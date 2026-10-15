"use strict";

// Finds the Hermes web server that runs on this computer. Only this
// computer's own addresses are ever tried, so a request can never be steered
// at another host, and nothing under ~/.hermes is read: the address comes from
// STEPSEMBLE_HERMES_URL or Hermes' default port on each local address.

const os = require("node:os");

const DEFAULT_PORT = 9119;
const PROBE_TIMEOUT_MS = 2500;
const CACHE_MS = 30_000;
const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1"]);

function ownAddresses(interfaces = os.networkInterfaces()) {
  const out = [];
  for (const rows of Object.values(interfaces || {})) {
    for (const row of rows || []) {
      if (row && row.family === "IPv4" && !row.internal && typeof row.address === "string") out.push(row.address);
    }
  }
  return [...new Set(out)];
}

function isOwnHost(hostname, interfaces) {
  const host = String(hostname || "").replace(/^\[|\]$/g, "").toLowerCase();
  return LOOPBACK.has(host) || ownAddresses(interfaces).includes(host);
}

function candidateUrls({ env = process.env, interfaces = os.networkInterfaces() } = {}) {
  const out = [];
  const configured = String(env.STEPSEMBLE_HERMES_URL || "").trim();
  if (configured) {
    try {
      const url = new URL(configured);
      if ((url.protocol === "http:" || url.protocol === "https:") && !url.username && !url.password && isOwnHost(url.hostname, interfaces)) out.push(url.origin);
    } catch {}
  }
  out.push(`http://127.0.0.1:${DEFAULT_PORT}`);
  for (const address of ownAddresses(interfaces)) out.push(`http://${address}:${DEFAULT_PORT}`);
  return [...new Set(out)];
}

function normalizeStatus(body) {
  if (!body || typeof body !== "object" || typeof body.version !== "string" || !body.version) return null;
  return {
    version: body.version.slice(0, 64),
    authRequired: body.auth_required === true,
    providers: Array.isArray(body.auth_providers) ? body.auth_providers.filter(value => typeof value === "string").slice(0, 16) : [],
    installId: typeof body.install_id === "string" ? body.install_id.slice(0, 128) : "",
    gatewayRunning: body.gateway_running === true,
  };
}

async function probe(baseUrl, fetchImpl) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const response = await fetchImpl(`${baseUrl}/api/status`, { signal: controller.signal, redirect: "error", headers: { accept: "application/json" } });
    if (!response.ok) return null;
    const status = normalizeStatus(await response.json());
    return status ? { url: baseUrl, status } : null;
  } catch { return null; } finally { clearTimeout(timer); }
}

function createHermesDiscovery({ env = process.env, fetchImpl = fetch, interfaces = () => os.networkInterfaces(), now = Date.now, cacheMs = CACHE_MS } = {}) {
  let cached = null, pending = null;
  async function find({ refresh = false } = {}) {
    if (!refresh && cached && now() - cached.at < cacheMs) return cached.value;
    if (pending) return pending;
    pending = (async () => {
      let value = null;
      for (const url of candidateUrls({ env, interfaces: interfaces() })) {
        value = await probe(url, fetchImpl);
        if (value) break;
      }
      cached = { at: now(), value };
      return value;
    })().finally(() => { pending = null; });
    return pending;
  }
  return Object.freeze({ find });
}

module.exports = { createHermesDiscovery, candidateUrls, normalizeStatus, isOwnHost, ownAddresses, DEFAULT_PORT };
