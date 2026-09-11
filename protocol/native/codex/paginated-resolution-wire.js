"use strict";
// Host-private protocol 15. This is a bounded ancestry/resolution receipt,
// not a transcript, source grant, native-authentication proof, or HTTP DTO.
// The native helper returns the plan and the observed source sizes only after
// every planned rollout has been opened through its held-FD boundary.
const crypto = require("node:crypto");
const path = require("node:path");
const { canonicalJSON } = require("../../../public/modules/projection");

const VERSION = "0.153.4";
const PROTOCOL_VERSION = 15;
const MAX_DEPTH = 64;
const RECORD_BYTES = 128 * 1024;
const SOURCE_BYTES = 256 * 1024 * 1024;
const RECORDS = 262144;
const LIMITS = Object.freeze({
  inputBytes: 16 * 1024 * 1024,
  headerBytes: 64 * 1024,
  outputBytes: 4 + 64 * 1024,
  pathBytes: 160,
  base64Bytes: 4 * Math.ceil(RECORD_BYTES / 3),
  recordBytes: RECORD_BYTES,
  maxDepth: MAX_DEPTH,
  sourceBytes: SOURCE_BYTES,
  records: RECORDS,
});

const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const keys = (value, names) => object(value) && Object.keys(value).sort().join(",") === [...names].sort().join(",");
const uuid = value => typeof value === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
const hash = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const decimal = value => typeof value === "string" && /^(0|[1-9]\d{0,29})$/.test(value);
const u64 = value => typeof value === "string" && /^(0|[1-9]\d{0,19})$/.test(value)
  && BigInt(value) <= 18446744073709551615n;
const rootIdentity = value => keys(value, ["device", "inode"]) && u64(value.device) && u64(value.inode) && value.inode !== "0";
const count = (value, max, min = 0) => Number.isSafeInteger(value) && value >= min && value <= max;
const wellFormed = value => typeof value === "string" && value.isWellFormed();
const digest = value => crypto.createHash("sha256").update(value).digest("hex");
const unavailable = code => ({ kind: "source_unavailable", code });

function detach(value, limit = LIMITS.headerBytes) {
  try {
    const json = canonicalJSON(value, limit);
    return json === null ? null : JSON.parse(json);
  } catch {
    return null;
  }
}

function timestamp(year, month, day, hour, minute, second) {
  const y = Number(year), m = Number(month), d = Number(day);
  const leap = y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1];
  return !!days && d >= 1 && d <= days && Number(hour) < 24 && Number(minute) < 60 && Number(second) < 60;
}

// Keep this in lockstep with the native codex_locator module. The returned
// stable/physical split is needed for reverted heads and reverted ancestors.
function locatorInfo(value) {
  if (typeof value !== "string" || value.length === 0 || Buffer.byteLength(value) > LIMITS.pathBytes) return null;
  const parts = value.split("/");
  const file = parts.length === 5 && parts[0] === "sessions"
    ? parts[4] : parts.length === 2 && parts[0] === "archived_sessions" ? parts[1] : null;
  if (!file || !wellFormed(value)) return null;
  const match = /^rollout-(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})-([a-f0-9-]{36})(?:_([a-f0-9-]{36}))?\.jsonl(?:\.zst)?$/.exec(file);
  if (!match || !timestamp(...match.slice(1, 7))) return null;
  const stableThreadId = match[7], physicalRolloutId = match[8] ?? match[7];
  if (!uuid(stableThreadId) || !uuid(physicalRolloutId)) return null;
  if (parts.length === 5 && (parts[1] !== match[1] || parts[2] !== match[2] || parts[3] !== match[3])) return null;
  return { stableThreadId, physicalRolloutId, compressed: file.endsWith(".zst"), archived: parts[0] === "archived_sessions" };
}

function canonicalBase64(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > LIMITS.base64Bytes
    || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) return false;
  let bytes;
  try { bytes = Buffer.from(value, "base64"); } catch { return false; }
  return bytes.length >= 1 && bytes.length <= LIMITS.recordBytes && bytes.toString("base64") === value;
}

