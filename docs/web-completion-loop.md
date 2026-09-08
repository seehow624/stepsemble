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

「待完成」不表示從零開始；沿用主計畫已驗模組，只補缺口。

| Checkpoint | 交付與必要證據 | 開始狀態 |
| --- | --- | --- |
| C1 來源到可用清單 | source-group 一次 opt-in／readers scope；inventory 與內容共用有界 admission；動態來源撤銷、增改刪、catalog 分頁；正確 native title/metadata；actual Host→Web 按需讀取 | Plan1.53已接來源選擇/50列paging/可見名稱/完整原文及manual fallback；真Host合成CUA已驗，owner opt-in體驗/實機與完整gate仍待，C1未完成 |
| C2 各 Agent 原生歷史 | 各自固定版本 API／格式、native ID/name、主／subagent 範圍、完整歷史與原生名稱驗證；未知版本／來源有清楚狀態 | Plan1.54新增Codex受限read RPC／真CLI合成legacy歷史；items/list與paginated gap已確認，來源隔離/Host/Web/rich mapping及其他adapter仍待，C2未完成 |
| C3 Session／approval／恢復 | 按真實 capability 接結構化事件、續跑與 approval；ownership、exact correlation、重送／重連／Host crash、durable journal/replay 不漏不重 | 有 contract 與局部實作，未全驗 |
| C4 帳號與故障體驗 | 登入／登出偵測、官方登入入口、路由相容、取消／失敗／stale／busy 可復原；不修寫第三方憑證或以重試消耗模型 | 局部已驗，跨 harness 待補 |
| C5 手機與跨裝置操作 | 完整 history i18n、鍵盤／focus／內捲動、長歷史 DOM 上限、Host 切換、background/reconnect、跨機與目標瀏覽器實測 | 桌面與手機尺寸部分已驗，實機待補 |
| C6 可靠性與效能 | 保存完整失敗診斷；調查曾發生的未定位測試失敗；同 workload 多輪 before/after、記憶體、長串流與斷線驗證 | 現有短測與 baseline 已有，驗收未完成 |
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

- **2026-09-08／C2 Codex讀取邊界，Plan1.54／rc.6不變**：10個補充schema固定、
  獨立read-only RPC與真0.153.4 owned-home runner；cli/vscode/exec/appServer/
  subAgent review/unknown、主/封存分頁及7個legacy對話49turns/147items/原生名稱
  已驗，loaded0/model endpoint0/10原檔不變/actual cleanup確認。不是全adapter：
  items/list有schema卻native -32601，paginated JSONL-only缺name/store projection。
  下一步補owned store／capture／rich mapping及同Host接線，不能直讀私人Codex HOME。
  官方文件只作介面參照，以固定CLI實測為準；詳[codex-history-compatibility.md](codex-history-compatibility.md)。
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
