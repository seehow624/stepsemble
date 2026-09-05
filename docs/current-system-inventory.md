# Stepsemble 3.0.0 現行系統盤點

> 狀態：Phase 0 基線（Baseline）
> 盤點版本：1.2
> 盤點日期：2026-09-04
> 對應原始碼：Pi Harbor 2.13.2 commit `5ef248e20a7f49c274555cab91045542b0150def` → Stepsemble 3.0.0 source commit `39e671d1b95f3f72ca76178c44216fbe15ed1cc5`
> Runtime 基線：Node.js 22.19+、CommonJS、無 runtime npm dependency、buildless PWA
> Live 驗證：2026-09-04 Mac Mini 已由 2.13.2 原地升級並運行 Stepsemble 3.0.0；canonical repository 為 `seehow624/stepsemble`

## 1. 這份文件的角色

這份盤點凍結「目前真的存在什麼」，不是未來設計。長期方向與階段門檻見 [`platform-plan.md`](platform-plan.md)；已上線架構摘要見 [`architecture.md`](architecture.md)。

未來開始 Stepsemble Protocol、Rust Host Core、TypeScript Client SDK、agent adapter、session、approval、Model Source 或跨平台工作前，依序完整讀取：

1. [`platform-plan.md`](platform-plan.md)
2. 本文件
3. [`architecture.md`](architecture.md)
4. 專案根目錄 `_MEMORY-CARD.md`（本機記憶層，不提交公開 repo）
5. `git status --short`、`package.json` 與當前測試結果

本文件採以下原則：

- 只記錄不含秘密的 shape、上限、狀態與邊界。
- 「原始碼中存在」不等於「已有完整 contract test」。未覆蓋處會明標。
- 本盤點不是 Stepsemble Protocol v1；Phase 1 會把它轉成 canonical schema、fixture 與可執行 contract。
- 路由若未特別標示，JSON request body 上限沿用 `readJSON()` 預設的 16 MiB。

2026-09-05 開發增量另見 [`reliability-followup.md`](reliability-followup.md)。本文件保留歷史基線，不把尚未部署的封存、stream、worktree、前端修復改寫成既有正式版行為。

### 1.1 v3 品牌遷移增量

- 新 identity：`Stepsemble`、`stepsemble`、`STEPSEMBLE_*`、`com.stepsemble.*`、`STEPSEMBLE3`。
- 雙讀相容：`~/.config/pi-harbor`、`~/.config/pi-web`、`pi_harbor`／`pi_web` cookie、`PI_HARBOR_*`／`PI_WEB_*`、`PIHARBOR3`／`PIHARBOR2`。
- private state 只在新檔不存在時複製；舊來源不刪除，symlink 不跟隨，檔案／資料夾權限收斂為 `0600`／`0700`。
- macOS、Linux、Windows 安裝器只在 active-work gate 通過後切換服務，並以 `/api/health` 的 `appVersion` 驗證；失敗恢復舊程式與服務。
- `~/.pi`、其他 harness 的原生 config/session、provider login、approval 與 workspace 不屬品牌遷移範圍。

### 1.2 本機遷移驗證

- 升級前 active Pi RPC 與 generic task 都是 0；升級後 `com.stepsemble.server` 以既有 SSH-localhost 模式運行，`com.stepsemble.updater` 已載入，舊 server/updater label 已卸載並封存。
- 升級前後 `/api/sessions` 都回傳 8 個可見 session；`~/.pi/agent/sessions` 都是 25 個檔案、58,696,776 bytes。遷移未搬動原生 session、approval 或 provider auth。
- 新舊 Web token 的 SHA-256 相同；舊 `~/.config/pi-harbor` 保留，新 `~/.config/stepsemble` 為 additive copy。
- `com.piharbor.cua-driver` 未被 installer 納入遷移，驗證前後都維持同一 PID 636；舊 `pi-harbor-bin` 也保留。
- 新 updater 在 repository rename 的 rolling 空窗可唯讀舊 stable feed並做 semantic-version 比較；3.0.0 對 2.13.2 的實測結果為 `up_to_date`，禁止 downgrade。此 fallback 保留給尚未跨版的舊安裝。
- macOS shell/plist、Linux shell 與 Windows PowerShell AST 均通過語法驗證；Linux source installer 已在乾淨 Debian/Node 22 container 實跑完成。Windows Scheduled Task 與 Linux systemd 的真實 service rollback 仍需各平台 runner 驗證。

## 2. 系統與程序邊界

```text
Browser / installed PWA
  │ same-origin HTTP + authenticated SSE
  ▼
server.js (one Node process per Host)
  ├─ HTTP route/controller, static files, auth and remote relay
  ├─ Pi native RPC manager ──spawn──> pi --mode rpc
  ├─ generic Agent task service ──spawn──> detached supervisor per task
  │                                  └─ PTY/pipe ──> claude/codex/grok/opencode
  ├─ session/provider/device/update services
  └─ local files under ~/.pi and ~/.config/stepsemble

Remote Stepsemble Host
  ▲
  └─ /r/<machineId>/api/* relay
```

### 2.1 現行責任分配

