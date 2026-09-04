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
]);
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

function normalizeConnectorEvent(value, { taskId = "", agentId = "" } = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const type = safeText(value.type, 32).toLowerCase();
  if (!CONNECTOR_EVENT_TYPES.includes(type)) return null;
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
  CONNECTOR_STATUSES,
  normalizeConnectorDefinition,
  normalizeConnectorEvent,
  parseConnectorEventLine,
};
