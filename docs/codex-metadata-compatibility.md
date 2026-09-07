# Codex 0.153.4：離線相容與唯讀前置檢查

2026-09-07；開發候選 3.0.7-rc.2，**不是 release／部署／原生 adapter 完成**。

## 本次真正執行的範圍

在 macOS arm64 以使用者已指定的可信任官方 App 內 binary，僅執行 `--version`
及 `app-server generate-json-schema`。每次都使用新 local temp HOME／CODEX_HOME／cwd、
白名單環境；未啟動 app-server、讀帳號或使用模型，也沒有登入／登出、建立 session、
改設定、搬憑證、改 OpenCodex wrapper、重啟正式服務或更動固定來源 72h 長測。
不把其他工作同時可能改動的帳號設定宣稱為整天未變。

新增 [`0.153.4-schema.json`](../protocol/native/codex/0.153.4-schema.json)，
保留原 0.153.3 證據。舊 18 份 schema 的 bytes／SHA-256 全同，方法 catalog
仍為 99 client requests／10 server requests／81 notifications。另保存 6 份
config/read、account/read、thread/start 輸入／輸出 schema，共 24 份。
這 6 份沒有舊版獨立 hash，不宣稱已逐檔比對舊版。

## 修正內容

- 手動 runner 在使用真 HOME 前先生成並比對版本專屬 schema；未知版本和
  同版本 schema 漂移都停止，不因版本字串相同就放行。記錄新 baseline 不能覆寫舊檔。
- Metadata preflight 不再建立空白 thread。傳輸層只允許 `initialize`、
  `config/read`、`account/read`；不能發出 thread/turn、login 或 config write。
- `config/read` 帶相同 cwd，先核對路由，再以 `refreshToken:false` 讀 account。
  非官方 endpoint、嘗試覆寫 built-in openai provider、API-only auth、格式不明的
  設定都停止；未選用的第三方 provider 設定保留，不改成官方路由讓測試過關。
- 拒絕不是 ChatGPT 帳號 metadata 的 account，且要求
  `requiresOpenaiAuth:true`。此欄位本身不是計費／網路路由的證明。
- 1 MiB 單 frame／8 MiB 全輸出／256 notification／4 pending requests 上限；
  UTF-8 分段、截斷、非法 JSON、早期 EOF、逾時與意外 server request 均停止
  自己的 child，拒絕後續呼叫，不重試，不保留 raw notification／SDK error。
- 成功只代表 metadata gate，明確回傳 `threadCreated:false`、
  `instructionIsolationVerified:false`、`toolIsolationVerified:false`。
  Codex model turn 入口仍禁止，既有 Claude 單次 attempt marker 不變。

安全原因碼可區分 `unsupported_native_version`、`native_schema_mismatch`、
`non_native_route`、`ambiguous_native_provider_config`、`non_subscription_auth_config`、
`native_subscription_unavailable` 與傳輸故障。這是**手動檢查報告**，
尚未接成 Web UI 診斷，不能宣稱正式 App 所有 Failed 訊息都已替換。

## 驗收與限制

本機完整測試 356 項：354 通過／2 平台 skip／0 失敗；其中 native schema、
metadata transport、subscription guards 共 25 項皆離線／合成。
JavaScript check、strict typed client、protocol artifact、1,251-case Ajv conformance、
版本同步及 diff check 通過。新 commit 的三 OS CI 以 GitHub 實際結果為準；
不是三 OS 原生 Codex runtime 測試。

新版真帳號的 metadata preflight **本輪未執行**。0.153.3 的歷史路由與全域指令
觀察不能代替目前帳號狀態。後續先在既有授權範圍做 metadata 驗收；模型之前仍需
原生工具／指令隔離、訂閱路由與實際 native history/approval/resume 證據。
沒有為此取消全域 AGENTS.md，`project_doc_max_bytes=0` 仍不能視為全域指令隔離。

## 官方依據

- [App Server](https://learn.chatgpt.com/docs/app-server)：metadata RPC、account 模式，
  `account/read` 可不要求主動刷新；官方元件仍自行管理原生憑證。
- [設定參考](https://learn.chatgpt.com/docs/config-file/config-reference) 與
  [進階設定](https://learn.chatgpt.com/zh-Hant/docs/config-file/config-advanced)：供應商／endpoint／
  auth 分開，built-in provider ID 不支援覆寫；本檢查保守拒絕這類歧義設定，
  不宣稱它真的把原生 provider 替換成功。確切本機版本以生成 schema 為準。
