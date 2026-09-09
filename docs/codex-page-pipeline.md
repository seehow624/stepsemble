# 大型歷史：受限分頁解析與共用名稱管線

2026-09-09／Plan1.73；工程 `40d2b43dba9ed9c01eef3f05e269137303953463`。
接續 [v11 全來源格式驗證](codex-validated-source.md)。本段已實作並跑過真程序，
**不是大型歷史已接 registry／HTTP／Web，也不是 C2 或整體 Web 完成**。
正式3.0.6、開發3.0.7-rc.7、B+ logo、私人來源／讀者／帳號與部署關卡不變。
獨立72h未查未改，不將其結果移到新 SHA。

## 這次完成

既有 `history-pipeline.js` 新增 `readPage()` 和 `readNamedPage()`；兩者沿用原本
兩個 helper slot、共享 Host admission、AbortSignal、10秒期限、actual-close與
unknown-close quarantine，沒有第二套 runner、隱藏 queue 或失敗自動重試。

`readNamedPage()` 保留五階段：SQLite A → v11 rollout A → 受限 parser →
SQLite B → v11 rollout B。一個 permit 持有到所有實體程序收尾；兩次全來源版本與
SQLite名稱／preview／path版本都匹配才回覆。這是前後匹配，不是跨檔原子 snapshot。

私有 parser v7/v8 只傳選定頁 bytes＋固定 name index；不把單頁偽裝成全檔 snapshot。
v7 為 raw page；v8 同時重用既有 SQLite／index 名稱規則。全檔 digest／recordCount／
identity 與 `codex_legacy_envelope_v1` receipt 來自 trusted helper，並非由單頁推導。
原生名稱依選定 thread 與全檔 metadata receipt，即使 metadata 不在當前頁也可解析。

| 私有種類 | 用途 |
| --- | --- |
| `codex_parsed_page_capture` | 受限解析後的單頁與 index observation |
| `codex_named_page_capture` | 通過前後雙來源版本核對的名稱＋單頁 |
| `codex_named_page_source_version` | page-independent 的完整 history＋SQLite版本 |
| `codex_validated_rollout_records` | `one_legacy_rollout_validated_page` 原文頁面 |

v10 opaque receipt、舊 parser1–6、舊 named version不能相互升級／降級。
`sameNamedVersion(a,b,true)` 明確選新版本；預設仍只接受舊版。
`structured:true` 在新分頁管線明示拒絕，不能把單頁推出全域 turn/tool/rollback圖。
沒有擴大現有 public DTO 的8MiB／8192筆限制；小型與壓縮來源仍走原本已驗路徑。
Windows來源仍明示 unsupported；新分頁只處理 legacy plain JSONL。

頁內逐筆重驗 UTF8／JSON envelope／metadata關係，保留原文、CRLF、blank、fork和未知
事件，不執行 transcript裡的命令／URL／附件。輸入最多50筆／256KiB，raw JSON輸出
仍272KiB、總response416KiB；若字串escaping使頁面變大，只推進實際回傳的prefix，
單筆無法容納就明示錯誤。Host另外核對完整版本、descriptor、原文和實際cursor。
parser讀取白名單只加兩個程式碼檔案，沒有開放任何資料目錄、寫入或child權限。

