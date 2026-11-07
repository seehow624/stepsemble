"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createMagpieGatewayService, quotaEntries, quotaWindow, windowMinutes } = require("../server/magpie-gateway-service");
const { accountKey } = require("../server/quota-identity");
const { createOpenCodexGatewayService } = require("../server/opencodex-gateway-service");
const { createWorkspaceUsage } = require("../server/workspace-usage");
const { gatewayModelOptions } = require("../server/claude-code-structured-adapter");

const MODELS = [
  { id: "minimax/MiniMax-M3", display_name: "MiniMax-M3", magpie_label: "MiniMax-M3 · MiniMax", owned_by: "minimax", context_window: 1000000, reasoning_levels: ["low", "high", "ultra"] },
  { id: "claude/claude-haiku-5-5", display_name: "Claude Haiku 5.5", magpie_label: "Claude Haiku 5.5 · Claude Code", owned_by: "claude", context_window: 1000000, reasoning_levels: ["low", "max"] },
  { id: "claude/claude-opus-5-5", display_name: "Claude Opus 5.5", magpie_label: "Claude Opus 5.5 · Claude Code", owned_by: "claude", context_window: 1000000, reasoning_levels: ["low", "medium", "high", "xhigh", "max"] },
  { id: "claude/claude-opus-4-5", display_name: "Claude Opus 4.5", magpie_label: "Claude Opus 4.5 · Claude Code", owned_by: "claude", context_window: 200000 },
  { id: "codex/gpt-6.1-sol", display_name: "GPT-6.1-Sol", magpie_label: "GPT-6.1-Sol · Codex", owned_by: "codex", context_window: 272000, reasoning_levels: ["low", "max"] },
];

