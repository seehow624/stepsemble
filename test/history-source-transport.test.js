"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), crypto = require("node:crypto");
const transport = require("../public/modules/history-transport"), wire = require("../server/history-catalog-wire");
const { PUBLIC_CODES } = require("../server/history-http"), { canonicalJSON } = require("../public/modules/projection");
const origin = "https://owned.invalid", viewId = crypto.randomUUID(), snapshotId = crypto.randomUUID(), catalogId = "claude-" + "a".repeat(64);
const pageRequest = { sourceId: "owned", page: { offset: 0, limit: 50 }, snapshotId: null, refresh: false };
const metadataRequest = { sourceId: "owned", catalogId, snapshotId, requestId: crypto.randomUUID() };
const sources = { kind: "history_sources", sources: [{ sourceId: "owned", agentId: "claude-code", scope: "main_sessions", label: "Owned root", description: "" }], sourceAuthenticated: false, publishable: false };
const page = { kind: "history_source_catalog", sourceId: "owned", snapshotId, stale: false, refreshing: false, lastError: null,
  total: 1, page: pageRequest.page, nextOffset: null, entries: [{ catalogId, nativeTitle: null, titleStatus: "not_loaded" }], sourceAuthenticated: false, publishable: false };
const metadata = { kind: "history_source_metadata", ...metadataRequest, metadata: { sessionId: crypto.randomUUID(), nativeTitle: "原生名稱 🐾", summary: "摘要獨立顯示", titleStatus: "native" }, sourceAuthenticated: false, publishable: false };
const make = fetch => transport.create({ origin, hostId: "owned-host", viewId, canonicalJSON, routePrefix: "/r/owned", fetch });
const response = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
const rejects = (p, code) => assert.rejects(p, e => e.name === "HistoryTransportError" && e.code === code);
const operations = [
  { route: "/sources", body: {}, value: sources, run: (api, signal) => api.sources(signal) },
  { route: "/source-catalog", body: pageRequest, value: page, run: (api, signal) => api.sourceCatalog(pageRequest, signal) },
  { route: "/source-metadata", body: metadataRequest, value: metadata, run: (api, signal) => api.sourceMetadata(metadataRequest, signal) }
];
test("source groups, catalog pages and native metadata use only fixed same-origin dedicated-peer routes", async () => {
  for (const operation of operations) {
    let calls = 0;
    const api = make(async (url, init) => {
      calls++; assert.equal(url, origin + "/r/owned/api/history" + operation.route); assert.equal(init.method, "POST");
      assert.deepEqual(JSON.parse(init.body), operation.body); assert.equal(init.credentials, "same-origin"); assert.equal(init.redirect, "error");
      assert.equal(init.cache, "no-store"); assert.equal(init.headers.Authorization, undefined); assert.equal(init.headers["X-Stepsemble-History-CSRF"], "1");
      assert.equal(init.headers["X-Stepsemble-History-View"], viewId); return response(operation.value);
    });
    assert.deepEqual(await operation.run(api), operation.value); assert.equal(calls, 1);
  }
});
test("source metadata/catalog inputs are detached and validated before any network request", async () => {
  const api = make(() => assert.fail("invalid request fetched"));
  for (const request of [{ ...pageRequest, page: { offset: 0, limit: 51 } }, { ...pageRequest, page: { offset: 50, limit: 50 } },
    { ...pageRequest, refresh: true, snapshotId }, { ...pageRequest, projectsRoot: "/private" }, { ...pageRequest, sourceId: "../source" }])
    await rejects(api.sourceCatalog(request), "history_request_invalid");
  for (const request of [{ ...metadataRequest, snapshotId: null }, { ...metadataRequest, requestId: "bad" }, { ...metadataRequest, catalogId: "filename.jsonl" },
    { ...metadataRequest, nativeTitle: "forged" }, { ...metadataRequest, source: {} }, { ...metadataRequest, page: {} }])
    await rejects(api.sourceMetadata(request), "history_request_invalid");
  let getters = 0; const accessor = { ...metadataRequest };
  Object.defineProperty(accessor, "catalogId", { enumerable: true, get() { getters++; return catalogId; } });
  await rejects(api.sourceMetadata(accessor), "history_request_invalid"); assert.equal(getters, 0);
});
test("client and Host catalog validators agree on bounded 2048-entry paging and adversarial metadata", async () => {
  const sets = [
    { value: sources, client: transport.validSources, host: wire.validSources, run: api => api.sources(), changes: [v => { v.sources.push(v.sources[0]); },
      v => { v.sources[0].agentId = "codex"; }, v => { v.sources[0].label = ""; }, v => { v.sources[0].readers = ["private"]; }] },
    { value: page, client: v => transport.validSourceCatalog(v, pageRequest), host: v => wire.validPage(v, pageRequest, PUBLIC_CODES), run: api => api.sourceCatalog(pageRequest),
      changes: [v => { v.total = 2049; }, v => { v.total = 2; }, v => { v.entries[0].nativeTitle = "guessed"; }, v => { v.entries[0].titleStatus = "native"; },
        v => { v.entries[0].catalogId = "filename"; }, v => { v.lastError = "private diagnostic"; }, v => { v.nextOffset = 2; }, v => { v.snapshotId = null; }] },
    { value: metadata, client: v => transport.validSourceMetadata(v, metadataRequest), host: v => wire.validMetadata(v, metadataRequest), run: api => api.sourceMetadata(metadataRequest),
      changes: [v => { v.requestId = crypto.randomUUID(); }, v => { v.snapshotId = crypto.randomUUID(); }, v => { v.catalogId = "claude-" + "b".repeat(64); },
        v => { v.metadata.nativeTitle = "x".repeat(1025); }, v => { v.metadata.summary = "s".repeat(4097); }, v => { v.metadata.nativeTitle = null; },
        v => { v.metadata.titleStatus = "not_loaded"; }, v => { v.metadata.nativeTitle = "\u0000"; }, v => { v.metadata.sessionId = "wrong"; }, v => { v.metadata.path = "/private"; }] }
  ];
  for (const set of sets) {
    assert.equal(set.client(set.value), true); assert.equal(set.host(set.value), true);
    for (const change of [...set.changes, v => { v.sourceAuthenticated = true; }, v => { v.publishable = true; }, v => { v.source = "/private"; }]) {
      const value = structuredClone(set.value); change(value); assert.equal(set.client(value), false); assert.equal(set.host(value), false);
      await rejects(set.run(make(async () => response(value))), "history_response_invalid");
    }
  }
  for (const lastError of PUBLIC_CODES) {
    const value = { ...page, lastError }; assert.equal(transport.validSourceCatalog(value, pageRequest), wire.validPage(value, pageRequest, PUBLIC_CODES), lastError);
  }
  const lastRequest = { ...pageRequest, page: { offset: 2000, limit: 50 }, snapshotId };
  const last = { ...page, total: 2048, page: lastRequest.page, entries: Array.from({ length: 48 }, (_, n) => ({ catalogId: "claude-" + n.toString(16).padStart(64, "0"), nativeTitle: null, titleStatus: "not_loaded" })) };
  assert.equal(transport.validSourceCatalog(last, lastRequest), true); assert.equal(wire.validPage(last, lastRequest, PUBLIC_CODES), true);
});
test("source operations preserve explicit unsupported/stale/errors without automatic fallback, scans or retry", async () => {
  for (const operation of operations) for (const code of ["history_method_not_allowed", "history_source_unavailable", "history_catalog_changed", "source_inventory_limit", "source_metadata_invalid", "source_worker_failure"]) {
    let calls = 0; const value = { kind: "source_unavailable", code };
    assert.deepEqual(await operation.run(make(async () => { calls++; return response(value, 405); })), value); assert.equal(calls, 1);
  }
});
test("all source operations cancel promptly and discard/cancel an adapter's late response body", async () => {
  for (const operation of operations) {
    const controller = new AbortController(); let finish, fetchSignal, cancels = 0;
    const api = make((_url, init) => { fetchSignal = init.signal; return new Promise(resolve => { finish = resolve; }); });
    const pending = operation.run(api, controller.signal); await new Promise(resolve => setImmediate(resolve)); controller.abort();
    await rejects(pending, "history_aborted"); assert.equal(fetchSignal.aborted, true);
    finish(new Response(new ReadableStream({ cancel() { cancels++; } }), { headers: { "content-type": "application/json" } }));
    await new Promise(resolve => setImmediate(resolve)); assert.equal(cancels, 1);
  }
});
test("all source operations retain decoded byte limits even when Content-Length advertises one byte", async () => {
  for (const operation of operations) {
    let pulls = 0, cancels = 0;
    const api = make(async () => new Response(new ReadableStream({ pull(controller) {
      controller.enqueue(new Uint8Array(pulls++ === 0 ? transport.LIMITS.responseBytes : 1));
    }, cancel() { cancels++; } }), { headers: { "content-type": "application/json", "content-length": "1" } }));
    await rejects(operation.run(api), "history_response_too_large"); assert.equal(cancels, 1); assert.ok(pulls <= 3);
  }
});
