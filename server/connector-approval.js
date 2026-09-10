"use strict";

// A small, Host-local approval boundary for generic CLI connectors.  This is
// intentionally a detached proposal helper, not a durable store or a native
// dispatcher.  The worker which eventually sends a decision must still perform
// the transaction/receipt/evidence checks described by protocol/v1.

const crypto = require("node:crypto");
const { isDeepStrictEqual } = require("node:util");
const { describeCommand } = require("../protocol/command-state");
const { createValidator } = require("../protocol/validator");
const { createDomain } = require("../protocol/domain");
const { normalizeConnectorProtocolEvent } = require("./connector-protocol");

const contracts = createValidator(require("../protocol/v1/schema.json"));
const domain = createDomain(contracts);
const MAX_PENDING_APPROVALS = 32;
const MAX_RECEIPTS = 5000;
const MAX_OUTBOX_BYTES = 64 * 1024 * 1024;
const APPROVAL_DECISIONS = new Set(["approved", "denied"]);
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const reject = code => ({ kind: "reject", code });
const clone = value => structuredClone(value);

function validId(value) {
  return typeof value === "string" && ID.test(value);
}

function validDeviceId(value) {
  return validId(value);
}

function timestamp(now) {
  if (!Number.isSafeInteger(now) || Math.abs(now) > 8640000000000000) return null;
  const value = new Date(now).toISOString();
  return contracts.validate("timestamp", value).valid ? value : null;
}

function exact(value, keys) {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const ownKeys = Reflect.ownKeys(value);
    return ownKeys.length === keys.length && ownKeys.every(key => typeof key === "string" && keys.includes(key));
  } catch { return false; }
}

function inputShape(value) {
  try {
    return exact(value, ["commandId", "deviceId", "sessionId", "runId", "approvalId", "nonce", "scope", "decision", "idempotencyKey"])
      && validId(value.commandId) && validDeviceId(value.deviceId) && validId(value.sessionId)
      && validId(value.runId) && validId(value.approvalId) && validId(value.nonce)
      && ["once", "run", "session"].includes(value.scope) && APPROVAL_DECISIONS.has(value.decision)
      && validId(value.idempotencyKey);
  } catch { return false; }
}

function commandFor(input) {
  return {
    protocolVersion: 1,
    commandId: input.commandId,
    deviceId: input.deviceId,
    sessionId: input.sessionId,
    type: "approval.resolve",
    idempotencyKey: input.idempotencyKey,
    payload: {
      runId: input.runId,
      approvalId: input.approvalId,
      nonce: input.nonce,
      decision: input.decision,
      scope: input.scope,
    },
  };
}

function approvalState(approval, extra = {}) {
  return {
    approval: clone(approval),
    revision: Number.isSafeInteger(extra.revision) ? extra.revision : 0,
    updatedAt: extra.updatedAt || approval.createdAt,
    resolvedAt: extra.resolvedAt || null,
    resolvedByDeviceId: extra.resolvedByDeviceId || null,
    resolutionReceiptId: extra.resolutionReceiptId || null,
    nativeAcknowledgement: extra.nativeAcknowledgement || null,
    terminalReason: extra.terminalReason || null,
  };
}

