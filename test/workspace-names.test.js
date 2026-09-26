"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { workspaceSessionName, workspaceAutoName, workspacePlaceholderName, workspaceMayAutoName } = require("../server/workspace-names");

test("a session name is one clean line of at most 120 characters", () => {
  assert.equal(workspaceSessionName("  API\n\t設計  "), "API 設計");
  assert.equal(workspaceSessionName("   "), "");
  assert.equal(workspaceSessionName(42), "");
  assert.equal(Array.from(workspaceSessionName("名".repeat(200))).length, 120);
});

test("an unnamed session takes a short title from the first line of its first message", () => {
  assert.equal(workspaceAutoName("你現在是什麼模型呢"), "你現在是什麼模型呢");
  assert.equal(workspaceAutoName("\n## Fix the flaky login test on Safari and make sure the retry banner never shows twice\nmore"),
    "Fix the flaky login test on Safari and make…");
  // Chinese takes twice the room, and a Chinese phrase is not dropped to
  // keep an English word whole.
  assert.equal(workspaceAutoName("幫我看一下為什麼 Safari 上的登入測試會偶爾失敗，還有重試的橫幅為什麼會出現兩次"),
    "幫我看一下為什麼 Safari 上的登入測試會偶爾失敗…");
  assert.equal(workspaceAutoName("> quoted question"), "quoted question");
  // A command names nothing.
  assert.equal(workspaceAutoName("/model sonnet"), "");
  assert.equal(workspaceAutoName("  /login"), "");
  assert.equal(workspaceAutoName(" \n "), "");
});

test("only the names agents give unnamed sessions count as no name", () => {
  for (const name of ["", "Claude Code", "Claude Code 61fdc56e", "Grok 01a0d8d4", "Kilo Code ses_4d3a9", "Codex 019a0b1c",
    "OpenCode ses_3f2e1d0c", "New session - 2026-09-26T00:00:00.000Z", "Antigravity 7f3c2a10", "Pi"]) {
    assert.equal(workspacePlaceholderName(name), true, name);
  }
  for (const name of ["測試", "Codex demo", "Claude Code notes", "API 開發", "Grok research"]) assert.equal(workspacePlaceholderName(name), false, name);
});

test("a session is named from its first message once, never over a chosen name, and never for Pi", () => {
  assert.equal(workspaceMayAutoName({ agentId: "claude-code", named: false, name: "Claude Code 61fdc56e" }), true);
  // Typed at creation, even when it looks like an agent's own name.
  assert.equal(workspaceMayAutoName({ agentId: "claude-code", named: true, name: "Claude Code 61fdc56e" }), false);
  assert.equal(workspaceMayAutoName({ agentId: "grok-build", named: false, autoNamed: true, name: "Hello" }), false);
  // A session from before names were recorded is judged by its name.
  assert.equal(workspaceMayAutoName({ agentId: "grok-build", name: "Grok 01a0d8d4" }), true);
  assert.equal(workspaceMayAutoName({ agentId: "codex", name: "網站設計" }), false);
  assert.equal(workspaceMayAutoName({ agentId: "pi", named: false, name: "Pi" }), false);
});
