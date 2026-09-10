# Codex 原生審批協議驗收

2026-09-11，主 agent 以官方原生 Codex 0.153.4 執行
`scripts/check-native-codex-approval.mjs`，通過既有版本及 schema baseline 檢查後，
在全新 owned HOME／CODEX_HOME 啟動 app-server。模型來源是綁定 127.0.0.1 的
固定 SSE fixture，不使用使用者帳號、憑證或付費模型。

實際流程是 initialize → thread/start → turn/start →
`item/commandExecution/requestApproval` → 不回答審批、呼叫 turn/interrupt →
`serverRequest/resolved` → `turn/completed`，最後狀態 interrupted。
測試確認沒有送出 approval response，不能把 resolved notification 當成批准成功。
原生程序結束、owned 目錄清理後才回報通過。

另有 POSIX 的第二個真原生案例：先把 owned Host 的 session/run bootstrap 明確綁到
剛收到的 native thread/turn ID，再由 bridge 將真 approval 寫進專用 worker 的 SQLite。
送出「拒絕」經 admission → durable dispatch → native response → pipe accepted；
原生繼續收到本機 fixture 的結束文字並完成回合。測試命令若執行會建立 owned marker，
兩案例皆確認 marker 不存在。關閉再開 journal 後，拒絕決定與 `awaiting_confirmation`
receipt 仍在，只送一次 response；即使 native resolved／turn completed，也不憑此猜測
decision ACK。這是 owned bootstrap，不是私人歷史匯入或 production lifecycle 接線。

本機結果：

```json
{"result":"passed","nativeVersion":"0.153.4","scope":"owned_native_approval_interrupted_before_answer","modelRequests":1,"realModelRequests":0,"approvalMethod":"item/commandExecution/requestApproval","requestResolvedWithoutApprovalAck":true,"terminalStatus":"interrupted","remainingChildren":0,"cleanupConfirmed":true}
```

第一次嘗試在 config.toml 設定 `approval_policy="untrusted"` 被原生明確拒絕。
按照固定原始碼的測試，改為 config `on-request`，thread/turn request 使用 `untrusted`
後通過。保留這項差異，不能將 JSON-RPC 與 config 設定視為完全相同的可選值。

此測試已加入 native Codex CI workflow；本機通過不代表其他 OS 的 CI 已通過。
本機 Node 22.22.3 與最低 22.19.0 的兩案例皆通過；第二案例 `modelRequests:2`（全為
本機固定 SSE）、`realModelRequests:0`、`journalReopenVerified:true`、
`commandExecuted:false`、`cleanupConfirmed:true`。Windows 仍可驗第一案例，第二
案例會明示 `journal_owner_acl_not_implemented`，不能將 unsupported 當 Windows journal 通過。
它驗證真正的 native request／interrupt／notification／journal-backed denial，沒有驗證批准執行、
Claude 或其他 agent、正式 HTTP/UI、跨裝置、完整 resume/history 或訂閱使用。
fixture 的 `authorizeNative` 是明確的 owned 測試授權；正式接線必須使用
[session journal](session-journal.md) 的 durable dispatch 與已認證 session/device。

原生語義來源：Codex source commit `3d2ee51ca2d5db578f328aa75e20aa22c0197c9a`，
`app-server/src/bespoke_event_handling.rs`、`app-server/tests/suite/v2/turn_interrupt.rs`。
command/file/permissions approval 都在解析／提交決定以前發 request-resolved notification，
取消也會發同一通知；不能據此製造 native ACK。

2026-09-11 另核對 [OpenAI App Server 官方文件](https://learn.chatgpt.com/docs/app-server)：
resolved 可表示回答或清除請求；permission grant 的原生範圍是 turn／session。
因此 adapter 不可把 permission 的 `turn` 說成「僅這一次」，也不可把 cleared 當批准。
官方頁是交叉確認；本批線上格式仍固定 0.153.4，不能直接套用未驗證的新版本欄位。
