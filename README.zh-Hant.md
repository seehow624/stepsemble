# Stepsemble（繁體中文）

[English](README.md) · [简体中文](README.zh-Hans.md) · 繁體中文 · [日本語](README.ja.md) · [한국어](README.ko.md) · [Türkçe](README.tr.md) · [Français](README.fr.md) · [Deutsch](README.de.md) · [Español](README.es.md) · [Português](README.pt-BR.md) · [Italiano](README.it.md)

Stepsemble 是開源、自架、手機優先的本機 coding agent 工作區。Pi Agent
目前使用原生 session 路徑；同一個介面也可啟動主機上已安裝的 Claude Code、Codex
CLI、Grok Build 與 OpenCode。

## 隱私與安全

倉庫只包含應用程式碼與通用部署範本，不包含 token、工作階段記錄、專案檔案、私有網址、帳號憑證、模型使用歷史、用量統計或任何特定電腦設定。token 應保存在本機權限為 `600` 的檔案，服務預設只監聽回環位址，再透過 Tailscale Serve 或其他 HTTPS 閘道存取。

## 快速開始

在每一台要執行 Stepsemble 的電腦上執行：

```bash
/bin/zsh -c "$(curl -fsSL https://raw.githubusercontent.com/seehow624/stepsemble/master/install.sh)"
```

安裝程式會檢查 Pi Agent 與 Node.js、下載並驗證最新穩定 Release、建立
launchd 服務與自動更新。若沒有 Pi Agent，會先詢問是否透過 Pi 官方安裝程式加入；
選擇略過也能正常使用其他已安裝的 agent connector。

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

## 從 Pi Harbor 升級

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

加入 LLM 服務商：開啟 **Settings → Connection → Models & providers**，選擇目錄服務、帳號／OAuth 登入、API key、本機服務或自訂 Provider，然後選擇要顯示的模型。

## Agent Hub 連接器

首頁的 **Agent Hub** 會探索本機 Pi Agent，以及已安裝的 Claude Code、Codex
CLI、Grok Build、OpenCode。建立 **New project** 時可選擇 Agent，也可以開啟隔離
Git worktree。CLI 的 stdout／stderr 會串流到對話；macOS/Linux 會透過內附的
`server/pty-bridge.py` 提供真正的互動式終端，Windows 或沒有 Python 的主機則安全地使用 pipe。計時器會在你瀏覽其他頁面時繼續，
關閉瀏覽器後工作仍會留在收件匣；重新點選即可回放有限長度的輸出記錄。未安裝的
連接器會顯示為不可選取，必須先在該主機安裝對應 CLI。

Stepsemble 只在同一個本機使用者環境中啟動這些 CLI，不會複製、匯出、改寫或上傳
Claude Code、Codex 等官方登入與訂閱憑證，也不會靜默把官方訂閱切成 API key 或
第三方 router。各家原生客戶端仍可照常直接使用。

Pi 工作會保留原生完整工作階段歷史。通用 CLI 工作由獨立的每工作監督器管理，記錄保存在
`~/.config/stepsemble/agent-tasks.json`（權限 `600`）。重新啟動 Stepsemble 網頁服務時會重新
接管監督器，計時器與輸出都會繼續；如果主機或監督器本身被終止，收件匣會如實標記為已中斷。
首頁 Agent Hub 的「查看全部」工作中心提供搜尋、狀態篩選、回放與一鍵停止。

目前通用 CLI 仍屬 terminal integration；可回放的 Stepsemble journal 還不等於各家
完整原生 session、結構化 tool history 與 approval schema。這些 parity 是
[跨平台計畫](docs/platform-plan.md)中必須通過 contract test 的後續里程碑，不是目前宣稱。

## 自動更新

預設每小時檢查 GitHub 的最新穩定 Release，並驗證 SHA-256。若任何 agent 正在工作或等待輸入，更新會延後，完成後才替換應用程式。更新器不會修改原生工作階段、專案檔案、Provider 憑證或 Web token。

## 移除

```bash
~/.local/share/stepsemble-bin/uninstall.sh
```

可以選擇只移除 Stepsemble，或連同 Pi Agent 執行檔一起移除；工作階段、憑證與專案資料夾都會保留。

## 開發與測試

```bash
npm run check
npm test
```

大型架構變更前，請依序讀取[跨平台完整體架構與執行計畫](docs/platform-plan.md)、
[目前系統盤點](docs/current-system-inventory.md)、[目前架構](docs/architecture.md)與
[效能基線](docs/performance-baseline.md)。完整部署、設定與安全說明請參閱[英文文件](README.md)。
