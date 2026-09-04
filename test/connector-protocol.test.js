const test = require("node:test");
const assert = require("node:assert/strict");
const {
  CONNECTOR_PROTOCOL_VERSION,
  normalizeConnectorDefinition,
  normalizeConnectorEvent,
  parseConnectorEventLine,
} = require("../server/connector-protocol");

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

  const event = normalizeConnectorEvent({ type: "status", status: "waiting", error: "need input" }, {
    taskId: "task-123",
    agentId: "claude-code",
  });
  assert.deepEqual(event, { type: "status", taskId: "task-123", agentId: "claude-code", status: "waiting", error: "need input" });
  assert.equal(parseConnectorEventLine(JSON.stringify(event), { taskId: "task-123" }).status, "waiting");
});

test("connector protocol rejects arbitrary or oversized event lines", () => {
  assert.equal(normalizeConnectorEvent({ type: "exec", command: "rm -rf /" }), null);
  assert.equal(normalizeConnectorEvent({ type: "status", status: "unknown" }), null);
  assert.equal(parseConnectorEventLine("plain terminal output"), null);
  assert.equal(parseConnectorEventLine(`{"type":"output","text":"${"x".repeat(70 * 1024)}"}`), null);
});
