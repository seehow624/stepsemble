"use strict";
// Reserved composite service: one Rust reader, then one bytes-only Node worker.
// No production route, source discovery, native CLI/account, or model invocation.
const path = require("node:path"), crypto = require("node:crypto");
const { spawn } = require("node:child_process"), { performance } = require("node:perf_hooks");
const { normalizeSourceInput } = require("./history-source");
const { createNativeHelper, SOURCE_CODES } = require("./history-native-helper");
const { validSdkPath } = require("./history-sdk");
const { detach, keys, uuid } = require("./history-worker-wire");
const wire = require("./history-bytes-wire");
const LIMITS = Object.freeze({ roots: 256, bindings: 64, workers: 2, deadlineMs: 10000, cleanupMs: 1000 });
const unavailable = code => ({ kind: "source_unavailable", code });
const helperCodes = new Set([...SOURCE_CODES, "source_worker_protocol", "source_worker_exit", "source_worker_timeout",
  "source_worker_spawn_failed", "source_worker_io_error", "source_worker_diagnostic", "source_worker_output_limit",
  "source_worker_input_limit", "source_aborted", "source_cleanup_unconfirmed", "source_service_quarantined", "source_service_closed"]);
const u64 = value => typeof value === "string" && /^(0|[1-9]\d{0,19})$/.test(value) && BigInt(value) <= 18446744073709551615n;
const canonicalPath = value => typeof value === "string" && value.length <= 8192 && path.isAbsolute(value)
  && value === path.resolve(value) && value !== path.parse(value).root && !/[\u0000-\u001f\u007f*?\[\]{},]/.test(value);
const ownOptions = (value, allowed) => value && typeof value === "object" && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value)) && !Object.getOwnPropertySymbols(value).length
  && Object.entries(Object.getOwnPropertyDescriptors(value)).every(([key, descriptor]) => allowed.includes(key) && Object.hasOwn(descriptor, "value"));
function captureValue(value) {
  const fields = ["kind", "sessionId", "byteLength", "sha256", "identity", "checks", "sourceAuthenticated", "publishable", "cleanupConfirmed", "bytes"];
  if (ownOptions(value, ["kind", "code"]) && keys(value, ["kind", "code"])) return wire.detach(value);
  if (!ownOptions(value, fields) || !keys(value, fields)) return null;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (descriptors.cleanupConfirmed.value !== true || !Buffer.isBuffer(descriptors.bytes.value)) return null;
  const snapshot = wire.detach(Object.fromEntries(fields.filter(key => !["bytes", "cleanupConfirmed"].includes(key)).map(key => [key, descriptors[key].value])));
  return snapshot ? { snapshot, bytes: descriptors.bytes.value } : null;
}

