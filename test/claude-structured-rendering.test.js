"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const rendering = require(path.join(root, "public/modules/claude-structured-rendering.js"));

function collect(rows) {
  const renderer = rendering.createRenderer();
  return rows.map(event => renderer.consume(event)).filter(Boolean);
}

test("Claude partial stream, assistant envelope, and result render one final answer", () => {
  const answer = "Claude Code test Not logged in Please run/login";
  const updates = collect([
    { type: "user", message: { id: "user-1" } },
    { type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "Claude Code test " } } },
    { type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "Not logged in" } } },
    { type: "assistant", message: { id: "message-1", content: [{ type: "text", text: answer }] } },
    { type: "result", result: answer },
  ]);

  assert.deepEqual(updates.map(update => [update.mode, update.text]), [
    ["append", "Claude Code test "],
    ["append", "Not logged in"],
    ["replace", answer],
  ]);
  assert.equal(updates.at(-1).phase, "assistant");
});

test("identical replies in separate Claude turns are not globally deduplicated", () => {
  const answer = "same answer";
  const updates = collect([
    { type: "user" },
    { type: "assistant", message: { id: "message-1", content: [{ type: "text", text: answer }] } },
    { type: "result", result: answer },
    { type: "user" },
    { type: "assistant", message: { id: "message-2", content: [{ type: "text", text: answer }] } },
    { type: "result", result: answer },
  ]);

  assert.deepEqual(updates.map(update => [update.mode, update.text, update.beginTurn]), [
    ["append", answer, true],
    ["append", answer, true],
  ]);
});

test("repeated partial chunks remain visible and tool/thinking stream frames stay hidden", () => {
  const updates = collect([
    { type: "user" },
    { type: "stream_event", delta: "top-level " },
    { type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "ha" } } },
    { type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "ha" } } },
    { type: "stream_event", event: { type: "content_block_delta", delta: { type: "thinking_delta", thinking: "secret" } } },
    { type: "stream_event", event: { type: "content_block_start", content_block: { type: "tool_use", name: "secret_tool" } } },
  ]);

  assert.deepEqual(updates.map(update => update.text), ["top-level ", "ha", "ha"]);
  assert.equal(rendering.eventText({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "thinking_delta", thinking: "secret" } } }), "");
});

test("nested message lifecycle frames and same-id content blocks never erase visible text", () => {
  const renderer = rendering.createRenderer();
  const rows = [
    { type: "user" },
    { type: "stream_event", event: { type: "message_start", message: { id: "message-1" } } },
    { type: "stream_event", event: { type: "content_block_start", content_block: { type: "text", text: "first block" } } },
    { type: "assistant", message: { id: "message-1", content: [{ type: "text", text: "first block" }] } },
    { type: "assistant", message: { id: "message-1", content: [{ type: "text", text: "second block" }] } },
    { type: "result", result: "second block" },
    { type: "result", result: "second block" },
  ];
  const updates = rows.map(row => renderer.consume(row)).filter(Boolean);
  assert.deepEqual(updates.map(update => [update.mode, update.text]), [
    ["append", "first block"],
    ["append", "second block"],
  ]);
});

test("long assistant payloads are not cut at the former 64 KiB output-tail limit", () => {
  const text = "x".repeat(70 * 1024);
  const update = rendering.createRenderer().consume({ type: "assistant", message: { id: "message-long", content: [{ type: "text", text }] } });
  assert.equal(update.text.length, text.length);
});

test("browser module is wired before app and included in the service-worker shell", () => {
  const html = fs.readFileSync(path.join(root, "public/index.html"), "utf8");
  const app = fs.readFileSync(path.join(root, "public/app.js"), "utf8");
  const sw = fs.readFileSync(path.join(root, "public/sw.js"), "utf8");
  assert.ok(html.indexOf("/modules/claude-structured-rendering.js") < html.indexOf("/app.js"));
  assert.match(app, /stepsembleClaudeStructuredRendering/);
  assert.match(app, /replaceClaudeStructuredOutputTail/);
  assert.match(sw, /modules\/claude-structured-rendering\.js/);
});
