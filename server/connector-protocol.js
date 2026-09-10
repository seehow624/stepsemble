"use strict";

// Versioned boundary for non-Pi connectors.  A connector remains an
// allow-listed executable, but the contract is explicit enough for future
// adapters (Codex, Claude Code, Grok Build, OpenCode, or a user-supplied
// signed adapter) to advertise capabilities and structured lifecycle events
// without changing the Agent Hub API.
const CONNECTOR_PROTOCOL_VERSION = 1;
const CONNECTOR_EVENT_TYPES = Object.freeze([
  "task_started",
  "output",
  "status",
  "input",
  "task_exit",
  // A deliberately separate envelope for versioned, machine-readable
  // observations.  It is not a journal event and carries no authority on its
  // own; the Host must still correlate and admit any resulting command.
  "protocol_event",
]);
const CONNECTOR_PROTOCOL_EVENT_TYPES = Object.freeze(["approval.requested"]);
const CONNECTOR_STATUSES = Object.freeze([
  "starting",
  "running",
  "waiting",
  "reconnecting",
  "completed",
  "failed",
  "stopped",
  "detached",
  "orphaned",
]);

function safeText(value, limit = 2000) {
  return String(value ?? "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ")
    .slice(0, limit);
}

function normalizeConnectorDefinition(definition) {
  if (!definition || typeof definition !== "object") return null;
  const id = safeText(definition.id, 64).toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{0,47}$/.test(id)) return null;
  const capabilities = [...new Set((Array.isArray(definition.capabilities) ? definition.capabilities : [])
    .map((value) => safeText(value, 48).toLowerCase()).filter(Boolean))];
  return {
    protocolVersion: CONNECTOR_PROTOCOL_VERSION,
    id,
    label: safeText(definition.label || id, 120),
    kind: definition.kind === "native" ? "native" : "cli",
    capabilities,
    events: [...CONNECTOR_EVENT_TYPES],
  };
}

const PROTOCOL_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const NATIVE_EVENT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}[Tt]\d{2}:[0-5]\d:[0-5]\d(?:\.\d{1,3})?(?:[Zz]|[+-]\d{2}:\d{2})$/;
const APPROVAL_SCOPES = new Set(["once", "run", "session"]);
const APPROVAL_EVENT_KEYS = ["type", "sessionId", "runId", "nativeEventId", "createdAt", "payload"];
const APPROVAL_KEYS = ["approvalId", "sessionId", "runId", "status", "scope", "expiresAt", "request", "createdAt", "nonce", "toolId", "nativeRequestId"];

function exactObject(value, keys) {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const ownKeys = Reflect.ownKeys(value);
    return ownKeys.length === keys.length && ownKeys.every(key => typeof key === "string" && keys.includes(key));
  } catch { return false; }
}

function validProtocolId(value) {
  return typeof value === "string" && PROTOCOL_ID.test(value);
}

function validNativeEventId(value) {
  return typeof value === "string" && NATIVE_EVENT_ID.test(value);
}

function validTimestamp(value) {
  if (typeof value !== "string" || !ISO_TIMESTAMP.test(value)) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() !== "Invalid Date";
}

/**
 * Normalize the one structured native observation currently admitted for a
 * generic connector.  The line is intentionally not a full protocol/v1 event:
 * eventId/sequence/generation belong to the Host journal.  This object is an
 * untrusted observation and can never acknowledge, approve or resume work.
 */
