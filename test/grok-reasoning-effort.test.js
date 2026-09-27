"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { PassThrough } = require("node:stream");
const { EventEmitter } = require("node:events");
const { createGrokAcpAdapter } = require("../server/grok-acp-adapter");
const { effortCatalog, replyEffort, withEffortOption, LEGACY_EFFORT_OPTION } = require("../server/grok-reasoning-effort");

// Models as Grok 1.0.41 lists them (Mini, 2026-09-27); the MacBook Pro's Grok
// lists the same models but no reasoning option among its config options.
const grok47 = { modelId: "grok-4.7", name: "Grok 4.7", _meta: { supportsReasoningEffort: true, reasoningEffort: "high", reasoningEfforts: [
  { id: "xhigh", value: "xhigh", label: "Extra High", default: false }, { id: "high", value: "high", label: "High", default: true },
  { id: "medium", value: "medium", label: "Medium", default: false }, { id: "low", value: "low", label: "Low", default: false }] } };
const sol = { modelId: "ocx-gpt-6-sol", name: "OCX gpt-6-sol", _meta: { supportsReasoningEffort: true, reasoningEffort: "medium", reasoningEfforts: [
  { value: "low", label: "Low" }, { value: "medium", label: "Medium", default: true }, { value: "high", label: "High" }, { value: "max", label: "Max" }] } };
const plainModel = { modelId: "plain", name: "Plain" };
const reply = (extra = {}) => ({ sessionId: "session-1", models: { currentModelId: "grok-4.7", availableModels: [grok47, sol, plainModel] }, ...extra });

test("a Grok that lists only its models gets a reasoning option from each model's levels", () => {
  const catalog = effortCatalog(reply());
  const model = { id: "acp.model", category: "model", legacyModel: true, currentValue: "grok-4.7", options: [] };
  const options = withEffortOption([model], catalog, null);
  const effort = options.find(option => option.category === "thought_level");
  assert.equal(effort.id, LEGACY_EFFORT_OPTION);
  assert.deepEqual(effort.options.map(choice => choice.value), ["xhigh", "high", "medium", "low"]);
  assert.equal(effort.options[0].name, "Extra High");
  assert.equal(effort.currentValue, "high", "the model's default until the session names one");
  // The level carries over to a model that offers it, else the model's default.
  assert.equal(withEffortOption([{ ...model, currentValue: "ocx-gpt-6-sol" }], catalog, "low").at(-1).currentValue, "low");
  assert.equal(withEffortOption([{ ...model, currentValue: "ocx-gpt-6-sol" }], catalog, "xhigh").at(-1).currentValue, "medium");
  // A model without levels shows none.
  assert.equal(withEffortOption([{ ...model, currentValue: "plain" }], catalog, "low").some(option => option.category === "thought_level"), false);
  // A Grok that lists its own reasoning option keeps it and gets no second one.
  assert.equal(effortCatalog(reply({ configOptions: [{ id: "reasoning_effort", category: "thought_level", options: [{ value: "low" }] }] })), null);
  // The session's level, as the reply's x.ai/sessionConfig marks it.
  assert.equal(replyEffort({ _meta: { "x.ai/sessionConfig": { options: [{ id: "grok-4.7", category: "model", selected: true },
    { id: "high", category: "mode", selected: false }, { id: "low", category: "mode", selected: true }] } } }), "low");
});

function grokWithoutReasoningOption(sent) {
  const child = new EventEmitter();
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.kill = () => child.emit("close", 0, null);
  const reply = (id, result) => child.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
  child.stdin.on("data", chunk => {
    for (const line of chunk.toString().split(/\n/).filter(Boolean)) {
      const frame = JSON.parse(line);
      sent.push(frame);
      if (frame.method === "initialize") reply(frame.id, { authMethods: [{ id: "cached_token" }] });
      else if (frame.method === "session/new") reply(frame.id, { sessionId: "session-1", models: { currentModelId: "grok-4.7", availableModels: [grok47, sol] } });
      else if (frame.method === "session/load") {
        // Grok names the session's level as it loads, before it answers.
        child.stdout.write(JSON.stringify({ jsonrpc: "2.0", method: "_x.ai/session_notification", params: { sessionId: "session-1",
          update: { sessionUpdate: "model_changed", model_id: "ocx-gpt-6-sol", reasoning_effort: "max" } } }) + "\n");
        reply(frame.id, { models: { currentModelId: "ocx-gpt-6-sol", availableModels: [grok47, sol] } });
      } else reply(frame.id, frame.method === "session/set_model" ? { _meta: { model: { Ok: frame.params.modelId } } } : {});
    }
  });
  return child;
}

test("Grok sets the reasoning effort with a model switch carrying _meta.reasoningEffort when it lists no reasoning option", async t => {
  const sent = [];
  const adapter = createGrokAcpAdapter({ command: "/usr/local/bin/grok", cwd: "/tmp", env: {}, spawnImpl: () => grokWithoutReasoningOption(sent) });
  t.after(() => adapter.close());
  const session = await adapter.createSession({ directory: "/tmp" });
  const effort = () => adapter.sessionConfigOptions(session.sessionId).find(option => option.category === "thought_level");
  assert.equal(effort().currentValue, "high");
  const set = await adapter.setConfigOption(session.sessionId, LEGACY_EFFORT_OPTION, "low");
  assert.equal(set.kind, "configured");
  const frame = sent.filter(row => row.method === "session/set_model").at(-1);
  assert.deepEqual(frame.params, { sessionId: "session-1", modelId: "grok-4.7", _meta: { reasoningEffort: "low" } });
  assert.equal(effort().currentValue, "low");
  // Switching the model keeps the level where the new model offers it.
  await adapter.setConfigOption(session.sessionId, "acp.model", "ocx-gpt-6-sol");
  assert.equal(effort().currentValue, "low");
  assert.deepEqual(effort().options.map(choice => choice.value), ["low", "medium", "high", "max"]);
  // A level the model does not offer is refused.
  assert.equal((await adapter.setConfigOption(session.sessionId, LEGACY_EFFORT_OPTION, "xhigh")).code, "grok_config_invalid");
  // A conversation opened again shows the level Grok reports as it loads.
  const loaded = await adapter.loadSession(session.sessionId, "/tmp");
  assert.equal(loaded.kind, "loaded");
  assert.equal(adapter.sessionConfigOptions(session.sessionId).find(option => option.category === "model").currentValue, "ocx-gpt-6-sol");
  assert.equal(effort().currentValue, "max");
});
