"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { launchClaudeStructuredSession, parkIdleClaudeStructuredSession } = require("../server/claude-structured-launch");

test("native Claude uses the desktop transport even when the HTTP host is SSH", async () => {
  const child = { marker: "Aqua" }, calls = [];
  const options = { command: "/host/claude", cwd: "/project", env: { SSH_CONNECTION: "background", SECRET: "host-only" },
    sessionId: "resume-id", permissionPromptTool: null, name: "Conversation" };
  const result = await launchClaudeStructuredSession({ ...options, platform: "darwin",
    desktopClient: { async launchStructured(value) { calls.push(value); return child; } },
    sessionFactory(value) { assert.equal(value.spawnImpl(), child); assert.equal(value.name, options.name); return "native-session"; } });
  assert.equal(result, "native-session");
  assert.deepEqual(calls, [{ cwd: "/project", sessionId: "resume-id", permissionPromptTool: null }]);
});

test("missing, old, failed and uncertain desktop helpers never fall back to local spawn", async () => {
  let launched = 0;
  const sessionFactory = () => { launched++; };
  const base = { platform: "darwin", env: { SSH_CONNECTION: "background" }, sessionFactory };
  await assert.rejects(launchClaudeStructuredSession(base), /desktop_required/);
  await assert.rejects(launchClaudeStructuredSession({ ...base, desktopClient: {} }), /desktop_upgrade_required/);
  const error = Object.assign(new Error("desktop_launch_uncertain"), { uncertain: true });
  await assert.rejects(launchClaudeStructuredSession({ ...base, desktopClient: { async launchStructured() { throw error; } } }), e => e === error);
  assert.equal(launched, 0);
});

test("desktop constructor failure terminates only its already-owned child and does not retry", async () => {
  const killed = []; let launches = 0;
  await assert.rejects(launchClaudeStructuredSession({ cwd: "/project",
    desktopClient: { async launchStructured() { launches++; return { kill: signal => killed.push(signal) }; } },
    sessionFactory() { throw new Error("invalid_session_options"); } }), /invalid_session_options/);
  assert.equal(launches, 1); assert.deepEqual(killed, ["SIGTERM"]);
});

test("a definite capacity rejection parks one resumable idle session and retries the launch once", async () => {
  const calls = [], child = { marker: "Aqua" };
  const desktopClient = { async launchStructured(options) {
    calls.push(["launch", options]);
    if (calls.filter(row => row[0] === "launch").length === 1) throw Object.assign(new Error("desktop_capacity"), { code: "desktop_capacity" });
    return child;
  } };
  const result = await launchClaudeStructuredSession({ cwd: "/project", sessionId: "saved-id", desktopClient,
    onCapacity: async () => { calls.push(["park"]); return true; },
    sessionFactory: options => options.spawnImpl() });
  assert.equal(result, child);
  assert.deepEqual(calls.map(row => row[0]), ["launch", "park", "launch"]);
  assert.deepEqual(calls[0][1], calls[2][1]);
});

test("capacity recovery is bounded and never retries an uncertain launch or kills busy sessions", async () => {
  for (const uncertain of [false, true]) {
    let launches = 0, parks = 0;
    const error = Object.assign(new Error("desktop_capacity"), { code: "desktop_capacity", uncertain });
    await assert.rejects(launchClaudeStructuredSession({ cwd: "/project",
      desktopClient: { async launchStructured() { launches++; throw error; } },
      onCapacity: async () => { parks++; return true; } }), value => value === error);
    assert.equal(launches, uncertain ? 1 : 2);
    assert.equal(parks, uncertain ? 0 : 1);
  }
  let launches = 0;
  await assert.rejects(launchClaudeStructuredSession({ cwd: "/project",
    desktopClient: { async launchStructured() { launches++; throw Object.assign(new Error("desktop_capacity"), { code: "desktop_capacity" }); } },
    onCapacity: async () => false }), error => error.code === "desktop_capacity");
  assert.equal(launches, 1);
});

test("parking selects the oldest resumable idle session and protects work, approvals, unsaved sessions and the requested identity", async () => {
  const parked = [], sessions = new Map();
  const add = (id, at, idle) => sessions.set(id, {
    status: () => ({ nativeSessionId: id, lastActivityAt: at }),
    isIdle: () => idle,
    async suspend() { parked.push(id); return { kind: "closed", cleanupConfirmed: true }; },
  });
  add("busy", 0, false); add("unsaved", 1, true); add("requested", 2, true); add("old-idle", 3, true); add("new-idle", 4, true);
  assert.equal(await parkIdleClaudeStructuredSession({ sessions, excludeSessionId: "requested", canResume: id => id !== "unsaved" }), true);
  assert.deepEqual(parked, ["old-idle"]);
  assert.equal(sessions.has("old-idle"), false);
  assert.equal(sessions.size, 4);
});

test("parking rechecks idleness and an unconfirmed cleanup does not free a slot", async () => {
  let closes = 0;
  const sessions = new Map([["old-idle", {
    status: () => ({ nativeSessionId: "old-idle", lastActivityAt: 1 }), isIdle: () => true,
    async suspend() { closes++; return { kind: "closed", cleanupConfirmed: false }; },
  }]]);
  assert.equal(await parkIdleClaudeStructuredSession({ sessions, canResume: () => true }), false);
  assert.equal(sessions.size, 1);
  assert.equal(closes, 1);
  sessions.get("old-idle").suspend = async () => ({ kind: "reject", code: "claude_session_busy" });
  assert.equal(await parkIdleClaudeStructuredSession({ sessions, canResume: () => true }), false);
  assert.equal(sessions.size, 1);
});

test("non-broker local Linux and desktop development launches preserve existing options", async () => {
  for (const platform of ["linux", "win32", "darwin"]) {
    const options = { command: "/fixed/claude", cwd: "/project", env: {} };
    assert.equal(await launchClaudeStructuredSession({ ...options, platform,
      sessionFactory: input => { assert.deepEqual(input, options); return "direct"; } }), "direct");
  }
});
