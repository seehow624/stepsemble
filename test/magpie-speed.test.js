"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { createMagpieGatewayService } = require("../server/magpie-gateway-service");
const row = { id: "codex/gpt-6.1-sol", owned_by: "codex", service_tiers: [{ id: "priority", name: "Fast" }], native_endpoints: ["/v1/responses"] };
test("magpie-speed: the identified service, exact Codex owner, Responses endpoint and snake_case tier are all required", async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "magpie-speed-")); t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.mkdirSync(path.join(home, ".config", "magpie"), { recursive: true });
  let metadata = row, offline = false; const calls = [];
  const gateway = createMagpieGatewayService({ home, env: { HOME: home, PATH: "" }, fetchImpl: async url => {
    calls.push(url); if (offline) throw new Error("offline"); return new Response(JSON.stringify({ data: [metadata] }), { status: 200 });
  } });
  const input = { baseUrl: "http://127.0.0.1:3425/v1", model: row.id, api: "openai-responses" };
  const cap = await gateway.speedCapability(input);
  assert.equal(cap.support, "supported"); assert.equal(cap.route, "magpie"); assert.equal(cap.tier, "priority"); assert.equal(cap.effective, "unknown");
  assert.deepEqual(calls, ["http://127.0.0.1:3425/v1/models"]);
  for (const baseUrl of ["https://other.example/v1", "http://127.0.0.1:3426/v1", "http://127.0.0.1:3425/other", "http://user@127.0.0.1:3425/v1"]) assert.equal((await gateway.speedCapability({ ...input, baseUrl })).support, "unknown");
  assert.equal(calls.length, 1, "the caller cannot make the service probe arbitrary endpoints");
  assert.equal((await gateway.speedCapability({ ...input, baseUrl: "http://127.0.0.1:3425/backend-api/codex" })).support, "unknown", "Responses metadata alone never enables the backend route");
  for (const change of [{ owned_by: "relay" }, { owned_by: undefined }, { native_endpoints: [] }, { service_tiers: [{ id: "turbo", name: "Fast" }] }, { service_tiers: undefined }]) {
    metadata = { ...row, ...change }; assert.equal((await gateway.speedCapability(input)).support, "unknown");
  }
  metadata = row; offline = true; assert.equal((await gateway.speedCapability(input)).support, "unknown", "stale catalog is not permission to spend");
});
test("magpie-speed: separate native Codex backend contract requires both exact native and gateway priority catalogs", async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "magpie-backend-")); t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.mkdirSync(path.join(home, ".config", "magpie"), { recursive: true });
  let metadata, offline = false;
  const gateway = createMagpieGatewayService({ home, env: { HOME: home, PATH: "" }, fetchImpl: async () => {
    if (offline) throw new Error("offline"); return new Response(JSON.stringify({ data: [metadata] }));
  } });
  for (const model of ["gpt-6.1-sol", "gpt-6-astra"]) {
    metadata = { ...row, id: "codex/" + model };
    const input = { baseUrl: "http://127.0.0.1:3425/backend-api/codex", api: "codex-native-backend", provider: "openai", model,
      nativeModels: [{ id: model, model, serviceTiers: [{ id: "priority" }] }] };
    const cap = await gateway.speedCapability(input);
    assert.equal(cap.support, "supported"); assert.equal(cap.model, model); assert.equal(cap.effective, "unknown");
    assert.deepEqual(JSON.parse(cap.fingerprint), ["magpie-codex-native-v1", gateway.origin, "/backend-api/codex", "openai", model, "codex/" + model, "priority"]);
    for (const change of [{ provider: "magpie" }, { nativeModels: [] }, { nativeModels: [{ id: model, serviceTiers: [] }] },
      { model: "codex/" + model }, { model: "group/custom" }, { model: "custom" },
      { baseUrl: gateway.origin + "/backend-api/codex/" }, { baseUrl: "http://user@127.0.0.1:3425/backend-api/codex" },
      { baseUrl: "http://127.0.0.1:3426/backend-api/codex" }, { baseUrl: gateway.origin + "/backend-api/codex?x=1" }]) {
      assert.equal((await gateway.speedCapability({ ...input, ...change })).support, "unknown");
    }
    metadata = { ...metadata, owned_by: "relay" }; assert.equal((await gateway.speedCapability(input)).support, "unknown");
    metadata = { ...row, id: "codex/" + model, service_tiers: [] }; assert.equal((await gateway.speedCapability(input)).support, "unknown");
    metadata = { ...row, id: "codex/" + model }; offline = true;
    assert.equal((await gateway.speedCapability(input)).support, "unknown"); offline = false;
  }
});
