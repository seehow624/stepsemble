"use strict";
const test=require("node:test"),assert=require("node:assert/strict"),{randomUUID}=require("node:crypto");
const {parse,eligible,create}=require("../public/modules/agent-compaction");
const flush=()=>new Promise(resolve=>setImmediate(resolve));
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
function fixture(){
 let context={context:"host-1:view-1",entry:randomUUID(),agentId:"pi",connected:true,readOnly:false,busy:false};
 let state={supported:true,instructions:true,busy:false,reason:null,operation:null};const calls=[],accepted=[],errors=[],statuses=[],timers=new Map();let timer=0,postFailure=null;
 const controller=create({getContext:()=>context,request:async(path,body)=>{calls.push({path,body});if(body){if(postFailure)throw postFailure;state={...state,busy:true,operation:{id:randomUUID(),status:"running",error:null}};}return structuredClone(state);},onAccepted:text=>accepted.push(text),onError:code=>errors.push(code),onStatus:value=>statuses.push(value),schedule:fn=>{timers.set(++timer,fn);return timer;},cancel:id=>timers.delete(id),makeRequestId:()=>randomUUID()});
 return {controller,calls,accepted,errors,statuses,timers,setContext:value=>{context={...context,...value};},setState:value=>{state=value;},getState:()=>state,postFailure:value=>{postFailure=value;},tick:async()=>{const [id,fn]=timers.entries().next().value||[];if(fn){timers.delete(id);await fn();}},close:()=>controller.close()};
}

test("only the complete compact command is intercepted, preserving multiline instructions",()=>{
 assert.deepEqual(parse(" /COMPACT  Keep decisions\nand current work "),{instructions:"Keep decisions\nand current work"});assert.deepEqual(parse("/compact"),{instructions:""});
 for(const text of ["/compactor","/compact-other","Explain /compact","`/compact`",null])assert.equal(parse(text),null);
 for(const agent of ["pi","claude-code","codex","opencode","cline","kilo","omp","grok-build","antigravity"])assert.equal(eligible(agent),true);
 for(const agent of ["hermes","unknown",null])assert.equal(eligible(agent),false);
});

test("the slash item is disabled until native capability is known and Hermes has no item",async()=>{
 const f=fixture();assert.equal(f.controller.item().disabled,true);await f.controller.refresh();assert.equal(f.controller.item().disabled,false);assert.equal(f.controller.item().name,"compact");
 f.setState({supported:false,instructions:false,busy:false,reason:"compaction_native_unavailable",operation:null});await f.controller.refresh();assert.equal(f.controller.item().disabled,true);assert.equal(f.controller.item().reason,"compaction_native_unavailable");
 f.setContext({agentId:"hermes"});assert.equal(f.controller.item(),null);const count=f.calls.length;await f.controller.refresh();assert.equal(f.calls.length,count);f.close();
});

test("accepted compaction clears only its captured draft and keeps polling after the acknowledgement",async()=>{
 const f=fixture();const result=await f.controller.submit("/compact Keep decisions",{hasAttachments:false});
 assert.equal(result.accepted,true);assert.deepEqual(f.accepted,["/compact Keep decisions"]);assert.equal(f.controller.busy(),true);assert.equal(f.getState().operation.status,"running");assert.equal(f.timers.size,1);
 const post=f.calls.find(call=>call.body);assert.equal(post.body.instructions,"Keep decisions");assert.match(post.body.requestId,/^[a-f0-9-]{36}$/);
 f.setState({...f.getState(),busy:false,operation:{...f.getState().operation,status:"completed",beforeTokens:10000,afterTokens:2000,estimated:true}});await f.tick();
 assert.equal(f.controller.busy(),false);assert.equal(f.statuses.at(-1).operation.status,"completed");assert.equal(f.timers.size,0);f.close();
});

