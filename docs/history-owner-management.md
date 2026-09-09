# 本機多來源群組管理與候選驗收

2026-09-09，Plan1.78；開發3.0.7-rc.7，正式3.0.6未變。

本功能補上先前只能建立單一群組的缺口：owner可檢視、新增、替換、編輯及移除
群組，不必直接拼接多份JSON。輸出永遠是**新的未啟用候選檔**，不覆寫來源設定、
不重啟Host，也不把一般history reader變成管理員。C1整體與Web正式發布尚未完成。

## 操作方式

在保存來源的macOS／Linux電腦，以受信任的開發checkout執行：

```sh
node scripts/history-manage.mjs --lang zh-Hant
```

支援`en`／`zh-Hant`；`--help`可非互動查看，其餘要求本機stdin/stderr為TTY。
任一欄`cancel`、Ctrl+C或EOF取消；不是接受貼上的多行批次授權。不要輸入秘密token。
畫面含私人路徑／reader ID，只在本機核對，不貼到聊天、GitHub或公開log。

1. 明確指定既有私有設定檔；列出完整原設定，沒有自選HOME或讀取憑證。
2. 選操作和精確source ID，依下表提供必要輸入。
3. 明確指定**另一個新檔名**作為候選；父目錄須已存在、canonical、owner/private。
4. 核對變更前後、完整結果、每個來源及讀者範圍。只有精確`CREATE`才建立候選。

| 操作 | 行為 |
| --- | --- |
| `list` | 唯讀檢視，不建立檔案 |
| `add` | 從另一份owner指定設定匯入精確ID的單一群組；既有同ID拒絕 |
| `replace` | 以另一份設定中的同ID群組完整替換原位置；可包含明確核對的agent/root變更 |
| `edit` | 完整替換顯示名稱、說明及readers；ID/root/agent/scope不變，不改原生session名稱 |
| `remove` | 只從候選中移除指定群組；不刪原始歷史、不刪原設定、不移除獨立manual catalog授權 |

`add`／`replace`所需的單群組檔可先由
[既有設定精靈](history-owner-setup.md)明確建立；選擇`--agent codex`可建立Codex群組。
匯入檔含多組時也**只取指定ID**；不合併其他群組、手動catalog、origin或readers。
群組數最多8，其他128KiB／256 roots限制仍由相同startup validator檢查。

兩份設定的origin陣列（含順序）及helper必須完全相同，不做默認改寫。兩個不同的
既有SDK路徑拒絕；Codex-only設定補入Claude SDK時，先顯示SDK並要求`ADOPT_SDK`，
再顯示完整候選並要求`CREATE`。最終review是儲存的權威：首次SDK提示後若資料改變，
以重新建立的完整候選review為準；完整review後任何輸入變更則拒絕，不偷偷rebase。
沒有reader的停用設定不得藉匯入自動安裝／取得helper，請先走新設定精靈。

`browser:master`涵蓋持有Host主token的所有瀏覽器；`peer:<grant-id>`授權incoming
Host而非某一個下游人。readers是完整替換，不與原權限做union。此流程不查ID是否
已存在，也不因無效ID而擴成master。Claude main_sessions及Codex stored_threads的
目前／未來來源範圍維持原契約，後者包含封存、subagent、internal及未知origin。

## 安全與回滾界線

- 輸入檔使用bounded/no-follow/fd一致性讀取；input parent也需canonical、owner、
  private。設定檔本身仍需0600-equivalent、single-link、128KiB以内。
- 新候選重新走完整startup parser；手動catalog、其他group及順序原樣保留。
  所有**保留或新增**root比對既有expected dev/ino，不重新stamp來掩蓋路徑替換。
  移除的失效root不再驗，但其他保留root離線／換inode仍拒絕，不能輸出部分有效設定。
- 候選與before/after review皆deep-detached、frozen、single-use，不凍結呼叫端資料。
  commit前後再驗base/import檔身分及內容、parents、保留roots和artifacts；變更即失敗。
- 新檔沿用O_EXCL／O_NOFOLLOW／0600／fsync及startup讀回。競爭檔不覆寫；部分失敗
  只清本次exclusive輸出的同inode，若被換成別人的檔案則保留並明示本機檢查。
- JSON review將終端控制字元／雙向控制符顯示為字面escape。一般錯誤不輸出輸入path、
  內容或秘密；沒有新增Web寫入route、shell任意命令或來源掃描。