| 元件 | 現行責任 | 生命週期 |
| --- | --- | --- |
| `public/app.js` | SPA view controller、session/task 選擇、SSE reducer、approval sheet、provider/device/update UI | Browser/PWA page |
| `server.js` | 全部 HTTP route、Pi RPC、session scan、provider auth、device relay、push、update orchestration | Host service |
| `server/agent-connectors.js` | allow-list discovery、generic task 目錄、HTTP SSE journal、supervisor reconnect | Host service |
| `server/agent-task-supervisor.js` | 單一 generic CLI 的 child/PTY、控制 socket、短期 event buffer、metadata snapshot | Detached per task |
| `server/pty-bridge.py` | Unix pseudo-terminal bridge | Generic CLI child helper |
| `server/connector-protocol.js` | Generic connector v1 manifest、5 種 event、9 種 status 正規化 | Library |
| `server/device-trust.js` | 一次性 pairing capability、peer credential hash、grant persistence | Library + disk |
| `server/http-utils.js` | security headers、cookie/bearer auth、JSON body、SSE frame | Library |
| `pi --mode rpc` | Pi 原生 session、完整 message/tool lifecycle、模型與 extension UI | Child process |

### 2.2 已知能力差距（必須保留在所有產品宣稱中）

| Connector | 現況 | 目前不能宣稱的能力 |
| --- | --- | --- |
| Pi Agent | 原生 JSON-RPC、Pi JSONL session、歷史、模型命令、structured extension UI | Host service 重啟後仍可無縫接回同一個活躍 Pi child；目前只會在 grace window 內等待它完成 |
| Claude Code | Interactive CLI over PTY/pipe；detached supervisor；64 KiB output tail | 完整 native session/history、structured approval、resume、tool event、Claude Agent SDK parity |
| Codex CLI | 同上 | 完整 Codex task/session、structured approval、resume、tool event |
| Grok Build | 同上 | 完整 session/history/approval/resume |
| OpenCode | 同上 | 完整 session/history/approval/resume；它目前是 Agent connector，不是第三方 Model Source adapter |

Generic connector 的「可啟動、可串流、server restart 可重新 attach」只是 Level 1 terminal integration，不等於使用官方客戶端的完整 session 體驗。

## 3. Authentication 與 trust scope

### 3.1 符號

| 符號 | 條件 |
| --- | --- |
| Public | 無登入；仍受跨站 mutation guard 與輸入驗證 |
| L | 嚴格 loopback TCP + loopback Host + 無 forwarding header + 一次性狀態 |
| C | request 本身攜帶的一次性 pairing capability |
| B | `stepsemble` HttpOnly、SameSite=Strict cookie；值是有效 token 的 SHA-256 hash。v3 遷移期也讀 `pi_harbor`／`pi_web`，但登入只新發 `stepsemble` |
| P | 64 hex bearer peer credential；Host 只存 incoming hash |
| B/P | `authenticate()` 接受 B 或 P |
| MB | B 且必須是 installer/master token，不接受額外 access token |

### 3.2 全域規則

- POST/PUT/PATCH/DELETE 若 `Sec-Fetch-Site: cross-site`，或 `Origin.host` 與 request `Host` 不同，先回 403。
- Browser cookie 預設 30 天、HttpOnly、SameSite=Strict、Path=/；只有 `STEPSEMBLE_SECURE_COOKIE=1` 才加 Secure/HSTS。
- Login 以 client socket address 計數：10 分鐘內最多 10 次失敗；之後 429 並帶 `Retry-After`。
- Master token 與額外 access token 都以 SHA-256 hash 比對；額外 token 只在建立時回傳明文一次。
- `/r/...` 入口只接受本機 Browser cookie；它不接受另一台 Host 的 peer bearer 作為 relay caller。
- Remote relay 對已 pairing Host 只送 dedicated bearer；legacy 手動加入 Host 才送 shared master-token cookie。trust state 損壞時 fail closed，不准退回 legacy cookie。
- `authenticate()` 雖區分 `browser` 與 `peer`，多數受保護 route 目前仍是 B/P；只有下表明示的敏感 route 額外限制為 B 或 MB。

## 4. HTTP、SSE 與 relay 端點

### 4.1 Public、bootstrap 與 stream

| Method / path | Caller | Scope | 輸入與上限 | 主要輸出／timeout | 測試狀態 |
| --- | --- | --- | --- | --- | --- |
| `POST /api/login` | Web/CLI | Public | JSON ≤4 KiB；token ≤512 chars | 204 + cookie；401/429 | Live integration：tokens/onboarding；rate-limit 僅靜態覆蓋 |
| `POST /api/logout` | Web | Public | 空 object | 204 + expire cookie | UI/static only |
| `GET /api/health` | installer、updater、Web | Public | 無 | appVersion、machine display、deviceId、port、uptime | 多個 live integration |
| `GET /api/machine` | Login page、Web、relay | Optional B/P | Public 只得 display/platform/authed；只有 B 得 `home`、`piBin` | 200 | pairing/device integration |
| `GET /api/onboarding/key` | First-run local Web | L | 無 | eligible；只有合格時含一次性 master key | Live integration |
| `POST /api/onboarding/confirm` | First-run local Web | L | 空 object | 204；持久標記與 token hash 綁定 | Live integration |
| `POST /api/device-pairing/consume` | Joining Host | C | JSON ≤16 KiB；v3 offerId/secret/requestingDevice | 200，唯一會 server-to-server 傳新 credential 的 response；410 legacy miss | Live integration |
| `GET /api/provider-auth/stream?runId&after` | Web/relay | B/P | cursor 或 `Last-Event-ID` | SSE；15 s ping；run 最長 30 min | 靜態 lifecycle；未有完整 live provider fixture |
| `GET /api/stream?sid&after` | Web/relay | B/P | cursor 或 `Last-Event-ID` | Pi SSE；15 s ping；最多 8,000 events/8 MiB memory replay | SSE ordering static test；未有 Pi fake-RPC contract |
| `GET /api/agent/stream?taskId&after` | Web/relay | B/P | cursor 或 `Last-Event-ID` | Generic SSE；15 s ping；最多 1,200 events/8 MiB；restart 可回 64 KiB tail | Live connector integration |
| `ANY /r/<machineId>/api/*` | Web selected remote Host | B | method/query/body streaming relay | 非 SSE 60 s；SSE 無固定 timeout；response hop-by-hop/auth headers 被移除 | Live pairing/trust integration |

