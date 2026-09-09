"use strict";
// Trusted Host pipeline only. Caller owns source grants/binding revocation and
// supplies its shared admission plus an AbortSignal. No discovery or HTTP API.
const path = require("node:path"), crypto = require("node:crypto");
const { spawn } = require("node:child_process"), { performance } = require("node:perf_hooks");
const { createNativeHelper, SOURCE_CODES } = require("../claude/history-native-helper");
const { isReaderAdmission, LIMIT } = require("../claude/history-reader-admission");
const source = require("./source-wire"), wire = require("./parser-wire");
const scanned = require("./scanned-source-wire"), paged = require("./validated-page");
const structuredSource = require("./structured-source-wire");
const compressedSource = require("./compressed-page-source-wire");
const sqlite = require("./sqlite-wire").context;
const unavailable = code => ({ kind: "source_unavailable", code });
const codes = new Set([...SOURCE_CODES, ...wire.CODES, "source_worker_exit", "source_worker_timeout", "source_worker_spawn_failed",
  "source_worker_io_error", "source_worker_diagnostic", "source_worker_input_limit", "source_busy", "source_aborted", "source_cleanup_unconfirmed",
  "source_service_quarantined", "source_service_closed"]);
const own = (v, allowed) => v && typeof v === "object" && [Object.prototype, null].includes(Object.getPrototypeOf(v))
  && !Object.getOwnPropertySymbols(v).length && Object.entries(Object.getOwnPropertyDescriptors(v)).every(([k, d]) => allowed.includes(k) && Object.hasOwn(d, "value"));
