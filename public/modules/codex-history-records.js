"use strict";
/** Shared, inert Codex raw-record DTO. These records are not the native turn
 * projection: no synthesized message IDs, approval receipts or resume actions.
 * Structural validation is not source authentication; native capture/parser
 * checks byte digests independently before this public boundary. */
var StepsembleCodexHistoryRecords;
(function (StepsembleCodexHistoryRecords) {
    StepsembleCodexHistoryRecords.LIMITS = Object.freeze({ responseBytes: 384 * 1024, pageBytes: 272 * 1024, sourceBytes: 8 * 1024 * 1024,
        recordBytes: 128 * 1024, records: 8192, pageRecords: 50, nameBytes: 32768 });
    // Explicit capability negotiation: old callers keep the original bounds and
    // reject this shape. A validated page is not an old whole-file snapshot.
    StepsembleCodexHistoryRecords.PAGE_PROFILE = "codex_validated_page_v1";
    StepsembleCodexHistoryRecords.PAGE_LIMITS = Object.freeze({ sourceBytes: 256 * 1024 * 1024, records: 262144 });
    StepsembleCodexHistoryRecords.STRUCTURE_PROFILE = "codex_legacy_record_structure_v1";
    StepsembleCodexHistoryRecords.STRUCTURE_WARNINGS = ["invalid_turn_reference", "ambiguous_turn_reference", "unmatched_turn_reference", "invalid_tool_reference",
        "ambiguous_tool_reference", "unknown_record_preserved", "unknown_event_preserved", "invalid_terminal_error", "unclassified_error_preserved",
        "invalid_rollback_count", "invalid_message_preserved"];
    StepsembleCodexHistoryRecords.STRUCTURE_KINDS = ["unknown", "metadata", "model_context", "tool", "user", "assistant", "reasoning", "lifecycle", "compaction", "review", "assessment", "item", "subagent", "hook"];
    StepsembleCodexHistoryRecords.TOOL_FAMILIES = ["command", "patch", "dynamic", "mcp", "web", "image_generation", "image_view", "spawn_agent", "send_input", "wait_agents", "close_agent", "resume_agent"];
    const keys = (v, names) => v !== null && typeof v === "object" && !Array.isArray(v)
        && Object.keys(v).sort().join(",") === [...names].sort().join(",");
    const count = (v, max) => Number.isSafeInteger(v) && v >= 0 && v <= max;
    const uuid = (v) => typeof v === "string" && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(v);
    const hash = (v) => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
    const label = (v) => typeof v === "string" && v.length > 0 && v.length <= 128 && !/[\u0000-\u001f\u007f-\u009f]/.test(v);
    const encoder = new TextEncoder();
    StepsembleCodexHistoryRecords.validTitle = (v) => v === null || typeof v === "string" && encoder.encode(v).length <= StepsembleCodexHistoryRecords.LIMITS.nameBytes;
    function validPage(v, profile) {
        return (profile === undefined || profile === StepsembleCodexHistoryRecords.PAGE_PROFILE) && keys(v, ["offset", "limit"])
            && count(v.offset, profile === StepsembleCodexHistoryRecords.PAGE_PROFILE ? StepsembleCodexHistoryRecords.PAGE_LIMITS.records : StepsembleCodexHistoryRecords.LIMITS.records) && count(v.limit, StepsembleCodexHistoryRecords.LIMITS.pageRecords) && v.limit > 0;
    }
    StepsembleCodexHistoryRecords.validPage = validPage;
    /** Input must already be byte-bounded detached JSON, with no getters. */
    function validHistoryValue(v, threadId, page, structured = false, profile) {
        const paged = profile === StepsembleCodexHistoryRecords.PAGE_PROFILE, limits = paged ? StepsembleCodexHistoryRecords.PAGE_LIMITS : StepsembleCodexHistoryRecords.LIMITS;
        if (typeof structured !== "boolean" || structured && paged || !uuid(threadId) || !validPage(page, profile) || !keys(v, ["kind", "nativeVersion", "nativeThreadId", "nativeTitle", "page", "records", "semanticHistoryComplete", "sourceAuthenticated", "publishable", "authority", ...(structured ? ["structure"] : [])])
            || v.kind !== (paged ? "codex_validated_source_records" : "codex_source_records") || v.nativeVersion !== "0.153.4" || v.nativeThreadId !== threadId || !StepsembleCodexHistoryRecords.validTitle(v.nativeTitle)
            || !validPage(v.page, profile) || v.page.offset !== page.offset || v.page.limit !== page.limit || v.semanticHistoryComplete !== false || v.sourceAuthenticated !== false || v.publishable !== false
            || !keys(v.authority, ["sourceAuthenticated", "approvalAcknowledged", "runTerminalObserved", "resumeAllowed"]) || !Object.values(v.authority).every(x => x === false))
            return false;
        const r = v.records;
        if (!keys(r, ["kind", "nativeVersion", "nativeThreadId", "scope", "sha256", "recordCount", "byteLength", "offset", "records", "nextOffset", "endOfFile", "sourceAuthenticated", "publishable", "semanticHistoryComplete"])
            || r.kind !== (paged ? "codex_validated_rollout_records" : "codex_rollout_records") || r.nativeVersion !== v.nativeVersion || r.nativeThreadId !== threadId || r.scope !== (paged ? "one_legacy_rollout_validated_page" : "one_legacy_rollout_raw_records")
            || !hash(r.sha256) || !count(r.recordCount, limits.records) || !r.recordCount || !count(r.byteLength, limits.sourceBytes) || !r.byteLength
            || r.offset !== page.offset || !Array.isArray(r.records) || r.records.length > page.limit || r.offset + r.records.length > r.recordCount
            || r.endOfFile !== (r.offset + r.records.length === r.recordCount) || r.nextOffset !== (r.endOfFile ? null : r.offset + r.records.length)
            || !r.endOfFile && !r.records.length || r.sourceAuthenticated !== false || r.publishable !== false || r.semanticHistoryComplete !== false
            || encoder.encode(JSON.stringify(r)).length > StepsembleCodexHistoryRecords.LIMITS.pageBytes)
            return false;
        let end = null;
        for (const [i, row] of r.records.entries()) {
            if (!keys(row, ["recordIndex", "byteOffset", "byteLength", "recordType", "payloadType", "rawText", "sha256", "executable"])
                || row.recordIndex !== page.offset + i || !count(row.byteOffset, r.byteLength) || !count(row.byteLength, StepsembleCodexHistoryRecords.LIMITS.recordBytes) || !row.byteLength
                || row.byteOffset + row.byteLength > r.byteLength || end !== null && row.byteOffset !== end || row.recordIndex === 0 && row.byteOffset !== 0
                || !label(row.recordType) || row.payloadType !== null && !label(row.payloadType) || typeof row.rawText !== "string"
                || encoder.encode(row.rawText).length !== row.byteLength || !row.rawText.endsWith("\n") || !hash(row.sha256) || row.executable !== false)
                return false;
            end = row.byteOffset + row.byteLength;
        }
        return (!r.endOfFile || end === null || end === r.byteLength) && (!structured || validStructure(v.structure, r));
    }
    StepsembleCodexHistoryRecords.validHistoryValue = validHistoryValue;
    /** Detached JSON only. This validates a source-linked observation, not source
     * authentication or an execution/approval receipt. Shared with the parser. */
    function validStructure(v, page) {
        const id = (n) => typeof n === "string" && n.length > 0 && n.length <= 1024 && !/[\u0000-\u001f\u007f-\u009f]/.test(n)
            && !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?:^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(n);
        const index = (n) => count(n, page.recordCount - 1);
        const key = (n) => typeof n === "string" && /^record-(0|[1-9][0-9]*)$/.test(n) && index(Number(n.slice(7)));
        if (!keys(v, ["profile", "totalTurns", "retainedTurns", "turns", "annotations"]) || v.profile !== StepsembleCodexHistoryRecords.STRUCTURE_PROFILE
            || !count(v.totalTurns, page.recordCount) || !count(v.retainedTurns, v.totalTurns) || !Array.isArray(v.turns)
            || v.turns.length > Math.min(v.totalTurns, page.records.length) || !Array.isArray(v.annotations) || v.annotations.length !== page.records.length
            || encoder.encode(JSON.stringify({ records: page, structure: v })).length > StepsembleCodexHistoryRecords.LIMITS.pageBytes)
            return false;
        const turns = new Map();
        for (const t of v.turns) {
            if (!keys(t, ["turnKey", "nativeTurnId", "boundary", "firstRecordIndex", "lastRecordIndex", "recordedStatus", "statusRecordIndex", "branchState", "rollbackRecordIndex"])
                || !key(t.turnKey) || turns.has(t.turnKey) || t.nativeTurnId !== null && !id(t.nativeTurnId)
                || t.boundary !== (t.nativeTurnId === null ? "inferred" : "explicit") || !index(t.firstRecordIndex) || !index(t.lastRecordIndex)
                || t.firstRecordIndex > t.lastRecordIndex || t.turnKey !== `record-${t.firstRecordIndex}`
                || typeof t.recordedStatus !== "string" || !["unknown", "started", "completed", "failed", "interrupted"].includes(t.recordedStatus)
                || t.statusRecordIndex !== null && (!index(t.statusRecordIndex) || t.statusRecordIndex < t.firstRecordIndex || t.statusRecordIndex > t.lastRecordIndex)
                || t.recordedStatus !== "unknown" && t.statusRecordIndex === null || !["retained", "rolled_back"].includes(t.branchState)
                || (t.branchState === "retained" ? t.rollbackRecordIndex !== null : !index(t.rollbackRecordIndex) || t.rollbackRecordIndex <= t.lastRecordIndex))
                return false;
            turns.set(t.turnKey, t);
        }
        const used = new Set();
        for (const [i, a] of v.annotations.entries()) {
            if (!keys(a, ["recordIndex", "kind", "turnKey", "tool", "warnings"]) || a.recordIndex !== page.offset + i || !index(a.recordIndex)
                || typeof a.kind !== "string" || !StepsembleCodexHistoryRecords.STRUCTURE_KINDS.includes(a.kind) || a.turnKey !== null && (typeof a.turnKey !== "string" || !turns.has(a.turnKey)) || !Array.isArray(a.warnings)
                || a.warnings.length > StepsembleCodexHistoryRecords.STRUCTURE_WARNINGS.length || new Set(a.warnings).size !== a.warnings.length || a.warnings.some(w => !StepsembleCodexHistoryRecords.STRUCTURE_WARNINGS.includes(w)))
                return false;
            if (a.turnKey !== null) {
                const t = turns.get(a.turnKey);
                used.add(t.turnKey);
                if (a.recordIndex < t.firstRecordIndex || a.recordIndex > t.lastRecordIndex)
                    return false;
            }
            if (a.tool !== null) {
                const t = a.tool;
                if (a.kind !== "tool" || !keys(t, ["family", "phase", "nativeCallId", "relatedRecordIndex"]) || !StepsembleCodexHistoryRecords.TOOL_FAMILIES.includes(t.family)
                    || !["begin", "end", "request", "single"].includes(t.phase) || !id(t.nativeCallId)
                    || t.relatedRecordIndex !== null && (!index(t.relatedRecordIndex) || t.relatedRecordIndex === a.recordIndex || a.turnKey === null || !["begin", "end"].includes(t.phase)))
                    return false;
                const other = t.relatedRecordIndex === null ? null : v.annotations[t.relatedRecordIndex - page.offset];
                if (other && (other.turnKey !== a.turnKey || other.tool?.family !== t.family || other.tool.nativeCallId !== t.nativeCallId
                    || other.tool.relatedRecordIndex !== a.recordIndex || other.tool.phase !== (t.phase === "begin" ? "end" : "begin")))
                    return false;
            }
        }
        const retainedVisible = v.turns.filter(t => t.branchState === "retained").length;
        return used.size === turns.size && retainedVisible <= v.retainedTurns && v.turns.length - retainedVisible <= v.totalTurns - v.retainedTurns;
    }
    StepsembleCodexHistoryRecords.validStructure = validStructure;
    function validBoundRecords(v, threadId, page, scope) {
        return uuid(scope.bindingId) && uuid(scope.requestId) && count(scope.generation, Number.MAX_SAFE_INTEGER) && scope.generation > 0
            && (scope.version === undefined || hash(scope.version))
            && (scope.structured === undefined || scope.structured === true)
            && (scope.profile === undefined || scope.profile === StepsembleCodexHistoryRecords.PAGE_PROFILE && scope.structured === undefined)
            && keys(v, ["kind", "bindingId", "generation", "requestId", "sourceVersion", "history", "sourceAuthenticated", "publishable", "cleanupConfirmed"])
            && v.kind === "bound_codex_records" && v.bindingId === scope.bindingId && v.generation === scope.generation && v.requestId === scope.requestId
            && hash(v.sourceVersion) && (scope.version === undefined || v.sourceVersion === scope.version)
            && v.sourceAuthenticated === false && v.publishable === false && v.cleanupConfirmed === true && validHistoryValue(v.history, threadId, page, scope.structured === true, scope.profile);
    }
    StepsembleCodexHistoryRecords.validBoundRecords = validBoundRecords;
})(StepsembleCodexHistoryRecords || (StepsembleCodexHistoryRecords = {}));
if (typeof module !== "undefined")
    module.exports = StepsembleCodexHistoryRecords;
