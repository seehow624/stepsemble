"use strict";
// Trusted Host binding around the existing admitted, double-revalidated reader.
// No credential, native CLI, execution, provider routing or implicit source grant.
const crypto = require("node:crypto");
const { createCodexHistoryPipeline } = require("./history-pipeline");
const { normalizeGroupSource } = require("./history-source-index");
const { isReaderAdmission } = require("../claude/history-reader-admission");
const wire = require("./parser-wire"), sql = require("./sqlite-wire").context;
const historyWire = require("./source-wire");
const publicWire = require("../../../public/modules/codex-history-records");
const LIMITS = Object.freeze({ bindings: 64, groups: 8, sourceBytes: 64 * 1024, responseBytes: 384 * 1024, pageRecords: 50, records: 8192 });
const unavailable = code => ({ kind: "source_unavailable", code });
const uuid = value => typeof value === "string" && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
const token = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
function normalizeCodexSource(input) {
  const v = wire.detach(input, LIMITS.sourceBytes);
  if (!wire.keys(v, ["agentId", "sessionId", "history", "sqlite", "historyMode"]) || v.agentId !== "codex" || !uuid(v.sessionId)
    || !["legacy", "paginated"].includes(v.historyMode) || !historyWire.input(v.history) || !sql.input(v.sqlite)
    || v.history.source.threadId !== v.sessionId || v.sqlite.source.threadId !== v.sessionId) return null;
  return v;
}
function sourceGroup(source) {
  return { nativeVersion: source.history.nativeVersion, codexRoot: source.history.source.codexRoot, expectedCodexRoot: source.history.expectedRoot,
    sqliteRoot: source.sqlite.source.sqliteRoot, expectedSqliteRoot: source.sqlite.expectedRoot };
}
const key = value => JSON.stringify([value.nativeVersion, value.codexRoot, value.expectedCodexRoot.device, value.expectedCodexRoot.inode,
  value.sqliteRoot, value.expectedSqliteRoot.device, value.expectedSqliteRoot.inode]);
