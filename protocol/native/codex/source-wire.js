"use strict";
// Host-private v3 Rust capture, not an HTTP schema or private-source permission.
const path = require("node:path"), crypto = require("node:crypto");
const { canonicalJSON } = require("../../../public/modules/projection");
const VERSION = "0.153.4";
const LIMITS = Object.freeze({ rolloutBytes: 8 * 1024 * 1024, indexBytes: 8 * 1024 * 1024, outputBytes: 4 + 16 * 1024 + 16 * 1024 * 1024 });
const keys = (v, names) => v !== null && typeof v === "object" && !Array.isArray(v) && Object.keys(v).sort().join(",") === [...names].sort().join(",");
const uuid = v => typeof v === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(v);
const hash = v => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
const decimal = v => typeof v === "string" && /^(0|[1-9]\d{0,29})$/.test(v);
const u64 = v => typeof v === "string" && /^(0|[1-9]\d{0,19})$/.test(v) && BigInt(v) <= 18446744073709551615n;
const rootIdentity = v => keys(v, ["device", "inode"]) && u64(v.device) && u64(v.inode) && v.inode !== "0";
const digest = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
function detached(value) {
  try { const json = canonicalJSON(value, 12 * 1024); return json === null ? null : JSON.parse(json); } catch { return null; }
}
function locator(value, threadId) {
  if (typeof value !== "string" || value.length > 160 || !uuid(threadId)) return false;
  const p = value.split("/"), active = p.length === 5 && p[0] === "sessions";
  if (!active && !(p.length === 2 && p[0] === "archived_sessions")) return false;
  const m = /^rollout-(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})-([a-f0-9-]{36})(?:_([a-f0-9-]{36}))?\.jsonl(?:\.zst)?$/.exec(p.at(-1));
  if (!m || m[7] !== threadId || !uuid(m[8] ?? m[7])) return false;
  const year = Number(m[1]), month = Number(m[2]), day = Number(m[3]);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month-1];
  return !!days && day >= 1 && day <= days && Number(m[4]) < 24 && Number(m[5]) < 60 && Number(m[6]) < 60
    && (!active || p.slice(1, 4).every((v, i) => v === m[i+1]));
}
function input(v) {
  return keys(v, ["nativeVersion", "source", "expectedRoot"]) && v.nativeVersion === VERSION && rootIdentity(v.expectedRoot)
    && keys(v.source, ["codexRoot", "threadId", "rolloutPath"]) && locator(v.source.rolloutPath, v.source.threadId)
    && typeof v.source.codexRoot === "string" && v.source.codexRoot.length <= 8192 && path.isAbsolute(v.source.codexRoot)
    && path.resolve(v.source.codexRoot) === v.source.codexRoot && path.parse(v.source.codexRoot).root !== v.source.codexRoot
    && !/[\u0000-\u001f\u007f*?\[\]{},]/.test(v.source.codexRoot);
}
function identity(v, length) {
  return keys(v, ["device", "inode", "size", "mtimeNs", "ctimeNs"]) && rootIdentity({ device: v.device, inode: v.inode })
    && v.size === length && Number.isSafeInteger(length) && length >= 0 && decimal(v.mtimeNs) && decimal(v.ctimeNs);
}
function descriptor(v, offset, device, empty, max) {
  return keys(v, ["byteOffset", "byteLength", "sha256", "identity"]) && v.byteOffset === offset && hash(v.sha256)
    && identity(v.identity, v.byteLength) && v.identity.device === device && v.byteLength >= (empty ? 0 : 1) && v.byteLength <= max;
}
function storage(v) {
  if (!Object.hasOwn(v, "storage")) return !v.rolloutPath.endsWith(".zst");
  const s = v.storage, plain = v.rolloutPath.replace(/\.zst$/, "");
  return keys(s, ["encoding", "rolloutPath"]) && (s.encoding === "jsonl" && s.rolloutPath === plain || s.encoding === "zstd" && s.rolloutPath === plain + ".zst");
}
function checks(v, stored) {
  return keys(v, ["owner", "acl", "containment", "reads", "matchingBytes", "unchangedObservedIdentity", "nameIndexPresenceRechecked", ...(stored ? ["rolloutSelectionRechecked"] : [])])
    && v.owner === "posix_euid_and_mode" && v.acl === "no_extended_acl" && v.containment === "root_identity_and_openat_nofollow"
    && v.reads === 2 && v.matchingBytes === true && v.unchangedObservedIdentity === true && v.nameIndexPresenceRechecked === true && (!stored || v.rolloutSelectionRechecked === true);
}
function metadata(v) {
  const stored = !!v && Object.hasOwn(v, "storage");
  return keys(v, ["kind", "nativeVersion", "threadId", "rolloutPath", "rootIdentity", "byteLength", "sha256", "rollout", "nameIndex", "checks", "sourceAuthenticated", "publishable", ...(stored ? ["storage"] : [])])
    && v.kind === "native_codex_source_bytes" && v.nativeVersion === VERSION && rootIdentity(v.rootIdentity)
    && locator(v.rolloutPath, v.threadId) && storage(v) && hash(v.sha256)
    && descriptor(v.rollout, 0, v.rootIdentity.device, false, LIMITS.rolloutBytes)
    && (v.nameIndex === null || (descriptor(v.nameIndex, v.rollout.byteLength, v.rootIdentity.device, true, LIMITS.indexBytes)
      && v.nameIndex.identity.inode !== v.rollout.identity.inode))
    && v.byteLength === v.rollout.byteLength + (v.nameIndex?.byteLength ?? 0) && checks(v.checks, stored)
    && v.sourceAuthenticated === false && v.publishable === false;
}
function decode(result, payload, job) {
  if (!metadata(result) || Object.hasOwn(result, "storage") !== (job.protocolVersion === 9) || !Buffer.isBuffer(payload) || job.nativeVersion !== result.nativeVersion || job.source.threadId !== result.threadId
    || job.source.rolloutPath !== result.rolloutPath || job.expectedRoot.device !== result.rootIdentity.device || job.expectedRoot.inode !== result.rootIdentity.inode
    || payload.length !== result.byteLength || digest(payload) !== result.sha256) return null;
  const rollout = payload.subarray(0, result.rollout.byteLength), index = payload.subarray(result.rollout.byteLength);
  if (digest(rollout) !== result.rollout.sha256 || (result.nameIndex !== null && digest(index) !== result.nameIndex.sha256)) return null;
  return { ...result, rolloutBytes: Buffer.from(rollout), nameIndexBytes: result.nameIndex === null ? null : Buffer.from(index), cleanupConfirmed: true };
}
function sourceVersion(result) {
  // Do not serialize/copy raw buffers merely to extract a small version fence.
  let header;
  try {
    if (!result || ![Object.prototype, null].includes(Object.getPrototypeOf(result)) || Object.getOwnPropertySymbols(result).length) return null;
    const props = Object.getOwnPropertyDescriptors(result);
    if (Object.values(props).some(d => !Object.hasOwn(d, "value") || !d.enumerable)) return null;
    header = Object.fromEntries(Object.entries(props).filter(([k]) => !["rolloutBytes", "nameIndexBytes", "cleanupConfirmed"].includes(k)).map(([k, d]) => [k, d.value]));
  } catch { return null; }
  const v = detached(header); if (!metadata(v)) return null;
  const version = d => d === null ? null : { sha256: d.sha256, identity: { ...d.identity } };
  return { nativeVersion: v.nativeVersion, threadId: v.threadId, rolloutPath: v.rolloutPath, rootIdentity: { ...v.rootIdentity },
    rollout: version(v.rollout), nameIndex: version(v.nameIndex), ...(v.storage ? { storage: { ...v.storage } } : {}) };
}
function validVersion(v) {
  const part = (p, empty, max) => keys(p, ["sha256", "identity"]) && hash(p.sha256) && identity(p.identity, p.identity?.size)
    && p.identity.size >= (empty ? 0 : 1) && p.identity.size <= max && p.identity.device === v.rootIdentity.device;
  return keys(v, ["nativeVersion", "threadId", "rolloutPath", "rootIdentity", "rollout", "nameIndex", ...(v && Object.hasOwn(v, "storage") ? ["storage"] : [])]) && v.nativeVersion === VERSION
    && locator(v.rolloutPath, v.threadId) && storage(v) && rootIdentity(v.rootIdentity)
    && part(v.rollout, false, LIMITS.rolloutBytes) && (v.nameIndex === null || (part(v.nameIndex, true, LIMITS.indexBytes)
      && v.nameIndex.identity.inode !== v.rollout.identity.inode));
}
function sameSourceVersion(expected, actual) {
  const a = detached(expected), b = detached(actual);
  return validVersion(a) && validVersion(b) && canonicalJSON(a) === canonicalJSON(b);
}
module.exports = { VERSION, LIMITS, input, locator, decode, sourceVersion, sameSourceVersion };
