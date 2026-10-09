/* Shared Goal and schedule surfaces. All execution and clocks belong to the Host. */
(function (root) {
  "use strict";
  const en = { goals:"Goals", schedules:"Schedules", newGoal:"New Goal", newSchedule:"New schedule", close:"Close", back:"Back", title:"Name", objective:"Goal and completion criteria", project:"Project", agent:"Agent", mode:"Run mode", goal:"Work toward a Goal", task:"Run one task", limits:"Limits", minutes:"Time limit (minutes)", turns:"Maximum turns", tokens:"Output token budget", save:"Save", start:"Start Goal", pause:"Pause", resume:"Resume", stop:"Stop", run:"Run now", edit:"Edit", remove:"Delete", conversation:"Open conversation", result:"Latest result", next:"Next run", previous:"Last run", history:"Run history", schedule:"Repeat", once:"Once", daily:"Every day", weekly:"Every week", interval:"At an interval", every:"Interval (minutes)", time:"Time", timeZone:"Time zone", date:"Date and time", days:"Weekdays", hostNote:"Runs on this Host. Keep the computer awake and Stepsemble running. Closing this page does not stop a task.", modelNote:"New conversations use this agent’s saved model and normal permission settings. Approvals remain in the conversation.", emptyGoals:"Give an agent a goal. Follow its work here, even after you close the conversation.", emptySchedules:"Choose when an agent should work. Each run gets its own conversation and result.", elapsed:"Worked for", turn:"turns", live:"Current activity", waiting:"Waiting for you", queued:"Queued", starting:"Starting", running:"Working", stopping:"Stopping", paused:"Paused", blocked:"Needs your input", interrupted:"Interrupted", limited:"Limit reached", completed:"Completed", failed:"Failed", stopped:"Stopped", thinking:"Thinking", approval:"Waiting for approval", inactive:"Paused", ended:"Finished", unavailable:"Tasks are unavailable on this Host", noAgents:"No supported agents installed", refreshError:"Connection interrupted. Showing the last update.", removeConfirm:"Delete this schedule? Existing runs are kept.", newHint:"Describe what should be done and how the agent should verify it.", late:"Started after its scheduled time", retry:"Try again", returnChat:"Return to conversation", sun:"Sun", mon:"Mon", tue:"Tue", wed:"Wed", thu:"Thu", fri:"Fri", sat:"Sat" };
  const zh = { goals:"目標", schedules:"排程", newGoal:"新增 Goal", newSchedule:"新增排程", close:"關閉", back:"返回", title:"名稱", objective:"目標與完成條件", project:"專案", agent:"Agent", mode:"執行方式", goal:"持續推進目標", task:"執行一次任務", limits:"執行上限", minutes:"時間上限（分鐘）", turns:"最多接續回合", tokens:"輸出 Token 預算", save:"儲存", start:"開始 Goal", pause:"暫停", resume:"繼續", stop:"停止", run:"立即執行", edit:"編輯", remove:"刪除", conversation:"開啟對話", result:"最新結果", next:"下次執行", previous:"上次執行", history:"執行紀錄", schedule:"重複方式", once:"單次", daily:"每天", weekly:"每週", interval:"固定間隔", every:"間隔（分鐘）", time:"時間", timeZone:"時區", date:"日期與時間", days:"星期", hostNote:"任務在這台 Host 上執行。電腦需保持喚醒，並運行 Stepsemble；關閉此頁不會停止任務。", modelNote:"新對話沿用該 Agent 的模型與一般權限設定。需要批准的操作會在對話中等待你處理。", emptyGoals:"給 Agent 一個目標。即使關閉對話，也能在這裡查看它的工作。", emptySchedules:"安排 Agent 開始工作的時間。每次執行都有獨立對話與結果。", elapsed:"已工作", turn:"回合", live:"目前活動", waiting:"等待你處理", queued:"排隊中", starting:"啟動中", running:"工作中", stopping:"正在停止", paused:"已暫停", blocked:"需要你的回覆", interrupted:"執行中斷", limited:"已達上限", completed:"已完成", failed:"執行失敗", stopped:"已停止", thinking:"思考中", approval:"等待批准", inactive:"已暫停", ended:"已結束", unavailable:"這台 Host 暫時無法使用目標與排程", noAgents:"尚未安裝支援的 Agent", refreshError:"連線中斷，目前顯示上次更新。", removeConfirm:"刪除此排程？既有執行紀錄會保留。", newHint:"描述要完成的工作，以及如何確認完成。", late:"已補跑錯過的排程", retry:"重試", returnChat:"返回對話", sun:"日", mon:"一", tue:"二", wed:"三", thu:"四", fri:"五", sat:"六" };
  const t = key => (/^zh/.test(document.documentElement.lang) ? zh[key] : en[key]) || key;
  const el = (tag, content = "", cls = "") => { const e = document.createElement(tag); e.className = cls; e.textContent = content; return e; };
  function button(label, action, cls = "") { const b = el("button", label, `btn ${cls}`); b.type = "button"; b.onclick = action; return b; }
  const active = row => ["starting","running","waiting","stopping","queued"].includes(row.status);
  const resumable = row => ["paused","blocked","interrupted"].includes(row.status);
  function duration(ms) { const s = Math.floor(Math.max(0, ms) / 1000); return `${Math.floor(s / 3600) ? `${Math.floor(s / 3600)}h ` : ""}${Math.floor(s / 60) % 60}m ${s % 60}s`; }
  const stamp = (n, timeZone) => n ? new Date(n).toLocaleString(document.documentElement.lang, timeZone ? {timeZone} : undefined) : "—";
  function create({ api, context, openConversation, onChanged = () => {} }) {
    let modal = null, timer = null, epoch = 0, view = "goals", data = null, contextValue = null, receivedAt = 0, editing = false;
    function close() { epoch++; clearTimeout(timer); modal?.close(); modal?.remove(); root.dispatchEvent(new Event("stepsemble-workflow-panel")); modal = null; editing = false; }
    const call = (body, target = contextValue.target) => api("/api/workflows", body, target);
    function error(message) { const e = modal?.querySelector(".wf-error"); if (!e) return; e.textContent = message; e.hidden = !message; }
    async function action(row, name) {
      if (name === "delete" && !root.confirm(t("removeConfirm"))) return;
      const controls = [...modal.querySelectorAll("button")]; controls.forEach(b => b.disabled = true);
      try { await call({ id: row.id, action: name }); onChanged(); await refresh(); }
      catch (e) { error(e.message); }
      finally { controls.forEach(b => b.disabled = false); }
    }
    function nav() {
      const header = el("header", "", "wf-header");
      const copy = el("div"); copy.append(el("small", contextValue.hostName), el("h1", t(view)));
      header.append(copy, button(t("close"), close, "ghost"));
      const tabs = el("nav", "", "wf-tabs"); tabs.setAttribute("aria-label", "Goals and schedules");
      for (const key of ["goals","schedules"]) { const b = button(t(key), () => { editing = false; view = key; render(); }); b.setAttribute("aria-current", String(view === key)); tabs.append(b); }
      tabs.append(button(t(view === "goals" ? "newGoal" : "newSchedule"), () => form(), "primary wf-add"));
      return [header, tabs];
    }
    function runCard(row) {
      const card = el("article", "", "wf-card"); card.dataset.state = row.status; card.dataset.runId = row.id;
      const head = el("div", "", "wf-card-head"); head.append(el("strong", row.title), el("span", t(row.status), "wf-status"));
      const ms = row.elapsedMs + (["starting","running","waiting"].includes(row.status) ? Date.now() - receivedAt : 0);
      const time = el("span", `${t("elapsed")} ${duration(ms)}`, "wf-clock"); time.dataset.run = row.id;
      card.append(head, el("p", row.objective, "wf-objective"), el("small", `${row.agentId} · ${row.cwd}`, "wf-project"));
      const meta = el("div", "", "wf-meta"); meta.append(time, el("span", `${row.turns} ${t("turn")} · ${row.outputTokens.toLocaleString()} tokens`)); card.append(meta);
      if (active(row)) card.append(el("p", `${t("live")} · ${t(row.activity)}`, "wf-activity"));
      if (row.error) card.append(el("p", row.error, "wf-run-error"));
      if (row.scheduledAt && row.startedAt - row.scheduledAt > 60000) card.append(el("small", t("late")));
      if (row.result) { const details = el("details"); details.append(el("summary", t("result")), el("pre", row.result, "wf-result")); card.append(details); }
      const actions = el("div", "", "wf-actions");
      if (row.entry) actions.append(button(t("conversation"), () => { const target = contextValue.target; close(); openConversation(row.entry, row.title, target); }));
      if (active(row) && row.status !== "stopping") actions.append(button(t("pause"), () => action(row, "pause")));
      if (resumable(row)) actions.append(button(t("resume"), () => action(row, "resume")));
      if ((active(row) || resumable(row)) && (row.status !== "stopping" || row.error)) actions.append(button(t("stop"), () => action(row, "stop"), "ghost"));
      card.append(actions); return card;
    }
    function scheduleCard(row) {
      const card = el("article", "", "wf-card"), head = el("div", "", "wf-card-head");
      head.append(el("strong", row.title), el("span", row.enabled ? t(row.schedule.kind) : t("paused"), "wf-status"));
      card.dataset.runId = row.id;
      card.append(head, el("p", row.objective, "wf-objective"), el("small", `${row.agentId} · ${row.cwd}`, "wf-project"));
      card.append(el("p", `${t("next")} · ${row.enabled ? stamp(row.nextAt, row.schedule.timeZone) : "—"}${row.schedule.timeZone ? ` · ${row.schedule.timeZone}` : ""}`, "wf-meta"));
      const history = data.runs.filter(r => r.scheduleId === row.id).reverse();
      if (history[0]) card.append(el("small", `${t("previous")} · ${stamp(history[0].startedAt || history[0].createdAt, row.schedule.timeZone)} · ${t(history[0].status)}`));
      const controls = el("div", "", "wf-actions");
      controls.append(button(t("run"), () => action(row, "run")), button(t("edit"), () => form(row)), button(t(row.enabled ? "pause" : "resume"), () => action(row, row.enabled ? "pause" : "resume")), button(t("remove"), () => action(row, "delete"), "ghost"));
      card.append(controls);
      if (history.length) { const details = el("details"); details.append(el("summary", `${t("history")} · ${history.length}`)); for (const run of history) details.append(runCard(run)); card.append(details); }
      return card;
    }
    function render() {
      if (!modal || editing) return;
      const scroll = modal.scrollTop, focusId = document.activeElement?.dataset?.focus;
      const expanded = new Set([...modal.querySelectorAll("details[open]")].map(d => d.dataset.key));
      const errorBox = el("p", "", "wf-error"); errorBox.setAttribute("role", "status"); errorBox.hidden = true;
      const list = el("div", "", "wf-list");
      const rows = view === "goals" ? [...(data?.runs || [])].reverse() : data?.schedules || [];
      if (!rows.length) list.append(el("p", t(view === "goals" ? "emptyGoals" : "emptySchedules"), "wf-empty"));
      else for (const row of rows) list.append(view === "goals" ? runCard(row) : scheduleCard(row));
      modal.replaceChildren(...nav(), errorBox, list, el("p", t("hostNote"), "wf-note"));
      for (const card of modal.querySelectorAll(".wf-card")) {
        [...card.querySelectorAll(":scope > .wf-actions button")].forEach((b,i) => b.dataset.focus = `${card.dataset.runId}:${i}`);
        [...card.querySelectorAll(":scope > details")].forEach((d,i) => { d.dataset.key = `${card.dataset.runId}:${i}`; d.open = expanded.has(d.dataset.key); });
      }
      modal.scrollTop = scroll;
      if (focusId) modal.querySelector(`[data-focus="${CSS.escape(focusId)}"]`)?.focus();
    }
    async function refresh() {
      const token = epoch;
      try { const next = await call(); if (token !== epoch || !modal) return; data = next; receivedAt = Date.now(); if (!next.available) error(t("unavailable")); else render(); }
      catch (e) { if (token === epoch) error(e.message || t("refreshError")); }
    }
    function field(form, label, type, value, options = null) {
      const box = el("label", "", "wf-field"); box.append(el("span", t(label)));
      const input = el(type === "textarea" ? "textarea" : options ? "select" : "input");
      if (options) for (const [val, name] of options) { const o = el("option", name); o.value = val; input.append(o); }
      else if (type !== "textarea") input.type = type;
      input.value = value ?? ""; input.required = true; input.name = label;
      if (type === "textarea") { input.rows = 5; input.maxLength = 16000; input.placeholder = t("newHint"); }
      box.append(input); form.append(box); return input;
    }
    async function form(row = null, entry = null, objective = "") {
      editing = true; clearTimeout(timer); const token = ++epoch;
      const scheduling = view === "schedules", header = el("header", "", "wf-header");
      header.append(el("h2", t(row ? "edit" : scheduling ? "newSchedule" : "newGoal")), button(t("back"), () => { editing = false; render(); poll(); }));
      const f = el("form", "", "wf-form"), errorBox = el("p", "", "wf-error"); errorBox.setAttribute("role", "alert"); errorBox.hidden = true;
      const title = field(f,"title","text", row?.title || ""); title.maxLength = 120;
      const prompt = field(f,"objective","textarea", row?.objective || objective);
      const pair = el("div", "", "wf-grid"); f.append(pair);
      const projects = [...new Set([...(contextValue.projects || []), row?.cwd, entry?.record.cwd].filter(Boolean))];
      const cwd = field(pair,"project","text", row?.cwd || entry?.record.cwd || projects[0], projects.map(p => [p,p]));
      const agent = field(pair,"agent","text", row?.agentId || entry?.record.agentId, [["", "…"]]);
      if (entry) { cwd.disabled = true; agent.disabled = true; }
      const mode = scheduling ? field(f,"mode","text",row?.mode || "task", [["task",t("task")],["goal",t("goal")]]) : null;
      let repeat, at, time, zone, interval, dayInputs;
      if (scheduling) {
        repeat = field(f,"schedule","text",row?.schedule.kind || "daily", ["once","daily","weekly","interval"].map(k => [k,t(k)]));
        const localDate = n => { const d = new Date(n); return new Date(d.getTime() - d.getTimezoneOffset()*60000).toISOString().slice(0,16); };
        at = field(f,"date","datetime-local",localDate(row?.schedule.at || Date.now()+3600000));
        time = field(f,"time","time",row?.schedule.time || "09:00");
        zone = field(f,"timeZone","text",row?.schedule.timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone);
        interval = field(f,"every","number",row?.schedule.minutes || 60); interval.min = 15; interval.max = 10080;
        const days = el("fieldset", "", "wf-days"); days.append(el("legend",t("days"))); dayInputs = [];
        ["sun","mon","tue","wed","thu","fri","sat"].forEach((key,i) => { const label = el("label"), input = el("input"); input.type="checkbox"; input.value=String(i); input.checked=(row?.schedule.days || [1,2,3,4,5]).includes(i); label.append(input,el("span",t(key))); days.append(label); dayInputs.push(input); }); f.append(days);
        const sync = () => { for (const [control, visible] of [[at,repeat.value==="once"],[time,["daily","weekly"].includes(repeat.value)],[zone,["daily","weekly"].includes(repeat.value)],[interval,repeat.value==="interval"]]) { control.parentElement.hidden=!visible; control.disabled=!visible; } days.hidden=repeat.value!=="weekly"; };
        repeat.onchange=sync; sync();
      }
      const limits = el("div", "", "wf-grid wf-limits"); f.append(el("h3",t("limits")),limits);
      const minutes=field(limits,"minutes","number",row?.limits.minutes || 60); minutes.min=1; minutes.max=1440;
      const turns=field(limits,"turns","number",row?.limits.turns || 20); turns.min=1; turns.max=100;
      const tokens=field(limits,"tokens","number",row?.limits.outputTokens || 100000); tokens.min=100; tokens.max=10000000;
      let requestId = crypto.randomUUID();
      f.addEventListener("input", () => { requestId = crypto.randomUUID(); });
      const submit=el("button",t(scheduling?"save":"start"),"btn primary"); submit.type="submit"; submit.disabled=true;
      f.append(el("p",t("modelNote"),"wf-note"),errorBox,submit); modal.replaceChildren(header,f); title.focus();
      f.onsubmit=async event => {
        event.preventDefault(); submit.disabled=true; error("");
        const input={ requestId, kind:scheduling?"schedule":"goal", title:title.value, objective:prompt.value, cwd:cwd.value, agentId:agent.value, mode:mode?.value || "goal", limits:{minutes:Number(minutes.value),turns:Number(turns.value),outputTokens:Number(tokens.value)}, ...(entry?{entry:entry.key}:{}) };
        if (scheduling) input.schedule={kind:repeat.value, at:repeat.value==="once"&&at.value?new Date(at.value).toISOString():null,time:time.value,timeZone:zone.value,minutes:Number(interval.value),days:dayInputs.filter(i=>i.checked).map(i=>Number(i.value))};
        if(row) Object.assign(input,{id:row.id,action:"edit",enabled:row.enabled});
        try { const created=await call(input); if(token!==epoch)return; onChanged(); editing=false; view=scheduling?"schedules":"goals"; await refresh(); poll(); if(!scheduling && entry) { const target=contextValue.target; close(); openConversation(created.entry||entry.key,created.title,target); } }
        catch(e){ error(e.message); submit.disabled=false; }
      };
      try { const catalog=await api("/api/agents",undefined,contextValue.target); if(token!==epoch)return;
        agent.replaceChildren(); for(const a of catalog.connectors||[]) if(a.installed && ["pi","codex","claude-code","omp","opencode","cline","kilo","hermes","grok-build"].includes(a.id)) {const o=el("option",a.label||a.id);o.value=a.id;agent.append(o);}
        agent.value=row?.agentId||entry?.record.agentId||agent.options[0]?.value||""; submit.disabled=!agent.value||!cwd.value; if(!agent.value)error(t("noAgents"));
      }catch(e){error(e.message);}
    }
    function poll() { clearTimeout(timer); if (!modal || editing) return; timer=setTimeout(async()=>{await refresh();poll();},4000); }
    async function open(which="goals", target=null, entryKey=null, objective="") {
      close(); const token=++epoch; const resolved=await context(target); if(token!==epoch)return; contextValue=resolved; view=which;
      modal=el("dialog","","wf-panel"); modal.setAttribute("aria-label",t(which));modal.setAttribute("data-i18n-ignore","");document.body.append(modal);modal.showModal();root.dispatchEvent(new Event("stepsemble-workflow-panel"));modal.addEventListener("cancel",e=>{e.preventDefault();close();});
      data={runs:[],schedules:[]};receivedAt=Date.now();render();
      await refresh(); if(token!==epoch||!modal)return;
      if(entryKey) { const entry=contextValue.entries.find(e=>e.key===entryKey); if(entry) {await form(null,entry,objective);return;} }
      modal.querySelector("button")?.focus(); poll();
    }
    return {open,close};
  }
  function mountConversation({ api, post }) {
    const key = new URLSearchParams(location.search).get("entry"); if(!key)return;
    const toolbar=document.querySelector(".composer-toolbar"), messages=document.getElementById("messages"); if(!toolbar||!messages)return;
    const create=button("◎ Goal",()=>root.parent.postMessage({type:"workspace-goal",objective:document.getElementById("input")?.value||""},location.origin),"ghost wf-goal-button");
    create.setAttribute("data-i18n-ignore","");toolbar.insertBefore(create,document.getElementById("btn-abort")||toolbar.lastElementChild);
    const banner=el("section","","wf-banner");banner.hidden=true;banner.setAttribute("data-i18n-ignore","");banner.setAttribute("aria-label","Goal");messages.before(banner);
    let latest=null, received=0, loading=false, disconnected=false;
    const render=()=>{
      if(!latest){banner.hidden=true;return;}banner.hidden=false;const r=latest;
      const copy=el("div","","wf-banner-copy");copy.append(el("strong",`◎ ${r.title}`),el("small",`${t(r.status)} · ${t("elapsed")} ${duration(r.elapsedMs+(!disconnected&&["starting","running","waiting"].includes(r.status)?Date.now()-received:0))}`),el("span",disconnected?t("refreshError"):active(r)?`${t("live")} · ${t(r.activity)}`:r.error||r.result.slice(0,180),"wf-banner-activity"));
      const actions=el("div","","wf-actions");const act=async name=>{try{await post("/api/workflows",{id:r.id,action:name});await refresh();}catch(e){copy.append(el("small",e.message));}};
      if(active(r)&&r.status!=="stopping")actions.append(button(t("pause"),()=>act("pause")));
      if(resumable(r))actions.append(button(t("resume"),()=>act("resume")));
      if((active(r)||resumable(r))&&(r.status!=="stopping"||r.error))actions.append(button(t("stop"),()=>act("stop")));
      actions.append(button(t("goals"),()=>root.parent.postMessage({type:"workspace-goals"},location.origin),"ghost"));
      const focused=banner.contains(document.activeElement)?document.activeElement.textContent:null;
      banner.replaceChildren(copy,actions);create.disabled=active(r);
      if(focused)[...actions.children].find(b=>b.textContent===focused)?.focus();
    };
    async function refresh(){if(loading||document.hidden)return;loading=true;try{const data=await api("/api/workflows?entry="+encodeURIComponent(key));latest=[...(data.runs||[])].reverse().find(r=>r.entry===key)||null;received=Date.now();disconnected=false;render();}catch{disconnected=true;render();}finally{loading=false;}}
    root.addEventListener("message",event=>{if(event.origin===location.origin&&event.source===root.parent&&event.data?.type==="workspace-workflows-changed")void refresh();});
    const timer=setInterval(()=>{void refresh();},1500);root.addEventListener("pagehide",()=>clearInterval(timer),{once:true});void refresh();
  }
  root.StepsembleWorkflows={create,mountConversation,label:t};
})(window);
