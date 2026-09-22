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
const OPENCODE_GO_BASE_URL = "https://opencode.ai/zen/go/v1";
const OPENCODE_GO_WINDOWS = Object.freeze([["rolling", 300], ["weekly", 10080], ["monthly", 43200]]);
// Adding a provider in Stepsemble is enough to see its allowance: the probe is
// chosen by the provider's canonical destination, so a custom base URL never
// receives a credential configured for somewhere else. Providers with no known
// usage endpoint simply do not appear.
const QUOTA_PROBES = Object.freeze([
  {
    name: "OpenCode Go", ids: ["opencode-go"],
    bases: [OPENCODE_GO_BASE_URL],
    url: OPENCODE_GO_BASE_URL + "/usage",
    parse: json => OPENCODE_GO_WINDOWS
      .map(([key, minutes]) => windowUsage(json?.usage?.[key]?.percent, json?.usage?.[key]?.resetsAt, null, minutes, null))
      .filter(Boolean),
  },
  {
    name: "MiniMax", ids: ["minimax", "minimax-cn"],
    bases: ["https://api.minimax.io/v1", "https://api.minimaxi.com/v1"],
    url: "https://api.minimax.io/v1/token_plan/remains",
    // Every model reports its own rolling and weekly allowance, and the row
    // shows whichever model is closest to running out.
    parse: json => {
      const rows = Array.isArray(json?.model_remains) ? json.model_remains : [];
      const tightest = (remainingKey, resetKey, minutes) => {
        const rows2 = rows.map(row => ({ remaining: percentValue(row?.[remainingKey]), reset: row?.[resetKey] }))
          .filter(row => row.remaining !== null);
        if (!rows2.length) return null;
        const low = rows2.reduce((a, b) => a.remaining <= b.remaining ? a : b);
        return windowUsage(100 - low.remaining, asSecondsValue(low.reset), null, minutes, null);
      };
      return [tightest("current_interval_remaining_percent", "end_time", 300),
        tightest("current_weekly_remaining_percent", "weekly_end_time", 10080)].filter(Boolean);
    },
  },
]);
function percentValue(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100 ? value : null;
}
// Credentials come from Stepsemble's own provider configuration first, then from
// another local app's, so an allowance already configured elsewhere appears
// without asking for the same key twice.
async function providerCredentials(home, osHome) {
  const files = [home && path.join(home, ".pi", "agent", "models.json"),
    osHome && path.join(osHome, ".opencodex", "config.json")];
  const rows = [];
  for (const file of files) {
    if (!file) continue;
    try {
      const providers = JSON.parse(await fs.readFile(file, "utf8"))?.providers || {};
      for (const provider of Object.values(providers)) {
        if (!provider || typeof provider !== "object") continue;
        const base = typeof provider.baseUrl === "string" ? provider.baseUrl.replace(/\/+$/, "") : "";
        const key = typeof provider.apiKey === "string" ? provider.apiKey.trim() : "";
        // Environment and command references are resolved by their owning app.
        if (!base || !key || key.startsWith("$") || key.startsWith("!")) continue;
        rows.push({ base, key });
      }
    } catch {}
  }
  return rows;
}
async function configuredProviderQuotas({ home, fetchImpl = fetch, osHome = os.homedir() } = {}) {
  const credentials = await providerCredentials(home, osHome);
  const claimed = new Set();
  const rows = await Promise.all(QUOTA_PROBES.map(async probe => {
    const credential = credentials.find(row => probe.bases.includes(row.base));
    if (!credential || claimed.has(probe.name)) return null;
    claimed.add(probe.name);
    try {
      const res = await fetchImpl(probe.url, {
        headers: { Accept: "application/json", Authorization: `Bearer ${credential.key}` },
        redirect: "error", signal: AbortSignal.timeout(12000),
      });
      if (!res.ok) return null;
      const windows = probe.parse(await res.json());
      return windows.length ? { provider: probe.name, ids: probe.ids, status: "ready", observedAt: null, source: "provider", windows } : null;
    } catch { return null; }
  }));
  // Probe order, not completion order, so rows keep their place between polls.
  return rows.filter(Boolean);
}
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
function opencodexProviders(reports, now, skip = new Set()) {
  return reports.flatMap(report => {
    const id = report?.provider;
    if (typeof id !== "string" || OPENCODEX_HANDLED_ELSEWHERE.has(id) || skip.has(id)) return [];
    const quota = report.quota || {};
    const windows = currentWindows(OPENCODEX_WINDOWS
      .map(([key, minutes]) => windowUsage(quota[`${key}Percent`], asSecondsValue(quota[`${key}ResetAt`]), null, minutes, null))
      .filter(Boolean), now);
    if (!windows.length) return [];
    return [{ provider: OPENCODEX_NAMES[id] || report.label || id, status: "ready", observedAt: null, source: "opencodex", windows }];
  });
}
function asSecondsValue(value) { return typeof value === "number" && Number.isFinite(value) ? Math.floor(value / 1000) : value; }
function createWorkspaceUsage({ home, codex, allowKeychain = false, fetchImpl = fetch, readClaudeToken = () => claudeToken(home, allowKeychain),
  readClaudeCache = () => claudeCache(home, now()), readProviderQuotas = () => configuredProviderQuotas({ home, fetchImpl }),
  readOpenCodex = () => opencodexQuotas({ home, fetchImpl }), now = Date.now }) {
  let cached = null, flight = null, expires = 0;
  function providerRow(provider, settled, observedAt = null, source = null) {
    const windows = settled.status === "fulfilled" ? (settled.value?.windows || []) : [];
    const observed = settled.status === "fulfilled" && typeof settled.value?.observedAt === "number" ? settled.value.observedAt : observedAt;
    return { provider, status: !windows.length ? "unavailable" : observed ? "cached" : "ready",
      observedAt: windows.length ? observed : null, source: windows.length ? source : null, windows };
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
      Promise.resolve().then(readProviderQuotas),
      Promise.resolve().then(readOpenCodex),
    ]);
    // A probed allowance wins over a borrowed one, so the same provider is never
    // listed twice and the row does not depend on another app being up.
    const probed = sources[2].status === "fulfilled" ? sources[2].value : [];
    const borrowed = sources[3].status === "fulfilled" ? sources[3].value : [];
    const providers = [providerRow("Codex", sources[0], null, "native"), providerRow("Claude", sources[1], null, "native"),
      ...probed.map(({ ids, ...row }) => row),
      ...opencodexProviders(borrowed, now(), new Set(probed.flatMap(row => row.ids || [])))];
    cached = { updatedAt: now(), providers };
    // A reading that came from a cache is retried sooner than a live one.
    expires = now() + (providers.every(p => p.status === "ready") ? 300000 : 60000);
    return cached;
  }
  return { read() { if (cached && now() < expires) return Promise.resolve(cached); if (!flight) flight = collect().finally(() => flight = null); return flight; } };
}
module.exports = { createWorkspaceUsage, windowUsage, codexWindows, claudeWindows, currentWindows, keychainHome, opencodexProviders, opencodexQuotas, configuredProviderQuotas, providerCredentials, QUOTA_PROBES };
