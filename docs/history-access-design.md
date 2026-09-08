# Claude 歷史安全接入：實作狀態與剩餘 gate

**Plan1.46更新**：開發候選rc.3已掛入實際server.js／Agent Hub／獨立頁面，
但預設停用、未部署、沒有私人來源登記。新接線／權限／操作方式／當前驗收以
[history-host-integration.md](history-host-integration.md)為準；下方保留1.42–1.45
階段記錄，其中「尚未接入正式server」不能再當作最新開發狀態。

日期：2026-09-08。這份文件接續 Plan 1.41 proposal，區分已完成的 reserved
implementation、synthetic 驗證與尚未達成的 production 條件。**正式 server/app
尚未啟用新歷史 routes 或 UI**；隔離預覽只建立自己的合成來源，未掃描／讀取
私人 Claude 歷史、變更官方登入或呼叫模型。未部署，固定來源 72h 長測不變。

## 已有元件與邊界

| 元件 | 本輪已有能力 | 不代表已完成 |
| --- | --- | --- |
| `protocol/native/claude/history-registry.js` | Host 固定 catalog、principal/view/binding 隔離、64-slot pool、租期、撤銷與 actual-close 再利用 | 正式來源登記 UI、原生來源認證、ACL／descriptor containment |
| `server/history-identity.js` | 注入既有 cookie／peer authority，建立有界 opaque principal，rotation/logout/revoke fan-out | 新登入系統、browser device grant、per-tab authentication |
| `server/history-http.js` | 注入式 catalog/register/page/release handler、exact Origin／CSRF／auth、byte cap、取消及送出前重驗 | 已安裝在 `server.js` 的 production routes |
| `server/history-relay.js` | dedicated peer bearer、有界本地 owner mapping／解壓後收取、current peer／principal 重驗與取消 | legacy shared-cookie relay、gateway 下游使用者的端到端 delegation |
| `client/history-transport.ts`、`client/history-pages.ts` | same-origin bounded transport、provider 驗證、分頁／version／stale fence | 原生來源可信性、journal publication、正式跨 Host UI 接線 |
| `client/history-view.ts`、`public/history-preview.*` | 隔離唯讀 UI、catalog 選擇、分頁／取消／手動 refresh、有限 DOM | 正式 app 入口、手機／多 Client 效能與可部署性驗收 |
| `protocol/native/claude/history-sdk.js` | 執行 exact hash-verified Buffer、resolution/cache fencing、one-shot SDK attempt | 原始 JSONL provenance、完整依賴／OS／網路隔離 |

不要重用 Pi 的 `/api/session?file=` 作 Claude 歷史入口。新的 inert 資料不可誤入
rename/archive、approval、resume 或 normalized journal 路徑。

## 三層身份與 Host wiring

1. **Authenticated principal**：Host 由當前有效 cookie／peer grant 得到穩定
   opaque reference。它不是 raw credential，不能由 request body 指定。
2. **View reference**：UUID，只隔離分頁與生命週期。同一 cookie 的 tabs 共用
   principal；自報 view ID 不是額外認證，也不是 browser device identity。
3. **Source binding**：Host 自派 bindingId／遞增 generation，綁定 principal、
   view、catalog source 與原生 session。HTTP 不接受來源路徑或 SDK 覆寫。

Identity adapter 每次驗證重新讀取注入的目前 authority；最多保留 21 個 browser
及 128 個 peer principal entries，只保留加鹽 fingerprint 與 opaque reference。
登入資料本身仍由原有 Host store 管理。Host 必須把 logout／token rotation／
grant revoke 同步接到 identity invalidation、registry revoke 及 relay cancellation。
單靠下次請求重新驗證不足以即時中止飛行中的讀取。

`invalidateBrowserCredential`／`invalidateBrowserCookie` 會撤掉當前歷史 scope，
**不會刪除原 store 的 shared token**；若該 token 仍有效，可建立新的 principal，
但不能復活舊 binding。真正撤銷 credential 必須先改 authoritative store。
`peerGrantIds` 與 credential lookup 必須反映有效／到期／撤銷狀態，不能只列曾存在的 ID。

