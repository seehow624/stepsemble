"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { PassThrough } = require("node:stream");
const { EventEmitter } = require("node:events");
const {
  buildClaudeStructuredArgs,
  claudeSupportsBypass,
  normalizeClaudeEvent,
  createClaudeStructuredParser,
  createClaudeStructuredSession,
  gatewayModelOptions,
} = require("../server/claude-code-structured-adapter");

function childFixture() {
  const child = new EventEmitter();
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.killed = false;
  child.kill = () => { child.killed = true; child.emit("close", 0, null); };
  return child;
}

function observeControlWire(child, handler) {
  let buffered = "";
  child.stdin.on("data", chunk => {
    buffered += chunk.toString();
    const lines = buffered.split("\n");
    buffered = lines.pop() || "";
    for (const line of lines) {
      if (!line.trim()) continue;
      handler(JSON.parse(line));
    }
  });
}

test("Claude structured args are explicit, resumable, and never shell-expanded", () => {
  assert.deepEqual(buildClaudeStructuredArgs({ sessionId: "session-1" }), [
    "-p", "--output-format", "stream-json", "--input-format", "stream-json", "--verbose", "--include-partial-messages",
    "--permission-prompts", "host", "--resume", "session-1",
  ]);
  assert.deepEqual(buildClaudeStructuredArgs({ allowBypass: true }).slice(6, 9), [
    "--include-partial-messages", "--allow-dangerously-skip-permissions", "--permission-prompts",
  ]);
  // Bypass permissions can be chosen later, but the session never starts in it.
  assert.equal(buildClaudeStructuredArgs({ allowBypass: true }).includes("--dangerously-skip-permissions"), false);
  assert.equal(buildClaudeStructuredArgs({ allowBypass: true }).includes("--permission-mode"), false);
  assert.deepEqual(buildClaudeStructuredArgs({ permissionPromptTool: "mcp__stepsemble__permission" }).slice(-2), ["--permission-prompt-tool", "mcp__stepsemble__permission"]);
  assert.throws(() => buildClaudeStructuredArgs({ sessionId: "../../secret" }), /invalid_claude_session_id/);
  assert.throws(() => buildClaudeStructuredArgs({ permissionPromptTool: "tool;rm" }), /invalid_permission_prompt_tool/);
  assert.deepEqual(buildClaudeStructuredArgs({ settingsPath: "/tmp/stepsemble-claude-settings.json" }).slice(-2), ["--settings", "/tmp/stepsemble-claude-settings.json"]);
  assert.throws(() => buildClaudeStructuredArgs({ settingsPath: "relative.json" }), /invalid_claude_settings_path/);
});

test("Bypass permissions is offered only by a Claude CLI that lists the option", { skip: process.platform === "win32" }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "stepsemble-claude-help-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const cli = (name, help) => {
    const file = path.join(dir, name);
    fs.writeFileSync(file, "#!/bin/sh\necho '" + help + "'\n", { mode: 0o755 });
    return file;
  };
  assert.equal(await claudeSupportsBypass(cli("claude-current", "  --allow-dangerously-skip-permissions  Enable bypassing all permission checks")), true);
  assert.equal(await claudeSupportsBypass(cli("claude-older", "  --dangerously-skip-permissions  Bypass all permission checks")), false);
  assert.equal(await claudeSupportsBypass(path.join(dir, "missing")), false);
});

test("Claude permission modes are read from Claude, changed live and put back after a relaunch", async () => {
  const child = childFixture();
  const requests = [];
  observeControlWire(child, message => {
    if (message.type !== "control_request") return;
    requests.push(message.request);
    const reply = response => child.stdout.write(JSON.stringify({ type: "control_response", response }) + "\n");
    if (message.request.subtype === "initialize") reply({ subtype: "success", request_id: message.request_id, response: { current_permission_mode: "bypassPermissions" } });
    if (message.request.subtype !== "set_permission_mode") return;
    if (message.request.mode === "auto") {
      reply({ subtype: "error", request_id: message.request_id, error: "Cannot set permission mode to bypassPermissions because the session was not launched with --dangerously-skip-permissions" });
      return;
    }
    reply({ subtype: "success", request_id: message.request_id, response: { mode: message.request.mode } });
  });
  // A mode chosen before a restart is put back once Claude has initialized.
  const session = createClaudeStructuredSession({ command: "/usr/local/bin/claude", cwd: "/tmp", spawnImpl: () => child, requestTimeoutMs: 500, initialPermissionMode: "plan" });
  assert.deepEqual(await session.permissionState(), { permissionMode: "plan" });
  assert.deepEqual(requests.map(request => [request.subtype, request.mode || null]), [["initialize", null], ["set_permission_mode", "plan"], ["get_settings", null]]);
  assert.deepEqual(await session.setPermissionMode("acceptEdits"), { kind: "changed", permissionMode: "acceptEdits" });
  // The CLI flag calls the ask-first mode "manual"; the control request calls it "default".
  assert.deepEqual(await session.setPermissionMode("manual"), { kind: "changed", permissionMode: "default" });
  assert.equal(requests.at(-1).mode, "default");
  await assert.rejects(session.setPermissionMode("everything"), error => error.code === "claude_permission_mode_invalid");
  await assert.rejects(session.setPermissionMode("auto"), error => error.code === "claude_bypass_unavailable");
  assert.equal(session.status().permissionMode, "default");
  // Claude reports its own changes, such as leaving plan mode.
  child.stdout.write(JSON.stringify({ type: "system", subtype: "status", status: null, permissionMode: "plan", uuid: "u-1", session_id: "claude-mode-session" }) + "\n");
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(session.status().permissionMode, "plan");
  await session.close();
});

test("idle suspension protects turns, permissions, pending input and background tasks", async t => {
  const child = childFixture(), frames = [];
  observeControlWire(child, message => {
    frames.push(message);
    if (message.type === "control_request") child.stdout.write(JSON.stringify({ type: "control_response", response: {
      subtype: "success", request_id: message.request_id, response: {},
    } }) + "\n");
  });
  const session = createClaudeStructuredSession({ command: "/synthetic/claude", cwd: "/tmp", env: {}, sessionId: "saved-session", spawnImpl: () => child, requestTimeoutMs: 100 });
  t.after(() => session.close());
  assert.equal(session.isIdle(), false);
  await session.models();
  child.stdout.write(JSON.stringify({ type: "system", subtype: "task_started", task_id: "historical-background", isReplay: true }) + "\n");
  assert.equal(session.isIdle(), true);
  const send = session.send("one message");
  assert.equal((await session.suspend()).kind, "reject", "a prompt waiting on the initialized promise already owns the session");
  await send;
  assert.equal(session.isIdle(), false);
  const emit = event => child.stdout.write(JSON.stringify({ session_id: "saved-session", ...event }) + "\n");
  emit({ type: "control_request", request_id: "permission-a", request: { subtype: "can_use_tool", tool_name: "Bash", input: { command: "synthetic" } } });
  emit({ type: "result", subtype: "success", result: "done" });
  assert.equal(session.isIdle(), false);
  emit({ type: "control_cancel_request", request_id: "permission-a" });
  assert.equal(session.isIdle(), true);
  emit({ type: "system", subtype: "task_started", task_id: "background-a" });
  emit({ type: "system", subtype: "task_started", task_id: "background-b" });
  emit({ type: "result", subtype: "success", result: "parent is waiting" });
  assert.equal(session.isIdle(), false, "an idle parent can still own background work");
  assert.equal((await session.suspend()).code, "claude_session_busy");
  emit({ type: "system", subtype: "task_notification", task_id: "background-a", status: "completed" });
  assert.equal(session.isIdle(), false);
  emit({ type: "system", subtype: "task_updated", task_id: "background-b", patch: { status: "failed" } });
  assert.equal(session.isIdle(), true);
  assert.equal((await session.suspend()).cleanupConfirmed, true);
  assert.equal(frames.filter(frame => frame.type === "user").length, 1);
});

