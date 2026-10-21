# Hermes 助理

Stepsemble 的「助理」頁是 Hermes Agent Bot Mode 的手機優先客戶端。它連到同一台電腦上
Hermes 已在執行的網頁伺服器，讓你在手機或桌面跟每個 Bot 的永久對話（Bot Chat）聊天、
回答 Hermes 的提問，並查看 Telegram、例行工作等其他來源的對話。

## 使用

- 只要已配對的任一台電腦裝了 Hermes，Bot 與群組就和 session 出現在同一個 Workspace 側欄（多台電腦時在「最近」下方），沒有模式切換；
  Workspace 的搜尋同時找 session、Bot 與群組成員。Bot 標題旁是管理 Bot 與新增 Bot，排程旁多一個「所有例行工作」；多台電腦裝了 Hermes 時，
  區塊上方可選電腦（與助理頁共用選擇）。訂閱額度照常顯示。
- 在側欄點 Bot、群組或頁面，和 session 一樣開在左上的主畫面（焦點在空面板時開在那裡），可以和 coding session 分割、拖曳到面板邊緣、移到新視窗。
  同一台電腦的同一個 Bot（或群組、頁面）只有一個面板；面板內的歷史、設定與例行工作都在同一個面板切換，標題列跟著顯示「名稱 · 設定」等，重新載入後回到同一個畫面。
  電腦版的 Bot 面板沒有自己的標題列：標題列顯示頭像與名稱，旁邊是「歷史」，選單裡有設定、例行工作與「更多…」。手機一次顯示一個面板，保留 Bot 自己的標題列，
  返回鍵回到 Workspace 清單。取消新增、刪除 Bot 或解散群組會關閉該面板。
- 第一次打開時，先有三步導覽說明帳號密碼從哪裡來：帳號是第一次替 Hermes 控制台設定保護時取的（預設 `admin`），存在
  `~/.hermes/config.yaml` 的 `dashboard › basic_auth › username`；密碼只存雜湊、查不到；還沒設或忘記時在那台電腦執行
  `hermes dashboard --host 0.0.0.0` 重新設定（忘記時先刪掉 `password_hash` 那一行），再重新啟動 Hermes。登入表單上的
  「去哪裡找帳號密碼？」可以再打開導覽。第一次登入後會跳出四張介紹卡。導覽和介紹各只在每個瀏覽器出現一次
  （記在 `localStorage` 的 `stepsemble.assistant.guide.v1`）。
- Hermes 只在本機、不需要登入時直接進入，不會看到登入和導覽；只開 OAuth 登入的 Hermes 會改顯示說明，請使用者先替控制台加上帳號密碼。
- 有多台裝 Hermes 時，右上角可以選擇要用哪一台；選擇記在這個瀏覽器。
- Bot 需要你核准、回答問題或輸入 sudo／secret 時，卡片直接出現在對話裡，手機會收到推播。
  回覆完成時，如果沒有任何畫面正在看那個對話，也會推播。
- Hermes 不再出現在「新增對話」；以前用 ACP 開的 Hermes 對話仍可照常打開。
- 首頁用列表顯示 Bot、最近對話預覽與時間；搜尋欄可篩選已載入的 Bot 和群組。桌面保留左右雙欄，手機一次只顯示列表或對話。
- 對話頁的返回與歷史操作使用純圖示，保留可及名稱與滑鼠提示；歷史圖示開啟歷史面板，可搜尋、分頁與依日期瀏覽。每列的更多操作提供重新命名及二段確認刪除。
  選取歷史後直接閱讀該對話；重開面板會保留同一個 Bot 的查詢和捲動位置。
- 對話頁返回先回助理列表，不直接跳到工作區；歷史面板或更多選單開著時，瀏覽器返回先關閉面板。
  設定／例行工作返回該 Bot 的對話，瀏覽器前進可還原畫面。直接開對話網址也有助理列表作為返回落點。
- 對話右上角的「更多選項 → 例行工作」（以及名單頁的「所有例行工作」）列出 Hermes cron job：可暫停、立即執行、看執行紀錄、
  編輯、刪除。「同時送到這個 Bot 的對話」會在送達清單加入或移除 `bot-chat`。在這裡新增的例行工作依 Bot Mode 慣例
  命名為 `[bot:<profile>] <名稱>`，預設送到這個 Bot 的對話；既有工作的名稱與其他設定不會被自動修改。
