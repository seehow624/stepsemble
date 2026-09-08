# 在來源電腦設定唯讀歷史

Plan 1.57，2026-09-08。此精靈在開發候選 `3.0.7-rc.7` 提供，**尚未部署到正式
3.0.6**。它改善 owner opt-in，不是讓任何已登入的 Web reader 都取得管理權。
現有主機、憑證及來源不會因為加入此功能而被修改。

## 開始前

1. 在**保存 Claude 對話的電腦**開終端機，不是在手機，也不是另一台 gateway。
   目前支援 macOS/Linux；Windows 原生 reader 仍未通過，不能以設定成功代替。
2. 準備可信 Rust reader 與固定 SDK。來源、artifact 及設定的信任／檔案系統限制見
   [Host 接線說明](history-host-integration.md) 與 [native reader](native-history-reader.md)。
   精靈不安裝、下載、執行或更新這些 artifact，亦不更動官方 Claude 安裝。
3. 選定要分享的 projects root，以及誰可以讀。根目錄下**目前和未來的主對話**
   都屬此群組範圍；若只想分享單一 session，使用既有 `history-config.mjs create`。
4. 準備已存在、由自己擁有的私有設定父目錄（例如 mode 0700）。輸出必須是新檔；
   不覆寫現有 `history.json`、不合併多群組、不自動 chmod/chown，也不改父目錄。

## 逐項設定

在開發 checkout 中執行，或把腳本路徑改成已驗證候選版本的絕對路徑：

```sh
node scripts/history-setup.mjs --lang zh-Hant
```

英文可用 `--lang en`，`--help` 可在非互動終端查看。精靈本身要求 stdin/stderr 都是
TTY，拒絕 pipe、檔案輸入與 raw terminal；保留終端機原生行編輯。每欄最多修正三次，
任一欄輸入 `cancel` 或 Ctrl+C/EOF 都不建立設定。不要整段貼入多行答案。

依序輸入：

| 欄位 | 要填什麼 |
| --- | --- |
| 新設定檔 | 自己選定的新檔絕對路徑；父目錄 private，檔案尚不存在 |
| Browser origin | 來源 Host 的 Stepsemble 網址 origin，例如 `https://your-host.example`，不含頁面 path |
| Rust reader | 可信可執行檔的 canonical 絕對路徑 |
| SDK | 固定版本 artifact 的 `sdk.mjs` canonical 絕對路徑 |
| Projects root | 自己明確選定的 Claude projects 根目錄；不自動找 `~/.claude` |
| Source ID / label | 群組穩定識別碼與可理解顯示名稱；不是偽造原生 session 名稱 |
| Readers | 一個或多個讀者 ID，以逗號分隔；**不是 token、password 或 bearer secret** |

`canonical` 表示實際完整路徑，不包含 `~`、symlink 或 `..`。精靈不自行把另一個
路徑替換成你的選擇；格式／metadata 不符時留在當前欄位，讓你修正或取消。

- `browser:master`：持有來源 Host 主 token 的**所有**瀏覽器，不只目前電腦／分頁。
- `browser:<token-id>`：已建立的附加 access-token ID，不是那枚 token 的秘密值。
- `peer:<grant-id>`：來源 Host 的 incoming grant ID；是分享給 gateway Host，
  不代表限定其下游的某個人。沿用既有逐 Host 信任邊界，不冒充端到端個人 delegation。
- 精靈不讀取 credentials store，不核驗 ID 是否已建立；錯 ID 不會自動換成 master。

最後會顯示即將儲存的完整設定、檔名、root identity、讀者與範圍，以及必要警告。
只有**完全相同的 `CREATE`** 才儲存；其他回答取消。畫面包含私人路徑與識別碼，
只供本機 owner 核對，不要貼到聊天、GitHub、截圖或公開日誌。

## 建立後不等於已啟用

- 新檔以 exclusive create、0600、file fsync 建立，再由同一 startup validator 核對。
  本次沒有目錄 fsync／斷電實驗，不宣稱 power-loss durability。
