"use strict";
// Bytes-only, Host-private v11 page projection. Full-file validation belongs to
// the held-FD helper receipt, not to these selected bytes. No native turn graph.
const scan = require("./scanned-source-wire"), { canonicalJSON } = require("../../../public/modules/projection");
const { createHash } = require("node:crypto"), { LIMITS: RAW } = require("./rollout-snapshot");
const keys = (v, names) => v && typeof v === "object" && !Array.isArray(v) && Object.keys(v).sort().join(",") === [...names].sort().join(",");
const integer = (v, min, max) => Number.isSafeInteger(v) && v >= min && v <= max;
const label = v => typeof v === "string" && v.length > 0 && v.length <= 128 && !/[\u0000-\u001f\u007f-\u009f]/.test(v);
const object = v => v !== null && typeof v === "object" && !Array.isArray(v);
const uuid = v => typeof v === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
const sha = b => createHash("sha256").update(b).digest("hex"), hash = v => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
const unavailable = code => ({ kind: "source_unavailable", code });
const version = v => v?.kind === "codex_validated_source_version" && scan.sameSourceVersion(v, v);
function selection(v) {
  return keys(v, ["mode"]) && v.mode === "names" || keys(v, ["mode", "offset", "limit"]) && v.mode === "records"
    && integer(v.offset, 0, scan.LIMITS.records) && integer(v.limit, 1, scan.LIMITS.pageRecords);
}
function descriptor(page, source, selected) {
  if (!version(source) || !selection(selected) || !keys(page, ["offset", "byteLength", "records", "nextOffset"])
    || page.offset !== (selected.mode === "names" ? 0 : selected.offset) || !integer(page.offset, 0, source.rollout.recordCount)
    || !integer(page.byteLength, 0, scan.LIMITS.pageBytes) || !Array.isArray(page.records)
    || page.records.length > (selected.mode === "names" ? 1 : selected.limit)) return false;
  const end = page.offset + page.records.length, remaining = source.rollout.recordCount - end;
  if (remaining < 0 || page.nextOffset !== (remaining === 0 ? null : end) || remaining > 0 && !page.records.length) return false;
  let size = 0, byteEnd = null;
  for (const [i, r] of page.records.entries()) {
    if (!keys(r, ["recordIndex", "byteOffset", "byteLength", "payloadOffset", "sha256"]) || r.recordIndex !== page.offset + i
      || !integer(r.byteLength, 1, scan.LIMITS.recordBytes) || !integer(r.byteOffset, r.recordIndex, r.recordIndex * scan.LIMITS.recordBytes)
      || r.byteOffset + r.byteLength > source.rollout.identity.size || r.payloadOffset !== size || !hash(r.sha256)
      || byteEnd !== null && r.byteOffset !== byteEnd) return false;
    size += r.byteLength; byteEnd = r.byteOffset + r.byteLength;
  }
  return size === page.byteLength && (byteEnd === null || integer(source.rollout.identity.size - byteEnd, remaining, remaining * scan.LIMITS.recordBytes));
}
function payload(bytes, job) {
  if (!Buffer.isBuffer(bytes) || !descriptor(job.page, job.source, job.selection)
    || bytes.length !== job.page.byteLength + (job.source.nameIndex?.identity.size ?? 0)) return false;
  for (const r of job.page.records) {
    const b = bytes.subarray(r.payloadOffset, r.payloadOffset + r.byteLength);
    if (sha(b) !== r.sha256 || b.at(-1) !== 10 || b.indexOf(10) !== b.length - 1) return false;
  }
  return job.source.nameIndex === null || sha(bytes.subarray(job.page.byteLength)) === job.source.nameIndex.sha256;
}
function record(bytes, r, source) {
  let text, value, recordType = "blank", payloadType = null;
  try { text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { return unavailable("rollout_invalid_utf8"); }
  if (text.trim()) {
    try { value = JSON.parse(text); } catch { return unavailable("rollout_invalid_record"); }
    if (!object(value) || !label(value.type) || canonicalJSON(value, RAW.recordBytes * 4) === null) return unavailable("rollout_invalid_record");
    recordType = value.type;
    if (object(value.payload) && label(value.payload.type)) payloadType = value.payload.type;
    if (r.recordIndex < source.validation.selectedMetadataRecord) return unavailable("rollout_selected_thread_mismatch");
    if (recordType === "session_meta") {
      if (!object(value.payload) || !uuid(value.payload.id)) return unavailable("rollout_invalid_metadata");
      const mode = Object.hasOwn(value.payload, "history_mode") ? value.payload.history_mode : "legacy";
      if (mode !== "legacy") return unavailable(mode === "paginated" ? "native_paginated_history_unsupported" : "native_history_mode_unknown");
    }
  }
  if (r.recordIndex === source.validation.selectedMetadataRecord && (recordType !== "session_meta" || value.payload.id !== source.threadId))
    return unavailable("rollout_selected_thread_mismatch");
  return { recordIndex: r.recordIndex, byteOffset: r.byteOffset, byteLength: r.byteLength, recordType, payloadType,
    rawText: text, sha256: r.sha256, executable: false };
}
function project(bytes, job) {
  if (!payload(bytes, job)) return unavailable("source_worker_protocol");
  const source = job.source, records = [], result = { kind: "codex_validated_rollout_records", nativeVersion: source.nativeVersion,
    nativeThreadId: source.threadId, scope: "one_legacy_rollout_validated_page", sha256: source.rollout.sha256,
    recordCount: source.rollout.recordCount, byteLength: source.rollout.identity.size, offset: job.page.offset, records,
    nextOffset: null, endOfFile: false, sourceAuthenticated: false, publishable: false, semanticHistoryComplete: false };
  let size = 1024;
  for (const r of job.page.records) {
    const row = record(bytes.subarray(r.payloadOffset, r.payloadOffset + r.byteLength), r, source);
    if (row.kind === "source_unavailable") return row;
    if (job.selection.mode === "names") continue;
    const rowSize = Buffer.byteLength(JSON.stringify(row)) + 1;
    if (size + rowSize > RAW.pageBytes) { if (!records.length) return unavailable("rollout_record_limit"); break; }
    records.push(row); size += rowSize;
  }
  if (job.selection.mode === "names") return null;
  result.endOfFile = result.offset + records.length === result.recordCount;
  result.nextOffset = result.endOfFile ? null : result.offset + records.length;
  return result;
}
// Reconstruct at most one bounded page: parent verifies byte offsets, labels,
// original text and the *returned* cursor, including JSON-escape budget cuts.
function matches(value, job, bytes) {
  if (bytes === undefined) {
    if (job.selection.mode === "names") return value === null;
    if (!value || !Array.isArray(value.records) || value.records.length > job.page.records.length
      || !value.records.length && job.page.records.length || Buffer.byteLength(JSON.stringify(value)) > RAW.pageBytes) return false;
    for (const [i, r] of value.records.entries()) {
      const d = job.page.records[i];
      if (!keys(r, ["recordIndex", "byteOffset", "byteLength", "recordType", "payloadType", "rawText", "sha256", "executable"])
        || r.recordIndex !== d.recordIndex || r.byteOffset !== d.byteOffset || r.byteLength !== d.byteLength || r.sha256 !== d.sha256
        || !label(r.recordType) || r.payloadType !== null && !label(r.payloadType) || typeof r.rawText !== "string" || r.executable !== false) return false;
      const b = Buffer.from(r.rawText);
      if (b.length !== r.byteLength || sha(b) !== d.sha256 || b.at(-1) !== 10 || b.indexOf(10) !== b.length - 1) return false;
    }
    const eof = value.offset + value.records.length === job.source.rollout.recordCount;
    const expected = { kind: "codex_validated_rollout_records", nativeVersion: job.source.nativeVersion, nativeThreadId: job.source.threadId,
      scope: "one_legacy_rollout_validated_page", sha256: job.source.rollout.sha256, recordCount: job.source.rollout.recordCount,
      byteLength: job.source.rollout.identity.size, offset: job.page.offset, records: value.records,
      nextOffset: eof ? null : job.page.offset + value.records.length, endOfFile: eof,
      sourceAuthenticated: false, publishable: false, semanticHistoryComplete: false };
    return canonicalJSON(value, RAW.pageBytes) === canonicalJSON(expected, RAW.pageBytes);
  }
  if (!Buffer.isBuffer(bytes)) return false;
  const expected = project(bytes, job);
  return expected?.kind !== "source_unavailable" && canonicalJSON(value, RAW.pageBytes) === canonicalJSON(expected, RAW.pageBytes);
}
module.exports = { version, selection, descriptor, payload, project, matches };
