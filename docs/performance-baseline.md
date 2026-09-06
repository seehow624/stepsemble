# Stepsemble Host performance baselines

> Baseline A：Pi Harbor 2.13.2（改名前）
> Baseline B：Stepsemble 3.0.0（相容遷移、本機部署與 clean source commit 後）
> Date：2026-09-04
> Host：Darwin 25.6.0、arm64、10 logical CPUs、Node.js v22.22.3
> Raw results：[`2.13.2`](baselines/host-performance-2026-09-04-darwin-arm64.json)；[`3.0.0`](baselines/host-performance-2026-09-04-stepsemble-3.0.0-darwin-arm64.json)

## Purpose

這是 Phase 0 的第一份可重複 Host-side 基線。它用 `scripts/host-performance-baseline.mjs` 建立全新的 local temp `PI_HOME`、合成 Pi JSONL sessions 與假的 allow-listed Claude CLI，再啟動隔離的 Stepsemble server。它不讀真實 session、workspace、provider credential、官方訂閱或 token。

執行：

```bash
npm run benchmark:host
```

每次比較必須保留完整 JSON、app commit、worktree dirty 狀態、`server.js`／benchmark SHA-256、OS/arch、Node 版本與 workload。不同硬體的絕對值不能直接混成同一趨勢；若 `sourceWorktreeDirty=true`，只能把 file hash 相同的結果視為同一實作。

2.13.2 量測執行當下的計畫與 benchmark 尚未提交，因此第一份 raw result 如實記為 `sourceWorktreeDirty=true`。3.0.0 結果是在本機服務成功遷移後、首個 Stepsemble source commit `39e671d1b95f3f72ca76178c44216fbe15ed1cc5` 的乾淨 worktree 上重跑，記為 `sourceWorktreeDirty=false`。兩份結果都保存被測 `server.js` 與 benchmark script 的 SHA-256；3.0.0 已是可只靠 commit 重現的比較點。

## Workload

| Item | Value |
| --- | ---: |
| Project directories | 12 |
| Regular session files | 300 |
| Messages per regular session | 120 |
| Long-session messages | 5,000 |
| Total session files | 301 |
| Warm health requests | 100 |
| Warm session-list requests | 20 |
| Long-session requests | 8 |
| Concurrent generic Agent tasks | 8 |

總 synthetic history 為 41,000 個 message entries，另有 header/session-info entries。Session list明確帶 `includeTemporary=1`，並斷言回傳301個檔案；這避免 temp fixture被產品的Sub Agent filter正確隱藏後，誤留下空資料基線。

## Baseline A：Pi Harbor 2.13.2

| Metric | Result |
| --- | ---: |
| Server startup | 31.272 ms |
| `/api/health` p50 / p95 / p99 | 0.193 / 0.613 / 1.061 ms |
| Session list cold | 93.384 ms |
| Session list warm p50 / p95 | 9.588 / 10.582 ms |
| Long session p50 / p95 | 11.318 / 13.913 ms |
| Invalidated scan | 103.358 ms |
| Health max during invalidated scan | 1.031 ms |
| Generic Agent open | 86.773 ms |
| Generic Agent SSE `connected` | 0.685 ms |
| 8 generic tasks open wall time | 95.462 ms |
| 8-task SSE `connected` p50 / p95 | 0.973 / 1.375 ms |
| Event-loop delay p50 / p95 / max | 10.232 / 18.924 / 19.087 ms |
| RSS idle / after workload | 53.906 / 127.938 MiB |

## Baseline B：Stepsemble 3.0.0

| Metric | Result |
| --- | ---: |
| Server startup | 34.257 ms |
| `/api/health` p50 / p95 / p99 | 0.197 / 0.604 / 1.049 ms |
| Session list cold | 92.812 ms |
| Session list warm p50 / p95 | 9.430 / 10.091 ms |
| Long session p50 / p95 | 9.977 / 13.821 ms |
| Invalidated scan | 102.371 ms |
| Health max during invalidated scan | 1.758 ms |
| Generic Agent open | 85.595 ms |
| Generic Agent SSE `connected` | 0.801 ms |
| 8 generic tasks open wall time | 92.743 ms |
| 8-task SSE `connected` p50 / p95 | 0.985 / 1.663 ms |
| Event-loop delay p50 / p95 / max | 10.084 / 18.760 / 20.120 ms |
| RSS idle / after workload | 53.844 / 132.781 MiB |

改名前後沒有看到具實務意義的 Host regression：health p95、cold/warm session、long session、generic open、8-task open 與 invalidated scan 都持平或略快；startup 增加 2.985 ms。8-task SSE p95 從 1.375 ms 到 1.663 ms，絕對差 0.288 ms；scan 期間 health max 增加 0.727 ms，仍遠低於 control API 的 100 ms 初始門檻。After-workload RSS 增加約 4.8 MiB，需以多輪/soak 才能判定是否為趨勢。

## Reading the result correctly

