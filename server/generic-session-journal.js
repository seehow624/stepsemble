"use strict";

// Durable canonical state for CLI connectors that do not expose a native
// session store.  The supervisor remains the owner of the child process; this
// module owns the Stepsemble session/run/approval projection and its SQLite
// journal.  Native effects are never inferred from a pipe write: decisions
// move through admission -> dispatch -> pipe acceptance -> explicit adapter
// acknowledgement, and resume is a separate evidence-bound fact.

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { createSessionJournalClient } = require("./session-journal-client");
const tx = require("../protocol/transaction-state");
const projectionModule = require("../public/modules/projection");
const lifecycle = require("../public/modules/lifecycle");
const { createValidator } = require("../protocol/validator");
const { createDomain } = require("../protocol/domain");

const contracts = createValidator(require("../protocol/v1/schema.json"));
const domain = createDomain(contracts);
const projection = projectionModule.create({ ...contracts, ...domain }, lifecycle.create({ ...contracts, ...domain }));
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const DEVICE_ID = "stepsemble-host";
const STORE_ID = "generic-session-store";
const MAX_EVENT_TEXT = 64 * 1024;
const MAX_FAILURE_MESSAGE = 512;
const BOOTSTRAP_SEQUENCE = 4;
const reject = code => ({ kind: "reject", code });
const clone = value => structuredClone(value);

function validId(value) { return typeof value === "string" && ID.test(value); }
function nowMs(value) {
  const result = Number(value);
  return Number.isSafeInteger(result) && result >= 0 && result <= 8640000000000000 ? result : Date.now();
}
function iso(value) { return new Date(nowMs(value)).toISOString(); }
function id(prefix) { return `${prefix}-${crypto.randomUUID()}`; }
function digest(value) { return crypto.createHash("sha256").update(String(value)).digest("hex").slice(0, 24); }
function text(value, limit = MAX_EVENT_TEXT) {
  return String(value ?? "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ").slice(0, limit);
}

function profileFor(task) {
  const profileId = task.profileId || `profile-${digest(`${task.id}\0${task.agentId}`)}`;
  return {
    launchProfileId: profileId,
    harnessId: String(task.agentId || "terminal").slice(0, 128),
    modelId: null,
    sourceId: "terminal",
    authMode: "unknown",
    billingMode: "unknown",
    credentialReference: null,
  };
}

function canonicalIds(task) {
  const sessionId = validId(task.sessionId) ? task.sessionId : `session-${task.id}`;
  const runId = validId(task.runId) ? task.runId : `run-${task.id}`;
  const incarnationId = validId(task.incarnationId) ? task.incarnationId : `inc-${task.id}`;
  return { sessionId, runId, incarnationId };
}

function initialProjection(task, { sessionId, runId }) {
  const generation = validId(task.journalGeneration) ? task.journalGeneration : `generic-${digest(task.id)}`;
  const at = iso(task.startedAt || Date.now());
  const profile = profileFor(task);
  const session = {
    sessionId,
    native: { harnessId: task.agentId, adapterVersion: "terminal-v1", nativeSessionId: task.id, reference: null },
    workspaceId: `workspace-${digest(task.cwd || task.id)}`,
    // The profile is committed by the subsequent model.changed fact. Keeping
    // session.created unprofiled is required by the canonical reducer.
    launchProfileId: null,
    createdAt: at,
    status: "active",
  };
  const run = { runId, sessionId, state: "starting", createdAt: at };
  const empty = projection.empty({ sessionId, generation, sequence: 0 });
  const events = [
    { type: "session.created", runId: null, payload: { session } },
    { type: "model.changed", runId: null, payload: { launchProfile: profile } },
    { type: "run.starting", runId, payload: { run } },
    { type: "launch_profile.locked", runId, payload: { launchProfile: profile } },
  ].map((fact, index) => ({ protocolVersion: 1, eventId: id("bootstrap"), sessionId, generation, sequence: index + 1, createdAt: at, ...clone(fact) }));
  return projection.applyBatch(empty, {
    afterCursor: empty.cursor,
    cursor: { ...empty.cursor, sequence: events.length },
    events,
    hasMore: false,
  }).then(result => {
    if (result.kind !== "apply") return reject(result.reason || "invalid_store_view");
    return tx.initialView(result.state, { storeId: STORE_ID, storeGeneration: generation });
  });
}

function eventIds(count, prefix = "event") {
  return Array.from({ length: count }, () => id(prefix));
}

