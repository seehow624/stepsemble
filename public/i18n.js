/* pi-web locale layer. English is the source language and the safe fallback. */
(() => {
  "use strict";

  const LOCALES = Object.freeze([
    { id: "en", label: "English" },
    { id: "zh-Hans", label: "简体中文" },
    { id: "zh-Hant", label: "繁體中文" },
    { id: "ja", label: "日本語" },
    { id: "ko", label: "한국어" },
    { id: "tr", label: "Türkçe" },
    { id: "fr", label: "Français" },
    { id: "de", label: "Deutsch" },
    { id: "es", label: "Español" },
    { id: "pt-BR", label: "Português (Brasil)" },
    { id: "it", label: "Italiano" },
  ]);
  const LOCALE_IDS = new Set(LOCALES.map((item) => item.id));

  // Existing releases wrote Chinese strings from app.js. These aliases let the
  // new English-first layer translate old dynamic messages without changing
  // session content, prompts, terminal output, or model responses.
  const HAN_TO_EN = {
    "登入": "Sign in", "Token 不正確": "Invalid token", "設定": "Settings", "返回": "Back",
    "返回列表": "Back to sessions", "返回設定": "Back to settings", "更多": "More", "新對話": "New conversation",
    "新對話還沒存檔，先講一句話吧": "This conversation is not saved yet. Send a message first.",
    "切換機器": "Switch device", "新增設備": "Add device", "編輯": "Edit", "刪除": "Delete",
    "重新整理": "Refresh", "切換專案分組": "Toggle project grouping", "搜尋 session…": "Search sessions…",
    "未指定專案": "Unassigned project", "顯示更多": "Show more", "顯示更多 sessions": "Show more sessions",
    "已按專案分組": "Grouped by project", "已切換為平面列表": "Flat session list enabled", "已重新整理": "Refreshed",
    "這台機器還沒有任何 session。": "No sessions on this device.", "點擊 New project 選擇資料夾開始": "Choose a folder from New project to begin",
    "最新": "Latest", "回到底部": "Jump to latest", "加入附件": "Add attachment", "選擇模型": "Choose model",
    "伺服器預設": "Server default", "思考等級": "Thinking level", "停止": "Stop", "送出": "Send",
    "對話工具": "Conversation tools", "agent 執行中": "Agent is working", "從左側選擇一個 session，": "Select a session,",
    "或開一個新對話": "or start a new conversation", "正在整理對話上下文…": "Preparing conversation context…",
    "連線已恢復，工作仍在繼續…": "Connection restored; work is continuing…", "正在恢復即時連線…": "Restoring live connection…",
    "載入更早的訊息": "Load earlier messages", "載入中…": "Loading…", "載入歷史失敗：": "Could not load history: ",
    "歷史讀取失敗": "History load failed", "無法開啟對話：": "Could not open conversation: ", "對話未開啟": "Conversation is not open",
    "工作": "work", "仍在": "Still ", "最後更新於": "; last update ", "前；若沒有繼續，可按停止後重試。": " ago; stop and retry if it does not continue.",
    "無法開啟對話": "Could not open conversation", "訊息已排隊，等目前工作完成後會繼續處理。": "Message queued; it will be handled after the current work finishes.",
    "訊息沒送出去，已保留草稿": "Message was not sent; draft preserved", "回到底部": "Jump to latest",
    "圖片": "Image", "點擊放大圖片": "Click to enlarge image", "查看圖片": "View image", "張圖片": " images",
    "另有": " plus ", "張圖片無法預覽": " images could not be previewed", "移除圖片": "Remove image",
    "不是圖片檔案": "Not an image file", "圖片太大，請先壓縮後再貼上": "Image is too large; compress it before pasting",
    "無法處理圖片": "Could not process image", "圖片讀取失敗": "Could not read image", "圖片壓縮失敗": "Image compression failed",
    "無法讀取圖片": "Could not read image", "最多 4 張圖片": "Up to 4 images", "圖片處理失敗": "Image processing failed",
    "正在加入圖片…": "Adding image…", "張圖片已加入": " image(s) added", "瀏覽器沒有提供可讀取的圖片，請先點擊輸入框再貼上": "The browser did not provide a readable image. Focus the message box and paste again.",
    "需要你的回覆": "Your response is needed", "確認": "Confirm", "完成": "Done", "輸入內容": "Enter text", "送出": "Send",
    "模型與推理": "Model & reasoning", "重新命名": "Rename", "刪除（移到垃圾桶）": "Delete (move to Trash)",
    "儲存": "Save", "取消": "Cancel", "讀取失敗：": "Load failed: ", "讀取中…": "Loading…",
    "沒有顯示中的模型，請到設定勾選模型": "No visible models. Select models in Settings.", "模型：": "Model: ", "切換失敗：": "Switch failed: ",
    "思考等級：": "Thinking level: ", "設定失敗：": "Settings failed: ", "複製": "Copy", "已複製": "Copied", "複製失敗": "Copy failed",
    "圖表渲染中…": "Rendering chart…", "圖表語法錯誤：": "Chart syntax error: ", "壓縮失敗：": "Compaction failed: ", "已壓縮：": "Compacted: ",
    "送出失敗": "Send failed", "對話未開啟": "Conversation is not open", "無法讀取模型清單": "Could not load model list",
    "設定需檢查": "configuration needs attention", "模型": "models", "Provider": "Provider", "模型與 Provider": "Models & providers",
    "讀取模型與 Provider…": "Loading models and providers…", "管理模型顯示與自訂 Provider": "Manage visible models and custom providers",
    "模型清單中…": "Loading model list…", "Provider 設定讀取失敗：": "Could not load provider settings: ",
    "收起": "Collapse", "展開": "Expand", "編輯 ": "Edit ", "刪除 ": "Delete ", "尚未載入": "not loaded",
    "自訂": "custom", "找不到符合的 Provider 或模型。": "No matching provider or model.", "找不到": "No matches for ",
    "個服務": " service(s)", "個模型": " model(s)", "模型清單已更新": "model list updated", "已加入": " added",
    "用帳號登入": "Sign in with an account", "使用 API key": "Use an API key", "直接使用": "Use directly",
    "免費／免帳戶": "Free / no account", "API key／付費服務": "API key / paid services", "帳戶登入": "Account sign-in",
    "貼上服務提供的 API key，費用與額度由服務商管理。": "Paste a key from the service; the provider manages billing and limits.",
    "本機服務直接使用，不需要帳號或 API key。": "Use a local service directly; no account or API key is required.",
    "使用官方帳號或訂閱登入，Pi 會自動保存並更新憑證。": "Sign in with an official account or subscription; Pi stores and refreshes credentials.",
    "找不到符合的 Provider 或模型。": "No matching provider or model.", "已設定": "Configured", "選擇一個服務": "Choose a service",
    "選擇你要使用的服務，再選擇帳號登入或 API key。技術設定會由 Pi 自動處理。": "Choose a service, then sign in or provide an API key. Pi handles the technical setup.",
    "搜尋 Provider…": "Search providers…", "讀取 Provider 清單中…": "Loading provider list…", "目前無法讀取可用 Provider，請稍後再試。": "Provider list is unavailable. Try again later.",
    "只有自架端點或特殊 API 才需要這裡": "For self-hosted endpoints or special APIs",
    "自訂 Provider": "Custom provider", "進階設定會儲存在本機的": "Advanced settings are saved locally in ",
    "一般服務請回到上一步選擇，不需要填這些欄位。": "For regular services, go back and choose one instead.", "API 類型": "API type",
    "API key（可選）": "API key (optional)", "可填": "You may use ", "模型（每行一個，可用": "Models (one per line; use ", "顯示名稱": "display name",
    "請先選擇一個 Provider。": "Choose a provider first.", "請貼上 API key。": "Paste an API key.", "正在儲存並檢查 API key…": "Saving and checking API key…",
    "API key 尚未儲存，請確認區域與 key 是否相符。": "API key was not saved. Check that the region and key match.", "API key 設定失敗": "API key setup failed",
    "按一下直接掃描這台 Mac 的本機模型。": "Click to scan local models on this Mac.", "選一種登入方式開始。": "Choose a sign-in method to begin.",
    "已設定；重新掃描可以更新模型清單。": " is configured; rescan to update the model list.", "已有登入設定；重新選擇登入方式即可更新。": " already has sign-in details; choose a method again to update.",
    "移除這個登入設定": "Remove sign-in", "移除這個 Provider": "Remove provider", "返回服務清單": "Back to provider list",
    "確定移除": "Remove ", "之後仍可從免費清單重新加入。": "You can add it again from the free list.", "只會移除本機憑證，不會刪除 Provider。": "Only local credentials will be removed; the provider stays.",
    "已移除": " removed", "登入設定已移除": " sign-in removed", "移除登入設定失敗": "Could not remove sign-in",
    "請填寫 Provider ID、Base URL，並至少加入一個模型。": "Enter a provider ID and base URL, and add at least one model.", "Provider 已更新": "Provider updated", "Provider 已新增": "Provider added", "儲存失敗": "Save failed", "Provider 已刪除": "Provider deleted", "刪除失敗": "Delete failed",
    "設備": "Devices", "連線": "Connection", "這台機器": "This device", "本機安裝的 pi coding agent": "Pi coding agent installed on this device", "Sessions 總數": "Total sessions", "這台機器上的全部 sessions": "All sessions on this device", "登出": "Sign out", "清除這個瀏覽器的登入狀態": "Clear this browser's sign-in state",
    "介面": "Interface", "外觀": "Appearance", "跟隨系統": "System", "亮色": "Light", "暗色": "Dark", "設計風格": "Design theme", "緊湊列表": "Compact list", "桌面側欄寬度": "Desktop sidebar width", "文字大小": "Text size", "按專案分組": "Group by project", "減少動態效果": "Reduce motion", "思考過程": "Thinking blocks", "收合": "Collapsed", "展開": "Expanded", "新手勢": "Swipe gesture", "開啟": "Enabled", "關於": "About", "手勢提示": "Gesture tips", "恢復介面預設": "Restore interface defaults", "模型與 Provider": "Models & providers",
    "已在這台設備上": "Already using this device", "在線": "Online", "離線": "Offline", "檢查中": "Checking", "尚未檢查": "Not checked", "使用中": "In use", "儲存後會自動加入設備清單。": "The device will be added after saving.", "儲存設備": "Save device", "測試連線": "Test connection", "刪除設備": "Delete device", "使用配對碼加入": "Join with pairing code", "產生新的配對碼": "Generate new pairing code", "驗證並加入": "Verify and add", "重新啟動 Pi Web": "Restart Pi Web", "主機名稱（可選）": "Host name (optional)", "設備名稱": "Device name", "Pi Web 網址": "Pi Web URL", "本機 Pi Web port": "Local Pi Web port", "配對碼已複製": "Pairing code copied", "配對碼已產生，請手動複製": "Pairing code generated; copy it manually", "無法產生配對碼": "Could not generate pairing code", "設備配對成功": "Device paired", "設備配對失敗": "Device pairing failed", "登入已過期": "Sign-in expired",
    "要恢復介面預設設定嗎？登入狀態與 session 不會受到影響。": "Restore interface defaults? Sign-in and sessions will not be affected.", "介面設定已恢復預設": "Interface defaults restored",
    "選擇專案資料夾": "Choose a project folder", "選擇的位置": "Selected location", "Session 名稱（可留空）": "Session name (optional)", "在這裡開始": "Start here", "家目錄": "Home folder", "上一層": "Parent folder", "選擇一個資料夾": "Choose a folder",
    "Session 名稱": "Session name", "目前狀態：": "Current status: ", "配對碼 5 分鐘內有效，複製到另一台 Pi Web 使用。": "Pairing code is valid for 5 minutes; paste it into another Pi Web.",
    "正在驗證配對碼並測試遠端連線…": "Verifying pairing code and testing the remote connection…", "配對失敗；請確認配對碼尚未過期，以及兩台設備使用相同 token。": "Pairing failed; check that the code has not expired and both devices use the same token.",
    "請貼上另一台設備產生的配對碼。": "Paste the pairing code generated by the other device.", "目前無法讀取設備清單": "Could not load device list", "無法讀取設備清單": "Could not load device list",
    "PI AGENT DEVICE": "PI AGENT DEVICE", "MODEL PROVIDER": "MODEL PROVIDER", "NEW PROJECT": "NEW PROJECT",
    "圖片檢視": "Image viewer", "關閉圖片": "Close image", "關閉模型選單": "Close model menu", "關閉": "Close",
    "工作已中止": "Work stopped", "工作失敗": "Work failed", "工作在完成事件前停止；請檢查連線或重試。": "Work stopped before completion; check the connection or retry.", "沒有收到結束原因": "No stop reason was received",
    "已切換到": "Switched to ", "天前": " days ago", "(未命名)": "(Untitled)", "顯示更多（": "Show more (", "已移到垃圾桶": "Moved to Trash", "刪除失敗：": "Delete failed: ", "重新命名失敗：": "Rename failed: ", "歷史讀取失敗": "History load failed", "即時連線中斷，": "Live connection interrupted; ", "秒後自動恢復…": "s until automatic recovery…", "本次對話用量": "Usage for this conversation", "（執行中…）": "(Running…)", "（沒有收到工具輸出）": "(No tool output received)", "（無輸出）": "(No output)", "回覆 Provider 登入失敗：": "Provider sign-in response failed: ", "回覆 Pi 失敗：": "Pi response failed: ", "Pi 通知": "Pi notification", "秒": "s", "分鐘": "min", "仍在": "Still ", "連線暫時失敗，正在重試": "Connection temporarily failed; retrying", "重試失敗，請檢查模型或連線": "Retry failed; check the model or connection", "上下文整理暫時失敗，準備重試…": "Context preparation failed temporarily; retrying…", "正在重試整理上下文": "Retrying context preparation", "擴充功能錯誤：": "Extension error: ", "未知錯誤": "Unknown error", "暫時失敗": "Temporarily failed", "模型暫時失敗，準備重試：": "Model temporarily failed; retrying: ", "則訊息排隊中": " message(s) queued", "Pi 無法啟動": "Pi could not start", "Pi 工作程序已中斷": "Pi work process stopped", "這次工作被停止，沒有產生完整回覆。": "This work was stopped before a complete response was produced.", "Pi 沒有提供錯誤原因，請檢查連線或按重試。": "Pi did not provide a reason; check the connection or retry.", "連線已恢復，工作仍在繼續…": "Connection restored; work is continuing…", "⏳": "⏳", "不是圖片檔案": "Not an image file", "圖片太大，請先壓縮後再貼上": "Image is too large; compress it before pasting", "無法處理圖片": "Could not process image", "圖片讀取失敗": "Could not read image", "圖片壓縮失敗": "Image compression failed", "無法讀取圖片": "Could not read image", "最多 4 張圖片": "Up to 4 images", "圖片處理失敗": "Image processing failed", "正在加入圖片…": "Adding image…", "瀏覽器沒有提供可讀取的圖片，請先點擊輸入框再貼上": "The browser did not provide a readable image. Focus the message box and paste again.", "正在加入圖片…": "Adding image…", "張圖片已加入": " image(s) added", "留空以保留目前 API key": "Leave empty to keep the current API key", "可填 $ENV_VAR 或 !command": "You may use $ENV_VAR or !command", "請修正 models.json 後重新讀取。": "Fix models.json and reload.", "沒有讀到可用模型，點右上角重新讀取。": "No available models. Click reload above.", "找不到「": "No matches for \"", "」；可以試試服務商名稱或 Provider ID。": "\"; try a provider name or ID.", "個服務": " service(s)", "已加入；模型清單已更新。": " added; model list updated.", "已加入；重新掃描可以更新模型清單。": " added; rescan to update the model list.", "按一下直接掃描這台 Mac 的本機模型。": "Click to scan local models on this Mac.", "已有登入設定；重新選擇登入方式即可更新。": " already has sign-in details; choose a method again to update.", "選一種登入方式開始。": "Choose a sign-in method to begin.", "正在儲存並檢查 API key…": "Saving and checking API key…", "API key 尚未儲存，請確認區域與 key 是否相符。": "API key was not saved. Check that the region and key match.", "免費 Provider 設定失敗": "Free provider setup failed", "確定移除「": "Remove \"", "」？": "\"?", "免費清單重新加入": "add it again from the free list", "登入設定已移除": " sign-in removed", "移除登入設定失敗": "Could not remove sign-in", "請填寫 Provider ID、Base URL，並至少加入一個模型。": "Enter a provider ID and base URL, and add at least one model.", "從 models.json 移除「": "Remove \"", "不會刪除 auth.json 的登入憑證。": "auth.json credentials will not be deleted.", "刪除失敗": "Delete failed", "讀取本機設備設定失敗": "Could not load local device settings", "正在測試連線…": "Testing connection…", "連線成功，Pi Web 正常回應。": "Connection succeeded; Pi Web responded normally.", "連線失敗；請確認 Pi Web、port 與 Tailscale／HTTPS 網址。": "Connection failed; check Pi Web, the port, and the Tailscale/HTTPS URL.", "請填寫設備名稱。": "Enter a device name.", "請填寫設備名稱與 Pi Web 網址。": "Enter a device name and Pi Web URL.", "Pi Web port 必須是 1024–65535 的整數。": "Pi Web port must be an integer from 1024 to 65535.", "設定已保存；新的 port 需要重新啟動 Pi Web 後才會生效。": "Settings saved; the new port takes effect after Pi Web restarts.", "設備名稱已更新；port 等待重啟後生效": "Device name updated; port will apply after restart", "本機設備設定已更新": "Local device settings updated", "設備已更新": "Device updated", "設備已加入": "Device added", "重新啟動 Pi Web 會中斷目前的瀏覽連線；正在執行的 Pi 工作會先嘗試安全收尾。要繼續嗎？": "Restarting Pi Web will interrupt this browser connection; running Pi work will try to finish safely first. Continue?", "正在要求 Pi Web 重新啟動…": "Requesting Pi Web restart…", "Pi Web 正在重新啟動": "Pi Web is restarting", "無法重新啟動 Pi Web": "Could not restart Pi Web", "確定要刪除": "Delete ", "設備已刪除": "Device deleted", "設備刪除失敗": "Could not delete device", "這裡沒有可進入的子資料夾": "There are no subfolders to open", "讀取資料夾中…": "Loading folders…", "讀取失敗": "Load failed", "無法讀取資料夾：": "Could not read folder: ", "請先選擇一個資料夾": "Choose a folder first", "新版已準備好；目前工作完成後可重新整理。": "A new version is ready; refresh after current work finishes.", "Pi Web 已更新，正在重新載入…": "Pi Web updated; reloading…", "重試": "Retry", "顯示更多 sessions": "Show more sessions",
  };

  const TRANSLATIONS = {
    en: {},
    "zh-Hant": {
      "Sign in": "登入", "Settings": "設定", "Back": "返回", "Back to sessions": "返回列表", "Back to settings": "返回設定", "More": "更多", "New conversation": "新對話", "Switch device": "切換設備", "Add device": "新增設備", "Refresh": "重新整理", "Toggle project grouping": "切換專案分組", "Search sessions…": "搜尋工作階段…", "No sessions on this device.": "這台設備還沒有任何工作階段。", "Choose a folder from New project to begin": "從 New project 選擇資料夾開始", "Latest": "最新", "Jump to latest": "回到最新", "Add attachment": "加入附件", "Choose model": "選擇模型", "Server default": "伺服器預設", "Thinking level": "思考等級", "Stop": "停止", "Send": "送出", "Conversation tools": "對話工具", "Agent is working": "Agent 執行中", "Select a session,": "從左側選擇一個工作階段，", "or start a new conversation": "或開啟新對話", "Loading…": "讀取中…", "Cancel": "取消", "Save": "儲存", "Confirm": "確認", "Done": "完成", "Copy": "複製", "Copied": "已複製", "Copy failed": "複製失敗", "Model & reasoning": "模型與推理", "Rename": "重新命名", "Delete (move to Trash)": "刪除（移到垃圾桶）", "Models & providers": "模型與 Provider", "Manage visible models and custom providers": "管理模型顯示與自訂 Provider", "Add provider": "新增 Provider", "Reload models": "重新讀取模型", "Search providers or models…": "搜尋 Provider 或模型…", "Search providers…": "搜尋 Provider…", "Provider list": "Provider 清單", "Choose a service": "選擇一個服務", "Sign in with an account": "用帳號登入", "Use an API key": "使用 API key", "Use directly": "直接使用", "Back to provider list": "返回服務清單", "Custom provider": "自訂 Provider", "For self-hosted endpoints or special APIs": "只有自架端點或特殊 API 才需要這裡", "Devices": "設備", "Connection": "連線", "This device": "這台設備", "Pi version": "Pi 版本", "Total sessions": "工作階段總數", "Sign out": "登出", "Interface": "介面", "Language": "語言", "Appearance": "外觀", "System": "跟隨系統", "Light": "亮色", "Dark": "暗色", "Design theme": "設計風格", "Compact list": "緊湊列表", "Desktop sidebar width": "桌面側欄寬度", "Text size": "文字大小", "Group by project": "按專案分組", "Reduce motion": "減少動態效果", "Thinking blocks": "思考區塊", "Collapsed": "收合", "Expanded": "展開", "Swipe gesture": "新手勢", "Enabled": "開啟", "About": "關於", "Gesture tips": "手勢提示", "Restore interface defaults": "恢復介面預設", "Choose a project folder": "選擇專案資料夾", "Selected location": "選擇的位置", "Session name (optional)": "工作階段名稱（可留空）", "Start here": "在這裡開始", "Parent folder": "上一層", "Home folder": "家目錄", "Image viewer": "圖片檢視", "Close image": "關閉圖片", "Close": "關閉", "Your response is needed": "需要你的回覆", "Restore interface defaults? Sign-in and sessions will not be affected.": "要恢復介面預設設定嗎？登入狀態與工作階段不會受到影響。",
    },
    "zh-Hans": {
      "Sign in": "登录", "Settings": "设置", "Back": "返回", "Back to sessions": "返回列表", "Back to settings": "返回设置", "More": "更多", "New conversation": "新对话", "Switch device": "切换设备", "Add device": "添加设备", "Refresh": "刷新", "Toggle project grouping": "切换项目分组", "Search sessions…": "搜索会话…", "No sessions on this device.": "这台设备还没有会话。", "Choose a folder from New project to begin": "从 New project 选择文件夹开始", "Latest": "最新", "Jump to latest": "回到底部", "Add attachment": "添加附件", "Choose model": "选择模型", "Server default": "服务器默认", "Thinking level": "思考等级", "Stop": "停止", "Send": "发送", "Conversation tools": "对话工具", "Agent is working": "Agent 正在工作", "Select a session,": "从左侧选择一个会话，", "or start a new conversation": "或开始新对话", "Loading…": "加载中…", "Cancel": "取消", "Save": "保存", "Confirm": "确认", "Done": "完成", "Copy": "复制", "Copied": "已复制", "Copy failed": "复制失败", "Model & reasoning": "模型与推理", "Rename": "重命名", "Delete (move to Trash)": "删除（移到废纸篓）", "Models & providers": "模型与 Provider", "Manage visible models and custom providers": "管理可见模型与自定义 Provider", "Add provider": "添加 Provider", "Reload models": "重新加载模型", "Search providers or models…": "搜索 Provider 或模型…", "Search providers…": "搜索 Provider…", "Provider list": "Provider 列表", "Choose a service": "选择服务", "Sign in with an account": "使用账号登录", "Use an API key": "使用 API key", "Use directly": "直接使用", "Back to provider list": "返回服务列表", "Custom provider": "自定义 Provider", "For self-hosted endpoints or special APIs": "仅用于自托管端点或特殊 API", "Devices": "设备", "Connection": "连接", "This device": "这台设备", "Pi version": "Pi 版本", "Total sessions": "会话总数", "Sign out": "退出登录", "Interface": "界面", "Language": "语言", "Appearance": "外观", "System": "跟随系统", "Light": "浅色", "Dark": "深色", "Design theme": "设计主题", "Compact list": "紧凑列表", "Desktop sidebar width": "桌面侧栏宽度", "Text size": "文字大小", "Group by project": "按项目分组", "Reduce motion": "减少动态效果", "Thinking blocks": "思考区块", "Collapsed": "收起", "Expanded": "展开", "Swipe gesture": "新手势", "Enabled": "已启用", "About": "关于", "Gesture tips": "手势提示", "Restore interface defaults": "恢复界面默认", "Choose a project folder": "选择项目文件夹", "Selected location": "选择的位置", "Session name (optional)": "会话名称（可选）", "Start here": "从这里开始", "Parent folder": "上一级", "Home folder": "主目录", "Image viewer": "图片查看器", "Close image": "关闭图片", "Close": "关闭", "Your response is needed": "需要你的回复", "Restore interface defaults? Sign-in and sessions will not be affected.": "要恢复界面默认设置吗？登录状态与会话不会受到影响。",
    },
    ja: {
      "Sign in": "サインイン", "Settings": "設定", "Back": "戻る", "Back to sessions": "セッションに戻る", "Back to settings": "設定に戻る", "More": "その他", "New conversation": "新しい会話", "Switch device": "デバイスを切り替え", "Add device": "デバイスを追加", "Refresh": "更新", "Toggle project grouping": "プロジェクトのグループ化", "Search sessions…": "セッションを検索…", "No sessions on this device.": "このデバイスにセッションはありません。", "Latest": "最新", "Jump to latest": "最新へ移動", "Add attachment": "添付を追加", "Choose model": "モデルを選択", "Server default": "サーバーの既定", "Thinking level": "思考レベル", "Stop": "停止", "Send": "送信", "Loading…": "読み込み中…", "Cancel": "キャンセル", "Save": "保存", "Confirm": "確認", "Done": "完了", "Copy": "コピー", "Model & reasoning": "モデルと推論", "Rename": "名前を変更", "Delete (move to Trash)": "削除（ゴミ箱へ）", "Models & providers": "モデルとプロバイダー", "Add provider": "プロバイダーを追加", "Search providers…": "プロバイダーを検索…", "Choose a service": "サービスを選択", "Sign in with an account": "アカウントでサインイン", "Use an API key": "API キーを使用", "Use directly": "直接使用", "Back to provider list": "プロバイダー一覧に戻る", "Custom provider": "カスタムプロバイダー", "Devices": "デバイス", "Connection": "接続", "This device": "このデバイス", "Total sessions": "セッション数", "Sign out": "サインアウト", "Interface": "インターフェース", "Language": "言語", "Appearance": "外観", "System": "システムに合わせる", "Light": "ライト", "Dark": "ダーク", "Design theme": "デザインテーマ", "Compact list": "コンパクトリスト", "Text size": "文字サイズ", "Group by project": "プロジェクトでグループ化", "Reduce motion": "モーションを減らす", "Thinking blocks": "思考ブロック", "Collapsed": "折りたたみ", "Expanded": "展開", "About": "概要", "Choose a project folder": "プロジェクトフォルダーを選択", "Selected location": "選択した場所", "Session name (optional)": "セッション名（任意）", "Start here": "ここから開始", "Parent folder": "親フォルダー", "Home folder": "ホームフォルダー", "Image viewer": "画像ビューアー", "Close image": "画像を閉じる", "Close": "閉じる", "Your response is needed": "回答が必要です", "Choose a folder from New project to begin": "New project からフォルダーを選択して開始", "Conversation tools": "会話ツール", "Agent is working": "Agent が作業中", "Select a session,": "左側からセッションを選択するか、", "or start a new conversation": "または新しい会話を開始", "Copied": "コピーしました", "Copy failed": "コピーに失敗しました", "Manage visible models and custom providers": "表示するモデルとカスタムプロバイダーを管理", "Reload models": "モデルを再読み込み", "Search providers or models…": "プロバイダーまたはモデルを検索…", "Provider list": "プロバイダー一覧", "For self-hosted endpoints or special APIs": "セルフホストのエンドポイントや特殊な API 用", "Pi version": "Pi バージョン", "Desktop sidebar width": "デスクトップのサイドバー幅", "Swipe gesture": "スワイプジェスチャー", "Enabled": "有効", "Gesture tips": "ジェスチャーのヒント", "Restore interface defaults": "インターフェースの既定値を復元", "Restore interface defaults? Sign-in and sessions will not be affected.": "インターフェースの既定値を復元しますか？サインインとセッションには影響しません。", "Show more": "さらに表示", "Show less": "表示を減らす", "Show more (": "さらに表示 (", "Show more sessions": "セッションをさらに表示", "Unassigned project": "未割り当てのプロジェクト",
    },
    ko: {
      "Sign in": "로그인", "Settings": "설정", "Back": "뒤로", "Back to sessions": "세션으로 돌아가기", "Back to settings": "설정으로 돌아가기", "More": "더 보기", "New conversation": "새 대화", "Switch device": "기기 전환", "Add device": "기기 추가", "Refresh": "새로 고침", "Toggle project grouping": "프로젝트 그룹 전환", "Search sessions…": "세션 검색…", "No sessions on this device.": "이 기기에 세션이 없습니다.", "Latest": "최신", "Jump to latest": "최신으로 이동", "Add attachment": "첨부 추가", "Choose model": "모델 선택", "Server default": "서버 기본값", "Thinking level": "사고 수준", "Stop": "중지", "Send": "보내기", "Loading…": "로드 중…", "Cancel": "취소", "Save": "저장", "Confirm": "확인", "Done": "완료", "Copy": "복사", "Model & reasoning": "모델 및 추론", "Rename": "이름 변경", "Delete (move to Trash)": "삭제(휴지통으로 이동)", "Models & providers": "모델 및 Provider", "Add provider": "Provider 추가", "Search providers…": "Provider 검색…", "Choose a service": "서비스 선택", "Sign in with an account": "계정으로 로그인", "Use an API key": "API 키 사용", "Use directly": "직접 사용", "Back to provider list": "Provider 목록으로", "Custom provider": "사용자 지정 Provider", "Devices": "기기", "Connection": "연결", "This device": "이 기기", "Total sessions": "전체 세션", "Sign out": "로그아웃", "Interface": "인터페이스", "Language": "언어", "Appearance": "모양", "System": "시스템 설정", "Light": "밝게", "Dark": "어둡게", "Design theme": "디자인 테마", "Compact list": "간결한 목록", "Text size": "글자 크기", "Group by project": "프로젝트별 그룹화", "Reduce motion": "동작 줄이기", "Thinking blocks": "사고 블록", "Collapsed": "접힘", "Expanded": "펼침", "About": "정보", "Choose a project folder": "프로젝트 폴더 선택", "Selected location": "선택한 위치", "Session name (optional)": "세션 이름(선택 사항)", "Start here": "여기서 시작", "Parent folder": "상위 폴더", "Home folder": "홈 폴더", "Image viewer": "이미지 뷰어", "Close image": "이미지 닫기", "Close": "닫기", "Your response is needed": "응답이 필요합니다", "Choose a folder from New project to begin": "New project에서 폴더를 선택하여 시작", "Conversation tools": "대화 도구", "Agent is working": "Agent 작업 중", "Select a session,": "왼쪽에서 세션을 선택하거나", "or start a new conversation": "새 대화를 시작하세요", "Copied": "복사됨", "Copy failed": "복사 실패", "Manage visible models and custom providers": "표시할 모델 및 사용자 지정 Provider 관리", "Reload models": "모델 다시 불러오기", "Search providers or models…": "Provider 또는 모델 검색…", "Provider list": "Provider 목록", "For self-hosted endpoints or special APIs": "자체 호스팅 엔드포인트 또는 특수 API용", "Pi version": "Pi 버전", "Desktop sidebar width": "데스크톱 사이드바 너비", "Swipe gesture": "스와이프 제스처", "Enabled": "사용", "Gesture tips": "제스처 안내", "Restore interface defaults": "인터페이스 기본값 복원", "Restore interface defaults? Sign-in and sessions will not be affected.": "인터페이스 기본값을 복원할까요? 로그인과 세션에는 영향을 주지 않습니다.", "Show more": "더 보기", "Show less": "접기", "Show more (": "더 보기 (", "Show more sessions": "세션 더 보기", "Unassigned project": "할당되지 않은 프로젝트",
    },
    tr: {
      "Sign in": "Giriş yap", "Settings": "Ayarlar", "Back": "Geri", "Back to sessions": "Oturumlara dön", "Back to settings": "Ayarlara dön", "More": "Daha fazla", "New conversation": "Yeni konuşma", "Switch device": "Cihazı değiştir", "Add device": "Cihaz ekle", "Refresh": "Yenile", "Toggle project grouping": "Proje gruplamasını değiştir", "Search sessions…": "Oturumlarda ara…", "No sessions on this device.": "Bu cihazda oturum yok.", "Latest": "En yeni", "Jump to latest": "En yeniye git", "Add attachment": "Ek ekle", "Choose model": "Model seç", "Server default": "Sunucu varsayılanı", "Thinking level": "Düşünme düzeyi", "Stop": "Durdur", "Send": "Gönder", "Loading…": "Yükleniyor…", "Cancel": "İptal", "Save": "Kaydet", "Confirm": "Onayla", "Done": "Bitti", "Copy": "Kopyala", "Model & reasoning": "Model ve akıl yürütme", "Rename": "Yeniden adlandır", "Delete (move to Trash)": "Sil (Çöp Kutusu'na taşı)", "Models & providers": "Modeller ve sağlayıcılar", "Add provider": "Sağlayıcı ekle", "Search providers…": "Sağlayıcılarda ara…", "Choose a service": "Bir hizmet seç", "Sign in with an account": "Hesapla giriş yap", "Use an API key": "API anahtarı kullan", "Use directly": "Doğrudan kullan", "Back to provider list": "Sağlayıcı listesine dön", "Custom provider": "Özel sağlayıcı", "Devices": "Cihazlar", "Connection": "Bağlantı", "This device": "Bu cihaz", "Total sessions": "Toplam oturum", "Sign out": "Çıkış yap", "Interface": "Arayüz", "Language": "Dil", "Appearance": "Görünüm", "System": "Sistem", "Light": "Açık", "Dark": "Koyu", "Design theme": "Tasarım teması", "Compact list": "Sıkı liste", "Text size": "Metin boyutu", "Group by project": "Projeye göre grupla", "Reduce motion": "Hareketi azalt", "Thinking blocks": "Düşünme blokları", "Collapsed": "Daraltılmış", "Expanded": "Genişletilmiş", "About": "Hakkında", "Choose a project folder": "Proje klasörü seç", "Selected location": "Seçilen konum", "Session name (optional)": "Oturum adı (isteğe bağlı)", "Start here": "Buradan başla", "Parent folder": "Üst klasör", "Home folder": "Ana klasör", "Image viewer": "Görüntüleyici", "Close image": "Görseli kapat", "Close": "Kapat", "Your response is needed": "Yanıtınız gerekiyor", "Choose a folder from New project to begin": "Başlamak için New project'ten bir klasör seçin", "Conversation tools": "Konuşma araçları", "Agent is working": "Agent çalışıyor", "Select a session,": "Bir oturum seçin,", "or start a new conversation": "veya yeni bir konuşma başlatın", "Copied": "Kopyalandı", "Copy failed": "Kopyalama başarısız", "Manage visible models and custom providers": "Görünür modelleri ve özel sağlayıcıları yönet", "Reload models": "Modelleri yeniden yükle", "Search providers or models…": "Sağlayıcıları veya modelleri ara…", "Provider list": "Sağlayıcı listesi", "For self-hosted endpoints or special APIs": "Kendi barındırdığınız uç noktalar veya özel API'ler için", "Pi version": "Pi sürümü", "Desktop sidebar width": "Masaüstü kenar çubuğu genişliği", "Swipe gesture": "Kaydırma hareketi", "Enabled": "Etkin", "Gesture tips": "Hareket ipuçları", "Restore interface defaults": "Arayüz varsayılanlarını geri yükle", "Restore interface defaults? Sign-in and sessions will not be affected.": "Arayüz varsayılanları geri yüklensin mi? Oturum açma ve oturumlar etkilenmez.", "Show more": "Daha fazla göster", "Show less": "Daha az göster", "Show more sessions": "Daha fazla oturum göster", "Unassigned project": "Atanmamış proje",
    },
    fr: {
      "Sign in": "Se connecter", "Settings": "Réglages", "Back": "Retour", "Back to sessions": "Retour aux sessions", "Back to settings": "Retour aux réglages", "More": "Plus", "New conversation": "Nouvelle conversation", "Switch device": "Changer d’appareil", "Add device": "Ajouter un appareil", "Refresh": "Actualiser", "Toggle project grouping": "Basculer le regroupement par projet", "Search sessions…": "Rechercher des sessions…", "No sessions on this device.": "Aucune session sur cet appareil.", "Latest": "Récent", "Jump to latest": "Aller au plus récent", "Add attachment": "Ajouter une pièce jointe", "Choose model": "Choisir un modèle", "Server default": "Valeur serveur", "Thinking level": "Niveau de réflexion", "Stop": "Arrêter", "Send": "Envoyer", "Loading…": "Chargement…", "Cancel": "Annuler", "Save": "Enregistrer", "Confirm": "Confirmer", "Done": "Terminé", "Copy": "Copier", "Model & reasoning": "Modèle et raisonnement", "Rename": "Renommer", "Delete (move to Trash)": "Supprimer (mettre à la corbeille)", "Models & providers": "Modèles et fournisseurs", "Add provider": "Ajouter un fournisseur", "Search providers…": "Rechercher des fournisseurs…", "Choose a service": "Choisir un service", "Sign in with an account": "Se connecter avec un compte", "Use an API key": "Utiliser une clé API", "Use directly": "Utiliser directement", "Back to provider list": "Retour à la liste", "Custom provider": "Fournisseur personnalisé", "Devices": "Appareils", "Connection": "Connexion", "This device": "Cet appareil", "Total sessions": "Sessions totales", "Sign out": "Se déconnecter", "Interface": "Interface", "Language": "Langue", "Appearance": "Apparence", "System": "Système", "Light": "Clair", "Dark": "Sombre", "Design theme": "Thème visuel", "Compact list": "Liste compacte", "Text size": "Taille du texte", "Group by project": "Grouper par projet", "Reduce motion": "Réduire les animations", "Thinking blocks": "Blocs de réflexion", "Collapsed": "Réduit", "Expanded": "Développé", "About": "À propos", "Choose a project folder": "Choisir un dossier de projet", "Selected location": "Emplacement sélectionné", "Session name (optional)": "Nom de session (facultatif)", "Start here": "Commencer ici", "Parent folder": "Dossier parent", "Home folder": "Dossier personnel", "Image viewer": "Visionneuse d’images", "Close image": "Fermer l’image", "Close": "Fermer", "Your response is needed": "Votre réponse est requise", "Choose a folder from New project to begin": "Choisissez un dossier dans New project pour commencer", "Conversation tools": "Outils de conversation", "Agent is working": "L’agent travaille", "Select a session,": "Sélectionnez une session,", "or start a new conversation": "ou démarrez une nouvelle conversation", "Copied": "Copié", "Copy failed": "Échec de la copie", "Manage visible models and custom providers": "Gérer les modèles visibles et les fournisseurs personnalisés", "Reload models": "Recharger les modèles", "Search providers or models…": "Rechercher des fournisseurs ou des modèles…", "Provider list": "Liste des fournisseurs", "For self-hosted endpoints or special APIs": "Pour les points de terminaison auto-hébergés ou les API spéciales", "Pi version": "Version de Pi", "Desktop sidebar width": "Largeur de la barre latérale sur ordinateur", "Swipe gesture": "Geste de balayage", "Enabled": "Activé", "Gesture tips": "Conseils gestuels", "Restore interface defaults": "Restaurer les paramètres d’interface par défaut", "Restore interface defaults? Sign-in and sessions will not be affected.": "Restaurer les paramètres d’interface par défaut ? La connexion et les sessions ne seront pas affectées.", "Show more": "Afficher plus", "Show less": "Afficher moins", "Show more sessions": "Afficher plus de sessions", "Unassigned project": "Projet non attribué",
    },
    de: {
      "Sign in": "Anmelden", "Settings": "Einstellungen", "Back": "Zurück", "Back to sessions": "Zu den Sitzungen", "Back to settings": "Zu den Einstellungen", "More": "Mehr", "New conversation": "Neue Unterhaltung", "Switch device": "Gerät wechseln", "Add device": "Gerät hinzufügen", "Refresh": "Aktualisieren", "Toggle project grouping": "Projektgruppierung umschalten", "Search sessions…": "Sitzungen durchsuchen…", "No sessions on this device.": "Keine Sitzungen auf diesem Gerät.", "Latest": "Neueste", "Jump to latest": "Zur neuesten wechseln", "Add attachment": "Anhang hinzufügen", "Choose model": "Modell auswählen", "Server default": "Serverstandard", "Thinking level": "Denkstufe", "Stop": "Stopp", "Send": "Senden", "Loading…": "Wird geladen…", "Cancel": "Abbrechen", "Save": "Speichern", "Confirm": "Bestätigen", "Done": "Fertig", "Copy": "Kopieren", "Model & reasoning": "Modell und Schlussfolgerung", "Rename": "Umbenennen", "Delete (move to Trash)": "Löschen (in den Papierkorb)", "Models & providers": "Modelle und Anbieter", "Add provider": "Anbieter hinzufügen", "Search providers…": "Anbieter durchsuchen…", "Choose a service": "Dienst auswählen", "Sign in with an account": "Mit Konto anmelden", "Use an API key": "API-Schlüssel verwenden", "Use directly": "Direkt verwenden", "Back to provider list": "Zur Anbieterliste", "Custom provider": "Benutzerdefinierter Anbieter", "Devices": "Geräte", "Connection": "Verbindung", "This device": "Dieses Gerät", "Total sessions": "Sitzungen gesamt", "Sign out": "Abmelden", "Interface": "Oberfläche", "Language": "Sprache", "Appearance": "Darstellung", "System": "System", "Light": "Hell", "Dark": "Dunkel", "Design theme": "Designthema", "Compact list": "Kompakte Liste", "Text size": "Textgröße", "Group by project": "Nach Projekt gruppieren", "Reduce motion": "Bewegung reduzieren", "Thinking blocks": "Denkblöcke", "Collapsed": "Eingeklappt", "Expanded": "Ausgeklappt", "About": "Über", "Choose a project folder": "Projektordner auswählen", "Selected location": "Ausgewählter Ort", "Session name (optional)": "Sitzungsname (optional)", "Start here": "Hier starten", "Parent folder": "Übergeordneter Ordner", "Home folder": "Home-Ordner", "Image viewer": "Bildanzeige", "Close image": "Bild schließen", "Close": "Schließen", "Your response is needed": "Ihre Antwort wird benötigt", "Choose a folder from New project to begin": "Wählen Sie einen Ordner unter „New project“, um zu beginnen", "Conversation tools": "Unterhaltungswerkzeuge", "Agent is working": "Agent arbeitet", "Select a session,": "Sitzung auswählen,", "or start a new conversation": "oder eine neue Unterhaltung starten", "Copied": "Kopiert", "Copy failed": "Kopieren fehlgeschlagen", "Manage visible models and custom providers": "Sichtbare Modelle und benutzerdefinierte Anbieter verwalten", "Reload models": "Modelle neu laden", "Search providers or models…": "Anbieter oder Modelle durchsuchen…", "Provider list": "Anbieterliste", "For self-hosted endpoints or special APIs": "Für selbst gehostete Endpunkte oder spezielle APIs", "Pi version": "Pi-Version", "Desktop sidebar width": "Breite der Desktop-Seitenleiste", "Swipe gesture": "Wischgeste", "Enabled": "Aktiviert", "Gesture tips": "Gestenhinweise", "Restore interface defaults": "Oberflächenstandards wiederherstellen", "Restore interface defaults? Sign-in and sessions will not be affected.": "Oberflächenstandards wiederherstellen? Anmeldung und Sitzungen bleiben unverändert.", "Show more": "Mehr anzeigen", "Show less": "Weniger anzeigen", "Show more sessions": "Mehr Sitzungen anzeigen", "Unassigned project": "Nicht zugeordnetes Projekt",
    },
    es: {
      "Sign in": "Iniciar sesión", "Settings": "Ajustes", "Back": "Atrás", "Back to sessions": "Volver a sesiones", "More": "Más", "New conversation": "Nueva conversación", "Switch device": "Cambiar dispositivo", "Add device": "Añadir dispositivo", "Refresh": "Actualizar", "Search sessions…": "Buscar sesiones…", "No sessions on this device.": "No hay sesiones en este dispositivo.", "Latest": "Más reciente", "Add attachment": "Añadir archivo", "Choose model": "Elegir modelo", "Stop": "Detener", "Send": "Enviar", "Loading…": "Cargando…", "Cancel": "Cancelar", "Save": "Guardar", "Confirm": "Confirmar", "Done": "Listo", "Copy": "Copiar", "Rename": "Cambiar nombre", "Delete (move to Trash)": "Eliminar (mover a la papelera)", "Models & providers": "Modelos y proveedores", "Add provider": "Añadir proveedor", "Search providers…": "Buscar proveedores…", "Choose a service": "Elegir un servicio", "Sign in with an account": "Iniciar sesión con una cuenta", "Use an API key": "Usar una clave API", "Use directly": "Usar directamente", "Custom provider": "Proveedor personalizado", "Devices": "Dispositivos", "Connection": "Conexión", "This device": "Este dispositivo", "Total sessions": "Sesiones totales", "Sign out": "Cerrar sesión", "Interface": "Interfaz", "Language": "Idioma", "Appearance": "Apariencia", "System": "Sistema", "Light": "Claro", "Dark": "Oscuro", "Design theme": "Tema de diseño", "Compact list": "Lista compacta", "Text size": "Tamaño del texto", "Group by project": "Agrupar por proyecto", "Reduce motion": "Reducir movimiento", "About": "Acerca de", "Choose a project folder": "Elegir una carpeta de proyecto", "Selected location": "Ubicación seleccionada", "Session name (optional)": "Nombre de sesión (opcional)", "Start here": "Empezar aquí", "Parent folder": "Carpeta superior", "Home folder": "Carpeta de inicio", "Close": "Cerrar", "Back to settings": "Volver a ajustes", "Toggle project grouping": "Alternar agrupación por proyecto", "Choose a folder from New project to begin": "Elige una carpeta en New project para empezar", "Jump to latest": "Ir a lo más reciente", "Server default": "Predeterminado del servidor", "Thinking level": "Nivel de razonamiento", "Conversation tools": "Herramientas de conversación", "Agent is working": "El agente está trabajando", "Select a session,": "Selecciona una sesión,", "or start a new conversation": "o inicia una conversación nueva", "Copied": "Copiado", "Copy failed": "Error al copiar", "Model & reasoning": "Modelo y razonamiento", "Manage visible models and custom providers": "Gestionar modelos visibles y proveedores personalizados", "Reload models": "Recargar modelos", "Search providers or models…": "Buscar proveedores o modelos…", "Provider list": "Lista de proveedores", "Back to provider list": "Volver a la lista de proveedores", "For self-hosted endpoints or special APIs": "Para endpoints autoalojados o API especiales", "Pi version": "Versión de Pi", "Desktop sidebar width": "Ancho de la barra lateral del escritorio", "Thinking blocks": "Bloques de razonamiento", "Collapsed": "Contraído", "Expanded": "Expandido", "Swipe gesture": "Gesto de deslizamiento", "Enabled": "Activado", "Gesture tips": "Consejos de gestos", "Restore interface defaults": "Restaurar valores predeterminados de la interfaz", "Restore interface defaults? Sign-in and sessions will not be affected.": "¿Restaurar los valores predeterminados de la interfaz? El inicio de sesión y las sesiones no se verán afectados.", "Image viewer": "Visor de imágenes", "Close image": "Cerrar imagen", "Your response is needed": "Se necesita tu respuesta", "Show more": "Mostrar más", "Show less": "Mostrar menos", "Show more sessions": "Mostrar más sesiones", "Unassigned project": "Proyecto sin asignar",
    },
    "pt-BR": {
      "Sign in": "Entrar", "Settings": "Configurações", "Back": "Voltar", "Back to sessions": "Voltar às sessões", "More": "Mais", "New conversation": "Nova conversa", "Switch device": "Trocar dispositivo", "Add device": "Adicionar dispositivo", "Refresh": "Atualizar", "Search sessions…": "Pesquisar sessões…", "No sessions on this device.": "Não há sessões neste dispositivo.", "Latest": "Mais recente", "Add attachment": "Adicionar anexo", "Choose model": "Escolher modelo", "Stop": "Parar", "Send": "Enviar", "Loading…": "Carregando…", "Cancel": "Cancelar", "Save": "Salvar", "Confirm": "Confirmar", "Done": "Concluído", "Copy": "Copiar", "Rename": "Renomear", "Delete (move to Trash)": "Excluir (mover para a lixeira)", "Models & providers": "Modelos e provedores", "Add provider": "Adicionar provedor", "Search providers…": "Pesquisar provedores…", "Choose a service": "Escolha um serviço", "Sign in with an account": "Entrar com uma conta", "Use an API key": "Usar uma chave de API", "Use directly": "Usar diretamente", "Custom provider": "Provedor personalizado", "Devices": "Dispositivos", "Connection": "Conexão", "This device": "Este dispositivo", "Total sessions": "Total de sessões", "Sign out": "Sair", "Interface": "Interface", "Language": "Idioma", "Appearance": "Aparência", "System": "Sistema", "Light": "Claro", "Dark": "Escuro", "Design theme": "Tema de design", "Compact list": "Lista compacta", "Text size": "Tamanho do texto", "Group by project": "Agrupar por projeto", "Reduce motion": "Reduzir movimento", "About": "Sobre", "Choose a project folder": "Escolher uma pasta de projeto", "Selected location": "Local selecionado", "Session name (optional)": "Nome da sessão (opcional)", "Start here": "Começar aqui", "Parent folder": "Pasta pai", "Home folder": "Pasta inicial", "Close": "Fechar", "Back to settings": "Voltar às configurações", "Toggle project grouping": "Alternar agrupamento por projeto", "Choose a folder from New project to begin": "Escolha uma pasta em New project para começar", "Jump to latest": "Ir para a mais recente", "Server default": "Padrão do servidor", "Thinking level": "Nível de raciocínio", "Conversation tools": "Ferramentas da conversa", "Agent is working": "O agente está trabalhando", "Select a session,": "Selecione uma sessão,", "or start a new conversation": "ou inicie uma nova conversa", "Copied": "Copiado", "Copy failed": "Falha ao copiar", "Model & reasoning": "Modelo e raciocínio", "Manage visible models and custom providers": "Gerenciar modelos visíveis e provedores personalizados", "Reload models": "Recarregar modelos", "Search providers or models…": "Pesquisar provedores ou modelos…", "Provider list": "Lista de provedores", "Back to provider list": "Voltar à lista de provedores", "For self-hosted endpoints or special APIs": "Para endpoints auto-hospedados ou APIs especiais", "Pi version": "Versão do Pi", "Desktop sidebar width": "Largura da barra lateral no desktop", "Thinking blocks": "Blocos de raciocínio", "Collapsed": "Recolhido", "Expanded": "Expandido", "Swipe gesture": "Gesto de deslize", "Enabled": "Ativado", "Gesture tips": "Dicas de gestos", "Restore interface defaults": "Restaurar padrões da interface", "Restore interface defaults? Sign-in and sessions will not be affected.": "Restaurar os padrões da interface? O login e as sessões não serão afetados.", "Image viewer": "Visualizador de imagens", "Close image": "Fechar imagem", "Your response is needed": "Sua resposta é necessária", "Show more": "Mostrar mais", "Show less": "Mostrar menos", "Show more sessions": "Mostrar mais sessões", "Unassigned project": "Projeto sem atribuição",
    },
    it: {
      "Sign in": "Accedi", "Settings": "Impostazioni", "Back": "Indietro", "Back to sessions": "Torna alle sessioni", "More": "Altro", "New conversation": "Nuova conversazione", "Switch device": "Cambia dispositivo", "Add device": "Aggiungi dispositivo", "Refresh": "Aggiorna", "Search sessions…": "Cerca sessioni…", "No sessions on this device.": "Nessuna sessione su questo dispositivo.", "Latest": "Più recente", "Add attachment": "Aggiungi allegato", "Choose model": "Scegli modello", "Stop": "Ferma", "Send": "Invia", "Loading…": "Caricamento…", "Cancel": "Annulla", "Save": "Salva", "Confirm": "Conferma", "Done": "Fatto", "Copy": "Copia", "Rename": "Rinomina", "Delete (move to Trash)": "Elimina (sposta nel Cestino)", "Models & providers": "Modelli e provider", "Add provider": "Aggiungi provider", "Search providers…": "Cerca provider…", "Choose a service": "Scegli un servizio", "Sign in with an account": "Accedi con un account", "Use an API key": "Usa una chiave API", "Use directly": "Usa direttamente", "Custom provider": "Provider personalizzato", "Devices": "Dispositivi", "Connection": "Connessione", "This device": "Questo dispositivo", "Total sessions": "Sessioni totali", "Sign out": "Esci", "Interface": "Interfaccia", "Language": "Lingua", "Appearance": "Aspetto", "System": "Sistema", "Light": "Chiaro", "Dark": "Scuro", "Design theme": "Tema di design", "Compact list": "Elenco compatto", "Text size": "Dimensione testo", "Group by project": "Raggruppa per progetto", "Reduce motion": "Riduci movimento", "About": "Informazioni", "Choose a project folder": "Scegli una cartella progetto", "Selected location": "Posizione selezionata", "Session name (optional)": "Nome sessione (facoltativo)", "Start here": "Inizia qui", "Parent folder": "Cartella principale", "Home folder": "Cartella home", "Close": "Chiudi", "Back to settings": "Torna alle impostazioni", "Toggle project grouping": "Attiva/disattiva il raggruppamento per progetto", "Choose a folder from New project to begin": "Scegli una cartella da New project per iniziare", "Jump to latest": "Vai all’ultimo elemento", "Server default": "Predefinito del server", "Thinking level": "Livello di ragionamento", "Conversation tools": "Strumenti della conversazione", "Agent is working": "L’agente è al lavoro", "Select a session,": "Seleziona una sessione,", "or start a new conversation": "oppure inizia una nuova conversazione", "Copied": "Copiato", "Copy failed": "Copia non riuscita", "Model & reasoning": "Modello e ragionamento", "Manage visible models and custom providers": "Gestisci modelli visibili e provider personalizzati", "Reload models": "Ricarica modelli", "Search providers or models…": "Cerca provider o modelli…", "Provider list": "Elenco provider", "Back to provider list": "Torna all’elenco provider", "For self-hosted endpoints or special APIs": "Per endpoint self-hosted o API speciali", "Pi version": "Versione di Pi", "Desktop sidebar width": "Larghezza della barra laterale desktop", "Thinking blocks": "Blocchi di ragionamento", "Collapsed": "Compresso", "Expanded": "Espanso", "Swipe gesture": "Gesto di scorrimento", "Enabled": "Attivato", "Gesture tips": "Suggerimenti sui gesti", "Restore interface defaults": "Ripristina impostazioni predefinite dell’interfaccia", "Restore interface defaults? Sign-in and sessions will not be affected.": "Ripristinare le impostazioni predefinite dell’interfaccia? L’accesso e le sessioni non saranno interessati.", "Image viewer": "Visualizzatore di immagini", "Close image": "Chiudi immagine", "Your response is needed": "Serve una risposta", "Show more": "Mostra altro", "Show less": "Mostra meno", "Show more sessions": "Mostra altre sessioni", "Unassigned project": "Progetto non assegnato",
    },
  };
  const PROJECT_ACTION_TRANSLATIONS = {
    en: {
      "PROJECT": "PROJECT", "Project": "Project", "Pin": "Pin", "Unpin": "Unpin", "Edit project": "Edit project", "Project name": "Project name", "Reveal in Finder": "Reveal in Finder", "Create permanent worktree": "Create permanent worktree", "Archive chats": "Archive chats", "Remove project": "Remove project", "New session in project": "New session in project", "More project actions": "More project actions", "Project pinned": "Project pinned", "Project unpinned": "Project unpinned", "Project renamed": "Project renamed", "Opened in Finder": "Opened in Finder", "Permanent worktree created": "Permanent worktree created", "Archived chats": "Archived chats", "Project removed": "Project removed", "Could not reveal project": "Could not reveal project", "Could not create worktree": "Could not create worktree", "Could not archive chats": "Could not archive chats", "Create a permanent worktree for this project?": "Create a permanent worktree for this project?", "Archive this project's chats?": "Archive this project's chats?", "Remove this project from the list? Chats remain on disk.": "Remove this project from the list? Chats remain on disk.", "Project folder is unavailable": "Project folder is unavailable",
    },
    "zh-Hant": {
      "PROJECT": "專案", "Project": "專案", "Pin": "釘選", "Unpin": "取消釘選", "Edit project": "編輯專案", "Project name": "專案名稱", "Reveal in Finder": "在 Finder 顯示", "Create permanent worktree": "建立永久 worktree", "Archive chats": "封存對話", "Remove project": "移除專案", "New session in project": "在此專案新增工作階段", "More project actions": "更多專案操作", "Project pinned": "專案已釘選", "Project unpinned": "專案已取消釘選", "Project renamed": "專案已重新命名", "Opened in Finder": "已在 Finder 開啟", "Permanent worktree created": "永久 worktree 已建立", "Archived chats": "已封存對話", "Project removed": "專案已移除", "Could not reveal project": "無法在 Finder 顯示專案", "Could not create worktree": "無法建立 worktree", "Could not archive chats": "無法封存對話", "Create a permanent worktree for this project?": "要為此專案建立永久 worktree 嗎？", "Archive this project's chats?": "要封存此專案的對話嗎？", "Remove this project from the list? Chats remain on disk.": "要從列表移除這個專案嗎？對話仍會保留在磁碟上。", "Project folder is unavailable": "專案資料夾無法使用",
    },
    "zh-Hans": {
      "PROJECT": "项目", "Project": "项目", "Pin": "置顶", "Unpin": "取消置顶", "Edit project": "编辑项目", "Project name": "项目名称", "Reveal in Finder": "在 Finder 中显示", "Create permanent worktree": "创建永久 worktree", "Archive chats": "归档对话", "Remove project": "移除项目", "New session in project": "在此项目中新建会话", "More project actions": "更多项目操作", "Project pinned": "项目已置顶", "Project unpinned": "项目已取消置顶", "Project renamed": "项目已重命名", "Opened in Finder": "已在 Finder 中打开", "Permanent worktree created": "永久 worktree 已创建", "Archived chats": "对话已归档", "Project removed": "项目已移除", "Could not reveal project": "无法在 Finder 中显示项目", "Could not create worktree": "无法创建 worktree", "Could not archive chats": "无法归档对话", "Create a permanent worktree for this project?": "要为此项目创建永久 worktree 吗？", "Archive this project's chats?": "要归档此项目的对话吗？", "Remove this project from the list? Chats remain on disk.": "要从列表移除此项目吗？对话仍会保留在磁盘中。", "Project folder is unavailable": "项目文件夹不可用",
    },
    ja: {
      "PROJECT": "プロジェクト", "Project": "プロジェクト", "Pin": "ピン留め", "Unpin": "ピン留めを解除", "Edit project": "プロジェクトを編集", "Project name": "プロジェクト名", "Reveal in Finder": "Finder で表示", "Create permanent worktree": "永続 worktree を作成", "Archive chats": "会話をアーカイブ", "Remove project": "プロジェクトを削除", "New session in project": "このプロジェクトで新しいセッション", "More project actions": "その他のプロジェクト操作", "Project pinned": "プロジェクトをピン留めしました", "Project unpinned": "ピン留めを解除しました", "Project renamed": "プロジェクト名を変更しました", "Opened in Finder": "Finder で開きました", "Permanent worktree created": "永続 worktree を作成しました", "Archived chats": "会話をアーカイブしました", "Project removed": "プロジェクトを削除しました", "Could not reveal project": "Finder でプロジェクトを表示できません", "Could not create worktree": "worktree を作成できません", "Could not archive chats": "会話をアーカイブできません", "Create a permanent worktree for this project?": "このプロジェクトに永続 worktree を作成しますか？", "Archive this project's chats?": "このプロジェクトの会話をアーカイブしますか？", "Remove this project from the list? Chats remain on disk.": "このプロジェクトを一覧から削除しますか？会話はディスクに残ります。", "Project folder is unavailable": "プロジェクトフォルダーを利用できません",
    },
    ko: {
      "PROJECT": "프로젝트", "Project": "프로젝트", "Pin": "고정", "Unpin": "고정 해제", "Edit project": "프로젝트 편집", "Project name": "프로젝트 이름", "Reveal in Finder": "Finder에서 보기", "Create permanent worktree": "영구 worktree 만들기", "Archive chats": "대화 보관", "Remove project": "프로젝트 제거", "New session in project": "이 프로젝트에서 새 세션", "More project actions": "프로젝트 추가 작업", "Project pinned": "프로젝트를 고정했습니다", "Project unpinned": "프로젝트 고정을 해제했습니다", "Project renamed": "프로젝트 이름을 변경했습니다", "Opened in Finder": "Finder에서 열었습니다", "Permanent worktree created": "영구 worktree를 만들었습니다", "Archived chats": "대화를 보관했습니다", "Project removed": "프로젝트를 제거했습니다", "Could not reveal project": "Finder에서 프로젝트를 표시할 수 없습니다", "Could not create worktree": "worktree를 만들 수 없습니다", "Could not archive chats": "대화를 보관할 수 없습니다", "Create a permanent worktree for this project?": "이 프로젝트에 영구 worktree를 만들까요?", "Archive this project's chats?": "이 프로젝트의 대화를 보관할까요?", "Remove this project from the list? Chats remain on disk.": "목록에서 이 프로젝트를 제거할까요? 대화는 디스크에 남습니다.", "Project folder is unavailable": "프로젝트 폴더를 사용할 수 없습니다",
    },
    tr: { "PROJECT": "PROJE", "Project": "Proje", "Pin": "Sabitle", "Unpin": "Sabitlemeyi kaldır", "Edit project": "Projeyi düzenle", "Project name": "Proje adı", "Reveal in Finder": "Finder'da göster", "Create permanent worktree": "Kalıcı worktree oluştur", "Archive chats": "Sohbetleri arşivle", "Remove project": "Projeyi kaldır", "New session in project": "Bu projede yeni oturum", "More project actions": "Diğer proje işlemleri", "Project pinned": "Proje sabitlendi", "Project unpinned": "Proje sabitlemesi kaldırıldı", "Project renamed": "Proje yeniden adlandırıldı", "Opened in Finder": "Finder'da açıldı", "Permanent worktree created": "Kalıcı worktree oluşturuldu", "Archived chats": "Sohbetler arşivlendi", "Project removed": "Proje kaldırıldı", "Could not reveal project": "Proje Finder'da gösterilemedi", "Could not create worktree": "Worktree oluşturulamadı", "Could not archive chats": "Sohbetler arşivlenemedi", "Create a permanent worktree for this project?": "Bu proje için kalıcı worktree oluşturulsun mu?", "Archive this project's chats?": "Bu projenin sohbetleri arşivlensin mi?", "Remove this project from the list? Chats remain on disk.": "Bu proje listeden kaldırılsın mı? Sohbetler diskte kalır.", "Project folder is unavailable": "Proje klasörü kullanılamıyor" },
    fr: { "PROJECT": "PROJET", "Project": "Projet", "Pin": "Épingler", "Unpin": "Désépingler", "Edit project": "Modifier le projet", "Project name": "Nom du projet", "Reveal in Finder": "Afficher dans le Finder", "Create permanent worktree": "Créer un worktree permanent", "Archive chats": "Archiver les conversations", "Remove project": "Supprimer le projet", "New session in project": "Nouvelle session dans ce projet", "More project actions": "Autres actions du projet", "Project pinned": "Projet épinglé", "Project unpinned": "Projet désépinglé", "Project renamed": "Projet renommé", "Opened in Finder": "Ouvert dans le Finder", "Permanent worktree created": "Worktree permanent créé", "Archived chats": "Conversations archivées", "Project removed": "Projet supprimé", "Could not reveal project": "Impossible d’afficher le projet dans le Finder", "Could not create worktree": "Impossible de créer le worktree", "Could not archive chats": "Impossible d’archiver les conversations", "Create a permanent worktree for this project?": "Créer un worktree permanent pour ce projet ?", "Archive this project's chats?": "Archiver les conversations de ce projet ?", "Remove this project from the list? Chats remain on disk.": "Supprimer ce projet de la liste ? Les conversations restent sur le disque.", "Project folder is unavailable": "Le dossier du projet est indisponible" },
    de: { "PROJECT": "PROJEKT", "Project": "Projekt", "Pin": "Anheften", "Unpin": "Lösen", "Edit project": "Projekt bearbeiten", "Project name": "Projektname", "Reveal in Finder": "Im Finder anzeigen", "Create permanent worktree": "Permanenten Worktree erstellen", "Archive chats": "Chats archivieren", "Remove project": "Projekt entfernen", "New session in project": "Neue Sitzung in diesem Projekt", "More project actions": "Weitere Projektaktionen", "Project pinned": "Projekt angeheftet", "Project unpinned": "Projekt gelöst", "Project renamed": "Projekt umbenannt", "Opened in Finder": "Im Finder geöffnet", "Permanent worktree created": "Permanenter Worktree erstellt", "Archived chats": "Chats archiviert", "Project removed": "Projekt entfernt", "Could not reveal project": "Projekt kann nicht im Finder angezeigt werden", "Could not create worktree": "Worktree konnte nicht erstellt werden", "Could not archive chats": "Chats konnten nicht archiviert werden", "Create a permanent worktree for this project?": "Permanenten Worktree für dieses Projekt erstellen?", "Archive this project's chats?": "Chats dieses Projekts archivieren?", "Remove this project from the list? Chats remain on disk.": "Dieses Projekt aus der Liste entfernen? Chats bleiben auf der Festplatte.", "Project folder is unavailable": "Projektordner ist nicht verfügbar" },
    es: { "PROJECT": "PROYECTO", "Project": "Proyecto", "Pin": "Fijar", "Unpin": "Desfijar", "Edit project": "Editar proyecto", "Project name": "Nombre del proyecto", "Reveal in Finder": "Mostrar en Finder", "Create permanent worktree": "Crear worktree permanente", "Archive chats": "Archivar chats", "Remove project": "Quitar proyecto", "New session in project": "Nueva sesión en este proyecto", "More project actions": "Más acciones del proyecto", "Project pinned": "Proyecto fijado", "Project unpinned": "Proyecto desfijado", "Project renamed": "Proyecto renombrado", "Opened in Finder": "Abierto en Finder", "Permanent worktree created": "Worktree permanente creado", "Archived chats": "Chats archivados", "Project removed": "Proyecto eliminado", "Could not reveal project": "No se pudo mostrar el proyecto en Finder", "Could not create worktree": "No se pudo crear el worktree", "Could not archive chats": "No se pudieron archivar los chats", "Create a permanent worktree for this project?": "¿Crear un worktree permanente para este proyecto?", "Archive this project's chats?": "¿Archivar los chats de este proyecto?", "Remove this project from the list? Chats remain on disk.": "¿Quitar este proyecto de la lista? Los chats permanecen en el disco.", "Project folder is unavailable": "La carpeta del proyecto no está disponible" },
    "pt-BR": { "PROJECT": "PROJETO", "Project": "Projeto", "Pin": "Fixar", "Unpin": "Desafixar", "Edit project": "Editar projeto", "Project name": "Nome do projeto", "Reveal in Finder": "Mostrar no Finder", "Create permanent worktree": "Criar worktree permanente", "Archive chats": "Arquivar conversas", "Remove project": "Remover projeto", "New session in project": "Nova sessão neste projeto", "More project actions": "Mais ações do projeto", "Project pinned": "Projeto fixado", "Project unpinned": "Projeto desafixado", "Project renamed": "Projeto renomeado", "Opened in Finder": "Aberto no Finder", "Permanent worktree created": "Worktree permanente criado", "Archived chats": "Conversas arquivadas", "Project removed": "Projeto removido", "Could not reveal project": "Não foi possível mostrar o projeto no Finder", "Could not create worktree": "Não foi possível criar o worktree", "Could not archive chats": "Não foi possível arquivar as conversas", "Create a permanent worktree for this project?": "Criar um worktree permanente para este projeto?", "Archive this project's chats?": "Arquivar as conversas deste projeto?", "Remove this project from the list? Chats remain on disk.": "Remover este projeto da lista? As conversas permanecem no disco.", "Project folder is unavailable": "A pasta do projeto não está disponível" },
    it: { "PROJECT": "PROGETTO", "Project": "Progetto", "Pin": "Fissa", "Unpin": "Rimuovi fissaggio", "Edit project": "Modifica progetto", "Project name": "Nome progetto", "Reveal in Finder": "Mostra nel Finder", "Create permanent worktree": "Crea worktree permanente", "Archive chats": "Archivia chat", "Remove project": "Rimuovi progetto", "New session in project": "Nuova sessione in questo progetto", "More project actions": "Altre azioni del progetto", "Project pinned": "Progetto fissato", "Project unpinned": "Fissaggio rimosso", "Project renamed": "Progetto rinominato", "Opened in Finder": "Aperto nel Finder", "Permanent worktree created": "Worktree permanente creato", "Archived chats": "Chat archiviate", "Project removed": "Progetto rimosso", "Could not reveal project": "Impossibile mostrare il progetto nel Finder", "Could not create worktree": "Impossibile creare il worktree", "Could not archive chats": "Impossibile archiviare le chat", "Create a permanent worktree for this project?": "Creare un worktree permanente per questo progetto?", "Archive this project's chats?": "Archiviare le chat di questo progetto?", "Remove this project from the list? Chats remain on disk.": "Rimuovere questo progetto dall’elenco? Le chat resteranno sul disco.", "Project folder is unavailable": "La cartella del progetto non è disponibile" },
  };
  for (const [id, table] of Object.entries(PROJECT_ACTION_TRANSLATIONS)) Object.assign(TRANSLATIONS[id], table);
  const PINNED_LABELS = {
    en: "Pinned", "zh-Hant": "已釘選", "zh-Hans": "已置顶", ja: "ピン留め", ko: "고정됨",
    tr: "Sabitlenenler", fr: "Épinglés", de: "Angeheftet", es: "Fijados", "pt-BR": "Fixados", it: "Fissati",
  };
  for (const [id, label] of Object.entries(PINNED_LABELS)) Object.assign(TRANSLATIONS[id], { Pinned: label });
  // The count suffix is emitted as a separate source fragment by the session
  // list renderer; keep it localized for every European locale.
  Object.assign(TRANSLATIONS.tr, { "Show more (": "Daha fazla göster (" });
  Object.assign(TRANSLATIONS.fr, { "Show more (": "Afficher plus (" });
  Object.assign(TRANSLATIONS.de, { "Show more (": "Mehr anzeigen (" });
  Object.assign(TRANSLATIONS.es, { "Show more (": "Mostrar más (" });
  Object.assign(TRANSLATIONS["pt-BR"], { "Show more (": "Mostrar mais (" });
  Object.assign(TRANSLATIONS.it, { "Show more (": "Mostra altro (" });

  // Static HTML chrome is localized through the same source-key registry as
  // dynamic app messages. Keeping this small shared registry here prevents
  // the first render from leaking English when the user has selected another
  // locale, while content generated by Pi remains untouched.
  const STATIC_UI_TRANSLATIONS = {
    en: {
      "New project": "New project", "Choose a folder to start a conversation": "Choose a folder to start a conversation", "Sessions": "Sessions", "Search sessions…": "Search sessions…", "No sessions on this device.": "No sessions on this device.", "Message pi… (/ for commands, paste images directly)": "Message pi… (/ for commands, paste images directly)", "Updates": "Updates", "Automatic updates": "Automatic updates", "Check for updates": "Check for updates", "New name": "New name", "Choose a folder": "Choose a folder", "Save and check": "Save and check", "Show Sub Agent sessions": "Show Sub Agent sessions", "Hide Sub Agent sessions": "Hide Sub Agent sessions", "Temporary workspaces are hidden by default": "Temporary workspaces are hidden by default", "Temporary sessions: {count}": "Temporary sessions: {count}",
    },
    "zh-Hant": {
      "New project": "新增專案", "Choose a folder to start a conversation": "選擇資料夾開始對話", "Sessions": "工作階段", "Search sessions…": "搜尋工作階段…", "No sessions on this device.": "這台設備沒有工作階段。", "Message pi… (/ for commands, paste images directly)": "傳訊息給 pi…（/ 指令，可直接貼上圖片）", "Updates": "更新", "Automatic updates": "自動更新", "Check for updates": "檢查更新", "New name": "新名稱", "Choose a folder": "選擇資料夾", "Save and check": "儲存並檢查", "Show Sub Agent sessions": "顯示 Sub Agent 工作階段", "Hide Sub Agent sessions": "隱藏 Sub Agent 工作階段", "Temporary workspaces are hidden by default": "暫存工作區預設隱藏", "Temporary sessions: {count}": "暫存工作階段：{count} 個",
    },
    "zh-Hans": {
      "New project": "新建项目", "Choose a folder to start a conversation": "选择文件夹开始对话", "Sessions": "会话", "Search sessions…": "搜索会话…", "No sessions on this device.": "此设备没有会话。", "Message pi… (/ for commands, paste images directly)": "发送消息给 pi…（/ 指令，可直接粘贴图片）", "Updates": "更新", "Automatic updates": "自动更新", "Check for updates": "检查更新", "New name": "新名称", "Choose a folder": "选择文件夹", "Save and check": "保存并检查", "Show Sub Agent sessions": "显示 Sub Agent 会话", "Hide Sub Agent sessions": "隐藏 Sub Agent 会话", "Temporary workspaces are hidden by default": "临时工作区默认隐藏", "Temporary sessions: {count}": "临时会话：{count} 个",
    },
    ja: {
      "New project": "新しいプロジェクト", "Choose a folder to start a conversation": "フォルダーを選んで会話を開始", "Sessions": "セッション", "Search sessions…": "セッションを検索…", "No sessions on this device.": "このデバイスにセッションはありません。", "Message pi… (/ for commands, paste images directly)": "pi にメッセージ…（/ でコマンド、画像を直接貼り付け）", "Updates": "更新", "Automatic updates": "自動更新", "Check for updates": "更新を確認", "New name": "新しい名前", "Choose a folder": "フォルダーを選択", "Save and check": "保存して確認", "Show Sub Agent sessions": "Sub Agent のセッションを表示", "Hide Sub Agent sessions": "Sub Agent のセッションを非表示", "Temporary workspaces are hidden by default": "一時ワークスペースは既定で非表示です", "Temporary sessions: {count}": "一時セッション：{count} 件",
    },
    ko: {
      "New project": "새 프로젝트", "Choose a folder to start a conversation": "폴더를 선택하여 대화 시작", "Sessions": "세션", "Search sessions…": "세션 검색…", "No sessions on this device.": "이 기기에 세션이 없습니다.", "Message pi… (/ for commands, paste images directly)": "pi에게 메시지… (/ 명령, 이미지 직접 붙여넣기)", "Updates": "업데이트", "Automatic updates": "자동 업데이트", "Check for updates": "업데이트 확인", "New name": "새 이름", "Choose a folder": "폴더 선택", "Save and check": "저장하고 확인", "Show Sub Agent sessions": "Sub Agent 세션 표시", "Hide Sub Agent sessions": "Sub Agent 세션 숨기기", "Temporary workspaces are hidden by default": "임시 작업 공간은 기본적으로 숨겨집니다", "Temporary sessions: {count}": "임시 세션 {count}개",
    },
    tr: {
      "New project": "Yeni proje", "Choose a folder to start a conversation": "Bir klasör seçerek konuşma başlatın", "Sessions": "Oturumlar", "Search sessions…": "Oturumlarda ara…", "No sessions on this device.": "Bu cihazda oturum yok.", "Message pi… (/ for commands, paste images directly)": "pi'ye mesaj… (/ komutlar, görselleri doğrudan yapıştırın)", "Updates": "Güncellemeler", "Automatic updates": "Otomatik güncellemeler", "Check for updates": "Güncellemeleri denetle", "New name": "Yeni ad", "Choose a folder": "Klasör seç", "Save and check": "Kaydet ve denetle", "Show Sub Agent sessions": "Sub Agent oturumlarını göster", "Hide Sub Agent sessions": "Sub Agent oturumlarını gizle", "Temporary workspaces are hidden by default": "Geçici çalışma alanları varsayılan olarak gizlidir", "Temporary sessions: {count}": "Geçici oturum: {count}",
    },
    fr: {
      "New project": "Nouveau projet", "Choose a folder to start a conversation": "Choisissez un dossier pour commencer une conversation", "Sessions": "Sessions", "Search sessions…": "Rechercher des sessions…", "No sessions on this device.": "Aucune session sur cet appareil.", "Message pi… (/ for commands, paste images directly)": "Message à pi… (/ pour les commandes, collez directement des images)", "Updates": "Mises à jour", "Automatic updates": "Mises à jour automatiques", "Check for updates": "Rechercher des mises à jour", "New name": "Nouveau nom", "Choose a folder": "Choisir un dossier", "Save and check": "Enregistrer et vérifier", "Show Sub Agent sessions": "Afficher les sessions des Sub Agent", "Hide Sub Agent sessions": "Masquer les sessions des Sub Agent", "Temporary workspaces are hidden by default": "Les espaces de travail temporaires sont masqués par défaut", "Temporary sessions: {count}": "Sessions temporaires : {count}",
    },
    de: {
      "New project": "Neues Projekt", "Choose a folder to start a conversation": "Wählen Sie einen Ordner, um eine Unterhaltung zu beginnen", "Sessions": "Sitzungen", "Search sessions…": "Sitzungen durchsuchen…", "No sessions on this device.": "Keine Sitzungen auf diesem Gerät.", "Message pi… (/ for commands, paste images directly)": "Nachricht an pi… (/ für Befehle, Bilder direkt einfügen)", "Updates": "Aktualisierungen", "Automatic updates": "Automatische Aktualisierungen", "Check for updates": "Nach Aktualisierungen suchen", "New name": "Neuer Name", "Choose a folder": "Ordner auswählen", "Save and check": "Speichern und prüfen", "Show Sub Agent sessions": "Sub-Agent-Sitzungen anzeigen", "Hide Sub Agent sessions": "Sub-Agent-Sitzungen ausblenden", "Temporary workspaces are hidden by default": "Temporäre Arbeitsbereiche werden standardmäßig ausgeblendet", "Temporary sessions: {count}": "Temporäre Sitzungen: {count}",
    },
    es: {
      "New project": "Nuevo proyecto", "Choose a folder to start a conversation": "Elige una carpeta para iniciar una conversación", "Sessions": "Sesiones", "Search sessions…": "Buscar sesiones…", "No sessions on this device.": "No hay sesiones en este dispositivo.", "Message pi… (/ for commands, paste images directly)": "Mensaje para pi… (/ para comandos, pega imágenes directamente)", "Updates": "Actualizaciones", "Automatic updates": "Actualizaciones automáticas", "Check for updates": "Buscar actualizaciones", "New name": "Nombre nuevo", "Choose a folder": "Elegir una carpeta", "Save and check": "Guardar y comprobar", "Show Sub Agent sessions": "Mostrar sesiones de Sub Agent", "Hide Sub Agent sessions": "Ocultar sesiones de Sub Agent", "Temporary workspaces are hidden by default": "Los espacios de trabajo temporales están ocultos de forma predeterminada", "Temporary sessions: {count}": "Sesiones temporales: {count}",
    },
    "pt-BR": {
      "New project": "Novo projeto", "Choose a folder to start a conversation": "Escolha uma pasta para iniciar uma conversa", "Sessions": "Sessões", "Search sessions…": "Pesquisar sessões…", "No sessions on this device.": "Não há sessões neste dispositivo.", "Message pi… (/ for commands, paste images directly)": "Mensagem para pi… (/ para comandos, cole imagens diretamente)", "Updates": "Atualizações", "Automatic updates": "Atualizações automáticas", "Check for updates": "Verificar atualizações", "New name": "Novo nome", "Choose a folder": "Escolher uma pasta", "Save and check": "Salvar e verificar", "Show Sub Agent sessions": "Mostrar sessões do Sub Agent", "Hide Sub Agent sessions": "Ocultar sessões do Sub Agent", "Temporary workspaces are hidden by default": "Os espaços de trabalho temporários ficam ocultos por padrão", "Temporary sessions: {count}": "Sessões temporárias: {count}",
    },
    it: {
      "New project": "Nuovo progetto", "Choose a folder to start a conversation": "Scegli una cartella per iniziare una conversazione", "Sessions": "Sessioni", "Search sessions…": "Cerca sessioni…", "No sessions on this device.": "Nessuna sessione su questo dispositivo.", "Message pi… (/ for commands, paste images directly)": "Messaggio a pi… (/ per i comandi, incolla direttamente le immagini)", "Updates": "Aggiornamenti", "Automatic updates": "Aggiornamenti automatici", "Check for updates": "Controlla aggiornamenti", "New name": "Nuovo nome", "Choose a folder": "Scegli una cartella", "Save and check": "Salva e verifica", "Show Sub Agent sessions": "Mostra le sessioni dei Sub Agent", "Hide Sub Agent sessions": "Nascondi le sessioni dei Sub Agent", "Temporary workspaces are hidden by default": "Gli spazi di lavoro temporanei sono nascosti per impostazione predefinita", "Temporary sessions: {count}": "Sessioni temporanee: {count}",
    },
  };
  for (const [id, table] of Object.entries(STATIC_UI_TRANSLATIONS)) Object.assign(TRANSLATIONS[id], table);

  // The explanatory copy below is part of the application chrome rather than
  // session content. Keep it in the same source-key registry as button labels
  // so the subtitles stay in sync when the user switches locales repeatedly.
  // These four locales receive complete, natural translations here; provider
  // and model names remain product names and are intentionally not translated.
  const EAST_ASIAN_SUBTITLE_TRANSLATIONS = {
    en: {
      "To add another Pi Agent computer, run Pi Web there and enter its Tailscale or HTTPS address. You can also use a one-time pairing code. Both devices must use the same Web token.": "To add another Pi Agent computer, run Pi Web there and enter its Tailscale or HTTPS address. You can also use a one-time pairing code. Both devices must use the same Web token.",
      "Pi coding agent installed on this device": "Pi coding agent installed on this device",
      "All sessions on this device": "All sessions on this device",
      "Clear this browser's sign-in state": "Clear this browser's sign-in state",
      "Check GitHub and update this device periodically": "Check GitHub and update this device periodically",
      "Checking updater status…": "Checking updater status…",
      "Choose the language used by Pi Web": "Choose the language used by Pi Web",
      "Light, dark, or follow system": "Light, dark, or follow system",
      "Choose a complete colour system": "Choose a complete colour system",
      "Show sessions with less spacing": "Show sessions with less spacing",
      "Desktop only; mobile always uses full width": "Desktop only; mobile always uses full width",
      "Adjust interface text for readability": "Adjust interface text for readability",
      "Group sessions by working directory": "Group sessions by working directory",
      "Reduce transitions and scrolling animations": "Reduce transitions and scrolling animations",
      "Default state for assistant thinking blocks": "Default state for assistant thinking blocks",
      "Swipe from the left edge in a conversation to go back": "Swipe from the left edge in a conversation to go back",
      "Mobile-first remote workspace for Pi": "Mobile-first remote workspace for Pi",
      "Pull down to refresh; swipe from the left edge to go back; long-press a session to rename or delete": "Pull down to refresh; swipe from the left edge to go back; long-press a session to rename or delete",
      "Clear theme, density, and model visibility preferences": "Clear theme, density, and model visibility preferences",
      "Manage visible models and custom providers in one list.": "Manage visible models and custom providers in one list.",
      "Each device must run Pi Web (default port 3140) with this Web token. Use a Tailscale Serve or HTTPS URL reachable from this device.": "Each device must run Pi Web (default port 3140) with this Web token. Use a Tailscale Serve or HTTPS URL reachable from this device.",
      "Generate a pairing code in the other Pi Web device settings and paste it here. Codes expire after 5 minutes and can only be used once.": "Generate a pairing code in the other Pi Web device settings and paste it here. Codes expire after 5 minutes and can only be used once.",
      "Choose a service, then sign in or provide an API key. Pi handles the technical setup.": "Choose a service, then sign in or provide an API key. Pi handles the technical setup.",
      "Open the official sign-in flow; credentials stay on this device": "Open the official sign-in flow; credentials stay on this device",
      "Paste a key from this service and Pi will configure it": "Paste a key from this service and Pi will configure it",
      "The key is stored only on this device. Pi will validate it and load available models.": "The key is stored only on this device. Pi will validate it and load available models.",
      "No account or API key required; Pi reads local models": "No account or API key required; Pi reads local models",
      "Advanced settings are saved in ": "Advanced settings are saved in ",
      "For regular services, go back and choose one instead.": "For regular services, go back and choose one instead.",
      "The device will be added after saving.": "The device will be added after saving.",
      "PI REQUEST": "PI REQUEST",
      "NEW PROJECT": "NEW PROJECT",
      "Session": "Session",
      "⚡ Model & reasoning…": "⚡ Model & reasoning…",
      "✏️ Rename": "✏️ Rename",
      "🗑 Delete (move to Trash)": "🗑 Delete (move to Trash)",
    },
    "zh-Hant": {
      "To add another Pi Agent computer, run Pi Web there and enter its Tailscale or HTTPS address. You can also use a one-time pairing code. Both devices must use the same Web token.": "若要新增其他 Pi Agent 電腦，請先在該電腦執行 Pi Web，然後輸入它的 Tailscale 或 HTTPS 位址。也可以使用一次性配對碼。兩台裝置必須使用相同的 Web token。",
      "Pi coding agent installed on this device": "這台裝置上的 Pi coding agent",
      "All sessions on this device": "這台裝置上的所有工作階段",
      "Clear this browser's sign-in state": "清除這個瀏覽器的登入狀態",
      "Check GitHub and update this device periodically": "定期檢查 GitHub 並更新這台裝置",
      "Checking updater status…": "正在檢查更新工具狀態…",
      "Choose the language used by Pi Web": "選擇 Pi Web 使用的語言",
      "Light, dark, or follow system": "亮色、暗色或跟隨系統",
      "Choose a complete colour system": "選擇完整的色彩系統",
      "Show sessions with less spacing": "用較小的間距顯示工作階段",
      "Desktop only; mobile always uses full width": "僅適用於桌面；手機版一律使用全寬",
      "Adjust interface text for readability": "調整介面文字大小以便閱讀",
      "Group sessions by working directory": "依工作目錄將工作階段分組",
      "Reduce transitions and scrolling animations": "減少轉場與捲動動畫",
      "Default state for assistant thinking blocks": "助理思考區塊的預設狀態",
      "Swipe from the left edge in a conversation to go back": "在對話中從左側邊緣滑動即可返回",
      "Mobile-first remote workspace for Pi": "以行動裝置優先打造的 Pi 遠端工作區",
      "Pull down to refresh; swipe from the left edge to go back; long-press a session to rename or delete": "下拉重新整理；從左側邊緣向右滑返回；長按工作階段可重新命名或刪除",
      "Clear theme, density, and model visibility preferences": "清除主題、密度與模型顯示偏好",
      "Manage visible models and custom providers in one list.": "在同一份清單中管理可見模型與自訂 Provider。",
      "Each device must run Pi Web (default port 3140) with this Web token. Use a Tailscale Serve or HTTPS URL reachable from this device.": "每台裝置都必須執行 Pi Web（預設 port 3140）並使用這個 Web token。請使用本裝置可連線的 Tailscale Serve 或 HTTPS 位址。",
      "Generate a pairing code in the other Pi Web device settings and paste it here. Codes expire after 5 minutes and can only be used once.": "請在另一台 Pi Web 的裝置設定中產生配對碼，貼到這裡。配對碼 5 分鐘後過期，且只能使用一次。",
      "Choose a service, then sign in or provide an API key. Pi handles the technical setup.": "選擇服務後登入帳號或提供 API key，技術設定會由 Pi 自動處理。",
      "Open the official sign-in flow; credentials stay on this device": "開啟官方登入流程；憑證會保留在這台裝置上",
      "Paste a key from this service and Pi will configure it": "貼上這項服務的 key，Pi 會自動完成設定",
      "The key is stored only on this device. Pi will validate it and load available models.": "key 只會儲存在這台裝置上。Pi 會驗證 key 並載入可用模型。",
      "No account or API key required; Pi reads local models": "不需要帳號或 API key；Pi 會讀取本機模型",
      "Advanced settings are saved in ": "進階設定會儲存在 ",
      "For regular services, go back and choose one instead.": "一般服務請返回上一頁選擇，不需要填寫這些欄位。",
      "The device will be added after saving.": "儲存後會自動加入裝置清單。",
      "PI REQUEST": "PI REQUEST",
      "NEW PROJECT": "新專案",
      "Session": "工作階段",
      "⚡ Model & reasoning…": "⚡ 模型與推理…",
      "✏️ Rename": "✏️ 重新命名",
      "🗑 Delete (move to Trash)": "🗑 刪除（移到垃圾桶）",
    },
    "zh-Hans": {
      "To add another Pi Agent computer, run Pi Web there and enter its Tailscale or HTTPS address. You can also use a one-time pairing code. Both devices must use the same Web token.": "要添加其他 Pi Agent 电脑，请先在那台电脑运行 Pi Web，然后输入它的 Tailscale 或 HTTPS 地址。也可以使用一次性配对码。两台设备必须使用相同的 Web token。",
      "Pi coding agent installed on this device": "此设备上安装的 Pi coding agent",
      "All sessions on this device": "此设备上的所有会话",
      "Clear this browser's sign-in state": "清除此浏览器的登录状态",
      "Check GitHub and update this device periodically": "定期检查 GitHub 并更新此设备",
      "Checking updater status…": "正在检查更新工具状态…",
      "Choose the language used by Pi Web": "选择 Pi Web 使用的语言",
      "Light, dark, or follow system": "浅色、深色或跟随系统",
      "Choose a complete colour system": "选择完整的色彩系统",
      "Show sessions with less spacing": "以更小的间距显示会话",
      "Desktop only; mobile always uses full width": "仅适用于桌面端；移动端始终使用全宽",
      "Adjust interface text for readability": "调整界面文字大小以便阅读",
      "Group sessions by working directory": "按工作目录将会话分组",
      "Reduce transitions and scrolling animations": "减少过渡和滚动动画",
      "Default state for assistant thinking blocks": "助手思考区块的默认状态",
      "Swipe from the left edge in a conversation to go back": "在对话中从左侧边缘滑动即可返回",
      "Mobile-first remote workspace for Pi": "以移动端优先打造的 Pi 远程工作区",
      "Pull down to refresh; swipe from the left edge to go back; long-press a session to rename or delete": "下拉刷新；从左侧边缘向右滑返回；长按会话可重命名或删除",
      "Clear theme, density, and model visibility preferences": "清除主题、密度和模型显示偏好",
      "Manage visible models and custom providers in one list.": "在同一列表中管理可见模型和自定义 Provider。",
      "Each device must run Pi Web (default port 3140) with this Web token. Use a Tailscale Serve or HTTPS URL reachable from this device.": "每台设备都必须运行 Pi Web（默认端口 3140）并使用此 Web token。请使用此设备可以访问的 Tailscale Serve 或 HTTPS 地址。",
      "Generate a pairing code in the other Pi Web device settings and paste it here. Codes expire after 5 minutes and can only be used once.": "请在另一台 Pi Web 的设备设置中生成配对码并粘贴到这里。配对码 5 分钟后过期，且只能使用一次。",
      "Choose a service, then sign in or provide an API key. Pi handles the technical setup.": "选择服务后登录账号或提供 API key，技术设置由 Pi 自动处理。",
      "Open the official sign-in flow; credentials stay on this device": "打开官方登录流程；凭证会保留在此设备上",
      "Paste a key from this service and Pi will configure it": "粘贴此服务的 key，Pi 会自动完成配置",
      "The key is stored only on this device. Pi will validate it and load available models.": "key 只会存储在此设备上。Pi 会验证 key 并加载可用模型。",
      "No account or API key required; Pi reads local models": "无需账号或 API key；Pi 会读取本地模型",
      "Advanced settings are saved in ": "高级设置保存在 ",
      "For regular services, go back and choose one instead.": "普通服务请返回上一步选择，无需填写这些字段。",
      "The device will be added after saving.": "保存后设备会自动加入列表。",
      "PI REQUEST": "PI REQUEST",
      "NEW PROJECT": "新建项目",
      "Session": "会话",
      "⚡ Model & reasoning…": "⚡ 模型与推理…",
      "✏️ Rename": "✏️ 重命名",
      "🗑 Delete (move to Trash)": "🗑 删除（移到废纸篓）",
    },
    ja: {
      "To add another Pi Agent computer, run Pi Web there and enter its Tailscale or HTTPS address. You can also use a one-time pairing code. Both devices must use the same Web token.": "別の Pi Agent コンピューターを追加するには、そのコンピューターで Pi Web を起動し、Tailscale または HTTPS アドレスを入力してください。ワンタイムのペアリングコードも使用できます。両方のデバイスで同じ Web トークンを使う必要があります。",
      "Pi coding agent installed on this device": "このデバイスにインストールされている Pi coding agent",
      "All sessions on this device": "このデバイスのすべてのセッション",
      "Clear this browser's sign-in state": "このブラウザーのサインイン状態を消去",
      "Check GitHub and update this device periodically": "GitHub を定期的に確認してこのデバイスを更新",
      "Checking updater status…": "アップデーターの状態を確認中…",
      "Choose the language used by Pi Web": "Pi Web で使用する言語を選択",
      "Light, dark, or follow system": "ライト、ダーク、またはシステムに合わせる",
      "Choose a complete colour system": "カラーパレット全体を選択",
      "Show sessions with less spacing": "間隔を狭くしてセッションを表示",
      "Desktop only; mobile always uses full width": "デスクトップのみ。モバイルでは常に全幅を使用",
      "Adjust interface text for readability": "読みやすいようにインターフェースの文字サイズを調整",
      "Group sessions by working directory": "作業ディレクトリごとにセッションをグループ化",
      "Reduce transitions and scrolling animations": "トランジションとスクロールアニメーションを減らす",
      "Default state for assistant thinking blocks": "アシスタントの思考ブロックの既定状態",
      "Swipe from the left edge in a conversation to go back": "会話中に左端からスワイプして戻る",
      "Mobile-first remote workspace for Pi": "Pi のモバイル優先リモートワークスペース",
      "Pull down to refresh; swipe from the left edge to go back; long-press a session to rename or delete": "下に引いて更新。左端からスワイプして戻る。セッションを長押しすると名前変更または削除できます",
      "Clear theme, density, and model visibility preferences": "テーマ、密度、モデル表示の設定を消去",
      "Manage visible models and custom providers in one list.": "表示するモデルとカスタムプロバイダーを 1 つのリストで管理します。",
      "Each device must run Pi Web (default port 3140) with this Web token. Use a Tailscale Serve or HTTPS URL reachable from this device.": "各デバイスで Pi Web（既定ポート 3140）をこの Web トークンで実行してください。このデバイスから到達できる Tailscale Serve または HTTPS URL を使用します。",
      "Generate a pairing code in the other Pi Web device settings and paste it here. Codes expire after 5 minutes and can only be used once.": "別の Pi Web デバイス設定でペアリングコードを生成し、ここに貼り付けてください。コードの有効期限は 5 分で、一度しか使えません。",
      "Choose a service, then sign in or provide an API key. Pi handles the technical setup.": "サービスを選択し、アカウントでサインインするか API キーを入力してください。技術的な設定は Pi が処理します。",
      "Open the official sign-in flow; credentials stay on this device": "公式サインインフローを開きます。認証情報はこのデバイスに保存されます",
      "Paste a key from this service and Pi will configure it": "このサービスのキーを貼り付けると、Pi が設定します",
      "The key is stored only on this device. Pi will validate it and load available models.": "キーはこのデバイスにのみ保存されます。Pi が検証して利用可能なモデルを読み込みます。",
      "No account or API key required; Pi reads local models": "アカウントも API キーも不要。Pi がローカルモデルを読み込みます",
      "Advanced settings are saved in ": "詳細設定は ",
      "For regular services, go back and choose one instead.": "通常のサービスは前の画面に戻って選択してください。",
      "The device will be added after saving.": "保存するとデバイスが追加されます。",
      "PI REQUEST": "PI REQUEST",
      "NEW PROJECT": "新しいプロジェクト",
      "Session": "セッション",
      "⚡ Model & reasoning…": "⚡ モデルと推論…",
      "✏️ Rename": "✏️ 名前を変更",
      "🗑 Delete (move to Trash)": "🗑 削除（ゴミ箱へ）",
    },
    ko: {
      "To add another Pi Agent computer, run Pi Web there and enter its Tailscale or HTTPS address. You can also use a one-time pairing code. Both devices must use the same Web token.": "다른 Pi Agent 컴퓨터를 추가하려면 해당 컴퓨터에서 Pi Web을 실행하고 Tailscale 또는 HTTPS 주소를 입력하세요. 일회용 페어링 코드도 사용할 수 있습니다. 두 기기 모두 같은 Web 토큰을 사용해야 합니다.",
      "Pi coding agent installed on this device": "이 기기에 설치된 Pi coding agent",
      "All sessions on this device": "이 기기의 모든 세션",
      "Clear this browser's sign-in state": "이 브라우저의 로그인 상태 지우기",
      "Check GitHub and update this device periodically": "GitHub를 주기적으로 확인하여 이 기기 업데이트",
      "Checking updater status…": "업데이트 도구 상태 확인 중…",
      "Choose the language used by Pi Web": "Pi Web에서 사용할 언어 선택",
      "Light, dark, or follow system": "밝게, 어둡게 또는 시스템 설정 따르기",
      "Choose a complete colour system": "전체 색상 시스템 선택",
      "Show sessions with less spacing": "간격을 줄여 세션 표시",
      "Desktop only; mobile always uses full width": "데스크톱 전용이며 모바일에서는 항상 전체 너비를 사용합니다",
      "Adjust interface text for readability": "읽기 쉽도록 인터페이스 글자 크기 조정",
      "Group sessions by working directory": "작업 디렉터리별로 세션 그룹화",
      "Reduce transitions and scrolling animations": "전환 및 스크롤 애니메이션 줄이기",
      "Default state for assistant thinking blocks": "어시스턴트 사고 블록의 기본 상태",
      "Swipe from the left edge in a conversation to go back": "대화 중 왼쪽 가장자리에서 밀어 뒤로 이동",
      "Mobile-first remote workspace for Pi": "모바일 우선 Pi 원격 작업 공간",
      "Pull down to refresh; swipe from the left edge to go back; long-press a session to rename or delete": "아래로 당겨 새로 고침하고, 왼쪽 가장자리에서 밀어 뒤로 이동하세요. 세션을 길게 누르면 이름을 바꾸거나 삭제할 수 있습니다",
      "Clear theme, density, and model visibility preferences": "테마, 밀도 및 모델 표시 설정 지우기",
      "Manage visible models and custom providers in one list.": "표시할 모델과 사용자 지정 Provider를 한 목록에서 관리합니다.",
      "Each device must run Pi Web (default port 3140) with this Web token. Use a Tailscale Serve or HTTPS URL reachable from this device.": "각 기기에서 이 Web 토큰으로 Pi Web(기본 포트 3140)을 실행해야 합니다. 이 기기에서 연결할 수 있는 Tailscale Serve 또는 HTTPS URL을 사용하세요.",
      "Generate a pairing code in the other Pi Web device settings and paste it here. Codes expire after 5 minutes and can only be used once.": "다른 Pi Web의 기기 설정에서 페어링 코드를 생성하여 여기에 붙여넣으세요. 코드는 5분 후 만료되며 한 번만 사용할 수 있습니다.",
      "Choose a service, then sign in or provide an API key. Pi handles the technical setup.": "서비스를 선택한 다음 계정으로 로그인하거나 API 키를 입력하세요. 기술 설정은 Pi가 처리합니다.",
      "Open the official sign-in flow; credentials stay on this device": "공식 로그인 절차를 엽니다. 인증 정보는 이 기기에 보관됩니다",
      "Paste a key from this service and Pi will configure it": "이 서비스의 키를 붙여넣으면 Pi가 설정합니다",
      "The key is stored only on this device. Pi will validate it and load available models.": "키는 이 기기에만 저장됩니다. Pi가 키를 확인하고 사용 가능한 모델을 불러옵니다.",
      "No account or API key required; Pi reads local models": "계정이나 API 키가 필요하지 않습니다. Pi가 로컬 모델을 읽습니다",
      "Advanced settings are saved in ": "고급 설정은 ",
      "For regular services, go back and choose one instead.": "일반 서비스는 이전 단계로 돌아가 선택하세요.",
      "The device will be added after saving.": "저장하면 기기가 목록에 추가됩니다.",
      "PI REQUEST": "PI REQUEST",
      "NEW PROJECT": "새 프로젝트",
      "Session": "세션",
      "⚡ Model & reasoning…": "⚡ 모델 및 추론…",
      "✏️ Rename": "✏️ 이름 변경",
      "🗑 Delete (move to Trash)": "🗑 삭제(휴지통으로 이동)",
    },
  };
  for (const [id, table] of Object.entries(EAST_ASIAN_SUBTITLE_TRANSLATIONS)) Object.assign(TRANSLATIONS[id], table);

  // Form labels and helper text are also rendered from static HTML attributes
  // (placeholder/title/aria-label). Register them explicitly so a locale
  // switch never leaves an English label beside a translated subtitle.
  const EAST_ASIAN_FORM_COPY = {
    en: {
      "Device name": "Device name", "Pi Web URL": "Pi Web URL", "Host name (optional)": "Host name (optional)", "Save device": "Save device", "Test connection": "Test connection", "Restart Pi Web": "Restart Pi Web", "Delete device": "Delete device", "One-time pairing code": "One-time pairing code", "Pairing code for another device": "Pairing code for another device", "Generate new pairing code": "Generate new pairing code", "Verify and add": "Verify and add", "API key": "API key", "Paste API key": "Paste API key", "Save and check": "Save and check", "Provider ID": "Provider ID", "API type": "API type", "Base URL": "Base URL", "API key (optional)": "API key (optional)", "Models (one per line; use ": "Models (one per line; use ", "Loading provider list…": "Loading provider list…", "PI AGENT DEVICE": "PI AGENT DEVICE", "MODEL PROVIDER": "MODEL PROVIDER",
    },
    "zh-Hant": {
      "Device name": "裝置名稱", "Pi Web URL": "Pi Web 網址", "Host name (optional)": "主機名稱（可選）", "Save device": "儲存裝置", "Test connection": "測試連線", "Restart Pi Web": "重新啟動 Pi Web", "Delete device": "刪除裝置", "One-time pairing code": "一次性配對碼", "Pairing code for another device": "提供給另一台裝置的配對碼", "Generate new pairing code": "產生新的配對碼", "Verify and add": "驗證並加入", "API key": "API key", "Paste API key": "貼上 API key", "Save and check": "儲存並檢查", "Provider ID": "Provider ID", "API type": "API 類型", "Base URL": "Base URL", "API key (optional)": "API key（可選）", "Models (one per line; use ": "模型（每行一個；格式：", "Loading provider list…": "正在載入 Provider 清單…", "PI AGENT DEVICE": "PI AGENT 裝置", "MODEL PROVIDER": "模型 Provider",
    },
    "zh-Hans": {
      "Device name": "设备名称", "Pi Web URL": "Pi Web 地址", "Host name (optional)": "主机名（可选）", "Save device": "保存设备", "Test connection": "测试连接", "Restart Pi Web": "重启 Pi Web", "Delete device": "删除设备", "One-time pairing code": "一次性配对码", "Pairing code for another device": "提供给另一台设备的配对码", "Generate new pairing code": "生成新的配对码", "Verify and add": "验证并添加", "API key": "API key", "Paste API key": "粘贴 API key", "Save and check": "保存并检查", "Provider ID": "Provider ID", "API type": "API 类型", "Base URL": "Base URL", "API key (optional)": "API key（可选）", "Models (one per line; use ": "模型（每行一个；格式：", "Loading provider list…": "正在加载 Provider 列表…", "PI AGENT DEVICE": "PI AGENT 设备", "MODEL PROVIDER": "模型 Provider",
    },
    ja: {
      "Device name": "デバイス名", "Pi Web URL": "Pi Web URL", "Host name (optional)": "ホスト名（任意）", "Save device": "デバイスを保存", "Test connection": "接続をテスト", "Restart Pi Web": "Pi Web を再起動", "Delete device": "デバイスを削除", "One-time pairing code": "ワンタイムペアリングコード", "Pairing code for another device": "別のデバイス用のペアリングコード", "Generate new pairing code": "新しいペアリングコードを生成", "Verify and add": "確認して追加", "API key": "API キー", "Paste API key": "API キーを貼り付け", "Save and check": "保存して確認", "Provider ID": "プロバイダー ID", "API type": "API タイプ", "Base URL": "ベース URL", "API key (optional)": "API キー（任意）", "Models (one per line; use ": "モデル（1 行に 1 つ。形式：", "Loading provider list…": "プロバイダー一覧を読み込み中…", "PI AGENT DEVICE": "PI AGENT デバイス", "MODEL PROVIDER": "モデルプロバイダー",
    },
    ko: {
      "Device name": "기기 이름", "Pi Web URL": "Pi Web URL", "Host name (optional)": "호스트 이름(선택 사항)", "Save device": "기기 저장", "Test connection": "연결 테스트", "Restart Pi Web": "Pi Web 다시 시작", "Delete device": "기기 삭제", "One-time pairing code": "일회용 페어링 코드", "Pairing code for another device": "다른 기기용 페어링 코드", "Generate new pairing code": "새 페어링 코드 생성", "Verify and add": "확인하고 추가", "API key": "API 키", "Paste API key": "API 키 붙여넣기", "Save and check": "저장하고 확인", "Provider ID": "Provider ID", "API type": "API 유형", "Base URL": "기본 URL", "API key (optional)": "API 키(선택 사항)", "Models (one per line; use ": "모델(한 줄에 하나, 형식: ", "Loading provider list…": "Provider 목록 불러오는 중…", "PI AGENT DEVICE": "PI AGENT 기기", "MODEL PROVIDER": "모델 Provider",
    },
  };
  for (const [id, table] of Object.entries(EAST_ASIAN_FORM_COPY)) Object.assign(TRANSLATIONS[id], table);

  // Device setup and OAuth actions are rendered after the initial HTML pass;
  // keep their helper copy in the same English-first registry so switching
  // locale also updates the explanatory text and sign-in action.
  const DEVICE_HELP_TRANSLATIONS = {
    en: {
      "How to add a device": "How to add a device",
      "Install and start Pi Web on the other computer. Keep it running and use the same Web token.": "Install and start Pi Web on the other computer. Keep it running and use the same Web token.",
      "On that computer, copy its Tailscale Serve or HTTPS Pi Web address, then paste it into ": "On that computer, copy its Tailscale Serve or HTTPS Pi Web address, then paste it into ",
      "Enter a friendly device name, choose ": "Enter a friendly device name, choose ",
      "If you cannot copy a URL, use the link button in Devices to create a one-time pairing code. Enter that code here instead; it expires after five minutes.": "If you cannot copy a URL, use the link button in Devices to create a one-time pairing code. Enter that code here instead; it expires after five minutes.",
      "Open official sign-in page": "Open official sign-in page",
    },
    "zh-Hant": {
      "How to add a device": "如何新增設備",
      "Install and start Pi Web on the other computer. Keep it running and use the same Web token.": "在另一台電腦安裝並啟動 Pi Web，保持程式運作，並使用相同的 Web token。",
      "On that computer, copy its Tailscale Serve or HTTPS Pi Web address, then paste it into ": "在那台電腦複製 Tailscale Serve 或 HTTPS 的 Pi Web 網址，貼到",
      "Enter a friendly device name, choose ": "輸入容易辨識的設備名稱，選擇",
      "If you cannot copy a URL, use the link button in Devices to create a one-time pairing code. Enter that code here instead; it expires after five minutes.": "如果無法複製網址，請在「設備」按連結按鈕建立一次性配對碼，再把配對碼填在這裡；配對碼五分鐘後失效。",
      "Open official sign-in page": "開啟官方登入頁面",
    },
    "zh-Hans": {
      "How to add a device": "如何添加设备",
      "Install and start Pi Web on the other computer. Keep it running and use the same Web token.": "在另一台电脑安装并启动 Pi Web，保持程序运行，并使用相同的 Web token。",
      "On that computer, copy its Tailscale Serve or HTTPS Pi Web address, then paste it into ": "在那台电脑复制 Tailscale Serve 或 HTTPS 的 Pi Web 地址，然后粘贴到",
      "Enter a friendly device name, choose ": "输入易于识别的设备名称，选择",
      "If you cannot copy a URL, use the link button in Devices to create a one-time pairing code. Enter that code here instead; it expires after five minutes.": "如果无法复制地址，请在“设备”中使用链接按钮创建一次性配对码，再将配对码填在这里；配对码五分钟后失效。",
      "Open official sign-in page": "打开官方登录页面",
    },
    ja: {
      "How to add a device": "デバイスの追加方法",
      "Install and start Pi Web on the other computer. Keep it running and use the same Web token.": "もう一台のコンピューターに Pi Web をインストールして起動し、同じ Web トークンで実行したままにします。",
      "On that computer, copy its Tailscale Serve or HTTPS Pi Web address, then paste it into ": "そのコンピューターの Tailscale Serve または HTTPS の Pi Web アドレスをコピーし、",
      "Enter a friendly device name, choose ": "わかりやすいデバイス名を入力し、",
      "If you cannot copy a URL, use the link button in Devices to create a one-time pairing code. Enter that code here instead; it expires after five minutes.": "URL をコピーできない場合は、「デバイス」のリンクボタンでワンタイムペアリングコードを作成し、ここに入力してください。コードは 5 分で期限切れになります。",
      "Open official sign-in page": "公式のサインインページを開く",
    },
    ko: {
      "How to add a device": "기기 추가 방법",
      "Install and start Pi Web on the other computer. Keep it running and use the same Web token.": "다른 컴퓨터에 Pi Web을 설치하고 실행한 뒤, 같은 Web 토큰으로 계속 실행해 두세요.",
      "On that computer, copy its Tailscale Serve or HTTPS Pi Web address, then paste it into ": "해당 컴퓨터의 Tailscale Serve 또는 HTTPS Pi Web 주소를 복사해",
      "Enter a friendly device name, choose ": "알아보기 쉬운 기기 이름을 입력하고",
      "If you cannot copy a URL, use the link button in Devices to create a one-time pairing code. Enter that code here instead; it expires after five minutes.": "URL을 복사할 수 없다면 ‘기기’의 링크 버튼으로 일회용 페어링 코드를 만든 다음 여기에 입력하세요. 코드는 5분 후 만료됩니다.",
      "Open official sign-in page": "공식 로그인 페이지 열기",
    },
    tr: {
      "How to add a device": "Cihaz ekleme",
      "Install and start Pi Web on the other computer. Keep it running and use the same Web token.": "Diğer bilgisayara Pi Web'i yükleyip başlatın. Açık tutun ve aynı Web jetonunu kullanın.",
      "On that computer, copy its Tailscale Serve or HTTPS Pi Web address, then paste it into ": "O bilgisayardaki Tailscale Serve veya HTTPS Pi Web adresini kopyalayıp",
      "Enter a friendly device name, choose ": "Anlaşılır bir cihaz adı girin, ardından",
      "If you cannot copy a URL, use the link button in Devices to create a one-time pairing code. Enter that code here instead; it expires after five minutes.": "URL'yi kopyalayamıyorsanız Cihazlar bölümündeki bağlantı düğmesiyle tek kullanımlık eşleştirme kodu oluşturun ve buraya girin. Kod beş dakika içinde geçersiz olur.",
      "Open official sign-in page": "Resmî giriş sayfasını aç",
    },
    fr: {
      "How to add a device": "Ajouter un appareil",
      "Install and start Pi Web on the other computer. Keep it running and use the same Web token.": "Installez et lancez Pi Web sur l’autre ordinateur. Laissez-le ouvert et utilisez le même jeton Web.",
      "On that computer, copy its Tailscale Serve or HTTPS Pi Web address, then paste it into ": "Sur cet ordinateur, copiez l’adresse Pi Web Tailscale Serve ou HTTPS, puis collez-la dans",
      "Enter a friendly device name, choose ": "Saisissez un nom facile à reconnaître, puis choisissez",
      "If you cannot copy a URL, use the link button in Devices to create a one-time pairing code. Enter that code here instead; it expires after five minutes.": "Si vous ne pouvez pas copier une URL, utilisez le bouton de lien dans Appareils pour créer un code d’association à usage unique. Saisissez-le ici ; il expire après cinq minutes.",
      "Open official sign-in page": "Ouvrir la page de connexion officielle",
    },
    de: {
      "How to add a device": "Gerät hinzufügen",
      "Install and start Pi Web on the other computer. Keep it running and use the same Web token.": "Installieren und starten Sie Pi Web auf dem anderen Computer. Lassen Sie es geöffnet und verwenden Sie dasselbe Web-Token.",
      "On that computer, copy its Tailscale Serve or HTTPS Pi Web address, then paste it into ": "Kopieren Sie auf diesem Computer die Tailscale-Serve- oder HTTPS-Adresse von Pi Web und fügen Sie sie in",
      "Enter a friendly device name, choose ": "Geben Sie einen gut erkennbaren Gerätenamen ein und wählen Sie",
      "If you cannot copy a URL, use the link button in Devices to create a one-time pairing code. Enter that code here instead; it expires after five minutes.": "Wenn Sie keine URL kopieren können, erstellen Sie über die Verknüpfungsschaltfläche unter Geräte einen einmaligen Kopplungscode. Geben Sie ihn hier ein; er läuft nach fünf Minuten ab.",
      "Open official sign-in page": "Offizielle Anmeldeseite öffnen",
    },
    es: {
      "How to add a device": "Cómo añadir un dispositivo",
      "Install and start Pi Web on the other computer. Keep it running and use the same Web token.": "Instala e inicia Pi Web en el otro ordenador. Déjalo en ejecución y usa el mismo token web.",
      "On that computer, copy its Tailscale Serve or HTTPS Pi Web address, then paste it into ": "En ese ordenador, copia la dirección Pi Web de Tailscale Serve o HTTPS y pégala en",
      "Enter a friendly device name, choose ": "Escribe un nombre fácil de reconocer y elige",
      "If you cannot copy a URL, use the link button in Devices to create a one-time pairing code. Enter that code here instead; it expires after five minutes.": "Si no puedes copiar una URL, usa el botón de enlace de Dispositivos para crear un código de emparejamiento de un solo uso. Introdúcelo aquí; caduca en cinco minutos.",
      "Open official sign-in page": "Abrir la página oficial de inicio de sesión",
    },
    "pt-BR": {
      "How to add a device": "Como adicionar um dispositivo",
      "Install and start Pi Web on the other computer. Keep it running and use the same Web token.": "Instale e abra o Pi Web no outro computador. Mantenha-o em execução e use o mesmo token Web.",
      "On that computer, copy its Tailscale Serve or HTTPS Pi Web address, then paste it into ": "Nesse computador, copie o endereço Pi Web do Tailscale Serve ou HTTPS e cole em",
      "Enter a friendly device name, choose ": "Digite um nome fácil de reconhecer e selecione",
      "If you cannot copy a URL, use the link button in Devices to create a one-time pairing code. Enter that code here instead; it expires after five minutes.": "Se não conseguir copiar uma URL, use o botão de link em Dispositivos para criar um código de pareamento de uso único. Digite-o aqui; ele expira em cinco minutos.",
      "Open official sign-in page": "Abrir a página oficial de login",
    },
    it: {
      "How to add a device": "Come aggiungere un dispositivo",
      "Install and start Pi Web on the other computer. Keep it running and use the same Web token.": "Installa e avvia Pi Web sull’altro computer. Lascialo in esecuzione e usa lo stesso token Web.",
      "On that computer, copy its Tailscale Serve or HTTPS Pi Web address, then paste it into ": "Su quel computer, copia l’indirizzo Pi Web Tailscale Serve o HTTPS e incollalo in",
      "Enter a friendly device name, choose ": "Inserisci un nome riconoscibile e scegli",
      "If you cannot copy a URL, use the link button in Devices to create a one-time pairing code. Enter that code here instead; it expires after five minutes.": "Se non puoi copiare un URL, usa il pulsante di collegamento in Dispositivi per creare un codice di abbinamento monouso. Inseriscilo qui; scade dopo cinque minuti.",
      "Open official sign-in page": "Apri la pagina ufficiale di accesso",
    },
  };
  for (const [id, table] of Object.entries(DEVICE_HELP_TRANSLATIONS)) Object.assign(TRANSLATIONS[id], table);

  // Natural translations for the longer helper text used by the European
  // locales.  These strings are deliberately keyed by their English source so
  // they also work when users switch repeatedly between languages.
  const EUROPEAN_SUBTITLE_COPY = {
    "To add another Pi Agent computer, run Pi Web there and enter its Tailscale or HTTPS address. You can also use a one-time pairing code. Both devices must use the same Web token.": {
      tr: "Başka bir Pi Agent bilgisayarı eklemek için orada Pi Web'i çalıştırın ve Tailscale veya HTTPS adresini girin. Tek kullanımlık eşleştirme kodunu da kullanabilirsiniz. Her iki cihaz da aynı Web token'ını kullanmalıdır.",
      fr: "Pour ajouter un autre ordinateur Pi Agent, lancez Pi Web dessus et saisissez son adresse Tailscale ou HTTPS. Vous pouvez aussi utiliser un code d’association à usage unique. Les deux appareils doivent utiliser le même jeton Web.",
      de: "Um einen weiteren Pi-Agent-Computer hinzuzufügen, starten Sie dort Pi Web und geben Sie seine Tailscale- oder HTTPS-Adresse ein. Sie können auch einen einmaligen Kopplungscode verwenden. Beide Geräte müssen dasselbe Web-Token nutzen.",
      es: "Para añadir otro ordenador con Pi Agent, ejecuta Pi Web allí e introduce su dirección de Tailscale o HTTPS. También puedes usar un código de emparejamiento de un solo uso. Ambos dispositivos deben usar el mismo token web.",
      "pt-BR": "Para adicionar outro computador com Pi Agent, execute o Pi Web nele e informe o endereço Tailscale ou HTTPS. Você também pode usar um código de pareamento de uso único. Os dois dispositivos devem usar o mesmo token da Web.",
      it: "Per aggiungere un altro computer Pi Agent, avvia Pi Web su quel computer e inserisci il relativo indirizzo Tailscale o HTTPS. Puoi anche usare un codice di abbinamento monouso. Entrambi i dispositivi devono usare lo stesso token Web.",
    },
    "Pi coding agent installed on this device": {
      tr: "Bu cihaza Pi coding agent yüklendi", fr: "Agent de programmation Pi installé sur cet appareil", de: "Pi-Coding-Agent auf diesem Gerät installiert", es: "Agente de programación de Pi instalado en este dispositivo", "pt-BR": "Agente de programação Pi instalado neste dispositivo", it: "Agente di programmazione Pi installato su questo dispositivo",
    },
    "All sessions on this device": {
      tr: "Bu cihazdaki tüm oturumlar", fr: "Toutes les sessions sur cet appareil", de: "Alle Sitzungen auf diesem Gerät", es: "Todas las sesiones de este dispositivo", "pt-BR": "Todas as sessões neste dispositivo", it: "Tutte le sessioni su questo dispositivo",
    },
    "Clear this browser's sign-in state": {
      tr: "Bu tarayıcının oturum açma durumunu temizle", fr: "Effacer l’état de connexion de ce navigateur", de: "Anmeldestatus dieses Browsers löschen", es: "Borrar el estado de inicio de sesión de este navegador", "pt-BR": "Limpar o estado de login deste navegador", it: "Cancella lo stato di accesso di questo browser",
    },
    "Check GitHub and update this device periodically": {
      tr: "GitHub'u düzenli olarak kontrol edip bu cihazı güncelle", fr: "Vérifier GitHub et mettre régulièrement à jour cet appareil", de: "GitHub regelmäßig prüfen und dieses Gerät aktualisieren", es: "Comprobar GitHub y actualizar este dispositivo periódicamente", "pt-BR": "Verificar o GitHub e atualizar este dispositivo periodicamente", it: "Controlla GitHub e aggiorna periodicamente questo dispositivo",
    },
    "Checking updater status…": {
      tr: "Güncelleyici durumu kontrol ediliyor…", fr: "Vérification de l’état du programme de mise à jour…", de: "Updater-Status wird geprüft…", es: "Comprobando el estado del actualizador…", "pt-BR": "Verificando o status do atualizador…", it: "Verifica dello stato dell’aggiornamento…",
    },
    "Choose the language used by Pi Web": {
      tr: "Pi Web'in kullandığı dili seçin", fr: "Choisissez la langue utilisée par Pi Web", de: "Wählen Sie die von Pi Web verwendete Sprache", es: "Elige el idioma que usa Pi Web", "pt-BR": "Escolha o idioma usado pelo Pi Web", it: "Scegli la lingua usata da Pi Web",
    },
    "Light, dark, or follow system": {
      tr: "Açık, koyu veya sistem ayarını kullan", fr: "Clair, sombre ou selon le système", de: "Hell, dunkel oder nach Systemeinstellung", es: "Claro, oscuro o según el sistema", "pt-BR": "Claro, escuro ou seguir o sistema", it: "Chiaro, scuro o in base al sistema",
    },
    "Choose a complete colour system": {
      tr: "Eksiksiz bir renk sistemi seçin", fr: "Choisissez un système de couleurs complet", de: "Wählen Sie ein vollständiges Farbsystem", es: "Elige un sistema de colores completo", "pt-BR": "Escolha um sistema de cores completo", it: "Scegli un sistema cromatico completo",
    },
    "Show sessions with less spacing": {
      tr: "Oturumları daha az aralıkla göster", fr: "Afficher les sessions avec moins d’espace", de: "Sitzungen mit weniger Abstand anzeigen", es: "Mostrar sesiones con menos espacio", "pt-BR": "Mostrar sessões com menos espaçamento", it: "Mostra le sessioni con meno spazio",
    },
    "Desktop only; mobile always uses full width": {
      tr: "Yalnızca masaüstü; mobilde her zaman tam genişlik kullanılır", fr: "Ordinateur uniquement ; le mobile utilise toujours toute la largeur", de: "Nur Desktop; mobil wird immer die volle Breite verwendet", es: "Solo escritorio; en móviles siempre se usa todo el ancho", "pt-BR": "Somente no desktop; no celular, a largura é sempre total", it: "Solo desktop; sui dispositivi mobili viene sempre usata tutta la larghezza",
    },
    "Adjust interface text for readability": {
      tr: "Arayüz metnini okunabilirlik için ayarlayın", fr: "Ajustez le texte de l’interface pour plus de lisibilité", de: "Passen Sie die Oberfläche für bessere Lesbarkeit an", es: "Ajusta el texto de la interfaz para facilitar la lectura", "pt-BR": "Ajuste o texto da interface para facilitar a leitura", it: "Regola il testo dell’interfaccia per una migliore leggibilità",
    },
    "Group sessions by working directory": {
      tr: "Oturumları çalışma dizinine göre grupla", fr: "Regrouper les sessions par répertoire de travail", de: "Sitzungen nach Arbeitsverzeichnis gruppieren", es: "Agrupar sesiones por directorio de trabajo", "pt-BR": "Agrupar sessões por diretório de trabalho", it: "Raggruppa le sessioni per directory di lavoro",
    },
    "Reduce transitions and scrolling animations": {
      tr: "Geçişleri ve kaydırma animasyonlarını azalt", fr: "Réduire les transitions et les animations de défilement", de: "Übergänge und Scroll-Animationen reduzieren", es: "Reducir las transiciones y animaciones de desplazamiento", "pt-BR": "Reduzir transições e animações de rolagem", it: "Riduci le transizioni e le animazioni di scorrimento",
    },
    "Default state for assistant thinking blocks": {
      tr: "Asistanın düşünme blokları için varsayılan durum", fr: "État par défaut des blocs de réflexion de l’assistant", de: "Standardzustand der Denkblöcke des Assistenten", es: "Estado predeterminado de los bloques de razonamiento del asistente", "pt-BR": "Estado padrão dos blocos de raciocínio do assistente", it: "Stato predefinito dei blocchi di ragionamento dell’assistente",
    },
    "Swipe from the left edge in a conversation to go back": {
      tr: "Geri dönmek için konuşmada sol kenardan kaydırın", fr: "Balayez depuis le bord gauche d’une conversation pour revenir en arrière", de: "Wischen Sie in einer Unterhaltung vom linken Rand, um zurückzugehen", es: "Desliza desde el borde izquierdo de una conversación para volver", "pt-BR": "Deslize a partir da borda esquerda em uma conversa para voltar", it: "Scorri dal bordo sinistro di una conversazione per tornare indietro",
    },
    "Manage visible models and custom providers in one list.": {
      tr: "Görünür modelleri ve özel sağlayıcıları tek listede yönetin.", fr: "Gérez les modèles visibles et les fournisseurs personnalisés dans une seule liste.", de: "Verwalten Sie sichtbare Modelle und benutzerdefinierte Anbieter in einer Liste.", es: "Gestiona los modelos visibles y los proveedores personalizados en una sola lista.", "pt-BR": "Gerencie modelos visíveis e provedores personalizados em uma única lista.", it: "Gestisci i modelli visibili e i provider personalizzati in un unico elenco.",
    },
    "Loading model list…": {
      tr: "Model listesi yükleniyor…", fr: "Chargement de la liste des modèles…", de: "Modellliste wird geladen…", es: "Cargando la lista de modelos…", "pt-BR": "Carregando a lista de modelos…", it: "Caricamento dell’elenco dei modelli…",
    },
    "Choose a service, then sign in or provide an API key. Pi handles the technical setup.": {
      tr: "Bir hizmet seçin, ardından giriş yapın veya API anahtarı sağlayın. Teknik kurulumu Pi halleder.", fr: "Choisissez un service, puis connectez-vous ou fournissez une clé API. Pi s’occupe de la configuration technique.", de: "Wählen Sie einen Dienst und melden Sie sich an oder geben Sie einen API-Schlüssel ein. Pi übernimmt die technische Einrichtung.", es: "Elige un servicio y luego inicia sesión o proporciona una clave API. Pi se encarga de la configuración técnica.", "pt-BR": "Escolha um serviço e depois entre ou informe uma chave de API. O Pi cuida da configuração técnica.", it: "Scegli un servizio, quindi accedi o fornisci una chiave API. Pi gestisce la configurazione tecnica.",
    },
    "Open the official sign-in flow; credentials stay on this device": {
      tr: "Resmî giriş akışını açın; kimlik bilgileri bu cihazda kalır", fr: "Ouvrir la procédure de connexion officielle ; les identifiants restent sur cet appareil", de: "Offiziellen Anmeldevorgang öffnen; Anmeldedaten bleiben auf diesem Gerät", es: "Abrir el inicio de sesión oficial; las credenciales permanecen en este dispositivo", "pt-BR": "Abrir o fluxo oficial de login; as credenciais permanecem neste dispositivo", it: "Apri il flusso di accesso ufficiale; le credenziali restano su questo dispositivo",
    },
    "Paste a key from this service and Pi will configure it": {
      tr: "Bu hizmetten aldığınız anahtarı yapıştırın; Pi yapılandırmayı yapar", fr: "Collez une clé de ce service et Pi la configurera", de: "Fügen Sie einen Schlüssel dieses Dienstes ein; Pi richtet ihn ein", es: "Pega una clave de este servicio y Pi la configurará", "pt-BR": "Cole uma chave deste serviço e o Pi fará a configuração", it: "Incolla una chiave di questo servizio e Pi la configurerà",
    },
    "The key is stored only on this device. Pi will validate it and load available models.": {
      tr: "Anahtar yalnızca bu cihazda saklanır. Pi anahtarı doğrular ve kullanılabilir modelleri yükler.", fr: "La clé est stockée uniquement sur cet appareil. Pi la validera et chargera les modèles disponibles.", de: "Der Schlüssel wird nur auf diesem Gerät gespeichert. Pi prüft ihn und lädt die verfügbaren Modelle.", es: "La clave solo se almacena en este dispositivo. Pi la validará y cargará los modelos disponibles.", "pt-BR": "A chave é armazenada somente neste dispositivo. O Pi vai validá-la e carregar os modelos disponíveis.", it: "La chiave viene memorizzata solo su questo dispositivo. Pi la verificherà e caricherà i modelli disponibili.",
    },
    "No account or API key required; Pi reads local models": {
      tr: "Hesap veya API anahtarı gerekmez; Pi yerel modelleri okur", fr: "Aucun compte ni clé API requis ; Pi lit les modèles locaux", de: "Kein Konto und kein API-Schlüssel erforderlich; Pi liest lokale Modelle", es: "No se necesita cuenta ni clave API; Pi lee los modelos locales", "pt-BR": "Não é necessária conta nem chave de API; o Pi lê os modelos locais", it: "Non servono account né chiavi API; Pi legge i modelli locali",
    },
    "For regular services, go back and choose one instead.": {
      tr: "Normal hizmetler için geri dönüp listeden birini seçin.", fr: "Pour les services courants, revenez en arrière et choisissez-en un dans la liste.", de: "Für reguläre Dienste gehen Sie zurück und wählen Sie stattdessen einen aus.", es: "Para los servicios habituales, vuelve atrás y elige uno de la lista.", "pt-BR": "Para serviços comuns, volte e escolha um deles.", it: "Per i servizi normali, torna indietro e scegline uno.",
    },
    "Each device must run Pi Web (default port 3140) with this Web token. Use a Tailscale Serve or HTTPS URL reachable from this device.": {
      tr: "Her cihaz bu Web token'ıyla Pi Web'i (varsayılan bağlantı noktası 3140) çalıştırmalıdır. Bu cihazdan erişilebilen bir Tailscale Serve veya HTTPS URL'si kullanın.", fr: "Chaque appareil doit exécuter Pi Web (port 3140 par défaut) avec ce jeton Web. Utilisez une URL Tailscale Serve ou HTTPS accessible depuis cet appareil.", de: "Auf jedem Gerät muss Pi Web (Standardport 3140) mit diesem Web-Token laufen. Verwenden Sie eine von diesem Gerät erreichbare Tailscale-Serve- oder HTTPS-URL.", es: "Cada dispositivo debe ejecutar Pi Web (puerto predeterminado 3140) con este token web. Usa una URL de Tailscale Serve o HTTPS accesible desde este dispositivo.", "pt-BR": "Cada dispositivo deve executar o Pi Web (porta padrão 3140) com este token da Web. Use uma URL do Tailscale Serve ou HTTPS acessível a partir deste dispositivo.", it: "Ogni dispositivo deve eseguire Pi Web (porta predefinita 3140) con questo token Web. Usa un URL Tailscale Serve o HTTPS raggiungibile da questo dispositivo.",
    },
    "Generate a pairing code in the other Pi Web device settings and paste it here. Codes expire after 5 minutes and can only be used once.": {
      tr: "Diğer Pi Web cihazının ayarlarında bir eşleştirme kodu oluşturup buraya yapıştırın. Kodların süresi 5 dakika sonra dolar ve yalnızca bir kez kullanılabilir.", fr: "Générez un code d’association dans les réglages de l’autre appareil Pi Web, puis collez-le ici. Les codes expirent après 5 minutes et ne peuvent être utilisés qu’une fois.", de: "Erzeugen Sie in den Einstellungen des anderen Pi-Web-Geräts einen Kopplungscode und fügen Sie ihn hier ein. Codes laufen nach 5 Minuten ab und können nur einmal verwendet werden.", es: "Genera un código de emparejamiento en los ajustes del otro dispositivo Pi Web y pégalo aquí. Los códigos caducan después de 5 minutos y solo se pueden usar una vez.", "pt-BR": "Gere um código de pareamento nas configurações do outro dispositivo Pi Web e cole-o aqui. Os códigos expiram após 5 minutos e só podem ser usados uma vez.", it: "Genera un codice di abbinamento nelle impostazioni dell’altro dispositivo Pi Web e incollalo qui. I codici scadono dopo 5 minuti e possono essere usati una sola volta.",
    },
    "Pull down to refresh; swipe from the left edge to go back; long-press a session to rename or delete": {
      tr: "Yenilemek için aşağı çekin; geri dönmek için sol kenardan kaydırın; bir oturumu yeniden adlandırmak veya silmek için uzun basın", fr: "Tirez vers le bas pour actualiser ; balayez depuis le bord gauche pour revenir ; appuyez longuement sur une session pour la renommer ou la supprimer", de: "Zum Aktualisieren nach unten ziehen; vom linken Rand wischen, um zurückzugehen; eine Sitzung zum Umbenennen oder Löschen gedrückt halten", es: "Desliza hacia abajo para actualizar; desliza desde el borde izquierdo para volver; mantén pulsada una sesión para cambiarle el nombre o eliminarla", "pt-BR": "Puxe para baixo para atualizar; deslize da borda esquerda para voltar; mantenha uma sessão pressionada para renomeá-la ou excluí-la", it: "Trascina verso il basso per aggiornare; scorri dal bordo sinistro per tornare indietro; tieni premuta una sessione per rinominarla o eliminarla",
    },
    "Mobile-first remote workspace for Pi": {
      tr: "Pi için mobil öncelikli uzak çalışma alanı", fr: "Espace de travail distant pensé d’abord pour le mobile, pour Pi", de: "Mobil optimierter Remote-Arbeitsbereich für Pi", es: "Espacio de trabajo remoto para Pi, pensado para móviles", "pt-BR": "Espaço de trabalho remoto para Pi, pensado primeiro para celular", it: "Workspace remoto per Pi, progettato prima di tutto per i dispositivi mobili",
    },
    "Clear theme, density, and model visibility preferences": {
      tr: "Tema, yoğunluk ve model görünürlüğü tercihlerini temizle", fr: "Effacer les préférences de thème, densité et visibilité des modèles", de: "Design-, Dichte- und Sichtbarkeitseinstellungen der Modelle löschen", es: "Borrar las preferencias de tema, densidad y visibilidad de modelos", "pt-BR": "Limpar preferências de tema, densidade e visibilidade dos modelos", it: "Cancella le preferenze di tema, densità e visibilità dei modelli",
    },
    "Pi Web · self-hosted on your tailnet": {
      tr: "Pi Web · tailnet'inizde self-hosted", fr: "Pi Web · auto-hébergé sur votre tailnet", de: "Pi Web · selbst gehostet in Ihrem Tailnet", es: "Pi Web · autoalojado en tu tailnet", "pt-BR": "Pi Web · auto-hospedado no seu tailnet", it: "Pi Web · self-hosted sulla tua tailnet",
    },
    "Models (one per line; use ": {
      tr: "Modeller (her satıra bir tane; şu biçimi kullanın: ", fr: "Modèles (un par ligne ; utilisez ", de: "Modelle (eines pro Zeile; verwenden Sie ", es: "Modelos (uno por línea; usa ", "pt-BR": "Modelos (um por linha; use ", it: "Modelli (uno per riga; usa ",
    },
    "Models (one per line; use": {
      tr: "Modeller (her satıra bir tane; şu biçimi kullanın:", fr: "Modèles (un par ligne ; utilisez", de: "Modelle (eines pro Zeile; verwenden Sie", es: "Modelos (uno por línea; usa", "pt-BR": "Modelos (um por linha; use", it: "Modelli (uno per riga; usa",
    },
    "Advanced settings are saved in": {
      tr: "Gelişmiş ayarlar şuraya kaydedilir", fr: "Les réglages avancés sont enregistrés dans", de: "Erweiterte Einstellungen werden gespeichert in", es: "La configuración avanzada se guarda en", "pt-BR": "As configurações avançadas são salvas em", it: "Le impostazioni avanzate vengono salvate in",
    },
    "How to add a device": {
      tr: "Cihaz ekleme", fr: "Comment ajouter un appareil", de: "Gerät hinzufügen", es: "Cómo añadir un dispositivo", "pt-BR": "Como adicionar um dispositivo", it: "Come aggiungere un dispositivo",
    },
    "Install and start Pi Web on the other computer. Keep it running and use the same Web token.": {
      tr: "Diğer bilgisayara Pi Web'i kurup çalıştırın. Açık tutun ve aynı Web token'ını kullanın.", fr: "Installez et démarrez Pi Web sur l’autre ordinateur. Laissez-le fonctionner et utilisez le même jeton Web.", de: "Installieren und starten Sie Pi Web auf dem anderen Computer. Lassen Sie es laufen und verwenden Sie dasselbe Web-Token.", es: "Instala e inicia Pi Web en el otro ordenador. Déjalo en ejecución y usa el mismo token web.", "pt-BR": "Instale e inicie o Pi Web no outro computador. Mantenha-o em execução e use o mesmo token da Web.", it: "Installa e avvia Pi Web sull’altro computer. Lascialo in esecuzione e usa lo stesso token Web.",
    },
    "On that computer, copy its Tailscale Serve or HTTPS Pi Web address, then paste it into": {
      tr: "O bilgisayarda Tailscale Serve veya HTTPS Pi Web adresini kopyalayıp buraya yapıştırın:", fr: "Sur cet ordinateur, copiez l’adresse Pi Web Tailscale Serve ou HTTPS, puis collez-la dans", de: "Kopieren Sie auf diesem Computer die Tailscale-Serve- oder HTTPS-Adresse von Pi Web und fügen Sie sie ein in", es: "En ese ordenador, copia la dirección de Pi Web de Tailscale Serve o HTTPS y pégala en", "pt-BR": "Nesse computador, copie o endereço Tailscale Serve ou HTTPS do Pi Web e cole-o em", it: "Su quel computer, copia l’indirizzo Pi Web Tailscale Serve o HTTPS e incollalo in",
    },
    "Enter a friendly device name, choose": {
      tr: "Anlaşılır bir cihaz adı girin, ardından", fr: "Saisissez un nom convivial pour l’appareil, choisissez", de: "Geben Sie einen verständlichen Gerätenamen ein, wählen Sie", es: "Introduce un nombre descriptivo para el dispositivo, elige", "pt-BR": "Digite um nome amigável para o dispositivo, escolha", it: "Inserisci un nome descrittivo per il dispositivo, scegli",
    },
    "and then select": {
      tr: "ve ardından seçin", fr: "puis sélectionnez", de: "und wählen Sie anschließend", es: "y después selecciona", "pt-BR": "e depois selecione", it: "e poi seleziona",
    },
    "If you cannot copy a URL, use the link button in Devices to create a one-time pairing code. Enter that code here instead; it expires after five minutes.": {
      tr: "URL'yi kopyalayamıyorsanız, tek kullanımlık eşleştirme kodu oluşturmak için Cihazlar bölümündeki bağlantı düğmesini kullanın. Bunun yerine kodu buraya girin; beş dakika sonra geçerliliğini yitirir.", fr: "Si vous ne pouvez pas copier une URL, utilisez le bouton de lien dans Appareils pour créer un code d’association à usage unique. Saisissez plutôt ce code ici ; il expire après cinq minutes.", de: "Wenn Sie keine URL kopieren können, erstellen Sie über die Verknüpfungsschaltfläche unter Geräte einen einmaligen Kopplungscode. Geben Sie stattdessen diesen Code hier ein; er läuft nach fünf Minuten ab.", es: "Si no puedes copiar una URL, usa el botón de enlace de Dispositivos para crear un código de emparejamiento de un solo uso. Introduce ese código aquí; caduca después de cinco minutos.", "pt-BR": "Se não puder copiar uma URL, use o botão de link em Dispositivos para criar um código de pareamento de uso único. Digite esse código aqui; ele expira após cinco minutos.", it: "Se non puoi copiare un URL, usa il pulsante di collegamento in Dispositivi per creare un codice di abbinamento monouso. Inserisci qui quel codice; scade dopo cinque minuti.",
    },
  };
  for (const [key, values] of Object.entries(EUROPEAN_SUBTITLE_COPY)) {
    for (const id of ["tr", "fr", "de", "es", "pt-BR", "it"]) {
      if (values[id]) TRANSLATIONS[id][key] = values[id];
    }
  }

  const EUROPEAN_FORM_COPY = {
    tr: {
      "Device name": "Cihaz adı", "Pi Web URL": "Pi Web URL'si", "Host name (optional)": "Ana bilgisayar adı (isteğe bağlı)", "Save device": "Cihazı kaydet", "Test connection": "Bağlantıyı test et", "Restart Pi Web": "Pi Web'i yeniden başlat", "Delete device": "Cihazı sil", "One-time pairing code": "Tek kullanımlık eşleştirme kodu", "Pairing code for another device": "Başka bir cihaz için eşleştirme kodu", "Generate new pairing code": "Yeni eşleştirme kodu oluştur", "Verify and add": "Doğrula ve ekle", "API key": "API anahtarı", "Paste API key": "API anahtarını yapıştırın", "Save and check": "Kaydet ve kontrol et", "Provider ID": "Sağlayıcı kimliği", "API type": "API türü", "Base URL": "Temel URL", "API key (optional)": "API anahtarı (isteğe bağlı)", "Loading provider list…": "Sağlayıcı listesi yükleniyor…", "PI AGENT DEVICE": "PI AGENT CİHAZI", "MODEL PROVIDER": "MODEL SAĞLAYICISI",
      "Local Pi Web port": "Yerel Pi Web bağlantı noktası", "Remove sign-in": "Oturum açmayı kaldır", "Delete provider": "Sağlayıcıyı sil", "Join with pairing code": "Eşleştirme koduyla katıl", "Search providers": "Sağlayıcılarda ara", "Search providers or models": "Sağlayıcı veya model ara", "e.g. Work computer": "ör. İş bilgisayarı", "e.g. office-laptop": "ör. ofis-dizüstü", "e.g. ollama-local": "ör. ollama-local", "e.g. Project QA": "ör. Proje QA", "https://host.example or http://…:3140": "https://host.example veya http://…:3140", "You may use $ENV_VAR or !command": "$ENV_VAR veya !command kullanabilirsiniz", "NEW PROJECT": "YENİ PROJE", "Session": "Oturum", "PI REQUEST": "PI İSTEĞİ", "Token": "Token",
    },
    fr: {
      "Device name": "Nom de l’appareil", "Pi Web URL": "URL de Pi Web", "Host name (optional)": "Nom d’hôte (facultatif)", "Save device": "Enregistrer l’appareil", "Test connection": "Tester la connexion", "Restart Pi Web": "Redémarrer Pi Web", "Delete device": "Supprimer l’appareil", "One-time pairing code": "Code d’association à usage unique", "Pairing code for another device": "Code d’association pour un autre appareil", "Generate new pairing code": "Générer un nouveau code d’association", "Verify and add": "Vérifier et ajouter", "API key": "Clé API", "Paste API key": "Collez la clé API", "Save and check": "Enregistrer et vérifier", "Provider ID": "Identifiant du fournisseur", "API type": "Type d’API", "Base URL": "URL de base", "API key (optional)": "Clé API (facultatif)", "Loading provider list…": "Chargement de la liste des fournisseurs…", "PI AGENT DEVICE": "APPAREIL PI AGENT", "MODEL PROVIDER": "FOURNISSEUR DE MODÈLE",
      "Local Pi Web port": "Port Pi Web local", "Remove sign-in": "Supprimer la connexion", "Delete provider": "Supprimer le fournisseur", "Join with pairing code": "Rejoindre avec un code d’association", "Search providers": "Rechercher des fournisseurs", "Search providers or models": "Rechercher des fournisseurs ou des modèles", "e.g. Work computer": "ex. ordinateur professionnel", "e.g. office-laptop": "ex. portable-bureau", "e.g. ollama-local": "ex. ollama-local", "e.g. Project QA": "ex. projet QA", "https://host.example or http://…:3140": "https://host.example ou http://…:3140", "You may use $ENV_VAR or !command": "Vous pouvez utiliser $ENV_VAR ou !command", "NEW PROJECT": "NOUVEAU PROJET", "Session": "Session", "PI REQUEST": "DEMANDE PI", "Token": "Jeton",
    },
    de: {
      "Device name": "Gerätename", "Pi Web URL": "Pi-Web-URL", "Host name (optional)": "Hostname (optional)", "Save device": "Gerät speichern", "Test connection": "Verbindung testen", "Restart Pi Web": "Pi Web neu starten", "Delete device": "Gerät löschen", "One-time pairing code": "Einmaliger Kopplungscode", "Pairing code for another device": "Kopplungscode für ein anderes Gerät", "Generate new pairing code": "Neuen Kopplungscode erzeugen", "Verify and add": "Prüfen und hinzufügen", "API key": "API-Schlüssel", "Paste API key": "API-Schlüssel einfügen", "Save and check": "Speichern und prüfen", "Provider ID": "Anbieter-ID", "API type": "API-Typ", "Base URL": "Basis-URL", "API key (optional)": "API-Schlüssel (optional)", "Loading provider list…": "Anbieterliste wird geladen…", "PI AGENT DEVICE": "PI-AGENT-GERÄT", "MODEL PROVIDER": "MODELLANBIETER",
      "Local Pi Web port": "Lokaler Pi-Web-Port", "Remove sign-in": "Anmeldung entfernen", "Delete provider": "Anbieter löschen", "Join with pairing code": "Mit Kopplungscode beitreten", "Search providers": "Anbieter durchsuchen", "Search providers or models": "Anbieter oder Modelle durchsuchen", "e.g. Work computer": "z. B. Arbeitscomputer", "e.g. office-laptop": "z. B. Büro-Laptop", "e.g. ollama-local": "z. B. ollama-local", "e.g. Project QA": "z. B. Projekt-QA", "https://host.example or http://…:3140": "https://host.example oder http://…:3140", "You may use $ENV_VAR or !command": "$ENV_VAR oder !command kann verwendet werden", "NEW PROJECT": "NEUES PROJEKT", "Session": "Sitzung", "PI REQUEST": "PI-ANFRAGE", "Token": "Token",
    },
    es: {
      "Device name": "Nombre del dispositivo", "Pi Web URL": "URL de Pi Web", "Host name (optional)": "Nombre del host (opcional)", "Save device": "Guardar dispositivo", "Test connection": "Probar conexión", "Restart Pi Web": "Reiniciar Pi Web", "Delete device": "Eliminar dispositivo", "One-time pairing code": "Código de emparejamiento de un solo uso", "Pairing code for another device": "Código de emparejamiento para otro dispositivo", "Generate new pairing code": "Generar un nuevo código de emparejamiento", "Verify and add": "Verificar y añadir", "API key": "Clave API", "Paste API key": "Pega la clave API", "Save and check": "Guardar y comprobar", "Provider ID": "ID del proveedor", "API type": "Tipo de API", "Base URL": "URL base", "API key (optional)": "Clave API (opcional)", "Loading provider list…": "Cargando la lista de proveedores…", "PI AGENT DEVICE": "DISPOSITIVO PI AGENT", "MODEL PROVIDER": "PROVEEDOR DE MODELOS",
      "Local Pi Web port": "Puerto local de Pi Web", "Remove sign-in": "Eliminar inicio de sesión", "Delete provider": "Eliminar proveedor", "Join with pairing code": "Unirse con código de emparejamiento", "Search providers": "Buscar proveedores", "Search providers or models": "Buscar proveedores o modelos", "e.g. Work computer": "p. ej., ordenador de trabajo", "e.g. office-laptop": "p. ej., portátil-oficina", "e.g. ollama-local": "p. ej., ollama-local", "e.g. Project QA": "p. ej., proyecto QA", "https://host.example or http://…:3140": "https://host.example o http://…:3140", "You may use $ENV_VAR or !command": "Puedes usar $ENV_VAR o !command", "NEW PROJECT": "NUEVO PROYECTO", "Session": "Sesión", "PI REQUEST": "SOLICITUD DE PI", "Token": "Token",
    },
    "pt-BR": {
      "Device name": "Nome do dispositivo", "Pi Web URL": "URL do Pi Web", "Host name (optional)": "Nome do host (opcional)", "Save device": "Salvar dispositivo", "Test connection": "Testar conexão", "Restart Pi Web": "Reiniciar o Pi Web", "Delete device": "Excluir dispositivo", "One-time pairing code": "Código de pareamento de uso único", "Pairing code for another device": "Código de pareamento para outro dispositivo", "Generate new pairing code": "Gerar novo código de pareamento", "Verify and add": "Verificar e adicionar", "API key": "Chave de API", "Paste API key": "Cole a chave de API", "Save and check": "Salvar e verificar", "Provider ID": "ID do provedor", "API type": "Tipo de API", "Base URL": "URL base", "API key (optional)": "Chave de API (opcional)", "Loading provider list…": "Carregando a lista de provedores…", "PI AGENT DEVICE": "DISPOSITIVO PI AGENT", "MODEL PROVIDER": "PROVEDOR DE MODELO",
      "Local Pi Web port": "Porta local do Pi Web", "Remove sign-in": "Remover login", "Delete provider": "Excluir provedor", "Join with pairing code": "Entrar com código de pareamento", "Search providers": "Pesquisar provedores", "Search providers or models": "Pesquisar provedores ou modelos", "e.g. Work computer": "ex.: computador do trabalho", "e.g. office-laptop": "ex.: laptop-escritório", "e.g. ollama-local": "ex.: ollama-local", "e.g. Project QA": "ex.: projeto QA", "https://host.example or http://…:3140": "https://host.example ou http://…:3140", "You may use $ENV_VAR or !command": "Você pode usar $ENV_VAR ou !command", "NEW PROJECT": "NOVO PROJETO", "Session": "Sessão", "PI REQUEST": "SOLICITAÇÃO DO PI", "Token": "Token",
    },
    it: {
      "Device name": "Nome dispositivo", "Pi Web URL": "URL di Pi Web", "Host name (optional)": "Nome host (facoltativo)", "Save device": "Salva dispositivo", "Test connection": "Testa connessione", "Restart Pi Web": "Riavvia Pi Web", "Delete device": "Elimina dispositivo", "One-time pairing code": "Codice di abbinamento monouso", "Pairing code for another device": "Codice di abbinamento per un altro dispositivo", "Generate new pairing code": "Genera nuovo codice di abbinamento", "Verify and add": "Verifica e aggiungi", "API key": "Chiave API", "Paste API key": "Incolla la chiave API", "Save and check": "Salva e verifica", "Provider ID": "ID provider", "API type": "Tipo di API", "Base URL": "URL di base", "API key (optional)": "Chiave API (facoltativa)", "Loading provider list…": "Caricamento dell’elenco dei provider…", "PI AGENT DEVICE": "DISPOSITIVO PI AGENT", "MODEL PROVIDER": "PROVIDER DEL MODELLO",
      "Local Pi Web port": "Porta locale di Pi Web", "Remove sign-in": "Rimuovi accesso", "Delete provider": "Elimina provider", "Join with pairing code": "Partecipa con codice di abbinamento", "Search providers": "Cerca provider", "Search providers or models": "Cerca provider o modelli", "e.g. Work computer": "es. computer di lavoro", "e.g. office-laptop": "es. portatile-ufficio", "e.g. ollama-local": "es. ollama-local", "e.g. Project QA": "es. progetto QA", "https://host.example or http://…:3140": "https://host.example o http://…:3140", "You may use $ENV_VAR or !command": "Puoi usare $ENV_VAR o !command", "NEW PROJECT": "NUOVO PROGETTO", "Session": "Sessione", "PI REQUEST": "RICHIESTA PI", "Token": "Token",
    },
  };
  for (const [id, table] of Object.entries(EUROPEAN_FORM_COPY)) Object.assign(TRANSLATIONS[id], table);

  // Keep the locale tables auditable.  The UI still uses the English source
  // key as its safe fallback, but every fallback is now explicit and can be
  // reported in development/tests instead of silently leaking a random
  // language after a dynamic DOM update.
  const LOCALE_SOURCE_KEYS = Object.freeze([...new Set([
    ...Object.values(HAN_TO_EN),
    ...Object.values(TRANSLATIONS).flatMap((table) => Object.keys(table)),
  ])].filter((key) => typeof key === "string" && key.length > 0));
  const LOCALE_PLACEHOLDER_RE = /\{[a-zA-Z0-9_.-]+\}/g;
  function localePlaceholders(value) {
    return [...new Set(String(value || "").match(LOCALE_PLACEHOLDER_RE) || [])].sort();
  }
  const LOCALE_FALLBACK_KEYS = {};
  // Materialize the English fallback in every locale table.  This makes a
  // missing translation an explicit, testable state rather than an accidental
  // fall-through in the DOM replacement pass.
  for (const key of LOCALE_SOURCE_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(TRANSLATIONS.en, key)) TRANSLATIONS.en[key] = key;
  }
  for (const [id, table] of Object.entries(TRANSLATIONS)) {
    const fallbackKeys = [];
    for (const key of LOCALE_SOURCE_KEYS) {
      if (Object.prototype.hasOwnProperty.call(table, key)) continue;
      table[key] = TRANSLATIONS.en[key] ?? key;
      fallbackKeys.push(key);
    }
    if (fallbackKeys.length) LOCALE_FALLBACK_KEYS[id] = Object.freeze(fallbackKeys);
  }
  function auditLocales() {
    const missingKeys = {};
    const placeholderMismatches = {};
    const hanLeaks = {};
    for (const [id, table] of Object.entries(TRANSLATIONS)) {
      const missing = LOCALE_SOURCE_KEYS.filter((key) => !Object.prototype.hasOwnProperty.call(table, key));
      if (missing.length) missingKeys[id] = missing;
      const mismatches = [];
      const leaks = [];
      for (const key of LOCALE_SOURCE_KEYS) {
        if (!Object.prototype.hasOwnProperty.call(table, key)) continue;
        const sourcePlaceholders = localePlaceholders(TRANSLATIONS.en[key] ?? key);
        const targetPlaceholders = localePlaceholders(table[key]);
        if (sourcePlaceholders.join("\u0000") !== targetPlaceholders.join("\u0000")) mismatches.push(key);
        // Japanese and the two Chinese locales legitimately contain Han
        // characters; other locales should never contain accidental CJK UI.
        if (!id.startsWith("zh-") && id !== "ja" && /[\u3400-\u9fff]/.test(String(table[key]))) leaks.push(key);
      }
      if (mismatches.length) placeholderMismatches[id] = mismatches;
      if (leaks.length) hanLeaks[id] = leaks;
    }
    return {
      ok: !Object.keys(missingKeys).length && !Object.keys(placeholderMismatches).length && !Object.keys(hanLeaks).length,
      keyCount: LOCALE_SOURCE_KEYS.length,
      localeIds: Object.keys(TRANSLATIONS),
      fallbackKeys: LOCALE_FALLBACK_KEYS,
      missingKeys,
      placeholderMismatches,
      hanLeaks,
    };
  }

  const PROVIDER_COPY = {
    minimax: { en: "MiniMax (International)", "zh-Hant": "MiniMax（國際版）", "zh-Hans": "MiniMax（国际版）", ja: "MiniMax（国際版）", ko: "MiniMax (국제)" },
    "minimax-cn": { en: "MiniMax (China)", "zh-Hant": "MiniMax（中國版）", "zh-Hans": "MiniMax（中国版）", ja: "MiniMax（中国）", ko: "MiniMax (중국)" },
    "opencode-free": { en: "OpenCode Free Models", "zh-Hant": "OpenCode 免費模型", "zh-Hans": "OpenCode 免费模型" },
    "ollama-local": { en: "Ollama (Local)", "zh-Hant": "Ollama（本機）", "zh-Hans": "Ollama（本地）" },
    "lmstudio-local": { en: "LM Studio (Local)", "zh-Hant": "LM Studio（本機）", "zh-Hans": "LM Studio（本地）" },
    "vllm-local": { en: "vLLM (Local)", "zh-Hant": "vLLM（本機）", "zh-Hans": "vLLM（本地）" },
    zai: { en: "Zhipu GLM", "zh-Hant": "智譜 GLM", "zh-Hans": "智谱 GLM" },
    "glm-cn": { en: "BigModel GLM (China)", "zh-Hant": "BigModel GLM（中國）", "zh-Hans": "BigModel GLM（中国）" },
  };

  // Translate back from any previously rendered locale before applying the
  // next locale. This keeps repeated language switches lossless even when a
  // DOM node was rendered in Japanese, Korean, or another supported locale.
  const TRANSLATION_REVERSE_PAIRS = Object.values(TRANSLATIONS)
    .flatMap((table) => Object.entries(table)
      .filter(([key, value]) => value && value !== key)
      .map(([key, value]) => [value, key]))
    .sort((a, b) => b[0].length - a[0].length);

  const SOURCE_KEYS = Object.keys(HAN_TO_EN).sort((a, b) => b.length - a.length);
  const EN_KEYS = Object.keys(Object.assign({}, ...Object.values(TRANSLATIONS))).sort((a, b) => b.length - a.length);
  const HAN_RE = /[\u3400-\u9fff]/;
  const NON_CONTENT = ".md-body, .thinking-block, .tool-command, .tool-output, .code-block, .mermaid-block, .msg.user .bubble, .session-item .s-name, .project-group-copy, [data-i18n-ignore]";
  let locale = "en";
  let localizing = false;
  let localizationQueued = false;
  let localeApplied = false;
  const pendingRoots = new Set();
  const rawTextNodes = new WeakMap();

  function normalizeLocale(value) { return LOCALE_IDS.has(value) ? value : "en"; }
  function replacePairs(value, pairs) {
    let out = String(value);
    for (const key of pairs) out = out.replaceAll(key, pairs === SOURCE_KEYS ? HAN_TO_EN[key] : (TRANSLATIONS[locale]?.[key] || key));
    return out;
  }
  function sourceToEnglish(value) {
    let out = String(value);
    for (const key of SOURCE_KEYS) out = out.replaceAll(key, HAN_TO_EN[key]);
    for (const [translated, key] of TRANSLATION_REVERSE_PAIRS) out = out.replaceAll(translated, key);
    return out;
  }
  function translate(value, target = locale) {
    if (value == null || typeof value !== "string" || !value) return value;
    const source = sourceToEnglish(value);
    const table = TRANSLATIONS[target] || {};
    let out = source;
    for (const key of EN_KEYS) {
      const translated = table[key];
      if (translated && translated !== key) out = out.replaceAll(key, translated);
    }
    // A non-Chinese UI must never expose a legacy Chinese chrome string. User
    // prompts and model output are excluded from the DOM walk below.
    // Japanese legitimately contains kanji; never scrub CJK from ja. Other
    // locales only scrub unresolved legacy Chinese chrome as a final guard.
    if (!target.startsWith("zh-") && target !== "ja" && HAN_RE.test(out)) out = out.replace(/[\u3400-\u9fff]+/g, "").replace(/\s{2,}/g, " ").trim();
    return out;
  }
  function shouldSkip(node) {
    const element = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
    return !!element?.closest(NON_CONTENT);
  }
  function localizeAttributes(root) {
    const elements = [];
    if (root?.nodeType === Node.ELEMENT_NODE && root.matches?.("[title], [aria-label], [placeholder]")) elements.push(root);
    if (root?.querySelectorAll) elements.push(...root.querySelectorAll("[title], [aria-label], [placeholder]"));
    for (const item of elements) {
      for (const attr of ["title", "aria-label", "placeholder"]) {
        if (item.hasAttribute(attr)) {
          // DOMStringMap keys cannot contain hyphens (e.g. `i18nAria-label`).
          // Keep a stable, camel-cased source value so localization can be
          // applied repeatedly when the user switches languages.
          const rawKey = attr === "aria-label"
            ? "i18nAriaLabel"
            : `i18n${attr[0].toUpperCase()}${attr.slice(1)}`;
          const current = item.getAttribute(attr) || "";
          const lastKey = `${rawKey}Last`;
          // If application code changed the attribute since the last render,
          // treat the new value as the source rather than keeping stale text.
          if (!item.dataset[rawKey] || item.dataset[lastKey] !== current) item.dataset[rawKey] = current;
          const translated = translate(item.dataset[rawKey], locale);
          item.dataset[lastKey] = translated;
          // Avoid writing the same attribute value repeatedly. MutationObserver
          // watches attributes, so unconditional writes would create a loop.
          if (item.getAttribute(attr) !== translated) item.setAttribute(attr, translated);
        }
      }
    }
  }
  function localizeDom(root = document) {
    // MutationObserver passes Element roots for newly rendered rows and
    // dialogs. The old body-only guard silently skipped those nodes, leaving
    // dynamically inserted Chinese chrome visible in the English UI.
    if (!root || (root !== document && root.nodeType !== Node.ELEMENT_NODE)) return;
    if (localizing) return;
    localizing = true;
    try {
      const walker = document.createTreeWalker(root.body || root, NodeFilter.SHOW_TEXT);
      const nodes = [];
      let node;
      while ((node = walker.nextNode())) nodes.push(node);
      for (const textNode of nodes) {
        if (shouldSkip(textNode)) continue;
        const current = textNode.nodeValue;
        const previous = rawTextNodes.get(textNode);
        const raw = previous && current === previous.lastRendered ? previous.raw : current;
        if (!raw || !raw.trim()) continue;
        const translated = translate(raw, locale);
        if (translated !== current) textNode.nodeValue = translated;
        rawTextNodes.set(textNode, { raw, lastRendered: translated });
      }
      localizeAttributes(root.body || root);
      const localeSelect = document.getElementById("set-locale");
      if (localeSelect) localeSelect.value = locale;
    } finally { localizing = false; }
  }
  function queueLocalize(records = []) {
    for (const record of records || []) {
      const target = record.target;
      if (target && target.id !== "messages" && !shouldSkip(target)) pendingRoots.add(target);
      for (const node of record.addedNodes || []) {
        if (node.nodeType === Node.ELEMENT_NODE && !shouldSkip(node)) pendingRoots.add(node);
      }
    }
    if (localizationQueued) return;
    localizationQueued = true;
    queueMicrotask(() => {
      localizationQueued = false;
      const roots = [...pendingRoots];
      pendingRoots.clear();
      if (roots.length > 16) localizeDom();
      else for (const root of roots) localizeDom(root);
    });
  }
  function setLocale(value) {
    const next = normalizeLocale(value);
    const changed = next !== locale;
    locale = next;
    document.documentElement.lang = locale;
    document.documentElement.dir = "ltr";
    if (changed || !localeApplied) localizeDom();
    localeApplied = true;
    return locale;
  }
  function getLocale() { return locale; }
  function t(key, vars = {}) {
    let out = translate(String(key), locale);
    for (const [name, value] of Object.entries(vars)) out = out.replaceAll(`{${name}}`, String(value));
    return out;
  }
  function providerName(provider) {
    const id = typeof provider === "string" ? provider : provider?.id;
    const copy = PROVIDER_COPY[id];
    return copy?.[locale] || copy?.en || (typeof provider === "string" ? provider : provider?.name) || id || "Provider";
  }
  function providerDescription(provider) {
    return translate(typeof provider === "string" ? provider : provider?.description || "", locale);
  }

  window.piI18n = Object.freeze({ locales: LOCALES, normalizeLocale, getLocale, setLocale, localize: localizeDom, queue: queueLocalize, t, translate, providerName, providerDescription, auditLocales });
  try {
    const raw = localStorage.getItem("piweb.settings.v2") || localStorage.getItem("piweb.settings.v1") || "{}";
    locale = normalizeLocale(JSON.parse(raw).locale);
  } catch {}
  new MutationObserver((records) => queueLocalize(records)).observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ["title", "aria-label", "placeholder"] });
  setLocale(locale);
})();
