const test = require("node:test");
const assert = require("node:assert/strict");
const {
  CONNECTOR_PROTOCOL_VERSION,
  CONNECTOR_PROTOCOL_EVENT_TYPES,
  STRUCTURED_EVENT_PREFIX,
  normalizeConnectorDefinition,
  normalizeConnectorEvent,
  normalizeConnectorProtocolEvent,
  parseConnectorEventLine,
  parseConnectorProtocolEventLine,
} = require("../server/connector-protocol");

const approvalEvent = (overrides = {}) => ({
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

test("connector protocol normalizes a safe manifest and lifecycle event", () => {
  const manifest = normalizeConnectorDefinition({
    id: "Claude-Code",
    label: "Claude Code",
    kind: "cli",
    capabilities: ["terminal", "TERMINAL", "streaming"],
  });
  assert.equal(manifest.protocolVersion, CONNECTOR_PROTOCOL_VERSION);
  assert.deepEqual(manifest.capabilities, ["terminal", "streaming"]);
  assert.ok(manifest.events.includes("task_exit"));
  assert.ok(manifest.events.includes("protocol_event"));
  assert.deepEqual(CONNECTOR_PROTOCOL_EVENT_TYPES, ["approval.requested"]);

  const event = normalizeConnectorEvent({ type: "status", status: "waiting", error: "need input" }, {
    taskId: "task-123",
    agentId: "claude-code",
  });
  assert.deepEqual(event, { type: "status", taskId: "task-123", agentId: "claude-code", status: "waiting", error: "need input" });
  assert.equal(parseConnectorEventLine(JSON.stringify(event), { taskId: "task-123" }).status, "waiting");

  const input = normalizeConnectorEvent({ type: "input", text: "printf 'hello'", truncated: true, at: 123 }, {
    taskId: "task-123", agentId: "claude-code",
  });
  assert.deepEqual(input, { type: "input", taskId: "task-123", agentId: "claude-code", at: 123, text: "printf 'hello'", truncated: true });
});

test("connector protocol accepts only an explicitly prefixed approval observation", () => {
  const value = approvalEvent();
  const normalized = normalizeConnectorProtocolEvent(value, { taskId: "task-123", agentId: "claude-code" });
  assert.equal(normalized.type, "protocol_event");
  assert.equal(normalized.event.type, "approval.requested");
  assert.equal(normalized.event.payload.approval.request.summary, "Run the synthetic formatter");
  assert.deepEqual(normalized.authority, { sourceAuthenticated: false, approvalAcknowledged: false, resumeAllowed: false });
  const line = `${STRUCTURED_EVENT_PREFIX}${JSON.stringify(value)}`;
  const parsed = parseConnectorProtocolEventLine(line, { taskId: "task-123", agentId: "claude-code" });
  assert.deepEqual(parsed, normalized);
  assert.equal(parseConnectorEventLine(JSON.stringify({ type: "protocol_event", event: value }), { taskId: "task-123" }), null, "the generic JSON parser cannot bypass the structured prefix");
  assert.equal(parseConnectorProtocolEventLine(JSON.stringify(value), { taskId: "task-123" }), null, "without the prefix ordinary output stays ordinary output");
});

test("connector protocol rejects arbitrary or oversized event lines", () => {
  assert.equal(normalizeConnectorEvent({ type: "exec", command: "rm -rf /" }), null);
  assert.equal(normalizeConnectorEvent({ type: "status", status: "unknown" }), null);
  assert.equal(parseConnectorEventLine("plain terminal output"), null);
  assert.equal(parseConnectorEventLine(`{"type":"output","text":"${"x".repeat(70 * 1024)}"}`), null);
  assert.equal(parseConnectorProtocolEventLine(`${STRUCTURED_EVENT_PREFIX}${JSON.stringify({ ...approvalEvent(), type: "approval.resolved" })}`), null, "the CLI cannot self-approve or claim native acknowledgement");
  assert.equal(parseConnectorProtocolEventLine(`${STRUCTURED_EVENT_PREFIX}${JSON.stringify({ ...approvalEvent(), sessionId: "foreign" })}`), null);
  assert.equal(parseConnectorProtocolEventLine(`${STRUCTURED_EVENT_PREFIX}${JSON.stringify({ ...approvalEvent(), payload: { approval: { ...approvalEvent().payload.approval, expiresAt: "2026-09-09T23:59:59.000Z" } } })}`), null);
  assert.equal(parseConnectorProtocolEventLine(`${STRUCTURED_EVENT_PREFIX}${JSON.stringify({ ...approvalEvent(), payload: { approval: { ...approvalEvent().payload.approval, expiresAt: "2026-09-10T00:00:00.500Z" } }, createdAt: "2026-09-10T00:00:01.000Z" })}`), null, "an event observed after expiry is not a live pending request");
  assert.equal(parseConnectorProtocolEventLine(`${STRUCTURED_EVENT_PREFIX}${"x".repeat(128 * 1024)}`), null);
  const throwing = {};
  Object.defineProperty(throwing, "type", { enumerable: true, get() { throw new Error("untrusted accessor"); } });
  assert.equal(normalizeConnectorProtocolEvent(throwing), null, "accessors are rejected without escaping the parser");
  const symbolExtra = { ...approvalEvent() };
  symbolExtra[Symbol("untrusted")] = true;
  assert.equal(normalizeConnectorProtocolEvent(symbolExtra), null, "symbol/hidden fields cannot bypass the closed shape");
});
