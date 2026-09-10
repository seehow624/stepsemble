# Codex paginated 祖先鏈：依計畫逐檔開啟

2026-09-11／Plan1.86（C2）。這批把[鏈計畫](codex-paginated-chain.md)接到既有
POSIX Codex source opener：依最舊到最新的順序實際讀完每個 rollout，建立
`codex_paginated_resolution::Observed`，再呼叫[解析結果](codex-paginated-resolution.md)
的 `resolve()`。仍不是 C2 全部完成，也沒有接上 Host／Web 或正式服務。

## 這批做了什麼

- 新增 binary protocol 15 的 owned-only adapter（`src/codex_paginated.rs`）。輸入帶
  已由 caller 解析的每個 `session_meta`、其實際 repository-relative locator、stable
  thread ID 與 selected physical rollout ID；adapter 重新以既有 ancestry／chain 模組
  產生計畫，不接受 caller 傳入未驗證的順序。
- 逐一依計畫讀取來源，祖先先於最新 rollout。每個 locator 都以自身檔名的 stable prefix
  驗證，並把 `_physical` suffix 綁到計畫的 physical rollout ID；最新檔案仍用 selected
  stable thread ID。這同時涵蓋 head 與 ancestor 自身 revert，不把 stable ID 當檔案 UUID。
- 每個來源都呼叫既有 `posix::codex` 的 held-FD 邊界：root identity、逐 component
  `openat(O_NOFOLLOW)`、owner/mode、ACL、local filesystem、regular-file／hardlink、
  fixed compressed-sibling 選擇、name edge、before／between／after identity 複核，
  以及 actual close。沒有透過 path 讀取或另寫一套 opener。
- 建計畫時使用的第一筆 `session_meta` bytes 會在同一次完整雙掃後與來源 offset 0
  的第一筆逐字比對；caller 若帶入 stale／不同內容，即使來源摘要看似合理也回
  `source_changed`，不產生部分 resolution。
- paginated source 使用 opaque byte scanner，不套用會拒絕 `history_mode: paginated`
  的 legacy envelope validator。plain 與 zstd 都做完整雙掃、LF tail／record／來源上限
  檢查；zstd 以 bounded streaming decoder 讀完所有 frame，不把解壓內容寫回來源。
  每次只保留一筆 page observation，完整摘要仍涵蓋整個來源。
- `stored_bytes` 取 held physical file 的大小並在每檔讀取前套用整鏈剩餘預算；
  compressed 檔以壓縮後大小計算。`decoded_bytes` 與 `record_count` 取完整 plain／
  解壓摘要；stored 與 decoded 各自有整鏈剩餘預算，不能以小 zstd 檔案繞過解碼上限。
- 第一掃描會逐筆解析 top-level `ordinal`（包含 metadata），要求起始 ordinal 等於該檔
  metadata 的 ordinal、後續連續遞增、無 duplicate key／u64 溢位；若有 ancestry cutoff，
  只在對應 ordinal 的完整 LF 行尾與 `end_byte_offset` 完全相等時標記驗證成功。
  `record_count` 僅是來源內筆數，不再拿來冒充 global ordinal。
- 任何一檔超出 stored／decoded 剩餘預算都在開始讀取前回明確錯誤（分別為
  `paginated_resolution_bytes_exceeded`、`paginated_resolution_decoded_bytes_exceeded`）。

## 拒絕與輸出邊界

缺檔、非 regular／symlink／hardlink、ACL／owner／mount 不符、root 或 source identity
改變、plain/zstd layout 改變、zstd frame 損壞、incomplete tail、metadata／history_base
duplicate key、ordinal 不符／切點未驗證、record／來源超限與整鏈 stored／decoded 預算超限，
全部回明確 `source_unavailable`
code；不轉成空歷史，也不回傳已讀的部分鏈。來源錯誤會在下一檔前停止，`resolve()` 只有
在所有 planned source 都成功觀察後才會被呼叫。

成功 frame 的 kind 是 `native_codex_paginated_resolution`，包含 plan、每檔 decoded／
stored 數字（十進位字串）與 resolution；`sourceAuthenticated:false`、
`publishable:false`、`historyComplete:false` 永遠固定。這只證明本次依計畫完成受控
讀取與切點範圍檢查，不是來源授權、durable 完整性或可 resume／approval 證明。

## 驗收證據

本機（OneStep-MacMini，owned fixture）執行：

```sh
cargo +1.97.1 fmt --manifest-path crates/history-source-reader/Cargo.toml --all -- --check
cargo +1.97.1 clippy --manifest-path crates/history-source-reader/Cargo.toml --locked --all-targets -- -D warnings
cargo +1.97.1 test --manifest-path crates/history-source-reader/Cargo.toml --locked --all-targets
cargo +1.97.1 build --manifest-path crates/history-source-reader/Cargo.toml --locked --bin stepsemble-history-source-reader --bin ancestry-probe
STEPSEMBLE_ANCESTRY_PROBE=$(pwd)/crates/history-source-reader/target/debug/ancestry-probe \
STEPSEMBLE_PAGINATED_RESOLUTION_PROBE=$(pwd)/crates/history-source-reader/target/debug/stepsemble-history-source-reader \
node scripts/check-native-codex-paginated.mjs /opt/homebrew/bin/codex
```

Rust all-targets 共 183 tests 通過（library 84、binary 59、整合 3＋10＋11＋16）；新增 owned POSIX 測試
實際讀取 archived zstd ancestor、active plain head，以及 ancestor 自身 stable_physical
revert，確認 physical／decoded 大小、ordinal 切點、順序與兩層 false flags。真 Codex
0.153.4 oracle 回報：
`ancestryDifferential: matched_native_inherited_record`、
`resolutionDifferential: matched_native_planned_source_openings`、
`resolutionNegativeControl: mismatch_rejected`；後者是刻意反轉期望來源順序後確認
差分斷言會失敗，再恢復正確期望；差分同時比對每檔 stat stored bytes、decoded bytes、
record count 與整鏈合計，避免探針空跑。owned native／helper／fixture 結束後
`remainingChildren:0`、`cleanupConfirmed:true`，沒有讀取私人 `~/.codex` 或呼叫模型。

## 仍待

這批仍只完成來源逐檔 acquisition 與受控 observation：尚未把 state 的 selected row、
`thread_history_1.sqlite` projection checkpoint 與每段 durable complete-LF 摘要在同一
reader admission 內合併判定落後／partial-tail，也尚未提供獨立 source-version、
created-ordinal cursor、permissioned parser → source service → registry／HTTP／peer／
typed Web。三 OS／320／390px 產品鏈、原生完整語義、真機與帳號／部署 gate 仍獨立；
Windows 私有來源維持明示 unsupported。
