"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { createWorkspaceUsage, windowUsage, codexWindows, claudeWindows, currentWindows, keychainHome, opencodexProviders, configuredProviderQuotas } = require("../server/workspace-usage");
test("quota preserves observed zero, separates windows and rejects unknown values", () => {
  assert.equal(windowUsage(0, 1700000000, "five").remainingPercent, 100);
  for (const value of [undefined, null, "0", -1, 101, NaN]) assert.equal(windowUsage(value, null, "x"), null);
  assert.deepEqual(codexWindows({ rateLimitsByLimitId: { codex: { primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: 1700000000 }, secondary: { usedPercent: 50, windowDurationMins: 10080 } } } }).map(w => w.remainingPercent), [75, 50]);
});
test("quota coalesces requests, caches results and never exports credentials", async () => {
  let calls = 0, time = 0;
  const service = createWorkspaceUsage({ home: "/synthetic", now: () => time,
    codex: async () => { calls++; return { rateLimits: { primary: { usedPercent: 20 } } }; },
    readClaudeToken: async () => "synthetic-secret",
    fetchImpl: async (url, options) => {
      assert.equal(url, "https://api.anthropic.com/api/oauth/usage");
      assert.equal(options.headers.Authorization, "Bearer synthetic-secret");
      return { ok: true, json: async () => ({ five_hour: { utilization: 0 }, seven_day: { utilization: 90 } }) };
    },
  });
  const [a, b] = await Promise.all([service.read(), service.read()]);
  assert.deepEqual(a, b); assert.equal(calls, 1);
  assert.equal(a.providers[1].windows[0].remainingPercent, 100);
  assert.ok(!JSON.stringify(a).includes("synthetic-secret"));
  await service.read(); assert.equal(calls, 1);
  time = 300001; await service.read(); assert.equal(calls, 2);
});
test("missing quota is unavailable rather than zero and provider failure is isolated", async () => {
  const service = createWorkspaceUsage({ codex: async () => { throw new Error("private failure"); }, readClaudeToken: async () => null,
    fetchImpl: () => { throw new Error("must not fetch without a token"); } });
  const result = await service.read();
  assert.ok(result.providers.every(p => p.status === "unavailable" && p.windows.length === 0));
  assert.ok(!JSON.stringify(result).includes("private"));
});

test("a cached Claude reading is reported with the time it was observed, never as live", async () => {
  const service = createWorkspaceUsage({
    now: () => 500,
    codex: async () => ({ rateLimits: { primary: { usedPercent: 40, windowDurationMins: 10080 } } }),
    readClaudeToken: async () => null,
    fetchImpl: () => { throw new Error("must not fetch without a token"); },
    readClaudeCache: async () => ({ windows: claudeWindows({ five_hour: { utilization: 12 }, seven_day: { utilization: 80 } }), observedAt: 123 }),
  });
  const result = await service.read();
  const [codex, claude] = result.providers;
  assert.equal(codex.status, "ready");
  assert.equal(codex.observedAt, null);
  assert.equal(claude.status, "cached");
  assert.equal(claude.observedAt, 123);
  assert.deepEqual(claude.windows.map(w => w.remainingPercent), [88, 20]);
});

test("a window whose allowance already reset is dropped instead of reporting its old number", () => {
  const now = 1_700_000_000_000;
  const windows = [
    windowUsage(100, 1_699_000_000, "5 hours", 300, null),
    windowUsage(28, 1_700_500_000, "Weekly", 10080, null),
  ];
  const kept = currentWindows(windows, now);
  assert.deepEqual(kept.map(w => w.windowDurationMins), [10080]);
  // A window without a parseable reset time cannot be judged and is retained.
  assert.equal(currentWindows([windowUsage(5, null, "x")], now).length, 1);
});

test("the keychain is read only for the console user's own home", () => {
  const osHome = "/Users/synthetic";
  assert.equal(keychainHome(osHome, { osHome }), true);
  assert.equal(keychainHome("/Users/other", { osHome, realpath: () => { throw new Error("missing"); } }), false);
  // An isolated preview home that links .claude at the same directory is still
  // that user's own credentials.
  assert.equal(keychainHome("/tmp/preview/home", { osHome, realpath: p => p.replace("/tmp/preview/home", osHome) }), true);
  assert.equal(keychainHome("", { osHome }), false);
});

