"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createLaunchDiagnostics, normalizeLaunchDiagnostic } = require("../server/agent-launch-diagnostics");
const enabled = { STEPSEMBLE_AGENT_LAUNCH_DIAGNOSTICS: "1" };
const source = name => fs.readFileSync(path.join(__dirname, "..", name), "utf8");
const connectorSource = source("server/agent-connectors.js").split("  async function open(")[1].split("\n  function get(")[0];
const hostSource = source("server.js");
const hostOpenSource = hostSource.split("async function openAgentTask(")[1].split("\n// Goals use")[0];
const routeSource = hostSource.split('if (p === "/api/agent/open" && req.method === "POST") {')[1].split('\n      if (p === "/api/agent/send"')[0];
function connector(overrides = {}) {
  const tasks = new Map(), calls = [];
  const context = { definitionFor: () => ({ id: "claude-code", label: "Claude Code" }), resolveCommand: () => "synthetic-command",
    piBin: "", env: {}, validateCwd: () => "synthetic-cwd", crypto: require("node:crypto"), canonicalJournal: { available: false },
    safeName: () => "synthetic", ptyRuntime: null, supervisorSocketPath: () => "synthetic-socket", supervisorMetadataPath: () => "synthetic-meta",
    taskConfigDir: "", createConnectorApprovalState: () => ({}), desktopClaude: null, appHome: "synthetic-home", tasks,
    createCanonical: async () => ({ kind: "reject", code: "journal_unavailable" }), persist: () => {},
    launchAgentSupervisor: async () => { calls.push("spawn"); return { pid: 123, transport: "pipe" }; },
    waitForSupervisor: async task => { task.status = "running"; calls.push("wait"); }, recordCanonicalStart: async () => { calls.push("start"); },
    publicTask: task => ({ status: task.status }), path: { basename: () => "synthetic-command" },
    setStatus: (task, status) => { task.status = status; calls.push(status); }, process: { kill: () => calls.push("kill") }, ...overrides };
  return { open: vm.runInNewContext(`(async function open(${connectorSource})`, context), tasks, calls };
}
function hostOpen(overrides = {}) {
  const calls = [];
  const context = { workspaceRegistry: { list: () => calls.push("registry"), remember: () => ({}) },
    ensureOpenCodeNativeProbe: async () => calls.push("opencode"), ensureCodexNativeProbe: async () => calls.push("codex"),
    claudeDesktopUpgrade: { isRunning: () => false }, claudeAuth: { isBusy: () => false }, claudeLaunchReservations: 0,
    workspaceSessionName: () => "", ACP_AGENT_IDS: [], claudeStructuredEnabled: false, agentTasks: { open: async (...args) => { calls.push(args); return {}; } }, ...overrides };
  return { open: vm.runInNewContext(`(async function openAgentTask(${hostOpenSource})`, context), context, calls };
}
async function route(env, openAgentTask, body = {}) {
  let response, closes = 0;
  const res = { writableEnded: false, once: () => closes++, off: () => closes-- };
  const context = { process: { env }, createLaunchDiagnostics: () => createLaunchDiagnostics(env), openAgentTask, readJSON: async () => body, req: {}, res, AbortController,
    sendJSON: (_, status, value) => { response = { status, value }; } };
  // Include the route's closing return/block, wrapped in a source-only function.
  await vm.runInNewContext(`(async () => { if (true) {${routeSource}})`, context)();
  assert.equal(closes, 0);
  return JSON.parse(JSON.stringify(response));
}

test("launch diagnostic is opt-in, fixed-schema and monotonic per concurrent request", () => {
  assert.equal(createLaunchDiagnostics({}), null);
  assert.equal(createLaunchDiagnostics({ STEPSEMBLE_AGENT_LAUNCH_DIAGNOSTICS: "true" }), null);
  let time = 0;
  const first = createLaunchDiagnostics(enabled, () => time), second = createLaunchDiagnostics(enabled, () => time);
  first.markStage("canonical_create"); second.markStage("supervisor_spawn");
  for (const [value, bucket] of [[0, "lt_10ms"], [10, "lt_100ms"], [100, "lt_1s"], [1000, "lt_5s"], [5000, "gte_5s"]]) {
    time = value;
    assert.equal(first.failure(new Error("private")).elapsedBucket, bucket);
  }
  assert.equal(first.failure({}).stage, "canonical_create");
  assert.equal(second.failure({}).stage, "supervisor_spawn");
  first.markStage("secret-marker"); assert.equal(first.failure({}).stage, "canonical_create");
  assert.deepEqual(first.failure({ code: "secret-marker", message: "C:\\private\\secret-marker", stack: "secret-marker" }), {
    schemaVersion: 1, stage: "canonical_create", elapsedBucket: "gte_5s", category: "canonical_error", errorFamily: "unknown", code: "unknown",
  });
});

