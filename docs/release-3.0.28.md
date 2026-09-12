# Stepsemble 3.0.28 release record

版本：`3.0.28`

## 修正

修正 Agent Hub Task center 在 iPhone 窄螢幕上的 Stop 按鈕走樣問題：

- 重置 Safari 原生 button appearance，避免平台樣式覆蓋 Stepsemble 的按鈕版型。
- 固定 trailing action 的寬度與置中方式，保留 44px 觸控高度。
- 長任務名稱、更新時間及窄卡片不再擠壓 Stop 按鈕。

## 驗收

- `npm run check:client`
- `npm run check`
- `npm run check:protocol`
- `npm run check:protocol:conformance`
- `npm test`

本版本不更動 stop API 或任務生命週期，只修正呈現與觸控版型。
