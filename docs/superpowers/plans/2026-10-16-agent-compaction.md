# Coding agent 原生壓縮 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. 本任務由目前 session 內聯完成，不啟動 subagent，不自動提交。

**Goal:** coding agent 對話提供可靠的 `/compact`，無法原生壓縮的路徑明確停用，完全排除 Hermes。

**Architecture:** Host 以工作區 entry key 解出已擁有的對話，統一處理 capability、busy／Goal 鎖定、UUID 冪等與非同步狀態。各 adapter 只負責自己的原生操作及完成證據；前端單一小模組接斜線選單和執行狀態，絕不修改 `/clear` 或一般 prompt 內容。

**Tech Stack:** Node.js 內建 test／HTTP、無第三方依賴的 CommonJS／browser UMD、Pi RPC、Claude stream-json、Codex app-server、OpenCode HTTP、ACP v1。

---

## 工作區與約束

- 既有本機 worktree：`/Users/jerometeng/.config/superpowers/worktrees/Stepsemble/notification-polish`，分支 `feature/agent-compaction`，基於 `d40a03f`／3.9.6。
- 不在 SMB 寫 build／依賴資料，不修改使用者原生設定，不對正在運作的對話試壓縮。
- 測試繼承環境要清除 `ANTHROPIC_BASE_URL` 與 `CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY`，避免既有 Claude catalog 測試讀到真實資料。
- 不自動 commit／push／合併／發布；使用者此次只授權功能實作。

## Task 1：能力、HTTP 狀態與單次執行邊界

**Files:** 新增 `server/agent-compaction.js`、`test/agent-compaction.test.js`。

- [ ] 先寫能力測試：Pi／Claude 支援摘要說明，Codex／OpenCode 不接受摘要說明，ACP 必須有當前原生公告，Antigravity 停用，Hermes 不列入口。
- [ ] 執行 `node --test test/agent-compaction.test.js`，確認因缺少模組／能力失敗。
- [ ] 定義 action DTO：`{ entry, requestId, instructions? }`；狀態 DTO：`{ supported, instructions, reason, operation: { id, status, error, beforeTokens?, afterTokens?, estimated? } | null }`。reason 使用固定代碼，模型文字不可改變能力。
- [ ] 實作能力正規化與 controller：查 registry、比對原生身份、拒絕唯讀／Hermes／busy／Goal、先占位再 await、同 requestId 不重送、同 entry 一次一個操作。capability 查詢不得送模型請求。
- [ ] 寫有界狀態保留與關閉清理測試：terminal 可淘汰、running 不淘汰；未知 requestId 不可當完成；Host restart 不重播。
- [ ] 驗證錯誤及 competing sends：原生失敗沒有 completed、沒有捏造 token 數，重複請求僅一次執行。

例：
```js
const pending = deferred();
const a = await service.start({ entry: key, requestId });
const b = await service.start({ entry: key, requestId });
assert.equal(a.operation.id, b.operation.id);
assert.equal(executions.length, 1);
assert.equal(service.locked(key), true);
pending.resolve({ completed: true });
await flush();
assert.equal(service.snapshot(key).operation.status, "completed");
```

## Task 2：ACP 公告與壓縮分流

**Files:** 修改 `server/agent-client-protocol-adapter.js`、`server/grok-acp-adapter.js`；測試 `test/agent-client-protocol-adapter.test.js`、`test/grok-acp-adapter.test.js`。

- [ ] 先寫測試：只有該 session 的原生 `available_commands_update` 公告 `compact`／`compress`／`summarize` 才允許；空清單撤回能力、不同 session 不共用、early 公告不被 session/new 回覆清除。
- [ ] 確認失敗後，保存有界且不持久化的壓縮 capability，公開 `compactionSupport(sessionId)`。
- [ ] 壓縮操作只呼叫公告中的精確原生指令；有 input hint 才接受附加說明；沒有公告時在 `session/prompt` IO 前拒絕。
- [ ] 等 prompt 的原生完成／錯誤，檢查 stopReason；`cancelled` 不可算成功。不接受模型自稱「已壓縮」作能力證據。
- [ ] 跑上述兩個 adapter tests，保留既有圖片、模型、fork、permission 行為。

## Task 3：Pi 與 Claude 原生完成證據

**Files:** 修改 `server/claude-code-structured-adapter.js`，擴充 `test/claude-code-structured-adapter.test.js`；Pi 接線由 Host bridge 使用現有 `rpcCommand`。