function fixture(t, { online = true } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "stepsemble-magpie-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  for (const dir of [".codex", ".local/bin", ".pi/agent", ".config/stepsemble", ".opencodex"]) fs.mkdirSync(path.join(home, dir), { recursive: true });
  const binary = path.join(home, ".local/bin", process.platform === "win32" ? "magpie.exe" : "magpie");
  fs.writeFileSync(binary, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const runs = [];
  // The gateway's quotas (null: an older gateway without them), `magpie quota
  // --json` (null: an older command that does not know it) and `magpie accounts --json`.
  let up = online, fetches = 0, quotas = null, quotaJson = null, accounts = "[]";
  const service = createMagpieGatewayService({ home, env: { PATH: "" }, now: () => 1000,
    fetchImpl: async (url, options) => {
      fetches++;
      assert.equal(options.redirect, "error");
      if (!up) throw new Error("connection refused");
      if (url === "http://127.0.0.1:3425/v1/magpie/quotas") return quotas === null ? new Response("not found", { status: 404 }) : new Response(JSON.stringify({ object: "list", data: quotas }), { status: 200 });
      assert.equal(url, "http://127.0.0.1:3425/v1/models");
      return new Response(JSON.stringify({ object: "list", data: MODELS }), { status: 200 });
    },
    execFileImpl: (file, args, options, callback) => {
      assert.equal(file, binary); assert.equal(options.env.HOME, home);
      runs.push(args);
      if (args[0] === "quota") return quotaJson === null ? callback(Object.assign(new Error("exit 1"), { code: 1 }), "", "unknown command") : callback(null, quotaJson, "");
      callback(null, args[0] === "accounts" ? accounts : "", "");
    },
  });
  const write = (file, text) => fs.writeFileSync(path.join(home, file), text);
  const read = file => JSON.parse(fs.readFileSync(path.join(home, file), "utf8"));
  return { home, service, runs, write, read, fetches: () => fetches, online: value => { up = value; }, accounts: value => { accounts = value; },
    quotas: value => { quotas = value; }, quotaJson: value => { quotaJson = value; } };
}

test("status tells which agents go through Magpie and which go elsewhere", async t => {
  const f = fixture(t);
  f.write(".codex/config.toml", 'model = "gpt-6.1-sol"\nopenai_base_url = "http://127.0.0.1:3425/backend-api/codex"\n[agents]\nopenai_base_url = "http://elsewhere"\n');
  f.write(".config/stepsemble/claude-gateway.json", JSON.stringify({ version: 1, enabled: true, baseUrl: "http://127.0.0.1:10100" }));
  f.write(".pi/agent/settings.json", JSON.stringify({ defaultProvider: "magpie", defaultModel: "claude/claude-opus-5-5" }));
  const status = await f.service.status();
  assert.equal(status.installed, true); assert.equal(status.reachable, true); assert.equal(status.origin, "http://127.0.0.1:3425");
  assert.deepEqual(status.providerIds, ["minimax", "claude", "codex"]);
  assert.deepEqual(status.codex, { mode: "magpie", currentModel: "gpt-6.1-sol", baseUrl: "http://127.0.0.1:3425/backend-api/codex" });
  assert.equal(status.claude.here, false, "a route to OpenCodex is not Magpie's");
  assert.deepEqual(status.pi, { here: true, model: "claude/claude-opus-5-5" });
  f.write(".codex/config.toml", 'model = "gpt-6.1-sol"\nopenai_base_url = "http://127.0.0.1:10100/v1"\n');
  assert.equal((await f.service.status()).codex.mode, "other");
  f.write(".codex/config.toml", 'model = "gpt-6.1-sol"\n');
  assert.equal((await f.service.status()).codex.mode, "direct");
});

test("Claude routing needs Magpie answering, writes its model list with Claude's own models first, and is taken back only from Magpie", async t => {
  const f = fixture(t, { online: false });
  await assert.rejects(f.service.setClaudeSessionRouting(true), { code: "magpie_offline" });
  assert.equal(fs.existsSync(path.join(f.home, ".config/stepsemble/claude-gateway.json")), false);
  f.online(true);
  const status = await f.service.setClaudeSessionRouting(true);
  assert.equal(status.claude.here, true);
  assert.deepEqual(f.read(".config/stepsemble/claude-gateway.json"), { version: 1, enabled: true, baseUrl: "http://127.0.0.1:3425" });
  const catalog = f.read(".config/stepsemble/claude-gateway-catalog.json");
  assert.equal(catalog.gateway, "magpie"); assert.equal(catalog.baseUrl, "http://127.0.0.1:3425");
  // Claude's own models come first in Claude Code's order, named as Claude
  // Code's own settings name them: "[1m]" for the 1M context, no level.
  const ids = ["claude/claude-opus-5-5[1m]", "claude/claude-opus-4-5", "claude/claude-haiku-5-5[1m]", "minimax/MiniMax-M3", "codex/gpt-6.1-sol"];
  assert.deepEqual(catalog.models.map(row => row.id), ids);
  assert.equal(catalog.models[3].description, "Magpie gateway · MiniMax");
  assert.deepEqual(catalog.models[3].supportedEffortLevels, ["low", "high"]);
  assert.deepEqual(catalog.models[0].supportedEffortLevels, ["low", "medium", "high", "xhigh", "max"]);
  // Claude Code's own cache keeps Magpie's ids as its discovery writes them.
  assert.deepEqual(f.read(".claude/cache/gateway-models.json").models.map(row => row.id),
    ["claude/claude-opus-5-5", "claude/claude-opus-4-5", "claude/claude-haiku-5-5", "minimax/MiniMax-M3", "codex/gpt-6.1-sol"]);
  const picker = f.read(".config/stepsemble/claude-gateway-settings.json").modelPicker.options;
  assert.deepEqual(picker.map(row => row.model), ids);
  // Claude's own models behave as themselves; others as a Claude model of their context.
  assert.deepEqual(picker.map(row => row.behavesAs), ["claude-opus-5-5", "claude-opus-4-5", "claude-haiku-5-5", "claude-sonnet-5[1m]", "claude-sonnet-5"]);
  // The conversation's model sheet reads the same list.
  const options = gatewayModelOptions({ HOME: f.home, ANTHROPIC_BASE_URL: "http://127.0.0.1:3425" });
  assert.deepEqual(options.map(row => [row.id, row.gateway]), ids.map(id => [id, "magpie"]));
  assert.equal(options[0].contextWindow, 1000000);
  await f.service.setClaudeSessionRouting(false);
  assert.deepEqual(f.read(".config/stepsemble/claude-gateway.json"), { version: 1, enabled: false, baseUrl: null });
  f.write(".config/stepsemble/claude-gateway.json", JSON.stringify({ version: 1, enabled: true, baseUrl: "http://127.0.0.1:10100" }));
  await f.service.setClaudeSessionRouting(false);
  assert.equal(f.read(".config/stepsemble/claude-gateway.json").baseUrl, "http://127.0.0.1:10100");
  assert.equal(await f.service.refreshClaudeGatewayCache(), null, "another gateway's route keeps its own list");
});

test("Claude's model list follows the models picked for Claude Code in Magpie", async t => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.home, ".config/magpie"), { recursive: true });
  f.write(".config/magpie/settings.json", JSON.stringify({ hiddenModels: { claude: ["codex/gpt-6.1-sol", "claude/claude-opus-4-5", "claude/claude-haiku-5-5"], codex: ["minimax/MiniMax-M3"] } }));
  await f.service.setClaudeSessionRouting(true);
  assert.deepEqual(f.read(".config/stepsemble/claude-gateway-catalog.json").models.map(row => row.id), ["claude/claude-opus-5-5[1m]", "minimax/MiniMax-M3"]);
  assert.deepEqual(f.read(".config/stepsemble/claude-gateway-settings.json").modelPicker.options.map(row => row.model), ["claude/claude-opus-5-5[1m]", "minimax/MiniMax-M3"]);
  // A change on the Agents page is taken up at the next launch, with the same catalog.
  f.write(".config/magpie/settings.json", JSON.stringify({ hiddenModels: { claude: [] }, pickedModels: { claude: ["codex/gpt-6.1-sol"] } }));
  await f.service.refreshClaudeGatewayCache();
  assert.deepEqual(f.read(".config/stepsemble/claude-gateway-catalog.json").models.map(row => row.id), ["codex/gpt-6.1-sol"]);
  assert.equal(f.fetches(), 1, "the catalog itself is not fetched again");
});

