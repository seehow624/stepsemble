"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const schema = require("../protocol/v1/schema.json");
const fixtures = require("../protocol/v1/fixtures/domains.json");
const { createValidator } = require("../protocol/validator");
const node = createValidator(schema);
const context = vm.createContext({ fetch, Error, AbortController, setTimeout, clearTimeout });
vm.runInContext(fs.readFileSync(require.resolve("../public/modules/protocol-contracts.js"), "utf8"), context);
vm.runInContext(fs.readFileSync(require.resolve("../public/modules/client-sdk.js"), "utf8"), context);
const browser = context.StepsembleProtocol;

function expect(contract, value, valid) {
  for (const validator of [node, browser]) assert.equal(validator.validate(contract, value).valid, valid, contract);
}
test("Node and browser validate every reserved domain and reject missing required fields", () => {
  for (const { contract, value } of fixtures) {
    expect(contract, value, true);
    assert.deepEqual(context.StepsembleClient.parse(contract, value), value);
    for (const field of schema.$defs[contract].required) {
      const missing = structuredClone(value); delete missing[field];
      expect(contract, missing, false);
    }
    for (const invalid of [null, [], "private-token", 7]) expect(contract, invalid, false);
    const additive = { ...value, futureField: true };
    expect(contract, additive, schema.$defs[contract].additionalProperties !== false);
  }
});
test("contract negative boundaries fail closed without exposing payload material", () => {
  const seed = Object.fromEntries(fixtures.map(item => [item.contract, item.value]));
  for (const [contract, value] of [
    ["event", { ...seed.event, sequence: Number.MAX_SAFE_INTEGER + 1 }],
    ["event", { ...seed.event, sequence: 0 }],
    ["cursor", { ...seed.cursor, sequence: -1 }],
    ["cursor", { ...seed.cursor, generation: "../private-token" }],
    ["approval", { ...seed.approval, scope: "always" }],
    ["approval", { ...seed.approval, request: { summary: "" } }],
    ["run", { ...seed.run, state: "unknown" }],
    ["page", { ...seed.page, items: Array(501).fill(null) }],
    ["launchProfile", { ...seed.launchProfile, authMode: "silently_fallback" }],
  ]) expect(contract, value, false);
  for (const time of ["2026-02-29T00:00:00Z", "2026-13-01T00:00:00Z", "2026-09-05T24:00:00Z", "2026-09-05T00:00:00", "2026-09-05T00:00:00+25:00"]) expect("run", { ...seed.run, createdAt: time }, false);
  expect("run", { ...seed.run, createdAt: "2024-02-29T00:00:00.123Z" }, true);
  assert.throws(() => context.StepsembleClient.parse("approval", { private: "private-token" }), error => error.code === "invalid_payload" && !error.message.includes("private-token"));
});
test("unsupported schema extensions fail at construction, not as permissive validation", () => {
  assert.throws(() => createValidator({ $defs: { value: { oneOf: [] } } }), /Unsupported schema keyword/);
  assert.throws(() => createValidator({ $defs: { value: { $ref: "https://invalid.test" } } }), /Unknown schema reference/);
  expect("__proto__", {}, false);
});
