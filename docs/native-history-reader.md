# ADR：獨立原生 history source reader 的窄邊界

Plan1.49新增獨立private protocolVersion2的explicit-root metadata inventory與
Host-private增量索引，沿用本文件的fd/ACL/mount/actual-close防線。
下方「不掃描」描述原v1單檔capture；v2只在Host明確授權root後執行有界目錄雙掃，
仍不探索HOME／讀私人history，未接Host/Web。詳見[native-history-discovery.md](native-history-discovery.md)。

日期：2026-09-08。狀態：Rust reader／bytes-only SDK composite 已實作，core
`d3e2fe1` 的四組跨平台 CI 已通過。Windows 仍 unsupported，不代表 production gate 已完成。

## 決策與非目標

以小型 Rust helper 補上 Node 公開 API 缺少的 descriptor-relative 開檔與
fd-based ACL 檢查。這是單次、唯讀、指定 source 的 reader，不是 Rust Host
大遷移；僅經新 composite service 驗證合成全鏈，不接正式 Web，不部署、不改固定來源 72h 長測。
Rust helper 本身不 discovery HOME、不掃描私人 history、不載入 SDK、不啟動 native CLI、模型、
登入或網路功能，不執行 JSONL 裡的指令，不建立 journal／approval／resume 證據。

所有成功結果仍為 `sourceAuthenticated:false`、`publishable:false`。POSIX gate
只描述本次已觀測的 filesystem 屬性，不證明資料由 Claude 或特定使用者產生。
Windows helper CLI 本階段明確 unsupported；獨立 Windows permission probe 的
實際測試不能代替 Windows source reader、reparse-point 或完整 ACL gate。

背景：[platform plan](platform-plan.md)、[history access design](history-access-design.md)。

## 信任與 authority

trusted Host 負責 canonicalize、選擇及授權 root／project／session，並提供授權
當時的 root identity。Helper input 是 private trusted-caller contract，不是 browser
API；Client 不得傳 native path、expectedRoot、SDK path、UID 或任意 flags。

`expectedRoot` 強制核對實際開啟的 root fd 的 device/inode，可拒絕不同 inode 的
root pathname 替換，但 identity **本身不授權**。攻擊者若能自報 expectedRoot，
便能自報另一個 root；因此它不能取代 Host catalog／principal 授權。

canonical absolute pathname 不是 directory capability：從 Host 授權到 helper
首次 open 之間，ancestor 或 mount namespace 仍可能變動。本版不聲稱完成完整
ancestor trust audit。Host 須信任這段 acquisition 的 ancestors／mount namespace；
未來可傳遞已授權 directory fd 進一步縮小此缺口，但本 wire contract 尚未實作。
核對 inode 不凍結 root 的位置／內容，也不是永久的 inode provenance。

## 固定 private wire contract

一次程序只處理一次工作。stdin 是有界 UTF-8 JSON；上限 12KiB，exact keys，
拒絕 trailing 非空資料、未知欄位、錯誤型別、malformed UTF-8、無效數值／路徑。
不從 environment 補 root、nonce 或 expectedRoot。呼叫端必須關閉 stdin。

```text
{
  protocolVersion: 1,
  nonce: <64 lowercase ASCII hex characters>,
  source: { projectsRoot, projectKey, sessionId },
  expectedRoot: { device, inode }
}
```

- `projectsRoot`：Host 已 canonicalize 的 absolute root，不接受 filesystem root
  作廣泛 grant；不接受 NUL 或以 dot components／重複 separator 冒充 canonical。
- `projectKey`：`[A-Za-z0-9_-]{1,255}`，只能是一個 component。
- `sessionId`：UUID；實際 basename 固定為 `sessionId + ".jsonl"`。
- `expectedRoot.device`／`inode`：canonical unsigned decimal 字串，各 1–20 digits，
  除單一 `0` 外不接受前導零；inode 必須大於 0，必須能無損解析為 u64，overflow 拒絕。
- nonce 僅做 request correlation，不是 source authority 或 authentication。

stdout 是 **4-byte unsigned big-endian headerLength + JSON header + raw bytes**。
headerLength 不超過 16KiB，raw bytes 不超過 8MiB；不得換成 newline framing，
不得把 raw bytes 放進 JSON／base64。Header exact envelope：

