/* The subagents of a conversation's current turn, from each agent's own data,
   and those an earlier turn started that are still working.
   Nothing is inferred for an agent that does not report its subagents. */
(function(root,factory){const api=factory();if(typeof module==="object"&&module.exports)module.exports=api;else root.StepsembleSubagents=api;})(typeof window!=="undefined"?window:globalThis,function(){
  "use strict";
  const MAX_ROWS=64, MAX_LOG=200, MAX_TEXT=4000, MAX_ARCHIVE=200;
  const CLAUDE_TOOLS=new Set(["Task","Agent"]);
  const TERMINAL=new Set(["completed","failed"]);
  const plain=value=>!!value&&typeof value==="object"&&!Array.isArray(value);
  const clip=(value,limit=MAX_TEXT)=>typeof value==="string"?value.slice(0,limit):"";
  const firstLine=value=>clip(value).split("\n").map(line=>line.trim()).find(Boolean)||"";
  const textOf=value=>typeof value==="string"?value:Array.isArray(value)?value.map(part=>typeof part==="string"?part:plain(part)&&part.type==="text"?part.text||"":"").join(""):"";
  // pi-subagents names a child's thinking level `thinking` (an older build
  // called it thinkingLevel); a model may carry its level as a suffix, which
  // the thinking field already says.
  const PI_LEVEL=/:(?:off|minimal|low|medium|high|xhigh|max)$/;
  const piModel=value=>clip(value,120).replace(PI_LEVEL,"");
  const piThinking=(...values)=>clip(values.find(value=>typeof value==="string"&&value)||"",64);
  // A child's session is named "agent: task"; the task is what it was asked.
  const piTask=(name,agent)=>{const text=firstLine(name);return agent&&text.startsWith(agent+": ")?text.slice(agent.length+2):text;};
  const PI_CHILD={pending:"pending",queued:"pending",running:"running",paused:"running",detached:"running",complete:"completed",completed:"completed",failed:"failed",partial:"failed",stopped:"failed",rejected:"failed"};
  const RUN_ID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
  // pi-subagents' final details as rows, small enough to keep with a saved
  // message: a foreground run's results, or a workflow's children as far as
  // its launch knew them. A background run keeps its id, by which the Host
  // reads the run's own status as it goes.
  const PI_LOG=20;
  function piRecord(details){
    if(!plain(details))return null;
    const rows=[];
    for(const result of (Array.isArray(details.results)?details.results:[]).slice(0,MAX_ROWS)){
      if(!plain(result)||!Number.isSafeInteger(result.index))continue;
      const messages=Array.isArray(result.messages)?result.messages:[];
      const reply=messages.findLast(message=>message?.role==="assistant"&&textOf(message.content).trim());
      const response=messages.findLast(message=>message?.role==="assistant");
      const failed=result.exitCode!==0||!!result.error||!!result.interrupted||!!result.timedOut||!!result.stopped;
      const progress=plain(result.progress)?result.progress:plain(result.progressSummary)?result.progressSummary:{},usage=plain(result.usage)?result.usage:{};
      const used=Number.isSafeInteger(usage.input)&&Number.isSafeInteger(usage.output)?usage.input+usage.output:0;
      rows.push({index:result.index,key:String(result.index),harness:"pi",name:clip(result.agent,80)||"subagent",task:firstLine(result.task),prompt:clip(result.task,2000),status:failed?"failed":"completed",
        result:failed?clip(result.error)||clip(textOf(reply?.content)):clip(result.finalOutput)||clip(textOf(reply?.content)),model:piModel(response?.model||result.model||progress.model),
        reasoningEffort:piThinking(result.thinking,progress.thinking,result.thinkingLevel,progress.thinkingLevel),
        tokens:Number.isSafeInteger(progress.tokens)&&progress.tokens>0?progress.tokens:used>0?used:null,durationMs:Number.isSafeInteger(progress.durationMs)?progress.durationMs:null,
        log:(Array.isArray(progress.recentTools)?progress.recentTools:[]).slice(-PI_LOG).map(tool=>({kind:"tool",name:clip(tool?.tool,80)||"tool",summary:clip(tool?.args,300),done:true}))});
    }
    const background=!!(details.background||details.asyncId);
    // Only the call that launched the run: a status call reports the same
    // children, which its launch already shows.
    if(!rows.length&&background){
      const children=Array.isArray(details.workflowChildren?.children)?details.workflowChildren.children:[];
      children.slice(0,MAX_ROWS).forEach((child,index)=>{
        if(!plain(child))return;
        const agent=clip(child.agent,80);
        rows.push({index,key:clip(child.childId,128)||String(index),harness:"pi",name:agent||"subagent",task:piTask(child.sessionName,agent),prompt:"",status:PI_CHILD[child.state]||"running",
          result:"",model:piModel(child.model),reasoningEffort:piThinking(child.thinking),tokens:null,durationMs:null,log:[]});
      });
    }
    const run=RUN_ID.test(String(details.asyncId||""))?{id:String(details.asyncId),call:clip(details.toolCallId,256)}:null;
    return rows.length?{rows,...(background?{background:true}:{}),...(run?{run}:{})}:background?{rows,background:true,...(run?{run}:{})}:null;
  }
  function create({now=Date.now}={}){
    // Earlier turns' subagents stay reachable from their transcript cards.
    let rows=new Map(), signature="[]";
    const archive=new Map();
    function retire(map){for(const row of map.values()){archive.delete(row.id);archive.set(row.id,row);}while(archive.size>MAX_ARCHIVE)archive.delete(archive.keys().next().value);}
    const listeners=new Set(), piCalls=new Map(), claudeTasks=new Map();
    // pi-subagents' background runs this view knows, by the tool call that
    // started them, until the Host reports them done or gone.
    const piRuns=new Map();
    // A subagent that works on its own, a background one or a Codex thread,
    // outlives the turn that started it until it ends.
    const lasting=row=>!TERMINAL.has(row.status)&&(row.background===true||row.source==="codex");
    // Codex turns a sent message ended, whose snapshot may still arrive; and
    // whether a Claude turn ended, so the next one begins a turn even when the
    // Host started it (Claude echoes no prompt it is sent).
    let codexTurn=null, claudeEnded=false;
    const endedTurns=new Set();
    // force: an earlier turn's subagent changed, which the current ones do not show.
    function emit(force=false){const next=JSON.stringify([...rows.values()]);if(next===signature&&!force)return;signature=next;for(const fn of listeners){try{fn();}catch{}}}
    function upsert(id,fields){
      if(!id)return null;
      let row=rows.get(id);
      if(!row){
        if(rows.size>=MAX_ROWS)return null;
        row={id,parentId:null,name:"",task:"",prompt:"",status:"running",activity:"",log:[],result:"",model:"",reasoningEffort:"",tokens:null,durationMs:null,background:false,source:"",startedAt:now(),endedAt:null};
        rows.set(id,row);
      }
      for(const [key,value] of Object.entries(fields))if(value!==undefined&&value!==null&&value!=="")row[key]=value;
      if(TERMINAL.has(row.status)&&row.endedAt===null)row.endedAt=now();
      if(!TERMINAL.has(row.status))row.endedAt=null;
      return row;
    }
    function log(row,entry){if(!row)return;row.log.push(entry);if(row.log.length>MAX_LOG)row.log.splice(0,row.log.length-MAX_LOG);}
    function newTurn(){
      claudeEnded=false;
      if(codexTurn!==null){endedTurns.add(codexTurn);while(endedTurns.size>MAX_ROWS)endedTurns.delete(endedTurns.values().next().value);}
      const kept=new Map(),gone=new Map();
      for(const [id,row] of rows)(lasting(row)?kept:gone).set(id,row);
      retire(gone);rows=kept;
      for(const call of [...piCalls.keys()])if(![...kept.values()].some(row=>row.toolId===call))piCalls.delete(call);
      for(const [task,id] of [...claudeTasks])if(!kept.has(id))claudeTasks.delete(task);
      emit();
    }
    // Claude Code: a Task/Agent tool call is a subagent; events carrying its
    // tool id as parent_tool_use_id are the subagent's own work.
    // A backgrounded Agent answers its call at once ("Async agent launched");
    // its task events say when it really ends, with its last reply as result.
    const CLAUDE_TASK={pending:"pending",running:"running",completed:"completed",failed:"failed",error:"failed",killed:"failed",stopped:"failed",cancelled:"failed"};
    // Claude reports every task it runs, each shell command (local_bash), a
    // Monitor or a workflow as well as an agent; only an agent's is a subagent.
    // Without a kind (an older Claude Code), one its Agent call started is.
    const CLAUDE_AGENT_TASKS=new Set(["local_agent","remote_agent","in_process_teammate"]);
    function claudeTask(event){
      const id=String(event.tool_use_id||claudeTasks.get(event.task_id)||"");
      if(!id)return;
      if(event.subtype==="task_started"&&(typeof event.task_type==="string"&&event.task_type?!CLAUDE_AGENT_TASKS.has(event.task_type):!rows.has(id)&&!event.subagent_type))return;
      if(event.task_id)claudeTasks.set(String(event.task_id),id);
      while(claudeTasks.size>MAX_ROWS)claudeTasks.delete(claudeTasks.keys().next().value);
      if(event.subtype==="task_started"){upsert(id,{source:"claude",toolId:id,name:clip(event.subagent_type,80)||rows.get(id)?.name||"subagent",task:clip(event.description,300)||firstLine(event.prompt),prompt:clip(event.prompt),background:event.is_backgrounded===true||undefined});return;}
      if(!rows.has(id))return;
      const status=CLAUDE_TASK[event.subtype==="task_updated"?event.patch?.status:event.status];
      if(!status)return;
      const lastReply=[...rows.get(id).log].reverse().find(entry=>entry.kind==="text")?.text;
      upsert(id,{status,result:TERMINAL.has(status)?clip(event.summary)||rows.get(id).result||lastReply:undefined});
    }
    function claude(event){
      if(!plain(event))return;
      if(event.type==="system"&&["task_started","task_updated","task_notification"].includes(event.subtype)){claudeTask(event);emit();return;}
      const parent=event.parent_tool_use_id||event.parentToolUseId||null;
      if(event.type==="result"&&!parent){claudeEnded=true;return;}
      if(claudeEnded&&!parent&&(event.type==="assistant"||event.type==="stream_event"&&event.event?.type==="message_start"))newTurn();
      const message=plain(event.message)?event.message:null;
      const blocks=Array.isArray(message?.content)?[...message.content]:[];
      if(event.type==="stream_event"&&event.event?.type==="content_block_start"&&plain(event.event.content_block))blocks.push(event.event.content_block);
      const response=event.type==="assistant"?message:event.type==="stream_event"&&event.event?.type==="message_start"?event.event.message:null;
      if(parent&&rows.has(parent)&&plain(response)){
        const model=clip(response.model,120);
        if(model&&model!=="<synthetic>")upsert(parent,{model});
      }
      if(event.type==="user"&&!parent&&(typeof message?.content==="string"&&message.content.trim()||blocks.some(block=>block?.type==="text"&&String(block.text||"").trim())&&!blocks.some(block=>block?.type==="tool_result"))){newTurn();return;}
      for(const block of blocks){
        if(!plain(block))continue;
        if(block.type==="tool_use"&&CLAUDE_TOOLS.has(block.name)){
          const input=plain(block.input)?block.input:{};
          upsert(String(block.id||""),{source:"claude",toolId:String(block.id||""),parentId:parent,name:clip(input.subagent_type,80)||"subagent",task:clip(input.description,300)||firstLine(input.prompt),prompt:clip(input.prompt),background:input.run_in_background===true||undefined});
        }else if(block.type==="tool_result"&&rows.has(String(block.tool_use_id||""))){
          const row=rows.get(String(block.tool_use_id)),content=textOf(block.content);
          // A backgrounded call's result only reports that it started.
          if((row.background||/^Async agent launched/.test(content.trim()))&&!block.is_error)upsert(row.id,{background:true});
          else upsert(row.id,{status:block.is_error?"failed":"completed",result:clip(content)});
        }else if(parent&&rows.has(parent)){
          const row=rows.get(parent);
          if(block.type==="tool_use"){
            if(!row.log.some(entry=>entry.id===block.id)){log(row,{kind:"tool",id:String(block.id||""),name:clip(block.name,80)||"tool",summary:clip(JSON.stringify(block.input||{}),300),done:false});row.activity=clip(block.name,80);}
          }else if(block.type==="tool_result"){
            const entry=row.log.find(item=>item.id===block.tool_use_id);if(entry){entry.done=true;entry.error=!!block.is_error;}
          }else if(block.type==="text"&&event.type==="assistant"&&String(block.text||"").trim())log(row,{kind:"text",text:clip(block.text)});
        }
      }
      emit();
    }
    // Pi with pi-subagents: the subagent tool reports each child's progress.
    const PI_STATUS={pending:"pending",running:"running",completed:"completed",failed:"failed",detached:"running"};
    // A workflow script names its children only as it runs them.
    function piLaunch(args,index){
      const list=Array.isArray(args?.tasks)?args.tasks:null,value=list?list[index]:args,workflow=!!(args?.workflowScript||args?.workflowScriptPath||args?.workflow);
      return {agent:clip(value?.agent,80)||(workflow?"workflow":""),task:firstLine(value?.task||"")};
    }
    function trackPiRun(toolId,run){if(run&&RUN_ID.test(run.id)&&!piRuns.has(toolId))piRuns.set(toolId,{toolId,id:run.id,call:run.call||toolId,settled:false});}
    function pi(ev){
      if(!plain(ev))return;
      if(ev.type==="message_start"&&ev.message?.role==="user"){newTurn();return;}
      if(ev.toolName!=="subagent"||!ev.toolCallId)return;
      const call=String(ev.toolCallId);
      if(ev.type==="tool_execution_start")piCalls.set(call,plain(ev.args)?ev.args:{});
      const details=plain(ev.partialResult?.details)?ev.partialResult.details:plain(ev.result?.details)?ev.result.details:null;
      for(const progress of Array.isArray(details?.progress)?details.progress:[]){
        if(!plain(progress)||!Number.isSafeInteger(progress.index))continue;
        const row=upsert(`${call}:${progress.index}`,{source:"pi",toolId:call,name:clip(progress.agent,80)||"subagent",task:firstLine(progress.task),status:PI_STATUS[progress.status]||"running",
          background:progress.status==="detached"||undefined,model:piModel(progress.model),reasoningEffort:piThinking(progress.thinking,progress.thinkingLevel),tokens:Number.isSafeInteger(progress.tokens)?progress.tokens:undefined,
          durationMs:Number.isSafeInteger(progress.durationMs)?progress.durationMs:undefined,result:clip(progress.error)});
        if(!row)continue;
        row.activity=progress.currentTool?clip(`${progress.currentTool} ${progress.currentToolArgs||""}`.trim(),300):"";
        row.log=[...(Array.isArray(progress.recentTools)?progress.recentTools:[]).map(tool=>({kind:"tool",name:clip(tool?.tool,80)||"tool",summary:clip(tool?.args,300),done:true})),
          ...(Array.isArray(progress.recentOutput)?progress.recentOutput:[]).filter(line=>typeof line==="string"&&line.trim()).map(line=>({kind:"text",text:clip(line)}))].slice(-MAX_LOG);
      }
      if(ev.type==="tool_execution_end"){
        const record=piRecord(details),results=record?.rows||[];
        trackPiRun(call,record?.run);
        for(const item of results){
          const row=upsert(`${call}:${item.key}`,{source:"pi",toolId:call,name:item.name,task:item.task,prompt:item.prompt,status:item.status,result:item.result,model:item.model,reasoningEffort:item.reasoningEffort,tokens:item.tokens,durationMs:item.durationMs,background:record.background||undefined});
          if(row&&!row.log.length)row.log=item.log;
        }
        if(!results.length&&record?.background){
          const {agent,task}=piLaunch(piCalls.get(call),0);
          upsert(`${call}:0`,{source:"pi",toolId:call,name:agent||"subagent",task,status:"running",background:true});
        }else if(!results.length)for(const row of rows.values())if(row.id.startsWith(call+":")&&!TERMINAL.has(row.status))row.status=ev.isError?"failed":"completed";
        piCalls.delete(call);
      }
      emit();
    }
    // A background run's children as the Host read them from the run's own
    // status; they take the place of what its launch drew. null: the run is
    // no longer there to read, and what is shown stays.
    function piRun(toolId,data){
      const run=piRuns.get(toolId);
      if(!run)return false;
      if(!plain(data)){run.settled=true;return false;}
      const children=(Array.isArray(data.children)?data.children:[]).filter(child=>plain(child)&&clip(child.key,128)).slice(0,MAX_ROWS);
      const live=[...rows.values()].some(row=>row.toolId===toolId)||!toolId||![...archive.values()].some(row=>row.toolId===toolId);
      const target=live?rows:archive,ids=new Set(children.map(child=>`${toolId}:${clip(child.key,128)}`));
      if(children.length)for(const [id,row] of [...target])if(row.toolId===toolId&&!ids.has(id))target.delete(id);
      for(const child of children){
        const id=`${toolId}:${clip(child.key,128)}`,status=TERMINAL.has(child.status)||child.status==="pending"?child.status:"running";
        const fields={toolId,name:clip(child.name,80)||"subagent",task:firstLine(child.task),status,model:piModel(child.model),reasoningEffort:piThinking(child.thinking),
          tokens:Number.isSafeInteger(child.tokens)&&child.tokens>0?child.tokens:undefined,durationMs:Number.isSafeInteger(child.durationMs)?child.durationMs:undefined,result:clip(child.error),background:true};
        const log=(Array.isArray(child.log)?child.log:[]).filter(plain).slice(-MAX_LOG).map(entry=>entry.kind==="text"?{kind:"text",text:clip(entry.text)}:{kind:"tool",name:clip(entry.name,80)||"tool",summary:clip(entry.summary,300),done:true});
        let row;
        if(live)row=upsert(id,{source:"pi",...fields});
        else{
          row=archive.get(id)||{id,source:"history",history:true,harness:"pi",parentId:null,prompt:"",activity:"",log:[],result:"",model:"",reasoningEffort:"",tokens:null,durationMs:null,startedAt:null,endedAt:null};
          for(const [key,value] of Object.entries(fields))if(value!==undefined&&value!=="")row[key]=value;
          archive.delete(id);archive.set(id,row);
        }
        if(!row)continue;
        row.activity=TERMINAL.has(status)?"":clip(child.activity,300);
        if(log.length)row.log=log;
      }
      while(archive.size>MAX_ARCHIVE)archive.delete(archive.keys().next().value);
      run.settled=TERMINAL.has(data.state)&&children.every(child=>TERMINAL.has(child.status));
      emit(!live);
      return true;
    }
    // The background runs whose children may still change.
    function piPending(){return [...piRuns.values()].filter(run=>!run.settled).map(run=>({toolId:run.toolId,id:run.id,call:run.call}));}
    // Codex: spawnAgent names the threads it starts; later collab calls carry
    // each thread's last state. Items are a snapshot of one turn, the newest.
    const CODEX_STATUS={pendingInit:"running",running:"running",completed:"completed",shutdown:"completed",errored:"failed",interrupted:"failed",notFound:"failed"};
    function codex(items,turnId=null){
      const turn=turnId??null,ended=turn!==null&&endedTurns.has(turn);
      const previous=rows;rows=new Map();let count=0;
      for(const [id,row] of previous)if((row.turnId??null)!==turn&&lasting(row))rows.set(id,row);
      for(const item of Array.isArray(items)?items:[]){
        if(!plain(item))continue;
        if(item.type==="collabAgentToolCall"){
          const states=plain(item.agentsStates)?item.agentsStates:{};
          for(const id of Array.isArray(item.receiverThreadIds)?item.receiverThreadIds:[]){
            if(typeof id!=="string"||!id)continue;
            if(item.tool==="spawnAgent"&&!rows.has(id)){
              // The turn a sent message ended brings back none of its finished subagents.
              if(ended&&!previous.has(id))continue;
              const earlier=previous.get(id);
              // The model and effort the call asked for are not what the child
              // runs with; what its creation resolved to stays from the last read.
              const row=upsert(id,{source:"codex",toolId:clip(item.id,256),name:earlier?.name&&!/^Subagent \d+$/.test(earlier.name)?earlier.name:`Subagent ${++count}`,task:firstLine(item.prompt),prompt:clip(item.prompt),
                model:earlier?.model,reasoningEffort:earlier?.reasoningEffort});
              if(row)row.turnId=turn;
              if(row&&earlier)row.startedAt=earlier.startedAt;
            }
            const state=plain(states[id])?states[id]:null;
            if(state&&rows.has(id))upsert(id,{status:CODEX_STATUS[state.status]||"running",result:clip(state.message)});
          }
        }else if(item.type==="subAgentActivity"&&rows.has(item.agentThreadId)){
          const name=clip(String(item.agentPath||"").split("/").filter(Boolean).pop(),80);
          // Its creation says the model and effort it resolved to.
          upsert(item.agentThreadId,{name,status:item.kind==="completed"?"completed":item.kind==="interrupted"?"failed":undefined,model:clip(item.model,120),reasoningEffort:clip(item.reasoningEffort,64)});
        }
      }
      for(const [id,row] of previous)if(!rows.has(id))retire(new Map([[id,row]]));
      if(turn!==null)codexTurn=turn;
      emit();
    }
    // OpenCode: task tool calls and subtask parts after the latest user message.
    const OPENCODE_STATUS={pending:"pending",running:"running",completed:"completed",error:"failed",failed:"failed"};
    function openCode(messages){
      const list=Array.isArray(messages)?messages:[];
      let start=0;list.forEach((message,index)=>{if((message?.info?.role||message?.role)==="user")start=index+1;});
      const previous=rows;rows=new Map();
      for(const message of list.slice(start)){
        for(const part of Array.isArray(message?.parts)?message.parts:[]){
          if(!plain(part))continue;
          let row=null;
          if(part.type==="tool"&&part.tool==="task"){
            const state=plain(part.state)?part.state:{},input=plain(state.input)?state.input:{};
            row=upsert(String(part.callID||part.id||""),{source:"opencode",toolId:String(part.callID||part.id||""),name:clip(input.subagent_type,80)||"task",task:clip(input.description,300)||firstLine(input.prompt),prompt:clip(input.prompt),
              status:OPENCODE_STATUS[state.status]||"running",result:clip(typeof state.output==="string"?state.output:state.error),childSessionId:clip(state.metadata?.sessionId,200)});
          }else if(part.type==="subtask"){
            row=upsert(String(part.id||""),{source:"opencode",toolId:String(part.id||""),name:clip(part.agent,80)||"subagent",task:clip(part.description,300)||firstLine(part.prompt),prompt:clip(part.prompt),
              status:OPENCODE_STATUS[part.status]||"running",result:clip(part.result),model:clip(part.model?.modelID,120)});
          }
          if(row&&previous.has(row.id))row.startedAt=previous.get(row.id).startedAt;
        }
      }
      for(const [id,row] of previous)if(!rows.has(id))retire(new Map([[id,row]]));
      emit();
    }
    // A card drawn from a saved conversation this view never saw live: only
    // what the record itself says, kept with the earlier turns' subagents.
    function remember({toolId,name,args,result,isError=false,record=null,harness=""}={}){
      toolId=String(toolId||"");
      if(!toolId||[...rows.values(),...archive.values()].some(row=>row.toolId===toolId))return false;
      const base={source:"history",history:true,harness:clip(harness,32),toolId,parentId:null,activity:"",log:[],model:"",reasoningEffort:"",tokens:null,durationMs:null,background:false,startedAt:null,endedAt:null};
      const input=plain(args)?args:{},text=clip(typeof result==="string"?result:""),found=[];
      // A background run's record says only how its children stood at launch;
      // the Host reads how they stand now.
      const background=!!record?.background&&!isError;
      if(Array.isArray(record?.rows)&&record.rows.length)for(const item of record.rows.slice(0,MAX_ROWS)){
        if(!plain(item)||!Number.isSafeInteger(item.index))continue;
        found.push({...base,id:`${toolId}:${clip(item.key,128)||item.index}`,name:clip(item.name,80)||"subagent",task:firstLine(item.task),prompt:clip(item.prompt),
          status:TERMINAL.has(item.status)?item.status:background?"started":"completed",background,result:clip(item.result),
          harness:clip(item.harness,32)||base.harness,model:piModel(item.model),reasoningEffort:clip(item.reasoningEffort,64),tokens:Number.isSafeInteger(item.tokens)?item.tokens:null,durationMs:Number.isSafeInteger(item.durationMs)?item.durationMs:null,
          log:(Array.isArray(item.log)?item.log:[]).filter(plain).slice(-MAX_LOG).map(entry=>({kind:entry.kind==="text"?"text":"tool",name:clip(entry.name,80),summary:clip(entry.summary,300),text:clip(entry.text),done:true}))});
      }else if(name==="subagent"){
        // A background run answers at once; the record never says when it ended.
        const tasks=Array.isArray(input.tasks)?input.tasks:[input],launch=piLaunch(input,0);
        tasks.slice(0,MAX_ROWS).forEach((task,index)=>{if(!plain(task)||!firstLine(task.task))return;
          found.push({...base,id:`${toolId}:${index}`,name:clip(task.agent,80)||"subagent",task:firstLine(task.task),prompt:clip(task.task),status:isError?"failed":background?"started":"completed",background,result:tasks.length===1&&!background?text:""});});
        if(!found.length&&background&&record?.run)found.push({...base,id:`${toolId}:0`,name:launch.agent||"subagent",task:launch.task,prompt:"",status:"started",background:true,result:""});
      }else if(firstLine(input.description)||firstLine(input.prompt)){
        const started=!isError&&/^Async agent launched/.test(text.trim());
        found.push({...base,id:toolId,name:clip(input.subagent_type,80)||(name==="task"?"task":"subagent"),task:clip(input.description,300)||firstLine(input.prompt),prompt:clip(input.prompt),
          status:isError?"failed":started?"started":"completed",background:started,result:started?"":text});
      }
      for(const row of found){archive.delete(row.id);archive.set(row.id,row);}
      while(archive.size>MAX_ARCHIVE)archive.delete(archive.keys().next().value);
      if(found.length&&background)trackPiRun(toolId,record?.run);
      return found.length>0;
    }
    function list(){return JSON.parse(JSON.stringify([...rows.values()]));}
    // Every subagent the conversation showed, the current ones last in, so first out.
    function all(){const every=new Map(archive);for(const [id,row] of rows){every.delete(id);every.set(id,row);}return JSON.parse(JSON.stringify([...every.values()].reverse()));}
    function summary(){const values=[...rows.values()];return {total:values.length,running:values.filter(row=>!TERMINAL.has(row.status)).length,completed:values.filter(row=>row.status==="completed").length,failed:values.filter(row=>row.status==="failed").length};}
    function reset(){retire(rows);rows=new Map();piCalls.clear();piRuns.clear();claudeTasks.clear();endedTurns.clear();codexTurn=null;claudeEnded=false;emit();}
    function onChange(fn){listeners.add(fn);return()=>listeners.delete(fn);}
    const copy=row=>row?JSON.parse(JSON.stringify(row)):null;
    function get(id){return copy(rows.get(id)||archive.get(id));}
    function byTool(toolId){if(!toolId)return [];const found=[...rows.values()].filter(row=>row.toolId===toolId);return (found.length?found:[...archive.values()].filter(row=>row.toolId===toolId)).map(copy);}
    return {claude,pi,piRun,piPending,codex,openCode,newTurn,reset,list,all,summary,onChange,get,byTool,remember};
  }
  return {create,piRecord};
});