test("a turn Claude starts by itself, or its own compaction, keeps the session busy until its result", async t => {
  const child = childFixture();
  observeControlWire(child, message => {
    if (message.type === "control_request") child.stdout.write(JSON.stringify({ type: "control_response", response: {
      subtype: "success", request_id: message.request_id, response: {},
    } }) + "\n");
  });
  const session = createClaudeStructuredSession({ command: "/synthetic/claude", cwd: "/tmp", env: {}, sessionId: "saved-session", spawnImpl: () => child, requestTimeoutMs: 100 });
  t.after(() => session.close());
  await session.models();
  const emit = event => child.stdout.write(JSON.stringify({ session_id: "saved-session", ...event }) + "\n");
  const settle = () => new Promise(resolve => setImmediate(resolve));
  await session.send("after a restart");
  // A queued background-task notice is answered first; its turn ends at once.
  emit({ type: "system", subtype: "init" });
  emit({ type: "result", subtype: "success", result: "" });
  await settle();
  assert.equal(session.isIdle(), true);
  // Claude then starts the turn for the message it had queued.
  emit({ type: "system", subtype: "init" });
  emit({ type: "system", subtype: "status", status: "requesting" });
  await settle();
  assert.equal(session.status().state, "running");
  assert.equal(session.isIdle(), false, "no output yet, but Claude is working");
  emit({ type: "system", subtype: "status", status: "compacting" });
  emit({ type: "result", subtype: "success", result: "done" });
  await settle();
  assert.equal(session.isIdle(), true, "a result ends the compaction with the turn");
  // Claude compacting between turns keeps the process until its boundary.
  emit({ type: "system", subtype: "status", status: "compacting" });
  await settle();
  assert.equal(session.isIdle(), false);
  emit({ type: "system", subtype: "compact_boundary", compact_metadata: { trigger: "auto" } });
  await settle();
  assert.equal(session.isIdle(), true);
  assert.equal(session.status().state, "waiting");
});

test("a scheduled prompt or monitor keeps its Claude process, while one in replayed history does not", async t => {
  const child = childFixture();
  observeControlWire(child, message => {
    if (message.type === "control_request") child.stdout.write(JSON.stringify({ type: "control_response", response: {
      subtype: "success", request_id: message.request_id, response: {},
    } }) + "\n");
  });
  const session = createClaudeStructuredSession({ command: "/synthetic/claude", cwd: "/tmp", env: {}, sessionId: "saved-session", spawnImpl: () => child, requestTimeoutMs: 100 });
  t.after(() => session.close());
  await session.models();
  const emit = event => child.stdout.write(JSON.stringify({ session_id: "saved-session", ...event }) + "\n");
  const tool = name => ({ type: "assistant", message: { id: `assistant-${name}`, role: "assistant", content: [{ type: "tool_use", id: `toolu-${name}`, name, input: {} }] } });
  emit({ ...tool("CronCreate"), isReplay: true });
  emit({ type: "result", subtype: "success", result: "history" });
  assert.equal(session.isIdle(), true, "a schedule from before this process is not in it");
  emit(tool("Read"));
  emit({ type: "result", subtype: "success", result: "read" });
  assert.equal(session.isIdle(), true);
  emit(tool("ScheduleWakeup"));
  emit({ type: "result", subtype: "success", result: "scheduled" });
  assert.equal(session.isIdle(), false);
  assert.equal((await session.suspend()).code, "claude_session_busy");
});

test("Claude structured gateway sessions expose the refreshed OpenCodex catalog and settings merge", async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "stepsemble-claude-gateway-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const configDir = path.join(home, ".config", "stepsemble");
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, "claude-gateway-settings.json"), JSON.stringify({ modelPicker: { options: [{ model: "claude-ocx-test--glm", behavesAs: "claude-sonnet-5" }] } }));
  fs.writeFileSync(path.join(configDir, "claude-gateway-catalog.json"), JSON.stringify({ version: 1, baseUrl: "http://127.0.0.1:10100", models: [{
    id: "claude-ocx-test--glm", name: "GLM (OpenCodex)", description: "OpenCodex gateway", contextWindow: 1000000,
    supportsEffort: true, supportedEffortLevels: ["low", "high"],
  }] }));
  const child = childFixture();
  observeControlWire(child, message => {
    if (message.type !== "control_request" || message.request?.subtype !== "initialize") return;
    child.stdout.write(JSON.stringify({ type: "control_response", response: {
      subtype: "success", request_id: message.request_id, response: {
        models: [{ value: "claude-ocx-test--glm", displayName: "GLM (Claude initialize)" }],
        model: "claude-sonnet-5",
      },
    } }) + "\n");
  });
  let args;
  const session = createClaudeStructuredSession({ command: "/usr/local/bin/claude", cwd: "/tmp", env: { HOME: home, ANTHROPIC_BASE_URL: "http://127.0.0.1:10100" },
    spawnImpl: (file, argv, options) => { args = { file, argv, options }; return child; } });
  t.after(() => session.close());
  const catalog = await session.models();
  assert.equal(catalog.models.length, 1);
  assert.deepEqual(catalog.models[0], {
    id: "claude-ocx-test--glm", name: "GLM (OpenCodex)", description: "OpenCodex gateway", contextWindow: 1000000,
    supportsEffort: true, supportedEffortLevels: ["low", "high"], reasoning: true, gateway: "opencodex",
  });
  assert.deepEqual(args.argv.slice(-2), ["--settings", path.join(configDir, "claude-gateway-settings.json")]);
});

test("Claude gateway aliases keep the gateway's own effort levels", async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "stepsemble-claude-gateway-levels-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const configDir = path.join(home, ".config", "stepsemble");
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, "claude-gateway-catalog.json"), JSON.stringify({ version: 1, baseUrl: "http://127.0.0.1:10100", models: [
    { id: "claude-ocx-test--glm", name: "GLM", description: "OpenCodex gateway", contextWindow: 1000000, supportsEffort: true, supportedEffortLevels: ["low", "high", "max"] },
    { id: "claude-ocx-test--free", name: "Free", description: "OpenCodex gateway", contextWindow: null, supportsEffort: false, supportedEffortLevels: [] },
  ] }));
  const child = childFixture();
  observeControlWire(child, message => {
    if (message.type !== "control_request" || message.request?.subtype !== "initialize") return;
    child.stdout.write(JSON.stringify({ type: "control_response", response: {
      subtype: "success", request_id: message.request_id,
      response: {
        // An alias row inherits the capabilities of the base model it behaves
        // as, so every alias arrives with the full Claude range even when the
        // upstream provider offers fewer levels.
        models: [
          { value: "claude-ocx-test--glm", displayName: "GLM", supportsEffort: true, supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"] },
          { value: "claude-ocx-test--free", displayName: "Free", supportsEffort: true, supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"] },
          { value: "haiku", displayName: "Haiku" },
        ],
        model: "claude-sonnet-5",
      },
    } }) + "\n");
  });
  const session = createClaudeStructuredSession({ command: "/usr/local/bin/claude", cwd: "/tmp",
    env: { HOME: home, ANTHROPIC_BASE_URL: "http://127.0.0.1:10100" }, spawnImpl: () => child });
  t.after(() => session.close());
  const catalog = await session.models();
  const byId = new Map(catalog.models.map(row => [row.id, row]));
  assert.deepEqual(byId.get("claude-ocx-test--glm").supportedEffortLevels, ["low", "high", "max"]);
  assert.equal(byId.get("claude-ocx-test--glm").contextWindow, 1000000);
  assert.equal(byId.get("claude-ocx-test--glm").gateway, "opencodex");
  // An explicit gateway no-effort declaration must not inherit Claude's
  // base-model capabilities. Native vendor rows are unaffected.
  assert.deepEqual(byId.get("claude-ocx-test--free").supportedEffortLevels, []);
  assert.equal(byId.get("claude-ocx-test--free").supportsEffort, false);
  assert.equal(byId.get("haiku").supportsEffort, undefined);
  fs.writeFileSync(path.join(configDir, "claude-gateway-catalog.json"), JSON.stringify({ version: 1, baseUrl: "http://127.0.0.1:10100", models: [
    { id: "claude-ocx-test--new", name: "New upstream model", supportedEffortLevels: ["low"] },
  ] }));
  const refreshed = await session.models();
  assert.deepEqual(refreshed.models.map(model => model.id), ["haiku", "claude-ocx-test--new"]);
  assert.equal(refreshed.currentModel, catalog.currentModel, "catalog reload never changes the selected model");
  fs.writeFileSync(path.join(configDir, "claude-gateway-catalog.json"), JSON.stringify({ version: 1, baseUrl: "http://127.0.0.1:10100", models: [] }));
  assert.deepEqual((await session.models()).models.map(model => model.id), ["haiku"]);
});

