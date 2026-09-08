# Claude 唯讀歷史：隔離預覽與驗收

2026-09-08，Plan 1.44，3.0.7-rc.2 開發候選。**不是正式上線功能。**
正式 Host、原生 Claude 帳號、私人歷史及 72 小時固定版本長測均不由本預覽變更。

## 已實作的路徑

```text
預設：合成來源目錄 → legacy 隔離讀取 worker ────────────┐
明確 native：合成 root identity → Rust helper → actual close │
                         → bytes-only SDK worker ──────────┤
                                                 scoped registry
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

預設保持既有 `legacy_source_worker`。若要明確驗證新的 native composite backend，
先依 [native reader ADR](native-history-reader.md) 在本機 temporary target directory
build helper，再執行：

```sh
npm run preview:history -- /absolute/path/to/sdk.mjs --native-helper=/absolute/local-target/debug/stepsemble-history-source-reader
```

CLI 只接受 SDK positional argument 與一個 `--native-helper=`；不接受 source/root
override、任意 worker args、SDK fallback 或重複選項。Helper 必須為 canonical
absolute regular executable，symlink／alias、不可執行／不存在的檔案在配置階段拒絕，
不先建立 fixtures。這是 trusted Host executable 設定，不是已執行 bytes 的 pinning。
Windows native preview 本階段明確拒絕啟動；不將 unsupported 偽裝為 legacy 成功。

Native mode 仍只建立上述四組 synthetic sources；expectedRoot 取自預覽**自己新建**
projects directory 的 device/inode，不讀取／掃描私人 root。它用固定兩 helper slots
的 composite service；Rust helper actual-close 後才把 captured bytes 送進受限 Node
SDK worker，後者沒有 source subtree read grant 或 child-spawn grant。原始 fixtures、
HTML／CSS／logo／共用 client assets 不因 backend 選擇改變。

Ready JSON 與程式 status 回固定 backend label `legacy_source_worker` 或
`native_bytes_worker`；不輸出 helper path、root、cookie 或 credential。Native reader／
SDK／ACL／cleanup 失敗原樣 fail-closed，不重試 legacy backend。`createHistoryPreview`
的可信程式介面對應 `{sdkPath, port?, nativeHelperPath?}`；browser 無法切 backend。

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

## 2026-09-08 實際瀏覽器驗證（legacy backend）

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

新增 native preview 的 unit／HTTP 測試使用自建 executable protocol fixture，驗證
root identity 傳遞、native failure 不 fallback、cookie 撤銷及 actual-close 清理；它
不冒充 Rust ACL 成功或官方 SDK 全鏈證據。

## 2026-09-08 native backend 實際瀏覽器驗證

以明確 `--native-helper=` 啟動自己的 loopback preview，ready label 確認
`native_bytes_worker`；使用 Rust 1.97.1 locked release helper（SHA256
`e2368ef16e1def5a43baf064b81da98aad107946bc1f7cdebd0507fd49c33d02`）及官方
SDK 0.3.259。不是沿用上節 legacy 結果。Codex Computer Use 的 in-app browser
實際點選與畫面確認：

- rich／compaction／file-history 分別載入 6／5／4 則；沒有檔案還原或模型操作。
- 1,000 則來源，SDK offset 0 → 10，Client 保留 20 則、DOM 僅 10 個 article。
- 在 offset 10 手動刷新成 25 則後，分段顯示 1–10／11–20／21–25，DOM 為 10／10／5。
- 自建來源 append 後下一頁被拒，舊 25 則仍保留、明示來源已改變且停用續頁；手動刷新成功。
- 撤銷自建 cookie 後請求被拒，顯示登入失效並保留舊頁；reload 重新 bootstrap 後可讀。
- 關閉預覽後 DOM 訊息歸零，Enter 鍵可重新選取 rich 並載入 6 則。
- 預設 1280×720 畫面，390×844 的可見按鈕高度為 44px 以上；390px／320px 的
  document scrollWidth 分別恰為 390／320，無橫向溢出。不是實體手機或 Safari 驗收。
- 檢查時 console warn/error 為空。最後重設 viewport、關閉自己分頁，對自己預覽
  輸入 `stop`，取得 `history_preview_closed_cleanup_confirmed` 及 exit 0；fixture
  bytes 核對、workers／listener 都依 close gate 清理，正式服務沒有重啟。

加入預覽選項後全套本機 624 tests＝622 pass／2 platform skips／0 fail；preview
專項 6/6。真 Rust → SDK → HTTP/relay pipeline 的三 OS CI 邊界另見
[native reader ADR](native-history-reader.md)。沒有新增畫面設計或改動 B+ logo；
這批不是 CWV、多輪 UI 性能、source provenance 或可部署性通過。

## 上線前尚需通過

1. 將已有窄 POSIX fd／ACL reader 接到真正授權來源的驗收，以及 Windows 完整 reader
   owner/ACL gate；root identity／no-follow 不代表完整 ancestor／namespace provenance。
2. 正式 Host 的來源授權清單、credential rotation/logout/device revoke/shutdown 接線。
3. 正式 UI Host 選擇與 dedicated-peer relay 的端到端／rolling 驗證。
4. 大來源記憶體與多輪效能、手機實機及背景恢復；現有 72h 長測不涵蓋本輪歷史預覽。

Node permission model 不是惡意程式 sandbox。Legacy 的 projects-root read grant 不是
完整來源隔離；native 的 bytes-only worker 移除此 grant，也不因此證明 OS sandbox、
同 UID attacker 隔離或原生資料 authenticity。未知 actual-close 仍保留自己的 fixtures，
不以 listener 關閉或已送出 kill 當作 reader 已退出。
完整 session/approval/resume、durable journal 與跨平台 App 仍有獨立門檻，詳見
`history-access-design.md`、`platform-plan.md`，不能因本頁可操作就視為完成。
