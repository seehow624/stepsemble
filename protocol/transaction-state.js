"use strict";
// Host-only, detached multi-row proposals. This is NOT a database, authenticator
// or dispatcher. The real store must reread grants and CAS every read dependency
// inside one durable transaction before any external action is permitted.
const { isDeepStrictEqual } = require("node:util");
const { createValidator } = require("./validator"), { createDomain } = require("./domain");
const commands = require("./command-state");
const projectionModule = require("../public/modules/projection");
const contracts = createValidator(require("./v1/schema.json")), domain = createDomain(contracts);
const projection = projectionModule.create({ ...contracts, ...domain }, require("../public/modules/lifecycle").create({ ...contracts, ...domain }));
const clone = value => structuredClone(value), reject = code => ({ kind: "reject", code });
const id = value => contracts.validate("id", value).valid;
const terminal = state => ["completed", "failed", "interrupted"].includes(state);
const scopeKey = row => JSON.stringify([row.deviceId, row.sessionId, row.commandType, row.idempotencyKey]);
const commandKey = row => JSON.stringify([row.deviceId, row.sessionId, row.commandId]);
const exact = (value, keys) => value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const commandFields = ["protocolVersion", "commandId", "deviceId", "sessionId", "type", "idempotencyKey", "payload"];
function checkView(value) {
  if (projectionModule.canonicalJSON(value, 64 * 1024 * 1024) === null
    || !exact(value, ["storeId", "storeGeneration", "revision", "quarantined", "projection", "receipts", "outbox"])
    || !id(value.storeId) || !id(value.storeGeneration) || !Number.isSafeInteger(value.revision) || value.revision < 0
    || typeof value.quarantined !== "boolean" || !projection.checkState(value.projection).valid || value.projection.session === null
    || !Array.isArray(value.receipts) || !Array.isArray(value.outbox) || value.receipts.length > 5000 || value.receipts.length !== value.outbox.length) return reject("invalid_store_view");
  const receiptIds = new Set(), scopes = new Set(), commandIds = new Set(), attempts = new Set();
  const outbox = new Map(), runs = new Map(value.projection.runs.map(row => [row.run.runId, row]));
  const approvals = new Map(value.projection.approvals.map(row => [row.approval.approvalId, row]));
  const targets = new Set();
  for (const row of value.outbox) {
    if (!exact(row, ["receiptId", "command", "dispatch"]) || !id(row.receiptId) || outbox.has(row.receiptId)
      || !exact(row.command, commandFields) || !["run.start", "approval.resolve"].includes(row.command.type)
      || commands.describeCommand(row.command).kind !== "binding"
      || row.dispatch !== null && (!exact(row.dispatch, ["attemptId", "incarnationId"]) || !id(row.dispatch.attemptId) || !id(row.dispatch.incarnationId))) return reject("invalid_outbox");
    outbox.set(row.receiptId, row);
  }
  for (const receipt of value.receipts) {
    if (!domain.checkReceipt(receipt).valid) return reject("receipt_conflict");
    const row = outbox.get(receipt.receiptId), scope = scopeKey(receipt), commandId = commandKey(receipt);
    if (!row || receiptIds.has(receipt.receiptId) || scopes.has(scope) || commandIds.has(commandId)
      || receipt.sessionId !== value.projection.cursor.sessionId || receipt.attemptId !== (row.dispatch?.attemptId ?? null)
      || receipt.attemptId !== null && attempts.has(receipt.attemptId)) return reject("receipt_conflict");
    const cmd = row.command, binding = commands.describeCommand(cmd), run = runs.get(cmd.payload.runId);
    if (binding.fingerprint !== receipt.fingerprint || binding.fingerprintVersion !== receipt.fingerprintVersion
      || scope !== scopeKey({ ...cmd, commandType: cmd.type }) || commandId !== commandKey(cmd)
      || !run || Date.parse(receipt.createdAt) < Date.parse(value.projection.session.session.createdAt)) return reject("outbox_mismatch");
    const target = JSON.stringify([cmd.type, cmd.type === "run.start" ? cmd.payload.runId : cmd.payload.approvalId]);
    if (targets.has(target)) return reject("winner_conflict"); targets.add(target);
    if (cmd.type === "run.start") {
      if (!run.profileLocked || run.launchProfile.launchProfileId !== cmd.payload.launchProfileId) return reject("profile_mismatch");
    } else {
      const a = approvals.get(cmd.payload.approvalId);
      if (!a || a.resolutionReceiptId !== receipt.receiptId || a.resolvedByDeviceId !== cmd.deviceId
        || a.approval.status !== cmd.payload.decision || a.approval.nonce !== cmd.payload.nonce || a.approval.scope !== cmd.payload.scope || a.approval.runId !== cmd.payload.runId) return reject("approval_conflict");
      if (a.nativeAcknowledgement !== null && (receipt.state !== "succeeded" || a.nativeAcknowledgement.attemptId !== receipt.attemptId
        || !isDeepStrictEqual(a.nativeAcknowledgement.evidence, receipt.outcome.evidence))) return reject("acknowledgement_conflict");
      if (receipt.state === "succeeded" && a.nativeAcknowledgement === null) return reject("acknowledgement_conflict");
    }
    receiptIds.add(receipt.receiptId); scopes.add(scope); commandIds.add(commandId); if (receipt.attemptId !== null) attempts.add(receipt.attemptId);
  }
  for (const row of approvals.values()) if (row.resolutionReceiptId !== null && !receiptIds.has(row.resolutionReceiptId)) return reject("receipt_conflict");
  return { kind: "valid" };
}
function initialView(state, config) {
  if (!projection.checkState(state).valid || !config || !id(config.storeId) || !id(config.storeGeneration)) return reject("invalid_store_view");
  const { storeId, storeGeneration } = config;
  const value = { storeId, storeGeneration, revision: 0, quarantined: false, projection: clone(state), receipts: [], outbox: [] };
  const result = checkView(value); return result.kind === "valid" ? { kind: "view", state: value } : result;
}
function preflight(input, context, { authorization = false, mutation = true } = {}) {
  const checked = checkView(input); if (checked.kind !== "valid") return checked;
  if (!context || context.storeId !== input.storeId || context.storeGeneration !== input.storeGeneration
    || context.expectedRevision !== input.revision) return reject("store_revision_conflict");
  if (mutation && input.revision === Number.MAX_SAFE_INTEGER) return reject("revision_overflow");
  if (authorization && (context.authorized !== true || !id(context.authenticatedDeviceId))) return reject("not_authorized");
  if (!Number.isSafeInteger(context.now) || Math.abs(context.now) > 8640000000000000
    || !contracts.validate("timestamp", new Date(context.now).toISOString()).valid
    || context.now < Date.parse(input.projection.updatedAt)
    || input.receipts.some(row => context.now < Date.parse(row.updatedAt))) return reject("state_time_conflict");
  return { kind: "view", state: clone(input), expected: { storeId: input.storeId, storeGeneration: input.storeGeneration,
    revision: input.revision, cursor: clone(input.projection.cursor) }, context: {
    storeId: input.storeId, storeGeneration: input.storeGeneration, expectedRevision: input.revision,
    now: context.now, authorized: context.authorized === true, authenticatedDeviceId: context.authenticatedDeviceId,
  } };
}
function finish(expected, next, events = [], receiptId = null) {
  next.revision++;
  const checked = checkView(next); if (checked.kind !== "valid") return checked;
  return { kind: "transaction", expected: clone(expected),
    state: next, append: clone(events), receiptId };
}
async function project(view, facts, eventIds, now) {
  if (!Array.isArray(eventIds) || eventIds.length !== facts.length || eventIds.some(value => !id(value))) return reject("invalid_event_ids");
  const start = view.projection.cursor;
  if (start.sequence > Number.MAX_SAFE_INTEGER - facts.length) return reject("sequence_overflow");
  const events = facts.map((fact, i) => ({ protocolVersion: 1, eventId: eventIds[i], sessionId: start.sessionId, generation: start.generation,
    sequence: start.sequence + i + 1, createdAt: new Date(now).toISOString(), ...fact }));
  const result = await projection.applyBatch(view.projection, { afterCursor: clone(start), cursor: { ...start, sequence: start.sequence + events.length }, events, hasMore: false });
  if (result.kind !== "apply") return reject(result.reason || "projection_conflict");
  view.projection = result.state; return { kind: "projected", events };
}
async function planAdmission(input, command, context) {
  const read = preflight(input, context, { authorization: true, mutation: false }); if (read.kind !== "view") return read;
  if (projectionModule.canonicalJSON(command, 2 * 1024 * 1024) === null || !contracts.validate("command", command).valid) return reject("invalid_payload");
  const cmd = Object.fromEntries(commandFields.map(key => [key, clone(command[key])])), next = read.state, c = read.context;
  const existing = next.receipts.find(row => scopeKey(row) === scopeKey({ ...cmd, commandType: cmd.type })) ?? null;
  const byId = next.receipts.find(row => commandKey(row) === commandKey(cmd)) ?? null;
  const writer = next.projection.runs.find(row => !terminal(row.run.state)) ?? null;
  const approval = cmd.type === "approval.resolve" ? next.projection.approvals.find(row => row.approval.approvalId === cmd.payload.approvalId) : null;
  const result = commands.inspectCommand(cmd, { ...c, session: next.projection.session.session, run: writer?.run ?? null, approval: approval?.approval,
    launchProfile: next.projection.session.launchProfile, receiptId: context.receiptId, existingReceipt: existing, commandIdReceipt: byId });
  if (result.kind === "reject" || result.kind === "replay") return result;
  if (next.quarantined) return reject("store_recovery_required");
  if (next.revision === Number.MAX_SAFE_INTEGER) return reject("revision_overflow");
  if (!["run.start", "approval.resolve"].includes(cmd.type)) return reject("unsupported_transaction");
  if (next.receipts.length >= 5000) return reject("store_capacity");
  if (next.receipts.some(row => row.receiptId === result.receipt.receiptId)) return reject("receipt_conflict");
  let facts;
  if (cmd.type === "run.start") {
    if (next.projection.runs.some(row => row.run.runId === cmd.payload.runId)) return reject("run_conflict");
    if (next.projection.session.launchProfile?.launchProfileId !== cmd.payload.launchProfileId) return reject("profile_mismatch");
    facts = [{ type: "run.starting", runId: cmd.payload.runId, payload: { run: { runId: cmd.payload.runId, sessionId: cmd.sessionId, state: "starting", createdAt: new Date(c.now).toISOString() } } },
      { type: "launch_profile.locked", runId: cmd.payload.runId, payload: { launchProfile: clone(next.projection.session.launchProfile) } }];
  } else facts = [{ type: "approval.resolved", runId: cmd.payload.runId, payload: { approvalId: cmd.payload.approvalId, nonce: cmd.payload.nonce,
    decision: cmd.payload.decision, deviceId: cmd.deviceId, nativeAcknowledged: false, receiptId: result.receipt.receiptId } }];
  // `project` detaches event IDs/payloads synchronously before its first await.
  const projected = await project(next, facts, context.eventIds, c.now); if (projected.kind !== "projected") return projected;
  next.receipts.push(result.receipt); next.outbox.push({ receiptId: result.receipt.receiptId, command: cmd, dispatch: null });
  return finish(read.expected, next, projected.events, result.receipt.receiptId);
}
function planDispatch(input, receiptId, context) {
  const read = preflight(input, context, { authorization: true }); if (read.kind !== "view") return read;
  const next = read.state;
  if (next.quarantined) return reject("store_recovery_required");
  const index = next.receipts.findIndex(row => row.receiptId === receiptId), row = next.outbox.find(row => row.receiptId === receiptId);
  if (index < 0 || !row) return reject("receipt_conflict");
  const receipt = next.receipts[index], cmd = row.command, run = next.projection.runs.find(row => row.run.runId === cmd.payload.runId);
  if (receipt.deviceId !== context.authenticatedDeviceId) return reject("device_mismatch");
  if (!id(context.incarnationId) || !id(context.attemptId) || next.receipts.some(row => row.attemptId === context.attemptId)) return reject("attempt_mismatch");
  if (cmd.type === "run.start" && run.run.state !== "starting" || cmd.type === "approval.resolve" && run.run.state !== "waiting_approval") return reject("run_conflict");
  if (cmd.type === "approval.resolve") {
    const a = next.projection.approvals.find(row => row.approval.approvalId === cmd.payload.approvalId);
    if (context.now >= Date.parse(a.approval.expiresAt)) return reject("approval_expired");
  }
  const result = commands.transitionReceipt(receipt, { type: "dispatch", attemptId: context.attemptId }, { expectedRevision: context.receiptRevision, now: context.now });
  if (result.kind !== "transition") return result;
  next.receipts[index] = result.receipt; row.dispatch = { attemptId: context.attemptId, incarnationId: context.incarnationId };
  return finish(read.expected, next, [], receiptId);
}
function planPipeAccepted(input, receiptId, context) {
  const read = preflight(input, context); if (read.kind !== "view") return read;
  const next = read.state, index = next.receipts.findIndex(row => row.receiptId === receiptId), row = next.outbox.find(row => row.receiptId === receiptId);
  if (index < 0 || !row || row.dispatch?.incarnationId !== context.incarnationId) return reject("attempt_mismatch");
  const result = commands.transitionReceipt(next.receipts[index], { type: "pipe_accepted", attemptId: context.attemptId }, { expectedRevision: context.receiptRevision, now: context.now });
  if (result.kind !== "transition") return result;
  next.receipts[index] = result.receipt; return finish(read.expected, next, [], receiptId);
}
async function planApprovalAcknowledgement(input, receiptId, context) {
  const read = preflight(input, context); if (read.kind !== "view") return read;
  const next = read.state, index = next.receipts.findIndex(row => row.receiptId === receiptId), row = next.outbox.find(row => row.receiptId === receiptId);
  if (index < 0 || !row || row.command.type !== "approval.resolve") return reject("receipt_conflict");
  const cmd = row.command, a = next.projection.approvals.find(row => row.approval.approvalId === cmd.payload.approvalId);
  // This trusted adapter assertion is NOT proof supplied by an HTTP client. The
  // real store must atomically persist the verified proof and incarnation binding.
  if (context.evidenceVerified !== true || !contracts.validate("nativeEvidence", context.evidence).valid
    || row.dispatch?.incarnationId !== context.incarnationId || row.dispatch?.attemptId !== context.attemptId
    || context.nativeRequestId !== a.approval.nativeRequestId || context.nonce !== a.approval.nonce) return reject("evidence_mismatch");
  const evidence = clone(context.evidence), result = commands.transitionReceipt(next.receipts[index], { type: "settle", attemptId: context.attemptId,
    outcome: { status: "succeeded", code: "native_confirmed", resultReference: a.approval.approvalId, evidence } }, { expectedRevision: context.receiptRevision, now: context.now });
  if (result.kind !== "transition") return result;
  const facts = [{ type: "approval.acknowledged", runId: cmd.payload.runId, payload: { approvalId: a.approval.approvalId,
    nonce: a.approval.nonce, receiptId, attemptId: context.attemptId, evidence: clone(evidence) } }];
  const projected = await project(next, facts, context.eventIds, context.now); if (projected.kind !== "projected") return projected;
  next.receipts[index] = result.receipt; return finish(read.expected, next, projected.events, receiptId);
}
async function planRecovery(input, context) {
  const read = preflight(input, context); if (read.kind !== "view") return read;
  if (!["current_store", "restored_backup", "unknown"].includes(context.source)) return reject("missing_recovery_context");
  const next = read.state;
  if (context.source !== "current_store") { next.quarantined = true; return finish(read.expected, next); }
  for (let i = 0; i < next.receipts.length; i++) {
    const result = commands.recoverReceipt(next.receipts[i], { source: "current_store", now: context.now });
    if (result.kind === "reject") return result;
    if (result.kind === "transition") next.receipts[i] = result.receipt;
  }
  const writer = next.projection.runs.find(row => !terminal(row.run.state));
  let events = [];
  if (writer && writer.run.state !== "orphaned") {
    const projected = await project(next, [{ type: "run.orphaned", runId: writer.run.runId, payload: { reason: "host_restarted" } }], context.eventIds, context.now);
    if (projected.kind !== "projected") return projected; events = projected.events;
  }
  return finish(read.expected, next, events);
}
module.exports = { checkView, initialView, planAdmission, planDispatch, planPipeAccepted, planApprovalAcknowledgement, planRecovery };
