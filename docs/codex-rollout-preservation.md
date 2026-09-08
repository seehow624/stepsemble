# Codex legacy：原始記錄與原生投影分開保留

Plan1.58，2026-09-08，開發候選仍 `3.0.7-rc.7`，未部署。
這是 C2 的 bytes-only 原始記錄分頁及相容性診斷，不是完整 Codex adapter／Web 功能。

## 缺項原因已定位

先前八類工具 fixture 的 native read 只有六類，commandExecution/imageView 未返回。
本次沒有猜改 JSON、刪除原 fixture 或減少 expected 清單：

1. 用同一固定本機 0.153.4、隔離自建 HOME 暫時開啟 rollout trace；rich file
   的16 records 全部被讀入，parse errors0。診斷 instrumentation 隨後移除，
   正常傳輸仍不保留 native stderr 或原生 error text。
2. 檢視官方 `rust-v0.153.4` 原始碼，tag 解引用為 commit
   `3d2ee51ca2d5db578f328aa75e20aa22c0197c9a`。`app-server/src/request_processors.rs`
   的 `build_legacy_api_turns_from_rollout_items` 先調用 `is_persisted_rollout_item`。
3. `rollout/src/policy.rs` 把 ExecCommandBegin/End、ViewImageToolCall 列為 transient，
   legacy replay 因而不送入 builder；builder 本身雖有 handler，不能據此宣稱 API
   會還原。ResponseItem function calls 也不是該 builder 的 tool-item 回退路徑。

