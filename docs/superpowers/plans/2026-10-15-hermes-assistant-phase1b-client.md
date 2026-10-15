# Hermes 助理 第 1b 階段（畫面）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新增 `/assistant.html`：自動連到有 Hermes 的電腦、Hermes 登入、Bot 名單、Bot Chat（串流、思考與工具、附件、中斷）、Hermes 的提問卡片、其他對話、推播點擊開啟；工作區加上「工作區｜助理」切換；新增對話不再列出 Hermes。

**Architecture:** 獨立頁面，沿用 Stepsemble 的 `style.css` 色票與 `workspace-i18n.js` 的語系／主題偏好。三個新模組：`assistant-model.js`（純函式，Node 可測）、`assistant-api.js`（唯一呼叫 Stepsemble 的地方，經 `/r/<id>` 連到有 Hermes 的那台）、`assistant.js`（畫面）。字串在 `assistant-i18n.js`（11 種語言）。

**Tech Stack:** 無建置步驟的瀏覽器 JavaScript、`EventSource`、`marked` + `DOMPurify`（既有 vendor）、Playwright 1.63（瀏覽器測試，沿用 Rolling 的隔離安裝）。

前置：第 1a 階段（伺服器端 `/api/assistant/*`）已完成。

---

## 檔案結構

| 檔案 | 動作 | 職責 |
|---|---|---|
| `public/modules/assistant-model.js` | 新增 | 選機器、歷史與即時事件轉成對話、時間與來源文字 |
| `public/modules/assistant-i18n.js` | 新增 | 助理頁字串，11 種語言 |
| `public/modules/assistant-api.js` | 新增 | 機器清單、`/api/assistant/*`、事件串流 |
| `public/modules/assistant.js` | 新增 | 畫面與互動 |
| `public/modules/assistant.css` | 新增 | 樣式 |
| `public/assistant.html` | 新增 | 頁面骨架 |
| `public/modules/agent-identity.js` | 修改 | `startsConversations()`：新增對話可列出的 Agent |
| `public/app.js` | 修改 | 新增對話排除 Hermes；登入後可回到助理頁 |
| `public/modules/workspace.js`、`public/workspace.html`、`public/modules/workspace.css`、`public/modules/workspace-i18n.js` | 修改 | 「工作區｜助理」切換；新增對話排除 Hermes |
| `scripts/version.mjs` | 修改 | `assistant.html` 的版本號同步 |
| `scripts/assistant-preview.mjs`、`scripts/assistant-browser-cases.mjs`、`scripts/rolling-browser-worker.mjs` | 新增／修改 | 假 Hermes 的預覽 Host 與瀏覽器測試 |
| `package.json` | 修改 | `check:assistant` 納入新檔 |
| `docs/hermes-assistant.md`、`docs/agent-capability-matrix.md` | 新增／修改 | 文件 |

---

### Task 1: 純函式模組

**Files:**
- Create: `public/modules/assistant-model.js`
- Test: `test/assistant-model.test.js`

- [ ] **Step 1: 寫失敗的測試**

```js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const M = require("../public/modules/assistant-model.js");

test("the assistant uses the computer that runs Hermes, a saved choice first", () => {
  const rows = [
    { id: "mbp", self: true, status: { installed: false } },
    { id: "mini", self: false, status: { installed: true } },
    { id: "studio", self: false, status: { installed: true } },
    { id: "offline", self: false, status: null },
  ];
  assert.deepEqual(M.chooseHermesMachine(rows, null).choices.map(row => row.id), ["mini", "studio"]);
  assert.equal(M.chooseHermesMachine(rows, null).selected.id, "mini");
  assert.equal(M.chooseHermesMachine(rows, "studio").selected.id, "studio");
  assert.equal(M.chooseHermesMachine(rows, "mbp").selected.id, "mini", "a computer without Hermes is never chosen");
  assert.equal(M.chooseHermesMachine([{ id: "a", self: true, status: { installed: true } }, { id: "b", status: { installed: true } }], null).selected.id, "a");
  assert.equal(M.chooseHermesMachine([], null).selected, null);
});

test("history becomes a transcript, and live events extend it in order", () => {
  const items = M.fromHistory([{ role: "user", text: "hi" }, { role: "tool", name: "calendar", context: "today" }, { role: "assistant", text: "Hello" }]);
  assert.deepEqual(items.map(item => [item.role, item.text, item.tools.length]), [["user", "hi", 0], ["assistant", "", 1], ["assistant", "Hello", 0]]);
  for (const event of [
    { type: "message.start", payload: {} },
    { type: "thinking.delta", payload: { text: "checking" } },
    { type: "tool.start", payload: { tool_id: "t1", name: "search", args_text: "{}" } },
    { type: "tool.complete", payload: { tool_id: "t1", name: "search", summary: "3 results" } },
    { type: "message.delta", payload: { text: "Done " } },
    { type: "message.delta", payload: { text: "now." } },
    { type: "message.complete", payload: { text: "Done now." } },
  ]) assert.equal(M.applyEvent(items, event), true, event.type);
  const last = items.at(-1);
  assert.equal(last.text, "Done now.");
  assert.equal(last.thinking, "checking");
  assert.deepEqual(last.tools.map(tool => [tool.name, tool.done, tool.result]), [["search", true, "3 results"]]);
  assert.equal(last.streaming, false);
  assert.ok(last.rev > 0, "a changed item says so, so the page redraws only it");
  assert.equal(M.applyEvent(items, { type: "status.update", payload: {} }), false);
  M.applyEvent(items, { type: "error", payload: { message: "Model unavailable" } });
  assert.deepEqual([items.at(-1).role, items.at(-1).text], ["system", "Model unavailable"]);
});

test("a reply already in progress continues where it was", () => {
  const items = M.withInflight(M.fromHistory([{ role: "user", text: "earlier" }]), { user: "now", assistant: "Half" });
  assert.deepEqual(items.map(item => [item.role, item.text, item.streaming]), [["user", "earlier", false], ["user", "now", false], ["assistant", "Half", true]]);
  M.applyEvent(items, { type: "message.delta", payload: { text: " done" } });
  assert.equal(items.at(-1).text, "Half done");
});

test("times, sources, initials and colours read well", () => {
  const now = Date.UTC(2026, 9, 15, 12, 0, 0);
  assert.match(M.formatWhen(now / 1000 - 60, now, "en"), /\d/);
  assert.notEqual(M.formatWhen(now / 1000 - 30 * 86_400, now, "en"), "");
  assert.equal(M.formatWhen(0, now, "en"), "");
  assert.equal(M.sourceLabel("telegram"), "Telegram");
  assert.equal(M.sourceLabel("CRON"), "Cron");
  assert.equal(M.sourceLabel(""), "");
  assert.equal(M.initials("luna"), "L");
  assert.equal(M.initials("影片"), "影");
  assert.equal(M.colorFor("x", "#5b8def"), "#5b8def");
  assert.match(M.colorFor("qa-reviewer", null), /^#[0-9a-f]{6}$/);
});
```

- [ ] **Step 2: 確認失敗**

Run: `node --test test/assistant-model.test.js`
Expected: FAIL，`Cannot find module '../public/modules/assistant-model.js'`

- [ ] **Step 3: 實作**

```js
(function expose(root, factory) {
  "use strict";
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.StepsembleAssistantModel = Object.freeze(api);
})(typeof window !== "undefined" ? window : null, () => {
  "use strict";

  // Pure pieces of the assistant page: which computer to use, and how Hermes
  // history and live events become a transcript. No DOM, so Node tests them.

  const SOURCES = Object.freeze({ telegram: "Telegram", discord: "Discord", slack: "Slack", whatsapp: "WhatsApp", signal: "Signal",
    matrix: "Matrix", email: "Email", sms: "SMS", cron: "Cron", webhook: "Webhook", api_server: "API", tui: "TUI", cli: "CLI",
    desktop: "Desktop", dashboard: "Web", web: "Web", acp: "ACP" });
  const PALETTE = ["#5b8def", "#d9822b", "#3aa675", "#b25fd3", "#d64f6a", "#2a9fb0", "#8a8f2b", "#7a6cf0"];
  let counter = 0;

  function chooseHermesMachine(rows, savedId) {
    const choices = (Array.isArray(rows) ? rows : []).filter(row => row && row.status && row.status.installed === true);
    const selected = choices.find(row => row.id === savedId) || choices.find(row => row.self) || choices[0] || null;
    return { choices, selected };
  }

  function item(role, text = "") {
    return { id: `${role}-${++counter}`, role, text, thinking: "", tools: [], attachments: [], streaming: false, rev: 0 };
  }
  function userItem(text, attachments = []) {
    const value = item("user", text);
    value.attachments = attachments.slice(0, 8);
    return value;
  }
  const systemItem = text => item("system", text);

  function fromHistory(messages) {
    const items = [];
    for (const message of Array.isArray(messages) ? messages : []) {
      if (message?.role === "tool") {
        const value = item("assistant");
        value.tools.push({ id: null, name: message.name || "tool", detail: message.context || "", result: "", done: true });
        items.push(value);
        continue;
      }
      const role = message?.role === "user" ? "user" : message?.role === "system" ? "system" : "assistant";
      items.push(item(role, typeof message?.text === "string" ? message.text : ""));
    }
    return items;
  }

  function withInflight(items, inflight) {
    if (!inflight) return items;
    const last = items[items.length - 1];
    if (inflight.user && !(last && last.role === "user" && last.text === inflight.user)) items.push(item("user", inflight.user));
    const live = item("assistant", inflight.assistant || "");
    live.streaming = true;
    items.push(live);
    return items;
  }

  function streaming(items) {
    for (let index = items.length - 1; index >= 0; index -= 1) if (items[index].streaming) return items[index];
    const value = item("assistant");
    value.streaming = true;
    items.push(value);
    return value;
  }
  function settle(items) {
    for (const value of items) if (value.streaming) { value.streaming = false; value.rev += 1; }
  }

  function applyEvent(items, event) {
    const payload = event?.payload || {};
    switch (event?.type) {
      case "message.start": {
        settle(items);
        const value = item("assistant");
        value.streaming = true;
        items.push(value);
        return true;
      }
      case "message.delta":
      case "thinking.delta": {
        if (!payload.text) return false;
        const value = streaming(items);
        if (event.type === "message.delta") value.text += payload.text; else value.thinking += payload.text;
        value.rev += 1;
        return true;
      }
      case "tool.start": {
        const value = streaming(items);
        value.tools.push({ id: payload.tool_id || null, name: payload.name || "tool", detail: payload.args_text || payload.context || "", result: "", done: false });
        value.rev += 1;
        return true;
      }
      case "tool.complete": {
        const value = streaming(items);
        const tool = [...value.tools].reverse().find(entry => (payload.tool_id ? entry.id === payload.tool_id : !entry.done && entry.name === payload.name));
        if (!tool) return false;
        tool.done = true;
        tool.result = payload.summary || payload.result_text || "";
        value.rev += 1;
        return true;
      }
      case "message.complete": {
        const value = [...items].reverse().find(entry => entry.streaming);
        if (!value) return false;
        value.streaming = false;
        if (!value.text && typeof payload.text === "string") value.text = payload.text;
        value.rev += 1;
        return true;
      }
      case "error":
        settle(items);
        items.push(item("system", payload.message || "Error"));
        return true;
      default:
        return false;
    }
  }

  function formatWhen(seconds, now = Date.now(), locale = "en") {
    const value = Number(seconds);
    if (!Number.isFinite(value) || value <= 0) return "";
    const date = new Date(value < 1e12 ? value * 1000 : value), today = new Date(now);
    try {
      if (date.toDateString() === today.toDateString()) return date.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" });
      if (now - date.getTime() < 6 * 86_400_000 && date < today) return date.toLocaleDateString(locale, { weekday: "short" });
      return date.toLocaleDateString(locale, { month: "short", day: "numeric" });
    } catch { return date.toISOString().slice(0, 10); }
  }
  function sourceLabel(source) {
    const key = String(source || "").toLowerCase();
    return SOURCES[key] || (key ? key.slice(0, 20) : "");
  }
  function initials(name) {
    const text = String(name || "").trim();
    return text ? Array.from(text)[0].toUpperCase() : "?";
  }
  function colorFor(name, color) {
    if (/^#[0-9a-fA-F]{3,8}$/.test(String(color || ""))) return color;
    let hash = 0;
    for (const char of String(name || "")) hash = (hash * 31 + char.codePointAt(0)) >>> 0;
    return PALETTE[hash % PALETTE.length];
  }

  return { chooseHermesMachine, fromHistory, withInflight, applyEvent, userItem, systemItem, formatWhen, sourceLabel, initials, colorFor };
});
```

