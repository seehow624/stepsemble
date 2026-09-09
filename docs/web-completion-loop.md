# Web 完整體：持續執行與驗收清單

2026-09-08，Jerome 明確要求「開啟 loop 模式，讓它變得完整」。已建立目前任務的
持續 goal；本文件保存工作順序和驗收狀態，**不是另一個排程器，也不執行背景 shell loop**。
長期決策仍以 [platform-plan.md](platform-plan.md) 為準；本文件不取代或放寬該計畫。

## 目標與停止條件

把本階段 Stepsemble **Web App 做到可驗收、可安全發布的完整版本**。
不是把所有未來原生 App 一次上架，也不是只把目前的 Rust inventory 核心寫完。
Web/PWA 永久保留；iOS/macOS 與其餘平台客戶端依既定分期另行驗收。

只有本階段接受範圍逐項具備實作、測試和實際操作證據，已知阻擋缺陷處理，
發布／回滾準備就緒且通過既有正式上線關卡後，才可以把 goal 標為完成。
若某 harness 沒有相應原生能力，要明示能力邊界，不用 UI 假裝已完成；
外部能力或授權阻擋不能直接勾選成「完成」。

## 開始時的真實基線

- 開始 HEAD：`722477185b44305067b33700dd27dfb473ee55cf`，工作樹乾淨。
- 開發候選 `3.0.7-rc.5`；兩台 Mac 最後已確認正式版本 `3.0.6`。本次開啟 loop 未部署。
- Plan 1.49 原生探索核心已驗；native 程式證據屬於 `25c91bb`，見
  [native-history-discovery.md](native-history-discovery.md)。不重新做同一個核心。
- Pi＋Stepsemble tasks 的統一呈現清單已驗；它不是其他 CLI 原生歷史的自動匯入。
- Claude 單 session opt-in、唯讀 HTTP／relay／獨立頁已實作；新 source-group
  inventory **尚未接 config、動態 registry 或 Web**，沒有新增私人來源。
- 固定 `ab227af` 的 72h soak 仍由既有獨立監測追蹤；這份清單不冒稱即時狀態，
  不把那份結果套用到新 runtime。

## 順序與驗收

2026-09-09／Plan1.72 **進行中**：Codex可讀歷史先補來源關聯回合／工具結構與
parser5/6、同兩reader named流程。真正native147messages／rich turn ID與219原文
逐byte比對通；新近8MiB/8192筆worker、真Claude peer、雙版本及五階段取消通。
完整及最低Node1012/0fail；既有Claude deadline測試牆鐘競態已改精確時鐘回歸。
**b8d1843已接source service／HTTP／peer／Web，仍不勾C2**；e9aac82再修模式切換
fetch abort早於Host actualclose的source_busy真競態，本機與最低Node1019/0fail、
真Host23筆3回合與CUA320/390完整長文／內捲／跨頁工具／回退與raw切換通；新exact
CI全通/full logs已核，原b8 rolling兩OS失敗保留。e9三OS1019/0fail、reader244＋25＋10，
雙OS各六新結構Web cases通。接下來大型歷史、paginated/native語義、其他adapter，
不重做已驗壓縮／冷DB。
8b29e62底層一般／reader／nativeCodex全通且full logs已核，
原工程24f924f rolling通；原Windows測試路径缺陷的兩CI失敗保留，未放寬worker grant。
詳[結構與未完成項](codex-history-structure.md)，新Web驗收獨立記錄，不是C1–C8完成。

2026-09-09／Plan1.71壓縮來源增量：v9同heldparent選plain/壓縮、strict frame boundary
及有界背景解壓、雙來源version fence、真正Host/catalog/名稱/分頁已接；985/0fail本機及
最低Node、390px CUA壓縮頁和恢復通。工程a2af9f6後以9820ed2修測試Buffer差異膨脹，
新一般／reader／rolling三CI全通及full logs已核；nativeCodex／Claude保留a2af9f6
未改產品的成功證據。原reader兩次Linux失敗仍保留，不改寫成通過，非C2整體完成。
下一段仍有大型歷史限制、完整native語義呈現、其他adapter與C3–C8；不是只剩72h。
詳[壓縮歷史](codex-compressed-history.md)。正式3.0.6／私人來源與固定72h不變。

