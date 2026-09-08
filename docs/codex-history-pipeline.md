# Codex：背景解析與跨 Agent 共用生命週期

2026-09-09／Plan1.61，開發候選仍3.0.7-rc.7，未部署。

## 已做與未做

新增可信Host內部`createCodexHistoryPipeline`：將既有Rust成組capture的bytes交給
短生命週期Node子程序，解析選定legacy rollout及名稱索引。強制使用caller持有、
與Claude content/inventory相同的`createReaderAdmission`，沒有各adapter另開額度。

**不是新的Codex來源授權、registry、HTTP或Web adapter**。呼叫者仍須選定及授權
精確root/locator/readers，以signal撤銷在途工作，並在發布前復核binding世代與權限。
回覆的composite sourceVersion是Host-private描述，不是可直接公開的opaque token。
`nativeTitleResolved`、`sourceAuthenticated`、`publishable`、`semanticHistoryComplete`
仍全false；SQLite最終名稱來源、壓縮/reference/paginated與完整原生投影尚未補完。

## 一份額度跨越所有階段

```text
Host持有的shared admission（共2份，無隱藏等待佇列）
  ├─ Claude content／inventory（既有實作）
  └─ Codex selected read
       取得1份 → Rust capture → Rust actual close → parser → parser actual close
                └────────────── 額度持續保留 ──────────────────┘
```

- 整次操作一個10秒deadline、1秒cleanup窗口；兩個固定helper slot不因失敗重建。
  取消停止原工作，不重送；stdout或exit事件不能單獨釋放額度或回成功。
- SIGKILL只送給該次已啟動的精確child；actual close後才發布。啟動瞬間撤銷、
  晚到成功回覆、stderr/error/過量輸出與來源版本變更都不能繞過判定。
- cleanup無法確認時永久quarantine共享admission、取消其他consumer、保留未知
  佔用。晚到close可釋放實體佔用，但不能解除quarantine或用新pipeline繞過。
- 關閉單一pipeline不關掉Host其他consumer；Host關閉shared admission才取消全部。
  Windows來源reader仍明示unsupported；Node bytes parser可跑不代表Windows來源可用。

## 有界 bytes-only 子程序

內部parser wire v1不同於Rust capture v3。4-byte header length＋最多16KiB header，
後接rollout與index各最多8MiB原始bytes；輸出最多416KiB／4096chunks。子程序核對
nonce、固定版本、各段長度及SHA後才解析；parent不JSON stringify整份16MiB transcript。
header沒有絕對來源讀取路徑，但**原文中原有路徑仍作為惰性bytes保留**，不是讀取授權。

只給六個固定程式檔的Node read permission，沒有廣域source read、write或child spawn
permission；env只LANG/LC_ALL，不繼承帳號或第三方route。這是受信任程式的Node權限
限制，**不是OS sandbox或網路隔離**，也沒有宣稱任意不受信任程式碼可安全執行。
本worker沒有native CLI、模型或網路呼叫。128MiB是V8 old-space限制，不是整體RSS硬上限。

names與records兩種selection都先驗完整選定legacy rollout，thread mismatch、unknown
mode或paginated仍unavailable；不是名稱模式可以跳過來源格式驗證。名稱保留單筆／
列表候選差異。raw頁仍最多50筆／272KiB，parent逐筆核SHA/byte range並比對captured
原始bytes；不把released worker-local snapshot handle跨程序公開。每頁仍重capture/
重parse，以expectedVersion擋stale；**尚無跨頁快取或最終名稱權威**。

## 驗證

- 22個新Node tests；完整本機845＝843pass/2skip/0fail，最低Node22.19聚焦114/114。
  覆蓋兩階段取消、啟動重入取消、deadline、close前不發布、unknown cleanup隔離全域、
  stale rollout/index、getter/shared-memory/extra fields、nonce/bytes偽造、超量stderr/
  stdout、未知模式及真permissioned child拒絕FS/child權限。
