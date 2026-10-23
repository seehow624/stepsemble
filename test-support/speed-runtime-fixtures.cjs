"use strict";
// Synthetic native controls only; no CLI process, provider network or user frame.
const { EventEmitter } = require("node:events"), { PassThrough } = require("node:stream");
const path = require("node:path");
const { createClaudeStructuredSession } = require("../server/claude-code-structured-adapter");
const { createPiSpeed } = require("../server/pi-speed");
function claudeSpeedFixture(models, sessionId) {
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
  child.kill = () => { child.emit("close", 0); return true; };
  let fast = false;
  child.stdin.on("data", chunk => {
    for (const line of chunk.toString().trim().split("\n")) {
      const frame = JSON.parse(line); if (frame.type !== "control_request") throw new Error("synthetic_speed_user_frame_forbidden");
      const request = frame.request; let response = {};
      if (request.subtype === "initialize") response = { claude_code_version: "2.1.308", currentModel: models[0].id,
        models: models.map((row, i) => ({ value: row.id, displayName: row.name, supportsFastMode: i === 0 })),
        fast_mode_state: fast ? "on" : "off", ...(!fast ? { fast_mode_disabled_reason: "sdk_opt_in_required" } : {}) };
      if (request.subtype === "apply_flag_settings") fast = request.settings.fastMode;
      if (request.subtype === "get_settings") response = { effective: { fastMode: fast }, applied: { model: models[0].id } };
      queueMicrotask(() => child.stdout.write(JSON.stringify({ type: "control_response", response: { subtype: "success", request_id: frame.request_id, response } }) + "\n"));
    }
  });
  const session = createClaudeStructuredSession({ command: "/synthetic/claude", cwd: "/tmp", env: {}, spawnImpl: () => child, requestTimeoutMs: 500 });
  return { session: { models: () => session.models(), setSpeed: (...args) => session.setSpeed(...args), status: () => ({ ...session.status(), nativeSessionId: sessionId }) }, close: () => session.close() };
}
async function piSpeedFixture(capability) {
  const { installPiSpeed } = await import("../server/pi-speed-extension.mjs");
  const model = { provider: "magpie", api: "openai-responses", baseUrl: "http://127.0.0.1:3425/v1", id: "codex/fixture-pi" };
  const entries = [], hooks = {}, commands = {}; let leafId = null;
  const ctx = { model, isIdle: () => true, sessionManager: { getBranch: () => entries } };
  installPiSpeed({ on: (name, fn) => { hooks[name] = fn; }, registerCommand: (name, spec) => { commands[name] = spec.handler; },
    appendEntry: (customType, data) => { const id = "receipt-" + entries.length; entries.push({ id, parentId: leafId, type: "custom", customType, data }); leafId = id; }
  }, { capability });
  hooks.session_start({}, ctx);
  return createPiSpeed({ command: async (_sid, cmd) => {
    if (cmd.type === "get_commands") return { success: true, data: { commands: [{ name: "stepsemble-speed", source: "extension", sourceInfo: { path: path.resolve(__dirname, "../server/pi-speed-extension.mjs") } }] } };
    if (cmd.type === "get_state") return { success: true, data: { model, sessionId: "fixture-pi-session" } };
    if (cmd.type === "get_entries") return { success: true, data: { entries, leafId } };
    if (cmd.type === "prompt" && cmd.message.startsWith("/stepsemble-speed ")) {
      await commands["stepsemble-speed"](cmd.message.slice("/stepsemble-speed ".length), ctx);
      return { success: true, data: { disposition: "handled" } };
    }
    throw new Error("synthetic_speed_user_frame_forbidden");
  } });
}
module.exports = { claudeSpeedFixture, piSpeedFixture };
