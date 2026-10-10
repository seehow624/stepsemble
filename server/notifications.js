"use strict";
const { randomUUID } = require("node:crypto");

// Recent lifecycle facts, not transcripts. Only explicit workspace members
// can cause an alert; a replay or subagent must not repeat a root task's alert.
function createNotifications({ entries, host, publish = () => {}, now = Date.now, quietCompletion = () => false }) {
  const boot = randomUUID(), runs = new Map(), recent = [];
  let sequence = 0;
  function entryFor(agent, id) {
    try { return entries().find(row => row.record.agentId === agent && !row.record.nativeHistoryReadonly &&
      [row.record.id, row.record.taskId, row.record.sid, row.record.nativeThreadId, row.record.nativeSessionId]
        .some(value => value === id || value === `${agent}:${id}`)); } catch { return null; }
  }
  function send(agent, id, kind, requestId = null) {
    const entry = entryFor(agent, id); if (!entry) return;
    const event = { id: `${boot}:${++sequence}`, host: host(), key: entry.key, agentId: agent, kind,
      title: String(entry.record.name || agent).replace(/[\r\n]/g, " ").slice(0, 120), at: now(), requestId };
    recent.push(event); if (recent.length > 128) recent.shift();
    try { publish(structuredClone(event)); } catch {}
    return event;
  }
  function observe(agent, id, event = {}) {
    if (!id || typeof id !== "string" || id.length > 512 || event.isReplay || event.parentToolUseId || event.parent_tool_use_id) return;
    const key = `${agent}:${id}`, type = event.type;
    if (["agent_start", "turn.started", "rate.turn.started"].includes(type)) {
      const prior = runs.get(key), turn = event.turnId || event.runId;
      if (prior?.active && (!turn || turn === prior.turn)) return;
      runs.delete(key); runs.set(key, { active: true, turn, outcome: "completed", requests: new Set() });
      while (runs.size > 512) runs.delete(runs.keys().next().value);
    }
    const run = runs.get(key);
    if (!run) return;
    if (agent === "codex" && event.turnId && run.turn && event.turnId !== run.turn) return;
    const requestId = String(event.requestId || event.request?.id || event.id || "approval").slice(0, 512);
    const approval = type === "approval.requested" || type === "permission_request"
      || type === "control_request" && event.request?.subtype === "can_use_tool"
      || type === "rate.permission" && !event.resolved
      || type === "extension_ui_request" && ["select", "confirm", "input", "editor"].includes(event.method);
    if (approval && run.active && !run.requests.has(requestId)) { run.requests.add(requestId); send(agent, id, "approval", requestId); }
    if (["approval.resolved", "rate.permission.resolved", "control_cancel_request", "extension_ui_closed"].includes(type) || type === "rate.permission" && event.resolved) {
      run.requests.delete(requestId);
      for (const row of recent) if (row.key === entryFor(agent, id)?.key && row.kind === "approval" && row.requestId === requestId) row.resolved = true;
    }
    if (agent === "pi" && type === "message_end" && event.message?.role === "assistant") {
      run.outcome = event.message.stopReason === "aborted" ? "stopped" : event.message.stopReason === "error" || event.message.errorMessage ? "failed" : "completed";
    }
    let outcome = null;
    if (agent === "pi" && type === "agent_settled") outcome = run.outcome;
    if (agent === "pi" && type === "rpc_exit") outcome = "failed";
    if (agent === "codex" && type === "turn.completed") outcome = event.status === "completed" ? "completed" : event.status === "interrupted" ? "stopped" : "failed";
    if (agent === "codex" && type === "turn.interrupted") outcome = "stopped";
    if (agent === "codex" && ["transport.failed", "thread.closed"].includes(type)) outcome = "failed";
    if (agent === "claude-code" && type === "result") outcome = event.interrupted ? "stopped" : event.is_error ? "failed" : "completed";
    if (type === "rate.turn.ended") {
      outcome = event.result?.stopReason === "cancelled" ? "stopped" : agent === "claude-code" ? "failed" : event.result ? "completed" : "failed";
    }
    if (outcome && run.active) {
      run.active = false;
      const entry = entryFor(agent, id);
      for (const row of recent) if (row.key === entry?.key && row.kind === "approval") row.resolved = true;
      if (!quietCompletion(entry?.key)) send(agent, id, outcome);
    }
  }
  function settled(task) { if (task?.id && ["completed", "failed", "stopped"].includes(task.status)) send(task.agentId, task.id, task.status); }
  function finished(run) {
    const entry = entries().find(row => row.key === run.entry);
    if (!entry || !["completed", "failed", "stopped", "limited", "blocked"].includes(run.status)) return;
    send(entry.record.agentId, entry.record.sid || entry.record.id || entry.record.taskId, run.status === "limited" ? "stopped" : run.status === "blocked" ? "blockedGoal" : run.status);
  }
  // Entry keys need no provider lookup. Removed memberships never open again.
  function snapshot(after) {
    const prefix = `${boot}:`, parsed = typeof after === "string" && after.startsWith(prefix) ? Number(after.slice(prefix.length)) : NaN;
    let keys; try { keys = new Set(entries().map(row => row.key)); } catch { keys = new Set(); }
    return { cursor: `${boot}:${sequence}`, events: Number.isSafeInteger(parsed) && parsed >= 0 && parsed <= sequence
      ? recent.filter(row => Number(row.id.slice(prefix.length)) > parsed && keys.has(row.key)).map(row => structuredClone(row)) : [] };
  }
  return { observe, settled, finished, read: snapshot };
}
module.exports = { createNotifications };