test("Claude accepts current and persisted OpenCodex aliases, switches exact IDs and removes retired aliases", async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "stepsemble-claude-gateway-aliases-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const baseUrl = "http://127.0.0.1:10100";
  const env = { HOME: home, ANTHROPIC_BASE_URL: baseUrl };
  const dir = path.join(home, ".config", "stepsemble");
  fs.mkdirSync(dir, { recursive: true });
  const ids = ["ocx-claude-native--gpt-6.1-sol", "ocx-claude2-openrouter--anthropic~sclaude-test~ts",
    "claude-ocx-minimax--MiniMax-M3", "claude-ocx2-openrouter--anthropic~sclaude-test~ts"];
  const file = path.join(dir, "claude-gateway-catalog.json");
  const write = models => fs.writeFileSync(file, JSON.stringify({ baseUrl, models }));
  write(ids.map(id => ({ id, name: id, contextWindow: 1000000, supportedEffortLevels: ["low", "high"] })));
  const child = childFixture(), switches = [];
  observeControlWire(child, message => {
    if (message.type !== "control_request") return;
    const request = message.request;
    if (request.subtype === "set_model") switches.push(request.model);
    const response = request.subtype === "initialize"
      ? { model: "haiku", models: [{ value: "haiku" }, ...ids.map(value => ({ value })), { value: "ocx-claude-native--retired" }] }
      : request.subtype === "set_model" ? { model: request.model } : {};
    child.stdout.write(JSON.stringify({ type: "control_response", response: { subtype: "success", request_id: message.request_id, response } }) + "\n");
  });
  const session = createClaudeStructuredSession({ command: "/usr/local/bin/claude", cwd: home, env, spawnImpl: () => child });
  t.after(() => session.close());
  const catalog = await session.models();
  assert.deepEqual(catalog.models.map(row => row.id), ["haiku", ...ids]);
  for (const id of ids) {
    assert.deepEqual(catalog.models.find(row => row.id === id).supportedEffortLevels, ["low", "high"]);
    assert.equal((await session.setModel(id)).model, id);
  }
  assert.deepEqual(switches, ids, "aliases reach Claude unchanged");
  write([]);
  assert.deepEqual((await session.models()).models.map(row => row.id), ["haiku"]);
  fs.rmSync(file);
  fs.mkdirSync(path.join(home, ".claude", "cache"), { recursive: true });
  fs.writeFileSync(path.join(home, ".claude", "cache", "gateway-models.json"), JSON.stringify({ baseUrl, models: ids.map(id => ({ id })) }));
  assert.deepEqual(gatewayModelOptions(env).map(row => row.id), ids, "older public caches retain both alias generations");
});

test("Claude structured parser locks the native session and preserves subagent correlation", () => {
  const events = [];
  const parser = createClaudeStructuredParser({ onEvent: event => events.push(event) });
  parser.push(JSON.stringify({ type: "system", session_id: "session-1", uuid: "event-1" }) + "\n");
  parser.push(JSON.stringify({ type: "stream_event", session_id: "session-1", parent_tool_use_id: "tool-1", delta: "hello" }) + "\n");
  assert.equal(parser.status().sessionId, "session-1");
  assert.equal(events[1].parentToolUseId, "tool-1");
  assert.equal(parser.text(), "hello");
  parser.push(JSON.stringify({ type: "result", session_id: "other", result: "bad" }) + "\n");
  assert.equal(parser.status().failed, "claude_session_mismatch");
});

test("Claude structured parser validates native control requests", () => {
  const events = [];
  const parser = createClaudeStructuredParser({ onEvent: event => events.push(event) });
  parser.push(JSON.stringify({ type: "control_request", request_id: "perm-1", request: {
    subtype: "can_use_tool", tool_name: "Bash", input: { command: "pwd" }, description: "Run pwd",
  } }) + "\n");
  assert.equal(events[0].requestId, "perm-1");
  assert.equal(events[0].request.subtype, "can_use_tool");
  parser.push(JSON.stringify({ type: "control_request", request: { subtype: "can_use_tool" } }) + "\n");
  assert.equal(parser.status().failed, "structured_event_invalid");
});

test("Claude structured session writes native permission responses and interrupts without closing", async t => {
  const child = childFixture();
  observeControlWire(child, message => {
    if (message.type !== "control_request" || message.request?.subtype !== "initialize") return;
    child.stdout.write(JSON.stringify({ type: "control_response", response: {
      subtype: "success", request_id: message.request_id, response: { models: [], model: "sonnet" },
    } }) + "\n");
  });
  let args;
  const session = createClaudeStructuredSession({ command: "/usr/local/bin/claude", cwd: "/tmp", name: "Named Claude task", spawnImpl: (file, argv, options) => { args = { file, argv, options }; return child; } });
  t.after(() => session.close());
  assert.equal(args.file, "/usr/local/bin/claude");
  assert.equal(session.name, "Named Claude task");
  assert.equal(args.argv.includes("--input-format"), true);
  const chunks = [];
  child.stdin.on("data", chunk => chunks.push(chunk.toString()));
  const sent = await session.send("hello");
  assert.equal(sent.kind, "sent");
  assert.match(chunks.join(""), /"type":"user"/);
  assert.equal(session.acknowledgePermission("missing", "allow").code, "claude_permission_unavailable");
  child.stdout.write(JSON.stringify({ type: "control_request", request_id: "perm-1", request: {
    subtype: "can_use_tool", tool_name: "Bash", input: { command: "pwd" }, description: "Run pwd",
  } }) + "\n");
  assert.equal(session.pendingPermissions()[0].approvalProtocol, "control");
  const allowed = await session.acknowledgePermission("perm-1", "allow");
  assert.deepEqual(allowed, { kind: "written", requestId: "perm-1", decision: "allow" });
  const lines = chunks.join("").trim().split("\n").map(line => JSON.parse(line));
  const response = lines.find(line => line.type === "control_response");
  assert.deepEqual(response, { type: "control_response", response: {
    subtype: "success", request_id: "perm-1", response: { behavior: "allow", updatedInput: { command: "pwd" } },
  } });
  assert.equal((await session.acknowledgePermission("perm-1", "deny")).code, "claude_permission_already_responded");
  child.stdout.write(JSON.stringify({ type: "control_response", response: { subtype: "success", request_id: "perm-1", response: { behavior: "allow" } } }) + "\n");
  assert.equal(session.pendingPermissions().length, 0);
  const interrupted = await session.interrupt();
  assert.equal(interrupted.kind, "sent");
  const interruptRequest = chunks.join("").trim().split("\n").map(line => JSON.parse(line)).find(line => line.type === "control_request" && line.request?.subtype === "interrupt");
  assert.equal(interruptRequest.request.subtype, "interrupt");
  const multiline = await session.send("line one\nline two");
  assert.equal(multiline.kind, "sent");
  child.stdout.write(JSON.stringify({ type: "result", session_id: "session-2", result: "done" }) + "\n");
  assert.equal(session.status().nativeSessionId, "session-2");
  assert.equal((await session.close()).cleanupConfirmed, true);
});

