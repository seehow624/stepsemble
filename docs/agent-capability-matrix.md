# Agent capability matrix

狀態：Stepsemble 3.0.27 開發／發布驗收文件。這份矩陣把「上游 harness 官方提供什麼」和「Stepsemble 在目前版本實際驗證到什麼」分開，避免把某個 CLI 的輸出捕捉誤稱成原生 session parity。

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
| OpenCode | 官方 local server：health、session list/get/status、children、messages、abort、permission response、async prompt | **已完成 native adapter**；健康探測與 session probe 成功後標 `native_readonly`／`native_api`，可在 Agent Hub 開原生 session；重啟以 bounded checkpoint + reconcile 恢復 | 一般啟動模式必須明確設定 `STEPSEMBLE_OPENCODE_SERVER_URL`；macOS SSH launcher 若已有 owner-only `com.jerome.opencode-web.plist`，會把該本機服務設定帶入 child。仍不掃描隨機 port、不讀 `~/.opencode`、不寫入或公開密碼。若 server 未探測成功，仍是 `canonical_bounded` CLI。 |
| Claude Code | 官方 CLI／SDK 支援 session ID resume、stream-json、permission prompt tool，以及以 `parent_tool_use_id` 轉送 subagent 文字 | 明確 opt-in 的 `claude-cli-stream-json-v1` structured session；Stepsemble 保存 bounded JSONL event window、native session ID、resume 參數與 subagent correlation，Agent Hub 可開啟、重送、關閉並顯示 pending permission | 需 `STEPSEMBLE_CLAUDE_STRUCTURED=1`。Claude 的 public print/stream-json channel 沒有可由 Stepsemble 偽造的 permission response envelope；approval card 會明確要求使用 Claude 的 MCP `permission-prompt-tool`，不把 pipe write 當 ACK。既有 CLI session 清單仍不從 `~/.claude` 推斷。 |
| Codex | 官方 `codex app-server` JSON-RPC 支援 thread read/list、turn/item lifecycle 與 server-initiated approval request | Stepsemble 已接上明確 opt-in 的 app-server history adapter；第二層 mutation opt-in 後，Agent Hub 可 resume／送 turn／interrupt／回答 approval，並以 owner-only intent journal + native response 做 reconcile；唯讀模式仍可安全載入 bounded turns/items history | 需 `STEPSEMBLE_CODEX_NATIVE=1`；要寫入再加 `STEPSEMBLE_CODEX_NATIVE_MUTATIONS=1`。thread/turn 的 native response 可作 bounded ACK；approval response 的 `written` 只代表已寫入 pipe，會維持 `awaiting_confirmation`，直到 native server 提供 correlated evidence。 |
| Grok Build | 官方 CLI 支援 `--session-id`／`--resume`／`--continue`、`~/.grok/sessions`、streaming JSON，以及 `grok agent stdio` 的 ACP JSON-RPC；另有 permission mode、subagents、session list/search/export | 明確 opt-in 的 `grok-acp-v1` structured ACP session；Stepsemble 驗證 initialize/authenticate/session/new/session/prompt/update/cancel、permission request/response，Agent Hub 可開啟、重送、停止與顯示 ACP options | 需 `STEPSEMBLE_GROK_ACP=1` 且本機 `grok` 可執行。Stepsemble 不讀 `~/.grok/sessions`，所以 Host restart 後既有 Grok transcript 仍使用 bounded CLI／官方 resume 路徑；ACP `session/load` 只保留為明確的 best-effort route，不把失敗誤報為 history parity。 |

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

使用 macOS SSH launcher 的 Mac mini 若已由 launchd 管理
`com.jerome.opencode-web.plist`，不需要把密碼複製到 Stepsemble 設定；啟動器
只在本機 child process 中沿用該 owner-only plist 的設定。其他平台與其他
launch mode 仍必須由管理者明確提供上述環境變數。

Stepsemble 啟動後會先呼叫 `/global/health`、`/session` 與 permission list probe；session/history 先以 health + session 成功為準，approval 只有 permission probe 成功才標成 `native_api`。瀏覽器可使用以下已驗證的 Host 路由：

- `GET /api/opencode/native`：adapter 狀態與 capability。
- `GET /api/opencode/sessions`：有界 session 清單。
- `GET /api/opencode/session?sessionId=…`：session、status、children、messages、pending permissions。
- `POST /api/opencode/message`：優先走官方 `prompt_async`，舊 server 才 fallback 到 synchronous message。
- `POST /api/opencode/permission`：把 `once`／`always`／`reject` 委派回 upstream。
- `POST /api/opencode/reconcile`：重新讀取 session/status/children/messages/permissions，並以 owner-only checkpoint 記錄 ID／cursor，不儲存對話正文。

