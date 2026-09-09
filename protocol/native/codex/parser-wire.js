"use strict";
// Host-private bytes-only parser wire, not HTTP, a source grant, or native RPC.
const path = require("node:path"), crypto = require("node:crypto");
const { canonicalJSON } = require("../../../public/modules/projection");
const source = require("./source-wire");
const sqlite = require("./sqlite-wire").context;
const { observeMetadataName } = require("./metadata-name");
const { LIMITS: INDEX } = require("./name-index");
const { LIMITS: RAW } = require("./rollout-snapshot");
const LIMITS = Object.freeze({ headerBytes: 16 * 1024, namedHeaderBytes: 224 * 1024, inputBytes: 4 + 224 * 1024 + 16 * 1024 * 1024,
  outputBytes: 416 * 1024, chunks: 4096, deadlineMs: 10000, cleanupMs: 1000 });
const CODES = Object.freeze(["source_worker_protocol", "source_worker_failure", "source_version_changed", "source_worker_output_limit",
  "invalid_envelope_or_version", "invalid_rollout_bytes_or_limit", "rollout_incomplete_tail", "rollout_record_limit", "rollout_invalid_utf8",
  "rollout_invalid_record", "rollout_selected_thread_mismatch", "rollout_invalid_metadata", "native_paginated_history_unsupported",
  "native_history_mode_unknown", "invalid_rollout_page", "rollout_snapshot_changed", "rollout_page_limit", "rollout_snapshot_unavailable",
  "invalid_name_index_bytes_or_limit", "name_index_record_limit", "name_index_invalid_utf8", "name_index_name_limit",
  "name_index_record_unsupported", "name_index_output_limit", "invalid_name_resolution_input", "invalid_name_resolution_fields",
  "invalid_name_resolution_context", "name_resolution_missing_row_unsupported", "name_resolution_rollout_mismatch", "name_resolution_index_unavailable"]);
