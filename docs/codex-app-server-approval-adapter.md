# Codex app-server approval adapter（C3 第一個原生接線切片）

這一切片把 Codex CLI `0.153.4` 的 app-server v2 JSONL 通道接到 Host 的
session journal。它是 Host-only 的 transport/bridge，不會把一般 CLI stdout
的文字當成原生事件。另提供明確 opt-in 的唯讀 history adapter，讓 Agent Hub
與 All conversations 看見官方 `thread/list`／`thread/read` 結果；它仍未把
Codex 冒稱成公開完整 parity。

## 原生邊界

`server/codex-app-server-transport.js` 只接受 pinned app-server 方法：

- client request：`initialize`、`thread/start`、`thread/resume`、`turn/start`、
  `turn/interrupt`；
- readonly history request：`thread/list`、`thread/read`、`thread/turns/list`、
  `thread/items/list`。每頁最多 100 筆，cursor、filter、turn/item 形狀與
  response bytes 都有上限；thread metadata 不會把原生 `path` 提升到 normalized
  public surface。`thread/read(includeTurns)` 與 paginated turn/item pages 仍是
  native observation，沒有自動授權、resume 或 approval authority；
- Codex server request：`item/commandExecution/requestApproval`、
  `item/fileChange/requestApproval`、`item/permissions/requestApproval`；
- lifecycle：thread/turn/item 及 `serverRequest/resolved` notification。

JSON-RPC request ID 保留原本的 number/string 型別，pending correlation 不會把
`1` 與 `"1"` 混在一起。journal 的 string-only `nativeRequestId` 也以 `n:1`／`s:1`
保留此差異，回覆原生時仍使用原本型別。所有 frame、pending request、approval、outbound queue、
stderr retained tail 都有上限；子行程 stdout/stderr、stdin error 與 bounded
SIGTERM→SIGKILL cleanup 均有明確處理。每一個已交給 stdin 的 write 都保留
完成 callback；callback 遺失時會 bounded timeout/reject，close 不會留下懸掛的
Promise。原生 permission 的 `run` 映射為 Codex 的 `turn` scope；較窄的
protocol `once` 不會被靜默放大，而是明確拒絕（`session` 仍映射為 `session`）。
審批 observer 若同步或非同步回 reject，transport 會明確失敗並清理程序，而非留下
未進 journal、又永遠等不到使用者決定的原生 request；已關閉的舊 request 不因此復活。

transport 的 `authorizeNative` 是 journal adapter 的唯一授權邊界。initialize
以外的原生寫入必須拿到 `{ kind: "committed", receiptId, attemptId,
incarnationId }` proof；授權 await 回來後會重新核對 lifecycle、approval row、
thread/turn、decision/scope 及 incarnation，並以 in-flight reservation 拒絕
平行 double dispatch。

## 唯讀 Agent Hub adapter

正常啟動不會因為偵測到 `codex` binary 就啟動 app-server。要明確啟用：

```sh
export STEPSEMBLE_CODEX_NATIVE=1
# 可選：指定 codex 絕對路徑與 app-server 的工作目錄
export STEPSEMBLE_CODEX_BIN=/opt/homebrew/bin/codex
export STEPSEMBLE_CODEX_CWD="$HOME"
```

啟用後 Host 只建立一個 owner-managed `codex app-server --listen stdio://`
子程序，先以 `initialize` 再以 `thread/list` probe；失敗時回到原本的
`canonical_bounded` Codex CLI connector。adapter 只允許：

- `GET /api/codex/native`：狀態與 capability（永遠 `approval: unavailable`）；
- `GET /api/codex/threads`、`/api/codex/thread`、`/api/codex/turns`、
  `/api/codex/items`：有界唯讀資料。對話檢視會先讀 metadata，再以 turn/item
  pages 組合畫面；不依賴大型 `thread/read(includeTurns=true)` 單幀，因此大型
  rollout 也不會因一次回應過大而卡住整個頁面；每一輪仍受 page/cursor/bytes
  上限約束，未載入的頁面會明確保留 cursor；
  `/api/codex/thread` 的 HTTP 預設是 metadata-only，只有明確傳
  `includeTurns=1` 才會要求舊式 full-history response。
- Agent Hub／All conversations 的 Codex rows：標成 `nativeCodex`、
  `readOnly`，可以開啟 transcript，但不會送訊息、resume、abort 或回答
  approval。

adapter 不把 Codex 原生 rollout `path` 放入 browser DTO，也不會由
`thread/list` 直接推導訂閱、登入或 approval 成功；Host shutdown 會先關閉
此子程序並等待 bounded cleanup。

## Journal bridge

`server/codex-approval-bridge.js` 提供 Host-only composition seam。它只接受
transport 先標記 `authority.sourceAuthenticated:true` 的 native request；這個
標記不是 caller 自報即可取得的信任，啟動端仍須在 adapter 外驗證 pinned
executable/schema，再把結果交給 bridge。

流程如下：

