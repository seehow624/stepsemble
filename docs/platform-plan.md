# Stepsemble 跨平台完整體架構與執行計畫

> 狀態：已接受（Accepted）
> 計畫版本：1.30
> 最後更新：2026-09-06
> 當前產品基線：Stepsemble 3.0.5（由 Pi Harbor 2.13.2 相容遷移）
> Mini／MacBook Pro 啟用版本：3.0.5／source `7851c10`（2026-09-06 已部署並公開 stable release）
> 當前實作：Node.js 22.19+ ＋無建置步驟的 JavaScript PWA
> 長期目標：Rust Host Core ＋ TypeScript 跨平台 Client ＋ Tauri 2 App Shell

## 文件用途與回復方法

這份文件是 Stepsemble 從 Web App 發展為跨平台 Coding Agent 工作區的長期計畫與決策來源。它的目的是讓後續對話即使經過 session 壓縮、開啟新 session，或換由其他 agent 執行，仍可恢復已確認的方向，不需要重新推導。

未來開始任何架構、跨平台、session、approval、agent adapter、model routing 或 Rust 遷移工作前，依序：

1. 完整讀取本文件。
2. 完整讀取 [`docs/current-system-inventory.md`](current-system-inventory.md)，確認相容性基線與已知缺口。
3. 讀取 [`docs/architecture.md`](architecture.md)，確認目前已上線的架構。
4. 涉及效能時讀取 [`docs/performance-baseline.md`](performance-baseline.md) 與其 raw JSON。
5. 檢查 `git status --short`、`package.json` 版本與現有測試。
6. 從本文件的「當前執行狀態」找到下一個未完成項目。
7. 只在前一階段驗收條件通過後，才進入下一階段。
8. 每次實質進展都要同步更新「當前執行狀態」與「變更記錄」。

[`docs/architecture.md`](architecture.md) 描述「當前已上線的真實狀態」；本文件描述「已確認的目標架構與遷移順序」。兩者不得混為一談。

## 當前執行狀態

| 項目 | 狀態 | 說明 |
| --- | --- | --- |
| Web 正式上線／品牌介面整理 | 3.0.5 已在兩台 Mac 上線並公開 | exact `7851c10` 三OS CI／雙平台 rolling 全綠；巢狀資料夾捲動、首次 SW 啟用表單保留已上線，品牌原圖未改；原生歷史／保護設定保留，兩台更新器正常。見 `project-picker-scroll.md` |
| 長期語言邊界 | 已定案 | Rust Host Core；TypeScript UI/Client；Swift/Kotlin 僅處理平台專屬能力 |
| Web 產品定位 | 已定案 | Web/PWA 永久保留，不是過渡版 |
| 產品名稱與識別 | 已定案 | Stepsemble；step + ensemble；四個等權模組代表 agents，藍紫內緣代表每個 agent 共用的 Stepsemble coordination layer |
| Host/Client 邊界 | 已定案 | Desktop 可為 Host + Client；iOS/Android 初期只為 Client |
| App Shell | 目標已定，待驗證 | Tauri 2 為預設方案；必須先通過 Apple 實機 PoC 驗收門檻 |
| 當前回歸基線 | 3.0.5 已發布；3.0.6 candidate 驗收中 | Windows stop fix `ae0cebc` 已通過 CI34027450549 三OS333tests／0fail及 rolling34027450520。新增 UI／restore 修正待final-source gate；見 `agent-stop-reliability.md` |
| Pi Failed／session 名稱修正 | 已隨3.0.4部署 | 已分離預期 idle close 與異常退出、補上送出／關閉競爭保護，名稱統一 native name／first user；驗證與相容邊界見 `pi-session-lifecycle.md`。未呼叫真實模型或改寫歷史 |
| 開發分支跨平台回歸 | 已通過，逐批驗證 | 2026-09-05 `6a0ddd4`／CI33970842907三OS全綠270tests/0fail；Rolling33970842871 macOS/Linux各8cases全綠。Native Pi offline contract33967509738三OS實跑0.84.2各57frames；本批見1.23記錄，新的commit需看各自workflow；不等於model/provider parity或release |
| 現行系統盤點 | 已完成 | HTTP/SSE/RPC、資料、狀態、approval、event、安裝與 rollback 已落於 `current-system-inventory.md` |
| 本機品牌遷移 | 已部署 | Mac Mini 已由 2.13.2 原地升級至 3.0.0；session/token/SSH launcher/CUA driver 均完成前後核對 |
| 跨平台 installer smoke | 部分完成 | macOS live migration、Linux clean-container install、Windows PowerShell AST 通過；Linux systemd/Windows Scheduled Task real runner 待補 |
| Host 效能基線 | 已完成 | 2.13.2 與 clean source commit `39e671d` 的 3.0.0 都以 301 synthetic sessions、41,000 messages、8 generic tasks 實測；結果見 `performance-baseline.md` |
| Browser 效能基線 | 已量測，保留缺口 | Chrome DevTools 已連線；cold/warm、長 session、30 秒串流、mobile 4× CPU、network/accessibility 見 `browser-performance-baseline.md`；標準 TBT 與完整 trace export 待補 |
| 階段 0：計畫與基線 | 基線可供後續比較 | 已記錄長對話 INP 537 ms、mobile restore LCP 4859 ms、串流收尾長任務；這不是順滑度驗收通過 |
| 階段 1：Stepsemble Protocol v1 | 進行中 | handshake／strict TS SDK／35 events＋8 commands、receipt／entity／bounded history／snapshot、多列proposal／observed-fact邊界、30-step synthetic transaction golden與1,251-case Ajv conformance已實作；Pi0.84.2三OS真實離線57frames已驗；實際native ownership/evidence驗證／durable ledger／snapshot transport／rolling gate仍未通過 |
| Pi 原生 RPC 邊界 | 已實作，隨rc.3啟用於Mini | 嚴格 frame／UI reply、跨程序 correlation、有界 pending dialog、TypeScript FIFO／失敗手動重試、完整 pending-set 重連對齊／舊 stream fencing、更新／idle／離開聊天保護；Windows core launch／PATH／owned tree 已接上 runner fixture；仍非 durable approval 或原生全版本／provider／模型串流驗收 |
| 已發佈 Web rolling 相容 | Legacy smoke 已驗 | 真實v3.0.3/v3.0.2 pinned source與development雙向搭配，Chromium桌面/手機尺寸8cases，macOS/Linux各跑一次共16cases／CI33970245044過。SW/PWA cache、Safari/Firefox/Windows/實機、future journal transport不包含，見`protocol/rolling-compatibility.md` |
| Codex 官方介面基線 | 離線 metadata 已驗 | 0.153.3官方CLI輸出18個schema hash與99/10/81方法catalog；隔離HOME且不啟app-server/模型/登入，不改OpenCodex wrapper；不是原生runtime/session/approval驗收 |
| Claude／Codex 真實訂閱 smoke | 已授權，成功 gate 未通過 | 各1次最小測試已獲同意；Claude唯一一次因OAuth過期／更新失敗，native記錄usage四項0，不重試；Codex preflight檢出既有本機API代理與全域指令，未送turn/start、不改設定。詳見`native-subscription-smoke.md`；不是adapter/parity通過 |
| Claude 官方登入入口 | 3.0.4在Mini啟用，當前signed_out | rc.3曾以桌面助手通過detected metadata／UI；3.0.4部署前後均signed_out，liveVerified=false，不以舊成功記錄冒充現在已登入。入口保留，不自動修憑證／重試模型；詳見 `claude-sign-in.md` |
| Claude macOS 桌面執行元件 | Mini助手與Web已啟用 | rc.3 Aqua LaunchAgent、owner-only IPC、登入/task互斥及單次launch票；真GUI fake-CLI metadata/task均Aqua且重啟重接只開一次。真正SSH Background→助手Aqua→官方Claude metadata detected；零login/logout/model。Web經另行同意後無任務啟用，保留3.0.3可回退；不是原生全能力驗收，見`claude-desktop-runner.md` |
| 優先可靠性修復 | 已實作，隨rc.3啟用於Mini | 可復原封存、開啟中 session 保護、symlink containment、循環／超大 history 防護、UTF-8 framing、SSE 背壓、snapshot 去重、async worktree；詳見 `reliability-followup.md` |
| Web 卡頓修復 | 部分完成 | 歷史離屏分批建立、相鄰訊息線性合併、局部翻譯、聊天可及性；仍需 virtualization、實機／多輪效能門檻驗收 |

### 下一個可執行任務

**2026-09-06 最新進度**：Web 3.0.5已完成公開 release、Mini／MacBook Pro 可回滾部署，兩台每60分鐘自動更新正常；不要再要求 MBP 補裝。SSH 仍沒有權限，不繞過。使用者同意下一批先修 Windows 停止／重連競態、補恢復驗收，再量測長對話；實作／驗收記錄見 `agent-stop-reliability.md`。Claude 最近 metadata 為 signed_out，登入由 owner 進行；模型重測仍需新的用量同意。Phase 1、實機和72h不因Web上線就完成。每次部署仍先檢查 active work 並保留回滾。

先閱讀 `reliability-followup.md`、`protocol/v1/README.md`、`command-state.md`、`lifecycle.md`、`projection.md`、`transactions.md`、`protocol/native/pi/README.md`、`protocol/native/codex/README.md`、`protocol/rolling-compatibility.md` 、`native-subscription-smoke.md` 與 `claude-sign-in.md`，再繼續 Phase 1。Pi三OS真實離線、pending-set/FIFO/reconnect、receipt/entity/projection/snapshot、8commands/observations多列proposal與30-step golden已做；前兩已發布版本的legacy browser雙向8cases在macOS/Linux皆過；Codex0.153.3離線schema metadata已驗，不要重做。Jerome已同意Claude/Codex各1次最小測試；Claude唯一attempt因OAuth過期失敗，記錄用量0但不得自動重試，Jerome曾於09-06自行重新登入，但最新metadata又為signed_out；官方登入由owner進行，模型重測仍需新的同意。Codex沒有送turn：有效設定仍有本機API代理與全域指令，需要先決定隔離方式，不可自行改設定／搬憑證／移除私人指令。Native ownership/evidence、模型/tool／訂閱與authenticated transport仍需接入，之後按階段接durable store/crash/restore，純函式不是DB證據。Projection未接live UI，paging/worker/效能、SW/cache/Safari/Firefox/實機/futurejournalrolling、72h等仍待；Rust/App完整體未完成；後續部署依本次active-work與回滾安全邊界辦理。

## 一、不可退讓的核心決策

### D-001：Web/PWA 永久是第一等 Client

Web App 不會在原生 App 出現後被取代。它長期承擔：

- 零安裝存取。
- 新平台尚未提供 App 時的完整界面。
- 原生 App 故障時的救援入口。
- 自架 Host 的管理界面。
- 產品行為的參考 Client。

### D-002：Host 與 Client 從架構上分離

- **Host** 擁有 agent 子程序、PTY、workspace、session 來源、approval、provider 登入與秘密。
- **Client** 顯示與控制 Host，不擁有 agent 帳號與工作區真實資料。
- macOS、Windows、Linux 可提供 Host + Client。
- iOS、Android 在可預見的階段只提供 Client。
- 關閉任何 Client 不得終止正在執行的 Host task。

### D-003：固定語言邊界，不追求單一語言

- TypeScript：Web UI、共用 Client SDK、前端 state reducer、界面與原生橋接的呼叫端。
- Rust：Host Core、daemon、process/PTY、事件持久化、伺服器、裝置信任與安全邊界。
- Swift：Apple 平台 Keychain、Face ID/Touch ID、APNs、Bonjour、Share Sheet 等必要橋接。
- Kotlin：Android Keystore、FCM、Intent、Share Sheet 等必要橋接。
- C#：僅在 Rust/Windows API 無法穩定完成的 Windows 專屬邊界使用。
- 平台橋接不得重新實作 session、approval、model routing 或 agent 狀態機。

### D-004：Rust 是長期 Host Core，但不作 Big Bang Rewrite

新的 Host 核心能力以 Rust 目標架構設計。現有 Node 服務作為可用的行為基線與回滾路徑，按端點與能力逐步遷移，禁止一次性翻譯整個 `server.js` 後直接替換。

### D-005：Tauri 2 為預設 App Shell，但要有退出機制

Tauri 2 的 HTML/TypeScript UI ＋ Rust Core ＋ Swift/Kotlin plugin 模式與本計畫相符。正式承諾前必須完成 Apple 實機 PoC。若特定平台無法通過穩定性、效能、無障礙或商店審核門檻，可在不改變 Stepsemble Protocol 與 UI 資料模型的前提下替換單一平台 shell。

### D-006：原生 agent session 是來源，Stepsemble 事件是可回放投影

