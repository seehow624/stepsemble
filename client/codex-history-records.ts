/** Shared, inert Codex raw-record DTO. These records are not the native turn
 * projection: no synthesized message IDs, approval receipts or resume actions.
 * Structural validation is not source authentication; native capture/parser
 * checks byte digests independently before this public boundary. */
namespace StepsembleCodexHistoryRecords {
  type ObjectValue = Record<string, unknown>;
  export const LIMITS = Object.freeze({ responseBytes: 384 * 1024, pageBytes: 272 * 1024, sourceBytes: 8 * 1024 * 1024,
    recordBytes: 128 * 1024, records: 8192, pageRecords: 50, nameBytes: 32768 });
  export interface Page { offset: number; limit: number }
  export interface RawRecord {
    recordIndex: number; byteOffset: number; byteLength: number; recordType: string; payloadType: string | null;
    rawText: string; sha256: string; executable: false;
  }
  export interface Records {
    kind: "codex_rollout_records"; nativeVersion: "0.153.4"; nativeThreadId: string; scope: "one_legacy_rollout_raw_records";
    sha256: string; recordCount: number; byteLength: number; offset: number; records: RawRecord[]; nextOffset: number | null; endOfFile: boolean;
    sourceAuthenticated: false; publishable: false; semanticHistoryComplete: false;
  }
  export interface History {
    kind: "codex_source_records"; nativeVersion: "0.153.4"; nativeThreadId: string; nativeTitle: string | null; page: Page; records: Records;
    semanticHistoryComplete: false; sourceAuthenticated: false; publishable: false;
    authority: { sourceAuthenticated: false; approvalAcknowledged: false; runTerminalObserved: false; resumeAllowed: false };
  }
  export interface Scope { bindingId: string; generation: number; requestId: string; version?: string }
  export interface Bound extends Omit<Scope, "version"> {
    kind: "bound_codex_records"; sourceVersion: string; history: History; sourceAuthenticated: false; publishable: false; cleanupConfirmed: true;
  }
  const keys = (v: unknown, names: string[]): v is ObjectValue => v !== null && typeof v === "object" && !Array.isArray(v)
    && Object.keys(v).sort().join(",") === [...names].sort().join(",");
  const count = (v: unknown, max: number): v is number => Number.isSafeInteger(v) && (v as number) >= 0 && (v as number) <= max;
  const uuid = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(v);
  const hash = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
  const label = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 128 && !/[\u0000-\u001f\u007f-\u009f]/.test(v);
  const encoder = new TextEncoder();
  export const validTitle = (v: unknown): v is string | null => v === null || typeof v === "string" && encoder.encode(v).length <= LIMITS.nameBytes;
  export function validPage(v: unknown): v is Page {
    return keys(v, ["offset", "limit"]) && count(v.offset, LIMITS.records) && count(v.limit, LIMITS.pageRecords) && v.limit > 0;
  }
  /** Input must already be byte-bounded detached JSON, with no getters. */
  export function validHistoryValue(v: unknown, threadId: string, page: Page): v is History {
    if (!uuid(threadId) || !validPage(page) || !keys(v, ["kind", "nativeVersion", "nativeThreadId", "nativeTitle", "page", "records", "semanticHistoryComplete", "sourceAuthenticated", "publishable", "authority"])
      || v.kind !== "codex_source_records" || v.nativeVersion !== "0.153.4" || v.nativeThreadId !== threadId || !validTitle(v.nativeTitle)
      || !validPage(v.page) || v.page.offset !== page.offset || v.page.limit !== page.limit || v.semanticHistoryComplete !== false || v.sourceAuthenticated !== false || v.publishable !== false
      || !keys(v.authority, ["sourceAuthenticated", "approvalAcknowledged", "runTerminalObserved", "resumeAllowed"]) || !Object.values(v.authority).every(x => x === false)) return false;
    const r = v.records;
    if (!keys(r, ["kind", "nativeVersion", "nativeThreadId", "scope", "sha256", "recordCount", "byteLength", "offset", "records", "nextOffset", "endOfFile", "sourceAuthenticated", "publishable", "semanticHistoryComplete"])
      || r.kind !== "codex_rollout_records" || r.nativeVersion !== v.nativeVersion || r.nativeThreadId !== threadId || r.scope !== "one_legacy_rollout_raw_records"
      || !hash(r.sha256) || !count(r.recordCount, LIMITS.records) || !r.recordCount || !count(r.byteLength, LIMITS.sourceBytes) || !r.byteLength
      || r.offset !== page.offset || !Array.isArray(r.records) || r.records.length > page.limit || r.offset + r.records.length > r.recordCount
      || r.endOfFile !== (r.offset + r.records.length === r.recordCount) || r.nextOffset !== (r.endOfFile ? null : r.offset + r.records.length)
      || !r.endOfFile && !r.records.length || r.sourceAuthenticated !== false || r.publishable !== false || r.semanticHistoryComplete !== false
      || encoder.encode(JSON.stringify(r)).length > LIMITS.pageBytes) return false;
    let end: number | null = null;
    for (const [i, row] of r.records.entries()) {
      if (!keys(row, ["recordIndex", "byteOffset", "byteLength", "recordType", "payloadType", "rawText", "sha256", "executable"])
        || row.recordIndex !== page.offset + i || !count(row.byteOffset, r.byteLength) || !count(row.byteLength, LIMITS.recordBytes) || !row.byteLength
        || row.byteOffset + row.byteLength > r.byteLength || end !== null && row.byteOffset !== end || row.recordIndex === 0 && row.byteOffset !== 0
        || !label(row.recordType) || row.payloadType !== null && !label(row.payloadType) || typeof row.rawText !== "string"
        || encoder.encode(row.rawText).length !== row.byteLength || !row.rawText.endsWith("\n") || !hash(row.sha256) || row.executable !== false) return false;
      end = row.byteOffset + row.byteLength;
    }
    return !r.endOfFile || end === null || end === r.byteLength;
  }
  export function validBoundRecords(v: unknown, threadId: string, page: Page, scope: Scope): v is Bound {
    return uuid(scope.bindingId) && uuid(scope.requestId) && count(scope.generation, Number.MAX_SAFE_INTEGER) && scope.generation > 0
      && (scope.version === undefined || hash(scope.version))
      && keys(v, ["kind", "bindingId", "generation", "requestId", "sourceVersion", "history", "sourceAuthenticated", "publishable", "cleanupConfirmed"])
      && v.kind === "bound_codex_records" && v.bindingId === scope.bindingId && v.generation === scope.generation && v.requestId === scope.requestId
      && hash(v.sourceVersion) && (scope.version === undefined || v.sourceVersion === scope.version)
      && v.sourceAuthenticated === false && v.publishable === false && v.cleanupConfirmed === true && validHistoryValue(v.history, threadId, page);
  }
}
if (typeof module !== "undefined") module.exports = StepsembleCodexHistoryRecords;
