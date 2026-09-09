# 2026-09-09 發布收尾檢查表

狀態：**準備中，不是已發布或全部驗收完成。**

Jerome 要求馬來西亞時間19:34長測結束後大總結及製作最終版本；沿用原排程於19:35
核對報告。若仍 running 就繼續監測，不能按時間判通過。無重要變化保持安靜。

## 長測通過門檻

- 固定 source `ab227af7e12edd7a9182d700ce052dfaf92a34b4`，runtime 與
  `2b7f0b652634a30cb546aceb27339cdad140efc0` 相同，不重建／換 SHA／套用新版本。
- `status=passed`、`continuousObservedMs >= 259200000`、`cleanupConfirmed=true`。
- 8 tasks、每個2 clients、acknowledgementsVerified = cycles×8；正常及強制 Host
  重啟都有記錄。報告遺失／過時／意外中斷不能宣告成功，不憑持久 PID 停止程序。
- 將去識別結果與限制寫回[長測文件](session-discovery-and-soak.md)、主計畫、vault；
  保留報告及失敗診斷，不影響正式服務或其他工作。

## 大總結與版本準備

| 項目 | 必須核對 |
| --- | --- |
| 已上線與候選 | 正式3.0.6、候選確切提交／版本分開；B+保留 |
| 實際功能 | 按[C1–C8](web-completion-loop.md)列使用者可操作成果；核心完成不等於Web已接 |
| GitHub | exact SHA必要CI；保留macOS aggregate timeout等原失敗與修復證據 |
| 可靠性 | 每項測試來源／workload；舊72h不算新版本通過72h |
| 發布判定 | 阻擋缺陷及必要gates處理完才release-ready，否則明列剩餘，不為趕時間跳過 |
| 回滾 | 版本校驗、安裝／資料備份、回滾步驟、部署前active-work檢查 |
| 正式上線 | 依既有owner確認；私人roots/readers、登入／路由／真模型用量不越權 |

合成terminal agents／loopback clients不驗證native history/approval/resume、durable journal、
exactly-once、真手機背景／斷線或完整Rust Host。原生各平台App仍按長期分期，不臨時上架。

先核長測终態及當時工作樹／提交／CI，保存未提交工作；再完成安全可授權的版本說明、
已知限制、候選版與回滾準備。需要owner操作則清楚列出。總結完成或失敗已報告後，
停用本次長測追蹤，不封存對話。最新增量見[v12來源](codex-structured-source.md)。
