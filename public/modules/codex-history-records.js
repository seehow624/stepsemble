"use strict";
/** Shared, inert Codex raw-record DTO. These records are not the native turn
 * projection: no synthesized message IDs, approval receipts or resume actions.
 * Structural validation is not source authentication; native capture/parser
 * checks byte digests independently before this public boundary. */
var StepsembleCodexHistoryRecords;
(function (StepsembleCodexHistoryRecords) {
    StepsembleCodexHistoryRecords.LIMITS = Object.freeze({ responseBytes: 384 * 1024, pageBytes: 272 * 1024, sourceBytes: 8 * 1024 * 1024,
        recordBytes: 128 * 1024, records: 8192, pageRecords: 50, nameBytes: 32768 });
    const keys = (v, names) => v !== null && typeof v === "object" && !Array.isArray(v)
        && Object.keys(v).sort().join(",") === [...names].sort().join(",");
    const count = (v, max) => Number.isSafeInteger(v) && v >= 0 && v <= max;
    const uuid = (v) => typeof v === "string" && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(v);
    const hash = (v) => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
    const label = (v) => typeof v === "string" && v.length > 0 && v.length <= 128 && !/[\u0000-\u001f\u007f-\u009f]/.test(v);
    const encoder = new TextEncoder();
    StepsembleCodexHistoryRecords.validTitle = (v) => v === null || typeof v === "string" && encoder.encode(v).length <= StepsembleCodexHistoryRecords.LIMITS.nameBytes;
    function validPage(v) {
        return keys(v, ["offset", "limit"]) && count(v.offset, StepsembleCodexHistoryRecords.LIMITS.records) && count(v.limit, StepsembleCodexHistoryRecords.LIMITS.pageRecords) && v.limit > 0;
    }
    StepsembleCodexHistoryRecords.validPage = validPage;
    /** Input must already be byte-bounded detached JSON, with no getters. */
    function validHistoryValue(v, threadId, page) {
        if (!uuid(threadId) || !validPage(page) || !keys(v, ["kind", "nativeVersion", "nativeThreadId", "nativeTitle", "page", "records", "semanticHistoryComplete", "sourceAuthenticated", "publishable", "authority"])
            || v.kind !== "codex_source_records" || v.nativeVersion !== "0.153.4" || v.nativeThreadId !== threadId || !StepsembleCodexHistoryRecords.validTitle(v.nativeTitle)
            || !validPage(v.page) || v.page.offset !== page.offset || v.page.limit !== page.limit || v.semanticHistoryComplete !== false || v.sourceAuthenticated !== false || v.publishable !== false
            || !keys(v.authority, ["sourceAuthenticated", "approvalAcknowledged", "runTerminalObserved", "resumeAllowed"]) || !Object.values(v.authority).every(x => x === false))
            return false;
        const r = v.records;
        if (!keys(r, ["kind", "nativeVersion", "nativeThreadId", "scope", "sha256", "recordCount", "byteLength", "offset", "records", "nextOffset", "endOfFile", "sourceAuthenticated", "publishable", "semanticHistoryComplete"])
            || r.kind !== "codex_rollout_records" || r.nativeVersion !== v.nativeVersion || r.nativeThreadId !== threadId || r.scope !== "one_legacy_rollout_raw_records"
            || !hash(r.sha256) || !count(r.recordCount, StepsembleCodexHistoryRecords.LIMITS.records) || !r.recordCount || !count(r.byteLength, StepsembleCodexHistoryRecords.LIMITS.sourceBytes) || !r.byteLength
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
        return !r.endOfFile || end === null || end === r.byteLength;
    }
    StepsembleCodexHistoryRecords.validHistoryValue = validHistoryValue;
    function validBoundRecords(v, threadId, page, scope) {
        return uuid(scope.bindingId) && uuid(scope.requestId) && count(scope.generation, Number.MAX_SAFE_INTEGER) && scope.generation > 0
            && (scope.version === undefined || hash(scope.version))
            && keys(v, ["kind", "bindingId", "generation", "requestId", "sourceVersion", "history", "sourceAuthenticated", "publishable", "cleanupConfirmed"])
            && v.kind === "bound_codex_records" && v.bindingId === scope.bindingId && v.generation === scope.generation && v.requestId === scope.requestId
            && hash(v.sourceVersion) && (scope.version === undefined || v.sourceVersion === scope.version)
            && v.sourceAuthenticated === false && v.publishable === false && v.cleanupConfirmed === true && validHistoryValue(v.history, threadId, page);
    }
    StepsembleCodexHistoryRecords.validBoundRecords = validBoundRecords;
})(StepsembleCodexHistoryRecords || (StepsembleCodexHistoryRecords = {}));
if (typeof module !== "undefined")
    module.exports = StepsembleCodexHistoryRecords;