- 有原生 session/history API 的 agent，其原生資料是主要來源。
- Stepsemble 保存正規化、可排序、可斷線續傳的 append-only event journal。
- Stepsemble 不得為了統一 UI 而破壞、改寫或偽造原生 session。
- 沒有原生 session API 的 harness，才以 Stepsemble journal 作為權威記錄。

### D-007：官方登入與訂閱必須保持原生邊界

- Claude Code、Codex 等官方登入保存在各自客戶端的原生位置。
- Stepsemble 不複製、匯出、同步或上傳這些 OAuth/token。
- Stepsemble 只保存「使用哪個登入來源」的不含秘密參照。
- 官方訂閱與外部 API/provider 計費路徑必須在 UI 明確顯示。
- 禁止在官方訂閱、API key、外部 router 之間靜默 fallback。

### D-008：第三方模型工具是 Model Source，不是 Agent

OpenCodex、CC Switch 與未來的 gateway/router 放在 Model Source/Launch Profile 層。能使用 harness 原生 provider 時優先使用原生方式；需要跨協議轉譯、集中模型目錄或多帳號路由時才啟用外部工具。

### D-009：所有客戶端都使用同一套 Stepsemble Protocol

Tauri App 不得繞過公開 Host API 直接呼叫私有商業邏輯。原生 IPC 只用於 Keychain、通知、視窗、檔案選擇與其他平台能力。Web、App 與遠端裝置應觀察到一致的 session 行為。

### D-010：產品名稱定案為 Stepsemble

- 公開產品名、套件名、服務名、設定路徑、環境變數與 protocol 新前綴統一使用 Stepsemble／`stepsemble`／`STEPSEMBLE_*`。
- 名稱來自 **step + ensemble**：不同 coding agent 以一致步伐協作，不綁定單一 harness 或 model。
- Step Mosaic 由四個等權模組組成：錯落旋轉代表 step-by-step handoff，四個相同藍紫內緣代表每個 agent 都接入同一個 Stepsemble coordination layer，中央負空間代表共同 workspace。品牌母檔是使用者親自確認的 `public/stepsemble-mark.png`（1254×1254；SHA-256 `cc1b089b74d7ed6b38ad40498b43fcd68957cce5692a84689f2b3b9fdf23f511`）；彩色輸出必須由此母檔直接派生。未來若製作向量版，必須以母檔做視覺比對並由使用者確認後才能取代，禁止再以近似重畫稿直接上線。
- 核心品牌禁止使用 provider logo 或把 Claude、Codex 等供應商代表色固定分配給任一模組；provider identity 只在有文字標籤的產品 UI 中出現。
- v3 保留 Pi Harbor／Pi Web 的設定路徑、cookie、環境變數、配對碼與 Release asset 讀取相容；舊來源只複製、不刪除，健康檢查成功前不封存舊程式。
- 2026-09-04 的初步 exact-name 網路、常見 package registry、GitHub、App Store 與主要網域檢查未發現明顯同名產品；這不是正式商標法律意見，公開商業發佈前仍需做目標市場商標檢索。

## 二、產品目標與非目標

### 目標

- 在一個工作區中穩定使用 Pi Agent、Claude Code、Codex、Grok Build、OpenCode 與未來 harness。
- 對每個支援的 harness 提供可恢復 session、完整歷史、即時事件、取消與 approval。
- 感受上接近各家官方客戶端：輸入不卡頓、事件不丟失、不重複、可斷線恢復。
- Web/PWA 始終可用，並與原生 Client 共用 Host 與 session。
- 按 Web → macOS/iOS → Windows/Linux → Android 順序擴展。
- 不影響使用者直接使用官方 Claude Code、Codex 或其他客戶端。
- 對舊版 Client/Host 提供明確的相容與升級策略。
- 重啟 Web UI、App Shell 或 Host API 時，正在運行的 task 仍能繼續。
- 本機優先、隱私優先，不將 workspace、prompt、session 或 provider 秘密預設上傳雲端。

### 非目標

- 初期不建立多租戶雲端 coding agent 執行平台。
- 不在 iOS/Android 本機啟動桌面 coding agent CLI。
- 不要求所有平台、UI 與 runtime 共用同一種語言。
- 初期不為每個平台重寫完整原生 UI。
- 不替代官方 provider 的帳號、訂閱、用量與計費系統。
- 不因為架構遷移而變更或刪除使用者原生 session、workspace 與憑證。
- 不在沒有效能證據時將 Web UI 改寫為 Rust/WASM。

## 三、共同詞彙

| 名稱 | 定義 |
| --- | --- |
| Coding Harness | 實際管理 prompt、tool call、context 與 agent loop 的程式，例如 Claude Code 或 Codex |
| Provider | 實際提供模型推理與計費的服務來源 |
| Model | 實際執行推理的 model ID |
| Model Source | 可提供 provider/model 目錄與路由的來源，包含原生設定或外部 router |
| Launch Profile | 一次 session 啟動時鎖定的 harness、route、provider、model、auth reference 與能力快照 |
| Host | 可存取 workspace、執行 harness 與保存 session 的電腦 |
| Client | Web/PWA 或原生 App，用於觀看與控制 Host |
| Session | 可持續、可恢復的對話與工作單位 |
| Turn | 一次使用者輸入到 agent 結束或中斷的執行 |
| Run | Host 上一次實際執行，可能包含多個 tool/approval 事件 |
| Event Journal | Stepsemble 對一個 session/run 保存的有序 append-only 事件記錄 |
| Approval | 執行高風險動作前，需由已授權使用者明確回應的持久狀態 |
| Projection | 由事件日誌重建的 UI/session 顯示狀態，可丟棄後重新生成 |

UI 必須清楚分開：

```text
Harness：Claude Code
Connection：OpenCodex
Provider：MiniMax
Model：MiniMax M3
Billing/Auth：MiniMax API key
```

「使用 Claude Code harness」不等於「正在使用 Claude model」，也不等於「消耗 Claude 訂閱」。

## 四、目標系統架構

```mermaid
flowchart TB
  subgraph Clients[Stepsemble Clients]
    Web[Web / PWA]
    IOS[iOS App]
    Mac[macOS App]
    Android[Android App]
    Windows[Windows App]
    Linux[Linux App]
  end

  SDK[TypeScript Stepsemble Client SDK]
  Protocol[Stepsemble Protocol v1\nREST + SSE + Schemas]

  subgraph Host[Desktop Stepsemble Host]
    Server[Rust Stepsemble Server]
    Core[Rust Session / Approval / Event Core]
    Runtime[Rust Process / PTY Runtime]
    Resolver[Model Source Resolver]
    Adapters[Agent Adapters]
    Store[(SQLite metadata + event journal)]
  end

  Native[Native agent sessions / configs]
  Agents[Pi / Claude Code / Codex / Grok / OpenCode]
  Routers[Native provider / OpenCodex / future routers]

  Web --> SDK
  IOS --> SDK
  Mac --> SDK
  Android --> SDK
  Windows --> SDK
  Linux --> SDK
  SDK --> Protocol
  Protocol --> Server
  Server --> Core
  Core --> Store
  Core --> Runtime
  Core --> Resolver
  Runtime --> Adapters
  Adapters --> Agents
  Adapters --> Native
  Resolver --> Routers
```

### 實際程序邊界

```text
stepsemble-daemon
  ├─ 獨立於 App 視窗生命週期
  ├─ 服務 Web/PWA 與原生 Client
  ├─ 管理 task/session/approval
  ├─ 與各 agent harness 通訊
  └─ 在 UI 關閉後依使用者授權繼續運行

stepsemble-shell
  ├─ Tauri 視窗、menu bar/tray、deep link
  ├─ 啟動/探測本機 daemon
  ├─ 連接本機或遠端 Host
  └─ 原生平台橋接
```

App 視窗崩潰或關閉時，daemon 不應被強制終止。daemon 崩潰時，App 必須清楚告知狀態，並由持久資料判定 task 是可重接、中斷或已完成，不得伪裝仍在執行。

## 五、平台責任矩陣

| 平台 | Web UI | 原生 Client | Host Runtime | 本機 Agent | 原生專屬能力 |
| --- | --- | --- | --- | --- | --- |
| Browser/PWA | 是 | 否 | 否 | 否 | Service Worker、Web Push |
| iOS/iPadOS | 共用打包 UI | 是 | 否 | 否 | Keychain、Face ID、APNs、Bonjour、Share Sheet |
| macOS | 共用打包 UI | 是 | 是 | 是 | Keychain、menu bar、notification、launch agent |
| Android | 共用打包 UI | 是 | 否 | 否 | Keystore、FCM、Intent、Share Sheet |
| Windows | 共用打包 UI | 是 | 是 | 是 | Credential Locker/DPAPI、tray、notification、service/task |
| Linux | 共用打包 UI | 是 | 是 | 是 | Secret Service、tray、notification、systemd user service |

行動平台不啟動桌面 CLI；它們只會對使用者擁有或已授權的 Host 發出指令。

## 六、長期程式語言與專案結構

### TypeScript 規則

- 新的 Client SDK 與 UI domain code 使用 strict TypeScript。
- 現有 JavaScript 先以 `checkJs`/JSDoc 建立型別基線，再逐檔轉換，禁止一次重寫前端。
- 前端不得直接組裝不受控的 agent command；所有呼叫通過 typed Client SDK。
- 外部 event/payload 即使通過 TypeScript 編譯，仍必須做 runtime validation。
- UI framework 不在這個階段強制替換。優先拆分純函式與 state reducer；只有組件隔離、效能或可測試性證明必要時，才另立 ADR 評估 React/Svelte 等框架。
- 線上 App 不依賴用戶電腦安裝 npm 套件；編譯產物在 release 時生成與驗證。

### Rust 規則

- 使用可重現的 Rust toolchain 與 lockfile。
- async I/O 預設使用 Tokio；HTTP/SSE 預設評估 Axum；serialization 預設 Serde；structured logging 預設 `tracing`。套件最終選擇在對應 ADR 與 PoC 通過後鎖定。
- async runtime thread 禁止未受控的 blocking filesystem/process call。
- 預設禁止 `unsafe`；不得已時必須將邊界、不變條件、測試與替代方案寫進 ADR。
- parser、event envelope、approval 與 path validation 不使用 `unwrap()` 處理不可信輸入。
- panic 不得輸出 token、prompt、provider response 或 workspace 內容。
- daemon 與 App Shell 以程序邊界隔離；初期不用 N-API/FFI 將長時間 runtime 嵌入 Node 程序。
- Cargo、DerivedData、node_modules 等派生產物必須位於本機磁碟的專用 build/cache 路徑，不得寫入 SMB 掛載的 devkit 工作目錄。Cargo 使用明確的 `CARGO_TARGET_DIR` 或 `--target-dir`。

### 目標 repo layout

```text
stepsemble/
├─ apps/
│  ├─ web/                  # TypeScript Web/PWA
│  └─ shell/                # Tauri desktop/mobile shell
├─ packages/
│  ├─ client/               # typed Stepsemble Client SDK
│  ├─ ui/                   # shared UI/domain modules
│  └─ protocol-generated/   # generated TypeScript bindings
├─ crates/
│  ├─ stepsemble-protocol/      # envelopes, ids, capabilities
│  ├─ stepsemble-core/          # session, run, approval, projection
│  ├─ stepsemble-store/         # SQLite, migration, backup
│  ├─ stepsemble-host/          # process, PTY, filesystem, Git
│  ├─ stepsemble-adapters/      # structured harness adapters
│  ├─ stepsemble-server/        # HTTP/SSE, auth, pairing
│  └─ stepsemble-daemon/        # standalone desktop host binary
├─ native/
│  ├─ apple/                # thin Swift bridge
│  ├─ android/              # thin Kotlin bridge
│  └─ windows/              # only if a native bridge is required
├─ schemas/                      # canonical protocol/schema source
└─ tests/                        # contract, fixtures, integration, chaos
```

這是目標結構，不在階段 0 進行無意義的大規模搬檔。每個目錄在有第一個實際模組時才建立。

## 七、Stepsemble Protocol v1

### 傳輸決策

- Control command：HTTPS JSON request。
- Host → Client 即時事件：SSE，延續目前已驗證的 POST + SSE 模式。
- 雙向高頻資料只在證據證明 SSE 不足時評估 WebSocket，不先行引入第二套狀態邏輯。
- 圖片、檔案與大型 binary 使用獨立 HTTP upload/download，不內嵌在 SSE event。
- 本機 shell 與 daemon 可使用 owner-only Unix socket/Windows named pipe，但上層語意與網路 API 一致。

### 版本協商

每個 Client 連線時提供：

- `clientVersion`
- `protocolMin`
- `protocolMax`
- `platform`
- `capabilities`
- `deviceId`

Host 回傳：

- 實際選定的 `protocolVersion`
- Host 版本與 schema version
- 可用 agent/model/source capabilities
- 強制升級或降級模式
- 已停用能力清單

