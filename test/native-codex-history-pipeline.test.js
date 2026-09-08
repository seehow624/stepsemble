"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), path = require("node:path");
const { EventEmitter } = require("node:events"), { PassThrough } = require("node:stream");
const { createCodexHistoryPipeline } = require("../protocol/native/codex/history-pipeline");
const { createReaderAdmission } = require("../protocol/native/claude/history-reader-admission");
const wire = require("../protocol/native/codex/parser-wire"), { processJob } = require("../protocol/native/codex/parser-worker");
const fixture = require("../protocol/native/codex/parser-fixture.cjs");
const tick = () => new Promise(resolve => setImmediate(resolve));
const unavailable = code => ({ kind: "source_unavailable", code });
function harness(t, config = {}) {
  const admission = config.admission ?? createReaderAdmission(), helpers = [], children = [], launches = [];
  let physical = 0, maxPhysical = 0;
  const allocate = () => { physical++; maxPhysical = Math.max(physical, maxPhysical); }, release = () => { physical--; assert(physical >= 0); };
  const pipeline = createCodexHistoryPipeline({ helperPath: path.resolve("owned-codex-helper"), admission, platform: "linux", deadlineMs: config.deadlineMs ?? 1000,
    cleanupMs: 20, createHelper(options) {
      const h = { options, active: false, calls: [], closed: false };
      h.status = () => ({ closed: h.closed, activeWorker: h.active, cleanupConfirmed: !h.active, quarantined: false });
      h.close = () => { if (h.active) { h.active = false; release(); } };
      h.readCodex = (input, { signal }) => {
        assert.equal(h.active, false); h.active = true; allocate(); h.calls.push(input);
        const promise = new Promise(resolve => { h.finish = (result = fixture.captured(), close = true) => { if (close) h.close(); resolve(result); }; });
        signal.addEventListener("abort", () => { if (!config.holdReader) h.finish(unavailable("source_aborted")); }, { once: true });
        config.onRead?.(h); return promise;
      };
      h.shutdown = async () => { h.closed = true; return { cleanupConfirmed: !h.active, quarantined: false }; };
      helpers.push(h); return h;
    }, spawnChild(executable, args, options) {
      allocate(); launches.push({ executable, args, options });
      const c = new EventEmitter(), chunks = []; c.active = true; c.stdin = new PassThrough(); c.stdout = new PassThrough(); c.stderr = new PassThrough(); c.kills = 0;
      c.stdin.on("data", b => chunks.push(b)); c.input = () => wire.readJob(Buffer.concat(chunks));
      c.close = (code = 0, signal = null) => { if (c.active) { c.active = false; release(); } c.emit("close", code, signal); };
      c.kill = () => { c.kills++; if (!config.holdParser) c.close(null, "SIGKILL"); return true; };
      c.response = () => { const { job, bytes } = c.input(); return { protocolVersion: 1, nonce: job.nonce, result: processJob(job, bytes) }; };
      c.reply = (close = true) => { c.stdout.write(JSON.stringify(c.response()) + "\n"); if (close) c.close(); };
      children.push(c); config.onSpawn?.(c); return c;
    } });
  t.after(async () => { for (const h of helpers) { h.finish?.(unavailable("source_aborted")); h.close(); } for (const c of children) c.close(); await pipeline.shutdown(); });
  return { pipeline, helpers, children, launches, admission, physical: () => physical, maxPhysical: () => maxPhysical };
}
async function nextParser(h, capture = fixture.captured()) {
  h.helpers.find(v => v.active).finish(capture); await tick(); return h.children.at(-1);
}
async function complete(h, options = {}) {
  const promise = h.pipeline.read(fixture.request(), options); (await nextParser(h)).reply(); return promise;
}
test("one permit spans Rust capture and parser actual-close; stdout or exit alone cannot publish", async t => {
  const h = harness(t), request = fixture.request(), pending = h.pipeline.read(request);
  request.source.codexRoot = path.resolve("mutated"); assert.equal(h.helpers[0].calls[0].source.codexRoot, fixture.root);
  const child = await nextParser(h); assert.equal(h.admission.status().activeWorkers, 1); assert.equal(h.physical(), 1);
  child.reply(false); child.emit("exit", 0); let done = false; pending.then(() => { done = true; }); await tick(); assert.equal(done, false);
  child.close(); const result = await pending;
  assert.equal(result.kind, "codex_parsed_capture"); assert.equal(result.cleanupConfirmed, true); assert.equal(result.index.nativeTitleResolved, false);
  assert.equal(h.admission.status().cleanupConfirmed, true); assert.equal(h.maxPhysical(), 1);
});
test("two pipelines share the caller's Host budget; third read is busy before capture with no hidden queue", async t => {
  const admission = createReaderAdmission(), a = harness(t, { admission }), b = harness(t, { admission });
  const first = a.pipeline.read(fixture.request()), second = b.pipeline.read(fixture.request(), { selection: { mode: "names" } });
  assert.equal((await b.pipeline.read(fixture.request())).code, "source_busy"); assert.equal(b.helpers.flatMap(v => v.calls).length, 1);
  const ca = await nextParser(a); assert.equal(admission.status().activeWorkers, 2);
  assert.equal((await a.pipeline.read(fixture.request())).code, "source_busy");
  const cb = await nextParser(b); ca.reply(); cb.reply(); assert.equal((await first).kind, "codex_parsed_capture"); assert.equal((await second).page, null);
  assert.equal(admission.status().activeWorkers, 0); assert.equal(a.physical() + b.physical(), 0);
});
test("exact source version fences both name and rollout revisions before parser spawn", async t => {
  const h = harness(t), first = await complete(h), expected = first.source;
  const next = await complete(h, { expectedVersion: expected, selection: { mode: "records", offset: 2, limit: 2 } });
  assert.equal(next.page.offset, 2);
  for (const change of [v => { v.nameIndex.identity.inode = "9"; }, v => { v.rollout.identity.mtimeNs = "3"; }]) {
    const before = h.children.length, pending = h.pipeline.read(fixture.request(), { expectedVersion: expected }), capture = fixture.captured(); change(capture);
    h.helpers.find(v => v.active).finish(capture); assert.equal((await pending).code, "source_version_changed"); assert.equal(h.children.length, before);
  }
});
test("cancel during capture or parsing waits for actual cleanup and never replays the request", async t => {
  for (const parser of [false, true]) {
    const h = harness(t), controller = new AbortController(), pending = h.pipeline.read(fixture.request(), { signal: controller.signal });
    if (parser) await nextParser(h); controller.abort(); assert.equal((await pending).code, "source_aborted");
    assert.equal(h.pipeline.status().cleanupConfirmed, true); assert.equal(h.admission.status().quarantined, false);
    assert.equal(h.helpers.flatMap(v => v.calls).length, 1); assert.equal(h.children.length, parser ? 1 : 0);
  }
});
test("unknown parser cleanup quarantines every consumer, retains occupancy and cannot be bypassed by a new pipeline", async t => {
  const admission = createReaderAdmission(), h = harness(t, { admission, holdParser: true }), other = harness(t, { admission }), controller = new AbortController();
  const pending = h.pipeline.read(fixture.request(), { signal: controller.signal }), sibling = other.pipeline.read(fixture.request());
  const child = await nextParser(h); controller.abort(); assert.equal((await pending).code, "source_cleanup_unconfirmed");
  assert.equal((await sibling).code, "source_service_quarantined"); assert.equal(child.kills, 1);
  assert.equal(admission.status().quarantined, true); assert.equal(admission.status().activeWorkers, 1);
  const replacement = harness(t, { admission }); assert.equal((await replacement.pipeline.read(fixture.request())).code, "source_service_quarantined");
  assert.equal(replacement.helpers.flatMap(v => v.calls).length, 0);
  child.close(null, "SIGKILL"); assert.equal(admission.status().activeWorkers, 0); assert.equal(admission.status().quarantined, true);
});
test("a capture result without actual helper close is never parsed or released as success", async t => {
  const h = harness(t, { holdReader: true }), pending = h.pipeline.read(fixture.request());
  h.helpers[0].finish(fixture.captured(), false); assert.equal((await pending).code, "source_cleanup_unconfirmed"); assert.equal(h.children.length, 0);
  assert.equal(h.admission.status().activeWorkers, 1); assert.equal(h.admission.status().quarantined, true);
  h.helpers[0].close(); assert.equal(h.admission.status().activeWorkers, 0); assert.equal((await h.pipeline.read(fixture.request())).code, "source_service_quarantined");
});
test("malformed output, stderr and excess bytes are sanitized with cleanup before another operation", async t => {
  for (const [act, code] of [
    [c => { const v = c.response(); v.nonce = "b".repeat(64); c.stdout.write(JSON.stringify(v) + "\n"); c.close(); }, "source_worker_protocol"],
    [c => c.stderr.write("private path and token must not escape"), "source_worker_diagnostic"],
    [c => c.stdout.write(Buffer.alloc(wire.LIMITS.outputBytes + 1)), "source_worker_output_limit"],
    [c => { c.reply(false); c.reply(false); c.close(); }, "source_worker_protocol"],
    [c => c.close(7), "source_worker_exit"],
    [c => c.stdout.emit("error", Error("private diagnostic")), "source_worker_io_error"],
  ]) {
    const h = harness(t), pending = h.pipeline.read(fixture.request()), child = await nextParser(h); act(child);
    assert.deepEqual(await pending, unavailable(code)); assert.equal(h.admission.status().cleanupConfirmed, true); assert.equal(h.admission.status().quarantined, false);
    assert.equal((await complete(h)).kind, "codex_parsed_capture");
  }
});
test("shutdown and shared Host close cancel occupied work but closing one consumer leaves the other usable", async t => {
  const admission = createReaderAdmission(), a = harness(t, { admission }), b = harness(t, { admission });
  const first = a.pipeline.read(fixture.request()), second = b.pipeline.read(fixture.request());
  await nextParser(a); const closing = a.pipeline.shutdown(); assert.equal((await first).code, "source_service_closed");
  assert.equal((await closing).cleanupConfirmed, true); assert.equal(admission.status().closed, false); assert.equal(b.helpers[0].active, true);
  (await nextParser(b)).reply(); assert.equal((await second).kind, "codex_parsed_capture");
  const third = b.pipeline.read(fixture.request()); admission.close(); assert.equal((await third).code, "source_service_closed");
  assert.equal((await b.pipeline.read(fixture.request())).code, "source_service_closed"); assert.equal(admission.status().cleanupConfirmed, true);
});
test("late successful output after cancellation has no publication rights and times out conservatively", async t => {
  const h = harness(t, { holdParser: true }), controller = new AbortController(), pending = h.pipeline.read(fixture.request(), { signal: controller.signal });
  const child = await nextParser(h); controller.abort(); child.reply(); assert.equal((await pending).code, "source_aborted");
  assert.equal(h.admission.status().quarantined, false);
  const slow = harness(t, { deadlineMs: 30 }), timeout = slow.pipeline.read(fixture.request());
  assert.equal((await timeout).code, "source_worker_timeout"); assert.equal(slow.children.length, 0); assert.equal(slow.admission.status().cleanupConfirmed, true);
});
test("invalid private DTOs, extra options, pre-abort and unsupported platform refuse before any capture", async t => {
  const h = harness(t); let called = 0;
  const getter = fixture.request(); Object.defineProperty(getter.source, "codexRoot", { enumerable: true, get() { called++; return fixture.root; } });
  for (const input of [null, {}, getter, { ...fixture.request(), env: {} }, { ...fixture.request(), nativeVersion: "latest" }]) assert.equal((await h.pipeline.read(input)).code, "invalid_codex_pipeline_request");
  for (const options of [{ selection: { mode: "names", limit: 1 } }, { expectedVersion: {} }, { env: {} }, { get selection() { called++; return { mode: "names" }; } }])
    assert.equal((await h.pipeline.read(fixture.request(), options)).code, "invalid_codex_pipeline_request");
  const controller = new AbortController(); controller.abort(); assert.equal((await h.pipeline.read(fixture.request(), { signal: controller.signal })).code, "source_aborted");
  assert.equal(called, 0); assert.equal(h.helpers.flatMap(v => v.calls).length, 0);
  const unsupported = createCodexHistoryPipeline({ helperPath: process.execPath, admission: createReaderAdmission(), platform: "win32" });
  assert.equal((await unsupported.read(fixture.request())).code, "source_platform_unsupported"); assert.equal((await unsupported.shutdown()).cleanupConfirmed, true);
});
test("reentrant cancellation during spawn and the parser deadline kill only the exact child and await close", async t => {
  const controller = new AbortController(), h = harness(t, { onSpawn: () => controller.abort() });
  const pending = h.pipeline.read(fixture.request(), { signal: controller.signal });
  const child = await nextParser(h);
  assert.equal((await pending).code, "source_aborted"); assert.equal(child.kills, 1);
  assert.equal(h.admission.status().cleanupConfirmed, true); assert.equal(h.admission.status().quarantined, false);
  const slow = harness(t, { deadlineMs: 50 }), timed = slow.pipeline.read(fixture.request());
  const parser = await nextParser(slow);
  assert.equal((await timed).code, "source_worker_timeout"); assert.equal(parser.kills, 1);
  assert.equal(slow.admission.status().cleanupConfirmed, true); assert.equal(slow.admission.status().quarantined, false);
});
test("capture identity and diagnostics are fenced before parsing; an explicit unknown cleanup quarantines the shared budget", async t => {
  for (const change of [v => { v.rootIdentity.inode = "99"; }, v => { v.threadId = "00000000-0000-4000-8000-000000000000"; },
    v => { v.cleanupConfirmed = false; }]) {
    const h = harness(t), pending = h.pipeline.read(fixture.request()), capture = fixture.captured(); change(capture); h.helpers[0].finish(capture);
    assert.equal((await pending).code, "source_worker_protocol"); assert.equal(h.children.length, 0); assert.equal(h.admission.status().cleanupConfirmed, true);
  }
  for (const [code, expected, quarantined] of [["private path/token", "source_worker_failure", false], ["source_cleanup_unconfirmed", "source_cleanup_unconfirmed", true]]) {
    const h = harness(t), pending = h.pipeline.read(fixture.request()); h.helpers[0].finish(unavailable(code));
    assert.deepEqual(await pending, unavailable(expected)); assert.equal(h.children.length, 0); assert.equal(h.admission.status().quarantined, quarantined);
  }
});
test("real shared admission is required; arbitrary launch options and unsupported lifecycle factories are rejected", () => {
  const admission = createReaderAdmission(), options = { helperPath: process.execPath, admission };
  for (const bad of [{ ...options, admission: undefined }, { ...options, admission: { ...admission } }, { ...options, helperPath: "/" }, { ...options, env: {} },
    { ...options, deadlineMs: 10001 }, { ...options, cleanupMs: 1001 }, { ...options, createHelper: () => ({}) }])
    assert.throws(() => createCodexHistoryPipeline(bad), /invalid_codex_pipeline/);
});