### 4.2 Session、project 與 task

| Method / path | Caller | Scope | 輸入與上限 | 主要輸出／行為 | 測試狀態 |
| --- | --- | --- | --- | --- | --- |
| `GET /api/sessions?includeTemporary` | Web | B/P | Boolean-ish query | Pi session summary；附 live Pi run state | Static UI；scan parser 無獨立 contract |
| `GET /api/session?file&limit&before` | Web | B/P | safe relative `.jsonl`；file ≤128 MiB；limit ≤500 | active branch messages + pagination | Static UI；無 live route contract |
| `GET /api/session-search?q` | Web | B/P | q 2–200 chars | 最近最多 400 files、單檔 ≤8 MiB、2.5 s budget、20 results | Static UI only |
| `GET /api/session-export?file` | Web | B/P | safe relative file ≤128 MiB | Markdown + name | Static UI only |
| `GET /api/usage-summary?days` | Web | B/P | 1–30 days | 最近最多 300 files、單檔 ≤8 MiB、3 s budget | Unit usage + static UI；route 未 live 覆蓋 |
| `POST /api/rename` | Web | B/P | file、name ≤120 after normalization | append Pi-native `session_info` JSONL | Static UI only |
| `POST /api/delete` | Web | B/P | safe file | 優先移到 `~/.Trash`；失敗才 unlink | Static UI only |
| `POST /api/session-action` | Web | B/P | archive(file) / unarchive(archiveId) | 同磁碟 move；只有完整 restore 才刪 archive dir | Static UI only |
| `POST /api/project-action` | Web | B/P | absolute allowed cwd；reveal/archive/worktree | Finder reveal、session archive、permanent Git worktree | Static UI；Git worktree route 未 live 覆蓋 |
| `GET /api/project-changes?cwd` | Web | B/P | allowed project dir | read-only Git overview；≤500 changed files | Live service unit |
| `GET /api/project-diff?cwd&path` | Web | B/P | scoped path | staged/worktree/untracked diff | Live service unit |
| `GET /api/browse?path` | Web | B/P | absolute real path within browse roots | visible directory entries only；dot dirs hidden | Live integration |
| `GET /api/agents` | Web | B/P | 無 | allow-listed connector catalog/capabilities/install state | Unit + static integration |
| `GET /api/agent-tasks` | Web | B/P | 無 | Pi live tasks + generic tasks | Static UI；generic service unit |
| `GET /api/agent-task?taskId` | Web | B/P | task ID | generic task detail + 64 KiB output tail | Generic service unit |
| `POST /api/agent/open` | Web | B/P | JSON ≤64 KiB；agentId/cwd/name/worktree | Pi: 200 native RPC；generic: 201 supervisor task | Generic service unit；route static |
| `POST /api/agent/send` | Web | B/P | JSON ≤1.1 MiB；message ≤1,000,000 chars | write supervisor control socket | Generic service unit |
| `POST /api/agent/abort` | Web | B/P | taskId | Pi `abort` 或 generic stop | Generic service unit；Pi branch static |
| `POST /api/agent/close` | Web | B/P | generic taskId | generic stop | Generic service unit |
| `GET /api/rpcs` | Web、installer、updater | B/P | 無 | live Pi processes + generic task list | Static/update tests；無 full live Pi RPC |

### 4.3 Pi-native RPC control

| Method / path | Caller | Scope | 輸入與上限 | 主要輸出／timeout | 測試狀態 |
| --- | --- | --- | --- | --- | --- |
| `POST /api/open` | Web | B/P | existing file 或 absolute allowed cwd/name | spawn/reuse `pi --mode rpc`；max active 16 | Static UI only |
| `POST /api/send` | Web | B/P | message ≤1,000,000 chars；request ≤16 MiB；最多 4 張 safe image，每張 base64 <8 MiB | `prompt`；streaming 中加 `followUp` | Static UI only |
| `POST /api/abort` | Web | B/P | sid | write `abort` | Static UI only |
| `POST /api/close` | Web | B/P | sid | 只有無 client、非 exited 才 kill；回 clients count | Static UI only |
| `POST /api/cmd` | Web | B/P | sid + allow-listed command | fire-and-forget write | Static UI + usage unit |
| `POST /api/rpc-cmd` | Web internal | B/P | sid + arbitrary object command | correlated response；20 s timeout | Static UI only |
| `POST /api/rpc-ui` | Web approval sheet | B/P | sid、request id、value/confirmed/cancelled | `extension_ui_response` | Static UI only |
| `GET /api/models?sid` | Web | B/P | optional live sid | live or temporary Pi RPC model catalog；20 s timeout | Static UI only |

