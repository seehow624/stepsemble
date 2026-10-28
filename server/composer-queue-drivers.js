"use strict";

// How each agent takes a queued message (server/composer-queue.js). "start"
// sends it as the next turn of an idle agent; "jump" puts it into the turn
// under way: Pi's steer, Codex's turn/steer, Claude Code's user frame with
// priority "next". Each confirms from the agent's own report before the
// message counts as delivered.

const { codexImageInputs, piImageInputs } = require("./prompt-attachments");

const THREAD = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const reject = (code, extra = {}) => ({ kind: "reject", code: String(code || "queue_delivery_failed").slice(0, 128), ...extra });
const textOf = content => typeof content === "string" ? content
  : Array.isArray(content) ? content.filter(block => block?.type === "text").map(block => block.text || "").join("") : "";

// Pi: conversations are known by their session file, which outlives the RPC
// process; a page names the live process it has open.
function createPiQueueDriver({ sessions, command, sessionFileOf = () => null, send = null }) {
  const keyOf = (sid, session) => sessionFileOf(session) || session?.meta?.file || `sid:${sid}`;
  const live = session => !!session && !session.exited && !session.closeReason && !session.protocolFailed;
  function liveSid(id) {
    for (const [sid, session] of sessions) if (live(session) && keyOf(sid, session) === id) return sid;
    return null;
  }
  function busy(id) {
    const session = sessions.get(liveSid(id));
    if (!session) return false;
    return !!(session.state?.isStreaming || session.state?.isCompacting
      || [...(session.pendingWork?.values() || [])].some(work => ["prompt", "steer", "follow_up", "compact"].includes(work?.type)));
  }
  return Object.freeze({
    resolve(ref) {
      const session = sessions.get(ref);
      if (session) return keyOf(ref, session);
      return liveSid(ref) ? ref : null;
    },
    liveSids(id) { return [...sessions].filter(([sid, session]) => live(session) && keyOf(sid, session) === id).map(([sid]) => sid); },
    available: id => !!liveSid(id),
    busy,
    async deliver(id, item, payload, { jump }) {
      if (item.speed === "ultrafast") return reject("speed_revalidation_required");
      const sid = liveSid(id);
      if (!sid) return reject("pi_unavailable");
      const images = piImageInputs(payload.images), streaming = !!sessions.get(sid)?.state?.isStreaming;
      const message = { message: payload.text, ...(images.length ? { images } : {}) };
      const run = async cmd => {
        try { return send ? await send(sid, cmd, item) : await command(sid, cmd); }
        catch (error) { return { success: false, error: error.code || error.message }; }
      };
      if (jump && streaming) {
        // Delivered after the current tool calls, before Pi's next model call.
        const response = await run({ type: "steer", ...message });
        if (response?.error === "speed_busy") return { kind: "unsupported" };
        return response?.success ? { kind: "accepted" } : reject(response?.error || "pi_steer_rejected");
      }
      if (busy(id)) return { kind: "busy" };
      const response = await run({ type: "prompt", ...message });
      if (response?.success) return { kind: "delivered" };
      return /stream/i.test(String(response?.error || "")) ? { kind: "busy" } : reject("pi_prompt_rejected");
    },
    fromEvent(sid, event) {
      // Most events are streamed text; only these concern the queue.
      if (!["message_start", "agent_settled", "rpc_exit"].includes(event?.type) || event.type === "message_start" && event.message?.role !== "user") return null;
      const session = sessions.get(sid);
      if (!session) return null;
      const id = keyOf(sid, session);
      if (event.type === "message_start" && event.message?.role === "user") return { id, deliveredText: textOf(event.message.content) };
      if (event.type === "agent_settled") {
        const outcome = event.aborted === true ? "stopped" : session.state?.runOutcome;
        return { id, turnEnded: outcome === "stopped" ? "stopped" : outcome === "failed" ? "failed" : "completed" };
      }
      if (event.type === "rpc_exit") return { id, turnEnded: "stopped" };
      return null;
    },
  });
}

