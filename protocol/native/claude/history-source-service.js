"use strict";
// Reserved Host reference. bind() is TRUSTED registration, never a request API.
// Opaque handles fence request scope; they do NOT authenticate native origins.
const path = require("node:path"), crypto = require("node:crypto");
const { spawn } = require("node:child_process");
const { performance } = require("node:perf_hooks");
const { normalizeSourceInput } = require("./history-source");
const { WIRE_VERSION, LIMITS, uuid, keys, detach, validRequest, validPage, readResponse } = require("./history-worker-wire");
const { validSdkPath } = require("./history-sdk");
const unavailable = code => ({ kind: "source_unavailable", code });
const worker = path.join(__dirname, "history-source-worker.js");
function environment() {
  const result = { PATH: path.dirname(process.execPath) };
  for (const name of ["SystemRoot", "SYSTEMROOT", "WINDIR", "LANG", "LC_ALL"])
    if (process.env[name]) result[name] = process.env[name];
  return result; // No HOME, credentials, NODE_OPTIONS, loader paths or provider routing.
}
function launchOptions(source, sdkPath) {
  // Node grants a directory's descendants too. This is the registered projects
  // root, NOT an OS sandbox or descriptor-relative single-file capability.
  const grants = [source.projectsRoot, worker, path.join(__dirname, "history-source.js"),
    path.join(__dirname, "history-record-scope.js"), path.join(__dirname, "history-worker-wire.js"),
    path.join(__dirname, "history-sdk.js"), path.join(__dirname, "history-observation-value.js"),
    path.resolve(__dirname, "../../../public/modules/projection.js")];
  if (sdkPath) grants.push(sdkPath, path.join(path.dirname(sdkPath), "package.json"),
    path.join(__dirname, "history-selection.js"), path.join(__dirname, "history-observation.js"));
  return { executable: process.execPath,
    args: ["--permission", "--no-warnings", "--max-old-space-size=128", ...grants.map(value => `--allow-fs-read=${value}`), worker],
    options: { cwd: __dirname, env: environment(), stdio: ["pipe", "pipe", "pipe"], windowsHide: true, detached: false, shell: false } };
}
/** Dependencies/timing overrides belong to trusted tests, never request data.
 * Use ONE shared service per Host. No pending queue or auto-retry. A retained
 * binding-id tombstone enforces increasing generations, within a fixed cap.
 */
