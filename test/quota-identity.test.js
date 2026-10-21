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

test("two Hosts with the same official Claude UUID select the freshest complete native sample, not totals", () => {
  const key = accountKey("claude", "11111111-1111-4111-8111-111111111111");
  const mini = host("mini", key, 20, 900, { sampledAt: 100, source: "native", windows: [{ usedPercent: 20, windowDurationMins: 300 }, { usedPercent: 35, windowDurationMins: 10080 }] });
  const mbp = host("mbp", key, 21, 800, { sampledAt: 200, source: "native", windows: [{ usedPercent: 21, windowDurationMins: 300 }, { usedPercent: 39, windowDurationMins: 10080 }] });
  const result = combineQuotas([mini, mbp]); assert.equal(result.length, 1);
  assert.deepEqual(result[0].windows.map(w => w.usedPercent), [21, 39]); assert.equal(result[0].hosts.length, 2);
  const cached = host("cache", key, 99, 1000, { sampledAt: 1000, status: "cached" });
  assert.deepEqual(combineQuotas([cached, mini, mbp])[0].windows.map(w => w.usedPercent), [21, 39]);
  mbp.unavailable = true;
  assert.deepEqual(combineQuotas([mini, mbp])[0].windows.map(w => w.usedPercent), [20, 35]);
  const changed = host("mbp", accountKey("claude", "22222222-2222-4222-8222-222222222222"), 20);
  assert.equal(combineQuotas([mini, changed]).length, 2);
  const emailDerived = host("magpie", accountKey("claude", "private@example.test", "email"), 20);
  assert.equal(combineQuotas([mini, emailDerived]).length, 2, "email and UUID are not verified aliases");
});

test("official UUID profile email alias merges native and Magpie across Hosts using freshest complete sample", () => {
  const uuid = accountKey("claude", "11111111-1111-4111-8111-111111111111");
  const email = accountKey("claude", "private@example.test", "email");
  const native = host("mini", uuid, 23, 100, { source: "native", accountAliases: [email], sampledAt: 100,
    windows: [{ usedPercent: 23, windowDurationMins: 300 }, { usedPercent: 47, windowDurationMins: 10080 }] });
  const magpie = host("mbp", email, 24, 200, { source: "magpie", sampledAt: 200,
    windows: [{ usedPercent: 24, windowDurationMins: 300 }, { usedPercent: 48, windowDurationMins: 10080 }] });
  for (const rows of [[native, magpie], [magpie, native]]) {
    const combined = combineQuotas(rows); assert.equal(combined.length, 1); assert.equal(combined[0].accountKey, uuid);
    assert.deepEqual(combined[0].windows.map(w => w.usedPercent), [24, 48]); assert.equal(combined[0].hosts.length, 2);
  }
  assert.equal(magpie.quota.providers[0].accountKey, email, "inputs remain unchanged");
  magpie.unavailable = true;
  assert.deepEqual(combineQuotas([native, magpie])[0].windows.map(w => w.usedPercent), [23, 47]);
  delete magpie.unavailable; magpie.quota.providers[0].status = "cached";
  assert.deepEqual(combineQuotas([native, magpie])[0].windows.map(w => w.usedPercent), [23, 47]);
});
test("conflicting UUID aliases, unverified claims and unknown CLI identities never bind an email-only reading", () => {
  const a = accountKey("claude", "uuid-a"), b = accountKey("claude", "uuid-b"), alias = accountKey("claude", "private@example.test", "email");
  const magpie = host("mbp", alias, 20, 10, { source: "magpie" });
  const native = extra => host("mini", a, 20, 9, { source: "native", accountAliases: [alias], ...extra });
  const conflicting = host("other", b, 20, 8, { source: "native", accountAliases: [alias], status: "cached" });
  assert.equal(combineQuotas([native(), conflicting, magpie]).length, 3, "two UUID claimants make the alias ambiguous");
  assert.equal(combineQuotas([native(), host("same-uuid", a, 20, 8, { source: "native", accountAliases: [alias] }), magpie]).length, 1);
  for (const extra of [{ accountKey: null }, { source: "magpie" }, { source: "signin" }, { accountAliases: ["invalid"] },
    { accountAliases: [alias, "v1:" + "c".repeat(64)] }, { windows: [] }, { status: "unavailable" }]) {
    assert.equal(combineQuotas([native(extra), magpie]).length, 2);
  }
  const anonymous = host("cli-cache", null, 20, 1, { source: "native", status: "cached", accountAliases: [alias] });
  assert.equal(combineQuotas([native(), magpie, anonymous]).length, 2, "anonymous cache remains unbound even alongside verified evidence");
});
