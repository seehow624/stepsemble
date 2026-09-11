"use strict";
// Host-private protocol 16. This is a bounded observation of Codex's separate
// thread_history_1.sqlite projection. It is deliberately not history content,
// an authentication grant, or proof of an atomic state/history snapshot.
const path = require("node:path");
const crypto = require("node:crypto");
const { canonicalJSON } = require("../../../public/modules/projection");

const VERSION = "0.153.4";
const SQLITE_VERSION = "3.53.4";
const PROTOCOL_VERSION = 16;
const LIMITS = Object.freeze({
  inputBytes: 12 * 1024,
  headerBytes: 16 * 1024,
  payloadBytes: 128 * 1024,
  outputBytes: 4 + 16 * 1024 + 128 * 1024,
  readBytes: 8 * 1024 * 1024,
  readCalls: 1024,
  mapBytes: 8 * 1024 * 1024,
  maps: 256,
  turns: 2048,
  idBytes: 256,
  textBytes: 256,
});

const keys = (value, names) => value !== null && typeof value === "object" && !Array.isArray(value)
  && Object.keys(value).sort().join(",") === [...names].sort().join(",");
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const uuid = value => typeof value === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
const hash = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const u64 = value => typeof value === "string" && /^(0|[1-9]\d{0,19})$/.test(value)
  && BigInt(value) <= 18446744073709551615n;
const i64 = value => typeof value === "string" && /^(0|-?[1-9]\d{0,18})$/.test(value)
  && BigInt(value) >= -9223372036854775808n && BigInt(value) <= 9223372036854775807n;
const rootIdentity = value => keys(value, ["device", "inode"]) && u64(value.device) && u64(value.inode) && value.inode !== "0";
const count = (value, max, min = 0) => Number.isSafeInteger(value) && value >= min && value <= max;
const text = (value, max = LIMITS.textBytes) => typeof value === "string" && value.isWellFormed()
  && Buffer.byteLength(value) <= max && !/[\u0000-\u001f\u007f]/.test(value);
const id = value => text(value, LIMITS.idBytes) && value.length > 0;
const digest = value => crypto.createHash("sha256").update(value).digest("hex");
const unavailable = code => ({ kind: "source_unavailable", code });

function detach(value, limit = LIMITS.payloadBytes) {
  try {
    const json = canonicalJSON(value, limit);
    return json === null ? null : JSON.parse(json);
  } catch {
    return null;
  }
}

function input(value) {
  if (!keys(value, ["nativeVersion", "source", "expectedRoot"]) || value.nativeVersion !== VERSION
    || !rootIdentity(value.expectedRoot) || !keys(value.source, ["sqliteRoot", "threadId"])
    || !uuid(value.source.threadId) || typeof value.source.sqliteRoot !== "string"
    || !value.source.sqliteRoot.isWellFormed() || Buffer.byteLength(value.source.sqliteRoot) > 8192
    || !path.isAbsolute(value.source.sqliteRoot) || path.resolve(value.source.sqliteRoot) !== value.source.sqliteRoot
    || path.parse(value.source.sqliteRoot).root === value.source.sqliteRoot
    || /[\u0000-\u001f\u007f*?\[\]{},]/.test(value.source.sqliteRoot)) return false;
  return true;
}

function identityList(value) {
  const roles = ["database", "wal", "shm"];
  return Array.isArray(value) && value.length === roles.length && roles.every((role, index) => {
    const item = value[index];
    return keys(item, ["role", "device", "inode"]) && item.role === role
      && rootIdentity({ device: item.device, inode: item.inode });
  }) && new Set(value.map(item => `${item.device}:${item.inode}`)).size === roles.length;
}

function checkpoint(value) {
  return value === null || keys(value, ["nextRolloutByteOffset", "nextRolloutOrdinal"])
    && i64(value.nextRolloutByteOffset) && i64(value.nextRolloutOrdinal)
    && BigInt(value.nextRolloutByteOffset) >= 0n && BigInt(value.nextRolloutOrdinal) >= 0n;
}

