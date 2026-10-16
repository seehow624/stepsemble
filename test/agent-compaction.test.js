"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), { randomUUID } = require("node:crypto");
const { normalizeCompactCommand, createAgentCompaction } = require("../server/agent-compaction");
const flush = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve, reject; const promise = new Promise((a,b) => { resolve=a; reject=b; }); return { promise, resolve, reject }; };
function fixture(t) {
  const key=randomUUID(), entries=new Map([[key,{key,record:{agentId:"pi",sid:"owned-pi",cwd:"/owned"}}]]), calls=[], reservations=[];
  const pending=deferred(); let description={supported:true,instructions:true,reason:null,busy:false}, goal=false;
  const service=createAgentCompaction({ resolve:key=>entries.get(key), describe:async()=>description, goalLocked:()=>goal,
    run:async(record,options)=>{calls.push({record:{...record},options});return pending.promise;}, reserve:active=>reservations.push(active) });
  t.after(()=>{service.close();pending.resolve({completed:true});});
  return {service,key,entries,calls,reservations,pending,input:()=>({entry:key,requestId:randomUUID()}),describe:value=>{description=value;},goal:value=>{goal=value;}};
}

test("only an agent-advertised compaction command is selected, with bounded input hints",()=>{
  assert.equal(normalizeCompactCommand(null),null);
  assert.equal(normalizeCompactCommand([{name:"write-summary"},{name:"compact-all"}]),null);
  assert.deepEqual(normalizeCompactCommand([{name:"compress",input:{hint:"What to keep"}}]),{command:"compress",instructions:true});
  assert.deepEqual(normalizeCompactCommand([{name:"summarize"},{name:"compact"}]),{command:"compact",instructions:false});
  assert.equal(normalizeCompactCommand([{name:"COMPACT"},{name:"/compact"}]),null);
  assert.equal(normalizeCompactCommand([{name:"compact",input:{hint:"x".repeat(4000)}}]).instructions,false);
});

test("inspection reports capability without executing or reserving native work",async t=>{
  const f=fixture(t), state=await f.service.inspect(f.key);
  assert.equal(state.supported,true);assert.equal(state.instructions,true);assert.equal(state.operation,null);
  assert.deepEqual(f.calls,[]);assert.deepEqual(f.reservations,[]);
});

test("execution keeps its original native scope and cannot finish on an acknowledgement",async t=>{
  const f=fixture(t), input={...f.input(),instructions:"Keep decisions\nand remaining work"};
  const state=await f.service.start(input);await flush();
  assert.equal(state.operation.status,"running");assert.equal(f.service.locked(f.key),true);
  assert.equal(f.calls.length,1);assert.equal(f.calls[0].record.sid,"owned-pi");assert.equal(f.calls[0].options.instructions,input.instructions);
  assert.deepEqual(f.reservations,[true]);
  f.pending.resolve({kind:"sent"});await flush();
  const after=await f.service.inspect(f.key);assert.notEqual(after.operation.status,"completed");assert.equal(after.operation.error,"compaction_not_confirmed");
});

test("native completion records only the token values it really provides",async t=>{
  const f=fixture(t);await f.service.start(f.input());await flush();
  f.pending.resolve({completed:true,beforeTokens:12345,afterTokens:2300,estimated:true,modelReply:"not public"});await flush();
  const state=await f.service.inspect(f.key);assert.equal(state.operation.status,"completed");assert.equal(state.operation.beforeTokens,12345);
  assert.equal(state.operation.afterTokens,2300);assert.equal(state.operation.estimated,true);assert.equal(state.operation.modelReply,undefined);
  assert.equal(f.service.locked(f.key),false);assert.deepEqual(f.reservations,[true,false]);
});

test("unknown and invalid token values remain absent",async t=>{
  const f=fixture(t);await f.service.start(f.input());await flush();f.pending.resolve({completed:true,beforeTokens:-1,afterTokens:Infinity});await flush();
  const op=(await f.service.inspect(f.key)).operation;assert.equal(op.status,"completed");assert.equal(op.beforeTokens,undefined);assert.equal(op.afterTokens,undefined);
});

test("native errors are failures, not successful compression",async t=>{
  const f=fixture(t);await f.service.start(f.input());await flush();f.pending.reject(Object.assign(new Error("private provider details"),{code:"provider_unavailable"}));await flush();
  const op=(await f.service.inspect(f.key)).operation;assert.equal(op.status,"failed");assert.equal(op.error,"provider_unavailable");assert.equal(op.afterTokens,undefined);assert.equal(f.service.locked(f.key),false);
});

