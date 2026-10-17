"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { createWorkspaceRegistry } = require("../server/workspace-registry");
function fixture(t) { const dir = fs.mkdtempSync(path.join(os.tmpdir(), "workspace-registry-")); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return path.join(dir, "workspaces.json"); }
test("completed unread state persists, survives identity updates, and acknowledges only the viewed result", t => {
  const file = fixture(t), registry = createWorkspaceRegistry(file);
  const row = registry.remember({ id: "codex:a", agentId: "codex", nativeThreadId: "a" });
  const event = { key: row.key, id: "00000000-0000-4000-8000-000000000001:1", kind: "completed", at: 100 };
  assert.equal(row.completion, undefined, "imported history is not retroactively unread");
  registry.completed(event);
  assert.equal(registry.list().entries[0].completion.read, false);
  assert.equal(registry.completed({ ...event, kind: "approval" }), null);
  registry.remember({ ...row.record, name: "Renamed" });
  registry.update(row.key, { nativeSessionId: "resumed" });
  assert.deepEqual(createWorkspaceRegistry(file).get(row.key).completion, { id: event.id, kind: event.kind, at: event.at, read: false });
  registry.markRead(row.key, event.id);
  registry.completed(event);
  assert.equal(registry.get(row.key).completion.read, true, "replayed completion cannot create unread again");
  const newer = { ...event, id: event.id.replace(":1", ":2"), kind: "failed", at: 200 };
  registry.completed(newer);
  registry.markRead(row.key, event.id);
  assert.equal(registry.get(row.key).completion.read, false, "late read from another device cannot clear a newer result");
  assert.equal(registry.get(row.key).completion.kind, "failed");
  registry.markRead(row.key, newer.id);
  assert.equal(createWorkspaceRegistry(file).get(row.key).completion.read, true);
  registry.remove(row.key);
  assert.equal(registry.completed(newer), null);
  assert.equal(registry.markRead(row.key, newer.id), null);
});
test("Host lifecycle persists outcomes independently of push delivery and ignores replay and intermediate Goal turns", t => {
  const registry = createWorkspaceRegistry(fixture(t));
  const row = registry.remember({ id: "codex:a", agentId: "codex", nativeThreadId: "a" });
  let goal = false;
  const notifications = require("../server/notifications").createNotifications({ entries: () => registry.list().entries,
    host: () => "mini", quietCompletion: () => goal,
    publish(event) { registry.completed(event); throw new Error("notifications disabled"); } });
  const observe = event => notifications.observe("codex", "a", event);
  observe({ type: "turn.started", turnId: "one" });
  assert.equal(notifications.working(row), true);
  observe({ type: "turn.completed", turnId: "old", status: "completed" });
  assert.equal(registry.get(row.key).completion, undefined);
  observe({ type: "turn.completed", turnId: "one", status: "completed" });
  assert.equal(notifications.working(row), false);
  const completion = registry.get(row.key).completion;
  registry.markRead(row.key, completion.id);
  observe({ type: "turn.started", turnId: "one", isReplay: true });
  observe({ type: "turn.completed", turnId: "one", status: "completed", isReplay: true });
  assert.equal(registry.get(row.key).completion.read, true);
  goal = true;
  observe({ type: "turn.started", turnId: "two" });
  observe({ type: "turn.completed", turnId: "two", status: "completed" });
  assert.equal(registry.get(row.key).completion.id, completion.id);
  notifications.finished({ entry: row.key, status: "blocked" });
  assert.equal(registry.get(row.key).completion.kind, "blockedGoal");
  assert.equal(registry.get(row.key).completion.read, false);
  goal = false;
  observe({ type: "turn.started", turnId: "three" });
  observe({ type: "transport.failed", turnId: "three" });
  assert.equal(registry.get(row.key).completion.kind, "failed");
  assert.equal(notifications.working(row), false);
});
const order = require("../public/modules/workspace-order");
test("pins and custom order persist while native identities and memberships stay intact", t => {
  const file = fixture(t), registry = createWorkspaceRegistry(file);
  const a = registry.remember({ id: "codex:a", agentId: "codex", nativeThreadId: "native-a", cwd: "/A" });
  const b = registry.remember({ id: "claude-code:b", agentId: "claude-code", cwd: "/A" });
  const c = registry.remember({ id: "pi:c", agentId: "pi", sid: "c", cwd: "/B" });
  registry.project("/C");
  const members = registry.list().entries;
  registry.arrange({ kind: "project", id: "/C", pinned: true });
  registry.arrange({ kind: "project", id: "/B", before: "/A" });
  registry.arrange({ kind: "session", id: b.key, before: a.key });
  assert.deepEqual(order.projects(registry.list()), ["/C", "/B", "/A"]);
  // Sessions follow their activity now; an older client's saved order is kept but not shown.
  assert.deepEqual(order.entries(registry.list(), "/A").map(row => row.key), [a.key, b.key]);
  registry.arrange({ kind: "session", id: a.key, pinned: true });
  assert.throws(() => registry.arrange({ kind: "session", id: b.key, before: a.key }), /target_invalid/);
  assert.throws(() => registry.arrange({ kind: "session", id: b.key, before: c.key }), /target_invalid/);
  assert.throws(() => registry.arrange({ kind: "session", id: "absent", before: null }), /missing/);
  assert.deepEqual(createWorkspaceRegistry(file).list(), registry.list());
  assert.deepEqual(registry.list().entries, members);
  registry.arrange({ kind: "session", id: a.key, pinned: false });
  registry.arrange({ kind: "session", id: a.key, before: null });
  assert.deepEqual(order.entries(registry.list(), "/A").map(row => row.key), [a.key, b.key]);
  registry.remove(a.key); registry.removeProject("/C");
  assert.ok(!registry.list().presentation.sessionOrder.includes(a.key));
  assert.deepEqual(registry.list().presentation.pinnedProjects, []);
});
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
test("removing one project removes only its workspace memberships", t => {
  const file = fixture(t), registry = createWorkspaceRegistry(file);
  const one = registry.remember({ id: "codex:one", agentId: "codex", cwd: "/home/Projects" });
  const two = registry.remember({ id: "codex:two", agentId: "codex", cwd: "/volumes/Projects" });
  assert.deepEqual(registry.removeProject("/home/Projects"), [one.key]);
  assert.deepEqual(createWorkspaceRegistry(file).list().projects, ["/volumes/Projects"]);
  assert.deepEqual(registry.list().entries.map(row => row.key), [two.key]);
  assert.equal(registry.removeProject("/home/Projects"), null);
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

test("a project's sessions list pins first, then the one at work, then the latest activity", () => {
  const row = (key, fields = {}) => ({ key, record: { agentId: "pi", sid: key, cwd: "/A" }, ...fields });
  const snapshot = { projects: ["/A"], entries: [row("old", { activityAt: 100 }), row("new", { activityAt: 300 }), row("never"), row("busy", { activityAt: 50, working: true }),
    row("pinned", { activityAt: 10 }), row("mid", { activityAt: 200 }), row("elsewhere", { activityAt: 999, record: { agentId: "pi", sid: "x", cwd: "/B" } })],
    presentation: { pinnedSessions: ["pinned"], sessionOrder: ["old", "mid"] } };
  assert.deepEqual(order.entries(snapshot, "/A").map(item => item.key), ["pinned", "busy", "new", "mid", "old", "never"]);
  snapshot.entries.find(item => item.key === "old").activityAt = 500;
  assert.equal(order.entries(snapshot, "/A")[2].key, "old", "a reply moves a session up");
  snapshot.entries.push(row("tie-a", { activityAt: 5 }), row("tie-b", { activityAt: 5 }));
  assert.deepEqual(order.entries(snapshot, "/A").slice(-3).map(item => item.key), ["tie-a", "tie-b", "never"], "equal times keep their place");
});

test("a session's latest activity persists, never moves back, and survives a restart", t => {
  const file = fixture(t), registry = createWorkspaceRegistry(file);
  const a = registry.remember({ id: "pi:a", agentId: "pi", sid: "a", cwd: "/A" });
  assert.equal(registry.touched(a.key, 5000).activityAt, 5000);
  assert.equal(registry.touched(a.key, 4000).activityAt, 5000, "an older time never moves it back");
  assert.equal(registry.touched("absent", 6000), null);
  assert.equal(registry.touched(a.key, Number.NaN).activityAt, 5000);
  registry.touched(a.key, 7000);
  registry.update(a.key, { name: "Renamed" });
  assert.equal(createWorkspaceRegistry(file).get(a.key).activityAt, 7000);
});

