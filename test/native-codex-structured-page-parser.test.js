"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), { spawn } = require("node:child_process");
const f = require("../protocol/native/codex/structured-page-fixture.cjs");
const wire = require("../protocol/native/codex/parser-wire"), worker = require("../protocol/native/codex/parser-worker");
const structured = require("../protocol/native/codex/structured-page"), source = require("../protocol/native/codex/structured-source-wire");
const old = require("../protocol/native/codex/parser-fixture.cjs");
const envelope = (job, bytes) => { const header = Buffer.from(JSON.stringify(job)), prefix = Buffer.alloc(4); prefix.writeUInt32BE(header.length);
  return Buffer.concat([prefix, header, bytes]); };
function prepare(capture = f.captureFrom(), selection, named = false, sql, method) {
  const job = f.job(capture, selection, named, sql, method), encoded = wire.encodeJob(job, capture);
  assert(encoded); const decoded = wire.readJob(encoded); assert(decoded);
  const result = worker.processJob(decoded.job, decoded.bytes), response = wire.encodeResponse(result, job);
  assert(response); assert.deepEqual(wire.readResponse(response, job, decoded.bytes), result);
  return { capture, job, encoded, bytes: decoded.bytes, result, response };
}
const turn = (key, id, first, last, state = "retained", rollback = null) => ({ turnKey: key, nativeTurnId: id, boundary: id === null ? "inferred" : "explicit",
  firstRecordIndex: first, lastRecordIndex: last, recordedStatus: "started", statusRecordIndex: first, branchState: state, rollbackRecordIndex: rollback });
const annotation = (recordIndex, kind, turnKey = null, tool = null, warnings = []) => ({ recordIndex, kind, turnKey, tool, warnings });

test("v9 consumes the exact v12 segments and keeps page-aware selected structure without authority", () => {
  const base = old.withRollout([{ type: "session_meta", payload: { id: old.id, history_mode: "legacy", cli_version: "0.153.4" } },
    { type: "event_msg", payload: { type: "task_started", turn_id: "A" } },
    { type: "event_msg", payload: { type: "exec_command_begin", turn_id: "A", call_id: "call-A" } },
    { type: "event_msg", payload: { type: "exec_command_end", turn_id: "A", call_id: "call-A" } }]);
  base.storage = { encoding: "jsonl", rolloutPath: base.rolloutPath }; base.checks.rolloutSelectionRechecked = true;
  const structure = { structureProfile: f.PROFILE, totalTurns: 1, retainedTurns: 1, turns: [turn("record-1", "A", 1, 3)],
    annotations: [annotation(1, "lifecycle", "record-1"), annotation(2, "tool", "record-1", { family: "command", phase: "begin", nativeCallId: "call-A", relatedRecordIndex: 3 }),
      annotation(3, "tool", "record-1", { family: "command", phase: "end", nativeCallId: "call-A", relatedRecordIndex: 2 })] };
  const capture = f.captureFrom(base, 1, 3, structure), { result, bytes } = prepare(capture, { mode: "records", offset: 1, limit: 3 });
  assert.equal(result.kind, "codex_parsed_structured_page_capture"); assert.equal(result.page.scope, "one_legacy_rollout_validated_page");
  assert.equal(result.structure.profile, f.PROFILE); assert.equal(Object.hasOwn(result.structure, "structureProfile"), false);
  assert.deepEqual(result.structure.annotations.map(v => v.tool?.relatedRecordIndex ?? null), [null, 3, 2]);
  assert.equal(result.sourceAuthenticated, false); assert.equal(result.publishable, false); assert.equal(result.semanticHistoryComplete, false);
  assert.equal(bytes.length, capture.pageBytes.length + capture.nameIndexBytes.length + capture.structureBytes.length);
});

