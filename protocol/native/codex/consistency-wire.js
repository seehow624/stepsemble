"use strict";
// Host-private protocol 17. This is an observation-only cross-check over
// already captured protocol 15/16 data. It never accepts source paths or
// authority flags as proof and never returns transcript bytes.
const { canonicalJSON } = require("../../../public/modules/projection");
const paginatedWire = require("./paginated-resolution-wire");
const checkpointWire = require("./checkpoint-wire");

const VERSION = "0.153.4";
const PROTOCOL_VERSION = 17;
const MAX_DEPTH = 64;
const SOURCE_BYTES = 256 * 1024 * 1024;
const LIMITS = Object.freeze({ inputBytes: 512 * 1024, headerBytes: 256 * 1024, outputBytes: 4 + 256 * 1024,
  pathBytes: 160, textBytes: 256 });
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const keys = (value, names) => object(value) && Object.keys(value).sort().join(",") === [...names].sort().join(",");
const uuid = value => typeof value === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
const decimal = value => typeof value === "string" && /^(0|[1-9]\d{0,19})$/.test(value) && BigInt(value) <= 18446744073709551615n;
const text = value => typeof value === "string" && value.isWellFormed() && value.length <= LIMITS.textBytes
  && !/[\u0000-\u001f\u007f]/.test(value);
const count = (value, max, min = 0) => Number.isSafeInteger(value) && value >= min && value <= max;
const unavailable = code => ({ kind: "source_unavailable", code });

function detach(value, limit = LIMITS.headerBytes) {
  try { const json = canonicalJSON(value, limit); return json === null ? null : JSON.parse(json); } catch { return null; }
}

function locatorInfo(value) {
  if (typeof value !== "string" || value.length === 0 || Buffer.byteLength(value) > LIMITS.pathBytes) return null;
  const parts = value.split("/"), file = parts.length === 5 && parts[0] === "sessions" ? parts[4]
    : parts.length === 2 && parts[0] === "archived_sessions" ? parts[1] : null;
  const match = file && /^rollout-(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})-([a-f0-9-]{36})(?:_([a-f0-9-]{36}))?\.jsonl(?:\.zst)?$/.exec(file);
  if (!match) return null;
  const year = Number(match[1]), month = Number(match[2]), day = Number(match[3]);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
  if (!days || day < 1 || day > days || Number(match[4]) >= 24 || Number(match[5]) >= 60 || Number(match[6]) >= 60
    || parts.length === 5 && (parts[1] !== match[1] || parts[2] !== match[2] || parts[3] !== match[3])) return null;
  return { stableThreadId: match[7], physicalRolloutId: match[8] ?? match[7], compressed: file.endsWith(".zst"), archived: parts[0] === "archived_sessions" };
}

function cutoff(ordinal, offset) {
  return ordinal === null && offset === null || decimal(ordinal) && decimal(offset) && BigInt(ordinal) > 0n && BigInt(offset) >= 0n;
}

function planSource(value) {
  return keys(value, ["rolloutId", "rolloutPath", "compressed", "archived", "endOrdinalExclusive", "endByteOffset"])
    && uuid(value.rolloutId) && locatorInfo(value.rolloutPath)?.physicalRolloutId === value.rolloutId
    && value.compressed === locatorInfo(value.rolloutPath).compressed && value.archived === locatorInfo(value.rolloutPath).archived
    && cutoff(value.endOrdinalExclusive, value.endByteOffset);
}

function resolvedSource(value, planned) {
  const names = ["rolloutId", "rolloutPath", "compressed", "archived", "decodedBytes", "storedBytes", "recordCount", "endOrdinalExclusive", "endByteOffset"];
  const evidenceNames = ["rolloutId", "rolloutPath", "compressed", "archived", "decodedBytes", "storedBytes", "recordCount",
    "completeLfEndByteOffset", "nextOrdinalExclusive", "endOrdinalExclusive", "endByteOffset"];
  const hasNativeEvidence = keys(value, evidenceNames);
  return (keys(value, names) || hasNativeEvidence)
    && uuid(value.rolloutId) && value.rolloutId === planned.rolloutId && value.rolloutPath === planned.rolloutPath
    && value.compressed === planned.compressed && value.archived === planned.archived
    && decimal(value.decodedBytes) && BigInt(value.decodedBytes) > 0n && BigInt(value.decodedBytes) <= BigInt(SOURCE_BYTES)
    && decimal(value.storedBytes) && BigInt(value.storedBytes) > 0n && BigInt(value.storedBytes) <= BigInt(SOURCE_BYTES)
    && count(value.recordCount, 262144, 1) && value.endOrdinalExclusive === planned.endOrdinalExclusive && value.endByteOffset === planned.endByteOffset
    && (!hasNativeEvidence || paginatedWire.validResolvedEvidence(value));
}

