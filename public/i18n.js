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
      "Sign in": "サインイン", "Settings": "設定", "Back": "戻る", "Back to sessions": "セッションに戻る", "Back to settings": "設定に戻る", "More": "その他", "New conversation": "新しい会話", "Switch device": "デバイスを切り替え", "Add device": "デバイスを追加", "Refresh": "更新", "Toggle project grouping": "プロジェクトのグループ化", "Search sessions…": "セッションを検索…", "No sessions on this device.": "このデバイスにセッションはありません。", "Latest": "最新", "Jump to latest": "最新へ移動", "Add attachment": "添付を追加", "Choose model": "モデルを選択", "Server default": "サーバーの既定", "Thinking level": "思考レベル", "Stop": "停止", "Send": "送信", "Loading…": "読み込み中…", "Cancel": "キャンセル", "Save": "保存", "Confirm": "確認", "Done": "完了", "Copy": "コピー", "Model & reasoning": "モデルと推論", "Rename": "名前を変更", "Delete (move to Trash)": "削除（ゴミ箱へ）", "Models & providers": "モデルとプロバイダー", "Add provider": "プロバイダーを追加", "Search providers…": "プロバイダーを検索…", "Choose a service": "サービスを選択", "Sign in with an account": "アカウントでサインイン", "Use an API key": "API キーを使用", "Use directly": "直接使用", "Back to provider list": "プロバイダー一覧に戻る", "Custom provider": "カスタムプロバイダー", "Devices": "デバイス", "Connection": "接続", "This device": "このデバイス", "Total sessions": "セッション数", "Sign out": "サインアウト", "Interface": "インターフェース", "Language": "言語", "Appearance": "外観", "System": "システムに合わせる", "Light": "ライト", "Dark": "ダーク", "Design theme": "デザインテーマ", "Compact list": "コンパクトリスト", "Text size": "文字サイズ", "Group by project": "プロジェクトでグループ化", "Reduce motion": "モーションを減らす", "Thinking blocks": "思考ブロック", "Collapsed": "折りたたみ", "Expanded": "展開", "About": "概要", "Choose a project folder": "プロジェクトフォルダーを選択", "Selected location": "選択した場所", "Session name (optional)": "セッション名（任意）", "Start here": "ここから開始", "Parent folder": "親フォルダー", "Home folder": "ホームフォルダー", "Image viewer": "画像ビューアー", "Close image": "画像を閉じる", "Close": "閉じる", "Your response is needed": "回答が必要です",
    },
    ko: {
      "Sign in": "로그인", "Settings": "설정", "Back": "뒤로", "Back to sessions": "세션으로 돌아가기", "Back to settings": "설정으로 돌아가기", "More": "더 보기", "New conversation": "새 대화", "Switch device": "기기 전환", "Add device": "기기 추가", "Refresh": "새로 고침", "Toggle project grouping": "프로젝트 그룹 전환", "Search sessions…": "세션 검색…", "No sessions on this device.": "이 기기에 세션이 없습니다.", "Latest": "최신", "Jump to latest": "최신으로 이동", "Add attachment": "첨부 추가", "Choose model": "모델 선택", "Server default": "서버 기본값", "Thinking level": "사고 수준", "Stop": "중지", "Send": "보내기", "Loading…": "로드 중…", "Cancel": "취소", "Save": "저장", "Confirm": "확인", "Done": "완료", "Copy": "복사", "Model & reasoning": "모델 및 추론", "Rename": "이름 변경", "Delete (move to Trash)": "삭제(휴지통으로 이동)", "Models & providers": "모델 및 Provider", "Add provider": "Provider 추가", "Search providers…": "Provider 검색…", "Choose a service": "서비스 선택", "Sign in with an account": "계정으로 로그인", "Use an API key": "API 키 사용", "Use directly": "직접 사용", "Back to provider list": "Provider 목록으로", "Custom provider": "사용자 지정 Provider", "Devices": "기기", "Connection": "연결", "This device": "이 기기", "Total sessions": "전체 세션", "Sign out": "로그아웃", "Interface": "인터페이스", "Language": "언어", "Appearance": "모양", "System": "시스템 설정", "Light": "밝게", "Dark": "어둡게", "Design theme": "디자인 테마", "Compact list": "간결한 목록", "Text size": "글자 크기", "Group by project": "프로젝트별 그룹화", "Reduce motion": "동작 줄이기", "Thinking blocks": "사고 블록", "Collapsed": "접힘", "Expanded": "펼침", "About": "정보", "Choose a project folder": "프로젝트 폴더 선택", "Selected location": "선택한 위치", "Session name (optional)": "세션 이름(선택 사항)", "Start here": "여기서 시작", "Parent folder": "상위 폴더", "Home folder": "홈 폴더", "Image viewer": "이미지 뷰어", "Close image": "이미지 닫기", "Close": "닫기", "Your response is needed": "응답이 필요합니다",
    },
    tr: {
      "Sign in": "Giriş yap", "Settings": "Ayarlar", "Back": "Geri", "Back to sessions": "Oturumlara dön", "Back to settings": "Ayarlara dön", "More": "Daha fazla", "New conversation": "Yeni konuşma", "Switch device": "Cihazı değiştir", "Add device": "Cihaz ekle", "Refresh": "Yenile", "Toggle project grouping": "Proje gruplamasını değiştir", "Search sessions…": "Oturumlarda ara…", "No sessions on this device.": "Bu cihazda oturum yok.", "Latest": "En yeni", "Jump to latest": "En yeniye git", "Add attachment": "Ek ekle", "Choose model": "Model seç", "Server default": "Sunucu varsayılanı", "Thinking level": "Düşünme düzeyi", "Stop": "Durdur", "Send": "Gönder", "Loading…": "Yükleniyor…", "Cancel": "İptal", "Save": "Kaydet", "Confirm": "Onayla", "Done": "Bitti", "Copy": "Kopyala", "Model & reasoning": "Model ve akıl yürütme", "Rename": "Yeniden adlandır", "Delete (move to Trash)": "Sil (Çöp Kutusu'na taşı)", "Models & providers": "Modeller ve sağlayıcılar", "Add provider": "Sağlayıcı ekle", "Search providers…": "Sağlayıcılarda ara…", "Choose a service": "Bir hizmet seç", "Sign in with an account": "Hesapla giriş yap", "Use an API key": "API anahtarı kullan", "Use directly": "Doğrudan kullan", "Back to provider list": "Sağlayıcı listesine dön", "Custom provider": "Özel sağlayıcı", "Devices": "Cihazlar", "Connection": "Bağlantı", "This device": "Bu cihaz", "Total sessions": "Toplam oturum", "Sign out": "Çıkış yap", "Interface": "Arayüz", "Language": "Dil", "Appearance": "Görünüm", "System": "Sistem", "Light": "Açık", "Dark": "Koyu", "Design theme": "Tasarım teması", "Compact list": "Sıkı liste", "Text size": "Metin boyutu", "Group by project": "Projeye göre grupla", "Reduce motion": "Hareketi azalt", "Thinking blocks": "Düşünme blokları", "Collapsed": "Daraltılmış", "Expanded": "Genişletilmiş", "About": "Hakkında", "Choose a project folder": "Proje klasörü seç", "Selected location": "Seçilen konum", "Session name (optional)": "Oturum adı (isteğe bağlı)", "Start here": "Buradan başla", "Parent folder": "Üst klasör", "Home folder": "Ana klasör", "Image viewer": "Görüntüleyici", "Close image": "Görseli kapat", "Close": "Kapat", "Your response is needed": "Yanıtınız gerekiyor",
    },
    fr: {
      "Sign in": "Se connecter", "Settings": "Réglages", "Back": "Retour", "Back to sessions": "Retour aux sessions", "Back to settings": "Retour aux réglages", "More": "Plus", "New conversation": "Nouvelle conversation", "Switch device": "Changer d’appareil", "Add device": "Ajouter un appareil", "Refresh": "Actualiser", "Toggle project grouping": "Basculer le regroupement par projet", "Search sessions…": "Rechercher des sessions…", "No sessions on this device.": "Aucune session sur cet appareil.", "Latest": "Récent", "Jump to latest": "Aller au plus récent", "Add attachment": "Ajouter une pièce jointe", "Choose model": "Choisir un modèle", "Server default": "Valeur serveur", "Thinking level": "Niveau de réflexion", "Stop": "Arrêter", "Send": "Envoyer", "Loading…": "Chargement…", "Cancel": "Annuler", "Save": "Enregistrer", "Confirm": "Confirmer", "Done": "Terminé", "Copy": "Copier", "Model & reasoning": "Modèle et raisonnement", "Rename": "Renommer", "Delete (move to Trash)": "Supprimer (mettre à la corbeille)", "Models & providers": "Modèles et fournisseurs", "Add provider": "Ajouter un fournisseur", "Search providers…": "Rechercher des fournisseurs…", "Choose a service": "Choisir un service", "Sign in with an account": "Se connecter avec un compte", "Use an API key": "Utiliser une clé API", "Use directly": "Utiliser directement", "Back to provider list": "Retour à la liste", "Custom provider": "Fournisseur personnalisé", "Devices": "Appareils", "Connection": "Connexion", "This device": "Cet appareil", "Total sessions": "Sessions totales", "Sign out": "Se déconnecter", "Interface": "Interface", "Language": "Langue", "Appearance": "Apparence", "System": "Système", "Light": "Clair", "Dark": "Sombre", "Design theme": "Thème visuel", "Compact list": "Liste compacte", "Text size": "Taille du texte", "Group by project": "Grouper par projet", "Reduce motion": "Réduire les animations", "Thinking blocks": "Blocs de réflexion", "Collapsed": "Réduit", "Expanded": "Développé", "About": "À propos", "Choose a project folder": "Choisir un dossier de projet", "Selected location": "Emplacement sélectionné", "Session name (optional)": "Nom de session (facultatif)", "Start here": "Commencer ici", "Parent folder": "Dossier parent", "Home folder": "Dossier personnel", "Image viewer": "Visionneuse d’images", "Close image": "Fermer l’image", "Close": "Fermer", "Your response is needed": "Votre réponse est requise",
    },
    de: {
      "Sign in": "Anmelden", "Settings": "Einstellungen", "Back": "Zurück", "Back to sessions": "Zu den Sitzungen", "Back to settings": "Zu den Einstellungen", "More": "Mehr", "New conversation": "Neue Unterhaltung", "Switch device": "Gerät wechseln", "Add device": "Gerät hinzufügen", "Refresh": "Aktualisieren", "Toggle project grouping": "Projektgruppierung umschalten", "Search sessions…": "Sitzungen durchsuchen…", "No sessions on this device.": "Keine Sitzungen auf diesem Gerät.", "Latest": "Neueste", "Jump to latest": "Zur neuesten wechseln", "Add attachment": "Anhang hinzufügen", "Choose model": "Modell auswählen", "Server default": "Serverstandard", "Thinking level": "Denkstufe", "Stop": "Stopp", "Send": "Senden", "Loading…": "Wird geladen…", "Cancel": "Abbrechen", "Save": "Speichern", "Confirm": "Bestätigen", "Done": "Fertig", "Copy": "Kopieren", "Model & reasoning": "Modell und Schlussfolgerung", "Rename": "Umbenennen", "Delete (move to Trash)": "Löschen (in den Papierkorb)", "Models & providers": "Modelle und Anbieter", "Add provider": "Anbieter hinzufügen", "Search providers…": "Anbieter durchsuchen…", "Choose a service": "Dienst auswählen", "Sign in with an account": "Mit Konto anmelden", "Use an API key": "API-Schlüssel verwenden", "Use directly": "Direkt verwenden", "Back to provider list": "Zur Anbieterliste", "Custom provider": "Benutzerdefinierter Anbieter", "Devices": "Geräte", "Connection": "Verbindung", "This device": "Dieses Gerät", "Total sessions": "Sitzungen gesamt", "Sign out": "Abmelden", "Interface": "Oberfläche", "Language": "Sprache", "Appearance": "Darstellung", "System": "System", "Light": "Hell", "Dark": "Dunkel", "Design theme": "Designthema", "Compact list": "Kompakte Liste", "Text size": "Textgröße", "Group by project": "Nach Projekt gruppieren", "Reduce motion": "Bewegung reduzieren", "Thinking blocks": "Denkblöcke", "Collapsed": "Eingeklappt", "Expanded": "Ausgeklappt", "About": "Über", "Choose a project folder": "Projektordner auswählen", "Selected location": "Ausgewählter Ort", "Session name (optional)": "Sitzungsname (optional)", "Start here": "Hier starten", "Parent folder": "Übergeordneter Ordner", "Home folder": "Home-Ordner", "Image viewer": "Bildanzeige", "Close image": "Bild schließen", "Close": "Schließen", "Your response is needed": "Ihre Antwort wird benötigt",
    },
    es: {
      "Sign in": "Iniciar sesión", "Settings": "Ajustes", "Back": "Atrás", "Back to sessions": "Volver a sesiones", "More": "Más", "New conversation": "Nueva conversación", "Switch device": "Cambiar dispositivo", "Add device": "Añadir dispositivo", "Refresh": "Actualizar", "Search sessions…": "Buscar sesiones…", "No sessions on this device.": "No hay sesiones en este dispositivo.", "Latest": "Más reciente", "Add attachment": "Añadir archivo", "Choose model": "Elegir modelo", "Stop": "Detener", "Send": "Enviar", "Loading…": "Cargando…", "Cancel": "Cancelar", "Save": "Guardar", "Confirm": "Confirmar", "Done": "Listo", "Copy": "Copiar", "Rename": "Cambiar nombre", "Delete (move to Trash)": "Eliminar (mover a la papelera)", "Models & providers": "Modelos y proveedores", "Add provider": "Añadir proveedor", "Search providers…": "Buscar proveedores…", "Choose a service": "Elegir un servicio", "Sign in with an account": "Iniciar sesión con una cuenta", "Use an API key": "Usar una clave API", "Use directly": "Usar directamente", "Custom provider": "Proveedor personalizado", "Devices": "Dispositivos", "Connection": "Conexión", "This device": "Este dispositivo", "Total sessions": "Sesiones totales", "Sign out": "Cerrar sesión", "Interface": "Interfaz", "Language": "Idioma", "Appearance": "Apariencia", "System": "Sistema", "Light": "Claro", "Dark": "Oscuro", "Design theme": "Tema de diseño", "Compact list": "Lista compacta", "Text size": "Tamaño del texto", "Group by project": "Agrupar por proyecto", "Reduce motion": "Reducir movimiento", "About": "Acerca de", "Choose a project folder": "Elegir una carpeta de proyecto", "Selected location": "Ubicación seleccionada", "Session name (optional)": "Nombre de sesión (opcional)", "Start here": "Empezar aquí", "Parent folder": "Carpeta superior", "Home folder": "Carpeta de inicio", "Close": "Cerrar",
    },
    "pt-BR": {
      "Sign in": "Entrar", "Settings": "Configurações", "Back": "Voltar", "Back to sessions": "Voltar às sessões", "More": "Mais", "New conversation": "Nova conversa", "Switch device": "Trocar dispositivo", "Add device": "Adicionar dispositivo", "Refresh": "Atualizar", "Search sessions…": "Pesquisar sessões…", "No sessions on this device.": "Não há sessões neste dispositivo.", "Latest": "Mais recente", "Add attachment": "Adicionar anexo", "Choose model": "Escolher modelo", "Stop": "Parar", "Send": "Enviar", "Loading…": "Carregando…", "Cancel": "Cancelar", "Save": "Salvar", "Confirm": "Confirmar", "Done": "Concluído", "Copy": "Copiar", "Rename": "Renomear", "Delete (move to Trash)": "Excluir (mover para a lixeira)", "Models & providers": "Modelos e provedores", "Add provider": "Adicionar provedor", "Search providers…": "Pesquisar provedores…", "Choose a service": "Escolha um serviço", "Sign in with an account": "Entrar com uma conta", "Use an API key": "Usar uma chave de API", "Use directly": "Usar diretamente", "Custom provider": "Provedor personalizado", "Devices": "Dispositivos", "Connection": "Conexão", "This device": "Este dispositivo", "Total sessions": "Total de sessões", "Sign out": "Sair", "Interface": "Interface", "Language": "Idioma", "Appearance": "Aparência", "System": "Sistema", "Light": "Claro", "Dark": "Escuro", "Design theme": "Tema de design", "Compact list": "Lista compacta", "Text size": "Tamanho do texto", "Group by project": "Agrupar por projeto", "Reduce motion": "Reduzir movimento", "About": "Sobre", "Choose a project folder": "Escolher uma pasta de projeto", "Selected location": "Local selecionado", "Session name (optional)": "Nome da sessão (opcional)", "Start here": "Começar aqui", "Parent folder": "Pasta pai", "Home folder": "Pasta inicial", "Close": "Fechar",
    },
    it: {
      "Sign in": "Accedi", "Settings": "Impostazioni", "Back": "Indietro", "Back to sessions": "Torna alle sessioni", "More": "Altro", "New conversation": "Nuova conversazione", "Switch device": "Cambia dispositivo", "Add device": "Aggiungi dispositivo", "Refresh": "Aggiorna", "Search sessions…": "Cerca sessioni…", "No sessions on this device.": "Nessuna sessione su questo dispositivo.", "Latest": "Più recente", "Add attachment": "Aggiungi allegato", "Choose model": "Scegli modello", "Stop": "Ferma", "Send": "Invia", "Loading…": "Caricamento…", "Cancel": "Annulla", "Save": "Salva", "Confirm": "Conferma", "Done": "Fatto", "Copy": "Copia", "Rename": "Rinomina", "Delete (move to Trash)": "Elimina (sposta nel Cestino)", "Models & providers": "Modelli e provider", "Add provider": "Aggiungi provider", "Search providers…": "Cerca provider…", "Choose a service": "Scegli un servizio", "Sign in with an account": "Accedi con un account", "Use an API key": "Usa una chiave API", "Use directly": "Usa direttamente", "Custom provider": "Provider personalizzato", "Devices": "Dispositivi", "Connection": "Connessione", "This device": "Questo dispositivo", "Total sessions": "Sessioni totali", "Sign out": "Esci", "Interface": "Interfaccia", "Language": "Lingua", "Appearance": "Aspetto", "System": "Sistema", "Light": "Chiaro", "Dark": "Scuro", "Design theme": "Tema di design", "Compact list": "Elenco compatto", "Text size": "Dimensione testo", "Group by project": "Raggruppa per progetto", "Reduce motion": "Riduci movimento", "About": "Informazioni", "Choose a project folder": "Scegli una cartella progetto", "Selected location": "Posizione selezionata", "Session name (optional)": "Nome sessione (facoltativo)", "Start here": "Inizia qui", "Parent folder": "Cartella principale", "Home folder": "Cartella home", "Close": "Chiudi",
    },
  };
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
    if (!target.startsWith("zh-") && HAN_RE.test(out)) out = out.replace(/[\u3400-\u9fff]+/g, "").replace(/\s{2,}/g, " ").trim();
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
        if (item.hasAttribute(attr) && !item.dataset.i18nRaw) item.dataset.i18nRaw = "";
        if (item.hasAttribute(attr)) {
          // DOMStringMap keys cannot contain hyphens (e.g. `i18nAria-label`).
          // Keep a stable, camel-cased source value so localization can be
          // applied repeatedly when the user switches languages.
          const rawKey = attr === "aria-label"
            ? "i18nAriaLabel"
            : `i18n${attr[0].toUpperCase()}${attr.slice(1)}`;
          item.dataset[rawKey] ||= item.getAttribute(attr);
          const translated = translate(item.dataset[rawKey], locale);
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
        const raw = rawTextNodes.has(textNode) ? rawTextNodes.get(textNode) : textNode.nodeValue;
        if (!raw || !raw.trim()) continue;
        if (!rawTextNodes.has(textNode)) rawTextNodes.set(textNode, raw);
        const translated = translate(raw, locale);
        if (translated !== raw) textNode.nodeValue = translated;
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

  window.piI18n = Object.freeze({ locales: LOCALES, normalizeLocale, getLocale, setLocale, localize: localizeDom, queue: queueLocalize, t, translate, providerName, providerDescription });
  try {
    const raw = localStorage.getItem("piweb.settings.v2") || localStorage.getItem("piweb.settings.v1") || "{}";
    locale = normalizeLocale(JSON.parse(raw).locale);
  } catch {}
  new MutationObserver((records) => queueLocalize(records)).observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ["title", "aria-label", "placeholder"] });
  setLocale(locale);
})();
