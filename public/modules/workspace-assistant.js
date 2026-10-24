/* The Bots and groups of the computer that runs Hermes, in the Workspace's
   own list beside the sessions. A Bot, a group or an Assistant page opens in
   a Workspace pane; this module reads Hermes only through Stepsemble's
   assistant API. */
"use strict";
(function (root) {
  const A = root.StepsembleAssistantAvatars, AI = root.StepsembleAssistantI18n, Api = root.StepsembleAssistantApi;
  const M = root.StepsembleAssistantModel, W = root.StepsembleWorkspaceAssistantModel;
  const MACHINE_KEY = "stepsemble.assistant.machine", COLLAPSED_KEY = "stepsemble.workspace.assistant.collapsed.v1", POLL = 15_000;
  const ICONS = {
    computer: "M3 4.5h18v12H3zM9 20h6M12 16.5V20", chevron: "M8 9.5l4-4 4 4M8 14.5l4 4 4-4", down: "m6 9 6 6 6-6",
    manage: "M4 7h9M17 7h3M4 17h3M11 17h9M15 5v4M9 15v4", plus: "M12 5v14M5 12h14",
    // The repeat arrows the Automations list gives a routine.
    routines: "M4 12a8 8 0 0 1 14-5.3M20 12a8 8 0 0 1-14 5.3M18 3v4h-4M6 21v-4h4",
    page: "M5 5.5h14v10H9.5L5 19.5z", group: "M9 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM3.5 19a5.5 5.5 0 0 1 11 0M16 11a2.5 2.5 0 1 0 0-5M17.5 14.5a4.5 4.5 0 0 1 3 4.5",
  };

  // In the Workspace's list the Bots block is one of its sections:
  // sectionActions() adds the list's own actions (move up, down) to the Bots
  // heading's menu, and decorate() lets the list make that heading draggable.
  // onLoaded() follows the first ready read and each read a tab's change
  // report asked for, so the Workspace can read the routines again.
  function create({ locale, wt, machines, selected, open, dragStart, dragEnd, menu, newWindow, onInstalled, sectionActions = () => [], decorate = () => {}, onLoaded = () => {} }) {
    const t = (key, vars) => AI.t(key, vars, locale());
    const node = (tag, text, className) => { const e = document.createElement(tag); if (text) e.textContent = text; if (className) e.className = className; return e; };
    function icon(path, className = "") {
      const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      svg.setAttribute("viewBox", "0 0 24 24"); svg.setAttribute("aria-hidden", "true");
      if (className) svg.setAttribute("class", className);
      const stroke = document.createElementNS("http://www.w3.org/2000/svg", "path"); stroke.setAttribute("d", path); svg.append(stroke);
      return svg;
    }
    function button(text, action, label = text, className = "btn") {
      const b = node("button", text, className); b.type = "button"; b.title = label; b.setAttribute("aria-label", label); b.onclick = action; return b;
    }
    let root = null, active = false, inline = false, choices = [], current = null, state = "loading", failure = null, query = "";
    let data = { bots: [], allBots: [], groups: { supported: false, rooms: [] }, asks: [] }, epoch = 0, timer = 0, soon = 0, reported = false;
    const pictures = new Map();
    let collapsed = new Set();
    try { collapsed = new Set(JSON.parse(localStorage.getItem(COLLAPSED_KEY)) || []); } catch {}
    const apiFor = machine => Api.create({ base: machine.base });

    // Which computers run Hermes; the switch appears once one does.
    // A computer that does not answer in a few seconds (asleep, away) does not
    // hold up the Bots of the others; it counts as having none for now.
    const DISCOVER_MS = 4000;
    const answered = promise => Promise.race([promise.catch(() => null), new Promise(resolve => setTimeout(resolve, DISCOVER_MS, null))]);
    async function discover() {
      const rows = machines();
      const checked = await Promise.all(rows.map(async row => ({ ...row, status: await answered(apiFor(row).status()) })));
      let saved = null; try { saved = localStorage.getItem(MACHINE_KEY); } catch {}
      const choice = M.chooseHermesMachine(checked, current?.id || saved);
      choices = choice.choices; current = choice.selected;
      onInstalled(!!current);
      if (active) { render(); void refresh(); }
      return !!current;
    }
    function selectMachine(id) {
      const next = choices.find(row => row.id === id);
      if (!next || next.id === current?.id) return;
      current = next; state = "loading"; data = { bots: [], allBots: [], groups: { supported: false, rooms: [] }, asks: [] };
      try { localStorage.setItem(MACHINE_KEY, next.id); } catch {}
      render(); void refresh();
    }
    async function refresh() {
      clearTimeout(timer);
      if (!active || !current) return;
      const mine = ++epoch, target = current, api = apiFor(target), before = state;
      try {
        const status = await api.status();
        if (mine !== epoch) return;
        target.status = status;
        if (!status.installed) state = "missing";
        else if (!status.running) state = "stopped";
        else if (!status.signedIn && status.authRequired && Array.isArray(status.providers) && !status.providers.includes("basic")) state = "oauth";
        else if (!status.signedIn) state = "signin";
        else {
          const [bots, groups, asks] = await Promise.all([api.bots(), api.groups().catch(() => ({ supported: false, rooms: [] })), api.asks().catch(() => ({ asks: [] }))]);
          if (mine !== epoch) return;
          const allBots = Array.isArray(bots.bots) ? bots.bots : [];
          data = { allBots, bots: allBots.filter(bot => !bot.hidden), asks: Array.isArray(asks.asks) ? asks.asks : [],
            groups: { supported: groups?.supported === true, rooms: Array.isArray(groups?.rooms) ? groups.rooms : [] } };
          state = "ready";
        }
        failure = null;
      } catch (error) { if (mine !== epoch) return; state = "error"; failure = error; }
      update();
      if (state === "ready" && (before !== "ready" || reported)) { reported = false; onLoaded(); }
      if (active && !document.hidden) timer = setTimeout(refresh, POLL);
    }
    // A tab reported a change (a reply, a new Bot or group): read again soon,
    // once for a burst of reports.
    function changed(profile = null) {
      // A Bot's settings changed: its picture may be new.
      if (profile) for (const key of [...pictures.keys()]) if (key.endsWith(`/${profile}`)) pictures.delete(key);
      reported = true; clearTimeout(soon); soon = setTimeout(() => void refresh(), 400);
    }

    const context = host => host === current?.id ? { bots: data.allBots, groups: data.groups.rooms, t } : { bots: [], groups: [], t };
    function ref(host, route) { return W.ref(host, route, context(host)); }
    // An uploaded picture is read once per computer and Bot; a built-in face
    // shows until it arrives.
    function avatarNode(bot, className = "workspace-assistant-avatar", host = current?.id) {
      const holder = A.paint(node("span", "", className), bot), machine = machines().find(row => row.id === host);
      if (A.resolve(bot).kind === "custom" && machine) {
        const key = `${machine.id}/${bot.name}`;
        if (!pictures.has(key)) pictures.set(key, apiFor(machine).botAvatar(bot.name).then(result => result.data).catch(() => null));
        void pictures.get(key).then(picture => { if (picture) A.paint(holder, bot, picture); });
      }
      return holder;
    }
    // A tab's label starts with its Bot's face, its group's faces, or a page mark.
    function tabIcon(tab) {
      const route = tab.assistant || {};
      if (route.profile && ["bot", "settings", "routines"].includes(route.page)) {
        const bot = (tab.host === current?.id && data.allBots.find(row => row.name === route.profile))
          || { name: route.profile, avatarPreset: A.isPreset(tab.avatar) ? tab.avatar : null, hasAvatar: tab.avatar === "custom" };
        return avatarNode(bot, "workspace-tab-avatar", tab.host);
      }
      const mark = node("span", "", "workspace-tab-avatar workspace-tab-page");
      mark.setAttribute("aria-hidden", "true");
      mark.append(icon({ group: ICONS.group, routines: ICONS.routines, bots: ICONS.manage }[route.page] || ICONS.page));
      return mark;
    }
    function isSelected(route) {
      const subject = W.subject(route);
      return selected().some(tab => tab.host === current?.id && tab.assistant && W.subject(tab.assistant) === subject);
    }
    function go(route) { if (current) open(current.id, route); }
    function saveCollapsed() { try { localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...collapsed])); } catch {} }

    function machineCard() {
      const card = node("label", "", "workspace-host-card workspace-assistant-host");
      const mark = node("span", "", "workspace-host-icon"); mark.setAttribute("aria-hidden", "true");
      const dot = node("span", "", "workspace-status-dot");
      dot.dataset.state = state === "ready" ? "online" : state === "loading" ? "" : "offline";
      mark.append(icon(ICONS.computer), dot);
      const select = node("select"); select.id = "workspace-assistant-machine"; select.setAttribute("aria-label", t("computer"));
      for (const row of choices) { const option = node("option", row.name); option.value = row.id; select.append(option); }
      if (current) select.value = current.id;
      select.onchange = () => selectMachine(select.value);
      const line = node("span", state === "ready" ? wt("connected") : state === "loading" ? wt("connecting") : state === "stopped" ? t("notRunningTitle") : state === "error" ? wt("hostUnavailable") : t("signInTitle"),
        "workspace-host-state");
      line.setAttribute("aria-hidden", "true");
      card.append(mark, select, line, icon(ICONS.chevron, "workspace-host-chevron"));
      return card;
    }
    function searchRow() {
      const row = node("div", "", "workspace-search-row");
      const wrap = node("label", "", "workspace-search-wrap"), mark = node("span", "⌕"); mark.setAttribute("aria-hidden", "true");
      const input = node("input"); input.id = "workspace-assistant-search"; input.type = "search"; input.spellcheck = false; input.setAttribute("autocorrect", "off"); input.setAttribute("autocapitalize", "off"); input.value = query;
      input.placeholder = t("searchBots"); input.setAttribute("aria-label", t("searchBots"));
      input.oninput = () => { query = input.value; update(); };
      wrap.append(mark, input);
      const manage = button("", () => go({ page: "bots" }), t("manageBots"), "btn workspace-row-action"); manage.id = "workspace-assistant-manage"; manage.append(icon(ICONS.manage));
      const add = button("", () => go({ page: "newbot" }), t("newBot"), "btn workspace-row-action"); add.id = "workspace-assistant-add"; add.append(icon(ICONS.plus));
      const ready = state === "ready";
      input.disabled = manage.disabled = add.disabled = !ready;
      row.append(wrap, manage, add);
      return row;
    }
    // fold: false makes a part of a section (the groups inside the Workspace's
    // Bots card), which folds with the section it is part of.
    function section(id, title, extra = null, { fold = true } = {}) {
      const box = node("section", "", "workspace-project workspace-assistant-section"); box.dataset.section = id;
      const header = node("header"), contents = node("div", "", "workspace-project-sessions");
      const hidden = fold && !query && collapsed.has(id);
      const copy = node("span", "", "workspace-project-copy"); copy.append(node("strong", title));
      let toggle = null;
      if (fold) {
        toggle = button("", () => {
          if (collapsed.has(id)) collapsed.delete(id); else collapsed.add(id);
          saveCollapsed(); update();
        }, title, "btn workspace-project-toggle");
        toggle.append(icon(ICONS.down, "workspace-project-chevron"), copy);
        toggle.setAttribute("aria-expanded", String(!hidden));
        header.append(toggle);
      } else { box.classList.add("workspace-assistant-part"); copy.classList.add("workspace-assistant-label"); header.append(copy); }
      box.dataset.collapsed = String(hidden); contents.hidden = hidden;
      if (extra) header.append(extra);
      box.append(header, contents);
      return { box, contents, toggle };
    }
    function botRow(bot) {
      const route = { page: "bot", profile: bot.name }, row = node("div", "", "workspace-session-row");
      const waiting = W.waiting(data.asks, bot.name);
      const preview = W.preview(bot.botChat?.preview) || bot.description || "";
      const entry = button("", () => go(route), `${bot.displayName}${preview ? " · " + preview : ""}`, "btn workspace-session workspace-assistant-row");
      entry.dataset.profile = bot.name; entry.dataset.open = String(isSelected(route)); entry.draggable = true;
      entry.ondragstart = event => dragStart(event, current.id, route); entry.ondragend = dragEnd;
      const copy = node("span", "", "workspace-assistant-copy"); copy.append(node("strong", bot.displayName), node("small", preview));
      entry.append(avatarNode(bot), copy);
      if (waiting) { const badge = node("span", String(waiting), "workspace-assistant-badge"); badge.title = t("pending", { count: waiting }); entry.append(badge); }
      const actions = button("⋯", () => menu(actions, [[t("settings"), () => go({ page: "settings", profile: bot.name })],
        [t("routines"), () => go({ page: "routines", profile: bot.name })], [wt("moveWindow"), () => newWindow(current.id, route)]]),
      t("moreOptions"), "btn workspace-session-menu");
      actions.setAttribute("aria-haspopup", "menu");
      entry.oncontextmenu = event => { event.preventDefault(); actions.click(); };
      row.append(entry, actions);
      return row;
    }
    function groupRow(room) {
      const route = { page: "group", room: room.id }, row = node("div", "", "workspace-session-row");
      const members = (room.members || []).map(member => member.displayName).join(", ");
      const entry = button("", () => go(route), `${room.name} · ${members}`, "btn workspace-session workspace-assistant-row");
      entry.dataset.room = room.id; entry.dataset.open = String(isSelected(route)); entry.draggable = true;
      entry.ondragstart = event => dragStart(event, current.id, route); entry.ondragend = dragEnd;
      const faces = node("span", "", "workspace-assistant-faces"); faces.setAttribute("aria-hidden", "true");
      for (const member of (room.members || []).slice(0, 2)) faces.append(avatarNode(data.allBots.find(bot => bot.name === member.profile) || { name: member.profile }));
      const copy = node("span", "", "workspace-assistant-copy"); copy.append(node("strong", room.name), node("small", members));
      entry.append(faces, copy);
      row.append(entry);
      return row;
    }
    function note(title, body = "", action = null) {
      const box = node("div", "", "workspace-assistant-note");
      box.append(node("strong", title));
      if (body) box.append(node("p", body));
      if (action) box.append(action);
      return box;
    }
    // In the Workspace's list, New Bot and a menu (Manage Bots and the list's
    // own actions) sit on the Bots heading, as a project's + and ⋯ do.
    function inlineActions() {
      const box = node("span", "", "workspace-assistant-actions"), ready = state === "ready";
      const add = button("", () => go({ page: "newbot" }), t("newBot"), "btn workspace-project-add"); add.id = "workspace-assistant-add"; add.append(icon(ICONS.plus));
      const more = button("⋯", () => menu(more, [...(ready ? [[t("manageBots"), () => go({ page: "bots" })]] : []), ...sectionActions()]), t("moreOptions"), "btn workspace-project-menu");
      more.id = "workspace-assistant-more"; more.setAttribute("aria-haspopup", "menu");
      add.disabled = !ready; box.append(add, more); return box;
    }
    function renderList() {
      const list = root?.querySelector("#workspace-assistant-list");
      if (!list) return;
      const keep = list.scrollTop, name = current?.name || "";
      list.replaceChildren();
      let notice = null;
      if (state === "loading") notice = note(t("loading"));
      else if (state === "missing" || !current) notice = note(t("notInstalledTitle"), t("notInstalledBody"));
      else if (state === "stopped") notice = note(t("notRunningTitle"), t("notRunningBody", { computer: name }), button(t("retry"), () => void refresh(), t("retry"), "btn ghost"));
      else if (state === "oauth") notice = note(t("signInTitle"), t("oauthOnly"));
      else if (state === "signin") notice = note(t("signInTitle"), t("signInBody", { computer: name }), button(t("signIn"), () => go({ page: "home" }), t("signIn"), "btn primary"));
      else if (state === "error") notice = note(t("failed", { message: failure?.message || "" }), "", button(t("retry"), () => void refresh(), t("retry"), "btn ghost"));
      if (notice && inline) { const bots = section("bots", t("bots"), inlineActions()); bots.contents.append(notice); list.append(bots.box); decorate(bots.toggle); }
      else if (notice) list.append(notice);
      else {
        if (data.asks.length) {
          const pending = button(t("pending", { count: data.asks.length }), () => go({ page: "pending" }), t("pendingTitle"), "btn workspace-assistant-pending");
          list.append(pending);
        }
        const bots = section("bots", t("bots"), inline ? inlineActions() : null);
        if (inline) decorate(bots.toggle);
        const botRows = W.botRows(data.bots, query, locale());
        for (const bot of botRows) bots.contents.append(botRow(bot));
        if (!botRows.length) bots.contents.append(node("small", t(query ? "noMatches" : "noBots")));
        list.append(bots.box);
        // In the Workspace's list the groups are part of the Bots' card: they
        // move with it, and fold when the Bots fold.
        if (inline && bots.contents.hidden) { list.scrollTop = keep; return; }
        const add = data.groups.supported ? button("", () => go({ page: "newgroup" }), t("newGroup"), "btn workspace-project-add") : null;
        add?.append(icon(ICONS.plus));
        const groups = section("groups", t("groups"), add, { fold: !inline });
        if (!data.groups.supported) groups.contents.append(node("small", t("groupsUnsupported")));
        else {
          const rooms = W.groupRows(data.groups.rooms, query, locale());
          for (const room of rooms) groups.contents.append(groupRow(room));
          if (!rooms.length) groups.contents.append(node("small", t(query ? "noMatches" : "noGroups")));
        }
        if (!query || groups.contents.querySelector(".workspace-assistant-row")) list.append(groups.box);
      }
      list.scrollTop = keep;
    }
    let drawn = { card: "", list: "" };
    function render() {
      if (!root || !active) return;
      const focused = document.activeElement?.id === "workspace-assistant-search";
      drawn = { card: "", list: "" };
      // In the Workspace's list the Workspace's search filters the Bots too,
      // and the computer shows only when more than one runs Hermes.
      if (inline) root.replaceChildren(...(choices.length > 1 ? [machineCard()] : []), Object.assign(node("div"), { id: "workspace-assistant-list" }));
      else root.replaceChildren(machineCard(), searchRow(), Object.assign(node("div"), { id: "workspace-assistant-list" }));
      update();
      if (focused) root.querySelector("#workspace-assistant-search")?.focus();
    }
    // A poll that finds nothing new leaves the sidebar alone, so a row being
    // dragged, an open menu or the search caret are not disturbed.
    function update() {
      if (!root || !active) return;
      const card = JSON.stringify([choices.map(row => [row.id, row.name]), current?.id, state, locale()]);
      if (card !== drawn.card) {
        drawn.card = card;
        root.querySelector(".workspace-assistant-host")?.replaceWith(machineCard());
        const ready = state === "ready";
        for (const id of ["workspace-assistant-search", "workspace-assistant-manage", "workspace-assistant-add"]) { const control = root.querySelector("#" + id); if (control) control.disabled = !ready; }
      }
      const list = JSON.stringify([state, failure?.message || "", data, query, [...collapsed], locale(), current?.id]);
      if (list !== drawn.list) { drawn.list = list; renderList(); }
    }
    // Only the rows' open marks follow tab changes; the list is not rebuilt.
    function mark() {
      for (const row of root?.querySelectorAll(".workspace-assistant-row") || []) {
        const route = row.dataset.profile ? { page: "bot", profile: row.dataset.profile } : { page: "group", room: row.dataset.room };
        row.dataset.open = String(isSelected(route));
      }
    }
    function activate(container, options = {}) {
      root = container; active = true; inline = options.inline === true;
      render(); void refresh();
    }
    function setQuery(value) { query = String(value || ""); update(); }
    function deactivate() { active = false; clearTimeout(timer); clearTimeout(soon); epoch++; }
    document.addEventListener("visibilitychange", () => { if (active && !document.hidden) void refresh(); });

    // Every Bot's routines on the computer that runs Hermes, for the
    // Workspace's Automations.
    async function routines() {
      const target = current;
      if (!target || state !== "ready") return null;
      const result = await apiFor(target).routines(null);
      return { target: target.id, items: Array.isArray(result?.routines) ? result.routines : [], bots: data.allBots };
    }
    // The Assistant's own words, for the Workspace controls that open it.
    return Object.freeze({ discover, activate, deactivate, refresh, changed, render, mark, ref, tabIcon, setQuery, routines, avatar: bot => avatarNode(bot), text: t, get active() { return active; },
      get machine() { return current; }, get installed() { return !!current; }, get ready() { return state === "ready"; } });
  }

  root.StepsembleWorkspaceAssistant = Object.freeze({ create });
})(window);
