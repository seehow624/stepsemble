"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { createHermesDiscovery, candidateUrls, isOwnHost, normalizeStatus } = require("../server/hermes-discovery");
const { createFakeHermesGateway } = require("../test-support/fake-hermes-gateway.cjs");

const interfaces = {
  en0: [{ family: "IPv4", internal: false, address: "192.168.1.20" }],
  utun4: [{ family: "IPv4", internal: false, address: "100.79.81.95" }],
  lo0: [{ family: "IPv4", internal: true, address: "127.0.0.1" }],
};

test("only this computer's own addresses are tried, the configured one first", () => {
  assert.deepEqual(candidateUrls({ env: { STEPSEMBLE_HERMES_URL: "http://100.79.81.95:9200/ignored" }, interfaces }),
    ["http://100.79.81.95:9200", "http://127.0.0.1:9119", "http://192.168.1.20:9119", "http://100.79.81.95:9119"]);
  for (const outside of ["http://example.com:9119", "http://10.0.0.9:9119", "ftp://127.0.0.1:9119", "http://user:pw@127.0.0.1:9119"]) {
    assert.equal(candidateUrls({ env: { STEPSEMBLE_HERMES_URL: outside }, interfaces })[0], "http://127.0.0.1:9119", outside);
  }
  assert.equal(isOwnHost("localhost", interfaces), true);
  assert.equal(isOwnHost("[::1]", interfaces), true);
  assert.equal(isOwnHost("100.79.81.95", interfaces), true);
  assert.equal(isOwnHost("8.8.8.8", interfaces), false);
});

test("a status answer must name a version, and its sign-in facts are normalized", () => {
  assert.equal(normalizeStatus({}), null);
  assert.equal(normalizeStatus({ version: "" }), null);
  assert.deepEqual(normalizeStatus({ version: "0.21.6", auth_required: true, auth_providers: ["basic", 7], install_id: "abc", gateway_running: true }),
    { version: "0.21.6", authRequired: true, providers: ["basic"], installId: "abc", gatewayRunning: true });
});

test("discovery finds a running Hermes and remembers it for a while", async t => {
  const fake = createFakeHermesGateway();
  await fake.start();
  t.after(() => fake.close());
  let clock = 1_000, probes = 0;
  const fetchImpl = (url, init) => { probes += 1; return fetch(url, init); };
  const discovery = createHermesDiscovery({ env: { STEPSEMBLE_HERMES_URL: fake.url }, interfaces: () => ({}), fetchImpl, now: () => clock });
  const found = await discovery.find();
  assert.equal(found.url, fake.url);
  assert.equal(found.status.version, "0.21.6");
  assert.equal(found.status.authRequired, true);
  const before = probes;
  await discovery.find();
  assert.equal(probes, before, "answered from memory");
  clock += 31_000;
  await discovery.find();
  assert.ok(probes > before, "asked again after the memory window");
});

test("nothing listening means no Hermes, not an error", async () => {
  const discovery = createHermesDiscovery({ env: {}, interfaces: () => ({}), fetchImpl: async () => { throw new Error("ECONNREFUSED"); } });
  assert.equal(await discovery.find(), null);
});
