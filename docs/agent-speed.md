# 對話速度控制

速度與模型、思考強度分開。新對話不沿用其他對話的 Fast；只有使用者明確選擇的對話保存速度偏好。Fast 可能增加用量或費用，確認視窗亦提醒：CLI 在此對話內建立的原生子 Agent 依其自身規則，可能一併受影響。Stepsemble 不把速度加入 agent.last、工作流程或外部子任務預設；沒有承諾 CLI 內部子 Agent 的費用隔離。

## 契約

`GET/POST /api/agent-speed` 接收 `agentId`、`sessionId`、可選 `model`。POST 使用 `speed: standard|fast|ultrafast`，並帶 GET 的 `revision`；任何付費級別均需要 `confirmCost:true` 與該級別的能力指紋。Fast 沿用 `fingerprint`；Ultra Fast 使用 `fingerprints.ultrafast`，不可借用 Fast 的確認或指紋。過期選擇或能力拒絕為 409。保存失敗回 503，不把記憶體值假裝成已持久化。

回應分開提供：

- `support: supported|unavailable|unknown`、`choices`：是否有已驗證的設定契約與目前能力。
- `requested`：該對話的偏好，不等於供應商已提供付費加速。
- `effective: standard|fast|ultrafast|cooldown|unknown`：只有原生狀態足夠才標示有效。
- `reason`、`appliesNextTurn`、`fingerprint`、`revision`：原因、下回合語意、模型/路由重驗與跨視窗比較後更新。

原生 ACK 不是速度保證。排隊保存送出當時的速度與指紋，派送時再次驗證；不能把速度快照塞入既有執行回合的 steer，這類訊息留待自己的回合。換模型/供應商／路由或撤回 offering 時撤銷不相容的付費級別，切回不自動恢復。

## 實際支援範圍

| Agent／路由 | 目前行為 |
| --- | --- |
| Codex 原生 OpenAI | 0.163.0 起的已知 per-turn 契約；原生 `model/list.serviceTiers` 明示 `priority` 或 `fast`，且有效設定/子程序環境確認官方路由才開放 Fast。不是依模型名字的 Fast 字樣。Ultra Fast 另要求同一已驗證原生官方路由的新鮮精確模型列明示 `ultrafast`；只有此路徑開放 Ultra。 |
| Claude Code 原生 Anthropic | 此輪實際驗證 2.1.308。模型明示 `supportsFastMode:true`、原生狀態存在、官方路由且無帳戶/政策拒因才開放；`sdk_opt_in_required` 由使用者明確選擇觸發 session opt-in。未知版本不猜支援。 |
| Codex 經已識別 Magpie | `/v1` Responses 契約要求同一 service 的新鮮精確模型列宣告 `owned_by:"codex"`、`native_endpoints:["/v1/responses"]` 與 `service_tiers.priority`。另有獨立的原生 `/backend-api/codex` 契約：只限內建 `openai` provider、無自訂 catalog／衝突路由，原生 `model/list` 的精確無 slash 模型明示 priority，且新鮮 gateway 列 `codex/<原生模型>` 同時符合上述 owner／endpoint／tier。兩種路徑指紋分離，不接受任意 loopback、路徑或 group／虛擬模型。 |
| Claude Code 經 Magpie Codex 模型 | Claude 2.1.308、已識別 Magpie 根 URL、同一新鮮精確 `codex/<model>` 列明示 Codex owner、上游 Responses 與 priority 才開放 Fast。用原生 session-local capability env 加入該精確模型的 `fast_mode`，再驗證 fastMode true/false、effective settings 與 initialize on/off。保留模型與 effort；gateway served tier 仍 unknown。 |
| Pi 經相同 Magpie Codex 模型 | owned extension/RPC，只限 `provider:magpie` 與上述精確 metadata。Responses／Chat Completions 的 base URL 為 `/v1`，寫／清除 `service_tier`；Anthropic Messages 的 base URL 為根路徑，寫／清除 `speed` 與自有 Fast beta，保留其他 beta。各 input API／路徑指紋分離。其他 provider／模型仍 unknown。 |
| Pi 原生 ChatGPT OAuth | owned extension、`openai-codex`／`openai-codex-responses`、官方 ChatGPT backend。用 Pi 自己目前帳戶的新鮮 `/codex/models` 精確 `slug` 列明示 `service_tiers.priority` 才提供一般／Fast；不提供 Ultra，不改模型、effort 或登入路由。原生 SDK 委派邊界綁定實際請求憑證，詳見下節。 |
| 其他 Magpie owner／任意代理 | 未有相同轉送契約證據者維持 unknown。Magpie 可能全域強制 tier 或拒絕後回退，UI 明示 requested 與 served 分離，不修改其全域設定。 |
| Hermes Bot | 維持 unknown。已檢視 0.22.2 session-qualified WS setter，但它會立即改動忙碌回合，缺少已驗證的 tier＋prompt 原子派送；config.get 的一般模式讀回可能落回全域 Fast，重連重開亦會換 live identity。不能只加選單就保證排隊快照。沒有無 session 的 config.set。 |
| OpenCode、Grok/其他 ACP、Antigravity | `unknown`；不把 variants、模式、思考強度或名字當速度能力。 |