- [ ] **Step 4: 確認通過**

Run: `node --test test/assistant-model.test.js`
Expected: 4 pass, 0 fail

- [ ] **Step 5: Commit**

```bash
git add public/modules/assistant-model.js test/assistant-model.test.js
git commit -m "Turn Hermes history and events into an assistant transcript"
```

---

### Task 2: 字串（11 種語言）

**Files:**
- Create: `public/modules/assistant-i18n.js`
- Modify: `public/modules/workspace-i18n.js`（每個語言表在 `"workspace":` 之後加 `"assistant":`）
- Test: `test/assistant-i18n.test.js`

- [ ] **Step 1: 寫失敗的測試**

```js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const I = require("../public/modules/assistant-i18n.js");
const W = require("../public/modules/workspace-i18n.js");

const LOCALES = ["en", "zh-Hant", "zh-Hans", "ja", "ko", "tr", "fr", "de", "es", "pt-BR", "it"];
const placeholders = text => [...String(text).matchAll(/\{(\w+)\}/g)].map(match => match[1]).sort();

test("every assistant string exists in every locale with the same placeholders", () => {
  assert.deepEqual(Object.keys(I.tables), LOCALES);
  const keys = Object.keys(I.tables.en).sort();
  for (const locale of LOCALES) {
    assert.deepEqual(Object.keys(I.tables[locale]).sort(), keys, locale);
    for (const key of keys) {
      assert.ok(I.tables[locale][key].trim(), `${locale}.${key}`);
      assert.deepEqual(placeholders(I.tables[locale][key]), placeholders(I.tables.en[key]), `${locale}.${key}`);
    }
  }
});

test("strings fill their placeholders and fall back to English", () => {
  assert.equal(I.t("messagePlaceholder", { name: "Luna" }, "zh-Hant"), "傳訊息給 Luna");
  assert.equal(I.t("pending", { count: 2 }, "en"), "Needs you · 2");
  assert.equal(I.t("send", {}, "xx"), "Send");
  assert.equal(I.t("missing-key", {}, "en"), "missing-key");
});

test("the Workspace names the assistant in every locale", () => {
  for (const locale of LOCALES) assert.ok(W.tables[locale].assistant, locale);
  assert.equal(W.tables["zh-Hant"].assistant, "助理");
});
```

- [ ] **Step 2: 確認失敗**

Run: `node --test test/assistant-i18n.test.js`
Expected: FAIL，`Cannot find module '../public/modules/assistant-i18n.js'`

- [ ] **Step 3: 建立 `public/modules/assistant-i18n.js`**

