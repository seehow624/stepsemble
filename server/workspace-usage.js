"use strict";
const { normalizeQuotaConfig } = require("./quota-sources");
const fs = require("node:fs/promises"), fss = require("node:fs"), os = require("node:os"), path = require("node:path");
const { execFile } = require("node:child_process");
// opencodex already probes every provider it routes and publishes the results on
// its loopback management API. Reading that endpoint keeps provider credentials
// and probes out of Stepsemble, and it is the only source for allowances that
// have no local CLI of their own, such as an OpenCode Go subscription.
const OPENCODEX_PORT = 10100;
const OPENCODEX_WINDOWS = Object.freeze([["fiveHour", 300], ["weekly", 10080], ["monthly", 43200]]);
const OPENCODEX_NAMES = Object.freeze({ "opencode-go": "OpenCode Go", "opencode-free": "OpenCode Zen", "minimax": "MiniMax", "minimax-cn": "MiniMax (China)" });
// Providers Stepsemble reads directly keep that fresher source instead.
const OPENCODEX_HANDLED_ELSEWHERE = new Set(["anthropic", "openai"]);
const OPENCODE_GO_BASE_URL = "https://opencode.ai/zen/go/v1";
const OPENCODE_GO_WINDOWS = Object.freeze([["rolling", 300], ["weekly", 10080], ["monthly", 43200]]);
// MiniMax's international and China platforms issue separate keys, and each
// key is only valid on its own platform's host.
const MINIMAX_BASE_URL = "https://api.minimax.io/v1";
const MINIMAX_CN_BASE_URL = "https://api.minimaxi.com/v1";
// ChatGPT reports an account's Codex allowance on the usage endpoint the Codex
// CLI itself reads. Reading it directly does not depend on the CLI's
// app-server schema, which changes with Codex releases.
const CHATGPT_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const CHATGPT_AUTH_CLAIM = "https://api.openai.com/auth";
const ANTHROPIC_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
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
  { name: "MiniMax", ids: ["minimax"], bases: [MINIMAX_BASE_URL], url: MINIMAX_BASE_URL + "/token_plan/remains", parse: minimaxWindows },
  { name: "MiniMax (China)", ids: ["minimax-cn"], bases: [MINIMAX_CN_BASE_URL], url: MINIMAX_CN_BASE_URL + "/token_plan/remains", parse: minimaxWindows },
]);
// An API key saved under Settings sits in Pi's credential store under the
// provider's own id, and Pi only sends it to that provider's API.
const SAVED_KEY_BASES = Object.freeze({ "opencode-go": OPENCODE_GO_BASE_URL, minimax: MINIMAX_BASE_URL, "minimax-cn": MINIMAX_CN_BASE_URL });
function percentValue(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100 ? value : null;
}
// Every MiniMax model reports its own rolling and weekly allowance, and the row
// shows whichever model is closest to running out.
function minimaxWindows(json) {
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
// Settings sign-ins are stored by Pi in ~/.pi/agent/auth.json. A saved OAuth
// token comes back with its expiry for the caller to judge. A key that runs a
// command or refers to an environment variable is Pi's to resolve, so it is
// never run or sent from here.
async function storedSignIn(home, providerId) {
  if (!home || typeof providerId !== "string" || !providerId) return null;
  let saved;
  try { saved = JSON.parse(await fs.readFile(path.join(home, ".pi", "agent", "auth.json"), "utf8"))?.[providerId]; }
  catch { return null; }
  if (saved?.type === "oauth" && typeof saved.access === "string" && saved.access) {
    return { type: "oauth", secret: saved.access,
      accountId: typeof saved.accountId === "string" && saved.accountId ? saved.accountId : null,
      expiresAt: typeof saved.expires === "number" && Number.isFinite(saved.expires) ? saved.expires : null };
  }
  const key = saved?.type === "api_key" && typeof saved.key === "string" ? saved.key.trim() : "";
  return key && !key.startsWith("!") && !key.includes("$") ? { type: "api_key", secret: key } : null;
}
async function savedKeyCredentials(readSignIn) {
  const rows = [];
  for (const [id, base] of Object.entries(SAVED_KEY_BASES)) {
    try {
      const saved = await readSignIn(id);
      if (saved?.type === "api_key" && typeof saved.secret === "string" && saved.secret) rows.push({ base, key: saved.secret });
    } catch {}
  }
  return rows;
}
async function configuredProviderQuotas({ home, fetchImpl = fetch, osHome = os.homedir(), readSignIn = id => storedSignIn(home, id) } = {}) {
  const credentials = [...await savedKeyCredentials(readSignIn), ...await providerCredentials(home, osHome)];
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
function jwtPayload(token) {
  const part = typeof token === "string" ? token.split(".")[1] : "";
  if (!part) return null;
  try {
    const value = JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
    return value && typeof value === "object" ? value : null;
  } catch { return null; }
}
function chatgptAccountId(token) {
  const id = jwtPayload(token)?.[CHATGPT_AUTH_CLAIM]?.chatgpt_account_id;
  return typeof id === "string" && id ? id : null;
}
// An expired token is never sent; the app that owns the sign-in renews it.
function liveToken(credential, now) {
  if (credential?.type !== "oauth" || typeof credential.secret !== "string" || !credential.secret) return false;
  if (typeof credential.expiresAt === "number" && credential.expiresAt <= now) return false;
  const exp = jwtPayload(credential.secret)?.exp;
  return !(typeof exp === "number" && exp * 1000 <= now);
}
// The Codex CLI's own ChatGPT sign-in. It is only ever read: renewing it here
// would rotate the CLI's refresh token and sign Codex out.
async function codexSignIn(home, env = {}) {
  const dir = typeof env.CODEX_HOME === "string" && env.CODEX_HOME ? path.resolve(env.CODEX_HOME) : home ? path.join(home, ".codex") : null;
  if (!dir) return null;
  try {
    const tokens = JSON.parse(await fs.readFile(path.join(dir, "auth.json"), "utf8"))?.tokens;
    if (typeof tokens?.access_token !== "string" || !tokens.access_token) return null;
    return { type: "oauth", secret: tokens.access_token, expiresAt: null,
      accountId: typeof tokens.account_id === "string" && tokens.account_id ? tokens.account_id : null };
  } catch { return null; }
}
// ChatGPT's usage payload: the account's Codex windows plus any separately
// metered limits, keyed the way the app-server keys its rate-limit buckets.
function chatgptWindows(data) {
  const rows = [];
  const add = (bucket, limit) => {
    for (const w of [limit?.primary_window, limit?.secondary_window]) {
      const seconds = w?.limit_window_seconds;
      const minutes = typeof seconds === "number" && Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds / 60) : null;
      const row = windowUsage(w?.used_percent, w?.reset_at, `${bucket} · ${minutes || "?"} minutes`, minutes, bucket);
      if (row) rows.push(row);
    }
  };
  add("codex", data?.rate_limit);
  for (const extra of Array.isArray(data?.additional_rate_limits) ? data.additional_rate_limits : []) {
    const id = [extra?.metered_feature, extra?.limit_name].find(value => typeof value === "string" && value.trim());
    if (id) add(id.trim().slice(0, 64), extra.rate_limit);
  }
  return rows;
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
// `readSignIn(providerId)` returns a Settings sign-in. The server passes one
// that renews an expiring OAuth token through Pi; the default only reads.
function createWorkspaceUsage({ home, codex, env = {}, allowKeychain = false, fetchImpl = fetch, readClaudeToken = () => claudeToken(home, allowKeychain),
  readClaudeCache = () => claudeCache(home, now()), readCodexSignIn = () => codexSignIn(home, env),
  readSignIn = providerId => storedSignIn(home, providerId),
  readProviderQuotas = () => configuredProviderQuotas({ home, fetchImpl, readSignIn }),
  readOpenCodex = () => opencodexQuotas({ home, fetchImpl }), readConfig = async () => null, readCodexBar = async () => null, now = Date.now }) {
  let cached = null, expires = 0;
  function providerRow(provider, settled) {
    const value = settled.status === "fulfilled" ? settled.value : null;
    const windows = value?.windows || [];
    const observed = typeof value?.observedAt === "number" ? value.observedAt : null;
    return { provider, status: !windows.length ? "unavailable" : observed ? "cached" : "ready",
      observedAt: windows.length ? observed : null, source: windows.length ? value.source || null : null, windows };
  }
  async function signIn(read) {
    try { return await read(); } catch { return null; }
  }
  async function chatgptUsage(credential) {
    const headers = { Accept: "application/json", Authorization: `Bearer ${credential.secret}` };
    const accountId = credential.accountId || chatgptAccountId(credential.secret);
    if (accountId) headers["ChatGPT-Account-Id"] = accountId;
    const res = await fetchImpl(CHATGPT_USAGE_URL, { headers, redirect: "error", signal: AbortSignal.timeout(10000) });
    return res.ok ? chatgptWindows(await res.json()) : [];
  }
  async function claudeUsage(token) {
    const res = await fetchImpl(ANTHROPIC_USAGE_URL, { headers: { Authorization: `Bearer ${token}`, "anthropic-beta": "oauth-2025-04-20" }, signal: AbortSignal.timeout(10000) });
    return res.ok ? claudeWindows(await res.json()) : [];
  }
  // Where each service's allowance comes from. Sources are tried in this order
  // unless Settings prefers one for a service; a source that is off is never read.
  const DEFAULT_ORDER = ["agents", "pi", "opencodex", "codexbar"];
  const SERVICE_LABELS = { codex: "Codex", claude: "Claude", "opencode-go": "OpenCode Go", "opencode-free": "OpenCode Zen", minimax: "MiniMax", "minimax-cn": "MiniMax (China)" };
  const OPENCODEX_SERVICES = { anthropic: "claude", openai: "codex" };
  function sourceOrder(service, config) {
    const preferred = config.prefer[service];
    return preferred ? [preferred, ...DEFAULT_ORDER.filter(id => id !== preferred)] : DEFAULT_ORDER;
  }
  async function chatgptReading(read, source) {
    const credential = await signIn(read);
    if (!liveToken(credential, now())) return null;
    try { const windows = await chatgptUsage(credential); return windows.length ? { windows, observedAt: null, source } : null; } catch { return null; }
  }
  async function claudeTokenReading(read, source) {
    const credential = await signIn(read);
    if (!liveToken(credential, now())) return null;
    try { const windows = await claudeUsage(credential.secret); return windows.length ? { windows, observedAt: null, source } : null; } catch { return null; }
  }
  // Codex: its own app-server when this release has reviewed the installed
  // CLI's schema, otherwise ChatGPT with the account the Codex CLI is signed in
  // to ("agents"), or with the ChatGPT account signed in through Pi ("pi").
  // Claude: Claude Code's own sign-in, or the Claude account signed in through Pi.
  async function signInReading(sourceId, service) {
    if (service === "codex") {
      if (sourceId === "pi") return chatgptReading(() => readSignIn("openai-codex"), "signin");
      try {
        const windows = codexWindows(await codex());
        if (windows.length) return { windows, observedAt: null, source: "native" };
      } catch {}
      return chatgptReading(readCodexSignIn, "account");
    }
    if (sourceId === "pi") return claudeTokenReading(() => readSignIn("anthropic"), "signin");
    return claudeTokenReading(async () => ({ type: "oauth", secret: await readClaudeToken(), expiresAt: null }), "native");
  }
  // `full` reads every source that is on, for Settings to compare them; the
  // limits strip stops at the first source that answers.
  async function collect(full) {
    let config;
    try { config = normalizeQuotaConfig(await readConfig()); } catch { config = normalizeQuotaConfig(null); }
    const on = id => config.sources[id] !== false;
    const readings = { agents: new Map(), pi: new Map(), opencodex: new Map(), codexbar: new Map() };
    const labels = new Map();
    const [probed, borrowed, bar] = await Promise.allSettled([
      on("pi") ? Promise.resolve().then(readProviderQuotas) : [],
      on("opencodex") ? Promise.resolve().then(readOpenCodex) : [],
      on("codexbar") ? Promise.resolve().then(readCodexBar) : null,
    ]);
    for (const row of probed.status === "fulfilled" && Array.isArray(probed.value) ? probed.value : []) {
      const service = Array.isArray(row?.ids) && typeof row.ids[0] === "string" ? row.ids[0] : null;
      if (!service || !row.windows?.length) continue;
      readings.pi.set(service, { windows: row.windows, observedAt: row.observedAt ?? null, source: row.source || "signin" });
      labels.set(service, row.provider);
    }
    for (const report of borrowed.status === "fulfilled" && Array.isArray(borrowed.value) ? borrowed.value : []) {
      const id = typeof report?.provider === "string" ? report.provider : "";
      if (!id) continue;
      const service = OPENCODEX_SERVICES[id] || id, quota = report.quota || {};
      const windows = currentWindows(OPENCODEX_WINDOWS
        .map(([key, minutes]) => windowUsage(quota[`${key}Percent`], asSecondsValue(quota[`${key}ResetAt`]), null, minutes, null))
        .filter(Boolean), now());
      if (!windows.length) continue;
      readings.opencodex.set(service, { windows, observedAt: null, source: "opencodex" });
      if (!labels.has(service)) labels.set(service, OPENCODEX_NAMES[id] || report.label || id);
    }
    const codexbar = bar.status === "fulfilled" ? bar.value : null;
    for (const report of Array.isArray(codexbar?.reports) ? codexbar.reports : []) {
      const windows = currentWindows((report.windows || [])
        .map(w => windowUsage(w.usedPercent, Number.isFinite(w.resetsAt) ? Math.floor(w.resetsAt / 1000) : null, null, w.windowDurationMins, null))
        .filter(Boolean), now());
      if (!windows.length) continue;
      // CodexBar keeps its own cache; an old reading says when it was taken.
      const stale = Number.isFinite(report.updatedAt) && now() - report.updatedAt > 15 * 60 * 1000;
      readings.codexbar.set(report.id, { windows, observedAt: stale ? report.updatedAt : null, source: "codexbar" });
      if (!labels.has(report.id)) labels.set(report.id, report.label || report.id);
    }
    for (const service of ["codex", "claude"]) {
      for (const sourceId of sourceOrder(service, config)) {
        if (!on(sourceId)) continue;
        if (sourceId === "agents" || sourceId === "pi") {
          const reading = await signInReading(sourceId, service);
          if (reading) readings[sourceId].set(service, reading);
        }
        if (!full && readings[sourceId].has(service)) break;
      }
    }
    // Claude Code caches what it last observed; that still reports something
    // when no source can read Claude live.
    if (on("agents") && !DEFAULT_ORDER.some(id => on(id) && readings[id].has("claude"))) {
      try {
        const cache = await readClaudeCache();
        if (cache?.windows?.length) readings.agents.set("claude", { windows: cache.windows, observedAt: cache.observedAt ?? null, source: "native" });
      } catch {}
    }
    const label = service => SERVICE_LABELS[service] || labels.get(service) || service;
    const services = ["codex", "claude"];
    for (const id of DEFAULT_ORDER) for (const service of readings[id].keys()) if (!services.includes(service)) services.push(service);
    const providers = [];
    for (const service of services) {
      const sourceId = sourceOrder(service, config).find(id => on(id) && readings[id].has(service)) || null;
      const reading = sourceId ? readings[sourceId].get(service) : null;
      if (!reading && service !== "codex" && service !== "claude") continue;
      const windows = reading?.windows || [];
      const observed = typeof reading?.observedAt === "number" ? reading.observedAt : null;
      providers.push({ provider: label(service), service, sourceId, status: !windows.length ? "unavailable" : observed ? "cached" : "ready",
        observedAt: windows.length ? observed : null, source: windows.length ? reading.source || null : null, windows });
    }
    const sources = {};
    for (const id of DEFAULT_ORDER) {
      sources[id] = { enabled: on(id), services: [...readings[id].entries()].map(([service, reading]) => ({ service, label: label(service),
        windows: reading.windows, observedAt: reading.observedAt ?? null })) };
    }
    if (codexbar) sources.codexbar.reason = codexbar.reason || null;
    const result = { updatedAt: now(), providers, sources, prefer: config.prefer };
    if (full) { cachedFull = result; expiresFull = now() + 60000; }
    cached = result;
    // A reading that came from a cache is retried sooner than a live one.
    expires = now() + (providers.every(p => p.status === "ready") ? 300000 : 60000);
    return result;
  }
  let cachedFull = null, expiresFull = 0;
  const flights = { fast: null, full: null };
  return {
    read(options = {}) {
      const full = options?.full === true, key = full ? "full" : "fast";
      if (!full && cached && now() < expires) return Promise.resolve(cached);
      if (full && cachedFull && now() < expiresFull) return Promise.resolve(cachedFull);
      if (!flights[key]) flights[key] = collect(full).finally(() => { flights[key] = null; });
      return flights[key];
    },
    // A changed source or preference applies to the next read.
    invalidate() { cached = null; cachedFull = null; expires = 0; expiresFull = 0; },
  };
}
module.exports = { createWorkspaceUsage, windowUsage, codexWindows, chatgptWindows, claudeWindows, currentWindows, keychainHome, opencodexProviders, opencodexQuotas,
  configuredProviderQuotas, providerCredentials, storedSignIn, codexSignIn, QUOTA_PROBES };