function turn(value) {
  return keys(value, ["turnId", "status", "rolloutOrdinal", "rolloutByteOffset", "rolloutEndOrdinal",
    "rolloutEndByteOffset", "firstUserItemId", "finalAgentItemId"])
    && id(value.turnId) && text(value.status) && i64(value.rolloutOrdinal)
    && BigInt(value.rolloutOrdinal) >= 0n
    && (value.rolloutByteOffset === null || i64(value.rolloutByteOffset))
    && (value.rolloutEndOrdinal === null || i64(value.rolloutEndOrdinal))
    && (value.rolloutEndByteOffset === null || i64(value.rolloutEndByteOffset))
    && (value.firstUserItemId === null || id(value.firstUserItemId))
    && (value.finalAgentItemId === null || id(value.finalAgentItemId));
}

function observation(value, threadId) {
  if (!keys(value, ["kind", "nativeVersion", "sqliteVersion", "scope", "threadId", "checkpoint", "turns",
    "itemCount", "maxItemOrdinal", "sourceAuthenticated", "publishable", "historyComplete", "connectionClosed"])
    || value.kind !== "codex_paginated_projection_checkpoint" || value.nativeVersion !== VERSION
    || value.sqliteVersion !== SQLITE_VERSION || value.scope !== "provided_history_database_selected_thread_projection_only"
    || value.threadId !== threadId || !uuid(value.threadId) || !checkpoint(value.checkpoint)
    || !Array.isArray(value.turns) || value.turns.length > LIMITS.turns || !value.turns.every(turn)
    || !i64(value.itemCount) || BigInt(value.itemCount) < 0n
    || (value.maxItemOrdinal !== null && (!i64(value.maxItemOrdinal) || BigInt(value.maxItemOrdinal) < 0n))
    || value.sourceAuthenticated !== false || value.publishable !== false
    || value.historyComplete !== false || value.connectionClosed !== true) return false;
  return true;
}

function body(value, threadId) {
  return keys(value, ["observation", "identities", "filesystemChecksPassed", "sourceDescriptorsClosed",
    "sqliteDescriptorsOpened", "sqliteDescriptorsClosed", "shmMappingsClosed", "requestedReadBytes",
    "readCalls", "mappedShmBytes", "sourceAuthenticated", "publishable"])
    && observation(value.observation, threadId) && identityList(value.identities)
    && value.filesystemChecksPassed === true && value.sourceDescriptorsClosed === 4
    && value.sqliteDescriptorsOpened === 3 && value.sqliteDescriptorsClosed === 3
    && count(value.shmMappingsClosed, LIMITS.maps) && count(value.requestedReadBytes, LIMITS.readBytes, 1)
    && count(value.readCalls, LIMITS.readCalls, 1) && count(value.mappedShmBytes, LIMITS.mapBytes)
    && (value.shmMappingsClosed === 0 ? value.mappedShmBytes === 0 : value.mappedShmBytes >= value.shmMappingsClosed)
    && value.sourceAuthenticated === false && value.publishable === false;
}

function header(value, job) {
  return keys(value, ["kind", "nativeVersion", "threadId", "expectedRoot", "byteLength", "sha256",
    "sourceAuthenticated", "publishable"])
    && value.kind === "native_sqlite_paginated_checkpoint" && value.nativeVersion === VERSION
    && value.nativeVersion === job.nativeVersion && uuid(value.threadId) && value.threadId === job.source.threadId
    && rootIdentity(value.expectedRoot) && value.expectedRoot.device === job.expectedRoot.device
    && value.expectedRoot.inode === job.expectedRoot.inode && count(value.byteLength, LIMITS.payloadBytes, 1)
    && hash(value.sha256) && value.sourceAuthenticated === false && value.publishable === false;
}

function decode(result, payload, job) {
  if (!header(result, job) || !Buffer.isBuffer(payload) || payload.length !== result.byteLength
    || digest(payload) !== result.sha256 || payload[0] === 0xef && payload[1] === 0xbb && payload[2] === 0xbf) return null;
  let value;
  try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(payload)); } catch { return null; }
  if (canonicalJSON(value, LIMITS.payloadBytes) === null || !body(value, job.source.threadId)) return null;
  return { ...result, metadata: value, cleanupConfirmed: true };
}