test("Claude structured controls use exact initialize/set_model wire and update only after ACK", async t => {
  const child = childFixture();
  const requests = [];
  let respond = null;
  observeControlWire(child, message => {
    if (message.type !== "control_request") return;
    requests.push(message);
    respond?.(message);
  });
  const session = createClaudeStructuredSession({ command: "/usr/local/bin/claude", cwd: "/tmp", spawnImpl: () => child, requestTimeoutMs: 200 });
  t.after(() => session.close());
  respond = message => {
    if (message.request.subtype !== "initialize") return;
    child.stdout.write(JSON.stringify({ type: "control_response", response: {
      subtype: "success", request_id: message.request_id,
      response: { models: [
        { value: "sonnet", displayName: "Claude Sonnet", description: "Balanced", supportsEffort: true },
        { value: "opus", displayName: "Claude Opus", description: "Deep" },
      ], model: "sonnet" },
    } }) + "\n");
  };
  const catalog = await session.models();
  assert.deepEqual(catalog, { models: [
    { id: "sonnet", name: "Claude Sonnet", description: "Balanced", supportsEffort: true },
    { id: "opus", name: "Claude Opus", description: "Deep" },
  ], currentModel: "sonnet", currentEffort: null });
  assert.deepEqual(requests[0], { type: "control_request", request_id: requests[0].request_id, request: { subtype: "initialize" } });

  let resolveModelRequest;
  respond = message => { if (message.request.subtype === "set_model") resolveModelRequest = message; };
  const changing = session.setModel("opus");
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(resolveModelRequest.request.subtype, "set_model");
  assert.equal(resolveModelRequest.request.model, "opus");
  assert.equal(session.contextUsage().model, "sonnet", "selected model stays old until native ACK");
  child.stdout.write(JSON.stringify({ type: "control_response", response: {
    subtype: "success", request_id: resolveModelRequest.request_id, response: {},
  } }) + "\n");
  assert.deepEqual(await changing, { kind: "changed", model: "opus", effort: null });
  assert.equal(session.contextUsage().model, "opus");
});

test("Claude effort changes through flag settings and never resets the model", async t => {
  const child = childFixture();
  const requests = [];
  observeControlWire(child, message => {
    if (message.type !== "control_request") return;
    requests.push(message);
    if (message.request?.subtype === "initialize") {
      child.stdout.write(JSON.stringify({ type: "control_response", response: {
        subtype: "success", request_id: message.request_id,
        response: { models: [{ value: "sonnet", displayName: "Sonnet", supportsEffort: true, supportedEffortLevels: ["low", "high"] }], model: "sonnet", effort: "low" },
      } }) + "\n");
    }
  });
  const session = createClaudeStructuredSession({ command: "/usr/local/bin/claude", cwd: "/tmp", spawnImpl: () => child, requestTimeoutMs: 200 });
  t.after(() => session.close());
  await session.models();
  let effortRequest;
  // Add a second observer after initialization so the ACK can be controlled
  // without changing the initialize fixture above.
  child.stdin.on("data", chunk => {
    for (const raw of chunk.toString().split("\n").filter(Boolean)) {
      const message = JSON.parse(raw);
      if (message.type === "control_request" && message.request?.subtype === "apply_flag_settings") effortRequest = message;
    }
  });
  const changing = session.setEffort("high");
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(effortRequest?.request, { subtype: "apply_flag_settings", settings: { effortLevel: "high" } });
  // Claude Code reads only the model from set_model, and one without a
  // model switches to the default model.
  assert.equal(requests.some(message => message.request?.subtype === "set_model"), false);
  child.stdout.write(JSON.stringify({ type: "control_response", response: {
    subtype: "success", request_id: effortRequest.request_id,
  } }) + "\n");
  assert.deepEqual(await changing, { kind: "changed", effort: "high" });
  assert.equal(session.status().effort, "high");
  assert.equal(session.status().model, "sonnet");

  // Default effort clears the flag so Claude's own default applies again.
  const clearing = session.setEffort("auto");
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(effortRequest.request, { subtype: "apply_flag_settings", settings: { effortLevel: null } });
  child.stdout.write(JSON.stringify({ type: "control_response", response: { subtype: "success", request_id: effortRequest.request_id } }) + "\n");
  assert.deepEqual(await clearing, { kind: "changed", effort: "auto" });
});

test("Claude without flag settings gets the effort with its current model", async t => {
  const child = childFixture();
  const requests = [];
  observeControlWire(child, message => {
    if (message.type !== "control_request") return;
    requests.push(message.request);
    const subtype = message.request?.subtype;
    const respond = (body, ok = true) => child.stdout.write(JSON.stringify({ type: "control_response", response: ok
      ? { subtype: "success", request_id: message.request_id, response: body }
      : { subtype: "error", request_id: message.request_id, error: "Unsupported control request subtype: " + subtype } }) + "\n");
    if (subtype === "initialize") respond({ models: [{ value: "sonnet" }, { value: "opus" }] });
    else if (subtype === "apply_flag_settings") respond(null, false);
    else respond({});
  });
  const session = createClaudeStructuredSession({ command: "/usr/local/bin/claude", cwd: "/tmp", spawnImpl: () => child, requestTimeoutMs: 200 });
  t.after(() => session.close());
  await session.models();
  // With no known model, a set_model would switch to the default model.
  await assert.rejects(session.setEffort("high"), error => error.code === "claude_control_rejected");
  assert.equal(requests.some(request => request.subtype === "set_model"), false);

  await session.setModel("opus");
  requests.length = 0;
  assert.deepEqual(await session.setEffort("high"), { kind: "changed", effort: "high" });
  assert.deepEqual(requests, [
    { subtype: "apply_flag_settings", settings: { effortLevel: "high" } },
    { subtype: "set_model", model: "opus", effort: "high" },
  ]);
  assert.equal(session.status().model, "opus");
});

test("Claude context usage uses latest assistant input plus cache tokens and modelUsage capacity", async t => {
  const child = childFixture();
  observeControlWire(child, message => {
    if (message.type !== "control_request" || message.request.subtype !== "initialize") return;
    child.stdout.write(JSON.stringify({ type: "control_response", response: {
      subtype: "success", request_id: message.request_id, response: { models: [], model: "sonnet" },
    } }) + "\n");
  });
  const session = createClaudeStructuredSession({ command: "/usr/local/bin/claude", cwd: "/tmp", spawnImpl: () => child, requestTimeoutMs: 200 });
  t.after(() => session.close());
  await session.models();
  child.stdout.write(JSON.stringify({ type: "assistant", session_id: "session-1", message: {
    model: "sonnet", usage: {
      input_tokens: 120, output_tokens: 45, cache_read_input_tokens: 300, cache_creation_input_tokens: 15,
    }, content: [{ type: "text", text: "done" }],
  } }) + "\n");
  child.stdout.write(JSON.stringify({ type: "result", session_id: "session-1", modelUsage: {
    sonnet: { inputTokens: 120, outputTokens: 45, cacheReadInputTokens: 300, cacheCreationInputTokens: 15, contextWindow: 200000 },
  }, result: "done" }) + "\n");
  assert.deepEqual(session.contextUsage(), {
    model: "sonnet", contextWindow: 200000, contextTokens: 435, contextPercent: 0.2175,
    usage: { totalTokens: 480, inputTokens: 120, outputTokens: 45, cachedInputTokens: 300, cacheWriteInputTokens: 15 },
  });
  child.stdout.write(JSON.stringify({ type: "result", session_id: "session-1", modelUsage: {
    sonnet: { inputTokens: 999, contextWindow: 0 },
  }, result: "unknown capacity" }) + "\n");
  // A later cumulative result cannot overwrite the latest assistant context;
  // an advertised non-positive limit remains unknown rather than zero.
  assert.equal(session.contextUsage().contextTokens, 435);
  assert.equal(session.contextUsage().contextWindow, 200000);
});

