"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { EventEmitter } = require("node:events"), { PassThrough } = require("node:stream");
const { createClaudeStructuredSession } = require("../server/claude-code-structured-adapter");
const { createClaudeQueueDriver } = require("../server/composer-queue-drivers");
const { createComposerQueueStore, createComposerQueue } = require("../server/composer-queue");
function fixture(t, options = {}) {
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
  child.kill = () => { child.emit("close", 0); return true; };
  const frames = [], runtime = { fast: false, model: options.model || "opus", env: {}, ignored: false, timeout: false, denied: null, cooldown: false };
  child.stdin.on("data", chunk => {
    for (const line of chunk.toString().trim().split("\n")) {
      const f = JSON.parse(line); frames.push(f); if (f.type !== "control_request") continue;
      let response = {};
      if (f.request.subtype === "initialize") response = { claude_code_version: options.version || "2.1.308", currentModel: runtime.model,
        ...(!runtime.omitModels ? { models: [{ value: "opus", displayName: "Opus", supportsFastMode: runtime.supportsFast !== false }, { value: "other", displayName: "Other", supportsFastMode: false }] } : {}),
        fast_mode_state: runtime.cooldown ? "cooldown" : runtime.fast ? "on" : "off",
        ...(runtime.denied ? { fast_mode_disabled_reason: runtime.denied } : runtime.fast ? {} : { fast_mode_disabled_reason: "sdk_opt_in_required" }) };
      if (f.request.subtype === "initialize" && runtime.missingState) { delete response.fast_mode_state; delete response.fast_mode_disabled_reason; }
      if (f.request.subtype === "initialize" && runtime.initializeTimeout) continue;
      if (f.request.subtype === "get_settings" && runtime.settingsTimeout) continue;
      if (f.request.subtype === "get_settings") response = { effective: { fastMode: runtime.fast, env: runtime.env }, applied: { model: runtime.model, effort: "high" } };
      if (f.request.subtype === "set_model") { runtime.model = f.request.model; response = { model: runtime.model }; }
      if (f.request.subtype === "apply_flag_settings" && f.request.settings.env && !runtime.ignoreEnv) runtime.env = f.request.settings.env;
      if (f.request.subtype === "apply_flag_settings" && Object.hasOwn(f.request.settings, "fastMode")) {
        if (!runtime.ignored) runtime.fast = f.request.settings.fastMode;
        if (runtime.timeout) continue;
      }
      queueMicrotask(() => child.stdout.write(JSON.stringify({ type: "control_response", response: { subtype: "success", request_id: f.request_id, response } }) + "\n"));
    }
  });
  const session = createClaudeStructuredSession({ command: "/synthetic/claude", cwd: "/tmp", env: options.env || {}, spawnImpl: () => child, requestTimeoutMs: 50, onEvent: options.onEvent,
    ...(options.speedEnvironment !== undefined ? { speedEnvironment: options.speedEnvironment } : {}), gatewaySpeedCapability: options.gatewaySpeedCapability });
  t.after(() => session.close()); return { session, frames, runtime, child };
}
test("claude-speed: granting Fast preserves native unscoped global negative capability restrictions", () => {
  const { grantFastCapability } = require("../server/claude-gateway-speed");
  for (const value of ["-fast_mode", "vision; -fast_mode,reasoning", "codex/*=reasoning;-fast_mode"]) {
    assert.equal(grantFastCapability(value, "codex/fixture-gpt"), null);
  }
  assert.equal(grantFastCapability("other=-fast_mode;vision", "codex/fixture-gpt"), "other=-fast_mode;vision;codex/fixture-gpt=fast_mode");
});
test("claude-speed: child routing receipts bound URL and capability size and remove embedded URL credentials", () => {
  const { claudeSpeedEnvironment } = require("../server/claude-gateway-speed");
  for (const url of ["https://user:secret@example.test", "https://example.test/?token=secret", "https://example.test/#secret"]) {
    const receipt = claudeSpeedEnvironment({ ANTHROPIC_BASE_URL: url, ANTHROPIC_API_KEY: "must-not-cross" });
    assert.equal(receipt.ANTHROPIC_BASE_URL, "unverified"); assert.equal(Object.hasOwn(receipt, "ANTHROPIC_API_KEY"), false);
    assert.equal(JSON.stringify(receipt).includes("secret"), false);
  }
  assert.equal(claudeSpeedEnvironment({ ANTHROPIC_BASE_URL: "https://example.test/" + "x".repeat(2048) }), null);
  assert.equal(claudeSpeedEnvironment({ CLAUDE_CODE_MODEL_CAPABILITIES: "x".repeat(16385) }), null);
});
test("claude-speed: effective route and restrictions are discovered before classifying an apparently official child", async t => {
  for (const speedEnvironment of [{}, { ANTHROPIC_BASE_URL: "https://api.anthropic.com" }]) {
    const f = fixture(t, { speedEnvironment });
    const direct = (await f.session.models()).speed;
    assert.equal(direct.support, "supported");
    f.runtime.env = { ANTHROPIC_BASE_URL: "https://unverified.invalid", CLAUDE_CODE_DISABLE_FAST_MODE: "1" };
    assert.equal((await f.session.models()).speed.support, "unknown");
    await assert.rejects(f.session.setSpeed("fast", direct.fingerprint), /speed_revalidation_required/);
    assert.equal(f.frames.some(frame => frame.request?.settings?.fastMode === true || frame.type === "user"), false);
    f.runtime.env = { ANTHROPIC_BASE_URL: "https://api.anthropic.com" };
    assert.equal((await f.session.models()).speed.support, "supported");
    f.runtime.env = { ANTHROPIC_BASE_URL: "https://another.invalid" };
    assert.equal((await f.session.models()).speed.support, "unknown", "an official transition cannot pin a stale route");
  }
});
test("claude-speed: failed effective-settings discovery closes paid authorization on an official child", async t => {
  const f = fixture(t), direct = (await f.session.models()).speed;
  f.runtime.settingsTimeout = true;
  assert.equal((await f.session.models()).speed.support, "unknown");
  await assert.rejects(f.session.setSpeed("fast", direct.fingerprint), /speed_revalidation_required/);
  assert.equal(f.frames.some(frame => frame.request?.settings?.fastMode === true || frame.type === "user"), false);
});
test("claude-speed: Ultra is refused without flags or a user frame, never downgraded to false", async t => {
  const { session, frames } = fixture(t); await session.models(); const before = frames.length;
  await assert.rejects(session.setSpeed("ultrafast", "forged"), /speed_revalidation_required/);
  const result = await session.send("not sent", { speed: "ultrafast", speedFingerprint: "forged" });
  assert.equal(result.kind, "reject");
  assert.equal(frames.slice(before).some(f => f.type === "user" || f.request?.subtype === "apply_flag_settings"), false);
});
test("claude-speed: fresh initialize catalog supersedes startup and omitted models preserve it", async t => {
  const { session, runtime } = fixture(t);
  assert.equal((await session.models()).speed.support, "supported");
  runtime.supportsFast = false;
  assert.equal((await session.models()).speed.support, "unavailable");
  runtime.omitModels = true;
  assert.equal((await session.models()).speed.support, "unavailable");
  runtime.omitModels = false; runtime.supportsFast = true;
  assert.equal((await session.models()).speed.support, "supported");
});
test("claude-speed: exact session flag, true/false readback, no prompt and independent effort/model", async t => {
  const { session, frames } = fixture(t);
  const catalog = await session.models(); assert.equal(catalog.speed.support, "supported");
  const fast = await session.setSpeed("fast", catalog.speed.fingerprint);
  assert.equal(fast.requested, "fast"); assert.equal(fast.effective, "fast");
  assert.deepEqual(frames.filter(f => f.request?.subtype === "apply_flag_settings").at(-1).request, { subtype: "apply_flag_settings", settings: { fastMode: true } });
  const standard = await session.setSpeed("standard"); assert.equal(standard.effective, "standard");
  assert.equal(frames.some(f => f.type === "user"), false);
  assert.equal(session.status().model, "opus"); assert.equal(session.status().effort, "high");
  assert.equal(frames.some(f => f.request?.subtype === "update_settings" || f.request?.subtype === "set_model"), false);
});
test("claude-speed: ACK without readback and timeout never release a potentially paid user frame", async t => {
  for (const key of ["ignored", "timeout"]) {
    const { session, frames, runtime } = fixture(t); const catalog = await session.models(); runtime[key] = true;
    const result = await session.send("synthetic only", { speed: "fast", speedFingerprint: catalog.speed.fingerprint });
    assert.equal(result.kind, "reject"); assert.equal(frames.some(f => f.type === "user"), false);
    assert.equal(session.status().speed.effective, "unknown");
    runtime[key] = false;
    if (key === "timeout") {
      await assert.rejects(session.setSpeed("standard"), /speed_reopen_required/, "a potentially late apply cannot be cleared by an unrelated ACK");
      assert.equal((await session.send("still blocked", { speed: "standard" })).kind, "reject");
      assert.equal(frames.some(f => f.type === "user"), false);
    } else assert.equal((await session.setSpeed("standard")).effective, "standard", "explicit off resolves a mismatched readback before sending");
  }
});
test("claude-speed: account refusal rolls back flag, cooldown is not silently called fast", async t => {
  const { session, runtime } = fixture(t); const cap = (await session.models()).speed;
  runtime.denied = "extra_usage_disabled";
  await assert.rejects(session.setSpeed("fast", cap.fingerprint), /speed_extra_usage_disabled/);
  assert.equal(runtime.fast, false); assert.equal(session.status().speed.support, "unavailable");
  runtime.denied = null;
  await session.setSpeed("standard"); runtime.cooldown = true;
  assert.equal((await session.setSpeed("fast", cap.fingerprint)).effective, "cooldown");
});
test("claude-speed: a result missing speed never lets the next standard message inherit Fast", async t => {
  const { session, frames, runtime, child } = fixture(t); const cap = (await session.models()).speed;
  assert.equal((await session.send("explicit paid preference", { speed: "fast", speedFingerprint: cap.fingerprint })).kind, "sent");
  assert.equal(runtime.fast, true);
  child.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "synthetic", session_id: "session-a" }) + "\n");
  assert.equal(session.status().speed.support, "unknown");
  assert.equal((await session.send("ordinary next message", { speed: "standard" })).kind, "sent");
  assert.equal(runtime.fast, false);
  assert.equal(frames.filter(f => f.type === "user").length, 2);
});
test("claude-speed: two queued Fast messages revalidate missing result metadata without a browser GET", async t => {
  let queue;
  const { session, frames, runtime, child } = fixture(t, { onEvent: event => queue?.observe("claude-code", "local-1", event) });
  const driver = createClaudeQueueDriver({ resolveSession: () => ({ id: "local-1", session }), send: (_id, text, options) => session.send(text, options) });
  queue = createComposerQueue({ store: createComposerQueueStore(), drivers: { "claude-code": driver }, sweepMs: 0 });
  t.after(() => queue.close());
  const snapshot = { speed: "fast", speedFingerprint: (await session.models()).speed.fingerprint };
  assert.equal((await session.send("initial turn", snapshot)).kind, "sent");
  const queued = ["first queued", "second queued"].map(text => queue.add("claude-code", "local-1", { text, ...snapshot }).item);
  const event = value => child.stdout.write(JSON.stringify({ session_id: "local-1", ...value }) + "\n");
  for (let i = 0; i < queued.length; i++) {
    const before = frames.length;
    event({ type: "result", subtype: "success", is_error: false, result: "synthetic" });
    await new Promise(resolve => setImmediate(resolve));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(frames.filter(f => f.type === "user").length, i + 2);
    const turn = frames.slice(before);
    assert.deepEqual(turn.slice(0, 2).map(frame => frame.request.subtype), ["get_settings", "initialize"], "refresh effective routing and native state before any flag write");
    assert.equal(turn.at(-1).uuid, queued[i].id);
    assert.equal(runtime.fast, true);
    assert.equal(queue.snapshot("claude-code", "local-1").paused, false);
    event({ type: "command_lifecycle", command_uuid: queued[i].id, state: "started" });
  }
  assert.equal(queue.snapshot("claude-code", "local-1").items.length, 0);
});
test("claude-speed: a fresh unknown, denied or timed-out handshake never releases a queued paid frame", async t => {
  for (const mode of ["missingState", "denied", "initializeTimeout"]) {
    const { session, frames, runtime, child } = fixture(t);
    const snapshot = { speed: "fast", speedFingerprint: (await session.models()).speed.fingerprint };
    assert.equal((await session.send("initial turn", snapshot)).kind, "sent");
    child.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "synthetic" }) + "\n");
    runtime[mode] = mode === "denied" ? "extra_usage_disabled" : true;
    const before = frames.length;
    assert.equal((await session.send("must stay queued", snapshot)).kind, "reject");
    assert.deepEqual(frames.slice(before, before + 2).map(frame => frame.request.subtype), ["get_settings", "initialize"], "refresh routing and runtime state read-only before considering a flag write");
    assert.equal(frames.slice(before).some(f => f.type === "user" || f.request?.subtype === "apply_flag_settings"), false);
  }
});
test("claude-speed: changed model revokes Fast and proxies/old runtime are not probed with flag writes", async t => {
  const { session, runtime } = fixture(t); const cap = (await session.models()).speed;
  await session.setSpeed("fast", cap.fingerprint); await session.setModel("other");
  assert.equal(runtime.fast, false); assert.equal((await session.models()).speed.support, "unavailable");
  await assert.rejects(session.setSpeed("fast", cap.fingerprint), /speed_revalidation_required/);
  for (const options of [{ env: { ANTHROPIC_BASE_URL: "http://localhost:3425" } }, { version: "2.1.1" }]) {
    const f = fixture(t, options); const report = await f.session.models(); assert.equal(report.speed.support, "unknown");
    await f.session.setSpeed("standard"); assert.equal(f.frames.some(frame => frame.request?.settings?.fastMode !== undefined), false);
    await assert.rejects(f.session.setSpeed("fast", "forged"), /speed_revalidation_required/);
  }
});

