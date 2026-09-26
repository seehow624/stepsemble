"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { PassThrough } = require("node:stream");
const { EventEmitter } = require("node:events");
const { normalizeUpdate, createAgentClientProtocolAdapter, LEGACY_MODE_OPTION, configOptionsFromSession, applyConfigUpdate } = require("../server/agent-client-protocol-adapter");

function childFixture({ configOptions = null, modes = null } = {}) {
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
        result = { sessionId: "session-1", ...(configOptions ? { configOptions } : {}), ...(modes ? { modes } : {}) };
      }
      else if (frame.method === "session/set_mode") {
        child.modeRequests = [...(child.modeRequests || []), frame.params];
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
  const pending = adapter.prompt(session.sessionId, "hello");
  assert.equal(adapter.sessionWorking(session.sessionId), true, "working while the prompt is answered");
  const prompted = await pending;
  assert.equal(prompted.kind, "prompted");
  assert.equal(adapter.sessionWorking(session.sessionId), false);
  assert.equal(adapter.sessions().find(row => row.id === session.sessionId).status, "idle", "a finished turn leaves the session idle");
  assert.equal(updates[0].update.content.text, "hello");
  assert.equal(adapter.sessionEvents(session.sessionId)[0].type, "session.update");
  assert.equal((await adapter.cancel(session.sessionId)).kind, "cancelled");
});

test("an ACP turn outlasts the request time limit", async t => {
  const child = new EventEmitter();
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.kill = () => child.emit("close", 0, null);
  child.stdin.on("data", chunk => {
    for (const line of chunk.toString().split(/\n/).filter(Boolean)) {
      const frame = JSON.parse(line);
      const reply = result => child.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: frame.id, result }) + "\n");
      if (frame.method === "initialize") reply({ agentCapabilities: {} });
      else if (frame.method === "session/new") reply({ sessionId: "session-1" });
      else if (frame.method === "session/prompt") setTimeout(() => reply({ stopReason: "end_turn" }), 80);
    }
  });
  const adapter = createAgentClientProtocolAdapter({ command: "/usr/local/bin/kilo", args: ["acp"], cwd: "/tmp", spawnImpl: () => child, requestTimeoutMs: 20 });
  t.after(() => adapter.close());
  const session = await adapter.createSession({ directory: "/tmp" });
  const result = await adapter.prompt(session.sessionId, "a long task");
  assert.equal(result.kind, "prompted", "a turn is not cut off by the 30-second request limit");
  assert.equal(result.result.stopReason, "end_turn");
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

test("ACP modes in the older modes form are offered as one option and changed with session/set_mode", async t => {
  // Hermes 0.21 answers session/new with modes rather than config options.
  const child = childFixture({ modes: { currentModeId: "default", availableModes: [
    { id: "default", name: "Default", description: "Ask before edits." },
    { id: "accept_edits", name: "Accept Edits", description: "Auto-allow workspace and temp-dir edits; still asks for sensitive paths." },
    { id: "dont_ask", name: "Don't Ask", description: "Auto-allow file edits for this session except sensitive paths." },
  ] } });
  const adapter = createAgentClientProtocolAdapter({ command: "/usr/local/bin/hermes", args: ["acp"], cwd: "/tmp", spawnImpl: () => child });
  t.after(() => adapter.close());
  const session = await adapter.createSession({ directory: "/tmp" });
  const mode = session.configOptions.find(option => option.category === "mode");
  assert.equal(mode.id, LEGACY_MODE_OPTION);
  assert.equal(mode.currentValue, "default");
  assert.deepEqual(mode.options.map(option => option.value), ["default", "accept_edits", "dont_ask"]);
  const changed = await adapter.setConfigOption(session.sessionId, LEGACY_MODE_OPTION, "accept_edits");
  assert.equal(changed.kind, "configured");
  assert.deepEqual(child.modeRequests, [{ sessionId: "session-1", modeId: "accept_edits" }]);
  assert.equal(adapter.sessionConfigOptions(session.sessionId).find(option => option.category === "mode").currentValue, "accept_edits");
  assert.equal((await adapter.setConfigOption(session.sessionId, LEGACY_MODE_OPTION, "yolo")).code, "acp_config_invalid");
  // The agent may change the mode itself; its update is followed.
  child.stdout.write(JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "session-1", update: { sessionUpdate: "current_mode_update", currentModeId: "dont_ask" } } }) + "\n");
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(adapter.sessionConfigOptions(session.sessionId).find(option => option.category === "mode").currentValue, "dont_ask");
});

