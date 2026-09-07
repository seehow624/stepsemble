"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs/promises");
const path = require("node:path"), os = require("node:os"), { EventEmitter } = require("node:events"), { PassThrough } = require("node:stream");
const { spawn } = require("node:child_process");
const fixture = require("../protocol/native/claude/history-fixture.cjs");
const { createSourceService } = require("../protocol/native/claude/history-source-service");
const { createSourceReader, parseHistoryBytes } = require("../protocol/native/claude/history-source");
const { selectHistory } = require("../protocol/native/claude/history-selection");
const wire = require("../protocol/native/claude/history-worker-wire");
const testCase = fixture.richCases("/synthetic")[0], bindingId = fixture.uuid(70), requestId = fixture.uuid(71);
const source = { projectsRoot: path.resolve("synthetic-projects"), projectKey: "-workspace", sessionId: testCase.sessionId };
const sdkPath = path.resolve("synthetic-sdk/sdk.mjs"), binding = { bindingId, generation: 1, source };
const request = { bindingId, generation: 1, requestId }, page = { offset: 0, limit: 2 };
const unavailable = code => ({ kind: "source_unavailable", code });
function snapshot() {
  const parsed = parseHistoryBytes(Buffer.from(testCase.records.map(r => JSON.stringify(r)).join("\n") + "\n"), testCase.sessionId);
  return { ...parsed, kind: "source_snapshot", identity: { device: "1", inode: "2", size: parsed.byteLength, mtimeNs: "3", ctimeNs: "4" },
    checks: { owner: "posix_euid_and_mode", reads: 2, matchingBytes: true, unchangedObservedIdentity: true }, sourceAuthenticated: false, publishable: false };
}
async function resultFor(job, captured = snapshot()) {
  return selectHistory(captured, job.history.page, async (sid, o) => {
    await o.sessionStore.load({ projectKey: o.dir.replace(/[^a-zA-Z0-9]/g, "-"), sessionId: sid });
    return fixture.selectedRows(testCase).slice(o.offset, o.offset + o.limit);
  }); // Unit stand-in, not the official selector contract.
}
function harness(options = {}) {
  const children = [], service = createSourceService({ sdkPath, platform: "darwin", cleanupMs: 20, ...options,
    spawnChild(executable, args, settings) {
      if (options.realAfterFirst && children.length) { const c = spawn(executable, args, settings); children.push(c); return c; }
      const c = new EventEmitter(); c.stdin = new PassThrough(); c.stdout = new PassThrough(); c.stderr = new PassThrough();
      c.kill = () => { if (!options.holdClose) c.emit("close", null, "SIGKILL"); return true; };
      const chunks = []; c.stdin.on("data", b => chunks.push(b)); c.job = () => JSON.parse(Buffer.concat(chunks));
      c.reply = (result, close = true) => {
        c.stdout.write(JSON.stringify({ protocolVersion: wire.WIRE_VERSION, nonce: c.job().nonce, request: c.job().request, result }) + "\n");
        if (close) c.emit("close", 0, null);
      }; children.push(c); return c;
    } });
  const bound = service.bind(options.binding || binding);
  return { service, bound, children };
}
async function start(h, captured) {
  const pending = h.bound.observe(request, { page }), c = h.children.at(-1); c.reply(await resultFor(c.job(), captured)); return pending;
}
test("a confirmed first page pins a detached version; continuations preserve it without storing rows", async () => {
  const h = harness(), first = await start(h); assert.match(first.sourceVersion, /^[a-f0-9]{64}$/);
  const original = wire.sourceVersion(first.history.source); first.history.source.identity.inode = "999"; first.history.source.sha256 = "0".repeat(64);
  const options = { page: { offset: 2, limit: 2 }, version: first.sourceVersion }, pending = h.bound.observe(request, options), c = h.children.at(-1);
  options.page.offset = 100; assert.deepEqual(c.job().history.expectedVersion, original); assert.equal(c.job().history.page.offset, 2);
  assert.equal(Object.hasOwn(c.job().history.expectedVersion, "records"), false);
  c.reply(await resultFor(c.job())); const next = await pending;
  assert.equal(next.sourceVersion, first.sourceVersion); assert.equal(next.publishable, false); assert.equal(next.cleanupConfirmed, true);
  assert.deepEqual(next.history.observation.messages.map(m => m.nativeMessageId), testCase.expectedIds.slice(2, 4));
  const repeat = h.bound.observe(request, { page, version: first.sourceVersion }), r = h.children.at(-1); r.reply(await resultFor(r.job()));
  assert.equal((await repeat).sourceVersion, first.sourceVersion); await h.service.shutdown();
});
test("successful explicit refresh retires the old version, but a failed or cancelled refresh cannot replace it", async () => {
  const h = harness(), first = await start(h);
  const failed = h.bound.observe(request, { page }); h.children.at(-1).reply(unavailable("source_missing")); assert.equal((await failed).code, "source_missing");
  const abort = new AbortController(), cancelled = h.bound.observe(request, { page, signal: abort.signal }); abort.abort(); assert.equal((await cancelled).code, "source_aborted");
  const continuation = h.bound.observe(request, { page, version: first.sourceVersion }), c = h.children.at(-1); c.reply(await resultFor(c.job()));
  assert.equal((await continuation).sourceVersion, first.sourceVersion);
  const refreshed = await start(h); assert.notEqual(refreshed.sourceVersion, first.sourceVersion);
  const count = h.children.length; assert.deepEqual(await h.bound.observe(request, { version: first.sourceVersion }), unavailable("source_version_unavailable"));
  assert.equal(h.children.length, count); await h.service.shutdown();
});
test("tokens cannot cross bindings, services or revoked generations and malformed tokens never spawn", async () => {
  const h = harness(), first = await start(h), other = harness();
  const b2 = fixture.uuid(80), bound2 = h.service.bind({ ...binding, bindingId: b2 });
  assert.deepEqual(await bound2.observe({ ...request, bindingId: b2 }, { version: first.sourceVersion }), unavailable("source_version_unavailable"));
  assert.deepEqual(await other.bound.observe(request, { version: first.sourceVersion }), unavailable("source_version_unavailable"));
  for (const version of [null, {}, "", "a".repeat(63), "A".repeat(64), "/private/sdk.mjs"])
    assert.deepEqual(await h.bound.observe(request, { version }), unavailable("invalid_history_version"));
  assert.deepEqual(await h.bound.observe(request, { version: "a".repeat(64) }), unavailable("source_version_unavailable"));
  h.bound.revoke(); const newer = h.service.bind({ ...binding, generation: 2 });
  assert.deepEqual(await newer.observe({ ...request, generation: 2 }, { version: first.sourceVersion }), unavailable("source_version_unavailable"));
  assert.equal(h.children.length, 1); assert.equal(other.children.length, 0); await h.service.shutdown(); await other.service.shutdown();
});
test("parent independently refuses changed content or file identity and permanently invalidates that version", async () => {
  for (const change of [s => { s.sha256 = "b".repeat(64); }, ...["device", "inode", "mtimeNs", "ctimeNs"].map(key => s => { s.identity[key] = "99"; }),
    s => { s.identity.size++; s.byteLength++; }]) {
    const h = harness(), first = await start(h), pending = h.bound.observe(request, { page, version: first.sourceVersion }), c = h.children.at(-1);
    const altered = await resultFor(c.job()); change(altered.source); c.reply(altered);
    assert.deepEqual(await pending, unavailable("source_version_changed"));
    const count = h.children.length;
    assert.deepEqual(await h.bound.observe(request, { page, version: first.sourceVersion }), unavailable("source_version_unavailable"));
    assert.equal(h.children.length, count); assert.notEqual((await start(h)).sourceVersion, first.sourceVersion); await h.service.shutdown();
  }
});
test("reported version change and oversized continuation return no page; only change invalidates token", async () => {
  const h = harness(), first = await start(h);
  const tooLarge = h.bound.observe(request, { version: first.sourceVersion }); h.children.at(-1).reply(unavailable("source_observation_too_large"));
  assert.deepEqual(await tooLarge, unavailable("source_observation_too_large"));
  const small = h.bound.observe(request, { page: { offset: 0, limit: 1 }, version: first.sourceVersion }), c = h.children.at(-1); c.reply(await resultFor(c.job()));
  assert.equal((await small).sourceVersion, first.sourceVersion);
  const changed = h.bound.observe(request, { page, version: first.sourceVersion }); h.children.at(-1).reply(unavailable("source_version_changed"));
  assert.deepEqual(await changed, unavailable("source_version_changed"));
  assert.deepEqual(await h.bound.observe(request, { version: first.sourceVersion }), unavailable("source_version_unavailable")); await h.service.shutdown();
});
test("version fingerprints reject extra keys, non-integer size, bad digests and unknown identity fields", () => {
  const v = wire.sourceVersion(snapshot()), job = { protocolVersion: 1, nonce: "a".repeat(64), request, source, history: { sdkPath, page, expectedVersion: v } };
  assert.equal(wire.validJob(job), true); assert.equal(wire.sameSourceVersion(v, snapshot()), true);
  for (const mutate of [v => { v.records = []; }, v => { v.sha256 = "x"; }, v => { v.identity.size = 0; },
    v => { v.identity.size = 1.5; }, v => { v.identity.inode = "0"; }, v => { v.identity.path = "/private"; }, v => { v.identity.mtimeNs = -1; }]) {
    const bad = structuredClone(job); mutate(bad.history.expectedVersion); assert.equal(wire.validJob(bad), false);
  }
});
test("unconfirmed cleanup cannot issue a version or accept a late successful refresh", async () => {
  const h = harness({ holdClose: true }), first = await start(h), abort = new AbortController();
  const pending = h.bound.observe(request, { page, signal: abort.signal }), c = h.children.at(-1); c.reply(await resultFor(c.job()), false); abort.abort();
  assert.deepEqual(await pending, unavailable("source_cleanup_unconfirmed")); c.emit("close", 0, null);
  assert.equal(h.service.status().quarantined, true);
  assert.deepEqual(await h.bound.observe(request, { version: first.sourceVersion }), unavailable("source_service_quarantined")); await h.service.shutdown();
});
test("real worker rejects appended, edited, truncated and replaced fixture versions before loading an unavailable SDK", { skip: !["darwin", "linux"].includes(process.platform) }, async t => {
  const home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "stepsemble-history-version-")));
  t.after(() => fs.rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));
  const projectsRoot = path.join(home, "projects"), project = path.join(projectsRoot, "-workspace"); await fs.mkdir(project, { recursive: true, mode: 0o700 });
  const filename = path.join(project, `${testCase.sessionId}.jsonl`), bytes = testCase.records.map(r => JSON.stringify(r)).join("\n") + "\n";
  for (const kind of ["append", "edit", "truncate", "replace"]) {
    await fs.writeFile(filename, bytes, { mode: 0o600 }); const captured = await createSourceReader()({ ...source, projectsRoot });
    assert.equal(captured.kind, "source_snapshot");
    const h = harness({ realAfterFirst: true, binding: { ...binding, source: { ...source, projectsRoot } }, sdkPath: path.join(home, "missing-sdk", "sdk.mjs") });
    try {
      const first = await start(h, captured);
      if (kind === "append") await fs.appendFile(filename, JSON.stringify({ type: "custom-title", sessionId: testCase.sessionId, customTitle: "Synthetic update" }) + "\n");
      if (kind === "edit") await fs.writeFile(filename, bytes.replace("Synthetic recorded thinking", "Different recorded thinking"));
      if (kind === "truncate") await fs.writeFile(filename, JSON.stringify(testCase.records[0]) + "\n");
      if (kind === "replace") { const replacement = path.join(project, "owned-replacement.jsonl"); await fs.writeFile(replacement, bytes, { mode: 0o600 }); await fs.rename(replacement, filename); }
      const changedBytes = await fs.readFile(filename);
      assert.deepEqual(await h.bound.observe(request, { page, version: first.sourceVersion }), unavailable("source_version_changed"));
      assert.deepEqual(await fs.readFile(filename), changedBytes); assert.equal(h.service.status().activeWorkers, 0);
      assert.deepEqual(await h.bound.observe(request, { version: first.sourceVersion }), unavailable("source_version_unavailable"));
    } finally { assert.equal((await h.service.shutdown()).cleanupConfirmed, true); }
  }
});
