"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { once } = require("node:events");
const { createHttpUtils } = require("../server/http-utils");
const { createAgentModeStore } = require("../server/agent-mode-store");
const { createAgentModeRoutes, codexPresetFor, codexTurnPermissions } = require("../server/agent-mode-routes");

test("the mode store keeps one mode per conversation across a restart and stays bounded", t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "stepsemble-agent-modes-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "agent-modes.json");
  const store = createAgentModeStore({ file });
  assert.equal(store.set("codex", "thread-1", "read-only"), true);
  assert.equal(store.set("claude-code", "session-1", "plan"), true);
  assert.equal(store.set("codex", "../escape", "read-only"), false, "ids are validated");
  assert.equal(store.set("codex", "thread-1", "bad mode!"), false, "modes are validated");
  const reopened = createAgentModeStore({ file });
  assert.equal(reopened.get("codex", "thread-1"), "read-only");
  assert.equal(reopened.get("claude-code", "session-1"), "plan");
  assert.equal(reopened.get("hermes", "unknown"), null);
  if (process.platform !== "win32") assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  for (let index = 0; index < 520; index += 1) reopened.set("opencode", "session-" + index, "build");
  const saved = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(saved.modes.length, 500);
  assert.equal(createAgentModeStore({ file }).get("codex", "thread-1"), null, "the oldest entries go first");
});

test("Codex presets map both ways between Stepsemble and Codex's own policies", () => {
  assert.deepEqual(codexTurnPermissions("read-only"), { approvalPolicy: "on-request", sandboxPolicy: { type: "readOnly" } });
  assert.deepEqual(codexTurnPermissions("workspace"), { approvalPolicy: "on-request", sandboxPolicy: { type: "workspaceWrite" } });
  assert.deepEqual(codexTurnPermissions("full-access"), { approvalPolicy: "never", sandboxPolicy: { type: "dangerFullAccess" } });
  assert.equal(codexTurnPermissions("__proto__"), null);
  assert.equal(codexPresetFor({ approvalPolicy: "never", sandbox: "dangerFullAccess" }), "full-access");
  assert.equal(codexPresetFor({ approvalPolicy: "untrusted", sandbox: "workspaceWrite" }), "custom");
  assert.equal(codexPresetFor(null), null);
});

async function fixture(t, { claudeHelperOutdated } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "stepsemble-agent-mode-routes-"));
  const store = createAgentModeStore({ file: path.join(dir, "agent-modes.json") });
  const calls = [];
  let claudeMode = "bypassPermissions";
  const claude = {
    permissionState: async () => ({ permissionMode: claudeMode }),
    setPermissionMode: async mode => {
      calls.push(["claude", mode]);
      if (mode === "bypassPermissions") throw Object.assign(new Error("refused"), { code: "claude_bypass_unavailable" });
      claudeMode = mode === "manual" ? "default" : mode;
      return { kind: "changed", permissionMode: claudeMode };
    },
    status: () => ({ nativeSessionId: "claude-native-1" }),
  };
  let hermesMode = "default";
  const hermes = {
    sessionConfigOptions: id => id === "hermes-1" ? [{ id: "acp.mode", category: "mode", currentValue: hermesMode, legacy: true,
      options: [{ value: "default", name: "Default", description: "Ask before edits." }, { value: "accept_edits", name: "Accept Edits", description: null }] }] : [],
    setConfigOption: async (id, configId, value) => { calls.push(["hermes", id, configId, value]); hermesMode = value; return { kind: "configured" }; },
  };
  const openCode = {
    status: () => ({ ready: true }),
    agents: async ({ directory }) => { calls.push(["agents", directory]); return [
      { name: "build", description: "The default agent.", mode: "primary" }, { name: "plan", description: "Plan mode.", mode: "primary" },
      { name: "explore", mode: "subagent" }, { name: "title", mode: "primary", hidden: true },
    ]; },
    messages: async () => ({ messages: [{ role: "user", info: { agent: "plan" } }, { role: "assistant", info: {} }] }),
  };
  let codexReady = true;
  const codex = {
    status: () => ({ mutationReady: codexReady }),
    permissionState: id => id === "thread-1" ? { approvalPolicy: "never", sandbox: "dangerFullAccess" } : null,
  };
  const { readJSON, sendJSON } = createHttpUtils();
  const handle = createAgentModeRoutes({ store, codex, claudeHelperOutdated, resolveClaude: id => id === "claude-local-1" || id === "claude-native-1" ? { session: claude } : null,
    openCode, openCodeDirectory: cwd => cwd, acpAdapterForAgent: id => id === "hermes" ? hermes : null, readJSON, sendJSON });
  const server = http.createServer(async (req, res) => {
    if (!await handle(req, res, new URL(req.url, "http://localhost"))) sendJSON(res, 404, { error: "not_found" });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); fs.rmSync(dir, { recursive: true, force: true }); });
  const base = "http://127.0.0.1:" + server.address().port;
  const get = async query => { const response = await fetch(base + "/api/agent-mode?" + new URLSearchParams(query)); return { status: response.status, data: await response.json() }; };
  const post = async body => { const response = await fetch(base + "/api/agent-mode", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }); return { status: response.status, data: await response.json() }; };
  return { store, calls, get, post, setCodexReady(value) { codexReady = value; } };
}

