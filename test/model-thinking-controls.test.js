"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
const appSource = fs.readFileSync(path.join(root, "public", "app.js"), "utf8");

function slice(startMarker, endMarker) {
  const start = appSource.indexOf(startMarker);
  const end = appSource.indexOf(endMarker, start);
  assert.ok(start >= 0 && end > start, `${startMarker} should appear before ${endMarker}`);
  return appSource.slice(start, end);
}

function element(children = []) {
  const classes = new Set();
  const attributes = Object.create(null);
  return {
    textContent: "", title: "", hidden: false, dataset: {},
    classList: {
      toggle(name, enabled) { if (enabled) classes.add(name); else classes.delete(name); },
      contains(name) { return classes.has(name); },
    },
    setAttribute(name, value) { attributes[name] = String(value); },
    removeAttribute(name) { delete attributes[name]; },
    getAttribute(name) { return attributes[name]; },
    querySelectorAll() { return children; },
    _classes: classes,
  };
}

// The thinking level on the message box's edge: what the composer tells it
// (its dataset) and the state it hands the line to draw.
const line = el => ({ ...el.composerEffort.dataset, hidden: el.composerEffort.hidden, ...el.composerEffort.drawn });

function selectStub(levels) {
  return {
    options: levels.map(value => ({ value, textContent: value })),
    value: "off", disabled: false, hidden: false, title: "", rebuilds: 0,
    replaceChildren(...nodes) { this.rebuilds += 1; this.options = nodes.map(node => ({ value: node.value, textContent: node.textContent, disabled: !!node.disabled, dataset: { ...node.dataset } })); },
    removeAttribute(name) { if (name === "title") this.title = ""; },
  };
}

