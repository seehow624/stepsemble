# Codex paginated 投影檢查點：受控 SQLite 讀取邊界

2026-09-10／Plan1.82。這批完成[上一段清單](codex-paginated-history.md)第 1 項的
**投影檢查點讀取**，仍**不是** C2 完成，也沒有接上 Host／Web 或正式服務。

## 這批做了什麼

原生 Codex 的 paginated 對話把內容放在與 `state_5.sqlite` **不同**的
`thread_history_1.sqlite`。既有 Rust reader 只讀 state 資料庫的名稱欄位，
因此無法判斷一個 paginated 投影是否落後於實際 rollout 檔案。

新增 `crates/history-source-reader/src/sqlite_paginated.rs`，在既有的
唯讀來源邊界上讀取該資料庫的**投影記帳資料**：

- `thread_history_projection_state` 的 `next_rollout_byte_offset` /
  `next_rollout_ordinal`，即投影自己聲稱已消化到哪裡。
- `thread_turns` 的回合邊界（ordinal、byte offset、首尾 item ID、狀態），
  依 `rollout_ordinal` 排序，上限 2048 筆，超過明確拒絕而非截斷。
- `thread_items` 的**數量與最大 ordinal**，用於和檢查點比對。

## 明確的邊界

`item_json` 在這條連線上**不可讀**：authorizer 只允許 `thread_id` 與
`rollout_ordinal` 兩個欄位，內容仍屬於另外驗證的分頁 observation 管線。
`thread_realtime_items`、`error_json`、`group_concat`、`readfile` 等一律拒絕；
SQL 函式只放行 `count` 與 `max`。三張表的 DDL 逐字固定於
`protocol/native/codex/sqlite-thread-*.sql`，任何 schema 變動回
`SchemaUnsupported` 而非嘗試解析。

輸出永遠帶 `sourceAuthenticated:false`、`publishable:false`、
`historyComplete:false`。**檢查點只證明這個投影當下的聲稱**，不是來源授權，
也不是 durable 歷史完整性證明；投影落後時如實回報落後的數字。
缺投影列是本次交易的觀察，不等於歷史為空。

沿用既有安全設定：唯讀連線、250ms 交易預算、64,000 VM 步數上限、
defensive／trusted_schema off／attach 關閉、取消旗標，以及回傳任何列之前
必須確認連線實際關閉。WAL 與 cold RAM snapshot 兩種版面各有進入點，
journal mode 不符即拒絕。

## 驗收

Rust crate 全套 `cargo test --locked` 通過，其中本模組 12 項涵蓋：正向讀取與
ordinal 排序、落後投影如實回報、缺列不等於空歷史、item payload 不可讀、
其他表／SQL 函式維持未授權、schema 變動與缺表拒絕、可寫連線拒絕、
未固定版本與非法選取拒絕、取消、超過回合上限拒絕、cold 進入點的 journal 檢查。
`cargo fmt --check` 與 `cargo clippy -D warnings` 乾淨。

固定 DDL 由 `scripts/check-native-codex-paginated.mjs` 對**實際原生產生的**
資料庫逐表比對，原生改版造成 drift 會在此失敗，而不是無聲讀出錯誤資料。
本機以 0.153.4 執行通過（`historySchemaSha256`
`5dc2e78ea370ca336b00f7ed52a845bd89692804fb0a829476eb9e901e57dd90`、
`privateHistoryReads:0`、`modelEndpointRequests:0`、`cleanupConfirmed:true`）。
Node 端 1158 tests／1156 pass／2 Windows-only skip／0 fail 不變。

## 仍待

本批**只有讀取邊界**。Plan1.86 已由[逐檔開啟 adapter](codex-paginated-opening.md)
以 state 的 `rollout_path` 計畫解析祖先鏈與 active/archive、plain/zstd 版面；仍尚未把
durable complete-LF 範圍與檢查點實際比對
以判定落後／不一致／partial-tail；獨立 source-version／created-ordinal cursor；
permissioned parser → named source service → registry／HTTP／peer／typed Web；
以及損壞／版本變更／取消／超限的三 OS 與 320/390px 實測。
Windows 私有來源仍 unsupported。原生 materialization、真機與帳號／部署 gate
各自獨立，未因本批而通過。
