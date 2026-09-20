"use strict";

const INTERVAL_MS = 5 * 60 * 1000;
const RETRY_MS = 30 * 1000;

function parseRemoteCatalogModels(providerId, value) {
  const entries = Array.isArray(value) ? value
    : Array.isArray(value?.models) ? value.models
      : value && typeof value === "object" ? Object.values(value) : null;
  if (!entries?.length || entries.length > 10000) throw new Error("Invalid or empty model catalog");
  const ids = new Set();
  return entries.map(entry => {
    if (!entry || typeof entry.id !== "string" || !entry.id.trim() || ids.has(entry.id)) {
      throw new Error("Invalid or duplicate model in catalog");
    }
    ids.add(entry.id);
    return { ...entry, provider: providerId };
  });
}

// Only fetch public catalogs here. Authentication and custom endpoints stay
// with their existing provider implementations.
function createModelCatalogSync({ readStore, writeEntry, providerIds, fetch: request = globalThis.fetch,
  customSources = () => [], now = Date.now, offline = () => false, onChange = () => {}, version = "unknown" }) {
  let pending = null;
  let nextCheck = 0;
  let state = { checkedAt: null, refreshed: [], errors: [], storeChanged: false };

  function refresh({ force = false } = {}) {
    if (pending) return pending;
    if (offline()) return Promise.resolve({ ...state, skipped: true, reason: "PI_OFFLINE" });
    if (!force && now() < nextCheck) return Promise.resolve(state);
    pending = (async () => {
      const store = await readStore();
      if (!store || typeof store !== "object" || Array.isArray(store)) throw new Error("Invalid cached model catalog");
      const sources = await customSources();
      const customIds = new Set(sources.map(source => source.id));
      const ids = [...new Set([...Object.keys(store), ...await providerIds()])]
        .filter(id => /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(id) && !customIds.has(id));
      const jobs = [...ids.map(id => ({ id })), ...sources];
      const signal = AbortSignal.timeout(8000);
      const refreshed = [], errors = [];
      let storeChanged = false, cursor = 0;
      async function worker() {
        while (cursor < jobs.length) {
          const source = jobs[cursor++], id = source.id, stored = store[id];
          try {
            signal.throwIfAborted();
            if (source.refresh) {
              const result = await source.refresh({ signal });
              storeChanged ||= result.changed;
              refreshed.push({ id, supported: true, ...result });
              continue;
            }
            const headers = { accept: "application/json", "user-agent": `Stepsemble/${version} (model catalog sync)` };
            if (stored?.etag && stored.models?.length) headers["if-none-match"] = stored.etag;
            const response = await request(`https://pi.dev/api/models/providers/${encodeURIComponent(id)}`, {
              headers, signal, redirect: "error",
            });
            const checkedAt = now();
            if (response.status === 404 || response.status === 501) {
              refreshed.push({ id, changed: false, supported: false });
              continue;
            }
            let next;
            if (response.status === 304 && stored?.models?.length) {
              next = { ...stored, checkedAt };
            } else if (response.status === 200) {
              const body = await response.text();
              if (Buffer.byteLength(body) > 8 * 1024 * 1024) throw new Error("Model catalog is too large");
              next = { models: parseRemoteCatalogModels(id, JSON.parse(body)), checkedAt,
                lastModified: Date.parse(response.headers.get("last-modified") || "") || 0,
                etag: response.headers.get("etag") || undefined };
            } else throw new Error(`Catalog request failed (HTTP ${response.status})`);
            const changed = JSON.stringify(stored?.models || []) !== JSON.stringify(next.models);
            // The storage adapter commits one provider under Pi's own file
            // lock; a concurrent Pi refresh cannot be overwritten wholesale.
            const committed = await writeEntry(id, next, stored);
            storeChanged ||= changed || committed === false;
            refreshed.push({ id, changed, supported: true, models: next.models.length });
          } catch (error) {
            errors.push({ id, error: error.message || "Model catalog check failed" });
          }
        }
      }
      await Promise.all(Array.from({ length: Math.min(4, jobs.length) }, worker));
      if (storeChanged) onChange();
      state = { checkedAt: now(), refreshed, errors, storeChanged };
      nextCheck = now() + (errors.length ? RETRY_MS : INTERVAL_MS);
      return state;
    })().catch(error => {
      nextCheck = now() + RETRY_MS;
      state = { ...state, errors: [{ id: null, error: error.message || "Model catalog check failed" }] };
      return state;
    }).finally(() => { pending = null; });
    return pending;
  }
  return { refresh, status: () => ({ ...state, nextCheckAt: nextCheck }) };
}

module.exports = { createModelCatalogSync, parseRemoteCatalogModels, INTERVAL_MS };
