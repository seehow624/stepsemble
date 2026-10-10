"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
const ui = require("../public/modules/workflows-ui.js");
const i18n = require("../public/modules/workflows-i18n.js");
const source = fs.readFileSync(path.join(__dirname,"../public/modules/workflows-ui.js"),"utf8");
const clone = value => JSON.parse(JSON.stringify(value));
const flush = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve,reject; const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject}; };
const limits = {minutes:60,turns:20,outputTokens:100000};
const run = (id="goal-1",status="running") => ({id,title:"Ship the page",objective:"Verify keyboard access",agentId:"pi",cwd:"/demo/Website",mode:"goal",status,elapsedMs:60000,turns:2,outputTokens:2000,limits,activity:"thinking",createdAt:1,updatedAt:1,result:"",entry:"entry-1"});
const schedule = (id="schedule-1") => ({...run(id),status:undefined,enabled:true,schedule:{kind:"weekly",time:"09:00",timeZone:"Asia/Taipei",days:[1,3,5]},nextAt:1700003600000,lastRunId:null,mode:"task"});

// Run the real controller without a browser or provider. Layout and keyboard
// routing are verified separately in the browser; this adapter models DOM
// focus, form validation, option selection and event handlers used here.
function dom() {
  const document={documentElement:{lang:"en"},activeElement:null};
  class Element {
    constructor(tag){this.tagName=tag;this.children=[];this.dataset={};this.style={};this.attrs={};this.events={};this.disabled=false;this.hidden=false;this._value="";this._text="";this.scrollTop=0;}
    set textContent(value){this._text=String(value);this.replaceChildren();}
    get textContent(){return this._text+this.children.map(child=>child.textContent).join("");}
    set value(value){const next=String(value??"");this._value=this.tagName==="select"&&!this.children.some(option=>option.value===next)?"":next;}
    get value(){return this._value;}
    get options(){return this.children;}
    append(...nodes){for(const node of nodes){node.parentElement=this;this.children.push(node);}}
    appendChild(node){this.append(node);return node;}
    replaceChildren(...nodes){if(this.contains(document.activeElement))document.activeElement=document.body;this.children=[];this.append(...nodes);}
    setAttribute(key,value){this.attrs[key]=String(value);}
    getAttribute(key){return this.attrs[key]??null;}
    addEventListener(key,fn){(this.events[key]||=[]).push(fn);}
    dispatchEvent(event){this["on"+event.type]?.(event);for(const fn of this.events[event.type]||[])fn(event);}
    all(){return this.children.flatMap(node=>[node,...node.all()]);}
    contains(node){return this===node||this.all().includes(node);}
    querySelectorAll(selector){return this.all().filter(node=>selector.split(",").some(part=>{
      part=part.trim();if(part==="details[open]")return node.tagName==="details"&&node.open;
      if(part.startsWith("."))return (node.className||"").split(" ").includes(part.slice(1));
      const attr=part.match(/^\[data-([\w-]+)(?:=([^\]]+))?\]$/);
      if(attr){const key=attr[1].replace(/-([a-z])/g,(_,c)=>c.toUpperCase());return Object.hasOwn(node.dataset,key)&&(!attr[2]||node.dataset[key]===attr[2]);}
      return node.tagName===part;
    }));}
    querySelector(selector){return this.querySelectorAll(selector)[0]||null;}
    focus(){document.activeElement=this;}
    async click(){if(!this.disabled)return this.onclick?.();}
    showModal(){this.open=true;}
    close(){this.open=false;}
    remove(){if(this.parentElement)this.parentElement.children=this.parentElement.children.filter(node=>node!==this);}
    checkValidity(){if(this.disabled)return true;if(this.required&&!this.value)return false;if(this.type==="number")return Number.isSafeInteger(Number(this.value))&&Number(this.value)>=Number(this.min)&&Number(this.value)<=Number(this.max);return true;}
    reportValidity(){return this.querySelectorAll("input,select,textarea").every(node=>node.checkValidity());}
  }
  document.body=new Element("body");document.activeElement=document.body;document.createElement=tag=>new Element(tag);
  return document;
}
async function harness({runs=[run()],schedules=[],mobile=false,crypto}={}) {
  const doc=dom(),timers=new Map();let timerId=0,uuid=0;
  const h={doc,runs:clone(runs),schedules:clone(schedules),posts:[],changed:0,opened:[],now:1700000000000,available:true};
  const root={document:doc,StepsembleWorkflowI18n:i18n,crypto:crypto||{randomUUID:()=>"request-"+(++uuid)},confirm:()=>true,
    Event:class{constructor(type){this.type=type;}},dispatchEvent(){},matchMedia:()=>({matches:mobile}),
    setTimeout(fn,ms){timers.set(++timerId,{fn,ms,interval:false});return timerId;},clearTimeout(id){timers.delete(id);},
    setInterval(fn,ms){timers.set(++timerId,{fn,ms,interval:true});return timerId;},clearInterval(id){timers.delete(id);}};
  vm.runInNewContext(source,{window:root,Date:class extends Date{static now(){return h.now;}},Intl,Uint8Array});
  h.controller=root.StepsembleWorkflows.create({
    context:async target=>({target:target||"host-1",hostName:"Fixture",projects:["/demo/Website","/demo/API"],entries:[{key:"entry-1",record:{agentId:"pi",cwd:"/demo/Website"}}]}),
    onChanged(){h.changed++;},openConversation(...args){h.opened.push(args);},
    api:async(route,body,target)=>{
      if(route==="/api/agents")return h.agentsImpl?h.agentsImpl():{connectors:[{id:"pi",installed:true},{id:"codex",installed:true},{id:"antigravity",installed:true},{id:"hermes",installed:false}]};
      if(!body)return h.readImpl?h.readImpl():{available:h.available,runs:clone(h.runs),schedules:clone(h.schedules)};
      h.posts.push({body:clone(body),target});if(h.postImpl)return h.postImpl(body);
      if(body.action){const row=[...h.runs,...h.schedules].find(item=>item.id===body.id);if(row.schedule){if(body.action==="pause")row.enabled=false;else if(body.action==="resume")row.enabled=true;else if(body.action==="edit")Object.assign(row,body);else if(body.action==="delete")h.schedules=h.schedules.filter(item=>item.id!==row.id);}else row.status={pause:"paused",resume:"running",stop:"stopped"}[body.action];return clone(row);}
      const row={...run("created-"+h.posts.length),...body};if(body.kind==="schedule"){row.enabled=true;h.schedules.push(row);}else h.runs.push(row);return clone(row);
    }
  });
  h.find=selector=>doc.body.querySelector(selector);
  h.byKey=key=>doc.body.querySelectorAll("[data-focus]").find(node=>node.dataset.focus===key);
  h.field=name=>doc.body.querySelectorAll("input,select,textarea").find(node=>node.name===name);
  h.input=(name,value)=>{const field=h.field(name);field.value=value;field.dispatchEvent(new root.Event("change"));h.find("form").dispatchEvent(new root.Event("input"));};
  h.submit=()=>h.find("form").onsubmit({preventDefault(){}});
  h.tick=async ms=>{const entry=[...timers.entries()].find(([,value])=>value.ms===ms);if(entry){if(!entry[1].interval)timers.delete(entry[0]);await entry[1].fn();}};
  h.close=()=>{h.controller.close();assert.equal(timers.size,0);};
  await h.controller.open();return h;
}
test("Goals and Schedules share one stable New button with a contextual accessible name", async () => {
  const h = await harness(); const add = h.byKey("new");
  assert.equal(add.textContent, "+ New"); assert.equal(add.getAttribute("aria-label"), "New Goal");
  await h.byKey("tab:schedules").click();
  assert.equal(h.byKey("new"), add); assert.equal(add.textContent, "+ New"); assert.equal(add.getAttribute("aria-label"), "New schedule");
  h.close();
});

