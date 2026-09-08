"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), { spawn } = require("node:child_process");
const f = require("../protocol/native/codex/parser-fixture.cjs"), wire = require("../protocol/native/codex/parser-wire");
const { processJob } = require("../protocol/native/codex/parser-worker");
const { observeRolloutNameIdentity, createRolloutSnapshot, releaseRolloutSnapshot, readRolloutPage, LIMITS } = require("../protocol/native/codex/rollout-snapshot");
const parameters = { nativeVersion: "0.153.4", threadId: f.id }, meta = mode => ({ type: "session_meta", payload: { id: f.id, history_mode: mode } });
function prepared(c = f.captured(), sql = f.sqliteCapture(), method = "thread_read_sqlite", selection = { mode: "names" }) {
  const job = f.namedJob(c, selection, sql, method), encoded = wire.encodeJob(job, c);
  assert(encoded); const decoded = wire.readJob(encoded); assert(decoded); return { ...decoded, encoded };
}
test("named parser joins the selected SQL title with the captured identity; raw page and old protocol stay unchanged", () => {
  const { job, bytes } = prepared(), result = processJob(job, bytes);
  assert.equal(result.name.name, "原生候選 🐾"); assert.equal(result.name.candidateSource, "sqlite_distinct_legacy_title");
  assert.equal(result.name.nativeTitleResolved, false); assert.equal(result.sourceAuthenticated, false); assert.equal(result.publishable, false);
  assert.equal(result.page, null); assert.deepEqual(wire.readResponse(wire.encodeResponse(result, job), job, bytes), result);
  const c = f.captured(), oldJob = f.job(c), named = prepared(c, undefined, undefined, oldJob.selection);
  const oldResult = processJob(oldJob, wire.readJob(wire.encodeJob(oldJob, c)).bytes), next = processJob(named.job, named.bytes);
  assert.deepEqual(next.page, oldResult.page); assert.equal(Object.hasOwn(oldResult, "name"), false);
});
test("legacy read keeps the raw index name; list trims and suppresses matching SQL preview", () => {
  const sql = f.sqliteCapture(o => { o.fields.title = "first"; o.nameContext.preview = "原生候選 🐾"; });
  const read = prepared(undefined, sql), list = prepared(undefined, sql, "thread_list_state_row");
  const a = processJob(read.job, read.bytes).name, b = processJob(list.job, list.bytes).name;
  assert.equal(a.name, "  原生候選 🐾  "); assert.equal(a.candidateSource, "legacy_index_single_read");
  assert.equal(b.name, null); assert.equal(b.candidateSource, "legacy_index_batch_list"); assert.equal(b.suppressedByPreview, true);
});
test("paginated names use first selected metadata only, while paginated records stay explicitly unsupported", () => {
  const c = f.withRollout([meta("paginated"), { type: "session_meta", payload: { id: "11111111-2222-4333-8444-555555555555", history_mode: "legacy" } }]);
  const sql = f.sqliteCapture(o => { o.fields.history_mode = "paginated"; o.fields.name = "  分頁名称 🐾  "; });
  const p = prepared(c, sql), result = processJob(p.job, p.bytes);
  assert.equal(result.name.name, "分頁名称 🐾"); assert.equal(result.name.candidateSource, "sqlite_paginated_name");
  const raw = prepared(c, sql, undefined, { mode: "records", offset: 0, limit: 2 });
  assert.equal(processJob(raw.job, raw.bytes).code, "native_paginated_history_unsupported");
  assert.equal(result.semanticHistoryComplete, false);
});
test("names require matched thread, mode and independently selected path; missing SQL never silently falls back", () => {
  for (const change of [o => { o.fields.history_mode = "paginated"; }, o => { o.nameContext.rolloutPath = "../auth.json"; },
    o => { o.nameContext.rolloutPath += ".moved"; }]) {
    const p = prepared(undefined, f.sqliteCapture(change)); assert.equal(processJob(p.job, p.bytes).code, "name_resolution_rollout_mismatch");
  }
  const sql = f.sqliteCapture(o => { o.fields = null; o.nameContext = null; }), p = prepared(undefined, sql);
  assert.equal(processJob(p.job, p.bytes).code, "name_resolution_missing_row_unsupported");
  const bad = f.namedJob(); bad.nameResolution.fields.id = "11111111-2222-4333-8444-555555555555";
  assert.equal(wire.validJob(bad), false);
});
test("name identity is a bounded observation, not a raw snapshot or a repair-capable native parser", () => {
  const raw = f.withRollout(["", meta("legacy"), { type: "session_meta", payload: { id: f.id, history_mode: "future" } }]).rolloutBytes;
  const before = Buffer.from(raw), identity = observeRolloutNameIdentity(raw, parameters);
  assert.equal(identity.kind, "codex_rollout_name_identity"); assert.equal(identity.historyMode, "legacy"); assert.deepEqual(raw, before);
  assert.equal(Object.hasOwn(identity, "snapshotId"), false); assert.equal(releaseRolloutSnapshot(identity), false);
  assert.equal(readRolloutPage(identity, {}).code, "rollout_snapshot_unavailable");
  assert.equal(createRolloutSnapshot(raw, parameters).code, "native_history_mode_unknown");
  for (const [records, code] of [[[meta("future")], "native_history_mode_unknown"], [[{ ...meta("legacy"), payload: { id: "11111111-2222-4333-8444-555555555555" } }], "rollout_selected_thread_mismatch"],
    [[{ type: "event_msg", payload: {} }, meta("legacy")], "rollout_selected_thread_mismatch"], [[meta("legacy"), "not JSON"], "rollout_invalid_record"]])
    assert.equal(observeRolloutNameIdentity(f.withRollout(records).rolloutBytes, parameters).code, code);
  assert.equal(observeRolloutNameIdentity(raw.subarray(0, -1), parameters).code, "rollout_incomplete_tail");
  assert.equal(observeRolloutNameIdentity(Buffer.alloc(LIMITS.inputBytes + 1), parameters).code, "invalid_rollout_bytes_or_limit");
  assert.equal(observeRolloutNameIdentity(f.withRollout([meta("legacy"), " ".repeat(LIMITS.recordBytes)]).rolloutBytes, parameters).code, "rollout_record_limit");
});
test("v2 accepts bounded SQL name context above the old header cap but rejects malformed, accessored and oversized fields", () => {
  const p = prepared(undefined, f.sqliteCapture(o => { o.nameContext.preview = "x".repeat(32768); }));
  assert(p.encoded.readUInt32BE(0) > wire.LIMITS.headerBytes); assert(p.encoded.readUInt32BE(0) <= wire.LIMITS.namedHeaderBytes);
  assert.equal(processJob(p.job, p.bytes).name.name, "原生候選 🐾");
  for (const change of [j => { j.nameResolution.nameContext.preview += "x"; }, j => { j.nameResolution.env = {}; },
    j => { j.nameResolution.fields.title = "\ud800"; }, j => { j.nameResolution.rolloutPath = "relative"; }, j => { j.protocolVersion = 1; }]) {
    const job = structuredClone(p.job); change(job); assert.equal(wire.encodeJob(job, f.captured()), null);
  }
  let calls = 0; const getter = f.namedJob(); Object.defineProperty(getter.nameResolution, "fields", { get() { calls++; } });
  assert.equal(wire.encodeJob(getter, f.captured()), null); assert.equal(calls, 0);
  const changed = Buffer.from(p.encoded); changed[changed.length - 3] ^= 1; assert.equal(wire.readJob(changed), null);
});
test("v2 output is nonce-bound, exact-shaped and never grants native-name or source authority", () => {
  const p = prepared(), result = processJob(p.job, p.bytes);
  for (const change of [r => { r.name.nativeTitleResolved = true; }, r => { r.name.sourceAuthenticated = true; }, r => { r.name.publishable = true; },
    r => { r.name.method = "thread_list_state_row"; }, r => { r.name.candidateSource = "guessed"; }, r => { r.name.name = "\ud800"; },
    r => { r.name.extra = "private"; }, r => { r.name.nativeThreadId = "11111111-2222-4333-8444-555555555555"; }]) {
    const value = structuredClone(result); change(value);
    assert.equal(wire.readResponse(Buffer.from(JSON.stringify({ protocolVersion: 2, nonce: p.job.nonce, result: value }) + "\n"), p.job, p.bytes), null);
  }
});
test("actual permissioned parser resolves v2 without native source reads, writes, inherited routes or model calls", async () => {
  const p = prepared(undefined, f.sqliteCapture(o => { o.nameContext.preview = "x".repeat(32768); })), launch = wire.launchOptions();
  assert.deepEqual(launch.options.env, { LANG: "C", LC_ALL: "C" }); assert.equal(launch.options.shell, false);
  const child = spawn(launch.executable, launch.args, launch.options), output = [], errors = [];
  const timer = setTimeout(() => child.kill("SIGKILL"), 10000);
  child.stdout.on("data", b => output.push(b)); child.stderr.on("data", b => errors.push(b)); child.stdin.end(p.encoded);
  const [code, signal] = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", (...v) => resolve(v)); }).finally(() => clearTimeout(timer));
  assert.equal(code, 0); assert.equal(signal, null); assert.equal(Buffer.concat(errors).length, 0);
  assert.equal(wire.readResponse(Buffer.concat(output), p.job, p.bytes).name.name, "原生候選 🐾");
});
