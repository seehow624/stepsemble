(function () {
  "use strict";

  // The assistant page: Hermes Bots and their conversations, served by the
  // computer that runs Hermes. Every call goes through that computer's
  // /api/assistant; this page never talks to Hermes itself, and an answer to
  // a sudo or secret question leaves its field as soon as it is sent.

  const WI = window.StepsembleWorkspaceI18n, AI = window.StepsembleAssistantI18n;
  const M = window.StepsembleAssistantModel, Api = window.StepsembleAssistantApi;
  const MACHINE_KEY = "stepsemble.assistant.machine";
  const MAX_FILE = 10 * 1024 * 1024, MAX_FILES = 4;
  const params = new URLSearchParams(location.search);
  const prefs = WI.preferences(localStorage, { prefersDark: matchMedia("(prefers-color-scheme: dark)").matches });
  const coarse = matchMedia("(pointer: coarse)").matches;
  const t = (key, vars) => AI.t(key, vars, prefs.locale);
  const main = document.getElementById("assistant-main");
  const machineSelect = document.getElementById("assistant-machine");
  const clientId = (() => {
    try { const saved = sessionStorage.getItem("stepsemble.assistant.client"); if (saved) return saved; } catch {}
    const id = crypto.randomUUID();
    try { sessionStorage.setItem("stepsemble.assistant.client", id); } catch {}
    return id;
  })();
  const asks = new Map();
  const listing = { query: "", rows: [], hasMore: false };
  let api = null, machine = null, bots = [], stream = null, chat = null, tab = "chat", screen = "";
  let renderQueued = false, watchTimer = 0, reloadTimer = 0, routinesView = null, groupsView = null;
  let groupData = { supported: false, rooms: [] }, allBots = [], manageView = null, consoleView = null, showHidden = false;
  const avatars = new Map();

  function el(tag, className = "", text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }
  function button(label, className, onClick, type = "button") {
    const node = el("button", className, label);
    node.type = type;
    if (onClick) node.addEventListener("click", onClick);
    return node;
  }
  const render = node => main.replaceChildren(node);
  function toast(text) {
    const note = el("p", "assistant-toast", text);
    note.setAttribute("role", "status");
    document.body.append(note);
    setTimeout(() => note.remove(), 4000);
  }

  function applyPreferences() {
    const root = document.documentElement;
    root.lang = prefs.locale;
    root.dataset.theme = prefs.resolvedTheme;
    root.dataset.designTheme = prefs.designTheme;
    root.classList.toggle("reduced-motion", prefs.reducedMotion);
    root.style.fontSize = `${prefs.fontScale}%`;
    document.title = `Stepsemble · ${t("assistant")}`;
    for (const node of document.querySelectorAll("[data-assistant-i18n]")) node.textContent = t(node.dataset.assistantI18n);
    machineSelect.setAttribute("aria-label", t("computer"));
  }

  function signInToStepsemble() {
    const login = new URL("/index.html", location.origin);
    login.searchParams.set("returnWorkspace", "1");
    login.searchParams.set("assistant", "1");
    for (const key of ["bot", "session", "view"]) if (params.get(key)) login.searchParams.set(key, params.get(key));
    location.replace(login.href);
  }

  function setUrl(profile, sessionId) {
    const url = new URL(location.href);
    url.search = "";
    if (profile) url.searchParams.set("bot", profile);
    if (profile && sessionId) url.searchParams.set("session", sessionId);
    history.replaceState(null, "", url);
  }

  function messageView(title, body, { retry, home } = {}) {
    const box = el("section", "assistant-message");
    box.append(el("h1", "", title));
    if (body) box.append(el("p", "", body));
    if (retry) box.append(button(t("retry"), "btn primary", retry));
    if (home) { const link = el("a", "btn ghost", t("workspace")); link.href = "/workspace.html"; box.append(link); }
    return box;
  }
  const loadingView = () => messageView(t("loading"), "");
  const errorView = (error, retry) => messageView(t("failed", { message: error?.message || "" }), "", { retry });

  // A Bot's picture when Hermes has one (fetched once per page), else its initials.
  function avatar(bot) {
    const node = el("span", "assistant-avatar", M.initials(bot.displayName || bot.name));
    node.style.background = M.colorFor(bot.name, bot.color);
    node.setAttribute("aria-hidden", "true");
    const known = allBots.find(row => row.name === bot.name);
    if (api && (bot.hasAvatar || known?.hasAvatar)) {
      if (!avatars.has(bot.name)) avatars.set(bot.name, api.botAvatar(bot.name).then(result => result.data).catch(() => null));
      void avatars.get(bot.name).then(data => {
        if (!data) return;
        node.textContent = "";
        node.style.backgroundImage = `url("${data}")`;
        node.classList.add("has-picture");
      });
    }
    return node;
  }

  // ---- start-up -------------------------------------------------------

  async function boot() {
    applyPreferences();
    render(loadingView());
    let rows;
    try { rows = await Api.machines({ onSignedOut: signInToStepsemble }); } catch (error) {
      if (error.code !== "stepsemble_signed_out") render(errorView(error, boot));
      return;
    }
    const checked = await Promise.all(rows.map(async row => ({ ...row, status: await Api.create({ base: row.base }).status().catch(() => null) })));
    let saved = null;
    try { saved = localStorage.getItem(MACHINE_KEY); } catch {}
    const { choices, selected } = M.chooseHermesMachine(checked, saved);
    machineSelect.replaceChildren(...choices.map(row => { const option = el("option", "", row.name); option.value = row.id; return option; }));
    machineSelect.hidden = choices.length < 2;
    machineSelect.onchange = () => {
      const next = choices.find(row => row.id === machineSelect.value);
      try { localStorage.setItem(MACHINE_KEY, next.id); } catch {}
      void start(next);
    };
    if (!selected) { render(messageView(t("notInstalledTitle"), t("notInstalledBody"), { home: true })); return; }
    machineSelect.value = selected.id;
    await start(selected);
  }

  async function start(next) {
    machine = next;
    stream?.close();
    stream = null;
    chat = null;
    asks.clear();
    api = Api.create({ base: next.base, onSignedOut: signInToStepsemble });
    routinesView = window.StepsembleAssistantRoutines.create({ api, t, el, button, toast, M, locale: prefs.locale,
      botName: profile => allBots.find(bot => bot.name === profile)?.displayName || profile,
      openSession: (profile, sessionId, title) => void openBot(profile, sessionId, { title }) });
    avatars.clear();
    manageView = window.StepsembleAssistantManage.create({ api, t, el, button, toast, M, machineName: () => machine?.name || "", bots: () => bots,
      onCreated: profile => void loadBots().catch(() => {}).finally(() => void openBot(profile, null, { tab: "settings" })),
      onDeleted: () => void loadBots().catch(() => {}).finally(showRoster),
      onChanged: profile => { avatars.delete(profile); void loadBots().then(() => refreshBotHead(profile)).catch(() => {}); } });
    consoleView = window.StepsembleAssistantConsole.create({ api, t, el, button, toast, locale: prefs.locale,
      onBack: () => { if (history.length > 1) history.back(); else location.assign("/index.html?settings=1&section=connection"); } });
    groupsView?.close();
    groupsView = window.StepsembleAssistantGroups.create({ api, t, el, button, toast, avatar, markdown, bots: () => bots,
      onBack: () => void loadGroups().finally(showRoster) });
    render(loadingView());
    let status;
    try { status = await api.status(); } catch (error) { render(errorView(error, () => start(next))); return; }
    if (!status.installed) { render(messageView(t("notInstalledTitle"), t("notInstalledBody"), { home: true })); return; }
    if (!status.running) { render(messageView(t("notRunningTitle"), t("notRunningBody", { computer: next.name }), { retry: () => start(next) })); return; }
    if (!status.signedIn) { render(signInView()); return; }
    stream = api.stream({ onEvent: handleEvent, onState: state => document.body.classList.toggle("assistant-offline", state === "error") });
    try {
      for (const ask of (await api.asks()).asks || []) asks.set(ask.id, ask);
      await loadBots();
      await loadGroups();
    } catch (error) { render(errorView(error, () => start(next))); return; }
    if (params.get("view") === "console") { screen = "console"; await consoleView.show(main); return; }
    const bot = params.get("bot");
    if (bot) await openBot(bot, params.get("session") || null);
    else showRoster();
  }

  function signInView() {
    const form = el("form", "assistant-sign-in");
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
    form.append(el("h1", "", t("signInTitle")), el("p", "", t("signInBody", { computer: machine.name })), username.wrap, password.wrap, error, submit);
    form.addEventListener("submit", async event => {
      event.preventDefault();
      submit.disabled = true;
      error.hidden = true;
      const secret = password.input.value;
      password.input.value = "";
      try {
        await api.login(username.input.value, secret);
        await start(machine);
      } catch (failure) {
        const key = { hermes_invalid_credentials: "wrongPassword", hermes_rate_limited: "rateLimited", hermes_oauth_only: "oauthOnly" }[failure.code];
        error.textContent = key ? t(key) : t("failed", { message: failure.message });
        error.hidden = false;
        submit.disabled = false;
        password.input.focus();
      }
    });
    return form;
  }

  // ---- Bots -----------------------------------------------------------

  async function loadBots() {
    allBots = (await api.bots()).bots || [];
    bots = allBots.filter(bot => !bot.hidden);
  }

  async function loadGroups() { try { groupData = await groupsView.load(); } catch { groupData = { supported: false, rooms: [] }; } }
  function openGroup(room) { chat = null; screen = "group"; setUrl(null, null); watchNow(); groupsView.view(main, room); }
  function newGroup() { chat = null; screen = "group"; groupsView.picker(main, openGroup); }

  function waitingFor(profile) { return [...asks.values()].filter(ask => ask.profile === profile).length; }

  function updatePending() {
    const node = document.getElementById("assistant-pending");
    if (!node) return;
    node.hidden = asks.size === 0;
    node.textContent = t("pending", { count: asks.size });
  }

  function showRoster() {
    groupsView?.close();
    chat = null;
    screen = "roster";
    setUrl(null, null);
    watchNow();
    const wrap = el("section", "assistant-roster");
    const head = el("div", "assistant-section-head");
    const pending = button("", "assistant-pending", () => { screen = "pending"; render(pendingView()); });
    pending.id = "assistant-pending";
    const all = button(t("allRoutines"), "btn ghost assistant-all-routines", () => {
      screen = "routines";
      const box = el("section", "assistant-roster");
      const top = el("div", "assistant-section-head");
      const back = button("‹", "btn ghost assistant-back", showRoster);
      back.setAttribute("aria-label", t("back"));
      top.append(back, el("h1", "", t("allRoutines")));
      const body = el("div");
      box.append(top, body);
      render(box);
      void routinesView.list(body, null);
    });
    const add = button(t("newBot"), "btn ghost assistant-new-bot", () => { screen = "newbot"; chat = null; manageView.creator(main, showRoster); });
    head.append(el("h1", "", t("bots")), pending, all, add);
    wrap.append(head);
    if (!bots.length) wrap.append(el("p", "assistant-empty", t("noBots")));
    const list = el("ul", "assistant-bot-list");
    const hiddenBots = allBots.filter(bot => bot.hidden);
    const sorted = [...bots, ...(showHidden ? hiddenBots : [])].sort((a, b) => (b.botChat?.lastActive || 0) - (a.botChat?.lastActive || 0) || Number(b.isDefault) - Number(a.isDefault));
    for (const bot of sorted) {
      const row = button("", "assistant-bot-row", () => void openBot(bot.name, null));
      row.dataset.profile = bot.name;
      if (bot.hidden) row.classList.add("is-hidden");
      const copy = el("span", "assistant-bot-copy");
      copy.append(el("strong", "", bot.displayName), el("small", "", bot.botChat?.preview || bot.description || ""));
      const meta = el("span", "assistant-bot-meta");
      meta.append(el("time", "", M.formatWhen(bot.botChat?.lastActive, Date.now(), prefs.locale)));
      const waiting = waitingFor(bot.name);
      if (waiting) meta.append(el("span", "assistant-badge", String(waiting)));
      row.append(avatar(bot), copy, meta);
      const item = el("li");
      item.append(row);
      list.append(item);
    }
    if (hiddenBots.length) {
      const toggle = button(t("hiddenBots", { count: hiddenBots.length }), "btn ghost assistant-hidden-bots", () => { showHidden = !showHidden; showRoster(); });
      toggle.setAttribute("aria-pressed", String(showHidden));
      wrap.append(list, toggle);
    } else wrap.append(list);
    wrap.append(groupsView.section(groupData, openGroup, newGroup));
    wrap.append(button(t("signOut"), "btn ghost assistant-sign-out", async () => {
      await api.logout().catch(() => {});
      stream?.close();
      stream = null;
      render(signInView());
    }));
    render(wrap);
    updatePending();
  }

  function pendingView() {
    const wrap = el("section", "assistant-roster");
    const head = el("div", "assistant-section-head");
    const back = button("‹", "btn ghost assistant-back", showRoster);
    back.setAttribute("aria-label", t("back"));
    head.append(back, el("h1", "", t("pendingTitle")));
    wrap.append(head);
    if (!asks.size) wrap.append(el("p", "assistant-empty", t("nothingPending")));
    const list = el("ul", "assistant-bot-list");
    for (const ask of asks.values()) {
      const bot = allBots.find(row => row.name === ask.profile) || { name: ask.profile, displayName: ask.bot };
      const row = button("", "assistant-bot-row", () => void openBot(ask.profile, ask.sessionId));
      const copy = el("span", "assistant-bot-copy");
      copy.append(el("strong", "", bot.displayName), el("small", "", ask.description || ask.command || ask.prompt || ask.questions?.[0]?.question || ""));
      row.append(avatar(bot), copy);
      const item = el("li");
      item.append(row);
      list.append(item);
    }
    wrap.append(list);
    return wrap;
  }

  // ---- a conversation -----------------------------------------------------

  async function openBot(profile, sessionId, { title = "", tab: startTab = "chat" } = {}) {
    groupsView?.close();
    const bot = allBots.find(row => row.name === profile) || { name: profile, displayName: profile, color: null, model: "", botChat: null };
    tab = startTab;
    screen = "bot";
    render(loadingView());
    try {
      const view = sessionId ? await api.openSession(sessionId, profile) : await api.botChat(profile);
      const botChat = !sessionId || view.botChat === true || sessionId === bot.botChat?.id;
      chat = { ...view, bot, botChat, title, items: M.withInflight(M.fromHistory(view.messages), view.inflight),
        cards: new Map(), closed: [], nodes: new Map(), attachments: [], sending: false, sync: null };
      for (const ask of view.asks || []) asks.set(ask.id, ask);
      setUrl(profile, botChat ? null : chat.sessionId);
      render(botView());
      watchNow();
      void api.read(chat.sessionId, profile).catch(() => {});
    } catch (error) { render(errorView(error, () => openBot(profile, sessionId, { title }))); }
  }

  function reopen() {
    if (!chat) return;
    void openBot(chat.profile, chat.botChat ? null : chat.sessionId, { title: chat.title });
  }

  // The open Bot's picture, name and model, redrawn after its settings change.
  function botHead() {
    const title = el("div", "assistant-bot-title");
    const detail = chat.botChat ? (chat.bot.model ? `${t("model")} · ${chat.bot.model}` : "") : (chat.title || t("untitled"));
    title.append(el("strong", "", chat.bot.displayName), el("small", "", detail));
    return [avatar(chat.bot), title];
  }
  function refreshBotHead(profile) {
    if (!chat || chat.profile !== profile) return;
    chat.bot = allBots.find(row => row.name === profile) || chat.bot;
    const head = document.getElementById("assistant-bot-head");
    if (head) head.replaceChildren(head.firstElementChild, ...botHead());
  }

  function botView() {
    const wrap = el("section", "assistant-bot");
    const head = el("header", "assistant-bot-head");
    const back = button("‹", "btn ghost assistant-back", () => {
      if (chat && !chat.botChat) { void openBot(chat.profile, null); return; }
      void loadBots().catch(() => {}).finally(showRoster);
    });
    back.setAttribute("aria-label", t("back"));
    head.id = "assistant-bot-head";
    head.append(back, ...botHead());
    const tabs = el("div", "assistant-tabs");
    tabs.setAttribute("role", "tablist");
    for (const [key, label] of [["chat", t("chat")], ["other", t("otherChats")], ["routines", t("routines")], ["settings", t("settings")]]) {
      const node = button(label, "assistant-tab", () => {
        tab = key;
        render(botView());
        if (key === "other") void loadSessions(true);
      });
      node.setAttribute("role", "tab");
      node.setAttribute("aria-selected", String(tab === key));
      tabs.append(node);
    }
    wrap.append(head, tabs);
    requestAnimationFrame(() => tabs.querySelector("[aria-selected=\"true\"]")?.scrollIntoView({ block: "nearest", inline: "nearest" }));
    if (tab === "other") { wrap.append(sessionsView()); return wrap; }
    if (tab === "routines") {
      const body = el("div", "assistant-sessions");
      wrap.append(body);
      void routinesView.list(body, chat.profile);
      return wrap;
    }
    if (tab === "settings") {
      const body = el("div", "assistant-sessions");
      wrap.append(body);
      void manageView.settings(body, chat.profile);
      return wrap;
    }
    const transcript = el("div", "assistant-transcript");
    transcript.id = "assistant-transcript";
    wrap.append(transcript, composer());
    chat.nodes.clear();
    queueMicrotask(() => { renderTranscript(); scrollToEnd(); });
    return wrap;
  }

  function markdown(text) {
    const box = el("div", "md-body");
    if (window.marked && window.DOMPurify) {
      box.innerHTML = window.DOMPurify.sanitize(window.marked.parse(text, { breaks: true, gfm: true }), { ADD_ATTR: ["target"] });
      for (const link of box.querySelectorAll("a[href]")) { link.target = "_blank"; link.rel = "noopener"; }
    } else box.textContent = text;
    return box;
  }

  function itemNode(item) {
    const cached = chat.nodes.get(item.id);
    if (cached && cached.rev === item.rev) return cached.node;
    const node = el("div", `assistant-msg ${item.role}`);
    if (item.role === "user") {
      const bubble = el("div", "assistant-bubble", item.text);
      for (const name of item.attachments) bubble.append(el("span", "assistant-chip", name));
      node.append(bubble);
    } else if (item.role === "system") node.textContent = item.text;
    else {
      if (item.thinking) {
        const details = el("details", "assistant-thinking");
        details.append(el("summary", "", t("thinking")), el("pre", "", item.thinking));
        node.append(details);
      }
      for (const tool of item.tools) {
        const details = el("details", "assistant-tool");
        details.append(el("summary", "", `${t("tool")} · ${tool.name}${tool.done ? "" : " …"}`));
        if (tool.detail || tool.result) details.append(el("pre", "", [tool.detail, tool.result].filter(Boolean).join("\n\n")));
        node.append(details);
      }
      if (item.text) node.append(markdown(item.text));
      if (item.streaming && !item.text) node.append(el("p", "assistant-working", t("working")));
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
      card.append(actions(...ask.choices.map(choice => button(t(choice), choice === "deny" ? "btn ghost" : "btn primary", () => send({ choice })))));
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
    chat.sync?.();
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

  function composer() {
    const form = el("form", "assistant-composer");
    const chips = el("div", "assistant-attachments");
    const input = el("textarea", "assistant-input");
    input.rows = 1;
    input.placeholder = t("messagePlaceholder", { name: chat.bot.displayName });
    input.setAttribute("aria-label", input.placeholder);
    const file = el("input");
    file.type = "file"; file.multiple = true; file.hidden = true;
    const attach = button("+", "btn ghost assistant-attach", () => file.click());
    attach.setAttribute("aria-label", t("attach"));
    const hint = el("p", "assistant-hint", t("interruptHint"));
    const send = button(t("send"), "btn primary assistant-send", null, "submit");
    const stop = button(t("stop"), "btn ghost assistant-stop", () => void api.interrupt(chat.sessionId).catch(error => toast(t("failed", { message: error.message }))));
    const renderChips = () => chips.replaceChildren(...chat.attachments.map((item, index) => {
      const chip = el("span", "assistant-chip", item.name);
      const remove = button("×", "assistant-chip-remove", () => { chat.attachments.splice(index, 1); renderChips(); sync(); });
      remove.setAttribute("aria-label", `${t("remove")} ${item.name}`);
      chip.append(remove);
      return chip;
    }));
    function sync() {
      if (!chat) return;
      stop.hidden = !chat.running;
      hint.hidden = !(chat.running && input.value.trim());
      send.disabled = chat.sending || !(input.value.trim() || chat.attachments.length);
      input.style.height = "auto";
      input.style.height = `${Math.min(input.scrollHeight, 180)}px`;
    }
    file.addEventListener("change", async () => {
      for (const picked of file.files) {
        if (chat.attachments.length >= MAX_FILES) { toast(t("tooMany")); break; }
        if (picked.size > MAX_FILE) { toast(t("tooLarge", { name: picked.name })); continue; }
        chat.attachments.push({ kind: picked.type.startsWith("image/") ? "image" : "file", name: picked.name,
          mime: picked.type || "application/octet-stream", data: await readBase64(picked) });
      }
      file.value = "";
      renderChips();
      sync();
    });
    input.addEventListener("input", sync);
    input.addEventListener("keydown", event => {
      if (event.key === "Enter" && !event.shiftKey && !event.isComposing && !coarse) { event.preventDefault(); form.requestSubmit(); }
    });
    form.addEventListener("submit", async event => {
      event.preventDefault();
      const text = input.value;
      if (!text.trim() && !chat.attachments.length) return;
      const attachments = chat.attachments;
      chat.sending = true;
      chat.items.push(M.userItem(text, attachments.map(item => item.name)));
      chat.attachments = [];
      input.value = "";
      renderChips();
      renderTranscript();
      scrollToEnd();
      // Running from the moment it is sent: a quick reply can finish before
      // this request answers, and its events then decide the state.
      chat.running = true;
      try {
        await api.prompt(chat.sessionId, text, attachments);
      } catch (error) {
        chat.running = false;
        chat.items.push(M.systemItem(t("sendFailed", { message: error.message })));
        input.value = text;
        renderTranscript();
      } finally { if (chat) { chat.sending = false; sync(); } }
    });
    chat.sync = sync;
    const row = el("div", "assistant-composer-row");
    row.append(attach, input, stop, send);
    form.append(chips, hint, row, file);
    queueMicrotask(sync);
    return form;
  }

  // ---- other conversations ----------------------------------------------

  function sessionsView() {
    const wrap = el("div", "assistant-sessions");
    const search = el("input", "assistant-search");
    search.type = "search";
    search.placeholder = t("search");
    search.setAttribute("aria-label", t("search"));
    search.value = listing.query;
    let timer = 0;
    search.addEventListener("input", () => {
      clearTimeout(timer);
      timer = setTimeout(() => { listing.query = search.value.trim(); void loadSessions(true); }, 350);
    });
    const list = el("ul", "assistant-session-list");
    list.id = "assistant-session-list";
    const more = button(t("loadMore"), "btn ghost", () => void loadSessions(false));
    more.id = "assistant-more";
    more.hidden = true;
    wrap.append(search, list, more);
    queueMicrotask(renderSessions);
    return wrap;
  }

  async function loadSessions(reset) {
    if (!chat) return;
    try {
      const data = await api.sessions(chat.profile, listing.query, reset ? 0 : listing.rows.length);
      listing.rows = reset ? data.sessions : [...listing.rows, ...data.sessions];
      listing.hasMore = data.hasMore === true;
    } catch (error) { toast(t("failed", { message: error.message })); }
    renderSessions();
  }

  function renderSessions() {
    const list = document.getElementById("assistant-session-list");
    if (!list) return;
    list.replaceChildren();
    if (!listing.rows.length) list.append(el("li", "assistant-empty", t("noChats")));
    for (const row of listing.rows) list.append(sessionRow(row));
    const more = document.getElementById("assistant-more");
    if (more) more.hidden = !listing.hasMore;
  }

  function sessionRow(row) {
    const item = el("li", `assistant-session-row${row.unread ? " unread" : ""}`);
    const open = button("", "assistant-session-open", () => void openBot(chat.profile, row.id, { title: row.title }));
    open.append(el("strong", "", row.title || row.preview || t("untitled")),
      el("small", "", [M.sourceLabel(row.source), M.formatWhen(row.lastActive, Date.now(), prefs.locale)].filter(Boolean).join(" · ")));
    const rename = button(t("rename"), "btn ghost", () => {
      const input = el("input", "assistant-rename");
      input.value = row.title || "";
      input.setAttribute("aria-label", t("rename"));
      let done = false;
      const save = async () => {
        if (done) return;
        done = true;
        const title = input.value.trim();
        if (title && title !== row.title) {
          try { await api.rename(row.id, chat.profile, title); row.title = title; } catch (error) { toast(t("failed", { message: error.message })); }
        }
        renderSessions();
      };
      input.addEventListener("keydown", event => {
        if (event.key === "Enter") { event.preventDefault(); void save(); }
        if (event.key === "Escape") { done = true; renderSessions(); }
      });
      input.addEventListener("blur", () => void save());
      open.replaceWith(input);
      input.focus();
    });
    let armed = false;
    const remove = button(t("delete"), "btn ghost assistant-danger", async () => {
      if (!armed) {
        armed = true;
        remove.textContent = t("confirmDelete");
        setTimeout(() => { armed = false; remove.textContent = t("delete"); }, 4000);
        return;
      }
      try {
        await api.remove(row.id, chat.profile);
        listing.rows = listing.rows.filter(other => other.id !== row.id);
        renderSessions();
      } catch (error) { toast(t("failed", { message: error.message })); }
    });
    const actions = el("span", "assistant-session-actions");
    actions.append(rename, remove);
    item.append(open, actions);
    return item;
  }

  // ---- events from Hermes ------------------------------------------------

  function scheduleReload() {
    clearTimeout(reloadTimer);
    reloadTimer = setTimeout(async () => {
      try { await loadBots(); } catch { return; }
      if (screen === "roster") showRoster();
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
    const visible = document.visibilityState === "visible";
    void api.watch(clientId, visible && chat ? chat.sessionId : null).catch(() => {});
    if (visible && chat) watchTimer = setTimeout(watchNow, 20_000);
  }

  document.addEventListener("visibilitychange", watchNow);
  navigator.serviceWorker?.addEventListener("message", event => {
    if (event.data?.type !== "STEPSEMBLE_OPEN_ASSISTANT" || typeof event.data.url !== "string") return;
    const url = new URL(event.data.url, location.origin);
    if (url.origin !== location.origin || url.pathname !== "/assistant.html" || !api) return;
    const bot = url.searchParams.get("bot");
    if (bot) void openBot(bot, url.searchParams.get("session") || null);
  });

  void boot();
})();
