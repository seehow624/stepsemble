(function (root, factory) {
  "use strict";
  const node = typeof module === "object" && module.exports;
  const api = factory(node ? require("./assistant-navigation") : root.StepsembleAssistantNavigation,
    node ? require("./assistant-avatars") : root.StepsembleAssistantAvatars);
  if (node) module.exports = api;
  if (root) root.StepsembleWorkspaceAssistantModel = api;
})(typeof window !== "undefined" ? window : null, function (N, A) {
  "use strict";

  // Workspace 裡的 Bot 分頁：一個分頁對應一個主題（某個 Bot、群組或頁面），
  // 同一個 Bot 的對話、歷史、設定與例行工作都在同一個分頁裡切換。
  const BOT_PAGES = ["bot", "settings", "routines"];
  const PAGE_TITLES = { routines: "allRoutines", bots: "manageBots", newbot: "newBot", newgroup: "newGroup", pending: "pendingTitle", home: "assistant" };
  const botRoute = route => BOT_PAGES.includes(route.page) && !!route.profile;

  function subject(route) {
    if (botRoute(route)) return `bot:${route.profile}`;
    if (route.page === "group") return `group:${route.room}`;
    return `page:${route.page}`;
  }
  function findTab(refs, host, route) {
    const wanted = subject(route);
    return refs.find(ref => ref.host === host && ref.assistant && subject(ref.assistant) === wanted) || null;
  }
  function title(route, { bots = [], groups = [], t }) {
    if (botRoute(route)) {
      const name = bots.find(bot => bot.name === route.profile)?.displayName || route.profile;
      return route.page === "bot" ? name : `${name} · ${t(route.page)}`;
    }
    if (route.page === "group") return groups.find(room => room.id === route.room)?.name || t("groups");
    return t(PAGE_TITLES[route.page] || "assistant");
  }
  // 記內建造型的名稱；上傳的圖片只記成 custom，由分頁標籤經 API 讀取。
  function avatarFor(route, bots = []) {
    if (!botRoute(route)) return undefined;
    const choice = A.resolve(bots.find(bot => bot.name === route.profile) || { name: route.profile });
    return choice.kind === "preset" ? choice.id : "custom";
  }
  // 分頁的電腦就是它的 host；開著的面板不保存。
  function tabRoute(route) {
    const { machine, panel, ...rest } = N.normalize(route);
    return rest;
  }
  function ref(host, route, { bots = [], groups = [], t, uuid = () => crypto.randomUUID() }) {
    const assistant = tabRoute(route), value = { host, key: uuid(), title: title(assistant, { bots, groups, t }), assistant };
    const avatar = avatarFor(assistant, bots);
    if (avatar) value.avatar = avatar;
    return value;
  }
  function frameUrl(tab) {
    const url = new URL(N.toUrl({ ...tab.assistant, machine: tab.host }, "http://stepsemble.invalid/assistant.html"));
    url.searchParams.set("embed", "1");
    return url.pathname + url.search;
  }
  // 列表預覽只顯示文字：去掉 Markdown 記號與連結網址，換行收成一行。
  const preview = text => String(text || "").replace(/\]\([^)]*\)/g, "]").replace(/[#*_`~>\[\]]/g, "")
    .replace(/\s+/g, " ").trim();
  const query = (value, locale) => String(value || "").trim().toLocaleLowerCase(locale);
  function botRows(bots, text = "", locale = "en") {
    const q = query(text, locale);
    return [...bots].sort((a, b) => (b.botChat?.lastActive || 0) - (a.botChat?.lastActive || 0) || Number(!!b.isDefault) - Number(!!a.isDefault))
      .filter(bot => `${bot.displayName} ${bot.description || ""} ${bot.botChat?.preview || ""}`.toLocaleLowerCase(locale).includes(q));
  }
  function groupRows(groups, text = "", locale = "en") {
    const q = query(text, locale);
    return groups.filter(room => `${room.name} ${(room.members || []).map(member => member.displayName).join(" ")}`.toLocaleLowerCase(locale).includes(q));
  }
  const waiting = (asks, profile) => asks.filter(ask => ask.profile === profile).length;

  return Object.freeze({ subject, findTab, title, avatarFor, tabRoute, ref, frameUrl, preview, botRows, groupRows, waiting });
});
