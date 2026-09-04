# Stepsemble Host performance baselines

> Baseline A：Pi Harbor 2.13.2（改名前）
> Baseline B：Stepsemble 3.0.0（相容遷移並完成本機部署後）
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

前兩次量測執行當下的計畫與 benchmark 尚未提交，因此 raw result 如實記為 `sourceWorktreeDirty=true`；被測的 `server.js` 與 benchmark script 均另存 SHA-256。3.0.0 結果是在本機服務成功由 2.13.2 遷移至 Stepsemble 後，以相同 source tree 和隔離 fixture 重跑。首個 release commit 形成後會再建立一份 `sourceWorktreeDirty=false` 的不可變比較點。

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
| Server startup | 32.825 ms |
| `/api/health` p50 / p95 / p99 | 0.172 / 0.608 / 1.023 ms |
| Session list cold | 94.312 ms |
| Session list warm p50 / p95 | 9.302 / 10.190 ms |
| Long session p50 / p95 | 10.782 / 14.797 ms |
| Invalidated scan | 107.830 ms |
| Health max during invalidated scan | 1.172 ms |
| Generic Agent open | 85.276 ms |
| Generic Agent SSE `connected` | 0.751 ms |
| 8 generic tasks open wall time | 94.544 ms |
| 8-task SSE `connected` p50 / p95 | 1.782 / 2.424 ms |
| Event-loop delay p50 / p95 / max | 10.158 / 18.498 / 19.644 ms |
| RSS idle / after workload | 53.656 / 130.344 MiB |

改名前後沒有看到具實務意義的 Host regression：health p95、warm session p95、generic open 與 8-task open 都持平或略快；startup 增加 1.553 ms，cold scan 增加 4.472 ms，仍屬同級波動。8-task SSE p95 從 1.375 ms 到 2.424 ms，絕對差約 1 ms，仍遠低於 control API 的 100 ms 初始門檻；需要多輪/soak 才能判定趨勢。

## Reading the result correctly

- 這台開發機、local temp filesystem 上兩版的 health 與 warm read paths 都符合目前主計畫的普通 control API p95 <100 ms 初始目標。
- Cold list與invalidated scan約100 ms，後者已略超過目標邊界；這是fast local storage結果，不能推論SMB、外接碟或數千session也安全。
- Scan期間health response最高約1 ms，代表此特定fixture裡async file streaming有讓event loop持續服務；它不能消除sync directory/stat與`execFileSync`在慢 filesystem/Git上的已知風險。
- 8個generic task可並行啟動並取得各自SSE readiness；這仍未測slow consumer、真實CLI輸出洪峰或72小時存活。
- 兩版 RSS 都由約 54 MiB 升至約 128–130 MiB，包含 session cache、JSON parsing、response buffers、task metadata 與尚未強制 GC 的正常高水位；單次結果不能判定 memory leak。後續需要 repeat/soak 觀察是否持續上升。
- Event-loop utilization 約 0.72–0.73，來自 benchmark 刻意不停送 health probe，不代表一般 idle 負載。
- Generic SSE數據只驗證舊 Node supervisor與stream handshake；假的Claude CLI不代表Claude Code官方session、approval或訂閱路徑已驗證。

## Missing browser baseline

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
