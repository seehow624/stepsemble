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

test("a Grok process started while signed out is replaced once Grok is signed in", async t => {
  let signedIn = false, spawned = 0;
  const spawnImpl = () => {
    spawned++;
    const child = childFixture();
    const write = child.stdout.write.bind(child.stdout);
    // The fixture answers initialize with cached_token; while signed out Grok
    // offers only methods Stepsemble does not use without a key.
    child.stdout.write = chunk => {
      const text = String(chunk);
      if (!signedIn && text.includes("authMethods")) return write(text.replace('[{"id":"cached_token"}]', '[{"id":"xai.api_key"}]'));
      return write(chunk);
    };
    return child;
  };
  const adapter = createGrokAcpAdapter({ command: "/usr/local/bin/grok", cwd: "/tmp", env: {}, spawnImpl });
  t.after(() => adapter.close());
  const first = await adapter.createSession({ directory: "/tmp" });
  assert.equal(first.kind, "reject");
  assert.equal(first.code, "grok_auth_required");
  assert.notEqual(adapter.status().state, "degraded", "a signed-out start does not break the adapter");
  signedIn = true;
  const second = await adapter.createSession({ directory: "/tmp" });
  assert.equal(second.kind, "created");
  assert.equal(spawned, 2, "the retry starts a fresh Grok process");
  assert.equal(adapter.status().ready, true);
});


test("Grok ACP offers Default and Plan, the modes Grok confirms, and switches them with session/set_mode", async t => {
  const child = childFixture();
  const sent = [];
  child.stdin.on("data", chunk => { for (const line of chunk.toString().split(/\n/).filter(Boolean)) sent.push(JSON.parse(line)); });
  const adapter = createGrokAcpAdapter({ command: "/usr/local/bin/grok", cwd: "/tmp", env: { XAI_API_KEY: "fixture" }, spawnImpl: () => child });
  t.after(() => adapter.close());
  const session = await adapter.createSession({ directory: "/tmp" });
  const mode = adapter.sessionConfigOptions(session.sessionId).find(option => option.category === "mode");
  assert.deepEqual(mode.options.map(choice => choice.value), ["default", "plan"]);
  assert.equal(mode.currentValue, "default");
  assert.equal((await adapter.setConfigOption(session.sessionId, mode.id, "plan")).value, "plan");
  assert.deepEqual(sent.filter(frame => frame.method === "session/set_mode").map(frame => frame.params.modeId), ["plan"]);
  assert.equal(adapter.sessionConfigOptions(session.sessionId).find(option => option.category === "mode").currentValue, "plan");
  // A mode Grok would accept without applying is never sent.
  assert.equal((await adapter.setConfigOption(session.sessionId, mode.id, "bypassPermissions")).code, "grok_config_invalid");
});
