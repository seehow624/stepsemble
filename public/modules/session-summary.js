/* A conversation's summary: its goals, the subagents it ran, the files it
   wrote and the sources it read, gathered from what the page already holds. */
(function(root,factory){const api=factory();if(typeof module==="object"&&module.exports)module.exports=api;else root.StepsembleSessionSummary=api;})(typeof window!=="undefined"?window:globalThis,function(){
  "use strict";
  const MAX_ROWS=50;
  const plain=value=>!!value&&typeof value==="object"&&!Array.isArray(value);
  // Tools that write a file, by the names agents give them.
  const WRITES=new Set(["write","edit","multiedit","multi_edit","notebookedit","notebook_edit","apply_patch","create_file","write_file","edit_file","str_replace_editor","str_replace_based_edit_tool"]);
  const FETCHES=new Set(["webfetch","web_fetch","fetch","fetch_url","browse"]);
  const SEARCHES=new Set(["websearch","web_search","search","google_search"]);
  const absolute=value=>/^(?:\/|~\/|[A-Za-z]:[\\/])/.test(value);
  const web=value=>{try{const url=new URL(value);return ["http:","https:"].includes(url.protocol)?url:null;}catch{return null;}};
  function label(url){const path=url.pathname.replace(/\/$/,"");return (url.hostname.replace(/^www\./,"")+(path.length>1?path:"")).slice(0,120);}
  // Newest first, each once.
  function newestFirst(rows,key){const seen=new Map();for(const row of rows){const id=key(row);seen.delete(id);seen.set(id,row);}return [...seen.values()].reverse().slice(0,MAX_ROWS);}
  function outputs(tools){
    const rows=[];
    for(const tool of Array.isArray(tools)?tools:[]){
      const name=String(tool?.name||"").toLowerCase(),args=plain(tool?.args)?tool.args:{};
      if(!WRITES.has(name))continue;
      const paths=[args.file_path,args.filePath,args.notebook_path,args.path,...(Array.isArray(args.changes)?args.changes.map(change=>change?.path):[])];
      for(const path of paths)if(typeof path==="string"&&path.trim()&&path!=="files")rows.push({path:path.trim(),openable:absolute(path.trim())});
    }
    return newestFirst(rows,row=>row.path);
  }
  function sources(tools,links){
    const rows=[];
    for(const tool of Array.isArray(tools)?tools:[]){
      const name=String(tool?.name||"").toLowerCase(),args=plain(tool?.args)?tool.args:{};
      const url=FETCHES.has(name)&&typeof args.url==="string"?web(args.url):null;
      if(url)rows.push({url:url.href,label:label(url)});
      else if(SEARCHES.has(name)&&typeof args.query==="string"&&args.query.trim())rows.push({query:args.query.trim().slice(0,200)});
    }
    for(const link of Array.isArray(links)?links:[]){const url=web(link);if(url)rows.push({url:url.href,label:label(url)});}
    return newestFirst(rows,row=>row.url||"?"+row.query);
  }
  function mount({document,container,t,onSubagent=()=>{},onFile=()=>{},onChanges=()=>{},fileLink}){
    const el=(tag,cls="",text="")=>{const node=document.createElement(tag);if(cls)node.className=cls;if(text)node.textContent=text;return node;};
    const panel=el("section","session-summary");panel.hidden=true;panel.setAttribute("role","dialog");panel.dataset.i18nIgnore="";
    container.append(panel);
    let collect=null,opener=null;
    function section(title,rows,empty){
      const box=el("section","session-summary-section"),list=el("ul","session-summary-list");
      box.append(el("h3","",title));
      if(rows.length)for(const row of rows){const li=el("li");li.append(row);list.append(li);}else list.append(el("li","session-summary-empty",empty));
      box.append(list);return box;
    }
    function render(){
      if(panel.hidden||!collect)return;
      const data=collect();
      const header=el("header","session-summary-header"),close=el("button","session-summary-close","×");
      close.type="button";close.setAttribute("aria-label",t("close"));close.addEventListener("click",hide);
      header.append(el("h2","",t("title")),close);
      const goals=(data.goals||[]).map(goal=>{const row=el("div","session-summary-goal");row.dataset.state=goal.state||"";
        row.append(el("span","session-summary-goal-objective",goal.objective),el("span","session-summary-meta",[goal.label,goal.elapsed].filter(Boolean).join(" · ")));return row;});
      const subagents=(data.subagents||[]).map(row=>{const item=el("button","session-summary-item");item.type="button";item.dataset.state=row.status||"";
        item.append(el("strong","",row.name||"subagent"),el("span","session-summary-meta",[row.statusLabel,row.task].filter(Boolean).join(" · ")));
        item.addEventListener("click",()=>{hide();onSubagent(row.id);});return item;});
      const files=(data.outputs||[]).map(row=>{
        if(!row.openable)return el("span","session-summary-path",row.path);
        const link=fileLink(row.path);link.classList.add("session-summary-path");
        link.addEventListener("click",event=>{event.preventDefault();onFile(link);});
        link.addEventListener("keydown",event=>{if(event.key==="Enter"||event.key===" "){event.preventDefault();onFile(link);}});
        return link;});
      const reads=(data.sources||[]).map(row=>{
        if(!row.url)return el("span","session-summary-query",row.query);
        const link=el("a","session-summary-link",row.label);link.href=row.url;link.target="_blank";link.rel="noopener noreferrer";link.title=row.url;return link;});
      const outputsBox=section(t("outputs"),files,t("noOutputs"));
      const changes=el("button","btn ghost session-summary-changes",t("viewChanges")+(data.changes?` · ${data.changes}`:""));changes.type="button";
      changes.addEventListener("click",()=>{hide();onChanges();});outputsBox.append(changes);
      panel.replaceChildren(header,section(t("goals"),goals,t("noGoals")),section(t("subagents"),subagents,t("noSubagents")),outputsBox,section(t("sources"),reads,t("noSources")));
      panel.setAttribute("aria-label",t("title"));
    }
    function show(source){collect=source;if(panel.hidden)opener=document.activeElement;panel.hidden=false;render();panel.querySelector("button")?.focus?.({preventScroll:true});}
    function hide(){if(panel.hidden)return;panel.hidden=true;const target=opener;opener=null;target?.focus?.({preventScroll:true});}
    function toggle(source){if(panel.hidden)show(source);else hide();}
    const onKey=event=>{if(event.key==="Escape"&&!panel.hidden){event.preventDefault?.();hide();}};
    const onPointer=event=>{if(!panel.hidden&&!panel.contains(event.target)&&!event.target?.closest?.("[data-summary-toggle]"))hide();};
    document.addEventListener("keydown",onKey);document.addEventListener("pointerdown",onPointer,true);
    return {show,hide,toggle,render,isOpen:()=>!panel.hidden,element:panel};
  }
  return {outputs,sources,mount};
});
