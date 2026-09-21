"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { createWorkspaceRegistry } = require("../server/workspace-registry");
function fixture(t) { const dir = fs.mkdtempSync(path.join(os.tmpdir(), "workspace-registry-")); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return path.join(dir, "workspaces.json"); }
test("workspace membership persists without importing provider histories", t => {
  const file = fixture(t), registry = createWorkspaceRegistry(file);
  assert.deepEqual(registry.list().entries, []);
  registry.project("/project"); assert.equal(registry.list().entries.length, 0);
  const owned = registry.remember({ id: "codex:owned", agentId: "codex", cwd: "/project", name: "Same title", secret: "must-not-persist", outputTail: "private transcript", mutation: "native_api" });
  const imported = registry.remember({ id: "codex:external", agentId: "codex", cwd: "/project", name: "Same title", readOnly: true }, "added");
  assert.notEqual(owned.key, imported.key);
  assert.equal(createWorkspaceRegistry(file).get(owned.key).record.mutation, "native_api");
  assert.equal(createWorkspaceRegistry(file).get(imported.key).record.readOnly, true);
  assert.ok(!fs.readFileSync(file, "utf8").includes("must-not-persist"));
  assert.ok(!fs.readFileSync(file, "utf8").includes("private transcript"));
  registry.remove(imported.key); assert.equal(registry.list().entries.length, 1);
});
test("Pi learns its durable file without creating a second membership", t => {
  const file = fixture(t), registry = createWorkspaceRegistry(file);
  const first = registry.remember({ sid: "rpc-1", agentId: "pi", cwd: "/project" });
  const second = registry.remember({ sid: "rpc-1", agentId: "pi", file: "project/session.jsonl" });
  assert.equal(first.key, second.key); assert.equal(registry.list().entries.length, 1);
  assert.equal(createWorkspaceRegistry(file).get(first.key).record.file, "project/session.jsonl");
});
test("corrupt registry fails closed without replacing the user's file", t => {
  const file = fixture(t); fs.writeFileSync(file, "broken"); const registry = createWorkspaceRegistry(file);
  assert.throws(() => registry.list(), /unavailable/);
  assert.throws(() => registry.project("/project"), /unavailable/);
  assert.equal(fs.readFileSync(file, "utf8"), "broken");
});
test("native identity updates preserve product identity and provenance", t => {
  const registry = createWorkspaceRegistry(fixture(t)); const row = registry.remember({ id: "claude-code:local", agentId: "claude-code" });
  registry.update(row.key, { nativeSessionId: "native-real", persisted: true });
  assert.equal(registry.get(row.key).record.nativeSessionId, "native-real");
  assert.equal(registry.get(row.key).origin, "created");
});

test("resuming a persisted Claude identity updates its original workspace entry", t => {
  const registry = createWorkspaceRegistry(fixture(t));
  const first = registry.remember({ id: "claude-code:old", agentId: "claude-code", nativeClaudeStructured: true, nativeSessionId: "native-identity", persisted: true });
  const resumed = registry.remember({ id: "claude-code:new", agentId: "claude-code", nativeClaudeStructured: true, nativeSessionId: "native-identity", persisted: true }, "added");
  assert.equal(resumed.key, first.key); assert.equal(resumed.origin, "created");
  assert.equal(registry.list().entries.length, 1);
  assert.equal(registry.get(first.key).record.id, "claude-code:new");
});
