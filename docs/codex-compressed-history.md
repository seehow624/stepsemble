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

## 本機驗證（執行過程；最終 CI 見下節）

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

## Exact CI 初次結果與重驗

工程 `a2af9f64853313210868798b25439fd815ae4fb0` 已推 master：
一般34300956326、nativeCodex34300956330、nativeClaude34300956333、rolling34300956363
均success；reader34300956349的Mac、Windows與RustSec通，Linux job102307551204在
真Host測試中被runner shutdown signal中斷，exit143，**非 assertion failure**。
完整第一attempt log保存`/tmp/stepsemble-compressed-ci-reader-attempt-1.log`，Linux單job
完整log另存`...-ci-linux-reader-2.log`。只重跑該Linux job，不變更SHA、放寬測試或
把第一次失敗消掉；其最終結果與完整CI核對仍待記錄。不是正式3.0.6或72h結果。

第二attempt同Linux job102308367558仍在Host步驟被取消（24秒，annotation僅
`The operation was canceled.`，該step cancelled、後續skipped），並非測試通過。
完整log`...-ci-reader-attempt-2.log`保留。兩次同位置中斷，尚不能排除資源／清理問題，
不再僅憑第一次runner訊息當成純平台偶發：補有界stage/elapsed/parent RSS與Linux
**exact owned Host PID**的VmRSS診斷，不掃其他process、不讀環境／對話／憑證，不改
timeout/skip/斷言；待新SHA CI定位及通過。本增量仍進行中。

新增stage診斷後，在同一Mac owned workload重現測試程序RSS由main cleanup的
110,149,632 bytes→expected duplicate-compress rejection後1,344,241,664 bytes，
該段耗時近7秒；完整`...-host-progress-1.log`保留。根因為fixture
`assert.equal(retainedRollout, null)` 在預期失敗時產生整個Buffer的巨大差異。
改 boolean 斷言＋固定短錯誤碼，不格式化原文；restore bytes仍exact equals，
新增固定message及boolean actual回歸斷言。這是測試診斷的資源缺陷，不放寬
產品source/parser/Host限制；Linux兩次中斷可能與此相關，待新CI確認，不再斷言
只是GitHub平台偶發。

本機同workload修正後（host-progress-2.log）：main cleanup110,149,632→mutation
cleanup110,460,928 bytes（85ms），整輪2,979ms／最高stage110,608,384 bytes；最低
Node22.19對照整輪2,737ms／最高stage128,581,632 bytes（host-progress-min-1.log）。
這是測試parent的stage RSS，不是完整採樣峰值或產品Host效能數據；Linux exact owned
Host RSS另由下一CI記錄。所有Host/writer/owned目錄均完成實際清理。

## 最終工程驗收（2026-09-09／未部署）

修正工程 `9820ed2932ecf9beab2fe8ead1179ab90bfc54af` 已推 origin/master。
以下三個受影響 CI 全部 success，完整 logs 已下載核對；初工程失敗的兩個 attempts
仍保留，不用成功重驗改寫歷史，也不宣稱已精確取得 GitHub runner 的 OOM kill 證據。

- [一般 CI 34301665184](https://github.com/seehow624/stepsemble/actions/runs/34301665184)：
  三OS各985 tests／0 fail；Mac983pass/2skip，Linux982/3，Windows935/50。
- [Reader CI 34301665130](https://github.com/seehow624/stepsemble/actions/runs/34301665130)：
  三OS各236 reader＋10 compressed tests，全部通；POSIX Rust29lib/33bin，Windows
  27/15。Windows私人來源仍明示unsupported，Host gate skipped不是功能通過。
  POSIX真Host39筆／原設定／名稱／完整頁／壓縮與cold／失效和錯誤復原通，Host/writer
  已reaped及兩owned目錄移除。Linux成功完成先前中斷的Host步驟和全部後續gates。
  RustSec0.22.2／DB `bf25f6575a93a35f30796c65c0ed91bee7fa19fd`／43packages／
  0known/0warnings；原lock SHA `aa93d9f47ca7b3c38d21b8a5ce4b17b397d9a6c171a71867e82b8979626fca8e`不變。
- [Rolling browser CI 34301665201](https://github.com/seehow624/stepsemble/actions/runs/34301665201)：
  Mac/Linux各原24case＋六個Codex1440/390/320×明暗gate全通，壓縮全部頁／双向版本
  切換／損壞專用提示與復原通。不是實體手機、私人來源或模型驗收。
- 原生Codex34300956330與Claude34300956333仍是工程a2af9f6的success證據；9820ed2
  只改owned測試資源診斷，這兩個workflow未重新觸發，不能標成9820ed2五CI全跑。

Linux真Host整輪4,229ms；測試parent最高觀測stage RSS164,651,008 bytes，main cleanup
→mutation cleanup為180ms，沒有本機修正前的1.344GB巨大差異。exact owned Host的
最高觀測stage RSS85,794,816 bytes；清理後為null。這是合成39筆workload的階段讀值，
**不是完整峰值、產品before/after改善或大型歷史容量驗收**。新Linux結果支持修正測試
資源缺陷的判斷；原runner兩次中斷只有shutdown/cancelled訊息的限制仍保留。

完整新logs：`/tmp/stepsemble-compressed-fixed-ci-{general,reader,rolling}.log`。
本機Host/writer/CUA與所有本輪CI watch／下載程序已結束，沒有未清理的本輪fixture。

下一段仍要完整語義歷史、其餘 Agent、C1–C8 驗收與既有正式發布關卡。

## 接續入口（不重做本增量）

- 本文的小型profile仍是≤8MiB完整單檔；大型plain與compressed已另以有界雙掃、
  新private receipt與既有public分頁接入Host/Web，見
  [Plan1.79大型壓縮](codex-large-compressed-history.md)。不是提高Node整份buffer上限，
  也不是所有大型對話／最大容量已驗；source version、取消及原件不變的界線保留。
- 完整語義：已有 `history-observation.js` 的 API observation，不是 raw rollout
  的完整重建。固定 source 的 `app-server-protocol/src/protocol/thread_history.rs`、
  `thread_history_projection.rs`、`thread-store/src/local/thread_history/read.rs`
  及其 tests 是下一輪入口，需完整讀取選中的檔案後才實作；本輪只定位了路徑。
  不能憑外觀把 synthetic turn ID/工具核准/terminal status 稱為原生能力。
- 各 Agent 的未完項與 C3–C8 仍由 web-completion-loop.md 排序，正式部署照既有關卡。