```js
/* Explicit UI keys only: Bot names, titles and messages never enter translation. */
(function (root) {
  "use strict";
  const KEYS = ["workspace", "assistant", "computer", "loading", "retry", "back", "notInstalledTitle", "notInstalledBody", "notRunningTitle",
    "notRunningBody", "signInTitle", "signInBody", "username", "password", "signIn", "wrongPassword", "rateLimited", "oauthOnly", "signOut",
    "bots", "noBots", "pending", "pendingTitle", "nothingPending", "chat", "otherChats", "search", "noChats", "loadMore", "untitled",
    "messagePlaceholder", "send", "stop", "attach", "remove", "tooLarge", "tooMany", "interruptHint", "working", "thinking", "tool",
    "reconnecting", "sendFailed", "failed", "approvalTitle", "once", "session", "always", "deny", "clarifyTitle", "answer", "submit", "skip",
    "sudoTitle", "secretTitle", "hiddenValue", "answered", "withdrawn", "rename", "delete", "confirmDelete", "save", "cancel", "model"];
  const rows = {
    "en": ["Workspace", "Assistant", "Computer", "Loading…", "Try again", "Back", "Hermes is not installed",
      "Install Hermes Agent on one of your computers to use the assistant.", "Hermes is not running", "Start Hermes on {computer}, then try again.",
      "Sign in to Hermes", "Use the username and password of the Hermes dashboard on {computer}. Stepsemble keeps the sign-in, never the password.",
      "Username", "Password", "Sign in", "The username or password is wrong.", "Too many attempts. Wait a minute and try again.",
      "This Hermes only allows OAuth sign-in, which Stepsemble does not support yet.", "Sign out of Hermes", "Bots", "No Bots yet.",
      "Needs you · {count}", "Waiting for your answer", "Nothing is waiting for you.", "Chat", "Other conversations", "Search conversations",
      "No other conversations.", "Show more", "Untitled", "Message {name}", "Send", "Stop", "Attach", "Remove", "{name} is larger than 10 MB.",
      "Attach up to 4 files at a time.", "Sending now interrupts the current reply.", "Working…", "Thinking", "Tool", "Reconnecting to Hermes…",
      "Could not send: {message}", "Something went wrong: {message}", "{bot} wants to run this", "Allow once", "Allow for this chat", "Always allow",
      "Deny", "{bot} has a question", "Your answer", "Send answer", "Skip", "{bot} needs your sudo password", "{bot} needs {name}", "Hidden as you type",
      "Answered", "No longer needed", "Rename", "Delete", "Tap again to delete", "Save", "Cancel", "Model"],
    "zh-Hant": ["工作區", "助理", "電腦", "載入中…", "再試一次", "返回", "Hermes 尚未安裝", "在你的其中一台電腦安裝 Hermes Agent，就能使用助理。",
      "Hermes 沒有在執行", "請在 {computer} 啟動 Hermes，然後再試一次。", "登入 Hermes",
      "使用 {computer} 上 Hermes 網頁控制台的帳號和密碼。Stepsemble 只保留登入狀態，不會保存密碼。", "帳號", "密碼", "登入", "帳號或密碼錯誤。",
      "嘗試次數太多，請等一分鐘再試。", "這個 Hermes 只允許 OAuth 登入，Stepsemble 目前還不支援。", "登出 Hermes", "Bot", "還沒有 Bot。",
      "等你處理 · {count}", "等待你的回覆", "目前沒有需要你處理的事。", "對話", "其他對話", "搜尋對話", "沒有其他對話。", "顯示更多", "未命名",
      "傳訊息給 {name}", "傳送", "停止", "附加檔案", "移除", "{name} 超過 10 MB。", "一次最多附加 4 個檔案。", "現在送出會中斷目前的回覆。", "處理中…",
      "思考過程", "工具", "正在重新連線 Hermes…", "無法傳送：{message}", "發生錯誤：{message}", "{bot} 想執行這項操作", "允許一次", "這段對話都允許",
      "一律允許", "拒絕", "{bot} 有問題要問你", "你的回答", "送出回答", "略過", "{bot} 需要你的 sudo 密碼", "{bot} 需要 {name}", "輸入時會隱藏",
      "已回覆", "已不需要", "重新命名", "刪除", "再點一次就刪除", "儲存", "取消", "模型"],
    "zh-Hans": ["工作区", "助理", "电脑", "加载中…", "再试一次", "返回", "Hermes 尚未安装", "在你的其中一台电脑安装 Hermes Agent，就能使用助理。",
      "Hermes 没有在运行", "请在 {computer} 启动 Hermes，然后再试一次。", "登录 Hermes",
      "使用 {computer} 上 Hermes 网页控制台的账号和密码。Stepsemble 只保留登录状态，不会保存密码。", "账号", "密码", "登录", "账号或密码错误。",
      "尝试次数太多，请等一分钟再试。", "这个 Hermes 只允许 OAuth 登录，Stepsemble 目前还不支持。", "退出 Hermes", "Bot", "还没有 Bot。",
      "等你处理 · {count}", "等待你的回复", "目前没有需要你处理的事。", "对话", "其他对话", "搜索对话", "没有其他对话。", "显示更多", "未命名",
      "给 {name} 发消息", "发送", "停止", "附加文件", "移除", "{name} 超过 10 MB。", "一次最多附加 4 个文件。", "现在发送会中断当前的回复。", "处理中…",
      "思考过程", "工具", "正在重新连接 Hermes…", "无法发送：{message}", "发生错误：{message}", "{bot} 想执行这项操作", "允许一次", "本对话都允许",
      "始终允许", "拒绝", "{bot} 有问题要问你", "你的回答", "发送回答", "跳过", "{bot} 需要你的 sudo 密码", "{bot} 需要 {name}", "输入时会隐藏",
      "已回复", "已不需要", "重命名", "删除", "再点一次即删除", "保存", "取消", "模型"],
    "ja": ["ワークスペース", "アシスタント", "コンピュータ", "読み込み中…", "もう一度試す", "戻る", "Hermes がインストールされていません",
      "いずれかのコンピュータに Hermes Agent をインストールすると、アシスタントを使えます。", "Hermes が実行されていません",
      "{computer} で Hermes を起動してから、もう一度お試しください。", "Hermes にサインイン",
      "{computer} の Hermes ダッシュボードのユーザー名とパスワードを使います。Stepsemble が保存するのはサインイン状態だけで、パスワードは保存しません。",
      "ユーザー名", "パスワード", "サインイン", "ユーザー名またはパスワードが違います。", "試行回数が多すぎます。1 分待ってからお試しください。",
      "この Hermes は OAuth サインインのみ許可しています。Stepsemble はまだ対応していません。", "Hermes からサインアウト", "Bot", "Bot はまだありません。",
      "対応待ち · {count}", "あなたの回答を待っています", "対応が必要なものはありません。", "チャット", "ほかの会話", "会話を検索", "ほかの会話はありません。",
      "さらに表示", "無題", "{name} にメッセージ", "送信", "停止", "添付", "取り除く", "{name} は 10 MB を超えています。", "一度に添付できるのは 4 件までです。",
      "今送信すると、現在の返信は中断されます。", "処理中…", "思考", "ツール", "Hermes に再接続しています…", "送信できませんでした：{message}",
      "問題が発生しました：{message}", "{bot} がこれを実行しようとしています", "今回だけ許可", "このチャットでは許可", "常に許可", "拒否",
      "{bot} から質問があります", "あなたの回答", "回答を送信", "スキップ", "{bot} が sudo パスワードを求めています", "{bot} が {name} を求めています",
      "入力中は非表示", "回答済み", "不要になりました", "名前を変更", "削除", "もう一度タップすると削除", "保存", "キャンセル", "モデル"],
    "ko": ["작업 공간", "어시스턴트", "컴퓨터", "불러오는 중…", "다시 시도", "뒤로", "Hermes가 설치되어 있지 않습니다",
      "컴퓨터 중 하나에 Hermes Agent를 설치하면 어시스턴트를 사용할 수 있습니다.", "Hermes가 실행 중이 아닙니다", "{computer}에서 Hermes를 시작한 뒤 다시 시도하세요.",
      "Hermes에 로그인", "{computer}에 있는 Hermes 대시보드의 사용자 이름과 비밀번호를 사용하세요. Stepsemble은 로그인 상태만 보관하고 비밀번호는 저장하지 않습니다.",
      "사용자 이름", "비밀번호", "로그인", "사용자 이름 또는 비밀번호가 틀렸습니다.", "시도 횟수가 너무 많습니다. 1분 뒤에 다시 시도하세요.",
      "이 Hermes는 OAuth 로그인만 허용하며, Stepsemble은 아직 지원하지 않습니다.", "Hermes에서 로그아웃", "Bot", "아직 Bot이 없습니다.", "확인 필요 · {count}",
      "답변을 기다리는 중", "확인할 항목이 없습니다.", "채팅", "다른 대화", "대화 검색", "다른 대화가 없습니다.", "더 보기", "제목 없음", "{name}에게 메시지",
      "보내기", "중지", "첨부", "빼기", "{name} 파일이 10MB를 넘습니다.", "한 번에 최대 4개까지 첨부할 수 있습니다.", "지금 보내면 현재 답변이 중단됩니다.",
      "작업 중…", "생각", "도구", "Hermes에 다시 연결하는 중…", "보낼 수 없습니다: {message}", "문제가 발생했습니다: {message}",
      "{bot}이(가) 이 작업을 실행하려고 합니다", "이번만 허용", "이 채팅에서 허용", "항상 허용", "거부", "{bot}이(가) 질문이 있습니다", "내 답변", "답변 보내기",
      "건너뛰기", "{bot}에 sudo 비밀번호가 필요합니다", "{bot}에 {name}이(가) 필요합니다", "입력하는 동안 숨겨집니다", "답변함", "더 이상 필요 없음", "이름 바꾸기",
      "삭제", "한 번 더 누르면 삭제", "저장", "취소", "모델"],
    "tr": ["Çalışma alanı", "Asistan", "Bilgisayar", "Yükleniyor…", "Tekrar dene", "Geri", "Hermes yüklü değil",
      "Asistanı kullanmak için bilgisayarlarınızdan birine Hermes Agent yükleyin.", "Hermes çalışmıyor", "{computer} üzerinde Hermes'i başlatın ve tekrar deneyin.",
      "Hermes'e giriş yapın", "{computer} üzerindeki Hermes panosunun kullanıcı adı ve parolasını kullanın. Stepsemble yalnızca oturumu saklar, parolayı asla saklamaz.",
      "Kullanıcı adı", "Parola", "Giriş yap", "Kullanıcı adı veya parola yanlış.", "Çok fazla deneme. Bir dakika bekleyip tekrar deneyin.",
      "Bu Hermes yalnızca OAuth ile girişe izin veriyor; Stepsemble bunu henüz desteklemiyor.", "Hermes'ten çıkış yap", "Botlar", "Henüz Bot yok.",
      "Sizi bekliyor · {count}", "Yanıtınızı bekliyor", "Sizi bekleyen bir şey yok.", "Sohbet", "Diğer konuşmalar", "Konuşmalarda ara", "Başka konuşma yok.",
      "Daha fazla göster", "Adsız", "{name} için mesaj", "Gönder", "Durdur", "Ekle", "Kaldır", "{name} 10 MB'tan büyük.", "Aynı anda en fazla 4 dosya ekleyin.",
      "Şimdi göndermek mevcut yanıtı keser.", "Çalışıyor…", "Düşünme", "Araç", "Hermes'e yeniden bağlanılıyor…", "Gönderilemedi: {message}",
      "Bir sorun oluştu: {message}", "{bot} bunu çalıştırmak istiyor", "Bir kez izin ver", "Bu sohbette izin ver", "Her zaman izin ver", "Reddet",
      "{bot} bir soru soruyor", "Yanıtınız", "Yanıtı gönder", "Atla", "{bot} sudo parolanızı istiyor", "{bot} {name} istiyor", "Yazarken gizlenir", "Yanıtlandı",
      "Artık gerekmiyor", "Yeniden adlandır", "Sil", "Silmek için tekrar dokunun", "Kaydet", "İptal", "Model"],
    "fr": ["Espace de travail", "Assistant", "Ordinateur", "Chargement…", "Réessayer", "Retour", "Hermes n’est pas installé",
      "Installez Hermes Agent sur l’un de vos ordinateurs pour utiliser l’assistant.", "Hermes n’est pas lancé", "Lancez Hermes sur {computer}, puis réessayez.",
      "Se connecter à Hermes", "Utilisez le nom d’utilisateur et le mot de passe du tableau de bord Hermes de {computer}. Stepsemble conserve la connexion, jamais le mot de passe.",
      "Nom d’utilisateur", "Mot de passe", "Se connecter", "Nom d’utilisateur ou mot de passe incorrect.", "Trop de tentatives. Patientez une minute puis réessayez.",
      "Ce Hermes n’accepte que la connexion OAuth, que Stepsemble ne prend pas encore en charge.", "Se déconnecter de Hermes", "Bots", "Aucun Bot pour l’instant.",
      "Pour vous · {count}", "En attente de votre réponse", "Rien ne vous attend.", "Discussion", "Autres conversations", "Rechercher dans les conversations",
      "Aucune autre conversation.", "Afficher plus", "Sans titre", "Message à {name}", "Envoyer", "Arrêter", "Joindre", "Retirer", "{name} dépasse 10 Mo.",
      "Joignez au plus 4 fichiers à la fois.", "Envoyer maintenant interrompt la réponse en cours.", "En cours…", "Réflexion", "Outil", "Reconnexion à Hermes…",
      "Envoi impossible : {message}", "Un problème est survenu : {message}", "{bot} veut exécuter ceci", "Autoriser une fois", "Autoriser pour cette discussion",
      "Toujours autoriser", "Refuser", "{bot} a une question", "Votre réponse", "Envoyer la réponse", "Passer", "{bot} a besoin de votre mot de passe sudo",
      "{bot} a besoin de {name}", "Masqué pendant la saisie", "Répondu", "Plus nécessaire", "Renommer", "Supprimer", "Touchez encore pour supprimer",
      "Enregistrer", "Annuler", "Modèle"],
    "de": ["Arbeitsbereich", "Assistent", "Computer", "Wird geladen…", "Erneut versuchen", "Zurück", "Hermes ist nicht installiert",
      "Installiere Hermes Agent auf einem deiner Computer, um den Assistenten zu nutzen.", "Hermes läuft nicht", "Starte Hermes auf {computer} und versuche es dann erneut.",
      "Bei Hermes anmelden", "Verwende Benutzername und Passwort des Hermes-Dashboards auf {computer}. Stepsemble speichert die Anmeldung, nie das Passwort.",
      "Benutzername", "Passwort", "Anmelden", "Benutzername oder Passwort ist falsch.", "Zu viele Versuche. Warte eine Minute und versuche es erneut.",
      "Dieses Hermes erlaubt nur die OAuth-Anmeldung, die Stepsemble noch nicht unterstützt.", "Von Hermes abmelden", "Bots", "Noch keine Bots.",
      "Wartet auf dich · {count}", "Wartet auf deine Antwort", "Nichts wartet auf dich.", "Chat", "Andere Unterhaltungen", "Unterhaltungen durchsuchen",
      "Keine anderen Unterhaltungen.", "Mehr anzeigen", "Ohne Titel", "Nachricht an {name}", "Senden", "Stoppen", "Anhängen", "Entfernen",
      "{name} ist größer als 10 MB.", "Hänge höchstens 4 Dateien auf einmal an.", "Jetzt zu senden unterbricht die aktuelle Antwort.", "Wird bearbeitet…",
      "Denkprozess", "Werkzeug", "Verbindung zu Hermes wird wiederhergestellt…", "Senden fehlgeschlagen: {message}", "Etwas ist schiefgelaufen: {message}",
      "{bot} möchte das ausführen", "Einmal erlauben", "Für diesen Chat erlauben", "Immer erlauben", "Ablehnen", "{bot} hat eine Frage", "Deine Antwort",
      "Antwort senden", "Überspringen", "{bot} braucht dein sudo-Passwort", "{bot} braucht {name}", "Beim Tippen verborgen", "Beantwortet", "Nicht mehr nötig",
      "Umbenennen", "Löschen", "Zum Löschen erneut tippen", "Speichern", "Abbrechen", "Modell"],
    "es": ["Espacio de trabajo", "Asistente", "Ordenador", "Cargando…", "Reintentar", "Atrás", "Hermes no está instalado",
      "Instala Hermes Agent en uno de tus ordenadores para usar el asistente.", "Hermes no se está ejecutando", "Inicia Hermes en {computer} y vuelve a intentarlo.",
      "Iniciar sesión en Hermes", "Usa el usuario y la contraseña del panel de Hermes en {computer}. Stepsemble guarda la sesión, nunca la contraseña.",
      "Usuario", "Contraseña", "Iniciar sesión", "El usuario o la contraseña no son correctos.", "Demasiados intentos. Espera un minuto y vuelve a intentarlo.",
      "Este Hermes solo permite iniciar sesión con OAuth, que Stepsemble aún no admite.", "Cerrar sesión de Hermes", "Bots", "Todavía no hay Bots.",
      "Te espera · {count}", "Esperando tu respuesta", "No hay nada esperándote.", "Chat", "Otras conversaciones", "Buscar conversaciones",
      "No hay otras conversaciones.", "Mostrar más", "Sin título", "Mensaje para {name}", "Enviar", "Detener", "Adjuntar", "Quitar", "{name} supera los 10 MB.",
      "Adjunta como máximo 4 archivos a la vez.", "Enviar ahora interrumpe la respuesta actual.", "Trabajando…", "Razonamiento", "Herramienta",
      "Reconectando con Hermes…", "No se pudo enviar: {message}", "Algo salió mal: {message}", "{bot} quiere ejecutar esto", "Permitir una vez",
      "Permitir en este chat", "Permitir siempre", "Denegar", "{bot} tiene una pregunta", "Tu respuesta", "Enviar respuesta", "Omitir",
      "{bot} necesita tu contraseña de sudo", "{bot} necesita {name}", "Oculto mientras escribes", "Respondido", "Ya no hace falta", "Cambiar nombre", "Eliminar",
      "Toca otra vez para eliminar", "Guardar", "Cancelar", "Modelo"],
    "pt-BR": ["Área de trabalho", "Assistente", "Computador", "Carregando…", "Tentar de novo", "Voltar", "Hermes não está instalado",
      "Instale o Hermes Agent em um dos seus computadores para usar o assistente.", "Hermes não está em execução", "Inicie o Hermes em {computer} e tente de novo.",
      "Entrar no Hermes", "Use o usuário e a senha do painel do Hermes em {computer}. O Stepsemble guarda a sessão, nunca a senha.", "Usuário", "Senha", "Entrar",
      "Usuário ou senha incorretos.", "Tentativas demais. Aguarde um minuto e tente de novo.", "Este Hermes só permite entrar com OAuth, que o Stepsemble ainda não suporta.",
      "Sair do Hermes", "Bots", "Ainda não há Bots.", "Aguardando você · {count}", "Aguardando sua resposta", "Nada está aguardando você.", "Conversa",
      "Outras conversas", "Buscar conversas", "Nenhuma outra conversa.", "Mostrar mais", "Sem título", "Mensagem para {name}", "Enviar", "Parar", "Anexar", "Remover",
      "{name} tem mais de 10 MB.", "Anexe no máximo 4 arquivos por vez.", "Enviar agora interrompe a resposta atual.", "Trabalhando…", "Raciocínio", "Ferramenta",
      "Reconectando ao Hermes…", "Não foi possível enviar: {message}", "Algo deu errado: {message}", "{bot} quer executar isto", "Permitir uma vez",
      "Permitir nesta conversa", "Sempre permitir", "Negar", "{bot} tem uma pergunta", "Sua resposta", "Enviar resposta", "Pular", "{bot} precisa da sua senha sudo",
      "{bot} precisa de {name}", "Oculto enquanto você digita", "Respondido", "Não é mais necessário", "Renomear", "Excluir", "Toque de novo para excluir", "Salvar",
      "Cancelar", "Modelo"],
    "it": ["Area di lavoro", "Assistente", "Computer", "Caricamento…", "Riprova", "Indietro", "Hermes non è installato",
      "Installa Hermes Agent su uno dei tuoi computer per usare l’assistente.", "Hermes non è in esecuzione", "Avvia Hermes su {computer}, poi riprova.",
      "Accedi a Hermes", "Usa nome utente e password della dashboard di Hermes su {computer}. Stepsemble conserva l’accesso, mai la password.", "Nome utente",
      "Password", "Accedi", "Nome utente o password errati.", "Troppi tentativi. Attendi un minuto e riprova.",
      "Questo Hermes consente solo l’accesso OAuth, che Stepsemble non supporta ancora.", "Esci da Hermes", "Bot", "Ancora nessun Bot.", "Ti aspetta · {count}",
      "In attesa della tua risposta", "Niente ti aspetta.", "Chat", "Altre conversazioni", "Cerca nelle conversazioni", "Nessun’altra conversazione.", "Mostra altro",
      "Senza titolo", "Messaggio a {name}", "Invia", "Interrompi", "Allega", "Rimuovi", "{name} supera i 10 MB.", "Allega al massimo 4 file alla volta.",
      "Inviare ora interrompe la risposta in corso.", "In corso…", "Ragionamento", "Strumento", "Riconnessione a Hermes…", "Invio non riuscito: {message}",
      "Qualcosa è andato storto: {message}", "{bot} vuole eseguire questo", "Consenti una volta", "Consenti in questa chat", "Consenti sempre", "Nega",
      "{bot} ha una domanda", "La tua risposta", "Invia risposta", "Salta", "{bot} ha bisogno della tua password sudo", "{bot} ha bisogno di {name}",
      "Nascosto mentre scrivi", "Risposto", "Non più necessario", "Rinomina", "Elimina", "Tocca di nuovo per eliminare", "Salva", "Annulla", "Modello"],
  };
  const tables = {};
  for (const [locale, values] of Object.entries(rows)) {
    if (values.length !== KEYS.length) throw new Error(`assistant-i18n: ${locale} has ${values.length} strings, expected ${KEYS.length}`);
    tables[locale] = Object.freeze(Object.fromEntries(KEYS.map((key, index) => [key, values[index]])));
  }
  function t(key, vars = {}, locale = "en") {
    const table = tables[locale] || tables.en;
    const text = table[key] ?? tables.en[key] ?? key;
    return text.replace(/\{(\w+)\}/g, (match, name) => (vars && vars[name] !== undefined ? String(vars[name]) : match));
  }
  const api = Object.freeze({ tables: Object.freeze(tables), t });
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.StepsembleAssistantI18n = api;
})(typeof window !== "undefined" ? window : globalThis);
```

