"use strict";
const { createHash } = require("node:crypto");
// Opaque comparison keys only. Neither login identifiers nor credentials leave
// the Host. Unknown identities stay separate; equal percentages prove nothing.
const digest = value => createHash("sha256").update(value).digest("hex");
function accountKey(service, value, kind = "account") {
  if (typeof value !== "string" || !value.trim() || value.length > 8192 || /[\x00-\x1f\x7f]/.test(value)) return null;
  return "v1:" + digest(JSON.stringify([service, kind, value]));
}
// The plan an account is on, as its vendor names it. Claude's profile names
// its organization's plan for display ("Ultra"), held to the pattern Claude
// Code holds it to, else by its kind ("claude_max"); either is shown as is or
// in words (planLabel). Nothing else of the profile is kept.
const CLAUDE_PLAN_NAME = /^[\p{L}\p{N}](?:[\p{L}\p{N} .+-]{0,38}[\p{L}\p{N}+])?$/u;
const PLAN_ID = /^[a-z][a-z0-9_]{0,63}$/;
function validClaudePlan(value) {
  return typeof value === "string" && (CLAUDE_PLAN_NAME.test(value) || PLAN_ID.test(value));
}
function claudePlan(profile) {
  const organization = profile?.organization, named = organization?.plan_display_name, kind = organization?.organization_type;
  if (typeof named === "string" && CLAUDE_PLAN_NAME.test(named)) return named;
  return typeof kind === "string" && PLAN_ID.test(kind) ? kind : null;
}
// A ChatGPT sign-in names its plan in the token ("prolite").
function chatgptPlan(payload) {
  const plan = payload?.["https://api.openai.com/auth"]?.chatgpt_plan_type;
  return typeof plan === "string" && PLAN_ID.test(plan) && plan !== "unknown" ? plan : null;
}
function boundAnthropicKey(credential) {
  const proof = credential?.anthropicIdentity;
  return proof?.v === 1 && typeof credential.access === "string" && credential.access
    && proof.bearerSha256 === digest(credential.access) ? accountKey("claude", proof.accountUuid) : null;
}
// The official profile of the bearer: the account's opaque key, the opaque
// key of its email as the alias another reader (Magpie) knows the same
// account by, and its plan. Neither the UUID nor the email leaves.
function createClaudeProfileReader({ fetchImpl = fetch, now = Date.now } = {}) {
  const cache = new Map();
  return async token => {
    if (typeof token !== "string" || !token) return { accountKey: null, accountAliases: [], plan: null };
    const key = digest(token), old = cache.get(key);
    if (old && now() - old.at < (old.value.accountKey ? 30 * 60 * 1000 : 60000)) return old.value;
    const value = { accountKey: null, accountAliases: [], plan: null };
    try {
      const res = await fetchImpl("https://api.anthropic.com/api/oauth/profile", {
        headers: { Authorization: "Bearer " + token, Accept: "application/json", "anthropic-beta": "oauth-2025-04-20" },
        redirect: "error", signal: AbortSignal.timeout(5000),
      });
      if (res.ok) {
        const profile = await res.json(), account = profile?.account;
        value.accountKey = accountKey("claude", account?.uuid);
        if (value.accountKey) value.plan = claudePlan(profile);
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
module.exports = { accountKey, boundAnthropicKey, createClaudeIdentityReader, createClaudeProfileReader, chatgptAliases, chatgptPlan, claudePlan, validClaudePlan };
