"use strict";

// Measurements belong to the Host's agent connection, never to a browser.
// Only counts, durations and run identities are kept; no prompt/tool text.
const { randomUUID } = require("node:crypto");
const Rate = require("../public/modules/output-rate");
const Presentation = require("../public/modules/agent-transcript-presentation");
const { acpTurnOutput } = require("../public/modules/context-usage");

function manages(record) {
  return !!record && !record.nativeHistoryReadonly && (record.agentId === "pi" || record.nativeClaudeStructured
    || record.nativeCodex && record.mutation === "native_api" || record.nativeOpenCode || record.nativeAcp || record.nativeGrokAcp);
}

function createHostOutputRates({ store, entries, now = Date.now, onError = () => {} }) {
  const runs = new Map();
  const keyOf = (agent, id) => `${agent}:${id}`;
  function entryFor(agent, id) {
    try {
      return entries().find(row => row.record.agentId === agent && (row.record.sid === id || row.record.nativeThreadId === id
        || row.record.nativeSessionId === id || row.record.id === keyOf(agent, id) || row.record.taskId === keyOf(agent, id)))?.key || null;
    } catch (error) { onError(error); return null; }
  }
  function start(agent, id, runId = randomUUID(), at = now()) {
    const key = keyOf(agent, id), prior = runs.get(key);
    if (prior?.meter.endedAt === null || prior?.runId === runId) return prior;
    const run = { agent, id, runId, entry: entryFor(agent, id), meter: Rate.createMeter({ startedAt: at, liveAverage: agent === "codex" }),
      busy: new Set(), counts: new Map(), texts: new Map(), streamed: new Set(), messageId: null, totalBefore: null, total: prior?.total ?? null };
    runs.delete(key); runs.set(key, run);
    // Retain recent completed runs for late native usage, without retaining
    // an unbounded set of sessions on a long-running Host.
    if (runs.size > 512) for (const [oldKey, old] of runs) {
      if (old.meter.endedAt !== null) runs.delete(oldKey);
      if (runs.size <= 512) break;
    }
    return run;
  }
  function get(agent, id) { return runs.get(keyOf(agent, id)); }
  function sample(run, tokens = 0) { if (run) Rate.sample(run.meter, now(), { busy: run.busy.size > 0, tokens }); }
  function busy(run, id, active) {
    if (!run || !id) return;
    if (active) run.busy.add(String(id)); else run.busy.delete(String(id));
    sample(run);
  }
  function text(run, value, id = null, cumulative = false) {
    if (!run || typeof value !== "string") return;
    let count = Rate.estimateTokens(value);
    if (cumulative && id) {
      const previous = run.texts.get(id) || 0;
      run.texts.set(id, Math.max(previous, count));
      count = Math.max(0, count - previous);
    }
    sample(run, count);
  }
  function count(run, id, value) {
    if (!run || !(Number(value) >= 0)) return;
    run.counts.set(String(id), Math.max(run.counts.get(String(id)) || 0, Number(value)));
    Rate.reportTotal(run.meter, [...run.counts.values()].reduce((sum, n) => sum + n, 0));
  }
  function persist(run) {
    if (!run || run.meter.endedAt === null) return;
    const summary = Rate.summary(run.meter);
    if (!(summary.tokens > 0)) return;
    run.entry ||= entryFor(run.agent, run.id);
    if (!run.entry) return;
    try { store.recordHost(run.entry, { ...summary, startedAt: run.meter.startedAt, endedAt: run.meter.endedAt, runId: run.runId }); }
    catch (error) { onError(error); }
  }
  function end(agent, id, runId = null) {
    const run = get(agent, id);
    if (!run || runId && run.runId !== runId || run.meter.endedAt !== null) return;
    Rate.finish(run.meter, now()); persist(run);
  }
  function tool(run, value) { if (value?.id) busy(run, `tool:${value.id}`, value.running === true); }
  function pi(id, event) {
    if (event.type === "agent_start") start("pi", id);
    const run = get("pi", id);
    if (!run) return;
    if (event.type === "message_update") {
      const delta = event.assistantMessageEvent;
      if (["text_delta", "thinking_delta"].includes(delta?.type)) text(run, delta.delta);
    }
    if (event.type === "message_end" && event.message?.role === "assistant") Rate.report(run.meter, event.message.usage?.output);
    if (event.type === "tool_execution_start" || event.type === "tool_execution_end") busy(run, `tool:${event.toolCallId}`, event.type === "tool_execution_start");
    if (event.type === "extension_ui_request" && ["select", "confirm", "input", "editor"].includes(event.method)) busy(run, `ui:${event.id}`, true);
    if (event.type === "extension_ui_closed") busy(run, `ui:${event.id}`, false);
    if (["agent_settled", "rpc_exit"].includes(event.type)) end("pi", id);
  }
  function claude(id, event) {
    if (event.type === "rate.turn.started") start("claude-code", id, event.runId, event.at);
    const run = get("claude-code", id);
    if (!run || event.parentToolUseId || event.parent_tool_use_id || event.isReplay) return;
    if (event.type === "stream_event") {
      const value = event.event || {};
      if (value.type === "message_start") run.messageId = value.message?.id || randomUUID();
      if (value.type === "content_block_delta" && ["text_delta", "thinking_delta"].includes(value.delta?.type)) {
        run.streamed.add(run.messageId);
        text(run, value.delta.text || value.delta.thinking);
      }
      if (value.type === "message_delta") count(run, run.messageId, value.usage?.output_tokens);
    }
    if (event.type === "assistant") {
      const message = event.message || {};
      count(run, message.id || run.messageId, message.usage?.output_tokens);
      if (!run.streamed.has(message.id || run.messageId)) text(run, (message.content || []).filter(b => ["text", "thinking"].includes(b.type)).map(b => b.text || b.thinking || "").join(""), message.id, true);
    }
    // A streamed tool_use block is still the model writing its arguments.
    // Execution begins once Claude emits the completed assistant message.
    if (event.type !== "stream_event") for (const activity of Presentation.claudeEvent(event)) if (activity.kind === "tool") tool(run, activity.tool);
    if (event.type === "control_request" && event.request?.subtype === "can_use_tool" || event.type === "permission_request") busy(run, `ui:${event.requestId}`, true);
    if (["rate.permission.resolved", "control_cancel_request"].includes(event.type)) busy(run, `ui:${event.requestId}`, false);
    if (event.type === "result") { Rate.reportTotal(run.meter, event.usage?.output_tokens); end("claude-code", id); }
    if (event.type === "rate.turn.ended") end("claude-code", id);
  }
  function acp(agent, event) {
    const id = event.sessionId;
    if (event.type === "rate.turn.started") start(agent, id, event.runId);
    const run = get(agent, id);
    if (!run) return;
    if (event.type === "session.update") {
      const activity = Presentation.acpUpdate(event.update);
      if (["message_delta", "thinking_delta"].includes(activity?.kind)) text(run, activity.text);
      if (activity?.kind === "tool") tool(run, activity.tool);
    }
    if (event.type === "rate.permission") busy(run, `ui:${event.requestId}`, !event.resolved);
    if (event.type === "rate.turn.ended") {
      Rate.reportTotal(run.meter, acpTurnOutput(event.result, { agentId: agent }));
      end(agent, id);
    }
  }
  function codex(event) {
    const id = event.threadId || event.request?.threadId, turnId = event.turnId || event.request?.turnId;
    if (!id) return;
    if (event.type === "turn.started") start("codex", id, turnId);
    const run = get("codex", id);
    if (!run || turnId && run.runId !== turnId) return;
    if (event.type === "thread.tokenUsage.updated") {
      const total = event.tokenUsage?.total?.outputTokens, last = event.tokenUsage?.last?.outputTokens;
      if (Number.isSafeInteger(total) && total >= 0) {
        run.totalBefore ??= run.total !== null && run.total <= total ? run.total : Math.max(0, total - (Number.isSafeInteger(last) ? last : total));
        run.total = Math.max(total, run.total || 0);
        Rate.reportTotal(run.meter, run.total - run.totalBefore);
        persist(run);
      }
    }
    if (["item.started", "item.completed"].includes(event.type) && ["commandExecution", "fileChange", "mcpToolCall", "dynamicToolCall", "webSearch", "imageGeneration", "collabAgentToolCall"].includes(event.itemType)) busy(run, `tool:${event.itemId}`, event.type === "item.started");
    if (event.type === "approval.requested") busy(run, `ui:${event.request?.requestId ?? event.request?.id}`, true);
    if (event.type === "approval.resolved") busy(run, `ui:${event.requestId}`, false);
    if (["turn.completed", "turn.interrupted", "transport.failed", "thread.closed", "thread/closed", "thread/archived"].includes(event.type)) end("codex", id, turnId);
  }
  // OpenCode has an HTTP snapshot API. The Host polls only sessions it sent
  // work to, until they settle; a missing page never owns this lifecycle.
  function openCode(id, snapshot, runId) {
    const run = get("opencode", id);
    if (!run || run.runId !== runId || run.meter.endedAt !== null) return false;
    let output = false, pendingReply = false;
    const busyIds = new Set((snapshot.permissions || []).map(row => `ui:${row.id}`));
    for (const message of snapshot.messages || []) {
      const info = message.info || message;
      if (info.role !== "assistant" || run.knownReplies?.has(info.id)) continue;
      output = true;
      if (!info.time?.completed) pendingReply = true;
      count(run, info.id, (Number(info.tokens?.output) || 0) + (Number(info.tokens?.reasoning) || 0));
      for (const [index, part] of (message.parts || []).entries()) {
        if (["text", "reasoning"].includes(part.type)) text(run, part.text, `${info.id}:${part.id || index}`, true);
        if (part.type === "tool" && ["pending", "running"].includes(part.state?.status)) busyIds.add(`tool:${part.callID || part.id}`);
      }
    }
    run.busy = busyIds; sample(run);
    const status = snapshot.status?.type || "idle";
    if (status !== "idle") run.sawBusy = true;
    if (!run.sending && status === "idle" && !pendingReply && !busyIds.size && (output || run.sawBusy)) end("opencode", id, runId);
    return run.meter.endedAt === null;
  }
  async function sendOpenCode(adapter, id, message, options) {
    if (options.noReply || get("opencode", id)?.meter.endedAt === null) return adapter.sendMessage(id, message, options);
    // The baseline excludes prior replies, even when the new reply finishes
    // between two snapshots. A failed baseline must not block sending work.
    let baseline;
    try { baseline = await adapter.messages(id, { directory: options.directory }); }
    catch { return adapter.sendMessage(id, message, options); }
    const run = start("opencode", id);
    run.knownReplies = new Set(baseline.messages.map(row => (row.info || row).id));
    run.sending = true;
    const poll = async () => {
      if (run.meter.endedAt !== null || get("opencode", id) !== run) return;
      try {
        const [page, statuses, permissionPage] = await Promise.all([adapter.messages(id, { directory: options.directory }),
          adapter.sessionStatus({ directory: options.directory }), adapter.permissions({ sessionId: id, directory: options.directory })]);
        openCode(id, { messages: page.messages, status: statuses[id], permissions: permissionPage.permissions }, run.runId);
      } catch { /* A temporary disconnection is not the end of the run. */ }
      if (run.meter.endedAt === null && now() - run.meter.startedAt < 6 * 60 * 60 * 1000) setTimeout(poll, 1000).unref?.();
      else if (run.meter.endedAt === null) runs.delete(keyOf("opencode", id));
    };
    void poll();
    try { return await adapter.sendMessage(id, message, options); }
    catch (error) {
      // HTTP failure can be an uncertain send. Continue observing the native
      // session; never retry the user's mutation from the meter.
      throw error;
    } finally { run.sending = false; }
  }
  function read(entry) {
    const record = entries().find(row => row.key === entry)?.record;
    const run = [...runs.values()].find(row => row.entry === entry && row.meter.endedAt === null);
    const at = now();
    return { ...store.read(entry), hostTracked: !!manages(record), active: run ? { startedAt: run.meter.startedAt, observedAt: at,
      liveRate: Rate.liveRate(run.meter, at), estimated: !run.meter.liveAverage || !(run.meter.reported > 0), liveAverage: run.meter.liveAverage } : null };
  }
  return { start, end, get, pi, claude, acp, codex, openCode, sendOpenCode, read, manages };
}

module.exports = { createHostOutputRates, manages };