function entry(value, index, threadId = null) {
  if (!keys(value, ["rolloutId", "base64Record", "rolloutPath"]) || !uuid(value.rolloutId)
    || !canonicalBase64(value.base64Record)) return false;
  const info = locatorInfo(value.rolloutPath);
  if (!info || info.physicalRolloutId !== value.rolloutId) return false;
  // The selected head is named by the stable thread ID. Ancestors carry their
  // own stable prefix (which may differ after a revert).
  return index !== 0 || threadId === null || info.stableThreadId === threadId;
}

// The registry/service accepts this smaller selection envelope and supplies
// the already-authorized root identity and native version. It is intentionally
// not a filesystem or source-grant DTO.
function selection(value) {
  return keys(value, ["selectedRolloutId", "entries"]) && uuid(value.selectedRolloutId)
    && Array.isArray(value.entries) && value.entries.length >= 1 && value.entries.length <= MAX_DEPTH
    && value.selectedRolloutId === value.entries[0]?.rolloutId
    && value.entries.every((item, index) => entry(item, index))
    && new Set(value.entries.map(item => item.rolloutId)).size === value.entries.length
    && new Set(value.entries.map(item => item.rolloutPath)).size === value.entries.length;
}

function input(value) {
  if (!keys(value, ["nativeVersion", "codexRoot", "expectedRoot", "threadId", "selectedRolloutId", "entries"])
    || value.nativeVersion !== VERSION || !rootIdentity(value.expectedRoot)
    || !wellFormed(value.codexRoot) || Buffer.byteLength(value.codexRoot) > 8192
    || !path.isAbsolute(value.codexRoot) || path.resolve(value.codexRoot) !== value.codexRoot
    || path.parse(value.codexRoot).root === value.codexRoot || /[\u0000-\u001f\u007f*?\[\]{},]/.test(value.codexRoot)
    || !uuid(value.threadId) || !uuid(value.selectedRolloutId) || !Array.isArray(value.entries)
    || value.entries.length < 1 || value.entries.length > MAX_DEPTH
    || value.selectedRolloutId !== value.entries[0]?.rolloutId
    || !value.entries.every((item, index) => entry(item, index, value.threadId))
    || !selection({ selectedRolloutId: value.selectedRolloutId, entries: value.entries })) return false;
  return true;
}

function cutoff(ordinal, offset) {
  return ordinal === null && offset === null || decimal(ordinal) && decimal(offset)
    && BigInt(ordinal) > 0n && BigInt(offset) >= 0n;
}

function sourceShape(value, resolved = false) {
  const names = resolved
    ? ["rolloutId", "rolloutPath", "compressed", "archived", "decodedBytes", "storedBytes", "recordCount", "endOrdinalExclusive", "endByteOffset"]
    : ["rolloutId", "rolloutPath", "compressed", "archived", "endOrdinalExclusive", "endByteOffset"];
  if (!keys(value, names) || !uuid(value.rolloutId) || !wellFormed(value.rolloutPath)) return false;
  const info = locatorInfo(value.rolloutPath);
  if (!info || info.physicalRolloutId !== value.rolloutId || value.compressed !== info.compressed || value.archived !== info.archived
    || !cutoff(value.endOrdinalExclusive, value.endByteOffset)) return false;
  if (!resolved) return true;
  return u64(value.decodedBytes) && BigInt(value.decodedBytes) > 0n && BigInt(value.decodedBytes) <= BigInt(SOURCE_BYTES)
    && u64(value.storedBytes) && BigInt(value.storedBytes) > 0n && BigInt(value.storedBytes) <= BigInt(SOURCE_BYTES)
    && count(value.recordCount, RECORDS, 1);
}

