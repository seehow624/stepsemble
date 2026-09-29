"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createModelVisibilityStore } = require("../server/model-visibility-store");

test("the model menu's hidden models and providers are kept on the Host, owner-only", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "stepsemble-model-visibility-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "config", "model-visibility.json");
  const store = createModelVisibilityStore({ file });
  // Never written: every device still has its own list to bring.
  assert.deepEqual(store.read(), { saved: false, hidden: [], updatedAt: null });
  let result = store.change({ hide: ["minimax::*", "openai-codex::gpt-5.5", "opencode-go::glm-5.3:cloud"] });
  assert.equal(result.saved, true);
  assert.deepEqual(result.hidden, ["minimax::*", "openai-codex::gpt-5.5", "opencode-go::glm-5.3:cloud"]);
  if (process.platform !== "win32") assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  // Another device shows one and hides one; nothing else changes.
  result = store.change({ show: ["minimax::*"], hide: ["openai-codex::gpt-5.4"] });
  assert.deepEqual(result.hidden, ["openai-codex::gpt-5.4", "openai-codex::gpt-5.5", "opencode-go::glm-5.3:cloud"]);
  assert.deepEqual(createModelVisibilityStore({ file }).read().hidden, result.hidden, "read back after a restart");
  // What is not a key is refused, and the list stays as it was.
  for (const bad of [["no-separator"], ["::model"], ["provider::"], ["a\u0000b::c"], ["x".repeat(600) + "::y"], "minimax::*", [42]]) {
    assert.throws(() => store.change({ hide: bad }), error => error.statusCode === 400, JSON.stringify(bad).slice(0, 40));
  }
  assert.deepEqual(store.read().hidden, result.hidden);
  // A damaged file reads as never written, not as an error.
  fs.writeFileSync(file, "{not json");
  assert.equal(store.read().saved, false);
});
