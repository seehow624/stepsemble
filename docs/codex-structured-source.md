# 大型 Codex 歷史：全來源結構與 v12 來源接線

2026-09-09／Plan1.75，接續 [大型 Web 分頁](codex-large-web.md)。
**本段的新跨頁結構尚未接入 parser、named pipeline 或 Web**，不是 C2 完成。
原大型逐筆文字／跳頁、小型與壓縮來源回合檢視保持原契約；正式 3.0.6／dev rc.7／B+ 不變。

## 契約與邊界

- Rust `codex_rollout_structure` 在同一來源兩次完整掃描中建立有界回合、工具及 rollback
  關聯，最多 262144 個緊湊 entries，只留下選定頁 annotations／原始 native ID。
  完整 SHA-256 僅作內部查找鍵，不顯示成 native ID；未知原文不丟失。
- 同名多回合不猜配對；工具按回合世代、family、完整 call ID 區分。頁外重複 begin/end
  撤銷原配對，rollback 後重用 ID 不復活舊工具。歷史 lifecycle 不代表目前正在執行，
  request 不是 approval receipt。
- 新 v12 kind `native_codex_structured_source_page`、profile
  `codex_legacy_selected_structure_v1`、`codex_structured_source_version` 與 v10/v11 分開。
  所有 authority／semantic-complete flags 保持 false，不升級舊 receipt。
- 同 POSIX held-root／FD、owner/mode/ACL、name edges／index 存在性、兩輪 digest 及
  actual close；新 helper method 共用原 admission、取消、quarantine、期限，不建新 pool。
- header 16KiB，body 為 raw page（50筆／256KiB）、name index（8MiB）、structure JSON
  （獨立512KiB）三段，逐段 offset／length／hash 加全 body hash。source 仍限
  256MiB／262144筆，每筆128KiB。512KiB sideband **不是** public／parser 的回覆預算。
- Windows 私人來源仍 unsupported；pure-core/wire 測試通過不等於 Windows source 支援。
  本段不新增私人 roots/readers、登入／路由／模型使用或正式部署授權。

## 審查與回歸

Sol High 獨立審查重現 matching pass 的 task start 變動會先報 `InvalidStructure`，
而非來源競態。保留 red regression 後，改為先收候選 ID、完成整檔 digest 比對，再確認 ID；
同長改 ID／malformed start 都回 `Changed`。另一項大回退取消延遲，改每256次 pop 檢查
同一 caller checkpoint；262142回合的取消測試驗證尚未發布的索引會中止。不加重試／timeout。

新 Node wire 審查亦修正巢狀 getter、Windows version 自檢路徑、合法 end-before-begin
工具紀錄誤拒；另外明訂 header cap、配置前的三段 native-buffer 上限／非共享記憶體，
拒 malformed nested shapes 與 prototype-family 名稱，避免異常輸入觸發例外或額外配置。
9個具名 v12 測試覆蓋正常、反向配對、最大 ID sideband、EOF、偽造及取消／quarantine。

## 本機證據（不是正式部署）

- 完整與最低 Node22.19 各1068 total／1066 pass／2 skip／0 fail；舊來源／parser／Host
  契約回歸。generated client/protocol、獨立 Ajv1251、version 與 actionlint 通過。

- Rust all-targets：30 lib／46 binary／10 envelope／11 structure／15 scanner 全通，
  fmt／Clippy warnings-as-errors 通過。包含前／中／後權限、來源與 index 變動拒絕。
- 最低 Node22.19 純資料差分：174資料組／2565選定頁，原文、ID、回合、工具、rollback、
  warnings/cursor 與舊 JS 小型契約一致；174 children reaped。
- 真 Node→release Rust：17,017,392bytes／16384筆，first／9000／10000／last／EOF，
  雙向跨頁配對、頁外 duplicate 撤銷、損壞不回半頁／修復、舊版本與 root/sentinel 隔離通。
  首輪19 spawned／19 reaped／0 remaining，1個自建目錄清理；max read約480ms。
  這不是 Host、手機、SMB 或混合負載效能承諾。
- Generated allocation：256MiB長文／262143個獨立回合／262142個不同工具。
  後兩者 requested-live peak 約50.3／64.0MB，選定頁保留約63–70KB，釋放回基準；
  **不是 RSS 或整個 App 記憶體保證**。舊scanner五組allocation回歸通。
- CI 新增三平台差分、allocation、嚴格 wire 及真 v12 owned gate。
  **這裡列的是本機結果；本次提交後仍須核對 exact SHA CI，不沿用上一批。**

## 下一段接實際產品

1. 新明確 page-aware parser：傳 raw/index/structure 三段、不開來源讀取權；按完整
   raw JSON＋structure＋envelope 預算縮 prefix，同步 annotations／turns／cursor，保留
   全來源 counts。必測最大 CJK／emoji native IDs、escaping、單筆超限與 EOF。
2. 接原 SQL A→rollout A→parser→SQL B→rollout B，維持兩 readers、同期限、双版本、
   撤銷及 actual-close/quarantine，不另建 side-channel。
3. 明確 public profile／typed validators、保留 raw 相容，Web 才顯示新來源關聯與
   同版本跨頁跳轉；未知／推定／回退不冒充 native 完整投影。
4. 真 owned Host、共享 Claude reader、五階段取消、最大 DTO、320/390px、同 workload
   多輪效能和 exact CI，通過才更新 C2/C6 邊界。

其他 adapter、durable journal、approval/resume、真手機、Windows來源與 C1–C8 仍待。
獨立72h固定 ab227af／2b7f0b6 的結果不能套新程式碼；今晚依
[發布審查](release-review-2026-09-09.md) 收尾，不把計時結束當最終版本完成。
