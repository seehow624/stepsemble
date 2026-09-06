# 原生訂閱最小驗收：手動、有額度上限、不能自動重試

2026-09-05 Jerome 明確同意 Claude／Codex 各 **1 次**最小原生測試，
不改登入／模型路由，不重啟正式服務。這是人工 native harness 驗收，
**不是已接上 Stepsemble Web 的 adapter，也不是 approval／resume parity 通過**。

## 最新檢查：2026-09-06，新的同意，兩邊均未送模型

Jerome 再回覆「好」，同意 Claude／Codex 各新一次最小訂閱測試；仍不授權變更
登入、路由、計費來源或全域指令，也不允許失敗後自動重試。此同意與 9 月 5 日
已消耗的 Claude attempt 分開記錄，沒有刪除或重置舊 marker。

去識別結果：[`baselines/native-subscription-preflight-2026-09-06.json`](baselines/native-subscription-preflight-2026-09-06.json)。

- Claude 2.1.259：正式 Web 經桌面助手回 `signed_out`；本次執行環境確認為
  Aqua，直接官方 CLI 的 `--safe-mode auth status --json` 亦為
  `loggedIn:false`／`authMethod:none`。沒有執行 `-p`，不是模型請求失敗，
  也不是只從 SSH 的狀態推定登出。需要 owner 完成官方登入，未定位頻繁登出的全部根因。
- Codex：可信任原生入口現為 **0.153.4**，而 runner 僅釘住 0.153.3。
  實際 preflight 回泛化的 `native_probe_failed`；後續只讀 `--version` 與 runner
  執行順序核對，確認在版本檢查即停止，未啟動 app-server／查 account／建立 thread。
  不把舊版的帳號、有效路由或 instruction-source 觀察當成新版已驗證結果；
  也沒有放寬版本門檻、降版 binary 或更改 OpenCodex wrapper。
- 新 run 的兩個 attempt marker 均不存在；本次模型 attempt **各 0 次**，
  usage 未觀察，不填成全帳號零用量。原生登入／登出均未呼叫。
- 5 個原生設定／全域指令邏輯路徑的前後 SHA-256 相同，沒有直接讀取、輸出或複製原生憑證；官方 CLI 仍自行讀取其登入狀態。
  Mini／MBP 正式仍 3.0.6、uptime 連續；桌面助手、既有 CUA 服務和 72h fixture
  均未被重啟。72h 仍 running，不是通過。

本輪因此停在前置檢查。未使用的額度同意不授權任意新版本、路由、設定或自動重送；
後續先完成 Claude 官方登入、Codex 新版介面與路由／指令／工具隔離審查，才可再評估最小驗收。

## 歷史實際結果：2026-09-05

完整去識別摘要：[`baselines/native-subscription-smoke-2026-09-05.json`](baselines/native-subscription-smoke-2026-09-05.json)。

| 項目 | 觀察 | 結論 |
| --- | --- | --- |
| Claude Code 2.1.259 | 官方 `auth status` 顯示已登入 claude.ai；實際唯一一次 `-p` 失敗。這次自己的新 history 保留 user prompt 與 `<synthetic>` 的 `authentication_failed`，原因是 OAuth 過期且更新失敗 | 未通過；沒有重試。原生記錄 input/output/cache 四項 usage 都是 0，不能把它延伸為服務端帳務或整個帳號額度的保證 |
| Codex 0.153.3 | app-server 初始化與 ChatGPT account metadata 可讀；`thread/start` 曾回傳 1 個全域指令來源，即使 `project_doc_max_bytes=0`。另確認 effective config 的 API base URL 指向使用者設定中的本機代理 | **沒有送 `turn/start`**；不是 Codex 模型失敗。最後 runner 在路由檢查就停止，不再建立新 thread；不能只靠 provider 名稱／登入類型宣稱原生直連 |
| 影響核對 | Claude settings／Codex config 前後 SHA-256 相同；沒有 login/logout、複製憑證或改 wrapper；正式 health 3.0.3 正常、未重啟 | 保留現況，沒有為驗收改帳號或第三方工具設定 |

安全檢查比原先預期更嚴格，因此本次兩個成功 gate 都未通過。早期 Codex
preflight 可能留下空 native threads；沒有刪除或改寫原生歷史，也沒有讀其他既有對話。
Claude 的唯一 attempt marker 與自己的錯誤 history 保留供交接，不因零用量就清掉。
原始本機臨時路徑只記於私人 vault，不放 public fixture；沒有輸出 email、token、
原始設定、私人指令內容、原生 session ID 或代理位址。

## 手動 runner

`scripts/probe-native-subscriptions.mjs` **不加入 npm scripts／CI**。一般測試只測
純函式與合成暫存 marker，絕不呼叫真實 CLI／模型。

