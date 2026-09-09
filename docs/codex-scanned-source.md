# 大型 Codex 來源：v10 安全分頁擷取（Plan 1.73／進行中）

2026-09-09；工程 `da12256501a74da749fd293bc969b4c0f4feb4a6`；owned CI 路徑修正
`eabba3efa7834c128e8cabe69b338c2f35c4995f`，產品來源邊界未放寬。
這一段接續[逐段掃描核心](history-large-scan.md)，將它接到真正的檔案安全邊界，並新增
Node→Rust 的 Host-private 協定。**尚未接入 registry／named parser／HTTP／Web；
尚未提供大型原生語義歷史，也不是 C2 完成。**
正式3.0.6、dev3.0.7-rc.7、B+、來源／讀者授權、帳號及獨立72h均不變。

## 實作範圍

- `posix/codex.rs` 的同一個 authenticated open/check/close 流程分成 bytes 與 page
  兩種結果；**v3/v9原有兩份buffer逐byte比較的順序／checks不變**。新路徑不複製或
  放寬一套權限政策，沿用同opened root identity、owner/mode、ACL、hardlink、local
  volume、held directories、固定name-index存在性與name→object edge重驗。
- v10只接受strict source/nativeVersion/expectedRoot/page與nonce。所有struct先exact
  deserialize再重用v9的來源驗證，duplicate/unknown/null fields不被Value重建洗掉。
  只允許既有active／archive／revert locator；不能藉page參數選`auth.json`、args、env或任意路徑。
- selected reader以同held FD的positioned `read_at`逐段掃描；不是重新open path，
  也不借共用OS seek cursor。兩輪中間重驗所有原身份，最後再重驗names/root，逐個
  `close`成功後才寫成功frame；Node只有真正child `close`後才交付buffer。
- name index仍是固定檔案，缺少／空檔／有值分開，兩次literal byte compare；沒有任意
  auxiliary path。檔案變更／權限／索引出現消失／目錄或選中檔替換均不能回頁。
- 新讀取仍使用原5秒Rust budget、10秒Node deadline和unknown-close quarantine；
  沒有加長timeout、加worker/heap grant、換進程或自動retry。checkpoint不能取代
  父程序硬逾時及實際收尾。成功／取消／失敗都不留原生session或模型工作。

## v10 和 v9 的界線

| 項目 | 既有 v3/v9 | 新 v10（private） |
| --- | --- | --- |
| selected rollout總量 | ≤8 MiB | plain source ≤256 MiB／262,144筆 |
| 回傳rollout bytes | 整份 | 一頁≤50筆、≤256 KiB原始bytes |
| 全來源比較 | 兩份bytes literal equality | 兩次全檔SHA-256／長度／筆數 observation |
| 名稱索引 | 固定≤8 MiB完整bytes | 相同；未改成無界index或假名稱 |
| storage | v9 plain優先、可選compressed | 同plain優先；選到compressed明確unsupported，不拿zstd當JSONL |
| native語義 | 後續既有parser另驗 | **此擷取尚未驗**，不可直接發布為原生歷史 |

新success kind是`native_codex_source_page`，不是舊`native_codex_source_bytes`。
frame分離：

- `rollout`：整份來源identity／SHA-256／recordCount；不是page digest。
- `page`：offset／nextOffset／總byteLength，以及每筆全來源ordinal、原始byteOffset、
  payloadOffset、byteLength、SHA-256。原始body逐byte保留，包括LF/CRLF及空行。
- `nameIndex`：固定索引descriptor與body，缺少為null；不當作名稱解析結果。
- `checks.matchingRolloutDigests`、`matchingNameIndexBytes`分開；不冒稱新的rollout
  digest比較也是literal matchingBytes，更不說這是原子filesystem snapshot。
- `recordSemanticsValidated`、`semanticHistoryComplete`、`sourceAuthenticated`、
  `publishable`全部false。filesystem相容性／身份檢查**不等於原生provenance或Web讀者grant**。

