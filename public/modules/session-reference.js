/* Sessions referenced from the composer: each becomes a handoff summary the
   Host writes, shown as a chip, previewed and editable, appended on send. */
(function(root,factory){const api=factory();if(typeof module==="object"&&module.exports)module.exports=api;else root.StepsembleSessionReference=api;})(typeof window!=="undefined"?window:globalThis,function(){
  "use strict";
  const MAX=3, ACTIVE=new Set(["starting","running","queued"]), DONE=new Set(["completed"]);
  const codeOf=error=>{const code=error?.code||error?.data?.code||error?.message;return typeof code==="string"&&/^[a-z_]+$/.test(code)?code:"reference_failed";};
  // listSessions: the Host's other sessions for the picker, the way to add a
  // reference without dragging (keyboard, phone).
  function create({document,container,request,getContext,t,reason=code=>t(code),schedule=fn=>setTimeout(fn,1500),cancel=id=>clearTimeout(id),onChange=()=>{},listSessions=null}){
    const el=(tag,cls="",text="")=>{const node=document.createElement(tag);if(cls)node.className=cls;if(text)node.textContent=text;return node;};
    let refs=[],stamp=null,waiters=[],dialog=null,picker=null;
    const fenceOf=()=>{const context=getContext();return `${context.context||""}\n${context.entry||""}`;};
    // A conversation switch leaves the old draft's references behind.
    function sync(){const current=fenceOf();if(stamp!==null&&stamp!==current&&refs.length){for(const ref of refs)stop(ref);refs=[];settle();}stamp=current;}
    const alive=(ref,fence)=>fence===fenceOf()&&refs.includes(ref);
    function stop(ref){if(ref.timer){cancel(ref.timer);ref.timer=null;}if(ACTIVE.has(ref.state)&&ref.jobId)void Promise.resolve(request("/api/handoff/summary/cancel",{id:ref.jobId})).catch(()=>{});}
    function settle(){
      const waiting=refs.some(ref=>ACTIVE.has(ref.state)),blocked=refs.some(ref=>["failed","needs_confirm"].includes(ref.state));
      if(waiting)return;
      const list=waiters;waiters=[];for(const resolve of list)resolve(!blocked);
    }
    function changed(){render();settle();try{onChange();}catch{}}
    function apply(ref,job,fence){
      ref.jobId=job?.id||ref.jobId;ref.progress=job?.progress||ref.progress;ref.agent=job?.agentId||ref.agent;ref.coveredTurns=job?.coveredTurns??ref.coveredTurns;ref.cwd=String(job?.sourceCwd||ref.cwd||"").slice(0,1000);
      const status=job?.status;
      if(status==="completed"){ref.state="completed";ref.summary=String(job.summary||"");ref.plain=false;}
      else if(status==="needs_confirm"){ref.state="needs_confirm";ref.estimatedTokens=job.estimatedTokens||0;}
      else if(status==="failed"||status==="cancelled"){const raw=String(job.error||"");ref.state="failed";ref.error=/^[a-z_]+$/.test(raw)?reason(raw):raw.slice(0,300)||reason("reference_failed");}
      else{ref.state="running";ref.timer=schedule(()=>poll(ref,fence));}
      changed();
    }
    async function poll(ref,fence){
      ref.timer=null;
      if(!alive(ref,fence)){sync();return;}
      try{const job=await request(`/api/handoff/summary?id=${encodeURIComponent(ref.jobId)}`);if(alive(ref,fence))apply(ref,job,fence);else sync();}
      catch{if(alive(ref,fence))ref.timer=schedule(()=>poll(ref,fence));}
    }
    async function start(ref,{confirm=false}={}){
      const fence=fenceOf(),target=getContext().entry;
      ref.state="starting";ref.error="";changed();
      try{const job=await request("/api/handoff/summary",{source:ref.key,target,...(confirm?{confirm:true}:{})});if(alive(ref,fence))apply(ref,job,fence);}
      catch(error){if(alive(ref,fence)){ref.state="failed";ref.error=reason(codeOf(error));changed();}}
    }
    async function plain(ref){
      const fence=fenceOf(),target=getContext().entry;
      ref.state="starting";changed();
      try{
        const value=await request(`/api/handoff/digest?source=${encodeURIComponent(ref.key)}&target=${encodeURIComponent(target)}`);
        if(!alive(ref,fence))return;
        Object.assign(ref,{state:"completed",summary:String(value?.summary||""),plain:true,coveredTurns:value?.coveredTurns??ref.coveredTurns,cwd:String(value?.sourceCwd||ref.cwd||"").slice(0,1000)});changed();
      }catch(error){if(alive(ref,fence)){ref.state="failed";ref.error=reason(codeOf(error));changed();}}
    }
    function add(session){
      sync();const context=getContext();
      if(!session?.key)return {added:false,reason:"unsupported"};
      if(session.key===context.entry)return {added:false,reason:"self"};
      if(session.host&&context.host&&session.host!==context.host)return {added:false,reason:"otherHost"};
      if(refs.some(ref=>ref.key===session.key))return {added:false,reason:"duplicate"};
      if(refs.length>=MAX)return {added:false,reason:"limit"};
      const ref={key:session.key,title:String(session.title||"").slice(0,200)||session.key.slice(0,8),agentId:String(session.agentId||""),state:"starting",progress:{done:0,total:1},summary:"",edited:null,plain:false,coveredTurns:0,error:"",timer:null,jobId:null};
      refs.push(ref);void start(ref);return {added:true};
    }
    function remove(key){const ref=refs.find(item=>item.key===key);if(!ref)return;stop(ref);refs=refs.filter(item=>item!==ref);changed();}
    function clear(){for(const ref of refs)stop(ref);refs=[];dialog?.close?.();picker?.close?.();changed();}
    function count(){sync();return refs.length;}
    function ready(){sync();return refs.every(ref=>DONE.has(ref.state));}
    function whenReady(){sync();return new Promise(resolve=>{waiters.push(resolve);settle();});}
    function compose(text){
      sync();
      // Same Host: the source's project path is one the reader can open too.
      const blocks=refs.filter(ref=>DONE.has(ref.state)).map(ref=>`---\nReference: session "${ref.title}" (${[ref.agentId||"agent",ref.cwd].filter(Boolean).join(", ")}), ${ref.plain?"plain digest":"handoff summary"} through turn ${ref.coveredTurns}:\n${ref.edited??ref.summary}`);
      return [String(text||""),...blocks].filter(Boolean).join("\n\n");
    }
    function preview(ref){
      if(!dialog){dialog=el("dialog","session-ref-dialog");document.body.append(dialog);}
      const editor=el("textarea","session-ref-editor");editor.value=ref.edited??ref.summary;editor.setAttribute("aria-label",t("previewTitle"));
      const save=el("button","btn primary session-ref-save",t("save"));save.type="button";
      save.addEventListener("click",()=>{ref.edited=editor.value;dialog.close();changed();});
      const dismiss=el("button","btn ghost session-ref-close",t("close"));dismiss.type="button";dismiss.addEventListener("click",()=>dialog.close());
      const actions=el("div","session-ref-actions");actions.append(dismiss,save);
      const meta=ref.plain?t("previewPlainMeta",{turn:ref.coveredTurns}):t("previewMeta",{agent:ref.agent||"",turn:ref.coveredTurns});
      dialog.replaceChildren(el("h2","",`${t("previewTitle")} · ${ref.title}`),el("p","session-ref-meta",meta),editor,actions);
      dialog.showModal?.();editor.focus?.();
    }
    function available(){return typeof listSessions==="function";}
    async function pick(){
      if(!available())return;
      sync();const fence=fenceOf(),self=getContext().entry;
      if(!picker){picker=el("dialog","session-ref-dialog session-ref-picker");document.body.append(picker);}
      const search=el("input","session-ref-search");search.type="search";search.placeholder=t("pickSearch");search.setAttribute("aria-label",t("pickSearch"));
      const status=el("p","session-ref-pick-status");status.setAttribute("role","status");
      const list=el("div","session-ref-pick-list");
      const dismiss=button("btn ghost session-ref-close",t("close"),()=>picker.close());
      const actions=el("div","session-ref-actions");actions.append(dismiss);
      picker.replaceChildren(el("h2","",t("pickTitle")),search,status,list,actions);
      let sessions=[];
      const draw=()=>{
        const query=String(search.value||"").trim().toLowerCase();
        const shown=sessions.filter(row=>!query||[row.title,row.agentLabel,row.agentId,row.cwd].some(value=>String(value||"").toLowerCase().includes(query)));
        list.replaceChildren(...shown.map(row=>{
          const added=refs.some(ref=>ref.key===row.key);
          const item=button("session-ref-pick","",()=>{
            const result=add(row);
            if(result.added)picker.close();else status.textContent=t(result.reason==="unsupported"?"reference_source_unavailable":result.reason);
          });
          item.append(el("strong","",row.title||row.key.slice(0,8)),el("small","",[row.agentLabel||row.agentId,row.cwd].filter(Boolean).join(" · ")));
          if(added){item.disabled=true;item.append(el("span","session-ref-pick-added",t("added")));}
          return item;
        }));
        if(!sessions.length)status.textContent=t("pickEmpty");
      };
      search.addEventListener("input",draw);
      status.textContent=t("pickLoading");
      picker.showModal?.();search.focus?.();
      try{
        const rows=await listSessions();
        if(fence!==fenceOf())return;
        sessions=(Array.isArray(rows)?rows:[]).filter(row=>row?.key&&row.key!==self);
        status.textContent="";draw();
      }catch{if(fence===fenceOf())status.textContent=t("pickFailed");}
    }
    function button(cls,label,fn){const node=el("button",cls,label);node.type="button";node.addEventListener("click",fn);return node;}
    function render(){
      container.replaceChildren();container.hidden=!refs.length;container.classList?.toggle?.("hidden",!refs.length);
      for(const ref of refs){
        const chip=el("div","session-ref");chip.dataset.state=ref.state==="starting"?"running":ref.state;chip.dataset.plain=String(!!ref.plain);
        chip.append(el("strong","session-ref-name",t("referenceOf",{name:ref.title})));
        const total=ref.progress?.total||1;
        const status=ref.state==="completed"?t(ref.plain?"plainReady":"ready"):ref.state==="needs_confirm"?t("needsConfirm",{tokens:Number(ref.estimatedTokens||0).toLocaleString()})
          :ref.state==="failed"?t("failed",{reason:ref.error}):total>1?t("summarizingProgress",{done:ref.progress?.done||0,total}):t("summarizing");
        chip.append(el("span","session-ref-status",status));
        if(ref.state==="completed")chip.append(button("session-ref-preview",t("preview"),()=>preview(ref)));
        if(ref.state==="needs_confirm")chip.append(button("session-ref-confirm",t("confirm"),()=>void start(ref,{confirm:true})));
        if(ref.state==="failed")chip.append(button("session-ref-retry",t("retry"),()=>void start(ref)),button("session-ref-plain",t("usePlain"),()=>void plain(ref)));
        const close=button("session-ref-remove","×",()=>remove(ref.key));close.setAttribute("aria-label",t("remove"));chip.append(close);
        container.append(chip);
      }
    }
    render();
    return {add,remove,clear,count,ready,whenReady,compose,render,pick,available};
  }
  return {create};
});
