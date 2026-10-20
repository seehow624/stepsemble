"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { present, detailLine, modelKey, modelTags, matchModel, contextCapacity, effortBars, levelName } = require("../public/modules/model-presentation");

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
    [{ id: "ocx-claude-native--claude-fable-5-1[1m]", name: "claude-fable-5-1 (anthropic) · 1M", provider: "claude-code", description: "OpenCodex gateway", contextWindow: 1e6 }, "claude-fable-5-1 · 1M", "OpenCodex · Anthropic"],
    [{ id: "ocx-claude-native--gpt-6-astra--fast", name: "gpt-6-astra (native) · Fast", provider: "claude-code", description: "OpenCodex gateway" }, "gpt-6-astra · Fast", "OpenCodex · ChatGPT"],
    [{ id: "ocx-claude-minimax--MiniMax-M3", name: "MiniMax-M3 (minimax)", provider: "claude-code", description: "OpenCodex gateway" }, "MiniMax-M3", "OpenCodex · MiniMax"],
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

// Magpie's models as Codex, Claude Code and Pi list them (Mini, 2026-10-20).
test("models through Magpie name the model and say Magpie and the vendor", () => {
  const rows = [
    [{ id: "minimax/MiniMax-M3", displayName: "MiniMax-M3 · MiniMax", description: "MiniMax-M3 · MiniMax via magpie" }, "codex", "MiniMax-M3", "Magpie · MiniMax"],
    [{ id: "claude/claude-opus-5-5", displayName: "Claude Opus 5.5 · Claude Code", description: "Claude Opus 5.5 · Claude Code via magpie" }, "codex", "Claude Opus 5.5", "Magpie · Anthropic"],
    [{ id: "codex/gpt-6-luna", name: "GPT-6-Luna · Codex", provider: "magpie" }, "pi", "GPT-6-Luna", "Magpie · ChatGPT"],
    [{ id: "minimax/MiniMax-M3", name: "MiniMax-M3", description: "Magpie gateway · MiniMax" }, "claude-code", "MiniMax-M3", "Magpie · MiniMax"],
    [{ id: "gpt-6.1-sol", displayName: "GPT-6.1-Sol", description: "Latest workhorse model for coding and everyday work." }, "codex", "GPT-6.1-Sol", "OpenAI"],
  ];
  for (const [row, agent, name, provider] of rows) assert.deepEqual([present(row, agent).name, present(row, agent).provider], [name, provider], row.id);
});