- 這台開發機、local temp filesystem 上兩版的 health 與 warm read paths 都符合目前主計畫的普通 control API p95 <100 ms 初始目標。
- Cold list與invalidated scan約100 ms，後者已略超過目標邊界；這是fast local storage結果，不能推論SMB、外接碟或數千session也安全。
- Scan期間health response最高約1 ms，代表此特定fixture裡async file streaming有讓event loop持續服務；它不能消除sync directory/stat與`execFileSync`在慢 filesystem/Git上的已知風險。
- 8個generic task可並行啟動並取得各自SSE readiness；這仍未測slow consumer、真實CLI輸出洪峰或72小時存活。
- 兩版 RSS 都由約 54 MiB 升至約 128–130 MiB，包含 session cache、JSON parsing、response buffers、task metadata 與尚未強制 GC 的正常高水位；單次結果不能判定 memory leak。後續需要 repeat/soak 觀察是否持續上升。
- Event-loop utilization 約 0.72–0.73，來自 benchmark 刻意不停送 health probe，不代表一般 idle 負載。
- Generic SSE數據只驗證舊 Node supervisor與stream handshake；假的Claude CLI不代表Claude Code官方session、approval或訂閱路徑已驗證。

## Browser baseline follow-up (2026-09-05)

Chrome DevTools MCP is now configured and real browser measurements are recorded
in [browser-performance-baseline.md](browser-performance-baseline.md), with
[returned MCP evidence](baselines/browser-performance-2026-09-05.json). Desktop
long-session interaction and mobile restore are measured failures for Phase 2.
Standardized TBT and downloadable full trace exports remain explicit gaps.
The following section preserves the historical setup limitation at the time of
the Host-only baseline; it is no longer a request to install the MCP again.

## Original browser limitation (historical)

本次環境沒有 `chrome-devtools` MCP，依web performance audit規則不能聲稱LCP、FCP、CLS、INP、TBT、network waterfall或accessibility trace結果。配置後應在同一版本補做：

```json
"chrome-devtools": {
  "type": "local",
  "command": ["npx", "-y", "chrome-devtools-mcp@latest"]
}
```

在browser trace完成前，Phase 0 Host基線可視為完成，但Web順滑度驗收仍是明確的open item；Phase 2不能只用這份server數據結案。

## Next comparisons

至少在以下變更前後重跑同一script：

- Session index/async filesystem改造。
- `execFileSync` Git/worktree移除。
- TypeScript Client SDK接管network/replay。
- Rust shadow daemon與Rust runtime切換。
- 1/4/8/16 concurrent tasks、slow SSE consumer與72-hour soak專用bench加入時。

## 2026-09-06: clean 3.0.6 candidate

Exact source `331b9f0`, clean worktree, Node22.22.3 on the same Darwin25.6.0
arm64 host: [raw result](baselines/host-performance-2026-09-06-stepsemble-3.0.6-darwin-arm64.json).
The benchmark/parser have changed since the original 3.0.0 measurement; do not
attribute every difference to the 3.0.6 stop fix or combine runs as a percentile.

- Warm health p95:0.771ms; warm session list p95:13.938ms; long history p95:18.655ms.
- Cold list:139.666ms; invalidated scan:138.358ms; concurrent health max:1.304ms.
  Cold reads still exceed the plan's initial100ms control target; slow disks and
  much larger histories remain unverified.
- Eight synthetic generic tasks opened in104.605ms, SSE handshake p95:7.342ms,
  all stopped through the confirmed-exit API; no real provider/model used.
- Event-loop delay p95:13.099ms/max22.512ms; RSS idle54.656/loaded97.719MiB.
  One run is not a memory-leak/soak result.

## 2026-09-06: three clean 3.0.7-rc.1 runs

[`Raw repeated results`](baselines/host-performance-2026-09-06-stepsemble-3.0.7-rc.1-darwin-arm64.json)
retain three sequential executions of exact `2b7f0b6` with dirty=false, on the
same Darwin25.6.0 arm64 / Node22.22.3 machine and the unchanged benchmark script.
This candidate has not replaced3.0.6 production.

| Metric (three independent run values) | Run1 | Run2 | Run3 |
| --- | ---: | ---: | ---: |
| Cold list ms |90.266|89.744|91.907|
| Warm-list p95 ms |7.340|7.485|7.319|
| Invalidated scan ms |91.904|92.607|92.785|
| Health max during scan ms |4.944|5.184|5.171|
| Event-loop delay p95 ms |12.403|12.132|12.083|
| After-workload RSS MiB |123.891|126.172|125.031|

All three cold/invalidated reads fit the initial100ms local goal for this
fixture. The three old/new executions are not interleaved controlled A/B trials;
no population percentile or percentage speedup is claimed. Peak RSS is higher
than the prior single3.0.6 run; four concurrent parsers trade some memory for
latency. Slow disks, larger stores, physical mobile and long-run memory behavior
remain separate gates. See [soak scope](session-discovery-and-soak.md).