test("attachments, unsupported instructions, readonly and busy conversations keep the draft and send nothing",async()=>{
 for(const kind of ["attachments","instructions","readonly","busy","notconnected"]){const f=fixture();
  if(kind==="instructions")f.setState({supported:true,instructions:false,busy:false,operation:null});
  if(kind==="readonly")f.setContext({readOnly:true});if(kind==="busy")f.setContext({busy:true});if(kind==="notconnected")f.setContext({connected:false});
  const result=await f.controller.submit("/compact Keep decisions",{hasAttachments:kind==="attachments"});assert.equal(result.accepted,false,kind);assert.equal(f.calls.filter(call=>call.body).length,0,kind);assert.deepEqual(f.accepted,[]);assert.equal(f.errors.length,1,kind);f.close();
 }
});

test("double clicks cannot dispatch the same action twice",async()=>{
 const gate=deferred();let context={context:"one",entry:randomUUID(),agentId:"pi",connected:true},posts=0;
 const c=create({getContext:()=>context,request:async(path,body)=>{if(body){posts++;return gate.promise;}return {supported:true,instructions:true,busy:false,operation:null};},schedule:()=>1,cancel(){},onError(){}});
 const first=c.submit("/compact");await flush();const second=await c.submit("/compact");assert.equal(second.accepted,false);assert.equal(posts,1);
 gate.resolve({supported:true,instructions:true,busy:false,operation:{id:randomUUID(),status:"completed"}});await first;c.close();
});

test("an uncertain POST retry reuses its UUID instead of buying a second compaction",async()=>{
 const f=fixture();f.postFailure(new Error("lost response"));await f.controller.submit("/compact");const first=f.calls.find(call=>call.body).body;
 assert.equal(f.accepted.length,0);f.postFailure(null);await f.controller.submit("/compact");const posts=f.calls.filter(call=>call.body);assert.equal(posts.length,2);assert.equal(posts[1].body.requestId,first.requestId);f.close();
});

test("late results from another Host or conversation never clear the new draft",async()=>{
 const gate=deferred(),accepted=[],statuses=[];let context={context:"host-a:1",entry:randomUUID(),agentId:"pi",connected:true};
 const c=create({getContext:()=>context,request:async(path,body)=>body?gate.promise:{supported:true,instructions:true,busy:false,operation:null},onAccepted:text=>accepted.push(text),onStatus:state=>statuses.push(state),schedule:()=>1,cancel(){}});
 const send=c.submit("/compact");await flush();context={...context,context:"host-b:2",entry:randomUUID()};
 gate.resolve({supported:true,instructions:true,busy:true,operation:{id:randomUUID(),status:"running"}});await send;assert.deepEqual(accepted,[]);assert.equal(c.busy(),false);assert.equal(c.item().disabled,true);c.close();
});

test("a lost poll keeps the running operation rather than declaring success",async()=>{
 const f=fixture();await f.controller.submit("/compact");const before=f.statuses.at(-1).operation.status;assert.equal(before,"running");f.close();assert.equal(f.timers.size,0);
});
test("compaction labels exist in every locale with matching interpolation and no user-text rewriting",()=>{
 const i18n=require("../public/modules/compaction-i18n");const keys=Object.keys(i18n.tables.en);
 assert.equal(i18n.locales.length,11);
 for(const locale of i18n.locales){assert.deepEqual(Object.keys(i18n.tables[locale]),keys);for(const key of keys){assert.ok(i18n.tables[locale][key]);assert.deepEqual([...i18n.tables[locale][key].matchAll(/\{(\w+)\}/g)].map(m=>m[1]).sort(),[...i18n.tables.en[key].matchAll(/\{(\w+)\}/g)].map(m=>m[1]).sort());}}
 assert.equal(i18n.t("running",{},"zh-Hant"),"正在壓縮上下文…");
 assert.match(i18n.t("completedTokens",{before:"10k",after:"2k"},"en"),/10k.*2k/);
 assert.equal(i18n.t("compaction_result_unknown",{},"zh-Hant"),i18n.t("compaction_not_confirmed",{},"zh-Hant"));
});
