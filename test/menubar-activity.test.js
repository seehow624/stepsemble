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
  value=M.activity([{live:{active:1,tokensPerSecond:0},history:live.history}]);assert.equal(value.rate,0);assert.equal(value.source,"waiting");
  value=M.activity([{history:live.history,historyAgeMs:45000}]);assert.equal(value.rate,null);assert.equal(value.source,"unknown");
  assert.equal(M.badge("hidden",null,[]),"");
});
