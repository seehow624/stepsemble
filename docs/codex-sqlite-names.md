# Codex：SQLite 名稱優先順序與原生驗證

2026-09-09／Plan1.62，開發候選仍3.0.7-rc.7，未部署。

## 已完成的範圍

新增`metadata-name.js`，有界解讀caller提供的固定版本SQLite欄位；13組自建資料
透過真Codex0.153.4 API驗證名稱優先順序，補上先前只有index fallback的證據缺口。
**不是讀取真人SQLite的reader，也不是Codex完整歷史或Host/Web已接通。**

[官方App Server文件](https://learn.chatgpt.com/docs/app-server)區分`thread.name`與
read/list/turns，也說明read不等於resume。[環境變數文件](https://learn.chatgpt.com/docs/config-file/environment-variables)
說明SQLite可以獨立儲存，config的`sqlite_home`優先於環境變數。本批以固定source
commit`3d2ee51ca2d5db578f328aa75e20aa22c0197c9a`及真binary核對，不用最新版文件
推測固定舊版能力。主要來源是`thread-store/src/local/{helpers,read_thread,list_threads}.rs`
及`state/src/model/thread_metadata.rs`。

## 名稱不是單一欄位

| 類型／狀況 | 原生SQLite候選 | 本批原生API驗證 |
| --- | --- | --- |
| legacy非空title且不等於first user | trim後title | 優先於衝突index；legacy的name欄位不代替它 |
| legacy title空白或等於first user | 無SQLite候選 | 單筆read用原始index候選，list用批次trim候選 |
| title等於rollout preview、stored first user為空 | title仍是distinct候選 | read保留title、list可因preview相同而無name |
| paginated非空name | trim後name | 忽略legacy title與index候選 |
| paginated name為null或空白 | 無SQLite候選 | 不退回title/index；此處只驗metadata |

Rust Unicode White_Space處理與既有index parser共用，保留BOM、移除NEL等原生空白，
不直接用JavaScript trim。資料庫`first_user_message`是NOT NULL字串，native row mapper
把**完全空字串**轉成`Option::None`，不能直接把Rust結構的nullable規則套到SQL欄位。
原始欄位仍保存，不把trim後名稱反寫回去；markup/emoji亦為惰性原文。

`codex_metadata_name_observation`的scope是`provided_sqlite_name_fields_only`。
只接受固定nativeVersion、選定threadId及精確五欄：`id/history_mode/title/
first_user_message/name`。input128KiB、每文字欄32KiB、output128KiB；getter、
多餘欄位、版本/ID/mode不符、無效Unicode或過量資料回unavailable，不截斷。
missing row與已提供欄位分開；它不表示「資料庫尚未讀到也可忽略」。

所有輸出仍`nativeTitleResolved:false/sourceAuthenticated:false/publishable:false`。
**此module只提供SQLite候選，不合成最終native name**；最終選擇還需要可信DB/rollout
模式、preview/index、版本與selected source檢查，read/list不可硬合併。

## 真原生測試如何避免碰到使用者資料

`scripts/check-native-codex-metadata-names.mjs`只接受固定binary路徑，不接受source root。
每次自建新home、13份synthetic rollout、固定測試config/index、獨立sqlite目錄及env
decoy目錄，沿用有界唯讀RPC與本機拒絕模型endpoint，不承接帳號或路由。

1. 真CLI建立自己的schema並scan/read fixture，確認loaded空且actual close。
2. **native程序完全關閉後**，只對此測試DB參數化更新五個name相關欄位，再關SQLite。
   不手寫原生schema；stored first user empty用空字串，不改NOT NULL constraint。
3. 三組paginated metadata案例同時明確retag合成rollout模式；這不是原生paginated
   history store建置，不聲稱其turn/items可用。測試SQL與native無同時連線。
4. 重啟owned CLI，核read前後、10組legacy includeTurns、state-only及scan列表分頁。
   最後單獨探測一次paginated includeTurns，確認strict通道因`deprecationNotice`
   拒絕並結束；不放寬notice allowlist、不把它算完整history通過。
5. native actual close後核五欄不變；15份rollout/index/config bytes除明確fixture
   setup外不變、decoy仍空、DB不在CodexHome，models/private/loaded0、remaining children0。

Node SQLite在最低Node22.19的fixture版本是3.50.4。這裡只操作可信、自建、無並行
的測試資料；**不能將這段程式複用到真實來源或live backup**。固定native的
`state/src/lib.rs`要求SQLite至少3.51.3、含WAL-reset修復。新正式reader仍必須另定
SQLite artifact/version及依賴稽核，不以測試方便為由使用較舊SQLite讀真人DB。

### 已發現並保留的失敗

- 首次fixture把Rust optional first user當SQL NULL，觸發NOT NULL。核原生row mapper
  後改為空字串，並讓pure欄位parser拒SQL NULL；不改原生資料庫schema。
- 第二／第三次在名稱案例中途試paginated includeTurns，strict RPC拒原生
  deprecationNotice，並非預期的普通RPC error。已保留此測試，移到metadata驗證後的
  獨立終止probe，預期明確unavailable；沒有移除unsupported gate或允許副作用事件。
  診斷只留方法／參數key／status type，不dump原生識別資料或訊息。

首三次完整failure logs `/tmp/stepsemble-codex-metadata-native-{first,second,third}.log`。

## 本機驗證

- 4個新unit tests：13規則cases、row缺少／unknown/ID/version、Unicode、getter、
  detached欄位及input/text/output limits。完整Node849＝847pass/2skip/0fail；最低
  Node22.19 reader+Codex聚焦118/118。syntax/TS/generated/version/Ajv1251/actionlint通。
- Node22.19與22.22.3真native各13cases通；22.22.3另5輪通，每輪2個owned native
  processes、15份原檔按預期保留、5欄不變、model/private/loaded0、cleanup確認。
- 原來17個index cases與raw/native投影限制仍保留。新native CI三OS追加13個metadata
  cases；reader聚焦suite增加至118。exact工程CI待push後核完整logs，不先宣稱通過。

主要logs `/tmp/stepsemble-codex-metadata-{full.tap,minimum.tap,native-fourth.log,
native-current.log,native-repeat.log}`。沒有真人模型、私人DB、Host/UI部署或72h變更。

## 接續到產品所需的關卡

- 來源設定必須分開讓owner確認CodexRoot與SQLiteRoot及readers；不能從Host繼承的
  環境變數或讀私人config擅自擴大範圍。
- DB+WAL/SHM一致性與檔案身分、ACL、local filesystem、既有writer不受影響、來源
  改變拒絕；不能把複製單一`state_5.sqlite`或兩次相同metadata當成交易快照。
- SQLite解析依賴須固定／可稽核，採有界背景工作；禁止private source migrations、
  checkpoint或repair。未知schema/mode不能降級成只相信index。
- 只選定row及可信schema、對照rollout thread/mode、绑定source revision；解析結果
  接既有共享admission、binding撤銷、opaque version及HTTP/Web前再驗scope/stale。
- 補壓縮／reference／原生完整歷史、其他harness與C1–C8其餘驗收。正式3.0.6、
  B+、帳號route、私人readers與凍結72h維持，不把本批候選當全產品完成。
