"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { createAntigravityGate, hooksDocument } = require("../server/antigravity-gate");
const { createAntigravityAcpBridge, classifyTool, parseModelList, displayArgs } = require("../server/antigravity-acp-bridge");

const unix = { skip: process.platform === "win32" ? "the fake agy runs its hooks with /bin/sh" : false };
const FAKE_AGY = path.join(__dirname, "..", "test-support", "fake-agy.cjs");
const HOOK = path.join(__dirname, "..", "server", "antigravity-approval-hook.js");
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, label, timeoutMs = 10_000) {
  const end = Date.now() + timeoutMs;
  while (!(await predicate()) && Date.now() < end) await sleep(25);
  assert.ok(await predicate(), label);
}
const PNG = Buffer.from("89504e470d0a1a0a0000000d4948445200000001000000010802000000907753de0000000c4944415408d763f8cfc0000003010100c9fe92ef0000000049454e44ae426082", "hex");

// A throwaway HOME with the fake agy on a fixed path, a gate and a bridge.
function setup(t, { env = {}, gateOverride = null, models = true, history = null } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "stepsemble-agy-bridge-")));
  const bin = path.join(root, "bin"), project = path.join(root, "project"), config = path.join(root, "config");
  fs.mkdirSync(bin); fs.mkdirSync(project); fs.mkdirSync(config);
  const agy = path.join(bin, "agy");
  fs.writeFileSync(agy, `#!/bin/sh\nexec "${process.execPath}" "${FAKE_AGY}" "$@"\n`, { mode: 0o755 });
  const log = path.join(root, "agy.log"), commands = path.join(root, "commands.log");
  const fullEnv = { PATH: [bin, path.dirname(process.execPath), "/usr/bin", "/bin"].join(path.delimiter), HOME: root,
    FAKE_AGY_LOG: log, FAKE_AGY_COMMANDS: commands, FAKE_AGY_UUID_IDS: "1", ...env };
  let bridge = null;
  const gate = gateOverride || createAntigravityGate({ directory: path.join(config, "antigravity-gate"), runDirectory: path.join(config, "run"),
    decide: (owner, payload, options) => bridge.decide(owner, payload, options) });
  const make = (registry = path.join(config, "acp-antigravity-sessions.json")) => createAntigravityAcpBridge({
    command: agy, cwd: root, env: fullEnv, gate, agyHome: path.join(root, ".gemini", "antigravity-cli"), registryFile: registry,
    defaultModel: () => "magpie/fake/model", gatewayOnly: () => models, history,
    modelInfo: id => id === "magpie/fake/model" ? { name: "Fake Model", contextWindow: 200000, efforts: ["low", "medium", "high", "xhigh"] }
      : id === "magpie/fake/other" ? { name: "Other Model", contextWindow: 1000000, efforts: ["low", "high"] } : null,
  });
  bridge = make();
  const starts = () => (fs.existsSync(log) ? fs.readFileSync(log, "utf8") : "").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)).filter(row => row.args.includes("stream-json"));
  const ran = () => (fs.existsSync(commands) ? fs.readFileSync(commands, "utf8") : "").trim().split("\n").filter(Boolean);
  t.after(async () => {
    await bridge.close();
    if (!gateOverride) await gate.close();
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  return { root, project, config, gate, get bridge() { return bridge; }, set bridge(value) { bridge = value; }, make, starts, ran };
}
const updates = (bridge, id, kind) => bridge.sessionEvents(id).map(row => row.update).filter(update => !kind || update.sessionUpdate === kind);
const texts = (bridge, id) => updates(bridge, id, "agent_message_chunk").map(update => update.content.text).join("");

test("tool calls are classified for the gate, and their arguments carry the names the page reads", () => {
  assert.equal(classifyTool("read_file"), "read");
  assert.equal(classifyTool("invoke_subagent"), "quiet");
  assert.equal(classifyTool("manage_task", { Action: "list" }), "quiet");
  assert.equal(classifyTool("manage_task", { Action: "send_input" }), "ask");
  assert.equal(classifyTool("write_file"), "edit");
  assert.equal(classifyTool("edit_file"), "edit");
  assert.equal(classifyTool("run_command"), "ask");
  assert.equal(classifyTool("search_web"), "ask");
  assert.equal(classifyTool("some_new_tool"), "ask", "an unknown tool is asked about");
  assert.deepEqual(displayArgs({ CommandLine: "npm test", Path: "/a" }), { CommandLine: "npm test", Path: "/a", command: "npm test", path: "/a" });
  assert.deepEqual(parseModelList("Fetching available models...\nmagpie/x/y\tmagpie/x/y\ngemini-a-high\tGemini A (High)\nbad id\n"),
    [{ id: "magpie/x/y", name: "magpie/x/y" }, { id: "gemini-a-high", name: "Gemini A (High)" }]);
  const document = hooksDocument({ nodePath: "/opt/node's/bin/node", hookScript: "/srv/hook.js", platform: "darwin" });
  const hook = document["stepsemble-approval"].PreToolUse[0];
  assert.equal(hook.matcher, "*");
  assert.equal(hook.hooks[0].command, "'/opt/node'\\''s/bin/node' '/srv/hook.js'");
  assert.ok(hook.hooks[0].timeout >= 3600, "agy waits for the person");
});

test("the hook always prints a decision, and denies whenever it cannot ask Stepsemble", unix, async () => {
  const run = (env, input) => new Promise(resolve => {
    const child = spawn(process.execPath, [HOOK], { env: { PATH: process.env.PATH, ...env }, stdio: ["pipe", "pipe", "ignore"] });
    let out = ""; child.stdout.on("data", text => { out += text; });
    child.on("close", code => resolve({ code, decision: out.trim() ? JSON.parse(out.trim()) : null }));
    child.stdin.end(input);
  });
  const payload = JSON.stringify({ toolCall: { name: "run_command", args: { CommandLine: "rm -rf /" } }, stepIdx: 2 });
  for (const [env, input] of [[{}, payload], [{ STEPSEMBLE_AGY_GATE: "/nonexistent/socket", STEPSEMBLE_AGY_GATE_TOKEN: "a".repeat(64) }, payload],
    [{ STEPSEMBLE_AGY_GATE: "/nonexistent/socket", STEPSEMBLE_AGY_GATE_TOKEN: "short" }, payload], [{}, "not json"]]) {
    const result = await run(env, input);
    assert.equal(result.code, 0);
    assert.equal(result.decision?.decision, "deny", JSON.stringify(env));
    assert.ok(result.decision.reason);
  }
});

test("the gate answers only an agy process it started, and asks the bridge for it", unix, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "stepsemble-agy-gate-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const asked = [];
  const gate = createAntigravityGate({ directory: path.join(root, "gate"), runDirectory: path.join(root, "run"),
    decide: async (owner, payload) => { asked.push({ owner, tool: payload.toolCall.name }); return { decision: "allow", reason: "ok" }; } });
  t.after(() => gate.close());
  await gate.ready;
  const hooks = JSON.parse(fs.readFileSync(path.join(root, "gate", ".agents", "hooks.json"), "utf8"));
  assert.match(hooks["stepsemble-approval"].PreToolUse[0].hooks[0].command, /antigravity-approval-hook\.js/);
  const token = gate.issue("owner-1");
  assert.deepEqual(gate.launch(token).args, ["--dangerously-skip-permissions", "--add-dir", path.join(root, "gate")]);
  const ask = (env) => new Promise(resolve => {
    const child = spawn(process.execPath, [HOOK], { env: { PATH: process.env.PATH, ...env }, stdio: ["pipe", "pipe", "ignore"] });
    let out = ""; child.stdout.on("data", text => { out += text; });
    child.on("close", () => resolve(JSON.parse(out.trim())));
    child.stdin.end(JSON.stringify({ toolCall: { name: "run_command", args: {} }, stepIdx: 1 }));
  });
  assert.equal((await ask(gate.launch(token).env)).decision, "allow");
  assert.deepEqual(asked, [{ owner: "owner-1", tool: "run_command" }]);
  assert.equal((await ask({ ...gate.launch(token).env, STEPSEMBLE_AGY_GATE_TOKEN: "b".repeat(64) })).decision, "deny", "another token is refused");
  gate.revoke(token);
  assert.equal((await ask(gate.launch(token).env)).decision, "deny", "a revoked token is refused");
  assert.equal(asked.length, 1);
});

