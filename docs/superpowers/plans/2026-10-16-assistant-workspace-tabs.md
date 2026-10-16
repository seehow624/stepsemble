# Assistant Workspace 分頁（B 方案）實作計畫

規格：`docs/superpowers/specs/2026-10-16-assistant-workspace-tabs-design.md`

每一步先寫會失敗的測試、確認失敗原因正確，再寫最少的程式讓它通過。全部使用假 Hermes，不呼叫模型。

## 任務

1. 版面參照（`public/modules/workspace-layout.js`，`test/workspace-layout.test.js`）
   - `reference()` 保留並驗證 `assistant` 路由與 `avatar`；不合法的路由整個丟棄，不讓分頁壞掉。
   - 搬移、插入、正規化後仍保留 `assistant`。

2. 框架標頭（`server.js`，`test/` 既有的靜態檔案標頭測試）
   - 只有 `assistant.html?embed=1` 可同源嵌入；`assistant.html` 本身仍 `DENY`。

3. 記憶體歷史（`public/modules/assistant-navigation.js`，`test/assistant-navigation.test.js`）
   - `memoryWindow(url)` 提供 `history.pushState/replaceState/go/back/state/length`、`location.href` 與 popstate；
     `create({ window: memoryWindow(...) })` 的返回與歷史面板行為和真瀏覽器相同。

4. 側欄模型（新檔 `public/modules/workspace-assistant-model.js`，`test/workspace-assistant-model.test.js`）
   - 路由的「主題」（bot:<profile>、group:<room>、page:<page>）與分頁去重。
   - 分頁標題與頭像描述；建立分頁參照；從分頁參照產生框架網址。

5. 嵌入模式（`public/modules/assistant.js`、`public/modules/assistant.css`）
   - 隱藏外框、記憶體路由、回報路由、每個框架自己的 client ID、可見狀態、登入過期導向最上層、detach 關閉串流。

6. 助理側欄（新檔 `public/modules/workspace-assistant.js`、`public/workspace.html`、`public/modules/workspace.css`）
   - Hermes 電腦卡片、搜尋、Bot／群組列、等你處理、例行工作／管理／新增按鈕、狀態說明與登入分頁。

7. Workspace 整合（`public/modules/workspace.js`）
   - 桌面切換側欄模式並記住；Bot 分頁的框架、標籤頭像、訊息處理；排除在 session 清理、可見 session、已讀、重新命名之外；
     切到手機寬度時回到工作區模式。

8. 瀏覽器回歸（新檔 `scripts/assistant-workspace-browser-cases.mjs`，加入 `check:assistant` 與 Rolling worker）

9. 文件（`docs/hermes-assistant.md`）與完整檢查：`npm run check`、隔離 HOME 的 `npm test`、瀏覽器回歸、本機 Rolling。
