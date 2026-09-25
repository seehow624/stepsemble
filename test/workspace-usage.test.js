"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), path = require("node:path");
const { createWorkspaceUsage, windowUsage, codexWindows, chatgptWindows, claudeWindows, currentWindows, keychainHome, opencodexProviders,
  configuredProviderQuotas, storedSignIn } = require("../server/workspace-usage");
const jwt = claims => `header.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.signature`;
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
  const osHome = path.resolve("synthetic-user-home");
  const previewHome = path.resolve("synthetic-preview-home");
  assert.equal(keychainHome(osHome, { osHome }), true);
  assert.equal(keychainHome(path.resolve("other-user-home"), { osHome, realpath: () => { throw new Error("missing"); } }), false);
  // An isolated preview home that links .claude at the same directory is still
  // that user's own credentials.
  assert.equal(keychainHome(previewHome, { osHome, realpath: p => p === path.join(previewHome, ".claude")
    ? path.join(osHome, ".claude") : p }), true);
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

test("ChatGPT usage keeps each Codex window and separately metered limit", () => {
  const windows = chatgptWindows({ plan_type: "pro", rate_limit: { allowed: true,
    primary_window: { used_percent: 54, limit_window_seconds: 604800, reset_after_seconds: 1, reset_at: 1_700_600_000 }, secondary_window: null },
  additional_rate_limits: [
    { limit_name: "Spark", metered_feature: "codex_spark", rate_limit: { primary_window: { used_percent: 10, limit_window_seconds: 18000, reset_at: 1_700_010_000 } } },
    { limit_name: "", rate_limit: { primary_window: { used_percent: 5 } } },
    { metered_feature: "codex_other", rate_limit: { primary_window: { used_percent: 180 } } },
  ] });
  assert.deepEqual(windows.map(w => [w.bucket, w.windowDurationMins, w.remainingPercent, w.resetsAt]),
    [["codex", 10080, 46, 1_700_600_000_000], ["codex_spark", 300, 90, 1_700_010_000_000]]);
  assert.deepEqual(chatgptWindows(null), []);
});