`scanned-source-wire.js`嚴格校驗固定storage、scope/root、body與逐筆digest、payload和
來源offset連續性、source/count/line/page上限、EOF與empty page、所有proof/authority
flags。每筆body只能含一個末尾LF；escaped JSON wire大小仍是後續parser的獨立限制。
`codex_scanned_source_version`不含page offset/body，因此不同頁可共用同source version；
它仍包含整份rollout、name-index identity/digest和physical selection。頁外變動會失效，
缺少/空index或same bytes的新inode也失效。舊sourceVersion/parser不接受新shape。

`createNativeHelper.readCodexPage()`使用同一helper實例的busy／abort／deadline／close／
quarantine狀態；沒有第二套繞過admission的runner。**尚未把新method放進實際
source-service/named pipeline的admission流程**，呼叫方不能因此自行授權新來源。
目前POSIX開啟來源；Windows保留真binary unsupported，不能把wire或scanner通過算成支援。

## 本機驗證

OneStep-MacMini；所有fixture在自己新建的本機temporary root，沒有私人資料或模型呼叫。

- Rust：**29 library／41 binary／15 scanner**與all-targets/cross-process gates通。
  新8個binary tests含strict v10 input/error frame、大小／count／tail、舊8MiB拒絕不變、
  active/archive/revert、same FD與索引、所有7個held descriptor在before/between/after
  的ACL/mode變動、21種讀取點/來源與index/目錄變動組合、symlink/hardlink/fifo等拒絕。
- Node新9項test、相關33focused全部通；完整及最低Node22.19各
  **1028 total／1026 pass／2 skip／0 fail**。輸入getters零呼叫、實際close前不settle、
  scope/proof/frame/body/ordinal/EOF/版本拒絕，無收尾則同helper永久quarantine。
  明確測到非JSON/binary LF能作為byte observation返回但語義flag仍false，避免偷換驗證層。
- 真Node→Rust release gate：**16 MiB／16,384筆**，first／middle50筆／last／EOF
  原始bytes與offset、same-version通；改第10,000筆再讀第一頁，page bytes相同但full
  source version不同。小來源全頁拼回原文、索引missing/empty/replaced、wrong-root、
  sentinel零誤讀、tail/record/empty拒絕後恢復、plain priority和compressed拒絕均通。
  每輪20child spawn/reap，max1、remaining0、helper actualclose、1owned目錄清理。
- 舊實際Host回歸：39raw＋23structured/3turns、cold/compressed雙向version、名稱、
  tool links/rollback/raw roundtrip及復原，Host/writer actualclose、2owned目錄清理通。
  **此Host gate仍是原小來源，不冒稱它使用v10或讀了16MiB。**
- fmt／Clippy all-targets／actionlint／client generated／版本同步／Ajv1251conformance／
  gitleaks0leaks通，正式及public contract無改。

Logs：`/tmp/stepsemble-scanned-source-{rust-2,rust-full-1,owned-2,host-1,clippy-1}.log`、
`node-1.tap`、`full-1.tap`、`minimum-2.tap`、`{client,protocol,conformance,version,secrets}-1.log`。
第一次minimum指令使用檔案glob，漏的是`test/support/codex-binding-harness.cjs`這個
自動發現entry（1027），不是產品failure；已按完整`node --test`重跑1028，不把前次稱full。
第一輪owned-1測middle2筆、owned-2增為最大50筆，兩輪均通且各20child/1dir清理。

## Exact CI

工程 da12256 與測試修正 eabba3e 均已 push；以下已完成並核對下載的完整 logs。
新 workflow 另外 build release reader 並跑真正 Node/Rust 檔案 gate 與 9 個
wire/helper tests，不是只執行泛用記憶體 scanner。