// Claude Code routed through Magpie lists its own aliases by Magpie's id with
// the level each runs at (Mini, 2026-10-21).
const magpieAliases = [
  { id: "opus", name: "claude/claude-opus-5-5:xhigh[1m]", resolvedModel: "claude/claude-opus-5-5:xhigh[1m]", description: "Custom Opus model (1M context)", supportsEffort: true, supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"] },
  { id: "fable", name: "claude/claude-opus-5-5:high[1m]", resolvedModel: "claude/claude-opus-5-5:high[1m]", description: "Custom Fable model", supportsEffort: true, supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"] },
  { id: "sonnet", name: "claude/claude-opus-5-5:medium[1m]", resolvedModel: "claude/claude-opus-5-5:medium[1m]", description: "Custom Sonnet model (1M context)", supportsEffort: true, supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"] },
  { id: "haiku", name: "claude/claude-haiku-5-5:xhigh[1m]", resolvedModel: "claude/claude-haiku-5-5:xhigh[1m]", description: "Custom Haiku model" },
  { id: "minimax/MiniMax-M3.1-Flash", name: "MiniMax-M3.1-Flash", resolvedModel: "minimax/MiniMax-M3.1-Flash", description: "Magpie gateway · MiniMax", contextWindow: 1_000_000, gateway: "magpie" },
];

test("Claude's Magpie aliases are named with their 1M context, Magpie and the level each runs at", () => {
  assert.deepEqual(magpieAliases.map(row => [present(row, "claude-code").name, detailLine(row, "claude-code")]), [
    ["Opus 5.5 · 1M", "Magpie · Anthropic · Extra high"],
    ["Opus 5.5 · 1M", "Magpie · Anthropic · High"],
    ["Opus 5.5 · 1M", "Magpie · Anthropic · Medium"],
    ["Haiku 5.5 · 1M", "Magpie · Anthropic · Extra high"],
    ["MiniMax-M3.1-Flash", "Magpie · MiniMax · 1M ctx"],
  ]);
});

test("a model id is compared without its route, level and tags", () => {
  assert.equal(modelKey("claude/claude-opus-5-5:xhigh[1m]"), "claude-opus-5-5");
  assert.equal(modelKey("claude-opus-5-5[1m]"), "claude-opus-5-5");
  assert.equal(modelKey("ocx-claude-native--claude-fable-5-1[1m]"), "claude-fable-5-1");
  assert.equal(modelKey("claude-ocx-native--gpt-6-astra--fast"), "gpt-6-astra--fast");
  assert.equal(modelKey("openrouter/anthropic/claude-sonnet-5"), "claude-sonnet-5");
  assert.equal(modelKey("gpt-6.1-sol"), "gpt-6.1-sol");
  assert.deepEqual(modelTags("claude/claude-opus-5-5:xhigh[1m]"), { wide: true, effort: "xhigh" });
  assert.deepEqual(modelTags("claude-opus-5-5"), { wide: false, effort: null });
});

test("a reported model finds its catalog row, the one at the conversation's level among several", () => {
  // Claude reports the model it runs bare.
  assert.equal(matchModel(magpieAliases, "claude-opus-5-5", { effort: "xhigh" }).id, "opus");
  assert.equal(matchModel(magpieAliases, "claude-opus-5-5", { effort: "high" }).id, "fable");
  assert.equal(matchModel(magpieAliases, "claude-opus-5-5", { effort: "medium" }).id, "sonnet");
  // A level no alias runs at keeps the first.
  assert.equal(matchModel(magpieAliases, "claude-opus-5-5", { effort: "max" }).id, "opus");
  // The id's own level names its alias; an exact id or resolvedModel wins.
  assert.equal(matchModel(magpieAliases, "claude/claude-opus-5-5:high[1m]", { effort: "xhigh" }).id, "fable");
  assert.equal(matchModel(magpieAliases, "sonnet", { effort: "xhigh" }).id, "sonnet");
  assert.equal(matchModel(magpieAliases, "claude-haiku-5-5").id, "haiku");
  assert.equal(matchModel(magpieAliases, "MiniMax-M3.1-Flash").id, "minimax/MiniMax-M3.1-Flash");
  // Claude's own list: a bare name keeps a model of the same 1M-ness first.
  const own = [{ id: "sonnet[1m]", resolvedModel: "claude-sonnet-5[1m]" }, { id: "sonnet", resolvedModel: "claude-sonnet-5" }];
  assert.equal(matchModel(own, "claude-sonnet-5").id, "sonnet");
  assert.equal(matchModel(own, "claude-sonnet-5-x[1m]"), null);
  assert.equal(matchModel([], "claude-opus-5-5"), null);
  assert.equal(matchModel(magpieAliases, "claude-fable-5-1"), null);
});

test("a model's capacity is the one it states, else 1M from its name or description", () => {
  assert.equal(contextCapacity({ id: "x", contextWindow: 272_000 }), 272_000);
  assert.equal(contextCapacity(magpieAliases[1]), 1_000_000, "[1m] in resolvedModel");
  assert.equal(contextCapacity({ id: "sonnet", description: "Sonnet 5 with 1M context" }), 1_000_000);
  assert.equal(contextCapacity({ id: "opus", name: "Opus (1M context)" }), 1_000_000);
  assert.equal(contextCapacity("claude-opus-5-5[1m]"), 1_000_000);
  assert.equal(contextCapacity({ id: "claude-opus-5-5" }), null);
  assert.equal(contextCapacity(null), null);
});

test("a level lights its place in the model's own list on four bars, and the top level a mark", () => {
  // "4+" is all four bars with the top level's mark.
  const bars = (levels, list) => levels.map(level => { const shown = effortBars(level, list); return shown.top ? "4+" : shown.bars; });
  const claude = ["low", "medium", "high", "xhigh", "max"];
  assert.deepEqual(bars(claude, claude), [1, 2, 3, 4, "4+"], "every Claude level has its own look");
  // Short lists count up from one bar, so no two levels share one.
  assert.deepEqual(bars(["low", "high"], ["low", "high"]), [1, "4+"]);
  assert.deepEqual(bars(["low", "medium", "high"], ["off", "low", "medium", "high"]), [1, 2, "4+"], "Medium stays apart from High");
  assert.deepEqual(bars(["low", "medium", "high", "xhigh"], ["low", "medium", "high", "xhigh"]), [1, 2, 3, "4+"]);
  assert.deepEqual(bars(["high"], ["high"]), ["4+"], "a model with one level shows it as its top");
  // Longer lists share the lowest bar, once.
  const codex = ["low", "medium", "high", "xhigh", "max", "ultra"];
  assert.deepEqual(bars(codex, codex), [1, 1, 2, 3, 4, "4+"]);
  const pi = ["minimal", "low", "medium", "high", "xhigh", "max"];
  assert.deepEqual(bars(pi, ["off", ...pi]), [1, 1, 2, 3, 4, "4+"]);
  // Seven levels into four bars share it twice, still at the low end.
  const every = ["minimal", "low", "medium", "high", "xhigh", "max", "ultra"];
  assert.deepEqual(bars(every, every), [1, 1, 1, 2, 3, 4, "4+"]);
  // Grok lists its levels from Extra high down; they are ranked all the same.
  assert.deepEqual(bars(["low", "high", "xhigh"], ["xhigh", "high", "medium", "low"]), [1, 3, "4+"]);
  // A level outside the model's list is placed on the full scale, topped by Max.
  assert.deepEqual(bars(["max", "xhigh", "minimal", "ultra"], []), ["4+", 4, 1, "4+"]);
  assert.deepEqual(effortBars("off", claude), { state: "off", bars: 0, top: false });
  assert.deepEqual(effortBars("none", claude), { state: "off", bars: 0, top: false });
  assert.deepEqual(effortBars("auto", claude), { state: "auto", bars: 0, top: false });
  assert.deepEqual(effortBars("", claude), { state: "none", bars: 0, top: false });
  assert.equal(levelName("xhigh"), "Extra high");
  assert.equal(levelName("max"), "Max");
});
