"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { PassThrough } = require("node:stream");
const { EventEmitter } = require("node:events");
const {
  buildAntigravityStructuredArgs,
  normalizeAntigravityEvent,
  createAntigravityStructuredParser,
  createAntigravityStructuredSession,
} = require("../server/antigravity-cli-structured-adapter");

function childFixture() {
  const child = new EventEmitter();
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.killed = false;
  child.kill = () => { child.killed = true; child.emit("close", 0, null); };
  return child;
}

test("Antigravity stream args are resumable and never shell-expanded", () => {
  assert.deepEqual(buildAntigravityStructuredArgs({ conversationId: "conversation-1" }), [
    "--input-format", "stream-json", "--output-format", "stream-json", "--conversation", "conversation-1",
  ]);
  assert.throws(() => buildAntigravityStructuredArgs({ conversationId: "../../secret" }), /invalid_antigravity_conversation_id/);
});

test("Antigravity parser locks conversation identity and extracts step/result text", () => {
  const events = [];
  const parser = createAntigravityStructuredParser({ onEvent: event => events.push(event) });
  parser.push(JSON.stringify({ type: "init", conversation_id: "conversation-1", event_id: "event-1" }) + "\n");
  parser.push(JSON.stringify({ type: "step_update", conversation_id: "conversation-1", step_update: { text_delta: "hello" } }) + "\n");
  parser.push(JSON.stringify({ type: "result", conversation_id: "conversation-1", status: "SUCCESS", response: " world" }) + "\n");
  assert.equal(parser.status().conversationId, "conversation-1");
  assert.equal(events[0].eventId, "event-1");
  assert.equal(parser.text(), "hello world");
  assert.equal(normalizeAntigravityEvent({ type: "result", conversation_id: "bad id" }), null);
  parser.push(JSON.stringify({ type: "result", conversation_id: "other", status: "SUCCESS" }) + "\n");
  assert.equal(parser.status().failed, "antigravity_conversation_mismatch");
});

test("Antigravity session writes documented user JSONL and never fabricates approval ACK", async t => {
  const child = childFixture();
  let args;
  const session = createAntigravityStructuredSession({ command: "/usr/local/bin/agy", cwd: "/tmp", name: "My Antigravity task", spawnImpl: (file, argv, options) => { args = { file, argv, options }; return child; } });
  t.after(() => session.close());
  assert.equal(args.file, "/usr/local/bin/agy");
  assert.equal(session.name, "My Antigravity task");
  assert.deepEqual(args.argv.slice(0, 4), ["--input-format", "stream-json", "--output-format", "stream-json"]);
  const chunks = [];
  child.stdin.on("data", chunk => chunks.push(chunk.toString()));
  const sent = await session.send("hello");
  assert.equal(sent.kind, "sent");
  assert.match(chunks.join(""), /"event":"user"/);
  assert.match(chunks.join(""), /"content":"hello"/);
  assert.equal(session.acknowledgePermission("missing", "allow").code, "antigravity_permission_unavailable");
  child.stdout.write(JSON.stringify({ type: "init", conversation_id: "conversation-2" }) + "\n");
  assert.equal(session.status().nativeConversationId, "conversation-2");
  assert.equal((await session.close()).cleanupConfirmed, true);
});

test("Antigravity approval observations remain bounded and cannot become an ACK", async t => {
  const child = childFixture();
  const session = createAntigravityStructuredSession({ command: "/usr/local/bin/agy", cwd: "/tmp", spawnImpl: () => child });
  t.after(() => session.close());
  child.stdout.write(JSON.stringify({ type: "init", conversation_id: "conversation-approval" }) + "\n");
  child.stdout.write(JSON.stringify({ type: "step_update", conversation_id: "conversation-approval", tool_info: { request_id: "approval-1", requires_approval: true, message: "Run tests" } }) + "\n");
  assert.equal(session.pendingPermissions().length, 1);
  assert.equal(session.pendingPermissions()[0].requestId, "approval-1");
  assert.equal(session.acknowledgePermission("approval-1", "allow").code, "antigravity_permission_requires_native_ui");
});

test("Antigravity's own stream, as its docs show it, is read: the kind in event, the conversation in the payload", () => {
  // antigravity.google/docs/cli/headless, Streaming JSON.
  const events = [];
  const parser = createAntigravityStructuredParser({ onEvent: event => events.push(event) });
  const id = "c3b66b04-872b-4fbe-a3a4-058a026ef20a";
  for (const line of [
    { event: "init", conversation_id: id, init: { cwd: "/home/user/project", tools: ["run_command"], permission_mode: "request-review" } },
    { event: "step_update", step_update: { conversation_id: id, step_index: 0, state: "DONE", step_type: "user_input" } },
    { event: "step_update", step_update: { conversation_id: id, step_index: 3, state: "DONE", step_type: "agent_response", text_delta: "Git rebase rewrites history." } },
    { event: "result", result: { conversation_id: id, status: "SUCCESS", response: "Git rebase rewrites history.", num_turns: 1 } },
  ]) parser.push(JSON.stringify(line) + "\n");
  const status = parser.status();
  assert.deepEqual(events.map(event => event.type), ["init", "step_update", "step_update", "result"]);
  assert.equal(status.conversationId, id);
  assert.equal(status.result.resultStatus, "SUCCESS");
  assert.equal(status.skippedEvents, 0);
  assert.match(parser.text(), /Git rebase rewrites history/);
  // Signed out, agy ends at once with a result naming no conversation.
  const signedOut = normalizeAntigravityEvent({ event: "result", result: { conversation_id: "", status: "ERROR", error: "authentication failed or timed out" } });
  assert.deepEqual([signedOut.type, signedOut.resultStatus, signedOut.conversationId], ["result", "ERROR", null]);
  // A conversation id that is not one is still refused.
  assert.equal(normalizeAntigravityEvent({ event: "result", result: { conversation_id: "../../x", status: "SUCCESS" } }), null);
});
