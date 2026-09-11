# Generic connector approval observation（C3 第一個可驗收增量）

> 狀態：已完成本輪合成驗收（Host-local proposal；不是已發布能力）
> 進度：Plan 1.86／C3 第一步
> 範圍：Claude Code generic connector 的通用 stdout 邊界；同一邊界可供其他 allow-listed CLI 重用

## 這次補上的缺口

generic connector 原本只有 terminal stdout/stderr、短期 event buffer 和停止控制。
本增量補上一條嚴格的 machine-readable approval observation 邊界，以及一個 Host-local
的決議 proposal helper：

1. detached supervisor 只從 stdout 接受精確的 `STEPSEMBLE_EVENT ` 前綴，將後面的 JSON
   解碼成 `approval.requested` observation；一般 CLI 文字仍只是 output。
2. `server/agent-connectors.js` 把 observation 交給有界的
   `server/connector-approval.js`。它綁定 task／agent、session、run、native event、
   native request、nonce 與 approval ID，拒絕重複或衝突的身份。
3. `connector-approval.js` 的純 Host 測試 helper 依 `protocol/v1` 的
   `approval.resolve` 欄位和 `sha256-tuple-v1` fingerprint 產生一筆 accepted
   `commandReceipt` 與私有 outbox proposal。generic task service **不再暴露這個 helper
   作為決議路徑**：它固定回 `durable_transaction_required`，避免沒有 authenticated
   grant／canonical run projection 時繞過既有 transaction planner。真正 adapter 必須呼叫
   durable journal。

這是可獨立測試的 Host 內部邊界，不是新 HTTP route 或前端功能。CLI 自己輸出的
`approval.resolved`、ACK、`resume` 或其他未列入 allowlist 的 JSON 永遠不會被正規化成
權威事件。

## 重啟 replay 的明確範圍

generic task 的私有 `agent-tasks.json` 現在會在既有 output tail 之外，保存最多 64 筆／
128 KiB 的 `output`、`status`、`input`、`task_started`、`task_exit` 非授權事件，以及
Stepsemble 自己的 SSE cursor。服務重啟後先恢復這個有限窗口，再 attach detached
supervisor；超限資料從最舊端淘汰。`protocol_event`、`protocol_event_rejected` 和所有
approval observation 會被過濾，不會因為 snapshot replay 而重新建立 approval state。
因此這是 UI context／重連體驗的改善，不是完整 session history、durable journal 或
approval recovery；`resolveApproval()` 仍固定回 `durable_transaction_required`。

## Observation 形狀與安全界線

事件行必須是：

```text
STEPSEMBLE_EVENT {"type":"approval.requested", ...}
```

JSON event 和 approval 都是 closed shape；目前只允許下列資料：

- event 的 `sessionId`、`runId`、`nativeEventId`、RFC3339 `createdAt`，以及
  `payload.approval`；
- approval 的 ID、`pending` 狀態、`once`／`run`／`session` scope、未過期的
  `expiresAt`、最多 512 字元的 `request.summary`、nonce、可空的 `toolId` 和
  `nativeRequestId`；
- 單行上限 128 KiB；沒有精確前綴、錯誤 JSON、過期 event、控制字元或額外欄位一律
  丟棄，不進 approval state。

每個 task 最多保留 32 筆 pending observation、5,000 筆 receipt，private outbox 總計
64 MiB；超限一律拒絕新決議，不驅逐舊 winner。相同 approval 的正規化資料完全相同時
重送回報 `duplicate`；相同 approval ID 的變形、重用 native event／request 或 nonce
回報固定 conflict code。所有接受的 observation 都帶明確：

```json
{"sourceAuthenticated":false,"approvalAcknowledged":false,"resumeAllowed":false}
```

這個 authority object 是負向保證，不是權限授予。receipt 不包含原始 prompt；command
payload 只留在 private outbox proposal，尚未交給任何 native process。

## 決議流程（目前停在 proposal）

純 helper 先做 exact correlation：`deviceId`、`sessionId`、`runId`、
`approvalId`、`nonce`、scope 必須和 observation 完全相同，decision 只能是
`approved` 或 `denied`。receipt／command index 以 tuple key 保存，避免同一 approval
有兩個 winner；fingerprint 不同的同 key 重送回報 `idempotency_conflict`，已決議 approval
被另一個 key 搶答回報 `approval_conflict`。

成功 proposal 的狀態刻意是：

- receipt：`accepted`、`revision: 0`、`attemptId: null`、`outcome: null`；
- outbox：保留 exact command，`dispatch: null`、`operation: null`；
- approval：保存 decision、resolution receipt、device 和 revision 1，但
  `nativeAcknowledgement: null`；
- 回傳欄位：`nativeAcknowledged: false`、`resumeAllowed: false`。