function capture(value, request) {
  const detached = detach(value);
  if (!detached || detached.cleanupConfirmed !== true || !Object.hasOwn(detached, "metadata")) return null;
  const { metadata, cleanupConfirmed, ...headerValue } = detached;
  return header(headerValue, request) && body(metadata, request.source.threadId) ? detached : null;
}

function sourceVersion(value) {
  const captured = detach(value);
  if (!captured || !captured.cleanupConfirmed || !body(captured.metadata, captured.threadId)
    || !rootIdentity(captured.expectedRoot)) return null;
  const observationValue = captured.metadata.observation;
  const canonical = canonicalJSON(observationValue, LIMITS.payloadBytes);
  if (canonical === null) return null;
  return { kind: "codex_paginated_projection_checkpoint_version", nativeVersion: VERSION,
    threadId: captured.threadId, rootIdentity: { ...captured.expectedRoot }, identities: captured.metadata.identities,
    checkpointSha256: digest(canonical) };
}

function validVersion(value) {
  return keys(value, ["kind", "nativeVersion", "threadId", "rootIdentity", "identities", "checkpointSha256"])
    && value.kind === "codex_paginated_projection_checkpoint_version" && value.nativeVersion === VERSION
    && uuid(value.threadId) && rootIdentity(value.rootIdentity) && identityList(value.identities)
    && hash(value.checkpointSha256);
}

function sameSourceVersion(expected, actual) {
  const a = detach(expected), b = detach(actual);
  return validVersion(a) && validVersion(b) && canonicalJSON(a) === canonicalJSON(b);
}

// Bound responses are the only shape that may cross the Host registry. Keep
// this validator separate from `capture`: a valid native frame is not, by
// itself, proof that it belongs to a particular binding or request.
function validBoundCheckpoint(value, sessionId, expected = {}) {
  const detached = detach(value, LIMITS.payloadBytes);
  if (!detached || !keys(detached, ["kind", "bindingId", "generation", "requestId", "sourceVersion", "checkpoint", "evidence",
    "consistency", "snapshotAtomic", "historyComplete", "sourceAuthenticated", "publishable", "cleanupConfirmed"])
    || detached.kind !== "bound_codex_paginated_checkpoint" || !uuid(detached.bindingId)
    || !count(detached.generation, Number.MAX_SAFE_INTEGER, 1) || !uuid(detached.requestId)
    || expected.bindingId !== undefined && detached.bindingId !== expected.bindingId
    || expected.generation !== undefined && detached.generation !== expected.generation
    || expected.requestId !== undefined && detached.requestId !== expected.requestId
    || !validVersion(detached.sourceVersion) || detached.sourceVersion.threadId !== sessionId
    || !observation(detached.checkpoint, sessionId) || !body(detached.evidence, sessionId)
    // Keep the public projection and the retained evidence bound to the same
    // observation. A shape-valid but divergent pair would otherwise let a
    // caller choose the checkpoint while inspecting unrelated evidence.
    || canonicalJSON(detached.checkpoint, LIMITS.payloadBytes) !== canonicalJSON(detached.evidence.observation, LIMITS.payloadBytes)
    || (() => {
      const canonical = canonicalJSON(detached.checkpoint, LIMITS.payloadBytes);
      return canonical === null || detached.sourceVersion.checkpointSha256 !== digest(canonical);
    })()
    || detached.consistency !== "single_history_database_observation" || detached.snapshotAtomic !== false
    || detached.historyComplete !== false || detached.sourceAuthenticated !== false || detached.publishable !== false
    || detached.cleanupConfirmed !== true) return false;
  return true;
}

module.exports = { VERSION, SQLITE_VERSION, PROTOCOL_VERSION, LIMITS, keys, detach, input, decode, capture,
  sourceVersion, sameSourceVersion, validVersion, validBoundCheckpoint };
