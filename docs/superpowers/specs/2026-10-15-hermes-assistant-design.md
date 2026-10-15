# Stepsemble 助理（Hermes）設計規格

- 日期：2026-10-15
- 狀態：設計已由使用者核准；實作前請使用者審閱本文件
- 分支：`feature/hermes-assistant`（worktree，master 不動）
- 發布：五個階段全部完成後，一次發布

## 1. 背景與目標

Grok Bot（xAI）與 ChatGPT Dots（OpenAI）把「常駐、可以分工的私人 Bot」做成產品。
Hermes Agent 0.21.6 的 Bot Mode 已經提供同樣的能力：每個 Bot 是一個 profile，有自己的
永久對話（Bot Chat）、模型、記憶、技能、例行工作；同一台機器的 Bot 可以開群組、互相傳訊息。
但這些功能目前只有 Hermes 桌面版有畫面。

使用者的 Mac mini 長期執行 Hermes（Luna 與 7 個製作用 profile），手機目前透過 Telegram
與 Stepwell Local（`com.jerome.hermes-web`）使用。

目標：在 Stepsemble 新增「助理」，成為 Hermes 的手機優先客戶端：

1. 手機上好用的介面，取代用 Telegram 跟 Luna 對話。
2. 在一個地方管理所有 Bot、例行工作、群組與技能。
3. 接手 Stepwell Local 所有與 Hermes 相關的功能。

Hermes 在 Stepsemble 不再是 coding agent，不出現在「新增對話」。

## 2. 決策紀錄

| # | 決策 |
|---|---|
| D1 | 入口是獨立的「助理」分頁：頂部切換「工作區｜助理」 |
| D2 | Stepsemble 為主、Telegram 為備用。例行工作可逐一開關「同時送到 Bot Chat」，不自動改動既有工作 |
| D3 | 群組聊天納入，限同一台機器上的 Bot；跨機器群組不做 |
| D4 | Bot 完整管理（建立、個性、技能／工具／MCP、頭像、模型、隱藏、刪除） |
| D5 | 助理分頁自動連到裝了 Hermes 的機器；只有一台就直接用，多台讓使用者選，沒有就不顯示 |
| D6 | Stepsemble 接手 Stepwell Local 的 Hermes 功能；日曆、Apple 提醒、記帳、個人脈絡、Luna 工作區通道不搬 |
| D7 | 連線方式只用一種：連 Hermes 現有的伺服器並登入一次；找不到伺服器就清楚提示，不自動另開 |
| D8 | Stepsemble 不保存 Hermes 的對話內容；只保存登入狀態（< 1 KB）與少量畫面狀態 |
| D9 | 五個階段依序完成，最後一次發布 |
| D10 | 在獨立 worktree 開發，避免影響同時使用 master 的其他 Agent |

## 3. 範圍

### 3.1 範圍內

依階段列在第 5 節。

### 3.2 範圍外

- 跨機器群組、跨機器 Bot 轉送（Hermes 桌面版自己擔任中繼）。
- 「示範一次變技能」、Bot 專屬信箱等 Hermes 沒有的 Grok Bot 功能。
- Stepwell 的生活功能：日曆、Apple 提醒、記帳、個人脈絡、Luna 寫入工作區的通道、Stepwell Cloud。
- 停用 Stepwell Local。若日後停用，必須先處理 Luna 依賴 Stepwell 的能力（讀日曆與提醒、
  寫任務、記帳 CLI）。
- Hermes OAuth（Nous Portal）登入方式；本版只支援帳號密碼與「免登入的本機伺服器」。
- AI 生成頭像、Bot 名單的自訂分組（sections）、Bot 範本分享。

## 4. 架構

```
手機／瀏覽器
   │  Stepsemble 原本的登入（cookie 或已配對裝置的 bearer）
   ▼
裝了 Hermes 的那台 Stepsemble 伺服器
   ├─ /api/assistant/*（hermes-assistant-routes）
   ├─ hermes-assistant-service ── 推播（web-push）
   └─ hermes-gateway-client ──（Hermes 登入狀態）──▶ 同一台機器的 Hermes 伺服器
                                                    └ Bot、對話、例行工作、技能、群組都存在這裡
```

### 4.1 伺服器端模組

每個模組只做一件事，透過明確的函式介面溝通，可以單獨測試。