OpenCode server 官方文件列出上述 session/message/permission 路由，並說明 `opencode serve` 預設 loopback 與 Basic Auth；OpenCode 的 approval 選項為 `once`、`always`、`reject`，而 subagent 是 child session。參見 [OpenCode server API](https://github.com/anomalyco/opencode/blob/dev/packages/web/src/content/docs/server.mdx)、[OpenCode permissions](https://opencode.ai/v2/docs/permissions)、[OpenCode agents](https://opencode.ai/v2/docs/agents)。

## 3.0.27 structured adapter 使用方式

這三個 adapter 都是 opt-in；未設定旗標時，既有 bounded CLI connector 不變，也不會讀取 agent 的私有 credential/session store。

### Claude Code

```sh
export STEPSEMBLE_CLAUDE_STRUCTURED=1
# Optional: the MCP permission-prompt-tool name configured for Claude Code.
export STEPSEMBLE_CLAUDE_PERMISSION_PROMPT_TOOL='your_permission_tool'
```

Agent Hub 的 Claude task 會以 public `claude -p --output-format stream-json --input-format stream-json --verbose` 啟動，輸入走 JSONL，resume 只接受明確的 upstream session ID。可使用：

- `GET /api/claude/structured`：adapter 與目前 task。
- `GET /api/claude/structured/events?sessionId=…`：bounded event window。
- `GET /api/claude/structured/pending?sessionId=…`：pending permission request。
- `POST /api/claude/structured/prompt`、`POST /api/claude/structured/close`：送出／關閉。

`POST /api/claude/structured/permission` 會固定回 `claude_permission_requires_mcp_tool`；這是 fail-closed 的安全邊界，不是缺少 UI。若要在 Web 內完成 Claude approval，必須配置官方 `--permission-prompt-tool` MCP tool，並由該 tool 回傳真正的 permission result。

### Codex

唯讀歷史仍只需要：

```sh
export STEPSEMBLE_CODEX_NATIVE=1
```

要啟用 native mutation／resume／turn／interrupt／approval，再明確加入：

```sh
export STEPSEMBLE_CODEX_NATIVE_MUTATIONS=1
```

所有寫入先落到 `~/.config/stepsemble/codex-native-mutations.json` 的 owner-only intent journal。`thread/start`、`thread/resume`、`turn/start`、`turn/interrupt` 的 native response 可以作為 bounded evidence；approval response 的 `written` 只代表 pipe write，狀態會停留在 `awaiting_confirmation`，不會被誤報成 Codex 已核准。

### Grok Build

```sh
export STEPSEMBLE_GROK_ACP=1
```

Agent Hub 會以 `grok --no-auto-update agent stdio` 建立單一 ACP process，執行 initialize/authenticate/session/new/session/prompt/update/cancel，並將 `session/request_permission` 的 options 原樣以 bounded、sanitized 卡片呈現。可使用：

- `GET /api/grok/acp`、`GET /api/grok/acp/sessions`：adapter 與目前 process 內 session 狀態。
- `GET /api/grok/acp/events?sessionId=…`、`GET /api/grok/acp/pending`：事件與 pending permission。
- `POST /api/grok/acp/session`、`POST /api/grok/acp/prompt`、`POST /api/grok/acp/cancel`、`POST /api/grok/acp/permission`。

ACP permission 回覆只接受目前 request 所提供的 `optionId`，並送出標準 `{ outcome: { outcome: "selected", optionId } }` 或 `{ outcome: { outcome: "cancelled" } }`。Stepsemble 不用 `--always-approve`，也不掃描 `~/.grok/sessions`；因此 process restart 後的既有 session 必須由官方 Grok resume／CLI bounded 路徑重新接回。

## 為什麼其他 harness 仍然分級

Claude Code 官方 CLI 的 `--resume`、`--output-format stream-json`、`--input-format stream-json` 與 permission-prompt-tool 是公開介面；Stepsemble 已把可驗證的 JSONL session／resume／subagent correlation 接起來，但 approval response 仍由 Claude 的 MCP tool 擁有。[Claude Code CLI reference](https://docs.anthropic.com/en/docs/claude-code/cli-usage) 是執行／resume 的公開界面。Codex app-server 則明確定義 thread／turn／item lifecycle 與 approval request；Stepsemble 對 mutation 使用第二層 opt-in 和 intent journal，仍以實際 JSON-RPC evidence 為準。[Codex app-server](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md) 是目前的官方契約。Grok Build 官方公開 headless session flags、streaming JSON、`grok agent stdio` ACP、permission mode、session list/search/export 與 subagents；Stepsemble 已驗證 ACP 的 session/prompt/update/permission back-channel，但不讀私有 session store，Host restart 的既有歷史仍保留 bounded 邊界。[Grok Build headless & scripting](https://docs.x.ai/build/cli/headless-scripting)、[Grok Build sessions](https://docs.x.ai/build/features/sessions)、[Grok Build permissions](https://docs.x.ai/build/features/permissions)

任何 harness 升級到 native 等級前，都必須有：官方版本／協議來源、bounded parser、session／message／child／status／approval fixtures、重啟 reconcile 測試，以及在未設定或 upstream 失敗時回落 `canonical_bounded` 的證據。
