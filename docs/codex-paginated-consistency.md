# Codex paginated：選定列、投影檢查點與 durable 前綴一致性

## 接續 1.93：受控 consistency gate 接入 service／HTTP／typed transport

本輪新增 native protocol 17 `native_codex_paginated_consistency`，把既有的
protocol 15 paginated resolution、protocol 16 physical-head projection checkpoint
與 Rust `codex_paginated_consistency::assemble()` 接成一個可重複驗證的受控流程。
同一個 owned binding 會依序完成：resolution、以 selected physical rollout ID 讀取
checkpoint、組合 durable evidence，最後才回傳 detached consistency observation。這個
流程共用既有 helper slot、single admission、AbortSignal、actual close、quarantine 與
generation／request fence；不另外掃描 HOME、不暴露來源絕對路徑，也不接觸登入憑證或
訂閱帳號。

接線現在穿過 `history-source-service.js`、`history-registry.js`、
`server/history-http.js` 與 `client/history-transport.ts`。公開 route 是
`POST /api/history/paginated-consistency`，使用獨立 512 KiB body／2048 chunks
界線；typed browser transport 以同一個 exact-key envelope 驗證 response。protocol 17
本身仍只接受 detached selection、plan、resolution、projection subset 與 durable
evidence，禁止未知欄位，並在 Rust 端再次組合與拒絕不一致資料。

這個 gate 的 aggregation 明確標記為 `cross_observation_non_atomic`：它是同一次受控
生命週期內的 sequential observation，不是來源檔案與 SQLite 的原子 snapshot。輸出的
`historyComplete`、`sourceAuthenticated`、`publishable` 永遠是 `false`；它不代表
transcript、resume、approval、journal replay、完整 ancestry discovery 或其他 agent
parity。任何 partial LF、projection lagging／out-of-range、physical key、版本、generation
或 binding mismatch 都 fail-closed，不回傳空歷史或部分成功。

驗證：新增 protocol 17 wire／pipeline／HTTP／service 測試，並保留 physical selected
rollout（revert 形狀）檢查；完整 Node、client、Rust 與 protocol conformance gates 需
全部通過後才可提交。這一段是 C2 的安全增量，不宣稱 C2/C3 已完成。

## 接續 1.90：resolution 接入 owned Host／registry／HTTP／typed transport

1.89 的 protocol 15 native helper／pipeline 現在已由
`protocol/native/codex/history-source-service.js` 的 paginated binding 接住，並穿過
`protocol/native/claude/history-registry.js`、`server/history-http.js` 與
`client/history-transport.ts`。每一層只接受 detached、exact-key 的 selection envelope：
selected head 必須是 binding catalog 已授權的 head，第一筆 locator 必須與 source catalog
相同；root identity、stable thread、native version、generation、request ID 與 expected
version 都會重新核對。成功結果固定為
`bound_codex_paginated_resolution`，仍標示 `historyComplete:false`、
`sourceAuthenticated:false`、`publishable:false`，並在實際 close 後才釋放 admission。

HTTP 的 `/api/history/paginated-resolution` 有獨立 16 MiB／8192 chunks body budget；普通
history request 仍維持原本的小界線。這個接線不會自行掃描 HOME、不暴露來源絕對路徑，也
不改動官方登入或訂閱帳號。Browser transport 的大 request budget 只服務已授權的 metadata
selection，response 仍受既有 bounded reader 限制。

驗證：focused service／registry／HTTP／transport 及 protocol 15 tests 34/34 通過；
`npm run build:client`、`npm run check:client` 與完整 Node suite 1225 pass／2 skip／0 fail
通過。這仍是 observation 接線，不是 transcript、resume、approval 或完整 C2。

## 接續 1.89：protocol 15 native helper／pipeline 邊界

本輪已把既有 Rust `codex_paginated` protocol 15 接到
`history-native-helper.js` 與共享 `history-pipeline.js`。Node 端新增
`paginated-resolution-wire.js`，對 input、stable／physical rollout locator、
canonical base64 metadata、oldest→head plan、resolution source、stored／decoded
整鏈合計、ordinal cutoff 與三個 false flags 做 strict detached validation；未知
欄位、錯誤順序、跨 source mismatch、非 canonical 數字、空／超限 source 一律
fail-closed。pipeline 沿用既有兩個 helper slot、single admission permit、
AbortSignal、actual child close、quarantine 與 expected-version fence，輸出仍是
`codex_paginated_resolution_capture` observation，不是 transcript、resume、
approval 或授權。

這個增量當時只到 Host-private native pipeline：它要求上游已持有並驗證每個 first
metadata record 與 repository-relative locator，**不**自行掃描 HOME、不暴露任意
檔案路徑、不接 HTTP／registry／Web，也尚未把下方 `codex_paginated_consistency::assemble()`
的 durable LF 與 SQLite projection checkpoint 組合進來。Windows 仍明確
`source_platform_unsupported`。

驗證：focused Node helper／wire／pipeline 8 tests、完整 `npm test` 1218 passed／
2 skipped、client build/check 通過；Rust all-targets library／binary／integration
tests 全綠。官方 Codex 0.153.4 owned paginated fixture 的實際 Rust resolution
probe 亦通過（stored／decoded bytes、record counts、reverted source 順序與
negative-control mismatch）。

2026-09-11／C2 bounded assembly。這一段只新增純組合邊界，尚未接到
durable／SQLite consistency、正式 source service 或 Web；protocol 15 native
helper／pipeline 接線見上節。它不改變既有 POSIX opener、祖先鏈計畫或
projection reader。

## 固定原生語意

以 `/Volumes/devkit/Tools/codex-history-source.uiLcBa/codex-rs` 的固定
`3d2ee51ca2d5db578f328aa75e20aa22c0197c9a` 為準：