1. `observe(nativeRequest)` 先核對 pinned method、thread/turn，以及 journal
   canonical `session.native.{harnessId,nativeSessionId}` 和
   `run.nativeRunId`；再由 Host 產生 approval ID、nonce、timestamp，以既有
   `planObservedEvents` 寫入 `approval.requested`。native `itemId` 不會被冒充
   成 canonical `toolId`，沒有已驗 tool mapping 時固定寫 `null`。
2. `resolve(requestId, intent)` 以固定的 command/idempotency intent 呼叫
   `planAdmission`，再呼叫 `planDispatch`。只有 dispatch 已在 SQLite commit
   且 `authorizeNative` 再次核對 outbox 後，才讓 transport 寫原生 response；
   callback 完成（pipe flush）後才以 `planPipeAccepted` 前進 receipt。
3. `serverRequest/resolved` 只代表 Codex listener 關閉了該 request。Codex
   也會在 interrupt、尚未回答的 approval 上送這個通知；通知不帶 decision，
   所以 bridge 永遠不會據此產生 `approval.acknowledged`，receipt 會停在
   `awaiting_confirmation`，需另一個獨立、驗證過的 native evidence 才能
   settle。
4. close、resolved、journal worker uncertain 都不會自動重送。有限 tombstone
   保存 replay 所需的 command intent，以及經 transport 既有上限截斷、可供
   verified-ACK adapter 做 correlation 的 detached request envelope；不保留無界
   stdout 或額外原始串流。ACK verifier 仍只能由 Host 注入，重試會重新走 journal
   grant/CAS，撤權後會得到 `not_authorized`。

這個 bridge 沒有替 production HTTP/UI 宣稱 Codex session parity；呼叫端仍須
提供已驗的 session/run/native mapping、device grant、incarnation 與其他
lifecycle authorizer。

## 驗收證據

`test/codex-app-server-transport.test.js` 使用 owned `PassThrough`/fake native
process 與真 SQLite `session-journal-client`，不啟動模型、不讀私有歷史、不碰
登入或憑證。測試涵蓋：

- 原生 approval request → `planObservedEvents` durable pending → admission →
  dispatch → flushed native response → correlated `serverRequest/resolved`；
- resolved 不被當成 ACK、reopen 不自動 resend、撤銷 grant 後 idempotent replay
  重新被 journal 拒絕；
- request/response typed-ID、非法 command array、active-turn resume、平行
  authorization/lifecycle race、5000 個合法 notification，以及忽略 SIGTERM
  的 owned child 最終 bounded cleanup。

`test/agent-connectors.test.js` 另驗證 generic supervisor 的超長行會丟棄至下一個
LF；中段出現 `STEPSEMBLE_EVENT ` 不會被提升成 approval。generic stdout
observation 仍是 `sourceAuthenticated:false`，不能取代上述原生通道。

focused transport test 另覆蓋 observe 等待 journal 時收到 closure、closure 後
late writable callback 更新 tombstone、native item correlation、Windows absolute
cwd、permission scope、未知/排除 turns 的 resume reconciliation、同一 stdout
chunk 的 turn completion/interrupt race，以及沒有 stdin callback 時的 bounded
close/reject；新增 history list/read/turn/item 的官方方法、cursor/filter
validation、bounded page 與 malformed-response fail-closed cases。

## 尚未涵蓋

首輪 GitHub CI（工程 `0f6c3e6`）保留兩個測試失敗：Linux 的 observe-race
測試以固定 `setImmediate` 次數等 worker，可能在真正進入前太早斷言；已改用實際
進入 transaction wrapper 的 Promise 訊號。Windows 的 Node SIGTERM 會直接終止
child，不能套用 POSIX 必須升級 SIGKILL 的斷言；兩平台仍都要求 actual close／
cleanupConfirmed。修正不延長產品期限、不跳過案例、不改 native runtime 行為。

- C3 的 approval bridge 仍未接入 production HTTP/UI；本輪接入的是 C2 唯讀
  app-server history adapter。Claude/OpenCode/Grok 的 approval authority 仍各自
  依其上游契約分級，不會共用這個 Codex adapter。
- bridge 的 `acknowledge(requestId, details)` 現在可在 Host verifier 回傳精確
  `native_ack`／`authoritative_readback` 後，以 `planApprovalAcknowledgement` 原子
  settle receipt、approval projection 與 event；沒有 verifier 或 evidence shape
  不符時 fail closed。這仍不是 production proof provider，也不會由
  `serverRequest/resolved` 自動觸發或自動 resume。
- `serverRequest/resolved` 沒有 decision evidence；要完成 receipt settlement
  仍需另一路由的原生 readback/attestation，不能以 listener close 猜測成功。
- `thread/resume` 若回傳未知 turn status 會停在
  `reconciliation_required`，不會猜測可開始新 turn；由上層提供 reconciliation
  後才能繼續。
- `thread/status/changed` 僅接受 pinned schema 的 tagged status object；未知形狀
  只作 bounded diagnostic，沒有 native authority 意義。
- app-server binary 的 runtime version/executable trust 仍由 launch/admission
  owner 驗證；adapter 的 `0.153.4` pin 是 protocol/schema boundary，不是對
  私人帳號或訂閱狀態的自動驗證。
