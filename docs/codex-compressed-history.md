# Codex 壓縮歷史接線 — Plan 1.71

2026-09-09，C2 的下一增量；整個 C1–C8 goal 繼續，**未部署**。
沿用 1.70 的冷 SQLite 與 Host/Web，不改正式 3.0.6、B+ logo、帳號或獨立 72h。

## 依據及實作步驟

1. 固定 Codex 0.153.4 / `3d2ee51ca2d5db578f328aa75e20aa22c0197c9a` 的
   `codex-rs/rollout/src/compression.rs`、`seekable_reader.rs`：plain 優先；plain
   缺少時讀固定 `.jsonl.zst` sibling；可串接 frames。資料庫可能仍保存 plain path。
   只讀邊界參考 [官方 App Server](https://learn.chatgpt.com/docs/app-server) 的
   stored read，不呼叫 resume、修復、解壓回存或任何模型。現行 paginated 不支援的
   gate 不因新版文件而升級。
2. Rust v9 在同一 held parent 解析兩種表示。只有 plain 的 ENOENT 可選 compressed；
   symlink、ACL、mode、空檔案等錯誤不能 fallback。所有 FD/父路徑/選中名稱，以及
   compressed 情況的 plain absence 重驗，兩次 bounded 讀取相同，close 後才傳 bytes。
   v3 契約原樣保留為 `readCodexLegacy`；目前 `readCodex` 使用 v9。
3. 原始實體 bytes 與其 SHA/identity 保持版本依據；v9 新增嚴格 storage descriptor
   （requested path、physical path、encoding 分開）。不是 native authenticity。
4. parser v3/v4 在既有受限 Node child 解壓；舊 v1/v2 不接受新 storage 證據。
   parent 不解壓、不再建一個工作池。raw/named parser 都保留實體版本與解壓後的
   length/SHA/frame count，頁內 offset 以解壓 bytes 為準。
5. 沿用同 Host 兩個 reader 名額、截止時間、kill/actual-close/quarantine；named
   SQL A + physical A → parser → SQL B + physical B，兩種版本相同才發表。
6. 實際 owner→Host→HTTP→typed Web：壓縮來源清單/名稱、全部頁面、cold+compressed、
   plain/compressed 雙向切換失效、損壞拒絕及 plain 恢復；CI 320/390/1440×light/dark。

## 解壓邊界與已發現問題

最低 Node22.19 的實測：直接 `zstdDecompressSync` 只回串接檔案的第一 frame；
截斷 frame/checksum 也可能回傳資料而不報錯。因此不能把它的成功當完整性證據。
先按 [Zstandard v1.5.7 格式](https://raw.githubusercontent.com/facebook/zstd/v1.5.7/doc/zstd_compression_format.md)
掃描 frame/block 完整邊界，再對每 frame 各自解壓，檢查消耗長度及可用的 content-size，
保留預設 checksum 驗證；非法尾端與不完整下一 frame 一律拒絕。

- 實體 rollout ≤8MiB、解壓合計 ≤8MiB、window ≤8MiB、≤256 frames、≤65536 blocks。
- 同時設定 [Node22.19 限額](https://nodejs.org/download/release/v22.19.0/docs/api/zlib.html)：
  `maxOutputLength` 與 `ZSTD_d_windowLogMax=23`，不依賴壓縮比推估。
- 支援 bounded skippable、raw/RLE/compressed blocks、content-size 有/無及多 frame。
- 外部 dictionary ID、reserved flags 明示 unsupported；無外部字典查找。
- 無 native CLI、私人 HOME、來源寫入/臨時解壓檔案或新的 Rust 依賴。
- decoded proof 是可信受限 worker 的輸出，不是 parent 自行重解壓或密碼學 native
  證明；完整語義視圖仍 `semanticHistoryComplete:false`，不假造 resume/approval。

## 本機驗證（exact CI 待執行）

- 第一輪完整 Node984 / 0 fail / 2 skip；Rust29 lib/33 bin 通過；clippy通過。
- 新10組單元案例含實際 permissioned worker、每個截斷 prefix、checksum、串接、
  size/window/dictionary、版本與response形狀。舊 v3 tests 保留。
- 第一輪 Host 發現錯誤碼未加 server allowlist：壓縮損壞被轉成
  `history_transport_failed`；已補 server 與 TypeScript client/i18n，保留原失敗
  `/tmp/stepsemble-compressed-host-1.log`。修正後實際 Host 通過（host-2/3.log）。
- 加入 explicit compressed DB locator 後，最低 Node 初次遇 fixture command allowlist
  漏項（host-min-1.log）；已补兩個固定命令並把 mutation queue 的失敗與實際 close
  分開，新增重複 compress 拒絕後 restore/cleanup 的真 Host gate。沒有放寬產品權限。
- 最低 Node 真 Host 再驗成功（host-min-2.log）：39筆所有頁／名稱、冷+串接壓縮、
  直接 `.zst` catalog path、雙向切換、損壞與plain優先、partial／paginated／unsafe、
  empty、startup與mutation failure復原，Host/writer全close、owned目錄移除。
- 完整 Rust all-targets／SQLite跨程序通，29lib/33bin、179child/83dirs；原actual
  shared pipeline51spawn/max2/remaining0全清理，v3/v9真binary source gate通。
- CUA tab15實際390×844：壓縮39筆名稱、11–20頁、無横溢（scrollWidth=390），
  plain恢復後next停用／原頁保留、手動refresh回1–10，console error空；tab關閉、
  viewport reset、ownedHost27222終止及兩fixture目錄清理。非真iPhone或私人来源。
- `fmt/clippy`、TypeScript generated、syntax/version、Ajv1251、fixedSQLiteartifact、
  actionlint已驗；最後完整及最低Node均985／983pass／2skip／0fail（node-all-3.tap、
  min-node-2.tap）。exact SHA CI 待收尾。

下一段仍要完整語義歷史、其餘 Agent、C1–C8 驗收與既有正式發布關卡。