test("launch diagnostic rejects injected enums, inherited fields and accessors, drops extras", () => {
  const diagnostic = createLaunchDiagnostics(enabled, () => 0); diagnostic.markStage("workspace_registry");
  const safe = diagnostic.failure(new Error("workspace_registry_unavailable", { cause: new SyntaxError("secret-marker") }));
  assert.equal(safe.category, "workspace_registry_unavailable"); assert.equal(safe.errorFamily, "parse");
  const coded = diagnostic.failure(new Error("workspace_registry_unavailable", { cause: Object.assign(new Error("secret-marker"), { code: "EACCES" }) }));
  assert.equal(coded.code, "EACCES"); assert.equal(coded.errorFamily, "os");
  assert.deepEqual(normalizeLaunchDiagnostic({ ...safe, message: "secret-marker", stack: "secret-marker", path: "secret-marker", __proto__: null }), safe);
  for (const field of Object.keys(safe)) {
    assert.equal(normalizeLaunchDiagnostic({ ...safe, [field]: "secret-marker" }), null);
    const getter = { ...safe }; Object.defineProperty(getter, field, { get() { throw new Error("must not read"); } });
    assert.equal(normalizeLaunchDiagnostic(getter), null);
  }
  assert.equal(normalizeLaunchDiagnostic(Object.create(safe)), null);
  diagnostic.markStage("opencode_probe"); assert.equal(diagnostic.failure(new Error("secret-marker")).category, "unexpected");
  assert.equal(JSON.stringify(diagnostic.failure({ code: "C:\\private\\secret-marker", message: "secret-marker" })).includes("secret-marker"), false);
});

test("actual connector source propagates stages without changing success, reject status or cleanup", async () => {
  const diagnostic = createLaunchDiagnostics(enabled, () => 0), stages = [];
  const markStage = stage => { stages.push(stage); diagnostic.markStage(stage); };
  const success = connector();
  assert.equal((await success.open({ agentId: "claude-code" }, { markStage })).status, "running");
  assert.deepEqual(stages, ["command_resolution", "cwd_validation", "task_initialization", "canonical_create", "supervisor_spawn", "supervisor_wait", "canonical_start", "public_result"]);
  assert.deepEqual(success.calls, ["spawn", "wait", "start"]);
  const disabled = connector(); await disabled.open({ agentId: "claude-code", markStage: () => { throw new Error("untrusted"); } });
  assert.deepEqual(disabled.calls, success.calls);
  for (const code of [undefined, "secret-marker"]) for (const [seam, stage] of [["createCanonical", "canonical_create"], ["launchAgentSupervisor", "supervisor_spawn"], ["waitForSupervisor", "supervisor_wait"], ["recordCanonicalStart", "canonical_start"]]) {
    const error = Object.assign(new Error("C:\\private\\secret-marker"), { code });
    const fixture = connector({ [seam]: async () => { throw error; } });
    await assert.rejects(fixture.open({ agentId: "claude-code" }, { markStage }), caught => caught === error);
    assert.equal(diagnostic.failure(error).stage, stage);
    assert.equal(diagnostic.failure(error).code, "unknown");
    assert.equal(fixture.calls.filter(call => call === "spawn").length, seam === "createCanonical" || seam === "launchAgentSupervisor" ? 0 : 1);
    if (seam === "waitForSupervisor") assert.deepEqual(fixture.calls, ["spawn", "failed", "kill"]);
  }
  const reject = connector({ createCanonical: async () => ({ kind: "reject", code: "journal_corrupt" }) });
  await assert.rejects(reject.open({ agentId: "claude-code" }, { markStage }), error => error.statusCode === 503);
  assert.equal(reject.tasks.size, 0); assert.deepEqual(reject.calls, []);
  const cwd = connector({ validateCwd: () => null });
  await assert.rejects(cwd.open({ agentId: "claude-code" }, { markStage }), error => error.statusCode === 400 && error.code === "project_folder_unavailable");
});

