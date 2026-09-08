# Codex：名稱索引解讀與原生 API 差異

2026-09-09／Plan1.60，開發候選仍3.0.7-rc.7、未部署。

## 本批交付與不能宣稱的事

`protocol/native/codex/name-index.js` 解讀 caller 提供的固定版本索引 bytes，或接
Plan1.59 成組 capture 的索引 descriptor／SHA／sourceVersion。沒有filesystem、
HOME探索、native啟動或新的HTTP權限。真Rust capture→索引解析已在owned fixture接通。

結果只叫 `codex_name_index_observation`／`legacy_session_index_only`，分開保存
`latestEntry`、`readCandidate`、`listCandidate`；`nativeTitleResolved:false`、
`sourceAuthenticated:false`、`publishable:false`。**這不是所有Codex對話的最終原生名稱**。
它不解析rollout內容，不以名稱相同去重，不用檔名、UUID或第一句訊息取代自訂名稱。
綁定的sourceVersion不代替Host授權、選定rollout內容驗證或發布時stale檢查。

## 已核對的名稱規則

[官方App Server文件](https://learn.chatgpt.com/docs/app-server) 將`thread.name`與
`thread/read`／list區分，read不等於resume。固定`rust-v0.153.4` source commit
`3d2ee51ca2d5db578f328aa75e20aa22c0197c9a`的`rollout/src/session_index.rs`及
`thread-store/src/local/{read_thread,helpers}.rs`另顯示：

- 單筆索引查詢讀最後一筆有效且ID匹配的紀錄，**不是依updated_at排序**；時間欄位
  原生只要求字串。若最後名稱是空白，單筆候選為null，不倒退拿舊非空名稱。
- 批次索引查詢忽略空白名稱，保留最後一筆非空且經Rust Unicode White_Space trim
  的名稱。所以空白更新可能使單筆無名、列表仍有舊名，兩者不能偷偷合併。
- 保留單筆原始名稱空白；Unicode NEL與BOM不能直接用JavaScript trim混為一談。
  合法UUID simple/braced/URN/大小寫、serde sequence entry、unknown欄位均納入驗證。
  重複known欄位（含escaped key）依serde拒絕，不能用JSON.parse的last-key-wins改名。
- SQLite中與預覽不同的legacy title可以優先於索引；paginated名稱來自不同store。
  **本批沒有capture/查詢SQLite，也沒有驗完該優先順序**，不可把index當唯一權威。

17組真0.153.4 owned fixtures另外觀測：當index name恰等於第一則訊息預覽，
本批單筆read（list前及之後）仍回該名稱，list回null。只看其中一段Rust的
「預覽相同則不設定」helper不足以推論整個API；read的SQLite metadata與rollout
合併可保留名稱。本模組不擅自套用全域預覽抑制，native測試分方法核對。

## 邊界

8MiB input／65536 records／128KiB record／32KiB selected name／128KiB encoded
output；超限回unavailable，不截斷或退回舊名稱。完整但沒有末尾LF的record可解析；
無效JSON/required field/native ID依索引規則忽略且有rejected計數，invalid UTF8／
過深或無法安全解讀的結構則整組unavailable。此計數不代表完整歷史無損。
缺index、空index、無此ID不同；只回選定ID的名稱，不回其他對話名稱或全index。
input透過intrinsic byte getters複製，拒shared memory，回傳不依賴caller後續改bytes。
此同步parser仍有固定工作上限，**尚未接Host worker/admission，不宣稱主執行緒效能驗收**。
另在Mini/Node22.22.3用8,387,188bytes／7,598records的owned index做三輪單程序探測，
解析84.55／78.66／74.93ms（`/tmp/stepsemble-codex-names-synchronous-baseline.jsonl`）。
這不是before/after、Host或Web基準；此量級不應接到請求主執行緒批量重複解析，
後續需納入worker、shared admission與有界版本快取後另測。

## 驗證紀錄

- 7個新Node tests；本機完整823＝821pass/2skip/0fail，最低Node22.19聚焦26/26。
  數據／版號／getter／shared memory、duplicates／UUID／Unicode／錯行／tail／
  bytes/record/name/output/depth limits、source SHA與detached version皆驗。
- 真Rust→索引解析仍9次owned capture；缺空index分開、改caller bytes後原觀測保留、
  新解析拒變更bytes。Rust沒有修改，沿用Plan1.59 exact本機debug artifact，不新稱Rust測試。
- `check-native-codex-names.mjs` 最低Node22.19與22.22固定CLI各17cases通；另22.22
  連續5輪通。每輪單筆read前後各17、list分頁，19原檔bytes不變、loaded/model/private0、
  cleanup確認。native index最後一筆是合法無LF；malformed tail只有unit直接覆蓋，
  native fixture中的malformed row在中間。沒有SQLite title override或paginated驗收。
- 新native runner的前兩次失敗是把preview同名誤當一律null、再誤猜cold preview空。
  固定source與實際API確認read/list差異後改成分方法精確斷言；不是刪掉case或更改
  原生資料讓測試過。失敗logs `...-native-first.log`／`...-native-second.log`保留。
- strict TS/generated/syntax/version/Ajv1251/actionlint通。

本機logs `/tmp/stepsemble-codex-names-{full-final.tap,minnode-final.tap,unit-bounds.tap,
minnode-native-final.log,native-repeat.jsonl,reader-final.log,checks.log}`。

### Exact CI

程式`f884843222e3d39c72891c4d07b2f15f7c7ca334`已push：

- 一般[34250969945](https://github.com/seehow624/stepsemble/actions/runs/34250969945)
  三OS823/0fail、各Ajv1251；Mac821pass/2skip、Linux820/3、Windows776/47。
- 固定原生[34250969947](https://github.com/seehow624/stepsemble/actions/runs/34250969947)
  三OS最低Node22.19各17新name cases、read/list前後分別驗、19原檔不變、model/private/loaded0、
  actualcleanup通。旧raw113頁/219records/3transient/byteexact與native缺項gate亦保持。
  全部首次attempt成功，完整logs核實；不是SQLite覆寫、paginated或Windows Rust來源驗收。
- reader [34250970005](https://github.com/seehow624/stepsemble/actions/runs/34250970005)
  完整workflow成功且logs核實：Rust Mac25/Linux25/Windows10，Node各92/92；
  POSIX實際9次capture→name解析＋raw頁、原ClaudeactualHost/sourceGroups/metadata/setup/
  shared gates仍通，Windows實際binary維持unsupported，沒有宣稱name解析來源能力通過。
  RustSec DB`bf25f6575a93a35f30796c65c0ed91bee7fa19fd`、1242advisories、
  lock`6583452ddbf9af1e6cce6623144f94660c4108c6877efa02e1e58b90d28f2e25`、
  33packages／0known vulnerabilities／0warnings。

完整logs `/tmp/stepsemble-codex-names-{general-ci,native-ci,reader-ci}.log`。
本批沒有Host/Web或Claude reader程式變動，不新增rolling/nativeClaude workflow；
Plan1.59相應證據不冒稱本SHA有新UI／實機驗收。

下一步：完整名稱來源（SQLite/WAL一致性／固定版本與權限）及owned優先順序驗證、
Codex opt-in／精確locator inventory、壓縮與referenced history、同Host資源限额下
capture→解析→釋放、registry／HTTP／Web及跨頁stale；不能把本批候選名稱直接公開。
C1–C8整體未完成；B+、私人來源/readers、正式3.0.6、帳號route與獨立72h全不動。
