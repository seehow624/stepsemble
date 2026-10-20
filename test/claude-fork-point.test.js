"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { claudeForkPoint, claudeForkPointFromRows, claudeTranscriptFile } = require("../server/claude-fork-point");
const { createNativeHistoryCatalog } = require("../server/native-history-catalog");

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

test("the branch point is read from Claude's transcript for the conversation's folder", async () => {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-fork-point-"));
  const cwd = "/Users/someone/My Project";
  const file = claudeTranscriptFile("7f3c2a10-5b6e-4c1d-9a8b-0e1f2a3b4c5d", cwd, { configDir });
  assert.equal(file, path.join(configDir, "projects", "-Users-someone-My-Project", "7f3c2a10-5b6e-4c1d-9a8b-0e1f2a3b4c5d.jsonl"));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, rows.map(row => JSON.stringify(row)).join("\n") + "\n{broken\n");
  assert.equal(await claudeForkPoint("7f3c2a10-5b6e-4c1d-9a8b-0e1f2a3b4c5d", "msg_2", cwd, { configDir }), "m1");
  assert.equal(await claudeForkPoint("../escape", "msg_2", cwd, { configDir }), null);
  assert.equal(await claudeForkPoint("7f3c2a10-5b6e-4c1d-9a8b-0e1f2a3b4c5d", "msg_2", "relative/path", { configDir }), null);
  fs.rmSync(configDir, { recursive: true, force: true });
});

// A conversation far larger than the reader keeps of it, with a line past the
// line limit in its middle: branching through a reply near its start, middle
// or end still finds where that turn ends, from one streamed read that later
// lookups read on from.
test("a branch point is found in a transcript past every size the reader keeps", { skip: process.platform === "win32" }, async t => {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-fork-point-large-"));
  t.after(() => fs.rmSync(configDir, { recursive: true, force: true }));
  const id = "8a4d3b21-6c7f-4d2e-8b9c-1f2a3b4c5d6e", cwd = "/Users/someone/Large";
  const file = claudeTranscriptFile(id, cwd, { configDir });
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o755 });
  const lines = [];
  const turn = index => {
    lines.push({ type: "user", uuid: `u${index}`, message: { role: "user", content: `question ${index}` } },
      { type: "assistant", uuid: `a${index}`, message: { id: `msg_${index}`, content: [{ type: "tool_use", id: `t${index}`, name: "Read", input: { file_path: `/f/${index}` } }] } },
      { type: "user", uuid: `r${index}`, message: { role: "user", content: [{ type: "tool_result", tool_use_id: `t${index}`, content: "x".repeat(64 * 1024) }] } },
      { type: "assistant", uuid: `z${index}`, message: { id: `msg_${index}_text`, content: [{ type: "text", text: `answer ${index}` }] } });
  };
  for (let index = 0; index < 60; index++) turn(index);
  const text = lines.map(row => JSON.stringify(row));
  text.splice(120, 0, JSON.stringify({ type: "user", uuid: "huge", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t29", content: "y".repeat(300 * 1024) }] } }));
  fs.writeFileSync(file, text.join("\n") + "\n", { mode: 0o600 });
  const parses = [];
  const catalog = createNativeHistoryCatalog({ home: configDir, onParse: pass => parses.push(pass),
    limits: { retainedBytes: 256 * 1024, lineBytes: 128 * 1024, chunkBytes: 16 * 1024 } });
  t.after(() => catalog.shutdown());
  assert.ok(fs.statSync(file).size > 16 * 256 * 1024);
  for (const index of [0, 30, 59]) {
    assert.equal(await claudeForkPoint(id, `msg_${index}`, cwd, { configDir, catalog }), `z${index}`);
    assert.equal(await claudeForkPoint(id, `msg_${index}_text`, cwd, { configDir, catalog }), `z${index}`);
  }
  assert.equal(await claudeForkPoint(id, "msg_missing", cwd, { configDir, catalog }), null);
  assert.equal(parses.length, 1, "one streamed read serves every lookup");
  // A reply written after the last read is found by reading on from there.
  const size = fs.statSync(file).size;
  fs.appendFileSync(file, [{ type: "user", uuid: "u60", message: { role: "user", content: "question 60" } },
    { type: "assistant", uuid: "a60", message: { id: "msg_60", content: [{ type: "text", text: "answer 60" }] } }].map(row => JSON.stringify(row)).join("\n") + "\n");
  assert.equal(await claudeForkPoint(id, "msg_60", cwd, { configDir, catalog }), "a60");
  assert.deepEqual(parses.at(-1), { from: size, to: fs.statSync(file).size });
  // Without the Host's catalog the transcript is streamed once.
  assert.equal(await claudeForkPoint(id, "msg_30", cwd, { configDir }), "z30");
});
