"use strict";
// Bytes-only observation of rust-v0.153.4's legacy session_index.jsonl.
// This index is NOT authoritative over a distinct SQLite title, and cannot
// supply paginated names. No filesystem access, native launch or publication.
const crypto = require("node:crypto");
const { canonicalJSON } = require("../../../public/modules/projection");
const { sourceVersion } = require("./source-wire");
const VERSION = "0.153.4";
const LIMITS = Object.freeze({ inputBytes: 8 * 1024 * 1024, recordBytes: 128 * 1024, records: 65536, nameBytes: 32 * 1024, outputBytes: 128 * 1024 });
const typed = Object.getPrototypeOf(Uint8Array.prototype);
const intrinsic = key => Object.getOwnPropertyDescriptor(typed, key).get;
const bufferOf = intrinsic("buffer"), lengthOf = intrinsic("byteLength"), offsetOf = intrinsic("byteOffset"), tagOf = intrinsic(Symbol.toStringTag);
const unavailable = code => ({ kind: "codex_history_unavailable", code });
const hash = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
// Rust str::trim uses Unicode White_Space, not JS trim's BOM treatment.
const trim = value => value.replace(/^[\u0009-\u000d\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+|[\u0009-\u000d\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+$/g, "");
function uuid(value) {
  if (typeof value !== "string") return null;
  if (value.startsWith("urn:uuid:")) { if (value.length !== 45) return null; value = value.slice(9); }
  else if (value.startsWith("{") && value.endsWith("}")) { if (value.length !== 38) return null; value = value.slice(1, -1); }
  if (/^[a-f0-9]{32}$/i.test(value)) value = `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
  return /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value) ? value.toLowerCase() : null;
}
function json(value, max = 2048) {
  try { const text = canonicalJSON(value, max); return text === null ? null : JSON.parse(text); } catch { return null; }
}
function copyBytes(value) {
  try {
    if (tagOf.call(value) !== "Uint8Array") return null;
    const backing = bufferOf.call(value), length = lengthOf.call(value), offset = offsetOf.call(value);
    if (Object.getPrototypeOf(backing) !== ArrayBuffer.prototype || length > LIMITS.inputBytes) return null;
    const bytes = Buffer.allocUnsafe(length);
    Uint8Array.prototype.set.call(bytes, new Uint8Array(backing, offset, length)); return bytes;
  } catch { return null; }
}
// JSON.parse is used for syntax first. Track only top-level keys afterward:
// serde rejects duplicate known struct fields, whereas JSON.parse takes last.
function duplicateField(text) {
  let depth = 0, key = false; const seen = new Set();
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') {
      const start = i;
      for (i++; i < text.length; i++) { if (text[i] === "\\") i++; else if (text[i] === '"') break; }
      if (depth === 1 && key) {
        const name = JSON.parse(text.slice(start, i + 1)); key = false;
        if (["id", "thread_name", "updated_at"].includes(name)) {
          if (seen.has(name)) return true; seen.add(name);
        }
      }
    } else if (ch === "{" || ch === "[") { depth++; if (depth === 1) key = ch === "{"; }
    else if (ch === "}" || ch === "]") depth--;
    else if (ch === "," && depth === 1) key = true;
  }
  return false;
}
function entry(text) {
  let value;
  try { value = JSON.parse(text); } catch { return null; }
  // Narrow bounded structure; refuse an entire observation if we cannot safely
  // interpret a native-accepted record. Never pick an older name on a limit.
  if (canonicalJSON(value, LIMITS.recordBytes * 4) === null) throw new Error("name_index_record_unsupported");
  if (Array.isArray(value)) {
    if (value.length !== 3) return null;
    value = { id: value[0], thread_name: value[1], updated_at: value[2] };
  } else if (!value || typeof value !== "object" || duplicateField(text)) return null;
  const id = uuid(value.id);
  return id && typeof value.thread_name === "string" && typeof value.updated_at === "string"
    ? { id, name: value.thread_name, updatedAt: value.updated_at } : null;
}
function observeNameIndex(input, parameters) {
  const options = json(parameters);
  if (!options || Object.keys(options).sort().join(",") !== "nativeVersion,threadId" || options.nativeVersion !== VERSION ||
      uuid(options.threadId) !== options.threadId) return unavailable("invalid_envelope_or_version");
  const bytes = input === null ? null : copyBytes(input);
  if (input !== null && bytes === null) return unavailable("invalid_name_index_bytes_or_limit");
  try {
    const result = { kind: "codex_name_index_observation", nativeVersion: VERSION, nativeThreadId: options.threadId,
      scope: "legacy_session_index_only", presence: bytes === null ? "missing" : bytes.length ? "present" : "empty",
      byteLength: bytes?.length ?? 0, sha256: bytes === null ? null : hash(bytes), recordCount: 0,
      rejectedReadRecords: 0, rejectedListRecords: 0, latestEntry: null, readCandidate: null, listCandidate: null,
      nativeTitleResolved: false, sourceAuthenticated: false, publishable: false };
    if (!bytes?.length) return result;
    const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }); let start = 0;
    for (let end = 0; end <= bytes.length; end++) {
      if (end - start > LIMITS.recordBytes) return unavailable("name_index_record_limit");
      if (end < bytes.length && bytes[end] !== 10) continue;
      if (end === start && end === bytes.length) break;
      if (result.recordCount === LIMITS.records) return unavailable("name_index_record_limit");
      const recordIndex = result.recordCount++; let text;
      try { text = decoder.decode(bytes.subarray(start, end)); } catch { return unavailable("name_index_invalid_utf8"); }
      const raw = /^[\t\n\f\r ]*$/.test(text) ? null : entry(text), trimmed = trim(text);
      const batch = trimmed ? (trimmed === text ? raw : entry(trimmed)) : null;
      if (!raw && !/^[\t\n\f\r ]*$/.test(text)) result.rejectedReadRecords++;
      if (!batch && trimmed) result.rejectedListRecords++;
      if (raw?.id === options.threadId) {
        if (Buffer.byteLength(raw.name) > LIMITS.nameBytes) return unavailable("name_index_name_limit");
        result.latestEntry = { name: raw.name, updatedAt: raw.updatedAt, recordIndex, byteOffset: start, byteLength: end - start };
        result.readCandidate = trim(raw.name) ? raw.name : null;
      }
      if (batch?.id === options.threadId && trim(batch.name)) {
        if (Buffer.byteLength(batch.name) > LIMITS.nameBytes) return unavailable("name_index_name_limit");
        result.listCandidate = trim(batch.name);
      }
      start = end + 1;
    }
    return Buffer.byteLength(JSON.stringify(result)) <= LIMITS.outputBytes ? result : unavailable("name_index_output_limit");
  } catch { return unavailable("name_index_record_unsupported"); }
  finally { bytes?.fill(0); }
}
function observeCapturedNameIndex(capture) {
  // The result is Host-private, not a browser-supplied claim of source access.
  // Verify detached bytes against the v3 descriptor again before interpretation.
  const version = sourceVersion(capture);
  if (!version) return unavailable("invalid_codex_capture");
  let fields;
  try { fields = Object.getOwnPropertyDescriptors(capture); } catch { return unavailable("invalid_codex_capture"); }
  if (fields.cleanupConfirmed?.value !== true || !Object.hasOwn(fields.nameIndexBytes ?? {}, "value")) return unavailable("invalid_codex_capture");
  const result = observeNameIndex(fields.nameIndexBytes.value, { nativeVersion: version.nativeVersion, threadId: version.threadId });
  if (result.kind !== "codex_name_index_observation") return result;
  if (result.sha256 !== (version.nameIndex?.sha256 ?? null) || result.byteLength !== (version.nameIndex?.identity.size ?? 0)) return unavailable("name_index_capture_changed");
  const bound = { ...result, sourceVersion: version };
  return Buffer.byteLength(JSON.stringify(bound)) <= LIMITS.outputBytes ? bound : unavailable("name_index_output_limit");
}
module.exports = { observeNameIndex, observeCapturedNameIndex, LIMITS, trimNativeWhitespace: trim };
