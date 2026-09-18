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
    "-p", "--output-format", "stream-json", "--input-format", "stream-json", "--verbose", "--include-partial-messages", "--permission-prompts", "host", "--resume", "session-1",
  ]);
  assert.deepEqual(buildClaudeStructuredArgs({ permissionPromptTool: "mcp__stepsemble__permission" }).slice(-2), ["--permission-prompt-tool", "mcp__stepsemble__permission"]);
  assert.throws(() => buildClaudeStructuredArgs({ sessionId: "../../secret" }), /invalid_claude_session_id/);
  assert.throws(() => buildClaudeStructuredArgs({ permissionPromptTool: "tool;rm" }), /invalid_permission_prompt_tool/);
  assert.deepEqual(buildClaudeStructuredArgs({ settingsPath: "/tmp/stepsemble-claude-settings.json" }).slice(-2), ["--settings", "/tmp/stepsemble-claude-settings.json"]);
  assert.throws(() => buildClaudeStructuredArgs({ settingsPath: "relative.json" }), /invalid_claude_settings_path/);
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
    id: "claude-ocx-test--glm", name: "GLM (Claude initialize)", description: "OpenCodex gateway", contextWindow: 1000000,
    supportsEffort: true, supportedEffortLevels: ["low", "high"], reasoning: true, gateway: "opencodex",
  });
  assert.deepEqual(args.argv.slice(-2), ["--settings", path.join(configDir, "claude-gateway-settings.json")]);
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

test("Claude effort control uses the native set_model envelope and updates after ACK", async t => {
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
      if (message.type === "control_request" && message.request?.subtype === "set_model" && message.request?.effort === "high") effortRequest = message;
    }
  });
  const changing = session.setEffort("high");
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(effortRequest?.request?.subtype, "set_model");
  assert.equal(effortRequest.request.effort, "high");
  child.stdout.write(JSON.stringify({ type: "control_response", response: {
    subtype: "success", request_id: effortRequest.request_id, response: { effort: "high" },
  } }) + "\n");
  assert.deepEqual(await changing, { kind: "changed", effort: "high" });
  assert.equal(session.status().effort, "high");
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

test("Claude rejects oversized image frames before marking a prompt active", async t => {
  const child = childFixture();
  const writes = [];
  child.stdin.on("data", chunk => writes.push(chunk));
  const session = createClaudeStructuredSession({ command: "/usr/local/bin/claude", cwd: "/tmp", spawnImpl: () => child });
  t.after(() => session.close());
  const image = "A".repeat(7 * 1024 * 1024);
  const result = await session.send("", { images: [
    { data: image, mimeType: "image/png" },
    { data: image, mimeType: "image/png" },
  ] });
  assert.deepEqual(result, { kind: "reject", code: "claude_input_frame_too_large" });
  assert.equal(session.status().state, "waiting");
  assert.equal(writes.length, 0, "oversized image prompt must not be partially written");
});

test("Claude rejects a prompt when the outbound queue is already full", async t => {
  const child = childFixture();
  Object.defineProperty(child.stdin, "writableLength", { configurable: true, value: 16 * 1024 * 1024 });
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