test("Claude control correlation is bounded and timeout failures clean up", async t => {
  const child = childFixture();
  let firstRequest = null;
  observeControlWire(child, message => { if (!firstRequest && message.type === "control_request") firstRequest = message; });
  const session = createClaudeStructuredSession({ command: "/usr/local/bin/claude", cwd: "/tmp", spawnImpl: () => child, requestTimeoutMs: 10 });
  t.after(() => session.close());
  const pending = session.models();
  await new Promise(resolve => setTimeout(resolve, 2));
  assert.ok(firstRequest);
  child.stdout.write(JSON.stringify({ type: "control_response", response: {
    subtype: "success", request_id: "stepsemble-ctrl-unknown", response: { models: [] },
  } }) + "\n");
  await assert.rejects(pending, error => error && error.code === "claude_control_timeout");
  assert.equal(session.status().state, "failed");
  await session.close();
});

test("Claude close rejects pending initialize without misclassifying normal cleanup", async t => {
  const child = childFixture();
  const session = createClaudeStructuredSession({ command: "/usr/local/bin/claude", cwd: "/tmp", spawnImpl: () => child, requestTimeoutMs: 200 });
  const pending = session.models();
  const closed = await session.close();
  assert.equal(closed.cleanupConfirmed, true);
  await assert.rejects(pending, error => error && error.code === "claude_session_closed");
  assert.equal(session.status().state, "closed");
  assert.equal(session.status().failed, null);
  t.after(() => session.close());
});

test("Claude keeps an image prompt inside its budget and writes it whole", async t => {
  const child = childFixture();
  let userFrame = null;
  observeControlWire(child, message => {
    if (message.type === "user") { userFrame = message; return; }
    if (message.type !== "control_request" || message.request.subtype !== "initialize") return;
    child.stdout.write(JSON.stringify({ type: "control_response", response: {
      subtype: "success", request_id: message.request_id, response: { models: [], model: "sonnet" },
    } }) + "\n");
  });
  const session = createClaudeStructuredSession({ command: "/usr/local/bin/claude", cwd: "/tmp", spawnImpl: () => child, requestTimeoutMs: 5000 });
  t.after(() => session.close());
  await session.models();
  const image = "A".repeat(7 * 1024 * 1024);
  const result = await session.send("", { images: Array.from({ length: 5 }, () => ({ data: image, mimeType: "image/png" })) });
  assert.equal(result.kind, "sent");
  for (let attempt = 0; attempt < 50 && !userFrame; attempt += 1) await new Promise(resolve => setTimeout(resolve, 20));
  // Five 7 MiB images exceed the 24 MiB prompt budget: the first three are
  // written in one frame instead of the prompt being refused or cut mid-frame.
  assert.equal(userFrame?.message?.content?.length, 3);
  assert.ok(userFrame.message.content.every(block => block.type === "image" && block.source.data.length === image.length));
});

test("a queued message is a user frame that names itself, comes from a person and joins the turn at its next step", async t => {
  const child = childFixture();
  const frames = [], events = [];
  observeControlWire(child, message => {
    if (message.type === "user") { frames.push(message); return; }
    if (message.type !== "control_request" || message.request.subtype !== "initialize") return;
    child.stdout.write(JSON.stringify({ type: "control_response", response: { subtype: "success", request_id: message.request_id, response: { models: [], model: "sonnet" } } }) + "\n");
  });
  const session = createClaudeStructuredSession({ command: "/usr/local/bin/claude", cwd: "/tmp", spawnImpl: () => child, requestTimeoutMs: 5000,
    onRateEvent: event => events.push(event) });
  t.after(() => session.close());
  const uuid = "11111111-2222-4333-8444-555555555555";
  assert.equal((await session.send("also check the docs", { uuid, priority: "next", origin: { kind: "human" } })).kind, "sent");
  // An ordinary send stays exactly as before.
  assert.equal((await session.send("plain")).kind, "sent");
  for (let attempt = 0; attempt < 50 && frames.length < 2; attempt += 1) await new Promise(resolve => setTimeout(resolve, 20));
  assert.deepEqual(frames[0], { type: "user", message: { role: "user", content: [{ type: "text", text: "also check the docs" }] }, uuid, priority: "next", origin: { kind: "human" } });
  assert.deepEqual(frames[1], { type: "user", message: { role: "user", content: [{ type: "text", text: "plain" }] } });
  for (const options of [{ uuid: "../bad" }, { priority: "soon" }, { origin: { kind: "peer" } }]) assert.equal((await session.send("x", options)).code, "claude_prompt_invalid");
  // Claude reports the message's fate under its uuid; the Host passes it on.
  child.stdout.write(JSON.stringify({ type: "command_lifecycle", command_uuid: uuid, state: "queued", uuid: "aaaaaaaa-2222-4333-8444-555555555555", session_id: "native-1" }) + "\n");
  for (let attempt = 0; attempt < 50 && !events.some(event => event.type === "command_lifecycle"); attempt += 1) await new Promise(resolve => setTimeout(resolve, 10));
  const lifecycle = events.find(event => event.type === "command_lifecycle");
  assert.equal(lifecycle.command_uuid, uuid); assert.equal(lifecycle.state, "queued");
});

test("Claude rejects a prompt when the outbound queue is already full", async t => {
  const child = childFixture();
  Object.defineProperty(child.stdin, "writableLength", { configurable: true, value: 32 * 1024 * 1024 });
  const session = createClaudeStructuredSession({ command: "/usr/local/bin/claude", cwd: "/tmp", spawnImpl: () => child });
  t.after(() => session.close());
  const result = await session.send("small prompt");
  assert.deepEqual(result, { kind: "reject", code: "claude_input_queue_full" });
  assert.equal(session.status().state, "waiting");
});

test("Claude model switching is refused while a prompt is active", async t => {
  const child = childFixture();
  observeControlWire(child, message => {
    if (message.type !== "control_request" || message.request.subtype !== "initialize") return;
    child.stdout.write(JSON.stringify({ type: "control_response", response: {
      subtype: "success", request_id: message.request_id, response: { models: [], model: "sonnet" },
    } }) + "\n");
  });
  const session = createClaudeStructuredSession({ command: "/usr/local/bin/claude", cwd: "/tmp", spawnImpl: () => child, requestTimeoutMs: 200 });
  t.after(() => session.close());
  await session.models();
  assert.equal((await session.send("active prompt")).kind, "sent");
  await assert.rejects(session.setModel("opus"), error => error && error.code === "claude_model_switch_active");
});

test("Claude's 1M context model keeps its capacity although assistant messages name the bare model", async t => {
  // Shapes from a real Claude Code 2.1.281 run with Opus (1M context).
  const child = childFixture();
  const session = createClaudeStructuredSession({ command: "/usr/local/bin/claude", cwd: "/tmp", spawnImpl: () => child });
  t.after(() => session.close());
  child.stdout.write(JSON.stringify({ type: "system", subtype: "init", session_id: "session-1", model: "claude-opus-5-5[1m]" }) + "\n");
  const assistant = input => JSON.stringify({ type: "assistant", session_id: "session-1", message: {
    model: "claude-opus-5-5", usage: { input_tokens: 2, output_tokens: 3, cache_read_input_tokens: 0, cache_creation_input_tokens: input },
    content: [{ type: "text", text: "hi" }] } }) + "\n";
  child.stdout.write(assistant(158826));
  child.stdout.write(JSON.stringify({ type: "result", session_id: "session-1", modelUsage: {
    "claude-opus-5-5[1m]": { inputTokens: 2, outputTokens: 81, cacheCreationInputTokens: 158826, contextWindow: 1000000, canonicalModel: "claude-opus-5-5" },
  }, result: "hi" }) + "\n");
  await new Promise(resolve => setImmediate(resolve));
  let usage = session.contextUsage();
  assert.equal(usage.model, "claude-opus-5-5[1m]", "the full name from init is kept");
  assert.equal(usage.contextWindow, 1000000);
  assert.equal(usage.contextTokens, 158828);
  // The next turn's first usage keeps the capacity of the same model.
  child.stdout.write(assistant(160000));
  await new Promise(resolve => setImmediate(resolve));
  usage = session.contextUsage();
  assert.equal(usage.contextWindow, 1000000);
  assert.equal(usage.contextPercent, 16.0002);
});

