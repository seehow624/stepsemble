# 對話速度控制

速度與模型、思考強度分開。新對話不沿用其他對話的 Fast；只有使用者明確選擇的對話保存速度偏好。Fast 可能增加用量或費用，確認視窗亦提醒：CLI 在此對話內建立的原生子 Agent 依其自身規則，可能一併受影響。Stepsemble 不把速度加入 agent.last、工作流程或外部子任務預設；沒有承諾 CLI 內部子 Agent 的費用隔離。

## 契約

`GET/POST /api/agent-speed` 接收 `agentId`、`sessionId`、可選 `model`。POST 使用 `speed: standard|fast`，並帶 GET 的 `revision`；Fast 額外需要 `confirmCost:true` 與能力 `fingerprint`。過期選擇或能力拒絕為 409。保存失敗回 503，不把記憶體值假裝成已持久化。

回應分開提供：

- `support: supported|unavailable|unknown`、`choices`：是否有已驗證的設定契約與目前能力。
- `requested`：該對話的偏好，不等於供應商已提供付費加速。
- `effective: standard|fast|cooldown|unknown`：只有原生狀態足夠才標示有效。
- `reason`、`appliesNextTurn`、`fingerprint`、`revision`：原因、下回合語意、模型/路由重驗與跨視窗比較後更新。

原生 ACK 不是速度保證。排隊保存送出當時的速度與指紋，派送時再次驗證；不能把速度快照塞入既有執行回合的 steer，這類訊息留待自己的回合。換模型/供應商撤銷不相容的 Fast，切回不自動恢復。

## 實際支援範圍

| Agent／路由 | 目前行為 |
| --- | --- |
| Codex 原生 OpenAI | 0.163.0 起的已知 per-turn 契約；原生 `model/list.serviceTiers` 明示 `priority` 或 `fast`，且有效設定/子程序環境確認官方路由才開放 Fast。不是依模型名字的 Fast 字樣。 |
| Claude Code 原生 Anthropic | 此輪實際驗證 2.1.308。模型明示 `supportsFastMode:true`、原生狀態存在、官方路由且無帳戶/政策拒因才開放；`sdk_opt_in_required` 由使用者明確選擇觸發 session opt-in。未知版本不猜支援。 |
| Codex 經已識別 Magpie（使用者主要路徑） | 已接通 requested Fast：Agent 有效設定指向 Host 既有 Magpie service，且同一 service 的新鮮 `/v1/models` 精確模型列宣告 `owned_by:"codex"`、`native_endpoints:["/v1/responses"]` 與 `service_tiers` 的 `priority`。不是任意 loopback 或模型名字推論。 |
| Pi 經相同 Magpie Codex 模型 | 已接 repository-owned extension/RPC；只限 `provider:magpie`、`api:openai-responses`、精確同一路由及上述 metadata。其他 Pi provider／模型仍 unknown；不擴大成所有 GPT 都可用。 |
| 其他 Magpie owner／任意代理 | 未有相同轉送契約證據者維持 unknown。Magpie 可能全域強制 tier 或拒絕後回退，UI 明示 requested 與 served 分離，不修改其全域設定。 |
| Hermes Bot | 共用未知狀態提示與服務回應。未取得部署端 WS 能力證據，沒有用 REST 欄位冒充 WS，也沒有無 session 的 config.set。 |
| OpenCode、Grok/其他 ACP、Antigravity | `unknown`；不把 variants、模式、思考強度或名字當速度能力。 |

未知 Agent/代理不會被 Stepsemble 自動開啟 Fast，也不會被擅自寫入未驗證的關閉欄位；其原有外部設定可能仍適用，UI 明示未知而不是宣稱一般模式已生效。

## 原生派送與失敗

