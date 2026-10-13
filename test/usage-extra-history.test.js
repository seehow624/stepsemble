"use strict";
const test=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs/promises"),os=require("node:os"),path=require("node:path"),{DatabaseSync}=require("node:sqlite");
const R=require("../server/usage-extra-records"),H=require("../server/usage-extra-history"),{report}=require("../server/usage-analytics-worker"),{createUsageParser}=require("../server/usage-records"),D=require("../public/modules/usage-data"),M=require("../public/modules/menubar-data");
const AT=Date.parse("2026-10-13T03:00:00Z"), UUID="11111111-1111-4111-8111-111111111111";
const budget=()=>({deadline:Date.now()+15000,maxBytes:1e8,bytes:0,visited:0,limited:false});
async function fixture(t,beforeRemove=()=>{}){const home=await fs.mkdtemp(path.join(os.tmpdir(),"stepsemble-extra-"));t.after(async()=>{await beforeRemove();await fs.rm(home,{recursive:true,force:true});});return fs.realpath(home);}
async function write(file,value){await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,JSON.stringify(value));}
const msg=(id="msg1")=>({id,sessionID:"session1",role:"assistant",modelID:"claude-test",providerID:"anthropic",time:{created:AT},tokens:{input:100,output:20,reasoning:5,cache:{read:80,write:10}},cost:.1,content:"PRIVATE PROMPT MUST NOT LEAVE READER"});
const input=home=>({home,entries:[],query:{from:AT-1,to:AT+1000,timeZone:"UTC"}});