function planShape(value, threadId, selectedRolloutId) {
  if (!keys(value, ["profile", "threadId", "sources", "reachedRoot", "chainByteBudget", "chainDecodedByteBudget", "sourceAuthenticated", "historyComplete"])
    || value.profile !== "codex_paginated_chain_plan_v1" || value.threadId !== threadId || !Array.isArray(value.sources)
    || value.sources.length < 1 || value.sources.length > MAX_DEPTH || !value.sources.every(item => sourceShape(item))
    || new Set(value.sources.map(item => item.rolloutId)).size !== value.sources.length
    || new Set(value.sources.map(item => item.rolloutPath)).size !== value.sources.length
    || value.sources.at(-1)?.rolloutId !== selectedRolloutId
    || value.sources.at(-1)?.endOrdinalExclusive !== null || value.sources.at(-1)?.endByteOffset !== null
    || value.chainByteBudget !== SOURCE_BYTES || value.chainDecodedByteBudget !== SOURCE_BYTES
    || typeof value.reachedRoot !== "boolean" || value.sourceAuthenticated !== false || value.historyComplete !== false) return false;
  return true;
}

function resolutionShape(value, plan) {
  if (!keys(value, ["profile", "threadId", "sources", "chainStoredBytes", "chainDecodedBytes", "ordinalCutoffsVerified", "reachedRoot", "sourceAuthenticated", "historyComplete"])
    || value.profile !== "codex_paginated_resolution_v1" || value.threadId !== plan.threadId || !Array.isArray(value.sources)
    || value.sources.length !== plan.sources.length || !u64(value.chainStoredBytes) || !u64(value.chainDecodedBytes)
    || BigInt(value.chainStoredBytes) < 1n || BigInt(value.chainStoredBytes) > BigInt(SOURCE_BYTES)
    || BigInt(value.chainDecodedBytes) < 1n || BigInt(value.chainDecodedBytes) > BigInt(SOURCE_BYTES)
    || value.ordinalCutoffsVerified !== true || value.reachedRoot !== plan.reachedRoot
    || value.sourceAuthenticated !== false || value.historyComplete !== false) return false;
  let stored = 0n, decoded = 0n;
  for (const [index, item] of value.sources.entries()) {
    const planned = plan.sources[index];
    if (!sourceShape(item, true) || item.rolloutId !== planned.rolloutId || item.rolloutPath !== planned.rolloutPath
      || item.compressed !== planned.compressed || item.archived !== planned.archived
      || item.endOrdinalExclusive !== planned.endOrdinalExclusive || item.endByteOffset !== planned.endByteOffset) return false;
    stored += BigInt(item.storedBytes); decoded += BigInt(item.decodedBytes);
    if (stored > BigInt(SOURCE_BYTES) || decoded > BigInt(SOURCE_BYTES)) return false;
    if (item.endByteOffset !== null && BigInt(item.endByteOffset) > BigInt(item.decodedBytes)) return false;
  }
  return stored === BigInt(value.chainStoredBytes) && decoded === BigInt(value.chainDecodedBytes);
}

function header(value, job) {
  return keys(value, ["kind", "nativeVersion", "threadId", "expectedRoot", "plan", "resolution", "sourceAuthenticated", "publishable", "historyComplete"])
    && value.kind === "native_codex_paginated_resolution" && value.nativeVersion === VERSION
    && value.nativeVersion === job.nativeVersion && uuid(value.threadId) && value.threadId === job.threadId
    && rootIdentity(value.expectedRoot) && rootIdentity(job.expectedRoot)
    && value.expectedRoot.device === job.expectedRoot.device && value.expectedRoot.inode === job.expectedRoot.inode
    && planShape(value.plan, job.threadId, job.selectedRolloutId) && resolutionShape(value.resolution, value.plan)
    && value.sourceAuthenticated === false && value.publishable === false && value.historyComplete === false;
}

function decode(result, payload, job) {
  if (!header(result, job) || !Buffer.isBuffer(payload) || payload.length !== 0) return null;
  return { ...result, cleanupConfirmed: true };
}

function capture(value, request) {
  const detached = detach(value, LIMITS.headerBytes);
  if (!detached || detached.cleanupConfirmed !== true) return null;
  const { cleanupConfirmed, ...headerValue } = detached;
  const job = { protocolVersion: PROTOCOL_VERSION, nativeVersion: request.nativeVersion, threadId: request.threadId,
    selectedRolloutId: request.selectedRolloutId, expectedRoot: request.expectedRoot };
  return header(headerValue, job) ? detached : null;
}

