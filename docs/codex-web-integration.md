# Codex 來源群組到 Web：已驗證的原始紀錄增量

2026-09-09，Plan 1.69；起始基線 `0eb7e3362a433cb960d53ab0e26ad68530d06ac3`。
**本增量與相應 CI 已驗，尚未部署；C1–C8 整體未完成**。本輪驗收涵蓋 source
settings → grants → discovery → binding/registry → HTTP → Web，不是僅新增reader。
主要工程`2fe48d03eeeb8a38e9c2bf4e0a68e5cc5b25b082`；最後工程與空清單／fixture
清理補強`c57747f4c34f34a1730098dd00a3bd43c275d917`，exact CI見下。

## 已選定的方向

- 以固定 Codex 0.153.4 SQLite `threads` 的 ID 與目前 `rollout_path` 為清單依據；
  同一個 thread 可留下多個 rollout，不能靠掃檔名選出目前歷史。
- catalog 代表「這份 state DB 儲存的全部 rows」，包括 archived、subagent、空 preview；
  不冒充原生 `thread/list` 的篩選結果。未知 source 保留並標示，不默默省略。
- SQLite root 與 Codex root 分開明確授權，前者的路徑欄位只是惰性資料；真正開檔仍需
  經後者的 containment、root identity、FD/ACL 和既有 v3 locator 檢查。
