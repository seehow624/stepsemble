"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), crypto = require("node:crypto");
const { createStructuredRolloutSnapshot: create, readStructuredRolloutPage: readPage, releaseStructuredRolloutSnapshot: release, LIMITS } = require("../protocol/native/codex/rollout-structure");
const { richRecords } = require("../protocol/native/codex/history-fixture");
const options = { nativeVersion: "0.153.4", threadId: "01234567-89ab-4def-8123-456789abcdef" };
const meta = () => ({ type: "session_meta", payload: { id: options.threadId, cli_version: options.nativeVersion, history_mode: "legacy" } });
const event = (type, values = {}) => ({ type: "event_msg", payload: { type, ...values } });
const start = id => event("task_started", { turn_id: id }), end = id => event("task_complete", { turn_id: id });
const user = message => event("user_message", { message }), agent = message => event("agent_message", { message });
const command = (phase, turn = "A", call = "call") => event(`exec_command_${phase}`, { turn_id: turn, call_id: call, command: ["never-execute"], stdout: "stored" });
const bytes = rows => Buffer.from([meta(), ...rows].map(r => JSON.stringify(r)).join("\r\n") + "\r\n");
const read = (snapshot, offset = 0, limit = 50) => readPage(snapshot, { snapshotId: snapshot.snapshotId, offset, limit });
function snapshot(t, rows) {
  const value = create(bytes(rows), options); assert.equal(value.kind, "codex_structured_rollout_snapshot"); t.after(() => release(value)); return value;
}
function collect(s, limit = 50) {
  const records = [], annotations = [], turns = new Map(); let offset = 0, pages = 0;
  do {
    const p = read(s, offset, limit); assert.equal(p.kind, "codex_structured_rollout_records");
    assert(Buffer.byteLength(JSON.stringify(p)) <= LIMITS.pageBytes);
    assert.deepEqual(p.annotations.map(a => a.recordIndex), p.records.records.map(r => r.recordIndex));
    records.push(...p.records.records); annotations.push(...p.annotations); for (const turn of p.turns) turns.set(turn.turnKey, turn);
    offset = p.records.nextOffset; pages++;
  } while (offset !== null);
  return { records, annotations, turns: [...turns.values()], pages };
}
test("structure links explicit turns, steering, recorded completion and all raw CRLF bytes without native authority", t => {
  const rows = [start("A"), user("原文🐾"), user("同回合補充"), agent("回答"), end("A")];
  const s = snapshot(t, rows), p = collect(s, 2);
  assert.equal(s.totalTurns, 1); assert.equal(p.turns[0].nativeTurnId, "A"); assert.equal(p.turns[0].boundary, "explicit");
  assert.equal(p.turns[0].recordedStatus, "completed"); assert.equal(p.turns[0].statusRecordIndex, 5);
  assert.deepEqual(p.annotations.map(a => a.kind), ["metadata", "lifecycle", "user", "user", "assistant", "lifecycle"]);
  assert.equal(p.records.map(r => r.rawText).join(""), bytes(rows).toString());
  assert.equal(s.sha256, crypto.createHash("sha256").update(bytes(rows)).digest("hex"));
  for (const flag of ["sourceAuthenticated", "publishable", "semanticHistoryComplete"]) assert.equal(read(s)[flag], false);
  assert.equal(read(s).executable, false); assert.equal(Object.isFrozen(s), true);
});
test("implicit boundaries have source keys, not fabricated native IDs or success states", t => {
  const s = snapshot(t, [user("one"), agent("answer"), user("two"), agent("answer")]), p = collect(s);
  assert.deepEqual(p.turns.map(r => [r.turnKey, r.nativeTurnId, r.boundary, r.recordedStatus]),
    [["record-1", null, "inferred", "unknown"], ["record-3", null, "inferred", "unknown"]]);
});
test("late command completion stays with the original turn, even across pages and a newer active turn", t => {
  const s = snapshot(t, [start("A"), command("begin"), end("A"), start("B"), user("B"), command("end"), end("B")]), p = collect(s, 2);
  assert.equal(p.annotations[2].tool.relatedRecordIndex, 6); assert.equal(p.annotations[6].tool.relatedRecordIndex, 2);
  assert.equal(p.annotations[6].turnKey, p.annotations[1].turnKey); assert.notEqual(p.annotations[6].turnKey, p.annotations[4].turnKey);
  assert.deepEqual(p.turns.map(r => r.recordedStatus), ["completed", "completed"]);
});
test("unknown explicit turn IDs cannot attach tools or close an unrelated active turn", t => {
  const s = snapshot(t, [start("A"), command("end", "missing"), end("missing"), event("turn_aborted", { turn_id: "missing" }), user("still A")]), p = collect(s);
  assert.equal(p.turns[0].recordedStatus, "started");
  for (const i of [2, 3, 4]) { assert.equal(p.annotations[i].turnKey, null); assert.deepEqual(p.annotations[i].warnings, ["unmatched_turn_reference"]); }
  assert.equal(p.annotations[5].turnKey, "record-1");
});
test("duplicate active native turn IDs are ambiguous, while rolled-back IDs may be reused without reviving old records", t => {
  const s = snapshot(t, [start("A"), start("A"), command("end"), end("A"), event("thread_rolled_back", { num_turns: 2 }), start("A"), command("begin"), command("end"), end("A")]), p = collect(s);
  assert.equal(p.annotations[3].turnKey, null); assert(p.annotations[3].warnings.includes("ambiguous_turn_reference"));
  assert.equal(p.annotations[8].turnKey, "record-6"); assert.equal(p.annotations[8].tool.relatedRecordIndex, 7);
  assert.deepEqual(p.turns.map(r => r.branchState), ["rolled_back", "rolled_back", "retained"]); assert.equal(s.retainedTurns, 1);
});
test("rollback marks source-linked turns without deleting original records and cannot resurrect a retired tool", t => {
  const rows = [start("A"), command("begin"), end("A"), start("B"), end("B"), event("thread_rolled_back", { num_turns: 2 }), command("end"), start("C"), user("kept")];
  const s = snapshot(t, rows), p = collect(s, 1);
  assert.equal(p.records.map(r => r.rawText).join(""), bytes(rows).toString()); assert.equal(p.turns.length, 3);
  for (const turn of p.turns.slice(0, 2)) { assert.equal(turn.branchState, "rolled_back"); assert.equal(turn.rollbackRecordIndex, 6); }
  assert.equal(p.annotations[7].turnKey, null); assert.equal(p.annotations[2].tool.relatedRecordIndex, null);
});
test("tool associations isolate family and turn; duplicate begin or end invalidates every claimed pair", t => {
  const s = snapshot(t, [start("A"), command("begin"), command("end"), command("end"),
    event("mcp_tool_call_begin", { call_id: "call" }), event("mcp_tool_call_end", { call_id: "call" }), end("A"),
    start("B"), command("begin", "B"), command("end", "B")]), p = collect(s);
  for (const i of [2, 3, 4]) { assert.equal(p.annotations[i].tool.relatedRecordIndex, null); assert(p.annotations[i].warnings.includes("ambiguous_tool_reference")); }
  assert.equal(p.annotations[5].tool.relatedRecordIndex, 6); assert.equal(p.annotations[9].tool.relatedRecordIndex, 10);
});
test("patch approval records are requests only; they do not become approval receipts or tool completions", t => {
  const s = snapshot(t, [start("A"), event("apply_patch_approval_request", { turn_id: "A", call_id: "patch", auto_approved: true }),
    event("patch_apply_begin", { turn_id: "A", call_id: "patch" }), event("patch_apply_end", { turn_id: "A", call_id: "patch", status: "declined" })]), p = collect(s);
  assert.equal(p.annotations[2].tool.phase, "request"); assert.equal(p.annotations[2].tool.relatedRecordIndex, null);
  assert.equal(p.annotations[3].tool.relatedRecordIndex, 4); assert.equal(read(s).executable, false);
  assert.equal(Object.hasOwn(p.annotations[2], "approved"), false);
});
test("all stored rich records survive, including command/image omitted by native legacy projection", t => {
  const rows = richRecords("/owned-never-read"); const s = snapshot(t, rows), p = collect(s, 3);
  assert.equal(p.records.length, 16); assert.equal(p.records.map(r => r.rawText).join(""), bytes(rows).toString());
  assert.equal(p.annotations.filter(r => r.kind === "tool").length, 7);
  assert.equal(p.annotations.filter(r => r.kind === "model_context").length, 2);
  assert.equal(p.annotations.find(r => r.tool?.family === "command" && r.tool.phase === "begin").tool.relatedRecordIndex, 6);
  assert(p.annotations.some(r => r.tool?.family === "image_view"));
});
test("model context is retained but is not duplicated as a second visible user or assistant message", t => {
  const s = snapshot(t, [start("A"), user("same"), { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "same" }] } }, agent("same")]), p = collect(s);
  assert.equal(p.records.length, 5); assert.equal(p.annotations[3].kind, "model_context"); assert.equal(p.annotations.filter(a => a.kind === "user").length, 1);
});
test("compaction-only implicit boundary stays with the following user; a tool or visible compaction breaks that exception", t => {
  const compacted = { type: "compacted", payload: { message: "summary" } };
  const a = snapshot(t, [compacted, user("same turn")]), b = snapshot(t, [compacted, event("mcp_tool_call_begin", { call_id: "tool" }), user("new turn")]);
  const c = snapshot(t, [compacted, event("context_compacted"), user("new turn")]);
  assert.equal(a.totalTurns, 1); assert.equal(b.totalTurns, 2); assert.equal(c.totalTurns, 2);
});
test("recorded errors preserve failure across completion, while non-status errors leave the active turn alone", t => {
  for (const info of [null, "other", { response_stream_disconnected: { http_status_code: 500 } }]) {
    const s = snapshot(t, [start("A"), event("error", { message: "stored error", codex_error_info: info }), end("A")]);
    assert.equal(collect(s).turns[0].recordedStatus, "failed");
  }
  for (const info of ["thread_rollback_failed", { active_turn_not_steerable: { turn_kind: "review" } }]) {
    const s = snapshot(t, [start("A"), event("error", { message: "not terminal", codex_error_info: info }), end("A")]);
    assert.equal(collect(s).turns[0].recordedStatus, "completed");
  }
});
test("late terminal error and abort target their original turn; unknown error data cannot be upgraded to success", t => {
  const s = snapshot(t, [start("A"), end("A"), start("B"), event("task_complete", { turn_id: "A", error: { message: "late error" } }),
    event("turn_aborted", { turn_id: "A" }), event("error", { message: "unknown", codex_error_info: "future_error" }), end("B")]);
  const p = collect(s); assert.deepEqual(p.turns.map(t => t.recordedStatus), ["interrupted", "unknown"]);
  assert(p.annotations[7].warnings.includes("unclassified_error_preserved"));
});
test("unknown records, malformed references and unusual payload types remain raw and never execute coercion", t => {
  const s = snapshot(t, [start("A"), { type: "future_record", payload: { html: "<script>never()</script>", path: "https://never-fetch.invalid" } },
    event("future_event", { command: "never execute" }), event({ toString: "never" }),
    event("task_started", { turn_id: "x".repeat(1025) }), event("thread_rolled_back", { num_turns: -1 }), command("begin", "A", "")]);
  const p = collect(s); assert.equal(p.records.length, 8); assert.equal(p.annotations[2].kind, "unknown"); assert.equal(p.annotations[4].kind, "unknown");
  assert.equal(p.turns[0].recordedStatus, "started"); assert.deepEqual(p.annotations[7].warnings, ["invalid_tool_reference"]);
});
test("one-page output budget shrinks pages without omissions, truncation or broken source offsets", t => {
  const s = snapshot(t, [start("A"), ...Array.from({ length: 15 }, (_, i) => agent(`${i}:` + "🐾".repeat(20000))), end("A")]);
  const p = collect(s); assert(p.pages > 1); assert.equal(p.records.length, s.recordCount);
  let offset = 0; for (const row of p.records) { assert.equal(row.byteOffset, offset); offset += row.byteLength; } assert.equal(offset, s.byteLength);
});
test("returned structures are detached, snapshots are source-specific, and release is irreversible", t => {
  const a = snapshot(t, [start("A"), user("source")]), b = snapshot(t, [start("A"), user("source")]);
  const p = read(a); p.turns[0].nativeTurnId = "changed"; p.annotations[1].warnings.push("fake"); p.records.records[1].rawText = "changed";
  assert.equal(read(a).turns[0].nativeTurnId, "A"); assert.deepEqual(read(a).annotations[1].warnings, []);
  assert.equal(readPage(a, { snapshotId: b.snapshotId, offset: 0, limit: 5 }).code, "rollout_snapshot_changed");
  assert.equal(read({ ...a }).code, "rollout_snapshot_unavailable"); assert.equal(release(a), true); assert.equal(release(a), false);
  assert.equal(read(a).code, "rollout_snapshot_unavailable"); assert.equal(read(b).kind, "codex_structured_rollout_records");
});
test("source format/version, framing and selection gates apply before any structural result", () => {
  const source = bytes([]);
  for (const [data, opts] of [[source.subarray(0, -1), options], [Buffer.from(source.toString().replace("0.153.4", "0.153.3")), options],
    [Buffer.from(source.toString().replace("legacy", "paginated")), options], [source, { ...options, nativeVersion: "future" }],
    [Buffer.alloc(8 * 1024 * 1024 + 1), options]]) assert.equal(create(data, opts).kind, "codex_history_unavailable");
});
test("caller getters and malformed page selections cannot execute or disclose partial structure", t => {
  const s = snapshot(t, [start("A")]); let calls = 0;
  const opts = { ...options }; Object.defineProperty(opts, "threadId", { enumerable: true, get() { calls++; return options.threadId; } });
  assert.equal(create(bytes([]), opts).kind, "codex_history_unavailable");
  assert.equal(readPage(s, { snapshotId: s.snapshotId, offset: 0, get limit() { calls++; return 1; } }).kind, "codex_history_unavailable");
  for (const extra of [{ limit: 0 }, { limit: 51 }, { offset: -1 }, { offset: 0.5 }, { extra: true }])
    assert.equal(readPage(s, { snapshotId: s.snapshotId, offset: 0, limit: 2, ...extra }).kind, "codex_history_unavailable");
  assert.equal(calls, 0); assert.deepEqual(read(s, s.recordCount).annotations, []);
});
test("malformed messages stay raw without inventing a boundary; invalid Unicode still fails the original JSON gate", t => {
  const rows = [event("agent_message", { message: {} }), event("agent_reasoning", { text: 1 }), start(""), user("real"),
    event("agent_reasoning_raw_content", { text: "stored reasoning" }), agent("answer")];
  const s = snapshot(t, rows), p = collect(s);
  assert.equal(s.totalTurns, 1); assert.equal(p.turns[0].turnKey, "record-4");
  for (const i of [1, 2]) { assert.equal(p.annotations[i].turnKey, null); assert.deepEqual(p.annotations[i].warnings, ["invalid_message_preserved"]); }
  assert.deepEqual(p.annotations[3].warnings, ["invalid_turn_reference"]);
  assert.equal(p.records.map(r => r.rawText).join(""), bytes(rows).toString());
  assert.equal(create(bytes([start(String.fromCharCode(55296))]), options).code, "rollout_invalid_record");
});
