# Stepsemble 3.0.7 發布清單與使用範圍

Jerome於2026-09-09要求結束一天多的持續擴充，整理成果並發布可供Mac Mini與
MacBook Pro更新的正式版。本次是**已驗增量的3.0.7正式更新**，不是宣稱C1–C8
長期計畫全部完成。正式發布以GitHub Release及其tag/checksum/provenance為準；
本文件不是主機已安裝成功的證據。

## 版本內容

- 已確認的B+ logo與不同Agent標誌、統一對話清單及手機內層捲動。
- Pi新工作樹原生sid／SSE、名稱與cwd；重複Start、錯誤Failed與資料夾授權修正。
- Claude/Codex原生歷史的受控唯讀來源、原名、分頁、熱／冷SQLite，Codex大型
  plain／Zstandard、raw／結構模式、工具跨頁與來源改變／取消／修復體驗。
- 本機來源群組精靈／管理、有限reader資源、實際程序關閉後釋放、不自動消耗模型重試。
- Codex paginated能力與lagging projection查證、獨立inert item模組及scoped-ID修正；
  **這部分還不是可用的私人paginated Web來源**。

新原生歷史功能必須另外配置可信Rust reader／固定SDK及owner來源/readers scope；
升級既有3.0.6不會自動授權、掃描私人HOME、修改Claude/Codex或第三方模型路由。
本次release包含程式來源，不冒稱同時打包並設定好每台機器的原生reader。

## 發布與安全更新門檻

1. 工程來源`836cf7059e3e975a572fca32b0f05d0994f088ad`先通必要general／native Codex／
   reader／rolling；未改的Claude SDK沿用fa8c84a已驗證來源，不假稱新SHA重跑。
2. 版本常數、HTML/manifest/SW cache同步3.0.7，再跑完整回歸及必要跨平台CI；
   source-only封裝驗版本、checksum、關鍵檔案及release-policy，不靠改版號冒充驗收。
3. 只有必要gate通過才建立`v3.0.7` tag；GitHub workflow再跑最低Node測試、建立
   stepsemble／pi-harbor相同來源資產與SHA256，產生provenance後發布非prerelease。
4. 兩台既有stable updater透過Release feed取得更新；可用不等於立即安裝。
   自動更新未啟用／主機離線／仍有Agent工作會延後，不能把Git push說成已更新。
5. 更新前確認執行中Pi/task/login狀態，保留原程式與設定／資料；有工作不強制切換。
   更新後核對`/api/health`的appVersion、來源/history不被搬動及服務健康。
6. 更新器驗SHA256，啟用後健康／版本不符會恢復前一程式與服務。不要用程式回滾
   覆蓋升級後新產生的使用者資料；資料回復必須個別判斷。

## 驗收證據與明確限制

工程及3.0.7版號同步後，本機Node22.22.3／22.19.0各1158tests、1156pass／
2 Windows-only skip／0fail；另通過語法、client／protocol同步、1251項獨立schema
驗證、版號、actionlint及gitleaks檢查。新paginated三OS真CLI owned oracle與schema hash通。
工程`836cf70`四組必要CI均已成功：[general](https://github.com/seehow624/stepsemble/actions/runs/34368582157)、
[native Codex](https://github.com/seehow624/stepsemble/actions/runs/34368582494)、
[reader](https://github.com/seehow624/stepsemble/actions/runs/34368582221)、
[rolling browser](https://github.com/seehow624/stepsemble/actions/runs/34368582144)。
general三OS各1158項，Linux／macOS／Windows分別1155／1156／1083 pass，
3／2／75個平台限定skip，均0fail。發布版本的CI與Release workflow另對exact SHA核對。
新原生讀取、17.2MB／16384筆Host、320/390px畫面、故障與清理證據見
[大型壓縮](codex-large-compressed-history.md)、[paginated限制](codex-paginated-history.md)。

72h已於2026-09-09 19:34:16 MYT通過，但只涵蓋凍結rc.1的8554cycles／68432ACK與
重啟工作負載；不能說3.0.7完整runtime也跑了72h。原監測已刪除，不再啟動。

留待後續、不在此次宣称完成：完整原生approval/resume/durable journal、其他Agent
原生history adapters、Codex paginated安全來源到Web、真iPhone/Safari/PWA背景網路、
Windows私有reader、全Host混合負載和未來各平台原生客戶端。
完整脈絡保留於[主計畫](platform-plan.md)及[C1–C8](web-completion-loop.md)；
本次發布收尾後停止持續Goal擴充，等待Jerome重新指定工作。
