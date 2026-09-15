# Agent capability matrix

狀態：Stepsemble 3.0.44。這份矩陣說明目前實作與其限制；安裝版本、connector 啟用、帳號登入及真實模型回覆是不同的驗收項目，不能互相替代。

## 圖片、模型與上下文

| Harness 路徑 | 圖片 | 模型切換 | 上下文佔比 |
| --- | --- | --- | --- |
| Pi RPC | 支援 | 原生 RPC | 原生用量 |
| OpenCode server | 原生 file parts | 原生模型清單、送出時選擇 | 最新回覆用量及模型容量 |
| Claude structured | Anthropic image blocks | initialize 模型清單、set_model 原生 ACK | 最新 assistant 輸入與 cache tokens；容量由原生 modelUsage 提供 |
| Codex app-server | 原生 image data URL | model/list 清單、下一個 turn 的 model/effort | thread/tokenUsage/updated 的 last 與 modelContextWindow |
| Cline / Kilo / Hermes ACP | ACP image blocks | 僅 agent 有提供 model config option 時 | 僅 agent 有回報用量與容量時 |
| 純終端／唯讀歷史 | 不提供發送圖片 | 不提供即時模型控制 | 不推算原生 context |

未知用量或容量保留未知，不以累積計費 token 冒充當前上下文。模型清單依電腦上官方 harness 的設定與帳號回傳，不寫入全域帳號／provider 設定。Codex 的舊分頁若指向另一個已開啟的原生 thread，送出／停止會拒絕並要求重新開啟正確對話。