2026-09-09／Plan1.70冷來源增量已驗，整體goal繼續：cold SQLite已接主DB共享鎖＋有界唯讀RAM副本、v7/v8、
Node同admission/version、實際Host/Web。真ownedHost39筆冷頁／清單／名稱、雙向
layout失效／partial拒絕與復原、CUA390px冷熱流程已驗；本機975/0fail/2skip、
Rust29/30／全部179child與83dirs清理通。新工程7b16d03五CI已通／full logs已核，底層808efca既有
三CI證據不套成新SHA結果；Windows來源仍unsupported，也不是C2整體完成。
詳[冷資料庫接續與證據](codex-cold-sqlite.md)；Plan1.69 Web原始紀錄既有成果不重做。

「待完成」不表示從零開始；沿用主計畫已驗模組，只補缺口。

| Checkpoint | 交付與必要證據 | 開始狀態 |
| --- | --- | --- |
| C1 來源到可用清單 | source-group 一次 opt-in／readers scope；inventory 與內容共用有界 admission；動態來源撤銷、增改刪、catalog 分頁；正確 native title/metadata；actual Host→Web 按需讀取 | Plan1.57新增本機新群組設定精靈/review/明確readers/CREATE與真Host原檔驗證；Web列表已接，不自選私人來源或新增Web管理route，完整管理/實機與C1完整gate仍待 |
| C2 各 Agent 原生歷史 | 各自固定版本 API／格式、native ID/name、主／subagent 範圍、完整歷史與原生名稱驗證；未知版本／來源有清楚狀態 | Plan1.69 owner→catalog→registry→HTTP/peer→Web raw records；1.70冷DB及1.71壓縮v9／bounded parser全鏈與CI已驗。三OS985/0fail、reader236＋10，POSIX39筆全頁／名稱／雙向切換與cleanup，雙OS×六壓縮browser cases通。仍非完整native語義／原子snapshot／resume；超8MiB大型歷史、paginated、其他adapter與C2完整驗收繼續 |
| C3 Session／approval／恢復 | 按真實 capability 接結構化事件、續跑與 approval；ownership、exact correlation、重送／重連／Host crash、durable journal/replay 不漏不重 | 有 contract 與局部實作，未全驗 |
| C4 帳號與故障體驗 | 登入／登出偵測、官方登入入口、路由相容、取消／失敗／stale／busy 可復原；不修寫第三方憑證或以重試消耗模型 | 局部已驗，跨 harness 待補 |
| C5 手機與跨裝置操作 | 完整 history i18n、鍵盤／focus／內捲動、長歷史 DOM 上限、Host 切換、background/reconnect、跨機與目標瀏覽器實測 | Plan1.56已接119keys/11語並修正locale scroll跳動；320/390合成Host CUA、原文/DOM/focus保留已驗；人工校稿/真機/跨Host與其餘gate仍待 |
| C6 可靠性與效能 | 保存完整失敗診斷；調查曾發生的未定位測試失敗；同 workload 多輪 before/after、記憶體、長串流與斷線驗證 | Plan1.65修POSIX fixture鎖與Mac320px觀測競態；1.71重現並修測試Buffer差異格式化膨脹，原兩次Linux失敗保留，新9820ed2通。Linux合成Host最高觀測stage RSS85,794,816 bytes，非完整峰值／容量結論；混合負載、長歷史與整體效能gate仍待 |
| C7 跨平台 Host 與分階段 Rust | 保留相容 Host/Client 邊界；Rust 以契約／shadow／逐 endpoint 方式接入；Windows 原生來源與真服務 runner 不把 parser 通過当成功能通過 | POSIX reader 已有，其餘按主計畫 gate 推進 |
| C8 發布與回滾 | exact SHA 的必要 CI／browser／native gates、來源與帳號授權、active-work 檢查、備份、回滾、正式健康與版本／裝置驗收 | 正式 3.0.6 不變；新候選未部署 |

## 第一段：C1 的具體接續

1. 先讀主計畫、現況盤點、架構，再讀 `native-history-discovery.md`、
   `history-host-integration.md` 與相關 registry/service 原始碼。
2. 實作可信 source-group config，讀者採既有 browser credential／incoming peer grant
   身分；保留舊 explicit catalog 相容，設定缺少或未知欄位時 fail closed。