test("OpenCode and Kilo use separate identities, reasoning and cache once",()=>{
 const a=R.opencodeMessage("opencode",msg()),b=R.opencodeMessage("kilo",msg());
 assert.deepEqual(a.tokens,{input:100,output:25,cacheRead:80,cacheWrite:10});assert.notEqual(a.identity,b.identity);assert.equal(JSON.stringify(a).includes("PRIVATE"),false);
});
test("Gemini resolves cached input against the saved total and marks ambiguity",()=>{
 const parse=t=>R.geminiSession({sessionId:"g",messages:[{id:"m",type:"gemini",timestamp:AT,model:"gemini-test",tokens:t}]});
 assert.deepEqual(parse({input:100,output:20,thoughts:5,cached:80,total:125}).rows[0].tokens,{input:20,output:25,cacheRead:80,cacheWrite:0});
 assert.equal(parse({input:20,output:20,thoughts:5,cached:80,total:125}).rows[0].tokens.input,20);
 const bad=parse({input:100,output:20,cached:80,total:999});assert.equal(bad.partial,true);assert.equal(bad.rows[0].tokens.input,null);
});
test("Cline extension and CLI have different cache contracts",()=>{
 const ui=R.clineMessages("roo-code",[{type:"say",say:"api_req_started",ts:AT,text:JSON.stringify({tokensIn:20,tokensOut:10,cacheReads:80,cost:.02})}],"s");
 const cli=R.clineCli({messages:[{role:"assistant",id:"m",ts:AT,metrics:{inputTokens:100,outputTokens:10,cacheReadTokens:80,cost:.02}}]},"s");
 assert.equal(ui.rows[0].tokens.input,20);assert.equal(cli.rows[0].tokens.input,20);assert.equal(ui.rows[0].cost,.02);
});
test("OMP uses native Pi usage without conflating the two agents",()=>{
 const rows=[{type:"session",id:UUID,cwd:"/project"},{type:"message",id:"m",timestamp:AT,message:{role:"assistant",model:"m",provider:"p",usage:{input:10,output:2,cacheRead:5,cacheWrite:0}}}];
 const p=createUsageParser("pi",UUID),o=createUsageParser("omp",UUID);for(const r of rows){p.consume(r);o.consume(r);}
 assert.equal(o.result().rows.length,1);assert.notEqual(o.result().rows[0].identity,p.result().rows[0].identity);
});
test("Grok validates per-inference identity and does not add reasoning twice",()=>{
 const row={sid:"s",pid:42,ts:AT,msg:"shell.turn.inference_done",ctx:{model:"grok",loop_index:1,prompt_tokens:100,cached_prompt_tokens:80,completion_tokens:20}};
 assert.deepEqual(R.grokLog([row]).rows[0].tokens,{input:20,output:20,cacheRead:80,cacheWrite:0});
 assert.equal(R.grokLog([{...row,pid:null}]).partial,true);
});
function varint(n){const out=[];n=BigInt(n);do{let b=Number(n&127n);n>>=7n;out.push(n?b|128:b);}while(n);return Buffer.from(out);}
function proto(fields){return Buffer.concat(fields.map(([id,v])=>Buffer.isBuffer(v)||typeof v==="string"?Buffer.concat([varint(id*8+2),varint(Buffer.byteLength(v)),Buffer.from(v)]):Buffer.concat([varint(id*8),varint(v)])));}
test("Antigravity protobuf has bounded parsing, readable labels and explicit approximate dates",()=>{
 const usage=proto([[1,20],[2,30],[3,12],[5,80],[9,10],[10,2],[11,"response"]]);
 const blob=proto([[1,proto([[4,usage],[19,"claude-test"]])]]);
 const r=R.antigravityGeneration(blob,UUID,1,{started:AT});assert.equal(r.dateApproximate,true);assert.equal(r.model,"claude-test");assert.deepEqual(r.tokens,{input:50,output:12,cacheRead:80,cacheWrite:0});
 assert.equal(R.proto(Buffer.from([10,255,255,255,255,255,255,255,255,255,255,255])),null);assert.equal(R.proto(Buffer.alloc(4*1024*1024+1)),null);
});
test("machine scan reads OpenCode WAL and deduplicates legacy exports without changing the database",async t=>{
 let db;const home=await fixture(t,()=>db?.close()),folder=path.join(home,".local/share/opencode");await fs.mkdir(folder,{recursive:true});
 db=new DatabaseSync(path.join(folder,"opencode.db"));
 db.exec("PRAGMA journal_mode=WAL; CREATE TABLE session(id TEXT PRIMARY KEY,directory TEXT,title TEXT); CREATE TABLE message(id TEXT,session_id TEXT,data TEXT);");
 db.prepare("INSERT INTO session VALUES(?,?,?)").run("session1","/demo","Saved session");db.prepare("INSERT INTO message VALUES(?,?,?)").run("msg1","session1",JSON.stringify(msg()));
 await write(path.join(folder,"storage/message/session1/msg1.json"),msg());
 const a=await report(input(home));assert.equal(a.total.tokens,215);assert.equal(a.total.calls,1);assert.equal(a.sessions.length,1);assert.equal(JSON.stringify(a).includes("PRIVATE"),false);
 db.prepare("INSERT INTO message VALUES(?,?,?)").run("msg2","session1",JSON.stringify(msg("msg2")));
 const b=await report(input(home));assert.equal(b.total.tokens,430);assert.equal(b.total.calls,2);assert.equal(db.prepare("SELECT count(*) n FROM message").get().n,2);
 const scoped=await report({...input(home),query:{...input(home).query,scope:"workspace"},entries:[{key:"registered",record:{agentId:"opencode",nativeSessionId:"session1"}}]});assert.equal(scoped.total.tokens,430);assert.equal(scoped.sessions[0].id,"registered");
});
test("unsafe SQLite companions and views are rejected",async t=>{
 const home=await fixture(t),file=path.join(home,"opencode.db"),db=new DatabaseSync(file);
 db.exec("CREATE TABLE raw(id TEXT,session_id TEXT,data TEXT);CREATE VIEW message AS SELECT * FROM raw");db.close();
 const source={file,root:home,agent:"opencode",format:"opencode-db"};assert.equal((await H.readExtraUsageFile(source,budget())).reason,"unsupported_format");
 if(process.platform!=="win32"){await fs.writeFile(path.join(home,"target"),"private");await fs.symlink(path.join(home,"target"),file+"-wal");assert.equal((await H.readExtraUsageFile(source,budget())).reason,"unsafe_file");}
});
test("Hermes includes auxiliary work, main residual and unknown call counts without inventing a call",async t=>{
 const home=await fixture(t),folder=path.join(home,".hermes");await fs.mkdir(folder);const db=new DatabaseSync(path.join(folder,"state.db"));
 db.exec("CREATE TABLE sessions(id TEXT,model TEXT,started_at REAL,input_tokens INTEGER,output_tokens INTEGER,cache_read_tokens INTEGER,cache_write_tokens INTEGER,estimated_cost_usd REAL,api_call_count INTEGER);CREATE TABLE session_model_usage(session_id TEXT,model TEXT,task TEXT,input_tokens INTEGER,output_tokens INTEGER,cache_read_tokens INTEGER,cache_write_tokens INTEGER,estimated_cost_usd REAL,api_call_count INTEGER)");
 db.prepare("INSERT INTO sessions VALUES(?,?,?,?,?,?,?,?,?)").run("s","last-model",AT/1000,100,20,50,0,.1,4);
 db.prepare("INSERT INTO session_model_usage VALUES(?,?,?,?,?,?,?,?,?)").run("s","first-model","",60,10,30,0,.06,2);
 db.prepare("INSERT INTO session_model_usage VALUES(?,?,?,?,?,?,?,?,?)").run("s","aux-model","title",10,2,0,0,.01,null);db.close();
 const r=await report(input(home));assert.equal(r.total.tokens,182);assert.equal(r.total.calls,4);assert.equal(r.total.unknownCalls,1);assert.equal(r.dateApproximateRecords,3);assert.equal(r.coverage.partial,1);assert.ok(Math.abs(r.total.knownCost-.11)<1e-8);assert.equal(r.models.some(m=>m.name==="unknown"),true);
 const sum=D.empty();D.addCall(sum,{tokens:{input:1,output:0,cacheRead:0,cacheWrite:0},callsUnknown:true},{usd:.01,source:"agent"});assert.equal(sum.calls,0);assert.equal(sum.unknownPricedRecords,1);
});
test("Grok overlapping log and turn totals are not added twice and report incomplete coverage",async t=>{
 const home=await fixture(t),root=path.join(home,".grok");await fs.mkdir(path.join(root,"logs"),{recursive:true});await fs.mkdir(path.join(root,"sessions/s"),{recursive:true});
 await fs.writeFile(path.join(root,"logs/unified.jsonl"),JSON.stringify({sid:"s",pid:42,ts:AT,msg:"shell.turn.inference_done",ctx:{loop_index:0,prompt_tokens:100,cached_prompt_tokens:80,completion_tokens:20}})+"\n");
 await fs.writeFile(path.join(root,"sessions/s/updates.jsonl"),JSON.stringify({method:"session/update",params:{sessionId:"s",_meta:{eventId:"t",agentTimestampMs:AT},update:{sessionUpdate:"turn_completed",usage:{inputTokens:100,outputTokens:20,cacheReadTokens:80}}}})+"\n");
 const r=await report(input(home));assert.equal(r.total.tokens,120);assert.equal(r.total.calls,1);assert.equal(r.coverage.partial,1);assert.equal(r.issues[0].reason,"overlapping_history");
});
test("menu bar distinguishes unavailable usage, partial cost and used versus remaining",()=>{
 const quotas=[{windows:[{usedPercent:30},{usedPercent:80}]}];assert.equal(M.badge("quota",null,quotas),"20%");assert.equal(M.badge("quota",null,quotas,"used"),"80%");
 assert.equal(M.badge("tokens",{total:{tokens:0}},[],"remaining","en",true),"—");assert.equal(M.badge("quota",null,quotas,"remaining","en",true),"20%");
 assert.equal(M.cost({unknownPricedRecords:1,knownCost:.12,unknownUnpricedRecords:1}),"≥ $0.12");assert.equal(M.cost({pricedCalls:0,knownCost:0}),"—");
 const r=M.range(new Date(AT));assert.ok(r.from<=AT && r.to>AT);assert.equal(Object.keys(M.AGENT_NAMES).length,12);
});