test("agy finds Stepsemble's hook as Stepsemble wrote it at every start, and old pictures go", unix, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "stepsemble-agy-gate-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const old = path.join(root, "gate", "attachments", "old-conversation"), recent = path.join(root, "gate", "attachments", "recent-conversation");
  fs.mkdirSync(old, { recursive: true }); fs.mkdirSync(recent, { recursive: true });
  const longAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
  fs.utimesSync(old, longAgo, longAgo);
  const gate = createAntigravityGate({ directory: path.join(root, "gate"), runDirectory: path.join(root, "run"), decide: async () => ({ decision: "deny" }) });
  t.after(() => gate.close());
  assert.deepEqual(fs.readdirSync(path.join(root, "gate", "attachments")), ["recent-conversation"]);
  const file = path.join(root, "gate", ".agents", "hooks.json"), written = fs.readFileSync(file, "utf8");
  // An agent that changed the file (it works in this folder too) does not
  // change what the next agy process runs.
  fs.writeFileSync(file, JSON.stringify({ "stepsemble-approval": { PreToolUse: [] } }));
  gate.launch(gate.issue("owner"));
  assert.equal(fs.readFileSync(file, "utf8"), written);
});

test("a new conversation is agy's own, answers in the stream, reports context and is kept for a restart", unix, async t => {
  const s = setup(t);
  const created = await s.bridge.createSession({ directory: s.project, name: "First" });
  assert.equal(created.kind, "created");
  assert.match(created.sessionId, /^[0-9a-f-]{36}$/, "the id agy gave in init");
  const model = created.configOptions.find(option => option.category === "model");
  assert.equal(model.currentValue, "magpie/fake/model");
  assert.deepEqual(model.options.map(option => option.value), ["magpie/fake/model", "magpie/fake/other"], "only the gateway's models");
  assert.equal(model.options[0].name, "Fake Model");
  const thought = created.configOptions.find(option => option.category === "thought_level");
  assert.deepEqual(thought.options.map(option => option.value), ["auto", "low", "medium", "high"], "agy takes no other level for a gateway model");
  const mode = created.configOptions.find(option => option.category === "mode");
  assert.equal(mode.currentValue, "default");
  const result = await s.bridge.prompt(created.sessionId, "hello");
  assert.deepEqual(result, { kind: "prompted", sessionId: created.sessionId, result: { stopReason: "end_turn" } });
  assert.match(texts(s.bridge, created.sessionId), /fake answer 1 \(magpie\/fake\/model\)/);
  assert.deepEqual(updates(s.bridge, created.sessionId, "user_message_chunk").map(update => update.content.text), ["hello"]);
  const usage = updates(s.bridge, created.sessionId, "usage_update").pop();
  assert.equal(usage.used, 1000); assert.equal(usage.size, 200000);
  assert.equal(s.bridge.sessionWorking(created.sessionId), false);
  const start = s.starts()[0];
  assert.ok(start.gate, "the hook's environment was given");
  assert.ok(start.args.includes("--dangerously-skip-permissions") && start.args.includes("--add-dir"), "the gate is the only approval");
  const saved = JSON.parse(fs.readFileSync(path.join(s.config, "acp-antigravity-sessions.json"), "utf8"));
  assert.equal(saved.sessions[0].id, created.sessionId);
  assert.equal(saved.sessions[0].cwd, s.project);
});

