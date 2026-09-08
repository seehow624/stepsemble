#!/usr/bin/env node
import assert from "node:assert/strict";
import crypto from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { startSyntheticHistoryHost } from "./history-host-synthetic.mjs";
import transportModule from "../public/modules/history-transport.js";
import projection from "../public/modules/projection.js";
import catalogWire from "../server/history-catalog-wire.js";
import historyHttp from "../server/history-http.js";
const { create: createTransport } = transportModule, { canonicalJSON } = projection;

export async function checkHistorySetupNative(options) {
  const host = await startSyntheticHistoryHost({ ...options, sourceGroups: true, setupWizard: true }); let cleanup;
  const viewId = crypto.randomUUID(), cookie = `stepsemble=${crypto.createHash("sha256").update(host.token).digest("hex")}`;
  const api = createTransport({ origin: host.origin, hostId: "synthetic-host", viewId, canonicalJSON,
    fetch: (url, init) => fetch(url, { ...init, headers: { ...init.headers, origin: host.origin, cookie } }) });
  try {
    assert.equal(host.setupResult.created, true); assert.equal(host.setupResult.sourceReads, 0); assert.equal(host.setupResult.hostRestarted, false);
    const manual = await api.catalog(); assert.equal(manual.kind, "history_catalog"); assert.equal(manual.entries.length, 0);
    const sources = await api.sources(); assert.equal(sources.kind, "history_sources"); assert.equal(sources.sources.length, 1);
    assert.equal(sources.sources[0].sourceId, "fixture-root");
    const input = { sourceId: "fixture-root", page: { offset: 0, limit: 10 }, snapshotId: null, refresh: false };
    assert.equal((await api.sourceCatalog(input)).snapshotId, null, "wizard and Host startup do not scan");
    const catalog = await api.sourceCatalog({ ...input, refresh: true }); assert.equal(catalog.kind, "history_source_catalog"); assert.equal(catalog.total, 4);
    const metadata = await api.sourceMetadata({ sourceId: "fixture-root", catalogId: catalog.entries[0].catalogId, snapshotId: catalog.snapshotId, requestId: crypto.randomUUID() });
    assert.equal(metadata.kind, "history_source_metadata", metadata.code);
    const reg = await api.register({ catalogId: catalog.entries[0].catalogId, viewId }); assert.equal(reg.kind, "history_registration", reg.code);
    const page = await api.read({ hostId: "synthetic-host", bindingId: reg.bindingId, generation: reg.generation, sessionId: reg.sessionId },
      { bindingId: reg.bindingId, generation: reg.generation, requestId: crypto.randomUUID() }, { page: { offset: 0, limit: 10 }, signal: new AbortController().signal });
    assert.equal(page.kind, "bound_history_observation", page.code);
    const source = host.cases.find(row => row.sessionId === reg.sessionId); assert.ok(source);
    assert.deepEqual(page.history.observation.messages.map(row => row.nativeMessageId), source.expectedIds.slice(0, 10));
    assert.equal((await api.release({ bindingId: reg.bindingId, generation: reg.generation })).cleanupConfirmed, true);
  } finally { cleanup = await host.close(); }
  return { actualSetupGate: "passed", createdConfigUsedUnedited: true, setupSourceReads: 0, setupHostRestarted: false,
    explicitTestHostStartedAfterSetup: true, firstInventoryRequiresRefresh: true, actualSourceMetadataAndContent: true,
    modelCalls: 0, privateHistoryReads: 0, ...cleanup };
}