function createSourceService({ spawnChild = spawn, platform = process.platform,
  deadlineMs = LIMITS.deadlineMs, cleanupMs = LIMITS.cleanupMs, sdkPath } = {}) {
  if (sdkPath !== undefined && !validSdkPath(sdkPath)) throw new TypeError("invalid_history_sdk_path");
  if (![deadlineMs, cleanupMs].every(value => Number.isSafeInteger(value) && value > 0)
    || deadlineMs > LIMITS.deadlineMs || cleanupMs > LIMITS.cleanupMs) throw new TypeError("invalid_source_service_limits");
  const bindings = new Map(), flights = new Set(); let closed = false, quarantined = false;
  function bind(input) {
    if (closed) return unavailable("source_service_closed");
    if (quarantined) return unavailable("source_service_quarantined");
    const value = detach(input);
    if (!keys(value, ["bindingId", "generation", "source"]) || !uuid(value.bindingId)
      || !Number.isSafeInteger(value.generation) || value.generation < 1) return unavailable("invalid_source_binding");
    const source = normalizeSourceInput(value.source);
    // No broad root or permission wildcard expansion. Host must supply an
    // already-authorized canonical root, not ask this service to discover one.
    if (!source || source.projectsRoot === path.parse(source.projectsRoot).root
      || source.projectsRoot !== path.resolve(source.projectsRoot) || /[*?\[\]{},\r\n]/.test(source.projectsRoot)) return unavailable("invalid_source_binding");
    const previous = bindings.get(value.bindingId);
    if (previous && (!previous.revoked || previous.flight || value.generation <= previous.generation)) return unavailable("source_binding_conflict");
    if (!previous && bindings.size >= LIMITS.bindings) return unavailable("source_binding_limit");
    const state = { generation: value.generation, revoked: false, flight: null };
    bindings.set(value.bindingId, state);
    const descriptor = Object.freeze({ bindingId: value.bindingId, generation: value.generation, sessionId: source.sessionId });
    function revoke() {
      state.revoked = true; state.flight?.stop("source_binding_revoked");
    }
    async function capture(input, { signal } = {}, page = null) {
      const request = detach(input);
      if (!validRequest(request) || request.bindingId !== descriptor.bindingId || request.generation !== descriptor.generation)
        return unavailable("source_binding_mismatch");
      if (closed) return unavailable("source_service_closed");
      if (quarantined) return unavailable("source_service_quarantined");
      if (state.revoked || bindings.get(value.bindingId) !== state) return unavailable("source_binding_revoked");
      if (signal !== undefined && !(signal instanceof AbortSignal)) return unavailable("invalid_source_signal");
      if (signal?.aborted) return unavailable("source_aborted");
      if (!["darwin", "linux"].includes(platform)) return unavailable("source_platform_unsupported");
      if (state.flight || flights.size >= LIMITS.workers) return unavailable("source_busy");
      const job = { protocolVersion: WIRE_VERSION, nonce: crypto.randomBytes(32).toString("hex"), request, source };
      if (page) job.history = { sdkPath, page };
      const inputLine = JSON.stringify(job) + "\n";
      if (Buffer.byteLength(inputLine) > LIMITS.inputBytes) return unavailable("source_worker_input_limit");
      const outputLimit = page ? LIMITS.pageBytes : LIMITS.outputBytes;
      let resolve;
      const promise = new Promise(done => { resolve = done; });
      let child = null, failure = null, settled = false, exited = false, cleanupTimer = null, terminationSent = false;
      let outputBytes = 0; const chunks = [];
      const flight = { promise, stop }; state.flight = flight; flights.add(flight);
      const abort = () => stop("source_aborted");
      const expiresAt = performance.now() + deadlineMs;
      const timer = setTimeout(() => stop("source_worker_timeout"), deadlineMs);
      function settle(result) {
        if (settled) return; settled = true;
        clearTimeout(timer); clearTimeout(cleanupTimer); signal?.removeEventListener("abort", abort);
        chunks.length = 0; resolve(result);
      }
      function release() {
        exited = true; flights.delete(flight);
        if (state.flight === flight) state.flight = null;
      }
      function stop(code) {
        if (failure || settled || exited) return;
        failure = code; chunks.length = 0;
        cleanupTimer = setTimeout(() => {
          quarantined = true;
          settle(unavailable("source_cleanup_unconfirmed"));
          // Slot remains occupied until actual close; never reopen around it.
        }, cleanupMs);
        // Only this fresh ChildProcess object, once. Never a stored PID, shell,
        // process group, production service, task tree or native agent.
        terminateOwnedChild();
      }
      function terminateOwnedChild() {
        if (!child || !failure || terminationSent || exited) return;
        terminationSent = true;
        try { child.kill("SIGKILL"); } catch { /* uncertain cleanup remains fenced */ }
      }
      signal?.addEventListener("abort", abort, { once: true });
      try {
        const launch = launchOptions(source, page ? sdkPath : undefined);
        child = spawnChild(launch.executable, launch.args, launch.options);
        child.on("error", () => stop("source_worker_spawn_failed")); // Also absorb repeated/late child errors safely.
        child.stdin.on("error", () => stop("source_worker_io_error"));
        child.stdout.on("error", () => stop("source_worker_io_error"));
        child.stderr.on("error", () => stop("source_worker_io_error"));
        child.stderr.on("data", () => stop("source_worker_diagnostic")); // No raw diagnostics cross the boundary.
        child.stdout.on("data", chunk => {
          if (settled || failure) return;
          if (!Buffer.isBuffer(chunk) || (outputBytes += chunk.length) > outputLimit
            || chunks.length >= LIMITS.outputChunks) return stop("source_worker_output_limit");
          chunks.push(chunk);
        });
        child.once("close", (code, signalName) => {
          release();
          if (settled) return; // A late close frees the slot, never publishes late data or unquarantines.
          if (failure) return settle(unavailable(failure));
          if (state.revoked || bindings.get(value.bindingId) !== state) return settle(unavailable("source_binding_revoked"));
          if (signal?.aborted) return settle(unavailable("source_aborted"));
          if (code !== 0 || signalName) return settle(unavailable("source_worker_exit"));
          if (performance.now() >= expiresAt) return settle(unavailable("source_worker_timeout"));
          const result = readResponse(Buffer.concat(chunks), job);
          if (performance.now() >= expiresAt) return settle(unavailable("source_worker_timeout"));
          if (!result) return settle(unavailable("source_worker_protocol"));
          if (result.kind === "source_unavailable") return settle(result);
          if (page) return settle({ kind: "bound_history_observation", ...request, history: result,
            sourceAuthenticated: false, publishable: false, cleanupConfirmed: true });
          settle({ kind: "bound_source_snapshot", ...request, snapshot: result,
            sourceAuthenticated: false, publishable: false, cleanupConfirmed: true });
        });
        child.stdin.end(inputLine);
        // A trusted spawn hook can synchronously revoke/abort during creation.
        if (signal?.aborted) stop("source_aborted");
        if (state.revoked) stop("source_binding_revoked");
        terminateOwnedChild();
      } catch {
        if (child) stop("source_worker_spawn_failed");
        else { release(); settle(unavailable("source_worker_spawn_failed")); }
      }
      return promise;
    }
    async function observe(input, options = {}) {
      if (!options || typeof options !== "object" || Array.isArray(options)
        || ![Object.prototype, null].includes(Object.getPrototypeOf(options)) || Object.getOwnPropertySymbols(options).length > 0
        || Object.entries(Object.getOwnPropertyDescriptors(options)).some(([key, d]) => !["page", "signal"].includes(key) || !Object.hasOwn(d, "value")))
        return unavailable("invalid_history_options");
      const page = detach(options.page === undefined ? { offset: 0, limit: 100 } : options.page);
      if (!validPage(page)) return unavailable("invalid_history_page");
      if (!sdkPath) return unavailable("source_sdk_unavailable");
      return capture(input, { signal: options.signal }, page);
    }
    // Do not expose the internal third argument or let capture select SDK mode.
    return Object.freeze({ kind: "bound_source", descriptor, capture: (input, options) => capture(input, options), observe, revoke });
  }
  async function shutdown() {
    closed = true;
    for (const state of bindings.values()) { state.revoked = true; state.flight?.stop("source_service_closed"); }
    await Promise.all([...flights].map(flight => flight.promise));
    return { kind: "source_service_closed", cleanupConfirmed: flights.size === 0, quarantined };
  }
  return Object.freeze({ bind, shutdown, status: () => ({ closed, quarantined, activeWorkers: flights.size, retainedBindings: bindings.size }) });
}
module.exports = { createSourceService, LIMITS };
