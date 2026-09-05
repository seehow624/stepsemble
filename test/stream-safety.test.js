"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { Writable } = require("node:stream");
const { once } = require("node:events");
const { createLineDecoder, writeBounded, activePathIds } = require("../server/stream-safety");

test("JSONL decoding preserves every UTF-8 boundary and CRLF", () => {
  const source = Buffer.from('{"text":"貓掌🐾"}\r\n{"ok":true}\n');
  for (let split = 0; split <= source.length; split++) {
    const lines = [];
    const decoder = createLineDecoder({ onLine: line => lines.push(JSON.parse(line)), onError: assert.fail });
    decoder.push(source.subarray(0, split)); decoder.push(source.subarray(split)); decoder.end();
    assert.deepEqual(lines, [{ text: "貓掌🐾" }, { ok: true }]);
  }
});

test("unterminated and oversized frames fail once and stop accepting input", () => {
  let errors = 0;
  const decoder = createLineDecoder({ maxBytes: 4, onLine: assert.fail, onError: () => errors++ });
  decoder.push("1234"); decoder.push("5"); decoder.push("\n"); decoder.end();
  assert.equal(errors, 1);
  const truncated = createLineDecoder({ onLine: assert.fail, onError: () => errors++ });
  truncated.push("{"); truncated.end(); assert.equal(errors, 2);
});

test("many short frames in one chunk do not trip the per-frame bound", () => {
  const lines = [];
  const decoder = createLineDecoder({ maxBytes: 2, onLine: line => lines.push(line), onError: assert.fail });
  decoder.push("ab\n".repeat(100)); decoder.end(); assert.equal(lines.length, 100);
});

test("file reader can opt into a final record without weakening protocol framing", () => {
  const lines = [];
  const decoder = createLineDecoder({ onLine: line => lines.push(line), onError: assert.fail });
  decoder.push("貓掌\r"); decoder.end({ allowPartial: true }); decoder.end({ allowPartial: true });
  assert.deepEqual(lines, ["貓掌"]);
});

test("slow SSE preserves ordering and flushes queued writes before end", async () => {
  const received = [];
  const stream = new Writable({ highWaterMark: 1, write(chunk, encoding, callback) {
    received.push(chunk.toString()); setTimeout(callback, 5);
  } });
  assert.equal(writeBounded(stream, "A"), true);
  assert.equal(writeBounded(stream, "B"), true);
  assert.equal(writeBounded(stream, "C"), true);
  stream.end(); await once(stream, "finish");
  assert.equal(received.join(""), "ABC");
});

test("oversized or stalled clients are disconnected with bounded memory", async () => {
  const slow = new Writable({ highWaterMark: 1, write() {} });
  assert.equal(writeBounded(slow, "1234", { maxBytes: 4 }), true);
  assert.equal(writeBounded(slow, "5", { maxBytes: 4 }), false);
  assert.equal(slow.destroyed, true);
  const stalled = new Writable({ highWaterMark: 1, write() {} });
  writeBounded(stalled, "A", { stallMs: 10 });
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(stalled.destroyed, true);
});

test("history traversal detects self and multi-entry cycles without changing data", () => {
  const a = { id: "a", parentId: "b" }, b = { id: "b", parentId: "a" };
  const index = new Map([["a", a], ["b", b]]);
  assert.throws(() => activePathIds(index, a), error => error.code === "session_corrupt" && error.statusCode === 422);
  assert.equal(a.parentId, "b");
  assert.throws(() => activePathIds(new Map([["a", { id: "a", parentId: "a" }]]), { id: "a", parentId: "a" }));
  assert.deepEqual([...activePathIds(new Map([["a", { id: "a" }]]), { id: "b", parentId: "a" })], ["b", "a"]);
});
