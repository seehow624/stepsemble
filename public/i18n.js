/* pi-harbor locale layer. English is the source language and the safe fallback. */
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
    "已在這台設備上": "Already using this device", "在線": "Online", "離線": "Offline", "檢查中": "Checking", "尚未檢查": "Not checked", "使用中": "In use", "儲存後會自動加入設備清單。": "The device will be added after saving.", "儲存設備": "Save device", "測試連線": "Test connection", "刪除設備": "Delete device", "使用配對碼加入": "Join with pairing code", "產生新的配對碼": "Generate new pairing code", "驗證並加入": "Verify and add", "重新啟動 Pi Harbor": "Restart Pi Harbor", "主機名稱（可選）": "Host name (optional)", "設備名稱": "Device name", "Pi Harbor 網址": "Pi Harbor URL", "本機 Pi Harbor port": "Local Pi Harbor port", "配對碼已複製": "Pairing code copied", "配對碼已產生，請手動複製": "Pairing code generated; copy it manually", "無法產生配對碼": "Could not generate pairing code", "設備配對成功": "Device paired", "設備配對失敗": "Device pairing failed", "登入已過期": "Sign-in expired",
    "要恢復介面預設設定嗎？登入狀態與 session 不會受到影響。": "Restore interface defaults? Sign-in and sessions will not be affected.", "介面設定已恢復預設": "Interface defaults restored",
    "選擇專案資料夾": "Choose a project folder", "選擇的位置": "Selected location", "Session 名稱（可留空）": "Session name (optional)", "在這裡開始": "Start here", "家目錄": "Home folder", "上一層": "Parent folder", "選擇一個資料夾": "Choose a folder",
    "Session 名稱": "Session name", "目前狀態：": "Current status: ", "配對碼 5 分鐘內有效，複製到另一台 Pi Harbor 使用。": "Pairing code is valid for 5 minutes; paste it into another Pi Harbor.",
    "正在驗證配對碼並測試遠端連線…": "Verifying pairing code and testing the remote connection…", "配對失敗；請確認配對碼尚未過期，以及兩台設備使用相同 token。": "Pairing failed; check that the code has not expired and both devices use the same token.",
    "請貼上另一台設備產生的配對碼。": "Paste the pairing code generated by the other device.", "目前無法讀取設備清單": "Could not load device list", "無法讀取設備清單": "Could not load device list",
    "PI AGENT DEVICE": "PI AGENT DEVICE", "MODEL PROVIDER": "MODEL PROVIDER", "NEW PROJECT": "NEW PROJECT",
    "圖片檢視": "Image viewer", "關閉圖片": "Close image", "關閉模型選單": "Close model menu", "關閉": "Close",
    "工作已中止": "Work stopped", "工作失敗": "Work failed", "工作在完成事件前停止；請檢查連線或重試。": "Work stopped before completion; check the connection or retry.", "沒有收到結束原因": "No stop reason was received",
    "已切換到": "Switched to ", "天前": " days ago", "(未命名)": "(Untitled)", "顯示更多（": "Show more (", "已移到垃圾桶": "Moved to Trash", "刪除失敗：": "Delete failed: ", "重新命名失敗：": "Rename failed: ", "歷史讀取失敗": "History load failed", "即時連線中斷，": "Live connection interrupted; ", "秒後自動恢復…": "s until automatic recovery…", "本次對話用量": "Usage for this conversation", "（執行中…）": "(Running…)", "（沒有收到工具輸出）": "(No tool output received)", "（無輸出）": "(No output)", "回覆 Provider 登入失敗：": "Provider sign-in response failed: ", "回覆 Pi 失敗：": "Pi response failed: ", "Pi 通知": "Pi notification", "秒": "s", "分鐘": "min", "仍在": "Still ", "連線暫時失敗，正在重試": "Connection temporarily failed; retrying", "重試失敗，請檢查模型或連線": "Retry failed; check the model or connection", "上下文整理暫時失敗，準備重試…": "Context preparation failed temporarily; retrying…", "正在重試整理上下文": "Retrying context preparation", "擴充功能錯誤：": "Extension error: ", "未知錯誤": "Unknown error", "暫時失敗": "Temporarily failed", "模型暫時失敗，準備重試：": "Model temporarily failed; retrying: ", "則訊息排隊中": " message(s) queued", "Pi 無法啟動": "Pi could not start", "Pi 工作程序已中斷": "Pi work process stopped", "這次工作被停止，沒有產生完整回覆。": "This work was stopped before a complete response was produced.", "Pi 沒有提供錯誤原因，請檢查連線或按重試。": "Pi did not provide a reason; check the connection or retry.", "連線已恢復，工作仍在繼續…": "Connection restored; work is continuing…", "⏳": "⏳", "不是圖片檔案": "Not an image file", "圖片太大，請先壓縮後再貼上": "Image is too large; compress it before pasting", "無法處理圖片": "Could not process image", "圖片讀取失敗": "Could not read image", "圖片壓縮失敗": "Image compression failed", "無法讀取圖片": "Could not read image", "最多 4 張圖片": "Up to 4 images", "圖片處理失敗": "Image processing failed", "正在加入圖片…": "Adding image…", "瀏覽器沒有提供可讀取的圖片，請先點擊輸入框再貼上": "The browser did not provide a readable image. Focus the message box and paste again.", "正在加入圖片…": "Adding image…", "張圖片已加入": " image(s) added", "留空以保留目前 API key": "Leave empty to keep the current API key", "可填 $ENV_VAR 或 !command": "You may use $ENV_VAR or !command", "請修正 models.json 後重新讀取。": "Fix models.json and reload.", "沒有讀到可用模型，點右上角重新讀取。": "No available models. Click reload above.", "找不到「": "No matches for \"", "」；可以試試服務商名稱或 Provider ID。": "\"; try a provider name or ID.", "個服務": " service(s)", "已加入；模型清單已更新。": " added; model list updated.", "已加入；重新掃描可以更新模型清單。": " added; rescan to update the model list.", "按一下直接掃描這台 Mac 的本機模型。": "Click to scan local models on this Mac.", "已有登入設定；重新選擇登入方式即可更新。": " already has sign-in details; choose a method again to update.", "選一種登入方式開始。": "Choose a sign-in method to begin.", "正在儲存並檢查 API key…": "Saving and checking API key…", "API key 尚未儲存，請確認區域與 key 是否相符。": "API key was not saved. Check that the region and key match.", "免費 Provider 設定失敗": "Free provider setup failed", "確定移除「": "Remove \"", "」？": "\"?", "免費清單重新加入": "add it again from the free list", "登入設定已移除": " sign-in removed", "移除登入設定失敗": "Could not remove sign-in", "請填寫 Provider ID、Base URL，並至少加入一個模型。": "Enter a provider ID and base URL, and add at least one model.", "從 models.json 移除「": "Remove \"", "不會刪除 auth.json 的登入憑證。": "auth.json credentials will not be deleted.", "刪除失敗": "Delete failed", "讀取本機設備設定失敗": "Could not load local device settings", "正在測試連線…": "Testing connection…", "連線成功，Pi Harbor 正常回應。": "Connection succeeded; Pi Harbor responded normally.", "連線失敗；請確認 Pi Harbor、port 與 Tailscale／HTTPS 網址。": "Connection failed; check Pi Harbor, the port, and the Tailscale/HTTPS URL.", "請填寫設備名稱。": "Enter a device name.", "請填寫設備名稱與 Pi Harbor 網址。": "Enter a device name and Pi Harbor URL.", "Pi Harbor port 必須是 1024–65535 的整數。": "Pi Harbor port must be an integer from 1024 to 65535.", "設定已保存；新的 port 需要重新啟動 Pi Harbor 後才會生效。": "Settings saved; the new port takes effect after Pi Harbor restarts.", "設備名稱已更新；port 等待重啟後生效": "Device name updated; port will apply after restart", "本機設備設定已更新": "Local device settings updated", "設備已更新": "Device updated", "設備已加入": "Device added", "重新啟動 Pi Harbor 會中斷目前的瀏覽連線；正在執行的 Pi 工作會先嘗試安全收尾。要繼續嗎？": "Restarting Pi Harbor will interrupt this browser connection; running Pi work will try to finish safely first. Continue?", "正在要求 Pi Harbor 重新啟動…": "Requesting Pi Harbor restart…", "Pi Harbor 正在重新啟動": "Pi Harbor is restarting", "無法重新啟動 Pi Harbor": "Could not restart Pi Harbor", "確定要刪除": "Delete ", "設備已刪除": "Device deleted", "設備刪除失敗": "Could not delete device", "這裡沒有可進入的子資料夾": "There are no subfolders to open", "讀取資料夾中…": "Loading folders…", "讀取失敗": "Load failed", "無法讀取資料夾：": "Could not read folder: ", "請先選擇一個資料夾": "Choose a folder first", "新版已準備好；目前工作完成後可重新整理。": "A new version is ready; refresh after current work finishes.", "Pi Harbor 已更新，正在重新載入…": "Pi Harbor updated; reloading…", "重試": "Retry", "顯示更多 sessions": "Show more sessions",
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

  // First-login guidance is deliberately explicit in every locale. The shell
  // command itself is marked data-i18n-ignore in index.html; these strings
  // explain where a user may safely obtain the token without disclosing it.
  const FIRST_LOGIN_TRANSLATIONS = {
    en: {
      "First time?": "First time?",
      "The installer creates a private Web token on the computer running Pi Harbor.": "The installer creates a private Web token on the computer running Pi Harbor.",
      "On that computer, open a terminal and run the command for its operating system:": "On that computer, open a terminal and run the command for its operating system:",
      "Open Terminal from Applications → Utilities, then run:": "Open Terminal from Applications → Utilities, then run:",
      "Open your terminal emulator, then run:": "Open your terminal emulator, then run:",
      "Open PowerShell from the Start menu, then run:": "Open PowerShell from the Start menu, then run:",
      "In Command Prompt, run this instead:": "In Command Prompt, run this instead:",
      "If a custom PI_HARBOR_TOKEN_FILE is configured, use that file instead of the default path.": "If a custom PI_HARBOR_TOKEN_FILE is configured, use that file instead of the default path.",
      "From another device, retrieve the token securely from that host and paste it here.": "From another device, retrieve the token securely from that host and paste it here.",
      "Never share the token in chat, screenshots, repositories, or logs.": "Never share the token in chat, screenshots, repositories, or logs.",
    },
    "zh-Hant": {
      "First time?": "第一次使用嗎？",
      "The installer creates a private Web token on the computer running Pi Harbor.": "安裝程式會在執行 Pi Harbor 的電腦上建立私密 Web token。",
      "On that computer, open a terminal and run the command for its operating system:": "請在該電腦開啟終端機，執行對應作業系統的指令：",
      "Open Terminal from Applications → Utilities, then run:": "從「應用程式 → 工具程式」開啟「終端機」，然後執行：",
      "Open your terminal emulator, then run:": "開啟你的終端機程式，然後執行：",
      "Open PowerShell from the Start menu, then run:": "從「開始」功能表開啟 PowerShell，然後執行：",
      "In Command Prompt, run this instead:": "若使用命令提示字元，請改執行：",
      "If a custom PI_HARBOR_TOKEN_FILE is configured, use that file instead of the default path.": "如果設定了自訂 PI_HARBOR_TOKEN_FILE，請改用該檔案，不要使用預設路徑。",
      "From another device, retrieve the token securely from that host and paste it here.": "從其他裝置安全地向該主機取得 token，然後貼到這裡。",
      "Never share the token in chat, screenshots, repositories, or logs.": "絕不要在聊天、截圖、程式碼儲存庫或日誌中分享 token。",
    },
    "zh-Hans": {
      "First time?": "第一次使用吗？",
      "The installer creates a private Web token on the computer running Pi Harbor.": "安装程序会在运行 Pi Harbor 的电脑上创建私密 Web token。",
      "On that computer, open a terminal and run the command for its operating system:": "请在那台电脑打开终端，运行对应操作系统的命令：",
      "Open Terminal from Applications → Utilities, then run:": "从“应用程序 → 实用工具”打开“终端”，然后运行：",
      "Open your terminal emulator, then run:": "打开你的终端程序，然后运行：",
      "Open PowerShell from the Start menu, then run:": "从“开始”菜单打开 PowerShell，然后运行：",
      "In Command Prompt, run this instead:": "如果使用命令提示符，请改为运行：",
      "If a custom PI_HARBOR_TOKEN_FILE is configured, use that file instead of the default path.": "如果配置了自定义 PI_HARBOR_TOKEN_FILE，请改用该文件，而不是默认路径。",
      "From another device, retrieve the token securely from that host and paste it here.": "从其他设备安全地在该主机上获取 token，然后粘贴到这里。",
      "Never share the token in chat, screenshots, repositories, or logs.": "绝不要在聊天、截图、代码仓库或日志中分享 token。",
    },
    ja: {
      "First time?": "初めてですか？",
      "The installer creates a private Web token on the computer running Pi Harbor.": "インストーラーは Pi Harbor を実行するコンピューターに非公開の Web トークンを作成します。",
      "On that computer, open a terminal and run the command for its operating system:": "そのコンピューターでターミナルを開き、OS に合わせたコマンドを実行します：",
      "Open Terminal from Applications → Utilities, then run:": "「アプリケーション → ユーティリティ」からターミナルを開き、次を実行します：",
      "Open your terminal emulator, then run:": "お使いのターミナルを開き、次を実行します：",
      "Open PowerShell from the Start menu, then run:": "スタートメニューから PowerShell を開き、次を実行します：",
      "In Command Prompt, run this instead:": "コマンドプロンプトの場合は、代わりに次を実行します：",
      "If a custom PI_HARBOR_TOKEN_FILE is configured, use that file instead of the default path.": "カスタムの PI_HARBOR_TOKEN_FILE を設定している場合は、既定のパスではなくそのファイルを使用してください。",
      "From another device, retrieve the token securely from that host and paste it here.": "別のデバイスから、そのホストでトークンを安全に取得してここに貼り付けます。",
      "Never share the token in chat, screenshots, repositories, or logs.": "トークンをチャット、スクリーンショット、リポジトリ、ログで共有しないでください。",
    },
    ko: {
      "First time?": "처음 사용하시나요?",
      "The installer creates a private Web token on the computer running Pi Harbor.": "설치 프로그램이 Pi Harbor를 실행하는 컴퓨터에 비공개 Web 토큰을 만듭니다.",
      "On that computer, open a terminal and run the command for its operating system:": "해당 컴퓨터에서 터미널을 열고 운영체제에 맞는 명령을 실행하세요:",
      "Open Terminal from Applications → Utilities, then run:": "'응용 프로그램 → 유틸리티'에서 터미널을 열고 다음을 실행하세요:",
      "Open your terminal emulator, then run:": "사용 중인 터미널을 열고 다음을 실행하세요:",
      "Open PowerShell from the Start menu, then run:": "시작 메뉴에서 PowerShell을 열고 다음을 실행하세요:",
      "In Command Prompt, run this instead:": "명령 프롬프트에서는 대신 다음을 실행하세요:",
      "If a custom PI_HARBOR_TOKEN_FILE is configured, use that file instead of the default path.": "사용자 지정 PI_HARBOR_TOKEN_FILE을 설정했다면 기본 경로 대신 해당 파일을 사용하세요.",
      "From another device, retrieve the token securely from that host and paste it here.": "다른 기기에서는 해당 호스트에서 토큰을 안전하게 가져와 여기에 붙여넣으세요.",
      "Never share the token in chat, screenshots, repositories, or logs.": "토큰을 채팅, 스크린샷, 저장소 또는 로그에 절대 공유하지 마세요.",
    },
    tr: {
      "First time?": "İlk kez mi kullanıyorsunuz?",
      "The installer creates a private Web token on the computer running Pi Harbor.": "Yükleyici, Pi Harbor'ı çalıştıran bilgisayarda özel bir Web token'ı oluşturur.",
      "On that computer, open a terminal and run the command for its operating system:": "Bu bilgisayarda bir terminal açın ve işletim sistemine uygun komutu çalıştırın:",
      "Open Terminal from Applications → Utilities, then run:": "Uygulamalar → İzlenceler içinden Terminal'i açın ve şunu çalıştırın:",
      "Open your terminal emulator, then run:": "Terminal uygulamanızı açın ve şunu çalıştırın:",
      "Open PowerShell from the Start menu, then run:": "Başlat menüsünden PowerShell'i açın ve şunu çalıştırın:",
      "In Command Prompt, run this instead:": "Komut İstemi'nde bunun yerine şunu çalıştırın:",
      "If a custom PI_HARBOR_TOKEN_FILE is configured, use that file instead of the default path.": "Özel bir PI_HARBOR_TOKEN_FILE yapılandırıldıysa varsayılan yol yerine bu dosyayı kullanın.",
      "From another device, retrieve the token securely from that host and paste it here.": "Başka bir cihazdan token'ı bu ana bilgisayardan güvenli şekilde alıp buraya yapıştırın.",
      "Never share the token in chat, screenshots, repositories, or logs.": "Token'ı sohbetlerde, ekran görüntülerinde, depolarda veya günlüklerde asla paylaşmayın.",
    },
    fr: {
      "First time?": "Première utilisation ?",
      "The installer creates a private Web token on the computer running Pi Harbor.": "L’installeur crée un jeton Web privé sur l’ordinateur qui exécute Pi Harbor.",
      "On that computer, open a terminal and run the command for its operating system:": "Sur cet ordinateur, ouvrez un terminal et exécutez la commande correspondant à son système :",
      "Open Terminal from Applications → Utilities, then run:": "Ouvrez le Terminal depuis Applications → Utilitaires, puis exécutez :",
      "Open your terminal emulator, then run:": "Ouvrez votre terminal, puis exécutez :",
      "Open PowerShell from the Start menu, then run:": "Ouvrez PowerShell depuis le menu Démarrer, puis exécutez :",
      "In Command Prompt, run this instead:": "Dans l’invite de commandes, exécutez plutôt :",
      "If a custom PI_HARBOR_TOKEN_FILE is configured, use that file instead of the default path.": "Si un PI_HARBOR_TOKEN_FILE personnalisé est configuré, utilisez ce fichier plutôt que le chemin par défaut.",
      "From another device, retrieve the token securely from that host and paste it here.": "Depuis un autre appareil, récupérez le jeton en toute sécurité sur cet hôte et collez-le ici.",
      "Never share the token in chat, screenshots, repositories, or logs.": "Ne partagez jamais le jeton dans un chat, une capture d’écran, un dépôt ou un journal.",
    },
    de: {
      "First time?": "Zum ersten Mal?",
      "The installer creates a private Web token on the computer running Pi Harbor.": "Das Installationsprogramm erstellt ein privates Web-Token auf dem Computer, auf dem Pi Harbor läuft.",
      "On that computer, open a terminal and run the command for its operating system:": "Öffnen Sie auf diesem Computer ein Terminal und führen Sie den Befehl für sein Betriebssystem aus:",
      "Open Terminal from Applications → Utilities, then run:": "Öffnen Sie das Terminal über Programme → Dienstprogramme und führen Sie aus:",
      "Open your terminal emulator, then run:": "Öffnen Sie Ihr Terminal und führen Sie aus:",
      "Open PowerShell from the Start menu, then run:": "Öffnen Sie PowerShell über das Startmenü und führen Sie aus:",
      "In Command Prompt, run this instead:": "In der Eingabeaufforderung führen Sie stattdessen aus:",
      "If a custom PI_HARBOR_TOKEN_FILE is configured, use that file instead of the default path.": "Wenn ein eigenes PI_HARBOR_TOKEN_FILE konfiguriert ist, verwenden Sie diese Datei statt des Standardpfads.",
      "From another device, retrieve the token securely from that host and paste it here.": "Rufen Sie das Token von einem anderen Gerät sicher auf diesem Host ab und fügen Sie es hier ein.",
      "Never share the token in chat, screenshots, repositories, or logs.": "Teilen Sie das Token niemals in Chats, Screenshots, Repositories oder Protokollen.",
    },
    es: {
      "First time?": "¿Es tu primera vez?",
      "The installer creates a private Web token on the computer running Pi Harbor.": "El instalador crea un token web privado en el ordenador que ejecuta Pi Harbor.",
      "On that computer, open a terminal and run the command for its operating system:": "En ese ordenador, abre un terminal y ejecuta el comando de su sistema operativo:",
      "Open Terminal from Applications → Utilities, then run:": "Abre Terminal desde Aplicaciones → Utilidades y ejecuta:",
      "Open your terminal emulator, then run:": "Abre tu terminal y ejecuta:",
      "Open PowerShell from the Start menu, then run:": "Abre PowerShell desde el menú Inicio y ejecuta:",
      "In Command Prompt, run this instead:": "En el Símbolo del sistema, ejecuta esto en su lugar:",
      "If a custom PI_HARBOR_TOKEN_FILE is configured, use that file instead of the default path.": "Si se ha configurado un PI_HARBOR_TOKEN_FILE personalizado, usa ese archivo en lugar de la ruta predeterminada.",
      "From another device, retrieve the token securely from that host and paste it here.": "Desde otro dispositivo, recupera el token de forma segura en ese equipo anfitrión y pégalo aquí.",
      "Never share the token in chat, screenshots, repositories, or logs.": "Nunca compartas el token en chats, capturas de pantalla, repositorios ni registros.",
    },
    "pt-BR": {
      "First time?": "É a primeira vez?",
      "The installer creates a private Web token on the computer running Pi Harbor.": "O instalador cria um token Web privado no computador que executa o Pi Harbor.",
      "On that computer, open a terminal and run the command for its operating system:": "Nesse computador, abra um terminal e execute o comando do sistema operacional dele:",
      "Open Terminal from Applications → Utilities, then run:": "Abra o Terminal em Aplicativos → Utilitários e execute:",
      "Open your terminal emulator, then run:": "Abra seu terminal e execute:",
      "Open PowerShell from the Start menu, then run:": "Abra o PowerShell pelo menu Iniciar e execute:",
      "In Command Prompt, run this instead:": "No Prompt de Comando, execute isto:",
      "If a custom PI_HARBOR_TOKEN_FILE is configured, use that file instead of the default path.": "Se um PI_HARBOR_TOKEN_FILE personalizado estiver configurado, use esse arquivo em vez do caminho padrão.",
      "From another device, retrieve the token securely from that host and paste it here.": "Em outro dispositivo, obtenha o token com segurança nesse host e cole-o aqui.",
      "Never share the token in chat, screenshots, repositories, or logs.": "Nunca compartilhe o token em chats, capturas de tela, repositórios ou logs.",
    },
    it: {
      "First time?": "È la prima volta?",
      "The installer creates a private Web token on the computer running Pi Harbor.": "Il programma di installazione crea un token Web privato sul computer che esegue Pi Harbor.",
      "On that computer, open a terminal and run the command for its operating system:": "Su quel computer, apri un terminale ed esegui il comando del suo sistema operativo:",
      "Open Terminal from Applications → Utilities, then run:": "Apri Terminale da Applicazioni → Utility ed esegui:",
      "Open your terminal emulator, then run:": "Apri il tuo terminale ed esegui:",
      "Open PowerShell from the Start menu, then run:": "Apri PowerShell dal menu Start ed esegui:",
      "In Command Prompt, run this instead:": "Nel Prompt dei comandi esegui invece:",
      "If a custom PI_HARBOR_TOKEN_FILE is configured, use that file instead of the default path.": "Se è configurato un PI_HARBOR_TOKEN_FILE personalizzato, usa quel file invece del percorso predefinito.",
      "From another device, retrieve the token securely from that host and paste it here.": "Da un altro dispositivo, recupera il token in modo sicuro da quell’host e incollalo qui.",
      "Never share the token in chat, screenshots, repositories, or logs.": "Non condividere mai il token in chat, schermate, repository o log.",
    },
  };
  for (const [id, table] of Object.entries(FIRST_LOGIN_TRANSLATIONS)) Object.assign(TRANSLATIONS[id], table);

  // First-run key onboarding (hardware-wallet style). The masked/revealed key
  // itself is marked data-i18n-ignore in index.html and is never translated.
  const ONBOARDING_KEY_TRANSLATIONS = {
    en: {
      "Save your access key": "Save your access key",
      "Pi Harbor created a private access key on this computer. Record it somewhere safe — like a hardware wallet, it is shown only once.": "Pi Harbor created a private access key on this computer. Record it somewhere safe — like a hardware wallet, it is shown only once.",
      "Show key": "Show key",
      "Hide key": "Hide key",
      "I saved the key in a safe place": "I saved the key in a safe place",
      "Anyone with this key can access this computer's Pi Harbor": "Anyone with this key can access this computer's Pi Harbor",
      "Continue to sign in": "Continue to sign in",
      "Skip for now": "Skip for now",
      "Paste the key you saved to sign in.": "Paste the key you saved to sign in.",
      "Could not save the confirmation; try again": "Could not save the confirmation; try again",
    },
    "zh-Hant": {
      "Save your access key": "保存你的存取密鑰",
      "Pi Harbor created a private access key on this computer. Record it somewhere safe — like a hardware wallet, it is shown only once.": "Pi Harbor 已在這台電腦上建立私密存取密鑰。請把它抄寫到安全的地方——就像冷錢包一樣，只會顯示這一次。",
      "Show key": "顯示密鑰",
      "Hide key": "隱藏密鑰",
      "I saved the key in a safe place": "我已把密鑰保存在安全的地方",
      "Anyone with this key can access this computer's Pi Harbor": "任何拿到這把密鑰的人都能存取這台電腦的 Pi Harbor",
      "Continue to sign in": "繼續登入",
      "Skip for now": "暫時略過",
      "Paste the key you saved to sign in.": "貼上你剛保存的密鑰以登入。",
      "Could not save the confirmation; try again": "無法保存確認狀態；請再試一次",
    },
    "zh-Hans": {
      "Save your access key": "保存你的访问密钥",
      "Pi Harbor created a private access key on this computer. Record it somewhere safe — like a hardware wallet, it is shown only once.": "Pi Harbor 已在这台电脑上创建私密访问密钥。请把它抄写到安全的地方——就像冷钱包一样，只会显示这一次。",
      "Show key": "显示密钥",
      "Hide key": "隐藏密钥",
      "I saved the key in a safe place": "我已把密钥保存在安全的地方",
      "Anyone with this key can access this computer's Pi Harbor": "任何拿到此密钥的人都能访问这台电脑的 Pi Harbor",
      "Continue to sign in": "继续登录",
      "Skip for now": "暂时跳过",
      "Paste the key you saved to sign in.": "粘贴你刚保存的密钥以登录。",
      "Could not save the confirmation; try again": "无法保存确认状态；请再试一次",
    },
    ja: {
      "Save your access key": "アクセスキーを保存してください",
      "Pi Harbor created a private access key on this computer. Record it somewhere safe — like a hardware wallet, it is shown only once.": "Pi Harbor はこのコンピューターに非公開のアクセスキーを作成しました。ハードウェアウォレットと同様に、一度しか表示されないので安全な場所に記録してください。",
      "Show key": "キーを表示",
      "Hide key": "キーを隠す",
      "I saved the key in a safe place": "キーを安全な場所に保存しました",
      "Anyone with this key can access this computer's Pi Harbor": "このキーを持つ人は誰でもこのコンピューターの Pi Harbor にアクセスできます",
      "Continue to sign in": "サインインへ進む",
      "Skip for now": "今はスキップ",
      "Paste the key you saved to sign in.": "保存したキーを貼り付けてサインインします。",
      "Could not save the confirmation; try again": "確認を保存できませんでした。もう一度お試しください",
    },
    ko: {
      "Save your access key": "액세스 키를 저장하세요",
      "Pi Harbor created a private access key on this computer. Record it somewhere safe — like a hardware wallet, it is shown only once.": "Pi Harbor가 이 컴퓨터에 비공개 액세스 키를 만들었습니다. 하드웨어 지갑처럼 한 번만 표시되니 안전한 곳에 기록해 두세요.",
      "Show key": "키 표시",
      "Hide key": "키 숨기기",
      "I saved the key in a safe place": "키를 안전한 곳에 저장했습니다",
      "Anyone with this key can access this computer's Pi Harbor": "이 키를 가진 사람은 누구나 이 컴퓨터의 Pi Harbor에 접근할 수 있습니다",
      "Continue to sign in": "로그인 계속",
      "Skip for now": "지금은 건너뛰기",
      "Paste the key you saved to sign in.": "저장한 키를 붙여넣어 로그인하세요.",
      "Could not save the confirmation; try again": "확인을 저장하지 못했습니다. 다시 시도하세요",
    },
    tr: {
      "Save your access key": "Erişim anahtarınızı kaydedin",
      "Pi Harbor created a private access key on this computer. Record it somewhere safe — like a hardware wallet, it is shown only once.": "Pi Harbor bu bilgisayarda özel bir erişim anahtarı oluşturdu. Donanım cüzdanı gibi yalnızca bir kez gösterilir; güvenli bir yere kaydedin.",
      "Show key": "Anahtarı göster",
      "Hide key": "Anahtarı gizle",
      "I saved the key in a safe place": "Anahtarı güvenli bir yere kaydettim",
      "Anyone with this key can access this computer's Pi Harbor": "Bu anahtara sahip olan herkes bu bilgisayarın Pi Harbor'ına erişebilir",
      "Continue to sign in": "Oturum açmaya devam et",
      "Skip for now": "Şimdilik atla",
      "Paste the key you saved to sign in.": "Oturum açmak için kaydettiğiniz anahtarı yapıştırın.",
      "Could not save the confirmation; try again": "Onay kaydedilemedi; yeniden deneyin",
    },
    fr: {
      "Save your access key": "Enregistrez votre clé d’accès",
      "Pi Harbor created a private access key on this computer. Record it somewhere safe — like a hardware wallet, it is shown only once.": "Pi Harbor a créé une clé d’accès privée sur cet ordinateur. Notez-la en lieu sûr — comme un portefeuille matériel, elle n’est affichée qu’une seule fois.",
      "Show key": "Afficher la clé",
      "Hide key": "Masquer la clé",
      "I saved the key in a safe place": "J’ai enregistré la clé en lieu sûr",
      "Anyone with this key can access this computer's Pi Harbor": "Toute personne disposant de cette clé peut accéder au Pi Harbor de cet ordinateur",
      "Continue to sign in": "Continuer vers la connexion",
      "Skip for now": "Ignorer pour l’instant",
      "Paste the key you saved to sign in.": "Collez la clé enregistrée pour vous connecter.",
      "Could not save the confirmation; try again": "Impossible d’enregistrer la confirmation ; réessayez",
    },
    de: {
      "Save your access key": "Sichern Sie Ihren Zugangsschlüssel",
      "Pi Harbor created a private access key on this computer. Record it somewhere safe — like a hardware wallet, it is shown only once.": "Pi Harbor hat einen privaten Zugangsschlüssel auf diesem Computer erstellt. Bewahren Sie ihn sicher auf — wie bei einer Hardware-Wallet wird er nur einmal angezeigt.",
      "Show key": "Schlüssel anzeigen",
      "Hide key": "Schlüssel verbergen",
      "I saved the key in a safe place": "Ich habe den Schlüssel an einem sicheren Ort verwahrt",
      "Anyone with this key can access this computer's Pi Harbor": "Jeder mit diesem Schlüssel kann auf den Pi Harbor dieses Computers zugreifen",
      "Continue to sign in": "Weiter zur Anmeldung",
      "Skip for now": "Vorerst überspringen",
      "Paste the key you saved to sign in.": "Fügen Sie den gesicherten Schlüssel ein, um sich anzumelden.",
      "Could not save the confirmation; try again": "Bestätigung konnte nicht gespeichert werden; bitte erneut versuchen",
    },
    es: {
      "Save your access key": "Guarda tu clave de acceso",
      "Pi Harbor created a private access key on this computer. Record it somewhere safe — like a hardware wallet, it is shown only once.": "Pi Harbor creó una clave de acceso privada en este ordenador. Anótala en un lugar seguro — como una cartera hardware, solo se muestra una vez.",
      "Show key": "Mostrar clave",
      "Hide key": "Ocultar clave",
      "I saved the key in a safe place": "He guardado la clave en un lugar seguro",
      "Anyone with this key can access this computer's Pi Harbor": "Cualquiera con esta clave puede acceder al Pi Harbor de este ordenador",
      "Continue to sign in": "Continuar al inicio de sesión",
      "Skip for now": "Omitir por ahora",
      "Paste the key you saved to sign in.": "Pega la clave que guardaste para iniciar sesión.",
      "Could not save the confirmation; try again": "No se pudo guardar la confirmación; inténtalo de nuevo",
    },
    "pt-BR": {
      "Save your access key": "Guarde sua chave de acesso",
      "Pi Harbor created a private access key on this computer. Record it somewhere safe — like a hardware wallet, it is shown only once.": "O Pi Harbor criou uma chave de acesso privada neste computador. Anote-a em um lugar seguro — como uma carteira de hardware, ela é exibida apenas uma vez.",
      "Show key": "Mostrar chave",
      "Hide key": "Ocultar chave",
      "I saved the key in a safe place": "Guardei a chave em um lugar seguro",
      "Anyone with this key can access this computer's Pi Harbor": "Qualquer pessoa com esta chave pode acessar o Pi Harbor deste computador",
      "Continue to sign in": "Continuar para o login",
      "Skip for now": "Pular por agora",
      "Paste the key you saved to sign in.": "Cole a chave que você guardou para entrar.",
      "Could not save the confirmation; try again": "Não foi possível salvar a confirmação; tente novamente",
    },
    it: {
      "Save your access key": "Salva la tua chiave di accesso",
      "Pi Harbor created a private access key on this computer. Record it somewhere safe — like a hardware wallet, it is shown only once.": "Pi Harbor ha creato una chiave di accesso privata su questo computer. Annotala in un luogo sicuro — come un portafoglio hardware, viene mostrata una sola volta.",
      "Show key": "Mostra chiave",
      "Hide key": "Nascondi chiave",
      "I saved the key in a safe place": "Ho salvato la chiave in un luogo sicuro",
      "Anyone with this key can access this computer's Pi Harbor": "Chiunque abbia questa chiave può accedere al Pi Harbor di questo computer",
      "Continue to sign in": "Continua con l’accesso",
      "Skip for now": "Salta per ora",
      "Paste the key you saved to sign in.": "Incolla la chiave salvata per accedere.",
      "Could not save the confirmation; try again": "Impossibile salvare la conferma; riprova",
    },
  };
  for (const [id, table] of Object.entries(ONBOARDING_KEY_TRANSLATIONS)) Object.assign(TRANSLATIONS[id], table);

  const PROJECT_BROWSE_TRANSLATIONS = {
    en: {
      "There are no subfolders to open": "There are no subfolders to open", "Loading folders…": "Loading folders…", "Load failed": "Load failed", "Could not read folder: ": "Could not read folder: ", "Choose a folder first": "Choose a folder first",
    },
    "zh-Hant": {
      "There are no subfolders to open": "這裡沒有可進入的子資料夾", "Loading folders…": "正在載入資料夾…", "Load failed": "讀取失敗", "Could not read folder: ": "無法讀取資料夾：", "Choose a folder first": "請先選擇一個資料夾",
    },
    "zh-Hans": {
      "There are no subfolders to open": "这里没有可进入的子文件夹", "Loading folders…": "正在加载文件夹…", "Load failed": "加载失败", "Could not read folder: ": "无法读取文件夹：", "Choose a folder first": "请先选择一个文件夹",
    },
    ja: {
      "There are no subfolders to open": "開けるサブフォルダーはありません", "Loading folders…": "フォルダーを読み込み中…", "Load failed": "読み込みに失敗しました", "Could not read folder: ": "フォルダーを読み込めません：", "Choose a folder first": "先にフォルダーを選択してください",
    },
    ko: {
      "There are no subfolders to open": "열 수 있는 하위 폴더가 없습니다", "Loading folders…": "폴더를 불러오는 중…", "Load failed": "로드 실패", "Could not read folder: ": "폴더를 읽을 수 없습니다: ", "Choose a folder first": "먼저 폴더를 선택하세요",
    },
    tr: {
      "There are no subfolders to open": "Açılacak alt klasör yok", "Loading folders…": "Klasörler yükleniyor…", "Load failed": "Yükleme başarısız", "Could not read folder: ": "Klasör okunamadı: ", "Choose a folder first": "Önce bir klasör seçin",
    },
    fr: {
      "There are no subfolders to open": "Aucun sous-dossier à ouvrir", "Loading folders…": "Chargement des dossiers…", "Load failed": "Échec du chargement", "Could not read folder: ": "Impossible de lire le dossier : ", "Choose a folder first": "Choisissez d’abord un dossier",
    },
    de: {
      "There are no subfolders to open": "Keine Unterordner zum Öffnen vorhanden", "Loading folders…": "Ordner werden geladen…", "Load failed": "Laden fehlgeschlagen", "Could not read folder: ": "Ordner konnte nicht gelesen werden: ", "Choose a folder first": "Wählen Sie zuerst einen Ordner aus",
    },
    es: {
      "There are no subfolders to open": "No hay subcarpetas que abrir", "Loading folders…": "Cargando carpetas…", "Load failed": "Error de carga", "Could not read folder: ": "No se ha podido leer la carpeta: ", "Choose a folder first": "Elige primero una carpeta",
    },
    "pt-BR": {
      "There are no subfolders to open": "Não há subpastas para abrir", "Loading folders…": "Carregando pastas…", "Load failed": "Falha ao carregar", "Could not read folder: ": "Não foi possível ler a pasta: ", "Choose a folder first": "Escolha uma pasta primeiro",
    },
    it: {
      "There are no subfolders to open": "Non ci sono sottocartelle da aprire", "Loading folders…": "Caricamento delle cartelle…", "Load failed": "Caricamento non riuscito", "Could not read folder: ": "Impossibile leggere la cartella: ", "Choose a folder first": "Scegli prima una cartella",
    },
  };
  for (const [id, table] of Object.entries(PROJECT_BROWSE_TRANSLATIONS)) Object.assign(TRANSLATIONS[id], table);

  // Activity receipts are rendered inside #messages, which is intentionally
  // excluded from the generic DOM translator so prompts and model output stay
  // untouched. Keep every receipt fragment explicit in every supported locale.
  const ACTIVITY_RECEIPT_TRANSLATIONS = {
    en: {
      "Completed": "Completed", "Failed": "Failed", "Interrupted": "Interrupted", "No final response": "No final response",
      "Edited {count} file": "Edited {count} file", "Edited {count} files": "Edited {count} files",
      "{count} tool": "{count} tool", "{count} tools": "{count} tools",
    },
    "zh-Hant": {
      "Completed": "已完成", "Failed": "失敗", "Interrupted": "已中斷", "No final response": "沒有最終回覆",
      "Edited {count} file": "修改 {count} 個檔案", "Edited {count} files": "修改 {count} 個檔案",
      "{count} tool": "{count} 個工具", "{count} tools": "{count} 個工具",
    },
    "zh-Hans": {
      "Completed": "已完成", "Failed": "失败", "Interrupted": "已中断", "No final response": "没有最终回复",
      "Edited {count} file": "修改 {count} 个文件", "Edited {count} files": "修改 {count} 个文件",
      "{count} tool": "{count} 个工具", "{count} tools": "{count} 个工具",
    },
    ja: {
      "Completed": "完了", "Failed": "失敗", "Interrupted": "中断", "No final response": "最終回答なし",
      "Edited {count} file": "{count} 件のファイルを編集", "Edited {count} files": "{count} 件のファイルを編集",
      "{count} tool": "{count} 個のツール", "{count} tools": "{count} 個のツール",
    },
    ko: {
      "Completed": "완료", "Failed": "실패", "Interrupted": "중단됨", "No final response": "최종 응답 없음",
      "Edited {count} file": "{count}개 파일 수정", "Edited {count} files": "{count}개 파일 수정",
      "{count} tool": "{count}개 도구", "{count} tools": "{count}개 도구",
    },
    tr: {
      "Completed": "Tamamlandı", "Failed": "Başarısız", "Interrupted": "Kesildi", "No final response": "Son yanıt yok",
      "Edited {count} file": "{count} dosya düzenlendi", "Edited {count} files": "{count} dosya düzenlendi",
      "{count} tool": "{count} araç", "{count} tools": "{count} araç",
    },
    fr: {
      "Completed": "Terminé", "Failed": "Échec", "Interrupted": "Interrompu", "No final response": "Aucune réponse finale",
      "Edited {count} file": "{count} fichier modifié", "Edited {count} files": "{count} fichiers modifiés",
      "{count} tool": "{count} outil", "{count} tools": "{count} outils",
    },
    de: {
      "Completed": "Abgeschlossen", "Failed": "Fehlgeschlagen", "Interrupted": "Unterbrochen", "No final response": "Keine abschließende Antwort",
      "Edited {count} file": "{count} Datei bearbeitet", "Edited {count} files": "{count} Dateien bearbeitet",
      "{count} tool": "{count} Tool", "{count} tools": "{count} Tools",
    },
    es: {
      "Completed": "Completado", "Failed": "Error", "Interrupted": "Interrumpido", "No final response": "Sin respuesta final",
      "Edited {count} file": "{count} archivo editado", "Edited {count} files": "{count} archivos editados",
      "{count} tool": "{count} herramienta", "{count} tools": "{count} herramientas",
    },
    "pt-BR": {
      "Completed": "Concluído", "Failed": "Falhou", "Interrupted": "Interrompido", "No final response": "Sem resposta final",
      "Edited {count} file": "{count} arquivo editado", "Edited {count} files": "{count} arquivos editados",
      "{count} tool": "{count} ferramenta", "{count} tools": "{count} ferramentas",
    },
    it: {
      "Completed": "Completato", "Failed": "Non riuscito", "Interrupted": "Interrotto", "No final response": "Nessuna risposta finale",
      "Edited {count} file": "{count} file modificato", "Edited {count} files": "{count} file modificati",
      "{count} tool": "{count} strumento", "{count} tools": "{count} strumenti",
    },
  };
  for (const [id, table] of Object.entries(ACTIVITY_RECEIPT_TRANSLATIONS)) Object.assign(TRANSLATIONS[id], table);

  // The explanatory copy below is part of the application chrome rather than
  // session content. Keep it in the same source-key registry as button labels
  // so the subtitles stay in sync when the user switches locales repeatedly.
  // These four locales receive complete, natural translations here; provider
  // and model names remain product names and are intentionally not translated.
  const EAST_ASIAN_SUBTITLE_TRANSLATIONS = {
    en: {
      "To add another Pi Agent computer, run Pi Harbor there and enter its Tailscale or HTTPS address. You can also use a one-time pairing code. Both devices must use the same Web token.": "To add another Pi Agent computer, run Pi Harbor there and enter its Tailscale or HTTPS address. You can also use a one-time pairing code. Both devices must use the same Web token.",
      "Pi coding agent installed on this device": "Pi coding agent installed on this device",
      "All sessions on this device": "All sessions on this device",
      "Clear this browser's sign-in state": "Clear this browser's sign-in state",
      "Check GitHub and update this device periodically": "Check GitHub and update this device periodically",
      "Checking updater status…": "Checking updater status…",
      "Choose the language used by Pi Harbor": "Choose the language used by Pi Harbor",
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
      "Each device must run Pi Harbor (default port 3140) with this Web token. Use a Tailscale Serve or HTTPS URL reachable from this device.": "Each device must run Pi Harbor (default port 3140) with this Web token. Use a Tailscale Serve or HTTPS URL reachable from this device.",
      "Generate a pairing code in the other Pi Harbor device settings and paste it here. Codes expire after 5 minutes and can only be used once.": "Generate a pairing code in the other Pi Harbor device settings and paste it here. Codes expire after 5 minutes and can only be used once.",
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
      "To add another Pi Agent computer, run Pi Harbor there and enter its Tailscale or HTTPS address. You can also use a one-time pairing code. Both devices must use the same Web token.": "若要新增其他 Pi Agent 電腦，請先在該電腦執行 Pi Harbor，然後輸入它的 Tailscale 或 HTTPS 位址。也可以使用一次性配對碼。兩台裝置必須使用相同的 Web token。",
      "Pi coding agent installed on this device": "這台裝置上的 Pi coding agent",
      "All sessions on this device": "這台裝置上的所有工作階段",
      "Clear this browser's sign-in state": "清除這個瀏覽器的登入狀態",
      "Check GitHub and update this device periodically": "定期檢查 GitHub 並更新這台裝置",
      "Checking updater status…": "正在檢查更新工具狀態…",
      "Choose the language used by Pi Harbor": "選擇 Pi Harbor 使用的語言",
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
      "Each device must run Pi Harbor (default port 3140) with this Web token. Use a Tailscale Serve or HTTPS URL reachable from this device.": "每台裝置都必須執行 Pi Harbor（預設 port 3140）並使用這個 Web token。請使用本裝置可連線的 Tailscale Serve 或 HTTPS 位址。",
      "Generate a pairing code in the other Pi Harbor device settings and paste it here. Codes expire after 5 minutes and can only be used once.": "請在另一台 Pi Harbor 的裝置設定中產生配對碼，貼到這裡。配對碼 5 分鐘後過期，且只能使用一次。",
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
      "To add another Pi Agent computer, run Pi Harbor there and enter its Tailscale or HTTPS address. You can also use a one-time pairing code. Both devices must use the same Web token.": "要添加其他 Pi Agent 电脑，请先在那台电脑运行 Pi Harbor，然后输入它的 Tailscale 或 HTTPS 地址。也可以使用一次性配对码。两台设备必须使用相同的 Web token。",
      "Pi coding agent installed on this device": "此设备上安装的 Pi coding agent",
      "All sessions on this device": "此设备上的所有会话",
      "Clear this browser's sign-in state": "清除此浏览器的登录状态",
      "Check GitHub and update this device periodically": "定期检查 GitHub 并更新此设备",
      "Checking updater status…": "正在检查更新工具状态…",
      "Choose the language used by Pi Harbor": "选择 Pi Harbor 使用的语言",
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
      "Each device must run Pi Harbor (default port 3140) with this Web token. Use a Tailscale Serve or HTTPS URL reachable from this device.": "每台设备都必须运行 Pi Harbor（默认端口 3140）并使用此 Web token。请使用此设备可以访问的 Tailscale Serve 或 HTTPS 地址。",
      "Generate a pairing code in the other Pi Harbor device settings and paste it here. Codes expire after 5 minutes and can only be used once.": "请在另一台 Pi Harbor 的设备设置中生成配对码并粘贴到这里。配对码 5 分钟后过期，且只能使用一次。",
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
      "To add another Pi Agent computer, run Pi Harbor there and enter its Tailscale or HTTPS address. You can also use a one-time pairing code. Both devices must use the same Web token.": "別の Pi Agent コンピューターを追加するには、そのコンピューターで Pi Harbor を起動し、Tailscale または HTTPS アドレスを入力してください。ワンタイムのペアリングコードも使用できます。両方のデバイスで同じ Web トークンを使う必要があります。",
      "Pi coding agent installed on this device": "このデバイスにインストールされている Pi coding agent",
      "All sessions on this device": "このデバイスのすべてのセッション",
      "Clear this browser's sign-in state": "このブラウザーのサインイン状態を消去",
      "Check GitHub and update this device periodically": "GitHub を定期的に確認してこのデバイスを更新",
      "Checking updater status…": "アップデーターの状態を確認中…",
      "Choose the language used by Pi Harbor": "Pi Harbor で使用する言語を選択",
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
      "Each device must run Pi Harbor (default port 3140) with this Web token. Use a Tailscale Serve or HTTPS URL reachable from this device.": "各デバイスで Pi Harbor（既定ポート 3140）をこの Web トークンで実行してください。このデバイスから到達できる Tailscale Serve または HTTPS URL を使用します。",
      "Generate a pairing code in the other Pi Harbor device settings and paste it here. Codes expire after 5 minutes and can only be used once.": "別の Pi Harbor デバイス設定でペアリングコードを生成し、ここに貼り付けてください。コードの有効期限は 5 分で、一度しか使えません。",
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
      "To add another Pi Agent computer, run Pi Harbor there and enter its Tailscale or HTTPS address. You can also use a one-time pairing code. Both devices must use the same Web token.": "다른 Pi Agent 컴퓨터를 추가하려면 해당 컴퓨터에서 Pi Harbor을 실행하고 Tailscale 또는 HTTPS 주소를 입력하세요. 일회용 페어링 코드도 사용할 수 있습니다. 두 기기 모두 같은 Web 토큰을 사용해야 합니다.",
      "Pi coding agent installed on this device": "이 기기에 설치된 Pi coding agent",
      "All sessions on this device": "이 기기의 모든 세션",
      "Clear this browser's sign-in state": "이 브라우저의 로그인 상태 지우기",
      "Check GitHub and update this device periodically": "GitHub를 주기적으로 확인하여 이 기기 업데이트",
      "Checking updater status…": "업데이트 도구 상태 확인 중…",
      "Choose the language used by Pi Harbor": "Pi Harbor에서 사용할 언어 선택",
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
      "Each device must run Pi Harbor (default port 3140) with this Web token. Use a Tailscale Serve or HTTPS URL reachable from this device.": "각 기기에서 이 Web 토큰으로 Pi Harbor(기본 포트 3140)을 실행해야 합니다. 이 기기에서 연결할 수 있는 Tailscale Serve 또는 HTTPS URL을 사용하세요.",
      "Generate a pairing code in the other Pi Harbor device settings and paste it here. Codes expire after 5 minutes and can only be used once.": "다른 Pi Harbor의 기기 설정에서 페어링 코드를 생성하여 여기에 붙여넣으세요. 코드는 5분 후 만료되며 한 번만 사용할 수 있습니다.",
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
      "Device name": "Device name", "Pi Harbor URL": "Pi Harbor URL", "Host name (optional)": "Host name (optional)", "Save device": "Save device", "Test connection": "Test connection", "Restart Pi Harbor": "Restart Pi Harbor", "Delete device": "Delete device", "One-time pairing code": "One-time pairing code", "Pairing code for another device": "Pairing code for another device", "Generate new pairing code": "Generate new pairing code", "Verify and add": "Verify and add", "API key": "API key", "Paste API key": "Paste API key", "Save and check": "Save and check", "Provider ID": "Provider ID", "API type": "API type", "Base URL": "Base URL", "API key (optional)": "API key (optional)", "Models (one per line; use ": "Models (one per line; use ", "Loading provider list…": "Loading provider list…", "PI AGENT DEVICE": "PI AGENT DEVICE", "MODEL PROVIDER": "MODEL PROVIDER",
    },
    "zh-Hant": {
      "Device name": "裝置名稱", "Pi Harbor URL": "Pi Harbor 網址", "Host name (optional)": "主機名稱（可選）", "Save device": "儲存裝置", "Test connection": "測試連線", "Restart Pi Harbor": "重新啟動 Pi Harbor", "Delete device": "刪除裝置", "One-time pairing code": "一次性配對碼", "Pairing code for another device": "提供給另一台裝置的配對碼", "Generate new pairing code": "產生新的配對碼", "Verify and add": "驗證並加入", "API key": "API key", "Paste API key": "貼上 API key", "Save and check": "儲存並檢查", "Provider ID": "Provider ID", "API type": "API 類型", "Base URL": "Base URL", "API key (optional)": "API key（可選）", "Models (one per line; use ": "模型（每行一個；格式：", "Loading provider list…": "正在載入 Provider 清單…", "PI AGENT DEVICE": "PI AGENT 裝置", "MODEL PROVIDER": "模型 Provider",
    },
    "zh-Hans": {
      "Device name": "设备名称", "Pi Harbor URL": "Pi Harbor 地址", "Host name (optional)": "主机名（可选）", "Save device": "保存设备", "Test connection": "测试连接", "Restart Pi Harbor": "重启 Pi Harbor", "Delete device": "删除设备", "One-time pairing code": "一次性配对码", "Pairing code for another device": "提供给另一台设备的配对码", "Generate new pairing code": "生成新的配对码", "Verify and add": "验证并添加", "API key": "API key", "Paste API key": "粘贴 API key", "Save and check": "保存并检查", "Provider ID": "Provider ID", "API type": "API 类型", "Base URL": "Base URL", "API key (optional)": "API key（可选）", "Models (one per line; use ": "模型（每行一个；格式：", "Loading provider list…": "正在加载 Provider 列表…", "PI AGENT DEVICE": "PI AGENT 设备", "MODEL PROVIDER": "模型 Provider",
    },
    ja: {
      "Device name": "デバイス名", "Pi Harbor URL": "Pi Harbor URL", "Host name (optional)": "ホスト名（任意）", "Save device": "デバイスを保存", "Test connection": "接続をテスト", "Restart Pi Harbor": "Pi Harbor を再起動", "Delete device": "デバイスを削除", "One-time pairing code": "ワンタイムペアリングコード", "Pairing code for another device": "別のデバイス用のペアリングコード", "Generate new pairing code": "新しいペアリングコードを生成", "Verify and add": "確認して追加", "API key": "API キー", "Paste API key": "API キーを貼り付け", "Save and check": "保存して確認", "Provider ID": "プロバイダー ID", "API type": "API タイプ", "Base URL": "ベース URL", "API key (optional)": "API キー（任意）", "Models (one per line; use ": "モデル（1 行に 1 つ。形式：", "Loading provider list…": "プロバイダー一覧を読み込み中…", "PI AGENT DEVICE": "PI AGENT デバイス", "MODEL PROVIDER": "モデルプロバイダー",
    },
    ko: {
      "Device name": "기기 이름", "Pi Harbor URL": "Pi Harbor URL", "Host name (optional)": "호스트 이름(선택 사항)", "Save device": "기기 저장", "Test connection": "연결 테스트", "Restart Pi Harbor": "Pi Harbor 다시 시작", "Delete device": "기기 삭제", "One-time pairing code": "일회용 페어링 코드", "Pairing code for another device": "다른 기기용 페어링 코드", "Generate new pairing code": "새 페어링 코드 생성", "Verify and add": "확인하고 추가", "API key": "API 키", "Paste API key": "API 키 붙여넣기", "Save and check": "저장하고 확인", "Provider ID": "Provider ID", "API type": "API 유형", "Base URL": "기본 URL", "API key (optional)": "API 키(선택 사항)", "Models (one per line; use ": "모델(한 줄에 하나, 형식: ", "Loading provider list…": "Provider 목록 불러오는 중…", "PI AGENT DEVICE": "PI AGENT 기기", "MODEL PROVIDER": "모델 Provider",
    },
  };
  for (const [id, table] of Object.entries(EAST_ASIAN_FORM_COPY)) Object.assign(TRANSLATIONS[id], table);

  // Device setup and OAuth actions are rendered after the initial HTML pass;
  // keep their helper copy in the same English-first registry so switching
  // locale also updates the explanatory text and sign-in action.
  const DEVICE_HELP_TRANSLATIONS = {
    en: {
      "How to add a device": "How to add a device",
      "Install and start Pi Harbor on the other computer. Keep it running and use the same Web token.": "Install and start Pi Harbor on the other computer. Keep it running and use the same Web token.",
      "On that computer, copy its Tailscale Serve or HTTPS Pi Harbor address, then paste it into ": "On that computer, copy its Tailscale Serve or HTTPS Pi Harbor address, then paste it into ",
      "Enter a friendly device name, choose ": "Enter a friendly device name, choose ",
      "If you cannot copy a URL, use the link button in Devices to create a one-time pairing code. Enter that code here instead; it expires after five minutes.": "If you cannot copy a URL, use the link button in Devices to create a one-time pairing code. Enter that code here instead; it expires after five minutes.",
      "Open official sign-in page": "Open official sign-in page",
    },
    "zh-Hant": {
      "How to add a device": "如何新增設備",
      "Install and start Pi Harbor on the other computer. Keep it running and use the same Web token.": "在另一台電腦安裝並啟動 Pi Harbor，保持程式運作，並使用相同的 Web token。",
      "On that computer, copy its Tailscale Serve or HTTPS Pi Harbor address, then paste it into ": "在那台電腦複製 Tailscale Serve 或 HTTPS 的 Pi Harbor 網址，貼到",
      "Enter a friendly device name, choose ": "輸入容易辨識的設備名稱，選擇",
      "If you cannot copy a URL, use the link button in Devices to create a one-time pairing code. Enter that code here instead; it expires after five minutes.": "如果無法複製網址，請在「設備」按連結按鈕建立一次性配對碼，再把配對碼填在這裡；配對碼五分鐘後失效。",
      "Open official sign-in page": "開啟官方登入頁面",
    },
    "zh-Hans": {
      "How to add a device": "如何添加设备",
      "Install and start Pi Harbor on the other computer. Keep it running and use the same Web token.": "在另一台电脑安装并启动 Pi Harbor，保持程序运行，并使用相同的 Web token。",
      "On that computer, copy its Tailscale Serve or HTTPS Pi Harbor address, then paste it into ": "在那台电脑复制 Tailscale Serve 或 HTTPS 的 Pi Harbor 地址，然后粘贴到",
      "Enter a friendly device name, choose ": "输入易于识别的设备名称，选择",
      "If you cannot copy a URL, use the link button in Devices to create a one-time pairing code. Enter that code here instead; it expires after five minutes.": "如果无法复制地址，请在“设备”中使用链接按钮创建一次性配对码，再将配对码填在这里；配对码五分钟后失效。",
      "Open official sign-in page": "打开官方登录页面",
    },
    ja: {
      "How to add a device": "デバイスの追加方法",
      "Install and start Pi Harbor on the other computer. Keep it running and use the same Web token.": "もう一台のコンピューターに Pi Harbor をインストールして起動し、同じ Web トークンで実行したままにします。",
      "On that computer, copy its Tailscale Serve or HTTPS Pi Harbor address, then paste it into ": "そのコンピューターの Tailscale Serve または HTTPS の Pi Harbor アドレスをコピーし、",
      "Enter a friendly device name, choose ": "わかりやすいデバイス名を入力し、",
      "If you cannot copy a URL, use the link button in Devices to create a one-time pairing code. Enter that code here instead; it expires after five minutes.": "URL をコピーできない場合は、「デバイス」のリンクボタンでワンタイムペアリングコードを作成し、ここに入力してください。コードは 5 分で期限切れになります。",
      "Open official sign-in page": "公式のサインインページを開く",
    },
    ko: {
      "How to add a device": "기기 추가 방법",
      "Install and start Pi Harbor on the other computer. Keep it running and use the same Web token.": "다른 컴퓨터에 Pi Harbor을 설치하고 실행한 뒤, 같은 Web 토큰으로 계속 실행해 두세요.",
      "On that computer, copy its Tailscale Serve or HTTPS Pi Harbor address, then paste it into ": "해당 컴퓨터의 Tailscale Serve 또는 HTTPS Pi Harbor 주소를 복사해",
      "Enter a friendly device name, choose ": "알아보기 쉬운 기기 이름을 입력하고",
      "If you cannot copy a URL, use the link button in Devices to create a one-time pairing code. Enter that code here instead; it expires after five minutes.": "URL을 복사할 수 없다면 ‘기기’의 링크 버튼으로 일회용 페어링 코드를 만든 다음 여기에 입력하세요. 코드는 5분 후 만료됩니다.",
      "Open official sign-in page": "공식 로그인 페이지 열기",
    },
    tr: {
      "How to add a device": "Cihaz ekleme",
      "Install and start Pi Harbor on the other computer. Keep it running and use the same Web token.": "Diğer bilgisayara Pi Harbor'i yükleyip başlatın. Açık tutun ve aynı Web jetonunu kullanın.",
      "On that computer, copy its Tailscale Serve or HTTPS Pi Harbor address, then paste it into ": "O bilgisayardaki Tailscale Serve veya HTTPS Pi Harbor adresini kopyalayıp",
      "Enter a friendly device name, choose ": "Anlaşılır bir cihaz adı girin, ardından",
      "If you cannot copy a URL, use the link button in Devices to create a one-time pairing code. Enter that code here instead; it expires after five minutes.": "URL'yi kopyalayamıyorsanız Cihazlar bölümündeki bağlantı düğmesiyle tek kullanımlık eşleştirme kodu oluşturun ve buraya girin. Kod beş dakika içinde geçersiz olur.",
      "Open official sign-in page": "Resmî giriş sayfasını aç",
    },
    fr: {
      "How to add a device": "Ajouter un appareil",
      "Install and start Pi Harbor on the other computer. Keep it running and use the same Web token.": "Installez et lancez Pi Harbor sur l’autre ordinateur. Laissez-le ouvert et utilisez le même jeton Web.",
      "On that computer, copy its Tailscale Serve or HTTPS Pi Harbor address, then paste it into ": "Sur cet ordinateur, copiez l’adresse Pi Harbor Tailscale Serve ou HTTPS, puis collez-la dans",
      "Enter a friendly device name, choose ": "Saisissez un nom facile à reconnaître, puis choisissez",
      "If you cannot copy a URL, use the link button in Devices to create a one-time pairing code. Enter that code here instead; it expires after five minutes.": "Si vous ne pouvez pas copier une URL, utilisez le bouton de lien dans Appareils pour créer un code d’association à usage unique. Saisissez-le ici ; il expire après cinq minutes.",
      "Open official sign-in page": "Ouvrir la page de connexion officielle",
    },
    de: {
      "How to add a device": "Gerät hinzufügen",
      "Install and start Pi Harbor on the other computer. Keep it running and use the same Web token.": "Installieren und starten Sie Pi Harbor auf dem anderen Computer. Lassen Sie es geöffnet und verwenden Sie dasselbe Web-Token.",
      "On that computer, copy its Tailscale Serve or HTTPS Pi Harbor address, then paste it into ": "Kopieren Sie auf diesem Computer die Tailscale-Serve- oder HTTPS-Adresse von Pi Harbor und fügen Sie sie in",
      "Enter a friendly device name, choose ": "Geben Sie einen gut erkennbaren Gerätenamen ein und wählen Sie",
      "If you cannot copy a URL, use the link button in Devices to create a one-time pairing code. Enter that code here instead; it expires after five minutes.": "Wenn Sie keine URL kopieren können, erstellen Sie über die Verknüpfungsschaltfläche unter Geräte einen einmaligen Kopplungscode. Geben Sie ihn hier ein; er läuft nach fünf Minuten ab.",
      "Open official sign-in page": "Offizielle Anmeldeseite öffnen",
    },
    es: {
      "How to add a device": "Cómo añadir un dispositivo",
      "Install and start Pi Harbor on the other computer. Keep it running and use the same Web token.": "Instala e inicia Pi Harbor en el otro ordenador. Déjalo en ejecución y usa el mismo token web.",
      "On that computer, copy its Tailscale Serve or HTTPS Pi Harbor address, then paste it into ": "En ese ordenador, copia la dirección Pi Harbor de Tailscale Serve o HTTPS y pégala en",
      "Enter a friendly device name, choose ": "Escribe un nombre fácil de reconocer y elige",
      "If you cannot copy a URL, use the link button in Devices to create a one-time pairing code. Enter that code here instead; it expires after five minutes.": "Si no puedes copiar una URL, usa el botón de enlace de Dispositivos para crear un código de emparejamiento de un solo uso. Introdúcelo aquí; caduca en cinco minutos.",
      "Open official sign-in page": "Abrir la página oficial de inicio de sesión",
    },
    "pt-BR": {
      "How to add a device": "Como adicionar um dispositivo",
      "Install and start Pi Harbor on the other computer. Keep it running and use the same Web token.": "Instale e abra o Pi Harbor no outro computador. Mantenha-o em execução e use o mesmo token Web.",
      "On that computer, copy its Tailscale Serve or HTTPS Pi Harbor address, then paste it into ": "Nesse computador, copie o endereço Pi Harbor do Tailscale Serve ou HTTPS e cole em",
      "Enter a friendly device name, choose ": "Digite um nome fácil de reconhecer e selecione",
      "If you cannot copy a URL, use the link button in Devices to create a one-time pairing code. Enter that code here instead; it expires after five minutes.": "Se não conseguir copiar uma URL, use o botão de link em Dispositivos para criar um código de pareamento de uso único. Digite-o aqui; ele expira em cinco minutos.",
      "Open official sign-in page": "Abrir a página oficial de login",
    },
    it: {
      "How to add a device": "Come aggiungere un dispositivo",
      "Install and start Pi Harbor on the other computer. Keep it running and use the same Web token.": "Installa e avvia Pi Harbor sull’altro computer. Lascialo in esecuzione e usa lo stesso token Web.",
      "On that computer, copy its Tailscale Serve or HTTPS Pi Harbor address, then paste it into ": "Su quel computer, copia l’indirizzo Pi Harbor Tailscale Serve o HTTPS e incollalo in",
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
    "To add another Pi Agent computer, run Pi Harbor there and enter its Tailscale or HTTPS address. You can also use a one-time pairing code. Both devices must use the same Web token.": {
      tr: "Başka bir Pi Agent bilgisayarı eklemek için orada Pi Harbor'i çalıştırın ve Tailscale veya HTTPS adresini girin. Tek kullanımlık eşleştirme kodunu da kullanabilirsiniz. Her iki cihaz da aynı Web token'ını kullanmalıdır.",
      fr: "Pour ajouter un autre ordinateur Pi Agent, lancez Pi Harbor dessus et saisissez son adresse Tailscale ou HTTPS. Vous pouvez aussi utiliser un code d’association à usage unique. Les deux appareils doivent utiliser le même jeton Web.",
      de: "Um einen weiteren Pi-Agent-Computer hinzuzufügen, starten Sie dort Pi Harbor und geben Sie seine Tailscale- oder HTTPS-Adresse ein. Sie können auch einen einmaligen Kopplungscode verwenden. Beide Geräte müssen dasselbe Web-Token nutzen.",
      es: "Para añadir otro ordenador con Pi Agent, ejecuta Pi Harbor allí e introduce su dirección de Tailscale o HTTPS. También puedes usar un código de emparejamiento de un solo uso. Ambos dispositivos deben usar el mismo token web.",
      "pt-BR": "Para adicionar outro computador com Pi Agent, execute o Pi Harbor nele e informe o endereço Tailscale ou HTTPS. Você também pode usar um código de pareamento de uso único. Os dois dispositivos devem usar o mesmo token da Web.",
      it: "Per aggiungere un altro computer Pi Agent, avvia Pi Harbor su quel computer e inserisci il relativo indirizzo Tailscale o HTTPS. Puoi anche usare un codice di abbinamento monouso. Entrambi i dispositivi devono usare lo stesso token Web.",
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
    "Choose the language used by Pi Harbor": {
      tr: "Pi Harbor'in kullandığı dili seçin", fr: "Choisissez la langue utilisée par Pi Harbor", de: "Wählen Sie die von Pi Harbor verwendete Sprache", es: "Elige el idioma que usa Pi Harbor", "pt-BR": "Escolha o idioma usado pelo Pi Harbor", it: "Scegli la lingua usata da Pi Harbor",
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
    "Each device must run Pi Harbor (default port 3140) with this Web token. Use a Tailscale Serve or HTTPS URL reachable from this device.": {
      tr: "Her cihaz bu Web token'ıyla Pi Harbor'i (varsayılan bağlantı noktası 3140) çalıştırmalıdır. Bu cihazdan erişilebilen bir Tailscale Serve veya HTTPS URL'si kullanın.", fr: "Chaque appareil doit exécuter Pi Harbor (port 3140 par défaut) avec ce jeton Web. Utilisez une URL Tailscale Serve ou HTTPS accessible depuis cet appareil.", de: "Auf jedem Gerät muss Pi Harbor (Standardport 3140) mit diesem Web-Token laufen. Verwenden Sie eine von diesem Gerät erreichbare Tailscale-Serve- oder HTTPS-URL.", es: "Cada dispositivo debe ejecutar Pi Harbor (puerto predeterminado 3140) con este token web. Usa una URL de Tailscale Serve o HTTPS accesible desde este dispositivo.", "pt-BR": "Cada dispositivo deve executar o Pi Harbor (porta padrão 3140) com este token da Web. Use uma URL do Tailscale Serve ou HTTPS acessível a partir deste dispositivo.", it: "Ogni dispositivo deve eseguire Pi Harbor (porta predefinita 3140) con questo token Web. Usa un URL Tailscale Serve o HTTPS raggiungibile da questo dispositivo.",
    },
    "Generate a pairing code in the other Pi Harbor device settings and paste it here. Codes expire after 5 minutes and can only be used once.": {
      tr: "Diğer Pi Harbor cihazının ayarlarında bir eşleştirme kodu oluşturup buraya yapıştırın. Kodların süresi 5 dakika sonra dolar ve yalnızca bir kez kullanılabilir.", fr: "Générez un code d’association dans les réglages de l’autre appareil Pi Harbor, puis collez-le ici. Les codes expirent après 5 minutes et ne peuvent être utilisés qu’une fois.", de: "Erzeugen Sie in den Einstellungen des anderen Pi Harbor-Geräts einen Kopplungscode und fügen Sie ihn hier ein. Codes laufen nach 5 Minuten ab und können nur einmal verwendet werden.", es: "Genera un código de emparejamiento en los ajustes del otro dispositivo Pi Harbor y pégalo aquí. Los códigos caducan después de 5 minutos y solo se pueden usar una vez.", "pt-BR": "Gere um código de pareamento nas configurações do outro dispositivo Pi Harbor e cole-o aqui. Os códigos expiram após 5 minutos e só podem ser usados uma vez.", it: "Genera un codice di abbinamento nelle impostazioni dell’altro dispositivo Pi Harbor e incollalo qui. I codici scadono dopo 5 minuti e possono essere usati una sola volta.",
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
    "Pi Harbor · self-hosted on your tailnet": {
      tr: "Pi Harbor · tailnet'inizde self-hosted", fr: "Pi Harbor · auto-hébergé sur votre tailnet", de: "Pi Harbor · selbst gehostet in Ihrem Tailnet", es: "Pi Harbor · autoalojado en tu tailnet", "pt-BR": "Pi Harbor · auto-hospedado no seu tailnet", it: "Pi Harbor · self-hosted sulla tua tailnet",
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
    "Install and start Pi Harbor on the other computer. Keep it running and use the same Web token.": {
      tr: "Diğer bilgisayara Pi Harbor'i kurup çalıştırın. Açık tutun ve aynı Web token'ını kullanın.", fr: "Installez et démarrez Pi Harbor sur l’autre ordinateur. Laissez-le fonctionner et utilisez le même jeton Web.", de: "Installieren und starten Sie Pi Harbor auf dem anderen Computer. Lassen Sie es laufen und verwenden Sie dasselbe Web-Token.", es: "Instala e inicia Pi Harbor en el otro ordenador. Déjalo en ejecución y usa el mismo token web.", "pt-BR": "Instale e inicie o Pi Harbor no outro computador. Mantenha-o em execução e use o mesmo token da Web.", it: "Installa e avvia Pi Harbor sull’altro computer. Lascialo in esecuzione e usa lo stesso token Web.",
    },
    "On that computer, copy its Tailscale Serve or HTTPS Pi Harbor address, then paste it into": {
      tr: "O bilgisayarda Tailscale Serve veya HTTPS Pi Harbor adresini kopyalayıp buraya yapıştırın:", fr: "Sur cet ordinateur, copiez l’adresse Pi Harbor Tailscale Serve ou HTTPS, puis collez-la dans", de: "Kopieren Sie auf diesem Computer die Tailscale-Serve- oder HTTPS-Adresse von Pi Harbor und fügen Sie sie ein in", es: "En ese ordenador, copia la dirección de Pi Harbor de Tailscale Serve o HTTPS y pégala en", "pt-BR": "Nesse computador, copie o endereço Tailscale Serve ou HTTPS do Pi Harbor e cole-o em", it: "Su quel computer, copia l’indirizzo Pi Harbor Tailscale Serve o HTTPS e incollalo in",
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
      "Device name": "Cihaz adı", "Pi Harbor URL": "Pi Harbor URL'si", "Host name (optional)": "Ana bilgisayar adı (isteğe bağlı)", "Save device": "Cihazı kaydet", "Test connection": "Bağlantıyı test et", "Restart Pi Harbor": "Pi Harbor'i yeniden başlat", "Delete device": "Cihazı sil", "One-time pairing code": "Tek kullanımlık eşleştirme kodu", "Pairing code for another device": "Başka bir cihaz için eşleştirme kodu", "Generate new pairing code": "Yeni eşleştirme kodu oluştur", "Verify and add": "Doğrula ve ekle", "API key": "API anahtarı", "Paste API key": "API anahtarını yapıştırın", "Save and check": "Kaydet ve kontrol et", "Provider ID": "Sağlayıcı kimliği", "API type": "API türü", "Base URL": "Temel URL", "API key (optional)": "API anahtarı (isteğe bağlı)", "Loading provider list…": "Sağlayıcı listesi yükleniyor…", "PI AGENT DEVICE": "PI AGENT CİHAZI", "MODEL PROVIDER": "MODEL SAĞLAYICISI",
      "Local Pi Harbor port": "Yerel Pi Harbor bağlantı noktası", "Remove sign-in": "Oturum açmayı kaldır", "Delete provider": "Sağlayıcıyı sil", "Join with pairing code": "Eşleştirme koduyla katıl", "Search providers": "Sağlayıcılarda ara", "Search providers or models": "Sağlayıcı veya model ara", "e.g. Work computer": "ör. İş bilgisayarı", "e.g. office-laptop": "ör. ofis-dizüstü", "e.g. ollama-local": "ör. ollama-local", "e.g. Project QA": "ör. Proje QA", "https://host.example or http://…:3140": "https://host.example veya http://…:3140", "You may use $ENV_VAR or !command": "$ENV_VAR veya !command kullanabilirsiniz", "NEW PROJECT": "YENİ PROJE", "Session": "Oturum", "PI REQUEST": "PI İSTEĞİ", "Token": "Token",
    },
    fr: {
      "Device name": "Nom de l’appareil", "Pi Harbor URL": "URL de Pi Harbor", "Host name (optional)": "Nom d’hôte (facultatif)", "Save device": "Enregistrer l’appareil", "Test connection": "Tester la connexion", "Restart Pi Harbor": "Redémarrer Pi Harbor", "Delete device": "Supprimer l’appareil", "One-time pairing code": "Code d’association à usage unique", "Pairing code for another device": "Code d’association pour un autre appareil", "Generate new pairing code": "Générer un nouveau code d’association", "Verify and add": "Vérifier et ajouter", "API key": "Clé API", "Paste API key": "Collez la clé API", "Save and check": "Enregistrer et vérifier", "Provider ID": "Identifiant du fournisseur", "API type": "Type d’API", "Base URL": "URL de base", "API key (optional)": "Clé API (facultatif)", "Loading provider list…": "Chargement de la liste des fournisseurs…", "PI AGENT DEVICE": "APPAREIL PI AGENT", "MODEL PROVIDER": "FOURNISSEUR DE MODÈLE",
      "Local Pi Harbor port": "Port Pi Harbor local", "Remove sign-in": "Supprimer la connexion", "Delete provider": "Supprimer le fournisseur", "Join with pairing code": "Rejoindre avec un code d’association", "Search providers": "Rechercher des fournisseurs", "Search providers or models": "Rechercher des fournisseurs ou des modèles", "e.g. Work computer": "ex. ordinateur professionnel", "e.g. office-laptop": "ex. portable-bureau", "e.g. ollama-local": "ex. ollama-local", "e.g. Project QA": "ex. projet QA", "https://host.example or http://…:3140": "https://host.example ou http://…:3140", "You may use $ENV_VAR or !command": "Vous pouvez utiliser $ENV_VAR ou !command", "NEW PROJECT": "NOUVEAU PROJET", "Session": "Session", "PI REQUEST": "DEMANDE PI", "Token": "Jeton",
    },
    de: {
      "Device name": "Gerätename", "Pi Harbor URL": "Pi Harbor-URL", "Host name (optional)": "Hostname (optional)", "Save device": "Gerät speichern", "Test connection": "Verbindung testen", "Restart Pi Harbor": "Pi Harbor neu starten", "Delete device": "Gerät löschen", "One-time pairing code": "Einmaliger Kopplungscode", "Pairing code for another device": "Kopplungscode für ein anderes Gerät", "Generate new pairing code": "Neuen Kopplungscode erzeugen", "Verify and add": "Prüfen und hinzufügen", "API key": "API-Schlüssel", "Paste API key": "API-Schlüssel einfügen", "Save and check": "Speichern und prüfen", "Provider ID": "Anbieter-ID", "API type": "API-Typ", "Base URL": "Basis-URL", "API key (optional)": "API-Schlüssel (optional)", "Loading provider list…": "Anbieterliste wird geladen…", "PI AGENT DEVICE": "PI-AGENT-GERÄT", "MODEL PROVIDER": "MODELLANBIETER",
      "Local Pi Harbor port": "Lokaler Pi Harbor-Port", "Remove sign-in": "Anmeldung entfernen", "Delete provider": "Anbieter löschen", "Join with pairing code": "Mit Kopplungscode beitreten", "Search providers": "Anbieter durchsuchen", "Search providers or models": "Anbieter oder Modelle durchsuchen", "e.g. Work computer": "z. B. Arbeitscomputer", "e.g. office-laptop": "z. B. Büro-Laptop", "e.g. ollama-local": "z. B. ollama-local", "e.g. Project QA": "z. B. Projekt-QA", "https://host.example or http://…:3140": "https://host.example oder http://…:3140", "You may use $ENV_VAR or !command": "$ENV_VAR oder !command kann verwendet werden", "NEW PROJECT": "NEUES PROJEKT", "Session": "Sitzung", "PI REQUEST": "PI-ANFRAGE", "Token": "Token",
    },
    es: {
      "Device name": "Nombre del dispositivo", "Pi Harbor URL": "URL de Pi Harbor", "Host name (optional)": "Nombre del host (opcional)", "Save device": "Guardar dispositivo", "Test connection": "Probar conexión", "Restart Pi Harbor": "Reiniciar Pi Harbor", "Delete device": "Eliminar dispositivo", "One-time pairing code": "Código de emparejamiento de un solo uso", "Pairing code for another device": "Código de emparejamiento para otro dispositivo", "Generate new pairing code": "Generar un nuevo código de emparejamiento", "Verify and add": "Verificar y añadir", "API key": "Clave API", "Paste API key": "Pega la clave API", "Save and check": "Guardar y comprobar", "Provider ID": "ID del proveedor", "API type": "Tipo de API", "Base URL": "URL base", "API key (optional)": "Clave API (opcional)", "Loading provider list…": "Cargando la lista de proveedores…", "PI AGENT DEVICE": "DISPOSITIVO PI AGENT", "MODEL PROVIDER": "PROVEEDOR DE MODELOS",
      "Local Pi Harbor port": "Puerto local de Pi Harbor", "Remove sign-in": "Eliminar inicio de sesión", "Delete provider": "Eliminar proveedor", "Join with pairing code": "Unirse con código de emparejamiento", "Search providers": "Buscar proveedores", "Search providers or models": "Buscar proveedores o modelos", "e.g. Work computer": "p. ej., ordenador de trabajo", "e.g. office-laptop": "p. ej., portátil-oficina", "e.g. ollama-local": "p. ej., ollama-local", "e.g. Project QA": "p. ej., proyecto QA", "https://host.example or http://…:3140": "https://host.example o http://…:3140", "You may use $ENV_VAR or !command": "Puedes usar $ENV_VAR o !command", "NEW PROJECT": "NUEVO PROYECTO", "Session": "Sesión", "PI REQUEST": "SOLICITUD DE PI", "Token": "Token",
    },
    "pt-BR": {
      "Device name": "Nome do dispositivo", "Pi Harbor URL": "URL do Pi Harbor", "Host name (optional)": "Nome do host (opcional)", "Save device": "Salvar dispositivo", "Test connection": "Testar conexão", "Restart Pi Harbor": "Reiniciar o Pi Harbor", "Delete device": "Excluir dispositivo", "One-time pairing code": "Código de pareamento de uso único", "Pairing code for another device": "Código de pareamento para outro dispositivo", "Generate new pairing code": "Gerar novo código de pareamento", "Verify and add": "Verificar e adicionar", "API key": "Chave de API", "Paste API key": "Cole a chave de API", "Save and check": "Salvar e verificar", "Provider ID": "ID do provedor", "API type": "Tipo de API", "Base URL": "URL base", "API key (optional)": "Chave de API (opcional)", "Loading provider list…": "Carregando a lista de provedores…", "PI AGENT DEVICE": "DISPOSITIVO PI AGENT", "MODEL PROVIDER": "PROVEDOR DE MODELO",
      "Local Pi Harbor port": "Porta local do Pi Harbor", "Remove sign-in": "Remover login", "Delete provider": "Excluir provedor", "Join with pairing code": "Entrar com código de pareamento", "Search providers": "Pesquisar provedores", "Search providers or models": "Pesquisar provedores ou modelos", "e.g. Work computer": "ex.: computador do trabalho", "e.g. office-laptop": "ex.: laptop-escritório", "e.g. ollama-local": "ex.: ollama-local", "e.g. Project QA": "ex.: projeto QA", "https://host.example or http://…:3140": "https://host.example ou http://…:3140", "You may use $ENV_VAR or !command": "Você pode usar $ENV_VAR ou !command", "NEW PROJECT": "NOVO PROJETO", "Session": "Sessão", "PI REQUEST": "SOLICITAÇÃO DO PI", "Token": "Token",
    },
    it: {
      "Device name": "Nome dispositivo", "Pi Harbor URL": "URL di Pi Harbor", "Host name (optional)": "Nome host (facoltativo)", "Save device": "Salva dispositivo", "Test connection": "Testa connessione", "Restart Pi Harbor": "Riavvia Pi Harbor", "Delete device": "Elimina dispositivo", "One-time pairing code": "Codice di abbinamento monouso", "Pairing code for another device": "Codice di abbinamento per un altro dispositivo", "Generate new pairing code": "Genera nuovo codice di abbinamento", "Verify and add": "Verifica e aggiungi", "API key": "Chiave API", "Paste API key": "Incolla la chiave API", "Save and check": "Salva e verifica", "Provider ID": "ID provider", "API type": "Tipo di API", "Base URL": "URL di base", "API key (optional)": "Chiave API (facoltativa)", "Loading provider list…": "Caricamento dell’elenco dei provider…", "PI AGENT DEVICE": "DISPOSITIVO PI AGENT", "MODEL PROVIDER": "PROVIDER DEL MODELLO",
      "Local Pi Harbor port": "Porta locale di Pi Harbor", "Remove sign-in": "Rimuovi accesso", "Delete provider": "Elimina provider", "Join with pairing code": "Partecipa con codice di abbinamento", "Search providers": "Cerca provider", "Search providers or models": "Cerca provider o modelli", "e.g. Work computer": "es. computer di lavoro", "e.g. office-laptop": "es. portatile-ufficio", "e.g. ollama-local": "es. ollama-local", "e.g. Project QA": "es. progetto QA", "https://host.example or http://…:3140": "https://host.example o http://…:3140", "You may use $ENV_VAR or !command": "Puoi usare $ENV_VAR o !command", "NEW PROJECT": "NUOVO PROGETTO", "Session": "Sessione", "PI REQUEST": "RICHIESTA PI", "Token": "Token",
    },
  };
  for (const [id, table] of Object.entries(EUROPEAN_FORM_COPY)) Object.assign(TRANSLATIONS[id], table);

  // Pi Harbor's simplified information architecture and single work-status
  // label use these English source keys in both static HTML and dynamic DOM.
  // Keep every locale explicit so a language switch never falls back to a
  // different language for the new settings groups or activity states.
  const SIMPLIFIED_UI_TRANSLATIONS = {
    en: {
      "Behavior": "Behavior", "Advanced": "Advanced", "Online": "Online", "Offline": "Offline", "Checking": "Checking", "Not checked": "Not checked",
      "Thinking…": "Thinking…", "Working…": "Working…", "Writing…": "Writing…", "Waiting for your response": "Waiting for your response", "Retrying…": "Retrying…", "Compacting…": "Compacting…",
    },
    "zh-Hant": {
      "Behavior": "行為", "Advanced": "進階", "Online": "在線", "Offline": "離線", "Checking": "檢查中", "Not checked": "尚未檢查",
      "Thinking…": "思考中…", "Working…": "工作中…", "Writing…": "撰寫中…", "Waiting for your response": "等待你的回覆", "Retrying…": "重試中…", "Compacting…": "整理對話中…",
    },
    "zh-Hans": {
      "Behavior": "行为", "Advanced": "高级", "Online": "在线", "Offline": "离线", "Checking": "检查中", "Not checked": "尚未检查",
      "Thinking…": "思考中…", "Working…": "工作中…", "Writing…": "输出中…", "Waiting for your response": "等待你的回复", "Retrying…": "正在重试…", "Compacting…": "正在整理对话…",
    },
    ja: {
      "Behavior": "動作", "Advanced": "詳細設定", "Online": "オンライン", "Offline": "オフライン", "Checking": "確認中", "Not checked": "未確認",
      "Thinking…": "思考中…", "Working…": "作業中…", "Writing…": "生成中…", "Waiting for your response": "回答を待っています", "Retrying…": "再試行中…", "Compacting…": "コンテキストを整理中…",
    },
    ko: {
      "Behavior": "동작", "Advanced": "고급", "Online": "온라인", "Offline": "오프라인", "Checking": "확인 중", "Not checked": "확인 안 됨",
      "Thinking…": "생각 중…", "Working…": "작업 중…", "Writing…": "작성 중…", "Waiting for your response": "응답 대기 중", "Retrying…": "재시도 중…", "Compacting…": "대화 정리 중…",
    },
    tr: {
      "Behavior": "Davranış", "Advanced": "Gelişmiş", "Online": "Çevrimiçi", "Offline": "Çevrimdışı", "Checking": "Denetleniyor", "Not checked": "Denetlenmedi",
      "Thinking…": "Düşünüyor…", "Working…": "Çalışıyor…", "Writing…": "Yazıyor…", "Waiting for your response": "Yanıtınız bekleniyor", "Retrying…": "Yeniden deneniyor…", "Compacting…": "Bağlam düzenleniyor…",
    },
    fr: {
      "Behavior": "Comportement", "Advanced": "Avancé", "Online": "En ligne", "Offline": "Hors ligne", "Checking": "Vérification…", "Not checked": "Non vérifié",
      "Thinking…": "Réflexion…", "Working…": "En cours…", "Writing…": "Rédaction…", "Waiting for your response": "En attente de votre réponse", "Retrying…": "Nouvelle tentative…", "Compacting…": "Compactage…",
    },
    de: {
      "Behavior": "Verhalten", "Advanced": "Erweitert", "Online": "Online", "Offline": "Offline", "Checking": "Wird geprüft", "Not checked": "Nicht geprüft",
      "Thinking…": "Denkt nach…", "Working…": "Wird ausgeführt…", "Writing…": "Schreibt…", "Waiting for your response": "Warte auf Ihre Antwort", "Retrying…": "Wird erneut versucht…", "Compacting…": "Kontext wird gekürzt…",
    },
    es: {
      "Behavior": "Comportamiento", "Advanced": "Avanzado", "Online": "En línea", "Offline": "Sin conexión", "Checking": "Comprobando", "Not checked": "Sin comprobar",
      "Thinking…": "Pensando…", "Working…": "Trabajando…", "Writing…": "Escribiendo…", "Waiting for your response": "Esperando tu respuesta", "Retrying…": "Reintentando…", "Compacting…": "Compactando…",
    },
    "pt-BR": {
      "Behavior": "Comportamento", "Advanced": "Avançado", "Online": "Online", "Offline": "Offline", "Checking": "Verificando", "Not checked": "Não verificado",
      "Thinking…": "Pensando…", "Working…": "Trabalhando…", "Writing…": "Escrevendo…", "Waiting for your response": "Aguardando sua resposta", "Retrying…": "Tentando novamente…", "Compacting…": "Compactando…",
    },
    it: {
      "Behavior": "Comportamento", "Advanced": "Avanzate", "Online": "Online", "Offline": "Offline", "Checking": "Verifica in corso", "Not checked": "Non verificato",
      "Thinking…": "Ragionamento…", "Working…": "Al lavoro…", "Writing…": "Scrittura…", "Waiting for your response": "In attesa della risposta", "Retrying…": "Nuovo tentativo…", "Compacting…": "Compattazione…",
    },
  };
  for (const [id, table] of Object.entries(SIMPLIFIED_UI_TRANSLATIONS)) Object.assign(TRANSLATIONS[id], table);

  // Update center copy is kept as a complete per-locale table because it is
  // rendered dynamically for every configured device. This prevents a status
  // row, timestamp label, or partial-success summary from falling back to
  // English when a remote device responds later.
  const UPDATE_CENTER_TRANSLATIONS = {
    en: {
      "Update all devices": "Update all devices", "Update settings are independent for each configured device.": "Update settings are independent for each configured device.",
      "Current version": "Current version", "Latest version": "Latest version", "Pi Harbor device": "Pi Harbor device", "Not checked": "Not checked", "Checking": "Checking", "Online": "Online", "Unavailable": "Unavailable",
      "Automatic updates for {device}": "Automatic updates for {device}", "Check {device} for updates": "Check {device} for updates", "Checking {device} for updates…": "Checking {device} for updates…",
      "Update pending on {device}; waiting for Agent work to finish": "Update pending on {device}; waiting for Agent work to finish", "Update available on {device}: Pi Harbor {version}": "Update available on {device}: Pi Harbor {version}", "Update available on {device}": "Update available on {device}",
      "Update check failed on {device}": "Update check failed on {device}", "Updater service is unavailable on {device}": "Updater service is unavailable on {device}", "Automatic updates are off on {device}": "Automatic updates are off on {device}",
      "Up to date on {device}; checked {time}": "Up to date on {device}; checked {time}", "Up to date on {device}": "Up to date on {device}", "Ready to check {device} for updates": "Ready to check {device} for updates",
      "Last check: {time}": "Last check: {time}", "No check yet": "No check yet", "Automatic checks are off": "Automatic checks are off", "Next automatic check: {time}": "Next automatic check: {time}", "Next automatic check will appear after the first check": "Next automatic check will appear after the first check",
      "Update status unavailable on {device}": "Update status unavailable on {device}", "Update controls require a newer Pi Harbor on {device}": "Update controls require a newer Pi Harbor on {device}", "Install the Pi Harbor updater on {device} to enable automatic updates": "Install the Pi Harbor updater on {device} to enable automatic updates", "Updater service is not installed on {device}": "Updater service is not installed on {device}",
      "Checks GitHub every {minutes} minutes on {device}": "Checks GitHub every {minutes} minutes on {device}", "Automatic updates enabled for {device}": "Automatic updates enabled for {device}", "Automatic updates disabled for {device}": "Automatic updates disabled for {device}", "Could not save update settings on {device}": "Could not save update settings on {device}", "Update check started on {device}": "Update check started on {device}", "Could not start an update check on {device}": "Could not start an update check on {device}",
      "Asking {count} devices to check for updates…": "Asking {count} devices to check for updates…", "Update all complete: {started} started, {skipped} skipped, {failed} failed.": "Update all complete: {started} started, {skipped} skipped, {failed} failed.",
    },
    "zh-Hant": {
      "Update all devices": "更新所有裝置", "Update settings are independent for each configured device.": "每台已設定裝置的更新設定彼此獨立。", "Current version": "目前版本", "Latest version": "最新版本", "Pi Harbor device": "Pi Harbor 裝置", "Not checked": "尚未檢查", "Checking": "檢查中", "Online": "在線", "Unavailable": "無法使用",
      "Automatic updates for {device}": "{device} 的自動更新", "Check {device} for updates": "檢查 {device} 的更新", "Checking {device} for updates…": "正在檢查 {device} 的更新…", "Update pending on {device}; waiting for Agent work to finish": "{device} 的更新待處理；等待 Pi 工作完成", "Update available on {device}: Pi Harbor {version}": "{device} 有可用更新：Pi Harbor {version}", "Update available on {device}": "{device} 有可用更新", "Update check failed on {device}": "{device} 的更新檢查失敗", "Updater service is unavailable on {device}": "{device} 的更新服務無法使用", "Automatic updates are off on {device}": "{device} 的自動更新已關閉",
      "Up to date on {device}; checked {time}": "{device} 已是最新；檢查時間：{time}", "Up to date on {device}": "{device} 已是最新", "Ready to check {device} for updates": "準備檢查 {device} 的更新", "Last check: {time}": "上次檢查：{time}", "No check yet": "尚未檢查", "Automatic checks are off": "自動檢查已關閉", "Next automatic check: {time}": "下次自動檢查：{time}", "Next automatic check will appear after the first check": "首次檢查後會顯示下次自動檢查時間",
      "Update status unavailable on {device}": "無法取得 {device} 的更新狀態", "Update controls require a newer Pi Harbor on {device}": "{device} 需要較新的 Pi Harbor 才能使用更新控制項", "Install the Pi Harbor updater on {device} to enable automatic updates": "請在 {device} 安裝 Pi Harbor 更新工具以啟用自動更新", "Updater service is not installed on {device}": "{device} 尚未安裝更新服務", "Checks GitHub every {minutes} minutes on {device}": "每 {minutes} 分鐘在 {device} 檢查 GitHub", "Automatic updates enabled for {device}": "已為 {device} 開啟自動更新", "Automatic updates disabled for {device}": "已關閉 {device} 的自動更新", "Could not save update settings on {device}": "無法儲存 {device} 的更新設定", "Update check started on {device}": "已開始檢查 {device} 的更新", "Could not start an update check on {device}": "無法開始檢查 {device} 的更新",
      "Asking {count} devices to check for updates…": "正在要求 {count} 台裝置檢查更新…", "Update all complete: {started} started, {skipped} skipped, {failed} failed.": "全部更新檢查完成：已開始 {started} 台、略過 {skipped} 台、失敗 {failed} 台。",
    },
    "zh-Hans": {
      "Update all devices": "更新所有设备", "Update settings are independent for each configured device.": "每台已配置设备的更新设置彼此独立。", "Current version": "当前版本", "Latest version": "最新版本", "Pi Harbor device": "Pi Harbor 设备", "Not checked": "尚未检查", "Checking": "检查中", "Online": "在线", "Unavailable": "无法使用",
      "Automatic updates for {device}": "{device} 的自动更新", "Check {device} for updates": "检查 {device} 的更新", "Checking {device} for updates…": "正在检查 {device} 的更新…", "Update pending on {device}; waiting for Agent work to finish": "{device} 的更新待处理；等待 Pi 工作完成", "Update available on {device}: Pi Harbor {version}": "{device} 有可用更新：Pi Harbor {version}", "Update available on {device}": "{device} 有可用更新", "Update check failed on {device}": "{device} 的更新检查失败", "Updater service is unavailable on {device}": "{device} 的更新服务不可用", "Automatic updates are off on {device}": "{device} 的自动更新已关闭",
      "Up to date on {device}; checked {time}": "{device} 已是最新；检查时间：{time}", "Up to date on {device}": "{device} 已是最新", "Ready to check {device} for updates": "准备检查 {device} 的更新", "Last check: {time}": "上次检查：{time}", "No check yet": "尚未检查", "Automatic checks are off": "自动检查已关闭", "Next automatic check: {time}": "下次自动检查：{time}", "Next automatic check will appear after the first check": "首次检查后会显示下次自动检查时间",
      "Update status unavailable on {device}": "无法获取 {device} 的更新状态", "Update controls require a newer Pi Harbor on {device}": "{device} 需要较新的 Pi Harbor 才能使用更新控制项", "Install the Pi Harbor updater on {device} to enable automatic updates": "请在 {device} 安装 Pi Harbor 更新工具以启用自动更新", "Updater service is not installed on {device}": "{device} 尚未安装更新服务", "Checks GitHub every {minutes} minutes on {device}": "每 {minutes} 分钟在 {device} 检查 GitHub", "Automatic updates enabled for {device}": "已为 {device} 启用自动更新", "Automatic updates disabled for {device}": "已关闭 {device} 的自动更新", "Could not save update settings on {device}": "无法保存 {device} 的更新设置", "Update check started on {device}": "已开始检查 {device} 的更新", "Could not start an update check on {device}": "无法开始检查 {device} 的更新",
      "Asking {count} devices to check for updates…": "正在要求 {count} 台设备检查更新…", "Update all complete: {started} started, {skipped} skipped, {failed} failed.": "全部更新检查完成：已开始 {started} 台、跳过 {skipped} 台、失败 {failed} 台。",
    },
    ja: {
      "Update all devices": "すべてのデバイスを更新", "Update settings are independent for each configured device.": "設定したデバイスごとに更新設定を個別に管理します。", "Current version": "現在のバージョン", "Latest version": "最新バージョン", "Pi Harbor device": "Pi Harbor デバイス", "Not checked": "未確認", "Checking": "確認中", "Online": "オンライン", "Unavailable": "利用不可",
      "Automatic updates for {device}": "{device} の自動更新", "Check {device} for updates": "{device} の更新を確認", "Checking {device} for updates…": "{device} の更新を確認中…", "Update pending on {device}; waiting for Agent work to finish": "{device} の更新は保留中です。Agent の作業完了を待っています", "Update available on {device}: Pi Harbor {version}": "{device} に更新があります：Pi Harbor {version}", "Update available on {device}": "{device} に更新があります", "Update check failed on {device}": "{device} の更新確認に失敗しました", "Updater service is unavailable on {device}": "{device} の更新サービスを利用できません", "Automatic updates are off on {device}": "{device} の自動更新はオフです",
      "Up to date on {device}; checked {time}": "{device} は最新です。確認日時：{time}", "Up to date on {device}": "{device} は最新です", "Ready to check {device} for updates": "{device} の更新を確認できます", "Last check: {time}": "前回の確認：{time}", "No check yet": "未確認", "Automatic checks are off": "自動確認はオフです", "Next automatic check: {time}": "次回の自動確認：{time}", "Next automatic check will appear after the first check": "初回確認後に次回の自動確認時刻が表示されます",
      "Update status unavailable on {device}": "{device} の更新状態を取得できません", "Update controls require a newer Pi Harbor on {device}": "{device} の更新機能には新しい Pi Harbor が必要です", "Install the Pi Harbor updater on {device} to enable automatic updates": "自動更新を有効にするには {device} に Pi Harbor アップデーターをインストールしてください", "Updater service is not installed on {device}": "{device} に更新サービスがインストールされていません", "Checks GitHub every {minutes} minutes on {device}": "{device} で {minutes} 分ごとに GitHub を確認", "Automatic updates enabled for {device}": "{device} の自動更新を有効にしました", "Automatic updates disabled for {device}": "{device} の自動更新を無効にしました", "Could not save update settings on {device}": "{device} の更新設定を保存できませんでした", "Update check started on {device}": "{device} の更新確認を開始しました", "Could not start an update check on {device}": "{device} の更新確認を開始できませんでした",
      "Asking {count} devices to check for updates…": "{count} 台のデバイスに更新確認を依頼中…", "Update all complete: {started} started, {skipped} skipped, {failed} failed.": "すべての更新確認が完了しました：開始 {started} 台、スキップ {skipped} 台、失敗 {failed} 台。",
    },
    ko: {
      "Update all devices": "모든 기기 업데이트", "Update settings are independent for each configured device.": "설정한 기기마다 업데이트 설정이 독립적으로 적용됩니다.", "Current version": "현재 버전", "Latest version": "최신 버전", "Pi Harbor device": "Pi Harbor 기기", "Not checked": "확인 안 됨", "Checking": "확인 중", "Online": "온라인", "Unavailable": "사용할 수 없음",
      "Automatic updates for {device}": "{device} 자동 업데이트", "Check {device} for updates": "{device} 업데이트 확인", "Checking {device} for updates…": "{device} 업데이트 확인 중…", "Update pending on {device}; waiting for Agent work to finish": "{device} 업데이트 대기 중; Agent 작업이 끝나기를 기다립니다", "Update available on {device}: Pi Harbor {version}": "{device}에 업데이트가 있습니다: Pi Harbor {version}", "Update available on {device}": "{device}에 업데이트가 있습니다", "Update check failed on {device}": "{device} 업데이트 확인 실패", "Updater service is unavailable on {device}": "{device}에서 업데이트 서비스를 사용할 수 없음", "Automatic updates are off on {device}": "{device}의 자동 업데이트가 꺼져 있음",
      "Up to date on {device}; checked {time}": "{device}는 최신 상태입니다; 확인: {time}", "Up to date on {device}": "{device}는 최신 상태입니다", "Ready to check {device} for updates": "{device} 업데이트를 확인할 준비가 됨", "Last check: {time}": "마지막 확인: {time}", "No check yet": "아직 확인하지 않음", "Automatic checks are off": "자동 확인이 꺼져 있음", "Next automatic check: {time}": "다음 자동 확인: {time}", "Next automatic check will appear after the first check": "첫 확인 후 다음 자동 확인 시간이 표시됩니다",
      "Update status unavailable on {device}": "{device}의 업데이트 상태를 사용할 수 없음", "Update controls require a newer Pi Harbor on {device}": "{device}의 업데이트 기능에는 최신 Pi Harbor가 필요합니다", "Install the Pi Harbor updater on {device} to enable automatic updates": "자동 업데이트를 사용하려면 {device}에 Pi Harbor 업데이트 도구를 설치하세요", "Updater service is not installed on {device}": "{device}에 업데이트 서비스가 설치되지 않음", "Checks GitHub every {minutes} minutes on {device}": "{device}에서 {minutes}분마다 GitHub 확인", "Automatic updates enabled for {device}": "{device} 자동 업데이트를 켰습니다", "Automatic updates disabled for {device}": "{device} 자동 업데이트를 껐습니다", "Could not save update settings on {device}": "{device} 업데이트 설정을 저장할 수 없음", "Update check started on {device}": "{device} 업데이트 확인을 시작했습니다", "Could not start an update check on {device}": "{device} 업데이트 확인을 시작할 수 없음",
      "Asking {count} devices to check for updates…": "{count}개 기기에 업데이트 확인 요청 중…", "Update all complete: {started} started, {skipped} skipped, {failed} failed.": "모든 업데이트 확인 완료: 시작 {started}개, 건너뜀 {skipped}개, 실패 {failed}개.",
    },
    tr: {
      "Update all devices": "Tüm cihazları güncelle", "Update settings are independent for each configured device.": "Güncelleme ayarları yapılandırılmış her cihaz için bağımsızdır.", "Current version": "Mevcut sürüm", "Latest version": "En son sürüm", "Pi Harbor device": "Pi Harbor cihazı", "Not checked": "Denetlenmedi", "Checking": "Denetleniyor", "Online": "Çevrimiçi", "Unavailable": "Kullanılamıyor",
      "Automatic updates for {device}": "{device} için otomatik güncellemeler", "Check {device} for updates": "{device} için güncellemeleri denetle", "Checking {device} for updates…": "{device} güncellemeleri denetleniyor…", "Update pending on {device}; waiting for Agent work to finish": "{device} güncellemesi beklemede; Agent çalışmasının bitmesi bekleniyor", "Update available on {device}: Pi Harbor {version}": "{device} için güncelleme var: Pi Harbor {version}", "Update available on {device}": "{device} için güncelleme var", "Update check failed on {device}": "{device} güncellemesi denetlenemedi", "Updater service is unavailable on {device}": "{device} üzerindeki güncelleme hizmeti kullanılamıyor", "Automatic updates are off on {device}": "{device} üzerinde otomatik güncellemeler kapalı",
      "Up to date on {device}; checked {time}": "{device} güncel; denetim: {time}", "Up to date on {device}": "{device} güncel", "Ready to check {device} for updates": "{device} güncellemelerini denetlemeye hazır", "Last check: {time}": "Son denetim: {time}", "No check yet": "Henüz denetlenmedi", "Automatic checks are off": "Otomatik denetimler kapalı", "Next automatic check: {time}": "Sonraki otomatik denetim: {time}", "Next automatic check will appear after the first check": "İlk denetimden sonra sonraki otomatik denetim zamanı görünür",
      "Update status unavailable on {device}": "{device} güncelleme durumu kullanılamıyor", "Update controls require a newer Pi Harbor on {device}": "{device} güncelleme denetimleri için daha yeni bir Pi Harbor gerekiyor", "Install the Pi Harbor updater on {device} to enable automatic updates": "Otomatik güncellemeleri etkinleştirmek için {device} üzerine Pi Harbor güncelleyicisini kurun", "Updater service is not installed on {device}": "{device} üzerinde güncelleme hizmeti kurulu değil", "Checks GitHub every {minutes} minutes on {device}": "{device} üzerinde GitHub {minutes} dakikada bir denetlenir", "Automatic updates enabled for {device}": "{device} için otomatik güncellemeler açıldı", "Automatic updates disabled for {device}": "{device} için otomatik güncellemeler kapatıldı", "Could not save update settings on {device}": "{device} güncelleme ayarları kaydedilemedi", "Update check started on {device}": "{device} güncelleme denetimi başlatıldı", "Could not start an update check on {device}": "{device} güncelleme denetimi başlatılamadı",
      "Asking {count} devices to check for updates…": "{count} cihazdan güncellemeleri denetlemesi isteniyor…", "Update all complete: {started} started, {skipped} skipped, {failed} failed.": "Tüm güncelleme denetimleri tamamlandı: {started} başlatıldı, {skipped} atlandı, {failed} başarısız.",
    },
    fr: {
      "Update all devices": "Mettre à jour tous les appareils", "Update settings are independent for each configured device.": "Les réglages de mise à jour sont indépendants pour chaque appareil configuré.", "Current version": "Version actuelle", "Latest version": "Dernière version", "Pi Harbor device": "Appareil Pi Harbor", "Not checked": "Non vérifié", "Checking": "Vérification…", "Online": "En ligne", "Unavailable": "Indisponible",
      "Automatic updates for {device}": "Mises à jour automatiques de {device}", "Check {device} for updates": "Rechercher des mises à jour sur {device}", "Checking {device} for updates…": "Recherche de mises à jour sur {device}…", "Update pending on {device}; waiting for Agent work to finish": "Mise à jour en attente sur {device} ; en attente de la fin du travail de l’agent", "Update available on {device}: Pi Harbor {version}": "Mise à jour disponible sur {device} : Pi Harbor {version}", "Update available on {device}": "Mise à jour disponible sur {device}", "Update check failed on {device}": "Échec de la recherche de mises à jour sur {device}", "Updater service is unavailable on {device}": "Le service de mise à jour est indisponible sur {device}", "Automatic updates are off on {device}": "Les mises à jour automatiques sont désactivées sur {device}",
      "Up to date on {device}; checked {time}": "{device} est à jour ; vérifié le {time}", "Up to date on {device}": "{device} est à jour", "Ready to check {device} for updates": "Prêt à rechercher des mises à jour sur {device}", "Last check: {time}": "Dernière vérification : {time}", "No check yet": "Pas encore vérifié", "Automatic checks are off": "Les vérifications automatiques sont désactivées", "Next automatic check: {time}": "Prochaine vérification automatique : {time}", "Next automatic check will appear after the first check": "La prochaine vérification automatique apparaîtra après la première",
      "Update status unavailable on {device}": "État des mises à jour indisponible sur {device}", "Update controls require a newer Pi Harbor on {device}": "Une version plus récente de Pi Harbor est requise sur {device} pour gérer les mises à jour", "Install the Pi Harbor updater on {device} to enable automatic updates": "Installez le programme de mise à jour Pi Harbor sur {device} pour activer les mises à jour automatiques", "Updater service is not installed on {device}": "Le service de mise à jour n’est pas installé sur {device}", "Checks GitHub every {minutes} minutes on {device}": "GitHub est vérifié toutes les {minutes} minutes sur {device}", "Automatic updates enabled for {device}": "Mises à jour automatiques activées sur {device}", "Automatic updates disabled for {device}": "Mises à jour automatiques désactivées sur {device}", "Could not save update settings on {device}": "Impossible d’enregistrer les réglages de mise à jour sur {device}", "Update check started on {device}": "Recherche de mises à jour démarrée sur {device}", "Could not start an update check on {device}": "Impossible de démarrer la recherche de mises à jour sur {device}",
      "Asking {count} devices to check for updates…": "Demande de recherche de mises à jour sur {count} appareils…", "Update all complete: {started} started, {skipped} skipped, {failed} failed.": "Toutes les recherches sont terminées : {started} lancée(s), {skipped} ignorée(s), {failed} en échec.",
    },
    de: {
      "Update all devices": "Alle Geräte aktualisieren", "Update settings are independent for each configured device.": "Die Update-Einstellungen gelten unabhängig für jedes eingerichtete Gerät.", "Current version": "Aktuelle Version", "Latest version": "Neueste Version", "Pi Harbor device": "Pi-Harbor-Gerät", "Not checked": "Nicht geprüft", "Checking": "Wird geprüft", "Online": "Online", "Unavailable": "Nicht verfügbar",
      "Automatic updates for {device}": "Automatische Updates für {device}", "Check {device} for updates": "{device} auf Updates prüfen", "Checking {device} for updates…": "{device} wird auf Updates geprüft…", "Update pending on {device}; waiting for Agent work to finish": "Update auf {device} ausstehend; warten, bis die Agent-Arbeit beendet ist", "Update available on {device}: Pi Harbor {version}": "Update auf {device} verfügbar: Pi Harbor {version}", "Update available on {device}": "Update auf {device} verfügbar", "Update check failed on {device}": "Update-Prüfung auf {device} fehlgeschlagen", "Updater service is unavailable on {device}": "Update-Dienst auf {device} ist nicht verfügbar", "Automatic updates are off on {device}": "Automatische Updates sind auf {device} ausgeschaltet",
      "Up to date on {device}; checked {time}": "{device} ist aktuell; geprüft: {time}", "Up to date on {device}": "{device} ist aktuell", "Ready to check {device} for updates": "Bereit, {device} auf Updates zu prüfen", "Last check: {time}": "Letzte Prüfung: {time}", "No check yet": "Noch nicht geprüft", "Automatic checks are off": "Automatische Prüfungen sind ausgeschaltet", "Next automatic check: {time}": "Nächste automatische Prüfung: {time}", "Next automatic check will appear after the first check": "Die nächste automatische Prüfung wird nach der ersten Prüfung angezeigt",
      "Update status unavailable on {device}": "Update-Status auf {device} nicht verfügbar", "Update controls require a newer Pi Harbor on {device}": "Für die Update-Steuerung auf {device} ist ein neueres Pi Harbor erforderlich", "Install the Pi Harbor updater on {device} to enable automatic updates": "Installieren Sie den Pi-Harbor-Updater auf {device}, um automatische Updates zu aktivieren", "Updater service is not installed on {device}": "Der Update-Dienst ist auf {device} nicht installiert", "Checks GitHub every {minutes} minutes on {device}": "GitHub wird auf {device} alle {minutes} Minuten geprüft", "Automatic updates enabled for {device}": "Automatische Updates für {device} aktiviert", "Automatic updates disabled for {device}": "Automatische Updates für {device} deaktiviert", "Could not save update settings on {device}": "Update-Einstellungen auf {device} konnten nicht gespeichert werden", "Update check started on {device}": "Update-Prüfung auf {device} gestartet", "Could not start an update check on {device}": "Update-Prüfung auf {device} konnte nicht gestartet werden",
      "Asking {count} devices to check for updates…": "{count} Geräte werden zur Update-Prüfung aufgefordert…", "Update all complete: {started} started, {skipped} skipped, {failed} failed.": "Alle Update-Prüfungen abgeschlossen: {started} gestartet, {skipped} übersprungen, {failed} fehlgeschlagen.",
    },
    es: {
      "Update all devices": "Actualizar todos los dispositivos", "Update settings are independent for each configured device.": "Los ajustes de actualización son independientes para cada dispositivo configurado.", "Current version": "Versión actual", "Latest version": "Última versión", "Pi Harbor device": "Dispositivo Pi Harbor", "Not checked": "Sin comprobar", "Checking": "Comprobando", "Online": "En línea", "Unavailable": "No disponible",
      "Automatic updates for {device}": "Actualizaciones automáticas de {device}", "Check {device} for updates": "Buscar actualizaciones en {device}", "Checking {device} for updates…": "Comprobando actualizaciones en {device}…", "Update pending on {device}; waiting for Agent work to finish": "Actualización pendiente en {device}; esperando a que termine el trabajo del agente", "Update available on {device}: Pi Harbor {version}": "Hay una actualización para {device}: Pi Harbor {version}", "Update available on {device}": "Hay una actualización para {device}", "Update check failed on {device}": "No se pudieron comprobar las actualizaciones de {device}", "Updater service is unavailable on {device}": "El servicio de actualización no está disponible en {device}", "Automatic updates are off on {device}": "Las actualizaciones automáticas están desactivadas en {device}",
      "Up to date on {device}; checked {time}": "{device} está actualizado; comprobado: {time}", "Up to date on {device}": "{device} está actualizado", "Ready to check {device} for updates": "Listo para buscar actualizaciones en {device}", "Last check: {time}": "Última comprobación: {time}", "No check yet": "Aún no se ha comprobado", "Automatic checks are off": "Las comprobaciones automáticas están desactivadas", "Next automatic check: {time}": "Siguiente comprobación automática: {time}", "Next automatic check will appear after the first check": "La siguiente comprobación automática aparecerá después de la primera",
      "Update status unavailable on {device}": "El estado de actualización no está disponible en {device}", "Update controls require a newer Pi Harbor on {device}": "Se necesita un Pi Harbor más reciente en {device} para controlar las actualizaciones", "Install the Pi Harbor updater on {device} to enable automatic updates": "Instala el actualizador de Pi Harbor en {device} para activar las actualizaciones automáticas", "Updater service is not installed on {device}": "El servicio de actualización no está instalado en {device}", "Checks GitHub every {minutes} minutes on {device}": "Comprueba GitHub cada {minutes} minutos en {device}", "Automatic updates enabled for {device}": "Actualizaciones automáticas activadas para {device}", "Automatic updates disabled for {device}": "Actualizaciones automáticas desactivadas para {device}", "Could not save update settings on {device}": "No se pudieron guardar los ajustes de actualización de {device}", "Update check started on {device}": "Se inició la búsqueda de actualizaciones en {device}", "Could not start an update check on {device}": "No se pudo iniciar la búsqueda de actualizaciones en {device}",
      "Asking {count} devices to check for updates…": "Solicitando a {count} dispositivos que busquen actualizaciones…", "Update all complete: {started} started, {skipped} skipped, {failed} failed.": "Búsqueda completa: {started} iniciadas, {skipped} omitidas, {failed} fallidas.",
    },
    "pt-BR": {
      "Update all devices": "Atualizar todos os dispositivos", "Update settings are independent for each configured device.": "As configurações de atualização são independentes para cada dispositivo configurado.", "Current version": "Versão atual", "Latest version": "Versão mais recente", "Pi Harbor device": "Dispositivo Pi Harbor", "Not checked": "Não verificado", "Checking": "Verificando", "Online": "Online", "Unavailable": "Indisponível",
      "Automatic updates for {device}": "Atualizações automáticas de {device}", "Check {device} for updates": "Verificar atualizações em {device}", "Checking {device} for updates…": "Verificando atualizações em {device}…", "Update pending on {device}; waiting for Agent work to finish": "Atualização pendente em {device}; aguardando o trabalho do agente terminar", "Update available on {device}: Pi Harbor {version}": "Atualização disponível em {device}: Pi Harbor {version}", "Update available on {device}": "Atualização disponível em {device}", "Update check failed on {device}": "Falha ao verificar atualizações em {device}", "Updater service is unavailable on {device}": "O serviço de atualização está indisponível em {device}", "Automatic updates are off on {device}": "As atualizações automáticas estão desativadas em {device}",
      "Up to date on {device}; checked {time}": "{device} está atualizado; verificado em {time}", "Up to date on {device}": "{device} está atualizado", "Ready to check {device} for updates": "Pronto para verificar atualizações em {device}", "Last check: {time}": "Última verificação: {time}", "No check yet": "Ainda não verificado", "Automatic checks are off": "As verificações automáticas estão desativadas", "Next automatic check: {time}": "Próxima verificação automática: {time}", "Next automatic check will appear after the first check": "A próxima verificação automática aparecerá após a primeira",
      "Update status unavailable on {device}": "O status de atualização não está disponível em {device}", "Update controls require a newer Pi Harbor on {device}": "É necessário um Pi Harbor mais recente em {device} para controlar atualizações", "Install the Pi Harbor updater on {device} to enable automatic updates": "Instale o atualizador do Pi Harbor em {device} para ativar atualizações automáticas", "Updater service is not installed on {device}": "O serviço de atualização não está instalado em {device}", "Checks GitHub every {minutes} minutes on {device}": "Verifica o GitHub a cada {minutes} minutos em {device}", "Automatic updates enabled for {device}": "Atualizações automáticas ativadas para {device}", "Automatic updates disabled for {device}": "Atualizações automáticas desativadas para {device}", "Could not save update settings on {device}": "Não foi possível salvar as configurações de atualização de {device}", "Update check started on {device}": "Verificação de atualização iniciada em {device}", "Could not start an update check on {device}": "Não foi possível iniciar a verificação de atualização em {device}",
      "Asking {count} devices to check for updates…": "Solicitando que {count} dispositivos verifiquem atualizações…", "Update all complete: {started} started, {skipped} skipped, {failed} failed.": "Todas as verificações concluídas: {started} iniciadas, {skipped} ignoradas, {failed} falhas.",
    },
    it: {
      "Update all devices": "Aggiorna tutti i dispositivi", "Update settings are independent for each configured device.": "Le impostazioni degli aggiornamenti sono indipendenti per ogni dispositivo configurato.", "Current version": "Versione corrente", "Latest version": "Versione più recente", "Pi Harbor device": "Dispositivo Pi Harbor", "Not checked": "Non verificato", "Checking": "Verifica in corso", "Online": "Online", "Unavailable": "Non disponibile",
      "Automatic updates for {device}": "Aggiornamenti automatici per {device}", "Check {device} for updates": "Controlla gli aggiornamenti di {device}", "Checking {device} for updates…": "Controllo degli aggiornamenti di {device}…", "Update pending on {device}; waiting for Agent work to finish": "Aggiornamento in attesa su {device}; in attesa del termine del lavoro dell’agente", "Update available on {device}: Pi Harbor {version}": "Aggiornamento disponibile su {device}: Pi Harbor {version}", "Update available on {device}": "Aggiornamento disponibile su {device}", "Update check failed on {device}": "Controllo degli aggiornamenti di {device} non riuscito", "Updater service is unavailable on {device}": "Il servizio di aggiornamento non è disponibile su {device}", "Automatic updates are off on {device}": "Gli aggiornamenti automatici sono disattivati su {device}",
      "Up to date on {device}; checked {time}": "{device} è aggiornato; verificato: {time}", "Up to date on {device}": "{device} è aggiornato", "Ready to check {device} for updates": "Pronto a controllare gli aggiornamenti di {device}", "Last check: {time}": "Ultimo controllo: {time}", "No check yet": "Non ancora verificato", "Automatic checks are off": "I controlli automatici sono disattivati", "Next automatic check: {time}": "Prossimo controllo automatico: {time}", "Next automatic check will appear after the first check": "Il prossimo controllo automatico apparirà dopo il primo",
      "Update status unavailable on {device}": "Stato degli aggiornamenti non disponibile su {device}", "Update controls require a newer Pi Harbor on {device}": "Per gestire gli aggiornamenti su {device} serve una versione più recente di Pi Harbor", "Install the Pi Harbor updater on {device} to enable automatic updates": "Installa l’aggiornamento di Pi Harbor su {device} per abilitare gli aggiornamenti automatici", "Updater service is not installed on {device}": "Il servizio di aggiornamento non è installato su {device}", "Checks GitHub every {minutes} minutes on {device}": "Controlla GitHub ogni {minutes} minuti su {device}", "Automatic updates enabled for {device}": "Aggiornamenti automatici attivati per {device}", "Automatic updates disabled for {device}": "Aggiornamenti automatici disattivati per {device}", "Could not save update settings on {device}": "Impossibile salvare le impostazioni di aggiornamento di {device}", "Update check started on {device}": "Controllo degli aggiornamenti avviato su {device}", "Could not start an update check on {device}": "Impossibile avviare il controllo degli aggiornamenti su {device}",
      "Asking {count} devices to check for updates…": "Richiesta di controllo degli aggiornamenti su {count} dispositivi…", "Update all complete: {started} started, {skipped} skipped, {failed} failed.": "Tutti i controlli completati: {started} avviati, {skipped} ignorati, {failed} non riusciti.",
    },
  };
  for (const [id, table] of Object.entries(UPDATE_CENTER_TRANSLATIONS)) Object.assign(TRANSLATIONS[id], table);

  // Resource sync copy is a complete per-locale table because the comparison
  // result is rendered dynamically per device pair, like the update center.
  const RESOURCE_SYNC_TRANSLATIONS = {
    en: {
      "Resource sync": "Resource sync",
      "Compare global Pi extensions, skills, and packages between two devices. Read-only; nothing is installed.": "Compare global Pi extensions, skills, and packages between two devices. Read-only; nothing is installed.",
      "Compare": "Compare", "With": "With",
      "Inventory source device": "Inventory source device", "Comparison target device": "Comparison target device",
      "Compare resources": "Compare resources",
      "Add another device to compare resources": "Add another device to compare resources",
      "Pick two different devices to compare": "Pick two different devices to compare",
      "Comparing resources…": "Comparing resources…",
      "Resource comparison failed": "Resource comparison failed",
      "Could not reach {device}": "Could not reach {device}",
      "Resource comparison needs a newer Pi Harbor on {device}": "Resource comparison needs a newer Pi Harbor on {device}",
      "No differences: both devices match": "No differences: both devices match",
      "{count} difference(s) found": "{count} difference(s) found",
      "Extensions": "Extensions", "Skills": "Skills", "Packages": "Packages",
      "{a} on {nameA} · {b} on {nameB}": "{a} on {nameA} · {b} on {nameB}",
      "Only on {device}": "Only on {device}", "Different on each device": "Different on each device",
      "{count} identical": "{count} identical",
    },
    "zh-Hant": {
      "Resource sync": "資源同步",
      "Compare global Pi extensions, skills, and packages between two devices. Read-only; nothing is installed.": "比對兩台裝置的全域 Pi 擴充功能、Skills 與套件。唯讀比對，不會安裝任何內容。",
      "Compare": "比對", "With": "與",
      "Inventory source device": "盤點來源裝置", "Comparison target device": "比對目標裝置",
      "Compare resources": "比對資源",
      "Add another device to compare resources": "新增另一台裝置才能比對資源",
      "Pick two different devices to compare": "請選擇兩台不同的裝置",
      "Comparing resources…": "正在比對資源…",
      "Resource comparison failed": "資源比對失敗",
      "Could not reach {device}": "無法連上 {device}",
      "Resource comparison needs a newer Pi Harbor on {device}": "{device} 需要較新的 Pi Harbor 才能比對資源",
      "No differences: both devices match": "沒有差異：兩台裝置一致",
      "{count} difference(s) found": "找到 {count} 項差異",
      "Extensions": "擴充功能", "Skills": "Skills", "Packages": "套件",
      "{a} on {nameA} · {b} on {nameB}": "{nameA} 有 {a} · {nameB} 有 {b}",
      "Only on {device}": "只在 {device}", "Different on each device": "兩台內容不同",
      "{count} identical": "{count} 項相同",
    },
    "zh-Hans": {
      "Resource sync": "资源同步",
      "Compare global Pi extensions, skills, and packages between two devices. Read-only; nothing is installed.": "比较两台设备的全局 Pi 扩展、Skills 与软件包。只读比较，不会安装任何内容。",
      "Compare": "比较", "With": "与",
      "Inventory source device": "盘点来源设备", "Comparison target device": "比较目标设备",
      "Compare resources": "比较资源",
      "Add another device to compare resources": "添加另一台设备才能比较资源",
      "Pick two different devices to compare": "请选择两台不同的设备",
      "Comparing resources…": "正在比较资源…",
      "Resource comparison failed": "资源比较失败",
      "Could not reach {device}": "无法连接 {device}",
      "Resource comparison needs a newer Pi Harbor on {device}": "{device} 需要较新的 Pi Harbor 才能比较资源",
      "No differences: both devices match": "没有差异：两台设备一致",
      "{count} difference(s) found": "找到 {count} 处差异",
      "Extensions": "扩展", "Skills": "Skills", "Packages": "软件包",
      "{a} on {nameA} · {b} on {nameB}": "{nameA} 有 {a} · {nameB} 有 {b}",
      "Only on {device}": "仅在 {device}", "Different on each device": "两台内容不同",
      "{count} identical": "{count} 项相同",
    },
    ja: {
      "Resource sync": "リソース同期",
      "Compare global Pi extensions, skills, and packages between two devices. Read-only; nothing is installed.": "2台のデバイス間でグローバルなPi拡張機能・Skills・パッケージを比較します。読み取り専用で、何もインストールしません。",
      "Compare": "比較", "With": "と",
      "Inventory source device": "基準デバイス", "Comparison target device": "比較デバイス",
      "Compare resources": "リソースを比較",
      "Add another device to compare resources": "比較するには別のデバイスを追加してください",
      "Pick two different devices to compare": "異なる2台のデバイスを選択してください",
      "Comparing resources…": "リソースを比較中…",
      "Resource comparison failed": "リソースの比較に失敗しました",
      "Could not reach {device}": "{device} に接続できません",
      "Resource comparison needs a newer Pi Harbor on {device}": "リソース比較には {device} の新しいPi Harborが必要です",
      "No differences: both devices match": "差分なし：両デバイス一致",
      "{count} difference(s) found": "{count} 件の差分が見つかりました",
      "Extensions": "拡張機能", "Skills": "Skills", "Packages": "パッケージ",
      "{a} on {nameA} · {b} on {nameB}": "{nameA}：{a} · {nameB}：{b}",
      "Only on {device}": "{device} のみ", "Different on each device": "両デバイスで内容が異なります",
      "{count} identical": "{count} 件が同一",
    },
    ko: {
      "Resource sync": "리소스 동기화",
      "Compare global Pi extensions, skills, and packages between two devices. Read-only; nothing is installed.": "두 기기 간에 전역 Pi 확장, Skills, 패키지를 비교합니다. 읽기 전용이며 아무것도 설치하지 않습니다.",
      "Compare": "비교", "With": "대상",
      "Inventory source device": "기준 기기", "Comparison target device": "비교 대상 기기",
      "Compare resources": "리소스 비교",
      "Add another device to compare resources": "리소스를 비교하려면 다른 기기를 추가하세요",
      "Pick two different devices to compare": "서로 다른 두 기기를 선택하세요",
      "Comparing resources…": "리소스 비교 중…",
      "Resource comparison failed": "리소스 비교 실패",
      "Could not reach {device}": "{device}에 연결할 수 없음",
      "Resource comparison needs a newer Pi Harbor on {device}": "리소스 비교에는 {device}의 최신 Pi Harbor가 필요합니다",
      "No differences: both devices match": "차이 없음: 두 기기가 일치합니다",
      "{count} difference(s) found": "차이 {count}개 발견",
      "Extensions": "확장", "Skills": "Skills", "Packages": "패키지",
      "{a} on {nameA} · {b} on {nameB}": "{nameA}: {a} · {nameB}: {b}",
      "Only on {device}": "{device}에만 있음", "Different on each device": "각 기기의 내용이 다릅니다",
      "{count} identical": "동일 {count}개",
    },
    tr: {
      "Resource sync": "Kaynak senkronizasyonu",
      "Compare global Pi extensions, skills, and packages between two devices. Read-only; nothing is installed.": "İki cihaz arasındaki global Pi uzantılarını, Skills'leri ve paketleri karşılaştırın. Salt okunur; hiçbir şey yüklenmez.",
      "Compare": "Karşılaştır", "With": "Şununla",
      "Inventory source device": "Envanter kaynağı cihaz", "Comparison target device": "Karşılaştırma hedefi cihaz",
      "Compare resources": "Kaynakları karşılaştır",
      "Add another device to compare resources": "Kaynakları karşılaştırmak için başka bir cihaz ekleyin",
      "Pick two different devices to compare": "Karşılaştırmak için iki farklı cihaz seçin",
      "Comparing resources…": "Kaynaklar karşılaştırılıyor…",
      "Resource comparison failed": "Kaynak karşılaştırması başarısız oldu",
      "Could not reach {device}": "{device} cihazına ulaşılamadı",
      "Resource comparison needs a newer Pi Harbor on {device}": "Kaynak karşılaştırması için {device} üzerinde daha yeni bir Pi Harbor gerekir",
      "No differences: both devices match": "Fark yok: iki cihaz da aynı",
      "{count} difference(s) found": "{count} fark bulundu",
      "Extensions": "Uzantılar", "Skills": "Skills", "Packages": "Paketler",
      "{a} on {nameA} · {b} on {nameB}": "{nameA}: {a} · {nameB}: {b}",
      "Only on {device}": "Yalnızca {device}", "Different on each device": "Her cihazda farklı",
      "{count} identical": "{count} özdeş",
    },
    fr: {
      "Resource sync": "Synchronisation des ressources",
      "Compare global Pi extensions, skills, and packages between two devices. Read-only; nothing is installed.": "Comparez les extensions, skills et paquets Pi globaux entre deux appareils. Lecture seule ; rien n'est installé.",
      "Compare": "Comparer", "With": "Avec",
      "Inventory source device": "Appareil source de l'inventaire", "Comparison target device": "Appareil cible de la comparaison",
      "Compare resources": "Comparer les ressources",
      "Add another device to compare resources": "Ajoutez un autre appareil pour comparer les ressources",
      "Pick two different devices to compare": "Choisissez deux appareils différents",
      "Comparing resources…": "Comparaison des ressources…",
      "Resource comparison failed": "Échec de la comparaison des ressources",
      "Could not reach {device}": "Impossible de joindre {device}",
      "Resource comparison needs a newer Pi Harbor on {device}": "La comparaison des ressources nécessite un Pi Harbor plus récent sur {device}",
      "No differences: both devices match": "Aucune différence : les deux appareils concordent",
      "{count} difference(s) found": "{count} différence(s) trouvée(s)",
      "Extensions": "Extensions", "Skills": "Skills", "Packages": "Paquets",
      "{a} on {nameA} · {b} on {nameB}": "{nameA} : {a} · {nameB} : {b}",
      "Only on {device}": "Uniquement sur {device}", "Different on each device": "Différent sur chaque appareil",
      "{count} identical": "{count} identiques",
    },
    de: {
      "Resource sync": "Ressourcen-Sync",
      "Compare global Pi extensions, skills, and packages between two devices. Read-only; nothing is installed.": "Vergleiche globale Pi-Erweiterungen, Skills und Pakete zwischen zwei Geräten. Nur lesend; nichts wird installiert.",
      "Compare": "Vergleichen", "With": "Mit",
      "Inventory source device": "Basisgerät", "Comparison target device": "Vergleichsgerät",
      "Compare resources": "Ressourcen vergleichen",
      "Add another device to compare resources": "Füge ein weiteres Gerät hinzu, um Ressourcen zu vergleichen",
      "Pick two different devices to compare": "Wähle zwei unterschiedliche Geräte",
      "Comparing resources…": "Ressourcen werden verglichen…",
      "Resource comparison failed": "Ressourcenvergleich fehlgeschlagen",
      "Could not reach {device}": "{device} ist nicht erreichbar",
      "Resource comparison needs a newer Pi Harbor on {device}": "Der Ressourcenvergleich benötigt ein neueres Pi Harbor auf {device}",
      "No differences: both devices match": "Keine Unterschiede: beide Geräte sind identisch",
      "{count} difference(s) found": "{count} Unterschied(e) gefunden",
      "Extensions": "Erweiterungen", "Skills": "Skills", "Packages": "Pakete",
      "{a} on {nameA} · {b} on {nameB}": "{nameA}: {a} · {nameB}: {b}",
      "Only on {device}": "Nur auf {device}", "Different on each device": "Auf jedem Gerät unterschiedlich",
      "{count} identical": "{count} identisch",
    },
    es: {
      "Resource sync": "Sincronización de recursos",
      "Compare global Pi extensions, skills, and packages between two devices. Read-only; nothing is installed.": "Compara extensiones, skills y paquetes globales de Pi entre dos dispositivos. Solo lectura; no se instala nada.",
      "Compare": "Comparar", "With": "Con",
      "Inventory source device": "Dispositivo de origen", "Comparison target device": "Dispositivo de comparación",
      "Compare resources": "Comparar recursos",
      "Add another device to compare resources": "Añade otro dispositivo para comparar recursos",
      "Pick two different devices to compare": "Elige dos dispositivos distintos",
      "Comparing resources…": "Comparando recursos…",
      "Resource comparison failed": "Error al comparar recursos",
      "Could not reach {device}": "No se pudo conectar con {device}",
      "Resource comparison needs a newer Pi Harbor on {device}": "La comparación de recursos requiere un Pi Harbor más reciente en {device}",
      "No differences: both devices match": "Sin diferencias: ambos dispositivos coinciden",
      "{count} difference(s) found": "{count} diferencia(s) encontrada(s)",
      "Extensions": "Extensiones", "Skills": "Skills", "Packages": "Paquetes",
      "{a} on {nameA} · {b} on {nameB}": "{nameA}: {a} · {nameB}: {b}",
      "Only on {device}": "Solo en {device}", "Different on each device": "Distinto en cada dispositivo",
      "{count} identical": "{count} idénticos",
    },
    "pt-BR": {
      "Resource sync": "Sincronização de recursos",
      "Compare global Pi extensions, skills, and packages between two devices. Read-only; nothing is installed.": "Compare extensões, skills e pacotes globais do Pi entre dois dispositivos. Somente leitura; nada é instalado.",
      "Compare": "Comparar", "With": "Com",
      "Inventory source device": "Dispositivo de origem", "Comparison target device": "Dispositivo de comparação",
      "Compare resources": "Comparar recursos",
      "Add another device to compare resources": "Adicione outro dispositivo para comparar recursos",
      "Pick two different devices to compare": "Escolha dois dispositivos diferentes",
      "Comparing resources…": "Comparando recursos…",
      "Resource comparison failed": "Falha ao comparar recursos",
      "Could not reach {device}": "Não foi possível acessar {device}",
      "Resource comparison needs a newer Pi Harbor on {device}": "A comparação de recursos requer um Pi Harbor mais recente em {device}",
      "No differences: both devices match": "Sem diferenças: os dispositivos coincidem",
      "{count} difference(s) found": "{count} diferença(s) encontrada(s)",
      "Extensions": "Extensões", "Skills": "Skills", "Packages": "Pacotes",
      "{a} on {nameA} · {b} on {nameB}": "{nameA}: {a} · {nameB}: {b}",
      "Only on {device}": "Somente em {device}", "Different on each device": "Diferente em cada dispositivo",
      "{count} identical": "{count} idênticos",
    },
    it: {
      "Resource sync": "Sincronizzazione risorse",
      "Compare global Pi extensions, skills, and packages between two devices. Read-only; nothing is installed.": "Confronta estensioni, skill e pacchetti Pi globali tra due dispositivi. Sola lettura; non viene installato nulla.",
      "Compare": "Confronta", "With": "Con",
      "Inventory source device": "Dispositivo di origine", "Comparison target device": "Dispositivo di confronto",
      "Compare resources": "Confronta risorse",
      "Add another device to compare resources": "Aggiungi un altro dispositivo per confrontare le risorse",
      "Pick two different devices to compare": "Scegli due dispositivi diversi",
      "Comparing resources…": "Confronto delle risorse…",
      "Resource comparison failed": "Confronto delle risorse non riuscito",
      "Could not reach {device}": "Impossibile raggiungere {device}",
      "Resource comparison needs a newer Pi Harbor on {device}": "Il confronto delle risorse richiede un Pi Harbor più recente su {device}",
      "No differences: both devices match": "Nessuna differenza: i dispositivi coincidono",
      "{count} difference(s) found": "{count} differenza/e trovata/e",
      "Extensions": "Estensioni", "Skills": "Skills", "Packages": "Pacchetti",
      "{a} on {nameA} · {b} on {nameB}": "{nameA}: {a} · {nameB}: {b}",
      "Only on {device}": "Solo su {device}", "Different on each device": "Diverso su ogni dispositivo",
      "{count} identical": "{count} identici",
    },
  };
  for (const [id, table] of Object.entries(RESOURCE_SYNC_TRANSLATIONS)) Object.assign(TRANSLATIONS[id], table);

  // Thinking-level copy: Pi clamps levels per model, so the composer must be
  // honest about what a model supports and the provider form explains the
  // thinking marker that keeps reasoning models reasoning.
  const THINKING_LEVEL_TRANSLATIONS = {
    en: {
      "{model} does not support {level} thinking; using {actual}": "{model} does not support {level} thinking; using {actual}",
      "; add ": "; add ", " for reasoning models": " for reasoning models",
    },
    "zh-Hant": {
      "{model} does not support {level} thinking; using {actual}": "{model} 不支援 {level} 思考等級；改用 {actual}",
      "; add ": "；在結尾加 ", " for reasoning models": " 即標記為推論模型",
    },
    "zh-Hans": {
      "{model} does not support {level} thinking; using {actual}": "{model} 不支持 {level} 思考等级；改用 {actual}",
      "; add ": "；结尾加 ", " for reasoning models": " 即标记为推理模型",
    },
    ja: {
      "{model} does not support {level} thinking; using {actual}": "{model} は {level} の思考レベルに対応していません。{actual} を使用します",
      "; add ": "；末尾に ", " for reasoning models": " を付けると推論モデルになります",
    },
    ko: {
      "{model} does not support {level} thinking; using {actual}": "{model}은(는) {level} 사고 수준을 지원하지 않습니다. {actual} 사용",
      "; add ": ", 뒤에 ", " for reasoning models": "을 붙이면 추론 모델로 표시됩니다",
    },
    tr: {
      "{model} does not support {level} thinking; using {actual}": "{model}, {level} düşünme seviyesini desteklemiyor; {actual} kullanılıyor",
      "; add ": ", ekleyin: ", " for reasoning models": " akıl yürütme modelleri için",
    },
    fr: {
      "{model} does not support {level} thinking; using {actual}": "{model} ne prend pas en charge le niveau de réflexion {level} ; utilisation de {actual}",
      "; add ": " ; ajoutez ", " for reasoning models": " pour les modèles à raisonnement",
    },
    de: {
      "{model} does not support {level} thinking; using {actual}": "{model} unterstützt die Denkstufe {level} nicht; verwende {actual}",
      "; add ": ", füge ", " for reasoning models": " für Modelle mit Reasoning hinzu",
    },
    es: {
      "{model} does not support {level} thinking; using {actual}": "{model} no admite el nivel de razonamiento {level}; se usa {actual}",
      "; add ": ", añade ", " for reasoning models": " para modelos con razonamiento",
    },
    "pt-BR": {
      "{model} does not support {level} thinking; using {actual}": "{model} não oferece suporte ao nível de raciocínio {level}; usando {actual}",
      "; add ": ", adicione ", " for reasoning models": " para modelos de raciocínio",
    },
    it: {
      "{model} does not support {level} thinking; using {actual}": "{model} non supporta il livello di ragionamento {level}; si usa {actual}",
      "; add ": ", aggiungi ", " for reasoning models": " per i modelli con reasoning",
    },
  };
  for (const [id, table] of Object.entries(THINKING_LEVEL_TRANSLATIONS)) Object.assign(TRANSLATIONS[id], table);

  // Sub Agent filter copy: a short constant label + state note keeps the row
  // readable in the narrowest desktop sidebar in every locale.
  const SUB_AGENT_FILTER_TRANSLATIONS = {
    en: {
      "Sub Agent sessions": "Sub Agent sessions",
      "Hidden by default": "Hidden by default", "Showing": "Showing",
    },
    "zh-Hant": {
      "Sub Agent sessions": "Sub Agent 工作階段",
      "Hidden by default": "預設隱藏", "Showing": "顯示中",
    },
    "zh-Hans": {
      "Sub Agent sessions": "Sub Agent 会话",
      "Hidden by default": "默认隐藏", "Showing": "显示中",
    },
    ja: {
      "Sub Agent sessions": "Sub Agent セッション",
      "Hidden by default": "既定で非表示", "Showing": "表示中",
    },
    ko: {
      "Sub Agent sessions": "Sub Agent 세션",
      "Hidden by default": "기본 숨김", "Showing": "표시 중",
    },
    tr: {
      "Sub Agent sessions": "Sub Agent oturumları",
      "Hidden by default": "Varsayılan olarak gizli", "Showing": "Gösteriliyor",
    },
    fr: {
      "Sub Agent sessions": "Sessions des Sub Agent",
      "Hidden by default": "Masquées par défaut", "Showing": "Affichées",
    },
    de: {
      "Sub Agent sessions": "Sub-Agent-Sitzungen",
      "Hidden by default": "Standardmäßig ausgeblendet", "Showing": "Eingeblendet",
    },
    es: {
      "Sub Agent sessions": "Sesiones de Sub Agent",
      "Hidden by default": "Ocultas por defecto", "Showing": "Mostrando",
    },
    "pt-BR": {
      "Sub Agent sessions": "Sessões de Sub Agent",
      "Hidden by default": "Ocultas por padrão", "Showing": "Mostrando",
    },
    it: {
      "Sub Agent sessions": "Sessioni dei Sub Agent",
      "Hidden by default": "Nascoste per impostazione predefinita", "Showing": "Visibili",
    },
  };
  for (const [id, table] of Object.entries(SUB_AGENT_FILTER_TRANSLATIONS)) Object.assign(TRANSLATIONS[id], table);

  // Stuck-run banner: one short title, one action button, one confirmation.
  const STUCK_SESSION_TRANSLATIONS = {
    en: { "Stuck sessions": "Stuck sessions", "Force stop": "Force stop", "Stuck run closed": "Stuck run closed" },
    "zh-Hant": { "Stuck sessions": "卡住的工作", "Force stop": "強制關閉", "Stuck run closed": "已關閉卡住的工作" },
    "zh-Hans": { "Stuck sessions": "卡住的任务", "Force stop": "强制关闭", "Stuck run closed": "已关闭卡住的任务" },
    ja: { "Stuck sessions": "停止中のタスク", "Force stop": "強制停止", "Stuck run closed": "停止中のタスクを終了しました" },
    ko: { "Stuck sessions": "멈춘 작업", "Force stop": "강제 중지", "Stuck run closed": "멈춘 작업을 종료했습니다" },
    tr: { "Stuck sessions": "Takılı kalan işler", "Force stop": "Zorla durdur", "Stuck run closed": "Takılı iş kapatıldı" },
    fr: { "Stuck sessions": "Exécutions bloquées", "Force stop": "Forcer l'arrêt", "Stuck run closed": "Exécution bloquée fermée" },
    de: { "Stuck sessions": "Hängende Läufe", "Force stop": "Erzwungen beenden", "Stuck run closed": "Hängender Lauf beendet" },
    es: { "Stuck sessions": "Ejecuciones atascadas", "Force stop": "Forzar detención", "Stuck run closed": "Ejecución atascada cerrada" },
    "pt-BR": { "Stuck sessions": "Execuções travadas", "Force stop": "Forçar parada", "Stuck run closed": "Execução travada encerrada" },
    it: { "Stuck sessions": "Esecuzioni bloccate", "Force stop": "Forza interruzione", "Stuck run closed": "Esecuzione bloccata chiusa" },
  };
  for (const [id, table] of Object.entries(STUCK_SESSION_TRANSLATIONS)) Object.assign(TRANSLATIONS[id], table);

  // Provider config portability dialogs and toasts.
  const PROVIDER_CONFIG_TRANSLATIONS = {
    en: {
      "New session": "New session", "Open Settings": "Open Settings",
      "Provider config exported": "Provider config exported",
      "Provider config exported with API keys": "Provider config exported with API keys",
      "Include API keys in the export file?": "Include API keys in the export file?\n\nCancel = export without secrets (keys stay on this device).\nOK = include keys in plain text; keep the file safe.",
      "Invalid JSON file": "Invalid JSON file",
      "No providers found in the imported file": "No providers found in the imported file",
      "Import these providers?": "Import these providers?",
      "Providers with the same ID will be replaced.": "Providers with the same id are replaced.",
      "Imported {count} providers": "Imported {count} providers",
    },
    "zh-Hant": {
      "New session": "新工作階段", "Open Settings": "開啟設定",
      "Provider config exported": "Provider 設定已匯出",
      "Provider config exported with API keys": "Provider 設定已匯出（含 API key）",
      "Include API keys in the export file?": "要在匯出檔中包含 API key 嗎？\n\n取消 = 不含金錀（金錀留在這台電腦）\n確定 = 以明碼包含金錀，請妥善保存檔案",
      "Invalid JSON file": "JSON 檔案格式錯誤",
      "No providers found in the imported file": "匯入檔中沒有 Provider",
      "Import these providers?": "要匯入這些 Provider 嗎？",
      "Providers with the same ID will be replaced.": "相同 ID 的 Provider 會被取代。",
      "Imported {count} providers": "已匯入 {count} 個 Provider",
    },
    "zh-Hans": {
      "New session": "新会话", "Open Settings": "打开设置",
      "Provider config exported": "Provider 配置已导出",
      "Provider config exported with API keys": "Provider 配置已导出（含 API key）",
      "Include API keys in the export file?": "要在导出文件中包含 API key 吗？\n\n取消 = 不含密钥（密钥留在这台电脑）\n确定 = 以明文包含密钥，请妥善保管",
      "Invalid JSON file": "JSON 文件格式错误",
      "No providers found in the imported file": "导入文件中没有 Provider",
      "Import these providers?": "要导入这些 Provider 吗？",
      "Providers with the same ID will be replaced.": "相同 ID 的 Provider 会被替换。",
      "Imported {count} providers": "已导入 {count} 个 Provider",
    },
    ja: {
      "New session": "新規セッション", "Open Settings": "設定を開く",
      "Provider config exported": "Provider 設定を書き出しました",
      "Provider config exported with API keys": "API キー付きで Provider 設定を書き出しました",
      "Include API keys in the export file?": "書き出しファイルに API キーを含めますか？\n\nキャンセル = キーを含めない（この端末に留まります）\nOK = キーを平文で含めます。取り扱いに注意",
      "Invalid JSON file": "JSON ファイルが不正です",
      "No providers found in the imported file": "取り込むファイルに Provider がありません",
      "Import these providers?": "これらの Provider を取り込みますか？",
      "Providers with the same ID will be replaced.": "同じ ID の Provider は置き換えられます。",
      "Imported {count} providers": "{count} 件の Provider を取り込みました",
    },
    ko: {
      "New session": "새 세션", "Open Settings": "설정 열기",
      "Provider config exported": "Provider 설정을 내보냈습니다",
      "Provider config exported with API keys": "API 키를 포함해 Provider 설정을 내보냈습니다",
      "Include API keys in the export file?": "내보내기 파일에 API 키를 포함할까요?\n\n취소 = 키 제외 (이 기기에만 유지)\n확인 = 키를 평문으로 포함. 파일을 안전하게 보관하세요",
      "Invalid JSON file": "잘못된 JSON 파일입니다",
      "No providers found in the imported file": "가져온 파일에 Provider가 없습니다",
      "Import these providers?": "이 Provider들을 가져오시겠습니까?",
      "Providers with the same ID will be replaced.": "같은 ID의 Provider는 대체됩니다.",
      "Imported {count} providers": "{count}개의 Provider를 가져왔습니다",
    },
    tr: {
      "New session": "Yeni oturum", "Open Settings": "Ayarları aç",
      "Provider config exported": "Provider yapılandırması dışa aktarıldı",
      "Provider config exported with API keys": "API anahtarlarıyla Provider yapılandırması dışa aktarıldı",
      "Include API keys in the export file?": "Dışa aktarılan dosyaya API anahtarları eklensin mi?\n\nİptal = anahtarlar olmadan (bu cihazda kalır)\nTamam = anahtarlar düz metinle eklenir; dosyayı güvende tutun",
      "Invalid JSON file": "Geçersiz JSON dosyası",
      "No providers found in the imported file": "İçe alınan dosyada Provider yok",
      "Import these providers?": "Bu Provider'lar içe aktarılsın mı?",
      "Providers with the same ID will be replaced.": "Aynı kimlikli Provider'lar değiştirilir.",
      "Imported {count} providers": "{count} Provider içe aktarıldı",
    },
    fr: {
      "New session": "Nouvelle session", "Open Settings": "Ouvrir les réglages",
      "Provider config exported": "Configuration des fournisseurs exportée",
      "Provider config exported with API keys": "Configuration exportée avec les clés API",
      "Include API keys in the export file?": "Inclure les clés API dans le fichier d'export ?\n\nAnnuler = exporter sans secrets (les clés restent sur cet appareil)\nOK = inclure les clés en clair ; gardez le fichier en sécurité",
      "Invalid JSON file": "Fichier JSON invalide",
      "No providers found in the imported file": "Aucun fournisseur dans le fichier importé",
      "Import these providers?": "Importer ces fournisseurs ?",
      "Providers with the same ID will be replaced.": "Les fournisseurs du même identifiant sont remplacés.",
      "Imported {count} providers": "{count} fournisseurs importés",
    },
    de: {
      "New session": "Neue Sitzung", "Open Settings": "Einstellungen öffnen",
      "Provider config exported": "Provider-Konfiguration exportiert",
      "Provider config exported with API keys": "Provider-Konfiguration mit API-Schlüsseln exportiert",
      "Include API keys in the export file?": "API-Schlüssel in die Exportdatei aufnehmen?\n\nAbbrechen = ohne Geheimnisse exportieren (Schlüssel bleiben auf diesem Gerät)\nOK = Schlüssel im Klartext aufnehmen; Datei sicher aufbewahren",
      "Invalid JSON file": "Ungültige JSON-Datei",
      "No providers found in the imported file": "Keine Provider in der importierten Datei gefunden",
      "Import these providers?": "Diese Provider importieren?",
      "Providers with the same ID will be replaced.": "Provider mit derselben ID werden ersetzt.",
      "Imported {count} providers": "{count} Provider importiert",
    },
    es: {
      "New session": "Nueva sesión", "Open Settings": "Abrir ajustes",
      "Provider config exported": "Configuración de proveedores exportada",
      "Provider config exported with API keys": "Configuración exportada con claves API",
      "Include API keys in the export file?": "¿Incluir claves API en el archivo de exportación?\n\nCancelar = exportar sin secretos (las claves se quedan en este dispositivo)\nAceptar = incluir claves en texto plano; guarda el archivo con cuidado",
      "Invalid JSON file": "Archivo JSON no válido",
      "No providers found in the imported file": "No hay proveedores en el archivo importado",
      "Import these providers?": "¿Importar estos proveedores?",
      "Providers with the same ID will be replaced.": "Los proveedores con el mismo ID se reemplazan.",
      "Imported {count} providers": "{count} proveedores importados",
    },
    "pt-BR": {
      "New session": "Nova sessão", "Open Settings": "Abrir ajustes",
      "Provider config exported": "Configuração de provedores exportada",
      "Provider config exported with API keys": "Configuração exportada com chaves de API",
      "Include API keys in the export file?": "Incluir chaves de API no arquivo exportado?\n\nCancelar = exportar sem segredos (as chaves ficam neste dispositivo)\nOK = incluir chaves em texto puro; mantenha o arquivo seguro",
      "Invalid JSON file": "Arquivo JSON inválido",
      "No providers found in the imported file": "Nenhum provedor no arquivo importado",
      "Import these providers?": "Importar estes provedores?",
      "Providers with the same ID will be replaced.": "Provedores com o mesmo ID serão substituídos.",
      "Imported {count} providers": "{count} provedores importados",
    },
    it: {
      "New session": "Nuova sessione", "Open Settings": "Apri impostazioni",
      "Provider config exported": "Configurazione dei provider esportata",
      "Provider config exported with API keys": "Configurazione esportata con chiavi API",
      "Include API keys in the export file?": "Includere le chiavi API nel file esportato?\n\nAnnulla = esporta senza segreti (le chiavi restano su questo dispositivo)\nOK = includi le chiavi in chiaro; conserva il file al sicuro",
      "Invalid JSON file": "File JSON non valido",
      "No providers found in the imported file": "Nessun provider nel file importato",
      "Import these providers?": "Importare questi provider?",
      "Providers with the same ID will be replaced.": "I provider con lo stesso ID vengono sostituiti.",
      "Imported {count} providers": "{count} provider importati",
    },
  };
  for (const [id, table] of Object.entries(PROVIDER_CONFIG_TRANSLATIONS)) Object.assign(TRANSLATIONS[id], table);

  // Local usage summary card.
  const USAGE_TRANSLATIONS = {
    en: { "Usage · last 7 days": "Usage · last 7 days", "No usage in the last 7 days": "No usage in the last 7 days", "Full-text results": "Full-text results", "Session exported": "Session exported" },
    "zh-Hant": { "Usage · last 7 days": "用量 · 最近 7 天", "No usage in the last 7 days": "最近 7 天沒有用量", "Full-text results": "全文搜尋結果", "Session exported": "工作階段已匯出" },
    "zh-Hans": { "Usage · last 7 days": "用量 · 最近 7 天", "No usage in the last 7 days": "最近 7 天没有用量", "Full-text results": "全文搜索结果", "Session exported": "会话已导出" },
    ja: { "Usage · last 7 days": "使用量 · 過去7日間", "No usage in the last 7 days": "過去7日間の使用はありません", "Full-text results": "全文検索結果", "Session exported": "セッションを書き出しました" },
    ko: { "Usage · last 7 days": "사용량 · 최근 7일", "No usage in the last 7 days": "최근 7일간 사용 기록이 없습니다", "Full-text results": "전체 검색 결과", "Session exported": "세션을 내보냈습니다" },
    tr: { "Usage · last 7 days": "Kullanım · son 7 gün", "No usage in the last 7 days": "Son 7 günde kullanım yok", "Full-text results": "Tam metin sonuçları", "Session exported": "Oturum dışa aktarıldı" },
    fr: { "Usage · last 7 days": "Utilisation · 7 derniers jours", "No usage in the last 7 days": "Aucune utilisation ces 7 derniers jours", "Full-text results": "Résultats plein texte", "Session exported": "Session exportée" },
    de: { "Usage · last 7 days": "Verbrauch · letzte 7 Tage", "No usage in the last 7 days": "Kein Verbrauch in den letzten 7 Tagen", "Full-text results": "Volltext-Ergebnisse", "Session exported": "Sitzung exportiert" },
    es: { "Usage · last 7 days": "Uso · últimos 7 días", "No usage in the last 7 days": "Sin uso en los últimos 7 días", "Full-text results": "Resultados de texto completo", "Session exported": "Sesión exportada" },
    "pt-BR": { "Usage · last 7 days": "Uso · últimos 7 dias", "No usage in the last 7 days": "Sem uso nos últimos 7 dias", "Full-text results": "Resultados de texto integral", "Session exported": "Sessão exportada" },
    it: { "Usage · last 7 days": "Utilizzo · ultimi 7 giorni", "No usage in the last 7 days": "Nessun utilizzo negli ultimi 7 giorni", "Full-text results": "Risultati full-text", "Session exported": "Sessione esportata" },
  };
  for (const [id, table] of Object.entries(USAGE_TRANSLATIONS)) Object.assign(TRANSLATIONS[id], table);

  // Push notification settings.
  const PUSH_TRANSLATIONS = {
    en: { "Not available": "Not available", "Enable": "Enable", "Notifications on": "Notifications on", "Notifications off": "Notifications off", "Blocked in browser settings": "Blocked in browser settings" },
    "zh-Hant": { "Not available": "不支援", "Enable": "啟用", "Notifications on": "通知已開啟", "Notifications off": "通知已關閉", "Blocked in browser settings": "已被瀏覽器封鎖" },
    "zh-Hans": { "Not available": "不支持", "Enable": "启用", "Notifications on": "通知已开启", "Notifications off": "通知已关闭", "Blocked in browser settings": "已被浏览器封锁" },
    ja: { "Not available": "利用不可", "Enable": "有効にする", "Notifications on": "通知オン", "Notifications off": "通知オフ", "Blocked in browser settings": "ブラウザでブロック中" },
    ko: { "Not available": "사용 불가", "Enable": "사용", "Notifications on": "알림 켜짐", "Notifications off": "알림 꺼짐", "Blocked in browser settings": "브라우저에서 차단됨" },
    tr: { "Not available": "Kullanılamıyor", "Enable": "Etkinleştir", "Notifications on": "Bildirimler açık", "Notifications off": "Bildirimler kapalı", "Blocked in browser settings": "Tarayıcıda engellendi" },
    fr: { "Not available": "Indisponible", "Enable": "Activer", "Notifications on": "Notifications activées", "Notifications off": "Notifications désactivées", "Blocked in browser settings": "Bloqué dans les réglages du navigateur" },
    de: { "Not available": "Nicht verfügbar", "Enable": "Aktivieren", "Notifications on": "Mitteilungen an", "Notifications off": "Mitteilungen aus", "Blocked in browser settings": "In den Browser-Einstellungen blockiert" },
    es: { "Not available": "No disponible", "Enable": "Activar", "Notifications on": "Notificaciones activadas", "Notifications off": "Notificaciones desactivadas", "Blocked in browser settings": "Bloqueado en los ajustes del navegador" },
    "pt-BR": { "Not available": "Indisponível", "Enable": "Ativar", "Notifications on": "Notificações ativadas", "Notifications off": "Notificações desativadas", "Blocked in browser settings": "Bloqueado nas configurações do navegador" },
    it: { "Not available": "Non disponibile", "Enable": "Attiva", "Notifications on": "Notifiche attive", "Notifications off": "Notifiche disattivate", "Blocked in browser settings": "Bloccato nelle impostazioni del browser" },
  };
  for (const [id, table] of Object.entries(PUSH_TRANSLATIONS)) Object.assign(TRANSLATIONS[id], table);

  const UPDATE_CLIENT_TRANSLATIONS = {
    en: {
      "Pi Harbor update ready; reload after the current work finishes": "Pi Harbor update ready; reload after the current work finishes",
      "Pi Harbor updated; reloading…": "Pi Harbor updated; reloading…",
      "Update Pi Harbor on this device to add or change provider credentials.": "Update Pi Harbor on this device to add or change provider credentials.",
    },
    "zh-Hant": {
      "Pi Harbor update ready; reload after the current work finishes": "Pi Harbor 更新已準備好；目前工作完成後請重新整理",
      "Pi Harbor updated; reloading…": "Pi Harbor 已更新；正在重新載入…",
      "Update Pi Harbor on this device to add or change provider credentials.": "請更新這台裝置上的 Pi Harbor，才能新增或變更 Provider 憑證。",
    },
    "zh-Hans": {
      "Pi Harbor update ready; reload after the current work finishes": "Pi Harbor 更新已准备好；当前工作完成后请刷新",
      "Pi Harbor updated; reloading…": "Pi Harbor 已更新；正在重新加载…",
      "Update Pi Harbor on this device to add or change provider credentials.": "请更新此设备上的 Pi Harbor，才能添加或更改 Provider 凭证。",
    },
    ja: {
      "Pi Harbor update ready; reload after the current work finishes": "Pi Harbor の更新を準備しました。現在の作業が終わったら再読み込みしてください",
      "Pi Harbor updated; reloading…": "Pi Harbor を更新しました。再読み込み中…",
      "Update Pi Harbor on this device to add or change provider credentials.": "プロバイダーの認証情報を追加または変更するには、このデバイスの Pi Harbor を更新してください。",
    },
    ko: {
      "Pi Harbor update ready; reload after the current work finishes": "Pi Harbor 업데이트가 준비되었습니다. 현재 작업이 끝나면 새로 고치세요",
      "Pi Harbor updated; reloading…": "Pi Harbor가 업데이트되었습니다. 다시 불러오는 중…",
      "Update Pi Harbor on this device to add or change provider credentials.": "Provider 자격 증명을 추가하거나 변경하려면 이 기기의 Pi Harbor를 업데이트하세요.",
    },
    tr: {
      "Pi Harbor update ready; reload after the current work finishes": "Pi Harbor güncellemesi hazır; mevcut çalışma bitince yeniden yükleyin",
      "Pi Harbor updated; reloading…": "Pi Harbor güncellendi; yeniden yükleniyor…",
      "Update Pi Harbor on this device to add or change provider credentials.": "Sağlayıcı kimlik bilgileri eklemek veya değiştirmek için bu cihazdaki Pi Harbor'ı güncelleyin.",
    },
    fr: {
      "Pi Harbor update ready; reload after the current work finishes": "La mise à jour de Pi Harbor est prête ; rechargez après la fin du travail en cours",
      "Pi Harbor updated; reloading…": "Pi Harbor a été mis à jour ; rechargement…",
      "Update Pi Harbor on this device to add or change provider credentials.": "Mettez à jour Pi Harbor sur cet appareil pour ajouter ou modifier les identifiants du fournisseur.",
    },
    de: {
      "Pi Harbor update ready; reload after the current work finishes": "Das Pi-Harbor-Update ist bereit; laden Sie nach Abschluss der aktuellen Arbeit neu",
      "Pi Harbor updated; reloading…": "Pi Harbor wurde aktualisiert; wird neu geladen…",
      "Update Pi Harbor on this device to add or change provider credentials.": "Aktualisieren Sie Pi Harbor auf diesem Gerät, um Anbieter-Zugangsdaten hinzuzufügen oder zu ändern.",
    },
    es: {
      "Pi Harbor update ready; reload after the current work finishes": "La actualización de Pi Harbor está lista; recarga cuando termine el trabajo actual",
      "Pi Harbor updated; reloading…": "Pi Harbor se ha actualizado; recargando…",
      "Update Pi Harbor on this device to add or change provider credentials.": "Actualiza Pi Harbor en este dispositivo para añadir o cambiar las credenciales del proveedor.",
    },
    "pt-BR": {
      "Pi Harbor update ready; reload after the current work finishes": "A atualização do Pi Harbor está pronta; recarregue quando o trabalho atual terminar",
      "Pi Harbor updated; reloading…": "O Pi Harbor foi atualizado; recarregando…",
      "Update Pi Harbor on this device to add or change provider credentials.": "Atualize o Pi Harbor neste dispositivo para adicionar ou alterar as credenciais do provedor.",
    },
    it: {
      "Pi Harbor update ready; reload after the current work finishes": "L’aggiornamento di Pi Harbor è pronto; ricarica al termine del lavoro corrente",
      "Pi Harbor updated; reloading…": "Pi Harbor è stato aggiornato; ricaricamento…",
      "Update Pi Harbor on this device to add or change provider credentials.": "Aggiorna Pi Harbor su questo dispositivo per aggiungere o modificare le credenziali del provider.",
    },
  };
  for (const [id, table] of Object.entries(UPDATE_CLIENT_TRANSLATIONS)) Object.assign(TRANSLATIONS[id], table);

  // Keep the locale tables auditable.  The UI still uses the English source
  // key as its safe fallback, but every fallback is now explicit and can be
  // reported in development/tests instead of silently leaking a random
  // language after a dynamic DOM update.
  // Stable keys are used by the device-trust and pairing UI. They are kept
  // separate from the legacy English/Chinese fragment translator so new copy
  // never depends on whole-DOM substring replacement.
  const KEYED_TRANSLATIONS = {
    en: {
      "deviceTrust.pairingNote": "One-time pairing creates an independent, revocable device credential. Manual URL entry remains the legacy shared Web-token path.",
      "deviceTrust.authorizedTitle": "Authorized devices",
      "deviceTrust.authorizedLoading": "Loading authorized devices…",
      "deviceTrust.authorizedEmpty": "No dedicated peer credentials are authorized on this device.",
      "deviceTrust.authorizedUnavailable": "Authorized devices are unavailable.",
      "deviceTrust.authLocal": "Local",
      "deviceTrust.authDedicated": "Dedicated peer",
      "deviceTrust.authLegacy": "Legacy shared token",
      "deviceTrust.authUnavailable": "Trust unavailable",
      "deviceTrust.remoteAuthorizationError": "{device} is offline or no longer authorized. Delete it and pair it again.",
      "deviceTrust.dedicatedUrlChange": "This dedicated device URL cannot be changed. Delete the device and pair it again.",
      "deviceTrust.trustStateUnavailable": "Device trust is unavailable; repair it before changing URLs or pairing.",
      "deviceTrust.authorizedOn": "Authorized {date}",
      "deviceTrust.revoke": "Revoke",
      "deviceTrust.revokeConfirm": "Revoke access for {device}?",
      "deviceTrust.revoked": "Device access revoked",
      "deviceTrust.revokeFailed": "Could not revoke device access",
      "deviceTrust.reviewTitle": "Pairing review",
      "deviceTrust.reviewDescription": "Check the device details before connecting.",
      "deviceTrust.candidate": "Device",
      "deviceTrust.expires": "Expires {time}",
      "deviceTrust.version": "Pairing version {version}",
      "deviceTrust.reviewCode": "Review pairing code",
      "deviceTrust.confirmPair": "Pair this device",
      "deviceTrust.codeNotice": "Codes expire after five minutes and can only be used once.",
      "deviceTrust.codeGenerated": "Pairing code is valid for five minutes; paste it into another Pi Harbor.",
      "deviceTrust.pasteCode": "Paste a PIHARBOR3 code generated by another Pi Harbor. Review the device details before pairing.",
      "deviceTrust.helpTitle": "How to add a device",
      "deviceTrust.helpManual": "For a legacy connection, enter the other Pi Harbor URL and save it. Both devices must use the same Web token.",
      "deviceTrust.helpPairStep": "For independent access, create a one-time pairing code in the other device's Settings, then paste it here.",
      "deviceTrust.helpConfirmStep": "Review the device details, then choose Pair this device. The code is used once and expires after five minutes.",
      "deviceTrust.manualNote": "Manual URL entry stays on the legacy shared Web-token path; one-time pairing provisions an independent, revocable credential.",
      "deviceTrust.inUse": "In use · {status}",
      "deviceTrust.statusOnline": "Online",
      "deviceTrust.statusOffline": "Offline",
      "deviceTrust.statusNotChecked": "Not checked",
      "deviceTrust.savedNotice": "Pairing code generated; copy it manually",
    },
    "zh-Hant": {
      "deviceTrust.pairingNote": "一次性配對會建立獨立且可撤銷的裝置憑證。手動輸入網址仍使用舊版共用 Web token 路徑。",
      "deviceTrust.authorizedTitle": "已授權裝置",
      "deviceTrust.authorizedLoading": "正在載入已授權裝置…",
      "deviceTrust.authorizedEmpty": "這台裝置目前沒有獲授權的專用對等憑證。",
      "deviceTrust.authorizedUnavailable": "無法取得已授權裝置。",
      "deviceTrust.authLocal": "本機",
      "deviceTrust.authDedicated": "專用對等憑證",
      "deviceTrust.authLegacy": "舊版共用 token",
      "deviceTrust.authUnavailable": "信任狀態無法使用",
      "deviceTrust.remoteAuthorizationError": "「{device}」離線或已不再獲授權。請刪除後重新配對。",
      "deviceTrust.dedicatedUrlChange": "無法變更這台專用裝置的網址。請刪除裝置後重新配對。",
      "deviceTrust.trustStateUnavailable": "裝置信任狀態無法使用，修復後才能變更網址或配對。",
      "deviceTrust.authorizedOn": "授權於 {date}",
      "deviceTrust.revoke": "撤銷",
      "deviceTrust.revokeConfirm": "要撤銷「{device}」的存取權嗎？",
      "deviceTrust.revoked": "裝置存取權已撤銷",
      "deviceTrust.revokeFailed": "無法撤銷裝置存取權",
      "deviceTrust.reviewTitle": "配對確認",
      "deviceTrust.reviewDescription": "連線前請檢查裝置資料。",
      "deviceTrust.candidate": "裝置",
      "deviceTrust.expires": "到期時間 {time}",
      "deviceTrust.version": "配對版本 {version}",
      "deviceTrust.reviewCode": "檢查配對碼",
      "deviceTrust.confirmPair": "配對這台裝置",
      "deviceTrust.codeNotice": "配對碼五分鐘後到期，且只能使用一次。",
      "deviceTrust.codeGenerated": "配對碼五分鐘內有效，請貼到另一個 Pi Harbor。",
      "deviceTrust.pasteCode": "請貼上由另一個 Pi Harbor 產生的 PIHARBOR3 配對碼。配對前請檢查裝置資料。",
      "deviceTrust.helpTitle": "如何新增裝置",
      "deviceTrust.helpManual": "若要使用舊版連線，請輸入另一個 Pi Harbor 網址並儲存。兩台裝置必須使用相同的 Web token。",
      "deviceTrust.helpPairStep": "若要使用獨立存取權，請在另一台裝置的設定中建立一次性配對碼，再貼到這裡。",
      "deviceTrust.helpConfirmStep": "請檢查裝置資料，再選擇「配對這台裝置」。配對碼只能使用一次，五分鐘後到期。",
      "deviceTrust.manualNote": "手動輸入網址仍使用舊版共用 Web token；一次性配對會建立獨立且可撤銷的憑證。",
      "deviceTrust.inUse": "使用中 · {status}",
      "deviceTrust.statusOnline": "在線",
      "deviceTrust.statusOffline": "離線",
      "deviceTrust.statusNotChecked": "尚未檢查",
      "deviceTrust.savedNotice": "配對碼已產生，請手動複製",
    },
    "zh-Hans": {
      "deviceTrust.pairingNote": "一次性配对会创建独立且可撤销的设备凭证。手动输入网址仍使用旧版共享 Web token 路径。",
      "deviceTrust.authorizedTitle": "已授权设备",
      "deviceTrust.authorizedLoading": "正在加载已授权设备…",
      "deviceTrust.authorizedEmpty": "此设备目前没有获授权的专用对等凭证。",
      "deviceTrust.authorizedUnavailable": "无法获取已授权设备。",
      "deviceTrust.authLocal": "本地",
      "deviceTrust.authDedicated": "专用对等凭证",
      "deviceTrust.authLegacy": "旧版共享 token",
      "deviceTrust.authUnavailable": "信任状态不可用",
      "deviceTrust.remoteAuthorizationError": "“{device}”已离线或不再获得授权。请删除后重新配对。",
      "deviceTrust.dedicatedUrlChange": "无法更改此专用设备的网址。请删除设备后重新配对。",
      "deviceTrust.trustStateUnavailable": "设备信任状态不可用，请修复后再更改网址或配对。",
      "deviceTrust.authorizedOn": "授权于 {date}",
      "deviceTrust.revoke": "撤销",
      "deviceTrust.revokeConfirm": "要撤销“{device}”的访问权限吗？",
      "deviceTrust.revoked": "设备访问权限已撤销",
      "deviceTrust.revokeFailed": "无法撤销设备访问权限",
      "deviceTrust.reviewTitle": "配对确认",
      "deviceTrust.reviewDescription": "连接前请检查设备信息。",
      "deviceTrust.candidate": "设备",
      "deviceTrust.expires": "到期时间 {time}",
      "deviceTrust.version": "配对版本 {version}",
      "deviceTrust.reviewCode": "检查配对码",
      "deviceTrust.confirmPair": "配对此设备",
      "deviceTrust.codeNotice": "配对码将在五分钟后过期，且只能使用一次。",
      "deviceTrust.codeGenerated": "配对码五分钟内有效，请粘贴到另一台 Pi Harbor。",
      "deviceTrust.pasteCode": "请粘贴另一台 Pi Harbor 生成的 PIHARBOR3 配对码。配对前请检查设备信息。",
      "deviceTrust.helpTitle": "如何添加设备",
      "deviceTrust.helpManual": "若要使用旧版连接，请输入另一台 Pi Harbor 的网址并保存。两台设备必须使用相同的 Web token。",
      "deviceTrust.helpPairStep": "若要使用独立访问权限，请在另一台设备的设置中创建一次性配对码，然后粘贴到这里。",
      "deviceTrust.helpConfirmStep": "请检查设备信息，然后选择“配对此设备”。配对码只能使用一次，五分钟后过期。",
      "deviceTrust.manualNote": "手动输入网址仍使用旧版共享 Web token；一次性配对会配置独立且可撤销的凭证。",
      "deviceTrust.inUse": "使用中 · {status}",
      "deviceTrust.statusOnline": "在线",
      "deviceTrust.statusOffline": "离线",
      "deviceTrust.statusNotChecked": "尚未检查",
      "deviceTrust.savedNotice": "配对码已生成，请手动复制",
    },
    ja: {
      "deviceTrust.pairingNote": "ワンタイムペアリングでは、独立して取り消せるデバイス認証情報が作成されます。URL の手動入力は従来どおり共有 Web トークンを使います。",
      "deviceTrust.authorizedTitle": "承認済みデバイス",
      "deviceTrust.authorizedLoading": "承認済みデバイスを読み込み中…",
      "deviceTrust.authorizedEmpty": "このデバイスには専用のピア認証情報が承認されていません。",
      "deviceTrust.authorizedUnavailable": "承認済みデバイスを利用できません。",
      "deviceTrust.authLocal": "ローカル",
      "deviceTrust.authDedicated": "専用ピア",
      "deviceTrust.authLegacy": "従来の共有トークン",
      "deviceTrust.authUnavailable": "信頼情報を利用できません",
      "deviceTrust.remoteAuthorizationError": "「{device}」はオフラインか、認証が取り消されています。削除して再度ペアリングしてください。",
      "deviceTrust.dedicatedUrlChange": "この専用デバイスの URL は変更できません。削除して再度ペアリングしてください。",
      "deviceTrust.trustStateUnavailable": "デバイスの信頼情報を利用できません。URL の変更やペアリングの前に修復してください。",
      "deviceTrust.authorizedOn": "承認日 {date}",
      "deviceTrust.revoke": "取り消す",
      "deviceTrust.revokeConfirm": "「{device}」のアクセスを取り消しますか？",
      "deviceTrust.revoked": "デバイスのアクセスを取り消しました",
      "deviceTrust.revokeFailed": "デバイスのアクセスを取り消せませんでした",
      "deviceTrust.reviewTitle": "ペアリングの確認",
      "deviceTrust.reviewDescription": "接続する前にデバイス情報を確認してください。",
      "deviceTrust.candidate": "デバイス",
      "deviceTrust.expires": "有効期限 {time}",
      "deviceTrust.version": "ペアリングバージョン {version}",
      "deviceTrust.reviewCode": "ペアリングコードを確認",
      "deviceTrust.confirmPair": "このデバイスをペアリング",
      "deviceTrust.codeNotice": "コードは 5 分で期限切れになり、一度だけ使用できます。",
      "deviceTrust.codeGenerated": "ペアリングコードは 5 分間有効です。別の Pi Harbor に貼り付けてください。",
      "deviceTrust.pasteCode": "別の Pi Harbor が生成した PIHARBOR3 コードを貼り付けてください。ペアリング前に情報を確認します。",
      "deviceTrust.helpTitle": "デバイスの追加方法",
      "deviceTrust.helpManual": "従来の接続では、別の Pi Harbor の URL を入力して保存します。両方のデバイスで同じ Web トークンを使います。",
      "deviceTrust.helpPairStep": "独立したアクセスには、もう一方のデバイスの設定でワンタイムコードを作成し、ここに貼り付けます。",
      "deviceTrust.helpConfirmStep": "デバイス情報を確認してから「このデバイスをペアリング」を選びます。コードは一度だけ使え、5 分で期限切れになります。",
      "deviceTrust.manualNote": "URL の手動入力は従来の共有 Web トークンを使います。ワンタイムペアリングでは独立して取り消せる認証情報が作成されます。",
      "deviceTrust.inUse": "使用中 · {status}",
      "deviceTrust.statusOnline": "オンライン",
      "deviceTrust.statusOffline": "オフライン",
      "deviceTrust.statusNotChecked": "未確認",
      "deviceTrust.savedNotice": "ペアリングコードを生成しました。手動でコピーしてください",
    },
    ko: {
      "deviceTrust.pairingNote": "일회용 페어링은 독립적으로 취소할 수 있는 기기 인증 정보를 만듭니다. URL을 수동으로 입력하면 기존 공유 Web 토큰 경로를 사용합니다.",
      "deviceTrust.authorizedTitle": "승인된 기기",
      "deviceTrust.authorizedLoading": "승인된 기기를 불러오는 중…",
      "deviceTrust.authorizedEmpty": "이 기기에는 승인된 전용 피어 인증 정보가 없습니다.",
      "deviceTrust.authorizedUnavailable": "승인된 기기를 사용할 수 없습니다.",
      "deviceTrust.authLocal": "로컬",
      "deviceTrust.authDedicated": "전용 피어",
      "deviceTrust.authLegacy": "기존 공유 토큰",
      "deviceTrust.authUnavailable": "신뢰 정보를 사용할 수 없음",
      "deviceTrust.remoteAuthorizationError": "‘{device}’이(가) 오프라인이거나 더 이상 승인되지 않았습니다. 삭제한 후 다시 페어링하세요.",
      "deviceTrust.dedicatedUrlChange": "이 전용 기기의 URL은 변경할 수 없습니다. 기기를 삭제한 후 다시 페어링하세요.",
      "deviceTrust.trustStateUnavailable": "기기 신뢰 정보를 사용할 수 없습니다. URL을 변경하거나 페어링하기 전에 복구하세요.",
      "deviceTrust.authorizedOn": "승인일 {date}",
      "deviceTrust.revoke": "취소",
      "deviceTrust.revokeConfirm": "‘{device}’의 액세스 권한을 취소할까요?",
      "deviceTrust.revoked": "기기 액세스 권한을 취소했습니다",
      "deviceTrust.revokeFailed": "기기 액세스 권한을 취소할 수 없습니다",
      "deviceTrust.reviewTitle": "페어링 확인",
      "deviceTrust.reviewDescription": "연결하기 전에 기기 정보를 확인하세요.",
      "deviceTrust.candidate": "기기",
      "deviceTrust.expires": "만료 {time}",
      "deviceTrust.version": "페어링 버전 {version}",
      "deviceTrust.reviewCode": "페어링 코드 확인",
      "deviceTrust.confirmPair": "이 기기 페어링",
      "deviceTrust.codeNotice": "코드는 5분 후 만료되며 한 번만 사용할 수 있습니다.",
      "deviceTrust.codeGenerated": "페어링 코드는 5분 동안 유효합니다. 다른 Pi Harbor에 붙여넣으세요.",
      "deviceTrust.pasteCode": "다른 Pi Harbor에서 만든 PIHARBOR3 코드를 붙여넣으세요. 페어링 전에 기기 정보를 확인합니다.",
      "deviceTrust.helpTitle": "기기 추가 방법",
      "deviceTrust.helpManual": "기존 연결을 사용하려면 다른 Pi Harbor URL을 입력하고 저장하세요. 두 기기에서 같은 Web 토큰을 사용해야 합니다.",
      "deviceTrust.helpPairStep": "독립 액세스를 사용하려면 다른 기기의 설정에서 일회용 페어링 코드를 만든 뒤 여기에 붙여넣으세요.",
      "deviceTrust.helpConfirmStep": "기기 정보를 확인한 다음 ‘이 기기 페어링’을 선택하세요. 코드는 한 번만 사용할 수 있고 5분 후 만료됩니다.",
      "deviceTrust.manualNote": "URL을 수동으로 입력하면 기존 공유 Web 토큰을 사용하고, 일회용 페어링은 독립적으로 취소할 수 있는 인증 정보를 발급합니다.",
      "deviceTrust.inUse": "사용 중 · {status}",
      "deviceTrust.statusOnline": "온라인",
      "deviceTrust.statusOffline": "오프라인",
      "deviceTrust.statusNotChecked": "확인하지 않음",
      "deviceTrust.savedNotice": "페어링 코드가 생성되었습니다. 직접 복사하세요",
    },
    tr: {
      "deviceTrust.pairingNote": "Tek kullanımlık eşleştirme bağımsız ve iptal edilebilir bir cihaz kimlik bilgisi oluşturur. URL'yi elle girmek eski paylaşılan Web token yolunu kullanmaya devam eder.",
      "deviceTrust.authorizedTitle": "Yetkili cihazlar",
      "deviceTrust.authorizedLoading": "Yetkili cihazlar yükleniyor…",
      "deviceTrust.authorizedEmpty": "Bu cihazda yetkilendirilmiş özel eş cihaz kimliği yok.",
      "deviceTrust.authorizedUnavailable": "Yetkili cihazlar kullanılamıyor.",
      "deviceTrust.authLocal": "Yerel",
      "deviceTrust.authDedicated": "Özel eş",
      "deviceTrust.authLegacy": "Eski paylaşılan token",
      "deviceTrust.authUnavailable": "Güven bilgisi kullanılamıyor",
      "deviceTrust.remoteAuthorizationError": "{device} çevrimdışı veya artık yetkili değil. Silip yeniden eşleştirin.",
      "deviceTrust.dedicatedUrlChange": "Bu özel cihazın URL'si değiştirilemez. Cihazı silip yeniden eşleştirin.",
      "deviceTrust.trustStateUnavailable": "Cihaz güven bilgisi kullanılamıyor; URL'leri değiştirmeden veya eşleştirmeden önce onarın.",
      "deviceTrust.authorizedOn": "Yetkilendirme: {date}",
      "deviceTrust.revoke": "İptal et",
      "deviceTrust.revokeConfirm": "“{device}” erişimi iptal edilsin mi?",
      "deviceTrust.revoked": "Cihaz erişimi iptal edildi",
      "deviceTrust.revokeFailed": "Cihaz erişimi iptal edilemedi",
      "deviceTrust.reviewTitle": "Eşleştirme incelemesi",
      "deviceTrust.reviewDescription": "Bağlanmadan önce cihaz bilgilerini kontrol edin.",
      "deviceTrust.candidate": "Cihaz",
      "deviceTrust.expires": "Son kullanma: {time}",
      "deviceTrust.version": "Eşleştirme sürümü {version}",
      "deviceTrust.reviewCode": "Eşleştirme kodunu incele",
      "deviceTrust.confirmPair": "Bu cihazı eşleştir",
      "deviceTrust.codeNotice": "Kodlar beş dakika sonra geçersiz olur ve yalnızca bir kez kullanılabilir.",
      "deviceTrust.codeGenerated": "Eşleştirme kodu beş dakika geçerlidir; başka bir Pi Harbor'a yapıştırın.",
      "deviceTrust.pasteCode": "Başka bir Pi Harbor'ın oluşturduğu PIHARBOR3 kodunu yapıştırın. Eşleştirmeden önce cihaz bilgilerini inceleyin.",
      "deviceTrust.helpTitle": "Cihaz ekleme",
      "deviceTrust.helpManual": "Eski bağlantı için diğer Pi Harbor URL'sini girip kaydedin. İki cihaz da aynı Web token'ını kullanmalıdır.",
      "deviceTrust.helpPairStep": "Bağımsız erişim için diğer cihazın Ayarlar bölümünde tek kullanımlık kod oluşturup buraya yapıştırın.",
      "deviceTrust.helpConfirmStep": "Cihaz bilgilerini inceleyin ve ardından “Bu cihazı eşleştir” seçeneğini kullanın. Kod bir kez kullanılır ve beş dakika sonra geçersiz olur.",
      "deviceTrust.manualNote": "URL'yi elle girmek eski paylaşılan Web token yolunu kullanır; tek kullanımlık eşleştirme bağımsız ve iptal edilebilir bir kimlik bilgisi verir.",
      "deviceTrust.inUse": "Kullanılıyor · {status}",
      "deviceTrust.statusOnline": "Çevrimiçi",
      "deviceTrust.statusOffline": "Çevrimdışı",
      "deviceTrust.statusNotChecked": "Kontrol edilmedi",
      "deviceTrust.savedNotice": "Eşleştirme kodu oluşturuldu; elle kopyalayın",
    },
    fr: {
      "deviceTrust.pairingNote": "L’association à usage unique crée un identifiant d’appareil indépendant et révocable. La saisie manuelle d’une URL conserve l’ancien parcours avec jeton Web partagé.",
      "deviceTrust.authorizedTitle": "Appareils autorisés",
      "deviceTrust.authorizedLoading": "Chargement des appareils autorisés…",
      "deviceTrust.authorizedEmpty": "Aucun identifiant de pair dédié n’est autorisé sur cet appareil.",
      "deviceTrust.authorizedUnavailable": "Les appareils autorisés sont indisponibles.",
      "deviceTrust.authLocal": "Local",
      "deviceTrust.authDedicated": "Pair dédié",
      "deviceTrust.authLegacy": "Ancien jeton partagé",
      "deviceTrust.authUnavailable": "Confiance indisponible",
      "deviceTrust.remoteAuthorizationError": "{device} est hors ligne ou n’est plus autorisé. Supprimez-le et associez-le à nouveau.",
      "deviceTrust.dedicatedUrlChange": "L’URL de cet appareil dédié ne peut pas être modifiée. Supprimez l’appareil et associez-le à nouveau.",
      "deviceTrust.trustStateUnavailable": "La confiance de l’appareil est indisponible ; réparez-la avant de modifier une URL ou d’associer un appareil.",
      "deviceTrust.authorizedOn": "Autorisé le {date}",
      "deviceTrust.revoke": "Révoquer",
      "deviceTrust.revokeConfirm": "Révoquer l’accès de « {device} » ?",
      "deviceTrust.revoked": "Accès de l’appareil révoqué",
      "deviceTrust.revokeFailed": "Impossible de révoquer l’accès de l’appareil",
      "deviceTrust.reviewTitle": "Vérification de l’association",
      "deviceTrust.reviewDescription": "Vérifiez les informations avant de vous connecter.",
      "deviceTrust.candidate": "Appareil",
      "deviceTrust.expires": "Expire le {time}",
      "deviceTrust.version": "Version de l’association {version}",
      "deviceTrust.reviewCode": "Vérifier le code d’association",
      "deviceTrust.confirmPair": "Associer cet appareil",
      "deviceTrust.codeNotice": "Les codes expirent après cinq minutes et ne peuvent être utilisés qu’une fois.",
      "deviceTrust.codeGenerated": "Le code est valable cinq minutes ; collez-le dans un autre Pi Harbor.",
      "deviceTrust.pasteCode": "Collez un code PIHARBOR3 créé par un autre Pi Harbor. Vérifiez les informations avant l’association.",
      "deviceTrust.helpTitle": "Comment ajouter un appareil",
      "deviceTrust.helpManual": "Pour une connexion ancienne, saisissez l’URL de l’autre Pi Harbor et enregistrez-la. Les deux appareils doivent utiliser le même jeton Web.",
      "deviceTrust.helpPairStep": "Pour un accès indépendant, créez un code à usage unique dans les réglages de l’autre appareil, puis collez-le ici.",
      "deviceTrust.helpConfirmStep": "Vérifiez les informations, puis choisissez « Associer cet appareil ». Le code est utilisable une fois et expire après cinq minutes.",
      "deviceTrust.manualNote": "La saisie manuelle d’une URL conserve le jeton Web partagé ; l’association à usage unique crée un identifiant indépendant et révocable.",
      "deviceTrust.inUse": "En cours · {status}",
      "deviceTrust.statusOnline": "En ligne",
      "deviceTrust.statusOffline": "Hors ligne",
      "deviceTrust.statusNotChecked": "Non vérifié",
      "deviceTrust.savedNotice": "Code créé ; copiez-le manuellement",
    },
    de: {
      "deviceTrust.pairingNote": "Eine einmalige Kopplung erstellt eine unabhängige, widerrufbare Geräteanmeldung. Die manuelle URL-Eingabe bleibt beim alten Weg mit gemeinsamem Web-Token.",
      "deviceTrust.authorizedTitle": "Autorisierte Geräte",
      "deviceTrust.authorizedLoading": "Autorisierte Geräte werden geladen…",
      "deviceTrust.authorizedEmpty": "Auf diesem Gerät sind keine dedizierten Peer-Anmeldungen autorisiert.",
      "deviceTrust.authorizedUnavailable": "Autorisierte Geräte sind nicht verfügbar.",
      "deviceTrust.authLocal": "Lokal",
      "deviceTrust.authDedicated": "Dedizierter Peer",
      "deviceTrust.authLegacy": "Altes gemeinsames Token",
      "deviceTrust.authUnavailable": "Vertrauensstatus nicht verfügbar",
      "deviceTrust.remoteAuthorizationError": "{device} ist offline oder nicht mehr autorisiert. Löschen Sie das Gerät und koppeln Sie es erneut.",
      "deviceTrust.dedicatedUrlChange": "Die URL dieses dedizierten Geräts kann nicht geändert werden. Löschen Sie es und koppeln Sie es erneut.",
      "deviceTrust.trustStateUnavailable": "Der Gerätevertrauensstatus ist nicht verfügbar. Reparieren Sie ihn, bevor Sie URLs ändern oder koppeln.",
      "deviceTrust.authorizedOn": "Autorisiert am {date}",
      "deviceTrust.revoke": "Widerrufen",
      "deviceTrust.revokeConfirm": "Zugriff für „{device}“ widerrufen?",
      "deviceTrust.revoked": "Gerätezugriff widerrufen",
      "deviceTrust.revokeFailed": "Gerätezugriff konnte nicht widerrufen werden",
      "deviceTrust.reviewTitle": "Kopplung prüfen",
      "deviceTrust.reviewDescription": "Prüfen Sie die Gerätedaten, bevor Sie eine Verbindung herstellen.",
      "deviceTrust.candidate": "Gerät",
      "deviceTrust.expires": "Läuft ab am {time}",
      "deviceTrust.version": "Kopplungsversion {version}",
      "deviceTrust.reviewCode": "Kopplungscode prüfen",
      "deviceTrust.confirmPair": "Dieses Gerät koppeln",
      "deviceTrust.codeNotice": "Codes laufen nach fünf Minuten ab und können nur einmal verwendet werden.",
      "deviceTrust.codeGenerated": "Der Kopplungscode ist fünf Minuten gültig. Fügen Sie ihn in einem anderen Pi Harbor ein.",
      "deviceTrust.pasteCode": "Fügen Sie einen von einem anderen Pi Harbor erstellten PIHARBOR3-Code ein. Prüfen Sie die Daten vor der Kopplung.",
      "deviceTrust.helpTitle": "So fügen Sie ein Gerät hinzu",
      "deviceTrust.helpManual": "Für eine alte Verbindung geben Sie die URL des anderen Pi Harbor ein und speichern sie. Beide Geräte müssen dasselbe Web-Token verwenden.",
      "deviceTrust.helpPairStep": "Für unabhängigen Zugriff erstellen Sie in den Einstellungen des anderen Geräts einen einmaligen Code und fügen ihn hier ein.",
      "deviceTrust.helpConfirmStep": "Prüfen Sie die Gerätedaten und wählen Sie dann „Dieses Gerät koppeln“. Der Code gilt einmalig und läuft nach fünf Minuten ab.",
      "deviceTrust.manualNote": "Die manuelle URL-Eingabe verwendet weiterhin das gemeinsame Web-Token; eine einmalige Kopplung erstellt eine unabhängige, widerrufbare Anmeldung.",
      "deviceTrust.inUse": "In Verwendung · {status}",
      "deviceTrust.statusOnline": "Online",
      "deviceTrust.statusOffline": "Offline",
      "deviceTrust.statusNotChecked": "Nicht geprüft",
      "deviceTrust.savedNotice": "Kopplungscode erstellt; bitte manuell kopieren",
    },
    es: {
      "deviceTrust.pairingNote": "El emparejamiento de un solo uso crea una credencial de dispositivo independiente y revocable. La entrada manual de URL mantiene el antiguo recorrido con token web compartido.",
      "deviceTrust.authorizedTitle": "Dispositivos autorizados",
      "deviceTrust.authorizedLoading": "Cargando dispositivos autorizados…",
      "deviceTrust.authorizedEmpty": "No hay credenciales de par dedicadas autorizadas en este dispositivo.",
      "deviceTrust.authorizedUnavailable": "Los dispositivos autorizados no están disponibles.",
      "deviceTrust.authLocal": "Local",
      "deviceTrust.authDedicated": "Par dedicado",
      "deviceTrust.authLegacy": "Token compartido heredado",
      "deviceTrust.authUnavailable": "Confianza no disponible",
      "deviceTrust.remoteAuthorizationError": "{device} está sin conexión o ya no tiene autorización. Elimínalo y vuelve a emparejarlo.",
      "deviceTrust.dedicatedUrlChange": "No se puede cambiar la URL de este dispositivo dedicado. Elimínalo y vuelve a emparejarlo.",
      "deviceTrust.trustStateUnavailable": "La confianza del dispositivo no está disponible; repárala antes de cambiar URL o emparejar.",
      "deviceTrust.authorizedOn": "Autorizado el {date}",
      "deviceTrust.revoke": "Revocar",
      "deviceTrust.revokeConfirm": "¿Revocar el acceso de «{device}»?",
      "deviceTrust.revoked": "Acceso del dispositivo revocado",
      "deviceTrust.revokeFailed": "No se pudo revocar el acceso del dispositivo",
      "deviceTrust.reviewTitle": "Revisión del emparejamiento",
      "deviceTrust.reviewDescription": "Comprueba los datos del dispositivo antes de conectarte.",
      "deviceTrust.candidate": "Dispositivo",
      "deviceTrust.expires": "Caduca {time}",
      "deviceTrust.version": "Versión del emparejamiento {version}",
      "deviceTrust.reviewCode": "Revisar código de emparejamiento",
      "deviceTrust.confirmPair": "Emparejar este dispositivo",
      "deviceTrust.codeNotice": "Los códigos caducan después de cinco minutos y solo pueden usarse una vez.",
      "deviceTrust.codeGenerated": "El código es válido durante cinco minutos; pégalo en otro Pi Harbor.",
      "deviceTrust.pasteCode": "Pega un código PIHARBOR3 generado por otro Pi Harbor. Revisa los datos antes de emparejar.",
      "deviceTrust.helpTitle": "Cómo añadir un dispositivo",
      "deviceTrust.helpManual": "Para una conexión heredada, introduce la URL del otro Pi Harbor y guárdala. Ambos dispositivos deben usar el mismo token web.",
      "deviceTrust.helpPairStep": "Para un acceso independiente, crea un código de un solo uso en los ajustes del otro dispositivo y pégalo aquí.",
      "deviceTrust.helpConfirmStep": "Revisa los datos del dispositivo y elige «Emparejar este dispositivo». El código se usa una vez y caduca en cinco minutos.",
      "deviceTrust.manualNote": "La entrada manual de URL mantiene el token web compartido; el emparejamiento de un solo uso crea una credencial independiente y revocable.",
      "deviceTrust.inUse": "En uso · {status}",
      "deviceTrust.statusOnline": "En línea",
      "deviceTrust.statusOffline": "Sin conexión",
      "deviceTrust.statusNotChecked": "Sin comprobar",
      "deviceTrust.savedNotice": "Código generado; cópialo manualmente",
    },
    "pt-BR": {
      "deviceTrust.pairingNote": "O pareamento de uso único cria uma credencial de dispositivo independente e revogável. A entrada manual de URL continua usando o caminho antigo com token Web compartilhado.",
      "deviceTrust.authorizedTitle": "Dispositivos autorizados",
      "deviceTrust.authorizedLoading": "Carregando dispositivos autorizados…",
      "deviceTrust.authorizedEmpty": "Nenhuma credencial de par dedicada está autorizada neste dispositivo.",
      "deviceTrust.authorizedUnavailable": "Os dispositivos autorizados estão indisponíveis.",
      "deviceTrust.authLocal": "Local",
      "deviceTrust.authDedicated": "Par dedicado",
      "deviceTrust.authLegacy": "Token compartilhado legado",
      "deviceTrust.authUnavailable": "Confiança indisponível",
      "deviceTrust.remoteAuthorizationError": "{device} está offline ou não tem mais autorização. Exclua e pareie novamente.",
      "deviceTrust.dedicatedUrlChange": "A URL deste dispositivo dedicado não pode ser alterada. Exclua o dispositivo e pareie novamente.",
      "deviceTrust.trustStateUnavailable": "A confiança do dispositivo está indisponível; repare-a antes de alterar URLs ou parear.",
      "deviceTrust.authorizedOn": "Autorizado em {date}",
      "deviceTrust.revoke": "Revogar",
      "deviceTrust.revokeConfirm": "Revogar o acesso de “{device}”?",
      "deviceTrust.revoked": "Acesso do dispositivo revogado",
      "deviceTrust.revokeFailed": "Não foi possível revogar o acesso do dispositivo",
      "deviceTrust.reviewTitle": "Revisão do pareamento",
      "deviceTrust.reviewDescription": "Confira os dados do dispositivo antes de conectar.",
      "deviceTrust.candidate": "Dispositivo",
      "deviceTrust.expires": "Expira em {time}",
      "deviceTrust.version": "Versão do pareamento {version}",
      "deviceTrust.reviewCode": "Revisar código de pareamento",
      "deviceTrust.confirmPair": "Parear este dispositivo",
      "deviceTrust.codeNotice": "Os códigos expiram após cinco minutos e só podem ser usados uma vez.",
      "deviceTrust.codeGenerated": "O código é válido por cinco minutos; cole-o em outro Pi Harbor.",
      "deviceTrust.pasteCode": "Cole um código PIHARBOR3 gerado por outro Pi Harbor. Confira os dados antes de parear.",
      "deviceTrust.helpTitle": "Como adicionar um dispositivo",
      "deviceTrust.helpManual": "Para uma conexão legada, informe a URL do outro Pi Harbor e salve. Os dois dispositivos devem usar o mesmo token Web.",
      "deviceTrust.helpPairStep": "Para acesso independente, crie um código de uso único nas configurações do outro dispositivo e cole-o aqui.",
      "deviceTrust.helpConfirmStep": "Confira os dados e escolha “Parear este dispositivo”. O código é usado uma vez e expira em cinco minutos.",
      "deviceTrust.manualNote": "A entrada manual de URL continua usando o token Web compartilhado; o pareamento de uso único cria uma credencial independente e revogável.",
      "deviceTrust.inUse": "Em uso · {status}",
      "deviceTrust.statusOnline": "Online",
      "deviceTrust.statusOffline": "Offline",
      "deviceTrust.statusNotChecked": "Não verificado",
      "deviceTrust.savedNotice": "Código gerado; copie manualmente",
    },
    it: {
      "deviceTrust.pairingNote": "L’abbinamento una tantum crea una credenziale del dispositivo indipendente e revocabile. L’inserimento manuale dell’URL mantiene il vecchio percorso con token Web condiviso.",
      "deviceTrust.authorizedTitle": "Dispositivi autorizzati",
      "deviceTrust.authorizedLoading": "Caricamento dei dispositivi autorizzati…",
      "deviceTrust.authorizedEmpty": "Nessuna credenziale peer dedicata è autorizzata su questo dispositivo.",
      "deviceTrust.authorizedUnavailable": "I dispositivi autorizzati non sono disponibili.",
      "deviceTrust.authLocal": "Locale",
      "deviceTrust.authDedicated": "Peer dedicato",
      "deviceTrust.authLegacy": "Token condiviso legacy",
      "deviceTrust.authUnavailable": "Attendibilità non disponibile",
      "deviceTrust.remoteAuthorizationError": "{device} è offline o non è più autorizzato. Eliminalo e abbinalo di nuovo.",
      "deviceTrust.dedicatedUrlChange": "L’URL di questo dispositivo dedicato non può essere modificato. Eliminalo e abbinalo di nuovo.",
      "deviceTrust.trustStateUnavailable": "La fiducia del dispositivo non è disponibile; riparala prima di modificare URL o abbinare.",
      "deviceTrust.authorizedOn": "Autorizzato il {date}",
      "deviceTrust.revoke": "Revoca",
      "deviceTrust.revokeConfirm": "Revocare l’accesso di “{device}”?",
      "deviceTrust.revoked": "Accesso del dispositivo revocato",
      "deviceTrust.revokeFailed": "Impossibile revocare l’accesso del dispositivo",
      "deviceTrust.reviewTitle": "Verifica abbinamento",
      "deviceTrust.reviewDescription": "Controlla i dati del dispositivo prima di connetterti.",
      "deviceTrust.candidate": "Dispositivo",
      "deviceTrust.expires": "Scade {time}",
      "deviceTrust.version": "Versione abbinamento {version}",
      "deviceTrust.reviewCode": "Verifica codice di abbinamento",
      "deviceTrust.confirmPair": "Abbina questo dispositivo",
      "deviceTrust.codeNotice": "I codici scadono dopo cinque minuti e possono essere usati una sola volta.",
      "deviceTrust.codeGenerated": "Il codice è valido per cinque minuti; incollalo in un altro Pi Harbor.",
      "deviceTrust.pasteCode": "Incolla un codice PIHARBOR3 generato da un altro Pi Harbor. Controlla i dati prima dell’abbinamento.",
      "deviceTrust.helpTitle": "Come aggiungere un dispositivo",
      "deviceTrust.helpManual": "Per una connessione legacy, inserisci l’URL dell’altro Pi Harbor e salvalo. Entrambi i dispositivi devono usare lo stesso token Web.",
      "deviceTrust.helpPairStep": "Per un accesso indipendente, crea un codice una tantum nelle impostazioni dell’altro dispositivo e incollalo qui.",
      "deviceTrust.helpConfirmStep": "Controlla i dati e scegli “Abbina questo dispositivo”. Il codice si usa una volta e scade dopo cinque minuti.",
      "deviceTrust.manualNote": "L’inserimento manuale dell’URL usa il token Web condiviso; l’abbinamento una tantum crea una credenziale indipendente e revocabile.",
      "deviceTrust.inUse": "In uso · {status}",
      "deviceTrust.statusOnline": "Online",
      "deviceTrust.statusOffline": "Offline",
      "deviceTrust.statusNotChecked": "Non verificato",
      "deviceTrust.savedNotice": "Codice creato; copialo manualmente",
    },
  };
  const KEYED_LABEL_TRANSLATIONS = {
    en: { "deviceTrust.urlLabel": "Pi Harbor URL", "deviceTrust.expiresLabel": "Expires", "deviceTrust.versionLabel": "Pairing version", "usage.title": "Usage · last 7 days" },
    "zh-Hant": { "deviceTrust.urlLabel": "Pi Harbor 網址", "deviceTrust.expiresLabel": "到期時間", "deviceTrust.versionLabel": "配對版本", "usage.title": "用量 · 最近 7 天" },
    "zh-Hans": { "deviceTrust.urlLabel": "Pi Harbor 地址", "deviceTrust.expiresLabel": "到期时间", "deviceTrust.versionLabel": "配对版本", "usage.title": "用量 · 最近 7 天" },
    ja: { "deviceTrust.urlLabel": "Pi Harbor URL", "deviceTrust.expiresLabel": "有効期限", "deviceTrust.versionLabel": "ペアリングバージョン", "usage.title": "使用量 · 過去7日間" },
    ko: { "deviceTrust.urlLabel": "Pi Harbor URL", "deviceTrust.expiresLabel": "만료", "deviceTrust.versionLabel": "페어링 버전", "usage.title": "사용량 · 최근 7일" },
    tr: { "deviceTrust.urlLabel": "Pi Harbor URL'si", "deviceTrust.expiresLabel": "Son kullanma", "deviceTrust.versionLabel": "Eşleştirme sürümü", "usage.title": "Kullanım · son 7 gün" },
    fr: { "deviceTrust.urlLabel": "URL de Pi Harbor", "deviceTrust.expiresLabel": "Expiration", "deviceTrust.versionLabel": "Version de l’association", "usage.title": "Utilisation · 7 derniers jours" },
    de: { "deviceTrust.urlLabel": "Pi-Harbor-URL", "deviceTrust.expiresLabel": "Läuft ab", "deviceTrust.versionLabel": "Kopplungsversion", "usage.title": "Verbrauch · letzte 7 Tage" },
    es: { "deviceTrust.urlLabel": "URL de Pi Harbor", "deviceTrust.expiresLabel": "Caduca", "deviceTrust.versionLabel": "Versión del emparejamiento", "usage.title": "Uso · últimos 7 días" },
    "pt-BR": { "deviceTrust.urlLabel": "URL do Pi Harbor", "deviceTrust.expiresLabel": "Expira", "deviceTrust.versionLabel": "Versão do pareamento", "usage.title": "Uso · últimos 7 dias" },
    it: { "deviceTrust.urlLabel": "URL di Pi Harbor", "deviceTrust.expiresLabel": "Scadenza", "deviceTrust.versionLabel": "Versione abbinamento", "usage.title": "Utilizzo · ultimi 7 giorni" },
  };
  for (const [id, table] of Object.entries(KEYED_LABEL_TRANSLATIONS)) Object.assign(KEYED_TRANSLATIONS[id], table);
  const CONTEXT_DASHBOARD_TRANSLATIONS = {
    en: {
      "contextDashboard.context": "Context",      "contextDashboard.input": "Input", "contextDashboard.output": "Output", "contextDashboard.cacheHit": "Cache hit",
      "contextDashboard.cacheHitPercent": "Hit %", "contextDashboard.cacheWrite": "Cache write",
      "contextDashboard.unavailable": "Unavailable", "contextDashboard.awaiting": "Awaiting response",
      "contextDashboard.details": "Usage details",
      "contextDashboard.cacheWriteNone": "No cache writes reported by this provider",
      "contextDashboard.summary": "Context {used} of {capacity}, {percent}; input {input}; output {output}; cache hit {cacheHit} ({cacheHitPercent}); cache write {cacheWrite}",
    },
    "zh-Hant": {
      "contextDashboard.context": "上下文",      "contextDashboard.input": "輸入", "contextDashboard.output": "輸出", "contextDashboard.cacheHit": "快取命中",
      "contextDashboard.cacheHitPercent": "命中率", "contextDashboard.cacheWrite": "快取寫入",
      "contextDashboard.unavailable": "無法使用", "contextDashboard.awaiting": "等待回應",
      "contextDashboard.details": "用量詳情",
      "contextDashboard.cacheWriteNone": "此服務商未回報快取寫入",
      "contextDashboard.summary": "上下文使用 {used} / {capacity}，{percent}；輸入 {input}；輸出 {output}；快取命中 {cacheHit}（{cacheHitPercent}）；快取寫入 {cacheWrite}",
    },
    "zh-Hans": {
      "contextDashboard.context": "上下文",      "contextDashboard.input": "输入", "contextDashboard.output": "输出", "contextDashboard.cacheHit": "缓存命中",
      "contextDashboard.cacheHitPercent": "命中率", "contextDashboard.cacheWrite": "缓存写入",
      "contextDashboard.unavailable": "无法使用", "contextDashboard.awaiting": "等待响应",
      "contextDashboard.details": "用量详情",
      "contextDashboard.cacheWriteNone": "此服务商未报告缓存写入",
      "contextDashboard.summary": "上下文使用 {used} / {capacity}，{percent}；输入 {input}；输出 {output}；缓存命中 {cacheHit}（{cacheHitPercent}）；缓存写入 {cacheWrite}",
    },
    ja: {
      "contextDashboard.context": "コンテキスト",      "contextDashboard.input": "入力", "contextDashboard.output": "出力", "contextDashboard.cacheHit": "キャッシュヒット",
      "contextDashboard.cacheHitPercent": "ヒット率", "contextDashboard.cacheWrite": "キャッシュ書き込み",
      "contextDashboard.unavailable": "利用不可", "contextDashboard.awaiting": "応答待ち",
      "contextDashboard.details": "使用量の詳細",
      "contextDashboard.cacheWriteNone": "このプロバイダーはキャッシュ書き込みを報告していません",
      "contextDashboard.summary": "コンテキスト {used} / {capacity}、{percent}；入力 {input}；出力 {output}；キャッシュヒット {cacheHit}（{cacheHitPercent}）；キャッシュ書き込み {cacheWrite}",
    },
    ko: {
      "contextDashboard.context": "컨텍스트",      "contextDashboard.input": "입력", "contextDashboard.output": "출력", "contextDashboard.cacheHit": "캐시 적중",
      "contextDashboard.cacheHitPercent": "적중률", "contextDashboard.cacheWrite": "캐시 쓰기",
      "contextDashboard.unavailable": "사용할 수 없음", "contextDashboard.awaiting": "응답 대기 중",
      "contextDashboard.details": "사용량 세부 정보",
      "contextDashboard.cacheWriteNone": "이 공급자는 캐시 쓰기를 보고하지 않습니다",
      "contextDashboard.summary": "컨텍스트 {used} / {capacity}, {percent}; 입력 {input}; 출력 {output}; 캐시 적중 {cacheHit} ({cacheHitPercent}); 캐시 쓰기 {cacheWrite}",
    },
    tr: {
      "contextDashboard.context": "Bağlam",      "contextDashboard.input": "Girdi", "contextDashboard.output": "Çıktı", "contextDashboard.cacheHit": "Önbellek isabeti",
      "contextDashboard.cacheHitPercent": "İsabet %", "contextDashboard.cacheWrite": "Önbellek yazma",
      "contextDashboard.unavailable": "Kullanılamıyor", "contextDashboard.awaiting": "Yanıt bekleniyor",
      "contextDashboard.details": "Kullanım ayrıntıları",
      "contextDashboard.cacheWriteNone": "Bu sağlayıcı önbellek yazmayı raporlamıyor",
      "contextDashboard.summary": "Bağlam {used} / {capacity}, {percent}; girdi {input}; çıktı {output}; önbellek isabeti {cacheHit} ({cacheHitPercent}); önbellek yazma {cacheWrite}",
    },
    fr: {
      "contextDashboard.context": "Contexte",      "contextDashboard.input": "Entrée", "contextDashboard.output": "Sortie", "contextDashboard.cacheHit": "Cache",
      "contextDashboard.cacheHitPercent": "Cache %", "contextDashboard.cacheWrite": "Écriture du cache",
      "contextDashboard.unavailable": "Indisponible", "contextDashboard.awaiting": "En attente de la réponse",
      "contextDashboard.details": "Détails d’utilisation",
      "contextDashboard.cacheWriteNone": "Ce fournisseur ne signale pas d’écritures de cache",
      "contextDashboard.summary": "Contexte {used} sur {capacity}, {percent} ; entrée {input} ; sortie {output} ; cache {cacheHit} ({cacheHitPercent}) ; écriture du cache {cacheWrite}",
    },
    de: {
      "contextDashboard.context": "Kontext",      "contextDashboard.input": "Eingabe", "contextDashboard.output": "Ausgabe", "contextDashboard.cacheHit": "Cache-Treffer",
      "contextDashboard.cacheHitPercent": "Cache-Treffer %", "contextDashboard.cacheWrite": "Cache-Schreibvorgänge",
      "contextDashboard.unavailable": "Nicht verfügbar", "contextDashboard.awaiting": "Warten auf Antwort",
      "contextDashboard.details": "Nutzungsdetails",
      "contextDashboard.cacheWriteNone": "Dieser Anbieter meldet keine Cache-Schreibvorgänge",
      "contextDashboard.summary": "Kontext {used} von {capacity}, {percent}; Eingabe {input}; Ausgabe {output}; Cache-Treffer {cacheHit} ({cacheHitPercent}); Cache-Schreibvorgänge {cacheWrite}",
    },
    es: {
      "contextDashboard.context": "Contexto",      "contextDashboard.input": "Entrada", "contextDashboard.output": "Salida", "contextDashboard.cacheHit": "Aciertos de caché",
      "contextDashboard.cacheHitPercent": "Acierto %", "contextDashboard.cacheWrite": "Escrituras de caché",
      "contextDashboard.unavailable": "No disponible", "contextDashboard.awaiting": "Esperando respuesta",
      "contextDashboard.details": "Detalles de uso",
      "contextDashboard.cacheWriteNone": "Este proveedor no informa de escrituras de caché",
      "contextDashboard.summary": "Contexto {used} de {capacity}, {percent}; entrada {input}; salida {output}; aciertos de caché {cacheHit} ({cacheHitPercent}); escrituras de caché {cacheWrite}",
    },
    "pt-BR": {
      "contextDashboard.context": "Contexto",      "contextDashboard.input": "Entrada", "contextDashboard.output": "Saída", "contextDashboard.cacheHit": "Acerto de cache",
      "contextDashboard.cacheHitPercent": "Acerto %", "contextDashboard.cacheWrite": "Gravações de cache",
      "contextDashboard.unavailable": "Indisponível", "contextDashboard.awaiting": "Aguardando resposta",
      "contextDashboard.details": "Detalhes de uso",
      "contextDashboard.cacheWriteNone": "Este provedor não informa gravações de cache",
      "contextDashboard.summary": "Contexto {used} de {capacity}, {percent}; entrada {input}; saída {output}; acertos de cache {cacheHit} ({cacheHitPercent}); gravações de cache {cacheWrite}",
    },
    it: {
      "contextDashboard.context": "Contesto",      "contextDashboard.input": "Input", "contextDashboard.output": "Output", "contextDashboard.cacheHit": "Cache hit",
      "contextDashboard.cacheHitPercent": "Hit %", "contextDashboard.cacheWrite": "Scritture cache",
      "contextDashboard.unavailable": "Non disponibile", "contextDashboard.awaiting": "In attesa della risposta",
      "contextDashboard.details": "Dettagli utilizzo",
      "contextDashboard.cacheWriteNone": "Questo provider non segnala scritture della cache",
      "contextDashboard.summary": "Contesto {used} su {capacity}, {percent}; input {input}; output {output}; cache hit {cacheHit} ({cacheHitPercent}); scritture cache {cacheWrite}",
    },
  };
  for (const [id, table] of Object.entries(CONTEXT_DASHBOARD_TRANSLATIONS)) Object.assign(KEYED_TRANSLATIONS[id], table);
  const TOKENS_TRANSLATIONS = {
    en: {
      "tokens.title": "Access tokens", "tokens.note": "Issue one token per device or person. Revoking a token ends its access immediately; the installer token always keeps working.",
      "tokens.create": "Create", "tokens.cancel": "Cancel", "tokens.labelPlaceholder": "e.g. MacBook",
      "tokens.showOnce": "Copy this token now — it will not be shown again.", "tokens.done": "Done", "tokens.copy": "Copy",
      "tokens.created": "Created {date}", "tokens.lastUsed": "Last used {date}", "tokens.neverUsed": "Never used",
      "tokens.revoke": "Revoke", "tokens.revokeConfirm": "Revoke \"{label}\"?", "tokens.revoked": "Token revoked",
      "tokens.loading": "Loading tokens…", "tokens.empty": "No extra tokens issued.", "tokens.labelRequired": "Enter a label first",
      "tokens.limit": "Token limit reached (20)", "tokens.error": "Token operation failed", "tokens.copied": "Token copied", "tokens.copyFailed": "Copy failed",
    },
    "zh-Hant": {
      "tokens.title": "存取令牌", "tokens.note": "為每台裝置或每位使用者簽發獨立令牌。撤銷立即生效；安裝時的主令牌始終可用。",
      "tokens.create": "建立", "tokens.cancel": "取消", "tokens.labelPlaceholder": "例如 MacBook",
      "tokens.showOnce": "請立即複製此令牌——之後不會再顯示。", "tokens.done": "完成", "tokens.copy": "複製",
      "tokens.created": "建立於 {date}", "tokens.lastUsed": "最後使用 {date}", "tokens.neverUsed": "從未使用",
      "tokens.revoke": "撤銷", "tokens.revokeConfirm": "要撤銷「{label}」嗎？", "tokens.revoked": "令牌已撤銷",
      "tokens.loading": "正在載入令牌…", "tokens.empty": "尚未簽發額外令牌。", "tokens.labelRequired": "請先填寫名稱",
      "tokens.limit": "已達令牌數量上限（20）", "tokens.error": "令牌操作失敗", "tokens.copied": "令牌已複製", "tokens.copyFailed": "複製失敗",
    },
    "zh-Hans": {
      "tokens.title": "访问令牌", "tokens.note": "为每台设备或每位用户签发独立令牌。撤销立即生效；安装时的主令牌始终可用。",
      "tokens.create": "创建", "tokens.cancel": "取消", "tokens.labelPlaceholder": "例如 MacBook",
      "tokens.showOnce": "请立即复制此令牌——之后不会再显示。", "tokens.done": "完成", "tokens.copy": "复制",
      "tokens.created": "创建于 {date}", "tokens.lastUsed": "最后使用 {date}", "tokens.neverUsed": "从未使用",
      "tokens.revoke": "撤销", "tokens.revokeConfirm": "要撤销“{label}”吗？", "tokens.revoked": "令牌已撤销",
      "tokens.loading": "正在加载令牌…", "tokens.empty": "尚未签发额外令牌。", "tokens.labelRequired": "请先填写名称",
      "tokens.limit": "已达令牌数量上限（20）", "tokens.error": "令牌操作失败", "tokens.copied": "令牌已复制", "tokens.copyFailed": "复制失败",
    },
    ja: {
      "tokens.title": "アクセストークン", "tokens.note": "デバイスや人ごとにトークンを発行できます。取り消すとすぐに無効になり、インストール時のマスタートークンは常に使えます。",
      "tokens.create": "作成", "tokens.cancel": "キャンセル", "tokens.labelPlaceholder": "例: MacBook",
      "tokens.showOnce": "今すぐトークンをコピーしてください——再度表示されません。", "tokens.done": "完了", "tokens.copy": "コピー",
      "tokens.created": "作成 {date}", "tokens.lastUsed": "最終使用 {date}", "tokens.neverUsed": "未使用",
      "tokens.revoke": "取り消す", "tokens.revokeConfirm": "「{label}」を取り消しますか？", "tokens.revoked": "トークンを取り消しました",
      "tokens.loading": "トークンを読み込み中…", "tokens.empty": "追加トークンは発行されていません。", "tokens.labelRequired": "先にラベルを入力してください",
      "tokens.limit": "トークン数の上限に達しました（20）", "tokens.error": "トークン操作に失敗しました", "tokens.copied": "トークンをコピーしました", "tokens.copyFailed": "コピーに失敗しました",
    },
    ko: {
      "tokens.title": "액세스 토큰", "tokens.note": "기기나 사람별로 토큰을 발급하세요. 취소하면 즉시 차단되며, 설치 시의 마스터 토큰은 항상 사용할 수 있습니다.",
      "tokens.create": "만들기", "tokens.cancel": "취소", "tokens.labelPlaceholder": "예: MacBook",
      "tokens.showOnce": "지금 이 토큰을 복사하세요 — 다시 표시되지 않습니다.", "tokens.done": "완료", "tokens.copy": "복사",
      "tokens.created": "생성 {date}", "tokens.lastUsed": "마지막 사용 {date}", "tokens.neverUsed": "사용된 적 없음",
      "tokens.revoke": "취소", "tokens.revokeConfirm": "\"{label}\"을(를) 취소할까요?", "tokens.revoked": "토큰이 취소되었습니다",
      "tokens.loading": "토큰 불러오는 중…", "tokens.empty": "발급된 추가 토큰이 없습니다.", "tokens.labelRequired": "먼저 라벨을 입력하세요",
      "tokens.limit": "토큰 한도에 도달했습니다 (20)", "tokens.error": "토큰 작업 실패", "tokens.copied": "토큰 복사됨", "tokens.copyFailed": "복사 실패",
    },
    tr: {
      "tokens.title": "Erişim anahtarları", "tokens.note": "Her cihaz veya kişi için bir anahtar verin. İptal edilen anahtar anında erişimi kaybeder; kurulum anahtarı her zaman çalışır.",
      "tokens.create": "Oluştur", "tokens.cancel": "İptal", "tokens.labelPlaceholder": "örn. MacBook",
      "tokens.showOnce": "Bu anahtarı şimdi kopyalayın — bir daha gösterilmeyecek.", "tokens.done": "Bitti", "tokens.copy": "Kopyala",
      "tokens.created": "Oluşturuldu {date}", "tokens.lastUsed": "Son kullanım {date}", "tokens.neverUsed": "Hiç kullanılmadı",
      "tokens.revoke": "İptal et", "tokens.revokeConfirm": "\"{label}\" iptal edilsin mi?", "tokens.revoked": "Anahtar iptal edildi",
      "tokens.loading": "Anahtarlar yükleniyor…", "tokens.empty": "Ek anahtar verilmedi.", "tokens.labelRequired": "Önce bir etiket girin",
      "tokens.limit": "Anahtar sınırına ulaşıldı (20)", "tokens.error": "Anahtar işlemi başarısız", "tokens.copied": "Anahtar kopyalandı", "tokens.copyFailed": "Kopyalama başarısız",
    },
    fr: {
      "tokens.title": "Jetons d’accès", "tokens.note": "Émettez un jeton par appareil ou personne. La révocation coupe l’accès immédiatement ; le jeton d’installation reste toujours valide.",
      "tokens.create": "Créer", "tokens.cancel": "Annuler", "tokens.labelPlaceholder": "ex. MacBook",
      "tokens.showOnce": "Copiez ce jeton maintenant — il ne sera plus affiché.", "tokens.done": "Terminé", "tokens.copy": "Copier",
      "tokens.created": "Créé {date}", "tokens.lastUsed": "Dernière utilisation {date}", "tokens.neverUsed": "Jamais utilisé",
      "tokens.revoke": "Révoquer", "tokens.revokeConfirm": "Révoquer « {label} » ?", "tokens.revoked": "Jeton révoqué",
      "tokens.loading": "Chargement des jetons…", "tokens.empty": "Aucun jeton supplémentaire émis.", "tokens.labelRequired": "Saisissez d’abord un libellé",
      "tokens.limit": "Limite de jetons atteinte (20)", "tokens.error": "Échec de l’opération", "tokens.copied": "Jeton copié", "tokens.copyFailed": "Échec de la copie",
    },
    de: {
      "tokens.title": "Zugangs-Token", "tokens.note": "Ein Token pro Gerät oder Person ausstellen. Widerruf wirkt sofort; das Installations-Token bleibt immer gültig.",
      "tokens.create": "Erstellen", "tokens.cancel": "Abbrechen", "tokens.labelPlaceholder": "z. B. MacBook",
      "tokens.showOnce": "Token jetzt kopieren — er wird nicht mehr angezeigt.", "tokens.done": "Fertig", "tokens.copy": "Kopieren",
      "tokens.created": "Erstellt {date}", "tokens.lastUsed": "Zuletzt verwendet {date}", "tokens.neverUsed": "Nie verwendet",
      "tokens.revoke": "Widerrufen", "tokens.revokeConfirm": "„{label}“ widerrufen?", "tokens.revoked": "Token widerrufen",
      "tokens.loading": "Token werden geladen…", "tokens.empty": "Keine zusätzlichen Token ausgestellt.", "tokens.labelRequired": "Bitte zuerst ein Label eingeben",
      "tokens.limit": "Token-Limit erreicht (20)", "tokens.error": "Token-Vorgang fehlgeschlagen", "tokens.copied": "Token kopiert", "tokens.copyFailed": "Kopieren fehlgeschlagen",
    },
    es: {
      "tokens.title": "Tokens de acceso", "tokens.note": "Emite un token por dispositivo o persona. Revocarlo corta el acceso al instante; el token del instalador siempre funciona.",
      "tokens.create": "Crear", "tokens.cancel": "Cancelar", "tokens.labelPlaceholder": "p. ej. MacBook",
      "tokens.showOnce": "Copia este token ahora — no se volverá a mostrar.", "tokens.done": "Hecho", "tokens.copy": "Copiar",
      "tokens.created": "Creado {date}", "tokens.lastUsed": "Último uso {date}", "tokens.neverUsed": "Nunca usado",
      "tokens.revoke": "Revocar", "tokens.revokeConfirm": "¿Revocar «{label}»?", "tokens.revoked": "Token revocado",
      "tokens.loading": "Cargando tokens…", "tokens.empty": "No hay tokens adicionales emitidos.", "tokens.labelRequired": "Escribe primero una etiqueta",
      "tokens.limit": "Límite de tokens alcanzado (20)", "tokens.error": "Error en la operación", "tokens.copied": "Token copiado", "tokens.copyFailed": "Error al copiar",
    },
    "pt-BR": {
      "tokens.title": "Tokens de acesso", "tokens.note": "Emita um token por dispositivo ou pessoa. Revogar corta o acesso imediatamente; o token do instalador sempre funciona.",
      "tokens.create": "Criar", "tokens.cancel": "Cancelar", "tokens.labelPlaceholder": "ex. MacBook",
      "tokens.showOnce": "Copie este token agora — ele não será mostrado novamente.", "tokens.done": "Concluído", "tokens.copy": "Copiar",
      "tokens.created": "Criado {date}", "tokens.lastUsed": "Último uso {date}", "tokens.neverUsed": "Nunca usado",
      "tokens.revoke": "Revogar", "tokens.revokeConfirm": "Revogar “{label}”?", "tokens.revoked": "Token revogado",
      "tokens.loading": "Carregando tokens…", "tokens.empty": "Nenhum token extra emitido.", "tokens.labelRequired": "Digite primeiro um rótulo",
      "tokens.limit": "Limite de tokens atingido (20)", "tokens.error": "Falha na operação", "tokens.copied": "Token copiado", "tokens.copyFailed": "Falha ao copiar",
    },
    it: {
      "tokens.title": "Token di accesso", "tokens.note": "Emetti un token per dispositivo o persona. La revoca interrompe subito l’accesso; il token dell’installazione resta sempre valido.",
      "tokens.create": "Crea", "tokens.cancel": "Annulla", "tokens.labelPlaceholder": "es. MacBook",
      "tokens.showOnce": "Copia subito questo token — non verrà mostrato di nuovo.", "tokens.done": "Fatto", "tokens.copy": "Copia",
      "tokens.created": "Creato {date}", "tokens.lastUsed": "Ultimo uso {date}", "tokens.neverUsed": "Mai usato",
      "tokens.revoke": "Revoca", "tokens.revokeConfirm": "Revocare “{label}”?", "tokens.revoked": "Token revocato",
      "tokens.loading": "Caricamento dei token…", "tokens.empty": "Nessun token aggiuntivo emesso.", "tokens.labelRequired": "Inserisci prima un’etichetta",
      "tokens.limit": "Limite di token raggiunto (20)", "tokens.error": "Operazione non riuscita", "tokens.copied": "Token copiato", "tokens.copyFailed": "Copia non riuscita",
    },
  };
  for (const [id, table] of Object.entries(TOKENS_TRANSLATIONS)) Object.assign(KEYED_TRANSLATIONS[id], table);

  const CHANGES_TRANSLATIONS = {
    en: {
      "changes.title": "Changes", "changes.open": "View project changes", "changes.openCount": "View {count} project changes",
      "changes.refresh": "Refresh changes", "changes.close": "Close changes", "changes.project": "PROJECT", "changes.changedFiles": "Changed files",
      "changes.fileCount": "{count} changed files", "changes.branch": "Branch {branch}", "changes.staged": "Staged", "changes.worktree": "Working tree",
      "changes.loading": "Reading changes…", "changes.unavailable": "Could not read changes", "changes.unavailableDetail": "Git changes are unavailable right now.",
      "changes.notRepository": "Not a Git repository", "changes.notRepositoryDetail": "This project folder is not inside a Git repository.",
      "changes.clean": "No local changes", "changes.cleanDetail": "The working tree matches the latest commit.",
      "changes.selectFile": "Select a file to inspect its diff.", "changes.diffLoading": "Loading diff…", "changes.noDiff": "This file has no text diff to display.",
      "changes.binary": "Binary files do not have a text diff.", "changes.oversized": "This file is too large to display safely.", "changes.truncated": "This diff is long, so only its beginning is shown.",
      "changes.modified": "Modified", "changes.added": "Added", "changes.deleted": "Deleted", "changes.renamed": "Renamed",
      "changes.copied": "Copied", "changes.untracked": "Untracked", "changes.conflicted": "Conflicted",
    },
    "zh-Hant": {
      "changes.title": "變更", "changes.open": "查看專案變更", "changes.openCount": "查看 {count} 個專案變更",
      "changes.refresh": "重新整理變更", "changes.close": "關閉變更", "changes.project": "專案", "changes.changedFiles": "已變更檔案",
      "changes.fileCount": "{count} 個變更檔案", "changes.branch": "分支 {branch}", "changes.staged": "已暫存", "changes.worktree": "工作目錄",
      "changes.loading": "正在讀取變更…", "changes.unavailable": "無法讀取變更", "changes.unavailableDetail": "目前無法取得 Git 變更。",
      "changes.notRepository": "不是 Git 儲存庫", "changes.notRepositoryDetail": "此專案資料夾不在 Git 儲存庫中。",
      "changes.clean": "沒有本機變更", "changes.cleanDetail": "工作目錄與最新提交一致。",
      "changes.selectFile": "選一個檔案查看差異。", "changes.diffLoading": "正在載入差異…", "changes.noDiff": "此檔案沒有可顯示的文字差異。",
      "changes.binary": "二進位檔案無法顯示文字差異。", "changes.oversized": "檔案太大，無法安全顯示差異。", "changes.truncated": "差異過長，僅顯示前段內容。",
      "changes.modified": "修改", "changes.added": "新增", "changes.deleted": "刪除", "changes.renamed": "重新命名",
      "changes.copied": "複製", "changes.untracked": "未追蹤", "changes.conflicted": "衝突",
    },
    "zh-Hans": {
      "changes.title": "更改", "changes.open": "查看项目更改", "changes.openCount": "查看 {count} 个项目更改",
      "changes.refresh": "刷新更改", "changes.close": "关闭更改", "changes.project": "项目", "changes.changedFiles": "已更改文件",
      "changes.fileCount": "{count} 个更改文件", "changes.branch": "分支 {branch}", "changes.staged": "已暂存", "changes.worktree": "工作目录",
      "changes.loading": "正在读取更改…", "changes.unavailable": "无法读取更改", "changes.unavailableDetail": "目前无法获取 Git 更改。",
      "changes.notRepository": "不是 Git 仓库", "changes.notRepositoryDetail": "此项目文件夹不在 Git 仓库中。",
      "changes.clean": "没有本地更改", "changes.cleanDetail": "工作目录与最新提交一致。",
      "changes.selectFile": "选择一个文件查看差异。", "changes.diffLoading": "正在加载差异…", "changes.noDiff": "此文件没有可显示的文本差异。",
      "changes.binary": "二进制文件无法显示文本差异。", "changes.oversized": "文件太大，无法安全显示差异。", "changes.truncated": "差异过长，仅显示开头部分。",
      "changes.modified": "已修改", "changes.added": "已添加", "changes.deleted": "已删除", "changes.renamed": "已重命名",
      "changes.copied": "已复制", "changes.untracked": "未跟踪", "changes.conflicted": "有冲突",
    },
    ja: {
      "changes.title": "変更", "changes.open": "プロジェクトの変更を表示", "changes.openCount": "プロジェクトの変更 {count} 件を表示",
      "changes.refresh": "変更を更新", "changes.close": "変更を閉じる", "changes.project": "プロジェクト", "changes.changedFiles": "変更されたファイル",
      "changes.fileCount": "変更 {count} 件", "changes.branch": "ブランチ {branch}", "changes.staged": "ステージ済み", "changes.worktree": "作業ツリー",
      "changes.loading": "変更を読み込み中…", "changes.unavailable": "変更を読み込めません", "changes.unavailableDetail": "現在 Git の変更を取得できません。",
      "changes.notRepository": "Git リポジトリではありません", "changes.notRepositoryDetail": "このプロジェクトフォルダは Git リポジトリ内にありません。",
      "changes.clean": "ローカルの変更はありません", "changes.cleanDetail": "作業ツリーは最新のコミットと一致しています。",
      "changes.selectFile": "差分を確認するファイルを選択してください。", "changes.diffLoading": "差分を読み込み中…", "changes.noDiff": "表示できるテキスト差分はありません。",
      "changes.binary": "バイナリファイルのテキスト差分は表示できません。", "changes.oversized": "ファイルが大きすぎるため安全に表示できません。", "changes.truncated": "差分が長いため、先頭部分のみ表示しています。",
      "changes.modified": "変更", "changes.added": "追加", "changes.deleted": "削除", "changes.renamed": "名前変更",
      "changes.copied": "コピー", "changes.untracked": "未追跡", "changes.conflicted": "競合",
    },
    ko: {
      "changes.title": "변경 사항", "changes.open": "프로젝트 변경 사항 보기", "changes.openCount": "프로젝트 변경 사항 {count}개 보기",
      "changes.refresh": "변경 사항 새로고침", "changes.close": "변경 사항 닫기", "changes.project": "프로젝트", "changes.changedFiles": "변경된 파일",
      "changes.fileCount": "변경된 파일 {count}개", "changes.branch": "브랜치 {branch}", "changes.staged": "스테이징됨", "changes.worktree": "작업 트리",
      "changes.loading": "변경 사항을 읽는 중…", "changes.unavailable": "변경 사항을 읽을 수 없음", "changes.unavailableDetail": "현재 Git 변경 사항을 가져올 수 없습니다.",
      "changes.notRepository": "Git 저장소가 아님", "changes.notRepositoryDetail": "이 프로젝트 폴더는 Git 저장소 안에 있지 않습니다.",
      "changes.clean": "로컬 변경 사항 없음", "changes.cleanDetail": "작업 트리가 최신 커밋과 일치합니다.",
      "changes.selectFile": "diff를 확인할 파일을 선택하세요.", "changes.diffLoading": "diff 불러오는 중…", "changes.noDiff": "표시할 텍스트 diff가 없습니다.",
      "changes.binary": "바이너리 파일은 텍스트 diff를 표시할 수 없습니다.", "changes.oversized": "파일이 너무 커서 안전하게 표시할 수 없습니다.", "changes.truncated": "diff가 길어 앞부분만 표시합니다.",
      "changes.modified": "수정됨", "changes.added": "추가됨", "changes.deleted": "삭제됨", "changes.renamed": "이름 변경됨",
      "changes.copied": "복사됨", "changes.untracked": "추적되지 않음", "changes.conflicted": "충돌",
    },
    tr: {
      "changes.title": "Değişiklikler", "changes.open": "Proje değişikliklerini görüntüle", "changes.openCount": "{count} proje değişikliğini görüntüle",
      "changes.refresh": "Değişiklikleri yenile", "changes.close": "Değişiklikleri kapat", "changes.project": "PROJE", "changes.changedFiles": "Değişen dosyalar",
      "changes.fileCount": "{count} değişen dosya", "changes.branch": "Dal {branch}", "changes.staged": "Hazırlanmış", "changes.worktree": "Çalışma ağacı",
      "changes.loading": "Değişiklikler okunuyor…", "changes.unavailable": "Değişiklikler okunamadı", "changes.unavailableDetail": "Git değişiklikleri şu anda kullanılamıyor.",
      "changes.notRepository": "Git deposu değil", "changes.notRepositoryDetail": "Bu proje klasörü bir Git deposunun içinde değil.",
      "changes.clean": "Yerel değişiklik yok", "changes.cleanDetail": "Çalışma ağacı son işlemeyle eşleşiyor.",
      "changes.selectFile": "Farkını incelemek için bir dosya seçin.", "changes.diffLoading": "Fark yükleniyor…", "changes.noDiff": "Bu dosya için gösterilecek metin farkı yok.",
      "changes.binary": "İkili dosyaların metin farkı gösterilemez.", "changes.oversized": "Bu dosya güvenle görüntülenemeyecek kadar büyük.", "changes.truncated": "Fark uzun olduğu için yalnızca başlangıcı gösteriliyor.",
      "changes.modified": "Değiştirildi", "changes.added": "Eklendi", "changes.deleted": "Silindi", "changes.renamed": "Yeniden adlandırıldı",
      "changes.copied": "Kopyalandı", "changes.untracked": "İzlenmiyor", "changes.conflicted": "Çakışma",
    },
    fr: {
      "changes.title": "Modifications", "changes.open": "Voir les modifications du projet", "changes.openCount": "Voir {count} modifications du projet",
      "changes.refresh": "Actualiser les modifications", "changes.close": "Fermer les modifications", "changes.project": "PROJET", "changes.changedFiles": "Fichiers modifiés",
      "changes.fileCount": "{count} fichiers modifiés", "changes.branch": "Branche {branch}", "changes.staged": "Indexé", "changes.worktree": "Arbre de travail",
      "changes.loading": "Lecture des modifications…", "changes.unavailable": "Impossible de lire les modifications", "changes.unavailableDetail": "Les modifications Git sont indisponibles pour le moment.",
      "changes.notRepository": "Pas de dépôt Git", "changes.notRepositoryDetail": "Ce dossier de projet ne se trouve pas dans un dépôt Git.",
      "changes.clean": "Aucune modification locale", "changes.cleanDetail": "L’arbre de travail correspond au dernier commit.",
      "changes.selectFile": "Sélectionnez un fichier pour examiner son diff.", "changes.diffLoading": "Chargement du diff…", "changes.noDiff": "Ce fichier n’a aucun diff texte à afficher.",
      "changes.binary": "Les fichiers binaires n’ont pas de diff texte.", "changes.oversized": "Ce fichier est trop volumineux pour être affiché en toute sécurité.", "changes.truncated": "Ce diff est long ; seul son début est affiché.",
      "changes.modified": "Modifié", "changes.added": "Ajouté", "changes.deleted": "Supprimé", "changes.renamed": "Renommé",
      "changes.copied": "Copié", "changes.untracked": "Non suivi", "changes.conflicted": "En conflit",
    },
    de: {
      "changes.title": "Änderungen", "changes.open": "Projektänderungen anzeigen", "changes.openCount": "{count} Projektänderungen anzeigen",
      "changes.refresh": "Änderungen aktualisieren", "changes.close": "Änderungen schließen", "changes.project": "PROJEKT", "changes.changedFiles": "Geänderte Dateien",
      "changes.fileCount": "{count} geänderte Dateien", "changes.branch": "Branch {branch}", "changes.staged": "Vorgemerkt", "changes.worktree": "Arbeitsverzeichnis",
      "changes.loading": "Änderungen werden gelesen…", "changes.unavailable": "Änderungen konnten nicht gelesen werden", "changes.unavailableDetail": "Git-Änderungen sind derzeit nicht verfügbar.",
      "changes.notRepository": "Kein Git-Repository", "changes.notRepositoryDetail": "Dieser Projektordner befindet sich nicht in einem Git-Repository.",
      "changes.clean": "Keine lokalen Änderungen", "changes.cleanDetail": "Das Arbeitsverzeichnis entspricht dem letzten Commit.",
      "changes.selectFile": "Wählen Sie eine Datei aus, um den Diff anzusehen.", "changes.diffLoading": "Diff wird geladen…", "changes.noDiff": "Für diese Datei gibt es keinen anzeigbaren Text-Diff.",
      "changes.binary": "Binärdateien haben keinen Text-Diff.", "changes.oversized": "Diese Datei ist zu groß für eine sichere Anzeige.", "changes.truncated": "Dieser Diff ist lang; nur der Anfang wird angezeigt.",
      "changes.modified": "Geändert", "changes.added": "Hinzugefügt", "changes.deleted": "Gelöscht", "changes.renamed": "Umbenannt",
      "changes.copied": "Kopiert", "changes.untracked": "Nicht verfolgt", "changes.conflicted": "Konflikt",
    },
    es: {
      "changes.title": "Cambios", "changes.open": "Ver cambios del proyecto", "changes.openCount": "Ver {count} cambios del proyecto",
      "changes.refresh": "Actualizar cambios", "changes.close": "Cerrar cambios", "changes.project": "PROYECTO", "changes.changedFiles": "Archivos modificados",
      "changes.fileCount": "{count} archivos modificados", "changes.branch": "Rama {branch}", "changes.staged": "Preparado", "changes.worktree": "Árbol de trabajo",
      "changes.loading": "Leyendo cambios…", "changes.unavailable": "No se pudieron leer los cambios", "changes.unavailableDetail": "Los cambios de Git no están disponibles ahora mismo.",
      "changes.notRepository": "No es un repositorio Git", "changes.notRepositoryDetail": "Esta carpeta de proyecto no está dentro de un repositorio Git.",
      "changes.clean": "No hay cambios locales", "changes.cleanDetail": "El árbol de trabajo coincide con el último commit.",
      "changes.selectFile": "Selecciona un archivo para revisar su diff.", "changes.diffLoading": "Cargando diff…", "changes.noDiff": "Este archivo no tiene un diff de texto que mostrar.",
      "changes.binary": "Los archivos binarios no tienen diff de texto.", "changes.oversized": "Este archivo es demasiado grande para mostrarlo con seguridad.", "changes.truncated": "El diff es largo; solo se muestra el principio.",
      "changes.modified": "Modificado", "changes.added": "Añadido", "changes.deleted": "Eliminado", "changes.renamed": "Renombrado",
      "changes.copied": "Copiado", "changes.untracked": "Sin seguimiento", "changes.conflicted": "En conflicto",
    },
    "pt-BR": {
      "changes.title": "Alterações", "changes.open": "Ver alterações do projeto", "changes.openCount": "Ver {count} alterações do projeto",
      "changes.refresh": "Atualizar alterações", "changes.close": "Fechar alterações", "changes.project": "PROJETO", "changes.changedFiles": "Arquivos alterados",
      "changes.fileCount": "{count} arquivos alterados", "changes.branch": "Branch {branch}", "changes.staged": "Preparado", "changes.worktree": "Árvore de trabalho",
      "changes.loading": "Lendo alterações…", "changes.unavailable": "Não foi possível ler as alterações", "changes.unavailableDetail": "As alterações do Git não estão disponíveis no momento.",
      "changes.notRepository": "Não é um repositório Git", "changes.notRepositoryDetail": "Esta pasta de projeto não está dentro de um repositório Git.",
      "changes.clean": "Nenhuma alteração local", "changes.cleanDetail": "A árvore de trabalho corresponde ao commit mais recente.",
      "changes.selectFile": "Selecione um arquivo para examinar o diff.", "changes.diffLoading": "Carregando diff…", "changes.noDiff": "Este arquivo não tem um diff de texto para exibir.",
      "changes.binary": "Arquivos binários não têm diff de texto.", "changes.oversized": "Este arquivo é grande demais para ser exibido com segurança.", "changes.truncated": "O diff é longo; apenas o início é exibido.",
      "changes.modified": "Alterado", "changes.added": "Adicionado", "changes.deleted": "Excluído", "changes.renamed": "Renomeado",
      "changes.copied": "Copiado", "changes.untracked": "Não rastreado", "changes.conflicted": "Em conflito",
    },
    it: {
      "changes.title": "Modifiche", "changes.open": "Visualizza le modifiche del progetto", "changes.openCount": "Visualizza {count} modifiche del progetto",
      "changes.refresh": "Aggiorna modifiche", "changes.close": "Chiudi modifiche", "changes.project": "PROGETTO", "changes.changedFiles": "File modificati",
      "changes.fileCount": "{count} file modificati", "changes.branch": "Branch {branch}", "changes.staged": "In staging", "changes.worktree": "Albero di lavoro",
      "changes.loading": "Lettura delle modifiche…", "changes.unavailable": "Impossibile leggere le modifiche", "changes.unavailableDetail": "Le modifiche Git non sono disponibili al momento.",
      "changes.notRepository": "Non è un repository Git", "changes.notRepositoryDetail": "Questa cartella di progetto non si trova in un repository Git.",
      "changes.clean": "Nessuna modifica locale", "changes.cleanDetail": "L’albero di lavoro corrisponde all’ultimo commit.",
      "changes.selectFile": "Seleziona un file per esaminarne il diff.", "changes.diffLoading": "Caricamento diff…", "changes.noDiff": "Questo file non ha un diff di testo da mostrare.",
      "changes.binary": "I file binari non hanno un diff di testo.", "changes.oversized": "Questo file è troppo grande per essere visualizzato in sicurezza.", "changes.truncated": "Il diff è lungo; viene mostrato solo l’inizio.",
      "changes.modified": "Modificato", "changes.added": "Aggiunto", "changes.deleted": "Eliminato", "changes.renamed": "Rinominato",
      "changes.copied": "Copiato", "changes.untracked": "Non tracciato", "changes.conflicted": "In conflitto",
    },
  };
  for (const [id, table] of Object.entries(CHANGES_TRANSLATIONS)) Object.assign(KEYED_TRANSLATIONS[id], table);
  const TASK_PROGRESS_TRANSLATIONS = {
    en: {
      "taskProgress.title": "Task progress", "taskProgress.count": "{done} of {total}", "taskProgress.details": "Task details",
      "taskProgress.running": "Running", "taskProgress.completed": "Completed", "taskProgress.current": "Currently working",
      "taskProgress.upNext": "Up next", "taskProgress.expand": "Show task progress", "taskProgress.collapse": "Hide task progress",
    },
    "zh-Hant": {
      "taskProgress.title": "任務進度", "taskProgress.count": "{done} / {total}", "taskProgress.details": "任務詳細資料",
      "taskProgress.running": "執行中", "taskProgress.completed": "已完成", "taskProgress.current": "目前執行",
      "taskProgress.upNext": "下一步", "taskProgress.expand": "顯示任務進度", "taskProgress.collapse": "收起任務進度",
    },
    "zh-Hans": {
      "taskProgress.title": "任务进度", "taskProgress.count": "{done} / {total}", "taskProgress.details": "任务详细信息",
      "taskProgress.running": "执行中", "taskProgress.completed": "已完成", "taskProgress.current": "当前执行",
      "taskProgress.upNext": "下一步", "taskProgress.expand": "显示任务进度", "taskProgress.collapse": "收起任务进度",
    },
    ja: {
      "taskProgress.title": "タスクの進捗", "taskProgress.count": "{done} / {total}", "taskProgress.details": "タスクの詳細",
      "taskProgress.running": "実行中", "taskProgress.completed": "完了", "taskProgress.current": "現在実行中",
      "taskProgress.upNext": "次のタスク", "taskProgress.expand": "タスクの進捗を表示", "taskProgress.collapse": "タスクの進捗を隠す",
    },
    ko: {
      "taskProgress.title": "작업 진행률", "taskProgress.count": "{done} / {total}", "taskProgress.details": "작업 세부 정보",
      "taskProgress.running": "실행 중", "taskProgress.completed": "완료", "taskProgress.current": "현재 작업",
      "taskProgress.upNext": "다음 작업", "taskProgress.expand": "작업 진행률 표시", "taskProgress.collapse": "작업 진행률 숨기기",
    },
    tr: {
      "taskProgress.title": "Görev ilerlemesi", "taskProgress.count": "{done} / {total}", "taskProgress.details": "Görev ayrıntıları",
      "taskProgress.running": "Çalışıyor", "taskProgress.completed": "Tamamlandı", "taskProgress.current": "Şu anda çalışıyor",
      "taskProgress.upNext": "Sıradaki", "taskProgress.expand": "Görev ilerlemesini göster", "taskProgress.collapse": "Görev ilerlemesini gizle",
    },
    fr: {
      "taskProgress.title": "Progression de la tâche", "taskProgress.count": "{done} sur {total}", "taskProgress.details": "Détails de la tâche",
      "taskProgress.running": "En cours", "taskProgress.completed": "Terminé", "taskProgress.current": "Travail en cours",
      "taskProgress.upNext": "À suivre", "taskProgress.expand": "Afficher la progression", "taskProgress.collapse": "Masquer la progression",
    },
    de: {
      "taskProgress.title": "Aufgabenfortschritt", "taskProgress.count": "{done} von {total}", "taskProgress.details": "Aufgabendetails",
      "taskProgress.running": "Wird ausgeführt", "taskProgress.completed": "Abgeschlossen", "taskProgress.current": "Aktuell in Arbeit",
      "taskProgress.upNext": "Als Nächstes", "taskProgress.expand": "Aufgabenfortschritt anzeigen", "taskProgress.collapse": "Aufgabenfortschritt ausblenden",
    },
    es: {
      "taskProgress.title": "Progreso de la tarea", "taskProgress.count": "{done} de {total}", "taskProgress.details": "Detalles de la tarea",
      "taskProgress.running": "En curso", "taskProgress.completed": "Completado", "taskProgress.current": "Trabajando ahora",
      "taskProgress.upNext": "A continuación", "taskProgress.expand": "Mostrar progreso de la tarea", "taskProgress.collapse": "Ocultar progreso de la tarea",
    },
    "pt-BR": {
      "taskProgress.title": "Progresso da tarefa", "taskProgress.count": "{done} de {total}", "taskProgress.details": "Detalhes da tarefa",
      "taskProgress.running": "Em execução", "taskProgress.completed": "Concluído", "taskProgress.current": "Trabalhando agora",
      "taskProgress.upNext": "Próximo", "taskProgress.expand": "Mostrar progresso da tarefa", "taskProgress.collapse": "Ocultar progresso da tarefa",
    },
    it: {
      "taskProgress.title": "Avanzamento attività", "taskProgress.count": "{done} di {total}", "taskProgress.details": "Dettagli attività",
      "taskProgress.running": "In esecuzione", "taskProgress.completed": "Completato", "taskProgress.current": "In lavorazione",
      "taskProgress.upNext": "Prossimo", "taskProgress.expand": "Mostra avanzamento attività", "taskProgress.collapse": "Nascondi avanzamento attività",
    },
  };
  for (const [id, table] of Object.entries(TASK_PROGRESS_TRANSLATIONS)) Object.assign(KEYED_TRANSLATIONS[id], table);

  // Runtime status, retry, and failure messages. These were authored as
  // Traditional Chinese sentences and translated by phrase substitution, which
  // produced broken output such as "Connection，workStill …" in English. They
  // are stable keys now, so every locale gets a real sentence.
  const RUNTIME_TRANSLATIONS = {
    en: {
      "runtime.connectionRetrying": "Connection lost; retrying",
      "runtime.streamRetry": "Live connection dropped; reconnecting in {seconds}s…",
      "runtime.streamRecovering": "Live connection is not responding; reconnecting…",
      "runtime.streamRestored": "Connection restored; the run is still going…",
      "runtime.stillWorking": "Still {activity}… last update {age} ago. If it does not continue, stop and try again.",
      "runtime.retryAttempt": "Connection lost; retrying ({attempt}/{total})",
      "runtime.retryFailed": "Retry failed; check the model or the connection",
      "runtime.retryFailedHint": "Retry failed; check the model or the connection, then use Retry to run it again.",
      "runtime.compactRetrying": "Compaction failed; preparing to retry…",
      "runtime.compactAttempt": "Retrying compaction (attempt {attempt})…",
      "runtime.compactFailed": "Compaction failed. Stop and try again; if it keeps happening, switch model or shorten the conversation.",
      "runtime.compactDone": "Compaction finished; resuming work…",
      "runtime.extensionError": "Extension error: {detail}",
      "runtime.modelRetrying": "The model failed temporarily; preparing to retry: {detail}",
      "runtime.runStopped": "This run was stopped before it produced a complete reply.",
      "runtime.noErrorReason": "Pi did not report a reason. Check the connection or use Retry.",
      "runtime.runStoppedEarly": "The run stopped before its completion event; check the connection or retry.",
      "runtime.messageQueued": "Message queued; it will be sent once the current run finishes.",
      "runtime.messageNotSent": "The message was not sent; your draft is saved",
      "runtime.newChatNeedsMessage": "This conversation is not saved yet; send a message first",
      "runtime.deleteFailed": "Delete failed: {detail}",
      "runtime.renameFailed": "Rename failed: {detail}",
      "runtime.historyFailed": "Could not load history: {detail}",
      "runtime.openChatFailed": "Could not open the conversation: {detail}",
      "runtime.providerReplyFailed": "Could not answer the provider sign-in: {detail}",
      "runtime.piReplyFailed": "Could not answer Pi: {detail}",
      "runtime.loadFailed": "Could not load: {detail}",
      "runtime.switchFailed": "Switch failed: {detail}",
      "runtime.saveFailed": "Could not save: {detail}",
      "runtime.compactCommandFailed": "Compaction failed: {detail}",
      "runtime.thinkingLevel": "Thinking level: {level}",
      "runtime.noMatchingModels": "No models match your search.",
      "runtime.noVisibleModels": "No models are visible; choose models in Settings",
      "runtime.unknownError": "Unknown error",
      "runtime.temporaryFailure": "Temporary failure",
    },
    "zh-Hant": {
      "runtime.connectionRetrying": "連線暫時失敗，正在重試",
      "runtime.streamRetry": "即時連線中斷，{seconds} 秒後自動恢復…",
      "runtime.streamRecovering": "即時連線沒有回應，正在恢復…",
      "runtime.streamRestored": "連線已恢復，工作仍在繼續…",
      "runtime.stillWorking": "仍在{activity}…最後更新於 {age}前；若沒有繼續，可按停止後重試。",
      "runtime.retryAttempt": "連線暫時失敗，正在重試（{attempt}/{total}）",
      "runtime.retryFailed": "重試失敗，請檢查模型或連線",
      "runtime.retryFailedHint": "重試失敗，請檢查模型或連線；可按重試重新執行。",
      "runtime.compactRetrying": "上下文整理暫時失敗，準備重試…",
      "runtime.compactAttempt": "正在重試整理上下文（第 {attempt} 次）…",
      "runtime.compactFailed": "上下文整理失敗，請按停止後重試；若持續發生，請換模型或縮短對話。",
      "runtime.compactDone": "上下文整理完成，正在恢復工作…",
      "runtime.extensionError": "擴充功能錯誤：{detail}",
      "runtime.modelRetrying": "模型暫時失敗，準備重試：{detail}",
      "runtime.runStopped": "這次工作被停止，沒有產生完整回覆。",
      "runtime.noErrorReason": "Pi 沒有提供錯誤原因，請檢查連線或按重試。",
      "runtime.runStoppedEarly": "工作在完成事件前停止；請檢查連線或重試。",
      "runtime.messageQueued": "訊息已排隊，等目前工作完成後會繼續處理。",
      "runtime.messageNotSent": "訊息沒送出去，已保留草稿",
      "runtime.newChatNeedsMessage": "新對話還沒存檔，先講一句話吧",
      "runtime.deleteFailed": "刪除失敗：{detail}",
      "runtime.renameFailed": "重新命名失敗：{detail}",
      "runtime.historyFailed": "載入歷史失敗：{detail}",
      "runtime.openChatFailed": "無法開啟對話：{detail}",
      "runtime.providerReplyFailed": "回覆 Provider 登入失敗：{detail}",
      "runtime.piReplyFailed": "回覆 Pi 失敗：{detail}",
      "runtime.loadFailed": "讀取失敗：{detail}",
      "runtime.switchFailed": "切換失敗：{detail}",
      "runtime.saveFailed": "設定失敗：{detail}",
      "runtime.compactCommandFailed": "壓縮失敗：{detail}",
      "runtime.thinkingLevel": "思考等級：{level}",
      "runtime.noMatchingModels": "找不到符合的模型。",
      "runtime.noVisibleModels": "沒有顯示中的模型，請到設定勾選模型",
      "runtime.unknownError": "未知錯誤",
      "runtime.temporaryFailure": "暫時失敗",
    },
    "zh-Hans": {
      "runtime.connectionRetrying": "连接暂时失败，正在重试",
      "runtime.streamRetry": "实时连接中断，{seconds} 秒后自动恢复…",
      "runtime.streamRecovering": "实时连接没有响应，正在恢复…",
      "runtime.streamRestored": "连接已恢复，工作仍在继续…",
      "runtime.stillWorking": "仍在{activity}…最后更新于 {age}前；若没有继续，可按停止后重试。",
      "runtime.retryAttempt": "连接暂时失败，正在重试（{attempt}/{total}）",
      "runtime.retryFailed": "重试失败，请检查模型或连接",
      "runtime.retryFailedHint": "重试失败，请检查模型或连接；可按重试重新执行。",
      "runtime.compactRetrying": "上下文整理暂时失败，准备重试…",
      "runtime.compactAttempt": "正在重试整理上下文（第 {attempt} 次）…",
      "runtime.compactFailed": "上下文整理失败，请按停止后重试；若持续发生，请换模型或缩短对话。",
      "runtime.compactDone": "上下文整理完成，正在恢复工作…",
      "runtime.extensionError": "扩展错误：{detail}",
      "runtime.modelRetrying": "模型暂时失败，准备重试：{detail}",
      "runtime.runStopped": "这次工作被停止，没有产生完整回复。",
      "runtime.noErrorReason": "Pi 没有提供错误原因，请检查连接或按重试。",
      "runtime.runStoppedEarly": "工作在完成事件前停止；请检查连接或重试。",
      "runtime.messageQueued": "消息已排队，等当前工作完成后会继续处理。",
      "runtime.messageNotSent": "消息没有发送，已保留草稿",
      "runtime.newChatNeedsMessage": "新对话还没保存，先说一句话吧",
      "runtime.deleteFailed": "删除失败：{detail}",
      "runtime.renameFailed": "重命名失败：{detail}",
      "runtime.historyFailed": "加载历史失败：{detail}",
      "runtime.openChatFailed": "无法打开对话：{detail}",
      "runtime.providerReplyFailed": "回复 Provider 登录失败：{detail}",
      "runtime.piReplyFailed": "回复 Pi 失败：{detail}",
      "runtime.loadFailed": "读取失败：{detail}",
      "runtime.switchFailed": "切换失败：{detail}",
      "runtime.saveFailed": "设置失败：{detail}",
      "runtime.compactCommandFailed": "压缩失败：{detail}",
      "runtime.thinkingLevel": "思考等级：{level}",
      "runtime.noMatchingModels": "找不到匹配的模型。",
      "runtime.noVisibleModels": "没有显示中的模型，请到设置勾选模型",
      "runtime.unknownError": "未知错误",
      "runtime.temporaryFailure": "暂时失败",
    },
    ja: {
      "runtime.connectionRetrying": "接続に失敗しました。再試行しています",
      "runtime.streamRetry": "接続が切れました。{seconds} 秒後に再接続します…",
      "runtime.streamRecovering": "接続が応答しません。再接続しています…",
      "runtime.streamRestored": "接続が回復しました。処理は続行中です…",
      "runtime.stillWorking": "{activity}を継続中…最終更新は {age}前です。進まない場合は停止してからやり直してください。",
      "runtime.retryAttempt": "接続に失敗しました。再試行中（{attempt}/{total}）",
      "runtime.retryFailed": "再試行に失敗しました。モデルまたは接続を確認してください",
      "runtime.retryFailedHint": "再試行に失敗しました。モデルまたは接続を確認し、再実行してください。",
      "runtime.compactRetrying": "コンパクションに失敗しました。再試行を準備しています…",
      "runtime.compactAttempt": "コンパクションを再試行しています（{attempt} 回目）…",
      "runtime.compactFailed": "コンパクションに失敗しました。停止してやり直してください。続く場合はモデルを変えるか会話を短くしてください。",
      "runtime.compactDone": "コンパクションが完了しました。作業を再開しています…",
      "runtime.extensionError": "拡張機能のエラー：{detail}",
      "runtime.modelRetrying": "モデルが一時的に失敗しました。再試行します：{detail}",
      "runtime.runStopped": "この実行は完全な返信を生成する前に停止されました。",
      "runtime.noErrorReason": "Pi は理由を返しませんでした。接続を確認するか再試行してください。",
      "runtime.runStoppedEarly": "完了イベントの前に停止しました。接続を確認するか再試行してください。",
      "runtime.messageQueued": "メッセージをキューに追加しました。現在の実行が終わると送信されます。",
      "runtime.messageNotSent": "メッセージは送信されませんでした。下書きは保存されています",
      "runtime.newChatNeedsMessage": "この会話はまだ保存されていません。まずメッセージを送ってください",
      "runtime.deleteFailed": "削除に失敗しました：{detail}",
      "runtime.renameFailed": "名前の変更に失敗しました：{detail}",
      "runtime.historyFailed": "履歴を読み込めませんでした：{detail}",
      "runtime.openChatFailed": "会話を開けませんでした：{detail}",
      "runtime.providerReplyFailed": "プロバイダーのサインインに応答できませんでした：{detail}",
      "runtime.piReplyFailed": "Pi に応答できませんでした：{detail}",
      "runtime.loadFailed": "読み込みに失敗しました：{detail}",
      "runtime.switchFailed": "切り替えに失敗しました：{detail}",
      "runtime.saveFailed": "保存できませんでした：{detail}",
      "runtime.compactCommandFailed": "コンパクションに失敗しました：{detail}",
      "runtime.thinkingLevel": "思考レベル：{level}",
      "runtime.noMatchingModels": "一致するモデルがありません。",
      "runtime.noVisibleModels": "表示中のモデルがありません。設定で選択してください",
      "runtime.unknownError": "不明なエラー",
      "runtime.temporaryFailure": "一時的な失敗",
    },
    ko: {
      "runtime.connectionRetrying": "연결에 실패했습니다. 다시 시도 중",
      "runtime.streamRetry": "실시간 연결이 끊겼습니다. {seconds}초 후 다시 연결합니다…",
      "runtime.streamRecovering": "실시간 연결이 응답하지 않습니다. 복구 중…",
      "runtime.streamRestored": "연결이 복구되었습니다. 작업은 계속 진행 중입니다…",
      "runtime.stillWorking": "{activity} 진행 중… 마지막 업데이트는 {age} 전입니다. 계속되지 않으면 중지 후 다시 시도하세요.",
      "runtime.retryAttempt": "연결에 실패했습니다. 다시 시도 중 ({attempt}/{total})",
      "runtime.retryFailed": "재시도에 실패했습니다. 모델 또는 연결을 확인하세요",
      "runtime.retryFailedHint": "재시도에 실패했습니다. 모델 또는 연결을 확인한 뒤 다시 실행하세요.",
      "runtime.compactRetrying": "컨텍스트 정리에 실패했습니다. 다시 시도를 준비 중…",
      "runtime.compactAttempt": "컨텍스트 정리를 다시 시도합니다 ({attempt}번째)…",
      "runtime.compactFailed": "컨텍스트 정리에 실패했습니다. 중지 후 다시 시도하고, 계속되면 모델을 바꾸거나 대화를 줄이세요.",
      "runtime.compactDone": "컨텍스트 정리가 끝났습니다. 작업을 재개합니다…",
      "runtime.extensionError": "확장 기능 오류: {detail}",
      "runtime.modelRetrying": "모델이 일시적으로 실패했습니다. 다시 시도합니다: {detail}",
      "runtime.runStopped": "이 실행은 완전한 응답을 만들기 전에 중지되었습니다.",
      "runtime.noErrorReason": "Pi가 이유를 알려주지 않았습니다. 연결을 확인하거나 다시 시도하세요.",
      "runtime.runStoppedEarly": "완료 이벤트 전에 중지되었습니다. 연결을 확인하거나 다시 시도하세요.",
      "runtime.messageQueued": "메시지를 대기열에 넣었습니다. 현재 작업이 끝나면 전송됩니다.",
      "runtime.messageNotSent": "메시지를 보내지 못했습니다. 초안은 저장되었습니다",
      "runtime.newChatNeedsMessage": "이 대화는 아직 저장되지 않았습니다. 먼저 메시지를 보내세요",
      "runtime.deleteFailed": "삭제 실패: {detail}",
      "runtime.renameFailed": "이름 변경 실패: {detail}",
      "runtime.historyFailed": "기록을 불러오지 못했습니다: {detail}",
      "runtime.openChatFailed": "대화를 열지 못했습니다: {detail}",
      "runtime.providerReplyFailed": "제공자 로그인에 응답하지 못했습니다: {detail}",
      "runtime.piReplyFailed": "Pi에 응답하지 못했습니다: {detail}",
      "runtime.loadFailed": "불러오지 못했습니다: {detail}",
      "runtime.switchFailed": "전환 실패: {detail}",
      "runtime.saveFailed": "저장하지 못했습니다: {detail}",
      "runtime.compactCommandFailed": "압축 실패: {detail}",
      "runtime.thinkingLevel": "생각 수준: {level}",
      "runtime.noMatchingModels": "일치하는 모델이 없습니다.",
      "runtime.noVisibleModels": "표시 중인 모델이 없습니다. 설정에서 선택하세요",
      "runtime.unknownError": "알 수 없는 오류",
      "runtime.temporaryFailure": "일시적 실패",
    },
    tr: {
      "runtime.connectionRetrying": "Bağlantı koptu; yeniden deneniyor",
      "runtime.streamRetry": "Canlı bağlantı koptu; {seconds} sn içinde yeniden bağlanılıyor…",
      "runtime.streamRecovering": "Canlı bağlantı yanıt vermiyor; yeniden bağlanılıyor…",
      "runtime.streamRestored": "Bağlantı geri geldi; çalışma sürüyor…",
      "runtime.stillWorking": "Hâlâ {activity}… son güncelleme {age} önce. Devam etmiyorsa durdurup yeniden deneyin.",
      "runtime.retryAttempt": "Bağlantı koptu; yeniden deneniyor ({attempt}/{total})",
      "runtime.retryFailed": "Yeniden deneme başarısız; modeli veya bağlantıyı kontrol edin",
      "runtime.retryFailedHint": "Yeniden deneme başarısız; modeli veya bağlantıyı kontrol edip yeniden çalıştırın.",
      "runtime.compactRetrying": "Sıkıştırma başarısız; yeniden denemeye hazırlanılıyor…",
      "runtime.compactAttempt": "Sıkıştırma yeniden deneniyor ({attempt}. deneme)…",
      "runtime.compactFailed": "Sıkıştırma başarısız. Durdurup yeniden deneyin; sürerse modeli değiştirin veya konuşmayı kısaltın.",
      "runtime.compactDone": "Sıkıştırma tamamlandı; çalışmaya devam ediliyor…",
      "runtime.extensionError": "Uzantı hatası: {detail}",
      "runtime.modelRetrying": "Model geçici olarak başarısız oldu; yeniden denenecek: {detail}",
      "runtime.runStopped": "Bu çalışma tam bir yanıt üretmeden durduruldu.",
      "runtime.noErrorReason": "Pi bir neden bildirmedi. Bağlantıyı kontrol edin veya yeniden deneyin.",
      "runtime.runStoppedEarly": "Çalışma tamamlanma olayından önce durdu; bağlantıyı kontrol edin veya yeniden deneyin.",
      "runtime.messageQueued": "Mesaj sıraya alındı; mevcut çalışma bitince gönderilecek.",
      "runtime.messageNotSent": "Mesaj gönderilmedi; taslağınız kaydedildi",
      "runtime.newChatNeedsMessage": "Bu konuşma henüz kaydedilmedi; önce bir mesaj gönderin",
      "runtime.deleteFailed": "Silme başarısız: {detail}",
      "runtime.renameFailed": "Yeniden adlandırma başarısız: {detail}",
      "runtime.historyFailed": "Geçmiş yüklenemedi: {detail}",
      "runtime.openChatFailed": "Konuşma açılamadı: {detail}",
      "runtime.providerReplyFailed": "Sağlayıcı oturum açma yanıtlanamadı: {detail}",
      "runtime.piReplyFailed": "Pi yanıtlanamadı: {detail}",
      "runtime.loadFailed": "Yüklenemedi: {detail}",
      "runtime.switchFailed": "Değiştirilemedi: {detail}",
      "runtime.saveFailed": "Kaydedilemedi: {detail}",
      "runtime.compactCommandFailed": "Sıkıştırma başarısız: {detail}",
      "runtime.thinkingLevel": "Düşünme düzeyi: {level}",
      "runtime.noMatchingModels": "Eşleşen model yok.",
      "runtime.noVisibleModels": "Görünür model yok; Ayarlar'dan model seçin",
      "runtime.unknownError": "Bilinmeyen hata",
      "runtime.temporaryFailure": "Geçici hata",
    },
    fr: {
      "runtime.connectionRetrying": "Connexion perdue ; nouvelle tentative",
      "runtime.streamRetry": "Connexion en direct interrompue ; reconnexion dans {seconds} s…",
      "runtime.streamRecovering": "La connexion en direct ne répond pas ; reconnexion…",
      "runtime.streamRestored": "Connexion rétablie ; le travail continue…",
      "runtime.stillWorking": "Toujours {activity}… dernière mise à jour il y a {age}. Si rien ne bouge, arrêtez puis réessayez.",
      "runtime.retryAttempt": "Connexion perdue ; nouvelle tentative ({attempt}/{total})",
      "runtime.retryFailed": "Échec de la reprise ; vérifiez le modèle ou la connexion",
      "runtime.retryFailedHint": "Échec de la reprise ; vérifiez le modèle ou la connexion, puis relancez.",
      "runtime.compactRetrying": "Échec du compactage ; nouvelle tentative en préparation…",
      "runtime.compactAttempt": "Nouvelle tentative de compactage (essai {attempt})…",
      "runtime.compactFailed": "Échec du compactage. Arrêtez et réessayez ; si cela persiste, changez de modèle ou raccourcissez la conversation.",
      "runtime.compactDone": "Compactage terminé ; reprise du travail…",
      "runtime.extensionError": "Erreur d’extension : {detail}",
      "runtime.modelRetrying": "Le modèle a échoué temporairement ; nouvelle tentative : {detail}",
      "runtime.runStopped": "Cette exécution a été arrêtée avant de produire une réponse complète.",
      "runtime.noErrorReason": "Pi n’a pas indiqué de raison. Vérifiez la connexion ou réessayez.",
      "runtime.runStoppedEarly": "L’exécution s’est arrêtée avant son événement de fin ; vérifiez la connexion ou réessayez.",
      "runtime.messageQueued": "Message mis en file d’attente ; il partira à la fin de l’exécution en cours.",
      "runtime.messageNotSent": "Le message n’a pas été envoyé ; votre brouillon est conservé",
      "runtime.newChatNeedsMessage": "Cette conversation n’est pas encore enregistrée ; envoyez d’abord un message",
      "runtime.deleteFailed": "Échec de la suppression : {detail}",
      "runtime.renameFailed": "Échec du renommage : {detail}",
      "runtime.historyFailed": "Impossible de charger l’historique : {detail}",
      "runtime.openChatFailed": "Impossible d’ouvrir la conversation : {detail}",
      "runtime.providerReplyFailed": "Impossible de répondre à la connexion du fournisseur : {detail}",
      "runtime.piReplyFailed": "Impossible de répondre à Pi : {detail}",
      "runtime.loadFailed": "Chargement impossible : {detail}",
      "runtime.switchFailed": "Changement impossible : {detail}",
      "runtime.saveFailed": "Enregistrement impossible : {detail}",
      "runtime.compactCommandFailed": "Échec du compactage : {detail}",
      "runtime.thinkingLevel": "Niveau de réflexion : {level}",
      "runtime.noMatchingModels": "Aucun modèle ne correspond.",
      "runtime.noVisibleModels": "Aucun modèle visible ; choisissez-en dans les Réglages",
      "runtime.unknownError": "Erreur inconnue",
      "runtime.temporaryFailure": "Échec temporaire",
    },
    de: {
      "runtime.connectionRetrying": "Verbindung verloren; neuer Versuch",
      "runtime.streamRetry": "Live-Verbindung unterbrochen; neuer Versuch in {seconds} s…",
      "runtime.streamRecovering": "Live-Verbindung antwortet nicht; Wiederherstellung läuft…",
      "runtime.streamRestored": "Verbindung wiederhergestellt; die Ausführung läuft weiter…",
      "runtime.stillWorking": "Weiterhin {activity}… letzte Aktualisierung vor {age}. Wenn nichts passiert, stoppen und erneut versuchen.",
      "runtime.retryAttempt": "Verbindung verloren; neuer Versuch ({attempt}/{total})",
      "runtime.retryFailed": "Wiederholung fehlgeschlagen; Modell oder Verbindung prüfen",
      "runtime.retryFailedHint": "Wiederholung fehlgeschlagen; Modell oder Verbindung prüfen und erneut ausführen.",
      "runtime.compactRetrying": "Komprimierung fehlgeschlagen; neuer Versuch wird vorbereitet…",
      "runtime.compactAttempt": "Komprimierung wird wiederholt (Versuch {attempt})…",
      "runtime.compactFailed": "Komprimierung fehlgeschlagen. Stoppen und erneut versuchen; bei Wiederholung Modell wechseln oder Konversation kürzen.",
      "runtime.compactDone": "Komprimierung abgeschlossen; Arbeit wird fortgesetzt…",
      "runtime.extensionError": "Erweiterungsfehler: {detail}",
      "runtime.modelRetrying": "Das Modell ist vorübergehend fehlgeschlagen; neuer Versuch: {detail}",
      "runtime.runStopped": "Dieser Lauf wurde gestoppt, bevor eine vollständige Antwort entstand.",
      "runtime.noErrorReason": "Pi hat keinen Grund gemeldet. Verbindung prüfen oder erneut versuchen.",
      "runtime.runStoppedEarly": "Der Lauf endete vor seinem Abschlussereignis; Verbindung prüfen oder erneut versuchen.",
      "runtime.messageQueued": "Nachricht in der Warteschlange; sie wird nach dem aktuellen Lauf gesendet.",
      "runtime.messageNotSent": "Die Nachricht wurde nicht gesendet; Ihr Entwurf bleibt erhalten",
      "runtime.newChatNeedsMessage": "Diese Konversation ist noch nicht gespeichert; senden Sie zuerst eine Nachricht",
      "runtime.deleteFailed": "Löschen fehlgeschlagen: {detail}",
      "runtime.renameFailed": "Umbenennen fehlgeschlagen: {detail}",
      "runtime.historyFailed": "Verlauf konnte nicht geladen werden: {detail}",
      "runtime.openChatFailed": "Konversation konnte nicht geöffnet werden: {detail}",
      "runtime.providerReplyFailed": "Antwort auf die Anbieter-Anmeldung fehlgeschlagen: {detail}",
      "runtime.piReplyFailed": "Antwort an Pi fehlgeschlagen: {detail}",
      "runtime.loadFailed": "Laden fehlgeschlagen: {detail}",
      "runtime.switchFailed": "Wechsel fehlgeschlagen: {detail}",
      "runtime.saveFailed": "Speichern fehlgeschlagen: {detail}",
      "runtime.compactCommandFailed": "Komprimierung fehlgeschlagen: {detail}",
      "runtime.thinkingLevel": "Denkstufe: {level}",
      "runtime.noMatchingModels": "Keine passenden Modelle.",
      "runtime.noVisibleModels": "Keine sichtbaren Modelle; wählen Sie welche in den Einstellungen",
      "runtime.unknownError": "Unbekannter Fehler",
      "runtime.temporaryFailure": "Vorübergehender Fehler",
    },
    es: {
      "runtime.connectionRetrying": "Conexión perdida; reintentando",
      "runtime.streamRetry": "Conexión en vivo interrumpida; reconectando en {seconds} s…",
      "runtime.streamRecovering": "La conexión en vivo no responde; reconectando…",
      "runtime.streamRestored": "Conexión restablecida; el trabajo continúa…",
      "runtime.stillWorking": "Sigue {activity}… última actualización hace {age}. Si no avanza, detén y vuelve a intentarlo.",
      "runtime.retryAttempt": "Conexión perdida; reintentando ({attempt}/{total})",
      "runtime.retryFailed": "Falló el reintento; revisa el modelo o la conexión",
      "runtime.retryFailedHint": "Falló el reintento; revisa el modelo o la conexión y vuelve a ejecutarlo.",
      "runtime.compactRetrying": "Falló la compactación; preparando otro intento…",
      "runtime.compactAttempt": "Reintentando la compactación (intento {attempt})…",
      "runtime.compactFailed": "Falló la compactación. Detén y reintenta; si continúa, cambia de modelo o acorta la conversación.",
      "runtime.compactDone": "Compactación terminada; reanudando el trabajo…",
      "runtime.extensionError": "Error de extensión: {detail}",
      "runtime.modelRetrying": "El modelo falló temporalmente; se reintentará: {detail}",
      "runtime.runStopped": "Esta ejecución se detuvo antes de producir una respuesta completa.",
      "runtime.noErrorReason": "Pi no informó un motivo. Revisa la conexión o reintenta.",
      "runtime.runStoppedEarly": "La ejecución se detuvo antes de su evento final; revisa la conexión o reintenta.",
      "runtime.messageQueued": "Mensaje en cola; se enviará cuando termine la ejecución actual.",
      "runtime.messageNotSent": "El mensaje no se envió; tu borrador está guardado",
      "runtime.newChatNeedsMessage": "Esta conversación aún no está guardada; envía un mensaje primero",
      "runtime.deleteFailed": "Error al eliminar: {detail}",
      "runtime.renameFailed": "Error al renombrar: {detail}",
      "runtime.historyFailed": "No se pudo cargar el historial: {detail}",
      "runtime.openChatFailed": "No se pudo abrir la conversación: {detail}",
      "runtime.providerReplyFailed": "No se pudo responder al inicio de sesión del proveedor: {detail}",
      "runtime.piReplyFailed": "No se pudo responder a Pi: {detail}",
      "runtime.loadFailed": "No se pudo cargar: {detail}",
      "runtime.switchFailed": "No se pudo cambiar: {detail}",
      "runtime.saveFailed": "No se pudo guardar: {detail}",
      "runtime.compactCommandFailed": "Error al compactar: {detail}",
      "runtime.thinkingLevel": "Nivel de razonamiento: {level}",
      "runtime.noMatchingModels": "Ningún modelo coincide.",
      "runtime.noVisibleModels": "No hay modelos visibles; elígelos en Ajustes",
      "runtime.unknownError": "Error desconocido",
      "runtime.temporaryFailure": "Fallo temporal",
    },
    "pt-BR": {
      "runtime.connectionRetrying": "Conexão perdida; tentando novamente",
      "runtime.streamRetry": "Conexão ao vivo interrompida; reconectando em {seconds} s…",
      "runtime.streamRecovering": "A conexão ao vivo não responde; reconectando…",
      "runtime.streamRestored": "Conexão restabelecida; o trabalho continua…",
      "runtime.stillWorking": "Ainda {activity}… última atualização há {age}. Se não continuar, pare e tente de novo.",
      "runtime.retryAttempt": "Conexão perdida; tentando novamente ({attempt}/{total})",
      "runtime.retryFailed": "A nova tentativa falhou; verifique o modelo ou a conexão",
      "runtime.retryFailedHint": "A nova tentativa falhou; verifique o modelo ou a conexão e execute novamente.",
      "runtime.compactRetrying": "A compactação falhou; preparando nova tentativa…",
      "runtime.compactAttempt": "Tentando compactar novamente (tentativa {attempt})…",
      "runtime.compactFailed": "A compactação falhou. Pare e tente de novo; se persistir, troque de modelo ou encurte a conversa.",
      "runtime.compactDone": "Compactação concluída; retomando o trabalho…",
      "runtime.extensionError": "Erro de extensão: {detail}",
      "runtime.modelRetrying": "O modelo falhou temporariamente; será repetido: {detail}",
      "runtime.runStopped": "Esta execução foi interrompida antes de produzir uma resposta completa.",
      "runtime.noErrorReason": "O Pi não informou um motivo. Verifique a conexão ou tente novamente.",
      "runtime.runStoppedEarly": "A execução parou antes do evento de conclusão; verifique a conexão ou tente novamente.",
      "runtime.messageQueued": "Mensagem na fila; será enviada quando a execução atual terminar.",
      "runtime.messageNotSent": "A mensagem não foi enviada; seu rascunho foi mantido",
      "runtime.newChatNeedsMessage": "Esta conversa ainda não foi salva; envie uma mensagem primeiro",
      "runtime.deleteFailed": "Falha ao excluir: {detail}",
      "runtime.renameFailed": "Falha ao renomear: {detail}",
      "runtime.historyFailed": "Não foi possível carregar o histórico: {detail}",
      "runtime.openChatFailed": "Não foi possível abrir a conversa: {detail}",
      "runtime.providerReplyFailed": "Não foi possível responder ao login do provedor: {detail}",
      "runtime.piReplyFailed": "Não foi possível responder ao Pi: {detail}",
      "runtime.loadFailed": "Falha ao carregar: {detail}",
      "runtime.switchFailed": "Falha ao trocar: {detail}",
      "runtime.saveFailed": "Falha ao salvar: {detail}",
      "runtime.compactCommandFailed": "Falha ao compactar: {detail}",
      "runtime.thinkingLevel": "Nível de raciocínio: {level}",
      "runtime.noMatchingModels": "Nenhum modelo corresponde.",
      "runtime.noVisibleModels": "Nenhum modelo visível; escolha modelos em Configurações",
      "runtime.unknownError": "Erro desconhecido",
      "runtime.temporaryFailure": "Falha temporária",
    },
    it: {
      "runtime.connectionRetrying": "Connessione persa; nuovo tentativo",
      "runtime.streamRetry": "Connessione in tempo reale interrotta; riconnessione tra {seconds} s…",
      "runtime.streamRecovering": "La connessione in tempo reale non risponde; riconnessione…",
      "runtime.streamRestored": "Connessione ripristinata; il lavoro prosegue…",
      "runtime.stillWorking": "Ancora {activity}… ultimo aggiornamento {age} fa. Se non prosegue, ferma e riprova.",
      "runtime.retryAttempt": "Connessione persa; nuovo tentativo ({attempt}/{total})",
      "runtime.retryFailed": "Nuovo tentativo non riuscito; controlla il modello o la connessione",
      "runtime.retryFailedHint": "Nuovo tentativo non riuscito; controlla il modello o la connessione, poi riesegui.",
      "runtime.compactRetrying": "Compattazione non riuscita; preparazione di un nuovo tentativo…",
      "runtime.compactAttempt": "Nuovo tentativo di compattazione (tentativo {attempt})…",
      "runtime.compactFailed": "Compattazione non riuscita. Ferma e riprova; se continua, cambia modello o accorcia la conversazione.",
      "runtime.compactDone": "Compattazione completata; ripresa del lavoro…",
      "runtime.extensionError": "Errore dell’estensione: {detail}",
      "runtime.modelRetrying": "Il modello non ha risposto; nuovo tentativo: {detail}",
      "runtime.runStopped": "Questa esecuzione è stata interrotta prima di produrre una risposta completa.",
      "runtime.noErrorReason": "Pi non ha indicato un motivo. Controlla la connessione o riprova.",
      "runtime.runStoppedEarly": "L’esecuzione si è fermata prima dell’evento di completamento; controlla la connessione o riprova.",
      "runtime.messageQueued": "Messaggio in coda; verrà inviato al termine dell’esecuzione corrente.",
      "runtime.messageNotSent": "Il messaggio non è stato inviato; la bozza è stata conservata",
      "runtime.newChatNeedsMessage": "Questa conversazione non è ancora salvata; invia prima un messaggio",
      "runtime.deleteFailed": "Eliminazione non riuscita: {detail}",
      "runtime.renameFailed": "Rinomina non riuscita: {detail}",
      "runtime.historyFailed": "Impossibile caricare la cronologia: {detail}",
      "runtime.openChatFailed": "Impossibile aprire la conversazione: {detail}",
      "runtime.providerReplyFailed": "Impossibile rispondere all’accesso del provider: {detail}",
      "runtime.piReplyFailed": "Impossibile rispondere a Pi: {detail}",
      "runtime.loadFailed": "Caricamento non riuscito: {detail}",
      "runtime.switchFailed": "Cambio non riuscito: {detail}",
      "runtime.saveFailed": "Salvataggio non riuscito: {detail}",
      "runtime.compactCommandFailed": "Compattazione non riuscita: {detail}",
      "runtime.thinkingLevel": "Livello di ragionamento: {level}",
      "runtime.noMatchingModels": "Nessun modello corrispondente.",
      "runtime.noVisibleModels": "Nessun modello visibile; scegli i modelli nelle Impostazioni",
      "runtime.unknownError": "Errore sconosciuto",
      "runtime.temporaryFailure": "Errore temporaneo",
    },
  };
  for (const [id, table] of Object.entries(RUNTIME_TRANSLATIONS)) Object.assign(KEYED_TRANSLATIONS[id], table);

  // Provider setup and device management. Same reason as RUNTIME_TRANSLATIONS:
  // these were Chinese sentences that phrase substitution could not translate.
  const PROVIDER_DEVICE_TRANSLATIONS = {
    en: {
      "provider.readFailed": "Could not read provider settings: {detail}",
      "provider.localService": "A local service needs no account or API key.",
      "provider.apiKeyNote": "Paste the API key from the service; billing and quota stay with them.",
      "provider.accountNote": "Sign in with the official account or subscription; Pi stores and refreshes the credentials.",
      "provider.added": "{name} added; rescan to refresh the model list.",
      "provider.alreadySignedIn": "{name} is already signed in; choose a method again to update it.",
      "provider.chooseMethod": "Choose a sign-in method to start.",
      "provider.verificationCode": "Verification code: {code}",
      "provider.authTimeout": "The provider sign-in timed out. Start again and paste the redirect URL promptly.",
      "provider.authSuperseded": "Another sign-in replaced this one; keep only a single sign-in window open.",
      "provider.apiKeyLocal": "The {name} API key is stored only on this computer.",
      "provider.addedWithModels": "{name} added; the model list has been updated",
      "provider.apiKeyRequired": "Paste an API key.",
      "provider.apiKeyRejected": "The API key was not saved; check that the region matches the key.",
      "provider.removeAuthConfirm": "Remove the sign-in for “{name}”?\nOnly the local credential is removed; the provider stays.",
      "provider.deleteConfirm": "Remove “{id}” from models.json?\nThe credentials in auth.json are not deleted.",
      "settings.resetConfirm": "Restore the default interface settings? Your sign-in and sessions are not affected.",
      "device.testOk": "Connected: Pi Harbor responded normally.",
      "device.testFailed": "Connection failed. Check Pi Harbor, the port, and the Tailscale/HTTPS address.",
      "device.nameRequired": "Enter a device name.",
      "device.nameAndUrlRequired": "Enter a device name and a Pi Harbor address.",
      "device.portRestartNote": "Settings saved. The new port takes effect after Pi Harbor restarts.",
      "device.nameUpdated": "Device name updated; the port applies after a restart",
      "device.restartConfirm": "Restarting Pi Harbor drops the current browser connection; a running Pi task is given a chance to finish safely. Continue?",
      "device.deleteConfirm": "Delete “{name}”?",
      "sessions.justNow": "Just now",
      "common.undo": "Undo",
      "common.restored": "Restored",
      "sessions.running": "Running",
      "sessions.runningFor": "Running for {elapsed}",
      "sessions.runStuck": "Stuck",
    },
    "zh-Hant": {
      "provider.readFailed": "Provider 設定讀取失敗：{detail}",
      "provider.localService": "本機服務直接使用，不需要帳號或 API key。",
      "provider.apiKeyNote": "貼上服務提供的 API key，費用與額度由服務商管理。",
      "provider.accountNote": "使用官方帳號或訂閱登入，Pi 會自動保存並更新憑證。",
      "provider.added": "{name} 已加入；重新掃描可以更新模型清單。",
      "provider.alreadySignedIn": "{name} 已有登入設定；重新選擇登入方式即可更新。",
      "provider.chooseMethod": "選一種登入方式開始。",
      "provider.verificationCode": "驗證碼：{code}",
      "provider.authTimeout": "Provider 登入等待逾時，請重新開始並盡快貼上重新導向網址",
      "provider.authSuperseded": "這次 Provider 登入已被另一個登入嘗試取代，請只保留一個登入視窗",
      "provider.apiKeyLocal": "{name} 的 API key 只會儲存在這台電腦。",
      "provider.addedWithModels": "{name} 已加入，模型清單已更新",
      "provider.apiKeyRequired": "請貼上 API key。",
      "provider.apiKeyRejected": "API key 尚未儲存，請確認區域與 key 是否相符。",
      "provider.removeAuthConfirm": "確定移除「{name}」的登入設定？\n只會移除本機憑證，不會刪除 Provider。",
      "provider.deleteConfirm": "確定從 models.json 移除「{id}」？\n不會刪除 auth.json 的登入憑證。",
      "settings.resetConfirm": "要恢復介面預設設定嗎？登入狀態與 session 不會受到影響。",
      "device.testOk": "連線成功，Pi Harbor 正常回應。",
      "device.testFailed": "連線失敗；請確認 Pi Harbor、port 與 Tailscale／HTTPS 網址。",
      "device.nameRequired": "請填寫設備名稱。",
      "device.nameAndUrlRequired": "請填寫設備名稱與 Pi Harbor 網址。",
      "device.portRestartNote": "設定已保存；新的 port 需要重新啟動 Pi Harbor 後才會生效。",
      "device.nameUpdated": "設備名稱已更新；port 等待重啟後生效",
      "device.restartConfirm": "重新啟動 Pi Harbor 會中斷目前的瀏覽連線；正在執行的 Pi 工作會先嘗試安全收尾。要繼續嗎？",
      "device.deleteConfirm": "確定要刪除「{name}」嗎？",
      "sessions.justNow": "剛剛",
      "common.undo": "復原",
      "common.restored": "已還原",
      "sessions.running": "執行中",
      "sessions.runningFor": "已執行 {elapsed}",
      "sessions.runStuck": "卡住了",
    },
    "zh-Hans": {
      "provider.readFailed": "Provider 设置读取失败：{detail}",
      "provider.localService": "本机服务直接使用，不需要账号或 API key。",
      "provider.apiKeyNote": "粘贴服务提供的 API key，费用与额度由服务商管理。",
      "provider.accountNote": "使用官方账号或订阅登录，Pi 会自动保存并更新凭证。",
      "provider.added": "{name} 已添加；重新扫描可以更新模型列表。",
      "provider.alreadySignedIn": "{name} 已有登录设置；重新选择登录方式即可更新。",
      "provider.chooseMethod": "选一种登录方式开始。",
      "provider.verificationCode": "验证码：{code}",
      "provider.authTimeout": "Provider 登录等待超时，请重新开始并尽快粘贴重定向网址",
      "provider.authSuperseded": "这次 Provider 登录已被另一个登录尝试取代，请只保留一个登录窗口",
      "provider.apiKeyLocal": "{name} 的 API key 只会保存在这台电脑。",
      "provider.addedWithModels": "{name} 已添加，模型列表已更新",
      "provider.apiKeyRequired": "请粘贴 API key。",
      "provider.apiKeyRejected": "API key 尚未保存，请确认区域与 key 是否匹配。",
      "provider.removeAuthConfirm": "确定移除“{name}”的登录设置？\n只会移除本机凭证，不会删除 Provider。",
      "provider.deleteConfirm": "确定从 models.json 移除“{id}”？\n不会删除 auth.json 的登录凭证。",
      "settings.resetConfirm": "要恢复界面默认设置吗？登录状态与 session 不会受到影响。",
      "device.testOk": "连接成功，Pi Harbor 正常响应。",
      "device.testFailed": "连接失败；请确认 Pi Harbor、端口与 Tailscale／HTTPS 网址。",
      "device.nameRequired": "请填写设备名称。",
      "device.nameAndUrlRequired": "请填写设备名称与 Pi Harbor 网址。",
      "device.portRestartNote": "设置已保存；新的端口需要重新启动 Pi Harbor 后才会生效。",
      "device.nameUpdated": "设备名称已更新；端口等待重启后生效",
      "device.restartConfirm": "重新启动 Pi Harbor 会中断当前的浏览连接；正在执行的 Pi 工作会先尝试安全收尾。要继续吗？",
      "device.deleteConfirm": "确定要删除“{name}”吗？",
      "sessions.justNow": "刚刚",
      "common.undo": "撤销",
      "common.restored": "已恢复",
      "sessions.running": "运行中",
      "sessions.runningFor": "已运行 {elapsed}",
      "sessions.runStuck": "卡住了",
    },
    ja: {
      "provider.readFailed": "プロバイダー設定を読み込めませんでした：{detail}",
      "provider.localService": "ローカルサービスにはアカウントも API キーも不要です。",
      "provider.apiKeyNote": "サービスの API キーを貼り付けてください。料金と上限は提供元が管理します。",
      "provider.accountNote": "公式アカウントまたはサブスクリプションでサインインすると、Pi が資格情報を保存・更新します。",
      "provider.added": "{name} を追加しました。再スキャンでモデル一覧を更新できます。",
      "provider.alreadySignedIn": "{name} はすでにサインイン済みです。方法を選び直すと更新できます。",
      "provider.chooseMethod": "サインイン方法を選んでください。",
      "provider.verificationCode": "確認コード：{code}",
      "provider.authTimeout": "プロバイダーのサインインがタイムアウトしました。やり直して、リダイレクト URL を早めに貼り付けてください",
      "provider.authSuperseded": "別のサインインに置き換えられました。サインイン画面は一つだけ開いてください",
      "provider.apiKeyLocal": "{name} の API キーはこのコンピュータにのみ保存されます。",
      "provider.addedWithModels": "{name} を追加し、モデル一覧を更新しました",
      "provider.apiKeyRequired": "API キーを貼り付けてください。",
      "provider.apiKeyRejected": "API キーは保存されていません。リージョンとキーが一致しているか確認してください。",
      "provider.removeAuthConfirm": "「{name}」のサインインを削除しますか？\nローカルの資格情報のみ削除され、プロバイダーは残ります。",
      "provider.deleteConfirm": "models.json から「{id}」を削除しますか？\nauth.json の資格情報は削除されません。",
      "settings.resetConfirm": "インターフェイス設定を既定に戻しますか？サインインとセッションには影響しません。",
      "device.testOk": "接続できました。Pi Harbor は正常に応答しています。",
      "device.testFailed": "接続に失敗しました。Pi Harbor、ポート、Tailscale／HTTPS のアドレスを確認してください。",
      "device.nameRequired": "デバイス名を入力してください。",
      "device.nameAndUrlRequired": "デバイス名と Pi Harbor のアドレスを入力してください。",
      "device.portRestartNote": "設定を保存しました。新しいポートは Pi Harbor の再起動後に有効になります。",
      "device.nameUpdated": "デバイス名を更新しました。ポートは再起動後に適用されます",
      "device.restartConfirm": "Pi Harbor を再起動すると現在のブラウザ接続が切れます。実行中の Pi の処理は安全に終了を試みます。続けますか？",
      "device.deleteConfirm": "「{name}」を削除しますか？",
      "sessions.justNow": "たった今",
      "common.undo": "元に戻す",
      "common.restored": "復元しました",
      "sessions.running": "実行中",
      "sessions.runningFor": "実行時間 {elapsed}",
      "sessions.runStuck": "停止中",
    },
    ko: {
      "provider.readFailed": "제공자 설정을 읽지 못했습니다: {detail}",
      "provider.localService": "로컬 서비스는 계정이나 API 키가 필요 없습니다.",
      "provider.apiKeyNote": "서비스의 API 키를 붙여넣으세요. 요금과 한도는 제공자가 관리합니다.",
      "provider.accountNote": "공식 계정이나 구독으로 로그인하면 Pi가 자격 증명을 저장하고 갱신합니다.",
      "provider.added": "{name}을(를) 추가했습니다. 다시 검색하면 모델 목록이 갱신됩니다.",
      "provider.alreadySignedIn": "{name}은(는) 이미 로그인되어 있습니다. 방법을 다시 선택하면 갱신됩니다.",
      "provider.chooseMethod": "로그인 방법을 선택하세요.",
      "provider.verificationCode": "인증 코드: {code}",
      "provider.authTimeout": "제공자 로그인이 시간 초과되었습니다. 다시 시작하고 리디렉션 URL을 빠르게 붙여넣으세요",
      "provider.authSuperseded": "다른 로그인이 이 로그인을 대체했습니다. 로그인 창은 하나만 여세요",
      "provider.apiKeyLocal": "{name}의 API 키는 이 컴퓨터에만 저장됩니다.",
      "provider.addedWithModels": "{name}을(를) 추가했고 모델 목록을 갱신했습니다",
      "provider.apiKeyRequired": "API 키를 붙여넣으세요.",
      "provider.apiKeyRejected": "API 키가 저장되지 않았습니다. 지역과 키가 일치하는지 확인하세요.",
      "provider.removeAuthConfirm": "“{name}”의 로그인을 제거할까요?\n로컬 자격 증명만 제거되고 제공자는 남습니다.",
      "provider.deleteConfirm": "models.json에서 “{id}”을(를) 제거할까요?\nauth.json의 자격 증명은 삭제되지 않습니다.",
      "settings.resetConfirm": "인터페이스 설정을 기본값으로 되돌릴까요? 로그인과 세션에는 영향이 없습니다.",
      "device.testOk": "연결됨: Pi Harbor가 정상 응답했습니다.",
      "device.testFailed": "연결에 실패했습니다. Pi Harbor, 포트, Tailscale/HTTPS 주소를 확인하세요.",
      "device.nameRequired": "기기 이름을 입력하세요.",
      "device.nameAndUrlRequired": "기기 이름과 Pi Harbor 주소를 입력하세요.",
      "device.portRestartNote": "설정을 저장했습니다. 새 포트는 Pi Harbor 재시작 후 적용됩니다.",
      "device.nameUpdated": "기기 이름을 변경했습니다. 포트는 재시작 후 적용됩니다",
      "device.restartConfirm": "Pi Harbor를 재시작하면 현재 브라우저 연결이 끊깁니다. 실행 중인 Pi 작업은 안전하게 마무리를 시도합니다. 계속할까요?",
      "device.deleteConfirm": "“{name}”을(를) 삭제할까요?",
      "sessions.justNow": "방금 전",
      "common.undo": "실행 취소",
      "common.restored": "복원됨",
      "sessions.running": "실행 중",
      "sessions.runningFor": "{elapsed} 실행 중",
      "sessions.runStuck": "멈춤",
    },
    tr: {
      "provider.readFailed": "Sağlayıcı ayarları okunamadı: {detail}",
      "provider.localService": "Yerel bir servis için hesap veya API anahtarı gerekmez.",
      "provider.apiKeyNote": "Servisin API anahtarını yapıştırın; ücret ve kota sağlayıcıda kalır.",
      "provider.accountNote": "Resmî hesap veya abonelikle oturum açın; Pi kimlik bilgilerini saklar ve yeniler.",
      "provider.added": "{name} eklendi; model listesini yenilemek için yeniden tarayın.",
      "provider.alreadySignedIn": "{name} zaten oturum açmış; güncellemek için bir yöntem seçin.",
      "provider.chooseMethod": "Başlamak için bir oturum açma yöntemi seçin.",
      "provider.verificationCode": "Doğrulama kodu: {code}",
      "provider.authTimeout": "Sağlayıcı oturum açma zaman aşımına uğradı. Yeniden başlatıp yönlendirme URL sini hızlıca yapıştırın",
      "provider.authSuperseded": "Bu oturum açma başka biriyle değiştirildi; yalnızca tek bir pencere açık tutun",
      "provider.apiKeyLocal": "{name} API anahtarı yalnızca bu bilgisayarda saklanır.",
      "provider.addedWithModels": "{name} eklendi; model listesi güncellendi",
      "provider.apiKeyRequired": "Bir API anahtarı yapıştırın.",
      "provider.apiKeyRejected": "API anahtarı kaydedilmedi; bölge ile anahtarın eşleştiğini kontrol edin.",
      "provider.removeAuthConfirm": "“{name}” oturumu kaldırılsın mı?\nYalnızca yerel kimlik bilgisi silinir, sağlayıcı kalır.",
      "provider.deleteConfirm": "“{id}” models.json dosyasından kaldırılsın mı?\nauth.json içindeki kimlik bilgileri silinmez.",
      "settings.resetConfirm": "Arayüz ayarları varsayılana döndürülsün mü? Oturumunuz ve konuşmalarınız etkilenmez.",
      "device.testOk": "Bağlandı: Pi Harbor normal yanıt verdi.",
      "device.testFailed": "Bağlantı başarısız. Pi Harbor u, bağlantı noktasını ve Tailscale/HTTPS adresini kontrol edin.",
      "device.nameRequired": "Bir cihaz adı girin.",
      "device.nameAndUrlRequired": "Cihaz adı ve Pi Harbor adresi girin.",
      "device.portRestartNote": "Ayarlar kaydedildi. Yeni bağlantı noktası Pi Harbor yeniden başlatılınca geçerli olur.",
      "device.nameUpdated": "Cihaz adı güncellendi; bağlantı noktası yeniden başlatmadan sonra geçerli olur",
      "device.restartConfirm": "Pi Harbor u yeniden başlatmak mevcut tarayıcı bağlantısını keser; çalışan Pi işi güvenle bitmeye çalışır. Devam edilsin mi?",
      "device.deleteConfirm": "“{name}” silinsin mi?",
      "sessions.justNow": "Şimdi",
      "common.undo": "Geri al",
      "common.restored": "Geri getirildi",
      "sessions.running": "Çalışıyor",
      "sessions.runningFor": "{elapsed} çalışıyor",
      "sessions.runStuck": "Takıldı",
    },
    fr: {
      "provider.readFailed": "Impossible de lire les réglages du fournisseur : {detail}",
      "provider.localService": "Un service local ne demande ni compte ni clé API.",
      "provider.apiKeyNote": "Collez la clé API du service ; la facturation et les quotas restent chez lui.",
      "provider.accountNote": "Connectez-vous avec le compte ou l abonnement officiel ; Pi conserve et renouvelle les identifiants.",
      "provider.added": "{name} ajouté ; relancez l analyse pour actualiser la liste des modèles.",
      "provider.alreadySignedIn": "{name} est déjà connecté ; choisissez à nouveau une méthode pour le mettre à jour.",
      "provider.chooseMethod": "Choisissez une méthode de connexion pour commencer.",
      "provider.verificationCode": "Code de vérification : {code}",
      "provider.authTimeout": "La connexion au fournisseur a expiré. Recommencez et collez rapidement l URL de redirection",
      "provider.authSuperseded": "Une autre connexion a remplacé celle-ci ; ne gardez qu une seule fenêtre ouverte",
      "provider.apiKeyLocal": "La clé API {name} est conservée uniquement sur cet ordinateur.",
      "provider.addedWithModels": "{name} ajouté ; la liste des modèles a été mise à jour",
      "provider.apiKeyRequired": "Collez une clé API.",
      "provider.apiKeyRejected": "La clé API n a pas été enregistrée ; vérifiez que la région correspond à la clé.",
      "provider.removeAuthConfirm": "Supprimer la connexion de « {name} » ?\nSeul l identifiant local est supprimé ; le fournisseur reste.",
      "provider.deleteConfirm": "Retirer « {id} » de models.json ?\nLes identifiants d auth.json ne sont pas supprimés.",
      "settings.resetConfirm": "Restaurer les réglages d interface par défaut ? Votre connexion et vos sessions ne sont pas touchées.",
      "device.testOk": "Connecté : Pi Harbor a répondu normalement.",
      "device.testFailed": "Échec de la connexion. Vérifiez Pi Harbor, le port et l adresse Tailscale/HTTPS.",
      "device.nameRequired": "Saisissez un nom d appareil.",
      "device.nameAndUrlRequired": "Saisissez un nom d appareil et une adresse Pi Harbor.",
      "device.portRestartNote": "Réglages enregistrés. Le nouveau port s applique après le redémarrage de Pi Harbor.",
      "device.nameUpdated": "Nom de l appareil mis à jour ; le port s applique après un redémarrage",
      "device.restartConfirm": "Redémarrer Pi Harbor coupe la connexion actuelle du navigateur ; une tâche Pi en cours tente de se terminer proprement. Continuer ?",
      "device.deleteConfirm": "Supprimer « {name} » ?",
      "sessions.justNow": "À l’instant",
      "common.undo": "Annuler",
      "common.restored": "Restauré",
      "sessions.running": "En cours",
      "sessions.runningFor": "En cours depuis {elapsed}",
      "sessions.runStuck": "Bloqué",
    },
    de: {
      "provider.readFailed": "Anbietereinstellungen konnten nicht gelesen werden: {detail}",
      "provider.localService": "Ein lokaler Dienst braucht weder Konto noch API-Schlüssel.",
      "provider.apiKeyNote": "Fügen Sie den API-Schlüssel des Dienstes ein; Abrechnung und Kontingent bleiben dort.",
      "provider.accountNote": "Melden Sie sich mit dem offiziellen Konto oder Abo an; Pi speichert und erneuert die Zugangsdaten.",
      "provider.added": "{name} hinzugefügt; erneut scannen, um die Modellliste zu aktualisieren.",
      "provider.alreadySignedIn": "{name} ist bereits angemeldet; wählen Sie erneut eine Methode, um sie zu aktualisieren.",
      "provider.chooseMethod": "Wählen Sie eine Anmeldemethode.",
      "provider.verificationCode": "Bestätigungscode: {code}",
      "provider.authTimeout": "Die Anbieter-Anmeldung ist abgelaufen. Starten Sie neu und fügen Sie die Weiterleitungs-URL zügig ein",
      "provider.authSuperseded": "Eine andere Anmeldung hat diese ersetzt; lassen Sie nur ein Fenster offen",
      "provider.apiKeyLocal": "Der API-Schlüssel für {name} wird nur auf diesem Computer gespeichert.",
      "provider.addedWithModels": "{name} hinzugefügt; die Modellliste wurde aktualisiert",
      "provider.apiKeyRequired": "Fügen Sie einen API-Schlüssel ein.",
      "provider.apiKeyRejected": "Der API-Schlüssel wurde nicht gespeichert; prüfen Sie, ob Region und Schlüssel zusammenpassen.",
      "provider.removeAuthConfirm": "Anmeldung für „{name}“ entfernen?\nNur die lokalen Zugangsdaten werden entfernt; der Anbieter bleibt.",
      "provider.deleteConfirm": "„{id}“ aus models.json entfernen?\nDie Zugangsdaten in auth.json bleiben erhalten.",
      "settings.resetConfirm": "Standardeinstellungen der Oberfläche wiederherstellen? Anmeldung und Sitzungen bleiben unberührt.",
      "device.testOk": "Verbunden: Pi Harbor hat normal geantwortet.",
      "device.testFailed": "Verbindung fehlgeschlagen. Prüfen Sie Pi Harbor, den Port und die Tailscale/HTTPS-Adresse.",
      "device.nameRequired": "Geben Sie einen Gerätenamen ein.",
      "device.nameAndUrlRequired": "Geben Sie einen Gerätenamen und eine Pi-Harbor-Adresse ein.",
      "device.portRestartNote": "Einstellungen gespeichert. Der neue Port gilt nach einem Neustart von Pi Harbor.",
      "device.nameUpdated": "Gerätename aktualisiert; der Port gilt nach einem Neustart",
      "device.restartConfirm": "Ein Neustart von Pi Harbor trennt die aktuelle Browserverbindung; eine laufende Pi-Aufgabe versucht, sicher zu enden. Fortfahren?",
      "device.deleteConfirm": "„{name}“ löschen?",
      "sessions.justNow": "Gerade eben",
      "common.undo": "Rückgängig",
      "common.restored": "Wiederhergestellt",
      "sessions.running": "Läuft",
      "sessions.runningFor": "Läuft seit {elapsed}",
      "sessions.runStuck": "Hängt",
    },
    es: {
      "provider.readFailed": "No se pudo leer la configuración del proveedor: {detail}",
      "provider.localService": "Un servicio local no necesita cuenta ni clave API.",
      "provider.apiKeyNote": "Pega la clave API del servicio; la facturación y la cuota son suyas.",
      "provider.accountNote": "Inicia sesión con la cuenta o suscripción oficial; Pi guarda y renueva las credenciales.",
      "provider.added": "{name} añadido; vuelve a escanear para actualizar la lista de modelos.",
      "provider.alreadySignedIn": "{name} ya tiene sesión iniciada; elige otra vez un método para actualizarlo.",
      "provider.chooseMethod": "Elige un método de inicio de sesión para empezar.",
      "provider.verificationCode": "Código de verificación: {code}",
      "provider.authTimeout": "El inicio de sesión del proveedor caducó. Empieza de nuevo y pega pronto la URL de redirección",
      "provider.authSuperseded": "Otro inicio de sesión reemplazó a este; mantén abierta solo una ventana",
      "provider.apiKeyLocal": "La clave API de {name} se guarda solo en este ordenador.",
      "provider.addedWithModels": "{name} añadido; la lista de modelos se actualizó",
      "provider.apiKeyRequired": "Pega una clave API.",
      "provider.apiKeyRejected": "La clave API no se guardó; comprueba que la región coincide con la clave.",
      "provider.removeAuthConfirm": "¿Quitar el inicio de sesión de «{name}»?\nSolo se elimina la credencial local; el proveedor se mantiene.",
      "provider.deleteConfirm": "¿Quitar «{id}» de models.json?\nLas credenciales de auth.json no se eliminan.",
      "settings.resetConfirm": "¿Restaurar los ajustes de interfaz predeterminados? Tu sesión y conversaciones no se ven afectadas.",
      "device.testOk": "Conectado: Pi Harbor respondió con normalidad.",
      "device.testFailed": "Error de conexión. Revisa Pi Harbor, el puerto y la dirección Tailscale/HTTPS.",
      "device.nameRequired": "Escribe un nombre de dispositivo.",
      "device.nameAndUrlRequired": "Escribe un nombre de dispositivo y una dirección de Pi Harbor.",
      "device.portRestartNote": "Ajustes guardados. El nuevo puerto se aplica tras reiniciar Pi Harbor.",
      "device.nameUpdated": "Nombre del dispositivo actualizado; el puerto se aplica tras reiniciar",
      "device.restartConfirm": "Reiniciar Pi Harbor corta la conexión actual del navegador; una tarea de Pi en curso intentará terminar de forma segura. ¿Continuar?",
      "device.deleteConfirm": "¿Eliminar «{name}»?",
      "sessions.justNow": "Justo ahora",
      "common.undo": "Deshacer",
      "common.restored": "Restaurado",
      "sessions.running": "En ejecución",
      "sessions.runningFor": "En ejecución {elapsed}",
      "sessions.runStuck": "Atascado",
    },
    "pt-BR": {
      "provider.readFailed": "Não foi possível ler as configurações do provedor: {detail}",
      "provider.localService": "Um serviço local não precisa de conta nem de chave de API.",
      "provider.apiKeyNote": "Cole a chave de API do serviço; a cobrança e a cota ficam com ele.",
      "provider.accountNote": "Entre com a conta ou assinatura oficial; o Pi guarda e renova as credenciais.",
      "provider.added": "{name} adicionado; faça uma nova varredura para atualizar a lista de modelos.",
      "provider.alreadySignedIn": "{name} já está conectado; escolha um método novamente para atualizar.",
      "provider.chooseMethod": "Escolha um método de login para começar.",
      "provider.verificationCode": "Código de verificação: {code}",
      "provider.authTimeout": "O login do provedor expirou. Comece de novo e cole logo a URL de redirecionamento",
      "provider.authSuperseded": "Outro login substituiu este; mantenha apenas uma janela aberta",
      "provider.apiKeyLocal": "A chave de API de {name} fica salva apenas neste computador.",
      "provider.addedWithModels": "{name} adicionado; a lista de modelos foi atualizada",
      "provider.apiKeyRequired": "Cole uma chave de API.",
      "provider.apiKeyRejected": "A chave de API não foi salva; verifique se a região corresponde à chave.",
      "provider.removeAuthConfirm": "Remover o login de “{name}”?\nApenas a credencial local é removida; o provedor permanece.",
      "provider.deleteConfirm": "Remover “{id}” do models.json?\nAs credenciais do auth.json não são excluídas.",
      "settings.resetConfirm": "Restaurar as configurações padrão da interface? Seu login e suas conversas não são afetados.",
      "device.testOk": "Conectado: o Pi Harbor respondeu normalmente.",
      "device.testFailed": "Falha na conexão. Verifique o Pi Harbor, a porta e o endereço Tailscale/HTTPS.",
      "device.nameRequired": "Informe um nome de dispositivo.",
      "device.nameAndUrlRequired": "Informe um nome de dispositivo e um endereço do Pi Harbor.",
      "device.portRestartNote": "Configurações salvas. A nova porta passa a valer após reiniciar o Pi Harbor.",
      "device.nameUpdated": "Nome do dispositivo atualizado; a porta se aplica após reiniciar",
      "device.restartConfirm": "Reiniciar o Pi Harbor derruba a conexão atual do navegador; uma tarefa do Pi em execução tentará terminar com segurança. Continuar?",
      "device.deleteConfirm": "Excluir “{name}”?",
      "sessions.justNow": "Agora mesmo",
      "common.undo": "Desfazer",
      "common.restored": "Restaurado",
      "sessions.running": "Em execução",
      "sessions.runningFor": "Em execução há {elapsed}",
      "sessions.runStuck": "Travado",
    },
    it: {
      "provider.readFailed": "Impossibile leggere le impostazioni del provider: {detail}",
      "provider.localService": "Un servizio locale non richiede account né chiave API.",
      "provider.apiKeyNote": "Incolla la chiave API del servizio; costi e quota restano suoi.",
      "provider.accountNote": "Accedi con l account o l abbonamento ufficiale; Pi salva e aggiorna le credenziali.",
      "provider.added": "{name} aggiunto; esegui una nuova scansione per aggiornare l elenco dei modelli.",
      "provider.alreadySignedIn": "{name} ha già un accesso; scegli di nuovo un metodo per aggiornarlo.",
      "provider.chooseMethod": "Scegli un metodo di accesso per iniziare.",
      "provider.verificationCode": "Codice di verifica: {code}",
      "provider.authTimeout": "L accesso al provider è scaduto. Ricomincia e incolla subito l URL di reindirizzamento",
      "provider.authSuperseded": "Un altro accesso ha sostituito questo; tieni aperta una sola finestra",
      "provider.apiKeyLocal": "La chiave API di {name} viene salvata solo su questo computer.",
      "provider.addedWithModels": "{name} aggiunto; l elenco dei modelli è stato aggiornato",
      "provider.apiKeyRequired": "Incolla una chiave API.",
      "provider.apiKeyRejected": "La chiave API non è stata salvata; verifica che la regione corrisponda alla chiave.",
      "provider.removeAuthConfirm": "Rimuovere l accesso di “{name}”?\nViene rimossa solo la credenziale locale; il provider resta.",
      "provider.deleteConfirm": "Rimuovere “{id}” da models.json?\nLe credenziali in auth.json non vengono eliminate.",
      "settings.resetConfirm": "Ripristinare le impostazioni predefinite dell interfaccia? Accesso e conversazioni non vengono toccati.",
      "device.testOk": "Connesso: Pi Harbor ha risposto normalmente.",
      "device.testFailed": "Connessione non riuscita. Controlla Pi Harbor, la porta e l indirizzo Tailscale/HTTPS.",
      "device.nameRequired": "Inserisci un nome dispositivo.",
      "device.nameAndUrlRequired": "Inserisci un nome dispositivo e un indirizzo Pi Harbor.",
      "device.portRestartNote": "Impostazioni salvate. La nuova porta vale dopo il riavvio di Pi Harbor.",
      "device.nameUpdated": "Nome dispositivo aggiornato; la porta si applica dopo un riavvio",
      "device.restartConfirm": "Riavviare Pi Harbor interrompe la connessione attuale del browser; un lavoro Pi in corso proverà a chiudersi in sicurezza. Continuare?",
      "device.deleteConfirm": "Eliminare “{name}”?",
      "sessions.justNow": "Proprio ora",
      "common.undo": "Annulla",
      "common.restored": "Ripristinato",
      "sessions.running": "In esecuzione",
      "sessions.runningFor": "In esecuzione da {elapsed}",
      "sessions.runStuck": "Bloccato",
    },
  };
  for (const [id, table] of Object.entries(PROVIDER_DEVICE_TRANSLATIONS)) Object.assign(KEYED_TRANSLATIONS[id], table);

  // Agent Hub inventory, task states, and the generic CLI launch flow. Keep
  // these keyed so a locale switch never has to translate terminal output or
  // user-authored task names.
  const AGENT_HUB_TRANSLATIONS = {
    en: {
      "agentHub.title": "Agent Hub", "agentHub.agent": "Agent", "agentHub.discovering": "Discovering local agents…", "agentHub.refresh": "Refresh agents",
      "agentHub.activeSummary": "{active} active · {ready} ready", "agentHub.readySummary": "{ready} agents ready",
      "agentHub.noTasks": "No active tasks — choose an Agent when you start a project.", "agentHub.notInstalled": "not installed",
      "agentHub.isolated": "Isolated worktree", "agentHub.worktreeDescription": "Give this task its own Git branch and folder", "agentHub.piNote": "Pi Agent keeps full session history. CLI agents stream terminal output here.",
      "agentHub.cliNote": "This CLI streams terminal output here; the task keeps running when you leave the chat.", "agentHub.cliTextOnly": "CLI agents currently accept text input only.", "agentHub.agentTask": "Agent task", "agentHub.signal": "signal {value}", "agentHub.exitCode": "code {value}",
      "agentHub.starting": "Starting", "agentHub.running": "Working", "agentHub.reconnecting": "Reconnecting", "agentHub.waiting": "Waiting", "agentHub.completed": "Done",
      "agentHub.failed": "Failed", "agentHub.stopped": "Stopped", "agentHub.detached": "Detached", "agentHub.orphaned": "Interrupted",
    },
    "zh-Hant": {
      "agentHub.title": "Agent Hub", "agentHub.agent": "Agent", "agentHub.discovering": "正在探索本機 Agent…", "agentHub.refresh": "重新探索 Agent",
      "agentHub.activeSummary": "{active} 個執行中 · {ready} 個可用", "agentHub.readySummary": "{ready} 個 Agent 可用",
      "agentHub.noTasks": "目前沒有工作；建立專案時選擇要使用的 Agent。", "agentHub.notInstalled": "尚未安裝",
      "agentHub.isolated": "隔離 Worktree", "agentHub.worktreeDescription": "為這個工作建立獨立的 Git 分支與資料夾", "agentHub.piNote": "Pi Agent 會保留完整工作階段記錄；CLI Agent 會在這裡串流終端輸出。",
      "agentHub.cliNote": "CLI 輸出會串流到這裡；離開對話後工作仍會繼續。", "agentHub.cliTextOnly": "CLI Agent 目前只接受文字輸入。", "agentHub.agentTask": "Agent 工作", "agentHub.signal": "訊號 {value}", "agentHub.exitCode": "代碼 {value}", "agentHub.starting": "啟動中",
      "agentHub.running": "工作中", "agentHub.reconnecting": "重新連線中", "agentHub.waiting": "等待中", "agentHub.completed": "完成", "agentHub.failed": "失敗",
      "agentHub.stopped": "已停止", "agentHub.detached": "已脫離", "agentHub.orphaned": "已中斷",
    },
    "zh-Hans": {
      "agentHub.title": "Agent Hub", "agentHub.agent": "Agent", "agentHub.discovering": "正在探索本机 Agent…", "agentHub.refresh": "重新探索 Agent",
      "agentHub.activeSummary": "{active} 个运行中 · {ready} 个可用", "agentHub.readySummary": "{ready} 个 Agent 可用",
      "agentHub.noTasks": "目前没有任务；创建项目时选择要使用的 Agent。", "agentHub.notInstalled": "尚未安装",
      "agentHub.isolated": "隔离 Worktree", "agentHub.worktreeDescription": "为此任务建立独立的 Git 分支和文件夹", "agentHub.piNote": "Pi Agent 会保留完整会话记录；CLI Agent 会在这里串流终端输出。",
      "agentHub.cliNote": "CLI 输出会串流到这里；离开对话后任务仍会继续。", "agentHub.cliTextOnly": "CLI Agent 目前只接受文字输入。", "agentHub.agentTask": "Agent 任务", "agentHub.signal": "信号 {value}", "agentHub.exitCode": "代码 {value}", "agentHub.starting": "启动中",
      "agentHub.running": "工作中", "agentHub.reconnecting": "重新连接中", "agentHub.waiting": "等待中", "agentHub.completed": "完成", "agentHub.failed": "失败",
      "agentHub.stopped": "已停止", "agentHub.detached": "已脱离", "agentHub.orphaned": "已中断",
    },
    ja: {
      "agentHub.title": "Agent Hub", "agentHub.agent": "Agent", "agentHub.discovering": "ローカル Agent を検出中…", "agentHub.refresh": "Agent を更新",
      "agentHub.activeSummary": "{active} 件実行中 · {ready} 件利用可能", "agentHub.readySummary": "{ready} 件の Agent が利用可能",
      "agentHub.noTasks": "実行中のタスクはありません。プロジェクト開始時に Agent を選択してください。", "agentHub.notInstalled": "未インストール",
      "agentHub.isolated": "隔離 Worktree", "agentHub.piNote": "Pi Agent は完全なセッション履歴を保持します。CLI Agent の出力はここに表示されます。",
      "agentHub.cliNote": "CLI の出力をここに表示します。チャットを離れてもタスクは実行を続けます。", "agentHub.starting": "起動中",
      "agentHub.running": "作業中", "agentHub.reconnecting": "再接続中", "agentHub.waiting": "待機中", "agentHub.completed": "完了", "agentHub.failed": "失敗",
      "agentHub.stopped": "停止", "agentHub.detached": "分離済み", "agentHub.orphaned": "中断",
    },
    ko: {
      "agentHub.title": "Agent Hub", "agentHub.discovering": "로컬 Agent 검색 중…", "agentHub.refresh": "Agent 새로 고침",
      "agentHub.activeSummary": "{active}개 실행 중 · {ready}개 사용 가능", "agentHub.readySummary": "{ready}개 Agent 사용 가능",
      "agentHub.noTasks": "실행 중인 작업이 없습니다. 프로젝트를 시작할 때 Agent를 선택하세요.", "agentHub.notInstalled": "설치되지 않음",
      "agentHub.isolated": "격리된 Worktree", "agentHub.piNote": "Pi Agent는 전체 세션 기록을 보존합니다. CLI Agent 출력은 여기에 표시됩니다.",
      "agentHub.cliNote": "CLI 출력이 여기에 표시되며 채팅을 나가도 작업은 계속됩니다.", "agentHub.starting": "시작 중",
      "agentHub.running": "작업 중", "agentHub.reconnecting": "재연결 중", "agentHub.waiting": "대기 중", "agentHub.completed": "완료", "agentHub.failed": "실패",
      "agentHub.stopped": "중지됨", "agentHub.detached": "분리됨", "agentHub.orphaned": "중단됨",
    },
    tr: {
      "agentHub.title": "Agent Hub", "agentHub.discovering": "Yerel Agent'lar aranıyor…", "agentHub.refresh": "Agent'ları yenile",
      "agentHub.activeSummary": "{active} etkin · {ready} hazır", "agentHub.readySummary": "{ready} Agent hazır",
      "agentHub.noTasks": "Etkin görev yok — proje başlatırken bir Agent seçin.", "agentHub.notInstalled": "yüklü değil",
      "agentHub.isolated": "Yalıtılmış Worktree", "agentHub.piNote": "Pi Agent tam oturum geçmişini korur. CLI Agent çıktısı burada akar.",
      "agentHub.cliNote": "CLI çıktısı burada akar; sohbetten ayrılsanız da görev çalışmayı sürdürür.", "agentHub.starting": "Başlatılıyor",
      "agentHub.running": "Çalışıyor", "agentHub.reconnecting": "Yeniden bağlanıyor", "agentHub.waiting": "Bekliyor", "agentHub.completed": "Tamamlandı", "agentHub.failed": "Başarısız",
      "agentHub.stopped": "Durduruldu", "agentHub.detached": "Ayrıldı", "agentHub.orphaned": "Kesildi",
    },
    fr: {
      "agentHub.title": "Agent Hub", "agentHub.discovering": "Détection des agents locaux…", "agentHub.refresh": "Actualiser les agents",
      "agentHub.activeSummary": "{active} actif(s) · {ready} disponible(s)", "agentHub.readySummary": "{ready} agent(s) disponible(s)",
      "agentHub.noTasks": "Aucune tâche active — choisissez un agent au démarrage d’un projet.", "agentHub.notInstalled": "non installé",
      "agentHub.isolated": "Worktree isolé", "agentHub.piNote": "Pi Agent conserve l’historique complet. La sortie des agents CLI s’affiche ici.",
      "agentHub.cliNote": "La sortie CLI s’affiche ici ; la tâche continue même après avoir quitté la conversation.", "agentHub.starting": "Démarrage",
      "agentHub.running": "En cours", "agentHub.reconnecting": "Reconnexion", "agentHub.waiting": "En attente", "agentHub.completed": "Terminé", "agentHub.failed": "Échec",
      "agentHub.stopped": "Arrêté", "agentHub.detached": "Détaché", "agentHub.orphaned": "Interrompu",
    },
    de: {
      "agentHub.title": "Agent Hub", "agentHub.discovering": "Lokale Agents werden gesucht…", "agentHub.refresh": "Agents aktualisieren",
      "agentHub.activeSummary": "{active} aktiv · {ready} bereit", "agentHub.readySummary": "{ready} Agents bereit",
      "agentHub.noTasks": "Keine aktiven Aufgaben — wähle beim Start eines Projekts einen Agent.", "agentHub.notInstalled": "nicht installiert",
      "agentHub.isolated": "Isolierter Worktree", "agentHub.piNote": "Pi Agent bewahrt den vollständigen Sitzungsverlauf. CLI-Ausgaben werden hier angezeigt.",
      "agentHub.cliNote": "CLI-Ausgaben werden hier angezeigt; die Aufgabe läuft weiter, wenn du den Chat verlässt.", "agentHub.starting": "Wird gestartet",
      "agentHub.running": "In Arbeit", "agentHub.reconnecting": "Verbindung wird hergestellt", "agentHub.waiting": "Wartet", "agentHub.completed": "Fertig", "agentHub.failed": "Fehlgeschlagen",
      "agentHub.stopped": "Angehalten", "agentHub.detached": "Getrennt", "agentHub.orphaned": "Unterbrochen",
    },
    es: {
      "agentHub.title": "Agent Hub", "agentHub.discovering": "Buscando agentes locales…", "agentHub.refresh": "Actualizar agentes",
      "agentHub.activeSummary": "{active} activos · {ready} disponibles", "agentHub.readySummary": "{ready} agentes disponibles",
      "agentHub.noTasks": "No hay tareas activas; elige un agente al iniciar un proyecto.", "agentHub.notInstalled": "no instalado",
      "agentHub.isolated": "Worktree aislado", "agentHub.piNote": "Pi Agent conserva todo el historial. La salida de los agentes CLI aparece aquí.",
      "agentHub.cliNote": "La salida CLI aparece aquí; la tarea continúa aunque salgas del chat.", "agentHub.starting": "Iniciando",
      "agentHub.running": "Trabajando", "agentHub.reconnecting": "Reconectando", "agentHub.waiting": "Esperando", "agentHub.completed": "Listo", "agentHub.failed": "Fallido",
      "agentHub.stopped": "Detenido", "agentHub.detached": "Desconectado", "agentHub.orphaned": "Interrumpido",
    },
    "pt-BR": {
      "agentHub.title": "Agent Hub", "agentHub.discovering": "Detectando agentes locais…", "agentHub.refresh": "Atualizar agentes",
      "agentHub.activeSummary": "{active} ativos · {ready} disponíveis", "agentHub.readySummary": "{ready} agentes disponíveis",
      "agentHub.noTasks": "Nenhuma tarefa ativa — escolha um agente ao iniciar um projeto.", "agentHub.notInstalled": "não instalado",
      "agentHub.isolated": "Worktree isolado", "agentHub.piNote": "O Pi Agent mantém o histórico completo. A saída dos agentes CLI aparece aqui.",
      "agentHub.cliNote": "A saída CLI aparece aqui; a tarefa continua mesmo quando você sai do chat.", "agentHub.starting": "Iniciando",
      "agentHub.running": "Trabalhando", "agentHub.reconnecting": "Reconectando", "agentHub.waiting": "Aguardando", "agentHub.completed": "Concluído", "agentHub.failed": "Falhou",
      "agentHub.stopped": "Parado", "agentHub.detached": "Desanexado", "agentHub.orphaned": "Interrompido",
    },
    it: {
      "agentHub.title": "Agent Hub", "agentHub.discovering": "Rilevamento degli agent locali…", "agentHub.refresh": "Aggiorna agent",
      "agentHub.activeSummary": "{active} attivi · {ready} disponibili", "agentHub.readySummary": "{ready} agent disponibili",
      "agentHub.noTasks": "Nessuna attività attiva — scegli un agent quando avvii un progetto.", "agentHub.notInstalled": "non installato",
      "agentHub.isolated": "Worktree isolato", "agentHub.piNote": "Pi Agent conserva tutta la cronologia. L’output degli agent CLI appare qui.",
      "agentHub.cliNote": "L’output CLI appare qui; l’attività continua anche quando lasci la chat.", "agentHub.starting": "Avvio",
      "agentHub.running": "In esecuzione", "agentHub.reconnecting": "Riconnessione", "agentHub.waiting": "In attesa", "agentHub.completed": "Completato", "agentHub.failed": "Non riuscito",
      "agentHub.stopped": "Arrestato", "agentHub.detached": "Separato", "agentHub.orphaned": "Interrotto",
    },
  };
  const AGENT_HUB_TASK_CENTER_TRANSLATIONS = {
    en: {
      "agentHub.viewAll": "View all", "agentHub.close": "Close", "agentHub.taskCenterTitle": "Task center",
      "agentHub.taskSearch": "Search tasks…", "agentHub.taskFilter": "Filter tasks", "agentHub.filterAll": "All",
      "agentHub.filterActive": "Active", "agentHub.taskCenterEmpty": "No tasks match this view.",
      "agentHub.taskCenterCount": "{visible} of {total} tasks", "agentHub.taskOpen": "Open", "agentHub.taskStop": "Stop",
      "agentHub.taskStopping": "Stopping…", "agentHub.taskStoppedToast": "Agent task stopped", "agentHub.taskStopFailed": "Could not stop agent task",
      "agentHub.taskNoOutput": "No output yet", "agentHub.taskLastActivity": "Updated {value}", "agentHub.reconnectingNote": "Reconnecting to the supervisor…",
    },
    "zh-Hant": {
      "agentHub.viewAll": "查看全部", "agentHub.close": "關閉", "agentHub.taskCenterTitle": "工作中心", "agentHub.taskSearch": "搜尋工作…", "agentHub.taskFilter": "篩選工作", "agentHub.filterAll": "全部", "agentHub.filterActive": "執行中", "agentHub.taskCenterEmpty": "沒有符合的工作。", "agentHub.taskCenterCount": "顯示 {visible}／{total} 個工作", "agentHub.taskOpen": "開啟", "agentHub.taskStop": "停止", "agentHub.taskStopping": "停止中…", "agentHub.taskStoppedToast": "Agent 工作已停止", "agentHub.taskStopFailed": "無法停止 Agent 工作", "agentHub.taskNoOutput": "尚無輸出", "agentHub.taskLastActivity": "更新於 {value}", "agentHub.reconnectingNote": "正在重新連線至監督器…",
    },
    "zh-Hans": {
      "agentHub.viewAll": "查看全部", "agentHub.close": "关闭", "agentHub.taskCenterTitle": "任务中心", "agentHub.taskSearch": "搜索任务…", "agentHub.taskFilter": "筛选任务", "agentHub.filterAll": "全部", "agentHub.filterActive": "运行中", "agentHub.taskCenterEmpty": "没有符合的任务。", "agentHub.taskCenterCount": "显示 {visible}／{total} 个任务", "agentHub.taskOpen": "打开", "agentHub.taskStop": "停止", "agentHub.taskStopping": "停止中…", "agentHub.taskStoppedToast": "Agent 任务已停止", "agentHub.taskStopFailed": "无法停止 Agent 任务", "agentHub.taskNoOutput": "暂无输出", "agentHub.taskLastActivity": "更新于 {value}", "agentHub.reconnectingNote": "正在重新连接到监督器…",
    },
    ja: {
      "agentHub.viewAll": "すべて表示", "agentHub.close": "閉じる", "agentHub.taskCenterTitle": "タスクセンター", "agentHub.taskSearch": "タスクを検索…", "agentHub.taskFilter": "タスクを絞り込む", "agentHub.filterAll": "すべて", "agentHub.filterActive": "実行中", "agentHub.taskCenterEmpty": "一致するタスクはありません。", "agentHub.taskCenterCount": "{total} 件中 {visible} 件", "agentHub.taskOpen": "開く", "agentHub.taskStop": "停止", "agentHub.taskStopping": "停止中…", "agentHub.taskStoppedToast": "Agent タスクを停止しました", "agentHub.taskStopFailed": "Agent タスクを停止できません", "agentHub.taskNoOutput": "出力はまだありません", "agentHub.taskLastActivity": "更新 {value}", "agentHub.reconnectingNote": "スーパーバイザーに再接続中…",
    },
    ko: {
      "agentHub.viewAll": "모두 보기", "agentHub.close": "닫기", "agentHub.taskCenterTitle": "작업 센터", "agentHub.taskSearch": "작업 검색…", "agentHub.taskFilter": "작업 필터", "agentHub.filterAll": "모두", "agentHub.filterActive": "활성", "agentHub.taskCenterEmpty": "일치하는 작업이 없습니다.", "agentHub.taskCenterCount": "전체 {total}개 중 {visible}개", "agentHub.taskOpen": "열기", "agentHub.taskStop": "중지", "agentHub.taskStopping": "중지 중…", "agentHub.taskStoppedToast": "Agent 작업을 중지했습니다", "agentHub.taskStopFailed": "Agent 작업을 중지할 수 없습니다", "agentHub.taskNoOutput": "아직 출력 없음", "agentHub.taskLastActivity": "업데이트 {value}", "agentHub.reconnectingNote": "슈퍼바이저에 다시 연결 중…",
    },
    tr: {
      "agentHub.viewAll": "Tümünü gör", "agentHub.close": "Kapat", "agentHub.taskCenterTitle": "Görev merkezi", "agentHub.taskSearch": "Görevlerde ara…", "agentHub.taskFilter": "Görevleri filtrele", "agentHub.filterAll": "Tümü", "agentHub.filterActive": "Etkin", "agentHub.taskCenterEmpty": "Bu görünüme uyan görev yok.", "agentHub.taskCenterCount": "{total} görevden {visible} tanesi", "agentHub.taskOpen": "Aç", "agentHub.taskStop": "Durdur", "agentHub.taskStopping": "Durduruluyor…", "agentHub.taskStoppedToast": "Agent görevi durduruldu", "agentHub.taskStopFailed": "Agent görevi durdurulamadı", "agentHub.taskNoOutput": "Henüz çıktı yok", "agentHub.taskLastActivity": "Güncelleme {value}", "agentHub.reconnectingNote": "Süpervizöre yeniden bağlanılıyor…",
    },
    fr: {
      "agentHub.viewAll": "Tout afficher", "agentHub.close": "Fermer", "agentHub.taskCenterTitle": "Centre des tâches", "agentHub.taskSearch": "Rechercher des tâches…", "agentHub.taskFilter": "Filtrer les tâches", "agentHub.filterAll": "Toutes", "agentHub.filterActive": "Actives", "agentHub.taskCenterEmpty": "Aucune tâche ne correspond.", "agentHub.taskCenterCount": "{visible} sur {total} tâches", "agentHub.taskOpen": "Ouvrir", "agentHub.taskStop": "Arrêter", "agentHub.taskStopping": "Arrêt…", "agentHub.taskStoppedToast": "Tâche de l’agent arrêtée", "agentHub.taskStopFailed": "Impossible d’arrêter la tâche", "agentHub.taskNoOutput": "Aucune sortie", "agentHub.taskLastActivity": "Mis à jour {value}", "agentHub.reconnectingNote": "Reconnexion au superviseur…",
    },
    de: {
      "agentHub.viewAll": "Alle anzeigen", "agentHub.close": "Schließen", "agentHub.taskCenterTitle": "Aufgabenzentrale", "agentHub.taskSearch": "Aufgaben suchen…", "agentHub.taskFilter": "Aufgaben filtern", "agentHub.filterAll": "Alle", "agentHub.filterActive": "Aktiv", "agentHub.taskCenterEmpty": "Keine passenden Aufgaben.", "agentHub.taskCenterCount": "{visible} von {total} Aufgaben", "agentHub.taskOpen": "Öffnen", "agentHub.taskStop": "Stoppen", "agentHub.taskStopping": "Wird gestoppt…", "agentHub.taskStoppedToast": "Agent-Aufgabe gestoppt", "agentHub.taskStopFailed": "Agent-Aufgabe konnte nicht gestoppt werden", "agentHub.taskNoOutput": "Noch keine Ausgabe", "agentHub.taskLastActivity": "Aktualisiert {value}", "agentHub.reconnectingNote": "Verbindung zum Supervisor wird hergestellt…",
    },
    es: {
      "agentHub.viewAll": "Ver todo", "agentHub.close": "Cerrar", "agentHub.taskCenterTitle": "Centro de tareas", "agentHub.taskSearch": "Buscar tareas…", "agentHub.taskFilter": "Filtrar tareas", "agentHub.filterAll": "Todas", "agentHub.filterActive": "Activas", "agentHub.taskCenterEmpty": "No hay tareas que coincidan.", "agentHub.taskCenterCount": "{visible} de {total} tareas", "agentHub.taskOpen": "Abrir", "agentHub.taskStop": "Detener", "agentHub.taskStopping": "Deteniendo…", "agentHub.taskStoppedToast": "Tarea del agente detenida", "agentHub.taskStopFailed": "No se pudo detener la tarea", "agentHub.taskNoOutput": "Aún no hay salida", "agentHub.taskLastActivity": "Actualizado {value}", "agentHub.reconnectingNote": "Reconectando con el supervisor…",
    },
    "pt-BR": {
      "agentHub.viewAll": "Ver tudo", "agentHub.close": "Fechar", "agentHub.taskCenterTitle": "Central de tarefas", "agentHub.taskSearch": "Pesquisar tarefas…", "agentHub.taskFilter": "Filtrar tarefas", "agentHub.filterAll": "Todas", "agentHub.filterActive": "Ativas", "agentHub.taskCenterEmpty": "Nenhuma tarefa corresponde.", "agentHub.taskCenterCount": "{visible} de {total} tarefas", "agentHub.taskOpen": "Abrir", "agentHub.taskStop": "Parar", "agentHub.taskStopping": "Parando…", "agentHub.taskStoppedToast": "Tarefa do agente parada", "agentHub.taskStopFailed": "Não foi possível parar a tarefa", "agentHub.taskNoOutput": "Ainda sem saída", "agentHub.taskLastActivity": "Atualizado {value}", "agentHub.reconnectingNote": "Reconectando ao supervisor…",
    },
    it: {
      "agentHub.viewAll": "Mostra tutto", "agentHub.close": "Chiudi", "agentHub.taskCenterTitle": "Centro attività", "agentHub.taskSearch": "Cerca attività…", "agentHub.taskFilter": "Filtra attività", "agentHub.filterAll": "Tutte", "agentHub.filterActive": "Attive", "agentHub.taskCenterEmpty": "Nessuna attività corrisponde.", "agentHub.taskCenterCount": "{visible} di {total} attività", "agentHub.taskOpen": "Apri", "agentHub.taskStop": "Arresta", "agentHub.taskStopping": "Arresto…", "agentHub.taskStoppedToast": "Attività dell’agent arrestata", "agentHub.taskStopFailed": "Impossibile arrestare l’attività", "agentHub.taskNoOutput": "Nessun output", "agentHub.taskLastActivity": "Aggiornato {value}", "agentHub.reconnectingNote": "Riconnessione al supervisore…",
    },
  };
  for (const [id, table] of Object.entries(AGENT_HUB_TASK_CENTER_TRANSLATIONS)) {
    if (AGENT_HUB_TRANSLATIONS[id]) Object.assign(AGENT_HUB_TRANSLATIONS[id], table);
  }
  for (const id of Object.keys(KEYED_TRANSLATIONS)) Object.assign(KEYED_TRANSLATIONS[id], AGENT_HUB_TRANSLATIONS.en, AGENT_HUB_TRANSLATIONS[id] || {});

  const KEYED_SOURCE_KEYS = Object.freeze(Object.keys(KEYED_TRANSLATIONS.en));
  const KEYED_FALLBACK_KEYS = {};
  for (const [id, table] of Object.entries(KEYED_TRANSLATIONS)) {
    const missing = KEYED_SOURCE_KEYS.filter((key) => !Object.prototype.hasOwnProperty.call(table, key));
    if (missing.length) KEYED_FALLBACK_KEYS[id] = Object.freeze(missing);
  }

  const LOCALE_SOURCE_KEYS = Object.freeze([...new Set([
    ...Object.values(HAN_TO_EN),
    ...Object.values(TRANSLATIONS).flatMap((table) => Object.keys(table)),
  ])].filter((key) => typeof key === "string" && key.length > 0));
  const LOCALE_PLACEHOLDER_RE = /\{[a-zA-Z0-9_.-]+\}/g;
  const keyedPlaceholders = (value) => [...new Set(String(value || "").match(LOCALE_PLACEHOLDER_RE) || [])].sort();
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
    const keyedMissingKeys = {};
    const keyedPlaceholderMismatches = {};
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
    for (const [id, table] of Object.entries(KEYED_TRANSLATIONS)) {
      const missing = KEYED_SOURCE_KEYS.filter((key) => !Object.prototype.hasOwnProperty.call(table, key));
      if (missing.length) keyedMissingKeys[id] = missing;
      const mismatches = [];
      for (const key of KEYED_SOURCE_KEYS) {
        if (!Object.prototype.hasOwnProperty.call(table, key)) continue;
        if (keyedPlaceholders(KEYED_TRANSLATIONS.en[key]).join("\\u0000") !== keyedPlaceholders(table[key]).join("\\u0000")) mismatches.push(key);
      }
      if (mismatches.length) keyedPlaceholderMismatches[id] = mismatches;
    }
    return {
      ok: !Object.keys(missingKeys).length && !Object.keys(placeholderMismatches).length && !Object.keys(hanLeaks).length
        && !Object.keys(keyedMissingKeys).length && !Object.keys(keyedPlaceholderMismatches).length,
      keyCount: LOCALE_SOURCE_KEYS.length,
      keyedKeyCount: KEYED_SOURCE_KEYS.length,
      localeIds: Object.keys(TRANSLATIONS),
      fallbackKeys: LOCALE_FALLBACK_KEYS,
      keyedFallbackKeys: KEYED_FALLBACK_KEYS,
      missingKeys,
      placeholderMismatches,
      hanLeaks,
      keyedMissingKeys,
      keyedPlaceholderMismatches,
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
  const SOURCE_PAIRS = SOURCE_KEYS.map((key) => [key, HAN_TO_EN[key]]);
  const EN_KEYS = Object.keys(Object.assign({}, ...Object.values(TRANSLATIONS))).sort((a, b) => b.length - a.length);
  const HAN_RE = /[\u3400-\u9fff]/;
  const ASCII_WORD_FRAGMENT_RE = /^[A-Za-z0-9_]+$/;
  const ASCII_WORD_CHAR_RE = /[A-Za-z0-9_]/;
  const NON_CONTENT = ".md-body, .thinking-block, .tool-command, .tool-output, .code-block, .mermaid-block, .msg.user .bubble, .session-item .s-name, .project-group-copy, [data-i18n-ignore]";
  let locale = "en";
  let localizing = false;
  let localizationQueued = false;
  let localeApplied = false;
  const pendingRoots = new Set();
  const rawTextNodes = new WeakMap();

  function normalizeLocale(value) { return LOCALE_IDS.has(value) ? value : "en"; }
  // Locale tables contain both complete phrases and short fragments. Short
  // ASCII fragments must not match inside a longer word (for example Turkish
  // `Proje` inside English `Project`), while CJK and phrase fragments retain
  // the existing substring behavior.
  function replaceLocalizationFragment(value, search, replacement) {
    const source = String(value);
    if (!search || search === replacement) return source;
    if (!ASCII_WORD_FRAGMENT_RE.test(search)) return source.replaceAll(search, replacement);
    let out = "";
    let cursor = 0;
    while (cursor < source.length) {
      const index = source.indexOf(search, cursor);
      if (index < 0) { out += source.slice(cursor); break; }
      const end = index + search.length;
      out += source.slice(cursor, index);
      const before = source[index - 1];
      const after = source[end];
      if ((!before || !ASCII_WORD_CHAR_RE.test(before)) && (!after || !ASCII_WORD_CHAR_RE.test(after))) out += replacement;
      else out += source.slice(index, end);
      cursor = end;
    }
    return out;
  }
  function replacePairs(value, pairs) {
    let out = String(value);
    for (const [search, replacement] of pairs) out = replaceLocalizationFragment(out, search, replacement);
    return out;
  }
  function sourceToEnglish(value) {
    // Prefer complete, previously rendered translations before legacy aliases.
    // Otherwise a value such as `工作階段` is split at `工作` and can no longer
    // be recognized as the translated form of `Session`.
    let out = replacePairs(value, TRANSLATION_REVERSE_PAIRS);
    out = replacePairs(out, SOURCE_PAIRS);
    return out;
  }
  function translate(value, target = locale) {
    if (value == null || typeof value !== "string" || !value) return value;
    // Legacy application chrome is authored in Traditional Chinese, so Han
    // text is already in the target language. Re-processing it through the
    // legacy alias table corrupts valid phrases (`五分鐘` -> `五min`, etc.).
    if (target === "zh-Hant" && HAN_RE.test(value)) return value;
    const source = sourceToEnglish(value);
    const table = TRANSLATIONS[target] || {};
    let out = source;
    for (const key of EN_KEYS) {
      const translated = table[key];
      if (translated && translated !== key) out = replaceLocalizationFragment(out, key, translated);
    }
    // A non-Chinese UI must never expose a legacy Chinese chrome string. User
    // prompts and model output are excluded from the DOM walk below.
    // Japanese legitimately contains kanji; never scrub CJK from ja. Other
    // locales only scrub unresolved legacy Chinese chrome as a final guard.
    if (!target.startsWith("zh-") && target !== "ja" && HAN_RE.test(out)) out = out.replace(/[\u3400-\u9fff]+/g, "").replace(/\s{2,}/g, " ").trim();
    return out;
  }
  function interpolate(value, vars = {}) {
    let out = String(value ?? "");
    for (const [name, valueForName] of Object.entries(vars || {})) out = out.replaceAll(`{${name}}`, String(valueForName));
    return out;
  }
  function tKey(key, vars = {}, target = locale) {
    const source = typeof key === "string" ? KEYED_TRANSLATIONS.en[key] : undefined;
    const table = KEYED_TRANSLATIONS[target] || KEYED_TRANSLATIONS.en;
    const translated = source === undefined ? key
      : Object.prototype.hasOwnProperty.call(table, key) ? table[key] : source;
    return interpolate(translated, vars);
  }
  function localizeKeyedElements(root) {
    const base = root?.body || root;
    if (!base?.querySelectorAll) return;
    const elements = [];
    if (base.nodeType === Node.ELEMENT_NODE && base.matches?.("[data-i18n-key], [data-i18n-aria-key], [data-i18n-title-key], [data-i18n-placeholder-key]")) elements.push(base);
    elements.push(...base.querySelectorAll("[data-i18n-key], [data-i18n-aria-key], [data-i18n-title-key], [data-i18n-placeholder-key]"));
    for (const item of elements) {
      const textKey = item.getAttribute("data-i18n-key");
      if (textKey) {
        const translated = tKey(textKey);
        // Touched device/pairing nodes are text-only. For a future keyed node
        // with a child icon, replace only its text node so its structure stays.
        const textNode = [...item.childNodes].find((node) => node.nodeType === Node.TEXT_NODE);
        if (textNode) textNode.nodeValue = translated;
        else if (!item.children.length) item.textContent = translated;
        else item.insertBefore(document.createTextNode(translated), item.firstChild);
        item.dataset.i18nKeyRendered = translated;
      }
      for (const [attribute, dataName] of [["aria-label", "i18nAriaKey"], ["title", "i18nTitleKey"], ["placeholder", "i18nPlaceholderKey"]]) {
        const attributeKey = item.dataset[dataName];
        if (!attributeKey) continue;
        const translated = tKey(attributeKey);
        // These attributes are observed below. Rewriting an unchanged value
        // would enqueue the same element forever and pin the renderer at 100%.
        if (item.getAttribute(attribute) !== translated) item.setAttribute(attribute, translated);
      }
    }
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
      if (shouldSkip(item)) continue;
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
      localizeKeyedElements(root.body || root);
      const walker = document.createTreeWalker(root.body || root, NodeFilter.SHOW_TEXT);
      const nodes = [];
      let node;
      while ((node = walker.nextNode())) nodes.push(node);
      for (const textNode of nodes) {
        if (shouldSkip(textNode) || textNode.parentElement?.closest("[data-i18n-key]")) continue;
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
      if (localeSelect) {
        // Language names stay in their own language, so the list reads the same
        // whichever locale the UI is in. LOCALES is the single source of truth.
        for (const option of localeSelect.options) {
          const native = LOCALES.find((item) => item.id === option.value)?.label;
          if (native && option.textContent !== native) option.textContent = native;
        }
        localeSelect.value = locale;
      }
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
    return interpolate(translate(String(key), locale), vars);
  }
  function providerName(provider) {
    const id = typeof provider === "string" ? provider : provider?.id;
    const copy = PROVIDER_COPY[id];
    return copy?.[locale] || copy?.en || (typeof provider === "string" ? provider : provider?.name) || id || "Provider";
  }
  function providerDescription(provider) {
    return translate(typeof provider === "string" ? provider : provider?.description || "", locale);
  }

  window.piI18n = Object.freeze({ locales: LOCALES, normalizeLocale, getLocale, setLocale, localize: localizeDom, queue: queueLocalize, t, tKey, translate, providerName, providerDescription, auditLocales });
  try {
    const raw = localStorage.getItem("piharbor.settings.v2") || localStorage.getItem("piweb.settings.v2") || localStorage.getItem("piweb.settings.v1") || localStorage.getItem("piharbor.settings.v1") || "{}";
    locale = normalizeLocale(JSON.parse(raw).locale);
  } catch {}
  new MutationObserver((records) => queueLocalize(records)).observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ["title", "aria-label", "placeholder"] });
  setLocale(locale);
})();
