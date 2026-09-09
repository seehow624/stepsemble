# 2026-09-09 Stepsemble 大總結與發布審查

狀態：**72h已核對通過；RC發布保護已通CI，Pi／New Project修正已通本機與CUA驗收，待本輪必要CI。候選未升為 stable，沒有部署或重新授權私人來源。**

**本輪阻擋問題**：Pi＋worktree回原生`sid`卻被Web當generic task，造成假的Failed；
HOME不在browse roots內時New Project卡住；root chooser本身可誤當專案；managed
worktree在授權範圍外仍先建立。修正保持原生Pi連線，收緊新建目錄邊界，不新增檔案授權。
本輪必要CI與實際操作驗收完成前，不可發布候選為正式版。

本文件是今晚的單一收尾入口。功能實作與證據截至產品工程
`1b37173e8e8569e3c0bb18d807bff5ab20ff7a67`、browser runner 修正
`2beab6853497da210edc645200a1144095e31618`；發布分流保護與72h總結已提交
`df713033192d6b8ae916f7deb7694deb45400383`並通必要CI。Pi／資料夾修正另行驗證。
主計畫的歷史 checkpoint 不再當作現行待辦；完整未完成範圍仍以
[C1–C8](web-completion-loop.md)為準，不縮小原定產品目標。

Jerome要求馬來西亞時間19:34長測結束後大總結及製作最終版本；已核對真實passed
報告並結束原追蹤，沒有只按時鐘判成功。總結不抹掉實際剩餘工程與正式上線關卡。

## 版本與交付判定

| 層次 | 目前能確認什麼 |
| --- | --- |
| GitHub 正式版 | `v3.0.6`，tag source `331b9f0`；本輪只讀 API 核對，沒有更改 Release |
| 已安裝正式版 | Mini／MacBook Pro 最後已確認均為3.0.6；本輪未重啟、未重新量測兩台健康，不冒稱新的部署驗收 |
| 開發候選 | `3.0.7-rc.7`；程式已推 master，不等於發布資產或任何電腦已自動更新 |
| 候選／新正式 tag | 審查時`v3.0.7-rc.7`與`v3.0.7`均未建立；不以改版本號代替發布門檻 |
| 72h 範圍 | 僅隔離的rc.1／固定ab227af來源，不包括後來的B+、原生歷史與本輪發布修正 |

因此即使原72h通過，也只能關閉**該固定工作負載的長測門檻**，不能宣稱rc.7已通過
72h，或Claude／Codex等已具有完整原生客戶端能力。今晚可完成有證據的總結與候選
發布準備；未通門檻必須繼續工程或取得owner操作，不能假稱「全部最終完成」。

## 這段期間真正完成的產品能力

- **品牌與辨識**：保留已確認B+向量母版，藍紫連接與白色模組採同一幾何旋轉；
  一般／maskable／favicon分開。對話列表、Hub與標題有Pi、Claude、Codex、OpenCode、
  Grok標誌；模型不冒充Agent，GPT圖示映射不表示新增GPT connector。
- **統一清單**：既有Pi原生對話和Stepsemble工作可按來源區分，保持原生名稱與
  工作生命週期分離；新來源採owner opt-in、分頁與按需讀取，不偷偷掃描所有HOME。
- **Claude唯讀歷史**：固定官方SDK、隔離reader、原文／名稱、受限分頁、工具等歷史
  內容已接實際Host與Web；來源變更／撤銷／忙碌有明確恢復，不代表approval或resume。
- **Codex唯讀歷史**：SQLite原名優先序、熱／冷DB、小型plain／壓縮、大型plain已接
  Host／peer／Web；17.2MB、16384筆驗證保留原生ID、全來源回合、rollback、工具跨頁往返
  及raw原文。未知紀錄不執行；不支援的官方paginated／native投影明示限制。
- **介面與取消**：320／390px、有限DOM、長文內捲動、多語切換保留focus／scroll；
  修復切換模式及取消後Refresh早於Host實際清理所造成的busy／Failed競態。
- **資源邊界**：同Host兩reader共用預算，包含inventory與Claude／Codex內容；
  actual close後才釋放，未確認清理保留隔離，不靠自動重試增加程序或模型用量。

這些是已實作、按列出範圍驗證的**候選能力**，不是宣稱已部署到正式使用中的兩台。
品牌證據見[B+](brand-refresh-3.0.7-rc.2.md)，功能證據見
[Codex結構接線](codex-structured-source.md)、[Claude接線](history-host-integration.md)。

## 已核對的CI及失敗原因

