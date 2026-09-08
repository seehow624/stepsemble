/// <reference path="./protocol-types.d.ts" />
/** Reserved inert-history view controller. No DOM/network/storage/native calls.
 * The caller supplies a scoped transport and reviewed response validator; this
 * module cannot authenticate a Host/source or grant journal/approval authority. */
namespace StepsembleHistoryPages {
  export interface Scope { hostId: string; bindingId: string; generation: number; sessionId: string }
  export interface Page { offset: number; limit: number }
  export interface Request { bindingId: string; generation: number; requestId: string }
  export interface ReadOptions { page: Page; version?: string; signal: AbortSignal }
  export interface Dependencies {
    read(scope: Scope, request: Request, options: ReadOptions): Promise<unknown>;
    canonicalJSON(value: unknown, maxBytes: number): string | null;
    /** Complete provider-specific history shape/version/content validation.
     * Must be independently implemented, not `() => true` in a real Client. */
    validateHistory(history: unknown, sessionId: string, page: Page): boolean;
    requestId(): string;
  }
  type ObjectValue = Record<string, unknown>;
  export interface Observation {
    messages: Array<ObjectValue & { nativeMessageId: string }>;
    sourceDigest: string; selectionDigest: string; publishable: false;
    authority: { sourceAuthenticated: false; approvalAcknowledged: false; runTerminalObserved: false; resumeAllowed: false };
    [key: string]: unknown;
  }
  export interface StoredPage { offset: number; limit: number; observation: Observation }
  export interface View {
    scope: Scope | null; status: "empty" | "loading" | "refreshing" | "ready" | "error" | "stale" | "disposed";
    error: string | null; sourceVersion: string | null; pages: StoredPage[];
    messageCount: number; startOffset: number | null; nextOffset: number | null; reachedEnd: boolean;
    publishable: false;
  }
  export type Outcome = { kind: "applied" | "ignored" | "cancelled" } | { kind: "unavailable"; code: string };
  type Mode = "refresh" | "next" | "previous";
  interface Ticket { mode: Mode; scope: Scope; request: Request; page: Page; version?: string; abort: AbortController }
  interface Reply { kind: "bound_history_observation"; bindingId: string; generation: number; requestId: string;
    sourceVersion: string; sourceAuthenticated: false; publishable: false; cleanupConfirmed: true;
    history: { kind: "source_history_observation"; source: ObjectValue; page: Page; observation: Observation; reader: ObjectValue; metrics: unknown } }
  export const LIMITS = Object.freeze({ responseBytes: 272 * 1024, retainedBytes: 2 * 1024 * 1024, messages: 500, pages: 32, pageMessages: 100 });
  const object = (v: unknown): v is ObjectValue => v !== null && typeof v === "object" && !Array.isArray(v);
  const keys = (v: unknown, names: string[]): v is ObjectValue => object(v) && Object.keys(v).sort().join(",") === [...names].sort().join(",");
  const uuid = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(v);
  const hash = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
  const positive = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) > 0;
  const pageValid = (v: unknown): v is unknown & Page => keys(v, ["offset", "limit"])
    && Number.isSafeInteger(v.offset) && (v.offset as number) >= 0 && (v.offset as number) <= 2000 && positive(v.limit) && v.limit <= LIMITS.pageMessages;
  const unavailable = (code: string): Outcome => ({ kind: "unavailable", code });
  const sourceFailures = new Set(["source_busy", "source_aborted", "source_version_changed", "source_version_unavailable", "source_observation_too_large",
    "source_platform_unsupported", "source_missing", "source_empty", "source_changed", "source_incomplete_tail", "source_invalid_json",
    "source_access_denied", "source_read_budget", "source_worker_timeout", "source_cleanup_unconfirmed", "source_service_quarantined",
    "source_service_closed", "source_binding_revoked", "source_binding_mismatch", "source_sdk_unavailable",
    "history_principal_unavailable", "history_source_unavailable", "history_binding_unavailable", "history_view_conflict",
    "history_capacity_unavailable", "history_registry_closed", "history_registry_unavailable", "history_unauthorized",
    "history_origin_rejected", "history_csrf_rejected", "history_request_timeout", "history_request_aborted",
    "history_response_too_large", "history_response_invalid", "history_transport_failed"]);

  export function create(deps: Dependencies) {
    if (![deps?.read, deps?.canonicalJSON, deps?.validateHistory, deps?.requestId].every(v => typeof v === "function")) throw new TypeError("history_dependencies_required");
    const { read, canonicalJSON, validateHistory, requestId } = deps;
    let scope: Scope | null = null, pending: Ticket | null = null, disposed = false, stale = false, error: string | null = null;
    let pages: StoredPage[] = [], version: string | null = null, identity: string | null = null, reachedEnd = false;
    const detach = <T>(value: unknown, limit: number): T | null => {
      try { const json = canonicalJSON(value, limit); return json === null ? null : JSON.parse(json) as T; } catch { return null; }
    };
    function cancel(): Outcome {
      const old = pending; pending = null; old?.abort.abort(); return { kind: "cancelled" };
    }
    function reset(input: Scope): Outcome {
      if (disposed) return unavailable("history_disposed");
      const next = detach<Scope>(input, 2048);
      if (!keys(next, ["hostId", "bindingId", "generation", "sessionId"]) || typeof next.hostId !== "string"
        || !/^[A-Za-z0-9_.:-]{1,128}$/.test(next.hostId) || !uuid(next.bindingId) || !uuid(next.sessionId) || !positive(next.generation))
        return unavailable("invalid_history_scope");
      cancel(); scope = next; pages = []; version = identity = null; error = null; stale = reachedEnd = false;
      return { kind: "applied" };
    }
    function state(): View {
      const first = pages[0], last = pages.at(-1);
      return structuredClone({ scope, status: disposed ? "disposed" : pending ? pages.length ? "refreshing" : "loading"
        : stale ? "stale" : error ? "error" : pages.length ? "ready" : "empty", error, sourceVersion: version, pages,
        messageCount: pages.reduce((sum, p) => sum + p.observation.messages.length, 0), startOffset: first?.offset ?? null,
        nextOffset: last ? last.offset + last.observation.messages.length : null, reachedEnd, publishable: false });
    }
    function fail(code: string): Outcome {
      error = code;
      if (["source_version_changed", "source_version_unavailable", "history_version_mismatch", "source_binding_revoked",
        "source_service_closed", "source_service_quarantined", "source_cleanup_unconfirmed", "history_principal_unavailable",
        "history_source_unavailable", "history_binding_unavailable", "history_registry_closed", "history_registry_unavailable",
        "history_unauthorized", "history_origin_rejected", "history_csrf_rejected"].includes(code)) stale = true;
      return unavailable(code);
    }
    function validReply(value: unknown, ticket: Ticket): value is Reply {
      if (!keys(value, ["kind", "bindingId", "generation", "requestId", "sourceVersion", "history", "sourceAuthenticated", "publishable", "cleanupConfirmed"])
        || value.kind !== "bound_history_observation" || value.bindingId !== ticket.scope.bindingId || value.generation !== ticket.scope.generation
        || value.requestId !== ticket.request.requestId || !hash(value.sourceVersion) || value.sourceAuthenticated !== false || value.publishable !== false
        || value.cleanupConfirmed !== true || !keys(value.history, ["kind", "source", "page", "observation", "reader", "metrics"])) return false;
      const h = value.history, o = h.observation;
      if (h.kind !== "source_history_observation" || !pageValid(h.page) || h.page.offset !== ticket.page.offset || h.page.limit !== ticket.page.limit
        || !object(h.source) || h.source.sessionId !== ticket.scope.sessionId || h.source.sourceAuthenticated !== false || h.source.publishable !== false
        || !object(h.reader) || !object(o) || o.sessionId !== ticket.scope.sessionId || o.publishable !== false
        || !hash(o.sourceDigest) || !hash(o.selectionDigest) || !Array.isArray(o.messages) || o.messages.length > ticket.page.limit
        || !o.messages.every(m => object(m) && uuid(m.nativeMessageId))
        || !keys(o.authority, ["sourceAuthenticated", "approvalAcknowledged", "runTerminalObserved", "resumeAllowed"])
        || !Object.values(o.authority).every(v => v === false)) return false;
      const verified: unknown = validateHistory(h, ticket.scope.sessionId, { ...ticket.page });
      if (verified === true) return true;
      // The dependency is synchronous by contract. Reject accidental Promises,
      // but absorb their rejection so a bad adapter cannot cause an unhandled
      // asynchronous error. Intrinsic Promise brand-check avoids then getters.
      try { void Promise.prototype.then.call(verified as Promise<unknown>, undefined, () => undefined); } catch { /* not a Promise */ }
      return false;
    }
    function integrate(result: Reply, ticket: Ticket): Outcome {
      const h = result.history;
      // Whole-source hash + filesystem identity + reader profile + canonical
      // source digest must match too, not only an opaque token echoed by a Host.
      const nextIdentity = canonicalJSON({ source: h.source, reader: h.reader, sourceDigest: h.observation.sourceDigest }, LIMITS.responseBytes);
      if (nextIdentity === null) return fail("history_response_invalid");
      if (ticket.mode !== "refresh" && (result.sourceVersion !== ticket.version || result.sourceVersion !== version || nextIdentity !== identity))
        return fail("history_version_mismatch");
      const incoming: StoredPage = { ...ticket.page, observation: h.observation };
      if (ticket.mode === "previous" && h.observation.messages.length !== ticket.page.limit) return fail("history_page_gap");
      const next = ticket.mode === "refresh" ? [incoming] : ticket.mode === "previous" ? [incoming, ...pages]
        : h.observation.messages.length ? [...pages, incoming] : pages;
      const ids = new Set<string>(); let messageCount = 0;
      for (const p of next) for (const m of p.observation.messages) {
        if (ids.has(m.nativeMessageId)) return fail("history_duplicate_message"); ids.add(m.nativeMessageId); messageCount++;
      }
      if (messageCount > LIMITS.messages || next.length > LIMITS.pages || canonicalJSON(next, LIMITS.retainedBytes) === null)
        return fail("history_view_limit");
      // Commit all page/view fields together, only after every check succeeds.
      pages = next; version = result.sourceVersion; identity = nextIdentity; stale = false; error = null;
      if (ticket.mode !== "previous") reachedEnd = h.observation.messages.length < ticket.page.limit;
      return { kind: "applied" };
    }
    async function run(mode: Mode, page: Page): Promise<Outcome> {
      if (disposed) return unavailable("history_disposed");
      if (!scope) return unavailable("history_scope_required");
      const detachedPage = detach<Page>(page, 1024);
      if (!pageValid(detachedPage)) return unavailable("invalid_history_page");
      if (mode === "refresh") cancel();
      else {
        if (pending) return unavailable("history_busy");
        if (stale || !version || !pages.length) return unavailable("history_refresh_required");
      }
      let id: string;
      try { id = requestId(); } catch { return fail("history_request_unavailable"); }
      if (!uuid(id)) return fail("history_request_unavailable");
      const ticket: Ticket = { mode, scope: { ...scope }, request: { bindingId: scope.bindingId, generation: scope.generation, requestId: id },
        page: detachedPage, ...(mode === "refresh" ? {} : { version: version! }), abort: new AbortController() };
      pending = ticket; error = null;
      try {
        const raw = await read({ ...ticket.scope }, { ...ticket.request },
          { page: { ...ticket.page }, ...(ticket.version ? { version: ticket.version } : {}), signal: ticket.abort.signal });
        // Check before parsing/validation: old responses must not cost a decode
        // or mutate a different Host, session, generation or refreshed view.
        if (pending !== ticket || disposed || ticket.abort.signal.aborted) return { kind: "ignored" };
        const value = detach<unknown>(raw, LIMITS.responseBytes);
        if (keys(value, ["kind", "code"]) && value.kind === "source_unavailable")
          return fail(typeof value.code === "string" && sourceFailures.has(value.code) ? value.code : "history_read_failed");
        if (!validReply(value, ticket)) return fail("history_response_invalid");
        return integrate(value, ticket);
      } catch {
        if (pending !== ticket || disposed || ticket.abort.signal.aborted) return { kind: "ignored" };
        return fail("history_transport_failed"); // No raw path, exception or transcript diagnostics.
      } finally { if (pending === ticket) pending = null; }
    }
    function refresh(page: Page = { offset: 0, limit: 25 }): Promise<Outcome> { return run("refresh", page); }
    function loadNext(limit = 25): Promise<Outcome> {
      if (disposed) return Promise.resolve(unavailable("history_disposed"));
      if (pending) return Promise.resolve(unavailable("history_busy"));
      if (stale || !version || !pages.length) return Promise.resolve(unavailable("history_refresh_required"));
      if (reachedEnd) return Promise.resolve(unavailable("history_end_reached"));
      const last = pages.at(-1)!; return run("next", { offset: last.offset + last.observation.messages.length, limit });
    }
    function loadPrevious(limit = 25): Promise<Outcome> {
      if (disposed) return Promise.resolve(unavailable("history_disposed"));
      if (pending) return Promise.resolve(unavailable("history_busy"));
      if (stale || !version || !pages.length) return Promise.resolve(unavailable("history_refresh_required"));
      if (!positive(limit) || limit > LIMITS.pageMessages) return Promise.resolve(unavailable("invalid_history_page"));
      const start = pages[0].offset;
      if (start === 0) return Promise.resolve(unavailable("history_start_reached"));
      return run("previous", { offset: Math.max(0, start - limit), limit: Math.min(start, limit) });
    }
    function dispose(): void { cancel(); disposed = true; scope = null; pages = []; version = identity = null; error = null; stale = reachedEnd = false; }
    return Object.freeze({ reset, refresh, loadNext, loadPrevious, cancel, dispose, state });
  }
}
if (typeof module !== "undefined") module.exports = StepsembleHistoryPages;
