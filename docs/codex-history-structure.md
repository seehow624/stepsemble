# Codex 歷史的來源關聯結構（Plan 1.72／Web 接線已驗，未部署）

這一段將原始紀錄補上回合與工具關聯，並接入真正的 Host／HTTP／Web。
**工程 `b8d18436c1fa63ceb9074ecdaf938303543b17e1` 已完成此接線；
`e9aac82aa8921f2b8d6dc8dbf518fc36f85735a1` 修正模式切換的真 HTTP 收尾競態。
仍不是 C2 整體完成。**
既有 raw API 保持相容；正式 3.0.6、開發 rc.7、私人來源及獨立 72h 均不變。

## Web 接線增量（2026-09-09 11:29 MYT）

- `structured: true` 明確穿過 source service、registry、HTTP、peer relay、typed client。
  registry 先確認來源是 Codex，Claude／metadata／false／未知欄位不啟動讀取；撤權、
  source version、generation、實際清理與舊 raw DTO 不變。結構回覆不能無聲降級。
- parser 與 public boundary 共用嚴格 `codex-history-records` validator；受限 worker
  只多一個固定程式檔 read grant，沒有原生來源路徑、model、登入或執行權限。
- 實際 Web 預設對話檢視；原始模式可明確切換。回合標成歷史狀態，沒有 native ID
  時標推定／未知；回退內容仍在。assistant 使用 Codex identity，model-context 不
  當第二則對話，未知紀錄可展開。長文不截斷、內層捲動，raw JSON 仍惰性且只展開一筆。
- 跨頁工具關聯按鈕沿用同 source version，跳轉後聚焦確切 record heading；不執行工具。
  跳轉後上一頁停用，下一頁循真正 nextOffset，重新整理回開頭。模式切換立即清除
  舊畫面，但不把fetch abort誤當Host關閉：等待舊bounded唯讀回覆收尾後再讀新模式；
  舊內容不得覆蓋新模式。明確取消／關閉仍可abort，一頁留存與撤權保護不變。
- 修正後本機 Node22.22.3／最低22.19 各 **1019 total／1017 pass／2 skip／0 fail**。
  新增七測試，含 strict vocabulary／Unicode、HTTP全頁、模式競態／downgrade、DOM、
  Claude 零誤讀；既有 peer 測試也驗新結構轉送。build／generated／version／fmt／
  clippy／syntax／actionlint／gitleaks 通過。
- 真 owned Host 先完成原39筆 cold／compressed／名稱／復原 gate，再以新23筆／3回合
  驗 full pages、跨頁4↔13工具、回退及推定回合、raw逐筆相同、壓縮version與撤銷。
  0model／0private history reads，Host/writer actualclose及兩owned目錄清理確認。
- Computer Use 實際390px與320px：13050字長文保留結尾，224px內捲動 PageDown
  0→196，外頁1835不動；無橫溢、按鈕≥44px、Codex圖示、跨頁聚焦record13、回退與
  推定unknown、raw切換及關閉清空均驗。這是瀏覽器viewport，不是真實iPhone。
  i18n11語有CI案例；本機實看發現錯用舊auxiliary/expand文案，已換專用key並加回歸。
- 開發中同rc.7的24h靜態快取曾顯示舊文案，改用全新owned Host origin驗最新build；
  不修改正式cache或部署。唯讀租約在人工驗收期間過期時正確要求refresh，更新後跳轉通。
- b8d1843一般／原生Claude／原生Codex／reader四CI已通並核full logs；rolling出現
  真模式切換競態，已修為e9aac82，新四CI全部通過且完整logs已核，見下表。

本輪 logs `/tmp/stepsemble-structured-web-*`：full-3.tap、minimum-2.tap、host-2.log、
boundary-2.tap、clippy-1.log、secrets-1.log。保留 view-1／integrated-1 的新測試fixture
呼叫錯誤（snapshot API、必要signal、assistant實際在下一頁），以及host-1遺漏owned
fixture command allowlist的失敗；修正測試而未放寬產品協定。所有owned程序已清理。

### Web CI 發現的實際缺陷與修正