| 提交與 workflow | 結果與證據 |
| --- | --- |
| da12256／[一般 CI](https://github.com/seehow624/stepsemble/actions/runs/34311976796) | 三 OS 各 1028 項、0 fail |
| da12256／[reader 原失敗](https://github.com/seehow624/stepsemble/actions/runs/34311976954) | Windows owned 腳本收到混用斜線的 absolute executable path，嚴格 canonical-path check 在 spawn 前拒絕；Mac/Linux 新來源 gate 通過。保留失敗，不改成通過 |
| eabba3e／[一般 CI](https://github.com/seehow624/stepsemble/actions/runs/34312350930) | 三 OS 各 1028 項、0 fail；Mac 1026 pass／2 skip，Linux 1025／3，Windows 978／50；各 Ajv1251 通過 |
| eabba3e／[reader 修正後](https://github.com/seehow624/stepsemble/actions/runs/34312350953) | 三 OS 各 9 新 wire tests＋244 原 boundary＋25 structure＋10 compressed 全通；POSIX Rust29 library／41 binary、Windows27／17，各15 scanner及五 allocation workload通過 |
| eabba3e／[固定 Codex 契約](https://github.com/seehow624/stepsemble/actions/runs/34312350923) | 三 OS 固定0.153.4：49 legacy turns／147 items、50 source-linked turns／219 raw records、17 index／19 SQL name cases；0 model endpoint request、0 loaded threads、原始11檔不變與 cleanup。commandExecution／imageView native projection及paginated缺口仍明示 |
| da12256／[固定 Claude 契約](https://github.com/seehow624/stepsemble/actions/runs/34311976883) | 三 OS 固定 SDK 合成唯讀契約通過，0 model；Windows private source 不支援保持。eabba3e 未觸發此 workflow，不冒稱重跑 |
| da12256／[雙版本 browser](https://github.com/seehow624/stepsemble/actions/runs/34311976902) | Mac/Linux 各24原 cases＋6 Codex三尺寸／明暗 cases通過；保留可讀/raw、完整長文、跨頁工具、回退及冷/壓縮來源回歸。不是v10大檔Web或真機證據；eabba3e未觸發 |

修正只在 owned 腳本先確認 CLI argument 為 absolute，再 `path.resolve` 正規化；
helper 的 canonical-path 規則原封保留。Windows 真 binary 已實跑 v10 unsupported，
1 child spawn/reap、remaining0、1 owned directory 清理；不是 POSIX 權限支援。
Mac/Linux 真 16MiB gate 均 20 child spawn/reap、max1、remaining0、1 directory 清理。
原 Host gate 各39 raw＋23 structured／3 turns、Host/writer reaped、2 directories清理。
RustSec locked dependency gate 通過，沒有忽略項或放寬 timeout／worker grant。

固定 Codex 原 da12256 的 [34311976916](https://github.com/seehow624/stepsemble/actions/runs/34311976916)
亦成功；修正後採 eabba3e 的重跑結果。完整 logs 在
`/tmp/stepsemble-scanned-source-ci-{reader-failed,reader-fixed,general-fixed,codex-fixed,claude,rolling}.log`。
本機修正後 `owned-3.log` 也通過並清理；沒有待等的工程 CI 或 owned 子程序。

## 下一段必須接完

1. **完整原生格式／metadata／名稱的有界驗證**：所有來源紀錄都要驗，不只當前頁。
   selected thread、fork metadata、native version/history mode、非法UTF-8/JSON/深度、
   index名稱與SQLite語意都不能由v10的byte-framing成功推論。不能直接把此body送Web。
2. 背景parser與source-linked structure跨整個來源建立回合／工具／rollback關聯，
   仍只回一頁與有界必要索引。compressed/paginated是不同能力，不能無聲套plain或降級。
3. 接同兩reader admission、named SQL/rollout前後version fence、binding/revocation，
   再接catalog、HTTP、relay、typedclient與實際Web；raw與舊v3/v9/v1–v6兼容。
4. 真大檔Host/Web、取消硬逾時／close、頁外變動、tail恢復、原名與工具跨頁、手機與
   混合負載／實測RSS、exact CI及正式release gates。沒有這些不能勾C2/C6/C8完成。

既有獨立72h source `ab227af`／runtime `2b7f0b6`未查未改，也不把其結果套到本工程。
