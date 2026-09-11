/// <reference path="./history-pages.ts" />
/// <reference path="./codex-history-records.ts" />
declare function require(name: "./codex-history-records"): typeof StepsembleCodexHistoryRecords;
/** Same-origin history HTTP transport. No SDK, source paths, bearer
 * credentials, legacy relay fallback or journal writes.
 * Cookie authentication and ownership remain the Host's responsibility. */
namespace StepsembleHistoryTransport {
  const codexRecords = typeof module !== "undefined" ? require("./codex-history-records") : StepsembleCodexHistoryRecords;
  type ObjectValue = Record<string, unknown>;
  export const LIMITS = Object.freeze({ responseBytes: 384 * 1024, claudeResponseBytes: 272 * 1024, requestBytes: 4096, timeoutMs: 15000 });
  export interface Dependencies {
    /** Trusted application origin, never a history-row URL. In a browser this
     * must equal location.origin. Only fixed local/paired history paths are supported. */
    origin: string; hostId: string; viewId: string;
    /** Empty for local; otherwise one exact dedicated-peer route. Never a URL. */
    routePrefix?: string;
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
  export type SourceGroup = { sourceId: string; label: string; description: string } &
    ({ agentId: "claude-code"; scope: "main_sessions" } | { agentId: "codex"; scope: "stored_threads" });
  export interface Sources { kind: "history_sources"; sources: SourceGroup[]; sourceAuthenticated: false; publishable: false }
  export interface SourceCatalogRequest { sourceId: string; page: { offset: number; limit: number }; snapshotId: string | null; refresh: boolean }
  export interface SourceCandidate { catalogId: string; nativeTitle: null; titleStatus: "not_loaded" }
  export interface SourceCatalog {
    kind: "history_source_catalog"; sourceId: string; snapshotId: string | null; stale: boolean; refreshing: boolean; lastError: string | null;
    total: number; page: { offset: number; limit: number }; nextOffset: number | null; entries: SourceCandidate[]; sourceAuthenticated: false; publishable: false;
  }
  export interface MetadataRequest { sourceId: string; catalogId: string; snapshotId: string; requestId: string }
  export interface SessionMetadata { sessionId: string; nativeTitle: string | null; summary: string | null; titleStatus: "native" | "untitled" }
  export interface SourceMetadata extends MetadataRequest { kind: "history_source_metadata"; metadata: SessionMetadata; sourceAuthenticated: false; publishable: false }
  export interface Unavailable { kind: "source_unavailable"; code: string }
  export interface CodexCheckpointRequest extends ReleaseRequest { requestId: string }
  export interface CodexCheckpoint {
    kind: "bound_codex_paginated_checkpoint"; bindingId: string; generation: number; requestId: string;
    sourceVersion: Record<string, unknown>; checkpoint: Record<string, unknown>; evidence: Record<string, unknown>;
    consistency: "single_history_database_observation"; snapshotAtomic: false; historyComplete: false;
    sourceAuthenticated: false; publishable: false; cleanupConfirmed: true;
  }
  export interface CodexReadOptions extends StepsembleHistoryPages.ReadOptions { structured?: true; profile?: StepsembleCodexHistoryRecords.PageProfile }
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
    "history_catalog_changed", "source_inventory_limit", "source_worker_failure", "source_metadata_invalid",
    "history_unauthorized", "history_origin_rejected", "history_csrf_rejected", "history_content_type_rejected",
    "history_body_too_large", "history_body_invalid", "history_request_timeout", "history_request_aborted",
    "history_response_too_large", "history_response_invalid", "history_transport_failed", "history_method_not_allowed",
    "source_busy", "source_aborted", "source_version_changed", "source_version_unavailable", "source_observation_too_large",
    "source_platform_unsupported", "source_missing", "source_empty", "source_changed", "source_incomplete_tail", "source_invalid_json",
    "source_access_denied", "source_read_budget", "source_worker_timeout", "source_cleanup_unconfirmed", "source_service_quarantined",
    "source_acl_unavailable", "source_acl_unsupported", "source_root_identity_changed", "source_containment_unavailable",
    "source_identity_unavailable", "source_close_failed",
    "source_scope_mismatch", "source_encoding_unsupported", "source_too_large", "source_sqlite_unsupported", "source_database_unsupported", "source_database_unavailable", "source_cancelled", "source_record_limit",
    "native_paginated_history_unsupported", "native_history_mode_unknown", "rollout_incomplete_tail", "rollout_record_limit",
    "rollout_compression_limit", "rollout_compression_invalid", "rollout_compression_unsupported",
    "rollout_structure_invalid", "rollout_structure_page_limit",
    "rollout_invalid_utf8", "rollout_invalid_record", "rollout_selected_thread_mismatch", "rollout_invalid_metadata",
    "name_resolution_rollout_mismatch", "name_resolution_missing_row_unsupported", "name_resolution_index_unavailable",
    "source_service_closed", "source_binding_revoked", "source_binding_mismatch", "source_sdk_unavailable"]);
  const pageValid = (v: unknown): boolean => keys(v, ["offset", "limit"]) && Number.isSafeInteger(v.offset)
    && (v.offset as number) >= 0 && (v.offset as number) <= 2000 && positive(v.limit) && v.limit <= 100;
  const reference = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9:_-]{1,128}$/.test(v);
  const sourceUuid = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(v);
  const count = (v: unknown, max: number): v is number => Number.isSafeInteger(v) && (v as number) >= 0 && (v as number) <= max;
  const text = (v: unknown, max: number, min = 0): v is string => typeof v === "string" && v.length >= min && v.length <= max && !/[\u0000-\u001f\u007f]/.test(v);
  const catalogId = (v: unknown): v is string => typeof v === "string" && /^(claude|codex)-[a-f0-9]{64}$/.test(v);
  const decimal64 = (v: unknown): v is string => typeof v === "string" && /^(0|[1-9]\d{0,19})$/.test(v) && BigInt(v) <= 18446744073709551615n;
  const signed64 = (v: unknown): v is string => typeof v === "string" && /^(0|-?[1-9]\d{0,18})$/.test(v)
    && BigInt(v) >= -9223372036854775808n && BigInt(v) <= 9223372036854775807n;
  const nonnegative64 = (v: unknown): v is string => signed64(v) && BigInt(v) >= 0n;
  const rootIdentityValid = (v: unknown): boolean => keys(v, ["device", "inode"]) && decimal64(v.device) && decimal64(v.inode) && v.inode !== "0";
  const checkpointIdentityList = (v: unknown): boolean => {
    const roles = ["database", "wal", "shm"];
    return Array.isArray(v) && v.length === roles.length && roles.every((role, index) => {
      const item = v[index]; return keys(item, ["role", "device", "inode"]) && item.role === role && rootIdentityValid({ device: item.device, inode: item.inode });
    }) && new Set(v.map(item => `${item.device}:${item.inode}`)).size === roles.length;
  };
  const checkpointObservationValid = (v: unknown, sessionId: string): boolean => {
    if (!keys(v, ["kind", "nativeVersion", "sqliteVersion", "scope", "threadId", "checkpoint", "turns", "itemCount", "maxItemOrdinal",
      "sourceAuthenticated", "publishable", "historyComplete", "connectionClosed"])) return false;
    const value = v as ObjectValue, point = value.checkpoint;
    const validPoint = point === null || keys(point, ["nextRolloutByteOffset", "nextRolloutOrdinal"])
      && nonnegative64(point.nextRolloutByteOffset) && nonnegative64(point.nextRolloutOrdinal);
    return value.kind === "codex_paginated_projection_checkpoint" && value.nativeVersion === "0.153.4" && value.sqliteVersion === "3.53.4"
      && value.scope === "provided_history_database_selected_thread_projection_only" && value.threadId === sessionId && sourceUuid(value.threadId)
      && validPoint && Array.isArray(value.turns) && value.turns.length <= 2048 && nonnegative64(value.itemCount)
      && (value.maxItemOrdinal === null || nonnegative64(value.maxItemOrdinal)) && value.sourceAuthenticated === false
      && value.publishable === false && value.historyComplete === false && value.connectionClosed === true;
  };
  const checkpointEvidenceValid = (v: unknown, sessionId: string): boolean => {
    if (!keys(v, ["observation", "identities", "filesystemChecksPassed", "sourceDescriptorsClosed", "sqliteDescriptorsOpened",
      "sqliteDescriptorsClosed", "shmMappingsClosed", "requestedReadBytes", "readCalls", "mappedShmBytes", "sourceAuthenticated", "publishable"])) return false;
    const value = v as ObjectValue;
    return checkpointObservationValid(value.observation, sessionId) && checkpointIdentityList(value.identities)
      && value.filesystemChecksPassed === true && value.sourceDescriptorsClosed === 4 && value.sqliteDescriptorsOpened === 3
      && value.sqliteDescriptorsClosed === 3 && count(value.shmMappingsClosed, 256) && count(value.requestedReadBytes, 8 * 1024 * 1024)
      && (value.requestedReadBytes as number) > 0 && count(value.readCalls, 1024) && (value.readCalls as number) > 0
      && count(value.mappedShmBytes, 8 * 1024 * 1024) && value.sourceAuthenticated === false && value.publishable === false;
  };
  const checkpointSourceVersionValid = (v: unknown, sessionId: string): boolean => {
    if (!keys(v, ["kind", "nativeVersion", "threadId", "rootIdentity", "identities", "checkpointSha256"])) return false;
    const value = v as ObjectValue;
    return value.kind === "codex_paginated_projection_checkpoint_version" && value.nativeVersion === "0.153.4"
      && value.threadId === sessionId && sourceUuid(value.threadId) && rootIdentityValid(value.rootIdentity)
      && checkpointIdentityList(value.identities) && hash(value.checkpointSha256);
  };
  export function validBoundCheckpoint(v: unknown, sessionId: string, request?: Partial<CodexCheckpointRequest>): v is CodexCheckpoint {
    if (!keys(v, ["kind", "bindingId", "generation", "requestId", "sourceVersion", "checkpoint", "evidence", "consistency",
      "snapshotAtomic", "historyComplete", "sourceAuthenticated", "publishable", "cleanupConfirmed"])) return false;
    const value = v as ObjectValue;
    return value.kind === "bound_codex_paginated_checkpoint" && uuid(value.bindingId) && positive(value.generation) && uuid(value.requestId)
      && (request?.bindingId === undefined || value.bindingId === request.bindingId)
      && (request?.generation === undefined || value.generation === request.generation)
      && (request?.requestId === undefined || value.requestId === request.requestId)
      && checkpointSourceVersionValid(value.sourceVersion, sessionId) && checkpointObservationValid(value.checkpoint, sessionId)
      && checkpointEvidenceValid(value.evidence, sessionId) && value.consistency === "single_history_database_observation"
      && value.snapshotAtomic === false && value.historyComplete === false && value.sourceAuthenticated === false
      && value.publishable === false && value.cleanupConfirmed === true;
  }
  export function validSources(v: unknown): v is Sources {
    return keys(v, ["kind", "sources", "sourceAuthenticated", "publishable"]) && v.kind === "history_sources"
      && v.sourceAuthenticated === false && v.publishable === false && Array.isArray(v.sources) && v.sources.length <= 8
      && new Set(v.sources.map(g => g?.sourceId)).size === v.sources.length
      && v.sources.every(g => keys(g, ["sourceId", "agentId", "scope", "label", "description"]) && reference(g.sourceId)
        && (g.agentId === "claude-code" && g.scope === "main_sessions" || g.agentId === "codex" && g.scope === "stored_threads") && text(g.label, 120, 1) && text(g.description, 300));
  }
  export function validSourceCatalogRequest(v: unknown): v is SourceCatalogRequest {
    return keys(v, ["sourceId", "page", "snapshotId", "refresh"]) && reference(v.sourceId)
      && keys(v.page, ["offset", "limit"]) && count(v.page.offset, 2048) && count(v.page.limit, 50) && v.page.limit > 0
      && (v.snapshotId === null || sourceUuid(v.snapshotId)) && typeof v.refresh === "boolean"
      && (v.page.offset === 0 || v.snapshotId !== null) && (!v.refresh || v.page.offset === 0 && v.snapshotId === null);
  }
  export function validSourceCatalog(v: unknown, request: unknown): v is SourceCatalog {
    return validSourceCatalogRequest(request) && keys(v, ["kind", "sourceId", "snapshotId", "stale", "refreshing", "lastError", "total", "page",
      "nextOffset", "entries", "sourceAuthenticated", "publishable"]) && v.kind === "history_source_catalog"
      && v.sourceId === request.sourceId && (v.snapshotId === null || sourceUuid(v.snapshotId))
      && (request.snapshotId === null || request.snapshotId === v.snapshotId) && (!request.refresh || v.snapshotId !== null)
      && typeof v.stale === "boolean" && typeof v.refreshing === "boolean" && (v.lastError === null || typeof v.lastError === "string" && sourceCodes.has(v.lastError))
      && count(v.total, 2048) && keys(v.page, ["offset", "limit"]) && v.page.offset === request.page.offset && v.page.limit === request.page.limit
      && request.page.offset <= v.total && Array.isArray(v.entries) && v.entries.length === Math.min(request.page.limit, v.total - request.page.offset)
      && v.entries.every(e => keys(e, ["catalogId", "nativeTitle", "titleStatus"]) && catalogId(e.catalogId) && e.nativeTitle === null && e.titleStatus === "not_loaded")
      && new Set(v.entries.map(e => e.catalogId)).size === v.entries.length
      && v.nextOffset === (request.page.offset + v.entries.length < v.total ? request.page.offset + v.entries.length : null)
      && (v.snapshotId !== null || v.total === 0 && v.stale === true) && v.sourceAuthenticated === false && v.publishable === false;
  }
  export function validMetadataRequest(v: unknown): v is MetadataRequest {
    return keys(v, ["sourceId", "catalogId", "snapshotId", "requestId"]) && reference(v.sourceId) && catalogId(v.catalogId) && sourceUuid(v.snapshotId) && sourceUuid(v.requestId);
  }
  export function validSourceMetadata(v: unknown, request: unknown): v is SourceMetadata {
    const metadataText = (v: unknown, max: number): v is string => typeof v === "string" && v.length > 0 && v.length <= max
      && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(v);
    return validMetadataRequest(request) && keys(v, ["kind", "sourceId", "catalogId", "snapshotId", "requestId", "metadata", "sourceAuthenticated", "publishable"])
      && v.kind === "history_source_metadata" && v.sourceId === request.sourceId && v.catalogId === request.catalogId
      && v.snapshotId === request.snapshotId && v.requestId === request.requestId
      && keys(v.metadata, ["sessionId", "nativeTitle", "summary", "titleStatus"]) && sourceUuid(v.metadata.sessionId)
      && (v.metadata.summary === null || !request.catalogId.startsWith("codex-") && metadataText(v.metadata.summary, 4096))
      && (v.metadata.titleStatus === "native" && (request.catalogId.startsWith("codex-") ? typeof v.metadata.nativeTitle === "string" && codexRecords.validTitle(v.metadata.nativeTitle) : metadataText(v.metadata.nativeTitle, 1024))
        || v.metadata.titleStatus === "untitled" && v.metadata.nativeTitle === null)
      && v.sourceAuthenticated === false && v.publishable === false;
  }

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
    const routePrefix = deps.routePrefix ?? "";
    if (typeof routePrefix !== "string" || routePrefix !== "" && !/^\/r\/[a-z0-9-]{1,48}$/.test(routePrefix)) failure("history_route_invalid");
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
        const url = origin + routePrefix + path;
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
    async function sources(signal?: AbortSignal): Promise<Sources | Unavailable> {
      const { value, ok } = await exchange("/api/history/sources", "POST", {}, signal);
      const denied = unavailable(value); if (denied) return denied;
      if (!ok || !validSources(value)) return failure("history_response_invalid");
      return value;
    }
    async function sourceCatalog(input: SourceCatalogRequest, signal?: AbortSignal): Promise<SourceCatalog | Unavailable> {
      const request = detach(input); if (!validSourceCatalogRequest(request)) return failure("history_request_invalid");
      const { value, ok } = await exchange("/api/history/source-catalog", "POST", request, signal);
      const denied = unavailable(value); if (denied) return denied;
      if (!ok || !validSourceCatalog(value, request)) return failure("history_response_invalid");
      return value;
    }
    async function sourceMetadata(input: MetadataRequest, signal?: AbortSignal): Promise<SourceMetadata | Unavailable> {
      const request = detach(input); if (!validMetadataRequest(request)) return failure("history_request_invalid");
      const { value, ok } = await exchange("/api/history/source-metadata", "POST", request, signal);
      const denied = unavailable(value); if (denied) return denied;
      if (!ok || !validSourceMetadata(value, request)) return failure("history_response_invalid");
      return value;
    }
    async function readCodexCheckpoint(scope: StepsembleHistoryPages.Scope, request: CodexCheckpointRequest, signal?: AbortSignal): Promise<CodexCheckpoint | Unavailable> {
      const expected = detach({ scope, request });
      if (!object(expected) || !keys(expected.scope, ["hostId", "bindingId", "generation", "sessionId"])
        || expected.scope.hostId !== hostId || !uuid(expected.scope.bindingId) || !uuid(expected.scope.sessionId) || !positive(expected.scope.generation)
        || !keys(expected.request, ["bindingId", "generation", "requestId"]) || !uuid(expected.request.requestId)
        || expected.request.bindingId !== expected.scope.bindingId || expected.request.generation !== expected.scope.generation)
        return failure("history_request_invalid");
      const { value, ok } = await exchange("/api/history/checkpoint", "POST", expected.request, signal);
      const denied = unavailable(value); if (denied) return denied;
      let bound = false;
      try {
        bound = object(value) && canonicalJSON(value.checkpoint, LIMITS.responseBytes) !== null
          && canonicalJSON(value.checkpoint, LIMITS.responseBytes) === canonicalJSON((value.evidence as ObjectValue | undefined)?.observation, LIMITS.responseBytes);
      } catch { bound = false; }
      if (!ok || !validBoundCheckpoint(value, expected.scope.sessionId, expected.request) || !bound) return failure("history_response_invalid");
      return value as unknown as CodexCheckpoint;
    }
    async function read(scope: StepsembleHistoryPages.Scope, request: StepsembleHistoryPages.Request, options: CodexReadOptions, codex = false): Promise<unknown> {
      if (!keys(options, ["page", "signal", ...(options?.version === undefined ? [] : ["version"]), ...(Object.hasOwn(options ?? {}, "structured") ? ["structured"] : []), ...(Object.hasOwn(options ?? {}, "profile") ? ["profile"] : [])])
        || Object.hasOwn(options, "structured") && (!codex || options.structured !== true)
        || Object.hasOwn(options, "profile") && (!codex || !codexRecords.validProfile(options.profile) || options.structured !== undefined)) return failure("history_request_invalid");
      const expected = detach({ scope, request, page: options.page, ...(options.profile === undefined ? {} : { profile: options.profile }), ...(options.structured === true ? { structured: true } : {}), ...(options.version === undefined ? {} : { version: options.version }) });
      if (!object(expected) || !keys(expected.scope, ["hostId", "bindingId", "generation", "sessionId"])
        || expected.scope.hostId !== hostId || !uuid(expected.scope.bindingId) || !uuid(expected.scope.sessionId) || !positive(expected.scope.generation)
        || !keys(expected.request, ["bindingId", "generation", "requestId"]) || !uuid(expected.request.requestId)
        || expected.request.bindingId !== expected.scope.bindingId || expected.request.generation !== expected.scope.generation
        || !(codex ? codexRecords.validPage(expected.page, expected.profile) : pageValid(expected.page)) || ("version" in expected && !hash(expected.version))) return failure("history_request_invalid");
      const body = { ...expected.request, page: expected.page, ...("profile" in expected ? { profile: expected.profile } : {}), ...("structured" in expected ? { structured: expected.structured } : {}), ...("version" in expected ? { version: expected.version } : {}) };
      const { value, ok } = await exchange("/api/history/page", "POST", body, options.signal);
      const denied = unavailable(value); if (denied) return denied;
      if (codex) {
        if (!ok || !codexRecords.validBoundRecords(value, expected.scope.sessionId, expected.page as StepsembleCodexHistoryRecords.Page,
          body as unknown as StepsembleCodexHistoryRecords.Scope)) return failure("history_response_invalid");
        return value;
      }
      if (!ok || canonicalJSON(value, LIMITS.claudeResponseBytes) === null || !keys(value, ["kind", "bindingId", "generation", "requestId", "sourceVersion", "history", "sourceAuthenticated", "publishable", "cleanupConfirmed"])
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
    return Object.freeze({ catalog, sources, sourceCatalog, sourceMetadata, register, read: (scope: StepsembleHistoryPages.Scope, request: StepsembleHistoryPages.Request, options: StepsembleHistoryPages.ReadOptions) => read(scope, request, options),
      readCodex: (scope: StepsembleHistoryPages.Scope, request: StepsembleHistoryPages.Request, options: CodexReadOptions) => read(scope, request, options, true),
      readCodexCheckpoint, release });
  }
}
if (typeof module !== "undefined") module.exports = StepsembleHistoryTransport;