Relay 的 remote Host 認到的是 gateway 的 peer grant，不能從自報 view ID 得知
gateway 下游的終端使用者。Gateway 以有界本地 mapping 檢查 downstream principal
到 remote binding 的 ownership，並自派 upstream view UUID；這提供 gateway 內的
scope fencing，仍不是 remote Host 的端到端 user delegation。

## Registry／pool 已實作

- 固定 Host catalog 最多 256 項；Client 只能選 bounded opaque `catalogId`。
  建構時 detach source，只接受 canonical absolute root／project key／session ID；
  不做 HOME discovery。未知／撤銷／未授權 source 在 worker spawn 前拒絕。
- 共用一個 source service：至多 64 個 stable slot，source service 共用 2 workers。
  row 不保留 raw transcript。每 view 有自己的 binding 與 sourceVersion；同來源
  的 A refresh 不取代 B 的 token，來源改變時各自的續頁會變 stale。
- release／principal revoke／source withdrawal／lease expiry／shutdown 先同步失效，
  再 revoke owned handle。只在 `status()` 確認 revoked、無 activeWorker 且
  cleanupConfirmed 後，才以同 bindingId、嚴格更高 generation 重用。
- 優先重用同 owner 的 idle slot，也可原子移轉給其他 principal。舊 row、callback、
  generation、token 不會取得新 owner 的 scope；沒有無界 per-principal tombstone map。
  active／closing slot 不可重用，滿額回 `history_capacity_unavailable`。
- 租期預設 60 秒，trusted constructor 可設 1ms–24h。相同 view/source 的明確
  register 會續租；observe 本身不續租。timer 會撤銷閒置／飛行中 view，操作與
  回覆前也重驗租期。這不是 token 本身新增 TTL，不會停止原生 Claude task。
- 註冊起初是尚未 observe 的 tentative row。Host 的 private
  `cancelRegistration(principal, receipt)` 只接受最新原始回覆物件的 identity，
  複製／舊 renewal receipt 不能撤銷較新註冊；回 true 只表示邏輯退役。首次合法
  observe 同步 claim，之後 renewal 也不能透過舊 registration rollback 撤掉它。
  同 principal/view 可在新 catalog 授權成功後替換未 observe 的 row，以恢復遺失
  註冊回覆的切來源操作；已 claim 的 row 仍須 release。Generation／actual-close
  及 quarantine 條件不變，拒絕新 source 不會破壞仍有效的舊 row。
- cleanup timeout 保留占用並 quarantine 原 service；late close 可釋放實體 slot，
  **不能解除 quarantine**。不得另建 service 或重啟 Host 來繞過。

Registry 測試包含 mocked token churn，以及真正 source service 的單 slot
跨 principal/session 1000 次 register/release：retained binding 始終為 1。
另驗 64-slot cap、closing、owner transfer、post-close/pre-publication revoke、
來源撤銷、租期、shutdown 與實際 permission worker 的自有 fixture。

## 保留 HTTP contract

每個 endpoint 都需要 UUID header `X-Stepsemble-History-View`。Browser 額外需要
`X-Stepsemble-History-CSRF: 1`、正確 JSON Content-Type 及 trusted configured Origin。

| Method／path | Exact JSON body |
| --- | --- |
| `POST /api/history/catalog` | `{}` |
| `POST /api/history/registrations` | `{catalogId, viewId}`；viewId 須等於 header |
| `POST /api/history/page` | `{bindingId, generation, requestId, page:{offset,limit}, version?}` |
| `DELETE /api/history/registrations/<bindingId>` | `{generation}` |

Catalog 回 bounded `{catalogId,label,description}` 清單，不回 path／principal／SDK。
Host 注入的 `listCatalog` 必須只回該 principal 當下可見的 metadata；registry 的
register 仍獨立檢查授權。Registration 回 binding/session/view/catalog/expiry；page
沿用嚴格 inert `bound_history_observation` envelope。每次送出前重驗當前 auth，
registration/page 再驗 registry owner、generation 與租期。
HTTP 保留 register 的原始 private receipt，在已知 timeout／abort／auth failure／
無效回覆等尚未正常送出的情況 best-effort rollback；晚到結果也走同一精確 receipt。
已正常 `res.end` 不取消，更不以複製的 JSON 回覆撤銷新 renewal 或已 claim 的讀取。

