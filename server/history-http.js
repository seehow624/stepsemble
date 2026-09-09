"use strict";
// Reserved, injected HTTP boundary. No route is installed and no native source
// is discovered here. A Host must provide a reviewed catalog/registry, current
// authorization callbacks, revoke fan-out and trusted configured origins.
const { canonicalJSON } = require("../public/modules/projection");
const sourceCatalogWire = require("./history-catalog-wire");
const codexRecords = require("../public/modules/codex-history-records");
const LIMITS = Object.freeze({ requestBytes: 8192, responseBytes: 384 * 1024, claudeResponseBytes: 272 * 1024, requestChunks: 1024, deadlineMs: 15000 });
const VIEW_HEADER = "x-stepsemble-history-view", CSRF_HEADER = "x-stepsemble-history-csrf";
const uuid = v => typeof v === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(v);
const principalValid = v => typeof v === "string" && /^[A-Za-z0-9:_-]{1,128}$/.test(v);
const object = v => v !== null && typeof v === "object" && !Array.isArray(v);
const exact = (v, names) => object(v) && Object.keys(v).sort().join(",") === [...names].sort().join(",");
const positive = v => Number.isSafeInteger(v) && v > 0;
function inertHistory(value, page) {
  if (!exact(value, ["kind", "source", "page", "observation", "reader", "metrics"]) || value.kind !== "source_history_observation"
    || !exact(value.page, ["offset", "limit"]) || value.page.offset !== page.offset || value.page.limit !== page.limit
    || !object(value.source) || value.source.sourceAuthenticated !== false || value.source.publishable !== false
    || !object(value.observation) || value.observation.publishable !== false
    || !exact(value.observation.authority, ["sourceAuthenticated", "approvalAcknowledged", "runTerminalObserved", "resumeAllowed"])) return false;
  return Object.values(value.observation.authority).every(v => v === false);
}
const error = (code, status = 400) => Object.assign(new Error(code), { code, status });
const unavailable = code => ({ kind: "source_unavailable", code });
// Only fixed codes cross HTTP. Never serialize an exception, raw diagnostic,
// credential, source path or caller-provided error string.
const PUBLIC_CODES = new Set([
  "invalid_history_registration", "invalid_history_request", "invalid_history_release", "invalid_source_signal",
  "history_principal_unavailable", "history_source_unavailable", "history_binding_unavailable", "history_view_conflict",
  "history_capacity_unavailable", "history_registry_closed", "history_registry_unavailable",
  "history_catalog_changed", "source_inventory_limit", "source_worker_failure", "source_metadata_invalid",
  "source_busy", "source_aborted", "source_version_changed", "source_version_unavailable", "source_observation_too_large",
  "source_platform_unsupported", "source_missing", "source_empty", "source_changed", "source_incomplete_tail", "source_invalid_json",
  "source_access_denied", "source_read_budget", "source_worker_timeout", "source_cleanup_unconfirmed", "source_service_quarantined",
  "source_acl_unavailable", "source_acl_unsupported", "source_root_identity_changed", "source_containment_unavailable",
  "source_identity_unavailable", "source_close_failed",
  "source_scope_mismatch", "source_encoding_unsupported", "source_too_large", "source_sqlite_unsupported",
  "native_paginated_history_unsupported", "native_history_mode_unknown", "rollout_incomplete_tail", "rollout_record_limit",
  "rollout_compression_limit", "rollout_compression_invalid", "rollout_compression_unsupported",
  "rollout_structure_invalid", "rollout_structure_page_limit",
  "rollout_invalid_utf8", "rollout_invalid_record", "rollout_selected_thread_mismatch", "rollout_invalid_metadata",
  "name_resolution_rollout_mismatch", "name_resolution_missing_row_unsupported", "name_resolution_index_unavailable",
  "source_service_closed", "source_binding_revoked", "source_binding_mismatch", "source_sdk_unavailable",
  "history_unauthorized", "history_origin_rejected", "history_csrf_rejected", "history_content_type_rejected",
  "history_body_too_large", "history_body_invalid", "history_request_timeout", "history_request_aborted",
  "history_response_too_large", "history_response_invalid", "history_transport_failed", "history_method_not_allowed",
]);

function configuredOrigin(value) {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password && value === url.origin ? value : null;
  } catch { return null; }
}

