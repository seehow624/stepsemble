# 原生來源群組：設定、動態綁定與分頁

2026-09-08，Plan 1.53；開發候選3.0.7-rc.6，正式3.0.6未變。
**來源群組已接入實際 Host 的設定、HTTP／dedicated relay 及原生內容讀取鏈。**
原生名稱及TypeScript source transport也已接真SDK合成鏈。
本批已接Web來源選擇／分頁／按需名稱，沒有新增私人來源或部署。
來源授權設定仍是operator私有檔、其他harness adapter及實機完整驗收仍待；
不是「全部原生對話已完整收錄」。

## 明確授權範圍

舊 `version:1` 的逐 session 手動 catalog 繼續可用，不自動遷移或擴大。
新 `version:2` 保留全部 v1 欄位，另要求 exact `sourceGroups` array，最多8組。
每組格式如下；所有路徑都是需替換、經 owner 決定的範例：

```json
{
  "sourceId": "reviewed-claude-root",
  "agentId": "claude-code",
  "scope": "main_sessions",
  "label": "已確認分享的 Claude 主對話",
  "description": "",
  "projectsRoot": "/absolute/approved-claude/projects",
  "expectedRoot": { "device": "1", "inode": "2" },
  "readers": ["browser:master"]
}
```

`expectedRoot` 必須來自實際選定 root，不能照抄上述數字。Reader 使用既有
browser credential ID 或 incoming peer grant ID，不是 raw token。群組授權包含
這個 root 下**目前及之後新增、符合範圍的主對話**；分享前必須理解這項差別。
不遞迴 subagents、附件、備份，也不探索其他 agent 的目錄。未知 scope／agent、
wildcard reader、重複 source ID／root、同 root 不同 dev/inode 都拒絕。
group＋manual catalog 合計最多256個獨立 root；動態 ID namespace 不與手動 ID 混用。

群組仍受原 reader 的 POSIX UID／mode／ACL／root identity／local filesystem gate
約束，macOS noowners 與 Windows 原生 reader 仍拒絕。設定合法不等於讀取已驗收；
不自動修改權限、搬資料、安裝 SDK、登入或更動第三方模型路由。

建立**新的**私有設定檔（父目錄必須已存在、private 且受可信 owner 管理）：

```sh
node scripts/history-config.mjs create-group /absolute/private-config/history.json \
  --origin https://your-host.example \
  --helper /absolute/private-tools/stepsemble-history-source-reader \
  --sdk /absolute/private-tools/claude-sdk/sdk.mjs \
  --projects-root /absolute/approved-claude/projects \
  --source-id reviewed-claude-root \
  --scope main_sessions \
  --reader browser:master \
  --label '已確認分享的 Claude 主對話'
```

沿用 exclusive create／0600／fsync，不覆寫既有設定；只取得 root metadata，
不掃描／讀 transcript、不重啟 Host。`check` 會回傳 manual catalog 與 group 數量。
多來源設定由 operator 在私有檔明確維護；目前不是 Web 設定表單或 hot reload。
正式採用仍須既有 active-work／來源及讀者確認／備份回滾／受控重啟 gate。

## 真正接入的資料流程

- Host 啟動建立最多8個 index object，**不啟動掃描子程序**。所有 index 與 content
  service 收到 Host 持有的同一 admission；全 Host 最多2個飛行工作、無 queue/retry。
- 每組最多2,048個 candidates、1MiB native inventory，最多8組即16,384個候選上限；
  不是一個無界總清單。HTTP 每頁最多50列，沒有把私有完整 snapshot 序列化出去。
- 新 trusted dynamic resolver 從目前索引取得 source＋私有 entry revision；registry
  只保留64個既有 slot，不複製／擴張舊256筆 catalog。先授權才查來源，拒絕 async／
  getter／不合法 resolver 結果。Entry revision 或 exact source tuple 改變即失效。