// The reasoning row is driven by three module-scope helpers plus the composer
// chip writer. Slicing them keeps the fixture honest: it exercises the shipped
// source instead of a re-implementation of the same rules.
function harness() {
  const select = selectStub(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
  const hint = element();
  const label = element();
  const el = {
    thinkingSelect: select, thinkingHint: hint, modelSheet: { querySelector: () => null },
    composerModelNameText: element(), composerEffort: element(), btnModel: element(),
  };
  const changes = [], access = { live: true };
  const context = vm.createContext({
    el, changes, composerSpeed: null,
    document: { createElement: () => ({ value: "", textContent: "", dataset: {} }), querySelector: () => label },
    window: { stepsembleI18n: { t: key => key }, stepsembleEffortSlider: { attachLine: ({ slider, commit }) => ({ set(state) { slider.drawn = state; slider.commit = commit; } }) } },
    rpc: { nativeClaudeStructured: true },
    connectorAllowsLiveControls: () => access.live,
    changeThinkingLevel: (level, options) => { changes.push([level, options]); return Promise.resolve(); },
    modelPresentation: require("../public/modules/model-presentation"),
    agentConnectorLabel: id => ({ kilo: "Kilo" })[id] || id,
    acpAgentOf: () => "kilo",
    acpThoughtOption: options => (Array.isArray(options) ? options : []).find(option => option?.category === "thought_level" && option.options?.length) || null,
    tKey: (key, vars = {}) => ({
      "runtime.thinkingUnsupported": "No thinking levels",
      "runtime.thinkingNotReported": "Not reported yet",
      "runtime.thinkingTooltip": `Thinking: ${vars.level}`,
      "runtime.modelThinking": `${vars.model}, thinking: ${vars.level}`,
      "runtime.thinkingNotOffered": `${vars.agent} offers none`,
    })[key] || key,
  });
  const source = [
    'let defaultThinkingSelectOptions = null;',
    slice("const CODEX_EFFORTS", "\nfunction updateThinkingSelectOptions()"),
    'let composerModelName = "";\nlet composerReasoningLevel = "off";\nlet composerReasoningLevels = [];\nlet composerReasoningNote = "";\nlet composerReasoningEffective = "";\nlet composerEffortLine = null;',
    slice("function updateComposerSummary(", "\nfunction applyComposerState("),
  ].join("\n");
  vm.runInContext(source, context, { filename: "public/app.js" });
  return { el, select, hint, context, changes, access };
}

test("a Claude model without thinking levels disables its control and says why", () => {
  const { context, el, hint } = harness();
  const connection = { nativeClaudeStructured: true, claudeEffort: "max",
    claudeModel: { id: "haiku", name: "Haiku", supportsEffort: false, supportedEffortLevels: [] } };
  context.syncNativeThinkingSelect(connection);
  assert.equal(el.thinkingSelect.disabled, true);
  // No level to pick, and no "Default" standing in for one.
  assert.deepEqual(el.thinkingSelect.options.map(option => option.value), []);
  assert.equal(el.thinkingSelect.hidden, true);
  assert.equal(el.thinkingSelect.title, "No thinking levels");
  assert.equal(hint.textContent, "No thinking levels");
  assert.equal(hint.classList.contains("hidden"), false);
  // The line must not keep advertising the level of the model selected
  // before: there is none, and the slider's text says why.
  assert.equal(line(el).state, "none");
  assert.equal(line(el).hidden, true);
  assert.equal(line(el).name, "No thinking levels");
  // The remembered level survives so a later model can restore it.
  assert.equal(connection.claudeEffort, "max");
  // Claude's list leaves the levels out for such a model.
  connection.claudeModel = { id: "haiku", name: "Haiku", resolvedModel: "claude-haiku-4-5-20251001" };
  context.syncNativeThinkingSelect(connection);
  assert.equal(el.thinkingSelect.disabled, true);
  assert.equal(line(el).name, "No thinking levels");
});

test("a restored model lists exactly its own levels and brings the chip back", () => {
  const { context, el, hint } = harness();
  const connection = { nativeClaudeStructured: true, claudeEffort: "max",
    claudeModel: { id: "glm", name: "GLM", supportsEffort: true, supportedEffortLevels: ["low", "high", "max"] } };
  context.syncNativeThinkingSelect(connection);
  assert.equal(el.thinkingSelect.disabled, false);
  assert.deepEqual(el.thinkingSelect.options.map(option => option.value), ["low", "high", "max"]);
  assert.equal(el.thinkingSelect.value, "max");
  assert.equal(el.thinkingSelect.title, "");
  assert.equal(hint.textContent, "");
  assert.equal(hint.classList.contains("hidden"), true);
  // The line: Max is the top of this model's own list, its whole length.
  assert.deepEqual([line(el).level, line(el).current, line(el).top, line(el).name], ["Max", 2, "true", "Max"]);
  assert.deepEqual(line(el).stops, ["low", "high", "max"]);
  assert.deepEqual([line(el).hidden, line(el).disabled], [true, false], "no model named yet, no line");
  // A level the model does not offer is shown as unknown until Claude reports
  // the level it runs with; it is never shown as "Default".
  connection.claudeModel = { id: "deepseek", supportsEffort: true, supportedEffortLevels: ["low", "max"] };
  connection.claudeEffort = "high";
  context.syncNativeThinkingSelect(connection);
  assert.deepEqual(el.thinkingSelect.options.map(option => option.value), ["", "low", "max"]);
  assert.equal(el.thinkingSelect.value, "");
  assert.equal(line(el).state, "none");
  assert.deepEqual([line(el).current, line(el).name], [-1, "Not reported yet"]);
  // The model's own level, when Claude's list names one, is used instead.
  connection.claudeModel = { id: "deepseek", supportsEffort: true, supportedEffortLevels: ["low", "max"], defaultEffort: "max" };
  connection.claudeEffort = "high";
  context.syncNativeThinkingSelect(connection);
  assert.deepEqual(el.thinkingSelect.options.map(option => option.value), ["low", "max"]);
  assert.equal(el.thinkingSelect.value, "max");
});

test("Codex shows the thread's own level and offers no Default", () => {
  const { context, el } = harness();
  context.rpc = { nativeCodexMutation: true };
  const model = { id: "gpt-6-luna", supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max"], defaultReasoningEffort: "medium" };
  const connection = { nativeCodexMutation: true, codexModel: model, codexEffort: null, codexThreadEffort: "max" };
  context.syncNativeThinkingSelect(connection);
  assert.deepEqual(el.thinkingSelect.options.map(option => option.value), ["low", "medium", "high", "xhigh", "max"]);
  assert.equal(el.thinkingSelect.value, "max");
  assert.equal(connection.codexEffort, "max");
  assert.deepEqual([line(el).level, line(el).current, line(el).top], ["Max", 4, "true"]);
  // A model without the chosen level takes the model's own level.
  connection.codexModel = { id: "glm", supportedReasoningEfforts: ["low", "high"], defaultReasoningEffort: "high" };
  context.syncNativeThinkingSelect(connection);
  assert.deepEqual(el.thinkingSelect.options.map(option => option.value), ["low", "high"]);
  assert.equal(connection.codexEffort, "high");
});

test("Codex guesses no level before Codex reports one, and a refresh keeps an open menu", () => {
  const { context, el } = harness();
  context.rpc = { nativeCodexMutation: true };
  // The thread has not been read yet: no model, no level.
  const connection = { nativeCodexMutation: true, codexModel: null, codexEffort: null, codexThreadEffort: null };
  context.syncNativeThinkingSelect(connection);
  assert.equal(connection.codexEffort, null);
  assert.equal(el.thinkingSelect.value, "");
  assert.equal(el.thinkingSelect.options[0].value, "");
  assert.equal(line(el).state, "none");
  // Codex reports the thread's model; its own level is used, not a guess.
  connection.codexModel = { id: "gpt-6-luna", supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max"], defaultReasoningEffort: "high" };
  context.syncNativeThinkingSelect(connection);
  assert.equal(connection.codexEffort, "high");
  // The same options on the next refresh leave the menu alone.
  const rebuilds = el.thinkingSelect.rebuilds;
  context.syncNativeThinkingSelect(connection);
  context.syncNativeThinkingSelect(connection);
  assert.equal(el.thinkingSelect.rebuilds, rebuilds);
});

test("Claude's list drops the default alias and names a bare transcript model", () => {
  const start = appSource.indexOf("function normalizeClaudeModel(");
  const end = appSource.indexOf("function currentOpenCodeModelPayload(", start);
  assert.ok(start >= 0 && end > start);
  const context = vm.createContext({ positiveFinite: value => (Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : null),
    modelPresentation: require("../public/modules/model-presentation") });
  vm.runInContext(appSource.slice(start, end), context, { filename: "public/app.js" });
  const { claudeCatalogFrom, claudeModelFromCatalog } = context;
  const catalog = claudeCatalogFrom({ currentModel: "default", models: [
    { id: "default", name: "Default (recommended)", resolvedModel: "claude-opus-5-5[1m]" },
    { id: "opus[1m]", name: "Opus (1M context)", resolvedModel: "claude-opus-5-5[1m]" },
    { id: "sonnet", name: "Sonnet", resolvedModel: "claude-sonnet-5" },
  ] });
  assert.deepEqual(catalog.models.map(model => model.id), ["opus[1m]", "sonnet"]);
  assert.equal(claudeModelFromCatalog(catalog.models, catalog.current).name, "Opus (1M context)");
  assert.equal(claudeModelFromCatalog(catalog.models, "claude-opus-5-5").name, "Opus (1M context)");
  assert.equal(claudeModelFromCatalog(catalog.models, "claude-opus-5-5[1m]").name, "Opus (1M context)");
  assert.equal(claudeModelFromCatalog(catalog.models, "claude-sonnet-5").name, "Sonnet");
});

test("the model chip never shows a default model or level", () => {
  const { context, el } = harness();
  context.updateComposerSummary("", "auto");
  assert.equal(el.composerModelNameText.textContent, "Choose model");
  assert.equal(line(el).hidden, true, "a level belongs to a model; none shows before one is known");
  context.updateComposerSummary("Opus (1M context)", "max");
  assert.equal(el.composerModelNameText.textContent, "Opus (1M context)");
  assert.equal(line(el).level, "Max");
  assert.equal(line(el).hidden, false);
  // The button shows the model alone; the level's name is in its own name.
  assert.equal(el.btnModel.getAttribute("aria-label"), "Opus (1M context), thinking: Max");
});

function claudeCatalogHelpers() {
  const start = appSource.indexOf("function normalizeClaudeModel(");
  const end = appSource.indexOf("function currentOpenCodeModelPayload(", start);
  const context = vm.createContext({ positiveFinite: value => (Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : null),
    modelPresentation: require("../public/modules/model-presentation") });
  vm.runInContext(appSource.slice(start, end), context, { filename: "public/app.js" });
  return context;
}

// Claude Code through Magpie: three aliases resolve to one model at three
// levels, and Claude reports the model bare (Mini, 2026-10-21).
const magpieRows = [
  { id: "opus", name: "claude/claude-opus-5-5:xhigh[1m]", resolvedModel: "claude/claude-opus-5-5:xhigh[1m]", description: "Custom Opus model (1M context)", supportsEffort: true, supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"] },
  { id: "fable", name: "claude/claude-opus-5-5:high[1m]", resolvedModel: "claude/claude-opus-5-5:high[1m]", description: "Custom Fable model", supportsEffort: true, supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"] },
  { id: "sonnet", name: "claude/claude-opus-5-5:medium[1m]", resolvedModel: "claude/claude-opus-5-5:medium[1m]", description: "Custom Sonnet model (1M context)", supportsEffort: true, supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"] },
];

test("a bare Claude model finds the Magpie alias at its level and never gives way to a poorer row", () => {
  const { claudeCatalogFrom, claudeModelFromCatalog, normalizeClaudeModel } = claudeCatalogHelpers();
  const { models } = claudeCatalogFrom({ models: magpieRows, currentModel: "claude-opus-5-5" });
  assert.equal(claudeModelFromCatalog(models, "claude-opus-5-5", { effort: "xhigh" }).id, "opus");
  assert.equal(claudeModelFromCatalog(models, "claude-opus-5-5", { effort: "high" }).id, "fable");
  // The aliases' capacity is in their resolved ids.
  assert.equal(models[1].contextWindow, 1_000_000);
  // A context report naming the model when the catalog has not loaded keeps
  // the row already shown, with its levels and capacity.
  const shown = models[0];
  assert.equal(claudeModelFromCatalog([], "claude-opus-5-5", { current: shown }), shown);
  assert.equal(claudeModelFromCatalog([], "claude/claude-opus-5-5:xhigh[1m]", { current: shown }), shown);
  // A different model is not kept.
  assert.equal(claudeModelFromCatalog([], "claude-haiku-5-5", { current: shown }).id, "claude-haiku-5-5");
  // A bare name says nothing about levels.
  assert.equal(normalizeClaudeModel("claude-opus-5-5").effortDeclared, false);
  assert.equal(normalizeClaudeModel("claude-opus-5-5[1m]").contextWindow, 1_000_000);
  assert.equal(normalizeClaudeModel({ id: "haiku", supportsEffort: false }).effortDeclared, true);
  // Claude's list leaves the levels out for a model without any.
  assert.equal(normalizeClaudeModel({ id: "haiku", resolvedModel: "claude-haiku-4-5-20251001" }).effortDeclared, true);
});

test("a level Claude reports shows on a model whose entry lists no levels", () => {
  const { context, el } = harness();
  const { normalizeClaudeModel } = claudeCatalogHelpers();
  const connection = { nativeClaudeStructured: true, claudeEffort: "xhigh", claudeModel: normalizeClaudeModel("claude-opus-5-5") };
  context.updateComposerSummary("Opus 5.5", undefined);
  context.syncNativeThinkingSelect(connection);
  assert.equal(connection.claudeEffort, "xhigh");
  assert.equal(el.thinkingSelect.value, "xhigh");
  assert.deepEqual([line(el).level, line(el).current, line(el).top], ["Extra high", 3, "false"], "only Max has the tip");
  assert.equal(el.btnModel.getAttribute("aria-label"), "Opus 5.5, thinking: Extra high");
});

test("Claude's auto shows the level it runs at when reported, and its own look otherwise", () => {
  const { context, el } = harness();
  const connection = { nativeClaudeStructured: true, claudeEffort: "auto", claudeEffectiveEffort: null, claudeModel: magpieRows[0] };
  context.updateComposerSummary("Opus 5.5 · 1M", undefined);
  context.syncNativeThinkingSelect(connection);
  assert.equal(connection.claudeEffort, "auto");
  assert.deepEqual([line(el).state, line(el).auto, line(el).current, line(el).name], ["auto", true, -1, "Auto"]);
  assert.equal(el.thinkingSelect.options[0].textContent, "Auto");
  assert.equal(el.thinkingSelect.options[0].disabled, true);
  connection.claudeEffectiveEffort = "high";
  context.syncNativeThinkingSelect(connection);
  // Dashed to the level it runs at, never the top.
  assert.deepEqual([line(el).state, line(el).current, line(el).top, line(el).name], ["auto", 2, "false", "Auto · High"]);
  assert.equal(el.btnModel.getAttribute("aria-label"), "Opus 5.5 · 1M, thinking: Auto · High");
  assert.equal(el.thinkingSelect.options[0].textContent, "Auto · High");
  // The level slider reads auto, and the level it runs at, from that entry.
  assert.deepEqual(el.thinkingSelect.options[0].dataset, { auto: "true", effective: "high" });
  assert.deepEqual(el.thinkingSelect.options.slice(1).map(option => option.dataset), [{}, {}, {}, {}, {}]);
});

test("a Magpie alias runs at the level its id names until Claude reports its own", () => {
  const { context, el } = harness();
  // Fable here is Magpie's Opus at High; Claude has not said which level it runs at.
  const connection = { nativeClaudeStructured: true, claudeEffort: null, claudeModel: magpieRows[1] };
  context.updateComposerSummary("Opus 5.5 · 1M", undefined);
  context.syncNativeThinkingSelect(connection);
  assert.equal(connection.claudeEffort, "high");
  assert.equal(el.thinkingSelect.value, "high");
  assert.equal(line(el).current, 2);
  // A level Claude reports wins, and changing it keeps the model.
  connection.claudeEffort = "max";
  context.syncNativeThinkingSelect(connection);
  assert.equal(el.thinkingSelect.value, "max");
  assert.equal(connection.claudeModel, magpieRows[1]);
  // Magpie's own id for the model names no level.
  connection.claudeEffort = null;
  connection.claudeModel = { id: "claude/claude-opus-5-5[1m]", resolvedModel: "claude/claude-opus-5-5[1m]", supportsEffort: true, supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"] };
  context.syncNativeThinkingSelect(connection);
  assert.equal(el.thinkingSelect.value, "");
});

test("agents with no level to choose show no line, and the button says why", () => {
  const { context, el } = harness();
  context.updateComposerSummary("Fixture OpenCode", "high");
  context.rpc = { nativeOpenCode: true };
  context.syncNativeThinkingSelect(context.rpc);
  assert.deepEqual([line(el).state, line(el).hidden, line(el).name], ["none", true, "OpenCode offers none"]);
  assert.equal(el.btnModel.getAttribute("aria-label"), "Fixture OpenCode. OpenCode offers none");
  // An ACP agent without a thought_level option.
  context.rpc = { nativeAcp: true, acpConfigOptions: [] };
  context.syncNativeThinkingSelect(context.rpc);
  assert.deepEqual([line(el).hidden, line(el).name], [true, "Kilo offers none"]);
  // Grok lists its levels from Extra high down; the line ranks them, by the names Grok gives.
  context.rpc = { nativeGrokAcp: true, acpConfigOptions: [{ id: "effort", category: "thought_level", currentValue: "high",
    options: ["xhigh", "high", "medium", "low"].map(value => ({ value, name: "Grok " + value })) }] };
  context.syncNativeThinkingSelect(context.rpc);
  assert.deepEqual([line(el).state, line(el).hidden, line(el).current], ["level", false, 2]);
  assert.deepEqual(line(el).stops, ["low", "medium", "high", "xhigh"]);
  assert.equal(line(el).labels.get("xhigh"), "Grok xhigh");
});

test("Pi's off is the empty line, and its levels fill the rest", () => {
  const { context, el } = harness();
  context.updateComposerSummary("Synthetic baseline", "off", { levels: ["off", "low", "medium", "high"] });
  assert.deepEqual([line(el).state, line(el).current, line(el).name, line(el).hidden], ["off", 0, "Off", false]);
  assert.deepEqual(line(el).stops, ["off", "low", "medium", "high"]);
  context.updateComposerSummary(undefined, "medium");
  assert.equal(line(el).current, 2);
  assert.equal(el.btnModel.getAttribute("aria-label"), "Synthetic baseline, thinking: Medium");
  // A model that can only go without has no level to pick: no line.
  context.updateComposerSummary(undefined, "off", { levels: ["off"] });
  assert.equal(line(el).hidden, true);
});

test("a level picked on the line goes the sheet's way, quietly, and a label is not a control", () => {
  const { context, el, changes, access } = harness();
  context.updateComposerSummary("Opus 5.5", "high", { levels: ["low", "medium", "high", "xhigh", "max"] });
  assert.equal(line(el).disabled, false);
  // The select is the record the sheet's slider shows; the change takes the app's one path, without a notice.
  assert.equal(el.composerEffort.commit("max"), undefined);
  assert.equal(el.thinkingSelect.value, "max");
  assert.deepEqual(changes.map(([level, options]) => [level, options?.quiet]), [["max", true]]);
  // A level the select does not offer is refused, and the line goes back.
  el.thinkingSelect.options.find(option => option.value === "xhigh").disabled = true;
  assert.equal(el.composerEffort.commit("xhigh"), false);
  assert.equal(el.composerEffort.commit("ultra"), false);
  assert.equal(changes.length, 1);
  // A read-only history shows the level it ran at, as a label.
  access.live = false;
  context.updateComposerSummary(undefined, "high");
  assert.deepEqual([line(el).hidden, line(el).disabled, line(el).current], [false, true, 2]);
});

test("a level picked on a Magpie alias that names its own moves the conversation to the same model without it", () => {
  const { claudeCatalogFrom, claudePlainModel } = claudeCatalogHelpers();
  const own = { id: "claude/claude-opus-5-5[1m]", name: "Claude Opus 5.5", resolvedModel: "claude/claude-opus-5-5[1m]", description: "Magpie gateway · Claude Code",
    contextWindow: 1_000_000, supportsEffort: true, supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"] };
  // Only aliases listed: the model's own id is made from the alias's, "[1m]" kept.
  const aliases = claudeCatalogFrom({ models: magpieRows }).models;
  const made = claudePlainModel({ claudeModel: aliases[0], claudeModels: aliases });
  assert.equal(made.id, "claude/claude-opus-5-5[1m]");
  assert.equal(made.resolvedModel, "claude/claude-opus-5-5[1m]");
  assert.equal(made.contextWindow, 1_000_000, "the same model, the same context");
  assert.deepEqual([...made.supportedEffortLevels], ["low", "medium", "high", "xhigh", "max"]);
  // With Magpie's own row listed, that row.
  const listed = claudeCatalogFrom({ models: [...magpieRows, own] }).models;
  assert.equal(claudePlainModel({ claudeModel: listed[1], claudeModels: listed }), listed[3]);
  // Nothing to move: the plain model itself, Claude's own aliases, a bare name.
  assert.equal(claudePlainModel({ claudeModel: listed[3], claudeModels: listed }), null);
  assert.equal(claudePlainModel({ claudeModel: { id: "opus[1m]", resolvedModel: "claude-opus-5-5[1m]" }, claudeModels: [] }), null);
  assert.equal(claudePlainModel({ claudeModel: { id: "claude-opus-5-5" }, claudeModels: [] }), null);
  assert.equal(claudePlainModel({ claudeModel: null }), null);
});