- 例行工作送到 Bot 的對話後，Bot 的回覆是在沒有瀏覽器連著時寫進去的，不會有即時事件。只要有手機訂閱推播，Host 每分鐘比對一次
  各 Bot 對話的最後活動；有變動就讀最新一頁，對 Hermes 標成 `[Cronjob "<名稱>"` 的訊息，把 Bot 的回覆推播到手機，
  標題是「Bot 名稱 · 例行工作名稱」。有畫面正在看那個對話、或連線中已經推過的不再推；Bot 還沒回完的等下一次。
  Host 啟動後的第一次只記下各對話的現況，不補推之前的回覆；沒有任何推播訂閱時不會去問 Hermes。
- 名單頁的「群組」區可以建立 2～6 個同一台電腦 Bot 的群組（Hermes hosted room）。`@名稱` 指名一個 Bot、`@all` 指名全體，
  沒有指名時由 Hermes 決定誰回答。成員需要核准時卡片出現在群組裡；可停止、重試失敗的回合、改名、解散（點兩次）。
  群組開著且畫面可見時每 1.5 秒讀新訊息、每 3 秒讀狀態。Hermes 沒有群組驅動時顯示「需要較新版本的 Hermes」。

- 名單頁的「新增 Bot」建立新的 Hermes profile（可從現有 Bot 複製設定），外觀寫入 `ui_meta["hermes-bots"]`，與 Hermes 桌面版共用。
  每個 Bot 的「更多選項 → 設定」可以改名稱、說明、顏色、圖片（PNG／JPEG／WebP，小於 2 MB）、從名單隱藏、個性（SOUL.md）、
  模型（Hermes 認為較貴的模型要再按一次「仍要使用」才會寫入）、技能、工具組與 MCP 伺服器。外觀以 Hermes 的修訂號比對，
  別處改過時不會覆蓋。刪除 Bot 要輸入它的設定檔 ID，預設 Bot 不能刪除。
- 迴紋針可以選任何檔案；在輸入框貼上截圖，或貼上從 Finder 複製的檔案，也會變成附件。一則訊息最多 10 個、每個 20 MB（和 Telegram 一樣），Host 收得下全部。
  圖片交給 Hermes 的圖片附件，其他檔案（例如 PDF）存進對話工作區、以 `@file:` 交給 Bot。貼上的截圖沒有檔名，會自動取名
  `pasted-日期-時間`；Excel、Numbers、Word 這類同時帶文字和圖片的內容照樣貼成文字。
- Bot 可以像在 Telegram 一樣傳檔案：回覆裡的 `MEDIA:/絕對路徑` 會變成附件，圖片保留比例直接顯示、點一下開啟原圖；照片上方及文件卡片提供開啟、下載、分享圖示，不顯示按鈕文字，保留無障礙名稱與提示。文字檔在手機上以裝置寬度排版閱讀，影片和音訊可直接播放；不安全的檔案類型不提供網頁內開啟。
  分享使用系統檔案分享面板，傳原始檔案而非私人網址，不會先另存下載；需要安全連線與瀏覽器支援，否則分享圖示停用並說明原因。讀檔後若瀏覽器要求新的點擊手勢，提示再點分享圖示；取消不顯示錯誤，離開對話後不再開啟面板。群組及例行工作也適用，手機通知只顯示文字或檔名，不顯示路徑。
- 外觀設定提供 54 款透明背景頭像，第一組為「抽象精靈」8 款（Void、Mercury、Fold、Orbit、Prism、Ink、Bloom、Echo），
  保留「A–Z 字母」26 款、「個性角色」10 款與「元素精靈」10 款。點選即儲存，方向鍵可在四類之間連續選擇；內建頭像沒有底框也不裁圓角，自訂圖片保留外框。
  沒有選擇時，第一個 Bot 使用白色 Void，其餘依序使用 8 款抽象精靈，超過 8 個則循環。新 Bot 的 `avatarIndex` 存於 metadata，改名或清單重排不改變頭像；舊 Bot 依預設 Bot 優先、設定檔 ID 排序補位，讀取不改寫 metadata。
  圖檔是 1254px 原圖縮成的 256px 透明 WebP（`public/assistant-avatars/v1/`，合計約 664 KiB），換圖時改用新的版本資料夾。
  選擇保存在 Bot metadata 的 `avatarPreset`，其他裝置重開 Stepsemble 也會讀到；選內建造型不會刪除既有圖片，仍可切回「使用已上傳圖片」。
  3.9.7 的 20 款向量造型已移除：先前選了舊造型的 Bot 改用上述預設頭像，Stepsemble 不改寫 Hermes 裡留著的舊值，重新選擇時才覆蓋。
