"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const { createHash } = require("node:crypto");
const schema = require("../protocol/v1/schema.json");
const { createValidator } = require("../protocol/validator");
const { createDomain } = require("../protocol/domain");
const { describeCommand, inspectCommand, transitionReceipt, recoverReceipt } = require("../protocol/command-state");
const fingerprints = require("../protocol/v1/fixtures/command-fingerprints.json");
const { seed, wire } = require("../protocol/v1/fixtures/corpus.cjs");
const { states, cases, outcome } = require("../protocol/v1/fixtures/receipts.cjs");
const contracts = createValidator(schema), domain = createDomain(contracts);
const browser = vm.createContext({ fetch, Error, AbortController, setTimeout, clearTimeout });
vm.runInContext(fs.readFileSync(require.resolve("../public/modules/protocol-contracts.js"), "utf8"), browser);
vm.runInContext(fs.readFileSync(require.resolve("../public/modules/client-sdk.js"), "utf8"), browser);
const command = type => structuredClone(wire.find(item => item.contract === "command" && item.value.type === type).value);
const now = Date.parse("2026-09-05T00:00:00Z");
function context(type = "run.start") {
  return { authorized: true, authenticatedDeviceId: "device-1", session: { ...seed.session, status: type === "session.restore" ? "archived" : "active" },
    run: type === "approval.resolve" ? { ...seed.run, state: "waiting_approval" } : type === "run.interrupt" ? seed.run : null,
    approval: seed.approval, launchProfile: seed.launchProfile, now, receiptId: "receipt-1", existingReceipt: null, commandIdReceipt: null };
}
const move = (receipt, action, options = {}) => transitionReceipt(receipt, action, { now: now + 1000, expectedRevision: receipt.revision, ...options });

