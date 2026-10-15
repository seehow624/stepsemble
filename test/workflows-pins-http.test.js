"use strict";
const test=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs/promises"),path=require("node:path"),os=require("node:os"),{spawn}=require("node:child_process");
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
test("a pinned model and permission mode reach the new conversation before its first prompt",async t=>{
  if(process.platform==="win32"){t.skip("POSIX executable protocol fixtures");return;}
  const {cleanEnvironment}=await import("../scripts/check-rolling-clients.mjs");const {freePort,waitForServer,stopServer}=await import("../scripts/host-performance-baseline.mjs");
  const home=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),"stepsemble-goal-pins-"))),bin=path.join(home,"bin"),log=path.join(home,"peer.log");await fs.mkdir(bin);
  const projects={};for(const name of ["pi","pi-missing","claude","kilo"]){projects[name]=path.join(home,"projects",name);await fs.mkdir(projects[name],{recursive:true});}
  const quote=s=>"'"+s.replaceAll("'","'\\''")+"'";
  for(const [name,mode] of [["pi","pi"],["claude","claude"],["kilo","acp"]])await fs.writeFile(path.join(bin,name),`#!/bin/sh\nSTEPSEMBLE_WORKFLOW_PEER_LOG=${quote(log)} STEPSEMBLE_WORKFLOW_PEER=${mode} exec ${quote(process.execPath)} ${quote(path.resolve("test-support/workflow-peer.cjs"))} "$@"\n`,{mode:0o700});
  const port=await freePort(),base=`http://127.0.0.1:${port}`;
  const child=spawn(process.execPath,[path.resolve("server.js")],{cwd:home,stdio:["ignore","pipe","pipe"],env:{...cleanEnvironment(home),PATH:[bin,path.dirname(process.execPath),"/usr/bin","/bin"].join(":"),PI_HOME:home,PI_BIN:path.join(bin,"pi"),STEPSEMBLE_HOST:"127.0.0.1",STEPSEMBLE_PORT:String(port),STEPSEMBLE_ORPHAN_EXIT:"0",STEPSEMBLE_TOKEN:"workflow-local-only",STEPSEMBLE_CLAUDE_STRUCTURED:"1",STEPSEMBLE_WORKSPACE_KEYCHAIN_USAGE:"0"}});
  let output="";child.stderr.on("data",b=>output+=b);t.after(async()=>{await stopServer(child);await fs.rm(home,{recursive:true,force:true});});await waitForServer(child);child.stdout.resume();
  let cookie="";const request=(route,body)=>fetch(base+route,{headers:{Cookie:cookie,Origin:base,...(body?{"Content-Type":"application/json"}:{})},...(body?{method:"POST",body:JSON.stringify(body)}:{})});
  const json=async(route,body)=>{const res=await request(route,body);const data=await res.json();assert(res.ok,JSON.stringify(data)+output);return data;};
  const login=await request("/api/login",{token:"workflow-local-only"});cookie=login.headers.get("set-cookie").split(";",1)[0];
  const until=async(id,status)=>{for(let i=0;i<100;i++){const row=(await json("/api/workflows")).runs.find(r=>r.id===id);if(status.includes(row.status))return row;await sleep(100);}throw new Error("Workflow timeout: "+JSON.stringify(await json("/api/workflows"))+output);};
  const peer=async mode=>(await fs.readFile(log,"utf8").catch(()=>"")).trim().split("\n").filter(Boolean).map(line=>JSON.parse(line)).filter(row=>row.mode===mode).map(row=>row.command);
  const config={title:"Pinned",objective:"Verify the implementation",mode:"task",limits:{minutes:1,turns:3}};

  assert.equal((await request("/api/workflows/options?agentId=antigravity")).status,400);
  const claudeOptions=await json("/api/workflows/options?agentId=claude-code&cwd="+encodeURIComponent(projects.claude));
  assert(claudeOptions.modes.some(mode=>mode.id==="acceptEdits"));assert(Array.isArray(claudeOptions.models));
  const state=await json("/api/workflows");assert.equal(typeof state.keepsAwake,"boolean");

  const pi=await json("/api/workflows",{...config,agentId:"pi",cwd:projects.pi,choice:{model:"fixture-model",provider:"fixture",effort:"high"}});
  assert.equal((await until(pi.id,["completed","failed"])).status,"completed");
  const piCommands=await peer("pi"),setModel=piCommands.findIndex(c=>c.type==="set_model"),prompt=piCommands.findIndex(c=>c.type==="prompt");
  assert.deepEqual({provider:piCommands[setModel].provider,modelId:piCommands[setModel].modelId},{provider:"fixture",modelId:"fixture-model"});
  assert.equal(piCommands.find(c=>c.type==="set_thinking_level").level,"high");assert(setModel<prompt,"the model is set before the first prompt");

  const missing=await json("/api/workflows",{...config,agentId:"pi",cwd:projects["pi-missing"],choice:{model:"missing",provider:"fixture"}});
  const failed=await until(missing.id,["completed","failed"]);assert.equal(failed.status,"failed");assert.match(failed.error,/pinned model is unavailable/);
  assert.equal((await peer("pi")).filter(c=>c.type==="prompt").length,1,"no prompt is sent with the wrong model");

  const claude=await json("/api/workflows",{...config,agentId:"claude-code",cwd:projects.claude,permission:"acceptEdits"});
  assert.equal((await until(claude.id,["completed","failed"])).status,"completed");
  const claudeCommands=await peer("claude"),mode=claudeCommands.findIndex(c=>c.request?.subtype==="set_permission_mode"),user=claudeCommands.findIndex(c=>c.type==="user");
  assert.equal(claudeCommands[mode].request.mode,"acceptEdits");assert(mode<user,"the mode is set before the first prompt");

  const kilo=await json("/api/workflows",{...config,agentId:"kilo",cwd:projects.kilo,permission:"no-such-mode"});
  const kiloDone=await until(kilo.id,["completed","failed"]);assert.equal(kiloDone.status,"failed");assert.match(kiloDone.error,/pinned permission mode/);
  assert.equal((await peer("acp")).filter(c=>c.method==="session/prompt").length,0);
});
