# Codex paginated 歷史：原生能力確認與獨立 item 契約

2026-09-09／Plan1.80，候選仍為 **3.0.7-rc.7，未部署**。
這批完成固定原生版本的正向 oracle、分頁 observation 與 scoped-ID 修正；
**不是 paginated Rust source／Host／Web 全鏈已接，也不是 C2 完成**。

## 修正舊測試的解讀

Plan1.54 的 `thread/items/list` 實際在 legacy fixture 呼叫，paginated fixture
在 runner 先 `continue`。因此當時的 -32601 只證明那個 legacy 案例不支援，
不能推論所有 paginated 原生歷史均不支援。Plan1.55 的 JSONL-only 空投影及
Plan1.62 的 full-read deprecation notice 拒絕仍是有效的原始案例，不覆寫成成功。

官方 [App Server 文件](https://learn.chatgpt.com/docs/app-server) 的 items/list
段落說能力取決於 active store，但同頁 paginated 建立／完整讀取段落仍有未支援
說明。因此本批以固定 **0.153.4** binary、既有十份 history schema hash，以及
tag commit `3d2ee51ca2d5db578f328aa75e20aa22c0197c9a` 的
[read.rs](https://github.com/openai/codex/blob/3d2ee51ca2d5db578f328aa75e20aa22c0197c9a/codex-rs/thread-store/src/local/thread_history/read.rs)、
[thread_read.rs](https://github.com/openai/codex/blob/3d2ee51ca2d5db578f328aa75e20aa22c0197c9a/codex-rs/app-server/tests/suite/v2/thread_read.rs)
和實際 owned runtime 為準；不從最新版文字猜測固定版本行為。

## 本次實作

- `paginated-history-observation.js` 是獨立 item-page 契約，不將資料假扮 legacy
  turn 或改掉舊拒絕條件。保留 native thread/session/title/turn/item、所有 item JSON、
  SHA-256 與未知欄位；工具、圖片和記錄中的 approval 狀態都不可執行。
- 2MiB input、50 items、128KiB 單 item、256KiB output、4KiB cursor；超限明確拒絕，
  不截斷。嚴格 metadata-only/notLoaded、paginated mode、selected IDs、頁面／entry
  shape；getter/cycle/non-JSON 拒絕。未知 item 標籤保留並警示，不等於所有 payload
  已驗原生語意。
- 身分使用 `(turnId,itemId)` tuple；原生資料表主鍵為
  `(thread_id,turn_id,item_id)`。修正 read transport 將跨回合相同 item ID 誤判為
  重複的問題；同 tuple 重複仍拒絕，且不能用可碰撞的字串 delimiter 拼 ID。
- `sourceAuthenticated:false`、`publishable:false`、`historyComplete:false` 永遠保持；
  這一頁不能產生來源權限、全來源版本或完整歷史證明。未新增 HTTP profile、來源
  自動掃描、native session/resume/approval 或權限授予。

## 原生 oracle 的範圍與结果

`scripts/check-native-codex-paginated.mjs` 只建立自己可清理的 HOME、明確 sqlite_home、
config／rollouts／舊索引與本地拒絕式模型 endpoint。原生建立及 migration 資料庫後，
確認實際 child close，才用 Node SQLite 插入**受信任的合成 projection rows**；
不是產品 SQLite reader，也沒有驗 native 如何產生這些 projection。
Node SQLite 不與原生程序／writer 同時連線，不讀私有來源。

固定 native-created history schema（排序 type/name/sql、只正規化 CRLF）SHA-256：
`5dc2e78ea370ca336b00f7ed52a845bd89692804fb0a829476eb9e901e57dd90`。
六個官方 thread_history migrations 建立 turns/items/projection/realtime 與相關索引；
runner 不用手寫 DDL 冒充原生 schema。

本機 Node22.22.3 與最低22.19.0均通過：

- 根對話4 items、繼承母對話第一回合的子對話6 items；10張單-item頁、5張 full-turn頁、
  26張實際 item observation 頁，另驗50筆同頁及單turn filter。
- 同一 item 更新保留第一次建立位置及最新 JSON；跨turn相同ID保留；錯對話 cursor
  回 -32600，read channel 仍健康。名稱來自 state name，不採舊索引名稱／preview。
- 模擬 revert：stable thread ID 不變，state row 指向新 physical rollout ID，且新檔
  位於 archived root；讀到 inherited＋新內容，不混入被取代的舊 rollout。
- 刻意讓根 projection 落後 durable JSONL：原生仍成功回2 items／EOF，但原文有4 items。
  新 observation 仍明示 incomplete/non-publishable。**RPC 成功不證明來源完整**。
- 3次原生啟動、loaded threads 0、模型 endpoint requests 0；5份 rollout/index/config
  原檔前後不變，selected metadata／projection 在各次明確 fixture setup 之外不變；
  actual-close及owned HOME清理確認。

本機整套／最低 Node 各 **1158total／1156pass／2 Windows-only skip／0fail**。
新10個 observation／fixture tests及2個transport tests；不是19種native payload或真機驗收。
CI已接入既有三OS pinned native workflow；本提交 exact CI 狀態另核，不將Mac結果當跨OS通過。
本次沒有改 Rust artifact、Web畫面或正式服務，亦不重查已完成的72h。

重跑：

```sh
node --test test/native-codex-paginated-observation.test.js test/native-codex-history-transport.test.js
node scripts/check-native-codex-paginated.mjs /absolute/verified/native/codex
```

## 下一段：安全來源到產品全鏈（仍待）

1. 固定 `state_5.sqlite` selected row + `thread_history_1.sqlite` WAL/cold schema／
   projection checkpoint／visible turns/items，接同一個 reader admission/deadline，
   所有資料只從已授權 roots 與 held FD 取得；不得將本 oracle 指向真人 HOME。
2. 從 state 的 current rollout_path 起，按 SessionMeta.history_base 解析祖先；
   stable thread ID／physical rollout ID 分離，active/archive及plain/zstd都需驗。
   bounded depth／bytes、cycle／missing source／no-follow／ACL／cutoff與ordinal位置。
3. 把 durable complete-LF 範圍、各段完整摘要與 selected projection checkpoint 比對；
   拒絕落後／不一致／partial-tail／來源變動。不用 native EOF 當完整證明，也不呼叫
   resume 或寫入 repair。subagent inherited prefix、跨段更新及fork截點語意另驗。
4. 新獨立 source-version/profile 和 created-ordinal cursor；同版本前後複核，selected
   page permissioned parser → named source service → registry／HTTP／peer／typed Web。
   不重用 legacy byte cursor，不把 scoped-ID 修正誤當現有 legacy API 語意改變。
5. 補損壞／版本變更／取消／超限／同Host繁中Web、三OS及320/390px實測；
   原生 materialization、真機與帳號／部署 gate 仍各自獨立。
