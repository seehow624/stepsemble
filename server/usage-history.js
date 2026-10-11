"use strict";

// Numeric history index. Native transcripts are never copied into the index.
const fs = require("node:fs/promises"), path = require("node:path"), crypto = require("node:crypto");
const { createUsageParser, number, text } = require("./usage-records");
const states = new Map();
const MAX_LINE = 8 * 1024 * 1024, MAX_FILE = 8 * 1024 * 1024 * 1024, MAX_INDEX = 64 * 1024 * 1024;
const MAX_ROWS = 100000, MAX_STATES = 2000, MAX_CACHED_ROWS = 120000;
const INDEX_VERSION = 4;
const uuid = /[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/i;
const REASONS = new Set(["", "missing_file", "permission_denied", "unsupported_format", "identity_mismatch", "incomplete_records", "malformed_records", "record_too_large", "truncated", "file_limit", "unsafe_file", "source_changed", "read_failed"]);
function failure(error) { return error?.code === "ENOENT" ? "missing_file" : ["EACCES", "EPERM"].includes(error?.code) ? "permission_denied" : "read_failed"; }
function piArtifact(file, agent) {
  if (agent !== "pi" || !file.includes(path.sep + "subagent-artifacts" + path.sep)) return {};
  const name = path.basename(file, ".jsonl"), runId = name.match(uuid)?.[0];
  if (!runId || !name.startsWith(runId + "_") || !/^[a-zA-Z0-9_-]+$/.test(name.slice(37))) return {};
  return { format: name.endsWith("_transcript") ? "pi-transcript" : "pi-events", artifact: name.replace(/_transcript$/, "") };
}
const inside = (root, file) => { const relative = path.relative(root, file); return relative && relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative); };
const owned = stat => typeof process.getuid !== "function" || stat.uid === process.getuid();
const fingerprint = stat => [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(":");
const fileState = stat => ({ dev: stat.dev, ino: stat.ino, size: stat.size });
const validFileId = value => typeof value === "string" && /^(0|[1-9]\d{0,19})$/.test(value) && BigInt(value) <= 0xffffffffffffffffn;
async function usageStat(handle) {
  const stat = await handle.stat({ bigint: true });
  return { dev: String(stat.dev), ino: String(stat.ino), size: Number(stat.size), uid: Number(stat.uid),
    // Nanosecond strings retain same-size edits within a millisecond.
    mtimeNs: String(stat.mtimeNs), ctimeNs: String(stat.ctimeNs), isFile: () => stat.isFile() };
}
async function probes(handle, offset) {
  const size = Math.min(4096, offset), head = Buffer.alloc(size), tail = Buffer.alloc(size);
  await handle.read(head, 0, size, 0); await handle.read(tail, 0, size, Math.max(0, offset - size));
  return [head, tail].map(bytes => crypto.createHash("sha256").update(bytes).digest("hex"));
}
async function canAppend(state, stat, handle) {
  if (!state.file || state.file.dev !== stat.dev || state.file.ino !== stat.ino || stat.size <= state.file.size || state.offset > state.file.size || !Array.isArray(state.probes)) return false;
  const current = await probes(handle, state.offset);
  return current.every((value, index) => value === state.probes[index]);
}
function resume(state, signature) {
  if (state.done) {
    state.parser = createUsageParser(state.agent, state.expected, { maxRows: MAX_ROWS, checkpoint: state.checkpoint, initialRows: state.result.rows, format: state.format, artifact: state.artifact });
    state.carry = Buffer.alloc(0); state.ignoring = false; state.controlOnly = state.result.ignored; state.lines = state.offset ? 1 : 0; state.partial = state.oversized || false;
  }
  state.done = false; state.fingerprint = signature;
}
function trimStates(keep) {
  let count = 0;
  for (const state of states.values()) count += state.count || 0;
  for (const [key, state] of states) {
    if (states.size <= MAX_STATES && count <= MAX_CACHED_ROWS) break;
    // Retain an unfinished reader so the next snapshot makes progress.
    if (key === keep || !state.done) continue;
    count -= state.count || 0; states.delete(key);
  }
}

async function discoverUsageFiles(home, roots, budget) {
  const files = [], sources = [];
  const configured = { codex: roots.codex || path.join(home, ".codex"), "claude-code": roots.claude || path.join(home, ".claude", "projects"), pi: roots.pi || path.join(home, ".pi", "agent", "sessions") };
  async function walk(folder, root, agent, depth = 0) {
    if (depth > 12 || budget.visited >= 20000 || Date.now() > budget.deadline) { budget.limited = true; return; }
    let children;
    try { children = await fs.readdir(folder, { withFileTypes: true }); }
    catch (error) { if (error.code !== "ENOENT") budget.limited = true; return; }
    for (const child of children) {
      if (++budget.visited > 20000 || Date.now() > budget.deadline) { budget.limited = true; return; }
      const file = path.join(folder, child.name);
      if (child.isDirectory()) { await walk(file, root, agent, depth + 1); continue; }
      if (child.name.endsWith(".jsonl.zst")) { budget.limited = true; continue; }
      if (!child.name.endsWith(".jsonl")) {
        if (child.isSymbolicLink()) try { if ((await fs.stat(file)).isDirectory()) budget.limited = true; } catch { budget.limited = true; }
        continue;
      }
      const parent = agent === "claude-code" && file.includes(path.sep + "subagents" + path.sep) ? file.split(path.sep + "subagents" + path.sep)[0].split(path.sep).at(-1) : "";
      const expected = parent.match(uuid)?.[0] || child.name.match(uuid)?.[0] || "";
      const artifact = piArtifact(file, agent);
      // Only a native history filename can be followed through a managed archive
      // symlink. Never traverse linked directories or caller-supplied paths.
      if (child.isSymbolicLink() && !expected || !child.isFile() && !child.isSymbolicLink()) continue;
      // Child event exports have no native session header to authenticate a
      // linked target outside the history root. Keep them within the root.
      if (child.isSymbolicLink() && artifact.format) { budget.limited = true; continue; }
      let stat;
      try { stat = await fs.lstat(file); } catch { budget.limited = true; continue; }
      if (!owned(stat)) { budget.limited = true; continue; }
      files.push({ file, root, agent, expected, linked: child.isSymbolicLink(), modified: stat.mtimeMs, subagent: !!parent, ...artifact });
    }
  }
  for (const [agent, folder] of Object.entries(configured)) {
    let root;
    try { root = await fs.realpath(folder); }
    catch (error) { sources.push({ agent, status: error.code === "ENOENT" ? "absent" : "unavailable" }); if (error.code !== "ENOENT") budget.limited = true; continue; }
    sources.push({ agent, status: "ready" });
    if (agent === "codex") for (const part of ["sessions", "archived_sessions"]) await walk(path.join(root, part), root, agent);
    else await walk(root, root, agent);
  }
  files.sort((a, b) => b.modified - a.modified || a.file.localeCompare(b.file));
  return { files, sources };
}

// Large Codex tool results dominate transcript bytes but contain no usage.
// Match only the serializer's outer record prefix, never text in a prompt.
function irrelevantCodexLine(bytes) {
  const prefix = bytes.subarray(0, 1024).toString("utf8");
  const start = /^\s*\{\s*(?:"timestamp"\s*:\s*"[^"\\]*"\s*,\s*)?"type"\s*:\s*"([a-z_]+)"/;
  const type = prefix.match(start)?.[1];
  if (type === "response_item") return true;
  return type === "event_msg" && /^\s*\{\s*(?:"timestamp"\s*:\s*"[^"\\]*"\s*,\s*)?"type"\s*:\s*"event_msg"\s*,\s*"payload"\s*:\s*\{\s*"type"\s*:\s*"(?!token_count"|task_started")[a-z_]+"/.test(prefix);
}

function validSaved(saved, agent, expected, format, artifact) {
  if (saved?.version !== INDEX_VERSION || typeof saved.fingerprint !== "string" || saved.fingerprint.length > 256 || saved.agent !== agent || saved.expected !== expected || saved.format !== format || saved.artifact !== artifact || !Array.isArray(saved.result?.rows) || saved.result.rows.length > MAX_ROWS) return false;
  if (typeof saved.result.session !== "string" || expected && saved.result.session !== (format === "native" ? expected : `artifact:${artifact}`) || !REASONS.has(saved.result.reason)) return false;
  if (!["partial", "invalid", "ignored", "pending"].every(key => typeof saved.result[key] === "boolean") || saved.result.invalid || saved.result.pending) return false;
  const cp = saved.state?.checkpoint;
  if (!cp || !["session", "fork", "turn", "model", "provider"].every(key => typeof cp[key] === "string" && cp[key].length <= 256) || cp.session !== saved.result.session || !["epoch", "skipped", "completed"].every(key => Number.isSafeInteger(cp[key]) && cp[key] >= 0) || !REASONS.has(cp.problem) || !REASONS.has(saved.state.readReason) || !["invalid", "headerSeen", "waitingFork", "replay", "userFork"].every(key => typeof cp[key] === "boolean")) return false;
  if (cp.previous !== null && (!Array.isArray(cp.previous) || cp.previous.length !== 4 || !cp.previous.every(value => Number.isSafeInteger(value) && number(value) !== null))) return false;
  if (!["started", "snapshots"].every(key => Array.isArray(cp[key]) && cp[key].length <= MAX_ROWS && cp[key].every(value => typeof value === "string" && value.length <= 1600))) return false;
  if (!["dev", "ino"].every(key => validFileId(saved.state.file?.[key])) || !Number.isSafeInteger(saved.state.file?.size) || saved.state.file.size < 0 || !Number.isSafeInteger(saved.state.offset) || saved.state.offset < 0 || saved.state.offset > saved.state.file.size || !Array.isArray(saved.state.probes) || saved.state.probes.length !== 2 || !saved.state.probes.every(value => /^[a-f0-9]{64}$/.test(value))) return false;
  return saved.result.rows.every(row => /^[a-f0-9]{64}$/.test(row?.identity) && Number.isSafeInteger(row.at) && row.at > 0 && typeof row.model === "string" && row.model.length <= 160 && typeof row.provider === "string" && row.provider.length <= 160 && row.tokens && ["input", "output", "cacheRead", "cacheWrite"].every(key => row.tokens[key] === null || Number.isSafeInteger(row.tokens[key]) && number(row.tokens[key]) !== null) && (row.cost === null || number(row.cost) !== null));
}

async function readUsageFile(source, budget, indexDir) {
  let handle;
  const { file, root, agent, expected, format = "native", artifact = "" } = source;
  try {
    const real = await fs.realpath(file);
    if (!inside(root, real) && !source.linked) return { rows: [], partial: true, invalid: true, reason: "unsafe_file" };
    handle = await fs.open(real, require("node:fs").constants.O_RDONLY | (require("node:fs").constants.O_NOFOLLOW || 0) | (require("node:fs").constants.O_NONBLOCK || 0));
    const stat = await usageStat(handle);
    if (!stat.isFile() || !owned(stat)) return { rows: [], partial: true, invalid: true, reason: "unsafe_file" };
    if (!Number.isSafeInteger(stat.size) || stat.size < 0) return { rows: [], partial: true, invalid: true, reason: "file_limit" };
    const signature = fingerprint(stat), key = `${agent}:${expected}:${real}`, id = crypto.createHash("sha256").update(key).digest("hex");
    let state = states.get(key);
    if (state && state.fingerprint !== signature) {
      if (await canAppend(state, stat, handle)) resume(state, signature);
      else { states.delete(key); state = null; }
    }
    if (state?.done) return state.result;
    const cacheFile = indexDir && path.join(indexDir, id + ".json");
    if (!state && cacheFile) {
      try {
        const info = await fs.stat(cacheFile);
        if (info.isFile() && owned(info) && info.size <= MAX_INDEX) {
          const saved = JSON.parse(await fs.readFile(cacheFile, "utf8"));
          if (validSaved(saved, agent, expected, format, artifact)) {
            const rows = saved.result.rows.map(row => ({ identity: row.identity, at: row.at, model: text(row.model), provider: text(row.provider), tokens: Object.fromEntries(["input", "output", "cacheRead", "cacheWrite"].map(key => [key, row.tokens[key]])), cost: row.cost }));
            const result = { rows, partial: saved.result.partial, reason: saved.result.reason, invalid: false, ignored: saved.result.ignored, pending: false, meta: { cwd: text(saved.result.meta?.cwd, 4096), name: text(saved.result.meta?.name) }, session: text(saved.result.session, 256) };
            const checkpoint = { ...saved.state.checkpoint, meta: { cwd: text(saved.state.checkpoint.meta?.cwd, 4096), name: text(saved.state.checkpoint.meta?.name) } };
            const loaded = { ...saved.state, checkpoint, agent, expected, format, artifact, fingerprint: saved.fingerprint, done: true, result, count: rows.length };
            if (saved.fingerprint === signature || await canAppend(loaded, stat, handle)) {
              state = loaded; states.set(key, state); trimStates(key);
              if (saved.fingerprint === signature) return result;
              resume(state, signature);
            }
          }
        }
      } catch { /* Missing, old or malformed numeric indexes are rebuilt. */ }
    }
    if (!state) {
      state = { fingerprint: signature, agent, expected, format, artifact, parser: createUsageParser(agent, expected, { maxRows: MAX_ROWS, format, artifact }), offset: 0, carry: Buffer.alloc(0), ignoring: false, partial: stat.size > MAX_FILE, readReason: stat.size > MAX_FILE ? "file_limit" : "", controlOnly: agent === "claude-code", lines: 0 };
      states.set(key, state);
    }
    const buffer = Buffer.allocUnsafe(256 * 1024), end = Math.min(stat.size, MAX_FILE);
    function consume(segment, complete) {
      if (state.ignoring) return;
      const line = state.carry.length ? Buffer.concat([state.carry, segment]) : segment;
      if (agent === "codex" && irrelevantCodexLine(line)) { state.carry = Buffer.alloc(0); state.ignoring = true; return; }
      if (line.length > MAX_LINE) { state.carry = Buffer.alloc(0); state.ignoring = true; state.partial = true; state.readReason ||= "record_too_large"; return; }
      if (!complete) { state.carry = Buffer.from(line); return; }
      try {
        const row = JSON.parse(line.toString("utf8")); state.lines++;
        state.controlOnly &&= ["launched", "started", "result"].includes(row?.type) && !row.message?.usage;
        state.parser.consume(row);
      } catch { if (line.length) { state.partial = true; state.readReason ||= "malformed_records"; } }
    }
    while (state.offset < end && budget.bytes < budget.maxBytes && Date.now() < budget.deadline) {
      const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, end - state.offset), state.offset);
      if (!bytesRead) break;
      state.offset += bytesRead; budget.bytes += bytesRead;
      const chunk = buffer.subarray(0, bytesRead); let start = 0;
      for (let at = chunk.indexOf(10); at !== -1; at = chunk.indexOf(10, start)) {
        consume(chunk.subarray(start, at), true); state.carry = Buffer.alloc(0); state.ignoring = false; start = at + 1;
      }
      consume(chunk.subarray(start), false);
    }
    const after = await usageStat(handle);
    if (after.ino !== stat.ino || after.dev !== stat.dev || after.size < stat.size || after.size === stat.size && after.mtimeNs !== stat.mtimeNs) { states.delete(key); return { rows: [], partial: true, invalid: true, reason: "source_changed" }; }
    const parsed = state.parser.result(), ignored = format !== "native" && !stat.size || state.controlOnly && state.lines > 0 && !state.partial && !state.carry.length && state.offset === stat.size;
    state.count = parsed.rows.length;
    const pending = state.offset < Math.min(after.size, MAX_FILE);
    const result = { rows: parsed.rows, meta: parsed.meta, session: parsed.session, partial: state.partial || !ignored && (pending || parsed.skipped > 0 || parsed.invalid), reason: ignored ? "" : state.readReason || parsed.reason, invalid: parsed.invalid, ignored, pending };
    if (pending) budget.limited = true;
    state.file = fileState(after); state.fingerprint = fingerprint(after); state.probes = await probes(handle, state.offset);
    if (!pending && !state.carry.length && !state.ignoring && after.size === stat.size) {
      state.done = true; state.result = result; state.checkpoint = state.parser.checkpoint(); state.oversized = state.partial; delete state.parser; delete state.carry;
      if (cacheFile && !result.invalid) {
        const temporary = cacheFile + "." + process.pid + ".tmp";
        const savedState = { file: state.file, offset: state.offset, probes: state.probes, checkpoint: state.checkpoint, oversized: state.oversized, readReason: state.readReason };
        try { await fs.mkdir(indexDir, { recursive: true, mode: 0o700 }); await fs.writeFile(temporary, JSON.stringify({ version: INDEX_VERSION, fingerprint: state.fingerprint, agent, expected, format, artifact, state: savedState, result }), { mode: 0o600 }); await fs.rename(temporary, cacheFile); }
        catch { /* A cache failure must not discard confirmed native usage. */ }
        finally { await fs.rm(temporary, { force: true }).catch(() => {}); }
      }
    }
    trimStates(key);
    return result;
  } catch (error) { return { rows: [], partial: true, invalid: true, reason: failure(error) }; }
  finally { await handle?.close().catch(() => {}); }
}

module.exports = { discoverUsageFiles, readUsageFile, failure };
