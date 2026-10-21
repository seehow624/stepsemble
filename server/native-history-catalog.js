"use strict";

// Local, read-only history catalog for harnesses that keep their own native
// transcripts on disk.  This module intentionally does not use a provider SDK
// or launch a provider process: it only reads the two well-known transcript
// roots, with bounded discovery, and streams the transcript the user
// explicitly opens.

const fs = require("node:fs");
const fsp = fs.promises;
const path = require("node:path");
const crypto = require("node:crypto");
const { createForkPoints, claudeOwnPrompt } = require("./claude-fork-point");

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const MAX_PROJECT_DEPTH = 4;
const MAX_FILES_PER_PROVIDER = 4096;
const MAX_METADATA_BYTES = 192 * 1024 * 1024;
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
// Claude's tool calls, shown as tool rows beside the messages.
const MAX_TOOLS = 4_000;
const MAX_TOOL_INPUT_BYTES = 64 * 1024;
const MAX_TOOL_FIELD_TEXT = 4 * 1024;
const MAX_TOOL_OUTPUT_TEXT = 32 * 1024;
const MAX_TOTAL_TOOL_BYTES = 8 * 1024 * 1024;
// Pictures the person sent, shown beside their message. Past this budget a
// picture goes to the page before; one message's pictures past it are counted
// and shown as ones the page cannot display.
const MAX_IMAGE_URL_BYTES = 8 * 1024 * 1024;
const MAX_TOTAL_IMAGE_BYTES = 16 * 1024 * 1024;
const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);
// A transcript is read as a stream of lines and keeps only what it shows. One
// page of it is the newest rows within the page budgets; older rows come with
// `before`. Past the retained budget the oldest rows are let go of and read
// from the file again when asked for.
const DEFAULT_LIMITS = Object.freeze({
  pageMessages: MAX_MESSAGES, pageMessageBytes: MAX_TOTAL_MESSAGE_BYTES, pageTools: MAX_TOOLS, pageToolBytes: MAX_TOTAL_TOOL_BYTES,
  pageImageBytes: MAX_TOTAL_IMAGE_BYTES, retainedBytes: 48 * 1024 * 1024, cacheBytes: 128 * 1024 * 1024, cacheEntries: 8,
  lineBytes: MAX_LINE_BYTES, chunkBytes: 1024 * 1024,
});
const FINGERPRINT_BYTES = 64;
const MAX_TITLE = 160;
const REFRESH_MS = 15_000;
const REFRESH_DEADLINE_MS = 4_000;
// A conversation asked for by its id but not in the catalog may be newer than
// the last scan (a branch of a Claude conversation begun seconds ago): look
// once more, at most this often.
const MISS_REFRESH_MS = 1_000;
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

