"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), path = require("node:path"), http = require("node:http");
const { once } = require("node:events"), { createHash, randomUUID } = require("node:crypto");
const { createHistoryHost, parseHistoryConfig, SOURCE_GROUP_LIMIT } = require("../server/history-host");
const { createSourceIndex } = require("../protocol/native/claude/history-source-index");
const wire = require("../server/history-catalog-wire"), { PUBLIC_CODES } = require("../server/history-http");
const origin = "https://synthetic.invalid", primary = "a".repeat(64), secondary = "b".repeat(64), peer = "c".repeat(64), grant = "d".repeat(32);
const sid = n => `${n.toString(16).padStart(8, "0")}-1111-4111-8111-111111111111`;
const group = n => ({ sourceId: `source-${n}`, agentId: "claude-code", scope: "main_sessions", label: `Reviewed root ${n}`, description: "Owned fixture only",
  projectsRoot: path.resolve(`synthetic-group-${n}`), expectedRoot: { device: "1", inode: String(n + 2) }, readers: ["browser:master", `peer:${grant}`] });
const config = (count = 1) => ({ version: 2, trustBoundary: "host_managed_paths", allowedOrigins: [origin],
  reader: { helperPath: process.execPath, sdkPath: path.resolve("synthetic-sdk/sdk.mjs") }, catalog: [], sourceGroups: Array.from({ length: count }, (_, n) => group(n)) });
