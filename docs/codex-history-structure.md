# Codex 歷史的來源關聯結構（Plan 1.72／進行中）

這一段將原始紀錄補上回合與工具關聯，供後續可讀對話介面使用。
**目前只接到既有的背景讀取 pipeline，尚未接 HTTP／Web；不是 C2 完成。**
既有 Web 原始紀錄、正式 3.0.6、開發 rc.7、私人來源及獨立 72h 均不變。

## 固定來源與行為

- Codex `0.153.4`，原始碼 `3d2ee51ca2d5db578f328aa75e20aa22c0197c9a`。
  本輪核對 `app-server-protocol/src/protocol/thread_history.rs` 的完整 production
  builder、`thread_history_projection.rs`、`thread-store/src/local/thread_history/read.rs`
  及 protocol error 的 terminal 判斷。後兩者是另一套 paginated store，不能套到 legacy。
- [官方 App Server 文件](https://learn.chatgpt.com/docs/app-server) 的 stored
  `thread/read` 與 resume 分開。實際驗證只對自建 HOME／資料使用固定 CLI 的唯讀方法；
  不採用最新版文件中實驗方法來冒充固定版本已支援。
- `rollout-structure.js` 將每筆原始記錄連到來源索引 `record-N`。明載的 turn ID 才能
  成為 `nativeTurnId`；隱含邊界的 ID 為 null、狀態 unknown，不照抄 native 的合成 ID／
  預設 completed。`recordedStatus` 是檔案記錄，不是目前有程序執行的證據。
- user／assistant／reasoning、明確 start／complete／abort、compaction、rollback、
  tool begin/end/request 及未知資料均保留原文。model-context response items 不重複
  宣稱為另一則使用者訊息；尚未完整解讀的 item／hook 等仍須保留原文與能力界線。
- 工具以回合、family、call ID 關聯；晚到結果可指回上一回合、跨頁仍有來源索引。
  重複 ID／begin/end 明示歧義，不偷偷換配對。approval request 不是核准回執。
- rollback 標記原回合為 rolled_back，原始 bytes 不刪除；重用 ID 不復活已回滾工具。
  與 native compatibility fallback 刻意不同：未知明確 turn ID 不附到目前回合、不
  結束另一個回合。不把這個保守索引稱作 native ThreadHistoryBuilder 等價實作。

## 邊界與背景接線

- 繼承原始讀取的 8 MiB／8,192 records／128 KiB 單筆／50 records 單頁，結構頁
  總量 272 KiB；必要時縮小回傳筆數，以 nextOffset 延續，不截掉原文或漏筆。
- 所有 `session_meta.cli_version` 必須與固定版本一致；缺少版本或未知格式不回傳
  結構。原始 raw 模式的相容性不變，未放寬既有 UTF-8／JSON／來源 ID 驗證。
- 既有 permissioned worker 新增 v5/v6（raw-structured／named-structured）；v1–v4
  仍拒絕新欄位，避免無聲降級。結構 DTO 嚴格驗證索引、邊界、狀態、回滾、已顯示
  回合計數及同頁工具雙向關聯；跨頁引用是受限 worker 的解讀，不是來源認證。
- `read`／`readNamed` 明確 opt-in `structured: true` 且 selection 必須 records。
  plain 與 bounded zstd 使用同一 decoder／worker，沒有新增程序池或 source grants。
  named 維持 SQL A → bytes A → parser → SQL B → bytes B，同 Host 兩名額、
  總期限、雙版本重驗、取消與 actual close；cleanup 不明仍 quarantine。
- sourceAuthenticated／publishable／semanticHistoryComplete／executable 均不升為 true；
  process-local snapshot handle 不出 worker。不新建 transcript cache 或寫原生來源。

## 本機證據（2026-09-09／Mac Mini）

- 固定真正 Codex：7 份普通 legacy 對話共 49 turns／147 messages 的順序及內容
  與結構索引吻合；另一份 rich fixture 的明確 turn ID 相同。全部原始資料共
  219 records／113 小頁逐 byte 相同，結構合計 50 turns。
  native rich 投影省略 commandExecution／imageView 的既有差異仍保留；索引不漏原文。
  0 model endpoint requests、0 loaded threads、11 source files 不變、actual cleanup。
- 實際 Rust reader／permissioned parser：結構化 16 records／8 小頁、跨頁工具關聯、
  真 Claude SDK peer 共用兩名額；named 的 5 階段取消與雙來源版本拒絕、原文不變通過。
  該 gate Codex 部分總計 190 spawns（包含 nested SQLite／named），剩餘 0；不能重複相加。
- 新核心 19 tests、parser 5 tests、named 2 tests；包含接近 8 MiB 且 8,192 records
  在真正 128 MiB heap worker 中完成。這不是無上限歷史或整體 Host RSS／手機效能保證。
- 完整 Node22.22.3 與最低22.19 各 1,012 total／1,010 pass／2 skip／0 fail；最後加強的
  near-byte-limit worker 測試另在兩版本通過。Rust 29 lib／33 binary、跨程序清理通；
  fmt／clippy／syntax／generated client及protocol／version／actionlint／gitleaks 通過。
- 新增結構後真正 native、一般、reader 等 exact-SHA CI 待提交後核對，不能借前批成功。
  HTTP/Web 此時仍是舊 raw DTO；既有 Host/browser 回歸不能算結構 UI 驗收。

### 本輪失敗及修正（保留，不洗成綠色）

1. pipeline benchmark 初次誤用 `protocol` 而非 `protocolVersion`，job 被正確拒絕；
   修正測試欄位並先 assert validated frame，第二次實際全鏈成功，未放寬產品 decoder。
2. 新 malformed-message test 初版要求保留 unpaired surrogate，但原有 JSON gate
   正確拒絕它；改為分別驗有效 JSON 的未知資料保留及無效 Unicode 拒絕。
3. 最低 Node 全套曾在既有 Claude deadline test 失敗：牆鐘等待 60ms 後，實際已過
   100ms 總期限，0 parser spawn 卻被測試要求為 1。產品正確拒絕過期工作；測試改用
   受控 timer／monotonic clock，精確驗 60ms 轉階段、99ms 未殺、100ms 殺且不延長期限。
   另加 101ms 且 timer callback 尚未執行時仍拒絕下一階段的回歸；不調大產品期限。

原始 logs 在本機 `/tmp/stepsemble-structure-*`；失敗的 pipeline-1、focused-3、
minimum-1/2 與成功的 pipeline-2、native-3、full-4、minimum-3、near-limit-* 分開保存。

## 接續：仍需完成，不能停在 library

1. 把此 opt-in 結構接 source service → registry → 嚴格 HTTP／peer → typed client，
   保持舊 raw DTO 相容、版本與租約／撤權圍籬；拒絕未知版本時仍可明確選 raw。
2. Web 以可讀回合、訊息與工具關聯呈現，unknown／model context／rollback 可核對原文；
   不顯示成可核准／續跑。單頁 DOM、完整長文、i18n、focus、320/390px 及取消／重連驗收。
3. 真 owned Host 與 Computer Use 操作、跨平台 CI，以及大型歷史限制與其他 adapter。
   paginated store、完整 native item 語義及 C1–C8 未完成，不以本段或 72h 結果代替。
