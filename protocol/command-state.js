"use strict";

// Reserved Host reference contract. Pure proposals, not a durable ledger,
// transaction, authorization service, clock or native dispatcher.
const { createHash } = require("node:crypto");
const { isDeepStrictEqual } = require("node:util");
const { createValidator } = require("./validator");
const { createDomain } = require("./domain");
const contracts = createValidator(require("./v1/schema.json"));
const domain = createDomain(contracts);
const reject = code => ({ kind: "reject", code });
const clone = value => structuredClone(value);
const id = value => contracts.validate("id", value).valid;
function timestamp(now) {
  if (!Number.isSafeInteger(now) || Math.abs(now) > 8640000000000000) return null;
  const value = new Date(now).toISOString();
  return contracts.validate("timestamp", value).valid ? value : null;
}

function describeCommand(command) {
  if (!contracts.validate("command", command).valid) return reject("invalid_payload");
  // Current closed command payloads contain only strings. No Unicode
  // normalization, coercion, generic object serialization or unknown intent.
  const pairs = Object.keys(command.payload).sort().map(key => [key, command.payload[key]]);
  if (pairs.some(([, value]) => typeof value !== "string" || !value.isWellFormed())) return reject("invalid_payload");
  const tuple = JSON.stringify(["stepsemble.command.v1", command.protocolVersion, command.deviceId, command.sessionId, command.type, pairs]);
  if (Buffer.byteLength(tuple) > 1024 * 1024 + 8192) return reject("invalid_payload");
  return {
    kind: "binding",
    scope: [command.deviceId, command.sessionId, command.type, command.idempotencyKey],
    fingerprintVersion: "sha256-tuple-v1",
    fingerprint: createHash("sha256").update(tuple, "utf8").digest("hex"),
  };
}

function inspectCommand(command, context) {
  // Fresh session/device authorization must precede even a stored-result replay.
  if (!context || context.authorized !== true || !id(context.authenticatedDeviceId)) return reject("not_authorized");
  const binding = describeCommand(command);
  if (binding.kind === "reject") return binding;
  if (command.deviceId !== context.authenticatedDeviceId) return reject("device_mismatch");
  if (!contracts.validate("session", context.session).valid || command.sessionId !== context.session.sessionId) return reject("entity_mismatch");
  // Both indexed reads must be explicit, taken inside the same future transaction.
  if (!Object.hasOwn(context, "existingReceipt") || context.existingReceipt === undefined
    || !Object.hasOwn(context, "commandIdReceipt") || context.commandIdReceipt === undefined) return reject("missing_ledger_context");
  const existing = context.existingReceipt, byId = context.commandIdReceipt;
  for (const value of [existing, byId]) if (value !== null && !domain.checkReceipt(value).valid) return reject("invalid_ledger_context");
  if (byId && (byId.deviceId !== command.deviceId || byId.sessionId !== command.sessionId || byId.commandId !== command.commandId)) return reject("invalid_ledger_context");
  if (existing) {
    if (existing.deviceId !== command.deviceId || existing.sessionId !== command.sessionId
      || existing.commandType !== command.type || existing.idempotencyKey !== command.idempotencyKey) return reject("invalid_ledger_context");
    if (byId && byId.receiptId !== existing.receiptId) return reject("command_id_conflict");
    if (byId && !isDeepStrictEqual(byId, existing) || !byId && existing.commandId === command.commandId) return reject("invalid_ledger_context");
    if (existing.fingerprintVersion !== binding.fingerprintVersion || existing.fingerprint !== binding.fingerprint) return reject("idempotency_conflict");
    // Do not run mutation preflight again: a prior winner may have changed the
    // run or consumed the approval. Returning a receipt never dispatches it.
    return { kind: "replay", receipt: clone(existing) };
  }
  if (byId) return reject("command_id_conflict");
  const preflight = domain.checkCommandContext(command, context);
  if (!preflight.valid) return reject(preflight.code);
  const createdAt = timestamp(context.now);
  if (!createdAt || !id(context.receiptId)) return reject("invalid_payload");
  if (context.now < Date.parse(context.session.createdAt) || context.run && context.now < Date.parse(context.run.createdAt)) return reject("receipt_time_conflict");
  return { kind: "admit", receipt: {
    protocolVersion: 1, receiptId: context.receiptId, deviceId: command.deviceId,
    sessionId: command.sessionId, commandId: command.commandId, idempotencyKey: command.idempotencyKey,
    commandType: command.type, fingerprintVersion: binding.fingerprintVersion, fingerprint: binding.fingerprint,
    revision: 0, state: "accepted", createdAt, updatedAt: createdAt, attemptId: null, outcome: null,
  } };
}