function plan(value, threadId, selectedRolloutId) {
  return keys(value, ["profile", "threadId", "sources", "reachedRoot", "chainByteBudget", "chainDecodedByteBudget", "sourceAuthenticated", "historyComplete"])
    && value.profile === "codex_paginated_chain_plan_v1" && value.threadId === threadId && Array.isArray(value.sources)
    && value.sources.length >= 1 && value.sources.length <= MAX_DEPTH && value.sources.every(planSource)
    && new Set(value.sources.map(source => source.rolloutId)).size === value.sources.length
    && new Set(value.sources.map(source => source.rolloutPath)).size === value.sources.length
    && value.sources.at(-1).rolloutId === selectedRolloutId && value.sources.at(-1).endOrdinalExclusive === null
    && value.sources.at(-1).endByteOffset === null && value.chainByteBudget === SOURCE_BYTES
    && value.chainDecodedByteBudget === SOURCE_BYTES && typeof value.reachedRoot === "boolean"
    && value.sourceAuthenticated === false && value.historyComplete === false;
}

function resolution(value, selectedPlan) {
  return keys(value, ["profile", "threadId", "sources", "chainStoredBytes", "chainDecodedBytes", "ordinalCutoffsVerified", "reachedRoot", "sourceAuthenticated", "historyComplete"])
    && value.profile === "codex_paginated_resolution_v1" && value.threadId === selectedPlan.threadId && Array.isArray(value.sources)
    && value.sources.length === selectedPlan.sources.length && decimal(value.chainStoredBytes) && BigInt(value.chainStoredBytes) > 0n
    && BigInt(value.chainStoredBytes) <= BigInt(SOURCE_BYTES) && decimal(value.chainDecodedBytes) && BigInt(value.chainDecodedBytes) > 0n
    && BigInt(value.chainDecodedBytes) <= BigInt(SOURCE_BYTES) && value.ordinalCutoffsVerified === true
    && value.reachedRoot === selectedPlan.reachedRoot && value.sourceAuthenticated === false && value.historyComplete === false
    && value.sources.every((source, index) => resolvedSource(source, selectedPlan.sources[index]));
}

function selected(value, threadId, headPath) {
  return keys(value, ["id", "rolloutPath", "source", "historyMode", "archived", "createdAt", "updatedAt", "createdAtMs", "updatedAtMs"])
    && value.id === threadId && value.rolloutPath === headPath && uuid(value.id) && locatorInfo(value.rolloutPath)?.stableThreadId === threadId
    && value.historyMode === "paginated" && typeof value.archived === "boolean" && text(value.source) && text(value.createdAt) && text(value.updatedAt)
    && (value.createdAtMs === null || text(value.createdAtMs)) && (value.updatedAtMs === null || text(value.updatedAtMs));
}

function projection(value, threadId) {
  const point = value?.checkpoint;
  return keys(value, ["kind", "nativeVersion", "threadId", "checkpoint", "sourceAuthenticated", "publishable", "historyComplete", "connectionClosed"])
    && value.kind === "codex_paginated_projection_checkpoint" && value.nativeVersion === VERSION && value.threadId === threadId && uuid(threadId)
    && (point === null || keys(point, ["nextRolloutByteOffset", "nextRolloutOrdinal"]) && decimal(point.nextRolloutByteOffset) && decimal(point.nextRolloutOrdinal))
    && value.sourceAuthenticated === false && value.publishable === false && value.historyComplete === false && value.connectionClosed === true;
}

function evidence(value, resolutionValue) {
  return Array.isArray(value) && value.length === resolutionValue.sources.length && value.length <= MAX_DEPTH && value.every((item, index) => {
    const source = resolutionValue.sources[index];
    return keys(item, ["rolloutId", "decodedBytes", "completeLfEndByteOffset", "nextOrdinalExclusive"]) && item.rolloutId === source.rolloutId
      && item.decodedBytes === source.decodedBytes && decimal(item.completeLfEndByteOffset) && decimal(item.nextOrdinalExclusive)
      && BigInt(item.completeLfEndByteOffset) <= BigInt(item.decodedBytes) && BigInt(item.nextOrdinalExclusive) > 0n;
  });
}

function input(value) {
  if (!keys(value, ["nativeVersion", "selected", "plan", "resolution", "projection", "evidence"]) || value.nativeVersion !== VERSION
    || !object(value.plan) || !object(value.resolution) || !object(value.projection)) return false;
  const threadId = value.plan.threadId, head = value.plan.sources?.at(-1);
  return uuid(threadId) && plan(value.plan, threadId, head?.rolloutId) && resolution(value.resolution, value.plan)
    && selected(value.selected, threadId, head.rolloutPath) && projection(value.projection, head.rolloutId) && evidence(value.evidence, value.resolution);
}

