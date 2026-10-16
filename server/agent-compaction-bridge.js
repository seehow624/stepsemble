"use strict";

// Each path delegates to its own native operation. The bridge never makes a
// replacement summary, swaps the model or opens a different conversation.
const unavailable = reason => ({ supported: false, instructions: false, reason, busy: false });
const failure = (code, statusCode = 409) => Object.assign(new Error(code), { code, statusCode });
const acpAgents = new Set(["cline", "kilo", "omp", "grok-build"]);
function nativeId(record) {
  if (record.agentId === "pi") return record.sid;
  if (record.agentId === "claude-code") return String(record.id || record.taskId || record.nativeSessionId || "").replace(/^claude-code:/, "");
  return record.nativeThreadId || record.nativeSessionId;
}
function accepted(result) {
  if (result?.kind === "reject") throw failure(result.code || "compaction_failed");
  return result;
}
function createCompactionBridge({ pi, claude, codex, openCode, acp, working = async () => false, choice = () => null }) {
  async function describe(record) {
    const agent = record.agentId, id = nativeId(record);
    if (agent === "hermes") return unavailable("compaction_excluded");
    if (agent === "antigravity") return unavailable("compaction_native_unavailable");
    if (agent === "pi") {
      const session = id && pi.session(id);
      if (!session || session.exited || session.protocolFailed) return unavailable("compaction_not_connected");
      return { supported: true, instructions: true, reason: null, busy: pi.busy(id) || await working(record) };
    }
    if (agent === "claude-code") {
      if (!record.nativeClaudeStructured) return unavailable("compaction_terminal_only");
      const session = claude(id)?.session, state = session?.status();
      if (!session || state.closed || state.failed || typeof session.compact !== "function") return unavailable("compaction_not_connected");
      return { supported: true, instructions: true, reason: null,
        busy: state.state !== "waiting" || state.compacting === true || session.pendingPermissions().length > 0 || await working(record) };
    }
    if (agent === "codex") {
      if (!record.nativeCodex || record.mutation !== "native_api") return unavailable("compaction_terminal_only");
      if (!codex.status().mutationReady || typeof codex.compactThread !== "function") return unavailable("compaction_native_unavailable");
      const state = codex.nativeState(id);
      if (state.threadId && state.threadId !== id) return unavailable("compaction_conversation_changed");
      return { supported: true, instructions: false, reason: null, busy: !!state.turnId || state.compacting === true
        || ["reconciliation_required", "initializing", "starting"].includes(state.state) || codex.pendingApprovals(id).length > 0 || await working(record) };
    }
    if (agent === "opencode") {
      if (!record.nativeOpenCode) return unavailable("compaction_terminal_only");
      if (!id || !openCode.status().ready || typeof openCode.compact !== "function") return unavailable("compaction_not_connected");
      const [states, pending] = await Promise.all([openCode.sessionStatus({ directory: record.cwd }), openCode.permissions({ sessionId: id, directory: record.cwd })]);
      if (pending.supported === false) return unavailable("compaction_native_unavailable");
      return { supported: true, instructions: false, reason: null, busy: ["busy", "retry"].includes(states[id]?.type) || pending.permissions.length > 0 || await working(record) };
    }
    if (acpAgents.has(agent)) {
      if (!record.nativeAcp && !record.nativeGrokAcp) return unavailable("compaction_terminal_only");
      const adapter = acp(agent), capability = adapter?.compactionSupport?.(id);
      if (!capability?.supported) return unavailable(capability?.reason || "compaction_native_unavailable");
      return { ...capability, busy: capability.busy === true || await working(record) };
    }
    return unavailable("compaction_unavailable");
  }
  async function run(record, { instructions = "" } = {}) {
    const capability = await describe(record);
    if (!capability.supported) throw failure(capability.reason || "compaction_unavailable");
    if (capability.busy) throw failure("compaction_busy");
    if (instructions && !capability.instructions) throw failure("compaction_instructions_unavailable", 400);
    const agent = record.agentId, id = nativeId(record);
    if (agent === "pi") {
      const result = await pi.command(id, { type: "compact", ...(instructions ? { customInstructions: instructions } : {}) });
      if (result?.success !== true) throw failure("compaction_native_failed");
      const data = result.data || {};
      return { completed: true, ...(Number.isSafeInteger(data.tokensBefore) && data.tokensBefore >= 0 ? { beforeTokens: data.tokensBefore } : {}),
        ...(Number.isSafeInteger(data.estimatedTokensAfter) && data.estimatedTokensAfter >= 0 ? { afterTokens: data.estimatedTokensAfter, estimated: true } : {}) };
    }
    if (agent === "claude-code") return accepted(await claude(id).session.compact({ instructions }));
    if (agent === "codex") {
      if (!codex.nativeState(id).threadId) accepted(await codex.resumeThread({ threadId: id }));
      return accepted(await codex.compactThread(id));
    }
    if (agent === "opencode") {
      const model = choice(agent, id)?.model, slash = typeof model === "string" ? model.indexOf("/") : -1;
      const selected = slash > 0 ? { providerID: model.slice(0, slash), modelID: model.slice(slash + 1) } : null;
      return accepted(await openCode.compact(id, { directory: record.cwd, ...(selected ? { model: selected } : {}) }));
    }
    if (acpAgents.has(agent)) return accepted(await acp(agent).compact(id, { instructions }));
    throw failure("compaction_unavailable");
  }
  return { describe, run };
}
module.exports = { createCompactionBridge, nativeId };
