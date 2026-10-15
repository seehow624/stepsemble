"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const M = require("../public/modules/assistant-model.js");

test("the assistant uses the computer that runs Hermes, a saved choice first", () => {
  const rows = [
    { id: "mbp", self: true, status: { installed: false } },
    { id: "mini", self: false, status: { installed: true } },
    { id: "studio", self: false, status: { installed: true } },
    { id: "offline", self: false, status: null },
  ];
  assert.deepEqual(M.chooseHermesMachine(rows, null).choices.map(row => row.id), ["mini", "studio"]);
  assert.equal(M.chooseHermesMachine(rows, null).selected.id, "mini");
  assert.equal(M.chooseHermesMachine(rows, "studio").selected.id, "studio");
  assert.equal(M.chooseHermesMachine(rows, "mbp").selected.id, "mini", "a computer without Hermes is never chosen");
  assert.equal(M.chooseHermesMachine([{ id: "a", self: true, status: { installed: true } }, { id: "b", status: { installed: true } }], null).selected.id, "a");
  assert.equal(M.chooseHermesMachine([], null).selected, null);
});

test("history becomes a transcript, and live events extend it in order", () => {
  const items = M.fromHistory([{ role: "user", text: "hi" }, { role: "tool", name: "calendar", context: "today" }, { role: "assistant", text: "Hello" }]);
  assert.deepEqual(items.map(item => [item.role, item.text, item.tools.length]), [["user", "hi", 0], ["assistant", "", 1], ["assistant", "Hello", 0]]);
  for (const event of [
    { type: "message.start", payload: {} },
    { type: "thinking.delta", payload: { text: "checking" } },
    { type: "tool.start", payload: { tool_id: "t1", name: "search", args_text: "{}" } },
    { type: "tool.complete", payload: { tool_id: "t1", name: "search", summary: "3 results" } },
    { type: "message.delta", payload: { text: "Done " } },
    { type: "message.delta", payload: { text: "now." } },
    { type: "message.complete", payload: { text: "Done now." } },
  ]) assert.equal(M.applyEvent(items, event), true, event.type);
  const last = items.at(-1);
  assert.equal(last.text, "Done now.");
  assert.equal(last.thinking, "checking");
  assert.deepEqual(last.tools.map(tool => [tool.name, tool.done, tool.result]), [["search", true, "3 results"]]);
  assert.equal(last.streaming, false);
  assert.ok(last.rev > 0, "a changed item says so, so the page redraws only it");
  assert.equal(M.applyEvent(items, { type: "status.update", payload: {} }), false);
  M.applyEvent(items, { type: "error", payload: { message: "Model unavailable" } });
  assert.deepEqual([items.at(-1).role, items.at(-1).text], ["system", "Model unavailable"]);
});

test("a reply already in progress continues where it was", () => {
  const items = M.withInflight(M.fromHistory([{ role: "user", text: "earlier" }]), { user: "now", assistant: "Half" });
  assert.deepEqual(items.map(item => [item.role, item.text, item.streaming]), [["user", "earlier", false], ["user", "now", false], ["assistant", "Half", true]]);
  M.applyEvent(items, { type: "message.delta", payload: { text: " done" } });
  assert.equal(items.at(-1).text, "Half done");
});

test("times, sources, initials and colours read well", () => {
  const now = Date.UTC(2026, 9, 15, 12, 0, 0);
  assert.match(M.formatWhen(now / 1000 - 60, now, "en"), /\d/);
  assert.notEqual(M.formatWhen(now / 1000 - 30 * 86_400, now, "en"), "");
  assert.equal(M.formatWhen(0, now, "en"), "");
  assert.equal(M.sourceLabel("telegram"), "Telegram");
  assert.equal(M.sourceLabel("CRON"), "Cron");
  assert.equal(M.sourceLabel(""), "");
  assert.equal(M.initials("luna"), "L");
  assert.equal(M.initials("影片"), "影");
  assert.equal(M.colorFor("x", "#5b8def"), "#5b8def");
  assert.match(M.colorFor("qa-reviewer", null), /^#[0-9a-f]{6}$/);
});