const keys = (v, expected) => !!v && typeof v === "object" && !Array.isArray(v) && Object.keys(v).sort().join(",") === [...expected].sort().join(",");
const sha = b => crypto.createHash("sha256").update(b).digest("hex");
const hash = v => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
const integer = (v, max) => Number.isSafeInteger(v) && v >= 0 && v <= max;
const label = v => typeof v === "string" && v.length > 0 && v.length <= 128 && !/[\u0000-\u001f\u007f-\u009f]/.test(v);
const unavailable = code => ({ kind: "source_unavailable", code });
function detach(v, limit = LIMITS.headerBytes) {
  try { const s = canonicalJSON(v, limit); return s === null ? null : JSON.parse(s); } catch { return null; }
}
function validSelection(v) {
  return keys(v, ["mode"]) && v.mode === "names" || keys(v, ["mode", "offset", "limit"]) && v.mode === "records"
    && integer(v.offset, RAW.records) && integer(v.limit, RAW.pageRecords) && v.limit > 0;
}
function validNameRequest(v) {
  return keys(v, ["history", "sqlite", "method"]) && source.input(v.history) && sqlite.input(v.sqlite)
    && v.history.nativeVersion === v.sqlite.nativeVersion && v.history.source.threadId === v.sqlite.source.threadId
    && ["thread_read_sqlite", "thread_list_state_row"].includes(v.method);
}
function sameNamedVersion(a, b) {
  a = detach(a); b = detach(b);
  const valid = v => keys(v, ["kind", "history", "sqlite"]) && v.kind === "codex_named_source_version"
    && source.sameSourceVersion(v.history, v.history) && sqlite.sameSourceVersion(v.sqlite, v.sqlite)
    && v.history.threadId === v.sqlite.threadId && v.history.nativeVersion === v.sqlite.nativeVersion;
  return valid(a) && valid(b) && source.sameSourceVersion(a.history, b.history) && sqlite.sameSourceVersion(a.sqlite, b.sqlite);
}
function validNameContext(v, version) {
  if (!keys(v, ["fields", "nameContext", "method", "rolloutPath"]) || !["thread_read_sqlite", "thread_list_state_row"].includes(v.method)
    || typeof v.rolloutPath !== "string" || !v.rolloutPath.isWellFormed() || Buffer.byteLength(v.rolloutPath) > 8192
    || !path.isAbsolute(v.rolloutPath) || path.resolve(v.rolloutPath) !== v.rolloutPath || /[\u0000-\u001f\u007f]/.test(v.rolloutPath)) return false;
  if (observeMetadataName(v.fields, { nativeVersion: version.nativeVersion, threadId: version.threadId }).kind !== "codex_metadata_name_observation") return false;
  const c = v.nameContext;
  return v.fields === null ? c === null : keys(c, ["rolloutPath", "preview"]) && typeof c.rolloutPath === "string" && c.rolloutPath.isWellFormed()
    && Buffer.byteLength(c.rolloutPath) <= 8192 && typeof c.preview === "string" && c.preview.isWellFormed() && Buffer.byteLength(c.preview) <= 32768;
}
function validJob(v) {
  const named = v?.protocolVersion === 2;
  return keys(v, ["protocolVersion", "nonce", "source", "selection", "expectedVersion", ...(named ? ["nameResolution"] : [])]) && [1, 2].includes(v.protocolVersion) && hash(v.nonce)
    && source.sameSourceVersion(v.source, v.source) && validSelection(v.selection)
    && (v.expectedVersion === null || source.sameSourceVersion(v.expectedVersion, v.expectedVersion)) && (!named || validNameContext(v.nameResolution, v.source));
}
function validPayload(bytes, job) {
  if (!Buffer.isBuffer(bytes) || !validJob(job)) return false;
  const split = job.source.rollout.identity.size, size = split + (job.source.nameIndex?.identity.size ?? 0);
  return bytes.length === size && sha(bytes.subarray(0, split)) === job.source.rollout.sha256
    && (job.source.nameIndex === null || sha(bytes.subarray(split)) === job.source.nameIndex.sha256);
}
function encodeJob(input, captured) {
  const job = detach(input, LIMITS.namedHeaderBytes), version = source.sourceVersion(captured);
  if (!validJob(job) || !version || !source.sameSourceVersion(version, job.source)) return null;
  const fields = Object.getOwnPropertyDescriptors(captured);
  if (fields.cleanupConfirmed?.value !== true) return null;
  const rollout = fields.rolloutBytes?.value, index = fields.nameIndexBytes?.value;
  // Capture buffers are Host-owned. Reject accessors/shared memory/overridden
  // properties rather than executing a caller's byteLength or copy hook.
  const typed = Object.getPrototypeOf(Uint8Array.prototype), get = key => Object.getOwnPropertyDescriptor(typed, key).get;
  const view = (value, size) => {
    try {
      if (!Buffer.isBuffer(value) || get("byteLength").call(value) !== size) return null;
      const backing = get("buffer").call(value), offset = get("byteOffset").call(value);
      return Object.getPrototypeOf(backing) === ArrayBuffer.prototype ? new Uint8Array(backing, offset, size) : null;
    } catch { return null; }
  };
  const a = view(rollout, version.rollout.identity.size), b = version.nameIndex === null ? null : view(index, version.nameIndex.identity.size);
  if (!a || (version.nameIndex === null ? index !== null : b === null)) return null;
  const header = Buffer.from(JSON.stringify(job)); if (header.length > (job.protocolVersion === 2 ? LIMITS.namedHeaderBytes : LIMITS.headerBytes)) return null;
  const encoded = Buffer.allocUnsafe(4 + header.length + a.length + (b?.length ?? 0));
  encoded.writeUInt32BE(header.length); header.copy(encoded, 4); encoded.set(a, 4 + header.length);
  if (b) encoded.set(b, 4 + header.length + a.length);
  // The child revalidates both segment digests before parsing. The parent has
  // already checked the Rust capture; don't parse/stringify 16MiB on its loop.
  return encoded;
}
function decode(bytes, limit) {
  if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > limit || bytes.subarray(0, 3).equals(Buffer.from([239, 187, 191]))) return null;
  try { return detach(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)), limit); } catch { return null; }
}
function readJob(frame) {
  if (!Buffer.isBuffer(frame) || frame.length < 5 || frame.length > LIMITS.inputBytes) return null;
  const length = frame.readUInt32BE(0); if (!length || length > LIMITS.namedHeaderBytes || length + 4 > frame.length) return null;
  const job = decode(frame.subarray(4, 4 + length), LIMITS.namedHeaderBytes), bytes = frame.subarray(4 + length);
  if (job?.protocolVersion !== 2 && length > LIMITS.headerBytes) return null;
  return validPayload(bytes, job) ? { job, bytes } : null;
}
function validIndex(v, job) {
  const d = job.source.nameIndex, nullableName = n => n === null || typeof n === "string" && Buffer.byteLength(n) <= INDEX.nameBytes;
  if (!keys(v, ["kind", "nativeVersion", "nativeThreadId", "scope", "presence", "byteLength", "sha256", "recordCount", "rejectedReadRecords", "rejectedListRecords",
    "latestEntry", "readCandidate", "listCandidate", "nativeTitleResolved", "sourceAuthenticated", "publishable"]) || v.kind !== "codex_name_index_observation"
    || v.nativeVersion !== job.source.nativeVersion || v.nativeThreadId !== job.source.threadId || v.scope !== "legacy_session_index_only"
    || v.presence !== (d === null ? "missing" : d.identity.size ? "present" : "empty") || v.byteLength !== (d?.identity.size ?? 0) || v.sha256 !== (d?.sha256 ?? null)
    || !integer(v.recordCount, INDEX.records) || !integer(v.rejectedReadRecords, v.recordCount) || !integer(v.rejectedListRecords, v.recordCount)
    || !nullableName(v.readCandidate) || !nullableName(v.listCandidate) || v.nativeTitleResolved !== false || v.sourceAuthenticated !== false || v.publishable !== false
    || Buffer.byteLength(JSON.stringify(v)) > INDEX.outputBytes) return false;
  if (v.latestEntry !== null && (!keys(v.latestEntry, ["name", "updatedAt", "recordIndex", "byteOffset", "byteLength"])
    || typeof v.latestEntry.name !== "string" || !nullableName(v.latestEntry.name) || typeof v.latestEntry.updatedAt !== "string"
    || !integer(v.latestEntry.recordIndex, v.recordCount - 1) || !integer(v.latestEntry.byteOffset, v.byteLength)
    || !integer(v.latestEntry.byteLength, INDEX.recordBytes) || v.latestEntry.byteOffset + v.latestEntry.byteLength > v.byteLength)) return false;
  if (v.readCandidate !== null && (v.readCandidate === "" || v.readCandidate !== v.latestEntry?.name) || v.listCandidate === "") return false;
  return v.byteLength > 0 || v.recordCount === 0 && v.latestEntry === null && v.readCandidate === null && v.listCandidate === null;
}
function validPage(v, job, payload) {
  if (!keys(v, ["kind", "nativeVersion", "nativeThreadId", "scope", "sha256", "recordCount", "byteLength", "offset", "records", "nextOffset", "endOfFile",
    "sourceAuthenticated", "publishable", "semanticHistoryComplete"]) || v.kind !== "codex_rollout_records"
    || v.nativeVersion !== job.source.nativeVersion || v.nativeThreadId !== job.source.threadId || v.scope !== "one_legacy_rollout_raw_records"
    || v.sha256 !== job.source.rollout.sha256 || v.byteLength !== job.source.rollout.identity.size || !integer(v.recordCount, RAW.records) || v.recordCount === 0
    || v.offset !== job.selection.offset || !Array.isArray(v.records) || v.records.length > job.selection.limit || v.offset + v.records.length > v.recordCount
    || v.endOfFile !== (v.offset + v.records.length === v.recordCount) || v.nextOffset !== (v.endOfFile ? null : v.offset + v.records.length)
    || !v.endOfFile && v.records.length === 0 || v.sourceAuthenticated !== false || v.publishable !== false || v.semanticHistoryComplete !== false
    || Buffer.byteLength(JSON.stringify(v)) > RAW.pageBytes) return false;
  let end = null;
  for (const [i, r] of v.records.entries()) {
    if (!keys(r, ["recordIndex", "byteOffset", "byteLength", "recordType", "payloadType", "rawText", "sha256", "executable"])
      || r.recordIndex !== v.offset + i || !integer(r.byteOffset, v.byteLength) || !integer(r.byteLength, RAW.recordBytes) || r.byteLength === 0
      || r.byteOffset + r.byteLength > v.byteLength || end !== null && r.byteOffset !== end || r.recordIndex === 0 && r.byteOffset !== 0
      || !label(r.recordType) || r.payloadType !== null && !label(r.payloadType) || typeof r.rawText !== "string" || r.executable !== false || !hash(r.sha256)) return false;
    const bytes = Buffer.from(r.rawText);
    if (bytes.length !== r.byteLength || sha(bytes) !== r.sha256 || bytes.at(-1) !== 10
      || payload && !bytes.equals(payload.subarray(r.byteOffset, r.byteOffset + r.byteLength))) return false;
    end = r.byteOffset + r.byteLength;
  }
  return !v.endOfFile || end === null || end === v.byteLength;
}
function validResult(v, job, payload) {
  if (keys(v, ["kind", "code"]) && v.kind === "source_unavailable") return CODES.includes(v.code);
  return keys(v, ["kind", "source", "index", "page", "sourceAuthenticated", "publishable", "semanticHistoryComplete", ...(job.protocolVersion === 2 ? ["name"] : [])])
    && v.kind === "codex_parsed_capture" && source.sameSourceVersion(job.source, v.source) && validIndex(v.index, job)
    && (job.selection.mode === "names" ? v.page === null : validPage(v.page, job, payload))
    && v.sourceAuthenticated === false && v.publishable === false && v.semanticHistoryComplete === false
    && (job.protocolVersion !== 2 || validName(v.name, job));
}
function validName(v, job) {
  return keys(v, ["kind", "nativeVersion", "nativeThreadId", "scope", "method", "name", "candidateSource", "suppressedByPreview", "nativeTitleResolved", "sourceAuthenticated", "publishable"])
    && v.kind === "codex_name_resolution_observation" && v.nativeVersion === job.source.nativeVersion && v.nativeThreadId === job.source.threadId
    && v.scope === "provided_matched_sqlite_rollout_context_only" && v.method === job.nameResolution.method
    && (v.name === null || typeof v.name === "string" && v.name.isWellFormed() && Buffer.byteLength(v.name) <= 32768)
    && [null, "sqlite_distinct_legacy_title", "sqlite_paginated_name", "legacy_index_single_read", "legacy_index_batch_list"].includes(v.candidateSource)
    && typeof v.suppressedByPreview === "boolean" && (!v.suppressedByPreview || v.name === null && v.method === "thread_list_state_row" && job.nameResolution.fields?.history_mode === "legacy")
    && v.nativeTitleResolved === false && v.sourceAuthenticated === false && v.publishable === false;
}
function readResponse(bytes, job, payload) {
  if (!validJob(job) || !Buffer.isBuffer(bytes) || bytes.at(-1) !== 10 || bytes.indexOf(10) !== bytes.length - 1) return null;
  const v = decode(bytes, LIMITS.outputBytes);
  return keys(v, ["protocolVersion", "nonce", "result"]) && v.protocolVersion === job.protocolVersion && v.nonce === job.nonce && validResult(v.result, job, payload) ? v.result : null;
}
function encodeResponse(result, job) {
  if (!validJob(job)) return null;
  const encode = result => Buffer.from(JSON.stringify({ protocolVersion: job.protocolVersion, nonce: job.nonce, result }) + "\n");
  let bytes;
  try { bytes = encode(result); } catch { bytes = encode(unavailable("source_worker_failure")); }
  if (bytes.length > LIMITS.outputBytes) bytes = encode(unavailable("source_worker_output_limit"));
  return readResponse(bytes, job) ? bytes : encode(unavailable("source_worker_protocol"));
}
function launchOptions() {
  const files = ["parser-worker.js", "parser-wire.js", "source-wire.js", "name-index.js", "rollout-snapshot.js", "sqlite-wire.js", "metadata-name.js", "name-resolution.js"].map(f => path.join(__dirname, f));
  files.push(path.resolve(__dirname, "../../../public/modules/projection.js"));
  return { executable: process.execPath, args: ["--permission", "--no-warnings", "--max-old-space-size=128", ...files.map(f => `--allow-fs-read=${f}`), files[0]],
    options: { cwd: __dirname, env: { LANG: "C", LC_ALL: "C" }, stdio: ["pipe", "pipe", "pipe"], shell: false, detached: false, windowsHide: true } };
}
module.exports = { LIMITS, CODES, detach, keys, validSelection, validJob, validPayload, validNameRequest, validName, sameNamedVersion, encodeJob, readJob, readResponse, encodeResponse, launchOptions };