3. 將 inventory 和 content flights 納入同一 Host 資源預算，避免每 group 各建 helper
   乘出無界程序；取消／超時後仍須 actual close，cleanup unknown 永久 quarantine。
4. 動態 registry 增改刪要同步撤銷失效 bindings、pages／sourceVersion 及 in-flight
   發布權；不能藉重建整個 service 清掉 quarantine 或繞過限制。
5. 設計有界、逐讀者授權的 catalog 分頁；2048 項 Host-private snapshot 含私人路徑，
   **不能直接送入舊的 256 項 catalog 或 Host-wide sessions API**。
6. 以固定版本的原生 metadata 取得真實 title；缺少名稱明示未命名／不可用，
   不把 UUID、檔案名或推測文字標成「原生名稱」。列表不預讀全部 transcript。
7. 用自建合成來源驗 actual Host／授權／registry／HTTP／browser 全鏈；覆蓋撤銷、
   空清單、失敗保留舊資料、超限、來源改變、並行 busy、關閉及晚回覆。
8. 接 Web 可理解的 opt-in／清單／歷史操作，完成瀏覽器驗收後才進真人來源關卡。

此順序允許為依賴先做 shared admission；不可為了速度先掛無界 HTTP 掃描，再補安全。

## 每次迭代規則

- 保留已確認 B+ logo、使用者現有工作樹、原生歷史與第三方模型／登入設定。
- 先定本次可驗證小目標，實作與負向測試一起完成；修復失敗後重跑相應 gate。
- 保存完整 TAP／錯誤 case／命令與 exit code，不能只留總數後宣稱已定位失敗。
- 測試紀錄區分 synthetic／真 SDK／真 CLI metadata／真模型／真 browser／真機，
  精確列出 SHA 與平台；skip、unsupported、未跑都不是通過。
- 本機 GUI 使用 Codex Computer Use；真模型呼叫不自動重試。CI fixture 不取私人 HOME。
- 每 checkpoint 更新此表與主計畫的實質增量，commit/push 後核對相應 CI；把私有
  交接記錄放 vault 的 Stepsemble 記憶卡及 daily，不把憑證、來源或測試私密輸出送 GitHub。
- 不重複詢問「要不要下一步」；有安全、相關工作就繼續。必須新增權限或外部操作時，
  清楚列出必要動作；有其他安全工作先做，不能將未通過門檻寫成已完成。

## 明確不自動跨越的關卡

- 私人來源根目錄、可讀 credential／分享範圍必須由 owner 明確選定。
- 真實模型用量、登入／路由變更及正式服務重啟／部署依既有確認與保護流程。
- 不動原 72h soak 的 controller、起點、runtime SHA 或獨立 automation；新增 runtime
  需要自己的相應穩定性證據，不能繼承凍結長測的結論。
- 未來 App Store 發布、費用、商標／帳號等外部事項不從「loop」推論新授權。

## 執行記錄

- **2026-09-09 08:16／Plan1.69增量完成、整體goal繼續**：主工程2fe48d0五CI全success；
  收尾c57747f三CI全success且完整logs已核。三OS各965/0fail（Mac2skip/Linux3/Win50）、
  reader226、Rust27lib/30POSIXbin/15Winbin／audit0/0，POSIX真Host39筆、emptyCatalog、
  startupFailureCleanup通；Mac/Linux各六個Codex三尺寸×明暗browser cases，原文／
  11語不重讀、長文內捲、翻頁／rename／格式提示／empty／關閉恢復通。不是全native
  語義或C1–C8完成，不支持的Windows私人reader未被算通。私人來源／B+／帳號／正式／
  獨立72h不動；下一輪優先cold／compressed來源可用性與完整語義、其他adapter，
  不重做已接的owner→registry→HTTP→Web。全部本機owned程序與CUA已清理。詳
  [Codex Web接線與exact CI](codex-web-integration.md)。

