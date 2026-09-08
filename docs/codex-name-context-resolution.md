# Codex 名稱：同交易脈絡與方法別解讀

2026-09-09／Plan1.67，開發仍3.0.7-rc.7，未部署。
接續 [Node SQLite 接線](codex-sqlite-node-pipeline.md)，不是全 Web 完成宣告。

## 實質增量

原先五個 SQL 欄位不足以組合最終名稱：SQLite 指向哪個 rollout，以及原生列表的
preview，都會影響判斷。固定原生版本0.153.4／source
`3d2ee51ca2d5db578f328aa75e20aa22c0197c9a` 的 read、list、row mapper 已核對。
依 OpenAI Docs 先確認 [thread/read 的非續跑用途](https://learn.chatgpt.com/docs/app-server)，
再讀固定版本原始碼與 owned oracle；沒有為查名稱啟動對話、登入或模型請求。

- 新 Rust v5，在**同一短唯讀交易**取得既有五欄與 `rollout_path`／`preview`；
  兩次 SELECT 共享 snapshot。v4 shape、五欄 authorizer、上限與 API 保持相容。
  v5 authorizer 只多允許兩欄，沒有任意 SQL、cwd、寫入或跟隨欄位內路徑的能力。
- 新 `nameContext`：present row 為 `{rolloutPath, preview}`，缺 row 才是 null。
  **SQL preview 是 NOT NULL 字串**，不是 nullable 欄位；raw 空字串原樣保存，
  原生 row mapper 在解讀時才將恰好空字串變成 None。空白字串及 BOM 不等於空值。
- 路徑≤8192bytes、preview≤32KiB、v5 observation≤192KiB、packet payload≤208KiB；
  舊 v4 的128／144KiB不變。原250ms／20kVM、source I/O／SHM／FD安全限額不變。
- Node v5 wire／helper／`createCodexNameContextPipeline` 共用 v1–v4 的 single-flight、
  Host兩名額、期限與真正close。v5版本包含原五欄與兩個 raw context 欄位的摘要；
  只改 preview／rollout path 也會失效，不受 unrelated table commit／I/O計數干擾。
- 純 `observeSqliteNameResolution` 組合 provided SQL context、index bytes、選定
  rollout ID／path／mode，分 `thread_read_sqlite` 與 `thread_list_state_row`。
  legacy distinct SQL title 優先，其次 read 用 raw最後索引、list用batch非空trim索引；
  list legacy 名稱等於preview時隱藏，paginated只用SQL name、不做該隱藏。
  缺SQL row、path／ID／mode不一致明示不可用，不猜測移動後路徑或偷偷fallback。

這個純 resolver **不決定列表成員**。一般原生列表排除 SQL preview恰好空字串；
section／relation filters可能納入。也不提供跨SQLite／rollout／index原子快照、
來源授權或final title證明。所有sourceAuthenticated／publishable／nativeTitleResolved
仍false。未接HTTP/Web，不能把raw metadata path送到browser。

## 本機驗證

- Node完整897項：895pass／0fail／2skip；reader focused162/162。
- v4、v5共跑原18個frame／version／cancel／actualclose／quarantine／admission測試；
  另3個context與5個方法別resolver tests。涵蓋preview/path變版、缺row、嚴格欄位、
  payload上限、raw Unicode、getter、模式不符，舊版不擴權。
- Rust lib21／main28，包含v5精確frame／不同上限，交易中另一writer commit仍見舊
  snapshot。POSIX跨程序source案例增加實際v5及錯root，合計103child全部reaped／
  61ownedDirs清除；未讀私人資料。
- 實際 Node→Rust v4/v5 同時與 Claude SDK／Codex parser共用最多2 reader；
  24reader launches含peers、1獨立owned pinned writer，remaining0／全部close。
  16成功SQLcapture都有真SHM mapping，最高requestedReadBytes12388；preview/path
  變版、無關commit不變、舊v4不變、錯root、兩版實際取消及原三檔bytes不变均驗。
  固定test-only writer只接受預定fixture操作，沒有自訂路徑／SQL或正式write mode。
- 真固定native oracle擴至19個read名稱、18個一般列表名稱、15legacy帶history讀取、
  4paginated metadata案例。read前後、stateOnly及scan list、21owned原檔、五欄與
  preview/path不變均驗；2native processes清理、loaded0、model endpoint requests0。
  空preview案例由native list排除，不拿「缺列」當作name=null通過。

上述不是native writer壓測、RSS/Core Vitals、私人session或新HostWeb接線。
Windows仍應在Node spawn前unsupported，Rust實際v5亦必須明示unsupported，
不能把Windows SQL library／純parser測試通過當成source支援。

本機logs：`/tmp/stepsemble-name-context-{npm,reader-unit,resolver}.tap`、
`...-rust-final-2.log`、`...-clippy-final.log`、`...-actual-second.log`、
`...-native-oracle-second.log`、`...-{check,client,protocol,ajv}.log`。
fmt／clippy warnings-as-errors／client／protocol／Ajv1251／actionlint／diff-check另驗。
跨平台CI以本批exact工程SHA核對後補錄，未把本機結果外推到Linux／Windows。

## 保留的失敗與修正

1. Rust authorizer closure lifetime推斷不足：明示AuthContext lifetime，未變權限範圍。
2. 新測試誤認SQL preview預設null；實測為空字串，且寫null被NOT NULL拒绝。
   讀固定row mapper核實後，正式v5改成必須raw字串；只有缺row的context為null。
3. CommonJS arrow-value exports未被ESM辨識為named export；改具名wrapper並重跑
   真實Node/Rust/SDK鏈，不只靠require unit test。
4. 新native oracle原預期19列，實際18列；固定SQLfilter確認空preview排除規則，
   現驗**精確ID集合**及19read／18list，不減少fixture或放寬成任意列數。

初始logs `...-rust-first.log`、`...-rust-all.log`、`...-rust-all-fixed.log`、
`...-actual.log`、`...-native-oracle.log`保留；未skip失敗、降低原限額或靜默重試模型。

## 下一個可驗收交付

把上述resolver接入同一admission下的有界background pipeline：先捕捉v5，再捕捉
已選rollout/index並驗first session_meta，最後重驗v5選定版本；每阶段取消／實際close
／撤銷／版本變動禁止發布。此為明示一致性檢查，不宣稱跨source原子snapshot。
不得外層取得名額後再呼叫會重複acquire的inner pipelines，也不得另開無界budget。
metadata/read/list的mode、preview來源與缺row／缺檔分支需各自證據。

再接Codex discovery／明確root及reader grants／動態registry／HTTP／Web，補cold DB、
compressed／paginated references及其他harness；C1–C8與正式發布gate仍全部保留。
正式3.0.6、B+ logo、私人來源／帳號路由及獨立72h凍結SHA不變；本輪未查／改soak。
