"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const recovery = require("../public/modules/pi-recovery");
const { activePathIds } = require("../server/stream-safety");
const vm = require("node:vm");
const error = (timestamp = 1) => ({ role: "assistant", timestamp, stopReason: "error", errorMessage: "WebSocket closed 1000", content: [{ type: "text", text: "Incomplete draft" }] });
const answer = (timestamp = 2) => ({ role: "assistant", timestamp, stopReason: "stop", content: [{ type: "text", text: "Normal answer" }] });
function episode(sequenced = false) {
  const owner = {}, state = recovery.create(owner);
  let nextSequence = 0;
  const send = (event, sequence = sequenced ? ++nextSequence : null) => recovery.update(state, event, owner, sequence);
  send({ type: "agent_start" });
  return { state, owner, send };
}
function interrupted(send, message = error()) {
  send({ type: "message_start", message }); send({ type: "message_end", message });
}
function retry(send, attempt = 1) {
  send({ type: "auto_retry_start", attempt });
  send({ type: "agent_end", messages: [error()], willRetry: true });
  send({ type: "agent_start" });
}
test("pi-recovery: error → willRetry → Pi retry → authoritative success → settled preserves raw errors", () => {
  const { state, send } = episode(), message = error(); interrupted(send, message); retry(send);
  assert.equal(state.failures[0].status, "interrupted");
  send({ type: "message_start", message: answer() });
  send({ type: "message_end", message: answer() });
  assert.equal(state.failures[0].status, "interrupted", "an answer alone is not retry authority");
  send({ type: "auto_retry_end", attempt: 1, success: true });
  assert.equal(state.failures[0].status, "recovered"); assert.equal(state.lastFailure, null);
  send({ type: "agent_settled" }); assert.equal(state.closed, true);
  assert.equal(message.errorMessage, "WebSocket closed 1000"); assert.equal(message.stopReason, "error");
});
test("pi-recovery: duplicate identified attempt snapshots are idempotent", () => {
  const { state, send } = episode(), message = error(); interrupted(send, message);
  assert.equal(send({ type: "message_end", message: { ...message } }), false);
  assert.equal(state.failures.length, 1);
});
test("pi-recovery: both Pi success/message_end orderings work, but never success signal alone", () => {
  const { state, send } = episode(); interrupted(send); retry(send);
  send({ type: "auto_retry_end", attempt: 1, success: true });
  assert.equal(state.failures[0].status, "interrupted");
  send({ type: "message_start", message: answer() }); send({ type: "message_end", message: answer() });
  assert.equal(state.failures[0].status, "recovered");
});
test("pi-recovery: length-limited retry cannot resurrect an old transport failure or claim full recovery", () => {
  for (const successFirst of [false, true]) {
    const { state, send } = episode(), original = error(); interrupted(send, original); retry(send);
    const truncated = { ...answer(), stopReason: "length" };
    if (successFirst) send({ type: "auto_retry_end", attempt: 1, success: true });
    send({ type: "message_start", message: truncated }); send({ type: "message_end", message: truncated });
    if (!successFirst) send({ type: "auto_retry_end", attempt: 1, success: true });
    assert.equal(state.lastFailure, null, "the earlier WebSocket error is not the latest terminal outcome");
    assert.equal(state.continuing, false);
    assert.equal(state.failures[0].status, "historical", "a truncated reply does not prove complete recovery");
    send({ type: "agent_end", messages: [truncated], willRetry: false });
    send({ type: "agent_settled" });
    assert.equal(state.lastFailure, null); assert.equal(state.closed, true);
    assert.equal(state.failures[0].status, "historical");
    assert.equal(original.stopReason, "error"); assert.equal(original.errorMessage, "WebSocket closed 1000");
    assert.equal(truncated.stopReason, "length");
  }
});
test("pi-recovery: reconnect can show retry with missing history", () => {
  const reconnect = episode();
  assert.equal(reconnect.send({ type: "auto_retry_start", attempt: 2 }), true);
  assert.equal(reconnect.state.continuing, true);
  assert.deepEqual(reconnect.state.failures, []);
});
function nativeClockReply(stopReason, content = [], clock = 100) {
  return { role: "assistant", api: "openai-codex-responses", provider: "openai-codex", model: "owned-clock-fixture",
    timestamp: clock, stopReason, content, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
}
test("pi-recovery: ordered no-ID replies sharing a timestamp retain every authoritative end", () => {
  const { state, send } = episode();
  const start = nativeClockReply("pending");
  const first = nativeClockReply("toolUse", [{ type: "toolCall", id: "clock-tool", name: "noop", arguments: {} }]);
  const final = nativeClockReply("stop", [{ type: "text", text: "Same-clock final answer" }]);
  send({ type: "message_start", message: start });
  assert.equal(send({ type: "message_end", message: first }), true);
  send({ type: "message_end", message: { role: "toolResult", timestamp: 100, toolCallId: "clock-tool", toolName: "noop", content: [], isError: false } });
  send({ type: "message_start", message: { ...start } });
  assert.equal(send({ type: "message_end", message: final }), true, "request-start wall clock is not a unique identity");
  assert.equal(send({ type: "message_end", message: { ...final } }), false, "duplicate end within the same generation stays idempotent");
  send({ type: "message_start", message: { ...start } });
  assert.equal(send({ type: "message_end", message: { ...final } }), true, "even an identical cached reply is new after its own start");
  assert.deepEqual(state.lastMessage, final, "the accepted snapshot is retained without mutation");
});
test("pi-recovery: same-clock retry generations recover without inventing a timestamp identity", () => {
  const { state, send } = episode();
  const start = nativeClockReply("pending"), failed = { ...nativeClockReply("error"), errorMessage: "WebSocket closed 1000" };
  send({ type: "message_start", message: start }); send({ type: "message_end", message: failed });
  send({ type: "agent_end", messages: [failed], willRetry: true });
  send({ type: "auto_retry_start", attempt: 1 }); send({ type: "agent_start" });
  send({ type: "message_start", message: { ...start } });
  const final = nativeClockReply("stop", [{ type: "text", text: "Same-clock retry answer" }]);
  assert.equal(send({ type: "message_end", message: final }), true);
  send({ type: "auto_retry_end", attempt: 1, success: true });
  assert.equal(state.failures[0].status, "recovered"); assert.equal(state.lastFailure, null);
  send({ type: "agent_end", messages: [final], willRetry: false }); send({ type: "agent_settled" });
  assert.equal(state.closed, true); assert.equal(failed.stopReason, "error");
});
test("pi-recovery: positive response identity and current stream pairing still reject stale snapshots", () => {
  const { send } = episode();
  const start = { ...nativeClockReply("pending"), responseId: "current-response" };
  send({ type: "message_start", message: start });
  assert.equal(send({ type: "message_end", message: { ...nativeClockReply("error"), responseId: "old-response", errorMessage: "old failure" } }), false);
  assert.equal(send({ type: "message_end", message: { ...nativeClockReply("stop", [], 99), responseId: "current-response" } }), false);
  assert.equal(send({ type: "message_end", message: { ...nativeClockReply("stop", [{ type: "text", text: "Current" }]), responseId: "current-response" } }), true);
});
test("pi-recovery: browser readiness waits for declaration without hiding a missing composer", async () => {
  const { piRecoveryPaneReady } = await import("../scripts/pi-recovery-browser-cases.mjs");
  const expression = "(" + piRecoveryPaneReady.toString() + ")()";
  const context = vm.createContext({ document: { querySelector: () => ({ disabled: false }) } });
  assert.equal(vm.runInContext(expression, context), false);
  context.rpc = { sid: "owned" }; assert.equal(vm.runInContext(expression, context), true);
  context.document.querySelector = () => ({ disabled: true }); assert.equal(vm.runInContext(expression, context), false);
  context.document.querySelector = () => null; assert.throws(() => vm.runInContext(expression, context), /disabled/, "genuine missing controls are not silently accepted");
});
test("pi-recovery: terminal error without retry and exhaustion stay failed", () => {
  for (const exhausted of [false, true]) {
    const { state, send } = episode(); interrupted(send);
    if (exhausted) {
      retry(send); interrupted(send, error(2));
      send({ type: "auto_retry_end", attempt: 1, success: false, finalError: "exhausted" });
    }
    send({ type: "agent_end", messages: [error(exhausted ? 2 : 1)], willRetry: false });
    send({ type: "agent_settled" });
    assert.equal(state.lastFailure.stopReason, "error");
    assert(state.failures.every(record => record.status === "failed"));
  }
});
test("pi-recovery: cancellation during backoff is stopped, raw error remains error", () => {
  const { state, send } = episode(), message = error(); interrupted(send, message);
  send({ type: "auto_retry_start", attempt: 1 });
  send({ type: "auto_retry_end", attempt: 1, success: false, finalError: "Retry cancelled" });
  send({ type: "agent_end", messages: [message], willRetry: false });
  assert.equal(state.lastFailure.stopReason, "aborted"); assert.equal(state.failures[0].status, "stopped");
  assert.equal(message.stopReason, "error");
});
test("pi-recovery: aborted reply cannot recover even when Pi calls auto_retry_end successful", () => {
  for (const successFirst of [true, false]) {
    const { state, send } = episode(); interrupted(send); retry(send);
    const aborted = { ...answer(), stopReason: "aborted" };
    if (successFirst) send({ type: "auto_retry_end", attempt: 1, success: true });
    send({ type: "message_start", message: aborted }); send({ type: "message_end", message: aborted });
    if (!successFirst) send({ type: "auto_retry_end", attempt: 1, success: true });
    send({ type: "agent_end", messages: [aborted], willRetry: false });
    assert.equal(state.lastFailure.stopReason, "aborted");
    assert(!state.failures.some(record => record.status === "recovered"));
  }
});
test("pi-recovery: multiple attempts survive; stale retry success cannot recover the newer failure", () => {
  const { state, send } = episode(); interrupted(send); retry(send);
  interrupted(send, error(2)); send({ type: "auto_retry_start", attempt: 2 }); send({ type: "agent_start" });
  assert.equal(send({ type: "auto_retry_end", attempt: 1, success: true }), false);
  assert(state.failures.every(record => record.status === "interrupted"));
  send({ type: "message_start", message: answer(3) }); send({ type: "message_end", message: answer(3) });
  send({ type: "auto_retry_end", attempt: 2, success: true });
  assert.equal(state.failures.length, 2); assert(state.failures.every(record => record.status === "recovered"));
});
test("pi-recovery: other run/session owners, stale attempt snapshots and settled events are rejected", () => {
  const { state, owner, send } = episode(true); interrupted(send); retry(send);
  assert.equal(recovery.update(state, { type: "auto_retry_end", attempt: 1, success: true }, {}), false);
  assert.equal(send({ type: "message_end", message: error(1) }, 3), false, "old source end cannot reappear before the new message_start");
  assert.equal(send({ type: "message_start", message: error(1) }, 2), false, "a replayed source start is not a new message generation");
  send({ type: "message_start", message: answer(2) });
  assert.equal(send({ type: "message_end", message: error(1) }, 3), false);
  assert.equal(send({ type: "agent_end", messages: [error(1)], willRetry: false }, 5), false);
  send({ type: "agent_settled" });
  assert.equal(send({ type: "message_end", message: answer(2) }), false);
  const next = recovery.create({}); recovery.update(next, { type: "message_end", message: answer(3) }, next.owner);
  assert.equal(state.failures[0].status, "interrupted", "later user/run success cannot rewrite the old attempt");
  assert.notEqual(next.owner, owner);
});
test("pi-recovery: tool/BG failures and arbitrary success are not recovery signals", () => {
  const { state, send } = episode(); interrupted(send);
  send({ type: "tool_execution_end", isError: true, toolName: "subagent" });
  assert.equal(send({ type: "message_end", message: { role: "toolResult", timestamp: 100, isError: true } }), true, "native tool timestamps are independent of assistant ownership");
  assert.equal(send({ type: "turn_end", message: { role: "toolResult", timestamp: 101, isError: true } }), true);
  send({ type: "message_start", message: answer(2) }); send({ type: "message_end", message: answer(2) });
  assert.equal(state.failures[0].status, "interrupted"); assert.equal(state.lastFailure.stopReason, "error");
  assert.equal(state.failures.length, 1);
});
test("pi-recovery: history omission is latest-edit/active-branch metadata, never recovery", () => {
  const entries = [
    { id: "u", type: "message", message: { role: "user" } },
    { id: "a", parentId: "u", type: "message", message: error() },
    { id: "omit", parentId: "a", type: "context_edit", targetId: "a", replacement: null },
    { id: "restore", parentId: "omit", type: "context_edit", targetId: "a", replacement: { role: "assistant", content: [] } },
    { id: "inactive", parentId: "omit", type: "context_edit", targetId: "a", replacement: null },
  ];
  const branch = head => {
    const ids = activePathIds(new Map(entries.map(e => [e.id, e])), entries.find(e => e.id === head));
    return entries.filter(e => ids.has(e.id));
  };
  assert.deepEqual([...recovery.omittedIds(branch("omit"))], ["a"]);
  assert.deepEqual([...recovery.omittedIds(branch("restore"))], []);
  const corruptTail = { id: "inactive-tail", parentId: "inactive-tail", type: "context_edit", targetId: "a", replacement: null };
  const byId = new Map([...entries, corruptTail].map(e => [e.id, e]));
  assert.deepEqual([...activePathIds(byId, entries[1])], ["a", "u"], "inactive corruption does not invalidate the selected message path");
  assert.throws(() => activePathIds(byId, corruptTail), { code: "session_corrupt" }, "selected-path cycle rejection remains unchanged");
  assert.deepEqual([...recovery.omittedIds(entries.slice(0, 2))], [], "old host/unknown metadata is not recovered");
  for (const role of ["user", "toolResult"]) {
    assert.deepEqual([...recovery.omittedIds([{ id: "x", type: "message", message: { ...error(), role } }, { type: "context_edit", targetId: "x", replacement: null }])], []);
  }
});