- [ ] **Step 4: 在 workspace-i18n 加上「助理」**

Run（一次性腳本，在每個語言表的 `"workspace":` 那一行之後插入）：

```bash
node -e '
const fs = require("fs"), file = "public/modules/workspace-i18n.js";
const names = { "en": "Assistant", "zh-Hant": "助理", "zh-Hans": "助理", "ja": "アシスタント", "ko": "어시스턴트", "tr": "Asistan", "fr": "Assistant",
  "de": "Assistent", "es": "Asistente", "pt-BR": "Assistente", "it": "Assistente" };
let locale = null, inserted = 0;
const lines = fs.readFileSync(file, "utf8").split("\n").flatMap(line => {
  const table = /^  "([A-Za-z-]+)": \{$/.exec(line);
  if (table) locale = table[1];
  if (locale && names[locale] && /^    "workspace": /.test(line)) { inserted += 1; const name = names[locale]; locale = null; return [line, `    "assistant": ${JSON.stringify(name)},`]; }
  return [line];
});
if (inserted !== 11) throw new Error("inserted " + inserted);
fs.writeFileSync(file, lines.join("\n"));
'
```

- [ ] **Step 5: 確認通過**

Run: `node --test test/assistant-i18n.test.js test/workspace-i18n.test.js`
Expected: 全部 pass

- [ ] **Step 6: Commit**

```bash
git add public/modules/assistant-i18n.js public/modules/workspace-i18n.js test/assistant-i18n.test.js
git commit -m "Name the assistant in every Stepsemble language"
```

---

### Task 3: 新增對話不再列出 Hermes

**Files:**
- Modify: `public/modules/agent-identity.js`（`StepsembleAgentIdentity.create = create;` 之後）
- Modify: `public/app.js`（`renderNewAgentOptions` 的 `const connectors = agentCatalog;`）
- Modify: `public/modules/workspace.js:1058`（新增對話對話框的 Agent 迴圈）
- Test: `test/agent-identity.test.js`（加一個 test）