| 檔案 | 職責 |
|---|---|
| `server/hermes-discovery.js` | 找到本機 Hermes 伺服器位址並讀取 `/api/status`（版本、是否需要登入、登入方式、`install_id`） |
| `server/hermes-session-store.js` | 保存 Hermes 登入後的 cookie（`~/.config/stepsemble/hermes-session.json`，權限 600）；不保存密碼 |
| `server/hermes-gateway-client.js` | 唯一直接與 Hermes 溝通的地方：REST 請求、登入、領 WebSocket 票、JSON-RPC 請求與事件、心跳、重連 |
| `server/hermes-assistant-service.js` | 助理核心：Bot 名單、確保 Bot Chat、送訊息、事件緩衝、待處理請求、通知觀察 |
| `server/hermes-assistant-state.js` | 少量畫面狀態（已讀位置等），`~/.config/stepsemble/assistant-state.json`，有筆數上限 |
| `server/hermes-routines.js` | 第 2 階段：例行工作 |
| `server/hermes-groups.js` | 第 3 階段：群組 |
| `server/hermes-bots-admin.js` | 第 4 階段：Bot 建立、編輯、刪除 |
| `server/hermes-skills.js` | 第 4 階段：技能與 Skill Hub |
| `server/hermes-console.js` | 第 5 階段：模型、API key、自訂 endpoint、備援、用量、Gateway |
| `server/hermes-assistant-routes.js` | `createHermesAssistantRoutes(deps)` 回傳 `handle(req, res, url)`，沿用 `agent-mode-routes.js` 的模式；`server.js` 只負責接上 |

### 4.2 瀏覽器端模組

| 檔案 | 職責 |
|---|---|
| `public/modules/assistant.js` | 助理分頁：切換、機器選擇、登入卡、Bot 名單、待處理數 |
| `public/modules/assistant-chat.js` | Bot Chat 與其他對話：歷史、串流、互動卡、輸入框 |
| `public/modules/assistant-routines.js` | 第 2 階段 |
| `public/modules/assistant-groups.js` | 第 3 階段 |
| `public/modules/assistant-bots.js` | 第 4 階段：Bot 與技能管理 |
| `public/modules/assistant-i18n.js` | 助理相關字串，沿用 `workspace-i18n.js` 的方式 |
| `public/modules/assistant.css` | 樣式，沿用 Stepsemble 既有的變數與元件 |

Markdown、思考與工具卡片的呈現沿用既有的 `agent-transcript-presentation.js` 等模組，不另寫一套。

### 4.3 找到 Hermes 伺服器

依序嘗試，第一個 `/api/status` 回應正確的就採用：

1. 環境變數 `STEPSEMBLE_HERMES_URL`（只接受本機位址）。
2. `http://127.0.0.1:9119`。
3. 本機自己的每個網路介面位址加上 `:9119`（例如 Tailscale 位址；Mac mini 的 Hermes 綁在
   `100.79.81.95:9119`）。

安全限制：只連本機自己的位址，不接受外部主機，避免被當成跳板（SSRF）。
不讀取 `~/.hermes` 內任何檔案來找位址或憑證。

`hermes` 指令是否存在，沿用既有 connector 偵測（`server/agent-connectors.js`）。

### 4.4 登入

由 `/api/status` 的 `auth_required` 與 `auth_providers` 決定：

- **需要登入且有 `basic`**：使用者在助理分頁輸入 Hermes 帳號密碼一次。Stepsemble 伺服器呼叫
  `POST /auth/password-login`（`{provider: "basic", username, password}`），只保存回傳的 session
  cookie。密碼用完即丟，不寫檔、不進 log。
- **不需要登入（本機伺服器）**：從首頁 HTML 取得 `window.__HERMES_SESSION_TOKEN__`，REST 帶
  `X-Hermes-Session-Token`，WebSocket 帶 `?token=`。實作時以 0.21.6 原始碼確認。
- **只有 OAuth**：顯示「這個 Hermes 只開放 OAuth 登入，Stepsemble 目前不支援」。

WebSocket 不接受 cookie：每次連線先 `POST /api/auth/ws-ticket` 領 30 秒一次性票，
再連 `/api/ws?ticket=<票>`。

限流：Hermes 每分鐘最多 10 次登入。帳密錯誤或被限流時立刻停止，絕不自動重試登入。
領票回 401 時視為登入過期，請使用者重新登入，草稿保留。

