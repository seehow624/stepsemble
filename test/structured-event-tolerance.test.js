"use strict";
// Agents add kinds of events over time and may send a very large one. A
// conversation goes on through both; only a frame the agent waits an answer
// to ends it when it cannot be read.
const test = require("node:test");
const assert = require("node:assert/strict");
const { createLineDecoder } = require("../server/stream-safety");
const { createClaudeStructuredParser } = require("../server/claude-code-structured-adapter");
const { createAntigravityStructuredParser } = require("../server/antigravity-cli-structured-adapter");
const { claudeMessages } = require("../server/native-history-catalog");

const line = value => JSON.stringify(value) + "\n";

test("a line longer than the limit is let go of and the next line is read, however it is split", () => {
  const lines = [], oversized = [];
  const decoder = createLineDecoder({ maxBytes: 16, onLine: value => lines.push(value), onError: () => assert.fail("no error"), onOversized: () => oversized.push(1) });
  decoder.push("first\n" + "x".repeat(10));
  decoder.push("y".repeat(10));
  decoder.push("z".repeat(40));
  decoder.push("\nsecond\n" + "w".repeat(40) + "\nthird");
  decoder.push("\n");
  assert.deepEqual(lines, ["first", "second", "third"]);
  assert.equal(oversized.length, 2);
  // Without onOversized a long line still ends the stream.
  let failed = false;
  const strict = createLineDecoder({ maxBytes: 4, onLine: () => {}, onError: () => { failed = true; } });
  strict.push("toolong\n");
  assert.equal(failed, true);
});

test("Claude's progress events, new kinds of event and unreadable lines never end the conversation", () => {
  const events = [];
  const parser = createClaudeStructuredParser({ onEvent: event => events.push(event) });
  const session = "session-1";
  parser.push(line({ type: "assistant", session_id: session, message: { id: "m1", role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "sleep 60" } }] } }));
  parser.push(line({ type: "tool_progress", session_id: session, tool_use_id: "toolu_1", tool_name: "Bash", parent_tool_use_id: null, elapsed_time_seconds: 30, heartbeat: true, uuid: "00000000-0000-4000-8000-000000000001" }));
  parser.push(line({ type: "prompt_suggestion", session_id: session, suggestion: "next" }));
  parser.push("Warning: printed by a plugin\n");
  // Known kind, identifier it cannot take: left out.
  parser.push(line({ type: "system", session_id: session, uuid: "not a valid id!" }));
  // A kind whose name is not an event name: left out.
  parser.push(line({ type: "Not An Event", session_id: session }));
  // A complete message longer than the 8 MiB line limit: left out.
  parser.push(JSON.stringify({ type: "assistant", session_id: session, message: { id: "m2", content: [{ type: "text", text: "x".repeat(9 * 1024 * 1024) }] } }) + "\n");
  parser.push(line({ type: "result", session_id: session, result: "done" }));
  const status = parser.status();
  assert.equal(status.failed, null);
  assert.equal(status.skippedEvents, 4);
  assert.deepEqual(events.map(event => event.type), ["assistant", "tool_progress", "prompt_suggestion", "result"]);
  assert.equal(parser.status().result.result, "done");
});

test("an unreadable frame Claude waits an answer to still ends the conversation", () => {
  const parser = createClaudeStructuredParser();
  parser.push(line({ type: "control_request", request: { subtype: "can_use_tool" } }));
  assert.equal(parser.status().failed, "structured_event_invalid");
  const permission = createClaudeStructuredParser();
  permission.push(line({ type: "permission_request", request_id: "bad id!" }));
  assert.equal(permission.status().failed, "structured_event_invalid");
});

test("an image a tool returned to Claude is not kept, and the rest of its result is", () => {
  const events = [];
  const parser = createClaudeStructuredParser({ onEvent: event => events.push(event) });
  const data = "A".repeat(3 * 1024 * 1024);
  parser.push(line({ type: "user", session_id: "s", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1",
    content: [{ type: "text", text: "Read the screenshot" }, { type: "image", source: { type: "base64", media_type: "image/png", data } }] }] },
    // Claude's own record of the call repeats the image.
    tool_use_result: { type: "image", file: { base64: data, type: "image/jpeg" } } }));
  parser.push(line({ type: "user", session_id: "s", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_2", content: "ok" }] },
    tool_use_result: { stdout: "ok", stderr: "" } }));
  assert.equal(parser.status().failed, null);
  const content = events[0].message.content[0].content;
  assert.equal(content[0].text, "Read the screenshot");
  assert.deepEqual(content[1].source, { type: "base64", media_type: "image/png", data: "", omitted: true });
  assert.deepEqual(events[0].tool_use_result, { omitted: true, bytes: Buffer.byteLength(JSON.stringify({ type: "image", file: { base64: data, type: "image/jpeg" } })) });
  assert.deepEqual(events[1].tool_use_result, { stdout: "ok", stderr: "" }, "a short record is kept");
  assert.ok(parser.status().bytes < 4096);
});