test("cross-page tool links and rollback indexes beyond 8192 remain full-source indexes", () => {
  const records = [{ type: "session_meta", payload: { id: old.id, history_mode: "legacy", cli_version: "0.153.4" } },
    ...Array.from({ length: 8197 }, (_, i) => ({ type: "event_msg", payload: { type: "future", n: i } })),
    { type: "event_msg", payload: { type: "task_started", turn_id: "far-turn" } },
    { type: "event_msg", payload: { type: "exec_command_begin", turn_id: "far-turn", call_id: "far-call" } },
    { type: "event_msg", payload: { type: "future" } },
    { type: "event_msg", payload: { type: "exec_command_end", turn_id: "far-turn", call_id: "far-call" } },
    { type: "event_msg", payload: { type: "future" } }, { type: "event_msg", payload: { type: "thread_rolled_back", num_turns: 1 } }];
  const base = old.withRollout(records, null); base.storage = { encoding: "jsonl", rolloutPath: base.rolloutPath }; base.checks.rolloutSelectionRechecked = true;
  const fullTurn = turn("record-8198", "far-turn", 8198, 8202, "rolled_back", 8203);
  const first = f.captureFrom(base, 8199, 2, { structureProfile: f.PROFILE, totalTurns: 1, retainedTurns: 0, turns: [fullTurn],
    annotations: [annotation(8199, "tool", "record-8198", { family: "command", phase: "begin", nativeCallId: "far-call", relatedRecordIndex: 8201 }),
      annotation(8200, "unknown", "record-8198", null, ["unknown_event_preserved"])] });
  const second = f.captureFrom(base, 8201, 2, { structureProfile: f.PROFILE, totalTurns: 1, retainedTurns: 0, turns: [fullTurn],
    annotations: [annotation(8201, "tool", "record-8198", { family: "command", phase: "end", nativeCallId: "far-call", relatedRecordIndex: 8199 }),
      annotation(8202, "unknown", "record-8198", null, ["unknown_event_preserved"])] });
  const a = prepare(first, { mode: "records", offset: 8199, limit: 2 }).result;
  const b = prepare(second, { mode: "records", offset: 8201, limit: 2 }).result;
  assert.equal(a.structure.annotations[0].tool.relatedRecordIndex, 8201); assert.equal(b.structure.annotations[0].tool.relatedRecordIndex, 8199);
  assert.equal(a.structure.turns[0].rollbackRecordIndex, 8203); assert.equal(b.structure.turns[0].firstRecordIndex, 8198);
  assert.equal(a.page.nextOffset, 8201); assert.equal(b.page.nextOffset, 8203);
});

test("v10 preserves maximal escaped name and CJK/emoji IDs while cutting one synchronous prefix to all three budgets", () => {
  const turnIds = Array.from({ length: 30 }, (_, i) => `${String(i).padStart(2, "0")}${"界😀".repeat(340)}`);
  const callIds = Array.from({ length: 30 }, (_, i) => `${String(i).padStart(2, "0")}${"令🐾".repeat(340)}`);
  assert(turnIds.every(v => v.length === 1022));
  const records = [{ type: "session_meta", payload: { id: old.id, history_mode: "legacy", cli_version: "0.153.4" } },
    ...turnIds.map(turn_id => ({ type: "event_msg", payload: { type: "task_started", turn_id } })),
    ...turnIds.map((turn_id, i) => ({ type: "event_msg", payload: { type: "exec_command_begin", turn_id, call_id: callIds[i] } }))];
  const base = old.withRollout(records, null); base.storage = { encoding: "jsonl", rolloutPath: base.rolloutPath }; base.checks.rolloutSelectionRechecked = true;
  const offset = 31, turns = turnIds.map((id, i) => turn(`record-${i + 1}`, id, i + 1, offset + i));
  const privateStructure = { structureProfile: f.PROFILE, totalTurns: 30, retainedTurns: 30, turns,
    annotations: callIds.map((id, i) => annotation(offset + i, "tool", `record-${i + 1}`,
      { family: "command", phase: "begin", nativeCallId: id, relatedRecordIndex: null })) };
  // This is the largest escaped SQL title whose duplicated metadata-name
  // observation remains one byte below its independent 128 KiB output cap.
  const capture = f.captureFrom(base, offset, 30, privateStructure), title = "\\\"".repeat(16326);
  const sql = old.sqliteCapture(o => { o.fields.title = title; o.nameContext.preview = "different"; });
  const { result, response } = prepare(capture, { mode: "records", offset, limit: 30 }, true, sql);
  assert.equal(result.name.name, title); assert(result.page.records.length > 0 && result.page.records.length < 30, String(result.page.records.length));
  assert.equal(result.structure.annotations.length, result.page.records.length); assert.equal(result.structure.turns.length, result.page.records.length);
  assert.equal(result.page.nextOffset, offset + result.page.records.length); assert.equal(result.page.endOfFile, false);
  assert.equal(result.structure.turns[0].nativeTurnId, turnIds[0]); assert.equal(result.structure.annotations[0].tool.nativeCallId, callIds[0]);
  assert(Buffer.byteLength(JSON.stringify({ records: result.page, structure: result.structure })) <= structured.LIMITS.combinedBytes);
  assert(Buffer.byteLength(JSON.stringify({ records: result.page, structure: result.structure, nativeTitle: result.name.name })) <= structured.LIMITS.publicBytes);
  assert(response.length <= wire.LIMITS.outputBytes);
  // Exercise the real public validator as well as the private parser budget:
  // adding the Host envelope must not turn a valid maximal prefix into an
  // unreadable HTTP DTO or silently truncate its native title/IDs.
  const publicWire = require("../public/modules/codex-history-records"), requestId = "11111111-2222-4333-8444-555555555555";
  const scope = { bindingId: requestId, generation: 1, requestId, profile: publicWire.STRUCTURED_PAGE_PROFILE };
  const history = { kind: "codex_structured_page_source_records", nativeVersion: "0.153.4", nativeThreadId: old.id,
    nativeTitle: result.name.name, page: { offset, limit: 30 }, records: result.page, structure: result.structure,
    sourceAuthenticated: false, publishable: false, semanticHistoryComplete: false,
    authority: { sourceAuthenticated: false, approvalAcknowledged: false, runTerminalObserved: false, resumeAllowed: false } };
  const bound = { kind: "bound_codex_records", bindingId: requestId, generation: 1, requestId, sourceVersion: "a".repeat(64),
    history, sourceAuthenticated: false, publishable: false, cleanupConfirmed: true };
  assert(Buffer.byteLength(JSON.stringify(bound)) <= publicWire.LIMITS.responseBytes);
  assert.equal(publicWire.validBoundRecords(bound, old.id, history.page, scope), true);
});

