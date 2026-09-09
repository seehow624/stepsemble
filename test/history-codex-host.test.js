"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), path = require("node:path"), http = require("node:http");
const { once } = require("node:events"), { randomUUID } = require("node:crypto");
const { createHistoryHost, parseHistoryConfig } = require("../server/history-host");
const { createCodexSourceIndex } = require("../protocol/native/codex/history-source-index");
const { harness, group, f } = require("./support/codex-binding-harness.cjs");
const catalogFixture = require("../protocol/native/codex/catalog-fixture.cjs"), catalogWire = require("../protocol/native/codex/sqlite-wire").catalog;
const transport = require("../public/modules/history-transport"), { canonicalJSON } = require("../public/modules/projection");
const origin = "https://owned.invalid", primary = "a".repeat(64), secondary = "b".repeat(64), peer = "c".repeat(64), grant = "d".repeat(32);
const config = () => ({ version: 3, trustBoundary: "host_managed_paths", allowedOrigins: [origin], reader: { helperPath: process.execPath, sdkPath: null }, catalog: [],
  sourceGroups: [{ ...group(), sourceId: "owned-codex", agentId: "codex", scope: "stored_threads", label: "Owned Codex", description: "No private source reads", readers: ["browser:master", `peer:${grant}`] }] });
const row = () => ({ ...catalogFixture.entry(f.id), rolloutPath: path.join(f.root, f.request().source.rolloutPath) });
const refresh = () => ({ sourceId: "owned-codex", snapshotId: null, page: { offset: 0, limit: 50 }, refresh: true });
async function setup(t, options = {}) {
  const input = options.config ?? config(), control = { entries: [row()], scans: 0, credentials: [{ id: "master", hash: primary }, { id: "12345678", hash: secondary }], peer: null, bindings: null };
  const budgets = [], host = createHistoryHost({ config: input, browserCredentials: () => control.credentials, peerGrantIds: () => [grant],
    authenticatePeerCredential: v => v === peer ? { grantId: grant } : null, resolvePeer: () => control.peer,
    sourceServiceFactory(opts) {
      budgets.push(opts.admission); let closed = false;
      return { bind() { let revoked = false; return { kind: "bound_source", revoke() { revoked = true; }, status: () => ({ revoked, activeWorker: false, cleanupConfirmed: true }),
        observe: async () => ({ kind: "source_unavailable", code: "source_missing" }) }; }, status: () => ({ closed, quarantined: false, cleanupConfirmed: true }),
        async shutdown() { closed = true; return { cleanupConfirmed: true }; } };
    },
    codexSourceIndexFactory(opts) {
      budgets.push(opts.admission); return createCodexSourceIndex({ ...opts, platform: "linux", createHelper: () => ({
        status: () => ({ activeWorker: false, cleanupConfirmed: true, quarantined: false }), shutdown: async () => ({ cleanupConfirmed: true }),
        async readCodexCatalog(request) {
          control.scans++; const packet = catalogFixture.packet(catalogFixture.body(control.entries));
          return catalogWire.decode(packet.header, packet.payload, request);
        } }) });
    },
    codexSourceServiceFactory(opts) {
      budgets.push(opts.admission); const h = harness(t, { admission: opts.admission, auto: true, ...options.binding }); control.bindings = h;
      if (!options.alterMetadata) return h.service;
      return { ...h.service, bind(input) { const bound = h.service.bind(input); if (bound.kind !== "bound_source") return bound;
        return { ...bound, async metadata(...args) { const result = await bound.metadata(...args); options.alterMetadata(result); return result; } }; } };
    } });
  const server = http.createServer(async (req, res) => { if (!await host.handle(req, res)) res.writeHead(404).end(); });
  server.listen(0, "127.0.0.1"); await once(server, "listening"); const url = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { await host.shutdown(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  async function request(route, body = {}, viewId = randomUUID(), token = primary, method = "POST") {
    const res = await fetch(url + route, { method, headers: { "Content-Type": "application/json", origin, cookie: `stepsemble=${token}`,
      "X-Stepsemble-History-CSRF": "1", "X-Stepsemble-History-View": viewId }, body: JSON.stringify(body) });
    return { status: res.status, value: await res.json() };
  }
  return { host, control, budgets, request, url, client(viewId) { return transport.create({ origin: url, hostId: "owned", viewId, canonicalJSON,
    fetch: (url, opts) => fetch(url, { ...opts, headers: { ...opts.headers, origin, cookie: `stepsemble=${primary}` } }) }); } };
}
test("v3 Codex groups require two explicit matching roots/readers, preserve v1/v2 and need no Claude SDK", () => {
  assert.deepEqual(parseHistoryConfig(config()), config());
  for (const mutate of [c => { c.version = 2; }, c => { c.reader = null; }, c => { c.sourceGroups[0].nativeVersion = "latest"; },
    c => { c.sourceGroups[0].scope = "main_sessions"; }, c => { delete c.sourceGroups[0].expectedSqliteRoot; }, c => { c.sourceGroups[0].readers = ["*"]; },
    c => { c.sourceGroups[0].codexRoot = c.sourceGroups[0].sqliteRoot; c.sourceGroups[0].expectedSqliteRoot.inode = "99"; }, c => { c.sourceGroups[0].sqliteRoot += "/../private"; },
    c => { c.sourceGroups.push({ ...c.sourceGroups[0], sourceId: "duplicate" }); }]) {
    const c = config(); mutate(c); assert.throws(() => parseHistoryConfig(c), /configuration_invalid/);
  }
});
test("structured Codex records cross actual Host HTTP and typed transport without a raw downgrade or extra authority", async t => {
  const h = await setup(t, { binding: { capture: method => method === "readCodex" ? f.structuredCaptured() : f.sqliteCapture() } });
  const viewId = randomUUID(), client = h.client(viewId), catalog = await client.sourceCatalog(refresh());
  const r = await client.register({ catalogId: catalog.entries[0].catalogId, viewId });
  const scope = { hostId: "owned", bindingId: r.bindingId, generation: r.generation, sessionId: r.sessionId };
  const request = () => ({ bindingId: r.bindingId, generation: r.generation, requestId: randomUUID() });
  let offset = 0, version; const records = [], annotations = [];
  do {
    const result = await client.readCodex(scope, request(), { page: { offset, limit: 2 }, signal: undefined, structured: true, ...(version ? { version } : {}) });
    assert.equal(result.kind, "bound_codex_records", result.code); version = result.sourceVersion;
    assert.equal(result.history.nativeTitle, "原生候選 🐾"); assert.equal(result.history.structure.totalTurns, 1);
    assert.equal(result.history.semanticHistoryComplete, false); assert(Object.values(result.history.authority).every(v => v === false));
    records.push(...result.history.records.records); annotations.push(...result.history.structure.annotations); offset = result.history.records.nextOffset;
  } while (offset !== null);
  assert.equal(records.map(r => r.rawText).join(""), f.structuredCaptured().rolloutBytes.toString());
  assert.equal(annotations[5].tool.relatedRecordIndex, 6); assert.equal(annotations[6].tool.relatedRecordIndex, 5);
  const raw = await client.readCodex(scope, request(), { page: { offset: 0, limit: 2 }, version, signal: undefined });
  assert.equal(raw.history.structure, undefined); assert.deepEqual(raw.history.records.records, records.slice(0, 2));
  const stages = h.control.bindings.stages.length;
  for (const structured of [false, 1, "true", null]) {
    assert.equal((await h.request("/api/history/page", { ...request(), page: { offset: 0, limit: 2 }, structured }, viewId)).status, 400);
  }
  assert.equal((await h.request("/api/history/page", { ...request(), page: { offset: 0, limit: 2 }, structured: true }, viewId, secondary)).value.kind, "source_unavailable");
  assert.equal(h.control.bindings.stages.length, stages);
  await client.release({ bindingId: r.bindingId, generation: r.generation });
  assert.equal((await client.readCodex(scope, request(), { page: { offset: 0, limit: 2 }, signal: undefined, structured: true })).kind, "source_unavailable");
  assert.equal(h.control.bindings.stages.length, stages); assert.equal(h.host.status().admission.activeWorkers, 0);
});
test("large-page profile crosses Host registry and typed HTTP, with old-client and cross-profile fences", async t => {
  const large = require("./support/codex-large-fixture.cjs")(), h = await setup(t, { binding: { capture: large.capture } });
  const viewId = randomUUID(), client = h.client(viewId), catalog = await client.sourceCatalog(refresh()), profile = "codex_validated_page_v1";
  const metadata = await client.sourceMetadata({ sourceId: catalog.sourceId, catalogId: catalog.entries[0].catalogId, snapshotId: catalog.snapshotId, requestId: randomUUID() });
  assert.equal(metadata.kind, "history_source_metadata", metadata.code); assert.equal(metadata.metadata.nativeTitle, "原生候選 🐾");
  assert.equal(Object.hasOwn(metadata, "sourceVersion"), false);
  const r = await client.register({ catalogId: catalog.entries[0].catalogId, viewId });
  const scope = { hostId: "owned", bindingId: r.bindingId, generation: r.generation, sessionId: r.sessionId };
  const request = () => ({ bindingId: r.bindingId, generation: r.generation, requestId: randomUUID() });
  const first = await client.readCodex(scope, request(), { page: { offset: 0, limit: 2 }, profile, signal: undefined });
  assert.equal(first.kind, "bound_codex_records", first.code); assert.equal(first.history.records.recordCount, 9005);
  const last = await client.readCodex(scope, request(), { page: { offset: 9000, limit: 10 }, version: first.sourceVersion, profile, signal: undefined });
  assert.equal(last.kind, "bound_codex_records", last.code); assert.equal(last.sourceVersion, first.sourceVersion); assert.equal(last.history.records.records.length, 5);
  assert.equal(last.history.records.endOfFile, true); assert.equal(last.history.structure, undefined);
  const stages = h.control.bindings.stages.length;
  for (const extra of [{}, { profile: "future" }, { profile, structured: true }]) {
    const bad = await h.request("/api/history/page", { ...request(), page: { offset: 9000, limit: 2 }, ...extra }, viewId);
    assert.equal(bad.status, 400);
  }
  const old = await client.readCodex(scope, request(), { page: { offset: 0, limit: 2 }, version: first.sourceVersion, signal: undefined });
  assert.equal(old.code, "source_version_unavailable"); assert.equal(h.control.bindings.stages.length, stages);
  await client.release({ bindingId: r.bindingId, generation: r.generation });
  assert.equal((await client.readCodex(scope, request(), { page: { offset: 9000, limit: 2 }, profile, signal: undefined })).kind, "source_unavailable");
  assert.equal(h.control.bindings.stages.length, stages); assert.equal(h.host.status().admission.activeWorkers, 0);
});
test("global structured pages traverse real Host HTTP and typed transport with original IDs, EOF and explicit version fences", async t => {
  const large = require("./support/codex-large-fixture.cjs")(true), h = await setup(t, { binding: { capture: large.capture } });
  const viewId = randomUUID(), client = h.client(viewId), catalog = await client.sourceCatalog(refresh()), profile = "codex_structured_page_v1";
  const r = await client.register({ catalogId: catalog.entries[0].catalogId, viewId });
  const scope = { hostId: "owned", bindingId: r.bindingId, generation: r.generation, sessionId: r.sessionId };
  const request = () => ({ bindingId: r.bindingId, generation: r.generation, requestId: randomUUID() });
  const read = (offset, version, selectedProfile = profile) => client.readCodex(scope, request(), { page: { offset, limit: 10 }, signal: undefined,
    profile: selectedProfile, ...(version ? { version } : {}) });
  const first = await read(0); assert.equal(first.kind, "bound_codex_records", first.code);
  assert.equal(first.history.kind, "codex_structured_page_source_records"); assert.equal(first.history.structure.totalTurns, 2);
  assert.equal(first.history.structure.annotations[3].tool.relatedRecordIndex, 9000);
  assert.equal(first.history.structure.turns[1].nativeTurnId, "原生回合 🐾"); assert.equal(first.history.structure.turns[1].branchState, "rolled_back");
  const last = await read(9000, first.sourceVersion); assert.equal(last.kind, "bound_codex_records", last.code);
  assert.equal(last.sourceVersion, first.sourceVersion); assert.equal(last.history.records.endOfFile, true);
  assert.equal(last.history.structure.annotations[0].tool.relatedRecordIndex, 3); assert.equal(last.history.structure.annotations[0].tool.nativeCallId, "原生工具 🐾");
  assert.equal(last.history.structure.turns[0].nativeTurnId, "原生回合 🐾");
  const eof = await read(9005, first.sourceVersion); assert.equal(eof.history.records.nextOffset, null); assert.deepEqual(eof.history.structure.turns, []);
  assert.deepEqual(eof.history.structure.annotations, []); assert.equal(eof.history.structure.totalTurns, 2);
  const before = h.control.bindings.stages.length;
  assert.equal((await read(9000, first.sourceVersion, "codex_validated_page_v1")).code, "source_version_unavailable");
  assert.equal(h.control.bindings.stages.length, before);
  assert.equal((await h.request("/api/history/page", { ...request(), page: { offset: 0, limit: 2 }, profile, structured: true }, viewId)).status, 400);
  const raw = await read(9000, undefined, "codex_validated_page_v1"); assert.equal(raw.history.structure, undefined);
  assert.deepEqual(raw.history.records, last.history.records); assert.notEqual(raw.sourceVersion, first.sourceVersion);
  assert.equal((await read(9000, raw.sourceVersion)).code, "source_version_unavailable");
  await client.release({ bindingId: r.bindingId, generation: r.generation }); assert.equal(h.host.status().admission.activeWorkers, 0);
  assert.equal(h.control.bindings.physical(), 0);
});
test("global structured page survives a dedicated peer relay and stops on peer revocation", async t => {
  const large = require("./support/codex-large-fixture.cjs")(true), upstream = await setup(t, { binding: { capture: large.capture } }), gateway = await setup(t), viewId = randomUUID();
  gateway.control.peer = { url: upstream.url, credential: peer, grantId: grant };
  const prefix = "/r/owned/api/history", page = (await gateway.request(prefix + "/source-catalog", refresh(), viewId)).value;
  const r = (await gateway.request(prefix + "/registrations", { catalogId: page.entries[0].catalogId, viewId }, viewId)).value;
  const body = { bindingId: r.bindingId, generation: r.generation, requestId: randomUUID(), profile: "codex_structured_page_v1", page: { offset: 9000, limit: 2 } };
  const result = await gateway.request(prefix + "/page", body, viewId); assert.equal(result.status, 200, result.value.code);
  assert.equal(result.value.history.structure.turns[0].nativeTurnId, "原生回合 🐾"); assert.equal(result.value.history.structure.annotations[0].tool.relatedRecordIndex, 3);
  assert.equal(result.value.history.authority.resumeAllowed, false);
  gateway.control.peer = null; gateway.host.peerChanged("owned");
  assert.equal((await gateway.request(prefix + "/page", body, viewId)).value.kind, "source_unavailable");
});
test("large-page request and selected native identity survive the dedicated peer relay", async t => {
  const large = require("./support/codex-large-fixture.cjs")(), upstream = await setup(t, { binding: { capture: large.capture } }), gateway = await setup(t), viewId = randomUUID();
  gateway.control.peer = { url: upstream.url, credential: peer, grantId: grant };
  const prefix = "/r/owned/api/history", page = (await gateway.request(prefix + "/source-catalog", refresh(), viewId)).value;
  const r = (await gateway.request(prefix + "/registrations", { catalogId: page.entries[0].catalogId, viewId }, viewId)).value;
  const body = { bindingId: r.bindingId, generation: r.generation, requestId: randomUUID(), profile: "codex_validated_page_v1", page: { offset: 9000, limit: 2 } };
  const result = await gateway.request(prefix + "/page", body, viewId); assert.equal(result.status, 200, result.value.code);
  assert.equal(result.value.history.kind, "codex_validated_source_records"); assert.equal(result.value.history.records.offset, 9000);
  assert.equal(result.value.history.nativeThreadId, f.id); assert.equal(result.value.history.authority.resumeAllowed, false);
  gateway.control.peer = null; gateway.host.peerChanged("owned");
  assert.equal((await gateway.request(prefix + "/page", body, viewId)).value.kind, "source_unavailable");
});
test("changing display mode over real HTTP waits for the previous read receipt, not just local fetch abort", async t => {
  const h = await setup(t, { binding: { holdReader: true } }), viewId = randomUUID(), client = h.client(viewId);
  const catalog = await client.sourceCatalog(refresh());
  const model = require("../public/modules/codex-history-view").createModel({ hostId: "owned", viewId, catalogId: catalog.entries[0].catalogId,
    initialStructured: true, transport: client, canonicalJSON, requestId: randomUUID });
  t.after(() => model.close());
  const waitFor = async condition => { for (let n = 0; n < 100 && !condition(); n++) await new Promise(resolve => setTimeout(resolve, 5)); assert(condition()); };
  const selected = model.select(catalog.entries[0].catalogId); await waitFor(() => h.control.bindings.stages.length === 1);
  const switched = model.setStructured(false);
  // A browser abort settles before the Host's held reader closes. A display
  // preference must not race a second read against that still-owned worker.
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(model.state().error, null); assert.equal(model.state().busy, true); assert.equal(h.control.bindings.stages.length, 1);
  for (let n = 0; n < 8; n++) {
    await waitFor(() => !!h.control.bindings.activeHelper());
    await h.control.bindings.step(h.control.bindings.stages.at(-1) === "readCodex" ? f.structuredCaptured() : f.sqliteCapture());
  }
  await selected; await switched; assert.equal(model.state().stage, "loaded"); assert.equal(model.state().page.history.structure, undefined);
  assert.equal(h.control.bindings.physical(), 0);
});
test("cancelled HTTP fetch exposes delayed physical cleanup without spawning a concurrent reader and manual refresh recovers", async t => {
  const h = await setup(t, { binding: { holdReader: true } }), viewId = randomUUID(), client = h.client(viewId);
  const catalog = await client.sourceCatalog(refresh());
  const model = require("../public/modules/codex-history-view").createModel({ hostId: "owned", viewId, catalogId: catalog.entries[0].catalogId,
    initialStructured: false, transport: client, canonicalJSON, requestId: randomUUID });
  t.after(() => model.close());
  const waitFor = async condition => { for (let n = 0; n < 100 && !condition(); n++) await new Promise(resolve => setTimeout(resolve, 5)); assert(condition()); };
  const finishRead = async () => {
    // holdReader pauses only the four helper captures; the parser child keeps
    // the harness's auto-close behavior and must not be stepped a fifth time.
    for (let n = 0; n < 4; n++) { await waitFor(() => !!h.control.bindings.activeHelper()); await h.control.bindings.step(); }
  };
  const selected = model.select(catalog.entries[0].catalogId); await finishRead(); await selected;
  assert.equal(model.state().stage, "loaded"); assert.equal(h.control.bindings.physical(), 0);
  const stages = h.control.bindings.stages.length, pending = model.next();
  await waitFor(() => h.control.bindings.stages.length === stages + 1 && h.control.bindings.physical() === 1);
  const restarted = model.refresh(); await Promise.allSettled([pending, restarted]);
  assert.equal(h.control.bindings.stages.length, stages + 1, "busy fence precedes a second physical spawn");
  assert.equal(h.control.bindings.physical(), 1); assert.equal(model.state().stage, "cancelled");
  assert.equal(model.state().error, null); assert.equal(model.state().cleanupPending, true); assert.equal(model.state().canNext, false);
  await model.next(); await model.previous(); await model.jump(1);
  assert.equal(h.control.bindings.stages.length, stages + 1, "cleanup-pending navigation is fenced in the model");
  await h.control.bindings.step(); await waitFor(() => h.control.bindings.physical() === 0);
  const recovered = model.refresh(); await finishRead(); await recovered;
  assert.equal(model.state().stage, "loaded"); assert.equal(model.state().cleanupPending, false);
  assert.equal(model.state().error, null); assert.equal(h.control.bindings.physical(), 0);
});
test("real Host + index + binding + parser + typed HTTP transport exposes Codex without leaking private source selectors", async t => {
  const h = await setup(t), viewId = randomUUID(), client = h.client(viewId);
  assert.equal(h.control.scans, 0); assert.equal(h.control.bindings.stages.length, 0); assert.equal(h.budgets.length, 2); assert.equal(h.budgets[0], h.budgets[1]);
  const sources = await client.sources(); assert.equal(sources.sources[0].agentId, "codex"); assert.equal(sources.sources[0].scope, "stored_threads");
  assert.equal((await h.request("/api/history/sources", {}, viewId, secondary)).value.sources.length, 0);
  const catalog = await client.sourceCatalog(refresh()); assert.equal(catalog.kind, "history_source_catalog"); assert.equal(catalog.total, 1);
  const metadata = await client.sourceMetadata({ sourceId: catalog.sourceId, catalogId: catalog.entries[0].catalogId, snapshotId: catalog.snapshotId, requestId: randomUUID() });
  assert.equal(metadata.kind, "history_source_metadata", metadata.code); assert.equal(metadata.metadata.nativeTitle, "原生候選 🐾");
  for (const privateField of ["rootIdentity", "rolloutPath", "expectedRoot", "bindingId", "sourceVersion", "readers", "nameContext"])
    assert(!JSON.stringify([sources, catalog, metadata]).includes(privateField));
  assert.equal(h.host.status().registry.activeSlots, 0);
  const registered = await client.register({ catalogId: catalog.entries[0].catalogId, viewId }); assert.equal(registered.kind, "history_registration");
  const scope = { hostId: "owned", bindingId: registered.bindingId, generation: registered.generation, sessionId: registered.sessionId };
  const request = () => ({ bindingId: scope.bindingId, generation: scope.generation, requestId: randomUUID() });
  const page = await client.readCodex(scope, request(), { page: { offset: 0, limit: 2 }, signal: undefined });
  assert.equal(page.kind, "bound_codex_records"); assert.equal(page.history.nativeThreadId, f.id); assert.equal(page.history.records.records.length, 2);
  const next = await client.readCodex(scope, request(), { page: { offset: page.history.records.nextOffset, limit: 2 }, version: page.sourceVersion, signal: undefined });
  assert.equal(next.sourceVersion, page.sourceVersion); assert.equal(next.history.records.offset, 2);
  await assert.rejects(client.read(scope, request(), { page: { offset: 0, limit: 2 }, signal: undefined }), /history_response_invalid/);
  assert.equal((await client.release({ bindingId: scope.bindingId, generation: scope.generation })).cleanupConfirmed, true);
  assert.equal(h.host.status().registry.retainedSlots, 1); assert.equal(h.host.status().admission.activeWorkers, 0);
});
test("unsafe catalog paths stay visible and paginated full history is explicit unavailable, never a silent empty transcript", async t => {
  const h = await setup(t); h.control.entries = [{ ...row(), rolloutPath: path.resolve("outside-root") }];
  let page = (await h.request("/api/history/source-catalog", refresh())).value;
  let metadata = { sourceId: page.sourceId, catalogId: page.entries[0].catalogId, snapshotId: page.snapshotId, requestId: randomUUID() };
  assert.equal(page.total, 1); assert.equal((await h.request("/api/history/source-metadata", metadata)).value.code, "source_scope_mismatch");
  assert.equal(h.control.bindings.stages.length, 0);
  h.control.entries = [{ ...row(), historyMode: "paginated" }]; page = (await h.request("/api/history/source-catalog", refresh())).value;
  metadata = { ...metadata, snapshotId: page.snapshotId }; assert.equal((await h.request("/api/history/source-metadata", metadata)).status, 200);
  const viewId = randomUUID(), r = (await h.request("/api/history/registrations", { catalogId: page.entries[0].catalogId, viewId }, viewId)).value;
  const count = h.control.bindings.stages.length;
  const history = await h.request("/api/history/page", { bindingId: r.bindingId, generation: r.generation, requestId: randomUUID(), page: { offset: 0, limit: 25 } }, viewId);
  assert.equal(history.value.code, "native_paginated_history_unsupported"); assert.equal(h.control.bindings.stages.length, count);
});
test("catalog revision/root withdrawal and credential revocation retire old registry readers", async t => {
  const h = await setup(t), viewId = randomUUID(); let page = (await h.request("/api/history/source-catalog", refresh())).value;
  const register = async () => (await h.request("/api/history/registrations", { catalogId: page.entries[0].catalogId, viewId }, viewId)).value;
  const first = await register(); assert.equal(h.host.status().registry.activeSlots, 1);
  h.control.entries[0].archived = true; page = (await h.request("/api/history/source-catalog", refresh())).value;
  assert.equal(h.host.status().registry.activeSlots, 0); const second = await register(); assert(second.generation > first.generation);
  h.control.credentials = []; h.host.credentialsChanged(); assert.equal(h.host.status().registry.activeSlots, 0);
  assert.equal(h.host.revokeSourceGroup("owned-codex"), true); assert.equal((await h.request("/api/history/sources")).status, 401);
});
test("mixed Claude/Codex views share exactly one 64-slot registry, not two per-agent registries", async t => {
  const c = config(); c.reader.sdkPath = path.resolve("owned-sdk/sdk.mjs"); c.catalog = [{ catalogId: "manual-claude", label: "Owned Claude", description: "",
    source: { projectsRoot: path.resolve("owned-claude"), projectKey: "owned", sessionId: randomUUID() }, expectedRoot: { device: "1", inode: "999" }, readers: ["browser:master"] }];
  const h = await setup(t, { config: c }), page = (await h.request("/api/history/source-catalog", refresh())).value;
  assert.equal(h.budgets.length, 3); assert(h.budgets.every(b => b === h.budgets[0]));
  for (let i = 0; i < 64; i++) { const viewId = randomUUID(); const r = await h.request("/api/history/registrations", { catalogId: i % 2 ? "manual-claude" : page.entries[0].catalogId, viewId }, viewId); assert.equal(r.value.kind, "history_registration"); }
  const viewId = randomUUID(); assert.equal((await h.request("/api/history/registrations", { catalogId: page.entries[0].catalogId, viewId }, viewId)).value.code, "history_capacity_unavailable");
  assert.equal(h.host.status().registry.activeSlots, 64); assert.equal(h.host.status().registry.retainedSlots, 64);
  assert.equal((await h.host.shutdown()).cleanupConfirmed, true);
});
test("Host rejects mismatched Codex metadata proof instead of publishing a trusted-factory success blindly", async t => {
  for (const change of [v => { v.source.history.rootIdentity.inode = "99"; }, v => { v.metadata.nativeTitle = "forged"; }, v => { v.name.nativeTitleResolved = true; }]) {
    const h = await setup(t, { alterMetadata: change }), page = (await h.request("/api/history/source-catalog", refresh())).value;
    const result = await h.request("/api/history/source-metadata", { sourceId: page.sourceId, catalogId: page.entries[0].catalogId, snapshotId: page.snapshotId, requestId: randomUUID() });
    assert.equal(result.status, 409); assert.equal(result.value.code, "history_response_invalid"); assert.equal(h.host.status().registry.activeSlots, 0);
  }
});
test("dedicated owned peer relay preserves Codex DTO and revokes its local view after peer withdrawal", async t => {
  const upstream = await setup(t, { binding: { capture: method => method === "readCodex" ? f.structuredCaptured() : f.sqliteCapture() } }), gateway = await setup(t), viewId = randomUUID(); gateway.control.peer = { url: upstream.url, credential: peer, grantId: grant };
  const prefix = "/r/owned/api/history", page = (await gateway.request(prefix + "/source-catalog", refresh(), viewId)).value;
  const registered = (await gateway.request(prefix + "/registrations", { catalogId: page.entries[0].catalogId, viewId }, viewId)).value;
  const body = { bindingId: registered.bindingId, generation: registered.generation, requestId: randomUUID(), page: { offset: 0, limit: 2 } };
  const result = await gateway.request(prefix + "/page", body, viewId); assert.equal(result.status, 200, result.value.code); assert.equal(result.value.kind, "bound_codex_records");
  const linked = await gateway.request(prefix + "/page", { ...body, requestId: randomUUID(), structured: true, version: result.value.sourceVersion }, viewId);
  assert.equal(linked.status, 200, linked.value.code); assert.equal(linked.value.history.structure.totalTurns, 1);
  assert.deepEqual(linked.value.history.records, result.value.history.records);
  gateway.control.peer = null; gateway.host.peerChanged("owned"); assert.equal((await gateway.request(prefix + "/page", body, viewId)).value.kind, "source_unavailable");
});
