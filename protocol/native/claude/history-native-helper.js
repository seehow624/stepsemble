"use strict";
// Reserved owned-child runner, used by the synthetic native composite service.
// No production route, private history, native account, UI or model invocation.
const path = require("node:path"), crypto = require("node:crypto");
const { spawn } = require("node:child_process"), { performance } = require("node:perf_hooks");
const { normalizeSourceInput } = require("./history-source");
const { canonicalJSON } = require("../../../public/modules/projection");
const inventoryWire = require("./history-inventory-wire");
const codexWire = require("../codex/source-wire");
const sqliteWire = require("../codex/sqlite-wire");
const LIMITS = Object.freeze({ inputBytes: 12 * 1024, headerBytes: 16 * 1024, sourceBytes: 8 * 1024 * 1024,
  outputBytes: 4 + 16 * 1024 + 8 * 1024 * 1024, outputChunks: 4096, deadlineMs: 10000, cleanupMs: 1000 });
const SOURCE_CODES = Object.freeze(["invalid_source_input", "source_platform_unsupported", "source_missing", "source_empty", "source_too_large",
  "source_line_too_large", "source_too_many_records", "source_incomplete_tail", "source_invalid_encoding", "source_blank_record",
  "source_invalid_json", "source_invalid_json_value", "source_scope_mismatch", "source_ancillary_invalid", "source_ancillary_reference_unavailable",
  "source_not_regular_or_linked", "source_owner_or_mode", "source_identity_unavailable", "source_hardlinked", "source_changed",
  "source_access_denied", "source_io_error", "source_read_budget", "source_close_failed", "source_worker_failure",
  "source_sdk_unavailable", "source_selection_failed", "source_observation_rejected", "source_observation_too_large", "source_version_changed",
  "source_acl_unavailable", "source_acl_unsupported", "source_root_identity_changed", "source_containment_unavailable", "source_inventory_limit", "source_encoding_unsupported",
  "source_database_unsupported", "source_database_unavailable", "source_busy", "source_cancelled"]);
const sourceCodes = new Set(SOURCE_CODES), unavailable = code => ({ kind: "source_unavailable", code });
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const keys = (value, names) => object(value) && Object.keys(value).sort().join(",") === [...names].sort().join(",");
const decimal = value => typeof value === "string" && /^\d{1,30}$/.test(value);
const u64 = value => typeof value === "string" && /^(0|[1-9]\d{0,19})$/.test(value) && BigInt(value) <= 18446744073709551615n;
const rootIdentity = value => keys(value, ["device", "inode"]) && u64(value.device) && u64(value.inode) && value.inode !== "0";
function detach(value, limit) {
  try { const json = canonicalJSON(value, limit); return json === null ? null : JSON.parse(json); } catch { return null; }
}
function decode(bytes, job) {
  if (bytes.length < 5) return null;
  const size = bytes.readUInt32BE(0);
  if (!size || size > LIMITS.headerBytes || bytes.length < 4 + size) return null;
  const header = bytes.subarray(4, 4 + size);
  if (header[0] === 0xef && header[1] === 0xbb && header[2] === 0xbf) return null;
  let value;
  try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(header)); } catch { return null; }
  if (canonicalJSON(value, LIMITS.headerBytes) === null || !keys(value, ["protocolVersion", "nonce", "result"])
    || value.protocolVersion !== job.protocolVersion || value.nonce !== job.nonce) return null;
  const result = value.result, payload = bytes.subarray(4 + size);
  if (keys(result, ["kind", "code"]) && result.kind === "source_unavailable")
    return sourceCodes.has(result.code) && payload.length === 0 ? result : null;
  if (job.protocolVersion === 2) return inventoryWire.decode(result, payload, job);
  if (job.protocolVersion === 3) return codexWire.decode(result, payload, job);
  if (job.protocolVersion === 4) return sqliteWire.decode(result, payload, job);
  if (!keys(result, ["kind", "sessionId", "byteLength", "sha256", "identity", "checks", "sourceAuthenticated", "publishable"])
    || result.kind !== "native_source_bytes" || result.sessionId !== job.source.sessionId || result.sourceAuthenticated !== false || result.publishable !== false
    || !Number.isSafeInteger(result.byteLength) || result.byteLength < 1 || result.byteLength > LIMITS.sourceBytes || result.byteLength !== payload.length
    || typeof result.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(result.sha256)
    || !keys(result.identity, ["device", "inode", "size", "mtimeNs", "ctimeNs"])
    || !["device", "inode", "mtimeNs", "ctimeNs"].every(k => decimal(result.identity[k])) || !/[1-9]/.test(result.identity.inode)
    || !u64(result.identity.device) || !u64(result.identity.inode) || result.identity.device !== job.expectedRoot.device
    || result.identity.size !== result.byteLength
    || !keys(result.checks, ["owner", "acl", "containment", "reads", "matchingBytes", "unchangedObservedIdentity"])
    || result.checks.owner !== "posix_euid_and_mode" || result.checks.acl !== "no_extended_acl"
    || result.checks.containment !== "root_identity_and_openat_nofollow" || result.checks.reads !== 2
    || result.checks.matchingBytes !== true || result.checks.unchangedObservedIdentity !== true
    || crypto.createHash("sha256").update(payload).digest("hex") !== result.sha256) return null;
  // Return owned bytes only after the exact one-frame shape and digest checks.
  // This is still structural consistency evidence, never native authenticity.
  return { ...result, bytes: Buffer.from(payload), cleanupConfirmed: true };
}

