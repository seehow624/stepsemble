# Harness 更新中心

Stepsemble 的「設定 → 更新 → Coding agents」是 coding agent 本身的更新控制面板，和 Stepsemble 自己的 App updater 分開運作。
面板操作的是目前選取的 Stepsemble device；切換 device 後可各自檢查與升級，不會把某台電腦的帳號或安裝誤套到另一台。

## 安全模型

- 所有可執行檢查與升級命令都固定在 `protocol/harness-updates.json`，瀏覽器不能提交任意 command 或 shell 字串。
- 檢查會移除常見 API key／登入環境變數；不會讀取或匯出 Claude、Codex、Pi、OpenCode、Hermes 的 credential 檔案。
- 升級前必須由 UI 明確確認；後端再次驗證 allow-list、安裝路徑與目前是否仍有 Pi RPC／Agent Hub 任務。
- 任何活動中的 session 或 task 都會讓升級回傳 `409 agent_busy`，不會強行殺掉程序。
- 更新結果只保存版本、狀態、時間與錯誤 code，不保存 stdout/stderr；狀態檔位於 `~/.config/stepsemble/harness-updates.json`，權限為 `0600`。
- Codex 的來源辨識只接受可證明由同一個 package-owned 路徑提供的 executable：Homebrew 會比對 named `brew list` 的 package paths、npm 會比對全域 package root 與 `package.json`，standalone 會比對 `CODEX_HOME/packages/standalone`。同名但來源不明的 shim／wrapper 會保持 unknown 並拒絕寫入。
- 升級後的 `--version` 讀取失敗會回報 verification failure；沒有強制驗證的策略也會在升級後讀一次版本（讀不到不算失敗）。若官方 updater 正常結束但版本未變：已知有較新的發佈版本時維持 `available` 並標記 `lastUpdateUnchanged`，否則才是 `up-to-date`／`unchanged`，不會冒充已安裝新版本。
- 設定頁只把「有新版本」的項目列入「Upgrade all」，並逐一呼叫 `apply`，每次完成後重新檢查該項；`apply-all` 也接受 `ids` 限定範圍。host-managed 項目只顯示「由主機管理」，未安裝的項目收成一行，不提供升級按鈕。
- 打開「更新」頁時，若上次檢查超過 12 小時，會自動在背景檢查一次版本。

## 檢查策略

| Harness | 檢查來源 | 升級方式 | 備註 |
| --- | --- | --- | --- |
| Codex CLI | 依已安裝來源檢查 Homebrew／npm；官方 standalone 只讀版本 | 保留來源：Homebrew `brew upgrade codex`、npm `npm install --global @openai/codex@latest`、官方 standalone `codex update` | OpenAI 官方安裝器的更新命令是同一個 standalone installer；Codex CLI 目前沒有穩定的 `update --check`，所以 standalone 狀態顯示 unknown。升級後會重新讀取 `codex --version`；未知來源不會執行更新 |
| Claude Code | `npm view @anthropic-ai/claude-code version`（只讀發佈版本） | `claude update` | 官方 updater 沒有 dry-run；升級後重新讀取版本，若仍落後會繼續顯示可更新 |
| OpenCode | Homebrew `brew outdated --json=v2 opencode`；非 Homebrew 安裝時只觀察版本 | Homebrew `brew upgrade opencode` 或 `opencode upgrade` | 不會在檢查階段呼叫會改動安裝的 `upgrade` |
| Pi Agent | `npm outdated --global --json @earendil-works/pi-coding-agent` | `npm install --global @earendil-works/pi-coding-agent@latest` | 只更新明確的 Pi package |
| Hermes Agent | `hermes update --check` | `hermes update --yes --backup` | Hermes 自己的備份旗標會保留 rollback 資料 |
| Gemini CLI | 版本觀察 | 手動 | 套件管理器依安裝方式而異，尚未有單一安全通道 |
| Cline / Kilo Code | 手動 | 手動 | 由 VS Code／編輯器 extension host 管理 |
| Grok Build / Antigravity | 手動 | 手動 | 目前沒有穩定、可驗證的本機 updater contract |

## API

這些 endpoint 會隨現有 `/r/<machine-id>/api/*` relay 支援遠端 Stepsemble device：

- `GET /api/harness-updates/status`
- `POST /api/harness-updates/check`（可帶 `{ "id": "codex" }`，省略時檢查全部）
- `POST /api/harness-updates/apply`（必須帶 `{ "id": "...", "confirm": true }`）
- `POST /api/harness-updates/apply-all`（必須帶 `{ "confirm": true }`；可加 `"ids": ["claude-code"]` 限定範圍）

這些 API 不會自動替使用者升級，也不會把未知的新版本直接提升成可寫入／可 approval 的 native protocol 能力。Codex 的 native 能力仍由獨立的 App Server schema preflight 決定。

## 背景相容性監測

若主機需要持續觀察 harness 是否換了版本，可執行 `npm run watch:harness -- --watch`。這個 watcher 只做 metadata／版本與 Codex schema preflight，會把 owner-only 報告寫到 `~/.config/stepsemble/harness-compatibility.json`；它不會登入、不會開始 model turn，也不會自動升級。真正的升級仍由設定頁的明確操作觸發。
