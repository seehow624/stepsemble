"use strict";
// Host-private Codex catalog. SQLite selects the current rollout; paths in a
// catalog are inert until checked against the separately granted Codex root.
const path = require("node:path"), crypto = require("node:crypto");
const { setImmediate: yieldToHost } = require("node:timers/promises");
const { canonicalJSON } = require("../../../public/modules/projection");
const wire = require("./sqlite-wire").catalog, historyWire = require("./source-wire");
const { createCodexCatalogPipeline } = require("./metadata-pipeline");
const { isReaderAdmission } = require("../claude/history-reader-admission");
const denied = code => ({ kind: "source_unavailable", code });
const id = value => typeof value === "string" && /^[A-Za-z0-9:_-]{1,128}$/.test(value);
const uuid = value => typeof value === "string" && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
const hash = value => crypto.createHash("sha256").update(canonicalJSON(value, wire.LIMITS.catalogBytes)).digest("hex");
function normalizeGroupSource(input) {
  const value = wire.detach(input);
  if (!wire.keys(value, ["nativeVersion", "sqliteRoot", "expectedSqliteRoot", "codexRoot", "expectedCodexRoot"])) return null;
  for (const [root, identity] of [["sqliteRoot", "expectedSqliteRoot"], ["codexRoot", "expectedCodexRoot"]])
    if (!wire.input({ nativeVersion: value.nativeVersion, source: { sqliteRoot: value[root] }, expectedRoot: value[identity] })) return null;
  if (value.sqliteRoot === value.codexRoot && canonicalJSON(value.expectedSqliteRoot) !== canonicalJSON(value.expectedCodexRoot)) return null;
  return value;
}
function selectHistory(source, entry) {
  // Do not resolve dot segments, tolerate relative paths or infer a private
  // home. A failed routing selection stays visible as an unavailable row.
  if (!path.isAbsolute(entry.rolloutPath) || path.resolve(entry.rolloutPath) !== entry.rolloutPath) return null;
  const locator = path.relative(source.codexRoot, entry.rolloutPath).split(path.sep).join("/");
  const result = { nativeVersion: source.nativeVersion,
    source: { codexRoot: source.codexRoot, threadId: entry.id, rolloutPath: locator }, expectedRoot: source.expectedCodexRoot };
  return historyWire.input(result) ? result : null;
}
function sourceKind(raw) {
  if (["cli", "vscode", "exec", "mcp"].includes(raw)) return "main";
  let value; try { value = JSON.parse(raw); } catch { return "unknown"; }
  if (wire.keys(value, ["custom"]) && typeof value.custom === "string") return "main";
  // Pinned serde SessionSource uses lowercase externally tagged enums. Keep
  // uncertain future values visible; no inferred parent graph from this hint.
  if (wire.keys(value, ["subagent"])) {
    const s = value.subagent;
    if (["review", "compact", "memory_consolidation"].includes(s) || wire.keys(s, ["other"]) && typeof s.other === "string") return "subagent";
    if (wire.keys(s, ["thread_spawn"])) {
      const spawn = s.thread_spawn;
      if (wire.own(spawn, ["parent_thread_id", "depth", "agent_path", "agent_nickname", "agent_role", "agent_type"])
        && uuid(spawn.parent_thread_id) && Number.isInteger(spawn.depth) && spawn.depth >= -2147483648 && spawn.depth <= 2147483647
        && ["agent_path", "agent_nickname", "agent_role", "agent_type"].every(k => spawn[k] === undefined || spawn[k] === null || typeof spawn[k] === "string")
        && !(Object.hasOwn(spawn, "agent_role") && Object.hasOwn(spawn, "agent_type"))) return "subagent";
    }
  }
  if (wire.keys(value, ["internal"]) && ["memory_consolidation", "guardian"].includes(value.internal)) return "internal";
  return "unknown";
}
function createCodexSourceIndex(options) {
  if (!wire.own(options, ["sourceId", "source", "helperPath", "authorize", "createHelper", "admission", "platform"])) throw new TypeError("invalid_codex_source_index_options");
  const { sourceId, authorize, admission } = options, source = normalizeGroupSource(options.source);
  if (!id(sourceId) || !source || typeof authorize !== "function" || !isReaderAdmission(admission)) throw new TypeError("invalid_codex_source_index_options");
  const pipeline = createCodexCatalogPipeline({ helperPath: options.helperPath, admission,
    ...(options.createHelper === undefined ? {} : { createHelper: options.createHelper }), ...(options.platform === undefined ? {} : { platform: options.platform }) });
  const request = { nativeVersion: source.nativeVersion, source: { sqliteRoot: source.sqliteRoot }, expectedRoot: source.expectedSqliteRoot };
  const groupFingerprint = hash([sourceId, source]);
  let closed = false, flight = null, revision = 0, snapshotId = null, stale = true, lastError = null, shutdownPromise;
  let entries = [], lookupEntries = new Map(), sourceVersion = null, changes = { added: 0, changed: 0, removed: 0 };
  function allowed(principal) { try { return id(principal) && authorize(principal, sourceId) === true; } catch { return false; } }
  function problem() {
    const state = pipeline.status();
    return closed || state.closed ? "source_service_closed" : state.quarantined ? "source_service_quarantined" : null;
  }
  function metadata(principal) {
    if (!allowed(principal)) return denied("history_source_unavailable");
    const error = problem(); if (error) return denied(error);
    return { sourceId, snapshotId, stale, refreshing: flight !== null, lastError, total: entries.length };
  }
  function view(principal) {
    const state = metadata(principal); if (state.kind === "source_unavailable") return state;
    return { kind: "source_inventory_state", sourceId, revision, stale, refreshing: flight !== null, lastError,
      snapshot: snapshotId === null ? null : structuredClone({ entries, sourceVersion, changes }), sourceAuthenticated: false, publishable: false };
  }
  function lookup(principal, catalogId) {
    if (!allowed(principal) || problem()) return null;
    const selected = lookupEntries.get(catalogId);
    return selected ? structuredClone({ source: selected.source, revision: selected.revision, unavailable: selected.unavailable }) : null;
  }
  function matchesSelection(principal, catalogId, selectionRevision) {
    return allowed(principal) && !problem() && typeof selectionRevision === "string" && lookupEntries.get(catalogId)?.revision === selectionRevision;
  }
  function page(principal, input) {
    const state = metadata(principal); if (state.kind === "source_unavailable") return state;
    const r = wire.detach(input);
    if (!wire.keys(r, ["offset", "limit", "snapshotId"]) || !Number.isSafeInteger(r.offset) || r.offset < 0 || r.offset > 2048
      || !Number.isSafeInteger(r.limit) || r.limit < 1 || r.limit > 50 || !(r.snapshotId === null || uuid(r.snapshotId))) return denied("invalid_history_request");
    if (r.snapshotId !== null && r.snapshotId !== snapshotId || r.offset > 0 && r.snapshotId === null || r.offset > entries.length) return denied("history_catalog_changed");
    const rows = entries.slice(r.offset, r.offset + r.limit).map(e => ({ catalogId: e.catalogId, nativeTitle: null, titleStatus: "not_loaded" }));
    return { kind: "history_source_catalog", ...state, page: { offset: r.offset, limit: r.limit }, nextOffset: r.offset + rows.length < entries.length ? r.offset + rows.length : null,
      entries: rows, sourceAuthenticated: false, publishable: false };
  }
  async function refresh(principal, options = {}) {
    if (!wire.own(options, ["signal"]) || options.signal !== undefined && !(options.signal instanceof AbortSignal)) return denied("invalid_source_signal");
    if (!allowed(principal)) return denied("history_source_unavailable");
    const error = problem(); if (error) return denied(error);
    if (options.signal?.aborted) return denied("source_aborted");
    if (flight) return denied("source_busy");
    if (revision === Number.MAX_SAFE_INTEGER) return denied("source_inventory_limit");
    let settled;
    const current = { principal, controller: new AbortController(), revoked: false, done: new Promise(resolve => { settled = resolve; }) }; flight = current; stale = true;
    const abort = () => current.controller.abort(); options.signal?.addEventListener("abort", abort, { once: true });
    try {
      const value = await pipeline.read(request, { signal: current.controller.signal });
      if (closed || current.revoked || current.controller.signal.aborted || !allowed(principal) || problem()) {
        lastError = problem() ?? "source_aborted"; return denied(lastError);
      }
      if (value.kind !== "codex_catalog_capture") { lastError = value.code; return value; }
      const currentError = () => closed || current.revoked || current.controller.signal.aborted || !allowed(principal) || problem() ? problem() ?? "source_aborted" : null;
      const selectedScope = hash([source, value.source.identities]), next = [];
      for (const row of value.metadata.entries) {
        if (next.length && next.length % 32 === 0) {
          await yieldToHost();
          const error = currentError(); if (error) { lastError = error; return denied(error); }
        }
        const catalogId = "codex-" + hash([groupFingerprint, row.id]), history = selectHistory(source, row);
        const fingerprint = hash([selectedScope, row]);
        const previous = lookupEntries.get(catalogId);
        next.push({ catalogId, revision: previous?.fingerprint === fingerprint ? previous.revision : crypto.randomUUID(), fingerprint,
          native: row, sourceKind: sourceKind(row.source),
          unavailable: !history ? "source_scope_mismatch" : null,
          source: { agentId: "codex", sessionId: row.id, history, historyMode: row.historyMode,
            sqlite: { ...request, source: { ...request.source, threadId: row.id } } } });
      }
      // Recent activity first; raw exact timestamps remain private metadata.
      // Stable ID ordering breaks ties without filename-derived chronology.
      const timestamp = e => BigInt(e.native.updatedAtMs ?? (BigInt(e.native.updatedAt) * 1000n).toString());
      next.sort((a, b) => timestamp(a) === timestamp(b) ? a.native.id < b.native.id ? -1 : a.native.id === b.native.id ? 0 : 1 : timestamp(a) > timestamp(b) ? -1 : 1);
      const remaining = new Set(lookupEntries.keys()); let added = 0, changed = 0;
      for (const row of next) { const old = lookupEntries.get(row.catalogId); if (!old) added++; else if (old.revision !== row.revision) changed++; remaining.delete(row.catalogId); }
      const finalError = currentError(); if (finalError) { lastError = finalError; return denied(finalError); }
      changes = { added, changed, removed: remaining.size }; entries = next; lookupEntries = new Map(next.map(e => [e.catalogId, e]));
      sourceVersion = value.source; snapshotId = crypto.randomUUID(); revision++; stale = false; lastError = null; flight = null;
      return view(principal);
    } catch { lastError = "source_worker_failure"; return denied(lastError); }
    finally { if (flight === current) flight = null; options.signal?.removeEventListener("abort", abort); settled(); }
  }
  function revokePrincipal(principal) { if (flight?.principal === principal) { flight.revoked = true; flight.controller.abort(); } }
  function shutdown() {
    if (shutdownPromise) return shutdownPromise;
    closed = true; stale = true; entries = []; lookupEntries.clear(); snapshotId = null; sourceVersion = null;
    const pending = flight; pending?.controller.abort();
    shutdownPromise = pipeline.shutdown().then(async result => { await pending?.done;
      return { kind: "source_index_closed", cleanupConfirmed: result.cleanupConfirmed, quarantined: result.quarantined }; });
    return shutdownPromise;
  }
  return Object.freeze({ refresh, metadata, view, page, lookup, matchesSelection, revokePrincipal, shutdown,
    status: () => ({ ...pipeline.status(), revision, stale, retainedEntries: entries.length, refreshing: flight !== null }) });
}
module.exports = { createCodexSourceIndex, normalizeGroupSource };
