# Codex SQLite：Node 接線與共用讀取名額

2026-09-09／Plan1.66，開發仍3.0.7-rc.7，未部署。接續
[FD 綁定來源](codex-sqlite-source-bound.md)；本頁不是完整原生歷史或正式上線宣告。

## 已實作

- `sqlite-wire.js` 嚴格接收 v4：nonce／固定 native 版本／獨立 SQLite root／thread ID／
  root identity／長度與 SHA256；固定 engine、欄位、三檔身分、FD 關閉和 I/O 限額。
  header≤16KiB、payload≤144KiB，UTF-8／BOM／尾隨資料／未知欄位／authority claims
  拒絕；控制用 DTO 脫離 caller 參照，不呼叫 getter／toJSON。
- 共用 `createNativeHelper.readCodexMetadata()`，v1–v4 同一個 single-flight／期限／
  stdout／stderr 限額與實際 child close 門檻。stdout 或 exit 事件都不能先發布。
  SQLite unavailable／unsupported／busy／cancelled 僅保留固定錯誤碼，不傳原始診斷。
- `createCodexMetadataPipeline()` 必須取得真正的 caller-owned reader admission。
  全 Host 名額仍為兩個，無排隊、重試或隱藏的新 budget；兩個 helper 物件固定重用。
  取消／關閉／逾時殺掉自己的讀取程序，實際 close 才能釋放。清理不明永久隔離整個
  共用 admission，晚到 close 可清除占用，但不能解除隔離或恢復發布權。
- 子程序關閉後，才以既有純函式解讀 bounded SQLite 欄位。保留 legacy／paginated／
  missing row 的區別和原文，沒有把候選名稱當成最終 native title。
- 選定欄位版本包含固定 native 版本、thread ID、root 與三檔 device/inode，以及原始
  selected fields 的 canonical JSON SHA256。它不是全 DB 版本，也不是檔案 mtime。
  非選定欄位的 commit／讀取計數差異不造成誤失效；選定欄位或檔案替換則失效。
  這不提供跨 SQLite／rollout／index 原子 snapshot；後續 resolver 必須處理組合證據。

`sourceAuthenticated`、`publishable`、`nativeTitleResolved` 持續為 false。Host-managed
executable 是 caller 信任前提，不將 SHA 或精確 DTO 冒稱原生來源簽章／授權。
沒有加入私人 root 探索、credential grant、registry、HTTP 或 Web 管理入口。

## 測試方式與目前證據

新增18個 Node unit tests：frame／payload／root／version／identity／limit／getter；
actual-close／late success／abort／timeout／共享隔離／shutdown；選定欄位版本與名稱候選。
本機完整 Node871，869pass／0fail／2skip；Rust lib16/main27、原跨程序測試皆通，
clippy warnings-as-errors、fmt、actionlint、diff-check 通過。

另新增 **test-only** `owned_sqlite_writer` example，與 reader 共用 locked SQLite3.53.4。
只建立自己的 temporary directory，沒有 path／SQL 輸入，stdin 只允許固定測試操作；
沒有為正式 reader 增加任何 write mode。關閉時先真正 close connection，再 explicit
刪除自己的目錄並核實不存在；parent 必須等實際 child close。

實際 Node→Rust v4→名稱解讀，與真 pinned Claude SDK／Codex bytes parser 共用 admission：
Mac讀取上限2、剩餘0，第三個讀取在 spawn 前 busy；13次讀取 child launch（含 peers），
一個獨立 pinned writer peer 全部清理。驗最新 WAL、legacy／paginated／missing、
unrelated write 版本不變／rename 版本失效、錯 root、真 capture cancellation。
DB/WAL/SHM 的檔名集合、完整 size/SHA256 在讀取／拒絕／取消前後一致。
比對在 Node process，**不是 writer process**，避免同 inode FD close 解除 POSIX 鎖。
成功 capture 要求實際 SHM 映射，不能用 orphan-WAL heap index 冒充活動 writer。

這些是 owned fixture／實際 pinned SDK 與 subprocess 證據，不是真 native Codex writer
壓測、真人對話、Web Core Vitals、Host RSS 或最終使用體驗驗收。Windows Node 在 spawn
前拒絕；Rust v4 真 binary 的 unsupported 仍由原跨平台來源 gate 驗證。

本機完整記錄：`/tmp/stepsemble-sqlite-node-unit.tap`、`...-npm.tap`、`...-build.log`、
`...-clippy.log`、`...-rust.log`、`...-actual-final.log`。另本機完整 actual pipeline 三輪
`...-repeat-1.log` 至3均通：每輪13 reader launches／1 writer，全實際清理；7成功
capture 都有 SHM 映射、最高 requestedReadBytes12388。不是負載或 RSS benchmark。

## Exact commit 跨平台驗證

工程 **7bdbfe362c7c0235293cbc8fb9cbf49284d94ddf** 五組 CI 全部 success，完整 logs 已核：

- [一般34279232220](https://github.com/seehow624/stepsemble/actions/runs/34279232220)：
  三OS各871/0fail及Ajv1251；Mac869pass/2skip、Linux868/3、Windows824/47。
- [Reader34279232507](https://github.com/seehow624/stepsemble/actions/runs/34279232507)：
  三OS Node136/136，Rust lib16/main27/27/12；POSIX原100child/61dirs清理。
  **新v4 Node鏈**在Mac/Linux Node22.19實際通：max2/remaining0、13reader launches、
  writer真reaped/1ownedDir清除、7capture真SHM、最高requestedReadBytes12388。
  Windows Node零spawn、Rust真v4 unsupported，舊41child/10dirs仍通；不能算來源支援。
  SQLite artifact/pin/43-package lock不變，RustSec0.22.2、DB
  `bf25f6575a93a35f30796c65c0ed91bee7fa19fd`、0known/0warnings；舊Host/groups/setup/
  metadata/shared admission亦通，這些Host證據不是新CodexHTTPWeb接入。
- [Rolling34279232221](https://github.com/seehow624/stepsemble/actions/runs/34279232221)：
  Mac/Linux各24cases、pageErrors0；每OS六原生來源案例×11語、localeReads0。
- [原生Codex34279232248](https://github.com/seehow624/stepsemble/actions/runs/34279232248)：
  三OS原有fixed0.153.4 owned CLI history／17index／13SQLite precedence cases通，
  0model endpoint requests、cleanup confirmed；paginated完整歷史仍明示不支援。
  這是原生相容性控制組，不是新Node v4已接入原生CLI或私人帳號。
- [Claude34279232377](https://github.com/seehow624/stepsemble/actions/runs/34279232377)：
  三OS pinned SDK0.3.259／nativeVersion2.1.259契約通、0model calls；保留Windows
  私人來源unsupported邊界，不因SDK fixture通過就提升來源能力。

Logs `/tmp/stepsemble-sqlite-node-{general,reader,rolling,native-codex,native-claude}-ci.log`。
本批實作／回歸／相容性證據完成，整體 Web goal 持續。

## 接續與未完成

接續 Codex 最終名稱 resolver 的 SQLite／index／rollout 證據組合，然後來源 inventory／
reader grants／動態 registry／HTTP／Web；需要各自正反與 actual Host 驗證。
cold DB／compressed／paginated history references／其他 adapters 和 C1–C8 仍未完成。
正式3.0.6、既有 B+ logo、私人來源／帳號與獨立72h不變；不借用凍結長測驗收新 runtime。
