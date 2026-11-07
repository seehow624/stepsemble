"use strict";

// Limits names each account's plan beside its service, shows the weeks Claude
// limits for one model apart ("Fable"), and counts a key used on two
// computers once.
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { claudeWindows } = require("../server/quota-windows");
const { createDesktopQuotaReader, sanitizeClaudeQuota } = require("../server/claude-quota");
const { accountKey, claudePlan, chatgptPlan, createClaudeProfileReader } = require("../server/quota-identity");
const { createWorkspaceUsage, codexPlan, claudeLocal } = require("../server/workspace-usage");
const { keyFingerprints, withKeyIdentities, quotaEntries } = require("../server/magpie-gateway-service");
const { planLabel, combineQuotas } = require("../public/modules/usage-data");

const UUID = "11111111-1111-4111-8111-111111111111", EPOCH = 1794000000000;
const RESET = "2026-11-09T02:00:00+00:00";
// Claude's usage endpoint as Claude Code 2.1.319 reads it: the five hours not
// started, the week, and the week of Fable apart, in `limits`.
const USAGE = { five_hour: null, seven_day: { utilization: 70, resets_at: RESET },
  limits: [{ kind: "weekly_all", group: "weekly", percent: 70, resets_at: RESET, scope: null },
    { kind: "weekly_scoped", group: "weekly", percent: 35, resets_at: RESET, scope: { model: { id: null, display_name: "Fable" }, surface: null } }] };

test("Claude's usage gives its own windows and the week of each model it limits apart", () => {
  const windows = claudeWindows(USAGE);
  assert.deepEqual(windows.map(w => [w.label, w.windowDurationMins, w.bucket, w.scope ?? null, w.usedPercent]),
    [["Weekly", 10080, null, null, 70], ["Fable", 10080, "Fable", "model", 35]]);
  // Its rows stand in for the five hours and the week when the older fields are missing.
  assert.deepEqual(claudeWindows({ limits: [{ kind: "session", percent: 12, resets_at: RESET, scope: null }, { kind: "weekly_all", percent: 40, resets_at: RESET, scope: null }] })
    .map(w => [w.label, w.windowDurationMins, w.usedPercent]), [["5 hours", 300, 12], ["Weekly", 10080, 40]]);
  // The older per-model weeks, once each; an unusable name or share is left out, and at most four models.
  const many = claudeWindows({ seven_day: { utilization: 1 }, seven_day_sonnet: { utilization: 9, resets_at: RESET },
    limits: [...["Fable", "fable", "<b>", "Haiku", "Opus", "Mythos", "Extra"].map((name, index) => ({ kind: "weekly_scoped", percent: index, resets_at: RESET, scope: { model: { display_name: name } } })),
      { kind: "weekly_scoped", percent: "5", scope: { model: { display_name: "Text" } } }, { kind: "weekly_scoped", percent: 5, scope: { surface: { display_name: "Claude Code" } } }] });
  assert.deepEqual(many.filter(w => w.scope === "model").map(w => w.bucket), ["Fable", "Haiku", "Opus", "Mythos"]);
  assert.deepEqual(claudeWindows({ five_hour: { utilization: 3 }, seven_day: { utilization: 4 } }).map(w => w.usedPercent), [3, 4], "a reading without models is as before");
});

test("the desktop helper's quota carries Claude's models and plan, held to the IPC allowlist", async () => {
  const reader = createDesktopQuotaReader({ now: () => EPOCH, readToken: async () => "secret",
    fetchImpl: async url => Response.json(url.endsWith("profile")
      ? { account: { uuid: UUID, email: "private@example.test" }, organization: { organization_type: "claude_max", plan_display_name: "Ultra", rate_limit_tier: "default_claude_max_20x" } }
      : USAGE) });
  const reading = await reader.read();
  assert.equal(reading.status, "ready"); assert.equal(reading.plan, "Ultra");
  assert.deepEqual(reading.windows.map(w => [w.bucket, w.scope ?? null, w.usedPercent]), [[null, null, 70], ["Fable", "model", 35]]);
  assert.ok(!/private|secret|example|11111111|rate_limit/.test(JSON.stringify(reading)));
  // A helper from before sends two windows and no plan; that stays valid.
  const base = { quotaVersion: 1, status: "ready", sampledAt: EPOCH, accountKey: accountKey("claude", UUID), windows: claudeWindows({ five_hour: { utilization: 1 }, seven_day: { utilization: 2 } }) };
  assert.equal(sanitizeClaudeQuota(base, EPOCH).windows.length, 2); assert.equal(sanitizeClaudeQuota(base, EPOCH).plan, undefined);
  assert.equal(sanitizeClaudeQuota({ ...base, plan: "claude_max" }, EPOCH).plan, "claude_max");
  assert.equal(sanitizeClaudeQuota({ ...base, plan: null }, EPOCH).plan, undefined, "no plan is no plan, not a malformed reading");
  const model = { label: "Fable", windowDurationMins: 10080, bucket: "Fable", scope: "model", usedPercent: 35, resetsAt: null };
  assert.equal(sanitizeClaudeQuota({ ...base, windows: [...base.windows, model] }, EPOCH).windows[2].bucket, "Fable");
  for (const bad of [{ plan: "<script>" }, { plan: 7 }, { windows: [...base.windows, { ...model, windowDurationMins: 300 }] },
    { windows: [...base.windows, { ...model, bucket: "a\u0000b" }] }, { windows: [...base.windows, model, { ...model, bucket: "FABLE" }] },
    { windows: [...base.windows, ...["A", "B", "C", "D", "E"].map(bucket => ({ ...model, bucket }))] }]) {
    assert.equal(sanitizeClaudeQuota({ ...base, ...bad }, EPOCH), null, JSON.stringify(bad).slice(0, 80));
  }
});

