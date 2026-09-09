"use strict";
// Reserved Host-only registry. Catalog, principal references and authorization
// callbacks are trusted dependencies, never request fields or native credentials.
const crypto = require("node:crypto"), path = require("node:path");
const { normalizeSourceInput } = require("./history-source");
const { LIMITS, detach, keys, uuid, validPage } = require("./history-worker-wire");
const REGISTRY_LIMITS = Object.freeze({ slots: LIMITS.bindings, catalog: 256, leaseMs: 60000, maxLeaseMs: 86400000 });
const REGISTRY_CODES = Object.freeze(["invalid_history_registration", "invalid_history_request", "invalid_history_release",
  "invalid_source_signal", "history_principal_unavailable", "history_source_unavailable", "history_binding_unavailable",
  "history_view_conflict", "history_capacity_unavailable", "history_registry_closed", "history_registry_unavailable"]);
const unavailable = code => ({ kind: "source_unavailable", code });
const reference = value => typeof value === "string" && /^[A-Za-z0-9:_-]{1,128}$/.test(value);
const identity = value => uuid(value?.bindingId) && uuid(value?.viewId)
  && Number.isSafeInteger(value?.generation) && value.generation > 0;
function normalizeRegistrySource(input) {
  const source = normalizeSourceInput(input);
  return source && source.projectsRoot === path.resolve(source.projectsRoot) && source.projectsRoot !== path.parse(source.projectsRoot).root
    && !/[*?\[\]{},\r\n]/.test(source.projectsRoot) ? source : null;
}

/** A single bounded slot array retains generations across all owners. Inactive
 * principal refs occupy at most maxSlots entries; no per-principal/revocation
 * cache is created. Host must synchronously invalidate its credential authority
 * before revokePrincipal(), and principalActive must consult that authority.
 * Lease timers revoke only these read-only bindings, never native agent tasks.
 */