因此決議不是 native delivery evidence，也不會改變 generic task 的 running／waiting
狀態、寫入 CLI stdin 或自動 resume。這個 helper 是 detached reference proposal；generic
task service 不會代它執行。未來真正 worker 必須在 durable transaction 中重讀 grant、
run／approval state，CAS receipt，先提交 dispatch marker，再做 native IO。

## 明確未完成的部分

本增量不宣稱 Claude Code 或其他 generic connector 已達 Pi parity，也不把下列項目藏在
API 後面：

- 沒有公開 HTTP／SSE approval route、UI approval sheet 或 authenticated device/session
  grant；generic service method 會固定拒絕，只有 Host-side detached helper 可供合成測試，
  後續真 adapter 必須直接接 durable journal。
- `connector-approval.js` 和 supervisor event window 都是 process-local。task JSON
  現在另外保存有限的非授權 output/status/input/lifecycle replay，但仍只是 reconnect
  context；Host crash/restart 後不會假稱已恢復舊 approval，亦未提供
  durable journal、generation／cursor、CAS commit 或 replay tombstone。child/supervisor
  exit、orphan 或 task terminal 時會清空 pending／receipt／outbox；不會把失效 approval
  留給 stale helper。若 supervisor 仍存活，Host restart 只會重新觀察仍在 event window
  的原始 observation，這不是 durable recovery 或 native proof。
- 沒有 native adapter、stdin decision protocol、native ACK／authoritative readback、
  delivery attempt、proof verification 或 resume；approval expiry/cancel/terminal
  projection 仍須接既有 lifecycle／transactions contract。
- 沒有把 generic task 轉成 canonical `session`／`run`／`waiting_approval` projection，
  也沒有因此更新 Codex、Grok Build 或 OpenCode 的 capability 宣稱。

## 合成驗收證據

測試只建立暫存目錄、synthetic `claude` shim 和 fake child；沒有呼叫模型、讀取私人
`HOME`、碰帳號／憑證、部署或重啟 3140 正式服務。

| 驗證 | 覆蓋內容 |
| --- | --- |
| `test/connector-protocol.test.js` | 前綴、closed shape、timestamp／expiry／128 KiB 邊界、拒絕 self-ACK／未授權 JSON |
| `test/connector-approval.test.js` | task correlation、native ID／nonce uniqueness、32 筆容量、單一 winner、receipt／outbox、replay、expiry 和 fail-closed |
| `test/agent-connectors.test.js` | fake Claude stdout → supervisor → Host observation，決議 proposal 不寫 CLI、不 ACK、不 resume，且仍可停止 child |

另有 bounded review：任意 stdout 文字（包括工具／模型輸出）都能偽造這個 synthetic
前綴，因此它永遠標成 `sourceAuthenticated:false`，不能成為 native evidence。現在 generic
service 不會把它送進 durable `approval.resolve`；task 結束後也立即清除 process-local
狀態。

本輪聚焦指令：

```bash
node --test test/connector-protocol.test.js test/connector-approval.test.js test/agent-connectors.test.js
npm run check
npm test
```

本輪實際輸出：`npm run check` 通過；`npm test` 為 1,165 tests／1,163 pass／2 skip／0
fail。合成測試不等於真 CLI、真 native evidence、durability 或跨 OS parity 證據。

## 接續

### 2026-09-11：修復快照與 observation 回放競態

GitHub `7eb54ff` 的 Ubuntu general CI 揭露真實遺漏：快速 child 在 Host attach
之前已送出 observation，文字快照卻把共用 event cursor 推過它，導致後續 replay
被當成重複而略過。不是增加測試等待時間就能修好的問題。

Host 現在分開追蹤文字快照 cursor 與 process-local protocol cursor，attach 以兩者
較小值要求有界回放。protocol 依自己的 sequence 去重，舊 output 不再追加；terminal
snapshot 也會關閉 pending state。Host restart 的 protocol cursor 從 0 開始，只恢復
supervisor 尚保留的 observation，不承諾完整歷史或 durable approval recovery。

新增可重現的 owned socket 測試：先送 seq 2 文字快照，再重複送 seq 1 observation
及 seq 2 output，要求 observation 恰好一次、文字也恰好一次。原本的真 supervisor
synthetic child 測試保留。修正後 Node 22.22.3 和最低 22.19.0 各為 1196 tests／
1194 pass／2 skip／0 fail；跨平台結果以該修正 exact SHA CI 為準。

下一步應把 observation 封裝進 Host durable journal（由 Host 指派 event ID／sequence／
generation），在同一 transaction 內和 authenticated session/run／pending approval
做 CAS，然後再為單一 harness 實作 native delivery、ACK proof、reconnect/crash replay
與 explicit resume。未通過這些 gates 前，產品仍應把 generic connector 顯示為 terminal
integration，不能宣稱完整 session／approval／resume。
