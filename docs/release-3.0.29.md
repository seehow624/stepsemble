# Stepsemble 3.0.29 release record

版本：`3.0.29`

## 行為修正

手機重新開啟 Stepsemble 時，預設回到 Sessions 首頁，不再因 localStorage
保存了上一個對話而直接跳入舊 conversation。

- 桌面版 reload 仍保留恢復最近對話的便利行為。
- 窄螢幕觸控裝置不自動恢復 chat 或 agent task。
- 使用者主動點擊 session、通知 deep link 或 Agent Hub task 仍可正常開啟。
- 手機頁面從 back-forward cache 回來時，也會回到 Sessions。

## 驗收

- `node --test test/smoke.test.js`：60 pass
- `npm run check:client`
- `npm run check`
- `npm run check:protocol`
- `npm run check:protocol:conformance`
- `npm test`