test("an action that needs approval waits for the person, who allows, denies or allows it for the conversation", unix, async t => {
  const s = setup(t);
  const { sessionId } = await s.bridge.createSession({ directory: s.project });
  let turn = s.bridge.prompt(sessionId, "please [run:npm test]");
  await until(() => s.bridge.pendingPermissions().length === 1, "the person is asked");
  const ask = s.bridge.pendingPermissions()[0];
  assert.equal(ask.sessionId, sessionId);
  assert.equal(ask.params.toolCall.title, "Run npm test");
  assert.equal(ask.params.toolCall.rawInput.command, "npm test");
  assert.deepEqual(ask.params.options.map(option => option.kind), ["allow_once", "allow_always", "reject_once"]);
  assert.equal(s.bridge.sessionWorking(sessionId), true);
  assert.equal(s.bridge.respondPermission(ask.id, { outcome: { outcome: "selected", optionId: "allow_once" } }).kind, "written");
  assert.equal((await turn).kind, "prompted");
  assert.deepEqual(s.ran(), ["npm test"]);
  const tool = updates(s.bridge, sessionId).filter(update => update.toolCallId && update.name === "run_command");
  assert.equal(tool[0].sessionUpdate, "tool_call"); assert.equal(tool.at(-1).status, "completed");

  turn = s.bridge.prompt(sessionId, "again [run:rm -rf build]");
  await until(() => s.bridge.pendingPermissions().length === 1, "asked again");
  s.bridge.respondPermission(s.bridge.pendingPermissions()[0].id, { outcome: { outcome: "selected", optionId: "reject_once" } });
  await turn;
  assert.deepEqual(s.ran(), ["npm test"], "a denied command never ran");
  assert.equal(updates(s.bridge, sessionId, "tool_call_update").at(-1).status, "failed");

  turn = s.bridge.prompt(sessionId, "[run:npm run lint]");
  await until(() => s.bridge.pendingPermissions().length === 1, "asked for the new command");
  s.bridge.respondPermission(s.bridge.pendingPermissions()[0].id, { outcome: { outcome: "selected", optionId: "allow_always" } });
  await turn;
  assert.equal((await s.bridge.prompt(sessionId, "[run:npm run lint]")).kind, "prompted", "the same command needs no second answer");
  assert.equal(s.bridge.pendingPermissions().length, 0);
  assert.deepEqual(s.ran(), ["npm test", "npm run lint", "npm run lint"]);
  assert.equal(s.bridge.respondPermission(999, { outcome: { outcome: "selected", optionId: "allow_once" } }).kind, "reject");
});

