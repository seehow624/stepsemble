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
function claudeWindows(data) {
  return [windowUsage(data?.five_hour?.utilization ?? data?.five_hour?.used_percentage, data?.five_hour?.resets_at, "5 hours", 300),
    windowUsage(data?.seven_day?.utilization ?? data?.seven_day?.used_percentage, data?.seven_day?.resets_at, "Weekly", 10080)].filter(Boolean);
}
module.exports = { windowUsage, currentWindows, claudeWindows };
