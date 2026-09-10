const test = require("node:test");
const assert = require("node:assert/strict");
const { createConnectorApprovalState } = require("../server/connector-approval");

const sourceEvent = (overrides = {}) => ({
  type: "approval.requested",
  sessionId: "session-1",
  runId: "run-1",
  nativeEventId: "native-event-1",
  createdAt: "2026-09-10T00:00:00.000Z",
  payload: {
    approval: {
      approvalId: "approval-1",
      sessionId: "session-1",
      runId: "run-1",
      status: "pending",
      scope: "once",
      expiresAt: "2026-09-10T00:10:00.000Z",
      request: { summary: "Run the synthetic formatter" },
      createdAt: "2026-09-10T00:00:00.000Z",
      nonce: "nonce-1",
      toolId: "tool-1",
      nativeRequestId: "native-request-1",
    },
  },
  ...overrides,
});

const sourceWithApproval = (approvalOverrides = {}, eventOverrides = {}) => sourceEvent({
  ...eventOverrides,
  payload: { approval: { ...sourceEvent().payload.approval, ...approvalOverrides } },
});

const decision = (overrides = {}) => ({
  commandId: "command-1",
  deviceId: "device-1",
  sessionId: "session-1",
  runId: "run-1",
  approvalId: "approval-1",
  nonce: "nonce-1",
  scope: "once",
  decision: "approved",
  idempotencyKey: "approval-key-1",
  ...overrides,
});

function state(overrides = {}) {
  return createConnectorApprovalState({
    taskId: "task-1",
    agentId: "claude-code",
    now: () => Date.parse("2026-09-10T00:01:00.000Z"),
    receiptId: () => "receipt-1",
    ...overrides,
  });
}

test("generic connector approval observation is bounded, correlated and idempotent", () => {
  const approvals = state();
  const first = approvals.observe({ event: sourceEvent() });
  assert.equal(first.kind, "observed");
  assert.equal(first.approval.approval.status, "pending");
  assert.equal(first.approval.resolutionReceiptId, null);
  assert.deepEqual(first.event.authority, { sourceAuthenticated: false, approvalAcknowledged: false, resumeAllowed: false });

  const duplicate = approvals.observe({ event: sourceEvent() });
  assert.equal(duplicate.kind, "duplicate");
  assert.equal(approvals.snapshot().approvals.length, 1);
  assert.equal(approvals.observe({ taskId: "foreign-task", event: sourceEvent() }).code, "approval_conflict");

  const changed = approvals.observe({ event: sourceEvent({ nativeEventId: "native-event-2" }) });
  assert.equal(changed.code, "approval_conflict");
  const sameNonce = approvals.observe({ event: sourceWithApproval({ approvalId: "approval-2" }, { nativeEventId: "native-event-2" }) });
  assert.equal(sameNonce.code, "approval_conflict");
  assert.equal(approvals.snapshot().receipts.length, 0);
});

test("resolve produces one accepted receipt and private outbox without native ACK or resume", () => {
  const approvals = state();
  approvals.observe({ event: sourceEvent() });
  const result = approvals.resolve(decision());
  assert.equal(result.kind, "admit");
  assert.equal(result.receipt.commandType, "approval.resolve");
  assert.equal(result.receipt.state, "accepted");
  assert.equal(result.receipt.revision, 0);
  assert.equal(result.receipt.outcome, null);
  assert.equal(result.receipt.attemptId, null);
  assert.equal(result.approval.approval.status, "approved");
  assert.equal(result.approval.resolutionReceiptId, "receipt-1");
  assert.equal(result.approval.nativeAcknowledgement, null);
  assert.equal(result.nativeAcknowledged, false);
  assert.equal(result.resumeAllowed, false);
  assert.equal(result.event.payload.nativeAcknowledged, false);
  assert.equal(result.outbox.dispatch, null);
  assert.equal(result.outbox.command.payload.approvalId, "approval-1");
  assert.equal(result.receipt.prompt, undefined, "receipt never stores the original prompt");
  assert.equal(result.receipt.outcome, null, "a decision is not native delivery evidence");

  const replay = approvals.resolve(decision({ commandId: "diagnostic-retry" }));
  assert.equal(replay.kind, "replay");
  assert.deepEqual(replay.receipt, result.receipt);
  assert.equal(approvals.snapshot().receipts.length, 1);
  assert.equal(approvals.snapshot().approvals[0].approval.status, "approved");
  assert.equal(approvals.resolve(decision({ nonce: "changed-nonce" })).code, "idempotency_conflict", "same idempotency key with changed correlation is not a replay");
});