`/api/cmd` 目前只允許：`get_state`、`get_available_models`、`set_model`、`cycle_model`、`set_thinking_level`、`get_available_thinking_levels`、`set_session_name`、`compact`、`get_session_stats`。

### 4.4 Provider、model 與 push

| Method / path | Caller | Scope | 輸入與上限 | 主要輸出／行為 | 測試狀態 |
| --- | --- | --- | --- | --- | --- |
| `GET /api/provider-catalog` | Web | B/P | 無 | provider/auth capability，不回秘密 | Static security/UI |
| `POST /api/provider-auth/start` | Web | B/P | providerId/authType/API key path | 建立最多 4 個、最長 30 min auth run | Static lifecycle |
| `POST /api/provider-auth/respond` | Web | B/P | runId/requestId/value ≤16 KiB | 回覆 pending prompt | Static lifecycle |
| `POST /api/provider-auth/cancel` | Web | B/P | runId | abort auth run | Static lifecycle |
| `POST /api/provider-auth/delete` | Web | B/P | providerId | 刪除對應 native credential/config | Static UI only |
| `POST /api/provider-free/setup` | Web | B/P | providerId | 設定 allow-listed free provider | Static UI only |
| `GET /api/model-providers` | Web | B/P | 無 | sanitized `models.json` provider list | Static security/UI |
| `POST /api/model-providers` | Web | B/P | upsert/delete validated provider | atomic write `models.json` | Static security/UI |
| `GET /api/model-config/export?secrets` | Web | B/P | `secrets=1` 明確 opt-in | portable provider config；預設移除 apiKey/oauth | Static source inspection only |
| `POST /api/model-config/import` | Web | B/P | providers object | 全量驗證後 atomic merge/write | Static source inspection only |
| `GET /api/push/config` | Web | B/P | 無 | VAPID public key | Static UI only |
| `POST /api/push/subscribe` | Web | B/P | HTTPS endpoint + browser public key/auth | persistent subscription | Static UI only |
| `POST /api/push/unsubscribe` | Web | B/P | endpoint | 移除 subscription | Static UI only |

目前 model provider 是 Pi Agent 的 provider config 功能，不是 OpenCodex/CC Switch 等第三方 Model Source/Profile abstraction。後者屬 Phase 7。

### 4.5 Device、trust、access token 與 update

| Method / path | Caller | Scope | 輸入與上限 | 主要輸出／行為 | 測試狀態 |
| --- | --- | --- | --- | --- | --- |
| `GET /api/device-settings` | Web | B/P | 無 | local id/name/port/publicUrl | Live pairing + static UI |
| `POST /api/device-settings` | Web | B/P | name、port 1024–65535、public URL | atomic `device.json`；可能要求 restart | Static UI |
| `POST /api/device-restart` | Web/relay | B/P | 空 | 202，250 ms 後 SIGTERM；graceful shutdown | Static UI only |
| `POST /api/device-pairing/start` | Web | B only | 無 | 5 分鐘、one-use STEPSEMBLE3 offer | Live integration |
| `POST /api/machines/pair/preview` | Web | B only | offer | local-only decode + temporary confirmation binding | Live integration |
| `POST /api/machines/pair` | Web | B only | previewed offer + confirmed | remote consume timeout 8 s；atomic grant/catalog flow | Live integration |
| `GET /api/machines` | Web | B/P | 無 | sanitized machine catalog + authMode | Live pairing/trust |
| `POST /api/machines` | Web | B/P | add/update/delete | managed catalog；dedicated URL immutable without re-pair | Live trust integration |
| `GET /api/device-trust/grants` | Web | B/P | alias `/api/device-grants` | incoming grants，不回 credential hash | Live integration |
| `POST /api/device-trust/grants/revoke` | Web | B/P | grantId | revoke；alias supported | Live integration |
| `DELETE /api/device-trust/grants/<id>` | API client | B/P | 32-hex grant ID；alias supported | revoke | Module/live path indirectly covered |
| `GET /api/access-tokens` | Settings | MB | 無 | metadata only | Live integration |
| `POST /api/access-tokens/create` | Settings | MB | JSON ≤2 KiB；label ≤40；max 20 | secret shown once、hash persisted | Live integration |
| `POST /api/access-tokens/revoke` | Settings | MB | JSON ≤2 KiB；id | 204；existing cookie fails next request | Live integration |
| `GET /api/version` | Web/update fallback | B/P | 無 | Pi version、app version、machine | Static UI |
| `GET /api/update/status` | Web | B/P | 無 | updater install/config/phase metadata | Static update suite |
| `POST /api/update/settings` | Web | B/P | enabled/repository/ref/15–10080 min | atomic updater config | Static update suite |
| `POST /api/update/run` | Web | B/P | 空 | 202 detached updater；duplicate 409 | Static update suite |
| `GET /api/pi-resources` | Settings compare | B/P | 無 | read-only extension/skill/package hashes | Live integration |

### 4.6 Static files

