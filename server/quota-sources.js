"use strict";

// Services that report provider allowances, shown under Settings → Quota
// sources. OpenCodex is the first one: it already checks every provider it
// routes and publishes the results on its loopback management API. Stepsemble
// only reads that API; it never changes the service or its credentials.

const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

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

async function opencodexSource({ home, env = process.env, fetchImpl = fetch, osHome = os.homedir(), timeoutMs = 8000 } = {}) {
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

module.exports = { listQuotaSources, opencodexSource, providerRow };