### 4.5 連線生命週期

已知 Hermes 行為（Stepwell 與 hermes-swift 實測）：

- 伺服器綁非本機位址時，uvicorn 用 20 秒 ping；Agent 回合卡住 event loop 會被誤判斷線。
- WebSocket 斷線後，記憶體中的 session 約有 20 秒寬限，`session.resume` 可以接回同一個回合。
- `session.create` 回傳 `stored_session_id`（資料庫 key），是斷線後接回的依據。
- 對執行中的 session 再 `prompt.submit` = 中斷目前回合並排隊，不會報錯。

Stepsemble 的做法：

- 有需要才連線：有瀏覽器打開助理分頁、或有回合正在執行時保持連線；閒置 10 分鐘後關閉。
- 每 20 秒送心跳；pong 慢不算斷線。
- 非人為斷線就自動重連，間隔從 0.5 秒逐步拉長到 15 秒；有回合在執行時持續重試（上限 60 秒），
  沒有時重試約 2.5 分鐘後停下，等下一個使用者動作。
- 重連後對每個執行中的對話呼叫 `session.resume`，再用 `session.events.since` 補上漏掉的事件
  （實作時確認此方法的參數與保留期間）。

### 4.6 事件傳到瀏覽器

- `GET /api/assistant/stream`：SSE，沿用 agent task 的 SSE 寫法，支援 `Last-Event-ID` 從游標續傳。
- 伺服器為每個對話保留有上限的事件緩衝（最多 512 筆或 1 MiB，先到先丟），回合結束 5 分鐘後丟棄。
- 打開對話時，歷史從 Hermes 讀取（REST `/api/sessions/{id}` 系列），不從 Stepsemble 讀。

### 4.7 機器路由

- 每台 Stepsemble 的 `GET /api/assistant/status` 回報：`installed`、`reachable`、`version`、
  `auth`（是否需要登入、是否已登入、支援方式）、`capabilities`。
- 瀏覽器載入時查詢所有已配對裝置的狀態：
  - 0 台有 Hermes：不顯示「工作區｜助理」切換。
  - 1 台：自動使用。
  - 多台：在設定中選擇，記在這個瀏覽器的 `localStorage`（`stepsemble.assistant.machine`）。
- 助理 API 一律送到那台機器的 `apiBase`，沿用既有的裝置憑證，與工作區目前選哪台無關。

### 4.8 Stepsemble 保存的資料

| 資料 | 位置 | 大小 |
|---|---|---|
| Hermes 登入 cookie | `~/.config/stepsemble/hermes-session.json`（600） | < 1 KB |
| 已讀位置 | `~/.config/stepsemble/assistant-state.json`（600），最多 500 筆，依 Hermes `install_id` 分開 | 數 KB |
| 進行中的事件 | 記憶體，有上限，見 4.6 | — |
| 草稿、選擇的機器 | 瀏覽器 `localStorage` | — |

Bot、對話、例行工作、技能、群組都只存在 Hermes。

## 5. 階段

每個階段結束時，完整測試與檢查都要通過，並提交到 `feature/hermes-assistant`。

### 第 1 階段：基礎與對話

**連線與入口**

- 4.3～4.7 的全部內容。
- 工作區頂部（手機列表頁與桌面 Workspace）加上「工作區｜助理」切換，只在有 Hermes 時顯示。
- 支援網址直接打開：`?view=assistant`、`?assistant=<bot>`、`?assistant-session=<id>`（推播點擊用）。
- 未登入時顯示登入卡（帳號、密碼、登入失敗原因）；伺服器沒在執行時顯示啟動方法，不自動啟動。

**Bot 名單**

- 來源：JSON-RPC `profiles.list`；名稱、職稱、描述、頭像、隱藏狀態來自 profile 的 `ui_meta`。
- 每列：頭像（上傳的圖片；沒有就用名稱首字與固定配色）、顯示名稱、Bot Chat 最新訊息預覽、
  時間、未讀點、待處理數。
- 依最近活動排序；隱藏的 Bot 不顯示（第 4 階段提供顯示隱藏 Bot 的開關）。
- 名單頂部顯示「待處理 N」，點開列出所有待處理請求。

**Bot Chat**

