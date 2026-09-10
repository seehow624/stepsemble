# Codex paginated 祖先鏈：解析結果與整鏈預算

2026-09-10／Plan1.85。這批把[鏈計畫](codex-paginated-chain.md)變成**已核對的解析
結果**，並修正一個計畫層的語意錯誤。仍**不是** C2 完成，也沒有接上 Host／Web。

## 修正：切點屬於被繼承的來源

`history_base` 記在**繼承方**的中繼資料裡，但它描述的是**祖先被用到哪裡**。
Plan1.84 誤把切點掛在繼承方身上，驗證時會拿錯誤檔案的大小去比對。
現在每個 planned source 帶的是「**這個來源**貢獻到哪個 exclusive 位置」，
最新的 rollout 則貢獻到結尾（無切點）。

這個錯誤是被**原生差分驗證抓出來的**：修正後 oracle 立刻回報 root 應有切點 `6`
而原本期望 null，正是真實 Codex 繼承時採用的位置。

## 這批做了什麼

新增 `crates/history-source-reader/src/codex_paginated_resolution.rs`：

- 接收依計畫順序（最舊在前）的實際觀測，逐一核對是否與計畫相符。
- **整鏈位元組預算**以 `stored_bytes` 累計，壓縮來源記實際讀取的壓縮大小；
  切點則以 `decoded_bytes` 檢查，因為 ordinal 與 offset 指的是解碼後的位置。
- 驗證每個被繼承的來源**確實包含**它的切點：offset 不得超過解碼長度、
  ordinal 不得超過記錄數，空來源無法滿足切點。

模組**不開檔、不解析記錄**。呼叫端仍逐一透過已認證邊界讀取後回報觀測。

## 明確的邊界

拒絕條件涵蓋：觀測順序錯誤或指向計畫外的 rollout、觀測數量與計畫不符、
切點落在來源之外、被繼承的來源為空、整鏈超過單一 admission 的位元組上限。
輸出永遠帶 `sourceAuthenticated:false`、`historyComplete:false`——
把每個指標都跟到底，只證明指標被跟完，不證明 durable 歷史完整。

## 驗收

Rust crate 全套通過（75 項單元測試）。本模組 7 項涵蓋：正確記錄與位元組合計、
壓縮祖先以壓縮大小計預算但以解碼大小驗切點、切點超出來源（位元組與 ordinal
兩種）拒絕、空來源拒絕、順序錯誤與外來 rollout 拒絕、觀測缺漏與多餘拒絕、
整鏈預算上限。`cargo fmt --check` 與 `cargo clippy -D warnings` 乾淨。

原生差分已更新為正確語意並通過（`matched_native_inherited_record`）。
Node 端 1158 tests／1156 pass／2 Windows-only skip／0 fail 不變。

## 仍待

解析結果目前由呼叫端提供觀測，**尚未接上實際的逐檔開啟**：no-follow／ACL、
逐檔 bounded bytes、zstd 解碼、缺檔與版面改變的處理仍要接既有 capture 能力。
之後才是把 durable complete-LF 範圍與[投影檢查點](codex-paginated-checkpoint.md)
比對以判定落後／不一致／partial-tail、獨立 source-version 與 created-ordinal
cursor、permissioned parser → named source service → registry／HTTP／peer／
typed Web，以及損壞／取消／超限的三 OS 與 320/390px 實測。
Windows 私有來源仍 unsupported。

