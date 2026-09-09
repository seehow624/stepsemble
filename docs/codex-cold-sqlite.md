# Codex 冷資料庫：有鎖的唯讀記憶體副本

2026-09-09／Plan1.70 進行中，開發3.0.7-rc.7，正式3.0.6未部署。
底層 cold API 與 Rust v7/v8、Node 共用 admission／version、實際 Host/Web 已接通，
本機合成資料全鏈及手機尺寸 CUA 已驗；這次新工程 CI 待提交後驗證。**未部署，
不是完整原生語義歷史或 C2 完成**。私人來源仍須 owner 選定，Windows 仍不支援。

## 為什麼需要另一條來源路徑

Codex正常關閉最後一個SQLite連線時，WAL和SHM可以被原生SQLite清除。Plan1.69
既有v4–v6來源讀取要求DB/WAL/SHM都存在，所以冷資料庫會拒絕。普通READ_ONLY仍可能
建立sidecar；這個負向控制繼續保留，不以普通開檔、immutable原來源或啟動Codex修復。

依固定SQLite3.53.4 C source的`pagerOpenWalIfPresent`與`sqlite3WalClose`，原生SQLite
必須取得非空主DB的EXCLUSIVE lock才能刪除WAL。因此新路徑：

1. 沿用原root/openat/owner/mode/ACL/local-mount檢查，只取得主DB的O_RDONLY FD。
   DB名稱固定state_5.sqlite；WAL、SHM、rollback journal必須均不存在。
2. 按POSIX SQLite順序取得主DBSHARED lock：先pending byte共享鎖，再shared range，
   最後釋放pending byte。全部F_SETLK非阻塞；已有exclusive/pending writer就busy，無重試。
3. 保留唯一主檔FD與共享鎖，逐64KiB讀入SQLite分配的私有RAM，最大64MiB／1024次讀。
   每個chunk前、copy後、發布前，重驗身份、權限、size/mtime/ctime及sidecar仍不存在。
   主root名稱也重驗；過程不可另開關同inode FD以免解除POSIX鎖。
4. 固定SQLite原生`sqlite3_deserialize`只接受非WAL的image；依該API明文規範，僅在
   私有RAM副本把header18/19兩byte改成1。原檔與其header完全不動；沒有自寫WAL重播。
   副本用READONLY＋FREEONCLOSE，不建立磁碟暫存副本、WAL或SHM。
5. 固定schema／authorizer／欄位上限與250ms SQL交易預算照舊；selected context20kVM，
   catalog64kVM／2048rows／2MiB。來源準備、copy及最後驗證合計合作式5秒。
6. Connection明確close後結果仍藏在Pending，最後權限／sidecar／content-stamp檢查
   完成並明確close主DB與root兩FD（釋放鎖），才取得結果。任何拒絕不暴露欄位。

來源仍可能被合法writer重開並commit，但持有SHARED lock時它無法刪除新WAL：
最終absence fence因此拒絕舊副本。原生writer若在copy期間checkpoint修改主DB，
也有sidecar與content-stamp兩條拒絕檢查。這不是OS sandbox或防同UID惡意瞬時ABA，
不聲稱與rollout/index為同一原子snapshot；sourceAuthenticated/publishable維持false。

## 不混用兩種唯讀證據

`sqlite3_db_readonly`只反映btree open flags，對READONLY deserialize memdb仍回false。
第一版直接套原guard因此被正確拒絕。現在用不可自行建構的ReadOnlyMemory型別保存
READONLY deserialize的建構證據，再進入crate-private冷metadata方法；原public熱DB
capture仍嚴格拒絕這種connection。測試在query_only=0且未安裝authorizer時實際UPDATE，
必須回原生SQLITE_READONLY且資料不變，不能只靠query_only假裝唯讀。

