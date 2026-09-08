# SQLite：跨程序驗證與唯讀開檔政策

2026-09-09／Plan1.64，開發仍3.0.7-rc.7，未部署；延續
[短交易library](codex-sqlite-transactions.md)。這不是完整Codex歷史／source grant。

**Plan1.65勘誤**：舊測試的檔案比對在writer process開/關同inode，會解除其POSIX鎖，
所以部分「活動writer」案例實際走orphan/heap-index而非活動SHM路徑。已把比對移到
獨立process，原13case重新驗證；新bound正向案例明確要求真SHM映射/關閉。最新證據與
來源FD綁定見[descriptor-backed來源](codex-sqlite-source-bound.md)。下方1.64的CI與數字
保留為當時記錄，不當作修正後結果或完整活動writer證據。

## 實際抓到的問題

只用READ_ONLY開main DB，或另加`readonly_shm=1`，**不能保證來源檔案不變**。
固定SQLite3.53.4、獨立子程序、完全自建fixture有三個反例：

1. 普通唯讀連線讀最新WAL，SHM bytes變動；main DB/WAL保持不變。
2. `readonly_shm=1`，關閉writer後移除自建WAL、保留SHM：建立0-byte WAL，回傳
   主DB較舊的`base`，而不是移除前WAL中的`latest`。
3. 正常checkpoint/close後無sidecar的cold DB：POSIX回SqliteUnavailable，**仍建立空WAL**；
   Windows回latest，**同時建立0-byte WAL與SHM**，不是無副作用成功。

首個assert失敗完整保留`/tmp/stepsemble-sqlite-process-first.log`，第二次偵察完整
列出檔案集合與大小；**這兩次都不是零寫入gate通過**。最終保留未受保護負向控制，
每輪重新驗證原問題仍可見，不能只以新路徑成功取代失敗證據。首次log曾印自建DB
byte arrays，已把斷言改為等值布林以免再dump；沒有私人DB內容。

