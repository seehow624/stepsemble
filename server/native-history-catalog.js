"use strict";

// Local, read-only history catalog for harnesses that keep their own native
// transcripts on disk.  This module intentionally does not use a provider SDK
// or launch a provider process: it only reads the two well-known transcript
// roots, with bounded discovery and a stable-file check for the transcript the
// user explicitly opens.

const fs = require("node:fs");
const fsp = fs.promises;
const path = require("node:path");

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const MAX_PROJECT_DEPTH = 4;
const MAX_FILES_PER_PROVIDER = 4096;
const MAX_METADATA_BYTES = 192 * 1024 * 1024;
const MAX_TRANSCRIPT_BYTES = 32 * 1024 * 1024;
const MAX_PARTIAL_WINDOW_BYTES = 4 * 1024 * 1024;
const MAX_METADATA_READ_BYTES = 96 * 1024;
// A single Codex record can contain a large pasted prompt or tool result. It
// is still bounded independently from the whole file; oversized records are
// omitted with an explicit partial flag instead of making the whole session
// unreadable.
const MAX_LINE_BYTES = 8 * 1024 * 1024;
const MAX_RECORDS = 50_000;
const MAX_MESSAGES = 4_000;
const MAX_MESSAGE_TEXT = 256 * 1024;
const MAX_TOTAL_MESSAGE_BYTES = 8 * 1024 * 1024;
const MAX_TITLE = 160;
const REFRESH_MS = 15_000;
const REFRESH_DEADLINE_MS = 4_000;
const POSIX = process.platform === "darwin" || process.platform === "linux";

const O_NOFOLLOW = fs.constants.O_NOFOLLOW || 0;
const O_NONBLOCK = fs.constants.O_NONBLOCK || 0;

function ownUid() {
  try { return Number.isSafeInteger(process.geteuid?.()) ? BigInt(process.geteuid()) : null; }
  catch { return null; }
}