- **2026-09-09／C2 Codex 完整 Web 接線，Plan 1.69 工作中**：以固定 state DB
  thread ID／選定 rollout 建立 catalog，避免同 thread 多 rollout 重複／錯選。
  驗收範圍含設定、授權、discovery、共用 registry、HTTP 與 Web；尚未完成或部署。
  工作入口與未完成項見 [Codex Web 接線](codex-web-integration.md)，不可把底層 reader
  完成等同 C2／本輪產品完成。私人來源、帳號及獨立 72h 不變。
  08:05更新：雙root owner精靈v3／source service／單一64槽union registry／HTTP／
  peer／typed Web raw-records已接通；完整及最低Node各965/0fail/2skip、Rust27/30、
  Ajv1251／fmt／clippy／generated／gitleaks通。真ownedHost39筆、WAL名稱／版本、
  paginated拒絕、unsafe path／actual cleanup通；CUA320/390長文內捲及原始紀錄、
  翻頁／格式提示已驗，並修正租約過期按鈕無反應。新CI待提交後核，未部署；raw
  非完整native語義畫面，其他來源及C1–C8仍未完成。詳工作入口，不重做已接線模組。

- **2026-09-09／C2 Node SQLite接線，Plan1.66／rc.7不變**：新增嚴格v4 frame及
  有界名稱pipeline，Host兩名額共用／取消actualclose／unknown cleanup全域隔離；
  selected-field版本排除I/O計數和其他欄位commit，不把候選名稱當最終title。
  新18unit、本機Node871/0fail/2skip、Rust/clippy通；owned pinned writer＋真Claude
  SDK/Codex parser驗max2/remaining0、最新WAL/名稱變更/bytes不變/取消。工程7bdbfe3
  五CI完整logs已核：一般各871/0fail、reader各136/136/audit0/0、POSIX13reader/1writer
  真清理/7真SHM、Winunsupported，rolling各24cases、原生Codex/Claude契約皆通。
  詳[Node SQLite接線](codex-sqlite-node-pipeline.md)，C1–C8整體未完，goal持續。
  未接私人grant或CodexHTTPWeb，正式/B+/帳號/獨立72h不動。

- **2026-09-09／C2來源FD綁定，Plan1.65／rc.7不變**：新增POSIX DB/WAL/SHM
  retained FD、共用ACL/owner/mount/root檢查、精確virtual-path syscall與有界讀取；
  SQLclose後再核權限/身份並關閉驗證FD才回覆，Rust v4 request/frame嚴格區分SQLite root。
  舊測試比對開/關同inode解除writer鎖已定位，改獨立process比對size/SHA/檔名；
  新正常case要求真SHM映射，原13negative/snapshot/kill案例重新驗，另53source/wire
  cases Mac通，總100child全reaped/61dirs清除。Node849/0fail、原reader/pair亦通；
  最終9bf8bf7三CI全通：一般各853/0fail、reader118/118與POSIX100child/61dirs、
  Win真v4unsupported/41child/10dirs、audit0/0、rolling雙OS各24case/pageErrors0。
  Mac320px loading早於route觀測的既有測試競態亦定位修正，保留失敗、不放寬exact1。
  未接Node v4／HostWeb、不授權私人來源，Windowssource與cold能力仍拒絕。
  詳[SQLite來源綁定](codex-sqlite-source-bound.md)，goal仍active，正式/B+/帳號/72h不動。

- **2026-09-09／C2 SQLite程序邊界，Plan1.64／rc.7不變**：新增非default的唯讀
  VFS政策、獨立子程序正反fixture。未受保護readonly_shm缺WAL會建立空檔且讀舊base，
  冷DB甚至失敗也會建WAL；新政策拒create/write/delete，必要檔案缺失回unavailable，
  不偷偷repair。13cases／16actualchildren全reaped，20commit snapshot、checkpoint成本、
  kill後OS釋放鎖、本機原Rust16＋25及Node849/0fail通。Win內部OPEN_ALWAYS繞過xOpen
  已用專用process syscall policy修正，保留未受保護cold平台差異及kill先關stdin競態
  的失敗紀錄。最終2df35cd三CI34268766580/34268766553/34268766557全通且logs核實：
  三OS各13cases/16reaped/8dirs清除、Rust16＋25/25/10、Node849及118/118、audit0/0；
  rolling雙OS各24cases/pageErrors0。這不是Windows source reader已支援。
  詳[SQLite程序與VFS](codex-sqlite-process.md)；未接private opener/ACL/worker/HostWeb，
  cold DB完整能力與C1–C8仍待，正式/私人/B+/帳號/72h邊界不變。

