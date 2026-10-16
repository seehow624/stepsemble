#!/usr/bin/env node
"use strict";
// Deterministic local protocol peer, never a model or a credential consumer.
const { randomUUID } = require("node:crypto");
const mode = process.env.STEPSEMBLE_WORKFLOW_PEER || "pi", sid = randomUUID();
if (process.argv.includes("--version")) { console.log("2.1.294"); process.exit(0); }
const emit = e => process.stdout.write(JSON.stringify(e)+"\n");
// Optional record of the commands this peer received, for Host assertions.
const log = c => { if (process.env.STEPSEMBLE_WORKFLOW_PEER_LOG) require("node:fs").appendFileSync(process.env.STEPSEMBLE_WORKFLOW_PEER_LOG, JSON.stringify({ mode, command: c })+"\n"); };
let running = false, timeout, turns=0, piPending=null, acpPending=null;
const answer = prompt => {
  turns++;
  const marker = prompt.match(/\[\[STEPSEMBLE_GOAL:[a-f0-9-]+:complete\]\]/)?.[0];
  return prompt.includes("TWO_TURNS") && turns === 1 ? "Implementation done; tests remain." : `Verified the requested task.\n${marker || "Done."}`;
};
// With STEPSEMBLE_WORKFLOW_PEER_SESSIONS the peer keeps a Pi-format session
// file there and reports it in get_state, as Pi does.
const sessionFile = process.env.STEPSEMBLE_WORKFLOW_PEER_SESSIONS ? require("node:path").join(process.env.STEPSEMBLE_WORKFLOW_PEER_SESSIONS, `peer-${sid}.jsonl`) : null;
// Each message names the one before it, so the file reads as Pi's branch.
let lastEntry = null;
const record = entry => { if (!sessionFile) return; if (entry.type === "message") { entry = { ...entry, parentId: lastEntry }; lastEntry = entry.id; }
  require("node:fs").mkdirSync(require("node:path").dirname(sessionFile), { recursive: true }); require("node:fs").appendFileSync(sessionFile, JSON.stringify(entry)+"\n"); };
