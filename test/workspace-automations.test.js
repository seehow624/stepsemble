"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const A = require("../public/modules/workspace-automations");

const HOUR = 3_600_000;
test("Automations list every computer's schedules, those needing attention first, then by next run", () => {
  const now = Date.UTC(2026, 9, 19, 12);
  const rows = A.collect({
    schedules: [
      { target: "mini", owner: "Mac Mini", items: [
        { id: "daily", title: "Daily check", enabled: true, nextAt: now + 5 * HOUR, schedule: { kind: "daily", time: "09:00" }, agentId: "pi" },
        { id: "off", title: "Weekly report", enabled: false, schedule: { kind: "weekly", time: "10:00", days: [1] } },
        { id: "done", title: "Once", enabled: false, schedule: { kind: "once", at: now - HOUR }, lastRunId: "run-1" },
        { id: "full", title: "Blocked", enabled: true, nextAt: now + 9 * HOUR, capacityBlocked: true, schedule: { kind: "daily", time: "21:00" } },
      ] },
      { target: "mbp", owner: "MacBook Pro", items: [{ id: "soon", title: "Soon", enabled: true, nextAt: now + HOUR, schedule: { kind: "interval", minutes: 30 } }] },
    ],
    scheduleLabel: spec => `S:${spec.kind}`,
  });
  assert.deepEqual(rows.map(row => [row.key, row.state]), [
    ["schedule:mini:full", "attention"],
    ["schedule:mbp:soon", "scheduled"], ["schedule:mini:daily", "scheduled"],
    ["schedule:mini:off", "paused"],
    ["schedule:mini:done", "finished"],
  ]);
  const soon = rows.find(row => row.id === "soon");
  assert.deepEqual([soon.kind, soon.target, soon.owner, soon.cadence], ["schedule", "mbp", "MacBook Pro", "S:interval"]);
  assert.equal(rows.find(row => row.id === "off").nextAt, null, "a paused schedule has no next run");
  assert.deepEqual(A.collect(), []);
});

test("the next run reads today, tomorrow, a weekday this week, or a date", () => {
  const now = new Date(2026, 9, 19, 10, 0).getTime(), at = (days, hours) => new Date(2026, 9, 19 + days, hours, 15).getTime();
  assert.equal(A.nextLabel(at(0, 21), now, "en"), "today 21:15");
  assert.equal(A.nextLabel(at(1, 3), now, "en"), "tomorrow 03:15");
  assert.equal(A.nextLabel(at(1, 3), now, "zh-Hant"), "明天 03:15");
  assert.match(A.nextLabel(at(3, 7), now, "en"), /^Thu 07:15$/);
  assert.match(A.nextLabel(at(20, 9), now, "en"), /^Nov 8 09:15$/);
  assert.equal(A.nextLabel(NaN, now, "en"), "");
});
