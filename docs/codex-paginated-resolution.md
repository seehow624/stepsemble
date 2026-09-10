# Codex paginated 祖先鏈：解析結果與整鏈預算

2026-09-11／Plan1.86。這批把[鏈計畫](codex-paginated-chain.md)變成**已核對的解析
結果**，並修正一個計畫層的語意錯誤；逐檔 acquisition 與實際 ordinal 掃描見
[逐檔開啟](codex-paginated-opening.md)。
仍**不是** C2 完成，也沒有接上 Host／Web。

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
- **整鏈 stored 預算**以 `stored_bytes` 累計，壓縮來源記實際讀取的壓縮大小；另以
  `decoded_bytes` 維持獨立整鏈上限，避免 zstd 小檔案繞過解碼 admission。
- 驗證每個被繼承的來源**確實包含**它的切點：opening adapter 已逐筆掃描 global
  ordinal，將 exclusive ordinal 對到完整 LF 行尾的 decoded byte offset；resolver
  只接受這個 per-record 證據，不把 local `record_count` 當 ordinal。
- 無效 cutoff（`endOrdinalExclusive`／`endByteOffset` 非成對或非精確整數）及未提供
  ordinal 證據都明確拒絕；空來源無法滿足切點。

模組**不開檔、不解析記錄**。呼叫端仍逐一透過已認證邊界讀取後回報觀測。

## 明確的邊界

拒絕條件涵蓋：觀測順序錯誤或指向計畫外的 rollout、觀測數量與計畫不符、
無效／半缺 cutoff、切點落在來源之外、ordinal 對應未驗證、被繼承的來源為空、整鏈
stored 或 decoded 超過單一 admission 上限。
輸出永遠帶 `sourceAuthenticated:false`、`historyComplete:false`——
把每個指標都跟到底，只證明指標被跟完，不證明 durable 歷史完整。

## 驗收

Rust library 84 項、binary 59 項 focused tests 通過；本模組涵蓋 stored／decoded
整鏈上限、逐筆 ordinal 證據、無效 cutoff 形狀、空來源、順序／外來 rollout、觀測
缺漏與多餘拒絕。`cargo fmt --check` 與 `cargo clippy -D warnings` 乾淨。

原生差分已更新為正確語意並通過（`matched_native_inherited_record`）。
本輪未重跑 Node 全套；另以 owned fixture 對 native 0.153.4 做差分，證據見逐檔開啟文件。

## 仍待

解析結果目前由逐檔 adapter 提供觀測；`codex-paginated-opening.md` 已把 no-follow／ACL、
逐檔 bounded bytes、zstd 解碼、缺檔與版面改變接到既有 capture 能力，並以逐筆 global
ordinal 與 exact LF 行尾驗證 ancestry cutoff（不以 local `record_count` 代替）。仍待把 durable
complete-LF 範圍與[投影檢查點](codex-paginated-checkpoint.md)
比對以判定落後／不一致／partial-tail、獨立 source-version 與 created-ordinal
cursor；無效／半缺 cutoff、metadata duplicate key 會先拒絕，不會被 `None` 當成無切點；
permissioned parser → named source service → registry／HTTP／peer／
typed Web，以及損壞／取消／超限的三 OS 與 320/390px 實測。
Windows 私有來源仍 unsupported。
