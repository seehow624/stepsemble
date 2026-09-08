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
5. exact threads DDL存於`protocol/native/codex/sqlite-threads-0.153.4.sql`，canonical
   fixture由Git固定LF。真owned Codex建DB後逐字核對兩種已驗格式：POSIX LF SHA256
   `244d1f71265bbdfaf4f7bf92c06a68a4e2b93e6edf4e1e27fceecd04e6b07b5e`；Windows CRLF
   `66863400450b5838251535ee0f507dedbb1fa8335000e90c40bd10a36476c52c`。
   library只接受這兩種完整字串，不全面normalize SQL或接受混合換行／其他空白改寫。
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

- 新16項Rust tests＋既有main25項本機全通。涵蓋exact engine、兩種native DDL及
  其他改寫拒絕、WAL尚未checkpoint的名稱、
  missing/unknown schema、read-only／attached／既有transaction拒絕、raw/null/UTF8/limits、
  authorizer、cancel/deadline/VM budget，以及另一thread的獨立SQLite連線**20次commit**。
  writer提交時reader仍讀原snapshot，下一次request讀新值。獨立writer在capture前
  ready，僅此owned並行fixture設synchronous=OFF，避免把20次磁碟flush算進reader
  250ms限額；正式capture限額不變。這是跨連線／thread的交易隔離測試，
  **不是crash durability／吞吐效能、跨process或真Codex同時寫入的壓力驗收**。
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
native-schema-final.log}`。

### 首批CI與修正

工程`379265aaab2a2cc1373c3a2488721b2a4918d885`：一般34261880239三OS各849/0fail
與Ajv1251，native34261880201各13SQLite＋17index cases、原檔／model0／cleanup通；
native Windows原始DDL為CRLF，上面兩個digest由此確認。rolling34261880343雙OS
各24cases/pageErrors0（含六native×11語localeReads0）。完整logs已核，非新SQLite
library接Web的驗收。Reader34261880347 **失敗且不覆寫紀錄**：

- Mac/Linux Rust15＋25通，接著offline cargo metadata回101。原本錯假設host build
  會下載完整跨target依賴；全新隔離Cargo cache只fetch host後，實際重現缺
  linux-raw-sys／offline refused。完整`cargo fetch --locked`補齊四個非host crates
  後，同一離線SHA／source／features gate通。CI新增明確完整locked fetch，未去掉
  offline/hash檢查；失敗診斷現在保留Cargo stderr，不再只看到exit101。
- Windows Rust14pass/1fail：測試把20次同步commit與writer建立等待放進交易，回Budget；
  未分別量測磁碟flush／排程耗時，不當成正式reader效能結論。修正
  上述fixture同步／寫入準備，保留20次commit、snapshot／next-read比較和250ms
  正式限額，不刪case／不skip Windows。另補明確LF/CRLF與未知DDL負向回歸。
- RustSec該run仍success：43packages/0known/0warnings。同舊fixed DB／lockfile；
  reader後續actual pipeline未執行，不能以其他CI綠燈冒稱來源鏈已通。

失敗logs `/tmp/stepsemble-sqlite-reader-{failed-ci,linux-failed,macos-failed,windows-failed}.log`，
乾淨cache重現 `/tmp/stepsemble-sqlite-cargo-{host-fetch,clean-metadata-error,all-fetch,clean-fixed}.log`；
修正本機Rust16＋25、clippy、最低Node native13與artifact gate已通；新16項另五輪全通。

### 修正後exact CI

`510c3f318bf9da75511160ee17bcdb5f44463d1f`四組全部success，已讀完整logs：

- 一般[34262843356](https://github.com/seehow624/stepsemble/actions/runs/34262843356)：
  三OS各849/0fail、Ajv1251；Mac847pass/2skip、Linux846/3、Windows802/47。
- Native[34262843355](https://github.com/seehow624/stepsemble/actions/runs/34262843355)：
  最低Node22.19三OS各13SQLite＋17index cases，POSIX LF／Windows CRLF digest正確，
  model/private0、原檔驗證與actual cleanup通。不是新Rust library讀native DB的端到端測試。
- Reader[34262843377](https://github.com/seehow624/stepsemble/actions/runs/34262843377)：
  三OS新Rust16全通，原main為25/25/10；完整locked fetch、精確source/features／
  官方SQLite SHA3與實際linked engine都通。Node每OS118/118；POSIX舊actual Rust→
  ClaudeSDK/Codexparser shared max2/remaining0/29spawns、舊Host/groups/metadata/setup通。
  **Windows實際source reader與相應Host流程仍明示unsupported**，不把library test
  通過當成Windows私人來源功能已完成。RustSec43packages/0known/0warnings，DB
  `bf25f6575a93a35f30796c65c0ed91bee7fa19fd`；lock SHA256
  `aa93d9f47ca7b3c38d21b8a5ce4b17b397d9a6c171a71867e82b8979626fca8e`。
- Rolling[34262843430](https://github.com/seehow624/stepsemble/actions/runs/34262843430)：
  Mac/Linux各24cases、pageErrors0；各六native source cases×11語、localeReads0。
  這是既有Web回歸，沒有新SQLite Web／真機／真人帳號驗收。

完整logs `/tmp/stepsemble-sqlite-fix-{general,native,reader,rolling}-ci.log`。
這個checkpoint已驗工程增量，C1–C8／完整Web goal繼續，不是發布／部署或72h結案。

## 接續

Plan1.64已加入[跨程序正反案例與唯讀VFS政策](codex-sqlite-process.md)：原先的
readonly_shm候選單獨使用仍會建空WAL，新shim補開檔拒寫／拒建／拒刪。這仍不是
descriptor/ACL source opener；以下安全來源、cold DB及HostWeb缺口未被取消。

固定SQLite source已讀`unixOpenSharedMemory`、`walIndexReadHdr`與
`walBeginShmUnreliable`。下一輪可實測`readonly_shm=1`作為**POSIX候選**：它會略過
SHM的O_RDWR/O_CREAT並用O_RDONLY/O_NOFOLLOW，但同process已有SHM物件會重用，
所以不能在已有writer的同process測完就聲稱成立；需要獨立process。readonly SHM
的unreliable/recovery分支仍有read locks及checkpoint成本，root還可能fchown。
**這不是已採用的source opener或零副作用保證**；必須驗DB/WAL/SHM每個實際descriptor、
local mount／ACL／ownership、替換／missing／取消／actualclose與跨process writer，
不得只加URI參數就開私人資料庫。Windows需要自己VFS實證，不能沿用unix推論。

先做descriptor-backed來源開啟及DB/WAL/SHM策略，把本交易module接進獨立受限worker，
再整合既有Codex rollout/index capture、composite revision／取消／source grant與
Host registry/HTTP/Web。Owner仍分別選CodexRoot和SQLiteRoot及readers，不從Host env
或私人config偷猜來源。[OpenAI文件](https://learn.chatgpt.com/docs/config-file/environment-variables)
確認sqlite_home可獨立、config優先env，本批不改其設定。

boundedrevisioncache、compressed/reference/paginated完整歷史、其他harness與C1–C8未完。
正式3.0.6、B+、私人來源／帳號route與凍結72h不動，goal仍以完整Web驗收為終點。
