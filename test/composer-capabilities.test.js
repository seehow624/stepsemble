"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");

function capabilities() {
  const source = fs.readFileSync(path.join(root, "public", "app.js"), "utf8");
  const start = source.indexOf("function connectorAcceptsImages(");
  const end = source.indexOf("function genericTaskTerminal(");
  assert.ok(start >= 0 && end > start, "composer capability helpers should exist");
  const context = vm.createContext({});
  vm.runInContext(source.slice(start, end), context);
  return context;
}

// Each composer control is gated on what the connector's wire format can
// actually carry. Showing a control the agent cannot honour is worse than
// hiding it: the user's attachment or model choice is silently discarded.
test("composer controls match what each connector can actually do", () => {
  const { connectorAcceptsImages, connectorAllowsLiveControls } = capabilities();
  const expected = [
    // Pi's native RPC has carried images, model choice and usage from the start.
    ["pi", { generic: false }, { image: true, live: true }],
    // OpenCode's native server offers all three.
    ["opencode", { generic: true, nativeOpenCode: true }, { image: true, live: true }],
    // ACP agents carry image blocks, config-option model choice and usage.
    ["acp", { generic: true, nativeAcp: true }, { image: true, live: true }],
    ["grok acp", { generic: true, nativeGrokAcp: true }, { image: true, live: false }],
    // Claude Code exposes image blocks plus session-scoped model/context APIs.
    ["claude", { generic: true, nativeClaudeStructured: true }, { image: true, live: true }],
    // Codex native mutation carries images and next-prompt model/effort.
    ["codex", { generic: true, nativeCodex: true, nativeCodexMutation: true }, { image: true, live: true }],
    ["codex text-only model", { generic: true, nativeCodex: true, nativeCodexMutation: true, codexModel: { inputModalities: ["text"] } }, { image: false, live: true }],
    // A stored Codex thread remains observation-only.
    ["codex history", { generic: true, nativeCodex: true }, { image: false, live: false }],
    // A terminal CLI reads text on stdin; anything else is dropped unseen.
    ["terminal cli", { generic: true }, { image: false, live: false }],
  ];
  for (const [label, connection, want] of expected) {
    assert.equal(connectorAcceptsImages(connection), want.image, `${label}: images`);
    assert.equal(connectorAllowsLiveControls(connection), want.live, `${label}: live controls`);
  }
});

test("Codex wire model id prefers the official model field and preserves modality metadata", () => {
  const app = fs.readFileSync(path.join(root, "public", "app.js"), "utf8");
  const start = app.indexOf("function normalizeCodexModel");
  const end = app.indexOf("function normalizeClaudeModel");
  assert.ok(start >= 0 && end > start, "Codex model normalizer should exist");
  const context = vm.createContext({ positiveFinite(value) {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? number : null;
  } });
  vm.runInContext(app.slice(start, end), context);
  const result = context.normalizeCodexModel({ id: "catalog-row", model: "official-wire-model", inputModalities: ["text"], supportedReasoningEfforts: [{ reasoningEffort: "ultra" }] });
  assert.equal(result.id, "official-wire-model");
  assert.deepEqual([...result.inputModalities], ["text"]);
  assert.deepEqual([...result.supportedReasoningEfforts], ["ultra"]);
  assert.equal(result.reasoningEffortsDeclared, true);
});

test("a stored transcript never offers to change anything", () => {
  const { connectorAcceptsImages, connectorAllowsLiveControls } = capabilities();
  // Both read-only markers must win over an otherwise capable connector.
  for (const readOnly of [{ readOnly: true }, { nativeHistoryReadonly: true }]) {
    for (const base of [{ nativeOpenCode: true }, { nativeAcp: true }, { nativeClaudeStructured: true }]) {
      const connection = { generic: true, ...base, ...readOnly };
      assert.equal(connectorAcceptsImages(connection), false);
      assert.equal(connectorAllowsLiveControls(connection), false);
    }
  }
  assert.equal(connectorAcceptsImages(null), false);
  assert.equal(connectorAllowsLiveControls(null), false);
});

test("native Claude/Codex composer uses session-scoped controls and real context DTOs", () => {
  const app = fs.readFileSync(path.join(root, "public", "app.js"), "utf8");
  assert.match(app, /\/api\/codex\/models/);
  assert.match(app, /\/api\/claude\/structured\/models/);
  assert.match(app, /\/api\/claude\/structured\/model/);
  assert.match(app, /\/api\/codex\/context\?threadId=/);
  assert.match(app, /\/api\/claude\/structured\/context\?sessionId=/);
  assert.match(app, /\/api\/codex\/mutation\/turn[\s\S]{0,600}images/);
  assert.match(app, /codexModel\.id/);
  assert.match(app, /\{\s*model:\s*rpc\.codexModel\.id/);
  assert.match(app, /codexEffort/);
  assert.match(app, /\{\s*effort:\s*rpc\.codexEffort/);
  assert.match(app, /contextPercent/);
  assert.match(app, /nativeContextRequestIsCurrent/);
  // Native adapters report contextPercent; the browser must not derive a
  // percentage from cumulative/turn usage when the provider omits it.
  const normalizer = app.slice(app.indexOf("function normalizeNativeContextStats"), app.indexOf("function nativeContextRequestIsCurrent"));
  assert.doesNotMatch(normalizer, /contextTokens\s*\/\s*contextWindow/);
});
