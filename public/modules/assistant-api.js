(function (root) {
  "use strict";

  // The assistant page's only door to Stepsemble: fetch with the sign-in
  // cookie, routed to the computer that runs Hermes ("" for this one,
  // /r/<id> through the device relay for another), plus the event stream.

  class ApiError extends Error {
    constructor(status, code, message) { super(message || code); this.name = "ApiError"; this.status = status; this.code = code; }
  }

  async function request(base, path, { method = "GET", body, signal, onSignedOut } = {}) {
    let response;
    try {
      response = await fetch(base + path, { method, credentials: "same-origin", cache: "no-store", signal,
        headers: body === undefined ? {} : { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    } catch (error) { throw new ApiError(0, "network_error", error?.message || "Network error"); }
    let data = null;
    try { data = await response.json(); } catch {}
    const code = typeof data?.error === "string" ? data.error : "";
    if (response.status === 401 && !code.startsWith("hermes_")) {
      onSignedOut?.();
      throw new ApiError(401, "stepsemble_signed_out", "Sign in to Stepsemble again");
    }
    if (!response.ok) throw new ApiError(response.status, code || "request_failed", typeof data?.message === "string" && data.message ? data.message : `HTTP ${response.status}`);
    return data;
  }

  async function machines({ onSignedOut } = {}) {
    const data = await request("", "/api/machines", { onSignedOut });
    const list = Array.isArray(data?.machines) ? data.machines : [];
    const self = data?.current || data?.selfId || list.find(machine => machine?.self)?.id;
    return list.filter(machine => machine && typeof machine.id === "string").map(machine => ({
      id: machine.id, name: machine.name || machine.id, self: machine.id === self,
      base: machine.id === self ? "" : `/r/${encodeURIComponent(machine.id)}` }));
  }

  function create({ base = "", onSignedOut } = {}) {
    const call = (path, options = {}) => request(base, path, { ...options, onSignedOut });
    const post = (path, body = {}) => call(path, { method: "POST", body });
    function status() {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 8000);
      return call("/api/assistant/status", { signal: controller.signal }).finally(() => clearTimeout(timer));
    }
    function stream({ after = 0, onEvent, onState } = {}) {
      let source = null, closed = false, last = after, retry = 0;
      const open = () => {
        if (closed) return;
        source = new EventSource(`${base}/api/assistant/stream?after=${last}`);
        source.onopen = () => onState?.("open");
        source.onmessage = message => {
          let event;
          try { event = JSON.parse(message.data); } catch { return; }
          if (Number.isSafeInteger(event?.id) && event.id > last) last = event.id;
          onEvent?.(event);
        };
        source.onerror = () => {
          onState?.("error");
          // EventSource retries a dropped stream by itself; a refused one
          // (for example after Stepsemble signed out) is closed for good.
          if (source.readyState === 2 && !closed) { clearTimeout(retry); retry = setTimeout(open, 3000); }
        };
      };
      open();
      return { close() { closed = true; clearTimeout(retry); source?.close(); }, get last() { return last; } };
    }
    return Object.freeze({
      base, status, stream,
      login: (username, password) => post("/api/assistant/login", { username, password }),
      logout: () => post("/api/assistant/logout"),
      bots: () => call("/api/assistant/bots"),
      botChat: profile => post("/api/assistant/bot-chat", { profile }),
      openSession: (sessionId, profile) => post("/api/assistant/session/open", { sessionId, profile }),
      sessions: (profile, q = "", offset = 0) => call(`/api/assistant/sessions?${new URLSearchParams({ profile, q, offset: String(offset) })}`),
      rename: (sessionId, profile, title) => post("/api/assistant/session/rename", { sessionId, profile, title }),
      remove: (sessionId, profile) => post("/api/assistant/session/delete", { sessionId, profile }),
      read: (sessionId, profile) => post("/api/assistant/session/read", { sessionId, profile }),
      prompt: (sessionId, text, attachments = []) => post("/api/assistant/prompt", { sessionId, text, attachments }),
      interrupt: sessionId => post("/api/assistant/interrupt", { sessionId }),
      asks: () => call("/api/assistant/asks"),
      respond: (id, answer) => post("/api/assistant/respond", { id, answer }),
      watch: (clientId, sessionId) => post("/api/assistant/watch", { clientId, sessionId }),
      routines: profile => call(`/api/assistant/routines${profile ? `?${new URLSearchParams({ profile })}` : ""}`),
      routineTargets: profile => call(`/api/assistant/routines/targets?${new URLSearchParams({ profile })}`),
      routineRuns: (id, profile) => call(`/api/assistant/routines/runs?${new URLSearchParams({ id, profile })}`),
      createRoutine: (profile, fields) => post("/api/assistant/routines/create", { profile, fields }),
      updateRoutine: (id, profile, fields) => post("/api/assistant/routines/update", { id, profile, fields }),
      pauseRoutine: (id, profile) => post("/api/assistant/routines/pause", { id, profile }),
      resumeRoutine: (id, profile) => post("/api/assistant/routines/resume", { id, profile }),
      runRoutine: (id, profile) => post("/api/assistant/routines/run", { id, profile }),
      deleteRoutine: (id, profile) => post("/api/assistant/routines/delete", { id, profile }),
      groups: () => call("/api/assistant/groups"),
      createGroup: (name, members) => post("/api/assistant/groups/create", { name, members }),
      groupLog: (room, since) => call(`/api/assistant/groups/log?${new URLSearchParams({ room, since: String(since) })}`),
      groupState: room => call(`/api/assistant/groups/state?${new URLSearchParams({ room })}`),
      groupSend: (room, text) => post("/api/assistant/groups/send", { room, text }),
      groupApprove: (room, approval, choice) => post("/api/assistant/groups/approve", { room, ...approval, choice }),
      groupRetry: (room, taskId) => post("/api/assistant/groups/retry", { room, taskId }),
      groupRename: (room, name) => post("/api/assistant/groups/rename", { room, name }),
      groupStop: room => post("/api/assistant/groups/stop", { room }),
      groupDisband: room => post("/api/assistant/groups/disband", { room }),
    });
  }

  root.StepsembleAssistantApi = Object.freeze({ create, machines, ApiError });
})(window);