- [ ] **Step 1: 寫失敗的測試**（附加到 `test/agent-identity.test.js` 結尾）

```js
test("a personal assistant is not offered as a new coding conversation", () => {
  assert.equal(identity.startsConversations({ id: "codex", installed: true, category: "coding" }), true);
  assert.equal(identity.startsConversations({ id: "hermes", installed: true, category: "personal" }), false);
  assert.equal(identity.startsConversations({ id: "kilo", installed: false, category: "coding" }), false);
  assert.equal(identity.startsConversations(null), false);
});
```

- [ ] **Step 2: 確認失敗**

Run: `node --test test/agent-identity.test.js`
Expected: FAIL，`identity.startsConversations is not a function`

- [ ] **Step 3: 實作**

`public/modules/agent-identity.js`，在 `StepsembleAgentIdentity.create = create;` 之後加入：

```js
    // Personal assistants (Hermes) live on the assistant page; a new
    // conversation offers only installed coding agents.
    function startsConversations(connector) {
        return !!connector && connector.installed === true && connector.category !== "personal";
    }
    StepsembleAgentIdentity.startsConversations = startsConversations;
```

`public/app.js` 的 `renderNewAgentOptions`，把 `const connectors = agentCatalog;` 改成：

```js
  // Hermes is reached from the assistant page, not as a coding conversation.
  const connectors = agentCatalog.filter(connector => connector.category !== "personal");
```

（已安裝與否仍由後面的 `option.disabled` 處理，所以這裡只排除 personal。）

`public/modules/workspace.js:1058`，把 `for (const agent of data.connectors || []) if (agent.installed) {` 改成：

```js
for (const agent of data.connectors || []) if (window.StepsembleAgentIdentity?.startsConversations ? window.StepsembleAgentIdentity.startsConversations(agent) : agent.installed && agent.category !== "personal") {
```

- [ ] **Step 4: 確認通過**

Run: `node --test test/agent-identity.test.js && node --check public/app.js && node --check public/modules/workspace.js`
Expected: pass，語法檢查無輸出

- [ ] **Step 5: Commit**

```bash
git add public/modules/agent-identity.js public/app.js public/modules/workspace.js test/agent-identity.test.js
git commit -m "Keep Hermes out of new coding conversations"
```

---

### Task 4: 助理頁（API、畫面、樣式、HTML）

**Files:**
- Create: `public/modules/assistant-api.js`
- Create: `public/modules/assistant.js`
- Create: `public/modules/assistant.css`
- Create: `public/assistant.html`
- Modify: `public/app.js`（`workspaceDestination()` 開頭）

這個任務的行為由 Task 7 的瀏覽器測試驗證（手機 393×852、桌面 1440×900）。

- [ ] **Step 1: `public/modules/assistant-api.js`**

```js
(function (root) {
  "use strict";

  // The assistant page's only door to Stepsemble: fetch with the sign-in
  // cookie, routed to the computer that runs Hermes ("" for this one,
  // /r/<id> through the device relay for another), plus the event stream.

  class ApiError extends Error {
    constructor(status, code, message) { super(message || code); this.name = "ApiError"; this.status = status; this.code = code; }
  }

  async function request(base, path, { method = "GET", body, signal, onSignedOut } = {}) {
    let response;
    try {
      response = await fetch(base + path, { method, credentials: "same-origin", cache: "no-store", signal,
        headers: body === undefined ? {} : { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    } catch (error) { throw new ApiError(0, "network_error", error?.message || "Network error"); }
    let data = null;
    try { data = await response.json(); } catch {}
    const code = typeof data?.error === "string" ? data.error : "";
    if (response.status === 401 && !code.startsWith("hermes_")) {
      onSignedOut?.();
      throw new ApiError(401, "stepsemble_signed_out", "Sign in to Stepsemble again");
    }
    if (!response.ok) throw new ApiError(response.status, code || "request_failed", typeof data?.message === "string" && data.message ? data.message : `HTTP ${response.status}`);
    return data;
  }

  async function machines({ onSignedOut } = {}) {
    const data = await request("", "/api/machines", { onSignedOut });
    const list = Array.isArray(data?.machines) ? data.machines : [];
    const self = data?.current || data?.selfId || list.find(machine => machine?.self)?.id;
    return list.filter(machine => machine && typeof machine.id === "string").map(machine => ({
      id: machine.id, name: machine.name || machine.id, self: machine.id === self,
      base: machine.id === self ? "" : `/r/${encodeURIComponent(machine.id)}` }));
  }

  function create({ base = "", onSignedOut } = {}) {
    const call = (path, options = {}) => request(base, path, { ...options, onSignedOut });
    const post = (path, body = {}) => call(path, { method: "POST", body });
    function status() {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 8000);
      return call("/api/assistant/status", { signal: controller.signal }).finally(() => clearTimeout(timer));
    }
    function stream({ after = 0, onEvent, onState } = {}) {
      let source = null, closed = false, last = after, retry = 0;
      const open = () => {
        if (closed) return;
        source = new EventSource(`${base}/api/assistant/stream?after=${last}`);
        source.onopen = () => onState?.("open");
        source.onmessage = message => {
          let event;
          try { event = JSON.parse(message.data); } catch { return; }
          if (Number.isSafeInteger(event?.id) && event.id > last) last = event.id;
          onEvent?.(event);
        };
        source.onerror = () => {
          onState?.("error");
          // EventSource retries a dropped stream by itself; a refused one
          // (for example after Stepsemble signed out) is closed for good.
          if (source.readyState === 2 && !closed) { clearTimeout(retry); retry = setTimeout(open, 3000); }
        };
      };
      open();
      return { close() { closed = true; clearTimeout(retry); source?.close(); }, get last() { return last; } };
    }
    return Object.freeze({
      base, status, stream,
      login: (username, password) => post("/api/assistant/login", { username, password }),
      logout: () => post("/api/assistant/logout"),
      bots: () => call("/api/assistant/bots"),
      botChat: profile => post("/api/assistant/bot-chat", { profile }),
      openSession: (sessionId, profile) => post("/api/assistant/session/open", { sessionId, profile }),
      sessions: (profile, q = "", offset = 0) => call(`/api/assistant/sessions?${new URLSearchParams({ profile, q, offset: String(offset) })}`),
      rename: (sessionId, profile, title) => post("/api/assistant/session/rename", { sessionId, profile, title }),
      remove: (sessionId, profile) => post("/api/assistant/session/delete", { sessionId, profile }),
      read: (sessionId, profile) => post("/api/assistant/session/read", { sessionId, profile }),
      prompt: (sessionId, text, attachments = []) => post("/api/assistant/prompt", { sessionId, text, attachments }),
      interrupt: sessionId => post("/api/assistant/interrupt", { sessionId }),
      asks: () => call("/api/assistant/asks"),
      respond: (id, answer) => post("/api/assistant/respond", { id, answer }),
      watch: (clientId, sessionId) => post("/api/assistant/watch", { clientId, sessionId }),
    });
  }

  root.StepsembleAssistantApi = Object.freeze({ create, machines, ApiError });
})(window);
```

- [ ] **Step 2: `public/modules/assistant.js`**

```js
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
  let api = null, machine = null, bots = [], stream = null, chat = null, tab = "chat";
  let renderQueued = false, watchTimer = 0, reloadTimer = 0;

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
    for (const key of ["bot", "session"]) if (params.get(key)) login.searchParams.set(key, params.get(key));
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

  function avatar(bot) {
    const node = el("span", "assistant-avatar", M.initials(bot.displayName || bot.name));
    node.style.background = M.colorFor(bot.name, bot.color);
    node.setAttribute("aria-hidden", "true");
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
    } catch (error) { render(errorView(error, () => start(next))); return; }
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

  async function loadBots() { bots = ((await api.bots()).bots || []).filter(bot => !bot.hidden); }

  function waitingFor(profile) { return [...asks.values()].filter(ask => ask.profile === profile).length; }

  function updatePending() {
    const node = document.getElementById("assistant-pending");
    if (!node) return;
    node.hidden = asks.size === 0;
    node.textContent = t("pending", { count: asks.size });
  }

  function showRoster() {
    chat = null;
    setUrl(null, null);
    watchNow();
    const wrap = el("section", "assistant-roster");
    const head = el("div", "assistant-section-head");
    const pending = button("", "assistant-pending", () => render(pendingView()));
    pending.id = "assistant-pending";
    head.append(el("h1", "", t("bots")), pending);
    wrap.append(head);
    if (!bots.length) wrap.append(el("p", "assistant-empty", t("noBots")));
    const list = el("ul", "assistant-bot-list");
    const sorted = [...bots].sort((a, b) => (b.botChat?.lastActive || 0) - (a.botChat?.lastActive || 0) || Number(b.isDefault) - Number(a.isDefault));
    for (const bot of sorted) {
      const row = button("", "assistant-bot-row", () => void openBot(bot.name, null));
      row.dataset.profile = bot.name;
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
    wrap.append(list, button(t("signOut"), "btn ghost assistant-sign-out", async () => {
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
    head.append(button("‹", "btn ghost assistant-back", showRoster), el("h1", "", t("pendingTitle")));
    head.firstChild.setAttribute("aria-label", t("back"));
    wrap.append(head);
    if (!asks.size) wrap.append(el("p", "assistant-empty", t("nothingPending")));
    const list = el("ul", "assistant-bot-list");
    for (const ask of asks.values()) {
      const bot = bots.find(row => row.name === ask.profile) || { name: ask.profile, displayName: ask.bot };
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

  async function openBot(profile, sessionId, { title = "" } = {}) {
    const bot = bots.find(row => row.name === profile) || { name: profile, displayName: profile, color: null, model: "", botChat: null };
    tab = "chat";
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

  function botView() {
    const wrap = el("section", "assistant-bot");
    const head = el("header", "assistant-bot-head");
    const back = button("‹", "btn ghost assistant-back", () => {
      if (chat && !chat.botChat) { void openBot(chat.profile, null); return; }
      void loadBots().catch(() => {}).finally(showRoster);
    });
    back.setAttribute("aria-label", t("back"));
    const title = el("div", "assistant-bot-title");
    const detail = chat.botChat ? (chat.bot.model ? `${t("model")} · ${chat.bot.model}` : "") : (chat.title || t("untitled"));
    title.append(el("strong", "", chat.bot.displayName), el("small", "", detail));
    head.append(back, avatar(chat.bot), title);
    const tabs = el("div", "assistant-tabs");
    tabs.setAttribute("role", "tablist");
    for (const [key, label] of [["chat", t("chat")], ["other", t("otherChats")]]) {
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
    if (tab === "other") { wrap.append(sessionsView()); return wrap; }
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
      try {
        await api.prompt(chat.sessionId, text, attachments);
        chat.running = true;
      } catch (error) {
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
    const name = el("strong", "", row.title || row.preview || t("untitled"));
    open.append(name, el("small", "", [M.sourceLabel(row.source), M.formatWhen(row.lastActive, Date.now(), prefs.locale)].filter(Boolean).join(" · ")));
    const rename = button(t("rename"), "btn ghost", () => {
      const input = el("input", "assistant-rename");
      input.value = row.title || "";
      input.setAttribute("aria-label", t("rename"));
      const save = async () => {
        const title = input.value.trim();
        if (title && title !== row.title) {
          try { await api.rename(row.id, chat.profile, title); row.title = title; } catch (error) { toast(t("failed", { message: error.message })); }
        }
        renderSessions();
      };
      input.addEventListener("keydown", event => { if (event.key === "Enter") { event.preventDefault(); void save(); } if (event.key === "Escape") renderSessions(); });
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
      if (!chat && document.querySelector(".assistant-roster .assistant-bot-list")) showRoster();
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
```