test("Codex routing goes through Magpie's own command and keeps Codex's model", async t => {
  const f = fixture(t);
  f.write(".codex/config.toml", 'model = "gpt-6.1-sol"\n');
  await f.service.setCodexRouting(false);
  assert.deepEqual(f.runs, [], "Codex not on Magpie is left alone");
  await f.service.setCodexRouting(true);
  assert.deepEqual(f.runs, [["codex", "codex/gpt-6.1-sol"]]);
  f.write(".codex/config.toml", 'model = "minimax/MiniMax-M3"\nopenai_base_url = "http://127.0.0.1:3425/backend-api/codex"\n');
  await f.service.setCodexRouting(true);
  await f.service.setCodexRouting(false);
  assert.deepEqual(f.runs.slice(1), [["codex", "minimax/MiniMax-M3"], ["codex", "default"]]);
  f.online(false);
  await assert.rejects(f.service.setCodexRouting(true), { code: "magpie_offline" });
});

test("Magpie's quota entries become allowances: every account, plan and balance, a window for one model kept under it", () => {
  assert.equal(windowMinutes("5 hours"), 300); assert.equal(windowMinutes("7 days"), 10080); assert.equal(windowMinutes("7 days · Fable"), null);
  assert.deepEqual(quotaWindow({ name: "7 days · Fable", used: 32, remaining: 68, resetsAt: "2026-11-09T10:00:00+08:00" }),
    { label: "7 days · Fable", windowDurationMins: 10080, bucket: "Fable", scope: "model", usedPercent: 32, resetsAt: Date.parse("2026-11-09T10:00:00+08:00") });
  assert.deepEqual(quotaWindow({ name: "Claude Opus 5.5 (High)", used: 100, remaining: 0 }), { label: "Claude Opus 5.5 (High)", windowDurationMins: null, bucket: null, scope: "model", usedPercent: 100, resetsAt: null });
  // The account's own window, and a pool several models draw on, are not one model's.
  assert.deepEqual(quotaWindow({ name: "7 days", used: 59 }), { label: "7 days", windowDurationMins: 10080, bucket: null, usedPercent: 59, resetsAt: null });
  assert.deepEqual(quotaWindow({ name: "5 hours", pool: "Gemini", used: 10 }), { label: "5 hours", windowDurationMins: 300, bucket: "Gemini", usedPercent: 10, resetsAt: null });
  assert.deepEqual(quotaWindow({ name: "Gemini", pool: "Gemini", used: 20 }), { label: "Gemini", windowDurationMins: null, bucket: null, usedPercent: 20, resetsAt: null });
  // Antigravity as Magpie 0.1.1672 reads it: a pool's own window is named after the pool; a model's
  // window drawing on a pool is still that model's.
  assert.deepEqual(quotaWindow({ name: "Gemini · 7 days", pool: "Gemini", used: 1.24, remaining: 98.76, resetsAt: "2026-11-13T23:55:55Z" }),
    { label: "Gemini · 7 days", windowDurationMins: 10080, bucket: "Gemini", usedPercent: 1.24, resetsAt: Date.parse("2026-11-13T23:55:55Z") });
  assert.deepEqual(quotaWindow({ name: "Claude & GPT · 7 days", pool: "Claude & GPT", used: 100 }), { label: "Claude & GPT · 7 days", windowDurationMins: 10080, bucket: "Claude & GPT", usedPercent: 100, resetsAt: null });
  assert.deepEqual(quotaWindow({ name: "Gemini 4 Argon (High)", pool: "Gemini 4 Argon", used: 0 }), { label: "Gemini 4 Argon (High)", windowDurationMins: null, bucket: null, scope: "model", usedPercent: 0, resetsAt: null });
  for (const window of [{ name: "5 hours", used: 101 }, { name: "5 hours", used: "x" }, { name: "credits", display: "1.2k / 3k", text: true, used: 0 },
    { name: "5 hours", unlimited: true, used: 0 }, { name: "wallet", balance: 12.5, unit: "USD", used: 0 }, null]) assert.equal(quotaWindow(window), null, JSON.stringify(window));
  const reports = quotaEntries({ object: "list", data: [
    { provider: "claude", name: "Claude Code", kind: "subscription", plan: "max", user: "Person@Example.com", readAt: "2026-10-20T13:50:58+08:00", last: true,
      windows: [{ name: "5 hours", used: 15, resetsAt: "2026-10-20T15:29:00+08:00" }, { name: "7 days", used: 23 }, { name: "7 days · Fable", used: 2 }] },
    { provider: "claude", name: "Claude Code", kind: "subscription", plan: "pro", user: "second@example.com", alias: "Work", windows: [{ name: "5 hours", used: 90 }] },
    { provider: "claude", name: "Claude Code", kind: "subscription", user: "third@example.com", windows: [], error: "Claude Code's /usage told no allowance" },
    { provider: "antigravity", name: "Antigravity", kind: "subscription", plan: "Antigravity Starter Quota", user: "person@example.com",
      windows: [{ name: "Claude Opus 5.5 (High)", used: 100 }, { name: "Gemini 3.8 Pro", used: 40, resetsAt: "2026-11-11T20:19:42Z" }] },
    { provider: "minimax", name: "MiniMax", kind: "plan", windows: [{ name: "5 hours", used: 0, resetsAt: "2026-11-07T13:00:00+08:00" }], lastServedAt: "2026-11-04T08:53:57Z" },
    { provider: "deepseek", name: "DeepSeek", kind: "balance", balance: "$12.50", windows: [] },
    { provider: "workbuddy", name: "WorkBuddy", kind: "subscription", user: "wb@example.com", windows: [{ name: "credits", balance: 6291, unit: "points", used: 0, remaining: 0 }] },
    { provider: "factory", name: "Factory", kind: "subscription", user: "f@example.com", windows: [{ name: "extra usage", display: "$3.20", text: true, used: 0 }] },
    { provider: "codex", name: "Codex", kind: "subscription", user: "far@example.com", from: "studio", windows: [{ name: "7 days", used: 33 }] },
    { provider: "../bad", windows: [{ name: "5 hours", used: 1 }] },
  ] });
  assert.deepEqual(reports.map(row => [row.service, row.kind, row.label, row.plan, row.alias, row.balance, row.windows.map(w => [w.windowDurationMins, w.bucket, w.usedPercent])]), [
    ["claude", "subscription", "Claude", "max", null, null, [[300, null, 15], [10080, null, 23], [10080, "Fable", 2]]],
    ["claude", "subscription", "Claude", "pro", "Work", null, [[300, null, 90]]],
    ["antigravity", "subscription", "Antigravity", "Antigravity Starter Quota", null, null, [[null, null, 100], [null, null, 40]]],
    ["minimax", "plan", "MiniMax", null, null, null, [[300, null, 0]]],
    ["deepseek", "balance", "DeepSeek", null, null, "$12.50", []],
    ["workbuddy", "subscription", "WorkBuddy", null, null, "6,291 points", []],
  ], "an account without a reading (an error, a text alone), a remote Magpie's account and a bad id are left out; a wallet is a balance");
  assert.equal(reports[0].windows[0].resetsAt, Date.parse("2026-10-20T15:29:00+08:00"));
  assert.equal(reports[0].readAt, Date.parse("2026-10-20T13:50:58+08:00")); assert.equal(reports[0].last, true); assert.equal(reports[1].last, false);
  assert.equal(reports[2].windows[0].label, "Claude Opus 5.5 (High)"); assert.equal(reports[2].windows[1].resetsAt, Date.parse("2026-11-11T20:19:42Z"));
  assert.equal(reports[3].lastServedAt, Date.parse("2026-11-04T08:53:57Z")); assert.equal(reports[3].accountKey, null); assert.equal(reports[4].accountKey, null);
  assert.equal(reports[0].accountKey, accountKey("claude", "person@example.com", "email"), "the same person, case apart");
  assert.notEqual(reports[0].accountKey, reports[1].accountKey); assert.notEqual(reports[0].accountKey, reports[2].accountKey, "an identity is the service's own");
  assert.ok(!JSON.stringify(reports).includes("example.com"));
  // The older accounts list names the service by agent, and the agent's own account as active.
  const legacy = quotaEntries([{ agent: "codex", user: "a@b.c", active: true, on: true, windows: [{ name: "7 days", used: 33 }] },
    { agent: "codex", user: "d@e.f", on: false, windows: [{ name: "7 days", used: 1 }] }, { agent: "copilot", windows: [{ name: "1 month", used: 101 }, { name: "1 month", used: 40 }] }]);
  assert.deepEqual(legacy.map(row => [row.service, row.label, row.kind, row.last, row.windows.map(w => [w.windowDurationMins, w.usedPercent])]),
    [["codex", "Codex", "subscription", true, [[10080, 33]]], ["copilot", "GitHub Copilot", "subscription", false, [[43200, 40]]]]);
});

