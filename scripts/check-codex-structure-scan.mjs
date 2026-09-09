#!/usr/bin/env node
// Pure owned bytes -> pinned Rust example vs existing source-linked JS rules.
// No CLI session, source path, account, network or production service is used.
import assert from "node:assert/strict";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const old = require("../protocol/native/codex/rollout-structure.js");
const { richRecords } = require("../protocol/native/codex/history-fixture.js");
const binary = process.argv[2];
assert.equal(process.argv.length, 3); assert(binary && path.isAbsolute(binary));
const options = { threadId: "01234567-89ab-4def-8123-456789abcdef", nativeVersion: "0.153.4" };
const meta = { type: "session_meta", payload: { id: options.threadId, cli_version: options.nativeVersion, history_mode: "legacy" } };
const event = (type, extra = {}) => ({ type: "event_msg", payload: { type, ...extra } });
const start = turn_id => event("task_started", { turn_id }), end = turn_id => event("task_complete", { turn_id });
const user = message => event("user_message", { message }), answer = message => event("agent_message", { message });
const call = (phase, turn_id = "A", call_id = "call") => event(`exec_command_${phase}`, { turn_id, call_id });
const rollback = num_turns => event("thread_rolled_back", { num_turns });
const cases = [[], [start("A"), user("中文🐾"), user("steer"), answer("complete"), end("A")],
  [user("one"), answer("a"), user("two"), answer("b")],
  [start("A"), call("begin"), end("A"), start("B"), user("B"), call("end"), end("B")],
  [start("A"), call("end", "missing"), end("missing"), event("turn_aborted", { turn_id: "missing" }), user("still A")],
  [start("A"), start("A"), call("end"), end("A"), rollback(1), call("begin"), rollback(1), start("A"), call("end"), end("A")],
  [start("A"), call("begin"), call("end"), call("end"), call("begin"), end("A")],
  [start("A"), call("end"), call("begin"), end("A")],
  [{ type: "compacted", payload: { message: "stored summary" } }, user("same inferred turn")],
  [{ type: "compacted", payload: {} }, event("context_compacted"), user("new inferred turn")],
  [event("agent_message", { message: {} }), event("agent_reasoning", { text: 1 }), start(""), user("valid"), event("agent_reasoning_raw_content", { text: "reasoning" })],
  [start("A"), end("A"), start("B"), event("task_complete", { turn_id: "A", error: { message: "late" } }), event("turn_aborted", { turn_id: "A" }), end("B")],
  [start("A"), { type: "future_record", payload: {} }, event("future_event"), event({ unknown: true }), start("x".repeat(1025)), rollback(-1), call("begin", "A", "")],
  [start("A"), event("task_complete"), event("turn_aborted"), event("task_complete", { turn_id: null }), user("more")],
  richRecords("/owned-never-open"),
];
for (const info of [null, "other", "thread_rollback_failed", "future_error", {}, 1,
  { response_stream_disconnected: { http_status_code: 500 } }, { response_stream_disconnected: { http_status_code: 65536 } },
  { active_turn_not_steerable: { turn_kind: "review" } }, { active_turn_not_steerable: { turn_kind: "unknown" } }])
  cases.push([start("A"), event("error", { message: "stored", codex_error_info: info }), end("A")]);
for (const prefix of ["patch_apply", "mcp_tool_call", "web_search", "image_generation", "collab_agent_spawn", "collab_agent_interaction", "collab_waiting", "collab_close", "collab_resume"]) {
  for (const turn_id of [undefined, "A", "B", "", 1]) cases.push([start("A"), event(`${prefix}_begin`, { turn_id, call_id: "call" }),
    event(`${prefix}_end`, { turn_id, call_id: "call" }), event(`${prefix}_end`, { turn_id, call_id: "call" })]);
}
cases.push([start("A"), event("apply_patch_approval_request", { call_id: "call" }), event("patch_apply_begin", { call_id: "call" }), event("patch_apply_end", { call_id: "call" }),
  event("dynamic_tool_call_response", { call_id: "dyn" }), event("dynamic_tool_call_request", { call_id: "dyn" }), event("view_image_tool_call", { call_id: "view" })]);
