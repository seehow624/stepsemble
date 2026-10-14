"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { summarizeRecent } = require("../server/recent-usage");
const { createHostOutputRates } = require("../server/host-output-rates");
const M = require("../public/modules/menubar-data");
test("activity worker reads unregistered history without pricing or prompt output", async t => {
  const fs = require("node:fs/promises"), os = require("node:os"), path = require("node:path");
  const { report } = require("../server/usage-analytics-worker");
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "stepsemble-activity-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const root = path.join(home, ".pi/agent/sessions"), at = Date.now(), id = "11111111-1111-4111-8111-111111111111";
  await fs.mkdir(root, { recursive: true });
  await fs.writeFile(path.join(root,id+".jsonl"), [{type:"session",id}, {type:"message",id:"m",timestamp:at,message:{role:"assistant",content:"private text",model:"test",usage:{input:100,output:60,cacheRead:20,cacheWrite:0}}}].map(JSON.stringify).join("\n")+"\n");
  const result=await report({home,roots:{},entries:[],query:{},kind:"activity",at});
  assert.equal(result.available,true);assert.equal(result.output,60);assert.equal(result.tokensPerSecond,1);assert.equal(JSON.stringify(result).includes("private text"),false);
});
test("machine activity counts only recent precise output and keeps burn separate", () => {
  const at=100000, row=(at,extra={})=>({at,tokens:{input:1000,output:120,cacheRead:2000,cacheWrite:0},agent:"pi",...extra});
  const result=summarizeRecent([row(at),row(at-59999),row(at-60000),row(at+1),row(at,{dateApproximate:true})],at);
  assert.equal(result.output,240);assert.equal(result.tokensPerSecond,4);assert.equal(result.tokensPerMinute,6240);assert.equal(result.calls,2);
});
test("live output excludes finished, waiting and stale runs without exposing sessions", () => {
  let now=10000;const host=createHostOutputRates({entries:()=>[],store:{recordHost(){}},now:()=>now});
  host.pi("private-session",{type:"agent_start"});now+=1000;
  host.pi("private-session",{type:"message_update",assistantMessageEvent:{type:"text_delta",delta:"hello world"}});
  assert(host.live().tokensPerSecond>0);assert.equal(JSON.stringify(host.live()).includes("private-session"),false);
  host.pi("private-session",{type:"tool_execution_start",toolCallId:"tool"});assert.equal(host.live().tokensPerSecond,0);
  host.pi("private-session",{type:"tool_execution_end",toolCallId:"tool"});now+=6000;assert.equal(host.live().tokensPerSecond,0);
  host.pi("private-session",{type:"agent_settled"});assert.equal(host.live().active,0);
});
test("Codex cached average does not keep the menu cat spinning after output stops", () => {
  let now=10000;const host=createHostOutputRates({entries:()=>[],store:{recordHost(){}},now:()=>now});
  host.codex({type:"turn.started",threadId:"thread",turnId:"turn"});now+=1000;
  host.codex({type:"thread.tokenUsage.updated",threadId:"thread",turnId:"turn",tokenUsage:{total:{outputTokens:100},last:{outputTokens:100}}});
  assert.equal(host.live().tokensPerSecond,100);assert.equal(host.live().averaged,true);
  now+=6000;assert.equal(host.live().tokensPerSecond,0);
});
test("menu combines Hosts without adding live and historical output twice", () => {
  const live={live:{tokensPerSecond:20,active:1,estimated:true},history:{available:true,tokensPerSecond:5,tokensPerMinute:500}};
  let value=M.activity([live,live]);assert.equal(value.rate,40);assert.equal(value.tokensPerMinute,1000);assert.equal(value.source,"live");
  value=M.activity([{history:live.history},null]);assert.equal(value.rate,5);assert.equal(value.partial,true);assert.equal(value.source,"history");
  value=M.activity([{live:{active:1,tokensPerSecond:0},history:live.history}]);assert.equal(value.rate,5);assert.equal(value.source,"history");
  value=M.activity([{history:live.history,historyAgeMs:45000}]);assert.equal(value.rate,null);assert.equal(value.source,"unknown");
  assert.equal(M.badge("hidden",null,[]),"");
});

