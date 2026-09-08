# Claude 唯讀歷史：隔離預覽與驗收

2026-09-08，Plan 1.42，3.0.7-rc.2 開發候選。**不是正式上線功能。**
正式 Host、原生 Claude 帳號、私人歷史及 72 小時固定版本長測均不由本預覽變更。

## 已實作的路徑

```text
合成來源目錄 → 固定 SDK 的隔離讀取 worker → scoped registry
                                           ↓
                                  嚴格 HTTP + 合成 cookie
                                           ↓
                               TypeScript transport / provider
                                           ↓
                                版本化分頁 controller / viewer
```

這條路徑實際讀取官方固定 SDK 的合成 transcript，不用 mock HTML 冒充原生資料。
SDK 不呼叫 query、CLI、登入、resume 或模型。`sourceAuthenticated`、`publishable`
與執行／核准／續跑權限維持 false；fixture 中的指令、工具與附件只以文字呈現。
遠端 relay 有獨立 HTTP 測試；固定 SDK script 另以兩個 loopback listener 驗證真正的
relay → remote registry → SDK worker，包括同 caller view 的不同 principals 不能借用
彼此 binding。它尚未接入這份預覽的 Host 選擇，不能聲稱真多機 UI 已驗。

## 重現

先完成 `npm run build:client`。準備已核對的官方 SDK 0.3.259
（對應 CLI 2.1.259，完整 pin 與取得方式見 `protocol/native/claude/README.md`），然後：

```sh
npm run preview:history -- /absolute/path/to/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs
```

預覽只監聽 `127.0.0.1` 的隨機埠；開啟輸出的本機網址。只有精確 allowlist 的 HTML、
CSS、B+ logo 與六個共用 JS 檔可讀，bootstrap 核對實際 Host／Origin，cookie 不輸出。
不接受 URL 指定來源路徑、SDK、shell、provider route 或私人 session。
四組 fixture 是工具與思考、壓縮後脈絡、附加檔案紀錄與 1,000 則長對話。

互動終端可輸入：

- `change long`：只 append 自建合成來源，驗證下次續頁拒絕混合版本。
- `revoke`：先旋轉合成 cookie，再撤銷舊 principal；舊頁請求回 401。重新載入本機頁面取得新合成 cookie。
- `stop`：撤銷、等待 worker 確認結束、關閉 listener、核對 fixture bytes，最後只清理自己建立的暫存目錄。

也可對這個預覽程序按 Ctrl-C。若 worker cleanup 或來源 bytes 不確定，保留資料並回報失敗，
不把「送出停止」當成「確認結束」。指令不操作正式服務或任何原生 session。

## 畫面與操作限制

| 層級 | 上限／行為 |
| --- | --- |
| Client 保留視窗 | 500 則／32 頁／2 MiB，失敗不覆蓋舊頁 |
| 本畫面 | 最多 10 則、每則前 24 個區塊、主要文字 48,000 units；截短內容明標 |
| 每次讀取選項 | 5／10／25 則；25 則仍以 10／10／5 分段呈現 |
| 原始／回覆 | 8 MiB 原始來源、256 KiB 內層、272 KiB 解壓後 HTTP 外層 |
| 生命週期 | 顯式操作才 renew 租約，不自動輪詢、模型重試或背景續跑 |
| 過期／撤銷 | 保留舊內容及清楚提示，禁止新續頁；成功手動 refresh 才替換 |

UI 採系統字體、44px 以上觸控目標、可見鍵盤焦點、即時 busy／cancel 回饋，
並提供 reduced-motion、reduced-transparency、contrast 樣式。沿用既有 B+ SVG，未重新生成 logo。
工具／thinking／附件使用 inert `textContent`／`details`；沒有 source URL、HTML 注入或執行按鈕。

## 2026-09-08 實際瀏覽器驗證

透過 Codex Computer Use，在隔離 loopback 預覽執行；不是私人帳號登入測試。

- 1440×1000 桌面、390×844 與 320×740 手機 viewport；手機沒有橫向溢出，主要按鈕高度至少 44px。
- rich 6 則、compaction 5 則（保留 SDK 分支順序）、file-history 4 則均載入。
- 1,000 則來源讀取下一頁：SDK offset 0 → 10，保留 20 則，但 DOM 仍只有 10 個訊息卡／97 個元素。
- 選 25 則 refresh：畫面依序 1–10、11–20、21–25，DOM 卡片 10／10／5。
- 合成來源 append 後續頁被拒；原 10 則保留、顯示 stale、下一頁停用；手動 refresh 復原。
- 合成 cookie 撤銷後舊請求拒絕、舊內容保留；reload 重新 bootstrap 後可選來源。
- 關閉預覽清空畫面；Enter 鍵重開 rich 成功。檢查時沒有 browser console error／warning。

這是功能、版面與 DOM 邊界證據，**不是 INP／LCP／CLS 或多輪效能數據**。
沒有 Safari／Firefox／iOS／Android 實機、睡眠喚醒、弱網或正式 PWA cache 驗收。

## 上線前尚需通過

1. 原生來源的 POSIX ACL／descriptor-relative containment 與 Windows owner/ACL gate。
2. 正式 Host 的來源授權清單、credential rotation/logout/device revoke/shutdown 接線。
3. 正式 UI Host 選擇與 dedicated-peer relay 的端到端／rolling 驗證。
4. 大來源記憶體與多輪效能、手機實機及背景恢復；現有 72h 長測不涵蓋本輪歷史預覽。

Node permission model 不是惡意程式 sandbox，不能把固定 projects-root read grant 稱為完整來源隔離。
完整 session/approval/resume、durable journal 與跨平台 App 仍有獨立門檻，詳見
`history-access-design.md`、`platform-plan.md`，不能因本頁可操作就視為完成。
