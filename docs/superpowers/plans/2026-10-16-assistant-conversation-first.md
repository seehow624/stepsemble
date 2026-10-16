# Assistant A 方案 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 落實已確認的 A 方案：對話優先的 Bot 首頁、歷史面板與對話頁；修正寬內容和手機返回層級。

**Architecture:** 保留既有 Hermes API，只補唯讀標題與原始分頁游標。抽出純路由／瀏覽器歷史控制器、Markdown 內容增強與歷史面板。`assistant.js` 負責組裝、串流、草稿與請求生命週期。歷史面板與更多選單共用焦點管理，所有返回操作由路由控制。

**Tech Stack:** 現有原生 JavaScript、CSS、marked、DOMPurify、Node `node:test`、Playwright 1.63.0、fake Hermes；不新增正式執行依賴。

**Spec:** `docs/superpowers/specs/2026-10-16-assistant-conversation-first-design.md`。使用者已在對話確認規格；開發階段於同一個 session 依序實作，不委派 Agent、不自動發布或提交。

**發布授權：** 2026-10-16，使用者在實作與測試完成後明確要求「提交合并发布吧」；整合 master 的 Pi 修正並準備 3.9.6。下列驗證紀錄為發布前的實作快照，實際發布結果以 GitHub 的版本標籤與 Release 工作流程為準。

---

## 檔案與責任

| 檔案 | 工作 |
|---|---|
| `public/modules/assistant-navigation.js` | 新增 UMD 純路由函式及瀏覽器歷史控制器 |
| `test/assistant-navigation.test.js` | 路由、父層、深連結、重載、前進返回測試 |
| `public/modules/assistant-content.js` | 新增安全 Markdown 與受限寬度的表格／程式碼 |
| `public/modules/assistant-model.js`、`test/assistant-history-model.test.js` | 連續歷史工具合併 |
| `server/hermes-assistant-service.js`、`test/hermes-assistant-title.test.js` | 重載歷史的唯讀標題與原始分頁游標 |
| `public/app.js`、`test/assistant-signin-return.test.js` | 登入返回保留經驗證的機器、面板與次頁識別 |
| `public/modules/assistant-history.js` | 新增搜尋、分頁、日期分組、列操作、狀態保存 |
| `public/modules/assistant.js` | 接路由、面板、首頁、對話、次頁與串流生命週期 |
| `public/modules/assistant.css` | A 方案響應式、局部捲動與 44px 操作區 |
| `public/modules/assistant-guide.js`、`assistant-i18n.js` | 更新新入口教學及 11 語系 |
| `public/assistant.html`、`package.json` | 模組載入與語法檢查 |
| `scripts/assistant-browser-cases.mjs` | 舊功能改由新入口操作，不刪測試範圍 |
| `scripts/assistant-mobile-browser-cases.mjs` | 新增寬內容、原生歷史 API、面板、草稿與競態回歸 |
| `scripts/rolling-browser-worker.mjs` | 新回歸納入現有 workspace 套件 |
| `docs/hermes-assistant.md` | 更新操作方式與驗證限制 |

### Task 1：先保留失敗的重現

- [x] 新增手機回歸檔，沿用 `createAssistantPreview({hermes:{authRequired:false}})` 與 API token 登入測試 Host；跳過首次導覽只用測試 localStorage。
- [x] 建立來源是 Telegram 的假歷史：中文問題、7 筆連續工具與含 12 欄表格／長網址／程式碼／圖片的回答。

```js
const columns = Array.from({ length: 12 }, (_, index) => `欄位${index + 1}`);
const table = `|${columns.join("|")}|\n|${columns.map(() => "---").join("|")}|\n|${columns.map(() => "比較內容".repeat(12)).join("|")}|`;
const session = preview.fake.addSession("default", "理解 MHz 數字代表什麼", { source: "telegram" });
session.messages.push({ role: "user", text: "這個東西可以怎麼幫我？" },
  ...Array.from({ length: 7 }, (_, index) => ({ role: "tool", name: `tool-${index}`, context: `步驟 ${index}` })),
  { role: "assistant", text: table + "\n\n表格後面的文字仍然必須完整可讀。" });
```

- [x] 對既有入口使用 `?bot=default&session=<id>`；量測真實幾何，記錄失敗，而不是只檢查有沒有 `overflow-x:hidden`。

```js
const layout = await page.locator(".assistant-transcript").evaluate(node => {
  node.scrollLeft = 100;
  return { width: node.clientWidth, scrollWidth: node.scrollWidth, left: node.scrollLeft };
});
assert.ok(layout.scrollWidth <= layout.width + 1);
assert.equal(layout.left, 0);
```

- [x] 另測 Workspace → Assistant → Bot，`page.goBack()` 後仍為 `/assistant.html` 首頁；舊版預期失敗。
- [x] 跑單一新測試，確認失敗點分別為內容溢出及返回 Workspace，保留測試。

### Task 2：寬內容與工具分組

