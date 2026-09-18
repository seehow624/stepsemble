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

function element() {
  const classes = new Set();
  const attributes = Object.create(null);
  return {
    textContent: "", title: "", hidden: false,
    classList: {
      toggle(name, enabled) { if (enabled) classes.add(name); else classes.delete(name); },
      contains(name) { return classes.has(name); },
    },
    setAttribute(name, value) { attributes[name] = String(value); },
    removeAttribute(name) { delete attributes[name]; },
    getAttribute(name) { return attributes[name]; },
    _classes: classes,
  };
}

function selectStub(levels) {
  return {
    options: levels.map(value => ({ value, textContent: value })),
    value: "off", disabled: false, hidden: false, title: "",
    replaceChildren(...nodes) { this.options = nodes.map(node => ({ value: node.value, textContent: node.textContent })); },
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
    composerModelNameText: element(), composerModelLevelText: element(), btnModel: element(),
  };
  const context = vm.createContext({
    el,
    document: { createElement: () => ({ value: "", textContent: "" }), querySelector: () => label },
    window: { stepsembleI18n: { t: key => key } },
    rpc: { nativeClaudeStructured: true },
    tKey: key => (key === "runtime.thinkingUnsupported" ? "No thinking levels" : key),
  });
  const source = [
    'let defaultThinkingSelectOptions = null;',
    slice("const CODEX_EFFORTS", "\nfunction thinkingPreference()"),
    slice("function modelThinkingBadge(model) {", "\nfunction normalizeOpenCodeModel"),
    'let composerModelName = "";\nlet composerReasoningLevel = "off";',
    slice("function updateComposerSummary(modelName, thinkingLevel) {", "\nfunction applyComposerState("),
  ].join("\n");
  vm.runInContext(source, context, { filename: "public/app.js" });
  return { el, select, hint, context };
}

test("model badges report the declared thinking range instead of a fixed level", () => {
  const { context } = harness();
  const { modelThinkingBadge } = context;
  // Claude rows declare real levels, so Opus must not read like Haiku.
  assert.equal(modelThinkingBadge({ id: "opus", supportsEffort: true, supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"] }), "low-max");
  assert.equal(modelThinkingBadge({ id: "glm", supportsEffort: true, supportedEffortLevels: ["low", "high", "max"] }), "low-max");
  assert.equal(modelThinkingBadge({ id: "narrow", supportsEffort: true, supportedEffortLevels: ["low", "high"] }), "low-high");
  assert.equal(modelThinkingBadge({ id: "single", supportsEffort: true, supportedEffortLevels: ["high", "high"] }), "high");
  assert.equal(modelThinkingBadge({ id: "haiku", supportsEffort: false, supportedEffortLevels: [], reasoning: false }), "");
  assert.equal(modelThinkingBadge({ id: "unknown levels", supportsEffort: true, supportedEffortLevels: ["ultra"] }), "");
  // Pi rows keep the thinkingLevelMap heuristic.
  assert.equal(modelThinkingBadge({ id: "pi-max", reasoning: true, thinkingLevelMap: { max: true } }), "max");
  assert.equal(modelThinkingBadge({ id: "pi-xhigh", reasoning: true, thinkingLevelMap: { xhigh: true } }), "xhigh");
  assert.equal(modelThinkingBadge({ id: "pi-plain", reasoning: true }), "high");
  assert.equal(modelThinkingBadge({ id: "pi-off", reasoning: false }), "");
});

test("a Claude model without thinking levels disables its control and says why", () => {
  const { context, el, hint } = harness();
  const connection = { nativeClaudeStructured: true, claudeEffort: "max",
    claudeModel: { id: "haiku", name: "Haiku", supportsEffort: false, supportedEffortLevels: [] } };
  context.syncNativeThinkingSelect(connection);
  assert.equal(el.thinkingSelect.disabled, true);
  assert.deepEqual(el.thinkingSelect.options.map(option => option.value), ["default"]);
  assert.equal(el.thinkingSelect.title, "No thinking levels");
  assert.equal(hint.textContent, "No thinking levels");
  assert.equal(hint.classList.contains("hidden"), false);
  // The chip must not keep advertising the level of the model selected before.
  assert.equal(el.composerModelLevelText.textContent, "");
  assert.equal(el.composerModelLevelText.classList.contains("hidden"), true);
  // The remembered level survives so a later model can restore it.
  assert.equal(connection.claudeEffort, "max");
});

test("a restored model lists exactly its own levels and brings the chip back", () => {
  const { context, el, hint } = harness();
  const connection = { nativeClaudeStructured: true, claudeEffort: "max",
    claudeModel: { id: "glm", name: "GLM", supportsEffort: true, supportedEffortLevels: ["low", "high", "max"] } };
  context.syncNativeThinkingSelect(connection);
  assert.equal(el.thinkingSelect.disabled, false);
  assert.deepEqual(el.thinkingSelect.options.map(option => option.value), ["auto", "low", "high", "max"]);
  assert.equal(el.thinkingSelect.value, "max");
  assert.equal(el.thinkingSelect.title, "");
  assert.equal(hint.textContent, "");
  assert.equal(hint.classList.contains("hidden"), true);
  assert.equal(el.composerModelLevelText.textContent, "· max");
  // A level the model does not offer falls back to its own default.
  connection.claudeModel = { id: "deepseek", supportsEffort: true, supportedEffortLevels: ["low", "max"] };
  connection.claudeEffort = "high";
  context.syncNativeThinkingSelect(connection);
  assert.deepEqual(el.thinkingSelect.options.map(option => option.value), ["auto", "low", "max"]);
  assert.equal(el.thinkingSelect.value, "auto");
});
