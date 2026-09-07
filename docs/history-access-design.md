# Claude 歷史安全接入設計（Plan 1.41）

日期：2026-09-08。**以下是待實作 proposal，不是已上線 API 或權限保證。**
本批只完成共用 provider decoder；未新增 HTTP route、來源登記或認證資料，
未部署／讀取私人歷史／更改官方登入。正式 3.0.6 與固定來源 72h 長測不變。

## 目前能重用什麼

| 本地程式依據 | 已有能力 | 不可誤認為已有 |
| --- | --- | --- |
| `server/http-utils.js` 的 `authenticate` | Browser cookie／peer bearer 驗證；peer 回 grantId/device | Browser 目前只回 mode，沒有 per-device/per-tab principal；peer grant 本身不是 session 級 ACL |
| `server/device-trust.js` 的 `authenticatePeerCredential`／`revokeIncomingGrant` | Hash-only 持久 peer grant，可撤銷 | 尚無 active-history binding 索引／撤銷後中止讀取回呼 |
| `server.js` 的 `cookieSuffix`／`isCrossSiteMutation` | HttpOnly、SameSite=Strict；檢查部分跨站 mutation | 缺 Origin 會放行；只比較 URL.host（包含 port，不包含 scheme），無 history 專屬 CSRF 規則 |
| `server.js` 的 `/r/<machineId>/api/*` relay | 已配對時只用 dedicated peer bearer，不回傳 Set-Cookie/auth challenge | Legacy 仍可走 shared cookie；一般 pipeline 沒有 history response byte cap |
| `protocol/native/claude/history-source-service.js` | Trusted-only bind、單 binding flight、共用 2 workers、generation/revoke、version fence、close/quarantine | 不是 authenticated source registry；64 binding tombstones 沒有通用 view allocator |
| `client/claude-history*.ts`、`client/history-pages.ts` | 共用驗證器、有限分頁、舊 ticket 排除、stale／refresh 原子替換 | 不是 HTTP transport／真 UI／native origin authenticity／durable journal |

不要重用 Pi 的 `/api/session?file=` 作 Claude 歷史入口。它以 Pi sessions-root
containment 驗證檔案，回的是 legacy session 形狀；新的 inert 資料不得誤入
rename/archive、approval、resume 或 normalized journal 路徑。

## 三層身份必須分開

1. **Authenticated principal**：Host 驗證的身份，決定能讀哪些已登記來源。
   Peer 用當前有效 grantId/device；Browser 目前是 host-wide token 登入。
   如要區分不同 browser device，必須另做可撤銷 device grant，不能靠 client
   自報 deviceId。內部 principal reference 不應含明文 credential，也不能由 body 指定。
2. **View／tab reference**：只用於分頁隔離與生命週期，不是新權限。
   同一 browser profile 的 tabs 共享 cookie；再加一顆 cookie 也不是 per-tab
   認證。不同 view 不共用一份會被 refresh 替換的 sourceVersion。
3. **Source binding**：Host 自派 bindingId/generation，绑定已授權 principal、
   view、原生 session 與 server-resolved source；請求不能帶原生路徑或 SDK path。

Relay 的 peer grant 識別的是 gateway device，不會自動證明 gateway 後方的
各個終端使用者。不能把 downstream 自報 viewId 說成跨使用者 ACL。

## 最小分階段實作

### A. 先做 registry／pool 的純狀態與隔離測試

- Host 管理的 catalog 先把授權工作區／固定官方 Claude session 解析成來源。
  Client 只能選 catalog opaque ID；不能送 projectsRoot/projectKey/file/sdkPath/
  executable/env。未知來源與未知版本拒絕，不靠任意掃描私人 HOME 補成功。
- Registry row 保存 internal principal、view、bindingId/generation/sessionId、
  trusted source handle、狀態與 lease；不存 raw history 或 native credentials。
  每次操作重新驗 current principal/grant 與 row ownership，不能只檢查 UUID。
- Host 共用**同一個** source service。Grant revoke、logout/token revoke、來源
  撤銷、view release/lease expiry、shutdown 都須 fan-out revoke；完成回覆前
  再確認 grant/registry generation 有效。只做 next-request auth 不夠。
- 每個同時開啟的 view 要獨立 binding，避免 A refresh 淘汰 B 的唯一 token。
  但每次開頁都創新 ID 會耗盡目前 64 個 tombstones，因此先做 bounded slot
  pool：同 principal 的空閒 slot 可跨 session 重用**同 bindingId、更高
  generation**，前提是 revoke 舊 handle 且確認 worker 已 close。Active/closing
  slot 不重用，不刪 generation fence，不重建 service 繞過 quarantine。
