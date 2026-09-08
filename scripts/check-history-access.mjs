// Offline integration contract: real loopback HTTP, synthetic credentials and
// owned fixture files only. The caller supplies its integrity-pinned SDK path.
import assert from "node:assert/strict";
import http from "node:http";
import crypto from "node:crypto";
import { once } from "node:events";
import sourceService from "../protocol/native/claude/history-source-service.js";
import registryModule from "../protocol/native/claude/history-registry.js";
import httpModule from "../server/history-http.js";
import relayModule from "../server/history-relay.js";
import transportModule from "../public/modules/history-transport.js";
import pagesModule from "../public/modules/history-pages.js";
import providerModule from "../public/modules/claude-history.js";
import projection from "../public/modules/projection.js";

export async function checkHistoryAccess({ sdkPath, catalog, createService = sourceService.createSourceService }) {
  assert.ok(Array.isArray(catalog) && catalog.length > 1);
  // Trusted test dependency only; never selected by an HTTP/browser field.
  const service = createService({ sdkPath });
  const principals = new Set(["fixture-browser-a", "fixture-browser-b", "fixture-peer"]);
  const peerCredential = crypto.randomBytes(32).toString("hex");
  const registry = registryModule.createHistoryRegistry({ sourceService: service,
    catalog: catalog.map(({ catalogId, source }) => ({ catalogId, source })), maxSlots: 2,
    authorize: (principal, catalogId) => principals.has(principal) && catalog.some(c => c.catalogId === catalogId),
    principalActive: principal => principals.has(principal) });
  let handle, revokeDuringRead = false;
  const server = http.createServer((req, res) => {
    void handle(req, res).then(handled => { if (!handled) { res.writeHead(404); res.end(); } });
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const origin = `http://127.0.0.1:${server.address().port}`;
  const auth = {
    authenticateBrowserCookie: (name, value) => name === "stepsemble" && ["a", "b"].includes(value)
      ? `fixture-browser-${value}` : null,
    authenticatePeerCredential: value => value === peerCredential ? "fixture-peer" : null,
    isPrincipalCurrent: principal => principals.has(principal),
  };
  handle = httpModule.createHistoryHttpHandler({ registry: { ...registry,
    observe(principal, request, options) {
      const result = registry.observe(principal, request, options);
      if (revokeDuringRead) {
        revokeDuringRead = false; principals.delete(principal); registry.revokePrincipal(principal);
      }
      return result;
    } }, auth, allowedOrigins: [origin] });
  const views = [];
  const client = actor => {
    const viewId = crypto.randomUUID();
    const transport = transportModule.create({ origin, hostId: "owned-http-fixture", viewId,
      canonicalJSON: projection.canonicalJSON,
      fetch: (url, options) => fetch(url, { ...options, headers: { ...options.headers, Origin: origin, Cookie: `stepsemble=${actor}` } }) });
    const view = pagesModule.create({ read: transport.read, canonicalJSON: projection.canonicalJSON,
      validateHistory: providerModule.create({ canonicalJSON: projection.canonicalJSON }).validateHistory, requestId: crypto.randomUUID });
    views.push(view);
    return { viewId, transport, view, async register(catalogId) {
      const result = await transport.register({ catalogId, viewId });
      assert.equal(result.kind, "history_registration", JSON.stringify(result));
      assert.deepEqual(view.reset({ hostId: "owned-http-fixture", bindingId: result.bindingId,
        generation: result.generation, sessionId: result.sessionId }), { kind: "applied" });
      return result;
    } };
  };
  const headers = viewId => ({ Origin: origin, Cookie: "stepsemble=a", "Content-Type": "application/json",
    "X-Stepsemble-History-CSRF": "1", "X-Stepsemble-History-View": viewId });
  const release = (c, r) => c.transport.release({ bindingId: r.bindingId, generation: r.generation });
  try {
    const a = client("a"), b = client("a");
    for (const entry of catalog) {
      const ra = await a.register(entry.catalogId), rb = await b.register(entry.catalogId);
      assert.notEqual(ra.bindingId, rb.bindingId);
      if (process.platform === "win32") {
        assert.deepEqual(await a.view.refresh(), { kind: "unavailable", code: "source_platform_unsupported" });
      } else {
        assert.deepEqual(await a.view.refresh({ offset: 0, limit: 2 }), { kind: "applied" });
        const version = a.view.state().sourceVersion;
        assert.deepEqual(await b.view.refresh({ offset: 0, limit: 2 }), { kind: "applied" });
        assert.notEqual(b.view.state().sourceVersion, version);
        assert.deepEqual(await b.view.refresh({ offset: 0, limit: 2 }), { kind: "applied" });
        assert.deepEqual(await a.view.loadNext(20), { kind: "applied" });
        assert.equal(a.view.state().sourceVersion, version);
        assert.deepEqual(a.view.state().pages.flatMap(page => page.observation.messages.map(m => m.nativeMessageId)), entry.expectedIds);
        assert.equal(a.view.state().publishable, false);
      }
      const invalid = await fetch(origin + "/api/history/registrations", { method: "POST", headers: headers(a.viewId),
        body: JSON.stringify({ catalogId: entry.catalogId, viewId: a.viewId, source: entry.source }) });
      assert.equal(invalid.status, 400); assert.equal((await invalid.json()).code, "invalid_history_registration");
      const stolen = await fetch(origin + "/api/history/page", { method: "POST", headers: headers(b.viewId),
        body: JSON.stringify({ bindingId: ra.bindingId, generation: ra.generation, requestId: crypto.randomUUID(), page: { offset: 0, limit: 2 } }) });
      assert.equal(stolen.status, 409); assert.equal((await stolen.json()).code, "history_binding_unavailable");
      const mixed = await fetch(origin + "/api/history/registrations", { method: "POST",
        headers: { ...headers(a.viewId), Authorization: `Bearer ${"a".repeat(64)}` }, body: JSON.stringify({ catalogId: entry.catalogId, viewId: a.viewId }) });
      assert.equal(mixed.status, 401); assert.equal((await mixed.json()).code, "history_unauthorized");
      assert.deepEqual(await release(b, rb), { kind: "history_released", cleanupConfirmed: true });
      const foreign = client("b"), rf = await foreign.register(entry.catalogId);
      assert.equal(rf.bindingId, rb.bindingId); assert.ok(rf.generation > rb.generation);
      const stale = await b.transport.read({ hostId: "owned-http-fixture", bindingId: rb.bindingId, generation: rb.generation, sessionId: rb.sessionId },
        { bindingId: rb.bindingId, generation: rb.generation, requestId: crypto.randomUUID() }, { page: { offset: 0, limit: 2 }, signal: new AbortController().signal });
      assert.deepEqual(stale, { kind: "source_unavailable", code: "history_binding_unavailable" });
      assert.deepEqual(await release(foreign, rf), { kind: "history_released", cleanupConfirmed: true });
      assert.deepEqual(await release(a, ra), { kind: "history_released", cleanupConfirmed: true });
    }
    // A second real HTTP listener exercises the gateway ownership boundary.
    // Both browsers intentionally choose the same local view ID; the relay
    // must allocate different remote views even though it uses one peer grant.
    let relay;
    const gateway = http.createServer((req, res) => {
      void relay(req, res).then(handled => { if (!handled) { res.writeHead(404); res.end(); } });
    });
    try {
      gateway.listen(0, "127.0.0.1"); await once(gateway, "listening");
      const gatewayOrigin = `http://127.0.0.1:${gateway.address().port}`, grantId = crypto.randomBytes(16).toString("hex");
      relay = relayModule.createHistoryRelayHandler({ auth, allowedOrigins: [gatewayOrigin],
        resolvePeer: machineId => machineId === "fixture-peer" ? { url: origin, grantId, credential: peerCredential } : null,
        isPeerCurrent: (machineId, grant) => machineId === "fixture-peer" && grant.url === origin && grant.grantId === grantId });
      const localView = crypto.randomUUID(), entry = catalog[0];
      const throughRelay = async (actor, route, method, body) => {
        const response = await fetch(gatewayOrigin + "/r/fixture-peer/api/history/" + route, { method,
          headers: { ...headers(localView), Origin: gatewayOrigin, Cookie: `stepsemble=${actor}` }, body: JSON.stringify(body) });
        return { status: response.status, value: await response.json() };
      };
      const ra = await throughRelay("a", "registrations", "POST", { catalogId: entry.catalogId, viewId: localView });
      const rb = await throughRelay("b", "registrations", "POST", { catalogId: entry.catalogId, viewId: localView });
      assert.equal(ra.status, 200); assert.equal(rb.status, 200);
      assert.equal(ra.value.viewId, localView); assert.equal(rb.value.viewId, localView);
      assert.notEqual(ra.value.bindingId, rb.value.bindingId);
      const page = { offset: 0, limit: 2 }, request = { bindingId: ra.value.bindingId, generation: ra.value.generation, requestId: crypto.randomUUID(), page };
      const denied = await throughRelay("b", "page", "POST", request);
      assert.equal(denied.status, 409); assert.equal(denied.value.code, "history_binding_unavailable");
      const accepted = await throughRelay("a", "page", "POST", request);
      if (process.platform === "win32") assert.equal(accepted.value.code, "source_platform_unsupported");
      else {
        assert.equal(accepted.status, 200);
        assert.equal(providerModule.create({ canonicalJSON: projection.canonicalJSON }).validateHistory(accepted.value.history, entry.source.sessionId, page), true);
        assert.deepEqual(accepted.value.history.observation.messages.map(message => message.nativeMessageId), entry.expectedIds.slice(0, 2));
        assert.equal(accepted.value.publishable, false);
      }
      for (const [actor, reg] of [["a", ra.value], ["b", rb.value]]) {
        const result = await throughRelay(actor, `registrations/${reg.bindingId}`, "DELETE", { generation: reg.generation });
        assert.equal(result.status, 200); assert.deepEqual(result.value, { kind: "history_released", cleanupConfirmed: true });
      }
    } finally {
      relay?.shutdown(); gateway.closeAllConnections(); await new Promise(resolve => gateway.close(resolve));
    }
    const victim = client("a"); await victim.register(catalog[0].catalogId);
    if (process.platform !== "win32") {
      assert.deepEqual(await victim.view.refresh({ offset: 0, limit: 2 }), { kind: "applied" });
      const before = victim.view.state().pages; revokeDuringRead = true;
      assert.deepEqual(await victim.view.loadNext(2), { kind: "unavailable", code: "history_unauthorized" });
      assert.equal(victim.view.state().status, "stale"); assert.deepEqual(victim.view.state().pages, before);
      assert.deepEqual(await victim.view.loadNext(2), { kind: "unavailable", code: "history_refresh_required" });
    } else { principals.delete("fixture-browser-a"); registry.revokePrincipal("fixture-browser-a"); }
    assert.equal(service.status().activeWorkers, 0);
    assert.equal(registry.status().retainedSlots, 2);
    return { authenticatedHttpGate: process.platform === "win32" ? "source_platform_unsupported" : "posix_fixture_passed",
      httpScopeAndOwnerTransferVerified: true, boundedRegistrySlots: 2,
      inFlightRevokeGate: process.platform === "win32" ? "source_platform_unsupported" : "posix_fixture_passed",
      relayScopeGate: process.platform === "win32" ? "source_platform_unsupported" : "posix_fixture_passed",
      relayDownstreamOwnerIsolation: true,
      syntheticCredentialsOnly: true, modelCalls: 0 };
  } finally {
    for (const view of views) view.dispose();
    try { assert.equal((await registry.shutdown()).cleanupConfirmed, true); }
    finally {
      // Failed/uncertain worker cleanup must still close this test listener;
      // leave the failure visible without holding the runner open forever.
      server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    }
  }
}
