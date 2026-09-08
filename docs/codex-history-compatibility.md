# Codex 原生歷史：固定版本讀取驗證

2026-09-08／Plan 1.55，開發候選仍為 3.0.7-rc.6，**沒有部署**。
這是 C2 的受限 RPC、inert observation 核心與真 CLI 合成測試，
不是已完成的 Codex 歷史 adapter。
既有 Web／source-group 仍只接已實作的來源，不會自動多掃 Codex HOME。

## Plan 1.54 已執行範圍（原基線保留）

- 使用操作員已確認的官方原生 Codex 0.153.4，不經 OpenCodex wrapper。
- 先重新核對既有 24 個 schema／99、10、81 method catalogs，再比對新增的
  `0.153.4-history-schema.json`：10 個歷史 request/response 檔案的 bytes/SHA-256。
  前四個重疊的 schema 必須仍與舊證據完全相同；沒有覆蓋舊基線。
- 每次只建立自己的本地臨時 HOME/CODEX_HOME/cwd，allowlist 環境不繼承帳號、
  第三方路由、代理、loader 或私人來源。合成 config 使用本地拒絕式模型 endpoint，
  禁用 apps/plugins/hooks/shell snapshot/memories/shell tool 與 telemetry exporter。
- 實際啟動原生 app-server，只呼叫 initialize、thread list/read/turns list/items list/
  loaded list。**沒有** thread start/resume、turn start、login、config write 或 approval reply。
- 8 個合成來源涵蓋 cli、vscode、exec、appServer、subAgent review、unknown、
  archive 與 paginated；來源列分頁每頁 2 個，不能只測預設 interactive sources。
- 7 個 legacy 對話共 49 turns／147 user/agent items；逐頁 `itemsView:full` 與
  `thread/read(includeTurns:true)` 完全相等，保留同回合的草稿及最後回答。
  主清單 7 個／封存 1 個（其中主清單有 1 個 paginated fixture）。
- Legacy 名稱驗證 append-only index 最新原生長名稱，與第一句 preview 分開；
  不是拿 UUID、檔案名或 preview 冒充名稱。
- read 前後 loaded threads 都為 0；本地模型 endpoint requests 為 0；
  8 份 rollout＋config＋name index 共 10 份原檔 bytes 不變；actual child close
  確認後才移除自己的臨時 HOME。最低 Node 22.19.0 及本機 22.22.3 已跑同一真 CLI 測試。

這批 user/agent 訊息測試**不代表**全部 19 種 native item、工具歷史、attachments、
compaction、原生持久化／approval 或任何真人帳號已驗。macOS arm64 真 CLI 證據
不能當作 Linux／Windows 真 CLI 通過。一般 CI 只自動跑合成傳輸與固定 schema 測試。

## Plan 1.55 新增觀察與完整性檢查

`history-observation.js` 只建立 detached、不可執行的 JSON 觀察：完整 native title
與 preview 分開、native thread/session ID 分開；保留所有 item 原始欄位、turn 的
錯誤／時間欄位與逐 item digest。未知 item 標記 warning 並保留，不悄悄丟棄。
儲存的 failed／declined 只代表歷史觀察，不是新執行結果或 approval receipt。
附件路徑／URL 不讀取、工具不重播。所有結果 `sourceAuthenticated:false`、
`publishable:false`，尚不允許拿去公開、接 HTTP 或當作可信來源。

固定版本／selected IDs、metadata-only notLoaded thread、full items、唯一 IDs、
50 turns／1000 items、2MiB input／256KiB observation output 都有檢查；超限
明示 unavailable，不截斷。13 個新 unit tests 包括所有 **19 種標籤的保留**、未知欄位、
getter/cycle、錯誤、附件、summary/duplicate/size 拒絕，但不是 19 種 native payload
各自通過真 CLI 的證據。真正發佈前仍需 source ACL、immutable capture、跨頁 fence。

新的 owned rich fixture 包含 command、patch、MCP、view-image、reasoning 與
compaction，保留所有預期項目，不靠移除失敗案例讓測試通過。固定 0.153.4 在
Node 22.19.0／22.22.3 的實際結果一致：

- 還原 6 種 item：userMessage、reasoning、fileChange（declined）、mcpToolCall
  （failed）、contextCompaction、agentMessage。
- **commandExecution 與 imageView 未還原；根因尚未確認，不能歸咎原生 bug，
  也不能宣稱全部工具歷史已通過。** `checkItemCoverage` 用独立 fixture 的
  expected ID/type 對照，回 `native_projection_incomplete`、missingTypes 兩項。
  這個檢查僅檢驗 expected 覆蓋，不驗證來源真偽；將來 expected 必須來自独立
  驗證的 capture，不能拿同一份 RPC 回覆自己對自己。
- 主清單 8／封存 1；既有 7 個 legacy 對話 49 turns／147 items 仍通過，
  加上 rich fixture 共 29 個 full observation pages；9 rollouts＋config＋index
  共 11 原檔 bytes 不變，loaded 0／model endpoint requests 0，actual close 後清理。
  沒有建立 fixture 提到的輸出檔或圖片，不是曾執行過那些工具。

runner exit 0 表示「正向讀取＋缺漏偵測」回歸通過，**不表示 rich 完整性 gate 通過**。
完整 sanitized 結果見 [Plan1.55 owned runtime](baselines/codex-history-observation-owned-2026-09-08.json)。
合成 config 另明確 `cli_auth_credentials_store = "file"`；只作用於自建 HOME，
不接觸 keychain／私人 auth 或第三方 route。測試 endpoint listen 失敗會 reject。

## 實測到的相容性缺口

