/// <reference path="./history-pages.ts" />
/** Reserved same-origin history HTTP transport. No SDK, source paths, bearer
 * credentials, relay fallback, journal writes or production route installation.
 * Cookie authentication and ownership remain the Host's responsibility. */
namespace StepsembleHistoryTransport {
  type ObjectValue = Record<string, unknown>;
  export const LIMITS = Object.freeze({ responseBytes: 272 * 1024, requestBytes: 4096, timeoutMs: 15000 });
  export interface Dependencies {
    /** Trusted application origin, never a history-row URL. In a browser this
     * must equal location.origin. Only fixed /api/history paths are supported. */
    origin: string; hostId: string; viewId: string;
    canonicalJSON(value: unknown, maxBytes: number): string | null;
    fetch?: typeof fetch;
    /** Local transport deadline, never forwarded as source authority. */
    timeoutMs?: number;
  }
  export interface RegistrationRequest { catalogId: string; viewId: string }
  export interface ReleaseRequest { bindingId: string; generation: number }
  export interface Registration extends RegistrationRequest, ReleaseRequest {
    kind: "history_registration"; sessionId: string; expiresAt: number;
    sourceAuthenticated: false; publishable: false;
  }
  export interface Released { kind: "history_released"; cleanupConfirmed: boolean }
  export interface CatalogEntry { catalogId: string; label: string; description: string }
  export interface Catalog { kind: "history_catalog"; entries: CatalogEntry[]; sourceAuthenticated: false; publishable: false }
  export interface Unavailable { kind: "source_unavailable"; code: string }
  export class TransportError extends Error {
    constructor(public readonly code: string) { super(code); this.name = "HistoryTransportError"; }
  }
  const object = (v: unknown): v is ObjectValue => v !== null && typeof v === "object" && !Array.isArray(v);
  const keys = (v: unknown, expected: string[]): v is ObjectValue => object(v)
    && Object.keys(v).sort().join(",") === [...expected].sort().join(",");
  const uuid = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(v);
  const positive = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) > 0;
  const opaque = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9_.:-]{1,128}$/.test(v);
  const hash = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
  const failure = (code: string): never => { throw new TransportError(code); };
  const sourceCodes = new Set(["invalid_history_registration", "invalid_history_request", "invalid_history_release", "invalid_source_signal",
    "history_principal_unavailable", "history_source_unavailable", "history_binding_unavailable", "history_view_conflict",
    "history_capacity_unavailable", "history_registry_closed", "history_registry_unavailable",
    "history_unauthorized", "history_origin_rejected", "history_csrf_rejected", "history_content_type_rejected",
    "history_body_too_large", "history_body_invalid", "history_request_timeout", "history_request_aborted",
    "history_response_too_large", "history_response_invalid", "history_transport_failed", "history_method_not_allowed",
    "source_busy", "source_aborted", "source_version_changed", "source_version_unavailable", "source_observation_too_large",
    "source_platform_unsupported", "source_missing", "source_empty", "source_changed", "source_incomplete_tail", "source_invalid_json",
    "source_access_denied", "source_read_budget", "source_worker_timeout", "source_cleanup_unconfirmed", "source_service_quarantined",
    "source_acl_unavailable", "source_acl_unsupported", "source_root_identity_changed", "source_containment_unavailable",
    "source_identity_unavailable", "source_close_failed",
    "source_service_closed", "source_binding_revoked", "source_binding_mismatch", "source_sdk_unavailable"]);
  const pageValid = (v: unknown): boolean => keys(v, ["offset", "limit"]) && Number.isSafeInteger(v.offset)
    && (v.offset as number) >= 0 && (v.offset as number) <= 2000 && positive(v.limit) && v.limit <= 100;

  export function create(deps: Dependencies) {
    if (typeof deps?.canonicalJSON !== "function" || !opaque(deps.hostId) || !uuid(deps.viewId)) failure("history_dependencies_required");
    let origin: string;
    try {
      const url = new URL(deps.origin);
      if (!["http:", "https:"].includes(url.protocol) || url.origin !== deps.origin || url.username || url.password
        || (typeof location !== "undefined" && location.origin !== url.origin)) failure("history_origin_invalid");
      origin = url.origin;
    } catch { return failure("history_origin_invalid"); }
    const { hostId, viewId, canonicalJSON } = deps;
    const transport = deps.fetch ?? globalThis.fetch.bind(globalThis);
    const timeoutMs = deps.timeoutMs ?? LIMITS.timeoutMs;
    if (typeof transport !== "function" || !positive(timeoutMs) || timeoutMs > 120000) failure("history_dependencies_required");
    function detach(value: unknown): unknown {
      try { const text = canonicalJSON(value, LIMITS.requestBytes); return text === null ? null : JSON.parse(text); } catch { return null; }
    }
    async function exchange(path: string, method: "POST" | "DELETE", body: unknown, signal?: AbortSignal): Promise<{ value: unknown; ok: boolean }> {
      const controller = new AbortController();
      let reader: ReadableStreamDefaultReader<Uint8Array> | null = null, response: Response | null = null;
      let stopped = false, completed = false, cancelledBody = false;
      let interrupt: ((reason: TransportError) => void) | null = null;
      // Only one pending operation owns the cancellation callback. Racing each
      // chunk against one never-settled promise would retain a reaction per
      // chunk until cancellation, defeating bounded tiny-chunk retention.
      const wait = <T>(flight: Promise<T>): Promise<T> => new Promise((resolve, reject) => {
        let settled = false;
        const cancel = (reason: TransportError) => { if (!settled) { settled = true; interrupt = null; reject(reason); } };
        interrupt = cancel;
        flight.then(value => {
          if (!settled) { settled = true; if (interrupt === cancel) interrupt = null; resolve(value); }
        }, reason => {
          if (!settled) { settled = true; if (interrupt === cancel) interrupt = null; reject(reason); }
        });
        if (stopped) cancel(new TransportError("history_aborted"));
      });
      const cancelBody = () => {
        if (cancelledBody || !response?.body) return;
        cancelledBody = true;
        try { void (reader ? reader.cancel() : response.body.cancel()).catch(() => undefined); } catch { /* cleanup only */ }
      };
      const stop = (code: string) => {
        if (stopped) return;
        stopped = true; controller.abort(); cancelBody(); interrupt?.(new TransportError(code));
      };
      const abort = () => stop("history_aborted");
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        if (signal?.aborted) return failure("history_aborted");
        signal?.addEventListener("abort", abort, { once: true });
        // Handle a signal implementation that changes during subscription.
        if (signal?.aborted) abort();
        timer = setTimeout(() => stop("history_timeout"), timeoutMs);
        const url = origin + path;
        const flight = Promise.resolve().then(() => {
          if (stopped) return failure("history_aborted");
          return transport(url, { method, credentials: "same-origin", mode: "same-origin", redirect: "error", cache: "no-store",
            headers: { "Content-Type": "application/json", "Accept": "application/json", "X-Stepsemble-History-CSRF": "1", "X-Stepsemble-History-View": viewId },
            body: JSON.stringify(body), signal: controller.signal });
        }).then(result => {
          response = result;
          // Fetch adapters may ignore abort and resolve after our promise ends.
          if (stopped) cancelBody();
          return result;
        });
        response = await wait(flight);
        if (stopped || signal?.aborted) return failure("history_aborted");
        if (response.redirected || (response.url && response.url !== url)
          || !/^application\/json(?:\s*;\s*charset\s*=\s*utf-8)?\s*$/i.test(response.headers.get("content-type") ?? "")
          || !response.body) return failure("history_response_invalid");
        reader = response.body.getReader();
        // One fixed allocation bounds retention even for millions of tiny
        // chunks. Fetch body bytes are already decoded from Content-Encoding;
        // Content-Length is deliberately neither trusted nor used for sizing.
        const bytes = new Uint8Array(LIMITS.responseBytes); let length = 0;
        for (;;) {
          const chunk = await wait(reader.read());
          if (stopped || signal?.aborted) return failure("history_aborted");
          if (chunk.done) break;
          if (!(chunk.value instanceof Uint8Array)) return failure("history_response_invalid");
          if (chunk.value.byteLength > LIMITS.responseBytes - length) return failure("history_response_too_large");
          bytes.set(chunk.value, length); length += chunk.value.byteLength;
        }
        // Fence cancellation before any UTF-8/JSON work. The controller has an
        // additional ticket-identity fence before provider validation/commit.
        if (stopped || signal?.aborted) return failure("history_aborted");
        if (!length || (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf)) return failure("history_response_invalid");
        let value: unknown;
        try {
          value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, length)));
          if (canonicalJSON(value, LIMITS.responseBytes) === null) return failure("history_response_invalid");
        } catch { return failure("history_response_invalid"); }
        completed = true;
        return { value, ok: response.ok };
      } catch (error) {
        if (error instanceof TransportError) throw error;
        return failure("history_transport_failed");
      } finally {
        if (timer !== undefined) clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        if (!completed) { stopped = true; controller.abort(); cancelBody(); }
        try { reader?.releaseLock(); } catch { /* a broken adapter cannot replace sanitized results */ }
      }
    }
    function unavailable(value: unknown): Unavailable | null {
      if (!keys(value, ["kind", "code"]) || value.kind !== "source_unavailable" || typeof value.code !== "string") return null;
      return { kind: "source_unavailable", code: sourceCodes.has(value.code) ? value.code : "history_read_failed" };
    }
    async function catalog(signal?: AbortSignal): Promise<Catalog | Unavailable> {
      const { value, ok } = await exchange("/api/history/catalog", "POST", {}, signal);
      const denied = unavailable(value); if (denied) return denied;
      if (!ok || !keys(value, ["kind", "entries", "sourceAuthenticated", "publishable"]) || value.kind !== "history_catalog"
        || value.sourceAuthenticated !== false || value.publishable !== false || !Array.isArray(value.entries) || value.entries.length > 256
        || !value.entries.every(entry => keys(entry, ["catalogId", "label", "description"])
          && typeof entry.catalogId === "string" && /^[A-Za-z0-9:_-]{1,128}$/.test(entry.catalogId)
          && typeof entry.label === "string" && entry.label.length > 0 && entry.label.length <= 120 && !/[\u0000-\u001f\u007f]/.test(entry.label)
          && typeof entry.description === "string" && entry.description.length <= 300 && !/[\u0000-\u001f\u007f]/.test(entry.description))
        || new Set(value.entries.map(entry => entry.catalogId)).size !== value.entries.length) return failure("history_response_invalid");
      return value as unknown as Catalog;
    }
    async function register(input: RegistrationRequest, signal?: AbortSignal): Promise<Registration | Unavailable> {
      const request = detach(input);
      if (!keys(request, ["catalogId", "viewId"]) || typeof request.catalogId !== "string"
        || !/^[A-Za-z0-9:_-]{1,128}$/.test(request.catalogId) || request.viewId !== viewId) return failure("history_request_invalid");
      const { value, ok } = await exchange("/api/history/registrations", "POST", request, signal);
      const denied = unavailable(value); if (denied) return denied;
      if (!ok || !keys(value, ["kind", "bindingId", "generation", "sessionId", "viewId", "catalogId", "expiresAt", "sourceAuthenticated", "publishable"])
        || value.kind !== "history_registration" || !uuid(value.bindingId) || !positive(value.generation) || !uuid(value.sessionId)
        || value.viewId !== viewId || value.catalogId !== request.catalogId || !positive(value.expiresAt)
        || value.sourceAuthenticated !== false || value.publishable !== false) return failure("history_response_invalid");
      return value as unknown as Registration;
    }
    async function read(scope: StepsembleHistoryPages.Scope, request: StepsembleHistoryPages.Request, options: StepsembleHistoryPages.ReadOptions): Promise<unknown> {
      if (!keys(options, options?.version === undefined ? ["page", "signal"] : ["page", "signal", "version"])) return failure("history_request_invalid");
      const expected = detach({ scope, request, page: options.page, ...(options.version === undefined ? {} : { version: options.version }) });
      if (!object(expected) || !keys(expected.scope, ["hostId", "bindingId", "generation", "sessionId"])
        || expected.scope.hostId !== hostId || !uuid(expected.scope.bindingId) || !uuid(expected.scope.sessionId) || !positive(expected.scope.generation)
        || !keys(expected.request, ["bindingId", "generation", "requestId"]) || !uuid(expected.request.requestId)
        || expected.request.bindingId !== expected.scope.bindingId || expected.request.generation !== expected.scope.generation
        || !pageValid(expected.page) || ("version" in expected && !hash(expected.version))) return failure("history_request_invalid");
      const body = { ...expected.request, page: expected.page, ...("version" in expected ? { version: expected.version } : {}) };
      const { value, ok } = await exchange("/api/history/page", "POST", body, options.signal);
      const denied = unavailable(value); if (denied) return denied;
      if (!ok || !keys(value, ["kind", "bindingId", "generation", "requestId", "sourceVersion", "history", "sourceAuthenticated", "publishable", "cleanupConfirmed"])
        || value.kind !== "bound_history_observation" || value.bindingId !== expected.request.bindingId || value.generation !== expected.request.generation
        || value.requestId !== expected.request.requestId || !hash(value.sourceVersion) || value.sourceAuthenticated !== false
        || value.publishable !== false || value.cleanupConfirmed !== true || !keys(value.history, ["kind", "source", "page", "observation", "reader", "metrics"])
        || value.history.kind !== "source_history_observation") return failure("history_response_invalid");
      return value; // Full provider/session/page checks are mandatory in controller.
    }
    async function release(input: ReleaseRequest, signal?: AbortSignal): Promise<Released | Unavailable> {
      const request = detach(input);
      if (!keys(request, ["bindingId", "generation"]) || !uuid(request.bindingId) || !positive(request.generation)) return failure("history_request_invalid");
      const { value, ok } = await exchange(`/api/history/registrations/${request.bindingId}`, "DELETE", { generation: request.generation }, signal);
      const denied = unavailable(value); if (denied) return denied;
      if (!ok || !keys(value, ["kind", "cleanupConfirmed"]) || value.kind !== "history_released" || typeof value.cleanupConfirmed !== "boolean")
        return failure("history_response_invalid");
      return value as unknown as Released;
    }
    return Object.freeze({ catalog, register, read, release });
  }
}
if (typeof module !== "undefined") module.exports = StepsembleHistoryTransport;
