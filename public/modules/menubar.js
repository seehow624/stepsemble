"use strict";
(() => {
  const D = window.StepsembleMenubarData, U = window.StepsembleUsageData, $ = id => document.getElementById(id);
  const copy = {
    en: { details:"Data details", limits:"Limits", remaining:"Remaining", used:"Used", today:"Today", tokens:"Tokens", cost:"Estimated cost", refresh:"Refresh", all:"All Hosts", rate:"Output tok/s", burn:"Usage tok/min", hidden:"Icon only", animate:"Animate cat", live:"Live output", average:"Current model average", history:"Output · past 60s", waiting:"Waiting for output", unknownActivity:"Activity unavailable", historyNote:"Saved output over the past minute; not model decoding speed.", burnNote:"Usage / min includes input, output and cache.", partialActivity:"Some Hosts or histories are unavailable.", menu:"Menu bar", open:"Open usage ↗", estimate:"USD estimate · not a bill", loading:"Reading limits…", unknown:"Limits unavailable", offline:"Could not read this Host. Retry or open Stepsemble.", partial:"Some histories or prices are unavailable. These are the available totals.", aggregate:"Some usage is a session total, dated by its session start.", updated:"Updated", expires:"Resets", days:"d", hours:"h", minutes:"m", indexing:"Indexing history…", retry:"Retry" },
    "zh-Hant": { details:"資料詳情", limits:"額度", remaining:"剩餘", used:"已用", today:"今天", tokens:"Token 用量", cost:"估算費用", refresh:"重新整理", all:"所有 Host", rate:"輸出 tok/s", burn:"用量 tok/min", hidden:"只顯示圖示", animate:"貓咪動畫", live:"即時輸出", average:"本輪模型平均", history:"輸出 · 過去 60 秒", waiting:"等待模型輸出", unknownActivity:"暫無活動資料", historyNote:"過去一分鐘保存的輸出量，並非模型生成速度。", burnNote:"每分鐘用量包含輸入、輸出與快取。", partialActivity:"部分 Host 或歷史不可用。", menu:"選單列", open:"開啟用量 ↗", estimate:"USD 估算 · 非實際帳單", loading:"正在讀取額度…", unknown:"暫無額度資料", offline:"無法讀取此 Host，請重試或開啟 Stepsemble。", partial:"部分歷史或單價不可用，目前顯示可取得的總數。", aggregate:"部分用量為對話總數，按對話開始日期歸檔。", updated:"更新於", expires:"重置", days:"天", hours:"小時", minutes:"分", indexing:"正在建立歷史索引…", retry:"重試" },
    zh: { details:"数据详情", limits:"额度", remaining:"剩余", used:"已用", today:"今天", tokens:"Token 用量", cost:"估算费用", refresh:"刷新", all:"所有 Host", rate:"输出 tok/s", burn:"用量 tok/min", hidden:"只显示图标", animate:"猫咪动画", live:"实时输出", average:"本轮模型平均", history:"输出 · 过去 60 秒", waiting:"等待模型输出", unknownActivity:"暂无活动数据", historyNote:"过去一分钟保存的输出量，并非模型生成速度。", burnNote:"每分钟用量包含输入、输出与缓存。", partialActivity:"部分 Host 或历史不可用。", menu:"菜单栏", open:"打开用量 ↗", estimate:"USD 估算 · 非实际账单", loading:"正在读取额度…", unknown:"暂无额度数据", offline:"无法读取此 Host，请重试或打开 Stepsemble。", partial:"部分历史或价格不可用，当前显示可取得的总数。", aggregate:"部分用量为对话总数，按对话开始日期归档。", updated:"更新于", expires:"重置", days:"天", hours:"小时", minutes:"分", indexing:"正在建立历史索引…", retry:"重试" },
  };
  const get = key => { try { return localStorage.getItem(key); } catch { return null; } };
  const save = (key, value) => { try { localStorage.setItem(key,value); } catch {} };
  let storage; try { storage = localStorage; } catch {}
  const prefs = window.StepsembleWorkspaceI18n.preferences(storage, { prefersDark:matchMedia("(prefers-color-scheme: dark)").matches });
  const t = key => (copy[prefs.locale] || copy.en)[key] || copy.en[key] || key;
  document.documentElement.lang = prefs.locale; document.documentElement.dataset.theme = prefs.resolvedTheme;
  let machines = [], self = "", selected = null, report = null, quotas = [], unavailable = true, loading = true, sequence = 0, abort = null, retryTimer = null;
  let mode = get("stepsemble.quota-display.v1") === "used" ? "used" : "remaining";
  let metric = ["tokens","cost","rate","burn","hidden"].includes(get("stepsemble.menubar.metric.v1")) ? get("stepsemble.menubar.metric.v1") : "limits";
  const node = (tag,text="",cls="") => { const e=document.createElement(tag); e.textContent=text; e.className=cls; return e; };
  const post = body => window.webkit?.messageHandlers?.stepsemble?.postMessage(body);
  let activity = D.activity([]), activityBusy = false, activityAbort = null, activitySequence = 0, activityTimer = null;
  let animate = get("stepsemble.menubar.animate.v1") !== "off";
  function updateBadge() {
    let text = metric === "rate" ? (activity.rate === null ? "—" : (activity.estimated ? "≈ " : "") + D.rate(activity.rate,prefs.locale)) + " tok/s"
      : metric === "burn" ? D.compact(activity.tokensPerMinute,prefs.locale) + " tok/min" : D.badge(metric,report,quotas,mode,prefs.locale,unavailable);
    post({type:"menubar-summary",text,label:metric === "limits" ? t(mode) : t(metric),metric,rate:activity.rate,animate,locale:prefs.locale,
      activityHosts:(selected === null ? [] : selected ? machines.filter(m=>m.id===selected) : machines).map(m=>m.id===self?"":m.id)});
  }
  function renderActivity() {
    $("rate").textContent=(activity.rate !== null && activity.estimated ? "≈ " : "") + D.rate(activity.rate,prefs.locale);
    $("activity-label").textContent=t(activity.source === "live" ? activity.averaged ? "average" : "live" : activity.source === "history" ? "history" : activity.source === "waiting" ? "waiting" : "unknownActivity");
    $("activity-note").textContent=[activity.source === "history" ? t("historyNote") : "", activity.tokensPerMinute !== null ? D.compact(activity.tokensPerMinute,prefs.locale)+" tok/min · "+t("burnNote") : "", activity.partial ? t("partialActivity") : ""].filter(Boolean).join(" ");
    updateBadge();
  }
  async function refreshActivity() {
    if (window.StepsembleMenubarNativePolling || activityBusy || selected === null) return;
    activityBusy=true; const epoch=activitySequence, selection=selected, controller=new AbortController();activityAbort=controller;
    const timeout=setTimeout(()=>controller.abort(),7000);
    try {
      const targets=selected?machines.filter(m=>m.id===selected):machines;
      const results=await Promise.all(targets.map(m=>api("/api/workspace/activity",m.id,controller.signal).catch(()=>null)));
      if(epoch===activitySequence && selection===selected){activity=D.activity(results);renderActivity();}
    } finally {clearTimeout(timeout);if(epoch===activitySequence){activityBusy=false;activityAbort=null;}}
  }
  $("animate").checked=animate;$("animate-label").textContent=t("animate");
  $("animate").onchange=()=>{animate=$("animate").checked;save("stepsemble.menubar.animate.v1",animate?"on":"off");updateBadge();};
  function openUsage(agent="") {
    const body={type:"menubar-open",host:selected || "",tab:"usage",agent};
    if (window.webkit?.messageHandlers?.stepsemble) post(body);
    else { const p=new URLSearchParams({usageTab:"usage",host:selected || "",...(agent?{usageAgent:agent}:{})}); window.open("/workspace.html?"+p,"_blank","noopener"); }
  }
  for (const [id,key] of [["limits-title","limits"],["today-title","today"],["token-label","tokens"],["cost-label","cost"],["estimate-note","estimate"],["metric-label","menu"],["open","open"]]) $(id).textContent=t(key);
  $("refresh").setAttribute("aria-label",t("refresh")); $("hosts").setAttribute("aria-label",window.StepsembleWorkspaceI18n.t("host",{},prefs.locale));
  for (const option of $("metric").options) option.textContent=t(option.value); $("metric").value=metric;
  $("metric").onchange=()=>{metric=$("metric").value;save("stepsemble.menubar.metric.v1",metric);updateBadge();};
  function renderMode() {
    $("quota-mode").replaceChildren();
    for (const key of ["remaining","used"]) {const b=node("button",t(key));b.type="button";b.setAttribute("aria-pressed",String(mode===key));b.onclick=()=>{mode=key;save("stepsemble.quota-display.v1",mode);renderMode();render();};$("quota-mode").append(b);}
  }
  function resetLabel(at) {
    if (!Number.isFinite(at)) return "";
    const left=Math.max(0,at-Date.now()), n=Math.ceil(left/60000);
    return t("expires")+" "+(n>=1440?Math.ceil(n/1440)+t("days"):n>=60?Math.ceil(n/60)+t("hours"):n+t("minutes"));
  }
  function render() {
    $("limits").replaceChildren();
    for (const provider of quotas) {
      const row=node("div","","quota"), name=node("span",provider.label || provider.provider || provider.id,"quota-name"), windows=node("div","","windows"); row.append(name,windows);
      if (quotas.some(p=>p.hosts?.length>1) || !selected) name.append(node("small",(provider.hosts || []).map(h=>h.name).join(" · "),"quota-hosts"));
      const available=(provider.windows||[]).filter(w=>D.percent(w)!==null);
      const visible=available.slice(0,2);
      for (const w of visible) {
        const container=node("div","","window"), title=node("div","","window-top"), pct=D.percent(w,mode), minutes=w.windowDurationMins;
        const period=!Number.isFinite(minutes)?w.label || "—":minutes===10080?"7"+t("days"):minutes===43200?"30"+t("days"):minutes%60===0?minutes/60+t("hours"):minutes+t("minutes");
        title.append(node("span",period),node("strong",pct+"%"));
        const bar=node("div","","bar"+(D.percent(w)<=10?" low":"")), fill=node("span");fill.style.width=pct+"%";bar.append(fill);
        container.title=[provider.label || provider.provider || provider.id,period,pct+"% "+t(mode),resetLabel(w.resetsAt)].join(" · ");
        container.append(title,bar,node("div",resetLabel(w.resetsAt),"reset"));windows.append(container);
      }
      if (!visible.length) windows.append(node("span",t("unknown"),"empty"));
      $("limits").append(row);
    }
    if (!quotas.length) $("limits").append(node("p",t(loading?"loading":unavailable?"offline":"unknown"),"empty"));
    $("tokens").textContent=unavailable?"—":D.compact(report?.total.tokens,prefs.locale);
    $("cost").textContent=unavailable?"—":D.cost(report?.total,prefs.locale);
    $("agents").replaceChildren();
    const agents=(report?.agents||[]).slice(0,8), max=Math.max(1,...agents.map(a=>a.tokens));
    for (const a of agents) {const b=node("button","","agent");b.type="button";b.onclick=()=>openUsage(a.id);const track=node("span","","track"), fill=node("i");fill.style.width=(a.tokens/max*100)+"%";track.append(fill);b.append(node("span",D.AGENT_NAMES[a.id] || a.id),node("span",D.compact(a.tokens,prefs.locale),"amount"),track);$("agents").append(b);}
    updateBadge();
  }
  async function api(route,host="",signal) {
    const prefix=host && host!==self?"/r/"+encodeURIComponent(host):"";
    const res=await fetch(prefix+route,{credentials:"same-origin",cache:"no-store",signal});
    if (!res.ok) throw new Error("reading_unavailable");return res.json();
  }
  async function refresh(fresh=false) {
    clearTimeout(retryTimer);abort?.abort();abort=new AbortController();const signal=abort.signal,epoch=++sequence;
    const timeout=setTimeout(()=>abort?.signal===signal&&abort.abort(),25000);
    loading=true;$("refresh").disabled=true;
    try {
      const data=await api("/api/machines","",signal);
      if (epoch!==sequence) return;
      machines=(data.machines||[]).filter(m=>typeof m.id==="string" && /^[a-zA-Z0-9_-]{1,128}$/.test(m.id));
      self=data.current || data.selfId || machines.find(m=>m.self)?.id || machines.find(m=>m.local)?.id || machines[0]?.id;
      if (selected===null) {const wanted=get("stepsemble.menubar.host.v1") || get("stepsemble.selected.v1"); selected=wanted==="*"?"":machines.some(m=>m.id===wanted)?wanted:self;}
      if (selected && !machines.some(m=>m.id===selected)) {selected=self;++activitySequence;activityAbort?.abort();activityBusy=false;activity=D.activity([]);renderActivity();}
      const all=node("option",t("all"));all.value="";$("hosts").replaceChildren(all);
      for (const m of machines) {const o=node("option",m.name || m.id);o.value=m.id;$("hosts").append(o);}$("hosts").value=selected || "";
      // Start the live meter as soon as Hosts are known. A slow first history
      // scan or provider request must not leave the cat frozen during startup.
      updateBadge();void refreshActivity();
      const targets=selected?machines.filter(m=>m.id===selected):machines;
      const query=new URLSearchParams({...D.range(),...(fresh?{fresh:"1"}:{})});
      const results=await Promise.all(targets.map(async m=>{
        const [r,q]=await Promise.allSettled([api("/api/workspace/analytics?"+query,m.id,signal),api("/api/workspace/usage"+(fresh?"?fresh=1":""),m.id,signal)]);
        return {host:m.id,name:m.name,report:r.status==="fulfilled"?r.value:null,quota:q.status==="fulfilled"?q.value:null};
      }));
      if (epoch!==sequence) return;
      report=results.some(r=>r.report)?U.combine(results):null;
      unavailable=!report || !report.coverage.covered && !!(report.coverage.missing || report.coverage.partial || report.coverage.indexing);
      quotas=U.combineQuotas(results);
      const notes=[], details=[];
      if (results.some(r=>!r.report || !r.quota)) notes.push(t("offline"));
      if (report && (report.coverage.missing || report.coverage.partial || report.coverage.unsupported || report.total.unpricedCalls || report.total.unknownUnpricedRecords || report.total.incompleteCalls)) details.push(t("partial"));
      if (results.some(r=>r.report?.dateApproximateRecords>0)) details.push(t("aggregate"));
      if (report?.coverage.indexing) {notes.push(t("indexing"));retryTimer=setTimeout(()=>refresh(),3000);}
      $("data-details").hidden=!details.length;$("data-details-text").textContent=details.join(" ");$("notice").textContent=notes.join(" ");$("updated").textContent=t("updated")+" "+new Date().toLocaleTimeString(prefs.locale,{hour:"2-digit",minute:"2-digit"});loading=false;render();void refreshActivity();
    } catch (error) {if (epoch!==sequence) return;loading=false;unavailable=true;report=null;quotas=[];$("data-details").hidden=true;$("notice").textContent=t("offline");$("updated").textContent="";render();}
    finally {clearTimeout(timeout);if(epoch===sequence) $("refresh").disabled=false;}
  }
  $("hosts").onchange=()=>{++activitySequence;activityAbort?.abort();activityBusy=false;activity=D.activity([]);renderActivity();selected=$("hosts").value;save("stepsemble.menubar.host.v1",selected || "*");report=null;quotas=[];unavailable=true;loading=true;$("data-details").hidden=true;$("data-details").open=false;$("notice").textContent="";$("updated").textContent="";render();void refresh();};
  $("refresh").onclick=()=>refresh(true);$("open").onclick=()=>openUsage();
  window.addEventListener("storage",event=>{if(event.key==="stepsemble.quota-display.v1"){mode=get(event.key)==="used"?"used":"remaining";renderMode();render();}});
  window.StepsembleMenubarRefresh=()=>refresh();
  window.StepsembleMenubarActivity=()=>refreshActivity();
  window.StepsembleMenubarNativeActivity=results=>{activity=D.activity(results);renderActivity();};
  // Native heartbeat continues when WebKit throttles timers in a closed popover.
  if(!window.webkit?.messageHandlers?.stepsemble) activityTimer=setInterval(refreshActivity,2000);
  window.addEventListener("pagehide",()=>{++sequence;abort?.abort();clearTimeout(retryTimer);++activitySequence;activityAbort?.abort();clearInterval(activityTimer);});
  $("data-details-label").textContent=t("details");
  renderMode();$("limits").append(node("p",t("loading"),"empty"));void refresh();
})();
