"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const tx = require("../protocol/transaction-state");
const { createValidator } = require("../protocol/validator"), { createDomain } = require("../protocol/domain");
const contracts = createValidator(require("../protocol/v1/schema.json")), domain = createDomain(contracts);
const projection = require("../public/modules/projection").create({ ...contracts, ...domain }, require("../public/modules/lifecycle").create({ ...contracts, ...domain }));
const wire = require("../protocol/v1/fixtures/wire.json"), { empty } = require("../protocol/v1/fixtures/projection.cjs");
const at = "2026-09-05T00:00:00.000Z", now = Date.parse(at), clone = value => structuredClone(value);
const command = type => clone(wire.find(row => row.contract === "command" && row.value.type === type).value);
const fact = type => ({ ...clone(wire.find(row => row.contract === "event" && row.value.type === type).value), createdAt: at });
function context(view, more = {}) { return { storeId: view.storeId, storeGeneration: view.storeGeneration, expectedRevision: view.revision, now,
  authorized: true, authenticatedDeviceId: "device-1", receiptId: "receipt-1", eventIds: ["admission-1", "admission-2"], ...more }; }
async function append(state, types) {
  const events = types.map((type, i) => ({ ...(typeof type === "string" ? fact(type) : clone(type)), sequence: state.cursor.sequence + i + 1,
    eventId: `native-${state.cursor.sequence + i + 1}`, sessionId: state.cursor.sessionId, generation: state.cursor.generation }));
  const result = await projection.applyBatch(state, { afterCursor: clone(state.cursor), cursor: { ...state.cursor, sequence: state.cursor.sequence + events.length }, events, hasMore: false });
  assert.equal(result.kind, "apply", result.reason); return result.state;
}
async function view(pending = false) {
  const state = await append(empty, ["session.created", "model.changed", ...(pending ? ["run.starting", "launch_profile.locked", "run.started", "tool.requested", "approval.requested"] : [])]);
  const result = tx.initialView(state, { storeId: "host-store-1", storeGeneration: "store-generation-1" });
  assert.equal(result.kind, "view", result.code); return result.state;
}
function transaction(result) { assert.equal(result.kind, "transaction", result.code); assert.equal(tx.checkView(result.state).kind, "valid"); return result.state; }
async function decided() {
  const s = await view(true); return transaction(await tx.planAdmission(s, command("approval.resolve"), context(s, { eventIds: ["decision-1"] })));
}
async function starting() {
  const s = await view(); return transaction(await tx.planAdmission(s, command("run.start"), context(s)));
}
function dispatch(s, more = {}) { return tx.planDispatch(s, "receipt-1", context(s, { receiptRevision: s.receipts[0].revision, attemptId: "attempt-1", incarnationId: "native-incarnation-1", ...more })); }
function ackContext(s, more = {}) { return context(s, { receiptRevision: s.receipts[0].revision, attemptId: "attempt-1", incarnationId: "native-incarnation-1", evidenceVerified: true,
  evidence: { kind: "native_ack", reference: "proof-1" }, nonce: "nonce-1", nativeRequestId: "native-request-1", eventIds: ["ack-1"], ...more }); }
// Deliberately an in-memory CAS model, not SQL/durability evidence. Every field
// returned by the planner is published together or the proposal is discarded.
function commit(current, proposal) {
  if (proposal.kind !== "transaction") return null;
  const e = proposal.expected;
  return e.storeId === current.storeId && e.storeGeneration === current.storeGeneration && e.revision === current.revision
    && JSON.stringify(e.cursor) === JSON.stringify(current.projection.cursor) ? clone(proposal.state) : null;
}