```text
{
  protocolVersion: 1,
  nonce,
  result: {
    kind: "native_source_bytes",
    sessionId, byteLength, sha256,
    identity: { device, inode, size, mtimeNs, ctimeNs },
    checks: {
      owner: "posix_euid_and_mode",
      acl: "no_extended_acl",
      containment: "root_identity_and_openat_nofollow",
      reads: 2,
      matchingBytes: true,
      unchangedObservedIdentity: true
    },
    sourceAuthenticated: false,
    publishable: false
  }
}
```

identity 的 device/inode 與 ns timestamps 用 unsigned 十進位字串；本版明確拒絕
pre-epoch／invalid ns timestamps（`source_identity_unavailable`），不讓 Rust 成功
後才被 Node 當成 protocol error。size 與 byteLength
為有界整數且相等；sha256 綁定原始 bytes。成功 raw length 必須恰等於 byteLength，
header 後少／多 bytes、額外 frame、nonce 不符、未知 shape 或 authority true 均拒絕。
失敗 result 為 sanitized `{kind:"source_unavailable",code}`，不帶 raw bytes；
尚未取得有效 nonce 的無效 input 可直接非零退出，不偽造成功 header。
stderr／error code 不包含 root、原文、憑證、任意 OS error 或 diagnostic dump。

Helper 只交付 bytes；JSONL UTF-8／逐行大小／record count／session scope／SDK
格式等仍由後續明確的 parser contract 驗證。讀取成功不代表 transcript 可發布。

## POSIX open 與權限流程

1. 從 `/` 開始，對 canonical root 的每個 component 逐層 no-follow 開啟，最多
   256 層；不接受 dot／重複 separator／trailing slash。最終 root 立即 fstat，檢查 directory、effective UID、
   禁止 group/other write，並比對 mandatory expectedRoot。任何失敗不開 project。
2. 以 root fd 為 anchor，用 `openat` 開單一 projectKey；再以 project fd 開單一
   session basename。每層使用 `O_NOFOLLOW`；directory 另有 `O_DIRECTORY`，
   fd 設 `O_CLOEXEC`，file 以 `O_NONBLOCK` 避免 FIFO open 等待。
3. 所有 authority 檢查都針對已開 fd，不使用 pathname ACL query、`/proc/self/fd`
   拼接或檢查後重新 absolute-path open。File 必須 regular、owner 符合、無
   group/other write、single link，且 `0 < size <= 8MiB`。
4. 由 fd 的 `fstatfs` 取得 filesystem type。本階段 macOS 只接受 local APFS／HFS
   且不得設定 `MNT_IGNORE_OWNERSHIP`（`noowners`）；該模式會把 apparent owner
   解釋為 current euid，不能靠 UID/mode 視作隔離。讀取器回
   `source_containment_unavailable`，不修改掛載或修權限。
   Linux 只接受 ext4／XFS／Btrfs／tmpfs；root/project/file device 必須相同。
   未知 filesystem、NFS／SMB／FUSE 或查詢失敗 unavailable；不可降級成 mode-only。
   Linux ext 家族共用 filesystem magic，不能只憑該值宣稱辨認了特定 ext 版本。
5. Linux 對固定 access/default POSIX ACL xattrs 做 fd-based 查詢；只有明確
   `ENODATA` 接受，存在任何 ACL xattr 或其他 error 均拒絕。macOS 先要求
   `fpathconf(fd, _PC_EXTENDED_SECURITY_NP)==1`，再以 `filesec_init` 建立
   security object，要求 `fstatx_np` 與 `filesec_query_property(FILESEC_ACL)`
   都成功。僅 property validity 為 0 才接受 absence；正值是 present bitmask
   而非必然等於 1，全部拒絕（包括純 deny／存在但零 entry 的 ACL）。負值或
   API error 拒絕；每路徑釋放 filesec object。`acl_get_fd_np` 的 NULL 可能
   同時代表 error 或 absence，因此不以 NULL／ENOENT／EINVAL 直接放行。
   這是嚴格且可能拒絕正常目錄的 policy，helper 不移除／修復 ACL。
