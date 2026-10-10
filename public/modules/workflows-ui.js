/* Host-owned Goals and schedules. The interface only observes and requests. */
(function (root, factory) {
  const api = factory(root);
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.StepsembleWorkflows = api;
})(typeof window !== "undefined" ? window : null, function (root) {
  "use strict";
  const AGENTS = ["pi", "codex", "claude-code", "omp", "opencode", "cline", "kilo", "hermes", "grok-build"];
  const ACTIVE = ["queued", "starting", "running", "waiting", "stopping"];
  const RESUMABLE = ["paused", "blocked", "interrupted"];
  const ATTENTION = ["waiting", "blocked", "interrupted", "failed", "limited"];
  const CLOCKED = ["starting", "running", "waiting"];
  const en = {
    goals: "Goals", schedules: "Schedules", newGoal: "New Goal", newSchedule: "New schedule", close: "Close", back: "Back",
    title: "Name", objective: "Objective", objectivePrompt: "What should the agent accomplish?", project: "Project", agent: "Agent", mode: "Run mode",
    goal: "Work toward a Goal", task: "Run one task", limits: "Execution limits", save: "Save schedule", start: "Start Goal",
    run: "Run now", edit: "Edit schedule", remove: "Delete schedule", conversation: "Open conversation", result: "Latest result",
    next: "Next run", history: "Run history", schedule: "When to run", once: "Once", daily: "Every day",
    weekly: "Every week", interval: "At an interval", every: "Interval (min)", time: "Time", timeZone: "Time zone", date: "Date and time", days: "Days of the week",
    hostNote: "Runs on this Host. Keep the computer awake and Stepsemble running.",
    modelNote: "Uses the agent’s saved model. Approvals stay in the conversation.",
    emptyGoals: "A clear goal. A place to follow its progress.", emptySchedules: "Make room for work that runs itself.",
    emptyGoalsHint: "Start here, or type /goal in any supported conversation.", emptySchedulesHint: "Choose a task and a time. Each run opens its own conversation.",
    elapsed: "Time worked", workingFor: "Working for", live: "Current activity", unavailable: "Goals and schedules are unavailable on this Host.",
    noAgents: "No supported agents installed.", noProjects: "Add a project before creating a task.", refreshError: "Connection interrupted. Showing the last update.",
    removeConfirm: "Delete this schedule? Existing runs are kept.", newHint: "Describe the work and how to verify it is complete…",
    late: "Started after its scheduled time", retry: "Try again", sun: "Sun", mon: "Mon", tue: "Tue", wed: "Wed", thu: "Thu", fri: "Fri", sat: "Sat",
    all: "All", active: "In progress", attention: "Needs attention", finished: "Finished", enabled: "Scheduled", filter: "Find a task…",
    noMatches: "No matching tasks", noMatchesHint: "Try another search or filter.", scheduled: "Scheduled run", ready: "Ready to run",
    outputTokens: "Output tokens", turnsUsed: "Turns used", timeBudget: "Time budget", ofLimit: "of {limit}",
    everyMinutes: "Every {minutes} min", weekAt: "{days} · {time}", dailyAt: "Every day · {time}",
    scheduleHint: "Set it once. Follow every run here.", goalHint: "Give the agent an outcome and follow its work.",
    taskHint: "One task per run", goalModeHint: "Continues until complete or a limit is reached", nameHint: "Optional — use the first line of the objective",
    limitsHint: "A run stops when any limit is reached.", chooseDays: "Choose at least one weekday.", futureDate: "Choose a future date and time.",
    invalidZone: "Enter a valid time zone, such as Asia/Taipei.", loading: "Connecting to the Host…", selectTask: "Select a task to see its progress.",
    objectiveRequired: "Describe an objective before starting.",
    resultEmpty: "The result will appear here when the agent finishes a turn.", historyEmpty: "No runs yet. The first result will appear here.",
    nextNone: "No upcoming run", editTime: "Choose a new time to run this schedule again.", requestPending: "Saving…",
  };
  const aliases = { pause: "pause", resume: "resume", stop: "stop", minutes: "minutes", turns: "turns", tokens: "tokens", limitsError: "limitsError", thinking: "state.thinking", approval: "state.waiting" };
  const locale = () => root?.document.documentElement.lang || "en";
  function t(key, vars = {}) {
    if (root?.StepsembleWorkflowI18n) return root.StepsembleWorkflowI18n.t(key, vars, locale());
    const alias = aliases[key] || (ACTIVE.includes(key) || RESUMABLE.includes(key) || ["limited", "completed", "failed", "stopped"].includes(key) ? "state." + key : null);
    const full = alias ? "goalComposer." + alias : "workflows." + key;
    const translated = root?.stepsembleI18n?.tKey(full, vars);
    if (translated && translated !== full) return translated;
    return (en[key] || key).replace(/\{(\w+)\}/g, (_, name) => vars[name] ?? "");
  }
  const active = row => ACTIVE.includes(row.status);
  const resumable = row => RESUMABLE.includes(row.status);
  const attention = row => ATTENTION.includes(row.status);
  const baseName = value => String(value || "").split(/[\\/]/).filter(Boolean).pop() || value || "—";
  function duration(ms) {
    const s = Math.floor(Math.max(0, Number(ms) || 0) / 1000);
    return `${Math.floor(s / 3600) ? `${Math.floor(s / 3600)}:` : ""}${String(Math.floor(s / 60) % 60).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
  }
  function elapsed(row, receivedAt, now = Date.now()) {
    return Math.max(0, Number(row.elapsedMs) || 0) + (CLOCKED.includes(row.status) ? Math.max(0, now - receivedAt) : 0);
  }
  function stamp(value, timeZone, options = {}) {
    if (!value) return "—";
    try { return new Intl.DateTimeFormat(locale(), { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", ...(timeZone ? { timeZone } : {}), ...options }).format(new Date(value)); }
    catch { return "—"; }
  }
  function scheduleState(row) {
    return row.enabled ? "enabled" : row.schedule.kind === "once" && !row.nextAt && row.lastRunId ? "finished" : "paused";
  }
  function scheduleLabel(spec) {
    if (spec.kind === "once") return stamp(spec.at);
    if (spec.kind === "interval") return t("everyMinutes", { minutes: spec.minutes });
    if (spec.kind === "daily") return t("dailyAt", { time: spec.time });
    const names = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
    const days = [1,2,3,4,5,6,0].filter(day => spec.days?.includes(day)).map(day => t(names[day])).join(" · ");
    return t("weekAt", { days, time: spec.time });
  }
  function relative(value, now = Date.now()) {
    const minutes = Math.ceil((Number(value) - now) / 60000);
    if (minutes <= 0) return t("ready");
    const [amount, unit] = minutes >= 1440 ? [Math.round(minutes / 1440), "day"] : minutes >= 60 ? [Math.round(minutes / 60), "hour"] : [minutes, "minute"];
    return new Intl.RelativeTimeFormat(locale(), { numeric: "always" }).format(amount, unit);
  }
  function requestId() {
    if (root.crypto.randomUUID) return root.crypto.randomUUID();
    const bytes = root.crypto.getRandomValues(new Uint8Array(16)); bytes[6] = (bytes[6] & 15) | 64; bytes[8] = (bytes[8] & 63) | 128;
    const hex = Array.from(bytes, b => b.toString(16).padStart(2,"0")).join("");
    return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
  }
  function validate(input, now = Date.now()) {
    if (typeof input.objective === "string" && !input.objective.trim()) return "workflows.objectiveRequired";
    const limits = input.limits;
    if (!limits || ![[limits.minutes,1,1440],[limits.turns,1,100],[limits.outputTokens,100,10000000]].every(([n,min,max]) => Number.isSafeInteger(n) && n >= min && n <= max)) return "goalComposer.limitsError";
    if (input.schedule?.kind === "once" && !(Date.parse(input.schedule.at) > now)) return "workflows.futureDate";
    if (input.schedule?.kind === "weekly" && !input.schedule.days.length) return "workflows.chooseDays";
    if (["daily", "weekly"].includes(input.schedule?.kind)) {
      try { new Intl.DateTimeFormat("en", { timeZone: input.schedule.timeZone }).format(now); } catch { return "workflows.invalidZone"; }
    }
    return null;
  }
  function create({ api, context, openConversation, onChanged = () => {} }) {
    const doc = root.document;
    const el = (tag, text = "", cls = "") => { const node = doc.createElement(tag); node.className = cls; node.textContent = text; return node; };
    function button(label, fn, cls = "", key = "") {
      const node = el("button", label, "btn " + cls); node.type = "button"; node.onclick = fn;
      if (key) node.dataset.focus = key;
      return node;
    }
    const icon = text => { const node = el("span", text, "wf-icon"); node.setAttribute("aria-hidden", "true"); return node; };
    let modal = null, timer = null, clock = null, epoch = 0, revision = 0, contextValue = null, data = null;
    let view = "goals", filter = "all", query = "", selected = null, historyId = null, editing = false, pending = false;
    let connected = false, frozenAt = 0, errorText = "", loaded = false, shell = null, listSignature = "", detailSignature = "";
    const received = new Map();
    const call = (body, target = contextValue.target) => api("/api/workflows", body, target);
    const goals = () => (data?.runs || []).filter(row => row.mode !== "task");
    const rows = () => view === "goals" ? goals() : data?.schedules || [];
    const current = () => rows().find(row => row.id === selected);
    const agentName = id => root.StepsembleAgentIdentity?.lookup(id).label || ({ pi:"Pi Agent", codex:"Codex", "claude-code":"Claude Code", omp:"Oh My Pi", opencode:"OpenCode", cline:"Cline", kilo:"Kilo Code", hermes:"Hermes Agent", "grok-build":"Grok Build" })[id] || id;
    const liveTime = row => elapsed(row, received.get(row.id) || Date.now(), connected ? Date.now() : frozenAt);
    function close() {
      epoch++; revision++; root.clearTimeout(timer); root.clearInterval(clock);
      modal?.close(); modal?.remove(); modal = null; shell = null; editing = false; pending = false;
      root.dispatchEvent(new root.Event("stepsemble-workflow-panel"));
    }
    function error(message = "") {
      errorText = message;
      if (!shell?.error) return;
      shell.error.textContent = message; shell.error.hidden = !message;
    }
    function rememberFocus(container) {
      const key = container.contains(doc.activeElement) ? doc.activeElement?.dataset.focus : null;
      return () => { if (key) [...container.querySelectorAll("[data-focus]")].find(node => node.dataset.focus === key)?.focus({ preventScroll: true }); };
    }
    function showConversation(row) {
      const target = contextValue.target; close(); openConversation(row.entry, row.title, target);
    }
    function merge(row) {
      const collection = row.schedule ? data.schedules : data.runs;
      const index = collection.findIndex(item => item.id === row.id);
      if (index < 0) collection.push(row); else collection[index] = row;
      if (!row.schedule) received.set(row.id, Date.now());
    }
    async function action(row, name) {
      if (pending || !loaded || data.available === false) return;
      if (name === "delete" && !root.confirm(t("removeConfirm"))) return;
      const focused = doc.activeElement?.dataset.focus === row.id + ":" + name;
      const token = epoch, target = contextValue.target; pending = true; revision++; error(""); updateButtons();
      try {
        const changed = await call({ id: row.id, action: name }, target);
        if (token !== epoch || !modal) return;
        revision++;
        if (name === "delete") data.schedules = data.schedules.filter(item => item.id !== row.id);
        else if (changed?.id) merge(changed);
        onChanged(); render(true); await refresh();
      } catch (e) { if (token === epoch) error(e.message || t("refreshError")); }
      finally { if (token === epoch && modal) {
        pending = false; updateButtons();
        if (focused && doc.activeElement === doc.body) {
          const successor = name === "pause" ? "resume" : name === "resume" ? "pause" : "conversation";
          const controls = [...modal.querySelectorAll("[data-focus]")];
          const next = [successor,name,"conversation"].map(key => controls.find(node => node.dataset.focus === row.id + ":" + key && !node.disabled)).find(Boolean);
          if (next) next.focus({ preventScroll:true });
          else if (current()?.id === row.id) (root.matchMedia?.("(max-width:700px)").matches ? shell.detail.querySelector(".wf-mobile-back") : [...shell.list.querySelectorAll("[data-focus]")].find(node => node.dataset.focus === "row:" + row.id))?.focus({ preventScroll:true });
        }
      } }
    }
    function updateButtons() {
      if (!modal) return;
      for (const node of modal.querySelectorAll("[data-mutation]")) node.disabled = pending || data?.available === false || !loaded || node.dataset.running === "true";
    }
    function mutateButton(row, name, label = name, cls = "") {
      const node = button(t(label), () => action(row, name), cls, row.id + ":" + name); node.dataset.mutation = ""; return node;
    }
    function controls(row) {
      const box = el("div", "", "wf-actions");
      if (row.entry) box.append(button(t("conversation") + " ↗", () => showConversation(row), "wf-open-chat", row.id + ":conversation"));
      if (active(row) && row.status !== "stopping") box.append(mutateButton(row,"pause"));
      if (resumable(row)) box.append(mutateButton(row,"resume", "resume", "primary"));
      if ((active(row) || resumable(row)) && (row.status !== "stopping" || row.error)) box.append(mutateButton(row,"stop", "stop", "ghost"));
      return box;
    }
    function badge(state) { const node = el("span", t(state), "wf-status"); node.dataset.state = state; return node; }
    function agentProject(row) {
      const box = el("div", "", "wf-context");
      const mark = root.StepsembleAgentIdentity?.create(doc, row.agentId, true) || icon("◎");
      box.append(mark, el("span", agentName(row.agentId)), el("span", "·"), el("span", baseName(row.cwd), "wf-project-name"));
      box.title = row.cwd; return box;
    }
    function buildShell() {
      modal.dataset.screen = "list"; modal.setAttribute("aria-label", t(view));
      const header = el("header", "", "wf-header"), identity = el("div", "", "wf-brand");
      const logo = el("span", "", "workspace-logo"); logo.setAttribute("aria-hidden", "true");
      identity.append(logo, el("strong", "Stepsemble"));
      const host = el("span", contextValue.hostName, "wf-host");
      const tabs = el("nav", "", "wf-tabs"); tabs.setAttribute("aria-label", t("goals") + " · " + t("schedules"));
      for (const key of ["goals", "schedules"]) {
        const tab = button(t(key), () => {
          view = key; filter = "all"; query = ""; selected = null; historyId = null;
          shell.search.value = ""; modal.dataset.screen = "list"; render(true); poll();
        }, "ghost", "tab:" + key);
        tab.dataset.view = key; tabs.append(tab);
      }
      const add = button("", () => form(), "primary wf-add", "new"); add.dataset.mutation = "";
      const dismiss = button("×", close, "ghost wf-close", "close"); dismiss.setAttribute("aria-label", t("close"));
      header.append(identity, host, tabs, add, dismiss);
      const heading = el("div", "", "wf-heading"), headingCopy = el("div"), title = el("h1"), subtitle = el("p"); headingCopy.append(title, subtitle);
      const stats = el("div", "", "wf-stats"); heading.append(headingCopy, stats);
      const errorBox = el("p", "", "wf-error"); errorBox.setAttribute("role", "status"); errorBox.hidden = true;
      const body = el("div", "", "wf-body"), rail = el("section", "", "wf-rail"), search = el("input", "", "wf-search");
      search.type = "search"; search.placeholder = t("filter"); search.setAttribute("aria-label", t("filter"));
      search.oninput = () => { query = search.value; selected = null; render(); };
      const filters = el("nav", "", "wf-filters"), list = el("ul", "", "wf-list");
      rail.append(search, filters, list); const detail = el("section", "", "wf-detail"); detail.setAttribute("aria-label", t("selectTask"));
      body.append(rail, detail);
      const note = el("footer", t("hostNote"), "wf-note wf-footer");
      modal.replaceChildren(header, heading, errorBox, body, note);
      shell = { header, tabs, add, title, subtitle, stats, error: errorBox, search, filters, list, detail };
      listSignature = ""; detailSignature = ""; error(errorText); render(true);
    }
    function matches(row) {
      const text = [row.title, row.objective, row.cwd, agentName(row.agentId)].join(" ").toLocaleLowerCase(locale());
      const found = !query || text.includes(query.toLocaleLowerCase(locale()));
      if (!found || filter === "all") return found;
      return view === "goals" ? filter === "active" ? active(row) : filter === "paused" ? row.status === "paused" : filter === "attention" ? attention(row) : !active(row) && !resumable(row) : scheduleState(row) === filter;
    }
    function sortedRows() {
      return [...rows()].filter(matches).sort((a,b) => view === "goals"
        ? Number(active(b)) - Number(active(a)) || Number(attention(b)) - Number(attention(a)) || (b.createdAt || 0) - (a.createdAt || 0)
        : Number(b.enabled) - Number(a.enabled) || (a.nextAt || Infinity) - (b.nextAt || Infinity) || (b.createdAt || 0) - (a.createdAt || 0));
    }
    function summary() {
      const values = view === "goals"
        ? [["active",goals().filter(active).length],["attention",goals().filter(attention).length],["completed",goals().filter(row => row.status === "completed").length]]
        : [["enabled",rows().filter(row => row.enabled).length],["paused",rows().filter(row => scheduleState(row) === "paused").length],["finished",rows().filter(row => scheduleState(row) === "finished").length]];
      // Stable nodes keep clocks and keyboard focus independent of polling.
      if (!shell.stats.children.length) for (let i=0; i<3; i++) { const node=el("div", "", "wf-stat"); node.append(el("strong"),el("span")); shell.stats.append(node); }
      values.forEach(([key,value],i) => { const node=shell.stats.children[i]; node.children[0].textContent=String(value); node.children[1].textContent=t(key); });
    }
    function empty(title, hint, mark = "◎", createAction = false) {
      const node = el("div", "", "wf-empty"); node.append(icon(mark), el("h2", title));
      if (hint) node.append(el("p", hint));
      if (createAction) { const add = button(t(view === "goals" ? "newGoal" : "newSchedule"), () => form(), "primary"); add.dataset.mutation = ""; node.append(add); }
      return node;
    }
    function render(force = false) {
      if (!modal || editing || !shell?.list) return;
      shell.title.textContent = t(view); shell.subtitle.textContent = t(view === "goals" ? "goalHint" : "scheduleHint");
      shell.add.textContent = "+ " + t(view === "goals" ? "newGoal" : "newSchedule");
      shell.search.placeholder = t("filter"); shell.search.setAttribute("aria-label", t("filter"));
      modal.querySelector(".wf-footer").textContent = t("hostNote");
      modal.setAttribute("aria-label", t(view));
      for (const tab of shell.tabs.children) { const chosen = tab.dataset.view === view; tab.textContent = t(tab.dataset.view); tab.setAttribute("aria-current", chosen ? "page" : "false"); }
      summary();
      const filterKeys = view === "goals" ? ["all","active","paused","attention","finished"] : ["all","enabled","paused","finished"];
      if (force) {
        const restore = rememberFocus(shell.filters); shell.filters.replaceChildren();
        for (const key of filterKeys) shell.filters.append(button(t(key), () => { filter = key; selected = null; render(); }, "ghost", "filter:" + key));
        restore();
      }
      for (const node of shell.filters.children) { node.textContent = t(node.dataset.focus.slice(7)); node.setAttribute("aria-pressed", String(node.dataset.focus === "filter:" + filter)); }
      const visible = sortedRows();
      if (!visible.some(row => row.id === selected)) { selected = visible[0]?.id || null; historyId = null; }
      const signature = JSON.stringify([locale(), view, query, filter, selected, loaded, visible.map(row => [row.id,row.title,row.status,row.agentId,row.cwd,row.enabled,row.schedule,row.nextAt])]);
      if (force || signature !== listSignature) {
        listSignature = signature; const scroll = shell.list.scrollTop, restore = rememberFocus(shell.list);
        shell.list.replaceChildren();
        if (!visible.length) {
          const item = el("li"); item.append(empty(t(!loaded ? "loading" : rows().length ? "noMatches" : view === "goals" ? "emptyGoals" : "emptySchedules"), loaded ? t(rows().length ? "noMatchesHint" : view === "goals" ? "emptyGoalsHint" : "emptySchedulesHint") : "", view === "goals" ? "◎" : "◷", loaded && !rows().length)); shell.list.append(item);
        }
        for (const row of visible) {
          const li = el("li"), item = button("", () => {
            selected = row.id; historyId = null; modal.dataset.screen = "detail"; render();
            if (root.matchMedia?.("(max-width:700px)").matches) shell.detail.querySelector(".wf-mobile-back")?.focus();
          }, "wf-item", "row:" + row.id);
          item.setAttribute("aria-current", String(row.id === selected)); item.dataset.state = row.status || scheduleState(row);
          const top = el("span", "", "wf-item-top"); top.append(el("strong", row.title), badge(row.status || scheduleState(row)));
          const context = el("span", agentName(row.agentId) + " · " + baseName(row.cwd), "wf-item-context");
          const meta = el("span", "", "wf-item-meta");
          if (view === "goals") { const time = el("span"); time.dataset.clock = row.id; meta.append(time); if (row.scheduleId) meta.append(el("span", t("scheduled"))); }
          else { meta.append(el("span", scheduleLabel(row.schedule))); if (row.enabled && row.nextAt) meta.append(el("span", stamp(row.nextAt, row.schedule.timeZone))); }
          item.append(top, context, meta); li.append(item); shell.list.append(li);
        }
        shell.list.scrollTop = scroll; restore();
      }
      const row = current();
      shell.detail.setAttribute("aria-label", row?.title || t("selectTask"));
      const related = view === "schedules" ? (data.runs || []).filter(run => run.scheduleId === row?.id) : [];
      const stable = value => JSON.stringify(value, (key,v) => ["elapsedMs","updatedAt","serverNow"].includes(key) ? undefined : v);
      const detailKey = stable([locale(), view, row, related, historyId, loaded]);
      if (force || detailKey !== detailSignature) {
        detailSignature = detailKey; const scroll = shell.detail.scrollTop, restore = rememberFocus(shell.detail);
        const expanded = new Set([...shell.detail.querySelectorAll("details[open]")].map(node => node.dataset.key));
        shell.detail.replaceChildren();
        if (row) {
          const back = button("‹ " + t("back"), () => { modal.dataset.screen = "list"; [...shell.list.querySelectorAll("[data-focus]")].find(node => node.dataset.focus === "row:" + selected)?.focus(); }, "ghost wf-mobile-back", "detail-back");
          shell.detail.append(back, view === "goals" ? goalDetail(row) : scheduleDetail(row, related));
        } else shell.detail.append(empty(t(loaded ? "selectTask" : "loading"), "", view === "goals" ? "◎" : "◷"));
        for (const node of shell.detail.querySelectorAll("details")) node.open = expanded.has(node.dataset.key);
        shell.detail.scrollTop = scroll; restore();
      }
      updateClock(); updateButtons();
    }
    function section(title, child, cls = "") { const node = el("section", "", "wf-section " + cls); node.append(el("h3", title), child); return node; }
    function runProgress(row) {
      const box = el("div", "", "wf-progress"); box.append(badge(row.status));
      const caption = el("span", t(CLOCKED.includes(row.status) ? "workingFor" : "elapsed"), "wf-caption");
      const time = el("strong", "", "wf-timer"); time.dataset.clock = row.id; box.append(caption,time);
      if (active(row) || resumable(row)) {
        const activity = el("div", "", "wf-activity"); activity.append(el("span", t("live"), "wf-caption"),el("p", t(row.activity || row.status))); box.append(activity);
      }
      const metrics = el("div", "", "wf-metrics");
      for (const [label,value,limit] of [["turnsUsed",row.turns,row.limits?.turns],["outputTokens",row.outputTokens,row.limits?.outputTokens]]) {
        const metric=el("div"); metric.append(el("span",t(label),"wf-caption"),el("strong",(Number(value)||0).toLocaleString(locale())),el("small",t("ofLimit",{limit:(Number(limit)||0).toLocaleString(locale())}))); metrics.append(metric);
      }
      box.append(metrics);
      if (row.limits?.minutes) {
        const budget=el("div","","wf-budget"),copy=el("span",t("timeBudget")),remaining=el("span","","wf-caption"); remaining.dataset.budget=row.id;
        const track=el("div","","wf-meter"),fill=el("span"); fill.dataset.meter=row.id; track.append(fill); budget.append(copy,remaining,track); box.append(budget);
      }
      if (row.error) { const message=el("p",row.error,"wf-run-error"); message.setAttribute("role","status"); box.append(message); }
      if (row.scheduledAt && row.startedAt-row.scheduledAt>60000) box.append(el("small",t("late"),"wf-caption"));
      box.append(controls(row)); return box;
    }
    function result(row) { return section(t("result"), row.result ? el("pre",row.result,"wf-result") : el("p",t("resultEmpty"),"wf-muted")); }
    function goalDetail(row) {
      const node=el("article","","wf-inspector"); node.dataset.runId=row.id;
      node.append(agentProject(row),el("h2",row.title),runProgress(row),section(t("objective"),el("p",row.objective,"wf-objective")),result(row));
      const project=el("details","","wf-project-details"); project.dataset.key="project:"+row.id; project.append(el("summary",t("project")),el("code",row.cwd)); node.append(project);
      return node;
    }
    function scheduleDetail(row, history) {
      history = [...history].sort((a,b) => (b.createdAt || 0)-(a.createdAt || 0));
      const node=el("article","","wf-inspector"); node.dataset.scheduleId=row.id;
      node.append(agentProject(row),el("h2",row.title));
      const plan=el("div","","wf-plan"); plan.append(badge(scheduleState(row)),el("span",t("next"),"wf-caption"));
      plan.append(el("strong",row.enabled && row.nextAt ? stamp(row.nextAt,row.schedule.timeZone) : t("nextNone"),"wf-next-time"));
      const countdown=el("span","","wf-countdown"); if(row.enabled && row.nextAt)countdown.dataset.next=String(row.nextAt); plan.append(countdown);
      plan.append(el("p",scheduleLabel(row.schedule),"wf-recurrence"));
      if (row.schedule.timeZone) plan.append(el("small",row.schedule.timeZone,"wf-caption"));
      if (row.schedule.kind === "weekly") {
        const days=el("div","","wf-week"); [1,2,3,4,5,6,0].forEach(day=>{const chip=el("span",t(["sun","mon","tue","wed","thu","fri","sat"][day]));chip.dataset.selected=String(row.schedule.days.includes(day));days.append(chip);}); plan.append(days);
      }
      if (scheduleState(row)==="finished") plan.append(el("p",t("editTime"),"wf-muted"));
      const actions=el("div","","wf-actions"); const executing=history.find(active);
      const run=mutateButton(row,"run","run","primary"); run.dataset.running=String(!!executing); actions.append(run);
      const edit=button(t("edit"),()=>form(row),"",row.id+":edit");edit.dataset.mutation="";actions.append(edit);
      if (scheduleState(row)!=="finished") actions.append(mutateButton(row,row.enabled?"pause":"resume"));
      plan.append(actions);node.append(plan,section(t("objective"),el("p",row.objective,"wf-objective")));
      const historyBox=el("div","","wf-history");
      if (!history.some(item=>item.id===historyId)) historyId=history[0]?.id||null;
      if (!history.length) historyBox.append(el("p",t("historyEmpty"),"wf-muted"));
      for (const item of history) {
        const entry=button("",()=>{historyId=item.id;render();},"wf-history-row", "history:"+item.id);entry.setAttribute("aria-current",String(historyId===item.id));
        const time=el("span",duration(liveTime(item)),"wf-caption");time.dataset.clock=item.id;
        entry.append(badge(item.status),el("span",stamp(item.startedAt||item.createdAt,row.schedule.timeZone)),time);historyBox.append(entry);
      }
      node.append(section(t("history"),historyBox));
      const runRow=history.find(item=>item.id===historyId); if(runRow)node.append(runProgress(runRow),result(runRow));
      const meta=el("details","","wf-project-details");meta.dataset.key="settings:"+row.id;
      meta.append(el("summary",t("limits")),el("p",t(row.mode==="goal"?"goal":"task")),el("p",`${t("minutes")}: ${row.limits.minutes} · ${t("turns")}: ${row.limits.turns} · ${t("tokens")}: ${row.limits.outputTokens.toLocaleString(locale())}`),el("code",row.cwd));node.append(meta);
      node.append(mutateButton(row,"delete","remove","ghost wf-delete"));return node;
    }
    function updateClock() {
      if (!modal || editing) return;
      const runMap=new Map((data?.runs||[]).map(row=>[row.id,row]));
      for(const node of modal.querySelectorAll("[data-clock]")){const row=runMap.get(node.dataset.clock);if(row)node.textContent=duration(liveTime(row));}
      for(const node of modal.querySelectorAll("[data-budget]")){const row=runMap.get(node.dataset.budget);if(row)node.textContent=`${duration(liveTime(row))} / ${duration(row.limits.minutes*60000)}`;}
      for(const node of modal.querySelectorAll("[data-meter]")){const row=runMap.get(node.dataset.meter);if(row)node.style.width=Math.min(100,liveTime(row)/(row.limits.minutes*600)) + "%";}
      for(const node of modal.querySelectorAll("[data-next]"))node.textContent=relative(Number(node.dataset.next));
    }
    async function refresh() {
      const token=epoch, version=revision, target=contextValue.target;
      try {
        const next=await call(undefined,target);if(token!==epoch||version!==revision||!modal||editing)return;
        data={...next,runs:next.runs||[],schedules:next.schedules||[]};loaded=true;connected=next.available!==false;
        const now=Date.now();frozenAt=now;for(const row of data.runs)received.set(row.id,now);
        error(next.available===false?t("unavailable"):"");render();
      }catch(e){if(token===epoch&&version===revision&&modal){if(connected)frozenAt=Date.now();connected=false;error(e.message||t("refreshError"));updateClock();}}
    }
    function poll() {root.clearTimeout(timer);if(!modal||editing)return;timer=root.setTimeout(async()=>{await refresh();poll();},4000);}
    function field(parent,key,type,value,options) {
      const box=el("label","","wf-field"),input=el(options?"select":type==="textarea"?"textarea":"input");box.append(el("span",t(key)));
      if(options)for(const [val,label]of options){const option=el("option",label);option.value=val;input.append(option);}
      else if(type!=="textarea")input.type=type;
      input.name=key;input.value=value??"";input.required=true;box.append(input);parent.append(box);return input;
    }
    async function form(row=null, entry=null, objective="") {
      if(pending)return;
      editing=true;revision++;root.clearTimeout(timer);const token=++epoch, target=contextValue.target;
      modal.dataset.screen="editor";const scheduling=view==="schedules";
      modal.setAttribute("aria-label",t(row?"edit":scheduling?"newSchedule":"newGoal"));
      const header=el("header","","wf-header wf-editor-header"),copy=el("div");copy.append(el("small",contextValue.hostName,"wf-caption"),el("h1",t(row?"edit":scheduling?"newSchedule":"newGoal")));
      const back=button("‹ "+t("back"),()=>{if(token!==epoch)return;epoch++;editing=false;pending=false;buildShell();void refresh();poll();shell.add.focus();},"ghost","editor-back");
      const dismiss=button("×",close,"ghost wf-close");dismiss.setAttribute("aria-label",t("close"));header.append(back,copy,dismiss);
      const f=el("form","","wf-form"),layout=el("div","","wf-editor-layout"),main=el("section","","wf-editor-main"),settings=el("aside","","wf-editor-settings");layout.append(main,settings);f.append(layout);
      // Open invalid advanced fields before native validation tries to focus them.
      f.noValidate=true;
      const title=field(main,"title","text",row?.title||"");title.required=false;title.maxLength=120;title.placeholder=t("nameHint");
      const prompt=field(main,"objectivePrompt","textarea",row?.objective||objective);prompt.rows=7;prompt.maxLength=16000;prompt.placeholder=t("newHint");
      const pair=el("div","","wf-grid");main.append(pair);
      const projects=[...new Set([...(contextValue.projects||[]),row?.cwd,entry?.record.cwd].filter(Boolean))];
      const cwd=field(pair,"project","text",row?.cwd||entry?.record.cwd||projects[0],projects.map(path=>[path,baseName(path)]));
      const projectPath=el("small",cwd.value,"wf-path");main.append(projectPath);cwd.onchange=()=>{projectPath.textContent=cwd.value;};
      const agent=field(pair,"agent","text",row?.agentId||entry?.record.agentId,[["",t("loading")]]);
      if(entry){cwd.disabled=true;agent.disabled=true;}
      const note=el("p",t("modelNote"),"wf-muted");main.append(note);
      let mode,repeat,at,time,zone,interval,dayInputs=[],days,preview;
      if(scheduling){
        settings.append(el("h2",t("schedule")));
        const repeatTabs=el("div","","wf-repeat");repeat=el("input");repeat.type="hidden";repeat.value=row?.schedule.kind||"daily";
        for(const kind of ["once","daily","weekly","interval"]){const b=button(t(kind),()=>{repeat.value=kind;sync();f.dispatchEvent(new root.Event("input"));},"", "repeat:"+kind);b.dataset.repeat=kind;repeatTabs.append(b);}settings.append(repeat,repeatTabs);
        const fields=el("div","","wf-schedule-fields");settings.append(fields);
        const localDate=value=>{const d=new Date(value);return new Date(d.getTime()-d.getTimezoneOffset()*60000).toISOString().slice(0,16);};
        at=field(fields,"date","datetime-local",localDate(row?.schedule.at||Date.now()+3600000));
        const localZone=Intl.DateTimeFormat().resolvedOptions().timeZone;
        const onceZone=el("small",localZone,"wf-caption");at.parentElement.append(onceZone);
        time=field(fields,"time","time",row?.schedule.time||"09:00");
        zone=field(fields,"timeZone","text",row?.schedule.timeZone||localZone);
        interval=field(fields,"every","number",row?.schedule.minutes||60);interval.min=15;interval.max=10080;interval.step=1;
        days=el("fieldset","","wf-days");days.append(el("legend",t("days")));const dayGroup=el("div");days.append(dayGroup);
        [1,2,3,4,5,6,0].forEach(day=>{const label=el("label"),input=el("input");input.type="checkbox";input.value=String(day);input.checked=(row?.schedule.kind==="weekly"?row.schedule.days:[1,2,3,4,5]).includes(day);input.name="weekday";label.append(input,el("span",t(["sun","mon","tue","wed","thu","fri","sat"][day])));dayGroup.append(label);dayInputs.push(input);});fields.append(days);
        preview=el("p","","wf-schedule-preview");preview.setAttribute("aria-live","polite");settings.append(preview);
        function sync(){
          for(const b of repeatTabs.children)b.setAttribute("aria-pressed",String(b.dataset.repeat===repeat.value));
          for(const[control,visible]of[[at,repeat.value==="once"],[time,["daily","weekly"].includes(repeat.value)],[zone,["daily","weekly"].includes(repeat.value)],[interval,repeat.value==="interval"]]){control.parentElement.hidden=!visible;control.disabled=!visible;}
          days.hidden=repeat.value!=="weekly";for(const input of dayInputs)input.disabled=days.hidden;
          preview.textContent=scheduleLabel({kind:repeat.value,at:at.value,time:time.value,timeZone:zone.value,minutes:interval.value,days:dayInputs.filter(input=>input.checked).map(input=>Number(input.value))});
        }
        f.addEventListener("input",sync);sync();
        mode=field(settings,"mode","text",row?.mode||"task",[["task",t("task")],["goal",t("goal")]]);
        const modeHint=el("p","","wf-muted");settings.append(modeHint);mode.onchange=()=>{modeHint.textContent=t(mode.value==="goal"?"goalModeHint":"taskHint");};mode.onchange();
      }else settings.append(el("h2",t("limits")),el("p",t("goalHint"),"wf-muted"));
      const limitBox=el("div","","wf-limit-box");settings.append(limitBox);
      const minutes=field(limitBox,"minutes","number",row?.limits.minutes||60);minutes.min=1;minutes.max=1440;minutes.step=1;
      const advanced=el("details","","wf-advanced");advanced.append(el("summary",t("limits")));const advancedFields=el("div","","wf-grid");advanced.append(advancedFields);limitBox.append(advanced);
      const turns=field(advancedFields,"turns","number",row?.limits.turns||20);turns.min=1;turns.max=100;turns.step=1;
      const tokens=field(advancedFields,"tokens","number",row?.limits.outputTokens||100000);tokens.min=100;tokens.max=10000000;tokens.step=1;
      advanced.append(el("p",t("limitsHint"),"wf-muted"));
      const footer=el("div","","wf-editor-footer"),errorBox=el("p","","wf-error");errorBox.setAttribute("role","alert");errorBox.hidden=true;
      const submit=el("button",t(scheduling?"save":"start"),"btn primary");submit.type="submit";submit.disabled=true;
      const retry=button(t("retry"),()=>void loadAgents(),"ghost");retry.hidden=true;
      footer.append(errorBox,el("p",t("hostNote"),"wf-muted"),retry,submit);f.append(footer);modal.replaceChildren(header,f);shell={error:errorBox};error("");(row?back:prompt).focus();
      let id=requestId(), catalogReady=false, sending=false;f.addEventListener("input",()=>{if(!sending)id=requestId();});
      function ready(){submit.disabled=sending||!catalogReady||!agent.value||!cwd.value||data?.available===false;}
      agent.addEventListener("change",ready);cwd.addEventListener("change",ready);
      async function loadAgents(){
        retry.hidden=true;
        try{
          const catalog=await api("/api/agents",undefined,target);if(token!==epoch||!modal)return;
          agent.replaceChildren();for(const item of catalog.connectors||[])if(item.installed&&AGENTS.includes(item.id)){const option=el("option",item.label||agentName(item.id));option.value=item.id;agent.append(option);}
          agent.value=row?.agentId||entry?.record.agentId||agent.options[0]?.value||"";catalogReady=true;
          error(!agent.value?t("noAgents"):!cwd.value?t("noProjects"):"");ready();
        }catch(e){if(token===epoch){error(e.message);retry.hidden=false;}}
      }
      f.onsubmit=async event=>{
        event.preventDefault();if(sending||!catalogReady||!agent.value||!cwd.value)return;
        if(!turns.checkValidity()||!tokens.checkValidity())advanced.open=true;
        if(!f.reportValidity())return;
        const input={requestId:id,kind:scheduling?"schedule":"goal",title:title.value.trim()||prompt.value.trim().split("\n")[0].slice(0,120),objective:prompt.value.trim(),cwd:cwd.value,agentId:agent.value,mode:mode?.value||"goal",limits:{minutes:Number(minutes.value),turns:Number(turns.value),outputTokens:Number(tokens.value)},...(entry?{entry:entry.key}:{})};
        if(scheduling){const date=new Date(at.value);input.schedule={kind:repeat.value,at:repeat.value==="once"&&Number.isFinite(date.getTime())?date.toISOString():null,time:time.value,timeZone:zone.value.trim(),minutes:Number(interval.value),days:dayInputs.filter(day=>day.checked).map(day=>Number(day.value))};}
        if(row)Object.assign(input,{id:row.id,action:"edit",enabled:row.enabled});
        const invalid=validate(input);if(invalid){error(t(invalid.slice(invalid.indexOf(".")+1)));return;}
        sending=true;pending=true;submit.textContent=t("requestPending");ready();error("");
        const fields=[...f.querySelectorAll("input,select,textarea,button")],disabled=fields.map(field=>field.disabled);fields.forEach(field=>field.disabled=true);
        try{
          const created=await call(input,target);if(token!==epoch||!modal)return;
          revision++;onChanged();if(created?.id)merge(created);loaded=true;connected=true;selected=created.id;filter="all";query="";editing=false;pending=false;
          buildShell();modal.dataset.screen="detail";await refresh();if(token!==epoch||!modal)return;poll();
          if(!scheduling&&entry)showConversation({entry:created.entry||entry.key,title:created.title});
          else shell.detail.querySelector(root.matchMedia?.("(max-width:700px)").matches?".wf-mobile-back":".wf-actions button")?.focus();
        }catch(e){if(token===epoch){error(e.message);sending=false;pending=false;fields.forEach((field,i)=>field.disabled=disabled[i]);submit.textContent=t(scheduling?"save":"start");ready();}}
      };
      await loadAgents();
    }
    async function open(which="goals",target=null,entryKey=null,objective="") {
      close();const token=++epoch;const resolved=await context(target);if(token!==epoch)return;
      contextValue=resolved;view=which==="schedules"?"schedules":"goals";filter="all";query="";selected=null;historyId=null;loaded=false;connected=false;errorText="";received.clear();
      data={runs:[],schedules:[]};modal=el("dialog","","wf-panel");modal.setAttribute("data-i18n-ignore","");doc.body.append(modal);modal.showModal();buildShell();
      root.dispatchEvent(new root.Event("stepsemble-workflow-panel"));modal.addEventListener("cancel",event=>{event.preventDefault();close();});
      clock=root.setInterval(updateClock,1000);await refresh();if(token!==epoch||!modal)return;
      if(entryKey){const entry=contextValue.entries?.find(item=>item.key===entryKey);if(entry){await form(null,entry,objective);return;}}
      shell.add.focus();poll();
    }
    return {open,close};
  }
  function mountConversation(options) { return root.StepsembleGoalComposer?.mount(options) || null; }
  return { create, mountConversation, label:t, duration, elapsed, scheduleState, scheduleLabel, validate };
});