- 技能：分類列出、開關、編輯 SKILL.md；技能中心可搜尋、預覽，安裝前一定先做 Hermes 的安全檢查並顯示結果——Hermes 封鎖的
  技能不提供安裝，需要確認的技能要按「我看過檢查結果，安裝」；Stepsemble 伺服器在安裝前會再檢查一次。

- 設定 → Agent 與模型 → Hermes（任一台裝了 Hermes 才出現）打開 Hermes 控制台（`/assistant.html?view=console`）：訊息閘道狀態與重新啟動
  （點兩次）、預設模型與推理強度、輔助模型、備援模型（最多 5 個，可排序）、提供者 API 金鑰、自訂端點，以及 7／30／90 天用量。
  Hermes 本身的更新仍在「設定 → 更新」。
- API 金鑰的值只從頁面送到 Hermes：不寫檔、不進 log、不回傳，送出後輸入欄立即清空；頁面只顯示 Hermes 的遮罩預覽。
  Hermes 設定檔裡的金鑰不會被讀出到瀏覽器，控制台只轉送需要顯示的欄位。訊息平台的憑證留在 Hermes 自己的頁面管理。

## 架構與安全

- 伺服器端模組：`server/hermes-discovery.js`、`hermes-session-store.js`、`hermes-gateway-client.js`、
  `hermes-assistant-service.js`、`hermes-routines.js`、`hermes-groups.js`、`hermes-bots.js`、`hermes-skills.js`、`hermes-console.js`、`hermes-assistant-routes.js`；路由為 `/api/assistant/*`。
- 瀏覽器端：`public/assistant.html` 與 `public/modules/assistant*.js`。跨機器時經由既有的
  裝置轉送 `/r/<id>/api/assistant/*`。
- 只連本機自己的位址（`STEPSEMBLE_HERMES_URL`、`127.0.0.1:9119`、本機各網路位址的 `:9119`），
  不讀取 `~/.hermes` 的任何檔案。
- 只保存 Hermes 的登入 cookie（`~/.config/stepsemble/hermes-session.json`，權限 600），不保存密碼。
  sudo 與 secret 的答案只轉交 Hermes，不寫檔、不進 log、不進事件緩衝；送出後輸入欄立即清空。
- Hermes 的 approval／clarify／sudo／secret 是伺服器對客戶端的請求；Stepsemble 連線後宣告
  `client.capabilities {server_requests: true}`，只回答自己打開的對話；不認得的請求立即拒絕，
  不讓 Agent 空等。核准只接受 Hermes 提供的選項，絕不自動核准。
- 斷線時自動重連，以 `session.resume` 與 `session.events.since` 接回並依序補上漏掉的事件。
- Stepsemble 開啟或重開對話時以 `source: "desktop"` 告訴 Hermes 這是圖形介面，Hermes 才會教 Bot 用 `MEDIA:` 傳附件。
  檔案經 `GET /api/assistant/media?path=` 從 Hermes 自己的 `/api/files/download` 串流取得：只接受這台 Host 曾在 Bot 回覆或群組成員訊息中
  看過的路徑，Hermes 仍套用它的敏感檔案阻擋與 100 MB 上限；Stepsemble 不直接讀那台電腦的磁碟，也不另存副本。
  圖片與影音以 inline 回應並加上沙盒 CSP；文字檔開啟時轉成跳脫後的閱讀頁（同樣在沙盒內，內容不會成為標籤），下載保留原檔；
  PDF 交給瀏覽器內建閱讀器，HTML 與其他類型一律下載；圖片、影音與 PDF 支援 Range，跨電腦轉送也會帶上。
  Bot 的檔案卡片與圖片可以拖出頁面：Chrome、Edge 用 `DownloadURL` 下載到放下的地方；Mac App 的 `WorkspaceWebView` 攔下 WebKit 對這些
  檔案網址的拖曳，拖曳時以頁面的登入下載到暫存資料夾，放下時交出檔案本身（Finder、WhatsApp、Mail 都收得到；`scripts/check-mac-file-drag.mjs` 驗證）。
  desktop 模式的 Bot 也可能寫 `::preview{file="…"}` 互動小工具；絕對路徑會顯示成只能下載的檔案卡片，Stepsemble 不執行其中的網頁。
