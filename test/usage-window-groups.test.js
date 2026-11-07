"use strict";
// Which of an account's windows stop it and which belong to a pool or to one
// model, as the Limits cards, the strip, the menu bar and Settings show them.
const test = require("node:test"), assert = require("node:assert/strict");
const { accountWindows, windowGroups } = require("../public/modules/usage-data");

const span = (name, used, minutes) => ({ label: name, windowDurationMins: minutes, usedPercent: used, remainingPercent: 100 - used });
const model = (name, used, extra = {}) => ({ label: name, windowDurationMins: null, scope: "model", usedPercent: used, remainingPercent: 100 - used, ...extra });
const pool = (name, minutes, used) => ({ label: name + " · " + (minutes === 300 ? "5 hours" : "7 days"), windowDurationMins: minutes, bucket: name, scope: "pool", usedPercent: used, remainingPercent: 100 - used });

test("a window for one model counts for the account only when it has no other", () => {
  const week = span("7 days", 40, 10080), fable = model("7 days · Fable", 100, { windowDurationMins: 10080, bucket: "Fable" });
  assert.deepEqual(accountWindows([week, fable]), [week]);
  assert.deepEqual(accountWindows([fable]), [fable]);
  assert.deepEqual(accountWindows(undefined), []);
  // A pool's window speaks for an account with none of its own, before a model's.
  const shared = pool("Gemini", 300, 4);
  assert.deepEqual(accountWindows([fable, shared]), [shared]); assert.deepEqual(accountWindows([week, shared, fable]), [week]);
});

test("an account without its own windows shows its two tightest pools; a couple of others show beside its own; the rest fold away", () => {
  const week = span("7 days", 40, 10080), fable = model("7 days · Fable", 2, { windowDurationMins: 10080, bucket: "Fable" });
  assert.deepEqual(windowGroups([week, fable]), { stopping: [week], inline: [fable], folded: [] });
  // Antigravity: no window of its own. Its two pools closest to running out show, each by its
  // tightest window; its other windows and its models' fold, pools first, the most used first.
  const pools = [pool("Gemini", 300, 4), pool("Gemini", 10080, 1), pool("Claude & GPT", 10080, 100), pool("Gemini 4 Argon", 10080, 0)];
  const models = [model("Gemini 4 Argon (High)", 0), model("Claude Opus 5.5 (High)", 100), model("GPT-OSS 120B (Medium)", 100)];
  const groups = windowGroups([...pools, ...models]);
  assert.deepEqual(groups.stopping, []);
  assert.deepEqual(groups.inline.map(w => w.label), ["Claude & GPT · 7 days", "Gemini · 5 hours"], "one window a pool, the two tightest pools");
  assert.deepEqual(groups.folded.map(w => w.label), ["Gemini · 7 days", "Gemini 4 Argon · 7 days", "Claude Opus 5.5 (High)", "GPT-OSS 120B (Medium)", "Gemini 4 Argon (High)"]);
  // Beside an account's own windows, a pool's or a model's shows only while there are no more than two.
  assert.deepEqual(windowGroups([week, pools[0], fable]).inline, [pools[0], fable]);
  assert.deepEqual(windowGroups([week, ...pools]).inline, []);
  // With neither, an account shows its two tightest models' windows; the rest fold.
  const only = ["A", "B", "C", "D", "E", "F"].map((name, index) => model(name, index * 10));
  const fallback = windowGroups(only);
  assert.deepEqual(fallback.stopping, []); assert.deepEqual(fallback.inline.map(w => w.label), ["F", "E"]);
  assert.deepEqual(fallback.folded.map(w => w.label), ["D", "C", "B", "A"]);
  assert.deepEqual(windowGroups(null), { stopping: [], inline: [], folded: [] });
});
