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
  if (mobile()) document.body.classList.add("sidebar-hidden");
  const node = (tag, text, className) => { const e = document.createElement(tag); if (text) e.textContent = text; if (className) e.className = className; return e; };
  function button(text, action, label = text, className = "btn") { const b = node("button", text, className); b.type = "button"; b.title = label; b.setAttribute("aria-label", label); b.onclick = action; return b; }
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
  const refOf = entry => ({ host, key: entry.key, title: entry.record.name || entry.record.agentId || "Session" });
  function allRefs() { return L.leaves(tree).flatMap(p => p.tabs); }
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
      if (mobile()) document.body.classList.add("sidebar-hidden");
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
      const key = L.identity(ref); if (frames.has(key)) continue;
      const frame = node("iframe", "", "workspace-frame"); frame.title = `${ref.title} · ${hostName(ref.host)}`;
      const url = new URL("/index.html", location.origin); url.searchParams.set("pane", "1"); url.searchParams.set("host", ref.host); url.searchParams.set("entry", ref.key);
      frame.src = url.href; frames.set(key, { frame, ref }); $("workspace-frames").append(frame);
    }
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
        // The header already opens an empty window; this one carries the pane's
        // own conversation, so it must not repeat that label.
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
      const slot = node("div", n.tabs.length ? t("loadingSession") : t("selectSession"), "workspace-slot");
      if (n.active) slots.set(n.active, slot);
      const overlay = node("div", "", "workspace-drop");
      const edgeAt = e => { const r = pane.getBoundingClientRect(), x = (e.clientX-r.left)/r.width, y = (e.clientY-r.top)/r.height; return x < .22 ? "left" : x > .78 ? "right" : y < .22 ? "top" : y > .78 ? "bottom" : "center"; };
      pane.ondragover = e => { if (!Array.from(e.dataTransfer.types).includes("application/x-stepsemble-session")) return; e.preventDefault(); overlay.dataset.edge = edgeAt(e); };
      pane.ondrop = e => { e.preventDefault(); try { acceptTransfer(JSON.parse(e.dataTransfer.getData("application/x-stepsemble-session")), n.id, edgeAt(e)); } catch (error) { toast(error.message); } finally { dragEnd(); } };
      // A single untouched pane keeps no strip at all, so the invitation to
      // drag a session is the only thing in it.
      if (n.tabs.length || actions.length) pane.append(tabs);
      pane.append(slot, overlay); return pane;
    }
    const shown = maximized ? L.leaves(tree).find(p => p.id === maximized) : tree;
    $("workspace-tree").append(draw(shown || tree)); requestAnimationFrame(layoutFrames); renderSidebar();
  }
  function renderSidebar() {
    const box = $("workspace-projects"); box.replaceChildren(); const search = $("workspace-search").value.trim().toLowerCase();
    const openKeys = new Set(allRefs().map(L.identity));
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
      toggle.append(node("span", "⌄", "workspace-project-chevron"), copy);
      const contents = node("div", "", "workspace-project-sessions");
      const hidden = !search && collapsedFor().has(cwd);
      section.dataset.collapsed = String(hidden); contents.hidden = hidden; toggle.setAttribute("aria-expanded", String(!hidden));
      header.append(toggle, button("＋", () => newSession(cwd), t("newSession"), "btn workspace-project-add"));
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
        const ref = refOf(entry), row = node("div", "", "workspace-session-row"), b = button("", () => open(ref), ref.title, "btn workspace-session"); b.dataset.open = String(openKeys.has(L.identity(ref))); b.draggable = true;
        b.append(node("strong", ref.title), node("small", `${entry.record.agentId} · ${entry.record.status || "history"}${entry.origin === "added" ? ` · ${t("added")}` : ""}`));
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
  async function refresh() {
    const epoch = ++refreshEpoch, target = host;
    const statusDot = document.querySelector(".workspace-status-dot");
    try { const data = await api("/api/workspace", undefined, target); if (epoch !== refreshEpoch || target !== host) return; if (JSON.stringify(data) !== JSON.stringify(snapshot)) { snapshot = data; if (!document.body.classList.contains("workspace-dragging")) renderSidebar(); }
      // A closed window can retain an old tab in its saved layout. Reconcile
      // against membership when it opens again, without touching other hosts.
      const available = new Set(data.entries.map(entry => entry.key));
      const stale = allRefs().filter(ref => ref.host === target && !available.has(ref.key));
      if (stale.length) { let next = tree; for (const ref of stale) next = L.remove(next, ref); commit(next); }
      $("workspace-connection").textContent = `${hostName(host)} · ${t("connected")}`; if (statusDot) statusDot.dataset.state = "online"; }
    catch (error) { if (epoch === refreshEpoch) { $("workspace-connection").textContent = error.message; if (statusDot) statusDot.dataset.state = "offline"; } }
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
  function meter(w) {
    const track = node("span", "", "workspace-limit-meter"), fill = node("span", "", "workspace-limit-fill");
    fill.style.width = `${Math.max(0, Math.min(100, Math.round(w.usedPercent)))}%`;
    track.append(fill);
    return track;
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
    closeUsageTip();
    box.replaceChildren();
    if (!data || !data.providers.some(p => p.windows.length)) {
      const note = data ? t("quotaUnavailable") : t("loadingQuota");
      box.append(node("span", note, "workspace-limits-note"));
      box.setAttribute("aria-label", `${t("quota")} · ${note}`);
      return;
    }
    const spoken = [];
    for (const provider of data.providers) {
      const windows = [...provider.windows].sort((a, b) => (a.windowDurationMins ?? Infinity) - (b.windowDurationMins ?? Infinity));
      const row = node("span", "", "workspace-limit");
      // A reading taken from a local cache carries the time it was observed
      // instead of being presented as the current number.
      if (provider.status === "cached") {
        row.dataset.stale = "true";
        if (provider.observedAt) row.title = t("checked", { date: date(provider.observedAt) });
      }
      const head = node("span", "", "workspace-limit-head");
      head.append(node("span", provider.provider, "workspace-limit-name"));
      // Every allowance gets the same shape whether a provider reports one or
      // three, so a single weekly limit still reads as "7d" beside its meter.
      row.append(head);
      const cells = node("span", "", "workspace-limit-windows");
      for (const w of windows) {
        const shape = windowShape(w), value = t("remaining", { percent: Math.round(w.remainingPercent) });
        const cell = node("span", "", "workspace-limit-cell");
        cell.dataset.level = remainingLevel(w.remainingPercent);
        const cellHead = node("span", "", "workspace-limit-cell-head");
        cellHead.append(node("span", shape, "workspace-limit-cell-label"),
          node("span", `${Math.round(w.remainingPercent)}%`, "workspace-limit-cell-value"));
        cell.append(cellHead, meter(w));
        cells.append(cell);
        spoken.push(`${shape} ${value}`);
      }
      row.append(cells);
      row.addEventListener("pointerenter", () => showUsageTip(row, { ...provider, windows }));
      row.addEventListener("pointerleave", closeUsageTip);
      box.append(row);
    }
    box.setAttribute("aria-label", `${t("quota")} · ${spoken.join(" · ")}`);
  }
  async function refreshUsage() {
    const target = host;
    try { const data = await api("/api/workspace/usage", undefined, target); if (target !== host) return;
      usage = data; usageHost = target;
      renderUsage(data);
    } catch { if (target === host) renderUsage({ providers: [] }); }
  }
  $("workspace-usage").onclick = () => {
    const body = dialog(t("quota")); body.append(node("p", t("quotaInfo")));
    if (usageHost === host && usage) for (const p of usage.providers) {
      body.append(node("strong", p.provider));
      // Say where a borrowed number came from, so a dependency on another app
      // is visible at the point the user reads the value.
      if (p.source === "opencodex") body.append(node("small", t("viaOpencodex")));
      if (!p.windows.length) body.append(node("p", t("unknownQuota")));
      for (const w of p.windows) body.append(node("p", `${usageLabel(w)} · ${t("remaining", { percent: Math.round(w.remainingPercent) })}`
        + (w.resetsAt ? ` · ${t("resetsIn", { duration: shortDuration(w.resetsAt - Date.now()) })} · ${t("resetAt", { date: date(w.resetsAt) })}` : "")));
      // Each provider carries its own observation time: a cached reading is as
      // old as its file, a live one is as old as this collection.
      body.append(node("small", t("checked", { date: date(p.observedAt || usage.updatedAt) })));
    }
  };
  function closeDialog() { dialogEpoch++; $("workspace-dialog").close(); $("workspace-dialog").classList.remove("workspace-project-dialog"); $("workspace-dialog-body").replaceChildren(); }
  function dialog(title) { dialogEpoch++; const modal = $("workspace-dialog"); modal.classList.remove("workspace-project-dialog"); $("workspace-dialog-title").textContent = title; const body = $("workspace-dialog-body"); body.replaceChildren(); if (!modal.open) modal.showModal(); return body; }
  function addProject() {
    const body = dialog(t("addProject")), epoch = dialogEpoch, target = host;
    $("workspace-dialog").classList.add("workspace-project-dialog");
    const pathLabel = node("label", t("folderPath"), "workspace-folder-label");
    pathLabel.htmlFor = "workspace-folder-path";
    const pathRow = node("div", "", "workspace-folder-path-row");
    const pathInput = node("input"); pathInput.id = "workspace-folder-path"; pathInput.type = "text"; pathInput.autocomplete = "off"; pathInput.spellcheck = false;
    let current = null, sequence = 0, historyPaths = [], historyIndex = -1;
    const back = button("←", () => { if (historyIndex > 0) void navigate(historyPaths[historyIndex - 1], historyIndex - 1); }, t("backFolder"), "btn workspace-folder-nav");
    const forward = button("→", () => { if (historyIndex < historyPaths.length - 1) void navigate(historyPaths[historyIndex + 1], historyIndex + 1); }, t("forwardFolder"), "btn workspace-folder-nav");
    const up = button("↑", () => { if (current?.parent && current.parent !== current.path) void navigate(current.parent); }, t("parent"), "btn workspace-folder-nav");
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
    const list = node("div", "", "workspace-folder-list");
    list.setAttribute("role", "region"); list.setAttribute("aria-label", t("foldersHere"));
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
      const entries = (current?.entries || []).filter(entry => entry.name.toLocaleLowerCase().includes(search.value.trim().toLocaleLowerCase()));
      if (!entries.length) {
        list.append(node("p", search.value.trim() ? t("noFolderMatches") : t("noFolders"), "workspace-folder-empty"));
        return;
      }
      for (const entry of entries) {
        const row = button("", () => { void navigate(entry.path || `${current.path}/${entry.name}`); }, entry.name, "btn workspace-folder-row");
        row.append(node("span", "", "workspace-folder-icon"), node("span", entry.name, "workspace-folder-name"), node("span", "›", "workspace-folder-chevron"));
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
    body.append(node("small", `${hostName(target)} · ${cwd}`));
    const name = node("input"); name.placeholder = t("optionalName"); name.setAttribute("aria-label", t("sessionName"));
    const select = node("select"); select.setAttribute("aria-label", "Agent");
    const start = button(t("create"), async () => {
      start.disabled = true;
      try {
        const data = await api("/api/agent/open", { agentId: select.value, cwd, name: name.value.trim() || null }, target);
        if (!data.workspaceEntry) throw new Error(data.workspaceError || t("createdUntracked"));
        closeDialog(); const entry = data.workspaceEntry;
        open({ host: target, key: entry.key, title: entry.record.name || select.value }); await refresh();
      } catch (error) { toast(error.message); start.disabled = !(error.status >= 400 && error.status < 500); if (start.disabled) body.append(node("p", t("createUncertain"))); }
    }, t("create"), "btn primary"); start.disabled = true; body.append(name, select, start);
    try { const data = await api("/api/agents", undefined, target); if (epoch !== dialogEpoch) return; for (const agent of data.connectors || []) if (agent.installed) { const opt = node("option", agent.label || agent.name || agent.id); opt.value = agent.id; select.append(opt); } start.disabled = !select.options.length; if (!select.options.length) body.append(node("p", t("noAgents"))); }
    catch (error) { if (epoch === dialogEpoch) body.append(node("p", error.message)); }
  }
  async function history() {
    const body = dialog(t("history")), epoch = dialogEpoch, target = host;
    body.append(node("p", t("historyInfo")));
    const search = node("input"); search.type = "search"; search.placeholder = t("historyPlaceholder"); search.setAttribute("aria-label", t("searchHistory"));
    const status = node("p", t("loading")), list = node("div"), more = button(t("more"), () => { limit += 50; show(); });
    let rows = [], limit = 50; body.append(search, status, list, more); more.hidden = true;
    function show() {
      const query = search.value.trim().toLowerCase(), filtered = rows.filter(r => `${r.record.name} ${r.record.agentId} ${r.record.cwd}`.toLowerCase().includes(query));
      list.replaceChildren(); status.textContent = t("count", { count: filtered.length }); more.hidden = limit >= filtered.length;
      for (const row of filtered.slice(0, limit)) {
        const item = node("article", "", "workspace-history-row"), copy = node("div"); copy.append(node("strong", row.record.name || row.record.firstMessage || row.record.agentId || "Pi"), node("small", `${row.record.agentId || "pi"} · ${row.record.cwd || ""}`));
        const add = button(t("addWorkspace"), async () => { add.disabled = true; try { await api("/api/workspace/adopt", { kind: row.kind, reference: row.reference }, target); add.textContent = t("added"); await refresh(); } catch (error) { toast(error.message); add.disabled = false; } });
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
    if (event.data?.type === "workspace-refresh") { void refresh(); channel?.postMessage({ type: "refresh" }); }
  });
  $("workspace-dialog-close").onclick = closeDialog;
  $("workspace-dialog").addEventListener("cancel", () => { dialogEpoch++; });
  $("workspace-add").onclick = () => addProject(); $("workspace-history").onclick = history; $("workspace-refresh").onclick = refresh;
  $("workspace-search").oninput = renderSidebar;
  $("workspace-new-window").onclick = () => newWindow();
  $("workspace-sidebar-toggle").onclick = () => { document.body.classList.toggle("sidebar-hidden"); requestAnimationFrame(layoutFrames); };
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
    if (mobile() !== wasMobile) { wasMobile = mobile(); if (wasMobile) document.body.classList.add("sidebar-hidden"); render(); }
    else layoutFrames();
  });
  window.addEventListener("pagehide", () => { try { save(); } catch {} });
  window.addEventListener("pageshow", event => { if (event.persisted) location.reload(); });
  document.addEventListener("visibilitychange", () => { if (!document.hidden) void refresh(); });
  setInterval(() => { if (!document.hidden && host) void refresh(); }, 10000);
  setInterval(() => { if (!document.hidden && host) void refreshUsage(); }, 300000);
  async function boot() {
    try {
      const res = await fetch("/api/machines", { credentials: "same-origin", cache: "no-store" });
      if (res.status === 401) {
        const login = new URL("/index.html", location.origin); login.searchParams.set("returnWorkspace", "1");
        for (const key of ["window", "ack", "source"]) if (params.has(key)) login.searchParams.set(key, params.get(key));
        location.replace(login.href); return;
      }
      if (!res.ok) throw new Error(t("hostsFailed"));
      const data = await res.json(); machines = data.machines; self = data.current || data.selfId || machines.find(m => m.self)?.id;
      host = self || machines[0]?.id;
      if (!host) throw new Error(t("noHosts"));
      for (const m of machines) { const option = node("option", m.name || m.id); option.value = m.id; $("workspace-host").append(option); }
      $("workspace-host").value = host;
      await refresh(); render(); void refreshUsage();
      if (params.get("ack") && params.get("source")) { save(); channel?.postMessage({ type: "window-ready", source: params.get("source"), target: windowId, token: params.get("ack") }); }
    } catch (error) { toast(error.message); $("workspace-connection").textContent = error.message; }
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
        if (entry) open({ host: self, key: entry.key, title: entry.record.name || entry.record.agentId });
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