function transitionReceipt(receipt, action, context) {
  if (!domain.checkReceipt(receipt).valid || !context) return reject("invalid_payload");
  if (!Number.isSafeInteger(context.expectedRevision) || context.expectedRevision !== receipt.revision) return reject("revision_conflict");
  if (receipt.revision === Number.MAX_SAFE_INTEGER) return reject("revision_overflow");
  const updatedAt = timestamp(context.now);
  if (!updatedAt || context.now < Date.parse(receipt.updatedAt)) return reject("receipt_time_conflict");
  const fields = { dispatch: ["type", "attemptId"], pipe_accepted: ["type", "attemptId"], settle: ["type", "attemptId", "outcome"], reject: ["type", "code"], uncertain: ["type"] };
  if (!action || typeof action !== "object" || Array.isArray(action) || !Object.hasOwn(fields, action.type)) return reject("invalid_action");
  const keys = Object.keys(action), allowed = fields[action.type];
  if (keys.length !== allowed.length || keys.some(key => !allowed.includes(key))) return reject("invalid_action");
  const next = clone(receipt);
  if (action.type === "dispatch") {
    if (receipt.state !== "accepted") return reject("receipt_state_conflict");
    if (!id(action.attemptId)) return reject("invalid_action");
    next.state = "dispatching"; next.attemptId = action.attemptId;
  } else if (action.type === "reject") {
    if (receipt.state !== "accepted") return reject("receipt_state_conflict");
    if (!id(action.code)) return reject("invalid_action");
    next.state = "failed";
    next.outcome = { status: "failed", code: action.code, resultReference: null, evidence: null };
  } else if (action.type === "uncertain") {
    if (!["dispatching", "awaiting_confirmation"].includes(receipt.state)) return reject("receipt_state_conflict");
    next.state = "uncertain";
  } else {
    if (action.attemptId !== receipt.attemptId || !id(action.attemptId)) return reject("attempt_mismatch");
    if (action.type === "pipe_accepted") {
      if (receipt.state !== "dispatching") return reject("receipt_state_conflict");
      next.state = "awaiting_confirmation";
    } else {
      if (!["dispatching", "awaiting_confirmation", "uncertain"].includes(receipt.state)) return reject("receipt_state_conflict");
      next.state = action.outcome?.status; next.outcome = clone(action.outcome);
    }
  }
  next.updatedAt = updatedAt; next.revision++;
  const result = domain.checkReceipt(next);
  if (!result.valid) return reject(result.code);
  // Caller must CAS receiptId + revision and commit next BEFORE dispatch. A
  // successful proposal alone grants no permission to execute an effect.
  return { kind: "transition", expectedRevision: receipt.revision, receipt: next };
}

function recoverReceipt(receipt, context) {
  if (!domain.checkReceipt(receipt).valid) return reject("invalid_payload");
  if (!context || !["current_store", "restored_backup", "unknown"].includes(context.source)) return reject("missing_recovery_context");
  // A backup may predate a dispatch marker even though the external effect ran.
  // Row contents alone cannot prove that an accepted command is still unsent.
  if (context.source !== "current_store") return { kind: "reconciliation_required", code: "store_recovery_required", receipt: clone(receipt) };
  if (!["dispatching", "awaiting_confirmation"].includes(receipt.state)) return { kind: "retain", receipt: clone(receipt) };
  return transitionReceipt(receipt, { type: "uncertain" }, { now: context.now, expectedRevision: receipt.revision });
}

module.exports = { describeCommand, inspectCommand, transitionReceipt, recoverReceipt };