- 相同 metadata 刷新保留 entry revision；變更、移除後再加入均換新 revision。
  成功 refresh 後同步 sweep，retire 舊 binding、版本 token 與飛行中發布權；之後
  仍依 actual-close 才可重用 slot，不重建 service 來逃避 quarantine。
- 每次成功 inventory 都換一個 snapshot UUID，續頁必須回傳同 token；跨 refresh、
  Host 重新啟動、空清單改變不能拼頁。這不是磁碟 atomic snapshot 或來源認證。
- 掃描失敗保留上一份清單並標 stale；成功空清單才清空。stale候選仍可按需嘗試
  讀取，但 content reader 會重新驗證檔案／來源版本；metadata不是內容授權證明。
- Credential/logout/grant 撤銷也 fan-out 到 index。可信 Host 的 `revokeSourceGroup`
  先同步撤銷該群組，再關閉其 index；不撤銷另行授權的 manual entry。boolean只
  表示邏輯撤銷，Host shutdown 另等待所有 index/service 的真實清理證據。
- 任一 unknown cleanup 使共用 budget 永久 quarantine；晚到 close 不復活結果，
  cached shutdown unknown 不會改寫成成功。關閉一組不取消其他組已授權的工作。

## HTTP／relay 契約

沿用 exact Origin＋JSON＋CSRF marker、view UUID、當前 credential 檢查、8KiB body、
15秒 deadline、272KiB decoded response 與固定錯誤碼。沒有 browser path／env／
SDK／worker count 選項；配對只走 dedicated peer，不退回 legacy cookie relay。

| POST route | Body 與回傳 |
| --- | --- |
| `/api/history/sources` | `{}`；回傳 `history_sources`，只含該讀者可讀的 sourceId／agentId／scope／label／description；不掃描 |
| `/api/history/source-catalog` | `{sourceId, page:{offset,limit}, snapshotId:null或UUID, refresh:boolean}`；回傳 `history_source_catalog`，含當前 snapshotId、page／total／nextOffset、stale／refreshing／lastError 和最多50列 |
| `/api/history/source-metadata` | `{sourceId,catalogId,snapshotId:UUID,requestId:UUID}`；回傳 `history_source_metadata`，含上述correlation及 `metadata:{sessionId,nativeTitle,summary,titleStatus}`；一次按需原生唯讀 |

`refresh:true` 只接受 offset0、snapshotId:null；每次都是明確、單次刷新。
`refresh:false` 只讀現有 snapshot，未掃過回 snapshotId:null／total0／stale:true；
不是「沒有任何對話」的確證。續頁 offset>0 必須帶 snapshotId，舊版本回
`history_catalog_changed`。同一 endpoint 可經 `/r/<machineId>` 使用。

列目前只有 `catalogId`、`nativeTitle:null`、`titleStatus:"not_loaded"`。
**列舉本身不讀 title**；新增metadata route才按需取得。沒有把 source label、UUID、檔名或第一行冒充對話名稱。
不回私人 path／dev-inode／readers／完整 inventory／transcript。
選到 catalogId 後沿用既有 register→page→release，原生內容依固定 SDK gate 讀取。
HTTP 送出前再驗 source authority／snapshot，relay 兩端驗 exact inert envelope。

## 原生名稱／metadata 的邊界

- 固定SDK0.3.259的 `getSessionInfo` 使用既有captured records，one-shot module
  loader只允許明確的 `getSessionMessages` 或 `getSessionInfo`；不暴露整個namespace
  或 `query`。SDK只拿memory SessionStore，同session/projectKey最多一次load，
  append／額外或跨scope load即使被SDK吞掉例外仍拒絕；不給SDK私人目錄權限。
- metadata私有protocolVersion3沒有page，內容version2維持不变；回覆operation／
  nonce／request／session／reader pin／raw hash與完整identity都必須一致。metadata
  worker同13個named runtime/SDK read grants，不加source/HOME/write/child grants。