function text(value, limit = 4096) {
  return String(value ?? "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, limit);
}

function boundedText(value, limit = MAX_MESSAGE_TEXT) {
  if (typeof value !== "string") return "";
  return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ").slice(0, limit);
}

function validUuid(value) { return typeof value === "string" && UUID.test(value); }

function timestamp(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    const ms = value > 10_000_000_000 ? value : value * 1000;
    return ms > 0 && Number.isSafeInteger(Math.round(ms)) ? Math.round(ms) : null;
  }
  if (typeof value !== "string" || !value.trim()) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function statMilliseconds(stat) {
  const value = Number(stat?.mtimeMs);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function normalizedRoot(value, fallback) {
  const raw = String(value ?? fallback ?? "").trim();
  if (!raw || !path.isAbsolute(raw) || raw.length > 4096 || /[\u0000-\u001f\u007f]/.test(raw)) return null;
  return path.resolve(raw);
}

function contained(root, filename) {
  const relative = path.relative(root, filename);
  return relative === "" || relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function safeStat(stat, { directory = false, allowLarge = false } = {}) {
  const uid = ownUid();
  if (!POSIX || uid === null || !stat || stat.isSymbolicLink()) return false;
  if (directory ? !stat.isDirectory() : !stat.isFile()) return false;
  if (stat.uid !== uid || (stat.mode & 0o022n) !== 0n || !directory && stat.nlink !== 1n || stat.ino <= 0n || stat.dev < 0n) return false;
  if (!allowLarge && !directory && stat.size > BigInt(MAX_METADATA_BYTES)) return false;
  return true;
}

function parseJsonLine(line) {
  if (typeof line !== "string" || Buffer.byteLength(line) > MAX_LINE_BYTES) return null;
  try {
    const value = JSON.parse(line);
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch { return null; }
}

function linesFromBuffer(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) return [];
  const decoder = new TextDecoder("utf-8", { fatal: false });
  return decoder.decode(buffer).split(/\r?\n/).filter(Boolean).map(parseJsonLine).filter(Boolean);
}

async function readHeadTail(filename, stat) {
  let handle;
  try {
    handle = await fsp.open(filename, fs.constants.O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
    const opened = await handle.stat({ bigint: true });
    if (!safeStat(opened, { allowLarge: true }) || opened.dev !== stat.dev || opened.ino !== stat.ino || opened.size !== stat.size
      || opened.mtimeNs !== stat.mtimeNs || opened.ctimeNs !== stat.ctimeNs) return [];
    const size = Number(opened.size);
    const chunk = Math.min(MAX_METADATA_READ_BYTES, size);
    const head = Buffer.alloc(chunk);
    if (chunk && (await handle.read(head, 0, chunk, 0)).bytesRead !== chunk) return [];
    const tail = size > chunk ? Buffer.alloc(chunk) : head;
    if (size > chunk && (await handle.read(tail, 0, chunk, size - chunk)).bytesRead !== chunk) return [];
    return [...linesFromBuffer(head), ...(tail === head ? [] : linesFromBuffer(tail))];
  } catch { return []; }
  finally { try { await handle?.close(); } catch {} }
}

async function readStableFile(filename) {
  let handle;
  try {
    handle = await fsp.open(filename, fs.constants.O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
    const before = await handle.stat({ bigint: true });
    if (!safeStat(before, { allowLarge: true }) || before.size < 1n) {
      return { kind: "source_unavailable", code: "source_missing" };
    }
    if (before.size > BigInt(Number.MAX_SAFE_INTEGER)) return { kind: "source_unavailable", code: "source_too_large" };
    const size = Number(before.size);
    const same = stat => stat.dev === before.dev && stat.ino === before.ino && stat.size === before.size
      && stat.mtimeNs === before.mtimeNs && stat.ctimeNs === before.ctimeNs && stat.nlink === before.nlink
      && stat.uid === before.uid && stat.mode === before.mode;
    const readRange = async (offset, length) => {
      const bytes = Buffer.alloc(length);
      let cursor = 0;
      while (cursor < length) {
        const count = Math.min(64 * 1024, length - cursor);
        const result = await handle.read(bytes, cursor, count, offset + cursor);
        if (result.bytesRead !== count) throw new Error("source_changed");
        cursor += count;
      }
      return bytes;
    };
    if (size > MAX_TRANSCRIPT_BYTES) {
      // Very old Codex sessions can contain enormous pasted/tool records or
      // grow into gigabytes. Read two bounded windows instead of allocating a
      // buffer proportional to the file. The caller marks this transcript as
      // partial and keeps the vendor file untouched.
      const window = Math.min(MAX_PARTIAL_WINDOW_BYTES, size);
      const tailOffset = size - window;
      const readWindowPass = async () => [await readRange(0, window), await readRange(tailOffset, window)];
      const first = await readWindowPass();
      const middle = await handle.stat({ bigint: true });
      const second = await readWindowPass();
      const after = await handle.stat({ bigint: true });
      if (!same(middle) || !same(after) || !first[0].equals(second[0]) || !first[1].equals(second[1])) {
        return { kind: "source_unavailable", code: "source_changed" };
      }
      return { kind: "source_chunks", chunks: [
        { bytes: first[0], skipTrailingPartial: true },
        { bytes: first[1], skipLeadingPartial: true },
      ], truncated: true, sourceSize: size };
    }
    const readPass = async () => {
      return readRange(0, size);
    };
    const first = await readPass();
    const middle = await handle.stat({ bigint: true });
    const second = await readPass();
    const after = await handle.stat({ bigint: true });
    if (!same(middle) || !same(after) || !first.equals(second)) return { kind: "source_unavailable", code: "source_changed" };
    return { kind: "source_bytes", bytes: first };
  } catch (error) {
    return { kind: "source_unavailable", code: error?.message === "source_changed" ? "source_changed" : "source_io_error" };
  } finally { try { await handle?.close(); } catch {} }
}

async function walkJsonl(root, { maxDepth = MAX_PROJECT_DEPTH, maxFiles = MAX_FILES_PER_PROVIDER, allowLarge = false } = {}) {
  const files = [];
  if (!root) return files;
  const queue = [{ directory: root, depth: 0 }];
  const visited = new Set();
  while (queue.length && files.length < maxFiles) {
    const current = queue.shift();
    let stat;
    try { stat = await fsp.lstat(current.directory, { bigint: true }); } catch { continue; }
    if (!safeStat(stat, { directory: true })) continue;
    const key = `${stat.dev}:${stat.ino}`;
    if (visited.has(key)) continue;
    visited.add(key);
    let entries;
    try { entries = await fsp.readdir(current.directory, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (files.length >= maxFiles) break;
      const filename = path.join(current.directory, entry.name);
      if (!contained(root, filename) || entry.name.startsWith(".")) continue;
      let child;
      try { child = await fsp.lstat(filename, { bigint: true }); } catch { continue; }
      if (entry.isDirectory() && current.depth < maxDepth && safeStat(child, { directory: true })) {
        queue.push({ directory: filename, depth: current.depth + 1 });
      } else if (entry.isFile() && entry.name.endsWith(".jsonl") && safeStat(child, { allowLarge })) {
        files.push({ filename, stat: child });
      }
    }
  }
  return files;
}

function messageText(value) {
  if (typeof value === "string") return boundedText(value);
  if (!Array.isArray(value)) return "";
  return value.map(part => {
    if (typeof part === "string") return part;
    if (!part || typeof part !== "object") return "";
    if (part.type === "text" || part.type === "output_text" || part.type === "input_text") return part.text || part.value || "";
    if (part.type === "tool_use" || part.type === "function_call") return `[${text(part.name || part.type, 120)}]`;
    if (part.type === "tool_result" || part.type === "function_call_output") return `[tool result] ${messageText(part.content || part.output || part.result)}`;
    return "";
  }).filter(Boolean).join("\n");
}

function claudeRecordText(row) {
  return messageText(row?.message?.content ?? row?.content ?? row?.text);
}

function codexRecordText(payload) {
  return messageText(payload?.content ?? payload?.message ?? payload?.text ?? payload?.summary);
}

// Codex Desktop often stores its bootstrap context as the first user record.
// Prefer a concise actual request for the list title instead of exposing a
// giant plugin/context preamble as the session name.
function titleFromMessage(value) {
  let source = boundedText(value, 96 * 1024);
  if (!source) return "";
  const taggedUsers = [...source.matchAll(/<user>([\s\S]*?)(?:<\/user>|$)/gi)].map(match => match[1]).filter(Boolean);
  if (taggedUsers.length) source = taggedUsers.at(-1);
  source = source
    .replace(/<recommended_plugins>[\s\S]*?<\/recommended_plugins>/gi, " ")
    .replace(/<app-context>[\s\S]*?<\/app-context>/gi, " ")
    .replace(/<environment_context>[\s\S]*?<\/environment_context>/gi, " ")
    .replace(/<developer>[\s\S]*?<\/developer>/gi, " ");
  const requestMatch = source.match(/(?:^|\n)\s*(?:My request|User request|Request):\s*([\s\S]+)/i);
  if (requestMatch?.[1]) source = requestMatch[1];
  const candidate = source.split(/\r?\n/)
    .map(line => text(line, MAX_TITLE * 2))
    .find(line => line && !/^<[^>]+>$/.test(line)
      && !/^#{1,6}\s/.test(line)
      && !/^(?:#\s*(?:AGENTS|CLAUDE)\.md\b|\[?(?:Files mentioned|environment_context|app-context)\]?)/i.test(line));
  return text(candidate || source, MAX_TITLE);
}

function usefulHistoryTitle(value) {
  const title = titleFromMessage(value);
  if (!title) return "";
  if (/Jerome Teng|馬來西亞華人|available and not installed|You are Codex|Codex, an AI coding agent/i.test(title)) return "";
  return title;
}

function extractClaudeMeta(records, fallbackId, stat, filename) {
  const first = records.find(row => row.type === "user" && claudeRecordText(row));
  const id = records.find(row => validUuid(row.sessionId))?.sessionId || fallbackId;
  const cwd = text(records.find(row => typeof row.cwd === "string")?.cwd, 4096);
  const times = records.map(row => timestamp(row.timestamp)).filter(Boolean);
  const updatedAt = Math.max(statMilliseconds(stat), ...times, 0);
  const aiTitle = records.find(row => row.type === "ai-title" && typeof row.aiTitle === "string")?.aiTitle;
  const title = text(aiTitle, MAX_TITLE) || titleFromMessage(claudeRecordText(first));
  return { provider: "claude-code", sessionId: id, filename, cwd, title: title || `Claude Code ${id?.slice(0, 8) || "history"}`, firstMessage: boundedText(claudeRecordText(first), 512), updatedAt,
    source: "claude-project-jsonl" };
}

function codexSessionMeta(records, fallbackId, stat, filename, historyTitles) {
  const meta = records.find(row => row.type === "session_meta" && row.payload && typeof row.payload === "object");
  const payload = meta?.payload || {};
  const id = validUuid(payload.id) ? payload.id : validUuid(payload.session_id) ? payload.session_id : fallbackId;
  const cwd = text(payload.cwd, 4096);
  const candidates = [];
  for (const row of records) {
    if (row.type !== "response_item" && row.type !== "event_msg") continue;
    const value = row.payload || row;
    const role = value.role || (value.type === "user_message" ? "user" : value.type === "agent_message" ? "assistant" : "");
    if (!["user", "assistant"].includes(role)) continue;
    const valueText = codexRecordText(value);
    if (valueText) candidates.push({ role, text: valueText });
  }
  const fallbackTitle = usefulHistoryTitle(historyTitles.get(id));
  const firstMessage = boundedText(candidates.find(row => row.role === "user")?.text || fallbackTitle, 512);
  const times = records.map(row => timestamp(row.timestamp)).filter(Boolean);
  const updatedAt = Math.max(statMilliseconds(stat), ...times, timestamp(payload.timestamp) || 0);
  const title = fallbackTitle || candidates.filter(row => row.role === "user").map(row => usefulHistoryTitle(row.text)).find(Boolean) || "";
  return { provider: "codex", sessionId: id, filename, cwd, title: title || `Codex ${id?.slice(0, 8) || "history"}`, firstMessage, updatedAt,
    source: filename.includes(`${path.sep}archived_sessions${path.sep}`) ? "codex-archived-rollout" : "codex-rollout", cliVersion: text(payload.cli_version, 128) };
}

function claudeMessages(records) {
  const messages = [];
  let totalBytes = 0;
  let truncated = false;
  for (const row of records) {
    if (!row || !["user", "assistant"].includes(row.type)) continue;
    const raw = claudeRecordText(row);
    if (!raw) continue;
    const remaining = MAX_TOTAL_MESSAGE_BYTES - totalBytes;
    if (remaining <= 0) { truncated = true; break; }
    const value = boundedText(raw, Math.min(MAX_MESSAGE_TEXT, remaining));
    if (!value) continue;
    if (value.length < raw.length) truncated = true;
    const role = row.type === "user" ? "user" : "assistant";
    // An assistant message's id lets a live view skip what this history
    // already shows.
    messages.push({ role, text: value, timestamp: timestamp(row.timestamp), ts: timestamp(row.timestamp), model: text(row.message?.model, 128) || undefined,
      id: role === "assistant" ? text(row.message?.id, 256) || undefined : undefined });
    totalBytes += Buffer.byteLength(value);
    if (messages.length >= MAX_MESSAGES) { truncated = true; break; }
  }
  Object.defineProperty(messages, "truncated", { value: truncated, enumerable: false });
  return messages;
}

function codexMessages(records) {
  const messages = [], seen = new Set();
  let totalBytes = 0;
  let truncated = false;
  for (const row of records) {
    const payload = row?.payload || row;
    if (!payload || typeof payload !== "object") continue;
    let role = payload.role;
    if (!role && row.type === "event_msg") role = payload.type === "user_message" ? "user" : payload.type === "agent_message" ? "assistant" : "";
    if (!["user", "assistant"].includes(role)) continue;
    const raw = codexRecordText(payload);
    if (!raw) continue;
    const key = `${role}:${raw.slice(0, 2048)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const remaining = MAX_TOTAL_MESSAGE_BYTES - totalBytes;
    if (remaining <= 0) { truncated = true; break; }
    const value = boundedText(raw, Math.min(MAX_MESSAGE_TEXT, remaining));
    if (!value) continue;
    if (value.length < raw.length) truncated = true;
    messages.push({ role, text: value, timestamp: timestamp(row.timestamp), ts: timestamp(row.timestamp) });
    totalBytes += Buffer.byteLength(value);
    if (messages.length >= MAX_MESSAGES) { truncated = true; break; }
  }
  Object.defineProperty(messages, "truncated", { value: truncated, enumerable: false });
  return messages;
}

function recordsFromChunks(chunks) {
  const records = [];
  let seen = 0;
  let omittedRecords = 0;
  const decoder = new TextDecoder("utf-8", { fatal: true });
  for (const descriptor of chunks) {
    const bytes = descriptor?.bytes;
    if (!Buffer.isBuffer(bytes) || bytes.length === 0) continue;
    let start = 0;
    let lineIndex = 0;
    while (start < bytes.length) {
      const lf = bytes.indexOf(0x0a, start);
      const hasLf = lf >= 0;
      const end = hasLf ? lf : bytes.length;
      let line = bytes.subarray(start, end);
      if (line.length && line[line.length - 1] === 0x0d) line = line.subarray(0, line.length - 1);
      // A partial window may start in the middle of a JSONL record, and its
      // head may end in the middle of another one. Do not reinterpret either
      // fragment as malformed native data.
      const leadingPartial = descriptor.skipLeadingPartial === true && lineIndex === 0;
      const trailingPartial = descriptor.skipTrailingPartial === true && !hasLf;
      if (!leadingPartial && !trailingPartial && line.length) {
        seen++;
        if (seen > MAX_RECORDS) return { kind: "source_unavailable", code: "source_too_many_records" };
        if (line.length > MAX_LINE_BYTES) {
          omittedRecords++;
        } else {
          let source;
          try { source = decoder.decode(line); }
          catch { return { kind: "source_unavailable", code: "source_invalid_encoding" }; }
          const row = parseJsonLine(source);
          if (!row) return { kind: "source_unavailable", code: "source_invalid_json" };
          records.push(row);
        }
      }
      if (!hasLf) break;
      start = end + 1;
      lineIndex++;
    }
  }
  return { kind: "source_records", records, omittedRecords };
}

function recordsFromBytes(bytes) {
  return recordsFromChunks([{ bytes }]);
}

function taskFromMeta(meta) {
  const prefix = meta.provider === "claude-code" ? "claude-history:" : "codex-history:";
  const label = meta.title || `${meta.provider === "claude-code" ? "Claude Code" : "Codex"} ${meta.sessionId.slice(0, 8)}`;
  return { id: `${prefix}${meta.sessionId}`, taskId: `${prefix}${meta.sessionId}`, agentId: meta.provider, agent: meta.provider, connector: meta.provider,
    nativeHistoryReadonly: true, nativeHistorySessionId: meta.sessionId, name: label, firstMessage: meta.firstMessage || "", preview: meta.firstMessage || "",
    cwd: meta.cwd || "", status: "history", isRunning: false, startedAt: meta.updatedAt || null, endedAt: meta.updatedAt || null,
    lastActivityAt: meta.updatedAt || null, history: "native_readonly", readOnly: true, source: meta.source };
}

async function mapLimit(items, limit, fn) {
  const output = new Array(items.length); let cursor = 0;
  async function worker() { while (true) { const index = cursor++; if (index >= items.length) return; try { output[index] = await fn(items[index], index); } catch { output[index] = null; } } }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return output;
}

function createNativeHistoryCatalog({ home = process.env.PI_HOME || require("node:os").homedir(), claudeRoot, codexRoot, clock = () => Date.now() } = {}) {
  const base = normalizedRoot(home, require("node:os").homedir());
  const roots = Object.freeze({
    claude: normalizedRoot(claudeRoot, path.join(base || "", ".claude", "projects")),
    codex: normalizedRoot(codexRoot, path.join(base || "", ".codex")),
  });
  let entries = new Map();
  let flight = null;
  let lastRefresh = 0;
  let closed = false;
  let lastError = null;

  async function readHistoryTitles() {
    const result = new Map();
    const filename = roots.codex && path.join(roots.codex, "history.jsonl");
    if (!filename || !contained(roots.codex, filename)) return result;
    let stat; try { stat = await fsp.lstat(filename, { bigint: true }); } catch { return result; }
    if (!safeStat(stat) || stat.size > 8n * 1024n * 1024n) return result;
    try {
      const bytes = await fsp.readFile(filename);
      for (const line of linesFromBuffer(bytes)) if (validUuid(line.session_id) && !result.has(line.session_id)) result.set(line.session_id, boundedText(line.text, MAX_TITLE));
    } catch {}
    return result;
  }

  async function inspectClaude(candidate) {
    const records = await readHeadTail(candidate.filename, candidate.stat);
    const idFromName = path.basename(candidate.filename, ".jsonl");
    const fallbackId = validUuid(idFromName) ? idFromName : null;
    if (!fallbackId && !records.some(row => validUuid(row.sessionId))) return null;
    return extractClaudeMeta(records, fallbackId, candidate.stat, candidate.filename);
  }

  async function inspectCodex(candidate, historyTitles) {
    const records = await readHeadTail(candidate.filename, candidate.stat);
    const match = path.basename(candidate.filename).match(/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})\.jsonl$/i);
    const fallbackId = match?.[1] || null;
    if (!fallbackId && !records.some(row => validUuid(row.payload?.id) || validUuid(row.payload?.session_id))) return null;
    return codexSessionMeta(records, fallbackId, candidate.stat, candidate.filename, historyTitles);
  }

  async function refresh() {
    if (closed) return { kind: "source_unavailable", code: "catalog_closed" };
    if (flight) return flight;
    flight = (async () => {
      try {
        if (!POSIX || !roots.claude || !roots.codex) { lastError = "platform_unsupported"; return status(); }
        // Keep the Codex surface deliberately narrow.  The root also contains
        // credentials, config and other JSON, so history discovery is limited
        // to the two rollout directories that Codex itself uses.
        const codexSessionRoots = [
          roots.codex && path.join(roots.codex, "sessions"),
          roots.codex && path.join(roots.codex, "archived_sessions"),
        ].filter(Boolean);
        const [claudeFiles, codexFileGroups, historyTitles] = await Promise.all([
          walkJsonl(roots.claude, { allowLarge: true }), Promise.all(codexSessionRoots.map(root => walkJsonl(root, { maxDepth: 5, allowLarge: true }))), readHistoryTitles(),
        ]);
        const codexFiles = codexFileGroups.flat();
        const [claudeMeta, codexMeta] = await Promise.all([
          mapLimit(claudeFiles, 8, inspectClaude), mapLimit(codexFiles.filter(row => !path.basename(row.filename).startsWith("history")), 8, row => inspectCodex(row, historyTitles)),
        ]);
        const next = new Map();
        for (const meta of [...claudeMeta, ...codexMeta].filter(Boolean)) {
          if (!validUuid(meta.sessionId)) continue;
          const key = `${meta.provider}:${meta.sessionId}`;
          const previous = next.get(key);
          if (!previous || meta.updatedAt >= previous.updatedAt) next.set(key, meta);
        }
        entries = next;
        lastRefresh = Number(clock()) || Date.now();
        lastError = null;
        return status();
      } catch (error) { lastError = text(error?.code || error?.message || "catalog_refresh_failed", 128); return status(); }
      finally { flight = null; }
    })();
    return flight;
  }

  async function ensureFresh() {
    if (!entries.size || Number(clock()) - lastRefresh >= REFRESH_MS) {
      let timer;
      try {
        await Promise.race([refresh(), new Promise(resolve => { timer = setTimeout(resolve, REFRESH_DEADLINE_MS); })]);
      } finally { if (timer) clearTimeout(timer); }
    }
  }

  async function listTasks() {
    await ensureFresh();
    return [...entries.values()].map(taskFromMeta).sort((a, b) => (b.lastActivityAt || 0) - (a.lastActivityAt || 0) || a.id.localeCompare(b.id));
  }

  async function read(taskId) {
    await ensureFresh();
    const raw = String(taskId || "");
    const match = /^(claude-history|codex-history):([a-f0-9-]{36})$/i.exec(raw);
    if (!match) return { kind: "source_unavailable", code: "history_session_invalid" };
    const provider = match[1] === "claude-history" ? "claude-code" : "codex";
    const meta = entries.get(`${provider}:${match[2]}`);
    if (!meta || !contained(roots[provider === "claude-code" ? "claude" : "codex"], meta.filename)) return { kind: "source_unavailable", code: "history_session_unavailable" };
    const stable = await readStableFile(meta.filename);
    if (stable.kind !== "source_bytes" && stable.kind !== "source_chunks") return stable;
    const parsed = stable.kind === "source_chunks"
      ? recordsFromChunks(stable.chunks)
      : recordsFromBytes(stable.bytes);
    if (parsed.kind !== "source_records") return parsed;
    const messages = provider === "claude-code" ? claudeMessages(parsed.records) : codexMessages(parsed.records);
    const partial = stable.truncated === true || parsed.omittedRecords > 0 || messages.truncated === true;
    return { kind: "native_history_transcript", agentId: provider, sessionId: meta.sessionId, cwd: meta.cwd || "", name: meta.title || taskFromMeta(meta).name,
      messages, hasMore: partial, truncated: partial, omittedRecords: parsed.omittedRecords || 0,
      source: "native_readonly", readOnly: true, updatedAt: meta.updatedAt || null };
  }

  function status() { return { enabled: POSIX, state: closed ? "closed" : "ready", lastRefresh: lastRefresh || null, entries: entries.size, lastError, refreshing: !!flight }; }
  async function shutdown() { closed = true; entries = new Map(); await flight?.catch?.(() => {}); return { cleanupConfirmed: true }; }
  return Object.freeze({ refresh, listTasks, read, status, shutdown });
}

module.exports = { createNativeHistoryCatalog, recordsFromBytes, claudeMessages, codexMessages, taskFromMeta, LIMITS: Object.freeze({ MAX_FILES_PER_PROVIDER, MAX_TRANSCRIPT_BYTES, MAX_MESSAGES }) };