- **2026-09-09／C2 SQLite短交易，Plan1.63／rc.7不變**：Rust接caller-owned唯讀
  connection，exact native schema／SQLite3.53.4、欄位／SQL／deadline/VM/cancel限額，
  close後才回；owned另一thread連線20次commit不混snapshot，checkpoint成本明示。
  新16Rust＋原25、Node849/0fail、舊sharedpipeline／43packages audit0/0通；首批
  general/native/rolling通，reader的offline跨target依賴與Windowsfixture等待超時
  已修，原失敗保留／正式250ms不變，LF/CRLF兩種native DDL明確固定。修正510c3f3
  四CI完整logs已核：一般三OS849/0fail、native各13＋17cases、新Rust16與sourcehash、
  Node各118/118、POSIX舊actual鏈／Windowsunsupported、audit0/0、browser各24cases。
  尚無source opener/VFS/ACL或新worker/HostWeb，不拿普通VFS開私人DB。详
  [SQLite交易](codex-sqlite-transactions.md)，C1–C8與正式/私人/B+/帳號/72h邊界不變。

- **2026-09-09／C2 SQLite名稱，Plan1.62／rc.7不變**：13個owned真native cases核
  DB distincttitle/index/name/preview優先與sqlite_home≠CodexRoot，固定五欄parser
  有界且不冒稱最終name/sourcegrant。本機849/0fail、最低Node118/118、兩Node真13cases
  與另五輪通；exact7bd9acb三CI完整logs已核，一般各849/0fail、native各13SQLite＋
  17index cases、reader各118/118＋POSIXactual／Windowsunsupported、audit0known0warnings。
  SQL NULL/empty差異與paginated deprecation拒絕均留證據，
  不放寬通道或碰私人DB。詳[SQLite名稱](codex-sqlite-names.md)，DBWAL一致性/正式
  reader/授權/HostWeb與C1–C8未完，正式/B+/帳號/私人/72h不變。

- **2026-09-09／C2/C6背景解析，Plan1.61／rc.7不變**：Rustcapture到Nodeparser
  actualclose共用Host兩名額，未知清理隔離所有consumer、無重送或新queue。22新tests、
  本機845/0fail、最低Node114/114，真跨harness max2/remaining0、stale/取消/raw頁通；
  首批CI Windows路徑JSON escaping斷言已定位修正，exact391f72b三CI已核完整logs：
  一般各845/0fail、native各17cases、reader各114tests/POSIX真跨harness/Windowsunsupported、audit0known0warnings。
  合成8MiB索引main-loop gap由87–94ms降6–8ms，整次約0.76秒，
  非Web/RSS驗收。詳[背景解析](codex-history-pipeline.md)，CodexSQLite/授權/registry/
  HTTPWeb與C1–C8未全完；正式、私人、帳號、B+與固定72h不變。

- **2026-09-09／C2 Codex index names，Plan1.60／rc.7不變**：有界bytes parser保留
  latest/read/list不同原生索引規則，成組capture SHA/version綁定，沒有最終title權威。
  真CLI17cases/19原檔不變/model0/loaded0/cleanup通，最低Node及另五輪通；確認
  preview同名read/list差異，SQLite優先來源未接。新7tests/完整823/0fail、最低Node26/26，
  exact f884843三CI全過且核logs，一般三OS823/0fail、native各17cases、reader各92tests/
  POSIXcapture→name/Windowsunsupported、audit0known0warnings。詳[名稱索引](codex-name-index.md)。
  其餘C1–C8、CodexHostWeb及權限關卡未完。

- **2026-09-08／C2 Codex selected source，Plan1.59／rc.7不變**：Rust新v3成組
  讀rollout與固定nameindex，精確active/archive/reverted locator、root/ACL/mount/
  雙讀/各層edges復核、缺/空索引分開，16MiB raw wire與composite version fence。
  Node同helper flight/actualclose/quarantine不另繞過，真Rust→raw頁owned鏈通；
  新Rust8tests/總25、Node8tests/總816/0fail、最低Node38/38及舊ClaudeactualHost通。
  exact ebe9a8e五CI已核：三OS816/0fail、reader POSIXpair/Windowsunsupported、雙OS
  各24browsercases；NativeCodex Linux首次下載reset，保留log只rerun failed後通。
  詳[Codex來源capture](codex-source-capture.md)。name parser、壓縮、
  source config/discovery/HostWeb仍待，不是完整原生歷史；私人/模型/正式/B+/72h不動。

