"use strict";
// Host-private v13/v14 receipts. Physical zstd identity and decoded JSONL
// coordinates are deliberately different types; neither is native provenance.
const crypto = require("node:crypto"), path = require("node:path");
const { canonicalJSON } = require("../../../public/modules/projection");
const legacy = require("./source-wire"), scanned = require("./scanned-source-wire"), structure = require("./structured-source-wire");
const PROFILE = structure.PROFILE;
const LIMITS = Object.freeze({ ...scanned.LIMITS, headerBytes: 16 * 1024, physicalBytes: 256 * 1024 * 1024,
  decodedBytes: 256 * 1024 * 1024, windowBytes: 8 * 1024 * 1024, frames: 256, blocks: 65536,
  structureBytes: structure.LIMITS.structureBytes, outputBytes: structure.LIMITS.outputBytes });
const object = v => v !== null && typeof v === "object" && !Array.isArray(v);
const keys = (v, names) => object(v) && Object.keys(v).sort().join(",") === [...names].sort().join(",");
const integer = (v, min, max) => Number.isSafeInteger(v) && v >= min && v <= max;
const hash = v => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
const digest = v => crypto.createHash("sha256").update(v).digest("hex");
const u64 = v => typeof v === "string" && /^(0|[1-9]\d{0,19})$/.test(v) && BigInt(v) <= 18446744073709551615n;
const decimal = v => typeof v === "string" && /^(0|[1-9]\d{0,29})$/.test(v);
const rootIdentity = v => keys(v, ["device", "inode"]) && u64(v.device) && u64(v.inode) && v.inode !== "0";
const identity = (v, min, max, root) => keys(v, ["device", "inode", "size", "mtimeNs", "ctimeNs"])
  && rootIdentity({ device: v.device, inode: v.inode }) && v.device === root.device
  && integer(v.size, min, max) && decimal(v.mtimeNs) && decimal(v.ctimeNs);
function detach(v, limit = LIMITS.headerBytes) {
  try { const json = canonicalJSON(v, limit); return json === null ? null : JSON.parse(json); } catch { return null; }
}
const headerKeys = global => ["kind", "nativeVersion", "threadId", "rolloutPath", "rootIdentity", "storage", "byteLength", "sha256", "physical", "decoded",
  "page", "nameIndex", "checks", "validation", "recordSemanticsValidated", "semanticHistoryComplete", "sourceAuthenticated", "publishable",
  ...(global ? ["structureFrame"] : [])];
const versionKeys = global => ["kind", "nativeVersion", "threadId", "rolloutPath", "rootIdentity", "storage", "physical", "decoded", "validation", "nameIndex",
  ...(global ? ["structureProfile"] : [])];