if (sessionFile) record({ type: "session", id: sid, timestamp: new Date().toISOString(), cwd: process.cwd() });
function piEnd(reply) {
  running=false; const message={role:"assistant",content:[{type:"text",text:reply}],usage:{output:120},stopReason:"stop"};
  record({ type: "message", id: randomUUID(), timestamp: new Date().toISOString(), message });
  emit({type:"message_end",message});emit({type:"agent_end",messages:[message]});emit({type:"agent_settled"});
}
require("node:readline").createInterface({input:process.stdin}).on("line",line=>{
  let c;try{c=JSON.parse(line);}catch{return;}
  log(c);
  if(mode==="pi") {
    const reply=data=>emit({type:"response",command:c.type,id:c.id,success:true,data:data||{}});
    if(c.type==="get_state"){reply({isStreaming:running,isCompacting:false,pendingMessageCount:0,...(sessionFile?{sessionFile}:{})});return;}
    if(c.type==="prompt")record({ type: "message", id: randomUUID(), timestamp: new Date().toISOString(), message: { role: "user", content: [{ type: "text", text: String(c.message || "") }] } });
    if(c.type==="get_available_models"){reply({models:[]});return;}
    if(c.type==="abort"){clearTimeout(timeout);piEnd("Interrupted");reply();return;}
    if(c.type==="compact") {running=true;emit({type:"compaction_start"});timeout=setTimeout(()=>{running=false;reply({tokensBefore:3000,estimatedTokensAfter:1000});emit({type:"compaction_end",result:{tokensBefore:3000,estimatedTokensAfter:1000}});},String(c.customInstructions||"").includes("SLOW")?800:10);return;}
    if(c.type==="set_model"&&c.modelId==="missing"){emit({type:"response",command:c.type,id:c.id,success:false,error:"Model not found"});return;}
    // SUBAGENT: pi-subagents progress for two children, as the extension reports it.
    if(c.type==="prompt"&&c.message.includes("SUBAGENT")) {
      running=true;emit({type:"agent_start"});reply();const call="sub-"+turns, args={tasks:[{agent:"scout",task:"Map the auth flow"},{agent:"reviewer",task:"Review the patch"}]};
      // As Pi does: the assistant message names the tool call before it runs.
      const calling={role:"assistant",content:[{type:"toolCall",id:call,name:"subagent",arguments:args}],stopReason:"toolUse"};
      emit({type:"message_end",message:calling}); record({ type: "message", id: randomUUID(), timestamp: new Date().toISOString(), message: calling });
      emit({type:"tool_execution_start",toolCallId:call,toolName:"subagent",args});
      const progress=status=>[{index:0,agent:"scout",task:"Map the auth flow",status:status[0],currentTool:"read",currentToolArgs:"src/auth.js",recentTools:[{tool:"grep",args:"login",endMs:1}],recentOutput:["Looking at the login flow"],toolCount:2,tokens:1840,model:"fixture-model",durationMs:3000},
        {index:1,agent:"reviewer",task:"Review the patch",status:status[1],recentTools:[],recentOutput:[],toolCount:0,tokens:0,durationMs:0}];
      setTimeout(()=>emit({type:"tool_execution_update",toolCallId:call,toolName:"subagent",args,partialResult:{content:[{type:"text",text:"working"}],details:{mode:"parallel",results:[],progress:progress(["running","pending"])}}}),200);
      timeout=setTimeout(()=>{const result={content:[{type:"text",text:"Both done"}],details:{mode:"parallel",results:[
        {index:0,agent:"scout",task:"Map the auth flow",exitCode:0,model:"fixture-model",usage:{input:1500,output:340,cacheRead:0,cacheWrite:0,cost:0,turns:2},progress:progress(["completed","completed"])[0],messages:[{role:"assistant",content:[{type:"text",text:"The redirect parameter is lost in the OAuth callback."}]}]},
        {index:1,agent:"reviewer",task:"Review the patch",exitCode:0,messages:[{role:"assistant",content:[{type:"text",text:"The patch looks correct."}]}]}]}};
        emit({type:"tool_execution_end",toolCallId:call,toolName:"subagent",isError:false,result});
        // As Pi saves it: the tool result keeps the extension's details.
        record({ type: "message", id: randomUUID(), timestamp: new Date().toISOString(), message: { role: "toolResult", toolCallId: call, toolName: "subagent", content: result.content, details: result.details, isError: false } });
        piEnd("Both subagents finished.");},c.message.includes("SLOW")?6000:600);return;
    }
    // A handoff summary request, as the summarizer receives it.
    if(c.type==="prompt"&&c.message.includes("You write a handoff summary")) {running=true;emit({type:"agent_start"});reply();timeout=setTimeout(()=>piEnd("1. Goal: keep users on their page after login.\n2. Done: the redirect is stored in the session.\n5. Open items: Safari cookies."),c.message.includes("SLOW")?4000:200);return;}
    if(c.type==="prompt") {running=true;emit({type:"agent_start"});reply();const text=answer(c.message);timeout=setTimeout(()=>piEnd(text),c.message.includes("SLOW")?10000:100);return;}
    reply();return;
  }
  if(mode==="claude") {
    const out=e=>emit({session_id:sid,...e});
    const control=response=>out({type:"control_response",response:{subtype:"success",request_id:c.request_id,response:response||{}}});
    const finish=text=>{out({type:"assistant",message:{id:randomUUID(),role:"assistant",model:"fixture",content:[{type:"text",text}],usage:{input_tokens:5,output_tokens:120}}});out({type:"result",subtype:"success",result:text,usage:{output_tokens:120}});};
    if(c.type==="control_request"){if(c.request?.subtype==="initialize")control({models:[{value:"fixture",displayName:"Fixture"}],model:"fixture"});else {if(c.request?.subtype==="interrupt"){clearTimeout(timeout);finish("Interrupted");}control();}return;}
    if(c.type==="user"){const prompt=(c.message?.content||[]).filter(p=>p.type==="text").map(p=>p.text).join("\n");const text=answer(prompt);timeout=setTimeout(()=>finish(text),prompt.includes("SLOW")?10000:100);}return;
  }
  const reply=result=>emit({jsonrpc:"2.0",id:c.id,result});const p=c.params||{};
  if(c.method==="initialize")reply({protocolVersion:1,agentCapabilities:{loadSession:true},agentInfo:{name:"workflow-fixture",version:"1"},authMethods:[{id:"cached_token",name:"Fixture"}]});
  else if(["session/new","session/load"].includes(c.method)) reply({sessionId:p.sessionId||sid,configOptions:[{id:"model",name:"Model",category:"model",type:"select",currentValue:"fixture",options:[{value:"fixture",name:"Fixture"}]}]});
  else if(c.method==="session/prompt") {acpPending=c;const prompt=(p.prompt||[]).map(b=>b.text||"").join("\n");const text=answer(prompt);timeout=setTimeout(()=>{emit({jsonrpc:"2.0",method:"session/update",params:{sessionId:p.sessionId,update:{sessionUpdate:"agent_message_chunk",content:{type:"text",text}}}});reply({stopReason:"end_turn",usage:{outputTokens:120}});acpPending=null;},prompt.includes("SLOW")?10000:100);}
  else if(c.method==="session/cancel"){clearTimeout(timeout);if(acpPending){emit({jsonrpc:"2.0",id:acpPending.id,result:{stopReason:"cancelled"}});acpPending=null;}if(c.id!==undefined)reply({});}
  else if(c.id!==undefined)reply({});
});
