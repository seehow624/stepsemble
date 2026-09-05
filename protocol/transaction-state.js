"use strict";
// Host-only, detached multi-row proposals. This is NOT a database, authenticator
// or dispatcher. The real store must reread grants and CAS every read dependency
// inside one durable transaction before any external action is permitted.
const { isDeepStrictEqual } = require("node:util");
const { createValidator } = require("./validator"), { createDomain } = require("./domain");
const commands = require("./command-state");
const projectionModule = require("../public/modules/projection");
const contracts = createValidator(require("./v1/schema.json")), domain = createDomain(contracts);
const lifecycle = require("../public/modules/lifecycle").create({ ...contracts, ...domain });
const projection = projectionModule.create({ ...contracts, ...domain }, lifecycle);
const clone = value => structuredClone(value), reject = code => ({ kind: "reject", code });
const id = value => contracts.validate("id", value).valid;
const terminal = state => ["completed", "failed", "interrupted"].includes(state);
const scopeKey = row => JSON.stringify([row.deviceId, row.sessionId, row.commandType, row.idempotencyKey]);
const commandKey = row => JSON.stringify([row.deviceId, row.sessionId, row.commandId]);
const exact = (value, keys) => value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const commandFields = ["protocolVersion", "commandId", "deviceId", "sessionId", "type", "idempotencyKey", "payload"];
const exclusiveTypes = new Set(["model.change", "session.archive", "session.restore", "context.compact"]);
const pendingReceipt = receipt => !["succeeded", "failed"].includes(receipt.state);
const evidenceShape = (value, host = false) => exact(value, ["kind", "reference"]) && id(value.reference)
  && ["native_ack", "authoritative_readback", ...(host ? ["host_commit"] : [])].includes(value.kind);