test("the approval mode decides at once: edits in the project, plan, bypass", unix, async t => {
  const s = setup(t);
  const { sessionId } = await s.bridge.createSession({ directory: s.project });
  const inside = path.join(s.project, "notes.txt"), outside = path.join(s.root, "outside.txt");
  assert.equal((await s.bridge.setConfigOption(sessionId, "mode", "acceptEdits")).kind, "configured");
  assert.equal((await s.bridge.prompt(sessionId, `[write:${inside}]`)).kind, "prompted");
  assert.ok(fs.existsSync(inside), "an edit in the project is accepted");
  let turn = s.bridge.prompt(sessionId, `[write:${outside}]`);
  await until(() => s.bridge.pendingPermissions().length === 1, "an edit outside the project is asked about");
  s.bridge.respondPermission(s.bridge.pendingPermissions()[0].id, { outcome: { outcome: "selected", optionId: "reject_once" } });
  await turn;
  assert.ok(!fs.existsSync(outside));
  await s.bridge.setConfigOption(sessionId, "mode", "plan");
  assert.equal((await s.bridge.prompt(sessionId, `[write:${outside}] [run:make]`)).kind, "prompted");
  assert.equal(s.bridge.pendingPermissions().length, 0, "plan refuses without asking");
  assert.ok(!fs.existsSync(outside)); assert.deepEqual(s.ran(), []);
  assert.ok(s.starts().at(-1).args.includes("plan"), "agy runs in its plan mode");
  await s.bridge.setConfigOption(sessionId, "mode", "bypassPermissions");
  assert.equal((await s.bridge.prompt(sessionId, "[run:make]")).kind, "prompted");
  assert.deepEqual(s.ran(), ["make"], "bypass runs without asking");
});

