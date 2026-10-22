"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { EventEmitter } = require("node:events"), { PassThrough } = require("node:stream");
const { createClaudeStructuredSession } = require("../server/claude-code-structured-adapter");
const { createClaudeQueueDriver } = require("../server/composer-queue-drivers");
const { createComposerQueueStore, createComposerQueue } = require("../server/composer-queue");
function fixture(t, options = {}) {
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
  child.kill = () => { child.emit("close", 0); return true; };
  const frames = [], runtime = { fast: false, model: "opus", ignored: false, timeout: false, denied: null, cooldown: false };
  child.stdin.on("data", chunk => {
    for (const line of chunk.toString().trim().split("\n")) {
      const f = JSON.parse(line); frames.push(f); if (f.type !== "control_request") continue;
      let response = {};
      if (f.request.subtype === "initialize") response = { claude_code_version: options.version || "2.1.308", currentModel: runtime.model,
        models: [{ value: "opus", displayName: "Opus", supportsFastMode: true }, { value: "other", displayName: "Other", supportsFastMode: false }],
        fast_mode_state: runtime.cooldown ? "cooldown" : runtime.fast ? "on" : "off",
        ...(runtime.denied ? { fast_mode_disabled_reason: runtime.denied } : runtime.fast ? {} : { fast_mode_disabled_reason: "sdk_opt_in_required" }) };
      if (f.request.subtype === "initialize" && runtime.missingState) { delete response.fast_mode_state; delete response.fast_mode_disabled_reason; }
      if (f.request.subtype === "initialize" && runtime.initializeTimeout) continue;
      if (f.request.subtype === "get_settings") response = { effective: { fastMode: runtime.fast }, applied: { model: runtime.model, effort: "high" } };
      if (f.request.subtype === "set_model") { runtime.model = f.request.model; response = { model: runtime.model }; }
      if (f.request.subtype === "apply_flag_settings" && Object.hasOwn(f.request.settings, "fastMode")) {
        if (!runtime.ignored) runtime.fast = f.request.settings.fastMode;
        if (runtime.timeout) continue;
      }
      queueMicrotask(() => child.stdout.write(JSON.stringify({ type: "control_response", response: { subtype: "success", request_id: f.request_id, response } }) + "\n"));
    }
  });
  const session = createClaudeStructuredSession({ command: "/synthetic/claude", cwd: "/tmp", env: options.env || {}, spawnImpl: () => child, requestTimeoutMs: 50, onEvent: options.onEvent });
  t.after(() => session.close()); return { session, frames, runtime, child };
}
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
    assert.equal(turn[0].request.subtype, "initialize", "refresh before trusting unknown cached state");
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
    assert.equal(frames[before].request.subtype, "initialize", "attempt a read-only refresh, not a flag write");
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