test("command identity freezes all eight intents, not key order or retry command IDs", () => {
  assert.deepEqual(Object.keys(fingerprints.digests).sort(), schema.$defs.command.anyOf.map(item => item.properties.type.const).sort());
  assert.deepEqual(schema.$defs.commandReceipt.properties.commandType.enum.slice().sort(), Object.keys(fingerprints.digests).sort());
  for (const [type, digest] of Object.entries(fingerprints.digests)) {
    const value = command(type), original = JSON.stringify(value), binding = describeCommand(value);
    assert.equal(binding.kind, "binding"); assert.equal(binding.fingerprintVersion, fingerprints.version); assert.equal(binding.fingerprint, digest);
    assert.deepEqual(binding.scope, [value.deviceId, value.sessionId, type, value.idempotencyKey]);
    assert.equal(describeCommand({ ...value, payload: Object.fromEntries(Object.entries(value.payload).reverse()), commandId: "new-retry-id", futureMetadata: "ignored" }).fingerprint, digest);
    const nextKey = describeCommand({ ...value, idempotencyKey: "new-key" }); assert.equal(nextKey.fingerprint, digest); assert.notDeepEqual(nextKey.scope, binding.scope);
    assert.notEqual(describeCommand({ ...value, sessionId: "other-session" }).fingerprint, digest);
    assert.notEqual(describeCommand({ ...value, deviceId: "other-device" }).fingerprint, digest);
    assert.equal(JSON.stringify(value), original);
  }
});
test("fingerprints preserve Unicode exactly, reject unpaired surrogates and bound prompts", () => {
  const value = command("session.rename"); value.payload.title = '貓掌🐾\n"step"\\path\u2028\u2029';
  // Independently spelled tuple freezes JSON escaping and UTF-8 bytes for Rust.
  const tuple = '["stepsemble.command.v1",1,"device-1","session-1","session.rename",[["title","貓掌🐾\\n\\"step\\"\\\\path\u2028\u2029"]]]';
  assert.equal(describeCommand(value).fingerprint, createHash("sha256").update(tuple, "utf8").digest("hex"));
  assert.notEqual(describeCommand({ ...value, payload: { title: "é" } }).fingerprint, describeCommand({ ...value, payload: { title: "e\u0301" } }).fingerprint);
  for (const title of ["\ud800", "\udfff", "x\ud800y", "\udc00x"]) assert.equal(describeCommand({ ...value, payload: { title } }).code, "invalid_payload");
  const start = command("run.start"); start.payload.prompt = "🐾".repeat(262144); assert.equal(describeCommand(start).kind, "binding");
  start.payload.prompt += "x"; assert.equal(describeCommand(start).code, "invalid_payload");
  for (const invalid of [null, [], {}, { ...value, type: "future" }, { ...value, payload: { title: "ok", autoApprove: true } }]) assert.equal(describeCommand(invalid).code, "invalid_payload");
});
test("admission performs domain preflight and creates bounded metadata without raw intent", () => {
  for (const type of Object.keys(fingerprints.digests)) {
    const value = command(type), result = inspectCommand(value, context(type));
    assert.equal(result.kind, "admit", type); assert.equal(domain.checkReceipt(result.receipt).valid, true);
    assert.equal(result.receipt.state, "accepted"); assert.equal(result.receipt.attemptId, null); assert.equal(result.receipt.outcome, null);
    assert.equal(result.receipt.fingerprint, fingerprints.digests[type]);
    for (const text of Object.values(value.payload).filter(text => text.includes(" "))) assert.equal(JSON.stringify(result.receipt).includes(text), false);
    assert.ok(Buffer.byteLength(JSON.stringify(result.receipt)) < 2048);
  }
  assert.deepEqual(inspectCommand(command("run.start"), context()).receipt, states.accepted);
  assert.equal(inspectCommand(command("run.start"), { ...context(), run: seed.run }).code, "run_conflict");
  assert.equal(inspectCommand(command("approval.resolve"), { ...context("approval.resolve"), now: Date.parse(seed.approval.expiresAt) }).code, "approval_expired");
  assert.equal(inspectCommand(command("approval.resolve"), { ...context("approval.resolve"), approval: { ...seed.approval, status: "denied" } }).code, "approval_conflict");
  assert.equal(inspectCommand(command("run.start"), { ...context(), now: now - 1 }).code, "receipt_time_conflict");
});
test("missing authorization, indexed ledger context or corrupted state never falls back to admission", () => {
  const value = command("run.start"), c = context();
  for (const change of [null, {}, { ...c, authorized: false }, { ...c, authenticatedDeviceId: null }]) assert.equal(inspectCommand(value, change).code, "not_authorized");
  assert.equal(inspectCommand(value, { ...c, authenticatedDeviceId: "other" }).code, "device_mismatch");
  assert.equal(inspectCommand(value, { ...c, session: { ...seed.session, sessionId: "other" } }).code, "entity_mismatch");
  for (const key of ["existingReceipt", "commandIdReceipt"]) {
    const missing = { ...c }; delete missing[key]; assert.equal(inspectCommand(value, missing).code, "missing_ledger_context");
    assert.equal(inspectCommand(value, { ...c, [key]: undefined }).code, "missing_ledger_context");
    assert.equal(inspectCommand(value, { ...c, [key]: {} }).code, "invalid_ledger_context");
  }
  for (const time of [NaN, Infinity, -1.5, 8640000000000001, Date.parse("+010000-01-01T00:00:00Z")]) assert.equal(inspectCommand(value, { ...c, now: time }).code, "invalid_payload");
  assert.equal(inspectCommand(value, { ...c, receiptId: "bad\n" }).code, "invalid_payload");
  assert.equal(inspectCommand(value, { ...c, existingReceipt: states.accepted }).code, "invalid_ledger_context", "inconsistent index miss cannot be a new admission");
  assert.equal(inspectCommand(value, { ...c, existingReceipt: states.accepted, commandIdReceipt: { ...states.accepted, fingerprint: "a".repeat(64) } }).code, "invalid_ledger_context");
});
test("same-key replay returns every stored state without reapplying effects or mutation preflight", () => {
  for (const receipt of Object.values(states)) {
    const result = inspectCommand(command("run.start"), { ...context(), session: { ...seed.session, status: "archived" }, run: seed.run, existingReceipt: receipt, commandIdReceipt: receipt });
    assert.equal(result.kind, "replay", receipt.state); assert.deepEqual(result.receipt, receipt); assert.notEqual(result.receipt, receipt);
    const retry = inspectCommand({ ...command("run.start"), commandId: "another-request-id" }, { ...context(), existingReceipt: receipt });
    assert.equal(retry.kind, "replay"); assert.equal(retry.receipt.commandId, "command-1");
    assert.equal(inspectCommand(command("run.start"), { ...context(), authorized: false, existingReceipt: receipt, commandIdReceipt: receipt }).code, "not_authorized");
  }
  const approve = command("approval.resolve"), c = context("approval.resolve"), receipt = inspectCommand(approve, c).receipt;
  assert.equal(inspectCommand(approve, { ...c, now: now + 99999999, approval: { ...seed.approval, status: "approved" }, existingReceipt: receipt, commandIdReceipt: receipt }).kind, "replay");
});
test("changed intent, conflicting command IDs and foreign lookup rows fail explicitly", () => {
  const value = command("run.start"), c = { ...context(), existingReceipt: states.accepted, commandIdReceipt: states.accepted };
  assert.equal(inspectCommand({ ...value, payload: { ...value.payload, prompt: "Different action" } }, c).code, "idempotency_conflict");
  for (const field of ["sessionId", "deviceId", "idempotencyKey", "commandType"]) assert.equal(inspectCommand(value, { ...c, existingReceipt: { ...states.accepted, [field]: field === "commandType" ? "session.rename" : "other" } }).code, "invalid_ledger_context");
  assert.equal(inspectCommand(value, { ...context(), commandIdReceipt: states.accepted }).code, "command_id_conflict");
  assert.equal(inspectCommand(value, { ...c, commandIdReceipt: { ...states.accepted, receiptId: "another-receipt" } }).code, "command_id_conflict");
});
test("receipt shape and semantic fixtures agree in Node, browser and typed SDK parsing", () => {
  for (const fixture of cases) {
    for (const api of [domain, browser.StepsembleProtocol]) assert.equal(api.checkReceipt(fixture.value).valid, fixture.state, fixture.name);
    if (fixture.state) assert.deepEqual(browser.StepsembleClient.parse("commandReceipt", fixture.value), fixture.value);
    else assert.throws(() => browser.StepsembleClient.parse("commandReceipt", fixture.value), error => error.message === "Invalid protocol payload");
  }
});
test("receipt transition matrix never treats a pipe acceptance as native success or permits redispatch", () => {
  const actions = { dispatch: { type: "dispatch", attemptId: "attempt-1" }, reject: { type: "reject", code: "unsupported" },
    pipe_accepted: { type: "pipe_accepted", attemptId: "attempt-1" }, uncertain: { type: "uncertain" }, settle: { type: "settle", attemptId: "attempt-1", outcome } };
  const allowed = { accepted: ["dispatch", "reject"], dispatching: ["pipe_accepted", "uncertain", "settle"], awaiting_confirmation: ["uncertain", "settle"], uncertain: ["settle"], succeeded: [], failed: [] };
  for (const [state, receipt] of Object.entries(states)) for (const [name, action] of Object.entries(actions)) {
    const before = JSON.stringify(receipt), result = move(receipt, action);
    assert.equal(result.kind === "transition", allowed[state].includes(name), `${state} -> ${name}`);
    assert.equal(JSON.stringify(receipt), before, "the proposal never mutates the loaded receipt");
    if (result.kind === "transition") { assert.equal(result.receipt.revision, receipt.revision + 1); assert.equal(result.expectedRevision, receipt.revision); assert.equal(domain.checkReceipt(result.receipt).valid, true); }
  }
  const sent = move(states.dispatching, actions.pipe_accepted).receipt; assert.equal(sent.state, "awaiting_confirmation"); assert.equal(sent.outcome, null);
  const failure = move(states.uncertain, { ...actions.settle, outcome: { ...outcome, status: "failed", code: "not_applied" } }); assert.equal(failure.receipt.state, "failed");
});
test("CAS revision, monotonic host time, attempt binding and verified evidence are mandatory", () => {
  const receipt = states.dispatching, action = { type: "settle", attemptId: "attempt-1", outcome };
  for (const revision of [undefined, 0, 2, 1.1]) assert.equal(move(receipt, action, { expectedRevision: revision }).code, "revision_conflict");
  assert.equal(move({ ...receipt, revision: Number.MAX_SAFE_INTEGER }, action).code, "revision_overflow");
  for (const time of [now - 1, NaN, Infinity]) assert.equal(move(receipt, action, { now: time }).code, "receipt_time_conflict");
  assert.equal(move(receipt, { ...action, attemptId: "another-worker" }).code, "attempt_mismatch");
  for (const value of [null, undefined, { ...outcome, evidence: null }, { ...outcome, evidence: { kind: "pipe_accepted", reference: "pipe-1" } }, { ...outcome, resultReference: "/private/path" }]) assert.equal(move(receipt, { ...action, outcome: value }).kind, "reject");
  for (const value of [null, [], {}, { type: "__proto__" }, { type: "uncertain", autoRetry: true }, { type: "dispatch" }]) assert.equal(move(receipt, value).code, "invalid_action");
});
test("crash recovery quarantines in-flight dispatch and only reconciles the same verified attempt", () => {
  for (const [state, receipt] of Object.entries(states)) {
    const result = recoverReceipt(JSON.parse(JSON.stringify(receipt)), { now: now + 1000, source: "current_store" });
    assert.equal(result.kind, ["dispatching", "awaiting_confirmation"].includes(state) ? "transition" : "retain");
    if (result.kind === "retain") assert.deepEqual(result.receipt, receipt);
    else {
      assert.equal(result.receipt.state, "uncertain"); assert.equal(result.receipt.attemptId, "attempt-1");
      assert.equal(move(result.receipt, { type: "dispatch", attemptId: "retry-2" }).kind, "reject");
      const resolved = move(result.receipt, { type: "settle", attemptId: "attempt-1", outcome });
      assert.equal(resolved.receipt.state, "succeeded");
      assert.equal(recoverReceipt(resolved.receipt, { now: now + 2000, source: "current_store" }).kind, "retain");
    }
  }
});
test("restored or unknown stores cannot treat old accepted receipts as proof of an unsent effect", () => {
  for (const receipt of Object.values(states)) {
    for (const source of ["restored_backup", "unknown"]) {
      const result = recoverReceipt(receipt, { now, source }); assert.equal(result.kind, "reconciliation_required");
      assert.deepEqual(result.receipt, receipt); assert.notEqual(result.receipt, receipt);
    }
    for (const missing of [undefined, {}, { now }, { now, source: "assume_safe" }]) assert.equal(recoverReceipt(receipt, missing).code, "missing_recovery_context");
  }
});
test("a simulated transaction boundary admits one receipt and commits only one dispatch proposal", () => {
  // Deliberately an in-memory contract model, NOT proof of SQLite atomicity or
  // an implementation wired to HTTP. Real storage must enforce these indexes/CAS.
  let stored = null, dispatched = 0;
  const c = context(), value = command("run.start");
  const proposals = [inspectCommand(value, c), inspectCommand(value, { ...c, receiptId: "receipt-2" })];
  const insert = proposal => { if (stored) return false; stored = structuredClone(proposal.receipt); return true; };
  assert.equal(insert(proposals[0]), true); assert.equal(insert(proposals[1]), false);
  assert.equal(inspectCommand(value, { ...c, existingReceipt: stored, commandIdReceipt: stored }).kind, "replay");
  const workers = [move(stored, { type: "dispatch", attemptId: "worker-1" }), move(stored, { type: "dispatch", attemptId: "worker-2" })];
  for (const proposal of workers) if (proposal.expectedRevision === stored.revision) { stored = proposal.receipt; dispatched++; }
  assert.equal(dispatched, 1); assert.equal(stored.attemptId, "worker-1");
  stored = recoverReceipt(JSON.parse(JSON.stringify(stored)), { now: now + 2000, source: "current_store" }).receipt;
  assert.equal(stored.state, "uncertain"); assert.equal(move(stored, { type: "dispatch", attemptId: "worker-3" }).kind, "reject");
});
