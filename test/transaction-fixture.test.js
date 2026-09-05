"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const api = require("../protocol/transaction-state");
const fixture = require("../protocol/v1/fixtures/transactions.json");
test("frozen multi-command golden trace replays exact rows, receipts, outbox, events, digests and CAS tokens", async () => {
  assert.equal(fixture.fixtureVersion, 1); assert.equal(api.checkView(fixture.initial).kind, "valid");
  let state = structuredClone(fixture.initial); const commands = new Set();
  for (const step of fixture.steps) {
    const before = JSON.stringify(state), args = structuredClone(step.args);
    if (step.method === "planAdmission") commands.add(args[0].type);
    const actual = await api[step.method](state, ...args);
    assert.deepEqual(actual, step.expected, step.name); assert.equal(JSON.stringify(state), before, step.name);
    if (actual.kind === "transaction") { assert.equal(api.checkView(actual.state).kind, "valid"); state = actual.state; }
  }
  assert.deepEqual([...commands].sort(), require("../protocol/v1/schema.json").$defs.command.anyOf.map(row => row.properties.type.const).sort());
  assert.equal(state.quarantined, true); assert.equal(state.receipts.length, 8); assert.equal(state.projection.session.session.status, "active");
  assert.equal(state.projection.messages.at(-1).text, "Done，🐾"); assert.equal(state.projection.messages.at(-1).thinking, "思考中");
  assert.equal(state.projection.contexts.at(-1).usedTokens, 10); assert.equal(state.projection.runs.at(-1).run.state, "interrupted");
});
test("explicit reference capture still matches the frozen trace without rewriting it", async () => {
  assert.deepEqual(await require("../test-support/transaction-scenario.cjs").capture(), fixture);
});