// The whole lines of `handle` from `state.offset` up to `size`, each given to
// `state.transcript` as it is read: one chunk and one line in memory at a time.
// `state.offset` moves only past whole lines, so a line still being written is
// read again next time; a line past the limit is let go of up to its end.
async function scanLines(handle, state, size, limits) {
  const transcript = state.transcript;
  const chunk = Buffer.allocUnsafe(Math.max(4096, limits.chunkBytes));
  const take = line => {
    const bytes = line.length && line[line.length - 1] === 0x0d ? line.subarray(0, -1) : line;
    if (!bytes.length) return true;
    let row = null;
    try { row = JSON.parse(bytes.toString("utf8")); } catch {}
    if (!row || typeof row !== "object" || Array.isArray(row)) return false;
    transcript.record(row);
    return true;
  };
  let position = state.offset, parts = [], partBytes = 0;
  while (position < size && !transcript.done) {
    const { bytesRead } = await handle.read(chunk, 0, Math.min(chunk.length, size - position), position);
    if (!bytesRead) break;
    const view = chunk.subarray(0, bytesRead);
    let start = 0;
    while (start < bytesRead && !transcript.done) {
      const lf = view.indexOf(0x0a, start);
      if (state.skipping) {
        if (lf < 0) { start = bytesRead; state.offset = position + bytesRead; continue; }
        state.skipping = false; start = lf + 1; state.offset = position + start; continue;
      }
      const piece = view.subarray(start, lf < 0 ? bytesRead : lf);
      if (partBytes + piece.length > limits.lineBytes) {
        transcript.omit(); parts = []; partBytes = 0;
        if (lf < 0) { state.skipping = true; start = bytesRead; state.offset = position + bytesRead; continue; }
        start = lf + 1; state.offset = position + start; continue;
      }
      if (lf < 0) { parts.push(Buffer.from(piece)); partBytes += piece.length; start = bytesRead; continue; }
      const line = parts.length ? Buffer.concat([...parts, piece]) : piece;
      parts = []; partBytes = 0;
      if (!take(line)) transcript.omit();
      start = lf + 1; state.offset = position + start;
    }
    position += bytesRead;
  }
  // The last line has no line end yet. A whole record is taken; a part of one
  // waits for the rest.
  if (parts.length && position >= size && !transcript.done && take(Buffer.concat(parts))) state.offset = size;
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

function extractClaudeMeta(records, id, stat, filename) {
  const first = records.find(row => row.type === "user" && claudeRecordText(row));
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

// The words of a Claude record: its text parts. Tool calls and their results
// are kept apart (claudeMessages), and a reminder Claude adds to a message is
// not part of what anyone wrote.
function claudeProse(content) {
  const parts = typeof content === "string" ? [content]
    : Array.isArray(content) ? content.map(part => typeof part === "string" ? part : part?.type === "text" ? part.text : "") : [];
  return parts.filter(part => typeof part === "string" && part)
    .map(part => part.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "").trim()).filter(Boolean).join("\n");
}

// A slash command the person typed, which Claude records as tagged text.
function claudeCommand(raw) {
  const name = /<command-name>([\s\S]*?)<\/command-name>/.exec(raw)?.[1]?.trim();
  if (!name) return null;
  const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(raw)?.[1]?.trim();
  return args ? `${name} ${args}` : name;
}

// What a slash command printed, which Claude also records as the person's.
function claudeCommandOutput(raw) {
  const match = /^<local-command-(?:stdout|stderr)>([\s\S]*?)<\/local-command-(?:stdout|stderr)>$/.exec(raw);
  return match ? match[1].trim() : null;
}

function claudeToolInput(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return {};
  let whole;
  try { whole = JSON.stringify(input); } catch { return {}; }
  if (typeof whole === "string" && Buffer.byteLength(whole) <= MAX_TOOL_INPUT_BYTES) return JSON.parse(whole);
  // A large input, such as a whole file Claude writes, keeps its short
  // fields and the start of its long ones.
  const kept = {};
  let size = 0;
  for (const [key, value] of Object.entries(input).slice(0, 32)) {
    const next = typeof value === "string" ? boundedText(value, MAX_TOOL_FIELD_TEXT) : value;
    let encoded;
    try { encoded = JSON.stringify(next); } catch { continue; }
    if (typeof encoded !== "string") continue;
    if (typeof next !== "string" && Buffer.byteLength(encoded) > MAX_TOOL_FIELD_TEXT) continue;
    if (size + Buffer.byteLength(encoded) > MAX_TOOL_INPUT_BYTES) break;
    kept[text(key, 128)] = next; size += Buffer.byteLength(encoded);
  }
  return kept;
}

function claudeToolOutput(content) {
  if (typeof content === "string") return boundedText(content, MAX_TOOL_OUTPUT_TEXT);
  if (!Array.isArray(content)) return "";
  return boundedText(content.map(part => typeof part === "string" ? part
    : part?.type === "text" ? part.text || "" : part?.type === "image" ? "[image]" : "").filter(Boolean).join("\n"), MAX_TOOL_OUTPUT_TEXT);
}

// The pictures of one record the person sent; one past its own limit is
// counted without its data.
function claudePictures(content) {
  const parts = (Array.isArray(content) ? content : []).filter(part => part?.type === "image");
  const imageAttachments = [];
  let bytes = 0, dropped = false;
  for (const part of parts) {
    const source = part.source && typeof part.source === "object" ? part.source : {};
    const type = String(source.media_type || "").toLowerCase();
    if (source.type !== "base64" || !IMAGE_TYPES.has(type) || typeof source.data !== "string") continue;
    const url = `data:${type};base64,${source.data}`;
    if (url.length > MAX_IMAGE_URL_BYTES) { dropped = true; continue; }
    bytes += url.length;
    imageAttachments.push({ data: url, mimeType: type });
  }
  return parts.length ? { images: parts.length, imageAttachments, bytes, dropped } : null;
}

// One transcript as it is read, record by record: its rows (messages, and
// Claude's tool calls, each shown before the message after it) numbered from
// the start of the file, and what the composer shows about its last turn.
// Claude stores a tool's result, a background task's notice and the notes it
// adds for itself as records of the person; none of those is shown as
// something they wrote. keepBelow: only rows before it are kept (an older
// page read again from the file). through: a Claude entry id the transcript
// ends with.
function createTranscript(provider, limits = DEFAULT_LIMITS, { keepBelow = Infinity, through = null } = {}) {
  const claude = provider === "claude-code";
  let rows = [], head = 0, first = 0, total = 0, retained = 0, omittedRecords = 0, done = false, found = through === null;
  const calls = new Map(), seen = new Set(), omittedAt = [], forks = claude ? createForkPoints() : null;
  const composer = { model: null, effort: null, contextTokens: null, contextWindow: null, observedAt: null };
  const evict = () => {
    while (retained > limits.retainedBytes && rows.length - head > 1) {
      const old = rows[head]; rows[head++] = null; first++; retained -= old.size;
      if (old.tool?.id && calls.get(old.tool.id) === old) calls.delete(old.tool.id);
    }
    if (head > 1024 && head * 2 > rows.length) { rows = rows.slice(head); head = 0; }
  };
  const add = entry => {
    if (total++ >= keepBelow) return null;
    rows.push(entry); retained += entry.size; evict();
    return entry;
  };
  const message = (role, raw, row, sent = null) => {
    const value = raw ? boundedText(raw, MAX_MESSAGE_TEXT) : "";
    if (!value && !sent?.images) return;
    const ts = timestamp(row.timestamp);
    // An assistant message's id lets a live view skip what this history
    // already shows.
    const item = claude ? { role, text: value, timestamp: ts, ts, model: text(row.message?.model, 128) || undefined,
      id: role === "assistant" ? text(row.message?.id, 256) || undefined : undefined,
      ...(sent?.images ? { images: sent.images, imageAttachments: sent.imageAttachments } : {}) } : { role, text: value, timestamp: ts, ts };
    const bytes = Buffer.byteLength(value), imageBytes = sent?.bytes || 0;
    add({ message: item, bytes, imageBytes, size: bytes + imageBytes, cut: value.length < raw.length || sent?.dropped === true });
  };
  const toolBytes = tool => Buffer.byteLength(JSON.stringify(tool.input)) + Buffer.byteLength(tool.output);
  const observeClaude = row => {
    const model = text(row.message?.model, 128);
    if (!model || model === "<synthetic>" || row.isSidechain === true) return;
    composer.model = model;
    // Claude Code names the 1M-token context of a model with a [1m] suffix.
    composer.contextWindow = /\[1m\]$/i.test(String(row.requestedModel || model)) ? 1_000_000 : null;
    const effort = text(row.perTurnEffort || row.effort, 32).toLowerCase();
    if (effort) composer.effort = effort;
    const usage = row.message?.usage;
    const used = usage && typeof usage === "object" ? ["input_tokens", "cache_creation_input_tokens", "cache_read_input_tokens", "output_tokens"]
      .reduce((sum, key) => sum + (Number.isSafeInteger(usage[key]) && usage[key] > 0 ? usage[key] : 0), 0) : 0;
    if (used > 0) composer.contextTokens = used;
    composer.observedAt = timestamp(row.timestamp) ?? composer.observedAt;
  };
  const observeCodex = row => {
    const payload = row.payload;
    if (!payload || typeof payload !== "object") return;
    if (row.type === "turn_context") {
      const model = text(payload.model, 128), effort = text(payload.effort, 32).toLowerCase();
      if (model) composer.model = model;
      if (effort) composer.effort = effort;
      if (model || effort) composer.observedAt = timestamp(row.timestamp) ?? composer.observedAt;
    } else if (row.type === "event_msg" && payload.type === "token_count" && payload.info && typeof payload.info === "object") {
      const used = payload.info.last_token_usage?.total_tokens, window = payload.info.model_context_window;
      if (Number.isSafeInteger(used) && used > 0) composer.contextTokens = used;
      if (Number.isSafeInteger(window) && window > 0) composer.contextWindow = window;
      composer.observedAt = timestamp(row.timestamp) ?? composer.observedAt;
    }
  };
  const claudeRecord = row => {
    if (!["user", "assistant"].includes(row.type)) return;
    if (row.type === "assistant") observeClaude(row);
    const content = row.message?.content ?? row.content ?? row.text;
    for (const part of Array.isArray(content) ? content : []) {
      if (part?.type === "tool_use" && row.type === "assistant") {
        const tool = { id: text(part.id, 256) || undefined, name: text(part.name, 128) || "tool", input: claudeToolInput(part.input),
          output: "", isError: false, ts: timestamp(row.timestamp), messageId: text(row.message?.id, 256) || undefined };
        const bytes = toolBytes(tool), entry = add({ tool, bytes, size: bytes });
        if (entry && tool.id) calls.set(tool.id, entry);
      } else if (part?.type === "tool_result" && row.type === "user") {
        const entry = calls.get(text(part.tool_use_id, 256));
        if (!entry) continue;
        entry.tool.output = claudeToolOutput(part.content);
        entry.tool.isError = part.is_error === true;
        entry.tool.endedAt = timestamp(row.timestamp);
        const bytes = toolBytes(entry.tool);
        retained += bytes - entry.size; entry.bytes = entry.size = bytes; evict();
      }
    }
    if (row.isMeta === true) return;
    const raw = claudeProse(content);
    const sent = row.type === "user" ? claudePictures(content) : null;
    if (!raw && !sent) return;
    // Claude's placeholder for a turn that was cut off, added when the
    // conversation is resumed; its other notes, such as an API error, stay.
    if (row.type === "assistant" && row.message?.model === "<synthetic>" && raw === "No response requested.") return;
    if (row.type === "assistant") message("assistant", raw, row);
    // A prompt Claude gave itself (a background task's notification) is not
    // the person's; its reply goes on the turn of the message before it.
    else if (/^<task-notification>/.test(raw) || claudeOwnPrompt(row)) return;
    else if (claudeCommand(raw)) message("user", claudeCommand(raw), row);
    else if (claudeCommandOutput(raw) !== null) { const output = claudeCommandOutput(raw); if (output) message("assistant", output, row); }
    else message("user", raw, row, sent);
  };
  const codexRecord = row => {
    observeCodex(row);
    const payload = row.payload || row;
    if (!payload || typeof payload !== "object") return;
    let role = payload.role;
    if (!role && row.type === "event_msg") role = payload.type === "user_message" ? "user" : payload.type === "agent_message" ? "assistant" : "";
    if (!["user", "assistant"].includes(role)) return;
    const raw = codexRecordText(payload);
    if (!raw) return;
    // Codex records a message both as an event and as a response item.
    const key = crypto.createHash("sha1").update(`${role}:${raw.slice(0, 2048)}`).digest("base64");
    if (seen.has(key)) return;
    seen.add(key);
    message(role, raw, row);
  };
  // The newest rows before `before` within the page budgets, never fewer
  // than one. A page whose rows were let go of says so (needsRange) and is
  // read again from the file. withTools false: the messages alone.
  function page({ before = null, limit = null, withTools = true } = {}) {
    const end = Math.min(before === null ? total : before, total, keepBelow);
    if (end > 0 && end <= first) return { needsRange: true, end };
    const most = Math.max(1, Math.min(limits.pageMessages, Number.isSafeInteger(limit) ? limit : limits.pageMessages));
    let start = end, messages = 0, tools = 0, textBytes = 0, toolBytesUsed = 0, imageBytes = 0, cut = false;
    const trimmed = new Map();
    for (let index = end - 1; index >= first; index--) {
      const entry = rows[head + index - first], empty = start === end;
      if (entry.message) {
        if (messages >= most || !empty && (textBytes + entry.bytes > limits.pageMessageBytes || imageBytes + entry.imageBytes > limits.pageImageBytes)) break;
        if (imageBytes + entry.imageBytes > limits.pageImageBytes) {
          // One message's own pictures past the budget: those that fit.
          const kept = [];
          for (const image of entry.message.imageAttachments) if (imageBytes + image.data.length <= limits.pageImageBytes) { kept.push(image); imageBytes += image.data.length; }
          trimmed.set(entry, { ...entry.message, imageAttachments: kept }); cut = true;
        } else imageBytes += entry.imageBytes;
        messages++; textBytes += entry.bytes;
      } else if (withTools) {
        if (!empty && (tools >= limits.pageTools || toolBytesUsed + entry.bytes > limits.pageToolBytes)) break;
        tools++; toolBytesUsed += entry.bytes;
      }
      if (entry.cut) cut = true;
      start = index;
    }
    const pageMessages = [], pageTools = [];
    for (let index = start; index < end; index++) {
      const entry = rows[head + index - first];
      if (entry.message) pageMessages.push(trimmed.get(entry) || entry.message);
      else if (withTools) pageTools.push({ ...entry.tool, after: pageMessages.length });
    }
    // A line left out sits before the row numbered with it; past the last row
    // it belongs to the newest page.
    const omitted = omittedRecords > omittedAt.length || omittedAt.some(at => at >= start && (at < end || at === total && end === total));
    return { messages: pageMessages, ...(claude ? { tools: pageTools } : {}), before: start > 0 ? start : null, end, truncated: cut || omitted };
  }
  return {
    record(row) {
      if (done || !row || typeof row !== "object") return;
      if (claude) { claudeRecord(row); forks.record(row); } else codexRecord(row);
      if (through !== null && row.uuid === through) { found = true; done = true; }
    },
    omit() { omittedRecords++; if (omittedAt.length < 10_000) omittedAt.push(total); },
    page,
    composer: () => ({ ...composer }),
    // The entry a branch through a Claude reply ends at (claude-fork-point.js).
    forkPoint: messageId => forks?.get(messageId) ?? null,
    get done() { return done; }, get found() { return found; },
    get retained() { return retained; }, get omittedRecords() { return omittedRecords; },
  };
}

// The newest page of whole records as one list, with its tool calls, whether
// it is partial and where the page before it starts.
function pageList(page) {
  const list = page.messages;
  Object.defineProperty(list, "truncated", { value: page.truncated || page.before !== null, enumerable: false });
  if (page.tools) Object.defineProperty(list, "tools", { value: page.tools, enumerable: false });
  Object.defineProperty(list, "before", { value: page.before, enumerable: false });
  return list;
}

function claudeMessages(records) {
  const transcript = createTranscript("claude-code");
  for (const row of records) transcript.record(row);
  return pageList(transcript.page());
}

function codexMessages(records) {
  const transcript = createTranscript("codex");
  for (const row of records) transcript.record(row);
  return pageList(transcript.page());
}

// A whole transcript already in memory, as the Claude release check reads it.
function recordsFromBytes(bytes) {
  const records = [];
  let seen = 0, omittedRecords = 0, start = 0;
  const decoder = new TextDecoder("utf-8", { fatal: true });
  while (Buffer.isBuffer(bytes) && start < bytes.length) {
    const lf = bytes.indexOf(0x0a, start), end = lf >= 0 ? lf : bytes.length;
    let line = bytes.subarray(start, end);
    if (line.length && line[line.length - 1] === 0x0d) line = line.subarray(0, line.length - 1);
    if (line.length) {
      if (++seen > MAX_RECORDS) return { kind: "source_unavailable", code: "source_too_many_records" };
      if (line.length > MAX_LINE_BYTES) omittedRecords++;
      else {
        let source;
        try { source = decoder.decode(line); }
        catch { return { kind: "source_unavailable", code: "source_invalid_encoding" }; }
        const row = parseJsonLine(source);
        if (!row) return { kind: "source_unavailable", code: "source_invalid_json" };
        records.push(row);
      }
    }
    start = end + 1;
  }
  return { kind: "source_records", records, omittedRecords };
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

// limits: DEFAULT_LIMITS to change (tests). onParse: told of each pass over a
// transcript file, { from, to } in bytes.
function createNativeHistoryCatalog({ home = process.env.PI_HOME || require("node:os").homedir(), claudeRoot, codexRoot, clock = () => Date.now(),
  limits: limitOverrides = {}, onParse = null } = {}) {
  const base = normalizedRoot(home, require("node:os").homedir());
  const roots = Object.freeze({
    claude: normalizedRoot(claudeRoot, path.join(base || "", ".claude", "projects")),
    codex: normalizedRoot(codexRoot, path.join(base || "", ".codex")),
  });
  const limits = Object.freeze({ ...DEFAULT_LIMITS, ...limitOverrides });
  let entries = new Map();
  let flight = null;
  let lastRefresh = 0;
  let closed = false;
  let lastError = null;
  // Transcripts already read, by the file's device and inode, oldest use
  // first: one read again is read on from where the last read stopped.
  const transcripts = new Map();

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

  // A Claude conversation is <project>/<uuid>.jsonl, named by its id. A
  // subagent's transcript (<uuid>/subagents/agent-*.jsonl, or a sidechain
  // beside the conversations) carries its parent's sessionId and never
  // stands in for the conversation.
  async function inspectClaude(candidate) {
    const id = path.basename(candidate.filename, ".jsonl");
    if (!validUuid(id) || path.dirname(path.dirname(candidate.filename)) !== roots.claude) return null;
    const records = await readHeadTail(candidate.filename, candidate.stat);
    if (records.find(row => row.type === "user" || row.type === "assistant")?.isSidechain === true) return null;
    return extractClaudeMeta(records, id, candidate.stat, candidate.filename);
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
          walkJsonl(roots.claude, { maxDepth: 1, allowLarge: true }), Promise.all(codexSessionRoots.map(root => walkJsonl(root, { maxDepth: 5, allowLarge: true }))), readHistoryTitles(),
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
      await boundedRefresh();
    }
  }

  async function boundedRefresh() {
    let timer;
    try {
      await Promise.race([refresh(), new Promise(resolve => { timer = setTimeout(resolve, REFRESH_DEADLINE_MS); })]);
    } finally { if (timer) clearTimeout(timer); }
  }

  // The newest record time known for one history, without waiting: a stale
  // index refreshes in the background and answers on a later call.
  function updatedAt(provider, sessionId) {
    if (closed || typeof sessionId !== "string") return null;
    if (!entries.size || Number(clock()) - lastRefresh >= REFRESH_MS) void boundedRefresh().catch(() => {});
    return entries.get(`${provider}:${sessionId}`)?.updatedAt || null;
  }

  async function listTasks() {
    await ensureFresh();
    return [...entries.values()].map(taskFromMeta).sort((a, b) => (b.lastActivityAt || 0) - (a.lastActivityAt || 0) || a.id.localeCompare(b.id));
  }

  function resetTranscript(entry) {
    entry.state = { transcript: createTranscript(entry.provider, limits), offset: 0, skipping: false };
    entry.head = entry.tail = null; entry.generation += 1;
  }

  // The bytes already read are still the file's: its start and the end of
  // the last line read are what they were.
  async function unchangedPrefix(entry, handle) {
    for (const [at, bytes] of [[0, entry.head], [entry.state.offset - (entry.tail?.length || 0), entry.tail]]) {
      if (!bytes?.length) continue;
      const now = Buffer.alloc(bytes.length);
      if ((await handle.read(now, 0, bytes.length, at)).bytesRead !== bytes.length || !now.equals(bytes)) return false;
    }
    return true;
  }

  // Reads what was added to the file since the last read. A live conversation
  // appends while it is read: what was read is a whole prefix of the file, and
  // one more pass takes what came meanwhile. A file that shrank or changed in
  // place is read again from its start.
  async function syncTranscript(entry, handle) {
    for (let attempt = 0; ; attempt++) {
      const before = await handle.stat({ bigint: true });
      if (!safeStat(before, { allowLarge: true }) || `${before.dev}:${before.ino}` !== entry.key) return "source_changed";
      const size = Number(before.size);
      if (size < entry.state.offset || !await unchangedPrefix(entry, handle)) resetTranscript(entry);
      const from = entry.state.offset;
      if (size > from) {
        onParse?.({ from, to: size });
        await scanLines(handle, entry.state, size, limits);
        const end = entry.state.offset, length = Math.min(FINGERPRINT_BYTES, end);
        if (!entry.head?.length && length) { entry.head = Buffer.alloc(length); await handle.read(entry.head, 0, length, 0); }
        entry.tail = Buffer.alloc(length); if (length) await handle.read(entry.tail, 0, length, end - length);
      }
      const after = await handle.stat({ bigint: true });
      if (after.size === before.size && after.mtimeNs === before.mtimeNs) return null;
      if (attempt > 0) return after.size >= before.size ? null : "source_changed";
    }
  }

  function transcriptFor(key, provider) {
    let entry = transcripts.get(key);
    if (entry?.provider !== provider) { entry = { key, provider, generation: 0, flight: null }; resetTranscript(entry); }
    transcripts.delete(key); transcripts.set(key, entry);
    return entry;
  }

  function trimTranscripts(keep) {
    let bytes = 0;
    for (const entry of transcripts.values()) bytes += entry.state.transcript.retained;
    for (const [key, entry] of transcripts) {
      if (transcripts.size <= limits.cacheEntries && bytes <= limits.cacheBytes) break;
      if (entry === keep || entry.flight) continue;
      transcripts.delete(key); bytes -= entry.state.transcript.retained;
    }
  }

  // One pass over the file that is not kept: a branch's history, or an older
  // page of a transcript whose oldest rows were let go of.
  async function scanOnce(handle, provider, size, options) {
    const state = { transcript: createTranscript(provider, limits, options), offset: 0, skipping: false };
    onParse?.({ from: 0, to: size, once: true });
    await scanLines(handle, state, size, limits);
    return state.transcript;
  }

  function openedFailure(stat) {
    if (!safeStat(stat, { allowLarge: true }) || stat.size < 1n) return "source_missing";
    return stat.size > BigInt(Number.MAX_SAFE_INTEGER) ? "source_too_large" : null;
  }

  // The kept transcript of an open file, read up to what the file holds now:
  // a read already under way may have begun before what was just written.
  async function syncedTranscript(handle, provider) {
    const stat = await handle.stat({ bigint: true }), failure = openedFailure(stat);
    if (failure) return { failure };
    const entry = transcriptFor(`${stat.dev}:${stat.ino}`, provider);
    if (entry.flight) await entry.flight.catch(() => {});
    if (!entry.flight) entry.flight = syncTranscript(entry, handle).finally(() => { entry.flight = null; });
    const changed = await entry.flight;
    if (changed) return { failure: changed };
    trimTranscripts(entry);
    return { entry, fileKey: entry.key };
  }

  const pageNumber = value => {
    if (value === null || value === undefined || value === "") return null;
    if (Number.isSafeInteger(value) && value >= 0) return value;
    return typeof value === "string" && /^\d{1,15}$/.test(value) ? Number(value) : NaN;
  };

  // through: a Claude entry id; the transcript is read up to and including
  // it (a branch's history before the branch has a record of its own).
  // before, limit: the page that ends before row `before`, of at most `limit`
  // messages; the newest page without them. tools false: without Claude's
  // tool calls. `sourceVersion` changes when the file is read again from its
  // start, and row numbers with it.
  async function read(taskId, { through = null, before = null, limit = null, tools = true } = {}) {
    await ensureFresh();
    const raw = String(taskId || "");
    const match = /^(claude-history|codex-history):([a-f0-9-]{36})$/i.exec(raw);
    if (!match) return { kind: "source_unavailable", code: "history_session_invalid" };
    const page = { before: pageNumber(before), limit: pageNumber(limit), withTools: tools !== false };
    if (Number.isNaN(page.before) || Number.isNaN(page.limit) || page.limit === 0) return { kind: "source_unavailable", code: "history_page_invalid" };
    const provider = match[1] === "claude-history" ? "claude-code" : "codex";
    if (through !== null && provider !== "claude-code") return { kind: "source_unavailable", code: "history_session_unavailable" };
    const key = `${provider}:${match[2]}`;
    let meta = entries.get(key);
    if (!meta && Number(clock()) - lastRefresh >= MISS_REFRESH_MS) {
      await boundedRefresh();
      meta = entries.get(key);
    }
    if (!meta || !contained(roots[provider === "claude-code" ? "claude" : "codex"], meta.filename)) return { kind: "source_unavailable", code: "history_session_unavailable" };
    let handle;
    try {
      handle = await fsp.open(meta.filename, fs.constants.O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
      let transcript, size, version;
      if (through !== null) {
        const stat = await handle.stat({ bigint: true }), failure = openedFailure(stat), fileKey = `${stat.dev}:${stat.ino}`;
        if (failure) return { kind: "source_unavailable", code: failure };
        size = Number(stat.size);
        transcript = await scanOnce(handle, provider, size, { through });
        if (!transcript.found) return { kind: "source_unavailable", code: "history_session_unavailable" };
        version = `${fileKey}:${transcripts.get(fileKey)?.generation || 0}:${through}`;
      } else {
        const synced = await syncedTranscript(handle, provider);
        if (synced.failure) return { kind: "source_unavailable", code: synced.failure };
        ({ transcript } = synced.entry.state); size = synced.entry.state.offset;
        version = `${synced.fileKey}:${synced.entry.generation}`;
      }
      let rows = transcript.page(page);
      if (rows.needsRange) rows = (await scanOnce(handle, provider, size, { through, keepBelow: rows.end })).page(page);
      return { kind: "native_history_transcript", agentId: provider, sessionId: meta.sessionId, cwd: meta.cwd || "", name: meta.title || taskFromMeta(meta).name,
        messages: rows.messages, ...(rows.tools ? { tools: rows.tools } : {}), hasMore: rows.before !== null, before: rows.before, end: rows.end,
        sourceVersion: crypto.createHash("sha256").update(version).digest("hex").slice(0, 24), truncated: rows.truncated,
        omittedRecords: transcript.omittedRecords, composer: transcript.composer(),
        source: "native_readonly", readOnly: true, updatedAt: meta.updatedAt || null };
    } catch { return { kind: "source_unavailable", code: "source_io_error" }; }
    finally { try { await handle?.close(); } catch {} }
  }

  // The entry a branch through a Claude reply ends at, from the transcript
  // at `filename` as its history reads it: the Host names the file from the
  // conversation's folder (claude-fork-point.js), which may be newer than the
  // last scan.
  async function claudeForkPoint(filename, messageId) {
    if (closed || !POSIX || typeof filename !== "string" || !path.isAbsolute(filename) || !filename.endsWith(".jsonl")) return null;
    let handle;
    try {
      handle = await fsp.open(filename, fs.constants.O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
      const synced = await syncedTranscript(handle, "claude-code");
      return synced.failure ? null : synced.entry.state.transcript.forkPoint(messageId);
    } catch { return null; }
    finally { try { await handle?.close(); } catch {} }
  }

  function status() { return { enabled: POSIX, state: closed ? "closed" : "ready", lastRefresh: lastRefresh || null, entries: entries.size, lastError, refreshing: !!flight }; }
  async function shutdown() { closed = true; entries = new Map(); transcripts.clear(); await flight?.catch?.(() => {}); return { cleanupConfirmed: true }; }
  return Object.freeze({ refresh, listTasks, read, claudeForkPoint, status, shutdown, updatedAt });
}

module.exports = { createNativeHistoryCatalog, createTranscript, recordsFromBytes, claudeMessages, codexMessages, taskFromMeta,
  LIMITS: Object.freeze({ MAX_FILES_PER_PROVIDER, MAX_MESSAGES, ...DEFAULT_LIMITS }) };