6. 同一 file fd 做兩趟有界 `pread`，每趟按最初 size 讀到完整 bytes，再做一個
   byte 的 EOF probe，拒絕 short read／growth。比較兩趟完整 bytes；前／中／後
   比較 dev/ino/uid/mode/nlink/size/ns mtime/ctime，讀前後重驗 root/project/file
   的 fd metadata／ACL。所有比較是 observed checks，不宣稱原子 snapshot。

根據實際 filesystem errno/type 能力決定 unavailable，不為了讓 fixture 綠燈而
放寬 production policy。Filesystem type allowlist 也不是惡意 kernel／mount
administrator 的安全邊界。

## 真實保證與已知限制

| 議題 | 本版保證 | 保留限制 |
| --- | --- | --- |
| Root identity | 實際開啟 fd 與 Host 授權 identity 相符 | 不完成 ancestor audit，不認證來源，也不凍結 namespace |
| Symlink | 單 component openat 的 no-follow | absolute root acquisition 的 ancestors 仍有信任前提 |
| Rename | 已開 fd 仍指原物件，不被同名替換重新導向 | 目錄可能被移出 root；不保證持續 subtree membership |
| Mount | 拒絕不同 dev／不支援的已觀測 filesystem | 相同 dev 不排除 bind mount；不凍結 mount namespace |
| Hardlink | 檢查時 nlink 為 1 | 不證明過去無其他 link，也不排除既有 writable fd |
| ACL | 檢查時沒有 policy 禁止的 ACL | 查詢與 read 非原子；不能撤銷他人已開 writable fd |
| 雙讀 | 兩次 bytes 相同且 metadata 未觀測 drift | 不是 transaction snapshot／未曾改寫的證據 |
| 同 UID | 不提供跨同 UID 程序隔離 | 同 UID 程序可在 capture 前寫入合法偽造內容 |
| 時間限制 | parent 可撤銷結果並終止 owned child | 一般檔案 IO 可能阻塞；timeout/SIGKILL 不等於已退出 |

若未來 Linux 使用 `openat2(RESOLVE_BENEATH|RESOLVE_NO_SYMLINKS|RESOLVE_NO_XDEV)`，
須另驗 kernel／filesystem 能力；不能 fallback 後仍宣稱相同保證。它可約束該次
lookup（含 bind mount），仍不是整個 capture 期間的 namespace lock。

## Rust 與 Node 邊界

Crate：`crates/history-source-reader/Cargo.toml`。Toolchain 固定 1.97.1；依賴
固定 libc 0.2.186、serde 1.0.228、serde_json 1.0.150、sha2 0.10.9，Windows
target dependency windows-sys 0.61.2；提交 lockfile，CI 以 `--locked` 執行。

依賴安全另由同一 workflow 的獨立 Linux `dependency-audit` job 驗證，不在三 OS
矩陣重複編譯工具。固定 `cargo-audit 0.22.2` 並以 `cargo install --locked` 安裝；
tool root、build target、官方 RustSec DB 都在 `runner.temp`，不修改全域 PATH。
`scripts/check-native-history-dependencies.mjs` 接受工具／DB／temporary root 三個
絕對路徑，建立自有隔離 audit config 和 process-local Cargo home，明確
`ignore=[]`、沒有平台或 severity 篩選、拒絕所有 warnings、啟用並更新 yanked
檢查；工具失敗或 stderr diagnostics 不得當作零漏洞通過。它輸出工具版本／
hash、官方 DB exact commit、advisory 數量與 lockfile 前後一致 SHA256，並在
自有 temporary directory 保留原始 JSON 與 evidence。不自動更新任何依賴。

2026-09-08 本機使用上述固定工具，官方 DB
`8a1eb4f933fb5821add5b4e98601ebd90b8b3538`（1,242 advisories），對 lockfile
SHA256 `6583452ddbf9af1e6cce6623144f94660c4108c6877efa02e1e58b90d28f2e25`
完成稽核：33 packages 含專案自身、32 個外部依賴，0 已知漏洞、0 warnings、exit 0。
這只是當次 DB／lockfile 的已知 advisory 檢查，不是 supply-chain 完整保證、來源
provenance、Windows reader 支援或整體計畫完成；未來 advisories 仍可能令 CI 失敗。

