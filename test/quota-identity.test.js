"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), crypto = require("node:crypto");
const fs = require("node:fs/promises"), os = require("node:os"), path = require("node:path");
const { accountKey, boundAnthropicKey, createClaudeIdentityReader } = require("../server/quota-identity");
const { createWorkspaceUsage, opencodexQuotas } = require("../server/workspace-usage");
const { combineQuotas } = require("../public/modules/usage-data");
test("quota comparison keys hide identities and isolate providers and credential kinds", () => {
  const a = accountKey("claude", "account-one");
  assert.match(a, /^v1:[a-f0-9]{64}$/); assert(!a.includes("account-one"));
  assert.equal(a, accountKey("claude", "account-one"));
  assert.notEqual(a, accountKey("codex", "account-one"));
  assert.notEqual(a, accountKey("claude", "account-one", "api-key"));
  for (const value of [null, "", "a\nb", {}, " "]) assert.equal(accountKey("claude", value), null);
});
test("Claude profile identity follows the exact bearer and is cached without exporting credentials", async () => {
  const calls = [];
  const read = createClaudeIdentityReader({ fetchImpl: async (url, options) => {
    calls.push(options.headers.Authorization); assert.equal(options.redirect, "error"); assert(url.endsWith("/profile"));
    return { ok: true, json: async () => ({ account: { uuid: options.headers.Authorization === "Bearer old" ? "a" : "b" } }) };
  } });
  const a = await read("old"); assert.equal(a, await read("old")); assert.notEqual(a, await read("new"));
  assert.equal(calls.length, 2);
  assert.equal(await createClaudeIdentityReader({ fetchImpl: async () => { throw Error("offline"); } })("old"), null);
  const proof = { v: 1, accountUuid: "a", bearerSha256: crypto.createHash("sha256").update("old").digest("hex") };
  assert.equal(boundAnthropicKey({ access: "old", anthropicIdentity: proof }), a);
  assert.equal(boundAnthropicKey({ access: "new", anthropicIdentity: proof }), null);
});
const host = (id, identity, used, at = 1, extra = {}) => ({ host: id, name: id, quota: { updatedAt: at, providers: [{
  service: "claude", provider: "Claude", accountKey: identity, status: "ready", windows: [{ usedPercent: used }], ...extra,
}] } });
test("same accounts collapse using the freshest complete reading, never summed or mixed", () => {
  const key = accountKey("claude", "a"), a = host("mini", key, 20), b = host("mbp", key, 22, 2);
  const result = combineQuotas([a, b]); assert.equal(result.length, 1);
  assert.deepEqual(result[0].windows, [{ usedPercent: 22 }]); assert.equal(result[0].hosts.length, 2);
  assert.equal(a.quota.providers[0].windows[0].usedPercent, 20);
  b.unavailable = true;
  assert.equal(combineQuotas([a, b])[0].windows[0].usedPercent, 20);
  assert.equal(combineQuotas([a, host("mbp", key, 80, 10, { status: "cached" })])[0].windows[0].usedPercent, 20);
});
test("unknown, different, and switched accounts never merge just because quotas match", () => {
  const a = accountKey("claude", "a"), b = accountKey("claude", "b");
  for (const keys of [[null, null], [a, null], [a, b], ["invalid", "invalid"]]) {
    assert.equal(combineQuotas([host("mini", keys[0], 10), host("mbp", keys[1], 10)]).length, 2);
  }
  assert.equal(combineQuotas([host("mini", a, 10)]).length, 1);
});
test("Codex account changes during a native quota request cannot inherit the old identity", async () => {
  const quiet = { codex: async () => ({ rateLimits: { primary: { usedPercent: 12 } } }), readOpenCodex: async () => [], readProviderQuotas: async () => [],
    readClaudeToken: async () => null, readSignIn: async () => null, readClaudeCache: async () => null };
  const read = async () => ({ type: "oauth", secret: "private-access", accountId: "private-account" });
  const result = await createWorkspaceUsage({ ...quiet, readCodexSignIn: read }).read();
  assert.equal(result.providers[0].accountKey, accountKey("codex", "private-account"));
  assert(!JSON.stringify(result).includes("private-"));
  let n = 0;
  const changed = await createWorkspaceUsage({ ...quiet, readCodexSignIn: async () => ({ ...(await read()), secret: String(++n) }) }).read();
  assert.equal(changed.providers[0].accountKey, null);
});
test("OpenCodex Claude quota uses a bound per-account reading; old or mismatched identity stays separate", async t => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "quota-proof-")); t.after(() => fs.rm(home, { recursive: true, force: true }));
  const dir = path.join(home, ".opencodex"); await fs.mkdir(dir);
  await fs.writeFile(path.join(dir, "admin-api-token"), "private-admin");
  const proof = { v: 1, accountUuid: "private-account", bearerSha256: crypto.createHash("sha256").update("access").digest("hex") };
  const write = access => fs.writeFile(path.join(dir, "auth.json"), JSON.stringify({ anthropic: { accounts: [{ id: "slot", credential: { access, anthropicIdentity: proof } }] } }));
  await write("access");
  const read = () => opencodexQuotas({ home, osHome: home, env: {}, fetchImpl: async url => ({ ok: true, json: async () => url.includes("oauth/accounts")
    ? { activeAccountId: "slot", accounts: [{ id: "slot", quota: { fiveHourPercent: 12, updatedAt: 10 } }] }
    : { reports: [{ provider: "anthropic", quota: { fiveHourPercent: 99 } }, { provider: "openai", aggregation: { kind: "pool" } }] } }) });
  const result = await read(); assert.equal(result[0].accountKey, accountKey("claude", "private-account")); assert.equal(result[0].quota.fiveHourPercent, 12);
  assert(!JSON.stringify(result).includes("private-")); assert.equal(result[1].accountKey, undefined);
  await write("rotated"); assert.equal((await read())[0].accountKey, undefined);
});