test("a changed model or level starts the next turn in agy with them, on the same conversation", unix, async t => {
  const s = setup(t);
  const { sessionId } = await s.bridge.createSession({ directory: s.project });
  await s.bridge.prompt(sessionId, "one");
  const changed = await s.bridge.setConfigOption(sessionId, "model", "magpie/fake/other");
  assert.equal(changed.kind, "configured");
  assert.deepEqual(changed.configOptions.find(option => option.category === "thought_level").options.map(option => option.value), ["auto", "low", "high"],
    "the levels the new model has");
  await s.bridge.setConfigOption(sessionId, "thought_level", "high");
  await s.bridge.prompt(sessionId, "two");
  const last = s.starts().at(-1).args;
  assert.deepEqual([last[last.indexOf("--model") + 1], last[last.indexOf("--effort") + 1], last[last.indexOf("--conversation") + 1]],
    ["magpie/fake/other", "high", sessionId]);
  assert.match(texts(s.bridge, sessionId), /fake answer 1 \(magpie\/fake\/other, high\)/, "the new process answered");
  assert.equal(updates(s.bridge, sessionId, "usage_update").pop().size, 1000000, "the new model's context");
  assert.equal((await s.bridge.setConfigOption(sessionId, "thought_level", "max")).kind, "reject", "a level the model lacks");
});

test("a level agy refuses at start is dropped and the turn runs without it", unix, async t => {
  const s = setup(t, { env: { FAKE_AGY_REJECT_EFFORT: "medium" }, models: false });
  const { sessionId } = await s.bridge.createSession({ directory: s.project });
  await s.bridge.setConfigOption(sessionId, "model", "gemini-fake-high");
  await s.bridge.setConfigOption(sessionId, "thought_level", "medium");
  assert.equal((await s.bridge.prompt(sessionId, "go")).kind, "prompted");
  assert.ok(!s.starts().at(-1).args.includes("--effort"));
  assert.ok(!s.bridge.sessionConfigOptions(sessionId).find(option => option.category === "thought_level").options.some(option => option.value === "medium"));
});

test("Stop ends the turn and the next message continues the conversation", unix, async t => {
  const s = setup(t);
  const { sessionId } = await s.bridge.createSession({ directory: s.project });
  const turn = s.bridge.prompt(sessionId, "think long [slow]");
  await until(() => s.bridge.sessionWorking(sessionId), "working");
  await sleep(100);
  assert.equal((await s.bridge.cancel(sessionId)).kind, "cancelled");
  assert.deepEqual((await turn).result, { stopReason: "cancelled" });
  assert.equal(s.bridge.sessionWorking(sessionId), false);
  assert.equal((await s.bridge.prompt(sessionId, "after the stop")).kind, "prompted");
  assert.ok(s.starts().at(-1).args.includes("--conversation"));
});

test("agy's own screen commands are refused before they end the session; a failed turn says why", unix, async t => {
  const s = setup(t);
  const { sessionId } = await s.bridge.createSession({ directory: s.project });
  for (const text of ["/model magpie/x", "/effort low", "/clear", "  /rename Better"]) {
    const result = await s.bridge.prompt(sessionId, text);
    assert.equal(result.kind, "reject"); assert.equal(result.code, "antigravity_command_unavailable");
  }
  assert.equal((await s.bridge.prompt(sessionId, "still here")).kind, "prompted");
  assert.equal(s.starts().length, 1, "the same agy process kept the conversation");
  const failed = await s.bridge.prompt(sessionId, "[fail]");
  assert.equal(failed.kind, "reject"); assert.equal(failed.error, "model request failed");
  assert.equal(updates(s.bridge, sessionId, "turn_error").pop().message, "model request failed");
});