function context(v) {
  return v.nativeVersion === legacy.VERSION && legacy.locator(v.rolloutPath, v.threadId) && rootIdentity(v.rootIdentity)
    && keys(v.storage, ["encoding", "rolloutPath"]) && v.storage.encoding === "zstd"
    && v.storage.rolloutPath === `${v.rolloutPath.replace(/\.zst$/, "")}.zst`
    && keys(v.physical, ["identity", "sha256"]) && hash(v.physical.sha256)
    && identity(v.physical.identity, 1, LIMITS.physicalBytes, v.rootIdentity)
    && keys(v.decoded, ["byteLength", "sha256", "recordCount", "frames"]) && hash(v.decoded.sha256)
    && integer(v.decoded.byteLength, 1, LIMITS.decodedBytes) && integer(v.decoded.recordCount, 1, LIMITS.records)
    && integer(v.decoded.frames, 1, LIMITS.frames) && v.decoded.recordCount <= v.decoded.byteLength
    && v.decoded.byteLength <= v.decoded.recordCount * LIMITS.recordBytes;
}
function index(v, root, physical, offset, framed) {
  return v === null || keys(v, ["identity", "sha256", ...(framed ? ["byteOffset", "byteLength"] : [])])
    && hash(v.sha256) && identity(v.identity, 0, LIMITS.indexBytes, root) && v.identity.inode !== physical.identity.inode
    && (!framed || v.byteOffset === offset && v.byteLength === v.identity.size);
}
function checks(v) {
  const booleans = ["matchingPhysicalDigests", "matchingDecodedDigests", "completeCompressedFrames", "matchingNameIndexBytes", "unchangedObservedIdentity",
    "nameIndexPresenceRechecked", "rolloutSelectionRechecked"];
  return keys(v, ["owner", "acl", "containment", "reads", ...booleans]) && v.owner === "posix_euid_and_mode" && v.acl === "no_extended_acl"
    && v.containment === "root_identity_and_openat_nofollow" && v.reads === 2 && booleans.every(k => v[k] === true);
}
function validation(v, count) {
  return keys(v, ["profile", "recordsValidated", "selectedMetadataRecord", "metadataRecords", "historyMode"])
    && v.profile === "codex_legacy_envelope_v1" && v.recordsValidated === count && v.historyMode === "legacy"
    && integer(v.selectedMetadataRecord, 0, count - 1) && integer(v.metadataRecords, 1, count - v.selectedMetadataRecord);
}
function page(v) {
  const p = v.page, source = v.decoded;
  if (!keys(p, ["offset", "byteLength", "records", "nextOffset"]) || !integer(p.offset, 0, source.recordCount)
    || !integer(p.byteLength, 0, LIMITS.pageBytes) || !Array.isArray(p.records) || p.records.length > LIMITS.pageRecords) return false;
  const end = p.offset + p.records.length, eof = end === source.recordCount;
  if (end > source.recordCount || p.nextOffset !== (eof ? null : end) || !eof && !p.records.length) return false;
  let payloadOffset = 0, byteEnd = null;
  for (const [i, r] of p.records.entries()) {
    if (!keys(r, ["recordIndex", "byteOffset", "byteLength", "payloadOffset", "sha256"]) || r.recordIndex !== p.offset + i
      || !integer(r.byteLength, 1, LIMITS.recordBytes) || !integer(r.byteOffset, r.recordIndex, r.recordIndex * LIMITS.recordBytes)
      || r.byteOffset + r.byteLength > source.byteLength || r.payloadOffset !== payloadOffset
      || byteEnd !== null && r.byteOffset !== byteEnd || !hash(r.sha256)) return false;
    payloadOffset += r.byteLength; byteEnd = r.byteOffset + r.byteLength;
  }
  const remaining = source.recordCount - end;
  return payloadOffset === p.byteLength && (byteEnd === null || integer(source.byteLength - byteEnd, remaining, remaining * LIMITS.recordBytes));
}
function metadata(v, global) {
  if (!keys(v, headerKeys(global)) || v.kind !== (global ? "native_codex_compressed_structured_source_page" : "native_codex_compressed_source_page")
    || !context(v) || !validation(v.validation, v.decoded.recordCount) || !page(v)
    || !index(v.nameIndex, v.rootIdentity, v.physical, v.page.byteLength, true) || !hash(v.sha256) || !checks(v.checks)
    || v.recordSemanticsValidated !== false || v.semanticHistoryComplete !== false || v.sourceAuthenticated !== false || v.publishable !== false) return false;
  const baseLength = v.page.byteLength + (v.nameIndex?.byteLength ?? 0);
  return global ? keys(v.structureFrame, ["profile", "byteOffset", "byteLength", "sha256"]) && v.structureFrame.profile === PROFILE
    && v.structureFrame.byteOffset === baseLength && integer(v.structureFrame.byteLength, 1, LIMITS.structureBytes)
    && hash(v.structureFrame.sha256) && v.byteLength === baseLength + v.structureFrame.byteLength : v.byteLength === baseLength;
}
function decode(value, payload, job, global) {
  const v = detach(value);
  if (job?.protocolVersion !== (global ? 14 : 13) || !scanned.input({ nativeVersion: job.nativeVersion, source: job.source, expectedRoot: job.expectedRoot, page: job.page })
    || !metadata(v, global) || !Buffer.isBuffer(payload) || payload.length !== v.byteLength || digest(payload) !== v.sha256
    || v.nativeVersion !== job.nativeVersion || v.threadId !== job.source.threadId || v.rolloutPath !== job.source.rolloutPath
    || v.rootIdentity.device !== job.expectedRoot.device || v.rootIdentity.inode !== job.expectedRoot.inode
    || v.page.offset !== job.page.offset || v.page.records.length > job.page.limit) return null;
  for (const r of v.page.records) {
    const bytes = payload.subarray(r.payloadOffset, r.payloadOffset + r.byteLength);
    if (digest(bytes) !== r.sha256 || bytes.at(-1) !== 10 || bytes.indexOf(10) !== bytes.length - 1) return null;
  }
  const indexEnd = v.page.byteLength + (v.nameIndex?.byteLength ?? 0), indexBytes = payload.subarray(v.page.byteLength, indexEnd);
  if (v.nameIndex !== null && digest(indexBytes) !== v.nameIndex.sha256) return null;
  let structureBytes, sideband;
  if (global) {
    structureBytes = payload.subarray(indexEnd);
    if (digest(structureBytes) !== v.structureFrame.sha256 || structureBytes[0] === 0xef && structureBytes[1] === 0xbb && structureBytes[2] === 0xbf) return null;
    try { sideband = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(structureBytes)); } catch { return null; }
    sideband = detach(sideband, LIMITS.structureBytes);
    if (!structure.validStructure(sideband, v.page, v.decoded.recordCount)) return null;
  }
  return { ...v, pageBytes: Buffer.from(payload.subarray(0, v.page.byteLength)), nameIndexBytes: v.nameIndex === null ? null : Buffer.from(indexBytes),
    ...(global ? { structureBytes: Buffer.from(structureBytes), structure: sideband } : {}), cleanupConfirmed: true };
}
function sourceVersion(result, global) {
  // No getters, caller copy/byteLength hooks or shared backing stores. The bounded
  // selected bytes are independently rechecked; the full-source hashes are the
  // held-FD helper's two-pass observations, not inferred from this small page.
  let r;
  try {
    if (!object(result) || ![Object.prototype, null].includes(Object.getPrototypeOf(result)) || Object.getOwnPropertySymbols(result).length) return null;
    const fields = Object.getOwnPropertyDescriptors(result), names = [...headerKeys(global), "pageBytes", "nameIndexBytes", "cleanupConfirmed", ...(global ? ["structureBytes", "structure"] : [])];
    if (Object.keys(fields).sort().join(",") !== names.sort().join(",") || Object.values(fields).some(d => !Object.hasOwn(d, "value") || !d.enumerable)) return null;
    r = Object.fromEntries(Object.entries(fields).map(([k, d]) => [k, d.value]));
  } catch { return null; }
  const header = detach(Object.fromEntries(headerKeys(global).map(k => [k, r[k]])));
  if (!metadata(header, global) || r.cleanupConfirmed !== true) return null;
  const typed = Object.getPrototypeOf(Uint8Array.prototype), get = key => Object.getOwnPropertyDescriptor(typed, key).get;
  const view = (value, size) => {
    try {
      if (!Buffer.isBuffer(value) || get("byteLength").call(value) !== size) return null;
      const backing = get("buffer").call(value), offset = get("byteOffset").call(value);
      return Object.getPrototypeOf(backing) === ArrayBuffer.prototype ? new Uint8Array(backing, offset, size) : null;
    } catch { return null; }
  };
  const parts = [view(r.pageBytes, header.page.byteLength), header.nameIndex === null ? null : view(r.nameIndexBytes, header.nameIndex.byteLength),
    global ? view(r.structureBytes, header.structureFrame.byteLength) : null];
  if (!parts[0] || (header.nameIndex === null ? r.nameIndexBytes !== null : !parts[1]) || global && !parts[2]) return null;
  const payload = Buffer.allocUnsafe(header.byteLength); let offset = 0;
  for (const part of parts) if (part) { payload.set(part, offset); offset += part.byteLength; }
  const checked = decode(header, payload, { protocolVersion: global ? 14 : 13, nativeVersion: header.nativeVersion,
    source: { codexRoot: path.join(path.parse(process.execPath).root, `compressed-version-${header.rootIdentity.device}`), rolloutPath: header.rolloutPath, threadId: header.threadId },
    expectedRoot: header.rootIdentity, page: { offset: header.page.offset, limit: Math.max(1, header.page.records.length) } }, global);
  if (!checked || global && canonicalJSON(checked.structure, LIMITS.structureBytes) !== canonicalJSON(r.structure, LIMITS.structureBytes)) return null;
  return { kind: global ? "codex_compressed_structured_source_version" : "codex_compressed_validated_source_version", nativeVersion: checked.nativeVersion,
    threadId: checked.threadId, rolloutPath: checked.rolloutPath, rootIdentity: checked.rootIdentity, storage: checked.storage, physical: checked.physical,
    decoded: checked.decoded, validation: checked.validation, nameIndex: checked.nameIndex === null ? null : { identity: checked.nameIndex.identity, sha256: checked.nameIndex.sha256 },
    ...(global ? { structureProfile: PROFILE } : {}) };
}
function validVersion(v, global) {
  return keys(v, versionKeys(global)) && v.kind === (global ? "codex_compressed_structured_source_version" : "codex_compressed_validated_source_version")
    && context(v) && validation(v.validation, v.decoded.recordCount) && index(v.nameIndex, v.rootIdentity, v.physical, null, false)
    && (!global || v.structureProfile === PROFILE);
}
function sameSourceVersion(a, b, global) {
  a = detach(a); b = detach(b); return validVersion(a, global) && validVersion(b, global) && canonicalJSON(a) === canonicalJSON(b);
}
const api = global => Object.freeze({ PROFILE, LIMITS, input: scanned.input, decode: (v, bytes, job) => decode(v, bytes, job, global),
  sourceVersion: result => sourceVersion(result, global), sameSourceVersion: (a, b) => sameSourceVersion(a, b, global) });
function decodedSummary(value) {
  const v = detach(value); return validVersion(v, false) || validVersion(v, true) ? v.decoded : null;
}
module.exports = { PROFILE, LIMITS, validated: api(false), structured: api(true), decodedSummary };
