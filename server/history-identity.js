"use strict";
// Private Host adapter, not a credential store or per-tab authentication layer.
// Existing token/grant authority is injected. Native provider credentials are
// never read here; public responses must never include these principal refs.
const crypto = require("node:crypto");
const { canonicalJSON } = require("../public/modules/projection");
const LIMITS = Object.freeze({ browser: 21, peer: 128 });
const reference = v => typeof v === "string" && /^[A-Za-z0-9:_-]{1,128}$/.test(v);
const hash = v => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
const exact = (v, keys) => v && typeof v === "object" && !Array.isArray(v)
  && Object.keys(v).sort().join(",") === keys.slice().sort().join(",");

function createHistoryIdentity({ browserCredentials, peerGrantIds, authenticatePeerCredential, onRevoke } = {}) {
  if (![browserCredentials, peerGrantIds, authenticatePeerCredential, onRevoke].every(f => typeof f === "function"))
    throw new TypeError("history_identity_dependencies_required");
  const salt = crypto.randomBytes(32), entries = new Map(); let closed = false, failed = false, clearing = false;
  const fingerprint = value => crypto.createHmac("sha256", salt).update(value).digest("hex");
  function retire(key) {
    const entry = entries.get(key); if (!entry) return;
    entries.delete(key); // Invalidate before the callback can synchronously re-enter.
    try { onRevoke(entry.principal); } catch {
      failed = true;
      // A failed fan-out makes every identity unavailable. Also attempt to
      // stop the other principals' active workers now, not only on their next
      // request. clear's reentrancy guard bounds repeated callback failures.
      clear();
    }
  }
  function clear() {
    if (clearing) return; clearing = true;
    try { for (const key of [...entries.keys()]) retire(key); } finally { clearing = false; }
  }
  function snapshot() {
    if (closed || failed) return null;
    try {
      // Dependencies are trusted, but malformed state must not appear as an
      // empty valid credential catalog or authorize cached identities.
      const raw = canonicalJSON({ browser: browserCredentials(), peer: peerGrantIds() }, 65536);
      if (raw === null) throw new Error();
      const value = JSON.parse(raw);
      if (!Array.isArray(value.browser) || value.browser.length > LIMITS.browser
        || !Array.isArray(value.peer) || value.peer.length > LIMITS.peer) throw new Error();
      const current = new Map();
      for (const row of value.browser) {
        if (!exact(row, ["id", "hash"]) || !reference(row.id) || !hash(row.hash) || current.has(`browser:${row.id}`)) throw new Error();
        current.set(`browser:${row.id}`, fingerprint(row.hash));
      }
      for (const id of value.peer) {
        if (!reference(id) || current.has(`peer:${id}`)) throw new Error();
        current.set(`peer:${id}`, fingerprint(`peer:${id}`));
      }
      for (const [key, entry] of entries) if (current.get(key) !== entry.fingerprint) retire(key);
      if (failed) { clear(); return null; }
      return { browser: value.browser, current };
    } catch { clear(); return null; }
  }
  function principal(key, current) {
    if (!current.has(key) || closed || failed) return null;
    let entry = entries.get(key);
    if (!entry) {
      if (entries.size >= LIMITS.browser + LIMITS.peer) return null;
      entry = { principal: `history:${crypto.randomUUID()}`, fingerprint: current.get(key) };
      entries.set(key, entry);
    }
    return entry.principal;
  }
  function browser(cookieName, candidate) {
    if (!["stepsemble", "pi_harbor", "pi_web"].includes(cookieName) || !hash(candidate)) return null;
    const state = snapshot(); if (!state) return null;
    const bytes = Buffer.from(candidate, "hex");
    const row = state.browser.find(row => crypto.timingSafeEqual(bytes, Buffer.from(row.hash, "hex")));
    return row ? principal(`browser:${row.id}`, state.current) : null;
  }
  function peer(candidate) {
    if (!hash(candidate)) return null;
    const state = snapshot(); if (!state) return null;
    try {
      const result = authenticatePeerCredential(candidate);
      return reference(result?.grantId) ? principal(`peer:${result.grantId}`, state.current) : null;
    } catch { return null; }
  }
  function isPrincipalCurrent(value) {
    if (!reference(value) || !snapshot()) return false;
    return [...entries.values()].some(entry => entry.principal === value);
  }
  function invalidateBrowserCredential(id) {
    if (!reference(id)) return false;
    const existed = entries.has(`browser:${id}`); retire(`browser:${id}`); return existed;
  }
  function invalidateBrowserCookie(cookieName, candidate) {
    const value = browser(cookieName, candidate);
    if (!value) return false;
    for (const [key, entry] of entries) if (entry.principal === value) { retire(key); return true; }
    return false;
  }
  function invalidatePeerGrant(id) {
    if (!reference(id)) return false;
    const existed = entries.has(`peer:${id}`); retire(`peer:${id}`); return existed;
  }
  return Object.freeze({ authenticateBrowserCookie: browser, authenticatePeerCredential: peer, isPrincipalCurrent,
    invalidateBrowserCredential, invalidateBrowserCookie, invalidatePeerGrant,
    refresh: () => snapshot() !== null,
    shutdown() { closed = true; clear(); },
    status: () => Object.freeze({ closed, failed, retainedPrincipals: entries.size }) });
}
module.exports = { createHistoryIdentity, LIMITS };