`sourceAuthenticated`／`publishable`／`semanticHistoryComplete`及名稱authority仍false。
使用 OpenAI Docs 維持[讀取 stored thread 與 resume 分離](https://learn.chatgpt.com/docs/app-server#read-a-stored-thread-without-resuming)
的界線；並非啟動真人 native session，固定0.153.4的投影差異仍保留。

## 本機證據

OneStep-MacMini；全部 owned fixtures，不讀私人歷史、不登入、不呼叫模型。

- 新10個page parser＋5個管線測試；新parser及整個named測試共34項通過。
  包括所有頁拼接／EOF、頁外metadata名稱、名稱fallback／preview抑制／不匹配、
  9,001筆來源／offset8500、strict framing／getter／shared-memory拒絕、v10防升級、
  leading blank／fork／unknown、escaping budget可續頁、actual restricted worker。
  五階段取消、unknown-close隔離、兩reader共享與前後／expected versions皆驗。
- 完整及最低Node22.19各 **1047 total／1045 pass／2 skip／0 fail**。
  generated client／protocol、Ajv1251、version、actionlint、gitleaks0通過。
  Rust產品未改；真程序使用已驗5555a7e debug helper，不冒稱本輪本機重跑Rust全套。
- 真 Node→Rust→permissioned parser v8兩輪：**16,858,235 bytes／16,384筆**；
  first1／middle50／last2／EOF，原名一致、全檔版本不隨頁改、原文與byteOffset準確。
  第10000筆壞掉，第一頁也拒絕；修復後恢復。合法頁外變動、SQL rename／preview／
  path和name-index變動，在前後或expected版本檢查拒絕。真Claude SDK peer共用admission，
  第三個reader不啟動，五階段真取消均清理；舊8MiB路徑仍明確拒絕大檔。
- 新大檔段每輪 **84 reader/parser spawns、max2、remaining0**；整個Codex複合gate
  每輪274 spawns，原fixture還原，writer已退出並移除1owned目錄，外層cleanup通過。
  一頁最大51,450bytes，未傳整個16.9MB rollout給Node parser。
- 兩輪debug管線最慢單次3.18／5.68秒，主event-loop最大sample gap約3.53／9.03ms；
  第二輪有其他完整測試同時跑。這是owned pipeline樣本，不是Host/Web、RSS、跨平台
  或最大256MiB檔案的效能驗收。期限未放寬；大型歷史仍須產品端量測。

Logs `/tmp/stepsemble-page-pipeline-{focused.tap,full-final.tap,minimum-final.tap,
owned-first.log,owned-second.log}`。初次page parser測試有一個mutation使用
`replace("event",...)`，但選中原文是response_item，實際沒修改任何字；該negative fixture
改為確實改字後通過，沒有因此放寬產品驗證。原log `page-parser-first.tap`保留。

## CI 與接續

工程已commit/push；四組exact CI全部success，完整logs已核對：

| Workflow | 結果 |
| --- | --- |
| [一般34316385458](https://github.com/seehow624/stepsemble/actions/runs/34316385458) | 三OS各1047項／0fail；Mac1045pass2skip、Linux1044/3、Windows997/50 |
| [Reader34316385560](https://github.com/seehow624/stepsemble/actions/runs/34316385560) | 三OS23 wire/page＋249 boundary＋25 structure＋10 compressed全通；POSIX真大檔named page每OS84spawns/max2/remaining0，所有五階段取消／版本／cleanup通 |
| [Codex34316385505](https://github.com/seehow624/stepsemble/actions/runs/34316385505) | 三OS固定0.153.4，49legacy turns/147items、17index/19SQLnamecases、0model endpoint/0loaded threads，來源不變與cleanup通 |
| [Rolling34316385502](https://github.com/seehow624/stepsemble/actions/runs/34316385502) | Mac/Linux各24原cases＋6Codex三尺寸明暗全通，每OS6個獨立cleanup回執；仍不是本新大檔Web接線證據 |

Reader同時重跑原Rust全套：POSIX29lib/44bin，Windows27/18，各10format/15scanner，
原generated allocation、v10及v11全來源gate通；既有真Host39raw＋23structure/3turns、
兩owned目錄與Host/writer清理通，非大檔Host。Windows新named-page來源仍明示unsupported，
0reader spawns；parser合成bytes測試通不代表Windows source已支援。
CI的新大檔debug單次最慢Mac5.35秒／Linux3.16秒，主loop最大sample gap28.84／11.23ms；
同樣不能當Web/RSS或全檔上限效能承諾。本輪未觸發獨立Claude workflow，不冒稱已重跑；
reader內仍含真固定SDK／共用Claude peer。Logs `/tmp/stepsemble-page-pipeline-ci-{general,reader,codex,rolling}.log`。
全部本機owned程序、工程CI watch與logs下載均已terminal；沒有本工程批待等項。

下一段直接接 **實際產品鏈**，不重做已驗scanner／format／page parser：

1. `history-source-service.js`目前只呼叫舊readNamed，將新page/profile接入同binding／
   generation／revocation／opaque sourceVersion token；版本模式不可互相誤用。
   小型壓縮／paginated metadata讀取仍保留，不能為支援大檔全面改成plain-only。
2. 跨頁turn/tool/rollback需要有界的全來源結構觀察；不能把新raw page掛上舊8192筆
   全檔snapshot、猜turn總數或只藏起unsupported。原native semantic缺口仍明示。
3. registry／typed HTTP與peer協定／Web，以新profile明确區分能力並覆蓋舊client拒絕，
   實驗證名稱、超過8192筆翻頁、跨頁工具、改名／追加／rollback、取消及disconnect。
   TypeScript來源是 `client/codex-history-records.ts`／`history-transport.ts`／
   `codex-history-view.ts`；public/modules為generated產物，使用既有build/check流程。
4. 真owned Host的大檔／RSS／event loop、320/390px操作與完整長文、故障及恢復验收。
   原HTTP／browser回歸不當成本新分頁已接Web的證據。
5. 繼續[C1–C8](web-completion-loop.md)其他harness與發布關卡；仍不是只剩72h。
