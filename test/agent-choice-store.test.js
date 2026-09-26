"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createAgentChoiceStore, MAX_SESSIONS } = require("../server/agent-choice-store");

test("the last choice for an agent is kept across restarts, and each conversation keeps its own", t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "stepsemble-choices-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "agent-choices.json");
  const store = createAgentChoiceStore({ file });
  assert.equal(store.last("claude-code"), null);
  assert.equal(store.record("claude-code", "session-a", { model: "opus[1m]", effort: "max" }), true);
  // A model change alone keeps the level chosen before.
  store.record("claude-code", "session-b", { model: "sonnet" });
  assert.deepEqual(store.last("claude-code"), { model: "sonnet", effort: "max" });
  assert.deepEqual(store.session("claude-code", "session-a"), { model: "opus[1m]", effort: "max" });
  assert.deepEqual(store.session("claude-code", "session-b"), { model: "sonnet" });
  // A conversation started with the last choice keeps it without changing it.
  store.record("codex", "thread-1", { model: "gpt-6-luna", effort: "max" }, { agent: false });
  assert.equal(store.last("codex"), null);
  assert.deepEqual(store.session("codex", "thread-1"), { model: "gpt-6-luna", effort: "max" });

  const reopened = createAgentChoiceStore({ file });
  assert.deepEqual(reopened.last("claude-code"), { model: "sonnet", effort: "max" });
  assert.deepEqual(reopened.session("claude-code", "session-a"), { model: "opus[1m]", effort: "max" });
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test("choices hold model and level ids only, within bounds", () => {
  const store = createAgentChoiceStore();
  assert.equal(store.record("Bad Agent", null, { model: "x" }), false);
  assert.equal(store.record("hermes", null, { model: "has space" }), false);
  assert.equal(store.record("hermes", null, { model: "x".repeat(257) }), false);
  assert.equal(store.record("hermes", null, { prompt: "secret" }), false);
  assert.equal(store.record("hermes", "../escape", { model: "openrouter:openai/gpt-6-luna" }), true);
  assert.equal(store.session("hermes", "../escape"), null);
  for (let index = 0; index < MAX_SESSIONS + 5; index += 1) store.record("kilo", "s" + index, { model: "m" });
  assert.equal(store.session("kilo", "s0"), null);
  assert.deepEqual(store.session("kilo", "s" + (MAX_SESSIONS + 4)), { model: "m" });
});