test("histories without provider metadata still label recognized model vendors",()=>{
 assert.deepEqual(D.modelIdentity("unknown","claude-opus-test"),{provider:"anthropic",model:"claude-opus-test"});
 assert.deepEqual(D.modelIdentity("antigravity","gemini-test"),{provider:"gemini",model:"gemini-test"});
 assert.deepEqual(D.modelIdentity("unknown","custom-model"),{provider:"unknown",model:"custom-model"});
});
test("machine discovery includes OMP, Gemini, Cline, Kilo, Roo and Antigravity numeric histories",async t=>{
 const home=await fixture(t);
 const omp=path.join(home,".omp/agent/sessions",UUID+".jsonl");await fs.mkdir(path.dirname(omp),{recursive:true});
 await fs.writeFile(omp,[{type:"session",id:UUID,cwd:"/demo"},{type:"message",id:"m",timestamp:AT,message:{role:"assistant",model:"test",usage:{input:10,output:2,cacheRead:0,cacheWrite:0}}}].map(JSON.stringify).join("\n")+"\n");
 await write(path.join(home,".gemini/tmp/project/chats/session-demo.json"),{sessionId:"g",messages:[{id:"m",type:"gemini",timestamp:AT,model:"gemini-test",tokens:{input:10,output:2,total:12}}]});
 await write(path.join(home,".cline/data/sessions/cli.messages.json"),{messages:[{id:"m",ts:AT,role:"assistant",metrics:{inputTokens:10,outputTokens:2}}]});
 const ui=[{type:"say",say:"api_req_started",ts:AT,text:JSON.stringify({tokensIn:10,tokensOut:2,modelId:"claude-test"})}];
 await write(path.join(home,"kilo-tasks/k/ui_messages.json"),ui);await write(path.join(home,"roo-tasks/r/ui_messages.json"),ui);
 const folder=path.join(home,".gemini/antigravity-cli/conversations");await fs.mkdir(folder,{recursive:true});const db=new DatabaseSync(path.join(folder,UUID+".db"));
 db.exec("CREATE TABLE gen_metadata(idx INTEGER,data BLOB);CREATE TABLE trajectory_metadata_blob(data BLOB)");
 db.prepare("INSERT INTO trajectory_metadata_blob VALUES(?)").run(proto([[2,proto([[1,Math.floor(AT/1000)]])]]));
 db.prepare("INSERT INTO gen_metadata VALUES(?,?)").run(1,proto([[1,proto([[4,proto([[1,10],[2,0],[3,2],[9,2]])],[19,"gemini-test"]])]]));db.close();
 const entries=[{key:"native-ag",record:{agentId:"antigravity",nativeSessionId:"wrapper",nativeConversationId:UUID}}];
 const r=await report({...input(home),roots:{kiloTasks:path.join(home,"kilo-tasks"),"roo-codeTasks":path.join(home,"roo-tasks")},entries});
 assert.equal(r.total.tokens,72);assert.deepEqual(r.agents.map(a=>a.id).sort(),["antigravity","cline","gemini","kilo","omp","roo-code"]);assert.equal(r.coverage.missing,0);assert.equal(r.sessions.some(s=>s.id==="native-ag"),true);
});
