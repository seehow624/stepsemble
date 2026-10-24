(function () {
  "use strict";

  // Assistant 的頁面只經 Stepsemble API 存取 Hermes；路由和草稿都留在前端。
  const WI = window.StepsembleWorkspaceI18n, AI = window.StepsembleAssistantI18n;
  const M = window.StepsembleAssistantModel, Api = window.StepsembleAssistantApi, Guide = window.StepsembleAssistantGuide;
  const N = window.StepsembleAssistantNavigation, A = window.StepsembleAssistantAvatars;
  const prefs = WI.preferences(localStorage, { prefersDark: matchMedia("(prefers-color-scheme: dark)").matches });
  const coarse = matchMedia("(pointer: coarse)").matches;
  // Enter in a text field, unless an input method used it to confirm text (composer-ime.js).
  const isEnter = event => !!window.stepsembleComposerIme?.isEnter(event);
  const t = (key, vars) => AI.t(key, vars, prefs.locale);
  const shell = document.getElementById("assistant-main"), listPane = document.getElementById("assistant-list"), main = document.getElementById("assistant-view");
  const top = document.querySelector(".assistant-top"), machineSelect = document.getElementById("assistant-machine");
  // Attachments follow Telegram (and the Host's own check): ten to a message, 20 MB each.
  const MACHINE_KEY = "stepsemble.assistant.machine", MAX_FILE = 20 * 1024 * 1024, MAX_FILES = 10;
  // 嵌在 Workspace 的分頁裡：只顯示這個分頁的頁面，路由留在記憶體，
  // 以訊息告訴 Workspace 目前的頁面、標題與頭像。
  const embedded = new URLSearchParams(location.search).get("embed") === "1";
  const WAM = window.StepsembleWorkspaceAssistantModel, workspace = embedded && window.parent !== window ? window.parent : null;
  const tell = message => workspace?.postMessage(message, location.origin);
  let shown = true;
  document.body.classList.toggle("assistant-embedded", embedded);
  // On a desktop the pane's title bar in the Workspace names the Bot and holds
  // its History and More; a phone shows one pane and keeps the Bot's own head,
  // with Back to the list. The Workspace's width decides, not this frame's.
  let mobilePane = false;
  if (embedded) try {
    const outer = window.parent.matchMedia("(max-width: 760px)");
    const sync = () => { mobilePane = outer.matches; document.body.classList.toggle("assistant-workspace-mobile", mobilePane); };
    sync(); outer.addEventListener?.("change", sync);
  } catch {}
  const asks = new Map(), avatars = new Map(), drafts = new Map(), sessionTitles = new Map(), groupDrafts = new Map();
  // 同一個視窗的每個 Bot 分頁各自回報正在看哪個對話。
  const clientId = (() => {
    if (embedded) return crypto.randomUUID();
    try { const saved = sessionStorage.getItem("stepsemble.assistant.client"); if (saved) return saved; } catch {}
    const id = crypto.randomUUID();
    try { sessionStorage.setItem("stepsemble.assistant.client", id); } catch {}
    return id;
  })();
  let api = null, machine = null, machines = [], bots = [], allBots = [], chat = null, chatKey = "", tab = "chat", screen = "auth";
  let stream = null, navigation = null, historyView = null, routinesView = null, groupsView = null, manageView = null, consoleView = null, guideView = null;
  let groupData = { supported: false, rooms: [] }, currentRoom = null, panel = null;
  let renderQueued = false, watchTimer = 0, reloadTimer = 0, routeRevision = 0, startRevision = 0, homeScroll = 0, rosterQuery = "";
  let routeTask = Promise.resolve();
  const content = window.StepsembleAssistantContent.create({ t, icon, toast,
    mediaUrl: (path, download) => `${api?.base || ""}/api/assistant/media?path=${encodeURIComponent(path)}${download ? "&download=1" : ""}` });
  const markdown = (text, options) => content.markdown(text, options);

  function el(tag, className = "", text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }
  function button(label, className, onClick, type = "button") {
    const node = el("button", className, label); node.type = type;
    if (onClick) node.addEventListener("click", onClick);
    return node;
  }
  const ICONS = {
    back: "M15 18l-6-6 6-6", plus: "M12 5v14M5 12h14", send: "M12 19V5M5 12l7-7 7 7",
    attach: "M20.5 11.5l-8.2 8.2a5 5 0 0 1-7.1-7.1l8.6-8.6a3.3 3.3 0 0 1 4.7 4.7l-8.5 8.5a1.7 1.7 0 0 1-2.4-2.4l7.8-7.8",
    clock: "M12 3.5a8.5 8.5 0 1 0 0 17 8.5 8.5 0 0 0 0-17zM12 7.5V12l3 2", stop: "M6.5 6.5h11v11h-11z",
    // Two speech bubbles: the conversations this Bot has had.
    history: "M8.5 14.5H6l-3 2.6V6.5A2.5 2.5 0 0 1 5.5 4h8A2.5 2.5 0 0 1 16 6.5V7M11.5 9h7a2.5 2.5 0 0 1 2.5 2.5V20l-3-2.5h-6.5A2.5 2.5 0 0 1 9 15v-3.5A2.5 2.5 0 0 1 11.5 9z",
    more: "M5.5 12h.01M12 12h.01M18.5 12h.01", close: "M6.5 6.5l11 11M17.5 6.5l-11 11", chevron: "M9.5 6l6 6-6 6",
    expand: "M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5",
    sliders: "M4 7h9M17 7h3M4 17h3M11 17h9M15 5v4M9 15v4", search: "M10.5 4a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13zM20 20l-4.6-4.6",
    open: "M14 3h7v7M10 14L21 3M10 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-5",
    download: "M12 3v12m-5-5 5 5 5-5M5 16v5h14v-5",
    share: "M12 16V3m-4 4 4-4 4 4M8 10H5v11h14V10h-3",
    // A routine's actions.
    pause: "M9 6v12M15 6v12", play: "M8 5.5v13l10-6.5z", edit: "M4 20h4L19 9l-4-4L4 16zM13.5 6.5l4 4",
    trash: "M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3",
  };
  function icon(name) {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 24 24"); svg.setAttribute("aria-hidden", "true"); svg.setAttribute("focusable", "false");
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path"); path.setAttribute("d", ICONS[name]); svg.append(path);
    return svg;
  }
  function iconButton(name, label, className, onClick, type = "button") {
    const node = button("", `assistant-icon-btn ${className}`, onClick, type);
    node.append(icon(name)); node.setAttribute("aria-label", label); node.title = label;
    return node;
  }
  function toast(text) { const note = el("p", "assistant-toast", text); note.setAttribute("role", "status"); document.body.append(note); setTimeout(() => note.remove(), 4000); }
  function layout() {
    shell.classList.toggle("has-list", !listPane.hidden); shell.classList.toggle("at-list", screen === "roster");
    document.body.classList.toggle("assistant-detail", !listPane.hidden && screen !== "roster");
  }
  function render(node) { main.replaceChildren(node); main.scrollTop = 0; layout(); }
  function showList(on) { listPane.hidden = embedded || !on; layout(); }
  function messageView(title, body, { retry, home, docs } = {}) {
    const box = el("section", "assistant-card assistant-message"); box.append(el("h1", "", title));
    if (body) box.append(el("p", "", body));
    if (retry) box.append(button(t("retry"), "btn primary", retry));
    if (home && !embedded) { const link = el("a", "btn ghost", t("workspace")); link.href = "/workspace.html"; box.append(link); }
    if (docs) { const link = el("a", "assistant-guide-link", t("guideDocs")); link.href = docs; link.target = "_blank"; link.rel = "noopener noreferrer"; box.append(link); }
    return box;
  }
  function loadingView() { const box = el("section", "assistant-loading"); box.setAttribute("role", "status"); box.append(el("span", "assistant-spinner"), el("span", "", t("loading"))); return box; }
  const errorView = (error, retry) => messageView(t("failed", { message: error?.message || "" }), "", { retry });
  function applyPreferences() {
    const root = document.documentElement; root.lang = prefs.locale; root.dataset.theme = prefs.resolvedTheme; root.dataset.designTheme = prefs.designTheme; root.dataset.look = prefs.look;
    root.classList.toggle("reduced-motion", prefs.reducedMotion); root.style.fontSize = `${prefs.fontScale}%`;
    document.title = `Stepsemble · ${t("assistant")}`;
    for (const node of document.querySelectorAll("[data-assistant-i18n]")) node.textContent = t(node.dataset.assistantI18n);
    machineSelect.setAttribute("aria-label", t("computer"));
  }
  function signInToStepsemble() {
    const params = new URLSearchParams(location.search), login = new URL("/index.html", location.origin);
    login.searchParams.set("returnWorkspace", "1");
    // 分頁不在框架裡打開登入頁：整個 Workspace 去登入，登入後回到 Workspace。
    if (embedded) { (window.top || window).location.replace(login.href); return; }
    login.searchParams.set("assistant", "1");
    for (const key of ["bot", "session", "view", "machine", "room", "panel"]) if (params.get(key)) login.searchParams.set(key, params.get(key));
    location.replace(login.href);
  }
  function avatar(bot) {
    const known = { ...allBots.find(row => row.name === bot.name), ...bot };
    const node = A.paint(el("span", "assistant-avatar"), known);
    if (api && A.resolve(known).kind === "custom") {
      if (!avatars.has(bot.name)) avatars.set(bot.name, api.botAvatar(bot.name).then(result => result.data).catch(() => null));
      void avatars.get(bot.name).then(data => { if (data) A.paint(node, known, data); });
    }
    return node;
  }
  const keyFor = route => [machine?.id, route.profile, route.session || "bot-chat"].join("/");
  function remember(entry = chat) {
    if (entry && (!drafts.get(entry.key)?.owner || drafts.get(entry.key).owner === entry)) drafts.set(entry.key, { text: entry.draft || "", attachments: entry.attachments, owner: entry });
  }
  function go(route) { navigation?.go({ ...route, machine: route.machine || machine?.id }); }
  // 分頁沒有自己的首頁：回到首頁的動作（取消、刪除、解散）關閉這個分頁。
  function showRoster() { if (embedded) tell({ type: mobilePane ? "workspace-show-list" : "assistant-close" }); else go({ page: "home" }); }
  function report() {
    if (!embedded || !navigation) return;
    const route = navigation.current;
    tell({ type: "assistant-route", route, title: WAM.title(route, { bots: allBots, groups: groupData.rooms, t }), avatar: WAM.avatarFor(route, allBots) || null });
  }
  function openBot(profile, session, { title = "", tab: page = "bot" } = {}) {
    if (session && title) sessionTitles.set(session, title);
    go({ page: page === "chat" ? "bot" : page, profile, ...(session ? { session } : {}) });
  }
  function openGroup(room) { tell({ type: "assistant-changed" }); go({ page: "group", room: room.id }); }
  function newGroup() { go({ page: "newgroup" }); }
  async function loadBots() {
    const owner = api, data = await owner.bots(); if (api !== owner) return;
    allBots = data.bots || []; bots = allBots.filter(bot => !bot.hidden);
  }
  async function loadGroups() {
    const owner = api;
    try { const data = await groupsView.load(); if (api === owner) groupData = data; }
    catch { if (api === owner) groupData = { supported: false, rooms: [] }; }
  }
  async function boot() {
    applyPreferences(); render(loadingView());
    try {
      const rows = await Api.machines({ onSignedOut: signInToStepsemble }), wanted = new URLSearchParams(location.search).get("machine");
      // 分頁固定在它的電腦上，不改用其他裝了 Hermes 的電腦。
      const checked = await Promise.all((embedded ? rows.filter(row => row.id === wanted) : rows).map(async row => ({ ...row, status: await Api.create({ base: row.base }).status().catch(() => null) })));
      let saved; try { saved = localStorage.getItem(MACHINE_KEY); } catch {}
      const choice = M.chooseHermesMachine(checked, wanted || saved);
      machines = choice.choices;
      machineSelect.replaceChildren(...machines.map(row => { const option = el("option", "", row.name); option.value = row.id; return option; }));
      machineSelect.hidden = machines.length < 2;
      machineSelect.onchange = () => {
        const next = machines.find(row => row.id === machineSelect.value); if (!next) return;
        try { localStorage.setItem(MACHINE_KEY, next.id); } catch {}
        if (navigation) go({ page: "home", machine: next.id });
        else { const url = new URL(location.href); url.searchParams.set("machine", next.id); history.replaceState(history.state, "", url); void start(next); }
      };
      if (!choice.selected) { render(messageView(t("notInstalledTitle"), t("notInstalledBody"), { home: true })); return; }
      await start(choice.selected);
    } catch (error) { if (error.code !== "stepsemble_signed_out") render(errorView(error, boot)); }
  }
  async function start(next) {
    const epoch = ++startRevision; routeRevision += 1;
    remember(); closePanel(false); groupsView?.close(); stream?.close();
    machine = next; machineSelect.value = next.id; screen = "auth"; chat = null; chatKey = ""; asks.clear(); avatars.clear(); showList(false);
    api = Api.create({ base: next.base, onSignedOut: signInToStepsemble });
    guideView = Guide.create({ t, el, button });
    routinesView = window.StepsembleAssistantRoutines.create({ api, t, el, button, icon, iconButton, toast, M, locale: prefs.locale, actions: showActions,
      botName: profile => allBots.find(bot => bot.name === profile)?.displayName || profile,
      botAvatar: profile => avatar(allBots.find(bot => bot.name === profile) || { name: profile, displayName: profile }),
      openSession: (profile, session, title) => openBot(profile, session, { title }) });
    const afterBots = action => {
      if (epoch !== startRevision) return;
      void loadBots().then(() => { if (epoch === startRevision) { action(); report(); tell({ type: "assistant-changed" }); } })
        .catch(error => { if (epoch === startRevision) toast(t("failed", { message: error.message })); });
    };
    manageView = window.StepsembleAssistantManage.create({ api, t, el, button, toast, M, machineName: () => machine?.name || "", bots: () => bots,
      onCreated: profile => afterBots(() => openBot(profile, null, { tab: "settings" })),
      onDeleted: () => afterBots(showRoster),
      onChanged: profile => { if (epoch !== startRevision) return; avatars.delete(profile); tell({ type: "assistant-changed", profile }); afterBots(() => { refreshBotHead(profile); renderRoster(); }); } });
    consoleView = window.StepsembleAssistantConsole.create({ api, t, el, button, iconButton, toast, locale: prefs.locale,
      onBack: () => { if (history.length > 1) history.back(); else location.assign("/index.html?settings=1&section=connection"); } });
    if (!groupDrafts.has(next.id)) groupDrafts.set(next.id, new Map());
    groupsView = window.StepsembleAssistantGroups.create({ api, t, el, button, iconButton, toast, avatar, markdown, bots: () => bots, drafts: groupDrafts.get(next.id),
      onBack: () => { if (epoch === startRevision) void loadGroups().finally(() => { if (epoch === startRevision) { tell({ type: "assistant-changed" }); showRoster(); } }); } });
    historyView = window.StepsembleAssistantHistory.create({ api, t, el, button, icon, M, locale: prefs.locale, showPanel, plain: content.plain,
      onSelect: (profile, row) => { if (epoch === startRevision) openBot(profile, row.id, { title: row.title }); } });
    render(loadingView());
    try {
      const status = await api.status(); if (epoch !== startRevision) return;
      if (!status.installed) { render(messageView(t("notInstalledTitle"), t("notInstalledBody"), { home: true })); return; }
      if (!status.running) { render(messageView(t("notRunningTitle"), t("notRunningBody", { computer: next.name }), { retry: () => start(next) })); return; }
      if (!status.signedIn && status.authRequired && Array.isArray(status.providers) && !status.providers.includes("basic")) {
        render(messageView(t("signInTitle"), `${t("oauthOnly")}${/^(zh|ja)/.test(prefs.locale) ? "" : " "}${t("oauthHelp", { computer: next.name })}`, { retry: () => start(next), docs: Guide.DOCS })); return;
      }
      if (!status.signedIn) { render(signInView()); return; }
      stream = api.stream({ onEvent: event => { if (epoch === startRevision) handleEvent(event); },
        onState: state => { if (epoch === startRevision) document.body.classList.toggle("assistant-offline", state === "error"); } });
      for (const ask of (await api.asks()).asks || []) asks.set(ask.id, ask);
      await Promise.all([loadBots(), loadGroups()]); if (epoch !== startRevision) return;
      if (!navigation) {
        navigation = N.create({ window: embedded ? N.memoryWindow(location.href) : window, onChange: route => { routeTask = applyRoute(route); } });
        navigation.initialize(); await routeTask;
      } else await applyRoute(navigation.current);
      if (epoch !== startRevision) return;
      if (!embedded && !Guide.seen("intro") && navigation.current.page !== "console" && !document.querySelector(".assistant-intro")) {
        closePanel(false);
        guideView.intro({ bots, avatar, onDone: () => {
          Guide.mark("intro");
          if (navigation?.current.panel) void applyRoute(navigation.current);
        } });
      }
    } catch (error) { if (epoch === startRevision) render(errorView(error, () => start(next))); }
  }

  // 面板與更多選單使用同一套關閉／焦點規則，返回只走路由控制器。
  function closePanel(restore = true) {
    historyView?.close();
    if (!panel) return;
    const previous = panel; panel = null;
    previous.layer.remove();
    document.removeEventListener("keydown", previous.keys, true);
    for (const [node, value] of previous.covered) node.inert = value;
    if (restore && previous.opener?.isConnected) previous.opener.focus();
  }
  // A panel is usually a step of the route, so closing it goes back; a menu of
  // actions on a page is not, and passes its own dismiss.
  function showPanel(title, subtitle = "", { lead = null, kind = "", dismiss = () => navigation.back() } = {}) {
    closePanel(false);
    const opener = document.activeElement, covered = new Map();
    for (const node of [...main.children, listPane, top]) { covered.set(node, node.inert); node.inert = true; }
    const layer = el("div", "assistant-overlay"), sheet = el("section", "assistant-sheet");
    if (kind) { layer.classList.add(`assistant-${kind}-layer`); sheet.classList.add(`assistant-${kind}-sheet`); }
    sheet.setAttribute("role", "dialog"); sheet.setAttribute("aria-modal", "true");
    const heading = el("h2", "", title); heading.id = "assistant-panel-title"; heading.tabIndex = -1; sheet.setAttribute("aria-labelledby", heading.id);
    const head = el("header", "assistant-sheet-head"), copy = el("div", "assistant-sheet-title"); copy.append(heading);
    if (subtitle) copy.append(el("p", "", subtitle));
    const close = iconButton("close", t("closePanel"), "assistant-sheet-close", dismiss);
    if (lead) head.append(lead);
    head.append(copy, close);
    const body = el("div", "assistant-sheet-body"); sheet.append(el("div", "assistant-sheet-grab"), head, body); layer.append(sheet); main.append(layer);
    panel = { layer, covered, opener };
    layer.addEventListener("click", event => { if (event.target === layer) dismiss(); });
    const keys = event => {
      if (panel?.layer !== layer) return;
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); dismiss(); }
      if (event.key === "Tab") {
        const focusable = [...sheet.querySelectorAll("button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), a[href], [tabindex='0']")].filter(node => node.getClientRects().length);
        const first = focusable[0], last = focusable.at(-1);
        if (!sheet.contains(document.activeElement)) { event.preventDefault(); (event.shiftKey ? last : first)?.focus(); }
        else if (event.shiftKey && (document.activeElement === first || document.activeElement === heading)) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    };
    panel.keys = keys;
    document.addEventListener("keydown", keys, true);
    heading.focus(); return { body, sheet };
  }
  function pageHead(title, back = () => navigation.back(), bot = null) {
    const head = el("header", "assistant-page-head");
    // 分頁第一層的上一頁在分頁外：電腦版不放返回，手機版和 Bot 對話一樣回到 Workspace 列表。
    if (!embedded || N.ancestors(navigation.current).length > 2) head.append(iconButton("back", t("back"), "assistant-back", back));
    else head.append(iconButton("back", t("back"), "assistant-back to-list", showRoster));
    if (bot) head.append(avatar(bot));
    head.append(el("h1", "", title)); return head;
  }
  function pageBody(title, bot) {
    const box = el("section", "assistant-roster assistant-page-body"), body = el("div"); box.append(pageHead(title, undefined, bot), body); render(box); return body;
  }
  async function ensureConversation(route, revision, force = false) {
    const key = keyFor(route);
    if (!force && chat && chatKey === key) return true;
    remember(); chat = null; chatKey = ""; watchNow(); render(loadingView());
    const owner = api, view = route.session ? await owner.openSession(route.session, route.profile) : await owner.botChat(route.profile);
    if (revision !== routeRevision || owner !== api) return false;
    const bot = allBots.find(row => row.name === route.profile) || { name: route.profile, displayName: route.profile, color: null, model: "" };
    const draft = drafts.get(key) || { text: "", attachments: [] };
    chat = { ...view, key, bot, profile: route.profile, botChat: !route.session || view.botChat === true || route.session === bot.botChat?.id,
      title: sessionTitles.get(route.session) || view.title || (route.session ? t("untitled") : t("botChat")),
      items: M.withInflight(M.fromHistory(view.messages), view.inflight), cards: new Map(), closed: [], nodes: new Map(), attachments: draft.attachments,
      draft: draft.text, sending: false, sync: null };
    chatKey = key;
    drafts.set(key, { ...draft, owner: chat });
    for (const ask of view.asks || []) asks.set(ask.id, ask);
    return true;
  }
  async function applyRoute(route, { force = false } = {}) {
    const revision = ++routeRevision;
    remember(); content.closeViewer(); closePanel(route.page === "bot");
    if (route.machine && route.machine !== machine?.id) {
      const next = machines.find(row => row.id === route.machine);
      if (next) await start(next); else go({ page: "home", machine: machine.id });
      return;
    }
    if (screen === "roster") homeScroll = listPane.scrollTop;
    screen = route.page === "home" ? "roster" : route.page; tab = route.page === "bot" ? "chat" : route.page;
    report();
    currentRoom = route.page === "group" ? route.room : null;
    showList(route.page !== "console"); layout();
    if (route.page !== "group") groupsView?.close();
    try {
      if (route.page === "bot") {
        if (!await ensureConversation(route, revision, force)) return;
        if (!document.getElementById("assistant-bot-head") || main.firstElementChild?.dataset.chat !== chat.key || force) render(botView());
        renderRoster(); watchNow(); void api.read(chat.sessionId, route.profile).catch(() => {});
        if (route.panel === "history" && !document.querySelector(".assistant-intro")) historyView.open(route.profile, chat.bot.displayName);
        if (route.panel === "menu" && !document.querySelector(".assistant-intro")) showMenu(route);
        return;
      }
      chat = null; chatKey = ""; watchNow();
      if (route.page === "home") {
        renderRoster(); const empty = el("section", "assistant-placeholder"); empty.append(el("p", "", bots.length ? t("pickBot") : t("noBots"))); render(empty); listPane.scrollTop = homeScroll;
      } else if (route.page === "group") {
        if (!groupData.rooms.some(row => row.id === route.room)) await loadGroups();
        if (revision !== routeRevision) return;
        const room = groupData.rooms.find(row => row.id === route.room); if (!room) throw new Error(t("noGroups"));
        groupsView.view(main, room); renderRoster(); layout();
      } else if (route.page === "newgroup") { groupsView.picker(main, openGroup); renderRoster(); layout(); }
      else if (route.page === "newbot") { manageView.creator(main, () => { if (embedded) showRoster(); else navigation.back(); }); renderRoster(); layout(); }
      else if (route.page === "bots") { renderManager(); renderRoster(); }
      else if (route.page === "pending") { render(pendingView()); renderRoster(); }
      else if (route.page === "routines") {
        const bot = allBots.find(row => row.name === route.profile); const body = pageBody(bot ? `${bot.displayName} · ${t("routines")}` : t("allRoutines"), bot);
        void routinesView.list(body, route.profile || null); renderRoster();
      } else if (route.page === "settings") {
        const bot = allBots.find(row => row.name === route.profile); const body = pageBody(bot ? `${bot.displayName} · ${t("settings")}` : t("settings"), bot);
        void manageView.settings(body, route.profile); renderRoster();
      } else if (route.page === "console") await consoleView.show(main);
    } catch (error) { if (revision === routeRevision) render(errorView(error, () => void applyRoute(navigation.current, { force: true }))); }
  }
  function reopen() { if (chat && navigation) void applyRoute(navigation.current, { force: true }); }
  function waitingFor(profile) { return [...asks.values()].filter(ask => ask.profile === profile).length; }
  function updatePending() {
    const node = document.getElementById("assistant-pending"); if (!node) return;
    node.hidden = asks.size === 0; node.textContent = t("pending", { count: asks.size });
    for (const row of listPane.querySelectorAll(".assistant-bot-row[data-profile]")) {
      const waiting = waitingFor(row.dataset.profile), badge = row.querySelector(".assistant-badge");
      if (badge) { badge.hidden = !waiting; badge.textContent = String(waiting); }
      row.classList.toggle("needs-reply", waiting > 0);
    }
  }
  function renderRoster() {
    if (listPane.hidden) return;
    const keep = listPane.scrollTop, wrap = el("section", "assistant-roster"), head = el("div", "assistant-section-head assistant-list-head");
    const title = el("div", "assistant-home-title"); title.append(el("h1", "", t("assistant")), el("small", "", machine?.name || ""));
    const add = button(`＋ ${t("newBot")}`, "assistant-link assistant-new-bot", () => go({ page: "newbot" }));
    add.setAttribute("aria-label", t("newBot"));
    head.append(title, add);
    const pending = button("", "assistant-pending", () => go({ page: "pending" })); pending.id = "assistant-pending";
    const search = el("input", "assistant-search assistant-bot-search"); search.type = "search"; search.spellcheck = false; search.setAttribute("autocorrect", "off"); search.setAttribute("autocapitalize", "off"); search.placeholder = t("searchBots"); search.setAttribute("aria-label", t("searchBots")); search.value = rosterQuery;
    const list = el("ul", "assistant-bot-list");
    const groupBox = el("div");
    function filterRows() {
      const query = rosterQuery.trim().toLocaleLowerCase(prefs.locale);
      const rows = [...bots].sort((a, b) => (b.botChat?.lastActive || 0) - (a.botChat?.lastActive || 0) || Number(b.isDefault) - Number(a.isDefault));
      list.replaceChildren();
      for (const bot of rows.filter(bot => `${bot.displayName} ${bot.description} ${bot.botChat?.preview || ""}`.toLocaleLowerCase(prefs.locale).includes(query))) {
        const row = button("", "assistant-bot-row", () => openBot(bot.name)); row.dataset.profile = bot.name;
        if (chat?.profile === bot.name || navigation?.current.profile === bot.name) row.setAttribute("aria-current", "true");
        const copy = el("span", "assistant-bot-copy"), first = el("span", "assistant-bot-first");
        first.append(el("strong", "", bot.displayName), el("time", "", M.formatWhen(bot.botChat?.lastActive, Date.now(), prefs.locale)));
        copy.append(first, el("small", "", WAM.preview(bot.botChat?.preview) || bot.description || ""));
        const badge = el("span", "assistant-badge", String(waitingFor(bot.name))); badge.hidden = !waitingFor(bot.name);
        row.append(avatar(bot), copy, badge); const li = el("li"); li.append(row); list.append(li);
      }
      if (!list.childElementCount) list.append(el("li", "assistant-empty", t(query ? "noMatches" : "noBots")));
      const groups = query ? { ...groupData, rooms: groupData.rooms.filter(room => `${room.name} ${room.members.map(member => member.displayName).join(" ")}`.toLocaleLowerCase(prefs.locale).includes(query)) } : groupData;
      groupBox.replaceChildren(groupsView.section(groups, openGroup, newGroup, currentRoom));
    }
    search.addEventListener("input", () => { rosterQuery = search.value; filterRows(); });
    const caption = el("div", "assistant-list-caption", t("bots"));
    const links = el("div", "assistant-home-links"); links.append(button(t("allRoutines"), "assistant-link assistant-all-routines", () => go({ page: "routines" })),
      button(t("manageBots"), "assistant-link", () => go({ page: "bots" })));
    wrap.append(head, search, pending, caption, list, groupBox, links);
    const hiddenCount = allBots.filter(bot => bot.hidden).length;
    if (hiddenCount) wrap.append(button(t("hiddenBots", { count: hiddenCount }), "assistant-link assistant-hidden-bots", () => go({ page: "bots" })));
    wrap.append(button(t("signOut"), "assistant-link assistant-sign-out", async () => {
      remember(); closePanel(false); await api.logout().catch(() => {}); stream?.close(); groupsView?.close(); navigation?.destroy(); navigation = null;
      chat = null; chatKey = ""; screen = "auth"; showList(false); render(signInView());
    }));
    filterRows(); listPane.replaceChildren(wrap); listPane.scrollTop = keep; updatePending();
  }
  function renderManager() {
    const body = pageBody(t("manageBots"));
    // New Bot is the list's quiet first row, not the page's loudest button.
    const list = el("ul", "assistant-bot-list"), add = button("", "assistant-bot-row assistant-add-row", () => go({ page: "newbot" }));
    const tile = el("span", "assistant-add-tile"), first = el("li"); tile.append(icon("plus"));
    add.append(tile, el("strong", "", t("newBot"))); first.append(add); list.append(first);
    for (const bot of allBots) {
      const row = button("", `assistant-bot-row${bot.hidden ? " is-hidden" : ""}`, () => openBot(bot.name, null, { tab: "settings" })); row.dataset.profile = bot.name;
      const copy = el("span", "assistant-bot-copy"); copy.append(el("strong", "", bot.displayName), el("small", "", bot.hidden ? t("hideBot") : bot.description));
      row.append(avatar(bot), copy, el("span", "assistant-row-chevron", "›")); const li = el("li"); li.append(row); list.append(li);
    }
    body.append(list);
  }
  function pendingView() {
    const box = el("section", "assistant-roster assistant-page-body"); box.append(pageHead(t("pendingTitle")));
    if (!asks.size) box.append(el("p", "assistant-empty", t("nothingPending")));
    for (const ask of asks.values()) {
      const row = button("", "assistant-bot-row", () => openBot(ask.profile, ask.sessionId)), bot = allBots.find(bot => bot.name === ask.profile) || { name: ask.profile, displayName: ask.bot };
      const copy = el("span", "assistant-bot-copy"); copy.append(el("strong", "", bot.displayName), el("small", "", ask.description || ask.command || ask.prompt || "")); row.append(avatar(bot), copy); box.append(row);
    }
    return box;
  }
  function conversationHead() {
    const head = el("header", "assistant-bot-head"); head.id = "assistant-bot-head";
    const back = iconButton("back", t("backAssistant"), "assistant-back to-list", showRoster);
    const title = el("div", "assistant-bot-title"); title.append(el("strong", "", chat.bot.displayName), el("small", "assistant-bot-status"));
    const history = iconButton("history", t("historyAction"), "assistant-header-action", () => go({ ...navigation.current, panel: "history" }));
    const more = iconButton("more", t("moreOptions"), "assistant-more-options", () => go({ ...navigation.current, panel: "menu" }));
    head.append(back, avatar(chat.bot), title, history, more); syncHead(head); return head;
  }
  // Under the name: that the Bot is answering now, as a chat app shows someone
  // typing; otherwise what the Bot is for, or the title of a saved conversation.
  function syncHead(head = document.getElementById("assistant-bot-head")) {
    if (!head || !chat) return;
    const running = !!chat.running, text = running ? t("working") : chat.botChat ? chat.bot.description || t("botChat") : chat.title;
    const status = head.querySelector(".assistant-bot-status");
    if (status.textContent !== text) status.textContent = text;
    head.classList.toggle("running", running);
  }
  // More options: who the Bot is, then where to manage it. A sheet from the
  // bottom on a phone; on a wide screen a small menu under its button.
  function showMenu(route) {
    const bot = chat.bot, opener = document.querySelector("#assistant-bot-head .assistant-more-options");
    const { body, sheet } = showPanel(bot.displayName, bot.description || "", { lead: avatar(bot), kind: "menu" });
    const group = el("div", "assistant-menu-group");
    for (const [page, name] of [["routines", "clock"], ["settings", "sliders"]]) {
      const row = button("", "assistant-menu-row", () => go({ page, profile: route.profile, session: route.session }));
      const tile = el("span", "assistant-menu-icon"), copy = el("span", "assistant-menu-copy"), hint = el("small", "", t(`${page}Hint`)), chevron = el("span", "assistant-menu-chevron");
      hint.id = `assistant-menu-${page}-hint`; row.setAttribute("aria-label", t(page)); row.setAttribute("aria-describedby", hint.id);
      tile.append(icon(name)); copy.append(el("strong", "", t(page)), hint); chevron.append(icon("chevron"));
      row.append(tile, copy, chevron); group.append(row);
    }
    body.append(group); anchorMenu(sheet, opener);
  }
  // On a wide screen a menu opens under its button, or above it when the
  // button is near the bottom of the page.
  function anchorMenu(sheet, opener) {
    if (!opener || !matchMedia("(min-width: 900px)").matches) return;
    const frame = main.getBoundingClientRect(), box = opener.getBoundingClientRect(), height = sheet.offsetHeight;
    sheet.style.right = `${Math.max(12, Math.round(frame.right - box.right))}px`;
    const below = box.bottom - frame.top + 6, above = box.top - frame.top - 6 - height;
    sheet.style.top = `${Math.round(below + height > frame.height - 12 && above >= 12 ? above : below)}px`;
  }
  // The actions of one thing on a page, such as a routine, in the same menu as
  // More options. An action that cannot be undone asks for a second tap.
  function showActions(opener, title, subtitle, items) {
    const { body, sheet } = showPanel(title, subtitle, { kind: "menu", dismiss: () => closePanel() });
    const group = el("div", "assistant-menu-group");
    for (const item of items) {
      const tile = el("span", "assistant-menu-icon"), copy = el("span", "assistant-menu-copy"), label = el("strong", "", item.label);
      let armed = false;
      const row = button("", `assistant-menu-row${item.danger ? " assistant-danger" : ""}`, () => {
        if (item.confirm && !armed) {
          armed = true; label.textContent = item.confirm;
          setTimeout(() => { armed = false; label.textContent = item.label; }, 4000);
          return;
        }
        closePanel(); void item.action();
      });
      tile.append(icon(item.icon)); copy.append(label); row.append(tile, copy); group.append(row);
    }
    body.append(group); anchorMenu(sheet, opener);
  }
  function refreshBotHead(profile) {
    const bot = allBots.find(bot => bot.name === profile);
    if (chat?.profile === profile) {
      chat.bot = bot || chat.bot;
      document.getElementById("assistant-bot-head")?.replaceWith(conversationHead());
    } else if (bot && navigation?.current.profile === profile && ["settings", "routines"].includes(navigation.current.page)) {
      const label = t(navigation.current.page);
      main.querySelector(".assistant-page-head")?.replaceWith(pageHead(`${bot.displayName} · ${label}`, undefined, bot));
    }
  }
  function botView() {
    const wrap = el("section", "assistant-bot"); wrap.dataset.chat = chat.key;
    const transcript = el("div", "assistant-transcript"); transcript.id = "assistant-transcript";
    wrap.append(conversationHead(), transcript, composer()); chat.nodes.clear();
    queueMicrotask(() => { if (wrap.isConnected) { renderTranscript(); scrollToEnd(); } });
    return wrap;
  }

  // Sign in to Hermes. The first time, a short guide explains where the
  // username and password come from; the form can reopen it.
  function signInView({ guide = !Guide.seen("signin") } = {}) {
    const page = el("div", "assistant-auth");
    if (guide) {
      page.append(guideView.setup({ computer: machine.name, onDone: () => { Guide.mark("signin"); render(signInView({ guide: false })); } }));
      return page;
    }
    const form = el("form", "assistant-card assistant-sign-in");
    page.append(form);
    const error = el("p", "assistant-error");
    error.hidden = true;
    const field = (label, type, autocomplete) => {
      const wrap = el("label", "assistant-field");
      const input = el("input");
      input.type = type; input.autocomplete = autocomplete; input.required = true;
      wrap.append(el("span", "", label), input);
      return { wrap, input };
    };
    const username = field(t("username"), "text", "username"), password = field(t("password"), "password", "current-password");
    const submit = button(t("signIn"), "btn primary", null, "submit");
    const where = el("p", "assistant-computer");
    where.append(el("span", "assistant-computer-dot"), el("span", "", machine.name));
    const help = button(t("guideHelp"), "assistant-link assistant-guide-open", () => render(signInView({ guide: true })));
    form.append(where, el("h1", "", t("signInTitle")), el("p", "assistant-sign-in-body", t("signInBody", { computer: machine.name })),
      username.wrap, password.wrap, error, submit, help);
    queueMicrotask(() => username.input.focus());
    form.addEventListener("submit", async event => {
      event.preventDefault();
      submit.disabled = true;
      error.hidden = true;
      const secret = password.input.value;
      password.input.value = "";
      try {
        await api.login(username.input.value, secret);
        tell({ type: "assistant-signed-in" });
        await start(machine);
      } catch (failure) {
        const key = { hermes_invalid_credentials: "wrongPassword", hermes_rate_limited: "rateLimited", hermes_oauth_only: "oauthOnly" }[failure.code];
        error.textContent = key ? t(key) : t("failed", { message: failure.message });
        error.hidden = false;
        submit.disabled = false;
        password.input.focus();
      }
    });
    return page;
  }


  function disclosure(label) { const summary = el("summary", "", label); summary.prepend(icon("chevron")); return summary; }
  // A file in a message or the composer: its type in a small badge, then its name.
  function fileChip(name) {
    const chip = el("span", "assistant-chip"), ext = /\.([A-Za-z0-9]{1,5})$/.exec(name)?.[1] || "";
    const badge = el("span", "assistant-chip-badge", (ext || "file").slice(0, 4).toUpperCase()); badge.setAttribute("aria-hidden", "true");
    chip.append(badge, el("span", "assistant-chip-name", name)); return chip;
  }
  function itemNode(item) {
    const cached = chat.nodes.get(item.id);
    if (cached && cached.rev === item.rev) return cached.node;
    const node = el("div", `assistant-msg ${item.role}`);
    if (item.role === "user") {
      // Pictures sent from this page show as pictures above the text; other files as chips.
      const pictures = item.attachments.filter(entry => entry?.src), files = item.attachments.filter(entry => !entry?.src);
      if (pictures.length) {
        const album = el("div", `assistant-album${pictures.length === 1 ? " single" : ""}`);
        for (const picture of pictures) {
          const open = button("", "assistant-album-item", () => content.view({ kind: "image", name: picture.name, src: picture.src }, open)), image = el("img");
          open.setAttribute("aria-label", `${t("fileOpen")} ${picture.name}`); image.src = picture.src; image.alt = ""; open.append(image); album.append(open);
        }
        node.append(album);
      }
      if (item.text || files.length) {
        const bubble = el("div", "assistant-bubble", item.text);
        for (const entry of files) bubble.append(fileChip(entry?.name ?? entry));
        node.append(bubble);
      }
    } else if (item.role === "system") node.textContent = item.text;
    else {
      const body = el("div", "assistant-reply");
      const steps = el("div", "assistant-steps");
      if (item.thinking) {
        const details = el("details", "assistant-thinking");
        details.append(disclosure(t("thinking")), el("pre", "", item.thinking));
        steps.append(details);
      }
      if (item.tools.length) {
        const running = item.tools.some(tool => !tool.done);
        const group = el("details", `assistant-tool-group${running ? " running" : ""}`);
        group.append(disclosure(t(running ? "toolsRunning" : "toolsComplete", { count: item.tools.length })));
        for (const tool of item.tools) {
          const details = el("details", "assistant-tool");
          details.append(el("summary", "", tool.name));
          if (tool.detail || tool.result) details.append(el("pre", "", [tool.detail, tool.result].filter(Boolean).join("\n\n")));
          group.append(details);
        }
        steps.append(group);
      }
      if (steps.childElementCount) body.append(steps);
      if (item.text) body.append(markdown(item.text, { complete: !item.streaming }));
      if (item.streaming && !item.text) body.append(el("p", "assistant-working", t("working")));
      node.append(avatar(chat.bot), body);
    }
    chat.nodes.set(item.id, { rev: item.rev, node });
    return node;
  }

  function askCard(ask) {
    if (chat.cards.has(ask.id)) return chat.cards.get(ask.id);
    const card = el("section", `assistant-ask assistant-ask-${ask.kind}`);
    card.dataset.ask = ask.id;
    const error = el("p", "assistant-error");
    error.hidden = true;
    const controls = () => card.querySelectorAll("button, input, textarea");
    const send = async answer => {
      for (const node of controls()) node.disabled = true;
      error.hidden = true;
      try { await api.respond(ask.id, answer); } catch (failure) {
        error.textContent = t("failed", { message: failure.message });
        error.hidden = false;
        for (const node of controls()) node.disabled = false;
      }
    };
    const actions = (...nodes) => { const row = el("div", "assistant-ask-actions"); row.append(...nodes); return row; };
    if (ask.kind === "approval") {
      card.append(el("h3", "", t("approvalTitle", { bot: ask.bot })));
      if (ask.command) card.append(el("pre", "assistant-ask-command", ask.command));
      if (ask.description) card.append(el("p", "", ask.description));
      // The narrowest permission is the obvious one; the wider ones stay quiet.
      card.append(actions(...ask.choices.map((choice, index) => button(t(choice), index === 0 && choice !== "deny" ? "btn primary" : choice === "deny" ? "btn ghost assistant-danger" : "btn ghost", () => send({ choice })))));
    } else if (ask.kind === "clarify") {
      card.append(el("h3", "", t("clarifyTitle", { bot: ask.bot })));
      const answers = {};
      for (const question of ask.questions) {
        const block = el("div", "assistant-ask-question");
        block.append(el("p", "", question.question));
        if (question.choices?.length) {
          const row = el("div", "assistant-ask-choices");
          const picked = new Set();
          for (const choice of question.choices) {
            const node = button(choice, "assistant-choice", () => {
              if (question.multiSelect) { if (picked.has(choice)) picked.delete(choice); else picked.add(choice); } else { picked.clear(); picked.add(choice); }
              answers[question.qid] = [...picked].join(", ");
              for (const other of row.children) other.setAttribute("aria-pressed", String(picked.has(other.textContent)));
            });
            node.setAttribute("aria-pressed", "false");
            row.append(node);
          }
          block.append(row);
        } else {
          const input = el("textarea", "assistant-ask-input");
          input.rows = 2;
          input.placeholder = t("answer");
          input.addEventListener("input", () => { answers[question.qid] = input.value; });
          block.append(input);
        }
        card.append(block);
      }
      card.append(actions(button(t("submit"), "btn primary", () => send({ answers })), button(t("skip"), "btn ghost", () => send({ answers: {} }))));
    } else {
      card.append(el("h3", "", ask.kind === "sudo" ? t("sudoTitle", { bot: ask.bot }) : t("secretTitle", { bot: ask.bot, name: ask.envVar || "" })));
      if (ask.kind === "sudo" && ask.command) card.append(el("pre", "assistant-ask-command", ask.command));
      if (ask.kind === "secret" && ask.prompt) card.append(el("p", "", ask.prompt));
      const form = el("form", "assistant-ask-secret");
      const input = el("input");
      input.type = "password"; input.autocomplete = "off"; input.placeholder = t("hiddenValue");
      input.setAttribute("aria-label", t("hiddenValue"));
      form.append(input, actions(button(t("submit"), "btn primary", null, "submit"), button(t("skip"), "btn ghost", () => send({ value: "" }))));
      form.addEventListener("submit", event => {
        event.preventDefault();
        const value = input.value;
        input.value = "";
        void send({ value });
      });
      card.append(form);
    }
    card.append(error);
    chat.cards.set(ask.id, card);
    return card;
  }

  function renderTranscript() {
    const box = document.getElementById("assistant-transcript");
    if (!box || !chat) return;
    const pinned = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
    const children = chat.items.map(itemNode);
    for (const closed of chat.closed) children.push(el("p", "assistant-ask-closed", `${closed.title} · ${t(closed.reason === "answered" ? "answered" : "withdrawn")}`));
    for (const ask of asks.values()) if (ask.sessionId === chat.sessionId) children.push(askCard(ask));
    box.replaceChildren(...children);
    if (pinned) box.scrollTop = box.scrollHeight;
    chat.sync?.(); syncHead();
  }
  function scheduleRender() {
    if (renderQueued) return;
    renderQueued = true;
    setTimeout(() => requestAnimationFrame(() => { renderQueued = false; renderTranscript(); }), 80);
  }
  function scrollToEnd() { const box = document.getElementById("assistant-transcript"); if (box) box.scrollTop = box.scrollHeight; }

  function readBase64(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).split(",", 2)[1] || "");
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file);
    });
  }

  // A pasted screenshot arrives as "image.png" or with no name, so it gets one
  // of its own; a file copied in Finder keeps its name.
  function pastedName(file, taken) {
    if (file.name && !/^image\.\w+$/i.test(file.name)) return file.name;
    const at = new Date(), pad = value => String(value).padStart(2, "0");
    const stamp = `${at.getFullYear()}${pad(at.getMonth() + 1)}${pad(at.getDate())}-${pad(at.getHours())}${pad(at.getMinutes())}${pad(at.getSeconds())}`;
    const ext = (/\.(\w+)$/.exec(file.name || "")?.[1] || (file.type.split("/")[1] || "png").replace(/\W.*$/, "").replace("jpeg", "jpg")).toLowerCase();
    let name = `pasted-${stamp}.${ext}`;
    for (let count = 2; taken.has(name); count += 1) name = `pasted-${stamp}-${count}.${ext}`;
    return name;
  }

  function composer() {
    // 固定這個表單所屬的對話與 API，避免送出等待期間切換 Bot 而寫到別筆。
    const entry = chat, owner = api;
    const form = el("form", "assistant-composer"), chips = el("div", "assistant-attachments"), input = el("textarea", "assistant-input");
    input.rows = 1; input.value = entry.draft;
    input.placeholder = t("messagePlaceholder", { name: entry.bot.displayName }); input.setAttribute("aria-label", input.placeholder);
    const file = el("input"); file.type = "file"; file.multiple = true; file.hidden = true;
    const attach = iconButton("attach", t("attach"), "assistant-attach", () => file.click());
    const hint = el("p", "assistant-hint", t("interruptHint"));
    const send = iconButton("send", t("send"), "assistant-send", null, "submit");
    const stop = iconButton("stop", t("stop"), "assistant-stop", () => void owner.interrupt(entry.sessionId).catch(error => toast(t("failed", { message: error.message }))));
    function renderChips() {
      chips.replaceChildren(...entry.attachments.map((item, index) => {
        const remove = iconButton("close", `${t("remove")} ${item.name}`, "assistant-chip-remove", () => {
          const [gone] = entry.attachments.splice(index, 1); if (gone?.preview) URL.revokeObjectURL(gone.preview);
          remember(entry); renderChips(); sync();
        });
        if (!item.preview) { const chip = fileChip(item.name); chip.append(remove); return chip; }
        // A picture shows as itself; its name stays for screen readers and the tooltip.
        const chip = el("span", "assistant-chip assistant-thumb"), image = el("img");
        image.src = item.preview; image.alt = ""; chip.title = item.name;
        chip.append(image, el("span", "assistant-chip-name", item.name), remove); return chip;
      }));
    }
    function sync() {
      stop.hidden = !entry.running; hint.hidden = !(entry.running && input.value.trim());
      send.disabled = entry.sending || !(input.value.trim() || entry.attachments.length);
      input.style.height = "auto"; input.style.height = `${Math.min(input.scrollHeight, 180)}px`;
    }
    async function addFiles(list, { pasted = false } = {}) {
      try {
        for (const picked of list) {
          if (entry.attachments.length >= MAX_FILES) { toast(t("tooMany", { count: MAX_FILES })); break; }
          if (picked.size > MAX_FILE) { toast(t("tooLarge", { name: picked.name, size: MAX_FILE / 1024 / 1024 })); continue; }
          const data = await readBase64(picked);
          const name = pasted ? pastedName(picked, new Set(entry.attachments.map(item => item.name))) : picked.name;
          const image = picked.type.startsWith("image/");
          entry.attachments.push({ kind: image ? "image" : "file", name, mime: picked.type || "application/octet-stream", data,
            ...(image ? { preview: URL.createObjectURL(picked) } : {}) });
        }
        remember(entry); renderChips(); sync();
      } catch (error) { toast(t("failed", { message: error.message })); }
    }
    file.addEventListener("change", async () => {
      try { await addFiles([...file.files]); } finally { file.value = ""; }
    });
    input.addEventListener("paste", event => {
      const files = [...(event.clipboardData?.files || [])];
      if (!files.length) return;
      // Excel, Numbers and Word put a picture of the copied part beside its
      // text; that stays a text paste. Finder puts the file name beside a file.
      const text = event.clipboardData.getData("text/plain");
      if (text.trim() && files.every(picked => picked.type.startsWith("image/") && !text.includes(picked.name))) return;
      event.preventDefault();
      void addFiles(files, { pasted: true });
    });
    input.addEventListener("input", () => { entry.draft = input.value; remember(entry); sync(); });
    input.addEventListener("keydown", event => {
      if (isEnter(event) && !event.shiftKey && !coarse) { event.preventDefault(); form.requestSubmit(); }
    });
    form.addEventListener("submit", async event => {
      event.preventDefault(); if (chat !== entry || entry.sending) return;
      const text = input.value; if (!text.trim() && !entry.attachments.length) return;
      const attachments = entry.attachments; entry.sending = true; entry.running = true;
      entry.items.push(M.userItem(text, attachments.map(item => item.preview ? { name: item.name, src: item.preview } : item.name)));
      entry.attachments = []; entry.draft = ""; input.value = ""; remember(entry);
      renderChips(); renderTranscript(); scrollToEnd(); sync();
      try { await owner.prompt(entry.sessionId, text, attachments.map(({ preview, ...item }) => item)); }
      catch (error) {
        entry.running = false;
        entry.items.push(M.systemItem(t("sendFailed", { message: error.message })));
        if (!entry.draft) entry.draft = text;
        entry.attachments = [...attachments, ...entry.attachments].slice(0, MAX_FILES);
        remember(entry);
        if (chat === entry) { if (!input.value) input.value = entry.draft; renderChips(); renderTranscript(); }
      } finally { entry.sending = false; if (chat === entry) sync(); }
    });
    // One rounded field holds what is attached, the text and its buttons.
    const field = el("div", "assistant-composer-field"), row = el("div", "assistant-composer-row");
    row.append(attach, input, stop, send); field.append(chips, row); form.append(hint, field, file);
    const speedCopy = window.StepsembleAgentSpeed;
    if (speedCopy) {
      const language = window.stepsembleI18n?.getLocale?.() || "en";
      const speed = el("p", "assistant-speed-note");
      speed.textContent = speedCopy.t("title", language) + ": " + speedCopy.t("unknown", language) + " · " + speedCopy.t("unverified", language);
      form.append(speed);
    }
    entry.sync = sync; queueMicrotask(() => { renderChips(); sync(); }); return form;
  }

  // ---- events from Hermes ------------------------------------------------

  function scheduleReload() {
    clearTimeout(reloadTimer);
    reloadTimer = setTimeout(async () => {
      try { await loadBots(); } catch { return; }
      renderRoster(); report(); tell({ type: "assistant-changed" });
    }, 600);
  }

  function handleEvent(event) {
    if (!event || typeof event.type !== "string") return;
    if (event.type === "ask") {
      asks.set(event.payload.id, event.payload);
      updatePending();
      if (chat && event.sessionId === chat.sessionId) scheduleRender();
      return;
    }
    if (event.type === "ask.closed") {
      const ask = asks.get(event.payload.id);
      asks.delete(event.payload.id);
      updatePending();
      if (chat && ask && ask.sessionId === chat.sessionId) {
        chat.cards.delete(ask.id);
        const title = ask.kind === "approval" ? t("approvalTitle", { bot: ask.bot }) : ask.kind === "clarify" ? t("clarifyTitle", { bot: ask.bot })
          : ask.kind === "sudo" ? t("sudoTitle", { bot: ask.bot }) : t("secretTitle", { bot: ask.bot, name: ask.envVar || "" });
        chat.closed.push({ title, reason: event.payload.reason });
        scheduleRender();
      }
      return;
    }
    if (event.type === "sessions.changed" || event.type === "cron.changed") { scheduleReload(); return; }
    if (event.type === "replay.gap") { reopen(); return; }
    if (event.type === "session.reload") { if (chat && event.sessionId === chat.sessionId) reopen(); return; }
    if (!chat || event.sessionId !== chat.sessionId || event.id <= chat.cursor) {
      if (event.type === "message.complete") scheduleReload();
      return;
    }
    if (!M.applyEvent(chat.items, event)) return;
    if (event.type === "message.start") chat.running = true;
    if (event.type === "message.complete" || event.type === "error") {
      chat.running = false;
      scheduleReload();
      void api.read(chat.sessionId, chat.profile).catch(() => {});
    }
    if (tab === "chat") scheduleRender();
  }

  function watchNow() {
    clearTimeout(watchTimer);
    if (!api) return;
    const visible = document.visibilityState === "visible" && shown;
    void api.watch(clientId, visible && chat ? chat.sessionId : null).catch(() => {});
    if (visible && chat) watchTimer = setTimeout(watchNow, 20_000);
  }

  document.addEventListener("visibilitychange", watchNow);
  // 在 Workspace 分頁裡：切換分頁、聚焦面板與 Workspace 的指示都經由訊息。
  if (embedded) {
    addEventListener("message", event => {
      if (event.origin !== location.origin || event.source !== window.parent) return;
      const data = event.data || {};
      if (data.type === "workspace-detach") { stream?.close(); shown = false; watchNow(); }
      if (data.type === "workspace-visibility") { shown = data.visible === true; watchNow(); }
      // The pane's title bar holds the conversation's History and More.
      if (data.type === "workspace-command" && navigation && chat && ["history", "menu"].includes(data.command)) go({ ...navigation.current, panel: data.command });
      if (data.type === "assistant-navigate" && navigation && data.route && typeof data.route === "object") {
        const route = N.normalize({ ...data.route, machine: machine?.id });
        if (route.page === data.route.page) go(route);
      }
    });
    addEventListener("pointerdown", () => tell({ type: "workspace-focus" }), { passive: true });
    addEventListener("keydown", event => {
      if (event.isComposing || !event.metaKey || !event.altKey || event.ctrlKey || event.shiftKey || !["ArrowLeft", "ArrowRight"].includes(event.key)) return;
      event.preventDefault(); event.stopImmediatePropagation();
      tell({ type: "workspace-select-tab", direction: event.key === "ArrowLeft" ? -1 : 1 });
    }, true);
  }
  if (!embedded) navigator.serviceWorker?.addEventListener("message", event => {
    if (event.data?.type !== "STEPSEMBLE_OPEN_ASSISTANT" || typeof event.data.url !== "string") return;
    const url = new URL(event.data.url, location.origin);
    if (url.origin !== location.origin || url.pathname !== "/assistant.html" || !api) return;
    const bot = url.searchParams.get("bot");
    if (bot) void openBot(bot, url.searchParams.get("session") || null);
  });

  void boot();
})();
