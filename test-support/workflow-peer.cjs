#!/usr/bin/env node
"use strict";
// Deterministic local protocol peer, never a model or a credential consumer.
const { randomUUID } = require("node:crypto");
const mode = process.env.STEPSEMBLE_WORKFLOW_PEER || "pi", sid = randomUUID();
if (process.argv.includes("--version")) { console.log("2.1.294"); process.exit(0); }
const emit = e => process.stdout.write(JSON.stringify(e)+"\n");
let running = false, timeout, turns=0, piPending=null, acpPending=null;
const answer = prompt => {
  turns++;
  const marker = prompt.match(/\[\[STEPSEMBLE_GOAL:[a-f0-9-]+:complete\]\]/)?.[0];
  return prompt.includes("TWO_TURNS") && turns === 1 ? "Implementation done; tests remain." : `Verified the requested task.\n${marker || "Done."}`;
};
function piEnd(reply) {
  running=false; const message={role:"assistant",content:[{type:"text",text:reply}],usage:{output:120},stopReason:"stop"};
  emit({type:"message_end",message});emit({type:"agent_end",messages:[message]});emit({type:"agent_settled"});
}
require("node:readline").createInterface({input:process.stdin}).on("line",line=>{
  let c;try{c=JSON.parse(line);}catch{return;}
  if(mode==="pi") {
    const reply=data=>emit({type:"response",command:c.type,id:c.id,success:true,data:data||{}});
    if(c.type==="get_state"){reply({isStreaming:running,isCompacting:false,pendingMessageCount:0});return;}
    if(c.type==="get_available_models"){reply({models:[]});return;}
    if(c.type==="abort"){clearTimeout(timeout);piEnd("Interrupted");reply();return;}
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