- [x] 新增內容模組，API 為 `StepsembleAssistantContent.create({ document, marked, purify }) → { markdown(text) }`。
- [x] `markdown()` 先用 marked 解析、DOMPurify 清理；未提供庫則 `textContent`；連結設 `target=_blank`、`rel=noopener noreferrer`。
- [x] 每個表格採用既有主 App 相同包裝，不引入另一套表格色彩：

```js
for (const table of box.querySelectorAll("table")) {
  const frame = document.createElement("div");
  frame.className = "md-table";
  const scroll = document.createElement("div");
  scroll.className = "md-table-scroll";
  scroll.tabIndex = 0;
  table.replaceWith(frame);
  frame.append(scroll);
  scroll.append(table);
  for (const cell of table.querySelectorAll("th, td")) {
    const content = document.createElement("div");
    content.className = "md-cell";
    content.append(...cell.childNodes);
    cell.append(content);
  }
}
```

- [x] 補對話／回覆／圖片的 `min-width:0`、`max-width:100%` 與文字換行，表格和 `pre` 自己承擔橫向捲動。
- [x] `fromHistory()` 把連續工具紀錄合併到一個工具區塊；後面真的回答保留獨立文字順序。測試精確核對全部工具資料仍存在：

```js
const items = M.fromHistory([
  { role: "user", text: "問題" },
  { role: "tool", name: "search", context: "one" },
  { role: "tool", name: "extract", context: "two" },
  { role: "assistant", text: "回答" },
]);
assert.equal(items.filter(row => row.tools.length).length, 1);
assert.deepEqual(items.flatMap(row => row.tools).map(row => row.name), ["search", "extract"]);
assert.deepEqual(items.filter(row => row.text).map(row => row.text), ["問題", "回答"]);
```

- [x] 工具 UI 使用一個 `details` 摘要；執行中與完成分開表達，詳細紀錄仍可展開，核准卡不放進工具摘要。
- [x] 回跑工具單元與溢出案例；證明表格可橫滑但父層 `scrollLeft` 維持 0。

### Task 3：統一返回路由

- [x] 新增 `assistant-navigation.js`，匯出 `normalize`、`fromUrl`、`toUrl`、`ancestors` 與 `create`。
- [x] 路由只保存 `{page,profile,session,room,panel,machine}`；頁面為 `home,bot,group,settings,routines,bots,newbot,newgroup,pending,console`；Bot 面板為 `history,menu`。
- [x] 網址保留 `bot`／`session`，新增 `room`／`panel`；次頁沿用 `view`；非法組合回安全首頁。state 加版本、根識別與深度，絕不放內容或附件。
- [x] 明確的父層斷言：

```js
assert.deepEqual(N.ancestors({ page: "bot", profile: "default", session: "st-1", panel: "history" }).map(row => row.page), ["home", "bot", "bot"]);
assert.deepEqual(N.ancestors({ page: "settings", profile: "default" }).map(row => row.page), ["home", "bot", "settings"]);
assert.deepEqual(N.ancestors({ page: "console" }).map(row => row.page), ["console"]);
```

- [x] 控制器接受注入的 window，介面 `initialize()`、`go(route)`、`back()`、`current`、`destroy()`。
- [x] 首次外部深連結：replace 為祖先根，再 push 需要的祖先；只對最終路由發通知。相同 state 的重載直接還原，不重建。
- [x] 主動導航重建目前根上的目標鏈：若深度大於零，保存最新目標並 `history.go(-depth)`，在 popstate 到根後建目標鏈；不顯示中間首頁。
  這也適用於從歷史選另一個 session，使新對話維持深度 1、刪掉舊面板的前進分支。等待 popstate 時再次點擊只更新目標，不重複 go。
- [x] 瀏覽器 Back／Forward 直接解析 state 還原；`back()` 在 Assistant 根才允許返回外部，不用全頁觸控攔截。
- [x] 測試深連結、重載不增長、面板返回、歷史替換、快速導航與 console 獨立根。

### Task 4：歷史面板

- [x] 新增 `assistant-history.js`，介面 `create({api,t,el,button,M,locale,showPanel,onSelect}) → {open(profile,botName),close()}`。
- [x] 每個 profile 以 Map 保留 `{query,rows,hasMore,scrollTop}`；請求編號與 profile 驗證過期結果，搜尋 250ms debounce，分頁沿用 API offset。
- [x] 面板標題、搜尋、依日期分組的列；每列標題／短預覽／來源／時間，更多操作再展開重新命名與二段確認刪除。
- [x] 面板必有關閉按鈕，錯誤列附 retry，空結果和 loading 不混用；重新命名與刪除完成才更新記憶體資料。
- [x] `showPanel()` 由主頁集中提供：建立 role=dialog、aria-modal 與標題；暫時 inert 背景、管理 Tab/Escape／關閉後焦點；點背景等同路由返回。
- [x] 選取只通知 `onSelect(profile,row)`，由路由控制器開同層 Bot 對話，不讓歷史模組自行操作 window history。
- [x] 瀏覽器驗證搜尋、分頁、重開捲動、rename、delete 及舊請求不能覆蓋新面板。

