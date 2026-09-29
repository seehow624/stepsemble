"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { claudeForkPoint, claudeForkPointFromRows, claudeTranscriptFile } = require("../server/claude-fork-point");

const rows = [
  { type: "user", uuid: "u1", message: { role: "user", content: "first question" } },
  { type: "assistant", uuid: "a1", message: { id: "msg_1", content: [{ type: "tool_use", id: "t1", name: "Bash" }] } },
  { type: "user", uuid: "r1", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "done" }] } },
  { type: "assistant", uuid: "a2", message: { id: "msg_2", content: [{ type: "text", text: "first answer" }] } },
  { type: "user", uuid: "m1", isMeta: true, message: { role: "user", content: "<system-reminder>note</system-reminder>" } },
  { type: "user", uuid: "u2", message: { role: "user", content: [{ type: "text", text: "second question" }] } },
  { type: "assistant", uuid: "a3", message: { id: "msg_3", content: [{ type: "text", text: "second answer" }] } },
];

test("a branch through a reply ends with the last entry of its turn, before the person's next message", () => {
  // The reply that called a tool keeps the tool's result and the text after it.
  assert.equal(claudeForkPointFromRows(rows, "msg_1"), "m1");
  assert.equal(claudeForkPointFromRows(rows, "msg_2"), "m1");
  assert.equal(claudeForkPointFromRows(rows, "msg_3"), "a3");
  assert.equal(claudeForkPointFromRows(rows, "msg_missing"), null);
});

test("the branch point is read from Claude's transcript for the conversation's folder", () => {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-fork-point-"));
  const cwd = "/Users/someone/My Project";
  const file = claudeTranscriptFile("7f3c2a10-5b6e-4c1d-9a8b-0e1f2a3b4c5d", cwd, { configDir });
  assert.equal(file, path.join(configDir, "projects", "-Users-someone-My-Project", "7f3c2a10-5b6e-4c1d-9a8b-0e1f2a3b4c5d.jsonl"));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, rows.map(row => JSON.stringify(row)).join("\n") + "\n{broken\n");
  assert.equal(claudeForkPoint("7f3c2a10-5b6e-4c1d-9a8b-0e1f2a3b4c5d", "msg_2", cwd, { configDir }), "m1");
  assert.equal(claudeForkPoint("../escape", "msg_2", cwd, { configDir }), null);
  assert.equal(claudeForkPoint("7f3c2a10-5b6e-4c1d-9a8b-0e1f2a3b4c5d", "msg_2", "relative/path", { configDir }), null);
  fs.rmSync(configDir, { recursive: true, force: true });
});