- 確保永久對話，與 Hermes 桌面版 Bot Mode 行為一致：
  1. `session.list`（`profile`、`title: "Bot Chat"`、`include_hidden: true`）找既有的。
  2. 沒有就 `session.create`（`profile`、`title: "Bot Chat"`、`hidden: true`、
     `follow_profile_config: true`），再立刻 `session.title` 寫入標題，避免重複建立。
- 在 Bot Chat 輸入 `/new` 或 `/reset` 時改送 `/compact`（Bot Mode 的規則：永久對話不分岔）。
- 歷史：Hermes REST 對話訊息；即時：`message.start`／`message.delta`／`message.complete`、
  `thinking.delta`、`tool.start`／`tool.complete`。
- 思考與工具預設收合，正式回覆用 Markdown。
- 輸入框：文字、附件（圖片 `image.attach_bytes`，檔案 `file.attach` 回傳的 `ref_text` 併入訊息）、
  中斷（`session.interrupt`）、模型與思考強度（`model.options`；選擇只套用在這個對話，行為依 Bot Mode）。
- 回合執行中仍可送出；按鈕旁標示「會中斷目前回覆」（Hermes 的排隊語意）。
- 草稿依對話存在 `localStorage`。

**待處理請求**

- `clarify.request`：選項或自由輸入 → `clarify.respond`（`answer`）。
- `approval.request`：只顯示 Hermes 給的選項 → `approval.respond`；絕不自動核准。
- `sudo.request`：密碼欄位遮罩 → `sudo.respond`（`password`）。
- `secret.request`：值欄位遮罩 → `secret.respond`（`value`）。
- 卡片直接出現在對話裡；回覆內容只轉交 Hermes，不寫檔、不進 log、不進事件緩衝。

**其他對話**

- 每個 Bot 頁面有「其他對話」：Telegram、例行工作、網頁、TUI 等來源都列出，附來源標籤。
- 搜尋（Hermes 全文搜尋）、打開續聊（`session.resume`）、改名、刪除（需確認）。

**推播**

- 沿用 Stepsemble 現有的 Web Push 與通知設定。
- 回覆完成：只有在沒有任何畫面正在看那個對話時才推播。瀏覽器透過 SSE 回報目前正在看的對話。
- 需要你回覆（四種請求）：一律推播，標題是 Bot 名稱。
- 回合失敗：推播。
- 點通知直接打開那個對話。

**移除新增對話的 Hermes 選項**

- 「新增對話」不再列出 Hermes（personal 類別）。
- 既有的 Hermes ACP 對話仍留在對話列表，可以照常打開。
- 設定 → Agents & models → Hermes 頁保留（第 5 階段擴充）。

**驗收**：手機 393×852：登入 → 看到 Luna 與其他 Bot → 打開 Luna 的 Bot Chat → 送訊息看串流 →
核准一個請求 → 鎖屏後收到推播 → 回來看到完整回覆；Telegram 的對話出現在「其他對話」。

### 第 2 階段：例行工作

- 來源：Hermes REST `/api/cron/jobs` 系列（列表、建立、更新、刪除、啟用／暫停、立即執行、執行紀錄）。
  實作時以 Stepwell 的 cron 編輯器與 0.21.6 原始碼確認端點與欄位。
- 每個 Bot 頁面有「例行工作」；助理分頁另有「所有例行工作」總覽。
- 每項顯示：名稱、排程（易讀文字）、下次執行、上次結果（成功、失敗、送達失敗分開顯示）、啟用狀態。
- 新增與編輯表單：
  - 排程：先選頻率，再選細節；「進階」可直接輸入 Hermes 排程字串。
  - 指令內容、模型與 provider、技能、無 Agent 腳本模式。
  - 送到哪裡：多選（Telegram 主頻道、指定 Telegram 對話、這個 Bot 的 Bot Chat、其他 Bot 的
    Bot Chat、只存本機）。「同時送到 Bot Chat」就是在送達清單加入或移除 `bot-chat`。
  - 在某個 Bot 底下新增的工作，名稱依 Bot Mode 慣例加上 `[bot:<名稱>]`。
- 立即執行需要確認（會真的執行）；刪除需要確認。
- 不自動修改既有工作；改不改由使用者逐一決定。

**驗收**：看到 Mini 上 4 個啟用中的工作與歷史；替 Luna 的一個工作打開「同時送到 Bot Chat」，
下一次執行的結果出現在 Luna 的 Bot Chat 並推播（實機驗證前先徵得使用者同意）。