function createConnectorApprovalState({ taskId = "", agentId = "", now = () => Date.now(), receiptId = () => crypto.randomUUID(), maxPending = MAX_PENDING_APPROVALS, maxReceipts = MAX_RECEIPTS, maxOutboxBytes = MAX_OUTBOX_BYTES } = {}) {
  const task = String(taskId || "");
  const agent = String(agentId || "");
  const approvals = new Map();
  const receipts = new Map();
  const outboxes = new Map();
  const receiptByScope = new Map();
  const receiptByCommand = new Map();
  const approvalByReceipt = new Map();
  const nativeEventById = new Map();
  const nativeRequestById = new Map();
  const nonceById = new Map();
  let outboxBytes = 0;
  let closed = false;
  let closeReason = null;

  function observe(value) {
    if (closed) return reject("task_unavailable");
    try {
      if (value && typeof value === "object" && !Array.isArray(value)) {
        if (Object.hasOwn(value, "taskId") && String(value.taskId) !== task) return reject("approval_conflict");
        if (Object.hasOwn(value, "agentId") && agent && String(value.agentId) !== agent) return reject("approval_conflict");
      }
    } catch { return reject("invalid_approval_event"); }
    let event;
    try {
      event = normalizeConnectorProtocolEvent(value?.event || value, { taskId: task, agentId: agent });
    } catch { return reject("invalid_approval_event"); }
    if (!event) return reject("invalid_approval_event");
    const source = event.event;
    const approval = source.payload.approval;
    const prior = approvals.get(approval.approvalId);
    if (prior) {
      if (isDeepStrictEqual(prior.source, source)) return { kind: "duplicate", approval: clone(prior.state), event: clone(event) };
      return reject("approval_conflict");
    }
    if (nativeEventById.has(source.nativeEventId) || nonceById.has(approval.nonce) || nativeRequestById.has(approval.nativeRequestId)) return reject("approval_conflict");
    const pendingCount = [...approvals.values()].filter(row => row.state.approval.status === "pending").length;
    if (!Number.isSafeInteger(maxPending) || maxPending < 1 || pendingCount >= maxPending) return reject("approval_capacity");
    const state = approvalState(approval);
    const row = { source: clone(source), state };
    approvals.set(approval.approvalId, row);
    nativeEventById.set(source.nativeEventId, approval.approvalId);
    nonceById.set(approval.nonce, approval.approvalId);
    nativeRequestById.set(approval.nativeRequestId, approval.approvalId);
    return { kind: "observed", approval: clone(state), event: clone(event) };
  }

  function resolve(input) {
    if (closed) return reject("task_unavailable");
    if (!inputShape(input)) return reject("invalid_payload");
    const command = commandFor(input);
    const binding = describeCommand(command);
    if (binding.kind === "reject") return binding;
    const scopeKey = JSON.stringify([input.deviceId, input.sessionId, "approval.resolve", input.idempotencyKey]);
    const commandKey = JSON.stringify([input.deviceId, input.sessionId, input.commandId]);
    const existing = receiptByScope.get(scopeKey);
    const byCommand = receiptByCommand.get(commandKey);
    if (existing) {
      if (byCommand && byCommand !== existing) return reject("command_id_conflict");
      if (existing.fingerprint !== binding.fingerprint || existing.fingerprintVersion !== binding.fingerprintVersion) return reject("idempotency_conflict");
      const replayRow = approvals.get(approvalByReceipt.get(existing.receiptId));
      return { kind: "replay", receipt: clone(existing), approval: replayRow ? clone(replayRow.state) : null, nativeAcknowledged: false, resumeAllowed: false };
    }
    if (byCommand) return reject("command_id_conflict");
    const row = approvals.get(input.approvalId);
    if (!row) return reject("approval_unavailable");
    const current = row.state;
    const approval = current.approval;
    if (approval.sessionId !== input.sessionId || approval.runId !== input.runId
      || approval.nonce !== input.nonce || approval.scope !== input.scope) return reject("approval_conflict");
    if (approval.status !== "pending" || current.resolutionReceiptId !== null) return reject("approval_conflict");
    const currentMs = Number(now());
    const createdMs = Date.parse(approval.createdAt), expiryMs = Date.parse(approval.expiresAt);
    if (!Number.isSafeInteger(currentMs) || !Number.isFinite(createdMs) || !Number.isFinite(expiryMs)
      || currentMs < createdMs || currentMs >= expiryMs) return reject("approval_expired");
    if (!Number.isSafeInteger(maxReceipts) || maxReceipts < 1 || receipts.size >= maxReceipts) return reject("receipt_capacity");
    const createdAt = timestamp(currentMs);
    let generatedReceiptId;
    try { generatedReceiptId = receiptId(); } catch { return reject("invalid_payload"); }
    if (!createdAt || !validId(generatedReceiptId)) return reject("invalid_payload");
    const receipt = {
      protocolVersion: 1,
      receiptId: generatedReceiptId,
      deviceId: input.deviceId,
      sessionId: input.sessionId,
      commandId: input.commandId,
      idempotencyKey: input.idempotencyKey,
      commandType: "approval.resolve",
      fingerprintVersion: binding.fingerprintVersion,
      fingerprint: binding.fingerprint,
      revision: 0,
      state: "accepted",
      createdAt,
      updatedAt: createdAt,
      attemptId: null,
      outcome: null,
    };
    const receiptCheck = domain.checkReceipt(receipt);
    if (!receiptCheck.valid) return reject(receiptCheck.code);
    if (receipts.has(generatedReceiptId)) return reject("receipt_conflict");
    const next = approvalState({ ...approval, status: input.decision }, {
      revision: current.revision + 1,
      updatedAt: createdAt,
      resolvedAt: createdAt,
      resolvedByDeviceId: input.deviceId,
      resolutionReceiptId: generatedReceiptId,
    });
    // This is a detached fact fragment. The durable Host must add its own
    // eventId, sequence, generation and authoritative createdAt before journal
    // append; returning it here is not an append acknowledgement.
    const event = {
      type: "approval.resolved",
      sessionId: input.sessionId,
      runId: input.runId,
      payload: {
        approvalId: input.approvalId,
        nonce: input.nonce,
        decision: input.decision,
        deviceId: input.deviceId,
        nativeAcknowledged: false,
        receiptId: generatedReceiptId,
      },
    };
    const outbox = { receiptId: generatedReceiptId, command: clone(command), dispatch: null, operation: null };
    const encodedOutboxBytes = Buffer.byteLength(JSON.stringify(outbox), "utf8");
    if (!Number.isSafeInteger(maxOutboxBytes) || maxOutboxBytes < 1 || outboxBytes > maxOutboxBytes - encodedOutboxBytes) return reject("receipt_capacity");
    row.state = next;
    const stored = { receipt: clone(receipt), command: clone(command), outbox };
    receipts.set(generatedReceiptId, stored.receipt);
    outboxes.set(generatedReceiptId, stored.outbox);
    outboxBytes += encodedOutboxBytes;
    approvalByReceipt.set(generatedReceiptId, input.approvalId);
    receiptByScope.set(scopeKey, stored.receipt);
    receiptByCommand.set(commandKey, stored.receipt);
    return {
      kind: "admit",
      receipt: clone(stored.receipt),
      outbox: clone(stored.outbox),
      approval: clone(next),
      event,
      nativeAcknowledged: false,
      resumeAllowed: false,
    };
  }

  // A generic connector has no durable cancellation fact yet. Once its
  // owned task has exited/orphaned, drop all process-local approval material
  // instead of allowing a stale UI/helper to create a decision after the
  // native process is gone. The durable Host must record explicit
  // approval.cancelled/expired facts when it owns a canonical run.
  function close(reason = "task_unavailable") {
    if (closed) return false;
    closed = true;
    closeReason = validId(reason) ? reason : "task_unavailable";
    approvals.clear();
    receipts.clear();
    outboxes.clear();
    receiptByScope.clear();
    receiptByCommand.clear();
    approvalByReceipt.clear();
    nativeEventById.clear();
    nativeRequestById.clear();
    nonceById.clear();
    outboxBytes = 0;
    return true;
  }

  function snapshot() {
    return {
      taskId: task,
      agentId: agent,
      available: !closed,
      closeReason,
      approvals: [...approvals.values()].map(row => clone(row.state)),
      receipts: [...receipts.values()].map(clone),
      // Commands are private outbox material.  Keep them available to the
      // eventual Host worker, but never expose them through publicTask/SSE.
      outbox: [...outboxes.values()].map(clone),
    };
  }

  function getApproval(approvalId) {
    if (closed) return null;
    const row = approvals.get(String(approvalId || ""));
    return row ? clone(row.state) : null;
  }

  return Object.freeze({ close, observe, resolve, getApproval, snapshot });
}

module.exports = {
  MAX_PENDING_APPROVALS,
  MAX_RECEIPTS,
  MAX_OUTBOX_BYTES,
  createConnectorApprovalState,
};
