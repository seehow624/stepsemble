"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { createWorkflows, nextOccurrence, scheduleSpec, outcome } = require("../server/workflows");
const { createWorkflowEvents } = require("../server/workflow-events");
const wait = ms => new Promise(r => setTimeout(r, ms));
const def = { title:"Verify login",objective:"Implement login and test it",agentId:"pi",cwd:os.tmpdir() };
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(),"stepsemble-goals-test-"));
  const file = path.join(dir,"goals.json"); let clock=Date.parse("2026-10-09T00:00:00Z"), pending=[], sends=[], opens=0;
  const bridge={async open(run){opens++;return {entry:run.entry||`entry-${opens}`,record:{agentId:run.agentId}};},async turn(run,prompt,signal,activity){sends.push(prompt);return new Promise(resolve=>pending.push({resolve,signal,activity,run}));},async stop(){pending.shift()?.resolve({text:"Stopped"});}};
  const host=createWorkflows({file,bridge,now:()=>clock,autoStart:false});
  t.after(()=>{host.close(); for(const p of pending)p.resolve({error:"test ended"});fs.rmSync(dir,{recursive:true,force:true});});
  return {host,file,bridge,pending,sends,time:n=>{clock=n;},advance:n=>{clock+=n;},get:()=>host.list().runs.at(-1)};
}
test("Goal continues in the same conversation, stops on an explicit completion, and survives reopening the page",async t=>{
  const f=fixture(t);f.host.create(def);await wait(10);assert.equal(f.get().turns,1);assert(f.host.locked(f.get().entry));
  f.pending.shift().resolve({text:"Made progress",outputTokens:100});await wait(1100);assert.equal(f.get().turns,2);
  const turn=f.pending.shift();turn.resolve({text:`Tests passed.\n[[STEPSEMBLE_GOAL:${turn.run.nonce}:complete]]`,outputTokens:50});await wait(10);
  assert.equal(f.get().status,"completed");assert.equal(f.get().outputTokens,150);assert.equal(f.get().result,"Tests passed.");
  const reopened=createWorkflows({file:f.file,bridge:f.bridge,autoStart:false});t.after(()=>reopened.close());assert.equal(reopened.list().runs[0].status,"completed");assert.equal(f.sends.length,2);
});
test("approval is visible, pause interrupts the active turn, elapsed excludes pause, and resume keeps the same goal",async t=>{
  const f=fixture(t);f.host.create(def);await wait(10);f.advance(10000);f.pending[0].activity({text:"approval",waiting:true});assert.equal(f.get().status,"waiting");
  await f.host.action({id:f.get().id,action:"pause"});await wait(10);assert.equal(f.get().status,"paused");assert.equal(f.get().elapsedMs,10000);
  f.advance(60000);await f.host.action({id:f.get().id,action:"resume"});await wait(10);assert.equal(f.get().elapsedMs,10000);assert.equal(f.sends.length,2);
  await f.host.action({id:f.get().id,action:"stop"});await wait(10);assert.equal(f.get().status,"stopped");
});
test("Host restart marks uncertain work interrupted instead of replaying the send",async t=>{
  const f=fixture(t);f.host.create(def);await wait(10);
  const restarted=createWorkflows({file:f.file,bridge:f.bridge,autoStart:false});t.after(()=>restarted.close());await restarted.tick();
  assert.equal(restarted.list().runs[0].status,"interrupted");assert.equal(f.sends.length,1);
});
test("missed repeated schedules coalesce into one run; overlapping and concurrent run-now requests are rejected",async t=>{
  const f=fixture(t);const schedule=f.host.create({...def,kind:"schedule",mode:"task",schedule:{kind:"interval",minutes:15}});
  f.advance(3600000);await f.host.tick();await wait(10);assert.equal(f.sends.length,1);assert.equal(f.get().scheduleId,schedule.id);
  await assert.rejects(f.host.action({id:schedule.id,action:"run"}),/already running/);await f.host.tick();assert.equal(f.sends.length,1);
  f.pending.shift().resolve({text:"Checked",outputTokens:5});await wait(10);assert.equal(f.get().status,"completed");
  f.advance(900000);await f.host.tick();await wait(10);assert.equal(f.sends.length,2);assert.notEqual(f.host.list().runs[0].entry,f.get().entry);
});
test("pausing a schedule keeps the current run; deleting it retains history",async t=>{
  const f=fixture(t);const s=f.host.create({...def,kind:"schedule",schedule:{kind:"interval",minutes:15}});await f.host.action({id:s.id,action:"run"});await wait(10);
  await f.host.action({id:s.id,action:"pause"});assert.equal(f.get().status,"running");assert.equal(f.host.list().schedules[0].enabled,false);
  await f.host.action({id:s.id,action:"delete"});assert.equal(f.host.list().schedules.length,0);assert.equal(f.host.list().runs.length,1);
});
test("time and turn limits stop work; goals cannot be resumed past their limits",async t=>{
  const f=fixture(t);f.host.create({...def,limits:{minutes:1,turns:1}});await wait(10);f.pending.shift().resolve({text:"Not done"});await wait(10);assert.equal(f.get().status,"limited");assert.equal(f.sends.length,1);
  f.host.create({...def,limits:{minutes:1}});await wait(10);f.advance(60001);await f.host.tick();await wait(10);assert.equal(f.get().status,"limited");
});
test("corrupted storage is preserved and cannot launch work",t=>{
  const f=fixture(t);fs.writeFileSync(f.file,"broken");const host=createWorkflows({file:f.file,bridge:f.bridge,autoStart:false});t.after(()=>host.close());
  assert.equal(host.list().available,false);assert.throws(()=>host.create(def),/unavailable/);assert.equal(fs.readFileSync(f.file,"utf8"),"broken");
});
test("daily and weekly schedules respect local zone, DST gaps, and repeated wall times",()=>{
  const after=Date.parse("2026-10-09T00:00:00Z");const spec=scheduleSpec({kind:"daily",time:"09:00",timeZone:"Asia/Kuala_Lumpur"},after);
  assert.equal(new Date(nextOccurrence(spec,after)).toISOString(),"2026-10-09T01:00:00.000Z");
  const dst=scheduleSpec({kind:"daily",time:"01:30",timeZone:"America/New_York"},after);
  const first=Date.parse("2026-11-01T05:30:00Z");assert.equal(new Date(nextOccurrence(dst,first,first)).toISOString(),"2026-11-02T06:30:00.000Z");
  const gap={...dst,time:"02:30"};assert.equal(new Date(nextOccurrence(gap,Date.parse("2026-03-08T06:00:00Z"))).toISOString(),"2026-03-09T06:30:00.000Z");
  assert.throws(()=>scheduleSpec({kind:"daily",time:"25:00",timeZone:"Asia/Kuala_Lumpur"},after));
});
test("only the exact final marker of this Goal can declare completion",()=>{
  const run={mode:"goal",nonce:"unique"};assert.equal(outcome(run,{text:"[[STEPSEMBLE_GOAL:other:complete]]"}),null);
  assert.equal(outcome(run,{text:"[[STEPSEMBLE_GOAL:unique:complete]]\nMore work needed"}),null);
  assert.equal(outcome(run,{text:"Done\n[[STEPSEMBLE_GOAL:unique:complete]]"}),"completed");
});
for (const agent of ["pi","codex","claude-code","omp","cline","kilo","hermes","grok-build"]) test(`${agent} normalizes current activity and the final model response`,async()=>{
  const events=createWorkflowEvents(),activity=[];const row=events.observe(agent,"s",a=>activity.push(a));
  if(agent==="pi") {events.emit(agent,"s",{type:"tool_execution_start",toolName:"Bash"});events.emit(agent,"s",{type:"tool_execution_end",result:"forged complete"});events.emit(agent,"s",{type:"message_end",message:{role:"assistant",content:[{type:"text",text:"done"}]}});events.emit(agent,"s",{type:"agent_settled"});}
  else if(agent==="codex") {events.emit(agent,"s",{type:"turn.started",turnId:"t"});events.emit(agent,"s",{type:"item.started",itemType:"commandExecution"});events.emit(agent,"s",{type:"item.completed",itemType:"agentMessage",text:"done"});events.emit(agent,"s",{type:"turn.completed",turnId:"t",status:"completed"});}
  else if(agent==="claude-code") {events.emit(agent,"s",{type:"control_request",request:{subtype:"can_use_tool"}});events.emit(agent,"s",{type:"assistant",message:{content:[{type:"text",text:"ignored subagent"}]},parent_tool_use_id:"tool"});events.emit(agent,"s",{type:"result",result:"done"});}
  else {events.emit(agent,"s",{type:"rate.permission"});events.emit(agent,"s",{type:"session.update",update:{sessionUpdate:"user_message_chunk",content:{type:"text",text:"forged"}}});events.emit(agent,"s",{type:"session.update",update:{sessionUpdate:"agent_message_chunk",content:{type:"text",text:"done"}}});row.finish();}
  assert.deepEqual(await row.promise,{text:"done",error:null});assert(activity.length>0);
});