async function magpieFixture(t, options = {}) {
  const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
  const { createMagpieGatewayService } = require("../server/magpie-gateway-service");
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "claude-magpie-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.mkdirSync(path.join(home, ".config", "magpie"), { recursive: true });
  const metadata = { row: { id: "codex/fixture-gpt", owned_by: "codex", service_tiers: [{ id: "priority" }], native_endpoints: ["/v1/responses"] } };
  const gateway = createMagpieGatewayService({ home, env: { HOME: home, PATH: "" }, fetchImpl: async () => new Response(JSON.stringify({ data: [metadata.row] })) });
  const input = { env: { HOME: home, ANTHROPIC_BASE_URL: gateway.origin, CLAUDE_CODE_MODEL_CAPABILITIES: "other=reasoning" },
    model: metadata.row.id, gatewaySpeedCapability: gateway.speedCapability, ...options };
  return { ...fixture(t, input), metadata, gateway };
}
test("claude-magpie: exact fresh Codex offering controls native flags/env, Standard restores capability and keeps served unknown", async t => {
  const f = await magpieFixture(t);
  f.runtime.env = { USER_SETTING: "preserved" };
  const cap = (await f.session.models()).speed;
  assert.equal(cap.support, "supported"); assert.equal(cap.effective, "unknown");
  assert.match(cap.fingerprint, /claude-2.1.308/); assert.match(cap.fingerprint, /claude-messages/);
  assert.equal(f.frames.some(frame => frame.request?.subtype === "apply_flag_settings"), false, "GET never opts in");
  const fast = await f.session.setSpeed("fast", cap.fingerprint);
  assert.equal(fast.effective, "unknown"); assert.equal(f.runtime.fast, true);
  assert.equal(f.runtime.env.CLAUDE_CODE_MODEL_CAPABILITIES, "other=reasoning;codex/fixture-gpt=fast_mode");
  assert.equal(f.runtime.env.USER_SETTING, "preserved");
  await f.session.setSpeed("standard");
  assert.equal(f.runtime.fast, false); assert.equal(f.runtime.env.CLAUDE_CODE_MODEL_CAPABILITIES, "other=reasoning");
  assert.equal(f.frames.some(frame => frame.type === "user" || ["update_settings", "set_model"].includes(frame.request?.subtype)), false);
  assert.equal(f.session.status().model, "codex/fixture-gpt"); assert.equal(f.session.status().effort, "high");
});
test("claude-magpie: revocation, native refusal, missing env receipt, timeout and stale model never release a user frame", async t => {
  for (const mode of ["revoked", "ignored", "timeout", "denied", "ignoreEnv", "model"]) {
    const f = await magpieFixture(t), cap = (await f.session.models()).speed;
    if (mode === "revoked") f.metadata.row.service_tiers = [];
    else if (mode === "model") await f.session.setModel("other");
    else f.runtime[mode] = mode === "denied" ? "policy" : true;
    const result = await f.session.send("must not dispatch", { speed: "fast", speedFingerprint: cap.fingerprint });
    assert.equal(result.kind, "reject", mode); assert.equal(f.frames.some(frame => frame.type === "user"), false, mode);
    if (mode === "timeout") {
      f.runtime.timeout = false;
      assert.equal((await f.session.send("still blocked", { speed: "standard" })).kind, "reject");
    }
  }
});
test("claude-magpie: exact negative native capability, missing desktop receipt and unknown owner stay closed", async t => {
  for (const change of [
    { env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:3425", CLAUDE_CODE_MODEL_CAPABILITIES: "codex/*=-fast_mode" } },
    { speedEnvironment: null },
  ]) {
    const f = await magpieFixture(t, change);
    assert.equal((await f.session.models()).speed.support, "unknown");
    await assert.rejects(f.session.setSpeed("fast", "forged"), /speed_revalidation_required/);
    assert.equal(f.frames.some(frame => frame.request?.settings?.env), false);
  }
  const f = await magpieFixture(t); f.metadata.row.owned_by = "claude";
  assert.equal((await f.session.models()).speed.support, "unknown");
});
test("claude-magpie: desktop child route/capabilities take precedence over Host env", async t => {
  const f = await magpieFixture(t, { env: { ANTHROPIC_BASE_URL: "https://wrong.invalid" }, speedEnvironment: {
    ANTHROPIC_BASE_URL: "http://127.0.0.1:3425", CLAUDE_CODE_MODEL_CAPABILITIES: "desktop=reasoning" } });
  const cap = (await f.session.models()).speed; assert.equal(cap.support, "supported");
  await f.session.setSpeed("fast", cap.fingerprint);
  assert.equal(f.runtime.env.CLAUDE_CODE_MODEL_CAPABILITIES, "desktop=reasoning;codex/fixture-gpt=fast_mode");
});
test("claude-magpie: busy choice sends no flag; queued Fast/Standard snapshots revalidate catalog and clear exactly", async t => {
  let queue;
  const f = await magpieFixture(t, { onEvent: event => queue?.observe("claude-code", "local-1", event) });
  const driver = createClaudeQueueDriver({ resolveSession: () => ({ id: "local-1", session: f.session }), send: (_id, text, options) => f.session.send(text, options) });
  queue = createComposerQueue({ store: createComposerQueueStore(), drivers: { "claude-code": driver }, sweepMs: 0 }); t.after(() => queue.close());
  const snapshot = { speed: "fast", speedFingerprint: (await f.session.models()).speed.fingerprint };
  assert.equal((await f.session.send("running", { speed: "standard" })).kind, "sent");
  const before = f.frames.length;
  await assert.rejects(f.session.setSpeed("fast", snapshot.speedFingerprint), /speed_busy/);
  assert.equal(f.frames.slice(before).some(frame => frame.request?.settings), false);
  queue.add("claude-code", "local-1", { text: "Fast next", ...snapshot });
  queue.add("claude-code", "local-1", { text: "Standard later", speed: "standard" });
  for (const fast of [true, false]) {
    f.child.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "synthetic", session_id: "local-1" }) + "\n");
    await new Promise(resolve => setImmediate(resolve)); await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.runtime.fast, fast);
    const user = f.frames.filter(frame => frame.type === "user").at(-1);
    f.child.stdout.write(JSON.stringify({ type: "command_lifecycle", command_uuid: user.uuid, state: "started", session_id: "local-1" }) + "\n");
  }
  assert.deepEqual(f.frames.filter(frame => frame.type === "user").map(frame => frame.message.content[0].text), ["running", "Fast next", "Standard later"]);
});
test("claude-magpie: Standard clears the flag while preserving capabilities changed outside its owned grant", async t => {
  const f = await magpieFixture(t), cap = (await f.session.models()).speed;
  await f.session.setSpeed("fast", cap.fingerprint);
  f.runtime.env.CLAUDE_CODE_MODEL_CAPABILITIES = "codex/*=-fast_mode;another=reasoning";
  await f.session.setSpeed("standard");
  assert.equal(f.runtime.fast, false);
  assert.equal(f.runtime.env.CLAUDE_CODE_MODEL_CAPABILITIES, "codex/*=-fast_mode;another=reasoning");
  assert.equal((await f.session.models()).speed.support, "unknown");
  const oldHelper = fixture(t, { speedEnvironment: null });
  assert.equal((await oldHelper.session.models()).speed.support, "unknown", "even a native-capable row cannot borrow an unreported desktop route");
});
