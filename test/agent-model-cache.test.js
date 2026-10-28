"use strict";
// Settings → Models & providers shows the models Claude Code and the ACP agents
// offered in their last conversation. Temporary directory only.
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { createAgentModelCache, acpModelChoices } = require("../server/agent-model-cache");

test("the last models an agent offered are kept, bounded and owner-only", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "stepsemble-agent-models-"));
  const file = path.join(dir, "agent-models.json");
  let clock = 1_000;
  try {
    const cache = createAgentModelCache({ file, now: () => clock });
    const choices = acpModelChoices([{ id: "mode", options: [{ value: "ask" }] },
      { id: "model", category: "model", options: [{ value: "anthropic/sonnet", name: "Sonnet" }, { value: "anthropic/sonnet" }, { value: "" }, { value: "openai/luna", description: "fast\nmodel" }] }]);
    assert.equal(cache.record("hermes", choices), true);
    if (process.platform !== "win32") assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.deepEqual(createAgentModelCache({ file }).get("hermes"), { agentId: "hermes", supported: true, observedAt: 1_000,
      models: [{ id: "anthropic/sonnet", name: "Sonnet" }, { id: "openai/luna", description: "fast model" }] });
    // The same list is not rewritten until an hour has passed.
    clock = 2_000;
    assert.equal(cache.record("hermes", choices), false);
    // Agents that never report models, and unknown ids, are not stored.
    assert.equal(cache.record("grok-build", choices), false);
    assert.equal(cache.record("../x", choices), false);
    assert.deepEqual(cache.get("antigravity"), { agentId: "antigravity", supported: true, models: [], observedAt: null });
    assert.equal(cache.get("../x").supported, false);
    assert.equal(cache.record("claude-code", Array.from({ length: 300 }, (_, i) => ({ id: "m" + i }))), true);
    assert.equal(cache.get("claude-code").models.length, 200);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("Claude's models keep their reasoning levels and capacity, so a conversation offers them before Claude runs", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "stepsemble-agent-models-"));
  const file = path.join(dir, "agent-models.json");
  try {
    const cache = createAgentModelCache({ file });
    assert.equal(cache.record("claude-code", [
      { id: "opus[1m]", name: "Opus (1M context)", supportsEffort: true, supportedEffortLevels: ["low", "High", "max", "max", "turbo"],
        defaultEffort: "high", contextWindow: 1_000_000, resolvedModel: "claude-opus-5-5[1m]", reasoning: true, supportsAutoMode: true },
      { id: "haiku", supportsEffort: false, contextWindow: -1, defaultEffort: "fastest", supportedEffortLevels: "high" },
      { id: "ocx-claude-native--gpt-6.1-sol", gateway: "opencodex", contextWindow: 500_000, supportedEffortLevels: ["low"], extra: "dropped" },
    ]), true);
    assert.deepEqual(createAgentModelCache({ file }).get("claude-code").models, [
      { id: "opus[1m]", name: "Opus (1M context)", supportsEffort: true, reasoning: true, supportsAutoMode: true,
        supportedEffortLevels: ["low", "high", "max"], defaultEffort: "high", contextWindow: 1_000_000, resolvedModel: "claude-opus-5-5[1m]" },
      { id: "haiku", supportsEffort: false },
      { id: "ocx-claude-native--gpt-6.1-sol", supportedEffortLevels: ["low"], contextWindow: 500_000, gateway: "opencodex" },
    ]);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
