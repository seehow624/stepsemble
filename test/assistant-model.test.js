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

test("the schedule picker writes Hermes schedules and reads them back", () => {
  assert.equal(M.scheduleFromPicker({ kind: "daily", time: "07:05" }), "5 7 * * *");
  assert.equal(M.scheduleFromPicker({ kind: "weekdays", time: "09:00" }), "0 9 * * 1-5");
  assert.equal(M.scheduleFromPicker({ kind: "weekly", time: "18:30", weekday: "0" }), "30 18 * * 0");
  assert.equal(M.scheduleFromPicker({ kind: "interval", every: "2", unit: "h" }), "every 2h");
  assert.equal(M.scheduleFromPicker({ kind: "interval", every: "0", unit: "m" }), "every 1m");
  assert.equal(M.scheduleFromPicker({ kind: "once", at: "2026-10-16T09:00" }), "2026-10-16T09:00");
  assert.equal(M.scheduleFromPicker({ kind: "advanced", raw: "  0 */3 * * * " }), "0 */3 * * *");
  assert.deepEqual(M.pickerFromSchedule({ kind: "cron", expr: "15 3 * * *" }), { kind: "daily", time: "03:15" });
  assert.deepEqual(M.pickerFromSchedule({ kind: "cron", expr: "0 9 * * 1-5" }), { kind: "weekdays", time: "09:00" });
  assert.deepEqual(M.pickerFromSchedule({ kind: "cron", expr: "30 18 * * 0" }), { kind: "weekly", time: "18:30", weekday: 0 });
  assert.deepEqual(M.pickerFromSchedule({ kind: "interval", minutes: 120 }), { kind: "interval", every: 2, unit: "h" });
  assert.deepEqual(M.pickerFromSchedule({ kind: "interval", minutes: 45 }), { kind: "interval", every: 45, unit: "m" });
  assert.deepEqual(M.pickerFromSchedule({ kind: "once", runAt: "2026-10-16T09:00:00+08:00" }), { kind: "once", at: "2026-10-16T09:00" });
  assert.deepEqual(M.pickerFromSchedule({ kind: "cron", expr: "0 */3 * * *", display: "0 */3 * * *" }), { kind: "advanced", raw: "0 */3 * * *" });
});

test("delivery targets toggle without disturbing the others", () => {
  assert.deepEqual(M.deliverTokens(" telegram:1, bot-chat ,telegram:1"), ["telegram:1", "bot-chat"]);
  assert.equal(M.withDeliver("telegram:586668748", "bot-chat", true), "telegram:586668748,bot-chat");
  assert.equal(M.withDeliver("telegram:586668748,bot-chat", "bot-chat", false), "telegram:586668748");
  assert.equal(M.withDeliver("local", "bot-chat", true), "bot-chat");
  assert.equal(M.withDeliver("bot-chat", "bot-chat", false), "local");
  assert.equal(M.routineName("[bot:qa-reviewer] Nightly check"), "Nightly check");
  assert.equal(M.routineName("Setel Email Auto-Processor"), "Setel Email Auto-Processor");
});
