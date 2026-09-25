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
  function usageLabel(w) {
    const period = w.windowDurationMins === 300 ? t("fiveHours") : w.windowDurationMins === 10080 ? t("weekly")
      : w.windowDurationMins === 43200 ? t("monthly") : t("minutes", { minutes: w.windowDurationMins || "?" });
    return w.bucket ? `${w.bucket} · ${period}` : period;
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
    const data = await res.json(); if (!res.ok) throw Object.assign(new Error(data.error || t("loadFailed")), { status: res.status }); return data;
  }
  const hostName = value => machines.find(m => m.id === value)?.name || value;
  const refOf = entry => ({ host, key: entry.key, title: plainTitle(entry.record.name) || entry.record.agentId || "Session" });
  function allRefs() { return L.leaves(tree).flatMap(p => p.tabs); }
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
    if (frame) { frame.ref.title = title; frame.frame.title = `${title} · ${hostName(ref.host)}`; }
    try { save(); } catch (error) { toast(error.message); }
    render();
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
        tab.append(button(ref.title, () => { n.active = key; focused = n.id; commit(tree); }, `${ref.title} · ${hostName(ref.host)}`), button("×", () => commit(L.remove(tree, ref)), t("closeTab", { title: ref.title }))); tablist.append(tab);
      }
      tabs.append(tablist);
      // Layout actions collapse into one overflow control. A permanent row of
      // buttons costs every pane a strip of height that belongs to the
      // conversation, and these actions are occasional.
      const actions = [];
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
        if (allRefs().some(tab => L.identity(tab) === L.identity(ref))) setRefTitle(ref, refOf(entry).title);
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
  function quotaRing(w) {
    const ring = node("span", "", "workspace-quota-ring");
    const remaining = w && Number.isFinite(w.remainingPercent) ? Math.max(0, Math.min(100, w.remainingPercent)) : null;
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 48 48"); svg.setAttribute("aria-hidden", "true");
    for (const className of ["quota-ring-track", "quota-ring-progress"]) {
      const circle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
      circle.setAttribute("cx", "24"); circle.setAttribute("cy", "24"); circle.setAttribute("r", "19");
      circle.setAttribute("pathLength", "100"); circle.setAttribute("class", className);
      if (className === "quota-ring-progress") {
        circle.style.strokeDasharray = "100";
        circle.style.strokeDashoffset = String(100 - (remaining ?? 0));
      }
      svg.append(circle);
    }
    ring.append(svg, node("span", remaining === null ? "—" : `${Math.round(remaining)}%`));
    ring.setAttribute("aria-hidden", "true");
    return ring;
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
  function renderUsage(data) {
    const box = $("workspace-usage");
    const previousScroll = box.querySelector(".workspace-limits-track")?.scrollLeft || 0;
    closeUsageTip();
    box.replaceChildren();
    if (!data || !data.providers?.length) {
      const note = data ? t("quotaUnavailable") : t("loadingQuota");
      box.append(node("span", note, "workspace-limits-note"));
      box.setAttribute("aria-label", `${t("quota")} · ${note}`);
      return;
    }
    const spoken = [];
    const track = node("div", "", "workspace-limits-track");
    track.dataset.count = String(data.providers.length);
    track.addEventListener("wheel", event => {
      if (track.scrollWidth <= track.clientWidth || Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
      track.scrollLeft += event.deltaY;
      event.preventDefault();
    }, { passive: false });
    track.addEventListener("keydown", event => {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      const step = track.firstElementChild?.offsetWidth || 80;
      track.scrollBy({ left: event.key === "ArrowRight" ? step : -step, behavior: "smooth" });
      event.preventDefault();
    });
    for (const provider of data.providers) {
      const windows = [...(provider.windows || [])].sort((a, b) =>
        (a.windowDurationMins ?? Infinity) - (b.windowDurationMins ?? Infinity) || a.remainingPercent - b.remainingPercent);
      const primary = windows[0] || null;
      const row = button("", showQuotaDialog, provider.provider, "workspace-limit");
      if (primary) row.dataset.level = remainingLevel(primary.remainingPercent);
      // A cached reading is marked stale; the hover card says when it was taken.
      if (provider.status === "cached") row.dataset.stale = "true";
      // Rows with a reading explain themselves in the hover card; a row without
      // one keeps the provider name as its tooltip so the bare logo stays legible.
      if (primary) row.removeAttribute("title");
      // In the strip the logo names the provider; the hover card, the dialog and
      // the spoken label carry the full name.
      const copy = node("span", "", "workspace-limit-copy");
      copy.append(providerLogo(provider.provider), node("span", primary ? windowShape(primary) || "—" : "—", "workspace-limit-period"));
      row.append(quotaRing(primary), copy);
      const summary = primary ? `${usageLabel(primary)} · ${t("remaining", { percent: Math.round(primary.remainingPercent) })}` : t("quotaUnavailable");
      row.setAttribute("aria-label", `${provider.provider} · ${summary}` + (provider.status === "cached" && provider.observedAt ? ` · ${t("checked", { date: date(provider.observedAt) })}` : ""));
      if (primary) row.addEventListener("pointerenter", () => showUsageTip(row, { ...provider, windows }));
      row.addEventListener("pointerleave", closeUsageTip);
      track.append(row);
      spoken.push(`${provider.provider} ${summary}`);
    }
    box.append(track);
    if (previousScroll) requestAnimationFrame(() => { if (track.isConnected) track.scrollLeft = previousScroll; });
    box.setAttribute("aria-label", `${t("quota")} · ${spoken.join(" · ")}`);
  }
  async function refreshUsage() {
    const target = host;
    try { const data = await api("/api/workspace/usage", undefined, target); if (target !== host) return;
      usage = data; usageHost = target;
      renderUsage(data);
    } catch { if (target === host) { usage = null; usageHost = null; renderUsage({ providers: [] }); } }
  }
  // Where the readings come from, with a way into Settings to add one.
  function quotaSources() {
    const box = node("div", "", "workspace-quota-sources");
    box.append(node("p", t("quotaSources")),
      button(t("settings"), () => { closeDialog(); window.open("/index.html?settings=1&section=quota-sources", "stepsemble-settings"); }, t("settings"), "btn ghost workspace-quota-settings"));
    return box;
  }
  function showQuotaDialog() {
    closeUsageTip();
    const body = dialog(t("quota"));
    $("workspace-dialog").classList.add("workspace-quota-dialog");
    body.append(node("p", t("quotaInfo"), "workspace-quota-intro"));
    if (usageHost !== host || !usage?.providers?.length) { body.append(node("p", t("quotaUnavailable")), quotaSources()); return; }
    for (const provider of usage.providers) {
      const section = node("section", "", "workspace-quota-provider");
      const head = node("div", "", "workspace-quota-provider-head");
      head.append(providerLogo(provider.provider), node("strong", provider.provider));
      if (provider.source === "opencodex") head.append(node("small", t("viaOpencodex"), "workspace-quota-source"));
      else if (provider.source === "codexbar") head.append(node("small", t("viaCodexbar"), "workspace-quota-source"));
      section.append(head);
      if (!provider.windows?.length) section.append(node("p", t("unknownQuota")));
      else {
        const windows = node("div", "", "workspace-quota-windows");
        for (const w of [...provider.windows].sort((a, b) => (a.windowDurationMins ?? Infinity) - (b.windowDurationMins ?? Infinity))) {
          const card = node("div", "", "workspace-quota-window");
          card.dataset.level = remainingLevel(w.remainingPercent);
          if (provider.status === "cached") card.dataset.stale = "true";
          const main = node("div", "", "workspace-quota-window-main");
          const copy = node("div", "", "workspace-quota-window-copy");
          copy.append(node("strong", usageLabel(w)),
            node("small", t("remaining", { percent: Math.round(w.remainingPercent) })));
          if (w.resetsAt) copy.append(node("small", t("resetsIn", { duration: shortDuration(w.resetsAt - Date.now()) })),
            node("small", t("resetAt", { date: date(w.resetsAt) })));
          main.append(quotaRing(w), copy);
          const bar = node("div", "", "workspace-quota-bar");
          const used = Math.max(0, Math.min(100, Number.isFinite(w.usedPercent) ? w.usedPercent : 100 - w.remainingPercent));
          bar.setAttribute("role", "progressbar"); bar.setAttribute("aria-valuemin", "0"); bar.setAttribute("aria-valuemax", "100");
          bar.setAttribute("aria-valuenow", String(Math.round(used)));
          bar.setAttribute("aria-label", `${usageLabel(w)} · ${t("used", { percent: Math.round(used) })}`);
          const fill = node("span"); fill.style.width = `${used}%`;
          bar.append(fill); card.append(main, bar); windows.append(card);
        }
        section.append(windows);
      }
      if (provider.observedAt || usage.updatedAt) section.append(node("small", t("checked", { date: date(provider.observedAt || usage.updatedAt) }), "workspace-quota-observed"));
      body.append(section);
    }
    body.append(quotaSources());
  }
  function closeDialog() { dialogEpoch++; if ($("workspace-dialog").open) $("workspace-dialog").close(); $("workspace-dialog").classList.remove("workspace-project-dialog", "workspace-quota-dialog", "workspace-signing-in"); $("workspace-dialog-body").replaceChildren(); }
  function dialog(title) { dialogEpoch++; const modal = $("workspace-dialog"); modal.classList.remove("workspace-project-dialog", "workspace-quota-dialog", "workspace-new-session-dialog", "workspace-signing-in"); $("workspace-dialog-title").textContent = title; const body = $("workspace-dialog-body"); body.replaceChildren(); if (!modal.open) modal.showModal(); return body; }
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
    browseHead.append(search);
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
      const entries = (current?.entries || []).filter(entry => entry.name.toLocaleLowerCase().includes(search.value.trim().toLocaleLowerCase()));
      if (!entries.length) {
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
    function updateNavigation() {
      back.disabled = historyIndex <= 0;
      forward.disabled = historyIndex < 0 || historyIndex >= historyPaths.length - 1;
      up.disabled = !current?.parent || current.parent === current.path;
      go.disabled = !pathInput.value.trim() || pathInput.value === current?.path;
    }
    async function navigate(path, historyTarget = null) {
      if (historyTarget === null && path && path === current?.path) return;
      const request = ++sequence;
      select.disabled = true; back.disabled = true; forward.disabled = true; up.disabled = true; go.disabled = true; search.disabled = true;
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
        search.disabled = false; updateNavigation();
        renderEntries();
      } catch (error) {
        if (epoch !== dialogEpoch || request !== sequence) return;
        updateNavigation();
        list.replaceChildren(node("p", error.message, "workspace-folder-empty workspace-folder-error"));
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
        toast(error.message); start.disabled = !(error.status >= 400 && error.status < 500); if (start.disabled) body.append(node("p", t("createUncertain")));
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
    const item = [...frames.values()].find(item => item.frame.contentWindow === event.source);
    if (!item) return;
    if (event.data?.type === "workspace-focus") { const p = L.leaves(tree).find(p => p.tabs.some(r => L.identity(r) === L.identity(item.ref))); if (p) { focused = p.id; for (const pane of document.querySelectorAll(".workspace-pane")) pane.dataset.focused = String(pane.dataset.pane === focused); } }
    if (event.data?.type === "workspace-title") setRefTitle(item.ref, event.data.title);
    if (event.data?.type === "workspace-show-list" && mobile()) {
      if (window.history.state?.stepsembleWorkspaceView === "session") window.history.back();
      else showMobileList();
    }
    if (event.data?.type === "workspace-refresh") { void refresh(); channel?.postMessage({ type: "refresh" }); }
  });
  function showMobileList() {
    if (!mobile()) return;
    document.body.classList.remove("sidebar-hidden");
    renderSidebar();
    requestAnimationFrame(layoutFrames);
    void refresh();
  }
  window.addEventListener("popstate", showMobileList);
  $("workspace-dialog-close").onclick = closeDialog;
  $("workspace-dialog").addEventListener("cancel", event => { event.preventDefault(); closeDialog(); });
  $("workspace-dialog").addEventListener("click", event => {
    const modal = $("workspace-dialog"), rect = modal.getBoundingClientRect();
    if (event.target === modal && (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom)) closeDialog();
  });
  $("workspace-add").onclick = () => addProject(); $("workspace-history").onclick = history;
  // Refresh reloads the list and the allowances together. The Host caches
  // provider readings, so repeated clicks do not reach the providers again.
  $("workspace-refresh").onclick = async () => {
    const control = $("workspace-refresh");
    if (control.dataset.busy === "true") return;
    control.dataset.busy = "true"; control.setAttribute("aria-busy", "true");
    const started = performance.now();
    try { await Promise.all([refresh(), refreshUsage()]); }
    finally {
      // A fast Host still shows one visible turn, so the click reads as done.
      setTimeout(() => { delete control.dataset.busy; control.removeAttribute("aria-busy"); }, Math.max(0, 450 - (performance.now() - started)));
    }
  };
  $("workspace-search").oninput = renderSidebar;
  $("workspace-host").onchange = () => { host = $("workspace-host").value; snapshot = { projects: [], entries: [] }; usage = null; renderUsage(null); renderSidebar(); void refresh(); void refreshUsage(); };
  $("workspace-sidebar-close").onclick = () => { document.body.classList.add("sidebar-hidden"); requestAnimationFrame(layoutFrames); };
  $("workspace-settings").onclick = () => { window.open("/index.html?settings=1", "stepsemble-settings"); };
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
  document.addEventListener("visibilitychange", () => { if (document.hidden) return; if (booted) void refresh(); else retryBoot(); });
  window.addEventListener("online", () => { if (booted) void refresh(); else retryBoot(); });
  setInterval(() => { if (!document.hidden && host) void refresh(); }, 10000);
  setInterval(() => { if (!document.hidden && host) void refreshUsage(); }, 300000);
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