test("ACP config option updates replace the options and keep the mode current", () => {
  const model = { id: "model", name: "Model", category: "model", type: "select", currentValue: "a", options: [{ value: "a" }, { value: "b" }] };
  const mode = { id: "mode", name: "Mode", category: "mode", type: "select", currentValue: "code", options: [{ value: "code", name: "Code" }, { value: "plan", name: "Plan" }] };
  const options = configOptionsFromSession({ configOptions: [model, mode], modes: { currentModeId: "x", availableModes: [{ id: "x" }] } });
  // A "mode" config option wins; the older modes form is not added beside it.
  assert.deepEqual(options.map(option => option.id), ["model", "mode"]);
  const updated = applyConfigUpdate(options, { sessionUpdate: "config_option_update", configOptions: [model, { ...mode, currentValue: "plan" }] });
  assert.equal(updated.find(option => option.id === "mode").currentValue, "plan");
  assert.equal(applyConfigUpdate(updated, { sessionUpdate: "agent_message_chunk" }), updated);
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

test("an ACP message is kept with the conversation's updates, and a refusal keeps the agent's reason", async t => {
  const child = new EventEmitter();
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.kill = () => child.emit("close", 0, null);
  child.stdin.on("data", chunk => {
    for (const line of chunk.toString().split(/\n/).filter(Boolean)) {
      const frame = JSON.parse(line);
      const reply = value => child.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: frame.id, ...value }) + "\n");
      if (frame.method === "initialize") reply({ result: { agentCapabilities: {} } });
      else if (frame.method === "session/new") reply({ result: { sessionId: "session-1" } });
      else if (frame.method === "session/prompt" && frame.params.prompt[0].text === "refused") {
        reply({ error: { code: -32603, message: "Internal error: You need to sign in to use this model." } });
      } else if (frame.method === "session/prompt") {
        child.stdout.write(JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "session-1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hi" } } } }) + "\n");
        reply({ result: { stopReason: "end_turn" } });
      }
    }
  });
  const adapter = createAgentClientProtocolAdapter({ command: "/usr/local/bin/kilo", args: ["acp"], cwd: "/tmp", spawnImpl: () => child });
  t.after(() => adapter.close());
  await adapter.createSession({ directory: "/tmp" });
  assert.equal((await adapter.prompt("session-1", "hello there")).kind, "prompted");
  // Agents do not repeat the person's message while they answer; a reloaded
  // page shows it above the answer from the kept copy.
  assert.deepEqual(adapter.sessionEvents("session-1").map(row => [row.update.sessionUpdate, row.update.content.text]),
    [["user_message_chunk", "hello there"], ["agent_message_chunk", "hi"]]);
  const refused = await adapter.prompt("session-1", "refused");
  assert.equal(refused.kind, "reject");
  assert.equal(refused.code, "acp_request_rejected");
  assert.equal(refused.error, "Internal error: You need to sign in to use this model.");
});

test("loading an ACP conversation keeps the agent's replay and takes the id asked for", async t => {
  const child = new EventEmitter();
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.kill = () => child.emit("close", 0, null);
  child.stdin.on("data", chunk => {
    for (const line of chunk.toString().split(/\n/).filter(Boolean)) {
      const frame = JSON.parse(line);
      const reply = result => child.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: frame.id, result }) + "\n");
      const update = value => child.stdout.write(JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "saved-1", update: value } }) + "\n");
      if (frame.method === "initialize") reply({ agentCapabilities: { loadSession: true } });
      else if (frame.method === "session/load") {
        // ACP: the conversation is replayed first, and the answer to
        // session/load names no session.
        update({ sessionUpdate: "user_message_chunk", content: { type: "text", text: "earlier question" } });
        update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "earlier answer" } });
        reply({});
      }
    }
  });
  const adapter = createAgentClientProtocolAdapter({ command: "/usr/local/bin/hermes", args: ["acp"], cwd: "/tmp", spawnImpl: () => child });
  t.after(() => adapter.close());
  const loaded = await adapter.createSession({ directory: "/tmp", sessionId: "saved-1" });
  assert.equal(loaded.kind, "loaded");
  assert.equal(loaded.sessionId, "saved-1");
  assert.deepEqual(adapter.sessionEvents("saved-1").map(row => row.update.content.text), ["earlier question", "earlier answer"]);
  const row = adapter.sessions().find(session => session.id === "saved-1");
  assert.equal(row.loaded, true);
  assert.equal(row.status, "idle");
});