const entry = n => ({ projectKey: "owned", sessionId: sid(n), identity: { device: "1", inode: String(n + 10), size: 20, mtimeNs: "3", ctimeNs: "4" } });
const body = (sourceId = "source-0", extra = {}) => ({ sourceId, page: { offset: 0, limit: 50 }, snapshotId: null, refresh: false, ...extra });
const unavailable = code => ({ kind: "source_unavailable", code });
function inventory(entries, source) {
  const bytes = Buffer.from(JSON.stringify(entries));
  return { kind: "native_source_inventory", entries, byteLength: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"),
    entryCount: entries.length, projectsScanned: entries.length ? 1 : 0, ignoredEntries: 0, expectedRoot: source.expectedRoot,
    checks: { owner: "posix_euid_and_mode", acl: "no_extended_acl", containment: "root_identity_and_openat_nofollow", enumerations: 2, matchingInventory: true },
    sourceAuthenticated: false, publishable: false, cleanupConfirmed: true };
}
async function fixture(t, count = 1, options = {}) {
  const rows = [], indexes = [], states = [], budgets = []; let contentBudget, closed = false;
  const state = { tokens: [{ id: "master", hash: primary }, { id: "12345678", hash: secondary }], paired: null };
  const host = createHistoryHost({ config: config(count), browserCredentials: () => state.tokens, peerGrantIds: () => [grant],
    authenticatePeerCredential: token => token === peer ? { grantId: grant } : null, resolvePeer: () => state.paired,
    sourceIndexFactory(opts) {
      budgets.push(opts.admission);
      const control = { entries: [entry(1)], calls: 0, hold: false, cleanup: true, finish: null, aborted: false };
      states.push(control); let active = false, stopped = false;
      const index = createSourceIndex({ ...opts, createHelper: () => ({
        async inventory(source, { signal }) {
          control.calls++; active = true; control.aborted = false;
          let reply = control.error ? unavailable(control.error) : inventory(control.entries, source);
          if (control.hold) reply = await new Promise(resolve => {
            control.finish = () => { signal.removeEventListener("abort", cancel); resolve(inventory(control.entries, source)); };
            const cancel = () => { control.aborted = true; control.finish(); };
            signal.addEventListener("abort", cancel, { once: true });
          });
          active = false; return reply;
        }, status: () => ({ closed: stopped, quarantined: false, activeWorker: active, cleanupConfirmed: !active && control.cleanup }),
        async shutdown() { stopped = true; control.finish?.(); return { cleanupConfirmed: !active && control.cleanup }; }
      }) }); indexes.push(index); return index;
    },
    sourceServiceFactory(opts) {
      contentBudget = opts.admission;
      return { bind(input) {
        const row = { ...input, revoked: false }; rows.push(row);
        return { kind: "bound_source", revoke() { row.revoked = true; }, status: () => ({ revoked: row.revoked, activeWorker: false, cleanupConfirmed: true }),
          async observe() { return unavailable("source_missing"); } };
      }, status: () => ({ closed, quarantined: false }), async shutdown() { closed = true; return { cleanupConfirmed: true }; } };
    }, ...options });
  const server = http.createServer(async (req, res) => { if (!await host.handle(req, res)) res.writeHead(404).end(); });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const url = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { for (const s of states) s.finish?.(); await host.shutdown(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  async function request(route, data = {}, token = primary, view = randomUUID(), peerAuth = false) {
    const response = await fetch(url + route, { method: "POST", headers: { "Content-Type": "application/json", origin,
      "X-Stepsemble-History-CSRF": "1", "X-Stepsemble-History-View": view,
      ...(peerAuth ? { authorization: `Bearer ${token}` } : { cookie: `stepsemble=${token}` }) }, body: JSON.stringify(data) });
    return { status: response.status, value: await response.json() };
  }
  return { host, state, rows, indexes, states, budgets, contentBudget, url, request,
    page: (data = body(), token = primary) => request("/api/history/source-catalog", data, token) };
}
test("v2 source groups are explicit, strict, bounded, non-overlapping and compatible with v1 manual catalogs", () => {
  for (const value of [null, [], "private"]) assert.throws(() => parseHistoryConfig(value), /configuration_invalid/);
  assert.deepEqual(parseHistoryConfig(config()), config());
  const { sourceGroups: _groups, ...legacy } = config(); legacy.version = 1; assert.deepEqual(parseHistoryConfig(legacy), legacy);
  for (const change of [c => { delete c.sourceGroups; }, c => { c.reader = null; }, c => { c.sourceGroups[0].scope = "all"; },
    c => { c.sourceGroups[0].agentId = "codex"; }, c => { c.sourceGroups[0].readers = []; }, c => { c.sourceGroups[0].readers = ["*"]; },
    c => { c.sourceGroups[0].projectsRoot = path.parse(process.execPath).root; }, c => { c.sourceGroups[0].extra = true; },
    c => { c.sourceGroups.push({ ...group(0), sourceId: "another" }); }, c => { c.sourceGroups.push({ ...group(1), sourceId: "source-0" }); },
    c => { c.sourceGroups[0].expectedRoot.inode = "0"; }, c => { c.catalog.push({ catalogId: "manual", label: "manual", description: "",
      source: { projectsRoot: group(0).projectsRoot, projectKey: "owned", sessionId: sid(1) }, expectedRoot: { device: "1", inode: "9" }, readers: ["browser:master"] }); }]) {
    const c = config(); change(c); assert.throws(() => parseHistoryConfig(c), /configuration_invalid/);
  }
  assert.equal(parseHistoryConfig(config(SOURCE_GROUP_LIMIT)).sourceGroups.length, 8);
  assert.throws(() => parseHistoryConfig(config(SOURCE_GROUP_LIMIT + 1)), /configuration_invalid/);
});
test("actual Host lists only granted groups, no constructor/list scan, no private fields or guessed titles", async t => {
  const h = await fixture(t, 2); assert.equal(h.states[0].calls, 0); assert.ok(h.budgets.every(b => b === h.contentBudget));
  const sources = await h.request("/api/history/sources"); assert.equal(sources.status, 200); assert.equal(sources.value.sources.length, 2);
  assert.equal((await h.request("/api/history/sources", {}, secondary)).value.sources.length, 0);
  assert.equal((await h.request("/api/history/sources", {}, peer, undefined, true)).value.sources.length, 2);
  assert.equal((await h.request("/api/history/catalog")).value.entries.length, 0, "no dynamic paths enter the legacy catalog");
  assert.equal((await h.page()).value.snapshotId, null); assert.equal(h.states[0].calls, 0);
  assert.equal((await h.page(body("source-0", { refresh: true }), secondary)).value.code, "history_source_unavailable");
  const refreshed = await h.page(body("source-0", { refresh: true })); assert.equal(refreshed.status, 200); assert.equal(h.states[0].calls, 1);
  assert.equal(refreshed.value.entries[0].nativeTitle, null); assert.equal(refreshed.value.entries[0].titleStatus, "not_loaded");
  for (const privateField of ["projectsRoot", "expectedRoot", "readers", "sessionId", "mtimeNs", "sourceAuthenticated\":true"])
    assert.equal(JSON.stringify([sources.value, refreshed.value]).includes(privateField), false);
});
test("actual Host serves 2048 candidates through 50-row snapshot-fenced pages, validates before work, and preserves stale data", async t => {
  const h = await fixture(t); h.states[0].entries = Array.from({ length: 2048 }, (_, n) => entry(n));
  const first = (await h.page(body("source-0", { refresh: true }))).value;
  assert.equal(first.total, 2048); assert.equal(first.entries.length, 50); assert.equal(first.nextOffset, 50);
  const last = (await h.page(body("source-0", { page: { offset: 2000, limit: 50 }, snapshotId: first.snapshotId }))).value;
  assert.equal(last.entries.length, 48); assert.equal(last.nextOffset, null);
  for (const extra of [{ page: { offset: 0, limit: 51 } }, { page: { offset: 50, limit: 50 } }, { projectsRoot: "/private" },
    { refresh: true, snapshotId: first.snapshotId }, { sourceId: "../private" }, { snapshotId: "invalid" }])
    assert.equal((await h.page(body("source-0", extra))).status, 400);
  assert.equal(h.states[0].calls, 1);
  h.states[0].error = "source_inventory_limit";
  assert.equal((await h.page(body("source-0", { refresh: true }))).value.code, "source_inventory_limit");
  const stale = (await h.page()).value; assert.equal(stale.total, 2048); assert.equal(stale.stale, true); assert.equal(stale.lastError, "source_inventory_limit");
  h.states[0].error = null; h.states[0].entries = [];
  const empty = (await h.page(body("source-0", { refresh: true }))).value; assert.equal(empty.total, 0); assert.equal(empty.stale, false);
  assert.equal((await h.page(body("source-0", { snapshotId: first.snapshotId }))).value.code, "history_catalog_changed");
});
test("metadata change/removal retires actual registry bindings, same identity keeps them, and revoked groups never revive", async t => {
  const h = await fixture(t), first = (await h.page(body("source-0", { refresh: true }))).value, viewId = randomUUID(), id = first.entries[0].catalogId;
  const register = () => h.request("/api/history/registrations", { catalogId: id, viewId }, primary, viewId);
  const a = (await register()).value; assert.equal(a.kind, "history_registration");
  await h.page(body("source-0", { refresh: true })); assert.equal(h.rows[0].revoked, false);
  h.states[0].entries = [{ ...entry(1), identity: { ...entry(1).identity, size: 25 } }];
  await h.page(body("source-0", { refresh: true })); assert.equal(h.rows[0].revoked, true);
  const b = (await register()).value; assert.equal(b.generation, a.generation + 1);
  h.states[0].entries = []; await h.page(body("source-0", { refresh: true }));
  assert.equal(h.rows[1].revoked, true); assert.equal((await register()).value.code, "history_source_unavailable");
  h.states[0].entries = [entry(1)]; await h.page(body("source-0", { refresh: true }));
  assert.equal((await register()).value.kind, "history_registration");
  assert.equal(h.host.revokeSourceGroup("source-0"), true); assert.equal(h.rows[2].revoked, true);
  assert.equal((await h.request("/api/history/sources")).value.sources.length, 0);
  assert.equal((await h.page(body("source-0", { refresh: true }))).value.code, "history_source_unavailable");
  assert.equal((await register()).value.code, "history_source_unavailable");
});
test("actual Host shares two scans without queue; credential/group revoke cancels pending discovery and blocks late publish", async t => {
  const h = await fixture(t, 3); h.states[0].hold = h.states[1].hold = true;
  const a = h.page(body("source-0", { refresh: true })), b = h.page(body("source-1", { refresh: true }));
  for (let tries = 0; tries < 500 && (!h.states[0].finish || !h.states[1].finish); tries++) await new Promise(r => setTimeout(r, 10));
  assert.ok(h.states[0].finish && h.states[1].finish, "both owned scans started within bounded test setup");
  assert.equal(h.host.status().admission.activeWorkers, 2);
  assert.equal((await h.page(body("source-2", { refresh: true }))).value.code, "source_busy"); assert.equal(h.states[2].calls, 0);
  h.host.revokeSourceGroup("source-0"); h.state.tokens = []; h.host.credentialsChanged();
  assert.notEqual((await a).value.kind, "history_source_catalog"); assert.equal((await b).status, 401);
  assert.equal(h.states[0].aborted, true); assert.equal(h.states[1].aborted, true);
  assert.equal(h.indexes[0].status().retainedEntries, 0); assert.equal(h.indexes[1].status().retainedEntries, 0);
});
test("owned Host relay uses dedicated peer capability for source groups/paging and isolates a withdrawn gateway grant", async t => {
  const upstream = await fixture(t), gateway = await fixture(t);
  gateway.state.paired = { url: upstream.url, credential: peer, grantId: grant };
  const listed = await gateway.request("/r/owned/api/history/sources"); assert.equal(listed.status, 200); assert.equal(listed.value.sources.length, 1);
  const first = await gateway.request("/r/owned/api/history/source-catalog", body("source-0", { refresh: true }));
  assert.equal(first.status, 200); assert.equal(first.value.entries.length, 1); assert.equal(gateway.states[0].calls, 0); assert.equal(upstream.states[0].calls, 1);
  upstream.host.revokeSourceGroup("source-0");
  assert.equal((await gateway.request("/r/owned/api/history/source-catalog", body())).value.code, "history_source_unavailable");
  gateway.state.paired = null; gateway.host.peerChanged("owned");
  assert.equal((await gateway.request("/r/owned/api/history/sources")).value.code, "history_source_unavailable");
});
test("public catalog wire rejects private fields, false authority, oversized pages and incorrect correlation", () => {
  const request = body(), value = { kind: "history_source_catalog", sourceId: "source-0", snapshotId: randomUUID(), stale: false, refreshing: false,
    lastError: null, total: 1, page: request.page, nextOffset: null, entries: [{ catalogId: "claude-" + "a".repeat(64), nativeTitle: null, titleStatus: "not_loaded" }],
    sourceAuthenticated: false, publishable: false };
  assert.equal(wire.validPage(value, request, PUBLIC_CODES), true);
  for (const change of [v => { v.sourceId = "wrong"; }, v => { v.sourceAuthenticated = true; }, v => { v.path = "/private"; },
    v => { v.lastError = "private exception"; }, v => { v.total = 2; }, v => { v.nextOffset = 1; }, v => { v.entries[0].nativeTitle = "guessed"; },
    v => { v.entries[0].source = {}; }, v => { v.snapshotId = null; }, v => { v.entries[0].catalogId = {}; }]) {
    const v = structuredClone(value); change(v); assert.equal(wire.validPage(v, request, PUBLIC_CODES), false);
  }
});
test("group cleanup failure quarantines the shared Host and cached shutdown never turns unknown into success", async t => {
  const h = await fixture(t, 2); h.states[0].cleanup = false;
  assert.equal((await h.page(body("source-0", { refresh: true }))).value.code, "source_cleanup_unconfirmed");
  assert.equal((await h.page(body("source-1", { refresh: true }))).value.code, "source_service_quarantined");
  assert.equal(h.states[1].calls, 0);
  const stopped = await h.host.shutdown(); assert.equal(stopped.cleanupConfirmed, false); assert.equal(stopped.quarantined, true);
  h.states[0].cleanup = true; assert.equal(h.host.status().admission.cleanupConfirmed, true);
  assert.equal(h.host.status().admission.quarantined, true); assert.equal((await h.host.shutdown()).cleanupConfirmed, false);
});