- 多 principal 的總 slot 預算也必須有界。跨 principal 回收要另外驗證原子
  owner 轉移、嚴格增加 generation 與舊 callback/credential 排除；驗證前只
  回明確 capacity unavailable，不能把 pool 當作已經解決任意長期 churn。
- Lease 限制 registry/view 生命週期，不把現有無 TTL 的 sourceVersion 說成
  有時間保證。Idle view 過期不停止原生 Claude task，只撤銷自己的唯讀 handle。

### B. 再做獨立 transport，先只接 synthetic source

候選 endpoints：`POST /api/history/registrations`、`POST /api/history/page`、
`DELETE /api/history/registrations/<id>`；名稱待 contract 實作定案。
Registration 只收 catalog ID/view reference；page body 僅
`{bindingId,generation,requestId,page:{offset,limit},version?}`，strict exact keys。
Host 自行恢復 session/source/SDK，不接受 caller timeout、source override 或 authority。

- Browser 分支要求 canonical origin 的 **scheme/host/port** 全相同、JSON
  content type、history CSRF header，拒絕缺失/無效 Origin。不盲信 request Host
  或未經驗證的 forwarded headers；HTTPS reverse proxy 的允許 origin 必須來自
  trusted Host 設定。保留舊 API 相容，不直接改全域 auth 行為。
- Remote/native 分支要求可撤銷 peer grant。新 history route 不允 legacy
  shared-cookie relay，也不讓 invalid bearer 回退 cookie；混合憑證策略明確
  fail closed。現有 `authenticate` 會在 invalid bearer 後考慮 cookie，不能
  不加檢查就拿來當這個新 contract。
- 不加 wildcard CORS、反射 origin 或 credentials。初期 same-origin／既有
  trusted relay；跨 origin native client 若需要，另驗 exact allow-list。
- Host 在 serialize/write 前限制 outer response ≤272KiB（child frame 仍
  ≤256KiB）。Browser／relay 串流讀取**解壓後 bytes**時累計限额，超額 cancel/
  abort，之後才 fatal UTF-8 decode 和 JSON.parse；不能只信 Content-Length，
  也不能沿用無界 `response.json()` 或一般 relay pipeline。
- HTTP aborted／response close 且未正常 writableEnded 時取消本次 observe；
  finally 移除 listeners。正常 response close 不應當失敗。Client cancel 只
  保證本地舊資料不發布，不是 worker close 證據。
- `source_cleanup_unconfirmed` 保留 worker slot 並 quarantine 共用 service；
  late close 不發布，也不自動解除 quarantine。沒有 Host/process restart 捷徑。
- 回覆 no-store、固定 sanitized code，不記 raw transcript、路徑、query token
  或 credentials。固定官方 SDK pin 漂移拒絕，不安裝或呼叫 query/login/model。

### C. 過 gate 才接真實 inert UI

先驗證 synthetic Client → authenticated transport → registry → source worker
全鏈，再接正式歷史顯示與 stale/refresh/capacity 控制。任何 public response
仍 `sourceAuthenticated:false`、`publishable:false`、approval ACK／run-terminal／
resume authority 全 false；不發 journal event，不對工具輸出自動採取行動。
來源 UID/mode/雙讀、官方 SDK hash 只給 observed consistency/drift evidence，
不是 provenance、完整 ACL、atomic descriptor containment；Windows native source
gate 尚 unsupported。上線前仍要獨立處理這些缺口與來源顯示措辭。

## 接入前驗收清單（全部尚待）

- [ ] 任意 path／SDK／source 欄位、未知 catalog ID、未授權 source 在 spawn 前拒絕。
- [ ] 跨 principal/view/binding/generation、失效 grant、logout/revoke 中途、late response 全拒。
- [ ] A/B 同 source 各自 refresh/續頁不互相污染；原檔改變各自變 stale。
- [ ] 單 slot 跨 session churn 1000 次不增加 tombstone，舊 gen/token 全拒；64-slot cap、closing slot、owner 轉移、quarantine 均驗。
- [ ] 缺／偽／異 scheme Origin、無 CSRF、混合 auth、invalid bearer fallback、legacy relay 均拒絕。
- [ ] Browser/Host/relay 的超額與慢分塊、假 Content-Length、壞 UTF-8、中途斷線，無 partial publish／無界 buffering／遺失 abort listeners。
- [ ] Source grant subtree、POSIX ACL/descriptor containment、Windows ownership gate 與 SDK loader 競爭有獨立驗收。
- [ ] 真瀏覽器/手機與多 Client 效能、stale/refresh/capacity 錯誤介面，再做可回滾部署。

這份設計不代替 native session/approval 全能力、durable journal、Rust migration、
App Shell 或實機長測；72h 的 fixed-source 結果也不能涵蓋本批尚未上線的功能。