test("a new kind of event, a line that is not JSON and an unknown result status never end the conversation", unix, async t => {
  const s = setup(t);
  const { sessionId } = await s.bridge.createSession({ directory: s.project });
  const odd = await s.bridge.prompt(sessionId, "something new [odd]");
  assert.equal(odd.kind, "prompted"); assert.deepEqual(odd.result, { stopReason: "end_turn" });
  assert.equal(texts(s.bridge, sessionId), "odd answer", "an answer that was not streamed is drawn whole");
  assert.equal(updates(s.bridge, sessionId, "turn_error").length, 0);
  assert.equal((await s.bridge.prompt(sessionId, "and then")).kind, "prompted");
  assert.equal(s.starts().length, 1, "the same agy process kept the conversation");
});

test("a picture is saved for agy to read, because its stream takes text only", unix, async t => {
  const s = setup(t);
  const { sessionId } = await s.bridge.createSession({ directory: s.project });
  assert.equal((await s.bridge.prompt(sessionId, "what is this?", { images: [{ data: PNG.toString("base64"), mimeType: "image/png" }] })).kind, "prompted");
  const folder = path.join(s.gate.attachmentsDirectory, sessionId);
  const files = fs.readdirSync(folder);
  assert.equal(files.length, 1); assert.match(files[0], /\.png$/);
  assert.deepEqual(fs.readFileSync(path.join(folder, files[0])), PNG);
  const transcript = fs.readFileSync(path.join(s.root, ".gemini", "antigravity-cli", "brain", sessionId, ".system_generated", "logs", "transcript.jsonl"), "utf8");
  assert.match(transcript, /Read it with read_file before you answer/);
  assert.ok(transcript.includes(path.join(folder, files[0])));
  assert.equal((await s.bridge.prompt(sessionId, "", { images: [{ data: PNG.toString("base64"), mimeType: "image/png" }] })).kind, "prompted", "a picture alone is a message");
});

test("after a restart the conversation is listed, opened with its turns and continued", unix, async t => {
  const s = setup(t);
  const { sessionId } = await s.bridge.createSession({ directory: s.project, name: "Keep me" });
  await s.bridge.setConfigOption(sessionId, "model", "magpie/fake/other");
  await s.bridge.prompt(sessionId, "remember zebra");
  await s.bridge.close();
  s.bridge = s.make();
  const listed = s.bridge.sessions().find(row => row.id === sessionId);
  assert.equal(listed.status, "available"); assert.equal(listed.name, "Keep me");
  const loaded = await s.bridge.createSession({ sessionId, directory: s.project });
  assert.equal(loaded.kind, "loaded");
  assert.equal(loaded.configOptions.find(option => option.category === "model").currentValue, "magpie/fake/other", "its own model");
  assert.deepEqual(updates(s.bridge, sessionId, "user_message_chunk").map(update => update.content.text), ["remember zebra"], "the turn agy kept");
  assert.match(texts(s.bridge, sessionId), /fake answer 1/);
  assert.equal((await s.bridge.prompt(sessionId, "and now?")).kind, "prompted");
  const last = s.starts().at(-1).args;
  assert.equal(last[last.indexOf("--conversation") + 1], sessionId);
  assert.equal(last[last.indexOf("--model") + 1], "magpie/fake/other");
});

