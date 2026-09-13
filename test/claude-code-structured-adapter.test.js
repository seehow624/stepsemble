"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { PassThrough } = require("node:stream");
const { EventEmitter } = require("node:events");
const {
  buildClaudeStructuredArgs,
  normalizeClaudeEvent,
  createClaudeStructuredParser,
  createClaudeStructuredSession,
} = require("../server/claude-code-structured-adapter");

function childFixture() {
  const child = new EventEmitter();
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.killed = false;
  child.kill = () => { child.killed = true; child.emit("close", 0, null); };
  return child;
}

test("Claude structured args are explicit, resumable, and never shell-expanded", () => {
  assert.deepEqual(buildClaudeStructuredArgs({ sessionId: "session-1" }), [
    "-p", "--output-format", "stream-json", "--input-format", "stream-json", "--verbose", "--include-partial-messages", "--permission-prompts", "host", "--resume", "session-1",
  ]);
  assert.deepEqual(buildClaudeStructuredArgs({ permissionPromptTool: "mcp__stepsemble__permission" }).slice(-2), ["--permission-prompt-tool", "mcp__stepsemble__permission"]);
  assert.throws(() => buildClaudeStructuredArgs({ sessionId: "../../secret" }), /invalid_claude_session_id/);
  assert.throws(() => buildClaudeStructuredArgs({ permissionPromptTool: "tool;rm" }), /invalid_permission_prompt_tool/);
});

test("Claude structured parser locks the native session and preserves subagent correlation", () => {
  const events = [];
  const parser = createClaudeStructuredParser({ onEvent: event => events.push(event) });
  parser.push(JSON.stringify({ type: "system", session_id: "session-1", uuid: "event-1" }) + "\n");
  parser.push(JSON.stringify({ type: "stream_event", session_id: "session-1", parent_tool_use_id: "tool-1", delta: "hello" }) + "\n");
  assert.equal(parser.status().sessionId, "session-1");
  assert.equal(events[1].parentToolUseId, "tool-1");
  assert.equal(parser.text(), "hello");
  parser.push(JSON.stringify({ type: "result", session_id: "other", result: "bad" }) + "\n");
  assert.equal(parser.status().failed, "claude_session_mismatch");
});

test("Claude structured parser validates native control requests", () => {
  const events = [];
  const parser = createClaudeStructuredParser({ onEvent: event => events.push(event) });
  parser.push(JSON.stringify({ type: "control_request", request_id: "perm-1", request: {
    subtype: "can_use_tool", tool_name: "Bash", input: { command: "pwd" }, description: "Run pwd",
  } }) + "\n");
  assert.equal(events[0].requestId, "perm-1");
  assert.equal(events[0].request.subtype, "can_use_tool");
  parser.push(JSON.stringify({ type: "control_request", request: { subtype: "can_use_tool" } }) + "\n");
  assert.equal(parser.status().failed, "structured_event_invalid");
});

test("Claude structured session writes native permission responses and interrupts without closing", async t => {
  const child = childFixture();
  let args;
  const session = createClaudeStructuredSession({ command: "/usr/local/bin/claude", cwd: "/tmp", name: "Named Claude task", spawnImpl: (file, argv, options) => { args = { file, argv, options }; return child; } });
  t.after(() => session.close());
  assert.equal(args.file, "/usr/local/bin/claude");
  assert.equal(session.name, "Named Claude task");
  assert.equal(args.argv.includes("--input-format"), true);
  const chunks = [];
  child.stdin.on("data", chunk => chunks.push(chunk.toString()));
  const sent = await session.send("hello");
  assert.equal(sent.kind, "sent");
  assert.match(chunks.join(""), /"type":"user"/);
  assert.equal(session.acknowledgePermission("missing", "allow").code, "claude_permission_unavailable");
  child.stdout.write(JSON.stringify({ type: "control_request", request_id: "perm-1", request: {
    subtype: "can_use_tool", tool_name: "Bash", input: { command: "pwd" }, description: "Run pwd",
  } }) + "\n");
  assert.equal(session.pendingPermissions()[0].approvalProtocol, "control");
  const allowed = await session.acknowledgePermission("perm-1", "allow");
  assert.deepEqual(allowed, { kind: "written", requestId: "perm-1", decision: "allow" });
  const lines = chunks.join("").trim().split("\n").map(line => JSON.parse(line));
  const response = lines.find(line => line.type === "control_response");
  assert.deepEqual(response, { type: "control_response", response: {
    subtype: "success", request_id: "perm-1", response: { behavior: "allow", updatedInput: { command: "pwd" } },
  } });
  assert.equal((await session.acknowledgePermission("perm-1", "deny")).code, "claude_permission_already_responded");
  child.stdout.write(JSON.stringify({ type: "control_response", response: { subtype: "success", request_id: "perm-1", response: { behavior: "allow" } } }) + "\n");
  assert.equal(session.pendingPermissions().length, 0);
  const interrupted = await session.interrupt();
  assert.equal(interrupted.kind, "sent");
  const interruptRequest = chunks.join("").trim().split("\n").map(line => JSON.parse(line)).find(line => line.type === "control_request" && line.request?.subtype === "interrupt");
  assert.equal(interruptRequest.request.subtype, "interrupt");
  const multiline = await session.send("line one\nline two");
  assert.equal(multiline.kind, "sent");
  child.stdout.write(JSON.stringify({ type: "result", session_id: "session-2", result: "done" }) + "\n");
  assert.equal(session.status().nativeSessionId, "session-2");
  assert.equal((await session.close()).cleanupConfirmed, true);
});
