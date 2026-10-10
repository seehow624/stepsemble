"use strict";
const fs = require("node:fs/promises");
const path = require("node:path");
const { number } = require("./usage-records");
const PRICE_URL = "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";
const MAX_BYTES = 5 * 1024 * 1024;
const RATE_FIELDS = ["input_cost_per_token", "output_cost_per_token", "cache_read_input_token_cost", "cache_creation_input_token_cost"];
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
  const provider = row.provider === "openai-codex" ? "openai" : row.provider;
  const matches = [`${provider}/${row.model}`, row.model];
  const key = matches.find(key => models[key] && (!provider || !models[key].provider || models[key].provider === provider || models[key].provider === "openai" && provider === "openai"));
  if (!key) return null;
  const rates = models[key], context = (row.tokens.input || 0) + (row.tokens.cacheRead || 0) + (row.tokens.cacheWrite || 0);
  let usd = 0;
  for (let i = 0; i < RATE_FIELDS.length; i++) {
    const count = row.tokens[["input", "output", "cacheRead", "cacheWrite"][i]];
    if (count === null) return null;
    if (!count) continue;
    const field = RATE_FIELDS[i];
    let rate = rates[field];
    for (const threshold of [128, 200, 256, 272]) if (context > threshold * 1000 && rates[`${field}_above_${threshold}k_tokens`] !== undefined) rate = rates[`${field}_above_${threshold}k_tokens`];
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