- `nativeTitle`只取SDK `customTitle`（SDK自身包含aiTitle選擇），與SDK `summary`
  分開。後者可能是first/last prompt，不能當原生名稱。缺title是null＋untitled，
  有原生title是native；title1024／summary4096個UTF-16 code units，壞型別／控制字元／超限回固定錯誤。
- 查名稱也有完整原生read成本，與inventory/content共享兩flight而不是獨立pool。
  Host在既有64-slot registry建立短期private view，完成/失敗均release，不能用caller
  view取代或續約使用者正在閱讀的內容。連續70讀＋一個active conversation保留2slots。
- 列表snapshot只證明當次inventory metadata。查名稱重新capture後，需與該catalog
  entry的dev/inode/size/mtimeNs/ctimeNs完全相符，回覆前再次驗snapshot/entryrevision
  與readers；對話在列舉後改名／刪除，不會被貼上舊snapshot，回history_catalog_changed。
- Host-private回覆限32KiB，公開回覆只留受限metadata與correlation及false authority；
  不序列化source identity/path/SDK cwd/gitBranch/tag/raw records/registry binding。
  原token/Origin/CSRF/15s/取消/relay decoded cap不變，也不新增對外metadata快取。
- strictTS `sources`／`sourceCatalog`／`sourceMetadata`共用既有bounded exchange，
  Client與Host validators對照測試、wrong snapshot/request/status/extra fields/過量
  Unicode資料/取消/晚body/解壓bytes上限覆蓋。舊Host不支援或busy不自動fallback/retry。
- Web列表現在按需逐一讀可見名稱，不能為了列表一次預讀全2048個transcript。

## Web來源列表（Plan1.53）

- `client/history-sources.ts`模型與render分離；初始只詢問已授權來源及現有索引，
  明確按重新整理才掃描。不提供私人路徑輸入或擴reader grant的捷徑。
- 每頁最多50列，保留當前選取的一份metadata；前後翻頁均帶snapshot UUID，
  舊回覆受epoch/source/snapshot/catalog/request隔離。失敗保留stale列、不可翻頁或
  新開；真正空結果才清空。撤銷/auth失效清除來源顯示及內容view。
- IntersectionObserver以內層清單為root，逐一讀可見列名稱。捲離取消該UI的名稱
  請求；背景頁暫停，回前景不自動重試。沒有observer時可用每列「讀名稱」手動操作。
  source_busy/error不自動retry；所有名稱仍受Host共享2flight actual-close預算。
- row與retry DOM在名稱到達時保持同一節點，full native title與summary分別顯示；
  title缺少明示未命名、不用摘要冒充。小螢幕名稱最多三行，可展開完整原文，
  summary另置原生details。含script標記的名稱只進textContent、不建立HTML/URL。
- 開啟內容使用獨立view，名稱變更不重建正在讀的內容；快速選擇只等待一次舊view
  cleanup後開最新一項。清單換snapshot保留舊選取但警示，重新點列才重開當前內容。
  手動catalog收在lazy details；無群組時沿用原viewer。舊Host不支援群組不會假造來源。
- 清單原生內捲動、overscroll containment、44px控制、鍵盤焦點與返回清單；保持
  B+logo及現有light/dark/reduced motion/transparency/contrast媒體規則。
- HTML入口現在no-cache/revalidate，含304回覆，避免更新後history document仍指向
  舊版本JS達24小時。版本化static assets仍保留快取，不取消整站cache。

### Plan1.53本機與瀏覽器證據

本機742 tests＝740 pass／2平台skip／0 fail；新增12項model/renderer涵蓋晚回覆、
撤銷、來源切換、snapshot、lazy名稱、焦點、完整文字及cleanup最新選擇。首輪唯一
失敗是rc.6缺CHANGELOG項，已補後重跑；以前678項未定位失敗仍未解釋。
最低Node22.19原生pipeline通過，actualMetadataGate/sourceGroups/Host/shared gate
保持passed，model/privatehistory=0，ownedcleanup確認。