- [b8d1843 rolling34307301537](https://github.com/seehow624/stepsemble/actions/runs/34307301537)
  兩OS均在壓縮來源重開後超時：Linux1440/light、Mac1440/dark；Mac前一light組通過。
  不清洗成成功。full log `ci-rolling-1.log`，Linux獨立job完整log
  `ci-rolling-linux-1-complete.log`；沒有轉義旗標的第一個下載檔為空，不能當證據。
- 真HTTP新增red test `mode-race-before.tap`精確重現`source_busy`：client abort先回來，
  Host仍持有reader，model卻以為flight.done代表actualclose。不是單純CI等待時間太短。
- e9aac82對模式切換採立即更新偏好與清空舊頁、等待原bounded唯讀回覆，不abort-fetch
  後立刻發第二次讀取；取消/關閉仍可中止。新測試用held reader＋真HTTP，先確認新模式
  busy且沒有第二讀，逐階段真正完成兩輪，再驗raw／physical0；修後`mode-race-after.tap`
  通。完整與最低Node各1019/0fail（full-4／minimum-3），不是調大timeout或跳過案例。
- CI失敗時新增有界UI診斷（status/warning/mode/record count），只用owned合成資料，
  不dump歷史、不自動重试掩蓋失敗。

| b8d1843 gate | 結果 |
| --- | --- |
| [一般34307301629](https://github.com/seehow624/stepsemble/actions/runs/34307301629) | 三OS1018/0fail；Mac1016pass2skip、Linux1015/3、Win968/50 |
| [Claude34307301559](https://github.com/seehow624/stepsemble/actions/runs/34307301559) | 固定SDK2.1.259合成readback、分頁／原文／權限邊界、0model；Windows source unsupported保留 |
| [Codex34307301578](https://github.com/seehow624/stepsemble/actions/runs/34307301578) | 三OS147messages／50結構turns／219raw、0model／0loaded／11files不變；完整投影仍未支援 |
| [Reader34307301540](https://github.com/seehow624/stepsemble/actions/runs/34307301540) | 三OS243reader＋25structure＋10compressed；POSIX真Host39raw＋23structured／3turns及cleanup，RustSec0/0 |

本批reader Rust仍POSIX29/33、Windows27/15；43packages、RustSec0.22.2、DB bf25f657…、
lock aa93d9…不變。Windows私人source/真Host仍unsupported/skipped，不能算全平台產品支援。

### 修正後 exact CI（2026-09-09 11:43 MYT）

以下均為 `e9aac82aa8921f2b8d6dc8dbf518fc36f85735a1`，全部success且full logs已核。
不是重新標綠原失敗；本輪未更動的native Codex維持上述b8d1843證據。

| Gate | 結果 |
| --- | --- |
| [一般34307855470](https://github.com/seehow624/stepsemble/actions/runs/34307855470) | 三OS1019/0fail；Mac1017pass2skip、Linux1016/3、Win969/50；新增真HTTP模式競態回歸通 |
| [Claude34307855413](https://github.com/seehow624/stepsemble/actions/runs/34307855413) | 固定SDK合成契約與授權/唯讀邊界通，0model，Windows source unsupported不變 |
| [Reader34307855452](https://github.com/seehow624/stepsemble/actions/runs/34307855452) | 三OS244reader＋25structure＋10compressed；POSIX真Host39raw＋23structured/3turns/cleanup，RustSec0/0及固定DB/lock不變 |
| [Rolling34307855519](https://github.com/seehow624/stepsemble/actions/runs/34307855519) | Mac/Linux各24原case＋6Codex三尺寸×明暗；可讀/raw、完整長文內捲、跨頁工具、回退/推定回合、11語不重讀、冷/壓縮/復原全通 |

完整logs `/tmp/stepsemble-structured-web-ci-fixed-{general,claude,reader,rolling}.log`；
所有本批watch與本機owned程序已結束。整體goal持續；這是來源關聯可讀Web增量，
不是完整native語義、私人來源授權、正式部署或C1–C8完成。

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

## 背景結構階段證據（2026-09-09／Mac Mini，Web 接線前）

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
- 下列 exact-SHA CI 已通過並核對完整 logs。HTTP/Web 此時仍是舊 raw DTO；
  既有 Host/browser 回歸不能算結構 UI 驗收。

### Exact CI（2026-09-09）

核心工程 `24f924fd38e1dbdc5c33dca135299c5e71601e86`；只修跨平台測試路徑的
`8b29e621e9ef4bc4b8981aafca5a2a7438b02d33` 不改產品程式。

| SHA | Gate | 結果 |
| --- | --- | --- |
| 8b29e62 | [一般 CI](https://github.com/seehow624/stepsemble/actions/runs/34304885283) | 三 OS 各1,012／0 fail；Mac1,010 pass/2 skip，Linux1,009/3，Windows962/50 |
| 8b29e62 | [原生 Codex](https://github.com/seehow624/stepsemble/actions/runs/34304885284) | 三 OS 各147 messages／50結構turns／219原始records、0model／11原件不變／cleanup |
| 8b29e62 | [Reader](https://github.com/seehow624/stepsemble/actions/runs/34304885315) | 三 OS 各239 reader＋24 structure＋10 compressed測試通；POSIX真named/peer/取消/Host，RustSec0/0 |
| 24f924f | [Rolling browser](https://github.com/seehow624/stepsemble/actions/runs/34304650230) | 雙 OS 各24原case＋6 Codex三尺寸×明暗，冷/壓縮/雙向切換/損壞提示及恢復通 |

POSIX 真 Host 各39筆原始records及cleanup通；Rust29lib/33bin，Windows27/15，
Windows私人source仍unsupported、真Host skipped不是功能通。RustSec0.22.2／
DB `bf25f6575a93a35f30796c65c0ed91bee7fa19fd`／43packages／0known、0warnings；
Cargo.lock SHA `aa93d9f47ca7b3c38d21b8a5ce4b17b397d9a6c171a71867e82b8979626fca8e`。
未新增 native Claude 全套 gate；既有真 Claude SDK peer 在新 reader gate 內實際驗證。
所有本機 owned Host／writer／reader 已清理，未進行新的 GUI 操作或正式部署。

### 本輪失敗及修正（保留，不洗成綠色）

1. pipeline benchmark 初次誤用 `protocol` 而非 `protocolVersion`，job 被正確拒絕；
   修正測試欄位並先 assert validated frame，第二次實際全鏈成功，未放寬產品 decoder。
2. 新 malformed-message test 初版要求保留 unpaired surrogate，但原有 JSON gate
   正確拒絕它；改為分別驗有效 JSON 的未知資料保留及無效 Unicode 拒絕。
3. 最低 Node 全套曾在既有 Claude deadline test 失敗：牆鐘等待 60ms 後，實際已過
   100ms 總期限，0 parser spawn 卻被測試要求為 1。產品正確拒絕過期工作；測試改用
   受控 timer／monotonic clock，精確驗 60ms 轉階段、99ms 未殺、100ms 殺且不延長期限。
   另加 101ms 且 timer callback 尚未執行時仍拒絕下一階段的回歸；不調大產品期限。
4. 工程 `24f924f` 的一般 CI Windows 在新 worker 測試檢查檔案 grant 時失敗：
   測試寫死 `/rollout-structure.js`，實際 Windows 路徑用反斜線。改為平台原生
   `path.resolve` 比對完整且唯一的 `--allow-fs-read`，不放寬 grant、skip Windows
   或略過四種真 worker 組合。原失敗 CI（一般34304650253／reader34304650239）
   完整 logs 保留；修正後8b29e62的新兩gate已通，不重寫原失敗結果。

原始 logs 在本機 `/tmp/stepsemble-structure-*`；失敗的 pipeline-1、focused-3、
minimum-1/2 與成功的 pipeline-2、native-3、full-4、minimum-3、near-limit-* 分開保存。

## 接續：仍需完成

1. 本段UI/HTTP/實際Host與新CI已驗，不再重做；後續先處理大型歷史超8MiB、
   paginated store與完整native item語義。目前source-linked
   可讀紀錄不是完整native投影，也沒有approval／resume能力。
2. 其他adapter與C1–C8仍依web-completion-loop接續；真機／跨裝置、混合負載、來源
   管理與正式發布關卡不能由本段或獨立72h代替。