test("Antigravity's new kinds of event, an unknown result status and unreadable lines never end the conversation", () => {
  const events = [];
  const parser = createAntigravityStructuredParser({ onEvent: event => events.push(event) });
  parser.push(line({ type: "init", conversation_id: "c1" }));
  parser.push(line({ type: "heartbeat", conversation_id: "c1" }));
  parser.push("not json\n");
  parser.push(line({ type: "step_update", conversation_id: "c1", event_id: "bad id!" }));
  parser.push(line({ type: "result", conversation_id: "c1", status: "PAUSED", response: "ok" }));
  const status = parser.status();
  assert.equal(status.failed, null);
  assert.equal(status.skippedEvents, 2);
  assert.deepEqual(events.map(event => event.type), ["init", "heartbeat", "result"]);
  assert.equal(events[2].resultStatus, null);
});

test("Claude's history shows tool calls as tool rows and only what the person wrote as theirs", () => {
  const at = second => `2026-09-27T15:00:${String(second).padStart(2, "0")}.000Z`;
  const records = [
    { type: "user", timestamp: at(0), message: { role: "user", content: "Install Xcode" } },
    { type: "assistant", timestamp: at(1), message: { id: "m1", role: "assistant", content: [{ type: "thinking", thinking: "…" }, { type: "text", text: "Checking first." }] } },
    { type: "assistant", timestamp: at(2), message: { id: "m2", role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "ls /Applications" } }] } },
    { type: "user", timestamp: at(3), message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: [{ type: "text", text: "Xcode.app" }, { type: "image", source: { type: "base64", data: "AAAA" } }] }] } },
    { type: "user", timestamp: at(4), message: { role: "user", content: "<task-notification>\n<task-id>b1</task-id>\n</task-notification>" } },
    { type: "user", timestamp: at(5), isMeta: true, message: { role: "user", content: "<local-command-caveat>Caveat: generated while running local commands</local-command-caveat>" } },
    { type: "user", timestamp: at(6), message: { role: "user", content: "<command-name>/model</command-name>\n<command-message>model</command-message>\n<command-args>sonnet</command-args>" } },
    { type: "user", timestamp: at(7), message: { role: "user", content: "<local-command-stdout>Set model to sonnet</local-command-stdout>" } },
    { type: "assistant", timestamp: at(8), message: { id: "m3", role: "assistant", content: [{ type: "tool_use", id: "toolu_2", name: "Write", input: { file_path: "/tmp/a.md", content: "y".repeat(100 * 1024) } }] } },
    { type: "user", timestamp: at(9), message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_2", is_error: true, content: "Exit code 137" }] } },
    { type: "assistant", timestamp: at(9), message: { id: "s1", model: "<synthetic>", role: "assistant", content: [{ type: "text", text: "No response requested." }] } },
    { type: "user", timestamp: at(10), message: { role: "user", content: [{ type: "text", text: "繼續<system-reminder>internal note</system-reminder>" }] } },
    { type: "assistant", timestamp: at(11), message: { id: "s2", model: "<synthetic>", role: "assistant", content: [{ type: "text", text: "API Error: 529 Overloaded" }] } },
  ];
  const messages = claudeMessages(records);
  assert.deepEqual(messages.map(message => [message.role, message.text]), [
    ["user", "Install Xcode"],
    ["assistant", "Checking first."],
    ["user", "/model sonnet"],
    ["assistant", "Set model to sonnet"],
    ["user", "繼續"],
    ["assistant", "API Error: 529 Overloaded"],
  ]);
  const [bash, write] = messages.tools;
  assert.deepEqual({ ...bash, ts: undefined, endedAt: undefined }, { id: "toolu_1", name: "Bash", input: { command: "ls /Applications" }, output: "Xcode.app\n[image]",
    isError: false, after: 2, ts: undefined, messageId: "m2", endedAt: undefined });
  assert.equal(bash.endedAt - bash.ts, 1000);
  assert.equal(write.after, 4);
  assert.equal(write.isError, true);
  assert.equal(write.output, "Exit code 137");
  assert.equal(write.input.file_path, "/tmp/a.md");
  assert.ok(write.input.content.length <= 4096, "a long input keeps the start of its long fields");
});