### Task 5：A 首頁與對話整合

- [x] 在 `assistant.js` 建立路由呈現器，以遞增的 revision 防止舊 API 回覆畫回錯誤 Bot；每次渲染前保存草稿及列表捲動。
- [x] Bot 與歷史切換不取消 Hermes 工作。草稿和附件用記憶體 Map 保存；在 key 加上 machine/profile/session，避免跨機混用。
- [x] 當面板關閉／開啟、設定返回時底層仍是同一個對話，不重建 transcript 或清空輸入。重新連線呼叫目前路由重讀，不 push 新歷史。
- [x] 首頁：小型全域切換、助理標題＋所選電腦、搜尋、Bot 列表、群組、所有例行工作／管理入口。未讀、待回覆使用實際資料。
- [x] 對話頁：`返回助理`、頭像／名稱／目前對話標題、`歷史`、`更多選項`；刪除四個 tab 的畫面，原功能轉入更多選單。
- [x] 設定／例行工作使用可返回的次頁，管理 Bot 可開設定和顯示隱藏 Bot；新建、刪除、群組照原 API，確認步驟不可省。
- [x] 使用 A 的列表和閱讀字級，手機觸控區至少 44px；桌面仍雙欄；大字、橫向、短視窗與鍵盤不裁掉操作。
- [x] 所有路徑（推播、重載、群組、既有 session 深連結、console、登入導覽）接同一套呈現器。

### Task 6：多語、導覽與現有端到端案例

- [x] 新字串補齊 11 語系；新入口的歷史、更多、返回、搜尋與工具摘要使用正式翻譯。
- [x] 修正四張介紹卡中「旁邊分頁」舊說法與分頁示意，改為歷史按鈕、更多選單位置；不改帳密設定邏輯。
- [x] 原瀏覽器案例改用新入口，不移除 approval／sudo／routines／skills／group／console 的原有驗證。
- [x] 新手機案例納入 `rolling-browser-worker.mjs` workspace 套件；兩個瀏覽器案例皆支援獨立 runner 和既有 Playwright runtime。
- [x] 腳本載入、版本查核、`check:assistant` 加入新增檔案；當前版本號保持不變。

### Task 7：驗收與交付

- [x] 每個修正先確認測試會在舊版失敗，再在新版通過。
- [x] 320／393／414px、手機橫向、1440px，深淺主題、繁中／英文／長字串與 150% 字級；截圖加實際幾何斷言。
- [x] `npm run check && npm run version:check && npm run check:client`。
- [x] 隔離 HOME 執行完整 `npm test`；失敗保存錯誤，不用先前判斷代替本輪結果。
- [x] 在本機磁碟的測試副本跑 `npm run test:rolling`，保留真實 exit code，不以最後一個 echo 覆蓋結果。
- [x] 補操作文件與本輪測試證據，提供新版預覽。清楚說明 iPhone 原生左緣滑動仍需實機確認。
- [x] 不做版本升級、git push、tag、發布或刪 worktree；等待使用者後續明確授權。

## 驗證紀錄（2026-10-16，Jerome-MacbookPro）

- `check`、`version:check`、`check:client`：最終程式 exit 0，版本仍保持分支原有的 3.9.4，未執行升版。
- 隔離 HOME 的完整單元測試：2,315 項，2,310 通過、0 失敗、5 項 Windows 專用測試略過。
- 助理原有功能案例：393px 手機與 1440px 桌面通過，保留登入、導覽、串流、核准、sudo、例行工作、群組、Bot／技能與控制台驗證。
- 新手機回歸：10 組通過；包括歷史錯誤與重試、過期搜尋、分頁去重、面板焦點、草稿／附件、群組草稿、快速切換與首次介紹。
- 額外捕獲並修正：CSS 蓋過 `hidden`、320px／150% 字級擠掉 Bot 名稱、對話歷史按鈕誤用例行工作「執行紀錄」文案。
- 真程式的私網假資料預覽：393px 與 1440px 已實際操作列表、對話、歷史搜尋及返回，並目視截圖；代理只允許助理所需入口，不連正式 Host 或 Hermes。
- Rolling：最終程式完整關卡 exit 0，core／workspace 均通過，包含 8 組舊版 Client／Host 相容案例、既有工作區功能及新助理回歸；本機副本的 22 個程式／測試檔與工作樹逐檔比對一致。
- 證據位於本機 `~/.cache/stepsemble-scratch/`：`assistant-a-final-check.log`、`assistant-a-final-unit.log`、`assistant-a-final-browser.log`、`assistant-a-final-rolling.log`、`assistant-a-shots/`。
- 限制：未做真 Hermes 互動、未送真模型請求；未驗證 WebKit、實體 iPhone 或主畫面 App 的原生邊緣手勢。
- 實作階段交付狀態：當時保留開發分支與未提交變更，主工作樹乾淨；收到上述後續發布授權後，另行提交、整合及發布。