目標是至少維持當前主版 Host 與前兩個已發佈 Client 版本的兼容路徑，因為 App Store 客戶端不可能與自架 Host 同步更新。

### 事件 envelope

```json
{
  "protocolVersion": 1,
  "eventId": "uuid",
  "sessionId": "stable-session-id",
  "runId": "stable-run-id",
  "sequence": 42,
  "type": "approval.requested",
  "createdAt": "2026-09-04T12:00:00.000Z",
  "payload": {}
}
```

不變條件：

- `sequence` 在同一 session 內單調增加。
- Host 對持久化成功的 event 提供至少一次交付。
- Client 以 `eventId`/`sequence` 排序與去重，重連不重複顯示。
- Client 透過 `Last-Event-ID` 或 `after` 繼續上次 cursor。
- 超出保留範圍時，Host 回傳完整 snapshot ＋新 cursor，不靜默丟事件。
- 所有可重試 command 支援 `idempotencyKey`。
- event 內不放 provider secret、官方 OAuth token 或未編輯的環境變數。

### 核心事件家族

- `session.created`, `session.updated`, `session.archived`
- `run.starting`, `run.started`, `run.completed`, `run.failed`, `run.interrupted`
- `message.delta`, `message.completed`
- `tool.requested`, `tool.started`, `tool.progress`, `tool.completed`, `tool.failed`
- `approval.requested`, `approval.resolved`, `approval.expired`, `approval.cancelled`
- `usage.updated`
- `context.updated`, `context.compacted`
- `model.changed`, `launch_profile.locked`
- `transport.connected`, `transport.degraded`, `transport.recovered`
- `host.restarting`, `host.ready`

新 adapter 不得發明只有特定 UI 才看得懂的事件；先映射到共用 event，無法無損表達的能力再使用有版本的 agent-specific extension payload。

## 八、資料、Session 與持久化

### 資料分層

1. **Native source**：各 harness 的原生 session/history/config，Stepsemble 不擁有也不改寫。
2. **Stepsemble durable state**：session identity、run、approval、device grant、launch profile snapshot、event journal。
3. **Projection/cache**：對話列表、搜尋 index、usage 匯總、UI snapshot，可由 1/2 重建。
4. **Client-local state**：草稿、顯示偏好、最後開啟位置與有限離線快取。

### 長期儲存決策

- Stepsemble-owned 結構化持久資料目標使用 SQLite。
- 事件表只 append，修改顯示狀態透過新 event 與 projection 完成。
- 大型 stdout/raw transcript 必須 bounded，或放在獨立檔案後以 hash/reference 連結，避免單一 DB 無限膨脹。
- SQLite 只儲存 credential reference/hash/encrypted payload，不收編官方 provider 的原始憑證。
- schema migration 在 transaction 內完成；遷移前建立可驗證備份，失敗必須回滾到舊程式與舊資料。
- 未驗證新 DB 前不刪除現有 JSON/JSONL 檔案。
- 所有 owner-only state 維持最小權限；對外匯出診斷時預設脫敏。

### Session identity

Stepsemble session 保存：

- Stepsemble stable session ID
- harness ID 與 adapter version
- native session ID/path/reference
- workspace 的 canonical identity
- 建立時的 Launch Profile snapshot
- 能力快照
- 最後成功對齊的 native cursor
- Stepsemble event cursor
- 狀態與中斷原因

絕不只以 model name、顯示名稱或一個易變檔案路徑識別 session。

### Session/run 狀態機

```text
idle
  → starting
  → running
  ↔ awaiting_approval
  → stopping
  → completed | failed | interrupted

starting | running | awaiting_approval | stopping
  → orphaned（執行狀態不明，仍保留 writer）
  → 有證據的 reconciliation 或 terminal outcome
```

規則：

- 一個 session 預設只有一個 active writer/run，但可有多個同時觀看的 Client。
- 所有狀態轉移必須有事件，禁止只改記憶體物件。
- Host 重啟後由 supervisor/native harness/last durable event 三方對齊。
- 無法證明仍在執行時標記 `interrupted`/`orphaned`，不伪報 `running`。
- `interrupted` 必須有終止依據；純粹失聯用 `orphaned`，不能因此釋放 writer。已提出停止者經 reconciliation 也不得恢復 running。Reserved wire 對應名稱為 `waiting_approval`，確切轉移與交易門檻見 `protocol/v1/lifecycle.md`。
- 客戶端斷線不等於 run 中斷。
- 同一 session 同時寫入衝突要以可解釋的 conflict 回應，不靜默覆蓋。

### Model 切換規則

- pending approval、tool 執行中或輸出中禁止更換 Launch Profile。
- 同 harness、同協議且原生支援時，可在 turn boundary 更換 model，並寫入 `model.changed`。
- 跨 provider、跨 router 或跨協議預設建立 fork，不在原 session 中偷換。
- 每個 run 保存實際使用的 profile snapshot，而不是只參照會變動的全局設定。

## 九、Approval 完整性

每個 approval 必須持久保存：

- approval ID
- session/run/tool identity
- 來自哪個 harness 與 native request ID
- 結構化的動作摘要、目標與風險等級
- 不可重複使用的 nonce
- 建立、到期、解決時間
- 解決結果
- 解決它的 device/user credential ID
- 對應的 native acknowledgement

安全規則：

- 預設不自動批准。
- 多 Client 同時回應時只有第一個合法、未過期的 nonce 生效，其餘取得已解決回應。
- 通知內不放完整 prompt、command 或私密檔案內容。
- 初期不在鎖定畫面通知上提供直接「批准」；使用者開啟 App、重新取得最新狀態，必要時通過生物辨識後回應。
- Client 重連後必須恢復 pending approval，不只依賴當時的 SSE event。
- approval 到期、Host 取消與 native harness 自行結束都要有明確 terminal event。

## 十、Agent Adapter 架構

### 對接層級

1. **Structured Native**：官方 app server、SDK、ACP、JSON-RPC 或受支援的 machine-readable protocol。
2. **Structured CLI**：官方 headless/JSON/streaming CLI，有可靠的 ID 與狀態。
3. **PTY Compatibility**：以互動式 CLI 終端兼容，只在前兩者不存在時使用。

同一 agent 可同時有 structured 與 PTY fallback，但 UI 必須告知當前使用的 integration tier 與能力差異。

### Adapter contract

每個 adapter 至少實作：

- discover executable/service/version
- report capabilities
- list/resume/create/fork session（若原生支援）
- start turn
- normalize stream events
- submit/cancel approval
- send follow-up/input
- stop/cancel run
- report terminal outcome
- map usage/context/model information
- recover after Stepsemble restart
- redact secrets and unsafe environment values

### 預設整合方向

| Harness | 優先方式 | 權威 session | Fallback |
| --- | --- | --- | --- |
| Pi Agent | 現有 JSON-RPC/native session | Pi native history | 無結構化協議時停用，不伪造 |
| Claude Code | 官方 structured/headless 介面，必要時評估 Agent SDK | Claude native session | PTY compatibility |
| Codex | Codex App Server/machine-readable protocol | Codex native session | 受限 CLI fallback |
| OpenCode | OpenCode service/structured events | OpenCode native session | PTY compatibility |
| Grok Build | ACP 或官方 structured protocol | Grok native session（若可用） | PTY compatibility |

表中的「優先方式」是實作前必須以當時官方文件與安裝版本再驗證的方向，不是在尚未通過 contract suite 前的兼容性宣稱。

### Capability 不得以 agent 名稱硬編碼

例如：

```json
{
  "sessions": { "list": true, "resume": true, "fork": false },
  "streaming": { "text": true, "toolEvents": true, "usage": true },
  "approvals": { "structured": true, "cancel": true },
  "models": { "list": true, "switchAtTurnBoundary": true },
  "input": { "images": true, "files": false },
  "recovery": { "reattach": true }
}
```

UI 依 capability 顯示功能，不因 agent label 做猜測。

## 十一、Model Source、Launch Profile 與第三方工具

### Resolver 流程

```text
Harness Adapter
  → Native model/provider discovery
  → User-defined native provider
  → External Model Source adapters
  → Capability/compatibility filter
  → User-visible Launch Profile
  → Immutable session/run snapshot
```

### Model Source 類型

- `native-official`：官方登入、官方 API 或 harness 原生 provider。
- `native-custom`：harness 官方允許的 custom endpoint/provider。
- `external-router`：OpenCodex 或其他跨協議 router。
- `profile-manager`：CC Switch 等主要管理外部設定的工具。
- `local-model`：Ollama、LM Studio、vLLM 等本機服務。

### 整合政策

- 原生直連優先，可減少故障層與帳號風險。
- OpenCodex 作為正式 Model Source adapter，透過可版本化、machine-readable 介面讀取目錄與路由狀態。
- CC Switch 初期只做 observer/import；在沒有穩定 API、lock 與 transaction 語意前，Stepsemble 不直接改寫它的資料庫或設定檔。
- 不自動啟用 account pool、輪詢多帳號或未授權 fallback。
- router 異常時 fail closed；不偷偷切換成另一家會產生費用的 provider。
- session 保存不含秘密的 route snapshot，包含 router ID/version、provider ID、model ID、protocol、auth reference 與 billing source label。

### 相容性等級

- **Native Verified**：官方/原生路徑並通過完整 contract suite。
- **Routed Verified**：經外部 router 並通過 streaming、tool、approval、context 與 recovery 測試。
- **Experimental**：基本文字與部分 tool 可用，能力差異清楚列出。
- **Unsupported**：隱藏或阻擋啟動，不讓使用者進入可預見的壞狀態。

「可選擇 model」不等於「可靠支援 coding harness」。必須分別測試 tool calling、streaming、reasoning、context、image/file input、approval 與 resume。

## 十二、安全、帳號與隱私

### Trust boundaries

- 瀏覽器/WebView 是低權限 Client。
- Tauri/Native bridge 只暴露最小、有範圍的 command。
- Host daemon 執行所有檔案系統、Git、PTY 與 agent 動作。
- Agent harness/provider/router 的輸出都是不可信資料，必須限制大小與驗證格式。
- 任何 Client 都不能送入任意 shell command；只能送 agent ID、已驗證參數與 prompt/input。

### Device identity

長期將目前 bearer/pairing 設計擴展為裝置專屬憑證：

- 每個 Client 有獨立 device ID 與可撤銷 credential。
- 原生 Client 將私密放在 Keychain/Keystore/Credential Locker/Secret Service。
- 新裝置使用短時間、單次配對能力，使用者檢視 Host/device 指紋後確認。
- 撤銷在 Host 下一個 request 即生效。
- 不以共用長期 token 作為新設備的預設配對路徑。
- 敏感 approval 可要求 Client 本機生物辨識，但 Host 仍會驗證 nonce、scope 與 device grant。

### Network

- Host 預設只監聽 loopback。
- 遠端使用 Tailscale/HTTPS 或受支援的安全 gateway，不將原始 Host port 暴露給不可信網路。
- iOS 區域網路探測必須提供清楚的權限說明，禁止用全局 ATS 寬鬆設定取代精確例外。
- 原生 App 中打包 UI，不導航到 Host 下載一整套可變動前端程式碼。
- 所有 relay 都不得反射 cookie、auth challenge、provider header 或私密路徑。

### Logging and diagnostics

- 使用 structured log，每個 run/request 有 trace ID。
- 預設不記錄 prompt、response 全文、token、authorization header 與 workspace 私密內容。
- 診斷包在本機產生、預設脫敏，匯出前顯示會包含的資料。
- crash reporting/telemetry 預設關閉，未來若引入必須 opt-in 並另立 privacy ADR。

## 十三、順滑度與穩定性預算

以下是初始工程目標，階段 0 取得真實基線後可透過計畫變更調整，但不得靜默降低：

| 指標 | 初始目標 |
| --- | --- |
| 本機普通 control API | p95 < 100 ms，不含外部 model/CLI 等待 |
| Host 收到 event 到前景 Client 可見 | LAN p95 < 100 ms |
| Client 輸入反應 | 持續串流時不出現 >100 ms 可感知卡頓 |
| 斷線恢復 | 傳輸回復後 p95 < 3 s，不丟 event |
| Host API 重啟後重接 runtime | p95 < 5 s |
| Event correctness | 測試中 0 丟失；重複交付被去重 |
| 長歷史 | 10,000 個正規化 event 可在 2 s 內顯示可操作初始畫面 |
| Soak | 72 小時、8 個同時 task、多 Client 反覆斷線，無不明 task 丟失 |

### 後端規則

- 所有資料結構有明確數量與 byte 上限。
- SSE 每個 Client 有 bounded queue 與 backpressure 策略；慢 Client 不得拖垮 Host。
- stdout/stderr 以有上限的 chunk 傳送，不讓單次巨大輸出壟斷其他 task。
- session 搜尋、usage 匯總、Git 操作、hash 與大檔讀取不在主 async runtime 上做未切片 blocking work。
- timeout、cancellation、child process tree 終止與 shutdown drain 都要有測試。