test("exact payload verification rejects frame/source/profile changes and forged shorter projections", () => {
  const p = prepare();
  for (const change of [j => { j.source.structureProfile = "future"; }, j => { j.source.rollout.recordCount--; }, j => { j.source.validation.recordsValidated--; },
    j => { j.structureFrame.profile = "future"; }, j => { j.structureFrame.byteOffset++; }, j => { j.structureFrame.byteLength++; },
    j => { j.structureFrame.sha256 = "f".repeat(64); }, j => { j.page.records[0].sha256 = "f".repeat(64); }, j => { j.page.nextOffset++; }]) {
    const job = structuredClone(p.job); change(job); assert.equal(wire.readJob(envelope(job, p.bytes)), null);
  }
  for (const index of [0, p.capture.pageBytes.length, p.bytes.length - 1]) {
    const changed = Buffer.from(p.bytes); changed[index] ^= 1; assert.equal(wire.readJob(envelope(p.job, changed)), null);
  }
  for (const change of [r => { r.page.records.pop(); r.structure.annotations.pop(); r.structure.turns = []; r.page.nextOffset--; },
    r => { r.page.nextOffset++; }, r => { r.structure.annotations.pop(); }, r => { r.structure.turns.push(structuredClone(r.structure.turns[0])); },
    r => { r.structure.profile = "future"; }, r => { r.structure.extra = true; }]) {
    const forged = structuredClone(p.result); change(forged);
    const bytes = Buffer.from(JSON.stringify({ protocolVersion: p.job.protocolVersion, nonce: p.job.nonce, result: forged }) + "\n");
    assert.equal(wire.readResponse(bytes, p.job, p.bytes), null);
  }
});

test("names mode validates the selected page and sideband but returns intact name with null page and structure", () => {
  const capture = f.captureFrom(undefined, 0, 1), read = prepare(capture, { mode: "names" }, true);
  assert.equal(read.result.name.name, "原生候選 🐾"); assert.equal(read.result.page, null); assert.equal(read.result.structure, null);
  const bad = f.captureFrom(undefined, 0, 1); bad.structure.annotations[0].recordIndex++;
  bad.structureBytes = Buffer.from(JSON.stringify(bad.structure)); bad.structureFrame.byteLength = bad.structureBytes.length;
  bad.structureFrame.sha256 = old.sha(bad.structureBytes); bad.byteLength = bad.structureFrame.byteOffset + bad.structureBytes.length;
  bad.sha256 = old.sha(f.payload(bad));
  assert.equal(wire.encodeJob(f.job(bad, { mode: "names" }, true), bad), null);
});

