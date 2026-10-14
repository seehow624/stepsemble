(function (root) {
  "use strict";
  const Data = root.StepsembleUsageData;
  const strings = {
    en: { usage: "Usage", subtitle: "A clearer view of the work you do.", today: "Today", week: "This week", month: "This month", thirty: "30 days", allHosts: "All Hosts", host: "Host", close: "Close", refresh: "Refresh", loading: "Reading usage…", tokens: "Tokens", cost: "Estimated cost", calls: "Model calls", input: "Input", output: "Output", cacheRead: "Cache read", cacheWrite: "Cache write", chart: "Daily usage", models: "Models", agents: "Agents", projects: "Projects", sessions: "Sessions", allAgents: "All agents", allProjects: "All projects", allModels: "All models", reset: "Clear filters", noData: "No recorded usage in this period", noDataHint: "Usage appears after a supported agent records a model call. Try a longer period.", estimate: "USD estimate from agent reports or reference model prices. Subscription allowance is shown separately; this is not a bill.", unknownCost: "Price unavailable", priced: "{known} of {total} calls priced", partialCost: "Known portion", scope: "This computer’s readable agent history", workspaceScope: "This Host uses workspace-only statistics. Update it to include this computer’s history.", mixedScope: "Some Hosts still use workspace-only statistics. Update them for computer-wide totals.", indexing: "Indexing history · {count} files remaining. Totals will update automatically.", viewSession: "Filter this session", coverage: "{covered} sessions read", missing: "{count} sessions unavailable", unsupported: "{count} sessions use an unsupported agent", partial: "Some records could not be read. Totals show the available portion.", offline: "Unavailable", retry: "Could not read usage. Try again.", updated: "Updated {time}", limits: "Subscription limits", remaining: "{percent}% remaining", resetAt: "Resets {time}", quotaUnknown: "Limits unavailable", incomplete: "Some calls have incomplete token counts.", openSession: "Open conversation", viewProject: "Filter this project", viewModel: "Filter this model", viewAgent: "Filter this agent", back: "Back", costSource: "Reference model prices", readOnly: "Usage refresh never starts an agent.", noResults: "No calls match these filters", filter: "Filter usage", sidebar: "Usage overview" },
    "zh-Hant": { usage: "用量", subtitle: "看見每一份工作的消耗。", today: "今天", week: "本週", month: "本月", thirty: "30 天", allHosts: "所有 Host", host: "Host", close: "關閉", refresh: "重新整理", loading: "正在讀取用量…", tokens: "Token 用量", cost: "估算費用", calls: "模型呼叫", input: "輸入", output: "輸出", cacheRead: "快取讀取", cacheWrite: "快取寫入", chart: "每日用量", models: "模型", agents: "Agent", projects: "專案", sessions: "Session", allAgents: "所有 Agent", allProjects: "所有專案", allModels: "所有模型", reset: "清除篩選", noData: "這段期間還沒有用量紀錄", noDataHint: "支援的 Agent 保存模型呼叫後就會顯示。也可以切換更長的期間。", estimate: "依 Agent 回報或參考模型單價估算，幣別為 USD。訂閱配額另外顯示；這不是實際帳單。", unknownCost: "缺少單價", priced: "已估算 {known}／{total} 次呼叫", partialCost: "已知部分", scope: "這台電腦可讀取的 Agent 紀錄", workspaceScope: "此 Host 仍只統計工作區，更新後可讀取整台電腦的紀錄。", mixedScope: "部分 Host 仍只統計工作區，更新後才能顯示整機用量。", indexing: "正在建立歷史索引 · 尚有 {count} 個檔案，用量將自動更新。", viewSession: "篩選此 Session", coverage: "已讀取 {covered} 個 Session", missing: "{count} 個 Session 暫時無法讀取", unsupported: "{count} 個 Session 的 Agent 暫不支援", partial: "部分紀錄無法讀取，目前顯示可取得的用量。", offline: "無法連線", retry: "暫時無法讀取用量，請重試。", updated: "更新於 {time}", limits: "訂閱配額", remaining: "剩餘 {percent}%", resetAt: "{time} 重置", quotaUnknown: "暫時無法取得配額", incomplete: "部分呼叫缺少完整的 Token 數字。", openSession: "開啟對話", viewProject: "篩選此專案", viewModel: "篩選此模型", viewAgent: "篩選此 Agent", back: "返回", costSource: "參考模型單價", readOnly: "重新整理用量不會啟動 Agent。", noResults: "沒有符合篩選的呼叫", filter: "篩選用量", sidebar: "用量總覽" },
    zh: { usage: "用量", subtitle: "看见每一份工作的消耗。", today: "今天", week: "本周", month: "本月", thirty: "30 天", allHosts: "所有 Host", close: "关闭", refresh: "刷新", loading: "正在读取用量…", tokens: "Token 用量", cost: "估算费用", calls: "模型调用", input: "输入", output: "输出", cacheRead: "缓存读取", cacheWrite: "缓存写入", chart: "每日用量", models: "模型", agents: "Agent", projects: "项目", sessions: "Session", allAgents: "所有 Agent", allProjects: "所有项目", allModels: "所有模型", reset: "清除筛选", noData: "这段时间还没有用量记录", noDataHint: "支持的 Agent 保存模型调用后就会显示。也可以切换更长的时间。", estimate: "按 Agent 回报或参考模型单价估算，币种为 USD。订阅配额另外显示；这不是实际账单。", unknownCost: "缺少单价", priced: "已估算 {known}／{total} 次调用", partialCost: "已知部分", scope: "这台电脑可读取的 Agent 记录", workspaceScope: "此 Host 仍只统计工作区，更新后可读取整台电脑的记录。", mixedScope: "部分 Host 仍只统计工作区，更新后才能显示整机用量。", indexing: "正在建立历史索引 · 尚有 {count} 个文件，用量将自动更新。", viewSession: "筛选此 Session", coverage: "已读取 {covered} 个 Session", missing: "{count} 个 Session 暂时无法读取", unsupported: "{count} 个 Session 的 Agent 暂不支持", partial: "部分记录无法读取，目前显示可取得的用量。", offline: "无法连接", retry: "暂时无法读取用量，请重试。", updated: "更新于 {time}", limits: "订阅配额", remaining: "剩余 {percent}%", resetAt: "{time} 重置", quotaUnknown: "暂时无法取得配额", incomplete: "部分调用缺少完整的 Token 数字。", openSession: "打开对话", viewProject: "筛选此项目", viewModel: "筛选此模型", viewAgent: "筛选此 Agent", back: "返回", readOnly: "刷新用量不会启动 Agent。", noResults: "没有符合筛选的调用", filter: "筛选用量", sidebar: "用量总览" },
  };
  Object.assign(strings.en, { more: "Show {count} more", overview: "Limits & usage", limitsTab: "Limits", overviewHint: "Your remaining allowance and the work behind it.", loadingLimits: "Reading limits…", retryLimits: "Could not read limits. Try again.", cachedLimits: "Previous reading", resetsIn: "Resets in {time}", awaitingReset: "Waiting for a new reading", sources: "Manage sources", limitsNote: "Remaining allowance comes from your signed-in services. Token usage and estimated costs are available in Usage." });
  Object.assign(strings["zh-Hant"], { more: "再顯示 {count} 筆", overview: "額度與用量", limitsTab: "額度", overviewHint: "查看剩餘額度，了解每一份工作的用量。", loadingLimits: "正在讀取額度…", retryLimits: "暫時無法讀取額度，請重試。", cachedLimits: "先前讀取的額度", resetsIn: "{time} 後重置", awaitingReset: "等待更新額度", sources: "管理額度來源", limitsNote: "剩餘額度來自已登入的服務；Token 用量與估算費用可在「用量」查看。" });
  Object.assign(strings.zh, { more: "再显示 {count} 条", overview: "额度与用量", limitsTab: "额度", overviewHint: "查看剩余额度，了解每一份工作的用量。", loadingLimits: "正在读取额度…", retryLimits: "暂时无法读取额度，请重试。", cachedLimits: "先前读取的额度", resetsIn: "{time} 后重置", awaitingReset: "等待更新额度", sources: "管理额度来源", limitsNote: "剩余额度来自已登录的服务；Token 用量与估算费用可在“用量”查看。" });
  Object.assign(strings.en, { historyCoverage: "{covered} histories read · all dates", historyMissing: "{count} histories could not be read", issueDetails: "View history issues ({count})", issueScope: "This check covers all saved history, independently of the selected dates and filters.", issueMore: "{count} more issues are not listed.", issue_missing_file: "History file not found", issue_permission_denied: "Permission denied", issue_unsupported_format: "Unsupported history format", issue_identity_mismatch: "History identity does not match", issue_incomplete_records: "Some usage records are incomplete", issue_malformed_records: "Some records contain invalid JSON", issue_record_too_large: "A record exceeds the reading limit", issue_truncated: "The child transcript was truncated", issue_file_limit: "The file exceeds the reading limit", issue_unsafe_file: "History is outside the allowed location or ownership", issue_source_changed: "The file changed while being read; refresh to retry", issue_read_failed: "History could not be read" });
  Object.assign(strings["zh-Hant"], { historyCoverage: "已讀取 {covered} 份歷史紀錄 · 所有日期", historyMissing: "{count} 份歷史紀錄無法讀取", issueDetails: "查看歷史紀錄問題（{count}）", issueScope: "此檢查涵蓋整個歷史庫，不受所選日期與篩選條件限制。", issueMore: "另有 {count} 筆問題未列出。", issue_missing_file: "找不到歷史檔", issue_permission_denied: "沒有讀取權限", issue_unsupported_format: "尚未支援的歷史格式", issue_identity_mismatch: "歷史檔身分與預期不符", issue_incomplete_records: "部分用量紀錄不完整", issue_malformed_records: "部分紀錄的 JSON 格式損壞", issue_record_too_large: "單筆紀錄超過讀取上限", issue_truncated: "子 Agent 匯出紀錄已被截斷", issue_file_limit: "檔案超過讀取上限", issue_unsafe_file: "歷史檔位置或擁有者不符合讀取範圍", issue_source_changed: "讀取時檔案已變更，請重新整理", issue_read_failed: "無法讀取歷史檔" });
  Object.assign(strings.zh, { historyCoverage: "已读取 {covered} 份历史记录 · 所有日期", historyMissing: "{count} 份历史记录无法读取", issueDetails: "查看历史记录问题（{count}）", issueScope: "此检查涵盖整个历史库，不受所选日期与筛选条件限制。", issueMore: "另有 {count} 条问题未列出。", issue_missing_file: "找不到历史文件", issue_permission_denied: "没有读取权限", issue_unsupported_format: "尚未支持的历史格式", issue_identity_mismatch: "历史文件身份与预期不符", issue_incomplete_records: "部分用量记录不完整", issue_malformed_records: "部分记录的 JSON 格式损坏", issue_record_too_large: "单条记录超过读取上限", issue_truncated: "子 Agent 导出记录已被截断", issue_file_limit: "文件超过读取上限", issue_unsafe_file: "历史文件位置或所有者不符合读取范围", issue_source_changed: "读取时文件已变更，请刷新", issue_read_failed: "无法读取历史文件" });
  Object.assign(strings.en, { quotaDisplay: "Display", remainingMode: "Remaining", usedMode: "Used", used: "{percent}% used",
    aggregateDates: "Some usage is a session total, assigned to its session start date. Daily values are approximate.", unknownCalls: "Some sessions did not save their model-call count; they are excluded from that count.", issue_overlapping_history: "Overlapping turn summaries were excluded. The remaining per-call log may cover only part of this session.",
    overviewHint: "Your allowance and the work behind it.", limitsNote: "Allowances come from your signed-in services. Token usage and estimated costs are available in Usage." });
  Object.assign(strings["zh-Hant"], { quotaDisplay: "顯示方式", remainingMode: "剩餘", usedMode: "已用", used: "已用 {percent}%",
    aggregateDates: "部分用量為整段對話總數，按對話開始日期歸檔；每日分布為近似值。", unknownCalls: "部分對話未保存模型呼叫次數，未計入呼叫數。", issue_overlapping_history: "已排除重疊的回合摘要；保留的逐次呼叫紀錄可能只涵蓋部分對話。",
    overviewHint: "查看額度，了解每一份工作的用量。", limitsNote: "額度來自已登入的服務；Token 用量與估算費用可在「用量」查看。" });
  Object.assign(strings.zh, { quotaDisplay: "显示方式", remainingMode: "剩余", usedMode: "已用", used: "已用 {percent}%",
    aggregateDates: "部分用量为整段对话总数，按对话开始日期归档；每日分布为近似值。", unknownCalls: "部分对话未保存模型调用次数，未计入调用数。", issue_overlapping_history: "已排除重叠的回合摘要；保留的逐次调用记录可能只涵盖部分对话。",
    overviewHint: "查看额度，了解每一份工作的用量。", limitsNote: "额度来自已登录的服务；Token 用量与估算费用可在“用量”查看。" });
  const QUOTA_DISPLAY_KEY = "stepsemble.quota-display.v1";
  function readQuotaMode() { try { return root.localStorage?.getItem(QUOTA_DISPLAY_KEY) === "used" ? "used" : "remaining"; } catch { return "remaining"; } }
  let quotaMode = readQuotaMode();
  function quotaRemaining(window) {
    const value = Number.isFinite(window?.remainingPercent) ? window.remainingPercent : Number.isFinite(window?.usedPercent) ? 100 - window.usedPercent : null;
    return value === null ? null : Math.max(0, Math.min(100, Math.round(value)));
  }
  function quotaPercent(window) { const remaining = quotaRemaining(window); return remaining === null ? null : quotaMode === "used" ? 100 - remaining : remaining; }
  function quotaLabel(window) { const percent = quotaPercent(window); return percent === null ? label("quotaUnknown") : label(quotaMode, { percent }); }
  const localeOf = () => document.documentElement.lang || "en";
  function label(key, vars = {}) { const locale = localeOf(); return (strings[locale]?.[key] || strings.en[key] || key).replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? ""); }
  const node = (tag, value = "", className = "") => { const el = document.createElement(tag); el.textContent = value; el.className = className; return el; };
  function button(value, action, className = "") { const el = node("button", value, className); el.type = "button"; el.onclick = action; return el; }
  const fmt = (n, compact = false) => new Intl.NumberFormat(localeOf(), compact ? { notation: "compact", maximumFractionDigits: 1 } : { maximumFractionDigits: 0 }).format(n || 0);
  function money(total, compact = false) {
    if (!(total?.pricedCalls || total?.unknownPricedRecords)) return "—";
    const short = compact && total.knownCost >= 1000;
    return (total.unpricedCalls || total.unknownUnpricedRecords ? "≥ " : "≈ ") + new Intl.NumberFormat(localeOf(), { style: "currency", currency: "USD", ...(short ? { notation: "compact", maximumFractionDigits: 1, minimumFractionDigits: 0 } : { maximumFractionDigits: 2, minimumFractionDigits: 2 }) }).format(total.knownCost);
  }
  const agentName = id => ({ pi: "Pi", codex: "Codex", "claude-code": "Claude Code", omp: "Oh My Pi", opencode: "OpenCode", hermes: "Hermes", gemini: "Gemini CLI", cline: "Cline", "kilo": "Kilo Code", "roo-code": "Roo Code", "grok-build": "Grok Build", antigravity: "Antigravity" })[id] || id;
  const vendorNames = { openai: "OpenAI", anthropic: "Anthropic", minimax: "MiniMax", z_ai: "Z.AI", deepseek: "DeepSeek", gemini: "Google", xai: "xAI" };
  const vendorName = id => Object.hasOwn(vendorNames, id) ? vendorNames[id] : id;
  const modelLabel = row => { const identity = Data.modelIdentity(row.provider, row.name); return { name: identity.model, provider: vendorName(identity.provider) }; };
  function range(period, now = new Date()) {
    const to = new Date(now); to.setHours(0, 0, 0, 0); to.setDate(to.getDate() + 1);
    const from = new Date(to); from.setDate(from.getDate() - 1);
    if (period === "week") from.setDate(from.getDate() - (from.getDay() + 6) % 7);
    else if (period === "month") from.setDate(1);
    else if (period === "thirty") from.setDate(from.getDate() - 29);
    return { from: from.getTime(), to: to.getTime(), timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC" };
  }
  function dateKey(date) { return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`; }
  function create({ api, context, openConversation, onVisibility = () => {}, onHostSelected = () => {}, onQuotaUpdated = () => {}, onQuotaDisplayChanged = () => {}, openQuotaSources = () => {}, providerLogo = () => node("span"), restoreFocus = () => {} }) {
    let indexingTimer;
    let panel = null, selectedHost = "", period = "week", lens = "models", sequence = 0, timer, anchor, current = null, tab = "limits";
    let filters = { agent: "", project: "", model: "", entry: "" }, view = null, previous = null, quotas = [], hostChoices = [];
    let scrolls = { limits: 0, usage: 0 }, issuesOpen = false;
    const hostGrouping = new Map();
    function selectQuotaMode(value) {
      if (value === quotaMode) return;
      quotaMode = value === "used" ? "used" : "remaining";
      try { root.localStorage?.setItem(QUOTA_DISPLAY_KEY, quotaMode); } catch { /* Still usable when device storage is unavailable. */ }
      if (panel && tab === "limits") renderLimits();
      onQuotaDisplayChanged();
    }
    function close() { if (!panel) return; sequence++; clearInterval(timer); clearTimeout(indexingTimer); panel.close(); panel.remove(); panel = null; view = null; onVisibility(); if (anchor?.isConnected) anchor.focus({ preventScroll: true }); else restoreFocus(); }
    function makeSelect(name, values, value, changed) {
      const select = node("select"); select.setAttribute("aria-label", label(name)); select.dataset.filter = name;
      for (const [id, title] of values) { const option = node("option", title); option.value = id; select.append(option); }
      select.value = value; select.onchange = () => changed(select.value); return select;
    }
    function status(value, kind = "") { const note = view.status; note.textContent = value; note.dataset.kind = kind; }
    function schedule() { clearInterval(timer); timer = setInterval(() => { if (panel && !document.hidden) void load(); }, tab === "limits" ? 120000 : 60000); }
    function selectTab(value) {
      if (value === tab) return;
      clearTimeout(indexingTimer); scrolls[tab] = view.body.scrollTop; tab = value;
      for (const control of view.tabs.children) { const active = control.dataset.overviewTab === tab; control.setAttribute("aria-selected", String(active)); control.tabIndex = active ? 0 : -1; }
      view.body.setAttribute("aria-labelledby", "usage-tab-" + tab); panel.dataset.tab = tab;
      if (tab === "usage" && previous) render(previous);
      else if (tab === "limits" && quotas.length) renderLimits();
      else renderEmpty(label(tab === "limits" ? "loadingLimits" : "loading"));
      view.body.scrollTop = scrolls[tab]; schedule(); void load();
    }
    function selectHost(value, notify = true) {
      if (selectedHost === value) return;
      selectedHost = value; view.host.value = value; previous = null; quotas = []; filters = { agent: "", project: "", model: "", entry: "" }; scrolls = { limits: 0, usage: 0 }; view.body.scrollTop = 0;
      if (notify && value) onHostSelected(value);
      void load();
    }
    async function load(fresh = false) {
      clearTimeout(indexingTimer);
      const epoch = ++sequence, loadingTab = tab, targets = selectedHost ? hostChoices.filter(item => item.id === selectedHost) : hostChoices;
      const query = new URLSearchParams({ ...range(period), ...filters, ...(fresh ? { fresh: "1" } : {}) });
      const loading = label(tab === "limits" ? "loadingLimits" : "loading");
      if (tab === "limits" ? !quotas.length : !previous) renderEmpty(loading);
      status(loading); view.refresh.disabled = true; panel.setAttribute("aria-busy", "true");
      const results = await Promise.all(targets.map(async host => {
        try {
          const value = loadingTab === "limits" ? await api("/api/workspace/usage" + (fresh ? "?fresh=1" : ""), undefined, host.id)
            : await Data.readReport(params => {
              if (!panel || epoch !== sequence) throw new Error("usage_read_cancelled");
              return api("/api/workspace/analytics?" + params, undefined, host.id);
            }, query, { modelGrouping: hostGrouping.get(host.id) });
          return { host: host.id, name: host.name, [loadingTab === "limits" ? "quota" : "report"]: value };
        } catch { return { host: host.id, name: host.name }; }
      }));
      if (!panel || epoch !== sequence) return;
      view.refresh.disabled = false; panel.removeAttribute("aria-busy");
      if (loadingTab === "limits") {
        // A failed reading can retain only this selection's earlier values,
        // explicitly marked as cached, never another Host's quota.
        quotas = results.map(result => result.quota ? result : { ...result, quota: quotas.find(old => old.host === result.host)?.quota, unavailable: true });
        renderLimits();
        for (const result of results) if (result.quota) onQuotaUpdated(result.host, result.quota);
        const succeeded = results.some(item => item.quota);
        status(succeeded ? label("updated", { time: new Date().toLocaleTimeString(localeOf(), { hour: "2-digit", minute: "2-digit" }) }) : label("retryLimits"), succeeded ? "" : "error");
        return;
      }
      const succeeded = results.some(item => item.report);
      if (!succeeded) { status(label("retry"), "error"); if (!previous) renderEmpty(label("retry")); return; }
      for (const result of results) if (result.report) hostGrouping.set(result.host, result.report.modelGrouping);
      previous = Data.combine(results); current = previous;
      current.facets = { agents: new Map(), projects: new Map(), models: new Map() };
      for (const result of results) for (const key of Object.keys(current.facets)) for (const item of result.report?.facets?.[key] || []) {
        if (key === "projects") {
          const old = current.facets.projects.get(item.id), hosts = [...new Set([...(old?.hostNames || []), result.name])];
          current.facets.projects.set(item.id, { ...item, hostNames: hosts });
        } else if (key === "models") { const model = Data.modelGroup(item); current.facets.models.set(model.id, model); }
        else current.facets[key].set(item.id, item);
      }
      render(current); status(label("updated", { time: new Date().toLocaleTimeString(localeOf(), { hour: "2-digit", minute: "2-digit" }) }));
      if (current.coverage.indexing) indexingTimer = setTimeout(() => { if (panel && tab === "usage" && !document.hidden) void load(); }, 2000);
    }
    function renderEmpty(title) {
      view.body.replaceChildren(node("p", title, "usage-empty"));
    }
    function render(data) {
      const body = view.body, scroll = body.scrollTop, active = body.contains(document.activeElement) ? document.activeElement : null;
      const focus = active?.dataset.period ? ["period", active.dataset.period] : active?.dataset.filter ? ["filter", active.dataset.filter] : active?.dataset.lens ? ["lens", active.dataset.lens]
        : active?.dataset.date ? ["date", active.dataset.date] : active?.dataset.row ? ["row", active.dataset.row] : null;
      body.replaceChildren();
      body.append(view.periods);
      const filtersBar = node("div", "", "usage-filters");
      for (const [key, collection, name] of [["agent", "agents", "allAgents"], ["project", "projects", "allProjects"], ["model", "models", "allModels"]]) {
        const items = [...data.facets[collection].values()], duplicates = title => items.filter(item => item.name === title).length > 1;
        const options = [["", label(name)], ...items.map(item => {
          const model = key === "model" ? modelLabel(item) : null;
          return [item.id, model ? model.name + (model.provider ? " · " + model.provider : "") : key === "agent" ? agentName(item.id)
            : item.name + (!selectedHost ? " · " + item.hostNames.join(", ") : duplicates(item.name) ? " · " + item.id : "")];
        })];
        if (filters[key] && !options.some(([id]) => id === filters[key])) options.push([filters[key], filters[key]]);
        filtersBar.append(makeSelect(name, options, filters[key], value => { filters[key] = value; filters.entry = ""; previous = null; void load(); }));
      }
      if (Object.values(filters).some(Boolean)) filtersBar.append(button(label("reset"), () => { filters = { agent: "", project: "", model: "", entry: "" }; previous = null; void load(); }, "usage-clear"));
      body.append(filtersBar);
      if (filters.entry) {
        const session = data.sessions.find(row => row.nativeId === filters.entry);
        const chip = button("Session · " + (session?.name || filters.entry.replace(/^native:[^:]+:/, "").slice(0, 8)) + " ×", () => { filters.entry = ""; previous = null; void load(); }, "usage-session-filter");
        chip.title = label("reset"); body.append(chip);
      }
      const metrics = node("section", "", "usage-metrics"); metrics.setAttribute("aria-label", label("usage"));
      const unreadable = !data.coverage.covered && (data.coverage.missing || data.coverage.partial || data.coverage.unsupported || data.coverage.indexing);
      for (const [key, value, sub] of [["tokens", unreadable ? "—" : fmt(data.total.tokens), ""], ["cost", money(data.total, true), data.total.unknownCalls ? label("unknownCalls") : label("priced", { known: fmt(data.total.pricedCalls), total: fmt(data.total.calls) })], ["calls", unreadable || data.total.unknownCalls && !data.total.calls ? "—" : (data.total.unknownCalls ? "≥ " : "") + fmt(data.total.calls), label(data.coverage.scope === "history" ? "historyCoverage" : "coverage", { covered: fmt(data.coverage.covered) })]]) {
        const card = node("div", "", "usage-metric"); card.dataset.metric = key; card.append(node("span", label(key)), node("strong", value));
        if (key === "cost" && data.total.knownCost >= 1000) card.append(node("small", money(data.total)));
        card.append(node("small", sub)); metrics.append(card);
      }
      body.append(metrics);
      const components = node("div", "", "usage-components");
      for (const key of ["input", "output", "cacheRead", "cacheWrite"]) {
        const row = node("div"); row.dataset.token = key; row.append(node("span", label(key)), node("strong", fmt(data.total[key], true))); components.append(row);
      }
      body.append(components);
      const notices = [];
      if (data.hosts.some(host => host.status === "unavailable")) notices.push(data.hosts.filter(h => h.status === "unavailable").map(h => h.name + " · " + label("offline")).join(" · "));
      if (data.coverage.missing) notices.push(label(data.coverage.scope === "history" ? "historyMissing" : "missing", { count: fmt(data.coverage.missing) }));
      if (data.coverage.unsupported) notices.push(label("unsupported", { count: fmt(data.coverage.unsupported) }));
      if (data.coverage.partial) notices.push(label("partial"));
      if (data.coverage.indexing) notices.push(label("indexing", { count: fmt(data.coverage.indexing) }));
      if (data.total.incompleteCalls) notices.push(label("incomplete"));
      if (data.dateApproximateRecords) notices.push(label("aggregateDates"));
      if (data.total.unknownCalls) notices.push(label("unknownCalls"));
      if (notices.length) { const note = node("p", notices.join(" · "), "usage-notice"); note.setAttribute("role", "status"); body.append(note); }
      if (data.issues?.length) {
        const details = node("details", "", "usage-issues"), list = node("ul"); details.open = issuesOpen;
        details.append(node("summary", label("issueDetails", { count: fmt(data.issues.length + data.coverage.issuesOmitted) })), node("p", label("issueScope")));
        details.ontoggle = () => { if (details.isConnected) issuesOpen = details.open; };
        for (const issue of [...data.issues].sort((a, b) => (a.status === "partial") - (b.status === "partial"))) {
          const row = node("li"); row.dataset.reason = issue.reason;
          row.append(node("strong", issue.name || agentName(issue.agent)), node("span", label("issue_" + issue.reason)));
          row.append(node("small", [issue.hostName, agentName(issue.agent), issue.path].filter(Boolean).join(" · "))); list.append(row);
        }
        details.append(list);
        if (data.coverage.issuesOmitted) details.append(node("p", label("issueMore", { count: fmt(data.coverage.issuesOmitted) })));
        body.append(details);
      }
      if (!data.total.calls) {
        const empty = node("section", "", "usage-empty"); empty.append(node("h2", Object.values(filters).some(Boolean) ? label("noResults") : label("noData")), node("p", label("noDataHint"))); body.append(empty);
      } else { body.append(chart(data)); body.append(breakdown(data)); }
      const foot = node("footer", "", "usage-explanation"); foot.append(node("p", label("estimate")), node("small", label(data.scope === "workspace" ? "workspaceScope" : data.scope === "mixed" ? "mixedScope" : "scope")));
      if (data.priceUpdatedAt) foot.append(node("small", label("costSource") + " · " + new Date(data.priceUpdatedAt).toLocaleDateString(localeOf())));
      body.append(foot);
      if (focus) [...body.querySelectorAll("[data-" + focus[0] + "]")].find(el => el.dataset[focus[0]] === focus[1])?.focus({ preventScroll: true });
      body.scrollTop = scroll;
    }
    function chart(data) {
      const section = node("section", "", "usage-chart-section"); section.append(node("h2", label("chart")));
      const graph = node("div", "", "usage-chart"), detail = node("p", "", "usage-chart-detail"); graph.setAttribute("role", "list"); graph.setAttribute("aria-label", label("chart"));
      detail.setAttribute("aria-live", "polite");
      const byDate = new Map(data.days.map(day => [day.date, day])), dates = [], bounds = range(period);
      for (const day = new Date(bounds.from); day.getTime() < bounds.to; day.setDate(day.getDate() + 1)) dates.push(new Date(day));
      const max = Math.max(1, ...data.days.map(day => day.tokens));
      for (const [index, day] of dates.entries()) {
        const row = byDate.get(dateKey(day)) || Data.empty();
        const column = node("div", "", "usage-chart-column"); column.setAttribute("role", "listitem"); column.dataset.date = dateKey(day);
        const spoken = day.toLocaleDateString(localeOf(), { month: "short", day: "numeric" }) + " · " + fmt(row.tokens) + " tokens · " + money(row);
        column.setAttribute("aria-label", spoken); column.title = spoken; column.tabIndex = 0;
        const showDay = () => {
          for (const item of graph.children) delete item.dataset.selected;
          column.dataset.selected = "true"; detail.replaceChildren(node("span", day.toLocaleDateString(localeOf(), { month: "short", day: "numeric" })),
            node("strong", fmt(row.tokens) + " tokens"), node("span", money(row)));
        };
        column.onclick = showDay; column.onfocus = showDay;
        column.onkeydown = event => { if (["Enter", " "].includes(event.key)) { event.preventDefault(); showDay(); } };
        const stack = node("div", "", "usage-chart-stack"); stack.style.height = Math.max(row.tokens ? 2 : 0, row.tokens / max * 100) + "%";
        for (const key of ["cacheWrite", "cacheRead", "input", "output"]) { const part = node("span"); part.dataset.token = key; part.style.flexGrow = String(row[key] || 0); stack.append(part); }
        const base = node("div", "", "usage-chart-base"); base.append(stack); column.append(base);
        column.append(node("span", dates.length <= 7 || index === 0 || index === dates.length - 1 || index % 7 === 0 ? String(day.getDate()) : "", "usage-chart-date")); graph.append(column);
        if (index === dates.length - 1) showDay();
      }
      section.append(graph, detail); return section;
    }
    function breakdown(data) {
      const section = node("section", "", "usage-breakdown"), tabs = node("div", "", "usage-tabs"); tabs.setAttribute("role", "tablist"); tabs.setAttribute("aria-label", label("filter"));
      const list = node("div", "", "usage-list"); list.id = "usage-breakdown-list"; list.setAttribute("role", "tabpanel");
      let limit = 200;
      function rows() {
        list.replaceChildren(); list.setAttribute("aria-label", label(lens));
        const header = node("div", "", "usage-list-head"); header.append(node("span", label(lens)), node("span", label("tokens")), node("span", label("cost"))); list.append(header);
        const values = data[lens] || [], max = Math.max(1, ...values.map(row => row.tokens));
        for (const row of values.slice(0, limit)) {
          const el = button("", () => {
            if (lens === "sessions" && row.registered !== false) { close(); openConversation(row.nativeId, row.name, row.host); }
            else if (lens === "sessions") { filters = { agent: "", project: "", model: "", entry: row.nativeId }; if (selectedHost !== row.host) { selectedHost = row.host; view.host.value = selectedHost; quotas = []; onHostSelected(selectedHost); } previous = null; void load(); }
            else { filters.entry = ""; filters[lens === "models" ? "model" : lens === "projects" ? "project" : "agent"] = lens === "projects" ? row.cwd : row.id; if (lens === "projects" && selectedHost !== row.host) { selectedHost = row.host; view.host.value = selectedHost; quotas = []; onHostSelected(selectedHost); } previous = null; void load(); }
          }, "usage-list-row");
          el.dataset.row = row.id;
          el.title = label(lens === "sessions" ? row.registered === false ? "viewSession" : "openSession" : lens === "models" ? "viewModel" : lens === "projects" ? "viewProject" : "viewAgent");
          const model = lens === "models" ? modelLabel(row) : null;
          const identity = node("span", "", "usage-list-identity"); identity.append(node("strong", model ? model.name : lens === "agents" ? agentName(row.name) : row.name));
          const detail = model ? model.provider : lens === "sessions" ? agentName(row.agent) + " · " + row.hostName : lens === "projects" ? row.hostName + " · " + row.cwd : "";
          if (detail) identity.append(node("small", detail));
          const amount = node("span", "", "usage-list-amount"); amount.append(node("strong", fmt(row.tokens, true)));
          const track = node("span", "", "usage-row-track"), fill = node("span"); fill.style.width = row.tokens / max * 100 + "%"; track.append(fill); amount.append(track);
          const cost = node("span", money(row, true), "usage-list-cost"); cost.title = money(row) + " · " + label("priced", { known: row.pricedCalls, total: row.calls });
          el.append(identity, amount, cost); list.append(el);
        }
        if (values.length > limit) list.append(button(label("more", { count: Math.min(200, values.length - limit) }), () => { limit += 200; rows(); }, "usage-more"));
      }
      const controls = [];
      for (const key of ["models", "projects", "agents", "sessions"]) {
        const control = button(label(key), () => { lens = key; limit = 200; for (const tab of controls) { const active = tab.dataset.lens === lens; tab.setAttribute("aria-selected", String(active)); tab.tabIndex = active ? 0 : -1; } rows(); }, "usage-tab");
        control.dataset.lens = key; control.setAttribute("role", "tab"); control.setAttribute("aria-controls", list.id); control.setAttribute("aria-selected", String(lens === key)); control.tabIndex = lens === key ? 0 : -1;
        control.onkeydown = event => { if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) { event.preventDefault(); const next = event.key === "Home" ? 0 : event.key === "End" ? 3 : (controls.indexOf(control) + (event.key === "ArrowLeft" ? 3 : 1)) % 4; controls[next].click(); controls[next].focus(); } };
        controls.push(control); tabs.append(control);
      }
      section.append(tabs, list); rows(); return section;
    }
    function renderLimits() {
      const body = view.body, scroll = body.scrollTop, focused = body.contains(document.activeElement) ? document.activeElement?.dataset : null;
      body.replaceChildren();
      const toolbar = node("div", "", "usage-quota-toolbar"), toggle = node("div", "", "usage-quota-toggle");
      toggle.setAttribute("role", "group"); toggle.setAttribute("aria-label", label("quotaDisplay"));
      for (const mode of ["remaining", "used"]) {
        const control = button(label(mode + "Mode"), () => selectQuotaMode(mode)); control.dataset.quotaMode = mode;
        control.setAttribute("aria-pressed", String(mode === quotaMode)); toggle.append(control);
      }
      toolbar.append(node("span", label("quotaDisplay")), toggle); body.append(toolbar);
      const section = node("section", "", "usage-quotas"); section.setAttribute("aria-label", label("limitsTab"));
      const grid = node("div", "", "usage-quota-grid");
      const duration = minutes => minutes % 1440 === 0 ? minutes / 1440 + "d" : minutes % 60 === 0 ? minutes / 60 + "h" : minutes + "m";
      for (const host of quotas) {
        if (host.unavailable) { const notice = node("p", host.name + " · " + label("offline") + (host.quota ? " · " + label("cachedLimits") : ""), "usage-notice"); notice.setAttribute("role", "status"); body.append(notice); }
        if (!host.quota?.providers?.length) {
          const empty = node("div", "", "usage-quota-empty"); empty.append(node("strong", host.name), node("p", label("quotaUnknown"))); section.append(empty);
        }
      }
      const providers = root.StepsembleUsageData.combineQuotas(quotas).sort((a, b) => {
        const tightest = provider => Math.min(101, ...(provider.windows || []).map(w => quotaRemaining(w) ?? 101));
        return tightest(a) - tightest(b);
      });
      for (const provider of providers) {
        const cached = provider.cached;
        const card = node("article", "", "usage-quota-card"); card.dataset.cached = String(!!cached);
        const heading = node("header", "", "usage-quota-heading"), identity = node("div", "", "usage-quota-identity");
        identity.append(node("strong", provider.provider), node("small", provider.hosts.map(host => host.name).join(" · "))); heading.append(providerLogo(provider.provider), identity);
        if (cached) heading.append(node("span", label("cachedLimits"), "usage-quota-cached"));
        card.append(heading);
        const readings = node("div", "", "usage-quota-windows");
        const windows = [...(provider.windows || [])].sort((a, b) => (a.windowDurationMins ?? Infinity) - (b.windowDurationMins ?? Infinity));
        readings.style.setProperty("--quota-columns", String(Math.min(3, Math.max(2, windows.length))));
        if (!windows.length) readings.append(node("p", label("quotaUnknown"), "usage-quota-unknown usage-muted"));
        for (const window of windows) {
          const remaining = quotaRemaining(window), percent = quotaPercent(window);
          const row = node("div", "", "usage-quota-window"); row.dataset.level = remaining === null || remaining > 25 ? "ok" : remaining <= 10 ? "critical" : "low";
          const minutes = window.windowDurationMins, period = Number.isFinite(minutes) && minutes > 0 ? duration(minutes) : window.label || "";
          const bucket = window.bucket && ![provider.provider, provider.service].some(name => String(name || "").toLowerCase() === String(window.bucket).toLowerCase()) ? window.bucket : "";
          const name = [bucket, period].filter(Boolean).join(" · ") || label("limitsTab"), value = quotaLabel(window);
          const line = node("div", "", "usage-quota-line"), amount = node("strong", percent === null ? "—" : percent + "%");
          amount.setAttribute("aria-label", value); amount.title = value;
          line.append(node("span", name), amount);
          const bar = node("div", "", "usage-quota-bar"); bar.setAttribute("role", "progressbar"); bar.setAttribute("aria-label", provider.provider + " · " + name + " · " + value);
          bar.setAttribute("aria-valuemin", "0"); bar.setAttribute("aria-valuemax", "100"); if (percent !== null) { bar.setAttribute("aria-valuenow", String(percent)); bar.setAttribute("aria-valuetext", value); }
          const fill = node("span"); fill.style.width = (percent ?? 0) + "%"; bar.append(fill); row.append(line, bar);
          if (window.resetsAt) {
            const left = Math.max(0, Math.ceil((window.resetsAt - Date.now()) / 60000)), days = Math.floor(left / 1440), hours = Math.floor(left % 1440 / 60);
            const reset = node("small", left ? label("resetsIn", { time: days ? `${days}d ${hours}h` : hours ? `${hours}h ${left % 60}m` : `${left}m` }) : label("awaitingReset"));
            reset.title = label("resetAt", { time: new Date(window.resetsAt).toLocaleString(localeOf()) }); row.append(reset);
          }
          readings.append(row);
        }
        if (cached && provider.observedAt) readings.append(node("small", label("updated", { time: new Date(provider.observedAt).toLocaleString(localeOf()) }), "usage-quota-observed usage-muted"));
        card.append(readings);
        grid.append(card);
      }
      for (const host of quotas) {
        const sources = button(label("sources") + (!selectedHost ? " · " + host.name : ""), () => { close(); openQuotaSources(host.host); }, "usage-quota-sources");
        sources.dataset.quotaSource = host.host; section.append(sources);
      }
      if (grid.children.length) section.prepend(grid);
      body.append(section, node("p", label("limitsNote"), "usage-explanation usage-muted"));
      if (focused?.quotaSource) [...body.querySelectorAll("[data-quota-source]")].find(el => el.dataset.quotaSource === focused.quotaSource)?.focus({ preventScroll: true });
      else if (focused?.quotaMode) [...body.querySelectorAll("[data-quota-mode]")].find(el => el.dataset.quotaMode === focused.quotaMode)?.focus({ preventScroll: true });
      body.scrollTop = scroll;
    }
    async function open(target, trigger = document.activeElement, options = {}) {
      if (panel) return;
      const ctx = context(); hostChoices = ctx.hosts; selectedHost = options.allHosts ? "" : target || ctx.selected; anchor = trigger; previous = null; quotas = []; tab = options.tab === "usage" ? "usage" : "limits"; scrolls = { limits: 0, usage: 0 }; filters = { agent: typeof options.agent === "string" && /^[a-zA-Z0-9_-]{1,80}$/.test(options.agent) ? options.agent : "", project: "", model: "", entry: "" };
      panel = node("dialog", "", "usage-panel"); panel.id = "usage-panel"; panel.dataset.tab = tab; panel.setAttribute("aria-labelledby", "usage-title");
      const header = node("header", "", "usage-header"), brand = node("div", "", "usage-brand");
      const logo = node("span", "", "workspace-logo"); logo.setAttribute("aria-hidden", "true"); brand.append(logo, node("strong", "Stepsemble"));
      const closeButton = button("×", close, "usage-close"); closeButton.setAttribute("aria-label", label("close"));
      const tabs = node("div", "", "usage-view-tabs"); tabs.setAttribute("role", "tablist"); tabs.setAttribute("aria-label", label("overview"));
      for (const key of ["limits", "usage"]) {
        const control = button(label(key === "limits" ? "limitsTab" : "usage"), () => selectTab(key)); control.id = "usage-tab-" + key; control.dataset.overviewTab = key;
        control.setAttribute("role", "tab"); control.setAttribute("aria-controls", "usage-view"); control.setAttribute("aria-selected", String(key === tab)); control.tabIndex = key === tab ? 0 : -1;
        control.onkeydown = event => { if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) { event.preventDefault(); const next = event.key === "Home" ? tabs.firstElementChild : event.key === "End" ? tabs.lastElementChild : key === "limits" ? tabs.lastElementChild : tabs.firstElementChild; next.click(); next.focus(); } };
        tabs.append(control);
      }
      header.append(brand, tabs, closeButton);
      const top = node("div", "", "usage-top"), heading = node("div", "", "usage-heading"), title = node("h1", label("overview")); title.id = "usage-title";
      heading.append(title, node("p", label("overviewHint"))); top.append(heading);
      const controls = node("div", "", "usage-controls"), periods = node("div", "", "usage-periods"); periods.setAttribute("role", "group"); periods.setAttribute("aria-label", label("chart"));
      for (const key of ["today", "week", "month", "thirty"]) {
        const b = button(label(key), () => { period = key; for (const control of periods.children) control.setAttribute("aria-pressed", String(control === b)); previous = null; void load(); });
        b.dataset.period = key; b.setAttribute("aria-pressed", String(period === key)); periods.append(b);
      }
      const host = makeSelect("host", [["", label("allHosts")], ...hostChoices.map(item => [item.id, item.name])], selectedHost, value => selectHost(value));
      const refresh = button("↻", () => void load(true), "usage-refresh"); refresh.setAttribute("aria-label", label("refresh"));
      controls.append(host, refresh); top.append(controls);
      const statusNote = node("p", label("loadingLimits"), "usage-status"); statusNote.setAttribute("role", "status");
      const body = node("div", "", "usage-body"); body.id = "usage-view"; body.setAttribute("role", "tabpanel"); body.setAttribute("aria-labelledby", "usage-tab-" + tab); view = { body, status: statusNote, refresh, host, tabs, periods };
      panel.append(header, top, statusNote, body); document.body.append(panel); panel.showModal(); closeButton.focus({ preventScroll: true }); onVisibility();
      panel.addEventListener("cancel", event => { event.preventDefault(); close(); });
      schedule(); await load();
    }
    document.addEventListener("visibilitychange", () => { if (panel && !document.hidden) void load(); });
    root.addEventListener?.("storage", event => {
      if (event.key !== null && event.key !== QUOTA_DISPLAY_KEY) return;
      const next = readQuotaMode(); if (next === quotaMode) return; quotaMode = next;
      if (panel && tab === "limits") renderLimits(); onQuotaDisplayChanged();
    });
    return { open, close, label, followHost(target) { if (panel) selectHost(target, false); }, isOpen: () => !!panel };
  }
  root.StepsembleUsageUI = { create, label, range, money, quotaRemaining, quotaPercent, quotaLabel };
})(window);
