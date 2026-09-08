"use strict";
// Host-private, opt-in source-group inventory. Not mounted in HTTP or the legacy
// catalog. Metadata identities are candidates, never titles or resume authority.
const crypto = require("node:crypto");
const { canonicalJSON } = require("../../../public/modules/projection");
const { createNativeHelper } = require("./history-native-helper");
const wire = require("./history-inventory-wire");
const unavailable = code => ({ kind: "source_unavailable", code });
const own = (v, allowed) => !!v && typeof v === "object" && !Array.isArray(v)
  && [Object.prototype, null].includes(Object.getPrototypeOf(v)) && !Object.getOwnPropertySymbols(v).length
  && Object.entries(Object.getOwnPropertyDescriptors(v)).every(([k, d]) => allowed.includes(k) && Object.hasOwn(d, "value"));
function createSourceIndex(options) {
  if (!own(options, ["sourceId", "source", "helperPath", "authorize", "createHelper"])) throw new TypeError("invalid_source_index_options");
  const { sourceId, helperPath, authorize, createHelper = createNativeHelper } = options;
  const encoded = canonicalJSON(options.source, 12 * 1024), source = encoded === null ? null : JSON.parse(encoded);
  if (typeof sourceId !== "string" || !/^[A-Za-z0-9:_-]{1,128}$/.test(sourceId) || !wire.input(source)
    || typeof authorize !== "function" || typeof createHelper !== "function") throw new TypeError("invalid_source_index_options");
  const helper = createHelper({ executablePath: helperPath, trustBoundary: "host_managed_executable" });
  if (!helper || !["inventory", "status", "shutdown"].every(k => typeof helper[k] === "function")) throw new TypeError("invalid_source_index_helper");
  let closed = false, quarantined = false, flight = null, revision = 0, snapshot = null, stale = true, lastError = null, shutdownPromise;
  function allowed(principal) {
    try { return typeof principal === "string" && /^[A-Za-z0-9:_-]{1,128}$/.test(principal) && authorize(principal, sourceId) === true; }
    catch { return false; }
  }
  function failure() {
    if (closed) return "source_service_closed";
    if (quarantined) return "source_service_quarantined";
    try {
      const state = helper.status();
      if (state.quarantined === true) return "source_service_quarantined";
      if (state.closed !== false || state.quarantined !== false) return "source_worker_failure";
    } catch { return "source_worker_failure"; }
    return null;
  }
  function view(principal) {
    if (!allowed(principal)) return unavailable("history_source_unavailable");
    const code = failure(); if (code) return unavailable(code);
    // Detached private source paths must never be sent directly to a Client.
    return { kind: "source_inventory_state", sourceId, revision, stale, refreshing: flight !== null, lastError,
      snapshot: snapshot === null ? null : structuredClone(snapshot), sourceAuthenticated: false, publishable: false };
  }
  async function refresh(principal, options = {}) {
    if (!own(options, ["signal"]) || options.signal !== undefined && !(options.signal instanceof AbortSignal)) return unavailable("invalid_source_signal");
    if (!allowed(principal)) return unavailable("history_source_unavailable");
    const problem = failure(); if (problem) return unavailable(problem);
    if (options.signal?.aborted) return unavailable("source_aborted");
    if (flight || helper.status().activeWorker) return unavailable("source_busy");
    if (revision === Number.MAX_SAFE_INTEGER) return unavailable("source_inventory_limit");
    const controller = new AbortController(), current = { principal, controller, revoked: false };
    flight = current; stale = true;
    const abort = () => controller.abort(); options.signal?.addEventListener("abort", abort, { once: true });
    try {
      const raw = await helper.inventory(structuredClone(source), { signal: controller.signal });
      const status = helper.status();
      if (status.quarantined || status.activeWorker || status.cleanupConfirmed !== true) {
        quarantined = true;
        lastError = "source_cleanup_unconfirmed"; return unavailable(lastError);
      }
      if (closed || current.revoked || controller.signal.aborted || !allowed(principal)) {
        lastError = "source_aborted"; return unavailable(lastError);
      }
      // A trusted test/helper injection cannot bypass structural checks. Re-encode
      // detached metadata through the same decoder, with no executable getters.
      const json = canonicalJSON(raw, wire.LIMITS.bytes + 16384), value = json === null ? null : JSON.parse(json);
      if (value?.kind !== "native_source_inventory") {
        const known = require("./history-native-helper").SOURCE_CODES;
        lastError = value?.kind === "source_unavailable" && known.includes(value.code) ? value.code : "source_worker_failure";
        return unavailable(lastError);
      }
      const { entries, cleanupConfirmed, ...header } = value;
      const bytes = Buffer.from(JSON.stringify(entries));
      // The original payload may use a different key order. Validate the supplied
      // original digest's shape but derive a new local digest for this re-encoding.
      if (cleanupConfirmed !== true || typeof header.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(header.sha256)) throw new Error();
      const checked = wire.decode({ ...header, byteLength: bytes.length, sha256: crypto.createHash("sha256").update(bytes).digest("hex") }, bytes, source);
      if (!checked) throw new Error();
      const next = checked.entries.map(e => ({ catalogId: "claude-" + crypto.createHash("sha256")
        .update(JSON.stringify([sourceId, source.projectsRoot, source.expectedRoot.device, source.expectedRoot.inode, e.projectKey, e.sessionId])).digest("hex"),
        source: { projectsRoot: source.projectsRoot, projectKey: e.projectKey, sessionId: e.sessionId }, identity: e.identity }));
      const old = new Map((snapshot?.entries ?? []).map(e => [e.catalogId, e]));
      let added = 0, changed = 0;
      for (const entry of next) {
        const previous = old.get(entry.catalogId);
        if (!previous) added++; else if (JSON.stringify(previous.identity) !== JSON.stringify(entry.identity)) changed++;
        old.delete(entry.catalogId);
      }
      snapshot = { entries: next, projectsScanned: checked.projectsScanned, ignoredEntries: checked.ignoredEntries,
        changes: { added, changed, removed: old.size } };
      revision++; stale = false; lastError = null; flight = null;
      return view(principal);
    } catch { lastError = "source_worker_failure"; return unavailable(lastError); }
    finally { if (flight === current) flight = null; options.signal?.removeEventListener("abort", abort); }
  }
  function revokePrincipal(principal) {
    if (flight?.principal === principal) { flight.revoked = true; flight.controller.abort(); }
  }
  function shutdown() {
    if (!closed) { closed = true; stale = true; snapshot = null; flight?.controller.abort(); shutdownPromise = helper.shutdown(); }
    return shutdownPromise;
  }
  return Object.freeze({ refresh, view, revokePrincipal, shutdown,
    status: () => ({ closed, quarantined, revision, stale, retainedEntries: snapshot?.entries.length ?? 0, refreshing: flight !== null }) });
}
module.exports = { createSourceIndex };
