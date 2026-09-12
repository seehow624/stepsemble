"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { PassThrough } = require("node:stream");
const { EventEmitter } = require("node:events");
const { normalizeUpdate, createGrokAcpAdapter } = require("../server/grok-acp-adapter");

function childFixture() {
  const child = new EventEmitter();
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.kill = () => child.emit("close", 0, null);
  child.stdin.on("data", chunk => {
    for (const line of chunk.toString().split(/\n/).filter(Boolean)) {
      const frame = JSON.parse(line);
      let result = {};
      if (frame.method === "initialize") result = { authMethods: [{ id: "cached_token" }] };
      else if (frame.method === "authenticate") result = {};
      else if (frame.method === "session/new") result = { sessionId: "session-1" };
      else if (frame.method === "session/prompt") {
        child.stdout.write(JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "session-1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hello" } } } }) + "\n");
        result = { stopReason: "end_turn" };
      }
      child.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: frame.id, result }) + "\n");
    }
  });
  return child;
}

test("Grok ACP update normalization is bounded and session-correlated", () => {
  const update = normalizeUpdate({ sessionId: "session-1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hi" } } });
  assert.equal(update.sessionId, "session-1");
  assert.equal(update.update.content.text, "hi");
  assert.equal(normalizeUpdate({ sessionId: "../bad", update: { sessionUpdate: "agent_message_chunk" } }), null);
});

test("Grok ACP performs initialize/authenticate/session/prompt through JSON-RPC", async t => {
  const child = childFixture();
  const updates = [];
  const adapter = createGrokAcpAdapter({ command: "/usr/local/bin/grok", cwd: "/tmp", env: { XAI_API_KEY: "fixture" }, spawnImpl: () => child, onUpdate: update => updates.push(update) });
  t.after(() => adapter.close());
  const session = await adapter.createSession({ directory: "/tmp" });
  assert.equal(session.kind, "created");
  assert.equal(adapter.status().ready, true);
  const prompted = await adapter.prompt(session.sessionId, "hello");
  assert.equal(prompted.kind, "prompted");
  assert.equal(updates[0].update.content.text, "hello");
  assert.equal(adapter.sessionEvents(session.sessionId)[0].type, "session.update");
  assert.equal((await adapter.close()).cleanupConfirmed, true);
});

test("Grok ACP accepts multiline prompts but rejects an option not offered by upstream", async t => {
  const child = childFixture();
  const adapter = createGrokAcpAdapter({ command: "/usr/local/bin/grok", cwd: "/tmp", env: { XAI_API_KEY: "fixture" }, spawnImpl: () => child });
  t.after(() => adapter.close());
  const session = await adapter.createSession({ directory: "/tmp" });
  const sent = await adapter.prompt(session.sessionId, "line one\nline two");
  assert.equal(sent.kind, "prompted");
  child.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: 101, method: "session/request_permission", params: {
    sessionId: session.sessionId,
    options: [{ optionId: "allow-once", name: "Allow once", kind: "allow_once" }],
  } }) + "\n");
  assert.equal(adapter.respondPermission(101, { outcome: { outcome: "selected", optionId: "never-offered" } }).code, "grok_permission_option_invalid");
  assert.equal(adapter.pendingPermissions().length, 1);
});

test("Grok ACP keeps permission requests pending until an explicit response", async t => {
  const child = childFixture();
  const adapter = createGrokAcpAdapter({ command: "/usr/local/bin/grok", cwd: "/tmp", spawnImpl: () => child });
  t.after(() => adapter.close());
  await adapter.initialize();
  child.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: 99, method: "session/request_permission", params: {
    sessionId: "session-1", toolCall: { title: "bash" },
    options: [{ optionId: "allow-once", name: "Allow once", kind: "allow_once" }, { optionId: "reject-once", name: "Reject", kind: "reject_once" }],
  } }) + "\n");
  assert.equal(adapter.pendingPermissions().length, 1);
  assert.equal(adapter.respondPermission(99, { outcome: { outcome: "selected", optionId: "reject-once" } }).kind, "written");
  assert.equal(adapter.pendingPermissions().length, 0);
});
