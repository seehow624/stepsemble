"use strict";
const path = require("node:path"), crypto = require("node:crypto");
const { Worker } = require("node:worker_threads");
function invalid() { return Object.assign(new Error("usage_query_invalid"), { statusCode: 400 }); }
function parseQuery(params, now = Date.now()) {
  const numeric = key => { const raw = params.get(key); return raw !== null && /^\d{10,16}$/.test(raw) ? Number(raw) : NaN; };
  const from = numeric("from"), to = numeric("to"), timeZone = params.get("timeZone") || "UTC";
  if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from <= 0 || to <= from || to - from > 366 * 86400000 || to > now + 2 * 86400000 || timeZone.length > 80) throw invalid();
  try { new Intl.DateTimeFormat("en", { timeZone }).format(); } catch { throw invalid(); }
  const query = { from, to, timeZone };
  for (const key of ["agent", "project", "model", "entry"]) {
    const value = params.get(key);
    if (value && (value.length > (key === "project" ? 4096 : 400) || /[\u0000-\u001f\u007f]/.test(value))) throw invalid();
    if (value) query[key] = value;
  }
  return query;
}
function createUsageAnalytics({ home, entries, pricing, roots = {}, now = Date.now } = {}) {
  let worker = null, cache = new Map(), flights = new Map(), serial = 0, pending = new Map(), closed = false, idle;
  function fail() {
    for (const { reject, timer } of pending.values()) { clearTimeout(timer); reject(Object.assign(new Error("usage_unavailable"), { statusCode: 503 })); }
    pending.clear(); worker = null;
  }
  function execute(input) {
    if (closed) return Promise.reject(Object.assign(new Error("usage_unavailable"), { statusCode: 503 }));
    clearTimeout(idle);
    if (!worker) {
      worker = new Worker(path.join(__dirname, "usage-analytics-worker.js"), { resourceLimits: { maxOldGenerationSizeMb: 192 } });
      const current = worker;
      current.on("error", () => { if (worker === current) fail(); }); current.on("exit", () => { if (worker === current) fail(); });
      current.on("message", value => {
        if (worker !== current) return;
        const item = pending.get(value.id); if (!item) return;
        pending.delete(value.id); clearTimeout(item.timer);
        if (value.error) item.reject(Object.assign(new Error(value.error), { statusCode: 503 })); else item.resolve(value.report);
        if (!pending.size) { current.unref(); idle = setTimeout(() => { const prior = worker; worker = null; void prior?.terminate(); }, 120000).unref(); }
      });
    }
    worker.ref();
    const id = ++serial;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { const prior = worker; worker = null; fail(); void prior?.terminate(); }, 25000).unref();
      pending.set(id, { resolve, reject, timer }); worker.postMessage({ id, input });
    });
  }
  async function read(query, { fresh = false } = {}) {
    const selected = entries();
    const signature = crypto.createHash("sha256").update(JSON.stringify(selected)).digest("hex");
    const key = JSON.stringify([signature, query]);
    const previous = cache.get(key);
    if (previous && now() - previous.at < (fresh ? 10000 : 30000)) return previous.report;
    if (flights.has(key)) return flights.get(key);
    if (flights.size >= 8) throw Object.assign(new Error("usage_unavailable"), { statusCode: 503 });
    // One bounded scan at a time, even if several devices pick different views.
    const flight = (async () => {
      await Promise.allSettled([...flights.values()]);
      const prices = await pricing.read();
      const report = await execute({ home, roots, entries: selected, query, prices: prices.models, priceUpdatedAt: prices.updatedAt });
      cache.set(key, { at: now(), report });
      while (cache.size > 8) cache.delete(cache.keys().next().value);
      return report;
    })().finally(() => flights.delete(key));
    flights.set(key, flight); return flight;
  }
  async function shutdown() { closed = true; clearTimeout(idle); cache.clear(); const prior = worker; worker = null; fail(); await prior?.terminate(); return { cleanupConfirmed: true }; }
  return { read, shutdown };
}
module.exports = { createUsageAnalytics, parseQuery };