### 前端規則

- 流式 token/event 在 animation frame 或短批次中更新，不為每個 token 全畫面重繪。
- 長對話與 session 清單使用 virtualization/windowing。
- Markdown/Mermaid 在完成或受控節流後渲染，不在每個 delta 重新 parse 整篇內容。
- 視圖切換使用 generation/request identity，過期 response 不得寫回新畫面。
- 不以高頻 polling 代替已有事件；polling 只用於可容錯狀態與受限 fallback。
- 減少動態、鍵盤操作、VoiceOver/TalkBack 與高對比是正式驗收項目。

## 十四、測試策略

### 測試金字塔

1. **Unit**：parser、state reducer、path validation、redaction、migration。
2. **Protocol contract**：所有 request/response/event 的 schema、golden fixture、向前/向後相容。
3. **Adapter contract**：對各 harness 版本測試啟動、stream、approval、stop、resume 與錯誤。
4. **Integration**：daemon + fake harness + SQLite + SSE + Client SDK。
5. **End-to-end**：真實瀏覽器、Tauri 視窗、iOS/Android 實機。
6. **Chaos**：殺死 Web server、daemon、supervisor、agent child；斷網；休眠/喚醒；磁碟滿；檔案損壞。
7. **Performance**：大歷史、高頻輸出、1/4/8/16 task、慢 Client、多 Client。
8. **Security**：路徑穿越、shell injection、SSRF、DNS rebinding、token 洩漏、replay、越權 approval。
9. **Installer/update**：macOS/Windows/Linux 簽名、升級、回滾、舊資料保留。

### 真實 agent 驗證規則

- 發現 executable 不等於已驗證。
- 登入流程可抵達不等於 token exchange 與真實 model call 已通過。
- 文字回覆成功不等於 tool/approval/session resume 已通過。
- 測試報告要列出 harness version、OS、integration tier、route/provider/model 與未驗證能力。
- 不在 CI 或 log 輸出使用者的官方訂閱 token。

## 十五、發佈、更新與回滾

- Host、Web Client、App Client、Protocol、DB schema 分開版本化。
- 新 Host 在啟用不相容 schema 前先備份，健康檢查失敗自動恢復舊版。
- 破壞性 protocol 變更先做雙讀/雙寫或轉換層，等支援中的 Client 升級後才移除。
- App Store 與 Play Store 客戶端不得被 Host 當日更新強制破壞。
- 採用功能旗標與分階段啟用：開發機 → 內部測試 → 手動 opt-in → 新安裝預設 → 全體。
- 新 Rust 能力在移除 Node fallback 前必須完成至少一個穩定版週期與 soak test。
- release 持續使用 checksum、artifact attestation、簽名與可驗證來源。

## 十六、平台發展順序

### 階段 A：Web-first（現在）

- Web/PWA 繼續作為唯一對外產品界面。
- 完成多 agent 的結構化 session、history、approval 與 model source。
- 建立 Stepsemble Protocol 與 Client SDK，避免 UI 綁定目前 Node route。
- 改善長對話、流式更新、重連與多裝置一致性。
- 進行 Rust daemon 漸進遷移，但 Web 用戶無需更換使用方式。

### 階段 B：Apple（macOS → iOS/iPadOS）

macOS：

- Host + Client。
- 可連接本機 daemon 或遠端 Host。
- 提供明確的「UI 關閉後任務是否繼續」同意與狀態。
- 完整 Host 版優先提供簽名/notarized 的官網安裝包；Mac App Store 若因 sandbox 限制，可只提供 Client-only 版本。

iOS/iPadOS：

- Client-only，不執行 agent CLI 或下載可變動執行碼。
- UI 資源包含在 App bundle，只透過 API 取得資料。
- 前景使用 SSE；背景狀態使用 APNs 或受支援的最小通知 relay。
- 提供內建 Demo Workspace/recorded session，讓 App Review 與未連 Host 的使用者也能看到核心價值。
- 不只是開啟 Host 網頁的 WebView wrapper。

### 階段 C：Windows 與 Linux

- 共用 TypeScript UI、Tauri shell、Rust daemon 與 Stepsemble Protocol。
- Windows 完成 ConPTY/process tree、簽名安裝、tray/notification 與自啟權限。
- Linux 完成 PTY、systemd user service、Secret Service、Wayland/X11 與主要發行版打包。
- 原生 App 未完成前，這些平台仍使用完整 Web/PWA。

### 階段 D：Android

- Client-only，與 iOS 共用主要 UI 與 Client SDK。
- 原生差異僅在 Keystore、FCM、Intent、Share Sheet、權限與生命週期橋接。
- 在不同廠商 WebView、省電策略與背景限制下做真實裝置測試。

### 階段 E：選擇性原生化

只有真實效能、無障礙、系統整合或商店規定證明共用 Web UI 無法達標時，才將單一高價值畫面以 SwiftUI、Jetpack Compose 或 WinUI 替換。這是 Client 實作選擇，不得分叉 Host Core 與產品語意。

## 十七、分階段工程計畫與驗收門檻

### Phase 0：計畫、基線與資產盤點

- [x] 將長期架構、語言邊界與平台順序落檔。
- [x] 記錄目前 Node/PWA 架構與 Stepsemble 3.0.0 的 127/127 測試基線。
- [x] 列出所有 HTTP/SSE/RPC 端點、呼叫者、auth scope、timeout 與資料大小上限。
- [x] 列出所有持久檔案、擁有者、權限、備份與回滾語意。
- [x] 盤點現有 session/run/approval/task 狀態與所有 event。
- [x] 建立 Host 效能基線：API latency、event-loop delay、SSE latency、RSS、長 session API、多 task。
- [ ] 建立 Browser 效能基線：LCP/FCP/CLS/INP/TBT、長 session render、持續 streaming、network、accessibility。
- [x] 記錄當前 macOS/Windows/Linux 安裝、啟動、更新與回滾行為。
- [x] 在 Mac Mini 完成 2.13.2 → 3.0.0 transactional live migration，並核對 session/token/CUA/launchd。
- [x] 在 clean Linux container 實跑 source install，並以 PowerShell AST parser 驗證 Windows installer。

驗收門檻：盤點可由新 agent 獨立讀懂，每個外部行為都有對應的測試或明確標記為未覆蓋。

### Phase 1：Stepsemble Protocol v1 與 Contract Suite

- [x] 建立 canonical schema 目錄與 protocol version policy（reserved 與 shipped contracts 分開）。
- [ ] 定義 ID、event envelope、error envelope、pagination、cursor、idempotency。
- [ ] 定義 session/run/approval/launch profile/capability schemas。
- [ ] 由現有線上行為建立脫敏 golden fixtures。
- [ ] 建立 Node 實作的 contract tests，保證後續 Rust 不改變語意。
- [x] 建立 Host/Client version negotiation 與 capability negotiation。
- [x] 建立 typed TypeScript Client SDK，先替換 Web JSON `api()`；其餘 SSE/bootstrap caller 待後續收斂。

已實作但不等於整個Phase1通過：35events／8commands schema、pure checks、receipt／entity／bounded history／snapshot、全8commands＋maintenance／terminal／observation多列proposals、30-step synthetic golden、1,251cases Ajv conformance；Pi0.84.2三OS真實離線57frames；legacy released Web雙向rolling8cases本機過。實際native ownership/evidence、多版本／模型tool、durable store／authenticated snapshot transport／完整release rolling gate仍保留未勾選。

驗收門檻：舊 UI 行為不變；同一 fixture 可用於 Node 與未來 Rust；過期與未知 event 有明確處理。

### Phase 2：TypeScript 前端邊界與順滑度

- [ ] 啟用 `checkJs`/strictness 基線，不一次要求全數據零錯誤。
- [ ] 拆分 session reducer、event reducer、approval store、model/profile store。
- [ ] 將前端網路重試、cursor 與去重收斂到 Client SDK。
- [ ] 長對話/session list virtualization。
- [ ] 串流 event 批次渲染、markdown 完成後渲染。
- [ ] 將現有前端模組逐步轉成 TypeScript，保留可部署 JS artifact。

驗收門檻：長 session、持續串流、快速切換 Host/session 通過效能與 race tests；Web/PWA 部署與離線 app shell 不回歸。

### Phase 3：現有 Node Host 去阻塞與可觀測性

- [ ] 將 request path 的同步 session 目錄掃描改為 async/indexed 路徑。
- [ ] 將 `execFileSync` Git/worktree 操作改為 cancellable async child process。
- [ ] 將高頻同步寫入改為受控事件佇列與原子落盤。
- [ ] 加入 event-loop delay、SSE queue、task lifecycle、重連與子程序延遲指標。
- [ ] 建立可脫敏診斷包。

驗收門檻：現有 Node 版在同一壓測工作負載下有可重現基準，不再有已知會凍結整個 HTTP server 的長時間同步操作。

### Phase 4：Rust Workspace 與只讀 Shadow Daemon

- [ ] 建立 Rust workspace、toolchain、lint、test、dependency audit 與 CI matrix。
- [ ] 實作 protocol types、error model、config loader 與 structured tracing。
- [ ] 實作 `/health`、capability handshake 與靜態資源服務。
- [ ] 只讀掃描現有 session/config，與 Node 輸出做 shadow comparison。
- [ ] 不寫入使用者資料，不接管真實 task。

驗收門檻：Rust 與 Node 對所有 golden fixture 產生等價結果；只讀 shadow 模式可隨時關閉，不影響線上服務。

### Phase 5：Rust Durable Core 與資料遷移

- [ ] 實作 SQLite schema、migration、backup、integrity check 與 rollback。
- [ ] 實作 append-only journal、snapshot、cursor、idempotency 與 projection rebuild。
- [ ] 實作 session/run/approval state machine。
- [ ] 從現有 Stepsemble JSON 資料雙讀，初期不刪舊檔。
- [ ] 提供對等回滾與資料匯出。

驗收門檻：斷電/崩潰/升級模擬下 DB 無不可恢復損壞；舊版 Node 仍可回滾啟動；原生 agent session 檔案未被改寫。

### Phase 6：Rust Runtime、PTY 與 Agent Adapter Parity

- [ ] 實作跨平台 child process tree、signal/stop、timeout、shutdown drain。
- [ ] 實作 macOS/Linux PTY 與 Windows ConPTY 邊界。
- [ ] 將目前 detached supervisor 語意移植到獨立 Rust runtime。
- [ ] 依 structured-first 順序實作 Pi、Claude Code、Codex、OpenCode、Grok adapter。
- [ ] 建立每個受支援 harness version 的 contract suite 與兼容矩陣。
- [ ] 保留 Node supervisor/adapter fallback 至少一個穩定版週期。

驗收門檻：新 runtime 通過 72 小時 soak、關閉 Client、重啟 API、殺死 child、反覆 approval、快速 stop/restart 與多 Client 測試。

### Phase 7：Model Source 與第三方路由

- [ ] 實作 Launch Profile schema 與 Resolver。
- [ ] 實作 harness-native model discovery，並標記 auth/billing source。
- [ ] 實作 OpenCodex adapter，只使用可靠、可版本化的介面。
- [ ] 實作 CC Switch observer/import，不直接改寫未文件化內部格式。
- [ ] 建立 Native/Routed/Experimental/Unsupported 兼容測試與 UI。
- [ ] 實作 fork-first 的跨 provider/protocol 切換。

驗收門檻：任何實際 route、provider、model、billing source 在啟動前都可被使用者看懂；router 故障不會偷換帳號或產生意外費用。

### Phase 8：Tauri Apple PoC 與正式客戶端

- [ ] 建立只包含共用 UI 與 Client SDK 的 Tauri shell。
- [ ] macOS 實作 Host + Client、daemon lifecycle、menu bar、通知、簽名與 notarization。
- [ ] iOS/iPadOS 實作 Client-only、Keychain、Face ID、APNs、Bonjour/QR pairing、Share Sheet。
- [ ] 完成長對話、鍵盤、safe area、旋轉、休眠/喚醒、背景回前景實機測試。
- [ ] 建立 App Review demo mode、privacy labels、review notes 與 support URL。

驗收門檻：Tauri PoC 通過順滑度、穩定性、原生能力、商店規則與維護成本評估。若未通過，以同一 Client SDK/UI 評估 Capacitor（mobile）或 Electron（desktop），不改寫 Host Core。

### Phase 9：Windows/Linux Desktop

- [ ] 建立 Windows/Linux Rust daemon 與 Tauri build matrix。
- [ ] 完成安裝、升級、回滾、簽名/驗證與 user-level background service。
- [ ] 驗證各 harness 在不同 shell/PATH/config 環境的實際發現與啟動。
- [ ] 完成檔案系統、PTY、通知、tray、權限與睡眠恢復測試。

