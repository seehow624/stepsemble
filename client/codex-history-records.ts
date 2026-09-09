/** Shared, inert Codex raw-record DTO. These records are not the native turn
 * projection: no synthesized message IDs, approval receipts or resume actions.
 * Structural validation is not source authentication; native capture/parser
 * checks byte digests independently before this public boundary. */
namespace StepsembleCodexHistoryRecords {
  type ObjectValue = Record<string, unknown>;
  export const LIMITS = Object.freeze({ responseBytes: 384 * 1024, pageBytes: 272 * 1024, sourceBytes: 8 * 1024 * 1024,
    recordBytes: 128 * 1024, records: 8192, pageRecords: 50, nameBytes: 32768 });
  export interface Page { offset: number; limit: number }
  export const STRUCTURE_PROFILE = "codex_legacy_record_structure_v1";
  export const STRUCTURE_WARNINGS: readonly string[] = ["invalid_turn_reference", "ambiguous_turn_reference", "unmatched_turn_reference", "invalid_tool_reference",
    "ambiguous_tool_reference", "unknown_record_preserved", "unknown_event_preserved", "invalid_terminal_error", "unclassified_error_preserved",
    "invalid_rollback_count", "invalid_message_preserved"];
  export const STRUCTURE_KINDS: readonly string[] = ["unknown", "metadata", "model_context", "tool", "user", "assistant", "reasoning", "lifecycle", "compaction", "review", "assessment", "item", "subagent", "hook"];
  export const TOOL_FAMILIES: readonly string[] = ["command", "patch", "dynamic", "mcp", "web", "image_generation", "image_view", "spawn_agent", "send_input", "wait_agents", "close_agent", "resume_agent"];
  export interface Turn {
    turnKey: string; nativeTurnId: string | null; boundary: "inferred" | "explicit"; firstRecordIndex: number; lastRecordIndex: number;
    recordedStatus: "unknown" | "started" | "completed" | "failed" | "interrupted"; statusRecordIndex: number | null;
    branchState: "retained" | "rolled_back"; rollbackRecordIndex: number | null;
  }
  export interface Annotation {
    recordIndex: number; kind: string; turnKey: string | null; warnings: string[];
    tool: { family: string; phase: "begin" | "end" | "request" | "single"; nativeCallId: string; relatedRecordIndex: number | null } | null;
  }
  export interface Structure { profile: typeof STRUCTURE_PROFILE; totalTurns: number; retainedTurns: number; turns: Turn[]; annotations: Annotation[] }
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
    structure?: Structure;
  }
  export interface Scope { bindingId: string; generation: number; requestId: string; version?: string; structured?: true }
  export interface Bound extends Omit<Scope, "version" | "structured"> {
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
  export function validHistoryValue(v: unknown, threadId: string, page: Page, structured = false): v is History {
    if (typeof structured !== "boolean" || !uuid(threadId) || !validPage(page) || !keys(v, ["kind", "nativeVersion", "nativeThreadId", "nativeTitle", "page", "records", "semanticHistoryComplete", "sourceAuthenticated", "publishable", "authority", ...(structured ? ["structure"] : [])])
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
    return (!r.endOfFile || end === null || end === r.byteLength) && (!structured || validStructure(v.structure, r as unknown as Records));
  }
  /** Detached JSON only. This validates a source-linked observation, not source
   * authentication or an execution/approval receipt. Shared with the parser. */
  export function validStructure(v: unknown, page: Records): v is Structure {
    const id = (n: unknown): n is string => typeof n === "string" && n.length > 0 && n.length <= 1024 && !/[\u0000-\u001f\u007f-\u009f]/.test(n)
      && !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?:^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(n);
    const index = (n: unknown): n is number => count(n, page.recordCount - 1);
    const key = (n: unknown): n is string => typeof n === "string" && /^record-(0|[1-9][0-9]*)$/.test(n) && index(Number(n.slice(7)));
    if (!keys(v, ["profile", "totalTurns", "retainedTurns", "turns", "annotations"]) || v.profile !== STRUCTURE_PROFILE
      || !count(v.totalTurns, page.recordCount) || !count(v.retainedTurns, v.totalTurns) || !Array.isArray(v.turns)
      || v.turns.length > Math.min(v.totalTurns, page.records.length) || !Array.isArray(v.annotations) || v.annotations.length !== page.records.length
      || encoder.encode(JSON.stringify({ records: page, structure: v })).length > LIMITS.pageBytes) return false;
    const turns = new Map<string, Turn>();
    for (const t of v.turns) {
      if (!keys(t, ["turnKey", "nativeTurnId", "boundary", "firstRecordIndex", "lastRecordIndex", "recordedStatus", "statusRecordIndex", "branchState", "rollbackRecordIndex"])
        || !key(t.turnKey) || turns.has(t.turnKey) || t.nativeTurnId !== null && !id(t.nativeTurnId)
        || t.boundary !== (t.nativeTurnId === null ? "inferred" : "explicit") || !index(t.firstRecordIndex) || !index(t.lastRecordIndex)
        || t.firstRecordIndex > t.lastRecordIndex || t.turnKey !== `record-${t.firstRecordIndex}`
        || typeof t.recordedStatus !== "string" || !["unknown", "started", "completed", "failed", "interrupted"].includes(t.recordedStatus)
        || t.statusRecordIndex !== null && (!index(t.statusRecordIndex) || t.statusRecordIndex < t.firstRecordIndex || t.statusRecordIndex > t.lastRecordIndex)
        || t.recordedStatus !== "unknown" && t.statusRecordIndex === null || !["retained", "rolled_back"].includes(t.branchState as string)
        || (t.branchState === "retained" ? t.rollbackRecordIndex !== null : !index(t.rollbackRecordIndex) || t.rollbackRecordIndex <= t.lastRecordIndex)) return false;
      turns.set(t.turnKey, t as unknown as Turn);
    }
    const used = new Set<string>();
    for (const [i, a] of v.annotations.entries()) {
      if (!keys(a, ["recordIndex", "kind", "turnKey", "tool", "warnings"]) || a.recordIndex !== page.offset + i || !index(a.recordIndex)
        || typeof a.kind !== "string" || !STRUCTURE_KINDS.includes(a.kind) || a.turnKey !== null && (typeof a.turnKey !== "string" || !turns.has(a.turnKey)) || !Array.isArray(a.warnings)
        || a.warnings.length > STRUCTURE_WARNINGS.length || new Set(a.warnings).size !== a.warnings.length || a.warnings.some(w => !STRUCTURE_WARNINGS.includes(w))) return false;
      if (a.turnKey !== null) {
        const t = turns.get(a.turnKey as string)!; used.add(t.turnKey);
        if (a.recordIndex < t.firstRecordIndex || a.recordIndex > t.lastRecordIndex) return false;
      }
      if (a.tool !== null) {
        const t = a.tool;
        if (a.kind !== "tool" || !keys(t, ["family", "phase", "nativeCallId", "relatedRecordIndex"]) || !TOOL_FAMILIES.includes(t.family as string)
          || !["begin", "end", "request", "single"].includes(t.phase as string) || !id(t.nativeCallId)
          || t.relatedRecordIndex !== null && (!index(t.relatedRecordIndex) || t.relatedRecordIndex === a.recordIndex || a.turnKey === null || !["begin", "end"].includes(t.phase as string))) return false;
        const other = t.relatedRecordIndex === null ? null : v.annotations[(t.relatedRecordIndex as number) - page.offset];
        if (other && (other.turnKey !== a.turnKey || other.tool?.family !== t.family || other.tool.nativeCallId !== t.nativeCallId
          || other.tool.relatedRecordIndex !== a.recordIndex || other.tool.phase !== (t.phase === "begin" ? "end" : "begin"))) return false;
      }
    }
    const retainedVisible = v.turns.filter(t => t.branchState === "retained").length;
    return used.size === turns.size && retainedVisible <= v.retainedTurns && v.turns.length - retainedVisible <= v.totalTurns - v.retainedTurns;
  }
  export function validBoundRecords(v: unknown, threadId: string, page: Page, scope: Scope): v is Bound {
    return uuid(scope.bindingId) && uuid(scope.requestId) && count(scope.generation, Number.MAX_SAFE_INTEGER) && scope.generation > 0
      && (scope.version === undefined || hash(scope.version))
      && (scope.structured === undefined || scope.structured === true)
      && keys(v, ["kind", "bindingId", "generation", "requestId", "sourceVersion", "history", "sourceAuthenticated", "publishable", "cleanupConfirmed"])
      && v.kind === "bound_codex_records" && v.bindingId === scope.bindingId && v.generation === scope.generation && v.requestId === scope.requestId
      && hash(v.sourceVersion) && (scope.version === undefined || v.sourceVersion === scope.version)
      && v.sourceAuthenticated === false && v.publishable === false && v.cleanupConfirmed === true && validHistoryValue(v.history, threadId, page, scope.structured === true);
  }
}
if (typeof module !== "undefined") module.exports = StepsembleCodexHistoryRecords;
