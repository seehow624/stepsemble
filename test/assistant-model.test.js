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
    { type: "reasoning.delta", payload: { text: "checking" } },
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

test("the thinking shown is the Bot's own reasoning, never Hermes's waiting line", () => {
  const items = [];
  M.applyEvent(items, { type: "message.start", payload: {} });
  assert.equal(M.applyEvent(items, { type: "thinking.delta", payload: { text: "(◕‿◕) pondering..." } }), false);
  M.applyEvent(items, { type: "message.delta", payload: { text: "42" } });
  // A Bot that does not show its reasoning while it thinks still gives it at the end.
  M.applyEvent(items, { type: "message.complete", payload: { text: "42", reasoning: "Six times seven." } });
  assert.deepEqual([items[0].text, items[0].thinking], ["42", "Six times seven."]);
  const reopened = M.fromHistory([{ role: "assistant", text: "42", thinking: "Six times seven." },
    { role: "system", kind: "delegation", text: "Subagent Task Completed: vendors" }]);
  assert.deepEqual(reopened.map(item => [item.role, item.thinking, item.kind]), [["assistant", "Six times seven.", ""], ["system", "", "delegation"]]);
});

test("while Hermes compacts a long conversation the answer says so, and only then", () => {
  const items = [];
  assert.equal(M.applyEvent(items, { type: "status.update", payload: { kind: "compacting", text: "Compacting context…" } }), false, "no turn, nothing to mark");
  M.applyEvent(items, { type: "message.start", payload: {} });
  assert.equal(M.applyEvent(items, { type: "status.update", payload: { kind: "compacting", text: "Compacting context…" } }), true);
  assert.equal(items[0].status, "compacting");
  assert.equal(M.applyEvent(items, { type: "status.update", payload: { kind: "heartbeat", text: "still here" } }), false);
  assert.equal(items[0].status, "compacting");
  M.applyEvent(items, { type: "status.update", payload: { kind: "compacted", text: "Compaction complete" } });
  assert.equal(items[0].status, "");
  M.applyEvent(items, { type: "status.update", payload: { kind: "compacting", text: "Compacting context…" } });
  M.applyEvent(items, { type: "tool.start", payload: { tool_id: "t1", name: "search" } });
  assert.equal(items[0].status, "", "work going on means the compaction is over");
  // Background work finishing is a notice of its own.
  M.applyEvent(items, { type: "status.update", payload: { kind: "process", text: "Subagent Task Completed: vendors" } });
  assert.deepEqual([items.at(-1).role, items.at(-1).kind, items.at(-1).text], ["system", "process", "Subagent Task Completed: vendors"]);
});

test("a message the Bot took into its work moves what it does next below that message", () => {
  const items = M.fromHistory([{ role: "user", text: "research this" }]);
  M.applyEvent(items, { type: "message.start", payload: {} });
  M.applyEvent(items, { type: "tool.start", payload: { tool_id: "t1", name: "search" } });
  const before = items.at(-1), sent = M.userItem("also check prices");
  items.push(sent);
  sent.delivery = "steered";
  M.continueBelow(items);
  assert.deepEqual(items.map(item => [item.role, item.streaming]), [["user", false], ["assistant", false], ["user", false], ["assistant", true]]);
  // The step that was running ends where it began; the answer comes below.
  M.applyEvent(items, { type: "tool.complete", payload: { tool_id: "t1", name: "search", summary: "3 results" } });
  assert.deepEqual(before.tools.map(tool => [tool.done, tool.result]), [[true, "3 results"]]);
  M.applyEvent(items, { type: "message.delta", payload: { text: "Both done." } });
  M.applyEvent(items, { type: "message.complete", payload: { text: "Both done." } });
  assert.deepEqual([items.at(-1).text, before.text, sent.delivery], ["Both done.", "", ""]);
  // An answer already being written stays in one piece; one with nothing yet just moves.
  const writing = M.fromHistory([]);
  M.applyEvent(writing, { type: "message.start", payload: {} });
  M.applyEvent(writing, { type: "message.delta", payload: { text: "Half" } });
  writing.push(M.userItem("more"));
  M.continueBelow(writing);
  assert.deepEqual(writing.map(item => [item.role, item.text]), [["assistant", "Half"], ["user", "more"]]);
  const empty = M.fromHistory([]);
  M.applyEvent(empty, { type: "message.start", payload: {} });
  empty.push(M.userItem("hello?"));
  M.continueBelow(empty);
  assert.deepEqual(empty.map(item => [item.role, item.streaming]), [["user", false], ["assistant", true]]);
});

test("a waiting message is marked until its turn starts, and Stop drops it", () => {
  const items = [];
  M.applyEvent(items, { type: "message.start", payload: {} });
  const first = M.userItem("one"), second = M.userItem("two");
  first.delivery = second.delivery = "queued";
  items.push(first);
  M.applyEvent(items, { type: "message.complete", payload: { text: "done" } });
  assert.equal(first.delivery, "queued", "still waiting after the turn it came during");
  M.applyEvent(items, { type: "message.start", payload: {} });
  assert.equal(first.delivery, "");
  items.push(second);
  M.dropQueued(items);
  assert.equal(second.delivery, "dropped");
  // A turn's end is news even when this page did not see it begin.
  assert.equal(M.applyEvent([], { type: "message.complete", payload: { text: "x" } }), true);
});

test("each message keeps the time it was written, for its bubble", () => {
  // Hermes's history gives seconds; the Host's events milliseconds.
  const items = M.fromHistory([{ role: "user", text: "hi", at: 1_760_000_000 }, { role: "assistant", text: "Hello", at: 1_760_000_005 }, { role: "assistant", text: "no time" }]);
  assert.deepEqual(items.map(item => item.at), [1_760_000_000_000, 1_760_000_005_000, 0]);
  M.applyEvent(items, { type: "message.start", payload: {} });
  M.applyEvent(items, { type: "message.delta", payload: { text: "Do" } });
  assert.equal(items.at(-1).at, 0, "an answer still being written has no time yet");
  M.applyEvent(items, { type: "message.complete", payload: { text: "Done" }, at: 1_760_000_100_000 });
  assert.equal(items.at(-1).at, 1_760_000_100_000, "the time the Host recorded its end");
  assert.ok(M.userItem("now").at >= Date.now() - 1000, "the person's message, when it was sent");
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

test("a new Bot's name suggests the same profile id the server accepts", () => {
  const { profileIdFor } = require("../server/hermes-bots");
  for (const label of ["Research Buddy", "  QA_Reviewer 2 ", "影像", "--Luna--"]) assert.equal(M.profileIdFor(label), profileIdFor(label), label);
  assert.equal(M.profileIdFor("Research Buddy"), "research-buddy");
});
