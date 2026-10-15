# Hermes 助理

Stepsemble 的「助理」頁是 Hermes Agent Bot Mode 的手機優先客戶端。它連到同一台電腦上
Hermes 已在執行的網頁伺服器，讓你在手機或桌面跟每個 Bot 的永久對話（Bot Chat）聊天、
回答 Hermes 的提問，並查看 Telegram、例行工作等其他來源的對話。

## 使用

- 只要已配對的任一台電腦裝了 Hermes，工作區頂部就會出現「工作區｜助理」切換。
- 第一次打開時，輸入那台電腦 Hermes 網頁控制台的帳號和密碼。
- 有多台裝 Hermes 時，右上角可以選擇要用哪一台；選擇記在這個瀏覽器。
- Bot 需要你核准、回答問題或輸入 sudo／secret 時，卡片直接出現在對話裡，手機會收到推播。
  回覆完成時，如果沒有任何畫面正在看那個對話，也會推播。
- Hermes 不再出現在「新增對話」；以前用 ACP 開的 Hermes 對話仍可照常打開。

## 架構與安全

- 伺服器端模組：`server/hermes-discovery.js`、`hermes-session-store.js`、`hermes-gateway-client.js`、
  `hermes-assistant-service.js`、`hermes-assistant-routes.js`；路由為 `/api/assistant/*`。
- 瀏覽器端：`public/assistant.html` 與 `public/modules/assistant*.js`。跨機器時經由既有的
  裝置轉送 `/r/<id>/api/assistant/*`。
- 只連本機自己的位址（`STEPSEMBLE_HERMES_URL`、`127.0.0.1:9119`、本機各網路位址的 `:9119`），
  不讀取 `~/.hermes` 的任何檔案。
- 只保存 Hermes 的登入 cookie（`~/.config/stepsemble/hermes-session.json`，權限 600），不保存密碼。
  sudo 與 secret 的答案只轉交 Hermes，不寫檔、不進 log、不進事件緩衝；送出後輸入欄立即清空。
- Hermes 的 approval／clarify／sudo／secret 是伺服器對客戶端的請求；Stepsemble 連線後宣告
  `client.capabilities {server_requests: true}`，只回答自己打開的對話；不認得的請求立即拒絕，
  不讓 Agent 空等。核准只接受 Hermes 提供的選項，絕不自動核准。
- 斷線時自動重連，以 `session.resume` 與 `session.events.since` 接回並依序補上漏掉的事件。

## 測試

- 單元與整合：`test/hermes-*.test.js`、`test/assistant-*.test.js`，以
  `test-support/fake-hermes-gateway.cjs` 模擬 Hermes 0.21.6。
- 瀏覽器：`node scripts/assistant-browser-cases.mjs <Playwright runtime>`，或 Rolling 的 workspace 套件。

## 相容性

基準為 Hermes 0.21.6。這套 WebSocket JSON-RPC 是 Hermes 給自家桌面版用的協定，Hermes 升級時
可能改變；每次 Hermes 新穩定版都要以假伺服器與真機唯讀檢查重新確認。