test("the Host clock advances only active work; paused, queued and terminal clocks are fixed",()=>{
  assert.equal(ui.duration(754000),"12:34");assert.equal(ui.duration(3602000),"1:00:02");
  for(const status of ["starting","running","waiting"])assert.equal(ui.elapsed(run("g",status),1000,4000),63000);
  for(const status of ["queued","stopping","paused","completed","failed"])assert.equal(ui.elapsed(run("g",status),1000,4000),60000);
});

test("schedule validation catches empty weekdays, past dates and invalid zones before sending",()=>{
  const input={limits,schedule:{kind:"weekly",days:[],timeZone:"Asia/Taipei"}};
  assert.equal(ui.validate(input),"workflows.chooseDays");
  input.schedule={kind:"once",at:"2000-01-01"};assert.equal(ui.validate(input),"workflows.futureDate");
  input.schedule={kind:"daily",timeZone:"Not/AZone"};assert.equal(ui.validate(input),"workflows.invalidZone");
  input.schedule={kind:"weekly",timeZone:"Asia/Taipei",days:[1]};assert.equal(ui.validate(input),null);
  assert.equal(ui.validate({...input,limits:{...limits,turns:1.5}}),"goalComposer.limitsError");
  assert.equal(ui.scheduleState({...schedule(),enabled:false,nextAt:null,lastRunId:"done",schedule:{kind:"once"}}),"finished");
});

