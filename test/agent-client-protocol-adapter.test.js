"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { PassThrough } = require("node:stream");
const { EventEmitter } = require("node:events");
const { normalizeUpdate, createAgentClientProtocolAdapter } = require("../server/agent-client-protocol-adapter");

function childFixture({ configOptions = null } = {}) {
  const child = new EventEmitter();
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.kill = () => child.emit("close", 0, null);
  child.prompts = [];
  child.stdin.on("data", chunk => {
    for (const line of chunk.toString().split(/\n/).filter(Boolean)) {
      const frame = JSON.parse(line);
      let result = {};
      if (frame.method === "initialize") result = { agentCapabilities: { loadSession: true } };
      else if (frame.method === "session/new" || frame.method === "session/load") {
        result = { sessionId: "session-1", ...(configOptions ? { configOptions } : {}) };
      }
      else if (frame.method === "session/set_config_option") {
        result = { configOptions: (configOptions || []).map(option => option.id === frame.params.configId
          ? { ...option, currentValue: frame.params.value } : option) };
      }
      else if (frame.method === "session/prompt") {
        child.prompts.push(frame.params.prompt);
        child.stdout.write(JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "session-1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hello" } } } }) + "\n");
        result = { stopReason: "end_turn" };
      }
      if (Object.hasOwn(frame, "id")) child.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: frame.id, result }) + "\n");
    }
  });
  return child;
}

test("ACP update normalization is bounded and session-correlated", () => {
  const update = normalizeUpdate({ sessionId: "session-1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hi" } } });
  assert.equal(update.sessionId, "session-1");
  assert.equal(update.update.content.text, "hi");
  assert.equal(normalizeUpdate({ sessionId: "../bad", update: { sessionUpdate: "agent_message_chunk" } }), null);
});

test("ACP adapter initializes, creates, prompts, and cancels through standard methods", async t => {
  const child = childFixture();
  const updates = [];
  const adapter = createAgentClientProtocolAdapter({ command: "/usr/local/bin/kilo", args: ["acp"], cwd: "/tmp", spawnImpl: () => child, onUpdate: update => updates.push(update) });
  t.after(() => adapter.close());
  const session = await adapter.createSession({ directory: "/tmp" });
  assert.equal(session.kind, "created");
  assert.equal(adapter.status().ready, true);
  const prompted = await adapter.prompt(session.sessionId, "hello");
  assert.equal(prompted.kind, "prompted");
  assert.equal(updates[0].update.content.text, "hello");
  assert.equal(adapter.sessionEvents(session.sessionId)[0].type, "session.update");
  assert.equal((await adapter.cancel(session.sessionId)).kind, "cancelled");
});

test("ACP prompts carry image attachments beside their text", async t => {
  const child = childFixture();
  const adapter = createAgentClientProtocolAdapter({ command: "/usr/local/bin/kilo", args: ["acp"], cwd: "/tmp", spawnImpl: () => child });
  t.after(() => adapter.close());
  const session = await adapter.createSession({ directory: "/tmp" });
  const png = "iVBORw0KGgoAAAANSUhEUg==";

  await adapter.prompt(session.sessionId, "what is this?", {
    images: [{ data: `data:image/png;base64,${png}`, mimeType: "image/png" }],
  });
  assert.deepEqual(child.prompts.at(-1), [
    { type: "text", text: "what is this?" },
    { type: "image", data: png, mimeType: "image/png" },
  ]);

  // An image with no question is a legitimate prompt and must not be refused.
  await adapter.prompt(session.sessionId, "", { images: [{ data: png, mimeType: "image/png" }] });
  assert.deepEqual(child.prompts.at(-1), [{ type: "image", data: png, mimeType: "image/png" }]);

  // Text alone still works, and an empty prompt is still rejected.
  await adapter.prompt(session.sessionId, "plain");
  assert.deepEqual(child.prompts.at(-1), [{ type: "text", text: "plain" }]);
  assert.equal((await adapter.prompt(session.sessionId, "")).code, "acp_prompt_invalid");
});

test("ACP model choice is read and applied through session config options", async t => {
  const configOptions = [
    { id: "model", name: "Model", category: "model", currentValue: "fast",
      options: [{ value: "fast", name: "Fast" }, { value: "deep", name: "Deep" }] },
    { id: "mode", name: "Mode", category: "mode", currentValue: "ask", options: [{ value: "ask", name: "Ask" }] },
  ];
  const child = childFixture({ configOptions });
  const adapter = createAgentClientProtocolAdapter({ command: "/usr/local/bin/kilo", args: ["acp"], cwd: "/tmp", spawnImpl: () => child });
  t.after(() => adapter.close());
  const session = await adapter.createSession({ directory: "/tmp" });

  assert.equal(session.configOptions.length, 2);
  assert.equal(adapter.sessionConfigOptions(session.sessionId)[0].currentValue, "fast");

  const applied = await adapter.setConfigOption(session.sessionId, "model", "deep");
  assert.equal(applied.kind, "configured");
  // The agent's reply is authoritative: the stored list must reflect it.
  assert.equal(adapter.sessionConfigOptions(session.sessionId).find(o => o.id === "model").currentValue, "deep");

  assert.equal((await adapter.setConfigOption(session.sessionId, "", "deep")).code, "acp_config_invalid");
  assert.equal((await adapter.setConfigOption("missing", "model", "deep")).code, "acp_session_unavailable");
});

test("ACP permissions remain pending until a valid offered option is selected", async t => {
  const child = childFixture();
  const adapter = createAgentClientProtocolAdapter({ command: "/usr/local/bin/hermes", args: ["acp"], cwd: "/tmp", spawnImpl: () => child });
  t.after(() => adapter.close());
  await adapter.initialize();
  child.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: 99, method: "session/request_permission", params: {
    sessionId: "session-1", toolCall: { title: "run command" },
    options: [{ optionId: "allow-once", name: "Allow once", kind: "allow_once" }, { optionId: "reject-once", name: "Reject", kind: "reject_once" }],
  } }) + "\n");
  assert.equal(adapter.pendingPermissions().length, 1);
  assert.equal(adapter.respondPermission(99, { outcome: { outcome: "selected", optionId: "never-offered" } }).code, "acp_permission_option_invalid");
  assert.equal(adapter.respondPermission(99, { outcome: { outcome: "selected", optionId: "reject-once" } }).kind, "written");
  assert.equal(adapter.pendingPermissions().length, 0);
});

test("ACP restart index preserves upstream session identity without private history reads", async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "stepsemble-acp-registry-"));
  const registryFile = path.join(directory, "sessions.json");
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const first = createAgentClientProtocolAdapter({ command: "/usr/local/bin/hermes", args: ["acp"], cwd: "/tmp", registryFile, spawnImpl: () => childFixture() });
  assert.equal((await first.createSession({ directory: "/tmp", name: "Saved session" })).sessionId, "session-1");
  await first.close();
  const second = createAgentClientProtocolAdapter({ command: "/usr/local/bin/hermes", args: ["acp"], cwd: "/tmp", registryFile, spawnImpl: () => childFixture() });
  t.after(() => second.close());
  const persisted = second.sessions().find(row => row.id === "session-1");
  assert.equal(persisted.loaded, false);
  assert.equal(persisted.persisted, true);
  assert.equal(persisted.name, "Saved session");
  assert.equal((await second.loadSession("session-1", "/tmp")).kind, "loaded");
  assert.equal(second.sessions().find(row => row.id === "session-1").loaded, true);
});
