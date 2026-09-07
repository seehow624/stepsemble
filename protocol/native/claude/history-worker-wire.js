"use strict";
// Private worker wire, not Stepsemble Protocol or a browser API.
const { canonicalJSON } = require("../../../public/modules/projection");
const { normalizeSourceInput, LIMITS: SOURCE } = require("./history-source");
const { classifyRecordScopes } = require("./history-record-scope");
const WIRE_VERSION = 1;
const LIMITS = Object.freeze({ inputBytes: 12288, outputBytes: 10 * 1024 * 1024, outputChunks: 4096,
  bindings: 64, workers: 2, deadlineMs: 10000, cleanupMs: 1000 });
const uuid = value => typeof value === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const keys = (value, list) => object(value) && Object.keys(value).sort().join(",") === [...list].sort().join(",");
const decimal = value => typeof value === "string" && /^\d{1,30}$/.test(value);
const sourceCodes = new Set(["invalid_source_input", "source_platform_unsupported", "source_missing", "source_empty", "source_too_large",
  "source_line_too_large", "source_too_many_records", "source_incomplete_tail", "source_invalid_encoding", "source_blank_record",
  "source_invalid_json", "source_invalid_json_value", "source_scope_mismatch", "source_ancillary_invalid", "source_ancillary_reference_unavailable",
  "source_not_regular_or_linked", "source_owner_or_mode", "source_identity_unavailable", "source_hardlinked", "source_changed",
  "source_access_denied", "source_io_error", "source_read_budget", "source_close_failed", "source_worker_failure"]);
function detach(value, limit = LIMITS.inputBytes) {
  const json = canonicalJSON(value, limit); return json === null ? null : JSON.parse(json);
}
function validRequest(value) {
  return keys(value, ["bindingId", "generation", "requestId"]) && uuid(value.bindingId) && uuid(value.requestId)
    && Number.isSafeInteger(value.generation) && value.generation > 0;
}
function decode(bytes, limit) {
  if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > limit || bytes.at(-1) !== 10
    || bytes.indexOf(10) !== bytes.length - 1 || bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))) return null;
  try { return detach(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)), limit); }
  catch { return null; }
}
function validJob(value) {
  return keys(value, ["protocolVersion", "nonce", "request", "source"]) && value.protocolVersion === WIRE_VERSION
    && typeof value.nonce === "string" && /^[a-f0-9]{64}$/.test(value.nonce)
    && validRequest(value.request) && normalizeSourceInput(value.source) !== null;
}
function validSnapshot(value, sessionId) {
  return keys(value, ["kind", "sessionId", "records", "byteLength", "sha256", "identity", "checks", "sourceAuthenticated", "publishable"])
    && value.kind === "source_snapshot" && value.sessionId === sessionId && value.sourceAuthenticated === false && value.publishable === false
    && Array.isArray(value.records) && value.records.length > 0 && value.records.length <= SOURCE.records
    && Number.isSafeInteger(value.byteLength) && value.byteLength > 0 && value.byteLength <= SOURCE.bytes
    && typeof value.sha256 === "string" && /^[a-f0-9]{64}$/.test(value.sha256)
    && keys(value.identity, ["device", "inode", "size", "mtimeNs", "ctimeNs"])
    && ["device", "inode", "mtimeNs", "ctimeNs"].every(key => decimal(value.identity[key]))
    && value.identity.inode !== "0" && value.identity.size === value.byteLength
    && keys(value.checks, ["owner", "reads", "matchingBytes", "unchangedObservedIdentity"])
    && value.checks.owner === "posix_euid_and_mode" && value.checks.reads === 2
    && value.checks.matchingBytes === true && value.checks.unchangedObservedIdentity === true
    && classifyRecordScopes(value.records, sessionId).kind === "record_scopes";
}
function readResponse(bytes, job) {
  const value = decode(bytes, LIMITS.outputBytes);
  if (!keys(value, ["protocolVersion", "nonce", "request", "result"]) || value.protocolVersion !== WIRE_VERSION
    || value.nonce !== job.nonce || !validRequest(value.request)
    || Object.keys(job.request).some(key => value.request[key] !== job.request[key])) return null;
  const result = value.result;
  if (keys(result, ["kind", "code"]) && result.kind === "source_unavailable" && sourceCodes.has(result.code)) return result;
  return validSnapshot(result, job.source.sessionId) ? result : null;
}
module.exports = { WIRE_VERSION, LIMITS, uuid, keys, detach, validRequest, validJob, decode, readResponse };
