# Codex：指定 rollout 與名稱索引的受限讀取

Plan1.59，2026-09-08，開發候選仍3.0.7-rc.7，未部署。
這是 C2 的實際 Rust descriptor capture 與 Node 邊界；尚不是 Codex Host/Web adapter。

後續Plan1.60已接[名稱索引候選解析](codex-name-index.md)，仍不是含SQLite的最終native title。

## 本批新增

- private Rust protocolVersion3，一次程序只取得操作員已選的 rollout 與固定
  `session_index.jsonl`，不 discovery HOME、不掃描目錄、不啟動 Codex、不讀 auth/config。
- `createNativeHelper.readCodex` 接同一 helper instance 的 single-flight／取消／
  actual-close／unknown-cleanup quarantine。原 Claude read/inventory 不被新方法繞過。
- 小型 composite sourceVersion 同時含 root identity、精確 rollout locator、兩份檔案
  的各自 SHA／identity。索引缺檔與存在空檔不同；同 bytes 換 inode 也不可混頁。
- 真 Rust→Node→Plan1.58 raw snapshot/pages 的 owned fixture 已接通。保存原始
  CRLF、工具事件與名稱 index bytes；**不在此模組解析／推測 native title**。

## 為何不能只用 thread ID

固定官方tag `rust-v0.153.4`（commit `3d2ee51ca2d5db578f328aa75e20aa22c0197c9a`）
的 `rollout_file_name.rs` 允許 reverted rollout 在 thread UUID 後加獨立 rollout UUID；
`recorder.rs` 使用本地日期建立 sessions/YYYY/MM/DD。compression還允許`.jsonl.zst`。
所以本批綁定完整合法 locator，不選「同 ID 的第一個檔案」、不改讀 plain sibling。

