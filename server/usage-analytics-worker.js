"use strict";
const { parentPort } = require("node:worker_threads");
const fs = require("node:fs"), path = require("node:path");
const { createUsageParser } = require("./usage-records");
const { estimate } = require("./usage-pricing");
const { empty, addCall } = require("../public/modules/usage-data");
const SUPPORTED = new Set(["pi", "claude-code", "codex"]);
const cache = new Map();
const MAX_LINE = 8 * 1024 * 1024, MAX_FILE = 512 * 1024 * 1024, MAX_SCAN = 1024 * 1024 * 1024;
const inside = (root, name) => { const rel = path.relative(root, name); return rel !== "" && rel !== ".." && !rel.startsWith(".." + path.sep) && !path.isAbsolute(rel); };
function nativeId(record) { return record.agentId === "codex" ? record.nativeThreadId || record.nativeHistorySessionId || String(record.id || record.taskId || "").replace(/^(codex-history|codex):/, "")
  : record.agentId === "claude-code" ? record.nativeSessionId || record.nativeHistorySessionId || String(record.id || record.taskId || "").replace(/^(claude-history|claude-code):/, "")
  // Pi's sid identifies the RPC process, not the id in the persisted file.
  : record.nativeSessionId || (record.file ? "" : record.sid || ""); }