| 工作流／確切來源 | 結果與範圍 |
| --- | --- |
| [CI34347125342](https://github.com/seehow624/stepsemble/actions/runs/34347125342)／df713033 | 發布分流／總結提交：三OS各1090tests、0fail；Mac1088pass/2skip、Linux1087/3、Windows1039/51；Ajv1251。Windows實跑CLI，fake bash案例明確skip |
| [CI34344004839](https://github.com/seehow624/stepsemble/actions/runs/34344004839)／2beab685 | 三OS各1086 tests、0fail；Mac1084pass/2skip、Linux1083/3、Windows1036/50；Ajv1251 |
| [Rolling34344004874](https://github.com/seehow624/stepsemble/actions/runs/34344004874)／2beab685 | macOS/Linux各24既有＋6Codex案例、1440/390/320×明暗、pageErrors0；實際release helper與cleanup均核 |
| [Claude34342859660](https://github.com/seehow624/stepsemble/actions/runs/34342859660)／1b37173 | 固定SDK0.3.259／CLI2.1.259合成歷史、禁止spawn/write；非真模型／私人來源 |
| [Codex34342859706](https://github.com/seehow624/stepsemble/actions/runs/34342859706)／1b37173 | 固定0.153.4自建原生來源、147items/50turns/219raw及名稱案例；保持projection不完整／paginated unsupported |
| [Reader34342859653](https://github.com/seehow624/stepsemble/actions/runs/34342859653)／1b37173 | 真POSIX reader→parser→Host/shared Claude、107個新結構child包含五階段取消；Windows私人來源仍unsupported |

2be只改測試runner政策及相應測試／文件，三native workflow未觸發，故明確沿用
未變產品的1b證據，**不冒稱它們在2be重跑**。本機完整及最低Node22.19各1086/0fail；
Rust來源、typed/generated、Ajv、版本、actionlint與秘密掃描另有已保存證據。

GitHub通知中，本輪確有[原rolling34342859676失敗](https://github.com/seehow624/stepsemble/actions/runs/34342859676)：
Linux全通，macOS前五個Codex案例通，第六個碰到整組300秒期限。工作流用了Debug
reader；改為相同固定工具鏈的Release建置後兩OS全通。沒有加長期限、刪案例或重試
掩蓋問題；原完整失敗logs仍保留。這是CI測試環境問題，不能據此宣稱正式服務出錯。

本機兩輪相同17.2MB/18reads量測：最大request255.5／253.5ms、health p95
2.23／2.30ms；200ms取樣Host RSS最大103.6／101.7MB。這不是峰值、A/B改善、
256MiB最大來源、SMB或混合負載容量驗收，不用它保證所有操作不卡。

## 長測通過門檻

**實際終態：passed，2026-09-09 19:34:16 MYT完成。** 連續觀察259200335ms、
8554輪／68432ACK、8tasks×2clients，214次正常／213次強制HTTP Host重啟。
cleanupConfirmed=true、controller已退出、owned home已移除；76個凍結來源hash
與兩個指定commit一致，runner／peer亦相符。完整報告及凍結source仍保留本機，
[去識別摘要](baselines/reliability-soak-72h-2026-09-09.json)保存終態與報告SHA256。
以下門檻已逐項核對，不再列為等候中的測試；它們仍只適用固定rc.1工作負載。
結果已保存並告知Jerome，原每小時追蹤已透過產品工具刪除；未封存開發任務。

- 固定 source `ab227af7e12edd7a9182d700ce052dfaf92a34b4`，runtime 與
  `2b7f0b652634a30cb546aceb27339cdad140efc0` 相同，不重建／換 SHA／套用新版本。
- `status=passed`、`continuousObservedMs >= 259200000`、`cleanupConfirmed=true`。
- 8 tasks、每個2 clients、acknowledgementsVerified = cycles×8；正常及強制 Host
  重啟都有記錄。報告遺失／過時／意外中斷不能宣告成功，不憑持久 PID 停止程序。
- 將去識別結果與限制寫回[長測文件](session-discovery-and-soak.md)、主計畫、vault；
  保留報告及失敗診斷，不影響正式服務或其他工作。

## 大總結與版本準備

| 項目 | 必須核對 |
| --- | --- |
| 已上線與候選 | 正式3.0.6、候選確切提交／版本分開；B+保留 |
| 實際功能 | 按[C1–C8](web-completion-loop.md)列使用者可操作成果；核心完成不等於Web已接 |
| GitHub | exact SHA必要CI；保留macOS aggregate timeout等原失敗與修復證據 |
| 可靠性 | 每項測試來源／workload；舊72h不算新版本通過72h |
| 發布判定 | 阻擋缺陷及必要gates處理完才release-ready，否則明列剩餘，不為趕時間跳過 |
| 回滾 | 版本校驗、安裝／資料備份、回滾步驟、部署前active-work檢查 |
| 正式上線 | 依既有owner確認；私人roots/readers、登入／路由／真模型用量不越權 |

### 發布前仍需完成的實際事項

本輪Pi／目錄修正的已驗範圍：

- Pi worktree只開一次，原生sid／SSE與generic task分流；名稱、draft、Changes使用
  canonical worktree cwd。重複Start合併、舊Host／取消的late response不附著新畫面；
  只對新建且idle的原生session請求關閉，不刪可能有資料的worktree。
- 空browse只選允許的HOME或首個有效explicit root；明確`~`、外部目錄仍拒絕。
  root chooser只列允許目錄且不可Start，載入新目錄時清空舊選擇；舊Host沒有新增
  `selectable`欄位時仍保守辨認root bridge，不破壞瀏覽協定。
- 新Pi cwd套同projectDirectory，啟動前重新核對；既有file resume政策不變。
  managed worktree只有安全存在的authority才可建立missing descendant；拒絕時在
  mkdir／Git worktree add前停止，不自行新增root或宣稱此為完整FD race-proof隔離。
- 最後完整／最低Node22.19各1098tests、1096pass／2skip／0fail；typed/generated、
  Ajv1251、版本、syntax與actionlint通。首次完整測試兩Node各有一個舊source-pattern
  smoke assertion仍強制APP_HOME，已更新為allowed-default契約；保留原失敗logs。
- 最後owned CUA320/390px：HOME不許可、只允許repo與managed root，初始root／
  navigation-only chooser、原名／新cwd／Changes clean branch均通，無橫向溢出，
  dev logs空。離開後clients=0，再對owned idle sid明確close；PID退出且Hub為Stopped。
  沒有發送模型prompt；所有本次owned Host／目錄／viewport／分頁已清理。
- 新browser CI案例保留全部舊Pi名稱／history／143 close／reload驗收，新增1440/390
  的root chooser與Pi工作樹／native SSE／Changes cwd／原件不變／cleanup gate。
  本機未另用Playwright操控GUI；這些新增自動案例須以GitHub實際結果為準。

1. **發布通道保護**：本輪審查發現原workflow會對所有`v*` tag直接建立普通Release，
   沒有RC分流。已補canonical tag/package精確比對；prerelease加`--prerelease
   --latest=false`，未知分類立即拒絕。4個focused測試涵蓋實際CLI／空格路徑、
   非法版本／尾換行／numeric identifier、隔離fake gh的完整資產與旗標、注入與
   fail-closed；actionlint與df713033三OS必要CI通。沒有建立tag／Release或切換更新來源。
2. **候選驗收**：逐變更核對必要CI；若發行新的runtime，按變動風險補自己的穩定性
   證據。不得將固定rc.1的72h貼到最新SHA。
3. **可安裝的來源功能**：需準備目標平台可信Rust reader／固定SDK，明確來源和
   reader scope，驗實際安裝/設定；目前不是installer自動探索私人原生歷史。
4. **正式變更關卡**：先owner確認目標版本、主機和來源；檢查active Pi/task/login，
   有工作不切換；保存程式與設定／資料備份，再按現有installer驗checksum與版本。
5. **部署／回滾驗收**：健康版本、原生history不變、既有對話、登入入口、手機與遠端
   操作均核對；失敗恢復舊程式/服務，不覆寫新產生的未知資料。installer rollback
   不等於已完成整個Host／native history的完整備份還原。

### 不應被今晚總結抹掉的未完成項

| 範圍 | 待完成而非從零重做 |
| --- | --- |
| C1 | 多來源群組安全編輯／管理、真人owner設定與實際裝置驗收 |
| C2 | 大型壓縮、Codex官方paginated／完整投影、OpenCode／Grok等其他原生history adapters；不能承諾全電腦對話已收錄 |
| C3 | 各harness真session／approval ACK／resume、ownership、durable journal與crash/replay完整證據 |
| C4 | 跨harness登入／路由／錯誤恢復；不修寫第三方憑證、不拿訂閱額度自動重試 |
| C5 | 真iPhone/Safari/PWA背景恢復、網路斷線、跨Host與人工多語校稿 |
| C6 | 全Host峰值記憶體、最大來源及混合負載、多輪可比較的順滑度驗收 |
| C7 | Windows私人native reader、Windows Scheduled Task與Linux systemd真runner、Rust Host逐契約遷移 |
| C8 | 目標候選完整發布／回滾／裝置／owner上線關卡 |

語言方向不改：TypeScript供UI／Client，Rust逐步承擔Host Core；Swift／Kotlin只做
平台專屬能力。Web/PWA永久保留，先Apple客戶端、再其他平台，不因Rust讀取核心通過
就宣稱完整Host或App Store版本已存在。

合成terminal agents／loopback clients不驗證native history/approval/resume、durable journal、
exactly-once、真手機背景／斷線或完整Rust Host。原生各平台App仍按長期分期，不臨時上架。

原長測終態與追蹤已結案；後續直接處理本輪Pi／目錄修正的確切提交與CI，再按C1–C8
做實際產品工程與發布／回滾準備，不重查已完成的72h、不拿文件更新代替產品驗收。
需要owner操作則清楚列出，不封存開發任務。大型歷史證據見[v12來源](codex-structured-source.md)。
