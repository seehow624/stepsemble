"use strict";
const { speedValue, paidSpeed, speedTier, speedFingerprint, unknownSpeed } = require("./agent-speed");
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const revisionOf = choice => JSON.stringify([choice?.speed || "standard", choice?.speedModel || null, choice?.speedFingerprint || null]);
function createAgentSpeedRoutes({ codex, ensureCodex, choices, readJSON, sendJSON, resolveClaude = () => null, piSpeed = null }) {
  const saves = new Map();
  return async function handle(req, res, url) {
    if (url.pathname !== "/api/agent-speed" || !["GET", "POST"].includes(req.method)) return false;
    let unlock = null;
    try {
      const input = req.method === "POST" ? await readJSON(req, 4096) : Object.fromEntries(url.searchParams);
      const { agentId, sessionId, model } = input;
      if (!/^[a-z0-9][a-z0-9-]{0,47}$/.test(agentId || "") || !ID.test(sessionId || "")
        || model !== undefined && (typeof model !== "string" || model.length > 256)) throw Object.assign(new Error("speed_invalid"), { statusCode: 400 });
      let capability = unknownSpeed(), claudeSession = null, claudeNativeId = null;
      const claudeStillOwned = () => resolveClaude(sessionId)?.session === claudeSession
        && (claudeSession?.status()?.nativeSessionId || sessionId) === claudeNativeId;
      const conflict = () => Object.assign(new Error("speed_conflict"), { statusCode: 409 });
      if (agentId === "codex") {
        await ensureCodex();
        capability = await codex.speedStatus(sessionId, model || null);
      } else if (agentId === "claude-code") {
        const resolved = resolveClaude(sessionId);
        if (resolved) {
          claudeSession = resolved.session;
          capability = { ...((await claudeSession.models()).speed || unknownSpeed()), nativeSessionId: claudeSession.status()?.nativeSessionId || sessionId };
          claudeNativeId = capability.nativeSessionId;
          if (!claudeStillOwned()) throw conflict();
        }
        else capability = unknownSpeed("speed_runtime_inactive");
      } else if (agentId === "pi" && piSpeed) capability = await piSpeed.status(sessionId);
      const storageId = ["pi", "claude-code"].includes(agentId) ? capability.nativeSessionId || sessionId : sessionId;
      if (req.method === "POST") {
        // Serialize the entire apply/CAS/save/rollback transaction, including
        // aliases for the same durable conversation, not just native flags.
        const key = agentId + ":" + storageId, previous = saves.get(key) || Promise.resolve();
        let release;
        const gate = new Promise(resolve => { release = resolve; });
        const tail = previous.then(() => gate);
        saves.set(key, tail);
        unlock = () => { release(); if (saves.get(key) === tail) saves.delete(key); };
        await previous;
        if (agentId === "claude-code" && claudeSession) {
          if (!claudeStillOwned()) throw conflict();
          capability = { ...((await claudeSession.models()).speed || unknownSpeed()), nativeSessionId: claudeNativeId };
          if (!claudeStillOwned()) throw conflict();
        } else if (agentId === "pi" && piSpeed) {
          capability = await piSpeed.status(sessionId);
          if ((capability.nativeSessionId || sessionId) !== storageId) throw conflict();
        } else if (agentId === "codex") capability = await codex.speedStatus(sessionId, model || null);
      }
      let choice = choices.session(agentId, storageId) || {};
      // Changing route/model revokes a paid preference. Returning to the old
      // model cannot silently restore it. A sleeping runtime is not evidence
      // of a changed route, so it keeps its preference pending revalidation.
      if (paidSpeed(choice.speed) && (model && choice.speedModel !== model
        || capability.fingerprint && choice.speedFingerprint !== speedFingerprint(capability, choice.speed)
        || ["speed_not_offered", "speed_catalog_identity_unverified", "speed_route_unverified"].includes(capability.reason))) {
        if (!choices.record(agentId, storageId, { speed: "standard", speedModel: model || choice.speedModel }, { agent: false })) throw Object.assign(new Error("speed_save_failed"), { statusCode: 503 });
        choice = choices.session(agentId, storageId) || {};
      }
      if (req.method === "POST") {
        const speed = speedValue(input.speed);
        if (input.revision !== revisionOf(choice)) throw Object.assign(new Error("speed_conflict"), { statusCode: 409 });
        const fingerprint = speedFingerprint(capability, speed);
        if (paidSpeed(speed) && (input.confirmCost !== true || !speedTier(capability, speed)
          || !fingerprint || input.fingerprint !== fingerprint)) throw Object.assign(new Error("speed_revalidation_required"), { statusCode: 409 });
        if (speed === "ultrafast" && agentId !== "codex") throw Object.assign(new Error("speed_runtime_unverified"), { statusCode: 409 });
        if (!["codex", "claude-code", "pi"].includes(agentId)) throw Object.assign(new Error("speed_runtime_unverified"), { statusCode: 409 });
        if (agentId === "claude-code") {
          if (claudeSession && !claudeStillOwned()) throw conflict();
          const status = claudeSession?.status();
          if (claudeSession && !status.working && !["running", "interrupting"].includes(status.state)) capability = await claudeSession.setSpeed(speed, capability.fingerprint);
          if (claudeSession && !claudeStillOwned()) throw conflict();
        }
        if (agentId === "pi") {
          if (!piSpeed || capability.blocked) throw Object.assign(new Error("speed_runtime_unverified"), { statusCode: 409 });
          if (!capability.isStreaming) capability = await piSpeed.setSpeed(sessionId, speed, capability.fingerprint, storageId);
        }
        if (input.revision !== revisionOf(choices.session(agentId, storageId))) {
          if (agentId === "claude-code" && speed === "fast" && claudeStillOwned()) await claudeSession.setSpeed("standard").catch(() => {});
          if (agentId === "pi" && speed === "fast") await piSpeed.setSpeed(sessionId, "standard", undefined, storageId).catch(() => {});
          throw Object.assign(new Error("speed_conflict"), { statusCode: 409 });
        }
        const recorded = choices.record(agentId, storageId, { speed, speedModel: model || capability.model,
          speedFingerprint: speedFingerprint(capability, speed) || "" }, { agent: false });
        if (!recorded) {
          if (agentId === "claude-code" && speed === "fast" && claudeStillOwned()) await claudeSession.setSpeed("standard").catch(() => {});
          if (agentId === "pi" && speed === "fast") await piSpeed.setSpeed(sessionId, "standard", undefined, storageId).catch(() => {});
          throw Object.assign(new Error("speed_save_failed"), { statusCode: 503 });
        }
        choice = choices.session(agentId, storageId) || {};
      }
      sendJSON(res, 200, { ...capability, requested: choice.speed || "standard", revision: revisionOf(choice),
        preferenceFingerprint: choice.speedFingerprint || null });
    } catch (error) { sendJSON(res, error.statusCode || 409, { error: error.code || error.message || "speed_runtime_unverified" }); }
    finally { unlock?.(); }
    return true;
  };
}
module.exports = { createAgentSpeedRoutes, revisionOf };
