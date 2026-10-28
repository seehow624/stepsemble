# Stepsemble（繁體中文）

[English](README.md) · [简体中文](README.zh-Hans.md) · 繁體中文 · [日本語](README.ja.md) · [한국어](README.ko.md) · [Türkçe](README.tr.md) · [Français](README.fr.md) · [Deutsch](README.de.md) · [Español](README.es.md) · [Português](README.pt-BR.md) · [Italiano](README.it.md)

Stepsemble 是開源、自架、手機優先的本機 coding agent 工作區。Pi Agent
目前使用原生 session 路徑；同一個介面也可啟動主機上已安裝的 Claude Code、Codex
CLI、Grok Build、OpenCode、Google Antigravity（`agy`）、Cline、Kilo Code、Oh My Pi（`omp`）與 Hermes。
Cline、Kilo、Oh My Pi 與 Hermes 若本機執行檔存在，會使用官方 ACP；不相容時安全回退有界通用 connector。

設定頁也提供受保護的 Harness 更新中心，可檢查與明確升級本機的 Codex CLI、Claude Code、OpenCode、Pi Agent、Oh My Pi 與 Hermes Agent。所有命令都來自白名單，執行中的 session／Agent task 會阻擋升級，不會被強制中斷。詳細策略請看 [docs/harness-updates.md](docs/harness-updates.md)。

## 隱私與安全

倉庫只包含應用程式碼與通用部署範本，不包含 token、工作階段記錄、專案檔案、私有網址、帳號憑證、模型使用歷史、用量統計或任何特定電腦設定。token 應保存在本機權限為 `600` 的檔案，服務預設只監聽回環位址，再透過 Tailscale Serve 或其他 HTTPS 閘道存取。

Stepsemble 會讀取 Claude Code 與 Codex 已存在這台電腦上的對話記錄，讓它們和其他對話一起顯示。macOS 與 Linux 預設讀取 `~/.claude/projects` 與 `~/.codex`；若要指定其他位置，可設定 `STEPSEMBLE_CLAUDE_PROJECTS_ROOT` 或 `STEPSEMBLE_CODEX_HISTORY_ROOT`。Windows 不支援，會直接回報無法使用，不會讀取這些檔案。

這些記錄是唯讀的，也不會離開本機：Stepsemble 不會寫入這些檔案、不會讀取憑證檔，只在通過驗證的請求指定某一則對話時才回傳內容。透過這個方式查看對話，不代表取得續跑、approval 或模型存取權限，這些仍然屬於各家自己的客戶端。

## 快速開始

在每一台要執行 Stepsemble 的電腦上執行：

```bash
/bin/zsh -c "$(curl -fsSL https://raw.githubusercontent.com/seehow624/stepsemble/master/install.sh)"
```

安裝程式會檢查 Pi Agent 與 Node.js、下載並驗證最新穩定 Release、建立
launchd 服務與自動更新。若沒有 Pi Agent，會先詢問是否透過 Pi 官方安裝程式加入；
選擇略過也能正常使用其他已安裝的 agent connector。

安裝程式會用這台 Mac 自己產生的憑證簽章 Stepsemble.app，放進 `~/Applications`。
在這台 Mac 上打開它就是 Workspace，會自動登入，也有 Mac 的選單、視窗和快捷鍵；
視窗和瀏覽器一樣沒有標題列，分頁列就在最上方、紅黃綠按鈕旁邊，拖動分頁列的空白處
就能移動視窗。手機和其他電腦照樣用瀏覽器。App 也負責啟動 Stepsemble，所以 macOS 只會針對
Stepsemble 詢問一次能否使用文件、桌面、下載項目、iCloud 雲碟和其他磁碟，之後
Stepsemble 或 Node.js 更新都不必重新允許。安裝完成時會打開 App 和「資料夾取用
權限」視窗：按「允許取用」，再逐一回應 macOS 的詢問。

