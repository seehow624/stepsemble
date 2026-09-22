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
function claudeWindows(data) {
  return [windowUsage(data?.five_hour?.utilization ?? data?.five_hour?.used_percentage, data?.five_hour?.resets_at, "5 hours", 300),
    windowUsage(data?.seven_day?.utilization ?? data?.seven_day?.used_percentage, data?.seven_day?.resets_at, "Weekly", 10080)].filter(Boolean);
}
// Claude Code caches its own utilization snapshot next to its settings. Reading
// that file needs no credential and no keychain prompt, but it is only as
// current as its own timestamp, so it travels with the time it was observed.
async function claudeCache(home) {
  if (!home) return null;
  try {
    const raw = await fs.readFile(path.join(home, ".claude.json"), "utf8");
    const cache = JSON.parse(raw)?.cachedUsageUtilization;
    const windows = claudeWindows(cache?.utilization);
    if (!windows.length) return null;
    return { windows, observedAt: typeof cache?.fetchedAtMs === "number" ? cache.fetchedAtMs : null };
  } catch { return null; }
}
async function claudeToken(home, allowKeychain) {
  try { const raw = await fs.readFile(path.join(home, ".claude", ".credentials.json"), "utf8"); return JSON.parse(raw)?.claudeAiOauth?.accessToken || null; } catch {}
  if (!allowKeychain || process.platform !== "darwin") return null;
  return new Promise(resolve => execFile("/usr/bin/security", ["find-generic-password", "-s", "Claude Code-credentials", "-w"], { timeout: 5000, maxBuffer: 65536 }, (error, stdout) => {
    if (error) return resolve(null);
    try { resolve(JSON.parse(stdout)?.claudeAiOauth?.accessToken || null); } catch { resolve(null); }
  }));
}
function createWorkspaceUsage({ home, codex, allowKeychain = false, fetchImpl = fetch, readClaudeToken = () => claudeToken(home, allowKeychain),
  readClaudeCache = () => claudeCache(home), now = Date.now }) {
  let cached = null, flight = null, expires = 0;
  async function collect() {
    const sources = await Promise.allSettled([
      Promise.resolve().then(codex).then(codexWindows).then(windows => ({ windows, observedAt: null })),
      (async () => {
        // Prefer the live account reading; fall back to Claude's own cache so a
        // host without keychain access still reports something it observed.
        try {
          const token = await readClaudeToken();
          if (token) {
            const res = await fetchImpl("https://api.anthropic.com/api/oauth/usage", { headers: { Authorization: `Bearer ${token}`, "anthropic-beta": "oauth-2025-04-20" }, signal: AbortSignal.timeout(10000) });
            if (res.ok) {
              const windows = claudeWindows(await res.json());
              if (windows.length) return { windows, observedAt: null };
            }
          }
        } catch {}
        const fallback = await readClaudeCache();
        if (fallback) return fallback;
        throw new Error("unavailable");
      })(),
    ]);
    const providers = sources.map((result, index) => {
      const value = result.status === "fulfilled" ? result.value : null;
      const windows = value?.windows || [];
      const observedAt = windows.length && typeof value.observedAt === "number" ? value.observedAt : null;
      return { provider: index === 0 ? "Codex" : "Claude",
        status: !windows.length ? "unavailable" : observedAt ? "cached" : "ready", observedAt, windows };
    });
    cached = { updatedAt: now(), providers };
    // A reading that came from a cache is retried sooner than a live one.
    expires = now() + (providers.every(p => p.status === "ready") ? 300000 : 60000);
    return cached;
  }
  return { read() { if (cached && now() < expires) return Promise.resolve(cached); if (!flight) flight = collect().finally(() => flight = null); return flight; } };
}
module.exports = { createWorkspaceUsage, windowUsage, codexWindows, claudeWindows };
