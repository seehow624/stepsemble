"use strict";
// Host-private v10 byte scan / v11 complete legacy-envelope validation receipt.
// Not a native-semantic history DTO,
// HTTP schema, source grant or replacement for the legacy raw parser contracts.
const crypto = require("node:crypto");
const { canonicalJSON } = require("../../../public/modules/projection");
const legacy = require("./source-wire");
const LIMITS = Object.freeze({ sourceBytes: 256 * 1024 * 1024, records: 262144, recordBytes: 128 * 1024,
  pageRecords: 50, pageBytes: 256 * 1024, indexBytes: legacy.LIMITS.indexBytes,
  outputBytes: 4 + 16 * 1024 + 256 * 1024 + legacy.LIMITS.indexBytes });
const keys = (v, names) => v !== null && typeof v === "object" && !Array.isArray(v) && Object.keys(v).sort().join(",") === [...names].sort().join(",");
const integer = (v, min, max) => Number.isSafeInteger(v) && v >= min && v <= max;
const hash = v => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
const digest = v => crypto.createHash("sha256").update(v).digest("hex");
const u64 = v => typeof v === "string" && /^(0|[1-9]\d{0,19})$/.test(v) && BigInt(v) <= 18446744073709551615n;
const decimal = v => typeof v === "string" && /^(0|[1-9]\d{0,29})$/.test(v);
const rootIdentity = v => keys(v, ["device", "inode"]) && u64(v.device) && u64(v.inode) && v.inode !== "0";
const identity = (v, min, max, root) => keys(v, ["device", "inode", "size", "mtimeNs", "ctimeNs"])
  && rootIdentity({ device: v.device, inode: v.inode }) && v.device === root.device
  && integer(v.size, min, max) && decimal(v.mtimeNs) && decimal(v.ctimeNs);
