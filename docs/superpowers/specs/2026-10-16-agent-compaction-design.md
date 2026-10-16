# Coding agent 手動上下文壓縮

## 已確認範圍

使用者同意：只增加各 coding agent 的壓縮入口；Hermes 已獨立為 Bot／Assistant，完全排除。不修改 `/clear`，不建完整斜線指令中心，不新增其他終端指令。原生介面無法安全提供壓縮時，保留停用項目並說明原因，不把普通 prompt 當作成功壓縮。

## 使用行為

- coding agent 對話的 `/` 選單包含 `/compact`。附加摘要說明只有原生介面確實接受時才允許。
- 手動輸入與選單走相同路徑，必須在一般訊息 echo、草稿清除和圖片移除之前分流。附帶圖片時拒絕，保留全部草稿／附件。
- 壓縮中顯示持續的狀態；重新整理可查同一操作。只有原生完成證據才能顯示完成；送出、ACK、一般模型回覆均不等同完成。
- 不改變工作區 entry、原生對話 ID、專案、模型、權限及對話歷史，不清空對話、不修改專案檔案。
- 只呈現原生已回報的 token 數；未知數維持未知，估算必須標示估算。
- 停用原因涵蓋未連線、純終端／唯讀歷史、agent 尚未公布壓縮指令、原生介面不支援、正忙、等待核准、被 Goal 擁有。

## 原生路徑

| Agent | 路徑 |
| --- | --- |
| Pi | 同一 sid 的 RPC `compact`，可帶 `customInstructions`；等待該 RPC 的原生回覆。 |
| Claude Code | 同一 structured session 的原生 `/compact`；觀察 root `compact_boundary` 與最終 result，不把任意文字當證據。桌面 helper 沿用既有 stream。 |
| Codex | 同一 thread 的 app-server `thread/compact/start`；保留 mutation 授權／journal、pool thread fence；等待原生 compact／turn 終結而非只等空 ACK。 |
| OpenCode | 同一 session 的 `/session/:id/summarize`，使用該會話的模型，不改全域設定；檢查原生回覆與實際閒置。 |
| OMP／Kilo／Cline／Grok Build | 只接受該 session 即時 `available_commands_update` 中的 `compact`／`compress`／`summarize`；沒有公告則停用。只暴露壓縮，不順便提供完整指令清單。 |
| Antigravity | 目前 stream-json 沒有已驗證的手動壓縮操作，停用並說明；不啟動替代模型或新對話。 |
| Hermes | 不提供入口，不呼叫 ACP 或 Bot API。 |

## Host 邊界

- 新增 `GET/POST /api/agent/compaction`，以已驗證工作區 entry key 解出 agent、原生 ID 與 cwd，不接受瀏覽器任意指定其他 session。
- GET 回報 capability 與最近一次操作狀態；不啟動 agent、不送模型請求。
- POST 接收 entry、UUID requestId 和可選摘要說明。有界冪等，同 ID 不重送；同 entry 同時只准一個壓縮操作。
- 工作中、核准等待、Goal 鎖定、唯讀、Hermes 等一律在原生 IO 前拒絕。執行前再次核對 membership／原生身份，避免刪除或重新掛載造成錯誤目標。
- 原生壓縮占用 Host 活動 reservation，不因瀏覽器斷線就釋放。一般送訊／其他 mutation 與 Goal 啟動不得插入壓縮中。
- 不對結果不明的 mutation 自動重送。Host 重啟後不重播未確認操作。

## 程式分工

- `server/agent-compaction.js`：壓縮能力／公告正規化、工作區身份、操作狀態、冪等與 HTTP controller。
- 各原生 adapter：精確協定及完成證據；Codex pool／history adapter 保持既有授權邊界。
- `public/modules/agent-compaction.js`：僅此動作的解析、選單項目、狀態輪詢與草稿安全；`public/app.js` 只接線。
- `public/modules/compaction-i18n.js`：11 語系文案，維持任務文字原樣。
- 現有 index／service worker 引入新模組，不改版號、不發布。

## 驗證

先寫失敗測試再實作：能力矩陣、Hermes 排除、附件／唯讀／Goal／忙碌／重複請求、身份重驗、ACK 非完成、失敗不假報 token、transport 關閉、ACP 早於 session/new 回覆的公告與後續撤回、UI 舊回覆／切 Host／草稿／停用項目、所有語系。原生 wire 用合成 peer，另對真實已安裝 CLI 使用隔離 HOME／假 model API；不對使用者對話發送付費測試。完整 npm suite、syntax／client／protocol 及隔離瀏覽器確認後回報，不自動 commit／合併／發布。
