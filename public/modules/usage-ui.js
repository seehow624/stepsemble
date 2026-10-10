(function (root) {
  "use strict";
  const Data = root.StepsembleUsageData;
  const strings = {
    en: { usage: "Usage", subtitle: "A clearer view of the work you do.", today: "Today", week: "This week", month: "This month", thirty: "30 days", allHosts: "All Hosts", host: "Host", close: "Close", refresh: "Refresh", loading: "Reading usage…", tokens: "Tokens", cost: "Estimated cost", calls: "Model calls", input: "Input", output: "Output", cacheRead: "Cache read", cacheWrite: "Cache write", chart: "Daily usage", models: "Models", agents: "Agents", projects: "Projects", sessions: "Sessions", allAgents: "All agents", allProjects: "All projects", allModels: "All models", reset: "Clear filters", noData: "No recorded usage in this period", noDataHint: "Usage appears after a supported agent records a model call. Try a longer period.", estimate: "USD estimate from agent reports or reference model prices. Subscription allowance is shown separately; this is not a bill.", unknownCost: "Price unavailable", priced: "{known} of {total} calls priced", partialCost: "Known portion", scope: "Sessions added to this workspace · Codex, Claude Code and Pi", coverage: "{covered} sessions read", missing: "{count} sessions unavailable", unsupported: "{count} sessions use an unsupported agent", partial: "Some records could not be read. Totals show the available portion.", offline: "Unavailable", retry: "Could not read usage. Try again.", updated: "Updated {time}", limits: "Subscription limits", remaining: "{percent}% remaining", resetAt: "Resets {time}", quotaUnknown: "Limits unavailable", incomplete: "Some calls have incomplete token counts.", openSession: "Open conversation", viewProject: "Filter this project", viewModel: "Filter this model", viewAgent: "Filter this agent", back: "Back", costSource: "Reference model prices", readOnly: "Usage refresh never starts an agent.", noResults: "No calls match these filters", filter: "Filter usage", sidebar: "Usage overview" },
    "zh-Hant": { usage: "用量", subtitle: "看見每一份工作的消耗。", today: "今天", week: "本週", month: "本月", thirty: "30 天", allHosts: "所有 Host", host: "Host", close: "關閉", refresh: "重新整理", loading: "正在讀取用量…", tokens: "Token 用量", cost: "估算費用", calls: "模型呼叫", input: "輸入", output: "輸出", cacheRead: "快取讀取", cacheWrite: "快取寫入", chart: "每日用量", models: "模型", agents: "Agent", projects: "專案", sessions: "Session", allAgents: "所有 Agent", allProjects: "所有專案", allModels: "所有模型", reset: "清除篩選", noData: "這段期間還沒有用量紀錄", noDataHint: "支援的 Agent 保存模型呼叫後就會顯示。也可以切換更長的期間。", estimate: "依 Agent 回報或參考模型單價估算，幣別為 USD。訂閱配額另外顯示；這不是實際帳單。", unknownCost: "缺少單價", priced: "已估算 {known}／{total} 次呼叫", partialCost: "已知部分", scope: "已加入此工作區的 Session · Codex、Claude Code、Pi", coverage: "已讀取 {covered} 個 Session", missing: "{count} 個 Session 暫時無法讀取", unsupported: "{count} 個 Session 的 Agent 暫不支援", partial: "部分紀錄無法讀取，目前顯示可取得的用量。", offline: "無法連線", retry: "暫時無法讀取用量，請重試。", updated: "更新於 {time}", limits: "訂閱配額", remaining: "剩餘 {percent}%", resetAt: "{time} 重置", quotaUnknown: "暫時無法取得配額", incomplete: "部分呼叫缺少完整的 Token 數字。", openSession: "開啟對話", viewProject: "篩選此專案", viewModel: "篩選此模型", viewAgent: "篩選此 Agent", back: "返回", costSource: "參考模型單價", readOnly: "重新整理用量不會啟動 Agent。", noResults: "沒有符合篩選的呼叫", filter: "篩選用量", sidebar: "用量總覽" },
    zh: { usage: "用量", subtitle: "看见每一份工作的消耗。", today: "今天", week: "本周", month: "本月", thirty: "30 天", allHosts: "所有 Host", close: "关闭", refresh: "刷新", loading: "正在读取用量…", tokens: "Token 用量", cost: "估算费用", calls: "模型调用", input: "输入", output: "输出", cacheRead: "缓存读取", cacheWrite: "缓存写入", chart: "每日用量", models: "模型", agents: "Agent", projects: "项目", sessions: "Session", allAgents: "所有 Agent", allProjects: "所有项目", allModels: "所有模型", reset: "清除筛选", noData: "这段时间还没有用量记录", noDataHint: "支持的 Agent 保存模型调用后就会显示。也可以切换更长的时间。", estimate: "按 Agent 回报或参考模型单价估算，币种为 USD。订阅配额另外显示；这不是实际账单。", unknownCost: "缺少单价", priced: "已估算 {known}／{total} 次调用", partialCost: "已知部分", scope: "已加入此工作区的 Session · Codex、Claude Code、Pi", coverage: "已读取 {covered} 个 Session", missing: "{count} 个 Session 暂时无法读取", unsupported: "{count} 个 Session 的 Agent 暂不支持", partial: "部分记录无法读取，目前显示可取得的用量。", offline: "无法连接", retry: "暂时无法读取用量，请重试。", updated: "更新于 {time}", limits: "订阅配额", remaining: "剩余 {percent}%", resetAt: "{time} 重置", quotaUnknown: "暂时无法取得配额", incomplete: "部分调用缺少完整的 Token 数字。", openSession: "打开对话", viewProject: "筛选此项目", viewModel: "筛选此模型", viewAgent: "筛选此 Agent", back: "返回", readOnly: "刷新用量不会启动 Agent。", noResults: "没有符合筛选的调用", filter: "筛选用量", sidebar: "用量总览" },
  };
  Object.assign(strings.en, { more: "Show {count} more" });
  Object.assign(strings["zh-Hant"], { more: "再顯示 {count} 筆" });
  Object.assign(strings.zh, { more: "再显示 {count} 条" });
  const localeOf = () => document.documentElement.lang || "en";
  function label(key, vars = {}) { const locale = localeOf(); return (strings[locale]?.[key] || strings.en[key] || key).replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? ""); }
  const node = (tag, value = "", className = "") => { const el = document.createElement(tag); el.textContent = value; el.className = className; return el; };
  function button(value, action, className = "") { const el = node("button", value, className); el.type = "button"; el.onclick = action; return el; }
  const fmt = (n, compact = false) => new Intl.NumberFormat(localeOf(), compact ? { notation: "compact", maximumFractionDigits: 1 } : { maximumFractionDigits: 0 }).format(n || 0);
  function money(total, compact = false) {
    if (!total?.pricedCalls) return "—";
    const short = compact && total.knownCost >= 1000;
    return (total.unpricedCalls ? "≥ " : "≈ ") + new Intl.NumberFormat(localeOf(), { style: "currency", currency: "USD", ...(short ? { notation: "compact", maximumFractionDigits: 1, minimumFractionDigits: 0 } : { maximumFractionDigits: 2, minimumFractionDigits: 2 }) }).format(total.knownCost);
  }
  const agentName = id => ({ pi: "Pi", codex: "Codex", "claude-code": "Claude Code" })[id] || id;
  function range(period, now = new Date()) {
    const to = new Date(now); to.setHours(0, 0, 0, 0); to.setDate(to.getDate() + 1);
    const from = new Date(to); from.setDate(from.getDate() - 1);
    if (period === "week") from.setDate(from.getDate() - (from.getDay() + 6) % 7);
    else if (period === "month") from.setDate(1);
    else if (period === "thirty") from.setDate(from.getDate() - 29);
    return { from: from.getTime(), to: to.getTime(), timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC" };
  }
  function dateKey(date) { return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`; }
  function create({ api, context, openConversation, onVisibility = () => {} }) {
    let panel = null, selectedHost = "", period = "week", lens = "models", sequence = 0, timer, anchor, current = null;
    let filters = { agent: "", project: "", model: "" }, view = null, previous = null, quotas = [], hostChoices = [];
    function close() { if (!panel) return; sequence++; clearInterval(timer); panel.close(); panel.remove(); panel = null; onVisibility(); anchor?.focus?.({ preventScroll: true }); }
    function makeSelect(name, values, value, changed) {
      const select = node("select"); select.setAttribute("aria-label", label(name)); select.dataset.filter = name;
      for (const [id, title] of values) { const option = node("option", title); option.value = id; select.append(option); }
      select.value = value; select.onchange = () => changed(select.value); return select;
    }
    function status(value, kind = "") { const note = view.status; note.textContent = value; note.dataset.kind = kind; }
    async function load(fresh = false) {
      const epoch = ++sequence, targets = selectedHost ? hostChoices.filter(item => item.id === selectedHost) : hostChoices;
      const query = new URLSearchParams({ ...range(period), ...filters, ...(fresh ? { fresh: "1" } : {}) });
      if (!previous) renderEmpty(label("loading"));
      status(label("loading")); view.refresh.disabled = true; panel.setAttribute("aria-busy", "true");
      const results = await Promise.all(targets.map(async host => {
        const [report, quota] = await Promise.allSettled([api("/api/workspace/analytics?" + query, undefined, host.id), api("/api/workspace/usage", undefined, host.id)]);
        return { host: host.id, name: host.name, report: report.status === "fulfilled" ? report.value : null, quota: quota.status === "fulfilled" ? quota.value : null };
      }));
      if (!panel || epoch !== sequence) return;
      view.refresh.disabled = false; panel.removeAttribute("aria-busy");
      quotas = results; const succeeded = results.some(item => item.report);
      if (!succeeded) { status(label("retry"), "error"); if (!previous) renderEmpty(label("retry")); return; }
      previous = Data.combine(results); current = previous;
      current.facets = { agents: new Map(), projects: new Map(), models: new Map() };
      for (const result of results) for (const key of Object.keys(current.facets)) for (const item of result.report?.facets?.[key] || []) {
        if (key === "projects") {
          const old = current.facets.projects.get(item.id), hosts = [...new Set([...(old?.hostNames || []), result.name])];
          current.facets.projects.set(item.id, { ...item, hostNames: hosts });
        } else current.facets[key].set(item.id, item);
      }
      render(current); status(label("updated", { time: new Date().toLocaleTimeString(localeOf(), { hour: "2-digit", minute: "2-digit" }) }));
    }
    function renderEmpty(title) {
      view.body.replaceChildren(node("p", title, "usage-empty"));
    }
    function render(data) {
      const body = view.body, scroll = body.scrollTop, active = body.contains(document.activeElement) ? document.activeElement : null;
      const focus = active?.dataset.filter ? ["filter", active.dataset.filter] : active?.dataset.lens ? ["lens", active.dataset.lens]
        : active?.dataset.date ? ["date", active.dataset.date] : active?.dataset.row ? ["row", active.dataset.row] : null;
      body.replaceChildren();
      const filtersBar = node("div", "", "usage-filters");
      for (const [key, collection, name] of [["agent", "agents", "allAgents"], ["project", "projects", "allProjects"], ["model", "models", "allModels"]]) {
        const items = [...data.facets[collection].values()], duplicates = title => items.filter(item => item.name === title).length > 1;
        const options = [["", label(name)], ...items.map(item => [item.id, key === "agent" ? agentName(item.id) : key === "model" ? item.name + (item.provider ? " · " + item.provider : "")
          : item.name + (!selectedHost ? " · " + item.hostNames.join(", ") : duplicates(item.name) ? " · " + item.id : "")])];
        if (filters[key] && !options.some(([id]) => id === filters[key])) options.push([filters[key], filters[key]]);
        filtersBar.append(makeSelect(name, options, filters[key], value => { filters[key] = value; previous = null; void load(); }));
      }
      if (Object.values(filters).some(Boolean)) filtersBar.append(button(label("reset"), () => { filters = { agent: "", project: "", model: "" }; previous = null; void load(); }, "usage-clear"));
      body.append(filtersBar);
      const metrics = node("section", "", "usage-metrics"); metrics.setAttribute("aria-label", label("usage"));
      const unreadable = !data.coverage.covered && (data.coverage.missing || data.coverage.partial || data.coverage.unsupported);
      for (const [key, value, sub] of [["tokens", unreadable ? "—" : fmt(data.total.tokens), ""], ["cost", money(data.total, true), label("priced", { known: fmt(data.total.pricedCalls), total: fmt(data.total.calls) })], ["calls", unreadable ? "—" : fmt(data.total.calls), label("coverage", { covered: fmt(data.coverage.covered) })]]) {
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
      if (data.coverage.missing) notices.push(label("missing", { count: fmt(data.coverage.missing) }));
      if (data.coverage.unsupported) notices.push(label("unsupported", { count: fmt(data.coverage.unsupported) }));
      if (data.coverage.partial) notices.push(label("partial"));
      if (data.total.incompleteCalls) notices.push(label("incomplete"));
      if (notices.length) { const note = node("p", notices.join(" · "), "usage-notice"); note.setAttribute("role", "status"); body.append(note); }
      if (!data.total.calls) {
        const empty = node("section", "", "usage-empty"); empty.append(node("h2", Object.values(filters).some(Boolean) ? label("noResults") : label("noData")), node("p", label("noDataHint"))); body.append(empty);
      } else { body.append(chart(data)); body.append(breakdown(data)); }
      body.append(quotaSection());
      const foot = node("footer", "", "usage-explanation"); foot.append(node("p", label("estimate")), node("small", label("scope")));
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
            if (lens === "sessions") { close(); openConversation(row.nativeId, row.name, row.host); }
            else { filters[lens === "models" ? "model" : lens === "projects" ? "project" : "agent"] = lens === "projects" ? row.cwd : row.id; if (lens === "projects") { selectedHost = row.host; view.host.value = selectedHost; } previous = null; void load(); }
          }, "usage-list-row");
          el.dataset.row = row.id;
          el.title = label(lens === "sessions" ? "openSession" : lens === "models" ? "viewModel" : lens === "projects" ? "viewProject" : "viewAgent");
          const identity = node("span", "", "usage-list-identity"); identity.append(node("strong", lens === "agents" ? agentName(row.name) : row.name));
          const detail = lens === "models" ? row.provider : lens === "sessions" ? agentName(row.agent) + " · " + row.hostName : lens === "projects" ? row.hostName + " · " + row.cwd : "";
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
    function quotaSection() {
      const section = node("section", "", "usage-quotas"); section.append(node("h2", label("limits")));
      const grid = node("div", "", "usage-quota-grid");
      for (const host of quotas) for (const provider of host.quota?.providers || []) {
        if (!provider.windows?.length) continue;
        const card = node("div", "", "usage-quota-card"); card.append(node("strong", provider.provider), node("small", host.name));
        for (const window of provider.windows) {
          const remaining = typeof window.remainingPercent === "number" ? Math.round(window.remainingPercent) : null;
          const row = node("div", "", "usage-quota-window");
          const period = window.windowDurationMins === 300 ? "5h" : window.windowDurationMins === 10080 ? "7d" : window.windowDurationMins === 43200 ? "30d" : window.label || window.bucket || "";
          row.append(node("span", period), node("strong", remaining === null ? "—" : label("remaining", { percent: remaining })));
          if (remaining !== null && remaining < 20) row.dataset.low = "true";
          card.append(row);
          if (window.resetsAt && window.resetsAt > Date.now()) card.append(node("small", label("resetAt", { time: new Date(window.resetsAt).toLocaleString(localeOf(), { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) })));
        }
        grid.append(card);
      }
      section.append(grid.children.length ? grid : node("p", label("quotaUnknown"), "usage-muted")); return section;
    }
    async function open(target, trigger = document.activeElement) {
      if (panel) return;
      const ctx = context(); hostChoices = ctx.hosts; selectedHost = target || ctx.selected; anchor = trigger; previous = null; filters = { agent: "", project: "", model: "" };
      panel = node("dialog", "", "usage-panel"); panel.setAttribute("aria-labelledby", "usage-title");
      const header = node("header", "", "usage-header"), brand = node("div", "", "usage-brand");
      const logo = node("span", "", "workspace-logo"); logo.setAttribute("aria-hidden", "true"); brand.append(logo, node("strong", "Stepsemble"));
      const closeButton = button("×", close, "usage-close"); closeButton.setAttribute("aria-label", label("close"));
      header.append(brand, closeButton);
      const top = node("div", "", "usage-top"), heading = node("div", "", "usage-heading"), title = node("h1", label("usage")); title.id = "usage-title";
      heading.append(title, node("p", label("subtitle"))); top.append(heading);
      const controls = node("div", "", "usage-controls"), periods = node("div", "", "usage-periods"); periods.setAttribute("role", "group"); periods.setAttribute("aria-label", label("chart"));
      for (const key of ["today", "week", "month", "thirty"]) {
        const b = button(label(key), () => { period = key; for (const control of periods.children) control.setAttribute("aria-pressed", String(control === b)); previous = null; void load(); });
        b.dataset.period = key; b.setAttribute("aria-pressed", String(period === key)); periods.append(b);
      }
      const host = makeSelect("host", [["", label("allHosts")], ...hostChoices.map(item => [item.id, item.name])], selectedHost, value => { selectedHost = value; previous = null; void load(); });
      const refresh = button("↻", () => void load(true), "usage-refresh"); refresh.setAttribute("aria-label", label("refresh"));
      controls.append(periods, host, refresh); top.append(controls);
      const statusNote = node("p", label("loading"), "usage-status"); statusNote.setAttribute("role", "status");
      const body = node("div", "", "usage-body"); view = { body, status: statusNote, refresh, host };
      panel.append(header, top, statusNote, body); document.body.append(panel); panel.showModal(); closeButton.focus({ preventScroll: true }); onVisibility();
      panel.addEventListener("cancel", event => { event.preventDefault(); close(); });
      await load(); if (panel) timer = setInterval(() => { if (panel && !document.hidden) void load(); }, 60000);
    }
    function summary(report, element) { const total = report?.total, coverage = report?.coverage; element.textContent = total && !(coverage && !coverage.covered && (coverage.missing || coverage.partial || coverage.unsupported)) ? `${fmt(total.tokens, true)} · ${money(total, true)}` : ""; }
    return { open, close, summary, label, isOpen: () => !!panel };
  }
  root.StepsembleUsageUI = { create, label, range, money };
})(window);