// Codex: a thread id. A message jumps into the active turn with turn/steer,
// which names the turn it expects; a Codex without it takes the message next.
function createCodexQueueDriver({ codex, ensure = async () => {}, permissions = () => ({}) }) {
  let steerUnavailable = false;
  const nativeState = id => { try { return codex.nativeState(id) || {}; } catch { return {}; } };
  function busy(id) {
    const native = nativeState(id);
    let approvals = [];
    try { approvals = codex.pendingApprovals(id) || []; } catch {}
    return !!(native.turnId || native.state === "turn_running" || native.compacting || approvals.length);
  }
  async function start(id, item, input) {
    if (!nativeState(id).threadId) {
      const resumed = await codex.resumeThread({ threadId: id });
      if (resumed?.kind === "reject") return reject(resumed.code);
    }
    if (nativeState(id).turnId) return { kind: "busy" };
    const params = { ...(item.model ? { model: item.model } : {}), ...(item.effort ? { effort: item.effort } : {}),
      speed: item.speed || "standard", speedFingerprint: item.speedFingerprint, ...(permissions(id) || {}) };
    const result = await codex.startTurn(input, params, id);
    if (["started", "completed"].includes(result?.kind)) return { kind: "delivered" };
    if (result?.code === "native_lifecycle_conflict") return { kind: "busy" };
    return reject(result?.code || "codex_turn_failed");
  }
  return Object.freeze({
    resolve: ref => THREAD.test(ref) ? ref : null,
    available: () => { try { return codex.status?.()?.mutationReady !== false; } catch { return false; } },
    canJump: () => !steerUnavailable,
    busy,
    async deliver(id, item, payload, { jump }) {
      await ensure();
      const input = [...(payload.text ? [{ type: "text", text: payload.text }] : []), ...codexImageInputs(payload.images)];
      if (!input.length) return reject("codex_turn_input_invalid");
      // turn/steer cannot carry a speed snapshot; leave it for its own turn.
      if (jump && item.speed && nativeState(id).turnId) return { kind: "unsupported" };
      if (jump) {
        // A turn that ended or changed between reading it and steering is
        // read again once; with no turn under way the message starts one.
        for (let attempt = 0; attempt < 2; attempt += 1) {
          const turnId = nativeState(id).turnId;
          if (!turnId) break;
          let result;
          try { result = typeof codex.steerTurn === "function" ? await codex.steerTurn(id, input, { expectedTurnId: turnId, clientUserMessageId: item.id }) : reject("native_method_unsupported"); }
          catch (error) { if (error?.code !== "native_child_capability_missing") throw error; result = reject("native_method_unsupported"); }
          if (result?.kind === "steered") return { kind: "accepted" };
          if (result?.code === "native_method_unsupported") { steerUnavailable = true; return { kind: "unsupported" }; }
          if (!["native_turn_mismatch", "native_steer_rejected", "native_turn_not_running"].includes(result?.code)) return reject(result?.code || "codex_steer_failed");
        }
        if (nativeState(id).turnId) return reject("native_turn_mismatch");
      }
      return start(id, item, input);
    },
    fromEvent(threadId, event) {
      if (!event || !THREAD.test(String(threadId || "")) || event.parentThreadId || event.type === "subagent.thread") return null;
      if (event.type === "turn.completed") return { id: threadId, turnEnded: event.status === "completed" ? "completed" : "failed" };
      if (event.type === "turn.interrupted" || event.type === "transport.failed") return { id: threadId, turnEnded: "stopped" };
      if (["item.started", "item.completed"].includes(event.type) && event.itemType === "userMessage" && typeof event.clientId === "string") return { id: threadId, delivered: event.clientId };
      return null;
    },
  });
}

