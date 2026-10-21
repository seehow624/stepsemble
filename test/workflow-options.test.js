"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { createWorkflowOptions } = require("../server/workflow-options");

function options(overrides = {}) {
  return createWorkflowOptions({
    last: agentId => ({ codex:{ model:"gpt-6", effort:"high" }, "claude-code":{ model:"opus" } })[agentId] || null,
    codexModels: async () => ({ data:[{ id:"row-1", model:"gpt-6", displayName:"GPT-6", supportedReasoningEfforts:[{ reasoningEffort:"low" }, { reasoningEffort:"high" }] }, { model:"gpt-6-mini" }] }),
    openCodeModels: async directory => ({ models:[{ providerID:"anthropic", modelID:"claude-opus-5-5", name:"Claude Opus 5.5", directory }] }),
    piModels: async () => [{ provider:"anthropic", id:"claude-sonnet-5-5", name:"Sonnet 5.5" }],
    cachedModels: agentId => agentId === "claude-code" ? { models:[{ id:"opus", name:"Opus 5.5" }, { id:"fable" }] } : { models:[] },
    modes: async agentId => ({ codex:["read-only", "workspace", "full-access"].map(id => ({ id })), "claude-code":[{ id:"default" }, { id:"acceptEdits" }] })[agentId] || [],
    ...overrides,
  });
}

test("Codex offers its wire model ids, reasoning levels, presets and the current choice", async () => {
  const result = await options()("codex", "/repo");
  assert.deepEqual(result.current, { model:"gpt-6", effort:"high" });
  assert.deepEqual(result.models, [{ choice:{ model:"gpt-6" }, label:"GPT-6", efforts:["low", "high"] }, { choice:{ model:"gpt-6-mini" }, label:"gpt-6-mini", efforts:[] }]);
  assert.deepEqual(result.modes.map(mode => mode.id), ["read-only", "workspace", "full-access"]);
});

test("OpenCode joins provider and model as its composer does", async () => {
  const result = await options()("opencode", "/repo");
  assert.deepEqual(result.models, [{ choice:{ model:"anthropic/claude-opus-5-5" }, label:"Claude Opus 5.5", efforts:[] }]);
});

test("Pi keeps the provider with the model so the Host can switch to it", async () => {
  const result = await options()("pi", "/repo");
  assert.deepEqual(result.models, [{ choice:{ model:"claude-sonnet-5-5", provider:"anthropic" }, label:"Sonnet 5.5", efforts:[] }]);
  assert.deepEqual(result.modes, []);
});

test("agents that report models only inside a conversation use the last list they reported", async () => {
  const result = await options()("claude-code", "/repo");
  assert.deepEqual(result.models.map(model => model.choice.model), ["opus", "fable"]);
  assert.deepEqual(result.modes.map(mode => mode.id), ["default", "acceptEdits"]);
});

test("an unavailable catalog still returns the modes and says the models are unknown", async () => {
  const result = await options({ codexModels: async () => { throw new Error("offline"); } })("codex", "/repo");
  assert.deepEqual(result.models, []); assert.equal(result.modelsUnavailable, true); assert.equal(result.modes.length, 3);
});

test("model lists are bounded and malformed rows are ignored", async () => {
  const many = Array.from({ length:600 }, (_, i) => ({ model:`m-${i}` })).concat([null, { model:"has space" }, { model:"" }]);
  const result = await options({ codexModels: async () => ({ data:many }) })("codex", "/repo");
  assert.equal(result.models.length, 500); assert.ok(result.models.every(model => !/\s/.test(model.choice.model)));
});

// Claude Code through Magpie: three slots on Opus 5.5 at three levels, the
// Haiku slot, and Magpie's own rows as the model sheet lists them (Mini, 2026-10-21).
test("a Goal or schedule offers one row per model, picked by the model's own id with its levels apart", async () => {
  const levels = ["low", "medium", "high", "xhigh", "max"];
  const slot = (id, model, level) => ({ id, name: `claude/${model}:${level}[1m]`, resolvedModel: `claude/${model}:${level}[1m]`, supportsEffort: true, supportedEffortLevels: levels });
  const cached = [slot("opus", "claude-opus-5-5", "xhigh"), slot("fable", "claude-opus-5-5", "high"), slot("sonnet", "claude-opus-5-5", "medium"), slot("haiku", "claude-haiku-5-5", "xhigh"),
    { id: "claude/claude-sonnet-5-5[1m]", name: "Claude Sonnet 5.5", resolvedModel: "claude/claude-sonnet-5-5[1m]", description: "Magpie gateway · Claude Code", contextWindow: 1_000_000, supportedEffortLevels: levels },
    { id: "minimax/MiniMax-M3.1-Flash", name: "MiniMax-M3.1-Flash", description: "Magpie gateway · MiniMax", contextWindow: 1_000_000, supportedEffortLevels: ["low", "max"] }];
  const result = await options({ cachedModels: agentId => agentId === "claude-code" ? { models: cached } : { models: [] } })("claude-code", "/repo");
  assert.deepEqual(result.models, [
    { choice: { model: "claude/claude-opus-5-5[1m]" }, label: "Opus 5.5 · 1M", efforts: levels },
    { choice: { model: "claude/claude-haiku-5-5[1m]" }, label: "Haiku 5.5 · 1M", efforts: levels },
    { choice: { model: "claude/claude-sonnet-5-5[1m]" }, label: "Sonnet 5.5 · 1M", efforts: levels },
    { choice: { model: "minimax/MiniMax-M3.1-Flash" }, label: "MiniMax-M3.1-Flash", efforts: ["low", "max"] },
  ]);
  // The choice kept from before ("opus") is still the Host's to apply.
  assert.deepEqual(result.current, { model: "opus" });
});