驗收門檻：各平台在全新一般使用者帳號、不需管理員/root 的預設流程完成安裝、配對、執行、重啟、升級與回滾。

### Phase 10：Android 與完整體

- [ ] 建立 Android Tauri Client-only build。
- [ ] 實作 Keystore、FCM、Intent、Share Sheet、區域網路與 app lifecycle。
- [ ] 在主要裝置、WebView 版本與電池策略下驗證。
- [ ] 完成所有平台的功能、安全、無障礙與相容性矩陣。
- [ ] 評估哪些畫面需要選擇性原生化，不做全平台先行重寫。

驗收門檻：Web、iOS、macOS、Android、Windows、Linux 都能連接受支援 Host；原生 App 不存在的環境仍可使用 Web/PWA 完成核心工作。

## 十八、CI 與平台測試矩陣

### 每個 PR

- Node legacy syntax/tests（遷移期間）。
- TypeScript typecheck、lint、unit tests。
- Rust fmt、clippy（warnings as errors）、unit/integration tests。
- Protocol schema compatibility check。
- 無秘密、無私人 host/path/device data 掃描。
- 安裝與更新檔案 preflight。

### 每個候選版

- macOS arm64，必要時 x64。
- Windows x64，之後 arm64。
- Linux x64，之後 arm64。
- iOS 最低支援版、當前版與至少兩種實機尺寸。
- Android 最低支援版、當前版與不同 WebView/廠商。
- Safari、Chrome、Edge、Firefox 的 Web/PWA 核心流程。
- 當前 Host 搭配支援範圍內舊 Client，與當前 Client 搭配支援範圍內舊 Host。

## 十九、主要風險與緩解

| 風險 | 緩解 |
| --- | --- |
| Rust 遷移引入新邏輯錯誤 | Contract fixtures、shadow mode、逐端點切換、Node fallback |
| 同時遷移 UI 與 Host 難以定位問題 | Protocol 先凍結；同一里程碑不同時替換兩個主邊界 |
| Tauri 不同系統 WebView 行為差異 | 實機矩陣、feature detection、shell fallback，不將商業邏輯鎖在 Tauri IPC |
| iOS App 被視為只是網站 wrapper | 打包 UI、原生 Keychain/Face ID/APNs/Share、demo mode、完整 App UX |
| App Store 更新慢於 Host | Protocol negotiation、前兩個 Client 版本兼容、破壞性變更延遲清理 |
| Agent CLI/SDK 快速變動 | Adapter version matrix、capability discovery、structured-first + bounded fallback |
| 第三方 router 改寫設定或閃退 | 原生優先、只讀觀察起步、不直接改未文件化資料庫、fail closed |
| 訂閱帳號被外部 route 混用 | Auth/billing source 明示、不匯出 OAuth、無靜默 fallback |
| SQLite/schema 遷移破壞使用者資料 | Transaction、backup、integrity check、雙讀過渡、舊檔保留 |
| 手機背景中斷 SSE | 前景 SSE；背景採 push；回前景以 cursor/snapshot 對齊 |
| 背景 daemon 讓使用者不知情 | 首次明確同意、tray/menu 狀態、可隨時停止、卸載可恢復 |
| 單體前端繼續膨脹 | TypeScript domain modules、Client SDK、state reducer、每階段行數/複雜度盤點 |
| 多平台功能漂移 | 共用 capability/schema/E2E scenarios，原生 bridge 不包含商業邏輯 |

## 二十、架構變更規則

下列變更必須新增 ADR，不只改程式碼：

- 更換 Rust、TypeScript 或 Tauri 的責任邊界。
- 從 SSE 轉成 WebSocket 或增加第二套事件傳輸。
- 變更 native session 與 Stepsemble journal 的主從關係。
- 改變 provider credential 的儲存位置。
- 增加 cloud relay、telemetry、crash reporting 或 hosted execution。
- 變更行動端 Client-only 的邊界。
- 引入全面原生 UI 或替換共用前端框架。
- 直接寫入第三方 router/profile manager 的私有設定格式。
- 改變支援的 Client/Host 版本視窗。

ADR 必須包含：背景、決策、替代方案、取捨、資料影響、安全影響、回滾路徑、測試證據與狀態。

更改本計畫時：

1. 不覆蓋過去決策沒有發生過的事實。
2. 在「決策紀錄」將舊決策標記 superseded，連結新 ADR。
3. 更新對應 phase、驗收門檻與風險。
4. 在「變更記錄」說明為何變動。
5. 若已有使用者資料或 Client 依賴，必須先寫相容/回滾計畫。

## 二十一、待後續 ADR/PoC 確認的問題

以下不影響語言與主架構，但必須在對應階段決定：

- Rust HTTP framework 與 SSE/backpressure 實作的最終套件。
- SQLite driver/migration library、journal payload 大小與 retention policy。
- TypeScript 打包工具與是否需要 component framework。
- Tauri iOS 在真實長對話、鍵盤、APNs、Bonjour 與 App Review 下的結果。
- macOS 完整 Host 是否只官網發佈，Mac App Store 是否另提供 Client-only。
- APNs/FCM 是否需要只保存 opaque task ID 的最小通知 relay。
- 本機 LAN HTTPS 證書、Host fingerprint 與 Tailscale 的預設用戶流程。
- OpenCodex 與 CC Switch 對外介面的長期穩定性與授權邊界。

## 二十二、完整體完成定義

只有同時達成以下條件，才可宣告「跨平台完整體」：

- Web/PWA 仍可完整使用核心功能。
- macOS、Windows、Linux 有可安裝的 Host + Client。
- iOS/iPadOS、Android 有可安裝的 Client。
- 所有 Client 使用同一個 Stepsemble Protocol 與 Host session source of truth。
- 已支援 agent 的 session、history、streaming、approval、stop、resume 等級被明確標記並通過對應 contract tests。
- 多 Client 同時連線不造成事件丟失、重複動作或 approval 越權。
- 官方訂閱、外部 API、router 與計費來源清楚隔離。
- 安裝、更新、資料遷移與回滾在支援平台都通過。
- 長時間、崩潰、斷網、休眠與多任務測試通過。
- 使用者不需理解 harness/provider/router 內部實作也能安全使用預設路徑。

## 決策紀錄

| ID | 日期 | 狀態 | 決策 |
| --- | --- | --- | --- |
| D-001 | 2026-09-04 | Accepted | Web/PWA 永久保留為第一等 Client |
| D-002 | 2026-09-04 | Accepted | Host 與 Client 分離；mobile 初期 Client-only |
| D-003 | 2026-09-04 | Accepted | TypeScript 負責 Client/UI，Rust 負責長期 Host Core，Swift/Kotlin 僅作平台橋接 |
| D-004 | 2026-09-04 | Accepted | Rust 遷移現在開始規劃，但以 contract-first 漸進切換，不 Big Bang Rewrite |
| D-005 | 2026-09-04 | Accepted with gate | Tauri 2 是預設 App Shell，正式承諾前必須通過 Apple 實機 PoC |
| D-006 | 2026-09-04 | Accepted | Native agent session 優先為來源，Stepsemble journal 為持久、可回放投影 |
| D-007 | 2026-09-04 | Accepted | 官方登入/訂閱不複製，實際 auth/billing source 必須明示，無靜默 fallback |
| D-008 | 2026-09-04 | Accepted | OpenCodex/CC Switch 屬 Model Source/Profile 層，不是 Coding Agent |
| D-009 | 2026-09-04 | Accepted | Web 與原生 App 使用同一個版本化 Stepsemble Protocol |
| D-010 | 2026-09-04 | Accepted | 產品名定案 Stepsemble；Step Mosaic 以四個等權 agent 模組與共用 coordination layer 為識別；v3 以 additive migration 保留 Pi Harbor/Pi Web 相容 |

## 變更記錄

### 2026-09-06 — Plan 1.30

- 同步兩台 Mac 的3.0.5正式部署與更新器狀態，保留歷史版本記錄。
- 下一批按使用者同意，先修 Windows stop/reconnect，再補隔離恢復與長對話效能驗收；邊界見 `agent-stop-reliability.md`。
- 停止改成等待已驗身分的控制連線與程序退出、合併重複要求；未確認不標停止、不殺持久 PID，逾時可重試。首輪本機333tests：331pass／2skip，尚待新 source 的跨平台 CI。
- `ae0cebc` 三OS／雙OS rolling 已通過；3.0.6候選補上還原衝突／Host重啟／sidecar保留、chat stop錯誤回饋、選取清單不重建；Chrome單輪first-open195ms與warm-reopen72ms保留量測條件，不作受控百分比或全平台順滑度宣稱。完整trace export仍受工具限制。

### 2026-09-06 — Plan 1.29

- Web 3.0.4 stable已公開並在Mini啟用，release source `4c144ad994ed9e1538c4a0c35655e063eb89152d`。CI34018959542三OS331tests零fail；Rolling34018995751兩OS各12cases；Release34019119879成功。原图完全不重繪。
- CUA真瀏覽器驗收390／320／1440px、淺暗／繁體、5000則合成歷史、未送草稿reload保留。抓到mobile返回後放大露出舊chat，已修全viewport清空及session identity並補行為測試；CI先被過時desktop-only smoke assertion擋下，修正後重跑全綠。不是Safari／實機或效能分數認證。
- 正式HTTP/HTTPS與archive/source逐byte相符，GitHub兩個品牌archive同digest、checksum及指定release workflow provenance驗過；內建update/run一次後up_to_date/3.0.4/error無。Web token/模型設定/SSH及helper未變，25份原生session path/size/mtime一致。3.0.3及rc.3回退副本保留。
- MacBook Pro仍3.0.0，relay health可達、RPC/task0，updater installed=false；SSH權限拒絕，不改登入／不繞過。其補裝、owner Claude登入、真模型／native parity／durable/Rust/Apps／實機與72h仍未完成。完整交付紀錄 `web-release-3.0.4.md`。

### 2026-09-06 — Plan 1.28

- Owner 明確要求既有成果與定案 logo 上線，授權可回滾 Web 部署／正式 release；不再停在 rc.4 啟用確認。未授權自動重登入、憑證搬移、模型重試或商店上架。
- 3.0.4 使用原圖派生的彩色 icon 取代一般畫面的單色 mask，新增常駐 workspace 品牌與獨立主機列、具文字的新專案按鈕；手機 Agent chips 換行，主要按鈕44px、搜尋／欄位 labels、鍵盤與 reduced-motion/transparency 支援。
- 修復 Agent catalog/task 的 stale-host／finally 競態；切主機與登出清快照／取消請求。只有404可 legacy Pi fallback，其他錯誤不假裝已安裝，未驗選項禁止啟動。
- Service Worker 預快取彩色 logo，清除範圍只限產品自己的舊 shell。母圖／icon 原始 bytes 不變。回歸、部署與未完成邊界見 `web-release-3.0.4.md`；正式成功狀態須驗證後另記，未降低 native／durable／Rust／Apps gate。

### 2026-09-06 — Plan 1.27