- 根據[官方 App Server 文件](https://learn.chatgpt.com/docs/app-server)，唯讀
  `thread/read` 不等於 resume；paginated 完整歷史目前的 unsupported 邊界保留。
  本輪不啟動私人 native app-server、不修復私人資料庫、不登入、不消耗模型。
- 沿用已驗 readNamed 的雙來源前後版本檢查，同一 Host admission 與 64 個 registry slots；
  不因新增 harness/group 而乘出額外讀取名額。

## 本增量驗收範圍（已執行）

1. v6 root-only catalog：固定欄位、唯讀短交易、2048 rows／2 MiB 上限，超限明示，
   不截斷為「全部」。需實測最大正常容量、VM/time budget、並行 commit、取消與 actual close。
2. Rust wire、嚴格 Node wire/helper、owned writer 實際跨程序測試；v4/v5 不擴權。
3. Codex source index 與 binding service，共用 admission/registry；reader revoke、root identity
   改變、selected rollout 改變、catalog snapshot 過期皆須撤銷舊發布權。
4. 明確雙 root／readers 的 owner 設定與 review，不推測私人 HOME，不建立真實 grant。
5. HTTP 和 typed Client 的 Codex 群組、名稱、分頁與內容接線；不要把 raw JSON 當成
   「與原生客戶端一樣完整」。缺項與未支援能力要可理解且可查原始紀錄。
6. 合成 Host + 真 owned reader + Web 案例驗授權隔離、取消、名稱/內容更新、手機捲動、
   混合 harness 的共享資源上限、舊 Claude 相容。完成後才記錄 exact SHA CI 證據。

## 實作範圍

以下先保存本機實作／驗收，再列08:16 MYT已核對的exact CI；不冒稱正式發布或真機驗收。

- Rust v6 已新增 root-only catalog 與 shared prepared source 泛型，原 v4/v5 形狀及
  欄位 allowlist 不變。catalog 單獨 64,000 VM steps，原單筆仍 20,000；兩者都保留
  250 ms 交易期限，來源仍 8 MiB／1024 reads。2 MiB 編碼上限也限制累積保留資料。
- 嚴格 Node v6 frame/helper、共用 admission 的 catalog pipeline、Codex source index
  已加入。catalogId 按群組與 native ID 穩定；選定 rollout／row metadata／DB 檔案
  身分改變會換 revision。安全路徑無法選定的 row 不刪掉，保留 unavailable。
  archived、subagent、internal、unknown、paginated rows 都保留；沒有推測 parent graph。
- index 提供 50 列／snapshot 分頁，失敗保留 stale 清單；撤銷、取消、關閉、晚回覆
  有測試。Host 共用兩讀取名額，清理不明隔離。投影每 32 rows 讓出主執行緒，
  每次回來和最終發布前重驗權限；shutdown 等待投影結束。
- 新 Codex binding service／嚴格 union normalizer／dispatcher 接在**同一個64槽registry**。
  index、名稱、內容共用 Host 的兩讀取名額；舊 Claude 預設與272KiB回覆限額不變。
  新 Codex384KiB回覆只接受固定原始紀錄DTO，不能冒用Claude observation或擴成執行API。
  HTTP、typed Client、dedicated peer relay均驗binding/view/generation/session/page/version。
- 設定v3支援Codex stored_threads群組與明確兩root/readers，Codex-only不需ClaudeSDK。
  `node scripts/history-setup.mjs --agent codex --lang zh-Hant` 會review再要求`CREATE`；
  只建立新的0600設定，重驗兩root身分，不掃來源、不覆寫或自動啟用正式服務。
  v1/v2及原Claude精靈保持相容。真實根目錄及啟用仍需owner選定／正式部署關卡。
- Web按來源agentId選擇renderer：一頁10筆、只保留一頁，依實際byte-bounded nextOffset
  翻頁，原生名稱不翻譯／不拿摘要代替。原始JSON惰性展開且同頁只開一筆；未知／工具
  紀錄保留為惰性文字，無執行、附件下載或可點擊原始URL。11語chrome明示raw records
  不是完整native語義視圖；paginated未支援不當空對話成功。
- Apple Design指引促成原生內捲動／鍵盤focus／保留既有44px與reduced-motion規則；
  4000字元excerpt另限14rem、raw限20rem。實測發現閒置後租約過期點翻頁無回饋，
  已改成明確refresh提示並重繪控制狀態；不新增背景續讀或改變原生session。

## 第一段底層本機驗證與原失敗（保留）

- 首次容量測試：4 項中 3 過、1 失敗，2,048 rows 在舊 20,000 VM 預算提前 Budget。
  保留 `/tmp/stepsemble-codex-catalog-capacity-first.log`；改 catalog 專用有限預算後，
  2,048 完整通、2,049 明確 TooLarge，未降低容量或放寬單筆規則。
- 完整 Node **937：935 pass／2 既有 skip／0 fail**；最低 Node 22.19 相關 **79/79**。
  Rust library **27/27**、binary **30/30**、跨程序 owned 測試全通，新增 v6 真 SHM／
  wrong root／zero payload 案例。`--all-targets`、fmt、clippy `-D warnings` 通。
- npm check、Client/Protocol generated check、Ajv **1251**、actionlint、diff check、
  gitleaks（redact）通。未變 lockfile、版本或正式資產。
- 最低 Node 真 Rust／Claude SDK／Codex parser 的 owned 鏈 **兩輪通**；v6 段每輪
  9 reader/peer spawns、5 成功 catalog captures 都有真 SHM，max physical **2**、
  remaining **0**。實際 2,048 rows／41 頁、不重複、DB/WAL/SHM bytes 不變；
  2,049 保留上一份 stale snapshot；9 次含實際取消。共用的 test-only writer 最終
  actual close／自建目錄清除，沒有私人讀取、原生 Codex 啟動或模型呼叫。
- 第一輪同資料的 Host 主執行緒 gap **135.57／109.98 ms**，整次 **229.96／203.90 ms**。
  移除重複完整複製、固定欄位版本編碼及分批投影後，gap **18.29／16.25 ms**，
  整次 **153.71／144.34 ms**。只代表本機 owned workload 的兩次樣本，非手機 UI、
  Core Web Vitals、RSS 或跨平台驗收。讀取最高 **819,300 bytes／201 calls**，未提高 I/O 限額。
- 完整紀錄 `/tmp/stepsemble-codex-catalog-{actual-first,actual-optimized,rust-final,clippy-final,gitleaks}.log`、
  `...-npm-final.tap`、`...-min-node.tap`；所有本批工具程序已結束，不要重等舊 session ID。

OpenAI Docs 及固定 upstream SHA `3d2ee51ca2d5db578f328aa75e20aa22c0197c9a` 的
SessionSource serde／state enum_to_string 促成原始分類保留與不 resume 的邊界。
正式 3.0.6、B+ logo、帳號、私人來源及獨立固定 SHA 的 72h 長測皆未改動，也未在本輪重查。

## 第二段全鏈本機驗證與原失敗

- 完整 Node及最低Node22.19各 **965：963 pass／2既有skip／0 fail**；Rust library
  **27/27**、binary **30/30**、owned跨程序來源／對抗案例全通；fmt/clippy、語法、
  generated Client/Protocol、Ajv **1251**、actionlint、diff及redacted gitleaks通。
- 新binding/index/Host/typedHTTP/peer/UI/owner測試，含共用64槽、撤銷與晚回覆、
  清理不明隔離、取消序列化、舊generation、變長page、關閉後再開與原文惰性DOM。
- 最低Node實際 `server.js`＋未修改wizard設定＋pinned owned SQLite writer＋Rust reader
  ＋Codex parser／typedHTTP全鏈通；39筆含CRLF、工具call/output和未知record均到齊。
  WAL改名立即失效舊sourceVersion；新名稱、paginated明示unsupported、unsafe locator
  保留清單但不開檔、reset後恢復均通。Host及writer實際退出，兩owned目錄清除，
  DB/WAL/SHM/rollout/index除明確fixture mutation外bytes不變；不需ClaudeSDK。
- CUA實際Host於390/320px：原生名稱與內容、上一頁／下一頁、原始JSON展開、
  無橫向溢位。長excerpt內捲 **0→196px、outer1597px不變**；320px原始紀錄13187
  字元在320px高區塊內，沒有一次鋪滿。paginated更新後顯示明確錯誤／0假成功record；
  console error/warn空。這不是實體手機、light/dark全矩陣或Core Web Vitals證據。
  最新修正版另實測閒置151秒再按翻頁：原頁保留、顯示「請先重新整理，再繼續翻頁」、
  下一頁disabled；重新整理後成功讀到第11–20筆。全部隔離Host/writer及CUA頁面已關閉，
  viewport還原、owned目錄清除；沒有留下本批背景測試程序。
- 已新增CI-only三尺寸×明暗真Codex Host瀏覽器案例，含11語不重讀、工具／未知頁、
  版本變更、格式拒絕、空清單及關閉恢復；本機不繞過CUA執行Playwright。CI結果見下。
- 保留首輪失敗：Host測試同root同identity本應合法，改測同root不同identity；HTTP
  union初版擴到舊Claudeoffset2001，已用Codex-enabled gate恢復舊限制；VM漏load
  CodexDTO依賴已修HTML/VM順序。新actualHost CLI首次漏傳必要signal欄位的request
  被嚴格拒絕，修測試後全通。未降低原斷言；所有失敗logs保留。
- 全鏈logs `/tmp/stepsemble-codex-{full-final,web-min-node-final}.tap`、
  `/tmp/stepsemble-codex-{actual-host-first,actual-host-second,web-rust-final,web-clippy-final,web-check,web-gitleaks}.log`。
  UI與owner `/tmp/stepsemble-codex-{ui-scroll,expiry,view-owner-first}.tap`；HTTP
  `/tmp/stepsemble-codex-http-{first,second}.tap`。空清單補強後完整965/0fail/2skip、
  generated與最低Node真Host（含啟動衝突後清理）再次通；logs
  `/tmp/stepsemble-codex-empty-final-suite.tap`、`/tmp/stepsemble-codex-actual-host-empty-cleanup.log`。

## Exact CI 證據（2026-09-09 08:16 MYT）

主要工程 **2fe48d0** 的五組全部success，完整logs已保存／核對：

- [一般CI34293643993](https://github.com/seehow624/stepsemble/actions/runs/34293643993)：
  三OS各965，Mac963pass/2skip、Linux962/3、Win915/50，fail皆0；各Ajv1251。
- [reader34293643961](https://github.com/seehow624/stepsemble/actions/runs/34293643961)：
  三OS Node reader226/226；Rust27lib、POSIX30bin／Win15bin，all-targets／fmt／clippy通。
  POSIX真CodexHost39筆／cleanup；v6 catalog真2048／41頁、超限stale、共用max2與
  actual-close通。Windows的私人來源／新Host gate仍unsupported或明示skip，不當支援成功。
  RustSec鎖定audit為0已知漏洞／0警告。
- [rolling34293643946](https://github.com/seehow624/stepsemble/actions/runs/34293643946)：
  Mac/Linux既有rolling／帳號／session／picker／catalog／Claude source與新增Codex
  1440/390/320×light/dark六案例全部通，每頁10筆／原文inert／11語不重讀／版本更新
  ／paginated提示／close-reopen；不是Windows瀏覽器、實體手機或正式來源的驗收。
- [原生Codex34293644095](https://github.com/seehow624/stepsemble/actions/runs/34293644095)、
  [Claude34293643991](https://github.com/seehow624/stepsemble/actions/runs/34293643991)：
  三OS固定版本契約通；Codex17index案例、19read／18list名稱優先級、0model endpoint／
  loaded0／private0／actual cleanup；Claude原SDK來源能力的POSIX／Windows邊界保持。

收尾工程 **c57747f** 的三組相應CI也全部success，full logs已核：

- [一般34294010688](https://github.com/seehow624/stepsemble/actions/runs/34294010688)：
  同上三OS965／0fail與skip分布，無縮減測試。
- [reader34294010681](https://github.com/seehow624/stepsemble/actions/runs/34294010681)：
  226/226與Rust/audit照常；POSIX新增`emptyCatalog:true`、`startupFailureCleanup:true`
  真Host gate通，沒有測試子程序因啟動失败殘留。
- [rolling34294010665](https://github.com/seehow624/stepsemble/actions/runs/34294010665)：
  兩OS全部通，新增空Codex清單文案／沒有假主對話範圍、12個Codex明暗／尺寸組合通。
  收尾只改文案及owned測試，原生Codex／Claude workflow未另觸發，不能說此SHA重跑五組。

完整logs在 `/tmp/stepsemble-codex-web-ci-{main,reader,browser}-{first,final}.log`
（第一輪main／reader無`-first`尾碼）、`...-native-codex.log`、`...-native-claude.log`。
所有下載／watch本機程序皆已結束；不用再重等舊session。

## 下一輪仍需完成（整體 goal 保持 active）

1. Plan1.70已完成cold SQLite到Host/Web及五CI驗收，見[冷資料庫全鏈](codex-cold-sqlite.md)。
   接著compressed rollout等來源可用性；不能讓reader修復來源或啟動原生工作。
2. 補齊完整native語義projection／其他adapter；不把raw reader算C2完成。
3. 依C1–C8清單接續真capability的session、approval、resume、跨裝置與可靠性驗收；
   私人root、帳號／模型用量、正式部署／active-work保護關卡依原計畫，不跨越。