function publicApproval(row) {
  if (!row || typeof row !== "object") return null;
  const approval = row.approval || {};
  return {
    approval: {
      approvalId: approval.approvalId,
      sessionId: approval.sessionId,
      runId: approval.runId,
      status: approval.status,
      scope: approval.scope,
      expiresAt: approval.expiresAt,
      request: { summary: text(approval.request?.summary, 512) },
      createdAt: approval.createdAt,
      nonce: approval.nonce,
      toolId: approval.toolId ?? null,
      nativeRequestId: approval.nativeRequestId,
    },
    revision: row.revision,
    updatedAt: row.updatedAt,
    resolvedAt: row.resolvedAt,
    resolvedByDeviceId: row.resolvedByDeviceId,
    resolutionReceiptId: row.resolutionReceiptId,
    nativeAcknowledgement: row.nativeAcknowledgement ? clone(row.nativeAcknowledgement) : null,
    terminalReason: row.terminalReason,
  };
}

function publicView(state) {
  if (!state || typeof state !== "object") return null;
  const projectionState = state.projection;
  const run = projectionState?.runs?.[projectionState.runs.length - 1] || null;
  const approvals = Array.isArray(projectionState?.approvals) ? projectionState.approvals.map(publicApproval).filter(Boolean) : [];
  return {
    sessionId: projectionState?.cursor?.sessionId || null,
    runId: run?.run?.runId || null,
    runState: run?.run?.state || null,
    nativeRunId: run?.nativeRunId || null,
    revision: state.revision,
    cursor: projectionState?.cursor ? clone(projectionState.cursor) : null,
    // Bootstrap facts live in the initial snapshot, not the append-only event
    // table. Replays must begin after that fixed snapshot floor.
    historyFloor: BOOTSTRAP_SEQUENCE,
    approvals,
    pendingApprovals: approvals.filter(row => ["pending", "approved", "denied"].includes(row.approval.status) && row.nativeAcknowledgement === null),
    durable: true,
  };
}

