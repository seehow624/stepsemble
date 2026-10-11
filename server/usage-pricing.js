"use strict";
const fs = require("node:fs/promises");
const path = require("node:path");
const { number } = require("./usage-records");
const PRICE_URL = "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";
const MAX_BYTES = 5 * 1024 * 1024;
const RATE_FIELDS = ["input_cost_per_token", "output_cost_per_token", "cache_read_input_token_cost", "cache_creation_input_token_cost"];
// Public vendor prices verified 2026-10-11. These fill catalog gaps; they do
// not substitute one model generation's price for an unannounced preview.
// https://docs.z.ai/guides/overview/pricing (USD per token)
// https://api-docs.deepseek.com/quick_start/pricing/ (standard peak rates;
// off-peak/holiday discounts are not inferred from a routed history record)
const OFFICIAL = {
  "glm-5.3-flash": { provider: "z_ai", input_cost_per_token: .15 / 1e6, output_cost_per_token: .50 / 1e6, cache_read_input_token_cost: .03 / 1e6 },
  "glm-5.3-flashx": { provider: "z_ai", input_cost_per_token: .37 / 1e6, output_cost_per_token: 1.25 / 1e6, cache_read_input_token_cost: .075 / 1e6 },
  "glm-5.3": { provider: "z_ai", input_cost_per_token: 1.4 / 1e6, output_cost_per_token: 4.4 / 1e6, cache_read_input_token_cost: .26 / 1e6 },
  "deepseek-v4.1-flash": { provider: "deepseek", input_cost_per_token: .30 / 1e6, output_cost_per_token: 1.2 / 1e6, cache_read_input_token_cost: .006 / 1e6 },
  "deepseek-flash": { provider: "deepseek", input_cost_per_token: .30 / 1e6, output_cost_per_token: 1.2 / 1e6, cache_read_input_token_cost: .006 / 1e6 },
};
const PROVIDER_ALIASES = { "openai-codex": "openai", "z-ai": "z_ai", zai: "z_ai", zhipu: "z_ai", "zhipu-ai": "z_ai", "minimax-cn": "minimax" };
const canonical = provider => Object.hasOwn(PROVIDER_ALIASES, provider) ? PROVIDER_ALIASES[provider] : provider;
const ROUTERS = new Set(["opencodex", "opencode-go"]);
const VENDORS = new Set(["openai", "anthropic", "minimax", "z_ai", "deepseek", "gemini", "xai"]);
const resolvedPrices = new WeakMap();
function modelIdentity(provider, model) {
  // OpenCodex's documented, reversible Claude Code picker aliases. The v2
  // escape decoder must be single-pass (~ts is a literal ~s, not a slash).
  const alias = canonical(provider) === "anthropic" && model.match(/^claude-ocx(2?)-([^/]+?)--(.+)$/);
  if (alias) {
    const decoded = alias[1] === "2" ? alias[3].replace(/~[st]/g, value => value === "~s" ? "/" : "~") : alias[3];
    provider = alias[2] === "native" ? "openai" : "opencodex";
    model = alias[2] === "native" ? decoded : alias[2] + "/" + decoded;
  }
  const routed = !provider || ROUTERS.has(provider) || canonical(provider) === "openai";
  let vendor = canonical(provider), id = model;
  if (routed) {
    for (let count = 0; count < 3 && id.includes("/"); count++) {
      const slash = id.indexOf("/"), prefix = canonical(id.slice(0, slash));
      if (!ROUTERS.has(prefix) && !VENDORS.has(prefix)) break;
      id = id.slice(slash + 1); if (VENDORS.has(prefix)) vendor = prefix;
    }
    const inferred = /^(?:gpt-|o[1-9](?:-|$))/.test(id) ? "openai" : /^claude-/.test(id) ? "anthropic" : /^minimax-/i.test(id) ? "minimax" : /^glm-/i.test(id) ? "z_ai" : /^deepseek-/i.test(id) ? "deepseek" : /^gemini-/i.test(id) ? "gemini" : /^grok-/i.test(id) ? "xai" : "";
    if (inferred) vendor = inferred;
  } else if (id.startsWith(vendor + "/")) id = id.slice(vendor.length + 1);
  return { provider: vendor, model: id };
}
function findRates(provider, model, models) {
  let resolved = resolvedPrices.get(models);
  if (!resolved) { resolved = new Map(); resolvedPrices.set(models, resolved); }
  const cacheKey = JSON.stringify([provider, model]);
  if (resolved.has(cacheKey)) return resolved.get(cacheKey);
  const remember = value => { resolved.set(cacheKey, value); return value; };
  const identity = modelIdentity(provider, model), compatible = value => value && (!identity.provider || !value.provider || canonical(value.provider) === identity.provider);
  for (const key of [`${identity.provider}/${identity.model}`, identity.model]) if (Object.hasOwn(models, key) && compatible(models[key])) return remember(models[key]);
  // Some official model IDs vary only in letter case between API catalogs.
  // Require an unambiguous provider/model pair, never fuzzy generation names.
  const wanted = identity.model.toLowerCase(); let match;
  for (const [key, value] of Object.entries(models)) {
    if (!compatible(value)) continue;
    const clean = key.startsWith(value.provider + "/") ? key.slice(value.provider.length + 1) : key;
    if (clean.toLowerCase() !== wanted) continue;
    if (match) return remember(null); match = value;
  }
  return remember(match || (compatible(OFFICIAL[wanted]) ? OFFICIAL[wanted] : null));
}
function sanitize(raw) {
  const models = Object.create(null);
  for (const [id, entry] of Object.entries(raw || {}).slice(0, 20000)) {
    if (!entry || typeof entry !== "object" || id.length > 256) continue;
    const rates = {};
    for (const [key, value] of Object.entries(entry)) if (/^(input_cost_per_token|output_cost_per_token|cache_read_input_token_cost|cache_creation_input_token_cost)(?:_above_\d+k_tokens)?$/.test(key) && number(value) !== null && value <= 1) rates[key] = value;
    const provider = entry.litellm_provider || entry.provider;
    if (Object.keys(rates).length) models[id] = { ...rates, provider: typeof provider === "string" ? provider.slice(0, 64) : "" };
  }
  return models;
}
function estimate(row, models) {
  // Pi can emit an all-zero price table for a custom/subscription model.
  // Positive token usage with reported cost=0 does not prove a free call.
  if (number(row.cost) !== null && (row.cost > 0 || Object.values(row.tokens).every(n => n === 0))) return { usd: row.cost, source: "agent" };
  const rates = findRates(row.provider, row.model, models);
  if (!rates) return null;
  const context = (row.tokens.input || 0) + (row.tokens.cacheRead || 0) + (row.tokens.cacheWrite || 0);
  let usd = 0;
  for (let i = 0; i < RATE_FIELDS.length; i++) {
    const count = row.tokens[["input", "output", "cacheRead", "cacheWrite"][i]];
    if (count === null) return null;
    if (!count) continue;
    const field = RATE_FIELDS[i];
    let rate = rates[field];
    const thresholds = Object.keys(rates).map(key => key.match(new RegExp(`^${field}_above_(\\d+)k_tokens$`))?.[1]).filter(Boolean).map(Number).sort((a, b) => a - b);
    for (const threshold of thresholds) if (context > threshold * 1000) rate = rates[`${field}_above_${threshold}k_tokens`];
    if (rate === undefined) return null; // Missing cache prices never mean free.
    usd += count * rate;
  }
  return Number.isFinite(usd) ? { usd, source: "catalog" } : null;
}
function createUsagePricing({ cacheFile, fetchImpl = fetch, now = Date.now, enabled = true } = {}) {
  let cache = null, flight = null, loading = null, triedAt = 0;
  async function read() {
    if (!cache && !loading) loading = (async () => {
      try {
        const stat = await fs.stat(cacheFile);
        if (stat.isFile() && stat.size <= MAX_BYTES) {
          const saved = JSON.parse(await fs.readFile(cacheFile, "utf8"));
          if (saved.version === 1 && Number.isSafeInteger(saved.updatedAt) && saved.updatedAt > 0 && saved.updatedAt <= now() + 300000) cache = { models: sanitize(saved.models), updatedAt: saved.updatedAt };
        }
      } catch {}
      cache ||= { models: {}, updatedAt: null };
    })().finally(() => { loading = null; });
    if (loading) await loading;
    if (flight) return flight;
    if (!enabled || cache.updatedAt && now() - cache.updatedAt < 86400000 || triedAt && now() - triedAt < 300000) return cache;
    if (!flight) flight = (async () => {
      triedAt = now();
      try {
        const response = await fetchImpl(PRICE_URL, { redirect: "error", signal: AbortSignal.timeout(8000), headers: { Accept: "application/json" } });
        if (!response.ok || Number(response.headers?.get("content-length")) > MAX_BYTES) return cache;
        let bytes = 0, chunks = [];
        for await (const chunk of response.body) { bytes += chunk.length; if (bytes > MAX_BYTES) { await response.body.cancel?.().catch?.(() => {}); return cache; } chunks.push(Buffer.from(chunk)); }
        const models = sanitize(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        if (!Object.keys(models).length) return cache;
        cache = { models, updatedAt: now() };
        if (cacheFile) {
          const temp = cacheFile + "." + process.pid + ".tmp";
          try { await fs.mkdir(path.dirname(cacheFile), { recursive: true, mode: 0o700 }); await fs.writeFile(temp, JSON.stringify({ version: 1, ...cache }), { mode: 0o600 }); await fs.rename(temp, cacheFile); }
          finally { await fs.rm(temp, { force: true }).catch(() => {}); }
        }
      } catch { /* Keep the last confirmed price catalog. */ }
      return cache;
    })().finally(() => { flight = null; });
    return flight;
  }
  return { read };
}
module.exports = { createUsagePricing, sanitize, estimate, PRICE_URL };