### 第 3 階段：群組聊天

- 先呼叫 `groups.capabilities`；`driver` 不是 `true` 時，群組區塊顯示「需要更新 Hermes」。
- 使用 `groups.list`／`create`／`send`／`log`／`state`／`stop`／`approve`／`retry`／`rename`／`disband`。
- 名單中有「群組」區：群組名稱、成員頭像、最新訊息、未讀。
- 建立群組：選 2～6 個同一台機器的 Bot、取名。
- 群組對話：每則訊息標示發言的 Bot；`@` 自動完成指名；`@all` 指名全體；停止；
  被停住的成員以 `@` 指名或 `@all` 讓它繼續；成員的核准請求同第 1 階段的卡片。
- 解散需要確認。
- 輪流發言由 Hermes 後端負責；Stepsemble 不實作輪流邏輯。

**驗收**：建立 Luna 與另一個 Bot 的群組，`@` 指名其中一個回答，停止後以 `@all` 續聊；
關掉瀏覽器後群組仍由 Hermes 繼續（以 `groups.log` 確認）。

### 第 4 階段：Bot 與技能管理

**Bot**

- 建立：
  - 快速：名稱、職稱、描述。
  - 進階：從既有 Bot 複製或全新、空白（不含內建技能）、指定模型與 provider、個性 SOUL.md、
    逐一開關技能、工具組、MCP 伺服器、是否從主 profile 複製 API key（預設開；OAuth 登入不會複製）。
- 編輯：職稱、描述、頭像（上傳圖片）、SOUL.md、模型、技能／工具／MCP 開關、隱藏與顯示、改名。
- 刪除：需輸入 Bot 名稱確認；說明對話與例行工作會一起刪除。
- 寫入的 `ui_meta` 與 Hermes 桌面版相容，兩邊看到同一份名單。
- 後端：`profiles.create`、`profiles.configure`、`profiles.set_asset`；改名與刪除等沒有 RPC 的操作，
  實作時確認 0.21.6 的正式介面（REST 或 `cli.exec` 白名單指令），不自行拼接 shell。

**技能**

- 依分類瀏覽、搜尋、逐一開關（`/api/skills`、`/api/skills/toggle`）。
- 查看與編輯 SKILL.md（`/api/skills/content`）。
- Skill Hub：搜尋、預覽、安全掃描、安裝、移除（`/api/skills/hub/*`）。安裝前一定顯示掃描結果並要求確認。
- 技能範圍依 profile 區分，沿用 Hermes 的語意。

**驗收**：在 Stepsemble 建立一個測試 Bot、改頭像與 SOUL.md、關掉一個技能，Hermes 桌面版或
`hermes profile list` 看得到同樣結果；刪除測試 Bot。

### 第 5 階段：Hermes 控制台

位置：設定 → Agents & models → Hermes 頁（擴充既有頁面）。

- 主模型、provider、思考強度、輔助模型預設值。`/api/config` 需整份寫回：讀取 → 修改 → 寫回，
  並檢查讀取後是否已被別人改過，避免覆蓋。
- API key：只顯示遮罩與是否已設定；可新增或取代；原始值永不回傳瀏覽器。
- 自訂 endpoint：新增、編輯、刪除、實測連線。
- 備援模型鏈：檢視與調整順序。
- 用量：7／30／90 天的 token、費用、依模型統計（`/api/analytics/*`）。
- Gateway：狀態、已連接的平台、執行中的回合；重啟需要確認，有回合執行中時警告。
- Hermes 版本更新沿用既有的 Harness 更新中心（Hermes 維持手動升級）。

**驗收**：與 Stepwell Local 工具頁逐項對照，涵蓋所有 Hermes 相關功能。

## 6. 錯誤處理

| 情況 | 處理 |
|---|---|
| 沒裝 Hermes | 不顯示助理切換 |
| Hermes 沒在執行 | 顯示「Hermes 沒在執行」與啟動方法；不自動啟動 |
| 只支援 OAuth | 顯示不支援的說明 |
| 帳密錯誤、限流 | 停止並顯示原因；不自動重試登入 |
| 登入過期 | 請使用者重新登入；草稿保留 |
| 連線被斷 | 依 4.5 自動重連並接回對話、補事件 |
| Hermes 版本缺某功能（`method not found` 等） | 只有該功能顯示「需要更新 Hermes 到 X 版」，其他照常 |
| Hermes 回傳錯誤 | 顯示 Hermes 的錯誤訊息摘要；不顯示原始 stack 或憑證 |
| 寫入衝突（設定已被別人改過） | 不覆蓋，提示重新載入 |