人工操作前須重新確認當次授權、既有 attempt 與可信任 native executable；
旗標不是同意書，不得自動新建 run 來規避已用掉的那一次。
目前 Claude 可做單次 attempt，**Codex 僅開放 preflight，不提供 model turn 入口**；
完整原生指令／工具隔離審查完成後才另行實作。版本釘住 Claude 2.1.259／Codex 0.153.3；其他版本先重新檢視。Codex
設定 inventory 解析另需 Python 3.11+ 的 `tomllib`。目前只做 macOS 本機驗收，
不是三 OS 原生 runtime gate。

```sh
node scripts/probe-native-subscriptions.mjs prepare
node scripts/probe-native-subscriptions.mjs codex /absolute/prepared-run /absolute/native/codex --preflight-only
# 以下會嘗試使用訂閱額度，必須有當次明確授權：
node scripts/probe-native-subscriptions.mjs claude /absolute/prepared-run /absolute/native/claude --execute-one-turn
```

- 原本 HOME 保留，讓官方 CLI 自行管理自己的憑證；不複製 OAuth／API key，
  不把第三方路由環境或 loader 變數傳給子程序。USER／LOGNAME 保留，否則 macOS
  原生登入偵測可能誤報未登入。讀設定不是繞過授權，原生 CLI 本身仍可能依其正常流程更新憑證。
- Claude `--safe-mode` 配合固定 marker、替代 system prompt、tools 空集合、
  strict 空 MCP、1 turn。`--bare` 不適用本次：官方說明它不讀 OAuth／Keychain，
  對 Anthropic 連線只接受 API key，會改變測試目的。
- Codex 直接指定可信任官方 binary，不執行 OpenCodex wrapper；依本次 binary 的
  schema 使用 `sandbox: "read-only"`。初始化後核對 auth 與完整有效路由，
  不改路由讓測試通過。MCP 名稱只允許可無歧義表達的 bare dotted keys；
  這個 CLI 會把加引號的 key segment 當成不同 server，不能用字串拼接猜語法。
  最終 runner 也以 per-process flags 關閉 hooks／shell snapshot／memories；不寫回設定。
- Codex 指令來源非空就停；`project_doc_max_bytes=0` 不能當全域指令隔離證據。
  沒有為了繞過此檢查搬走 AGENTS.md、換 CODEX_HOME 或複製 auth。
- 模型效果之前以 `wx` 排他建立並 sync 私人 attempt marker；即使後續 timeout、
  parse failure 或 crash，重跑同一 run 也先拒絕。這只是手動測試防重送，
  **不是產品 durable ledger／power-loss exactly-once 證據**。
- 結束或中斷只停止自己啟動的 child；不重啟使用者 App／正式服務。
  stdout frame 設上限，失敗報告只用白名單欄位與數字用量；不 dump 原始 SDK errors。
- Claude 成功路徑需要 marker stream、native session correlation 與 owned process
  結束後的 history readback；**本次未走完成功路徑**。不做 approval；任何 Codex
  server request 都拒絕並停止。`approvalPolicy: never` 本身不代表工具被禁止，
  所以 Codex model turn 入口暫不提供，不能把事後檢查 tool item 當執行前安全防線。

## 後續需要人工處理

2026-09-06 較早曾偵測到 claude.ai；當日最新檢查已是 `signed_out`，以上方新紀錄為準。
新的單次額度同意已收到，但前置檢查未過、沒有再次模型呼叫；前次失敗仍保留，
不能沿用已消耗的那一次 attempt。新增 App 登入入口的開發進度見 [`claude-sign-in.md`](claude-sign-in.md)，
不等於原生 smoke 或完整 adapter 成功。

Codex 要先決定原生訂閱與既有第三方路由的隔離方式，以及全域指令是否可納入
最小測試。此次沒有得到修改設定／憑證／指令的授權，故維持未送 turn；未使用的
一次不代表未來任何設定／模型／版本都可直接開跑。真正 adapter 的 native proof、
approval、resume/reconnect、durable journal、跨 OS、Rust／Apps gate 仍待完成。

## 依據

- [官方 Codex App Server](https://learn.chatgpt.com/docs/app-server)：原生結構化介面與生命週期；此次依本機生成 schema 核對版本差異。
- [官方設定參考](https://learn.chatgpt.com/docs/config-file/config-reference) 與
  [AGENTS.md 規則](https://learn.chatgpt.com/docs/agent-configuration/agents-md)：設定分層與全域／專案指令來源；不將專案 byte cap 推定為完整隔離。
- [官方 0.153.3 全域指令 loader 原始碼](https://github.com/openai/codex/blob/rust-v0.153.3/codex-rs/codex-home/src/instructions/mod.rs)
  與 [project loader](https://github.com/openai/codex/blob/rust-v0.153.3/codex-rs/core/src/agents_md.rs)：全域指令是獨立載入來源，與本次 runtime 觀察一致。
- [Claude 非互動模式](https://code.claude.com/docs/en/headless)：官方 CLI 與 bare 模式的登入差異。
- [Claude 法律與合規說明](https://code.claude.com/docs/en/legal-and-compliance)：本次是擁有者既有官方 CLI 的單次使用，不收集或中介訂閱 OAuth；不是對產品商業模式的合規認證。
