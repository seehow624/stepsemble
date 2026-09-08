# 原生對話來源探索：第一個安全增量

**最新接續Plan1.51**：來源群組設定、同Hostbudget、動態registry和分頁HTTP已接線，
actualRust＋SDK合成Host已驗；見[來源群組](history-source-groups.md)。原生title、Web
來源UI及其他agents仍待。下文保留1.49/1.50當時「未接線」的歷史，不作最新待辦。

2026-09-08，Plan 1.49。**已完成 Claude 主對話的 explicit-root metadata inventory
與 Host-private 增量索引核心；尚未接入 `server.js`、來源設定或 Web 清單。**
開發版仍為 3.0.7-rc.5，正式兩台 Mac 仍為 3.0.6，沒有部署或新增私人來源授權。
這不是所有 agent 自動收錄已完成，也不改寫固定 ab227af 的 72h 長測。

**Plan1.50接續已實作**：[共用reader admission](history-reader-admission.md)可讓index
與content使用同一Host-owned兩flight預算，已驗真Rust＋SDK並行/cleanup/quarantine。
下文「全域預算待完成」保留1.49當時狀態；目前仍需將source-group設定及HTTP/Web
掛上同一instance，不能每個group建立自己的budget，也不能說已完成全来源UI。

## 這批解決什麼

既有 `history.json` 一筆設定只能指定一個 session；不能為了列出所有 native
對話，在 Node request path 用一般 `readdir` 繞過 Rust source 的權限與目錄邊界。
新增 helper inventory 操作讓 Host 在**一次明確授權的 projects root**內發現候選，
之後可只處理新增／變更 metadata，按需讀取內容。沒有預設搜尋 HOME、讀取
`.claude`、SDK 安裝、登入、模型呼叫或權限修理。

目錄範圍只涵蓋既有 reader 契約的 `projectsRoot/projectKey/UUID.jsonl` 主對話。
project key 只接受 ASCII 字母數字、`-`、`_`，1–255 bytes；UUID 保留原始大小寫，
不同 project 的相同 UUID 仍是不同來源。其他名稱只計入 ignoredEntries，
**不遞迴 subagents、attachments、backup、未知 metadata 格式或其他 agent 的 root**。
這個範圍必須在未來 opt-in UI 中清楚列出，不得標成「所有對話已完整收錄」。

## Rust 讀取邊界

實作在 `crates/history-source-reader/src/posix/inventory.rs`，沿用現行 reader 的
root dev/inode、逐層 no-follow、fd UID/mode、無 extended ACL、本機 filesystem
與同 device policy。macOS noowners 和 Windows 原生 reader 仍拒絕。

- `openat` 由已持有 root/project fd 開啟單一 component；不使用 `/proc/self/fd`
  或重新拼 absolute source path。Directory 的內部 literal `.` 只建立新的
  directory open-file description，讓兩次 enumeration 有獨立 offset。
- `fdopendir/readdir` 一次只複製一個名稱，檢查 errno 區分 EOF 與失敗。
  不預先收取無限 directory list、不信任 dirent type。匹配格式的 project/session
  如果是 symlink、FIFO、hardlink、unsafe mode／ACL 等，整輪拒絕而不是隱藏它。
- 兩次完整、有序 metadata inventory 必須相同，project/root 前後 fd 狀態與
  name→object edge 重查，最後再開 canonical root 核對。失敗不回 partial rows。
  這是 observed consistency，**不是 atomic snapshot、檔案鎖或 native provenance**；
  ancestor acquisition、mount namespace、同 UID 偽造、觀察後變動等限制仍在。
- 每輪最多 10,000 個非 dot entries（包括 ignored）、512 個 project directories、
  2,048 個 session candidates、1MiB inventory JSON；共同 5 秒 Rust budget。
  超界回 `source_inventory_limit`，不截成看似完整的清單。IO 仍可能受 kernel 阻塞；
  parent 的 10 秒 deadline／1 秒 cleanup 與 actual-close 防線保持。
- Session 只開檔、讀 fd metadata，**不 `pread` 對話內容**。空檔和 >8MiB 檔仍列為
  候選，不能被當作可成功讀取；既有 content reader 另行執行完整 gate。
- Successful path 明確 close file／directory streams；所有 early errors 由 RAII
  釋放。close 失敗不輸出成功 inventory。Windows compiled CLI 兩種操作皆明示
  `source_platform_unsupported`，不將 unit tests 通過當成 Windows history 可讀。

## Private wire 與 owned worker

既有 protocolVersion 1 單檔 capture 不變。新 request 是 exact shape：

```text
{ protocolVersion: 2, nonce, projectsRoot, expectedRoot: { device, inode } }
```

Root 及 expectedRoot 由 trusted Host 選定，nonce 只做 correlation；不接受 browser
path、flags、limits、SDK、env 或 command。v1/v2 request 不能互相偷渡欄位。

Response 仍是 4-byte BE header length＋最多16KiB JSON header＋bounded payload。
`native_source_inventory` header 包含 payload byteLength/SHA-256、entryCount、
projectsScanned、ignoredEntries、expectedRoot、exact observed checks，以及
`sourceAuthenticated:false`／`publishable:false`。Payload 是 sorted array：

```text
[{ projectKey, sessionId, identity: { device, inode, size, mtimeNs, ctimeNs } }]
```

父層在 fatal UTF-8／JSON 前限制 bytes，核對 nonce/version、完整 hash、root、
數量、排序／唯一性、每筆 metadata 和非 authority flags；不回 raw payload bytes。
`createNativeHelper().inventory()` 與 `.read()` **共用同一個 single-flight**，
沒有 queue；只有 owned child actual close 才發布。取消／deadline／shutdown 只
signal 本次 ChildProcess，unknown close 永久 quarantine；晚到 close 不復活結果。
獨立 index 目前未加入正式 Host 的全域 reader admission，接線前仍須完成共用預算。

