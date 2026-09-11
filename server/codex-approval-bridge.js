"use strict";

// Host-only bridge for the pinned Codex app-server approval channel. It is a
// composition seam, not an HTTP/UI route: native JSON-RPC requests are first
// projected as approval.requested facts through the durable journal; a user
// decision then goes through planAdmission + planDispatch before this bridge
// permits the transport to write the native response. A resolved notification
// closes the native request only. Codex does not include the decision in that
// notification, so this bridge never turns it into approval.acknowledged.

const crypto = require("node:crypto");
const { isDeepStrictEqual } = require("node:util");

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const REQUEST_ID = /^(?:[A-Za-z0-9][A-Za-z0-9._:-]{0,255}|\d{1,18})$/;
const NATIVE_METHODS = new Set([
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
  "item/permissions/requestApproval",
]);
const DECISIONS = new Set(["approved", "denied"]);
const SCOPES = new Set(["once", "run", "session"]);
const reject = code => ({ kind: "reject", code });
const clone = value => structuredClone(value);

function nativeEvidence(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).length === 2 && (value.kind === "native_ack" || value.kind === "authoritative_readback")
    && id(value.reference);
}

function id(value) {
  return typeof value === "string" && ID.test(value);
}

function requestId(value) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 999999999999999999
    || typeof value === "string" && REQUEST_ID.test(value);
}

function requestKey(value) {
  return requestId(value) ? `${typeof value === "number" ? "n" : "s"}:${value}` : null;
}

function text(value, limit = 512) {
  return typeof value === "string" && !/[\u0000-\u001f\u007f]/.test(value) ? value.slice(0, limit) : "";
}

function validTime(value) {
  return Number.isSafeInteger(value) && value >= 0 && value <= 8640000000000000;
}

