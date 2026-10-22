"use strict";
const { speedValue, unknownSpeed } = require("./agent-speed");
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const revisionOf = choice => JSON.stringify([choice?.speed || "standard", choice?.speedModel || null, choice?.speedFingerprint || null]);
function createAgentSpeedRoutes({ codex, ensureCodex, choices, readJSON, sendJSON, resolveClaude = () => null, piSpeed = null }) {
  return async function handle(req, res, url) {
    if (url.pathname !== "/api/agent-speed" || !["GET", "POST"].includes(req.method)) return false;
    try {
      const input = req.method === "POST" ? await readJSON(req, 4096) : Object.fromEntries(url.searchParams);
      const { agentId, sessionId, model } = input;
      if (!/^[a-z0-9][a-z0-9-]{0,47}$/.test(agentId || "") || !ID.test(sessionId || "")
        || model !== undefined && (typeof model !== "string" || model.length > 256)) throw Object.assign(new Error("speed_invalid"), { statusCode: 400 });
      let capability = unknownSpeed();
      if (agentId === "codex") {
        await ensureCodex();
        capability = await codex.speedStatus(sessionId, model || null);
      } else if (agentId === "claude-code") {
        const resolved = resolveClaude(sessionId);
        if (resolved) capability = { ...((await resolved.session.models()).speed || unknownSpeed()),
          nativeSessionId: resolved.session.status()?.nativeSessionId || sessionId };
      } else if (agentId === "pi" && piSpeed) capability = await piSpeed.status(sessionId);
      const storageId = ["pi", "claude-code"].includes(agentId) ? capability.nativeSessionId || sessionId : sessionId;
      let choice = choices.session(agentId, storageId) || {};
      // Changing route/model revokes a paid preference. Returning to the old
      // model cannot silently restore it. A sleeping runtime is not evidence
      // of a changed route, so it keeps its preference pending revalidation.
      if (choice.speed === "fast" && (model && choice.speedModel !== model
        || capability.fingerprint && choice.speedFingerprint !== capability.fingerprint)) {
        if (!choices.record(agentId, storageId, { speed: "standard", speedModel: model || choice.speedModel }, { agent: false })) throw Object.assign(new Error("speed_save_failed"), { statusCode: 503 });
        choice = choices.session(agentId, storageId) || {};
      }
      if (req.method === "POST") {
        const speed = speedValue(input.speed);
        if (input.revision !== revisionOf(choice)) throw Object.assign(new Error("speed_conflict"), { statusCode: 409 });
        if (speed === "fast" && (input.confirmCost !== true || capability.support !== "supported"
          || input.fingerprint !== capability.fingerprint)) throw Object.assign(new Error("speed_revalidation_required"), { statusCode: 409 });
        if (!["codex", "claude-code", "pi"].includes(agentId)) throw Object.assign(new Error("speed_runtime_unverified"), { statusCode: 409 });
        if (agentId === "claude-code") {
          const session = resolveClaude(sessionId)?.session;
          const status = session?.status();
          if (session && !status.working && !["running", "interrupting"].includes(status.state)) capability = await session.setSpeed(speed, capability.fingerprint);
        }
        if (agentId === "pi") {
          if (!piSpeed || capability.blocked) throw Object.assign(new Error("speed_runtime_unverified"), { statusCode: 409 });
          if (!capability.isStreaming) capability = await piSpeed.setSpeed(sessionId, speed, capability.fingerprint);
        }
        if (input.revision !== revisionOf(choices.session(agentId, storageId))) {
          if (agentId === "claude-code" && speed === "fast") await resolveClaude(sessionId)?.session.setSpeed("standard").catch(() => {});
          if (agentId === "pi" && speed === "fast") await piSpeed.setSpeed(sessionId, "standard").catch(() => {});
          throw Object.assign(new Error("speed_conflict"), { statusCode: 409 });
        }
        const recorded = choices.record(agentId, storageId, { speed, speedModel: model || capability.model,
          speedFingerprint: capability.fingerprint || "" }, { agent: false });
        if (!recorded) {
          if (agentId === "claude-code" && speed === "fast") await resolveClaude(sessionId)?.session.setSpeed("standard").catch(() => {});
          if (agentId === "pi" && speed === "fast") await piSpeed.setSpeed(sessionId, "standard").catch(() => {});
          throw Object.assign(new Error("speed_save_failed"), { statusCode: 503 });
        }
        choice = choices.session(agentId, storageId) || {};
      }
      sendJSON(res, 200, { ...capability, requested: choice.speed || "standard", revision: revisionOf(choice),
        preferenceFingerprint: choice.speedFingerprint || null });
    } catch (error) { sendJSON(res, error.statusCode || 409, { error: error.code || error.message || "speed_runtime_unverified" }); }
    return true;
  };
}
module.exports = { createAgentSpeedRoutes, revisionOf };