function createHistoryRegistry({ sourceService, catalog, authorize, principalActive, resolveSource,
  normalizeSource = normalizeRegistrySource, validReadPage = validPage, privateSourceBytes = LIMITS.inputBytes,
  maxSlots = REGISTRY_LIMITS.slots, leaseMs = REGISTRY_LIMITS.leaseMs, now = Date.now } = {}) {
  if (!sourceService || !["bind", "status", "shutdown"].every(k => typeof sourceService[k] === "function")
    || typeof authorize !== "function" || typeof principalActive !== "function" || typeof now !== "function"
    || resolveSource !== undefined && typeof resolveSource !== "function"
    || typeof normalizeSource !== "function" || typeof validReadPage !== "function"
    || !Number.isSafeInteger(privateSourceBytes) || privateSourceBytes < LIMITS.inputBytes || privateSourceBytes > 64 * 1024
    || !Number.isSafeInteger(maxSlots) || maxSlots < 1 || maxSlots > REGISTRY_LIMITS.slots
    || !Number.isSafeInteger(leaseMs) || leaseMs < 1 || leaseMs > REGISTRY_LIMITS.maxLeaseMs)
    throw new TypeError("invalid_history_registry_options");
  // A fixed catalog cannot be expanded by callers, even after source withdrawal.
  if (!Array.isArray(catalog) || catalog.length > REGISTRY_LIMITS.catalog) throw new TypeError("invalid_history_catalog");
  const sources = new Map();
  // Host-only format policy. Request bodies cannot select a normalizer, source
  // root, larger limit or second registry. Detach the policy result as well.
  const normalize = input => detach(normalizeSource(input), privateSourceBytes);
  for (const input of catalog) {
    const entry = detach(input, privateSourceBytes), source = normalize(entry?.source);
    if (!keys(entry, ["catalogId", "source"]) || !reference(entry.catalogId) || sources.has(entry.catalogId) || !source
      || !uuid(source.sessionId)) throw new TypeError("invalid_history_catalog");
    sources.set(entry.catalogId, { source: Object.freeze(source), active: true });
  }
  const slots = []; let closed = false, failed = false, leaseTimer = null, shutdownPromise = null;
  function time() {
    const value = now();
    if (!Number.isSafeInteger(value) || value < 0 || value > Number.MAX_SAFE_INTEGER - leaseMs) throw new Error("invalid_clock");
    return value;
  }
  function serviceFailure() {
    if (closed) return "history_registry_closed";
    if (failed) return "history_registry_unavailable";
    try {
      const state = sourceService.status();
      if (state.quarantined === true) return "source_service_quarantined";
      if (state.closed === true) return "source_service_closed";
      if (state.quarantined !== false || state.closed !== false) return "history_registry_unavailable";
    } catch { return "history_registry_unavailable"; }
    return null;
  }
  function activePrincipal(principal) {
    try { return reference(principal) && principalActive(principal) === true; } catch { return false; }
  }
  function selected(principal, catalogId) {
    try {
      // Authorization precedes private lookup. The optional Host resolver owns
      // its bounded inventory; the registry retains only its 64 live slot refs,
      // never copies a dynamic inventory into the legacy 256-entry catalog.
      if (authorize(principal, catalogId) !== true) return null;
      const fixed = sources.get(catalogId);
      if (fixed) return fixed.active ? { source: fixed.source, key: "fixed" } : null;
      const resolved = resolveSource?.(principal, catalogId);
      if (resolved instanceof Promise) { void Promise.prototype.then.call(resolved, undefined, () => {}); return null; }
      const value = detach(resolved, privateSourceBytes);
      const source = normalize(value?.source);
      if (!keys(value, ["source", "revision"]) || !reference(value.revision) || !source || !uuid(source.sessionId)) return null;
      return { source, key: crypto.createHash("sha256").update(JSON.stringify([source, value.revision])).digest("hex") };
    } catch { return null; }
  }
  function allowed(principal, catalogId, sourceKey) {
    const value = selected(principal, catalogId);
    return value !== null && (sourceKey === undefined || sourceKey === value.key);
  }
  function collect(slot) {
    if (slot.state !== "closing" || !slot.handle) return;
    try {
      const status = slot.handle.status();
      // A settled request (including cleanup timeout) is not close evidence.
      if (status.revoked === true && status.activeWorker === false && status.cleanupConfirmed === true) {
        slot.row = null; slot.handle = null; slot.state = "idle";
      }
    } catch { failed = true; }
  }
  function retire(slot) {
    if (slot.state !== "active" && slot.state !== "binding") { collect(slot); return; }
    slot.row.active = false; slot.state = "closing"; // Invalidate before revoke can synchronously call back.
    try { slot.handle?.revoke(); } catch { failed = true; }
    collect(slot);
  }
  function schedule() {
    clearTimeout(leaseTimer); leaseTimer = null;
    if (closed || failed) return;
    const live = slots.filter(s => s.state === "active");
    if (!live.length) return;
    try {
      const delay = Math.max(1, Math.min(...live.map(s => s.row.expiresAt)) - time());
      leaseTimer = setTimeout(sweep, delay); leaseTimer.unref?.();
    } catch { failed = true; for (const slot of slots) retire(slot); }
  }
  function sweep() {
    let current;
    try { current = time(); } catch { failed = true; }
    for (const slot of slots) {
      if (slot.state === "active" && (failed || current >= slot.row.expiresAt
        || !activePrincipal(slot.owner) || !allowed(slot.owner, slot.row.catalogId, slot.row.sourceKey))) retire(slot);
      collect(slot);
    }
    schedule(); return status();
  }
  function descriptor(row) {
    const receipt = Object.freeze({ kind: "history_registration", bindingId: row.bindingId, generation: row.generation,
      sessionId: row.sessionId, viewId: row.viewId, catalogId: row.catalogId, expiresAt: row.expiresAt,
      sourceAuthenticated: false, publishable: false });
    // Private object identity, never serialized authority. A lost registration
    // response can be rolled back only while this exact attempt is unclaimed.
    row.receipt = row.claimed ? null : receipt;
    return receipt;
  }
  function register(principal, input) {
    const request = detach(input);
    if (!keys(request, ["catalogId", "viewId"]) || !reference(request.catalogId) || !uuid(request.viewId))
      return unavailable("invalid_history_registration");
    sweep(); const failure = serviceFailure(); if (failure) return unavailable(failure);
    if (!activePrincipal(principal)) return unavailable("history_principal_unavailable");
    const selection = selected(principal, request.catalogId);
    if (!selection) return unavailable("history_source_unavailable");
    const existing = slots.find(s => s.state === "active" && s.owner === principal && s.row.viewId === request.viewId);
    if (existing) {
      if (existing.row.catalogId === request.catalogId) {
        existing.row.expiresAt = time() + leaseMs; schedule(); return descriptor(existing.row);
      }
      if (existing.row.claimed) return unavailable("history_view_conflict");
      // Authorization for the new catalog was checked above. An unobserved
      // registration may have a lost HTTP reply; replace it without requiring
      // the caller to possess that reply, still respecting actual-close reuse.
      retire(existing);
      const retiringFailure = serviceFailure(); if (retiringFailure) { schedule(); return unavailable(retiringFailure); }
    }
    // Prefer this owner's idle slot, then atomically transfer any confirmed-idle
    // slot. Old row objects/callbacks never observe the new generation or owner.
    let slot = slots.find(s => s.state === "idle" && s.owner === principal && s.generation < Number.MAX_SAFE_INTEGER)
      || slots.find(s => s.state === "idle" && s.generation < Number.MAX_SAFE_INTEGER);
    if (!slot && slots.length < maxSlots) {
      slot = { bindingId: crypto.randomUUID(), generation: 0, owner: null, row: null, handle: null, state: "idle" }; slots.push(slot);
    }
    if (!slot) return unavailable("history_capacity_unavailable");
    const { source } = selection;
    const row = { ...request, bindingId: slot.bindingId, generation: slot.generation + 1,
      sessionId: source.sessionId, agentId: source.agentId ?? "claude-code", sourceKey: selection.key, expiresAt: time() + leaseMs, active: true, claimed: false, receipt: null };
    slot.generation = row.generation; slot.owner = principal; slot.row = row; slot.state = "binding";
    let handle;
    try { handle = sourceService.bind({ bindingId: row.bindingId, generation: row.generation, source }); }
    catch { failed = true; retire(slot); schedule(); return unavailable("history_registry_unavailable"); }
    if (handle?.kind !== "bound_source") {
      row.active = false; slot.row = null; slot.state = "idle"; schedule();
      if (handle?.kind === "source_unavailable") return handle;
      failed = true; return unavailable("history_registry_unavailable");
    }
    slot.handle = handle;
    if (!row.active || serviceFailure() || !activePrincipal(principal) || !allowed(principal, row.catalogId, row.sourceKey)) {
      // A trusted hook may revoke while bind is running, before handle exists.
      slot.state = "active"; retire(slot); schedule(); return unavailable("history_binding_unavailable");
    }
    slot.state = "active"; schedule(); return descriptor(row);
  }
  function owned(principal, request) {
    sweep();
    if (serviceFailure() || !activePrincipal(principal)) return null;
    const slot = slots.find(s => s.bindingId === request.bindingId);
    if (!slot || slot.state !== "active" || slot.owner !== principal || slot.generation !== request.generation
      || slot.row.viewId !== request.viewId || !allowed(principal, slot.row.catalogId, slot.row.sourceKey)) return null;
    return slot;
  }
  function current(principal, input) {
    const request = detach(input);
    return !!(keys(request, ["bindingId", "generation", "viewId"]) && identity(request) && owned(principal, request));
  }
  async function read(principal, input, options, metadata) {
    const request = detach(input);
    if (!keys(request, ["bindingId", "generation", "viewId", "requestId", ...(metadata ? [] : ["page", ...(Object.hasOwn(request ?? {}, "structured") ? ["structured"] : []), ...(Object.hasOwn(request ?? {}, "profile") ? ["profile"] : [])]), ...(request?.version === undefined ? [] : ["version"])])
      || !identity(request) || !uuid(request.requestId) || !metadata && validReadPage(request.page, request.profile) !== true
      || Object.hasOwn(request, "structured") && request.structured !== true
      || Object.hasOwn(request, "profile") && (request.profile !== "codex_validated_page_v1" || request.structured !== undefined)
      || request.version !== undefined && (typeof request.version !== "string" || !/^[a-f0-9]{64}$/.test(request.version)))
      return unavailable("invalid_history_request");
    if (!options || ![Object.prototype, null].includes(Object.getPrototypeOf(options)) || Object.getOwnPropertySymbols(options).length
      || Object.entries(Object.getOwnPropertyDescriptors(options)).some(([key, d]) => key !== "signal" || !Object.hasOwn(d, "value"))
      || options.signal !== undefined && !(options.signal instanceof AbortSignal)) return unavailable("invalid_source_signal");
    const slot = owned(principal, request);
    if (!slot) return unavailable(serviceFailure() || "history_binding_unavailable");
    const row = slot.row, handle = slot.handle;
    if ((request.structured === true || request.profile !== undefined) && row.agentId !== "codex") return unavailable("invalid_history_request");
    if (metadata && typeof handle.metadata !== "function") return unavailable("history_source_unavailable");
    // Claim synchronously, before source work or its callbacks. Once observed,
    // even a later renewal cannot make this row cancellable by an HTTP receipt.
    row.claimed = true; row.receipt = null;
    let result;
    try {
      result = await handle[metadata ? "metadata" : "observe"]({ bindingId: request.bindingId, generation: request.generation, requestId: request.requestId },
        { ...(metadata ? {} : { page: request.page }), ...(request.structured === true ? { structured: true } : {}),
          ...(request.profile === undefined ? {} : { profile: request.profile }),
          ...(request.version === undefined ? {} : { version: request.version }), signal: options.signal });
    } catch {
      if (slot.row === row) retire(slot);
      schedule(); return unavailable("history_registry_unavailable");
    }
    // Always recheck the live credential, catalog, lease and exact old row after
    // async work. An old completion cannot authorize a transferred slot.
    const live = owned(principal, request);
    if (result?.code === "source_cleanup_unconfirmed") return result;
    if (options.signal?.aborted) return unavailable("source_aborted");
    if (!live || live !== slot || live.row !== row || !row.active) return unavailable(serviceFailure() || "history_binding_unavailable");
    return result;
  }
  function release(principal, input) {
    const request = detach(input);
    if (!keys(request, ["bindingId", "generation", "viewId"]) || !identity(request)) return unavailable("invalid_history_release");
    const slot = owned(principal, request);
    if (!slot) return unavailable(serviceFailure() || "history_binding_unavailable");
    retire(slot); schedule(); return { kind: "history_released", cleanupConfirmed: slot.state === "idle" };
  }
  function cancelRegistration(principal, receipt) {
    if (!reference(principal) || !receipt || typeof receipt !== "object") return false;
    const slot = slots.find(s => s.state === "active" && s.owner === principal && !s.row.claimed && s.row.receipt === receipt);
    if (!slot) return false;
    // Auth may already have been revoked; the unforgeable in-process receipt
    // permits cleanup of this old row, never access or cleanup of a newer one.
    retire(slot); schedule(); return true; // Logical retirement, not actual-close evidence.
  }
  function revokePrincipal(principal) {
    if (!reference(principal)) return unavailable("history_principal_unavailable");
    for (const slot of slots) if (slot.owner === principal) retire(slot);
    schedule(); return status();
  }
  function revokeSource(catalogId) {
    // Dynamic owners must withdraw their resolver/ACL first. No unbounded
    // dynamic tombstone set is kept here; sweep also fences revision changes.
    const entry = sources.get(catalogId); if (entry) entry.active = false;
    for (const slot of slots) if (slot.row?.catalogId === catalogId) retire(slot);
    schedule(); return status();
  }
  function status() {
    return { closed, failed, retainedSlots: slots.length, activeSlots: slots.filter(s => s.state === "active").length,
      closingSlots: slots.filter(s => s.state === "closing").length, idleSlots: slots.filter(s => s.state === "idle").length,
      catalogSources: sources.size };
  }
  function shutdown() {
    if (shutdownPromise) return shutdownPromise;
    closed = true; clearTimeout(leaseTimer); leaseTimer = null;
    for (const slot of slots) retire(slot);
    shutdownPromise = (async () => {
      try {
        const result = await sourceService.shutdown();
        for (const slot of slots) collect(slot);
        return { kind: "history_registry_closed", cleanupConfirmed: result.cleanupConfirmed === true
          && slots.every(s => s.state === "idle"), quarantined: result.quarantined === true };
      } catch { failed = true; return { kind: "history_registry_closed", cleanupConfirmed: false, quarantined: true }; }
    })();
    return shutdownPromise;
  }
  return Object.freeze({ register, observe: (principal, request, options = {}) => read(principal, request, options, false),
    metadata: (principal, request, options = {}) => read(principal, request, options, true),
    release, cancelRegistration, current, revokePrincipal, revokeSource, sweep, status, shutdown });
}
module.exports = { createHistoryRegistry, normalizeRegistrySource, REGISTRY_LIMITS, REGISTRY_CODES };
