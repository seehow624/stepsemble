"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs/promises");
const path = require("node:path"), os = require("node:os"), { EventEmitter } = require("node:events"), { PassThrough } = require("node:stream");
const { spawn } = require("node:child_process");
const fixture = require("../protocol/native/claude/history-fixture.cjs");
const { selectHistory } = require("../protocol/native/claude/history-selection");
const { observeHistory } = require("../protocol/native/claude/history-observation");
const { parseHistoryBytes } = require("../protocol/native/claude/history-source");
const { createSourceService } = require("../protocol/native/claude/history-source-service");
const wire = require("../protocol/native/claude/history-worker-wire");
const { validSdkPath } = require("../protocol/native/claude/history-sdk");
const sdkPath = path.resolve("synthetic-sdk/sdk.mjs"), bindingId = fixture.uuid(70), requestId = fixture.uuid(71);
const request = { bindingId, generation: 1, requestId };
const source = { projectsRoot: path.resolve("synthetic-projects"), projectKey: "-workspace", sessionId: fixture.sessionId };
const page = { offset: 0, limit: 100 };
const unavailable = code => ({ kind: "source_unavailable", code });
function snapshot(c) {
  const parsed = parseHistoryBytes(Buffer.from(c.records.map(r => JSON.stringify(r)).join("\n") + "\n"), c.sessionId);
  return { ...parsed, kind: "source_snapshot", identity: { device: "1", inode: "2", size: parsed.byteLength, mtimeNs: "3", ctimeNs: "4" },
    checks: { owner: "posix_euid_and_mode", reads: 2, matchingBytes: true, unchangedObservedIdentity: true }, sourceAuthenticated: false, publishable: false };
}
const keyFor = (sid, options) => ({ projectKey: options.dir.replace(/[^a-zA-Z0-9]/g, "-"), sessionId: sid });
const standIn = c => async (sid, options) => {
  await options.sessionStore.load(keyFor(sid, options));
  return fixture.selectedRows(c).slice(options.offset, options.offset + options.limit);
}; // Ordinary offline unit fixture, NOT the SDK's branch algorithm.
function harness() {
  const children = [], service = createSourceService({ sdkPath, platform: "darwin", cleanupMs: 50, spawnChild() {
    const c = new EventEmitter(); c.stdin = new PassThrough(); c.stdout = new PassThrough(); c.stderr = new PassThrough();
    c.kill = () => { c.emit("close", null, "SIGKILL"); return true; };
    const input = []; c.stdin.on("data", b => input.push(b)); c.job = () => JSON.parse(Buffer.concat(input)); children.push(c); return c;
  } });
  const bound = service.bind({ bindingId, generation: 1, source }); return { children, service, bound };
}
test("snapshot store maps rich/compacted/ancillary pages without giving SDK mutable native rows", async () => {
  for (const c of fixture.richCases("/synthetic/workspace")) {
    const s = snapshot(c), before = JSON.stringify(s), expected = observeHistory({ sessionId: c.sessionId, nativeRecords: c.records, messages: fixture.selectedRows(c) });
    const result = await selectHistory(s, page, async (sid, options) => {
      const records = await options.sessionStore.load(keyFor(sid, options));
      const rows = fixture.selectedRows(c); records[0].parentUuid = fixture.uuid(999); return rows;
    });
    assert.deepEqual(result.observation, expected); assert.equal(JSON.stringify(s), before);
    assert.equal(Object.hasOwn(result.source, "records"), false); assert.equal(result.source.sha256, s.sha256);
    assert.equal(result.source.recordCount, c.records.length); assert.ok(result.metrics.maxRssKiB > 0);
    const partial = await selectHistory(s, { offset: 1, limit: 2 }, standIn(c));
    assert.deepEqual(partial.observation.messages.map(m => m.nativeMessageId), c.expectedIds.slice(1, 3));
    assert.equal(partial.observation.sourceDigest, expected.sourceDigest);
    const empty = await selectHistory(s, { offset: 2000, limit: 1 }, standIn(c));
    assert.deepEqual(empty.observation.messages, []); assert.ok(empty.observation.warnings.includes("empty_readback_unverified"));
  }
});
test("snapshot store rejects foreign/subagent keys, repeated loads and writes even if SDK suppresses errors", async () => {
  const c = fixture.richCases("/synthetic")[0], s = snapshot(c);
  for (const change of [key => ({ ...key, sessionId: fixture.otherSessionId }), key => ({ ...key, projectKey: "other" }),
    key => ({ ...key, subpath: "subagents/agent-other" })]) {
    await assert.rejects(selectHistory(s, page, async (sid, o) => {
      try { await o.sessionStore.load(change(keyFor(sid, o))); } catch {} return fixture.selectedRows(c);
    }), /snapshot_store_scope/);
  }
  for (const operation of [async (store, key) => store.load(key), async (store, key) => store.append(key, [])]) {
    await assert.rejects(selectHistory(s, page, async (sid, o) => {
      await o.sessionStore.load(keyFor(sid, o)); try { await operation(o.sessionStore, keyFor(sid, o)); } catch {}
      return fixture.selectedRows(c);
    }), /snapshot_store_scope/);
  }
  await assert.rejects(selectHistory(s, page, async () => []), /snapshot_store_scope/);
  await assert.rejects(selectHistory(s, { offset: 0, limit: 1 }, async (sid, o) => {
    await o.sessionStore.load(keyFor(sid, o)); return fixture.selectedRows(c);
  }), /snapshot_store_scope/);
});
test("SDK clone and returned observation do not alias nested native content", async () => {
  const c = fixture.richCases("/synthetic")[0], s = snapshot(c), before = JSON.stringify(s);
  let selected;
  const result = await selectHistory(s, page, async (sid, options) => {
    const rows = await options.sessionStore.load(keyFor(sid, options));
    rows[1].message.content[2].input.file_path = "SDK-mutated";
    rows[0].message.content[1].source.data = "SDK-mutated";
    selected = fixture.selectedRows(c); return selected;
  });
  assert.equal(JSON.stringify(s), before);
  const observationBefore = JSON.stringify(result.observation);
  selected[1].message.content[2].input.file_path = "later-SDK-mutation";
  assert.equal(JSON.stringify(result.observation), observationBefore);
  result.observation.messages[0].blocks[0].text = "view-mutated";
  assert.equal(JSON.stringify(s), before);
});
test("observation options/page bounds cannot add path, SDK, environment or invoke getters", async () => {
  const h = harness(); let invoked = false;
  const accessor = {}; Object.defineProperty(accessor, "page", { enumerable: true, get() { invoked = true; } });
  const inherited = Object.create({ get page() { invoked = true; return page; } });
  for (const bad of [accessor, inherited, { [Symbol("scope")]: true }, { sdkPath }, { env: {} }, null, []])
    assert.deepEqual(await h.bound.observe(request, bad), unavailable("invalid_history_options"));
  for (const p of [{ offset: -1, limit: 1 }, { offset: 2001, limit: 1 }, { offset: 0, limit: 0 }, { offset: 0, limit: 101 },
    { offset: 1.5, limit: 2 }, { ...page, sessionId: fixture.otherSessionId }])
    assert.deepEqual(await h.bound.observe(request, { page: p }), unavailable("invalid_history_page"));
  assert.equal(invoked, false); assert.equal(h.children.length, 0);
  const disabled = createSourceService(); assert.deepEqual(await disabled.bind({ bindingId, generation: 1, source }).observe(request), unavailable("source_sdk_unavailable"));
  for (const bad of ["relative/sdk.mjs", path.resolve("wild*/sdk.mjs"), path.resolve("other.mjs"), sdkPath + "\0"])
    assert.throws(() => createSourceService({ sdkPath: bad }), /invalid_history_sdk_path/);
  assert.equal(validSdkPath(sdkPath), true); await h.service.shutdown(); await disabled.shutdown();
});
test("observe and capture share busy/abort/revoke limits and snapshot capture cannot select SDK mode", async () => {
  const h = harness(), abort = new AbortController(), p = h.bound.observe(request, { signal: abort.signal });
  assert.deepEqual(h.children[0].job().history, { sdkPath, page, expectedVersion: null });
  assert.deepEqual(await h.bound.capture(request), unavailable("source_busy"));
  abort.abort(); assert.deepEqual(await p, unavailable("source_aborted"));
  const capture = h.bound.capture(request, {}, page); assert.equal(h.children[1].job().history, undefined);
  h.bound.revoke(); assert.deepEqual(await capture, unavailable("source_binding_revoked")); await h.service.shutdown();
});
test("bounded observation wire refuses scope/page/reader/authority/shape changes and never accepts raw snapshots", async () => {
  for (const c of fixture.richCases("/synthetic")) {
    const result = await selectHistory(snapshot(c), page, standIn(c));
    const job = { protocolVersion: 1, nonce: "a".repeat(64), request, source: { ...source, sessionId: c.sessionId }, history: { sdkPath, page } };
    const encode = r => Buffer.from(JSON.stringify({ protocolVersion: 1, nonce: job.nonce, request, result: r }) + "\n");
    assert.equal(wire.validJob(job), true); assert.deepEqual(wire.readResponse(encode(result), job), result);
    for (const mutate of [r => { r.observation.publishable = true; }, r => { r.observation.authority.resumeAllowed = true; },
      r => { r.observation.sessionId = fixture.otherSessionId; }, r => { r.source.sourceAuthenticated = true; },
      r => { r.source.records = []; }, r => { r.source.recordCount = 0; }, r => { r.page.offset++; },
      r => { r.reader.sdkSha256 = "b".repeat(64); }, r => { r.metrics.extra = "/private/path"; },
      r => { r.observation.messages[0].blocks[0].url = "https://example.invalid/never-fetch"; },
      r => { r.observation.messages[0].nativeMessageId = "bad"; }, r => { r.observation.warnings.push("private path"); }]) {
      const altered = structuredClone(result); mutate(altered); assert.equal(wire.readResponse(encode(altered), job), null);
    }
    assert.equal(wire.readResponse(encode(snapshot(c)), job), null);
    assert.equal(wire.readResponse(encode(result), { ...job, history: undefined }), null);
  }
});
test("observation output byte cap stops owned worker without accepting a partial page", async () => {
  const h = harness(), p = h.bound.observe(request);
  h.children[0].stdout.write(Buffer.alloc(wire.LIMITS.pageBytes + 1));
  assert.deepEqual(await p, unavailable("source_worker_output_limit")); assert.equal(h.service.status().activeWorkers, 0); await h.service.shutdown();
});
test("modified SDK bytes are rejected before module execution by the real source worker", { skip: process.platform === "win32" }, async t => {
  const home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "stepsemble-sdk-drift-")));
  t.after(() => fs.rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));
  const projectsRoot = path.join(home, "projects"), project = path.join(projectsRoot, "-workspace"); await fs.mkdir(project, { recursive: true, mode: 0o700 });
  const filename = path.join(project, `${fixture.sessionId}.jsonl`), bytes = fixture.fixture("/synthetic").map(r => JSON.stringify(r)).join("\n") + "\n";
  await fs.writeFile(filename, bytes, { mode: 0o600 });
  const badSdk = path.join(home, "sdk.mjs"); await fs.writeFile(badSdk, "process.stdout.write('MUST_NOT_EXECUTE'); export function getSessionMessages() {}\n");
  const service = createSourceService({ sdkPath: badSdk }); t.after(() => service.shutdown());
  const result = await service.bind({ bindingId, generation: 1, source: { ...source, projectsRoot } }).observe(request);
  assert.deepEqual(result, unavailable("source_sdk_unavailable")); assert.equal(await fs.readFile(filename, "utf8"), bytes);
});
test("cancellation also terminates an actively CPU-blocked observation worker without running SDK/model", async t => {
  const abort = new AbortController(); let child;
  const service = createSourceService({ sdkPath, platform: "darwin", spawnChild(executable, args, options) {
    child = spawn(executable, [...args.slice(0, -1), "-e", "process.stdin.resume();process.stdout.write('ready');while(true){}"], options);
    child.stdout.once("data", () => abort.abort()); return child;
  } }); t.after(() => service.shutdown());
  assert.deepEqual(await service.bind({ bindingId, generation: 1, source }).observe(request, { signal: abort.signal }), unavailable("source_aborted"));
  assert.ok(child.exitCode !== null || child.signalCode !== null); assert.equal(service.status().activeWorkers, 0);
});
