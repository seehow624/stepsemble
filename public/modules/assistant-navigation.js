(function (root, factory) {
  "use strict";
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.StepsembleAssistantNavigation = Object.freeze(api);
})(typeof window !== "undefined" ? window : null, function () {
  "use strict";

  const PROFILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
  const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
  const PAGES = ["home", "bot", "group", "settings", "routines", "bots", "newbot", "newgroup", "pending", "console"];
  const matches = (pattern, value) => typeof value === "string" && pattern.test(value);
  function normalize(input = {}) {
    if (!input || typeof input !== "object") input = {};
    const machine = matches(ID, input.machine) ? { machine: input.machine } : {};
    const home = { page: "home", ...machine };
    const present = value => value !== undefined && value !== null && value !== "";
    if (present(input.machine) && !matches(ID, input.machine)) return { page: "home" };
    if (!PAGES.includes(input.page)) return home;
    if (["bot", "settings", "routines"].includes(input.page) && present(input.session) && !matches(ID, input.session)) return home;
    if (input.page === "routines" && present(input.profile) && !matches(PROFILE, input.profile)) return home;
    const route = { page: input.page };
    if (["bot", "settings"].includes(route.page) && !matches(PROFILE, input.profile)) return home;
    if (route.page === "group") {
      if (!matches(ID, input.room)) return home;
      route.room = input.room;
    }
    if (["bot", "settings", "routines"].includes(route.page) && matches(PROFILE, input.profile)) {
      route.profile = input.profile;
      if (matches(ID, input.session)) route.session = input.session;
    }
    if (route.page === "bot" && ["history", "menu"].includes(input.panel)) route.panel = input.panel;
    return { ...route, ...machine };
  }
  function fromUrl(value) {
    const url = new URL(String(value), "http://localhost/assistant.html"), q = url.searchParams;
    return normalize({ page: q.get("view") || (q.has("room") ? "group" : q.has("bot") ? "bot" : "home"),
      profile: q.get("bot"), session: q.get("session"), room: q.get("room"), panel: q.get("panel"), machine: q.get("machine") });
  }
  function toUrl(value, base) {
    const route = normalize(value), url = new URL(String(base));
    url.search = ""; url.hash = "";
    if (route.profile) url.searchParams.set("bot", route.profile);
    if (route.session) url.searchParams.set("session", route.session);
    if (route.room) url.searchParams.set("room", route.room);
    if (!["home", "bot", "group"].includes(route.page)) url.searchParams.set("view", route.page);
    if (route.panel) url.searchParams.set("panel", route.panel);
    if (route.machine) url.searchParams.set("machine", route.machine);
    return url.href;
  }
  function ancestors(value) {
    const route = normalize(value), machine = route.machine ? { machine: route.machine } : {}, home = { page: "home", ...machine };
    if (route.page === "home" || route.page === "console") return [route];
    if (route.page === "bot" && route.panel) { const base = { ...route }; delete base.panel; return [home, base, route]; }
    if (["settings", "routines"].includes(route.page) && route.profile) {
      return [home, { page: "bot", profile: route.profile, ...(route.session ? { session: route.session } : {}), ...machine }, route];
    }
    return [home, route];
  }

  // 嵌入 Workspace 分頁時，路由只存在這個分頁的記憶體，不寫入瀏覽器歷史；
  // 介面與真實 history 相同：go 非同步送出 popstate，超出範圍時不動。
  function memoryWindow(href) {
    const entries = [{ state: null, url: String(href) }], listeners = new Set();
    let index = 0;
    const history = {
      get state() { return entries[index].state; }, get length() { return entries.length; },
      replaceState(state, _title, url = entries[index].url) { entries[index] = { state, url: String(url) }; },
      pushState(state, _title, url = entries[index].url) { entries.splice(index + 1, entries.length, { state, url: String(url) }); index += 1; },
      go(offset = 0) {
        queueMicrotask(() => {
          const next = index + offset;
          if (!offset || next < 0 || next >= entries.length) return;
          index = next;
          for (const listener of [...listeners]) listener({ state: entries[index].state });
        });
      },
      back() { history.go(-1); }, forward() { history.go(1); },
    };
    return Object.freeze({ location: { get href() { return entries[index].url; } }, history,
      addEventListener(type, listener) { if (type === "popstate") listeners.add(listener); },
      removeEventListener(type, listener) { if (type === "popstate") listeners.delete(listener); } });
  }

  // 使用同一個 Assistant 根節點建立頁面階層；選歷史會重建同層對話，
  // 不留下「舊對話 → 面板 → 新對話」而讓返回多走一層。
  function create({ window: win = window, onChange = () => {} } = {}) {
    let current = { page: "home" }, depth = 0, rootId = "", pending = null, destroyed = false;
    const stateOf = () => win.history.state?.stepsembleAssistant;
    const valid = state => state?.version === 1 && typeof state.root === "string" && Number.isInteger(state.depth) && state.depth >= 0;
    function write(route, index, replace) {
      const state = { stepsembleAssistant: { version: 1, root: rootId, depth: index, route } };
      win.history[replace ? "replaceState" : "pushState"](state, "", toUrl(route, win.location.href));
    }
    function announce(route, index) { current = route; depth = index; onChange(current); }
    function build(target, replaceRoot) {
      const chain = ancestors(target);
      if (replaceRoot) write(chain[0], 0, true);
      for (let index = 1; index < chain.length; index += 1) write(chain[index], index, false);
      announce(chain.at(-1), chain.length - 1);
    }
    function pop(event) {
      if (destroyed) return;
      const state = event.state?.stepsembleAssistant;
      if (!valid(state)) return;
      rootId = state.root;
      if (pending) {
        const next = pending; pending = null;
        build(next, true);
      } else announce(normalize(state.route), state.depth);
    }
    win.addEventListener("popstate", pop);
    function initialize() {
      const route = fromUrl(win.location.href), state = stateOf();
      if (valid(state) && toUrl(state.route, win.location.href) === toUrl(route, win.location.href)) {
        rootId = state.root;
        announce(route, state.depth);
      } else {
        rootId = `assistant-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        build(route, true);
      }
    }
    function go(value) {
      if (destroyed) return;
      const target = normalize(value);
      if (pending) { pending = target; return; }
      if (toUrl(target, win.location.href) === toUrl(current, win.location.href)) return;
      if (depth > 0) { pending = target; win.history.go(-depth); }
      else build(target, true);
    }
    return Object.freeze({ initialize, go, back() { if (!destroyed) win.history.back(); },
      get current() { return current; }, destroy() { destroyed = true; pending = null; win.removeEventListener("popstate", pop); } });
  }
  return { normalize, fromUrl, toUrl, ancestors, create, memoryWindow };
});