[官方 App Server 文件](https://learn.chatgpt.com/docs/app-server) 說明 read 和 resume
不同，paginated完整歷史仍拒絕；本 reader 沒有藉啟動／恢復對話補資料。
`nativeVersion:0.153.4` 是固定格式讀取期望值，**不是偵測每個檔案由該版本生成的證據**。
原生投影缺項及既有負向gate見[Plan1.58](codex-rollout-preservation.md)。

## Private input 與 wire

```text
{ protocolVersion:3, nonce:<64 lower hex>, nativeVersion:"0.153.4",
  source:{ codexRoot:<explicit canonical root>, threadId:<lowercase UUID>,
           rolloutPath:<one exact allowed relative locator> },
  expectedRoot:{device:<u64 decimal>,inode:<positive u64 decimal>} }
```

input最多12KiB、exact keys、無caller env/args或任意name-index路徑。這是 trusted Host
input，不是 browser API，也不是 possession of expectedRoot 就自動取得來源授權。
允許 locator 為：

- `sessions/YYYY/MM/DD/rollout-YYYY-MM-DDTHH-mm-ss-<threadUUID>[_<rolloutUUID>].jsonl`
- `archived_sessions/rollout-YYYY-MM-DDTHH-mm-ss-<threadUUID>[_<rolloutUUID>].jsonl`

檢查Gregorian日期／時分秒、日期目錄與filename一致、canonical lower UUID、精確thread
匹配；不接受dot、額外separator、不同UUID、temp或任意檔案。`.jsonl.zst`只辨識格式並
回 `source_encoding_unsupported`，**本批尚未實作解壓**，不是native不支援壓縮。

output沿用4-byte big-endian headerLength＋JSON header＋raw payload，header≤16KiB。
rollout `0 < bytes ≤ 8MiB`，index `0 ≤ bytes ≤ 8MiB`；payload固定rollout後接index，
最多16MiB。各段有offset/length/SHA/identity，另有整個payload SHA、root identity、
thread/locator/version與checks。Node逐一比對，拒少／多bytes、nonce/版本/root/檔案
混用、區段交疊、hash錯誤與authority=true；只有整組成功且actual close才回detached bytes。
原Claude v1仍維持8MiB，不把它的上限擴成16MiB。

index不存在是null，存在空檔有獨立descriptor和空bytes；其他開檔／ACL錯誤不是缺檔。
失敗只回固定unavailable code，不附路徑／原文／OS診斷，stderr也不留存。

## POSIX 實際檢查

沿用[原生 reader 的信任限制](native-history-reader.md)：root逐層no-follow取得，
驗expecteddevice/inode；後續以held parent fd逐層openat，不做任意pathname fallback。
root/四層date dirs/rollout/index均要求euid、禁止group/other寫、fd ACL與local mount
policy，regular files必須single link／同device；FIFO以nonblock開啟後拒絕。

持有兩份file fd與每個directory fd：兩輪各讀兩份完整bytes，途中／之後重驗metadata、
ACL及name-index是否仍存在／同inode，最後重驗所有name→object edges和root path。
時間budget5s，Node擁有10s／4096chunks與actual-close限制；不重試、無queue。
變動回unavailable，不發布其中一份或截尾。

這些是多次**已觀測的一致性檢查，不是跨檔案原子交易快照**。不凍結mount namespace、
不證明同UID程序沒改寫過、不解決全部ancestor acquisition或來源真偽。
回傳bytes之後來源仍可能改變，Host仍須在發布前與跨頁比對sourceVersion／權限。
所有成功 `sourceAuthenticated:false`、`publishable:false`；raw snapshot另維持
`semanticHistoryComplete:false`。Root/locator/index bytes必須留在Host-private層，
尤其整份index可能含其他對話名稱，不可送公開catalog、logs或未授權reader。

## 驗證

- Rust新增8tests，本機25/25；request/locator／raw錯誤frame、active/archive、
  index缺／空、各階段bytes/inode/presence變動、links／大小／FIFO／目錄拒絕、
  root與全部7個descriptor的ACL、directory mode、讀途中index ACL變動。
- Node新增8tests；本機完整816＝814pass/2skip/0fail，最低Node22.19聚焦38/38。
  跨版本／thread/root/locator、單段／整組SHA、offset、authority、partial／oversize、
  無getters、detached版本、三種操作共用single-flight、abort/晚close/quarantine均驗。
- 最低Node真Rust9次owned capture：active＋reverted archive，替換／追加／移除／空
  index版本不同；root mismatch／index mode／壓縮拒絕，auth locator spawn前拒絕。
  capture後接raw分頁，CRLF逐bytes回復且3個transient事件仍在；沒有native CLI/model。
  own fixture明確變動後恢復原bytes、actual cleanup確認，不宣稱過程從未寫fixture。
- 舊Claude native reader及真SDK→actualHost/sourceGroups/metadata/setup/shared admission
  owned鏈仍通；strict TS/generated/syntax/version/Ajv1251/fmt/clippy/actionlint通。
- 擴充三OSreader CI跑新pair鏈。Windows Node precheck維持unsupported；runner用
  trusted test override，要求**實際Windows binary**也回unsupported，不冒稱POSIX通過。
  本批exact CI已核對；Windows仍是拒絕能力驗證，不是完整來源讀取通過。

logs `/tmp/stepsemble-codex-capture-{rust.log,minnode.tap,suite.tap,native.log,legacy-reader.log,pipeline.log}`。
首次runner只因測試錯寫raw結果kind失敗，改成既有`codex_rollout_records`後重跑；
保留`native-first.log`，沒有改raw結果讓測試過。本機debug artifact是本輪重新build。

### Exact CI（2026-09-09 MYT 收尾）

程式 `ebe9a8e1f9946ce03e9008e3afb76d5fe9e25099`，五組終態及完整logs均已核對：

- 一般 [34248356766](https://github.com/seehow624/stepsemble/actions/runs/34248356766)：
  各816tests；Mac814pass/2skip、Linux813/3、Windows769/47，全部0fail，各Ajv1251。
- reader [34248356758](https://github.com/seehow624/stepsemble/actions/runs/34248356758)：
  Rust Mac25/Linux25/Windows10；Node各85/85。POSIX新Codex9次capture→raw頁、
  舊Claude actualHost/sourceGroups/metadata/setup/shared gates通；Windows真binary
  回source_platform_unsupported。三平台cleanup確認、private/model0。
  RustSec0.22.2／DB`bf25f6575a93a35f30796c65c0ed91bee7fa19fd`、1242advisories，
  lock SHA`6583452ddbf9af1e6cce6623144f94660c4108c6877efa02e1e58b90d28f2e25`、
  33packages，known vulnerabilities0／warnings0。
- NativeClaude [34248356747](https://github.com/seehow624/stepsemble/actions/runs/34248356747)：
  三OS固定SDK0.3.259、model0、nativeFileUnchanged=true。
- NativeCodex [34248356843](https://github.com/seehow624/stepsemble/actions/runs/34248356843)：
  attempt1的Linux在下載官方archive時curl35／connection reset，尚未執行native；
  保留失敗log，只rerun failed Linux。attempt2 Linux通，Mac/Windows沿attempt1已通結果。
  各49turns/147items、raw113頁/219records/3transient/byteexact、model0、loaded0、
  11原檔不變與cleanup確認；native缺項及paginated/items-list負向gate仍保留。
- rolling [34248356890](https://github.com/seehow624/stepsemble/actions/runs/34248356890)：
  Mac/Linux各24cases、pageErrors0；各六native頁×11語、localeReads0及原文/focus/scroll保留。
  這是既有合成Host UI回歸，不是新Codex Host/Web或真機驗收。

CI logs `/tmp/stepsemble-codex-capture-{ci,reader-ci,claude-ci,browser-ci,codex-ci,codex-ci-rerun}.log`；
首次下載失敗和rerun分檔保存，不抹除失敗。沒有重新部署或延伸72h證據。

## 仍待接上的產品工作

Codex source-group opt-in／exact locator discovery、fixed name-index semantic reader、
受限`.zst`解壓與referenced history、選定歷史版本／跨頁stale fence、Host共用admission
從capture持有到轉換／release、reader registry／HTTP/relay/TS/UI仍待。不能把新helper
方法當作已開通所有對話、原生title或完整工具投影。C1與C3–C8同樣仍依主計畫推進。
沒有私人root/readers grant、帳號／route、正式restart/deploy、B+或獨立72h變動。
