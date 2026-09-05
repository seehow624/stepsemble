"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const vm = require("node:vm");
const { spawn } = require("node:child_process");
const { negotiate, SUPPORTED_CAPABILITIES, PLATFORMS } = require("../server/platform-protocol");
const fixtures = require("../protocol/v1/fixtures/negotiation.json");
const schema = require("../protocol/v1/schema.json");
const root = path.resolve(__dirname, "..");

test("negotiation fixtures freeze current capabilities and incompatible version behavior", () => {
  for (const fixture of fixtures) assert.deepEqual(negotiate(fixture.request, "3.0.3"), { status: fixture.status, body: fixture.response }, fixture.name);
  assert.deepEqual(schema.$defs.handshake.properties.platform.enum, PLATFORMS);
  assert.equal(schema.$defs.negotiated.properties.protocolVersion.const, 1);
  assert.ok(!SUPPORTED_CAPABILITIES.includes("approval.durable"));
});

test("malformed handshakes fail without echoing client-supplied material", () => {
  const hello = fixtures[0].request;
  for (const bad of [null, [], "secret-value", {}, { ...hello, protocolMax: Infinity },
    { ...hello, protocolMin: 1.1 }, { ...hello, deviceId: "../secret-value" },
    { ...hello, capabilities: ["legacy.http", "legacy.http"] },
    { ...hello, capabilities: new Array(65).fill("legacy.http") },
    { ...hello, platform: "__proto__" }]) {
    const result = negotiate(bad, "3.0.3");
    assert.equal(result.status, 400);
    assert.ok(!JSON.stringify(result).includes("secret-value"));
  }
  assert.equal(negotiate({ ...hello, futureField: true }, "3.0.3").status, 200);
});

async function sdk() {
  const context = vm.createContext({ fetch, Error });
  vm.runInContext(await fs.readFile(path.join(root, "public/modules/client-sdk.js"), "utf8"), context);
  return context.StepsembleClient;
}

test("typed client preserves no-content, legacy errors, authorization and cancellation", async () => {
  const { Client } = await sdk();
  let calls = 0;
  const abort = new AbortController();
  const client = new Client({ fetch: async (url, options) => {
    calls++;
    assert.equal(url, "/r/fixture/api/abort");
    assert.equal(options.signal, abort.signal);
    assert.equal(options.credentials, "same-origin");
    return new Response(null, { status: 204 });
  } });
  assert.equal(await client.request("/r/fixture", "/api/abort", { method: "POST", signal: abort.signal }), null);
  assert.equal(calls, 1); // no implicit retry of side effects
  const denied = new Error("remote unauthorized");
  const unauthorized = new Client({ fetch: async () => new Response(null, { status: 401 }), onUnauthorized: base => { assert.equal(base, "/r/other"); return denied; } });
  await assert.rejects(unauthorized.request("/r/other", "/api/sessions"), error => error === denied);
  const legacy = new Client({ fetch: async () => Response.json({ error: "no such session" }, { status: 404 }) });
  await assert.rejects(legacy.request("", "/api/session"), error => error.status === 404 && error.message === "no such session" && error.path === "/api/session");
  const cancelled = new Error("cancelled");
  const failed = new Client({ fetch: async () => { throw cancelled; } });
  await assert.rejects(failed.request("", "/api/sessions"), error => error === cancelled);
});

test("client only treats missing handshake endpoint as a legacy host", async () => {
  const { Client } = await sdk();
  const missing = new Client({ fetch: async () => Response.json({ error: "not found" }, { status: 404 }) });
  assert.equal(await missing.negotiate("", fixtures[0].request), null);
  const newer = new Client({ fetch: async () => Response.json(fixtures[1].response, { status: 426 }) });
  await assert.rejects(newer.negotiate("", fixtures[0].request), error => error.status === 426 && error.code === "protocol_incompatible");
  const malformed = new Client({ fetch: async () => Response.json({ protocolVersion: 9 }) });
  await assert.rejects(malformed.negotiate("", fixtures[0].request), error => error.code === "invalid_response");
});

test("real HTTP handshake requires auth, honors golden wire responses, and bounds request size", async t => {
  const { freePort, waitForServer, stopServer } = await import("../scripts/host-performance-baseline.mjs");
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "stepsemble-protocol-test-"));
  const port = await freePort();
  const child = spawn(process.execPath, [path.join(root, "server.js")], {
    env: { PATH: path.dirname(process.execPath) + path.delimiter + "/usr/bin:/bin", HOME: home, PI_HOME: home,
      PI_BIN: path.join(root, "test-support/synthetic-pi.cjs"), STEPSEMBLE_PORT: String(port), STEPSEMBLE_HOST: "127.0.0.1", STEPSEMBLE_ORPHAN_EXIT: "0" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(async () => { await stopServer(child); await fs.rm(home, { recursive: true, force: true }); });
  await waitForServer(child);
  child.stdout.resume(); child.stderr.resume();
  const base = `http://127.0.0.1:${port}`;
  assert.equal((await fetch(base + "/api/protocol/handshake", { method: "POST" })).status, 401);
  const token = (await fs.readFile(path.join(home, ".config/stepsemble/token"), "utf8")).trim();
  const login = await fetch(base + "/api/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token }) });
  const cookie = login.headers.get("set-cookie").split(";", 1)[0];
  for (const fixture of fixtures) {
    const response = await fetch(base + "/api/protocol/handshake", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify(fixture.request) });
    assert.equal(response.status, fixture.status);
    const expected = structuredClone(fixture.response);
    if (expected.hostVersion) expected.hostVersion = require("../package.json").version;
    assert.deepEqual(await response.json(), expected);
  }
  const tooLarge = await fetch(base + "/api/protocol/handshake", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ padding: "x".repeat(17000) }) });
  assert.ok([400, 413].includes(tooLarge.status));
});
