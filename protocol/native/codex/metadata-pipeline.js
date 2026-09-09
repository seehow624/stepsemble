"use strict";
// Single owned Rust capture, then bounded pure name interpretation. Caller owns
// grants/revocation and the same admission used by every other history reader.
const { performance } = require("node:perf_hooks");
const { createNativeHelper, LIMITS, SOURCE_CODES } = require("../claude/history-native-helper");
const { isReaderAdmission, LIMIT } = require("../claude/history-reader-admission");
const sqliteWire = require("./sqlite-wire"), { observeMetadataName } = require("./metadata-name");
const unavailable = code => ({ kind: "source_unavailable", code });
const codes = new Set([...SOURCE_CODES, "source_worker_exit", "source_worker_timeout", "source_worker_spawn_failed", "source_worker_io_error",
  "source_worker_diagnostic", "source_worker_input_limit", "source_worker_output_limit", "source_worker_protocol", "source_aborted",
  "source_cleanup_unconfirmed", "source_service_quarantined", "source_service_closed"]);
function createPipeline(options = {}, withContext = false, withCatalog = false) {
  const wire = withCatalog ? sqliteWire.catalog : withContext ? sqliteWire.context : sqliteWire;
  const method = withCatalog ? "readCodexCatalog" : withContext ? "readCodexNameContext" : "readCodexMetadata";
  if (!wire.own(options, ["helperPath", "admission", "createHelper", "platform", "deadlineMs", "cleanupMs"])) throw new TypeError("invalid_codex_metadata_pipeline_options");
  const { helperPath, admission, createHelper = createNativeHelper, platform = process.platform,
    deadlineMs = LIMITS.deadlineMs, cleanupMs = LIMITS.cleanupMs } = options;
  if (!isReaderAdmission(admission) || typeof createHelper !== "function"
    || ![deadlineMs, cleanupMs].every(v => Number.isSafeInteger(v) && v > 0) || deadlineMs > LIMITS.deadlineMs || cleanupMs > LIMITS.cleanupMs)
    throw new TypeError("invalid_codex_metadata_pipeline_options");
  // Validate even when a trusted test factory replaces the actual child runner.
  createNativeHelper({ executablePath: helperPath, trustBoundary: "host_managed_executable", platform, deadlineMs, cleanupMs });
  const slots = Array.from({ length: LIMIT }, () => ({ flight: null, helper: createHelper({ executablePath: helperPath,
    trustBoundary: "host_managed_executable", platform, deadlineMs, cleanupMs }) }));
  if (new Set(slots.map(s => s.helper)).size !== LIMIT || slots.some(s => !s.helper || [method, "status", "shutdown"].some(k => typeof s.helper[k] !== "function")))
    throw new TypeError("invalid_codex_metadata_pipeline_helper");
  let closed = false, quarantined = false, shutdownPromise = null;
  const flights = new Set();
  function quarantine() {
    if (quarantined) return;
    quarantined = true; admission.quarantine();
    for (const f of flights) f.stop("source_service_quarantined");
  }
  function helperClosed(slot) {
    try { const s = slot.helper.status(); if (s.quarantined) quarantine(); return s.activeWorker === false && s.cleanupConfirmed === true; }
    catch { quarantine(); return false; }
  }
  function release(f) { flights.delete(f); if (f.slot.flight === f) f.slot.flight = null; }
  function sweep() {
    if (admission.status().quarantined) quarantine();
    for (const f of flights) if (f.settled && f.helperSettled && helperClosed(f.slot)) release(f);
  }
  async function read(input, options = {}) {
    sweep();
    if (!wire.own(options, ["signal", "expectedVersion"])) return unavailable("invalid_codex_metadata_request");
    const request = wire.detach(input), expected = options.expectedVersion === undefined ? null : wire.detach(options.expectedVersion);
    if (!wire.input(request) || options.expectedVersion !== undefined && !wire.sameSourceVersion(expected, expected)) return unavailable("invalid_codex_metadata_request");
    const signal = options.signal;
    if (signal !== undefined && !(signal instanceof AbortSignal)) return unavailable("invalid_source_signal");
    if (closed || admission.status().closed) return unavailable("source_service_closed");
    if (quarantined) return unavailable("source_service_quarantined");
    if (signal?.aborted) return unavailable("source_aborted");
    if (!["darwin", "linux"].includes(platform)) return unavailable("source_platform_unsupported");
    const slot = slots.find(s => !s.flight);
    if (!slot) return unavailable("source_busy");
    if (!helperClosed(slot) || quarantined) return unavailable("source_service_quarantined");
    let resolve;
    const promise = new Promise(done => { resolve = done; }), controller = new AbortController();
    const f = { slot, promise, stop, helperSettled: false, settled: false };
    const permit = admission.acquire(stop, () => f.helperSettled && helperClosed(slot));
    if (permit.kind !== "reader_permit") return permit;
    slot.flight = f; flights.add(f);
    let failure = null, cleanupTimer = null;
    const expires = performance.now() + deadlineMs, timer = setTimeout(() => stop("source_worker_timeout"), deadlineMs);
    const abort = () => stop("source_aborted");
    function settle(result) {
      if (f.settled) return;
      f.settled = true; clearTimeout(timer); clearTimeout(cleanupTimer); signal?.removeEventListener("abort", abort);
      if (f.helperSettled && helperClosed(slot)) release(f);
      permit.finish(); resolve(result);
    }
    function stop(code) {
      if (failure || f.settled) return;
      failure = code;
      cleanupTimer = setTimeout(() => { quarantine(); settle(unavailable("source_cleanup_unconfirmed")); }, cleanupMs);
      controller.abort();
      if (f.helperSettled && helperClosed(slot)) settle(unavailable(failure));
    }
    function current() {
      if (failure || f.settled) return false;
      if (closed || admission.status().closed) stop("source_service_closed");
      else if (quarantined || admission.status().quarantined) stop("source_service_quarantined");
      else if (signal?.aborted) stop("source_aborted");
      else if (performance.now() >= expires) stop("source_worker_timeout");
      return !failure && !f.settled;
    }
    signal?.addEventListener("abort", abort, { once: true });
    async function run() {
      if (!current()) { f.helperSettled = true; settle(unavailable(failure)); return; }
      let raw;
      try { raw = await slot.helper[method](request, { signal: controller.signal }); } catch { raw = unavailable("source_worker_failure"); }
      f.helperSettled = true;
      if (!helperClosed(slot)) { failure ||= "source_cleanup_unconfirmed"; controller.abort(); quarantine(); settle(unavailable("source_cleanup_unconfirmed")); return; }
      if (!current()) { if (!f.settled) settle(unavailable(failure)); else sweep(); return; }
      if (wire.own(raw, ["kind", "code"]) && wire.keys(raw, ["kind", "code"]) && raw.kind === "source_unavailable") {
        if (["source_cleanup_unconfirmed", "source_service_quarantined"].includes(raw.code)) { failure = raw.code; quarantine(); }
        settle(unavailable(codes.has(raw.code) ? raw.code : "source_worker_failure")); return;
      }
      const inspected = wire.inspectCapture(raw, request), captured = inspected?.captured, version = inspected?.version;
      if (!version) return settle(unavailable("source_worker_protocol"));
      if (expected !== null && !wire.sameSourceVersion(expected, version)) return settle(unavailable("source_version_changed"));
      if (withCatalog) {
        if (!current()) return;
        return settle({ kind: "codex_catalog_capture", source: version, metadata: captured.metadata.observation,
          sourceAuthenticated: false, publishable: false, cleanupConfirmed: true });
      }
      const metadata = observeMetadataName(captured.metadata.observation.fields, { nativeVersion: request.nativeVersion, threadId: request.source.threadId });
      if (!current()) return;
      if (metadata.kind !== "codex_metadata_name_observation") return settle(unavailable("source_observation_rejected"));
      settle({ kind: withContext ? "codex_sqlite_context_capture" : "codex_sqlite_name_capture", source: version, metadata,
        ...(withContext ? { nameContext: captured.metadata.observation.nameContext } : {}), sourceAuthenticated: false, publishable: false, cleanupConfirmed: true });
    }
    run().catch(() => { if (!f.helperSettled) stop("source_worker_failure"); else if (!f.settled) settle(unavailable(failure || "source_worker_failure")); });
    return promise;
  }
  function shutdown() {
    if (shutdownPromise) return shutdownPromise;
    closed = true; for (const f of flights) f.stop("source_service_closed");
    shutdownPromise = (async () => {
      await Promise.all([...flights].map(f => f.promise));
      await Promise.all(slots.map(async s => { try { await s.helper.shutdown(); } catch { quarantine(); } }));
      sweep(); return { kind: "codex_metadata_pipeline_closed", cleanupConfirmed: flights.size === 0, quarantined };
    })();
    return shutdownPromise;
  }
  return Object.freeze({ read, shutdown, status() { sweep(); return Object.freeze({ closed: closed || admission.status().closed, quarantined,
    activeWorkers: flights.size, cleanupConfirmed: flights.size === 0 }); } });
}
function createCodexMetadataPipeline(options) { return createPipeline(options); }
function createCodexNameContextPipeline(options) { return createPipeline(options, true); }
function createCodexCatalogPipeline(options) { return createPipeline(options, false, true); }
module.exports = { createCodexMetadataPipeline, createCodexNameContextPipeline, createCodexCatalogPipeline };
