# Codex 名稱與歷史：背景組合與雙來源版本重驗

2026-09-09／Plan1.68，開發仍3.0.7-rc.7，未部署。
接續 [同交易名稱脈絡](codex-name-context-resolution.md)，不是全 Web 完成宣告。

## 本次實作

`createCodexHistoryPipeline.readNamed` 將原有 v5 SQL context、v3 rollout/index
capture 與方法別 resolver 接成一條實際背景流程：

`SQL A → rollout/index A → permissioned parser → SQL B → rollout/index B`

- 一個 Host permit 從頭持有到所有實際程序 close；每次順序執行，沒有巢狀 acquire、
  新 queue、reader 預算或替補程序。與舊 Codex、SQLite 與 Claude 使用同一個最多2名額。
- SQL B 重驗 selected 七欄／檔案身分；rollout/index B 重驗兩檔版本與 root。
  只做 SQL 前後括住仍會漏掉解析途中改 index／rollout，故兩種來源都必須重驗。
- 呼叫端可帶 composite expectedVersion；SQL不符在第一次 capture 後拒絕，
  rollout/index不符在第二次capture後拒絕，兩者都不啟動parser或偷偷重試。
- 五階段共用原10秒總期限／1秒清理期限，不每階段重新延長。
  AbortSignal（含上層撤銷）會取消目前精確程序；未確認close則整個共用 admission
  永久quarantine，保留占用。晚到close可清掉占用，但不能解除隔離或發布晚到結果。
- 原 `read` v1 API／raw頁形狀保持相容。新 `readNamed` 預設只讀names，
  也可明確選records頁；無自動續跑、登入、寫入、原生repair或模型請求。

新輸入為 Host-private `{history, sqlite, method}`：原兩個獨立已選定來源請求、
相同nativeVersion／threadId，以及 `thread_read_sqlite` 或 `thread_list_state_row`。
來源授權仍由Host呼叫端持有；不能把JSON參數本身當成grant。

## Parser 與名稱邊界

新 parser wire v2 額外攜帶同交易SQL七欄與獨立推導的 selected rollout 絕對路徑。
SQL rollout_path 只是待比對字串，**不作為新開檔路徑**。ID／mode／path不符、
缺SQL row時明示unavailable，不猜移動位置、忽略SQL或冒稱已取得原生名稱。

v2 header上限224KiB，v1仍16KiB；共用stdin最大allocation變成224KiB＋16MiB＋4，
多208KiB，不擴大原rollout／index各8MiB、8192records／128KiB單行、416KiB輸出
或128MiB V8 heap限制。shape、nonce、payload分段digest及輸出權限旗標皆重驗。
Permissioned Node只多允許讀取三個固定程式模組（SQLite wire、metadata name、
name resolution），不允許讀來源檔、任意fs、write或child；env仍只有LANG/LC_ALL。

新增純 `observeRolloutNameIdentity`：第一個selected metadata決定ID／mode；後續
fork metadata不替换它。names可解讀legacy及paginated metadata，沒有snapshot handle，
複製buffer在返回前清理；raw records仍明示paginated完整歷史unsupported。

這個observer沿用既有保守限制：完整LF結尾、逐行有效JSON、第一個非空記錄必須是
session_meta。固定native parser可容忍部分前導event／壞行，且有更完整SessionMeta
serde語意；此處**不聲稱完整複刻native metadata parser或原生history store**。
遇到範圍外檔案明確拒絕，後續才能擴充有owned oracle支持的讀取能力。

