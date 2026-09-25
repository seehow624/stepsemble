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
  assert.deepEqual(requests.map(request => [request.subtype, request.mode || null]), [["initialize", null], ["set_permission_mode", "plan"]]);
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
  assert.deepEqual(await changing, { kind: "changed", model: "opus" });
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

test("Claude result errors leave the session failed instead of returning to waiting", async t => {
  const child = childFixture();
  const session = createClaudeStructuredSession({ command: "/usr/local/bin/claude", cwd: "/tmp", spawnImpl: () => child });
  t.after(() => session.close());
  child.stdout.write(JSON.stringify({ type: "result", session_id: "session-1", subtype: "error_during_execution", is_error: true,
    errors: ["Authentication failed: signed out"], modelUsage: {}, result: "" }) + "\n");
  const status = session.status();
  assert.equal(status.state, "failed");
  assert.equal(status.failed, "claude_error_during_execution");
  assert.deepEqual(status.result.errors, ["Authentication failed: signed out"]);
});

test("Claude parser failures carry a status code through the live session", async t => {
  const child = childFixture();
  const session = createClaudeStructuredSession({ command: "/usr/local/bin/claude", cwd: "/tmp", spawnImpl: () => child });
  t.after(() => session.close());
  child.stdout.write(JSON.stringify({ type: "control_response", response: { subtype: "success" } }) + "\n");
  assert.equal(session.status().state, "failed");
  assert.equal(session.status().failed, "structured_event_invalid");
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
  assert.deepEqual(await changing, { kind: "changed", model: "opus" });
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
