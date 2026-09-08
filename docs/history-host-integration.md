# Claude 唯讀歷史：Host 接線與操作邊界

2026-09-08，3.0.7-rc.3 開發候選。**程式已接入實際 `server.js` 與 Web 導航，
但尚未部署正式主機，也沒有登記／讀取使用者的私人歷史。**這不是完整 native
session／approval／resume parity。正式兩台 Mac 仍為 3.0.6；固定來源 72h 長測不變。

## 使用者會看到什麼

Agent Hub 的 **History／唯讀歷史** 是一般連結，預設另開分頁，不關閉原工作區。
目前主機走 `/api/history/*`，已配對主機走 `/r/<machineId>/api/history/*`。
URL 只攜帶已選機器 ID，不能指定來源路徑、SDK、模型或憑證。

歷史頁載入只要求已授權的 catalog，不自動選取／讀取第一份對話。點選來源後，
才向 Host 登記短租期 binding 並要求 bounded page。來源變動會保留舊頁、明示過期，
等使用者手動重新整理；不混合不同版本。工具、附件、網址及思考內容只作文字描述。
關閉歷史、取消或離開頁面不停止原生 Agent 工作，也不是 worker 已關閉的證據。

沒有設定、設定被拒絕或尚無授權來源，都顯示可重新確認的明確狀態；不以空白畫面
或一般 `Failed` 冒充一個原生 session。這個試用頁目前使用繁體中文，工作區入口
有完整11語系翻譯；歷史頁完整多語系仍待補。

## 預設停用，操作員明確啟用

Host 啟動時才載入 `CONFIG_DIR/history.json`，通常為
`~/.config/stepsemble/history.json`。可以用 `STEPSEMBLE_HISTORY_CONFIG` 指定另一個
canonical absolute file。安裝器不建立這份檔案；檔案不存在即停用。自訂路徑錯誤
不會回退到其他設定。設定變更需要受控重啟；不要中斷正在工作的正式主機。

設定檔、其祖先目錄、helper／SDK 及其祖先目錄都是**操作員管理的可信邊界**。
載入器拒絕符號連結、非 regular／多 hardlink、非目前 UID、過寬 mode、超過128KiB、
前後 identity 變動及不合法 JSON／欄位。helper 要可執行，helper／SDK 不可 group／
other writable。這些檢查**不等於 config/executable 的 fd ACL／mount 證明**、
執行當下的 binary hash pinning、同 UID 隔離或 OS sandbox；不要把設定放在不可信
共享／noowners／可被其他使用者替換的路徑。

來源讀取另外使用 Rust 的 fd owner／ACL／mount／openat containment gate。
來源必須是支援的本機 POSIX 檔案系統，沒有 extended ACL、symlink、跨 mount，
並符合 owner-only policy；macOS `noowners` 明確拒絕。**不自動 chmod、chown、
刪 ACL、搬動 `.claude`、變更掛載旗標或關閉安全檢查。**拒絕時先由操作員評估
存放位置與權限，而不是讓 App 越權修理私人歷史。

### 建立一個明確來源

先準備本地 Rust reader 與固定 SDK artifact，見 [native-history-reader.md](native-history-reader.md)。
目前 reader toolchain 固定1.97.1；SDK固定0.3.259／對應CLI2.1.259，SDK bytes SHA-256：
`7fa7c212361864544e775e7551519e790515f95d4bb6a4831b0b05f5b368a0c5`。
不自動下載／更新、不調整官方 Claude 安裝、登入或訂閱。

操作員確認指定 session 可向選定登入分享後，使用下列**需替換路徑與 ID 的範例**：

```sh
node scripts/history-config.mjs create /absolute/private-config/history.json \
  --origin https://your-host.example \
  --helper /absolute/private-tools/stepsemble-history-source-reader \
  --sdk /absolute/private-tools/claude-sdk/sdk.mjs \
  --projects-root /absolute/approved-claude/projects \
  --project-key approved-project-key \
  --session-id 11111111-1111-4111-8111-111111111111 \
  --reader browser:master \
  --label '已確認的對話'
```

命令只取得明確 root 的 device/inode metadata，**不掃描目錄／讀 transcript**。
輸出父目錄須已存在且為目前 UID 的 private directory；輸出以 exclusive create、
0600、fsync 建立，已存在的檔案絕不覆寫。失敗只回收本次建立且 identity 仍相符的
檔案；不修改來源或重啟 Host。輸出的 `valid` 只代表設定檢查通過，不能宣稱來源
ACL、SDK載入或完整讀取已通過。

```sh
node scripts/history-config.mjs check /absolute/private-config/history.json
```

`check` 只讀 startup config/artifact metadata，輸出數量與狀態，不輸出來源、憑證
或私人內容。正式啟用前，要選定來源與可讀者；本輪**沒有替 Jerome 作這項分享決定**。

### 設定格式

