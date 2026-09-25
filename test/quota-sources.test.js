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