- Workspace 的 Bot 分頁載入 `assistant.html?embed=1`；只有這個嵌入版允許 Workspace 同源框架，助理頁本身仍不可嵌入。
  分頁的路由只留在分頁記憶體，不寫入瀏覽器歷史；分頁以訊息回報目前頁面、標題與頭像，Workspace 據此更新標籤並保存版面。
  每個分頁有自己的推播 client ID；被切走的分頁不再宣告正在看那個對話，手機推播照常。
  Bot 分頁的版面參照以隨機 UUID 為 key 並帶著 Assistant 路由，Workspace 同步 session 清單時不會移除它，Mac App 的原生分頁拖曳也照常可用。
- 寬表格與程式碼只在自己的區域橫向捲動；圖片依閱讀欄縮放。連續工具紀錄合成可展開摘要，核准卡仍直接顯示。
- Bot 草稿與未送附件依機器／profile／對話分開保留，群組草稿依機器／群組分開保留；只存當前頁面的記憶體，重載後不保留。
  網址與瀏覽器歷史只保存路由識別，不放訊息內容、草稿、附件或敏感答案。
- 重開歷史會以既有唯讀 `session.title` 補上標題；分頁使用伺服器回傳的原始 `nextOffset`，不因濾掉永久 Bot Chat 而錯位。

## 測試

- 單元與整合：`test/hermes-*.test.js`、`test/assistant-*.test.js`，以
  `test-support/fake-hermes-gateway.cjs` 模擬 Hermes 0.22.0。
- 瀏覽器：`node scripts/assistant-browser-cases.mjs <Playwright runtime>`；新手機回歸為
  `node scripts/assistant-mobile-browser-cases.mjs <Playwright runtime>`，兩者均納入 Rolling 的 workspace 套件。
- 附件：`node scripts/assistant-media-browser-cases.mjs <Playwright runtime>`，在手機與桌面驗證圖片、PDF、文字檔與已消失的檔案。
- Workspace 面板：`node scripts/assistant-workspace-browser-cases.mjs <Playwright runtime>`，驗證 Bot 與 session 共用側欄與搜尋、Bot／群組／頁面換掉主畫面、
  標題列的歷史與設定、和 coding session 分割、拖曳、重新載入與推播狀態，以及手機的 Bot 面板與返回。
- 手機回歸涵蓋寬內容、原生瀏覽器 Back／Forward、歷史搜尋／分頁／操作／錯誤、草稿／附件／群組、競態與首次介紹。
  版面檢查包含 320／393／414px、橫向與桌面、深淺主題、繁中／英文／德文及 150% 字級。
- Chromium 模擬手機不等於真 iPhone 或 WebKit；iPhone 主畫面模式的原生左緣滑動仍需實機確認。

## 相容性

以 Hermes 0.22.0 原始碼實作與驗證（Mac mini 現行版本）；0.21.6 與 0.22.1 也宣告了所有用到的方法與路由。
這套 WebSocket JSON-RPC 是 Hermes 給自家桌面版用的協定，升級時可能改變：

- `npm run check:hermes-release`：讀本機 Hermes 原始碼（預設 `~/.hermes/hermes-agent`，或 `--source`），確認
  Stepsemble 用到的每個 JSON-RPC 方法與 REST 路由仍在；`--tag v0.22.1` 可在更新前先檢查已抓取的版本。結果記在
  `~/.config/stepsemble/hermes-release-checks.json`。
- `npm run test:native:hermes`：在裝 Hermes 的電腦上，用助理頁保存的登入唯讀檢查真機（狀態、Bot、對話、例行工作、
  群組支援），只印數量，不送訊息、不改任何設定。
- 0.22.1 新增「session authority」：Hermes 由 gateway 代管網頁伺服器時，`session.*`／`prompt.*` 改由它處理。
  方法名稱都還在，但行為要在真機更新後以互動測試確認。