- 只允許 GET/HEAD；normalized path 必須位於 `public/`。
- `index.html` 使用 `no-cache`；`sw.js` 使用 `no-cache, no-store, must-revalidate`；其他 asset 使用 `public, max-age=86400`。
- ETag 為 size + mtime weak ETag，支援 304。
- Service worker 明確不攔 `/api/` 與 `/r/`。

## 5. Wire protocol 與 event inventory

### 5.1 SSE 共通語意

- Content-Type `text/event-stream; charset=utf-8`、`Cache-Control: no-store`、`X-Accel-Buffering: no`。
- 連線建立後先註冊 subscriber，再送 named `connected` event，再 replay；這是避免 replay/subscription race 的現行保證。
- Cursor 取 query `after` 與 `Last-Event-ID` 的最大有效數字。
- Journal event 有 numeric SSE `id`；snapshot/connected/widget recovery 可沒有 id。
- 每 15 秒 comment ping。
- Event buffer 是 bytes + count 雙界；超界移除最舊 event，沒有 durable cursor-expired error。

### 5.2 Pi JSONL RPC

Transport：stdin/stdout 每行一個 JSON object；只以 `\n` 分幀並移除尾端 `\r`。Child 以 detached process group 啟動；正常 stop 先 SIGTERM，1.5 秒後 best-effort SIGKILL。

Browser reducer 已知的 inbound event：

- Run：`agent_start`、`agent_end`、`agent_settled`、`turn_end`、`rpc_exit`
- Message：`message_start`、`message_update`、`message_end`
- Tool：`tool_execution_start`、`tool_execution_update`、`tool_execution_end`
- Queue/retry/compaction：`queue_update`、`auto_retry_start`、`auto_retry_end`、`compaction_start`、`compaction_end`、`summarization_retry_scheduled`、`summarization_retry_attempt_start`、`summarization_retry_finished`
- Extension：`extension_ui_request`、`extension_error`
- Command：`response`

`message_update.assistantMessageEvent` 已知 subtype：`text_start`、`text_delta`、`thinking_delta`、`toolcall_end`。

Outbound command families：

- Prompt/stop：`prompt`、`abort`
- State/model/session：`get_state`、`get_available_models`、`set_model`、`cycle_model`、`set_thinking_level`、`get_available_thinking_levels`、`set_session_name`、`compact`、`get_session_stats`
- Interactive UI：`extension_ui_response`

Pi event schema 目前由 upstream Pi runtime 隱含決定；repo 尚無完整 vendored schema 或 sanitized golden transcript，這是 Phase 1 的首要 contract gap。

### 5.3 Pi extension UI / 現行 approval

`extension_ui_request.method`：

- 非互動：`notify`、`setStatus`、`setWidget`、`setTitle`
- 互動：`select`、`confirm`、`input`、`editor`
- 未知 method：Client 自動回 `cancelled: true`

目前互動 request 只存在 Pi child event、Node memory buffer 與當前 Browser state；沒有獨立 durable approval record、expiry、scope、decision audit 或 exactly-once/idempotency key。Node service crash/restart後無法保證恢復 pending approval。這正是長期計畫中 approval store/state machine 必須補上的原因。

### 5.4 Generic connector protocol v1

Manifest fields：`protocolVersion=1`、id、label、kind、capabilities、events、installed、command basename、transport、reason。

Event types：`task_started`、`output`、`status`、`input`、`task_exit`。

Statuses：`starting`、`running`、`waiting`、`reconnecting`、`completed`、`failed`、`stopped`、`detached`、`orphaned`。

Supervisor control socket 是 newline-delimited JSON：

- Request op：`attach(after)`、`ping`、`send(message)`、`stop`
- Response/frame type：`snapshot`、`event`、`sent`、`error`

這個 v1 protocol 只描述 terminal bytes 與程序 lifecycle，沒有 structured message/tool/approval/session/model events。

### 5.5 Provider auth event

Types：`started`、`auth_url`、`device_code`、`progress`/`info`、`prompt`、`notify`、`success`、`error`、`cancelled`。

- 最多同時 4 個 active auth run。
- 每個 run 最長 30 分鐘。
- Event memory buffer 最多 200 events/512 KiB。
- 完成後 5 分鐘移除 run。
- Pending secret/input 只在 memory；credential persistence 委託 Pi auth storage 或指定 provider config。

## 6. 狀態機盤點

### 6.1 Native Pi RPC/session

```text
open/spawn
  → waiting (process alive, not streaming)
  → running (`agent_start`)
  → waiting (`agent_settled`)
  → running (next prompt)
  → exited (`rpc_exit` / process error)
```

- 同一 `file` 在同一 Node process 內會 reuse live RPC。
- SSE 全離開且非 streaming 時，5 分鐘後 kill idle RPC。
- Process exit 後 map entry保留 10 分鐘。
- Server SIGTERM：不 kill 正在 streaming 的 Pi run，最多等待 45 秒；到期後 kill。非 streaming RPC 立即終止。
- `isStreaming` 的權威 transition 目前依 `agent_start`/`agent_settled`；沒有 persisted run row。
- 超過 15 分鐘無 client、無 output 的 running RPC 標 `stuck`，update 可把它視為 idle；這不會自動結束 task。

### 6.2 Generic Agent task

```text
starting → running ↔ waiting
             │
             ├─ control disconnect → reconnecting → previous/live status
             └─ exit/stop → completed | failed | stopped

startup recovery with dead supervisor → orphaned
```