const validPage = (page, profile) => publicWire.validPage(page, profile);
function createCodexSourceService(options = {}) {
  if (!sql.own(options, ["helperPath", "roots", "admission", "createHelper", "spawnChild", "platform", "deadlineMs", "cleanupMs"]))
    throw new TypeError("invalid_codex_source_service_options");
  const { roots: input, ...readerOptions } = options;
  const roots = wire.detach(input, LIMITS.sourceBytes * LIMITS.groups);
  if (!isReaderAdmission(options.admission) || !Array.isArray(roots) || roots.length > LIMITS.groups) throw new TypeError("invalid_codex_source_roots");
  const grants = new Set(), identities = new Map();
  for (const value of roots) {
    const group = normalizeGroupSource(value);
    if (!group || grants.has(key(group))) throw new TypeError("invalid_codex_source_roots");
    for (const [root, identity] of [[group.codexRoot, group.expectedCodexRoot], [group.sqliteRoot, group.expectedSqliteRoot]]) {
      const prior = identities.get(root);
      if (prior && (prior.device !== identity.device || prior.inode !== identity.inode)) throw new TypeError("invalid_codex_source_roots");
      identities.set(root, identity);
    }
    grants.add(key(group));
  }
  const admission = options.admission, pipeline = createCodexHistoryPipeline(readerOptions), bindings = new Map();
  let closed = false, shutdownPromise;
  function sweep() {
    const status = pipeline.status();
    // Unknown cleanup never frees a generation just because its promise settled.
    // Once quarantined, the global reader remains closed to new work even if a
    // late actual-close lets the registry retire these old handles safely.
    if (status.cleanupConfirmed) for (const state of bindings.values()) if (state.flight?.unknown) state.flight = null;
    return status;
  }
  function bind(input) {
    const status = sweep();
    if (closed || status.closed) return unavailable("source_service_closed");
    if (status.quarantined) return unavailable("source_service_quarantined");
    const value = wire.detach(input, LIMITS.sourceBytes), source = normalizeCodexSource(value?.source);
    if (!wire.keys(value, ["bindingId", "generation", "source"]) || !uuid(value.bindingId) || !Number.isSafeInteger(value.generation) || value.generation < 1
      || !source || !grants.has(key(sourceGroup(source)))) return unavailable("invalid_source_binding");
    const previous = bindings.get(value.bindingId);
    if (previous && (!previous.revoked || previous.flight || value.generation <= previous.generation)) return unavailable("source_binding_conflict");
    if (!previous && bindings.size >= LIMITS.bindings) return unavailable("source_binding_limit");
    const state = { generation: value.generation, revoked: false, flight: null, version: null };
    bindings.set(value.bindingId, state);
    const revoke = () => { state.revoked = true; state.version = null; state.flight?.controller.abort(); };
    async function read(input, options, metadata) {
      const status = sweep();
      if (!sql.own(options, ["signal", "version", ...(metadata ? [] : ["page", "structured", "profile"])])
        || options.structured !== undefined && options.structured !== true
        || options.profile !== undefined && (!publicWire.validProfile(options.profile) || options.structured !== undefined)) return unavailable("invalid_history_options");
      let profile = options.profile, paged = publicWire.validProfile(profile), globalStructure = profile === publicWire.STRUCTURED_PAGE_PROFILE;
      const request = wire.detach(input), page = wire.detach(options.page ?? { offset: 0, limit: 25 });
      if (!wire.keys(request, ["bindingId", "generation", "requestId"]) || request.bindingId !== value.bindingId || request.generation !== value.generation || !uuid(request.requestId))
        return unavailable("source_binding_mismatch");
      if (!validPage(page, options.profile)) return unavailable("invalid_history_page");
      if (options.signal !== undefined && !(options.signal instanceof AbortSignal)) return unavailable("invalid_source_signal");
      if (options.version !== undefined && !token(options.version)) return unavailable("invalid_history_version");
      if (closed || status.closed) return unavailable("source_service_closed");
      if (status.quarantined) return unavailable("source_service_quarantined");
      if (state.revoked || bindings.get(value.bindingId) !== state) return unavailable("source_binding_revoked");
      if (options.signal?.aborted) return unavailable("source_aborted");
      if (state.flight) return unavailable("source_busy");
      if (options.version !== undefined && state.version?.token !== options.version) return unavailable("source_version_unavailable");
      // No empty transcript fallback for unsupported native storage.
      if (!metadata && source.historyMode === "paginated") return unavailable("native_paginated_history_unsupported");
      const expected = options.version === undefined ? null : state.version;
      // Opaque versions belong to one capture protocol. They cannot be reused
      // to silently upgrade/downgrade source validation or storage semantics.
      if (expected && !metadata && expected.profile !== options.profile) return unavailable("source_version_unavailable");
      if (expected && metadata) { profile = expected.profile; paged = publicWire.validProfile(profile); globalStructure = profile === publicWire.STRUCTURED_PAGE_PROFILE; }
      let finish;
      const controller = new AbortController(), current = { controller, unknown: false, done: new Promise(resolve => { finish = resolve; }) }; state.flight = current;
      const abort = () => controller.abort(); options.signal?.addEventListener("abort", abort, { once: true });
      try {
        const capture = () => pipeline[globalStructure ? "readNamedStructuredPage" : paged ? "readNamedPage" : "readNamed"]({ history: source.history, sqlite: source.sqlite, method: "thread_read_sqlite" },
          { selection: metadata ? { mode: "names" } : { mode: "records", ...page }, ...(options.structured === true ? { structured: true } : {}),
            ...(expected ? { expectedVersion: expected.source } : {}), signal: controller.signal });
        let result = await capture();
        // Metadata's public shape is unchanged. Select the page-capable native
        // name reader only for a fresh, legacy, size-limited source and only
        // after the old reader has physically closed. No error retry loop.
        const beforeSwitch = pipeline.status();
        if (metadata && !expected && !paged && source.historyMode === "legacy" && result.kind === "source_unavailable"
          && ["source_too_large", "rollout_record_limit", "rollout_compression_limit"].includes(result.code) && beforeSwitch.cleanupConfirmed
          && !beforeSwitch.closed && !beforeSwitch.quarantined && !closed && !state.revoked && !controller.signal.aborted) {
          profile = publicWire.PAGE_PROFILE; paged = true; result = await capture();
        }
        const status = pipeline.status();
        if (result?.code === "source_cleanup_unconfirmed" || status.quarantined && !status.cleanupConfirmed) {
          current.unknown = true; return unavailable("source_cleanup_unconfirmed");
        }
        if (closed || status.closed) return unavailable("source_service_closed");
        if (state.revoked || bindings.get(value.bindingId) !== state) return unavailable("source_binding_revoked");
        if (controller.signal.aborted) return unavailable("source_aborted");
        if (status.quarantined) return unavailable("source_service_quarantined");
        if (result.kind === "source_unavailable") return result;
        if (result.kind !== (globalStructure ? "codex_named_structured_page_capture" : paged ? "codex_named_page_capture" : "codex_named_capture") || result.cleanupConfirmed !== true
          || !(globalStructure ? wire.sameStructuredNamedVersion(result.source, result.source) : wire.sameNamedVersion(result.source, result.source, paged))
          || result.source.history.threadId !== source.sessionId || result.name?.nativeThreadId !== source.sessionId
          || result.consistency !== "matching_selected_versions_before_and_after_parse") return unavailable("source_worker_protocol");
        const version = expected ?? { token: crypto.randomBytes(32).toString("hex"), source: result.source, profile };
        const common = { bindingId: value.bindingId, generation: value.generation, requestId: request.requestId, sourceVersion: version.token,
          sourceAuthenticated: false, publishable: false, cleanupConfirmed: true };
        let output;
        if (metadata) {
          output = { ...common, kind: "bound_codex_metadata", source: result.source, name: result.name,
            metadata: { sessionId: source.sessionId, nativeTitle: result.name.name, summary: null, titleStatus: result.name.name === null ? "untitled" : "native" } };
        } else {
          output = { ...common, kind: "bound_codex_records", history: { kind: globalStructure ? "codex_structured_page_source_records" : paged ? "codex_validated_source_records" : "codex_source_records", nativeVersion: "0.153.4", nativeThreadId: source.sessionId,
            nativeTitle: result.name.name, page, records: result.page, ...(options.structured === true || globalStructure ? { structure: result.structure } : {}),
            semanticHistoryComplete: false, sourceAuthenticated: false, publishable: false,
            authority: { sourceAuthenticated: false, approvalAcknowledged: false, runTerminalObserved: false, resumeAllowed: false } } };
        }
        const detached = wire.detach(output, LIMITS.responseBytes);
        if (!detached) return unavailable("source_observation_too_large");
        state.version = version;
        return detached;
      } catch {
        if (!pipeline.status().cleanupConfirmed) { current.unknown = true; admission.quarantine(); return unavailable("source_cleanup_unconfirmed"); }
        return unavailable("source_worker_failure");
      }
      finally { if (state.flight === current && !current.unknown) state.flight = null; options.signal?.removeEventListener("abort", abort); finish(); }
    }
    return Object.freeze({ kind: "bound_source", descriptor: Object.freeze({ bindingId: value.bindingId, generation: value.generation, sessionId: source.sessionId }),
      observe: (input, options = {}) => read(input, options, false), metadata: (input, options = {}) => read(input, options, true), revoke,
      status: () => { sweep(); return Object.freeze({ revoked: state.revoked, activeWorker: state.flight !== null, cleanupConfirmed: state.flight === null }); } });
  }
  function shutdown() {
    if (shutdownPromise) return shutdownPromise;
    closed = true;
    const pending = [...bindings.values()].flatMap(state => state.flight ? [state.flight.done] : []);
    for (const state of bindings.values()) { state.revoked = true; state.version = null; state.flight?.controller.abort(); }
    shutdownPromise = Promise.all([pipeline.shutdown(), ...pending]).then(([result]) => { sweep(); return { kind: "codex_source_service_closed",
      cleanupConfirmed: result.cleanupConfirmed && [...bindings.values()].every(s => s.flight === null), quarantined: result.quarantined }; });
    return shutdownPromise;
  }
  return Object.freeze({ bind, shutdown, status: () => ({ ...sweep(), closed: closed || pipeline.status().closed, retainedBindings: bindings.size }) });
}
module.exports = { createCodexSourceService, normalizeCodexSource, validPage, LIMITS };
