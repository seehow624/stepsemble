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
    // Claude Code takes Anthropic image blocks but exposes no model route.
    ["claude", { generic: true, nativeClaudeStructured: true }, { image: true, live: false }],
    // A terminal CLI reads text on stdin; anything else is dropped unseen.
    ["terminal cli", { generic: true }, { image: false, live: false }],
  ];
  for (const [label, connection, want] of expected) {
    assert.equal(connectorAcceptsImages(connection), want.image, `${label}: images`);
    assert.equal(connectorAllowsLiveControls(connection), want.live, `${label}: live controls`);
  }
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
