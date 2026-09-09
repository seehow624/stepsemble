# 大型來源全檔格式驗證（Plan1.73／v11，尚未接 Web）

2026-09-09；工程 `5555a7eb2a185da3a4f49e4c46d0c3eda18dc8bf`。
接續 [v10 安全分頁擷取](codex-scanned-source.md)。
這一段將全來源 legacy envelope 驗證接入真正的 held-FD 雙掃路徑，不只解析當前頁。
仍不是完整 native item projection、name resolver、approval、resume 或 C2 完成。
正式3.0.6／dev3.0.7-rc.7／B+與私人來源／讀者／帳號及部署關卡保持；獨立72h未查未改。

## 為何需要這一步

v10 可以安全觀察 bytes，但第一頁正常並不代表後面的 JSON、thread metadata 或
history mode 正常。不能把 selected page 直接當作已驗證的原生歷史交給 Web。

[官方 App Server 文件](https://learn.chatgpt.com/docs/app-server#read-a-stored-thread-without-resuming)
區分讀取 stored thread 和 resume；文件上的實驗分頁不等於固定0.153.4已提供該能力。
本輪使用 OpenAI Docs 核對此界線；離線相容依據為專案固定版本的既有 raw parser、
owned fixtures 與已固定來源的 metadata／lineage 定義，不啟動真人 session 或模型。
後續 metadata 可以來自 fork 的歷史，不以後面的 ID 取代最初選定的 thread。

## 契約與實作

- 新 `codex_rollout_format::Validator` 每次只持有一筆 parsed JSON 及固定 counters／
  selected ID。全來源每筆都經過 UTF-8、完整單行、JSON object/type label、depth≤64、
  Unicode scalar、finite number、第一個非空白 metadata／exact selected ID 驗證。
- blank 判定與 ECMAScript trim 相同，保留 CRLF／Unicode 空白／原始 bytes；U+0085
  等非 JS whitespace 不被 Rust `trim` 偷當空白。type label 以 UTF-16 units≤128計算。
- 首筆 metadata 必須對應 selected thread；後續 fork metadata 驗有效 ID 與 history mode，
  但不改 selected ownership。每一個 metadata 的 paginated／unknown mode 都明確拒絕。
  缺 history_mode 保持 legacy；歷史 cli_version 不當成 reader version 或執行授權。
- 未知 record/payload/fields 仍保留原文，不丟棄、不執行工具／URL／附件，也不憑文字
  建立 approval。這只驗可安全解析的 envelope，不是逐類 native event schema parity。
- 相容範圍不是任意手改 JSON 的所有容忍行為：serde 在解析時拒絕非 finite number
  或 unpaired surrogate，即使後面的 duplicate key 可能在 JS 覆蓋它。舊 JS raw
  parser 不改；新路徑明示拒絕，不默默修復／刪除記錄或輸出半份。
- validator 第一次錯誤後不可恢復成成功；finish 必須有 selected metadata。它接在
  第一輪全檔掃描，第二輪完整 digest/count/size 比對後才可完成 observation；兩輪
  中間與最後的 owner/ACL/name-edge/root recheck、固定name-index雙讀及actualclose保留。
- v3/v9、v10、parser1–6及目前public 8MiB契約都不改。v11採相同strict request shape，
  由 `readCodexValidatedPage()` 明確選用；不另開繞過既有 busy/abort/quarantine 的runner。
  原5秒Rust／10秒Node／cleanup期限、輸入與輸出界線、helper權限均未加寬。

成功kind為 `native_codex_validated_source_page`，新增exact `validation`：

| 欄位 | 意義 |
| --- | --- |
| profile | 固定 `codex_legacy_envelope_v1`，不是 latest/native完整性標籤 |
| recordsValidated | 等於整份rollout.recordCount，含未選頁和blank，不是page.records.length |
| selectedMetadataRecord | 第一個非空白且符合selected thread的原始ordinal |
| metadataRecords | 全來源metadata數量，含後續fork metadata |
| historyMode | 此完整記錄路徑只接受legacy |

`recordSemanticsValidated`／`semanticHistoryComplete`／`sourceAuthenticated`／`publishable`
**仍全部false**。`codex_validated_source_version`包含此profile與全來源／index identity和
digest，與v10的sourceVersion明確分開；不能用v10成功回覆冒充v11或反向降級。
Windows真binary仍unsupported；plain≤256MiB／262144筆／128KiB每筆／50筆和256KiB每頁，
固定name index≤8MiB；compressed新路徑仍明示unsupported，不取代既有小壓縮來源功能。

## 本機實際驗證

OneStep-MacMini；全部自建owned temporary fixtures，沒有私人讀取、native invocation或model。

- 新10個Rust format tests、3個binary cases：全檔/頁面count分離、first/fork/legacy/
  paginated/unknown、Unicode/depth/label/JSON/number、poisoning、未選頁壞紀錄，以及
  before/between/after × file append／mode／index replacement的9個拒絕組合。
- 新4個Node tests（同檔共13）：exact v11/proof/version、v10不可升級、actualclose前
  不settle、safe errors與同helper恢復、取消unknown-close隔離v10/v11，不盲重試。
- 真 release Node→Rust gate：**46組**與現有raw parser差分比對；rich／blank／fork
  全頁拼接逐byte相同。**16,858,235 bytes／16,384筆**的first／middle50／last／EOF
  每次都驗全來源；第10000筆破壞時第一頁不回partial，修復後恢復，合法頁外變動亦失效。
  v10仍可觀察那些opaque bytes但不能冒充v11 proof；舊8MiB拒絕保持。
  63child spawn/reap、max1、remaining0、1owned目錄清理；不是Host大檔或RSS測量。
- 舊v10實際20child/1dir與原Host39raw＋23structured/3turns、Host/writer reaped／
  2dirs清理回歸通過。它們不是v11已接Host或完整native projection的證據。

本機最後 Rust **29 library／44 binary／10 format／15 scanner**與all-targets通；完整及
最低Node22.19各**1032 total／1030 pass／2 skip／0 fail**。Clippy warnings-as-errors、
generated client/protocol、Ajv1251/version、actionlint/gitleaks0均通。
Logs prefix `/tmp/stepsemble-validated-source-*`：`rust-final.log`／`clippy-fixed.log`、
`full-fixed.tap`／`minimum-final.tap`、`owned-{first,second}.log`、`host-regression.log`、
`v10-regression.log`。第二輪真v11 gate相同63children/1dir全清，不當其他機器證據。

## 同輪定位的既有 PTY 測試競態

第一次全套的 `agent-connectors.test.js` 第3項真失敗，收到 `hello from cli` 後就stop，
卻要求另一個尚未輸出的 `stdin=tty` 必定存在。測試把非空output當作兩次write都完成，
不是證實產品遺失已送出的資料。

owned fake agent第二段刻意延後400ms，舊等待邏輯穩定重現同錯誤（`pty-race-before.tap`）。
修為同原40×100ms上限等greeting與terminal probe兩者，再做disconnect-window stop；
單次輸出、concurrentstop/idempotency、actualprocess cleanup斷言全部保留。
同延後fixture修後通（`pty-race-after.tap`），完整1032項回歸通；不新增產品sleep/timeout/skip。
原全套failure保留 `full.tap`，修後 `full-fixed.tap`。最初Clippy只抓到test多餘clone，
改from_ref後通；誤用不存在的npm conformance script已按package正確指令重跑，非產品失敗。

## Exact CI 與下一步

工程5555a7e已提交/push；五組exact CI均success，下載的完整logs已核對：

| Workflow | 實際證據 |
| --- | --- |
| [一般 CI34314269500](https://github.com/seehow624/stepsemble/actions/runs/34314269500) | 三OS各1032項／0fail；Mac1030pass2skip、Linux1029/3、Win982/50，Ajv1251各通，延後PTY marker測試通 |
| [Reader34314269533](https://github.com/seehow624/stepsemble/actions/runs/34314269533) | 三OS13 wire／244 boundary／25 structure／10 compressed全通；Rust POSIX29lib/44bin、Win27/18，各10format/15scanner及五generic allocation workload通 |
| [Claude34314269463](https://github.com/seehow624/stepsemble/actions/runs/34314269463) | 三OS固定SDK／nativeVersion2.1.259唯讀owned契約通，modelCalls0；Windows私人source仍unsupported |
| [Codex34314269461](https://github.com/seehow624/stepsemble/actions/runs/34314269461) | 三OS固定0.153.4，49legacy turns/147items、50source-linked turns/219raw、17index/19SQLname cases，0model endpoint/0loaded threads，原11檔不變及cleanup；原native projection/paginated缺口不變 |
| [雙版本browser34314269565](https://github.com/seehow624/stepsemble/actions/runs/34314269565) | Mac/Linux各24原case＋6Codex三尺寸明暗全通，保留完整可讀/raw／跨頁工具／回退／冷壓縮回歸；不是v11大檔Web或真機驗收 |

Reader中的新v11 gate在Mac/Linux各46差分／16,858,235bytes／16,384筆，63child
spawn/reap／remaining0／1dir清理；Windows是真binary v11 unsupported，1child/1dir，
不是大檔／POSIX來源成功。原v10各20child/1dir與POSIX真Host39raw＋23structured／3turns、
Host/writer reaped及2dirs清理通；locked RustSec0known/0warnings、lockfile aa93d9f4…不變。
Logs `/tmp/stepsemble-validated-source-ci-{general,reader,claude,codex,rolling}.log`；工程
watch與下載、所有本機owned程序皆已terminal，沒有本批工程CI待等項。

下一段必須把新receipt接進**page-aware受限parser與原生名稱解析、跨頁turn/tool/rollback
結構**，再接相同shared2reader／SQLA-rolloutA-parser-SQLB-rolloutB sourceVersion及
revocation、registry/typedHTTP/peer/Web。不能把只讀一頁的parser當作已重驗全来源。
需要真大檔Host/Web/RSS/混合負載/手機與release gates；C2/C6/C8仍未完成，C3–C7亦繼續。
