"use strict";
// Reserved bounded history relay. Uses only Host-resolved, dedicated outgoing
// peer grants. It does not install routes, discover hosts or support legacy
// shared-cookie peers. A bounded gateway ownership map authorizes local users;
// the remote Host still identifies this gateway. Opaque rewritten view refs
// isolate remote lifecycles and do not claim end-to-end native user provenance.
const { createHistoryHttpHandler, createHistoryRequestAuth, validCatalog, LIMITS, VIEW_HEADER, PUBLIC_CODES } = require("./history-http");
const { canonicalJSON } = require("../public/modules/projection");
const sourceCatalogWire = require("./history-catalog-wire");
const { validHistoryValue } = require("../public/modules/claude-history");
const codexRecords = require("../public/modules/codex-history-records");
const { randomUUID } = require("node:crypto");
const MAX_FLIGHTS = 64;
const MAX_BINDINGS = 64;
const fail = (code, status = 502) => Object.assign(new Error(code), { code, status });
const exact = (v, names) => v !== null && typeof v === "object" && !Array.isArray(v)
  && Object.keys(v).sort().join(",") === [...names].sort().join(",");

function peerSnapshot(value) {
  if (!value || typeof value.url !== "string" || typeof value.credential !== "string" || !/^[a-f0-9]{64}$/.test(value.credential)
    || typeof value.grantId !== "string" || !/^[a-f0-9]{32}$/.test(value.grantId)) return null;
  try {
    const url = new URL(value.url);
    // The configured target is a canonical origin (optionally one slash).
    // No query/token/path redirect can enter the fixed history URL namespace.
    if (!["http:", "https:"].includes(url.protocol) || ![url.origin, url.origin + "/"].includes(value.url)) return null;
    return Object.freeze({ url: url.origin, grantId: value.grantId, credential: value.credential });
  } catch { return null; }
}

/** resolvePeer(machineId) returns trusted {url, grantId, credential} or null;
 * isPeerCurrent(machineId, {url, grantId}) is a current store check, not cache.
 * Wire logout/token/peer revocation to the returned handler's revokePrincipal /
 * revokePeer methods as well as updating those current checks. That fan-out
 * aborts ongoing response streams. shutdown aborts all active reads.
 */