- **2026-09-08／C2 Codex原始記錄，Plan1.58／rc.7不變**：固定原始碼與owned trace
  定位legacy persistence filter省略command/image；原缺項gate仍留，不反覆猜JSON。
  bytes-only有界快照/分頁保存原文、unknown/CRLF，handle隔離及release；新11tests、
  本機805/0fail、最低Node37/37及真CLI raw113頁219records byte-exact、model/private0。
  首批exact57decd7一般三OS805/0fail，native Mac/Windows通但Linux啟動通知失敗。
  隔離重現後只允許owned Linux一次精確缺system-bwrap通知，timestamp合法且第一個
  history回覆前；其他warnings/effects仍拒絕。本機增至808/0fail、最低Node40/40，
  修正607677b一般CI34245329559三OS808/0fail/Ajv1251，native34245329521三OS
  真CLI最低Node22.19全部通、完整logs核實；原缺項gate仍留，詳[raw records](codex-rollout-preservation.md)。
  還沒有source fd/ACL/capture/nameindex/HostWeb接線，不等於C2或全產品完成，正式與72h不動。

- **2026-09-08／C1 owner設定精靈，Plan1.57／rc.7不變**：逐欄修正與明確現在/未來
  scope、master/peer讀者邊界，精確CREATE後才建立新的private config；review immutable/
  單次及metadata漂移拒絕，partial write不刪競爭輸出。真TTY建立/取消與最低Node真
  Rust/SDK/Host使用精靈原檔的actualSetupGate已通；新17tests、本機794/0fail、最低
  Node32/32及Ajv1251通。Exact3c919a5四CI已通：一般34240582314三OS794/0fail，
  reader34240582404新POSIXactualSetupGate、Claude34240582335、rolling34240582379
  雙OS各24cases；skip/unsupported分列，詳[owner setup](history-owner-setup.md)。
  不改正式服務/私人來源/讀者/帳號/B+/獨立72h，非Web管理API/多群組編輯/C1全完。

- **2026-09-08／C1/C5歷史多語，Plan1.56／rc.7**：實際頁/preview共用119keys及
  11完整字典；原始name/summary/messages/JSON/timestamps不翻譯，顯示上限通知另放。
  沿用workspace locale，page-only選單不寫settings/不操作歷史。CUA抓到並修正
  原生scroll anchoring重複補償；320px十一語、390px工具歷史、44px/無横溢/console0，
  owned Host cleanup確認。npm777/0fail、最低Node57/57及Ajv1251/生成/語法/版本通；
  新native browser多語、原文/focus/scroll/no-read gate依exact CI另验，詳
  [history-localization.md](history-localization.md)。正式/私人/模型/B+/独立72h不變；
  C1–C8未全部完成，不將人工校稿/真機/跨Host和其他adapter略過。
  Exact f7f1f17 四組CI已全通：一般34237527689三OS777/0fail及Ajv1251、rolling34237527690
  雙OS各24cases（各六native×11語/localeReads0/原文focusscroll不變）、reader34237527771
  與Claude34237527724；完整logs及各平台skip/unsupported已記專題文件。

- **2026-09-08／C2 observation 與缺漏保護，Plan1.55／rc.6不變**：有界保存
  native ID/name、完整原始item、turn狀態與未知欄位；不合成approval、不執行
  歷史工具、不讀附件。19種標籤保留的13新unit tests通，本機768/0fail；真CLI
  rich fixture只還原6類，command/image缺失明示unavailable，不能當完整歷史通過。
  Node22.19/22.22 owned runner均模型endpoint0／11原檔不變／actualcleanup確認。
  官方paginated完整讀取仍不支援，下一步查證rich格式與legacy capture/fence；
  不反覆猜格式或手改native store。詳相容性文件，C1–C8整體仍未完成。
  程式ebf756e已push，CI34232465377三OS各768/0fail（Mac766/2skip、Linux765/3、
  Windows736/32）與各Ajv1251通；未重跑browser/native-reader，非新UI驗收。

