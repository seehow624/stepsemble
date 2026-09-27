"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { createEventWindow } = require("../server/structured-event-window");
const { createClaudeStructuredParser } = require("../server/claude-code-structured-adapter");
const rendering = require("../public/modules/claude-structured-rendering");

// A turn as Claude Code 2.1.281 streams it with --include-partial-messages:
// deltas, then the complete message, then the result.
function turn(n, { chars = 400, toolDeltas = 0 } = {}) {
  const session = "11111111-2222-4333-8444-555555555555", id = "msg_" + n;
  const text = Array.from({ length: chars }, (_, i) => String.fromCharCode(97 + ((i * 7 + n) % 26))).join("");
  const rows = [{ type: "user", session_id: session, message: { role: "user", content: [{ type: "text", text: "question " + n }] } },
    { type: "stream_event", session_id: session, event: { type: "message_start", message: { id, role: "assistant", content: [] } } },
    { type: "stream_event", session_id: session, event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } }];
  for (let i = 0; i < text.length; i += 4) rows.push({ type: "stream_event", session_id: session, event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: text.slice(i, i + 4) } } });
  rows.push({ type: "assistant", session_id: session, message: { id, role: "assistant", content: [{ type: "text", text }] } });
  // A long file written by a tool streams its input in small pieces too.
  for (let i = 0; i < toolDeltas; i += 1) rows.push({ type: "stream_event", session_id: session, event: { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: "chunk" + i } } });
  if (toolDeltas) rows.push({ type: "assistant", session_id: session, message: { id, role: "assistant", content: [{ type: "tool_use", id: "tool_" + n, name: "Write", input: { file_path: "/tmp/CLAUDE.md" } }] } });
  rows.push({ type: "result", subtype: "success", session_id: session, result: text });
  return { rows, text };
}

// What the page draws: each turn's text, built the way app.js applies the renderer's updates.
function draw(events) {
  const renderer = rendering.createRenderer(), bubbles = [];
  for (const event of events) {
    const update = renderer.consume(event);
    if (!update?.text) continue;
    if (update.beginTurn || !bubbles.length) bubbles.push("");
    bubbles[bubbles.length - 1] = update.mode === "replace" ? update.text : bubbles[bubbles.length - 1] + update.text;
  }
  return bubbles;
}

test("a long Claude conversation is never ended for its number of events", () => {
  const all = [];
  const parser = createClaudeStructuredParser({ onEvent: event => all.push(event) });
  const turns = [turn(1), turn(2, { chars: 2000, toolDeltas: 1900 }), turn(3, { chars: 3000 }), turn(4)];
  for (const { rows } of turns) parser.push(rows.map(row => JSON.stringify(row)).join("\n") + "\n");
  const status = parser.status();
  assert.equal(status.failed, null);
  assert.ok(status.eventCount > 2048, "more events than the window holds, and more than the old limit: " + status.eventCount);
  assert.ok(status.retainedEvents <= 2048);
  // The numbers only grow, and every complete message is kept.
  const kept = parser.events();
  assert.ok(kept.every((event, index) => index === 0 || event.hostSeq > kept[index - 1].hostSeq));
  assert.equal(kept.filter(event => event.type === "assistant").length, 5);
  // A page opened now draws every answer in full, as it would from every event.
  assert.deepEqual(draw(kept), turns.map(item => item.text));
  assert.deepEqual(draw(all), turns.map(item => item.text));
});

test("a page reading on by number draws every answer once, while old events are let go", () => {
  const parser = createClaudeStructuredParser();
  const turns = [turn(1, { chars: 1200 }), turn(2, { chars: 2000, toolDeltas: 1900 }), turn(3, { chars: 3000 })];
  const lines = turns.flatMap(item => item.rows).map(row => JSON.stringify(row));
  const renderer = rendering.createRenderer(), bubbles = [];
  let next = 0;
  const poll = () => {
    for (const event of parser.events()) {
      if (event.hostSeq < next) continue;
      next = event.hostSeq + 1;
      const update = renderer.consume(event);
      if (!update?.text) continue;
      if (update.beginTurn || !bubbles.length) bubbles.push("");
      bubbles[bubbles.length - 1] = update.mode === "replace" ? update.text : bubbles[bubbles.length - 1] + update.text;
    }
  };
  // The page polls every 700 events, slower than the window turns over.
  for (let i = 0; i < lines.length; i += 700) { parser.push(lines.slice(i, i + 700).join("\n") + "\n"); poll(); }
  poll();
  assert.equal(parser.status().failed, null);
  assert.deepEqual(bubbles, turns.map(item => item.text));
});

test("the window lets go of the oldest events when nothing repeats them", () => {
  const window = createEventWindow({ maxEvents: 8 });
  for (let i = 0; i < 30; i += 1) window.push({ type: "x", n: i });
  const kept = window.events();
  assert.ok(kept.length <= 8 && kept.length >= 6);
  assert.equal(kept.at(-1).n, 29);
  assert.deepEqual(kept.map(event => event.hostSeq), kept.map(event => event.n));
  assert.equal(window.status().total, 30);
});

test("a page that holds only the later pieces of an answer draws the complete answer once", () => {
  const renderer = rendering.createRenderer(), bubbles = [];
  const apply = event => { const update = renderer.consume(event); if (!update?.text) return; if (update.beginTurn || !bubbles.length) bubbles.push(""); bubbles[bubbles.length - 1] = update.mode === "replace" ? update.text : bubbles[bubbles.length - 1] + update.text; };
  const full = "one two three four five six";
  apply({ type: "user", message: { role: "user", content: "q" } });
  for (const piece of ["four ", "five ", "six"]) apply({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: piece } } });
  apply({ type: "assistant", message: { id: "m1", role: "assistant", content: [{ type: "text", text: full }] } });
  apply({ type: "result", subtype: "success", result: full });
  assert.deepEqual(bubbles, [full]);
});

test("pieces go as soon as the complete message repeats them", () => {
  const window = createEventWindow({ maxEvents: 100, superseded: { complete: event => event.type === "assistant", partial: event => event.type === "stream_event" } });
  for (let i = 0; i < 40; i += 1) window.push({ type: "stream_event", n: i });
  window.push({ type: "assistant", n: 40 });
  window.push({ type: "stream_event", n: 41 });
  assert.deepEqual(window.events().map(event => event.n), [40, 41]);
  assert.deepEqual(window.events().map(event => event.hostSeq), [40, 41]);
});