test("plans are read from each vendor's own sign-in and named in words", async () => {
  assert.equal(claudePlan({ organization: { plan_display_name: "Ultra", organization_type: "claude_max" } }), "Ultra");
  assert.equal(claudePlan({ organization: { plan_display_name: "x".repeat(60), organization_type: "claude_pro" } }), "claude_pro");
  assert.equal(claudePlan({}), null);
  const read = createClaudeProfileReader({ fetchImpl: async () => ({ ok: true, json: async () => ({ account: { uuid: "a" }, organization: { plan_display_name: "Ultra" } }) }) });
  assert.equal((await read("token")).plan, "Ultra");
  assert.equal(chatgptPlan({ "https://api.openai.com/auth": { chatgpt_plan_type: "prolite" } }), "prolite");
  assert.equal(chatgptPlan({ "https://api.openai.com/auth": { chatgpt_plan_type: "unknown" } }), null);
  assert.equal(codexPlan({ rateLimits: { planType: "prolite" } }), "prolite");
  assert.equal(codexPlan({ rateLimitsByLimitId: { codex: { planType: "pro" } } }), "pro");
  assert.equal(codexPlan({ rateLimits: { planType: "unknown" } }), null);
  assert.deepEqual(["max", "prolite", "claude_max", "edu_plus", "Ultra", "Google AI Pro", "Pro Lite", "unknown", "", "<b>", null].map(planLabel),
    ["Max", "Pro Lite", "Max", "Edu Plus", "Ultra", "Google AI Pro", "Pro Lite", null, null, null, null]);
});

function claudeHome(t, { plan = "Ultra", fetchedAtMs = EPOCH - 60000, accountUuid = UUID } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "stepsemble-claude-local-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.writeFileSync(path.join(home, ".claude.json"), JSON.stringify({
    oauthAccount: { accountUuid: UUID, emailAddress: "private@example.test", planDisplayName: plan, organizationType: "claude_max" },
    cachedUsageUtilization: { fetchedAtMs, accountUuid, utilization: USAGE } }));
  return home;
}

test("Claude Code's own file names the plan of the account it is signed in to, and that account's models", async t => {
  const local = await claudeLocal(claudeHome(t));
  assert.equal(local.accountKey, accountKey("claude", UUID)); assert.equal(local.plan, "Ultra");
  assert.deepEqual(local.models.map(w => w.bucket), ["Fable"]);
  assert.equal((await claudeLocal(claudeHome(t, { plan: null }))).plan, "claude_max");
  assert.deepEqual((await claudeLocal(claudeHome(t, { accountUuid: "22222222-2222-4222-8222-222222222222" }))).models, [], "another account's usage is not this one's");
  assert.ok(!JSON.stringify(local).includes("example"));
});

test("a Claude reading without its models or plan takes them from the same account's other readings", async t => {
  const key = accountKey("claude", UUID), alias = accountKey("claude", "me@example.com", "email");
  const desktop = { quotaVersion: 1, status: "ready", sampledAt: EPOCH, accountKey: key, accountAliases: [alias],
    windows: claudeWindows({ five_hour: { utilization: 0 }, seven_day: { utilization: 70 } }) };
  const fable = { label: "7 days · Fable", windowDurationMins: 10080, bucket: "Fable", scope: "model", usedPercent: 35, resetsAt: null };
  const magpie = [{ service: "claude", kind: "subscription", label: "Claude", plan: "max", accountKey: alias, readAt: EPOCH, last: true,
    windows: [{ label: "5 hours", windowDurationMins: 300, usedPercent: 0, resetsAt: null }, { label: "7 days", windowDurationMins: 10080, usedPercent: 70, resetsAt: null }, fable] }];
  const make = options => createWorkspaceUsage({ now: () => EPOCH, codex: async () => ({}), readSignIn: async () => null,
    readProviderQuotas: async () => [], readOpenCodex: async () => [], readClaudeToken: async () => null,
    readDesktopClaudeQuota: async () => desktop, readMagpie: async () => magpie, ...options });
  // Claude Code's file names the plan (Ultra, not Magpie's "max"); Magpie's live reading gives Fable.
  let claude = (await make({ home: claudeHome(t) }).read()).providers.filter(p => p.service === "claude");
  assert.equal(claude.length, 1, "Magpie's reading of the same account is not a second card");
  assert.equal(claude[0].plan, "Ultra"); assert.equal(claude[0].source, "native");
  assert.deepEqual(claude[0].windows.map(w => [w.windowDurationMins, w.bucket ?? null, w.scope ?? null, w.usedPercent]), [[300, null, null, 0], [10080, null, null, 70], [10080, "Fable", "model", 35]]);
  // Without Magpie, the models' week comes from Claude Code's recent reading; a stale one is left out.
  claude = (await make({ home: claudeHome(t), readMagpie: async () => [] }).read()).providers.find(p => p.service === "claude");
  assert.deepEqual(claude.windows.filter(w => w.scope === "model").map(w => [w.bucket, w.usedPercent]), [["Fable", 35]]);
  claude = (await make({ home: claudeHome(t, { fetchedAtMs: EPOCH - 31 * 60000 }), readMagpie: async () => [] }).read()).providers.find(p => p.service === "claude");
  assert.deepEqual(claude.windows.filter(w => w.scope === "model"), []); assert.equal(claude.plan, "Ultra");
  // Magpie alone names the plan in words when nothing else does.
  claude = (await make({}).read()).providers.find(p => p.service === "claude");
  assert.equal(claude.plan, "Max");
  // A reading that has its own models keeps them.
  const own = { ...desktop, windows: [...desktop.windows, { label: "Fable", windowDurationMins: 10080, bucket: "Fable", scope: "model", usedPercent: 36, resetsAt: null }], plan: "Ultra" };
  claude = (await make({ readDesktopClaudeQuota: async () => own }).read()).providers.find(p => p.service === "claude");
  assert.deepEqual(claude.windows.filter(w => w.scope === "model").map(w => w.usedPercent), [36]); assert.equal(claude.plan, "Ultra");
});

