"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { createWorkspaceUsage, windowUsage, codexWindows, claudeWindows } = require("../server/workspace-usage");
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
