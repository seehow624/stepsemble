"use strict";
// Private v2 bytes-only worker protocol. No source pathname crosses this wire.
const path = require("node:path"), crypto = require("node:crypto");
const { canonicalJSON } = require("../../../public/modules/projection");
const { validHistoryValue } = require("../../../public/modules/claude-history");
const { validSdkPath } = require("./history-sdk");
const WIRE_VERSION = 2;
const LIMITS = Object.freeze({ headerBytes: 16 * 1024, sourceBytes: 8 * 1024 * 1024,
  inputBytes: 4 + 16 * 1024 + 8 * 1024 * 1024, outputBytes: 256 * 1024, pageBytes: 256 * 1024,
  inputChunks: 4096, outputChunks: 4096, deadlineMs: 10000, cleanupMs: 1000, pageMessages: 100 });
const sourceCodes = new Set(["invalid_source_input", "source_empty", "source_too_large", "source_line_too_large", "source_too_many_records",
  "source_incomplete_tail", "source_invalid_encoding", "source_blank_record", "source_invalid_json", "source_invalid_json_value",
  "source_scope_mismatch", "source_ancillary_invalid", "source_ancillary_reference_unavailable", "source_worker_failure", "source_worker_protocol",
  "source_sdk_unavailable", "source_selection_failed", "source_observation_rejected", "source_observation_too_large", "source_version_changed"]);
const keys = (v, names) => v !== null && typeof v === "object" && !Array.isArray(v) && Object.keys(v).sort().join(",") === [...names].sort().join(",");
const uuid = v => typeof v === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(v);
const hash = v => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
const decimal = v => typeof v === "string" && /^\d{1,30}$/.test(v);
const u64 = v => typeof v === "string" && /^(0|[1-9]\d{0,19})$/.test(v) && BigInt(v) <= 18446744073709551615n;
const positive = v => Number.isSafeInteger(v) && v > 0;
function detach(value, limit = LIMITS.headerBytes) {
  try { const json = canonicalJSON(value, limit); return json === null ? null : JSON.parse(json); } catch { return null; }
}
function validRequest(v) { return keys(v, ["bindingId", "generation", "requestId"]) && uuid(v.bindingId) && uuid(v.requestId) && positive(v.generation); }
function validPage(v) { return keys(v, ["offset", "limit"]) && Number.isSafeInteger(v.offset) && v.offset >= 0 && v.offset <= 2000 && positive(v.limit) && v.limit <= LIMITS.pageMessages; }
function validIdentity(v) { return keys(v, ["device", "inode", "size", "mtimeNs", "ctimeNs"]) && u64(v.device) && u64(v.inode) && v.inode !== "0"
  && positive(v.size) && v.size <= LIMITS.sourceBytes && decimal(v.mtimeNs) && decimal(v.ctimeNs); }
function validNativeChecks(v) { return keys(v, ["owner", "acl", "containment", "reads", "matchingBytes", "unchangedObservedIdentity"])
  && v.owner === "posix_euid_and_mode" && v.acl === "no_extended_acl" && v.containment === "root_identity_and_openat_nofollow"
  && v.reads === 2 && v.matchingBytes === true && v.unchangedObservedIdentity === true; }
function validNativeSnapshot(v) { return keys(v, ["kind", "sessionId", "byteLength", "sha256", "identity", "checks", "sourceAuthenticated", "publishable"])
  && v.kind === "native_source_bytes" && uuid(v.sessionId) && positive(v.byteLength) && v.byteLength <= LIMITS.sourceBytes && hash(v.sha256)
  && validIdentity(v.identity) && v.identity.size === v.byteLength && validNativeChecks(v.checks) && v.sourceAuthenticated === false && v.publishable === false; }
function sourceVersion(v) { return { sha256: v.sha256, identity: { ...v.identity } }; }
function validSourceVersion(v) { return keys(v, ["sha256", "identity"]) && hash(v.sha256) && validIdentity(v.identity); }
function sameSourceVersion(expected, actual) { return validSourceVersion(expected) && expected.sha256 === actual?.sha256
  && Object.keys(expected.identity).every(k => expected.identity[k] === actual.identity?.[k]); }
function validJob(v) { return keys(v, ["protocolVersion", "nonce", "request", "snapshot", "history"]) && v.protocolVersion === WIRE_VERSION && hash(v.nonce)
  && validRequest(v.request) && validNativeSnapshot(v.snapshot) && keys(v.history, ["sdkPath", "page", "expectedVersion"])
  && validSdkPath(v.history.sdkPath) && validPage(v.history.page) && (v.history.expectedVersion === null || validSourceVersion(v.history.expectedVersion)); }
