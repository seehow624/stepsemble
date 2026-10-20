/* Schedules in a Workspace pane: one computer's schedules, read through the
   Host this page came from. The Workspace places the pane and opens
   conversations; the two talk with messages. */
"use strict";
(() => {
  const WI = window.StepsembleWorkspaceI18n, W = window.StepsembleWorkflows;
  const params = new URLSearchParams(location.search), target = params.get("machine") || "";
  // On its own the page has no Workspace to open a conversation in.
  const workspace = params.get("embed") === "1" && window.parent !== window ? window.parent : null;
  if (!workspace) { location.replace("/"); return; }
  const tell = message => workspace.postMessage(message, location.origin);
  const prefersDark = () => matchMedia("(prefers-color-scheme: dark)").matches;
  const readPreferences = () => {
    try { return WI.preferences(localStorage, { prefersDark: prefersDark() }); }
    catch { return WI.preferences({ getItem: () => null }, { prefersDark: prefersDark() }); }
  };
  let prefs = readPreferences(), machines = [], self = "", shown = true, booted = null, starts = 0;
  const t = (key, vars) => WI.t(key, vars, prefs.locale);
  const mount = document.getElementById("schedules");
  // The Workspace's look, and the tab's title in its language.
  function applyPreferences() {
    const root = document.documentElement;
    root.lang = prefs.locale; root.dataset.theme = prefs.resolvedTheme; root.dataset.designTheme = prefs.designTheme; root.dataset.look = prefs.look;
    root.classList.toggle("reduced-motion", prefs.reducedMotion); root.style.fontSize = `${prefs.fontScale}%`;
    const title = W.label("schedules");
    document.title = `Stepsemble · ${title}`;
    tell({ type: "workspace-title", title });
  }
  // A phone shows one pane without the Workspace's title bars; the
  // Workspace's width decides, not this frame's.
  try {
    const outer = window.parent.matchMedia("(max-width: 760px)");
    const sync = () => document.documentElement.classList.toggle("wf-workspace-mobile", outer.matches);
    sync(); outer.addEventListener?.("change", sync);
  } catch {}
  // Another computer answers through this Host's relay, as in the Workspace.
  async function api(path, body, host = target, signal) {
    if (!machines.some(m => m.id === host)) throw new Error(t("hostUnavailable"));
    const prefix = host === self ? "" : `/r/${encodeURIComponent(host)}`;
    const res = await fetch(prefix + path, { credentials: "same-origin", cache: "no-store", signal, ...(body === undefined ? {} : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }) });
    if (res.status === 401) throw new Error(t("expired"));
    const data = await res.json(); if (!res.ok) throw Object.assign(new Error(data.error || t("loadFailed")), { status: res.status, ...(typeof data.code === "string" ? { code: data.code } : {}), detail: data }); return data;
  }
  const ui = W.create({ api, mount,
    async context(host) {
      host ||= target;
      const data = await api("/api/workspace", undefined, host);
      return { target: host, hostName: machines.find(m => m.id === host)?.name || host, projects: data.projects, entries: data.entries };
    },
    // The Workspace opens it beside this pane where there is room.
    openConversation(key, title) { tell({ type: "workspace-open", key, title }); },
    onChanged() { tell({ type: "workspace-workflows-changed" }); },
    back() { tell({ type: "workspace-show-list" }); },
    visible: () => shown && !document.hidden,
  });
  async function boot() {
    let res;
    try { res = await fetch("/api/machines", { credentials: "same-origin", cache: "no-store" }); } catch {}
    if (res?.status === 401) throw new Error(t("expired"));
    if (!res?.ok) throw new Error(t("hostsFailed"));
    const data = await res.json();
    machines = Array.isArray(data.machines) ? data.machines : [];
    self = data.current || data.selfId || machines.find(m => m.self)?.id || "";
  }
  // A computer that cannot be reached says so, with Try again.
  function failed(error, intent) {
    const box = document.createElement("div"), mark = document.createElement("span"), title = document.createElement("h2"), retry = document.createElement("button");
    box.className = "wf-empty"; mark.className = "wf-icon"; mark.textContent = "◷"; mark.setAttribute("aria-hidden", "true");
    title.textContent = error?.message || W.label("refreshError");
    retry.type = "button"; retry.className = "btn primary"; retry.textContent = W.label("retry"); retry.onclick = () => void start(intent);
    box.append(mark, title, retry); mount.replaceChildren(box);
  }
  // Only the latest request shows its failure.
  function start(intent) {
    const ticket = ++starts;
    booted ||= boot().catch(error => { booted = null; throw error; });
    return booted.then(() => ui.show(intent)).catch(error => { if (ticket === starts) failed(error, intent); });
  }
  const intentOf = value => ({ select: typeof value.select === "string" && value.select ? value.select : null, create: value.create === true, focus: value.focus === true });
  addEventListener("message", event => {
    if (event.origin !== location.origin || event.source !== workspace) return;
    const data = event.data || {};
    if (data.type === "schedules-show") void start(intentOf(data));
    // A pane out of sight stops asking its Host.
    if (data.type === "workspace-visibility") shown = data.visible === true;
    if (data.type === "workspace-detach") { shown = false; ui.close(); }
  });
  addEventListener("pointerdown", () => tell({ type: "workspace-focus" }), { passive: true });
  addEventListener("keydown", event => {
    if (event.isComposing || !event.metaKey || !event.altKey || event.ctrlKey || event.shiftKey || !["ArrowLeft", "ArrowRight"].includes(event.key)) return;
    event.preventDefault(); event.stopImmediatePropagation();
    tell({ type: "workspace-select-tab", direction: event.key === "ArrowLeft" ? -1 : 1 });
  }, true);
  // Settings changed in another pane, and "Follow system", reach this one too.
  const restyle = () => { const next = readPreferences(); if (JSON.stringify(next) !== JSON.stringify(prefs)) { prefs = next; applyPreferences(); } };
  addEventListener("storage", event => { if (event.key === null || /^(stepsemble|piharbor|piweb)\.settings\./.test(event.key)) restyle(); });
  matchMedia("(prefers-color-scheme: dark)").addEventListener?.("change", restyle);
  applyPreferences();
  tell({ type: "schedules-ready" });
  void start(intentOf({ select: params.get("select"), create: params.get("create") === "1", focus: params.get("focus") === "1" }));
})();
