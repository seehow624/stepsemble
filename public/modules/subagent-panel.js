/* The subagent bubble above the composer, its list and a read-only detail panel. */
(function(root,factory){const node=typeof module==="object"&&module.exports;const api=factory(node?require("./agent-identity"):root.StepsembleAgentIdentity);if(node)module.exports=api;else root.StepsembleSubagentPanel=api;})(typeof window!=="undefined"?window:globalThis,function(identity){
  "use strict";
  const TERMINAL=new Set(["completed","failed"]);
  // Agents that keep a subagent's work and settings where the Host can read them.
  const LOADED_ELSEWHERE=new Set(["codex","opencode","claude"]);
  const REFRESH_MS=5000, MAX_LOADING=3;
  function elapsed(row,now){
    // A saved conversation's subagent may carry no times at all.
    if(!Number.isSafeInteger(row?.durationMs)&&!Number.isFinite(row?.startedAt))return "";
    const running=!TERMINAL.has(row?.status)&&Number.isFinite(row?.startedAt);
    let ms=Number.isSafeInteger(row?.durationMs)&&(!running||row.status===undefined)?row.durationMs:(Number.isFinite(row?.endedAt)?row.endedAt:now)-(Number(row?.startedAt)||now);
    ms=Math.max(0,ms);const total=Math.floor(ms/1000),h=Math.floor(total/3600),m=Math.floor(total%3600/60),s=total%60,pad=v=>String(v).padStart(2,"0");
    return h?`${h}:${pad(m)}:${pad(s)}`:`${pad(m)}:${pad(s)}`;
  }
  function mount({document,container,t,now=Date.now,loadDetail=null}){
    const el=(tag,cls="",text="")=>{const node=document.createElement(tag);if(cls)node.className=cls;if(text)node.textContent=text;return node;};
    // extra: subagents of an earlier turn, opened from their transcript card.
    let rows=[],extra=new Map(),choices=null,openId=null,opener=null,loaded=new Map(),loading=new Set(),failed=new Set(),loadedStatus=new Map(),loadedAt=new Map(),flagged=new Set();
    const bubble=el("button","subagent-bubble");bubble.type="button";bubble.hidden=true;bubble.setAttribute("aria-expanded","false");
    const list=el("div","subagent-list");list.hidden=true;list.setAttribute("role","region");
    container.append(bubble,list);
    const drawer=el("aside","subagent-drawer");drawer.hidden=true;drawer.setAttribute("role","dialog");drawer.setAttribute("aria-modal","false");
    document.body.append(drawer);
    bubble.addEventListener("click",()=>{list.hidden=!list.hidden;bubble.setAttribute("aria-expanded",String(!list.hidden));if(!list.hidden)renderList();});
    const onKey=event=>{if(event.key==="Escape"&&openId!==null){event.preventDefault?.();close();}};
    document.addEventListener("keydown",onKey);
    function depth(row){let level=0,parent=row.parentId;const ids=new Map(rows.map(item=>[item.id,item]));while(parent&&ids.has(parent)&&level<3){level++;parent=ids.get(parent).parentId;}return level;}
    function statusChip(status){const chip=el("span","subagent-status",t("status_"+(status||"running")));chip.dataset.state=status||"running";return chip;}
    function renderBubble(){
      const total=rows.length,running=rows.filter(row=>!TERMINAL.has(row.status)).length,failures=rows.filter(row=>row.status==="failed").length;
      bubble.hidden=!total;if(!total){list.hidden=true;bubble.setAttribute("aria-expanded","false");return;}
      bubble.dataset.state=running?"running":"done";
      let label=running?(running===1?t("runningOne"):t("runningMany",{count:running})):(total===1?t("doneOne"):t("doneMany",{count:total}));
      if(!running&&failures)label+=" · "+t("failedPart",{count:failures});
      bubble.replaceChildren(el("span","subagent-bubble-label",label));list.setAttribute("aria-label",t("listLabel"));
    }
    function execution(row){
      const detail=loaded.get(row.id),source=detail?.harness||row.harness||row.source;
      const tool=identity.lookup(source==="claude"?"claude-code":source);
      const values=[["tool","harness",tool.id==="agent"?"":tool.label],["model","model",detail?.model||row.model],["thinking","thinking",detail?.reasoningEffort||row.reasoningEffort]];
      const metadata=el("dl","subagent-execution");
      for(const [name,label,value] of values){
        const field=el("div","subagent-execution-field"),text=typeof value==="string"?value.trim():"";
        const content=el("dd",`subagent-execution-${name}`,text||t("notProvided"));content.dataset.unknown=String(!text);
        field.append(el("dt","",t(label)),content);metadata.append(field);
      }
      return metadata;
    }
    function itemsFor(values){
      const items=el("ul","subagent-items");
      for(const row of values){
        const li=el("li"),item=el("button","subagent-item");item.type="button";item.dataset.depth=String(depth(row));item.dataset.id=row.id;
        const top=el("span","subagent-item-top");top.append(el("strong","subagent-name",row.name),statusChip(row.status));
        const time=elapsed(row,now());if(time)top.append(el("span","subagent-time",time));
        item.append(top,execution(row));
        if(row.task)item.append(el("span","subagent-task",row.task));
        if(row.activity&&!TERMINAL.has(row.status))item.append(el("span","subagent-activity",row.activity));
        if(row.background)item.append(el("span","subagent-flag",t("background")));
        item.addEventListener("click",()=>{choices=null;open(row.id);});
        li.append(item);items.append(li);
      }
      return items;
    }
    // A shown subagent's details load when its status changed since they last
    // did; while it runs, again every few seconds until its model is known,
    // or while its details are open.
    function loadable(row){return !!loadDetail&&(LOADED_ELSEWHERE.has(row.source)||row.source==="history"&&row.harness==="claude-code");}
    function wanted(row,opened){
      if(!loadable(row)||loading.has(row.id))return false;
      if(loadedStatus.get(row.id)!==row.status)return true;
      if(TERMINAL.has(row.status)||now()-(loadedAt.get(row.id)||0)<REFRESH_MS)return false;
      return opened||!loaded.get(row.id)?.model;
    }
    function request(values,opened=false){for(const row of values)if(loading.size<MAX_LOADING&&wanted(row,opened))void fetchDetail(row);}
    function renderList(){if(list.hidden)return;list.replaceChildren(itemsFor(rows));request(rows);}
    function entryNode(entry){
      if(entry.kind==="tool"){const node=el("li","subagent-log-tool");node.dataset.done=String(entry.done!==false);if(entry.error)node.dataset.error="true";node.append(el("strong","",entry.name||"tool"));if(entry.summary)node.append(el("span","",entry.summary));return node;}
      const node=el("li","subagent-log-text");node.append(el("p","",entry.text||""));return node;
    }
    function section(title,child){const node=el("section","subagent-section");node.append(el("h3","",title),child);return node;}
    function renderDrawer(){
      if(choices){
        const header=el("header","subagent-drawer-header"),dismiss=el("button","subagent-close","×");dismiss.type="button";dismiss.setAttribute("aria-label",t("close"));dismiss.addEventListener("click",close);
        header.append(el("h2","",t("listLabel")),dismiss);
        const shown=choices.map(id=>rows.find(item=>item.id===id)||extra.get(id)).filter(Boolean);
        drawer.replaceChildren(header,itemsFor(shown));request(shown);
        drawer.setAttribute("aria-label",t("listLabel"));drawer.hidden=false;return;
      }
      const row=rows.find(item=>item.id===openId)||extra.get(openId);
      if(!row){drawer.hidden=true;return;}
      if(wanted(row,true))void fetchDetail(row);
      const header=el("header","subagent-drawer-header"),heading=el("div");
      heading.append(el("h2","",row.name),statusChip(row.status));
      const meta=[elapsed(row,now()),Number.isSafeInteger(row.tokens)?t("tokens",{count:row.tokens.toLocaleString?row.tokens.toLocaleString():row.tokens}):""].filter(Boolean).join(" · ");
      if(meta)heading.append(el("p","subagent-meta",meta));
      const dismiss=el("button","subagent-close","×");dismiss.type="button";dismiss.setAttribute("aria-label",t("close"));dismiss.addEventListener("click",close);
      header.append(heading,dismiss);
      const notes=[];
      if(row.background)notes.push(el("p","subagent-note",t("background")));
      if(row.history)notes.push(el("p","subagent-note",t("fromHistory")));
      if(row.approvalUnavailable||flagged.has(row.id))notes.push(el("p","subagent-note",t("approvalUnavailable")));
      const log=row.log?.length?row.log:loaded.get(row.id)?.log||[];
      const logList=el("ol","subagent-log");
      if(log.length)for(const entry of log)logList.append(entryNode(entry));
      else logList.append(el("li","subagent-empty",loading.has(row.id)?t("loading"):failed.has(row.id)?t("detailUnavailable"):t("noActivity")));
      drawer.replaceChildren(header,execution(row),...notes,section(t("task"),el("pre","subagent-prompt",row.prompt||row.task)),section(t("activity"),logList),
        section(t("result"),row.result?el("pre","subagent-result",row.result):el("p","subagent-empty",t("noResult"))));
      drawer.setAttribute("aria-label",row.name);drawer.hidden=false;
    }
    async function fetchDetail(row){
      loading.add(row.id);loadedStatus.set(row.id,row.status);loadedAt.set(row.id,now());
      try{
        const detail=await loadDetail(row),text=(value,max)=>typeof value==="string"?value.slice(0,max):undefined;
        loaded.set(row.id,{log:Array.isArray(detail?.log)?detail.log:[],harness:text(detail?.harness,32),model:text(detail?.model,120),reasoningEffort:text(detail?.reasoningEffort,64)});
        if(detail?.approvalUnavailable)flagged.add(row.id);
        failed.delete(row.id);
      }
      catch{failed.add(row.id);}
      finally{loading.delete(row.id);renderList();if(openId===row.id||choices?.includes(row.id))renderDrawer();}
    }
    function open(id){if(!rows.some(row=>row.id===id)&&!extra.has(id))return;if(openId===null)opener=document.activeElement;openId=id;renderDrawer();}
    // Opens subagents a transcript card refers to, current or from an earlier turn.
    function show(values){
      const list=(Array.isArray(values)?values:[]).filter(row=>row?.id);
      if(!list.length)return;
      for(const row of list)if(!rows.some(item=>item.id===row.id))extra.set(row.id,row);
      while(extra.size>32)extra.delete(extra.keys().next().value);
      if(list.length===1){choices=null;open(list[0].id);return;}
      if(openId===null)opener=document.activeElement;choices=list.map(row=>row.id);openId="";renderDrawer();
    }
    function close(){
      openId=null;choices=null;drawer.hidden=true;
      const target=opener?.dataset?.id?Array.from(list.querySelectorAll(".subagent-item")).find(item=>item.dataset.id===opener.dataset.id)||opener:opener;
      opener=null;target?.focus?.();
    }
    function render(next){
      rows=Array.isArray(next)?next:[];
      renderBubble();renderList();
      if(openId!==null)renderDrawer();
      for(const id of new Set([...loaded.keys(),...loadedStatus.keys()]))if(!rows.some(row=>row.id===id)&&!extra.has(id)&&id!==openId){loaded.delete(id);loadedStatus.delete(id);loadedAt.delete(id);failed.delete(id);}
    }
    // An earlier turn's subagents shown here, as they now stand.
    function refresh(get){
      let changed=false;
      for(const id of extra.keys()){const row=get(id);if(row){extra.set(id,row);changed=true;}}
      if(changed&&openId!==null)renderDrawer();
    }
    // Another panel above the message box opening closes the list.
    function collapse(){if(list.hidden)return;list.hidden=true;bubble.setAttribute("aria-expanded","false");}
    function destroy(){document.removeEventListener("keydown",onKey);drawer.remove?.();bubble.remove?.();list.remove?.();}
    return {render,refresh,open,show,close,collapse,destroy,isOpen:()=>openId!==null};
  }
  return {mount,elapsed};
});
