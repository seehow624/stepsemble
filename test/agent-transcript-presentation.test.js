"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const presentation = require(path.join(root, "public/modules/agent-transcript-presentation.js"));

test("Codex command output becomes a collapsed tool presentation instead of assistant prose", () => {
  const value = presentation.codexItem({
    id: "command-1", type: "commandExecution", command: "/bin/zsh -lc 'cat ~/.agents/skills/example/SKILL.md'",
    status: "completed", exitCode: 0, aggregatedOutput: "# long skill\n" + "details\n".repeat(500),
  });
  assert.equal(value.kind, "tool");
  assert.equal(value.tool.name, "shell");
  assert.match(value.tool.args.command, /SKILL\.md/);
  assert.match(value.tool.output, /long skill/);
  assert.equal(value.tool.running, false);
  assert.equal(value.tool.isError, false);
  assert.equal(Object.hasOwn(value, "text"), false, "tool output must not be promoted to the main chat prose");
});

test("Codex reasoning, file edits and failures retain structure and status", () => {
  assert.deepEqual(presentation.codexItem({ type: "reasoning", summary: [{ text: "inspect first" }] }), {
    kind: "thinking", text: "inspect first",
  });
  const edit = presentation.codexItem({ id: "edit-1", type: "fileChange", status: "completed", changes: [{ path: "/owned/app.js" }] });
  assert.equal(edit.tool.name, "edit");
  assert.equal(edit.tool.args.path, "/owned/app.js");
  const failed = presentation.codexItem({ id: "command-2", type: "commandExecution", command: "npm test", status: "failed", exitCode: 1, aggregatedOutput: "failed" });
  assert.equal(failed.tool.isError, true);
});

test("Codex file changes carry paths and line totals into the review card", () => {
  const result = presentation.codexItem({ type: "fileChange", status: "completed", changes: [
    { path: "/project/src/a.js", kind: "update", diff: "--- a/src/a.js\n+++ b/src/a.js\n@@\n-old\n+new\n context" },
    { path: "/project/src/b.js", kind: "add", diff: "first\nsecond\n" },
  ] });
  assert.deepEqual(result.tool.args.changes, [
    { path: "/project/src/a.js", added: 1, removed: 1 },
    { path: "/project/src/b.js", added: 2, removed: 0 },
  ]);
  assert.match(result.tool.output, /src\/a\.js/);
});

test("Codex image views retain only server-issued preview handles", () => {
  const preview = { url: "/api/codex/image?token=abcdefghijklmnopqrstuvwxyz012345", mimeType: "image/png", name: "crop.png" };
  const value = presentation.codexItem({ id: "image-1", type: "imageView", path: "/owned/private/crop.png", preview });
  assert.equal(value.kind, "tool");
  assert.equal(value.tool.name, "view_image");
  assert.deepEqual(value.tool.preview, preview);
  const rejected = presentation.codexItem({ id: "image-2", type: "imageView", path: "/owned/private/crop.png",
    preview: { url: "file:///owned/private/crop.png", mimeType: "image/png", name: "crop.png" } });
  assert.equal(rejected.tool.preview, null);
});

test("OpenCode messages keep prose, reasoning and tool output in separate channels", () => {
  const value = presentation.openCodeMessage({ role: "assistant", parts: [
    { type: "reasoning", text: "checking" },
    { type: "tool", callID: "call-1", tool: "read", state: { status: "completed", input: { path: "/owned/file" }, output: "contents" } },
    { type: "text", text: "Final answer" },
  ] });
  assert.equal(value.text, "Final answer");
  assert.equal(value.thinking, "checking");
  assert.equal(value.tools.length, 1);
  assert.deepEqual(value.tools[0].args, { path: "/owned/file" });
  assert.equal(value.tools[0].output, "contents");
  assert.deepEqual(value.sequence.map(part => part.kind), ["thinking", "tool", "text"]);
});

test("ACP agents map thought, answer and tool updates without bracketed terminal noise", () => {
  assert.deepEqual(presentation.acpUpdate({ sessionUpdate: "agent_message_chunk", content: { text: "answer" } }), {
    kind: "message_delta", text: "answer",
  });
  assert.deepEqual(presentation.acpUpdate({ sessionUpdate: "agent_thought_chunk", content: { text: "thinking" } }), {
    kind: "thinking_delta", text: "thinking",
  });
  const tool = presentation.acpUpdate({ sessionUpdate: "tool_call_update", toolCallId: "tool-1", title: "Read file",
    input: { path: "/owned/file" }, output: "done", status: "completed" });
  assert.equal(tool.kind, "tool");
  assert.equal(tool.tool.id, "tool-1");
  assert.equal(tool.tool.output, "done");
  assert.equal(tool.tool.running, false);
});

test("ACP replays of the person's message and OpenCode's failed replies are shown", () => {
  // An agent's replay of a conversation, and the Host's copy of a message
  // sent from Stepsemble, are the person's own words.
  assert.deepEqual(presentation.acpUpdate({ sessionUpdate: "user_message_chunk", content: { type: "text", text: "question" } }), {
    kind: "user_delta", text: "question",
  });
  const failed = presentation.openCodeMessage({ role: "assistant", parts: [],
    info: { role: "assistant", error: { name: "APIError", data: { message: "You need to sign in to use this model.", statusCode: 401 } } } });
  assert.equal(failed.error, "You need to sign in to use this model.");
  assert.equal(presentation.openCodeMessage({ role: "assistant", parts: [{ type: "text", text: "fine" }] }).error, undefined);
});

test("Claude tool requests and results reconcile through their native call id", () => {
  const request = presentation.claudeEvent({ type: "assistant", message: { content: [
    { type: "tool_use", id: "call-1", name: "Read", input: { file_path: "/owned/SKILL.md" } },
  ] } });
  const result = presentation.claudeEvent({ type: "user", message: { content: [
    { type: "tool_result", tool_use_id: "call-1", content: "long output" },
  ] } });
  assert.equal(request[0].tool.id, "call-1");
  assert.equal(request[0].tool.name, "Read");
  assert.equal(request[0].tool.running, true);
  assert.equal(result[0].tool.id, "call-1");
  assert.equal(result[0].tool.output, "long output");
  assert.equal(result[0].tool.running, false);
});

test("the browser loads and offline-caches the presentation module before the app controller", () => {
  const html = fs.readFileSync(path.join(root, "public/index.html"), "utf8");
  const sw = fs.readFileSync(path.join(root, "public/sw.js"), "utf8");
  const app = fs.readFileSync(path.join(root, "public/app.js"), "utf8");
  assert.ok(html.indexOf("/modules/agent-transcript-presentation.js") < html.indexOf("/app.js"));
  assert.match(sw, /modules\/agent-transcript-presentation\.js/);
  assert.match(app, /agentTranscriptPresentation\.codexItem/);
  assert.match(app, /makeToolCard\(tool\.name/);
});
