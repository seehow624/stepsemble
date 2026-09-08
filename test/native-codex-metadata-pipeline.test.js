"use strict";
const baseTest = require("node:test"), assert = require("node:assert/strict");
const { createCodexMetadataPipeline, createCodexNameContextPipeline } = require("../protocol/native/codex/metadata-pipeline");
const { createReaderAdmission } = require("../protocol/native/claude/history-reader-admission");
const allFixture = require("../protocol/native/codex/sqlite-fixture.cjs");
for (const withContext of [false, true]) {
  const fixture = withContext ? allFixture.context : allFixture;
  const createPipeline = withContext ? createCodexNameContextPipeline : createCodexMetadataPipeline;
  const kind = withContext ? "codex_sqlite_context_capture" : "codex_sqlite_name_capture";
  const method = withContext ? "readCodexNameContext" : "readCodexMetadata";
  const test = (name, fn) => baseTest(`v${withContext ? 5 : 4}: ${name}`, fn);
  const unavailable = code => ({ kind: "source_unavailable", code });
  function harness(t, config = {}) {
    const admission = config.admission ?? createReaderAdmission(), helpers = [];
    const pipeline = createPipeline({ helperPath: process.execPath, admission, platform: "linux", deadlineMs: config.deadlineMs ?? 2000,
      cleanupMs: 20, createHelper() {
        const h = { active: false, calls: [] };
        h.status = () => ({ activeWorker: h.active, cleanupConfirmed: !h.active, quarantined: false });
        h.close = () => { h.active = false; };
        h[method] = (input, { signal }) => {
          assert.equal(h.active, false); h.active = true; h.calls.push(input);
          const p = new Promise(resolve => { h.finish = (result = fixture.capture(), close = true) => { if (close) h.close(); resolve(result); }; });
          signal.addEventListener("abort", () => { if (!config.hold) h.finish(unavailable("source_aborted")); }, { once: true });
          config.onRead?.(h); return p;
        };
        h.shutdown = async () => ({ cleanupConfirmed: !h.active }); helpers.push(h); return h;
      } });
    t.after(async () => { for (const h of helpers) { h.finish?.(unavailable("source_aborted")); h.close(); } await pipeline.shutdown(); });
    return { pipeline, admission, helpers };
  }
  async function complete(h, options, body) {
    const p = h.pipeline.read(fixture.request(), options); h.helpers.find(h => h.active).finish(fixture.capture(body)); return p;
  }
  test("shared admitted capture detaches input and interprets legacy/paginated/missing rows without final native title claims", async t => {
    const h = harness(t), r = fixture.request(), p = h.pipeline.read(r); r.source.sqliteRoot = "changed";
    assert.deepEqual(h.helpers[0].calls[0], fixture.request()); assert.equal(h.admission.status().activeWorkers, 1);
    h.helpers[0].finish(); const a = await p;
    assert.equal(a.kind, kind); assert.equal(a.metadata.candidate, "原生候選 🐾");
    assert.equal(a.metadata.candidateSource, "sqlite_distinct_legacy_title"); assert.equal(a.metadata.nativeTitleResolved, false);
    assert.equal(a.publishable, false); assert.equal(a.sourceAuthenticated, false); assert.equal(a.cleanupConfirmed, true); assert.equal(h.admission.status().activeWorkers, 0);
    const b = fixture.body(); b.observation.fields.history_mode = "paginated"; b.observation.fields.name = "  分頁名稱  ";
    assert.equal((await complete(h, {}, b)).metadata.candidate, "分頁名稱"); b.observation.fields = null; if (withContext) b.observation.nameContext = null;
    const missing = await complete(h, {}, b); assert.equal(missing.metadata.presence, "missing_row"); assert.equal(missing.metadata.candidate, null);
  });
  test("all metadata consumers share two physical permits and never queue or create replacement helpers", async t => {
    const admission = createReaderAdmission(), a = harness(t, { admission }), b = harness(t, { admission });
    const p = a.pipeline.read(fixture.request()), q = b.pipeline.read(fixture.request());
    assert.equal(admission.status().activeWorkers, 2); assert.equal((await a.pipeline.read(fixture.request())).code, "source_busy");
    assert.equal(a.helpers.flatMap(h => h.calls).length, 1); a.helpers[0].finish(); b.helpers[0].finish();
    assert.equal((await p).kind, kind); assert.equal((await q).kind, kind);
    assert.equal(admission.status().cleanupConfirmed, true); assert.equal(a.helpers.length + b.helpers.length, 4);
  });
  test("selected-field fence ignores counters but rejects changed fields and file identity before name publication", async t => {
    const h = harness(t), a = await complete(h), b = fixture.body(); b.readCalls++; b.requestedReadBytes += 8192;
    assert.equal((await complete(h, { expectedVersion: a.source }, b)).kind, kind);
    b.observation.fields.title += "changed"; assert.equal((await complete(h, { expectedVersion: a.source }, b)).code, "source_version_changed");
    const replacement = fixture.body(); replacement.identities[0].inode = "99";
    assert.equal((await complete(h, { expectedVersion: a.source }, replacement)).code, "source_version_changed");
  });
  test("abort, deadline and shared close await cleanup and do not replay", async t => {
    for (const reason of ["abort", "deadline", "sharedClose", "shutdown", "reentrant"]) {
      const controller = new AbortController(), h = harness(t, { deadlineMs: reason === "deadline" ? 30 : 2000, onRead: reason === "reentrant" ? () => controller.abort() : undefined });
      const p = h.pipeline.read(fixture.request(), { signal: controller.signal }); let closing;
      if (reason === "abort") controller.abort("PRIVATE"); if (reason === "sharedClose") h.admission.close(); if (reason === "shutdown") closing = h.pipeline.shutdown();
      assert.equal((await p).code, reason === "deadline" ? "source_worker_timeout" : ["sharedClose", "shutdown"].includes(reason) ? "source_service_closed" : "source_aborted");
      if (closing) assert.equal((await closing).cleanupConfirmed, true);
      assert.equal(h.admission.status().cleanupConfirmed, true); assert.equal(h.admission.status().quarantined, false); assert.equal(h.helpers.flatMap(h => h.calls).length, 1);
    }
  });
  test("unknown cleanup globally quarantines and retains the occupied permit until actual close, including late success", async t => {
    const admission = createReaderAdmission(), a = harness(t, { admission, hold: true }), b = harness(t, { admission });
    const controller = new AbortController(), p = a.pipeline.read(fixture.request(), { signal: controller.signal }), q = b.pipeline.read(fixture.request());
    controller.abort(); assert.equal((await p).code, "source_cleanup_unconfirmed"); assert.equal((await q).code, "source_service_quarantined");
    assert.equal(admission.status().activeWorkers, 1); assert.equal(admission.status().quarantined, true);
    a.helpers[0].finish(); await new Promise(resolve => setImmediate(resolve)); assert.equal(admission.status().activeWorkers, 0);
    const c = harness(t, { admission }); assert.equal((await c.pipeline.read(fixture.request())).code, "source_service_quarantined"); assert.equal(c.helpers.flatMap(h => h.calls).length, 0);
  });
  test("unclosed helper success cannot publish even structurally valid fields", async t => {
    const h = harness(t, { hold: true }), p = h.pipeline.read(fixture.request()); h.helpers[0].finish(fixture.capture(), false);
    assert.equal((await p).code, "source_cleanup_unconfirmed"); assert.equal(h.admission.status().activeWorkers, 1);
    h.helpers[0].close(); assert.equal(h.admission.status().cleanupConfirmed, true); assert.equal(h.admission.status().quarantined, true);
  });
  test("malformed injected output and private diagnostic codes cannot escape through names", async t => {
    for (const mutate of [v => { v.threadId = "wrong"; }, v => { v.expectedRoot.inode = "9"; }, v => { v.cleanupConfirmed = false; },
      v => { v.extra = true; }, v => { v.metadata.observation.connectionClosed = false; }]) {
      const h = harness(t), p = h.pipeline.read(fixture.request()), c = fixture.capture(); mutate(c); h.helpers[0].finish(c);
      assert.deepEqual(await p, unavailable("source_worker_protocol")); assert.equal(h.admission.status().cleanupConfirmed, true);
    }
    for (const code of ["PRIVATE PATH", "source_database_unavailable", "source_busy", "source_cleanup_unconfirmed"]) {
      const h = harness(t), p = h.pipeline.read(fixture.request()); h.helpers[0].finish(unavailable(code));
      assert.deepEqual(await p, unavailable(code === "PRIVATE PATH" ? "source_worker_failure" : code));
      assert.equal(h.admission.status().quarantined, code === "source_cleanup_unconfirmed");
    }
  });
  test("closing this consumer does not close another shared consumer", async t => {
    const admission = createReaderAdmission(), a = harness(t, { admission }), b = harness(t, { admission });
    const p = b.pipeline.read(fixture.request()); assert.equal((await a.pipeline.shutdown()).cleanupConfirmed, true);
    assert.equal(admission.status().closed, false); b.helpers[0].finish(); assert.equal((await p).kind, kind);
  });
  test("invalid requests/signals/versions/accessors and pre-abort cause no capture", async t => {
    const h = harness(t); let invoked = false;
    for (const r of [{}, null, { ...fixture.request(), nativeVersion: "unknown" }, { get source() { invoked = true; return {}; } }])
      assert.equal((await h.pipeline.read(r)).code, "invalid_codex_metadata_request");
    for (const options of [{ expectedVersion: null }, { expectedVersion: {} }, { env: {} }, { get signal() { invoked = true; return null; } }])
      assert.equal((await h.pipeline.read(fixture.request(), options)).code, "invalid_codex_metadata_request");
    assert.equal((await h.pipeline.read(fixture.request(), { signal: {} })).code, "invalid_source_signal");
    const c = new AbortController(); c.abort(); assert.equal((await h.pipeline.read(fixture.request(), { signal: c.signal })).code, "source_aborted");
    assert.equal(invoked, false); assert.equal(h.helpers.flatMap(h => h.calls).length, 0);
  });
  test("constructor requires genuine caller-owned admission and strict helper lifecycle; Windows stays unsupported", async () => {
    const options = { helperPath: process.execPath, admission: createReaderAdmission() };
    for (const bad of [{ ...options, admission: undefined }, { ...options, admission: { ...options.admission } }, { ...options, env: {} },
      { ...options, helperPath: "/" }, { ...options, deadlineMs: 10001 }, { ...options, cleanupMs: 1001 }, { ...options, createHelper: () => ({}) }])
      assert.throws(() => createPipeline(bad), /invalid_/);
    const p = createPipeline({ ...options, platform: "win32" }); assert.equal((await p.read(fixture.request())).code, "source_platform_unsupported");
    assert.equal((await p.shutdown()).cleanupConfirmed, true);
  });

}
