# Claude Code 官方登入入口

最新狀態（2026-09-06 22:44 MYT）：Mini／MBP 正式為 3.0.6。Jerome 回報已完成
瀏覽器登入，Mini 桌面助手回 `completed`／`detected`；另獲同意的單次直接 Aqua
Claude 2.1.259 模型／串流／新 session 歷史讀回通過。metadata API 仍保留
`liveVerified:false`，沒有將一次成功當成永久有效。詳見 [`native-subscription-smoke.md`](native-subscription-smoke.md)。
以下 rc.3 detected 與 3.0.4 部署時 signed_out 都是歷史，不代表目前仍未登入。

2026-09-06 後續：Jerome已同意桌面元件，3.0.4-rc.3實作登入與Claude任務共用Aqua助手，
Mini已獨立安裝並通過真正SSH→助手→官方CLI唯讀metadata檢查。Jerome另同意安全更新後，
主Web已啟用3.0.4-rc.3，正式UI及API均偵測既有登入，3.0.3保留可回退；
沒有重新登入或模型呼叫。細節與限制見[`claude-desktop-runner.md`](claude-desktop-runner.md)。
下列rc.1失敗與還原紀錄維持不變，不能改寫成當次成功。

2026-09-06 曾在 Mac Mini 試裝 3.0.4-rc.1，**真實登入環境驗收未通過，已還原正式 3.0.3**。
3.0.4-rc.2 新增已知 macOS SSH 環境的 fail-closed 保護，尚未部署。這不是 Claude Agent SDK
登入，也不是 Stepsemble 自建 OAuth client，更不是 Claude 結構化 adapter 完成。

## Mac Mini 實測發現與下一步

- 同一個使用者、HOME、官方 Claude Code 2.1.259，在桌面環境 metadata 為 `detected`，
  SSH 後台卻為 `signed_out`；移除 SSH 環境旗標重查仍相同。`launchctl managername`
  分別為 `Aqua`／`Background`。因此不能直接判定使用者又被登出。
- 登入設定與模型路由 SHA-256 前後相同，沒有真實 login/logout 或模型呼叫。
  Keychain search-list／default path 也一致；**沒有為診斷取出 Keychain 內的憑證、
  解鎖 Keychain、調整 ACL 或搬移 token**。觀察定位在執行環境差異，非完整 Keychain 根因證明。
- 試裝前與還原前皆確認 RPC／generic task／登入 operation 為零。25 個 session
  檔案的 path/size/mtime inventory 相同；保留舊程式、既有 SSH 啟動器與 CUA service。
  Chromium 實測 cache 3.0.3 → 3.0.4-rc.1 → 3.0.3；不是 iPhone/Safari 實機證據。
- 當次下一步（rc.3已取得同意並實作，見上方）：加入受限的 **macOS 桌面 Claude runner/helper**，讓官方登入
  **與實際 Claude 工作程序**共用正確執行環境；只修登入 metadata 而仍把工作放在 SSH
  不能當問題已解決。主 Web Host 的既有 SSH 啟動方式保留，不能貿然改成已知有 IO 問題的直跑。
- 在此之前，rc.2 對已知 macOS SSH 環境回 `desktop_required`、禁用登入；不再誤報
  `signed_out`，也不偷偷切換憑證儲存方式。這個 guard 不是一般性 audit-session 判定器。

去識別驗收紀錄：[`baselines/claude-sign-in-trial-2026-09-06.json`](baselines/claude-sign-in-trial-2026-09-06.json)。

## 使用方式與範圍

1. 在 Stepsemble 選對主機，展開 **Agent Hub → Claude Code 登入**。
2. 點「檢查狀態」。`偵測到訂閱登入` 僅代表 CLI metadata；不代表 token 一定有效。
3. 在 Claude 工作空檔點「開啟官方登入」，確認主機名稱與共用憑證提醒。
4. 已安裝的官方 Claude Code 會自行開啟**該 Host 的瀏覽器**，使用者在官方流程完成登入。
5. Stepsemble 等 CLI 結束後再次讀取 metadata，**不發送模型請求驗證**。

手機連 Mac Mini 時，登入頁開在 **Mac Mini，不是手機**。Headless／SSH 環境可能
無法自動開啟瀏覽器；若需要貼授權碼，先取消這次等待，再在 Host 的官方終端機
執行 `claude auth login --claudeai`。不要把授權碼貼入 Stepsemble。
目前不是手機內完整 OAuth／跨裝置回呼方案。09-06 使用者回報瀏覽器登入完成，
助手結果及另行同意的直接 CLI 最小模型測試已成功；未觀察瀏覽器內完整操作，
也不冒稱實機手機登入回呼已驗收。

這個入口改善「重新登入的入口」，**沒有解決所有頻繁失效的根因，也不保證永不登出**。
2026-09-05 的一次模型驗收曾出現 metadata 已登入但 OAuth 更新失敗；該失敗紀錄
保留於 [`native-subscription-smoke.md`](native-subscription-smoke.md)。09-06 22:44 MYT
新的單次模型測試成功，使用的是另外明確取得的同意，不將原失敗改寫為通過，也不自動重試。