冷Verified回覆明示cold_snapshot、僅database的真identity、兩個來源FDclose、RAM
copy byte/call、main shared lock／sidecar absence檢查；不杜撰WAL/SHM inode、native
SQLite FD或mapping計數。既有v4–v6 frame契約與legacy decoder仍只接受原三檔證據。
64MiB是cold完整RAM副本上限，不放大hot路徑8MiB實際I/O上限。兩個並行cold read最多
128MiB image storage，另有SQLite/parser/DTO overhead；尚無完整Host RSS量測。
RAM釋放不是安全抹除記憶體承諾。超限明示不可用，不截斷DB或回部分catalog。

## 本機證據與保留的失敗

Mac Mini、Rust1.97.1、鎖定SQLite3.53.4；只使用owned fixtures，沒有私人root或模型。

- Rust lib29、binary30和全部原有跨程序gate通。新增cold gate 12組：正確context/catalog、
  native writer兩階段reopen/commit/close、partial sidecar/journal、兩階段撤權、主檔stamp
  改變、root/main換檔、既有exclusive lock、actual kill、12MiB以上DB、symlink、64MiB
  超限及壞image。每個case資料/程序結果以完整log為準；Windows cold目前明示unsupported。
- 舊hot正常case仍強制真SHM mmap>0；普通唯讀改SHM、缺WAL新建空檔負向控制未放寬。
- cold fixture的bytes/檔名比對獨立process streaming SHA256，有限65MiB測試上限，避免
  snapshot比對開關FD干擾writer鎖；所有child actual-reap和TempDir explicit close均驗。
- 初始失敗：fixture呼叫不存在的send方法（改用現有stdin）；memdb被舊readonly guard
  拒絕（以上sealed型別及負向測試）；舊snapshot測試4MiB上限撞12MiB fixture（改有界
  streaming比對）；unsafe安全註解在assert外（移到unsafe前）。沒有改正式上限以洗過測試。
- logs：`/tmp/stepsemble-sqlite-cold-first.log`保留memdb guard失敗，`...-second.log`、
  `...-final-rust.log`、`...-clippy.log`、`...-node.tap`及`...-check.log`保存修正結果。
  部分早期編譯／fixture失敗使用重複log名稱，完整檔已被後一次覆寫；其實際錯誤在工具
  對話與上述摘要可查，但不能冒称全部初次原始log均已保存。後續attempt使用獨立名稱。

## Exact工程驗證（底層通過，1.70全鏈仍進行中）

工程`808efcaf584066e1f53c169ee0eb66ae8129be06`三組CI全部success，完整log已核：

- 一般34296495850：三OS各965／0fail、Ajv1251；Mac963pass／2skip、Linux962／3、
  Windows915／50。不是把skip算成功的功能驗證。
- reader34296495847：Mac/Linux各Rust29lib＋30binary；新增cold12組、41child全部
  reaped／21owned目錄explicit cleanup，全套跨程序147child／82dirs；原hot真SHM保持。
  Windows27lib＋15binary，cold只驗unsupported／3child／1dir，不宣稱Windows支援。
  三OSNode226／226；POSIX既有真owner→Host39筆／WAL名稱／版本失效／empty與startup
  cleanup均通，**此Host gate仍是hot，非本批cold接線**。
- RustSec0known／0warnings，43package lock／SQLite artifact pin不變；fmt/clippy通。
- rolling34296495886：Mac/Linux各原24browser cases與六個Codex1440/390/320×明暗
  全通，pageErrors0；是既有Web回歸，非cold或真機驗收。
- 本機額外三輪完整程序gate通，每輪cold41child／21dirs、全套147／82全清理。
  `...-repeat-1.log`至3、`...-general-ci.log`、`...-reader-ci.log`、`...-rolling-ci.log`。

## 同一 Plan1.70 的 Host/Web 接線（本機已驗，新 CI 待驗）

