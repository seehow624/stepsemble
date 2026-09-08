# 原生歷史：共用讀取資源限額

2026-09-08，Plan 1.50。開發版仍 `3.0.7-rc.5`，未部署正式服務。

**Plan1.51接續**：source-group config／同instance／dynamicregistry／HTTP分頁已接上，
見[來源群組](history-source-groups.md)；下方未接線是1.50當時範圍。Web來源UI和title仍待。

## 這批實際完成的部分

目錄探索和歷史內容讀取現在能共用一個 Host-private admission instance，固定
**最多兩個同時進行的工作**，不排隊、不重試。內容讀取由 Rust capture 轉入
bytes-only SDK worker 時仍占同一名額，不能在兩階段中間讓第三個工作插入。

`createHistoryHost` 建立並持有同一 instance，傳入現行 native source service；
`createSourceIndex` 接受相同的可信 instance，已用真正 Rust＋SDK 的合成來源
驗證與 content 共用。**source-group 設定／registry／HTTP 掃描／Web 清單尚未接線**。
本批不新增來源，不代表使用者已能在 UI 自動看見全部原生對話。

## 介面與生命週期

實作：`protocol/native/claude/history-reader-admission.js`。

- `createReaderAdmission()` 沒有可提高限額的設定；回傳 frozen instance。
- `acquire(stop, cleanup)` 只供可信 Host consumer 使用。滿額即回 `source_busy`，
  在建立 helper process 或 SDK process **之前**拒絕，不持有等待佇列。
- permit 涵蓋完整工作；`finish()` 只表示 consumer 已結束處理，還必須由其
  cleanup probe 確認相應 helper／SDK child 實際關閉才能釋放。
- 取消、kill 回傳值、exit event、逾時、Promise 已 settle，都不是 actual close。
- 無法確認清理立即永久 quarantine 整個共用 instance，同步停止其他飛行工作；
  晚到 close 可更新資源清理狀態，**不能解除 quarantine 或重新發布結果**。
- 重複呼叫舊 permit 的 finish 不會釋放新工作的名額。finished/unknown records
  最多仍兩筆；正常已確認記錄會移除，不累積無界 tombstones。
- `close()` 同步關閉新 admission、停止所有現有工作；cleanup 狀態仍按 actual
  close 證據判定。Host shutdown 合併 registry 與共享 budget 的結果，任何一邊
  unknown 都不能回報成功。先前 unknown shutdown 結果不因晚到 close 改寫成成功。

Content service 保留自己的兩個 helper、64 binding 與 generation/version fencing；
索引保留每來源 single-flight、來源授權及 stale snapshot。關閉一個 index 只停止
自己的 helper，**不關掉其他來源或整個共享 budget**；Host 才負責整體 close。
任一 consumer 可發現共用 quarantine，不能藉建立新 service 並沿用同 budget 繞過。

Instance 身分以 module-private WeakSet 檢查，plain object／spread 複本不能冒充；
這不是惡意同程序程式碼的 sandbox 或來源授權。可信 owner 若刻意建立另一個
budget，仍會得到另一個限額；因此未來 source-group 接線必須**傳入 Host 已有的
同一 instance**，不能每個 group 各建一個。各個 Host process 也不是全電腦共同配額。
Standalone diagnostic callers 可省略 admission 使用自己的 isolated instance。

## 驗證

全數使用合成資料，沒有私人歷史、原生登入、模型、路由或正式服務操作。
Rust／SDK pin、原生 source policy 和 Windows unsupported 邊界不變。

- 新 admission unit tests：固定容量、無佇列、unfinished 不可釋放、重複舊 permit、
  unknown cleanup／晚關閉、quarantine、全域關閉、cleanup/cancel callback 拋錯。
- 新跨 service/index tests：一掃描＋一內容完整兩階段、兩掃描擋第三內容、
  一 index 關閉不停止另一個、雙向 quarantine 傳播、replacement service 不繞過、
  Host close、假 admission instance 拒絕。