- Codex 新建/續接以 `serviceTier:"default"` 清除已知 native session 的付費預設；每次新回合明確送 `serviceTier:"default"`，以及 `serviceTierForTurn:"default"|<已宣告 tier id>`。付費 tier 不持續寫進 thread 預設。設定/派送回讀與實際供應商服務分開，後者保持 unknown。
- Claude 僅使用 `apply_flag_settings` 的 `{fastMode:true|false}`，不送 `/fast` 使用者 prompt，不更改模型或 effort，不呼叫寫設定檔的 `update_settings`。`get_settings.effective.fastMode` 必須精確相符，再由無 user prompt 的 initialize 握手讀 `fast_mode_state`／拒因；on、off、cooldown 不混用。帳戶拒絕時回復 false；ACK 與讀回不一致會拒絕送出。
- Claude 控制 timeout 可能已套用，故標為未知並阻止後續 prompt，直到重新開啟子程序；晚到 ACK 不能解除此限制。非 timeout 的讀回不符可用明確 standard 握手重新確認。若上一輪 result 缺少速度 metadata，閒置且序列化的 Fast 派送先讀新 initialize，再核對能力／指紋，不依賴瀏覽器 GET；新握手仍未知、拒絕或逾時則不送 user frame。
- Pi 先驗證 `get_commands` 的 extension 來源及自有檔案路徑，才送無模型訊息的 `/stepsemble-speed` 控制命令；handled ACK 不算成功，必須找到同 nonce、同模型身份、有效 leaf 父鏈上的 custom-entry 回執。Host 對同 sid 的設定／讀回／prompt 序列化；不明 set 結果鎖住後續送出，直到重新開啟。extension 在 session branch 還原自己的偏好，模型切換清成 standard；每次 provider request 重新驗精確路由／模型，Fast 寫 `service_tier:"priority"`，standard 刪除該欄位，不碰 reasoning。未知／虛擬模型不附加付費 tier。
- 忙碌中只記下回合偏好，不修改當前付費旗標。每個實際送出的回合仍帶速度快照，重開後保存偏好不等於免驗證授權。Pi 自有 `/stepsemble-refresh-models` 經精確 command 來源／路徑確認後，仍能在忙碌時刷新本機目錄，不更動速度；不豁免其他 slash、模板、帶參數或圖片的訊息。

## 驗證

Magpie 證據：官方 `yetone/magpie` v0.1.1294 的 `models_tiers_test.go`、`fast_test.go`、`codex_opencode_fast_test.go`、`own_tier_test.go`、`tier_record.go`；本機 catalog 的 codex/gpt-6.1-sol 等列確實有 snake_case `service_tiers`（初次只抽前幾個 MiniMax 列不足以判斷全部目錄，已更正）。自有服務只向既有 origin 讀 metadata，不接受 body/query 提供 base URL。

無真付費模型呼叫。合成測試覆蓋 wire 參數、false/off/未知 tier、舊 runtime、代理、拒絕、冷卻、timeout、缺欄位、重新載入、排隊及付費預設隔離。原生無推論探針使用臨時 HOME：Codex 0.163.0 回讀 thread tier default；Claude 2.1.308 完成 true → effective true → initialize on → false → effective false；Pi 成功完成 owned extension 的 handled／nonce／branch 回讀。另以已安裝 Pi OpenAI Responses adapter＋mock fetch 攔截實際請求：Fast 帶 priority，standard 無 tier，reasoning.high 不變，沒有真網路呼叫。

瀏覽器案例：`scripts/agent-speed-browser-cases.mjs`，使用現有 native composer fixture、真共用 route/store/queue；Chromium/WebKit、1280/390，檢查 HTTP 選擇/回讀、queue 快照、重載、費用確認、失敗 rollback、模型撤銷、鍵盤焦點及未知 Agent，而不只檢查按鈕。

2026-10-22 OneStep-MacMini：獨立審查的 Claude 缺 metadata 自動排隊、Pi 忙碌純控制指令兩項已修；新增 regression 先失敗再通過。完整單元 2848 passed／5 skipped／0 failed，7 項 checks 通過；完整 Chromium rolling 6 組、124 筆 passed 紀錄（含已納入持續回歸的 native／Magpie 速度案例）；速度專項 Chromium／WebKit 8/8。Codex queue 測試原先把淡出的舊 chip 當新訊息，現改等指定的非 leaving chip 入列，仍保留完整派送斷言。

額外把整套舊 queue 案例搬到 WebKit，桌面 Pi→Claude 切換會產生 protocol handshake access-control pageerror；相同測試在未改功能的 v3.9.44 與候選版皆重現。Codex queue 的 WebKit 案例通過；這項舊 suite 的 WebKit 問題尚未定位，不能宣稱所有 WebKit 佇列案例全綠。

所有測試命令均清除 `STEPSEMBLE_CODEX_NATIVE`、`STEPSEMBLE_CODEX_NATIVE_MUTATIONS`。本輪 log／截圖位於 gitignored `.tmp-cua/agent-speed/`（最新 `npm-test-parent-final.log`、`rolling-parent-final.log`、`browser-parent-final.log`；額外 WebKit 對照 `queue-webkit-compare.log`）。功能驗證未變更全域設定、憑證或已安裝 Agent。尚未使用真付費推論驗證 served tier、Magpie 回退或 CLI 原生子代理的費用繼承；Pi 其他後置 extension 若改寫路由仍是限制。
