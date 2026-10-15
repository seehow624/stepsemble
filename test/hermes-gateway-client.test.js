"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createHermesDiscovery } = require("../server/hermes-discovery");
const { createHermesSessionStore } = require("../server/hermes-session-store");
const { createHermesGatewayClient } = require("../server/hermes-gateway-client");
const { createFakeHermesGateway } = require("../test-support/fake-hermes-gateway.cjs");

const PASSWORD = "correct horse";
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, timeoutMs = 4000) {
  const started = Date.now();
  while (!(await check())) {
    if (Date.now() - started > timeoutMs) throw new Error("timed out waiting");
    await sleep(10);
  }
}

async function setup(t, fakeOptions = {}, options = {}) {
  const fake = createFakeHermesGateway(fakeOptions);
  await fake.start();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "stepsemble-hermes-client-"));
  const file = path.join(dir, "hermes-session.json");
  const store = createHermesSessionStore({ file });
  const discovery = createHermesDiscovery({ env: { STEPSEMBLE_HERMES_URL: fake.url }, interfaces: () => ({}) });
  const client = createHermesGatewayClient({ discovery, store,
    options: { reconnectDelaysMs: [20, 40, 80], keepaliveMs: 60_000, idleCloseMs: 60_000, idleReconnectBudgetMs: 3_000, ...options } });
  t.after(async () => { client.close(); await fake.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { fake, client, store, file };
}

test("a wrong password is reported once and nothing is saved", async t => {
  const { fake, client, store } = await setup(t);
  await assert.rejects(client.login("jerome", "nope"), error => error.code === "hermes_invalid_credentials" && error.statusCode === 401);
  assert.equal(store.read(), null);
  assert.equal(fake.state.loginAttempts, 1, "no automatic retry");
  fake.state.rateLimitAfter = 1;
  await assert.rejects(client.login("jerome", PASSWORD), error => error.code === "hermes_rate_limited" && error.statusCode === 429);
  const status = await client.status();
  assert.equal(status.signedIn, false);
  assert.equal(status.authRequired, true);
  assert.equal(status.version, "0.22.0");
});

test("signing in keeps only cookies; requests use a ticketed socket that says it answers questions", async t => {
  const { fake, client, file } = await setup(t);
  assert.equal((await client.login("jerome", PASSWORD)).signedIn, true);
  assert.equal(fs.readFileSync(file, "utf8").includes(PASSWORD), false, "the password is never written");
  const result = await client.request("profiles.list", { include_sessions: true });
  assert.equal(result.profiles[0].display_name, "Luna");
  assert.equal(fake.state.ticketsIssued, 1);
  assert.deepEqual(fake.state.capabilities, [true]);
  assert.equal((await client.status()).connection, "open");
});

test("events carry their session and sequence; Hermes questions can be claimed and answered", async t => {
  const { fake, client } = await setup(t);
  await client.login("jerome", PASSWORD);
  const events = [], asked = [];
  client.onEvent(event => events.push(event));
  client.onServerRequest(request => { asked.push(request); return true; });
  const created = await client.request("session.create", { profile: "default" });
  fake.emit(created.session_id, "message.delta", { text: "hi" });
  await until(() => events.some(event => event.type === "message.delta"));
  const delta = events.find(event => event.type === "message.delta");
  assert.equal(delta.sessionId, created.session_id);
  assert.equal(delta.seq, 1);
  assert.deepEqual(delta.payload, { text: "hi" });
  assert.ok(client.epoch, "gateway.ready names the replay epoch");
  const answered = fake.serverRequest(created.session_id, "approval", { request_id: "r1", command: "rm -rf /tmp/x", choices: ["once", "deny"] });
  await until(() => asked.length === 1);
  assert.equal(asked[0].method, "approval");
  assert.equal(asked[0].sessionId, created.session_id);
  assert.equal(client.answer(asked[0].id, { choice: "deny" }), true);
  assert.deepEqual((await answered).result, { choice: "deny" });
});

test("questions nobody here can answer are declined at once", async t => {
  const { fake, client } = await setup(t);
  await client.login("jerome", PASSWORD);
  client.onServerRequest(() => false);
  const created = await client.request("session.create", { profile: "default" });
  assert.equal((await fake.serverRequest(created.session_id, "tour", {})).error.code, 4404);
  assert.equal((await fake.serverRequest(created.session_id, "theme.pick", {})).error.code, -32601);
});

test("a dropped socket is reopened with a fresh ticket", async t => {
  const { fake, client } = await setup(t);
  await client.login("jerome", PASSWORD);
  await client.request("ping");
  const states = [];
  client.onState(change => states.push(change.state));
  fake.dropSockets();
  await until(() => states.includes("open"));
  assert.ok(states.includes("retrying"));
  assert.equal(fake.state.ticketsIssued, 2);
  assert.deepEqual(await client.request("ping"), { pong: true });
});

test("an expired sign-in stops the client instead of retrying", async t => {
  const { fake, client, store } = await setup(t);
  await client.login("jerome", PASSWORD);
  await client.request("ping");
  fake.expireSessions();
  fake.dropSockets();
  await until(async () => (await client.status()).connection === "signed_out");
  const issued = fake.state.ticketsIssued;
  await sleep(250);
  assert.equal(fake.state.ticketsIssued, issued, "no retry loop");
  assert.equal(store.read(), null);
  await assert.rejects(client.request("ping"), error => error.code === "hermes_signed_out");
});

test("rotated cookies replace the stored ones", async t => {
  const { fake, client, store } = await setup(t);
  await client.login("jerome", PASSWORD);
  const before = store.read().cookies.hermes_session_at;
  fake.rotateAccessToken();
  await client.rest("GET", "/api/sessions", { query: { profile: "default" } });
  const after = store.read().cookies.hermes_session_at;
  assert.notEqual(after, before);
  assert.deepEqual((await client.rest("GET", "/api/sessions", { query: { profile: "default" } })).sessions, []);
});

test("a Hermes that needs no sign-in is used with its own page token", async t => {
  const { client } = await setup(t, { authRequired: false });
  assert.equal((await client.status()).signedIn, true);
  assert.deepEqual(await client.request("ping"), { pong: true });
  assert.deepEqual((await client.rest("GET", "/api/sessions", { query: { profile: "default" } })).sessions, []);
});

test("an idle connection closes; a held one stays open", async t => {
  const { client } = await setup(t, {}, { idleCloseMs: 100 });
  await client.login("jerome", PASSWORD);
  await client.request("ping");
  const release = client.hold();
  await sleep(250);
  assert.equal((await client.status()).connection, "open");
  release();
  await until(async () => (await client.status()).connection === "idle");
});
