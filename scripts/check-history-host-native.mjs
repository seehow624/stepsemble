#!/usr/bin/env node
import assert from "node:assert/strict";
import crypto from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { startSyntheticHistoryHost } from "./history-host-synthetic.mjs";
import transportModule from "../public/modules/history-transport.js";
import projection from "../public/modules/projection.js";
const { create: createTransport } = transportModule, { canonicalJSON } = projection;

export async function checkHistoryHostNative(options) {
  const host = await startSyntheticHistoryHost(options), viewId = crypto.randomUUID(); let cleanup;
  const cookie = token => `stepsemble=${crypto.createHash("sha256").update(token).digest("hex")}`;
  const browser = (token, view = viewId) => createTransport({ origin: host.origin, hostId: "synthetic-host", viewId: view, canonicalJSON,
    fetch: (url, init) => fetch(url, { ...init, headers: { ...init.headers, origin: host.origin, cookie: cookie(token) } }) });
  const api = browser(host.token);
  const mutate = (route, body) => fetch(host.origin + route, { method: "POST", headers: { cookie: cookie(host.token), origin: host.origin, "content-type": "application/json" }, body: JSON.stringify(body) });
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
  return { actualHostGate: "passed", platform: process.platform, nodeVersion: process.version, cases: 4, privateHistoryReads: 0, modelCalls: 0,
    helperArtifactSha256: host.helperHash, sdkSha256: host.sdkHash, helperArtifact: host.helperArtifact, sdkArtifact: host.sdkArtifact,
    sourceAuthenticated: false, publishable: false, productionChanged: false, ...cleanup };
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [helperPath, sdkPath] = process.argv.slice(2); console.log(JSON.stringify(await checkHistoryHostNative({ helperPath, sdkPath }), null, 2));
}
