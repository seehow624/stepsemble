"use strict";
// Observe only model replies and native lifecycle events, never tool output.
function createWorkflowEvents({ onEvent = () => {} } = {}) {
  const pending = new Map();
  const key = (agent, id) => `${agent}:${id}`;
  const textOf = content => typeof content === "string" ? content : (content || []).filter(b => b.type === "text").map(b => b.text || "").join("\n");
  function observe(agent, id, activity) {
    const k = key(agent, id); if (pending.has(k)) throw new Error("Conversation already has a running Goal");
    let resolve;
    const promise = new Promise(r => { resolve = r; });
    const row = { text: "", error: null, activity, promise, turnId: null, ended: false,
      finish(error = null) { if (row.ended) return; row.ended = true; if (pending.get(k) === row) pending.delete(k); resolve({ text: row.text, error: error || row.error }); } };
    pending.set(k, row); return row;
  }
  function emit(agent, id, event) {
    if (!id) return;
    try { onEvent(agent, id, event); } catch {}
    const row = pending.get(key(agent, id)); if (!row) return;
    const append = value => { if (typeof value === "string") row.text = (row.text + value).slice(-32000); };
    const activity = (value, waiting = false) => row.activity({ text: value, waiting });
    const e = event || {};
    if (agent === "pi") {
      if (e.type === "message_end" && e.message?.role === "assistant") {
        row.text = textOf(e.message.content).slice(-32000);
        if (["error", "aborted"].includes(e.message.stopReason)) row.error = e.message.errorMessage || e.message.stopReason;
      }
      if (e.type === "tool_execution_start") activity(e.toolName || "tool");
      if (e.type === "tool_execution_end" || e.type === "extension_ui_closed") activity("thinking");
      if (e.type === "extension_ui_request" && ["select","confirm","input","editor"].includes(e.method)) activity("approval", true);
      if (e.type === "response" && e.command === "prompt" && e.success === false) row.finish(e.error || "Pi rejected the prompt");
      if (e.type === "agent_settled") row.finish();
      if (e.type === "rpc_exit") row.finish("Pi process exited");
    } else if (agent === "codex") {
      if (e.type === "turn.started") row.turnId = e.turnId;
      if (row.turnId && e.turnId && row.turnId !== e.turnId) return;
      if (e.type === "item.completed" && e.itemType === "agentMessage") row.text = String(e.text || "").slice(-32000);
      if (e.type === "item.started") activity(e.itemType || "thinking");
      if (e.type === "approval.requested") activity("approval", true);
      if (e.type === "approval.resolved") activity("thinking");
      if (e.type === "turn.completed") row.finish(e.status === "completed" ? null : `Codex turn ${e.status}`);
      if (["turn.interrupted", "transport.failed", "thread.closed"].includes(e.type)) row.finish(e.code || e.type);
    } else if (agent === "claude-code") {
      if (e.parentToolUseId || e.parent_tool_use_id || e.isReplay) return;
      if (e.type === "assistant") {
        row.text = textOf(e.message?.content).slice(-32000);
        const tool = e.message?.content?.find(b => b.type === "tool_use"); if (tool) activity(tool.name || "tool");
      }
      if (e.type === "control_request" || e.type === "permission_request") activity("approval", true);
      if (e.type === "rate.permission.resolved") activity("thinking");
      if (e.type === "result") { if (typeof e.result === "string") row.text = e.result.slice(-32000); row.finish(e.is_error ? e.errors?.join("\n") || e.result || "Claude Code failed" : null); }
      if (e.type === "rate.turn.ended") row.finish("Claude Code ended without a final result");
    } else {
      if (e.type === "rate.permission") activity(e.resolved ? "thinking" : "approval", !e.resolved);
      const u = e.update;
      if (e.type === "session.update" && u) {
        if (u.sessionUpdate === "agent_message_chunk" && u.content?.type === "text") append(u.content.text);
        if (["tool_call", "tool_call_update"].includes(u.sessionUpdate)) activity(u.status === "completed" ? "thinking" : u.title || "tool");
      }
      // ACP completes through the prompt promise, which includes failures.
    }
  }
  return { observe, emit, finish(agent, id, error) { pending.get(key(agent, id))?.finish(error); } };
}
module.exports = { createWorkflowEvents };