for (const id of ["A".repeat(1024), "🐾".repeat(512), "🐾".repeat(513), "bad\u0000", "bad\u0085", null, 0]) cases.push([start(id), call("begin", id, id), call("end", id, id), end(id)]);
let seed = 0x51e7;
const random = n => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % n; };
const mixed = [() => start(["A", "B", "A", ""][random(4)]), () => end(["A", "B", null][random(3)]),
  () => user("owned user"), () => answer("owned answer"), () => call(random(2) ? "begin" : "end", random(2) ? "A" : "B", `c${random(3)}`),
  () => rollback([0, 1, 2, 1000, -1, 0.5][random(6)]), () => event("error", { message: "owned", codex_error_info: ["other", "future", "thread_rollback_failed"][random(3)] }),
  () => event("turn_aborted", random(2) ? {} : { turn_id: "A" }), () => ({ type: "compacted", payload: {} }),
  () => event("item_completed", { turn_id: ["A", "B", "", null][random(4)] }),
  () => ({ type: "response_item", payload: { type: "message", role: "assistant", content: [] } })];
for (let i = 0; i < 96; i++) cases.push(Array.from({ length: 64 }, () => mixed[random(mixed.length)]()));
let selections = 0, reaped = 0;
for (const [caseIndex, rows] of cases.entries()) {
  const rollout = [meta, ...rows].map(v => JSON.stringify(v)).join("\r\n") + "\r\n";
  const source = old.createStructuredRolloutSnapshot(Buffer.from(rollout), options);
  assert.equal(source.kind, "codex_structured_rollout_snapshot", `case ${caseIndex}`);
  try {
    const offsets = [...new Set([0, 1, Math.floor(rows.length / 2), rows.length, rows.length + 1])];
    const pages = offsets.flatMap(offset => [1, 7, 50].map(limit => ({ offset, limit })));
    const env = {}; for (const name of ["SystemRoot", "SYSTEMROOT", "WINDIR"]) if (process.env[name]) env[name] = process.env[name];
    const child = spawnSync(path.resolve(binary), [], { env, input: JSON.stringify({ rollout, pages }), encoding: "utf8", timeout: 5000, maxBuffer: 2 * 1024 * 1024 });
    assert.equal(child.error, undefined, `case ${caseIndex}`); assert.equal(child.signal, null); assert.equal(child.status, 0); reaped++;
    const results = JSON.parse(child.stdout); assert.equal(results.length, pages.length);
    for (const [i, selection] of pages.entries()) {
      const expected = old.readStructuredRolloutPage(source, { snapshotId: source.snapshotId, ...selection }), actual = results[i];
      assert.equal(actual.error, undefined, `case ${caseIndex}/${i}`);
      assert.equal(actual.structure.structureProfile, "codex_legacy_selected_structure_v1");
      const { structureProfile, ...data } = actual.structure;
      assert.deepEqual(data, { totalTurns: expected.totalTurns, retainedTurns: expected.retainedTurns, turns: expected.turns, annotations: expected.annotations }, `case ${caseIndex}/${i}`);
      assert.deepEqual(actual.records, expected.records.records.map(({ recordIndex, rawText }) => ({ recordIndex, rawText })));
      assert.equal(actual.nextOffset, expected.records.nextOffset); assert.equal(actual.validation.recordsValidated, rows.length + 1); selections++;
    }
  } finally { assert.equal(old.releaseStructuredRolloutSnapshot(source), true); }
}
console.log(JSON.stringify({ gate: "owned_codex_structure_differential", cases: cases.length, selections, reaped,
  fullSourceTurnsToolsRollback: true, rawBytesExact: true, privateHistoryReads: 0, modelCalls: 0, sourceAuthenticated: false }));