Linux 可改用 `install-linux.sh`，會建立使用者層級的 systemd 服務與每小時更新計時器：

```bash
bash -c "$(curl -fsSL https://raw.githubusercontent.com/seehow624/stepsemble/master/install-linux.sh)"
```

Windows 可下載 `install-windows.ps1`，會建立使用者層級的工作排程（不需要系統管理員權限）：

```powershell
irm https://raw.githubusercontent.com/seehow624/stepsemble/master/install-windows.ps1 -OutFile install-windows.ps1
powershell -ExecutionPolicy Bypass -File .\install-windows.ps1
```

Linux 與 Windows 都需要 Node.js 22.19 以上；服務預設只監聽本機回環位址。

Linux 安裝程式會為你的帳號開啟一次 systemd linger，登出後 Stepsemble 仍會繼續運行，
手機也連得上。不想要可以加上 `--no-linger`；之後用 `loginctl disable-linger` 關掉，
也會維持關閉。Windows 如果開啟了「受控制資料夾存取」，安裝程式會說明如何允許 Node.js；
允許之前，Agent 無法修改文件、桌面等受保護資料夾裡的檔案。

「Add project」可以瀏覽的位置：macOS 是家目錄與 `/Volumes`；Linux 另外包含 `/media`、
`/mnt` 與 `/run/media/<使用者>`；Windows 是所有磁碟機。設定 `STEPSEMBLE_BROWSE_ROOTS`
會取代這些預設值。macOS 上的文件、桌面、下載項目、iCloud 雲碟與外接磁碟，需要 macOS
允許 Stepsemble 使用；資料夾被擋下時，「Add project」會在那台 Mac 上打開「資料夾
取用權限」視窗（也在 Stepsemble 選單裡），以前拒絕過的位置可以在同一個視窗打開
「完整磁碟取用權限」。3.8.26 以前安裝的主機更新後，會在沒有 Agent 工作時的第一次
更新檢查改由 App 啟動。透過 SSH 啟動（`stepsemble-mini-start.sh`）的主機維持原本
的啟動方式，App 只當它的視窗；這種主機或沒有 App 的主機，仍需要允許執行
Stepsemble 的 Node.js，這時「Add project」會顯示那個 Node.js，並可打開「完整磁碟
取用權限」。

## 從舊版本升級

v3 把改名視為「只增加、不破壞」的遷移：只有在 Stepsemble 對應檔案不存在時，
才會從 `~/.config/pi-harbor` 或 `~/.config/pi-web` 複製 token、裝置信任、工作記錄與
更新設定；舊來源不刪除，可供回滾。瀏覽器草稿、偏好、已選裝置、舊 cookie、
`PI_HARBOR_*`／`PI_WEB_*` 環境變數，以及 `PIHARBOR2`／`PIHARBOR3` 配對碼仍可讀取，
新資料才寫入 Stepsemble 名稱。

在支援的服務管理器上，只有 Stepsemble 3 回報正確版本且健康後，才封存舊程式與
服務檔。`~/.pi` 內的 Pi session、各家 CLI 自己的登入／session、Provider 憑證、
approval 與專案資料夾都不搬動。v3 Release 同時保留 `pi-harbor-*` 資產別名，讓舊
v2 更新器也能跨過這次改名。

安裝完成後，請在執行 Stepsemble 的電腦開啟終端機並執行：

```bash
cat ~/.config/stepsemble/token
```

將 token 貼到登入頁；從其他裝置使用時，也請從該主機安全地取得 token。若服務明確設定了 `STEPSEMBLE_TOKEN_FILE`，請讀取所設定的檔案，而不是預設路徑。絕不要把 token 寫入 Git、問題單、聊天、截圖或日誌。

在主機本機的瀏覽器首次開啟 Stepsemble 時，會提供類似冷錢包的一次性密鑰揭示導覽：密鑰只會在 loopback 連線上顯示——絕不會透過 Tailscale Serve、代理或其他裝置——並在你完成兩項確認後永遠不再出現。其他裝置一律使用已保存的密鑰或 token 檔案。