- 這是可信Host管理路徑下的偵測，不是對惡意同UID／祖先目錄的OS sandbox；沒有
  目錄fsync／斷電還原實驗，不能當durable journal或原子設定熱載入證據。

**移除／編輯候選不等於立刻撤銷執行中Host的權限。** 原Host仍使用原設定；
正式採用必須經source/readers確認、active-work、備份、受控切換與健康／回滾關卡。
保留原檔能回復原設定，但回滾也可能恢復舊授權，owner需再次核對，不能盲目回切。
本輪沒有熱載入或正式啟用，也沒有修改第三方帳號、模型路由或原生歷史。

## 實際驗收

- 新單元／互動流程涵蓋add/replace/edit/remove/list、v1相容、精確ID／root／origin／
  helper／SDK、讀者完整替換、8組上限、expected identity、input/root/artifact drift、
  不完整寫入、競爭檔保護、取消／TTY拒絕與終端escape。第一輪抓到before/after未detach
  使呼叫端array一同freeze的錯誤，已修正deep copy，保留原失敗TAP。
- 最低Node22.19的真Rust＋固定Claude SDK＋實際`server.js`：管理流程連續產生
  add→replace→edit→remove四份新候選，最後**原檔不再修改**即啟動獨立owned Host。
  所有原設定與中間候選bytes不變，manual4來源保留；master不能讀被限縮群組，指定
  issued reader可讀，移除群組拒絕。首次清單不掃描，明確refresh後4來源、原生metadata／
  訊息ID與內容、release／程序清理均通，`actualManagementGate:passed`。
- 以上為自建合成來源和真Host／Rust／SDK／typed HTTP鏈，modelCalls/privateHistoryReads=0。
  沒有真人owner操作、真手機GUI、Windows private reader或live配置更新證據。
- 另以真TTY逐欄操作繁中edit：顯示原設定、完整before/after、替換readers、空說明、
  確認前候選不存在，CREATE後0600；原設定與合成source bytes不變，owned目錄清理確認。
  終端測試不執行假reader／SDK，也不冒稱原生模型或手機Web管理驗收。
- Native reader CI增加新gate並保留既有Host/setup/Codex鏈；Windows明示unsupported，
  不把一般設定測試或skip當Windows原生來源支援。

完整本機證據：`/tmp/stepsemble-history-manage-*.tap`、`*-native.log`、`*-secrets.log`。

最終本機完整回歸在Node22.22.3及最低Node22.19皆為1124項：1122通過、2項既有
平台skip、0失敗；管理／既有設定focused48/48。語法、client／protocol typecheck、
Ajv1251、版本一致性、actionlint、diff及secret掃描通過。最終完整TAP為
`/tmp/stepsemble-history-manage-accepted-full.tap`及`*-accepted-minimum.tap`，
不以這份成功結果覆蓋下述較早的失敗紀錄。

### 同輪釐清的既有取消測試競態

完整回歸曾有`test/history-codex-host.test.js`取消／refresh案例失敗：期待cancelled，
實際failed。原紀錄保留`/tmp/stepsemble-history-manage-full-final.tap`；它沒有保存
error code，因此不冒稱還原了當時所有底層事件，也不是正式服務故障證據。

可控交錯查出確定的fixture缺陷：它固定cleanupMs=20ms、故意保持helper未close，
卻假設第二次HTTP register永遠在期限前抵達。期限前source_busy應顯示cancelled；
期限後register則正確回source_service_quarantined、stage failed。可控紅保留於
`/tmp/stepsemble-cancel-controlled-red.tap`，不是以20輪偶然全綠當作原因已消失。

現在測試自管這個既有20ms callback的交錯，不改產品deadline或增加sleep／skip。
期限前驗同一實體reader、導航受限、actual close取消deadline及manual refresh恢復；
期限後驗隔離、late close仍不復活且不再spawn。沒有60秒存活dummy timer，測後清queue。
兩案2/2、focused35/35通；只修測試，沒有把quarantine/auth/transport failure洗成cancelled。

本次提交的必要CI需按確切SHA核對；當前結果與失敗交接寫vault，不為記錄文件CI
再製造提交迴圈。C1真人opt-in／受控啟用、Web管理權限與熱載入決策仍有剩餘範圍，
C2–C8、既有B+與正式版本界線不變；不重跑已結案的rc.1 72h。