test("allowances come from the gateway, else from Magpie's command, once per couple of minutes", async t => {
  const f = fixture(t);
  f.quotas([{ provider: "codex", kind: "subscription", user: "a@b.c", windows: [{ name: "7 days", used: 33 }] }]);
  const [a, b] = await Promise.all([f.service.quotaReports(), f.service.quotaReports()]);
  assert.deepEqual(a, b); assert.equal(a[0].service, "codex");
  await f.service.quotaReports();
  assert.deepEqual(f.runs, [], "the gateway answered; the command is not run");
  assert.deepEqual(await f.service.quotaSource({ probe: false }).then(row => [row.installed, row.reason]), [true, "off"]);
  assert.equal((await f.service.quotaSource()).running, true);
  // Without the gateway, `magpie quota --json`; an older Magpie that does not know it still answers `accounts`.
  const g = fixture(t); g.online(false);
  g.quotaJson(JSON.stringify([{ provider: "minimax", kind: "plan", windows: [{ name: "5 hours", used: 5 }] }]));
  assert.deepEqual((await g.service.quotaReports()).map(row => [row.service, row.kind]), [["minimax", "plan"]]);
  assert.deepEqual(g.runs, [["quota", "--json"]]);
  const h = fixture(t); h.online(false);
  h.accounts(JSON.stringify([{ agent: "codex", user: "a@b.c", active: true, windows: [{ name: "7 days", used: 33 }] }]));
  assert.deepEqual((await h.service.quotaReports()).map(row => [row.service, row.last]), [["codex", true]]);
  assert.deepEqual(h.runs, [["quota", "--json"], ["accounts", "--json"]]);
  // An older gateway without quotas, and a command that answers nothing: no allowance, not an error.
  const i = fixture(t);
  assert.deepEqual(await i.service.quotaReports(), []); assert.deepEqual(i.runs, [["quota", "--json"], ["accounts", "--json"]]);
});

