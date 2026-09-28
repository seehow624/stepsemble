"use strict";

// Pictures the person sent come through each agent's record, so the page can
// show them above the message (appendImageGallery).
const test = require("node:test");
const assert = require("node:assert/strict");
const { claudeMessages } = require("../server/native-history-catalog");
const presentation = require("../public/modules/agent-transcript-presentation");

const png = "iVBORw0KGgo" + "A".repeat(64);

test("Claude's history keeps the pictures a person sent, and a message of pictures alone", () => {
  const row = (uuid, content) => ({ type: "user", uuid, timestamp: "2026-09-28T02:00:00.000Z", message: { role: "user", content } });
  const messages = claudeMessages([
    row("u1", [{ type: "text", text: "look at this" }, { type: "image", source: { type: "base64", media_type: "image/png", data: png } }]),
    { type: "assistant", uuid: "a1", timestamp: "2026-09-28T02:00:01.000Z", message: { role: "assistant", id: "msg_1", content: [{ type: "text", text: "a table" }] } },
    row("u2", [{ type: "image", source: { type: "base64", media_type: "image/jpeg", data: png } }]),
    row("u3", [{ type: "image", source: { type: "base64", media_type: "image/svg+xml", data: png } }, { type: "text", text: "not shown" }]),
  ]);
  assert.deepEqual(messages.map(message => [message.role, message.text, message.images || 0, (message.imageAttachments || []).length]),
    [["user", "look at this", 1, 1], ["assistant", "a table", 0, 0], ["user", "", 1, 1], ["user", "not shown", 1, 0]]);
  assert.equal(messages[0].imageAttachments[0].data, "data:image/png;base64," + png);
});

test("pictures past the budget are counted without their data", () => {
  const big = "A".repeat(7 * 1024 * 1024);
  const rows = [1, 2, 3].map(index => ({ type: "user", uuid: "u" + index, timestamp: "2026-09-28T02:00:00.000Z",
    message: { role: "user", content: [{ type: "text", text: "picture " + index }, { type: "image", source: { type: "base64", media_type: "image/png", data: big } }] } }));
  const messages = claudeMessages(rows);
  assert.deepEqual(messages.map(message => [message.images, message.imageAttachments.length]), [[1, 1], [1, 1], [1, 0]]);
});

test("Codex, OpenCode and replayed agent messages carry the pictures they hold", () => {
  const codex = presentation.codexItem({ type: "userMessage", content: [
    { type: "text", text: "hello" }, { type: "image", url: "data:image/png;base64," + png }, { type: "localImage", path: "/tmp/a.png" }] });
  assert.equal(codex.text, "hello", "no [image] marker in the text");
  assert.equal(codex.images, 2);
  assert.deepEqual(codex.imageAttachments.map(item => item.src), ["data:image/png;base64," + png]);
  assert.equal(presentation.codexItem({ type: "userMessage", content: [{ type: "image", url: "https://example.com/a.png" }] }).imageAttachments.length, 0,
    "only pictures held in the record are shown");
  const opencode = presentation.openCodeMessage({ role: "user", parts: [{ type: "text", text: "x" }, { type: "file", mime: "image/jpeg", url: "data:image/jpeg;base64," + png }] });
  assert.equal(opencode.images, 1);
  assert.equal(opencode.imageAttachments[0].src, "data:image/jpeg;base64," + png);
  const replay = presentation.acpUpdate({ sessionUpdate: "user_message_chunk", content: { type: "image", mimeType: "image/png", data: png } });
  assert.deepEqual(replay, { kind: "user_image", image: { src: "data:image/png;base64," + png, mimeType: "image/png" } });
  assert.deepEqual(presentation.acpUpdate({ sessionUpdate: "user_message_chunk", content: { type: "image", mimeType: "image/png" } }), { kind: "user_image", image: null });
});