function readBody(req, signal) {
  return new Promise((resolve, reject) => {
    let size = 0, count = 0, done = false;
    const chunks = [];
    const cleanup = () => {
      req.removeListener("data", data); req.removeListener("end", end); req.removeListener("error", failed);
      signal.removeEventListener("abort", aborted);
    };
    const finish = (failure, value) => {
      if (done) return; done = true; cleanup(); chunks.length = 0;
      if (failure) { req.resume(); reject(failure); } else resolve(value);
    };
    const aborted = () => finish(error("history_request_aborted", 408));
    const failed = () => finish(error("history_body_invalid"));
    const data = chunk => {
      if (!Buffer.isBuffer(chunk)) return failed();
      size += chunk.length;
      if (size > LIMITS.requestBytes || ++count > LIMITS.requestChunks) return finish(error("history_body_too_large", 413));
      chunks.push(chunk);
    };
    const end = () => {
      try {
        const bytes = Buffer.concat(chunks, size);
        if (!size || bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))) return failed();
        const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
        // Bound depth/value shape too, after the independent raw-byte bound.
        if (!object(value) || canonicalJSON(value, LIMITS.requestBytes) === null) return failed();
        finish(null, value);
      } catch { failed(); }
    };
    req.on("data", data); req.on("end", end); req.on("error", failed);
    signal.addEventListener("abort", aborted, { once: true });
    if (signal.aborted) aborted();
  });
}

function send(res, status, value, close = false) {
  if (res.destroyed || res.writableEnded) return;
  const raw = canonicalJSON(value, LIMITS.responseBytes);
  if (raw === null) return send(res, 502, unavailable("history_response_too_large"), close);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer", "Cross-Origin-Resource-Policy": "same-origin",
    "Content-Length": Buffer.byteLength(raw), ...(close ? { Connection: "close" } : {}) });
  res.end(raw);
}

/** All auth callbacks are synchronous and trusted:
 * authenticateBrowserCookie(name, value) / authenticatePeerCredential(value)
 * return a stable opaque principal string or null. Peer lookup MUST check the
 * current revocable grant, not a cached successful authentication. Neither
 * callback may return the credential itself. isPrincipalCurrent(principal)
 * must check logout/revocation state. Host revoke fan-out remains mandatory.
 * Cookies shared by browser tabs are host authentication, not per-tab ACL.
 * The fixed CSRF header is an intent marker, not a secret; exact trusted Origin,
 * JSON and no CORS are the complementary browser boundary.
 */
function createHistoryRequestAuth({ auth, allowedOrigins, browserCookieNames = ["stepsemble"], browserOnly = false } = {}) {
  if (![auth?.authenticateBrowserCookie, auth?.authenticatePeerCredential, auth?.isPrincipalCurrent].every(v => typeof v === "function")
    || !Array.isArray(allowedOrigins) || !allowedOrigins.length || !allowedOrigins.every(configuredOrigin)
    || !Array.isArray(browserCookieNames) || !browserCookieNames.length
    || !browserCookieNames.every(v => typeof v === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(v))
    || typeof browserOnly !== "boolean") throw new TypeError("history_http_configuration_invalid");
  const origins = new Set(allowedOrigins), cookieNames = new Set(browserCookieNames);
  function authenticate(req) {
    const h = req.headers;
    // Reject duplicate security/framing headers even when Node joins them.
    const unique = new Set(["authorization", "cookie", "origin", VIEW_HEADER, CSRF_HEADER, "content-type", "content-length"]), seen = new Set();
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      const name = req.rawHeaders[i].toLowerCase();
      if (unique.has(name) && seen.has(name)) throw error("history_unauthorized", 401);
      seen.add(name);
    }
    let principal;
    if (Object.hasOwn(h, "authorization")) {
      if (browserOnly) throw error("history_unauthorized", 401);
      // Any cookie + Authorization is ambiguous, including invalid bearer.
      if (Object.hasOwn(h, "cookie") || typeof h.authorization !== "string" || !/^Bearer [a-f0-9]{64}$/.test(h.authorization))
        throw error("history_unauthorized", 401);
      // Origin-bearing callers must obey the browser intent/origin boundary
      // even if they possess a peer capability. Native peer callers omit it.
      if (Object.hasOwn(h, "origin")) browserIntent(h);
      const credential = h.authorization.slice(7);
      principal = auth.authenticatePeerCredential(credential);
      if (principal === credential) throw error("history_unauthorized", 401);
    } else {
      browserIntent(h);
      if (typeof h.cookie !== "string" || h.cookie.length > 4096) throw error("history_unauthorized", 401);
      const cookies = h.cookie.split(";").map(part => part.trim().split("="));
      const candidates = cookies.filter(([name]) => cookieNames.has(name));
      if (candidates.length !== 1 || candidates[0].length !== 2) throw error("history_unauthorized", 401);
      let value;
      try { value = decodeURIComponent(candidates[0][1]); } catch { throw error("history_unauthorized", 401); }
      principal = auth.authenticateBrowserCookie(candidates[0][0], value);
      if (principal === value) throw error("history_unauthorized", 401);
    }
    if (!principalValid(principal) || auth.isPrincipalCurrent(principal) !== true) throw error("history_unauthorized", 401);
    return principal;
  }
  function browserIntent(h) {
    if (!configuredOrigin(h.origin) || !origins.has(h.origin) || h["sec-fetch-site"] === "cross-site") throw error("history_origin_rejected", 403);
    if (h[CSRF_HEADER] !== "1") throw error("history_csrf_rejected", 403);
  }
  return authenticate;
}

