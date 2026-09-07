"use strict";
// Private worker wire, not Stepsemble Protocol or a browser API.
const { canonicalJSON } = require("../../../public/modules/projection");
const { normalizeSourceInput, LIMITS: SOURCE } = require("./history-source");
const { classifyRecordScopes } = require("./history-record-scope");
const { validObservation } = require("./history-observation-value");
const { validSdkPath, SDK_VERSION, NATIVE_VERSION, SDK_SHA256 } = require("./history-sdk");
const WIRE_VERSION = 1;
const LIMITS = Object.freeze({ inputBytes: 12288, outputBytes: 10 * 1024 * 1024, outputChunks: 4096,
  bindings: 64, workers: 2, deadlineMs: 10000, cleanupMs: 1000, pageBytes: 256 * 1024, pageMessages: 100 });
const uuid = value => typeof value === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const keys = (value, list) => object(value) && Object.keys(value).sort().join(",") === [...list].sort().join(",");
const decimal = value => typeof value === "string" && /^\d{1,30}$/.test(value);
const sourceCodes = new Set(["invalid_source_input", "source_platform_unsupported", "source_missing", "source_empty", "source_too_large",
  "source_line_too_large", "source_too_many_records", "source_incomplete_tail", "source_invalid_encoding", "source_blank_record",
  "source_invalid_json", "source_invalid_json_value", "source_scope_mismatch", "source_ancillary_invalid", "source_ancillary_reference_unavailable",
  "source_not_regular_or_linked", "source_owner_or_mode", "source_identity_unavailable", "source_hardlinked", "source_changed",
  "source_access_denied", "source_io_error", "source_read_budget", "source_close_failed", "source_worker_failure",
  "source_sdk_unavailable", "source_selection_failed", "source_observation_rejected", "source_observation_too_large", "source_version_changed"]);
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
  return keys(value, ["protocolVersion", "nonce", "request", "source", ...(value?.history === undefined ? [] : ["history"])]) && value.protocolVersion === WIRE_VERSION
    && typeof value.nonce === "string" && /^[a-f0-9]{64}$/.test(value.nonce)
    && validRequest(value.request) && normalizeSourceInput(value.source) !== null
    && (value.history === undefined || keys(value.history, ["sdkPath", "page", ...(value.history?.expectedVersion === undefined ? [] : ["expectedVersion"])])
      && validSdkPath(value.history.sdkPath) && validPage(value.history.page)
      && (value.history.expectedVersion == null || validSourceVersion(value.history.expectedVersion)));
}
// A source fingerprint, not an authorization token or a persistent snapshot.
function sourceVersion(value) {
  return { sha256: value.sha256, identity: { ...value.identity } };
}
function validSourceVersion(value) {
  return keys(value, ["sha256", "identity"]) && typeof value.sha256 === "string" && /^[a-f0-9]{64}$/.test(value.sha256)
    && keys(value.identity, ["device", "inode", "size", "mtimeNs", "ctimeNs"])
    && ["device", "inode", "mtimeNs", "ctimeNs"].every(key => decimal(value.identity[key])) && value.identity.inode !== "0"
    && Number.isSafeInteger(value.identity.size) && value.identity.size > 0 && value.identity.size <= SOURCE.bytes;
}
function sameSourceVersion(expected, actual) {
  return validSourceVersion(expected) && expected.sha256 === actual.sha256
    && Object.keys(expected.identity).every(key => expected.identity[key] === actual.identity?.[key]);
}
function validPage(page) {
  return keys(page, ["offset", "limit"]) && Number.isSafeInteger(page.offset) && page.offset >= 0 && page.offset <= SOURCE.records
    && Number.isSafeInteger(page.limit) && page.limit > 0 && page.limit <= LIMITS.pageMessages;
}
function validSnapshot(value, sessionId, summary = false) {
  return keys(value, ["kind", "sessionId", summary ? "recordCount" : "records", "byteLength", "sha256", "identity", "checks", "sourceAuthenticated", "publishable"])
    && value.kind === (summary ? "source_snapshot_summary" : "source_snapshot") && value.sessionId === sessionId && value.sourceAuthenticated === false && value.publishable === false
    && (summary ? Number.isSafeInteger(value.recordCount) && value.recordCount > 0 && value.recordCount <= SOURCE.records
      : Array.isArray(value.records) && value.records.length > 0 && value.records.length <= SOURCE.records)
    && Number.isSafeInteger(value.byteLength) && value.byteLength > 0 && value.byteLength <= SOURCE.bytes
    && typeof value.sha256 === "string" && /^[a-f0-9]{64}$/.test(value.sha256)
    && keys(value.identity, ["device", "inode", "size", "mtimeNs", "ctimeNs"])
    && ["device", "inode", "mtimeNs", "ctimeNs"].every(key => decimal(value.identity[key]))
    && value.identity.inode !== "0" && value.identity.size === value.byteLength
    && keys(value.checks, ["owner", "reads", "matchingBytes", "unchangedObservedIdentity"])
    && value.checks.owner === "posix_euid_and_mode" && value.checks.reads === 2
    && value.checks.matchingBytes === true && value.checks.unchangedObservedIdentity === true
    && (summary || classifyRecordScopes(value.records, sessionId).kind === "record_scopes");
}
function readResponse(bytes, job) {
  const value = decode(bytes, job.history ? LIMITS.pageBytes : LIMITS.outputBytes);
  if (!keys(value, ["protocolVersion", "nonce", "request", "result"]) || value.protocolVersion !== WIRE_VERSION
    || value.nonce !== job.nonce || !validRequest(value.request)
    || Object.keys(job.request).some(key => value.request[key] !== job.request[key])) return null;
  const result = value.result;
  if (keys(result, ["kind", "code"]) && result.kind === "source_unavailable" && sourceCodes.has(result.code)) return result;
  if (job.history) {
    const valid = keys(result, ["kind", "source", "page", "observation", "reader", "metrics"])
    && result.kind === "source_history_observation" && validSnapshot(result.source, job.source.sessionId, true)
    && validPage(result.page) && result.page.offset === job.history.page.offset && result.page.limit === job.history.page.limit
    && keys(result.reader, ["sdkVersion", "nativeVersion", "sdkSha256", "selection"])
    && result.reader.sdkVersion === SDK_VERSION && result.reader.nativeVersion === NATIVE_VERSION && result.reader.sdkSha256 === SDK_SHA256
    && result.reader.selection === "snapshot_session_store"
    && keys(result.metrics, ["selectionMs", "mappingMs", "maxRssKiB"])
    && Object.values(result.metrics).every(v => typeof v === "number" && Number.isFinite(v) && v >= 0)
    && validObservation(result.observation, job.source.sessionId, result.page.limit, result.source.recordCount);
    if (!valid) return null;
    if (job.history.expectedVersion && !sameSourceVersion(job.history.expectedVersion, result.source))
      return { kind: "source_unavailable", code: "source_version_changed" };
    return result;
  }
  return validSnapshot(result, job.source.sessionId) ? result : null;
}
module.exports = { WIRE_VERSION, LIMITS, uuid, keys, detach, validRequest, validPage, validJob, decode, readResponse,
  sourceVersion, validSourceVersion, sameSourceVersion };