檔案／fd 由 Rust `File`／RAII 擁有；raw fd 只借用於局部 libc interoperability。
每段 unsafe 都記錄：fd 生命週期、buffer 長度／alignment、C 字串無 NUL、初始化與
返回值檢查、ACL allocation 的唯一釋放。不雙重接管 raw fd、不重試關閉可能已被
重用的 fd number，不把 unchecked errno／size 轉換帶進安全邏輯。

Node runner 是測試／實驗 adapter，由新 composite service 組合使用，不替換既有正式服務。它限制 stdin、
header、raw frame／stderr 和 pending work；完整驗形／hash／nonce 後仍等 owned
child actual close，再檢查 revoke／timeout 才能成功。abort、malformed frame、
非零退出或 cleanup unknown 不得發布 partial 或 late bytes；未知 close 保留占用。

Helper executable 的 pre-exec hash 驗證只證明「檢查時 pathname bytes」；從 hash
到 spawn 仍有替換競爭，不能稱為 exact executed-bytes pinning。Caller 須信任
build/output directory 及 launch environment；不讀 HOME／credential／loader 注入。
本版不是 OS sandbox、網路 sandbox 或對惡意 helper executable 的隔離。

平台附註：Node spawn 的顯式 env 是固定欄位，不代表 child environment 只有
那幾個欄位。macOS 可注入 `__CF_USER_TEXT_ENCODING`；Node 22.19 libuv 在 Windows
會補入 HOMEDRIVE/HOMEPATH/LOGONSERVER/PATH/SYSTEMDRIVE/SYSTEMROOT/TEMP/
USERDOMAIN/USERNAME/USERPROFILE/WINDIR。實體 Node fixture 僅接受這些已核對
的系統注入鍵並仍驗 spawn env exact；不輸出值，不宣稱 Windows 已隔離 native HOME。
Windows reader 仍 before-spawn unsupported，未利用這些欄位讀取任何來源。
依據：[Node 22.19 libuv required_vars](https://github.com/nodejs/node/blob/v22.19.0/deps/uv/src/win/process.c#L50)。

## Bytes-only SDK composite（Plan 1.44）

新增 `history-native-service.js`，trusted Host 必須提供固定 helper／SDK 路徑與
最多 256 筆已授權 root identity；整張表先 bounded detach，拒絕 getter／自訂
iterator／unknown fields，browser 不得選擇這些依賴。既有 Node source service
保留，沒有靜默 fallback；`capture()` 明確 unavailable，不冒充 raw capture parity。

單條工作順序是 Rust actual close → 父層驗證固定 bytes frame → bytes-only Node
worker → 官方固定版本 SDK → worker actual close → registry／HTTP／Client。
Service 固定持有兩個 helper runner instance，最多兩條 composite flights、無
queue，Rust 和 SDK 共用 10 秒 deadline＋1 秒 cleanup，不把兩階段相加成 20 秒。
每個 binding 的 generation、version、lease／revoke、caller abort、shutdown
在階段間及發布前重查；unknown-close 永久 quarantine 並停止其他 flight，實體
slot 保留到 late actual close，status sweep 只釋放 slot，不解除 quarantine。

`history-bytes-wire.js` v2 stdin 為 4-byte BE header＋16KiB 以內 metadata＋8MiB
以內 raw bytes。只傳 request scope、native snapshot summary、pinned SDK path、
page／expected fingerprint；**不傳 source 路徑，不建立 raw snapshot 暫存檔**。
SHA／大小／session／identity／兩個 native checks 都由 child 重驗；回應仍最多
256KiB，不回 raw records，native checks 不可降級成舊 mode-only profile。

`history-bytes-worker.js` 的 Node permission 在Plan1.44允許12個確定的code／SDK檔案；
Plan1.52新增 `history-metadata.js`，目前共13個exact檔案。新增私有v3 job只讀
captured SessionStore的 `getSessionInfo`，title/summary分離且與v2 page operation互斥；
仍共用相同two-flight/deadline/close budget，詳[來源群組](history-source-groups.md)。
沒有 source-root／HOME／write／child-spawn grant。實際 owned sentinel 測試確認
來源／相鄰檔案讀取、寫入、spawn 皆拒絕；owned 錯 hash SDK 未被執行。
這是 reviewed SDK 的最小能力配置，不是惡意 JavaScript／native code 的 OS
sandbox；`--max-old-space-size=128` 也不是 process RSS 上限。

共用 strict TypeScript provider 接受兩種 exact check profile，兩者 authority
仍全 false。HTTP／relay／transport／page controller 保留六種固定的 ACL、root
identity、containment、identity、close 拒絕碼；任意 diagnostics／path 不外傳。
失敗 refresh 保留既有頁面，不把讀取失敗顯示成空白歷史。

`scripts/check-native-history-pipeline.mjs` 用自建 rich／compaction／file-history
sources，實跑 Rust → 官方 SDK 0.3.259 → registry → loopback HTTP／relay →
shared transport／provider／controller；含 owner/view 隔離、高 generation 重用、
in-flight revoke、版本漂移、256KiB 大頁拒絕、原檔不變和 actual cleanup。
既有 `checkHistoryAccess` 只增加 trusted factory 注入，default 舊 service 不變；
官方 artifact downloader 保持 integrity pin，只抽出 callback 共用，unknown-close
不刪除仍可能使用中的 SDK fixture。

2026-09-08 本機 Node 22.19.0／22.22.3 及 CI 同款 `--download` 指令均通過；
root 最後一次 Node 22.19 驗證與完整測試並行，整套 synthetic pipeline 3,728ms。
這是整套測試時間，不是單次互動延遲；三個小來源為 3,621／3,141／2,965 bytes，
不是大歷史效能證據。全套 Node 621 tests：619 pass／2 platform skips／0 fail；
64 項 helper／bytes／composite／registry 測試全過，strict TS／artifact／syntax／
version 與 1,251-case Ajv conformance 皆過。該 core exact-commit 遠端 CI 見下節。
後續 explicit native preview 已用 release helper 通過真 browser 功能驗收，新增
3 項 preview 回歸後本機 624 tests＝622 pass／2 skip／0 fail，詳見 `history-preview.md`。
雙大來源 3 輪 debug／release 實測及所有原始 hashes 見 `claude-history-performance.md`：
SDK 單程序 RSS 高水位仍約 201–212MiB，release 慢首輪 756ms 保留；沒有記憶體
改善、controlled A/B 或整體順滑度通過的宣稱。

本鏈 `modelCalls:0`、`privateHistoryReads:0`、`productionWiring:false`。
Windows report 的 native／SDK pipeline gate 明確 `source_platform_unsupported`，
不把不執行當成功讀取。正式 trusted executable/root bootstrap、credential／catalog
及 logout／rotation／device revoke 接線、Windows 完整 reader、來源 provenance、
大來源記憶體／延遲及實機 UI 仍待，不因合成全鏈通過而上線。

重跑（先以固定 Rust toolchain build，build output 使用本機絕對 temporary path）：

```sh
CARGO_TARGET_DIR=/absolute/local/build node scripts/check-native-history-pipeline.mjs --download
```

## 已有本機證據與待驗收矩陣

2026-09-08 Plan 1.45 補上 macOS noowners 拒絕：本機官方 SDK `sys/mount.h`
定義 `MNT_IGNORE_OWNERSHIP=0x00200000`（alias `MNT_UNKNOWNPERMISSIONS`），
`mount(8)` 說明 noowners 將 apparent UID 99 解釋為 current effective UID。
既有 local/type allowlist 不足，因此加入 mounted ownership policy 正反單測；
Mac Rust 由 10 增至 11 項，本機全過，fmt／Clippy／locked debug/release build 過。
在 internal temp 的實際 Node→Rust 正常來源成功；另外將同一合成 checker 的
TMPDIR 指向 devkit 上自己建立的空目錄，取得 exact `source_containment_unavailable`，
而不是 SDK 或 frame error。Reader actual close、來源 fixture 清理與父空目錄清理
皆確認；没有 remount、沒有讀取私人來源或更改使用者權限。這個安全補強晚於下方
`3a8bb4d` 的驗收，須以後續 exact revision CI 為準；既有 benchmark/browser
數據保留各自 old binary SHA，不冒充已測新 binary。新的 release SHA256 是
`9045ccb6e22fbd3a08d02c91aa5b7b8a5b8e7263393c874fd6ef1cb9e0937aa0`。
此條件也不保證特權管理者在觀測間瞬間 remount 的原子安全，既有 namespace
及 trusted executable 限制保持不變。

Preview exact `3a8bb4dcdb862d577fab8f89ac43b22146edf2da` 的四組
[一般 CI](https://github.com/seehow624/stepsemble/actions/runs/34176030867)、
[Native Claude](https://github.com/seehow624/stepsemble/actions/runs/34176030870)、
[Native reader](https://github.com/seehow624/stepsemble/actions/runs/34176030859)、
[手動 Rolling](https://github.com/seehow624/stepsemble/actions/runs/34176052550)
全部成功。624 項一般測試：Mac 622 pass／2 skip、Linux 621／3、Windows 599／25，
0 fail；reader 各 44/44 Node negatives、當時 Mac10/Linux11/Windows7 Rust tests；
同一 official DB／lock 的 fresh audit 0 已知漏洞／0 warnings。此結果沒有略過前面
發現的 Windows 或 Linux CI failure，而是修正後完整再驗。

Core exact `d3e2fe1cbb8818e4b5d4850a7d8285897fc25d99`：
[一般 CI](https://github.com/seehow624/stepsemble/actions/runs/34175539973)、
[Native Claude](https://github.com/seehow624/stepsemble/actions/runs/34175540015)、
[Rolling](https://github.com/seehow624/stepsemble/actions/runs/34175540044)、
[Native reader](https://github.com/seehow624/stepsemble/actions/runs/34175539992)
全部成功。Mac/Linux/Windows Rust 分別 10／11／7 tests；新 workflow Node helper／
bytes／composite 是各 44/44，64/64 為本機另外包含 registry 的組合，不混報。
Mac/Linux actual SDK native pipeline 和 bounded-page/version gate passed；Windows
兩者都 `source_platform_unsupported`。Linux 真 ACL/default ACL/race fixture 與
Windows 3 個 owned permission probes 已實跑；Windows junction 必測通過，symlink
若無建立權限可明確不執行，因此沒有獨立 evidence 時不稱 symlink fixture 真跑過。
此 run 的 RustSec audit 同上 official DB／lock，33 packages、0 已知漏洞／0 warnings。
這些結果只屬上述 core commit，不自動涵蓋未來 preview／其他改動。

2026-09-08 macOS arm64／Rust 1.97.1 本機 Rust 10 tests 通過，包含 root/project/file
各層 extended ACL 拒絕與第一次讀取後加入 ACL 的 deterministic race。本機結果與
上方 exact-commit CI 分別記錄，不把所有結果視為同一環境。
另驗 pre-epoch 明確拒絕、root spelling、首次讀取前增長由 EOF probe 拒絕。
`scripts/check-native-history-reader.mjs` 在 Node 22.22.3 及最低 22.19.0 已實跑：
actual Node→Rust→既有 JSONL parser、原文/Unicode/SHA、wrong root identity、unsafe
mode 拒絕與 cleanup 都通過。僅自建 fixture，`modelCalls:0`、`privateHistoryReads:0`；
這支 basic reader script 不含 SDK／UI；完整 SDK 新鏈和各平台 probe 已由上方
獨立 pipeline／CI 證據提供，不將 basic parser 測試冒充全部。

獨立 reviewer 在本機 Node 22.22.3 重跑 `test/claude-history-native-helper.test.mjs`：
16 tests／16 pass／0 fail／0 skip，包含實際 owned Node 子程序 binary-frame fixture。
這不是實際 Rust reader integration，也不是 CI 固定 Node 22.19.0 的結果。

以下是完整驗收要求；未被本機證據逐項覆蓋者仍 pending，不以測試總數代替能力
覆蓋，也不把 mock syscall error 當作真實 filesystem 支援。

只用測試自建 temporary fixtures；不借用私人 native histories／帳號。需要 race
時使用 test-only deterministic barrier，不以成功跑過隨機迴圈宣稱證明無競爭。

- 正常 bytes／SHA／identity／frame；8MiB 邊界、超限、growth、short read、EOF
  probe、同長 overwrite、metadata drift；無成功 partial result。
- input 超限／extra keys／invalid UTF-8／nonce／root identity overflow／wrong inode；
  project／session traversal；不 fallback 到其他 source。
- root/project/file symlink、FIFO、socket、directory-as-file、hardlink、unsafe
  mode；outside sentinel 不得被回傳，FIFO 不得令驗收無期限等待。
- root/project/file ACL 與 default ACL、unsupported/error；macOS 純 deny 也拒絕。
  真實平台 fixture 加 deterministic error injection，兩者不可互相冒充。
- 開 root 後換 pathname、開 project 後 rename、開 file 後 replacement；允許
  拒絕或原 fd bytes，禁止 replacement sentinel。明示不驗證持續 subtree membership。
- 同 UID 在 capture 前改成另一份合法 fixture，仍不得將結果標為 authenticated。
- raw frame 截斷／額外 bytes／bad hash／nonce／authority true／stderr／非零退出、
  abort／deadline／ignore termination／late close；只有 actual close 才釋放資源。
- Rust fmt／clippy warnings-as-errors／locked tests／locked build 三 OS；Windows
  CLI unavailable 與獨立 permission probe 結果分列，不將 unsupported 算 source passed。
- 實際 Node→Rust integration synthetic capture；source bytes 不變、modelCalls 0，
  source checks 僅報各平台真正跑到的能力。CI workflow 存在不等於本次已執行。

專用 workflow：`.github/workflows/native-history-reader.yml`。Build 派生檔透過
`CARGO_TARGET_DIR` 放 runner 的本機 temporary directory，不寫入共享專案磁碟。
不得因本 helper 驗收通過而提前標記正式 Web wiring、Windows reader、完整 source
provenance、Rust Host 遷移、72h 或可部署性 gate 為完成。

## 依據

- 本機 macOS `open(2)`／`rename(2)`／`fstatfs(2)`／`acl_get_fd_np(3)`／
  `acl_get_entry(3)`／`close(2)` 與 SDK `sys/acl.h`。
- Apple Libc exact `71bbe350ab79eef58113991d817ccc6165061a64`：
  [`acl_get_fd_np`](https://github.com/apple-oss-distributions/Libc/blob/71bbe350ab79eef58113991d817ccc6165061a64/posix1e/acl_file.c#L77)
  的 NULL 歧義、[`filesec_get_property`](https://github.com/apple-oss-distributions/Libc/blob/71bbe350ab79eef58113991d817ccc6165061a64/gen/filesec.c#L148)
  的 absent property，以及 [`filesec_query_property`](https://github.com/apple-oss-distributions/Libc/blob/71bbe350ab79eef58113991d817ccc6165061a64/gen/filesec.c#L304)
  的 validity bitmask。API success 與 property absence 必須分開判斷。
- Apple XNU exact `f6217f891ac0bb64f3d375211650a4c1ff8ca1ea`：
  [unsupported ACL 也可被編碼為 NOACL](https://github.com/apple-oss-distributions/xnu/blob/f6217f891ac0bb64f3d375211650a4c1ff8ca1ea/bsd/vfs/vfs_vnops.c#L1663)，
  故先用 [`_PC_EXTENDED_SECURITY_NP`](https://github.com/apple-oss-distributions/xnu/blob/f6217f891ac0bb64f3d375211650a4c1ff8ca1ea/bsd/vfs/vfs_vnops.c#L1905)
  查 mounted filesystem capability；不僅依 absence 推斷支援。
- [Linux kernel pathname lookup](https://www.kernel.org/doc/html/latest/filesystems/path-lookup.html)：
  fd/object reference、rename 與 mount namespace 的限制。
- [openat2](https://man7.org/linux/man-pages/man2/openat2.2.html)：no-symlink／beneath／
  no-xdev 的 per-lookup 邊界；[fgetxattr](https://man7.org/linux/man-pages/man2/fgetxattr.2.html)
  與 [acl_get_entry](https://man7.org/linux/man-pages/man3/acl_get_entry.3.html)：fd ACL
  查詢及 Linux return convention。
