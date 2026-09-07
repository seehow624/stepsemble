"use strict";
/// <reference path="./lifecycle.ts" />
/** Validate an already bounded, detached Claude history observation.
 * This is an inert preview shape, not an authenticity or authority check. */
var StepsembleClaudeHistoryValue;
(function (StepsembleClaudeHistoryValue) {
    const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
    const array = (value) => Array.isArray(value);
    const keys = (value, required, optional = []) => object(value)
        && required.every(key => Object.hasOwn(value, key))
        && Object.keys(value).every(key => required.includes(key) || optional.includes(key));
    const uuid = (value) => typeof value === "string"
        && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
    const hash = (value) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
    const id = (value) => typeof value === "string" && /^[A-Za-z0-9_.:-]{1,256}$/.test(value);
    const text = (value) => typeof value === "string" && value.length <= 524288;
    const nullable = (predicate) => (value) => value === null || predicate(value);
    const integer = (value) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
    const bool = (value) => typeof value === "boolean";
    const warningNames = new Set([
        "unmapped_block_metadata", "opaque_thinking", "attachment_not_materialized", "tool_request_outside_page",
        "unsupported_content_block", "empty_readback_unverified", "native_parent_gap", "interrupted_message", "native_api_error",
        "unmapped_native_metadata", "compacted_history", "unsupported_system_record", "usage_not_aggregated", "system_records_outside_page",
        "native_attachment_records_unmapped", "tool_result_not_observed", "native_file_history_not_materialized", "native_metadata_not_mapped",
    ]);
    function validObservation(value, sessionId, pageLimit, recordCount) {
        if (!keys(value, ["kind", "formatVersion", "sessionId", "messages", "tools", "auxiliaryRecords", "auxiliaryCoverage", "warnings",
            "sourceDigest", "selectionDigest", "coverage", "publishable", "authority"]))
            return false;
        if (value.kind !== "history_observation" || value.formatVersion !== 1 || value.sessionId !== sessionId || value.publishable !== false
            || value.coverage !== "sdk_selected_page" || value.auxiliaryCoverage !== "whole_source" || !hash(value.sourceDigest) || !hash(value.selectionDigest))
            return false;
        if (!keys(value.authority, ["sourceAuthenticated", "approvalAcknowledged", "runTerminalObserved", "resumeAllowed"]))
            return false;
        if (!Object.values(value.authority).every(entry => entry === false))
            return false;
        const warningList = value.warnings;
        if (!array(warningList) || warningList.length > warningNames.size || new Set(warningList).size !== warningList.length
            || !warningList.every(entry => typeof entry === "string" && warningNames.has(entry)))
            return false;
        const messageList = value.messages;
        if (!array(messageList) || messageList.length > pageLimit)
            return false;
        const toolList = value.tools;
        if (!array(toolList) || toolList.length > 4000)
            return false;
        const auxiliaryList = value.auxiliaryRecords;
        if (!array(auxiliaryList) || auxiliaryList.length > recordCount)
            return false;
        let count = 0;
        function block(blockValue, nested = false) {
            if (++count > 4000 || !object(blockValue) || !hash(blockValue.nativeDigest))
                return false;
            const fields = (...extra) => keys(blockValue, ["kind", "nativeDigest", ...extra]);
            switch (blockValue.kind) {
                case "text":
                    return fields("text") && text(blockValue.text);
                case "thinking":
                    return !nested && fields("text", "signaturePresent") && text(blockValue.text) && bool(blockValue.signaturePresent);
                case "redacted_thinking":
                case "compaction_boundary":
                case "unsupported_system":
                    return !nested && fields();
                case "unsupported":
                    return fields("nativeType") && id(blockValue.nativeType);
                case "attachment":
                    return fields("mediaKind", "sourceType", "mediaType", "title")
                        && (blockValue.mediaKind === "image" || blockValue.mediaKind === "document")
                        && id(blockValue.sourceType) && nullable(text)(blockValue.mediaType) && nullable(text)(blockValue.title);
                case "tool_use":
                    return !nested && fields("nativeToolId", "name", "input") && id(blockValue.nativeToolId)
                        && id(blockValue.name) && object(blockValue.input);
                case "tool_result": {
                    if (nested || !fields("nativeToolId", "isError", "content") || !id(blockValue.nativeToolId) || !bool(blockValue.isError)
                        || !array(blockValue.content))
                        return false;
                    return blockValue.content.every(child => block(child, true));
                }
                default:
                    return false;
            }
        }
        const ids = new Map();
        for (const message of messageList) {
            const optional = object(message) && message.role === "assistant" ? ["reportedStopReason"] : [];
            if (!keys(message, ["nativeMessageId", "role", "apiMessageId", "originalTimestamp", "metadata", "blocks", "sourceDigest"], optional))
                return false;
            if (!uuid(message.nativeMessageId) || ids.has(message.nativeMessageId))
                return false;
            if (message.role !== "user" && message.role !== "assistant" && message.role !== "system")
                return false;
            if (!hash(message.sourceDigest) || !nullable(text)(message.originalTimestamp))
                return false;
            if (message.role === "assistant") {
                if (!id(message.apiMessageId) || !Object.hasOwn(message, "reportedStopReason") || !nullable(id)(message.reportedStopReason))
                    return false;
            }
            else if (message.apiMessageId !== null)
                return false;
            const metadata = message.metadata;
            if (!keys(metadata, ["aborted", "apiError", "compactSummary", "synthetic"], ["errorCode"]))
                return false;
            if (!["aborted", "apiError", "compactSummary", "synthetic"].every(key => nullable(bool)(metadata[key])))
                return false;
            if (Object.hasOwn(metadata, "errorCode") && !id(metadata.errorCode))
                return false;
            if (!array(message.blocks) || !message.blocks.every(child => block(child)))
                return false;
            ids.set(message.nativeMessageId, message);
        }
        const toolIds = new Set();
        const pointer = (pointerValue, kind, toolId) => {
            if (pointerValue === null)
                return true;
            if (!keys(pointerValue, ["messageId", "blockIndex"]) || !uuid(pointerValue.messageId) || !integer(pointerValue.blockIndex))
                return false;
            const message = ids.get(pointerValue.messageId);
            if (!message || !array(message.blocks))
                return false;
            const referenced = message.blocks[pointerValue.blockIndex];
            return object(referenced) && referenced.kind === kind && referenced.nativeToolId === toolId;
        };
        for (const tool of toolList) {
            if (!keys(tool, ["nativeToolId", "name", "request", "result", "observation", "approvalEvidence"]))
                return false;
            if (!id(tool.nativeToolId) || toolIds.has(tool.nativeToolId) || !nullable(id)(tool.name) || tool.approvalEvidence !== "unavailable"
                || (tool.observation !== "request_only" && tool.observation !== "request_unavailable"
                    && tool.observation !== "result_recorded" && tool.observation !== "error_result_recorded")
                || !pointer(tool.request, "tool_use", tool.nativeToolId) || !pointer(tool.result, "tool_result", tool.nativeToolId))
                return false;
            toolIds.add(tool.nativeToolId);
        }
        const indices = new Set();
        for (const auxiliary of auxiliaryList) {
            if (!keys(auxiliary, ["kind", "recordIndex", "nativeType", "scopeEvidence", "referenceIds", "nativeDigest"]))
                return false;
            if (auxiliary.kind !== "file_history" && auxiliary.kind !== "scoped_metadata")
                return false;
            if (!integer(auxiliary.recordIndex) || auxiliary.recordIndex >= recordCount || indices.has(auxiliary.recordIndex))
                return false;
            if (!id(auxiliary.nativeType) || !hash(auxiliary.nativeDigest))
                return false;
            if (auxiliary.scopeEvidence !== "recorded_session_id" && auxiliary.scopeEvidence !== "same_file_message_reference")
                return false;
            if (!array(auxiliary.referenceIds) || auxiliary.referenceIds.length > 2 || !auxiliary.referenceIds.every(reference => uuid(reference)))
                return false;
            indices.add(auxiliary.recordIndex);
        }
        return true;
    }
    StepsembleClaudeHistoryValue.validObservation = validObservation;
})(StepsembleClaudeHistoryValue || (StepsembleClaudeHistoryValue = {}));
if (typeof module !== "undefined")
    module.exports = StepsembleClaudeHistoryValue;