- HTTP service shutdown 採 `preserve: true`，只斷 control socket，不終止 supervisor/CLI。
- Reconnect backoff：100、250、500、1,000、2,000、5,000、10,000、30,000 ms，之後以 30 秒持續 bounded retry；若 supervisor PID 已死則 orphaned。
- Supervisor event 最多 1,200/8 MiB，只在 supervisor memory；metadata 每 500 ms debounce，保存 64 KiB output tail。
- Task catalog 最多保存最近 100 tasks。
- Terminal supervisor 寫 snapshot 後約 250 ms 結束並移除 Unix socket。

### 6.3 Provider auth

```text
created/started → progress/auth_url/device_code/prompt
  → success | error | cancelled | timeout
  → closed → removed after 5 min
```

### 6.4 Update

Observed phases：`idle`、`disabled`、`checking`、`available`、`pending`、`deferred`、`health_check`、`updated`、`up_to_date`、`rollback`、`error`、`unavailable`。

macOS updater 在下載前及 activation 前各檢查 active non-stuck Pi RPC；若有工作則 `deferred/active_rpc_running`。目前這個檢查不包含 generic detached Agent task。

## 7. Persistent data inventory

### 7.1 Pi-owned 或 Pi-shared

| Path（相對 `PI_HOME`/home） | Owner／writer | 內容與權限 | 備份／回滾語意 | 遷移限制 |
| --- | --- | --- | --- | --- |
| `.pi/agent/sessions/<project>/<session>.jsonl` | Pi primary；Stepsemble 讀、rename append、archive/delete move | Native append-only session；單檔 API 上限 128 MiB | Archive 是同盤 move；delete 優先 Trash | 永不轉成 Stepsemble-only 格式；保留 native source of truth |
| `.pi/agent/sessions/.archive/<archiveId>/...` | Stepsemble | 可復原 session snapshot | 全數 restore 成功才移除 archive dir | Rust migration 不可刪除未驗證 archive |
| `.pi/agent/models.json` | Pi + Stepsemble provider editor | Provider/model config，可能含 API key；Stepsemble atomic 0600 write | Import 前驗證；沒有版本化歷史 | 不進 journal/log；Model Source 層不得靜默改寫 |
| `.pi/agent/auth.json` | Pi auth storage，Stepsemble 經 Pi runtime 使用 | Native provider OAuth/API auth | 由 provider delete flow 處理 | 不複製到 Stepsemble DB、Client 或跨裝置同步 |
| `.pi/agent/nous-auth.json` | Stepsemble provider integration | Nous access/refresh secret；0600 atomic | refresh/update/delete | 同上，秘密留 Host |
| `.pi/agent/machines.json` | Stepsemble | managed machine catalog；0600 atomic | mutation 失敗回復 in-memory map並嘗試落回 | 長期移至 Stepsemble state 時需雙讀與 rollback |
| `.pi/agent/device.json` | Stepsemble | local id/name/port/publicUrl；0600 atomic | write failure 回復 memory；port 重啟後生效 | Installer/updater也讀 port，需跨版兼容 |
| `.pi/worktrees/<repo>/<stamp-suffix>` | Git + Stepsemble | permanent Git worktree | create failure遞迴清除 target | 不自動刪 user work；需明確 ownership metadata |

### 7.2 Stepsemble-owned config/state

| Path | Owner／writer | 內容與權限 | 備份／回滾語意 | 遷移限制 |
| --- | --- | --- | --- | --- |
| `.config/stepsemble/token` | installer/Host | 32-byte random master token；0600 | Install 保留既有；read failure 可暫用不顯示的 ephemeral token | 不進 DB、log、export；支援 custom file path |
| `.config/stepsemble/tokens.json` | Host | 最多 20 個額外 access-token hash/label/timestamps；0600 atomic | 寫入失敗回復 memory | 明文只回一次，migration 只搬 hash |
| `.config/stepsemble/onboarding.json` | Host | tokenHash + confirmedAt；0600 atomic | 損壞 fail closed，不重新顯示 token | 必須保持 one-time 語意 |
| `.config/stepsemble/device-trust.json` | device-trust module | incoming credential hash、outgoing raw dedicated credential、device metadata；≤2 MiB、0600 atomic | malformed/unreadable fail closed；mutation有 rollback ordering | outgoing secret 只可 Host-local；不可回 Browser |
| `.config/stepsemble/updater.json` | Host/installer | enabled/repo/ref/interval；0600 atomic | defaults 可重建 | 保持舊版 updater 可讀 |
| `.config/stepsemble/update-state.json` | updater/Host read | phase/version/check/error metadata；0600 atomic | updater覆寫 snapshot | 不是業務 journal，可重建 |
| `.config/stepsemble/push.json` | Host | VAPID private/public key；0600 atomic | 可重建會使舊 subscription 失效 | private key 留 Host |
| `.config/stepsemble/push-subscriptions.json` | Host | endpoint、p256dh、auth；0600 atomic | 404/410 自動移除 | 視為敏感 endpoint material |
| `.config/stepsemble/agent-tasks.json` | agent task service | 最多 100 個 generic task snapshot + 64 KiB tails；0600 atomic | 每次變更/500 ms debounce | 不是完整歷史；未來 migration 不得假裝完整 |
| `.config/stepsemble/agent-tasks/<taskId>.json` | detached supervisor | 單 task snapshot + 64 KiB tail；0600 atomic | terminal 時最後一次 persist | 可協助 recovery，但不能替代 event journal |
| `.config/stepsemble/agent-tasks/<taskId>.sock` | supervisor | owner-only Unix socket | terminal 時 unlink；stale socket由 liveness/reconnect處理 | Windows 對應 local named pipe |
| `/tmp/stepsemble-sockets/<hash>.sock` | supervisor | macOS/Unix socket path 過長時 fallback；directory 0700 | terminal 時 unlink | Hash 包含 config dir，避免 profile collision |

