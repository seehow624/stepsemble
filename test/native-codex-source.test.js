"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), path = require("node:path"), crypto = require("node:crypto");
const { EventEmitter } = require("node:events"), { PassThrough } = require("node:stream");
const wire = require("../protocol/native/codex/source-wire");
const { createNativeHelper } = require("../protocol/native/claude/history-native-helper");
const id = "11111111-1111-4111-8111-111111111111", rootIdentity = { device: "1", inode: "2" };
const locator = `sessions/2026/01/05/rollout-2026-01-05T12-00-00-${id}.jsonl`;
const input = () => ({ nativeVersion: wire.VERSION, source: { codexRoot: path.resolve("owned-codex"), rolloutPath: locator, threadId: id }, expectedRoot: { ...rootIdentity } });
const sha = b => crypto.createHash("sha256").update(b).digest("hex");
function fixture(index = Buffer.from('原生名稱 🐾\n')) {
  const rollout = Buffer.from('原始內容\r\n'), bytes = Buffer.concat([rollout, index ?? Buffer.alloc(0)]);
  const desc = (bytes, offset, inode) => ({ byteOffset: offset, byteLength: bytes.length, sha256: sha(bytes), identity: { device: "1", inode, size: bytes.length, mtimeNs: "4", ctimeNs: "5" } });
  return { bytes, header: { kind: "native_codex_source_bytes", nativeVersion: wire.VERSION, threadId: id, rolloutPath: locator, rootIdentity: { ...rootIdentity },
    byteLength: bytes.length, sha256: sha(bytes), rollout: desc(rollout, 0, "3"), nameIndex: index === null ? null : desc(index, rollout.length, "4"),
    checks: { owner: "posix_euid_and_mode", acl: "no_extended_acl", containment: "root_identity_and_openat_nofollow", reads: 2,
      matchingBytes: true, unchangedObservedIdentity: true, nameIndexPresenceRechecked: true }, sourceAuthenticated: false, publishable: false } };
}
function frame(job, { header: result, bytes } = fixture(), change = v => v) {
  const header = Buffer.from(JSON.stringify(change({ protocolVersion: 3, nonce: job.nonce, result }))), size = Buffer.alloc(4);
  size.writeUInt32BE(header.length); return Buffer.concat([size, header, bytes]);
}
function harness(t, options = {}) {
  const children = [], h = createNativeHelper({ executablePath: process.execPath, trustBoundary: "host_managed_executable", platform: "linux",
    deadlineMs: 3000, cleanupMs: 20, ...options, spawnChild(_bin, args, opts) {
      assert.deepEqual(args, []); assert.deepEqual(opts.env, { LANG: "C", LC_ALL: "C" }); assert.equal(opts.shell, false);
      const child = new EventEmitter(); child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
      child.stdin.on("data", bytes => { child.job = JSON.parse(bytes); }); child.kills = [];
      child.kill = signal => { child.kills.push(signal); if (!child.hold) queueMicrotask(() => child.emit("close", null, signal)); return true; };
      child.finish = (bytes = frame(child.job)) => { child.stdout.write(bytes); child.emit("close", 0, null); };
      children.push(child); return child;
    } });
  t.after(async () => { for (const child of children) child.emit("close", 0, null); await h.shutdown(); });
  return { h, children };
}
test("Codex capture locators retain exact active/archive/revert identity and recognize compressed format", () => {
  const v = input(); assert.equal(wire.input(v), true);
  for (const base of ["sessions/2026/01/05/", "archived_sessions/"]) {
    for (const suffix of [".jsonl", "_22222222-2222-4222-8222-222222222222.jsonl", ".jsonl.zst"])
      assert.equal(wire.locator(`${base}rollout-2026-01-05T12-00-00-${id}${suffix}`, id), true);
  }
  for (const value of ["auth.json", "config.toml", "../session_index.jsonl", locator.replace("/05/", "/06/"), locator + "/..", locator + ".tmp",
    locator.replace("T12", "T24"), locator.replace("12-00-00", "12-60-00"), locator.replace("01/05", "02/29").replace("01-05T", "02-29T"), locator.replace(id, id.toUpperCase().replace("1", "a"))])
    assert.equal(wire.locator(value, id), false, value);
  assert.equal(wire.locator(`sessions/2024/02/29/rollout-2024-02-29T12-00-00-${id}.jsonl`, id), true);
  assert.equal(wire.input({ ...v, nativeVersion: "0.153.3" }), false);
});
test("Codex source input rejects arbitrary keys, accessors and unsafe roots before spawning", async t => {
  const { h, children } = harness(t); let called = 0;
  const getter = input(); Object.defineProperty(getter.source, "codexRoot", { enumerable: true, get() { called++; return "/private"; } });
  for (const candidate of [null, {}, getter, { ...input(), expectedRoot: { device: "1", inode: "0" } },
    { ...input(), expectedRoot: { device: "1", inode: "18446744073709551616" } }, { ...input(), nativeVersion: "latest" },
    { ...input(), source: { ...input().source, nameIndex: "auth.json" } }, { ...input(), args: [] },
    ...[path.parse(process.cwd()).root, input().source.codexRoot + "/..", input().source.codexRoot + "/", "/private\nroot"].map(codexRoot => ({ ...input(), source: { ...input().source, codexRoot } }))])
    assert.equal((await h.readCodexLegacy(candidate)).code, "invalid_source_input");
  assert.equal(called, 0); assert.equal(children.length, 0);
});
test("one complete v3 frame detaches both byte ranges only after actual close", async t => {
  const { h, children } = harness(t), value = input(), pending = h.readCodexLegacy(value), c = children[0];
  value.source.rolloutPath = "auth.json"; value.expectedRoot.inode = "9";
  assert.equal(c.job.protocolVersion, 3); assert.equal(c.job.source.rolloutPath, locator); assert.equal(c.job.expectedRoot.inode, "2");
  const fixtureValue = fixture(), bytes = frame(c.job, fixtureValue); c.stdout.write(bytes); c.emit("exit", 0);
  let done = false; pending.then(() => { done = true; }); await new Promise(resolve => setImmediate(resolve)); assert.equal(done, false);
  c.emit("close", 0, null); const result = await pending;
  assert.equal(result.kind, "native_codex_source_bytes"); assert.equal(result.cleanupConfirmed, true);
  assert.deepEqual(Buffer.concat([result.rolloutBytes, result.nameIndexBytes]), fixtureValue.bytes);
  bytes.fill(0); assert.equal(result.rolloutBytes.toString(), "原始內容\r\n");
  assert.equal(result.sourceAuthenticated, false); assert.equal(result.publishable, false);
});
test("absent name index, present empty index and replacement have distinct source versions", () => {
  const job = input(), missing = fixture(null), empty = fixture(Buffer.alloc(0)), present = fixture();
  const a = wire.decode(missing.header, missing.bytes, job), b = wire.decode(empty.header, empty.bytes, job), c = wire.decode(present.header, present.bytes, job);
  assert.equal(a.nameIndexBytes, null); assert.equal(b.nameIndexBytes.length, 0);
  const va = wire.sourceVersion(a), vb = wire.sourceVersion(b), vc = wire.sourceVersion(c);
  assert.ok(va); assert.equal(wire.sameSourceVersion(va, va), true);
  assert.equal(wire.sameSourceVersion(va, vb), false); assert.equal(wire.sameSourceVersion(vb, vc), false);
  for (const mutate of [v => { v.rootIdentity.inode = "9"; }, v => { v.rollout.identity.inode = "9"; }, v => { v.nameIndex.identity.mtimeNs = "9"; },
    v => { v.nameIndex.sha256 = "f".repeat(64); }, v => { v.rolloutPath = v.rolloutPath.replace(".jsonl", "_22222222-2222-4222-8222-222222222222.jsonl"); }]) {
    const changed = structuredClone(vc); mutate(changed); assert.equal(wire.sameSourceVersion(vc, changed), false);
  }
  c.rootIdentity.inode = "8"; assert.equal(vc.rootIdentity.inode, "2");
  assert.equal(wire.sameSourceVersion({}, {}), false);
  const invalid = structuredClone(vc); invalid.nameIndex.identity.inode = invalid.rollout.identity.inode;
  assert.equal(wire.sameSourceVersion(invalid, invalid), false);
  let called = 0; const getter = { ...present.header }; Object.defineProperty(getter, "rolloutBytes", { enumerable: true, get() { called++; return Buffer.alloc(1); } });
  assert.equal(wire.sourceVersion(getter), null); assert.equal(called, 0);
});
test("Codex pair framing rejects mixed roots, threads, versions, offsets, hashes and authority claims", async t => {
  const mutations = [v => { v.threadId = "22222222-2222-4222-8222-222222222222"; }, v => { v.nativeVersion = "0.153.3"; },
    v => { v.rootIdentity.inode = "9"; }, v => { v.rolloutPath = "auth.json"; }, v => { v.rollout.byteOffset = 1; },
    v => { v.nameIndex.byteOffset--; }, v => { v.byteLength--; }, v => { v.rollout.sha256 = "f".repeat(64); },
    v => { v.nameIndex.sha256 = "f".repeat(64); }, v => { v.sha256 = "f".repeat(64); }, v => { v.nameIndex.identity.device = "2"; },
    v => { v.rollout.identity.inode = "0"; }, v => { v.nameIndex.identity.inode = v.rollout.identity.inode; },
    v => { v.nameIndex.identity.size--; }, v => { v.checks.nameIndexPresenceRechecked = false; },
    v => { v.sourceAuthenticated = true; }, v => { v.publishable = true; }, v => { v.extra = "PRIVATE"; }, v => { v.nameIndex = null; }];
  for (const mutate of mutations) {
    const { h, children } = harness(t), p = h.readCodexLegacy(input()), f = fixture(); mutate(f.header); children[0].finish(frame(children[0].job, f));
    assert.deepEqual(await p, { kind: "source_unavailable", code: "source_worker_protocol" });
  }
  for (const modify of [v => ({ ...v, nonce: "0".repeat(64) }), v => ({ ...v, protocolVersion: 1 }), v => ({ ...v, extra: true })]) {
    const { h, children } = harness(t), p = h.readCodexLegacy(input()); children[0].finish(frame(children[0].job, fixture(), modify)); assert.equal((await p).code, "source_worker_protocol");
  }
});
test("partial or oversized pairs and unexpected diagnostics never release partial raw data", async t => {
  for (const mode of ["short", "trailing", "oversize", "diagnostic"]) {
    const { h, children } = harness(t), p = h.readCodexLegacy(input()), c = children[0], bytes = frame(c.job);
    if (mode === "diagnostic") c.stderr.write("PRIVATE");
    else if (mode === "oversize") c.stdout.write(Buffer.alloc(wire.LIMITS.outputBytes+1));
    else c.finish(mode === "short" ? bytes.subarray(0, bytes.length-1) : Buffer.concat([bytes, Buffer.from("extra")]));
    const result = await p; assert.equal(result.kind, "source_unavailable"); assert.equal(Object.hasOwn(result, "rolloutBytes"), false);
    assert.equal(JSON.stringify(result).includes("PRIVATE"), false);
  }
});
test("Codex, Claude and inventory share the same flight and cleanup quarantine", async t => {
  const { h, children } = harness(t), abort = new AbortController(), p = h.readCodexLegacy(input(), { signal: abort.signal }), c = children[0]; c.hold = true;
  const claude = { source: { projectsRoot: path.resolve("owned-claude"), projectKey: "owned", sessionId: id }, expectedRoot: rootIdentity };
  assert.equal((await h.read(claude)).code, "source_busy");
  assert.equal((await h.inventory({ projectsRoot: claude.source.projectsRoot, expectedRoot: rootIdentity })).code, "source_busy");
  abort.abort("PRIVATE"); assert.equal((await p).code, "source_cleanup_unconfirmed");
  c.emit("close", 0, null); assert.equal((await h.readCodexLegacy(input())).code, "source_service_quarantined");
  assert.equal((await h.read(claude)).code, "source_service_quarantined");
  assert.equal(children.length, 1); assert.deepEqual(c.kills, ["SIGKILL"]);
});
test("pre-abort, Windows and a native unsupported reply remain explicit with no capability promotion", async t => {
  const win = harness(t, { platform: "win32" }); assert.equal((await win.h.readCodexLegacy(input())).code, "source_platform_unsupported"); assert.equal(win.children.length, 0);
  const { h, children } = harness(t), abort = new AbortController(); abort.abort(); assert.equal((await h.readCodexLegacy(input(), { signal: abort.signal })).code, "source_aborted");
  assert.equal(children.length, 0);
  const p = h.readCodexLegacy(input()), c = children[0]; c.finish(frame(c.job, { header: { kind: "source_unavailable", code: "source_encoding_unsupported" }, bytes: Buffer.alloc(0) }));
  assert.deepEqual(await p, { kind: "source_unavailable", code: "source_encoding_unsupported" });
});
