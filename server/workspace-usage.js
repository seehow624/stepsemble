"use strict";
const fs = require("node:fs/promises"), fss = require("node:fs"), os = require("node:os"), path = require("node:path");
const { execFile } = require("node:child_process");
// opencodex already probes every provider it routes and publishes the results on
// its loopback management API. Reading that endpoint keeps provider credentials
// and probes out of Stepsemble, and it is the only source for allowances that
// have no local CLI of their own, such as an OpenCode Go subscription.
const OPENCODEX_PORT = 10100;
const OPENCODEX_WINDOWS = Object.freeze([["fiveHour", 300], ["weekly", 10080], ["monthly", 43200]]);
const OPENCODEX_NAMES = Object.freeze({ "opencode-go": "OpenCode Go", "opencode-free": "OpenCode Zen", "minimax": "MiniMax", "minimax-cn": "MiniMax" });
// Providers Stepsemble reads directly keep that fresher source instead.
const OPENCODEX_HANDLED_ELSEWHERE = new Set(["anthropic", "openai"]);
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
// A window whose reset time has already passed is no longer described by the
// reading it came from: its allowance started over. Keeping such a window is
// how a day-old snapshot ends up presenting 100% remaining for a window that is
// in fact exhausted.
function currentWindows(windows, now) {
  return windows.filter(w => w.resetsAt === null || w.resetsAt > now);
}
// The keychain belongs to the console user, so it is only read for that user's
// home - directly, or through a symlink such as an isolated preview home that
// resolves to the same .claude directory.
function keychainHome(home, { osHome = os.homedir(), realpath = fss.realpathSync } = {}) {
  if (!home || !osHome) return false;
  if (path.resolve(home) === path.resolve(osHome)) return true;
  try {
    return realpath(path.join(path.resolve(home), ".claude")) === realpath(path.join(path.resolve(osHome), ".claude"));
  } catch { return false; }
}
function claudeWindows(data) {
  return [windowUsage(data?.five_hour?.utilization ?? data?.five_hour?.used_percentage, data?.five_hour?.resets_at, "5 hours", 300),
    windowUsage(data?.seven_day?.utilization ?? data?.seven_day?.used_percentage, data?.seven_day?.resets_at, "Weekly", 10080)].filter(Boolean);
}
// Claude Code caches its own utilization snapshot next to its settings. Reading
// that file needs no credential and no keychain prompt, but it is only as
// current as its own timestamp, so it travels with the time it was observed.
async function claudeCache(home, now) {
  if (!home) return null;
  try {
    const raw = await fs.readFile(path.join(home, ".claude.json"), "utf8");
    const cache = JSON.parse(raw)?.cachedUsageUtilization;
    const windows = currentWindows(claudeWindows(cache?.utilization), now);
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
// The management API needs the admin token and the port the service actually
// bound, both of which live beside the user's opencodex configuration.
async function opencodexQuotas({ home, fetchImpl = fetch, osHome = os.homedir(), env = process.env } = {}) {
  const directories = [env.OPENCODEX_HOME, path.join(osHome, ".opencodex"), home && path.join(home, ".opencodex")].filter(Boolean);
  let directory = null, token = null;
  for (const candidate of directories) {
    try {
      const value = (await fs.readFile(path.join(candidate, "admin-api-token"), "utf8")).trim();
      if (value) { directory = candidate; token = value; break; }
    } catch {}
  }
  if (!token) return [];
  let port = OPENCODEX_PORT;
  try {
    const bound = JSON.parse(await fs.readFile(path.join(directory, "runtime-port.json"), "utf8"))?.port;
    if (Number.isInteger(bound) && bound > 0 && bound < 65536) port = bound;
  } catch {}
  const res = await fetchImpl(`http://127.0.0.1:${port}/api/provider-quotas`, {
    headers: { Accept: "application/json", Authorization: `Bearer ${token}` }, redirect: "error", signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error("unavailable");
  const reports = (await res.json())?.reports;
  return Array.isArray(reports) ? reports : [];
}
// One row per provider opencodex knows about that Stepsemble cannot read itself.
function opencodexProviders(reports, now) {
  return reports.flatMap(report => {
    const id = report?.provider;
    if (typeof id !== "string" || OPENCODEX_HANDLED_ELSEWHERE.has(id)) return [];
    const quota = report.quota || {};
    const windows = currentWindows(OPENCODEX_WINDOWS
      .map(([key, minutes]) => windowUsage(quota[`${key}Percent`], asSecondsValue(quota[`${key}ResetAt`]), null, minutes, null))
      .filter(Boolean), now);
    if (!windows.length) return [];
    return [{ provider: OPENCODEX_NAMES[id] || report.label || id, status: "ready", observedAt: null, windows }];
  });
}
function asSecondsValue(value) { return typeof value === "number" && Number.isFinite(value) ? Math.floor(value / 1000) : value; }
function createWorkspaceUsage({ home, codex, allowKeychain = false, fetchImpl = fetch, readClaudeToken = () => claudeToken(home, allowKeychain),
  readClaudeCache = () => claudeCache(home, now()), readOpenCodex = () => opencodexQuotas({ home, fetchImpl }), now = Date.now }) {
  let cached = null, flight = null, expires = 0;
  function providerRow(provider, settled, observedAt = null) {
    const windows = settled.status === "fulfilled" ? (settled.value?.windows || []) : [];
    const observed = settled.status === "fulfilled" && typeof settled.value?.observedAt === "number" ? settled.value.observedAt : observedAt;
    return { provider, status: !windows.length ? "unavailable" : observed ? "cached" : "ready",
      observedAt: windows.length ? observed : null, windows };
  }
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
      Promise.resolve().then(readOpenCodex).then(reports => opencodexProviders(reports, now())),
    ]);
    const providers = [providerRow("Codex", sources[0]), providerRow("Claude", sources[1]),
      ...(sources[2].status === "fulfilled" ? sources[2].value : [])];
    cached = { updatedAt: now(), providers };
    // A reading that came from a cache is retried sooner than a live one.
    expires = now() + (providers.every(p => p.status === "ready") ? 300000 : 60000);
    return cached;
  }
  return { read() { if (cached && now() < expires) return Promise.resolve(cached); if (!flight) flight = collect().finally(() => flight = null); return flight; } };
}
module.exports = { createWorkspaceUsage, windowUsage, codexWindows, claudeWindows, currentWindows, keychainHome, opencodexProviders, opencodexQuotas };
