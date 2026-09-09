"use strict";
// Host-private v4 framing. Consistency/cleanup evidence, not a source grant or
// final native name. Never infer SQLite's root from the rollout's codexRoot.
const path = require("node:path"), crypto = require("node:crypto");
const { canonicalJSON } = require("../../../public/modules/projection");
const VERSION = "0.153.4", SQLITE_VERSION = "3.53.4";
function createWire(withContext, withCatalog = false) {
  const payloadBytes = (withCatalog ? 2064 : withContext ? 208 : 144) * 1024;
  const LIMITS = Object.freeze({ inputBytes: 12 * 1024, payloadBytes, textBytes: 32 * 1024,
    outputBytes: 4 + 16 * 1024 + payloadBytes, readBytes: 8 * 1024 * 1024, readCalls: 1024, mapBytes: 8 * 1024 * 1024, maps: 256,
    ...(withCatalog ? { catalogBytes: 2 * 1024 * 1024, entries: 2048 } : {}) });
  const keys = (v, names) => v !== null && typeof v === "object" && !Array.isArray(v) && Object.keys(v).sort().join(",") === [...names].sort().join(",");
  const own = (v, allowed) => v && typeof v === "object" && [Object.prototype, null].includes(Object.getPrototypeOf(v))
    && !Object.getOwnPropertySymbols(v).length && Object.entries(Object.getOwnPropertyDescriptors(v)).every(([k, d]) => allowed.includes(k) && Object.hasOwn(d, "value") && d.enumerable);
  const uuid = v => typeof v === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(v);
  const hash = v => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
  const u64 = v => typeof v === "string" && /^(0|[1-9]\d{0,19})$/.test(v) && BigInt(v) <= 18446744073709551615n;
  const rootIdentity = v => keys(v, ["device", "inode"]) && u64(v.device) && u64(v.inode) && v.inode !== "0";
  const digest = v => crypto.createHash("sha256").update(v).digest("hex");
  const count = (v, max, min = 0) => Number.isSafeInteger(v) && v >= min && v <= max;
  function detach(value, limit = LIMITS.inputBytes) {
    try { const json = canonicalJSON(value, limit); return json === null ? null : JSON.parse(json); } catch { return null; }
  }
  function input(v) {
    return keys(v, ["nativeVersion", "source", "expectedRoot"]) && v.nativeVersion === VERSION && rootIdentity(v.expectedRoot)
      && keys(v.source, withCatalog ? ["sqliteRoot"] : ["sqliteRoot", "threadId"]) && (withCatalog || uuid(v.source.threadId))
      && typeof v.source.sqliteRoot === "string" && v.source.sqliteRoot.isWellFormed() && Buffer.byteLength(v.source.sqliteRoot) <= 8192
      && path.isAbsolute(v.source.sqliteRoot) && path.resolve(v.source.sqliteRoot) === v.source.sqliteRoot
      && path.parse(v.source.sqliteRoot).root !== v.source.sqliteRoot && !/[\u0000-\u001f\u007f*?\[\]{},]/.test(v.source.sqliteRoot);
  }
  function identities(v) {
    return Array.isArray(v) && v.length === 3 && ["database", "wal", "shm"].every((role, i) => keys(v[i], ["role", "device", "inode"])
      && v[i].role === role && rootIdentity({ device: v[i].device, inode: v[i].inode }))
      && new Set(v.map(x => `${x.device}:${x.inode}`)).size === 3;
  }
  function fields(v, id) {
    const text = s => typeof s === "string" && s.isWellFormed() && Buffer.byteLength(s) <= LIMITS.textBytes;
    return v === null || keys(v, ["id", "history_mode", "title", "first_user_message", "name"]) && v.id === id
      && ["legacy", "paginated"].includes(v.history_mode) && text(v.title) && text(v.first_user_message) && (v.name === null || text(v.name));
  }
  function catalog(o) {
    if (!keys(o, ["kind", "nativeVersion", "sqliteVersion", "scope", "entries", "sourceAuthenticated", "publishable", "connectionClosed"])
      || o.kind !== "codex_sqlite_catalog_observation" || o.nativeVersion !== VERSION || o.sqliteVersion !== SQLITE_VERSION
      || o.scope !== "provided_state_database_all_stored_threads" || o.sourceAuthenticated !== false || o.publishable !== false || o.connectionClosed !== true
      || !Array.isArray(o.entries) || o.entries.length > LIMITS.entries) return false;
    const integer = v => typeof v === "string" && /^(0|-?[1-9]\d{0,18})$/.test(v) && BigInt(v) >= -9223372036854775808n && BigInt(v) <= 9223372036854775807n;
    const text = (v, size) => typeof v === "string" && v.isWellFormed() && Buffer.byteLength(v) <= size;
    const valid = o.entries.every((e, i) => keys(e, ["id", "rolloutPath", "source", "historyMode", "archived", "createdAt", "updatedAt", "createdAtMs", "updatedAtMs"])
      && uuid(e.id) && (!i || o.entries[i - 1].id < e.id) && text(e.rolloutPath, 8192) && text(e.source, 4096)
      && ["legacy", "paginated"].includes(e.historyMode) && typeof e.archived === "boolean" && integer(e.createdAt) && integer(e.updatedAt)
      && (e.createdAtMs === null || integer(e.createdAtMs)) && (e.updatedAtMs === null || integer(e.updatedAtMs)));
    // This private validator sees only JSON.parse output (decode or detach).
    // Exact recursive fields above already exclude hooks/unknown values; do
    // not walk/copy the entire 2 MiB object again merely to check encoded size.
    return valid && Buffer.byteLength(JSON.stringify(o)) <= LIMITS.catalogBytes;
  }
  function body(v, id) {
    if (!keys(v, ["observation", "identities", "filesystemChecksPassed", "sourceDescriptorsClosed", "sqliteDescriptorsOpened", "sqliteDescriptorsClosed",
      "shmMappingsClosed", "requestedReadBytes", "readCalls", "mappedShmBytes", "sourceAuthenticated", "publishable"])) return false;
    const o = v.observation;
    const context = o?.nameContext;
    if (withContext && (o?.fields === null ? context !== null : !keys(context, ["rolloutPath", "preview"])
      || typeof context.rolloutPath !== "string" || !context.rolloutPath.isWellFormed() || Buffer.byteLength(context.rolloutPath) > 8192
      || typeof context.preview !== "string" || !context.preview.isWellFormed() || Buffer.byteLength(context.preview) > LIMITS.textBytes)) return false;
    return (withCatalog ? catalog(o) : keys(o, ["kind", "nativeVersion", "sqliteVersion", "scope", "fields", "nativeTitleResolved", "sourceAuthenticated", "publishable", "connectionClosed", ...(withContext ? ["nameContext"] : [])])
      && o.kind === "codex_sqlite_metadata_observation" && o.nativeVersion === VERSION && o.sqliteVersion === SQLITE_VERSION
      && o.scope === (withContext ? "provided_connection_selected_name_context_only" : "provided_connection_selected_name_fields_only") && fields(o.fields, id) && o.nativeTitleResolved === false
      && o.sourceAuthenticated === false && o.publishable === false && o.connectionClosed === true)
      && identities(v.identities) && v.filesystemChecksPassed === true && v.sourceDescriptorsClosed === 4
      && v.sqliteDescriptorsOpened === 3 && v.sqliteDescriptorsClosed === 3 && count(v.shmMappingsClosed, LIMITS.maps)
      && count(v.requestedReadBytes, LIMITS.readBytes, 1) && count(v.readCalls, LIMITS.readCalls, 1) && count(v.mappedShmBytes, LIMITS.mapBytes)
      && (v.shmMappingsClosed === 0 ? v.mappedShmBytes === 0 : v.mappedShmBytes >= v.shmMappingsClosed)
      && v.sourceAuthenticated === false && v.publishable === false;
  }
  function header(v, job) {
    return keys(v, ["kind", "nativeVersion", ...(withCatalog ? [] : ["threadId"]), "expectedRoot", "byteLength", "sha256", "sourceAuthenticated", "publishable"])
      && v.kind === (withCatalog ? "native_sqlite_catalog" : withContext ? "native_sqlite_name_context" : "native_sqlite_metadata") && v.nativeVersion === VERSION && v.nativeVersion === job.nativeVersion
      && (withCatalog || uuid(v.threadId) && v.threadId === job.source.threadId) && rootIdentity(v.expectedRoot)
      && v.expectedRoot.device === job.expectedRoot.device && v.expectedRoot.inode === job.expectedRoot.inode
      && count(v.byteLength, LIMITS.payloadBytes, 1) && hash(v.sha256) && v.sourceAuthenticated === false && v.publishable === false;
  }
  function decode(result, payload, job) {
    if (!header(result, job) || !Buffer.isBuffer(payload) || payload.length !== result.byteLength || digest(payload) !== result.sha256
      || payload[0] === 0xef && payload[1] === 0xbb && payload[2] === 0xbf) return null;
    let value;
    try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(payload)); } catch { return null; }
    if ((!withCatalog && canonicalJSON(value, LIMITS.payloadBytes) === null) || !body(value, job.source.threadId)) return null;
    return { ...result, metadata: value, cleanupConfirmed: true };
  }
  function capture(value, request) {
    const v = detach(value, LIMITS.payloadBytes + 16 * 1024);
    if (!v || v.cleanupConfirmed !== true || !Object.hasOwn(v, "metadata")) return null;
    const { metadata, cleanupConfirmed, ...h } = v;
    // Revalidate injected helper output. The original payload digest cannot be
    // recreated from reserialized JSON; decode() already checked the wire bytes.
    return header(h, request) && body(metadata, request.source.threadId) ? v : null;
  }
  function versionOf(v) {
    const observed = v.metadata.observation;
    if (withCatalog) return { kind: "codex_sqlite_catalog_version", nativeVersion: VERSION, rootIdentity: v.expectedRoot,
      // Fixed field tuples are canonical regardless of incoming JSON key order.
      identities: v.metadata.identities, entriesSha256: digest(JSON.stringify(observed.entries.map(e => [e.id, e.rolloutPath, e.source, e.historyMode,
        e.archived, e.createdAt, e.updatedAt, e.createdAtMs, e.updatedAtMs]))) };
    return { kind: withContext ? "codex_sqlite_name_context_version" : "codex_sqlite_selected_fields_version", nativeVersion: VERSION, threadId: v.threadId,
      rootIdentity: v.expectedRoot, identities: v.metadata.identities, fieldsSha256: digest(canonicalJSON(withContext ? { fields: observed.fields, nameContext: observed.nameContext } : observed.fields)) };
  }
  function sourceVersion(value, request) {
    const v = capture(value, request); return v ? versionOf(v) : null;
  }
  function inspectCapture(value, request) {
    const captured = capture(value, request);
    // Keep validation and version derivation in one synchronous owned scope.
    // Injected results still undergo full detachment; no trust marker/cache.
    return captured ? { captured, version: versionOf(captured) } : null;
  }
  function validVersion(v) {
    if (withCatalog) return keys(v, ["kind", "nativeVersion", "rootIdentity", "identities", "entriesSha256"])
      && v.kind === "codex_sqlite_catalog_version" && v.nativeVersion === VERSION && rootIdentity(v.rootIdentity) && identities(v.identities) && hash(v.entriesSha256);
    return keys(v, ["kind", "nativeVersion", "threadId", "rootIdentity", "identities", "fieldsSha256"])
      && v.kind === (withContext ? "codex_sqlite_name_context_version" : "codex_sqlite_selected_fields_version") && v.nativeVersion === VERSION && uuid(v.threadId)
      && rootIdentity(v.rootIdentity) && identities(v.identities) && hash(v.fieldsSha256);
  }
  function sameSourceVersion(expected, actual) {
    const a = detach(expected), b = detach(actual);
    return validVersion(a) && validVersion(b) && canonicalJSON(a) === canonicalJSON(b);
  }
  return Object.freeze({ VERSION, SQLITE_VERSION, LIMITS, keys, own, detach, input, decode, capture, sourceVersion, sameSourceVersion, inspectCapture });
}
module.exports = { ...createWire(false), context: createWire(true), catalog: createWire(false, true) };
