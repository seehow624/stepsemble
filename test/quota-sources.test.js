"use strict";
// Settings → Quota sources reads OpenCodex's loopback management API. These
// tests use a temporary directory and a fake fetch; no service is contacted.
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { opencodexSource, providerRow } = require("../server/quota-sources");

function home() { return fs.mkdtempSync(path.join(os.tmpdir(), "stepsemble-quota-sources-")); }
function response(status, body) { return { ok: status >= 200 && status < 300, status, json: async () => body }; }

test("a missing OpenCodex is reported as not installed without any request", async () => {
  const dir = home();
  let calls = 0;
  const source = await opencodexSource({ home: dir, osHome: dir, env: {}, fetchImpl: async () => { calls++; return response(500, {}); } });
  assert.equal(source.installed, false);
  assert.equal(source.running, false);
  assert.equal(source.reason, "not_installed");
  assert.equal(calls, 0);
});

test("a running OpenCodex lists its providers with the admin token on the bound port", async () => {
  const dir = home(), ocx = path.join(dir, ".opencodex");
  fs.mkdirSync(ocx);
  fs.writeFileSync(path.join(ocx, "admin-api-token"), "synthetic-admin-token\n", { mode: 0o600 });
  fs.writeFileSync(path.join(ocx, "runtime-port.json"), JSON.stringify({ pid: 1, port: 10555, attestationSecret: "not-read" }));
  const seen = [];
  const source = await opencodexSource({ home: dir, osHome: dir, env: {}, fetchImpl: async (url, options) => {
    seen.push({ url, auth: options.headers.Authorization });
    return response(200, { reports: [
      { provider: "anthropic", label: "Anthropic Claude", quota: { fiveHourPercent: 73, fiveHourResetAt: 1790271000283, weeklyPercent: 17, customWindows: [{ label: "Fable", percent: 0 }] } },
      { provider: "openai", label: "OpenAI (Codex login)", quota: { updatedAt: 1 } },
    ] });
  } });
  assert.deepEqual(seen, [{ url: "http://127.0.0.1:10555/api/provider-quotas", auth: "Bearer synthetic-admin-token" }]);
  assert.equal(source.running, true);
  assert.equal(source.dashboardUrl, "http://localhost:10555");
  assert.equal(source.providers.length, 2);
  assert.deepEqual(source.providers[0].windows.map(window => [window.key, window.usedPercent]), [["fiveHour", 73], ["weekly", 17], ["custom", 0]]);
  assert.deepEqual(source.providers[1].windows, []);
  assert.ok(!JSON.stringify(source).includes("synthetic-admin-token"), "the admin token never leaves the host");
});

test("without a token the service is still reported as up or down", async () => {
  const dir = home();
  fs.mkdirSync(path.join(dir, ".opencodex"));
  const up = await opencodexSource({ home: dir, osHome: dir, env: {}, fetchImpl: async url => url.endsWith("/v1/models") ? response(200, { data: [] }) : response(404, {}) });
  assert.equal(up.running, true);
  assert.equal(up.reason, "token_missing");
  const down = await opencodexSource({ home: dir, osHome: dir, env: {}, fetchImpl: async () => { throw new Error("ECONNREFUSED"); } });
  assert.equal(down.running, false);
});

test("provider rows ignore malformed readings", () => {
  assert.equal(providerRow({}), null);
  assert.deepEqual(providerRow({ provider: "x", quota: { fiveHourPercent: "n/a", weeklyPercent: 250 } }).windows.map(window => window.usedPercent), [100]);
});


const { normalizeQuotaConfig, readQuotaConfig, writeQuotaConfig, codexbarReports, createCodexBarReader } = require("../server/quota-sources");

test("quota settings start with CodexBar off and keep only known sources and choices", async () => {
  assert.deepEqual(normalizeQuotaConfig(null).sources, { agents: true, pi: true, opencodex: true, codexbar: false });
  const dir = home();
  try {
    assert.deepEqual((await readQuotaConfig(dir)).prefer, {});
    await writeQuotaConfig(dir, { sources: { codexbar: true, evil: true, pi: "yes" }, prefer: { codex: "opencodex", claude: "nowhere", "../x": "pi" } });
    const saved = await readQuotaConfig(dir);
    assert.deepEqual([saved.sources.codexbar, saved.sources.pi, saved.prefer], [true, true, { codex: "opencodex" }]);
    assert.equal(fs.statSync(path.join(dir, "quota-sources.json")).mode & 0o777, 0o600);
    await writeQuotaConfig(dir, { prefer: { codex: null } });
    assert.deepEqual((await readQuotaConfig(dir)).prefer, {});
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("CodexBar's JSON becomes windows per provider, skipping failed providers", () => {
  const reports = codexbarReports([
    { provider: "codex", usage: { primary: { usedPercent: 28, windowMinutes: 300, resetsAt: "2025-12-04T19:15:00Z" },
      secondary: { usedPercent: 59, windowMinutes: 10080, resetsAt: "2025-12-05T17:00:00Z" }, tertiary: null, updatedAt: "2025-12-04T18:10:22Z" } },
    { provider: "claude", error: { message: "signed out" } },
    { provider: "Cursor", usage: { primary: { usedPercent: "n/a" } } },
    { provider: "../etc", usage: { primary: { usedPercent: 1 } } },
  ]);
  assert.deepEqual(reports.map(r => [r.id, r.label, r.windows.map(w => [w.key, w.windowDurationMins, w.usedPercent])]),
    [["codex", "Codex", [["primary", 300, 28], ["secondary", 10080, 59]]]]);
  assert.equal(reports[0].windows[0].resetsAt, Date.parse("2025-12-04T19:15:00Z"));
  assert.deepEqual(codexbarReports({ provider: "grok", usage: { primary: { usedPercent: 5, windowMinutes: 10080 } } }).map(r => r.id), ["grok"]);
});

test("CodexBar's CLI runs at most once per five minutes", async () => {
  let clock = 0, runs = 0;
  const reader = createCodexBarReader({ now: () => clock, find: async () => "/opt/homebrew/bin/codexbar",
    run: async () => { runs += 1; return { ok: true, reason: null, reports: [{ id: "codex" }] }; } });
  await Promise.all([reader.read(), reader.read()]);
  clock = 4 * 60 * 1000; await reader.read();
  assert.equal(runs, 1);
  clock = 6 * 60 * 1000; await reader.read();
  assert.equal(runs, 2);
  const missing = await createCodexBarReader({ find: async () => null, run: async () => { throw new Error("never runs"); } }).read();
  assert.deepEqual([missing.installed, missing.reason], [false, "not_installed"]);
});