Browser Origin 需完整 scheme/host/port 相符，缺失／偽造／不同 scheme 拒絕；不信任
request Host 或任意 forwarded header。CSRF header 是 intent marker，並非秘密。
Cookie 與 Authorization 混用、invalid bearer fallback、重複安全 header 均拒絕。
Peer 只接受 dedicated 可撤銷 bearer；帶 Origin 的 peer 仍須符合 browser intent。
不加入 wildcard／反射 CORS 或 legacy shared-cookie fallback。

Host body 上限 8KiB／1024 chunks、deadline 15 秒；outer response 上限 272KiB，
child page frame 仍為 256KiB。Browser 與 relay 以單一固定 buffer 累計 **fetch
解壓後 bytes**，超額取消；不信 Content-Length，不用無界 `response.json()`。
完成 byte bound 後才 fatal UTF-8 decode／JSON parse／shape validation。逾時、
中途斷線、late fetch、忽略 abort 的 adapter 不發布 partial data；finally 移除 listeners。
正常 response close 不當成取消。回覆 no-store 與固定 sanitized code。

Relay 預留 `/r/<machineId>/api/history/*` namespace，由 Host 解析 canonical peer
origin、grantId 與 credential；只送 dedicated bearer，不傳 browser cookie、Origin、
Set-Cookie 或 auth challenge，不跟 redirect。最多 64 個 relay flights，peer rotation／
revoke／logout／shutdown 可 abort active streams。它沒有安裝進正式 relay pipeline。
本地 ownership map 最多 64 rows，key 為 principal/machine/view tuple；pending 註冊
尚不能讀取，完整驗證後才 active。不同 principal 即使使用相同 caller view ID，也會
取得不同 upstream view UUID。Page/release 必須匹配本地 owner、binding/generation；
遠端同 ID 更高 generation 轉移會淘汰舊 owner。Release 先標 closing 並取消 page，
cleanup 未確認就保持 closing。Revoke 清除本地 row 並取消 streams；未知／閒置遠端
handle 仍靠 remote lease 收回，不把 local map 刪除說成 actual remote close。
未 observe 的 source change 沿原 upstream view 交由 remote registry 授權後替換；
拒絕新 source 時保留舊本地能力，已 observed row 仍須 release。Relay 的 private
receipt cancellation 只把本地未 observed row 退回 pending，以供重新註冊／租期回收，
不送可能晚到並誤撤新 renewal 的非同步 DELETE。
現有 browser transport 固定走 local `/api/history/*`；跨 Host selector／relay prefix
尚未接進預覽 UI，不能把 unit relay coverage 說成真實跨機 UI 驗收。

## 隔離 preview 與 SDK loading

`scripts/history-preview-server.mjs /absolute/pinned/sdk.mjs` 只在 loopback 隨機 port
啟動自己的 HTTP server、temporary synthetic JSONL 與臨時 cookie。Catalog 有 rich、
compaction、file-history，以及 1000 則長對話範例；不掛載私人來源。CLI 的 `change`／
`revoke` 只操作此 preview fixture／credential：revoke 先 rotate synthetic cookie，
再撤銷舊 principal，重新載入頁面才取得新 cookie。正式 `server.js`、`public/app.js`
沒有載入這個功能，預覽也不註冊 service worker。

UI 每次明確讀取先 register/續租，換 generation 時禁止直接續舊頁，保留先前頁面直到
refresh 成功原子替換。切來源會釋放舊 binding；取消／close／pagehide 只要求本地取消
及 release，**不是 actual worker close 的證據**；lease 是未完成 release 的後備機制。
文字、工具、附件、URL 外觀內容都用 inert text/details，不產生可執行連結或附件 fetch。
DOM 每畫面最多 10 則、每訊息 24 blocks、48000 文字 units；長資料明示縮短顯示。
DOM/model 測試不取代真 browser／手機／多 Client 效能與無障礙驗收。
註冊取消的 Host cleanup 只能 best effort：server 正常送出回覆不代表 browser 已消費，
不能靠 disconnect 推論每個 lost reply。Tentative replacement 與 lease 為此保留恢復途徑。