function createCodexApprovalBridge({
  journal,
  sessionId,
  runId,
  deviceId,
  threadId,
  turnId,
  incarnationId,
  harnessId = "codex",
  now = () => Date.now(),
  approvalTtlMs = 10 * 60 * 1000,
  idFactory = () => crypto.randomUUID(),
  authorizeOther = async () => reject("transaction_required"),
  // This callback belongs to the native owner/adapter. It must independently
  // verify the exact request/attempt before returning a durable evidence
  // reference; bridge callers never get to assert `evidenceVerified`.
  verifyNativeAcknowledgement = async () => reject("native_ack_verifier_required"),
  onEvent = null,
} = {}) {
  if (!journal || typeof journal.read !== "function" || typeof journal.execute !== "function") throw new TypeError("journal_required");
  if (![sessionId, runId, deviceId, threadId, turnId, incarnationId, harnessId].every(id)) throw new TypeError("native_mapping_required");
  if (!Number.isSafeInteger(approvalTtlMs) || approvalTtlMs < 1000 || approvalTtlMs > 86400000) throw new TypeError("approval_ttl_invalid");
  if (typeof idFactory !== "function" || typeof authorizeOther !== "function" || typeof verifyNativeAcknowledgement !== "function") throw new TypeError("bridge_callback_required");
  const rows = new Map();
  const tombstones = new Map();
  let transport = null;
  let closed = false;
  const maxPending = 32;
  // Keep an object for each in-flight journal projection.  A Set of keys is
  // not enough: a closure can arrive while observe() is awaiting SQLite and
  // the bounded closedRequests tombstones may evict that key before the
  // await resumes.  The reservation itself therefore carries a durable
  // in-memory closed bit until observe() finishes.
  const observing = new Map();
  const closedRequests = new Set();
  const resolving = new Set();
  const acknowledging = new Set();

  function generated(label) {
    let value;
    try { value = idFactory(label); } catch { return null; }
    return id(value) ? value : null;
  }

  function nativeMatches(request) {
    return request && NATIVE_METHODS.has(request.method) && request.threadId === threadId && request.turnId === turnId
      && id(request.itemId) && requestId(request.requestId) && request.nativeRequestId === requestKey(request.requestId)
      && request.authority?.sourceAuthenticated === true;
  }

  async function observe(request) {
    if (closed) return reject("bridge_closed");
    if (!nativeMatches(request)) return reject("native_correlation_mismatch");
    const key = requestKey(request.requestId);
    if (!key || rows.has(key) || observing.has(key) || closedRequests.has(key) || rows.size + observing.size >= maxPending) return reject("native_approval_conflict");
    const reservation = { closed: false };
    observing.set(key, reservation);
    try {
      const currentView = await journal.read(sessionId);
      if (currentView.kind !== "view") return currentView;
      const nativeSession = currentView.state.projection.session?.session?.native;
      const run = currentView.state.projection.runs.find(row => row.run.runId === runId);
      // The native IDs are accepted only after the journal's canonical
      // session/run identity confirms this exact app-server incarnation.
      if (!nativeSession || nativeSession.harnessId !== harnessId || nativeSession.nativeSessionId !== threadId
        || !run || run.nativeRunId !== turnId) return reject("native_identity_mismatch");
    const current = Number(now());
    if (!validTime(current)) return reject("invalid_time");
    const approvalId = generated("approval"), nonce = generated("nonce"), eventId = generated("event");
    if (!approvalId || !nonce || !eventId) return reject("id_generation_failed");
    const createdAt = new Date(current).toISOString(), expiresAt = new Date(current + approvalTtlMs).toISOString();
    const summary = text(request.summary) || text(request.params?.reason) || `Codex ${request.method} request`;
    // Native permission grants are scoped to the current turn or session.  A
    // protocol `run` approval is the only non-session scope that can be
    // represented without widening it; command/file requests remain `once`.
    const scope = request.method === "item/permissions/requestApproval" ? "run" : "once";
    const fact = { type: "approval.requested", payload: { approval: {
      approvalId, sessionId, runId, status: "pending", scope, expiresAt,
      request: { summary }, createdAt, nonce, toolId: null, nativeRequestId: String(request.nativeRequestId),
    } } };
    const committed = await journal.execute(sessionId, "planObservedEvents", [ [fact] ], {
      now: current, authenticatedDeviceId: deviceId, sessionId, runId, incarnationId,
      runtimeVerified: true, eventIds: [eventId], evidenceVerified: false,
    });
    if (committed.kind !== "committed") return committed;
    if (closed || reservation.closed || closedRequests.has(key)) return reject("bridge_closed");
    const row = { request: clone(request), approvalId, nonce, eventId, receiptId: null, dispatch: null, responseWritten: false, closed: false };
    rows.set(key, row);
    return { kind: "observed", approvalId, nonce, state: clone(committed.state), event: clone(committed.append.at(-1)) };
    } finally {
      if (observing.get(key) === reservation) observing.delete(key);
    }
  }

  async function authorizeNative(operation, context) {
    if (closed) return reject("bridge_closed");
    if (operation !== "approval.resolve") return authorizeOther(operation, context);
    const key = requestKey(context?.request?.requestId), row = key ? rows.get(key) : null, request = context?.request;
    if (!row || !request || row.closed || !row.dispatch || row.responseWritten || request.nativeRequestId !== row.request.nativeRequestId
      || request.threadId !== row.request.threadId || request.turnId !== row.request.turnId
      || request.itemId !== row.request.itemId
      || context.decision !== row.intent?.decision || context.scope !== row.intent?.scope) return reject("transaction_required");
    const view = await journal.read(sessionId);
    if (view.kind !== "view") return reject(view.code || "journal_unavailable");
    if (closed || rows.get(key) !== row || row.closed || row.responseWritten) return reject("transaction_required");
    const receipt = view.state.receipts.find(item => item.receiptId === row.receiptId);
    const outbox = view.state.outbox.find(item => item.receiptId === row.receiptId);
    if (!receipt || !outbox || receipt.state !== "dispatching" || receipt.attemptId !== row.dispatch.attemptId
      || outbox.dispatch?.incarnationId !== incarnationId || outbox.command.type !== "approval.resolve"
      || outbox.command.payload.approvalId !== row.approvalId || outbox.command.payload.nonce !== row.nonce
      || outbox.command.payload.runId !== runId || outbox.command.payload.decision !== context.decision
      || outbox.command.payload.scope !== context.scope) return reject("transaction_required");
    return clone(row.dispatch);
  }

  async function replayIntent(command, receiptId, current) {
    const replay = await journal.execute(sessionId, "planAdmission", [clone(command)], {
      now: current, authenticatedDeviceId: deviceId, sessionId, runId, receiptId: receiptId || command.commandId, eventIds: [],
    });
    if (replay.kind === "replay") return { kind: "replay", receiptId: replay.receipt.receiptId, receipt: replay.receipt, responseWritten: true, nativeAcknowledged: false };
    return replay;
  }

  async function resolve(requestValue, options = {}) {
    if (closed) return reject("bridge_closed");
    if (!options || typeof options !== "object" || Array.isArray(options)) return reject("native_approval_decision_invalid");
    const { decision, commandId = null, idempotencyKey = null } = options;
    const key = requestKey(requestValue), row = key ? rows.get(key) : null;
    const tombstone = key ? tombstones.get(key) : null;
    const hasCommandId = commandId !== null && commandId !== undefined;
    const hasIdempotencyKey = idempotencyKey !== null && idempotencyKey !== undefined;
    // Permissions requests are represented as protocol `run` scope (native
    // `turn` scope).  Derive that only when the caller omitted scope; an
    // explicit `once` remains a deliberate, rejected narrowing/expansion at
    // the native transport boundary.
    const scope = Object.hasOwn(options, "scope") ? options.scope
      : row?.request?.method === "item/permissions/requestApproval" ? "run" : tombstone?.intent?.scope || "once";
    if (!DECISIONS.has(decision) || !SCOPES.has(scope)) return reject("native_approval_decision_invalid");
    const priorIntent = row?.intent || tombstone?.intent || null;
    if (!row) {
      if (!tombstone || !priorIntent || priorIntent.decision !== decision || priorIntent.scope !== scope
        || hasCommandId && priorIntent.commandId !== commandId || hasIdempotencyKey && priorIntent.idempotencyKey !== idempotencyKey) return tombstone ? reject("idempotency_conflict") : reject("native_approval_unavailable");
      if (!priorIntent.command) return reject("native_approval_unavailable");
      const replay = await replayIntent(priorIntent.command, tombstone.receiptId, Number(now()));
      return replay.kind === "replay" ? { ...replay, responseWritten: tombstone.responseWritten, nativeAcknowledged: false } : replay;
    }
    if (priorIntent && (priorIntent.decision !== decision || priorIntent.scope !== scope
      || hasCommandId && priorIntent.commandId !== commandId || hasIdempotencyKey && priorIntent.idempotencyKey !== idempotencyKey)) return reject("idempotency_conflict");
    if (row.closed || row.responseWritten) {
      if (!row.intent?.command) return reject("native_approval_unavailable");
      const replay = await replayIntent(row.intent.command, row.receiptId, Number(now()));
      return replay.kind === "replay" ? { ...replay, responseWritten: row.responseWritten, nativeAcknowledged: false } : replay;
    }
    if (resolving.has(key)) return reject("resolve_in_flight");
    if (!transport || typeof transport.respondApproval !== "function") return reject("native_transport_unavailable");
    const current = Number(now());
    if (!validTime(current)) return reject("invalid_time");
    const intentCommandId = hasCommandId ? commandId : row.intent?.commandId || generated("command"), intentKey = hasIdempotencyKey ? idempotencyKey : row.intent?.idempotencyKey || generated("idempotency"), admissionEventId = row.intent?.eventId || generated("decision"), receiptId = row.intent?.receiptId || generated("receipt");
    if (!intentCommandId || !intentKey || !admissionEventId || !receiptId || !id(intentCommandId) || !id(intentKey)) return reject("id_generation_failed");
    row.intent = row.intent || { decision, scope, commandId: intentCommandId, idempotencyKey: intentKey, eventId: admissionEventId, receiptId, command: null };
    resolving.add(key);
    const command = { protocolVersion: 1, commandId: intentCommandId, deviceId, sessionId, type: "approval.resolve", idempotencyKey: intentKey,
      payload: { runId, approvalId: row.approvalId, nonce: row.nonce, decision, scope } };
    row.intent.command = clone(command);
    try {
      const admitted = await journal.execute(sessionId, "planAdmission", [command], {
        now: current, authenticatedDeviceId: deviceId, sessionId, runId, receiptId, eventIds: [admissionEventId],
      });
      if (admitted.kind !== "committed") return admitted;
      if (closed || row.closed || rows.get(key) !== row || closedRequests.has(key)) return reject("bridge_closed");
      const receipt = admitted.state.receipts.find(item => item.commandId === intentCommandId);
      if (!receipt) return reject("receipt_conflict");
      const attemptId = generated("attempt"); if (!attemptId) return reject("id_generation_failed");
      const dispatch = await journal.execute(sessionId, "planDispatch", [receipt.receiptId], {
        now: Number(now()), authenticatedDeviceId: deviceId, sessionId, runId, receiptRevision: receipt.revision,
        attemptId, incarnationId, eventIds: [],
      });
      if (dispatch.kind !== "committed") return dispatch;
      if (closed || row.closed || rows.get(key) !== row || closedRequests.has(key)) return reject("bridge_closed");
      const dispatched = dispatch.state.receipts.find(item => item.receiptId === receipt.receiptId);
      row.receiptId = receipt.receiptId;
      row.dispatch = { kind: "committed", receiptId: receipt.receiptId, attemptId: dispatched.attemptId, incarnationId };
      const native = await transport.respondApproval(row.request.requestId, { decision, scope });
      if (native.kind !== "written") return { kind: "dispatch_committed", code: "native_response_unavailable", receiptId: receipt.receiptId, dispatch: clone(dispatch.state) };
      row.responseWritten = true;
      // Native closure can race the writable callback.  The request row is
      // already detached in that case; keep the bounded tombstone's replay
      // metadata in sync with the actual write completion.
      const tombstone = tombstones.get(key);
      if (tombstone) {
        tombstone.responseWritten = true;
        tombstone.receiptId = receipt.receiptId;
      }
      // A successfully flushed write only means the pipe accepted bytes. This
      // deliberately advances to awaiting_confirmation; serverRequest/resolved
      // remains a closure observation and cannot settle the receipt.
      const pipe = await journal.execute(sessionId, "planPipeAccepted", [receipt.receiptId], {
        now: Number(now()), authenticatedDeviceId: deviceId, sessionId, runId, receiptRevision: dispatched.revision,
        attemptId: dispatched.attemptId, incarnationId, eventIds: [],
      });
      if (pipe.kind !== "committed") return { kind: "written", native, dispatch, pipe };
      return { kind: "written", native, admission: admitted, dispatch, pipe };
    } finally { resolving.delete(key); }
  }

  async function acknowledge(requestValue, details = {}) {
    if (closed) return reject("bridge_closed");
    if (!details || typeof details !== "object" || Array.isArray(details)) return reject("native_ack_details_invalid");
    let detachedDetails;
    try { detachedDetails = clone(details); } catch { return reject("native_ack_details_invalid"); }
    const key = requestKey(requestValue), entry = key ? rows.get(key) || tombstones.get(key) : null;
    if (!entry || !entry.request || !entry.receiptId || !entry.dispatch || entry.responseWritten !== true) return reject("native_ack_unavailable");
    if (acknowledging.has(key)) return reject("native_ack_in_flight");
    acknowledging.add(key);
    try {
      const current = Number(now());
      if (!validTime(current)) return reject("invalid_time");
      const view = await journal.read(sessionId);
      if (view.kind !== "view") return reject(view.code || "journal_unavailable");
      const receipt = view.state.receipts.find(item => item.receiptId === entry.receiptId);
      const outbox = view.state.outbox.find(item => item.receiptId === entry.receiptId);
      const approval = view.state.projection.approvals.find(item => item.approval.approvalId === entry.approvalId);
      if (!receipt || !outbox || !approval || outbox.command.type !== "approval.resolve"
        || outbox.command.payload.approvalId !== entry.approvalId || outbox.command.payload.runId !== runId
        || outbox.dispatch?.attemptId !== entry.dispatch.attemptId || outbox.dispatch?.incarnationId !== incarnationId
        || receipt.attemptId !== entry.dispatch.attemptId || approval.approval.nativeRequestId !== entry.request.nativeRequestId
        || approval.approval.nonce !== entry.nonce) return reject("native_ack_conflict");
      if (receipt.state === "succeeded" && approval.nativeAcknowledgement?.attemptId === entry.dispatch.attemptId
        && isDeepStrictEqual(approval.nativeAcknowledgement.evidence, entry.ackResult?.evidence)) {
        return { kind: "replay", receiptId: receipt.receiptId, receipt: clone(receipt), state: clone(view.state), nativeAcknowledged: true };
      }
      if (receipt.state !== "awaiting_confirmation") return reject("native_ack_unavailable");
      let request, verified;
      try {
        request = { request: clone(entry.request), receiptId: entry.receiptId, approvalId: entry.approvalId,
          nonce: entry.nonce, dispatch: clone(entry.dispatch), responseWritten: true, details: detachedDetails };
        verified = await verifyNativeAcknowledgement(request);
      } catch { return reject("native_ack_verification_failed"); }
      if (!verified || verified.kind !== "verified") return reject(verified?.kind === "reject" && id(verified.code) ? verified.code : "native_ack_unverified");
      if (!nativeEvidence(verified.evidence)) return reject("native_ack_unverified");
      if (closed) return reject("bridge_closed");
      const eventId = generated("ack-event");
      if (!eventId) return reject("id_generation_failed");
      const committed = await journal.execute(sessionId, "planApprovalAcknowledgement", [entry.receiptId], {
        now: current, authenticatedDeviceId: deviceId, sessionId, runId,
        receiptRevision: receipt.revision, attemptId: entry.dispatch.attemptId, incarnationId,
        nativeRequestId: entry.request.nativeRequestId, nonce: entry.nonce,
        evidenceVerified: true, evidence: clone(verified.evidence), eventIds: [eventId],
      });
      if (committed.kind !== "committed") return committed;
      const result = { kind: "acknowledged", receiptId: entry.receiptId, attemptId: entry.dispatch.attemptId,
        evidence: clone(verified.evidence), state: clone(committed.state), event: clone(committed.append.at(-1)) };
      entry.ackResult = clone(result);
      return result;
    } finally { acknowledging.delete(key); }
  }

  function handleEvent(event) {
    if (event?.type === "approval.resolved") {
      const key = requestKey(event.requestId), row = key ? rows.get(key) : null;
      const pendingObservation = key ? observing.get(key) : null;
      if (pendingObservation) pendingObservation.closed = true;
      if (key) closedRequests.add(key);
      if (closedRequests.size > maxPending * 2) closedRequests.delete(closedRequests.values().next().value);
      if (row) {
        row.closed = true;
        tombstones.set(key, { request: clone(row.request), approvalId: row.approvalId, nonce: row.nonce,
          receiptId: row.receiptId, responseWritten: row.responseWritten, dispatch: row.dispatch ? clone(row.dispatch) : null,
          ackResult: row.ackResult ? clone(row.ackResult) : null, intent: row.intent ? {
          decision: row.intent.decision, scope: row.intent.scope, commandId: row.intent.commandId,
          idempotencyKey: row.intent.idempotencyKey, eventId: row.intent.eventId, receiptId: row.intent.receiptId,
          command: row.intent.command ? clone(row.intent.command) : null,
        } : null });
        if (tombstones.size > maxPending * 2) tombstones.delete(tombstones.keys().next().value);
        rows.delete(key);
      }
    }
    if (typeof onEvent === "function") {
      try { onEvent(clone(event)); } catch {}
    }
  }

  function attach(nextTransport) {
    if (!nextTransport || typeof nextTransport.respondApproval !== "function") throw new TypeError("native_transport_required");
    if (transport && transport !== nextTransport) throw new Error("native_transport_already_attached");
    transport = nextTransport;
    return nextTransport;
  }

  function pending() {
    return [...rows.values()].map(row => clone(row));
  }

  function close() {
    closed = true;
    for (const row of rows.values()) { row.closed = true; row.dispatch = null; }
    rows.clear(); observing.clear(); closedRequests.clear(); tombstones.clear(); acknowledging.clear();
  }

  return Object.freeze({ acknowledge, attach, authorizeNative, close, observe, onEvent: handleEvent, pending, resolve });
}

module.exports = { createCodexApprovalBridge };