這解釋已觀測 fixture 的省略行為，不宣稱已檢查所有歷史版本，也不把公開 tag commit
冒充本機 binary 的可重現 build provenance。原生缺漏 gate 仍是
`native_projection_incomplete`（commandExecution/imageView），不是成功的完整工具歷史。
[官方 App Server 文件](https://learn.chatgpt.com/docs/app-server) 仍明示 paginated
full-history/turn pagination/resume 尚不支援；本版不建立或手改 native SQLite 來繞過。

核對的本地 reference bytes SHA256（路徑相對 `codex-rs/`）：

| 檔案 | SHA256 |
| --- | --- |
| app-server/src/request_processors.rs | 341f8855a79b7fd2e09f3a4d44e341ec322d476c645fefddf73f96355ce30f79 |
| rollout/src/policy.rs | d5e8584728fdcb2bd73e8522df88ad7d32d61a3b674324d3a84db3f553bac100 |
| app-server-protocol/src/protocol/thread_history.rs | 9c656087ffca171eafd180dd9be6051f1d9127d8467a82057a6ed0b752e7d9f2 |

## 原始記錄分頁契約

`protocol/native/codex/rollout-snapshot.js` 只接受 caller 已取得的 Uint8Array/Buffer：

- `createRolloutSnapshot(bytes, {nativeVersion,threadId})`：固定 reader version0.153.4、
  明確選取 thread，拒 shared memory，複製指定 byte view；不接受來源 path、fd 或 HOME。
- 最多8MiB／8192 records／單行128KiB，fatal UTF-8，完整 LF 結尾、有效 JSON 物件
  和首個非空 session_meta 的 selected ID；paginated、未知模式、無法驗讀／超限
  都回固定 unavailable，不截尾。後續 fork metadata 保留但不改 selected ID。
- JSON schema／各歷史 cli_version 的完整語意**未驗**。保留數字與 key 的原始 spelling，
  不把 JSON.parse 的便利檢查結果當格式正規化、來源真偽、duplicate-key 語意認證。
- snapshot header 凍結，bytes/boundaries 留在 WeakMap；隨機 snapshotId、整檔SHA、
  nativeThreadId及每行byteOffset/length/SHA固定。沒有偽造 native turn/item ID 或 title。
- `readRolloutPage(handle,{snapshotId,offset,limit})`：每頁最多50 records／272KiB encoded
  output，依byte budget縮小**整筆**回傳數，再給nextOffset；不丟內容、不切半筆。
  CRLF、空白行、未知 record/欄位、工具文字與圖片路徑均以 inert rawText 完整保存。
- handle 與 snapshotId 都必須匹配；即使新舊 bytes SHA 相同也不混用，克隆header不可讀。
  回覆 detached，不可反改內部快照；release不可逆並清掉本模組持有的 bytes/boundaries。
  已回給 caller 的文字不保證抹除。

所有結果 `sourceAuthenticated:false`、`publishable:false`、`semanticHistoryComplete:false`。
endOfFile 只表示這份已複製 raw file 到尾，不表示 live session 完成或 native history 全部。
沒有 source discovery／檔案開啟／ACL／原子 filesystem capture、CLI/SDK/network/model，
也不載入圖片、執行工具、回 approval、resume、改名或寫入原生來源。
沒有全 Host 的 admission/registry；外層仍須控制同時保留的 snapshot 數量及授權。

## 已驗證

- 新11項unit tests：raw byte round-trip／CRLF/Unicode/blank/unknown、rich transient
  records、typed-view copy／input/output mutation、snapshot混用、release、metadata/
  fork/mode、UTF8/partial/size/count、page byte budget、accessor/shared-memory拒絕。
- 首批本機完整805＝803pass/2skip/0fail；Node22.19聚焦37/37，strict TS/generated/syntax/
  version及Ajv1251通；actionlint通。
- 本機固定真CLI兩個Node版本（22.19.0、22.22.3）：原49 legacy turns／147 items、
  29原生觀察頁及缺漏 gate 不變；raw新增113頁／219 records逐位元組還原，保留
  三筆 transient command/image 事件，已release舊handle拒絕。11原檔不變、loaded0、
  model endpoint0，actual child close後ownedHOME清理。不是三個工具被執行過。
- 新 `Native Codex owned history` workflow：官方0.153.4三平台archive與SHA固定；
  hash通過才extract單一固定binary，不安裝／不改PATH/帳號。以Node22.19和owned
  fixture跑真CLI；必要schema drift/實際method行為會失敗，不能以skip/unsupported
  冒稱完整產品。首批exact commit `57decd7d5a6d448ba6b05ba222e5ffaa56043aa3`：
  [一般CI34243456424](https://github.com/seehow624/stepsemble/actions/runs/34243456424)
  三OS各805/0fail（Mac803pass/2skip、Linux802/3、Windows758/47），各Ajv1251；
  [native CI34243456521](https://github.com/seehow624/stepsemble/actions/runs/34243456521)
  Mac/Windows真CLI通過、Linux遇啟動通知失敗，不能把此run整體寫成通過。

本機logs：`/tmp/stepsemble-codex-raw-{focused.tap,full.tap,minnode.tap,runtime.json,minnode-runtime.json}`。
Plan1.55既有負向evidence不覆寫；新結果另存
[Plan1.58 evidence](baselines/codex-rollout-preservation-owned-2026-09-08.json)。

## Linux 啟動通知修正

首批Linux CI停在 `codex_history_unexpected_native_event`。使用已存在的
Node22.23.2 Linux arm64容器、官方固定0.153.4 binary和自建HOME重現：原生
`configWarning` 提醒PATH沒有system bubblewrap，會使用bundled版本；通知外層
另有 `emittedAtMs`。官方同tag的 `ServerNotificationEnvelope` 與 bwrap helper
也有這兩項定義。暫時診斷只對owned fixture使用，已移除，不保留原生通知文字。

修正只在 runner 的Linux owned-fixture模式明確開
`allowOwnedLinuxSandboxNotice:true`（另必須已有 `allowIndexRepair:true`）：

- 預設仍關閉；只接受固定0.153.4缺system-bwrap通知的精確文字SHA、空details、
  無非空path/range、合法可選整數timestamp、無request ID或多餘欄位。
- 最多一次，且必須在第一個history回覆前；變字、重複、過晚、user-namespace
  警告及其他事件／approval一律終止。不是略過所有configWarning。
- 只回固定診斷碼 `owned_linux_system_bwrap_missing`，不輸出native summary。
  沒有偽裝bubblewrap、安裝系統helper、改sandbox權限或增加執行能力。

修正後本機808＝806pass/2skip/0fail、最低Node22.19聚焦40/40，生成／strict TS／
語法／版本／Ajv1251／actionlint通。macOS兩Node真CLI及隔離Linux arm64真CLI均
raw113頁219records一致、model0、loaded0、11原檔不變、actual cleanup確認；
Linux僅多一個上述診斷碼。Linux容器network none/read-only、cap-drop ALL，這不是
跨Host／私人source reader或shell sandbox功能驗收。修正版本的exact三OS CI待核對。
完整logs為 `/tmp/stepsemble-codex-raw-notice-{full.tap,minnode.tap,runtime.json,minnode-runtime.json}`
及 `/tmp/stepsemble-codex-raw-linux-verified.{json,log}`；本次owned容器已結束且移除。

## 下一步

先接明確授權的 legacy source root／name index、Rust descriptor/ACL capture、一致來源
版本與跨頁 stale fence，再接 Host 共享限額、逐 reader registry、HTTP/relay/TS/UI。
raw source text 含私人路徑與工具輸出，不能直接出現在公共 catalog、logs 或新任意路徑API。
原生可投影項目與原始記錄必須分開標示，不能合成工具成功／approval／resume。
C1完整管理、C3–C8、Windows原生source capture/真機/效能/發布 gate 仍待；
本批不改B+、正式3.0.6、私人root/readers、帳號route與獨立固定72h。
