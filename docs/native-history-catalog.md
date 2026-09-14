# Claude Code 與 Codex 原生歷史目錄

Stepsemble 現在可以在本機以「唯讀觀察」方式列出並打開 Claude Code 與 Codex
已存在的對話。這項功能只補足歷史瀏覽，不把 Stepsemble 變成兩個官方 CLI 的
替代客戶端，也不授予繼續執行、送出訊息、停止工作或核准工具的權限。

## 使用方式

- 首頁 Sessions 與 **All conversations** 會收到兩個來源的歷史列。
- 每個專案的首頁預覽維持最多三筆；點 **Show more** 才載入該專案的其餘頁面。
- All conversations 維持分頁，每頁最多 50 筆；背景刷新不會在使用者正在閱讀時重排
  目前頁面。
- 打開歷史列後，對話標示為 **read-only**。輸入框、Send、Stop、resume、approval
  與 model 選擇都會被鎖定。要繼續工作，請從官方 Claude Code 或 Codex 客戶端
  開啟原生 session。

## 來源與邊界

在 macOS/Linux，Stepsemble 只讀目前登入使用者的以下路徑：

| Agent | 預設路徑 | 讀取內容 |
| --- | --- | --- |
| Claude Code | `~/.claude/projects/**/*.jsonl` | user/assistant 訊息、工作目錄、時間 |
| Codex | `~/.codex/sessions/**/*.jsonl`、`~/.codex/archived_sessions/**/*.jsonl` | session metadata、user/assistant 訊息、工作目錄、時間 |

可用 `CLAUDE_PROJECTS_ROOT` 與 `CODEX_HISTORY_ROOT` 指向受信任的本機測試根目錄；
瀏覽器不能透過 query parameter 提供檔案路徑。Codex 的 `history.jsonl` 只作為
名稱 fallback，不會掃描 `.codex` 內的其他 JSONL、credential、設定或 cache。

讀取器會拒絕 symlink、hard link、非目前使用者擁有、group/other 可寫、超出大小或
正在變動的檔案。索引只保存受限 metadata；使用者真正打開某一列時，伺服器再以
owner-only、no-follow、兩次完整讀取與 stat identity 檢查取得 transcript。任何檔案
不穩定時，該列仍可顯示，但內容會回報 unavailable，不會讀取另一個路徑作為猜測
fallback。超過完整 transcript 上限的檔案會只讀固定大小的檔案頭尾，畫面會明確標示
部分紀錄未顯示；這不會修改原檔，也不會把整個超大 session 載入記憶體。

## 安全與相容性

這個 catalog 不啟動 Claude Code/Codex、不呼叫 provider SDK、不發模型請求、不接觸
OAuth/API credential，也不修改原生 session。Codex 的原生 app-server 版本檢查與
approval bridge 仍維持原本的安全 gate；本功能的 local rollout fallback 永遠是
read-only，不能繞過該 gate。

索引是 bounded、lazy、single-flight 的：Agent Hub 要求 snapshot 時才掃描，每 15 秒
最多刷新一次，單次等待有 4 秒 deadline；每個 provider 最多檢查 4096 個檔案。完整
transcript 上限為 32 MiB，超大檔案每次只讀 4 MiB 頭部與 4 MiB 尾部；訊息總輸出另
限制為 8 MiB。這讓歷史數量增加時不會阻塞 Stepsemble 啟動，也不會一次把整個
transcript 載入首頁。

Windows 目前不宣稱能讀取這兩個 Unix CLI 的私有 history root；在該平台 catalog
保持停用，官方 agent 的既有 connector 行為不受影響。
