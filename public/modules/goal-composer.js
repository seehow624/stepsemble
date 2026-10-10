/* Inline Goal drafts and progress, owned by the current conversation's Host. */
(function (root, factory) {
  const api = factory(root);
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.StepsembleGoalComposer = api;
})(typeof window !== "undefined" ? window : globalThis, function (root) {
  "use strict";
  const ACTIVE = new Set(["queued", "starting", "running", "waiting", "stopping"]);
  const RESUMABLE = new Set(["paused", "blocked", "interrupted"]);
  const AGENTS = new Set(["pi", "codex", "claude-code", "opencode", "omp", "cline", "kilo", "hermes", "grok-build"]);
  function requestId() {
    if (root.crypto.randomUUID) return root.crypto.randomUUID();
    // Phones may access their Host over HTTP on a private network, where
    // randomUUID is unavailable but getRandomValues is still supported.
    const bytes = root.crypto.getRandomValues(new Uint8Array(16));
    bytes[6] = bytes[6] & 15 | 64; bytes[8] = bytes[8] & 63 | 128;
    const hex = Array.from(bytes, b => b.toString(16).padStart(2, "0")).join("");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }
  function parse(text) {
    if (typeof text !== "string") return null;
    const match = text.trimStart().match(/^\/goal(?:\s+([\s\S]*))?$/i);
    return match ? { objective: (match[1] || "").trim() } : null;
  }
  function createRequest({ entry, text, limits, title, requestId }) {
    const command = parse(text);
    if (!command?.objective || command.objective.length > 16000) throw new Error("objective");
    for (const [key, min, max] of [["minutes", 1, 1440], ["turns", 1, 100], ["outputTokens", 100, 10000000]]) {
      if (!Number.isSafeInteger(limits?.[key]) || limits[key] < min || limits[key] > max) throw new Error("limits");
    }
    const name = String(title || "").trim() || command.objective.split("\n")[0];
    return { kind: "goal", mode: "goal", entry, objective: command.objective,
      title: name.slice(0, 120), limits: { ...limits }, requestId };
  }
  function mount({ api, post, getConnection, getAgentId, getContext, onStarted, onChanged = () => {} }) {
    const document = root.document;
    const entry = new URLSearchParams(root.location.search).get("entry");
    const input = document.getElementById("input"), inner = document.querySelector(".composer-inner");
    if (!entry || !input || !inner) return null;
    const t = (key, vars) => root.stepsembleI18n.tKey("goalComposer." + key, vars);
    const localized = [];
    const node = (tag, cls = "", content = "") => { const n = document.createElement(tag); n.className = cls; n.textContent = content; return n; };
    const button = (label, fn, cls = "") => { const b = node("button", "btn ghost " + cls, label); b.type = "button"; b.addEventListener("click", fn); return b; };
    const section = node("section", "goal-composer"); section.hidden = true; section.dataset.i18nIgnore = ""; section.setAttribute("aria-label", "Goal");
    const draft = node("div", "goal-draft"), live = node("div", "goal-live");
    const draftHead = node("div", "goal-head"), draftLabel = node("strong", "goal-label", "◎ Goal"), ready = node("span", "goal-state");
    const cancel = button("×", () => { if (creating) return; input.value = parse(input.value)?.objective || ""; input.dispatchEvent(new root.Event("input", { bubbles: true })); input.focus(); }, "goal-dismiss");
    cancel.setAttribute("aria-label", t("cancel")); cancel.title = t("cancel"); draftHead.append(draftLabel, ready, cancel);
    const preview = node("p", "goal-objective");
    const fields = node("div", "goal-draft-controls");
    function field(parent, name, value, min, max) {
      const label = node("label", "goal-field"), span = node("span", "", t(name));
      localized.push([span, name]);
      const n = node("input"); n.type = "number"; n.min = min; n.max = max; n.step = "1"; n.value = value; n.name = name;
      label.append(span, n); parent.append(label); return n;
    }
    const minutes = field(fields, "minutes", 60, 1, 1440), tokens = field(fields, "tokens", 100000, 100, 10000000);
    const more = node("details", "goal-more"), moreLabel = node("summary", "", t("more")), advanced = node("div", "goal-advanced");
    const turns = field(advanced, "turns", 20, 1, 100);
    const titleLabel = node("label", "goal-field"), title = node("input"); title.type = "text"; title.maxLength = 120;
    const titleText = node("span", "", t("name")); localized.push([titleText, "name"]);
    titleLabel.append(titleText, title); advanced.append(titleLabel); more.append(moreLabel, advanced); fields.append(more);
    draft.append(draftHead, preview, fields);
    const liveHead = node("div", "goal-head"), liveLabel = node("strong", "goal-label", "◎ Goal"), status = node("span", "goal-state");
    const actions = node("div", "goal-actions"), clock = node("span", "goal-clock");
    const pause = button(t("pause"), () => action("pause"));
    const resume = button(t("resume"), () => action("resume"));
    const stop = button(t("stop"), () => action("stop"));
    actions.append(pause, resume, stop); liveHead.append(liveLabel, status, clock, actions);
    const objective = node("p", "goal-objective"), activity = node("p", "goal-activity"); activity.setAttribute("role", "status");
    const details = node("details", "goal-run-details"), detailLabel = node("summary", "", t("details")), metrics = node("p", "goal-metrics"), result = node("pre", "goal-result");
    details.append(detailLabel, metrics, result); live.append(liveHead, objective, activity, details);
    localized.push([moreLabel, "more"], [detailLabel, "details"], [pause, "pause"], [resume, "resume"], [stop, "stop"]);
    const error = node("p", "goal-error"); error.hidden = true; error.setAttribute("role", "alert");
    section.append(draft, live, error); inner.before(section);
    let latest = null, received = 0, loading = false, disconnected = false, creating = false, acting = false, closed = false, attempt = null, revision = 0;
    const supports = () => { const c = getConnection(); return !!c && AGENTS.has(getAgentId()) && !c.readOnly && !c.nativeHistoryReadonly; };
    const current = context => !closed && context === getContext();
    function showError(key, detail = null) { error.textContent = detail || t(key); error.hidden = false; }
    const elapsedMs = () => (latest?.elapsedMs || 0) + (!disconnected && ["starting", "running", "waiting"].includes(latest?.status) ? Math.max(0, Date.now() - received) : 0);
    function elapsed() {
      if (!latest) return;
      const ms = elapsedMs();
      const s = Math.floor(ms / 1000), time = `${Math.floor(s / 3600) ? Math.floor(s / 3600) + ":" : ""}${String(Math.floor(s / 60) % 60).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
      clock.textContent = t("elapsed", { time });
    }
    function accept(run, text) {
      latest = run; received = Date.now(); disconnected = false; attempt = null; revision++;
      if (input.value === text) { title.value = ""; more.open = false; }
      onStarted(text); onChanged();
    }
    function render() {
      if (closed) return;
      for (const [n, key] of localized) { const label = t(key); if (n.textContent !== label) n.textContent = label; }
      cancel.setAttribute("aria-label", t("cancel")); cancel.title = t("cancel");
      const command = parse(input.value), draftVisible = !!command && !ACTIVE.has(latest?.status);
      section.hidden = !command && !latest; draft.hidden = !draftVisible; live.hidden = draftVisible || !latest;
      if (draftVisible) {
        section.dataset.state = creating ? "starting" : "draft";
        ready.textContent = creating ? t("starting") : t("ready"); preview.textContent = command.objective || t("hint");
        for (const n of [minutes, tokens, turns, title, cancel]) n.disabled = creating;
      }
      if (!latest || draftVisible) return;
      section.dataset.state = latest.status; status.textContent = t("state." + latest.status); elapsed();
      objective.textContent = latest.objective;
      const activityKey = ["thinking", "approval", "queued", "starting", "waiting"].includes(latest.activity) ? "state." + latest.activity : null;
      const currentActivity = activityKey ? t(activityKey) : latest.activity || t("state." + latest.status);
      const activityText = disconnected ? t("disconnected") : latest.error || (ACTIVE.has(latest.status) ? currentActivity : latest.result?.slice(0, 180) || t("state." + latest.status));
      if (activity.textContent !== activityText) activity.textContent = activityText;
      pause.hidden = !ACTIVE.has(latest.status) || latest.status === "stopping";
      resume.hidden = !RESUMABLE.has(latest.status);
      stop.hidden = !(ACTIVE.has(latest.status) || RESUMABLE.has(latest.status)) || latest.status === "stopping" && !latest.error;
      for (const b of [pause, resume, stop]) b.disabled = acting;
      metrics.textContent = t("metrics", { turns: latest.turns, tokens: (latest.outputTokens || 0).toLocaleString(root.document.documentElement.lang) });
      result.textContent = latest.result || latest.objective;
    }
    async function refresh() {
      if (closed || loading || document.hidden) return;
      loading = true; const context = getContext(), requestedRevision = revision;
      try {
        const data = await api("/api/workflows?entry=" + encodeURIComponent(entry));
        if (!current(context) || revision !== requestedRevision) return;
        latest = [...(data.runs || [])].reverse().find(r => r.entry === entry) || null; received = Date.now(); disconnected = false;
        // A lost POST response can still have started the Goal. Its saved
        // request ID is an acknowledgement, so recover without another write.
        if (attempt && attempt.context === context && latest?.requestId === attempt.requestId) accept(latest, attempt.text);
        render();
      } catch { if (current(context) && revision === requestedRevision) { if (latest) latest.elapsedMs = elapsedMs(); received = Date.now(); disconnected = true; render(); } }
      finally { loading = false; }
    }
    async function submit(text, { hasAttachments = false } = {}) {
      if (!parse(text)) return false;
      if (creating) return true;
      error.hidden = true;
      if (!supports()) { showError("unsupported"); return true; }
      if (hasAttachments) { showError("attachments"); return true; }
      if (ACTIVE.has(latest?.status)) { showError("active"); return true; }
      const c = getConnection();
      if (c.streaming || c.acpPromptInFlight || c.taskStatus === "running") { showError("busy"); return true; }
      const context = getContext(), limits = { minutes: Number(minutes.value), turns: Number(turns.value), outputTokens: Number(tokens.value) };
      let request;
      try {
        request = createRequest({ entry, text, limits, title: title.value });
      } catch (e) { showError(e.message === "limits" ? "limitsError" : "empty"); return true; }
      const fingerprint = JSON.stringify({ ...request, context });
      if (attempt?.fingerprint !== fingerprint) attempt = { fingerprint, requestId: requestId(), context, text };
      request.requestId = attempt.requestId; creating = true; render();
      try {
        const created = await post("/api/workflows", request);
        if (!current(context)) return true;
        if (latest?.id !== created.id || attempt) accept(created, text);
        await refresh();
      } catch (e) { if (current(context) && attempt?.requestId === request.requestId) showError("failed", e.message); }
      finally { creating = false; if (current(context)) render(); }
      return true;
    }
    async function action(name) {
      if (!latest || acting) return;
      const id = latest.id, context = getContext(); acting = true; error.hidden = true; render();
      try {
        const updated = await post("/api/workflows", { id, action: name });
        if (current(context)) {
          revision++;
          if (updated?.id === id) { latest = updated; received = Date.now(); disconnected = false; }
          onChanged(); await refresh();
        }
      }
      catch (e) { if (current(context)) showError("failed", e.message); }
      finally { acting = false; if (current(context)) render(); }
    }
    input.addEventListener("input", () => { error.hidden = true; render(); });
    root.addEventListener("message", event => { if (event.origin === root.location.origin && event.source === root.parent && event.data?.type === "workspace-workflows-changed") void refresh(); });
    const poll = root.setInterval(() => void refresh(), 1500), ticker = root.setInterval(elapsed, 1000);
    root.addEventListener("pagehide", () => { closed = true; root.clearInterval(poll); root.clearInterval(ticker); }, { once: true });
    render(); void refresh();
    return { submit, refresh, commandItem: () => supports() ? { name: "goal", description: t("description"), source: "workflow" } : null };
  }
  return Object.freeze({ parse, createRequest, mount });
});