function normalizeConnectorProtocolEvent(value, { taskId = "", agentId = "" } = {}) {
  try {
    if (!exactObject(value, APPROVAL_EVENT_KEYS) || value.type !== "approval.requested"
      || !validProtocolId(value.sessionId) || !validProtocolId(value.runId)
      || !validNativeEventId(value.nativeEventId) || !validTimestamp(value.createdAt)
      || !exactObject(value.payload, ["approval"])) return null;
    const approval = value.payload.approval;
    if (!exactObject(approval, APPROVAL_KEYS)
      || !validProtocolId(approval.approvalId)
      || !validProtocolId(approval.sessionId) || approval.sessionId !== value.sessionId
      || !validProtocolId(approval.runId) || approval.runId !== value.runId
      || approval.status !== "pending" || !APPROVAL_SCOPES.has(approval.scope)
      || !validTimestamp(approval.expiresAt) || Date.parse(approval.expiresAt) <= Date.parse(approval.createdAt)
      || Date.parse(approval.expiresAt) <= Date.parse(value.createdAt)
      || !validTimestamp(approval.createdAt) || Date.parse(approval.createdAt) > Date.parse(value.createdAt)
      || !exactObject(approval.request, ["summary"])
      || typeof approval.request.summary !== "string" || approval.request.summary.length < 1 || approval.request.summary.length > 512
      || !validProtocolId(approval.nonce)
      || (approval.toolId !== null && !validProtocolId(approval.toolId))
      || typeof approval.nativeRequestId !== "string" || approval.nativeRequestId.length < 1 || approval.nativeRequestId.length > 512
      || /[\u0000-\u001f\u007f]/.test(approval.nativeRequestId)) return null;
    const normalized = {
      type: "approval.requested",
      sessionId: value.sessionId,
      runId: value.runId,
      nativeEventId: value.nativeEventId,
      createdAt: value.createdAt,
      payload: { approval: structuredClone(approval) },
    };
    return {
      type: "protocol_event",
      taskId: safeText(taskId, 80),
      ...(agentId ? { agentId: safeText(agentId, 64) } : {}),
      event: normalized,
      // Keep the boundary explicit for consumers.  This is an observation only;
      // no source authentication, native ACK or resume authority is implied.
      authority: { sourceAuthenticated: false, approvalAcknowledged: false, resumeAllowed: false },
    };
  } catch { return null; }
}

const STRUCTURED_EVENT_PREFIX = "STEPSEMBLE_EVENT ";

function parseConnectorProtocolEventLine(line, context = {}) {
  const raw = String(line ?? "");
  if (!raw.startsWith(STRUCTURED_EVENT_PREFIX) || Buffer.byteLength(raw, "utf8") > 128 * 1024) return null;
  try {
    const parsed = JSON.parse(raw.slice(STRUCTURED_EVENT_PREFIX.length));
    return normalizeConnectorProtocolEvent(parsed, context);
  } catch { return null; }
}

function normalizeConnectorEvent(value, { taskId = "", agentId = "" } = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const type = safeText(value.type, 32).toLowerCase();
  if (!CONNECTOR_EVENT_TYPES.includes(type)) return null;
  // Structured observations must come through parseConnectorProtocolEventLine
  // and its explicit stdout prefix. Never let a generic JSON envelope bypass
  // that source boundary.
  if (type === "protocol_event") return null;
  const event = { type, taskId: safeText(value.taskId || taskId, 80) };
  if (agentId) event.agentId = safeText(agentId, 64);
  if (type === "output") {
    event.stream = value.stream === "stderr" ? "stderr" : "stdout";
    event.text = safeText(value.text, 32 * 1024);
    if (!event.text) return null;
  } else if (type === "status") {
    const status = safeText(value.status, 24);
    if (!CONNECTOR_STATUSES.includes(status)) return null;
    event.status = status;
    if (value.error) event.error = safeText(value.error);
  } else if (type === "input") {
    event.at = Number.isFinite(Number(value.at)) ? Number(value.at) : Date.now();
  } else if (type === "task_exit") {
    const status = safeText(value.status, 24);
    if (status && !CONNECTOR_STATUSES.includes(status)) return null;
    if (status) event.status = status;
    if (Number.isInteger(value.code)) event.code = value.code;
    if (value.signal) event.signal = safeText(value.signal, 32);
    if (value.error) event.error = safeText(value.error);
  }
  return event;
}

function parseConnectorEventLine(line, context = {}) {
  const raw = String(line ?? "").trim();
  if (!raw || raw.length > 64 * 1024 || raw[0] !== "{") return null;
  try { return normalizeConnectorEvent(JSON.parse(raw), context); } catch { return null; }
}

module.exports = {
  CONNECTOR_PROTOCOL_VERSION,
  CONNECTOR_EVENT_TYPES,
  CONNECTOR_PROTOCOL_EVENT_TYPES,
  CONNECTOR_STATUSES,
  STRUCTURED_EVENT_PREFIX,
  normalizeConnectorDefinition,
  normalizeConnectorEvent,
  normalizeConnectorProtocolEvent,
  parseConnectorEventLine,
  parseConnectorProtocolEventLine,
};
