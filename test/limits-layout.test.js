"use strict";

// Limits lists every window as one aligned row, groups an account's shared
// pools with the models that draw on them, and treats Magpie's readings of
// its own cadence as current; Refresh asks Magpie to read again.
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { quotaLayout } = require("../public/modules/usage-data");
const { createMagpieGatewayService } = require("../server/magpie-gateway-service");
const { createWorkspaceUsage } = require("../server/workspace-usage");

const pool = (name, minutes, used) => ({ label: name + " · " + minutes, bucket: name, windowDurationMins: minutes, scope: "pool", usedPercent: used, remainingPercent: 100 - used, resetsAt: null });
const model = (label, used, extra = {}) => ({ label, bucket: null, windowDurationMins: null, scope: "model", usedPercent: used, remainingPercent: 100 - used, resetsAt: null, ...extra });
const shape = layout => ({ own: layout.own.map(w => w.windowDurationMins), models: layout.models.map(m => m.name),
  pools: layout.pools.map(p => [p.name, p.windows.map(w => w.windowDurationMins), p.models, p.apart.map(a => a.name)]) });

test("Antigravity's windows group by pool, its models named beside the pool they draw on", () => {
  // As Magpie reads a Google AI Pro account: three pools and nine model windows.
  const windows = [
    ...["High", "Low", "Medium"].flatMap(level => [model(`Claude Opus 5.5 (${level})`, 100), model(`Claude Sonnet 5.5 (${level})`, 100)]),
    ...["High", "Low", "Medium"].map(level => model(`Gemini 4 Argon (${level})`, 0, { pool: "Gemini 4 Argon" })),
    pool("Gemini", 10080, 4.54), pool("Gemini", 300, 1.74), pool("Claude & GPT", 10080, 100), pool("Gemini 4 Argon", 10080, 0),
  ];
  assert.deepEqual(shape(quotaLayout(windows)), { own: [], models: [], pools: [
    ["Gemini", [300, 10080], [], []],
    ["Claude & GPT", [10080], ["Opus 5.5", "Sonnet 5.5"], []],
    ["Gemini 4 Argon", [10080], [], []],
  ] }, "the shortest window first in each pool; a model named like its pool is the pool");
  // A model that reads apart from its pool keeps its own row there; variants that differ stay apart.
  const apart = quotaLayout([pool("Gemini", 10080, 10), model("Gemini 3.8 Flash (High)", 100), model("Gemini 3.8 Flash (Low)", 10),
    model("GPT-OSS 120B (Medium)", 40), pool("Claude & GPT", 10080, 40), model("Mythos 1", 0)]);
  assert.deepEqual(shape(apart), { own: [], models: ["Mythos 1"], pools: [
    ["Gemini", [10080], ["3.8 Flash (Low)"], ["3.8 Flash (High)"]],
    ["Claude & GPT", [10080], ["GPT-OSS 120B"], []],
  ] });
});

test("an account's own windows come first, shortest first, then the models it limits apart", () => {
  const claude = [{ label: "Weekly", windowDurationMins: 10080, usedPercent: 71 }, { label: "5 hours", windowDurationMins: 300, usedPercent: 0 },
    { label: "Fable", bucket: "Fable", windowDurationMins: 10080, scope: "model", usedPercent: 35 }];
  assert.deepEqual(shape(quotaLayout(claude)), { own: [300, 10080], models: ["Fable"], pools: [] });
  // Without pools, model windows are rows of their own, variants that read alike as one, the tightest first.
  const models = quotaLayout([model("Claude Opus 5.5 (High)", 100), model("Claude Opus 5.5 (Low)", 100), model("Gemini 4 Argon (High)", 20)]);
  assert.deepEqual(shape(models), { own: [], models: ["Claude Opus 5.5", "Gemini 4 Argon"], pools: [] });
  assert.deepEqual(shape(quotaLayout(null)), { own: [], models: [], pools: [] });
});