export async function checkHistoryHostNative(options) {
  const host = await startSyntheticHistoryHost({ ...options, sourceGroups: true }), viewId = crypto.randomUUID(); let cleanup;
  const cookie = token => `stepsemble=${crypto.createHash("sha256").update(token).digest("hex")}`;
  const browser = (token, view = viewId) => createTransport({ origin: host.origin, hostId: "synthetic-host", viewId: view, canonicalJSON,
    fetch: (url, init) => fetch(url, { ...init, headers: { ...init.headers, origin: host.origin, cookie: cookie(token) } }) });
  const api = browser(host.token);
  const mutate = (route, body) => fetch(host.origin + route, { method: "POST", headers: { cookie: cookie(host.token), origin: host.origin, "content-type": "application/json" }, body: JSON.stringify(body) });
  const groupRequest = async (route, body) => {
    const value = route === "/api/history/sources" ? await api.sources() : route === "/api/history/source-metadata"
      ? await api.sourceMetadata(body) : await api.sourceCatalog(body);
    if (value.kind !== "source_unavailable") assert.equal(route === "/api/history/sources" ? catalogWire.validSources(value)
      : route === "/api/history/source-metadata" ? catalogWire.validMetadata(value, body) : catalogWire.validPage(value, body, historyHttp.PUBLIC_CODES), true);
    return value;
  };
  const groupPage = (extra = {}) => groupRequest("/api/history/source-catalog", { sourceId: "fixture-root", page: { offset: 0, limit: 2 }, snapshotId: null, refresh: false, ...extra });
  const metadata = (catalog, catalogId) => groupRequest("/api/history/source-metadata", { sourceId: "fixture-root", catalogId,
    snapshotId: catalog.snapshotId, requestId: crypto.randomUUID() });
  const read = (transport, r, offset = 0, version) => transport.read({ hostId: "synthetic-host", bindingId: r.bindingId, generation: r.generation, sessionId: r.sessionId },
    { bindingId: r.bindingId, generation: r.generation, requestId: crypto.randomUUID() }, { page: { offset, limit: 10 }, signal: new AbortController().signal, ...(version ? { version } : {}) });
  try {
    const catalog = await api.catalog(); assert.equal(catalog.kind, "history_catalog", catalog.code); assert.equal(catalog.entries.length, 4);
    for (const c of host.cases) {
      const reg = await api.register({ catalogId: `fixture-${c.name}`, viewId }); assert.equal(reg.kind, "history_registration");
      const page = await read(api, reg); assert.equal(page.kind, "bound_history_observation", page.code); assert.equal(page.cleanupConfirmed, true);
      assert.deepEqual(page.history.observation.messages.map(m => m.nativeMessageId), c.expectedIds.slice(0, 10));
      assert.equal(page.sourceAuthenticated, false); assert.equal(page.publishable, false);
      if (c.name === "long") {
        const next = await read(api, reg, 10, page.sourceVersion); assert.equal(next.kind, "bound_history_observation", next.code);
        assert.deepEqual(next.history.observation.messages.map(m => m.nativeMessageId), c.expectedIds.slice(10, 20));
        await host.changeFixture("long"); const stale = await read(api, reg, 20, page.sourceVersion); assert.equal(stale.code, "source_version_changed");
        const fresh = await read(api, reg, 0); assert.equal(fresh.kind, "bound_history_observation", fresh.code); assert.notEqual(fresh.sourceVersion, page.sourceVersion);
      }
      assert.equal((await api.release({ bindingId: reg.bindingId, generation: reg.generation })).cleanupConfirmed, true);
    }
    assert.equal((await groupRequest("/api/history/sources", {})).sources.length, 1);
    assert.equal((await groupPage()).snapshotId, null, "startup/listing do not scan the source root");
    const firstCatalog = await groupPage({ refresh: true }); assert.equal(firstCatalog.total, 4); assert.equal(firstCatalog.entries.length, 2);
    assert.equal(firstCatalog.entries[0].nativeTitle, null); assert.equal(firstCatalog.entries[0].titleStatus, "not_loaded");
    const nextCatalog = await groupPage({ snapshotId: firstCatalog.snapshotId, page: { offset: 2, limit: 2 } });
    assert.equal(nextCatalog.entries.length, 2); assert.equal(nextCatalog.nextOffset, null);
    assert.equal(new Set([...firstCatalog.entries, ...nextCatalog.entries].map(e => e.catalogId)).size, 4);
    for (const entry of [...firstCatalog.entries, ...nextCatalog.entries]) {
      const value = await metadata(firstCatalog, entry.catalogId); assert.equal(value.kind, "history_source_metadata", value.code);
      const c = host.cases.find(c => c.sessionId === value.metadata.sessionId); assert.ok(c);
      const expectedTitle = c.name === "long" ? "Synthetic explicit version change" : c.name === "file-history" ? "Synthetic file history" : null;
      assert.equal(value.metadata.nativeTitle, expectedTitle); assert.equal(value.metadata.titleStatus, expectedTitle === null ? "untitled" : "native");
      if (expectedTitle === null) assert.equal(typeof value.metadata.summary, "string", "a native SDK summary is not silently promoted to title");
      for (const field of ["source", "sourceVersion", "bindingId", "identity", "projectsRoot", "readers"]) assert.equal(Object.hasOwn(value, field), false);
    }
    const dynamic = await api.register({ catalogId: firstCatalog.entries[0].catalogId, viewId }); assert.equal(dynamic.kind, "history_registration");
    const selectedCase = host.cases.find(c => c.sessionId === dynamic.sessionId); assert.ok(selectedCase);
    assert.deepEqual((await read(api, dynamic)).history.observation.messages.map(m => m.nativeMessageId), selectedCase.expectedIds.slice(0, 10));
    await host.changeFixture(selectedCase.name);
    assert.equal((await metadata(firstCatalog, dynamic.catalogId)).code, "history_catalog_changed", "captured metadata cannot be assigned to an older inventory identity");
    const refreshedCatalog = await groupPage({ refresh: true }); assert.equal(refreshedCatalog.total, 4);
    assert.notEqual(refreshedCatalog.snapshotId, firstCatalog.snapshotId);
    assert.equal((await read(api, dynamic)).code, "history_binding_unavailable", "metadata change retires the actual native binding");
    assert.equal((await groupPage({ snapshotId: firstCatalog.snapshotId, page: { offset: 2, limit: 2 } })).code, "history_catalog_changed");
    assert.equal((await metadata(firstCatalog, dynamic.catalogId)).code, "history_catalog_changed");
    assert.equal((await metadata(refreshedCatalog, dynamic.catalogId)).metadata.nativeTitle, "Synthetic explicit version change");
    await host.setFixturePresent(selectedCase.name, false); assert.equal((await groupPage({ refresh: true })).total, 3);
    assert.equal((await api.register({ catalogId: firstCatalog.entries[0].catalogId, viewId })).code, "history_source_unavailable");
    await host.setFixturePresent(selectedCase.name, true); assert.equal((await groupPage({ refresh: true })).total, 4);
    const issuedView = crypto.randomUUID(), issued = browser(host.issuedToken, issuedView);
    const reg = await issued.register({ catalogId: "fixture-rich", viewId: issuedView }); assert.equal(reg.kind, "history_registration");
    assert.equal((await mutate("/api/access-tokens/revoke", { id: host.issuedId })).status, 204);
    assert.equal((await read(issued, reg)).code, "history_unauthorized");
    const peerRequest = () => fetch(host.origin + "/api/history/catalog", { method: "POST", headers: { authorization: `Bearer ${host.peer.credential}`,
      "content-type": "application/json", "X-Stepsemble-History-View": crypto.randomUUID() }, body: "{}" });
    assert.equal((await peerRequest()).status, 200);
    assert.equal((await mutate("/api/device-grants/revoke", { grantId: host.peer.grantId })).status, 200);
    assert.equal((await peerRequest()).status, 401);
    const last = await api.register({ catalogId: "fixture-rich", viewId });
    assert.equal((await mutate("/api/logout", {})).status, 204);
    assert.equal((await read(api, last)).code, "history_binding_unavailable");
  } finally { cleanup = await host.close(); }
  return { actualHostGate: "passed", actualSourceGroupsGate: "passed", actualMetadataGate: "passed", platform: process.platform, nodeVersion: process.version, cases: 4, privateHistoryReads: 0, modelCalls: 0,
    helperArtifactSha256: host.helperHash, sdkSha256: host.sdkHash, helperArtifact: host.helperArtifact, sdkArtifact: host.sdkArtifact,
    sourceAuthenticated: false, publishable: false, productionChanged: false, ...cleanup };
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [helperPath, sdkPath] = process.argv.slice(2); console.log(JSON.stringify(await checkHistoryHostNative({ helperPath, sdkPath }), null, 2));
}