test("Codex's allowance is read from ChatGPT when its app-server cannot answer", async () => {
  const fs = require("node:fs"), os = require("node:os");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "stepsemble-quota-"));
  const now = 1_700_000_000_000, live = now / 1000 + 3600, expired = now / 1000 - 60;
  const writeCodexSignIn = token => {
    fs.mkdirSync(path.join(dir, ".codex"), { recursive: true });
    fs.writeFileSync(path.join(dir, ".codex", "auth.json"), JSON.stringify({ auth_mode: "chatgpt", tokens: { access_token: token, account_id: "acct-cli" } }));
  };
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push([url, options.headers.Authorization, options.headers["ChatGPT-Account-Id"]]);
    return { ok: true, json: async () => ({ rate_limit: { primary_window: { used_percent: 54, limit_window_seconds: 604800, reset_at: 1_700_600_000 } } }) };
  };
  const quiet = { now: () => now, fetchImpl, readClaudeToken: async () => null, readClaudeCache: async () => null,
    readProviderQuotas: async () => [], readOpenCodex: async () => [] };
  try {
    // The account the Codex CLI is signed in to comes first.
    const cliToken = jwt({ exp: live });
    writeCodexSignIn(cliToken);
    const first = await createWorkspaceUsage({ ...quiet, home: dir, codex: async () => { throw new Error("codex_schema_mismatch"); },
      readSignIn: async () => { throw new Error("the Codex CLI sign-in answered first"); } }).read();
    assert.deepEqual([first.providers[0].status, first.providers[0].source], ["ready", "account"]);
    assert.deepEqual(first.providers[0].windows.map(w => [w.bucket, w.windowDurationMins, w.remainingPercent]), [["codex", 10080, 46]]);
    assert.deepEqual(calls, [["https://chatgpt.com/backend-api/wham/usage", `Bearer ${cliToken}`, "acct-cli"]]);
    assert.ok(!JSON.stringify(first).includes(cliToken));

    // An expired CLI token is not sent; the ChatGPT account signed in under
    // Settings answers instead, with the account named inside its token.
    calls.length = 0;
    writeCodexSignIn(jwt({ exp: expired }));
    const settingsToken = jwt({ exp: live, "https://api.openai.com/auth": { chatgpt_account_id: "acct-settings" } });
    const second = await createWorkspaceUsage({ ...quiet, home: dir, codex: async () => ({ rateLimits: null }),
      readSignIn: async id => id === "openai-codex" ? { type: "oauth", secret: settingsToken, expiresAt: null } : null }).read();
    assert.deepEqual([second.providers[0].status, second.providers[0].source], ["ready", "signin"]);
    assert.deepEqual(calls, [["https://chatgpt.com/backend-api/wham/usage", `Bearer ${settingsToken}`, "acct-settings"]]);

    // With no live sign-in nothing is sent and the row stays unavailable.
    calls.length = 0;
    const none = await createWorkspaceUsage({ ...quiet, home: dir, codex: async () => { throw new Error("offline"); },
      readSignIn: async () => ({ type: "oauth", secret: "opaque", expiresAt: now - 1 }) }).read();
    assert.deepEqual([none.providers[0].status, calls.length], ["unavailable", 0]);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("Claude's allowance can come from the Claude account signed in under Settings", async () => {
  const calls = [];
  const quiet = { now: () => 1000, codex: async () => ({}), readCodexSignIn: async () => null, readClaudeToken: async () => null,
    readProviderQuotas: async () => [], readOpenCodex: async () => [],
    fetchImpl: async (url, options) => { calls.push([url, options.headers.Authorization]);
      return { ok: true, json: async () => ({ five_hour: { utilization: 30 }, seven_day: { utilization: 5 } }) }; } };
  const signedIn = await createWorkspaceUsage({ ...quiet, readClaudeCache: async () => { throw new Error("a live reading comes first"); },
    readSignIn: async id => id === "anthropic" ? { type: "oauth", secret: "settings-claude", expiresAt: 2000 } : null }).read();
  assert.deepEqual([signedIn.providers[1].status, signedIn.providers[1].source], ["ready", "signin"]);
  assert.deepEqual(signedIn.providers[1].windows.map(w => w.remainingPercent), [70, 95]);
  assert.deepEqual(calls, [["https://api.anthropic.com/api/oauth/usage", "Bearer settings-claude"]]);
  // An Anthropic API key cannot read subscription usage and is never sent there.
  calls.length = 0;
  const keyOnly = await createWorkspaceUsage({ ...quiet, readClaudeCache: async () => null,
    readSignIn: async id => id === "anthropic" ? { type: "api_key", secret: "sk-ant-api" } : null }).read();
  assert.deepEqual([keyOnly.providers[1].status, calls.length], ["unavailable", 0]);
});

test("API keys saved under Settings are probed on their own platform's host", async () => {
  const fs = require("node:fs"), os = require("node:os");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "stepsemble-quota-"));
  fs.mkdirSync(path.join(dir, ".pi", "agent"), { recursive: true });
  const writeSignIns = value => fs.writeFileSync(path.join(dir, ".pi", "agent", "auth.json"), JSON.stringify(value));
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push([url, options.headers.Authorization]);
    return { ok: true, json: async () => url.endsWith("/usage")
      ? { usage: { rolling: { percent: 12 }, weekly: { percent: 10 }, monthly: { percent: 43 } } }
      : { model_remains: [{ current_interval_remaining_percent: 80, current_weekly_remaining_percent: 60 }] } };
  };
  try {
    // A key that runs a command or names an environment variable is Pi's to
    // resolve; it is never run or sent from here, and OAuth is not an API key.
    writeSignIns({ "opencode-go": { type: "api_key", key: "!security find-generic-password -w" },
      minimax: { type: "api_key", key: "$MINIMAX_API_KEY" }, "minimax-cn": { type: "oauth", access: "a", refresh: "r", expires: 1 } });
    assert.deepEqual(await configuredProviderQuotas({ home: dir, osHome: "/nonexistent", fetchImpl }), []);
    assert.equal(calls.length, 0);

    writeSignIns({ "opencode-go": { type: "api_key", key: " sk-go " }, "minimax-cn": { type: "api_key", key: "cn-key" },
      "openai-codex": { type: "oauth", access: "chatgpt", refresh: "r", expires: 5 } });
    const rows = await configuredProviderQuotas({ home: dir, osHome: "/nonexistent", fetchImpl });
    assert.deepEqual(rows.map(r => r.provider), ["OpenCode Go", "MiniMax (China)"]);
    assert.deepEqual(calls.sort(), [["https://api.minimaxi.com/v1/token_plan/remains", "Bearer cn-key"], ["https://opencode.ai/zen/go/v1/usage", "Bearer sk-go"]]);
    assert.deepEqual(await storedSignIn(dir, "openai-codex"), { type: "oauth", secret: "chatgpt", accountId: null, expiresAt: 5 });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("a source that is off is never read, and a preferred source answers first", async () => {
  const now = 1_700_000_000_000;
  const reports = [{ provider: "openai", label: "OpenAI (Codex login)", quota: { weeklyPercent: 80, weeklyResetAt: now + 86_400_000 } },
    { provider: "anthropic", quota: { fiveHourPercent: 29, fiveHourResetAt: now + 3_600_000 } }];
  let codexCalls = 0, openCodexCalls = 0, barCalls = 0;
  const base = { home: "/nonexistent", now: () => now, fetchImpl: async () => { throw new Error("no network in this test"); },
    codex: async () => { codexCalls += 1; return { rateLimits: { primary: { usedPercent: 10, windowDurationMins: 300, resetsAt: now / 1000 + 600 } } }; },
    readClaudeToken: async () => null, readClaudeCache: async () => null, readCodexSignIn: async () => null, readSignIn: async () => null,
    readProviderQuotas: async () => [], readOpenCodex: async () => { openCodexCalls += 1; return reports; },
    readCodexBar: async () => { barCalls += 1; return { installed: true, reports: [] }; } };
  // By default the agent's own reading wins, OpenCodex fills in Claude, and CodexBar stays off.
  const first = await createWorkspaceUsage({ ...base, readConfig: async () => null }).read();
  assert.deepEqual(first.providers.slice(0, 2).map(p => [p.service, p.sourceId, p.windows[0]?.remainingPercent]), [["codex", "agents", 90], ["claude", "opencodex", 71]]);
  assert.equal(barCalls, 0);
  // Preferring OpenCodex for Codex skips the app-server; turning OpenCodex off stops its reads.
  codexCalls = 0;
  const preferred = await createWorkspaceUsage({ ...base, readConfig: async () => ({ prefer: { codex: "opencodex" } }) }).read();
  assert.deepEqual([preferred.providers[0].sourceId, preferred.providers[0].windows[0].remainingPercent, codexCalls], ["opencodex", 20, 0]);
  openCodexCalls = 0;
  const off = await createWorkspaceUsage({ ...base, readConfig: async () => ({ sources: { opencodex: false }, prefer: { codex: "opencodex" } }) }).read();
  assert.deepEqual([off.providers[0].sourceId, off.providers[1].status, openCodexCalls], ["agents", "unavailable", 0]);
});

test("Settings reads every source that is on, and CodexBar readings join the list", async () => {
  const now = 1_700_000_000_000;
  const usage = createWorkspaceUsage({ home: "/nonexistent", now: () => now, fetchImpl: async () => { throw new Error("offline"); },
    codex: async () => ({ rateLimits: { primary: { usedPercent: 40, windowDurationMins: 300, resetsAt: now / 1000 + 600 } } }),
    readClaudeToken: async () => null, readClaudeCache: async () => null, readCodexSignIn: async () => null, readSignIn: async () => null,
    readProviderQuotas: async () => [], readOpenCodex: async () => [],
    readConfig: async () => ({ sources: { codexbar: true } }),
    readCodexBar: async () => ({ installed: true, reports: [
      { id: "codex", label: "Codex", updatedAt: now, windows: [{ key: "primary", windowDurationMins: 300, usedPercent: 25, resetsAt: now + 600_000 }] },
      { id: "cursor", label: "Cursor", updatedAt: now - 3_600_000, windows: [{ key: "primary", windowDurationMins: 43200, usedPercent: 12, resetsAt: now + 86_400_000 }] }] }) });
  const full = await usage.read({ full: true });
  assert.deepEqual(full.sources.agents.services.map(s => s.service), ["codex"]);
  assert.deepEqual(full.sources.codexbar.services.map(s => s.service), ["codex", "cursor"]);
  const cursor = full.providers.find(p => p.service === "cursor");
  // CodexBar's own old reading keeps the time it was taken.
  assert.deepEqual([cursor.sourceId, cursor.status, cursor.observedAt, cursor.source], ["codexbar", "cached", now - 3_600_000, "codexbar"]);
  assert.equal(full.providers.find(p => p.service === "codex").sourceId, "agents");
});
