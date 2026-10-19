"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const A = require("../public/modules/workspace-automations");

const HOUR = 3_600_000;
test("Automations list every computer's schedules and every Bot's routines, those needing attention first, then by next run", () => {
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
    routines: { target: "mini", bots: [{ name: "default", displayName: "Nova" }], items: [
      { id: "email", profile: "default", name: "Email", enabled: true, nextRunAt: new Date(now + 2 * HOUR).toISOString(), schedule: { kind: "cron", expr: "15 3 * * *" }, lastStatus: "ok" },
      { id: "bills", profile: "default", name: "Bills", enabled: true, nextRunAt: new Date(now + 3 * HOUR).toISOString(), schedule: {}, lastStatus: "error" },
      { id: "luna", profile: "luna", name: "Reflection", enabled: false, schedule: {} },
    ] },
    scheduleLabel: spec => `S:${spec.kind}`, routineLabel: () => "R",
  });
  assert.deepEqual(rows.map(row => [row.key, row.state]), [
    ["routine:default:bills", "attention"], ["schedule:mini:full", "attention"],
    ["schedule:mbp:soon", "scheduled"], ["routine:default:email", "scheduled"], ["schedule:mini:daily", "scheduled"],
    ["routine:luna:luna", "paused"], ["schedule:mini:off", "paused"],
    ["schedule:mini:done", "finished"],
  ]);
  const email = rows.find(row => row.id === "email");
  assert.deepEqual([email.kind, email.target, email.owner, email.cadence, email.nextAt], ["routine", "mini", "Nova", "R", now + 2 * HOUR]);
  assert.equal(rows.find(row => row.id === "luna").owner, "luna", "a Bot that is not listed is named by its profile");
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

test("a routine's schedule is worded as the Bot's own Routines page words it", () => {
  const t = key => ({ daily: "Every day", weekdays: "Weekdays", interval: "Every", hours: "hours", minutes: "minutes", oneTime: "Once" })[key];
  const M = { pickerFromSchedule: schedule => schedule };
  assert.equal(A.routineCadence({ kind: "daily", time: "03:15" }, { M, t }), "Every day 03:15");
  assert.equal(A.routineCadence({ kind: "weekly", weekday: 3, time: "07:00" }, { M, t, locale: "en" }), "Wednesday 07:00");
  assert.equal(A.routineCadence({ kind: "interval", every: 2, unit: "h" }, { M, t }), "Every 2 hours");
  assert.equal(A.routineCadence({ kind: "raw", display: "*/5 * * * *" }, { M, t }), "*/5 * * * *");
});
