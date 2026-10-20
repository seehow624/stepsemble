"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createMagpieGatewayService, accountReports, windowMinutes } = require("../server/magpie-gateway-service");
const { createOpenCodexGatewayService } = require("../server/opencodex-gateway-service");
const { createWorkspaceUsage } = require("../server/workspace-usage");
const { gatewayModelOptions } = require("../server/claude-code-structured-adapter");

const MODELS = [
  { id: "minimax/MiniMax-M3", display_name: "MiniMax-M3", magpie_label: "MiniMax-M3 · MiniMax", owned_by: "minimax", context_window: 1000000, reasoning_levels: ["low", "high", "ultra"] },
  { id: "claude/claude-opus-5-5", display_name: "Claude Opus 5.5", magpie_label: "Claude Opus 5.5 · Claude Code", owned_by: "claude", context_window: 1000000 },
  { id: "codex/gpt-6.1-sol", display_name: "GPT-6.1-Sol", magpie_label: "GPT-6.1-Sol · Codex", owned_by: "codex", context_window: 272000, reasoning_levels: ["low", "max"] },
];

function fixture(t, { online = true } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "stepsemble-magpie-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  for (const dir of [".codex", ".local/bin", ".pi/agent", ".config/stepsemble", ".opencodex"]) fs.mkdirSync(path.join(home, dir), { recursive: true });
  const binary = path.join(home, ".local/bin", process.platform === "win32" ? "magpie.exe" : "magpie");
  fs.writeFileSync(binary, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const runs = [];
  let up = online, fetches = 0, accounts = "[]";
  const service = createMagpieGatewayService({ home, env: { PATH: "" }, now: () => 1000,
    fetchImpl: async (url, options) => {
      fetches++;
      assert.equal(url, "http://127.0.0.1:3425/v1/models"); assert.equal(options.redirect, "error");
      if (!up) throw new Error("connection refused");
      return new Response(JSON.stringify({ object: "list", data: MODELS }), { status: 200 });
    },
    execFileImpl: (file, args, options, callback) => {
      assert.equal(file, binary); assert.equal(options.env.HOME, home);
      runs.push(args);
      callback(null, args[0] === "accounts" ? accounts : "", "");
    },
  });
  const write = (file, text) => fs.writeFileSync(path.join(home, file), text);
  const read = file => JSON.parse(fs.readFileSync(path.join(home, file), "utf8"));
  return { home, service, runs, write, read, fetches: () => fetches, online: value => { up = value; }, accounts: value => { accounts = value; } };
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

test("Claude routing needs Magpie answering, writes its model list without Claude's own models, and is taken back only from Magpie", async t => {
  const f = fixture(t, { online: false });
  await assert.rejects(f.service.setClaudeSessionRouting(true), { code: "magpie_offline" });
  assert.equal(fs.existsSync(path.join(f.home, ".config/stepsemble/claude-gateway.json")), false);
  f.online(true);
  const status = await f.service.setClaudeSessionRouting(true);
  assert.equal(status.claude.here, true);
  assert.deepEqual(f.read(".config/stepsemble/claude-gateway.json"), { version: 1, enabled: true, baseUrl: "http://127.0.0.1:3425" });
  const catalog = f.read(".config/stepsemble/claude-gateway-catalog.json");
  assert.equal(catalog.gateway, "magpie"); assert.equal(catalog.baseUrl, "http://127.0.0.1:3425");
  assert.deepEqual(catalog.models.map(row => row.id), ["minimax/MiniMax-M3", "codex/gpt-6.1-sol"]);
  assert.equal(catalog.models[0].description, "Magpie gateway · MiniMax");
  assert.deepEqual(catalog.models[0].supportedEffortLevels, ["low", "high"]);
  assert.deepEqual(f.read(".claude/cache/gateway-models.json").models.map(row => row.id), ["minimax/MiniMax-M3", "codex/gpt-6.1-sol"]);
  const picker = f.read(".config/stepsemble/claude-gateway-settings.json").modelPicker.options;
  assert.deepEqual(picker.map(row => row.behavesAs), ["claude-sonnet-5[1m]", "claude-sonnet-5"]);
  // The conversation's model sheet reads the same list.
  const options = gatewayModelOptions({ HOME: f.home, ANTHROPIC_BASE_URL: "http://127.0.0.1:3425" });
  assert.deepEqual(options.map(row => [row.id, row.gateway]), [["minimax/MiniMax-M3", "magpie"], ["codex/gpt-6.1-sol", "magpie"]]);
  assert.equal(options[0].contextWindow, 1000000);
  await f.service.setClaudeSessionRouting(false);
  assert.deepEqual(f.read(".config/stepsemble/claude-gateway.json"), { version: 1, enabled: false, baseUrl: null });
  f.write(".config/stepsemble/claude-gateway.json", JSON.stringify({ version: 1, enabled: true, baseUrl: "http://127.0.0.1:10100" }));
  await f.service.setClaudeSessionRouting(false);
  assert.equal(f.read(".config/stepsemble/claude-gateway.json").baseUrl, "http://127.0.0.1:10100");
  assert.equal(await f.service.refreshClaudeGatewayCache(), null, "another gateway's route keeps its own list");
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

test("Magpie's account windows become allowances; a window for one model is left out", () => {
  assert.equal(windowMinutes("5 hours"), 300); assert.equal(windowMinutes("7 days"), 10080); assert.equal(windowMinutes("7 days · Fable"), null);
  const reports = accountReports([
    { agent: "claude", user: "Person@Example.com", active: false, on: true, windows: [{ name: "5 hours", used: 90 }] },
    { agent: "claude", user: "person@example.com", active: true, on: true, readAt: "2026-10-20T13:50:58+08:00",
      windows: [{ name: "5 hours", used: 15, resetsAt: "2026-10-20T15:29:00+08:00" }, { name: "7 days", used: 23 }, { name: "7 days · Fable", used: 0 }] },
    { agent: "codex", on: false, windows: [{ name: "7 days", used: 33 }] },
    { agent: "copilot", windows: [{ name: "1 month", used: 101 }, { name: "1 month", used: 40 }] },
    { agent: "../bad", windows: [{ name: "5 hours", used: 1 }] },
  ]);
  assert.deepEqual(reports.map(row => [row.service, row.label, row.windows.map(w => [w.windowDurationMins, w.usedPercent])]),
    [["claude", "Claude", [[300, 15], [10080, 23]]], ["copilot", "GitHub Copilot", [[43200, 40]]]]);
  assert.equal(reports[0].windows[0].resetsAt, Date.parse("2026-10-20T15:29:00+08:00"));
  assert.equal(reports[0].readAt, Date.parse("2026-10-20T13:50:58+08:00"));
  assert.match(reports[0].accountKey, /^v1:/); assert.ok(!JSON.stringify(reports).includes("example.com"));
});

test("allowances are read with Magpie's CLI once per couple of minutes", async t => {
  const f = fixture(t);
  f.accounts(JSON.stringify([{ agent: "codex", user: "a@b.c", active: true, windows: [{ name: "7 days", used: 33 }] }]));
  const [a, b] = await Promise.all([f.service.quotaReports(), f.service.quotaReports()]);
  assert.deepEqual(a, b); assert.equal(a[0].service, "codex");
  await f.service.quotaReports();
  assert.deepEqual(f.runs, [["accounts", "--json"]]);
  assert.deepEqual(await f.service.quotaSource({ probe: false }).then(row => [row.installed, row.reason]), [true, "off"]);
  assert.equal((await f.service.quotaSource()).running, true);
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
