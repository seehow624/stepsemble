/* Workspace chrome owns placement only. Provider state belongs to the Host. */
"use strict";
(() => {
  const L = window.StepsembleLayout, I = window.StepsembleWorkspaceI18n, O = window.StepsembleWorkspaceOrder, $ = id => document.getElementById(id);
  const WAM = window.StepsembleWorkspaceAssistantModel;
  // Created once the helpers below exist; the first preferences pass runs before.
  let assistantUI = null;
  const prefersDark = () => matchMedia("(prefers-color-scheme: dark)").matches;
  const readPreferences = () => {
    try { return I.preferences(localStorage, { prefersDark: prefersDark() }); }
    catch { return I.preferences({ getItem: () => null }, { prefersDark: prefersDark() }); }
  };
  let prefs = readPreferences();
  const t = (key, vars) => I.t(key, vars, prefs.locale);
  // The conversation page's plain-text rule for titles, so a first message
  // such as "**Fix** the build" reads the same in the sidebar, tab and pane.
  const plainTitle = value => String(value || "").replace(/[#*_`~>\[\]]/g, "").replace(/\((https?:\/\/)[^)]*\)/g, "")
    .replace(/[\r\n]+/g, " ").replace(/\s{2,}/g, " ").trim();
  const date = value => new Date(value).toLocaleString(prefs.locale);
  function applyPreferences() {
    // Same presentation contract as the conversation views: resolved theme,
    // design palette, type scale, density and sidebar width all come from the
    // user's saved preferences so the shell never looks like another product.
    const root = document.documentElement;
    root.lang = prefs.locale;
    root.dataset.theme = prefs.resolvedTheme;
    root.dataset.designTheme = prefs.designTheme;
    root.classList.toggle("reduced-motion", prefs.reducedMotion);
    root.style.fontSize = `${prefs.fontScale}%`;
    root.style.setProperty("--workspace-sidebar-width", `${prefs.sidebarWidth}px`);
    document.body.classList.toggle("compact", prefs.compact);
    document.title = `Stepsemble · ${t("workspace")}`;
    if (window.StepsembleWorkflows) {
      labelWorkflows();
    }
    for (const element of document.querySelectorAll("[data-workspace-i18n]")) element.textContent = t(element.dataset.workspaceI18n);
    for (const attr of ["aria-label", "title", "placeholder"]) for (const element of document.querySelectorAll(`[data-workspace-${attr}]`)) element.setAttribute(attr, t(element.getAttribute(`data-workspace-${attr}`)));
    renderHostState();
    if (assistantUI) { renderMode(); assistantUI.render(); }
    // The Mac app matches its window, buttons and dialogs to the chosen
    // theme; "auto" follows macOS.
    window.webkit?.messageHandlers?.stepsemble?.postMessage({ type: "appearance", theme: prefs.theme });
  }
  // The Host card's second line: whether the Host answers, in words.
  function renderHostState() {
    const state = $("workspace-host-state");
    if (!state) return;
    state.textContent = state.dataset.state === "online" ? t("connected") : state.dataset.state === "offline" ? t("hostUnavailable") : t("connecting");
  }
  // A bucket that only repeats the provider's name ("codex" under Codex) is
  // left out of the label.
  function usageLabel(w, provider = null) {
    const period = w.windowDurationMins === 300 ? t("fiveHours") : w.windowDurationMins === 10080 ? t("weekly")
      : w.windowDurationMins === 43200 ? t("monthly") : t("minutes", { minutes: w.windowDurationMins || "?" });
    const same = value => String(value || "").toLowerCase() === String(w.bucket || "").toLowerCase();
    return w.bucket && !same(provider?.provider) && !same(provider?.service) ? w.bucket + " · " + period : period;
  }
  applyPreferences();
  const params = new URLSearchParams(location.search);
  let windowId = /^[a-f0-9-]{36}$/.test(params.get("window")) ? params.get("window") : "main";
  let storageKey = `stepsemble.workspace.layout.v1.${windowId}`;
  let tree = L.pane(), focused = tree.id, maximized = null, machines = [], host = "", self = "";
  let snapshot = { projects: [], entries: [] }, refreshEpoch = 0, toastTimer, dialogEpoch = 0;
  let sidebarBusy = false, sidebarDragging = false, sidebarEditEpoch = 0;
  let pendingNotice = null, noticeEpoch = 0;
  const collapsedProjects = new Map();
  function collapsedFor(target = host) {
    if (!collapsedProjects.has(target)) {
      let paths = [];
      try { paths = JSON.parse(localStorage.getItem(`stepsemble.workspace.collapsed.v1.${target}`)); } catch {}
      collapsedProjects.set(target, new Set(Array.isArray(paths) ? paths.filter(path => typeof path === "string") : []));
    }
    return collapsedProjects.get(target);
  }
  // A long project shows its first sessions; the rest wait behind one small
  // control until the person opens them, for as long as this page lives.
  const SESSIONS_SHOWN = 3;
  const expandedProjects = new Map();
  function expandedFor(target = host) { if (!expandedProjects.has(target)) expandedProjects.set(target, new Set()); return expandedProjects.get(target); }
  function saveCollapsed(target = host) {
    try { localStorage.setItem(`stepsemble.workspace.collapsed.v1.${target}`, JSON.stringify([...collapsedFor(target)])); } catch {}
  }
  const frames = new Map(), slots = new Map(), pendingTransfers = new Map();
  const hostSnapshots = new Map(), readsPending = new Set(), readCompletions = new Set();
  const snapshotRequests = new Map();
  let channel;
  try { channel = new BroadcastChannel("stepsemble.workspace.v1"); } catch {}
  try { const saved = JSON.parse(localStorage.getItem(storageKey)); if (saved) { tree = L.normalize(saved.tree); focused = L.leaves(tree).some(p => p.id === saved.focused) ? saved.focused : L.leaves(tree)[0].id; } } catch {}
  const mobile = () => matchMedia("(max-width:760px)").matches;
  const node = (tag, text, className) => { const e = document.createElement(tag); if (text) e.textContent = text; if (className) e.className = className; return e; };
  function button(text, action, label = text, className = "btn") { const b = node("button", text, className); b.type = "button"; b.title = label; b.setAttribute("aria-label", label); b.onclick = action; return b; }
  // The Bots and groups share the sidebar with the sessions, below Recent; a
  // Bot opens in a pane as a session does, on a phone as well. The list is
  // redrawn around their block, which keeps its own state.
  const botsBlock = $("workspace-assistant");
  const assistantTab = (host, route) => WAM.findTab(allRefs(), host, route) || assistantUI.ref(host, route);
  assistantUI = window.StepsembleWorkspaceAssistant.create({
    locale: () => prefs.locale, wt: t,
    machines: () => machines.map(m => ({ id: m.id, name: m.name || m.id, self: m.id === self, base: m.id === self ? "" : `/r/${encodeURIComponent(m.id)}` })),
    selected: () => mobile() ? [active(L.leaves(tree).find(p => p.id === focused) || L.leaves(tree)[0])].filter(Boolean) : L.leaves(tree).map(active).filter(Boolean),
    open: (target, route) => openAssistant(target, route),
    dragStart: (event, target, route) => dragStart(event, assistantTab(target, route), false), dragEnd,
    menu: (anchor, actions) => openPaneMenu(anchor, actions),
    newWindow: (target, route) => newWindow(assistantTab(target, route)),
    onInstalled(installed) {
      $("workspace-routines").hidden = !installed; botsBlock.hidden = !installed;
      if (installed && !assistantUI.active) { assistantUI.setQuery($("workspace-search").value.trim()); assistantUI.activate(botsBlock, { inline: true }); }
      if (!installed && assistantUI.active) assistantUI.deactivate();
      renderSidebar();
    },
  });
  function renderMode() {
    const routines = $("workspace-routines"), label = assistantUI.text("allRoutines");
    routines.title = label; routines.setAttribute("aria-label", label);
  }
  function icon(path, className = "") {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 24 24"); svg.setAttribute("aria-hidden", "true");
    if (className) svg.setAttribute("class", className);
    const stroke = document.createElementNS("http://www.w3.org/2000/svg", "path");
    stroke.setAttribute("d", path); svg.append(stroke); return svg;
  }
  function stripButton(label, path, action, edge) {
    const control = button("", action, label, "btn workspace-strip-button");
    control.dataset.edge = edge; control.append(icon(path)); return control;
  }
  function sidebarToggle() {
    const sync = () => control.setAttribute("aria-expanded", String(!document.body.classList.contains("sidebar-hidden")));
    const control = stripButton(t("toggleSidebar"), "M4 7h16M4 12h16M4 17h16", () => {
      document.body.classList.toggle("sidebar-hidden"); sync(); requestAnimationFrame(layoutFrames);
    }, "start");
    control.setAttribute("aria-controls", "workspace-sidebar"); sync(); return control;
  }
  // Corners of the drawn layout. The first leaf is top-left; top-right follows
  // the right side of side-by-side splits and the upper side of stacked ones.
  function cornerPanes(root) {
    let start = root, end = root;
    while (start.type === "split") start = start.first;
    while (end.type === "split") end = end.axis === "row" ? end.second : end.first;
    return { start: start.id, end: end.id };
  }
  function toast(text) { $("workspace-toast").textContent = text; $("workspace-toast").hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => $("workspace-toast").hidden = true, 6000); }
  // The pane overflow menu lives on the document, not inside the pane: the
  // conversation frames sit in their own layer above the pane tree, so a menu
  // rendered inside a pane would be painted underneath the frame it belongs to.
  let paneMenu = null;
  function closePaneMenu() { const open = !!paneMenu; paneMenu?.element.remove(); paneMenu = null; if (open) settleSidebarOrder(); }
  // A session that moves up while the pointer is over the list, or a menu is
  // open, waits until the pointer leaves: a row never jumps under a click.
  let sidebarPointer = false, sidebarOrderPending = false;
  function sidebarHeld() { return sidebarPointer || !!paneMenu; }
  function settleSidebarOrder() { if (sidebarOrderPending && !sidebarHeld() && !sidebarDragging) renderSidebar(); }
  $("workspace-sidebar")?.addEventListener("pointerenter", () => { sidebarPointer = true; });
  $("workspace-sidebar")?.addEventListener("pointerleave", () => { sidebarPointer = false; settleSidebarOrder(); });
  function openPaneMenu(anchor, actions) {
    const reopening = paneMenu?.anchor === anchor;
    closePaneMenu();
    if (reopening) return;
    const element = node("div", "", "workspace-menu");
    element.setAttribute("role", "menu");
    for (const [label, run] of actions) {
      const item = button(label, () => { closePaneMenu(); run(); }, label, "btn workspace-menu-item");
      item.setAttribute("role", "menuitem");
      element.append(item);
    }
    document.body.append(element);
    const box = anchor.getBoundingClientRect(), width = element.offsetWidth;
    element.style.top = `${Math.round(box.bottom + 5)}px`;
    element.style.left = `${Math.round(Math.min(Math.max(8, box.right - width), Math.max(8, innerWidth - width - 8)))}px`;
    paneMenu = { element, anchor };
    element.querySelector("button")?.focus();
  }
  addEventListener("pointerdown", event => {
    if (!paneMenu || paneMenu.element.contains(event.target) || paneMenu.anchor.contains(event.target)) return;
    closePaneMenu();
  }, true);
  addEventListener("keydown", event => { if (event.key === "Escape" && paneMenu) { const anchor = paneMenu.anchor; closePaneMenu(); anchor.focus(); } });
  addEventListener("resize", closePaneMenu);
  function save(next = tree) {
    // Validate and persist before acknowledging a cross-window move. A storage
    // failure must never make the source discard the user's only visible tab.
    const checked = L.normalize(next);
    localStorage.setItem(storageKey, JSON.stringify({ tree: checked, focused }));
    tree = next;
  }
  async function api(path, body, target = host) {
    if (!machines.some(m => m.id === target)) throw new Error(t("hostUnavailable"));
    const prefix = target === self ? "" : `/r/${encodeURIComponent(target)}`;
    const res = await fetch(prefix + path, { credentials: "same-origin", cache: "no-store", ...(body === undefined ? {} : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }) });
    if (res.status === 401) throw new Error(t("expired"));
    const data = await res.json(); if (!res.ok) throw Object.assign(new Error(data.error || t("loadFailed")), { status: res.status, ...(typeof data.code === "string" ? { code: data.code } : {}), detail: data }); return data;
  }
  const hostName = value => machines.find(m => m.id === value)?.name || value;
  const refOf = entry => ({ host, key: entry.key, title: plainTitle(entry.record.name) || entry.record.agentId || "Session",
    ...(entry.record.agentId ? { agentId: entry.record.agentId } : {}) });
  function allRefs() { return L.leaves(tree).flatMap(p => p.tabs); }
  // A tab saved before its agent was kept gets its logo once the list names it.
  function setRefAgent(ref, agentId) {
    if (typeof agentId !== "string" || !/^[a-z0-9][a-z0-9-]{0,31}$/.test(agentId)) return;
    const key = L.identity(ref);
    let changed = false;
    for (const tab of allRefs()) if (L.identity(tab) === key && tab.agentId !== agentId) { tab.agentId = agentId; changed = true; }
    if (!changed) return;
    try { save(); } catch (error) { toast(error.message); }
    updateTabMetadata(ref);
  }
  // A session's tab starts with its agent's logo; a Bot tab with the Bot.
  const tabIcon = ref => ref.assistant ? assistantUI.tabIcon(ref) : window.StepsembleAgentIdentity.create(document, ref.agentId || "", true);
  // A title bar names the computer too once there is more than one.
  const tabLabel = ref => [tabIcon(ref), node("span", ref.title, "workspace-tab-title"), ...(machines.length > 1 ? [node("span", hostName(ref.host), "workspace-tab-host")] : [])];
  function updateTabMetadata(ref) {
    const current = allRefs().find(tab => L.identity(tab) === L.identity(ref));
    if (!current) return;
    for (const tab of document.querySelectorAll(".workspace-tab")) {
      if (tab.dataset.identity !== L.identity(ref)) continue;
      const label = tab.querySelector(".workspace-tab-label");
      label.title = `${current.title} · ${hostName(current.host)}`; label.setAttribute("aria-label", label.title);
      label.replaceChildren(...tabLabel(current));
      const close = tab.lastElementChild; close.title = t("closeTab", { title: current.title }); close.setAttribute("aria-label", close.title);
    }
  }
  function setRefTitle(ref, value) {
    const title = String(value || "").replace(/\s+/g, " ").trim().slice(0, 160);
    if (!title) return;
    const key = L.identity(ref);
    let changed = false;
    for (const tab of allRefs()) if (L.identity(tab) === key && tab.title !== title) { tab.title = title; changed = true; }
    if (!changed) return;
    const entry = ref.host === host && snapshot.entries.find(row => row.key === ref.key);
    if (entry) entry.record.name = title;
    const frame = frames.get(key);
    if (frame) {
      frame.ref.title = title; frame.frame.title = `${title} · ${hostName(ref.host)}`;
      // The conversation's own title row shows the same name.
      frame.frame.contentWindow?.postMessage({ type: "workspace-renamed", title }, location.origin);
    }
    try { save(); } catch (error) { toast(error.message); }
    updateTabMetadata(ref);
  }
  // Renames a session of any agent; the Host keeps the name.
  function renameSession(ref) {
    const body = dialog(t("renameSession")), epoch = dialogEpoch;
    const entry = ref.host === host ? snapshot.entries.find(row => row.key === ref.key) : null;
    const input = node("input"); input.type = "text"; input.autocomplete = "off"; input.maxLength = 120;
    input.value = plainTitle(entry?.record.name || ref.title) || ""; input.setAttribute("aria-label", t("sessionName"));
    const save = button(t("save"), async () => {
      const name = input.value.replace(/\s+/g, " ").trim();
      if (!name) { input.focus(); return; }
      save.disabled = true;
      try {
        const data = await api("/api/workspace/rename", { key: ref.key, name }, ref.host);
        if (epoch !== dialogEpoch) return;
        closeDialog();
        const title = data.name || name, listed = ref.host === host && snapshot.entries.find(row => row.key === ref.key);
        if (listed) listed.record.name = title;
        setRefTitle(ref, title); renderSidebar();
        channel?.postMessage({ type: "refresh" });
      } catch (error) { toast(error.message); save.disabled = false; }
    }, t("save"), "btn primary workspace-rename-save");
    input.addEventListener("keydown", event => { if (event.key === "Enter" && !event.isComposing) { event.preventDefault(); save.click(); } });
    const fields = node("div", "", "workspace-rename-fields"); fields.append(input, save); body.append(fields);
    requestAnimationFrame(() => { input.focus(); input.select(); });
  }
  function active(p) { return p.tabs.find(r => L.identity(r) === p.active); }
  function closeActiveTab() {
    if (settingsLayer) { closeSettings(); return; }
    if (usageUI.isOpen()) { usageUI.close(); return; }
    if (document.querySelector(".wf-panel[open]")) { workflowUI.close(); return; }
    if ($("workspace-dialog").open) { closeDialog(); return; }
    const pane = L.leaves(tree).find(row => row.id === focused) || L.leaves(tree)[0];
    if (active(pane)) closeSession(pane);
  }
  // Closing a pane's session closes the pane too when others remain; the
  // session itself keeps working.
  function closeSession(pane) {
    const ref = active(pane);
    if (!ref) return;
    const next = L.drop(tree, ref);
    if (maximized === pane.id) maximized = null;
    if (!commit(next)) return;
    focused = (L.leaves(tree).find(row => row.id === focused) || L.leaves(tree)[0]).id;
    if (mobile() && !active(L.leaves(tree).find(row => row.id === focused))) showMobileList();
  }
  window.addEventListener("stepsemble-close-tab", closeActiveTab);
  function commit(next, reveal = null) {
    const changed = L.leaves(next).filter(p => { const old = L.leaves(tree).find(old => old.id === p.id); return p.active !== old?.active || p.tabs.length < (old?.tabs.length || 0); }).map(p => p.id);
    try { save(next); render(); requestAnimationFrame(() => revealActiveTabs(reveal ? [reveal] : changed)); return true; }
    catch (error) { toast(error.message); return false; }
  }
  function revealActiveTabs(paneIds = L.leaves(tree).map(p => p.id)) {
    for (const pane of document.querySelectorAll(".workspace-pane")) {
      if (!paneIds.includes(pane.dataset.pane)) continue;
      const list = pane.querySelector(".workspace-tablist"), tab = list?.querySelector('[aria-selected="true"]');
      if (!tab || !list.clientWidth) continue;
      const a = tab.getBoundingClientRect(), b = list.getBoundingClientRect();
      if (a.left < b.left) list.scrollLeft += a.left - b.left;
      else if (a.right > b.right) list.scrollLeft += Math.min(a.right - b.right, a.left - b.left);
    }
    reportDragRegions();
  }
  function selectTab(paneId, key) {
    const pane = L.leaves(tree).find(p => p.id === paneId);
    if (!pane?.tabs.some(ref => L.identity(ref) === key)) return false;
    const previous = focused; focused = paneId;
    if (commit(tree, paneId)) return true;
    focused = previous; return false;
  }
  // The previous or next pane with a session takes the focus.
  function selectAdjacentTab(direction, paneId = focused) {
    if (![-1, 1].includes(direction) || settingsLayer || $("workspace-dialog").open || usageUI.isOpen()) return;
    const panes = L.leaves(tree).filter(p => p.active || p.id === paneId), index = panes.findIndex(p => p.id === paneId);
    const pane = panes[(index + direction + panes.length) % panes.length];
    if (pane?.active && pane.id !== paneId && selectTab(pane.id, pane.active)) requestAnimationFrame(() => frames.get(pane.active)?.frame.focus({ preventScroll: true }));
  }
  addEventListener("stepsemble-select-tab", event => selectAdjacentTab(event.detail?.direction));
  addEventListener("keydown", event => {
    if (!event.isComposing && event.metaKey && event.altKey && !event.ctrlKey && !event.shiftKey && ["ArrowLeft", "ArrowRight"].includes(event.key)) {
      event.preventDefault(); selectAdjacentTab(event.key === "ArrowLeft" ? -1 : 1);
    }
  });
  function untrackMembership(target, keys, broadcast = true) {
    if (!machines.some(machine => machine.id === target) || !Array.isArray(keys)) return;
    const valid = keys.filter(key => typeof key === "string" && /^[a-f0-9-]{36}$/.test(key));
    let next = tree;
    for (const key of valid) next = L.drop(next, { host: target, key });
    if (JSON.stringify(next) !== JSON.stringify(tree)) commit(next);
    if (broadcast) channel?.postMessage({ type: "untracked", host: target, keys: valid });
    void refresh();
  }
  // The top-left pane is the main one: a session picked from the list shows
  // there, and the other panes keep theirs. An empty pane in focus, as a
  // split just made, takes it instead.
  function primaryPane() {
    const shown = L.leaves(tree).find(p => p.id === focused);
    return shown && !shown.active ? shown.id : cornerPanes(tree).start;
  }
  function open(ref, paneId = primaryPane(), edge = "center", move = false) {
    try {
      const existing = !move && edge === "center" && L.leaves(tree).find(p => p.tabs.some(tab => L.identity(tab) === L.identity(ref)));
      if (existing) {
        const previousMaximized = maximized;
        if (maximized && maximized !== existing.id) maximized = null;
        if (!selectTab(existing.id, L.identity(ref))) { maximized = previousMaximized; return false; }
        if (mobile()) {
          if (!document.body.classList.contains("sidebar-hidden")) window.history.pushState({ stepsembleWorkspaceView: "session" }, "", location.href);
          document.body.classList.add("sidebar-hidden"); requestAnimationFrame(layoutFrames);
        }
        return true;
      }
      const next = L.insert(tree, paneId, ref, edge);
      const previousFocus = focused;
      focused = L.leaves(next).find(p => p.tabs.some(r => L.identity(r) === L.identity(ref))).id;
      maximized = null;
      if (!commit(next, focused)) { focused = previousFocus; return false; }
      if (mobile()) {
        if (!document.body.classList.contains("sidebar-hidden")) window.history.pushState({ stepsembleWorkspaceView: "session" }, "", location.href);
        document.body.classList.add("sidebar-hidden");
        requestAnimationFrame(layoutFrames);
      }
      return true;
    } catch (error) { toast(error.message); return false; }
  }
  // A Bot, a group or an Assistant page has one tab per computer: opening it
  // again shows that tab, moved to the page that was asked for.
  function openAssistant(target, route) {
    const existing = WAM.findTab(allRefs(), target, route);
    if (!existing) return open(assistantUI.ref(target, route));
    const fresh = assistantUI.ref(target, route);
    if (JSON.stringify(existing.assistant) !== JSON.stringify(fresh.assistant)) {
      updateAssistantTab(existing, { route: fresh.assistant, title: fresh.title, avatar: fresh.avatar });
      frames.get(L.identity(existing))?.frame.contentWindow?.postMessage({ type: "assistant-navigate", route: fresh.assistant }, location.origin);
    }
    return open(existing);
  }
  // A Bot tab says which page it shows; its label and the saved layout follow.
  function updateAssistantTab(ref, { route, title, avatar }) {
    let checked;
    try { checked = L.reference({ host: ref.host, key: ref.key, title: String(title || "").replace(/\s+/g, " ").trim() || ref.title, assistant: route, avatar: avatar || undefined }); }
    catch { return; }
    const key = L.identity(ref);
    let changed = false;
    for (const tab of allRefs()) if (L.identity(tab) === key) {
      if (JSON.stringify(tab.assistant) !== JSON.stringify(checked.assistant) || tab.title !== checked.title || tab.avatar !== checked.avatar) changed = true;
      tab.assistant = checked.assistant; tab.title = checked.title;
      if (checked.avatar) tab.avatar = checked.avatar; else delete tab.avatar;
    }
    const item = frames.get(key);
    if (item) { item.ref = allRefs().find(tab => L.identity(tab) === key) || item.ref; item.frame.title = `${checked.title} · ${hostName(ref.host)}`; }
    if (!changed) return;
    try { save(); } catch (error) { toast(error.message); }
    updateTabMetadata(ref); assistantUI.mark();
  }
  function dragStart(event, ref, fromTab) {
    const payload = { version: 1, ref: L.reference(ref), source: fromTab ? windowId : null, transfer: crypto.randomUUID() };
    if (fromTab) { pendingTransfers.set(payload.transfer, { ref: payload.ref, drag: true }); setTimeout(() => pendingTransfers.delete(payload.transfer), 30000); }
    event.dataTransfer.setData("application/x-stepsemble-session", JSON.stringify(payload));
    event.dataTransfer.effectAllowed = fromTab ? "move" : "copyMove";
    document.body.classList.add("workspace-dragging"); channel?.postMessage({ type: "drag", active: true }); reportDragRegions();
  }
  function referenceSession(payload, item) {
    const ref = payload?.ref;
    if (!ref?.key || ref.assistant) { toast(t("referenceUnsupported")); return; }
    if (ref.key === item.ref.key) { toast(t("referenceSelf")); return; }
    const entry = hostSnapshots.get(ref.host)?.entries.find(row => row.key === ref.key);
    // A session on another computer is summarized there; the chip names it.
    item.frame.contentWindow?.postMessage({ type: "workspace-reference-session", session: { key: ref.key, host: ref.host, hostName: hostName(ref.host),
      title: plainTitle(ref.title) || ref.title || "", agentId: entry?.record.agentId || ref.agentId || "" } }, location.origin);
  }
  function dragEnd() { renderSidebar(); document.body.classList.remove("workspace-dragging"); channel?.postMessage({ type: "drag", active: false }); reportDragRegions(); }
  addEventListener("keydown", event => { if (event.key === "Escape") dragEnd(); });
  let nativeOwnedDrag = null;
  // Native owns mouse tracking only; placement and save-before-ACK stay here.
  window.stepsembleNativeTabPayload = token => nativeOwnedDrag?.transfer === token ? nativeOwnedDrag : null;
  addEventListener("stepsemble-native-tab", event => {
    const data = event.detail || {};
    if (data.phase === "receive") {
      const pane = [...document.querySelectorAll(".workspace-pane")].find(element => { const r = element.getBoundingClientRect(); return data.x >= r.left && data.x <= r.right && data.y >= r.top && data.y <= r.bottom; });
      if (!pane) return;
      const bar = pane.querySelector(".workspace-tabs")?.getBoundingClientRect();
      const onBar = bar && data.x >= bar.left && data.x <= bar.right && data.y >= bar.top && data.y <= bar.bottom;
      const p = pane.getBoundingClientRect(), x = (data.x - p.left) / p.width, y = (data.y - p.top) / p.height;
      const edge = onBar ? "center" : x < .22 ? "left" : x > .78 ? "right" : y < .22 ? "top" : y > .78 ? "bottom" : "center";
      try { acceptTransfer(data.payload, pane.dataset.pane, edge); }
      catch (error) { toast(error.message); }
      return;
    }
    if (data.phase === "cancel") { if (nativeOwnedDrag?.transfer === data.token) nativeOwnedDrag = null; dragEnd(); return; }
    if (data.phase === "end") { dragEnd(); return; }
    const ref = allRefs().find(ref => L.identity(ref) === data.identity);
    if (!ref) return;
    const pane = L.leaves(tree).find(p => p.tabs.some(tab => L.identity(tab) === data.identity));
    if (data.phase === "click") { selectTab(pane.id, data.identity); return; }
    if (data.phase === "start" && typeof data.token === "string") {
      nativeOwnedDrag = { version: 1, ref: L.reference(ref), source: windowId, transfer: data.token };
      pendingTransfers.set(data.token, { ref: nativeOwnedDrag.ref, drag: true });
      setTimeout(() => { pendingTransfers.delete(data.token); if (nativeOwnedDrag?.transfer === data.token) nativeOwnedDrag = null; }, 30000);
      document.body.classList.add("workspace-dragging"); channel?.postMessage({ type: "drag", active: true }); reportDragRegions();
    }
    if (data.phase === "tear-out" && nativeOwnedDrag?.transfer === data.token) { newWindow(ref); nativeOwnedDrag = null; dragEnd(); }
  });
  function newWindow(ref) {
    const target = crypto.randomUUID(), token = crypto.randomUUID();
    if (ref) {
      const initial = L.pane(); initial.tabs = [L.reference(ref)]; initial.active = L.identity(ref);
      try { localStorage.setItem(`stepsemble.workspace.layout.v1.${target}`, JSON.stringify({ tree: initial, focused: initial.id })); }
      catch { toast(t("windowSaveFailed")); return; }
      pendingTransfers.set(token, { target, ref });
      setTimeout(() => pendingTransfers.delete(token), 15000);
    }
    const url = new URL("/workspace.html", location.origin); url.searchParams.set("window", target);
    if (ref) { url.searchParams.set("ack", token); url.searchParams.set("source", windowId); }
    const opened = window.open(url.href, `stepsemble-${target}`, "popup,width=1100,height=820");
    if (!opened) { pendingTransfers.delete(token); toast(t("popupBlocked")); }
  }
  function acceptTransfer(payload, paneId, edge) {
    if (payload.version !== 1) throw new Error(t("invalidDrop"));
    const ref = L.reference(payload.ref);
    if (!machines.some(m => m.id === ref.host)) throw new Error(t("missingHost"));
    if (open(ref, paneId, edge, true) && payload.source && payload.source !== windowId) {
      channel?.postMessage({ type: "moved", source: payload.source, ref, transfer: payload.transfer });
    }
  }
  function layoutFrames() {
    const bounds = $("workspace-stage").getBoundingClientRect();
    for (const [key, item] of frames) {
      const slot = slots.get(key);
      const visible = !!(slot && slot.getClientRects().length && slot.getBoundingClientRect().width > 0);
      // A Bot tab that is not shown stops counting as watching its chat, so
      // the phone still hears about a reply there.
      if (item.ref.assistant && item.frame.hidden === visible) item.frame.contentWindow?.postMessage({ type: "workspace-visibility", visible }, location.origin);
      item.frame.hidden = !visible;
      if (!visible) continue;
      const r = slot.getBoundingClientRect();
      Object.assign(item.frame.style, { left: `${r.left - bounds.left}px`, top: `${r.top - bounds.top}px`, width: `${r.width}px`, height: `${r.height}px` });
    }
    reportDragRegions(); notificationPresence();
  }
  const resize = new ResizeObserver(() => { layoutFrames(); revealActiveTabs(); }); resize.observe($("workspace-stage"));
  // The Mac app's window has no title bar. The app moves the window from the
  // empty parts of the Workspace's top edge, which the page names here, as a
  // browser's empty tab strip does; anywhere else this sends nothing.
  let dragRegionsSent = "[]", tabRegionsSent = "[]", dragRegionsFrame = 0;
  function reportDragRegions() {
    const app = window.webkit?.messageHandlers?.stepsemble;
    if (!app || dragRegionsFrame) return;
    dragRegionsFrame = requestAnimationFrame(() => {
      dragRegionsFrame = 0;
      // While a session is dragged, the whole page takes the drop.
      const moving = document.documentElement.dataset.macWindow === "chromeless" && !document.body.classList.contains("workspace-dragging");
      const rects = moving ? dragRegions() : [];
      const sent = JSON.stringify(rects);
      if (sent !== dragRegionsSent) { dragRegionsSent = sent; app.postMessage({ type: "drag-regions", rects }); }
      const tabRegions = !settingsLayer && !usageUI.isOpen() && !$("workspace-dialog").open && !document.querySelector(".wf-panel[open]") ? [...document.querySelectorAll(".workspace-tab-label")].flatMap(label => {
        const r = label.getBoundingClientRect(), list = label.closest(".workspace-tablist").getBoundingClientRect();
        const left = Math.max(r.left, list.left), right = Math.min(r.right, list.right);
        return right > left && r.height ? [{ identity: label.parentElement.dataset.identity, rect: [left, r.top, right - left, r.height] }] : [];
      }) : [];
      const tabSent = JSON.stringify(tabRegions);
      if (tabSent !== tabRegionsSent) { tabRegionsSent = tabSent; app.postMessage({ type: "tab-drag-regions", tabs: tabRegions }); }
    });
  }
  function dragRegions() {
    const rects = [], add = (left, top, right, bottom) => { if (right - left >= 2 && bottom - top >= 2) rects.push([left, top, right - left, bottom - top].map(Math.round)); };
    const box = element => element.getBoundingClientRect();
    if (settingsLayer) { add(0, 0, innerWidth, parseFloat(getComputedStyle(settingsLayer).paddingTop) || 0); return rects; }
    if (usageUI.isOpen()) return rects;
    const sidebar = $("workspace-sidebar"), name = sidebar.querySelector(".workspace-identity");
    if (sidebar.getClientRects().length && name) add(box(sidebar).left, 0, box(name).right, box(name.parentElement).bottom);
    if ($("workspace-stage").getClientRects().length) {
      const stage = box($("workspace-stage")), top = box($("workspace-tree")).top;
      add(stage.left, 0, stage.right, top);
      // The top row's strips: under the window's buttons, and after the tabs.
      for (const strip of document.querySelectorAll(".workspace-tabs")) {
        const bar = box(strip), list = strip.querySelector(".workspace-tablist");
        if (!bar.width || bar.top > top + 2) continue;
        if (strip.firstElementChild && strip.firstElementChild !== list) add(bar.left, bar.top, box(strip.firstElementChild).left, bar.bottom);
        if (list) { const r = box(list), last = list.lastElementChild; add(Math.max(r.left, last ? box(last).right : r.left), r.top, r.right, r.bottom); }
      }
    }
    const open = document.querySelector("dialog[open]");
    if (!open) return rects;
    const d = box(open);
    return rects.filter(([x, y, w, h]) => x >= d.right || x + w <= d.left || y >= d.bottom || y + h <= d.top);
  }
  addEventListener("stepsemble-workflow-panel", reportDragRegions);
  new ResizeObserver(reportDragRegions).observe($("workspace-sidebar"));
  new MutationObserver(reportDragRegions).observe($("workspace-dialog"), { attributes: true, attributeFilter: ["open"] });
  addEventListener("stepsemble-mac-window", () => requestAnimationFrame(layoutFrames));
  function render() {
    closePaneMenu();
    const scrolls = new Map([...document.querySelectorAll(".workspace-pane")].map(p => [p.dataset.pane, p.querySelector(".workspace-tablist")?.scrollLeft || 0]));
    slots.clear(); $("workspace-tree").replaceChildren();
    if (!L.leaves(tree).some(p => p.id === focused)) focused = L.leaves(tree)[0].id;
    const wanted = new Set(allRefs().map(L.identity));
    for (const [key, item] of frames) if (!wanted.has(key)) { item.frame.contentWindow?.postMessage({ type: "workspace-detach" }, location.origin); item.frame.remove(); frames.delete(key); }
    // Frames live in a stable layer and are never reparented on a split/move.
    // Reparenting an iframe reloads its browsing context on older browsers.
    const visibleRefs = L.leaves(tree).filter(p => (!mobile() || p.id === focused) && (!maximized || p.id === maximized)).map(active).filter(Boolean);
    for (const ref of visibleRefs) {
      const key = L.identity(ref);
      if (frames.has(key)) { frames.get(key).frame.title = `${ref.title} · ${hostName(ref.host)}`; continue; }
      const frame = node("iframe", "", "workspace-frame"); frame.title = `${ref.title} · ${hostName(ref.host)}`;
      // A video in a pane can still go full screen.
      frame.allow = "fullscreen"; frame.allowFullscreen = true;
      const url = new URL("/index.html", location.origin); url.searchParams.set("pane", "1"); url.searchParams.set("host", ref.host); url.searchParams.set("entry", ref.key);
      frame.src = ref.assistant ? new URL(WAM.frameUrl(ref), location.origin).href : url.href; frames.set(key, { frame, ref }); $("workspace-frames").append(frame);
    }
    const shown = (maximized && L.leaves(tree).find(p => p.id === maximized)) || tree;
    const corners = cornerPanes(shown);
    function draw(n) {
      if (n.type === "split") {
        const split = node("div", "", "workspace-split"); split.dataset.axis = n.axis;
        const first = node("div", "", "workspace-branch"), second = node("div", "", "workspace-branch");
        first.style.flex = `${n.ratio} 1 0`; second.style.flex = `${1-n.ratio} 1 0`;
        first.append(draw(n.first)); second.append(draw(n.second));
        const divider = node("div", "", "workspace-divider"); divider.tabIndex = 0; divider.setAttribute("role", "separator"); divider.setAttribute("aria-label", t("resize")); divider.setAttribute("aria-orientation", n.axis === "row" ? "vertical" : "horizontal"); divider.setAttribute("aria-valuenow", Math.round(n.ratio * 100));
        const adjust = ratio => { n.ratio = Math.max(.15, Math.min(.85, ratio)); first.style.flex = `${n.ratio} 1 0`; second.style.flex = `${1-n.ratio} 1 0`; divider.setAttribute("aria-valuenow", Math.round(n.ratio*100)); tree = L.replace(tree, n.id, n); layoutFrames(); revealActiveTabs(); };
        divider.onkeydown = e => { if (["ArrowLeft", "ArrowUp", "ArrowRight", "ArrowDown"].includes(e.key)) { e.preventDefault(); adjust(n.ratio + (["ArrowLeft", "ArrowUp"].includes(e.key) ? -.05 : .05)); try { save(); } catch (error) { toast(error.message); } } };
        divider.onpointerdown = e => { e.preventDefault(); divider.setPointerCapture(e.pointerId); document.body.classList.add("workspace-resizing"); };
        divider.onpointermove = e => { if (!divider.hasPointerCapture(e.pointerId)) return; const r = split.getBoundingClientRect(); adjust(n.axis === "row" ? (e.clientX-r.left)/r.width : (e.clientY-r.top)/r.height); };
        const finish = () => { document.body.classList.remove("workspace-resizing"); try { save(); } catch (error) { toast(error.message); } };
        divider.onpointerup = finish; divider.onpointercancel = finish; divider.onlostpointercapture = finish;
        split.append(first, divider, second); return split;
      }
      const pane = node("section", "", "workspace-pane"); pane.dataset.focused = String(n.id === focused); pane.dataset.pane = n.id;
      pane.onpointerdown = () => { if (focused !== n.id) { focused = n.id; for (const p of document.querySelectorAll(".workspace-pane")) p.dataset.focused = String(p.dataset.pane === focused); } };
      // The pane's title bar: its session's agent, name and computer, which
      // drags the session elsewhere, then the session's summary and actions.
      const tabs = node("div", "", "workspace-tabs");
      const tablist = node("div", "", "workspace-tablist");
      const shownRef = active(n);
      if (shownRef) {
        const key = L.identity(shownRef), tab = node("div", "", "workspace-tab"); tab.dataset.identity = key; tab.draggable = true;
        tab.ondragstart = e => dragStart(e, shownRef, true); tab.ondragend = dragEnd;
        // A middle click closes it, as in a browser; its press must not start
        // the platform's autoscroll.
        tab.onmousedown = e => { if (e.button === 1) e.preventDefault(); };
        tab.onauxclick = e => { if (e.button !== 1) return; e.preventDefault(); closeSession(n); };
        const label = button("", () => selectTab(n.id, key), `${shownRef.title} · ${hostName(shownRef.host)}`, "btn workspace-tab-label");
        label.append(...tabLabel(shownRef));
        tab.append(label, button("×", () => closeSession(n), t("closeTab", { title: shownRef.title }))); tablist.append(tab);
      }
      // A session dropped on the title bar takes this pane's place.
      tablist.ondragover = e => {
        if (!Array.from(e.dataTransfer.types).includes("application/x-stepsemble-session")) return;
        e.preventDefault(); e.stopPropagation(); overlay.dataset.edge = "center";
      };
      tablist.ondrop = e => {
        e.preventDefault(); e.stopPropagation();
        try { acceptTransfer(JSON.parse(e.dataTransfer.getData("application/x-stepsemble-session")), n.id, "center"); }
        catch (error) { toast(error.message); } finally { dragEnd(); }
      };
      tabs.append(tablist);
      const frameCommand = command => frames.get(n.active)?.frame.contentWindow?.postMessage({ type: "workspace-command", command }, location.origin);
      if (shownRef && !shownRef.assistant) {
        const summary = button("", () => frameCommand("summary"), t("summary"), "btn workspace-strip-button workspace-summary-button");
        summary.append(icon("M9 6h11M9 12h11M9 18h11M4.5 6h.01M4.5 12h.01M4.5 18h.01")); tabs.append(summary);
      }
      // A Bot's conversation keeps its history at the same place.
      const botChat = shownRef?.assistant?.page === "bot";
      if (botChat) {
        const history = button("", () => frameCommand("history"), assistantUI.text("historyAction"), "btn workspace-strip-button workspace-history-button");
        history.append(icon("M12 7v5l3 2M3.5 12a8.5 8.5 0 1 0 2.5-6M3 4v4h4")); tabs.append(history);
      }
      // Occasional actions collapse into one overflow control. A permanent row
      // of buttons costs every pane a strip of height that belongs to the
      // conversation.
      const actions = [];
      if (shownRef && !shownRef.assistant) {
        actions.push([t("rename"), () => renameSession(shownRef)]);
        if (shownRef.host === host) {
          const pinned = O.normalize(snapshot.presentation, snapshot).pinnedSessions.includes(shownRef.key);
          actions.push([t(pinned ? "unpin" : "pin"), () => void arrangeSidebar({ kind: "session", id: shownRef.key, pinned: !pinned })]);
        }
        actions.push([t("viewChanges"), () => frameCommand("changes")]);
      }
      if (!mobile() && shownRef) {
        for (const [label, edge] of [[t("splitHorizontal"), "right"], [t("splitVertical"), "bottom"]]) actions.push([label, () => {
          // Split with an empty destination, preserving the current conversation.
          if (L.leaves(tree).length >= 8) { toast(t("paneLimit")); return; }
          const empty = L.pane(); focused = empty.id; maximized = null;
          commit(L.replace(tree, n.id, { type: "split", id: crypto.randomUUID(), axis: edge === "right" ? "row" : "column", ratio: .5, first: n, second: empty }));
        }]);
        // The corner's window button opens an empty window; this one carries
        // the pane's own conversation, so it must not repeat that label.
        actions.push([t("moveWindow"), () => newWindow(shownRef)]);
        actions.push([maximized === n.id ? t("restore") : t("maximize"), () => { maximized = maximized ? null : n.id; render(); requestAnimationFrame(() => revealActiveTabs()); }]);
      }
      if (botChat) {
        const profile = shownRef.assistant.profile;
        actions.unshift([assistantUI.text("settings"), () => openAssistant(shownRef.host, { page: "settings", profile })],
          [assistantUI.text("routines"), () => openAssistant(shownRef.host, { page: "routines", profile })]);
      }
      if (shownRef && (!shownRef.assistant || botChat)) actions.push([t("moreActions"), () => frameCommand("menu")]);
      if (mobile() && L.leaves(tree).length > 1) actions.push([t("nextPane"), () => { const panes = L.leaves(tree); focused = panes[(panes.findIndex(p => p.id === focused)+1)%panes.length].id; commit(tree); }]);
      if (shownRef || L.leaves(tree).length > 1) actions.push([t("closePane"), () => { maximized = null; commit(L.closePane(tree, n.id)); }]);
      if (actions.length) {
        const overflow = button("⋯", () => openPaneMenu(overflow, actions), t("paneActions"), "btn workspace-pane-menu");
        overflow.setAttribute("aria-haspopup", "menu");
        tabs.append(overflow);
      }
      // The workspace has no header row. The list toggle opens the top-left
      // pane's strip and New window closes the top-right one, so both stay in
      // the corners of the stage however the panes are split.
      const corner = !mobile() && (n.id === corners.start || n.id === corners.end);
      if (corner && n.id === corners.start) tabs.prepend(sidebarToggle());
      if (corner && n.id === corners.end) tabs.append(stripButton(t("newWindow"), "M14 4h6v6M20 4l-9 9M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4", () => newWindow(), "end"));
      const slot = node("div", n.tabs.length ? t("loadingSession") : t("selectSession"), "workspace-slot");
      if (n.active) slots.set(n.active, slot);
      const overlay = node("div", "", "workspace-drop");
      const edgeAt = e => { const r = pane.getBoundingClientRect(), x = (e.clientX-r.left)/r.width, y = (e.clientY-r.top)/r.height; return x < .22 ? "left" : x > .78 ? "right" : y < .22 ? "top" : y > .78 ? "bottom" : "center"; };
      // A session dropped on the shown conversation's message box becomes a
      // reference in that conversation instead of a new pane.
      const referenceTarget = e => {
        const item = n.active && frames.get(n.active), r = item?.composerRect;
        if (!r || item.ref.assistant) return null;
        const f = item.frame.getBoundingClientRect(), x = e.clientX - f.left, y = e.clientY - f.top;
        return x >= r.x && x <= r.x + r.width && y >= r.y && y <= r.y + r.height ? item : null;
      };
      overlay.dataset.label = t("referenceDrop");
      pane.ondragover = e => { if (!Array.from(e.dataTransfer.types).includes("application/x-stepsemble-session")) return; e.preventDefault(); overlay.dataset.edge = referenceTarget(e) ? "reference" : edgeAt(e); };
      pane.ondrop = e => { e.preventDefault(); try { const payload = JSON.parse(e.dataTransfer.getData("application/x-stepsemble-session")), target = referenceTarget(e);
        if (target) referenceSession(payload, target); else acceptTransfer(payload, n.id, edgeAt(e)); } catch (error) { toast(error.message); } finally { dragEnd(); } };
      // A pane with no tabs, actions or corner controls keeps no strip, so the
      // invitation to drag a session is the only thing in it.
      if (n.tabs.length || actions.length || corner) pane.append(tabs);
      pane.append(slot, overlay); return pane;
    }
    $("workspace-tree").append(draw(shown));
    for (const pane of document.querySelectorAll(".workspace-pane")) { const list = pane.querySelector(".workspace-tablist"); if (list) list.scrollLeft = scrolls.get(pane.dataset.pane) || 0; }
    layoutFrames();
    requestAnimationFrame(() => revealActiveTabs(L.leaves(tree).filter(p => !scrolls.has(p.id)).map(p => p.id))); renderSidebar();
  }
  // Computers folded in the merged list, and how each answered last.
  const foldedMachines = new Set((() => { try { const saved = JSON.parse(localStorage.getItem("stepsemble.workspace.machines.folded.v1")); return Array.isArray(saved) ? saved.filter(id => typeof id === "string") : []; } catch { return []; } })());
  const machineStatus = new Map(), machinePolledAt = new Map();
  const refFor = (target, entry) => ({ host: target, key: entry.key, title: plainTitle(entry.record.name) || entry.record.agentId || "Session",
    ...(entry.record.agentId ? { agentId: entry.record.agentId } : {}) });
  const snapshotOf = target => target === host ? snapshot : hostSnapshots.get(target) || null;
  // The current computer first, then the others as listed.
  const orderedMachines = () => [...machines.filter(m => m.id === host), ...machines.filter(m => m.id !== host)];
  const RECENT_SHOWN = 5;
  // The sessions most recently used on any computer, those at work first.
  function recentEntries(search) {
    const rows = [];
    for (const machine of machines) for (const entry of snapshotOf(machine.id)?.entries || []) {
      if (search && !`${entry.record.name} ${entry.record.agentId} ${entry.record.cwd || ""}`.toLowerCase().includes(search)) continue;
      rows.push({ target: machine.id, entry, working: entry.working === true ? 1 : 0, at: Number(entry.activityAt) || 0 });
    }
    return rows.sort((a, b) => b.working - a.working || b.at - a.at).slice(0, RECENT_SHOWN);
  }
  // With more than one computer, every computer's sessions share one list:
  // the most recent across them first, then each computer's projects. The
  // current computer, which Settings, Schedules and the allowances follow,
  // keeps ordering and pins; another one's sessions open, rename and start
  // there as well.
  function renderSidebar() {
    if (sidebarDragging) return;
    sidebarOrderPending = false;
    // A redraw (a new order, a new session) keeps keyboard focus on the same control.
    const focusedRow = document.activeElement?.closest?.(".workspace-session-row, .workspace-project");
    const focusTarget = focusedRow && { entry: focusedRow.dataset.entry || null, host: focusedRow.dataset.host || null, cwd: focusedRow.dataset.cwd ?? null,
      part: ["workspace-session", "workspace-session-menu", "workspace-session-more", "workspace-project-toggle", "workspace-project-add", "workspace-project-menu"].find(name => document.activeElement.classList.contains(name)) };
    const box = $("workspace-projects"); box.replaceChildren(); const search = $("workspace-search").value.trim().toLowerCase();
    const selectedRefs = mobile() ? [active(L.leaves(tree).find(p => p.id === focused) || L.leaves(tree)[0])].filter(Boolean) : L.leaves(tree).map(active).filter(Boolean);
    const openKeys = new Set(selectedRefs.map(L.identity));
    const bots = botsBlock;
    if (machines.length <= 1) {
      if (assistantUI.installed) box.append(bots);
      renderProjects(box, host, snapshot, search, openKeys);
      if (!snapshot.projects.length && !snapshot.entries.length) box.append(node("p", t("empty")));
    } else {
      const recent = recentEntries(search);
      if (recent.length) {
        const section = node("section", "", "workspace-recent");
        section.append(node("h2", t("recentSessions"), "workspace-section-title"));
        for (const row of recent) section.append(sessionRow(row.target, row.entry, { openKeys, recent: true }));
        box.append(section);
      }
      if (assistantUI.installed) box.append(bots);
      for (const machine of orderedMachines()) box.append(machineSection(machine, search, openKeys));
    }
    if (focusTarget?.part) {
      const row = focusTarget.entry ? [...box.querySelectorAll(".workspace-session-row")].find(item => item.dataset.entry === focusTarget.entry && (!focusTarget.host || item.dataset.host === focusTarget.host))
        : [...box.querySelectorAll(".workspace-project")].find(item => item.dataset.cwd === focusTarget.cwd);
      const control = row?.querySelector(`.${focusTarget.part}`);
      if (control && control.offsetParent !== null) control.focus({ preventScroll: true });
    }
    assistantUI.mark();
  }
  function machineSection(machine, search, openKeys) {
    const target = machine.id, snap = snapshotOf(target), status = target === host ? null : machineStatus.get(target);
    const section = node("section", "", "workspace-machine"); section.dataset.host = target;
    const offline = status?.online === false;
    section.dataset.state = target === host ? "current" : offline ? "offline" : snap ? "online" : "waiting";
    const header = node("header", "", "workspace-machine-header");
    const folded = !search && foldedMachines.has(target);
    const contents = node("div", "", "workspace-machine-projects"); contents.hidden = folded;
    const toggle = button("", () => {
      if (foldedMachines.has(target)) foldedMachines.delete(target); else foldedMachines.add(target);
      try { localStorage.setItem("stepsemble.workspace.machines.folded.v1", JSON.stringify([...foldedMachines])); } catch {}
      const hidden = foldedMachines.has(target) && !search;
      contents.hidden = hidden; toggle.setAttribute("aria-expanded", String(!hidden));
    }, machine.name, "btn workspace-machine-toggle");
    toggle.setAttribute("aria-expanded", String(!folded));
    const state = target === host ? t("currentMachine") : offline ? (status.at ? t("machineOfflineSince", { time: new Intl.DateTimeFormat(document.documentElement.lang || "en", { hour: "2-digit", minute: "2-digit" }).format(status.at) }) : t("machineOffline")) : "";
    toggle.append(icon("m6 9 6 6 6-6", "workspace-project-chevron"), node("strong", machine.name), ...(state ? [node("small", state, "workspace-machine-state")] : []));
    header.append(toggle);
    if (target !== host) {
      const actions = button("⋯", () => openPaneMenu(actions, [[t("useMachine"), () => selectHost(target)]]), t("machineActions"), "btn workspace-project-menu");
      actions.setAttribute("aria-haspopup", "menu"); header.append(actions);
    }
    section.append(header, contents);
    if (snap) renderProjects(contents, target, snap, search, openKeys);
    else contents.append(node("small", offline ? t("machineUnreachable") : t("loadingSession"), "workspace-machine-note"));
    return section;
  }
  function renderProjects(box, target, snap, search, openKeys) {
    const current = target === host, presentation = O.normalize(snap.presentation, snap);
    for (const cwd of O.projects(snap)) {
      const matchesProject = !!search && cwd.toLowerCase().includes(search);
      const rows = O.entries(snap, cwd).filter(e => !search || matchesProject || `${e.record.name} ${e.record.agentId}`.toLowerCase().includes(search));
      if (search && !matchesProject && !rows.length) continue;
      const section = node("section", "", "workspace-project"), header = node("header"); section.dataset.cwd = cwd; section.dataset.host = target;
      const title = cwd.split(/[\\/]/).filter(Boolean).pop() || t("ungrouped");
      const toggle = button("", () => {
        const collapsed = collapsedFor(target);
        if (collapsed.has(cwd)) collapsed.delete(cwd); else collapsed.add(cwd);
        saveCollapsed(target);
        const hidden = collapsed.has(cwd) && !search;
        section.dataset.collapsed = String(hidden); toggle.setAttribute("aria-expanded", String(!hidden)); contents.hidden = hidden;
      }, cwd || title, "btn workspace-project-toggle");
      const pinned = current && presentation.pinnedProjects.includes(cwd);
      const copy = node("span", "", "workspace-project-copy");
      copy.append(node("strong", title)); if (cwd) copy.append(node("small", cwd));
      if (pinned) toggle.append(pinMark());
      toggle.append(icon("m6 9 6 6 6-6", "workspace-project-chevron"), copy);
      const contents = node("div", "", "workspace-project-sessions");
      const hidden = !search && collapsedFor(target).has(cwd);
      section.dataset.collapsed = String(hidden); contents.hidden = hidden; toggle.setAttribute("aria-expanded", String(!hidden));
      const add = button("", () => newSession(cwd, target), t("newSession"), "btn workspace-project-add");
      add.append(icon("M12 5v14M5 12h14")); header.append(toggle, add);
      if (cwd) {
        if (current) reorderRow(toggle, section, "project", cwd, "", pinned);
        const actions = button("⋯", () => openPaneMenu(actions, [...(current ? orderActions("project", cwd, "", pinned) : []), [t("removeProject"), async () => {
          actions.disabled = true;
          try {
            const result = await api("/api/workspace/project/remove", { cwd }, target);
            collapsedFor(target).delete(cwd); saveCollapsed(target);
            untrackMembership(target, result.keys);
          } catch (error) { toast(error.message); actions.disabled = false; }
        }]]), t("projectActions"), "btn workspace-project-menu");
        actions.disabled = sidebarBusy;
        actions.setAttribute("aria-haspopup", "menu"); header.append(actions);
      }
      section.append(header, contents);
      const overflow = !search && rows.length > SESSIONS_SHOWN;
      rows.forEach((entry, index) => {
        const row = sessionRow(target, entry, { openKeys, presentation });
        if (overflow && index >= SESSIONS_SHOWN) row.dataset.overflow = "true";
        contents.append(row); sessionStatus(row, entry);
      });
      if (overflow) {
        const more = button("", () => {
          const expanded = expandedFor(target), open = !expanded.has(cwd);
          if (open) expanded.add(cwd); else expanded.delete(cwd);
          more.setAttribute("aria-expanded", String(open)); syncSessionMore(section);
        }, "", "btn workspace-session-more");
        more.setAttribute("aria-expanded", String(expandedFor(target).has(cwd)));
        contents.append(more); syncSessionMore(section);
      }
      if (!rows.length) contents.append(node("small", t("noSessions"))); box.append(section);
    }
  }
  // One session's row; a row in Recent also names its computer.
  function sessionRow(target, entry, { openKeys, presentation = null, recent = false }) {
    const ref = refFor(target, entry), identity = window.StepsembleAgentIdentity.lookup(entry.record.agentId);
    const displayTitle = plainTitle(ref.title) || ref.title, current = target === host && !!presentation;
    const row = node("div", "", "workspace-session-row");
    row.dataset.entry = entry.key; row.dataset.host = target;
    const pinned = current && presentation.pinnedSessions.includes(entry.key);
    const b = button("", () => open(ref), `${identity.label}: ${displayTitle}`, "btn workspace-session");
    b.dataset.open = String(openKeys.has(L.identity(ref)));
    b.append(window.StepsembleAgentIdentity.create(document, entry.record.agentId, true), node("strong", displayTitle));
    if (recent) b.append(node("small", hostName(target), "workspace-session-host"));
    if (pinned) b.append(pinMark());
    const goal = node("span", "", "workspace-session-goal"), indicator = node("span", "", "workspace-session-status");
    goal.setAttribute("aria-hidden", "true"); goal.hidden = true;
    b.append(goal, indicator);
    // Sessions follow their activity; dragging one only places it in a pane.
    b.draggable = true; b.ondragstart = e => dragStart(e, ref, false); b.ondragend = dragEnd;
    const actions = button("⋯", () => openPaneMenu(actions, [
      ...(current ? [[t(pinned ? "unpin" : "pin"), () => void arrangeSidebar({ kind: "session", id: entry.key, pinned: !pinned })]] : []),
      [t("rename"), () => renameSession(ref)],
      [t("moveWindow"), () => newWindow(ref)],
      [t("remove"), async () => {
        actions.disabled = true;
        try { await api("/api/workspace/remove", { key: entry.key }, target); untrackMembership(target, [entry.key]); }
        catch (error) { toast(error.message); actions.disabled = false; }
      }],
    ]), t("sessionActions"), "btn workspace-session-menu");
    actions.disabled = sidebarBusy;
    actions.setAttribute("aria-haspopup", "menu");
    b.oncontextmenu = e => { e.preventDefault(); actions.click(); };
    row.append(b, actions);
    if (recent) sessionStatus(row, entry);
    return row;
  }
  function sessionStatus(row, entry) {
    const indicator = row.querySelector(".workspace-session-status");
    if (!indicator) return;
    const unread = entry.completion && !entry.completion.read;
    const state = entry.working === true || entry.working === undefined && ["running", "starting", "reconnecting"].includes(entry.record.status)
      ? "working" : unread ? entry.completion.kind === "completed" ? "unread" : "attention" : "idle";
    indicator.dataset.state = state;
    const label = state === "working" ? t("sessionWorking") : state === "unread" ? t("sessionUnread")
      : state === "attention" ? t("sessionAttention") : "";
    indicator.title = label;
    indicator.setAttribute("aria-hidden", "true");
    // A Goal is run inside its conversation; its mark is how the list shows it.
    const goal = row.querySelector(".workspace-session-goal");
    const goalLabel = { running: t("goalRunning"), paused: t("goalPaused"), attention: t("goalAttention") }[entry.goal] || "";
    if (goal) { goal.hidden = !goalLabel; goal.dataset.state = goalLabel ? entry.goal : ""; goal.title = goalLabel; }
    syncSessionMore(row.closest?.(".workspace-project"));
    const identity = window.StepsembleAgentIdentity.lookup(entry.record.agentId);
    const ref = refFor(row.dataset?.host || host, entry), title = plainTitle(ref.title) || ref.title;
    const spoken = [goalLabel, label].filter(Boolean).join(" · ");
    row.querySelector(".workspace-session").setAttribute("aria-label", `${identity.label}: ${title}${spoken ? " · " + spoken : ""}`);
  }
  // The overflow sessions hide unless their project is opened up; the one
  // open in a pane stays in view, and a hidden session at work or with an
  // unread result marks the control.
  function syncSessionMore(section) {
    const more = section?.querySelector(".workspace-session-more");
    if (!more) return;
    const expanded = more.getAttribute("aria-expanded") === "true";
    let hidden = 0, attention = "";
    for (const row of section.querySelectorAll(".workspace-session-row[data-overflow]")) {
      row.hidden = !expanded && row.querySelector(".workspace-session")?.dataset.open !== "true";
      if (!row.hidden) continue;
      hidden += 1;
      const state = row.querySelector(".workspace-session-status")?.dataset.state;
      if (!attention && ["working", "unread", "attention"].includes(state)) attention = state;
    }
    const label = expanded ? t("showFewerSessions") : t("showMoreSessions", { count: hidden });
    more.textContent = label; more.title = label; more.setAttribute("aria-label", label);
    more.dataset.attention = attention;
    more.hidden = !expanded && hidden === 0;
  }
  function rememberSnapshot(target, data) {
    for (const entry of data.entries) if (entry.completion && readCompletions.has(`${target}:${entry.key}:${entry.completion.id}`)) entry.completion.read = true;
    hostSnapshots.set(target, data);
    return data;
  }
  function probeVisibleResults() {
    for (const ref of visibleSessions()) {
      const entry = hostSnapshots.get(ref.host)?.entries.find(row => row.key === ref.key);
      if (!entry?.completion || entry.completion.read || entry.working) continue;
      frames.get(L.identity(ref))?.frame.contentWindow?.postMessage({ type: "workspace-read-probe", completionId: entry.completion.id }, location.origin);
    }
  }
  async function markViewed(item, completionId) {
    const ref = item.ref, entry = hostSnapshots.get(ref.host)?.entries.find(row => row.key === ref.key);
    if (!visibleSessions().some(value => L.identity(value) === L.identity(ref))
      || !entry?.completion || entry.completion.id !== completionId || entry.completion.read || entry.working) return;
    const id = `${ref.host}:${ref.key}:${completionId}`;
    if (readsPending.has(id)) return;
    readsPending.add(id);
    try {
      const result = await api("/api/workspace/read", { key: ref.key, completionId }, ref.host);
      if (result.completion?.id !== completionId || !result.completion.read) return;
      readCompletions.add(id);
      while (readCompletions.size > 1000) readCompletions.delete(readCompletions.values().next().value);
      const current = hostSnapshots.get(ref.host)?.entries.find(row => row.key === ref.key);
      if (current?.completion?.id === completionId) current.completion.read = true;
      for (const row of document.querySelectorAll(".workspace-session-row")) {
        if (row.dataset.entry === ref.key && (row.dataset.host || host) === ref.host && current) sessionStatus(row, current);
      }
      channel?.postMessage({ type: "refresh" });
    } catch { /* Keep unread on failure; a visible conversation retries on refresh. */ }
    finally { readsPending.delete(id); }
  }
  function pinMark() {
    const mark = icon("M9 3h6l-1 6 4 4v2h-5v6h-2v-6H6v-2l4-4-1-6", "workspace-pin");
    mark.setAttribute("aria-label", t("pinned")); return mark;
  }
  function orderPeers(kind, id, cwd, pinned) {
    const p = O.normalize(snapshot.presentation, snapshot);
    const ids = kind === "project" ? O.projects(snapshot) : O.entries(snapshot, cwd).map(row => row.key);
    const pins = kind === "project" ? p.pinnedProjects : p.pinnedSessions;
    return ids.filter(key => pins.includes(key) === pinned);
  }
  function orderStep(kind, id, cwd, pinned, direction) {
    const peers = orderPeers(kind, id, cwd, pinned), at = peers.indexOf(id);
    if (at < 0 || at + direction < 0 || at + direction >= peers.length) return;
    void arrangeSidebar({ kind, id, before: direction < 0 ? peers[at - 1] : peers[at + 2] || null });
  }
  function orderActions(kind, id, cwd, pinned) {
    const peers = orderPeers(kind, id, cwd, pinned), at = peers.indexOf(id);
    return [[t(pinned ? "unpin" : "pin"), () => void arrangeSidebar({ kind, id, pinned: !pinned })],
      ...(at > 0 ? [[t("moveUp"), () => orderStep(kind, id, cwd, pinned, -1)]] : []),
      ...(at < peers.length - 1 ? [[t("moveDown"), () => orderStep(kind, id, cwd, pinned, 1)]] : [])];
  }
  function reorderRow(surface, source, kind, id, group, pinned, nativeStart) {
    window.StepsembleWorkspaceReorder.attach(surface, source, { kind, id, group, pinned, nativeStart, enabled: () => !sidebarBusy,
      move: before => void arrangeSidebar({ kind, id, before }), keyboard: direction => orderStep(kind, id, group, pinned, direction),
      started: () => { sidebarDragging = true; closePaneMenu(); }, ended: native => { sidebarDragging = false; if (native) dragEnd(); },
    });
  }
  async function arrangeSidebar(input) {
    if (sidebarBusy) return;
    const target = host, epoch = ++sidebarEditEpoch, prior = snapshot.presentation;
    let next;
    try { next = O.arrange(snapshot, input); } catch (error) { toast(error.message); return; }
    sidebarBusy = true; refreshEpoch++;
    snapshot.presentation = next; renderSidebar();
    try {
      const data = await api("/api/workspace/arrange", input, target);
      if (target !== host || epoch !== sidebarEditEpoch) return;
      snapshot.presentation = data.presentation;
      $("workspace-connection").textContent = t("orderingSaved");
      channel?.postMessage({ type: "refresh" });
    } catch (error) {
      if (target !== host || epoch !== sidebarEditEpoch) return;
      snapshot.presentation = prior; toast(error.status === 404 && error.message !== "workspace_order_missing" ? t("sidebarOldHost") : error.message);
    } finally {
      if (target === host && epoch === sidebarEditEpoch) {
        sidebarBusy = false; renderSidebar();
        const row = [...$("workspace-projects").querySelectorAll("[data-reorder-kind]")].find(node => node.dataset.reorderKind === input.kind && node.dataset.reorderId === input.id);
        row?.querySelector("[data-reorder-surface]")?.focus({ preventScroll: true });
        void refresh();
      }
    }
  }
  let connectionNotice = "";
  // The Host card carries the connection state: its dot and second line. The
  // reason is spoken and shown on hover, and a new failure is raised once
  // instead of on every poll.
  function setConnection(online, message) {
    const dot = document.querySelector(".workspace-status-dot");
    if (dot) dot.dataset.state = online ? "online" : "offline";
    $("workspace-host").title = message;
    $("workspace-host-state").dataset.state = online ? "online" : "offline";
    renderHostState();
    const status = $("workspace-connection");
    if (status.textContent !== message) status.textContent = message;
    if (!online && message !== connectionNotice) toast(message);
    connectionNotice = online ? "" : message;
  }
  function requestSnapshot(target) {
    // A slow remote Host must be allowed to finish. Starting a new poll every
    // three seconds would otherwise invalidate every older response forever.
    if (snapshotRequests.has(target)) return snapshotRequests.get(target);
    const request = api("/api/workspace", undefined, target).finally(() => { if (snapshotRequests.get(target) === request) snapshotRequests.delete(target); });
    snapshotRequests.set(target, request);
    return request;
  }
  // What a list redraw depends on, without the states that change in place.
  const listStructure = value => JSON.stringify({ ...value, entries: value.entries.map(({ working, completion, goal, activityAt, ...row }) => ({ ...row, record: { ...row.record, status: undefined } })) });
  function updateRows(target, data) {
    for (const row of document.querySelectorAll(".workspace-session-row")) {
      if ((row.dataset.host || host) !== target) continue;
      const entry = data.entries.find(entry => entry.key === row.dataset.entry); if (entry) sessionStatus(row, entry);
    }
  }
  async function refresh() {
    const epoch = ++refreshEpoch, target = host;
    try { const data = await requestSnapshot(target); if (epoch !== refreshEpoch || target !== host || sidebarBusy || sidebarDragging) return;
      rememberSnapshot(target, data);
      if (JSON.stringify(data) !== JSON.stringify(snapshot)) {
        // Activity changes should not recreate the row under a finger, reset
        // its spinner, or steal keyboard focus from its menu button.
        const structure = value => JSON.stringify({ ...value, entries: value.entries.map(({ working, completion, goal, activityAt, ...row }) => ({ ...row, record: { ...row.record, status: undefined } })) });
        const orderOf = value => JSON.stringify(O.projects(value).map(cwd => O.entries(value, cwd).map(row => row.key)));
        const statusOnly = structure(data) === structure(snapshot), reordered = orderOf(data) !== orderOf(snapshot);
        snapshot = data;
        if (!document.body.classList.contains("workspace-dragging")) {
          if (statusOnly && (!reordered || sidebarHeld())) {
            updateRows(target, data);
            if (reordered) sidebarOrderPending = true;
          }
          else renderSidebar();
        }
      }
      if (!document.body.classList.contains("workspace-dragging")) for (const entry of data.entries) {
        const ref = { host: target, key: entry.key };
        if (allRefs().some(tab => L.identity(tab) === L.identity(ref))) { setRefAgent(ref, entry.record.agentId); setRefTitle(ref, refOf(entry).title); }
      }
      // A closed window can retain an old tab in its saved layout. Reconcile
      // against membership when it opens again, without touching other hosts.
      const available = new Set(data.entries.map(entry => entry.key));
      // A Bot tab is not a session of the Host's list.
      const stale = allRefs().filter(ref => ref.host === target && !ref.assistant && !available.has(ref.key));
      if (stale.length) { let next = tree; for (const ref of stale) next = L.drop(next, ref); commit(next); }
      setConnection(true, `${hostName(host)} · ${t("connected")}`);
      // The other computers' lists, every ten seconds, and those a split pane
      // shows a conversation from at once. An offline computer must not hold
      // up this Host's list.
      const merged = machines.length > 1, now = Date.now();
      const others = new Set([...visibleSessions().map(ref => ref.host), ...(merged ? machines.map(m => m.id).filter(id => now - (machinePolledAt.get(id) || 0) >= 10_000) : [])]);
      for (const id of others) if (id !== target) {
        machinePolledAt.set(id, now);
        void requestSnapshot(id).then(data => {
          if (id === host) return;
          const before = hostSnapshots.get(id), was = machineStatus.get(id);
          rememberSnapshot(id, data); machineStatus.set(id, { online: true, at: Date.now() });
          if (merged && !document.body.classList.contains("workspace-dragging")) {
            if (was?.online !== true || !before || listStructure(before) !== listStructure(data)) { if (sidebarHeld()) sidebarOrderPending = true; else renderSidebar(); }
            else updateRows(id, data);
          }
          probeVisibleResults();
        }, () => {
          const was = machineStatus.get(id);
          machineStatus.set(id, { online: false, at: was?.at || 0 });
          if (!merged) hostSnapshots.delete(id);
          else if (was?.online !== false) { if (sidebarHeld()) sidebarOrderPending = true; else renderSidebar(); }
        });
      }
      probeVisibleResults(); }
    catch (error) { if (epoch === refreshEpoch) setConnection(false, error.message); }
  }
  const remainingLevel = percent => percent <= 10 ? "critical" : percent <= 25 ? "low" : "ok";
  // Numeric window abbreviations stay readable in every locale, and a plan may
  // report any combination of a 5-hour, weekly or monthly allowance.
  function shortWindow(minutes) {
    if (!Number.isFinite(minutes) || minutes <= 0) return null;
    if (minutes % 1440 === 0) return `${minutes / 1440}d`;
    if (minutes % 60 === 0) return `${minutes / 60}h`;
    return `${minutes}m`;
  }
  function providerLogo(name) {
    const value = String(name || "").toLowerCase();
    const logo = node("span", "", "workspace-provider-logo");
    logo.dataset.logo = value.includes("codex") || value.includes("openai") ? "openai"
      : value.includes("claude") ? "claude"
      : value.includes("opencode") ? "opencode"
      : value.includes("minimax") ? "minimax"
      : value.includes("grok") ? "grok" : "unknown";
    if (logo.dataset.logo === "unknown") logo.textContent = String(name || "?").trim().slice(0, 2).toUpperCase();
    logo.setAttribute("aria-hidden", "true");
    return logo;
  }
  // Compact, language-neutral durations: "3d 19h", "2h 15m", "28m".
  function shortDuration(ms) {
    const total = Math.max(0, Math.round(ms / 60000));
    const days = Math.floor(total / 1440), hours = Math.floor((total % 1440) / 60);
    return days ? `${days}d ${hours}h` : hours ? `${hours}h ${total % 60}m` : `${total}m`;
  }
  const windowShape = w => shortWindow(w.windowDurationMins) || w.label;
  // Hovering a provider explains its allowances without leaving the sidebar.
  let usageTip = null;
  function closeUsageTip() { usageTip?.remove(); usageTip = null; }
  function showUsageTip(anchor, provider) {
    closeUsageTip();
    const tip = node("div", "", "workspace-tip");
    tip.append(node("strong", provider.provider, "workspace-tip-title"));
    for (const w of provider.windows) {
      const line = node("span", "", "workspace-tip-row");
      line.append(node("span", windowShape(w), "workspace-tip-key"),
        node("span", window.StepsembleUsageUI.quotaLabel(w), "workspace-tip-value"));
      tip.append(line);
      if (w.resetsAt) {
        tip.append(node("span", t("resetsIn", { duration: shortDuration(w.resetsAt - Date.now()) }), "workspace-tip-note"));
        tip.append(node("span", date(w.resetsAt), "workspace-tip-note workspace-tip-exact"));
      }
    }
    if (provider.status === "cached" && provider.observedAt) tip.append(node("span", t("checked", { date: date(provider.observedAt) }), "workspace-tip-note"));
    document.body.append(tip);
    const box = anchor.getBoundingClientRect(), width = tip.offsetWidth, height = tip.offsetHeight;
    const left = Math.min(Math.max(8, box.left), Math.max(8, innerWidth - width - 8));
    const above = box.top - height - 6;
    tip.style.left = `${Math.round(left)}px`;
    tip.style.top = `${Math.round(above >= 8 ? above : Math.min(box.bottom + 6, innerHeight - height - 8))}px`;
    usageTip = tip;
  }
  addEventListener("resize", closeUsageTip);
  addEventListener("scroll", closeUsageTip, true);
  // The strip stays quiet while every allowance is comfortable: one line and
  // the providers' own logos. A provider close to its limit gets a chip with
  // its tightest window using the selected Remaining/Used display. It opens the shared Limits/Usage view,
  // even when this Host cannot currently report an allowance.
  let usageReading = null;
  function renderUsage(data) {
    usageReading = data;
    const holder = $("workspace-usage");
    closeUsageTip();
    holder.replaceChildren();
    const box = node("div", "", "workspace-limits-box");
    holder.append(box);
    if (!data || !data.providers?.length) {
      const note = data ? t("quotaUnavailable") : t("loadingQuota");
      const strip = button("", () => void usageUI.open(host).catch(error => toast(error.message)), window.StepsembleUsageUI.label("overview") + " · " + note, "workspace-limits-strip workspace-limits-note");
      // The allowances' quiet line, with a muted dot while they are unknown.
      const lead = node("span", "", "workspace-limits-lead");
      lead.append(node("span", "", "workspace-limits-dot"), node("span", note, "workspace-limits-summary"));
      strip.append(lead);
      if (!data) strip.dataset.loading = "true";
      strip.setAttribute("aria-haspopup", "dialog"); strip.setAttribute("aria-controls", "usage-panel"); strip.setAttribute("aria-expanded", String(usageUI.isOpen()));
      box.append(strip);
      holder.setAttribute("aria-label", `${t("quota")} · ${note}`);
      return;
    }
    const rows = data.providers.map(provider => {
      const windows = [...(provider.windows || [])].sort((a, b) =>
        (a.windowDurationMins ?? Infinity) - (b.windowDurationMins ?? Infinity) || a.remainingPercent - b.remainingPercent);
      // The window with the least left is the one that stops work first.
      const tightest = windows.filter(w => Number.isFinite(w.remainingPercent))
        .sort((a, b) => a.remainingPercent - b.remainingPercent)[0] || null;
      return { provider, windows, tightest, level: tightest ? remainingLevel(tightest.remainingPercent) : null };
    });
    const hover = (anchor, row) => {
      if (row.tightest) anchor.addEventListener("pointerenter", () => { if (!usageUI.isOpen()) showUsageTip(anchor, { ...row.provider, windows: row.windows }); });
      anchor.addEventListener("pointerleave", closeUsageTip);
    };
    const spoken = rows.map(row => {
      const summary = row.tightest ? `${usageLabel(row.tightest, row.provider)} · ${window.StepsembleUsageUI.quotaLabel(row.tightest)}` : t("quotaUnavailable");
      return `${row.provider.provider} · ${summary}` + (row.provider.status === "cached" && row.provider.observedAt ? ` · ${t("checked", { date: date(row.provider.observedAt) })}` : "");
    });
    const label = `${window.StepsembleUsageUI.label("overview")} · ${spoken.join(" · ")}`;
    const strip = button("", () => void usageUI.open(host).catch(error => toast(error.message)), label, "workspace-limits-strip");
    strip.removeAttribute("title");
    strip.setAttribute("aria-haspopup", "dialog"); strip.setAttribute("aria-controls", "usage-panel"); strip.setAttribute("aria-expanded", String(usageUI.isOpen()));
    const alerts = rows.filter(row => row.level === "low" || row.level === "critical");
    const lead = node("span", "", "workspace-limits-lead");
    if (alerts.length) {
      strip.dataset.state = "alert";
      if (alerts.length > 2) lead.classList.add("workspace-limits-compact");
      for (const row of alerts) {
        const chip = node("span", "", "workspace-limit-alert");
        chip.dataset.level = row.level;
        if (row.provider.status === "cached") chip.dataset.stale = "true";
        chip.append(providerLogo(row.provider.provider), node("span", `${window.StepsembleUsageUI.quotaPercent(row.tightest)}%`, "workspace-limit-percent"),
          node("span", windowShape(row.tightest) || "", "workspace-limit-period"));
        hover(chip, row);
        lead.append(chip);
      }
    } else {
      strip.dataset.state = "ok";
      const known = rows.every(row => row.tightest);
      lead.append(node("span", "", "workspace-limits-dot"), node("span", t(known ? "quotaAllGood" : "quotaKnownGood"), "workspace-limits-summary"));
    }
    const marks = node("span", "", "workspace-limits-marks");
    for (const row of rows) {
      if (alerts.includes(row)) continue;
      const mark = node("span", "", "workspace-limit-mark");
      mark.append(providerLogo(row.provider.provider));
      if (!row.tightest) mark.dataset.unknown = "true";
      if (row.provider.status === "cached") mark.dataset.stale = "true";
      hover(mark, row);
      marks.append(mark);
    }
    strip.append(lead, marks);
    box.append(strip);
    holder.setAttribute("aria-label", label);
  }
  // Allowances change while agents work. The Host keeps a reading for up to
  // two minutes, which is also how often this asks; Refresh, here or in the
  // limits panel, has the Host read the providers again.
  let usageReadAt = 0;
  async function refreshUsage({ fresh = false } = {}) {
    const target = host;
    usageReadAt = Date.now();
    try { const data = await api(fresh ? "/api/workspace/usage?fresh=1" : "/api/workspace/usage", undefined, target); if (target !== host) return;
      renderUsage(data);
    } catch { if (target === host) renderUsage({ providers: [] }); }
  }
  function closeDialog() { dialogEpoch++; if ($("workspace-dialog").open) $("workspace-dialog").close(); $("workspace-dialog").classList.remove("workspace-project-dialog", "workspace-signing-in"); $("workspace-dialog-body").replaceChildren(); }
  function dialog(title) { dialogEpoch++; const modal = $("workspace-dialog"); modal.classList.remove("workspace-project-dialog", "workspace-new-session-dialog", "workspace-signing-in"); $("workspace-dialog-title").textContent = title; const body = $("workspace-dialog-body"); body.replaceChildren(); if (!modal.open) modal.showModal(); return body; }
  function addProject() {
    const body = dialog(t("addProject")), epoch = dialogEpoch, target = host;
    $("workspace-dialog").classList.add("workspace-project-dialog");
    const pathLabel = node("label", t("folderPath"), "workspace-folder-label");
    pathLabel.htmlFor = "workspace-folder-path";
    const pathRow = node("div", "", "workspace-folder-path-row");
    const pathInput = node("input"); pathInput.id = "workspace-folder-path"; pathInput.type = "text"; pathInput.autocomplete = "off"; pathInput.spellcheck = false;
    let current = null, sequence = 0, historyPaths = [], historyIndex = -1;
    const back = button("", () => { if (historyIndex > 0) void navigate(historyPaths[historyIndex - 1], historyIndex - 1); }, t("backFolder"), "btn workspace-folder-nav");
    const forward = button("", () => { if (historyIndex < historyPaths.length - 1) void navigate(historyPaths[historyIndex + 1], historyIndex + 1); }, t("forwardFolder"), "btn workspace-folder-nav");
    const up = button("", () => { if (current?.parent && current.parent !== current.path) void navigate(current.parent); }, t("parent"), "btn workspace-folder-nav");
    back.append(icon("M19 12H5m6-6-6 6 6 6"));
    forward.append(icon("M5 12h14m-6-6 6 6-6 6"));
    up.append(icon("M12 19V5m-6 6 6-6 6 6"));
    const go = button(t("go"), () => { if (pathInput.value.trim()) void navigate(pathInput.value); }, t("goToFolder"), "btn workspace-folder-go");
    pathInput.addEventListener("keydown", event => { if (event.key === "Enter") { event.preventDefault(); if (pathInput.value.trim()) void navigate(pathInput.value); } });
    pathInput.addEventListener("input", () => {
      select.disabled = !current || pathInput.value !== current.path || current.selectable === false;
      go.disabled = !pathInput.value.trim() || pathInput.value === current?.path;
    });
    pathRow.append(back, forward, up, pathInput, go);
    const browseHead = node("div", "", "workspace-folder-browse-head");
    browseHead.append(node("strong", t("foldersHere")));
    const search = node("input"); search.type = "search"; search.placeholder = t("filterFolders"); search.setAttribute("aria-label", t("filterFolders"));
    // A new project often needs a folder of its own: made here, inside the
    // folder shown, then opened so it can be added.
    const newFolder = button("", () => openNewFolder(), t("newFolder"), "btn workspace-folder-new");
    newFolder.append(icon("M12 5v14M5 12h14"), node("span", t("newFolder")));
    newFolder.disabled = true;
    browseHead.append(search, newFolder);
    let creating = null;
    let list = node("div", "", "workspace-folder-list");
    // A scrolling region takes focus so Home, End and the arrow keys move it.
    list.setAttribute("role", "region"); list.setAttribute("aria-label", t("foldersHere")); list.tabIndex = 0;
    // Each folder gets a new scrolling region. A scroll still animating in
    // the old one (after End or a flick) would otherwise carry on in the new
    // listing; some browsers keep it going even when the position is set.
    function freshList() {
      const next = list.cloneNode(false), focused = document.activeElement === list;
      list.replaceWith(next); list = next;
      if (focused) next.focus({ preventScroll: true });
    }
    const footer = node("div", "", "workspace-folder-footer");
    footer.append(node("small", t("projectInfo")));
    const select = button(t("addFolder"), async () => {
      if (!current || select.disabled) return;
      const chosen = current.path; select.disabled = true;
      try { await api("/api/workspace/project", { cwd: chosen }, target); closeDialog(); await refresh(); }
      catch (error) { toast(error.message); select.disabled = !current || pathInput.value !== current.path || current.selectable === false; }
    }, t("addFolder"), "btn primary workspace-folder-add");
    select.disabled = true; footer.append(select);
    body.append(pathLabel, pathRow, browseHead, list, footer);
    function renderEntries() {
      list.replaceChildren();
      // A filtered listing starts at its top.
      list.scrollTop = 0;
      if (creating) list.append(creating);
      const entries = (current?.entries || []).filter(entry => entry.name.toLocaleLowerCase().includes(search.value.trim().toLocaleLowerCase()));
      if (!entries.length) {
        if (creating && !search.value.trim()) return;
        list.append(node("p", search.value.trim() ? t("noFolderMatches") : t("noFolders"), "workspace-folder-empty"));
        return;
      }
      for (const entry of entries) {
        const row = button("", () => { void navigate(entry.path || `${current.path}/${entry.name}`); }, entry.name, "btn workspace-folder-row");
        row.append(node("span", "", "workspace-folder-icon"), node("span", entry.name, "workspace-folder-name"), icon("m9 5 7 7-7 7", "workspace-folder-chevron"));
        list.append(row);
      }
    }
    search.addEventListener("input", renderEntries);
    const folderError = error => error?.status === 409 ? t("folderExists")
      : error?.message === "name_invalid" ? t("folderNameInvalid")
      : error?.status === 404 && error?.message === "not found" ? t("folderOldHost")
      : error?.code === "folder_waiting" ? t(error.detail?.platform === "darwin" ? "folderWaitingMac" : "folderWaiting", { host: hostName(target) })
      // The system refused rather than the folder: macOS privacy protection,
      // or Windows Controlled folder access.
      : error?.code === "not_writable" && error.detail?.platform === "darwin" && error.detail?.reason === "EPERM" ? t(error.detail?.app === true ? "folderPrivacyApp" : "folderPrivacy", { host: hostName(target) })
      : error?.code === "not_writable" && error.detail?.platform === "win32" ? t("folderWindowsProtected", { runtime: error.detail.runtime || "node.exe" })
      : error?.status === 403 ? t("folderNotAllowed") : t("folderCreateFailed");
    // A folder the Host could not read says why, and what to do on that Host:
    // allow Stepsemble (or, without the app, its Node.js) on a Mac, answer a
    // dialog there, or try again later.
    function folderProblem(error, retry) {
      const box = node("div", "", "workspace-folder-problem"), detail = error?.detail || {}, where = hostName(target);
      // Stepsemble.app started that Host: its window asks macOS for access.
      const viaApp = detail.app === true;
      const message = error?.code === "folder_privacy" ? t(viaApp ? "folderPrivacyApp" : "folderPrivacy", { host: where })
        : error?.code === "folder_waiting" ? t(detail.platform === "darwin" ? "folderWaitingMac" : "folderWaiting", { host: where })
        : error?.code === "folder_permission" ? t("folderPermission")
        : error?.message || t("loadFailed");
      // Guidance reads as text; only an error the dialog cannot explain is red.
      const known = ["folder_privacy", "folder_waiting", "folder_permission"].includes(error?.code);
      box.append(node("p", message, known ? "workspace-folder-empty workspace-folder-guide" : "workspace-folder-empty workspace-folder-error"));
      if (!known) return box;
      const actions = node("div", "", "workspace-folder-problem-actions");
      if (error.code === "folder_privacy") {
        const label = t(viaApp ? "openStepsembleApp" : "openPrivacySettings", { host: where });
        const openSettings = button(label, async () => {
          openSettings.disabled = true;
          try {
            const opened = await api("/api/host/privacy-settings", {}, target);
            toast(t(opened?.app === true ? "stepsembleAppOpened" : "privacySettingsOpened", { host: where }));
          }
          catch (failure) { toast(failure.code === "open_failed" ? t(viaApp ? "stepsembleAppFailed" : "privacySettingsFailed", { host: where }) : failure.message); }
          finally { openSettings.disabled = false; }
        }, label, "btn ghost workspace-folder-privacy");
        actions.append(openSettings);
      }
      actions.append(button(t("tryAgain"), retry, t("tryAgain"), "btn ghost workspace-folder-retry"));
      box.append(actions);
      // The actions come first; the Node.js path is the detail below them,
      // shown only when that Node.js is what macOS asks about.
      if (error.code === "folder_privacy" && !viaApp && typeof detail.runtime === "string" && detail.runtime) {
        box.append(node("p", t("folderRuntime", { host: where }), "workspace-folder-runtime-label"), node("code", detail.runtime, "workspace-folder-runtime"));
      }
      return box;
    }
    function closeNewFolder() { creating?.remove(); creating = null; renderEntries(); newFolder.focus(); }
    function openNewFolder() {
      if (!current || current.selectable === false) return;
      if (creating) { creating.querySelector("input")?.focus(); return; }
      const form = node("form", "", "workspace-folder-create");
      const input = node("input"); input.type = "text"; input.autocomplete = "off"; input.spellcheck = false; input.maxLength = 200;
      input.placeholder = t("folderName"); input.setAttribute("aria-label", t("folderName"));
      const make = button(t("createFolder"), null, t("createFolder"), "btn primary workspace-folder-create-go"); make.type = "submit";
      const cancel = button(t("cancel"), () => closeNewFolder(), t("cancel"), "btn ghost workspace-folder-create-cancel");
      const note = node("p", "", "workspace-folder-create-error"); note.hidden = true; note.setAttribute("role", "alert");
      form.append(node("span", "", "workspace-folder-icon"), input, make, cancel, note);
      input.addEventListener("keydown", event => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); closeNewFolder(); } });
      form.addEventListener("submit", async event => {
        event.preventDefault();
        const name = input.value.trim(), parent = current?.path;
        if (!name || !parent) { input.focus(); return; }
        make.disabled = true; input.disabled = true; note.hidden = true;
        try {
          const made = await api("/api/browse/folder", { parent, name }, target);
          if (epoch !== dialogEpoch) return;
          creating = null;
          await navigate(made.path);
        } catch (error) {
          if (epoch !== dialogEpoch || creating !== form) return;
          make.disabled = false; input.disabled = false;
          note.textContent = folderError(error); note.hidden = false;
          input.focus(); input.select();
        }
      });
      creating = form;
      search.value = "";
      renderEntries();
      input.focus();
    }
    function updateNavigation() {
      back.disabled = historyIndex <= 0;
      forward.disabled = historyIndex < 0 || historyIndex >= historyPaths.length - 1;
      up.disabled = !current?.parent || current.parent === current.path;
      go.disabled = !pathInput.value.trim() || pathInput.value === current?.path;
    }
    async function navigate(path, historyTarget = null) {
      if (historyTarget === null && path && path === current?.path) return;
      const request = ++sequence;
      select.disabled = true; back.disabled = true; forward.disabled = true; up.disabled = true; go.disabled = true; search.disabled = true; newFolder.disabled = true;
      creating = null;
      freshList();
      list.replaceChildren(node("p", t("loading"), "workspace-folder-empty"));
      try {
        const data = await api(`/api/browse${path ? `?path=${encodeURIComponent(path)}` : ""}`, undefined, target);
        if (epoch !== dialogEpoch || request !== sequence) return;
        if (historyTarget !== null) { historyIndex = historyTarget; historyPaths[historyIndex] = data.path; }
        else if (historyPaths[historyIndex] !== data.path) {
          historyPaths = [...historyPaths.slice(0, historyIndex + 1), data.path]; historyIndex++;
        }
        current = data; pathInput.value = data.path; pathInput.scrollLeft = pathInput.scrollWidth; search.value = "";
        select.disabled = data.selectable === false;
        newFolder.disabled = data.selectable === false;
        search.disabled = false; updateNavigation();
        renderEntries();
      } catch (error) {
        if (epoch !== dialogEpoch || request !== sequence) return;
        updateNavigation();
        list.replaceChildren(folderProblem(error, () => void navigate(path, historyTarget)));
      }
    }
    void navigate();
  }
  async function newSession(cwd, target = host) {
    const body = dialog(t("newSession")), epoch = dialogEpoch;
    $("workspace-dialog").classList.add("workspace-new-session-dialog");
    body.append(node("small", `${hostName(target)} · ${cwd}`));
    // The agent and the name share one row; the action sits on its own, compact.
    const fields = node("div", "", "workspace-new-session-fields"), actions = node("div", "", "workspace-new-session-actions");
    const name = node("input"); name.type = "text"; name.autocomplete = "off"; name.placeholder = t("optionalName"); name.setAttribute("aria-label", t("sessionName"));
    const select = node("select"); select.setAttribute("aria-label", "Agent");
    // An agent that can work in its own Git worktree offers it here, as the
    // conversation page's New project did.
    const worktreeBox = node("input"); worktreeBox.type = "checkbox"; worktreeBox.id = "workspace-new-worktree";
    const worktree = node("label", "", "workspace-new-session-worktree"); worktree.htmlFor = worktreeBox.id; worktree.title = t("worktreeNote");
    worktree.append(worktreeBox, node("span", t("worktree"))); worktree.hidden = true;
    const capabilities = new Map();
    const syncWorktree = () => {
      const listed = capabilities.get(select.value), allowed = !Array.isArray(listed) || listed.includes("worktree");
      worktree.hidden = !allowed; if (!allowed) worktreeBox.checked = false;
    };
    select.addEventListener("change", syncWorktree);
    // An agent that is not signed in yet is offered its own sign-in here, in
    // a pane that runs that agent's sign-in command; the session then starts.
    const notice = node("div", "", "workspace-signin"); notice.hidden = true;
    let signInFrame = null;
    const signInError = error => /_auth_required|sign_in_required|login_required|not_signed_in|unauthenticated/.test(`${error?.code || ""} ${error?.message || ""}`)
      || /\b(?:sign in|signed in|log in|logged in|authenticat|unauthori[sz]ed)/i.test(String(error?.message || ""));
    function offerSignIn(agentId) {
      const label = [...select.options].find(option => option.value === agentId)?.textContent || agentId;
      $("workspace-dialog").classList.remove("workspace-signing-in");
      notice.replaceChildren(node("p", t("signInNeeded", { agent: label, host: hostName(target) })),
        button(t("signIn"), () => startSignIn(agentId), t("signIn"), "btn primary workspace-signin-start"));
      notice.hidden = false;
    }
    function startSignIn(agentId) {
      const url = new URL("/index.html", location.origin);
      url.searchParams.set("pane", "1"); url.searchParams.set("host", target); url.searchParams.set("signin", agentId);
      signInFrame = node("iframe", "", "workspace-signin-frame"); signInFrame.title = t("signIn"); signInFrame.src = url.href;
      // The sign-in terminal takes all the room the dialog has.
      $("workspace-dialog").classList.add("workspace-signing-in");
      notice.replaceChildren(signInFrame);
    }
    function onSignIn(event) {
      if (epoch !== dialogEpoch) { window.removeEventListener("message", onSignIn); return; }
      if (event.origin !== location.origin || !signInFrame || event.source !== signInFrame.contentWindow || event.data?.type !== "workspace-signin") return;
      const agentId = String(event.data.agentId || select.value);
      const completed = event.data.state === "completed" || event.data.completed === true;
      // A sign-in that failed stays on screen with its message until the
      // person closes that terminal; only then is Sign in offered again.
      if (!completed && event.data.state !== "closed") return;
      signInFrame = null;
      if (completed) { $("workspace-dialog").classList.remove("workspace-signing-in"); notice.replaceChildren(node("p", t("signedIn"))); if (!start.disabled) start.click(); }
      else offerSignIn(agentId);
    }
    window.addEventListener("message", onSignIn);
    const start = button(t("create"), async () => {
      start.disabled = true;
      try {
        const data = await api("/api/agent/open", { agentId: select.value, cwd, name: name.value.trim() || null, ...(worktreeBox.checked && !worktree.hidden ? { worktree: true } : {}) }, target);
        if (!data.workspaceEntry) throw new Error(data.workspaceError || t("createdUntracked"));
        closeDialog(); const entry = data.workspaceEntry;
        open({ host: target, key: entry.key, title: plainTitle(entry.record.name) || select.value }); await refresh();
      } catch (error) {
        if (signInError(error)) { start.disabled = false; offerSignIn(select.value); return; }
        // Claude Code refuses a folder its helper does not hold yet.
        const folder = { claude_folder_pending: "claudeFolderPending", desktop_workspace_denied: "claudeFolderDenied" }[error.code || error.message];
        toast(folder ? t(folder) : error.message); start.disabled = !(error.status >= 400 && error.status < 500); if (start.disabled) body.append(node("p", t("createUncertain")));
      }
    }, t("create"), "btn primary workspace-new-session-create"); start.disabled = true;
    name.addEventListener("keydown", event => { if (event.key === "Enter" && !event.isComposing && !start.disabled) { event.preventDefault(); start.click(); } });
    select.addEventListener("change", () => { if (!signInFrame) notice.hidden = true; });
    fields.append(select, name); actions.append(worktree, start); body.append(fields, actions, notice);
    try { const data = await api("/api/agents", undefined, target); if (epoch !== dialogEpoch) return; for (const agent of data.connectors || []) if (window.StepsembleAgentIdentity?.startsConversations ? window.StepsembleAgentIdentity.startsConversations(agent) : agent.installed && agent.category !== "personal") { const opt = node("option", agent.label || agent.name || agent.id); opt.value = agent.id; select.append(opt); capabilities.set(agent.id, agent.capabilities); } syncWorktree(); start.disabled = !select.options.length; if (!select.options.length) body.append(node("p", t("noAgents"))); }
    catch (error) { if (epoch === dialogEpoch) body.append(node("p", error.message)); }
  }
  async function history() {
    const body = dialog(t("history")), epoch = dialogEpoch, target = host;
    body.append(node("p", t("historyInfo")));
    // Each agent's own history, read only, in a tab of its own.
    const reader = node("a", t("historyReader"), "workspace-history-reader");
    reader.href = target === self ? "/history.html" : `/history.html?machine=${encodeURIComponent(target)}`;
    reader.target = "_blank"; reader.rel = "noopener noreferrer";
    body.append(reader);
    const search = node("input"); search.type = "search"; search.placeholder = t("historyPlaceholder"); search.setAttribute("aria-label", t("searchHistory"));
    // Sub Agent sessions run in temporary folders and stay hidden until asked for.
    // The choice is saved with the other settings.
    const subAgents = node("label", "", "workspace-history-filter"), subAgentsBox = node("input"), subAgentsText = node("span");
    subAgentsBox.type = "checkbox"; subAgentsBox.checked = prefs.showTemporarySessions; subAgents.append(subAgentsBox, subAgentsText); subAgents.hidden = true;
    subAgentsBox.onchange = () => {
      try { I.savePreference(localStorage, { showTemporarySessions: subAgentsBox.checked }); } catch {}
      prefs = { ...prefs, showTemporarySessions: subAgentsBox.checked }; limit = 50; show();
    };
    const status = node("p", t("loading")), list = node("div"), more = button(t("more"), () => { limit += 50; show(); });
    let rows = [], limit = 50; body.append(search, subAgents, status, list, more); more.hidden = true;
    function show() {
      const query = search.value.trim().toLowerCase(), filtered = rows.filter(r => (prefs.showTemporarySessions || !r.record.isTemporary)
        && `${r.record.name} ${r.record.agentId} ${r.record.cwd}`.toLowerCase().includes(query));
      list.replaceChildren(); more.hidden = limit >= filtered.length;
      // A Host with no other history says so; a search with no match keeps the count.
      status.textContent = rows.length ? t("count", { count: filtered.length }) : t("historyEmpty");
      for (const row of filtered.slice(0, limit)) {
        const item = node("article", "", "workspace-history-row"), copy = node("div"); copy.append(node("strong", row.record.name || row.record.firstMessage || row.record.agentId || "Pi"), node("small", `${row.record.agentId || "pi"} · ${row.record.cwd || ""}`));
        const add = button(t("addWorkspace"), async () => { add.disabled = true; try { await api("/api/workspace/adopt", { kind: row.kind, reference: row.reference }, target); add.textContent = t("added"); add.title = t("added"); add.setAttribute("aria-label", t("added")); await refresh(); } catch (error) { toast(error.message); add.disabled = false; } });
        item.append(copy, button(t("view"), () => previewHistory(row, target)), add); list.append(item);
      }
    }
    search.oninput = () => { limit = 50; show(); };
    const results = await Promise.allSettled([api("/api/sessions?includeTemporary=1", undefined, target), api("/api/agent-tasks", undefined, target)]);
    if (epoch !== dialogEpoch) return;
    const [pi, agents] = results;
    rows = [...(pi.status === "fulfilled" ? pi.value.sessions.map(record => ({ kind: "pi_history", reference: record.file, record })) : []), ...(agents.status === "fulfilled" ? agents.value.tasks.filter(r => r.agentId !== "pi").map(record => ({ kind: "task_record", reference: record.id || record.taskId, record })) : [])];
    rows = rows.filter(row => !snapshot.entries.some(entry => row.kind === "pi_history"
      ? entry.record.agentId === "pi" && entry.record.file === row.reference
      : (entry.record.id || entry.record.taskId) === row.reference
        || (entry.record.agentId === row.record.agentId && row.record.nativeHistorySessionId
          && [entry.record.nativeSessionId, entry.record.nativeThreadId].includes(row.record.nativeHistorySessionId))));
    const temporary = rows.filter(row => row.record.isTemporary === true).length;
    subAgentsText.textContent = t("showSubAgents", { count: temporary }); subAgents.hidden = temporary === 0;
    show(); if (results.some(r => r.status === "rejected")) status.textContent += ` · ${t("partialFailure")}`;
  }
  async function previewHistory(row, target) {
    const body = dialog(row.record.name || t("sessionHistory")), epoch = dialogEpoch;
    body.append(button(t("backHistory"), history)); const content = node("pre", t("loading")); content.style.cssText = "white-space:pre-wrap;overflow-wrap:anywhere;font:inherit"; body.append(content);
    try {
      let data;
      if (row.kind === "pi_history") data = await api(`/api/session?file=${encodeURIComponent(row.reference)}`, undefined, target);
      else if (row.record.nativeHistoryReadonly && /^(claude-history|codex-history):/.test(row.reference)) data = await api(`/api/native-history/session?taskId=${encodeURIComponent(row.reference)}`, undefined, target);
      else data = await api(`/api/agent-task?taskId=${encodeURIComponent(row.reference)}`, undefined, target);
      if (epoch !== dialogEpoch) return;
      content.textContent = Array.isArray(data.messages) ? data.messages.map(m => `${m.role || ""}\n${m.text || ""}`).join("\n\n") : data.task?.outputTail || t("historyMetadata");
      if (data.hasMore || data.truncated) content.append(document.createTextNode(`\n\n(${t("partialHistory")})`));
    } catch (error) { if (epoch === dialogEpoch) content.textContent = error.message; }
  }
  if (channel) channel.onmessage = ({ data }) => {
    try {
      if (data.type === "drag") { document.body.classList.toggle("workspace-dragging", data.active === true); reportDragRegions(); }
      if (data.type === "moved" && data.source === windowId) {
        const pending = pendingTransfers.get(data.transfer);
        if (pending?.drag && L.identity(pending.ref) === L.identity(L.reference(data.ref))) { pendingTransfers.delete(data.transfer); commit(L.drop(tree, pending.ref)); }
      }
      if (data.type === "window-ready" && data.source === windowId) { const pending = pendingTransfers.get(data.token); if (pending?.target === data.target) { pendingTransfers.delete(data.token); commit(L.drop(tree, pending.ref)); } }
      if (data.type === "untracked") untrackMembership(data.host, data.keys, false);
      if (data.type === "refresh") void refresh();
    } catch {}
  };
  window.addEventListener("message", event => {
    if (event.origin !== location.origin) return;
    if (settingsLayer && event.source === settingsLayer.querySelector("iframe")?.contentWindow) {
      if (event.data?.type === "workspace-settings-close") closeSettings();
      if (event.data?.type === "workspace-settings-host" && machines.some(machine => machine.id === event.data.host)) selectHost(event.data.host);
      return;
    }
    const item = [...frames.values()].find(item => item.frame.contentWindow === event.source);
    if (!item) return;
    if (event.data?.type === "workspace-composer-rect") {
      const r = event.data.rect;
      item.composerRect = r && [r.x, r.y, r.width, r.height].every(Number.isFinite) && r.width > 0 && r.height > 0 ? { x: r.x, y: r.y, width: r.width, height: r.height } : null;
      return;
    }
    if (item.ref.assistant) {
      const data = event.data || {};
      if (data.type === "assistant-route" && data.route && typeof data.route === "object") updateAssistantTab(item.ref, { route: WAM.tabRoute(data.route), title: data.title, avatar: data.avatar });
      if (data.type === "assistant-close") commit(L.drop(tree, item.ref));
      if (data.type === "assistant-changed") {
        const profile = typeof data.profile === "string" ? data.profile : null;
        assistantUI.changed(profile);
        if (profile) for (const tab of allRefs()) if (tab.assistant?.profile === profile) updateTabMetadata(tab);
      }
      // The tab that only signed in to Hermes has done its job.
      if (data.type === "assistant-signed-in") { assistantUI.changed(); if (item.ref.assistant.page === "home") commit(L.drop(tree, item.ref)); }
    }
    if (event.data?.type === "workspace-select-tab" && !item.frame.hidden) {
      const pane = L.leaves(tree).find(p => p.active === L.identity(item.ref));
      if (pane) selectAdjacentTab(event.data.direction, pane.id);
    }
    if (event.data?.type === "workspace-read-ready") void markViewed(item, event.data.completionId);
    if (event.data?.type === "workspace-ready") { void refresh(); }
    if (event.data?.type === "workspace-focus") { const p = L.leaves(tree).find(p => p.tabs.some(r => L.identity(r) === L.identity(item.ref))); if (p) { focused = p.id; for (const pane of document.querySelectorAll(".workspace-pane")) pane.dataset.focused = String(pane.dataset.pane === focused); } }
    if (event.data?.type === "workspace-workflows-changed") {
      void refresh();
      for (const peer of frames.values()) peer.frame.contentWindow?.postMessage({ type: "workspace-workflows-changed" }, location.origin);
    }
    if (event.data?.type === "workspace-title") setRefTitle(item.ref, event.data.title);
    if (event.data?.type === "workspace-show-list" && mobile()) {
      if (window.history.state?.stepsembleWorkspaceView === "session") window.history.back();
      else showMobileList();
    }
    if (event.data?.type === "workspace-refresh") { void refresh(); channel?.postMessage({ type: "refresh" }); }
    // A conversation this one made (Branch in new chat), on the same Host,
    // opens in a pane beside it, or in its place when no more panes fit.
    if (event.data?.type === "workspace-open" && typeof event.data.key === "string" && event.data.key && event.data.key.length <= 256) {
      const pane = L.leaves(tree).find(p => p.tabs.some(r => L.identity(r) === L.identity(item.ref)));
      const beside = !mobile() && pane && L.leaves(tree).length < 8;
      open({ host: item.ref.host, key: event.data.key, title: String(event.data.title || "").slice(0, 160) }, pane?.id || focused, beside ? "right" : "center");
      void refresh();
    }
  });
  const workflowUI = window.StepsembleWorkflows.create({ api,
    async context(target = host) { target ||= host; const data = await api("/api/workspace", undefined, target); return {target, hostName:hostName(target), projects:data.projects, entries:data.entries}; },
    openConversation(key, title, target) { open({host:target,key,title}); void refresh(); },
    onChanged() { void refresh(); for (const item of frames.values()) item.frame.contentWindow?.postMessage({type:"workspace-workflows-changed"},location.origin); },
  });
  const usageUI = window.StepsembleUsageUI.create({ api,
    context: () => ({ selected: host, hosts: machines.map(machine => ({ id: machine.id, name: machine.name || machine.id })) }),
    openConversation(key, title, target) { open({ host: target, key, title }); },
    providerLogo,
    onHostSelected: selectHost,
    onQuotaUpdated(target, data) { if (target === host) { usageReadAt = Date.now(); renderUsage(data); } },
    onQuotaDisplayChanged() { renderUsage(usageReading); },
    openQuotaSources(target) { selectHost(target); openSettings("quota-sources"); },
    restoreFocus() { document.querySelector(".workspace-limits-strip")?.focus({ preventScroll: true }); },
    onVisibility() { closeUsageTip(); document.querySelector(".workspace-limits-strip")?.setAttribute("aria-expanded", String(usageUI.isOpen())); reportDragRegions(); notificationPresence(); },
  });
  // A Goal runs inside its conversation; this button opens Schedules.
  function labelWorkflows() {
    const label = window.StepsembleWorkflows.label("schedules");
    $("workspace-workflows-label").textContent = label;
    $("workspace-workflows").title = label;
    $("workspace-workflows").setAttribute("aria-label", label);
  }
  labelWorkflows();
  $("workspace-workflows").onclick = () => workflowUI.open().catch(error => toast(error.message));
  $("workspace-routines").onclick = () => { if (assistantUI.machine) openAssistant(assistantUI.machine.id, { page: "routines" }); };
  function showMobileList() {
    if (!mobile()) return;
    document.body.classList.remove("sidebar-hidden");
    renderSidebar();
    requestAnimationFrame(layoutFrames);
    void refresh();
  }
  // Settings open over the Workspace, in this window. Closing them (Back at
  // their top level, Escape or the edge swipe) comes back to the panes as
  // they were: they are not reloaded. They used to open in a second window,
  // which on closing loaded a second Workspace.
  let settingsLayer = null;
  let settingsCovered = [];
  function openSettings(section = null) {
    if (settingsLayer) return;
    const url = new URL("/index.html", location.origin); url.searchParams.set("settings", "1");
    url.searchParams.set("host", host);
    if (section) url.searchParams.set("section", section);
    const frame = node("iframe", "", "workspace-settings-frame"); frame.title = t("settings"); frame.src = url.href;
    settingsLayer = node("div", "", "workspace-settings-layer"); settingsLayer.append(frame);
    settingsCovered = [...document.body.children].filter(child => !child.inert);
    for (const child of settingsCovered) child.inert = true;
    document.body.append(settingsLayer);
    reportDragRegions(); notificationPresence();
    frame.addEventListener("load", () => { try { frame.contentWindow.focus(); } catch {} }, { once: true });
  }
  function closeSettings() {
    if (!settingsLayer) return;
    settingsLayer.remove(); settingsLayer = null;
    for (const child of settingsCovered) child.inert = false;
    settingsCovered = [];
    renderSidebar(); requestAnimationFrame(layoutFrames);
    void refresh(); void refreshUsage();
  }
  window.addEventListener("popstate", showMobileList);
  $("workspace-dialog-close").onclick = closeDialog;
  $("workspace-dialog").addEventListener("cancel", event => { event.preventDefault(); closeDialog(); });
  $("workspace-dialog").addEventListener("click", event => {
    const modal = $("workspace-dialog"), rect = modal.getBoundingClientRect();
    if (event.target === modal && (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom)) closeDialog();
  });
  $("workspace-add").onclick = () => addProject(); $("workspace-history").onclick = history;
  // Refresh reloads the list and the allowances together. The allowances are
  // read from the providers again; the Host answers repeated clicks within
  // 15 seconds with the reading it just took.
  $("workspace-refresh").onclick = async () => {
    const control = $("workspace-refresh");
    if (control.dataset.busy === "true") return;
    control.dataset.busy = "true"; control.setAttribute("aria-busy", "true");
    const started = performance.now();
    try { await Promise.all([refresh(), refreshUsage({ fresh: true })]); }
    finally {
      // A fast Host still shows one visible turn, so the click reads as done.
      setTimeout(() => { delete control.dataset.busy; control.removeAttribute("aria-busy"); }, Math.max(0, 450 - (performance.now() - started)));
    }
  };
  $("workspace-search").oninput = () => { assistantUI.setQuery($("workspace-search").value.trim()); renderSidebar(); };
  function selectHost(value) {
    if (!machines.some(machine => machine.id === value) || value === host) return;
    window.StepsembleWorkspaceReorder.cancel(); sidebarEditEpoch++; sidebarBusy = false;
    host = value; $("workspace-host").value = host;
    try { localStorage.setItem("stepsemble.selected.v1", host); } catch {}
    snapshot = hostSnapshots.get(host) || { projects: [], entries: [] }; renderUsage(null); renderSidebar(); usageUI.followHost(host); void refresh(); void refreshUsage();
  }
  $("workspace-host").onchange = () => selectHost($("workspace-host").value);
  $("workspace-sidebar-close").onclick = () => { document.body.classList.add("sidebar-hidden"); requestAnimationFrame(layoutFrames); };
  $("workspace-settings").onclick = () => openSettings();
  window.addEventListener("dragend", dragEnd); window.addEventListener("drop", dragEnd);
  window.addEventListener("storage", event => {
    if (event.key !== null && !/^(stepsemble|piharbor|piweb)\.settings\./.test(event.key)) return;
    const next = readPreferences();
    if (JSON.stringify(next) === JSON.stringify(prefs)) return;
    prefs = next; applyPreferences(); closeDialog(); render(); void refresh(); void refreshUsage();
  });
  // "Follow system" has to follow the system while the shell stays open.
  matchMedia("(prefers-color-scheme: dark)").addEventListener?.("change", () => {
    if (prefs.theme !== "auto") return;
    prefs = readPreferences(); applyPreferences();
  });
  let wasMobile = mobile();
  window.addEventListener("resize", () => {
    if (mobile() !== wasMobile) { wasMobile = mobile(); document.body.classList.remove("sidebar-hidden"); render(); }
    else layoutFrames();
  });
  window.addEventListener("pagehide", () => { try { save(); } catch {} });
  window.addEventListener("pageshow", event => { if (event.persisted) location.reload(); });
  // Coming back to the Workspace (another app, a locked phone) shows current
  // allowances, not the ones from before it was left.
  document.addEventListener("visibilitychange", () => { if (document.hidden) return; if (booted) { void refresh(); if (Date.now() - usageReadAt > 60000) void refreshUsage(); } else retryBoot(); });
  window.addEventListener("online", () => { if (booted) void refresh(); else retryBoot(); });
  setInterval(() => { if (!document.hidden && host) void refresh(); }, 3000);
  setInterval(() => { if (!document.hidden && host) void refreshUsage(); }, 120000);
  // A Workspace opened while its host cannot be reached keeps trying, so it
  // connects by itself once the host answers instead of needing a reload.
  let booted = false, booting = false, bootTimer = 0, bootAttempt = 0, pendingUsage = null;
  function retryBoot() { clearTimeout(bootTimer); bootTimer = 0; void boot(); }
  // The assistant switch appears once any computer here runs Hermes. Older
  // Hosts without the route simply answer 404 and are skipped.
  async function checkAssistant() { await assistantUI.discover(); }
  async function boot() {
    if (booted || booting) return;
    booting = true;
    try {
      let res;
      try { res = await fetch("/api/machines", { credentials: "same-origin", cache: "no-store" }); }
      catch { throw new Error(t("hostsFailed")); }
      if (res.status === 401) {
        const login = new URL("/index.html", location.origin); login.searchParams.set("returnWorkspace", "1");
        for (const key of ["window", "ack", "source", "host", "entry", "usageTab", "usageAgent"]) if (params.has(key)) login.searchParams.set(key, params.get(key));
        location.replace(login.href); return;
      }
      if (!res.ok) throw new Error(t("hostsFailed"));
      const data = await res.json(); machines = data.machines; self = data.current || data.selfId || machines.find(m => m.self)?.id;
      let savedHost = null; try { savedHost = localStorage.getItem("stepsemble.selected.v1"); } catch {}
      const preferred = params.get("host") || savedHost;
      host = machines.some(machine => machine.id === preferred) ? preferred : self || machines[0]?.id;
      if (!host) throw new Error(t("noHosts"));
      $("workspace-host").replaceChildren();
      for (const m of machines) { const option = node("option", m.name || m.id); option.value = m.id; $("workspace-host").append(option); }
      $("workspace-host").value = host;
      booted = true;
      renderMode();
      await refresh(); render(); void refreshUsage(); void checkAssistant();
      if (!pendingNotice && params.has("host") && params.has("entry")) pendingNotice = { host: params.get("host"), key: params.get("entry") };
      if (pendingNotice) void openNotification(pendingNotice);
      if (pendingUsage) { openUsageIntent(pendingUsage); pendingUsage = null; }
      else if (params.get("usageTab") === "usage") openUsageIntent({ host: params.has("host") ? params.get("host") : host, agent: params.get("usageAgent") });
      if (params.get("ack") && params.get("source")) { save(); channel?.postMessage({ type: "window-ready", source: params.get("source"), target: windowId, token: params.get("ack") }); }
    } catch (error) {
      setConnection(false, error.message);
      if (!booted) bootTimer = setTimeout(retryBoot, Math.min(10000, 1000 * 2 ** bootAttempt++));
    } finally { booting = false; }
  }
  function visibleSessions() {
    if (document.hidden || !document.hasFocus() || settingsLayer || $("workspace-dialog").open || document.querySelector(".wf-panel[open], .usage-panel[open]")) return [];
    return [...frames.values()].filter(item => !item.ref.assistant && !item.frame.hidden && (!mobile() || document.body.classList.contains("sidebar-hidden"))).slice(0, 8).map(item => ({ host: item.ref.host, key: item.ref.key }));
  }
  function openUsageIntent(value) {
    const target = typeof value.host === "string" && machines.some(m => m.id === value.host) ? value.host : host;
    usageUI.close();
    void usageUI.open(target, undefined, { tab: "usage", agent: value.agent, allHosts: value.host === "" }).catch(error => toast(error.message));
  }
  window.addEventListener("message", event => {
    const value = event.data;
    if (event.source !== window || event.origin !== location.origin || value?.type !== "stepsemble-open-usage") return;
    if (!booted) { pendingUsage = { host: value.host, agent: value.agent }; return; }
    openUsageIntent(value);
  });
  function notificationPresence(worker = null, requestId = null) {
    probeVisibleResults();
    const sessions = visibleSessions(), data = { type: "STEPSEMBLE_NOTIFICATION_PRESENCE", sessions, visible: sessions.length > 0, requestId };
    if (worker) worker.postMessage(data);
    else {
      window.webkit?.messageHandlers?.stepsemble?.postMessage({ type: "notification-presence", sessions });
      if ("serviceWorker" in navigator) void navigator.serviceWorker.getRegistrations().then(rows => rows.forEach(row => row.active?.postMessage(data))).catch(() => {});
    }
  }
  async function openNotification(notice) {
    if (!window.StepsembleNotifications.target(notice)) return;
    pendingNotice = notice; if (!booted) return;
    const epoch = ++noticeEpoch;
    try {
      if (!machines.some(machine => machine.id === notice.host)) throw new Error(t("hostUnavailable"));
      const data = await api("/api/workspace", undefined, notice.host);
      if (epoch !== noticeEpoch) return;
      const entry = data.entries.find(row => row.key === notice.key);
      if (!entry) throw new Error(t("notAdded"));
      closeSettings(); workflowUI.close(); closeDialog(); selectHost(notice.host);
      open({ host: notice.host, key: entry.key, title: plainTitle(entry.record.name) || entry.record.agentId, agentId: entry.record.agentId });
      const url = new URL(location.href); url.searchParams.delete("host"); url.searchParams.delete("entry"); window.history.replaceState(window.history.state, "", url.href);
      pendingNotice = null;
    } catch (error) { if (epoch === noticeEpoch) { pendingNotice = null; toast(error.message); } }
  }
  window.addEventListener("stepsemble-open-notification", event => void openNotification(event.detail));
  for (const name of ["focus", "blur"]) window.addEventListener(name, () => notificationPresence());
  document.addEventListener("visibilitychange", () => notificationPresence());
  setInterval(notificationPresence, 15000);
  if ("serviceWorker" in navigator) {
    void navigator.serviceWorker.register("/sw.js", { updateViaCache: "none" }).catch(() => {});
    navigator.serviceWorker.addEventListener("message", async event => {
      const data = event.data || {};
      if (data.type === "STEPSEMBLE_NOTIFICATION_PRESENCE_REQUEST") { notificationPresence(event.source, data.requestId); return; }
      if (data.type === "STEPSEMBLE_OPEN_NOTIFICATION") { void openNotification(data.notice); return; }
      if (!["STEPSEMBLE_OPEN_AGENT_TASK", "PI_HARBOR_OPEN_AGENT_TASK", "STEPSEMBLE_OPEN_SESSION", "PI_HARBOR_OPEN_SESSION"].includes(data.type)) return;
      try {
        const local = await api("/api/workspace", undefined, self);
        const entry = local.entries.find(row => (data.taskId && [row.record.id, row.record.taskId].includes(data.taskId))
          || (data.file && row.record.agentId === "pi" && row.record.file === data.file));
        if (entry) open({ host: self, key: entry.key, title: plainTitle(entry.record.name) || entry.record.agentId });
        else toast(t("notAdded"));
      } catch (error) { toast(error.message); }
    });
  }
  // A restored URL owns its layout; a second simultaneous copy receives a
  // separate identity instead of racing writes to the same saved layout.
  if (navigator.locks) void navigator.locks.request(`stepsemble.workspace.window.${windowId}`, { ifAvailable: true }, async lock => {
    if (!lock) {
      const url = new URL(location.href); windowId = crypto.randomUUID();
      storageKey = `stepsemble.workspace.layout.v1.${windowId}`;
      url.searchParams.set("window", windowId); url.searchParams.delete("ack"); url.searchParams.delete("source");
      location.replace(url.href); return;
    }
    void boot();
    await new Promise(resolve => window.addEventListener("pagehide", resolve, { once: true }));
  });
  else void boot();
})();