Pi 原生 ChatGPT 的能力只來自同一 Pi OAuth 帳戶；Magpie／Codex CLI catalog 或憑證不能替此不同路由授權。缺原生 SDK ownership、OAuth 或 offering 時維持 unknown。Claude 經 gateway 不借用原生 Anthropic offering；目前只開放上表已驗證的 Magpie Codex 轉譯路徑。Magpie 0.1.1330 Claude subscription 列沒有 tier metadata，且其 subscription CLI bridge 不轉送請求 speed，仍 unknown；任意 owner、虛擬／group 模型亦不開放。

模型選單以鍵盤可操作的 segmented radio 顯示目前已驗證的選項；不提供 Ultra Fast 就不建立該按鈕，不用停用、鎖頭或升級文案佔位。一般模式不在 composer 顯示速度標籤；已保存 requested Fast 是模型按鈕內的小閃電，Ultra Fast 則為閃電加號，均非另一個互動控制。長篇 requested／reported、gateway 及安全原因收在可展開的速度資訊與輔助說明內，費用提醒留在每次切換付費級別的確認視窗。未顯示 runtime 原始錯誤、URL 或憑證。GET 失敗明確提示並關閉新付費授權，仍可關閉既有 Fast／Ultra Fast。

背景 focus GET 不停用已驗證的速度選擇器，也不覆寫尚未提交的鍵盤選擇；確認視窗前先鎖定 save，舊 GET 不可覆蓋成功的 POST。目錄載入完成後重驗同 key 的能力，不能把初次尚未就緒快取當成永久拒絕。

未知 Agent/代理不會被 Stepsemble 自動開啟 Fast，也不會被擅自寫入未驗證的關閉欄位；其原有外部設定可能仍適用，UI 明示未知而不是宣稱一般模式已生效。

## 原生派送與失敗

- 尚無活躍 owner 的 Codex 對話以唯讀 prospective probe 評估：`thread/read(includeTurns:false)` 取得該 thread 的 modelProvider／model／cwd，再依其 cwd 讀有效 config 及原生 model/list。缺身分不借用其他 thread 的 transport context。GET 不 resume、不建立 owner、不寫 tier、不送 user frame；實際派送仍在該 thread 的 owner 再次驗證能力與指紋。
- Codex 新建/續接以 `serviceTier:"default"` 清除已知 native session 的付費預設；每次新回合明確送 `serviceTier:"default"`，以及 `serviceTierForTurn:"default"|<已宣告 tier id>`。付費 tier 不持續寫進 thread 預設。設定/派送回讀與實際供應商服務分開，後者保持 unknown。
- Claude 僅使用 `apply_flag_settings` 的 `{fastMode:true|false}`，不送 `/fast` 使用者 prompt，不更改模型或 effort，不呼叫寫設定檔的 `update_settings`。`get_settings.effective.fastMode` 必須精確相符，再由無 user prompt 的 initialize 握手讀 `fast_mode_state`／拒因；on、off、cooldown 不混用。帳戶拒絕時回復 false；ACK 與讀回不一致會拒絕送出。
- Claude 控制 timeout 可能已套用，故標為未知並阻止後續 prompt，直到重新開啟子程序；晚到 ACK 不能解除此限制。非 timeout 的讀回不符可用明確 standard 握手重新確認。若上一輪 result 缺少速度 metadata，閒置且序列化的 Fast 派送先讀新 initialize，再核對能力／指紋，不依賴瀏覽器 GET；新握手仍未知、拒絕或逾時則不送 user frame。
- Pi 先驗證 `get_commands` 的 extension 來源及自有檔案路徑，才送無模型訊息的 `/stepsemble-speed` 控制命令；handled ACK 不算成功，必須找到同 nonce、同模型身份、有效 leaf 父鏈上的 custom-entry 回執。Host 對同 sid 的設定／讀回／prompt 序列化；不明 set 結果鎖住後續送出，直到重新開啟。extension 在 session branch 還原自己的偏好，模型切換清成 standard；每次 provider request 重新驗精確路由／模型，Fast 寫 `service_tier:"priority"`，standard 刪除該欄位，不碰 reasoning。未知／虛擬模型不附加付費 tier。派送前 offering／指紋／模型撤銷時用 Pi abort 控制；不能只 throw（Pi 會捕捉 hook 錯誤繼續）或偷偷降級派送。
- 忙碌中只記下回合偏好，不修改當前付費旗標。每個實際送出的回合仍帶速度快照，重開後保存偏好不等於免驗證授權。Pi 自有 `/stepsemble-refresh-models` 經精確 command 來源／路徑確認後，仍能在忙碌時刷新本機目錄，不更動速度；不豁免其他 slash、模板、帶參數或圖片的訊息。