test("approval winner, exact correlation and expiry fail closed", () => {
  const approvals = state();
  approvals.observe({ event: sourceEvent() });
  assert.equal(approvals.resolve(decision({ nonce: "other" })).code, "approval_conflict");
  assert.equal(approvals.resolve(decision({ sessionId: "foreign" })).code, "approval_conflict");
  const approved = approvals.resolve(decision());
  assert.equal(approved.kind, "admit");
  assert.equal(approvals.resolve(decision({ decision: "denied" })).code, "idempotency_conflict");
  assert.equal(approvals.resolve(decision({ idempotencyKey: "other-key", commandId: "command-2" })).code, "approval_conflict");

  const expired = state({ now: () => Date.parse("2026-09-10T00:10:00.000Z") });
  expired.observe({ event: sourceEvent() });
  assert.equal(expired.resolve(decision()).code, "approval_expired");
  assert.equal(expired.snapshot().approvals[0].approval.status, "pending", "expiry requires an explicit lifecycle fact; a failed decision must not silently mutate it");
});

test("invalid decision input and capacity never create receipts", () => {
  const approvals = state({ maxPending: 1 });
  assert.equal(approvals.resolve(decision()).code, "approval_unavailable");
  assert.equal(approvals.observe({ event: sourceEvent() }).kind, "observed");
  assert.equal(approvals.resolve({ ...decision(), decision: "yes" }).code, "invalid_payload");
  assert.equal(approvals.observe({ event: sourceWithApproval({ approvalId: "approval-2", nonce: "nonce-2", nativeRequestId: "native-request-2" }, { nativeEventId: "native-event-2" }) }).code, "approval_capacity");
  assert.equal(approvals.snapshot().receipts.length, 0);
  const throwing = {};
  Object.defineProperty(throwing, "commandId", { enumerable: true, get() { throw new Error("untrusted accessor"); } });
  assert.equal(approvals.resolve(throwing).code, "invalid_payload");
});

test("receipt and outbox bounds fail closed without replacing an earlier winner", () => {
  const approvals = state({ maxReceipts: 1 });
  approvals.observe({ event: sourceEvent() });
  assert.equal(approvals.resolve(decision()).kind, "admit");
  approvals.observe({ event: sourceWithApproval({ approvalId: "approval-2", nonce: "nonce-2", nativeRequestId: "native-request-2" }, { nativeEventId: "native-event-2" }) });
  assert.equal(approvals.resolve(decision({ approvalId: "approval-2", nonce: "nonce-2", commandId: "command-2", idempotencyKey: "approval-key-2" })).code, "receipt_capacity");
  assert.equal(approvals.snapshot().receipts.length, 1);
  assert.equal(approvals.snapshot().approvals[1].approval.status, "pending");

  const tinyOutbox = state({ maxOutboxBytes: 1 });
  tinyOutbox.observe({ event: sourceEvent() });
  assert.equal(tinyOutbox.resolve(decision()).code, "receipt_capacity");
  assert.equal(tinyOutbox.snapshot().receipts.length, 0);
  assert.equal(tinyOutbox.snapshot().approvals[0].approval.status, "pending", "capacity rejection is atomic");

  const collision = state({ maxReceipts: 2, receiptId: () => "receipt-1" });
  collision.observe({ event: sourceEvent() });
  assert.equal(collision.resolve(decision()).kind, "admit");
  collision.observe({ event: sourceWithApproval({ approvalId: "approval-2", nonce: "nonce-2", nativeRequestId: "native-request-2" }, { nativeEventId: "native-event-2" }) });
  assert.equal(collision.resolve(decision({ approvalId: "approval-2", nonce: "nonce-2", commandId: "command-2", idempotencyKey: "approval-key-2" })).code, "receipt_conflict");
  assert.equal(collision.snapshot().receipts.length, 1);
});

test("closing a generic task drops pending and prior process-local proposals", () => {
  const approvals = state();
  approvals.observe({ event: sourceEvent() });
  assert.equal(approvals.snapshot().available, true);
  assert.equal(approvals.close("task_terminal"), true);
  assert.equal(approvals.close("task_terminal"), false);
  const snapshot = approvals.snapshot();
  assert.equal(snapshot.available, false);
  assert.equal(snapshot.closeReason, "task_terminal");
  assert.deepEqual(snapshot.approvals, []);
  assert.deepEqual(snapshot.receipts, []);
  assert.equal(approvals.observe({ event: sourceEvent() }).code, "task_unavailable");
  assert.equal(approvals.resolve(decision()).code, "task_unavailable");
});