- [ ] **Step 3: `public/modules/assistant.css`**

```css
/* The assistant page: Hermes Bots and their conversations. Colours, type and
   the Markdown body come from style.css, so the page follows the user's
   Stepsemble theme instead of carrying its own. */
.assistant-page { display: flex; flex-direction: column; height: 100dvh; margin: 0; overflow: hidden; background: var(--paper); color: var(--ink);
  font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; }
.assistant-top { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: calc(var(--safe-top) + 10px) 16px 10px;
  border-bottom: 1px solid var(--line); background: var(--paper); }
.assistant-switch { display: inline-flex; padding: 3px; border: 1px solid var(--line); border-radius: 10px; background: var(--milk); }
.assistant-switch > * { padding: 5px 14px; border-radius: 7px; color: var(--pine-soft); font-size: .85rem; font-weight: 600; text-decoration: none; }
.assistant-switch [aria-current="page"] { background: var(--bubble-user); color: var(--ink); }
.assistant-machine { max-width: 45vw; padding: 6px 8px; border: 1px solid var(--line); border-radius: 8px; background: var(--milk); color: var(--ink); }
.assistant-main { flex: 1; min-height: 0; width: 100%; max-width: 860px; margin: 0 auto; overflow-y: auto; overscroll-behavior: contain; }
body.assistant-offline .assistant-top { box-shadow: inset 0 -2px 0 var(--warn); }

.assistant-message, .assistant-sign-in { display: grid; gap: 12px; max-width: 420px; margin: 12vh auto 0; padding: 0 24px; text-align: center; }
.assistant-message h1, .assistant-sign-in h1 { margin: 0; font-size: 1.2rem; }
.assistant-message p, .assistant-sign-in p { margin: 0; color: var(--pine-soft); }
.assistant-sign-in { text-align: left; }
.assistant-field { display: grid; gap: 4px; font-size: .85rem; color: var(--pine-soft); }
.assistant-field input, .assistant-search, .assistant-rename, .assistant-ask-secret input, .assistant-ask-input {
  width: 100%; box-sizing: border-box; padding: 10px 12px; border: 1px solid var(--line); border-radius: 10px; background: var(--milk); color: var(--ink); font: inherit; font-size: 16px; }
.assistant-error { margin: 0; color: var(--err); font-size: .85rem; }

.assistant-roster { padding: 12px 16px 32px; }
.assistant-section-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin: 4px 0 8px; }
.assistant-section-head h1 { margin: 0; font-size: 1.15rem; }
.assistant-pending { padding: 4px 12px; border: 1px solid var(--warn); border-radius: 999px; background: transparent; color: var(--warn); font-weight: 600; cursor: pointer; }
.assistant-bot-list, .assistant-session-list { margin: 0; padding: 0; list-style: none; }
.assistant-bot-row, .assistant-session-open { display: flex; align-items: center; gap: 12px; width: 100%; min-height: 64px; padding: 10px 4px; border: 0;
  border-bottom: 1px solid var(--line); background: transparent; color: inherit; font: inherit; text-align: left; cursor: pointer; }
.assistant-avatar { display: grid; flex: 0 0 40px; width: 40px; height: 40px; place-items: center; border-radius: 50%; color: #fff; font-weight: 700; }
.assistant-bot-copy, .assistant-session-open { min-width: 0; }
.assistant-bot-copy { flex: 1; }
.assistant-bot-copy strong, .assistant-bot-copy small, .assistant-session-open strong, .assistant-session-open small {
  display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.assistant-bot-copy small, .assistant-session-open small, .assistant-bot-meta time { color: var(--pine-soft); font-size: .8rem; }
.assistant-bot-meta { display: grid; justify-items: end; gap: 4px; }
.assistant-badge { min-width: 20px; padding: 0 6px; border-radius: 999px; background: var(--warn); color: #fff; font-size: .75rem; font-weight: 700; text-align: center; }
.assistant-sign-out { margin-top: 24px; }
.assistant-empty { padding: 24px 4px; color: var(--pine-soft); }

.assistant-bot { display: flex; flex-direction: column; height: 100%; }
.assistant-bot-head { display: flex; align-items: center; gap: 10px; padding: 8px 12px; }
.assistant-back { min-width: 40px; font-size: 1.4rem; }
.assistant-bot-title { min-width: 0; }
.assistant-bot-title strong, .assistant-bot-title small { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.assistant-bot-title small { color: var(--pine-soft); font-size: .8rem; }
.assistant-tabs { display: flex; gap: 4px; padding: 0 12px; border-bottom: 1px solid var(--line); }
.assistant-tab { padding: 8px 12px; border: 0; border-bottom: 2px solid transparent; background: transparent; color: var(--pine-soft); font: inherit; font-weight: 600; cursor: pointer; }
.assistant-tab[aria-selected="true"] { border-color: var(--accent); color: var(--ink); }

.assistant-transcript { flex: 1; min-height: 0; padding: 12px 16px; overflow-y: auto; overscroll-behavior: contain; }
.assistant-msg { margin: 0 0 14px; }
.assistant-msg.user { display: flex; justify-content: flex-end; }
.assistant-bubble { max-width: 82%; padding: 8px 12px; border-radius: 14px; background: var(--bubble-user); white-space: pre-wrap; overflow-wrap: anywhere; }
.assistant-msg.system { color: var(--pine-soft); font-size: .85rem; text-align: center; }
.assistant-thinking, .assistant-tool { margin: 0 0 6px; color: var(--pine-soft); font-size: .85rem; }
.assistant-thinking pre, .assistant-tool pre { max-height: 240px; margin: 6px 0 0; padding: 8px; overflow: auto; overscroll-behavior: contain auto; border-radius: 8px;
  background: var(--bubble-ai); font: 12px/1.6 var(--mono); white-space: pre-wrap; }
.assistant-working { margin: 0; color: var(--pine-soft); }
.assistant-chip { display: inline-flex; align-items: center; gap: 4px; margin: 4px 4px 0 0; padding: 2px 8px; border: 1px solid var(--line); border-radius: 999px; font-size: .78rem; }
.assistant-chip-remove { border: 0; background: transparent; color: inherit; cursor: pointer; }

.assistant-ask { margin: 0 0 14px; padding: 12px; border: 1px solid var(--warn); border-radius: 12px; background: var(--milk); }
.assistant-ask h3 { margin: 0 0 8px; font-size: .95rem; }
.assistant-ask p { margin: 0 0 8px; }
.assistant-ask-command { margin: 0 0 8px; padding: 8px; overflow-x: auto; overscroll-behavior: contain auto; border-radius: 8px; background: var(--bubble-ai); font: 12px/1.6 var(--mono); }
.assistant-ask-actions, .assistant-ask-choices { display: flex; flex-wrap: wrap; gap: 8px; }
.assistant-choice { padding: 6px 12px; border: 1px solid var(--line); border-radius: 999px; background: transparent; color: inherit; font: inherit; cursor: pointer; }
.assistant-choice[aria-pressed="true"] { border-color: var(--accent); background: var(--bubble-user); }
.assistant-ask-question { margin: 0 0 10px; }
.assistant-ask-secret { display: grid; gap: 8px; }
.assistant-ask-closed { margin: 0 0 14px; color: var(--pine-soft); font-size: .85rem; text-align: center; }

.assistant-composer { padding: 8px 12px calc(8px + env(safe-area-inset-bottom, 0px)); border-top: 1px solid var(--line); background: var(--paper); }
.assistant-composer-row { display: flex; align-items: flex-end; gap: 8px; }
.assistant-input { flex: 1; min-height: 40px; max-height: 180px; padding: 9px 12px; resize: none; border: 1px solid var(--line); border-radius: 14px;
  background: var(--milk); color: var(--ink); font: inherit; font-size: 16px; }
.assistant-attach { min-width: 40px; font-size: 1.2rem; }
.assistant-hint { margin: 0 0 6px; color: var(--warn); font-size: .8rem; }
.assistant-sessions { padding: 12px 16px 32px; overflow-y: auto; }
.assistant-session-row { display: flex; align-items: center; gap: 4px; border-bottom: 1px solid var(--line); }
.assistant-session-row .assistant-session-open { flex: 1; display: block; border-bottom: 0; }
.assistant-session-row.unread strong::after { content: " •"; color: var(--accent); }
.assistant-session-actions { display: flex; gap: 2px; }
.assistant-danger { color: var(--err); }
.assistant-toast { position: fixed; left: 50%; bottom: calc(80px + env(safe-area-inset-bottom, 0px)); z-index: 20; max-width: 90vw; margin: 0; padding: 8px 14px;
  transform: translateX(-50%); border-radius: 10px; background: var(--ink); color: var(--paper); font-size: .85rem; }
```