function createNativeSourceService(options = {}) {
  if (!ownOptions(options, ["helperPath", "sdkPath", "roots", "createHelper", "spawnChild", "platform", "deadlineMs", "cleanupMs"]))
    throw new TypeError("invalid_native_source_service_options");
  const { helperPath, sdkPath, roots, createHelper = createNativeHelper, spawnChild = spawn, platform = process.platform,
    deadlineMs = LIMITS.deadlineMs, cleanupMs = LIMITS.cleanupMs } = options;
  if (!canonicalPath(helperPath) || helperPath.length > 4096 || !validSdkPath(sdkPath)
    || !Array.isArray(roots) || roots.length > LIMITS.roots || typeof createHelper !== "function" || typeof spawnChild !== "function"
    || ![deadlineMs, cleanupMs].every(n => Number.isSafeInteger(n) && n > 0) || deadlineMs > LIMITS.deadlineMs || cleanupMs > LIMITS.cleanupMs)
    throw new TypeError("invalid_native_source_service_options");
  // Detach the entire table before iteration: an Array's overridden iterator or
  // indexed accessor must not bypass its advertised 256-entry bound.
  const rootTable = detach(roots, LIMITS.roots * 12288);
  if (!Array.isArray(rootTable) || rootTable.length > LIMITS.roots) throw new TypeError("invalid_native_source_roots");
  const grants = new Map();
  for (const input of rootTable) {
    const entry = detach(input);
    if (!keys(entry, ["projectsRoot", "expectedRoot"]) || !canonicalPath(entry.projectsRoot) || grants.has(entry.projectsRoot)
      || !keys(entry.expectedRoot, ["device", "inode"]) || !u64(entry.expectedRoot.device) || !u64(entry.expectedRoot.inode) || entry.expectedRoot.inode === "0")
      throw new TypeError("invalid_native_source_roots");
    grants.set(entry.projectsRoot, Object.freeze({ ...entry.expectedRoot }));
  }
  // Exactly two persistent helpers. Never allocate a replacement around unknown
  // cleanup or an instance's quarantine, even when its read promise has settled.
  const slots = Array.from({ length: LIMITS.workers }, () => ({ helper: createHelper({ executablePath: helperPath,
    trustBoundary: "host_managed_executable", platform, deadlineMs, cleanupMs }), flight: null }));
  if (slots[0].helper === slots[1].helper || slots.some(slot => !slot.helper || !["read", "status", "shutdown"].every(k => typeof slot.helper[k] === "function")))
    throw new TypeError("invalid_native_source_helper");
  const bindings = new Map(), flights = new Set();
  let closed = false, quarantined = false, shutdownPromise = null;
  function quarantine() {
    if (quarantined) return;
    quarantined = true;
    for (const flight of flights) flight.stop("source_service_quarantined");
  }
  function helperClosed(slot) {
    try {
      const status = slot.helper.status();
      if (status.quarantined === true) quarantine();
      return status.activeWorker === false && status.cleanupConfirmed === true;
    } catch { quarantine(); return false; }
  }
  function release(flight) {
    flights.delete(flight);
    if (flight.slot.flight === flight) flight.slot.flight = null;
    if (flight.state.flight === flight) flight.state.flight = null;
  }
  function sweep() {
    for (const flight of flights) {
      if (flight.settled && flight.helperSettled && !flight.childActive && helperClosed(flight.slot)) release(flight);
    }
  }
  function bind(input) {
    sweep();
    if (closed) return unavailable("source_service_closed");
    if (quarantined) return unavailable("source_service_quarantined");
    const value = detach(input), source = normalizeSourceInput(value?.source);
    if (!keys(value, ["bindingId", "generation", "source"]) || !uuid(value.bindingId) || !Number.isSafeInteger(value.generation)
      || value.generation < 1 || !source || !canonicalPath(source.projectsRoot) || !grants.has(source.projectsRoot)) return unavailable("invalid_source_binding");
    Object.freeze(source);
    const previous = bindings.get(value.bindingId);
    if (previous && (!previous.revoked || previous.flight || value.generation <= previous.generation)) return unavailable("source_binding_conflict");
    if (!previous && bindings.size >= LIMITS.bindings) return unavailable("source_binding_limit");
    const state = { generation: value.generation, revoked: false, flight: null, version: null };
    bindings.set(value.bindingId, state);
    const descriptor = Object.freeze({ bindingId: value.bindingId, generation: value.generation, sessionId: source.sessionId });
    const revoke = () => { state.revoked = true; state.version = null; state.flight?.stop("source_binding_revoked"); };
    async function observe(input, options = {}) {
      sweep();
      if (!ownOptions(options, ["page", "version", "signal"])) return unavailable("invalid_history_options");
      const request = detach(input), page = detach(options.page === undefined ? { offset: 0, limit: 100 } : options.page);
      if (!wire.validRequest(request) || request.bindingId !== descriptor.bindingId || request.generation !== descriptor.generation)
        return unavailable("source_binding_mismatch");
      if (!wire.validPage(page)) return unavailable("invalid_history_page");
      const { signal, version: token } = options;
      if (signal !== undefined && !(signal instanceof AbortSignal)) return unavailable("invalid_source_signal");
      if (closed) return unavailable("source_service_closed");
      if (quarantined) return unavailable("source_service_quarantined");
      if (state.revoked || bindings.get(value.bindingId) !== state) return unavailable("source_binding_revoked");
      if (signal?.aborted) return unavailable("source_aborted");
      if (!["darwin", "linux"].includes(platform)) return unavailable("source_platform_unsupported");
      if (token !== undefined && (typeof token !== "string" || !/^[a-f0-9]{64}$/.test(token))) return unavailable("invalid_history_version");
      if (token !== undefined && (!state.version || token !== state.version.token)) return unavailable("source_version_unavailable");
      const version = token === undefined ? null : state.version;
      if (state.flight || flights.size >= LIMITS.workers) return unavailable("source_busy");
      const slot = slots.find(slot => !slot.flight);
      if (!slot || !helperClosed(slot) || quarantined) return unavailable("source_service_quarantined");
      let nonce, nextToken;
      try { nonce = crypto.randomBytes(32).toString("hex"); nextToken = version ? null : crypto.randomBytes(32).toString("hex"); }
      catch { return unavailable("source_worker_failure"); }
      let resolve;
      const promise = new Promise(done => { resolve = done; }), controller = new AbortController();
      const flight = { promise, state, slot, stop, settled: false, helperSettled: false, childActive: false };
      state.flight = flight; slot.flight = flight; flights.add(flight);
      let failure = null, child = null, terminationSent = false, cleanupTimer = null;
      let output = null, outputBytes = 0, chunks = 0;
      const expiresAt = performance.now() + deadlineMs;
      const timer = setTimeout(() => stop("source_worker_timeout"), deadlineMs);
      const abort = () => stop("source_aborted");
      function settle(result) {
        if (flight.settled) return;
        flight.settled = true; output = null;
        clearTimeout(timer); clearTimeout(cleanupTimer); signal?.removeEventListener("abort", abort);
        if (flight.helperSettled && !flight.childActive && helperClosed(slot)) release(flight);
        resolve(result);
      }
      function terminate() {
        if (!child || !failure || !flight.childActive || terminationSent) return;
        terminationSent = true;
        try { child.kill("SIGKILL"); } catch { /* exact child actual close remains the only cleanup evidence */ }
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
        if (closed) stop("source_service_closed");
        else if (state.revoked || bindings.get(value.bindingId) !== state) stop("source_binding_revoked");
        else if (signal?.aborted) stop("source_aborted");
        else if (performance.now() >= expiresAt) stop("source_worker_timeout");
        else if (quarantined) stop("source_service_quarantined");
        return !failure && !flight.settled;
      }
      signal?.addEventListener("abort", abort, { once: true });
      async function run() {
        if (!current()) { flight.helperSettled = true; settle(unavailable(failure)); return; }
        let captured;
        try { captured = await slot.helper.read({ source, expectedRoot: grants.get(source.projectsRoot) }, { signal: controller.signal }); }
        catch { captured = unavailable("source_worker_failure"); }
        flight.helperSettled = true;
        if (!helperClosed(slot)) {
          controller.abort();
          quarantine(); if (!failure) failure = "source_cleanup_unconfirmed";
          settle(unavailable("source_cleanup_unconfirmed")); return;
        }
        if (!current()) { if (!flight.settled) settle(unavailable(failure)); else sweep(); return; }
        const safe = captureValue(captured);
        if (safe?.kind === "source_unavailable") {
          if (safe.code === "source_cleanup_unconfirmed" || safe.code === "source_service_quarantined") quarantine();
          return settle(unavailable(helperCodes.has(safe.code) ? safe.code : "source_worker_failure"));
        }
        if (!safe?.snapshot) return settle(unavailable("source_worker_protocol"));
        const { bytes, snapshot } = safe;
        if (!wire.validNativeSnapshot(snapshot) || snapshot.sessionId !== source.sessionId || snapshot.identity.device !== grants.get(source.projectsRoot).device)
          return settle(unavailable("source_worker_protocol"));
        if (version && !wire.sameSourceVersion(version.source, snapshot)) {
          if (state.version === version) state.version = null;
          return settle(unavailable("source_version_changed"));
        }
        const job = { protocolVersion: wire.WIRE_VERSION, nonce, request, snapshot,
          history: { sdkPath, page, expectedVersion: version?.source ?? null } };
        const encoded = wire.encodeJob(job, bytes);
        if (!encoded) return settle(unavailable("source_worker_protocol"));
        if (!current()) return;
        output = Buffer.alloc(wire.LIMITS.outputBytes);
        const launch = wire.launchOptions(sdkPath);
        // Mark the spawn interval as occupied before trusted dependency callbacks.
        flight.childActive = true;
        try { child = spawnChild(launch.executable, launch.args, launch.options); }
        catch { flight.childActive = false; return settle(unavailable(failure || "source_worker_spawn_failed")); }
        child.once("close", (code, signalName) => {
          flight.childActive = false;
          if (flight.settled) { sweep(); return; }
          if (!current()) { if (!flight.settled) settle(unavailable(failure)); return; }
          if (code !== 0 || signalName) return settle(unavailable("source_worker_exit"));
          let result;
          try { result = wire.readResponse(output.subarray(0, outputBytes), job); } catch { result = null; }
          if (!current()) return;
          if (!result) return settle(unavailable("source_worker_protocol"));
          if (result.kind === "source_unavailable") {
            if (result.code === "source_version_changed" && state.version === version) state.version = null;
            return settle(result);
          }
          // The v2 decoder must preserve the native profile even while the shared
          // provider accepts both legacy and native snapshots elsewhere.
          if (result.source?.checks?.acl !== "no_extended_acl" || result.source?.checks?.containment !== "root_identity_and_openat_nofollow"
            || !wire.sameSourceVersion(wire.sourceVersion(snapshot), result.source)) return settle(unavailable("source_worker_protocol"));
          if (!version) state.version = { token: nextToken, source: wire.sourceVersion(result.source) };
          settle({ kind: "bound_history_observation", ...request, sourceVersion: state.version.token, history: result,
            sourceAuthenticated: false, publishable: false, cleanupConfirmed: true });
        });
        child.on("error", () => stop("source_worker_spawn_failed"));
        for (const stream of [child.stdin, child.stdout, child.stderr]) stream.on("error", () => stop("source_worker_io_error"));
        child.stderr.on("data", () => stop("source_worker_diagnostic"));
        child.stdout.on("data", chunk => {
          if (flight.settled || failure || !flight.childActive) return;
          if (!Buffer.isBuffer(chunk) || chunk.length > wire.LIMITS.outputBytes - outputBytes || ++chunks > wire.LIMITS.outputChunks)
            return stop("source_worker_output_limit");
          chunk.copy(output, outputBytes); outputBytes += chunk.length;
        });
        if (current()) child.stdin.end(encoded);
        terminate();
      }
      run().catch(() => {
        if (flight.childActive || !flight.helperSettled) stop("source_worker_failure");
        else if (!flight.settled) settle(unavailable(failure || "source_worker_failure"));
      });
      return promise;
    }
    const status = () => { sweep(); return Object.freeze({ revoked: state.revoked || bindings.get(value.bindingId) !== state,
      activeWorker: state.flight !== null, cleanupConfirmed: state.flight === null }); };
    return Object.freeze({ kind: "bound_source", descriptor, observe, revoke, status,
      capture: async () => unavailable("reserved_source_capture_unavailable") });
  }
  function shutdown() {
    if (shutdownPromise) return shutdownPromise;
    closed = true;
    for (const state of bindings.values()) { state.revoked = true; state.version = null; state.flight?.stop("source_service_closed"); }
    shutdownPromise = (async () => {
      await Promise.all([...flights].map(flight => flight.promise));
      await Promise.all(slots.map(async slot => { try { await slot.helper.shutdown(); } catch { quarantine(); } }));
      sweep();
      return { kind: "source_service_closed", cleanupConfirmed: flights.size === 0, quarantined };
    })();
    return shutdownPromise;
  }
  return Object.freeze({ bind, shutdown, status: () => { sweep(); return Object.freeze({ closed, quarantined,
    activeWorkers: flights.size, retainedBindings: bindings.size }); } });
}
module.exports = { createNativeSourceService, LIMITS };
