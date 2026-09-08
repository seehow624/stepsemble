"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), path = require("node:path"), crypto = require("node:crypto");
const { EventEmitter } = require("node:events"), { PassThrough } = require("node:stream");
const { createNativeHelper } = require("../protocol/native/claude/history-native-helper");
const wire = require("../protocol/native/claude/history-inventory-wire");
const { createSourceIndex } = require("../protocol/native/claude/history-source-index");
const input = () => ({ projectsRoot: path.resolve("synthetic-inventory"), expectedRoot: { device: "1", inode: "2" } });
const session = n => `${n.toString(16).padStart(8, "0")}-1111-4111-8111-111111111111`;
const entry = (n = 1) => ({ projectKey: "owned", sessionId: session(n), identity: { device: "1", inode: String(n + 2), size: 10, mtimeNs: "4", ctimeNs: "5" } });
function result(entries = [entry()]) {
  const bytes = Buffer.from(JSON.stringify(entries));
  return { kind: "native_source_inventory", byteLength: bytes.length, sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
    entryCount: entries.length, projectsScanned: new Set(entries.map(e => e.projectKey)).size, ignoredEntries: 0, expectedRoot: input().expectedRoot,
    checks: { owner: "posix_euid_and_mode", acl: "no_extended_acl", containment: "root_identity_and_openat_nofollow", enumerations: 2, matchingInventory: true },
    sourceAuthenticated: false, publishable: false };
}
function frame(job, entries = [entry()], change = v => v, payload = Buffer.from(JSON.stringify(entries))) {
  const json = Buffer.from(JSON.stringify(change({ protocolVersion: 2, nonce: job.nonce, result: result(entries) })));
  const length = Buffer.alloc(4); length.writeUInt32BE(json.length);
  return Buffer.concat([length, json, payload]);
}
function harness({ hold = false, platform = "linux", cleanupMs = 30, deadlineMs = 200 } = {}) {
  const children = [];
  const api = createNativeHelper({ executablePath: process.execPath, trustBoundary: "host_managed_executable", platform, cleanupMs, deadlineMs,
    spawnChild(_bin, args, options) {
      assert.deepEqual(args, []); assert.deepEqual(options.env, { LANG: "C", LC_ALL: "C" }); assert.equal(options.shell, false);
      const child = new EventEmitter(); child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
      const chunks = []; child.stdin.on("data", c => chunks.push(c)); child.job = () => JSON.parse(Buffer.concat(chunks));
      child.kills = 0; child.kill = () => { child.kills++; if (!hold) child.emit("close", null, "SIGKILL"); };
      child.finish = (bytes = frame(child.job())) => { child.stdout.write(bytes); child.emit("close", 0, null); };
      children.push(child); return child;
    } });
  return { api, children };
}
test("inventory is explicit-root protocol 2, detached, metadata-only, with no widening of read protocol", async () => {
  const h = harness(), original = input(), promise = h.api.inventory(original), c = h.children[0];
  original.projectsRoot = path.resolve("other"); original.expectedRoot.inode = "9";
  assert.deepEqual(Object.keys(c.job()).sort(), ["expectedRoot", "nonce", "projectsRoot", "protocolVersion"]);
  assert.equal(c.job().projectsRoot, input().projectsRoot); assert.equal(c.job().expectedRoot.inode, "2");
  assert.match(c.job().nonce, /^[a-f0-9]{64}$/); c.finish();
  const value = await promise; assert.equal(value.kind, "native_source_inventory"); assert.equal(value.cleanupConfirmed, true);
  assert.deepEqual(value.entries, [entry()]); assert.equal(Object.hasOwn(value, "bytes"), false);
  const empty = h.api.inventory(input()); h.children[1].finish(frame(h.children[1].job(), []));
  assert.deepEqual((await empty).entries, []); await h.api.shutdown();
});
test("inventory refuses untrusted paths, source fields, accessors, bad roots, signals, and Windows without spawn", async () => {
  const h = harness(); let invoked = 0;
  const getter = input(); Object.defineProperty(getter, "projectsRoot", { enumerable: true, get() { invoked++; return input().projectsRoot; } });
  for (const value of [null, {}, getter, { ...input(), maxEntries: 99999 }, { ...input(), source: {} },
    { ...input(), projectsRoot: path.parse(process.execPath).root }, { ...input(), projectsRoot: "relative" },
    { ...input(), projectsRoot: input().projectsRoot + "/.." }, { ...input(), projectsRoot: input().projectsRoot + "\n" },
    { ...input(), expectedRoot: { device: "1", inode: "0" } }]) assert.equal((await h.api.inventory(value)).code, "invalid_source_input");
  assert.equal((await h.api.inventory(input(), { signal: {} })).code, "invalid_source_signal");
  assert.equal(invoked, 0); assert.equal(h.children.length, 0); await h.api.shutdown();
  const w = harness({ platform: "win32" }); assert.equal((await w.api.inventory(input())).code, "source_platform_unsupported");
  assert.equal(w.children.length, 0); await w.api.shutdown();
});
test("inventory has shared single-flight with capture and requires close, not exit, before publication", async () => {
  const h = harness(), pending = h.api.inventory(input()), c = h.children[0]; let settled = false; pending.then(() => { settled = true; });
  c.stdout.write(frame(c.job())); c.emit("exit", 0, null); await new Promise(r => setImmediate(r)); assert.equal(settled, false);
  assert.equal((await h.api.inventory(input())).code, "source_busy");
  const { projectsRoot, expectedRoot } = input();
  assert.equal((await h.api.read({ source: { projectsRoot, projectKey: "owned", sessionId: session(1) }, expectedRoot })).code, "source_busy");
  c.emit("close", 0, null); assert.equal((await pending).kind, "native_source_inventory"); await h.api.shutdown();
});
test("inventory validates scope, wire versions, limits, digest, ordering, identities and authority atomically", async () => {
  for (const change of [v => { v.protocolVersion = 1; }, v => { v.nonce = "b".repeat(64); }, v => { v.result.expectedRoot.inode = "9"; },
    v => { v.result.publishable = true; }, v => { v.result.sourceAuthenticated = true; }, v => { v.result.checks.enumerations = 1; },
    v => { v.result.sha256 = "0".repeat(64); }, v => { v.result.entryCount++; }, v => { v.result.projectsScanned = 513; },
    v => { v.result.ignoredEntries = 10000; }, v => { v.result.byteLength--; }, v => { v.result.path = "/private"; }]) {
    const h = harness(), p = h.api.inventory(input()), c = h.children[0]; c.finish(frame(c.job(), [entry()], v => { change(v); return v; }));
    assert.equal((await p).code, "source_worker_protocol"); await h.api.shutdown();
  }
  for (const entries of [[entry(), entry()], [entry(2), entry(1)], [{ ...entry(), projectKey: "../escape" }],
    [{ ...entry(), sessionId: "not-native-uuid" }], [{ ...entry(), title: "do not infer" }],
    [{ ...entry(), identity: { ...entry().identity, device: "2" } }], [{ ...entry(), identity: { ...entry().identity, inode: "0" } }],
    [{ ...entry(), identity: { ...entry().identity, mtimeNs: "-1" } }], Array.from({ length: wire.LIMITS.entries + 1 }, (_, n) => entry(n))]) {
    const h = harness({ deadlineMs: 1000 }), p = h.api.inventory(input()), c = h.children[0]; c.finish(frame(c.job(), entries));
    assert.equal((await p).code, "source_worker_protocol"); await h.api.shutdown();
  }
});
test("exact inventory row limit passes; truncated/extra/malformed payloads and separate byte budget reject", async () => {
  const h = harness({ deadlineMs: 1000 }), p = h.api.inventory(input()), c = h.children[0], entries = Array.from({ length: wire.LIMITS.entries }, (_, n) => entry(n));
  c.finish(frame(c.job(), entries)); assert.equal((await p).entries.length, wire.LIMITS.entries); await h.api.shutdown();
  for (const mutate of [b => b.subarray(0, -1), b => Buffer.concat([b, Buffer.from(" ")]),
    () => Buffer.alloc(wire.LIMITS.bytes + 16389)]) {
    const f = harness(), pending = f.api.inventory(input()), child = f.children[0]; child.finish(mutate(frame(child.job())));
    assert.match((await pending).code, /^source_worker_(protocol|output_limit)$/); await f.api.shutdown();
  }
});
test("cancel, timeout, late close and shutdown keep one owned discovery worker and permanent quarantine", async () => {
  for (const mode of ["abort", "timeout", "shutdown"]) {
    const h = harness({ hold: true, cleanupMs: 10, deadlineMs: mode === "timeout" ? 10 : 200 }), controller = new AbortController();
    const p = h.api.inventory(input(), { signal: controller.signal }), c = h.children[0];
    if (mode === "abort") controller.abort(); if (mode === "shutdown") void h.api.shutdown();
    assert.equal((await p).code, "source_cleanup_unconfirmed"); assert.equal(c.kills, 1);
    assert.equal(h.api.status().activeWorker, true); assert.equal(h.api.status().quarantined, true);
    c.finish(); assert.equal(h.api.status().activeWorker, false); assert.equal(h.api.status().quarantined, true);
    assert.notEqual((await h.api.inventory(input())).kind, "native_source_inventory"); assert.equal(h.children.length, 1); await h.api.shutdown();
  }
});