- [ ] **Step 4: `public/assistant.html`**

```html
<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover,interactive-widget=resizes-content">
<meta name="color-scheme" content="light dark"><title>Stepsemble · Assistant</title>
<link rel="icon" href="/icon-32.png?v=3.8.62"><link rel="manifest" href="/manifest.webmanifest?v=3.8.62">
<link rel="stylesheet" href="/style.css?v=3.8.62"><link rel="stylesheet" href="/modules/assistant.css?v=3.8.62"></head>
<body class="assistant-page">
<header class="assistant-top">
  <nav class="assistant-switch"><a href="/workspace.html" data-assistant-i18n="workspace">Workspace</a><span aria-current="page" data-assistant-i18n="assistant">Assistant</span></nav>
  <select id="assistant-machine" class="assistant-machine" hidden></select>
</header>
<main id="assistant-main" class="assistant-main"></main>
<script src="/vendor/marked.min.js"></script><script src="/vendor/purify.min.js"></script>
<script src="/modules/workspace-i18n.js?v=3.8.62"></script><script src="/modules/assistant-i18n.js?v=3.8.62"></script>
<script src="/modules/assistant-model.js?v=3.8.62"></script><script src="/modules/assistant-api.js?v=3.8.62"></script>
<script src="/modules/assistant.js?v=3.8.62"></script>
</body></html>
```

- [ ] **Step 5: 登入後回到助理頁**

`public/app.js` 的 `function workspaceDestination() {` 第一行之後加入：

```js
  // The assistant page sends people here to sign in and expects them back.
  if (PAGE_QUERY.get("assistant") === "1") {
    const assistant = new URL("/assistant.html", location.origin);
    for (const key of ["bot", "session"]) {
      const value = PAGE_QUERY.get(key);
      if (value && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(value)) assistant.searchParams.set(key, value);
    }
    return assistant.href;
  }
```

- [ ] **Step 6: 語法檢查**

Run: `node --check public/modules/assistant-api.js && node --check public/modules/assistant.js && node --check public/app.js`
Expected: 無輸出

- [ ] **Step 7: Commit**

```bash
git add public/assistant.html public/modules/assistant-api.js public/modules/assistant.js public/modules/assistant.css public/app.js
git commit -m "Add the assistant page for Hermes Bots"
```

---

### Task 5: 工作區的「工作區｜助理」切換

**Files:**
- Modify: `public/workspace.html`（`</header>` 品牌列之後）
- Modify: `public/modules/workspace.js`（`boot()` 內 `await refresh(); render(); void refreshUsage();` 之後）
- Modify: `public/modules/workspace.css`（結尾）

- [ ] **Step 1: HTML**

在 `public/workspace.html` 的 `<header class="workspace-brand-row">…</header>` 之後加入：

```html
  <nav id="workspace-mode" class="workspace-mode" hidden><span aria-current="page" data-workspace-i18n="workspace">Workspace</span><a href="/assistant.html" data-workspace-i18n="assistant">Assistant</a></nav>
```

- [ ] **Step 2: 只有某台電腦有 Hermes 才顯示**

在 `workspace.js` 的 `await refresh(); render(); void refreshUsage();` 那行之後加入 `void checkAssistant();`，並在 `async function boot()` 之前加入：

```js
  // The assistant switch appears once any computer here runs Hermes. Older
  // Hosts without the route simply answer 404 and are skipped.
  async function checkAssistant() {
    for (const machine of machines) {
      try {
        if ((await api("/api/assistant/status", undefined, machine.id))?.installed === true) { $("workspace-mode").hidden = false; return; }
      } catch {}
    }
  }
```

- [ ] **Step 3: 樣式**（附加到 `public/modules/workspace.css` 結尾）

```css
/* Workspace | Assistant: shown only when a computer here runs Hermes. */
.workspace-mode { display: flex; margin: 0 12px 8px; padding: 3px; border: .5px solid var(--line); border-radius: 10px; background: var(--milk); }
.workspace-mode[hidden] { display: none; }
.workspace-mode > * { flex: 1; padding: 5px 0; border-radius: 7px; color: var(--pine-soft); font-size: .82rem; font-weight: 600; text-align: center; text-decoration: none; }
.workspace-mode [aria-current="page"] { background: var(--bubble-user); color: var(--ink); }
```

- [ ] **Step 4: 語法檢查與既有測試**

Run: `node --check public/modules/workspace.js && node --test test/workspace-i18n.test.js`
Expected: pass

- [ ] **Step 5: Commit**

```bash
git add public/workspace.html public/modules/workspace.js public/modules/workspace.css
git commit -m "Switch between the Workspace and the assistant"
```

---

### Task 6: 版本號與檢查腳本

**Files:**
- Modify: `scripts/version.mjs`
- Modify: `package.json`（`check:assistant`）

- [ ] **Step 1: version.mjs 納入 assistant.html**

在 `TEXT_FILES` 加入 `"public/assistant.html",`；在 `currentVersionValues` 的 history 那行之後加入：

```js
  addMatches("public/assistant.html", /[?&]v=(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/g, "assistant asset query");
```

在 `replaceTextVersions` 的 history 那行之後加入：

```js
  if (file === "public/assistant.html") text = text.replace(/([?&]v=)\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/g, `$1${version}`);
```

- [ ] **Step 2: check:assistant 納入新的前端檔**

把 `check:assistant` 結尾的 `&& node --check public/sw.js` 改成：

```
&& node --check public/sw.js && node --check public/modules/assistant-model.js && node --check public/modules/assistant-i18n.js && node --check public/modules/assistant-api.js && node --check public/modules/assistant.js && node --check scripts/assistant-preview.mjs && node --check scripts/assistant-browser-cases.mjs
```

（`scripts/assistant-*.mjs` 在 Task 7 建立；本步驟與 Task 7 一起提交。）

- [ ] **Step 3: 確認**

Run: `npm run version:check`
Expected: `Stepsemble version sources are synchronized at 3.8.62`

---

### Task 7: 瀏覽器測試（假 Hermes + 真的 server.js）

**Files:**
- Create: `scripts/assistant-preview.mjs`
- Create: `scripts/assistant-browser-cases.mjs`
- Modify: `scripts/rolling-browser-worker.mjs`（`workspace` 套件）

- [ ] **Step 1: 預覽 Host**

```js
// A disposable Host wired to a fake Hermes: no model, account or real Hermes
// is touched. Used by the assistant browser cases.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { cleanEnvironment } from "./check-rolling-clients.mjs";
import { freePort, waitForServer, stopServer } from "./host-performance-baseline.mjs";

const require = createRequire(import.meta.url);
const { createFakeHermesGateway } = require("../test-support/fake-hermes-gateway.cjs");
const root = fileURLToPath(new URL("../", import.meta.url));

export async function createAssistantPreview() {
  const fake = createFakeHermesGateway();
  await fake.start();
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "stepsemble-assistant-preview-"));
  const config = path.join(home, ".config/stepsemble"), bin = path.join(home, "bin");
  await fs.mkdir(config, { recursive: true });
  await fs.mkdir(bin);
  const token = "assistant-preview-local-only";
  await fs.writeFile(path.join(config, "token"), token, { mode: 0o600 });
  await fs.writeFile(path.join(bin, "hermes"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const port = await freePort();
  const child = spawn(process.execPath, [path.join(root, "server.js")], { cwd: home, stdio: ["ignore", "pipe", "pipe"],
    env: { ...cleanEnvironment(home), PATH: `${bin}${path.delimiter}/usr/bin${path.delimiter}/bin`, PI_HOME: home, PI_BIN: path.join(home, "missing-pi"),
      STEPSEMBLE_PORT: String(port), STEPSEMBLE_HOST: "127.0.0.1", STEPSEMBLE_ORPHAN_EXIT: "0", STEPSEMBLE_HERMES_URL: fake.url, STEPSEMBLE_HERMES_ACP: "0" } });
  try { await waitForServer(child, 20_000); } catch (error) { await stopServer(child); await fake.close(); await fs.rm(home, { recursive: true, force: true }); throw error; }
  return {
    origin: `http://127.0.0.1:${port}`, token, fake,
    async close() { await stopServer(child); await fake.close(); await fs.rm(home, { recursive: true, force: true }); },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const preview = await createAssistantPreview();
  console.log(JSON.stringify({ origin: preview.origin, token: preview.token }));
  for (const signal of ["SIGTERM", "SIGINT"]) process.once(signal, async () => { await preview.close(); process.exit(0); });
}
```

若 `waitForServer(child, timeout)` 的回傳或判斷條件與此不同，以 `scripts/host-performance-baseline.mjs` 的實際簽名為準（它以子程序輸出 ` listening on ` 判定）。

- [ ] **Step 2: 瀏覽器測試**

```js
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { createAssistantPreview } from "./assistant-preview.mjs";