function validCatalog(reply) {
  return exact(reply, ["kind", "entries", "sourceAuthenticated", "publishable"]) && reply.kind === "history_catalog"
    && reply.sourceAuthenticated === false && reply.publishable === false && Array.isArray(reply.entries) && reply.entries.length <= 256
    && new Set(reply.entries.map(v => v?.catalogId)).size === reply.entries.length
    && reply.entries.every(v => exact(v, ["catalogId", "label", "description"])
      && typeof v.catalogId === "string" && /^[A-Za-z0-9:_-]{1,128}$/.test(v.catalogId)
      && typeof v.label === "string" && v.label.length > 0 && v.label.length <= 120 && !/[\u0000-\u001f\u007f]/.test(v.label)
      && typeof v.description === "string" && v.description.length <= 300 && !/[\u0000-\u001f\u007f]/.test(v.description));
}

function createHistoryHttpHandler({ registry, auth, allowedOrigins, browserCookieNames = ["stepsemble"], deadlineMs = LIMITS.deadlineMs,
  browserOnly = false, codexEnabled = false, listCatalog, listSources, sourceCatalog, sourceMetadata, catalogCurrent } = {}) {
  if (![registry?.register, registry?.observe, registry?.release, registry?.current].every(v => typeof v === "function")
    || typeof codexEnabled !== "boolean" || !positive(deadlineMs) || deadlineMs > LIMITS.deadlineMs || listCatalog !== undefined && typeof listCatalog !== "function"
    || [listSources, sourceCatalog, sourceMetadata, catalogCurrent].some(v => v !== undefined && typeof v !== "function")
    || (listSources !== undefined || sourceCatalog !== undefined || sourceMetadata !== undefined) && typeof catalogCurrent !== "function")
    throw new TypeError("history_http_configuration_invalid");
  const authenticate = createHistoryRequestAuth({ auth, allowedOrigins, browserCookieNames, browserOnly });
  return async function handle(req, res) {
    const target = req.url || "";
    if (target !== "/api/history" && !target.startsWith("/api/history/") && !target.startsWith("/api/history?")) return false;
    const abort = new AbortController(); let timedOut = false;
    const disconnected = () => abort.abort();
    const responseClosed = () => { if (!res.writableEnded) disconnected(); };
    req.on("aborted", disconnected); res.on("close", responseClosed); res.on("error", disconnected);
    const timer = setTimeout(() => { timedOut = true; abort.abort(); }, deadlineMs); timer.unref?.();
    let operationAbort, registration = null, registrationPrincipal = null, registrationPublished = false, finished = false;
    function cancelRegistration() {
      if (!registration || registrationPublished) return;
      const receipt = registration; registration = null;
      // This is the registry's original private object identity, not a decoded
      // public descriptor. Registry rejects stale receipts and claimed rows.
      // A true result only means retired, never confirmed worker cleanup.
      try { registry.cancelRegistration?.(registrationPrincipal, receipt); } catch { /* lease/revoke remain the fallback */ }
    }
    try {
      const principal = authenticate(req);
      if (typeof req.headers["content-type"] !== "string" || !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.headers["content-type"]))
        throw error("history_content_type_rejected", 415);
      if (req.headers["content-encoding"] !== undefined || req.headers.expect !== undefined) throw error("history_body_invalid");
      const declared = req.headers["content-length"];
      if (declared !== undefined && (!/^\d+$/.test(declared) || Number(declared) > LIMITS.requestBytes)) throw error("history_body_too_large", 413);
      const viewId = req.headers[VIEW_HEADER];
      if (!uuid(viewId)) throw error("invalid_history_request");
      const release = /^\/api\/history\/registrations\/([a-f0-9-]{36})$/i.exec(target);
      const route = target === "/api/history/catalog" && req.method === "POST" ? "catalog"
        : target === "/api/history/sources" && req.method === "POST" ? "sources"
        : target === "/api/history/source-catalog" && req.method === "POST" ? "sourceCatalog"
        : target === "/api/history/source-metadata" && req.method === "POST" ? "sourceMetadata"
        : target === "/api/history/registrations" && req.method === "POST" ? "register"
        : target === "/api/history/page" && req.method === "POST" ? "observe"
          : release && uuid(release[1]) && req.method === "DELETE" ? "release" : null;
      if (!route) throw error("history_method_not_allowed", 405);
      const body = await readBody(req, abort.signal);
      if (["catalog", "sources"].includes(route) && !exact(body, [])) throw error("invalid_history_request");
      if (route === "sourceCatalog" && !sourceCatalogWire.validRequest(body)) throw error("invalid_history_request");
      if (route === "sourceMetadata" && !sourceCatalogWire.validMetadataRequest(body)) throw error("invalid_history_request");
      if (route === "register" && (!exact(body, ["catalogId", "viewId"]) || body.viewId !== viewId
        || typeof body.catalogId !== "string" || !/^[A-Za-z0-9:_-]{1,128}$/.test(body.catalogId))) throw error("invalid_history_registration");
      if (route === "observe" && (!exact(body, ["bindingId", "generation", "requestId", "page", ...(Object.hasOwn(body, "version") ? ["version"] : []), ...(Object.hasOwn(body, "structured") ? ["structured"] : [])])
        || Object.hasOwn(body, "structured") && (!codexEnabled || body.structured !== true)
        || !uuid(body.bindingId) || !positive(body.generation) || !uuid(body.requestId) || !exact(body.page, ["offset", "limit"])
        || !(codexEnabled && codexRecords.validPage(body.page) || Number.isSafeInteger(body.page.offset) && body.page.offset >= 0 && body.page.offset <= 2000 && positive(body.page.limit) && body.page.limit <= 100)
        || Object.hasOwn(body, "version") && (typeof body.version !== "string" || !/^[a-f0-9]{64}$/.test(body.version)))) throw error("invalid_history_request");
      if (route === "release" && (!exact(body, ["generation"]) || !positive(body.generation))) throw error("invalid_history_release");
      if (abort.signal.aborted) throw error("history_request_aborted", 408);
      if (authenticate(req) !== principal) throw error("history_unauthorized", 401);
      const operation = route === "catalog" ? listCatalog ? Promise.resolve(listCatalog(principal, { signal: abort.signal, viewId }))
        .then(entries => ({ kind: "history_catalog", entries, sourceAuthenticated: false, publishable: false })) : unavailable("history_source_unavailable")
        : route === "sources" ? listSources?.(principal, { signal: abort.signal, viewId }) ?? unavailable("history_source_unavailable")
        : route === "sourceCatalog" ? sourceCatalog?.(principal, body, { signal: abort.signal, viewId }) ?? unavailable("history_source_unavailable")
        : route === "sourceMetadata" ? sourceMetadata?.(principal, body, { signal: abort.signal, viewId }) ?? unavailable("history_source_unavailable")
        : route === "register" ? registry.register(principal, body, { signal: abort.signal })
        : route === "observe" ? registry.observe(principal, { ...body, viewId }, { signal: abort.signal })
          : registry.release(principal, { bindingId: release[1], generation: body.generation, viewId }, { signal: abort.signal });
      const observedOperation = route === "register" && typeof registry.cancelRegistration === "function" ? Promise.resolve(operation).then(value => {
        if (value?.kind === "history_registration") {
          registration = value; registrationPrincipal = principal;
          if (finished || abort.signal.aborted) cancelRegistration();
        }
        return value;
      }) : operation;
      const cancelled = new Promise((_, reject) => {
        operationAbort = () => reject(error("history_request_aborted", 408));
        abort.signal.addEventListener("abort", operationAbort, { once: true });
        if (abort.signal.aborted) operationAbort();
      });
      const value = await Promise.race([observedOperation, cancelled]);
      // Re-authenticate current grant/cookie immediately before publishing.
      if (abort.signal.aborted) throw error("history_request_aborted", 408);
      if (authenticate(req) !== principal) throw error("history_unauthorized", 401);
      if (exact(value, ["kind", "code"]) && value.kind === "source_unavailable") {
        send(res, 409, unavailable(PUBLIC_CODES.has(value.code) ? value.code : "history_transport_failed"));
      } else {
        const raw = canonicalJSON(value, LIMITS.responseBytes);
        if (raw === null) throw error("history_response_too_large", 502);
        // Registry/service validates provider-specific nested data. This layer
        // preserves the existing inert response envelope and forbids authority.
        const reply = JSON.parse(raw);
        const valid = route === "catalog" ? validCatalog(reply)
          : route === "sources" ? sourceCatalogWire.validSources(reply)
          : route === "sourceCatalog" ? sourceCatalogWire.validPage(reply, body, PUBLIC_CODES)
          : route === "sourceMetadata" ? sourceCatalogWire.validMetadata(reply, body)
          : route === "release" ? exact(reply, ["kind", "cleanupConfirmed"]) && reply.kind === "history_released" && typeof reply.cleanupConfirmed === "boolean"
          : route === "register" ? exact(reply, ["kind", "bindingId", "generation", "sessionId", "viewId", "catalogId", "expiresAt", "sourceAuthenticated", "publishable"])
            && reply.kind === "history_registration" && reply.viewId === viewId && reply.catalogId === body.catalogId && uuid(reply.bindingId)
            && uuid(reply.sessionId) && positive(reply.generation) && positive(reply.expiresAt) && reply.sourceAuthenticated === false && reply.publishable === false
            : reply.kind === "bound_codex_records" ? codexEnabled && codexRecords.validBoundRecords(reply, reply.history?.nativeThreadId, body.page, body)
            : body.structured === undefined && Buffer.byteLength(raw) <= LIMITS.claudeResponseBytes && exact(reply, ["kind", "bindingId", "generation", "requestId", "sourceVersion", "history", "sourceAuthenticated", "publishable", "cleanupConfirmed"])
              && reply.kind === "bound_history_observation" && reply.bindingId === body.bindingId && reply.generation === body.generation
              && reply.requestId === body.requestId && typeof reply.sourceVersion === "string" && /^[a-f0-9]{64}$/.test(reply.sourceVersion)
              && reply.sourceAuthenticated === false && reply.publishable === false && reply.cleanupConfirmed === true && inertHistory(reply.history, body.page);
        if (!valid) throw error("history_response_invalid", 502);
        if (["sources", "sourceCatalog", "sourceMetadata"].includes(route) && catalogCurrent(principal, reply) !== true)
          throw error("history_catalog_changed", 409);
        if (["register", "observe"].includes(route) && registry.current(principal, { bindingId: reply.bindingId, generation: reply.generation, viewId }) !== true)
          throw error("history_binding_unavailable", 409);
        send(res, 200, reply);
        // This cannot prove browser consumption: a completely sent response
        // may still be lost downstream. Unclaimed registry rows can be replaced
        // by an authorized same-view selection, or expire under their lease.
        if (route === "register" && res.writableEnded && !res.destroyed) registrationPublished = true;
      }
    } catch (cause) {
      const code = timedOut ? "history_request_timeout" : PUBLIC_CODES.has(cause?.code) ? cause.code : "history_transport_failed";
      const status = timedOut ? 408 : cause?.code === code && [400, 401, 403, 405, 408, 409, 413, 415, 502, 503].includes(cause.status) ? cause.status : 503;
      send(res, status, unavailable(code), !req.complete);
    } finally {
      finished = true; cancelRegistration();
      clearTimeout(timer);
      if (operationAbort) abort.signal.removeEventListener("abort", operationAbort);
      req.removeListener("aborted", disconnected); res.removeListener("close", responseClosed); res.removeListener("error", disconnected);
    }
    return true;
  };
}

module.exports = { createHistoryHttpHandler, createHistoryRequestAuth, configuredOrigin, validCatalog, LIMITS, VIEW_HEADER, CSRF_HEADER, PUBLIC_CODES };
