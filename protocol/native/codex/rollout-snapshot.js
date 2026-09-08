"use strict";
// Bytes supplied by a trusted caller, NOT a filesystem reader or native RPC.
// Preserves raw records omitted by native projections, without inventing turns,
// item IDs, names, approval receipts or native capability. Not publishable.
const crypto = require("node:crypto");
const { canonicalJSON } = require("../../../public/modules/projection");
const NATIVE_VERSION = "0.153.4";
const LIMITS = Object.freeze({ inputBytes: 8 * 1024 * 1024, recordBytes: 128 * 1024, records: 8192, pageBytes: 272 * 1024, pageRecords: 50 });
const snapshots = new WeakMap();
const typed = Object.getPrototypeOf(Uint8Array.prototype);
const bufferOf = Object.getOwnPropertyDescriptor(typed, "buffer").get;
const offsetOf = Object.getOwnPropertyDescriptor(typed, "byteOffset").get;
const lengthOf = Object.getOwnPropertyDescriptor(typed, "byteLength").get;
const tagOf = Object.getOwnPropertyDescriptor(typed, Symbol.toStringTag).get;
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const uuid = value => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const label = value => typeof value === "string" && value.length > 0 && value.length <= 128 && !/[\u0000-\u001f\u007f-\u009f]/.test(value);
const unavailable = code => ({ kind: "codex_history_unavailable", code });
const hash = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
function optionsJSON(input) {
  try { const json = canonicalJSON(input, 2048); return json === null ? null : JSON.parse(json); } catch { return null; }
}
function copyBytes(input) {
  // Use intrinsic getters: no user .buffer/.byteLength/.slice accessors or
  // species constructors. Shared memory cannot be a stable capture input.
  try {
    if (tagOf.call(input) !== "Uint8Array") return null;
    const backing = bufferOf.call(input), length = lengthOf.call(input), offset = offsetOf.call(input);
    if (Object.getPrototypeOf(backing) !== ArrayBuffer.prototype || !length || length > LIMITS.inputBytes) return null;
    const bytes = Buffer.allocUnsafe(length);
    Uint8Array.prototype.set.call(bytes, new Uint8Array(backing, offset, length));
    return bytes;
  } catch { return null; }
}
function rawRecord(bytes, boundary, index) {
  const [start, end, recordType, payloadType] = boundary, value = bytes.subarray(start, end);
  return { recordIndex: index, byteOffset: start, byteLength: end - start, recordType, payloadType,
    rawText: value.toString("utf8"), sha256: hash(value), executable: false };
}
function parseRollout(input, parameters, namesOnly) {
  const options = optionsJSON(parameters);
  if (!object(options) || Object.keys(options).sort().join(",") !== "nativeVersion,threadId" ||
      options.nativeVersion !== NATIVE_VERSION || !uuid(options.threadId)) return unavailable("invalid_envelope_or_version");
  const bytes = copyBytes(input);
  if (bytes === null) return unavailable("invalid_rollout_bytes_or_limit");
  let retained = false;
  try {
    // Require a complete newline-terminated capture; an in-progress tail must
    // be refreshed explicitly, never dropped and reported as a complete file.
    if (bytes[bytes.length - 1] !== 10) return unavailable("rollout_incomplete_tail");
    const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }), boundaries = [];
    let start = 0, selected = false, selectedMode = null;
    for (let end = 0; end < bytes.length; end++) {
      if (end - start + 1 > LIMITS.recordBytes) return unavailable("rollout_record_limit");
      if (bytes[end] !== 10) continue;
      if (boundaries.length === LIMITS.records) return unavailable("rollout_record_limit");
      let text, value, recordType = "blank", payloadType = null;
      try { text = utf8.decode(bytes.subarray(start, end + 1)); } catch { return unavailable("rollout_invalid_utf8"); }
      if (text.trim()) {
        try { value = JSON.parse(text); } catch { return unavailable("rollout_invalid_record"); }
        // Also reject unpaired surrogates, extreme structure and non-finite
        // numeric JSON. The original spelling is retained, not this projection.
        if (!object(value) || !label(value.type) || canonicalJSON(value, LIMITS.recordBytes * 4) === null) return unavailable("rollout_invalid_record");
        recordType = value.type;
        if (object(value.payload) && label(value.payload.type)) payloadType = value.payload.type;
        if (!selected && value.type !== "session_meta") return unavailable("rollout_selected_thread_mismatch");
        if (value.type === "session_meta" && (!namesOnly || !selected)) {
          if (!object(value.payload) || !uuid(value.payload.id)) return unavailable("rollout_invalid_metadata");
          const mode = Object.hasOwn(value.payload, "history_mode") ? value.payload.history_mode : "legacy";
          if (mode === "paginated" && !namesOnly) return unavailable("native_paginated_history_unsupported");
          if (!["legacy", "paginated"].includes(mode)) return unavailable("native_history_mode_unknown");
          if (!selected && value.payload.id !== options.threadId) return unavailable("rollout_selected_thread_mismatch");
          if (!selected) selectedMode = mode;
          selected = true; // Later fork metadata is preserved, never changes selected ID.
        }
      }
      const boundary = [start, end + 1, recordType, payloadType];
      // Every record must fit in one encoded output page without truncation.
      if (!namesOnly && Buffer.byteLength(JSON.stringify(rawRecord(bytes, boundary, boundaries.length))) + 1024 > LIMITS.pageBytes) return unavailable("rollout_record_limit");
      boundaries.push(boundary); start = end + 1;
    }
    if (!selected) return unavailable("rollout_invalid_metadata");
    if (namesOnly) return { kind: "codex_rollout_name_identity", nativeVersion: NATIVE_VERSION, nativeThreadId: options.threadId,
      historyMode: selectedMode, scope: "selected_rollout_metadata_only", byteLength: bytes.length, sha256: hash(bytes),
      sourceAuthenticated: false, publishable: false, semanticHistoryComplete: false };
    const snapshot = Object.freeze({ kind: "codex_rollout_snapshot", snapshotId: crypto.randomUUID(), nativeVersion: NATIVE_VERSION,
      nativeThreadId: options.threadId, scope: "one_legacy_rollout_raw_records", byteLength: bytes.length,
      recordCount: boundaries.length, sha256: hash(bytes), sourceAuthenticated: false, publishable: false, semanticHistoryComplete: false });
    snapshots.set(snapshot, { bytes, boundaries }); retained = true;
    return snapshot;
  } catch { return unavailable("rollout_invalid_record"); }
  finally { if (!retained) bytes.fill(0); }
}
function createRolloutSnapshot(input, parameters) { return parseRollout(input, parameters, false); }
function observeRolloutNameIdentity(input, parameters) { return parseRollout(input, parameters, true); }
function readRolloutPage(snapshot, parameters) {
  const entry = snapshots.get(snapshot);
  if (!entry) return unavailable("rollout_snapshot_unavailable");
  const options = optionsJSON(parameters);
  if (!object(options) || Object.keys(options).sort().join(",") !== "limit,offset,snapshotId" ||
      !Number.isInteger(options.offset) || options.offset < 0 || options.offset > entry.boundaries.length ||
      !Number.isInteger(options.limit) || options.limit < 1 || options.limit > LIMITS.pageRecords) return unavailable("invalid_rollout_page");
  if (options.snapshotId !== snapshot.snapshotId) return unavailable("rollout_snapshot_changed");
  const records = [], result = { kind: "codex_rollout_records", snapshotId: snapshot.snapshotId, nativeVersion: snapshot.nativeVersion,
    nativeThreadId: snapshot.nativeThreadId, scope: snapshot.scope, sha256: snapshot.sha256,
    recordCount: snapshot.recordCount, byteLength: snapshot.byteLength, offset: options.offset, records,
    nextOffset: null, endOfFile: false, sourceAuthenticated: false, publishable: false, semanticHistoryComplete: false };
  // Reserve the maximum envelope/comma budget; final serialized size is also
  // checked. A byte-limited page advances only across records actually returned.
  let size = 1024, cursor = options.offset;
  while (cursor < entry.boundaries.length && records.length < options.limit) {
    const row = rawRecord(entry.bytes, entry.boundaries[cursor], cursor), rowSize = Buffer.byteLength(JSON.stringify(row)) + 1;
    if (size + rowSize > LIMITS.pageBytes) break;
    records.push(row); size += rowSize; cursor++;
  }
  if (!records.length && cursor !== entry.boundaries.length) return unavailable("rollout_record_limit");
  result.endOfFile = cursor === entry.boundaries.length;
  result.nextOffset = result.endOfFile ? null : cursor;
  if (Buffer.byteLength(JSON.stringify(result)) > LIMITS.pageBytes) return unavailable("rollout_page_limit");
  return result;
}
function releaseRolloutSnapshot(snapshot) {
  const entry = snapshots.get(snapshot);
  if (!entry) return false;
  snapshots.delete(snapshot); entry.bytes.fill(0); entry.boundaries.length = 0;
  // Previously returned detached text belongs to its caller; no wipe guarantee.
  return true;
}
module.exports = { createRolloutSnapshot, observeRolloutNameIdentity, readRolloutPage, releaseRolloutSnapshot, LIMITS };
