/* Workspace chrome owns placement only. Provider state belongs to the Host. */
"use strict";
(() => {
  const L = window.StepsembleLayout, I = window.StepsembleWorkspaceI18n, $ = id => document.getElementById(id);
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
    root.style.fontSize = `${prefs.fontScale}%`;
    root.style.setProperty("--workspace-sidebar-width", `${prefs.sidebarWidth}px`);
    document.body.classList.toggle("compact", prefs.compact);
    document.title = `Stepsemble · ${t("workspace")}`;
    for (const element of document.querySelectorAll("[data-workspace-i18n]")) element.textContent = t(element.dataset.workspaceI18n);
    for (const attr of ["aria-label", "title", "placeholder"]) for (const element of document.querySelectorAll(`[data-workspace-${attr}]`)) element.setAttribute(attr, t(element.getAttribute(`data-workspace-${attr}`)));
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
  const collapsedProjects = new Map();
  function collapsedFor(target = host) {
    if (!collapsedProjects.has(target)) {
      let paths = [];
      try { paths = JSON.parse(localStorage.getItem(`stepsemble.workspace.collapsed.v1.${target}`)); } catch {}
      collapsedProjects.set(target, new Set(Array.isArray(paths) ? paths.filter(path => typeof path === "string") : []));
    }
    return collapsedProjects.get(target);
  }
  function saveCollapsed(target = host) {
    try { localStorage.setItem(`stepsemble.workspace.collapsed.v1.${target}`, JSON.stringify([...collapsedFor(target)])); } catch {}
  }
  const frames = new Map(), slots = new Map(), pendingTransfers = new Map();
  let channel;
  try { channel = new BroadcastChannel("stepsemble.workspace.v1"); } catch {}
  try { const saved = JSON.parse(localStorage.getItem(storageKey)); if (saved) { tree = L.normalize(saved.tree); focused = L.leaves(tree).some(p => p.id === saved.focused) ? saved.focused : L.leaves(tree)[0].id; } } catch {}
  const mobile = () => matchMedia("(max-width:760px)").matches;
  const node = (tag, text, className) => { const e = document.createElement(tag); if (text) e.textContent = text; if (className) e.className = className; return e; };
  function button(text, action, label = text, className = "btn") { const b = node("button", text, className); b.type = "button"; b.title = label; b.setAttribute("aria-label", label); b.onclick = action; return b; }
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
  function closePaneMenu() { paneMenu?.element.remove(); paneMenu = null; }
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
    render();
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
    render();
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
  function commit(next) { try { save(next); render(); return true; } catch (error) { toast(error.message); return false; } }
  function untrackMembership(target, keys, broadcast = true) {
    if (!machines.some(machine => machine.id === target) || !Array.isArray(keys)) return;
    const valid = keys.filter(key => typeof key === "string" && /^[a-f0-9-]{36}$/.test(key));
    let next = tree;
    for (const key of valid) next = L.remove(next, { host: target, key });
    if (JSON.stringify(next) !== JSON.stringify(tree)) commit(next);
    if (broadcast) channel?.postMessage({ type: "untracked", host: target, keys: valid });
    void refresh();
  }
  function open(ref, paneId = focused, edge = "center") {
    try {
      const next = L.insert(tree, paneId, ref, edge);
      focused = L.leaves(next).find(p => p.tabs.some(r => L.identity(r) === L.identity(ref))).id;
      maximized = null;
      if (!commit(next)) return false;
      if (mobile()) {
        if (!document.body.classList.contains("sidebar-hidden")) window.history.pushState({ stepsembleWorkspaceView: "session" }, "", location.href);
        document.body.classList.add("sidebar-hidden");
        requestAnimationFrame(layoutFrames);
      }
      return true;
    } catch (error) { toast(error.message); return false; }
  }
  function dragStart(event, ref, fromTab) {
    const payload = { version: 1, ref: L.reference(ref), source: fromTab ? windowId : null, transfer: crypto.randomUUID() };
    if (fromTab) { pendingTransfers.set(payload.transfer, { ref: payload.ref, drag: true }); setTimeout(() => pendingTransfers.delete(payload.transfer), 30000); }
    event.dataTransfer.setData("application/x-stepsemble-session", JSON.stringify(payload));
    event.dataTransfer.effectAllowed = fromTab ? "move" : "copyMove";
    document.body.classList.add("workspace-dragging"); channel?.postMessage({ type: "drag", active: true });
  }
  function dragEnd() { renderSidebar(); document.body.classList.remove("workspace-dragging"); channel?.postMessage({ type: "drag", active: false }); }
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
    if (open(ref, paneId, edge) && payload.source && payload.source !== windowId) {
      channel?.postMessage({ type: "moved", source: payload.source, ref, transfer: payload.transfer });
    }
  }
  function layoutFrames() {
    const bounds = $("workspace-stage").getBoundingClientRect();
    for (const [key, item] of frames) {
      const slot = slots.get(key);
      const visible = slot && slot.getClientRects().length && slot.getBoundingClientRect().width > 0;
      item.frame.hidden = !visible;
      if (!visible) continue;
      const r = slot.getBoundingClientRect();
      Object.assign(item.frame.style, { left: `${r.left - bounds.left}px`, top: `${r.top - bounds.top}px`, width: `${r.width}px`, height: `${r.height}px` });
    }
  }
  const resize = new ResizeObserver(layoutFrames); resize.observe($("workspace-stage"));
  function render() {
    closePaneMenu();
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
      const url = new URL("/index.html", location.origin); url.searchParams.set("pane", "1"); url.searchParams.set("host", ref.host); url.searchParams.set("entry", ref.key);
      frame.src = url.href; frames.set(key, { frame, ref }); $("workspace-frames").append(frame);
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
        const adjust = ratio => { n.ratio = Math.max(.15, Math.min(.85, ratio)); first.style.flex = `${n.ratio} 1 0`; second.style.flex = `${1-n.ratio} 1 0`; divider.setAttribute("aria-valuenow", Math.round(n.ratio*100)); tree = L.replace(tree, n.id, n); layoutFrames(); };
        divider.onkeydown = e => { if (["ArrowLeft", "ArrowUp", "ArrowRight", "ArrowDown"].includes(e.key)) { e.preventDefault(); adjust(n.ratio + (["ArrowLeft", "ArrowUp"].includes(e.key) ? -.05 : .05)); try { save(); } catch (error) { toast(error.message); } } };
        divider.onpointerdown = e => { e.preventDefault(); divider.setPointerCapture(e.pointerId); document.body.classList.add("workspace-resizing"); };
        divider.onpointermove = e => { if (!divider.hasPointerCapture(e.pointerId)) return; const r = split.getBoundingClientRect(); adjust(n.axis === "row" ? (e.clientX-r.left)/r.width : (e.clientY-r.top)/r.height); };
        const finish = () => { document.body.classList.remove("workspace-resizing"); try { save(); } catch (error) { toast(error.message); } };
        divider.onpointerup = finish; divider.onpointercancel = finish; divider.onlostpointercapture = finish;
        split.append(first, divider, second); return split;
      }
      const pane = node("section", "", "workspace-pane"); pane.dataset.focused = String(n.id === focused); pane.dataset.pane = n.id;
      pane.onpointerdown = () => { if (focused !== n.id) { focused = n.id; for (const p of document.querySelectorAll(".workspace-pane")) p.dataset.focused = String(p.dataset.pane === focused); } };
      const tabs = node("div", "", "workspace-tabs");
      const tablist = node("div", "", "workspace-tablist"); tablist.setAttribute("role", "tablist");
      for (const ref of n.tabs) {
        const key = L.identity(ref), tab = node("div", "", "workspace-tab"); tab.setAttribute("aria-selected", String(n.active === key)); tab.draggable = true;
        tab.ondragstart = e => dragStart(e, ref, true); tab.ondragend = dragEnd;
        // Every tab is the same width and starts with its agent's logo; the
        // conversation below it shows no title row of its own.
        const label = button("", () => { n.active = key; focused = n.id; commit(tree); }, `${ref.title} · ${hostName(ref.host)}`, "btn workspace-tab-label");
        label.append(window.StepsembleAgentIdentity.create(document, ref.agentId || "", true), node("span", ref.title, "workspace-tab-title"));
        tab.append(label, button("×", () => commit(L.remove(tree, ref)), t("closeTab", { title: ref.title }))); tablist.append(tab);
      }
      tabs.append(tablist);
      // Layout actions collapse into one overflow control. A permanent row of
      // buttons costs every pane a strip of height that belongs to the
      // conversation, and these actions are occasional.
      const actions = [];
      if (active(n)) actions.push([t("rename"), () => renameSession(active(n))]);
      if (!mobile() && n.tabs.length) {
        for (const [label, edge] of [[t("splitHorizontal"), "right"], [t("splitVertical"), "bottom"]]) actions.push([label, () => {
          if (!active(n)) { toast(t("openFirst")); return; }
          // Split with an empty destination, preserving the current conversation.
          if (L.leaves(tree).length >= 8) { toast(t("paneLimit")); return; }
          const empty = L.pane(); focused = empty.id; maximized = null;
          commit(L.replace(tree, n.id, { type: "split", id: crypto.randomUUID(), axis: edge === "right" ? "row" : "column", ratio: .5, first: n, second: empty }));
        }]);
        // The strip's window button opens an empty window; this one carries the
        // pane's own conversation, so it must not repeat that label.
        actions.push([t("moveWindow"), () => newWindow(active(n))]);
        actions.push([maximized === n.id ? t("restore") : t("maximize"), () => { maximized = maximized ? null : n.id; render(); }]);
      }
      if (mobile() && L.leaves(tree).length > 1) actions.push([t("nextPane"), () => { const panes = L.leaves(tree); focused = panes[(panes.findIndex(p => p.id === focused)+1)%panes.length].id; commit(tree); }]);
      if (n.tabs.length || L.leaves(tree).length > 1) actions.push([t("closePane"), () => { maximized = null; commit(L.closePane(tree, n.id)); }]);
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
      pane.ondragover = e => { if (!Array.from(e.dataTransfer.types).includes("application/x-stepsemble-session")) return; e.preventDefault(); overlay.dataset.edge = edgeAt(e); };
      pane.ondrop = e => { e.preventDefault(); try { acceptTransfer(JSON.parse(e.dataTransfer.getData("application/x-stepsemble-session")), n.id, edgeAt(e)); } catch (error) { toast(error.message); } finally { dragEnd(); } };
      // A pane with no tabs, actions or corner controls keeps no strip, so the
      // invitation to drag a session is the only thing in it.
      if (n.tabs.length || actions.length || corner) pane.append(tabs);
      pane.append(slot, overlay); return pane;
    }
    $("workspace-tree").append(draw(shown)); requestAnimationFrame(layoutFrames); renderSidebar();
  }
  function renderSidebar() {
    const box = $("workspace-projects"); box.replaceChildren(); const search = $("workspace-search").value.trim().toLowerCase();
    const selectedRefs = mobile() ? [active(L.leaves(tree).find(p => p.id === focused) || L.leaves(tree)[0])].filter(Boolean) : L.leaves(tree).map(active).filter(Boolean);
    const openKeys = new Set(selectedRefs.map(L.identity));
    for (const cwd of [...new Set([...snapshot.projects, ...snapshot.entries.map(e => e.record.cwd || "")])]) {
      const matchesProject = !!search && cwd.toLowerCase().includes(search);
      const rows = snapshot.entries.filter(e => (e.record.cwd || "") === cwd && (!search || matchesProject || `${e.record.name} ${e.record.agentId}`.toLowerCase().includes(search)));
      if (search && !matchesProject && !rows.length) continue;
      const section = node("section", "", "workspace-project"), header = node("header");
      const title = cwd.split(/[\\/]/).filter(Boolean).pop() || t("ungrouped");
      const toggle = button("", () => {
        const collapsed = collapsedFor();
        if (collapsed.has(cwd)) collapsed.delete(cwd); else collapsed.add(cwd);
        saveCollapsed();
        const hidden = collapsed.has(cwd) && !search;
        section.dataset.collapsed = String(hidden); toggle.setAttribute("aria-expanded", String(!hidden)); contents.hidden = hidden;
      }, cwd || title, "btn workspace-project-toggle");
      const copy = node("span", "", "workspace-project-copy");
      copy.append(node("strong", title)); if (cwd) copy.append(node("small", cwd));
      toggle.append(icon("m6 9 6 6 6-6", "workspace-project-chevron"), copy);
      const contents = node("div", "", "workspace-project-sessions");
      const hidden = !search && collapsedFor().has(cwd);
      section.dataset.collapsed = String(hidden); contents.hidden = hidden; toggle.setAttribute("aria-expanded", String(!hidden));
      const add = button("", () => newSession(cwd), t("newSession"), "btn workspace-project-add");
      add.append(icon("M12 5v14M5 12h14")); header.append(toggle, add);
      if (cwd) {
        const actions = button("⋯", () => openPaneMenu(actions, [[t("removeProject"), async () => {
          const target = host; actions.disabled = true;
          try {
            const result = await api("/api/workspace/project/remove", { cwd }, target);
            collapsedFor(target).delete(cwd); saveCollapsed(target);
            untrackMembership(target, result.keys);
          } catch (error) { toast(error.message); actions.disabled = false; }
        }]]), t("projectActions"), "btn workspace-project-menu");
        actions.setAttribute("aria-haspopup", "menu"); header.append(actions);
      }
      section.append(header, contents);
      for (const entry of rows) {
        const ref = refOf(entry), identity = window.StepsembleAgentIdentity.lookup(entry.record.agentId);
        const displayTitle = plainTitle(ref.title) || ref.title;
        const row = node("div", "", "workspace-session-row");
        const b = button("", () => open(ref), `${identity.label}: ${displayTitle}`, "btn workspace-session");
        b.dataset.open = String(openKeys.has(L.identity(ref))); b.draggable = true;
        b.append(window.StepsembleAgentIdentity.create(document, entry.record.agentId, true), node("strong", displayTitle));
        b.ondragstart = e => dragStart(e, ref, false); b.ondragend = dragEnd;
        const actions = button("⋯", () => openPaneMenu(actions, [
          [t("rename"), () => renameSession(ref)],
          [t("moveWindow"), () => newWindow(ref)],
          [t("remove"), async () => {
            const target = ref.host; actions.disabled = true;
            try { await api("/api/workspace/remove", { key: entry.key }, target); untrackMembership(target, [entry.key]); }
            catch (error) { toast(error.message); actions.disabled = false; }
          }],
        ]), t("sessionActions"), "btn workspace-session-menu");
        actions.setAttribute("aria-haspopup", "menu");
        b.oncontextmenu = e => { e.preventDefault(); actions.click(); };
        row.append(b, actions); contents.append(row);
      }
      if (!rows.length) contents.append(node("small", t("noSessions"))); box.append(section);
    }
    if (!snapshot.projects.length && !snapshot.entries.length) box.append(node("p", t("empty")));
  }
  let connectionNotice = "";
  // The HOST dot carries the connection state. Its reason is spoken and shown
  // on hover, and a new failure is raised once instead of on every poll.
  function setConnection(online, message) {
    const dot = document.querySelector(".workspace-status-dot");
    if (dot) { dot.dataset.state = online ? "online" : "offline"; dot.parentElement.title = message; }
    const status = $("workspace-connection");
    if (status.textContent !== message) status.textContent = message;
    if (!online && message !== connectionNotice) toast(message);
    connectionNotice = online ? "" : message;
  }
  async function refresh() {
    const epoch = ++refreshEpoch, target = host;
    try { const data = await api("/api/workspace", undefined, target); if (epoch !== refreshEpoch || target !== host) return; if (JSON.stringify(data) !== JSON.stringify(snapshot)) { snapshot = data; if (!document.body.classList.contains("workspace-dragging")) renderSidebar(); }
      if (!document.body.classList.contains("workspace-dragging")) for (const entry of data.entries) {
        const ref = { host: target, key: entry.key };
        if (allRefs().some(tab => L.identity(tab) === L.identity(ref))) { setRefAgent(ref, entry.record.agentId); setRefTitle(ref, refOf(entry).title); }
      }
      // A closed window can retain an old tab in its saved layout. Reconcile
      // against membership when it opens again, without touching other hosts.
      const available = new Set(data.entries.map(entry => entry.key));
      const stale = allRefs().filter(ref => ref.host === target && !available.has(ref.key));
      if (stale.length) { let next = tree; for (const ref of stale) next = L.remove(next, ref); commit(next); }
      setConnection(true, `${hostName(host)} · ${t("connected")}`); }
    catch (error) { if (epoch === refreshEpoch) setConnection(false, error.message); }
  }
  let usage = null, usageHost = null;
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
        node("span", t("remaining", { percent: Math.round(w.remainingPercent) }), "workspace-tip-value"));
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
  let limitsOpen = false;
  function setLimitsOpen(open) {
    limitsOpen = !!open;
    const box = document.querySelector(".workspace-limits-box");
    if (!box) return;
    box.dataset.open = String(limitsOpen);
    box.querySelector(".workspace-limits-strip")?.setAttribute("aria-expanded", String(limitsOpen));
    const details = box.querySelector(".workspace-limits-details");
    if (details) details.inert = !limitsOpen;
    if (limitsOpen) closeUsageTip();
  }
  // A tap outside the box, a click in a conversation (focus moves into its
  // frame) or Escape closes it.
  addEventListener("pointerdown", event => { if (limitsOpen && !event.target.closest?.(".workspace-limits-box")) setLimitsOpen(false); }, true);
  addEventListener("blur", () => { if (limitsOpen) setLimitsOpen(false); });
  addEventListener("keydown", event => {
    if (event.key !== "Escape" || !limitsOpen) return;
    setLimitsOpen(false);
    document.querySelector(".workspace-limits-strip")?.focus();
  });
  // The strip stays quiet while every allowance is comfortable: one line and
  // the providers' own logos. A provider close to its limit gets a chip with
  // what is left of its tightest window. Tapping the strip opens the box
  // upward over the list with every allowance in it; tapping it again, tapping
  // elsewhere or Escape closes it.
  function renderUsage(data) {
    const holder = $("workspace-usage");
    closeUsageTip();
    holder.replaceChildren();
    const box = node("div", "", "workspace-limits-box");
    holder.append(box);
    if (!data || !data.providers?.length) {
      const note = data ? t("quotaUnavailable") : t("loadingQuota");
      limitsOpen = false;
      box.append(node("span", note, "workspace-limits-note"));
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
      if (row.tightest) anchor.addEventListener("pointerenter", () => { if (!limitsOpen) showUsageTip(anchor, { ...row.provider, windows: row.windows }); });
      anchor.addEventListener("pointerleave", closeUsageTip);
    };
    const spoken = rows.map(row => {
      const summary = row.tightest ? `${usageLabel(row.tightest, row.provider)} · ${t("remaining", { percent: Math.round(row.tightest.remainingPercent) })}` : t("quotaUnavailable");
      return `${row.provider.provider} · ${summary}` + (row.provider.status === "cached" && row.provider.observedAt ? ` · ${t("checked", { date: date(row.provider.observedAt) })}` : "");
    });
    const label = `${t("quota")} · ${spoken.join(" · ")}`;
    const strip = button("", () => setLimitsOpen(!limitsOpen), label, "workspace-limits-strip");
    strip.removeAttribute("title");
    strip.setAttribute("aria-controls", "workspace-limits-details");
    const alerts = rows.filter(row => row.level === "low" || row.level === "critical");
    const lead = node("span", "", "workspace-limits-lead");
    if (alerts.length) {
      strip.dataset.state = "alert";
      if (alerts.length > 2) lead.classList.add("workspace-limits-compact");
      for (const row of alerts) {
        const chip = node("span", "", "workspace-limit-alert");
        chip.dataset.level = row.level;
        if (row.provider.status === "cached") chip.dataset.stale = "true";
        chip.append(providerLogo(row.provider.provider), node("span", `${Math.round(row.tightest.remainingPercent)}%`, "workspace-limit-percent"),
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
    box.append(limitsDetails(rows, data), strip);
    holder.setAttribute("aria-label", label);
    setLimitsOpen(limitsOpen);
  }
  // A bucket that only repeats the provider's name is left out, as in the strip.
  function limitsRowName(w, provider) {
    const same = value => String(value || "").toLowerCase() === String(w.bucket || "").toLowerCase();
    const shape = windowShape(w) || "";
    return w.bucket && !same(provider?.provider) && !same(provider?.service) ? (w.bucket + " " + shape).trim() : shape;
  }
  // Every allowance on one line: how long it runs, a bar of what is left, the
  // percentage, and how long until it resets. Colour appears only where an
  // allowance runs low, and a provider close to a limit comes first.
  function limitsDetails(rows, data) {
    const details = node("div", "", "workspace-limits-details");
    details.id = "workspace-limits-details";
    details.setAttribute("role", "region");
    details.setAttribute("aria-label", t("quota"));
    const scroll = node("div", "", "workspace-limits-scroll");
    const grid = node("div", "", "workspace-limits-grid");
    const low = row => row.level === "low" || row.level === "critical";
    const ordered = rows.map((row, index) => ({ row, index }))
      .sort((a, b) => (low(b.row) - low(a.row)) || (low(a.row) && low(b.row) ? a.row.tightest.remainingPercent - b.row.tightest.remainingPercent : 0) || a.index - b.index)
      .map(item => item.row);
    for (const { provider, windows } of ordered) {
      const head = node("div", "", "workspace-limits-provider");
      if (provider.status === "cached") head.dataset.stale = "true";
      const name = node("strong", provider.provider);
      const via = provider.source === "opencodex" ? t("viaOpencodex") : provider.source === "codexbar" ? t("viaCodexbar") : "";
      if (via) name.title = via;
      head.append(providerLogo(provider.provider), name);
      if (provider.status === "cached" && provider.observedAt) head.append(node("small", t("checked", { date: clockTime(provider.observedAt) })));
      grid.append(head);
      if (!windows.length) { grid.append(node("p", t("unknownQuota"), "workspace-limits-unknown")); continue; }
      for (const w of windows) {
        const known = Number.isFinite(w.remainingPercent);
        const remaining = known ? Math.max(0, Math.min(100, Math.round(w.remainingPercent))) : null;
        const row = node("div", "", "workspace-limits-row");
        row.dataset.level = known ? remainingLevel(remaining) : "ok";
        if (provider.status === "cached") row.dataset.stale = "true";
        // A reset already past waits for the next reading.
        const resetsAt = w.resetsAt > Date.now() ? w.resetsAt : null;
        const when = resetsAt ? t("resetsIn", { duration: shortDuration(resetsAt - Date.now()) }) + " · " + clockTime(resetsAt) : "";
        const spoken = usageLabel(w, provider) + " · " + (known ? t("remaining", { percent: remaining }) : t("quotaUnavailable")) + (when ? " · " + when : "");
        const bar = node("span", "", "workspace-limits-bar");
        bar.setAttribute("role", "progressbar"); bar.setAttribute("aria-valuemin", "0"); bar.setAttribute("aria-valuemax", "100");
        if (known) bar.setAttribute("aria-valuenow", String(remaining));
        bar.setAttribute("aria-label", spoken);
        const fill = node("span"); fill.style.width = (remaining ?? 0) + "%";
        bar.append(fill);
        const reset = node("span", "", "workspace-limits-reset");
        reset.setAttribute("aria-hidden", "true");
        if (resetsAt) {
          reset.append(icon("M19.5 12a7.5 7.5 0 1 1-2.2-5.3M19.5 4.5v4h-4"), node("span", shortDuration(resetsAt - Date.now())));
          row.title = when;
        }
        row.append(node("span", limitsRowName(w, provider), "workspace-limits-name"), bar,
          node("span", known ? remaining + "%" : "—", "workspace-limits-value"), reset);
        grid.append(row);
      }
    }
    const foot = node("div", "", "workspace-limits-foot");
    // Refresh beside the time of the reading asks the providers again.
    const checked = node("span", "", "workspace-limits-checked");
    const again = button("", () => void refreshLimitsNow(again), t("refresh"), "btn ghost workspace-limits-refresh");
    again.append(icon("M19.5 12a7.5 7.5 0 1 1-2.2-5.3M19.5 4.5v4h-4"));
    checked.append(node("small", data.updatedAt ? t("checked", { date: clockTime(data.updatedAt) }) : ""), again);
    foot.append(checked,
      button(t("quotaSourcesLink"), () => { setLimitsOpen(false); openSettings("quota-sources"); }, t("quotaSourcesLink"), "workspace-limits-sources"));
    scroll.append(grid, foot);
    details.append(scroll);
    details.inert = true;
    return details;
  }
  // Allowances change while agents work. The Host keeps a reading for up to
  // two minutes, which is also how often this asks; Refresh, here or in the
  // limits panel, has the Host read the providers again.
  let usageReadAt = 0;
  async function refreshUsage({ fresh = false } = {}) {
    const target = host;
    usageReadAt = Date.now();
    try { const data = await api(fresh ? "/api/workspace/usage?fresh=1" : "/api/workspace/usage", undefined, target); if (target !== host) return;
      usage = data; usageHost = target;
      renderUsage(data);
    } catch { if (target === host) { usage = null; usageHost = null; renderUsage({ providers: [] }); } }
  }
  async function refreshLimitsNow(control) {
    if (control.dataset.busy === "true") return;
    const hadFocus = document.activeElement === control;
    control.dataset.busy = "true"; control.setAttribute("aria-busy", "true");
    try { await refreshUsage({ fresh: true }); }
    finally {
      // The panel is drawn again with the new reading; focus follows it.
      const next = document.querySelector(".workspace-limits-refresh");
      if (next && next !== control) { if (hadFocus) next.focus({ preventScroll: true }); }
      else { delete control.dataset.busy; control.removeAttribute("aria-busy"); }
    }
  }
  // A time in the person's own clock: the time alone today, the weekday within
  // a week either way, the date beyond that. No seconds.
  function clockTime(ms) {
    const at = new Date(ms), time = { hour: "numeric", minute: "2-digit" };
    const options = at.toDateString() === new Date().toDateString() ? time
      : Math.abs(ms - Date.now()) < 6 * 86400000 ? { weekday: "short", ...time } : { month: "numeric", day: "numeric", ...time };
    try { return new Intl.DateTimeFormat(prefs.locale, options).format(at); } catch { return at.toLocaleString(); }
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
      : error?.code === "not_writable" && error.detail?.platform === "darwin" && error.detail?.reason === "EPERM" ? t("folderPrivacy", { host: hostName(target) })
      : error?.code === "not_writable" && error.detail?.platform === "win32" ? t("folderWindowsProtected", { runtime: error.detail.runtime || "node.exe" })
      : error?.status === 403 ? t("folderNotAllowed") : t("folderCreateFailed");
    // A folder the Host could not read says why, and what to do on that Host:
    // allow its Node.js on a Mac, answer a dialog there, or try again later.
    function folderProblem(error, retry) {
      const box = node("div", "", "workspace-folder-problem"), detail = error?.detail || {}, where = hostName(target);
      const message = error?.code === "folder_privacy" ? t("folderPrivacy", { host: where })
        : error?.code === "folder_waiting" ? t(detail.platform === "darwin" ? "folderWaitingMac" : "folderWaiting", { host: where })
        : error?.code === "folder_permission" ? t("folderPermission")
        : error?.message || t("loadFailed");
      // Guidance reads as text; only an error the dialog cannot explain is red.
      const known = ["folder_privacy", "folder_waiting", "folder_permission"].includes(error?.code);
      box.append(node("p", message, known ? "workspace-folder-empty workspace-folder-guide" : "workspace-folder-empty workspace-folder-error"));
      if (!known) return box;
      const actions = node("div", "", "workspace-folder-problem-actions");
      if (error.code === "folder_privacy") {
        const openSettings = button(t("openPrivacySettings", { host: where }), async () => {
          openSettings.disabled = true;
          try { await api("/api/host/privacy-settings", {}, target); toast(t("privacySettingsOpened", { host: where })); }
          catch (failure) { toast(failure.code === "open_failed" ? t("privacySettingsFailed", { host: where }) : failure.message); }
          finally { openSettings.disabled = false; }
        }, t("openPrivacySettings", { host: where }), "btn ghost workspace-folder-privacy");
        actions.append(openSettings);
      }
      actions.append(button(t("tryAgain"), retry, t("tryAgain"), "btn ghost workspace-folder-retry"));
      box.append(actions);
      // The actions come first; the Node.js path is the detail below them.
      if (error.code === "folder_privacy" && typeof detail.runtime === "string" && detail.runtime) {
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
  async function newSession(cwd) {
    const body = dialog(t("newSession")), epoch = dialogEpoch, target = host;
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
    try { const data = await api("/api/agents", undefined, target); if (epoch !== dialogEpoch) return; for (const agent of data.connectors || []) if (agent.installed) { const opt = node("option", agent.label || agent.name || agent.id); opt.value = agent.id; select.append(opt); capabilities.set(agent.id, agent.capabilities); } syncWorktree(); start.disabled = !select.options.length; if (!select.options.length) body.append(node("p", t("noAgents"))); }
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
      list.replaceChildren(); status.textContent = t("count", { count: filtered.length }); more.hidden = limit >= filtered.length;
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
      if (data.type === "drag") document.body.classList.toggle("workspace-dragging", data.active === true);
      if (data.type === "moved" && data.source === windowId) {
        const pending = pendingTransfers.get(data.transfer);
        if (pending?.drag && L.identity(pending.ref) === L.identity(L.reference(data.ref))) { pendingTransfers.delete(data.transfer); commit(L.remove(tree, pending.ref)); }
      }
      if (data.type === "window-ready" && data.source === windowId) { const pending = pendingTransfers.get(data.token); if (pending?.target === data.target) { pendingTransfers.delete(data.token); commit(L.remove(tree, pending.ref)); } }
      if (data.type === "untracked") untrackMembership(data.host, data.keys, false);
      if (data.type === "refresh") void refresh();
    } catch {}
  };
  window.addEventListener("message", event => {
    if (event.origin !== location.origin) return;
    if (settingsLayer && event.source === settingsLayer.querySelector("iframe")?.contentWindow) {
      if (event.data?.type === "workspace-settings-close") closeSettings();
      return;
    }
    const item = [...frames.values()].find(item => item.frame.contentWindow === event.source);
    if (!item) return;
    if (event.data?.type === "workspace-focus") { const p = L.leaves(tree).find(p => p.tabs.some(r => L.identity(r) === L.identity(item.ref))); if (p) { focused = p.id; for (const pane of document.querySelectorAll(".workspace-pane")) pane.dataset.focused = String(pane.dataset.pane === focused); } }
    if (event.data?.type === "workspace-title") setRefTitle(item.ref, event.data.title);
    if (event.data?.type === "workspace-show-list" && mobile()) {
      if (window.history.state?.stepsembleWorkspaceView === "session") window.history.back();
      else showMobileList();
    }
    if (event.data?.type === "workspace-refresh") { void refresh(); channel?.postMessage({ type: "refresh" }); }
    // A conversation this one made (Branch in new chat), on the same Host,
    // opens as a tab of the pane beside it.
    if (event.data?.type === "workspace-open" && typeof event.data.key === "string" && event.data.key && event.data.key.length <= 256) {
      const pane = L.leaves(tree).find(p => p.tabs.some(r => L.identity(r) === L.identity(item.ref)));
      open({ host: item.ref.host, key: event.data.key, title: String(event.data.title || "").slice(0, 160) }, pane?.id || focused);
      void refresh();
    }
  });
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
    if (section) url.searchParams.set("section", section);
    const frame = node("iframe", "", "workspace-settings-frame"); frame.title = t("settings"); frame.src = url.href;
    settingsLayer = node("div", "", "workspace-settings-layer"); settingsLayer.append(frame);
    settingsCovered = [...document.body.children].filter(child => !child.inert);
    for (const child of settingsCovered) child.inert = true;
    document.body.append(settingsLayer);
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
  $("workspace-search").oninput = renderSidebar;
  $("workspace-host").onchange = () => { host = $("workspace-host").value; snapshot = { projects: [], entries: [] }; usage = null; renderUsage(null); renderSidebar(); void refresh(); void refreshUsage(); };
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
  setInterval(() => { if (!document.hidden && host) void refresh(); }, 10000);
  setInterval(() => { if (!document.hidden && host) void refreshUsage(); }, 120000);
  // A Workspace opened while its host cannot be reached keeps trying, so it
  // connects by itself once the host answers instead of needing a reload.
  let booted = false, booting = false, bootTimer = 0, bootAttempt = 0;
  function retryBoot() { clearTimeout(bootTimer); bootTimer = 0; void boot(); }
  async function boot() {
    if (booted || booting) return;
    booting = true;
    try {
      let res;
      try { res = await fetch("/api/machines", { credentials: "same-origin", cache: "no-store" }); }
      catch { throw new Error(t("hostsFailed")); }
      if (res.status === 401) {
        const login = new URL("/index.html", location.origin); login.searchParams.set("returnWorkspace", "1");
        for (const key of ["window", "ack", "source"]) if (params.has(key)) login.searchParams.set(key, params.get(key));
        location.replace(login.href); return;
      }
      if (!res.ok) throw new Error(t("hostsFailed"));
      const data = await res.json(); machines = data.machines; self = data.current || data.selfId || machines.find(m => m.self)?.id;
      host = self || machines[0]?.id;
      if (!host) throw new Error(t("noHosts"));
      $("workspace-host").replaceChildren();
      for (const m of machines) { const option = node("option", m.name || m.id); option.value = m.id; $("workspace-host").append(option); }
      $("workspace-host").value = host;
      booted = true;
      await refresh(); render(); void refreshUsage();
      if (params.get("ack") && params.get("source")) { save(); channel?.postMessage({ type: "window-ready", source: params.get("source"), target: windowId, token: params.get("ack") }); }
    } catch (error) {
      setConnection(false, error.message);
      if (!booted) bootTimer = setTimeout(retryBoot, Math.min(10000, 1000 * 2 ** bootAttempt++));
    } finally { booting = false; }
  }
  if ("serviceWorker" in navigator) {
    void navigator.serviceWorker.register("/sw.js", { updateViaCache: "none" }).catch(() => {});
    navigator.serviceWorker.addEventListener("message", async event => {
      const data = event.data || {};
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