## 7. 安全

- 所有 `/api/assistant/*` 都要通過 Stepsemble 既有的驗證（cookie＋CSRF 或已配對裝置的 bearer），
  沿用現有的請求大小限制。
- 瀏覽器永遠不直接連 Hermes，也拿不到 Hermes 的 cookie、token 或票。
- 不保存 Hermes 密碼；cookie 檔權限 600；所有 log 都不記錄密碼、cookie、票、sudo 密碼、secret 值、API key。
- 只連本機位址（4.3），防止 SSRF。
- 核准、sudo、secret 一律等使用者明確回覆；不自動核准、不使用 yolo。
- 會花費額度或改變狀態的動作（立即執行例行工作、重啟 Gateway、安裝技能、刪除）都需要確認。

## 8. 相容性

- 基準：Hermes 0.21.6。
- 啟動時讀 `/api/status` 的版本，並在使用各功能前偵測（例如 `groups.capabilities`）；
  缺少的方法視為「需要更新」，不猜測替代方案。
- 新增 `scripts/check-hermes-release.mjs` 與 `npm run check:hermes-release`，比照其他 Agent 的相容性檢查；
  `docs/agent-capability-matrix.md` 更新 Hermes 一列。
- 這套 JSON-RPC 是 Hermes 給自家桌面版用的內部協定，Hermes 升級可能改變；每次 Hermes 新穩定版
  都要跑相容性檢查。

## 9. 測試

- **假 Hermes**：`test-support/fake-hermes-gateway.mjs`，實作 `/api/status`、登入、ws-ticket、
  WebSocket JSON-RPC 與事件、各階段用到的 REST。所有自動測試都用它，不碰真的 Hermes。
- **單元與整合測試**：`test/hermes-*.test.js`，以 `node --test` 執行，涵蓋：找伺服器、登入與限流、
  cookie 保存權限、ws-ticket、重連與接回、事件緩衝上限、Bot Chat 不重複建立、四種請求回覆、
  推播條件、機器路由、各階段 API。
- **畫面測試**：`scripts/assistant-browser-cases.mjs`，比照既有瀏覽器測試，手機 393×852 與桌面兩種尺寸。
- **既有檢查**：`npm run check`、`npm test` 與所有既有關卡持續通過；新檔案加入對應的 `check:*` 腳本。
- **真機唯讀檢查**：`npm run test:native:hermes`，對真正的 Hermes 只讀：狀態、`profiles.list`、
  對話列表、例行工作列表。不送訊息。
- **真機互動測試**：會用到模型額度，執行前先徵得使用者同意，並優先使用測試用 Bot。

## 10. 開發與發布

- 所有開發在 `feature/hermes-assistant`（worktree：`~/.config/superpowers/worktrees/Stepsemble/hermes-assistant`）。
- 每個實作任務獨立提交；每個階段結束跑完整測試。
- 五個階段完成後：跑完所有發布關卡 → 回報結果並確認 → 合併到 master → 依現有流程發布新的次版本
  （3.9.0）→ 兩台主機在沒有工作時自動更新。
- 文件：新增 `docs/hermes-assistant.md`；更新 `README.md`、`README.zh-Hant.md`、`README.zh-Hans.md`、
  `docs/agent-capability-matrix.md`、`CHANGELOG.md`。

## 11. 風險與實作時要確認的事

| 項目 | 處理 |
|---|---|
| Hermes 內部協定可能改變 | 相容性檢查、逐功能偵測 |
| REST 端點與參數細節 | 實作每個功能前，以 0.21.6 原始碼與 Stepwell 現行實作確認 |
| `session.events.since` 的保留期間 | 第 1 階段確認；不足時以重新讀取歷史補齊 |
| 無登入模式的 token 取得方式 | 第 1 階段以 0.21.6 確認 |
| Stepwell Local 停用後 Luna 失去的能力 | 不在本次範圍；停用前另外規劃 |
| 真機測試的模型費用 | 先徵得同意 |
