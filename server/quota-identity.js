"use strict";
const { createHash } = require("node:crypto");
// Opaque comparison keys only. Neither login identifiers nor credentials leave
// the Host. Unknown identities stay separate; equal percentages prove nothing.
const digest = value => createHash("sha256").update(value).digest("hex");
function accountKey(service, value, kind = "account") {
  if (typeof value !== "string" || !value.trim() || value.length > 8192 || /[\x00-\x1f\x7f]/.test(value)) return null;
  return "v1:" + digest(JSON.stringify([service, kind, value]));
}
function boundAnthropicKey(credential) {
  const proof = credential?.anthropicIdentity;
  return proof?.v === 1 && typeof credential.access === "string" && credential.access
    && proof.bearerSha256 === digest(credential.access) ? accountKey("claude", proof.accountUuid) : null;
}
function createClaudeIdentityReader({ fetchImpl = fetch, now = Date.now } = {}) {
  const cache = new Map();
  return async token => {
    if (typeof token !== "string" || !token) return null;
    const key = digest(token), old = cache.get(key);
    if (old && now() - old.at < (old.value ? 30 * 60 * 1000 : 60000)) return old.value;
    let value = null;
    try {
      const res = await fetchImpl("https://api.anthropic.com/api/oauth/profile", {
        headers: { Authorization: "Bearer " + token, Accept: "application/json", "anthropic-beta": "oauth-2025-04-20" },
        redirect: "error", signal: AbortSignal.timeout(5000),
      });
      if (res.ok) value = accountKey("claude", (await res.json())?.account?.uuid);
    } catch { /* An unresolved identity never prevents showing the allowance. */ }
    if (cache.size >= 16) cache.delete(cache.keys().next().value);
    cache.set(key, { at: now(), value });
    return value;
  };
}
module.exports = { accountKey, boundAnthropicKey, createClaudeIdentityReader };