test("workflow chrome is complete in all 11 locales without rewriting arbitrary text",()=>{
  const keys=Object.keys(i18n.tables.en);
  const fallback=source.split("const en = {",2)[1].split("\n  };",1)[0];
  for(const match of fallback.matchAll(/\b([A-Za-z]+):\s*"/g))assert.ok(i18n.tables.en[match[1]],"localize "+match[1]);
  for(const locale of i18n.locales){assert.deepEqual(Object.keys(i18n.tables[locale]),keys);for(const key of keys){assert.ok(i18n.tables[locale][key]);assert.deepEqual([...i18n.tables[locale][key].matchAll(/\{(\w+)\}/g)].map(m=>m[1]).sort(),[...i18n.tables.en[key].matchAll(/\{(\w+)\}/g)].map(m=>m[1]).sort());}}
  assert.equal(i18n.t("User objective from host",{},"zh-Hant"),"User objective from host");
  assert.equal(i18n.t("everyMinutes",{minutes:30},"zh-Hant"),"每 30 分鐘");
  for(const name of ["index.html","workspace.html","sw.js"])assert.match(fs.readFileSync(path.join(__dirname,"../public",name),"utf8"),/modules\/workflows-i18n\.js/);
});

test("Goals filter out scheduled one-turn tasks and search keeps the user's focus",async()=>{
  const h=await harness({runs:[run(),run("blocked","blocked"),{...run("scheduled"),mode:"task"}]});
  assert.equal(h.find(".wf-list").querySelectorAll("button").length,2);
  await h.byKey("filter:attention").click();assert.equal(h.find(".wf-list").querySelectorAll("button").length,1);
  const search=h.find(".wf-search");search.focus();search.value="no match";search.oninput();
  assert.equal(h.doc.activeElement,search);assert.match(h.find(".wf-list").textContent,/No matching tasks/);h.close();
});

test("clock polling preserves selection, focused controls and expanded project details",async()=>{
  const h=await harness();const pause=h.byKey("goal-1:pause"),project=h.find("details");project.open=true;pause.focus();
  h.now+=1000;await h.tick(1000);assert.equal(h.find(".wf-timer").textContent,"01:01");
  await h.tick(4000);assert.equal(h.byKey("goal-1:pause"),pause);assert.equal(h.doc.activeElement,pause);
  h.runs[0].outputTokens=4000;await h.tick(4000);assert.equal(h.find("details").open,true);assert.equal(h.doc.activeElement,h.byKey("goal-1:pause"));h.close();
});

test("an older poll cannot replace an acknowledged pause; the displayed clock then freezes",async()=>{
  const h=await harness(),pending=deferred();let reads=0;
  h.readImpl=()=>++reads===1?pending.promise:{available:true,runs:clone(h.runs),schedules:[]};
  const polling=h.tick(4000);await flush();await h.byKey("goal-1:pause").click();
  pending.resolve({available:true,runs:[run()],schedules:[]});await polling;
  assert.ok(h.byKey("goal-1:resume"));assert.equal(h.byKey("goal-1:pause"),undefined);
  const before=h.find(".wf-timer").textContent;h.now+=10000;await h.tick(1000);assert.equal(h.find(".wf-timer").textContent,before);h.close();
});

test("disconnection freezes elapsed and reconnecting resumes authoritative Host time",async()=>{
  const h=await harness();h.now+=2000;h.readImpl=()=>{throw Error("offline");};await h.tick(4000);
  const before=h.find(".wf-timer").textContent;h.now+=20000;await h.tick(1000);assert.equal(h.find(".wf-timer").textContent,before);
  h.readImpl=null;h.runs[0].elapsedMs=90000;await h.tick(4000);assert.equal(h.find(".wf-timer").textContent,"01:30");h.close();
});

test("late mutations from an old Host do not alter a newly opened panel",async()=>{
  const h=await harness(),pending=deferred();h.postImpl=()=>pending.promise;
  const action=h.byKey("goal-1:pause").click();await flush();h.runs=[run("new-host")];await h.controller.open("goals","host-2");
  pending.resolve(run("goal-1","paused"));await action;
  assert.equal(h.changed,0);assert.ok(h.byKey("new-host:pause"));assert.equal(h.posts[0].target,"host-1");h.close();
});

test("an editor survives a pending poll and unavailable agent selection can be changed explicitly",async()=>{
  const h=await harness({schedules:[{...schedule(),agentId:"hermes"}]}),pending=deferred();h.readImpl=()=>pending.promise;
  const polling=h.tick(4000);await flush();await h.byKey("tab:schedules").click();await h.byKey("schedule-1:edit").click();
  h.input("title","Unsent draft");assert.equal(h.find("form").querySelectorAll("button").at(-1).disabled,true);
  h.input("agent","codex");assert.equal(h.find("form").querySelectorAll("button").at(-1).disabled,false);
  pending.resolve({available:true,runs:[],schedules:[]});await polling;assert.equal(h.field("title").value,"Unsent draft");h.close();
});

test("duplicate submissions are guarded, drafts survive uncertain replies, and retries reuse the same ID",async()=>{
  const h=await harness(),pending=deferred();await h.byKey("new").click();h.input("objectivePrompt","Ship and verify\nKeep the second line");h.input("minutes","30");
  h.postImpl=()=>pending.promise;const sending=h.submit();await h.submit();assert.equal(h.posts.length,1);
  pending.reject(Error("response lost"));await sending;assert.equal(h.field("objectivePrompt").value,"Ship and verify\nKeep the second line");
  const first=h.posts[0].body;h.postImpl=null;await h.submit();assert.equal(h.posts[1].body.requestId,first.requestId);assert.equal(first.title,"Ship and verify");assert.equal(first.limits.minutes,30);
  assert.ok(h.byKey("created-2:pause"));h.close();
});

test("editing a paused weekly schedule preserves its state, timezone, mode and exact weekdays",async()=>{
  const h=await harness({schedules:[{...schedule(),enabled:false}]});await h.byKey("tab:schedules").click();await h.byKey("schedule-1:edit").click();
  h.input("mode","goal");h.input("time","18:30");h.input("timeZone","Europe/Berlin");await h.submit();
  const sent=h.posts[0].body;assert.equal(sent.action,"edit");assert.equal(sent.enabled,false);assert.equal(sent.mode,"goal");assert.deepEqual(sent.schedule.days,[1,3,5]);assert.equal(sent.schedule.timeZone,"Europe/Berlin");assert.equal(sent.schedule.time,"18:30");h.close();
});

test("a running schedule cannot be manually launched twice; selected history keeps its own result",async()=>{
  const h=await harness({runs:[{...run("running-history"),scheduleId:"schedule-1",mode:"task"},{...run("old-history","completed"),scheduleId:"schedule-1",mode:"task",createdAt:0,result:"Previous result"}],schedules:[schedule()]});
  await h.byKey("tab:schedules").click();assert.equal(h.byKey("schedule-1:run").disabled,true);await h.byKey("schedule-1:run").click();assert.equal(h.posts.length,0);
  await h.byKey("history:old-history").click();assert.match(h.find(".wf-result").textContent,/Previous result/);await h.tick(4000);assert.match(h.find(".wf-result").textContent,/Previous result/);h.close();
});

test("mobile opens detail with focus on Back and returns focus to the selected row",async()=>{
  const h=await harness({mobile:true});await h.byKey("row:goal-1").click();assert.equal(h.find("dialog").dataset.screen,"detail");assert.equal(h.doc.activeElement,h.byKey("detail-back"));
  await h.byKey("detail-back").click();assert.equal(h.find("dialog").dataset.screen,"list");assert.equal(h.doc.activeElement,h.byKey("row:goal-1"));h.close();
});

test("private-network HTTP can create an idempotent UUID without crypto.randomUUID",async()=>{
  const h=await harness({crypto:{getRandomValues(bytes){bytes.fill(123);return bytes;}}});await h.byKey("new").click();h.input("objectivePrompt","Verify HTTP mobile");await h.submit();
  assert.match(h.posts[0].body.requestId,/^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/);h.close();
});

test("switching locale refreshes chrome while retaining the exact objective and result",async()=>{
  const h=await harness();h.doc.documentElement.lang="zh-Hant";await h.tick(4000);
  assert.equal(h.byKey("tab:schedules").textContent,"排程");assert.equal(h.find(".wf-objective").textContent,"Verify keyboard access");assert.equal(h.byKey("goal-1:pause").textContent,"暫停");h.close();
});

test("validation opens invalid advanced limits and rejects blank objectives without sending",async()=>{
  const h=await harness();await h.byKey("new").click();h.input("objectivePrompt","   ");await h.submit();assert.equal(h.posts.length,0);assert.match(h.find(".wf-error").textContent,/Describe an objective/);
  h.input("objectivePrompt","Check the page");h.input("turns","0");await h.submit();assert.equal(h.find("details").open,true);assert.equal(h.posts.length,0);h.close();
});

test("unavailable Hosts disable mutations and a finished once schedule offers a new time",async()=>{
  const h=await harness();h.available=false;await h.tick(4000);assert.equal(h.byKey("new").disabled,true);assert.equal(h.byKey("goal-1:pause").disabled,true);
  h.available=true;h.schedules=[{...schedule(),enabled:false,nextAt:null,lastRunId:"finished",schedule:{kind:"once",at:"2000-01-01"}}];await h.tick(4000);await h.byKey("tab:schedules").click();
  assert.equal(h.byKey("schedule-1:resume"),undefined);assert.ok(h.byKey("schedule-1:edit"));assert.match(h.find(".wf-plan").textContent,/Choose a new time/);h.close();
});

test("a late post-create refresh cannot reopen an old conversation after a Host switch",async()=>{
  const h=await harness(),pending=deferred();await h.controller.open("goals","host-1","entry-1","Check the existing entry");
  h.readImpl=()=>pending.promise;const saving=h.submit();await flush();
  h.readImpl=null;h.runs=[run("host-2-run")];await h.controller.open("goals","host-2");
  pending.resolve({available:true,runs:[run("old-host")],schedules:[]});await saving;
  assert.equal(h.opened.length,0);assert.ok(h.byKey("host-2-run:pause"));h.close();
});

test("changing daily to weekly starts with working days instead of daily's seven-day metadata",async()=>{
  const h=await harness({schedules:[{...schedule(),schedule:{kind:"daily",time:"09:00",timeZone:"Asia/Taipei",days:[0,1,2,3,4,5,6]}}]});
  await h.byKey("tab:schedules").click();await h.byKey("schedule-1:edit").click();await h.byKey("repeat:weekly").click();await h.submit();
  assert.deepEqual(h.posts[0].body.schedule.days,[1,2,3,4,5]);h.close();
});

test("keyboard focus follows Pause to Resume and back without returning to the page",async()=>{
  const h=await harness();h.byKey("goal-1:pause").focus();await h.byKey("goal-1:pause").click();assert.equal(h.doc.activeElement,h.byKey("goal-1:resume"));
  await h.byKey("goal-1:resume").click();assert.equal(h.doc.activeElement,h.byKey("goal-1:pause"));h.close();
});

test("workflow locale interpolation works in older WebKit without Object.hasOwn",()=>{
  const legacyObject=Object.create(Object);Object.defineProperty(legacyObject,"hasOwn",{value:undefined});
  const context={window:{},module:{exports:{}},Object:legacyObject};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,"../public/modules/workflows-i18n.js"),"utf8"),context);
  assert.equal(context.module.exports.t("ofLimit",{limit:100},"en"),"of 100");
  assert.equal(context.module.exports.t("dailyAt",{time:"09:00"},"zh-Hant"),"每天 · 09:00");
});
