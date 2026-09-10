# Codex paginated 祖先鏈：解析計畫與整體預算

2026-09-10／Plan1.84。這批完成[上一段清單](codex-paginated-history.md)第 2 項的
**鏈層級解析計畫**，仍**不是** C2 完成，也沒有接上 Host／Web 或正式服務。

## 為什麼需要

[祖先鏈解析](codex-paginated-ancestry.md)處理的是單一 rollout 的繼承指標。
要真的把一段歷史讀回來，還需要決定**依什麼順序取哪些檔案**，以及整條鏈
總共可以讀多少位元組。少了這層，繼承關係會變成繞過單一來源上限的途徑。

## 這批做了什麼

新增 `crates/history-source-reader/src/codex_paginated_chain.rs`，把選定的
rollout 與其祖先轉成**有界、有序的解析計畫**：

- 順序為**最舊在前**，讓繼承來的記錄依原始順序抵達。
- 每個 planned source 帶自己的 locator、是否壓縮、是否封存，以及該連結停止
  貢獻的 exclusive ordinal／byte offset（只有繼承方才有切點）。
- 整條鏈共用單一來源同等的位元組上限（`CHAIN_BYTES`，256 MiB）。
  `accumulate` 讓呼叫端在讀每個來源前累計，超出即停止而非回傳部分結果。

同時把 locator 規則抽到 `codex_locator.rs`，讓請求解析與鏈計畫共用**同一份**
規則，不再各存一份可能分岔的複本。既有 locator 測試維持通過。

## 明確的邊界

模組**不開檔**。每個 rollout 仍由呼叫端逐一透過已認證的來源邊界取得，
計畫只說明要取哪些、順序與預算。

拒絕條件涵蓋：locator 與其 rollout 不符、路徑逃逸或形狀錯誤、同一個實體檔案
在鏈中出現兩次、切點沒有嚴格往前推移（等於或更後面代表宣稱重疊歷史）、
鏈頭不是呼叫端選定的 rollout、locator 數量與連結數不符。
輸出永遠帶 `sourceAuthenticated:false`、`historyComplete:false`。

**revert 情境**特別處理：還原後最新 rollout 有自己的 UUID，但呼叫端選的仍是
穩定 thread ID，其 locator 也以該 thread 命名。計畫保留穩定 ID，並以鏈頭比對
實際 rollout ID，不假設兩者相等。

## 驗收

Rust crate 全套通過（68 項單元測試）。本模組 10 項涵蓋：正確排序與切點、
revert 後穩定 ID 與實體檔案分離、封存／壓縮版面如實回報且不改寫 locator、
重疊繼承（等於與更後面）拒絕、locator 指向錯誤 rollout 拒絕、五種畸形或逃逸
路徑拒絕、同檔重複拒絕、鏈頭不符拒絕、locator 缺漏拒絕、位元組累計與上限。
`cargo fmt --check` 與 `cargo clippy -D warnings` 乾淨。

**原生差分已擴充到計畫層**：owned probe 現在也回傳計畫，
`scripts/check-native-codex-paginated.mjs` 用真實 Codex 0.153.4 **實際儲存的
locator** 驗證排程順序與切點與原生繼承行為一致。刻意把順序期望改反會如預期
失敗，確認不是空跑。已接三 OS `native-codex-history.yml`。

Node 端 1158 tests／1156 pass／2 Windows-only skip／0 fail 不變。

## 仍待

計畫產出後，**尚未實際依計畫開啟每個祖先檔案**：no-follow／ACL／bounded bytes
的逐檔解析、plain 與 zstd 解碼、缺檔或版面改變的處理。之後才是把 durable
complete-LF 範圍與[投影檢查點](codex-paginated-checkpoint.md)比對以判定落後／
不一致／partial-tail、獨立 source-version 與 created-ordinal cursor、
permissioned parser → named source service → registry／HTTP／peer／typed Web，
以及損壞／取消／超限的三 OS 與 320/390px 實測。Windows 私有來源仍 unsupported。