function createCodexHistoryPipeline(options = {}) {
  if (!own(options, ["helperPath", "admission", "createHelper", "spawnChild", "platform", "deadlineMs", "cleanupMs"])) throw new TypeError("invalid_codex_pipeline_options");
  const { helperPath, admission, createHelper = createNativeHelper, spawnChild = spawn, platform = process.platform,
    deadlineMs = wire.LIMITS.deadlineMs, cleanupMs = wire.LIMITS.cleanupMs } = options;
  if (typeof helperPath !== "string" || helperPath.length > 4096 || !path.isAbsolute(helperPath) || path.resolve(helperPath) !== helperPath
    || path.parse(helperPath).root === helperPath || /[\u0000-\u001f\u007f]/.test(helperPath) || !isReaderAdmission(admission)
    || typeof createHelper !== "function" || typeof spawnChild !== "function" || ![deadlineMs, cleanupMs].every(v => Number.isSafeInteger(v) && v > 0)
    || deadlineMs > wire.LIMITS.deadlineMs || cleanupMs > wire.LIMITS.cleanupMs) throw new TypeError("invalid_codex_pipeline_options");
  // Allocate helpers once; never replace around unknown physical cleanup.
  const slots = Array.from({ length: LIMIT }, () => ({ flight: null, helper: createHelper({ executablePath: helperPath,
    trustBoundary: "host_managed_executable", platform, deadlineMs, cleanupMs }) }));
  if (new Set(slots.map(v => v.helper)).size !== LIMIT || slots.some(v => !v.helper || ["readCodex", "status", "shutdown"].some(k => typeof v.helper[k] !== "function")))
    throw new TypeError("invalid_codex_pipeline_helper");
  const flights = new Set(); let closed = false, quarantined = false, shutdownPromise = null;
  function quarantine() {
    if (quarantined) return;
    quarantined = true; admission.quarantine();
    for (const f of flights) f.stop("source_service_quarantined");
  }
  function helperClosed(slot) {
    try { const v = slot.helper.status(); if (v.quarantined) quarantine(); return v.activeWorker === false && v.cleanupConfirmed === true; }
    catch { quarantine(); return false; }
  }
  function release(f) { flights.delete(f); if (f.slot.flight === f) f.slot.flight = null; }
  function sweep() {
    if (admission.status().quarantined) quarantine();
    for (const f of flights) if (f.settled && f.helperSettled && !f.childActive && helperClosed(f.slot)) release(f);
  }
  async function read(input, options = {}, named = false, pageMode = false, globalStructure = false) {
    sweep();
    if (!own(options, ["selection", "expectedVersion", "signal", "structured"]) || options.structured !== undefined && typeof options.structured !== "boolean") return unavailable("invalid_codex_pipeline_request");
    const request = wire.detach(input, named ? wire.LIMITS.namedHeaderBytes : wire.LIMITS.headerBytes), selection = wire.detach(options.selection ?? (named ? { mode: "names" } : { mode: "records", offset: 0, limit: 50 }));
    const expected = options.expectedVersion === undefined ? null : wire.detach(options.expectedVersion);
    const expectedHistory = named ? expected?.history ?? null : expected;
    let compressedPage = pageMode && expectedHistory?.storage?.encoding === "zstd";
    let history = compressedPage ? (globalStructure ? compressedSource.structured : compressedSource.validated) : globalStructure ? structuredSource : pageMode ? scanned : source;
    const sameNamedVersion = globalStructure ? wire.sameStructuredNamedVersion : (a, b) => wire.sameNamedVersion(a, b, pageMode);
    if (!(named ? wire.validNameRequest(request) : source.input(request)) || !(pageMode ? paged.selection(selection) : wire.validSelection(selection))
      || options.structured === true && (pageMode || selection.mode !== "records")
      || options.expectedVersion !== undefined && !(named ? sameNamedVersion(expected, expected)
        : history.sameSourceVersion(expected, expected) && (globalStructure || !pageMode || paged.version(expected))))
      return unavailable("invalid_codex_pipeline_request");
    const signal = options.signal;
    if (signal !== undefined && !(signal instanceof AbortSignal)) return unavailable("invalid_source_signal");
    if (closed || admission.status().closed) return unavailable("source_service_closed");
    if (quarantined) return unavailable("source_service_quarantined");
    if (signal?.aborted) return unavailable("source_aborted");
    if (!["darwin", "linux"].includes(platform)) return unavailable("source_platform_unsupported");
    if (flights.size >= LIMIT) return unavailable("source_busy");
    const slot = slots.find(v => !v.flight);
    if (!slot || !helperClosed(slot) || quarantined) return unavailable("source_service_quarantined");
    if (named && typeof slot.helper.readCodexNameContext !== "function") return unavailable("source_worker_protocol");
    const historyRequest = named ? request.history : request;
    let historyMethod = compressedPage ? (globalStructure ? "readCodexCompressedStructuredPage" : "readCodexCompressedPage")
      : globalStructure ? "readCodexStructuredPage" : pageMode ? "readCodexValidatedPage" : "readCodex";
    if (typeof slot.helper[historyMethod] !== "function") return unavailable("source_worker_protocol");
    const captureRequest = pageMode ? { ...historyRequest, page: selection.mode === "names" ? { offset: 0, limit: 1 } : { offset: selection.offset, limit: selection.limit } } : historyRequest;
    let nonce;
    try { nonce = crypto.randomBytes(32).toString("hex"); } catch { return unavailable("source_worker_failure"); }
    let resolve; const promise = new Promise(done => { resolve = done; }), controller = new AbortController();
    const flight = { slot, promise, stop, helperSettled: false, childActive: false, settled: false };
    const permit = admission.acquire(stop, () => flight.helperSettled && !flight.childActive && helperClosed(slot));
    if (permit.kind !== "reader_permit") return permit;
    slot.flight = flight; flights.add(flight);
    let failure = null, child = null, terminationSent = false, cleanupTimer = null, output = null, encoded = null, size = 0, chunks = 0;
    const expires = performance.now() + deadlineMs, timer = setTimeout(() => stop("source_worker_timeout"), deadlineMs);
    const abort = () => stop("source_aborted");
    function settle(result) {
      if (flight.settled) return;
      flight.settled = true; output = null; encoded = null;
      clearTimeout(timer); clearTimeout(cleanupTimer); signal?.removeEventListener("abort", abort);
      if (flight.helperSettled && !flight.childActive && helperClosed(slot)) release(flight);
      permit.finish(); resolve(result);
    }
    function terminate() {
      if (!child || !failure || !flight.childActive || terminationSent) return;
      terminationSent = true;
      try { child.kill("SIGKILL"); } catch { /* only the exact child's close event confirms cleanup */ }
    }
    function stop(code) {
      if (failure || flight.settled) return;
      failure = code; output = null;
      cleanupTimer = setTimeout(() => { quarantine(); settle(unavailable("source_cleanup_unconfirmed")); }, cleanupMs);
      controller.abort(); terminate();
      if (flight.helperSettled && !flight.childActive && helperClosed(slot)) settle(unavailable(failure));
    }
    function current() {
      if (failure || flight.settled) return false;
      if (closed || admission.status().closed) stop("source_service_closed");
      else if (quarantined || admission.status().quarantined) stop("source_service_quarantined");
      else if (signal?.aborted) stop("source_aborted");
      else if (performance.now() >= expires) stop("source_worker_timeout");
      return !failure && !flight.settled;
    }
    signal?.addEventListener("abort", abort, { once: true });
    async function captureStep(method, selected, encodingPolicy = "fail") {
      if (!current()) { flight.helperSettled = true; if (!flight.settled) settle(unavailable(failure)); return null; }
      flight.helperSettled = false;
      let captured;
      try { captured = await slot.helper[method](selected, { signal: controller.signal }); } catch { captured = unavailable("source_worker_failure"); }
      flight.helperSettled = true;
      if (!helperClosed(slot)) {
        if (!failure) failure = "source_cleanup_unconfirmed";
        controller.abort(); quarantine(); settle(unavailable("source_cleanup_unconfirmed")); return null;
      }
      if (!current()) { if (!flight.settled) settle(unavailable(failure)); else sweep(); return null; }
      if (own(captured, ["kind", "code"]) && wire.keys(captured, ["kind", "code"]) && captured.kind === "source_unavailable") {
        // Only a fresh large-page encoding probe may continue, after actual
        // close, on this same permit/deadline. No busy/auth/timeout retry.
        if (captured.code === "source_encoding_unsupported" && encodingPolicy === "negotiate") return captured;
        if (captured.code === "source_encoding_unsupported" && encodingPolicy === "version_changed") {
          settle(unavailable("source_version_changed")); return null;
        }
        if (["source_cleanup_unconfirmed", "source_service_quarantined"].includes(captured.code)) { failure = captured.code; quarantine(); }
        settle(unavailable(codes.has(captured.code) ? captured.code : "source_worker_failure")); return null;
      }
      if (!captured) { settle(unavailable("source_worker_protocol")); return null; }
      return captured;
    }
    function historyVersion(captured) {
      const v = history.sourceVersion(captured), r = historyRequest;
      return v && (globalStructure || !pageMode || paged.version(v)) && captured.cleanupConfirmed === true && v.nativeVersion === r.nativeVersion && v.threadId === r.source.threadId && v.rolloutPath === r.source.rolloutPath
        && v.rootIdentity.device === r.expectedRoot.device && v.rootIdentity.inode === r.expectedRoot.inode ? v : null;
    }
    async function run() {
      let sqlCapture = null, sqlVersion = null;
      if (named) {
        const raw = await captureStep("readCodexNameContext", request.sqlite); if (!raw) return;
        sqlCapture = sqlite.capture(raw, request.sqlite); sqlVersion = sqlCapture && sqlite.sourceVersion(sqlCapture, request.sqlite);
        if (!sqlVersion) return settle(unavailable("source_worker_protocol"));
        if (expected !== null && !sqlite.sameSourceVersion(expected.sqlite, sqlVersion)) return settle(unavailable("source_version_changed"));
      }
      let captured = await captureStep(historyMethod, captureRequest, pageMode ? (expectedHistory !== null ? "version_changed" : "negotiate") : "fail");
      if (!captured) return;
      if (pageMode && captured.kind === "source_unavailable" && captured.code === "source_encoding_unsupported") {
        compressedPage = true; history = globalStructure ? compressedSource.structured : compressedSource.validated;
        historyMethod = globalStructure ? "readCodexCompressedStructuredPage" : "readCodexCompressedPage";
        if (typeof slot.helper[historyMethod] !== "function") return settle(unavailable("source_worker_protocol"));
        captured = await captureStep(historyMethod, captureRequest, "version_changed"); if (!captured) return;
      }
      const version = historyVersion(captured);
      if (!version) return settle(unavailable("source_worker_protocol"));
      if (expectedHistory !== null && !history.sameSourceVersion(expectedHistory, version)) return settle(unavailable("source_version_changed"));
      const job = { protocolVersion: compressedPage ? (globalStructure ? (named ? 14 : 13) : (named ? 12 : 11))
        : globalStructure ? (named ? 10 : 9) : pageMode ? (named ? 8 : 7) : options.structured === true ? (named ? 6 : 5) : (named ? 2 : 1) + (version.storage ? 2 : 0), nonce, source: version, selection, expectedVersion: expectedHistory,
        ...(pageMode ? { page: captured.page } : {}),
        ...(globalStructure ? { structureFrame: captured.structureFrame } : {}),
        ...(named ? { nameResolution: { fields: sqlCapture.metadata.observation.fields, nameContext: sqlCapture.metadata.observation.nameContext,
          method: request.method, rolloutPath: path.join(historyRequest.source.codexRoot, historyRequest.source.rolloutPath) } } : {}) };
      sqlCapture = null;
      encoded = wire.encodeJob(job, captured); captured = null;
      if (!encoded) return settle(unavailable("source_worker_protocol"));
      if (!current()) return;
      output = Buffer.allocUnsafe(wire.LIMITS.outputBytes);
      const launch = wire.launchOptions(); flight.childActive = true;
      try {
        child = spawnChild(launch.executable, launch.args, launch.options);
        child.once("close", (code, signalName) => {
          flight.childActive = false;
          if (flight.settled) { sweep(); return; }
          if (!current()) { if (!flight.settled) settle(unavailable(failure)); return; }
          if (code !== 0 || signalName) return settle(unavailable("source_worker_exit"));
          let result;
          try { result = wire.readResponse(output.subarray(0, size), job, encoded.subarray(4 + encoded.readUInt32BE(0))); } catch { result = null; }
          if (!current()) return;
          if (!result) return settle(unavailable("source_worker_protocol"));
          if (!named || result.kind === "source_unavailable") return settle(result.kind === "source_unavailable" ? result : { ...result, cleanupConfirmed: true });
          // Release large parser buffers before the two final captures. A
          // single permit spans every stage; none reacquires or queues work.
          output = null; encoded = null;
          finishNamed(result, version, sqlVersion).catch(() => {
            if (!flight.helperSettled) stop("source_worker_failure");
            else if (!flight.settled) settle(unavailable(failure || "source_worker_failure"));
          });
        });
        child.on("error", () => stop("source_worker_spawn_failed"));
        for (const stream of [child.stdin, child.stdout, child.stderr]) stream.on("error", () => stop("source_worker_io_error"));
        child.stderr.on("data", () => stop("source_worker_diagnostic"));
        child.stdout.on("data", chunk => {
          if (flight.settled || failure || !flight.childActive) return;
          if (!Buffer.isBuffer(chunk) || ++chunks > wire.LIMITS.chunks || chunk.length > wire.LIMITS.outputBytes - size) return stop("source_worker_output_limit");
          chunk.copy(output, size); size += chunk.length;
        });
        if (current()) child.stdin.end(encoded);
        terminate();
      } catch {
        if (child) stop("source_worker_spawn_failed");
        else { flight.childActive = false; settle(unavailable(failure || "source_worker_spawn_failed")); }
      }
    }
    async function finishNamed(parsed, initialHistory, initialSqlite) {
      let captured = await captureStep("readCodexNameContext", request.sqlite); if (!captured) return;
      const finalSqlite = sqlite.sourceVersion(captured, request.sqlite); captured = null;
      if (!finalSqlite) return settle(unavailable("source_worker_protocol"));
      if (!sqlite.sameSourceVersion(initialSqlite, finalSqlite)) return settle(unavailable("source_version_changed"));
      captured = await captureStep(historyMethod, captureRequest, pageMode ? "version_changed" : "fail"); if (!captured) return;
      const finalHistory = historyVersion(captured); captured = null;
      if (!finalHistory) return settle(unavailable("source_worker_protocol"));
      if (!history.sameSourceVersion(initialHistory, finalHistory)) return settle(unavailable("source_version_changed"));
      if (!current()) return;
      settle({ ...parsed, kind: globalStructure ? "codex_named_structured_page_capture" : pageMode ? "codex_named_page_capture" : "codex_named_capture", source: { kind: globalStructure ? "codex_named_structured_page_source_version" : pageMode ? "codex_named_page_source_version" : "codex_named_source_version", history: finalHistory, sqlite: finalSqlite },
        consistency: "matching_selected_versions_before_and_after_parse", cleanupConfirmed: true });
    }
    run().catch(() => {
      if (flight.childActive || !flight.helperSettled) stop("source_worker_failure");
      else if (!flight.settled) settle(unavailable(failure || "source_worker_failure"));
    });
    return promise;
  }
  function shutdown() {
    if (shutdownPromise) return shutdownPromise;
    closed = true; for (const f of flights) f.stop("source_service_closed");
    shutdownPromise = (async () => {
      await Promise.all([...flights].map(v => v.promise));
      await Promise.all(slots.map(async v => { try { await v.helper.shutdown(); } catch { quarantine(); } }));
      sweep(); return { kind: "codex_pipeline_closed", cleanupConfirmed: flights.size === 0, quarantined };
    })();
    return shutdownPromise;
  }
  return Object.freeze({ read: (input, options) => read(input, options), readNamed: (input, options) => read(input, options, true),
    readPage: (input, options) => read(input, options, false, true), readNamedPage: (input, options) => read(input, options, true, true),
    readStructuredPage: (input, options) => read(input, options, false, true, true), readNamedStructuredPage: (input, options) => read(input, options, true, true, true),
    shutdown, status() { sweep(); return Object.freeze({ closed: closed || admission.status().closed, quarantined,
    activeWorkers: flights.size, cleanupConfirmed: flights.size === 0 }); } });
}
module.exports = { createCodexHistoryPipeline };
