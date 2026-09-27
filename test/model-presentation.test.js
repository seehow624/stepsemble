"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { present, detailLine } = require("../public/modules/model-presentation");

// Rows as each agent lists them (Mini, 2026-09-27).
const rows = (agent, list) => list.map(([row, name, detail]) => ({ agent, row, name, detail }));
const cases = [
  ...rows("claude-code", [
    [{ id: "opus[1m]", name: "Opus (1M context)", provider: "claude-code", description: "Opus 5.5 with 1M context · Best for everyday, complex tasks", contextWindow: 1e6 }, "Opus 5.5 · 1M", "Anthropic"],
    [{ id: "claude-fable-5-1[1m]", name: "Fable", provider: "claude-code", description: "Fable 5.1 · Most capable for your hardest and longest-running tasks", contextWindow: 1e6 }, "Fable 5.1 · 1M", "Anthropic"],
    [{ id: "sonnet", name: "Sonnet", provider: "claude-code", description: "Sonnet 5 · Efficient for routine tasks" }, "Sonnet 5", "Anthropic"],
    [{ id: "sonnet[1m]", name: "Sonnet 5 (1M context)", provider: "claude-code", description: "Sonnet 5 for long sessions", contextWindow: 1e6 }, "Sonnet 5 · 1M", "Anthropic"],
    [{ id: "haiku", name: "Haiku", provider: "claude-code", description: "Haiku 4.5 · Fastest for quick answers" }, "Haiku 4.5", "Anthropic"],
    [{ id: "claude-opus-5-5[1m]", name: "claude-opus-5-5[1m]", provider: "claude-code" }, "Opus 5.5 · 1M", "Anthropic"],
    [{ id: "claude-fable-5-1", name: "claude-fable-5-1 (anthropic)", provider: "claude-code", description: "From gateway" }, "claude-fable-5-1", "OpenCodex · Anthropic"],
    [{ id: "claude-ocx-native--claude-fable-5-1[1m]", name: "claude-fable-5-1 (anthropic) · 1M", provider: "claude-code", description: "OpenCodex gateway · claude-fable-5-1 (anthropic) · 1M", contextWindow: 1e6 }, "claude-fable-5-1 · 1M", "OpenCodex · Anthropic"],
    [{ id: "claude-ocx-native--gpt-6-astra--fast", name: "gpt-6-astra (native) · Fast", provider: "claude-code", description: "OpenCodex gateway · gpt-6-astra (native) · Fast" }, "gpt-6-astra · Fast", "OpenCodex · ChatGPT"],
    [{ id: "claude-ocx-minimax--MiniMax-M3", name: "MiniMax-M3 (minimax)", provider: "claude-code", description: "OpenCodex gateway · MiniMax-M3 (minimax)" }, "MiniMax-M3", "OpenCodex · MiniMax"],
  ]),
  ...rows("codex", [
    [{ id: "gpt-6-luna", name: "GPT-6-Luna", provider: "codex", description: "GPT-6 Luna Codex model." }, "GPT-6-Luna", "OpenAI"],
    [{ id: "anthropic/claude-opus-5-5", name: "anthropic/claude-opus-5-5", provider: "codex", description: "Routed via opencodex → anthropic (anthropic)." }, "claude-opus-5-5", "OpenCodex · Anthropic"],
    [{ id: "opencode-go/glm-5.3", name: "opencode-go/glm-5.3", provider: "codex", description: "Routed via opencodex → opencode-go (opencode)." }, "glm-5.3", "OpenCodex · OpenCode Go"],
  ]),
  ...rows("grok-build", [
    [{ id: "grok-4.7", name: "Grok 4.7", provider: "grok-build" }, "Grok 4.7", "xAI"],
    [{ id: "ocx-gpt-6-sol", name: "OCX gpt-6-sol", provider: "grok-build" }, "gpt-6-sol", "OpenCodex · ChatGPT"],
    [{ id: "ocx-minimax-MiniMax-M3", name: "OCX minimax/MiniMax-M3", provider: "grok-build" }, "MiniMax-M3", "OpenCodex · MiniMax"],
  ]),
  ...rows("hermes", [
    [{ id: "openrouter:anthropic/claude-sonnet-5", name: "OpenRouter · anthropic/claude-sonnet-5", provider: "hermes" }, "claude-sonnet-5", "OpenRouter · Anthropic"],
    [{ id: "openai-codex:gpt-6-luna", name: "ChatGPT or Codex Subscription · gpt-6-luna", provider: "hermes" }, "gpt-6-luna", "ChatGPT"],
    [{ id: "minimax:MiniMax-M3", name: "MiniMax · MiniMax-M3", provider: "hermes" }, "MiniMax-M3", "MiniMax"],
  ]),
  ...rows("opencode", [
    [{ providerID: "opencode-go", modelID: "deepseek-v4-pro", id: "deepseek-v4-pro", provider: "opencode-go", name: "DeepSeek V4 Pro (New)" }, "DeepSeek V4 Pro", "OpenCode Go · New"],
    [{ providerID: "opencode", modelID: "big-pickle", id: "big-pickle", provider: "opencode", name: "Big Pickle" }, "Big Pickle", "OpenCode Zen"],
    [{ providerID: "openai", modelID: "gpt-6-sol", id: "gpt-6-sol", provider: "openai", name: "GPT-6 Sol" }, "GPT-6 Sol", "OpenAI"],
  ]),
  ...rows("pi", [
    [{ id: "gpt-6-sol", provider: "openai-codex", name: "GPT-6 Sol", contextWindow: 272000 }, "GPT-6 Sol", "ChatGPT · 272k ctx"],
    [{ id: "MiniMax-M3", provider: "minimax", name: "MiniMax-M3" }, "MiniMax-M3", "MiniMax"],
    [{ id: "qwen/qwen3-coder", provider: "openrouter", name: "qwen/qwen3-coder" }, "qwen3-coder", "OpenRouter · Qwen"],
  ]),
  ...rows("kilo", [
    [{ id: "kilo/anthropic/claude-opus-5.5", name: "Kilo Gateway/Anthropic: Claude Opus 5.5 (new)", provider: "kilo" }, "Claude Opus 5.5", "Kilo Gateway · Anthropic · new"],
    [{ id: "kilo/anthropic/claude-fable-5", name: "Kilo Gateway/Anthropic: Claude Fable 5 ($$$$)", provider: "kilo" }, "Claude Fable 5", "Kilo Gateway · Anthropic · $$$$"],
    [{ id: "kilo/openai/gpt-4o-2024-05-13", name: "Kilo Gateway/OpenAI: GPT-4o (2024-05-13)", provider: "kilo" }, "GPT-4o 2024-05-13", "Kilo Gateway · OpenAI"],
    [{ id: "kilo/kilo-auto/balanced", name: "Kilo Gateway/Auto Balanced", provider: "kilo" }, "Auto Balanced", "Kilo Gateway"],
  ]),
];

test("every agent's models are named by the model, with the provider on the second line and no brackets", () => {
  for (const { agent, row, name, detail } of cases) {
    const shown = present(row, agent);
    assert.equal(shown.name, name, agent + " " + row.name);
    assert.equal(detailLine(row, agent), detail, agent + " " + row.name);
    assert.doesNotMatch(shown.name, /[()]/, agent + " " + row.name);
    // The agent itself is never shown as the provider.
    assert.doesNotMatch(detailLine(row, agent), /claude-code|grok-build|\bcodex\b|\bhermes\b/, agent + " " + row.name);
  }
});

test("the model list and the model button use these names", () => {
  const app = fs.readFileSync(path.join(__dirname, "..", "public", "app.js"), "utf8");
  const index = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");
  assert.match(index, /modules\/model-presentation\.js\?v=[\d.]+"><\/script>\s*(?:<script[^>]*><\/script>\s*)*<script src="\/app\.js/);
  assert.match(app, /row\.querySelector\("small"\)\.textContent = modelPresentation\?\.detailLine\(m, agentId\)/);
  assert.doesNotMatch(app, /\(m\.provider \|\| "\?"\) \+ \(m\.contextWindow/);
});