function createGenericSessionJournal({ configDir, onUnavailable = null } = {}) {
  let directory = path.resolve(configDir || process.cwd());
  // macOS commonly exposes /tmp through a symlink. The SQLite owner-boundary
  // check intentionally rejects a non-canonical parent, so resolve it after
  // creating the private directory while leaving the task snapshot path alone.
  try { fs.mkdirSync(directory, { recursive: true, mode: 0o700 }); directory = fs.realpathSync(directory); } catch {}
  const filename = path.join(directory, "agent-sessions.sqlite");
  let journal = null;
  let unavailable = null;
  let ready = Promise.resolve(false);
  try {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (process.platform !== "win32") {
      try { fs.chmodSync(directory, 0o700); } catch {}
    }
    journal = createSessionJournalClient({ filename });
    ready = journal.ready.then(ok => {
      if (!ok) {
        unavailable = "journal_unavailable";
        journal = null;
      }
      return ok;
    }).catch(() => {
      unavailable = "journal_unavailable";
      journal = null;
      return false;
    });
  } catch (error) {
    unavailable = error?.message || "journal_unavailable";
    try { onUnavailable?.(unavailable); } catch {}
  }

  async function create(task) {
    if (!journal) return reject("journal_unavailable");
    const ids = canonicalIds(task);
    const initial = await initialProjection({ ...task, ...ids }, ids);
    if (initial.kind !== "view") return initial;
    const created = await journal.create(initial.state);
    if (created.kind === "reject" && created.code === "session_exists") {
      const existing = await journal.read(ids.sessionId);
      if (existing.kind !== "view") return existing;
      const grant = await journal.setGrant(ids.sessionId, DEVICE_ID, true);
      if (grant.kind === "reject") return grant;
      const currentRun = existing.state.projection.runs.find(row => row.run.runId === ids.runId) || existing.state.projection.runs.at(-1);
      return {
        kind: "existing",
        sessionId: existing.state.projection.cursor.sessionId,
        runId: currentRun?.run?.runId || ids.runId,
        incarnationId: ids.incarnationId,
        state: existing.state,
      };
    }
    if (created.kind === "reject") return created;
    const grant = await journal.setGrant(ids.sessionId, DEVICE_ID, true);
    if (grant.kind === "reject") return grant;
    return { kind: "created", sessionId: ids.sessionId, runId: ids.runId, incarnationId: ids.incarnationId, state: initial.state };
  }
  async function read(taskOrSessionId) {
    if (!journal) return reject("journal_unavailable");
    const sessionId = typeof taskOrSessionId === "string" ? taskOrSessionId : canonicalIds(taskOrSessionId).sessionId;
    return journal.read(sessionId);
  }
  async function observe(task, facts, options = {}) {
    if (!journal) return reject("journal_unavailable");
    const { sessionId, runId, incarnationId } = canonicalIds(task);
    if (!Array.isArray(facts) || !facts.length || facts.length > 32) return reject("invalid_payload");
    const current = await read(sessionId);
    if (current.kind !== "view") return current;
    const now = Math.max(nowMs(options.now), Date.parse(current.state.projection.updatedAt || "0"));
    const ids = Array.isArray(options.eventIds) && options.eventIds.length === facts.length ? options.eventIds : eventIds(facts.length);
    const result = await journal.execute(sessionId, "planObservedEvents", [clone(facts)], {
      now,
      authenticatedDeviceId: DEVICE_ID,
      sessionId,
      runId,
      incarnationId,
      runtimeVerified: true,
      evidenceVerified: options.evidenceVerified === true,
      evidence: options.evidence || undefined,
      eventIds: ids,
    });
    return result;
  }
  async function terminal(task, status, details = {}) {
    if (!journal) return reject("journal_unavailable");
    const { sessionId, runId, incarnationId } = canonicalIds(task);
    const current = await read(sessionId);
    if (current.kind !== "view") return current;
    const run = current.state.projection.runs.find(row => row.run.runId === runId);
    if (!run || ["completed", "failed", "interrupted"].includes(run.run.state)) return { kind: "replay", state: current.state };
    const type = status === "failed" ? "run.failed" : status === "stopped" ? "run.interrupted" : "run.completed";
    const payload = type === "run.failed"
      ? { error: { code: "agent_exit", message: text(details.error || "Agent exited with an error", MAX_FAILURE_MESSAGE) || "Agent exited with an error", retryable: false } }
      : type === "run.interrupted" ? { reason: details.reason === "host_shutdown" ? "host_shutdown" : "native_exit" }
        : { finishReason: "complete" };
    const pending = current.state.projection.approvals.filter(row => row.approval.runId === runId && ["pending"].includes(row.approval.status));
    const facts = pending.map(row => ({ type: Date.parse(row.approval.expiresAt) <= nowMs(details.now) ? "approval.expired" : "approval.cancelled", payload: {
      approvalId: row.approval.approvalId,
      ...(Date.parse(row.approval.expiresAt) <= nowMs(details.now) ? {} : { reason: "Run ended before a decision" }),
    } }));
    facts.push({ type, payload });
    const evidence = { kind: "authoritative_readback", reference: id("exit") };
    const result = await journal.execute(sessionId, "planRunTerminal", [runId], {
      now: Math.max(nowMs(details.now), Date.parse(current.state.projection.updatedAt || "0")),
      authenticatedDeviceId: DEVICE_ID,
      sessionId,
      runId,
      incarnationId,
      nativeRunId: run.nativeRunId,
      runtimeVerified: true,
      evidenceVerified: true,
      evidence,
      type,
      payload,
      source: "current_store",
      eventIds: eventIds(facts.length, "terminal"),
    });
    return result;
  }
  async function admitApproval(task, input = {}) {
    if (!journal) return reject("journal_unavailable");
    const { sessionId, runId, incarnationId } = canonicalIds(task);
    const current = await read(sessionId);
    if (current.kind !== "view") return current;
    const approval = current.state.projection.approvals.find(row => row.approval.approvalId === input.approvalId);
    if (!approval) return reject("approval_unavailable");
    const commandId = validId(input.commandId) ? input.commandId : id("command");
    const idempotencyKey = validId(input.idempotencyKey) ? input.idempotencyKey : id("idem");
    const receiptId = id("receipt");
    const command = {
      protocolVersion: 1,
      commandId,
      deviceId: DEVICE_ID,
      sessionId,
      type: "approval.resolve",
      idempotencyKey,
      payload: { runId, approvalId: input.approvalId, nonce: input.nonce, decision: input.decision, scope: input.scope },
    };
    const admitted = await journal.execute(sessionId, "planAdmission", [command], {
      now: Math.max(Date.now(), Date.parse(current.state.projection.updatedAt || "0")),
      authenticatedDeviceId: DEVICE_ID,
      sessionId,
      runId,
      receiptId,
      eventIds: [id("decision")],
    });
    if (admitted.kind !== "committed") return admitted;
    const receipt = admitted.state.receipts.find(row => row.receiptId === receiptId);
    if (!receipt) return reject("receipt_conflict");
    const attemptId = id("attempt");
    const dispatched = await journal.execute(sessionId, "planDispatch", [receiptId], {
      now: Math.max(Date.now(), Date.parse(admitted.state.projection.updatedAt || "0")),
      authenticatedDeviceId: DEVICE_ID,
      sessionId,
      runId,
      receiptRevision: receipt.revision,
      attemptId,
      incarnationId,
      eventIds: [],
    });
    if (dispatched.kind !== "committed") return dispatched;
    const nextReceipt = dispatched.state.receipts.find(row => row.receiptId === receiptId);
    return { kind: "dispatch", receipt: nextReceipt, state: dispatched.state, command, attemptId, incarnationId, approval: dispatched.state.projection.approvals.find(row => row.approval.approvalId === input.approvalId) };
  }
  async function pipeAccepted(task, dispatch) {
    if (!journal || !dispatch?.receipt?.receiptId) return reject("receipt_conflict");
    const { sessionId, runId, incarnationId } = canonicalIds(task);
    return journal.execute(sessionId, "planPipeAccepted", [dispatch.receipt.receiptId], {
      now: Math.max(Date.now(), Date.parse(dispatch.state?.projection?.updatedAt || "0")),
      authenticatedDeviceId: DEVICE_ID,
      sessionId,
      runId,
      receiptRevision: dispatch.receipt.revision,
      attemptId: dispatch.attemptId,
      incarnationId,
      eventIds: [],
    });
  }
  async function acknowledge(task, details = {}) {
    if (!journal) return reject("journal_unavailable");
    const { sessionId, runId, incarnationId } = canonicalIds(task);
    const current = await read(sessionId);
    if (current.kind !== "view") return current;
    const approval = current.state.projection.approvals.find(row => row.approval.approvalId === details.approvalId);
    const receipt = current.state.receipts.find(row => row.receiptId === approval?.resolutionReceiptId);
    if (!approval || !receipt) return reject("native_ack_unavailable");
    if (receipt.state === "succeeded" && approval.nativeAcknowledgement) return { kind: "replay", state: current.state, receipt, nativeAcknowledged: true };
    if (receipt.state !== "awaiting_confirmation" || approval.approval.nonce !== details.nonce || approval.approval.nativeRequestId !== details.nativeRequestId
      || receipt.attemptId !== details.attemptId) return reject("native_ack_conflict");
    const evidence = { kind: "native_ack", reference: details.evidenceReference };
    if (!validId(evidence.reference)) return reject("native_ack_unverified");
    const ack = await journal.execute(sessionId, "planApprovalAcknowledgement", [receipt.receiptId], {
      now: Math.max(Date.now(), Date.parse(current.state.projection.updatedAt || "0")),
      authenticatedDeviceId: DEVICE_ID,
      sessionId,
      runId,
      receiptRevision: receipt.revision,
      attemptId: details.attemptId,
      incarnationId,
      nativeRequestId: details.nativeRequestId,
      nonce: details.nonce,
      evidenceVerified: true,
      evidence,
      eventIds: [id("ack")],
    });
    if (ack.kind !== "committed") return ack;
    return { kind: "acknowledged", state: ack.state, evidence, approval: ack.state.projection.approvals.find(row => row.approval.approvalId === details.approvalId) };
  }
  async function resume(task, details = {}) {
    const { sessionId, runId } = canonicalIds(task);
    const evidence = { kind: "native_ack", reference: details.evidenceReference };
    if (!validId(evidence.reference)) return reject("native_ack_unverified");
    return observe(task, [{ type: "run.resumed", payload: { nativeRunId: details.nativeRunId || task.nativeRunId || task.id, evidence } }], { evidenceVerified: true, evidence, eventIds: [id("resume")] });
  }
  async function eventsAfter(task, cursor, limit = 100) {
    if (!journal) return reject("journal_unavailable");
    return journal.eventsAfter(canonicalIds(task).sessionId, cursor, limit);
  }
  async function close() { if (journal) return journal.close(); return { kind: "closed" }; }
  return Object.freeze({
    get available() { return !!journal && journal.available !== false; },
    ready,
    filename,
    deviceId: DEVICE_ID,
    create,
    read,
    observe,
    terminal,
    admitApproval,
    pipeAccepted,
    acknowledge,
    resume,
    eventsAfter,
    publicView,
    close,
    get unavailable() { return unavailable; },
  });
}

module.exports = { createGenericSessionJournal, publicView, DEVICE_ID };
