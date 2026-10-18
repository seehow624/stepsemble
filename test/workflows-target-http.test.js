"use strict";
const test=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs/promises"),path=require("node:path"),os=require("node:os"),{spawn}=require("node:child_process");
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
test("isolated schedule targets preserve native identity through idle release and Host restart, defer busy work, and never replace missing targets",async t=>{
  if(process.platform==="win32"){t.skip("POSIX executable protocol fixture");return;}
  const {cleanEnvironment}=await import("../scripts/check-rolling-clients.mjs"),{freePort,waitForServer,stopServer}=await import("../scripts/host-performance-baseline.mjs");
  const home=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),"stepsemble-workflow-target-"))),bin=path.join(home,"bin"),sessions=path.join(home,".pi/agent/sessions"),log=path.join(home,"peer.log");
  await fs.mkdir(bin);await fs.mkdir(sessions,{recursive:true});const quote=s=>"'"+s.replaceAll("'","'\\''")+"'";
  for(const [name,mode] of [["pi","pi"],["claude","claude"],["kilo","acp"]])await fs.writeFile(path.join(bin,name),`#!/bin/sh\nSTEPSEMBLE_WORKFLOW_PEER=${mode} STEPSEMBLE_WORKFLOW_PEER_LOG=${quote(log)} STEPSEMBLE_WORKFLOW_PEER_SESSIONS=${quote(sessions)} exec ${quote(process.execPath)} ${quote(path.resolve("test-support/workflow-peer.cjs"))} "$@"\n`,{mode:0o700});
  const port=await freePort(),base=`http://127.0.0.1:${port}`;let child,cookie="",output="";
  const request=(route,body)=>fetch(base+route,{headers:{Cookie:cookie,Origin:base,...(body?{"Content-Type":"application/json"}:{})},...(body?{method:"POST",body:JSON.stringify(body)}:{})});
  const json=async(route,body)=>{const res=await request(route,body),data=await res.json();assert(res.ok,JSON.stringify(data)+output);return data;};
  async function start(){
    child=spawn(process.execPath,[path.resolve("server.js")],{cwd:home,stdio:["ignore","pipe","pipe"],env:{...cleanEnvironment(home),PATH:[bin,path.dirname(process.execPath),"/usr/bin","/bin"].join(":"),PI_HOME:home,PI_BIN:path.join(bin,"pi"),STEPSEMBLE_HOST:"127.0.0.1",STEPSEMBLE_PORT:String(port),STEPSEMBLE_ORPHAN_EXIT:"0",STEPSEMBLE_TOKEN:"target-fixture-only",STEPSEMBLE_CLAUDE_STRUCTURED:"1",STEPSEMBLE_WORKSPACE_KEYCHAIN_USAGE:"0"}});
    child.stderr.on("data",b=>output+=b);child.stdout.resume();await waitForServer(child);
    const login=await request("/api/login",{token:"target-fixture-only"});cookie=login.headers.get("set-cookie").split(";",1)[0];
  }
  t.after(async()=>{if(child)await stopServer(child);await fs.rm(home,{recursive:true,force:true});});await start();
  const until=async(fn)=>{for(let i=0;i<120;i++){const value=await fn();if(value)return value;await sleep(50);}throw new Error("Timed out: "+JSON.stringify(await json("/api/workflows"))+output);};
  const finished=id=>until(async()=>{const r=(await json("/api/workflows")).runs.find(r=>r.id===id);return r&&["completed","failed"].includes(r.status)?r:null;});
  const peer=async()=>(await fs.readFile(log,"utf8")).trim().split("\n").map(line=>JSON.parse(line).command);
  const initial=await json("/api/open",{cwd:home,name:"Original maintenance conversation"}),key=initial.workspaceEntry.key;
  await json("/api/send",{sid:initial.sid,message:"Original history"});
  await until(async()=>{const r=(await json("/api/workspace/entry?key="+key)).record;return r.file&&!r.live?.isStreaming?r:null;});
  const record=(await json("/api/workspace/entry?key="+key)).record,file=path.join(sessions,record.file);
  const input={kind:"schedule",title:"Different schedule title",objective:"Scheduled maintenance",agentId:"pi",cwd:home,mode:"task",targetEntry:key,choice:{model:"missing",provider:"fixture",effort:"high"},permission:"invalid-pinned-mode",limits:{minutes:1,turns:3},schedule:{kind:"interval",minutes:15}};
  assert.equal((await request("/api/workflows",{...input,targetEntry:require("node:crypto").randomUUID()})).ok,false,"foreign Host keys cannot bind locally");
  assert.equal((await request("/api/workflows",{...input,agentId:"codex"})).ok,false,"forged agent cannot override the target");
  const other=path.join(home,"other");await fs.mkdir(other);
  assert.equal((await request("/api/workflows",{...input,cwd:other})).ok,false,"forged cwd cannot override the target");
  assert((await json("/api/workflows/targets")).entries.some(r=>r.key===key));
  const schedule=await json("/api/workflows",input);
  const edited=await json("/api/workflows",{...input,targetEntry:undefined,id:schedule.id,action:"edit",title:"Edited in place"});assert.equal(edited.targetEntry,key);
  assert.equal((await json("/api/workflows")).schedules.length,1);
  const runNow=async()=>{const r=await json("/api/workflows",{id:schedule.id,action:"run"});const done=await finished(r.id);assert.equal(done.status,"completed",JSON.stringify(done));assert.equal(done.entry,key);return done;};
  await runNow();assert.equal((await json("/api/workspace")).entries.length,1);
  assert(!(await peer()).some(c=>["set_model","set_thinking_level","set_permission_mode"].includes(c.type)),"schedule pins never apply to the target");
  // An idle Pi is released; --session must resume its actual saved history.
  assert.equal((await json("/api/close",{sid:record.sid})).closed,true);await sleep(100);
  await runNow();const resumed=(await json("/api/workspace/entry?key="+key)).record;
  assert.notEqual(resumed.sid,record.sid);assert.equal(resumed.file,record.file);assert.equal(resumed.name,record.name);
  assert((await peer()).some(c=>c.type==="peer_start"&&c.args.includes(file)));
  assert.match(await fs.readFile(file,"utf8"),/Original history/);
  assert.equal((await json("/api/workspace")).entries.length,1);
  // Native work and its follow-up win over the queued scheduler. Stopping the
  // queued run must not send an abort to the user's own native turn.
  await json("/api/send",{sid:resumed.sid,message:"SLOW original user work"});
  const waiting=await json("/api/workflows",{id:schedule.id,action:"run"});await sleep(1150);
  let queued=(await json("/api/workflows")).runs.find(r=>r.id===waiting.id);assert.equal(queued.status,"queued");assert.equal(queued.turns,0);assert.equal(queued.elapsedMs,0);assert.equal(queued.retries,undefined);
  assert.equal((await request("/api/send",{sid:resumed.sid,message:"SLOW user follow-up"})).status,200);
  const aborts=(await peer()).filter(c=>c.type==="abort").length;
  await json("/api/workflows",{id:waiting.id,action:"stop"});assert.equal((await peer()).filter(c=>c.type==="abort").length,aborts);
  await json("/api/abort",{sid:resumed.sid});await sleep(150);
  // Compaction owns the conversation too; no native prompt goes out until idle.
  const compact=json("/api/agent/compaction",{entry:key,requestId:require("node:crypto").randomUUID(),instructions:"SLOW"});await sleep(100);
  const deferred=await json("/api/workflows",{id:schedule.id,action:"run"});await sleep(100);
  queued=(await json("/api/workflows")).runs.find(r=>r.id===deferred.id);assert.equal(queued.status,"queued");
  await compact;assert.equal((await finished(deferred.id)).status,"completed");
  // Real occurrence (not just Run now) preserves the same target.
  await json("/api/workflows",{...input,id:schedule.id,action:"edit",schedule:{kind:"once",at:new Date(Date.now()+1500).toISOString()}});
  const due=await until(async()=>{const r=(await json("/api/workflows")).runs.find(r=>r.scheduleId===schedule.id&&r.scheduledAt);return r&&r.status==="completed"?r:null;});assert.equal(due.entry,key);
  // Persist the binding and restart only this isolated fixture Host.
  await stopServer(child);child=null;await start();
  assert.equal((await json("/api/workflows")).schedules[0].targetEntry,key);await runNow();
  assert.equal((await json("/api/workspace")).entries.length,1);
  // A deleted backing file, then deleted membership, both fail without a
  // new process/conversation or a silently cleared binding.
  await fs.unlink(file);const starts=(await peer()).filter(c=>c.type==="peer_start").length;
  const missing=await json("/api/workflows",{id:schedule.id,action:"run"});assert.equal((await finished(missing.id)).status,"failed");
  assert.equal((await peer()).filter(c=>c.type==="peer_start").length,starts);
  assert(!(await json("/api/workflows/targets")).entries.some(r=>r.key===key));
  await json("/api/workspace/remove",{key});const deleted=await json("/api/workflows",{id:schedule.id,action:"run"});assert.equal((await finished(deleted.id)).status,"failed");
  assert.equal((await json("/api/workflows")).schedules[0].targetEntry,key);assert.equal((await json("/api/workspace")).entries.length,0);
  const unbound=await json("/api/workflows",{...input,id:schedule.id,action:"edit",targetEntry:null});assert.equal(unbound.targetEntry,null);
  // Claude's released process and ACP's persisted native load also retain the
  // exact Workspace membership; schedule pins cannot override either one.
  const bindings=[];
  for(const agentId of ["claude-code","kilo"]){
    const created=await json("/api/workflows",{title:"Original native title",objective:"Original native history",agentId,cwd:home,mode:"task",...(agentId==="claude-code"?{permission:"acceptEdits",choice:{model:"fixture"}}:{})});
    const done=await finished(created.id);assert.equal(done.status,"completed");
    const prior=(await json("/api/workspace/entry?key="+done.entry)).record;
    const bound=await json("/api/workflows",{...input,agentId,targetEntry:done.entry});bindings.push({bound,prior,key:done.entry});
    if(agentId==="claude-code"){
      await json("/api/agent/close",{taskId:prior.id});
      const run=await json("/api/workflows",{id:bound.id,action:"run"});const resumed=await finished(run.id);assert.equal(resumed.status,"completed",JSON.stringify(resumed));assert.equal(resumed.entry,done.entry);
      assert.equal((await json("/api/workspace/entry?key="+done.entry)).record.nativeSessionId,prior.nativeSessionId);
      const nativeFile=path.join(home,".claude/projects",home.replace(/[^A-Za-z0-9]/g,"-"),prior.nativeSessionId+".jsonl");
      assert.match(await fs.readFile(nativeFile,"utf8"),/Original native history/);
      assert((await peer()).some(c=>c.type==="peer_start"&&c.args.includes("--resume")&&c.args.includes(prior.nativeSessionId)));
    }
  }
  await stopServer(child);child=null;await start();
  for(const {bound,prior,key} of bindings){
    const run=await json("/api/workflows",{id:bound.id,action:"run"}),done=await finished(run.id);assert.equal(done.status,"completed",JSON.stringify(done));assert.equal(done.entry,key);
    const current=(await json("/api/workspace/entry?key="+key)).record;assert.equal(current.nativeSessionId,prior.nativeSessionId);assert.equal(current.name,prior.name);
  }
  assert.equal((await json("/api/workspace")).entries.length,2,"native resumes do not add new Workspace entries");
  assert(!(await peer()).some(c=>c.request?.subtype==="set_permission_mode"&&c.request.mode==="invalid-pinned-mode"));
});