- [ ] 先寫測試：Claude 發出精確 `/compact` 控制文字，只有 root `system/compact_boundary` 與終端 result 才完成；子 agent／replay 不可算，is_error／process close 必須失敗。
- [ ] 實作 adapter `compact`，保留同一 process／native ID；壓縮中不能送入其他 prompt；完成後只回報原生可確認的數字。
- [ ] Pi 送 `{ type: "compact", customInstructions? }`，等原生 response 的 `success`，轉成統一完成 DTO。失敗／timeout 不重送、不清空會話。
- [ ] 用合成 peer 驗證 Claude desktop stream 仍通用，沒有更改 helper 登入或啟動方式。

## Task 4：Codex 與 OpenCode 原生操作

**Files:** 修改 `server/codex-app-server-transport.js`、`server/codex-native-pool.js`、`server/codex-native-history-adapter.js`、`server/codex-schema-compat.js`、`server/opencode-native-adapter.js`；擴充各同名 test。

- [ ] 先驗證已安裝 Codex schema：`thread/compact/start` 參數／回覆，以及 compaction 完成通知。輸出到本機暫存，不碰原生 HOME。
- [ ] transport 測試：wrong thread／busy／approval 先拒絕，mutation authorizer 非 committed 不寫 IO，非同步授權後重驗，空 ACK 不完成，同 decoder response＋完成事件不丟失，關閉或原生失敗解除 waiter。
- [ ] 新增 `thread.compact` mutation 授權與 journal，pool 對 exact worker 執行，不借用其他 thread 或 history reader。更新 used-method compatibility 清單與測試。
- [ ] OpenCode 測試精確 `/session/:id/summarize`、原會話模型／directory、非 true 回覆拒絕、busy 檢查、無網路 mutation retry。
- [ ] 所有原生測試通過後，把兩者接至 Host compaction bridge。

## Task 5：Host 接線與互斥

**Files:** 修改 `server.js`；新增 `test/agent-compaction-http.test.js`。

- [ ] 先寫合成 Host 測試：auth／origin、entry ownership、read-only history、Hermes exclusion、Goal owned、busy、同 entry 重複／不同 requestId；壓縮時普通 sends 被拒絕且不送模型。
- [ ] 在既有 authentication／origin 主區塊內接 `GET/POST /api/agent/compaction`。
- [ ] 橋接 Pi、Claude、Codex、OpenCode、ACP；Antigravity 明確不可用。POST 執行前重讀 registry 身份，保留 native-work reservation；HTTP 斷線不重送 mutation。
- [ ] `readJSON` 對被壓縮擁有的 entry 禁止交錯 mutation；停止／核准操作仍可用。Goal 開啟必須檢查 compaction lock。
- [ ] 不發一般對話 completion 通知來冒充壓縮完成；由操作狀態回報。

## Task 6：斜線選單與 UI

**Files:** 新增 `public/modules/agent-compaction.js`、`public/modules/compaction-i18n.js`；修改 `public/app.js`、`public/index.html`、`public/sw.js`、`public/style.css`；新增 `test/agent-compaction-ui.test.js`。

- [ ] 先寫 pure parsing：`/compact`／空白／多行 instructions，`/compactor` 不匹配，Hermes 無 item；disabled item 不可執行。
- [ ] 寫 controller DOM 測試：狀態輪詢保持 Host／entry fence、早到的舊回應不更新新視窗、草稿只在 accepted 後移除、附件拒絕且保留、不是 native completed 不顯示完成。
- [ ] `sendCurrent` 在一般 prompt echo 之前攔 `/compact`；保留其他指令路徑與 `/clear` 原碼。使用同一 compaction controller 執行；不新增 general command registry。
- [ ] `updateSlashMenu` 加專用項目並去掉重複 native compact；pick 對停用項目顯示原因，不送 prompt。參數提示依 backend capability。
- [ ] composer 顯示持續且可被輔助技術讀取的壓縮狀態；成功／失敗保留可理解文字；token 未知不顯示假數值。
- [ ] 加 11 語系並用 key／placeholder consistency tests 驗證。新 browser 模組納入 HTML／SW／syntax checks，版本保持 3.9.6。

## Task 7：整體驗收

**Files:** `docs/agent-compaction.md`、相關 preview／test 支援檔與 package checks。

- [ ] 範圍測試先全過，再執行 `env -u ANTHROPIC_BASE_URL -u CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY npm test`。
- [ ] 執行 `npm run check`、`npm run check:client`、`npm run check:protocol`、`npm run check:protocol:conformance`、`npm run version:check`。
- [ ] 以隔離 HOME／localhost 模型 fixture 驗證真實 Claude／Codex compaction，不使用 provider 帳號或現有對話；未安裝 agent 明確標示只有合成協定驗證。
- [ ] 隔離 browser：桌面／手機、Pi／非 Pi／disabled／running／failure／success、英文／繁中、輸入附件與舊回覆 race。
- [ ] `git diff --check`、檢查 `/clear`、Hermes 及模型／權限設定未更動；整理證據與未驗證限制。回報使用者，等待 commit／合併／發布授權。