test("Claude result modelUsage exposes capacity only until assistant usage arrives", async t => {
  const child = childFixture();
  const session = createClaudeStructuredSession({ command: "/usr/local/bin/claude", cwd: "/tmp", spawnImpl: () => child });
  t.after(() => session.close());
  child.stdout.write(JSON.stringify({ type: "result", session_id: "session-1", modelUsage: {
    sonnet: { inputTokens: 900, outputTokens: 100, cacheReadInputTokens: 400, contextWindow: 100000 },
  }, result: "done" }) + "\n");
  assert.deepEqual(session.contextUsage(), {
    model: "sonnet", contextWindow: 100000, contextTokens: null, contextPercent: null, usage: null,
  });
});

test("Claude result errors end the turn with the error and keep the session usable", async t => {
  const child = childFixture();
  const session = createClaudeStructuredSession({ command: "/usr/local/bin/claude", cwd: "/tmp", spawnImpl: () => child });
  t.after(() => session.close());
  child.stdout.write(JSON.stringify({ type: "result", session_id: "session-1", subtype: "error_during_execution", is_error: true,
    errors: ["Authentication failed: signed out"], modelUsage: {}, result: "" }) + "\n");
  const status = session.status();
  // Claude takes the next message as usual, for example after /login.
  assert.equal(status.state, "waiting");
  assert.equal(status.failed, null);
  assert.equal(status.turnError.code, "claude_error_during_execution");
  assert.equal(status.turnError.message, "Authentication failed: signed out");
  assert.deepEqual(status.result.errors, ["Authentication failed: signed out"]);
});

test("Claude treats the turn Stop ended as ended, not as an error", async t => {
  const child = childFixture();
  const writes = [];
  observeControlWire(child, message => writes.push(message));
  const rates = [];
  const session = createClaudeStructuredSession({ command: "/usr/local/bin/claude", cwd: "/tmp", spawnImpl: () => child, onRateEvent: event => rates.push(event) });
  t.after(() => session.close());
  const sent = await session.interrupt();
  assert.equal(sent.kind, "sent");
  await new Promise(resolve => setImmediate(resolve));
  const request = writes.find(message => message.request?.subtype === "interrupt");
  // Claude 2.1.281 answers the interrupt, then ends the turn with an error.
  child.stdout.write(JSON.stringify({ type: "control_response", response: { subtype: "success", request_id: request.request_id, response: { still_queued: [] } } }) + "\n");
  child.stdout.write(JSON.stringify({ type: "user", session_id: "session-1", message: { role: "user", content: [{ type: "text", text: "[Request interrupted by user]" }] } }) + "\n");
  child.stdout.write(JSON.stringify({ type: "result", session_id: "session-1", subtype: "error_during_execution", is_error: true,
    terminal_reason: "aborted_streaming", errors: ["[ede_diagnostic] result_type=user"], modelUsage: {}, result: "" }) + "\n");
  const status = session.status();
  assert.equal(status.state, "waiting");
  assert.equal(status.failed, null);
  assert.equal(status.turnError, null);
  // Stopped by another client too: the terminal reason alone says so.
  child.stdout.write(JSON.stringify({ type: "result", session_id: "session-1", subtype: "error_during_execution", is_error: true,
    terminal_reason: "aborted_tools", modelUsage: {}, result: "" }) + "\n");
  assert.equal(session.status().turnError, null);
  assert.ok(rates.some(event => event.type === "rate.turn.ended" && event.result?.stopReason === "cancelled"));
  assert.equal(rates.filter(event => event.type === "result" && event.interrupted === true).length, 2);
});

test("Claude reports when each turn started and ended, apart from when its process started", async t => {
  const child = childFixture();
  const session = createClaudeStructuredSession({ command: "/usr/local/bin/claude", cwd: "/tmp", spawnImpl: () => child });
  t.after(() => session.close());
  const pause = () => new Promise(resolve => setTimeout(resolve, 25));
  const say = (id, text) => child.stdout.write(JSON.stringify({ type: "assistant", session_id: "session-1",
    message: { id, role: "assistant", model: "claude-sonnet-5", content: [{ type: "text", text }] } }) + "\n");
  const end = () => child.stdout.write(JSON.stringify({ type: "result", session_id: "session-1", subtype: "success", is_error: false, modelUsage: {}, result: "" }) + "\n");
  const opened = session.status();
  assert.deepEqual([opened.turnStartedAt, opened.turnEndedAt], [null, null]);
  await pause();
  say("m1", "first");
  const first = session.status();
  assert.equal(first.state, "running");
  assert(first.turnStartedAt >= opened.startedAt + 20, "the turn starts when Claude answers, not when its process started");
  await pause();
  say("m2", "still the first turn");
  assert.equal(session.status().turnStartedAt, first.turnStartedAt);
  end();
  const done = session.status();
  assert.equal(done.state, "waiting");
  assert(done.turnEndedAt >= first.turnStartedAt + 20);
  await pause();
  say("m3", "second");
  const second = session.status();
  assert(second.turnStartedAt >= done.turnEndedAt + 20, "a new turn starts its own clock");
  assert.equal(second.turnEndedAt, null);
  assert.equal(second.startedAt, opened.startedAt);
});

test("Claude parser failures carry a status code through the live session", async t => {
  const child = childFixture();
  const session = createClaudeStructuredSession({ command: "/usr/local/bin/claude", cwd: "/tmp", spawnImpl: () => child });
  t.after(() => session.close());
  child.stdout.write(JSON.stringify({ type: "control_response", response: { subtype: "success" } }) + "\n");
  assert.equal(session.status().state, "failed");
  assert.equal(session.status().failed, "structured_event_invalid");
});

