"use strict";
/// <reference path="./history-pages.ts" />
/// <reference path="./claude-history-value.ts" />
var StepsembleClaudeHistory;
(function (StepsembleClaudeHistory) {
    const values = typeof module !== "undefined" ? require("./claude-history-value") : StepsembleClaudeHistoryValue;
    StepsembleClaudeHistory.READER = Object.freeze({ sdkVersion: "0.3.259", nativeVersion: "2.1.259",
        sdkSha256: "7fa7c212361864544e775e7551519e790515f95d4bb6a4831b0b05f5b368a0c5", selection: "snapshot_session_store" });
    StepsembleClaudeHistory.LIMITS = Object.freeze({ historyBytes: 256 * 1024, sourceBytes: 8 * 1024 * 1024, sourceRecords: 2000, pageMessages: 100 });
    const object = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
    const keys = (v, names) => object(v)
        && Object.keys(v).sort().join(",") === [...names].sort().join(",");
    const uuid = (v) => typeof v === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(v);
    const hash = (v) => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
    const decimal = (v) => typeof v === "string" && /^\d{1,30}$/.test(v);
    const integer = (v) => Number.isSafeInteger(v) && v >= 0;
    const positive = (v) => integer(v) && v > 0;
    function validPage(v) {
        return keys(v, ["offset", "limit"]) && integer(v.offset) && v.offset <= StepsembleClaudeHistory.LIMITS.sourceRecords
            && positive(v.limit) && v.limit <= StepsembleClaudeHistory.LIMITS.pageMessages;
    }
    function validSource(v, sessionId) {
        return keys(v, ["kind", "sessionId", "recordCount", "byteLength", "sha256", "identity", "checks", "sourceAuthenticated", "publishable"])
            && v.kind === "source_snapshot_summary" && v.sessionId === sessionId && v.sourceAuthenticated === false && v.publishable === false
            && positive(v.recordCount) && v.recordCount <= StepsembleClaudeHistory.LIMITS.sourceRecords && positive(v.byteLength) && v.byteLength <= StepsembleClaudeHistory.LIMITS.sourceBytes && hash(v.sha256)
            && keys(v.identity, ["device", "inode", "size", "mtimeNs", "ctimeNs"])
            && ["device", "inode", "mtimeNs", "ctimeNs"].every(k => decimal(v.identity[k]))
            && v.identity.inode !== "0" && v.identity.size === v.byteLength
            && keys(v.checks, ["owner", "reads", "matchingBytes", "unchangedObservedIdentity"])
            && v.checks.owner === "posix_euid_and_mode" && v.checks.reads === 2
            && v.checks.matchingBytes === true && v.checks.unchangedObservedIdentity === true;
    }
    /** Host fast path ONLY for already byte-bounded, detached JSON and validated
     * scope/page. Browser callers should use create().parse/validate/decodeHistory.
     * This low-level predicate does not evaluate a source hash or grant authority. */
    function validHistoryValue(value, sessionId, page) {
        if (!uuid(sessionId) || !validPage(page) || !keys(value, ["kind", "source", "page", "observation", "reader", "metrics"])
            || value.kind !== "source_history_observation" || !validSource(value.source, sessionId) || !object(value.source)
            || !validPage(value.page) || value.page.offset !== page.offset || value.page.limit !== page.limit
            || !keys(value.reader, ["sdkVersion", "nativeVersion", "sdkSha256", "selection"])
            || !Object.entries(StepsembleClaudeHistory.READER).every(([key, expected]) => value.reader[key] === expected)
            || !keys(value.metrics, ["selectionMs", "mappingMs", "maxRssKiB"])
            || !Object.values(value.metrics).every(v => typeof v === "number" && Number.isFinite(v) && v >= 0)
            || !integer(value.source.recordCount))
            return false;
        return values.validObservation(value.observation, sessionId, page.limit, value.source.recordCount);
    }
    StepsembleClaudeHistory.validHistoryValue = validHistoryValue;
    function create(deps) {
        if (typeof deps?.canonicalJSON !== "function")
            throw new TypeError("history_json_validator_required");
        const { canonicalJSON } = deps;
        function detach(value, limit) {
            const json = canonicalJSON(value, limit);
            return json === null ? null : JSON.parse(json);
        }
        function parseHistory(value, sessionId, page) {
            try {
                const expected = detach({ sessionId, page }, 2048);
                if (!keys(expected, ["sessionId", "page"]) || !uuid(expected.sessionId) || !validPage(expected.page))
                    return null;
                const history = detach(value, StepsembleClaudeHistory.LIMITS.historyBytes);
                return validHistoryValue(history, expected.sessionId, expected.page) ? history : null;
            }
            catch {
                return null;
            }
        }
        function validateHistory(value, sessionId, page) { return parseHistory(value, sessionId, page) !== null; }
        /** Decode one provider JSON payload, NOT a private worker JSONL envelope or
         * a bound HTTP response. Transport must cap streamed bytes before collecting
         * them; this function independently caps the supplied bytes before parsing. */
        function decodeHistory(bytes, sessionId, page) {
            try {
                if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0 || bytes.byteLength > StepsembleClaudeHistory.LIMITS.historyBytes)
                    return null;
                const snapshot = new Uint8Array(bytes);
                if (snapshot[0] === 0xef && snapshot[1] === 0xbb && snapshot[2] === 0xbf)
                    return null;
                const text = new TextDecoder("utf-8", { fatal: true }).decode(snapshot);
                return parseHistory(JSON.parse(text), sessionId, page);
            }
            catch {
                return null;
            }
        }
        return Object.freeze({ parseHistory, validateHistory, decodeHistory });
    }
    StepsembleClaudeHistory.create = create;
})(StepsembleClaudeHistory || (StepsembleClaudeHistory = {}));
if (typeof module !== "undefined")
    module.exports = StepsembleClaudeHistory;
