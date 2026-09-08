# 唯讀歷史多語言與閱讀位置

Plan 1.56，開發候選 `3.0.7-rc.7`，2026-09-08。這是 C1/C5 的增量，
不是完整 Web、其他 agent 原生能力或正式部署完成。

## 實作範圍

- 實際 Host 的 `history.html` 和隔離 `history-preview.html` 共用 119 個明確 UI key，
  每個 key 都有既存 11 語言版本；包含狀態、錯誤、按鈕、ARIA、數量與顯示上限。
- 沿用工作區／舊版設定的語言。頁首選單只改本頁，不把一份過期的 workspace settings
  寫回儲存，也不改全域預設。重新載入仍沿用工作區偏好，頁面有明確說明。
- 原生名稱、摘要、訊息、時間字串、思考／工具 JSON 及來源管理者提供的 label/description
  是資料，不走文字猜測翻譯；不是把 native 的「Refresh」誤譯成 UI。字數裁切通知另放，
  不混進原文。這不取消既有 10 則 DOM／內容區塊／文字上限。
- 翻譯只更新 keyed 文字及屬性，保留原 DOM、展開狀態、焦點、已讀內容和內層捲動。
  參數有 byte/key/type 上限，單次插值不重複展開值內的 placeholder；不使用 HTML 解析。
- locale 切換不呼叫 read/register/refresh/resume/approval，不載入翻譯服務、字型或外部圖示。
  新字典只在歷史頁載入，不加進工作區首頁的 JavaScript 載入路徑。

## 找到並修正的實際問題

320px 實際 Host CUA 測試在德文→日文時發現約 83px 閱讀位置偏移。
原因是 layout 已套用瀏覽器的 scroll anchoring，程式卻拿翻譯前的 scrollY 再補償一次。
改用 layout 後的當前 scrollY 加 viewport anchor 差；補上該順序的 unit regression。

重新測試使用新的隔離 Host origin，避免同 rc.7 資源 URL 的一天快取干擾；舊 Host
與新 Host 都明確 close，原 fixture bytes 不變，自己的分頁及 viewport override 已清理。
修正後德文→日文差約 0.28px；同一長標題連續 11 語言切換累積差小於 1.5px，
原始標題／正文、焦點及 list scrollTop 不變，沒有橫向溢出，button/select 高度至少 44px。
這是本機瀏覽器的 pixel rounding 證據，不是所有真機、Safari 或所有閱讀位置的保證。

## 驗證分層

- Node 22.22 本機 `npm test`：777 tests，775 pass／2 平台 skip／0 fail。
  新增 9 個多語回歸，既有 history renderer/model 測試同步檢查 keyed 文案。
- 最低 Node 22.19 聚焦 history/i18n：57/57；另有 38/38 history 聚焦修正後回歸。
- strict TypeScript、checked-in client/protocol、syntax、版本同步、actionlint、
  `git diff --check` 及獨立 Ajv 8.20.0／1251 cases 通過。
- 本機 Codex Computer Use：實際 `server.js`＋Rust reader＋固定 Claude SDK 0.3.259，
  64 個 owned synthetic 主對話，320px 十一語、390px 繁中工具／思考六則；console error/warn 0。
  Model calls 0，private history reads 0，兩次 owned Host cleanup 都確認，fixture 未改。
- CI browser 新增 source title 德日捲動回歸，以及 manual 工具歷史 11 語言循環：
  原文／DOM／focus／scroll／workspace settings 保留，數量展開、無橫溢、locale history requests 0。
  Mac/Linux 各 1440/390/320 × 明暗六組；**須依下方 exact SHA 結果驗收，不以 test source 代替成功**。

完整本機 TAP 保留在執行機 `/tmp/stepsemble-history-i18n-final-npm.tap`、
`/tmp/stepsemble-history-i18n-minnode.tap`、`/tmp/stepsemble-history-i18n-scroll-tests.tap`。
第一輪舊 test 的硬編碼中文／VM 缺新依賴造成的失敗也保留，不能把本批修正冒稱
先前 C6 未定位偶發失敗的根因。

## Exact CI

本批程式 commit/push 後另填實際 run 與完整 log 結果；目前不宣稱跨 OS 已通。

## 仍未完成

母語人工校稿、目標真機／Safari／跨 Host、背景恢復與多輪效能仍待；字典完整及回歸
通過不等同語言品質或跨裝置全驗。C1 owner opt-in 體驗、C2 原生 adapter、C3 durable /
approval/session、C4 帳號、C6 偶發失敗／效能、C7 Windows 與 C8 發布門檻仍依主計畫。

B+ logo、私人 root/readers、帳號與第三方模型路由、正式 3.0.6 都不變。
獨立固定來源 72h soak 未改動，其結果不能套用本候選；本批不建立或部署新 release。