```json
{
  "version": 1,
  "trustBoundary": "host_managed_paths",
  "allowedOrigins": ["https://your-host.example"],
  "reader": {
    "helperPath": "/absolute/private-tools/stepsemble-history-source-reader",
    "sdkPath": "/absolute/private-tools/claude-sdk/sdk.mjs"
  },
  "catalog": [{
    "catalogId": "source-1",
    "label": "已確認的對話",
    "description": "",
    "source": {
      "projectsRoot": "/absolute/approved-claude/projects",
      "projectKey": "approved-project-key",
      "sessionId": "11111111-1111-4111-8111-111111111111"
    },
    "expectedRoot": {"device": "1", "inode": "2"},
    "readers": ["browser:master"]
  }]
}
```

範例 device/inode 不能照抄；它們是啟用時明確觀察的 root identity。
Origin 必須精確符合 scheme／host／port，不帶 trailing slash、path 或 wildcard。
來源最多256個、origins最多16個。多份來源可由操作員編輯 private JSON，再 check；
同一 root 不得寫互相矛盾的 identity。HTTP 不提供 config 寫入 API。

`readers` 必須非空且逐項明確列出：

- `browser:master`：安裝器 token 對應的登入；**所有共享這個 token 的人是同一權限**。
- `browser:<token-id>`：Host 已核發 access-token 列表中的 ID，不是 raw token／hash。
- `peer:<grant-id>`：本 Host 已配對 incoming device grant 的32位hex ID，不是 bearer。

Gateway-only Host 可設 `reader: null`、`catalog: []`，但仍須設定 browser origins。
遠端必須另有自己的來源設定，明確授權 gateway 的 incoming grant。遠端看見的是
gateway 身份，**不是下游使用者的端到端 delegation**。所有能登入 gateway 的使用者
可要求其已配對的歷史 catalog；gateway 的 binding owner map 隔離不同使用者／分頁的
生命週期，但不是來源級下游 ACL。需要更細權限時不要把 gateway grant 授得過廣。

## 生命週期與安全接線

- 成功登入先撤掉 request 內舊歷史 scope，再設定新 cookie；同時過期兩個 legacy
  aliases。失敗登入不破壞有效工作。多個 Cookie／Bearer 混用仍拒絕，不猜選哪一個。
- 登出撤掉三種支援的 cookie alias 所屬歷史 scope。共享 token 本身仍有效，可重新
  登入取得新 scope；舊 binding／version 永不復活。
- access-token／incoming grant 撤銷先完成原 store 持久化，再取消受影響讀取。
  outgoing grant 替換、machine rename/delete、Host shutdown 也同步撤銷 relay 狀態。
- Host 關閉先停止 admission 並取消所有 owned reader；等待 actual-close cleanup
  結果才離開。無法確認 cleanup 就回報失敗，不宣稱成功；不以此中止原生 Agent。
- 本地、遠端以及會被 URL dot-segment normalization 轉成歷史的路徑都先保留在
  專用 boundary。非 canonical 別名拒絕，不落到 legacy generic proxy。
- `/history.html` 不進 SW offline SPA fallback，API 不快取；新JS/CSS由版本工具
  統一 cache-busting。頁面 bfcache 恢復會重載，不復活舊 view scope。

## 本輪驗證

新增配置、private credential policy、實際HTTP、relay、logout/revoke及URL別名測試。
真 `server.js` 測試包括 idle/graceful exit，以及啟動自建 stalled helper 後 SIGTERM：
Host 等 helper 實際關閉才 exit0；不是「送出 kill 即完成」。

`scripts/check-history-host-native.mjs` 以自己的 private temp home、JSONL、token與
incoming grant 起完整應用程式，跑四種來源、版本改變／重新整理、access-token與
device-grant revoke、logout。`check-native-history-pipeline.mjs` 已納入此 gate；
Windows 明示 unsupported，不藉 skip 宣稱可讀。

本機 Node22.19.0 與22.22.3 actual Host gate通過，Rust release artifact
`9045ccb6e22fbd3a08d02c91aa5b7b8a5b8e7263393c874fd6ef1cb9e0937aa0`，固定SDK。
全部合成來源／artifact前後確認，owned helper/Host已關閉、測試檔回收；私人history與
model calls均0。完整跨OS CI需以本批exact commit結果為準，不能借用前版綠燈。

Computer Use 實際操作新版：登入、來源選擇、下一頁、來源變動保留舊頁、手動refresh、
close清空；390×844及320×740無橫向溢出，可見button≥44px、DOM維持10則。
內建瀏覽器未開出 target-blank 分頁，因此單獨開啟／導覽歷史頁驗證，**新分頁自動
開啟與跨機 Safari／實機背景恢復不列為通過**。測試分頁與 viewport override已清理。
Apple Design 原則用於點按區、焦點與即時回饋；未做新多輪效能／CWV宣稱。

## 仍需完成

私人來源選擇／分享確認、production rollout gate、完整 i18n、跨機／真機 UI與效能、
Windows native opener、可信 bootstrap 更強 OS 證據、原生 approval ACK／resume、
durable journal、Rust Host遷移、Tauri／Apple／其他客戶端。不能把本輪 opt-in read-only
接線描述為「整個產品只剩72小時」或「所有 Agent 已跟 Pi 一樣」。
