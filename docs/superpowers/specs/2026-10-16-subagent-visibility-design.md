# Subagent 可見性

## 已確認範圍

使用者同意：session 派出 subagent 時，在輸入框上方顯示氣泡；點開列出每個 subagent，再點名字可查看它的詳細過程。只讀，不提供單獨停止。沒有原生 subagent 資料的 agent 不顯示氣泡，也不推測。

## 使用行為

- 當前這一輪有 subagent 時，輸入框上方顯示「N 個 subagent 執行中」；全部結束後改為「N 個 subagent 已完成」（有失敗時一併標示），保留到使用者送出下一則訊息。
- 點氣泡開啟清單，每列顯示名稱或角色、任務第一行、狀態（等待／執行中／完成／失敗）、已執行時間，以及 agent 有提供時的目前動作。巢狀 subagent 以縮排顯示在父項下。
- 點名稱開啟詳細面板：桌面版從右側滑出，手機版從下方滑出。內容為完整任務、即時工具紀錄（收合方式與主對話一致）與最後結果。
- 對話紀錄中的 subagent 工具卡片也能開啟同一個詳細面板，舊 session 也能回頭查看。重新開啟的 session 依已儲存的紀錄還原：Pi 由 Host 隨歷史附上 `pi-subagents` 結果的精簡版本（不含子對話訊息）；Claude Code 與 OpenCode 用該工具呼叫的參數與結果。Claude 背景 Agent 的已存結果只表示已啟動，狀態顯示「已啟動」而非完成。這類面板註明來自已儲存的對話，不顯示紀錄沒有的時間；氣泡只反映本畫面即時看到的這一輪。
- 鍵盤可操作；面板可用 Escape 關閉，焦點回到原處；11 語系。

## 各 agent 資料來源

- Claude Code：`Task`／`Agent` 工具呼叫的 `subagent_type`、`description`、`prompt`；`parent_tool_use_id` 相同的事件屬於該 subagent；對應的工具結果代表結束，結果為錯誤即失敗。
- Codex：`collabAgentToolCall`（`spawnAgent` 的任務、`receiverThreadIds`、`agentsStates`）與 `subAgentActivity`；子 thread 的 `source.subAgent.thread_spawn` 提供暱稱、角色、深度與父 thread。詳細內容以 `thread/read`／turns 讀取子 thread。實作前先用真實 Codex 確認目前連線能否收到子 thread 的即時事件；收不到時改為開啟面板期間定時讀取，並確保子 thread 的通知不會讓父 thread 的連線失敗。
- OpenCode：`subtask` 訊息部分與 `/session/:id/children`；詳細內容讀子 session 的訊息。
- Pi（`pi-subagents`）：`subagent` 工具的 `tool_execution_update` 進度（`details.progress[]`：agent、task、status、currentTool、recentTools、recentOutput、tokens、model、durationMs、error），結束時的 `details.results[].messages`。背景模式只顯示工具回傳前已知的狀態，並標示「背景執行」。
- 其他 agent 沒有可靠的原生資料，不顯示。

## 架構

- 前端新增獨立模組，把各 agent 的事件正規化成同一份清單：`{ id, parentId, name, role, task, status, startedAt, endedAt, activity, model, tokens, result, source }`。只處理當前連線與畫面世代的事件，切換對話或 Host 時清空。
- 氣泡、清單與詳細面板是同一模組的介面元件；`app.js` 只負責接上事件來源與工具卡片的點擊。
- 需要讀子 thread／子 session 的 agent（Codex、OpenCode）新增唯讀 Host 路由，以工作區 entry 驗證所屬關係，只允許讀取該 session 的子項，回應有大小上限。

## 驗證

- 單元測試：四種 agent 的事件正規化（含巢狀、失敗、背景、重播事件不重複）、氣泡文字與狀態轉換、跨對話隔離、詳細面板資料。
- Host 路由測試：只能讀取所屬 session 的子項，拒絕其他 thread／session，回應大小有界。
- 真實 CLI：以隔離 HOME 與本機假模型 API 驗證 Claude Code 與 Codex 的 subagent 事件形狀；Pi 以 `pi-subagents` 的實際進度格式做合成測試。
- 隔離瀏覽器：桌面與手機的氣泡、清單與詳細面板。
