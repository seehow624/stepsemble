"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const { createValidator } = require("../protocol/validator");
const { createDomain } = require("../protocol/domain");
const schema = require("../protocol/v1/schema.json");
const { cases, seed, wire, fullBatch } = require("../protocol/v1/fixtures/corpus.cjs");
const contracts = createValidator(schema);
const domain = createDomain(contracts);
const context = vm.createContext({ fetch, Error, AbortController, setTimeout, clearTimeout });
vm.runInContext(fs.readFileSync(require.resolve("../public/modules/protocol-contracts.js"), "utf8"), context);
vm.runInContext(fs.readFileSync(require.resolve("../public/modules/client-sdk.js"), "utf8"), context);
const browser = context.StepsembleProtocol;
const example = type => structuredClone(wire.find(item => item.value.type === type).value);
test("entire explicit wire corpus agrees in Node and browser", () => {
  for (const { name, contract, value, valid } of cases) {
    assert.equal(contracts.validate(contract, value).valid, valid, name);
    assert.equal(browser.validate(contract, value).valid, valid, name);
  }
  for (const contract of ["event", "command"]) assert.deepEqual(
    wire.filter(item => item.contract === contract).map(item => item.value.type).sort(),
    schema.$defs[contract].anyOf.map(branch => branch.properties.type.const).sort(),
    "a new wire variant needs an explicit golden fixture",
  );
});
test("reference siblings are enforced, including in browser generation source", () => {
  const check = createValidator({ $defs: { text: { type: "string" }, value: { $ref: "#/$defs/text", maxLength: 3 } } });
  assert.equal(check.validate("value", "yes").valid, true);
  assert.equal(check.validate("value", "longer").valid, false);
});
test("cross-entity events fail closed and SDK parsing uses semantics", () => {
  for (const api of [domain, browser]) {
    for (const fixture of wire.filter(item => item.contract === "event")) assert.equal(api.checkEvent(fixture.value).valid, true, fixture.value.type);
    for (const [type, field] of [["session.created", "session"], ["run.starting", "run"], ["approval.requested", "approval"]]) {
      const event = example(type); event.payload[field].sessionId = "another-session";
      assert.equal(api.checkEvent(event).code, "entity_mismatch");
      assert.throws(() => context.StepsembleClient.parse("event", event), error => error.code === "entity_mismatch");
    }
    const event = example("approval.requested");
    event.payload.approval.expiresAt = event.createdAt;
    assert.equal(api.checkEvent(event).code, "approval_expired");
    event.payload.approval.status = "approved";
    assert.equal(api.checkEvent(event).code, "entity_mismatch");
    assert.equal(api.checkProfile({ ...seed.launchProfile, credentialReference: "copied-token" }).code, "profile_mismatch");
    assert.equal(api.checkProfile({ ...seed.launchProfile, billingMode: "metered" }).code, "profile_mismatch");
  }
});
test("approval preflight binds device, session, run, nonce, scope and host time", () => {
  const command = example("approval.resolve");
  const state = { session: seed.session, run: { ...seed.run, state: "waiting_approval" }, approval: seed.approval, authenticatedDeviceId: "device-1", now: Date.parse("2026-09-05T00:05:00Z") };
  for (const api of [domain, browser]) {
    assert.equal(api.checkCommandContext(command, state).valid, true);
    for (const [change, code] of [
      [{ authenticatedDeviceId: "other-device" }, "device_mismatch"],
      [{ session: { ...state.session, sessionId: "other-session" } }, "entity_mismatch"],
      [{ session: { ...state.session, status: "archived" } }, "session_conflict"],
      [{ run: { ...state.run, runId: "other-run" } }, "entity_mismatch"],
      [{ run: { ...state.run, state: "completed" } }, "entity_mismatch"],
      [{ approval: { ...state.approval, status: "approved" } }, "approval_conflict"],
      [{ approval: { ...state.approval, nonce: "stale-nonce" } }, "approval_conflict"],
      [{ approval: { ...state.approval, scope: "session" } }, "approval_conflict"],
      [{ now: Date.parse(state.approval.expiresAt) }, "approval_expired"],
      [{ now: Date.parse(state.approval.createdAt) - 1 }, "approval_expired"],
      [{ now: undefined }, "invalid_payload"],
    ]) assert.equal(api.checkCommandContext(command, { ...state, ...change }).code, code);
    assert.equal(api.checkCommandContext({ ...command, payload: { ...command.payload, decision: "denied" } }, state).valid, true);
    const incomplete = { ...state }; delete incomplete.run;
    assert.equal(api.checkCommandContext(command, incomplete).code, "invalid_payload");
    // A persisted winner makes a subsequent request ineligible. This pure check
    // is not itself a transaction or a claim of exactly-once native dispatch.
    assert.equal(api.checkCommandContext(command, { ...state, approval: { ...state.approval, status: "denied" } }).code, "approval_conflict");
  }
});
test("mutations cannot replace an active writer or switch a locked model", () => {
  for (const api of [domain, browser]) {
    const state = { session: seed.session, run: null, authenticatedDeviceId: "device-1", launchProfile: seed.launchProfile };
    for (const type of ["run.start", "model.change", "session.archive", "context.compact"]) {
      const command = example(type);
      assert.equal(api.checkCommandContext(command, state).valid, true, type);
      for (const status of ["starting", "running", "waiting_approval"]) assert.equal(api.checkCommandContext(command, { ...state, run: { ...seed.run, state: status } }).code, "run_conflict");
    }
    assert.equal(api.checkCommandContext(example("run.start"), { ...state, launchProfile: { ...seed.launchProfile, harnessId: "other" } }).code, "profile_mismatch");
    assert.equal(api.checkCommandContext(example("run.start"), { ...state, run: { ...seed.run, state: "completed" } }).code, "run_conflict");
    assert.equal(api.checkCommandContext(example("run.interrupt"), state).code, "run_conflict");
    assert.equal(api.checkCommandContext(example("session.restore"), state).code, "session_conflict");
    assert.equal(api.checkCommandContext(example("session.restore"), { ...state, session: { ...seed.session, status: "archived" } }).valid, true);
    assert.equal(api.checkCommandContext(example("session.restore"), { ...state, run: seed.run, session: { ...seed.session, status: "archived" } }).code, "session_conflict");
  }
});
test("replay is contiguous, generation-bound, duplicate-safe and all-or-nothing", () => {
  for (const api of [domain, browser]) {
    const current = { ...seed.cursor, sequence: 250 };
    const result = api.inspectReplay(current, fullBatch);
    assert.equal(result.kind, "apply");
    assert.equal(result.events.length, 250);
    assert.equal(result.events[0].sequence, 251);
    assert.equal(result.cursor.sequence, 500);
    assert.equal(current.sequence, 250, "checking does not advance the caller cursor");
    assert.equal(api.inspectReplay(result.cursor, fullBatch).kind, "duplicate");
    assert.equal(api.inspectReplay(current, { ...seed.replayBatch }).kind, "duplicate");
    assert.equal(api.inspectReplay(current, { afterCursor: current, cursor: current, events: [], hasMore: false }).kind, "duplicate");
    assert.equal(api.inspectReplay(current, { afterCursor: current, cursor: current, events: [], hasMore: true }).reason, "sequence_gap");
    assert.equal(api.inspectReplay({ ...current, generation: "restored-journal" }, fullBatch).reason, "cursor_mismatch");
    assert.equal(api.inspectReplay({ ...current, sessionId: "other-session" }, fullBatch).reason, "cursor_mismatch");
    const future = { afterCursor: { ...current, sequence: 300 }, cursor: fullBatch.cursor, events: fullBatch.events.slice(300), hasMore: false };
    assert.equal(api.inspectReplay(current, future).reason, "sequence_gap");
    for (const mutation of [
      batch => { batch.events[400].sequence++; },
      batch => { batch.events[400].eventId = batch.events[300].eventId; },
      batch => { batch.events[400].generation = "other-generation"; },
      batch => { batch.events[400].type = "future.event"; },
    ]) {
      const broken = structuredClone(fullBatch); mutation(broken);
      const rejected = api.inspectReplay(current, broken);
      assert.equal(rejected.kind, "snapshot_required");
      assert.equal(rejected.events, undefined, "do not partially apply before a late error");
    }
    const overflow = { afterCursor: { ...current, sequence: Number.MAX_SAFE_INTEGER }, cursor: { ...current, sequence: Number.MAX_SAFE_INTEGER }, events: [seed.event], hasMore: false };
    assert.equal(api.inspectReplay(current, overflow).kind, "snapshot_required");
  }
});
