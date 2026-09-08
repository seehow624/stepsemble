# SQLite：以實際檔案描述符綁定來源

2026-09-09／Plan1.65，開發仍3.0.7-rc.7，未部署；接續Plan1.64。
本機Mac owned驗證通過，三OS CI仍待；不是完整Codex歷史或Host/Web接線完成。
正式服務、私人來源、帳號與獨立72h均不變。

## 已實作的來源邊界

- 共用既有POSIX root/openat/owner/mode/ACL/local-mount檢查，不複製第二套政策。
- 在全新專用process先開啟並保留root及固定DB/WAL/SHM的唯讀FD。SQLite只取得其dup，
  不再自行依真人path開檔；對SQLite提供固定虛擬檔名，namespace probes用root-relative
  fstatat，讀取前後核對實際FD與名稱對應。缺sidecar仍拒絕，cold支援沒有被冒稱完成。
- [SQLite官方警告](https://www.sqlite.org/howtocorrupt.html)與[POSIX fcntl規格](https://pubs.opengroup.org/onlinepubs/9799919799/functions/fcntl.html)
  均指出close任何同檔FD會解除該process的POSIX鎖。保留驗證FD到SQLite確實close後，
  不能把文字檔capture的open/close重新驗證方法搬入SQL交易中。
- 攔截固定SQLite的open/stat/read/close等內部syscall，所有SQLite實際FD在資料讀取前
  有來源檢查；阻擋新建/刪除與未知路徑。保留native WAL/SHM鎖，不自寫WAL重播。
- 單筆名稱metadata讀取沿用250ms/VM/authorizer/欄位限制，另加實際SQLite read-request
  byte/call限額；不把整個DB的大小當作要全部copy或load到記憶體。
- read後結果先保持不可取用，最後再核對權限/身份與來源名稱、確認所有FD close才回。
  合法writer的size/mtime變動不是替換；SQLite短交易負責內容snapshot，FD檢查不冒充
  filesystem原子交易或Native來源簽章。沒有在這一層授權Web credential。

## 固定程序／協定與資源範圍

Rust單次helper新增v4：精確nonce/nativeVersion/source.sqliteRoot/threadId/expectedRoot，
未知欄位拒絕，不繼承HOME、Codex root或環境；DB名稱固定state_5.sqlite。v1–v3相容。
來源root可與rollout root不同，兩者不能互相擴權；本批沒有增加任何owner設定或讀者grant。

- POSIX只支援64-bit、system page≤32KiB、既有owner/ACL/local-mount allowlist；
  Windows實際binary v4明示source_platform_unsupported，不只是測試stub回覆。
- 準備時持有root＋三個唯讀原FD；SQLite只dup三檔。native fd close與SHM munmap
  都逐一核實；成功回覆必須SQLite3開3關、原FD4關。未知close保留leases到process exit，
  不推論已清理，也不能由回覆取代parent actual-exit/EOF gate。
- 只允許SHM的PROT_READ/MAP_SHARED映射，主DB mmap关闭；累計SHM映射8MiB/256次。
  SQLite實際read/pread請求8MiB/1024次，source操作含準備與最後檢查合作式5秒；
  SQL交易原250ms/20,000 VM steps與欄位32KiB/結果128KiB不變。
- SQLite全域PRNG使用default VFS；專用process將其entropy改用getentropy，避免未知
  /dev/urandom開檔，不更換default VFS選擇。不允許第二次prepare／普通connection混用。
- v4 header≤16KiB、payload≤144KiB；length-prefixed header綁nonce、selection與payload SHA256。
  payload含三檔device/inode與實際資源計數；sourceAuthenticated/publishable維持false。
  SHA256是回覆artifact摘要，不是整個DB版本、原生簽章或Web授權。任何capture拒絕零payload。

這不是OS sandbox，不攔截整個程序所有syscall；不是filesystem原子交易，無法阻止同UID
對手在檢查間變更後復原。合法SQLite writer由短交易/原生鎖維持snapshot，size/mtime變動
不等於換檔。沒有吞吐/RSS/真native writer或Web流暢度證據；缺sidecar仍拒絕不repair。

## 本輪測試缺陷、修正與實證

第一輪`/tmp/stepsemble-sqlite-source-first-process.log`雖讀到latest，卻沒有SHM映射。
查固定C的unixLockSharedMemory後確認：舊fixture在writer所在process開/關比對用FD，
連帶解除writer的POSIX鎖，使部分「活動writer」案例實際進入orphan/heap-index路徑。
**這修正了Plan1.64對活動writer情境的證據範圍；不把先前綠燈當正確SHM路径驗證。**

現在所有檔案比對用獨立process，完整讀取owned檔案並比較名稱集合、size及SHA256；
不再於writer process開/關同inode。正常bound case要求至少一次真SHM mmap/munmap，
不能放寬為零；重新執行原13案例，普通唯讀改SHM／缺WAL建檔等負向控制仍成立。

Mac最終本機Rust lib16/main27、原13case＋新正常source gate＋53個source/wire cases通：
總100個child全實際reaped/remaining0、61個owned fixture目錄explicit close並核實清除。
53案例含真binary v4 nonce/digest/root mismatch；root/DB/WAL/SHM各在before/prepare後/read後
撤權與ACL；三檔symlink/hardlink/directory/FIFO；各角色兩階段換檔；缺檔無建立、取消、
rollback journal拒絕、過大欄位不截斷；read後合法commit＋checkpoint仍回原SQL snapshot。
攻擊案例writer先關閉，正常case保留真活動writer；不將其混稱同一競態或native writer。

clippy -D warnings、舊Node→Rust reader/inventory＋Codex pair capture與artifact SHA驗證通；
本機Node849/0fail（847pass/2skip）。完整logs `/tmp/stepsemble-sqlite-source-final-rust.log`、
`...-final-clippy.log`、`...-npm.tap`、`...-existing-reader.log`、`...-existing-codex.log`。
SQLite3.53.4/上游rev/43-package lock不變；三OS exact CI尚待，不把Windows source算成支援。

## 接續（未完成）

Node v4嚴格decoder／shared admission/actualclose/quarantine與名稱resolver尚未接；
本批只提供Rust獨立程序協定，不啟用私人root、不掛Host HTTP或Web。接續不能新增無界SQL
worker或使用synchronous Node DB parser，必須沿既有Host持有的共享budget。

後續還有cold DB、壓縮/paginated/reference、Codex來源inventory/registry/HTTPWeb，以及
其餘harness/C1–C8；本批不能當完整Web或完整多Agent歷史。