- 最低Node22.19實際Rust→parser與固定Claude SDK0.3.259／native2.1.259同額度並行；
  inventory第三個要求busy且不spawn。實體max2、remaining0、29次child啟動，exact raw
  頁逐byte還原並保留3筆transient事件；改index後只capture一次即拒stale，不啟parser。
  實際parser取消後cleanup確認，pre-abort零spawn。3份自建來源測後回到原bytes。
- 此新runner由`check-native-history-pipeline.mjs`的`codexPipeline`欄位獨立回報，
  舊Claude actualHost/sourceGroups/metadata/setup與HTTP仍跑；**不是Codex HTTP驗收**。
  固定SDK checksum由外層驗證，Rust無修改，沿用Plan1.59本機debug artifact
  SHA`e2fde5aa7f906aeb0f2476778bb753f4cef5402bab6a2a85ad34d84bbb2ed65a`。
- syntax/strict TS/generated/version/Ajv1251/actionlint通。原始22tests之前的20tests亦通；
  初始worker測試一個錯誤斷言把「header不給來源路徑」誤寫成「transcript不得有路徑」，
  已改成兩者分驗：header無來源grant、原文路徑不刪。不是發現或修復私人路徑外洩；
  首次失敗TAP保留。

本機完整logs：`/tmp/stepsemble-codex-pipeline-{full-final.tap,minimum-final.tap,
actual-first.json,actual-first.err}`；前期worker測試logs同prefix的`worker-first.tap`／
`worker-second.tap`。實際pipeline只用owned fixtures，private/model/nativeCodex launches均0。

### 同工作負載的主要執行緒探測

Mini／最低Node22.19，8,387,189bytes合成index，三次在同process依序量測直接同步
解析和Rust capture＋背景解析；2ms計時器觀察main-loop gap，無CI硬編時間閾值。

| 輪次 | 同步耗時 / 最大loop gap | 背景整次耗時 / 最大loop gap |
| --- | --- | --- |
| 1 | 91.71 / 93.22 ms | 759.93 / 6.71 ms |
| 2 | 85.22 / 86.55 ms | 763.84 / 8.41 ms |
| 3 | 93.14 / 94.45 ms | 756.55 / 6.22 ms |

背景版本減少此測試的main-loop阻塞，但包含I/O及IPC，**總耗時更長**；不是吞吐加速、
Web Core Vitals或Host完整效能驗收。RSS/長期記憶體、跨頁快取、逐列名稱重讀、
同時長串流和真手機互動仍須後續量測；本批沒有以此宣稱C6已完成。

### Exact CI

工程`f92b2f5d9e35782e9526387e96ae2d447f0c3c89`首批一般CI34255155653的Mac/Linux
通845/0fail，Windows與reader34255155692聚焦suite同一斷言失敗：JSON內Windows
路徑的反斜線已合法跳脫，測試卻用未跳脫原路徑比對。不是parser丟失原文；修正以
JSON literal比對，所有平台再同測Windows/POSIX路徑及完整rollout byte equality。
最低Node22項通，沒有skip/delete失敗case或更改runtime讓測試過；原始failure logs
`/tmp/stepsemble-codex-pipeline-{general-first,windows-first}.log`保留。修正SHA CI待核。

首批native [34255155675](https://github.com/seehow624/stepsemble/actions/runs/34255155675)
三OS真固定CLI通、完整logs核實：各17name cases/19原檔不變，raw113頁/219records/
3transient/model0/loaded0/cleanup通；原本native投影缺項及paginated限制仍保留。
reader workflow新script/test paths與114項聚焦suite，POSIX實際跨harness管線；
Windows的實際unsupported gate已通，不能當Windows來源成功。

## 下一步

先驗owned SQLite title優先來源及DB/WAL一致性，再補explicit Codex source config/
精確locator inventory、同Host shared admission下的registry/opaque version/HTTP/Web。
需要bounded revision cache減少逐頁完整重讀，不能用快取越過權限或stale檢查。
C1–C8整體仍未完成。正式3.0.6、B+、私人root/readers、登入/route與獨立72h不變；
本批新runtime不能繼承凍結版本的長測。
