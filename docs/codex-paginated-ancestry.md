# Codex paginated 祖先鏈：受控解析與原生差分

2026-09-10／Plan1.83。這批完成[上一段清單](codex-paginated-history.md)第 2 項的
**祖先指標解析與鏈結**，仍**不是** C2 完成，也沒有接上 Host／Web 或正式服務。

## 為什麼需要

paginated 對話可以繼承另一個 rollout 的前綴。繼承方在自己的 `session_meta`
記下 `history_base`，指名來源 rollout 以及停止繼承的 **exclusive** ordinal 與
byte offset。沒有這層解析，就無法從一個子對話往上追出完整的來源檔案集合，
也無法把**穩定對話 ID** 與**實際 rollout 檔案 ID** 分開（revert 之後兩者會不同）。

既有的 legacy envelope 驗證器一遇到 `history_mode: paginated` 就整份拒絕，
所以這裡新增平行模組，不放寬也不改動原本的 legacy 拒絕條件。

## 這批做了什麼

新增 `crates/history-source-reader/src/codex_paginated_ancestry.rs`：

- `read_claim` 讀**單一筆** `session_meta` 記錄，取出該 rollout 自己的 ID 與
  `history_base`；metadata ordinal 必須是 root 的 `0`，或等於自身
  `history_base.end_ordinal_exclusive`。整份檔案餵進來會失敗，不會只默默解析第一行。
- 以遞迴 JSON duplicate-key detector 保護 `type`／`payload`／`id`／`history_mode`／
  `history_base` 及其三個 cutoff 欄位；未知 metadata 欄位仍可保留，但重複控制欄位
  不會被 last-key-wins 悄悄覆蓋。
- `link` 把呼叫端逐一解析出的 claim 串成鏈，強制每一步真的對應前一個 link
  指名的祖先，並擋掉環（含自我指向）、超過深度 64、根之後還有多餘 link。
- `reached_root` 只表示最後一個 link 不再指名祖先。呼叫端提早停止時為 false，
  兩種情況都**不是**歷史完整性證明。

模組只解析與鏈結，**不開檔、不跟隨路徑、不決定鏈是否完整**。每個 rollout
仍由呼叫端透過已認證的來源邊界解析後提供位元組。

## 明確的邊界

`history_base` 形狀必須**完全相符**（恰好三個欄位、UUID、非負整數），
多一個欄位就拒絕，因為未知欄位可能改變繼承的意義。ordinal 與 byte offset
以字串保存精確整數，超過雙精度範圍（9007199254740993）仍完整保留。
輸出永遠帶 `sourceAuthenticated:false`、`historyComplete:false`。
legacy 或缺少 `history_mode` 的記錄回 `HistoryModeUnsupported`，交還給原本的驗證器。

## 驗收

Rust crate focused ancestry tests 17 項通過（含 metadata ordinal/base 關係、duplicate
控制欄位、根／繼承讀取、大整數精確、跨對話記錄拒絕、legacy 歸屬、畸形
`history_base`、非 metadata／壞 UTF-8、完整鏈結、提早停止、祖先不符、環與超深）。
`cargo fmt --check` 與 `cargo clippy -D warnings` 乾淨。

**最重要的證據是原生差分**：`scripts/check-native-codex-paginated.mjs` 現在把
真實 Codex 0.153.4 **實際繼承過的那筆記錄**餵給 Rust 解析器（owned probe
`src/bin/ancestry-probe.rs`，只吃 stdin 位元組、不開任何檔案），要求取出的
祖先指標與原生繼承行為完全一致，輸出 `ancestryDifferential`。
本機以真 binary 執行通過（`matched_native_inherited_record`）；
刻意把期望值改錯會如預期失敗（`Rust ancestry parser disagrees with the record
native inherited from`），確認這個檢查不是空跑。已接入既有三 OS
`native-codex-history.yml`，探針在該工作流程中一併編譯。

本輪未重跑 Node 全套；Rust 與 native owned differential 證據如上。

## 仍待

祖先鏈仍只是**指標關係**；Plan1.86 已由[逐檔開啟 adapter](codex-paginated-opening.md)
依鏈計畫實際取得每個祖先檔案（active/archive、plain/zstd 版面、no-follow／ACL／
bounded bytes）；`read_claim_with_metadata_id` 將 stable metadata ID 與 physical rollout
ID 分開核對，要求第一筆為單筆完整 LF；開啟端再逐筆核對 ordinal 與 exact cutoff byte，
在所有來源成功後產生 Observed、呼叫 resolution；
把 durable complete-LF 範圍與[投影檢查點](codex-paginated-checkpoint.md)實際比對
以判定落後／不一致／partial-tail；獨立 source-version／created-ordinal cursor；
permissioned parser → named source service → registry／HTTP／peer／typed Web；
以及損壞／版本變更／取消／超限的三 OS 與 320/390px 實測。
Windows 私有來源仍 unsupported。
