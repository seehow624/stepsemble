"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const N = require("../public/modules/assistant-navigation");

// 模擬瀏覽器的歷史 API；go 非同步送出 popstate，與真實瀏覽器相同。
function browser(url = "http://example.test/assistant.html?bot=default&session=st-1") {
  const entries = [{ url: "http://example.test/workspace.html", state: null }, { url, state: null }];
  let index = 1;
  const listeners = new Set(), location = { href: url };
  const history = {
    get state() { return entries[index].state; }, get length() { return entries.length; },
    replaceState(state, _, url) { entries[index] = { state, url: String(url) }; location.href = String(url); },
    pushState(state, _, url) { entries.splice(index + 1); entries.push({ state, url: String(url) }); index += 1; location.href = String(url); },
    go(offset) { queueMicrotask(() => { const next = index + offset; if (next < 0 || next >= entries.length) return; index = next; location.href = entries[index].url; for (const listener of listeners) listener({ state: entries[index].state }); }); },
    back() { this.go(-1); }, forward() { this.go(1); },
  };
  return { location, history, addEventListener: (_, listener) => listeners.add(listener), removeEventListener: (_, listener) => listeners.delete(listener), entries };
}
const flush = () => new Promise(resolve => setImmediate(resolve));

test("路由驗證與 URL 往返不接受任意路徑或非法 profile", () => {
  assert.deepEqual(N.normalize({ page: "bot", profile: "../bad" }), { page: "home" });
  const route = { page: "bot", profile: "qa-reviewer", session: "st-1", panel: "history", machine: "mini-1" };
  assert.deepEqual(N.fromUrl(N.toUrl(route, "http://example.test/assistant.html")), route);
  assert.deepEqual(N.ancestors(route).map(item => item.page), ["home", "bot", "bot"]);
  assert.deepEqual(N.ancestors({ page: "settings", profile: "default" }).map(item => item.page), ["home", "bot", "settings"]);
  assert.deepEqual(N.ancestors({ page: "console" }), [{ page: "console" }]);
});

test("外部對話深連結也有 Assistant 首頁，重載不增長歷史", async () => {
  const win = browser(), changes = [];
  const nav = N.create({ window: win, onChange: route => changes.push(route) });
  nav.initialize();
  assert.equal(nav.current.session, "st-1");
  assert.equal(win.history.length, 3);
  nav.destroy();
  const again = N.create({ window: win, onChange: route => changes.push(route) });
  again.initialize();
  assert.equal(win.history.length, 3);
  win.history.back(); await flush();
  assert.deepEqual(again.current, { page: "home" });
  assert.equal(new URL(win.location.href).pathname, "/assistant.html");
  win.history.forward(); await flush();
  assert.equal(again.current.session, "st-1");
  again.destroy();
});

test("歷史選取替換同層對話，一次返回到 Assistant 首頁", async () => {
  const win = browser(), nav = N.create({ window: win });
  nav.initialize();
  nav.go({ ...nav.current, panel: "history" }); await flush();
  assert.equal(nav.current.panel, "history");
  win.history.back(); await flush();
  assert.equal(nav.current.panel, undefined);
  assert.equal(nav.current.session, "st-1");
  nav.go({ ...nav.current, panel: "history" }); await flush();
  nav.go({ page: "bot", profile: "default", session: "st-2" }); await flush();
  assert.equal(nav.current.session, "st-2");
  win.history.back(); await flush();
  assert.deepEqual(nav.current, { page: "home" });
  win.history.forward(); await flush();
  assert.equal(nav.current.session, "st-2");
  assert.equal(nav.current.panel, undefined);
  nav.destroy();
});

test("等待 popstate 期間連點只採用最新目標，不重複退回", async () => {
  const win = browser(), changes = [], nav = N.create({ window: win, onChange: route => changes.push(route) });
  nav.initialize();
  nav.go({ page: "bot", profile: "qa-reviewer" });
  nav.go({ page: "group", room: "room-1" });
  await flush();
  assert.deepEqual(nav.current, { page: "group", room: "room-1" });
  assert.equal(changes.length, 2, "不呈現中間首頁或已過期的 Bot");
  nav.back(); await flush();
  assert.equal(nav.current.page, "home");
  nav.destroy();
});

test("控制台不插入 Bot 首頁；返回維持外部設定入口", () => {
  const win = browser("http://example.test/assistant.html?view=console"), nav = N.create({ window: win });
  nav.initialize();
  assert.deepEqual(nav.current, { page: "console" });
  assert.equal(win.history.length, 2);
  nav.destroy();
});

test("路由 state 不接收可字串化的物件或陣列作為識別值", () => {
  assert.deepEqual(N.normalize({ page: "bot", profile: ["default"] }), { page: "home" });
  assert.deepEqual(N.normalize({ page: "group", room: ["room-1"] }), { page: "home" });
  assert.deepEqual(N.normalize({ page: "home", machine: ["mini"] }), { page: "home" });
});

test("有填卻非法的 session 不得悄悄開成永久 Bot Chat", () => {
  assert.deepEqual(N.normalize({ page: "bot", profile: "default", session: "../../bad" }), { page: "home" });
  assert.deepEqual(N.normalize({ page: "bot", profile: "default", machine: "../bad" }), { page: "home" });
  assert.deepEqual(N.normalize({ page: "routines", profile: "../bad" }), { page: "home" });
});
