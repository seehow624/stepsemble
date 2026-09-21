"use strict";
const fs = require("node:fs/promises"), path = require("node:path");
const { execFile } = require("node:child_process");
function windowUsage(used, reset, label, windowDurationMins = null, bucket = null) {
  if (typeof used !== "number" || !Number.isFinite(used) || used < 0 || used > 100) return null;
  const resetMs = typeof reset === "number" ? reset * 1000 : Date.parse(reset);
  return { label, windowDurationMins, bucket, usedPercent: used, remainingPercent: 100 - used, resetsAt: Number.isFinite(resetMs) ? resetMs : null };
}
function codexWindows(data) {
  const buckets = data?.rateLimitsByLimitId ? Object.entries(data.rateLimitsByLimitId) : [["codex", data?.rateLimits]];
  return buckets.flatMap(([name, b]) => [b?.primary, b?.secondary].map(w => windowUsage(w?.usedPercent, w?.resetsAt,
    `${name} · ${w?.windowDurationMins || "?"} minutes`, w?.windowDurationMins ?? null, name))).filter(Boolean);
}
async function claudeToken(home, allowKeychain) {
  try { const raw = await fs.readFile(path.join(home, ".claude", ".credentials.json"), "utf8"); return JSON.parse(raw)?.claudeAiOauth?.accessToken || null; } catch {}
  if (!allowKeychain || process.platform !== "darwin") return null;
  return new Promise(resolve => execFile("/usr/bin/security", ["find-generic-password", "-s", "Claude Code-credentials", "-w"], { timeout: 5000, maxBuffer: 65536 }, (error, stdout) => {
    if (error) return resolve(null);
    try { resolve(JSON.parse(stdout)?.claudeAiOauth?.accessToken || null); } catch { resolve(null); }
  }));
}
function createWorkspaceUsage({ home, codex, allowKeychain = false, fetchImpl = fetch, readClaudeToken = () => claudeToken(home, allowKeychain), now = Date.now }) {
  let cached = null, flight = null, expires = 0;
  async function collect() {
    const sources = await Promise.allSettled([
      Promise.resolve().then(codex).then(codexWindows),
      (async () => {
        const token = await readClaudeToken(); if (!token) throw new Error("unavailable");
        const res = await fetchImpl("https://api.anthropic.com/api/oauth/usage", { headers: { Authorization: `Bearer ${token}`, "anthropic-beta": "oauth-2025-04-20" }, signal: AbortSignal.timeout(10000) });
        if (!res.ok) throw new Error("unavailable");
        const data = await res.json();
        return [windowUsage(data.five_hour?.utilization ?? data.five_hour?.used_percentage, data.five_hour?.resets_at, "5 hours", 300),
          windowUsage(data.seven_day?.utilization ?? data.seven_day?.used_percentage, data.seven_day?.resets_at, "Weekly", 10080)].filter(Boolean);
      })(),
    ]);
    cached = { updatedAt: now(), providers: sources.map((result, index) => ({ provider: index === 0 ? "Codex" : "Claude",
      status: result.status === "fulfilled" && result.value.length ? "ready" : "unavailable", windows: result.status === "fulfilled" ? result.value : [] })) };
    expires = now() + (sources.every(r => r.status === "fulfilled") ? 300000 : 60000);
    return cached;
  }
  return { read() { if (cached && now() < expires) return Promise.resolve(cached); if (!flight) flight = collect().finally(() => flight = null); return flight; } };
}
module.exports = { createWorkspaceUsage, windowUsage, codexWindows };