已安裝服務透過共用啟動設定預設開啟 Claude structured、Codex native 與 reviewed mutations；一般 Mac、Mini SSH、systemd 和 Windows task 使用相同預設。舊 Mac 自動更新器只替換程式也能於下次啟動套用。明確設定 `STEPSEMBLE_CLAUDE_STRUCTURED=0`、`STEPSEMBLE_CODEX_NATIVE=0` 或 `STEPSEMBLE_CODEX_NATIVE_MUTATIONS=0` 仍優先。直接執行開發 checkout 時維持明確 opt-in。

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
| OpenCode | 官方 local server：health、session list/get/status、children、messages、abort、permission response、async prompt | 原生 session、圖片、模型選擇、permission 及 bounded checkpoint + reconcile | 已安裝 Mac 若有同使用者持有、不可由群組／其他使用者寫入的 `com.jerome.opencode-web.plist`，會沿用服務 port 與認證；明確 URL 設定優先。不掃 port、不複製或公開密碼；其餘環境需設定 `STEPSEMBLE_OPENCODE_SERVER_URL`。 |
| Claude Code | 官方 stream-json、session resume、host permission、initialize / set_model | 圖片、模型清單與 ACK 後切換、上下文、bounded event window、native session ID、subagent correlation、resume／interrupt／Allow/Deny | 官方帳號必須在該電腦可用。若指定 permission-prompt-tool，仍由該 MCP tool 擁有授權。歷史目錄另由唯讀 catalog 掃描，不能把讀取歷史當作活躍 session 權限。 |
| Codex | 官方 app-server JSON-RPC thread/turn/item、model/list、tokenUsage 與 approval | reviewed `0.153.4`／`0.154.0` 可原生 resume、圖片 prompt、model/effort、context、interrupt 與 approval；使用 owner-only intent journal | 原生 response 可作 bounded ACK；approval pipe `written` 仍只是 `awaiting_confirmation`。未審核版本不開原生 mutation；不能承諾未來任意版本即時相容。 |
| Grok Build | 官方 CLI 支援 `--session-id`／`--resume`／`--continue`、`~/.grok/sessions`、streaming JSON，以及 `grok agent stdio` 的 ACP JSON-RPC；另有 permission mode、subagents、session list/search/export | 明確 opt-in 的 `grok-acp-v1` structured ACP session；Stepsemble 驗證 initialize/authenticate/session/new/session/prompt/update/cancel、permission request/response，Agent Hub 可開啟、重送、停止與顯示 ACP options | 需 `STEPSEMBLE_GROK_ACP=1` 且本機 `grok` 可執行。Stepsemble 不讀 `~/.grok/sessions`，所以 Host restart 後既有 Grok transcript 仍使用 bounded CLI／官方 resume 路徑；ACP `session/load` 只保留為明確的 best-effort route，不把失敗誤報為 history parity。 |
| Google Antigravity | 官方 [`agy` headless CLI](https://antigravity.google/docs/cli/headless/)：`--input-format stream-json`、`--output-format stream-json`、`--conversation`；輸出 `init`／`step_update`／`result` NDJSON | 明確 opt-in 的 `antigravity-cli-stream-json-v1` structured session；Agent Hub 可開啟、重送、停止、顯示 conversation ID，bounded parser 會鎖定單一 conversation | 需 `STEPSEMBLE_ANTIGRAVITY_STRUCTURED=1` 且本機有 `agy`。公開 headless stream 沒有可安全推斷的 approval response envelope，因此只觀察明確標記的 approval，回覆固定 fail-closed；未啟用時回落 `canonical_bounded` CLI。 |
| Cline | 官方 CLI 提供 `--acp` Agent Client Protocol 模式、session/prompt/update、permission request，以及 `--json` headless 模式 | **已完成 ACP native adapter**；若本機有 `cline`，Stepsemble 以 `cline --acp` 啟動標準 ACP，保留 upstream session ID、stream update、cancel 與 option-bound approval；Host restart 後以 bounded index 提供 resume 入口 | Stepsemble 不讀 Cline 私有資料庫；完整 transcript 仍由 upstream `session/load` 提供。可用 `STEPSEMBLE_CLINE_ACP=0` 回退 bounded CLI。 |
| Kilo Code | 官方 CLI 提供 `kilo run`、JSON 格式、session resume，以及 ACP server | **已完成 ACP native adapter**；若本機有 `kilo`，Stepsemble 以 `kilo acp` 啟動標準 ACP，支援 session/new/load、prompt/update、cancel 與 option-bound approval；Host restart 後以 bounded index 提供 resume 入口 | 不讀 Kilo 私有 credential/store；跨 restart 不掃描 SQLite，仍由 upstream `session/load` 決定 transcript。可用 `STEPSEMBLE_KILO_ACP=0` 回退 bounded CLI。 |
| Hermes Agent | 官方 Hermes ACP stdio server、session/prompt streaming、permission request、cancel，以及 sessions CLI | **已完成 ACP native adapter**；若本機有 `hermes`，Stepsemble 以 `hermes acp` 使用標準 ACP，Personal Agents 分組與 coding task 分離；Host restart 後以 bounded index 提供 resume 入口 | 不掃描 Hermes gateway、Telegram 或私有 session store；完整 transcript 仍由 upstream `session/load` 決定。可用 `STEPSEMBLE_HERMES_ACP=0` 回退 bounded CLI。 |

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

已安裝的 Mac 服務（一般 launchd 或 Mini SSH）若已有
`com.jerome.opencode-web.plist`，共用啟動設定會驗證擁有者、不可外部寫入、
一般檔案與大小限制後沿用本機服務。其他平台或不同服務設定仍需提供上述環境變數。

Stepsemble 啟動後會先呼叫 `/global/health`、`/session` 與 permission list probe；session/history 先以 health + session 成功為準，approval 只有 permission probe 成功才標成 `native_api`。瀏覽器可使用以下已驗證的 Host 路由：

- `GET /api/opencode/native`：adapter 狀態與 capability。
- `GET /api/opencode/sessions`：有界 session 清單。
- `GET /api/opencode/session?sessionId=…`：session、status、children、messages、pending permissions。
- `POST /api/opencode/message`：優先走官方 `prompt_async`，舊 server 才 fallback 到 synchronous message。
- `POST /api/opencode/permission`：把 `once`／`always`／`reject` 委派回 upstream。
- `POST /api/opencode/reconcile`：重新讀取 session/status/children/messages/permissions，並以 owner-only checkpoint 記錄 ID／cursor，不儲存對話正文。

OpenCode server 官方文件列出上述 session/message/permission 路由，並說明 `opencode serve` 預設 loopback 與 Basic Auth；OpenCode 的 approval 選項為 `once`、`always`、`reject`，而 subagent 是 child session。參見 [OpenCode server API](https://github.com/anomalyco/opencode/blob/dev/packages/web/src/content/docs/server.mdx)、[OpenCode permissions](https://opencode.ai/v2/docs/permissions)、[OpenCode agents](https://opencode.ai/v2/docs/agents)。

## Structured adapter 使用方式

以下指令適用於直接啟動開發 checkout；已安裝服務的 Claude／Codex 預設如上。Grok／Antigravity 仍需明確啟用。各 adapter 不複製帳號憑證；唯讀歷史 catalog 是獨立功能。

### Claude Code

```sh
export STEPSEMBLE_CLAUDE_STRUCTURED=1
# Optional: the MCP permission-prompt-tool name configured for Claude Code.
export STEPSEMBLE_CLAUDE_PERMISSION_PROMPT_TOOL='your_permission_tool'
```

Agent Hub 的 Claude task 會以 public `claude -p --output-format stream-json --input-format stream-json --verbose --permission-prompts host` 啟動，輸入走 JSONL，resume 只接受明確的 upstream session ID。可使用：

- `GET /api/claude/structured`：adapter 與目前 task。
- `GET /api/claude/structured/events?sessionId=…`：bounded event window。
- `GET /api/claude/structured/pending?sessionId=…`：pending permission request。
- `POST /api/claude/structured/prompt`、`POST /api/claude/structured/interrupt`、`POST /api/claude/structured/close`：送出／中斷一輪／關閉。
- `GET /api/claude/structured/models`、`POST /api/claude/structured/model`：指定 session 的模型清單與 ACK 後切換。
- `GET /api/claude/structured/context?sessionId=…`：當前 context DTO，未知欄位為 null。

在 host mode 下，`POST /api/claude/structured/permission` 只接受目前 `can_use_tool` request 的 ID，並送出官方 control response；Allow 會帶回 request 的原始 `input`，Deny 會帶回使用者拒絕訊息。未知、重複或 legacy permission frame 一律 fail-closed。若明確配置 `--permission-prompt-tool` MCP tool，Stepsemble 會停用 host response，改由 MCP tool 擁有決策。

### Cline、Kilo Code、Hermes（ACP）

這三個 connector 都使用標準 ACP JSON-RPC over stdio；Stepsemble 不把單次 JSON output 或私有 SQLite／gateway 檔案當成歷史 authority。執行檔存在時預設啟用，若要回退安全 bounded CLI，可設定：

```sh
export STEPSEMBLE_CLINE_ACP=0
export STEPSEMBLE_KILO_ACP=0
export STEPSEMBLE_HERMES_ACP=0
```

ACP adapter 只接受 upstream 回傳的 session ID，並驗證 `session/update` 的 session scope。`session/request_permission` 的回覆只接受當次 request 提供的 `optionId`；不自動選擇、不使用 yolo、不複製訂閱／OAuth。瀏覽器使用的路由為 `/api/{cline|kilo|hermes}/acp/{sessions,session,events,pending,prompt,cancel,permission}`；restart index 只存 resume 所需的非秘密 metadata。

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

`GET /api/codex/models` 回傳官方模型分頁；`GET /api/codex/context?threadId=…` 回傳對應 thread 的實際用量。`POST /api/codex/mutation/turn` 接收 `threadId`、`text`、`images`、選填 `model`／`effort`；圖片只接受有界 base64，不接受任意本機路徑。`POST /api/codex/mutation/interrupt` 也必須指定 `threadId`，跨對話 stale request 不會操作目前另一個 thread。模型及 input 格式依 [官方 Codex App Server 文件](https://learn.chatgpt.com/docs/app-server)。

### Grok Build

```sh
export STEPSEMBLE_GROK_ACP=1
```

Agent Hub 會以 `grok --no-auto-update agent stdio` 建立單一 ACP process，執行 initialize/authenticate/session/new/session/prompt/update/cancel，並將 `session/request_permission` 的 options 原樣以 bounded、sanitized 卡片呈現。可使用：

- `GET /api/grok/acp`、`GET /api/grok/acp/sessions`：adapter 與目前 process 內 session 狀態。
- `GET /api/grok/acp/events?sessionId=…`、`GET /api/grok/acp/pending`：事件與 pending permission。
- `POST /api/grok/acp/session`、`POST /api/grok/acp/prompt`、`POST /api/grok/acp/cancel`、`POST /api/grok/acp/permission`。

ACP permission 回覆只接受目前 request 所提供的 `optionId`，並送出標準 `{ outcome: { outcome: "selected", optionId } }` 或 `{ outcome: { outcome: "cancelled" } }`。Stepsemble 不用 `--always-approve`，也不掃描 `~/.grok/sessions`；因此 process restart 後的既有 session 必須由官方 Grok resume／CLI bounded 路徑重新接回。

### Google Antigravity

```sh
export STEPSEMBLE_ANTIGRAVITY_STRUCTURED=1
# Optional: use an explicit absolute binary when agy is not on PATH.
export STEPSEMBLE_ANTIGRAVITY_BIN=/absolute/path/to/agy
```

Agent Hub 會以 `agy --input-format stream-json --output-format stream-json` 建立長駐
session；輸入為 `{"event":"user","message":{"content":"…"}}`，輸出只接受
官方 `init`／`step_update`／`result`／`error` 事件。`conversation_id` 一旦出現就會
鎖定，任何跨 conversation 的事件會讓 adapter fail-closed。可以使用：

- `GET /api/antigravity/structured`、`GET /api/antigravity/structured/events?sessionId=…`：adapter、session 與 bounded event window。
- `GET /api/antigravity/structured/pending`：只顯示 upstream 明確標記的 approval observation。
- `POST /api/antigravity/structured/prompt`、`POST /api/antigravity/structured/close`：送出／關閉。

目前 headless stream 沒有公開、可驗證的 approval response envelope；因此
`/permission` 固定回 `antigravity_permission_requires_native_ui`，不會把任意 pipe write
當成核准。未設定旗標時不啟動 structured process，仍使用 bounded CLI connector。

## 為什麼其他 harness 仍然分級

Claude Code 官方 CLI 的 `--resume`、`--output-format stream-json`、`--input-format stream-json`、`--permission-prompts host` 與 control channel 是公開介面；Stepsemble 已把可驗證的 JSONL session／resume／subagent correlation／permission round-trip 接起來。[Claude Code CLI reference](https://code.claude.com/docs/en/cli-usage) 是執行／resume／permission 的公開界面。Codex app-server 則明確定義 thread／turn／item lifecycle 與 approval request；Stepsemble 對 mutation 使用第二層 opt-in 和 intent journal，仍以實際 JSON-RPC evidence 為準。[Codex app-server](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md) 是目前的官方契約。ACP 的 baseline 是 `initialize`、`session/new`、`session/prompt`、`session/update`、`session/cancel` 與 `session/request_permission`；Stepsemble 對 Cline、Kilo、Hermes 使用同一套 bounded ACP adapter。[ACP overview](https://agentclientprotocol.com/protocol/overview)、[ACP schema](https://github.com/agentclientprotocol/agent-client-protocol/blob/main/schema/v1/schema.json)

任何 harness 升級到 native 等級前，都必須有：官方版本／協議來源、bounded parser、session／message／child／status／approval fixtures、重啟 reconcile 測試，以及在未設定或 upstream 失敗時回落 `canonical_bounded` 的證據。

## Connector promotion gate

新 connector 先以 `experimental` 或 `structured` catalog 出現，避免 Agent Hub
為了「看起來支援」而攔截首頁、搬移訂閱憑證，或把 CLI 文字誤當成 approval。
升級為 native adapter 前必須同時通過：

1. 官方、版本化且可在本機驗證的協議來源（不是私有資料庫逆向）。
2. bounded parser 與 session／message／child／status／approval fixtures。
3. process restart、重連、重送、stop/cancel 和錯誤清理測試。
4. approval 的 request、decision、upstream ACK 三者可關聯；缺一就 fail-closed。
5. 憑證與訂閱狀態留在上游 harness，Stepsemble 不代持、不上傳、不跨機器複製。
6. 至少一輪跨平台 smoke 與固定來源的長時間 soak，並有明確回落路徑。
