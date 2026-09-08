/// <reference path="./history-pages.ts" />
/// <reference path="./claude-history-value.ts" />
/** Shared reviewed Claude inert-history provider. No SDK import, I/O, auth or
 * dispatch. Structural validation is not native-source authenticity. */
declare function require(name: "./claude-history-value"): typeof StepsembleClaudeHistoryValue;
namespace StepsembleClaudeHistory {
  const values = typeof module !== "undefined" ? require("./claude-history-value") : StepsembleClaudeHistoryValue;
  export const READER = Object.freeze({ sdkVersion: "0.3.259", nativeVersion: "2.1.259",
    sdkSha256: "7fa7c212361864544e775e7551519e790515f95d4bb6a4831b0b05f5b368a0c5", selection: "snapshot_session_store" } as const);
  export const LIMITS = Object.freeze({ historyBytes: 256 * 1024, sourceBytes: 8 * 1024 * 1024, sourceRecords: 2000, pageMessages: 100 });
  type ObjectValue = Record<string, unknown>;
  export interface Page { offset: number; limit: number }
  export interface BasicSourceChecks { owner: "posix_euid_and_mode"; reads: 2; matchingBytes: true; unchangedObservedIdentity: true }
  export interface NativeSourceChecks extends BasicSourceChecks {
    acl: "no_extended_acl"; containment: "root_identity_and_openat_nofollow";
  }
  export interface SourceSummary {
    kind: "source_snapshot_summary"; sessionId: string; recordCount: number; byteLength: number; sha256: string;
    identity: { device: string; inode: string; size: number; mtimeNs: string; ctimeNs: string };
    checks: BasicSourceChecks | NativeSourceChecks;
    sourceAuthenticated: false; publishable: false;
  }
  export interface History {
    kind: "source_history_observation"; source: SourceSummary; page: Page;
    observation: StepsembleHistoryPages.Observation; reader: typeof READER;
    metrics: { selectionMs: number; mappingMs: number; maxRssKiB: number };
  }
  export interface Dependencies { canonicalJSON(value: unknown, maxBytes: number): string | null }
  const object = (v: unknown): v is ObjectValue => v !== null && typeof v === "object" && !Array.isArray(v);
  const keys = (v: unknown, names: string[]): v is ObjectValue => object(v)
    && Object.keys(v).sort().join(",") === [...names].sort().join(",");
  const uuid = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(v);
  const hash = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
  const decimal = (v: unknown): v is string => typeof v === "string" && /^\d{1,30}$/.test(v);
  const integer = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;
  const positive = (v: unknown): v is number => integer(v) && v > 0;
  function validPage(v: unknown): v is Page & ObjectValue {
    return keys(v, ["offset", "limit"]) && integer(v.offset) && v.offset <= LIMITS.sourceRecords
      && positive(v.limit) && v.limit <= LIMITS.pageMessages;
  }
  /** Two exact observed-check profiles; neither grants native authenticity.
   * Native workers additionally REQUIRE the native profile, never downgrade. */
  export function validSourceChecks(v: unknown): v is BasicSourceChecks | NativeSourceChecks {
    return (keys(v, ["owner", "reads", "matchingBytes", "unchangedObservedIdentity"])
      || keys(v, ["owner", "reads", "matchingBytes", "unchangedObservedIdentity", "acl", "containment"])
        && v.acl === "no_extended_acl" && v.containment === "root_identity_and_openat_nofollow")
      && v.owner === "posix_euid_and_mode" && v.reads === 2
      && v.matchingBytes === true && v.unchangedObservedIdentity === true;
  }
  function validSource(v: unknown, sessionId: string): boolean {
    return keys(v, ["kind", "sessionId", "recordCount", "byteLength", "sha256", "identity", "checks", "sourceAuthenticated", "publishable"])
      && v.kind === "source_snapshot_summary" && v.sessionId === sessionId && v.sourceAuthenticated === false && v.publishable === false
      && positive(v.recordCount) && v.recordCount <= LIMITS.sourceRecords && positive(v.byteLength) && v.byteLength <= LIMITS.sourceBytes && hash(v.sha256)
      && keys(v.identity, ["device", "inode", "size", "mtimeNs", "ctimeNs"])
      && ["device", "inode", "mtimeNs", "ctimeNs"].every(k => decimal((v.identity as ObjectValue)[k]))
      && v.identity.inode !== "0" && v.identity.size === v.byteLength
      && validSourceChecks(v.checks);
  }
  /** Host fast path ONLY for already byte-bounded, detached JSON and validated
   * scope/page. Browser callers should use create().parse/validate/decodeHistory.
   * This low-level predicate does not evaluate a source hash or grant authority. */
  export function validHistoryValue(value: unknown, sessionId: string, page: Page): value is History {
    if (!uuid(sessionId) || !validPage(page) || !keys(value, ["kind", "source", "page", "observation", "reader", "metrics"])
      || value.kind !== "source_history_observation" || !validSource(value.source, sessionId) || !object(value.source)
      || !validPage(value.page) || value.page.offset !== page.offset || value.page.limit !== page.limit
      || !keys(value.reader, ["sdkVersion", "nativeVersion", "sdkSha256", "selection"])
      || !Object.entries(READER).every(([key, expected]) => (value.reader as ObjectValue)[key] === expected)
      || !keys(value.metrics, ["selectionMs", "mappingMs", "maxRssKiB"])
      || !Object.values(value.metrics).every(v => typeof v === "number" && Number.isFinite(v) && v >= 0)
      || !integer(value.source.recordCount)) return false;
    return values.validObservation(value.observation, sessionId, page.limit, value.source.recordCount);
  }
  export function create(deps: Dependencies) {
    if (typeof deps?.canonicalJSON !== "function") throw new TypeError("history_json_validator_required");
    const { canonicalJSON } = deps;
    function detach(value: unknown, limit: number): unknown {
      const json = canonicalJSON(value, limit); return json === null ? null : JSON.parse(json);
    }
    function parseHistory(value: unknown, sessionId: string, page: Page): History | null {
      try {
        const expected = detach({ sessionId, page }, 2048);
        if (!keys(expected, ["sessionId", "page"]) || !uuid(expected.sessionId) || !validPage(expected.page)) return null;
        const history = detach(value, LIMITS.historyBytes);
        return validHistoryValue(history, expected.sessionId, expected.page) ? history : null;
      } catch { return null; }
    }
    function validateHistory(value: unknown, sessionId: string, page: Page): boolean { return parseHistory(value, sessionId, page) !== null; }
    /** Decode one provider JSON payload, NOT a private worker JSONL envelope or
     * a bound HTTP response. Transport must cap streamed bytes before collecting
     * them; this function independently caps the supplied bytes before parsing. */
    function decodeHistory(bytes: Uint8Array, sessionId: string, page: Page): History | null {
      try {
        if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0 || bytes.byteLength > LIMITS.historyBytes) return null;
        const snapshot = new Uint8Array(bytes);
        if (snapshot[0] === 0xef && snapshot[1] === 0xbb && snapshot[2] === 0xbf) return null;
        const text = new TextDecoder("utf-8", { fatal: true }).decode(snapshot);
        return parseHistory(JSON.parse(text), sessionId, page);
      } catch { return null; }
    }
    return Object.freeze({ parseHistory, validateHistory, decodeHistory });
  }
}
if (typeof module !== "undefined") module.exports = StepsembleClaudeHistory;