[官方WAL說明](https://www.sqlite.org/wal.html)把sidecar存在／可建立列為唯讀
WAL可用條件；[URI說明](https://www.sqlite.org/uri.html)的immutable會關locking及
change detection，不能用來繞過活動來源的問題。本輪用Tavily查核官方說明和固定C
原始碼，再以實際程序行為定測試預期，不把URI旗標當安全證明。

## 新VFS policy primitive

`crates/history-source-reader/src/sqlite_readonly_vfs.rs`註冊
`stepsemble-readonly-vfs-1`，**不更換default VFS**，不接受path或設定私人root。
固定engine/source ID先驗，delegation僅固定內建unix或win32；不繼承自訂default。

- main只接受READ_ONLY＋readonly_shm；可寫／create／缺旗標直接拒絕。
- SQLite對WAL的READWRITE/CREATE要求，改為READ_ONLY／NOFOLLOW；WAL缺失就失敗，
  不建立空檔、不退回較舊主DB值。其他file-kind／delete-on-close與xDelete拒絕。
- 保留built-in的szOsFile/pAppData與IO methods；native SQLite仍處理WAL、SHM和OS locks，
  不自製WAL重播。根據[官方VFS contract](https://www.sqlite.org/c3ref/vfs.html)，
  失敗xOpen也清pMethods、outflags；delegation沿原VFS，不傳錯的file storage大小。
- 註冊物件與名稱為一次、process-lifetime配置，不能stack引用／關connection即free；
  OnceLock避免多次配置。不開DB於registration，Unix euid0明確拒絕。
- **unsafe API明列caller契約**：全新專用process，無既有SQLite connection；所有後續
  connection均用此VFS／READ_ONLY／readonly_shm，不改built-in VFS/syscalls。
  否則內建VFS可重用同process既有可寫SHM物件。讀取仍必須配合交易library的
  NO_CKPT_ON_CLOSE、query limits、authorizer、取消和actualclose。

這是**開檔/刪除政策，不是OS sandbox或完整來源VFS**。內建VFS仍自行按path解析
DB/WAL/SHM：實際descriptor identity、ACL、owner、mount、symlink/hardlink／替換、
native來源真實性與root grant尚未接上。NOFOLLOW與前後bytes相同不能取代上述驗證。
不能直接套用真人資料，也不宣稱所有syscall／atime／metadata完全無副作用。

## 跨程序13個case

Cargo新增`harness=false`的integration test `sqlite_wal_process`；正常執行只自建
temp fixture，無任意來源CLI參數；worker只由parent經私有stdin給該fixture path。
每個reader是fresh process，清env（Windows只留SystemRoot），不讀HOME/config/auth。
它不是production worker或正式admission接線；Rust main v1–v3仍未呼叫新module。

| Case | 實際驗證 |
| --- | --- |
| 活動writer／WAL最新名稱 | capture取latest；quiet writer期間DB/WAL/SHM bytes與名稱集合不變 |
| 預先取消 | Cancelled；來源bytes/名稱不變 |
| VFS policy | 可寫main／create／缺SHM旗標／delete四拒絕；default VFS不變 |
| 普通唯讀負向控制 | 只有SHM bytes改變，測試確實能抓到副作用 |
| writer關閉但保留WAL/SHM | 新process取latest，無原檔bytes/名稱變化 |
| 缺SHM | unavailable，不建SHM／不repair |
| 缺WAL | unavailable，不建WAL、不發布舊base |
| 無sidecar的cold DB | unavailable，不建任何sidecar；**此能力尚未支援** |
| 未受保護缺WAL控制 | 重現建立空WAL＋回舊base，未被當成權威名稱 |
| 未受保護cold控制 | POSIX失敗仍建空WAL；Windows回latest且建立空WAL＋SHM；均不是受保護讀取 |
| writer未commit | reader只見已commit值；commit後新reader讀新值 |
| 20個跨process commit | 人為持有read transaction時writer20次commit，重讀仍同snapshot；actualclose後checkpoint可進行 |
| kill reader | 持有read lock時checkpoint busy；kill並確認實際exit及pipes EOF後，writer checkpoint成功 |

每輪16個child、16個實際reaped／remaining0；normal與kill exit分開核對，bounded
stdin4KiB／stdout和stderr各16KiB、回覆及退出等待各5秒。failed startup/pipe/assert
也持有kill/wait清理，不用單一exited標記冒充整條cleanup。
最終收尾另要求8個owned fixture目錄均explicit `TempDir.close()`成功，並以
`try_exists`核實移除；不再依賴忽略刪除錯誤的implicit Drop來宣稱清理完成。

hold模式**只測OS鎖與交易隔離**，並非正式capture：它以parent有界等待控制交易、
並行writer只有此owned fixture設synchronous=OFF。正式library的250ms保持；本批
不是crash durability、吞吐／RSS、真Codex writer或Web流暢度測量。

## 驗證與接續

本機原Rust16＋main25、13cases及另五輪、clippy -D warnings／fmt／固定SQLite
artifact hash通；Node849＝847pass/2skip/0fail。Cargo.lock仍43packages且未變，
SQLite/ABI/toolchain不升級。新test由CI原`--all-targets`自動執行，不以skip取代Win。
最終工程 **`2df35cd305e5821601f551055940fe168f46342c`** 三組CI已成功、完整logs已核：

- 一般 **34268766553**：三OS各849/0fail＋Ajv1251；Mac847pass/2skip、
  Linux846/3、Windows802/47。skip不表示對應能力已支援。
- Reader **34268766580**：三OS各新13cases、16spawn/reaped16/remaining0、8個owned
  目錄實際移除；Windows7個直接syscall檢查也執行。原Rust library16及main25/25/10、
  artifact hash、Node118/118全通。POSIX舊actualHost/groups/metadata/setup與shared max2/
  remaining0仍通；**Windows正式source reader依然unsupported**，不是新SQLite接Web。
- 同一reader RustSec：audit0.22.2、DB bf25f6575a93a35f30796c65c0ed91bee7fa19fd、
  1242advisories、43packages、0known/0warnings；lock SHA
  aa93d9f47ca7b3c38d21b8a5ce4b17b397d9a6c171a71867e82b8979626fca8e不變。
- Rolling **34268766557**：Mac/Linux各24cases/pageErrors0；各六native UI×11語、
  localeReads0。只驗既有browser routes，不聲稱本module已接入Codex UI。

完整紀錄在`/tmp/stepsemble-sqlite-process-final-{general,reader,rolling}-ci.log`。
kill順序修正後另本機五輪通；最後explicit cleanup版也本機Rust16＋25＋13cases與clippy
全通。沒有新模型／私人history／GUI／真人跨裝置操作或正式部署，C1–C8仍未全完。

### Windows 失敗與修正歷程（保留原失敗，不重跑舊SHA掩蓋）

工程`aeaa5986d6df81a6efe6d005d257df763f152e01`的reader CI
`34265980949`：Mac/Linux13cases通，Windows在missing_shm回latest而非unavailable。
該版先assert回覆、後比較snapshot，**失敗log本身未證明是否建立SHM**；固定C原始碼
`winHandleOpen`則明確使用`OPEN_ALWAYS`，不因readonly_shm改成OPEN_EXISTING。
因此不能把POSIX的唯讀SHM行為直接套到Windows，也不能只改預期為成功。

新修正保留VFS default選擇，但在**專用process內的SQLite Win32 syscall table**
註冊CreateFileW保護：GENERIC_READ＋OPEN_EXISTING、拒絕delete-on-close；ANSI開檔
及W/A delete明確拒絕。保留原始wide callback、Windows ABI、sharing與overlapped
flags；不是修改全系統API或先exists再open的競態檢查。若registration失敗，caller
必須終止process，不能退回未受保護開檔。[Microsoft CreateFileW規格](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-createfilew)
與固定SQLite syscall原型一併核對。

Windows獨立policy child加7個直接syscall檢查：缺檔OPEN_ALWAYS、既有檔CREATE_ALWAYS
不截斷、實際WriteFile無權限、delete-on-close、ANSI open、W/A delete；parent再比完整
bytes/檔名。guarded缺sidecar案例改成**先比較snapshot再判回覆**；負向控制只印自建
檔名、大小及changed，不dump DB bytes。實際三OS驗證見上方最終exact CI。

同一原工程的一般CI`34265981014`三OS各849/0fail＋Ajv1251成功；rolling
`34265981058`雙OS各24cases/pageErrors0、各六native×11語/localeReads0，完整log已核，
不以此抵銷reader Windows失敗。原audit43packages/1242advisories/0known0warnings，
DB/lock SHA與1.63相同。

修正`6f7d846`的reader CI`34267247684`：POSIX兩OS成功；Windows止於測試程式的
`byte_char_slices` lint（`[b'!']`應寫`b"!"`），尚未執行新的process gate。
直接修正字串寫法，不allow lint或skip平台；完整job log保留
`/tmp/stepsemble-sqlite-process-winfix-windows-first.log`，由新SHA再驗。

後續`d588183`／reader CI`34267576834`的Windows實際通過新7個syscall檢查與所有
guarded缺sidecar回覆／bytes/名稱不變，再於**unguarded cold負向控制**失敗。
完整log `...winfix-windows-second.log`已確認Windows回latest並新增WAL0bytes＋SHM0bytes，
而POSIX回unavailable只新增WAL0bytes；固定`winHandleOpen(OPEN_ALWAYS)`及readonly
heap-index fallback符合觀測。現在針對這個未受保護控制逐平台核exact回覆與sidecars，
不是放寬guarded no-create/no-write、skip Windows或宣稱cold DB已支援。

`6e7eabc`／reader`34267894535`的Windows後續到kill case又抓到**測試清理順序競態**：
parent先drop stdin才kill，held child可先收到EOF並panic；其stderr使gate失敗。
`...winfix-windows-third.log`保留空輸入對finish訊息的斷言。現在kill路徑保留stdin
直到actual exit/reap才drop，normal close路徑不變；仍要求kill非成功退出、stderr空、
pipes EOF及checkpoint恢復。不忽略child panic，也不把此問題誤稱正式worker已修復。

`4bee3f3`的reader`34268336710`三OS與audit成功；一般34268336854、rolling
34268336777也成功且完整log核實。最後增加上述fixture目錄explicit cleanup檢查，
再由2df35cd三OS驗證，不以4bee3f3結果取代新SHA。中間6f7d846/d588183/6e7eabc的
general/rolling亦成功、完整logs保留，但均不能抵銷各自reader的Windows失敗。

下一個必做仍是**descriptor-backed DB/WAL/SHM source opener**與角色／ACL／local
mount／replacement checks，然後正式reader worker共用admission、sourceVersion、
Codex明確opt-in／inventory／registry／HTTP/Web。cold DB缺sidecar的完整讀取方案
需要另證明一致性且不寫來源，不能直接開immutable或讓native CLI偷偷repair。
壓縮／paginated/reference、其他harness與C1–C8仍待；不將目前unavailable當完成條件。

正式3.0.6／B+／私人來源與readers／帳號route／独立72h凍結全不變。
