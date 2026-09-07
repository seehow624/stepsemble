"use strict";
// Validate already bounded, detached JSON. Inert preview shape, NOT authenticity.
const object = v => v !== null && typeof v === "object" && !Array.isArray(v);
const keys = (v, required, optional = []) => object(v) && required.every(k => Object.hasOwn(v, k))
  && Object.keys(v).every(k => required.includes(k) || optional.includes(k));
const uuid = v => typeof v === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(v);
const hash = v => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
const id = v => typeof v === "string" && /^[A-Za-z0-9_.:-]{1,256}$/.test(v);
const text = v => typeof v === "string" && v.length <= 524288;
const nullable = fn => v => v === null || fn(v);
const integer = v => Number.isSafeInteger(v) && v >= 0;
const bool = v => typeof v === "boolean";
const warnings = new Set(["unmapped_block_metadata", "opaque_thinking", "attachment_not_materialized", "tool_request_outside_page",
  "unsupported_content_block", "empty_readback_unverified", "native_parent_gap", "interrupted_message", "native_api_error",
  "unmapped_native_metadata", "compacted_history", "unsupported_system_record", "usage_not_aggregated", "system_records_outside_page",
  "native_attachment_records_unmapped", "tool_result_not_observed", "native_file_history_not_materialized", "native_metadata_not_mapped"]);
function validObservation(v, sessionId, pageLimit, recordCount) {
  if (!keys(v, ["kind", "formatVersion", "sessionId", "messages", "tools", "auxiliaryRecords", "auxiliaryCoverage", "warnings",
    "sourceDigest", "selectionDigest", "coverage", "publishable", "authority"])
    || v.kind !== "history_observation" || v.formatVersion !== 1 || v.sessionId !== sessionId || v.publishable !== false
    || v.coverage !== "sdk_selected_page" || v.auxiliaryCoverage !== "whole_source" || !hash(v.sourceDigest) || !hash(v.selectionDigest)
    || !keys(v.authority, ["sourceAuthenticated", "approvalAcknowledged", "runTerminalObserved", "resumeAllowed"])
    || !Object.values(v.authority).every(x => x === false)
    || !Array.isArray(v.warnings) || v.warnings.length > warnings.size || new Set(v.warnings).size !== v.warnings.length
    || !v.warnings.every(x => warnings.has(x))
    || !Array.isArray(v.messages) || v.messages.length > pageLimit
    || !Array.isArray(v.tools) || v.tools.length > 4000
    || !Array.isArray(v.auxiliaryRecords) || v.auxiliaryRecords.length > recordCount) return false;
  let count = 0;
  function block(b, nested = false) {
    if (++count > 4000 || !object(b) || !hash(b.nativeDigest)) return false;
    const fields = (...extra) => keys(b, ["kind", "nativeDigest", ...extra]);
    switch (b.kind) {
      case "text": return fields("text") && text(b.text);
      case "thinking": return !nested && fields("text", "signaturePresent") && text(b.text) && bool(b.signaturePresent);
      case "redacted_thinking": return !nested && fields();
      case "compaction_boundary": case "unsupported_system": return !nested && fields();
      case "unsupported": return fields("nativeType") && id(b.nativeType);
      case "attachment": return fields("mediaKind", "sourceType", "mediaType", "title") && ["image", "document"].includes(b.mediaKind)
        && id(b.sourceType) && nullable(text)(b.mediaType) && nullable(text)(b.title);
      case "tool_use": return !nested && fields("nativeToolId", "name", "input") && id(b.nativeToolId) && id(b.name) && object(b.input);
      case "tool_result": return !nested && fields("nativeToolId", "isError", "content") && id(b.nativeToolId) && bool(b.isError)
        && Array.isArray(b.content) && b.content.every(child => block(child, true));
      default: return false;
    }
  }
  const ids = new Map();
  for (const m of v.messages) {
    if (!keys(m, ["nativeMessageId", "role", "apiMessageId", "originalTimestamp", "metadata", "blocks", "sourceDigest"],
      m?.role === "assistant" ? ["reportedStopReason"] : []) || !uuid(m.nativeMessageId) || ids.has(m.nativeMessageId)
      || !["user", "assistant", "system"].includes(m.role) || !hash(m.sourceDigest) || !nullable(text)(m.originalTimestamp)
      || (m.role === "assistant" ? !id(m.apiMessageId) || !Object.hasOwn(m, "reportedStopReason") || !nullable(id)(m.reportedStopReason) : m.apiMessageId !== null)
      || !keys(m.metadata, ["aborted", "apiError", "compactSummary", "synthetic"], ["errorCode"])
      || !["aborted", "apiError", "compactSummary", "synthetic"].every(k => nullable(bool)(m.metadata[k]))
      || Object.hasOwn(m.metadata, "errorCode") && !id(m.metadata.errorCode)
      || !Array.isArray(m.blocks) || !m.blocks.every(b => block(b))) return false;
    ids.set(m.nativeMessageId, m);
  }
  const toolIds = new Set();
  const pointer = (p, kind, toolId) => p === null || keys(p, ["messageId", "blockIndex"]) && uuid(p.messageId) && integer(p.blockIndex)
    && ids.get(p.messageId)?.blocks[p.blockIndex]?.kind === kind && ids.get(p.messageId).blocks[p.blockIndex].nativeToolId === toolId;
  for (const t of v.tools) {
    if (!keys(t, ["nativeToolId", "name", "request", "result", "observation", "approvalEvidence"])
      || !id(t.nativeToolId) || toolIds.has(t.nativeToolId) || !nullable(id)(t.name) || t.approvalEvidence !== "unavailable"
      || !["request_only", "request_unavailable", "result_recorded", "error_result_recorded"].includes(t.observation)
      || !pointer(t.request, "tool_use", t.nativeToolId) || !pointer(t.result, "tool_result", t.nativeToolId)) return false;
    toolIds.add(t.nativeToolId);
  }
  const indices = new Set();
  return v.auxiliaryRecords.every(a => {
    if (!keys(a, ["kind", "recordIndex", "nativeType", "scopeEvidence", "referenceIds", "nativeDigest"])
      || !["file_history", "scoped_metadata"].includes(a.kind) || !integer(a.recordIndex) || a.recordIndex >= recordCount || indices.has(a.recordIndex)
      || !id(a.nativeType) || !hash(a.nativeDigest) || !["recorded_session_id", "same_file_message_reference"].includes(a.scopeEvidence)
      || !Array.isArray(a.referenceIds) || a.referenceIds.length > 2 || !a.referenceIds.every(uuid)) return false;
    indices.add(a.recordIndex); return true;
  });
}
module.exports = { validObservation };