- review 是 detached/frozen/single-use；來源 root 的 dev/ino/uid/mode、output parent
  及 artifact identity/size/time/mode 在核對前後再驗。改變即失敗，不偷偷重新擷取並
  套用未核對過的值。此為可信 Host 管理路徑的偵測，不是同 UID 或惡意祖先目錄隔離。
- Partial write 只清理本次 exclusive 新檔且 dev/ino 仍相符的輸出；若路徑被換成
  別人的檔案，不刪它，回 `history_configuration_incomplete_check_output` 要求本機檢查。
- 成功表示設定格式與 metadata 檢查通過；沒有掃描目錄、讀 transcript、呼叫模型、
  登入或重啟。來源 fd ACL/mount、SDK hash/runtime 與實際 history 回讀仍是獨立 gate。

正式採用仍須確認 source/readers、active work、備份、回滾與受控重啟。新增設定
不會立即熱載入。主機依設定啟用後，歷史頁仍須手動「重新整理來源」才掃描，
再選一則對話按需讀取。既有非互動 `create`／`create-group`／`check` 保留；
`--reader` 現可明確用逗號選多個 ID，重複／空值／wildcard 一律拒絕。

## 已驗證與剩餘 gate

- 新增17 tests：immutable review、single use、root/artifact/parent drift、partial write、
  競爭輸出保護、無 source open/readdir、複數讀者、欄位修正、取消、UTF-8/貼上/輸入上限。
- 本機 `npm test` 794＝792pass/2skip/0fail；最低 Node22.19 聚焦32/32，strict TS、
  generated artifacts、syntax/version/actionlint 及 Ajv1251 通過。
- 真 TTY 繁中精靈：canonical 路徑修正、兩讀者摘要、確認前無檔、CREATE 後0600、
  既有檔拒絕及 Ctrl+C exit130；合成 source bytes hash 不變，所有自建測試檔已清理。
- 最低 Node22.19 真 Rust＋SDK0.3.259＋`server.js`：精靈產物**不再修改**即啟動獨立
  owned Host；無 manual catalog／初始無scan、explicit refresh四來源、metadata/content及
  release/cleanup通過，`actualSetupGate=passed`。測試程式自行啟動測試 Host，不是精靈
  啟動正式服務；setup/read model/private均0。Windows明確unsupported。
- 這不是 Web 內管理表單、多 root 編輯／hot reload、真人 owner 選源、真機、完整 C1
  或 C2–C8 驗收；其他 agent 的 native history/session/approval/durable 仍按主計畫補齊。

完整本機 logs：`/tmp/stepsemble-history-setup-{final.tap,focused.tap,minnode.tap,native.log}`。

## Exact CI

程式 `3c919a59b8ecf21853ae524e1c39f2e826c242ce` 的四組 CI 全部成功，完整 logs 已核對：

- [一般 CI 34240582314](https://github.com/seehow624/stepsemble/actions/runs/34240582314)：
  三 OS 各794 tests／0 fail；macOS 792 pass／2 skip、Linux 791／3、Windows 747／47，
  各 Ajv1251 通過。Windows 新增 POSIX setup 的 skips 不表示原生功能通過。
- [Reader 34240582404](https://github.com/seehow624/stepsemble/actions/runs/34240582404)：
  macOS/Linux 的新 `actualSetupGate:passed` 驗精靈原檔未修改即用於真 Host、明確
  refresh 後 inventory/metadata/content；setup 本身 sourceReads0/hostRestartedfalse。
  既有 Host/sourceGroups/metadata/shared gates 亦通；Windows 明示
  `source_platform_unsupported`。Rust 17/17/8、Node 各77/77；locked audit 0漏洞/0警告。
- [Native Claude 34240582335](https://github.com/seehow624/stepsemble/actions/runs/34240582335)：
  三 OS 固定 SDK0.3.259 合約通、modelCalls0/原檔不變；不是 Windows full-native reader。
- [Rolling 34240582379](https://github.com/seehow624/stepsemble/actions/runs/34240582379)：
  macOS/Linux 各24 cases／pageErrors0，含既有六 native來源×11語、localeReads0及
  owned cleanup。不是新增 Web 設定管理 UI 或真人／跨裝置驗收。
