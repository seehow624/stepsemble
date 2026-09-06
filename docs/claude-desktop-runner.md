# macOS Claude 桌面執行元件

> 2026-09-06，Mini 桌面助手已啟用，Web已更新stable3.0.4；助手程序未被這次更新重啟。rc.3曾偵測既有登入，最新metadata已為signed_out，須owner重新官方登入。不是 Claude 原生 session／approval adapter 已完成。

## 決策與範圍

Jerome 已同意實作受限桌面元件。保留現有 SSH Web Host，另外以
`com.stepsemble.claude-desktop` GUI LaunchAgent 管理 Claude 官方登入及任務啟動。
這是現有 Node runtime 的過渡邊界，**沒有更改長期 Rust Host／TypeScript Client 的語言決策**。
未來 Rust 可替換這個明確程序邊界，不需要把 UI 或官方認證重寫一次。

Apple 的 [TN2083](https://developer.apple.com/library/archive/technotes/tn2083/_index.html)
區分 GUI、SSH 與 per-user 執行環境；本機 `launchd.plist(5)`／`launchctl(1)`
也確認 `LimitLoadToSessionType` 與 `managername` 的用途。因此明確指定 `Aqua`，
不設定 `SessionCreate`，不只刪除 SSH 環境變數冒充桌面環境。
`managername` 是 legacy CLI，不是未來永遠穩定的 API；輸出異常時拒絕啟用，不猜測成功。

替代方案未採用：搬 OAuth／改 Keychain ACL 會改變原生憑證邊界；把整個 Web Host 移回
launchd 直跑會重引既有 IO 問題；只代理 auth status 則讓真實工作繼續使用錯誤環境。
選擇小型桌面 broker 的代價是多一個需安裝／維護的程序及 owner-only IPC，不能把它當作
免維護的帳號修復工具。其 runtime 固定本機副本，使回滾及未來 Rust 替換保持程序隔離。

```text
Web/PWA → 已認證的既有 SSH Web Host
                 ├─ Claude 登入 → 私有 Unix IPC → Aqua 桌面助手 → 官方 auth CLI
                 └─ Claude 任務 → 私有 Unix IPC → Aqua 桌面助手 → 獨立 supervisor
                                                                    └─ PTY/Claude
```

任務建立後，Web Host 直接連接既有 supervisor 的私有 socket。助手不轉送 prompt、
任務輸出或 terminal streaming，也不新增第二套 history/journal。Web／助手重啟不重開任務。
使用者登出 macOS 桌面、整機重啟或 supervisor 崩潰的完整恢復，仍不是本批已完成能力。

## 安全與失敗處理

- 僅 macOS opt-in／已知 SSH 路徑使用助手；缺失、離線、權限不符、非 Aqua 時，
  Claude 路徑 fail closed，不退回 SSH。其他 harness 不改執行位置。
- 使用 owner-only 0700 目錄、0600 Unix socket 與獨立 32-byte 隨機 IPC key。
  這把 key **不是** Claude／OAuth／Web master token。沒有 TCP listener、CORS 或 HTTP relay。
- IPC 固定版本與操作：health、status、auth prepare/start/cancel、task prepare/launch。
  不接受 command、argv、env、OAuth URL/code/token、任意輸出路徑或其他 agent ID。
- Request 8 KiB、response 8 KiB、header 2 KiB，最多 16 connections／8 個已認證處理要求。
  有限 serial admission lane 保證登入與任務啟動互斥；readiness／metadata／IPC 均有 deadline。
- Claude executable、HOME、PATH 與 workspace roots 由本機 owner 安裝設定，不由 Web 傳入。
  Workspace 用 realpath 再確認 roots，拒絕 symlink 導出。沿用原生設定，沒有改 provider route。
- 官方登入沿用 `claude-auth.js` 的固定參數、能力檢查與 discard-only stdout/stderr。
  metadata detected 不代表模型連通；沒有自建 OAuth、憑證搬移、Keychain ACL／unlock。
- Task prepare 只簽發 process-instance-bound、60 秒、單次 ticket；launch 消耗後不重新建立。
  助手重啟後舊 ticket 不可用，已存在 task ID 不可重新 prepare。最多32張票／32筆未清理啟動紀錄。
- 啟動前先以私有 atomic rename＋file/directory fsync 保存不確定性標記。
  回覆遺失時 Web 保留原 task ID、只嘗試接回固定 socket，不重送 launch，也不隨便 kill 未核對的 PID。
- 既有 supervisor 確認 terminal／child 已空、程序退出後才移除 active launch 記錄。
  無法核對的紀錄／當機中登入標記使新登入與新任務暫停，需 owner 檢查。
  這不是完整 durable journal、外部 exactly-once、磁碟損壞／備份還原安全性證明。
- 受信任的同一 macOS 使用者仍能修改 CLI／設定／IPC key；不是防止同帳戶惡意程式的 sandbox。
  通用 terminal 仍有原生 CLI 的輸出限制，不能宣稱所有 terminal 內容都已結構化脱敏。

## 安裝與回滾

明確 opt-in，從可信任且測試通過的 source 執行：

```sh
node scripts/install-claude-desktop.mjs --install --root /absolute/project-root
node scripts/install-claude-desktop.mjs --check
```

- 不執行 root/sudo；確認 GUI user domain 存在。
- Runtime 複製到本機 `~/.local/share/stepsemble-claude-desktop/candidate-*`，不從 SMB 執行，
  不裝 npm runtime dependencies，也不依賴會被 Web rollback 移走的程式路徑。
- Config／IPC key／受限 recovery state 位於 `~/.config/stepsemble/claude-desktop/`。
  Config 只保存 home、固定 Claude command 與 roots，沒有 provider 憑證。
- 安裝器不覆寫既有 config/plist，不改主 Web server／updater／CUA service，不更新其他裝置。
  既有助手的自動版本更新／簽名發佈尚未完成，不能把首次 installer 當完整 updater。
- 只做 health 與一次 native metadata gate，不會 login/logout 或送模型 prompt。
  首次 gate 失敗只卸載本次新 LaunchAgent，config/plist 改名保留，runtime 不刪除。
- launchd 異常退出重試節流30秒，正常退出不強迫重啟；不自動重送登入或 task。
- 手動停用只針對 `gui/<uid>/com.stepsemble.claude-desktop`，先檢查登入／任務狀態。
  不停 Web Host，不清空 recovery state、不刪 native history，不移除 Keychain item。
- 助手健康不等於正式 UI 已更新；正式 Web 仍需獨立版本/cache bump、active-work gate 與可回滾部署。

## 驗證

- `node --test test/claude-desktop.test.js`：Unix owner-only IPC、secret redaction、未知操作、
  Workspace confinement、auth/task 互斥、單次票／expiry／重啟、未知 launch、回覆丟失、
  真實合成 supervisor PTY、Host／helper 重啟重接、退出與權限錯誤。Windows 只跑適用的純測試；
  Unix fixture 的 injected context 不是 Windows/macOS GUI 證據。
- `node scripts/check-desktop-context.mjs --offline`：macOS 真正臨時 GUI LaunchAgent，
  **假** Claude 同時記錄 metadata 與 task 程序的 `managername`；驗證各為 Aqua、只開一次、
  Host/helper 重啟後接回、停止與 owned cleanup。只讀寫本次 fixture；不碰原生帳號／模型。
- 真正 Claude metadata、正式 helper 安裝、SSH → helper → native CLI、正式 UI 及使用者瀏覽器
  登入流程，必須分別記錄實測結果，不能拿假 CLI 的成功代替。

本批尚未授權新的模型用量測試；先前唯一 Claude smoke 失敗紀錄維持不變。
本文件不將 Claude 頻繁登出的所有根因、完整 native history/approval、Rust/Apps 或72h soak標為完成。

### 本機觀察

- 全套本機313tests／311pass2skip／零fail；部署source `f5455e1` 的CI33983687302三OS全綠（Mac311/2、Linux310/3、Windows303/10 pass/skip，均313tests零fail）；Rolling33983687313 macOS/Linux各8組相容＋2組synthetic auth UI全綠。
- 真GUI probe第一次metadata/task已Aqua，但5秒kickstart timeout撞30秒launchd節流，
  該次失敗保留，owned service與tasks已退出。改45秒bounded wait後整個probe通過，
  同一task跨Host/helper重啟仍只launch一次；未減少正式LaunchAgent節流。
- 首次獨立helper安裝成功，官方CLI metadata detected、liveVerified=false；主Web不變。
- 真正SSH client為Background；經私有IPC到助手Aqua查詢同一原生CLI，metadata detected。
  這處理了rc.1觀察到的執行環境落差，但不是OAuth交換／模型請求已成功的證據。
- 去識別觀察紀錄：[`baselines/claude-desktop-context-2026-09-06.json`](baselines/claude-desktop-context-2026-09-06.json)。

### Web 啟用驗收（同日後續）

- Jerome另回覆「好啊」同意無任務時可回滾更新；核對open RPC／generic task皆0、助手canStart=true後，以既有installer啟用可信任source `f5455e16c3c5914c7239c8c92c28d92232403e24`。
- 正式HTTP `/api/health` 為3.0.4-rc.3，`/api/claude-auth/status` 經既有SSH Web回Aqua／detected／liveVerified=false／無登入操作。沒有真實login/logout/model，也沒有重新啟動桌面助手或CUA。
- 隔離Chrome profile實測cache 3.0.3→3.0.4-rc.3；1440px與390px登入面板正常，44px按鈕、無水平溢位、page error 0。手動檢查及reload仍detected、auth mutation 0；不是實體手機／Safari或官方OAuth完整流程。
- 25份Pi session的path/size/mtime inventory相同；Web token、model stores、Claude/Codex設定、SSHkey/known_hosts/start/plist、helper/CUA plist與品牌共12份檔案SHA一致。Installer曾把Node路徑渲染成相同realpath的另一名稱，已恢復原launcher字串；實際binary相同，不需再重啟。
- 3.0.3留在`~/.local/share/stepsemble.previous`，3.0.2另保存在`~/.local/share/stepsemble.backup-3.0.2-20260906-rc3`，rc.1試裝程式也保留。回退仍需先檢查active work；沒有公開stable release或更新其他主機。
- 詳細去識別證據：[`baselines/claude-web-activation-2026-09-06.json`](baselines/claude-web-activation-2026-09-06.json)。舊rc.1失敗紀錄不改寫。