test("EOF is empty with full-source counts; oversized single raw row remains an explicit record limit", () => {
  const base = old.structuredCaptured(null), count = base.rolloutBytes.toString().split("\n").length - 1;
  const eof = prepare(f.captureFrom(base, count, 1, { structureProfile: f.PROFILE, totalTurns: count - 1, retainedTurns: count - 1, turns: [], annotations: [] }),
    { mode: "records", offset: count, limit: 1 }).result;
  assert.deepEqual(eof.page.records, []); assert.equal(eof.page.nextOffset, null); assert.equal(eof.page.endOfFile, true);
  assert.equal(eof.structure.totalTurns, count - 1); assert.deepEqual(eof.structure.annotations, []);
  const huge = old.withRollout([{ type: "session_meta", payload: { id: old.id, history_mode: "legacy", cli_version: "0.153.4" } }, "\v".repeat(120000)], null);
  huge.storage = { encoding: "jsonl", rolloutPath: huge.rolloutPath }; huge.checks.rolloutSelectionRechecked = true;
  const capture = f.captureFrom(huge, 1, 1, { structureProfile: f.PROFILE, totalTurns: 0, retainedTurns: 0, turns: [],
    annotations: [annotation(1, "unknown", null, null, ["unknown_record_preserved"])] });
  assert.equal(prepare(capture, { mode: "records", offset: 1, limit: 1 }).result.code, "rollout_record_limit");
});

test("one otherwise-valid record that cannot fit the full named parser envelope reports the structure page limit", () => {
  const nativeName = "\\\"".repeat(10870), index = Buffer.from(JSON.stringify({ id: old.id, thread_name: nativeName, updated_at: "x" }) + "\n");
  const base = old.withRollout([{ type: "session_meta", payload: { id: old.id, history_mode: "legacy", cli_version: "0.153.4" } },
    "\v".repeat(42000)], index);
  base.storage = { encoding: "jsonl", rolloutPath: base.rolloutPath }; base.checks.rolloutSelectionRechecked = true;
  const capture = f.captureFrom(base, 1, 1, { structureProfile: f.PROFILE, totalTurns: 0, retainedTurns: 0, turns: [],
    annotations: [annotation(1, "unknown", null, null, ["unknown_record_preserved"])] });
  const sql = old.sqliteCapture(o => { o.fields.title = ""; o.fields.first_user_message = ""; o.nameContext.preview = "different"; });
  const result = prepare(capture, { mode: "records", offset: 1, limit: 1 }, true, sql).result;
  assert.deepEqual(result, { kind: "source_unavailable", code: "rollout_structure_page_limit" });
});

test("structured named versions bind history and SQLite versions without aliasing old named kinds", () => {
  const capture = f.captureFrom(), history = source.sourceVersion(capture), sqlite = require("../protocol/native/codex/sqlite-wire").context;
  const sqlCapture = old.sqliteCapture(), sqlVersion = sqlite.sourceVersion(sqlCapture, old.namedRequest().sqlite);
  const version = { kind: "codex_named_structured_page_source_version", history, sqlite: sqlVersion };
  assert.equal(wire.sameStructuredNamedVersion(version, structuredClone(version)), true);
  for (const change of [v => { v.kind = "codex_named_page_source_version"; }, v => { v.history.rollout.sha256 = "f".repeat(64); },
    v => { v.sqlite.threadId = "11111111-2222-4333-8444-555555555555"; }, v => { v.extra = true; }]) {
    const other = structuredClone(version); change(other); assert.equal(wire.sameStructuredNamedVersion(version, other), false);
  }
});

test("v1-v8 compatibility stays separate and the restricted worker runs v10 with only fixed code reads", async () => {
  const oldCapture = old.pageCaptured(), oldJob = old.pageJob(oldCapture), oldFrame = wire.encodeJob(oldJob, oldCapture);
  assert.equal(worker.processJob(wire.readJob(oldFrame).job, wire.readJob(oldFrame).bytes).kind, "codex_parsed_page_capture");
  const p = prepare(f.captureFrom(undefined, 4, 2), undefined, true), launch = wire.launchOptions();
  assert(launch.args.includes("--permission")); assert.equal(launch.args.some(v => v.includes(old.root)), false);
  const done = await new Promise((resolve, reject) => {
    const child = spawn(launch.executable, launch.args, launch.options), stdout = [], stderr = [];
    const timer = setTimeout(() => child.kill("SIGKILL"), 10000);
    child.once("error", reject); child.stdout.on("data", v => stdout.push(v)); child.stderr.on("data", v => stderr.push(v));
    child.once("close", (code, signal) => { clearTimeout(timer); resolve({ code, signal, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) }); });
    child.stdin.end(p.encoded);
  });
  assert.equal(done.code, 0, done.stderr.toString()); assert.equal(done.signal, null); assert.equal(done.stderr.length, 0);
  assert.deepEqual(wire.readResponse(done.stdout, p.job, p.bytes), p.result);
});