- Actual Host 邊界測試核對它真的傳入可信 instance；共享清理未知不能被一個
  回報 clean 的 service 蓋過。既有 Host 取消 stalled helper／退出測試保留。
- 本機最終完整 **689 tests：687 pass、2 平台 skip、0 fail**；聚焦 suite 51/51。
  TypeScript/artifact、syntax、version、1,251-case Ajv、workflow actionlint 通過。
  本輪沒有重現先前那一次未定位失敗；不將本次通過當作已查明其根因。
- `scripts/check-native-history-pipeline.mjs` 新增真正 Rust inventory 與內容並行，
  以 owned ChildProcess 的 close 事件計數。最低 Node22.19.0、本機 macOS arm64
  實跑：`sharedReaderAdmissionGate=posix_owned_fixture_passed`，51 次 spawn attempt，
  physical maximum 2、remaining 0；第三請求無 spawn attempt。固定 SDK0.3.259，
  native CLI format2.1.259，debug helper SHA256
  `efedbde33d9ddcf8ed5f6aa084284349c3bbc0a4bd56b1bad4636452572e634a`。
- 同一次 pipeline 的既有 HTTP／relay／provider 及 actual `server.js` 四來源讀取、
  分頁／變更／撤銷 gate 通過，原 fixture 除明確合成 mutation 外不變，owned cleanup
  已確認。這些範圍與新 shared gate 分開，沒有冒稱 source-group 已掛 HTTP。

### Exact commit 跨平台驗收

程式／測試 **`ab8e6ed8ae30a6e643da6f9a8474c331c0f6a9fb`** 已 push，四組 workflow
全部成功，以下數字已核對該 SHA 的 logs，不沿用 Plan1.49 的綠燈。

| Gate | 已驗範圍 |
| --- | --- |
| [一般 CI 34214491752](https://github.com/seehow624/stepsemble/actions/runs/34214491752) | 每 OS 689 tests、0 fail；Mac 687 pass／2 skip、Linux 686／3、Windows 658／31；Ajv 每 OS 1,251 cases |
| [Native reader＋audit 34214491852](https://github.com/seehow624/stepsemble/actions/runs/34214491852) | Rust Mac17／Linux17／Windows8；Node 每 OS 65/65；Mac/Linux 實際 mixed inventory＋SDK gate 的 physical max2／remaining0／51 spawn attempts，既有 actual Host gate 通過；locked RustSec audit 成功 |
| [Native Claude 34214491802](https://github.com/seehow624/stepsemble/actions/runs/34214491802) | 固定 SDK0.3.259 三 OS 合成契約 passed，modelCalls0、nativeFileUnchanged=true |
| [Browser rolling 34214491690](https://github.com/seehow624/stepsemble/actions/runs/34214491690) | Mac/Linux 各18 cases 全 passed／pageErrors0；含既有雙向 released-source、登入／Pi／巢狀 picker／131-record catalog 回歸 |

Windows 的 native inventory／content pipeline 仍明確 `source_platform_unsupported`，
physical spawn0 不是原生讀取成功；不能因 Node parser/pool 測試成功宣稱原生可讀。
本批沒有變更 UI；rolling 是既有介面回歸，不是新 source-group UI、真機、RSS、
CWV 或長時間效能改善驗收。後續純文件提交與本次程式 SHA 證據分開。

重跑使用前述文件的明確 local helper 和固定 SDK artifact，或 pipeline 的
`--download` 固定版本合成測試模式；不要指定私人 history。完整測試輸出應保存，
失敗時保留 case 與 stack，不只保留尾端總數。

## 下一段（仍屬 C1）

source-group 一次 opt-in／readers config、共用現有 admission、動態 registry
增改刪與同步撤銷、受授權且有界的 catalog 分頁、正確 native title/metadata、
Web source onboarding／按需歷史仍需完成。不要重做 inventory／admission 核心，
也不要把 Host-private 含路徑 snapshot 直接送進舊 Host-wide catalog。

既有 72h 測試仍固定 `ab227af`；本次新 JS 不在那份 runtime 內。長測結果不能
替代本批的新驗證或正式部署關卡。
