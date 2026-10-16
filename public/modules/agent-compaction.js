/* Explicit compaction only; a pane observes Host work and never owns its lifetime. */
(function(root,factory){const api=factory(root);if(typeof module==="object"&&module.exports)module.exports=api;else root.StepsembleAgentCompaction=api;})(typeof window!=="undefined"?window:globalThis,function(root){
  "use strict";
  const AGENTS=new Set(["pi","claude-code","codex","opencode","cline","kilo","omp","grok-build","antigravity"]);
  const ACTIVE=new Set(["running"]);
  function parse(value){if(typeof value!=="string")return null;const match=value.trimStart().match(/^\/compact(?:\s+([\s\S]*))?$/i);return match?{instructions:(match[1]||"").trim()}:null;}
  const eligible=agent=>AGENTS.has(agent);
  function uuid(){
    if(root.crypto.randomUUID)return root.crypto.randomUUID();
    const bytes=root.crypto.getRandomValues(new Uint8Array(16));bytes[6]=bytes[6]&15|64;bytes[8]=bytes[8]&63|128;
    const hex=Array.from(bytes,value=>value.toString(16).padStart(2,"0")).join("");
    return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
  }
  const stamp=context=>[context.context||"",context.entry||"",context.agentId||""].join("\n");
  const codeOf=value=>{const code=value?.code||value?.message;return typeof code==="string"&&/^[a-z][a-z0-9_.:-]{1,95}$/.test(code)?code:"compaction_failed";};
  function localReason(context){
    if(!context.entry)return "compaction_not_workspace";
    if(!context.connected)return "compaction_not_connected";
    if(context.readOnly)return "compaction_readonly";
    if(context.busy)return "compaction_busy";
    return null;
  }
  function create({request,getContext,onAccepted=()=>{},onStatus=()=>{},onError=()=>{},schedule=fn=>root.setTimeout(fn,1500),cancel=id=>root.clearTimeout(id),makeRequestId=uuid,text=key=>key,now=Date.now}){
    let closed=false,cache=null,cacheStamp=null,sending=null,timer=null,attempt=null,lastRead=0;
    const reads=new Map();
    const current=fence=>!closed&&stamp(getContext())===fence;
    function state(){return cacheStamp===stamp(getContext())?cache:null;}
    function busy(){const fence=stamp(getContext());return sending===fence||ACTIVE.has(state()?.operation?.status);}
    function emit(){if(!closed)onStatus({...state(),submitting:sending===stamp(getContext())});}
    function stopTimer(){if(timer!==null){cancel(timer);timer=null;}}
    function poll(fence){
      stopTimer();if(!current(fence)||!ACTIVE.has(state()?.operation?.status))return;
      timer=schedule(async()=>{timer=null;if(current(fence))await refresh();});
    }
    async function refresh({lazy=false}={}){
      const context=getContext(),fence=stamp(context);
      if(closed||!eligible(context.agentId)||!context.entry||!context.connected)return null;
      if(reads.has(fence))return reads.get(fence);
      if(lazy&&cacheStamp===fence&&now()-lastRead<5000)return cache;
      const reading=(async()=>{
        lastRead=now();
        try{
          const result=await request("/api/agent/compaction?entry="+encodeURIComponent(context.entry));
          if(!current(fence))return null;
          cache=result;cacheStamp=fence;emit();poll(fence);return cache;
        }catch(error){
          // A missing poll is not evidence that the operation finished.
          if(current(fence)){if(cacheStamp!==fence){cache={supported:false,instructions:false,reason:codeOf(error),operation:null};cacheStamp=fence;}emit();poll(fence);}
          return null;
        }
      })();
      reads.set(fence,reading);
      try{return await reading;}finally{if(reads.get(fence)===reading)reads.delete(fence);}
    }
    function item(){
      const context=getContext();if(!eligible(context.agentId))return null;
      const capability=state(),reason=localReason(context)||(busy()?"compaction_busy":capability?.supported?capability.busy?"compaction_busy":null:capability?.reason||"compaction_checking");
      return {name:"compact",source:"compaction",disabled:!!reason,reason,instructions:capability?.instructions===true,
        description:text(reason||"description"),argumentHint:!reason&&capability?.instructions?text("instructionsHint"):""};
    }
    async function submit(value,{hasAttachments=false}={}){
      const parsed=parse(value),context=getContext(),fence=stamp(context);
      if(!parsed||!eligible(context.agentId))return {handled:false,accepted:false};
      const refuse=code=>{if(current(fence))onError(code);return {handled:true,accepted:false};};
      if(closed)return {handled:true,accepted:false};
      if(hasAttachments)return refuse("compaction_attachments");
      const local=localReason(context);if(local)return refuse(local);
      if(busy())return refuse("compaction_busy");
      if(parsed.instructions.length>16000||/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(parsed.instructions))return refuse("compaction_invalid_request");
      sending=fence;emit();
      try{
        const capability=await refresh();if(!current(fence))return {handled:true,accepted:false};
        if(!capability?.supported)return refuse(capability?.reason||"compaction_unavailable");
        if(capability.busy)return refuse("compaction_busy");
        if(parsed.instructions&&!capability.instructions)return refuse("compaction_instructions_unavailable");
        if(!attempt||attempt.fence!==fence||attempt.value!==value)attempt={fence,value,id:makeRequestId()};
        const result=await request("/api/agent/compaction",{entry:context.entry,requestId:attempt.id,...(parsed.instructions?{instructions:parsed.instructions}:{})});
        if(!current(fence))return {handled:true,accepted:false};
        if(!result?.operation?.id||!["running","completed","failed","uncertain"].includes(result.operation.status))throw new Error("compaction_result_unknown");
        cache=result;cacheStamp=fence;attempt=null;
        onAccepted(value);emit();poll(fence);return {handled:true,accepted:true};
      }catch(error){return refuse(codeOf(error));}
      finally{if(sending===fence)sending=null;if(current(fence))emit();}
    }
    function close(){closed=true;stopTimer();reads.clear();}
    return {refresh,item,submit,busy,state,close};
  }
  return {parse,eligible,create};
});