## Host-private 索引

`history-source-index.js` 是未公開的、單來源 group 核心：constructor 接受已選定
sourceId/root identity/helper 與同步 `authorize(principal, sourceId)`，本身不掃描。
每次 refresh／讀 snapshot 都檢查目前 source authority，飛行中結果送出前重驗。
Host 必須主動同步呼叫 revokePrincipal，shutdown 撤銷工作並清空 metadata。
這是 trusted callback 接入點，**不是已接上現有 cookie/grant 的來源設定功能**。

成功掃描原子取代最多2,048筆 snapshot，計算 added/changed/removed；catalog ID
是 sourceId/root identity/projectKey/exact UUID tuple 的 SHA-256，不使用 title、cwd
猜測去重。Hash 不是憑證，metadata 不能授權讀取／resume／approval。
失敗保留先前 snapshot 並標 stale；成功空 inventory 才能清空清單。
stale=false 只代表最近一次掃描成功，不代表之後 native 檔案未變。
沒有 background watcher／TTL／自動 retry／持久 DB；目前「增量」是 metadata 差異
索引，**每次仍完整雙掃目錄，不是 filesystem notification 或零掃描索引**。

Snapshot 含私有 path，**不可直接轉發到 HTTP／舊 Host-wide catalog**。
也沒有原生 title／preview；不把 UUID 或第一行文字冒充 session 名稱。
下一段需要：來源層 opt-in／reader scope 設定、全域 admission、catalog 分頁及
動態 registry 撤銷、固定版本原生 metadata/title、按需安全讀取，最後才接 Web。
Codex／OpenCode／Pi／Grok 等需各自 reviewed format/API adapter，不共用猜測 parser。

## 驗證與重跑

只使用自己建立的 canonical local temp fixtures；沒有私人 history／帳號／模型。
Build output 固定放本機 temporary target，不寫入 SMB：

```sh
CARGO_TARGET_DIR=/absolute/local/temp cargo +1.97.1 test --locked --all-targets \
  --manifest-path crates/history-source-reader/Cargo.toml
CARGO_TARGET_DIR=/absolute/local/temp cargo +1.97.1 build --locked \
  --manifest-path crates/history-source-reader/Cargo.toml
CARGO_TARGET_DIR=/absolute/local/temp node scripts/check-native-history-reader.mjs
node --test test/claude-history-inventory.test.js
```

Rust 新增 strict wire、exact/over bounds、empty/large metadata、ignored counts、
links/FIFO/mode/ACL、root identity 及 between-pass append/delete/edit/replacement
fixtures。Node 新增 scope/hash/count/order/byte limits、shared flight、unknown close、
source authority、incremental changes、stale保留與恢复、late revoke/shutdown。
實際 Node→Rust script驗目錄新增／移除、unsafe candidate不清舊snapshot、恢復及原檔
不變。最低 Node22.19.0 也重跑完整 Rust→SDK0.3.259→registry→HTTP／actual Host，
四來源／分頁／撤銷 gate通過，owned cleanup已確認；新探索本身仍未接HTTP。

本機 Rust17/17、strict TS／產物／syntax／version已過。一般Node完整回歸及跨平台
以本次 exact commit 的 CI結果為準，不沿用上一批綠燈。
沒有做新 browser／真機／效能／RSS改善宣稱，因為此次沒有變更Web UI。

### 本機回歸的限制

開發中途與Rust測試／編譯並行的一輪678項回歸有1項失敗；當時只保留尾端統計，
無法確認是哪個case或根因，不能宣稱已定位修復。其後678項重跑零失敗，最終679項
連續兩輪（677pass／2平台skip）與下列三OS exact-commit CI均零失敗。
這些通過結果不抹去該次未定位失敗，也不構成高負載／無flaky／整體穩定性證明。

### Exact commit 驗收

程式／測試 **`25c91bb117af7791ca70feb52a84dcd951798d23`** 已push，三組workflow全過：

| Gate | 已核實的範圍 |
| --- | --- |
| [一般CI 34207765820](https://github.com/seehow624/stepsemble/actions/runs/34207765820) | 每OS679項／0fail：Mac677pass2skip、Linux676pass3skip、Windows648pass31skip；每OS Ajv1251cases |
| [Native reader＋audit 34207765833](https://github.com/seehow624/stepsemble/actions/runs/34207765833) | Rust Mac17/Linux17/Windows8；每OS Node56/56；Mac/Linux實際inventory增量/stale/recovery及既有SDK→actualHost過；Windows兩種compiled CLI操作皆明示unsupported；locked RustSec audit成功 |
| [Native Claude 34207765784](https://github.com/seehow624/stepsemble/actions/runs/34207765784) | 固定SDK三OS合成history contract、modelCalls0、nativeFileUnchanged=true；不是Windows source支援 |

未變更UI/assets，這批未重跑browser rolling，不沿用舊rolling當作本SHA的新UI測試。
本機release helper另在最低Node22.19.0跑既有SDK→actualHost鏈成功，SHA256
`ea6b20d9ec8f2b76f107893648eb0d0ecf329f47c8f88cba23fe67c9c3e830fc`；debug的
inventory＋舊pipeline SHA是`efedbde33d9ddcf8ed5f6aa084284349c3bbc0a4bd56b1bad4636452572e634a`。
不把debug inventory的驗證冒充release inventory已另外實跑；build/fmt/Clippy皆過。
後續純文件commit與這份程式證據分開，不將commit改寫為未知future revision。
