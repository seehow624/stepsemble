"use strict";
const test=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs"),os=require("node:os"),path=require("node:path"),vm=require("node:vm");
const {PassThrough}=require("node:stream"),{EventEmitter}=require("node:events"),{randomUUID}=require("node:crypto");
const {createWorkflows}=require("../server/workflows"),{createWorkflowEvents}=require("../server/workflow-events");
const {createAgentClientProtocolAdapter}=require("../server/agent-client-protocol-adapter"),{createGrokAcpAdapter}=require("../server/grok-acp-adapter");
const wait=()=>new Promise(resolve=>setImmediate(resolve));

// Exercise the actual server.js busy predicate and turn method without starting
// a Host or a CLI. Native admission still uses the real ACP/Grok adapters.
const source=fs.readFileSync(path.join(__dirname,"../server.js"),"utf8");
function between(start,end){const from=source.indexOf(start),to=source.indexOf(end,from);assert(from>=0&&to>from);return source.slice(from,to);}
const identity=between("function workflowIdentity(record)","function workflowNative(record)");
const busy=between("async function workflowBusy(record)","// A pinned model and permission mode");
const busyError=between("function workflowTargetBusy()", "async function workflowTargetReady(run)");
const turn=between("    async turn(run, prompt, signal, activity)","    async stop(run)");
async function fixture(t,agentId){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),"stepsemble-acp-busy-")),events=createWorkflowEvents(),child=new EventEmitter();
  child.stdin=new PassThrough();child.stdout=new PassThrough();child.stderr=new PassThrough();child.kill=()=>child.emit("close",0,null);
  const prompts=[];let nativePrompt=null;
  const emit=value=>child.stdout.write(JSON.stringify(value)+"\n");
  child.stdin.on("data",chunk=>{for(const line of chunk.toString().trim().split("\n")){
    const frame=JSON.parse(line),reply=result=>emit({jsonrpc:"2.0",id:frame.id,result});
    if(frame.method==="initialize")reply({protocolVersion:1,agentCapabilities:{loadSession:true},authMethods:[{id:"cached_token"}]});
    else if(["session/new","session/load"].includes(frame.method))reply({sessionId:frame.params.sessionId||"native-session"});
    else if(frame.method==="session/prompt"){
      prompts.push(frame);nativePrompt=frame;
      emit({jsonrpc:"2.0",method:"session/update",params:{sessionId:frame.params.sessionId,update:{sessionUpdate:"plan",entries:[{content:"Done part",priority:"medium",status:"completed"},{content:"Still working",priority:"medium",status:"in_progress"}]}}});
    }else if(frame.method&&Object.hasOwn(frame,"id"))reply({});
  }});
  const create=agentId==="grok-build"?createGrokAcpAdapter:createAgentClientProtocolAdapter;
  const adapter=create({command:"/synthetic/acp-peer",cwd:dir,env:{},spawnImpl:()=>child,onRateEvent:event=>events.emit(agentId,event.sessionId,event)});
  const session=await adapter.createSession({directory:dir}),entry={key:randomUUID(),record:{agentId,cwd:dir,nativeSessionId:session.sessionId,nativeAcp:agentId!=="grok-build",nativeGrokAcp:agentId==="grok-build"}};
  let injectNative=false,userPrompt=null;
  const wrapped={...adapter,prompt(...args){if(injectNative){injectNative=false;userPrompt=adapter.prompt(session.sessionId,"User work arriving at admission");}return adapter.prompt(...args);}};
  const context={grokAcp:wrapped,acpAdapterForAgent:()=>wrapped,workflowEvents:events,workflowOwnedTurns:new Set(),workflowDispatches:new Map(),hostRates:{read:()=>({rates:[]})},compactions:{locked:()=>false},
    workflowTarget:()=>entry,workflowTargetReady:async run=>!context.workflows.targetBusy(entry.key,run.id)&&!await context.workflowBusy(entry.record)};
  vm.runInNewContext(`${identity}\n${busy}\n${busyError}\nturn=({${turn}}).turn;`,context);
  const host=createWorkflows({file:path.join(dir,"workflows.json"),autoStart:false,bridge:{prepare:context.workflowTargetReady,open:async()=>({entry:entry.key,record:entry.record}),turn:context.turn,stop:async()=>{throw new Error("Queued work must not cancel native work");}}});context.workflows=host;
  t.after(async()=>{host.close();await adapter.close();fs.rmSync(dir,{recursive:true,force:true});});
  const schedule=host.create({kind:"schedule",title:"Scheduled work",objective:"Continue safely",agentId,cwd:dir,targetEntry:entry.key,mode:"task",schedule:{kind:"interval",minutes:15}});
  const get=()=>host.list().runs.at(-1);
  const run=async()=>{await host.action({id:schedule.id,action:"run"});await wait();};
  const assertQueued=()=>{const row=get();assert.equal(row.status,"queued",JSON.stringify(row));assert.equal(row.activity,"conversation_busy");assert.equal(row.elapsedMs,0);assert.equal(row.turns,0);assert.equal(row.retries,undefined);assert.equal(host.locked(entry.key),false);};
  const finishNative=()=>{assert(nativePrompt);const frame=nativePrompt;nativePrompt=null;emit({jsonrpc:"2.0",id:frame.id,result:{stopReason:"end_turn"}});};
  return {host,adapter,entry,prompts,get,run,assertQueued,finishNative,inject:()=>{injectNative=true;},user:()=>userPrompt,permission(sessionId=entry.record.nativeSessionId){emit({jsonrpc:"2.0",id:77,method:"session/request_permission",params:{sessionId,options:[{optionId:"allow-once",name:"Allow once",kind:"allow_once"}]}});}};
}

for(const agentId of ["kilo","grok-build"]){
  test(`${agentId} partial completed plan does not admit a schedule before the native prompt finishes`,async t=>{
    const f=await fixture(t,agentId),user=f.adapter.prompt(f.entry.record.nativeSessionId,"Original native work");await wait();
    assert.equal(f.adapter.sessions()[0].status,agentId==="kilo"?"idle":"running");assert.equal(f.adapter.sessionWorking(f.entry.record.nativeSessionId),true);
    await f.run();f.assertQueued();assert.equal(f.prompts.length,1);
    f.finishNative();await user;await f.host.tick();await wait();assert.equal(f.prompts.length,2);
    f.finishNative();await wait();assert.equal(f.get().status,"completed");
  });
  test(`${agentId} pending approval blocks only its own schedule target`,async t=>{
    const f=await fixture(t,agentId);f.permission();assert.equal(f.adapter.sessionWorking(f.entry.record.nativeSessionId),false);
    await f.run();f.assertQueued();assert.equal(f.prompts.length,0);
    f.adapter.respondPermission("77",{outcome:{outcome:"selected",optionId:"allow-once"}});
    f.permission("another-native-session");await f.host.tick();await wait();assert.equal(f.prompts.length,1,"another session's approval does not block this target");
    f.finishNative();await wait();assert.equal(f.get().status,"completed");
  });
  test(`${agentId} prompt-in-flight rejection at native admission requeues without charging budgets`,async t=>{
    const f=await fixture(t,agentId);f.inject();await f.run();f.assertQueued();assert.equal(f.prompts.length,1,"only the original native prompt reached the peer");
    f.finishNative();await f.user();await f.host.tick();await wait();assert.equal(f.prompts.length,2);
    f.finishNative();await wait();assert.equal(f.get().status,"completed");assert.equal(f.get().turns,1);assert.equal(f.get().retries,0);
  });
}