test("repeated request IDs replay the same operation rather than sending again",async t=>{
  const f=fixture(t), input=f.input();const [a,b]=await Promise.all([f.service.start(input),f.service.start(input)]);await flush();
  assert.equal(a.operation.id,b.operation.id);assert.equal(f.calls.length,1);
  f.pending.resolve({completed:true});await flush();const c=await f.service.start(input);assert.equal(c.operation.status,"completed");assert.equal(f.calls.length,1);
  await assert.rejects(f.service.start({...input,instructions:"changed"}),/request_conflict/);
});

test("a competing compaction is refused before any second native action",async t=>{
  const f=fixture(t);await f.service.start(f.input());await assert.rejects(f.service.start(f.input()),/compaction_busy/);assert.equal(f.calls.length,1);
});

for(const [name,describe] of [["unsupported",{supported:false,instructions:false,reason:"compaction_unavailable"}], ["working",{supported:true,instructions:true,busy:true,reason:null}]])test(`${name} sessions never dispatch compaction`,async t=>{
  const f=fixture(t);f.describe(describe);await assert.rejects(f.service.start(f.input()),name==="unsupported"?/compaction_unavailable/:/compaction_busy/);assert.equal(f.calls.length,0);assert.deepEqual(f.reservations,[]);
});

test("unsupported instructions are refused instead of silently discarded",async t=>{
  const f=fixture(t);f.describe({supported:true,instructions:false,busy:false});await assert.rejects(f.service.start({...f.input(),instructions:"Keep decisions"}),/compaction_instructions_unavailable/);assert.equal(f.calls.length,0);
});

for(const reason of ["goal","readonly","history","hermes"])test(`${reason} sessions cannot be compacted`,async t=>{
  const f=fixture(t), entry=f.entries.get(f.key);
  if(reason==="goal")f.goal(true);
  if(reason==="readonly")entry.record.readOnly=true;
  if(reason==="history")entry.record.nativeHistoryReadonly=true;
  if(reason==="hermes")entry.record.agentId="hermes";
  const state=await f.service.inspect(f.key);assert.equal(state.supported,false);
  await assert.rejects(f.service.start(f.input()));assert.equal(f.calls.length,0);
});

test("Codex native mutation records may retain their reader's readOnly flag",async t=>{
  const f=fixture(t);Object.assign(f.entries.get(f.key).record,{agentId:"codex",readOnly:true,nativeCodex:true,mutation:"native_api",nativeThreadId:"owned-thread"});
  assert.equal((await f.service.inspect(f.key)).supported,true);
});

test("identity and Goal ownership are checked again after asynchronous admission",async t=>{
  const f=fixture(t), gate=deferred();let entered=false;
  const service=createAgentCompaction({resolve:key=>f.entries.get(key),describe:async()=>{entered=true;return gate.promise;},goalLocked:()=>false,run:async()=>{throw new Error("must not run");}});t.after(()=>service.close());
  const request=service.start(f.input());await flush();assert.equal(entered,true);
  f.entries.get(f.key).record.sid="another-session";gate.resolve({supported:true,instructions:true,busy:false});await assert.rejects(request,/compaction_conversation_changed/);
  assert.equal(service.locked(f.key),false);
});

test("input and ownership are validated before native work",async t=>{
  const f=fixture(t);
  for(const input of [{}, {entry:"../outside",requestId:randomUUID()}, {...f.input(),sessionId:"other"},{...f.input(),instructions:"x".repeat(16001)}, {...f.input(),instructions:"bad\u0000"}])await assert.rejects(f.service.start(input));
  await assert.rejects(f.service.inspect(randomUUID()),/workspace_entry_not_found/);assert.equal(f.calls.length,0);
});

test("closing the Host does not start or replay another native operation",async t=>{
  const f=fixture(t), input=f.input();await f.service.start(input);await flush();f.service.close();f.pending.resolve({completed:true});await flush();
  await assert.rejects(f.service.start(input),/compaction_closed/);assert.deepEqual(f.reservations,[true,false]);
});

test("an unconfirmed result is not success, yet releases the conversation and Host work",async t=>{
  const f=fixture(t);await f.service.start(f.input());await flush();
  f.pending.reject(Object.assign(new Error("slow"),{code:"compaction_result_unknown"}));await flush();
  const op=(await f.service.inspect(f.key)).operation;
  assert.equal(op.status,"uncertain");assert.equal(op.error,"compaction_result_unknown");
  assert.equal(f.service.locked(f.key),false);assert.deepEqual(f.reservations,[true,false]);
  await f.service.start(f.input());assert.equal(f.calls.length,2,"a person may start a new compaction after checking");
});