## 帳號與執行邊界

- Host 使用原本可信任的 Claude 安裝，固定 `--safe-mode auth login --claudeai`；
  先核對 version/help 的介面能力。這不是 binary 簽章驗證，不能安裝不可信任 wrapper。
- `--safe-mode` 避免專案客製程式載入；保留 Host 原本 HOME／環境與官方設定，
  不複製／解析／改寫 Keychain、credential file、第三方工具路由或訂閱設定。
  官方 CLI 本身仍可依其正常登入程序更新共用憑證。
- API／其他登入方式顯示 `other_auth`，不自動切換到訂閱。沒有 `--console`、
  API billing fallback、定期 logout/login、模型重送或自動重新授權。
- Stepsemble 不取得或轉送 OAuth URL、code、token、密碼、email。登入 stdout/stderr
  只 drain/discard，未接 terminal transcript、task journal、localStorage 或錯誤日誌。
  既有 Pi Provider 登入是另一條路徑，本次未更改；不可把兩者混為一談。
- 僅已通過 Stepsemble 認證的使用者／peer 可操作；沿用同源檢查，browser mutation
  額外要求 Origin。這是同一個受信任 Host 的能力，不是多租戶帳號隔離。

## 穩定性設計

- 懶載入、single-flight metadata／15 秒快取；只在開啟的登入面板輪詢進行中狀態。
  每段 metadata 命令 10 秒／32 KiB 上限；登入輸出 64 KiB、等待 3 分鐘上限。
  超限或失敗不印出 CLI 原始訊息、不自動重試。
- Host 只保留一筆登入 intent，準備階段有效 60 秒。重複 POST、過期／舊 ID
  不會重新啟動 CLI；結果不明先檢查狀態，取消或完成後才能由使用者新開一次。
- 與 Stepsemble Claude task／非同步 task launch reservation 互斥；不自動關閉工作。
  其他 App／獨立終端機的 Claude 工作不在這份清單內，仍需使用者選工作空檔。
- 主機切換／登出會使舊 HTTP 結果失效，不能讓 Host A 的 prepare 在 Host B start；
  頁面 reload 只讀狀態，不重送登入。關閉面板只停輪詢，不會取消官方登入。
- 取消只停止本次 owned auth child（Windows shim 使用 owned tree 清理），不執行
  `auth logout`，也不撤銷可能已完成的授權。正常 Host shutdown 清理 owned children。
- Intent 為 process-lifetime 狀態，**不是 durable OAuth resume 或跨 crash exactly-once**。
  強制 kill／斷電後，先確認官方程序和登入狀態；舊 intent 不能在新 Host 重播，
  但目前不提供殘留官方登入流程的跨 Host crash 恢復。不可把 unit tests 當此 gate。
- 結束操作的訊息與現在的 credential metadata 分開顯示，避免上一次登入成功遮蔽後續登出。

## HTTP 介面與驗收

| 介面 | 內容 |
| --- | --- |
| `GET /api/claude-auth/status` | 去識別狀態，固定 `liveVerified:false` |
| `POST /api/claude-auth/prepare` | 僅接受 `{confirm:true}`，取得本次 intent |
| `POST /api/claude-auth/start` | 僅接受 `{id}`；相同 ID 不重啟 |
| `POST /api/claude-auth/cancel` | 僅接受 `{id}`；不是登出 |

所有 body 限 1 KiB、禁止額外欄位，回應 no-store。舊 Host 404 顯示尚未支援，
不降級為 generic terminal 的 `/login` 或收集驗證碼。

測試使用 `test-support/fake-claude-auth.cjs` 的合成 CLI，完全隔離 HOME；涵蓋
lazy/cache、同意與 Origin、一次啟動、任務互斥、取消／timeout、舊 intent、關閉、
metadata/output 上限、切主機／reload、不洩漏 CLI 敏感輸出。
`npm run test:rolling` 另加入 1440／390px 的真實 Web UI start/cancel/retry/reload、
中英文切換、44px 按鈕與無水平溢位檢查；不是實體手機／Safari／官方 OAuth 成功證據。

rc.1 的 301 tests、原 8 組 rolling 與新增 2 組 auth UI cases 均通過跨 OS CI，
但沒有涵蓋真實桌面／SSH 認證差異，不能取代上面的人工 gate。rc.2 加入 SSH guard 回歸，
結果以新 commit CI 為準。版本工具已同步候選版資源與 cache；没有發布 GitHub release
或更新其他裝置。上述為rc.1/rc.2歷史；最新rc.3啟用與正式UI驗收見本文開頭及桌面元件文件，仍非真實OAuth完整流程。

## 官方依據

- [Claude 認證說明](https://code.claude.com/docs/en/authentication)：官方登入、憑證管理與終端機回填流程。
- [CLI 參考](https://code.claude.com/docs/en/cli-reference)：原生 auth status/login 命令；以本機 help 核對版本能力。
- [法律與合規說明](https://code.claude.com/docs/en/legal-and-compliance)：依未修改原生 CLI 託管的邊界設計，
  不提供 Stepsemble 自有的 Claude.ai OAuth；這不是整個產品商業模式的法律認證。
