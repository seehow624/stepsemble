# Session journal：原子保存審批、命令與事件

2026-09-11。`server/session-journal.js` 將既有 `protocol/transaction-state.js`
規劃器接到真正 SQLite transaction。這是 Host 內部元件，尚未接公開 API 或正式服務。

每次 admission／dispatch 都在 `BEGIN IMMEDIATE` 內讀取最新 session 與 device grant，
呼叫既有規劃器，將 projection、receipt、private outbox 與新增事件一起提交。
使用 `synchronous=FULL`；只有 commit 成功才回 `committed`。原生傳送端必須等這個
結果，不能在取得規劃器的 detached proposal 後便開始傳送。

相同命令沿用既有 fingerprint/idempotency 規則。撤銷 grant 後，連已接受命令的 replay
與尚未開始的 dispatch 也須重新通過授權。兩個 connection 競爭同一 approval 時，只有
一個決定成功；失敗的 transaction 不留下另一筆事件、receipt 或 outbox。

初始化明確接受一份已驗證 snapshot。snapshot 的 cursor 是 replay 下限；較早事件並
沒有被憑空重建，要求下限以前的 cursor 會得到 `snapshot_required`。
後續事件依 generation／sequence 回放，每頁最多 100 筆。
每次讀取 snapshot 也核對實際事件數、generation、首尾序號與連續範圍；回放頁面另核對
事件 schema 與索引身分。缺失事件回 `journal_corrupt`，不假裝是正常 replay 下限。

## 重啟與失敗驗證

`node --test test/session-journal.test.js` 使用真正暫存 SQLite 檔案，覆蓋：

- 決定後關閉、重新開啟，projection／receipt／outbox／event 一致，重送取得原 receipt。
- 兩個 connection 同時決定同一 approval，僅有一位 winner。
- grant 撤銷不能被 caller 的 `authorized:true` 覆蓋。
- planner 拒絕錯誤事件時不改資料。
- 在 SQLite event INSERT 後，以 owned trigger 令 snapshot UPDATE 失敗，整批 rollback；
  移除 trigger 後可用相同事件與 receipt ID 成功重試。
- 子程序完成 dispatch commit 後立即遭 SIGKILL；重新開啟仍保留 attempt，不允許第二次
  dispatch。`planRecovery` 將送達結果標為不確定、run 標為 orphaned，且再次重新開啟仍保留。
- 拒絕 symlink／對其他使用者可讀的資料檔，以及 worker 啟動中的待處理容量上限。
- SQLite `quick_check` 仍正常、但事件被刪除時，read／replay／decision 均拒絕；事件
  payload 與索引身分不一致時，回放拒絕。

本機 Node 22.22.3 與最低 Node 22.19.0 均為 11 tests／11 pass／0 fail。

這些測試驗證 process crash 與資料庫交易，沒有驗證突然斷電、硬碟故障、網路重連或
原生 agent 的 ACK。native evidence 的驗證仍由 adapter 負責。

主審已核 Codex 原始碼 `3d2ee51ca2d5db578f328aa75e20aa22c0197c9a`：
`app-server/src/bespoke_event_handling.rs` 的 command/file approval handler 先發出
`serverRequest/resolved`，才解析回覆並提交 approval；permissions handler 也相同。
`app-server/tests/suite/v2/turn_interrupt.rs` 另有未回答審批、直接 interrupt 也收到該
通知的案例。因此不能只靠此通知呼叫 `planApprovalAcknowledgement`。若原生證據只
能確認請求結束，仍須保留 ACK 未確認，不得把 Host decision 或 stdin write 當批准成功。

## 整合界線

只有 Host 內部可信程式可呼叫 `setGrant`、選擇 planner 與提供 native evidence context；
不得把這些參數直接映射成使用者可填入的 HTTP 欄位。UI 顯示與決議 API 還必須接上
既有已認證 device/session 權限。

目前要求 POSIX owner 私有目錄與資料檔；Windows 缺少 ACL 驗證，會在建立檔案前明示
unsupported。單一 snapshot 上限 8 MiB、每 session journal 100,000 筆事件、SQLite
檔案上限 256 MiB；達上限會拒絕新增，沒有偷偷刪除 receipt 或歷史。
這是可信 Host／同一 OS 使用者內的邊界，不防同 UID 惡意程序在檢查後替換檔案，亦非
歷史內容的防竄改簽章；不得將 Rust held-FD 的來源安全保證套用到這個 SQLite 元件。

使用 Node 22.19+ 的 `node:sqlite`，屬於該版本的 experimental API。
`session-journal-client.js` 已把 SQLite 與 projection 驗證放在專用 worker；最多 16 個
待處理要求、單筆 8 MiB／整個待處理佇列 16 MiB、預設 10 秒期限。worker 失敗或逾時會回結果不確定，終止 worker 且不自動
重送寫入。Host 整合應使用此非同步 client；worker 的實際寫入與重新開啟測試已通過。
現階段沒有宣稱 Windows、跨機器、原生 ACK 或完整 C3 parity 已完成。
