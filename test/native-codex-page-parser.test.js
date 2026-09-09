"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), { spawn } = require("node:child_process");
const wire = require("../protocol/native/codex/parser-wire"), worker = require("../protocol/native/codex/parser-worker");
const scan = require("../protocol/native/codex/scanned-source-wire"), old = require("../protocol/native/codex/source-wire");
const f = require("../protocol/native/codex/parser-fixture.cjs");
const frame = (job, bytes) => { const h = Buffer.from(JSON.stringify(job)), n = Buffer.alloc(4); n.writeUInt32BE(h.length); return Buffer.concat([n, h, bytes]); };
function prepare(capture = f.pageCaptured(), selection, named = false, sql) {
  const job = f.pageJob(capture, selection, named, sql), encoded = wire.encodeJob(job, capture);
  assert(encoded); const parsed = wire.readJob(encoded); assert(parsed);
  const result = worker.processJob(parsed.job, parsed.bytes);
  assert.deepEqual(wire.readResponse(wire.encodeResponse(result, job), job, parsed.bytes), result);
  return { job, encoded, bytes: parsed.bytes, result };
}
test("v7/v8 consume only selected bytes, preserve full identity and original raw records across all pages and EOF", () => {
  const base = f.structuredCaptured(), rows = []; let at = 0, version;
  do {
    const capture = f.pageCaptured(at, 2, base), { result, bytes, job } = prepare(capture);
    assert.equal(result.kind, "codex_parsed_page_capture", result.code); assert.equal(result.source.kind, "codex_validated_source_version");
    if (version) assert(scan.sameSourceVersion(version, result.source)); else version = result.source;
    assert.equal(result.page.recordCount, capture.rollout.recordCount); assert.equal(result.page.byteLength, base.rolloutBytes.length);
    assert.equal(bytes.length, capture.pageBytes.length + capture.nameIndexBytes.length); assert.equal(job.protocolVersion, 7);
    assert.equal(old.sourceVersion(capture), null); assert.equal(result.semanticHistoryComplete, false); assert.equal(result.publishable, false);
    assert.equal(Object.hasOwn(result, "structure"), false); rows.push(...result.page.records); at = result.page.nextOffset;
  } while (at !== null);
  assert.equal(rows.map(r => r.rawText).join(""), base.rolloutBytes.toString());
  const eof = prepare(f.pageCaptured(rows.length, 2, base)).result;
  assert.deepEqual(eof.page.records, []); assert.equal(eof.page.endOfFile, true); assert.equal(eof.page.nextOffset, null);
});
test("v8 resolves off-page metadata names with existing SQL/index semantics, including suppression and path/mode mismatch", () => {
  const capture = f.pageCaptured(4, 2), selection = { mode: "records", offset: 4, limit: 2 };
  assert.equal(prepare(capture, selection, true).result.name.name, "原生候選 🐾");
  const sql = f.sqliteCapture(o => { o.fields.title = "different SQL title"; });
  assert.equal(prepare(capture, selection, true, sql).result.name.name, "different SQL title");
  const fallback = f.sqliteCapture(o => { o.fields.title = o.nameContext.preview; });
  assert.equal(prepare(capture, selection, true, fallback).result.name.name, "  原生候選 🐾  ");
  const named = prepare(f.pageCaptured(0, 1), { mode: "names" }, true); assert.equal(named.result.page, null);
  const list = { ...f.pageJob(capture, selection, true, fallback) }; list.nameResolution.method = "thread_list_state_row";
  list.nameResolution.nameContext.preview = "原生候選 🐾"; list.nameResolution.fields.title = "原生候選 🐾";
  const p = wire.readJob(wire.encodeJob(list, capture)), r = worker.processJob(p.job, p.bytes);
  assert.equal(r.name.name, null); assert.equal(r.name.suppressedByPreview, true);
  for (const [change, code] of [[o => { o.nameContext.rolloutPath += ".moved"; }, "name_resolution_rollout_mismatch"],
    [o => { o.fields.history_mode = "paginated"; }, "name_resolution_rollout_mismatch"]]) {
    assert.equal(prepare(capture, selection, true, f.sqliteCapture(change)).result.code, code);
  }
});
test("v7 large source context does not allocate or require full-file bytes and keeps offsets beyond 8192", () => {
  const base = f.withRollout([{ type: "session_meta", payload: { id: f.id } }, ...Array(9000).fill({ type: "event_msg", payload: { type: "agent_message", message: "x".repeat(1024) } })]);
  const capture = f.pageCaptured(8500, 50, base), p = prepare(capture, { mode: "records", offset: 8500, limit: 50 }, true);
  assert.ok(base.rolloutBytes.length > 8 * 1024 * 1024); assert.ok(p.encoded.length < 100 * 1024);
  assert.equal(p.result.page.records.length, 50); assert.equal(p.result.page.records[0].recordIndex, 8500);
  assert.equal(p.result.page.recordCount, 9001); assert.equal(wire.validSelection(p.job.selection), false);
});
test("page input rejects v10 downgrade, old parser upgrades, extra grants, stale profiles, bad ranges and segment substitutions", () => {
  const { job, bytes } = prepare();
  for (const change of [v => { v.protocolVersion = 5; }, v => { v.source.kind = "codex_scanned_source_version"; delete v.source.validation; },
    v => { v.source.validation.recordsValidated--; }, v => { v.source.validation.historyMode = "paginated"; },
    v => { v.path = "auth.json"; }, v => { v.source.storage.encoding = "zstd"; }, v => { v.selection.offset++; },
    v => { v.page.records[0].payloadOffset++; }, v => { v.page.records[0].byteOffset++; }, v => { v.page.records[0].sha256 = "f".repeat(64); },
    v => { v.page.byteLength++; }, v => { v.page.nextOffset++; }, v => { v.page.records[0].extra = true; }]) {
    const j = structuredClone(job); change(j); assert.equal(wire.readJob(frame(j, bytes)), null);
  }
  const changed = Buffer.from(bytes); changed[changed.length - 2] ^= 1; assert.equal(wire.readJob(frame(job, changed)), null);
  assert.equal(wire.readJob(frame(job, Buffer.concat([bytes, bytes]))), null);
  const stale = structuredClone(job); stale.expectedVersion = structuredClone(job.source); stale.expectedVersion.rollout.sha256 = "f".repeat(64);
  assert.equal(worker.processJob(stale, bytes).code, "source_version_changed");
  const oldJob = f.job(); oldJob.source = job.source; assert.equal(wire.validJob(oldJob), false);
});
test("worker rechecks selected UTF8/envelopes and metadata even with a mocked complete-source receipt", () => {
  for (const [row, code] of [["not JSON", "rollout_invalid_record"], [{ type: "session_meta", payload: { id: "bad" } }, "rollout_invalid_metadata"],
    [{ type: "event_msg" }, "rollout_selected_thread_mismatch"], ["", "rollout_selected_thread_mismatch"]]) {
    const capture = f.pageCaptured(0, 1, f.withRollout([row])); assert.equal(prepare(capture).result.code, code);
  }
  const capture = f.pageCaptured(0, 1, f.withRollout(["x"])); capture.pageBytes[0] = 255;
  capture.page.records[0].sha256 = f.sha(capture.pageBytes);
  assert.equal(prepare(capture).result.code, "rollout_invalid_utf8");
});
test("JSON output byte budget advances only returned records, including blank/fork/unknown records and escaped whitespace", () => {
  const meta = { type: "session_meta", payload: { id: f.id } }, blank = "\v".repeat(48000);
  const base = f.withRollout([meta, blank, { type: "future_unknown", payload: {} }]);
  const first = prepare(f.pageCaptured(0, 3, base), { mode: "records", offset: 0, limit: 3 }).result;
  assert.equal(first.page.records.length, 1); assert.equal(first.page.nextOffset, 1);
  assert.equal(prepare(f.pageCaptured(1, 2, base)).result.code, "rollout_record_limit");
  const fork = f.withRollout([meta, "", { type: "session_meta", payload: { id: "bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeeee" } }, { type: "future_unknown" }]);
  const c = f.pageCaptured(0, 4, fork); c.validation.metadataRecords = 2;
  const p = prepare(c, { mode: "records", offset: 0, limit: 4 }).result;
  assert.deepEqual(p.page.records.map(r => r.recordType), ["session_meta", "blank", "session_meta", "future_unknown"]);
  const bounded = f.withRollout([meta, "\v".repeat(32000), "\v".repeat(32000), { type: "future_unknown" }]);
  const a = prepare(f.pageCaptured(0, 4, bounded), { mode: "records", offset: 0, limit: 4 }).result;
  assert.equal(a.page.records.length, 2); assert.equal(a.page.nextOffset, 2);
  const b = prepare(f.pageCaptured(2, 4, bounded), { mode: "records", offset: 2, limit: 4 }).result;
  assert.equal(b.page.endOfFile, true); assert.equal([...a.page.records, ...b.page.records].map(r => r.rawText).join(""), bounded.rolloutBytes.toString());
});
test("leading blank metadata offset and strict index presence survive page selection without a fabricated first-record identity", () => {
  const base = f.withRollout(["\r", { type: "session_meta", payload: { id: f.id } }, { type: "future_unknown" }]);
  for (const offset of [0, 1, 2, 3]) {
    const c = f.pageCaptured(offset, 1, base); c.validation.selectedMetadataRecord = 1;
    const result = prepare(c, { mode: "records", offset, limit: 1 }).result;
    assert.equal(result.kind, "codex_parsed_page_capture", result.code);
  }
  for (const index of [null, Buffer.alloc(0), Buffer.from([255])]) {
    const c = f.pageCaptured(0, 1, f.structuredCaptured(index)), result = prepare(c, { mode: "names" }).result;
    if (index?.length) assert.equal(result.code, "name_index_invalid_utf8");
    else assert.equal(result.index.presence, index === null ? "missing" : "empty");
  }
});
test("response binds full version, exact descriptor, original text and types; no fabricated graph or authoritative flags", () => {
  const { job, bytes, result } = prepare(f.pageCaptured(4, 2));
  for (const change of [v => { v.kind = "codex_parsed_capture"; }, v => { v.source.rollout.sha256 = "f".repeat(64); },
    v => { v.page.records[0].byteOffset++; }, v => { v.page.records[0].recordType = "invented"; },
    v => { v.page.records[0].rawText = v.page.records[0].rawText.replace("response_item", "modified_item"); },
    v => { v.page.nextOffset++; }, v => { v.page.recordCount--; }, v => { v.page.records.pop(); v.page.nextOffset--; },
    v => { v.structure = {}; }, v => { v.semanticHistoryComplete = true; }, v => { v.page.publishable = true; }]) {
    const value = structuredClone(result); change(value);
    assert.equal(wire.readResponse(Buffer.from(JSON.stringify({ protocolVersion: 7, nonce: job.nonce, result: value }) + "\n"), job, bytes), null);
  }
});
test("page capture rejects byte getters, shared memory, wrong selection and unknown cleanup without invoking hooks", () => {
  const good = f.pageCaptured(), job = f.pageJob(good); let reads = 0;
  const getter = f.pageCaptured(); Object.defineProperty(getter, "pageBytes", { enumerable: true, get() { reads++; return good.pageBytes; } });
  assert.equal(wire.encodeJob(job, getter), null); assert.equal(reads, 0);
  for (const change of [v => { v.cleanupConfirmed = false; }, v => { v.pageBytes = Buffer.from(new SharedArrayBuffer(v.pageBytes.length)); },
    v => { v.pageBytes = Buffer.alloc(1); }, v => { v.page.offset++; }]) { const c = f.pageCaptured(); change(c); assert.equal(wire.encodeJob(job, c), null); }
});
test("actual restricted parser accepts v8 selected bytes with only code-file read grants and no child diagnostics", async () => {
  const { encoded, job, bytes, result } = prepare(f.pageCaptured(4, 2), undefined, true), launch = wire.launchOptions();
  const out = await new Promise((resolve, reject) => {
    const child = spawn(launch.executable, launch.args, launch.options), stdout = [], stderr = [];
    const timer = setTimeout(() => child.kill("SIGKILL"), 10000);
    child.on("error", reject); child.stdout.on("data", b => stdout.push(b)); child.stderr.on("data", b => stderr.push(b));
    child.on("close", (code, signal) => { clearTimeout(timer); resolve({ code, signal, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) }); });
    child.stdin.end(encoded);
  });
  assert.equal(out.code, 0, out.stderr.toString()); assert.equal(out.signal, null); assert.equal(out.stderr.length, 0);
  assert.deepEqual(wire.readResponse(out.stdout, job, bytes), result);
});