function detach(value) { try { const json = canonicalJSON(value, 16 * 1024); return json === null ? null : JSON.parse(json); } catch { return null; } }
function input(v) {
  return keys(v, ["nativeVersion", "source", "expectedRoot", "page"])
    && legacy.input({ nativeVersion: v.nativeVersion, source: v.source, expectedRoot: v.expectedRoot })
    && keys(v.page, ["offset", "limit"]) && integer(v.page.offset, 0, LIMITS.records) && integer(v.page.limit, 1, LIMITS.pageRecords);
}
function context(v) {
  return v.nativeVersion === legacy.VERSION && legacy.locator(v.rolloutPath, v.threadId) && rootIdentity(v.rootIdentity)
    && keys(v.storage, ["encoding", "rolloutPath"]) && v.storage.encoding === "jsonl"
    && v.storage.rolloutPath === v.rolloutPath.replace(/\.zst$/, "");
}
function rollout(v, root) {
  return keys(v, ["identity", "sha256", "recordCount"]) && hash(v.sha256) && identity(v.identity, 1, LIMITS.sourceBytes, root)
    && integer(v.recordCount, 1, LIMITS.records) && v.recordCount <= v.identity.size && v.identity.size <= v.recordCount * LIMITS.recordBytes;
}
function index(v, root, selected, offset, framed) {
  return v === null || keys(v, ["identity", "sha256", ...(framed ? ["byteOffset", "byteLength"] : [])])
    && hash(v.sha256) && identity(v.identity, 0, LIMITS.indexBytes, root) && v.identity.inode !== selected.identity.inode
    && (!framed || v.byteOffset === offset && v.byteLength === v.identity.size);
}
function checks(v) {
  return keys(v, ["owner", "acl", "containment", "reads", "matchingRolloutDigests", "matchingNameIndexBytes", "unchangedObservedIdentity", "nameIndexPresenceRechecked", "rolloutSelectionRechecked"])
    && v.owner === "posix_euid_and_mode" && v.acl === "no_extended_acl" && v.containment === "root_identity_and_openat_nofollow"
    && v.reads === 2 && ["matchingRolloutDigests", "matchingNameIndexBytes", "unchangedObservedIdentity", "nameIndexPresenceRechecked", "rolloutSelectionRechecked"].every(k => v[k] === true);
}
function validation(v, count) {
  return keys(v, ["profile", "recordsValidated", "selectedMetadataRecord", "metadataRecords", "historyMode"])
    && v.profile === "codex_legacy_envelope_v1" && v.recordsValidated === count && v.historyMode === "legacy"
    && integer(v.selectedMetadataRecord, 0, count - 1) && integer(v.metadataRecords, 1, count - v.selectedMetadataRecord);
}
function metadata(v, validated = false) {
  if (!keys(v, ["kind", "nativeVersion", "threadId", "rolloutPath", "rootIdentity", "storage", "byteLength", "sha256", "rollout", "page", "nameIndex", "checks",
    "recordSemanticsValidated", "semanticHistoryComplete", "sourceAuthenticated", "publishable", ...(validated ? ["validation"] : [])])
    || v.kind !== (validated ? "native_codex_validated_source_page" : "native_codex_source_page") || !context(v) || !rollout(v.rollout, v.rootIdentity)
    || validated && !validation(v.validation, v.rollout.recordCount)
    || !keys(v.page, ["offset", "byteLength", "records", "nextOffset"]) || !integer(v.page.offset, 0, v.rollout.recordCount)
    || !integer(v.page.byteLength, 0, LIMITS.pageBytes) || !Array.isArray(v.page.records) || v.page.records.length > LIMITS.pageRecords
    || !index(v.nameIndex, v.rootIdentity, v.rollout, v.page.byteLength, true)
    || v.byteLength !== v.page.byteLength + (v.nameIndex?.byteLength ?? 0) || !hash(v.sha256) || !checks(v.checks)
    || v.recordSemanticsValidated !== false || v.semanticHistoryComplete !== false || v.sourceAuthenticated !== false || v.publishable !== false) return false;
  const end = v.page.offset + v.page.records.length, eof = end === v.rollout.recordCount;
  if (end > v.rollout.recordCount || v.page.nextOffset !== (eof ? null : end) || !eof && !v.page.records.length) return false;
  let payloadOffset = 0, byteEnd = null;
  for (const [i, r] of v.page.records.entries()) {
    if (!keys(r, ["recordIndex", "byteOffset", "byteLength", "payloadOffset", "sha256"]) || r.recordIndex !== v.page.offset + i
      || !integer(r.byteLength, 1, LIMITS.recordBytes) || !integer(r.byteOffset, r.recordIndex, r.recordIndex * LIMITS.recordBytes)
      || r.byteOffset + r.byteLength > v.rollout.identity.size || r.payloadOffset !== payloadOffset
      || byteEnd !== null && r.byteOffset !== byteEnd || !hash(r.sha256)) return false;
    payloadOffset += r.byteLength; byteEnd = r.byteOffset + r.byteLength;
  }
  const remaining = v.rollout.recordCount - end;
  return payloadOffset === v.page.byteLength && (byteEnd === null || integer(v.rollout.identity.size - byteEnd, remaining, remaining * LIMITS.recordBytes));
}
function decode(v, payload, job) {
  if (![10, 11].includes(job.protocolVersion) || !input({ nativeVersion: job.nativeVersion, source: job.source, expectedRoot: job.expectedRoot, page: job.page })
    || !metadata(v, job.protocolVersion === 11) || !Buffer.isBuffer(payload) || payload.length !== v.byteLength || digest(payload) !== v.sha256
    || v.nativeVersion !== job.nativeVersion || v.threadId !== job.source.threadId || v.rolloutPath !== job.source.rolloutPath
    || v.rootIdentity.device !== job.expectedRoot.device || v.rootIdentity.inode !== job.expectedRoot.inode
    || v.page.offset !== job.page.offset || v.page.records.length > job.page.limit) return null;
  for (const r of v.page.records) {
    const bytes = payload.subarray(r.payloadOffset, r.payloadOffset + r.byteLength);
    if (digest(bytes) !== r.sha256 || bytes.at(-1) !== 10 || bytes.indexOf(10) !== bytes.length - 1) return null;
  }
  const pageBytes = payload.subarray(0, v.page.byteLength), nameIndexBytes = payload.subarray(v.page.byteLength);
  if (v.nameIndex !== null && digest(nameIndexBytes) !== v.nameIndex.sha256) return null;
  // Digest of the ENTIRE source is not re-derived from a single page. It is a
  // structurally checked, trusted-helper observation, never native provenance.
  return { ...v, pageBytes: Buffer.from(pageBytes), nameIndexBytes: v.nameIndex === null ? null : Buffer.from(nameIndexBytes), cleanupConfirmed: true };
}
function sourceVersion(result) {
  let header;
  try {
    if (!result || ![Object.prototype, null].includes(Object.getPrototypeOf(result)) || Object.getOwnPropertySymbols(result).length) return null;
    const props = Object.getOwnPropertyDescriptors(result);
    if (Object.values(props).some(d => !Object.hasOwn(d, "value") || !d.enumerable)) return null;
    header = Object.fromEntries(Object.entries(props).filter(([k]) => !["pageBytes", "nameIndexBytes", "cleanupConfirmed"].includes(k)).map(([k, d]) => [k, d.value]));
  } catch { return null; }
  const v = detach(header), validated = v?.kind === "native_codex_validated_source_page"; if (!metadata(v, validated)) return null;
  return { kind: validated ? "codex_validated_source_version" : "codex_scanned_source_version", nativeVersion: v.nativeVersion, threadId: v.threadId, rolloutPath: v.rolloutPath,
    rootIdentity: v.rootIdentity, storage: v.storage, rollout: v.rollout,
    ...(validated ? { validation: v.validation } : {}),
    nameIndex: v.nameIndex === null ? null : { identity: v.nameIndex.identity, sha256: v.nameIndex.sha256 } };
}
function validVersion(v) {
  const validated = v?.kind === "codex_validated_source_version";
  return keys(v, ["kind", "nativeVersion", "threadId", "rolloutPath", "rootIdentity", "storage", "rollout", "nameIndex", ...(validated ? ["validation"] : [])])
    && v.kind === (validated ? "codex_validated_source_version" : "codex_scanned_source_version") && context(v) && rollout(v.rollout, v.rootIdentity)
    && (!validated || validation(v.validation, v.rollout.recordCount)) && index(v.nameIndex, v.rootIdentity, v.rollout, null, false);
}
function sameSourceVersion(a, b) { a = detach(a); b = detach(b); return validVersion(a) && validVersion(b) && canonicalJSON(a) === canonicalJSON(b); }
module.exports = { LIMITS, input, decode, sourceVersion, sameSourceVersion };