test("a conversation begun in agy's own screen is listed from agy's list, opened with its turns and continued", unix, async t => {
  let s = null, own = null;
  s = setup(t, { history: async () => own ? [{ id: own, cwd: s.project, name: "From the terminal", lastActivityAt: 1000 }] : [] });
  // agy wrote this conversation; the bridge never opened it.
  const { sessionId } = await s.bridge.createSession({ directory: s.project });
  await s.bridge.prompt(sessionId, "started elsewhere");
  await s.bridge.close();
  fs.rmSync(path.join(s.config, "acp-antigravity-sessions.json"));
  own = sessionId;
  s.bridge = s.make();
  s.bridge.sessions();
  await until(() => s.bridge.sessions().some(row => row.id === sessionId), "listed from agy's list");
  assert.deepEqual(s.bridge.sessions().find(row => row.id === sessionId), { id: sessionId, cwd: s.project, name: "From the terminal", status: "available", eventCount: 0, persisted: true, loaded: false, lastActivityAt: 1000 });
  const loaded = await s.bridge.createSession({ sessionId, directory: s.project, name: "From the terminal" });
  assert.equal(loaded.kind, "loaded");
  assert.deepEqual(updates(s.bridge, sessionId, "user_message_chunk").map(update => update.content.text), ["started elsewhere"]);
  assert.equal(s.bridge.sessions().filter(row => row.id === sessionId).length, 1, "listed once");
  assert.equal((await s.bridge.prompt(sessionId, "continued here")).kind, "prompted");
});

test("a subagent's action is asked about too, and named as the subagent's", unix, async t => {
  const s = setup(t);
  const { sessionId } = await s.bridge.createSession({ directory: s.project });
  const turn = s.bridge.prompt(sessionId, "[subagent-run:rm -rf data]");
  await until(() => s.bridge.pendingPermissions().length === 1, "asked");
  const ask = s.bridge.pendingPermissions()[0];
  assert.equal(ask.params.toolCall.title, "A subagent asks: Run rm -rf data");
  assert.equal(ask.params.toolCall.subagent, true);
  s.bridge.respondPermission(ask.id, { outcome: { outcome: "selected", optionId: "reject_once" } });
  await turn;
  assert.deepEqual(s.ran(), []);
  // The subagent itself is drawn as Claude Code's are.
  const started = updates(s.bridge, sessionId, "tool_call_update").find(update => update.name === "Agent");
  assert.equal(started.status, "completed");
  assert.equal(started.output, "Started Helper (general)");
  assert.equal(started.rawInput.description, "Helper");
  assert.equal(started.rawInput.subagent_type, "general");
  assert.equal(started.rawInput.prompt, "Run rm -rf data");
});

test("an action that finishes without the gate stops the conversation (tripwire)", unix, async t => {
  // A gate that lets agy run without the hook: the bridge must notice.
  const leaky = { ready: Promise.resolve(true), attachmentsDirectory: fs.mkdtempSync(path.join(os.tmpdir(), "stepsemble-leak-")),
    issue: () => "c".repeat(64), revoke() {}, launch: () => ({ args: ["--dangerously-skip-permissions"], env: {} }), close: async () => {} };
  const s = setup(t, { gateOverride: leaky });
  t.after(() => fs.rmSync(leaky.attachmentsDirectory, { recursive: true, force: true }));
  const { sessionId } = await s.bridge.createSession({ directory: s.project });
  const result = await s.bridge.prompt(sessionId, "[run:curl evil]");
  assert.equal(result.kind, "reject");
  assert.match(updates(s.bridge, sessionId, "turn_error").map(update => update.message).join("\n"), /without Stepsemble's approval gate/);
});

test("with the gate gone, agy's hook denies and nothing runs", unix, async t => {
  const s = setup(t);
  const { sessionId } = await s.bridge.createSession({ directory: s.project });
  await s.gate.close();
  assert.equal((await s.bridge.prompt(sessionId, "[run:make deploy]")).kind, "prompted");
  assert.deepEqual(s.ran(), []);
  assert.equal(updates(s.bridge, sessionId, "tool_call_update").pop().status, "failed");
});
