# 大型 Codex 壓縮歷史：有界讀取與完整產品接線

2026-09-09／Plan1.79，開發中的 rc.7，**本機產品驗收已通，exact提交的CI待核；未正式部署**。
前一已驗提交為 `46bca82`；C1–C8完整範圍與正式啟用關卡不變。

## 實際缺口

隔離的真 Host、owned SQLite writer 與公開 typed Web model：同一份16,384筆、
17,150,545 bytes歷史，plain可透過既有大型profile正常顯示；改成concatenated
Zstandard後，refresh回`source_unavailable/rollout_compression_limit`，畫面failed/stale。
這不是Claude登入、GitHub或session名稱改動。原小型parser只允許8MiB整份解壓結果。
測試來源、Host與writer均已清理，沒有使用私人歷史、模型或真帳號。

不提高Node整份buffer上限；以Rust串流解壓接既有逐筆全來源驗證與單頁留存。
底層仍是唯讀觀察，不會啟用對話、訂閱事件或發送模型請求。
官方[`thread/read`文件](https://learn.chatgpt.com/zh-Hant/docs/app-server)同樣區分讀歷史
與resume；本文的pinned來源檔案格式與官方RPC完整投影能力仍是兩個不同界線。

格式以Codex0.153.4、commit `3d2ee51ca2d5db578f328aa75e20aa22c0197c9a`為依據：
[`compression.rs`](https://github.com/openai/codex/blob/3d2ee51ca2d5db578f328aa75e20aa22c0197c9a/codex-rs/rollout/src/compression.rs)
的writer使用zstd stream encoder並聲明來源長度；
[`seekable_reader.rs`](https://github.com/openai/codex/blob/3d2ee51ca2d5db578f328aa75e20aa22c0197c9a/codex-rs/rollout/src/seekable_reader.rs)
保留plain-first、concatenated first-frame長度只是lower bound。官方seekable reader
會使用anonymous tempfile，本實作不複製這個行為，改成兩輪串流驗證與單頁留存。
本repo鎖定zstd0.13.3、zstd-safe7.3.0、zstd-sys2.1.0+zstd1.5.7；不能把它們冒稱
與pinned Codex的transitive lock完全相同。

## 協定與語言邊界

| 層 | 新能力 | 不變的界線 |
| --- | --- | --- |
| Rust source helper | native13 raw／14 selected-global structure；固定zstd0.13.3 | 舊9–12獨立、POSIX權限與held-FD檢查；Windows來源unsupported |
| Private receipt | `physical`檔案identity/hash；`decoded`長度/hash/recordCount/frames | 不用解壓長度冒充實體inode.size；全檔hash不從選中頁推算 |
| Permissioned parser | parser11/12 raw unnamed/named；13/14 structured unnamed/named | 只收decoded選中頁、name index、sideband；不能讀來源目錄、spawn或寫入 |
| Named pipeline | fresh encoding probe後改13/14；續頁直接同encoding | 同一permit與10秒deadline；actual-close、版本前後核對、unknown-cleanup quarantine |
| HTTP／Web | 沿用既有大型raw/structured public profile | opaque version綁定新private proof；不公開physical path或賦予resume/approval |

新private版本是`codex_compressed_validated_source_version`及
`codex_compressed_structured_source_version`；後者另綁`structureProfile`。
各版本有nativeVersion/threadId/rolloutPath/rootIdentity/storage、physical、decoded、
validation與nameIndex。舊plain版本與新compressed版本不可互相匹配。

physical與decoded屬不同欄位域，**不代表兩個數值必須不相等**。Node可驗證shape、
選中bytes、跨讀取版本與不混用的座標，不能由一頁重算整個來源的hash或證明原生真實性。
完整摘要屬受控helper的觀察；`sourceAuthenticated`、`publishable`、
`recordSemanticsValidated`、`semanticHistoryComplete`保持false。

## 資源、來源與取消

- physical／decoded各最多256MiB；record最多128KiB／262,144筆。
- Zstandard window最多8MiB、frames最多256（含skippable）、blocks最多65,536。
- 單頁最多50筆／256KiB；structure sideband最多512KiB，name index沿既有8MiB。
- 第一次掃描未知decoded長度但有上限；第二次須匹配第一次完整摘要。不為預知長度
  額外預解壓整份，不建立解壓tempfile、不reopen或duplicate來源FD。
- 原根目錄、euid/mode、ACL、single-link、local-filesystem、no-follow、name-edge、
  index存在性及前後identity檢查沿用；兩輪physical/decoded摘要均須相符。
- plain sibling仍優先。13/14只接受compressed；開始時plain存在回encodingunsupported，
  已持有compressed版本時Host轉為source_version_changed。捕捉中plain出現拒絕變動。
- 只有fresh大型plain probe回encodingunsupported且實際close後才轉13/14；不新建
  reader pool、queue、permit或deadline，不重試busy/權限/逾時/損壞。
- Web／metadata只有fresh舊容量錯誤（含compression_limit）才協商大型profile一次；
  新decoder仍有同window/frame上限，超限不繼續重試。

## 本機驗收與可重跑入口

- Node22.22.3完整、最低22.19各**1146total／1144pass／2 Windows-only skip／0fail**。
  新wire6、actual permissioned parser8、named pipeline4、Web negotiation1、metadata3
  均實際執行；不是只新增檔案。舊small/plain/structured及共享Claude reader回歸亦通。
- Rust33lib／52bin／10format／11structure／16scanner及owned SQLite程序測試全通；
  fmt、locked build/check、clippy `-D warnings`全通。新concat、末尾zero-length skip、
  unknown content size、checksum/truncation/dictionary/window、raw+structured mutation
  均有測試；不是完整fuzz或256MiB壓縮來源容量證明。
- 真owned Host→HTTP→typed Web model：**17,150,545decoded bytes／16,384records**，
  concat raw/structured逐頁與plain一致，原名及metadata、next/previous/直接跳轉/EOF、
  原始turn/call IDs、跨頁雙向工具、頁外rollback、兩encoding版本拒絕、plain優先、
  頁外decoded損壞與壓縮checksum拒絕、修复均通。19次compressed reads；Host/writer
  reaped、2owned目錄清理，privateHistoryReads/modelCalls皆0。
- 最終release reader SHA256 `74c5b34f0f98ba7332e71acfe70f67240bfd4e2b18c417402348f4dbfc73a2a3`；
  writer `f6cb9e69887bcd16d23e570302f1b93ab8e7ccc78c6af44c75c0886379401a2e`。
  本輪最後Host最大read247.42ms、29個health樣本p95 1.64ms、Host RSS樣本最大
  102,580,224bytes。**200ms採樣不是OS peak、整機容量或混合負載SLO**。
- 同最終artifact的CUA隔離390/320px：無橫溢，原名及16,384筆、工具10001↔4、
  raw/對話切換、連續next/previous、直接EOF4筆、長訊息224px內捲至原文末尾、
  encoding stale提示及恢復、checksum繁中錯誤且保留舊10筆、修復後真正loaded及
  10筆可再翻頁、關閉0筆、warn/error logs空。不是實體iPhone／Safari證據。
  直接跳轉會重設已訪頁stack，previous僅回已訪頁；不以固定10筆反算可變byte-budget頁。
  tab／viewport／Host／writer與owned目錄均已還原清理。
- 最低Node真Rust＋pinned Claude SDK完整pipeline亦通：實際Host/setup/四階段management、
  同shared2 readers、51spawn attempts／remaining0及cleanup通。此gate使用debug reader，
  不混稱上面的release SHA；無真帳號或模型。
- decoded scanner最大256MiB allocator gate通（1KiB records253,050B、128KiB records594,042B）；
  structure最壞calls63,961,832B／turns50,329,486B，drop回基準。**不包含zstd／全Host RSS**。
- RustSec0.22.2真官方DB `b50980aad8b8f14f77e25a97b32dd94bf008b0af`／1243advisories，
  47packages／0known vulnerabilities／0warnings；Cargo.lock SHA256
  `32cf61e8b894c385a85fb16668dfbfcbb0a9f345970b83689802f80b69aa5525`。
  gitleaks僅掃35個本輪變更檔，0findings；不掃其他app或私人HOME。

重跑入口：`npm test`、`cargo test --locked --all-targets`（crate manifest）、
`scripts/check-history-codex-host-native.mjs <release-reader>`、
`scripts/check-native-history-pipeline.mjs --download`（先建成對debug reader／writer）、
兩個新`test/native-codex-compressed-page-*.test.js`及既有named/source-service/view測試。
`scripts/history-codex-browser-cases.mjs`已擴充三尺寸×明暗的大型concat、跨頁structure、
encoding與checksum恢復，**只在CI執行；本提交必要跨平台CI仍需核對完整logs**。

## 本輪原失敗與修正

1. Rust全回歸抓到實際產品回歸：plain v10–12兩輪間Changed／owner-mode錯誤被`?`
   提前轉成I/O。先核對held-reader保存的精確失敗再傳播結果，五個既有race/permission
   案例恢復通過；原red保留，不用重跑偶然綠代替修正。
2. 末尾zero-length skippable恰好在EOF時留在Skip(0)，誤拒絕合法frame；立即normalize，
   1/2/7/64byte分片及真decoder完整capture已驗。先drop第一decoder才建第二個。
3. 未知decoded size越界明確映射compression_limit，而非plain too-large。映射測試通，
   不冒稱已解壓完整256MiB boundary或量得decoder peak。
4. 初版Node測試把physical/decoded不同域誤寫成「hash/size一定不同」，修正為shape拒絕
   及版本變更檢查，不放寬產品。named取消fixture則明確holdReader後再驗actual close。
5. 最低Node完整native首次缺debug example產物而ENOENT；補建owned_sqlite_writer後
   全鏈通過，不屬runtime讀取失敗，也未改release reader。

本機完整紀錄：`/tmp/stepsemble-compressed-{full,minimum}-final.tap`、
`/tmp/stepsemble-compressed-rust-tests-final.log`、`/tmp/stepsemble-compressed-host-final.log`、
`/tmp/stepsemble-compressed-native-final-retry.log`及`/tmp/stepsemble-compressed-rustsec.log`。
原red的rust-tests/clippy、named-first、native-final logs保留供同機交接；不是公開CI artifacts。

## 尚未涵蓋

Codex paginated原生投影、native session/resume/approval、其他agents原生adapter、
完整source-group owner與Web管理、真機／跨Host、全Host peak RSS／最大混合負載、
Windows private reader及正式候選安裝/回滾/部署仍按[C1–C8](web-completion-loop.md)。
8MiB decoder window不是總程序記憶體上限；selected結構索引與SDK peer仍須另量測。