function sourceVersion(value) {
  const detached = detach(value, LIMITS.headerBytes);
  if (!detached || detached.cleanupConfirmed !== true) return null;
  const { cleanupConfirmed, ...headerValue } = detached;
  const job = { protocolVersion: PROTOCOL_VERSION, nativeVersion: headerValue.nativeVersion,
    threadId: headerValue.threadId, selectedRolloutId: headerValue.plan?.sources?.at(-1)?.rolloutId,
    expectedRoot: headerValue.expectedRoot };
  if (!header(headerValue, job)) return null;
  const planCanonical = canonicalJSON(headerValue.plan, LIMITS.headerBytes);
  const resolutionCanonical = canonicalJSON(headerValue.resolution, LIMITS.headerBytes);
  if (planCanonical === null || resolutionCanonical === null) return null;
  return { kind: "codex_paginated_resolution_version", nativeVersion: VERSION, threadId: headerValue.threadId,
    rootIdentity: { ...headerValue.expectedRoot },
    selectedRolloutId: job.selectedRolloutId, planSha256: digest(planCanonical), resolutionSha256: digest(resolutionCanonical),
    sourceCount: headerValue.plan.sources.length, reachedRoot: headerValue.plan.reachedRoot };
}

function validVersion(value) {
  return keys(value, ["kind", "nativeVersion", "threadId", "rootIdentity", "selectedRolloutId", "planSha256", "resolutionSha256", "sourceCount", "reachedRoot"])
    && value.kind === "codex_paginated_resolution_version" && value.nativeVersion === VERSION && uuid(value.threadId)
    && rootIdentity(value.rootIdentity)
    && uuid(value.selectedRolloutId) && hash(value.planSha256) && hash(value.resolutionSha256)
    && count(value.sourceCount, MAX_DEPTH, 1) && typeof value.reachedRoot === "boolean";
}

function sameSourceVersion(expected, actual) {
  const a = detach(expected), b = detach(actual);
  return validVersion(a) && validVersion(b) && canonicalJSON(a) === canonicalJSON(b);
}

function validBoundResolution(value, sessionId, scope = {}) {
  if (!keys(value, ["kind", "bindingId", "generation", "requestId", "selectedRolloutId", "sourceVersion", "plan", "resolution",
    "consistency", "historyComplete", "sourceAuthenticated", "publishable", "cleanupConfirmed"])) return false;
  return value.kind === "bound_codex_paginated_resolution" && uuid(value.bindingId) && count(value.generation, Number.MAX_SAFE_INTEGER, 1)
    && uuid(value.requestId) && (scope.bindingId === undefined || value.bindingId === scope.bindingId)
    && (scope.generation === undefined || value.generation === scope.generation)
    && (scope.requestId === undefined || value.requestId === scope.requestId)
    && uuid(sessionId) && uuid(value.selectedRolloutId) && validVersion(value.sourceVersion)
    && value.sourceVersion.threadId === sessionId && value.sourceVersion.selectedRolloutId === value.selectedRolloutId
    && planShape(value.plan, sessionId, value.selectedRolloutId) && resolutionShape(value.resolution, value.plan)
    && value.consistency === "single_codex_paginated_resolution_observation" && value.historyComplete === false
    && value.sourceAuthenticated === false && value.publishable === false && value.cleanupConfirmed === true;
}

module.exports = Object.freeze({ VERSION, PROTOCOL_VERSION, LIMITS, keys, detach, input, locatorInfo,
  selection, decode, capture, sourceVersion, sameSourceVersion, validVersion, validBoundResolution, validResolution: value => {
    const detached = detach(value);
    if (!detached || detached.cleanupConfirmed !== true) return false;
    const { cleanupConfirmed, ...headerValue } = detached;
    const job = { protocolVersion: PROTOCOL_VERSION, nativeVersion: headerValue.nativeVersion,
      threadId: headerValue.threadId, selectedRolloutId: headerValue.plan?.sources?.at(-1)?.rolloutId,
      expectedRoot: headerValue.expectedRoot };
    return header(headerValue, job);
  }, unavailable });
