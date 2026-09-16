"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { launchClaudeStructuredSession } = require("../server/claude-structured-launch");

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

test("non-broker local Linux and desktop development launches preserve existing options", async () => {
  for (const platform of ["linux", "win32", "darwin"]) {
    const options = { command: "/fixed/claude", cwd: "/project", env: {} };
    assert.equal(await launchClaudeStructuredSession({ ...options, platform,
      sessionFactory: input => { assert.deepEqual(input, options); return "direct"; } }), "direct");
  }
});
