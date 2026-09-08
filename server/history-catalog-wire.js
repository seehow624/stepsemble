"use strict";
// Public, bounded metadata contract. No source paths, readers, file identities,
// raw inventory or inferred/native authority. SDK metadata is a separate read.
const exact = (v, names) => v && typeof v === "object" && !Array.isArray(v)
  && Object.keys(v).sort().join() === [...names].sort().join();
const reference = v => typeof v === "string" && /^[A-Za-z0-9:_-]{1,128}$/.test(v);
const uuid = v => typeof v === "string" && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(v);
const count = (v, max) => Number.isSafeInteger(v) && v >= 0 && v <= max;
const text = (v, max, min = 0) => typeof v === "string" && v.length >= min && v.length <= max && !/[\u0000-\u001f\u007f]/.test(v);
function validSources(v) {
  return exact(v, ["kind", "sources", "sourceAuthenticated", "publishable"]) && v.kind === "history_sources"
    && v.sourceAuthenticated === false && v.publishable === false && Array.isArray(v.sources) && v.sources.length <= 8
    && new Set(v.sources.map(g => g?.sourceId)).size === v.sources.length
    && v.sources.every(g => exact(g, ["sourceId", "agentId", "scope", "label", "description"]) && reference(g.sourceId)
      && g.agentId === "claude-code" && g.scope === "main_sessions" && text(g.label, 120, 1) && text(g.description, 300));
}
function validRequest(v) {
  return exact(v, ["sourceId", "page", "snapshotId", "refresh"]) && reference(v.sourceId)
    && exact(v.page, ["offset", "limit"]) && count(v.page.offset, 2048) && count(v.page.limit, 50) && v.page.limit > 0
    && (v.snapshotId === null || uuid(v.snapshotId)) && typeof v.refresh === "boolean"
    && (v.page.offset === 0 || v.snapshotId !== null) && (!v.refresh || v.page.offset === 0 && v.snapshotId === null);
}
function validPage(v, request, codes) {
  return validRequest(request) && exact(v, ["kind", "sourceId", "snapshotId", "stale", "refreshing", "lastError", "total", "page",
    "nextOffset", "entries", "sourceAuthenticated", "publishable"]) && v.kind === "history_source_catalog"
    && v.sourceId === request.sourceId && (v.snapshotId === null || uuid(v.snapshotId))
    && (request.snapshotId === null || request.snapshotId === v.snapshotId) && (!request.refresh || v.snapshotId !== null)
    && typeof v.stale === "boolean" && typeof v.refreshing === "boolean" && (v.lastError === null || codes.has(v.lastError))
    && count(v.total, 2048) && exact(v.page, ["offset", "limit"]) && v.page.offset === request.page.offset && v.page.limit === request.page.limit
    && v.page.offset <= v.total && Array.isArray(v.entries) && v.entries.length === Math.min(v.page.limit, v.total - v.page.offset)
    && v.entries.every(e => exact(e, ["catalogId", "nativeTitle", "titleStatus"]) && typeof e.catalogId === "string" && /^claude-[a-f0-9]{64}$/.test(e.catalogId)
      && e.nativeTitle === null && e.titleStatus === "not_loaded")
    && new Set(v.entries.map(e => e.catalogId)).size === v.entries.length
    && v.nextOffset === (v.page.offset + v.entries.length < v.total ? v.page.offset + v.entries.length : null)
    && (v.snapshotId !== null || v.total === 0 && v.stale === true)
    && v.sourceAuthenticated === false && v.publishable === false;
}
function validMetadataRequest(v) {
  return exact(v, ["sourceId", "catalogId", "snapshotId", "requestId"]) && reference(v.sourceId)
    && typeof v.catalogId === "string" && /^claude-[a-f0-9]{64}$/.test(v.catalogId) && uuid(v.snapshotId) && uuid(v.requestId);
}
function validMetadata(v, request) {
  const metadataText = (v, max) => typeof v === "string" && v.length > 0 && v.length <= max
    && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(v);
  return validMetadataRequest(request) && exact(v, ["kind", "sourceId", "catalogId", "snapshotId", "requestId", "metadata", "sourceAuthenticated", "publishable"])
    && v.kind === "history_source_metadata" && Object.keys(request).every(k => v[k] === request[k])
    && exact(v.metadata, ["sessionId", "nativeTitle", "summary", "titleStatus"]) && uuid(v.metadata.sessionId)
    && (v.metadata.summary === null || metadataText(v.metadata.summary, 4096))
    && (v.metadata.titleStatus === "native" && metadataText(v.metadata.nativeTitle, 1024)
      || v.metadata.titleStatus === "untitled" && v.metadata.nativeTitle === null)
    && v.sourceAuthenticated === false && v.publishable === false;
}
module.exports = { validSources, validRequest, validPage, validMetadataRequest, validMetadata };