### 7.3 Install/runtime paths

| Path | 用途 | Current rollback |
| --- | --- | --- |
| `.local/share/stepsemble` | active release | macOS/Linux/Windows activation 前將舊版移至 `.previous` |
| `.local/share/stepsemble.previous` | one-generation backup | macOS/Linux/Windows transaction 都在 activation 或版本化 health failure時回復 app 與對應 service 定義/狀態 |
| `.local/share/stepsemble-bin` | stable updater/uninstaller/launcher | 不跟 active release 同時消失 |
| `.local/share/stepsemble-runtime` | macOS installer-managed private Node | checksum verified；只在系統 Node 不符時建立 |
| `.local/state/stepsemble` | service logs、legacy migration state | 不含 Pi sessions/provider credentials |

實際 absolute path 全由 `APP_HOME = PI_HOME || os.homedir()` 導出；文件用相對 home 表示，避免把私人機器資訊寫入 repo。

## 8. In-memory state inventory

| State | 上限／清理 | 失去後影響 |
| --- | --- | --- |
| `rpcSessions` | max 16 active；idle 5 min；exit 10 min | 活躍 Pi child 無法被新 Node reattach；SSE event/cursor/widget snapshot消失 |
| Per-Pi `events` | 8,000/8 MiB | Browser只能依 native session reload已落盤內容；live-only event可能缺失 |
| Per-Pi `widgets` | max 32 | reconnect progress widget snapshot消失 |
| `pendingRpcCmds` | command 20 s timeout | outstanding command reject/timeout |
| `scanCache` | 以目前 session files清理，無硬數量上限 | 重新掃描所有 Pi JSONL，可能造成 latency spike |
| `providerAuthRuns` | max 4；30 min timeout；closed後5 min | 進行中登入無法恢復，必須重來 |
| `pairingPreviewApprovals` | 跟 offer expiry清理 | 使用者要重新 preview |
| Device trust offers | max 24；5 min | offer失效，安全重建 |
| `loginAttempts` | 10 min window，request 時清理 | service restart會重置 rate limit |
| `pushDeliveryInFlight` | endpoint set；request完成移除 | 可能重複或漏一則 best-effort notification |
| model/version caches | short-lived | 重新呼叫 Pi/version probe |
| update child/timer state | single child + deferred key | persistent update state仍保留；scheduler可再試 |
| Generic task HTTP events | per task 1,200/8 MiB | supervisor tail仍在，但 HTTP cursor從0重建 |
| Generic supervisor events | per task 1,200/8 MiB | supervisor結束後只剩64 KiB tail/metadata |

## 9. Install、startup、update 與 rollback matrix

| Platform | Install/start | Update | Active-task protection | Health/rollback | 現行差距 |
| --- | --- | --- | --- | --- | --- |
| macOS | Per-user zsh installer；launchd Agent；可安裝 private Node、選用官方 Pi；可保留舊 SSH launcher | launchd hourly updater；SHA-256、archive preflight；GitHub release | Installer 與 updater 都阻止 active native/generic agent work；無法驗證舊服務時 fail closed | Installer 30 次 listener/path health probe；updater版本化 `/api/health` probe失敗即回 `.previous`；服務與 plist 一併恢復 | 無法自動修復 agent 自身損壞的原生 session |
| Linux | Per-user bash installer；systemd user service；Node需使用者先安裝 | hourly systemd timer重跑 installer；SHA-256 + archive preflight | 更新前檢查 native RPC 與 generic task；驗證不了既有服務即停止 | app、unit、installer 與 active/enabled service 狀態納入 transaction；匹配版本 health 失敗回復 | 無 systemd 時只能完成檔案安裝、保留舊產品待人工驗證；仍缺 distro runtime CI |
| Windows | Per-user PowerShell；AtLogOn Scheduled Task；Node/tar需先有 | hourly Scheduled Task重跑 installer；SHA-256 + archive preflight | 更新前檢查 native RPC 與 generic task；驗證不了既有服務即停止 | app 與 Scheduled Task XML／running state 納入 transaction；匹配版本 health 失敗回復 | Pipe transport沒有 ConPTY；需 Windows runner/live sleep-resume 驗證 |

Release CI 定義：`v*` tag 觸發語法檢查、測試、版本一致性、`stepsemble-*` 與 rolling `pi-harbor-*` tar.gz、SHA-256、GitHub OIDC build provenance attestation。Canonical repo 是 `seehow624/stepsemble`；Local updater只強制 SHA-256，未在 client side驗 attestation。

## 10. 已知同步阻塞與順滑度風險

