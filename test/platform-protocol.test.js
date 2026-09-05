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
  const context = vm.createContext({ fetch, Error, SyntaxError, AbortController, setTimeout, clearTimeout });
  vm.runInContext(await fs.readFile(path.join(root, "public/modules/protocol-contracts.js"), "utf8"), context);
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

test("negotiated responses tolerate additive minor changes but reject invalid required fields", async () => {
  const { Client } = await sdk();
  const good = fixtures[0].response;
  const compatible = { ...good, schemaVersion: "1.2.0", extra: true, limits: { ...good.limits, futureLimit: 10 } };
  const client = new Client({ fetch: async () => Response.json(compatible) });
  assert.equal((await client.negotiate("", fixtures[0].request)).schemaVersion, "1.2.0");
  for (const value of [{ ...good, hostVersion: null }, { ...good, limits: {} }, { ...good, schemaVersion: "2.0.0" },
    { ...good, capabilities: ["legacy.http", "legacy.http"] }, { ...good, disabledCapabilities: ["legacy.http"] }]) {
    const bad = new Client({ fetch: async () => Response.json(value) });
    await assert.rejects(bad.negotiate("", fixtures[0].request), error => error.code === "invalid_response");
  }
  const malformed = new Client({ fetch: async () => new Response("not json") });
  await assert.rejects(malformed.negotiate("", fixtures[0].request), error => error.code === "invalid_response");
});

test("connections coalesce by host, isolate caller cancellation and do not cache failure", async () => {
  const { Client, Connections } = await sdk();
  const requests = [];
  const client = new Client({ fetch: (url, options) => new Promise((resolve, reject) => {
    requests.push({ url, resolve }); options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true });
  }) });
  const connections = new Connections(client, () => fixtures[0].request);
  const abort = new AbortController();
  const cancelled = connections.ensure("/r/one", abort.signal);
  const retained = connections.ensure("/r/one");
  const other = connections.ensure("/r/two");
  assert.equal(requests.length, 2);
  abort.abort(); await assert.rejects(cancelled);
  requests[0].resolve(Response.json(fixtures[0].response));
  requests[1].resolve(Response.json({ error: "unavailable" }, { status: 503 }));
  assert.equal((await retained).protocolVersion, 1);
  await assert.rejects(other, error => error.status === 503);
  await connections.ensure("/r/one"); assert.equal(requests.length, 2);
  const retry = connections.ensure("/r/two"); assert.equal(requests.length, 3);
  requests[2].resolve(new Response(null, { status: 404 })); assert.equal(await retry, null);
  connections.reset();
});

test("connection timeout and missing transport capability never silently downgrade", async () => {
  const { Client, Connections } = await sdk();
  const stalled = new Client({ fetch: (url, options) => new Promise((resolve, reject) => options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true })) });
  await assert.rejects(new Connections(stalled, () => fixtures[0].request, 60000, 10).ensure(""), error => error.code === "protocol_timeout");
  const missing = new Client({ fetch: async () => Response.json({ ...fixtures[0].response, capabilities: [] }) });
  await assert.rejects(new Connections(missing, () => fixtures[0].request).ensure(""), error => error.code === "capability_missing");
});

test("Web API captures its host before negotiation and never sends a mutation on negotiation failure", async () => {
  const source = (await fs.readFile(path.join(root, "public/app.js"), "utf8")).replace(/\r\n/g, "\n");
  const start = source.indexOf("async function api(");
  const end = source.indexOf("\nconst post", start);
  const calls = [];
  let release;
  const context = vm.createContext({ apiBase: "/r/one", protocolConnections: { ensure: () => new Promise(resolve => { release = resolve; }) },
    hostClient: { request: (...args) => { calls.push(args); return true; } } });
  vm.runInContext(source.slice(start, end), context);
  const pending = context.api("/api/sessions");
  context.apiBase = "/r/two"; release(); await pending;
  assert.equal(calls[0][0], "/r/one");
  context.protocolConnections.ensure = async () => { throw new Error("incompatible"); };
  await assert.rejects(context.api("/api/agent/open", { method: "POST" }), /incompatible/);
  assert.equal(calls.length, 1);
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
