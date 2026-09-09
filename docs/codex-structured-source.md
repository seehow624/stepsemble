# 大型 Codex 歷史：全來源結構與 v12 來源接線

2026-09-09／Plan1.76，接續 [大型 Web 分頁](codex-large-web.md)。
**新跨頁結構已接 parser、named pipeline、Host／peer 與 Web；不是 C2 整體完成或正式部署。**
原大型逐筆文字／跳頁、小型與壓縮來源回合檢視保持原契約；正式 3.0.6／dev rc.7／B+ 不變。

## Plan1.76：接入可操作的 Web

- 新 permissionless parser9／10 只接父程序提供的 raw／index／structure 三段，
  逐段與完整結果重驗；不開來源權限。按 records＋structure 272KiB、含完整名稱
  380KiB、parser envelope 416KiB 同步縮短 prefix，annotations／turns／cursor 一起變動。
  最大 CJK／emoji ID、escaped 名稱、EOF、單筆無法容納皆有明確測試，不截斷原生 ID。
- 沿用 SQL A→v12 rollout A→parser→SQL B→v12 rollout B；同 Host 的兩 readers、
  無額外 queue／pool、單一期限、撤銷、actual close 及 unknown-close quarantine。
- 明確 request profile `codex_structured_page_v1` 與 history kind
  `codex_structured_page_source_records`；structure profile 是
  `codex_legacy_selected_structure_v1`。裡面的 raw page 仍是舊 v11 validated records。
  舊 raw profile、舊小型 whole-file structure 不被暗中升級；opaque version 綁定 profile，
  切換顯示模式重新取得版本，跨頁工具連結則持同一版本。
- 可讀模式只在舊來源明確回 size／record limit 時協商新 profile；不在 auth、busy、
  timeout 或格式錯誤時改協定。保留全來源回合數、原生回合／call ID、頁外 rollback
  及雙向工具連結；推定／未知／已回退仍可核對，不冒充核准、執行狀態或續跑權。

### 本段整合證據

- Parser focused：Node22.22.3／最低22.19.0 各42/42，含受限子程序與舊1–8相容。
- 真 release Rust＋SQL writer＋shared Claude reader：17,017,392bytes／16384筆，
  parser9/10、names、首／中／尾／EOF、雙向3→10001紀錄連結與頁外 rollback；
  五階段取消、來源／SQLite／index 變更與舊version拒絕。最多兩個 physical readers，
  全部 actual close；owned writer 及目錄清理。不是只以 mocked capture 證明來源。
- 真 owned Host＋同一 Web model：17,150,545bytes／16384筆，18次大型讀取，原名／
  全來源結構／原生ID／頁外回退／跨頁往返／原始模式通。第一輪 fixture 漏工具 turn_id
  導致不配對，保留失敗後修正 fixture；未放寬產品配對規則。
- 最後兩輪相同18次read workload：max request255.5／253.5ms，health各28samples
  p95 2.23／2.30ms、max2.31／2.31ms；Host RSS200ms樣本max103,596,032／101,662,720
  bytes。兩輪Host／writer／2owned目錄皆清理。這是本機重複量測，非受控A/B、RSS峰值、
  256MiB／SMB／混合負載容量或使用者體感SLO；與舊17次read不可直接當效能提升比較。
- CUA 實際 Web：390×844、320×740，原始ID、3↔10000（內部零起算）工具導航、
  尾頁未知原文及 rollback、語言切換保留輸入、append 後阻擋舊版本／refresh 恢復、raw
  切換與關閉清頁通。10 cards／頁，無橫向溢出；長文字 PageDown 內捲196→392，
  外頁保持1517px；無 console warning/error。來源 lease 到期要求 refresh 亦已驗。
  這是桌面瀏覽器窄 viewport，不是實體手機背景／網路驗收。
- 完整 Node22.22.3／最低22.19.0 各1085 total／1083 pass／2既有skip／0fail；
  34項 view／真HTTP focused及最大名稱／ID封裝後的公開384KiB驗證通。generated
  client/protocol、Ajv1251、version、actionlint及gitleaks通。
- 兩Node版本各跑真 Rust／Claude SDK共用管線：新結構107次reader/parser spawns，
  整組381次attempts、max physical2／remaining0，五階段取消及全域索引各通；
  數字是巢狀範圍，不能相加。SDK／writer／owned來源均清理，0模型／私人歷史。
- 本次 exact SHA 的一般／Claude／Codex／reader／browser CI 需逐項核對完整 logs；
  結果以該次提交的 GitHub Actions 與 vault 交接記錄為準，不沿用 a4e503e。

### 修正取消後立即重新整理

Sol High審查以fetch已abort但physical reader仍存活的真HTTP交錯重現：再按Refresh會
收到spawn前的`source_busy`而誤標Failed。保留來源fence，新增本flight cleanup pending；
這時顯示取消／清理待確認，不自動輪詢／重試，只有手動Refresh可重試。
next／previous／直接跳轉與工具按鈕皆在UI及model層停用。驗證過的新observation才清
本flight旗標；release=false仍保留舊的unknown提示，release(null)不冒充清理證據。
按鈕有界參照在render cache前更新，不重建cards；假DOM明確驗同一按鈕重新啟用。

新HTTP回歸第一輪失敗是test harness把自動close的parser也當成held helper，誤等
第五次手動放行；改按四個真held helper的stage前進，未延長產品deadline，full suite
已重跑通。這是real HTTP＋受控reader lifecycle，真Rust actual-close另由上方gate證明。

本輪無私人歷史、真模型、登入／route 或正式服務變更。獨立72h不受此 owned Host影響。

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

## Plan1.75 基礎證據（不是正式部署）

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
  a4e503e 的一般／Claude／Codex／reader／browser 五組 exact CI 全通，完整 logs 已核；
  這是1.75證據，不代替1.76的新接線 CI。

## 接線清單狀態

1. 已實作 page-aware parser：傳 raw/index/structure 三段、不開來源讀取權；按完整
   raw JSON＋structure＋envelope 預算縮 prefix，同步 annotations／turns／cursor，保留
   全來源 counts。必測最大 CJK／emoji native IDs、escaping、單筆超限與 EOF。
2. 已接原 SQL A→rollout A→parser→SQL B→rollout B，維持兩 readers、同期限、双版本、
   撤銷及 actual-close/quarantine，不另建 side-channel。
3. 已接明確 public profile／typed validators、保留 raw 相容，Web 顯示新來源關聯與
   同版本跨頁跳轉；未知／推定／回退不冒充 native 完整投影。
4. 真 owned Host、共享 Claude reader、五階段取消、最大 DTO、320/390px、完整／最低
   Node已有本機證據；多輪效能和 exact CI 按上方證據核對，不直接勾 C2/C6。

其他 adapter、durable journal、approval/resume、真手機、Windows來源與 C1–C8 仍待。
獨立72h固定 ab227af／2b7f0b6 的結果不能套新程式碼；今晚依
[發布審查](release-review-2026-09-09.md) 收尾，不把計時結束當最終版本完成。