1. `listSessions()`、search、usage candidate discovery仍在 request path使用同步 `readdirSync/statSync/realpathSync`；大量檔案或 SMB/外接磁碟 metadata latency可卡住唯一 Node event loop。
2. 每個 cache miss session會順序完整 stream/parse JSONL；首次載入或大批 session變動時延遲線性增加。
3. `renameSession()` 同步讀完整 session再 append，只為找 leaf；大檔會阻塞。
4. `createPermanentWorktree()` 使用最長 10 s + 30 s `execFileSync`，期間所有 HTTP/SSE/ping都可能停住。
5. Browser `public/app.js` 約 9,800 行、單 controller；長 session DOM目前沒有 virtualization。
6. Markdown、tool cards、history merge與 live delta在主執行緒；雖有文字 delta batching，仍缺 Chrome trace/CWV基線。
7. Generic CLI只保存 output tail；重開看似「恢復」實際會丟早期輸出與 structured state。
8. Pi RPC stdout沒有明確單行 frame size上限；bounded event journal只在完整 JSON parse後生效。
9. SSE `res.write()` backpressure目前多數路徑把 false視為失效並移除 client，沒有 per-client queue/slow-consumer reason。

這些是 Phase 2/3 的量測與修正目標；Phase 0 不直接改線上行為。

## 11. 測試覆蓋基線

2026-09-04：`npm run check` 通過；`npm test` 127/127 通過，約 11.34 秒。

現有高價值 live/integration coverage：

- Login/access-token lifecycle。
- First-run loopback key reveal與fail-closed onboarding。
- STEPSEMBLE3 pairing、dedicated relay、revocation、legacy relay與trust corruption。
- Generic connector allow-list、no-shell launch、bounded output、stop、server restart reattach。
- Folder browse confinement、Pi resource inventory、Git read-only diff。
- Installer/updater archive traversal/symlink preflight（macOS conditional）。

主要未覆蓋 contract：

- 沒有 fake Pi RPC fixture驗證完整 inbound/outbound JSONL schema、approval、replay與restart。
- 多數 route 只有 static source/DOM assertion，沒有逐端點 request/response golden fixture。
- 沒有 browser automation的長 session、rapid host switch、multi-client、background/foreground、INP/LCP/CLS。
- Linux 已有乾淨 container source-install smoke；仍沒有 Linux systemd 與 Windows Scheduled Task 的 real service/update/rollback integration matrix。
- 沒有 crash/kill -9、disk full、partial write、power-loss與72-hour soak。
- 沒有 native Claude Code/Codex/OpenCode/Grok version matrix與官方 session/approval parity。

## 12. Phase 0 performance baseline protocol

Phase 0 的可重複 Host benchmark 必須使用隔離 `PI_HOME`、隨機 local port與合成 session，禁止讀真實使用者 session、provider auth或訂閱資料。至少記錄：

- `/api/health` warm latency p50/p95/p99。
- `/api/sessions` cold/warm latency與合成 file/message數。
- `/api/session` long-history latency與payload bytes。
- 在 cold session scan 同時的 health probe最大延遲，作為event-loop responsiveness proxy。
- Authenticated SSE `connected` handshake latency。
- Server RSS idle/after scan。
- Benchmark host OS/arch/Node/app version與執行時間。

Browser trace另行記錄 LCP、FCP、CLS、INP/TBT、network waterfall與accessibility snapshot。這次環境沒有配置 `chrome-devtools` MCP，故不能產生可信的 Core Web Vitals；不得用猜測值填入。啟用方式：

```json
"chrome-devtools": {
  "type": "local",
  "command": ["npx", "-y", "chrome-devtools-mcp@latest"]
}
```

Host benchmark 已落於 [`scripts/host-performance-baseline.mjs`](../scripts/host-performance-baseline.mjs)，摘要見 [`performance-baseline.md`](performance-baseline.md)；raw result 同時保留改名前 [`2.13.2`](baselines/host-performance-2026-09-04-darwin-arm64.json) 與部署後 [`3.0.0`](baselines/host-performance-2026-09-04-stepsemble-3.0.0-darwin-arm64.json)。數字只用來比較同一 workload 的後續版本，不拿單一開發機結果當全平台 SLA。

## 13. Phase 0 完成判準與 handoff

已完成：

- HTTP/SSE/RPC、caller、auth scope、timeout與主要大小上限盤點。
- 持久檔案、owner、權限、rollback與migration constraint盤點。
- Session/run/approval/task/event/in-memory state盤點。
- macOS/Linux/Windows install/start/update/rollback現況盤點。
- 每個 route family的coverage或未覆蓋標記。
- 隔離 Host 效能基線：301 個 session、41,000 則 message、8 個並行 generic tasks。

2026-09-05 follow-up：Chrome DevTools 已完成桌面、手機 CPU emulation、長 session、
30 秒 synthetic streaming、network 與 accessibility 量測，見
[`browser-performance-baseline.md`](browser-performance-baseline.md)。完整 raw trace
export 與標準 TBT 仍未取得。下列為原盤點時的歷史 open item：

尚待（原始記錄）：

- 配置 Chrome DevTools MCP後補 browser performance/accessibility trace。

完成 Browser trace 後，下一個工程階段是 Phase 1：由本盤點建立 Stepsemble Protocol v1 schema、sanitized golden fixtures 與 Node contract tests。任何 Rust code 都不應早於這組 contract。
