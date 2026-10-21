"use strict";

const fs = require("node:fs/promises"), path = require("node:path");
const { execFile } = require("node:child_process");
const { createHash } = require("node:crypto");
const { accountKey } = require("./quota-identity");
const { claudeWindows, currentWindows } = require("./quota-windows");
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const ACCOUNT_KEY = /^v1:[a-f0-9]{64}$/;
const QUOTA_VERSION = 1;
const MAX_BYTES = 65536, DEADLINE_MS = 12000, MIN_INTERVAL_MS = 15000;
const unavailable = () => ({ quotaVersion: QUOTA_VERSION, status: "unavailable", sampledAt: null, accountKey: null, windows: [] });

// Claude's existing read-only credential reader. No refresh, login or writes.
async function claudeToken(home, allowKeychain, { desktopKeychainOnly = false, platform = process.platform,
  readFile = fs.readFile, execFileImpl = execFile, now = Date.now } = {}) {
  const desktop = desktopKeychainOnly && allowKeychain && platform === "darwin";
  function parse(raw) {
    try {
      const credential = JSON.parse(raw)?.claudeAiOauth;
      // Aqua uses only the native keychain: even a still-valid legacy file
      // could belong to a previous account. Other callers stay file-first.
      if (desktop && typeof credential?.expiresAt === "number" && credential.expiresAt <= now()) return null;
      if (!desktop) return credential?.accessToken || null;
      return typeof credential?.accessToken === "string" && credential.accessToken ? credential.accessToken : null;
    } catch { return null; }
  }
  const keychainToken = () => new Promise(resolve => execFileImpl("/usr/bin/security", ["find-generic-password", "-s", "Claude Code-credentials", "-w"], { timeout: 5000, maxBuffer: 65536 }, (error, stdout) => resolve(error ? null : parse(stdout))));
  if (desktop) return keychainToken();
  // Preserve the legacy reader outside the desktop path, including its rule
  // that a readable credentials file with no token does not probe keychain.
  try { return JSON.parse(await readFile(path.join(home, ".claude", ".credentials.json"), "utf8"))?.claudeAiOauth?.accessToken || null; } catch {}
  return allowKeychain && platform === "darwin" ? keychainToken() : null;
}

// Strict allowlist at both IPC boundaries: no raw profile, email, URL or token.
function sanitizeClaudeQuota(value, now = Date.now()) {
  if (value?.quotaVersion !== QUOTA_VERSION) return null;
  if (value.status === "unavailable") return unavailable();
  if (!["ready", "cached"].includes(value.status) || typeof value.accountKey !== "string" || !ACCOUNT_KEY.test(value.accountKey)
    || !Number.isSafeInteger(value.sampledAt) || value.sampledAt <= 0 || value.sampledAt > now + 5000
    || !Array.isArray(value.windows) || !value.windows.length || value.windows.length > 2) return null;
  if (value.accountAliases !== undefined && (!Array.isArray(value.accountAliases) || value.accountAliases.length > 1
    || value.accountAliases.some(alias => typeof alias !== "string" || !ACCOUNT_KEY.test(alias) || alias === value.accountKey))) return null;
  const accountAliases = value.accountAliases?.slice() || [];
  const windows = [], durations = new Set();
  for (const w of value.windows) {
    if (![300, 10080].includes(w?.windowDurationMins) || durations.has(w.windowDurationMins)
      || typeof w.usedPercent !== "number" || !Number.isFinite(w.usedPercent) || w.usedPercent < 0 || w.usedPercent > 100
      || !(w.resetsAt === null || Number.isSafeInteger(w.resetsAt) && w.resetsAt > 0)) return null;
    durations.add(w.windowDurationMins);
    windows.push({ label: w.windowDurationMins === 300 ? "5 hours" : "Weekly", windowDurationMins: w.windowDurationMins,
      bucket: null, usedPercent: w.usedPercent, remainingPercent: 100 - w.usedPercent, resetsAt: w.resetsAt });
  }
  const current = currentWindows(windows, now);
  return current.length ? { quotaVersion: QUOTA_VERSION, status: value.status, sampledAt: value.sampledAt, accountKey: value.accountKey, ...(accountAliases.length ? { accountAliases } : {}), windows: current } : unavailable();
}