- Jerome同意修復Failed誤報／名稱不一致並補回歸。Pi0.84.2正常SIGTERM可exit143；舊mapper以非0判failed。現在先記錄Host自己的idle close intent，保留未知signal／protocol fault／active exit與已觀測model failure，不全面忽略143，不把只是看歷史當作completed run。
- 將送出前pending work、native fresh state、clients／UI／compaction／queue與revision納入close gate，關閉中拒收新訊息；async metadata後重檢同file writer與capacity。Legacy更新gate也看得到尚未agent_start的工作。沒有model retry／帳號操作。
- 增加獨立firstMessage，保留preview原用途；最新session_info含清空優先；list／Hub／detail／search／export統一標題，開既有file不採用caller display name改native名稱。共用strict TS helper與checked-in JS，保持runtime無依賴。
- 新增synthetic HTTP競爭、143／crash／失敗／名稱／pagination／history byte-preservation與1440／390實際browser cases。SSE detach晚於close時保留Waiting是正確防護；browser case明確等待detach再走idle close邊界，不冒稱返回必定立即kill。
- 本機319tests／317pass2Windows-onlyskip／0fail；strict TS／artifact／syntax／version／Ajv1251cases皆通過。Pinned Chromium153.0.8010.12的8組rolling＋2組既有Claude auth UI＋2組Pi session UI全過；跨OS需核對本批新commit CI。
- 第一個commit65d7295在CI34014570496的Windows因新artifact未固定LF而被byte一致性gate擋下，macOS/Linux與Rolling34014570478兩OS各12cases過。後續將public/modules/*.js統一LF並補policy回歸／rolling path gate，保留嚴格byte檢查，不略過Windows；需看後續commit結果。
- Source候選rc.4使用獨立cache identity；未部署／未重啟正式rc.3、未public release／真實帳號模型／history migration。各次CI需看exact commit；完整durable journal、其他native adapter／Rust／Apps等既有gate不因本修復完成。細節 `pi-session-lifecycle.md`。

### 2026-09-06 — Plan 1.26

- 同日後續Web啟用：Jerome回「好啊」批准無任務可回滾更新。Exact `f5455e1` 的CI33983687302三OS全綠、Rolling33983687313兩OS各8+2cases通過後，Mini正式Web由3.0.3升3.0.4-rc.3；保留SSH、helper/CUA未重啟。實際HTTP與Chrome UI detected/liveVerified=false，cache升級、1440/390px、reload/manual refresh不觸發auth，25份session inventory及12份保護設定/品牌SHA一致，3.0.3與更舊備份保留。未做真實login/logout/model／其他裝置rollout／stable release；細節`baselines/claude-web-activation-2026-09-06.json`。以下為先前實作/安裝時的歷史。
- Jerome同意實作桌面Claude元件，保留SSH主Web。採owner-only Unix socket＋獨立本機IPC key、固定command/env/roots、Aqua LaunchAgent。Apple TN2083與本機launchctl/man核對，不設定SessionCreate、不以刪SSH旗標假裝GUI。Node過渡launcher重用既有supervisor，不改長期Rust／TS邊界。
- 登入與task啟動同一助手仲裁；prepare票60秒／單次／instance綁定，啟動前fsync不確定性標記，丟回覆只重接不重開；無法核對的launch/auth標記fail closed。任務既有socket／64KiB tail不變，不冒稱完整session/history/approval或durable journal已完成。
- Synthetic測試涵蓋私有IPC、權限／Origin／大小／字段／workspace、互斥／過期／重啟／丟回覆／無fallback，並補native metadata child不退出時的有界deadline與不重複spawn。修正取消狀態在最後一次status中完成、但shutdown未flush而誤報recovery的race。
- Mac真GUI離線probe初次因launchctl kickstart的5秒deadline撞30秒節流失敗；核對owned processes退出後改45秒上限，新一次驗證metadata與task均Aqua，Web/helper restart reattach且僅1次launch。只用假CLI，沒有native帳號／模型。
- 獨立helper首次安裝成功；真實SSH client manager=Background，helper context=Aqua，官方Claude既有metadata detected／liveVerified=false。没有真實login/logout/model、憑證搬移、ACL或Keychain unlock；主Web服務3.0.3未重啟，沒有跨裝置rollout／stable release。
- 新增同一task兩张prepare票的effect-boundary防重複回歸，並同步剛安裝的助手。本機313tests／311pass2skip／0fail，syntax／strict TS／artifact／version／Ajv1251通過；新commit跨OS與rolling需查各自CI。完整安全／安裝／回滾／限制見`claude-desktop-runner.md`。已另詢問Web安全更新，不將助手安裝等同正式UI更新；新的模型用量尚未授權。

### 2026-09-06 — Plan 1.25

- Jerome同意安全更新試用；建立rc.1獨立version/cache，commit0dc884e，regular33979722911三OS與rolling33979722927兩OS皆綠。僅Mini本機installer；保留SSHlauncher、舊backup與CUAservice，無GitHub release／其他主機rollout。
- 真實人工gate發現同user/HOME/native2.1.259，在Aqua桌面metadata detected，在Background SSH卻signed_out；去掉SSH旗標仍相同，Keychain default/search paths亦相同。未呼叫model、login/logout、讀出OAuth秘密、改ACL／unlock／搬token。這是執行環境差異證據，不把CLI false當使用者再次登出，也不宣稱完整Keychain根因已證明。
- 已安全還原正式3.0.3；25個session檔案inventory、Web token、模型／Claude／Codex設定、SSH key/launcher/plist、品牌SHA一致。Chrome隔離頁觀察SW/cache先升rc.1再回3.0.3；rc.1程式保留供檢查，非部署成功gate。
- rc.2新增known macOS SSH的desktop_required fail-closed及測試，不自動改認證儲存路徑。下一步需另行同意受限desktop runner/helper，涵蓋登入和真正Claude工作程序，不可只修status讓SSH工作仍看不到原生登入；主Web服務SSH保留。完整紀錄claude-sign-in.md與trial baseline。

### 2026-09-06 — Plan 1.24

- Jerome已自行重新登入Claude，要求Stepsemble提供登入入口。唯讀官方2.1.259 metadata已偵測到claude.ai；沒有再次官方login、模型呼叫、改路由、重跑前次attempt，也不將09-05失敗改成成功。
- 新增官方Host登入handoff：固定CLI參數、metadata能力檢查、auth URL/code/token不轉送、single-flight/快取/上限、單一intent防重送、task launch互斥、cancel/timeout/shutdown僅清理owned child、Windows shim tree清理。不是自有OAuth／Agent SDK；也不是durable auth recovery。
- Agent Hub中英登入面板、Host名稱與共用憑證確認、未知≠登出、metadata≠模型連通、操作歷史與目前credential分開、切主機/頁面reload不重送、44px按鈕；手機連Mini仍須Mini瀏覽器。法律與認證資料查證影響設計邊界，詳見`claude-sign-in.md`。
- 本機301tests/299pass/2skip/0fail；8組既有rolling＋2組新auth UI案例通過，完全synthetic/isolated。新commit跨OS結果需核對CI；正式服務3.0.3未部署／重啟，原生adapter/approval/history parity、Rust/Apps與長期gate仍未完成。

### 2026-09-05 — Plan 1.23

- Jerome同意各1次原生訂閱最小驗收；官方Claude2.1.259顯示登入但真正唯一attempt回OAuth過期／更新失敗，自己的新history保留user與synthetic auth error，四項native usage皆0；沒有重試／login／logout／API billing fallback。不是成功stream/history驗收。
- Codex0.153.3只做app-server preflight，未送turn/start；檢出有效user config的本機API代理與project cap0仍載入1份全域指令。核對官方schema／文件／exact版本source，保留帳號／設定／wrapper；最後guard在route階段就停止。空native threads可能保留，未改寫歷史，不將preflight當model failure。
- 新增純手動`probe-native-subscriptions.mjs`（不接npm scripts或CI）：explicit mode、精確native版本、環境白名單、route／source guard、wx＋sync一次attempt marker、bounded frame／owned child cleanup、白名單失敗摘要、unknown與observed0分開。全域指令不能靠project cap偽裝隔離；MCP dotted override必須用已驗bare key。成功路徑仍待實際驗證，不是產品durable ledger。
- 新增12項offline guard回歸與去識別結果報告`native-subscription-smoke.md`／baseline JSON；前後settings/config SHA一致，正式health3.0.3/uptime86592，未重啟／部署，沒有搬憑證。最終Codex僅提供preflight、關閉hooks/snapshot/memories；native指令與工具隔離審查完成前不提供model turn入口，不能把never approval或事後tool檢查當執行前防線。
- 修改前基線`6a0ddd4`的CI33970842907三OS270tests與Rolling33970842871兩OS各8cases皆過。本批本機282tests／280pass／2skip／0fail（11.5秒），syntax／strict TS／artifact／version／Ajv1,251cases皆過；新commit跨OS與rolling結果需核對各自workflow，不能沿用上一批。

### 2026-09-05 — Plan 1.22

- 根據當日OpenAI官方App Server文件與實際安裝CLI，新增Codex0.153.3離線metadata gate：18schemas SHA-256/byte counts、99 client requests/10 server requests/81 notifications，exact version/hash/catalog漂移拒絕；全新HOME/CODEX_HOME/cwd，只執行version和generate-json-schema，沒有app-server startup/模型/登入/session讀寫。
- 本機`codex`是OpenCodex wrapper，native link指向ChatGPT app內binary；本probe用明確native binary，不修改wrapper或user config、不繞過實際應用路由來冒稱整合成功。保留官方原生request/resolved只是answered-or-cleared、不可當approved/success的邊界。文件`protocol/native/codex/README.md`。
- 這是macOS arm64 metadata證據，不是Codex live adapter/full history/approval/multiversion/crossOS。新增3項普通CI測試檢查catalog/格式漂移/環境隔離，實際native generator需明確提供受信binary，不在普通CI假冒執行。
- 本批本機270tests／268pass／2skip／零fail，strict TS、artifact、syntax、version與Ajv1,251cases皆過；native schema隔離record後再次check一致。
- 已核實43379f4／CI33970245094三OS267tests/0fail，以及Rolling33970245044 clean-source macOS/Linux各8cases/合計16cases全綠，Chromium153.0.8010.12。正式3140仍3.0.3、health ok/uptime82947，品牌SHA不變。模型用量授權尚未收到，不越過訂閱/部署/實機gate。

### 2026-09-05 — Plan 1.21

- 新增`test:rolling`實際Chromium test：固定已發佈v3.0.3/dc9b693、v3.0.2/6791f20 fullcommit並核對tag，不把當前模組假裝舊Client。Git archive與全套Client assets/真實Host在localtemp；2版本×雙方向×1440/390 viewport＝8cases，登入表單、Unicode history、stream/stop、手動deny、reload自動restore全部本機過。
- 每case新HOME/PI_HOME/isolated Chromium profile，synthetic Pi必須精確2prompts/1stop/1reply，無外部browser HTTP/JS runtime errors；currentClient到舊Host確實404 handshake fallback，舊Client不發handshake。SDK既有401/426/timeout不得downgrade另有回歸。
- Playwright1.63.0/test-only SHA-512 npm lock，disabledscripts/emptyconfigs，browser/deps都localtemp；不接真實帳號、不動正式Host。新增macOS14/Ubuntu24.04 workflow；歷史Host Unix launch、不宣稱Windows。SW阻擋避免替換frozen assets，故不含PWA offline/cache/實機/效能/未發布journal能力。
- 本機267tests/265pass/2skip、strictTS/artifact/syntax/version、Ajv1251cases過。前批1938a5d／CI33969459063三OS全綠264tests/0fail；本批需看新的regular/rolling workflow，不沿用舊綠燈。

### 2026-09-05 — Plan 1.20

- 新增Host-only `planObservedEvents`：一次最多500筆／16MiB exact normalized facts，綁定已驗runtime/session/run；Host自派envelope、整批projection和receipt關係一起檢查。拒絕混入decision/ACK/terminal/model/session effect；resume/reconciliation須同一verified proof binding。這只是純接入邊界，沒有實作native identity/proof service，也不接受Client boolean作權限。
- 固定30-step synthetic transaction JSON，覆蓋全部8commands、歷史/思考/tool/approval、原生確認、terminal、compact/archive/restore、backup quarantine與read-only replay／新intent拒絕；保存完整rows/outbox/events/digests/CAS。Tests只比對，不自動更新expected；跨語言reference不是native／durability證據。
- 已確認上批e83f545 regular CI33967509737與Native Pi offline contract33967509738皆三OS全綠；後者為實際Pi0.84.2 CLI：macOS14 arm64、Windows2025 x64、Ubuntu24.04 x64，各57frames，Linux audit零已知漏洞。不是model/tool/登入/訂閱驗收。正式服務與品牌仍未動。
- 本批本機264tests／262pass／2skip／零fail，strict TS／artifact／syntax／version／1,251-case獨立conformance皆通過；新commit的三OS結果需另外驗證。

### 2026-09-05 — Plan 1.19

- 新增隔離 `test:native:pi:runtime` 與固定0.84.2/test-only package lock；每次依賴/npm config/cache/agent/session全在本地temp，不安裝到SMB、不改既有Pi、不讀native登入、不呼叫模型。安裝scripts停用，來源限定public registry，全部tarball必有SHA-512。
- 上游shrinkwrap漏6個first-party子包integrity，lock generator從精確name/version/tarball的官方npmmetadata補齊，不降低CI校驗、不浮動版本。新增source/version/hash/link負例；local audit零已知漏洞，並以全新安裝Pi成功重跑57-frame真實離線fixture。
- 新增獨立`Native Pi offline contract`三OS workflow，按相關paths觸發／可手動跑；跨OS結果必須看該次workflow，不能以byte replay或本機Mac成功代替。本機260tests/258pass/2skip、fresh native57frames／audit／strict TS/artifact/version checks通過；上批3108ee0／CI33966713093三OS全綠，257tests／零fail。正式3.0.3、訂閱、品牌仍未動；模型/tool/登入/原生全版本/長時間/Apps等仍有未完成gate。

### 2026-09-05 — Plan 1.18

- Admission覆蓋全8commands；model/archive/restore/compact以pending receipt保留共享互斥位置，accepted/dispatching/uncertain都不放行新run；rename一次僅一筆未確認。Outbox只加明確operation binding（model profile/archive ID/context run），不接受任意路由設定。
- 原生／本機effect確認後才改title/profile/archive/context；correlated interrupt ACK不代表terminal。Model target immutable／fork防線；restore精確ID／archive不重用ID；compact必須Host明確提供context owner，不以array order猜測。失敗interrupt的新明確key可重新要求，絕不自動retry。
- Terminal proposal先cancel/expire所有pending approvals，再保留partial history並終結run；current-store accepted命令確定未送才reject，attempted delivery留uncertain，不把自然完成推論為stop成功。Backup quarantine下accepted仍保留不確定性；runtime/evidence truth依舊須真實adapter/store驗證並落盤。
- 新增11tests，全套本機257tests/255pass/2skip；上一批5de5c81／CI33965895866三OS全綠，246tests。正式服務／訂閱／品牌不動，reference transaction planners不等於durable IO/native parity/整個計畫完成。

### 2026-09-05 — Plan 1.17

- 補齊 start ACK／verified native not-applied failure／current-store predispatch rejection＋unstarted writer cleanup／delivery uncertain＋orphan 等多列 proposals。Receipt success 不是 coding run completed；失敗key留原receipt，不自動retry，新的明確command才可新開run。
- 只有尚未dispatch且current非quarantined store才能視為未送出；marker之後須verify not-applied或留uncertain。Approval delivery failure不反轉用戶decision、不偽造ACK、不resume。已知startup的late ACK可記錄；未知startup且已stopping/orphaned/terminal則要求reconciliation，不復活writer。
- 新增6tests，正常／延遲ACK、rejection／backup／dispatch barrier、failed-key replay、unknown與verifiedfailure、latecleanup rollback；全套本機246tests/244pass/2skip、strict TS/artifact/versionchecks通過；前批 `d7ac60a` CI33965309286三OS全綠（240tests、零fail）。未部署／未改帳號／品牌，純proposal仍不是durable/native-proof驗收。

### 2026-09-05 — Plan 1.16

- 新增 Host-only `protocol/transaction-state.js`：將 start／approval winner、profile lock、receipt、exact private outbox、journal events 和 cursor 組成一份 detached proposal。完整 store ID／generation／revision／cursor read set；不能用 proposal 直接 native IO。
- Dispatch attempt／native incarnation fence、pipe acceptance、correlated approval ACK 與 receipt 一起提交；late terminal ACK 不復活 run、不自動 resume。Current-store recovery 把 in-flight 設 uncertain 並保留 orphaned writer；backup／unknown 連 accepted 都 quarantine，無自動解禁。
- 13 項新測試：雙裝置不同 key 的 writer／approval 勝者、全套 row/outbox 關聯、late invalid rollback、dispatch race、ACK proof／nonce／incarnation、async input mutation、backup 隔離。全套本機 240 tests／238 pass／2 skip；上一批 `646793d` 227 tests 三 OS CI 已全綠。
- 此批是 reference transaction planners，不是 durable store／native proof service；其餘 6 commands、start confirmation／failure／predispatch rejection／cleanup／terminal／maintenance builders 仍待補。正式 3.0.3、訂閱與品牌未動。詳見 `protocol/v1/transactions.md`。

### 2026-09-05 — Plan 1.15

- 實作 strict TS 完整 normalized history projection，35 variants 明確處理；message completion 取代串流文字、保留 thinking；tool progress／output 分開；usage absolute、context unknown limit 保持 null。中斷／未見 final 保留 partial＋incomplete，不偽造成功或取消。
- 全批 detached staging＋scope／generation／sequence／SHA-256 event integrity；任何一筆失敗整批不套用。5,000 identities 的 floor 明確化，過舊重送要求 snapshot，不刪歷史、不盲信 sequence。
- Complete checksum snapshot／明確 generation replacement、同 generation 不倒退；in-memory replica 增加 local revision fencing，修正 cursor-only CAS 無法阻擋同游標 snapshot 修復後舊回應覆寫的問題。Hash 是完整性校驗，不是身份或 native evidence。
- 32 MiB state／16 MiB batch／明確 row 與 Unicode 上限、非 JSON 圖形拒絕；新增 14 tests（全 events、每個 split、rollback、duplicate tamper、10k messages、5.5k rollover、async／雙回應競爭），全套本機 227 tests／225 pass／2 skip、Ajv 1,251 cases。
- 未部署、未改 live capabilities／native credentials／品牌；完整 projection 尚未接入 live UI。後續 receipt/entity/outbox 交易、durable store、authenticated transport、worker／paging／rolling／實機 gate 不因此完成。細節 `protocol/v1/projection.md`。

### 2026-09-05 — Plan 1.14

- 新增 `client/lifecycle.ts` strict TypeScript 純 entity reducers，Node 與 browser 使用同一 checked-in JS artifact；保留既有 Node/PWA runtime 和語言邊界。Canonical `sessionState/runState/approvalState` 包含 revision、time、profile snapshot、archive identity、decision/device/receipt／native acknowledgement 等投影 metadata，不是完整 history snapshot。
- Reserved event union 29 → 35：新增 session restore、run stopping／orphaned／resumed／reconciled、approval acknowledged；resolution 必帶 receipt ID。尚未廣告／上線的領域可收緊，live handshake 仍 1.0.0、capabilities 不變，舊 HTTP／SSE 不受替換。
- 明確 orphaned 為非 terminal、保留 writer；late started 不復活 terminal，stop intent 不被 reconciliation 清除。Approval decision 不等於 native ACK，ACK 不自動 resume；pending request 必須明確取消／到期後才能寫 terminal run。已知 route/auth 變更要求 fork；完整 provider/protocol resolver 仍在 Phase 7。
- 相關 writer／unsettled approval 必須明確、完整、scope/revision/time 一致；ID／nonce availability 不得缺省。64 KiB decoded row/event、64 層／8,192 nodes、32 unsettled admission gate；拒絕 native request alias、非 JSON graph、超出毫秒精度或倒退時間。Future transport 仍需在 parse 前限制 bytes。
- 新增 14 tests，含 10 session／90 run／20 approval 狀態組合、正常流程、stop／late ACK、orphan recovery、防竄改與記憶體多列交易競爭模型。本機完整 213 tests＝211 pass／2 Windows-only skip；strict TS／artifacts／syntax／version 與 1,179-case Ajv 通過，跨 OS 以此批 CI 為準。
- `protocol/v1/lifecycle.md` 記錄多列 CAS／journal／receipt／outbox 原子提交門檻。Reducers 消費已授權的 journal facts，不驗登入或 native evidence 真實性、不派送／持久化；真實交易、完整 projection/snapshot、durability／rolling gate 仍未完成。正式 3.0.3 未部署／重啟，品牌和官方帳號／訂閱不動。

### 2026-09-05 — Plan 1.13

- 新增 reserved `commandReceipt` 閉合 schema、Node/browser 共享語意檢查與 strict TS parser；只存受限識別碼、摘要和證據 reference，不存 prompt／credential／本機路徑。Receipt success 代表該 command 效果已核對，不代表整個模型 run 完成。
- `protocol/command-state.js` 提供純 admission／replay／transition／recovery proposal。8 個 command 使用凍結的 UTF-8 SHA-256 tuple 指紋；同 key 不同 intent 拒絕，同 intent 重送回傳原 receipt，但每次仍需 Host 新鮮授權。兩個索引必須明確讀取，缺失／互相矛盾／外來 scope fail closed。
- 6 狀態 × 5 操作共 30 個組合測試；revision／attempt／時間與 evidence shape 防護，terminal 不重開、結果不明不自動重送。Current crash-consistent store 的 in-flight receipt 轉 uncertain；restored backup／unknown origin 所有狀態先隔離核對，不能把舊 accepted 當成確定尚未執行。
- 詳細契約見 `protocol/v1/command-state.md`。Pure proposal 必須由未來 store 原子提交後才能派送；native ACK／權限／證據真實性、approval winner、durable journal/outbox 與完整 entity reducers 均未實作。記憶體競爭模擬不是 SQLite／crash durability 證明，不能宣稱外部 exactly-once。
- 新增 12 項測試，本機完整 199 tests＝197 pass／2 Windows-only skip；strict TS／generated artifacts／syntax／版本與 853-case Ajv conformance 通過。跨 OS 結果以此批 commit 的 CI 為準。
- 未增加 live endpoint 或 advertised capability；handshake 仍為 1.0.0，SDK 無自動 side-effect retry。正式 3.0.3 未部署／重啟，品牌、帳號與訂閱未更動。

### 2026-09-05 — Plan 1.12

- 新 Web 在 Pi SSE 明確請求 `uiSnapshot=1`；Host 的 named `connected` 包含有版本／sid 的完整 pending 清單（包括空清單），不附 SSE id、不改 conversation cursor。Opt-in replay 略過歷史互動 UI／close，避免舊 ID 的 close 撤銷目前 snapshot；live lifecycle 照常傳。舊 Client 不帶參數時保留原路徑，新 Client 連舊 Host 也可用既有 connected／onopen fallback。
- Strict TS queue 整份驗證、count/byte bounds 與 duplicate ID 檢查後才原子替換 scope；保留未變 request 的 draft／in-flight identity，移除失效或已變更 request；其他 Host／session 與 provider 登入秘密不受影響。
- Native SSE callback／timer 加入 connection object＋view generation＋Host＋EventSource identity 防護。已協商 full snapshot 的連線失敗時停用回覆，驗證完整 snapshot 後再恢復，不因 transport-open 就重新啟用；仍無自動 side-effect retry。
- 隔離 HTTP 用8,100筆合成事件真正擠出8,000-event ring，驗证完整／部分／空 pending-set、cursor neutrality、live close 與 native ID reuse；controller 覆蓋壞 snapshot 不部分套用、draft／provider保留、in-flight late result 與舊 stream。完整本機187 tests＝185 pass／2 Windows-only skip；strict TS／artifact／syntax／版本與802-case Ajv通過，跨OS需看此批CI。
- Chrome390×844雙頁面驗證：受控 SSE 關閉／error 注入＋Offline 阻擋重連，另一頁回答並rollover，恢復後只保留有效input草稿，下一次完整空清單關閉失效sheet／清掉草稿；沒有自動送出。CDP Offline 本身不會可靠中斷已建立SSE，故不把網路切換單獨當斷線證據；測試是synthetic fault injection，不是實機／效能驗收。證據 `docs/baselines/native-ui-recovery-2026-09-05.json`。
- 正式3.0.3未部署／重啟，native帳號、訂閱與品牌不動。這只修復同一Host process內pending UI投影；Host restart／upstream未回報取消、durable approval／full journal、stateful idempotency、rolling matrix、Rust／Apps仍未完成。

### 2026-09-05 — Plan 1.11

- 新增 strict TypeScript native dialog queue 與 checked-in browser artifact，32 requests／64 KiB per event／256 KiB replay，Host＋session＋request 隔離與 FIFO；重複 snapshot 不清草稿，queued expiry／close 只移除對應請求。
- Native 送出改為等待 pipe ACK、12 秒 deadline、阻擋重複送出與舊 click；失敗／結果不明保留內容讓使用者手動重試，不自動重播 side effect。其他 client close 優先於遲到的 HTTP 回覆；已知404／409清掉失效請求。
- Provider 登入 sheet 暫停 native input 並在關閉後恢復；登入秘密不放 native queue／localStorage，切 Host／登出只 detach 舊登入 UI，不改官方 credentials。離開聊天與 legacy close endpoint 保護 pending Pi；頁面 reload 草稿仍非持久化。
- Pi RPC／models／version 共用 launch helper；Windows PATH大小寫與分隔符、absolute `.cmd` 參數邊界、literal `.js` fallback、無二次 detached console、bounded owned-tree taskkill。含 shell expansion 的 shim path／argv 明確拒絕，需使用者明確指定 direct CLI，不繞過第三方 wrapper。
- 本機181 tests＝179 pass／2 Windows-only skip；802-case Ajv／strict TS／generated artifact／syntax／版本檢查通過。新增 Windows argv 與跨平台 HTTP fixture（不再 skip Windows），需以該 commit 的 CI 結果確認，不把本機 skip 當 Windows 成功。
- Chrome mobile emulation 實際 Offline/online、FIFO、手動送出／取消／false、2 replies／無自動重試通過；provider preemption／stale結果由隔離 controller tests 覆蓋，不做真實登入。正式3.0.3未部署／重啟、品牌與訂閱不變；完整 durable／rolling／native adapter／Rust／App 路線仍未完成。

### 2026-09-05 — Plan 1.10

- 用已安裝 Pi 0.84.2、隔離 agent dir／cwd／明確空 session 檔、offline／no resources 與 synthetic extension，取得 57 個脫敏 native 封包；確認／拒絕／取消、select／input／editor、timeout、unknown ID／command、已落盤 session 重讀通過，不呼叫模型或讀訂閱憑證。
- 明確記錄上游 lazy session 尚未落盤不能當成持久化，以及 custom-message timestamp 重建差異。真實 probe 只在 macOS arm64 跑過；跨平台 byte replay 不等於原生平台驗收。
- 修復 caller ID 蓋掉 RPC correlation、其他 session 回覆可誤解 pending promise、`confirmed:"false"` 被轉為 true、畸形 native JSON 影響 Host；pending command 限 64／session，錯誤回覆 bounded／不反射原文。
- 新增 process-lifetime pending UI map、嚴格 method／選項／timeout、第一個有效回答勝出、重連 snapshot 不推進 cursor、已回答 dialog 不再重播、`extension_ui_closed`、跨 host 舊回答阻擋、draft 去重保留。Pending dialog 不再被 idle／stuck update gate 當空閒；signal-only exit 不再觸發延遲重複 kill。
- 本機 170 tests＝169 pass／1 Windows-only skip；strict TS／artifact／syntax／version、802-case Ajv 及真實 native probe 通過。Chrome synthetic replay 驗證重連／另一 client 回覆 false／關閉／draft 保留與清除；不宣稱效能基準或真實訂閱 parity。
- 未部署／未重啟正式 v3.0.3，不動品牌母檔與 native auth。Durable journal／approval、Web 多 dialog 佇列與失敗送出恢復、Pi Windows 原生 launch、rolling matrix、Rust／Apps 仍未完成。

### 2026-09-05 — Plan 1.9

- 補齊 29 event／8 command discriminated payload 與 synthetic fixtures；event generation、command device／protocol version、approval nonce／createdAt／native request reference 納入 reserved schema。
- JSON Schema 與 TypeScript declarations 共源產生，加入 type narrowing 正負向 compile assertions；修正 `$ref` sibling constraint 與尾端換行可繞過 ID pattern 的問題。
- 新增 Node/browser pure domain checks：跨實體 ID、approval Host time／nonce／scope、active writer／model lock、profile auth/billing 與 generation-aware replay batch。整批通過才回傳可套用事件；缺號／未知類型要求 snapshot，不靜默前進 cursor。
- 獨立 Ajv 8.20.0 Draft2020-12 conformance 802 cases 通過；pinned lock、禁止 install scripts、local temp install，CI/release 增加 gate，不增加 Host runtime dependencies。最初 8.17.1 經 audit 發現 `$data` ReDoS advisory，未使用該功能也仍改至 8.20.0；目前 lock audit 零已知漏洞。
- 尚無 durable storage／原子 approval winner／native ACK delivery／真實 SSE journal endpoint；不得把純函式 preflight 說成已解決 crash／多裝置競態。官方帳號與正式服務維持不動。
- 本機 161 項回歸（160 pass／1 Windows-only skip）、strict TS＋型別正負向 assertions、generated artifacts、802-case conformance、syntax／版本檢查通過。正式 health v3.0.3／uptime57912，未重啟。

### 2026-09-05 — Plan 1.8

- 可靠性修復 `26c4fbb` 的 Windows 測試遇到 CRLF source extraction 問題，`29ec18e` 已修；[CI 33949171058](https://github.com/seehow624/stepsemble/actions/runs/33949171058) 三平台全綠，不略過失敗測試。
- 新增 canonical schema 的 dependency-free vocabulary validator 與 browser generated artifact；CI/release 會核對來源／產物一致性。支援的 schema vocabulary 以外採 fail-closed，不宣稱完整 JSON Schema engine。
- Node/browser 對 session/run/approval/profile/event/cursor/command/page 等保留 shape 共用 fixtures＋負向測試；SDK 提供 typed parse。這不是 native agent domain endpoints 已實作。
- Web JSON API 接上 connection-time handshake：per-host coalescing、60秒快取、10秒timeout、caller abort隔離、401時失效；只允許404 legacy fallback，缺transport capability或不相容版本明確拒絕。
- strict negotiation response validation 接受 additive 1.x schema minor／limits fields；缺必填、重複capability、交集矛盾及錯誤major不靜默接受。
- Phase1仍缺discriminated payload語意、獨立validatorconformance、nativegoldentranscripts與replay/rollingmatrix。未部署正式服務、未更動官方登入／訂閱設定。
- 本批本機155項=154 pass／1 Windows-only skip；syntax、strict TypeScript、canonical artifact及version checks通過。Chrome synthetic登入→handshake→sessions／300則history→RPCready成功；426阻擋agentopen、404允許legacyAPI，無consoleerror。

### 2026-09-05 — Plan 1.7

- 使用者授權處理整體檢視發現及既有待辦。本批先修復可重現的資料安全、重播、串流與 event-loop 問題，未重新設定語言／平台決策。
- 刪除不再於 Trash 失敗後 unlink；統一封存及 Undo，拒絕開啟中的 Pi session 與 symlink 導出。循環 parent chain、單筆超過 16 MiB 的歷史回覆 422，保留原檔且不再自動開啟該損壞 session。
- Pi stdout 按 bytes 分幀再解碼 UTF-8；IPC 有上限；SSE 使用 Node 有界寫入佇列，慢連線不再被靜默丟棄；supervisor snapshot cursor 與 replace 語意防止重複輸出。
- Git worktree 改 async execFile，最多 2 個並行、timeout／HTTP 取消可中止；失敗不再遞迴刪除部分 worktree。
- 長歷史離屏分批渲染、訊息合併單次掃描；翻譯 observer 只掃新增範圍並去除重疊祖先；修正聊天按鈕對比度與模型 accessible name。實測與限制存 `reliability-followup.md`。
- 本批不操作真實 provider/OAuth，不重啟 v3.0.3 正式服務，不改品牌母圖。完整 Protocol、native agent parity、Rust Host、Tauri／各平台 client 與上架都仍未完成。

### 2026-09-05 — Plan 1.6

- Chrome DevTools 已啟用，完成 301 synthetic sessions、長 session、600 deltas/30 秒、桌面與 mobile 4× CPU、network、accessibility 基線；結果與工具輸出已落檔。標準 TBT 與完整 raw trace export 缺口仍明確保留。
- 確認 Phase 2 優先問題：長對話開啟 INP 537 ms、串流完成 479 ms long task、mobile restore LCP 4859 ms/CLS 約0.12、聊天按鈕對比度不足。
- Phase 1 第一批：新增 `protocol/v1` schema/policy、negotiation golden fixtures、authenticated `/api/protocol/handshake`；僅宣告現有能力，不宣告尚未實作的 durable approval/journal。
- 新增 strict TypeScript SDK 與 checked-in JS，既有 Web `api()` 改由 SDK 處理；保留 auth UX、AbortSignal、204、legacy error 與 no-side-effect-retry。CI/Release 檢查編譯產物一致性。
- 本機 `npm test` 132/132、TypeScript strict/artifact check、語法與版本檢查通過；瀏覽器成功載入 120 列與最新 300 則長對話，無 console error。此為開發中的第一批，Phase 1 與完整產品路線尚未完成，未發佈新 release。
- CI 揭露此前 Windows run 已多次卡住到 6 小時取消。新增 test/file 60 秒、CI job 10 分鐘上限；修正測試的 PATH delimiter、大小寫／canonical path、CRLF comment parsing、signal-only exit 清理等待。
- Windows npm `.cmd/.bat` shim 改為受限 cmd.exe 啟動：只接受 resolved absolute path，拒絕 expansion/metacharacters；prompt 永遠走 stdin；停止使用 taskkill 結束該 child tree。此修正仍不代表 ConPTY／完整原生 agent parity 已完成。
- 新增 Windows launch contract 與 real-runner pipe IO 測試；確認 Windows CLI child 不再二次 detached，只有 supervisor 脫離 Web service；Unix process group 行為不變。測試覆蓋 spaced path、literal stdin、輸出串流、restart/reattach 與停止後 child/supervisor 實際退出，清理不再搶先刪除使用中的 cwd。
- 本機全套 135 項：134 pass、1 Windows-only skip；strict TypeScript/artifact check 通過。`2d5e6de` 的 [CI 33941315112](https://github.com/seehow624/stepsemble/actions/runs/33941315112) macOS／Windows／Linux 全綠；不把平台限定 skip 當成執行成功。線上 health 仍為 v3.0.3、服務未重啟，本批未建立正式 release。

### 2026-09-04 — Plan 1.4

- 品牌圖示由直白貓掌與 `>_` 改為 Step Mosaic，避免與既有 coding agent／terminal identity 混淆。
- 四個模組與四個藍紫內緣保持完全等權；品牌色表示 Stepsemble coordination layer，不表示 Claude、Codex 或任何單一 provider。

### 2026-09-04 — Plan 1.3

- Mac Mini 已由 Pi Harbor 2.13.2 原地部署為 Stepsemble 3.0.0；保留 SSH localhost 啟動模式，舊 app/plist 可回復封存，舊 config/bin 保留。
- 升級前後可見 session 8、原生 session 25 files／58,696,776 bytes、Web token hash 完全一致；`com.piharbor.cua-driver` PID 636 未受影響。
- Updater 增加 canonical repo 發佈空窗的 read-only legacy stable fallback，semantic version gate 實測不會由 3.0.0 降回 2.13.2。
- Mini launcher 的 restart gate 擴大到 generic agent task；檢查失敗採 fail-closed，token JSON 由 `jq` 正確編碼。
- Linux source installer 在 clean Debian/Node 22 container 完成；Windows installer通過 PowerShell AST parse。
- 重跑 Stepsemble 3.0.0 Host benchmark 並保留第二份 raw JSON；未見實務上的 rename regression。Browser trace 仍因缺 Chrome DevTools MCP 而 blocked。

### 2026-09-04 — Plan 1.2

- 產品名正式定案為 Stepsemble，補上語意、視覺識別、初步名稱碰撞檢查與正式商標檢索門檻。
- 將產品版本提升為 3.0.0；新增 `STEPSEMBLE_*`、新路徑、cookie、service label、PWA cache 與 `STEPSEMBLE3` pairing identity。
- 建立 Pi Harbor/Pi Web additive migration：private config、task snapshot、瀏覽器偏好、舊 cookie、環境變數與配對碼雙讀；新寫只用 Stepsemble；舊來源不刪除。
- macOS、Linux、Windows 安裝器加入舊服務辨識、active-work gate、健康驗證與可回復切換；v3 Release 保留舊 asset alias 供 v2 updater 跨版。
- 新增品牌／遷移回歸測試，當前完整測試為 127/127。

### 2026-09-04 — Plan 1.1

- 新增 `current-system-inventory.md`，盤點現行 60+ route、三種 event transport、auth scope、持久資料、狀態機、approval 缺口與各平台安裝/回滾行為。
- 新增可重跑、完全隔離的 Host benchmark 與 raw baseline；不載入任何真實 session、provider credential 或官方訂閱。
- 實測 301 個 session、41,000 則 message 與 8 個並行 generic task；將結果與限制寫入 `performance-baseline.md`。
- 明確記錄 Claude Code/Codex/Grok/OpenCode 目前只有 terminal integration，尚未具備與 Pi 等價的完整 session/history/approval。
- Browser performance trace 因缺少 `chrome-devtools` MCP 保持未完成；不以 server 數據冒充 Web 順滑度。

### 2026-09-04 — Plan 1.0

- 首次落檔完整跨平台計畫。
- 定案 Web 永久保留、Apple 優先、之後 Windows/Linux/Android 的產品順序。
- 定案 TypeScript Client/UI ＋ Rust Host Core ＋ Tauri 2 target shell ＋ thin Swift/Kotlin bridge。
- 將 session、approval、native auth/subscription、model source、第三方 router、效能、測試、發佈與回滾納入同一計畫。
- 將當前 Node/PWA 實作定義為過渡基線，禁止未受控的一次性重寫。

## 官方參考

- [Tauri 2 跨平台架構](https://v2.tauri.app/concept/architecture/)
- [Tauri 2 Process Model](https://v2.tauri.app/concept/process-model/)
- [Tauri WebView 版本與平台差異](https://v2.tauri.app/reference/webview-versions/)
- [Apple SwiftUI](https://developer.apple.com/swiftui/)
- [Apple App Review Guidelines](https://developer.apple.com/app-store/review/guidelines/)
- [Apple Local Network Privacy](https://developer.apple.com/documentation/technotes/tn3179-understanding-local-network-privacy)
- [Apple Keychain Services](https://developer.apple.com/documentation/security/keychain-services/)
- [Android Jetpack Compose](https://developer.android.com/develop/ui/compose/first)
- [Microsoft WinUI 3](https://learn.microsoft.com/windows/apps/winui/winui3/)
- [Node.js child processes](https://nodejs.org/api/child_process.html)
- [Node.js TypeScript support](https://nodejs.org/api/typescript.html)
- [Rust concurrency](https://doc.rust-lang.org/book/ch16-00-concurrency.html)
- [Tokio](https://tokio.rs/tokio/tutorial)
