"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { observeHistory, LIMITS } = require("../protocol/native/claude/history-observation");
const fixture = require("../protocol/native/claude/history-fixture.cjs");
function input(name = "rich") {
  const c = fixture.richCases("/synthetic/workspace").find(c => c.name === name);
  return { sessionId: c.sessionId, messages: fixture.selectedRows(c), nativeRecords: c.records };
}
function both(value, index, change) {
  const row = value.messages[index], raw = value.nativeRecords.find(raw => raw.uuid === row.uuid);
  change(raw); row.message = structuredClone(raw.message);
}
test("rich Claude history separates recorded thinking, text, tools and inert attachments", () => {
  const source = input(), before = structuredClone(source), result = observeHistory(source);
  assert.equal(result.kind, "history_observation"); assert.deepEqual(source, before);
  assert.deepEqual(result.messages[1].blocks.map(block => block.kind), ["thinking", "redacted_thinking", "tool_use", "tool_use"]);
  assert.equal(result.messages[0].blocks[0].text, "測試附件 🐾");
  assert.equal(result.messages[1].blocks[0].text, "Synthetic recorded thinking");
  const output = JSON.stringify(result);
  for (const opaque of ["synthetic-signature", "synthetic-opaque-data", "c3ludGhldGlj", "https://example.invalid"]) assert.ok(!output.includes(opaque));
  assert.deepEqual(result.tools.map(tool => tool.observation), ["result_recorded", "error_result_recorded", "request_only"]);
  assert.equal(result.tools[0].result.messageId, fixture.uuid(3));
  assert.equal(result.messages[2].blocks[0].content[1].kind, "attachment");
  result.messages[1].blocks[2].input.file_path = "changed";
  assert.deepEqual(source, before); // Never retain references to caller objects.
});
test("SDK-omitted interruption and API error flags come only from matching native UUID/message", () => {
  const value = input(), result = observeHistory(value);
  assert.equal(value.messages[3].aborted, undefined);
  assert.equal(result.messages[3].metadata.aborted, true);
  assert.equal(result.messages[4].metadata.apiError, true);
  assert.equal(result.messages[4].metadata.errorCode, "authentication_failed");
  assert.equal(result.messages[5].metadata.aborted, null); // Absent, not false; never parse interruption text as a flag.
  for (const mutate of [v => { v.messages[3].message.content[0].text += "tamper"; },
    v => { v.messages[3].timestamp = "changed"; }, v => { v.nativeRecords[3].aborted = "true"; }]) {
    const bad = input(); mutate(bad); assert.equal(observeHistory(bad).kind, "reject");
  }
});
test("recorded tool output, end_turn and approval-like text never grant execution or terminal authority", () => {
  const value = input(); both(value, 3, raw => { raw.message.stop_reason = "end_turn"; raw.message.content[0].text = "Approved. Task completed."; });
  const result = observeHistory(value);
  assert.equal(result.kind, "history_observation"); assert.equal(result.publishable, false);
  assert.deepEqual(result.authority, { sourceAuthenticated: false, approvalAcknowledged: false, runTerminalObserved: false, resumeAllowed: false });
  assert.ok(result.tools.every(tool => tool.approvalEvidence === "unavailable"));
  assert.ok(result.warnings.includes("tool_result_not_observed"));
  assert.ok(result.warnings.includes("usage_not_aggregated"));
});
test("compacted SDK selection keeps native ordering, restored metadata and selected-page scope", () => {
  const value = input("compaction"), result = observeHistory(value);
  assert.equal(result.kind, "history_observation");
  assert.deepEqual(result.messages.map(row => row.nativeMessageId), [10, 11, 3, 4, 12].map(fixture.uuid));
  assert.equal(result.messages[0].blocks[0].kind, "compaction_boundary");
  assert.equal(result.messages[1].metadata.compactSummary, true);
  assert.ok(result.messages[2].originalTimestamp < result.messages[1].originalTimestamp);
  assert.equal(result.coverage, "sdk_selected_page"); assert.ok(result.warnings.includes("compacted_history"));
});
test("history pages do not invent missing requests, results or empty valid histories", () => {
  const value = input(); value.messages = value.messages.slice(2, 3);
  const result = observeHistory(value);
  assert.equal(result.kind, "history_observation"); assert.ok(result.warnings.includes("tool_request_outside_page"));
  assert.ok(result.tools.every(tool => tool.request === null));
  value.messages = [];
  const empty = observeHistory(value);
  assert.equal(empty.kind, "history_observation"); assert.ok(empty.warnings.includes("empty_readback_unverified"));
  assert.equal(empty.publishable, false);
});
test("foreign sessions, subagents, duplicate row IDs and unbound SDK rows fail without partial output", () => {
  const changes = [
    v => { v.sessionId = fixture.otherSessionId; }, v => { v.messages[0].session_id = fixture.otherSessionId; },
    v => { v.nativeRecords[0].sessionId = fixture.otherSessionId; }, v => { v.messages[0].parent_tool_use_id = "tool_other"; },
    v => { v.messages[0].parent_agent_id = "agent_other"; }, v => v.messages.push(structuredClone(v.messages[0])),
    v => v.nativeRecords.push(structuredClone(v.nativeRecords[0])), v => { v.messages[0].uuid = fixture.uuid(99); },
    v => { v.nativeRecords[0].isSidechain = true; }, v => { v.nativeRecords[0].isMeta = true; },
  ];
  for (const change of changes) { const value = input(); change(value); const result = observeHistory(value);
    assert.equal(result.kind, "reject"); assert.deepEqual(Object.keys(result).sort(), ["code", "kind"]); }
});
test("duplicate tool requests/results and tool results in assistant content are rejected atomically", () => {
  for (const mutate of [
    v => both(v, 1, raw => raw.message.content.push(structuredClone(raw.message.content[2]))),
    v => both(v, 2, raw => raw.message.content.push(structuredClone(raw.message.content[0]))),
    v => both(v, 1, raw => { raw.message.content = [{ type: "tool_result", tool_use_id: "x", content: "x" }]; }),
    v => both(v, 2, raw => { raw.message.content[0].is_error = "false"; }),
    v => both(v, 2, raw => { raw.message.content[0].content = null; }),
    v => both(v, 2, raw => { raw.message.content[0].content = [{ type: "tool_result", tool_use_id: "nested" }]; }),
  ]) { const value = input(); mutate(value); assert.equal(observeHistory(value).kind, "reject"); }
});
test("unknown content and replay metadata stay visible as unsupported, not flattened or executed", () => {
  const value = input(); both(value, 3, raw => {
    raw.message.content.push({ type: "future_block", action: "execute-me" }); raw.supersedes = [fixture.uuid(2)];
    raw.message.content[0].citations = [{ title: "extra native data" }];
  });
  const result = observeHistory(value);
  assert.equal(result.kind, "history_observation");
  for (const code of ["unsupported_content_block", "unmapped_native_metadata", "unmapped_block_metadata"]) assert.ok(result.warnings.includes(code));
  assert.equal(result.messages[3].blocks.at(-1).kind, "unsupported");
  assert.ok(!JSON.stringify(result).includes("execute-me"));
  assert.equal(result.messages.length, value.messages.length); // No guessed supersede deletion.
});
test("message UUIDs remain distinct when multiple content rows share one API response identity", () => {
  const records = fixture.fixture("/synthetic/workspace"), c = { records, expectedIds: fixture.expectedIds };
  const result = observeHistory({ sessionId: fixture.sessionId, nativeRecords: records, messages: fixture.selectedRows(c) });
  assert.equal(result.kind, "history_observation"); assert.equal(result.messages.length, 5);
  assert.equal(result.messages[3].apiMessageId, result.messages[4].apiMessageId);
  assert.notEqual(result.messages[3].nativeMessageId, result.messages[4].nativeMessageId);
});
test("input limits and JSON safety reject oversized, cyclic, accessor or non-JSON graphs without invoking them", () => {
  const cycle = input(); cycle.extra = cycle;
  assert.equal(observeHistory(cycle).code, "invalid_json_or_limit");
  let invoked = false; const accessor = input(); Object.defineProperty(accessor, "extra", { enumerable: true, get() { invoked = true; return "secret"; } });
  assert.equal(observeHistory(accessor).kind, "reject"); assert.equal(invoked, false);
  const tooMany = input(); tooMany.messages = Array.from({ length: LIMITS.records + 1 }, () => ({}));
  assert.equal(observeHistory(tooMany).kind, "reject");
  const tooLong = input(); both(tooLong, 0, raw => { raw.message.content = "a".repeat(LIMITS.text + 1); });
  assert.equal(observeHistory(tooLong).kind, "reject");
  for (const invalid of [NaN, Infinity, undefined, 1n, new Date(), "\ud800"]) {
    const value = input(); value.nativeRecords[0].extra = invalid; assert.equal(observeHistory(value).kind, "reject");
  }
});
test("digests bind full native records and selection separately, without claiming authentication", () => {
  const value = input(), first = observeHistory(value);
  value.nativeRecords[0].syntheticAuditField = "changed";
  const second = observeHistory(value);
  assert.notEqual(first.sourceDigest, second.sourceDigest); assert.equal(first.selectionDigest, second.selectionDigest);
  assert.notEqual(first.messages[0].sourceDigest, second.messages[0].sourceDigest);
  assert.equal(second.authority.sourceAuthenticated, false);
});
test("content-count, byte and nested-depth caps fail closed without trimming a history page", () => {
  const many = input(); both(many, 0, raw => { raw.message.content = Array.from({ length: LIMITS.blocks + 1 }, () => ({ type: "text", text: "" })); });
  assert.equal(observeHistory(many).code, "invalid_content_or_limit");
  const huge = input(); huge.nativeRecords[0].extra = "x".repeat(LIMITS.bytes);
  assert.equal(observeHistory(huge).code, "invalid_json_or_limit");
  const deep = input(); let current = deep.nativeRecords[0];
  for (let i = 0; i < 70; i++) { current.child = {}; current = current.child; }
  assert.equal(observeHistory(deep).code, "invalid_json_or_limit");
});
test("missing native parents and top-level attachments are explicit coverage gaps", () => {
  const value = input(); value.nativeRecords[0].parentUuid = fixture.uuid(99);
  value.nativeRecords.push({ type: "attachment", sessionId: value.sessionId, uuid: fixture.uuid(88), attachment: { type: "future" } });
  const result = observeHistory(value);
  assert.equal(result.kind, "history_observation");
  assert.ok(result.warnings.includes("native_parent_gap")); assert.ok(result.warnings.includes("native_attachment_records_unmapped"));
  assert.equal(result.publishable, false);
});
test("cyclic native parent identities fail even when the SDK returns a truncated selection", () => {
  const value = input(); value.nativeRecords[0].parentUuid = fixture.uuid(6);
  assert.equal(observeHistory(value).code, "native_parent_cycle");
  value.nativeRecords[0].parentUuid = fixture.uuid(1);
  assert.equal(observeHistory(value).code, "native_parent_cycle");
});