/** executablePath and every read's source/expectedRoot are trusted Host input,
 * never HTTP fields. expectedRoot is the already-authorized opened-root identity.
 * trustBoundary is an explicit caller acknowledgement, NOT a security proof:
 * the helper executable and its loader/dependencies must remain Host-managed
 * and protected before AND during launch. There is deliberately no pre-exec
 * path hash presented as a solution to executable path replacement/TOCTOU.
 * Timing/spawn overrides are for trusted tests. No caller args, env or shell.
 */
function createNativeHelper(options = {}) {
  const allowed = ["executablePath", "trustBoundary", "spawnChild", "platform", "deadlineMs", "cleanupMs"];
  if (!object(options) || ![Object.prototype, null].includes(Object.getPrototypeOf(options))
    || Object.getOwnPropertySymbols(options).length || Object.keys(options).some(k => !allowed.includes(k))
    || Object.values(Object.getOwnPropertyDescriptors(options)).some(d => !Object.hasOwn(d, "value"))) throw new TypeError("invalid_native_helper_options");
  const { executablePath, trustBoundary, spawnChild = spawn, platform = process.platform,
    deadlineMs = LIMITS.deadlineMs, cleanupMs = LIMITS.cleanupMs } = options;
  if (typeof executablePath !== "string" || executablePath.length > 4096 || !path.isAbsolute(executablePath) || path.resolve(executablePath) !== executablePath
    || path.parse(executablePath).root === executablePath || /[\u0000-\u001f\u007f]/.test(executablePath)
    || trustBoundary !== "host_managed_executable" || typeof spawnChild !== "function"
    || ![deadlineMs, cleanupMs].every(v => Number.isSafeInteger(v) && v > 0) || deadlineMs > LIMITS.deadlineMs || cleanupMs > LIMITS.cleanupMs)
    throw new TypeError("invalid_native_helper_options");
  let active = null, closed = false, quarantined = false;
  async function run(input, options = {}, version = 1) {
    if (!object(options) || ![Object.prototype, null].includes(Object.getPrototypeOf(options)) || Object.getOwnPropertySymbols(options).length
      || Object.entries(Object.getOwnPropertyDescriptors(options)).some(([key, d]) => key !== "signal" || !Object.hasOwn(d, "value")))
      return unavailable("invalid_source_signal");
    const signal = options.signal;
    if (signal !== undefined && !(signal instanceof AbortSignal)) return unavailable("invalid_source_signal");
    const value = detach(input, LIMITS.inputBytes), source = version === 1 ? normalizeSourceInput(value?.source) : value?.source;
    if (version === 4 ? !sqliteWire.input(value) : version === 3 ? !codexWire.input(value) : version === 2 ? !inventoryWire.input(value) : !keys(value, ["source", "expectedRoot"]) || !source || !rootIdentity(value.expectedRoot)
      || source.projectsRoot === path.parse(source.projectsRoot).root || source.projectsRoot !== path.resolve(source.projectsRoot)
      || /[*?\[\]{},\r\n]/.test(source.projectsRoot)) return unavailable("invalid_source_input");
    if (closed) return unavailable("source_service_closed");
    if (quarantined) return unavailable("source_service_quarantined");
    if (signal?.aborted) return unavailable("source_aborted");
    if (!["darwin", "linux"].includes(platform)) return unavailable("source_platform_unsupported");
    if (active) return unavailable("source_busy");
    const outputLimit = version === 4 ? sqliteWire.LIMITS.outputBytes : version === 3 ? codexWire.LIMITS.outputBytes : version === 2 ? 4 + LIMITS.headerBytes + inventoryWire.LIMITS.bytes : LIMITS.outputBytes;
    let job, inputLine, output;
    try {
      job = { protocolVersion: version, nonce: crypto.randomBytes(32).toString("hex"),
        ...(version === 2 ? { projectsRoot: value.projectsRoot } : { source }), expectedRoot: value.expectedRoot,
        ...(version === 3 || version === 4 ? { nativeVersion: value.nativeVersion } : {}) };
      inputLine = JSON.stringify(job) + "\n";
      if (Buffer.byteLength(inputLine) > LIMITS.inputBytes) return unavailable("source_worker_input_limit");
      output = Buffer.allocUnsafe(outputLimit);
    } catch { return unavailable("source_worker_failure"); }
    let resolve; const promise = new Promise(done => { resolve = done; });
    let child = null, failure = null, settled = false, exited = false, cleanupTimer = null, terminationSent = false, length = 0, chunks = 0;
    const flight = { promise, stop }; active = flight;
    const abort = () => stop("source_aborted"), expiresAt = performance.now() + deadlineMs;
    const timer = setTimeout(() => stop("source_worker_timeout"), deadlineMs);
    function settle(result) {
      if (settled) return; settled = true; clearTimeout(timer); clearTimeout(cleanupTimer);
      signal?.removeEventListener("abort", abort); output = null; resolve(result);
    }
    function release() { exited = true; if (active === flight) active = null; }
    function terminate() {
      if (!child || !failure || terminationSent || exited) return;
      terminationSent = true;
      try { child.kill("SIGKILL"); } catch { /* actual close, not kill's return value, confirms cleanup */ }
    }
    function stop(code) {
      if (failure || settled || exited) return;
      failure = code; output = null;
      cleanupTimer = setTimeout(() => { quarantined = true; settle(unavailable("source_cleanup_unconfirmed")); }, cleanupMs);
      terminate();
    }
    signal?.addEventListener("abort", abort, { once: true });
    try {
      child = spawnChild(executablePath, [], { cwd: path.dirname(executablePath), env: { LANG: "C", LC_ALL: "C" },
        stdio: ["pipe", "pipe", "pipe"], shell: false, detached: false, windowsHide: true });
      // Attach close first: setup errors must still observe this exact child's
      // cleanup. An exit event alone never frees the instance or publishes.
      child.once("close", (code, signalName) => {
        release(); if (settled) return;
        if (failure) return settle(unavailable(failure));
        if (closed) return settle(unavailable("source_service_closed"));
        if (signal?.aborted) return settle(unavailable("source_aborted"));
        if (code !== 0 || signalName) return settle(unavailable("source_worker_exit"));
        if (performance.now() >= expiresAt) return settle(unavailable("source_worker_timeout"));
        let result;
        try { result = decode(output.subarray(0, length), job); } catch { result = null; }
        if (performance.now() >= expiresAt) return settle(unavailable("source_worker_timeout"));
        settle(result ?? unavailable("source_worker_protocol"));
      });
      child.on("error", () => stop("source_worker_spawn_failed"));
      for (const stream of [child.stdin, child.stdout, child.stderr]) stream.on("error", () => stop("source_worker_io_error"));
      child.stderr.on("data", () => stop("source_worker_diagnostic")); // Never buffer, log or return diagnostic bytes.
      child.stdout.on("data", chunk => {
        if (settled || failure || exited) return;
        if (!Buffer.isBuffer(chunk) || chunk.length > outputLimit - length || ++chunks > LIMITS.outputChunks)
          return stop("source_worker_output_limit");
        chunk.copy(output, length); length += chunk.length;
        if (length >= 4 && (!output.readUInt32BE(0) || output.readUInt32BE(0) > LIMITS.headerBytes)) stop("source_worker_protocol");
      });
      child.stdin.end(inputLine);
      // A trusted spawn hook can synchronously abort/shutdown before returning.
      if (signal?.aborted) stop("source_aborted"); if (closed) stop("source_service_closed"); terminate();
    } catch {
      if (child) stop("source_worker_spawn_failed");
      else { release(); settle(unavailable("source_worker_spawn_failed")); }
    }
    return promise;
  }
  async function shutdown() {
    closed = true; active?.stop("source_service_closed");
    if (active) await active.promise;
    return { kind: "source_helper_closed", cleanupConfirmed: active === null, quarantined };
  }
  return Object.freeze({ read: (input, options) => run(input, options), inventory: (input, options) => run(input, options, 2), readCodex: (input, options) => run(input, options, 3),
    readCodexMetadata: (input, options) => run(input, options, 4),
    shutdown, status: () => Object.freeze({ closed, quarantined, activeWorker: active !== null, cleanupConfirmed: active === null }) });
}
module.exports = { createNativeHelper, LIMITS, SOURCE_CODES };