async function discover(root, wanted, budget, depth = 0) {
  if (depth > 8 || Date.now() > budget.deadline || budget.visited >= 20000) { budget.limited = true; return; }
  let children;
  try { children = await fs.promises.readdir(root, { withFileTypes: true }); } catch (e) { if (e.code !== "ENOENT") budget.limited = true; return; }
  for (const child of children) {
    if (++budget.visited > 20000 || Date.now() > budget.deadline) { budget.limited = true; return; }
    const file = path.join(root, child.name);
    if (child.isDirectory()) await discover(file, wanted, budget, depth + 1);
    else if (child.isFile() && child.name.endsWith(".jsonl")) {
      const item = wanted.find(item => child.name === item.id + ".jsonl" || child.name.endsWith("-" + item.id + ".jsonl") || file.includes(path.sep + item.id + path.sep + "subagents" + path.sep));
      if (item) item.files.push(file);
    }
  }
}
async function readFile(file, root, agent, expected, budget) {
  let handle;
  try {
    const real = await fs.promises.realpath(file);
    if (!inside(root, real)) return { rows: [], partial: true };
    handle = await fs.promises.open(real, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0));
    const stat = await handle.stat();
    if (!stat.isFile() || typeof process.getuid === "function" && stat.uid !== process.getuid()) return { rows: [], partial: true };
    const fingerprint = [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(":");
    const key = `${agent}:${expected}:${real}`, prior = cache.get(key);
    if (prior?.fingerprint === fingerprint) { cache.delete(key); cache.set(key, prior); return prior.result; }
    const parser = createUsageParser(agent, expected), buffer = Buffer.allocUnsafe(65536);
    let offset = 0, carry = Buffer.alloc(0), oversized = false, partial = stat.size > MAX_FILE, controlOnly = agent === "claude-code", lines = 0;
    const end = Math.min(stat.size, MAX_FILE);
    while (offset < end && budget.bytes < MAX_SCAN && Date.now() < budget.deadline) {
      const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, end - offset), offset);
      if (!bytesRead) break;
      offset += bytesRead; budget.bytes += bytesRead;
      let chunk = buffer.subarray(0, bytesRead), start = 0;
      for (let at = chunk.indexOf(10); at !== -1; at = chunk.indexOf(10, start)) {
        const segment = chunk.subarray(start, at);
        if (!oversized && carry.length + segment.length <= MAX_LINE) {
          const line = carry.length ? Buffer.concat([carry, segment]) : segment;
          try {
            const row = JSON.parse(line.toString("utf8")); lines++;
            controlOnly &&= ["launched", "started", "result"].includes(row?.type) && !row.message?.usage;
            parser.consume(row);
          } catch { if (line.length) partial = true; }
        } else partial = true;
        carry = Buffer.alloc(0); oversized = false; start = at + 1;
      }
      const last = chunk.subarray(start);
      if (!oversized && carry.length + last.length <= MAX_LINE) carry = carry.length ? Buffer.concat([carry, last]) : Buffer.from(last);
      else { carry = Buffer.alloc(0); oversized = true; partial = true; }
    }
    // A trailing unfinished JSONL record belongs to the next snapshot.
    const parsed = parser.result(), after = await handle.stat();
    if (after.ino !== stat.ino || after.dev !== stat.dev || after.size < stat.size || after.size === stat.size && after.mtimeMs !== stat.mtimeMs) return { rows: [], partial: true };
    const ignored = controlOnly && lines > 0 && !partial && !carry.length && offset === stat.size;
    partial ||= !ignored && (offset < stat.size || parsed.skipped > 0 || parsed.invalid);
    const result = { rows: parsed.rows, partial, invalid: parsed.invalid, ignored };
    if (!partial) {
      cache.delete(key); cache.set(key, { fingerprint, result });
      let count = 0;
      for (const value of cache.values()) count += value.result.rows.length;
      while (cache.size > 128 || count > 120000) { const first = cache.keys().next().value; count -= cache.get(first).result.rows.length; cache.delete(first); }
    }
    return result;
  } catch { return { rows: [], partial: true }; }
  finally { await handle?.close().catch(() => {}); }
}
async function report({ home, roots, entries, query, prices, priceUpdatedAt }) {
  const budget = { deadline: Date.now() + 16000, bytes: 0, visited: 0, limited: false };
  const selections = entries.slice(0, 2000).map(entry => ({ ...entry, id: nativeId(entry.record), files: [], root: null }));
  const coverage = { covered: 0, missing: 0, unsupported: 0, partial: entries.length > 2000 ? 1 : 0 };
  const baseRoots = { pi: path.join(home, ".pi", "agent", "sessions"), "claude-code": roots.claude || path.join(home, ".claude", "projects"), codex: roots.codex || path.join(home, ".codex") };
  for (const agent of SUPPORTED) {
    const wanted = selections.filter(item => item.record.agentId === agent);
    if (!wanted.length) continue;
    let root;
    try { root = await fs.promises.realpath(baseRoots[agent]); } catch { continue; }
    for (const item of wanted) item.root = root;
    if (agent === "pi") {
      for (const item of wanted) {
        const file = item.record.file;
        if (typeof file === "string") {
          const candidate = path.isAbsolute(file) ? file : path.resolve(root, file);
          if (inside(root, candidate)) item.files.push(candidate);
        }
      }
      // A just-created Pi session may not have saved its file into the registry.
      const unresolved = wanted.filter(item => !item.files.length && item.id);
      if (unresolved.length) await discover(root, unresolved, budget);
    } else {
      const valid = wanted.filter(item => /^[a-f0-9-]{36}$/i.test(item.id));
      if (agent === "codex") for (const folder of ["sessions", "archived_sessions"]) await discover(path.join(root, folder), valid, budget);
      else await discover(root, valid, budget);
    }
  }
  const seen = new Map();
  for (const item of selections.sort((a, b) => (a.addedAt || 0) - (b.addedAt || 0))) {
    if (!SUPPORTED.has(item.record.agentId)) { coverage.unsupported++; continue; }
    if (!item.files.length) { coverage.missing++; continue; }
    let good = false, partial = false;
    for (const file of [...new Set(item.files)].sort()) {
      const read = await readFile(file, item.root, item.record.agentId, item.id, budget);
      partial ||= read.partial; good ||= !read.ignored && (!read.invalid && !read.partial || read.rows.length > 0);
      for (const row of read.rows) if (!seen.has(row.identity)) {
        if (seen.size >= 150000) { budget.limited = true; break; }
        seen.set(row.identity, { ...row, entry: item });
      }
    }
    if (good) coverage.covered++; else coverage.missing++;
    if (partial) coverage.partial++;
  }
  if (budget.limited) coverage.partial++;
  const total = empty(), groups = Object.fromEntries(["days", "models", "agents", "projects", "sessions"].map(key => [key, new Map()]));
  const formatter = new Intl.DateTimeFormat("en-CA", { timeZone: query.timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
  const dateOf = at => { const parts = Object.fromEntries(formatter.formatToParts(at).map(p => [p.type, p.value])); return `${parts.year}-${parts.month}-${parts.day}`; };
  const facets = { agents: new Map(), projects: new Map(), models: new Map() };
  function fold(kind, id, row, cost, extra = {}) {
    let group = groups[kind].get(id);
    if (!group) { group = { ...empty(), id, ...extra }; groups[kind].set(id, group); }
    addCall(group, row, cost);
  }
  for (const row of seen.values()) {
    if (row.at < query.from || row.at >= query.to) continue;
    const entry = row.entry, record = entry.record, modelId = JSON.stringify([row.provider, row.model]), project = record.cwd || "";
    facets.agents.set(record.agentId, { id: record.agentId, name: record.agentId });
    facets.projects.set(project, { id: project, name: path.basename(project) || "—" });
    facets.models.set(modelId, { id: modelId, name: row.model, provider: row.provider });
    if (query.agent && query.agent !== record.agentId || query.project && query.project !== project || query.model && query.model !== modelId || query.entry && query.entry !== entry.key) continue;
    const cost = estimate(row, prices); addCall(total, row, cost);
    const date = dateOf(row.at);
    fold("days", date, row, cost, { date }); fold("models", modelId, row, cost, { name: row.model, provider: row.provider });
    fold("agents", record.agentId, row, cost, { name: record.agentId }); fold("projects", project, row, cost, { name: path.basename(project) || "—", cwd: project });
    fold("sessions", entry.key, row, cost, { name: record.name || record.agentId, agent: record.agentId, cwd: project });
  }
  return { version: 1, total, ...Object.fromEntries(Object.entries(groups).map(([key, map]) => [key, [...map.values()].sort((a, b) => key === "days" ? a.date.localeCompare(b.date) : b.tokens - a.tokens || a.id.localeCompare(b.id))])),
    facets: Object.fromEntries(Object.entries(facets).map(([key, map]) => [key, [...map.values()].sort((a, b) => a.name.localeCompare(b.name))])), coverage,
    range: { from: query.from, to: query.to, timeZone: query.timeZone }, priceUpdatedAt, generatedAt: Date.now(), scope: "workspace", currency: "USD", costKind: "estimate" };
}
if (parentPort) parentPort.on("message", async request => {
  try { parentPort.postMessage({ id: request.id, report: await report(request.input) }); }
  catch { parentPort.postMessage({ id: request.id, error: "usage_unavailable" }); }
});
module.exports = { report };