test("Codex is named by the plan its app-server reports", async () => {
  const service = createWorkspaceUsage({ now: () => EPOCH, readClaudeToken: async () => null, readSignIn: async () => null, readCodexSignIn: async () => null,
    readProviderQuotas: async () => [], readOpenCodex: async () => [], readMagpie: async () => [],
    codex: async () => ({ rateLimits: { planType: "prolite", primary: { usedPercent: 61, windowDurationMins: 10080 } } }) });
  const codex = (await service.read()).providers.find(p => p.service === "codex");
  assert.equal(codex.plan, "Pro Lite"); assert.equal(codex.source, "native");
});

test("a key's plan read by Magpie on two computers is one account in All Hosts", () => {
  const cache = JSON.stringify({ "claude/me@example.com": { quota: { readAt: "2026-11-07T17:12:42.857086+08:00" } },
    "minimax/plan 90986bc45d18f16c": { at: "2026-11-07T17:24:33.524382+08:00", quota: { provider: "minimax", readAt: "2026-11-07T17:24:33.524379+08:00" } },
    "deepseek/balance 0123456789abcdef": { quota: { readAt: "2026-11-07T17:20:00+08:00" } }, "broken/plan NOT-HEX": {} });
  const fingerprints = keyFingerprints(cache);
  assert.deepEqual(fingerprints.map(row => [row.service, row.kind, row.id]), [["minimax", "plan", "90986bc45d18f16c"], ["deepseek", "balance", "0123456789abcdef"]]);
  const entries = quotaEntries([{ provider: "minimax", name: "MiniMax", kind: "plan", readAt: "2026-11-07T17:24:33.524379+08:00", windows: [{ name: "5 hours", used: 1, remaining: 99 }] },
    { provider: "deepseek", name: "DeepSeek", kind: "balance", balance: "$12.50", readAt: "2026-11-07T17:21:00+08:00", windows: [] }]);
  const [minimax, deepseek] = withKeyIdentities(entries, fingerprints);
  assert.equal(minimax.accountKey, accountKey("minimax", "plan 90986bc45d18f16c", "magpie-key"));
  assert.equal(deepseek.accountKey, accountKey("deepseek", "balance 0123456789abcdef", "magpie-key"), "the only key of its service, read since");
  assert.ok(!JSON.stringify([minimax, deepseek]).includes("90986bc45d18f16c"), "the fingerprint itself does not leave");
  // Two keys of one service, neither matched by its reading time, stay apart.
  const two = withKeyIdentities([{ ...minimax, accountKey: null, readAt: 1 }, { ...minimax, accountKey: null, readAt: 2 }],
    [...fingerprints, { service: "minimax", kind: "plan", id: "ffffffffffffffff", readAt: 3 }]);
  assert.deepEqual(two.map(row => row.accountKey), [null, null]);
  // The same key on two Hosts is one card; another key stays its own.
  const host = (id, provider) => ({ host: id, name: id, quota: { updatedAt: 1, providers: [{ service: "minimax", provider: "MiniMax", source: "magpie", kind: "plan", status: "ready", windows: [{ usedPercent: 1, windowDurationMins: 300 }], ...provider }] } });
  assert.equal(combineQuotas([host("mini", { accountKey: minimax.accountKey }), host("mbp", { accountKey: minimax.accountKey })]).length, 1);
  assert.equal(combineQuotas([host("mini", { accountKey: minimax.accountKey }), host("mbp", { accountKey: accountKey("minimax", "plan ffffffffffffffff", "magpie-key") })]).length, 2);
});
