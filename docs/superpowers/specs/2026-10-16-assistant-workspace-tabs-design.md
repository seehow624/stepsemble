# Assistant：在 Workspace 裡開 Bot 分頁（B 方案）

日期：2026-10-16

狀態：使用者看過假資料示意圖後選 B，並說「可以 直接做」。這是實作授權，不是提交或發布授權。
實作與自動化驗證已完成（隔離 HOME 單元測試、瀏覽器回歸、本機 Rolling）；尚未提交與發布。

開發分支：`feature/assistant-workspace`（以 `master` 的 `3e160dd`，3.9.8 為基準）。
附件功能在另一個分支 `feature/assistant-attachments`，兩者分開開發，發布前再合併。

## 1. 目標與範圍

桌面 App 的 Assistant 目前是另一個整頁，看起來像瀏覽器裡的網頁。B 方案讓 Assistant 成為 Workspace 的一部分：

- 側欄的「工作區｜助理」在桌面寬度直接切換側欄內容，不離開 Workspace。
- 助理側欄列出 Bot 與群組；點一下就在目前面板開成分頁，可以和 coding session 左右或上下分割、拖曳、移到新視窗。
- 手機（寬度 ≤ 760px）維持現有的 `/assistant.html` 流程，切換仍是連結。
- `/assistant.html` 本身照常可用（直接網址、推播、Hermes 控制台）。

不改 Swift、不改 Hermes 協定、不新增伺服器 API；伺服器只允許 `assistant.html?embed=1` 被同源框架嵌入。

## 2. 使用者看到的樣子

助理側欄（桌面）：

- 第一列：「工作區｜助理」切換，右邊的按鈕在助理模式改成「所有例行工作」。
- 電腦卡片改成 Hermes 所在的電腦；有多台裝 Hermes 時可以切換，選擇與助理頁共用。
- 搜尋列：「搜尋 Bot 或群組」、管理 Bot、新增 Bot。
- 「Bot」區：頭像、名稱、最近一則預覽；有等你處理的提問時顯示數字。最上方有「等你處理」列。
- 「群組」區：成員頭像、群組名稱與成員；標題列的 + 建立群組。
- 底部的訂閱額度在助理模式隱藏。
- Hermes 沒安裝、沒執行、只允許 OAuth 或尚未登入時，側欄顯示對應說明；尚未登入時提供「登入 Hermes」，在分頁中完成登入後自動關閉該分頁。

分頁：

- Bot 分頁的標籤是 Bot 頭像與名稱；設定和例行工作顯示「名稱 · 設定」等。群組分頁顯示群組名稱，其他頁面（所有例行工作、管理 Bot、新增 Bot、新增群組、等你處理）顯示頁面名稱。
- 分頁內只有對話與輸入框：沒有頂部切換、Bot 列表與返回鍵。標題列保留對話名稱、歷史與更多選項。
- 分頁像瀏覽器分頁：內部可以前往同一個 Bot 的歷史、設定、例行工作，也可以從「等你處理」前往其他 Bot。重新載入後回到同一個畫面。
- 已有分頁正在顯示同一個 Bot（或群組、頁面）時，點側欄會切換到那個分頁，不重複開。

## 3. 架構

### 分頁參照

- Workspace 版面的分頁參照仍是 `{ host, key, title }`，`key` 是 UUID。Bot 分頁使用新的隨機 UUID，另加 `assistant`：已正規化的 Assistant 路由（page、profile、session、room）。
  Mac App 的原生分頁拖曳只接受 UUID，因此 Bot 分頁也能拖到其他視窗或拖出成新視窗，不需要改 Swift。
- `host` 是 Hermes 所在電腦的 ID；`avatar` 存內建頭像造型，讓標籤不用等 API 就能畫出來。
- 版面正規化時驗證 `assistant` 路由，只接受可以放進分頁的頁面：bot、settings、routines、group、bots、newbot、newgroup、pending、home（僅用於登入分頁）。
- Workspace 定期比對 Host 的 session 清單並移除不存在的分頁；Bot 分頁不在這個清單裡，必須排除。同樣排除在「目前看得到的 session」、已讀標記與重新命名之外。

### 嵌入模式

- 分頁的框架載入 `/assistant.html?embed=1&machine=<host>&bot=…&session=…&room=…&view=…`。
- 嵌入模式隱藏頂部切換、電腦選單、Bot 列表與返回鍵；Assistant 自己的路由改用記憶體內的歷史，不寫進瀏覽器歷史。
- 每次路由或標題改變，框架送 `assistant-route`（路由、標題、頭像）給 Workspace；Workspace 更新分頁參照並保存版面。
- 框架照 coding 分頁的慣例送 `workspace-focus` 與 `workspace-select-tab`，收 `workspace-detach`（關閉事件串流）與新的 `workspace-visibility`（分頁被切走時不再宣告正在看這個對話，手機推播照常）。
- 每個框架用自己的推播 client ID，避免同一個視窗內的多個 Bot 分頁互相覆蓋「正在看哪個對話」。
- Stepsemble 登入過期時，由最上層視窗導向登入頁，不在框架裡打開登入頁。

### 伺服器

- `assistant.html?embed=1` 與 pane、Settings 相同，送 `X-Frame-Options: SAMEORIGIN` 與 `frame-ancestors 'self'`；其他情況維持不可嵌入。

## 4. 不做的事

- 不改原生 Mac App、Service Worker 推播導向與 Hermes 控制台。
- 不在側欄重做登入表單、群組管理或 Bot 設定；這些都在分頁內用現有頁面完成。
- 手機版 Workspace 不顯示助理側欄。

## 5. 測試

- 單元：版面參照保留並驗證 `assistant` 路由；記憶體歷史的前進、返回與 popstate；伺服器只對 `embed=1` 放寬框架標頭；側欄模型（Hermes 電腦選擇、分頁參照、去重、標題）。
- 瀏覽器（假 Hermes）：桌面切換側欄、開 Bot 分頁、和 coding session 分割、重新載入後恢復同一畫面、分頁內前往歷史與設定、不寫入瀏覽器歷史、移除不存在 session 的刷新不會關掉 Bot 分頁、手機寬度維持連結。
- 全部使用假資料，不讀真實 Hermes、不呼叫模型。
