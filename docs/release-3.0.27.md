# Stepsemble 3.0.27 release record

日期：2026-09-12  
版本：`3.0.27`

## 這一版完成的內容

- Claude Code：新增 opt-in `claude-cli-stream-json-v1`。使用官方 stream-json／JSONL input／`--resume`，保留 bounded events、native session ID、`parent_tool_use_id` subagent correlation、prompt、close 與 pending permission。未配置 `STEPSEMBLE_CLAUDE_STRUCTURED=1` 時維持原本 CLI connector。
- Codex：保留 `STEPSEMBLE_CODEX_NATIVE=1` 的唯讀 history；新增第二層 `STEPSEMBLE_CODEX_NATIVE_MUTATIONS=1` 後才允許 thread start/resume、turn start/interrupt 與 approval response。所有 intent 先寫 owner-only journal；approval `written` 明確維持 `awaiting_confirmation`。
- Grok Build：新增 opt-in `grok-acp-v1`，使用官方 `grok --no-auto-update agent stdio` ACP，支援 initialize/authenticate/session/new/prompt/update/cancel、bounded session events 與 option-bound permission round-trip。未設定 `STEPSEMBLE_GROK_ACP=1` 時維持 bounded CLI connector。
- Agent Hub：Claude／Codex／Grok 原生 task 都能進入對話頁；Grok permission options 可直接選擇；Claude pending approval 明確顯示必須由 MCP permission-prompt-tool 回覆，不偽造 ACK。
- 可靠性：native adapter 都有 bounded parser、process cleanup、directory allow-list、unknown option rejection 與 restart-safe fallback；不讀取 Claude／Grok 私有 credential/session store，不碰訂閱帳號。

## 驗收結果

- `npm test`：`1286` pass、`3` skip、`0` fail。
- `npm run check`：syntax／desktop／session checks 全部通過。
- `npm run check:protocol:conformance`：通過（protocol corpus 不變）。
- short synthetic soak：`5` cycles、`2` tasks、host restart、雙 SSE client，`cleanupConfirmed=true`。
- 長時間 72 小時 soak 必須在乾淨 commit 上啟動；本次不把短 soak 或 CI 結果冒稱成 72 小時記憶體 certification。

## 明確安全邊界

1. Claude public stream-json 沒有 Stepsemble 可代答的 permission response envelope；`/api/claude/structured/permission` 會 fail closed，必須由官方 MCP permission-prompt-tool 擁有決策。
2. Codex approval pipe write 不是 native approval ACK；journal 會保留 `awaiting_confirmation`，直到上游 evidence 可關聯。
3. Grok ACP permission 只能回答 request 本身提供的 `optionId`；不使用 `--always-approve`，不從模型文字推導授權。
4. Grok／Claude adapter 不掃描私有 session directory。Host restart 後的既有歷史仍走官方 resume／bounded connector，不宣稱跨 process full parity。
5. MBP 若無法以 Tailscale/SSH 完成健康檢查，只記錄為未驗證，不把 GitHub release 當成已部署。

## 啟用方式

```sh
# Claude structured session
export STEPSEMBLE_CLAUDE_STRUCTURED=1
# Optional MCP permission-prompt-tool name (the MCP tool remains the authority)
export STEPSEMBLE_CLAUDE_PERMISSION_PROMPT_TOOL='your_permission_tool'

# Codex read + optional mutation (second flag is intentionally separate)
export STEPSEMBLE_CODEX_NATIVE=1
export STEPSEMBLE_CODEX_NATIVE_MUTATIONS=1

# Grok ACP
export STEPSEMBLE_GROK_ACP=1
```

三個旗標都是 opt-in；移除旗標即可回到原有 bounded connector。升級前請讓 updater 的 active-work gate 通過，保留既有 config/token/session 作為 rollback source。