test("actual Host and HTTP source preserve trusted callback, status, success and disabled contracts", async () => {
  const diagnostic = createLaunchDiagnostics(enabled, () => 0);
  for (const [seam, stage] of [["workspaceRegistry", "workspace_registry"], ["ensureOpenCodeNativeProbe", "opencode_probe"], ["ensureCodexNativeProbe", "codex_probe"], ["claudeAuth", "claude_guard"]]) {
    const error = new Error("secret-marker");
    const stub = seam === "workspaceRegistry" ? { list() { throw error; } } : seam === "claudeAuth" ? { isBusy() { throw error; } } : async () => { throw error; };
    const fixture = hostOpen({ [seam]: stub });
    await assert.rejects(fixture.open({ agentId: "claude-code" }, { launchDiagnostics: diagnostic }), caught => caught === error);
    assert.equal(diagnostic.failure(error).stage, stage);
    assert.equal(fixture.context.claudeLaunchReservations, 0);
  }
  const ordinary = hostOpen(); await ordinary.open({ agentId: "claude-code", launchDiagnostics: "secret-marker" });
  assert.equal(ordinary.calls.at(-1).length, 1);
  const trusted = hostOpen(); await trusted.open({ agentId: "claude-code" }, { launchDiagnostics: diagnostic });
  assert.equal(trusted.calls.at(-1)[1].markStage, diagnostic.markStage);
  assert.equal(trusted.context.claudeLaunchReservations, 0);
  const fail = async (_, options) => { options.launchDiagnostics?.markStage("supervisor_spawn"); throw new Error("fixed-existing-error"); };
  assert.deepEqual(await route({}, fail, { launchDiagnostics: enabled }), { status: 409, value: { error: "fixed-existing-error" } });
  const failed = await route(enabled, fail);
  assert.equal(failed.status, 409); assert.equal(failed.value.launchDiagnostic.stage, "supervisor_spawn");
  const explicit = await route(enabled, async () => { throw Object.assign(new Error("fixed"), { statusCode: 503 }); });
  assert.equal(explicit.status, 503);
  const value = { agentId: "claude-code", status: "running" };
  assert.deepEqual(await route(enabled, async () => value), { status: 201, value });
});

test("codeless registry, canonical and spawn failures reach only sanitized existing soak evidence", async () => {
  const { taskOpenFailureSummary } = await import("../scripts/reliability-soak.mjs");
  for (const stage of ["workspace_registry", "canonical_create", "supervisor_spawn"]) {
    const error = new Error(stage === "workspace_registry" ? "workspace_registry_unavailable" : "C:\\private\\secret-marker");
    const fixture = connector(stage === "canonical_create" ? { createCanonical: async () => { throw error; } }
      : stage === "supervisor_spawn" ? { launchAgentSupervisor: async () => { throw error; } } : {});
    const host = hostOpen({ agentTasks: { open: fixture.open }, ...(stage === "workspace_registry" ? { workspaceRegistry: { list() { throw error; } } } : {}) });
    const response = await route(enabled, host.open, { agentId: "claude-code" });
    assert.equal(response.status, 409);
    const summary = taskOpenFailureSummary({ stage: "task_open", status: response.status, body: response.value, openedTasks: 0, requestedTasks: 8, cleanupConfirmed: true });
    assert.equal(summary.launchDiagnostic.stage, stage); assert.equal(summary.launchDiagnostic.code, "unknown");
    assert.equal(summary.cleanupConfirmed, true); assert.equal(JSON.stringify(summary).includes("secret-marker"), false);
    assert.equal(host.context.claudeLaunchReservations, 0); assert.deepEqual(fixture.calls, stage === "supervisor_spawn" ? ["failed"] : []);
  }
});