// Claude Code: its own session id, or the Host's key before Claude reports
// one. A message is a stream-json user frame with the message's uuid, so
// Claude reports its fate (command_lifecycle).
function createClaudeQueueDriver({ resolveSession, send, saved = () => null, confirmWithin = 15_000 }) {
  const statusOf = resolved => { try { return resolved?.session?.status() || null; } catch { return null; } };
  const nativeOf = resolved => statusOf(resolved)?.nativeSessionId || resolved?.id || null;
  return Object.freeze({
    resolve(ref) {
      const resolved = resolveSession(ref);
      if (resolved) return nativeOf(resolved);
      return saved(ref) || null;
    },
    available: id => !!resolveSession(id) || !!saved(id),
    busy(id) {
      const status = statusOf(resolveSession(id));
      return !!status && (status.state === "running" || status.state === "interrupting" || !!status.compacting || !!status.working);
    },
    async deliver(id, item, payload, { jump = false } = {}) {
      if (item.speed === "ultrafast") return reject("speed_revalidation_required");
      const status = statusOf(resolveSession(id));
      if (jump && (item.speed === "fast" || status?.speed?.controlVerified) && ["running", "interrupting"].includes(status?.state)) return { kind: "unsupported" };
      const result = await send(id, payload.text, { images: payload.images, uuid: item.id, priority: "next", origin: { kind: "human" },
        speed: item.speed || "standard", speedFingerprint: item.speedFingerprint });
      if (result?.kind === "sent") return { kind: "accepted", confirmWithin };
      if (result?.code === "compaction_busy") return { kind: "busy" };
      return reject(result?.code || "claude_prompt_failed");
    },
    fromEvent(localId, event) {
      if (!["command_lifecycle", "result", "rate.turn.ended"].includes(event?.type) || event.parentToolUseId || event.isReplay === true) return null;
      const id = nativeOf(resolveSession(localId)) || localId;
      if (event.type === "command_lifecycle" && typeof event.command_uuid === "string") {
        const state = String(event.state || "");
        if (state === "started" || state === "completed") return { id, delivered: event.command_uuid };
        if (state === "queued") return { id, native: event.command_uuid };
        if (["cancelled", "discarded", "refused"].includes(state)) return { id, refused: event.command_uuid, code: `claude_${state}` };
        return null;
      }
      if (event.type === "result") {
        const failed = event.is_error === true || String(event.subtype || "").startsWith("error_");
        return { id, turnEnded: event.interrupted === true ? "stopped" : failed ? "failed" : "completed" };
      }
      if (event.type === "rate.turn.ended" && (!event.result || event.result.stopReason === "cancelled")) return { id, turnEnded: "stopped" };
      return null;
    },
  });
}

// Antigravity: the conversation id agy named, in the Host's bridge
// (server/antigravity-acp-bridge.js). The bridge takes a message at once and
// answers when its turn ends, so a message goes only between turns: agy's
// stream has nothing to put one into a turn under way.
function createAntigravityQueueDriver({ bridge, confirmWithin = 15_000 }) {
  const loaded = id => { try { return bridge.sessions().some(row => row.id === id && row.loaded !== false); } catch { return false; } };
  function busy(id) {
    try { return bridge.sessionWorking(id) || bridge.pendingPermissions().some(row => row.sessionId === id); } catch { return true; }
  }
  return Object.freeze({
    resolve: ref => typeof ref === "string" && THREAD.test(ref) && loaded(ref) ? ref : null,
    available: loaded,
    canJump: () => false,
    busy,
    async deliver(id, item, payload, { jump = false } = {}) {
      if (busy(id)) return { kind: jump ? "unsupported" : "busy" };
      const turn = bridge.prompt(id, payload.text, { images: payload.images, uuid: item.id });
      // Taken: the turn has started (its start names the message); the
      // answer comes when the turn ends.
      if (bridge.sessionWorking(id)) { void turn.catch(() => {}); return { kind: "accepted", confirmWithin }; }
      const result = await turn;
      return result?.kind === "reject" ? reject(result.code || "antigravity_prompt_failed") : { kind: "delivered" };
    },
    fromEvent(sessionId, event) {
      if (event?.type === "rate.turn.started" && typeof event.uuid === "string" && event.uuid) return { id: sessionId, delivered: event.uuid };
      if (event?.type === "rate.turn.ended") {
        return { id: sessionId, turnEnded: event.outcome === "stopped" ? "stopped" : event.outcome === "failed" ? "failed" : "completed" };
      }
      return null;
    },
  });
}

module.exports = { createPiQueueDriver, createCodexQueueDriver, createClaudeQueueDriver, createAntigravityQueueDriver };