test("each agent reports its own modes and the one in use; Pi and unknown agents report none", async t => {
  const f = await fixture(t);
  const codex = await f.get({ agentId: "codex", sessionId: "codex:thread-1" });
  assert.deepEqual(codex.data.modes.map(mode => mode.id), ["read-only", "workspace", "full-access"]);
  assert.equal(codex.data.current, "full-access");
  assert.equal(codex.data.appliesNextTurn, true);
  const claude = await f.get({ agentId: "claude-code", sessionId: "claude-local-1" });
  assert.deepEqual(claude.data.modes.map(mode => mode.id), ["default", "acceptEdits", "plan", "auto", "dontAsk", "bypassPermissions"]);
  assert.equal(claude.data.current, "bypassPermissions");
  const openCode = await f.get({ agentId: "opencode", sessionId: "oc-1", cwd: "/owned/project" });
  assert.deepEqual(openCode.data.modes.map(mode => mode.id), ["build", "plan"], "only visible primary agents are modes");
  assert.equal(openCode.data.current, "plan", "the agent of the last user message");
  assert.deepEqual(f.calls.shift(), ["agents", "/owned/project"]);
  const hermes = await f.get({ agentId: "hermes", sessionId: "hermes-1" });
  assert.deepEqual(hermes.data.modes.map(mode => [mode.id, mode.label]), [["default", "Default"], ["accept_edits", "Accept Edits"]]);
  assert.equal(hermes.data.current, "default");
  assert.deepEqual((await f.get({ agentId: "pi", sessionId: "anything" })).data, { supported: false });
  assert.deepEqual((await f.get({ agentId: "hermes", sessionId: "missing" })).data, { supported: false });
  assert.equal((await f.get({ agentId: "codex", sessionId: "../escape" })).status, 400);
  f.setCodexReady(false);
  assert.deepEqual((await f.get({ agentId: "codex", sessionId: "thread-1" })).data, { supported: false }, "a terminal-only Codex has no modes");
});

test("changing a mode applies it the agent's way and remembers it for the conversation", async t => {
  const f = await fixture(t);
  f.setCodexReady(true);
  const codex = await f.post({ agentId: "codex", sessionId: "thread-1", mode: "read-only" });
  assert.equal(codex.data.current, "read-only");
  assert.equal(f.store.get("codex", "thread-1"), "read-only");
  assert.equal((await f.post({ agentId: "codex", sessionId: "thread-1", mode: "yolo" })).status, 400);

  const claude = await f.post({ agentId: "claude-code", sessionId: "claude-local-1", mode: "plan" });
  assert.equal(claude.data.current, "plan");
  assert.equal(f.store.get("claude-code", "claude-native-1"), "plan", "kept under Claude's own session id");
  const refused = await f.post({ agentId: "claude-code", sessionId: "claude-local-1", mode: "bypassPermissions" });
  assert.equal(refused.status, 409);
  assert.equal(refused.data.error, "claude_bypass_unavailable");
  assert.equal(f.store.get("claude-code", "claude-native-1"), "plan", "a refused mode is not remembered");

  const openCode = await f.post({ agentId: "opencode", sessionId: "oc-1", mode: "build", cwd: "/owned/project" });
  assert.equal(openCode.data.current, "build");
  assert.equal(f.store.get("opencode", "oc-1"), "build");
  assert.equal((await f.post({ agentId: "opencode", sessionId: "oc-1", mode: "explore" })).status, 400, "a subagent is not a mode");

  const hermes = await f.post({ agentId: "hermes", sessionId: "hermes-1", mode: "accept_edits" });
  assert.equal(hermes.data.current, "accept_edits");
  assert.deepEqual(f.calls.at(-1), ["hermes", "hermes-1", "acp.mode", "accept_edits"]);
  assert.equal(f.store.get("hermes", "hermes-1"), "accept_edits");
  assert.equal((await f.post({ agentId: "pi", sessionId: "anything", mode: "x" })).status, 409);
});

test("a Bypass refusal from an old desktop helper says the helper needs the update", async t => {
  const f = await fixture(t, { claudeHelperOutdated: async () => true });
  const refused = await f.post({ agentId: "claude-code", sessionId: "claude-local-1", mode: "bypassPermissions" });
  assert.equal(refused.status, 409);
  assert.equal(refused.data.error, "claude_bypass_helper_outdated");
  // Other modes still change through the same helper.
  assert.equal((await f.post({ agentId: "claude-code", sessionId: "claude-local-1", mode: "plan" })).data.current, "plan");
});
