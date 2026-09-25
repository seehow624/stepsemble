"use strict";

// Services that report provider allowances, shown under Settings → Quota
// sources. OpenCodex is the first one: it already checks every provider it
// routes and publishes the results on its loopback management API. Stepsemble
// only reads that API; it never changes the service or its credentials.

const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { execFile } = require("node:child_process");

const OPENCODEX_DEFAULT_PORT = 10100;
const WINDOWS = Object.freeze([["fiveHour", 300], ["weekly", 10080], ["monthly", 43200]]);

function finitePercent(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.min(100, number)) : null;
}

function resetTime(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return null;
  return number < 1e11 ? number * 1000 : number;
}

// One provider row with its windows as "used" percentages.
function providerRow(report) {
  const id = typeof report?.provider === "string" ? report.provider.slice(0, 64) : "";
  if (!id) return null;
  const quota = report.quota && typeof report.quota === "object" ? report.quota : {};
  const windows = [];
  for (const [key, minutes] of WINDOWS) {
    const used = finitePercent(quota[key + "Percent"]);
    if (used === null) continue;
    windows.push({ key, windowDurationMins: minutes, usedPercent: used, resetsAt: resetTime(quota[key + "ResetAt"]) });
  }
  for (const custom of Array.isArray(quota.customWindows) ? quota.customWindows.slice(0, 4) : []) {
    const used = finitePercent(custom?.percent);
    if (used === null) continue;
    windows.push({ key: "custom", label: String(custom.label || "").slice(0, 40) || null, windowDurationMins: null, usedPercent: used, resetsAt: resetTime(custom.resetAt) });
  }
  return { id, label: String(report.label || id).slice(0, 80), windows, updatedAt: resetTime(report.updatedAt || quota.updatedAt) };
}

async function readText(file, maxBytes = 4096) {
  const handle = await fs.open(file, "r");
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > maxBytes) throw new Error("unexpected file");
    return (await handle.readFile("utf8")).trim();
  } finally { await handle.close(); }
}

async function opencodexSource({ home, env = process.env, fetchImpl = fetch, osHome = os.homedir(), timeoutMs = 8000, probe = true } = {}) {
  const directories = [...new Set([env.OPENCODEX_HOME, path.join(osHome, ".opencodex"), home && path.join(home, ".opencodex")].filter(Boolean))];
  let directory = null;
  for (const candidate of directories) {
    try { if ((await fs.stat(candidate)).isDirectory()) { directory = candidate; break; } } catch {}
  }
  const source = { id: "opencodex", name: "OpenCodex", installed: !!directory, running: false, port: null, dashboardUrl: null,
    providers: [], checkedAt: Date.now(), reason: directory ? null : "not_installed" };
  if (!directory) return source;
  let port = OPENCODEX_DEFAULT_PORT;
  try {
    const bound = JSON.parse(await readText(path.join(directory, "runtime-port.json")))?.port;
    if (Number.isInteger(bound) && bound > 0 && bound < 65536) port = bound;
  } catch {
    try {
      const configured = JSON.parse(await readText(path.join(directory, "config.json"), 1024 * 1024))?.port;
      if (Number.isInteger(configured) && configured > 1023 && configured < 65536) port = configured;
    } catch {}
  }
  source.port = port;
  source.dashboardUrl = "http://localhost:" + port;
  // A source that is turned off is only located, never called.
  if (!probe) { source.reason = "off"; return source; }
  let token = "";
  try { token = await readText(path.join(directory, "admin-api-token"), 512); } catch {}
  const base = "http://127.0.0.1:" + port;
  if (token) {
    try {
      const response = await fetchImpl(base + "/api/provider-quotas", { headers: { Accept: "application/json", Authorization: "Bearer " + token },
        redirect: "error", signal: AbortSignal.timeout(timeoutMs) });
      if (response.ok) {
        const body = await response.json();
        source.running = true;
        source.providers = (Array.isArray(body?.reports) ? body.reports : []).slice(0, 32).map(providerRow).filter(Boolean);
        return source;
      }
      source.reason = response.status === 401 || response.status === 403 ? "token_rejected" : "unavailable";
    } catch { source.reason = "not_running"; }
  } else source.reason = "token_missing";
  // Without the management API, still tell whether the service is up.
  try {
    const response = await fetchImpl(base + "/v1/models", { redirect: "error", signal: AbortSignal.timeout(Math.min(timeoutMs, 3000)) });
    source.running = response.ok || response.status === 401;
    if (source.running && source.reason === "not_running") source.reason = "unavailable";
  } catch { source.running = false; source.reason = source.reason || "not_running"; }
  return source;
}