- Rust v7 選定 name context、v8 root catalog，在**同一 held root/main**準備中選 layout。
  WAL/SHM 都在才走既有 VFS；兩者都不在才上主檔鎖讀 RAM；部分存在、權限或其他
  失敗均拒絕，沒有「失敗後再開另一條連線」或普通 SQLite fallback。
- v4/v5/v6 的 shape、三檔與 close 要求保持；v7/v8 接受舊 hot proof 或明示
  `sourceLayout: cold_snapshot` 的單一 DB proof。Node 嚴格核對 RAM 大小、64KiB chunk
  計數、鎖／absence／兩 FD close，混入 hot 計數、假 layout、超限均拒絕。legacy
  helper 方法與 decoder 留存，實際 v4–v6 冷來源零 payload 拒絕有回歸測試。
- 現有 context/catalog 方法改用 v7/v8；沿用同一 Host 兩 reader admission、deadline、
  actual-close、quarantine 與 named pipeline 的前後雙來源驗證，不另開 pool。
  cold source version 含 layout，hot version 保持舊 shape；名稱／主檔 identity 相同
  仍會在 hot↔cold 後失效。分頁 token 維持 binding 私有，舊 binding token 不可跨用。
- 真 `server.js`＋未改寫的 owner 精靈 config＋固定 writer/reader：39 筆原始 CRLF
  紀錄在熱、關閉後冷讀的所有分頁完全一致；cold catalog／native title、雙向 layout
  stale page、partial sidecar 明確不可用且不修檔、復原、WAL rename、paginated拒絕、
  unsafe path、empty catalog、occupied-port startup failure cleanup 全通。
- 本機 Rust29lib/30binary／全部 process gate 通：source adversarial增為100 child／
  53 dirs，全套179 child／83 dirs，全 reaped／explicit cleanup；原 cold12組41／21
  與 hot 真 SHM 保留。Node975／973pass／2skip／0fail，fmt/clippy/generated/check通。
- Codex Computer Use 的390×844實際合成 Host：熱頁→cold失效→cold清單與第11–20筆→
  reopen失效→refresh恢復第1–10筆，UI已驗；無橫溢、live embeds0、warn/error logs空。
  關閉歷史／分頁及viewport reset完成；Host/writer實際退出，兩自建目錄已清除。
  不是iPhone真機或正式來源驗收。CI六個Codex尺寸／明暗案例已加入相同雙向冷熱流程。
- 本輪失敗保留：`/tmp/stepsemble-cold-web-host-1.log`測試錯把舊binding token用於新
  binding，正確收到source_version_unavailable；修正測試使用當前binding token後，
  `host-2.log`驗真正layout改變的source_version_changed。`clippy-1.log`因新增分支
  讓舊unsafe註解離開直接相鄰位置，補回註解後`clippy-2.log`通，未放寬lint。
  其餘`rust-1.log`／`rust-2.log`、`node-1.tap`／`node-2.tap`、`check-1.log`與
  `gitleaks-1.log`皆使用相同 `/tmp/stepsemble-cold-web-` 前綴，attempt不互相覆寫。

## 剩餘工程與限制

本批 CI exact SHA 及各OS冷/熱回歸仍須核完後記錄。接著處理compressed rollout、
原生語義projection、其他adapter與C1–C8；未知或不支援格式保留明確狀態。
冷大DB完整Host RSS／延遲與多輪混合負載尚待；64MiB上限、共享兩reader沒有放大。
原始紀錄完整保存不是完整native聊天語義；paginated仍只支援metadata名稱。

OpenAI Docs讓本次維持「讀stored thread、不resume／載入工作」的界線，見
[官方App Server讀取說明](https://learn.chatgpt.com/docs/app-server)。SQLite依據為鎖定
rusqlite901f994所含C source與[deserialize API](https://www.sqlite.org/c3ref/deserialize.html)，
不是從原生client啟動取得副作用式修復。正式服務、B+logo、帳號/路由、私人readers與
固定source ab227af/runtime2b7f0b6的獨立72h均不動、不繼承長測結果。
