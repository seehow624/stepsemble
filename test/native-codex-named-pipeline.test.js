"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), { EventEmitter } = require("node:events"), { PassThrough } = require("node:stream");
const { createCodexHistoryPipeline } = require("../protocol/native/codex/history-pipeline");
const { createReaderAdmission } = require("../protocol/native/claude/history-reader-admission");
const wire = require("../protocol/native/codex/parser-wire"), { processJob } = require("../protocol/native/codex/parser-worker");
const f = require("../protocol/native/codex/parser-fixture.cjs");
const tick = () => new Promise(resolve => setImmediate(resolve)), unavailable = code => ({ kind: "source_unavailable", code });
function harness(t, config = {}) {
  const admission = config.admission ?? createReaderAdmission(), helpers = [], children = [], stages = [];
  let physical = 0, max = 0;
  const add = () => { physical++; max = Math.max(max, physical); }, drop = () => { physical--; assert(physical >= 0); };
  const pipeline = createCodexHistoryPipeline({ helperPath: process.execPath, admission, platform: config.platform ?? "linux",
    deadlineMs: config.deadlineMs ?? 1000, cleanupMs: 20,
    createHelper() {
      const h = { active: false, calls: [] };
      h.status = () => ({ activeWorker: h.active, cleanupConfirmed: !h.active, quarantined: false });
      h.close = () => { if (h.active) { h.active = false; drop(); } };
      for (const method of ["readCodex", "readCodexNameContext"]) h[method] = (input, { signal }) => {
        assert.equal(h.active, false); add(); h.active = true; h.calls.push({ method, input }); stages.push(method);
        const promise = new Promise(resolve => { h.finish = (result = method === "readCodex" ? f.captured() : f.sqliteCapture(), close = true) => { if (close) h.close(); resolve(result); }; });
        signal.addEventListener("abort", () => { if (!config.holdReader) h.finish(unavailable("source_aborted")); }, { once: true });
        return promise;
      };
      h.shutdown = async () => ({ cleanupConfirmed: !h.active }); helpers.push(h); return h;
    }, spawnChild() {
      add(); stages.push("parser"); const c = new EventEmitter(), input = [];
      c.stdin = new PassThrough(); c.stdout = new PassThrough(); c.stderr = new PassThrough(); c.active = true; c.kills = 0;
      c.stdin.on("data", b => input.push(b)); c.input = () => wire.readJob(Buffer.concat(input));
      c.close = (code = 0, signal = null) => { if (!c.active) return; c.active = false; drop(); c.emit("close", code, signal); };
      c.kill = () => { c.kills++; if (!config.holdParser) c.close(null, "SIGKILL"); return true; };
      c.reply = (close = true) => { const { job, bytes } = c.input(); c.stdout.write(wire.encodeResponse(processJob(job, bytes), job)); if (close) c.close(); };
      children.push(c); return c;
    } });
  const activeHelper = () => helpers.find(h => h.active), activeChild = () => children.find(c => c.active);
  async function step(result, close = true) {
    if (activeHelper()) activeHelper().finish(result, close); else { assert(activeChild()); activeChild().reply(close); }
    await tick();
  }
  t.after(async () => { for (const h of helpers) { h.finish?.(unavailable("source_aborted")); h.close(); } for (const c of children) c.close(); await pipeline.shutdown(); });
  return { pipeline, helpers, children, stages, admission, activeHelper, activeChild, step, physical: () => physical, max: () => max };
}
async function complete(h, options = {}, input = f.namedRequest()) {
  const promise = h.pipeline.readNamed(input, options); for (let i = 0; i < 5; i++) await h.step(); return promise;
}
test("one permit spans SQL A, bytes A, parser close, SQL B and bytes B; no early success or name authority", async t => {
  const h = harness(t), input = f.namedRequest(), pending = h.pipeline.readNamed(input); let done = false; pending.then(() => { done = true; });
  input.method = "changed"; input.sqlite.source.threadId = "changed";
  for (let i = 0; i < 5; i++) {
    assert.equal(h.physical(), 1); assert.equal(h.admission.status().activeWorkers, 1); assert.equal(done, false);
    if (i === 2) { await h.step(undefined, false); h.activeChild().emit("exit", 0); await tick(); assert.equal(done, false); h.activeChild().close(); await tick(); }
    else await h.step();
  }
  const result = await pending;
  assert.equal(result.kind, "codex_named_capture"); assert.equal(result.name.name, "原生候選 🐾"); assert.equal(result.name.method, "thread_read_sqlite");
  assert.equal(result.name.nativeTitleResolved, false); assert.equal(result.sourceAuthenticated, false); assert.equal(result.publishable, false);
  assert.equal(result.cleanupConfirmed, true); assert.equal(result.consistency, "matching_selected_versions_before_and_after_parse");
  assert(wire.sameNamedVersion(result.source, result.source)); assert.equal(h.max(), 1); assert.equal(h.physical(), 0);
  assert.deepEqual(h.stages, ["readCodexNameContext", "readCodex", "parser", "readCodexNameContext", "readCodex"]);
  assert.equal(h.admission.status().cleanupConfirmed, true);
});
test("named and old flows use the same two Host slots at every stage without a queue or a nested reservation", async t => {
  const admission = createReaderAdmission(), a = harness(t, { admission }), b = harness(t, { admission });
  const one = a.pipeline.readNamed(f.namedRequest()), two = b.pipeline.read(f.request());
  for (let i = 0; i < 5; i++) {
    assert.equal(admission.status().activeWorkers, 2);
    assert.equal((await a.pipeline.readNamed(f.namedRequest())).code, "source_busy"); assert.equal((await b.pipeline.read(f.request())).code, "source_busy");
    assert.equal(a.physical() + b.physical(), 2); await a.step();
  }
  assert.equal((await one).kind, "codex_named_capture"); await b.step(); await b.step(); assert.equal((await two).kind, "codex_parsed_capture");
  assert.equal(a.stages.length, 5); assert.equal(b.stages.length, 2); assert.equal(admission.status().cleanupConfirmed, true);
});
test("both final versions are fenced: SQL rename/path/preview and index/rollout revisions reject late results", async t => {
  for (const [stage, make] of [
    [3, () => f.sqliteCapture(o => { o.fields.title = "renamed"; })], [3, () => f.sqliteCapture(o => { o.nameContext.preview = "new"; })],
    [3, () => f.sqliteCapture(o => { o.nameContext.rolloutPath += ".moved"; })],
    [4, () => f.captured(Buffer.from(JSON.stringify({ id: f.id, thread_name: "renamed", updated_at: "x" }) + "\n"))],
    [4, () => { const c = f.captured(); c.rollout.identity.inode = "99"; return c; }],
    [4, () => { const c = f.captured(); c.nameIndex.identity.ctimeNs = "999"; return c; }], [4, () => f.captured(null)],
  ]) {
    const h = harness(t), promise = h.pipeline.readNamed(f.namedRequest());
    for (let i = 0; i < stage; i++) await h.step(); await h.step(make());
    assert.deepEqual(await promise, unavailable("source_version_changed")); assert.equal(h.stages.length, stage + 1);
    assert.equal(h.admission.status().cleanupConfirmed, true); assert.equal(h.admission.status().quarantined, false);
  }
});
test("expected composite versions fail early on SQL or captured bytes and do not spawn a parser or retry", async t => {
  const h = harness(t), first = await complete(h), expectedVersion = first.source;
  assert.equal((await complete(h, { expectedVersion, selection: { mode: "records", offset: 1, limit: 2 } })).page.offset, 1);
  for (const stage of [0, 1]) {
    const count = h.stages.length, pending = h.pipeline.readNamed(f.namedRequest(), { expectedVersion });
    if (stage === 1) await h.step();
    const c = stage === 0 ? f.sqliteCapture(o => { o.fields.title = "changed"; }) : f.captured(null); await h.step(c);
    assert.equal((await pending).code, "source_version_changed"); assert.equal(h.stages.length - count, stage + 1);
  }
});
for (const stage of [0, 1, 2, 3, 4]) {
  test(`revocation/abort during stage ${stage + 1} waits for real close, drops result and never retries`, async t => {
    const h = harness(t), controller = new AbortController(), pending = h.pipeline.readNamed(f.namedRequest(), { signal: controller.signal });
    for (let i = 0; i < stage; i++) await h.step(); controller.abort();
    assert.deepEqual(await pending, unavailable("source_aborted")); assert.equal(h.stages.length, stage + 1);
    assert.equal(h.admission.status().cleanupConfirmed, true); assert.equal(h.admission.status().quarantined, false);
  });
  test(`unknown cleanup during stage ${stage + 1} quarantines the shared Host and late close cannot publish`, async t => {
    const admission = createReaderAdmission(), h = harness(t, { admission, holdReader: true, holdParser: true }), peer = harness(t, { admission });
    const controller = new AbortController(), pending = h.pipeline.readNamed(f.namedRequest(), { signal: controller.signal });
    for (let i = 0; i < stage; i++) await h.step(); const other = peer.pipeline.read(f.request()); controller.abort();
    assert.deepEqual(await pending, unavailable("source_cleanup_unconfirmed")); assert.equal((await other).code, "source_service_quarantined");
    assert.equal(admission.status().quarantined, true); assert.equal(admission.status().activeWorkers, 1);
    await h.step(); assert.equal(admission.status().activeWorkers, 0); assert.equal(admission.status().quarantined, true);
    assert.equal((await peer.pipeline.readNamed(f.namedRequest())).code, "source_service_quarantined"); assert.equal(h.stages.length, stage + 1);
  });
}
test("every capture must independently match root, thread, close state and exact protocol, including final captures", async t => {
  for (const stage of [0, 1, 3, 4]) for (const malformed of [false, true]) {
    const h = harness(t), pending = h.pipeline.readNamed(f.namedRequest()); for (let i = 0; i < stage; i++) await h.step();
    const value = [0, 3].includes(stage) ? f.sqliteCapture() : f.captured();
    if (malformed) value.cleanupConfirmed = false; else value.threadId = "11111111-2222-4333-8444-555555555555";
    await h.step(value); assert.deepEqual(await pending, unavailable("source_worker_protocol")); assert.equal(h.stages.length, stage + 1);
    assert.equal(h.admission.status().cleanupConfirmed, true);
  }
});
test("parser refusal does not start final captures; shared close also cancels the final stage", async t => {
  const h = harness(t), pending = h.pipeline.readNamed(f.namedRequest());
  await h.step(f.sqliteCapture(o => { o.nameContext.rolloutPath = "../auth.json"; })); await h.step(); await h.step();
  assert.deepEqual(await pending, unavailable("name_resolution_rollout_mismatch")); assert.equal(h.stages.length, 3);
  const next = h.pipeline.readNamed(f.namedRequest()); for (let i = 0; i < 4; i++) await h.step(); h.admission.close();
  assert.equal((await next).code, "source_service_closed"); assert.equal(h.admission.status().cleanupConfirmed, true);
});
test("named inputs and expected versions are detached, exact and matched before any source access", async t => {
  const h = harness(t); let calls = 0;
  for (const change of [v => { v.sqlite.source.threadId = "11111111-2222-4333-8444-555555555555"; }, v => { v.method = "thread_resume"; },
    v => { v.sqlite.nativeVersion = "latest"; }, v => { v.env = {}; }, v => { Object.defineProperty(v.sqlite, "source", { get() { calls++; } }); }]) {
    const input = f.namedRequest(); change(input); assert.equal((await h.pipeline.readNamed(input)).code, "invalid_codex_pipeline_request");
  }
  for (const options of [{ expectedVersion: f.job().source }, { selection: { mode: "names", limit: 1 } }, { signal: {} }, { env: {} }])
    assert.match((await h.pipeline.readNamed(f.namedRequest(), options)).code, /^invalid_/);
  const abort = new AbortController(); abort.abort(); assert.equal((await h.pipeline.readNamed(f.namedRequest(), { signal: abort.signal })).code, "source_aborted");
  assert.equal(calls, 0); assert.equal(h.stages.length, 0);
  const windows = harness(t, { platform: "win32" }); assert.equal((await windows.pipeline.readNamed(f.namedRequest())).code, "source_platform_unsupported");
  assert.equal(windows.stages.length, 0);
});