| 項目 | 0.153.4 實際結果 | 整合時的限制 |
| --- | --- | --- |
| `thread/items/list` | schema／method catalog 存在，但原生回 -32601「not supported yet」 | 必須顯示 unavailable；不能靠 schema 宣称 item 分頁可用，不能重試或偷偷 resume |
| paginated JSONL-only fixture | `historyMode:paginated`，turns list 為空，legacy name index 未還原名稱 | 官方文件亦明示 paginated 完整讀取尚未支援；observation 一律 unavailable，不手改 store／偷偷 resume 或當作空歷史 |
| rich fixture command/image | 固定 CLI 在此 fixture 未還原兩項；其他六類有返回 | 原因仍待查證，完整性 gate 未過；不得減少預期 ID、丟掉工具後稱完整 |
| `thread/list useStateDbOnly:false` | 原生可能掃 rollout 並修復自己的索引 | 不是 OS 唯讀操作；只有本 runner 的自建 HOME 明確允許，不可直接對私人 HOME 執行 |
| 超大單回合 | 本模組 frame 上限 2 MiB，整個 child stdout 32 MiB | 超限明確失敗；不能截斷後稱完整，也不能依賴未實作的 items 分頁補救 |

這些限制來自實際固定 binary，不從最新版文件推測。官方文件說明 read 與 resume
的差別、分頁參數及實驗性方法，見 [App Server](https://learn.chatgpt.com/docs/app-server)。
Plan1.55 重查同一官方頁後確認其已明示 paginated 建立、完整歷史／turn 分頁／resume
仍 fail closed，因此將接續重點移至 legacy capture，不用手改 store 繞過原生能力。
合成 rollout 與 name index 格式參考官方專案的
[rollout fixtures](https://github.com/openai/codex/blob/main/codex-rs/app-server/tests/common/rollout.rs) 及
[session index](https://github.com/openai/codex/blob/main/codex-rs/rollout/src/session_index.rs)，
但最終是否成立，以固定 0.153.4 的本機 runtime assertions 為準。

## 核心的保護與限制

`protocol/native/codex/history-rpc.js` 是獨立 read-only RPC allowlist，不擴大原有
subscription metadata transport。每 child 一個隨機 incarnation、單次 handshake、
最多 2 pending／512 requests、15s timeout、最多 50 rows、4KiB cursor；fatal UTF-8、
2MiB frame／32MiB stdout／256KiB stderr。原生 error text 和 stderr 不回傳或保留。
response ID、selected thread／item turn、重複 row ID、page envelope 先驗。

原生啟動會送 `remoteControl/status/changed`；只丟棄最多四個 disabled 通知，
不保存機器名等欄位。其他通知、執行事件及 server approval requests 全部終止通道，
不自動回 approval。SIGTERM→SIGKILL 只送自己的 child；exitCode 不是 actual close，
cleanup timeout 永久回 unknown，runner 不刪仍可能使用中的 owned HOME。

這是傳輸層，不是 OS sandbox、binary provenance、完整回覆語意驗證器或來源快照；
**不能把這個 child 指向使用者原本的 Codex HOME**。它會寫自己的索引／啟動資料，
沒有私人來源授權、ACL、atomic capture、跨頁 revision fence、Host shared admission、
逐 reader registry 或 Web schema／觀察映射接線。

## 重跑

```sh
node --test test/native-codex-history-transport.test.js
node --test test/native-codex-history-observation.test.js
node scripts/check-native-codex-history.mjs /absolute/trusted/native/codex --runtime
```

`--runtime` 不接受外部 HOME／來源內容／route，不會套用自己的環境變數去讀私有帳號。
`--record` 只供人工審查後新增證據、exclusive create；不覆寫既有 golden。
一般測試不得執行真人 CLI、消耗模型或把 unsupported 改成 passed。

## Plan1.54 exact CI 證據（不可當成1.55已過）

程式 SHA `87225f953dce96f77eeea5956ab28fe4510008be`：

- [一般 CI 34227909134](https://github.com/seehow624/stepsemble/actions/runs/34227909134)：
  三 OS 各 755 tests／0 fail；Mac 753 pass／2 skip、Linux 752／3、Windows 723／32，
  各自 Ajv 1251 通過。包含本批 13 個傳輸／schema 測試，不執行真 Codex binary。
- [Rolling 34227909162](https://github.com/seehow624/stepsemble/actions/runs/34227909162)：
  macOS／Linux 各 24 browser cases 通過、pageErrors 0；含既有 Claude native
  source browser 六個明暗／尺寸組合及 fixture cleanup。**不是新增 Codex Web UI**。
- 真 Codex runner 為上面記錄的本機 macOS arm64、兩個 Node 版本 owned fixture；
  Linux／Windows 真 Codex 歷史仍未實跑。此次未改 Claude reader，未冒用旧 native CI
  為 Codex 相容性背書；正式服務與獨立 72h 不變。

## 下一步

先獨立驗證固定版本 raw fixture 的格式，查清 command/image 未還原原因；不反覆
猜 JSON、不縮減 expected 清單、不把負向 gate 的成功檢出當成完整歷史通過。
Paginated 完整讀取暫時明示 unavailable，避免手改 native SQLite。
接著做 legacy 一致快照／來源授權、改名／同時間來源／增改刪及 cross-page fence，
接同 Host 的限額、來源 registry、HTTP/relay/TS/UI。
保持原生與模型身份分離、全名與 preview 分離；不把歷史匯入等同 session resume。
C1/C3–C8 的授權操作、i18n、跨機／效能、durable 與發布 gate 仍繼續，不重做
已完成的來源列表，也不觸碰獨立固定 SHA 的 72 小時 soak。
