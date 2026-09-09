"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), crypto = require("node:crypto");
const path = require("node:path"), os = require("node:os"), fs = require("node:fs/promises");
const { EventEmitter } = require("node:events"), { PassThrough } = require("node:stream");
const { createHistoryRegistry, REGISTRY_LIMITS } = require("../protocol/native/claude/history-registry");
const { createSourceService } = require("../protocol/native/claude/history-source-service");
const { parseHistoryBytes } = require("../protocol/native/claude/history-source");
const { selectHistory } = require("../protocol/native/claude/history-selection");
const fixture = require("../protocol/native/claude/history-fixture.cjs");
const sid = fixture.sessionId, viewId = fixture.uuid(401), otherView = fixture.uuid(402), requestId = fixture.uuid(403);
const source = { projectsRoot: path.resolve("synthetic-projects"), projectKey: "-workspace", sessionId: sid };
const catalog = [{ catalogId: "one", source }, { catalogId: "two", source: { ...source, sessionId: fixture.otherSessionId } }];
const unavailable = code => ({ kind: "source_unavailable", code });
const scope = reg => ({ bindingId: reg.bindingId, generation: reg.generation, viewId: reg.viewId });
const request = (reg, extra = {}) => ({ ...scope(reg), requestId, page: { offset: 0, limit: 2 }, ...extra });
test("trusted dynamic resolution fences changed metadata and paths without expanding the fixed catalog", async () => {
  let selected = { source, revision: "one" };
  const h = setup({ catalog: [], resolveSource: () => selected });
  const first = h.register(); assert.equal(first.kind, "history_registration");
  assert.equal(h.registry.status().catalogSources, 0);
  selected = { source: { ...source }, revision: "one" }; h.registry.sweep();
  assert.equal(h.registry.current("alice", scope(first)), true);
  selected = { source, revision: "two" }; h.registry.sweep();
  assert.equal(h.registry.current("alice", scope(first)), false);
  const second = h.register(); assert.equal(second.generation, first.generation + 1);
  selected = { source: { ...source, projectKey: "other" }, revision: "two" };
  assert.equal(h.registry.current("alice", scope(second)), false, "unchanged resolver revision cannot mask a changed source tuple");
  selected = null; assert.equal(h.register().code, "history_source_unavailable"); await h.registry.shutdown();
});
test("dynamic resolver is authorized before lookup, rejects getters/promises and cannot revive withdrawn fixed entries", async () => {
  let calls = 0, selected = { source, revision: "v1" }, getterCalls = 0;
  const h = setup({ resolveSource: () => { calls++; return selected; } });
  h.denied.add("bob:dynamic"); assert.equal(h.register("bob", viewId, "dynamic").code, "history_source_unavailable"); assert.equal(calls, 0);
  const accessor = { source }; Object.defineProperty(accessor, "revision", { enumerable: true, get() { getterCalls++; return "v1"; } });
  for (const value of [accessor, Promise.resolve(selected), Promise.reject(new Error("private resolver failure")), { source, revision: "v1", authority: true }, { source, revision: "" }]) {
    selected = value; assert.equal(h.register("alice", viewId, "dynamic").code, "history_source_unavailable");
  }
  assert.equal(getterCalls, 0); selected = { source, revision: "v2" };
  h.registry.revokeSource("one"); assert.equal(h.register().code, "history_source_unavailable"); await h.registry.shutdown();
});
test("dynamic revision change during bind or observe rejects late publication and retires the exact old row", async () => {
  let revision = "a", resolve;
  const service = fakeService(), baseBind = service.bind;
  service.bind = input => {
    const bound = baseBind(input);
    return { ...bound, async observe() { return new Promise(r => { resolve = r; }); } };
  };
  const h = setup({ sourceService: service, catalog: [], resolveSource: () => ({ source, revision }) });
  const reg = h.register(), pending = h.registry.observe("alice", request(reg));
  revision = "b"; h.registry.sweep(); resolve({ kind: "bound_history_observation" });
  assert.equal((await pending).code, "history_binding_unavailable");
  service.bind = input => { const bound = baseBind(input); revision = "c"; return bound; };
  assert.equal(h.register().code, "history_binding_unavailable"); await h.registry.shutdown();
});
function fakeService() {
  const rows = new Map(); let closed = false, quarantined = false, binds = 0;
  return {
    bind(input) {
      binds++; const old = rows.get(input.bindingId);
      if (closed || quarantined) return unavailable("source_service_quarantined");
      if (old && (!old.revoked || old.activeWorker || input.generation <= old.generation)) return unavailable("source_binding_conflict");
      const row = { generation: input.generation, revoked: false, activeWorker: false, token: null }; rows.set(input.bindingId, row);
      return { kind: "bound_source", descriptor: { bindingId: input.bindingId, generation: input.generation, sessionId: input.source.sessionId },
        revoke() { row.revoked = true; row.token = null; },
        status: () => ({ revoked: row.revoked, activeWorker: row.activeWorker, cleanupConfirmed: !row.activeWorker }),
        async observe(req, options) {
          if (row.revoked) return unavailable("source_binding_revoked");
          if (options.version !== undefined && options.version !== row.token) return unavailable("source_version_unavailable");
          if (!options.version) row.token = crypto.randomBytes(32).toString("hex");
          return { kind: "bound_history_observation", ...req, sourceVersion: row.token, sourceAuthenticated: false, publishable: false, cleanupConfirmed: true };
        } };
    },
    status: () => ({ closed, quarantined, retainedBindings: rows.size, activeWorkers: [...rows.values()].filter(r => r.activeWorker).length, binds }),
    shutdown: async () => { closed = true; for (const r of rows.values()) r.revoked = true; return { cleanupConfirmed: true, quarantined }; },
  };
}
function setup(options = {}) {
  const active = new Set(["alice", "bob"]), denied = new Set();
  const service = options.sourceService || fakeService();
  const registry = createHistoryRegistry({ sourceService: service, catalog,
    principalActive: p => active.has(p), authorize: (p, id) => !denied.has(`${p}:${id}`), ...options });
  return { registry, service, active, denied, register: (p = "alice", v = viewId, id = "one") => registry.register(p, { catalogId: id, viewId: v }) };
}
test("Codex structured mode cannot invoke a Claude source or claim its registration", async () => {
  let reads = 0; const service = fakeService(), bind = service.bind;
  service.bind = input => { const bound = bind(input); return { ...bound, observe: async () => { reads++; return unavailable("unexpected_read"); } }; };
  const h = setup({ sourceService: service }), registration = h.register();
  assert.equal((await h.registry.observe("alice", request(registration, { structured: true }))).code, "invalid_history_request");
  assert.equal((await h.registry.metadata("alice", request(registration, { structured: true }))).code, "invalid_history_request");
  assert.equal(reads, 0); assert.equal(h.registry.current("alice", scope(registration)), true); await h.registry.shutdown();
});
test("catalog is fixed, bounded, detached and never accepts caller paths or authority", async () => {
  const entries = structuredClone(catalog), h = setup({ catalog: entries });
  entries[0].source.sessionId = fixture.otherSessionId;
  const r = h.register(); assert.equal(r.sessionId, sid); assert.equal(r.sourceAuthenticated, false); assert.equal(r.publishable, false);
  assert.deepEqual(Object.keys(r).sort(), ["kind", "bindingId", "generation", "sessionId", "viewId", "catalogId", "expiresAt", "sourceAuthenticated", "publishable"].sort());
  assert.equal(h.register("alice", otherView, "unknown").code, "history_source_unavailable");
  h.denied.add("bob:one"); assert.equal(h.register("bob").code, "history_source_unavailable");
  for (const key of ["source", "projectsRoot", "projectKey", "file", "sdkPath", "executable", "env", "principal", "approved"]) {
    assert.equal(h.registry.register("alice", { catalogId: "one", viewId, [key]: "/private/value" }).code, "invalid_history_registration");
    assert.equal((await h.registry.observe("alice", request(r, { [key]: "value" }))).code, "invalid_history_request");
  }
  assert.equal(h.service.status().binds, 1); await h.registry.shutdown();
  for (const bad of [[...catalog, catalog[0]], Array(REGISTRY_LIMITS.catalog + 1).fill(catalog[0]), [{ catalogId: "x", source: { ...source, projectsRoot: "/" } }],
    [{ catalogId: "x", source: { ...source, projectKey: "../escape" } }], [{ catalogId: "x", source, auth: true }]])
    assert.throws(() => setup({ catalog: bad }), /invalid_history_catalog/);
  for (const maxSlots of [0, 65, 1.5]) assert.throws(() => setup({ maxSlots }), /invalid_history_registry_options/);
});
test("accessors, malformed identity, unknown principal and extra options reject before service use", async () => {
  const h = setup(); let invoked = 0;
  const value = { viewId }; Object.defineProperty(value, "catalogId", { enumerable: true, get() { invoked++; return "one"; } });
  assert.equal(h.registry.register("alice", value).code, "invalid_history_registration");
  assert.equal(h.register("alice cookie secret").code, "history_principal_unavailable");
  const r = h.register();
  for (const extra of [{ generation: 0 }, { requestId: "x" }, { page: { offset: 0, limit: 101 } }, { version: "x" }, { viewId: "../" }])
    assert.equal((await h.registry.observe("alice", request(r, extra))).code, "invalid_history_request");
  const options = {}; Object.defineProperty(options, "signal", { enumerable: true, get() { invoked++; return undefined; } });
  assert.equal((await h.registry.observe("alice", request(r), options)).code, "invalid_source_signal");
  assert.equal((await h.registry.observe("alice", request(r), { source })).code, "invalid_source_signal");
  assert.equal(invoked, 0); await h.registry.shutdown();
});
test("principal, view, binding, generation and independent refresh tokens are isolated", async () => {
  const h = setup(), a = h.register(), b = h.register("alice", otherView), c = h.register("bob");
  assert.notEqual(a.bindingId, b.bindingId); assert.notEqual(a.bindingId, c.bindingId);
  const one = await h.registry.observe("alice", request(a)), two = await h.registry.observe("alice", request(b));
  assert.notEqual(one.sourceVersion, two.sourceVersion);
  for (const [p, req] of [["bob", request(a)], ["alice", request(a, { viewId: otherView })], ["alice", request(a, { generation: 2 })],
    ["alice", request(a, { bindingId: fixture.uuid(999) })]]) assert.equal((await h.registry.observe(p, req)).code, "history_binding_unavailable");
  assert.equal((await h.registry.observe("alice", request(b, { version: one.sourceVersion }))).code, "source_version_unavailable");
  const refresh = await h.registry.observe("alice", request(a)); assert.notEqual(refresh.sourceVersion, one.sourceVersion);
  assert.equal((await h.registry.observe("alice", request(b, { version: two.sourceVersion }))).sourceVersion, two.sourceVersion);
  assert.equal(h.register("alice", viewId, "two").code, "history_view_conflict");
  assert.equal(h.register().generation, a.generation); assert.equal(h.registry.status().activeSlots, 3);
  assert.equal(h.registry.release("bob", scope(a)).code, "history_binding_unavailable"); await h.registry.shutdown();
});
test("1000 cross-principal/session transfers retain one ID and strictly increasing generations", async () => {
  const h = setup({ maxSlots: 1, principalActive: () => true }); let bindingId, old;
  for (let i = 0; i < 1000; i++) {
    const principal = `owner:${i}`, r = h.register(principal, viewId, i % 2 ? "one" : "two");
    assert.equal(r.kind, "history_registration"); bindingId ||= r.bindingId; assert.equal(r.bindingId, bindingId); assert.equal(r.generation, i + 1);
    if (old) {
      assert.equal(h.registry.current(old.principal, scope(old.r)), false);
      assert.equal((await h.registry.observe(principal, request(r, { version: old.token }))).code, "source_version_unavailable");
      assert.equal(h.registry.release(old.principal, scope(old.r)).code, "history_binding_unavailable");
    }
    const read = await h.registry.observe(principal, request(r)); old = { principal, r, token: read.sourceVersion };
    assert.deepEqual(h.registry.release(principal, scope(r)), { kind: "history_released", cleanupConfirmed: true });
  }
  assert.equal(h.service.status().retainedBindings, 1); assert.equal(h.registry.status().retainedSlots, 1);
  assert.equal(h.registry.status().idleSlots, 1); await h.registry.shutdown();
});
test("64 live views cap allocation without unbounded per-principal state", async () => {
  const h = setup({ principalActive: () => true }), registrations = [];
  for (let i = 0; i < 64; i++) registrations.push(h.register(`owner:${i}`));
  assert.equal(h.register("owner:65").code, "history_capacity_unavailable");
  assert.equal(h.registry.status().retainedSlots, 64); assert.equal(h.service.status().retainedBindings, 64);
  h.registry.release("owner:0", scope(registrations[0])); const recycled = h.register("owner:65");
  assert.equal(recycled.bindingId, registrations[0].bindingId); assert.equal(recycled.generation, 2);
  assert.equal(h.registry.current("owner:0", scope(registrations[0])), false); await h.registry.shutdown();
});
test("private registration receipt cancels only the latest unclaimed attempt and cannot be replayed", async () => {
  const h = setup({ maxSlots: 1 }), first = h.register(), renewed = h.register();
  assert.notEqual(first, renewed); assert.deepEqual(scope(first), scope(renewed));
  assert.equal(h.registry.cancelRegistration("alice", first), false);
  assert.equal(h.registry.cancelRegistration("bob", renewed), false);
  assert.equal(h.registry.cancelRegistration("alice", structuredClone(renewed)), false);
  assert.equal(h.registry.current("alice", scope(renewed)), true);
  assert.equal(h.registry.cancelRegistration("alice", renewed), true);
  assert.equal(h.registry.cancelRegistration("alice", renewed), false);
  const next = h.register("bob"); assert.equal(next.bindingId, first.bindingId); assert.equal(next.generation, first.generation + 1);
  assert.equal(h.registry.cancelRegistration("alice", renewed), false); assert.equal(h.registry.current("bob", scope(next)), true);
  await h.registry.shutdown();
});
test("lost unobserved registration can switch authorized source; denied replacement preserves the old row", async () => {
  const h = setup({ maxSlots: 1 }), lost = h.register();
  h.denied.add("alice:two");
  assert.equal(h.register("alice", viewId, "two").code, "history_source_unavailable");
  assert.equal(h.register("alice", viewId, "unknown").code, "history_source_unavailable");
  assert.equal(h.registry.current("alice", scope(lost)), true);
  h.denied.delete("alice:two"); const replacement = h.register("alice", viewId, "two");
  assert.equal(replacement.kind, "history_registration"); assert.equal(replacement.bindingId, lost.bindingId); assert.equal(replacement.generation, lost.generation + 1);
  assert.equal(replacement.sessionId, fixture.otherSessionId); assert.equal(h.registry.cancelRegistration("alice", lost), false);
  assert.equal(h.registry.current("alice", scope(replacement)), true); assert.equal(h.service.status().retainedBindings, 1);
  await h.registry.observe("alice", request(replacement));
  assert.equal(h.register("alice", viewId, "one").code, "history_view_conflict"); await h.registry.shutdown();
});
test("a claimed row and all its subsequent renewals reject registration rollback", async () => {
  const worker = childService(), h = setup({ sourceService: worker.service }), first = h.register();
  const pending = h.registry.observe("alice", request(first)), renewed = h.register();
  assert.equal(h.registry.cancelRegistration("alice", first), false); assert.equal(h.registry.cancelRegistration("alice", renewed), false);
  assert.equal(worker.children[0].kills, 0); assert.equal(h.register("alice", viewId, "two").code, "history_view_conflict");
  worker.children[0].reply(unavailable("source_missing")); assert.equal((await pending).code, "source_missing");
  assert.equal(h.registry.current("alice", scope(renewed)), true); assert.equal(h.registry.cancelRegistration("alice", h.register()), false);
  await h.registry.shutdown();
});
test("tentative cancellation does not treat an unconfirmed worker close as reusable capacity", async () => {
  const base = fakeService(); let activeWorker = true, revoked = false;
  const service = { ...base, bind(input) {
    const bound = base.bind(input);
    return { ...bound, revoke() { revoked = true; bound.revoke(); },
      status: () => ({ revoked, activeWorker, cleanupConfirmed: !activeWorker }) };
  } };
  const h = setup({ sourceService: service, maxSlots: 1 }), first = h.register();
  assert.equal(h.registry.cancelRegistration("alice", first), true); assert.equal(h.registry.status().closingSlots, 1);
  assert.equal(h.register("alice", viewId, "two").code, "history_capacity_unavailable");
  activeWorker = false; const next = h.register("alice", viewId, "two");
  assert.equal(next.bindingId, first.bindingId); assert.equal(next.generation, first.generation + 1);
  await h.registry.shutdown();
});
test("current credential/ACL and fixed lease checks synchronously revoke all affected views", async () => {
  let clock = 1000; const h = setup({ now: () => clock, leaseMs: 100 });
  const a = h.register(), b = h.register("alice", otherView), other = h.register("bob");
  h.active.delete("alice"); assert.equal(h.registry.current("alice", scope(a)), false);
  assert.equal(h.registry.status().activeSlots, 1); assert.equal((await h.registry.observe("alice", request(b))).code, "history_binding_unavailable");
  h.denied.add("bob:one"); assert.equal(h.registry.current("bob", scope(other)), false); assert.equal(h.registry.status().idleSlots, 3);
  h.active.add("alice"); const r = h.register(); clock = r.expiresAt;
  assert.equal(h.registry.current("alice", scope(r)), false); assert.equal(h.registry.status().activeSlots, 0);
  const renewed = h.register(); assert.ok(renewed.generation > r.generation);
  h.registry.revokeSource("one"); assert.equal(h.registry.current("alice", scope(renewed)), false);
  assert.equal(h.register().code, "history_source_unavailable"); assert.equal(h.register("alice", viewId, "two").kind, "history_registration");
  await h.registry.shutdown(); assert.equal(h.register().code, "history_registry_closed");
});

