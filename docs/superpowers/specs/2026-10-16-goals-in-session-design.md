# Goals 回到 session 內

## 已確認範圍

使用者同意：Goal 屬於單一 session，不再有獨立的 Goals 入口；排程保留自己的面板。只改介面，Host 端的 Goal 執行、上限、通知與 API 都不變。使用者接受拿掉後，沒有跨 session 的「已完成 Goal」歷史列表。

## 使用行為

- 側欄上方的「Goals · Schedules」按鈕改成「排程」，點開直接是排程面板，移除 Goals 分頁、Goals 篩選與「新增 Goal」表單。
- session 內的 Goal 列維持現狀：`/goal` 開始、上限設定、即時狀態、暫停／繼續／停止、詳細結果。
- 側欄 session 列在該 session 的 Goal 執行中、暫停或需要處理時顯示 Goal 標記，三種狀態有不同樣式與無障礙文字；完成、停止或失敗結束後不再顯示。點擊 session 列照常開啟該 session。
- Goal 模式的排程照常執行，執行紀錄出現在該排程的歷史中，不再出現在 Goals 列表。
- 開新 Goal 的方式：照平常開新 session 並選好 agent、專案與模型，再輸入 `/goal`。

## 實作邊界

- 標記資料由 Host 從既有的 Goal 執行紀錄算出：`/api/workspace` 的每個 session 列帶 `goal: "running" | "paused" | "attention"`（取該工作區 entry 最新一筆非任務執行）；不新增 Host 狀態，沿用側欄既有的更新，不另開計時器。
- 移除只服務 Goals 面板的前端程式與文案；保留 Goal 列、排程、`/goal` 指令與 Host API。`workspace-goal(s)` 訊息已沒有任何發送端，處理程式一併移除。
- 更新 `docs/goals-and-schedules.md` 與 11 語系文案。

## 驗證

- 單元測試：按鈕標籤與無 Goals 分頁；排程歷史收錄 Goal 模式的執行；標記對應執行中／暫停／需要處理，結束後消失；多個 Host 與 session 不互相混淆。
- 既有 Goal 列、`/goal`、排程與 Host 工作流程測試全部維持通過。
- 隔離瀏覽器：桌面與手機的側欄標記、排程面板與 session 內 Goal 列。
