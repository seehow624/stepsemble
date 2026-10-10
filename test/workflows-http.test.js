"use strict";
const test=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs/promises"),path=require("node:path"),os=require("node:os"),{spawn}=require("node:child_process");
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
test("authenticated Host Goals complete across Pi, Claude and ACP without a browser; stop, locks and schedules persist",async t=>{
  if(process.platform==="win32"){t.skip("POSIX executable protocol fixtures");return;}
  const {cleanEnvironment}=await import("../scripts/check-rolling-clients.mjs");const {freePort,waitForServer,stopServer}=await import("../scripts/host-performance-baseline.mjs");
  const home=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),"stepsemble-goals-http-"))),bin=path.join(home,"bin");await fs.mkdir(bin);
  const quote=s=>"'"+s.replaceAll("'","'\\''")+"'";
  for(const [name,mode] of [["pi","pi"],["claude","claude"],["omp","acp"],["hermes","acp"],["kilo","acp"],["cline","acp"],["grok","acp"]])await fs.writeFile(path.join(bin,name),`#!/bin/sh\nSTEPSEMBLE_WORKFLOW_PEER=${mode} exec ${quote(process.execPath)} ${quote(path.resolve("test-support/workflow-peer.cjs"))} "$@"\n`,{mode:0o700});
  const sessions=new Map();
  const upstream=require("node:http").createServer((req,res)=>{
    let raw="";req.on("data",b=>raw+=b);req.on("end",()=>{
      const u=new URL(req.url,"http://local"),p=u.pathname,body=raw?JSON.parse(raw):{};
      const json=value=>{res.setHeader("Content-Type","application/json");res.end(JSON.stringify(value));};
      if(p==="/global/health")return json({healthy:true,version:"2.0.0"});
      if(p==="/permission")return json([]);
      if(p==="/session/status")return json(Object.fromEntries([...sessions].map(([id,s])=>[id,{type:s.busy?"busy":"idle"}])));
      if(p==="/session"&&req.method==="GET")return json([...sessions.values()].map(s=>s.info));
      if(p==="/session"&&req.method==="POST"){const id="s"+(sessions.size+1),info={id,title:body.title,directory:u.searchParams.get("directory"),time:{created:Date.now()}};sessions.set(id,{info,messages:[],busy:false});return json(info);}
      const m=p.match(/^\/session\/(s\d+)(?:\/(message|prompt_async|abort))?$/),session=m&&sessions.get(m[1]);
      if(session){
        if(!m[2])return json(session.info);
        if(m[2]==="message")return json(session.messages);
        if(m[2]==="abort"){session.busy=false;return json(true);}
        if(m[2]==="prompt_async"){
          const prompt=body.parts.map(p=>p.text||"").join("\n"),marker=prompt.match(/\[\[STEPSEMBLE_GOAL:[a-f0-9-]+:complete\]\]/)?.[0];
          const text=session.messages.length?"Verified.\n"+marker:"First part done";
          session.messages.push({info:{id:"m"+session.messages.length,sessionID:m[1],role:"assistant",time:{created:Date.now(),completed:Date.now()},tokens:{output:120}},parts:[{type:"text",text}]});
          return json({});
        }
      }
      res.statusCode=404;json({error:"not found"});
    });
  });
  await new Promise(resolve=>upstream.listen(0,"127.0.0.1",resolve));t.after(()=>{upstream.closeAllConnections();upstream.close();});
  const port=await freePort(),base=`http://127.0.0.1:${port}`;
  const child=spawn(process.execPath,[path.resolve("server.js")],{cwd:home,stdio:["ignore","pipe","pipe"],env:{...cleanEnvironment(home),PATH:[bin,path.dirname(process.execPath),"/usr/bin","/bin"].join(":"),PI_HOME:home,PI_BIN:path.join(bin,"pi"),STEPSEMBLE_HOST:"127.0.0.1",STEPSEMBLE_PORT:String(port),STEPSEMBLE_ORPHAN_EXIT:"0",STEPSEMBLE_TOKEN:"workflow-local-only",STEPSEMBLE_CLAUDE_STRUCTURED:"1",STEPSEMBLE_OPENCODE_SERVER_URL:`http://127.0.0.1:${upstream.address().port}`,STEPSEMBLE_WORKSPACE_KEYCHAIN_USAGE:"0"}});
  let output="";child.stderr.on("data",b=>output+=b);t.after(async()=>{await stopServer(child);await fs.rm(home,{recursive:true,force:true});});await waitForServer(child);child.stdout.resume();
  let cookie="";const request=(route,body,origin=base)=>fetch(base+route,{headers:{Cookie:cookie,Origin:origin,...(body?{"Content-Type":"application/json"}:{})},...(body?{method:"POST",body:JSON.stringify(body)}:{})});
  const json=async(route,body)=>{const res=await request(route,body);const data=await res.json();assert(res.ok,JSON.stringify(data)+output);return data;};
  assert.equal((await request("/api/workflows")).status,401);const login=await request("/api/login",{token:"workflow-local-only"});cookie=login.headers.get("set-cookie").split(";",1)[0];
  const config={title:"Offline Goal",objective:"TWO_TURNS verify the implementation",cwd:home,limits:{minutes:1,turns:3}};
  assert.equal((await request("/api/workflows",{...config,agentId:"pi"},"https://foreign.invalid")).status,403);
  const until=async(id,status)=>{for(let i=0;i<100;i++){const row=(await json("/api/workflows")).runs.find(r=>r.id===id);if(status.includes(row.status))return row;await sleep(100);}throw new Error("Workflow timeout: "+JSON.stringify(await json("/api/workflows"))+output);};
  let piEntry;
  for(const agentId of ["pi","claude-code","omp","hermes","kilo","cline","grok-build","opencode"]){
    const created=await json("/api/workflows",{...config,agentId});const done=await until(created.id,["completed","failed","limited"]);assert.equal(done.status,"completed",agentId+JSON.stringify(done));assert.equal(done.turns,2,agentId);assert(done.entry);if(agentId==="pi")piEntry=done.entry;assert(!done.result.includes("STEPSEMBLE_GOAL"));
  }
  // /goal sends only its existing entry; the Host resolves agent and folder.
  const inline=require("../public/modules/goal-composer.js").createRequest({entry:piEntry,text:"/goal Verify the current conversation",limits:{minutes:1,turns:3,outputTokens:1000},requestId:require("node:crypto").randomUUID()});
  const inlineRun=await json("/api/workflows",inline);
  assert.equal(inlineRun.entry,piEntry);assert.equal(inlineRun.agentId,"pi");assert.equal(inlineRun.cwd,home);
  const inlineDone=await until(inlineRun.id,["completed","failed"]);assert.equal(inlineDone.status,"completed");
  assert.equal((await json("/api/workflows",inline)).id,inlineRun.id,"retry must not create another Goal");
  const slow=await json("/api/workflows",{...config,agentId:"pi",objective:"SLOW task"});const busy=await until(slow.id,["running"]);
  const record=(await json("/api/workspace/entry?key="+busy.entry)).record;assert.equal((await request("/api/send",{sid:record.sid,message:"interleaving"})).status,409);
  await json("/api/workflows",{id:slow.id,action:"pause"});const paused=await until(slow.id,["paused"]);assert.equal(paused.status,"paused");
  const schedule=await json("/api/workflows",{...config,agentId:"pi",kind:"schedule",mode:"task",schedule:{kind:"once",at:new Date(Date.now()+1500).toISOString()}});
  await sleep(2800);const state=await json("/api/workflows");const run=state.runs.find(r=>r.scheduleId===schedule.id);assert(run);const done=await until(run.id,["completed","failed"]);assert.equal(done.status,"completed");assert.equal(done.turns,1);
  const saved=JSON.parse(await fs.readFile(path.join(home,".config/stepsemble/workflows.json"),"utf8"));assert.equal(saved.schedules.find(s=>s.id===schedule.id).enabled,false);assert.equal(saved.runs.filter(r=>r.scheduleId===schedule.id).length,1);
});