test("run admission reserves a locked writer, receipt, exact private outbox and two events together", async () => {
  const original = await view(), saved = JSON.stringify(original), cmd = command("run.start"); cmd.futureMetadata = "must-not-reach-native";
  const result = await tx.planAdmission(original, cmd, context(original)), next = transaction(result);
  assert.equal(JSON.stringify(original), saved); assert.equal(next.revision, original.revision + 1);
  assert.deepEqual(result.expected.cursor, original.projection.cursor); assert.equal(result.expected.revision, original.revision);
  assert.deepEqual(result.append.map(e => e.type), ["run.starting", "launch_profile.locked"]);
  assert.equal(next.projection.runs[0].run.state, "starting"); assert.equal(next.projection.runs[0].profileLocked, true);
  assert.equal(next.receipts[0].state, "accepted"); assert.equal(next.outbox[0].dispatch, null);
  assert.equal(next.outbox[0].command.payload.prompt, cmd.payload.prompt); assert.equal(next.outbox[0].command.futureMetadata, undefined);
  assert.equal(JSON.stringify(next.receipts).includes(cmd.payload.prompt), false, "private payload belongs only in outbox, not receipts");
  assert.ok(commit(original, result)); assert.equal(commit(next, result), null);
});
test("two devices with different keys still compete for one writer", async () => {
  const initial = await view(), first = command("run.start"), second = { ...first, deviceId: "device-2", commandId: "command-other", idempotencyKey: "key-other", payload: { ...first.payload, runId: "run-2" } };
  const [a, b] = await Promise.all([tx.planAdmission(initial, first, context(initial)), tx.planAdmission(initial, second, context(initial, { authenticatedDeviceId: "device-2", receiptId: "receipt-2" }))]);
  transaction(a); transaction(b); const current = commit(initial, a); assert.ok(current); assert.equal(commit(current, b), null);
  assert.equal(current.receipts.length, 1); assert.equal(current.outbox.length, 1); assert.equal(current.projection.runs.length, 1);
  const retry = await tx.planAdmission(current, second, context(current, { authenticatedDeviceId: "device-2", receiptId: "receipt-2" })); assert.equal(retry.code, "run_conflict");
});
test("two devices cannot both consume a pending approval or leave a losing outbox", async () => {
  const initial = await view(true), first = command("approval.resolve"), second = { ...first, deviceId: "device-2", commandId: "cmd-2", idempotencyKey: "key-2", payload: { ...first.payload, decision: "denied" } };
  const a = await tx.planAdmission(initial, first, context(initial, { eventIds: ["decision-a"] }));
  const b = await tx.planAdmission(initial, second, context(initial, { authenticatedDeviceId: "device-2", receiptId: "receipt-2", eventIds: ["decision-b"] }));
  const current = commit(initial, a); assert.ok(current); transaction(b); assert.equal(commit(current, b), null);
  assert.equal(current.projection.approvals[0].approval.status, "approved"); assert.equal(current.projection.approvals[0].nativeAcknowledgement, null);
  assert.equal(current.projection.runs[0].run.state, "waiting_approval"); assert.equal(current.outbox.length, 1);
  assert.equal((await tx.planAdmission(current, second, context(current, { authenticatedDeviceId: "device-2", receiptId: "receipt-2", eventIds: ["decision-b"] }))).code, "approval_conflict");
});
test("same-key retry returns the winner after state changed but requires fresh access", async () => {
  const current = await decided(), cmd = command("approval.resolve"), saved = JSON.stringify(current);
  const result = await tx.planAdmission(current, { ...cmd, commandId: "diagnostic-retry" }, context(current, { eventIds: [] }));
  assert.equal(result.kind, "replay"); assert.deepEqual(result.receipt, current.receipts[0]); assert.equal(JSON.stringify(current), saved);
  assert.equal((await tx.planAdmission(current, cmd, context(current, { authorized: false }))).code, "not_authorized");
  assert.equal((await tx.planAdmission(current, { ...cmd, payload: { ...cmd.payload, decision: "denied" } }, context(current))).code, "idempotency_conflict");
});
test("bad final journal fact, reused event ID or invalid context never exposes partial admission", async () => {
  const initial = await view(), saved = JSON.stringify(initial);
  for (const more of [{ eventIds: ["one"] }, { eventIds: ["same", "same"] }, { eventIds: ["native-1", "new"] }, { eventIds: ["valid", "bad\n"] },
    { expectedRevision: 1 }, { storeId: "other" }, { storeGeneration: "other" }, { now: now - 1 }, { authorized: false }, { receiptId: "bad\n" }]) {
    const result = await tx.planAdmission(initial, command("run.start"), context(initial, more)); assert.equal(result.kind, "reject", JSON.stringify(more)); assert.equal(JSON.stringify(initial), saved);
  }
  const archived = clone(initial); archived.projection = await append(archived.projection, ["session.archived"]);
  assert.equal((await tx.planAdmission(archived, command("run.start"), context(archived))).code, "session_conflict");
});
test("store row corruption, mismatched outbox intent and dangling receipts fail closed", async () => {
  const current = await decided();
  const mutations = [s => s.receipts.push(clone(s.receipts[0])), s => s.outbox.push(clone(s.outbox[0])), s => s.receipts[0] = null,
    s => s.outbox[0].command.payload.decision = "denied", s => s.outbox[0].command.future = true,
    s => s.projection.approvals[0].resolutionReceiptId = "missing", s => s.receipts[0].commandId = "foreign",
    s => s.receipts[0].sessionId = "foreign", s => s.outbox[0].dispatch = { attemptId: "attempt-1", incarnationId: "native-1" }];
  for (const mutate of mutations) { const broken = clone(current); mutate(broken); assert.equal(tx.checkView(broken).kind, "reject"); }
  let invoked = 0; const getter = clone(current); Object.defineProperty(getter, "outbox", { get() { invoked++; } });
  assert.equal(tx.checkView(getter).kind, "reject"); assert.equal(invoked, 0);
  assert.equal(tx.initialView(empty, { storeId: "a", storeGeneration: "b" }).kind, "reject");
});
test("dispatch marker is one owned attempt and does not itself send or confirm anything", async () => {
  const original = await decided(), first = dispatch(original), second = dispatch(original, { attemptId: "attempt-2" });
  const current = transaction(first); transaction(second); assert.ok(commit(original, first)); assert.equal(commit(current, second), null);
  assert.equal(current.receipts[0].state, "dispatching"); assert.equal(current.outbox[0].dispatch.incarnationId, "native-incarnation-1");
  assert.equal(current.projection.approvals[0].nativeAcknowledgement, null); assert.equal(current.projection.runs[0].run.state, "waiting_approval");
  assert.equal(first.sent, undefined); assert.equal(first.append.length, 0); assert.equal(first.expected.cursor.sequence, current.projection.cursor.sequence);
  assert.equal(dispatch(original, { authorized: false }).code, "not_authorized");
  assert.equal(dispatch(original, { authenticatedDeviceId: "device-2" }).code, "device_mismatch");
  assert.equal(dispatch(original, { receiptRevision: 1 }).code, "revision_conflict");
  assert.equal(dispatch(original, { now: now + 600000 }).code, "approval_expired");
  assert.equal(dispatch(current, { attemptId: "attempt-2", receiptRevision: 1 }).code, "receipt_state_conflict");
});
test("pipe acceptance is not native ACK; correlated ACK settles receipt and approval in one proposal", async () => {
  let current = transaction(dispatch(await decided()));
  current = transaction(tx.planPipeAccepted(current, "receipt-1", context(current, { receiptRevision: 1, attemptId: "attempt-1", incarnationId: "native-incarnation-1" })));
  assert.equal(current.receipts[0].state, "awaiting_confirmation"); assert.equal(current.projection.approvals[0].nativeAcknowledgement, null);
  const original = clone(current), result = await tx.planApprovalAcknowledgement(current, "receipt-1", ackContext(current)); current = transaction(result);
  assert.equal(current.receipts[0].state, "succeeded"); assert.equal(current.projection.approvals[0].nativeAcknowledgement.receiptId, "receipt-1");
  assert.equal(current.projection.approvals[0].nativeAcknowledgement.attemptId, "attempt-1"); assert.equal(result.append.length, 1);
  assert.equal(current.projection.runs[0].run.state, "waiting_approval", "ACK is not run resume");
  assert.deepEqual(result.expected.cursor, original.projection.cursor);
  assert.equal((await tx.planApprovalAcknowledgement(current, "receipt-1", ackContext(current))).code, "receipt_state_conflict");
});
test("wrong nonce, request, attempt, incarnation, proof and stale revision cannot confirm a receipt", async () => {
  const current = transaction(dispatch(await decided())), saved = JSON.stringify(current);
  for (const more of [{ evidenceVerified: false }, { evidence: { kind: "pipe_accepted", reference: "pipe-1" } }, { nonce: "nonce-2" }, { nativeRequestId: "request-other" },
    { attemptId: "attempt-2" }, { incarnationId: "native-incarnation-2" }, { receiptRevision: 0 }, { expectedRevision: 0 }, { eventIds: ["native-1"] }]) {
    assert.equal((await tx.planApprovalAcknowledgement(current, "receipt-1", ackContext(current, more))).kind, "reject"); assert.equal(JSON.stringify(current), saved);
  }
  assert.equal(tx.planPipeAccepted(current, "receipt-1", context(current, { receiptRevision: 1, attemptId: "attempt-1", incarnationId: "wrong" })).code, "attempt_mismatch");
});
test("late verified ACK after run terminal remains a delivery fact and never revives a writer", async () => {
  const current = transaction(dispatch(await decided()));
  current.projection = await append(current.projection, ["run.interrupted"]);
  assert.equal(tx.checkView(current).kind, "valid");
  const next = transaction(await tx.planApprovalAcknowledgement(current, "receipt-1", ackContext(current, { authorized: false })));
  assert.equal(next.projection.runs[0].run.state, "interrupted"); assert.equal(next.receipts[0].state, "succeeded");
});
test("current-store recovery atomically marks uncertain delivery and retains an orphaned writer", async () => {
  const current = transaction(dispatch(await decided()));
  const recovered = transaction(await tx.planRecovery(current, context(current, { source: "current_store", eventIds: ["orphan-1"] })));
  assert.equal(recovered.receipts[0].state, "uncertain"); assert.equal(recovered.projection.runs[0].run.state, "orphaned");
  assert.equal(dispatch(recovered, { receiptRevision: 2, attemptId: "another" }).kind, "reject");
  const acknowledged = transaction(await tx.planApprovalAcknowledgement(recovered, "receipt-1", ackContext(recovered)));
  assert.equal(acknowledged.receipts[0].state, "succeeded"); assert.equal(acknowledged.projection.runs[0].run.state, "orphaned");
});
test("backup/unknown recovery quarantines even an old accepted row and has no automatic unquarantine", async () => {
  const original = await decided();
  for (const source of ["restored_backup", "unknown"]) {
    const recovered = transaction(await tx.planRecovery(original, context(original, { source })));
    assert.equal(recovered.quarantined, true); assert.equal(recovered.receipts[0].state, "accepted"); assert.equal(dispatch(recovered).code, "store_recovery_required");
    assert.equal((await tx.planAdmission(recovered, command("approval.resolve"), context(recovered))).kind, "replay", "read-only receipt replay still needs grants");
    const kept = transaction(await tx.planRecovery(recovered, context(recovered, { source: "current_store", eventIds: ["orphan-1"] })));
    assert.equal(kept.quarantined, true);
  }
  assert.equal((await tx.planRecovery(original, context(original))).code, "missing_recovery_context");
});
test("async planners capture their original store/cursor read set before callers mutate inputs", async () => {
  const initial = await view(), expected = clone(initial), cmd = command("run.start"), c = context(initial);
  const pending = tx.planAdmission(initial, cmd, c);
  initial.revision = 999; initial.storeGeneration = "wrong"; initial.projection.cursor.sequence = 1000; cmd.payload.prompt = "mutated"; c.eventIds.length = 0;
  const result = await pending, next = transaction(result);
  assert.equal(result.expected.revision, expected.revision); assert.deepEqual(result.expected.cursor, expected.projection.cursor);
  assert.equal(result.expected.storeGeneration, expected.storeGeneration); assert.equal(next.outbox[0].command.payload.prompt, "Synthetic prompt");
  assert.ok(commit(expected, result));
});
test("run start ACK atomically confirms delivery and starts the locked run, not the whole coding turn", async () => {
  const current = transaction(dispatch(await starting()));
  const result = await tx.planRunStartAcknowledgement(current, "receipt-1", ackContext(current, { runId: "run-1", nativeRunId: "native-run-1", eventIds: ["started-1"] }));
  const next = transaction(result);
  assert.equal(next.receipts[0].state, "succeeded"); assert.equal(next.projection.runs[0].run.state, "running");
  assert.equal(next.projection.runs[0].nativeRunId, "native-run-1"); assert.equal(next.projection.runs[0].finishedAt, null);
  assert.deepEqual(result.append.map(e => e.type), ["run.started"]); assert.deepEqual(result.expected.cursor, current.projection.cursor);
  assert.equal((await tx.planRunStartAcknowledgement(next, "receipt-1", ackContext(next, { runId: "run-1", nativeRunId: "native-run-1" }))).code, "receipt_state_conflict");
});
test("a late start ACK never turns orphaned/stopping/terminal state into running", async () => {
  for (const type of ["run.orphaned", "run.stopping", "run.interrupted"]) {
    const current = transaction(dispatch(await starting())); current.projection = await append(current.projection, [type]);
    const saved = JSON.stringify(current);
    assert.equal((await tx.planRunStartAcknowledgement(current, "receipt-1", ackContext(current, { runId: "run-1", nativeRunId: "native-run-1", eventIds: ["started-1"] }))).code, "reconciliation_required");
    assert.equal(JSON.stringify(current), saved);
  }
  const known = transaction(dispatch(await starting())); known.projection = await append(known.projection, ["run.started", "run.interrupted"]);
  const next = transaction(await tx.planRunStartAcknowledgement(known, "receipt-1", ackContext(known, { runId: "run-1", nativeRunId: null, eventIds: [] })));
  assert.equal(next.projection.runs[0].run.state, "interrupted"); assert.equal(next.receipts[0].state, "succeeded");
});
test("pre-dispatch rejection releases only a provably unsent starting writer and retains its tombstone", async () => {
  const current = await starting(), result = await tx.planRejectBeforeDispatch(current, "receipt-1", context(current, { source: "current_store", receiptRevision: 0, code: "grant_revoked", eventIds: ["failed-1"] }));
  const next = transaction(result);
  assert.equal(next.receipts[0].state, "failed"); assert.equal(next.receipts[0].attemptId, null); assert.equal(next.receipts[0].outcome.evidence, null);
  assert.equal(next.projection.runs[0].run.state, "failed"); assert.equal(next.projection.runs[0].startedAt, null); assert.equal(next.outbox[0].dispatch, null);
  const retry = await tx.planAdmission(next, command("run.start"), context(next)); assert.equal(retry.kind, "replay"); assert.equal(retry.receipt.state, "failed");
  const other = command("run.start"); other.payload.runId = "run-2"; other.commandId = "command-2"; other.idempotencyKey = "key-2";
  const resumed = transaction(await tx.planAdmission(next, other, context(next, { receiptId: "receipt-2", eventIds: ["second-start", "second-lock"] })));
  assert.equal(resumed.receipts.length, 2); assert.equal(resumed.projection.runs[1].run.state, "starting");
});
test("rejection cannot reinterpret a dispatched or backup-accepted effect as definitely unsent", async () => {
  const initial = await starting(), c = s => context(s, { source: "current_store", receiptRevision: s.receipts[0].revision, code: "cancelled", eventIds: ["failed-1"] });
  const dispatched = transaction(dispatch(initial));
  assert.equal((await tx.planRejectBeforeDispatch(dispatched, "receipt-1", c(dispatched))).code, "receipt_state_conflict");
  for (const source of ["unknown", "restored_backup"]) {
    assert.equal((await tx.planRejectBeforeDispatch(initial, "receipt-1", { ...c(initial), source })).code, "missing_recovery_context");
    const restored = transaction(await tx.planRecovery(initial, context(initial, { source })));
    assert.equal((await tx.planRejectBeforeDispatch(restored, "receipt-1", c(restored))).code, "store_recovery_required");
  }
  const approval = await decided(), result = transaction(await tx.planRejectBeforeDispatch(approval, "receipt-1", c(approval)));
  assert.equal(result.projection.approvals[0].approval.status, "approved"); assert.equal(result.projection.approvals[0].nativeAcknowledgement, null);
  assert.equal(result.projection.runs[0].run.state, "waiting_approval", "delivery rejection is neither decision reversal nor native resume");
});
test("verified native non-application settles failure; unknown delivery stays uncertain with its writer", async () => {
  const current = transaction(dispatch(await starting())), c = s => ackContext(s, { runId: "run-1", effect: "not_applied", code: "native_rejected", eventIds: ["failed-1"] });
  const uncertain = transaction(await tx.planDeliveryUncertain(current, "receipt-1", { ...c(current), eventIds: ["lost-1"] }));
  assert.equal(uncertain.receipts[0].state, "uncertain"); assert.equal(uncertain.projection.runs[0].run.state, "orphaned");
  assert.equal(uncertain.outbox[0].dispatch.attemptId, "attempt-1"); assert.equal(dispatch(uncertain, { attemptId: "again" }).kind, "reject");
  assert.equal((await tx.planNativeFailure(uncertain, "receipt-1", { ...c(uncertain), effect: "unknown" })).code, "evidence_mismatch");
  assert.equal((await tx.planNativeFailure(uncertain, "receipt-1", { ...c(uncertain), evidenceVerified: false })).code, "evidence_mismatch");
  const failed = transaction(await tx.planNativeFailure(uncertain, "receipt-1", c(uncertain)));
  assert.equal(failed.receipts[0].state, "failed"); assert.equal(failed.projection.runs[0].run.state, "failed");
  const approval = transaction(dispatch(await decided()));
  const rejected = transaction(await tx.planNativeFailure(approval, "receipt-1", c(approval)));
  assert.equal(rejected.receipts[0].state, "failed"); assert.equal(rejected.projection.approvals[0].nativeAcknowledgement, null);
});
test("corrupt or stale final failure proposals cannot partially release a writer", async () => {
  const current = transaction(dispatch(await starting())), saved = JSON.stringify(current);
  for (const more of [{ eventIds: ["native-1"] }, { receiptRevision: 0 }, { runId: "wrong" }, { incarnationId: "wrong" }, { code: "bad\n" }]) {
    const result = await tx.planNativeFailure(current, "receipt-1", ackContext(current, { runId: "run-1", effect: "not_applied", code: "failed", eventIds: ["failed-1"], ...more }));
    assert.equal(result.kind, "reject"); assert.equal(JSON.stringify(current), saved);
  }
  const started = clone(current); started.projection = await append(started.projection, ["run.started"]);
  assert.equal((await tx.planNativeFailure(started, "receipt-1", ackContext(started, { runId: "run-1", effect: "not_applied", code: "model_error", eventIds: ["failed-1"] }))).code, "reconciliation_required");
});
function dispatchReceipt(s, receiptId) {
  const receipt = s.receipts.find(row => row.receiptId === receiptId);
  return tx.planDispatch(s, receiptId, context(s, { receiptRevision: receipt.revision, attemptId: `attempt-${receiptId}`, incarnationId: "native-incarnation-1" }));
}
function operationContext(s, receiptId, more = {}) {
  const receipt = s.receipts.find(row => row.receiptId === receiptId);
  return context(s, { receiptRevision: receipt.revision, attemptId: `attempt-${receiptId}`, incarnationId: "native-incarnation-1", evidenceVerified: true,
    evidence: { kind: "authoritative_readback", reference: `proof-${receiptId}` }, eventIds: [`effect-${receiptId}`], ...more });
}
async function admitOperation(s, type, more = {}) { return tx.planAdmission(s, command(type), context(s, { eventIds: [], ...more })); }
test("rename is confirmed metadata, not an optimistic mutation or two unordered pending names", async () => {
  let s = await view(true), result = await admitOperation(s, "session.rename"); s = transaction(result);
  assert.equal(s.projection.session.title, null); assert.equal(result.append.length, 0);
  const other = command("session.rename"); other.commandId = "rename-2"; other.idempotencyKey = "rename-key-2"; other.payload.title = "Other title";
  assert.equal((await tx.planAdmission(s, other, context(s, { eventIds: [], receiptId: "receipt-2" }))).code, "maintenance_conflict");
  s = transaction(dispatchReceipt(s, "receipt-1"));
  assert.equal((await tx.planOperationAcknowledgement(s, "receipt-1", operationContext(s, "receipt-1", { title: "wrong" }))).code, "evidence_mismatch");
  s = transaction(await tx.planOperationAcknowledgement(s, "receipt-1", operationContext(s, "receipt-1", { title: "Updated title" })));
  assert.equal(s.projection.session.title, "Updated title"); assert.equal(s.projection.runs[0].run.state, "waiting_approval");
});
test("model reservation freezes exact profile and blocks a concurrent start until confirmed", async () => {
  const initial = await view(), profile = { ...initial.projection.session.launchProfile, modelId: "another-model" };
  const changed = command("model.change"); changed.payload.launchProfileId = "profile-2"; profile.launchProfileId = "profile-2";
  let s = transaction(await tx.planAdmission(initial, changed, context(initial, { eventIds: [], launchProfile: profile })));
  assert.equal(s.projection.session.launchProfile.modelId, null); assert.equal(s.outbox[0].operation.launchProfile.modelId, "another-model");
  profile.modelId = "caller-mutated"; assert.equal(s.outbox[0].operation.launchProfile.modelId, "another-model");
  assert.equal((await tx.planAdmission(s, command("run.start"), context(s, { receiptId: "receipt-2" }))).code, "maintenance_conflict");
  s = transaction(dispatchReceipt(s, "receipt-1")); const selected = clone(s.outbox[0].operation.launchProfile);
  s = transaction(await tx.planOperationAcknowledgement(s, "receipt-1", operationContext(s, "receipt-1", { launchProfile: selected })));
  assert.equal(s.projection.session.launchProfile.modelId, "another-model");
  assert.equal((await tx.planAdmission(s, changed, context(s, { eventIds: [] }))).kind, "replay", "replay must not need the profile catalog again");
  const routed = { ...selected, launchProfileId: "profile-3", authMode: "api_key", billingMode: "metered", credentialReference: "key-ref" };
  const routeCommand = { ...changed, commandId: "model-3", idempotencyKey: "key-3", payload: { launchProfileId: "profile-3" } };
  assert.equal((await tx.planAdmission(s, routeCommand, context(s, { eventIds: [], receiptId: "receipt-3", launchProfile: routed }))).code, "fork_required");
});
test("archive and restore reserve exact identities and update only after confirmed effects", async () => {
  let s = await view(); s = transaction(await admitOperation(s, "session.archive", { archiveId: "archive-1" }));
  assert.equal(s.projection.session.session.status, "active");
  assert.equal((await tx.planAdmission(s, command("run.start"), context(s, { receiptId: "receipt-2" }))).code, "maintenance_conflict");
  s = transaction(dispatchReceipt(s, "receipt-1"));
  assert.equal((await tx.planOperationAcknowledgement(s, "receipt-1", operationContext(s, "receipt-1", { archiveId: "foreign" }))).code, "evidence_mismatch");
  s = transaction(await tx.planOperationAcknowledgement(s, "receipt-1", operationContext(s, "receipt-1", { archiveId: "archive-1" })));
  assert.equal(s.projection.session.session.status, "archived");
  s = transaction(await admitOperation(s, "session.restore", { receiptId: "receipt-2" })); assert.equal(s.projection.session.session.status, "archived");
  s = transaction(dispatchReceipt(s, "receipt-2"));
  s = transaction(await tx.planOperationAcknowledgement(s, "receipt-2", operationContext(s, "receipt-2", { archiveId: "archive-1" })));
  assert.equal(s.projection.session.session.status, "active"); assert.equal(s.projection.session.archiveId, null);
  const archive = command("session.archive"); archive.idempotencyKey = "archive-key-2"; archive.commandId = "archive-2";
  assert.equal((await tx.planAdmission(s, archive, context(s, { receiptId: "receipt-3", eventIds: [], archiveId: "archive-1" }))).code, "archive_conflict");
});
test("compact requires an explicit known context owner and an exclusive receipt, preserving unknown limit", async () => {
  const idle = await view(); assert.equal((await admitOperation(idle, "context.compact")).code, "context_unavailable");
  const current = await view(); current.projection = await append(current.projection, ["run.starting", "launch_profile.locked", "run.started", "run.completed"]);
  assert.equal((await admitOperation(current, "context.compact")).code, "context_unavailable", "never guess a context owner from array order");
  let s = transaction(await admitOperation(current, "context.compact", { targetRunId: "run-1" }));
  assert.equal(s.projection.contexts.length, 0); s = transaction(dispatchReceipt(s, "receipt-1"));
  assert.equal((await tx.planOperationAcknowledgement(s, "receipt-1", operationContext(s, "receipt-1", { runId: "foreign", beforeTokens: 100, afterTokens: 20 }))).code, "evidence_mismatch");
  s = transaction(await tx.planOperationAcknowledgement(s, "receipt-1", operationContext(s, "receipt-1", { runId: "run-1", beforeTokens: 100, afterTokens: 20 })));
  assert.equal(s.projection.contexts[0].usedTokens, 20); assert.equal(s.projection.contexts[0].limitTokens, null);
  assert.equal(s.projection.runs[0].run.state, "completed");
});
test("interrupt intent, delivery acknowledgement and terminal run remain separate; manual new retry has a new key", async () => {
  let s = await view(true); s = transaction(await admitOperation(s, "run.interrupt", { eventIds: ["stop-1"] }));
  assert.equal(s.projection.runs[0].run.state, "stopping"); assert.equal(s.projection.approvals[0].approval.status, "pending");
  s = transaction(await tx.planRejectBeforeDispatch(s, "receipt-1", context(s, { source: "current_store", receiptRevision: 0, code: "not_sent", eventIds: [] })));
  assert.equal(s.projection.runs[0].run.state, "stopping");
  const again = command("run.interrupt"); again.commandId = "stop-cmd-2"; again.idempotencyKey = "stop-key-2";
  const admitted = await tx.planAdmission(s, again, context(s, { receiptId: "receipt-2", eventIds: [] })); s = transaction(admitted); assert.equal(admitted.append.length, 0);
  s = transaction(dispatchReceipt(s, "receipt-2"));
  const result = await tx.planOperationAcknowledgement(s, "receipt-2", operationContext(s, "receipt-2", { runId: "run-1", eventIds: [] })); s = transaction(result);
  assert.equal(s.projection.runs[0].run.state, "stopping"); assert.equal(s.receipts[1].state, "succeeded"); assert.equal(result.append.length, 0);
});
test("uncertain maintenance retains exclusion and even valid local effects require correlated evidence", async () => {
  let s = await view(); s = transaction(await admitOperation(s, "session.archive", { archiveId: "archive-1" })); s = transaction(dispatchReceipt(s, "receipt-1"));
  s = transaction(await tx.planDeliveryUncertain(s, "receipt-1", operationContext(s, "receipt-1", { eventIds: [] })));
  assert.equal(s.receipts[0].state, "uncertain"); assert.equal(s.projection.session.session.status, "active");
  assert.equal((await tx.planAdmission(s, command("run.start"), context(s, { receiptId: "receipt-2" }))).code, "maintenance_conflict");
  for (const more of [{ evidenceVerified: false }, { incarnationId: "wrong" }, { attemptId: "wrong" }, { evidence: { kind: "pipe_accepted", reference: "p" } }, { eventIds: ["native-1"] }]) {
    assert.equal((await tx.planOperationAcknowledgement(s, "receipt-1", operationContext(s, "receipt-1", { archiveId: "archive-1", ...more }))).kind, "reject");
  }
  const confirmed = transaction(await tx.planOperationAcknowledgement(s, "receipt-1", operationContext(s, "receipt-1", { archiveId: "archive-1", evidence: { kind: "host_commit", reference: "archive-proof" } })));
  assert.equal(confirmed.projection.session.session.status, "archived");
});
test("simultaneous start and exclusive maintenance share the same revision fence", async () => {
  const initial = await view(), start = await tx.planAdmission(initial, command("run.start"), context(initial));
  const archive = await admitOperation(initial, "session.archive", { archiveId: "archive-1" }); transaction(start); transaction(archive);
  const started = commit(initial, start); assert.equal(commit(started, archive), null);
  const archived = commit(initial, archive); assert.equal(commit(archived, start), null);
  const unknownOp = clone(archived); unknownOp.outbox[0].operation.autoApprove = true; assert.equal(tx.checkView(unknownOp).kind, "reject");
});
function terminalContext(s, type, more = {}) {
  return context(s, { source: "current_store", runtimeVerified: true, evidenceVerified: true, sessionId: "session-1", runId: "run-1",
    nativeRunId: s.projection.runs[0].nativeRunId, incarnationId: "native-incarnation-1", evidence: { kind: "authoritative_readback", reference: "terminal-proof" },
    type, payload: fact(type).payload, eventIds: ["cancel-1", "terminal-1"], ...more });
}
test("verified terminal fact cancels pending approvals and preserves partial tool history in one transaction", async () => {
  for (const type of ["run.completed", "run.failed", "run.interrupted"]) {
    const s = await view(true), saved = JSON.stringify(s);
    const result = await tx.planRunTerminal(s, "run-1", terminalContext(s, type)), next = transaction(result);
    assert.equal(JSON.stringify(s), saved); assert.deepEqual(result.append.map(row => row.type), ["approval.cancelled", type]);
    assert.equal(next.projection.approvals[0].approval.status, "cancelled"); assert.equal(next.projection.tools[0].status, "incomplete");
    assert.equal(next.projection.runs[0].run.state, type.slice(4)); assert.equal(result.proof.evidence.reference, "terminal-proof");
    assert.equal((await tx.planRunTerminal(next, "run-1", terminalContext(next, type))).code, "run_conflict");
  }
  const expired = await view(true), done = transaction(await tx.planRunTerminal(expired, "run-1", terminalContext(expired, "run.interrupted", { now: now + 600000 })));
  assert.equal(done.projection.approvals[0].approval.status, "expired");
});
test("terminal cleanup rejects only unsent commands and leaves attempted delivery uncertain, never assumes stop caused completion", async () => {
  for (const attempted of [false, true]) {
    let s = await decided(); if (attempted) s = transaction(dispatch(s));
    const next = transaction(await tx.planRunTerminal(s, "run-1", terminalContext(s, "run.completed", { eventIds: ["terminal-1"] })));
    assert.equal(next.receipts[0].state, attempted ? "uncertain" : "failed");
    assert.equal(next.projection.approvals[0].approval.status, "approved"); assert.equal(next.projection.approvals[0].nativeAcknowledgement, null);
    assert.equal(next.projection.runs[0].run.state, "completed");
  }
  let s = await view(true); s = transaction(await admitOperation(s, "run.interrupt", { eventIds: ["stop-1"] })); s = transaction(dispatchReceipt(s, "receipt-1"));
  const next = transaction(await tx.planRunTerminal(s, "run-1", terminalContext(s, "run.completed")));
  assert.equal(next.receipts[0].state, "uncertain", "natural completion is not proof the interrupt command took effect");
});
test("a terminal cleanup from an old backup keeps accepted ambiguity quarantined", async () => {
  let s = await decided(); s = transaction(await tx.planRecovery(s, context(s, { source: "restored_backup" })));
  const next = transaction(await tx.planRunTerminal(s, "run-1", terminalContext(s, "run.interrupted", { source: "restored_backup", eventIds: ["terminal-1"] })));
  assert.equal(next.quarantined, true); assert.equal(next.receipts[0].state, "accepted"); assert.equal(next.projection.runs[0].run.state, "interrupted");
});
test("bad runtime proof or final event rolls back cancellations, receipt cleanup and terminal history together", async () => {
  const s = await view(true), saved = JSON.stringify(s);
  for (const more of [{ runtimeVerified: false }, { evidenceVerified: false }, { sessionId: "foreign" }, { nativeRunId: "foreign" },
    { source: "unknown" }, { payload: { reason: "invalid" } }, { eventIds: ["cancel-1", "native-1"] }, { expectedRevision: 99 }]) {
    assert.equal((await tx.planRunTerminal(s, "run-1", terminalContext(s, "run.interrupted", more))).kind, "reject"); assert.equal(JSON.stringify(s), saved);
  }
});
test("owned normalized observations atomically project history and pending requests with Host-assigned envelope", async () => {
  let s = await view(); s.projection = await append(s.projection, ["run.starting", "launch_profile.locked", "run.started"]);
  const observed = [fact("message.delta"), fact("tool.requested"), fact("approval.requested")].map(e => ({ type: e.type, payload: e.payload }));
  const c = context(s, { runtimeVerified: true, sessionId: "session-1", runId: "run-1", incarnationId: "native-1", eventIds: ["text-1", "tool-1", "request-1"] });
  const result = await tx.planObservedEvents(s, observed, c), next = transaction(result);
  assert.equal(next.projection.approvals[0].approval.status, "pending"); assert.equal(next.projection.runs[0].run.state, "waiting_approval");
  assert.equal(next.projection.messages.length, 1); assert.equal(next.receipts.length, 0); assert.equal(result.source.incarnationId, "native-1");
  assert.equal(result.append[0].createdAt, at); assert.equal(result.append[0].sequence, s.projection.cursor.sequence + 1);
  for (const more of [{ runtimeVerified: false }, { sessionId: "foreign" }, { runId: "foreign" }]) assert.equal((await tx.planObservedEvents(s, observed, { ...c, ...more })).code, "evidence_mismatch");
});
test("observation input cannot smuggle winners/ACK/terminal events or override scope/cursor/time", async () => {
  const s = await view(true), c = context(s, { runtimeVerified: true, sessionId: "session-1", runId: "run-1", incarnationId: "native-1", eventIds: ["fact-1"] });
  for (const type of ["approval.resolved", "approval.acknowledged", "run.interrupted", "model.changed", "session.updated", "run.starting"]) {
    assert.equal((await tx.planObservedEvents(s, [{ type, payload: fact(type).payload }], c)).code, "unsupported_observation");
  }
  for (const extra of [{ sequence: 1 }, { createdAt: at }, { runId: "foreign" }, { sessionId: "foreign" }]) {
    assert.equal((await tx.planObservedEvents(s, [{ type: "message.delta", payload: fact("message.delta").payload, ...extra }], c)).code, "unsupported_observation");
  }
  const saved = JSON.stringify(s);
  const result = await tx.planObservedEvents(s, [{ type: "message.delta", payload: fact("message.delta").payload }, { type: "tool.started", payload: { toolId: "missing" } }], { ...c, eventIds: ["text-1", "bad-tool"] });
  assert.equal(result.kind, "reject"); assert.equal(JSON.stringify(s), saved);
  assert.equal((await tx.planObservedEvents(s, [{ type: "run.resumed", payload: fact("run.resumed").payload }], c)).code, "evidence_mismatch");
});
