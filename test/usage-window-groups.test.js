"use strict";
// Which of an account's windows stop it and which belong to one model, as the
// Limits cards, the strip, the menu bar and Settings show them.
const test = require("node:test"), assert = require("node:assert/strict");
const { accountWindows, windowGroups } = require("../public/modules/usage-data");

const span = (name, used, minutes) => ({ label: name, windowDurationMins: minutes, usedPercent: used, remainingPercent: 100 - used });
const model = (name, used, extra = {}) => ({ label: name, windowDurationMins: null, scope: "model", usedPercent: used, remainingPercent: 100 - used, ...extra });

test("a window for one model counts for the account only when it has no other", () => {
  const week = span("7 days", 40, 10080), fable = model("7 days · Fable", 100, { windowDurationMins: 10080, bucket: "Fable" });
  assert.deepEqual(accountWindows([week, fable]), [week]);
  assert.deepEqual(accountWindows([fable]), [fable]);
  assert.deepEqual(accountWindows(undefined), []);
});

test("a couple of model windows show beside the account's own; more fold away, the most used first", () => {
  const week = span("7 days", 40, 10080), fable = model("7 days · Fable", 2, { windowDurationMins: 10080, bucket: "Fable" });
  assert.deepEqual(windowGroups([week, fable]), { stopping: [week], inline: [fable], folded: [] });
  // Antigravity: its pools' windows stop it; its ten models' windows fold, the most used first.
  const pools = [span("Gemini · 5 hours", 4, 300), span("Gemini · 7 days", 1, 10080), span("Claude & GPT · 7 days", 100, 10080)];
  const models = [model("Gemini 4 Argon (High)", 0), model("Claude Opus 5.5 (High)", 100), model("GPT-OSS 120B (Medium)", 100)];
  const groups = windowGroups([...pools, ...models]);
  assert.deepEqual(groups.stopping, pools); assert.deepEqual(groups.inline, []);
  assert.deepEqual(groups.folded.map(w => w.label), ["Claude Opus 5.5 (High)", "GPT-OSS 120B (Medium)", "Gemini 4 Argon (High)"]);
  // With no window of its own, an account shows its four tightest models' windows; the rest fold.
  const only = ["A", "B", "C", "D", "E", "F"].map((name, index) => model(name, index * 10));
  const fallback = windowGroups(only);
  assert.deepEqual(fallback.stopping, []); assert.deepEqual(fallback.inline.map(w => w.label), ["F", "E", "D", "C"]);
  assert.deepEqual(fallback.folded.map(w => w.label), ["B", "A"]);
  assert.deepEqual(windowGroups(null), { stopping: [], inline: [], folded: [] });
});