async function listQuotaSources(options = {}) {
  const sources = await Promise.all([opencodexSource(options).catch(() => ({ id: "opencodex", name: "OpenCodex", installed: false, running: false,
    port: null, dashboardUrl: null, providers: [], checkedAt: Date.now(), reason: "unavailable" }))]);
  return { sources };
}

// ---- Which quota sources are used ----
// Agents: each agent's own sign-in on this host (Codex, Claude Code).
// Pi: the accounts and API keys signed in through Pi.
// OpenCodex and CodexBar: local services that read limits themselves.
// CodexBar starts off: its CLI can read browser cookies and the keychain, so
// it runs only after someone turns it on.
const QUOTA_SOURCE_IDS = Object.freeze(["agents", "pi", "opencodex", "codexbar"]);
const DEFAULT_SOURCES = Object.freeze({ agents: true, pi: true, opencodex: true, codexbar: false });
const QUOTA_CONFIG_FILE = "quota-sources.json";
const SERVICE_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;

function normalizeQuotaConfig(value) {
  const input = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const sources = {}, prefer = {};
  for (const id of QUOTA_SOURCE_IDS) sources[id] = typeof input.sources?.[id] === "boolean" ? input.sources[id] : DEFAULT_SOURCES[id];
  const wanted = input.prefer && typeof input.prefer === "object" && !Array.isArray(input.prefer) ? input.prefer : {};
  for (const [service, source] of Object.entries(wanted).slice(0, 64)) {
    if (SERVICE_ID.test(service) && QUOTA_SOURCE_IDS.includes(source)) prefer[service] = source;
  }
  return { version: 1, sources, prefer };
}

async function readQuotaConfig(configDir) {
  try { return normalizeQuotaConfig(JSON.parse(await readText(path.join(configDir, QUOTA_CONFIG_FILE), 64 * 1024))); }
  catch { return normalizeQuotaConfig(null); }
}

// `update.sources` turns sources on or off; `update.prefer[service]` picks a
// source for one service, and null goes back to the default order.
async function writeQuotaConfig(configDir, update = {}) {
  const current = await readQuotaConfig(configDir);
  const sources = { ...current.sources }, prefer = { ...current.prefer };
  for (const [id, on] of Object.entries(update?.sources && typeof update.sources === "object" ? update.sources : {})) {
    if (QUOTA_SOURCE_IDS.includes(id) && typeof on === "boolean") sources[id] = on;
  }
  for (const [service, source] of Object.entries(update?.prefer && typeof update.prefer === "object" ? update.prefer : {})) {
    if (!SERVICE_ID.test(service)) continue;
    if (source === null) delete prefer[service];
    else if (QUOTA_SOURCE_IDS.includes(source)) prefer[service] = source;
  }
  const next = normalizeQuotaConfig({ sources, prefer });
  await fs.mkdir(configDir, { recursive: true, mode: 0o700 });
  const file = path.join(configDir, QUOTA_CONFIG_FILE), temp = file + "." + process.pid + ".tmp";
  await fs.writeFile(temp, JSON.stringify(next), { mode: 0o600 });
  await fs.rename(temp, file);
  return next;
}

// ---- CodexBar ----
// CodexBar's CLI prints each provider's usage windows as JSON
// (`codexbar usage --format json`): primary, secondary and tertiary windows
// with a used percentage, the window length in minutes and the reset time.
const CODEXBAR_PATHS = Object.freeze(["/opt/homebrew/bin/codexbar", "/usr/local/bin/codexbar", "/Applications/CodexBar.app/Contents/Helpers/CodexBarCLI"]);
const CODEXBAR_NAMES = Object.freeze({ codex: "Codex", claude: "Claude", cursor: "Cursor", gemini: "Gemini", antigravity: "Antigravity",
  kilo: "Kilo Code", grok: "Grok", openrouter: "OpenRouter", copilot: "GitHub Copilot", zai: "z.ai", minimax: "MiniMax", factory: "Factory" });