// The assistant page end to end against a fake Hermes: Stepsemble sign-in
// round trip, Hermes sign-in, roster, a streamed Bot Chat reply, an approval,
// a sudo question whose value never reaches the page, and older Telegram
// conversations. Phone and desktop widths.
export async function runAssistantBrowserCases(browser, { screenshots } = {}) {
  for (const viewport of [{ width: 393, height: 852 }, { width: 1440, height: 900 }]) {
    const preview = await createAssistantPreview();
    let context, stage = "open";
    try {
      context = await browser.newContext({ viewport, serviceWorkers: "block", locale: "en-US", reducedMotion: "reduce" });
      await context.addInitScript(() => {
        localStorage.setItem("stepsemble.onboarding.v1", "complete");
        localStorage.setItem("stepsemble.settings.v2", JSON.stringify({ locale: "en", theme: "dark", reducedMotion: true }));
      });
      const page = await context.newPage();
      page.setDefaultTimeout(15_000);
      const errors = [];
      page.on("pageerror", error => errors.push(error.message));
      const shot = async name => { if (screenshots) { await fs.mkdir(screenshots, { recursive: true }); await page.screenshot({ path: path.join(screenshots, `assistant-${name}-${viewport.width}.png`) }); } };

      stage = "Stepsemble sign-in returns to the assistant";
      await page.goto(preview.origin + "/assistant.html?bot=default");
      await page.waitForURL(/returnWorkspace=1/);
      assert.match(page.url(), /assistant=1/);
      await page.locator("#login-token").fill(preview.token);
      await page.locator("#login-form button").click();
      await page.waitForURL(/\/assistant\.html/);

      stage = "Hermes sign-in";
      await page.getByLabel("Username").fill("jerome");
      await page.getByLabel("Password").fill("wrong");
      await page.getByRole("button", { name: "Sign in" }).click();
      await page.getByText("The username or password is wrong.").waitFor();
      await page.getByLabel("Password").fill("correct horse");
      await page.getByRole("button", { name: "Sign in" }).click();

      stage = "Bot Chat";
      const input = page.getByPlaceholder("Message Luna");
      await input.waitFor();
      await input.fill("plan my day");
      await page.getByRole("button", { name: "Send" }).click();
      await page.locator(".assistant-msg.assistant", { hasText: "Echo: plan my day" }).waitFor();
      await shot("chat");

      stage = "roster";
      await page.getByRole("button", { name: "Back" }).click();
      await page.locator(".assistant-bot-row", { hasText: "Luna" }).waitFor();
      assert.equal(await page.locator(".assistant-bot-row", { hasText: "QA Reviewer" }).count(), 1);
      assert.equal(await page.locator(".assistant-bot-row", { hasText: "Image Artist" }).count(), 0, "hidden Bots stay hidden");
      await shot("roster");
      await page.locator(".assistant-bot-row", { hasText: "Luna" }).click();

      stage = "approval";
      preview.fake.setTurn({ reply: "Cleaned.", request: { method: "approval",
        params: { request_id: "a1", command: "rm -rf build", description: "Delete the build folder", choices: ["once", "deny"] } } });
      await input.fill("clean up");
      await page.getByRole("button", { name: "Send" }).click();
      await page.getByRole("button", { name: "Allow once" }).click();
      await page.locator(".assistant-msg.assistant", { hasText: "Cleaned." }).waitFor();
      assert.deepEqual(preview.fake.state.answers.at(-1).response.result, { choice: "once" });

      stage = "sudo";
      preview.fake.setTurn({ reply: "Listed.", request: { method: "sudo", params: { command: "sudo ls /root" } } });
      await input.fill("list root");
      await page.getByRole("button", { name: "Send" }).click();
      await page.getByPlaceholder("Hidden as you type").fill("hunter2-browser");
      await page.locator(".assistant-ask-sudo").getByRole("button", { name: "Send answer" }).click();
      await page.locator(".assistant-msg.assistant", { hasText: "Listed." }).waitFor();
      assert.deepEqual(preview.fake.state.answers.at(-1).response.result, { value: "hunter2-browser" });
      assert.equal((await page.content()).includes("hunter2-browser"), false, "the sudo password never stays in the page");

      stage = "other conversations";
      const telegram = preview.fake.addSession("default", "Groceries", { source: "telegram" });
      telegram.messages.push({ role: "user", text: "buy milk" });
      await page.getByRole("tab", { name: "Other conversations" }).click();
      const row = page.locator(".assistant-session-row", { hasText: "Groceries" });
      await row.waitFor();
      assert.match(await row.textContent(), /Telegram/);
      await row.locator(".assistant-session-open").click();
      await page.locator(".assistant-msg.user", { hasText: "buy milk" }).waitFor();
      await shot("other");

      stage = "Workspace switch";
      await page.goto(preview.origin + "/workspace.html");
      await page.locator("#workspace-mode:not([hidden])").waitFor({ state: "attached" });
      assert.equal(await page.locator("#workspace-mode a").getAttribute("href"), "/assistant.html");
      assert.deepEqual(errors, []);
    } catch (error) {
      error.message = `assistant ${viewport.width} at ${stage}: ${error.message}`;
      throw error;
    } finally {
      await context?.close();
      await preview.close();
    }
  }
}
```

- [ ] **Step 3: 接進 Rolling 的 workspace 套件**

`scripts/rolling-browser-worker.mjs`：在 import 區加入 `import { runAssistantBrowserCases } from "./assistant-browser-cases.mjs";`，並在 `else if (suite === "workspace") {` 區塊的 `await runUsageBrowserCases(browser);` 之後加入 `await runAssistantBrowserCases(browser);`。

- [ ] **Step 4: 本機執行**

用隔離安裝的 Playwright 1.63（與 Rolling 相同版本）在暫存目錄執行：

```bash
node -e '
const path = require("path");
(async () => {
  const runtime = process.env.PLAYWRIGHT_RUNTIME;
  const { chromium } = await import(path.join(runtime, "node_modules/playwright/index.mjs"));
  const { runAssistantBrowserCases } = await import(path.resolve("scripts/assistant-browser-cases.mjs"));
  const browser = await chromium.launch({ headless: true });
  try { await runAssistantBrowserCases(browser); console.log("ASSISTANT BROWSER CASES: PASS"); }
  finally { await browser.close(); }
})().catch(error => { console.error(error); process.exit(1); });
'
```

Expected: `ASSISTANT BROWSER CASES: PASS`

- [ ] **Step 5: Commit**

```bash
git add scripts/assistant-preview.mjs scripts/assistant-browser-cases.mjs scripts/rolling-browser-worker.mjs scripts/version.mjs package.json
git commit -m "Test the assistant page in a browser against a fake Hermes"
```

---

### Task 8: 文件與完整驗證

**Files:**
- Create: `docs/hermes-assistant.md`
- Modify: `docs/agent-capability-matrix.md`（Hermes 那一列）

- [ ] **Step 1: `docs/hermes-assistant.md`**

```markdown
# Hermes 助理

Stepsemble 的「助理」頁是 Hermes Agent Bot Mode 的手機優先客戶端。它連到同一台電腦上
Hermes 已在執行的網頁伺服器，讓你在手機或桌面跟每個 Bot 的永久對話（Bot Chat）聊天、
回答 Hermes 的提問，並查看 Telegram、例行工作等其他來源的對話。

## 使用

- 只要已配對的任一台電腦裝了 Hermes，工作區頂部就會出現「工作區｜助理」切換。
- 第一次打開時，輸入那台電腦 Hermes 網頁控制台的帳號和密碼。
- 有多台裝 Hermes 時，右上角可以選擇要用哪一台；選擇記在這個瀏覽器。
- Bot 需要你核准、回答問題或輸入 sudo／secret 時，卡片直接出現在對話裡，手機會收到推播。
  回覆完成時，如果沒有任何畫面正在看那個對話，也會推播。

## 架構與安全

- 伺服器端模組：`server/hermes-discovery.js`、`hermes-session-store.js`、`hermes-gateway-client.js`、
  `hermes-assistant-service.js`、`hermes-assistant-routes.js`；路由為 `/api/assistant/*`。
- 只連本機自己的位址（`STEPSEMBLE_HERMES_URL`、`127.0.0.1:9119`、本機各網路位址的 `:9119`），
  不讀取 `~/.hermes` 的任何檔案。
- 只保存 Hermes 的登入 cookie（`~/.config/stepsemble/hermes-session.json`，權限 600），不保存密碼。
  sudo 與 secret 的答案只轉交 Hermes，不寫檔、不進 log、不進事件緩衝。
- Hermes 的 approval／clarify／sudo／secret 是伺服器對客戶端的請求；Stepsemble 連線後宣告
  `client.capabilities {server_requests: true}`，只回答自己打開的對話；不認得的請求立即拒絕，
  不讓 Agent 空等。
- 斷線時自動重連，以 `session.resume` 與 `session.events.since` 接回並補上漏掉的事件。

## 相容性

基準為 Hermes 0.21.6。這套 WebSocket JSON-RPC 是 Hermes 給自家桌面版用的協定，Hermes 升級時
可能改變；測試以 `test-support/fake-hermes-gateway.cjs` 模擬 0.21.6 的行為。
```

- [ ] **Step 2: 能力矩陣**

在 `docs/agent-capability-matrix.md` 的 Hermes Agent 那一列，把描述欄最後補上：
「Stepsemble 3.9 起，Hermes 改由「助理」頁使用 Bot Mode（`/api/assistant/*`，見 `docs/hermes-assistant.md`），不再出現在新增對話；既有 ACP 對話仍可打開。」

- [ ] **Step 3: 完整驗證**

Run: `npm run check && npm test && npm run version:check`
Expected: 全部 exit 0，`npm test` 0 fail

- [ ] **Step 4: Commit**

```bash
git add docs/hermes-assistant.md docs/agent-capability-matrix.md
git commit -m "Document the Hermes assistant"
```

---

## Self-review

- 規格 5.1：入口切換（Task 5）、自動連到有 Hermes 的電腦與多台選擇（Task 1、4）、登入卡與錯誤原因（Task 4）、Bot 名單含最新訊息與待處理數（Task 4）、Bot Chat 串流／思考／工具／附件／中斷（Task 1、4）、提問卡片（Task 4、7）、其他對話含來源與搜尋、改名、刪除（Task 4、7）、推播點擊（1a + Task 4 的 `STEPSEMBLE_OPEN_ASSISTANT`）、從新增對話移除 Hermes（Task 3）。
- 依 1a 的調整：模型只顯示；頭像用首字與 Bot Mode 顏色。
- 安全：sudo 值送出後立即清空欄位，瀏覽器測試確認頁面內容不含該值。