test("Magpie is one more quota source, after the agents' own sign-ins", async () => {
  const service = createWorkspaceUsage({ home: "/synthetic", now: () => 1000,
    codex: async () => { throw new Error("no app-server"); }, readClaudeToken: async () => null, readCodexSignIn: async () => null,
    readProviderQuotas: async () => [], readOpenCodex: async () => [],
    readMagpie: async () => [
      { service: "claude", label: "Claude", windows: [{ windowDurationMins: 300, usedPercent: 15, resetsAt: null }], readAt: 1000, accountKey: "v1:x" },
      { service: "copilot", label: "GitHub Copilot", windows: [{ windowDurationMins: 43200, usedPercent: 40, resetsAt: null }], readAt: null },
    ] });
  const result = await service.read({ full: true });
  const claude = result.providers.find(row => row.service === "claude");
  assert.equal(claude.sourceId, "magpie"); assert.equal(claude.source, "magpie"); assert.equal(claude.windows[0].remainingPercent, 85);
  assert.equal(result.providers.find(row => row.service === "copilot").provider, "GitHub Copilot");
  assert.deepEqual(result.sources.magpie.services.map(row => row.service), ["claude", "copilot"]);
  const off = createWorkspaceUsage({ home: "/synthetic", readConfig: async () => ({ sources: { magpie: false } }),
    codex: async () => { throw new Error("none"); }, readClaudeToken: async () => null, readCodexSignIn: async () => null,
    readProviderQuotas: async () => [], readOpenCodex: async () => [], readMagpie: async () => { throw new Error("must not run"); } });
  assert.equal((await off.read()).sources.magpie.enabled, false);
});