- **2026-09-08／C2 Codex讀取邊界，Plan1.54／rc.6不變**：10個補充schema固定、
  獨立read-only RPC與真0.153.4 owned-home runner；cli/vscode/exec/appServer/
  subAgent review/unknown、主/封存分頁及7個legacy對話49turns/147items/原生名稱
  已驗，loaded0/model endpoint0/10原檔不變/actual cleanup確認。不是全adapter：
  items/list有schema卻native -32601，paginated JSONL-only缺name/store projection。
  下一步補owned store／capture／rich mapping及同Host接線，不能直讀私人Codex HOME。
  官方文件只作介面參照，以固定CLI實測為準；詳[codex-history-compatibility.md](codex-history-compatibility.md)。
  程式87225f9已push且exact CI34227909134三OS755/0fail、各Ajv1251及rolling34227909162
  雙OS各24cases/pageErrors0全過；真Codex不是跨OS或Web驗收，沒有重跑／冒用舊reader gates。
  C1及C3–C8仍繼續，正式/帳號/第三方route/獨立72h不變。

- **2026-09-08／C1 Web來源操作，Plan1.53／rc.6**：新增有界source browser model＋
  stable DOM；只逐一載可見名稱、metadata更新不重建content、換對話等待cleanup再開
  最新選擇。title與summary分開且完整文字可展開，50列inner scroll、≥44px、
  snapshotpaging/stale/abort/背景pause/manual fallback。CUA真Host64個owned來源、
  320/390px無横溢、原生改名及正文、返回焦點、manual內容與console無error已驗；
  本機742＝740pass/2skip/0fail、Node22.19真pipelinecleanup確認。新增Mac/Linux
  3尺寸×明暗的真native瀏覽器CI，f1f47ca雙OS各24cases（其中六個新sourcecases）
  已通；程式c88f526的三OS一般/native/audit gates也通，見來源群組exact紀錄。
  測試首輪只因rc.6 CHANGELOG
  尚未加而失敗，補上重跑通；不是以前678項unknownfail已定位。正式/私人/72h不變。

- **2026-09-08／C1名稱與client transport，Plan1.52**：固定SDK透過captured store取得
  native title，summary分開、不推測名稱；同2flight/64slots、ephemeral綁定不干擾
  現有對話、indexedidentity/snapshot/權限再次驗證。新HTTP/relay/strict TS已通
  最低Node22.19真Rust＋SDK合成Host鏈，`actualMetadataGate=passed`；沒有私人
  history/model/正式變動。接續Web來源UI＋按需名稱，不預讀全2048份transcript，
  做完CUA與相應回歸才可把C1往前勾。其餘C2–C8與原72h邊界不變。
  程式`850e012`四組exact CI全過：三OS730tests/0fail、POSIX新actualMetadataGate、
  固定SDK三OS及既有browser雙OS各18cases；詳細run ID/counts見來源群組文件。

- **2026-09-08／C1後端進展，Plan1.51**：明確source-group/private readers設定、
  同Hostbudget、dynamicresolver與變更/刪除撤銷、snapshot-fenced50列分頁、HTTP及
  dedicatedrelay已實作；actualserver.js＋真Rust＋SDK合成鏈通。來源尚未接Web，
  titleStatus為not_loaded，不是完整C1。下一輪從native title/metadata及TS/Web接線
  繼續，不重做已完成後端；詳[來源群組](history-source-groups.md)。
  程式`ad7e534`四組exact CI已全過：一般三OS705項0fail、新POSIX原生來源群組鏈、
  固定SDK三OS及既有browser雙OS各18cases；不代表native title／Web操作或C1全完成。

- **2026-09-08／C1部分進展，Plan1.50**：shared admission接上Host/content及index，
  真Rust＋SDK合成並行physical max2／remaining0、第三要求spawn前busy通過；本機
  689項回歸0fail。來源group還未掛HTTP/Web，C1未完成；下一輪不重做這個budget，
  從source-group config／同instance接線／dynamicregistry／catalog paging繼續。
  程式`ab8e6ed`四組exact CI全過：一般三OS各689項0fail、reader三OS及audit、
  固定SDK三OS、rolling雙OS各18cases。驗證範圍見[reader admission](history-reader-admission.md)；
  Windows原生來源仍unsupported，並非C1產品流程或整體goal驗收完成。

- **2026-09-08／啟動**：產品 goal 建立成功，狀態 active、沒有自行設定 token budget。
  本文件與主計畫入口保存完成條件和下一個 checkpoint；本次只是啟動及交接，
  C1–C8 未新增「通過」項，未變更 runtime、來源設定、帳號、正式部署或長測。