function createHistoryRelayHandler({ auth, allowedOrigins, browserCookieNames = ["stepsemble"], resolvePeer, isPeerCurrent,
  fetch: fetchFn = globalThis.fetch, deadlineMs = LIMITS.deadlineMs } = {}) {
  const authenticate = createHistoryRequestAuth({ auth, allowedOrigins, browserCookieNames, browserOnly: true });
  if (typeof resolvePeer !== "function" || typeof isPeerCurrent !== "function" || typeof fetchFn !== "function"
    || !Number.isSafeInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > LIMITS.deadlineMs) throw new TypeError("history_relay_configuration_invalid");
  const flights = new Set(), bindings = new Map(); let closed = false;
  const bindingKey = (principal, machineId, viewId) => JSON.stringify([principal, machineId, viewId]);
  function forget(row) {
    if (bindings.get(row.key) === row) bindings.delete(row.key);
    for (const flight of flights) if (flight.row === row) flight.abort();
  }
  function sweep() {
    const now = Date.now();
    for (const row of bindings.values()) if (!row.registering && row.expiresAt <= now) forget(row);
  }
  async function handle(req, res) {
    const original = req.url || "";
    const route = /^\/r\/([a-z0-9-]{1,48})(\/api\/history(?:\/.*|\?.*)?)$/.exec(original);
    if (!route) return false;
    const machineId = route[1], upstreamPath = route[2]; let selected = null;
    function peerActive() {
      if (!selected || closed) return false;
      try {
        const current = peerSnapshot(resolvePeer(machineId));
        return current !== null && current.url === selected.url && current.grantId === selected.grantId && current.credential === selected.credential
          && isPeerCurrent(machineId, { url: selected.url, grantId: selected.grantId }) === true;
      } catch { return false; }
    }
    function selectPeer() {
      if (!selected) selected = peerSnapshot(resolvePeer(machineId));
      if (!selected || !peerActive()) throw fail("history_source_unavailable", 503);
    }
    function owned(principal, body, closing = false) {
      selectPeer(); sweep();
      const row = bindings.get(bindingKey(principal, machineId, body.viewId));
      if (!row || row.state !== "active" && !(closing && row.state === "closing") || row.bindingId !== body.bindingId
        || row.generation !== body.generation || row.grantId !== selected.grantId || row.url !== selected.url)
        throw fail("history_binding_unavailable", 409);
      return row;
    }
    async function forward(principal, path, method, body, viewId, signal, row = null) {
      if (closed) throw fail("history_source_unavailable", 503);
      if (flights.size >= MAX_FLIGHTS) throw fail("history_capacity_unavailable", 409);
      selectPeer();
      if (authenticate(req) !== principal) throw fail("history_unauthorized", 401);
      const controller = new AbortController(), flight = { principal, machineId, row, abort: () => stop() };
      let response = null, reader = null, stopped = false, complete = false, cancelled = false, interrupt = null;
      // At most one cancellation waiter is retained, even for tiny chunks.
      const wait = pending => new Promise((resolve, reject) => {
        let settled = false;
        const cancel = () => { if (!settled) { settled = true; interrupt = null; reject(fail("history_request_aborted", 408)); } };
        interrupt = cancel;
        Promise.resolve(pending).then(value => {
          if (!settled) { settled = true; if (interrupt === cancel) interrupt = null; resolve(value); }
        }, cause => { if (!settled) { settled = true; if (interrupt === cancel) interrupt = null; reject(cause); } });
        if (stopped) cancel();
      });
      function cancelBody() {
        if (cancelled || !response?.body) return; cancelled = true;
        try { void (reader ? reader.cancel() : response.body.cancel()).catch(() => {}); } catch { /* cleanup only */ }
      }
      function stop() { if (stopped) return; stopped = true; controller.abort(); cancelBody(); interrupt?.(); }
      const onAbort = () => stop();
      const url = selected.url + path;
      try {
        flights.add(flight); signal.addEventListener("abort", onAbort, { once: true });
        if (signal.aborted) stop();
        if (stopped) throw fail("history_request_aborted", 408);
        const raw = canonicalJSON(body, LIMITS.requestBytes);
        if (raw === null) throw fail("history_body_too_large", 413);
        const pending = Promise.resolve().then(() => {
          if (stopped || !peerActive()) throw fail("history_source_unavailable", 503);
          return fetchFn(url, { method, credentials: "omit", redirect: "error", cache: "no-store",
            headers: { "Content-Type": "application/json", Accept: "application/json", [VIEW_HEADER]: viewId,
              Authorization: `Bearer ${selected.credential}` }, body: raw, signal: controller.signal });
        }).then(value => { response = value; if (stopped) cancelBody(); return value; });
        response = await wait(pending);
        if (stopped || signal.aborted) throw fail("history_request_aborted", 408);
        if (response.redirected || response.url && response.url !== url || !response.body
          || !/^application\/json(?:\s*;\s*charset\s*=\s*utf-8)?\s*$/i.test(response.headers.get("content-type") || ""))
          throw fail("history_response_invalid");
        reader = response.body.getReader();
        // fetch exposes Content-Encoding-decoded bytes. Never trust the wire
        // Content-Length for allocation, size checks, or successful completion.
        const bytes = new Uint8Array(LIMITS.responseBytes); let length = 0;
        for (;;) {
          const chunk = await wait(reader.read());
          if (stopped || signal.aborted) throw fail("history_request_aborted", 408);
          if (chunk.done) break;
          if (!(chunk.value instanceof Uint8Array)) throw fail("history_response_invalid");
          if (chunk.value.byteLength > LIMITS.responseBytes - length) throw fail("history_response_too_large");
          bytes.set(chunk.value, length); length += chunk.value.byteLength;
        }
        if (!length || bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) throw fail("history_response_invalid");
        let value;
        try {
          value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, length)));
          if (canonicalJSON(value, LIMITS.responseBytes) === null) throw 0;
        } catch { throw fail("history_response_invalid"); }
        if (!peerActive() || authenticate(req) !== principal) throw fail("history_unauthorized", 401);
        if (row && bindings.get(row.key) !== row) throw fail("history_binding_unavailable", 409);
        if (exact(value, ["kind", "code"]) && value.kind === "source_unavailable") {
          if (!PUBLIC_CODES.has(value.code)) throw fail("history_transport_failed");
          complete = true; return value;
        }
        if (!response.ok) throw fail("history_response_invalid");
        if (path === "/api/history/catalog" && !validCatalog(value)) throw fail("history_response_invalid");
        if (path === "/api/history/sources" && !sourceCatalogWire.validSources(value)) throw fail("history_response_invalid");
        if (path === "/api/history/source-catalog" && !sourceCatalogWire.validPage(value, body, PUBLIC_CODES)) throw fail("history_response_invalid");
        if (path === "/api/history/source-metadata" && !sourceCatalogWire.validMetadata(value, body)) throw fail("history_response_invalid");
        if (path === "/api/history/page" && (!row || row.state !== "active" || !(value?.kind === "bound_codex_records"
          ? codexRecords.validBoundRecords(value, row.sessionId, body.page, body) : validHistoryValue(value?.history, row.sessionId, body.page))))
          throw fail("history_response_invalid");
        // Shared HTTP handler checks whole bound/registration/release envelopes,
        // binding/generation/requestId and all inert authority before writing.
        complete = true; return value;
      } finally {
        if (!complete) stop();
        signal.removeEventListener("abort", onAbort); flights.delete(flight); interrupt = null;
        try { reader?.releaseLock(); } catch { /* an ignored cancellation may still own a read */ }
      }
    }
    const registry = {
      async register(principal, body, { signal }) {
        selectPeer(); sweep();
        const key = bindingKey(principal, machineId, body.viewId);
        let row = bindings.get(key), fresh = false;
        if (row && (row.url !== selected.url || row.grantId !== selected.grantId)) { forget(row); row = null; }
        if (row && (row.registering || row.state === "closing" || row.catalogId !== body.catalogId && row.observed)) throw fail("history_view_conflict", 409);
        if (!row) {
          if (bindings.size >= MAX_BINDINGS) throw fail("history_capacity_unavailable", 409);
          // A browser never chooses the remote view reference. Different local
          // principals using the same caller view get independent remote views;
          // failed/aborted registrations cannot be inherited by another user.
          row = { key, principal, machineId, localViewId: body.viewId, upstreamViewId: randomUUID(), catalogId: body.catalogId,
            url: selected.url, grantId: selected.grantId, state: "pending", expiresAt: Date.now() + deadlineMs, registering: false, observed: false, receipt: null };
          bindings.set(key, row); fresh = true;
        }
        const changingCatalog = row.catalogId !== body.catalogId, priorState = row.state;
        // A replacement may retire the old remote registration. Fence old page
        // admission until the remote has first authorized and decided it.
        if (changingCatalog) row.state = "pending";
        row.registering = true; row.receipt = null;
        try {
          const value = await forward(principal, "/api/history/registrations", "POST", { ...body, viewId: row.upstreamViewId }, row.upstreamViewId, signal, row);
          if (value?.kind === "source_unavailable") {
            if (fresh) forget(row);
            else row.state = value.code === "source_cleanup_unconfirmed" ? "closing" : priorState;
            return value;
          }
          const uuid = v => typeof v === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(v);
          if (!exact(value, ["kind", "bindingId", "generation", "sessionId", "viewId", "catalogId", "expiresAt", "sourceAuthenticated", "publishable"])
            || value.kind !== "history_registration" || value.viewId !== row.upstreamViewId || value.catalogId !== body.catalogId
            || !uuid(value.bindingId) || !uuid(value.sessionId) || !Number.isSafeInteger(value.generation) || value.generation < 1
            || !Number.isSafeInteger(value.expiresAt) || value.expiresAt <= Date.now() || value.sourceAuthenticated !== false || value.publishable !== false)
            throw fail("history_response_invalid");
          // Remote slot transfer may reuse a binding ID, but never let an old
          // local owner/generation retain access to the newly registered slot.
          for (const prior of bindings.values()) if (prior !== row && prior.machineId === machineId && prior.bindingId === value.bindingId) {
            if (prior.generation >= value.generation) throw fail("history_response_invalid");
            forget(prior);
          }
          if (row.bindingId === value.bindingId && row.generation > value.generation) throw fail("history_response_invalid");
          if (changingCatalog && row.bindingId === value.bindingId && row.generation >= value.generation) throw fail("history_response_invalid");
          if (row.bindingId === value.bindingId && row.generation === value.generation && row.sessionId !== value.sessionId) throw fail("history_response_invalid");
          Object.assign(row, { state: "active", catalogId: body.catalogId, bindingId: value.bindingId, generation: value.generation, sessionId: value.sessionId, expiresAt: value.expiresAt });
          const receipt = Object.freeze({ ...value, viewId: body.viewId }); row.receipt = row.observed ? null : receipt;
          return receipt;
        } catch (cause) {
          if (fresh) forget(row);
          // Unknown replacement completion leaves the old capability fenced;
          // an explicit registration can reconcile using the same remote view.
          throw cause;
        }
        finally { row.registering = false; }
      },
      observe(principal, body, { signal }) {
        const row = owned(principal, body);
        row.observed = true; row.receipt = null; // Irreversible, including a failed/aborted read.
        const { viewId, ...request } = body;
        return forward(principal, "/api/history/page", "POST", request, row.upstreamViewId, signal, row);
      },
      async release(principal, body, { signal }) {
        const row = owned(principal, body, true); row.state = "closing";
        for (const flight of flights) if (flight.row === row) flight.abort();
        const value = await forward(principal, `/api/history/registrations/${body.bindingId}`, "DELETE", { generation: body.generation }, row.upstreamViewId, signal, row);
        if (exact(value, ["kind", "cleanupConfirmed"]) && value.kind === "history_released" && value.cleanupConfirmed === true) forget(row);
        // False/unknown cleanup retains a closing row until its lease expires.
        // It is never an active read capability, nor evidence of worker exit.
        return value;
      },
      current(principal, scope) { try { return !!owned(principal, scope) && peerActive(); } catch { return false; } },
      cancelRegistration(principal, receipt) {
        if (!receipt || typeof receipt !== "object") return false;
        const row = [...bindings.values()].find(value => value.principal === principal && !value.observed && value.receipt === receipt);
        if (!row) return false;
        row.receipt = null; row.state = "pending";
        for (const flight of flights) if (flight.row === row) flight.abort();
        // Private local receipt only fences local authority. Keep this bounded
        // tentative row for explicit re-registration/replacement or lease expiry.
        // No asynchronous DELETE can arrive later and revoke a newer renewal.
        return true;
      },
    };
    const local = createHistoryHttpHandler({ registry, browserOnly: true, codexEnabled: true, allowedOrigins, browserCookieNames, deadlineMs,
      auth: { ...auth, isPrincipalCurrent(principal) { return auth.isPrincipalCurrent(principal) === true && (!selected || peerActive()); } },
      listCatalog: async (principal, { signal, viewId }) => {
        const value = await forward(principal, "/api/history/catalog", "POST", {}, viewId, signal);
        if (value.kind === "source_unavailable") throw fail(value.code, 503);
        return value.entries;
      },
      listSources: (principal, { signal, viewId }) => forward(principal, "/api/history/sources", "POST", {}, viewId, signal),
      sourceCatalog: (principal, body, { signal, viewId }) => forward(principal, "/api/history/source-catalog", "POST", body, viewId, signal),
      sourceMetadata: (principal, body, { signal, viewId }) => forward(principal, "/api/history/source-metadata", "POST", body, viewId, signal),
      catalogCurrent: () => peerActive() });
    req.url = upstreamPath;
    try { return await local(req, res); } finally { req.url = original; }
  }
  return Object.freeze(Object.assign(handle, {
    revokePrincipal(principal) { for (const row of bindings.values()) if (row.principal === principal) forget(row); for (const flight of flights) if (flight.principal === principal) flight.abort(); },
    revokePeer(machineId) { for (const row of bindings.values()) if (row.machineId === machineId) forget(row); for (const flight of flights) if (flight.machineId === machineId) flight.abort(); },
    shutdown() { closed = true; for (const row of bindings.values()) forget(row); for (const flight of flights) flight.abort(); },
  }));
}

module.exports = { createHistoryRelayHandler, MAX_FLIGHTS, MAX_BINDINGS };