test("every Magpie account shows: all of a service's when Magpie is its source, else those provably not the account already shown", async () => {
  const jwt = claims => `header.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.signature`;
  const token = jwt({ exp: 4102444800, "https://api.openai.com/auth": { chatgpt_account_id: "acct-native" }, "https://api.openai.com/profile": { email: "Me@Example.com" } });
  const mine = accountKey("codex", "me@example.com", "email"), other = accountKey("codex", "other@example.com", "email");
  const magpie = [
    { service: "codex", kind: "subscription", label: "Codex", plan: "pro", windows: [{ windowDurationMins: 10080, usedPercent: 46, resetsAt: null }], readAt: 1000, accountKey: mine, last: true },
    { service: "codex", kind: "subscription", label: "Codex", plan: "plus", alias: "Spare", windows: [{ windowDurationMins: 10080, usedPercent: 80, resetsAt: null }], readAt: 1000, accountKey: other },
    { service: "antigravity", kind: "subscription", label: "Antigravity", plan: "Antigravity Starter Quota", windows: [{ label: "Claude Opus 5.5 (High)", windowDurationMins: null, bucket: null, scope: "model", usedPercent: 100, resetsAt: null }], readAt: 1000, accountKey: "v1:" + "a".repeat(64) },
    { service: "minimax", kind: "plan", label: "MiniMax", windows: [{ label: "5 hours", windowDurationMins: 300, bucket: null, usedPercent: 0, resetsAt: null }], readAt: null, accountKey: null },
    { service: "deepseek", kind: "balance", label: "DeepSeek", windows: [], balance: "$12.50", readAt: null, accountKey: null },
  ];
  const make = (options = {}) => createWorkspaceUsage({ home: "/synthetic", now: () => 1000,
    codex: async () => { throw new Error("no app-server"); }, readClaudeToken: async () => null,
    readCodexSignIn: async () => ({ type: "oauth", secret: token, accountId: "acct-native", expiresAt: null }),
    fetchImpl: async () => ({ ok: true, json: async () => ({ rate_limit: { primary_window: { used_percent: 12, limit_window_seconds: 604800 } } }) }),
    readProviderQuotas: async () => [], readOpenCodex: async () => [], readMagpie: async () => magpie, ...options });
  const result = await make().read({ full: true });
  const codex = result.providers.filter(row => row.service === "codex");
  assert.deepEqual(codex.map(row => [row.sourceId, row.plan ?? null, row.alias ?? null, row.windows[0].usedPercent]), [["agents", null, null, 12], ["magpie", "plus", "Spare", 80]],
    "the account Codex itself is signed in to is read once, through that sign-in; Magpie's other account follows");
  assert.deepEqual(codex[0].accountAliases, [mine]);
  assert.deepEqual(result.providers.filter(row => !["codex", "claude"].includes(row.service)).map(row => [row.service, row.sourceId, row.status, row.kind, row.balance ?? null, row.windows.map(w => w.windowDurationMins ?? w.label)]),
    [["antigravity", "magpie", "ready", "subscription", null, ["Claude Opus 5.5 (High)"]], ["minimax", "magpie", "ready", "plan", null, [300]], ["deepseek", "magpie", "ready", "balance", "$12.50", []]]);
  assert.deepEqual(result.providers.find(row => row.service === "antigravity").windows.map(w => [w.label, w.scope]), [["Claude Opus 5.5 (High)", "model"]], "a window for one model stays marked so");
  // Settings tells which readings Limits shows: Magpie's reading of the account Codex is signed in to is not.
  assert.deepEqual(result.sources.magpie.services.map(row => [row.service, row.plan ?? row.kind, row.inUse]),
    [["codex", "pro", false], ["codex", "plus", true], ["antigravity", "Antigravity Starter Quota", true], ["minimax", "plan", true], ["deepseek", "balance", true]]);
  assert.deepEqual(result.sources.agents.services.map(row => [row.service, row.inUse]), [["codex", true]]);
  assert.ok(!JSON.stringify(result).includes("example.com"));
  // Preferred for the service, Magpie shows every account of it, the one it served last first.
  const preferred = await make({ readConfig: async () => ({ prefer: { codex: "magpie" } }) }).read({ full: true });
  assert.deepEqual(preferred.providers.filter(row => row.service === "codex").map(row => [row.sourceId, row.plan]), [["magpie", "pro"], ["magpie", "plus"]]);
  // A sign-in whose account cannot be told never shows a Magpie account twice: neither an
  // anonymous one, nor one with its own account id but no email to compare with Magpie's.
  const anonymous = await make({ readCodexSignIn: async () => ({ type: "oauth", secret: jwt({ exp: 4102444800 }), accountId: null, expiresAt: null }) }).read({ full: true });
  assert.deepEqual(anonymous.providers.filter(row => row.service === "codex").map(row => row.sourceId), ["agents"]);
  const unaliased = await make({ readCodexSignIn: async () => ({ type: "oauth", secret: jwt({ exp: 4102444800 }), accountId: "acct-native", expiresAt: null }) }).read({ full: true });
  const unaliasedCodex = unaliased.providers.filter(row => row.service === "codex");
  assert.deepEqual(unaliasedCodex.map(row => row.sourceId), ["agents"]); assert.match(unaliasedCodex[0].accountKey, /^v1:/); assert.equal(unaliasedCodex[0].accountAliases, undefined);
  assert.deepEqual(unaliased.sources.magpie.services.filter(row => row.service === "codex").map(row => row.inUse), [false, false]);
  // Magpie off: its accounts, plans and balances are gone, the sign-in stays.
  const off = await make({ readConfig: async () => ({ sources: { magpie: false } }) }).read({ full: true });
  assert.deepEqual(off.providers.map(row => row.service), ["codex", "claude"]);
});