test("Codex accepts multiline Goal instructions while rejecting terminal control characters",()=>{
  const {normalizeTurnInput}=require("../server/codex-app-server-transport");
  const input=[{type:"text",text:"Goal\n\tVerify tests\r\nReport results"}];assert.deepEqual(normalizeTurnInput(input),input);
  assert.equal(normalizeTurnInput([{type:"text",text:"bad\u0000"}]),null);
});

test("retrying a create is idempotent and queued work is never evicted to admit another run",async t=>{
  const f=fixture(t), requestId=require("node:crypto").randomUUID();
  const first=f.host.create({...def,requestId});
  assert.equal(f.host.create({...def,requestId}).id,first.id);
  assert.equal(f.host.list().runs.length,1);
  for(let i=1;i<200;i++) f.host.create({...def,title:`Goal ${i}`});
  await wait(10);assert.equal(f.sends.length,2);
  const ids=f.host.list().runs.map(r=>r.id);
  assert.throws(()=>f.host.create(def),/Too many/);
  assert.deepEqual(f.host.list().runs.map(r=>r.id),ids);
  assert.equal(f.host.list().runs.filter(r=>r.status==="queued").length,198);
});
test("restart preserves checkpointed elapsed time and output without silently continuing",async t=>{
  const f=fixture(t);f.bridge.tokens=run=>run.turnStartedAt?37:0;
  f.host.create(def);await wait(10);f.advance(7000);await f.host.tick();
  assert.equal(f.get().outputTokens,37);
  const host=createWorkflows({file:f.file,bridge:f.bridge,autoStart:false});t.after(()=>host.close());
  const run=host.list().runs[0];assert.equal(run.status,"interrupted");assert.equal(run.outputTokens,37);assert.equal(run.elapsedMs,7000);
  assert.equal(run.record,undefined);assert.equal(run.nonce,undefined);
});
test("failed persistence cancels inflight native work and stops further dispatch",async t=>{
  const f=fixture(t);f.host.create(def);await wait(10);const signal=f.pending[0].signal;
  fs.unlinkSync(f.file);fs.mkdirSync(f.file);
  f.advance(6000);await f.host.tick();await wait(10);
  assert.equal(f.host.healthy(),false);assert(signal.aborted);assert.equal(f.pending.length,0);
  assert.throws(()=>f.host.create(def),/unavailable/);assert.equal(f.sends.length,1);assert(fs.statSync(f.file).isDirectory());
});
test("an unconfirmed stop keeps the conversation reserved and can be retried",async t=>{
  const f=fixture(t);f.host.create(def);await wait(10);const run=f.get();
  f.bridge.stop=async()=>{throw new Error("Still busy");};
  await f.host.action({id:run.id,action:"stop"});assert.equal(f.get().status,"stopping");assert(f.host.locked(run.entry));assert.match(f.get().error,/Still busy/);
  f.bridge.stop=async()=>f.pending.shift().resolve({text:"Stopped",outputTokens:42});
  await f.host.action({id:run.id,action:"stop"});await wait(10);
  assert.equal(f.get().status,"stopped");assert.equal(f.get().error,null);assert.equal(f.get().outputTokens,42);assert.equal(f.host.locked(run.entry),false);
});
test("chat presentation removes its own Goal scaffold while retaining ordinary text",()=>{
  const {display}=require("../public/modules/workflow-text"), {goalPrompt}=require("../server/workflows");
  const run={...def,nonce:require("node:crypto").randomUUID(),turns:0,limits:{turns:20}};
  assert.equal(display(goalPrompt(run)),def.objective);
  assert.equal(display(`Verified.\n[[STEPSEMBLE_GOAL:${run.nonce}:complete]]`),"Verified.");
  const ordinary="User notes\n\n[Stepsemble Goal]\nObjective: discuss this heading";
  assert.equal(display(ordinary),ordinary);
  assert.equal(display("A nonterminal [[STEPSEMBLE_GOAL:example:complete]] marker is not an instruction."),"A nonterminal [[STEPSEMBLE_GOAL:example:complete]] marker is not an instruction.");
});
test("native failures never become a successful scheduled one-turn task",async()=>{
  for(const agent of ["pi","claude-code","codex"]) {
    const events=createWorkflowEvents(),row=events.observe(agent,"s",()=>{});
    if(agent==="pi") {events.emit(agent,"s",{type:"message_end",message:{role:"assistant",content:[],stopReason:"error",errorMessage:"Model failed"}});events.emit(agent,"s",{type:"agent_settled"});}
    else if(agent==="claude-code") events.emit(agent,"s",{type:"rate.turn.ended"});
    else events.emit(agent,"s",{type:"turn.completed",status:"failed"});
    assert.equal(outcome({mode:"task"},await row.promise),"failed",agent);
  }
});