test("a waiting Host never suppresses another computer or external agent; cached input drives motion independently", () => {
  const waiting={live:{active:1,tokensPerSecond:0},history:{available:true,tokensPerSecond:0,tokensPerMinute:0}};
  const external={live:{active:0,tokensPerSecond:0},history:{available:true,tokensPerSecond:48,tokensPerMinute:3600000,agents:[{agent:"codex",output:2880}]}};
  const value=M.activity([waiting,external]);
  assert.equal(value.rate,48);assert.equal(value.tokensPerMinute,3600000);assert.equal(value.motionRate,3600);
  assert.deepEqual(value.agents,["codex"]);assert.equal(value.estimated,true);
  const mixed=M.activity([{live:{active:1,tokensPerSecond:80}},external]);
  assert.equal(mixed.rate,128);assert.equal(mixed.source,"mixed");
  const stale=M.activity([{...external,historyAgeMs:45000}]);
  assert.equal(stale.motionRate,0);assert.equal(stale.tokensPerMinute,null);
  assert.equal(M.activity([waiting]).motionRate,4);assert.equal(M.activity([]).motionRate,0);
});
test("whole-machine sampling continues while pricing is blocked and follows external log appends", async t => {
  const fs=require("node:fs/promises"),os=require("node:os"),path=require("node:path");
  const {createUsageAnalytics}=require("../server/usage-analytics");
  const home=await fs.mkdtemp(path.join(os.tmpdir(),"stepsemble-live-machine-")),id="11111111-1111-4111-8111-111111111111";
  let at=Date.now(),release;
  const gate=new Promise(resolve=>release=resolve),file=path.join(home,".pi/agent/sessions",id+".jsonl");
  await fs.mkdir(path.dirname(file),{recursive:true});
  await fs.writeFile(file,JSON.stringify({type:"session",id})+"\n");
  const service=createUsageAnalytics({home,entries:()=>[],now:()=>at,pricing:{read:async()=>{await gate;return {models:{}};}}});
  t.after(async()=>{release();await service.shutdown();await fs.rm(home,{recursive:true,force:true});});
  const query={from:at-60000,to:at+60000,timeZone:"UTC"};let reportDone=false;
  const pending=service.read(query).then(()=>{reportDone=true;});
  const until=async predicate=>{const end=Date.now()+10000;while(Date.now()<end){const value=service.recent();if(predicate(value))return value;await new Promise(r=>setTimeout(r,20));}throw new Error("activity snapshot timed out");};
  await until(value=>value?.available);assert.equal(reportDone,false);
  at+=6000;
  await fs.appendFile(file,JSON.stringify({type:"message",id:"external",timestamp:at,message:{role:"assistant",model:"test",usage:{input:1000,output:600,cacheRead:10000,cacheWrite:0}}})+"\n");
  const recent=await until(value=>value?.output===600);
  assert.equal(recent.tokensPerMinute,11600);assert.equal(reportDone,false);assert.equal(recent.coverage.covered,1);
  at+=61000;const quiet=await until(value=>value?.at===at);assert.equal(quiet.output,0);
  release();await pending;
});
test("recent activity follows SQLite WAL writes even when the database mtime is old", async t => {
  const fs=require("node:fs/promises"),os=require("node:os"),path=require("node:path"),{DatabaseSync}=require("node:sqlite");
  const {report}=require("../server/usage-analytics-worker");
  const home=await fs.mkdtemp(path.join(os.tmpdir(),"stepsemble-activity-wal-")),folder=path.join(home,".local/share/opencode");
  await fs.mkdir(folder,{recursive:true});const file=path.join(folder,"opencode.db"),db=new DatabaseSync(file),at=Date.now();
  t.after(async()=>{db.close();await fs.rm(home,{recursive:true,force:true,maxRetries:5,retryDelay:20});});
  db.exec("PRAGMA journal_mode=WAL; CREATE TABLE message(id TEXT,session_id TEXT,data TEXT)");
  db.prepare("INSERT INTO message VALUES(?,?,?)").run("a","outside",JSON.stringify({role:"assistant",modelID:"test",providerID:"test",time:{created:at,completed:at},tokens:{input:100,output:600,cache:{read:200,write:0}}}));
  await fs.utimes(file,new Date(at-3600000),new Date(at-3600000));
  const result=await report({home,entries:[],query:{},kind:"activity",at});
  assert.equal(result.output,600);assert.equal(result.tokensPerMinute,900);assert.equal(result.coverage.covered,1);
});
test("recent linked histories use target timestamps and skip cold archives", {skip:process.platform==="win32"}, async t => {
  const fs=require("node:fs/promises"),os=require("node:os"),path=require("node:path"),{report}=require("../server/usage-analytics-worker");
  const home=await fs.mkdtemp(path.join(os.tmpdir(),"stepsemble-activity-links-")),folder=path.join(home,".codex/sessions"),at=Date.now();
  t.after(()=>fs.rm(home,{recursive:true,force:true}));await fs.mkdir(folder,{recursive:true});
  for(const [index,id] of ["11111111-1111-4111-8111-111111111111","22222222-2222-4222-8222-222222222222"].entries()) {
    const file=path.join(home,id+".jsonl"),link=path.join(folder,id+".jsonl"),stamp=index?at-3600000:at;
    const usage={input_tokens:100,output_tokens:60,cached_input_tokens:0,reasoning_output_tokens:0};
    await fs.writeFile(file,[{type:"session_meta",payload:{id}},{type:"event_msg",timestamp:new Date(stamp).toISOString(),payload:{type:"token_count",info:{total_token_usage:usage,last_token_usage:usage}}}].map(JSON.stringify).join("\n")+"\n");
    await fs.symlink(file,link);await fs.utimes(file,new Date(stamp),new Date(stamp));
    if(!index)await fs.lutimes(link,new Date(at-3600000),new Date(at-3600000));
  }
  const value=await report({home,entries:[],query:{},kind:"activity",at});
  assert.equal(value.coverage.covered,1);assert.equal(value.output,60);
});
