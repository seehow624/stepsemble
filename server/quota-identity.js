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
// The official profile of the bearer: the account's opaque key, and the
// opaque key of its email as the alias another reader (Magpie) knows the
// same account by. Neither the UUID nor the email leaves.
function createClaudeProfileReader({ fetchImpl = fetch, now = Date.now } = {}) {
  const cache = new Map();
  return async token => {
    if (typeof token !== "string" || !token) return { accountKey: null, accountAliases: [] };
    const key = digest(token), old = cache.get(key);
    if (old && now() - old.at < (old.value.accountKey ? 30 * 60 * 1000 : 60000)) return old.value;
    const value = { accountKey: null, accountAliases: [] };
    try {
      const res = await fetchImpl("https://api.anthropic.com/api/oauth/profile", {
        headers: { Authorization: "Bearer " + token, Accept: "application/json", "anthropic-beta": "oauth-2025-04-20" },
        redirect: "error", signal: AbortSignal.timeout(5000),
      });
      if (res.ok) {
        const account = (await res.json())?.account;
        value.accountKey = accountKey("claude", account?.uuid);
        const email = typeof account?.email === "string" ? account.email.trim().toLowerCase() : "";
        const alias = value.accountKey && email.length <= 320 && /^[^\s@]+@[^\s@]+$/.test(email) ? accountKey("claude", email, "email") : null;
        if (alias && alias !== value.accountKey) value.accountAliases = [alias];
      }
    } catch { /* An unresolved identity never prevents showing the allowance. */ }
    if (cache.size >= 16) cache.delete(cache.keys().next().value);
    cache.set(key, { at: now(), value });
    return value;
  };
}
function createClaudeIdentityReader(options) {
  const profile = createClaudeProfileReader(options);
  return async token => (await profile(token)).accountKey;
}
// A ChatGPT sign-in names its account id and its email in the token the
// Codex CLI and Pi hold; the email's opaque key is the alias Magpie's reading
// of the same account carries.
function chatgptAliases(payload) {
  const email = typeof payload?.["https://api.openai.com/profile"]?.email === "string" ? payload["https://api.openai.com/profile"].email.trim().toLowerCase() : "";
  const alias = email.length <= 320 && /^[^\s@]+@[^\s@]+$/.test(email) ? accountKey("codex", email, "email") : null;
  return alias ? [alias] : [];
}
module.exports = { accountKey, boundAnthropicKey, createClaudeIdentityReader, createClaudeProfileReader, chatgptAliases };