// Only these fixed official metadata endpoints receive the bearer. Streaming
// enforces the byte limit even without Content-Length; the shared deadline
// covers headers AND body. Redirects never forward the credential.
async function oauthMetadata(kind, token, fetchImpl, signal) {
  if (!["usage", "profile"].includes(kind)) throw new Error("unavailable");
  const res = await fetchImpl(`https://api.anthropic.com/api/oauth/${kind}`, {
    method: "GET", headers: { Authorization: `Bearer ${token}`, Accept: "application/json", "anthropic-beta": "oauth-2025-04-20" },
    redirect: "error", signal,
  });
  if (!res.ok || res.redirected || Number(res.headers.get("content-length")) > MAX_BYTES) {
    await res.body?.cancel().catch(() => {}); throw new Error("unavailable");
  }
  const chunks = []; let bytes = 0;
  try {
    for await (const chunk of res.body) {
      bytes += chunk.length;
      if (bytes > MAX_BYTES || signal.aborted) throw new Error("unavailable");
      chunks.push(Buffer.from(chunk));
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } finally { if (signal.aborted) await res.body?.cancel().catch(() => {}); }
}

function createDesktopQuotaReader({ home, readToken = () => claudeToken(home, true, { desktopKeychainOnly: true }), fetchImpl = globalThis.fetch,
  now = Date.now, deadlineMs = DEADLINE_MS } = {}) {
  let flight = null, snapshot = null, binding = null, lastAttempt = -Infinity, lastFailed = false;
  const tokenHash = token => typeof token === "string" && token && token.length <= 8192 && !/[\x00-\x20\x7f]/.test(token)
    ? createHash("sha256").update(token).digest("hex") : null;
  function saved(status) {
    return snapshot ? sanitizeClaudeQuota({ ...snapshot, status }, now()) || unavailable() : unavailable();
  }
  async function collect(signal) {
    const token = await readToken(), before = tokenHash(token);
    if (signal.aborted) return unavailable();
    if (!before || before !== binding) { snapshot = null; binding = before; lastFailed = false; }
    if (!before) return unavailable();
    if (now() - lastAttempt < MIN_INTERVAL_MS) {
      // Even a rate-limited snapshot must still belong to the current sign-in.
      const after = tokenHash(await readToken());
      if (signal.aborted) return unavailable();
      if (after !== before) { snapshot = null; binding = null; return unavailable(); }
      return saved(lastFailed ? "cached" : "ready");
    }
    lastAttempt = now();
    let reading = null;
    const networkSignal = AbortSignal.any([signal, AbortSignal.timeout(Math.max(1, Math.min(DEADLINE_MS, deadlineMs) - Math.min(2000, deadlineMs / 4)))]);
    try {
      const [usage, profile] = await Promise.all([oauthMetadata("usage", token, fetchImpl, networkSignal), oauthMetadata("profile", token, fetchImpl, networkSignal)]);
      const uuid = profile?.account?.uuid;
      if (typeof uuid === "string" && UUID.test(uuid)) {
        // Only the official profile that verified this UUID/bearer can attest
        // an email alias. The email itself never crosses the IPC boundary.
        const email = typeof profile.account.email === "string" ? profile.account.email.trim().toLowerCase() : "";
        const alias = email.length <= 320 && /^[^\s@]+@[^\s@]+$/.test(email) ? accountKey("claude", email, "email") : null;
        reading = sanitizeClaudeQuota({ quotaVersion: QUOTA_VERSION, status: "ready", sampledAt: now(),
          accountKey: accountKey("claude", uuid.toLowerCase()), ...(alias ? { accountAliases: [alias] } : {}), windows: claudeWindows(usage) }, now());
      }
    } catch { /* No native allowance is not zero usage. */ }
    // Binding is to the bearer actually used, not whichever profile is current
    // afterwards. A switch invalidates even the old failure fallback.
    const after = tokenHash(await readToken());
    if (signal.aborted) return unavailable();
    if (after !== before) { snapshot = null; binding = null; return unavailable(); }
    if (reading?.status === "ready") { snapshot = reading; lastFailed = false; return saved("ready"); }
    lastFailed = true;
    return saved("cached");
  }
  return {
    read() {
      if (flight) return flight;
      const controller = new AbortController();
      let timer;
      const timeout = new Promise(resolve => { timer = setTimeout(() => { controller.abort(); snapshot = null; binding = null; resolve(unavailable()); }, Math.min(DEADLINE_MS, Math.max(1, deadlineMs))); });
      flight = Promise.race([collect(controller.signal).catch(() => { lastFailed = true; return unavailable(); }), timeout]).finally(() => { clearTimeout(timer); flight = null; });
      return flight;
    },
  };
}
module.exports = { QUOTA_VERSION, claudeToken, sanitizeClaudeQuota, createDesktopQuotaReader };
