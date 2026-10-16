"use strict";
const test=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs/promises"),path=require("node:path"),os=require("node:os"),{spawn}=require("node:child_process"),{randomUUID}=require("node:crypto");
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
test("an authenticated owned Pi compaction preserves its conversation and excludes competing sends",async t=>{
 if(process.platform==="win32"){t.skip("POSIX executable native peer");return;}
 const {cleanEnvironment}=await import("../scripts/check-rolling-clients.mjs"),{freePort,waitForServer,stopServer}=await import("../scripts/host-performance-baseline.mjs");
 const home=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),"stepsemble-compact-http-"))),bin=path.join(home,"bin"),log=path.join(home,"peer.log");await fs.mkdir(bin);
 const quote=value=>"'"+value.replaceAll("'","'\\''")+"'";
 await fs.writeFile(path.join(bin,"pi"),`#!/bin/sh\nSTEPSEMBLE_WORKFLOW_PEER_LOG=${quote(log)} STEPSEMBLE_WORKFLOW_PEER=pi exec ${quote(process.execPath)} ${quote(path.resolve("test-support/workflow-peer.cjs"))} "$@"\n`,{mode:0o700});
 const port=await freePort(),base=`http://127.0.0.1:${port}`;
 const child=spawn(process.execPath,[path.resolve("server.js")],{cwd:home,stdio:["ignore","pipe","pipe"],env:{...cleanEnvironment(home),PATH:[bin,path.dirname(process.execPath),"/usr/bin","/bin"].join(":"),PI_HOME:home,PI_BIN:path.join(bin,"pi"),STEPSEMBLE_HOST:"127.0.0.1",STEPSEMBLE_PORT:String(port),STEPSEMBLE_ORPHAN_EXIT:"0",STEPSEMBLE_TOKEN:"owned-compaction-only",STEPSEMBLE_WORKSPACE_KEYCHAIN_USAGE:"0"}});
 let stderr="";child.stderr.on("data",b=>stderr+=b);t.after(async()=>{await stopServer(child);await fs.rm(home,{recursive:true,force:true});});await waitForServer(child);child.stdout.resume();
 let cookie="";
 const request=async(route,body,origin=base)=>{const response=await fetch(base+route,{method:body===undefined?"GET":"POST",headers:{Cookie:cookie,Origin:origin,...(body===undefined?{}:{"Content-Type":"application/json"})},...(body===undefined?{}:{body:JSON.stringify(body)})});return {status:response.status,headers:response.headers,data:response.status===204?null:await response.json()};};
 assert.equal((await request("/api/agent/compaction?entry="+randomUUID())).status,401);
 const login=await request("/api/login",{token:"owned-compaction-only"});cookie=login.headers.get("set-cookie").split(";",1)[0];
 const opened=await request("/api/agent/open",{agentId:"pi",cwd:home,name:"Compaction owned test"});assert.equal(opened.status,200,stderr);
 const entry=opened.data.workspaceEntry.key,sid=opened.data.sid,query="/api/agent/compaction?entry="+entry;
 const ready=await request(query);assert.equal(ready.status,200);assert.equal(ready.data.supported,true);assert.equal(ready.data.operation,null);
 assert.equal((await request("/api/agent/compaction",{entry,requestId:randomUUID()},"https://foreign.invalid")).status,403);
 assert.equal((await request("/api/agent/compaction",{entry:randomUUID(),requestId:randomUUID()})).status,404);
 const input={entry,requestId:randomUUID(),instructions:"SLOW keep current decisions"},started=await request("/api/agent/compaction",input);
 assert.equal(started.status,202);assert.equal(started.data.operation.status,"running");
 const duplicate=await request("/api/agent/compaction",input);assert.equal(duplicate.data.operation.id,started.data.operation.id);
 assert.equal((await request("/api/send",{sid,message:"must not interleave"})).status,409);
 assert.equal((await request("/api/agent/compaction",{...input,requestId:randomUUID()})).status,409);
 let state;
 for(let i=0;i<60;i++){state=await request(query);if(state.data.operation?.status!=="running")break;await sleep(100);}
 assert.equal(state.data.operation.status,"completed",JSON.stringify(state.data));assert.equal(state.data.operation.beforeTokens,3000);assert.equal(state.data.operation.afterTokens,1000);assert.equal(state.data.operation.estimated,true);
 const membership=await request("/api/workspace/entry?key="+entry);assert.equal(membership.data.record.sid,sid);assert.equal(membership.data.record.cwd,home);
 const commands=(await fs.readFile(log,"utf8")).trim().split("\n").map(line=>JSON.parse(line).command);assert.equal(commands.filter(c=>c.type==="compact").length,1);assert.equal(commands.filter(c=>c.type==="prompt").length,0);
 assert.equal(commands.find(c=>c.type==="compact").customInstructions,input.instructions);
});
