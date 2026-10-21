"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs/promises"), os = require("node:os"), path = require("node:path");
const { routingFilePath, claudeGatewayReadiness } = require("../server/claude-session-routing");

async function fixture(t, value = { version: 1, enabled: true, baseUrl: "http://127.0.0.1:3425" }) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "stepsemble-gateway-auth-"));
  const file = routingFilePath(home);
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await fs.writeFile(file, JSON.stringify(value), { mode: 0o600 });
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  return { home, file };
}

test("an explicit loopback gateway uses bounded model discovery, not native credentials", async t => {
  const f = await fixture(t);
  let calls = 0;
  const result = await claudeGatewayReadiness(f.home, { fetchImpl: async (url, options) => {
    calls++;
    assert.equal(url, "http://127.0.0.1:3425/v1/models");
    assert.equal(options.redirect, "error");
    assert.ok(options.signal instanceof AbortSignal);
    assert.deepEqual(options.headers, { accept: "application/json" });
    return Response.json({ data: [{ id: "claude/fixture" }] });
  } });
  assert.deepEqual(result, { ready: true });
  assert.equal(calls, 1);
});

test("disabled and invalid routes cannot bypass native authentication", async t => {
  const f = await fixture(t);
  for (const value of [
    { version: 1, enabled: false, baseUrl: "http://127.0.0.1:3425" },
    { version: 1, enabled: true, baseUrl: "https://example.invalid" },
  ]) {
    await fs.writeFile(f.file, JSON.stringify(value));
    assert.equal(await claudeGatewayReadiness(f.home, { fetchImpl: () => { assert.fail("unexpected request"); } }), null);
  }
});

test("offline, rejected, malformed and oversized gateway catalogs fail closed", async t => {
  const f = await fixture(t);
  for (const fetchImpl of [
    async () => { throw new Error("connection refused"); },
    async () => Response.json({ data: [{ id: "fixture" }] }, { status: 401 }),
    async () => Response.json({ data: [] }),
    async () => Response.json({ data: [{ id: 123 }] }),
    async () => new Response("not JSON"),
    async () => new Response("x".repeat(8 * 1024 * 1024 + 1)),
  ]) assert.deepEqual(await claudeGatewayReadiness(f.home, { fetchImpl }), { ready: false });
});

test("a changed route cannot reuse an in-flight gateway result", async t => {
  const f = await fixture(t);
  assert.deepEqual(await claudeGatewayReadiness(f.home, { fetchImpl: async () => {
    await fs.writeFile(f.file, JSON.stringify({ version: 1, enabled: false, baseUrl: "http://127.0.0.1:3425" }));
    return Response.json({ data: [{ id: "fixture" }] });
  } }), { ready: false });
});

test("a hung gateway request has a bounded deadline", async t => {
  const f = await fixture(t);
  const start = Date.now();
  const result = await claudeGatewayReadiness(f.home, { timeoutMs: 30, fetchImpl: (_url, { signal }) => new Promise((resolve, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    // Keep the synthetic request alive just as a real socket would.
    const timer = setTimeout(() => resolve(Response.json({ data: [] })), 1000);
    signal.addEventListener("abort", () => clearTimeout(timer), { once: true });
  }) });
  assert.deepEqual(result, { ready: false });
  assert.ok(Date.now() - start < 500);
});
