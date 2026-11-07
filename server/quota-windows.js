"use strict";
// Shared quota metadata parsers; no credentials or transport dependencies.
function windowUsage(used, reset, label, windowDurationMins = null, bucket = null) {
  if (typeof used !== "number" || !Number.isFinite(used) || used < 0 || used > 100) return null;
  const resetMs = typeof reset === "number" ? reset * 1000 : Date.parse(reset);
  return { label, windowDurationMins, bucket, usedPercent: used, remainingPercent: 100 - used, resetsAt: Number.isFinite(resetMs) ? resetMs : null };
}
// Reset windows no longer describe the current allowance.
function currentWindows(windows, now) {
  return windows.filter(w => w.resetsAt === null || w.resetsAt > now);
}
// A model's name as Claude's usage rows give it ("Fable"), held to the
// pattern Claude Code holds a plan's display name to.
const CLAUDE_MODEL_NAME = /^[\p{L}\p{N}](?:[\p{L}\p{N} .+-]{0,38}[\p{L}\p{N}+])?$/u;
const MAX_CLAUDE_MODEL_WINDOWS = 4;
// Claude's own windows (five hours, the week), then the week of each model
// it also limits apart: the usage endpoint's weekly_scoped rows ("Fable",
// shown by Claude Code as "Current week (Fable)") and its older per-model
// weeks (Opus, Sonnet) when it fills them in. A model's week stops that
// model only, so it is marked as a model's.
function claudeWindows(data) {
  const own = (value, label, minutes, bucket = null) => windowUsage(value?.utilization ?? value?.used_percentage, value?.resets_at, label, minutes, bucket);
  const rows = Array.isArray(data?.limits) ? data.limits.slice(0, 32).filter(row => row && typeof row === "object") : [];
  const plain = kind => rows.find(row => row.kind === kind && !row.scope);
  const ofRow = (row, label, minutes, bucket = null) => row ? windowUsage(row.percent, row.resets_at, label, minutes, bucket) : null;
  const windows = [own(data?.five_hour, "5 hours", 300) || ofRow(plain("session"), "5 hours", 300),
    own(data?.seven_day, "Weekly", 10080) || ofRow(plain("weekly_all"), "Weekly", 10080)].filter(Boolean);
  const named = new Set();
  const model = (name, window) => {
    if (!window || typeof name !== "string" || !CLAUDE_MODEL_NAME.test(name) || named.has(name.toLowerCase()) || named.size >= MAX_CLAUDE_MODEL_WINDOWS) return;
    named.add(name.toLowerCase());
    windows.push({ ...window, scope: "model" });
  };
  for (const row of rows) {
    const name = row.kind === "weekly_scoped" ? row.scope?.model?.display_name : null;
    if (typeof name === "string") model(name, ofRow(row, name, 10080, name));
  }
  model("Opus", own(data?.seven_day_opus, "Opus", 10080, "Opus"));
  model("Sonnet", own(data?.seven_day_sonnet, "Sonnet", 10080, "Sonnet"));
  return windows;
}
module.exports = { windowUsage, currentWindows, claudeWindows, CLAUDE_MODEL_NAME, MAX_CLAUDE_MODEL_WINDOWS };
