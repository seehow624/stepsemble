# Agent capability matrix

狀態：Stepsemble 3.0.12 開發／發布驗收文件。這份矩陣把「上游 harness 官方提供什麼」和「Stepsemble 在目前版本實際驗證到什麼」分開，避免把某個 CLI 的輸出捕捉誤稱成原生 session parity。

## Stepsemble 的驗證等級

| 等級 | 意義 |
| --- | --- |
| `native_full` | Stepsemble 使用 harness 的原生 session/runtime 協議，能保留其完整生命週期、歷史與 approval 語義。 |
| `native_readonly` | 已接上並驗證原生讀取（session、history、child/status 等），但 Stepsemble 不把沒有證據的 mutation／完整 transcript 反推成 full parity。 |
| `native_api` | capability 的控制面由 harness 官方 API 執行；每個 mutation 的結果仍以 upstream 回應和後續 reconcile 為準。 |
| `canonical_bounded` | 使用 Stepsemble 的 Host-local canonical journal 與有界 terminal snapshot；不冒稱讀到 upstream 私有歷史。 |
| `structured_ack_required` | approval 決策可以 durable，但要等 harness 回傳明確 ACK 才能宣稱原生執行／resume。 |

## 目前版本

| Harness | 官方可驗證介面 | Stepsemble 目前能力 | 邊界 |
| --- | --- | --- | --- |
| Pi Agent | 原生 JSON-RPC session、stream、approval、history | `native_full` | 只對 Pi 自己的 store／RPC 做 full claim。 |
| OpenCode | 官方 local server：health、session list/get/status、children、messages、abort、permission response、async prompt | **已完成 native adapter**；健康探測與 session probe 成功後標 `native_readonly`／`native_api`，可在 Agent Hub 開原生 session；重啟以 bounded checkpoint + reconcile 恢復 | 必須明確設定 `STEPSEMBLE_OPENCODE_SERVER_URL`；不掃描隨機 port、不讀 `~/.opencode`、不複製密碼。若 server 未探測成功，仍是 `canonical_bounded` CLI。 |
| Claude Code | 官方 CLI／SDK 支援 session ID resume、stream-json、permission prompt tool，以及以 `parent_tool_use_id` 轉送 subagent 文字 | Stepsemble 仍以 explicit source group 的 native read-only 或 bounded CLI 為準 | 官方介面足以做下一階段 structured adapter，但目前尚未把 CLI stream／resume／subagent transcript 接成 Stepsemble 的 native authority；未驗證的本機檔案不自動讀取。 |
| Codex | 官方 `codex app-server` JSON-RPC 支援 thread read/list、turn/item lifecycle 與 server-initiated approval request | Stepsemble 已有明確 Codex history/approval bridge，但仍按版本／source gate 宣告 | approval 是否被 native server／auto-review 接手，必須看實際 request／completed evidence；不能只看 CLI transcript。 |
| Grok Build | 官方 CLI 支援 `--session-id`／`--resume`／`--continue`、`~/.grok/sessions`、streaming JSON，以及 `grok agent stdio` 的 ACP JSON-RPC；另有 permission mode、subagents、session list/search/export | `canonical_bounded` CLI | 官方能力已足以做候選 ACP adapter，但 Stepsemble 尚未完成 ACP session/load、permission request、subagent update 與重啟 contract suite；在此之前保留 terminal capture，不讀取未驗證的私有 session store。 |

## OpenCode native adapter 使用方式

先由使用者明確啟動 OpenCode server（建議 loopback）：

```sh
opencode serve --hostname 127.0.0.1 --port 4096
```

再在啟動 Stepsemble 的同一個環境設定（Stepsemble 會把 New Project 選取的合法專案目錄以
`directory` query 傳給 OpenCode；這樣不會把 session 建在 server 啟動時的另一個專案）：

```sh
export STEPSEMBLE_OPENCODE_SERVER_URL=http://127.0.0.1:4096
# 如果 OpenCode server 設了 Basic Auth，再提供：
export STEPSEMBLE_OPENCODE_SERVER_USERNAME=opencode
export STEPSEMBLE_OPENCODE_SERVER_PASSWORD='由本機安全管理'
```

Stepsemble 啟動後會先呼叫 `/global/health`、`/session` 與 permission list probe；session/history 先以 health + session 成功為準，approval 只有 permission probe 成功才標成 `native_api`。瀏覽器可使用以下已驗證的 Host 路由：

- `GET /api/opencode/native`：adapter 狀態與 capability。
- `GET /api/opencode/sessions`：有界 session 清單。
- `GET /api/opencode/session?sessionId=…`：session、status、children、messages、pending permissions。
- `POST /api/opencode/message`：優先走官方 `prompt_async`，舊 server 才 fallback 到 synchronous message。
- `POST /api/opencode/permission`：把 `once`／`always`／`reject` 委派回 upstream。
- `POST /api/opencode/reconcile`：重新讀取 session/status/children/messages/permissions，並以 owner-only checkpoint 記錄 ID／cursor，不儲存對話正文。

OpenCode server 官方文件列出上述 session/message/permission 路由，並說明 `opencode serve` 預設 loopback 與 Basic Auth；OpenCode 的 approval 選項為 `once`、`always`、`reject`，而 subagent 是 child session。參見 [OpenCode server API](https://github.com/anomalyco/opencode/blob/dev/packages/web/src/content/docs/server.mdx)、[OpenCode permissions](https://opencode.ai/v2/docs/permissions)、[OpenCode agents](https://opencode.ai/v2/docs/agents)。

## 為什麼其他 harness 仍然分級

Claude Code 官方 CLI 有 `--resume`／`--output-format stream-json`、permission prompt tool，以及可用 `parent_tool_use_id` 重建 subagent 文字的 forwarding flag；這證明可以做可靠的 structured adapter，但不等於 Stepsemble 現在已經取得 Claude Code 客戶端的完整 authority。[Claude Code CLI reference](https://docs.anthropic.com/en/docs/claude-code/cli-usage) 仍然是執行／resume 的公開界面。Codex app-server 則明確定義 thread／turn／item lifecycle 與 approval request；其 native reviewer／auto-review 仍可能接手決策，所以 Stepsemble 必須以實際 JSON-RPC evidence 為準。[Codex app-server](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md) 是目前的官方契約。Grok Build 官方同時公開 headless session flags、streaming JSON、`grok agent stdio` ACP、custom model/provider、session list/search/export、permission mode 與 subagents；這使 Grok 成為下一個最值得做的 structured adapter，但 ACP 的 session/history/approval/restart contract 尚未在 Stepsemble 驗收，因此目前仍保持 bounded。[Grok Build overview](https://docs.x.ai/build/overview)、[Grok Build headless & scripting](https://docs.x.ai/build/cli/headless-scripting)、[Grok Build CLI reference](https://docs.x.ai/build/cli/reference)、[Grok Build permissions](https://docs.x.ai/build/features/permissions)

任何 harness 升級到 native 等級前，都必須有：官方版本／協議來源、bounded parser、session／message／child／status／approval fixtures、重啟 reconcile 測試，以及在未設定或 upstream 失敗時回落 `canonical_bounded` 的證據。