function validBytes(bytes, snapshot) { return Buffer.isBuffer(bytes) && validNativeSnapshot(snapshot) && bytes.length === snapshot.byteLength
  && crypto.createHash("sha256").update(bytes).digest("hex") === snapshot.sha256; }
function encodeJob(metadata, bytes) {
  const job = detach(metadata); if (!validJob(job) || !validBytes(bytes, job.snapshot)) return null;
  const header = Buffer.from(JSON.stringify(job)); if (header.length > LIMITS.headerBytes) return null;
  const size = Buffer.alloc(4); size.writeUInt32BE(header.length);
  return Buffer.concat([size, header, bytes]);
}
function decodeJSON(bytes, limit) {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.length > limit || bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))) return null;
  try { return detach(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)), limit); } catch { return null; }
}
function readJob(frame) {
  if (!Buffer.isBuffer(frame) || frame.length < 5 || frame.length > LIMITS.inputBytes) return null;
  const size = frame.readUInt32BE(0); if (!size || size > LIMITS.headerBytes || frame.length < 4 + size) return null;
  const job = decodeJSON(frame.subarray(4, 4 + size), LIMITS.headerBytes), bytes = frame.subarray(4 + size);
  return validJob(job) && validBytes(bytes, job.snapshot) ? { job, bytes } : null;
}
function readResponse(bytes, job) {
  if (!validJob(job) || !Buffer.isBuffer(bytes) || bytes.at(-1) !== 10 || bytes.indexOf(10) !== bytes.length - 1) return null;
  const value = decodeJSON(bytes, LIMITS.outputBytes);
  if (!keys(value, ["protocolVersion", "nonce", "request", "result"]) || value.protocolVersion !== WIRE_VERSION || value.nonce !== job.nonce
    || !validRequest(value.request) || Object.keys(job.request).some(k => value.request[k] !== job.request[k])) return null;
  const result = value.result;
  if (keys(result, ["kind", "code"]) && result.kind === "source_unavailable") return sourceCodes.has(result.code) ? result : null;
  if (!validHistoryValue(result, job.snapshot.sessionId, job.history.page) || !validNativeChecks(result.source.checks)
    || !sameSourceVersion(sourceVersion(job.snapshot), result.source) || result.source.byteLength !== job.snapshot.byteLength) return null;
  if (job.history.expectedVersion && !sameSourceVersion(job.history.expectedVersion, result.source))
    return { kind: "source_unavailable", code: "source_version_changed" };
  return result;
}
function encodeResponse(result, job) {
  if (!validJob(job)) return null;
  const encode = result => Buffer.from(JSON.stringify({ protocolVersion: WIRE_VERSION, nonce: job.nonce, request: job.request, result }) + "\n");
  let bytes;
  try { bytes = encode(result); } catch { bytes = encode({ kind: "source_unavailable", code: "source_worker_failure" }); }
  if (bytes.length > LIMITS.outputBytes) bytes = encode({ kind: "source_unavailable", code: "source_observation_too_large" });
  // Unknown codes/shapes can never carry diagnostics or raw source to parent.
  if (!readResponse(bytes, job)) bytes = encode({ kind: "source_unavailable", code: "source_worker_protocol" });
  return bytes;
}
function launchOptions(sdkPath) {
  if (!validSdkPath(sdkPath)) throw new TypeError("invalid_history_sdk_path");
  const worker = path.join(__dirname, "history-bytes-worker.js");
  const grants = [worker, ...["history-bytes-wire.js", "history-source.js", "history-record-scope.js", "history-sdk.js", "history-selection.js", "history-observation.js"].map(v => path.join(__dirname, v)),
    ...["projection.js", "claude-history.js", "claude-history-value.js"].map(v => path.resolve(__dirname, "../../../public/modules", v)),
    sdkPath, path.join(path.dirname(sdkPath), "package.json")];
  return { executable: process.execPath, args: ["--permission", "--no-warnings", "--max-old-space-size=128", ...grants.map(v => `--allow-fs-read=${v}`), worker],
    options: { cwd: __dirname, env: { LANG: "C", LC_ALL: "C" }, stdio: ["pipe", "pipe", "pipe"], windowsHide: true, detached: false, shell: false } };
}
module.exports = { WIRE_VERSION, LIMITS, keys, detach, validRequest, validPage, validIdentity, validNativeChecks, validNativeSnapshot,
  sourceVersion, validSourceVersion, sameSourceVersion, validJob, validBytes, encodeJob, readJob, readResponse, encodeResponse, launchOptions };