function childService({ holdClose = false, cleanupMs = 30, onSpawn } = {}) {
  const children = [], service = createSourceService({ platform: "darwin", sdkPath: path.resolve("synthetic-sdk/sdk.mjs"), cleanupMs,
    spawnChild() {
      const child = new EventEmitter(); child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
      child.kills = 0; child.kill = () => { child.kills++; if (!holdClose) child.emit("close", null, "SIGKILL"); return true; };
      const input = []; child.stdin.on("data", b => input.push(b)); child.job = () => JSON.parse(Buffer.concat(input));
      child.reply = result => { child.stdout.write(JSON.stringify({ protocolVersion: 1, nonce: child.job().nonce, request: child.job().request, result }) + "\n"); child.emit("close", 0, null); };
      children.push(child); onSpawn?.(); return child;
    } });
  return { service, children };
}
const rich = fixture.richCases("/synthetic")[0];
async function history(job) {
  const parsed = parseHistoryBytes(Buffer.from(rich.records.map(r => JSON.stringify(r)).join("\n") + "\n"), rich.sessionId);
  const snapshot = { ...parsed, kind: "source_snapshot", identity: { device: "1", inode: "2", size: parsed.byteLength, mtimeNs: "3", ctimeNs: "4" },
    checks: { owner: "posix_euid_and_mode", reads: 2, matchingBytes: true, unchangedObservedIdentity: true }, sourceAuthenticated: false, publishable: false };
  return selectHistory(snapshot, job.history.page, async (sid, options) => {
    await options.sessionStore.load({ projectKey: options.dir.replace(/[^a-zA-Z0-9]/g, "-"), sessionId: sid });
    return fixture.selectedRows(rich).slice(options.offset, options.offset + options.limit);
  }); // Synthetic selector, actual source-service/wire validation.
}
const richCatalog = [{ catalogId: "one", source: { ...source, sessionId: rich.sessionId } }];
test("actual source service keeps two views' versions independent and gates publication after revoke", async () => {
  const worker = childService(), h = setup({ sourceService: worker.service, catalog: richCatalog });
  const a = h.register(), b = h.register("alice", otherView);
  async function read(reg, extra) { const p = h.registry.observe("alice", request(reg, extra)); const c = worker.children.at(-1); c.reply(await history(c.job())); return p; }
  const one = await read(a), two = await read(b); assert.equal(one.kind, "bound_history_observation"); assert.notEqual(one.sourceVersion, two.sourceVersion);
  const next = await read(a); assert.notEqual(next.sourceVersion, one.sourceVersion);
  assert.equal((await read(b, { version: two.sourceVersion })).sourceVersion, two.sourceVersion);
  const pending = h.registry.observe("alice", request(a)); const child = worker.children.at(-1);
  h.active.delete("alice"); h.registry.revokePrincipal("alice");
  assert.equal(child.kills, 1); assert.equal((await pending).code, "history_binding_unavailable");
  assert.equal(h.registry.status().activeSlots, 0); assert.equal(worker.service.status().activeWorkers, 0); await h.registry.shutdown();
});
test("source change makes each view independently stale without refreshing the other view", async () => {
  const worker = childService(), h = setup({ sourceService: worker.service, catalog: richCatalog });
  const a = h.register(), b = h.register("alice", otherView);
  async function read(reg, version, changed = false) {
    const p = h.registry.observe("alice", request(reg, version ? { version } : {}));
    const child = worker.children.at(-1), result = await history(child.job());
    if (changed) result.source.sha256 = "b".repeat(64);
    child.reply(result); return p;
  }
  const one = await read(a), two = await read(b);
  assert.equal((await read(a, one.sourceVersion, true)).code, "source_version_changed");
  assert.equal((await read(b, two.sourceVersion, true)).code, "source_version_changed");
  assert.equal((await h.registry.observe("alice", request(a, { version: one.sourceVersion }))).code, "source_version_unavailable");
  assert.equal((await h.registry.observe("alice", request(b, { version: two.sourceVersion }))).code, "source_version_unavailable");
  assert.equal(h.registry.current("alice", scope(a)), true); assert.equal(h.registry.current("alice", scope(b)), true);
  await h.registry.shutdown();
});
test("publication rechecks revoke or ACL changes after worker close and before async continuation", async () => {
  for (const change of [h => h.registry.revokeSource("one"), h => { h.active.delete("alice"); }, h => h.denied.add("alice:one")]) {
    const worker = childService(), h = setup({ sourceService: worker.service, catalog: richCatalog }), a = h.register();
    const pending = h.registry.observe("alice", request(a)), child = worker.children[0], result = await history(child.job());
    child.reply(result); change(h);
    assert.equal((await pending).code, "history_binding_unavailable"); assert.equal(h.registry.current("alice", scope(a)), false);
    await h.registry.shutdown();
  }
});
test("real source-service tombstone map stays at one across 1000 alternating owner/session registrations", async () => {
  const service = createSourceService(), h = setup({ sourceService: service, maxSlots: 1 }); let old;
  for (let i = 0; i < 1000; i++) {
    const owner = i % 2 ? "alice" : "bob", r = h.register(owner, viewId, i % 3 ? "one" : "two");
    assert.equal(r.kind, "history_registration"); assert.equal(r.generation, i + 1);
    if (old) assert.equal(r.bindingId, old.bindingId);
    assert.equal(h.registry.release(owner, scope(r)).cleanupConfirmed, true); old = r;
  }
  assert.equal(service.status().retainedBindings, 1); assert.equal(service.status().activeWorkers, 0); await h.registry.shutdown();
});
test("abort and source revocation in-flight cannot publish or alter another principal's view", async () => {
  for (const revoke of [false, true]) {
    const worker = childService(), h = setup({ sourceService: worker.service }), a = h.register(), b = h.register("bob", otherView, "two");
    const controller = new AbortController(), pending = h.registry.observe("alice", request(a), { signal: controller.signal });
    if (revoke) h.registry.revokeSource("one"); else controller.abort();
    assert.equal((await pending).code, revoke ? "history_binding_unavailable" : "source_aborted");
    assert.equal(worker.children[0].kills, 1); assert.equal(h.registry.current("bob", scope(b)), true);
    await h.registry.shutdown();
  }
});
test("closing slot waits for actual close; late old callback cannot revoke a transferred owner", async () => {
  const worker = childService({ holdClose: true }), h = setup({ sourceService: worker.service, maxSlots: 1 });
  const a = h.register(), pending = h.registry.observe("alice", request(a)), child = worker.children[0];
  assert.deepEqual(h.registry.release("alice", scope(a)), { kind: "history_released", cleanupConfirmed: false });
  assert.equal(h.registry.status().closingSlots, 1); assert.equal(h.register("bob").code, "history_capacity_unavailable");
  child.emit("close", null, "SIGKILL"); const b = h.register("bob");
  assert.equal(b.bindingId, a.bindingId); assert.equal(b.generation, 2);
  assert.equal((await pending).code, "history_binding_unavailable"); assert.equal(h.registry.current("bob", scope(b)), true);
  assert.equal(h.registry.release("alice", scope(a)).code, "history_binding_unavailable"); await h.registry.shutdown();
});
test("cleanup timeout permanently quarantines shared service even after late close", async () => {
  const worker = childService({ holdClose: true, cleanupMs: 10 }), h = setup({ sourceService: worker.service, maxSlots: 1 });
  const a = h.register(), pending = h.registry.observe("alice", request(a)), child = worker.children[0];
  h.registry.release("alice", scope(a)); assert.equal((await pending).code, "source_cleanup_unconfirmed");
  assert.equal(h.registry.status().closingSlots, 1); assert.equal(h.register("bob").code, "source_service_quarantined");
  child.emit("close", null, "SIGKILL"); h.registry.sweep(); assert.equal(h.registry.status().idleSlots, 1);
  assert.equal(h.register("bob").code, "source_service_quarantined"); assert.equal(worker.children.length, 1);
  assert.equal((await h.registry.shutdown()).quarantined, true);
});
test("lease timer expires idle views and cancels an in-flight owned worker without a next request", async () => {
  const worker = childService(), h = setup({ sourceService: worker.service, leaseMs: 25 });
  const a = h.register(), pending = h.registry.observe("alice", request(a));
  assert.equal((await pending).code, "history_binding_unavailable"); assert.equal(worker.children[0].kills, 1);
  assert.equal(h.registry.status().activeSlots, 0); await h.registry.shutdown();
});
test("shutdown invalidates first, confirms actual cleanup and cannot reopen", async () => {
  const worker = childService({ holdClose: true }), h = setup({ sourceService: worker.service });
  const a = h.register(), pending = h.registry.observe("alice", request(a)), shutdown = h.registry.shutdown();
  assert.equal(h.registry.current("alice", scope(a)), false); assert.equal(h.register("bob").code, "history_registry_closed");
  worker.children[0].emit("close", null, "SIGKILL");
  assert.equal((await pending).code, "history_registry_closed"); assert.deepEqual(await shutdown, { kind: "history_registry_closed", cleanupConfirmed: true, quarantined: false });
  assert.equal(h.registry.shutdown(), shutdown);
});
test("actual permission worker reads only owned fixture and reuses confirmed slot without source changes", { skip: !["darwin", "linux"].includes(process.platform) }, async t => {
  const home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "stepsemble-registry-owned-")));
  t.after(() => fs.rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));
  const projectsRoot = path.join(home, "projects"), project = path.join(projectsRoot, "-workspace"); await fs.mkdir(project, { recursive: true, mode: 0o700 });
  const filename = path.join(project, `${rich.sessionId}.jsonl`), bytes = Buffer.from(rich.records.map(r => JSON.stringify(r)).join("\n") + "\n");
  await fs.writeFile(filename, bytes, { mode: 0o600 });
  // An intentionally absent trusted SDK fails after source capture, with no
  // download or source discovery. Successful page decoding is tested above.
  const service = createSourceService({ sdkPath: path.join(home, "missing-sdk", "sdk.mjs") });
  const h = setup({ sourceService: service, maxSlots: 1, catalog: [{ catalogId: "one", source: { ...source, projectsRoot, sessionId: rich.sessionId } }] });
  t.after(() => h.registry.shutdown()); const a = h.register();
  assert.equal((await h.registry.observe("alice", request(a))).code, "source_sdk_unavailable");
  assert.deepEqual(h.registry.release("alice", scope(a)), { kind: "history_released", cleanupConfirmed: true });
  const b = h.register("bob"); assert.equal(b.bindingId, a.bindingId); assert.equal(b.generation, 2);
  assert.equal((await h.registry.observe("bob", request(b))).code, "source_sdk_unavailable");
  assert.deepEqual(await fs.readFile(filename), bytes); assert.equal(service.status().activeWorkers, 0); assert.equal(service.status().retainedBindings, 1);
});