const boundRunId = row => row.command.payload.runId ?? row.operation?.runId ?? null;
function checkView(value) {
  if (projectionModule.canonicalJSON(value, 64 * 1024 * 1024) === null
    || !exact(value, ["storeId", "storeGeneration", "revision", "quarantined", "projection", "receipts", "outbox"])
    || !id(value.storeId) || !id(value.storeGeneration) || !Number.isSafeInteger(value.revision) || value.revision < 0
    || typeof value.quarantined !== "boolean" || !projection.checkState(value.projection).valid || value.projection.session === null
    || !Array.isArray(value.receipts) || !Array.isArray(value.outbox) || value.receipts.length > 5000 || value.receipts.length !== value.outbox.length) return reject("invalid_store_view");
  const receiptIds = new Set(), scopes = new Set(), commandIds = new Set(), attempts = new Set();
  const outbox = new Map(), runs = new Map(value.projection.runs.map(row => [row.run.runId, row]));
  const approvals = new Map(value.projection.approvals.map(row => [row.approval.approvalId, row]));
  const targets = new Set(), pendingTargets = new Set(), archiveIds = new Set(); let exclusive = 0, rename = 0;
  for (const row of value.outbox) {
    if (!exact(row, ["receiptId", "command", "dispatch", "operation"]) || !id(row.receiptId) || outbox.has(row.receiptId)
      || !exact(row.command, commandFields)
      || commands.describeCommand(row.command).kind !== "binding"
      || row.dispatch !== null && (!exact(row.dispatch, ["attemptId", "incarnationId"]) || !id(row.dispatch.attemptId) || !id(row.dispatch.incarnationId))) return reject("invalid_outbox");
    const cmd = row.command, op = row.operation;
    if (cmd.type === "model.change") {
      if (!exact(op, ["launchProfile"]) || projectionModule.canonicalJSON(op.launchProfile, 65536) === null
        || !domain.checkProfile(op.launchProfile).valid || op.launchProfile.launchProfileId !== cmd.payload.launchProfileId
        || op.launchProfile.harnessId !== value.projection.session.session.native.harnessId) return reject("profile_mismatch");
    } else if (cmd.type === "session.archive") {
      if (!exact(op, ["archiveId"]) || !id(op.archiveId) || archiveIds.has(op.archiveId)) return reject("invalid_outbox");
      archiveIds.add(op.archiveId);
    } else if (cmd.type === "context.compact") {
      if (!exact(op, ["runId"]) || !runs.has(op.runId)) return reject("invalid_outbox");
    } else if (op !== null) return reject("invalid_outbox");
    outbox.set(row.receiptId, row);
  }
  for (const receipt of value.receipts) {
    if (!domain.checkReceipt(receipt).valid) return reject("receipt_conflict");
    const row = outbox.get(receipt.receiptId), scope = scopeKey(receipt), commandId = commandKey(receipt);
    if (!row || receiptIds.has(receipt.receiptId) || scopes.has(scope) || commandIds.has(commandId)
      || receipt.sessionId !== value.projection.cursor.sessionId || receipt.attemptId !== (row.dispatch?.attemptId ?? null)
      || receipt.attemptId !== null && attempts.has(receipt.attemptId)) return reject("receipt_conflict");
    const cmd = row.command, binding = commands.describeCommand(cmd), run = runs.get(boundRunId(row));
    if (binding.fingerprint !== receipt.fingerprint || binding.fingerprintVersion !== receipt.fingerprintVersion
      || scope !== scopeKey({ ...cmd, commandType: cmd.type }) || commandId !== commandKey(cmd)
      || ["run.start", "run.interrupt", "approval.resolve", "context.compact"].includes(cmd.type) && !run
      || Date.parse(receipt.createdAt) < Date.parse(value.projection.session.session.createdAt)) return reject("outbox_mismatch");
    if (["run.start", "approval.resolve"].includes(cmd.type)) {
      const target = JSON.stringify([cmd.type, cmd.type === "run.start" ? cmd.payload.runId : cmd.payload.approvalId]);
      if (targets.has(target)) return reject("winner_conflict"); targets.add(target);
    }
    if (pendingReceipt(receipt)) {
      if (exclusiveTypes.has(cmd.type)) exclusive++;
      if (cmd.type === "session.rename") rename++;
      if (cmd.type === "run.interrupt") {
        if (pendingTargets.has(cmd.payload.runId)) return reject("winner_conflict"); pendingTargets.add(cmd.payload.runId);
      }
      if (cmd.type === "session.restore" && (value.projection.session.session.status !== "archived" || value.projection.session.archiveId !== cmd.payload.archiveId)
        || ["model.change", "session.archive", "context.compact"].includes(cmd.type) && value.projection.session.session.status !== "active") return reject("session_conflict");
    }
    if (cmd.type === "run.start") {
      if (!run.profileLocked || run.launchProfile.launchProfileId !== cmd.payload.launchProfileId) return reject("profile_mismatch");
      if (receipt.attemptId === null && run.startedAt !== null || receipt.state === "succeeded" && run.startedAt === null) return reject("acknowledgement_conflict");
    } else if (cmd.type === "approval.resolve") {
      const a = approvals.get(cmd.payload.approvalId);
      if (!a || a.resolutionReceiptId !== receipt.receiptId || a.resolvedByDeviceId !== cmd.deviceId
        || a.approval.status !== cmd.payload.decision || a.approval.nonce !== cmd.payload.nonce || a.approval.scope !== cmd.payload.scope || a.approval.runId !== cmd.payload.runId) return reject("approval_conflict");
      if (a.nativeAcknowledgement !== null && (receipt.state !== "succeeded" || a.nativeAcknowledgement.attemptId !== receipt.attemptId
        || !isDeepStrictEqual(a.nativeAcknowledgement.evidence, receipt.outcome.evidence))) return reject("acknowledgement_conflict");
      if (receipt.state === "succeeded" && a.nativeAcknowledgement === null) return reject("acknowledgement_conflict");
    }
    receiptIds.add(receipt.receiptId); scopes.add(scope); commandIds.add(commandId); if (receipt.attemptId !== null) attempts.add(receipt.attemptId);
  }
  if (exclusive > 1 || rename > 1 || exclusive && (rename || value.projection.runs.some(row => !terminal(row.run.state)))) return reject("maintenance_conflict");
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
  const selectedProfile = cmd.type === "model.change" ? context.launchProfile : next.projection.session.launchProfile;
  if (cmd.type === "model.change" && !existing && (projectionModule.canonicalJSON(selectedProfile, 65536) === null || !domain.checkProfile(selectedProfile).valid)) return reject("profile_mismatch");
  const result = commands.inspectCommand(cmd, { ...c, session: next.projection.session.session, run: writer?.run ?? null, approval: approval?.approval,
    launchProfile: selectedProfile, receiptId: context.receiptId, existingReceipt: existing, commandIdReceipt: byId });
  if (result.kind === "reject" || result.kind === "replay") return result;
  if (next.quarantined) return reject("store_recovery_required");
  if (next.revision === Number.MAX_SAFE_INTEGER) return reject("revision_overflow");
  if (next.receipts.length >= 5000) return reject("store_capacity");
  if (next.receipts.some(row => row.receiptId === result.receipt.receiptId)) return reject("receipt_conflict");
  const pending = next.receipts.filter(pendingReceipt);
  if (pending.some(row => exclusiveTypes.has(row.commandType))
    || exclusiveTypes.has(cmd.type) && pending.some(row => row.commandType === "session.rename")
    || cmd.type === "session.rename" && pending.some(row => row.commandType === cmd.type)) return reject("maintenance_conflict");
  if (cmd.type === "run.interrupt" && pending.some(receipt => receipt.commandType === cmd.type
    && next.outbox.find(row => row.receiptId === receipt.receiptId).command.payload.runId === cmd.payload.runId)) return reject("winner_conflict");
  let facts = [], operation = null;
  if (cmd.type === "run.start") {
    if (next.projection.runs.some(row => row.run.runId === cmd.payload.runId)) return reject("run_conflict");
    if (next.projection.session.launchProfile?.launchProfileId !== cmd.payload.launchProfileId) return reject("profile_mismatch");
    facts = [{ type: "run.starting", runId: cmd.payload.runId, payload: { run: { runId: cmd.payload.runId, sessionId: cmd.sessionId, state: "starting", createdAt: new Date(c.now).toISOString() } } },
      { type: "launch_profile.locked", runId: cmd.payload.runId, payload: { launchProfile: clone(next.projection.session.launchProfile) } }];
  } else if (cmd.type === "approval.resolve") facts = [{ type: "approval.resolved", runId: cmd.payload.runId, payload: { approvalId: cmd.payload.approvalId, nonce: cmd.payload.nonce,
    decision: cmd.payload.decision, deviceId: cmd.deviceId, nativeAcknowledged: false, receiptId: result.receipt.receiptId } }];
  else if (cmd.type === "run.interrupt") {
    if (writer.run.state === "orphaned") return reject("reconciliation_required");
    if (writer.run.state !== "stopping") facts = [{ type: "run.stopping", runId: cmd.payload.runId, payload: { reason: "user" } }];
  } else if (cmd.type === "model.change") {
    const preview = lifecycle.reduceSession(next.projection.session, { protocolVersion: 1, eventId: result.receipt.receiptId, sessionId: cmd.sessionId, generation: next.projection.cursor.generation,
      sequence: next.projection.cursor.sequence + 1, createdAt: new Date(c.now).toISOString(), type: "model.changed", runId: null, payload: { launchProfile: clone(selectedProfile) } },
    { expectedRevision: next.projection.session.revision, writer: null });
    if (preview.kind !== "transition") return preview;
    operation = { launchProfile: clone(selectedProfile) };
  } else if (cmd.type === "session.archive") {
    if (!id(context.archiveId) || next.outbox.some(row => row.command.type === "session.archive" && row.operation.archiveId === context.archiveId)) return reject("archive_conflict");
    operation = { archiveId: context.archiveId };
  } else if (cmd.type === "session.restore") {
    if (cmd.payload.archiveId !== next.projection.session.archiveId) return reject("archive_conflict");
  } else if (cmd.type === "context.compact") {
    // A store/native lookup must bind the actual context owner; array order is
    // not proof of which historical run owns the current native context.
    const run = next.projection.runs.find(row => row.run.runId === context.targetRunId);
    if (!run || run.startedAt === null || !terminal(run.run.state)) return reject("context_unavailable");
    operation = { runId: run.run.runId };
  }
  // `project` detaches event IDs/payloads synchronously before its first await.
  let events = [];
  if (facts.length) {
    const projected = await project(next, facts, context.eventIds, c.now); if (projected.kind !== "projected") return projected; events = projected.events;
  } else if (!Array.isArray(context.eventIds) || context.eventIds.length) return reject("invalid_event_ids");
  next.receipts.push(result.receipt); next.outbox.push({ receiptId: result.receipt.receiptId, command: cmd, dispatch: null, operation });
  return finish(read.expected, next, events, result.receipt.receiptId);
}
function planDispatch(input, receiptId, context) {
  const read = preflight(input, context, { authorization: true }); if (read.kind !== "view") return read;
  const next = read.state;
  if (next.quarantined) return reject("store_recovery_required");
  const index = next.receipts.findIndex(row => row.receiptId === receiptId), row = next.outbox.find(row => row.receiptId === receiptId);
  if (index < 0 || !row) return reject("receipt_conflict");
  const receipt = next.receipts[index], cmd = row.command, run = next.projection.runs.find(run => run.run.runId === boundRunId(row));
  if (receipt.deviceId !== context.authenticatedDeviceId) return reject("device_mismatch");
  if (cmd.type === "session.restore" ? next.projection.session.session.status !== "archived" || next.projection.session.archiveId !== cmd.payload.archiveId
    : next.projection.session.session.status !== "active") return reject("session_conflict");
  if (!id(context.incarnationId) || !id(context.attemptId) || next.receipts.some(row => row.attemptId === context.attemptId)) return reject("attempt_mismatch");
  if (cmd.type === "run.start" && run.run.state !== "starting" || cmd.type === "approval.resolve" && run.run.state !== "waiting_approval") return reject("run_conflict");
  if (cmd.type === "run.interrupt" && run.run.state !== "stopping") return reject("run_conflict");
  if (exclusiveTypes.has(cmd.type) && next.projection.runs.some(run => !terminal(run.run.state))) return reject("maintenance_conflict");
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
function effectRead(input, receiptId, context) {
  const read = preflight(input, context); if (read.kind !== "view") return read;
  const index = read.state.receipts.findIndex(row => row.receiptId === receiptId), row = read.state.outbox.find(row => row.receiptId === receiptId);
  if (index < 0 || !row) return reject("receipt_conflict");
  if (context.evidenceVerified !== true || !contracts.validate("nativeEvidence", context.evidence).valid
    || row.dispatch?.incarnationId !== context.incarnationId || row.dispatch?.attemptId !== context.attemptId) return reject("evidence_mismatch");
  return { ...read, index, row, evidence: clone(context.evidence),
    run: read.state.projection.runs.find(run => run.run.runId === boundRunId(row)) };
}
async function planRunStartAcknowledgement(input, receiptId, context) {
  const read = effectRead(input, receiptId, context); if (read.kind !== "view") return read;
  const { state: next, row, index, run } = read;
  if (row.command.type !== "run.start" || context.runId !== row.command.payload.runId) return reject("entity_mismatch");
  if (context.nativeRunId !== null && (typeof context.nativeRunId !== "string" || !context.nativeRunId.length || context.nativeRunId.length > 512)) return reject("invalid_payload");
  const result = commands.transitionReceipt(next.receipts[index], { type: "settle", attemptId: context.attemptId,
    outcome: { status: "succeeded", code: "native_started", resultReference: run.run.runId, evidence: read.evidence } }, { expectedRevision: context.receiptRevision, now: context.now });
  if (result.kind !== "transition") return result;
  let events = [];
  if (run.startedAt === null) {
    // A late start ACK after stop/orphan/terminal is not a fresh liveness proof.
    // Reconciliation must first establish the actual native/history state.
    if (run.run.state !== "starting") return reject("reconciliation_required");
    const projected = await project(next, [{ type: "run.started", runId: run.run.runId, payload: { nativeRunId: context.nativeRunId } }], context.eventIds, context.now);
    if (projected.kind !== "projected") return projected; events = projected.events;
  } else if (run.nativeRunId !== context.nativeRunId) return reject("entity_mismatch");
  next.receipts[index] = result.receipt; return finish(read.expected, next, events, receiptId);
}
async function planRejectBeforeDispatch(input, receiptId, context) {
  const read = preflight(input, context); if (read.kind !== "view") return read;
  const next = read.state, index = next.receipts.findIndex(row => row.receiptId === receiptId), row = next.outbox.find(row => row.receiptId === receiptId);
  // An old backup's accepted marker is NOT proof that no external effect ran.
  if (next.quarantined) return reject("store_recovery_required");
  if (context.source !== "current_store") return reject("missing_recovery_context");
  if (index < 0 || !row) return reject("receipt_conflict");
  const result = commands.transitionReceipt(next.receipts[index], { type: "reject", code: context.code }, { expectedRevision: context.receiptRevision, now: context.now });
  if (result.kind !== "transition") return result;
  let events = [];
  if (row.command.type === "run.start") {
    const run = next.projection.runs.find(run => run.run.runId === row.command.payload.runId);
    if (run.startedAt !== null) return reject("reconciliation_required");
    if (!terminal(run.run.state)) {
      const projected = await project(next, [{ type: "run.failed", runId: run.run.runId,
        payload: { error: { code: context.code, message: "Command rejected before dispatch", retryable: false } } }], context.eventIds, context.now);
      if (projected.kind !== "projected") return projected; events = projected.events;
    }
  }
  next.receipts[index] = result.receipt; return finish(read.expected, next, events, receiptId);
}
async function planNativeFailure(input, receiptId, context) {
  const read = effectRead(input, receiptId, context); if (read.kind !== "view") return read;
  const { state: next, row, index, run } = read;
  if (context.effect !== "not_applied" || !id(context.code)) return reject("evidence_mismatch");
  if (row.command.type === "approval.resolve") {
    const a = next.projection.approvals.find(a => a.approval.approvalId === row.command.payload.approvalId);
    if (context.nonce !== a.approval.nonce || context.nativeRequestId !== a.approval.nativeRequestId) return reject("evidence_mismatch");
  } else if (row.command.type === "run.start" && (context.runId !== run.run.runId || run.startedAt !== null)) return reject("reconciliation_required");
  const result = commands.transitionReceipt(next.receipts[index], { type: "settle", attemptId: context.attemptId,
    outcome: { status: "failed", code: context.code, resultReference: null, evidence: read.evidence } }, { expectedRevision: context.receiptRevision, now: context.now });
  if (result.kind !== "transition") return result;
  let events = [];
  if (row.command.type === "run.start" && !terminal(run.run.state)) {
    const projected = await project(next, [{ type: "run.failed", runId: run.run.runId,
      payload: { error: { code: context.code, message: "Native start was not applied", retryable: false } } }], context.eventIds, context.now);
    if (projected.kind !== "projected") return projected; events = projected.events;
  }
  next.receipts[index] = result.receipt; return finish(read.expected, next, events, receiptId);
}
async function planDeliveryUncertain(input, receiptId, context) {
  const read = preflight(input, context); if (read.kind !== "view") return read;
  const next = read.state, index = next.receipts.findIndex(row => row.receiptId === receiptId), row = next.outbox.find(row => row.receiptId === receiptId);
  if (index < 0 || !row || row.dispatch?.incarnationId !== context.incarnationId || row.dispatch?.attemptId !== context.attemptId) return reject("attempt_mismatch");
  const result = commands.transitionReceipt(next.receipts[index], { type: "uncertain" }, { expectedRevision: context.receiptRevision, now: context.now });
  if (result.kind !== "transition") return result;
  const run = next.projection.runs.find(run => run.run.runId === boundRunId(row)); let events = [];
  if (run && !terminal(run.run.state) && run.run.state !== "orphaned") {
    const projected = await project(next, [{ type: "run.orphaned", runId: run.run.runId, payload: { reason: "transport_lost" } }], context.eventIds, context.now);
    if (projected.kind !== "projected") return projected; events = projected.events;
  }
  next.receipts[index] = result.receipt; return finish(read.expected, next, events, receiptId);
}
async function planOperationAcknowledgement(input, receiptId, context) {
  const read = preflight(input, context); if (read.kind !== "view") return read;
  const next = read.state, index = next.receipts.findIndex(row => row.receiptId === receiptId), row = next.outbox.find(row => row.receiptId === receiptId);
  if (index < 0 || !row || ["run.start", "approval.resolve"].includes(row.command.type)) return reject("receipt_conflict");
  const cmd = row.command;
  if (context.evidenceVerified !== true || !evidenceShape(context.evidence, ["session.rename", "session.archive", "session.restore", "model.change"].includes(cmd.type))
    || row.dispatch?.incarnationId !== context.incarnationId || row.dispatch?.attemptId !== context.attemptId) return reject("evidence_mismatch");
  let facts = [], reference = null;
  if (cmd.type === "run.interrupt") {
    if (context.runId !== cmd.payload.runId) return reject("evidence_mismatch"); reference = cmd.payload.runId;
  } else if (cmd.type === "session.rename") {
    if (context.title !== cmd.payload.title) return reject("evidence_mismatch");
    facts = [{ type: "session.updated", runId: null, payload: { title: cmd.payload.title } }];
  } else if (cmd.type === "model.change") {
    if (!isDeepStrictEqual(context.launchProfile, row.operation.launchProfile)) return reject("evidence_mismatch");
    facts = [{ type: "model.changed", runId: null, payload: { launchProfile: clone(row.operation.launchProfile) } }]; reference = cmd.payload.launchProfileId;
  } else if (cmd.type === "session.archive" || cmd.type === "session.restore") {
    reference = cmd.type === "session.archive" ? row.operation.archiveId : cmd.payload.archiveId;
    if (context.archiveId !== reference) return reject("evidence_mismatch");
    facts = [{ type: cmd.type === "session.archive" ? "session.archived" : "session.restored", runId: null, payload: { archiveId: reference } }];
  } else if (cmd.type === "context.compact") {
    if (context.runId !== row.operation.runId) return reject("evidence_mismatch"); reference = row.operation.runId;
    facts = [{ type: "context.compacted", runId: reference, payload: { beforeTokens: context.beforeTokens, afterTokens: context.afterTokens } }];
  }
  const result = commands.transitionReceipt(next.receipts[index], { type: "settle", attemptId: context.attemptId,
    outcome: { status: "succeeded", code: "effect_confirmed", resultReference: reference, evidence: clone(context.evidence) } }, { expectedRevision: context.receiptRevision, now: context.now });
  if (result.kind !== "transition") return result;
  let events = [];
  if (facts.length) {
    const projected = await project(next, facts, context.eventIds, context.now); if (projected.kind !== "projected") return projected; events = projected.events;
  } else if (!Array.isArray(context.eventIds) || context.eventIds.length) return reject("invalid_event_ids");
  next.receipts[index] = result.receipt; return finish(read.expected, next, events, receiptId);
}
async function planRunTerminal(input, runId, context) {
  const read = preflight(input, context); if (read.kind !== "view") return read;
  const next = read.state, run = next.projection.runs.find(row => row.run.runId === runId);
  if (!run || terminal(run.run.state)) return reject("run_conflict");
  if (!["current_store", "restored_backup", "unknown"].includes(context.source)) return reject("missing_recovery_context");
  if (context.source !== "current_store" && !next.quarantined) return reject("store_recovery_required");
  // The actual adapter/store must verify the owned source and persist proof.
  // These are explicit trusted assertions, never fields trusted from a Client.
  if (context.runtimeVerified !== true || context.evidenceVerified !== true || !evidenceShape(context.evidence)
    || !id(context.incarnationId) || context.sessionId !== next.projection.cursor.sessionId || context.runId !== runId
    || context.nativeRunId !== run.nativeRunId) return reject("evidence_mismatch");
  if (!["run.completed", "run.failed", "run.interrupted"].includes(context.type)
    || projectionModule.canonicalJSON(context.payload, 65536) === null) return reject("invalid_payload");
  const facts = next.projection.approvals.filter(row => row.approval.runId === runId && row.approval.status === "pending").map(row =>
    context.now >= Date.parse(row.approval.expiresAt) ? { type: "approval.expired", runId, payload: { approvalId: row.approval.approvalId } }
      : { type: "approval.cancelled", runId, payload: { approvalId: row.approval.approvalId, reason: "Run ended before a decision" } });
  facts.push({ type: context.type, runId, payload: clone(context.payload) });
  const proof = { runId, sessionId: context.sessionId, incarnationId: context.incarnationId, nativeRunId: context.nativeRunId, evidence: clone(context.evidence) };
  const canRejectUnsent = context.source === "current_store" && !next.quarantined, now = context.now;
  const projected = await project(next, facts, context.eventIds, now); if (projected.kind !== "projected") return projected;
  const outbox = new Map(next.outbox.map(row => [row.receiptId, row]));
  for (let i = 0; i < next.receipts.length; i++) {
    const receipt = next.receipts[i], row = outbox.get(receipt.receiptId);
    if (boundRunId(row) !== runId || !["run.start", "approval.resolve", "run.interrupt"].includes(row.command.type)) continue;
    let action = null;
    if (receipt.state === "accepted" && canRejectUnsent) action = { type: "reject", code: "run_ended_before_dispatch" };
    else if (["dispatching", "awaiting_confirmation"].includes(receipt.state)) action = { type: "uncertain" };
    if (action) {
      const moved = commands.transitionReceipt(receipt, action, { now, expectedRevision: receipt.revision });
      if (moved.kind !== "transition") return moved; next.receipts[i] = moved.receipt;
    }
  }
  const result = finish(read.expected, next, projected.events);
  return result.kind === "transaction" ? { ...result, proof } : result;
}
async function planObservedEvents(input, facts, context) {
  const read = preflight(input, context); if (read.kind !== "view") return read;
  const next = read.state;
  if (context.runtimeVerified !== true || !id(context.incarnationId) || context.sessionId !== next.projection.cursor.sessionId
    || !next.projection.runs.some(row => row.run.runId === context.runId)) return reject("evidence_mismatch");
  // Normalized facts from one verified owned runtime, never an HTTP Client's
  // commands or event envelope. The Host assigns time, IDs, scope and cursor.
  if (projectionModule.canonicalJSON(facts, 16 * 1024 * 1024) === null || !Array.isArray(facts) || !facts.length || facts.length > 500) return reject("invalid_payload");
  const allowed = new Set(["message.delta", "message.completed", "tool.requested", "tool.started", "tool.progress", "tool.completed", "tool.failed",
    "usage.updated", "context.updated", "context.compacted", "approval.requested", "approval.cancelled", "approval.expired", "run.started", "run.orphaned", "run.resumed", "run.reconciled"]);
  for (const fact of facts) {
    if (!exact(fact, ["type", "payload"]) || !allowed.has(fact.type)) return reject("unsupported_observation");
    // Winner/ACK/terminal/effect events must use their receipt-aware planner.
    if (["run.resumed", "run.reconciled"].includes(fact.type) && (context.evidenceVerified !== true || !evidenceShape(context.evidence)
      || !isDeepStrictEqual(fact.payload?.evidence, context.evidence))) return reject("evidence_mismatch");
  }
  const normalized = facts.map(fact => ({ type: fact.type, runId: context.runId, payload: clone(fact.payload) }));
  const source = { sessionId: context.sessionId, runId: context.runId, incarnationId: context.incarnationId,
    evidence: context.evidenceVerified === true && evidenceShape(context.evidence) ? clone(context.evidence) : null };
  const projected = await project(next, normalized, context.eventIds, context.now); if (projected.kind !== "projected") return projected;
  const result = finish(read.expected, next, projected.events);
  return result.kind === "transaction" ? { ...result, source } : result;
}
module.exports = { checkView, initialView, planAdmission, planDispatch, planPipeAccepted, planApprovalAcknowledgement, planRecovery,
  planRunStartAcknowledgement, planRejectBeforeDispatch, planNativeFailure, planDeliveryUncertain, planOperationAcknowledgement, planRunTerminal, planObservedEvents };
