/* Pi retry presentation only. Never schedules work or changes the raw errors. */
(function (root) {
  "use strict";
  const failed = m => !!m && (!m.role || m.role === "assistant") &&
    (m.stopReason === "error" || m.stopReason === "aborted" || !!String(m.errorMessage || "").trim());
  function create(owner) {
    return { owner, closed: false, attempt: 0, retry: 0, continuing: false,
      successSignal: false, successfulReply: false, limitedReply: false, failures: [], lastFailure: null, messageKey: null, messages: new Map() };
  }
  const key = m => m?.id || m?.timestamp || m?.ts || null;
  function update(state, event, owner) {
    if (!state || state.owner !== owner || state.closed) return false;
    const m = event.type === "agent_end" ? event.messages?.findLast(m => m?.role === "assistant") : event.message;
    // Message snapshots can arrive after a replacement attempt has started.
    if (m?.role === "assistant" && key(m)) {
      if (state.messages.has(key(m)) && state.messages.get(key(m)) < state.attempt) return false;
      if (["message_end", "turn_end", "agent_end"].includes(event.type) && state.messageKey && key(m) !== state.messageKey) return false;
      if (event.type === "message_end" && state.messages.has(key(m))) return false;
    }
    switch (event.type) {
      case "agent_start":
        state.attempt++;
        state.messageKey = null;
        state.successfulReply = false;
        state.limitedReply = false;
        break;
      case "message_start":
        if (m?.role === "assistant") state.messageKey = key(m);
        break;
      case "message_end":
        if (m?.role !== "assistant") break;
        if (key(m)) state.messages.set(key(m), state.attempt);
        if (failed(m)) {
          state.lastFailure = m;
          state.successfulReply = false;
          state.limitedReply = false;
          state.successSignal = false;
          state.failures.push({ message: m, attempt: state.attempt, status: m.stopReason === "aborted" ? "stopped" : "interrupted" });
        } else {
          state.limitedReply = m.stopReason === "length";
          state.successfulReply = !state.limitedReply;
        }
        break;
      case "agent_end":
        if (!event.willRetry && failed(m)) {
          state.continuing = false;
          if (!state.cancelled) state.lastFailure = m;
          for (const record of state.failures) if (record.status === "interrupted") record.status = state.lastFailure?.stopReason === "aborted" ? "stopped" : "failed";
        }
        break;
      case "auto_retry_start":
        if (state.lastFailure?.stopReason === "aborted") return false;
        if (Number(event.attempt) < state.retry) return false;
        state.retry = Number(event.attempt) || 1;
        state.continuing = true;
        state.successSignal = false;
        state.successfulReply = false;
        state.limitedReply = false;
        break;
      case "auto_retry_end":
        if (!state.continuing || (event.attempt && Number(event.attempt) !== state.retry)) return false;
        if (event.success === true) state.successSignal = true;
        else if (event.success === false) {
          state.continuing = false;
          const stopped = event.finalError === "Retry cancelled" || state.lastFailure?.stopReason === "aborted";
          state.cancelled = stopped;
          state.lastFailure = stopped ? { ...state.lastFailure, stopReason: "aborted" } : state.lastFailure;
          for (const record of state.failures) if (record.status === "interrupted") record.status = stopped ? "stopped" : "failed";
        } else return false;
        break;
      case "agent_settled":
      case "rpc_exit":
        state.closed = true;
        state.continuing = false;
        break;
    }
    // Require Pi's explicit success plus this episode's non-error reply.
    // A length-limited reply clears the stale transport failure, but cannot
    // prove full recovery: keep the earlier interruption historical/unknown.
    if (state.continuing && state.successSignal && (state.successfulReply || state.limitedReply)) {
      const status = state.successfulReply ? "recovered" : "historical";
      for (const record of state.failures) if (record.status === "interrupted") record.status = status;
      state.lastFailure = null;
      state.continuing = false;
      state.successSignal = false;
      state.retry = 0;
    }
    return true;
  }
  // Null context edits are not proof of retry or success. Latest active-path
  // edits win; callers supply the selected branch, never the whole file.
  function omittedIds(entries) {
    const edits = new Map();
    for (const entry of entries) if (entry.type === "context_edit") edits.set(entry.targetId, entry.replacement === null);
    return new Set(entries.filter(e => e.type === "message" && e.message?.role === "assistant" && failed(e.message) && edits.get(e.id) === true).map(e => e.id));
  }
  const api = { create, update, failed, omittedIds };
  if (typeof module !== "undefined") module.exports = api;
  else root.StepsemblePiRecovery = api;
})(typeof window !== "undefined" ? window : globalThis);