## 獨立存取令牌

如果一台電腦由多人或多台裝置使用，可在 **Settings → Access tokens** 中使用安裝主令牌建立帶標籤的獨立令牌。令牌只會顯示一次，可以單獨撤銷，伺服器只在 `~/.config/stepsemble/tokens.json` 保存 SHA-256 雜湊（權限 `600`）。它們仍是主機級憑證，不會建立獨立的 Pi 帳號或專案權限。

## 多台電腦

每台電腦都執行自己的 Stepsemble 實例。在每台額外電腦上安裝並啟動 Stepsemble，然後在 **Settings → Devices → Add device** 加入 Tailscale 或 HTTPS 網址。手動輸入網址仍是舊版共用 Web token 路徑，要求兩台主機使用相同 token。更建議使用五分鐘有效、只能使用一次的 `STEPSEMBLE3` 配對碼：確認候選裝置資料後，會建立獨立且可撤銷的對等憑證，不會把共用 token 傳給候選網址。可在裝置設定中查看並撤銷已授權裝置，撤銷會立即生效。Stepsemble 3 可接受舊主機的 `PIHARBOR3`，也保留需共用 token 驗證的 `PIHARBOR2` 過渡格式；舊客戶端必須先更新，才能讀取新的 `STEPSEMBLE3`。不要將公開的 3140 port 暴露給不受信任的網路。

登入 Agent：在該 Agent 的對話輸入 `/login`；`/logout` 和 `/status` 用法相同。Stepsemble 會在對話所在的主機執行該 Agent 自己的指令，並以終端機畫面呈現：登入連結變成按鈕、一次性代碼可以複製，輸入的內容會送回指令；API key、token、密碼這類輸入會自動隱藏，也會在輸出中遮蔽。在 Pi 對話輸入 `/login`，會列出 Pi 支援的服務商，可用帳號登入或 API key。

輸入框採用 Codex 的排版：左邊是附件和**核准模式**，右邊依序是 context 圓環、模型和圓形送出鍵。**核准模式**列出這個對話所用 Agent 自己的權限模式：Codex 是唯讀、預設、完整權限；Claude Code 是手動確認、自動接受編輯、規劃、自動、不詢問、略過權限；OpenCode 是 Build 和 Plan；Hermes、Kilo、Cline 列出它們回報的模式；Grok Build 是預設和規劃，這是它實際會套用的兩種；Google Antigravity 是手動確認、自動接受編輯、規劃和略過權限，由 Stepsemble 自己的核准關卡執行（見下方）。Pi 沒有這類模式，所以不會顯示。每個對話會記住自己的選擇；Codex 從下一則訊息開始套用，其他 Agent 立即生效。略過權限需要 Claude Code 的 CLI 支援；如果這台 Mac 透過 Stepsemble 的 Claude 桌面助手啟動 Claude Code，助手也要是新版，可在設定的 Claude Code 頁面查看並更新。

**Settings → Agents & models → Models & providers** 會列出主機上安裝的每個 Agent。每個 Agent 的頁面會說明怎麼登入、列出它提供的模型，以及它自己的設定：Pi 的模型顯示、自訂 Provider 與最近 7 天用量、OpenCode 的服務商與本機伺服器，還有主機裝有 Magpie 或 OpenCodex 時，Codex 與 Claude Code 的轉送。同一區的 **Quota sources** 用來選擇訂閱與 API 額度從哪裡讀取：各 Agent 自己的登入、Pi 的登入與 key、Magpie、OpenCodex，或 CodexBar 的 CLI。每個來源都能開關；同一個服務有多個來源時，也能指定要用哪一個。

