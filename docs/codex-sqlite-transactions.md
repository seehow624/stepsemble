# Codex：短 SQLite 交易與修補版引擎

2026-09-09／Plan1.63，開發候選仍3.0.7-rc.7，未部署。

## 本批改變

新增Rust library `sqlite_metadata::capture_name_fields`：**接收caller已開啟、獨占
擁有的唯讀connection，不接受path或SQL**。在單一短交易核固定threads schema及WAL
mode，只取得選定thread的五個名稱欄位，結束交易並close connection後才回覆。
這補上SQLite交易一致性實作，不再只依caller提供的JavaScript欄位測規則。

它不是source opener／VFS／權限grant，不是DB檔案備份、Codex Host/Web接線或完整歷史。
現有Rust main的v1–v3路徑沒有呼叫這個library，正式Node服務沒有新增SQLite依賴。
新Cargo依賴供此library與測試使用；既有helper重新build並驗相容，不直接替换已部署artifact。

## 為何採短交易而不是複製整個DB

[SQLite WAL文件](https://www.sqlite.org/wal.html)說明讀交易有固定end mark，writer
仍可提交，但長交易可能阻礙checkpoint／WAL reset。因此只取選定metadata所需五欄；
不用一次備份所有人的全部資料，也不持有交易跨越HTTP等待、SDK解析或使用者翻頁。

[Online Backup說明](https://www.sqlite.org/backup.html)另指出外部寫入會讓增量備份
重新開始，頻繁寫入甚至可能無法完成。備份仍是其他用途的正式API，但不是這次名稱
讀取的必要步驟。**不複製單一主DB、不自製WAL重播、不用兩輪stat代替SQLite交易。**

此處的一致性僅是**同一SQLite connection的一個read transaction**，不代表SQLite＋
rollout＋name-index跨檔案原子交易，也不是跨請求版本穩定證明。

## 引擎與依賴來源

- SQLite固定3.53.4／source ID
  `2026-07-24 19:02:57 bf7c7f30031888f4e796e429ab3978879485813aaca6f641c7b33e4e09459bcc`。
  [官方3.53.4紀錄](https://www.sqlite.org/releaselog/3_53_4.html)給出的sqlite3.c SHA3-256
  是`67f423e9ebbbdc473cbc4772c872ee6b89f31fde4ed0279a5c25d5f65c043a16`；實際9,515,341bytes相符。
- 查核時registry rusqlite0.40.2／libsqlite3-sys0.38.2內附的是3.53.2。採**上游
  SQLite3.53.4更新commit** `901f9946efdaaa289e6b1c5bd56dc67f4b651e51`，而非浮動HEAD：
  rusqlite0.40.1／libsqlite3-sys0.38.1。這是精確Git來源，不冒稱crates.io新release。
  future升版需另核source/hash/runtime與回歸，不自動跟隨upstream。
- `check-native-sqlite-artifact.mjs`核locked package source／features、amalgamation SHA3
  與header，CI加此關卡。Rust測試及每次capture核**實際linked** version/source ID，
  不只驗磁碟上可能未被link的source。未使用系統SQLite或Node較舊的fixture SQLite。
- features只開bundled/hooks/limits/modern_sqlite；不用default cache、WASM、extension
  loader功能。Cargo.lock由33增至43packages，其餘既有版本不變。Toolchain仍固定
  1.97.1並以此驗證；manifest floor為1.88，未另聲稱MSRV1.88的實際build已驗。

## 範圍、關閉與限額

1. nativeVersion固定0.153.4、canonical UUID；missing row只表示此交易無該row。
   先設connection-local NO_CKPT_ON_CLOSE，取消／invalid input也不觸發close checkpoint。
2. 拒非autocommit、實際可寫或attached DB connection；`query_only=ON`不能洗成
   真正唯讀。caller必須提供fresh、無預載自訂函式等狀態的connection，不重用pool lease。
3. defensive開啟、trusted schema／views／triggers／extension loading／DQS關閉，
   不允許ATTACH建立／寫入。busy timeout為0、無retry。mmap禁用、temp在memory、
   cache512KiB是connection設定，不是process RSS硬上限。
4. authorizer只允許固定schema欄位、選定五欄、唯讀journal_mode及交易操作；
   其他表、cwd等未選欄、函式、attach、migration、checkpoint、VACUUM／repair與寫入拒絕。
   它是SQL第二道防線，不是OS sandbox或FS授權。
5. exact threads DDL存於`protocol/native/codex/sqlite-threads-0.153.4.sql`，真owned
   Codex建DB後逐字核對；SHA256
   `244d1f71265bbdfaf4f7bf92c06a68a4e2b93e6edf4e1e27fceecd04e6b07b5e`。
   不執行此DDL於來源，不接受改欄／view或未知mode；這是相容性辨識，不证明來源真實。
6. 每文字欄32KiB，SQLite row長度128KiB、SQL8KiB、output128KiB、column64、
   expression depth20、VDBE allocation25,000、variable1；blob／無效UTF8／超量拒絕不替換。
   輸出raw字段，無trim／finalname推論，sourceAuthenticated/publishable永遠false。
7. 250ms cooperative deadline、20,000 VM steps／100-op callback quantum及取消flag。
   SQLite短statement可能不足一個quantum；固定少量查詢另有前後clock檢查。
   **這不能中斷卡住的OS I/O，不是完整worker的wall-clock/RSS隔離**，外層shared
   admission／實際child close／未知清理隔離仍須接入。
8. 所有成功／失敗都消耗並close該connection；不保留跨頁read lock。close無法確認
   回CloseUnconfirmed，未來caller必須quarantine相應worker，不能自行改成可重用。

[官方open說明](https://www.sqlite.org/c3ref/open.html)警告immutable會停用locking／
change detection，不能用於正在變動的資料。本批測試未用immutable或nolock。
**普通唯讀SQLite仍可能建立／修改SHM等協調狀態**；本library不宣稱原生目錄完全零寫入。
只在owned資料上使用普通VFS；source opener的descriptor/ACL/檔案身分、SHM策略、
local-filesystem與既有writer邊界仍是下一個必做關卡，不可直接套私人路徑。

## 已驗與保留的失敗

- 新15項Rust tests＋既有main25項全通。涵蓋exact engine、WAL尚未checkpoint的名稱、
  missing/unknown schema、read-only／attached／既有transaction拒絕、raw/null/UTF8/limits、
  authorizer、cancel/deadline/VM budget，以及另一thread的獨立SQLite連線**20次commit**。
  writer提交時reader仍讀原snapshot，下一次request讀新值；這是跨連線／thread，
  **尚非跨process或真Codex同時寫入的壓力驗收**。
- 專門保留checkpoint副作用測試：owned writer在reader持有交易時TRUNCATE回busy，
  readerclose後成功。不聲稱讀者完全不影響writer／checkpoint。另一案例明確驗主DB
  bytes保持舊值、WAL含新值，reader取得新值且主DB／WAL bytes讀前後不變；未把SHM算入。
- 原生名稱runner仍13cases，新增與真CLI生成DDL逐字比對，最低Node22.19通；
  它仍用原有NodeSQLite離線修改owned fixture，不是新Rust module讀原生DB的端到端證據。
- 本機Node849＝847pass/2skip/0fail、舊實際Rust→ClaudeSDK＋Codexparser shared
  max2/remaining0/29spawns、Host fixture與cleanup通；沒有新的GUI／手機／Web效能驗收。
- locked RustSec0.22.2，DB`bf25f6575a93a35f30796c65c0ed91bee7fa19fd`、1242advisories，
  43packages/0known vulnerabilities/0warnings。不能以RustSec替代SQLite官方修補與來源核驗。
- 首次compile用了舊wrapper的DatabaseName，改為固定版本Name API。第二次14個fixture
  因macOS `/var` symlink被NOFOLLOW拒絕；改為canonical owned temp dir，**不移除NOFOLLOW**。
  第三次補固定wrapper的UTF8 error分類；VM probe原本反覆小query，不會跨越每statement
  的100-op quantum，改單一昂貴query。第四次probe漏選join表的欄而先被authorizer拒絕，
  改成明確選三個allowed id，**不放寬authorizer或刪除budget測試**。原失敗logs保留。

本機logs `/tmp/stepsemble-sqlite-{tests-first.log,tests-second.log,tests-third.log,
tests-fourth.log,tests-fifth.log,clippy.log,audit.log,node-full.tap,existing-pipeline.log,
native-schema-final.log}`。Exact工程CI待push後核完整結果，不能先當成三OS皆通。

## 接續

先做descriptor-backed來源開啟及DB/WAL/SHM策略，把本交易module接進獨立受限worker，
再整合既有Codex rollout/index capture、composite revision／取消／source grant與
Host registry/HTTP/Web。Owner仍分別選CodexRoot和SQLiteRoot及readers，不從Host env
或私人config偷猜來源。[OpenAI文件](https://learn.chatgpt.com/docs/config-file/environment-variables)
確認sqlite_home可獨立、config優先env，本批不改其設定。

boundedrevisioncache、compressed/reference/paginated完整歷史、其他harness與C1–C8未完。
正式3.0.6、B+、私人來源／帳號route與凍結72h不動，goal仍以完整Web驗收為終點。
