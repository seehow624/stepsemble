"use strict";

const INTERVAL_MS = 5 * 60 * 1000;
const RETRY_MS = 30 * 1000;
const { boundedJson } = require("./provider-live-catalog");

// Pi deliberately merges its static baseline with the remote overlay. For a
// newer complete catalog, hide baseline entries which upstream has retired.
// Explicit custom providers and extension-owned endpoints remain untouched.
function filterRetiredModels(models, { store = {}, providers = {}, generatedAt } = {}) {
  const catalogs = new Map();
  return models.filter(model => {
    const entry = store[model?.provider];
    const live = entry?.source?.kind === "provider-api";
    if ((!live && (!Number.isFinite(generatedAt) || !Number.isFinite(entry?.lastModified) || entry.lastModified <= generatedAt))
      || !Array.isArray(entry?.models) || (!live && !entry.models.length) || providers[model?.provider]) return true;
    if (!catalogs.has(model.provider)) catalogs.set(model.provider, {
      ids: new Set(entry.models.map(row => row.id)),
      endpoints: new Set([...(entry.source?.modelEndpoints || []), ...entry.models.map(row => row.baseUrl).filter(Boolean)]),
    });
    const { ids, endpoints } = catalogs.get(model.provider);
    return ids.has(model.id) || (!!model.baseUrl && !endpoints.has(model.baseUrl));
  });
}

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

// Public catalogs supply metadata/fallback; fixed official endpoints own the
// live roster when an eligible source exists. Credentials never reach Pi.
function createModelCatalogSync({ readStore, writeEntry, providerIds, fetch: request = globalThis.fetch,
  customSources = () => [], officialSource = () => null, generatedAt = () => 0,
  now = Date.now, offline = () => false, onChange = () => {}, version = "unknown" }) {
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
            const live = await officialSource(id);
            const metadataStored = stored?.source?.kind === "provider-api" ? stored.metadata : stored;
            const readPublic = async () => {
              const headers = { accept: "application/json", "user-agent": `Stepsemble/${version} (model catalog sync)` };
              if (metadataStored?.etag && metadataStored.models?.length) headers["if-none-match"] = metadataStored.etag;
              const response = await request(`https://pi.dev/api/models/providers/${encodeURIComponent(id)}`, { headers, signal, redirect: "error" });
              if (response.status === 404 || response.status === 501) return null;
              if (response.status === 304 && metadataStored?.models?.length) return { ...metadataStored, checkedAt: now() };
              if (response.status !== 200) throw new Error(`Catalog request failed (HTTP ${response.status})`);
              return { models: parseRemoteCatalogModels(id, await boundedJson(response)), checkedAt: now(),
                lastModified: Date.parse(response.headers.get("last-modified") || "") || 0,
                etag: response.headers.get("etag") || undefined };
            };
            const [metadataResult, liveResult] = await Promise.allSettled([readPublic(), live ? live.fetch({ signal }) : null]);
            const metadata = metadataResult.status === "fulfilled" ? metadataResult.value : null;
            let next, warning;
            if (live && !live.isCurrent()) throw new Error("Provider settings changed during refresh; will retry");
            if (live && liveResult.status === "fulfilled") {
              const models = live.normalize(liveResult.value, [
                ...(live.baseline || []), ...(metadataStored?.models || []), ...(metadata?.models || []),
              ]);
              next = { models, checkedAt: now(), lastModified: Math.max(now(), (generatedAt() || 0) + 1),
                metadata: metadata || metadataStored,
                source: { kind: "provider-api", url: live.endpoint, verifiedAt: now(),
                  modelEndpoints: [...new Set([...(live.baseline || []), ...(metadata?.models || []), ...(stored?.models || []), ...models].map(model => model.baseUrl).filter(Boolean))] } };
            } else if (live && stored?.source?.kind === "provider-api") {
              // Do not resurrect retired models from a fallback directory when
              // the authoritative endpoint is temporarily unavailable.
              next = { ...stored, metadata: metadata || stored.metadata };
              warning = "Official endpoint unavailable; using last verified provider catalog";
            } else if (metadata) {
              next = { ...metadata, source: { kind: "pi-directory", verifiedAt: now() } };
              if (live) warning = "Official endpoint unavailable; using Pi catalog fallback";
            } else if (live || metadataResult.status === "rejected") throw new Error("Model catalog sources unavailable; keeping cached models");
            else { refreshed.push({ id, changed: false, supported: false, source: "unavailable" }); continue; }
            if (warning) errors.push({ id, error: warning });
            const changed = JSON.stringify(stored?.models || []) !== JSON.stringify(next.models);
            // The storage adapter commits one provider under Pi's own file
            // lock; a concurrent Pi refresh cannot be overwritten wholesale.
            const committed = await writeEntry(id, next, stored);
            storeChanged ||= changed || committed === false;
            refreshed.push({ id, changed: changed && committed !== false, supported: true, models: next.models.length,
              source: next.source?.kind || "pi-directory", checkedAt: next.source?.verifiedAt || next.checkedAt,
              stale: !!warning, ...(committed === false ? { stale: true } : {}) });
            if (committed === false) errors.push({ id, error: "Catalog changed concurrently; will retry" });
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

module.exports = { createModelCatalogSync, parseRemoteCatalogModels, filterRetiredModels, INTERVAL_MS };
