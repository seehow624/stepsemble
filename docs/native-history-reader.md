# ADR：獨立原生 history source reader 的窄邊界

日期：2026-09-08。狀態：standalone 實作／本機合成驗證；本 exact commit 的
跨平台 CI 驗收 **pending**。本機證據見下節，不代表 production gate 已完成。

## 決策與非目標

以小型 Rust helper 補上 Node 公開 API 缺少的 descriptor-relative 開檔與
fd-based ACL 檢查。這是單次、唯讀、指定 source 的 reader，不是 Rust Host
大遷移；不接正式 Web／Node source service、不部署、不改固定來源 72h 長測。
不 discovery HOME、不掃描私人 history、不載入 SDK、不啟動 native CLI、模型、
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
4. 由 fd 的 `fstatfs` 取得 filesystem type。本階段 macOS 只接受 APFS／HFS，
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

檔案／fd 由 Rust `File`／RAII 擁有；raw fd 只借用於局部 libc interoperability。
每段 unsafe 都記錄：fd 生命週期、buffer 長度／alignment、C 字串無 NUL、初始化與
返回值檢查、ACL allocation 的唯一釋放。不雙重接管 raw fd、不重試關閉可能已被
重用的 fd number，不把 unchecked errno／size 轉換帶進安全邏輯。

Node runner 是獨立測試／實驗 adapter，不替換現有 source service。它限制 stdin、
header、raw frame／stderr 和 pending work；完整驗形／hash／nonce 後仍等 owned
child actual close，再檢查 revoke／timeout 才能成功。abort、malformed frame、
非零退出或 cleanup unknown 不得發布 partial 或 late bytes；未知 close 保留占用。

Helper executable 的 pre-exec hash 驗證只證明「檢查時 pathname bytes」；從 hash
到 spawn 仍有替換競爭，不能稱為 exact executed-bytes pinning。Caller 須信任
build/output directory 及 launch environment；不讀 HOME／credential／loader 注入。
本版不是 OS sandbox、網路 sandbox 或對惡意 helper executable 的隔離。

## 已有本機證據與待驗收矩陣

2026-09-08 macOS arm64／Rust 1.97.1 本機 Rust 10 tests 通過，包含 root/project/file
各層 extended ACL 拒絕與第一次讀取後加入 ACL 的 deterministic race。這只證明
該次本機 source revision／filesystem fixture；尚非三 OS exact-commit CI 結果。
另驗 pre-epoch 明確拒絕、root spelling、首次讀取前增長由 EOF probe 拒絕。
`scripts/check-native-history-reader.mjs` 在 Node 22.22.3 及最低 22.19.0 已實跑：
actual Node→Rust→既有 JSONL parser、原文/Unicode/SHA、wrong root identity、unsafe
mode 拒絕與 cleanup 都通過。僅自建 fixture，`modelCalls:0`、`privateHistoryReads:0`；
不是官方 SDK 新鏈或正式 UI。Windows permission probe 的平台實跑及 Linux ACL
fixture 仍須各自 CI 證據。

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
