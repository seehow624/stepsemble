"use strict";
const { parentPort } = require("node:worker_threads");
const path = require("node:path"), fs = require("node:fs/promises");
const { estimate } = require("./usage-pricing");
const { discoverUsageFiles, readUsageFile } = require("./usage-history");
const { empty, addCall, modelIdentity } = require("../public/modules/usage-data");
const SUPPORTED = new Set(["pi", "claude-code", "codex", ...require("./usage-extra-history").SUPPORTED]);
function nativeId(record) { return record.agentId === "codex" ? record.nativeThreadId || record.nativeHistorySessionId || String(record.id || record.taskId || "").replace(/^(codex-history|codex):/, "")
  : record.agentId === "claude-code" ? record.nativeSessionId || record.nativeHistorySessionId || String(record.id || record.taskId || "").replace(/^(claude-history|claude-code):/, "")
  // Pi's sid identifies the RPC process, not the id in the persisted file.
  : record.nativeConversationId || record.nativeSessionId || record.nativeHistorySessionId || (record.file ? "" : record.sid || String(record.id || record.taskId || "").replace(/^[a-z-]+:/, "")); }
async function machineUsage({ home, roots, entries, indexDir, workspaceOnly = false, recentAt = null }) {
  const budget = { deadline: Date.now() + 16000, maxBytes: 16 * 1024 * 1024 * 1024, bytes: 0, visited: 0, limited: false };
  const discovered = await discoverUsageFiles(home, roots, budget);
  // A link's mtime does not follow its archive, and SQLite can append only to
  // the WAL for a long time. Check both before excluding cold histories.
  const files = [];
  for (const file of discovered.files) {
    let modified = file.modified;
    if (recentAt !== null && file.linked) {
      try { modified = (await fs.stat(file.file)).mtimeMs; }
      catch { modified = Infinity; } // normal reader reports the actual failure
    }
    if (recentAt !== null && file.format?.endsWith("-db")) {
      try { modified = Math.max(modified || 0, (await fs.stat(file.file + "-wal")).mtimeMs); }
      catch { /* No WAL; use the main database's modification time. */ }
    }
    if (recentAt === null || !Number.isFinite(modified) || modified >= recentAt - 300000) files.push(file);
  }
  const sources = discovered.sources;
  const registry = entries.slice(0, 2000).sort((a, b) => (a.addedAt || 0) - (b.addedAt || 0));
  const groups = new Map(), seen = new Map(), matched = new Set(), issues = [];
  const coverage = { covered: 0, missing: 0, unsupported: registry.filter(item => !SUPPORTED.has(item.record.agentId)).length, partial: entries.length > 2000 ? 1 : 0, indexing: 0, scope: "history", issuesOmitted: 0 };
  function issue(value) { if (issues.length < 100) issues.push(value); else coverage.issuesOmitted++; }
  for (let at = 0; at < files.length; at++) {
    if (Date.now() >= budget.deadline || budget.bytes >= budget.maxBytes) { coverage.indexing += files.length - at; break; }
    const source = files[at], whole = await readUsageFile(source, budget, indexDir);
    for (const read of whole.collections || [whole]) {
      if (read.ignored) continue;
      if (read.pending) coverage.indexing++;
      const id = !read.invalid && read.session || (source.artifact ? `artifact:${source.artifact}` : source.expected || source.file);
      const registrations = registry.filter(item => {
        if (item.record.agentId !== source.agent) return false;
        const native = nativeId(item.record);
        return !!native && (native === id || !source.artifact && native === source.expected)
          || ["pi", "omp"].includes(source.agent) && typeof item.record.file === "string" && path.resolve(source.root, item.record.file) === source.file;
      });
      const registered = registrations[0];
      if (workspaceOnly && !registered) continue;
      for (const registration of registrations) matched.add(registration.key);
      const groupId = source.agent + ":" + id;
      let group = groups.get(groupId);
      if (!group) {
        const record = { ...registered?.record, agentId: source.agent, cwd: read.meta?.cwd || registered?.record.cwd || "", name: registered?.record.name || read.meta?.name || `${source.agent} · ${id.slice(0, 8)}` };
        group = { key: registered?.key || `native:${groupId}`, record, registered: !!registered, artifact: !!source.artifact, good: false, partial: false, pending: false, problems: [] };
        groups.set(groupId, group);
      }
      if (!source.subagent) {
        group.record.cwd = read.meta?.cwd || registered?.record.cwd || group.record.cwd;
        group.record.name = registered?.record.name || read.meta?.name || group.record.name;
      }
      group.good ||= !read.invalid && !read.partial || read.rows.length > 0;
      group.partial ||= read.partial && !read.pending; group.pending ||= read.pending;
      if (read.partial && !read.pending) group.problems.push({ agent: source.agent, path: source.file, reason: read.reason || "incomplete_records" });
      if (read.precise) group.precise = true;
      for (const row of read.rows) {
        const prior = seen.get(row.identity);
        if (prior) {
          // Copied/forked records share one call. A later Claude stream snapshot
          // can complete its output count without adding a second generation.
          for (const key of Object.keys(row.tokens)) prior.tokens[key] = prior.tokens[key] === null ? row.tokens[key] : row.tokens[key] === null ? prior.tokens[key] : Math.max(prior.tokens[key], row.tokens[key]);
          if (row.cost !== null && (prior.cost === null || row.cost > prior.cost)) prior.cost = row.cost;
          prior.at = Math.min(prior.at, row.at);
          // Exports may be newer than their native source. Prefer a registered
          // conversation, then a native history, for project and Session links.
          if (!prior.entry.registered && (group.registered || prior.entry.artifact && !group.artifact)
            || !prior.entry.record.cwd && group.record.cwd) prior.entry = group;
          continue;
        }
        if (seen.size >= 150000) { budget.limited = true; break; }
        seen.set(row.identity, { ...row, tokens: { ...row.tokens }, entry: group, sourceFormat: source.format });
      }
    }
  }
  // Grok's per-inference log supersedes its turn-level rollup. Never count
  // both views of a generation. A rollup remains useful for other sessions.
  for (const [id,row] of seen) if (row.sourceFormat === "grok-updates" && row.entry.precise) {
    seen.delete(id);
    // The log may have rotated before this session's first turn. Excluding
    // overlapping rollups prevents double counting, but cannot prove that
    // the retained per-call log covers its entire lifetime.
    if (!row.entry.rollupExcluded) {
      row.entry.rollupExcluded = true; row.entry.partial = true;
      row.entry.problems.push({ agent: "grok-build", path: "", reason: "overlapping_history" });
    }
  }
  for (const group of groups.values()) {
    if (group.good) coverage.covered++; else if (!group.pending) coverage.missing++;
    if (group.partial) coverage.partial++;
    for (const problem of group.problems) issue({ ...problem, entry: group.key, name: group.record.name, status: group.good ? "partial" : "missing" });
  }
  // Retain a warning for explicitly added histories that have disappeared.
  // During initial indexing an unmatched entry may simply be later in the scan.
  if (!coverage.indexing && !budget.limited) for (const item of registry.filter(item => SUPPORTED.has(item.record.agentId) && !matched.has(item.key))) {
    coverage.missing++;
    issue({ agent: item.record.agentId, entry: item.key, name: item.record.name || nativeId(item.record) || item.record.agentId, path: typeof item.record.file === "string" ? item.record.file : "", reason: "missing_file", status: "missing" });
  }
  if (budget.limited && !coverage.indexing) coverage.partial++;
  return { seen, coverage, sources, issues };
}
async function report(input) {
  const { home, roots = {}, entries = [], query, prices = {}, priceUpdatedAt } = input;
  const scope = query.scope === "workspace" ? "workspace" : "machine";
  const { seen, coverage, sources, issues } = await machineUsage({ home, roots, entries, indexDir: input.indexDir, workspaceOnly: scope === "workspace", recentAt: input.kind === "activity" ? input.at : null });
  if (input.kind === "activity") return { ...require("./recent-usage").summarizeRecent(seen.values(), input.at), coverage,
    available: coverage.covered > 0 || !(coverage.indexing || coverage.missing || coverage.partial || coverage.unsupported),
    partial: !!(coverage.indexing || coverage.partial || coverage.missing || coverage.unsupported) };
  const total = empty(), groups = Object.fromEntries(["days", "models", "agents", "projects", "sessions"].map(key => [key, new Map()]));
  const formatter = new Intl.DateTimeFormat("en-CA", { timeZone: query.timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
  const dateOf = at => { const parts = Object.fromEntries(formatter.formatToParts(at).map(p => [p.type, p.value])); return `${parts.year}-${parts.month}-${parts.day}`; };
  const facets = { agents: new Map(), projects: new Map(), models: new Map() };
  let dateApproximateRecords = 0;
  function fold(kind, id, row, cost, extra = {}) {
    let group = groups[kind].get(id);
    if (!group) { group = { ...empty(), id, ...extra }; groups[kind].set(id, group); }
    addCall(group, row, cost);
  }
  for (const row of seen.values()) {
    if (row.at < query.from || row.at >= query.to) continue;
    const entry = row.entry, record = entry.record, model = modelIdentity(row.provider, row.model), modelId = JSON.stringify([model.provider, model.model]), project = record.cwd || "";
    facets.agents.set(record.agentId, { id: record.agentId, name: record.agentId });
    facets.projects.set(project, { id: project, name: path.basename(project) || "—" });
    facets.models.set(modelId, { id: modelId, name: model.model, provider: model.provider });
    // Older clients may still send an id from a report grouped by the recorded
    // connection. Keep that exact filter working during a rolling update.
    const matchesModel = !query.model || query.model === modelId || query.model === JSON.stringify([row.provider, row.model]);
    if (query.agent && query.agent !== record.agentId || query.project && query.project !== project || !matchesModel || query.entry && query.entry !== entry.key) continue;
    if (row.dateApproximate) dateApproximateRecords++;
    const cost = estimate(row, prices); addCall(total, row, cost);
    const date = dateOf(row.at);
    fold("days", date, row, cost, { date }); fold("models", modelId, row, cost, { name: model.model, provider: model.provider });
    fold("agents", record.agentId, row, cost, { name: record.agentId }); fold("projects", project, row, cost, { name: path.basename(project) || "—", cwd: project });
    fold("sessions", entry.key, row, cost, { name: record.name || record.agentId, agent: record.agentId, cwd: project, registered: entry.registered !== false });
  }
  return { version: 1, total, ...Object.fromEntries(Object.entries(groups).map(([key, map]) => [key, [...map.values()].sort((a, b) => key === "days" ? a.date.localeCompare(b.date) : b.tokens - a.tokens || a.id.localeCompare(b.id))])),
    facets: Object.fromEntries(Object.entries(facets).map(([key, map]) => [key, [...map.values()].sort((a, b) => a.name.localeCompare(b.name))])), coverage, issues,
    range: { from: query.from, to: query.to, timeZone: query.timeZone }, priceUpdatedAt, generatedAt: Date.now(), scope, sources, currency: "USD", costKind: "estimate", modelGrouping: "vendor", dateApproximateRecords };
}
if (parentPort) parentPort.on("message", async request => {
  try { parentPort.postMessage({ id: request.id, report: await report(request.input) }); }
  catch { parentPort.postMessage({ id: request.id, error: "usage_unavailable" }); }
});
module.exports = { report };