OpenCodex 連接了 Pi 時，主機每 5 分鐘、以及每次打開模型選單時，會比對 OpenCodex 提供的模型和 Pi `models.json` 裡 OpenCodex 那一段。兩邊不一樣，就執行 OpenCodex 自己的 `opencodex integration client enable --client pi`，只重寫那一段（OpenCodex 會先存快照）。所以 OpenCodex 新加的模型不必等它重開，就會出現在 Pi 的選單。Stepsemble 不會自己改那一段，也不讀 OpenCodex 的憑證。

主機裝有 [Magpie](https://usemagpie.ai)（gateway 在 127.0.0.1:3425）時，Codex 和 Claude Code 的頁面會顯示各自是否經由它。Codex 的切換會執行 Magpie 自己的 `magpie codex` 指令；Claude Code 的切換會讓 Stepsemble 開始的對話經由 Magpie，就能選用 Magpie 的所有模型，Claude 自己的模型仍走訂閱。作為額度來源時，主機每隔幾分鐘讀一次 `magpie accounts --json`。轉送屬於它指向的那個 gateway：OpenCodex 不會把指向 Magpie 的轉送當成自己的；OpenCodex 關掉且沒有 Agent 經由它時，它的卡片也不會出現。

**Settings → Notifications** 為目前這台設備開啟推播。Agent 完成、失敗或被停止，而該對話沒有在任何畫面開著時，就會收到通知。**Settings → About** 顯示 Stepsemble 版本；各 Agent 的版本在 **Settings → Updates**。暫存資料夾裡的 Sub Agent 對話預設隱藏，可在「其他 App 的歷史」打開顯示。

## Workspace 裡的 Agent

Workspace 的**新增對話**會列出本機 Pi Agent，以及已安裝的 Claude Code、Codex
CLI、Grok Build、OpenCode、Google Antigravity（`agy`）、Cline、Kilo Code、Oh My Pi 與 Hermes。
選好 Agent 後可以勾選隔離 Git worktree。Agent 還沒登入時，同一個視窗會先提供它自己的登入，
登入完成就建立對話。CLI 的 stdout／stderr 會串流到對話；macOS/Linux 會透過內附的
`server/pty-bridge.py` 提供真正的互動式終端，Windows 或沒有 Python 的主機則安全地使用 pipe。計時器會在你瀏覽其他頁面時繼續，
關閉瀏覽器後工作仍會留在 Workspace；重新點選即可回放有限長度的輸出記錄。未安裝的
連接器不會列出，必須先在該主機安裝對應 CLI。

Workspace 側邊列表會顯示每個對話的狀態，**其他 App 的歷史**可以搜尋主機上的所有對話，也能開啟唯讀的歷史閱讀器。Grok Build 只要裝了 `grok` 就使用 ACP（`STEPSEMBLE_GROK_ACP=0` 可改回終端機方式）。Cline、Kilo、Oh My Pi、Hermes 會使用
標準 ACP 的 session/update、cancel 與 permission options；Stepsemble 不讀取私有
credential、gateway 或 session store。可用 `STEPSEMBLE_CLINE_ACP=0`、
`STEPSEMBLE_KILO_ACP=0`、`STEPSEMBLE_OMP_ACP=0`、`STEPSEMBLE_HERMES_ACP=0` 個別回退 CLI。
Oh My Pi 用 Bun 安裝（`bun install -g @oh-my-pi/pi-coding-agent`，需要 Bun 1.3.14 以上），
`omp` 會在 `~/.bun/bin`，Stepsemble 會到那裡找。
`omp` 還沒登入模型供應商時，新增 Oh My Pi 對話會先提供 `omp login`。

Google Antigravity 只要裝了 `agy`，就走它官方文件記載的 headless 串流（stream-json）；
`STEPSEMBLE_ANTIGRAVITY_STRUCTURED=0` 可改回終端機。每個對話就是 agy 自己的對話，畫面和 ACP Agent 的對話一樣：
可以選模型和思考強度（經 gateway 的模型，agy 只接受 low、medium、high）、看 context 圓環（經 Magpie 時，上限取自 Magpie 的模型清單）、
附圖片（agy 的串流只收文字，所以圖片會先存成檔案讓 agy 讀）、停止、排隊送出和 Goal。在 agy 自己畫面開始的對話也會列出來，
可以在 Stepsemble 打開接著做。agy 只在啟動時讀模型、思考強度和規劃模式，所以換了之後從下一則訊息開始套用，仍是同一個對話。
這個串流不會停在 agy 的第一次設定頁或信任資料夾的詢問上。

agy 的串流沒辦法在動作前先問你，所以 Stepsemble 啟動 agy 時加上 `--dangerously-skip-permissions`，
同時用 `--add-dir` 加入自己的 PreToolUse hook，由這個 hook 擔任唯一的核准關卡：agy 和它的子代理每一次呼叫工具，
都會先問主機，主機依這個對話的核准模式回答。手動確認（預設）時，會改東西的動作會在對話裡出現「允許／拒絕」卡片，等你決定；
自動接受編輯會放行專案內的檔案修改；規劃會拒絕所有修改；略過權限全部放行。讀取不會問。
關卡出問題一律拒絕：hook 連不到主機、拿不到明確答案或逾時，agy 都會拒絕；會改東西的動作如果沒有經過關卡同意就完成，對話會被停止。
每次啟動 agy 前都會重寫 hook 檔；agy 的新版本要先通過發版檢查（關卡拒絕的指令確實沒有執行）才會採用。
agy 自己畫面的指令（例如 `/rewind`、`/config`）會讓串流結束，所以 Stepsemble 會先攔下，並提供**在終端機模式繼續**，
在 agy 自己的畫面打開同一個對話；`/model` 和 `/effort` 會打開模型選單。agy 的串流沒有分支（fork）、壓縮和思考過程的文字，所以這幾項不提供。

在終端機（PTY）執行的 CLI 對話會顯示程式自己的畫面和一排按鍵（方向鍵、Tab、空白、Esc、Backspace、Enter）；
在畫面上打的字會直接送給程式，輸入框送出的訊息會按 Enter 送出。勾選隔離 Git worktree 的對話，
也和其他對話一樣使用各 Agent 的結構化通道（Claude Code、Codex、Grok Build、ACP Agent、OpenCode 的 server、Antigravity 的串流）。

Stepsemble 不會替 Agent 回答它自己的第一次設定頁。新增 Antigravity 對話時，如果 agy 的第一次設定還沒完成
（配色、服務條款與資料分享的選擇，agy 記在 `~/.gemini/antigravity-cli/cache/onboarding.json`），
新增對話視窗會說明，並在那個專案的終端機裡打開 agy 自己的設定頁，由你自己選；agy 存好後對話才開始，
也可以按「先不設定，直接開始」。視窗會提醒 agy 預設勾選資料分享；Stepsemble 不會替你勾選、取消或保存這個選擇（agy 官方文件說，CLI 把這個選擇存在帳號那邊）。
「信任這個資料夾」是另一個預設不勾的選項，勾了才會把資料夾加進 agy 官方文件記載的 `trustedWorkspaces` 設定。

Stepsemble 只在同一個本機使用者環境中啟動這些 CLI，不會複製、匯出、改寫或上傳
Claude Code、Codex 等官方登入與訂閱憑證，也不會靜默把官方訂閱切成 API key 或
第三方 router。各家原生客戶端仍可照常直接使用。

Pi 工作會保留原生完整工作階段歷史。通用 CLI 工作由獨立的每工作監督器管理，記錄保存在
`~/.config/stepsemble/agent-tasks.json`（權限 `600`）。重新啟動 Stepsemble 網頁服務時會重新
接管監督器，計時器與輸出都會繼續；如果主機或監督器本身被終止，收件匣會如實標記為已中斷。
首頁 Agent Hub 的「查看全部」工作中心提供搜尋、狀態篩選、回放與一鍵停止。

Stepsemble 也會把既有的 Claude Code 與 Codex session 顯示成有界的**唯讀歷史觀察**。
它只讀目前使用者的 project／rollout JSONL，不讀 provider 憑證、不啟動 CLI，也不發模型
請求。首頁每個專案先顯示三筆；按 **Show more** 或到分頁的 **All conversations** 才查看
其餘內容。這些歷史列不能送出、繼續、停止、核准工具或切換模型；要繼續工作請回到官方
客戶端。完整路徑、上限與安全檢查見
[`native-history-catalog.md`](docs/native-history-catalog.md)。

目前通用 CLI 仍屬 terminal integration；可回放的 Stepsemble journal 還不等於各家
完整原生 session、結構化 tool history 與 approval schema。這些 parity 是
[跨平台計畫](docs/platform-plan.md)中必須通過 contract test 的後續里程碑，不是目前宣稱。

## 助理（Hermes）

已配對的任一台電腦執行 [Hermes Agent](https://github.com/NousResearch/hermes-agent) 時，Workspace 頂部會出現「工作區｜助理」切換。
助理頁是那台電腦 Hermes Bot Mode 的手機優先客戶端（多台都有時可選擇）：用 Hermes 控制台帳號登入一次後，
就能和每個 Bot 的永久對話（Bot Chat）聊天（Bot 工作中傳的訊息會補充到目前的工作，不會中斷它）、回覆核准／提問／sudo／secret（有推播）、查看 Telegram 與例行工作的對話、
管理例行工作、和 2～6 個 Bot 開群組、建立與編輯 Bot（外觀、圖片、個性、模型與推理強度、技能、經 Hermes 安全檢查後從技能中心安裝、
工具組、MCP），也能刪除 Bot。**設定 → Agent 與模型 → Hermes** 是控制台：閘道、預設與輔助模型、推理強度、備援模型、
提供者 API 金鑰、自訂端點，以及 7／30／90 天用量。Hermes 不再出現在「新增對話」，以前用 ACP 開的 Hermes 對話仍可打開。

Stepsemble 只連那台電腦上已在執行的 Hermes，只保存 Hermes 的登入 cookie，對話都留在 Hermes；API 金鑰的值只從頁面送到
Hermes，不保存、不進 log、之後也不再顯示。詳見 [docs/hermes-assistant.md](docs/hermes-assistant.md)。

## 自動更新

預設每小時檢查 GitHub 的最新穩定 Release，並驗證 SHA-256。若任何 agent 正在工作或等待輸入，更新會延後，完成後才替換應用程式。更新器不會修改原生工作階段、專案檔案、Provider 憑證或 Web token。

## 移除

```bash
~/.local/share/stepsemble-bin/uninstall.sh
```

可以選擇只移除 Stepsemble，或連同 Pi Agent 執行檔一起移除；工作階段、憑證與專案資料夾都會保留。
Stepsemble.app 和它的簽章憑證也會移到垃圾桶，macOS 為它保留的資料夾權限會一併清除。

## 開發與測試

```bash
npm run check
npm test
```

大型架構變更前，請依序讀取[跨平台完整體架構與執行計畫](docs/platform-plan.md)、
[目前系統盤點](docs/current-system-inventory.md)、[目前架構](docs/architecture.md)與
[效能基線](docs/performance-baseline.md)。完整部署、設定與安全說明請參閱[英文文件](README.md)。

## 授權

採用 [Apache License 2.0](LICENSE)，聲明見 [NOTICE](NOTICE)。先前 MIT 版本的授權不會被追溯撤銷，原有聲明保留於 [legacy-MIT.txt](licenses/legacy-MIT.txt)。[第三方套件](public/vendor/THIRD-PARTY-NOTICES.md)及另行安裝的 coding agents 維持各自授權。