test("opencodex allowances become providers without duplicating the ones read directly", () => {
  const now = 1_700_000_000_000;
  const rows = opencodexProviders([
    { provider: "anthropic", label: "Anthropic Claude", quota: { fiveHourPercent: 0, weeklyPercent: 28 } },
    { provider: "openai", label: "OpenAI (Codex login)", quota: { weeklyPercent: 98 } },
    { provider: "opencode-go", label: "opencode go", quota: { fiveHourPercent: 12, fiveHourResetAt: 1_700_500_000_000,
      weeklyPercent: 10, weeklyResetAt: 1_700_900_000_000, monthlyPercent: 43, monthlyResetAt: 1_701_000_000_000 } },
    { provider: "minimax", label: "MiniMax", quota: {} },
  ], now);
  assert.deepEqual(rows.map(r => r.provider), ["OpenCode Go"]);
  assert.deepEqual(rows[0].windows.map(w => w.windowDurationMins), [300, 10080, 43200]);
  assert.deepEqual(rows[0].windows.map(w => w.remainingPercent), [88, 90, 57]);
  // opencodex reports millisecond timestamps; reading them as seconds would
  // place every reset decades into the past.
  assert.deepEqual(rows[0].windows.map(w => w.resetsAt), [1_700_500_000_000, 1_700_900_000_000, 1_701_000_000_000]);
  // An allowance whose reset already passed is dropped here too.
  assert.deepEqual(opencodexProviders([{ provider: "opencode-go", quota: { weeklyPercent: 5, weeklyResetAt: 1_600_000_000_000 } }], now), []);
});

test("a configured provider is probed by its destination, not by its name", async () => {
  const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "stepsemble-quota-"));
  fs.mkdirSync(path.join(dir, ".pi", "agent"), { recursive: true });
  const write = providers => fs.writeFileSync(path.join(dir, ".pi", "agent", "models.json"), JSON.stringify({ providers }));
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, auth: options.headers.Authorization });
    if (url.endsWith("/token_plan/remains")) {
      return { ok: true, json: async () => ({ model_remains: [
        { model_name: "general", current_interval_remaining_percent: 84, end_time: 1_700_000_000_000, current_weekly_remaining_percent: 100, weekly_end_time: 1_700_600_000_000 },
        { model_name: "video", current_interval_remaining_percent: 30, end_time: 1_700_000_000_000, current_weekly_remaining_percent: 55, weekly_end_time: 1_700_600_000_000 },
      ] }) };
    }
    return { ok: true, json: async () => ({ usage: { rolling: { percent: 12, resetsAt: "2026-09-22T07:40:04.919Z" }, weekly: { percent: 10 }, monthly: { percent: 43 } } }) };
  };
  try {
    // A lookalike name pointing somewhere else must not be probed, and an
    // unresolved environment reference must never be sent upstream.
    write({
      "opencode-go": { baseUrl: "https://api.example.com/v1", apiKey: "sk-other" },
      minimax: { baseUrl: "https://api.minimax.io/v1", apiKey: "$MINIMAX_KEY" },
    });
    assert.deepEqual(await configuredProviderQuotas({ home: dir, osHome: "/nonexistent", fetchImpl }), []);
    assert.equal(calls.length, 0);

    // Canonical destinations are probed, and each is read once even when the
    // user has configured it more than once.
    write({
      "my-go": { baseUrl: "https://opencode.ai/zen/go/v1/", apiKey: "sk-go" },
      "go-again": { baseUrl: "https://opencode.ai/zen/go/v1", apiKey: "sk-go" },
      minimax: { baseUrl: "https://api.minimax.io/v1", apiKey: "sk-mm" },
    });
    const rows = await configuredProviderQuotas({ home: dir, osHome: "/nonexistent", fetchImpl });
    assert.deepEqual(rows.map(r => r.provider).sort(), ["MiniMax", "OpenCode Go"]);
    assert.equal(calls.filter(c => c.url.endsWith("/usage")).length, 1);
    assert.equal(calls.find(c => c.url.endsWith("/usage")).auth, "Bearer sk-go");
    const go = rows.find(r => r.provider === "OpenCode Go");
    assert.deepEqual(go.windows.map(w => w.remainingPercent), [88, 90, 57]);
    // MiniMax reports the remaining share per model; the row keeps the model
    // closest to running out and converts its millisecond reset to seconds.
    const mini = rows.find(r => r.provider === "MiniMax");
    assert.deepEqual(mini.windows.map(w => w.remainingPercent), [30, 55]);
    assert.deepEqual(mini.windows.map(w => w.resetsAt), [1_700_000_000_000, 1_700_600_000_000]);
    assert.deepEqual(mini.windows.map(w => w.windowDurationMins), [300, 10080]);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