Codex Computer Use→actual server.js→Rust→固定SDK，用64個owned合成來源：
50/14列前後翻頁、可見5列起始名稱、inner scroll不帶動outer、320/390px無横溢與
44px控制、中文/emoji/script inert長名稱展開、選取正文、原檔改名後明確refresh/reselect、
舊snapshot警示、manual4來源相容、console0error/warn；關閉後點同列可重開內容，
三個GUI測試Host均actual cleanup，預覽分頁已關閉、viewport override已還原。
本機觀察為dark，不冒稱Safari/手機實機或light實測；新增CI真native gate在Mac/Linux
各跑1440/390/320×light/dark，全部通過，exact commit記錄如下。

### Plan1.53 exact commit CI

工程commit `c88f52668daa089f96f377964d8d0b6c7084b3c5`：

- 一般CI [34224589995](https://github.com/seehow624/stepsemble/actions/runs/34224589995)
  三OS742項/0fail：Mac740pass/2skip、Linux739/3、Windows710/32；各Ajv1251。
- Reader [34224589935](https://github.com/seehow624/stepsemble/actions/runs/34224589935)
  三OSNode77/77、Rust17/17/8；Mac/Linux actualHost/sourceGroups/Metadata/shared
  gates全部passed；Windows actualHost仍unsupported。locked RustSec0known/0warnings。
- NativeClaude [34224589996](https://github.com/seehow624/stepsemble/actions/runs/34224589996)
  三OSSDK0.3.259、modelCalls0、nativeFileUnchanged true。
- 首輪rolling34224590024雙OS在測試locator失敗：`.source-detail h2`同时選到外層
  原生title與內層hiddenheading，不是native reader失敗。完整diagnostics保留。

修正測試locator的 `f1f47caacdaeee6a1dceaa366fb206a99a6763b5` **只改測試script的四個
selector，沒有runtime變動**：

- 新[rolling34224865408](https://github.com/seehow624/stepsemble/actions/runs/34224865408)
  Mac/Linux各24cases全部passed。每OS六組新native來源case確認64來源、50列、
  noImplicitScan、visibleNamesOnly、stableFocusAndContent、fullNativeTitle、inertText、
  paging、closeReopen、staleRecovery、manualFallback、0model/0private/0pageErrors；
  每個ownedHost均cleanupConfirmed true。不是只重跑舊18cases。
- 新[一般CI34224865394](https://github.com/seehow624/stepsemble/actions/runs/34224865394)
  三OS742tests/0fail，pass/skip同上。上面的native gate屬runtime相同的c88f526，
  不冒稱f1f47ca另外跑過未觸發的workflow。所有log已逐項核對。

Plan1.56已補history UI的119keys/11語與切換保留，見[history-localization.md](history-localization.md)。
仍未完成：owner來源授權體驗／多語人工校稿／真Safari與跨機／其他harness原生
歷史與session/approval/durable／完整性能與發布關卡；C1及整個Web goal不勾完成。

## 前批 Plan 1.51 驗收

- 新測試覆盖 v1/v2、scope/readers/root/群組上限、無自動掃描、2,048項／50列分頁、
  舊 snapshot、stale保留/空清單、動態revision/tuple/撤銷/晚回覆、共同2flight、
  group/credential撤銷、dedicated relay、private-field拒絕與 unknown cleanup。
- Actual `server.js` 使用新v2合成設定，真正 Rust inventory→新HTTP分頁→dynamic
  register→固定 SDK內容讀取；metadata變更／移除／恢復、舊binding與續頁拒絕已驗。
  最低Node22.19.0，`actualSourceGroupsGate=passed`；無私人history、模型、正式變動。
- 本機最終705 tests＝703 pass／2平台skip／0 fail；聚焦69/69，strictTS產物／syntax／
  version／1,251-case Ajv通過。最低Node22.19真pipeline重跑通過，ownedcleanup確認。
  完整TAP保存；先前678項單次未定位失敗本輪未重現，不宣稱已修復其根因。
- 本批 exact CI 結果逐批記錄，不沿用1.50的綠燈。Rust本身未修改；
  Windows只跑公開contract／Host替身，不宣稱 POSIX native gate 在 Windows 成功。

### Plan 1.51 exact commit 證據（前批，不代替1.52驗收）

程式 **`ad7e53454af9ae245be3ac1d0bc1253c42feacdd`** 四組CI均成功，logs已核實：

| Gate | 結果與邊界 |
| --- | --- |
| [一般CI34217624560](https://github.com/seehow624/stepsemble/actions/runs/34217624560) | 每OS705tests／0fail；Mac703pass2skip、Linux702pass3skip、Windows673pass32skip；每OS Ajv1251 |
| [Native reader＋audit34217624556](https://github.com/seehow624/stepsemble/actions/runs/34217624556) | Rust Mac17／Linux17／Windows8，Node每OS67/67；Mac/Linux新`actualSourceGroupsGate=passed`及既有actualHost/shared gate通過，physical2/0/51；locked RustSec audit成功 |
| [Native Claude34217624589](https://github.com/seehow624/stepsemble/actions/runs/34217624589) | 固定SDK0.3.259三OS合成契約passed／modelCalls0／nativeFileUnchanged=true |
| [Browser rolling34217624540](https://github.com/seehow624/stepsemble/actions/runs/34217624540) | Mac/Linux各18cases全passed／pageErrors0，仍是既有介面回歸，非新來源UI或真機驗收 |

Windows compiled source pipeline仍明示unsupported，沒有在該平台實跑新native
source-group gate；Node Host/HTTP替身與跨平台SDK契約不能取代Windows reader。
後續純文件commit與上述程式證據分開。

### Plan 1.52 驗收

最低Node22.19新pipeline經compiled TS→actual server.js→Rust→固定SDK，
`actualMetadataGate=passed`；四份合成來源的原生title、未命名summary、改名後的
indexedidentity和snapshot拒絕、先前page與內容鏈均通過，model/privatehistory0、
owned fixture/child清理確認。新增選擇、scope/pin/wire、worker/service/registry、
HTTP/relay/權限/70讀slot重用與TS validators對照/取消/decoded-cap回歸。
本機最終730tests＝728pass／2平台skip／0fail；native聚焦90/90、HTTP/TS聚焦57/57，
strict TS/generated／syntax／版本一致性／actionlint及1,251-case Ajv通過。
舊未定位單次flaky仍未根因結案，這次未重現不能當作已修復。

程式 **`850e01294991c4a81173a69438081ebe4d73731e`** 四組CI均成功，logs已核實：

| Gate | 結果與邊界 |
| --- | --- |
| [一般CI34220571677](https://github.com/seehow624/stepsemble/actions/runs/34220571677) | 三OS各730tests／0fail；Mac728pass2skip、Linux727pass3skip、Windows698pass32skip；各Ajv1251 |
| [Native reader＋audit34220571738](https://github.com/seehow624/stepsemble/actions/runs/34220571738) | Rust Mac17／Linux17／Windows8，Node各77/77；Mac/Linux新`actualMetadataGate=passed`及既有actualHost/sourceGroup/shared gate通，Windows原生Host仍unsupported；locked RustSec 0已知漏洞/0warnings |
| [Native Claude34220571704](https://github.com/seehow624/stepsemble/actions/runs/34220571704) | SDK0.3.259三OS合成契約passed／modelCalls0／nativeFileUnchanged=true |
| [Browser rolling34220571699](https://github.com/seehow624/stepsemble/actions/runs/34220571699) | Mac/Linux各18cases全passed／pageErrors0；既有介面回歸，不是新source-group UI或實機驗收 |

後續純文件commit與這份程式證據分開，不宣稱新native UI已上線。

下一步是 Web 來源选择／重新整理／分頁與按需名稱介面及browser驗收，再進真人來源確認。其餘harness、resume、approval、
durable journal、真機/性能、Windows reader與發布關卡仍依主計畫待完成。
固定ab227af的72h長測不包含本批runtime，保持獨立。