async function findCodexBar({ env = process.env, osHome = os.homedir() } = {}) {
  const dirs = String(env.PATH || "").split(path.delimiter).filter(dir => path.isAbsolute(dir));
  const candidates = [...dirs.map(dir => path.join(dir, "codexbar")), ...CODEXBAR_PATHS,
    path.join(osHome, "Applications/CodexBar.app/Contents/Helpers/CodexBarCLI")];
  for (const file of new Set(candidates)) {
    try { const stat = await fs.stat(file); if (stat.isFile() && (stat.mode & 0o111)) return file; } catch {}
  }
  return null;
}

function codexbarWindow(window, key) {
  if (!window || typeof window !== "object") return null;
  const used = finitePercent(window.usedPercent);
  if (used === null) return null;
  const minutes = Number(window.windowMinutes);
  const reset = typeof window.resetsAt === "string" ? Date.parse(window.resetsAt) : resetTime(window.resetsAt);
  return { key, windowDurationMins: Number.isFinite(minutes) && minutes > 0 ? minutes : null, usedPercent: used,
    resetsAt: Number.isFinite(reset) ? reset : null };
}

function codexbarReports(payload) {
  const items = Array.isArray(payload) ? payload
    : payload && typeof payload === "object" ? (Array.isArray(payload.providers) ? payload.providers : [payload]) : [];
  const reports = [];
  for (const item of items.slice(0, 32)) {
    const id = typeof item?.provider === "string" ? item.provider.toLowerCase().slice(0, 64) : "";
    if (!SERVICE_ID.test(id) || item.error) continue;
    const usage = item.usage && typeof item.usage === "object" ? item.usage : {};
    const windows = [["primary", usage.primary], ["secondary", usage.secondary], ["tertiary", usage.tertiary]]
      .map(([key, window]) => codexbarWindow(window, key)).filter(Boolean);
    if (!windows.length) continue;
    const updated = typeof usage.updatedAt === "string" ? Date.parse(usage.updatedAt) : NaN;
    reports.push({ id, label: CODEXBAR_NAMES[id] || id.charAt(0).toUpperCase() + id.slice(1), windows, updatedAt: Number.isFinite(updated) ? updated : null });
  }
  return reports;
}

function runCodexBar(command, { env = process.env, timeoutMs = 45000 } = {}) {
  return new Promise(resolve => {
    execFile(command, ["usage", "--format", "json", "--json-only"], { timeout: timeoutMs, maxBuffer: 2 * 1024 * 1024,
      env: { ...env, NO_COLOR: "1" }, windowsHide: true }, (error, stdout) => {
      // A provider that fails makes the exit code non-zero; the others still print.
      const text = String(stdout || "").trim();
      if (!text) return resolve({ ok: false, reason: error?.killed ? "timed_out" : "failed", reports: [] });
      try {
        const reports = codexbarReports(JSON.parse(text));
        resolve({ ok: reports.length > 0, reason: reports.length ? null : "no_data", reports });
      } catch { resolve({ ok: false, reason: "unreadable", reports: [] }); }
    });
  });
}

function createCodexBarReader({ env = process.env, osHome = os.homedir(), now = Date.now, ttlMs = 5 * 60 * 1000, find = findCodexBar, run = runCodexBar } = {}) {
  let cached = null, flight = null;
  function read() {
    if (cached && now() - cached.at < ttlMs) return Promise.resolve(cached.value);
    if (!flight) {
      flight = (async () => {
        const command = await find({ env, osHome });
        const value = command ? { installed: true, ...(await run(command, { env })) } : { installed: false, ok: false, reason: "not_installed", reports: [] };
        cached = { at: now(), value };
        return value;
      })().finally(() => { flight = null; });
    }
    return flight;
  }
  return { read, reset() { cached = null; } };
}

module.exports = { listQuotaSources, opencodexSource, providerRow, QUOTA_SOURCE_IDS, normalizeQuotaConfig, readQuotaConfig, writeQuotaConfig,
  findCodexBar, codexbarReports, runCodexBar, createCodexBarReader };