test("OpenCodex no longer claims Codex or Claude routes that go to Magpie", async t => {
  const f = fixture(t);
  f.write(".opencodex/config.json", JSON.stringify({ port: 10100, claudeCode: { enabled: true } }));
  f.write(".codex/config.toml", 'model = "gpt-6.1-sol"\nopenai_base_url = "http://127.0.0.1:3425/backend-api/codex"\n');
  f.write(".config/stepsemble/claude-gateway.json", JSON.stringify({ version: 1, enabled: true, baseUrl: "http://127.0.0.1:3425" }));
  let fetched = 0;
  const opencodex = createOpenCodexGatewayService({ home: f.home, env: { PATH: "" }, fetchImpl: async () => { fetched++; throw new Error("down"); } });
  const status = await opencodex.status();
  assert.equal(status.codex.mode, "gateway-other");
  assert.equal(status.claude.sessionRouting.enabled, true); assert.equal(status.claude.sessionRouting.here, false);
  const before = fetched;
  assert.equal(await opencodex.refreshClaudeGatewayCache(), null); assert.equal(fetched, before, "OpenCodex does not write over Magpie's list");
  await opencodex.setClaudeSessionRouting(false);
  assert.equal(f.read(".config/stepsemble/claude-gateway.json").baseUrl, "http://127.0.0.1:3425");
  f.write(".codex/config.toml", 'openai_base_url = "http://127.0.0.1:10100/v1"\n');
  assert.equal((await opencodex.status()).codex.mode, "gateway");
});