- `state_5.sqlite` 的 `threads.id` 是 selected stable thread ID，
  `rollout_path` 指向目前 head 的 locator；revert 後兩者不等於檔名中的
  physical rollout UUID。
- `thread_history_projection_state` 以 physical rollout ID 為 key；
  `next_rollout_byte_offset` 與 `next_rollout_ordinal` 是同一個 durable、
  完整 LF 前綴的游標。原生 `materialize_to_sqlite` 讀不到完整 LF 的尾端時
  不前進游標，下一輪再處理。
- lineage 的 source segment 是 `[start_ordinal,end_ordinal)`；metadata
  ordinal 仍計入整體 ordinal，只是不屬於 segment 的 content range。

因此 assembly 不單拿 local `record_count` 當 global ordinal，也不把檔案 EOF
本身當成完整證明。

## 新增模組

`crates/history-source-reader/src/codex_paginated_consistency.rs` 的
`assemble()` 接受：

1. state database 的一個 `sqlite_metadata::CatalogEntry`（selected stable
   ID、head locator、`paginated` mode）；
2. 已由 `codex_paginated_chain` 產出的 oldest→head `Plan`；
3. 已由逐檔 opener 觀察後完成的 `codex_paginated_resolution::Resolution`；
4. selected head physical rollout 的 `sqlite_paginated::Observation`；以及
5. 每個 oldest→head source 的 `DurableEvidence`。

每個 `DurableEvidence` 只帶 canonical exact decimal string：physical rollout ID、
decoded source bytes、完整 LF 前綴結束 byte offset、前綴後的 exclusive ordinal。
完整 source 必須滿足 `complete_lf_end_byte_offset == decoded_bytes`；小於它
是 partial tail，大於它是不一致證據。每段的 `next_ordinal_exclusive` 還要等於
「該段 metadata ordinal + resolution 的 local `record_count`」：root 段的 metadata
ordinal 固定為 0，後續段由上一段 inherited cutoff 推出。若 chain 尚未抵達 root，
這個起點無法獨立確認，assembly 會回 `ordinal_start_unverified`。沒有
caller-supplied authority 或 completeness flag。

組合順序與拒絕條件：

- selected stable ID 必須同時等於 plan/resolution thread ID；state locator
  必須等於 head locator，且由 locator 規則解出的 physical UUID 必須等於
  head rollout ID。這保留 stable／physical 分離，涵蓋 selected revert。
- plan 與 resolution 的 source ID、locator、cutoff 成對值及數量逐項相等，
  並要求 resolution 已有 ordinal-cutoff 證據。
- durable evidence 必須 oldest→head 一一對齊 resolution；decoded bytes、
  cutoff ordinal/offset 與每個完整 LF 前綴都要在界內。缺少、順序錯、數字
  非 canonical exact u64、ordinal 與 metadata+record count 不一致、cutoff
  超出、partial tail 或 prefix 不一致都明確失敗。
- projection row 必須存在；其 physical key 必須是 head physical UUID。
  `next_rollout_ordinal` 與 `next_rollout_byte_offset` 小於 head durable
  前綴是 `projection_lagging`，大於則是 `projection_out_of_range`，只有兩者
  完全相等才可產生 assembly observation。

成功輸出仍固定 `sourceAuthenticated:false`、`publishable:false`、
`historyComplete:false`。它只表示本次選定 row、來源解析、durable LF 摘要與
head projection cursor 彼此相符，**不**表示 caller 提供的 offset 有來源身分或
原子快照證明，更不表示 durable 歷史完整、可 resume、可授權或可發布。只有尚待
接上的同一 admission held-FD scanner／snapshot 邊界，才能建立那些來源證據；本輪
pipeline 目前仍只回傳 plan/resolution 觀測。

## 測試與證據

新增 11 個 Rust focused tests（實際建 oldest→head 三段 plan/resolution）：

- 正向組合及三個 false flags；
- stable state/head locator 不符；
- projection lagging 與 out-of-range 分開拒絕；
- mixed projection byte/ordinal mismatch、durable partial tail、ordinal 不符、
  cutoff 超出前綴拒絕；
- 缺 checkpoint／缺 source evidence 不當成空歷史；
- projection physical key 不符（revert 形狀）拒絕。
- canonical numbers、zero extent、duplicate/over-depth plan、one-sided cutoff
  與未抵達 root 的 ordinal 起點全部拒絕。
- 偽造整鏈合計、zero stored bytes／record count 拒絕。

本輪 focused command：

```sh
cargo +1.97.1 fmt --manifest-path crates/history-source-reader/Cargo.toml --all
cargo +1.97.1 test --manifest-path crates/history-source-reader/Cargo.toml --locked codex_paginated_consistency
```

均通過；主 agent 完整 cargo all-targets 共 194 tests 通過，fmt/clippy 亦通過。這個純模組
沒有宣稱 native differential，因為實際 projection DB、held-FD source scan、
同一 admission/deadline 的 reader 尚未接上。

## 仍待

下一步（1.90 之後）仍要在一個受控 reader admission 內：先從已認證 state row 取得 selected
head，逐一透過既有 opener 產生每段真正的 complete-LF ordinal/offset evidence，
再從同一個 owned `thread_history_1.sqlite` snapshot 讀 head physical projection
checkpoint，最後呼叫本 assembly。仍須補來源與兩個 DB 的共同 snapshot／identity
fence、projection materialization 進度與 ancestor rows 的產品語意、source-version
及 created-ordinal cursor、source catalog 的 ancestry discovery、UI projection、
journal／approval／resume 事件，以及其他 agent adapter；任何缺檔、版面變更、身份變更、
lagging、out-of-range 或 partial tail
都應維持明確 unavailable，不回部分或空歷史。Windows 私有來源仍
unsupported。