function consistency(value, threadId) {
  return keys(value, ["profile", "threadId", "selectedRolloutId", "projectionThreadId", "projectionNextRolloutByteOffset", "projectionNextRolloutOrdinal", "durableSources", "sourceAuthenticated", "publishable", "historyComplete"])
    && value.profile === "codex_paginated_consistency_v1" && value.threadId === threadId && uuid(value.threadId) && uuid(value.selectedRolloutId)
    && uuid(value.projectionThreadId) && decimal(value.projectionNextRolloutByteOffset) && decimal(value.projectionNextRolloutOrdinal)
    && Array.isArray(value.durableSources) && value.durableSources.length >= 1 && value.durableSources.length <= MAX_DEPTH
    && value.durableSources.every(item => keys(item, ["rolloutId", "decodedBytes", "completeLfEndByteOffset", "nextOrdinalExclusive"])
      && uuid(item.rolloutId) && decimal(item.decodedBytes) && decimal(item.completeLfEndByteOffset) && decimal(item.nextOrdinalExclusive))
    && value.sourceAuthenticated === false && value.publishable === false && value.historyComplete === false;
}

function header(value, job) {
  return keys(value, ["kind", "nativeVersion", "threadId", "consistency", "sourceAuthenticated", "publishable", "historyComplete"])
    && value.kind === "native_codex_paginated_consistency" && value.nativeVersion === VERSION && value.threadId === job.threadId
    && consistency(value.consistency, job.threadId) && value.sourceAuthenticated === false && value.publishable === false && value.historyComplete === false;
}

function decode(result, payload, job) {
  if (!header(result, job) || !Buffer.isBuffer(payload) || payload.length !== 0) return null;
  return { ...result, cleanupConfirmed: true };
}

function capture(value, request) {
  const detached = detach(value);
  if (!detached || detached.cleanupConfirmed !== true) return null;
  const { cleanupConfirmed, ...headerValue } = detached;
  return header(headerValue, { threadId: request.plan.threadId }) ? detached : null;
}

function checkpointObservation(value, threadId) {
  return keys(value, ["kind", "nativeVersion", "sqliteVersion", "scope", "threadId", "checkpoint", "turns", "itemCount", "maxItemOrdinal",
    "sourceAuthenticated", "publishable", "historyComplete", "connectionClosed"])
    && value.kind === "codex_paginated_projection_checkpoint" && value.nativeVersion === VERSION && value.sqliteVersion === "3.53.4"
    && value.scope === "provided_history_database_selected_thread_projection_only" && value.threadId === threadId && uuid(threadId)
    && (value.checkpoint === null || keys(value.checkpoint, ["nextRolloutByteOffset", "nextRolloutOrdinal"])
      && decimal(value.checkpoint.nextRolloutByteOffset) && decimal(value.checkpoint.nextRolloutOrdinal))
    && Array.isArray(value.turns) && value.turns.length <= 2048 && decimal(value.itemCount)
    && (value.maxItemOrdinal === null || decimal(value.maxItemOrdinal)) && value.sourceAuthenticated === false
    && value.publishable === false && value.historyComplete === false && value.connectionClosed === true;
}

function validBoundConsistency(value, sessionId, request = {}) {
  if (!keys(value, ["kind", "bindingId", "generation", "requestId", "selectedRolloutId", "resolutionVersion", "checkpointVersion",
    "plan", "resolution", "checkpoint", "consistency", "aggregation", "historyComplete", "sourceAuthenticated", "publishable", "cleanupConfirmed"])) return false;
  const planValue = value.plan;
  return value.kind === "bound_codex_paginated_consistency" && uuid(value.bindingId) && count(value.generation, Number.MAX_SAFE_INTEGER, 1)
    && uuid(value.requestId) && (request.bindingId === undefined || value.bindingId === request.bindingId)
    && (request.generation === undefined || value.generation === request.generation) && (request.requestId === undefined || value.requestId === request.requestId)
    && uuid(sessionId) && uuid(value.selectedRolloutId) && paginatedWire.validVersion(value.resolutionVersion)
    && value.resolutionVersion.threadId === sessionId && value.resolutionVersion.selectedRolloutId === value.selectedRolloutId
    && checkpointWire.validVersion(value.checkpointVersion) && value.checkpointVersion.threadId === value.selectedRolloutId
    && plan(planValue, sessionId, value.selectedRolloutId) && resolution(value.resolution, planValue)
    && checkpointObservation(value.checkpoint, value.selectedRolloutId) && consistency(value.consistency, sessionId)
    && value.consistency.selectedRolloutId === value.selectedRolloutId && value.consistency.projectionThreadId === value.selectedRolloutId
    && value.aggregation === "cross_observation_non_atomic" && value.historyComplete === false
    && value.sourceAuthenticated === false && value.publishable === false && value.cleanupConfirmed === true;
}

module.exports = Object.freeze({ VERSION, PROTOCOL_VERSION, LIMITS, keys, detach, input, decode, capture, consistency, validBoundConsistency, unavailable });