SDK source 在讀取前檢查 size，再由一個 descriptor 以 64KiB chunks bounded read，
驗證 exact SHA-256。Node 的同步 `registerHooks` 只攔 exact nonce file URL 的
resolve/load，直接提供已驗證 Buffer，保留 `import.meta.url`／`createRequire` 語意。
nonce 避免命中既有 plain-path ESM namespace，resolve hook 避免 symlink 重新導向。
import 後 finally deregister，仍重新讀取／核對磁碟 artifact 以拒絕已觀測 drift。
每 owned worker/module 只有一次 attempt，失敗也耗用，不建立無界 nonce module cache。

9 個 SDK loader 測試驗證 overwrite/symlink swap-and-restore、舊 cache、前後 drift、
oversize/growth、短讀、close 失敗與既有 permission profile。**本機實際 Node 22.19.0**
已跑過這些測試與完整 pinned SDK contract，後者包含 real loopback HTTP → registry →
owned source worker → official SDK → Client paging、owner transfer 與 in-flight revoke。
結果為 synthetic POSIX fixture passed、`modelCalls:0`、來源 bytes unchanged。
Script另以兩個loopback listener實測dedicated relay→remote registry→固定SDK，
同caller view的不同browser principals不能借用binding；`relayScopeGate`與
`relayDownstreamOwnerIsolation`有actual fixture證據，但不是跨機browser UI。
主代理另以Computer Use操作隔離viewer，詳見 [history-preview.md](history-preview.md)。
CI matrix 設定 macOS/Linux/Windows + Node 22.19.0；設定存在不代表本輪 CI 已執行完成。

## 尚未完成的 production gate

2026-09-08 增量：[`小型 Rust reader`](native-history-reader.md) 已實作獨立 POSIX
fd ACL／openat／root identity capture 與 Node owned runner；尚未接進上述 source
service／SDK worker 或正式 Host。Windows CLI 仍 unsupported，permission probe
另驗。下列完整 production/source-authentication gate 仍保留，不能把本 helper 的
observed checks 當成已完成所有 ancestor／namespace／provenance 保證。

- 正式 Host 的 source 授權/catalog 維護、cookie/logout/token/grant lifecycle wiring、
  route／origin/reverse-proxy 設定、跨 Host UI 與端到端下游 user delegation。
- Source ACL／descriptor-relative containment、完整 ancestor 信任、Windows
  owner/ACL/reparse-point gate，以及 native provenance。目前 POSIX uid/mode、雙讀、
  inode/hash 只證明已觀測一致性；SDK exact bytes 不替原始 JSONL 提供來源認證。
- Node 22 沒有公開 `fs.openat/openat2` 或 fd ACL API。傳 source fd 能縮小 child 的
  路徑讀取需求，但 parent 初次 open 的 ancestor race／阻塞及 cleanup 仍需處理；
  不可把 `/proc/self/fd` 拼接當成跨平台 containment。完整 gate 需要原生 helper。
- Node permission model 不是防惡意程式的 sandbox：既有 fd 可繞過其 path checks，
  symlink 可跟隨到 grant 外，directory grant 也涵蓋 descendants。直接 outside-root
  deny canary 不等於 single-file isolation、ACL audit 或 OS/network sandbox。
- 多 Client admission／資源壓力、真 browser/mobile 與可回滾部署驗收；更完整附件、
  subagent、approval、resume、durable journal 等仍有各自的 capability gates。

所有觀測仍 `sourceAuthenticated:false`、`publishable:false`，approvalAcknowledged／
runTerminalObserved／resumeAllowed 全 false；不發 journal event，不執行來源中的指令。
固定來源 72h 長測不能替代這些新 contract 與剩餘 gate。

參考：[Node 22.19 module hooks](https://nodejs.org/download/release/v22.19.0/docs/api/module.html#moduleregisterhooksoptions)、
[descriptor 繼承](https://nodejs.org/download/release/v22.19.0/docs/api/child_process.html#optionsstdio)、
[Permission Model 限制](https://nodejs.org/download/release/v22.19.0/docs/api/permissions.html#limitations-and-known-issues)。