// Claude 2.1.281 lists "default" beside the model it stands for, and names
// neither the model nor the level in its initialize reply.
function claude2181(child, { applied = { model: "claude-opus-5-5[1m]", effort: "medium" }, effective = {} } = {}) {
  const requests = [];
  observeControlWire(child, message => {
    if (message.type !== "control_request") return;
    requests.push(message.request);
    const reply = response => child.stdout.write(JSON.stringify({ type: "control_response", response: { subtype: "success", request_id: message.request_id, response } }) + "\n");
    const subtype = message.request.subtype;
    if (subtype === "initialize") reply({ models: [
      { value: "default", resolvedModel: "claude-opus-5-5[1m]", displayName: "Default (recommended)", supportsEffort: true, supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"] },
      { value: "opus[1m]", resolvedModel: "claude-opus-5-5[1m]", displayName: "Opus (1M context)", supportsEffort: true, supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"] },
      { value: "sonnet", resolvedModel: "claude-sonnet-5", displayName: "Sonnet", supportsEffort: true, supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"] },
      { value: "haiku", resolvedModel: "claude-haiku-4-5-20251001", displayName: "Haiku" },
    ] });
    else if (subtype === "set_model") { applied = { ...applied, model: message.request.model === "sonnet" ? "claude-sonnet-5" : message.request.model }; reply({}); }
    else if (subtype === "apply_flag_settings") { applied = { ...applied, effort: message.request.settings.effortLevel || "high" }; reply({}); }
    else if (subtype === "get_settings") reply({ applied, effective });
  });
  return requests;
}

test("Claude reopens with the bare model name its transcript records", async t => {
  // Claude's transcript names Opus with 1M context "claude-opus-5-5".
  const child = childFixture();
  const requests = claude2181(child);
  const session = createClaudeStructuredSession({ command: "/usr/local/bin/claude", cwd: "/tmp", spawnImpl: () => child, requestTimeoutMs: 500,
    initialModel: "claude-opus-5-5" });
  t.after(() => session.close());
  assert.equal((await session.models()).currentModel, "opus[1m]");
  assert.equal(requests.find(request => request.subtype === "set_model").model, "opus[1m]");
});

test("Claude runs at the level its own settings name when none was picked in Stepsemble", async t => {
  // Claude 2.1.281 run with stream-json answers at Medium even though its
  // settings say xhigh; get_settings shows both.
  const child = childFixture();
  const requests = claude2181(child, { effective: { model: "opus[1m]", effortLevel: "xhigh" } });
  const session = createClaudeStructuredSession({ command: "/usr/local/bin/claude", cwd: "/tmp", spawnImpl: () => child, requestTimeoutMs: 500 });
  t.after(() => session.close());
  const catalog = await session.models();
  assert.equal(catalog.currentEffort, "xhigh");
  assert.deepEqual(requests.map(request => request.subtype), ["initialize", "get_settings", "apply_flag_settings"]);
  assert.deepEqual(requests[2].settings, { effortLevel: "xhigh" });

  // A level picked in Stepsemble wins over Claude's settings.
  const picked = childFixture();
  const pickedRequests = claude2181(picked, { effective: { effortLevel: "xhigh" } });
  const chosen = createClaudeStructuredSession({ command: "/usr/local/bin/claude", cwd: "/tmp", spawnImpl: () => picked, requestTimeoutMs: 500, initialEffort: "max" });
  t.after(() => chosen.close());
  assert.equal((await chosen.models()).currentEffort, "max");
  assert.deepEqual(pickedRequests.filter(request => request.subtype === "apply_flag_settings").map(request => request.settings.effortLevel), ["max"]);
});

test("Claude lists each model once and reports the model and level it really runs with", async t => {
  const child = childFixture();
  claude2181(child);
  const session = createClaudeStructuredSession({ command: "/usr/local/bin/claude", cwd: "/tmp", spawnImpl: () => child, requestTimeoutMs: 500 });
  t.after(() => session.close());
  const catalog = await session.models();
  assert.deepEqual(catalog.models.map(model => model.id), ["opus[1m]", "sonnet", "haiku"]);
  assert.equal(catalog.currentModel, "opus[1m]");
  assert.equal(catalog.currentEffort, "medium");
  // Switching reads the level Claude runs with for the new model.
  assert.deepEqual(await session.setModel("sonnet"), { kind: "changed", model: "sonnet", effort: "medium" });
});

test("Claude starts with the model and level chosen last", async t => {
  const child = childFixture();
  const requests = claude2181(child);
  const session = createClaudeStructuredSession({ command: "/usr/local/bin/claude", cwd: "/tmp", spawnImpl: () => child, requestTimeoutMs: 500,
    initialModel: "sonnet", initialEffort: "max" });
  t.after(() => session.close());
  const catalog = await session.models();
  assert.equal(catalog.currentModel, "sonnet");
  assert.equal(catalog.currentEffort, "max");
  assert.deepEqual(requests.map(request => request.subtype), ["initialize", "set_model", "apply_flag_settings", "get_settings"]);
  assert.equal(requests[1].model, "sonnet");
  assert.deepEqual(requests[2].settings, { effortLevel: "max" });
});

test("Claude skips a remembered model it no longer offers and a level the model lacks", async t => {
  const child = childFixture();
  const requests = claude2181(child);
  const session = createClaudeStructuredSession({ command: "/usr/local/bin/claude", cwd: "/tmp", spawnImpl: () => child, requestTimeoutMs: 500,
    initialModel: "claude-ocx-gone", initialEffort: "max" });
  t.after(() => session.close());
  const catalog = await session.models();
  assert.equal(catalog.currentModel, "opus[1m]");
  assert.equal(catalog.currentEffort, "max");
  assert.equal(requests.some(request => request.subtype === "set_model"), false);

  const haikuChild = childFixture();
  const haikuRequests = claude2181(haikuChild, { applied: { model: "claude-haiku-4-5-20251001", effort: null } });
  const haiku = createClaudeStructuredSession({ command: "/usr/local/bin/claude", cwd: "/tmp", spawnImpl: () => haikuChild, requestTimeoutMs: 500,
    initialModel: "haiku", initialEffort: "max" });
  t.after(() => haiku.close());
  const haikuCatalog = await haiku.models();
  assert.equal(haikuCatalog.currentModel, "haiku");
  assert.equal(haikuCatalog.currentEffort, null);
  assert.equal(haikuRequests.some(request => request.subtype === "apply_flag_settings"), false);
});


// A process that ignores the polite request and exits only when forced.
function stubbornChild() {
  const child = new EventEmitter();
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.signals = [];
  child.kill = signal => {
    child.signals.push(signal || "SIGTERM");
    if (signal === "SIGKILL") child.emit("close", null, "SIGKILL");
  };
  return child;
}

test("a failed Claude session ends its process, so it stops counting as work", async () => {
  const child = stubbornChild();
  const session = createClaudeStructuredSession({ command: "/usr/local/bin/claude", cwd: "/tmp", spawnImpl: () => child, forceKillAfterMs: 10 });
  child.stdout.write(JSON.stringify({ type: "error", error: "stream broke" }) + "\n");
  assert.equal(session.status().failed, "claude_native_error");
  assert.deepEqual(child.signals, ["SIGTERM"]);
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.deepEqual(child.signals, ["SIGTERM", "SIGKILL"]);
  const status = session.status();
  assert.equal(status.state, "failed");
  assert.equal(status.processExited, true);
});

test("closing Claude forces a process that ignores the request to exit", async () => {
  const child = stubbornChild();
  const session = createClaudeStructuredSession({ command: "/usr/local/bin/claude", cwd: "/tmp", spawnImpl: () => child, forceKillAfterMs: 10 });
  // The session's timers do not hold the Host open; this test must.
  const hold = setTimeout(() => {}, 1000);
  const closed = await session.close();
  clearTimeout(hold);
  assert.equal(closed.cleanupConfirmed, true);
  assert.deepEqual(child.signals, ["SIGTERM", "SIGKILL"]);
  assert.equal(session.status().state, "closed");
});

test("rechecking a closed Claude confirms cleanup only after its process exit is observed", async () => {
  const child = childFixture();
  child.kill = () => { child.killed = true; };
  const session = createClaudeStructuredSession({ command: "/synthetic/claude", cwd: "/tmp", env: {}, spawnImpl: () => child });
  const closing = session.close();
  const sameClose = session.close();
  assert.equal(sameClose, closing);
  assert.equal(session.status().cleanupConfirmed, false);
  child.emit("close", 0, null);
  assert.equal((await closing).cleanupConfirmed, true);
  assert.equal((await session.close()).cleanupConfirmed, true);
});

test("Claude model ids reject tabs and overlong values without truncation", async t => {
  const child = childFixture();
  const session = createClaudeStructuredSession({ command: "/usr/local/bin/claude", cwd: "/tmp", spawnImpl: () => child });
  t.after(() => session.close());
  await assert.rejects(session.setModel("sonnet\tpreview"), error => error && error.code === "claude_model_invalid");
  await assert.rejects(session.setModel("x".repeat(257)), error => error && error.code === "claude_model_invalid");
});

test("Claude model ACK errors preserve selection and successful switches clear old context", async t => {
  const child = childFixture();
  let respond = null;
  observeControlWire(child, message => { if (message.type === "control_request") respond?.(message); });
  const session = createClaudeStructuredSession({ command: "/usr/local/bin/claude", cwd: "/tmp", spawnImpl: () => child, requestTimeoutMs: 200 });
  t.after(() => session.close());
  respond = message => {
    if (message.request.subtype === "initialize") child.stdout.write(JSON.stringify({ type: "control_response", response: {
      subtype: "success", request_id: message.request_id, response: { model: "sonnet", models: [] },
    } }) + "\n");
  };
  await session.models();
  child.stdout.write(JSON.stringify({ type: "assistant", session_id: "session-1", message: { model: "sonnet", usage: {
    input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 25,
  } } }) + "\n");
  child.stdout.write(JSON.stringify({ type: "result", session_id: "session-1", modelUsage: {
    sonnet: { contextWindow: 1000 },
  } }) + "\n");
  assert.equal(session.contextUsage().contextWindow, 1000);

  let switchRequest;
  respond = message => { if (message.request.subtype === "set_model") switchRequest = message; };
  const rejected = session.setModel("opus");
  await new Promise(resolve => setImmediate(resolve));
  child.stdout.write(JSON.stringify({ type: "control_response", response: {
    subtype: "error", request_id: switchRequest.request_id, error: "model unavailable",
  } }) + "\n");
  await assert.rejects(rejected, error => error && error.code === "claude_control_rejected");
  assert.equal(session.contextUsage().model, "sonnet");
  assert.equal(session.contextUsage().contextWindow, 1000);

  const changing = session.setModel("opus");
  await new Promise(resolve => setImmediate(resolve));
  child.stdout.write(JSON.stringify({ type: "control_response", response: {
    subtype: "success", request_id: switchRequest.request_id, response: {},
  } }) + "\n");
  assert.deepEqual(await changing, { kind: "changed", model: "opus", effort: null });
  assert.deepEqual(session.contextUsage(), {
    model: "opus", contextWindow: null, contextTokens: null, contextPercent: null, usage: null,
  });
  child.stdout.write(JSON.stringify({ type: "result", session_id: "session-1", modelUsage: {
    sonnet: { inputTokens: 9999, contextWindow: 999999 },
  } }) + "\n");
  // A cumulative entry for the previous model must not be paired with the
  // newly selected model or resurrect its capacity.
  assert.deepEqual(session.contextUsage(), {
    model: "opus", contextWindow: null, contextTokens: null, contextPercent: null, usage: null,
  });
});

function compactionFixture(t) {
  const child=childFixture(),sent=[];
  observeControlWire(child,message=>{if(message.type==="control_request")child.stdout.write(JSON.stringify({type:"control_response",response:{subtype:"success",request_id:message.request_id,response:{}}})+"\n");else sent.push(message);});
  const session=createClaudeStructuredSession({command:"/usr/local/bin/claude",cwd:"/owned",spawnImpl:()=>child,requestTimeoutMs:100});t.after(()=>session.close());
  const emit=event=>child.stdout.write(JSON.stringify({session_id:"compact-native",...event})+"\n");
  return {child,session,sent,emit};
}
test("manual compaction requires a root boundary and final native result, not a pipe write",async t=>{
  const f=compactionFixture(t);let finished=false;const result=f.session.compact({instructions:"Keep decisions"}).then(value=>{finished=true;return value;});
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(f.sent[0].message.content[0].text,"/compact Keep decisions");assert.equal(finished,false);assert.equal(f.session.status().compacting,true);
  assert.equal((await f.session.send("interleaved")).code,"compaction_busy");
  f.emit({type:"system",subtype:"compact_boundary",compact_metadata:{trigger:"manual",pre_tokens:12345}});assert.equal(finished,false);
  f.emit({type:"result",subtype:"success",is_error:false,result:"Compacted"});
  assert.deepEqual(await result,{completed:true,beforeTokens:12345});assert.equal(f.session.status().compacting,false);
});
test("a normal response without a compact boundary never claims compaction succeeded",async t=>{
  const f=compactionFixture(t),result=f.session.compact();await new Promise(resolve=>setImmediate(resolve));
  f.emit({type:"result",subtype:"success",is_error:false,result:"I compacted it"});assert.equal((await result).code,"compaction_not_confirmed");
});
test("subagent and replay compact boundaries cannot complete the root compaction",async t=>{
  const f=compactionFixture(t),result=f.session.compact();await new Promise(resolve=>setImmediate(resolve));
  f.emit({type:"system",subtype:"compact_boundary",parent_tool_use_id:"child-tool",compact_metadata:{pre_tokens:100}});
  f.emit({type:"result",subtype:"success",parent_tool_use_id:"child-tool"});
  assert.equal(f.session.status().compacting,true);
  f.emit({type:"result",subtype:"error_during_execution",is_error:true,result:"Provider unavailable"});
  assert.notEqual((await result).completed,true);
});
test("closing a Claude process releases its pending compaction as failure",async t=>{
  const f=compactionFixture(t),result=f.session.compact();await new Promise(resolve=>setImmediate(resolve));f.child.emit("close",1,null);
  assert.equal((await result).code,"claude_process_ended");
});

// Claude Code routed through Magpie lists aliases whose resolved ids carry
// the route, the level they run at and "[1m]", and names the model it runs
// bare in its messages (Mini, 2026-10-21).
function magpieClaude(child, { applied = { model: "claude/claude-opus-5-5[1m]", effort: "high" }, effective = {} } = {}) {
  const alias = (value, level, extra = {}) => ({ value, displayName: `claude/claude-opus-5-5:${level}[1m]`, resolvedModel: `claude/claude-opus-5-5:${level}[1m]`,
    supportsEffort: true, supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"], ...extra });
  observeControlWire(child, message => {
    if (message.type !== "control_request") return;
    const reply = response => child.stdout.write(JSON.stringify({ type: "control_response", response: { subtype: "success", request_id: message.request_id, response } }) + "\n");
    if (message.request.subtype === "initialize") reply({ models: [alias("opus", "xhigh", { description: "Custom Opus model (1M context)" }), alias("fable", "high"), alias("sonnet", "medium")] });
    else if (message.request.subtype === "get_settings") reply({ applied, effective });
    else reply({});
  });
}

test("Claude through Magpie names the alias at the level it runs, with the 1M capacity before a turn ends", async t => {
  const child = childFixture();
  magpieClaude(child);
  const session = createClaudeStructuredSession({ command: "/usr/local/bin/claude", cwd: "/tmp", spawnImpl: () => child, requestTimeoutMs: 500 });
  t.after(() => session.close());
  assert.equal((await session.models()).currentEffort, "high");
  child.stdout.write(JSON.stringify({ type: "assistant", session_id: "session-1", message: { id: "m1", model: "claude-opus-5-5",
    usage: { input_tokens: 2, cache_read_input_tokens: 128_000, cache_creation_input_tokens: 579, output_tokens: 10 }, content: [] } }) + "\n");
  await new Promise(resolve => setImmediate(resolve));
  // Three aliases are this model; the one at the conversation's level is it.
  assert.equal((await session.models()).currentModel, "fable");
  const context = session.contextUsage();
  assert.equal(context.contextTokens, 128_581);
  assert.equal(context.contextWindow, 1_000_000, "the alias's [1m], before Claude reports a capacity");
  assert.equal(context.contextPercent, 12.8581);
});

test("Claude left to choose its own level reports auto, with the level its settings name", async t => {
  const child = childFixture();
  magpieClaude(child, { applied: { model: "opus", effort: "auto" }, effective: { effortLevel: "xhigh" } });
  // "auto" was kept for this conversation, so Claude's settings are not applied over it.
  const session = createClaudeStructuredSession({ command: "/usr/local/bin/claude", cwd: "/tmp", spawnImpl: () => child, requestTimeoutMs: 500, initialEffort: "auto" });
  t.after(() => session.close());
  const catalog = await session.models();
  assert.equal(catalog.currentEffort, "auto");
  assert.equal(catalog.effectiveEffort, "xhigh");
  await session.setEffort("high");
  assert.deepEqual([(await session.models()).currentEffort, (await session.models()).effectiveEffort], ["high", undefined]);
  // Cleared again, Claude runs at a level it has not reported.
  assert.equal((await session.setEffort("auto")).effort, "auto");
  assert.deepEqual([(await session.models()).currentEffort, (await session.models()).effectiveEffort], ["auto", undefined]);
});