function indexHarness() {
  let permitted = new Set(["owner"]), response = [entry()], resolve, launches = 0, active = false, closed = false, aborted = false;
  const index = createSourceIndex({ sourceId: "approved-claude-root", source: input(), helperPath: process.execPath,
    authorize: p => permitted.has(p), createHelper: () => ({
      async inventory(_input, { signal }) {
        launches++; active = true; aborted = false;
        signal.addEventListener("abort", () => { aborted = true; }, { once: true });
        if (response === null) response = await new Promise(r => { resolve = r; });
        active = false;
        return Array.isArray(response) ? { ...result(response), entries: response, cleanupConfirmed: true } : response;
      }, status: () => ({ activeWorker: active, closed, quarantined: false, cleanupConfirmed: !active }),
      async shutdown() { closed = true; resolve?.({ kind: "source_unavailable", code: "source_aborted" }); return { cleanupConfirmed: true }; }
    }) });
  return { index, set: value => { response = value; }, finish: value => resolve(value), revoke: () => { permitted = new Set(); },
    launches: () => launches, aborted: () => aborted };
}
test("source-group index requires authorization before scan and snapshot; no automatic work on construction", async () => {
  const h = indexHarness(); assert.equal(h.launches(), 0); assert.equal(h.index.view("owner").snapshot, null);
  assert.equal((await h.index.refresh("unknown")).code, "history_source_unavailable"); assert.equal(h.launches(), 0);
  const first = await h.index.refresh("owner"); assert.equal(first.stale, false); assert.equal(first.refreshing, false);
  assert.equal(first.sourceAuthenticated, false); assert.equal(first.publishable, false); assert.equal(first.revision, 1);
  first.snapshot.entries[0].source.projectKey = "mutated";
  assert.equal(h.index.view("owner").snapshot.entries[0].source.projectKey, "owned");
  h.revoke(); assert.equal(h.index.view("owner").code, "history_source_unavailable"); await h.index.shutdown();
});
test("incremental inventory preserves stable exact-source IDs and atomically reports added/changed/removed", async () => {
  const h = indexHarness(); const a = await h.index.refresh("owner"), id = a.snapshot.entries[0].catalogId;
  h.set([{ ...entry(), identity: { ...entry().identity, size: 11 } }, entry(2)]);
  const b = await h.index.refresh("owner"); assert.equal(b.snapshot.entries[0].catalogId, id);
  assert.deepEqual(b.snapshot.changes, { added: 1, changed: 1, removed: 0 });
  h.set([entry(2)]); const c = await h.index.refresh("owner"); assert.deepEqual(c.snapshot.changes, { added: 0, changed: 0, removed: 1 });
  h.set([]); const d = await h.index.refresh("owner"); assert.deepEqual(d.snapshot.entries, []); assert.equal(d.snapshot.changes.removed, 1);
  await h.index.shutdown();
});
test("failed or malformed refresh retains previous snapshot as stale instead of an empty success", async () => {
  const h = indexHarness(); await h.index.refresh("owner");
  for (const response of [{ kind: "source_unavailable", code: "source_inventory_limit" }, [{ ...entry(), projectKey: "../escape" }],
    { ...result(), entries: [entry()], cleanupConfirmed: false }]) {
    h.set(response); assert.equal((await h.index.refresh("owner")).kind, "source_unavailable");
    const state = h.index.view("owner"); assert.equal(state.stale, true); assert.equal(state.revision, 1); assert.equal(state.snapshot.entries.length, 1);
  }
  h.set([entry()]); assert.equal((await h.index.refresh("owner")).stale, false); await h.index.shutdown();
});
test("in-flight source authorization changes, explicit principal revoke and shutdown never publish late inventory", async () => {
  for (const mode of ["authority", "revoke", "shutdown", "cancel"]) {
    const h = indexHarness(); await h.index.refresh("owner"); h.set(null);
    const signal = new AbortController(), pending = h.index.refresh("owner", { signal: signal.signal });
    assert.equal((await h.index.refresh("owner")).code, "source_busy");
    if (mode === "authority") h.revoke();
    if (mode === "revoke") h.index.revokePrincipal("owner");
    if (mode === "shutdown") await h.index.shutdown();
    if (mode === "cancel") signal.abort();
    h.finish([entry(2)]); assert.equal((await pending).kind, "source_unavailable");
    assert.equal(h.index.status().revision, 1); assert.equal(h.index.status().stale, true);
    if (mode !== "authority") assert.equal(h.aborted(), true);
    await h.index.shutdown();
  }
});
test("source index quarantines unknown cleanup even if a late helper status claims it is idle", async () => {
  let cleanupConfirmed = false, calls = 0;
  const index = createSourceIndex({ sourceId: "owned", source: input(), helperPath: process.execPath, authorize: () => true,
    createHelper: () => ({ async inventory() { calls++; return { ...result(), entries: [entry()], cleanupConfirmed: true }; },
      status: () => ({ closed: false, quarantined: false, activeWorker: false, cleanupConfirmed }),
      async shutdown() { return { cleanupConfirmed }; } }) });
  assert.equal((await index.refresh("owner")).code, "source_cleanup_unconfirmed");
  cleanupConfirmed = true;
  assert.equal((await index.refresh("owner")).code, "source_service_quarantined");
  assert.equal(index.status().quarantined, true); assert.equal(calls, 1); await index.shutdown();
});
test("identical UUIDs from different exact projects remain separate candidates, not inferred duplicates", async () => {
  const h = indexHarness(); h.set([{ ...entry(), projectKey: "A" }, { ...entry(), projectKey: "B" }]);
  const first = await h.index.refresh("owner"); assert.equal(first.snapshot.entries.length, 2);
  assert.notEqual(first.snapshot.entries[0].catalogId, first.snapshot.entries[1].catalogId);
  const again = await h.index.refresh("owner"); assert.deepEqual(again.snapshot.changes, { added: 0, changed: 0, removed: 0 });
  assert.deepEqual(again.snapshot.entries, first.snapshot.entries); await h.index.shutdown();
});
test("private lookup keeps unchanged entry revisions but changed or removed/readded candidates never inherit old bindings", async () => {
  const h = indexHarness(), first = await h.index.refresh("owner"), id = first.snapshot.entries[0].catalogId;
  const a = h.index.lookup("owner", id); await h.index.refresh("owner");
  assert.deepEqual(h.index.lookup("owner", id), a); a.source.projectKey = "caller-mutated";
  assert.equal(h.index.lookup("owner", id).source.projectKey, "owned");
  h.set([{ ...entry(), identity: { ...entry().identity, size: 20 } }]); await h.index.refresh("owner");
  assert.notEqual(h.index.lookup("owner", id).revision, a.revision);
  h.set([]); await h.index.refresh("owner"); assert.equal(h.index.lookup("owner", id), null);
  h.set([entry()]); await h.index.refresh("owner"); assert.notEqual(h.index.lookup("owner", id).revision, a.revision);
  assert.equal(h.index.lookup("unknown", id), null); await h.index.shutdown(); assert.equal(h.index.lookup("owner", id), null);
});
test("public inventory pages are bounded, version-fenced and contain no private paths or guessed native titles", async () => {
  const h = indexHarness(); h.set(Array.from({ length: 101 }, (_, n) => entry(n)));
  await h.index.refresh("owner");
  const first = h.index.page("owner", { offset: 0, limit: 50, snapshotId: null });
  assert.equal(first.entries.length, 50); assert.equal(first.total, 101); assert.equal(first.nextOffset, 50);
  assert.equal(JSON.stringify(first).includes("projectsRoot"), false); assert.equal(JSON.stringify(first).includes("sessionId"), false);
  assert.ok(first.entries.every(e => e.nativeTitle === null && e.titleStatus === "not_loaded"));
  assert.equal(h.index.page("owner", { offset: 100, limit: 50, snapshotId: first.snapshotId }).entries.length, 1);
  assert.equal(h.index.page("owner", { offset: 50, limit: 50, snapshotId: null }).code, "history_catalog_changed");
  assert.equal(h.index.page("owner", { offset: 0, limit: 51, snapshotId: null }).code, "invalid_history_request");
  await h.index.refresh("owner");
  assert.equal(h.index.page("owner", { offset: 50, limit: 50, snapshotId: first.snapshotId }).code, "history_catalog_changed");
  h.revoke(); assert.equal(h.index.metadata("owner").code, "history_source_unavailable"); await h.index.shutdown();
});