依 OpenAI Docs 先核對 [thread/read 的非續跑用途](https://learn.chatgpt.com/docs/app-server)，
再看固定0.153.4 source `3d2ee51ca2d5db578f328aa75e20aa22c0197c9a` 的
SessionMeta、read_session_meta_line與原生測試。本批沒有啟動native Codex查私人history。

## 一致性不是原子快照

成功回覆 `codex_named_capture`，含 `codex_named_source_version` 的history及sqlite
版本，以及 `consistency: matching_selected_versions_before_and_after_parse`。
它證明選定版本在前後觀察時相同，**不是跨SQLite／JSONL的原子快照或鎖**；
不能排除未被觀察的ABA，或最後檢查後又有writer改動。
Host仍須在publication前確認binding／grant generation，下一頁帶expectedVersion。
`sourceAuthenticated`／`publishable`／`nativeTitleResolved`／`semanticHistoryComplete`
繼續false，不能直接作為HTTP公開payload或把raw SQL路徑傳到browser。

## 本機驗證

- 新25項Node測試：第一metadata／paginated names vs records、SQL read/list差異、
  preview隱藏、ID/mode/path拒絕、缺row、v2大header、getter／digest／nonce／flags；
  五階段各取消與unknown-close quarantine、全Host共用兩名額、early expectedVersion、
  最後SQL及rollout/index版本／root／close驗證、晚到结果不發布、actualpermissionedchild。
- 全Node922項：920pass／0fail／2skip；focused reader187/187。
- Rust lib21／main28、fmt、clippy all-targets warnings-as-errors通；production Rust
  reader不改，本次Rust只擴test-only owned writer，仍固定命令／無caller路徑或任意SQL。
- 實際owned鏈：新named gate90次reader/parser啟動（含Claude/Codex peers）、
  35成功SQLcapture全部真SHM mapping、最高requestedReadBytes12388；最大2／remaining0。
  六個mutation觀察含SQL rename/preview/path、index/rollout，以及SQL B後改index；
  都拒source_version_changed。五階段实际取消、early版本、raw頁bytes、fallback/list
  suppression、paginated metadata與inert SQLpath拒絕均通。
- 同一test-owned pinned writer同時持有SQLite及JSONL兩個root；只有固定fixture命令
  改資料。Node獨立process比對read／error／cancel前後DB/WAL/SHM及rollout/index
  原始bytes，避免同writerprocess開關同inode FD破壞POSIX鎖。
  新90與舊SQL24 reader合計114，另1writer；outerCodex全gate143children皆close，
  writer實際reaped／1個ownedtemp根目錄完整移除。不是私人來源或正式服務。
- 原client／protocol／Ajv1251、check、actionlint、diff-check另驗；跨平台結果見下。

本機logs `/tmp/stepsemble-named-{new-first,reader-unit,npm-first}.tap`、
`...-actual-first.log`、`...-{build,rust,clippy,check,client,protocol,ajv}.log`。
這不是新named流程的RSS／負載／Web Core Vitals驗收；舊8MiB parser main-loop比較
保留作控制組，不拿它聲稱新五階段延遲改善或Web已順滑。

## Exact工程跨平台驗證

工程 **2501c881d62f4490d2310e6179a9e68e013e69b2** 的五CI全部success，完整logs已核：

- [一般34285310005](https://github.com/seehow624/stepsemble/actions/runs/34285310005)：
  三OS各922／0fail／Ajv1251；Mac920pass/2skip、Linux919/3、Windows875/47。
- [Reader34285310066](https://github.com/seehow624/stepsemble/actions/runs/34285310066)：
  三OS各Node187/187，Rust lib21/main28/28/13；最低Node22.19的Mac/Linux各新named
  90reader/parser、35真SHM/read12388、六mutation/五cancel/max2/remaining0；舊SQL
  24reader/16SHM亦通，共用1writer全reaped。outerCodex143children全部close。
  Windows新named與原v4/v5在Node零spawn明示unsupported，Rust實際source仍unsupported；
  不把純parser通過當Windows來源支援。原POSIX Rust103child/61dirs、Windows43/10
  均清理；SQLite artifact/source pin與既有lock不變。
  RustSec0.22.2、DB `bf25f6575a93a35f30796c65c0ed91bee7fa19fd`，0known/0warnings。
- [Rolling34285310015](https://github.com/seehow624/stepsemble/actions/runs/34285310015)：
  Mac/Linux各24cases、pageErrors0；每OS六個既有native來源browser案例各11語、
  localeReads0。它是現有Web控制組，不是新Codex名稱已接Web的證據。
- [原生Codex34285309991](https://github.com/seehow624/stepsemble/actions/runs/34285309991)：
  三OS固定0.153.4原history、17index、19read/18list名稱，21owned原檔及七SQL欄不變、
  2native程序全close，loaded0/model endpoint requests0；paginated完整history仍unsupported。
- [Claude34285412218](https://github.com/seehow624/stepsemble/actions/runs/34285412218)：
  在同一exact工程手動觸發（本次未改Claude路徑，不會自動觸發該workflow）；三OS
  SDK0.3.259/native2.1.259既有契約通、0model calls。

Logs `/tmp/stepsemble-named-{general,reader,rolling,native-codex,native-claude}-ci.log`。
本機actual第二輪 `/tmp/stepsemble-named-actual-second.log` 同樣90/35/read12388、
所有實際close通。沒有測試失敗被跳過或靠重試掩蓋；未改原生／私人資料或正式服務。
本批是實質工程進度，整體goal仍active，C1–C8沒有全勾完成。

## 接續與保留

1. 將已驗reader接入**Codex專屬**discovery／source-group／binding／registry，
   同Host admission、reader grant、generation及前後publication fence不可缺。
   先用owned資料驗實際Host→HTTP→Web，不新增私人root或預設全分享。
2. 對cold／missing sidecar、缺SQL row、compressed rollout、native metadata前導
   相容與paginated history store另做固定native proof；不能靠fallback跳過未驗來源。
3. 再完成主計畫C1–C8剩餘項與正式發布驗收。這個increment不是完整產品或最終名稱。

正式兩Mac仍3.0.6，B+logo／帳號登入／第三方routes不動。
獨立72h source `ab227af7e12edd7a9182d700ce052dfaf92a34b4` 與runtime
`2b7f0b652634a30cb546aceb27339cdad140efc0` 保持凍結；本批沒有查改／重啟該測試，
不能將其結果套用到新程式。