## 驗證

Ultra Fast 契約依 OpenAI 官方 [Codex speed](https://developers.openai.com/codex/speed) 與 [API Ultrafast mode](https://developers.openai.com/api/docs/guides/ultrafast-mode)，以及本機 0.163.0 app-server 生成 schema 的 string `ModelServiceTier.id`／`serviceTierForTurn`。方案、模型名字或文件中的一般資格不是此帳號的授權，仍要求原生 catalog 的具體 offering。Pi／Claude／Magpie 未擴大 Ultra 支援，直接選擇或排隊注入均拒絕，不偷偷當成一般模式或 Fast。測試僅使用 synthetic control／catalog／payload，沒有 Ultra 付費實測、served tier 或實際計費保證。

原生 backend 額外證據：官方 Magpie v0.1.1294 `codex_backend.go` 的 `CodexPath`／`codexAccounts` 明確將無 slash 原生模型對應到 Codex owner 的 `codex/<model>`；`codex_backend_test.go::TestCodexOwnModelPassesThrough`、`fast_test.go`、`codex_opencode_fast_test.go` 證明 Responses tier 欄位轉送。此對應不是 prefix 猜測，且仍要求雙方新鮮 catalog 具體宣告 priority。全域 tier 覆寫、帳戶路由或 fallback 仍可能改變 served tier，不能以此聲稱實際計費 Fast。

Magpie 證據：官方 `yetone/magpie` v0.1.1294 的 `models_tiers_test.go`、`fast_test.go`、`codex_opencode_fast_test.go`、`own_tier_test.go`、`tier_record.go`；本機 catalog 的 codex/gpt-6.1-sol 等列確實有 snake_case `service_tiers`（初次只抽前幾個 MiniMax 列不足以判斷全部目錄，已更正）。自有服務只向既有 origin 讀 metadata，不接受 body/query 提供 base URL。

無真付費模型呼叫。合成測試覆蓋 wire 參數、false/off/未知 tier、舊 runtime、代理、拒絕、冷卻、timeout、缺欄位、重新載入、排隊及付費預設隔離。原生無推論探針使用臨時 HOME：Codex 0.163.0 回讀 thread tier default；Claude 2.1.308 完成 true → effective true → initialize on → false → effective false；Pi 成功完成 owned extension 的 handled／nonce／branch 回讀。另以已安裝 Pi OpenAI Responses adapter＋mock fetch 攔截實際請求：Fast 帶 priority，standard 無 tier，reasoning.high 不變，沒有真網路呼叫。

瀏覽器案例：`scripts/agent-speed-browser-cases.mjs`，使用現有 native composer fixture、真共用 route/store/queue；Chromium/WebKit、1280/390，檢查 HTTP 選擇/回讀、queue 快照、重載、費用確認、失敗 rollback、模型撤銷、鍵盤焦點及未知 Agent，而不只檢查按鈕。

2026-10-22 OneStep-MacMini：獨立審查的 Claude 缺 metadata 自動排隊、Pi 忙碌純控制指令兩項已修；新增 regression 先失敗再通過。完整單元 2848 passed／5 skipped／0 failed，7 項 checks 通過；完整 Chromium rolling 6 組、124 筆 passed 紀錄（含已納入持續回歸的 native／Magpie 速度案例）；速度專項 Chromium／WebKit 8/8。Codex queue 測試原先把淡出的舊 chip 當新訊息，現改等指定的非 leaving chip 入列，仍保留完整派送斷言。

額外把整套舊 queue 案例搬到 WebKit，桌面 Pi→Claude 切換會產生 protocol handshake access-control pageerror；相同測試在未改功能的 v3.9.44 與候選版皆重現。Codex queue 的 WebKit 案例通過；這項舊 suite 的 WebKit 問題尚未定位，不能宣稱所有 WebKit 佇列案例全綠。

所有測試命令均清除 `STEPSEMBLE_CODEX_NATIVE`、`STEPSEMBLE_CODEX_NATIVE_MUTATIONS`。本輪 log／截圖位於 gitignored `.tmp-cua/agent-speed/`（最新 `npm-test-parent-final.log`、`rolling-parent-final.log`、`browser-parent-final.log`；額外 WebKit 對照 `queue-webkit-compare.log`）。功能驗證未變更全域設定、憑證或已安裝 Agent。尚未使用真付費推論驗證 served tier、Magpie 回退或 CLI 原生子代理的費用繼承；Pi 其他後置 extension 若改寫路由仍是限制。

## Cross-tool dispatch evidence (Magpie 0.1.1330)

The matching public tag tree is `e00fbdbbc74f9829027a78769cbeb265d6271fb4`. `anthropic.go::parseAnthropicRequest` retains the exact Model and maps speed fast to Request.Fast; `chat.go::parseChat` retains Model and maps priority to Request.Fast; `responses.go::buildResponses` translates Fast into priority for ChatGPT/OpenAI upstreams. `native_endpoints` describes the model's upstream protocol, so the same exact Codex offering can authorize known Messages, Chat and Responses input translations. Each input API and path has a separate confirmation fingerprint; this contract does not authorize other owners or group/virtual models.

Claude's Aqua helper returns its actual child's non-secret routing and capability environment through the authenticated private stream READY frame. Host/SSH environment cannot authorize the child's route. Older helpers without this receipt cannot offer paid Fast. Every verified runtime refresh reads effective native settings before classifying an official or gateway route; failed discovery closes paid authorization. Capability changes use native `apply_flag_settings.settings.env`, preserve unrelated capabilities and explicit negative restrictions, and are read back before flags are trusted. Standard clears the flag and restores the capability string added by Stepsemble. These changes are process-local; no installed/global configuration is written. GET does not apply a paid flag. Model changes, revoked metadata, replaced owners and uncertain controls invalidate dispatch authorization. Native on verifies requested Messages dispatch; the gateway's served/billed tier remains unknown. Pi chooser changes and failure rollback carry the expected durable conversation ID into its serialized lane and owned command, so a queued session switch cannot apply either Fast or Standard to another conversation.

Reproducible synthetic boundary checks:

- `scripts/check-native-claude-magpie-speed.mjs /absolute/path/to/claude`: disposable HOME, fake API key, local fake Messages and synthetic offering. Actual Claude 2.1.308 through both direct and Aqua-helper transports sends Standard/Fast/Standard with speed absent/fast/absent, unchanged exact GPT model and High effort. The helper test deliberately supplies conflicting Host capability restrictions to verify child ownership. It exercises the authenticated helper stream with an isolated synthetic desktop-context check; it does not verify the installed launchd job or a physical Aqua login session.
- `scripts/check-native-pi-magpie-speed.mjs /absolute/path/to/pi-ai/dist`: actual installed Pi 1.4.0 SDK adapters plus the owned extension and injected fetch capture Responses/Chat/Messages Fast/off, exact endpoint, reasoning and Anthropic beta. Revoked metadata aborts all three adapters before fetch. No network, credential-file reads or installed writes.

Native CLI internal subagent inheritance remains the existing disclosed cost-confirmation limitation. Stepsemble does not copy paid preferences into unrelated sessions, workflow defaults or external subtasks. Hermes remains blocked by concrete shared-session busy mutation, non-atomic tier/prompt dispatch, misleading config.get off readback and reconnect identity/retry issues; an arbitrary build-hash or universal native-subagent noninheritance policy is not required. Native Pi ChatGPT now uses its own account-bound producer and delegated SDK boundary described below. Claude subscription and unverified ACP/OpenCode paths remain unknown. These checks prove requested dispatch, not account entitlement or actual billed service.

## Pi native ChatGPT: request-bound OAuth (Pi 1.4)

The owned extension reads credentials only through Pi's normal `ModelRegistry.getApiKeyAndHeaders` / OAuth APIs. It never reads Codex auth files or sends credentials to Host. Every capability check and paid request makes a fresh, uncached GET to `https://chatgpt.com/backend-api/codex/models?client_version=0.163.0`, using that Pi account. The whole discovery (including auth awaits) is bounded to four seconds and the streamed body to 2 MiB. Redirects, non-200, aged responses, malformed/duplicate exact model or tier rows, missing priority, conflicting auth/routing headers, proxy/environment overrides, account changes and discovery failures close paid authorization. No plan/model-name entitlement heuristic is used. Only a process-local HMAC account+subject/model/route fingerprint and safe capability fields enter receipts; restarting/reloading requires new consent if the fingerprint changed.

**Why a provider wrapper is necessary:** Pi resolves the request credential before `before_provider_headers`; that event does not expose the key. The Codex adapter captures key/account before `onPayload`, then constructs authoritative Authorization/account headers afterward. A second registry lookup in the extension hook cannot identify that captured credential. The scoped complete-Provider wrapper therefore delegates the original SDK `stream` / `streamSimple` unchanged, and finalizes the payload after all ordinary extension hooks using the exact captured request options. A fresh lookup also rejects account switches across discovery. Model/session/generation/preference/signal checks prevent stale discovery, cache warming, unrelated calls or queued ownership changes from applying Fast. `ctx.abort` plus the SDK callback rejection prevents inference on failed paid revalidation. Standard clears `service_tier` and the SDK serviceTier option without depending on successful auth/catalog discovery; unrelated headers and model/reasoning remain untouched.

**Narrow compatibility seam:** the public registry lacks an uncomposed built-in accessor. The wrapper reads `registry.runtime.builtins.get("openai-codex")` (never credentials through private fields), with shape and registered-provider ownership guards. Wrapping `getProvider()` would double-apply models.json; constructing a fresh static provider would discard Pi's remote catalog. Delegating the existing built-in retains OAuth/login/refresh and remote catalog, while normal configuration is applied exactly once. Another extension owning/replacing this provider, missing seam or missing public SDK cleanup keeps paid support closed. No SDK/installed/global files are modified.

**WebSocket credential binding:** Pi pools sockets by session+account, not access token. After successful paid revalidation, the wrapper calls the public `cleanupSessionResources` with only the exact nonempty durable session ID, before native acquisition. It is imported through Pi's official static root namespace alias/virtual module, so bundled CLI and extension share the same resource registry (a separately imported unbundled adapter would be wrong). The installed SDK registers its Codex socket pool there. Every delegated native call, including warming/nested calls, is tracked until its result completes. If another call for that session is still in flight, paid dispatch aborts without cleanup; other sessions are untouched. Initial ownership requires idle context. Shutdown with unfinished calls retains a retired wrapper instead of losing accounting; paid use then needs reopening. Transport, cacheRetention and sessionId are never forced or rewritten. As with all Pi extensions, arbitrary additional trusted extensions can execute in-process; incompatible runtime/resource semantics require revalidation, not silent authorization.

Validation: `test/pi-native-speed.test.mjs` covers exact offering, account/route/model/session races, captured-A versus lookup-B, token refresh, malformed/stale/bounded discovery, secrecy, Ultra rejection, Standard recovery, lifecycle and noninheritance. Existing Pi receipt/lane/queue/CAS regressions remain in place. `scripts/check-native-pi-chatgpt-speed.mjs /absolute/path/to/pi-coding-agent/dist/bundle/cli.js` runs the **actual bundled Pi** in unique private temporary HOMEs with fake OAuth and injected fetch/WebSocket only. SSE, WebSocket and auto each prove Standard → Fast → Standard, exact `gpt-6-astra`/xhigh, configured-header command evaluated once, preserved catalog/auth/refresh, warm old-token socket replaced by the refreshed credential, other-session socket retained, same-session busy socket not closed, revoked dispatch aborted and Standard recovery. Existing browser native cases now exercise Pi's native producer through the real shared speed routes; Magpie cases retain their own fixture. These are requested-wire proofs, not served-tier or billing evidence. Neither ACK nor `service_tier: default` proves served Fast or failure; effective remains unknown.

Native Pi review hardening: authorized Fast inference uses a request-local wrapper around the SDK's resolved fetch implementation. It accepts only the exact official `/backend-api/codex/responses` endpoint and sets `redirect: "error"`; this also covers auto's native SSE fallback. Standard delegates unchanged fetch options. No global fetch replacement, transport rewrite or copied SDK is used. Native failure side effects recheck the captured valid signal, durable session, model and runtime generation: a stale callback rejects its own SDK request but cannot abort or append a receipt into a replacement turn. Cleanup failures, incompatible delegates and the native fallback hook use the same ownership guard; Magpie behavior is unchanged.

`test/pi-native-speed-boundaries.test.mjs` permanently covers both review findings. The bundled CLI check additionally exercises synthetic 307/308 Fetch semantics on SSE and actual auto→SSE fallback, verifies no redirected target receives the paid body/account header, and verifies Standard recovery. Its stale-owner probe uses the actual bundled delegate with an isolated synthetic lazy context, not two live user turns. These are deterministic injected-transport tests, not real internet redirect or paid inference probes.