test("Magpie's readings within its own cadence are current; an older one is a previous reading", async () => {
  const NOW = 1_794_000_000_000;
  const read = async age => {
    const usage = createWorkspaceUsage({ now: () => NOW, codex: async () => ({}), readClaudeToken: async () => null, readSignIn: async () => null,
      readCodexSignIn: async () => null, readProviderQuotas: async () => [], readOpenCodex: async () => [],
      readMagpie: async () => [{ service: "minimax", kind: "plan", label: "MiniMax", readAt: NOW - age, accountKey: null,
        windows: [{ label: "5 hours", windowDurationMins: 300, usedPercent: 1, resetsAt: NOW + 3_600_000 }] }] });
    return (await usage.read()).providers.find(p => p.service === "minimax");
  };
  for (const minutes of [0, 2.5, 5, 9]) assert.deepEqual([(await read(minutes * 60000)).status, (await read(minutes * 60000)).observedAt], ["ready", null], minutes + " minutes");
  const old = await read(11 * 60000);
  assert.deepEqual([old.status, old.observedAt], ["cached", NOW - 11 * 60000]);
});

test("Refresh asks Magpie's command, which asks the vendors now; otherwise its gateway's last reading", async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "stepsemble-magpie-fresh-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.mkdirSync(path.join(home, ".local/bin"), { recursive: true });
  fs.writeFileSync(path.join(home, ".local/bin", process.platform === "win32" ? "magpie.exe" : "magpie"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  let time = 1_000_000, gateway = 0, commands = 0, slow = false;
  const entry = used => [{ provider: "minimax", name: "MiniMax", kind: "plan", readAt: new Date(time).toISOString(), windows: [{ name: "5 hours", used, remaining: 100 - used }] }];
  const service = createMagpieGatewayService({ home, env: { PATH: "" }, now: () => time, freshCommandMs: 50,
    fetchImpl: async url => { gateway++; assert.equal(url, "http://127.0.0.1:3425/v1/magpie/quotas"); return new Response(JSON.stringify({ data: entry(10) }), { status: 200 }); },
    execFileImpl: (file, args, options, callback) => {
      commands++; assert.deepEqual(args, ["quota", "--json"]);
      if (slow) setTimeout(() => callback(null, JSON.stringify(entry(30)), ""), 500); else callback(null, JSON.stringify(entry(20)), "");
    } });
  const used = reports => reports[0].windows[0].usedPercent;
  assert.equal(used(await service.quotaReports()), 10); assert.deepEqual([gateway, commands], [1, 0], "a plain reading is the gateway's");
  time += 30_000;
  assert.equal(used(await service.quotaReports()), 10); assert.deepEqual([gateway, commands], [1, 0], "kept a couple of minutes");
  assert.equal(used(await service.quotaReports({ fresh: true })), 20); assert.deepEqual([gateway, commands], [1, 1], "Refresh asks the command");
  time += 5_000;
  assert.equal(used(await service.quotaReports({ fresh: true })), 20); assert.deepEqual([gateway, commands], [1, 1], "a reading moments old answers Refresh");
  time += 20_000; slow = true;
  assert.equal(used(await service.quotaReports({ fresh: true })), 10); assert.deepEqual([gateway, commands], [2, 2], "a slow command gives way to the gateway");
});

test("Claude's five hours not yet started show as all there, beside its week", async () => {
  const NOW = 1_794_000_000_000;
  const usage = createWorkspaceUsage({ now: () => NOW, codex: async () => ({}), readSignIn: async () => null, readProviderQuotas: async () => [], readOpenCodex: async () => [],
    readMagpie: async () => [], readClaudeToken: async () => { throw new Error("no credential reads"); },
    readDesktopClaudeQuota: async () => ({ quotaVersion: 1, status: "ready", sampledAt: NOW, accountKey: "v1:" + "a".repeat(64),
      windows: [{ label: "Weekly", windowDurationMins: 10080, bucket: null, usedPercent: 71, remainingPercent: 29, resetsAt: NOW + 86_400_000 }] }) });
  const claude = (await usage.read()).providers.find(p => p.service === "claude");
  assert.deepEqual(claude.windows.map(w => [w.windowDurationMins, w.usedPercent, w.resetsAt]), [[300, 0, null], [10080, 71, NOW + 86_400_000]]);
});
