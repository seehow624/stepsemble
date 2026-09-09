# 大型歷史：Host／Web 分頁接線

2026-09-09／Plan1.74；接續[受限分頁管線](codex-page-pipeline.md)。
大型legacy plain Codex歷史已進入實際Host、peer與Web；**不是完整原生語義、
跨頁全域結構或C2完成**。正式3.0.6／devrc.7／B+／私人來源、讀者、帳號與部署關卡
不變；獨立72h未查未改，不將其證據轉給新版本。

## 產品契約

- 保留小型／壓縮來源的舊可讀回合與raw格式。Web只在fresh讀取收到
  `source_too_large`或`rollout_record_limit`後，以新request ID明確選
  `profile: codex_validated_page_v1`並顯示大型載入提示。最多一次格式協商，
  不重試busy／auth／timeout／損壞／版本改變／cleanup unknown，也不替續頁換版本。
- 新profile使用原`readNamedPage`／v11 helper／v8 parser、同兩reader與五階段
  source/name fence；10s pipeline、15s HTTP、撤銷與actual-close quarantine不變。
  第一次開啟大檔最多兩個依序有界請求；續頁直接用新格式，無新pool／queue／grant。
- Public history kind為`codex_validated_source_records`，record kind為
  `codex_validated_rollout_records`，scope為`one_legacy_rollout_validated_page`。
  profile與三種kind/scope必須匹配；新來源上限256MiB／262144筆，單筆128KiB、
  最多50筆／272KiB頁、384KiBresponse不變。舊caller仍8MiB／8192筆並拒新DTO；
  新profile亦拒舊DTO、structured:true、假structure或authority提升。
- Opaque版本綁定來源及profile，不可混用；registry／HTTP／typed transport／peer
  全部傳遞及驗證。Claude來源不接受Codex profile。metadata公開形狀不變：
  fresh legacy名稱只有在舊大小限制且實體收尾後，才切page-capable names；
  Host另核新named version、選定來源、名稱，不能盲信factory成功。
- 大型對話檢視顯示每筆完整文字、来源明示角色與Codex logo；未知／工具／rollback
  原文不丟失。尚無全域turn/tool關聯直接標示，不把頁內角色冒充全來源結構。
  Raw模式仍短預覽＋惰性完整JSON。Web一頁10筆、只留一頁；新增「紀錄編號→前往」
  可跨8192筆直接跳轉。11語切換不重讀或清除輸入；stale/busy停用跳轉，取消/關閉可用。

## 本機證據

- 完整與最低Node22.19各**1057total／1055pass／2skip／0fail**；新9個具名case
  與一個shared fixture載入，focused38通。驗profile／版本／oldclient／9000offset、
  metadata原名、撤銷／清理、協商取消及禁止其他錯誤重試。generatedclient/protocol、
  Ajv1251／version／actionlint通；原始失敗logs保留（測試缺結束括號、timeout文案
  未映射已修），沒有skip或放寬斷言。
- 真Rust→受限parser→完整server.js→HTTP→同Web model：**17,155,120bytes／16384筆**，
  first/next/previous/10000/16380末4筆、原名及全文尾標記通；append使舊version失效、
  refresh16385筆；rename一致，第10000筆壞掉第一頁也拒絕、修復恢復；raw切換維持profile。
  舊39raw、23結構/3回合、冷DB、壓縮、paginated拒絕與失敗清理也回歸通。
  最後另驗1,494,884bytes但16384筆的來源，確實由舊「筆數」限制切入新profile，
  不是只有檔案超8MiB時可用。
- 兩輪相同owned workload各17次內容請求：max單次3.25／3.20秒；讀取期間每輪161個
  health樣本，p95 **1.39／1.76ms**、max3.49／3.29ms；200ms取樣Host RSS最高
  **91,455,488／93,061,120bytes**。這是Mac Mini debug helper、17.2MB單來源，
  不是peak RSS、256MiB容量、SMB、混合負載或跨平台保證，不據此放寬deadline。
- Codex Computer Use真owned Host：390/320px無横溢；320px長文內層224px、
  scrollHeight8307，PageDown inner180而outer仍1679。完整尾標記、logo、語言切換
  保留16381輸入、末4筆／EOF、追加version拒絕、重新整理、關閉清空及errorlogs空通。
  一次工具等待新max先逾時，後續只讀確認loaded/max16385/warning hidden；不把此
  等待當產品通過，也無重送該請求。不是實體手機或CWV測量。
- Apple Design用於可中斷取消、原生內捲、輸入及標籤分離；未加動畫或改B+。
  所有測試皆自建來源、0private/model/native session/login；瀏覽器尺寸重設並關tab，
  每輪Host/writer已退出、兩owned目錄移除，來源未被產品讀取路徑改動。

Logs `/tmp/stepsemble-large-web-{full-final,minimum-final,focused-final3}.tap`及
`owned-{first,measured1,measured2,final}.log`。

## GitHub 證據與保留的失敗

工程`087102f6165a568ab72b5b510c980ff95fe33911`：
[一般測試](https://github.com/seehow624/stepsemble/actions/runs/34319968916)、
[Claude契約](https://github.com/seehow624/stepsemble/actions/runs/34319968919)、
[Codex契約](https://github.com/seehow624/stepsemble/actions/runs/34319968928)、
[reader安全邊界](https://github.com/seehow624/stepsemble/actions/runs/34319968934)通，完整logs已核。
三OS一般1057/0fail（Mac2／Linux3／Windows50skip，不冒稱原生Windows支援）。
POSIX真Host皆17.2MB/16384筆、舊筆數限制協商、名稱／版本／損壞及actual cleanup通。
CI Mac最大單次5.32秒、health p95 3.78ms、取樣RSS93,782,016bytes；Linux3.99秒、
2.34ms、115,281,920bytes，仍只是單來源owned workload，不是最大容量保證。

[原瀏覽器run](https://github.com/seehow624/stepsemble/actions/runs/34319968902)保留失敗：
Linux六組全通，Mac四組通後在worker開始約300秒被共同程序期限終止，未輸出頁面斷言失敗。
舊runner把所有core／sources／Codex案例放同一個五分鐘worker；新增大檔後矩陣超出
總預算。現在拆三個順序、獨立browser worker，每組仍300秒、CI job仍12分鐘、
每次UI等待與產品pipeline/HTTP期限不改；所有案例保留、不自動重試。
逾時單獨記錄原因，等實體close再返回，必要時五秒後終止未退出child；新增兩個
分組完整性及timeout/非零退出/成功的測試。**修正後exact CI待核，不把原Mac標成功。**

## 下一段：goal維持active

1. 全來源有界turn/tool/rollback結構接新頁面；不能將單頁交舊whole-file snapshot，
   也不能用可讀原文代替已接受的完整語義與跨頁工具範圍。
2. 大型壓縮、paginated/native投影、Windows原生來源與其他harness依真實能力接續。
3. 真機、最大來源／混合負載／RSS峰值及[C1–C8](web-completion-loop.md)的session、
   approval、登入、持久化、發布／回滾關卡；不是只剩72h。
