"use strict";
const assert = require("node:assert/strict");
const path = require("node:path");
const Ajv = require("ajv/dist/2020");
const addFormats = require("ajv-formats");
const root = process.argv[2];
const schema = require(path.join(root, "protocol/v1/schema.json"));
const { createValidator } = require(path.join(root, "protocol/validator.js"));
const { cases } = require(path.join(root, "protocol/v1/fixtures/corpus.cjs"));
const ajv = new Ajv({ strict: true });
addFormats(ajv, { mode: "full" });
ajv.addSchema(schema);
const local = createValidator(schema);
const compiled = new Map();
for (const key of Object.keys(schema.$defs)) compiled.set(key, ajv.compile({ $ref: `${schema.$id}#/$defs/${key}` }));
for (const { name, contract, value, valid } of cases) {
  // Do not print payloads or errors with user-controlled values on failure.
  assert.equal(compiled.get(contract)(value), valid, `Independent schema result: ${name}`);
  assert.equal(local.validate(contract, value).valid, valid, `Local schema result: ${name}`);
}
console.log(`Independent Draft 2020-12 conformance: ${cases.length} cases passed (Ajv ${require("ajv/package.json").version}).`);
