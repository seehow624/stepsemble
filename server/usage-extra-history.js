"use strict";
const fs=require("node:fs/promises"), path=require("node:path");
const {DatabaseSync}=require("node:sqlite");
const R=require("./usage-extra-records"), {text,time,number}=require("./usage-records");
const SUPPORTED=new Set(["omp","opencode","hermes","gemini","cline","kilo","roo-code","grok-build","antigravity"]);
const cache=new Map(), MAX_JSON=32*1024*1024, MAX_ROWS=100000;
const own=stat=>typeof process.getuid!=="function" || Number(stat.uid)===process.getuid();
const inside=(root,file)=>{const rel=path.relative(root,file);return rel!=="" && rel!==".." && !rel.startsWith(".."+path.sep) && !path.isAbsolute(rel);};
const signature=s=>[s.dev,s.ino,s.size,s.mtimeNs,s.ctimeNs].join(":");
const errorReason=e=>e?.code==="ENOENT"?"missing_file":["EACCES","EPERM"].includes(e?.code)?"permission_denied":"read_failed";

async function discoverExtraUsageFiles(home, roots, budget) {
  const files=[],sources=[],canonical=new Set();
  const data=roots.data || path.join(home,".local","share");
  const configured={
    omp:[[roots.omp || path.join(home,".omp","agent","sessions"),"omp"]],
    opencode:[[roots.opencode || path.join(data,"opencode"),"opencode"]],
    hermes:[[roots.hermes || path.join(home,".hermes"),"hermes"]],
    gemini:[[roots.gemini || path.join(home,".gemini","tmp"),"gemini"]],
    cline:[[roots.cline || path.join(home,".cline","data","sessions"),"cline-cli"]],
    "kilo":[[roots.kilo || path.join(data,"kilo"),"kilo"]],
    "grok-build":[[roots.grok || path.join(home,".grok","sessions"),"grok"],[path.join(roots.grokHome || path.join(home,".grok"),"logs"),"grok-log"]],
    antigravity:[[roots.antigravity || path.join(home,".gemini","antigravity-cli","conversations"),"antigravity"],[roots.antigravityExtension || path.join(home,".gemini","antigravity","conversations"),"antigravity"]],
    "roo-code":[],
  };
  const editors=process.platform==="darwin"?["Code","Code - Insiders","Cursor","Windsurf"].map(e=>path.join(home,"Library","Application Support",e,"User"))
    :process.platform==="win32"?["Code","Code - Insiders","Cursor","Windsurf"].map(e=>path.join(roots.appData || path.join(home,"AppData","Roaming"),e,"User"))
    :["Code","Code - Insiders","Cursor","Windsurf"].map(e=>path.join(roots.configHome || path.join(home,".config"),e,"User"));
  editors.push(path.join(home,".vscode-server","data","User"));
  const extensions={cline:"saoudrizwan.claude-dev","kilo":"kilocode.kilo-code","roo-code":"rooveterinaryinc.roo-cline"};
  for(const [agent,extension] of Object.entries(extensions)) {
    if(roots[agent+"Tasks"]) configured[agent].push([roots[agent+"Tasks"],"cline-ui"]);
    else for(const editor of editors) configured[agent].push([path.join(editor,"globalStorage",extension,"tasks"),"cline-ui"]);
  }
  function classify(file,kind) {
    const base=path.basename(file);
    if(kind==="omp" && base.endsWith(".jsonl")) return "native";
    if(["opencode","kilo"].includes(kind)) {
      if(base===(kind==="opencode"?"opencode.db":"kilo.db"))return "opencode-db";
      if(base.endsWith(".json") && file.includes(path.sep+"storage"+path.sep+"message"+path.sep))return "opencode-json";
    }
    if(kind==="hermes" && base==="state.db")return "hermes-db";
    if(kind==="gemini" && base.startsWith("session-") && base.endsWith(".json") && path.basename(path.dirname(file))==="chats")return "gemini-json";
    if(kind==="cline-ui" && base==="ui_messages.json")return "cline-ui";
    if(kind==="cline-cli" && base.endsWith(".messages.json"))return "cline-cli";
    if(kind==="grok" && base==="updates.jsonl")return "grok-updates";
    if(kind==="grok-log" && base==="unified.jsonl")return "grok-log";
    if(kind==="antigravity" && /^[a-f0-9-]{36}\.db$/i.test(base))return "antigravity-db";
    return null;
  }
  async function walk(folder,root,agent,kind,depth=0) {
    if(depth>10 || budget.visited>=20000 || Date.now()>budget.deadline){budget.limited=true;return;}
    let children;try{children=await fs.readdir(folder,{withFileTypes:true});}catch(e){if(e.code!=="ENOENT")budget.limited=true;return;}
    for(const child of children) {
      if(++budget.visited>20000 || Date.now()>budget.deadline){budget.limited=true;return;}
      const file=path.join(folder,child.name);
      if(child.isDirectory()) {
        // Hermes' home also contains an installation and plugins. Only its
        // profile stores are histories; never scan those source repositories.
        if(kind==="hermes" && depth===0 && child.name!=="profiles")continue;
        if(kind==="hermes" && depth>2)continue;
        if(["opencode","kilo"].includes(kind) && depth===0 && child.name!=="storage")continue;
        if(["opencode","kilo"].includes(kind) && depth===1 && child.name!=="message")continue;
        await walk(file,root,agent,kind,depth+1);continue;
      }
      const format=classify(file,kind);if(!format)continue;
      if(!child.isFile()){budget.limited=true;continue;}
      const stat=await fs.lstat(file).catch(()=>null);if(!stat || !own(stat)){budget.limited=true;continue;}
      const real=await fs.realpath(file).catch(()=>null);if(!real || canonical.has(real))continue;canonical.add(real);
      const expected=kind==="omp"?child.name.match(/[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}/i)?.[0] || ""
        :format==="antigravity-db"?path.basename(file,".db"):format==="cline-cli"?path.basename(file,".messages.json"):path.basename(path.dirname(file));
      files.push({file,root,agent,format,expected,modified:stat.mtimeMs});
    }
  }
  for(const [agent,folders] of Object.entries(configured)) {
    let present=false,unavailable=false;
    for(const [folder,kind] of folders) {
      let root;try{root=await fs.realpath(folder);}catch(e){if(e.code!=="ENOENT"){unavailable=true;budget.limited=true;}continue;}
      const stat=await fs.stat(root).catch(()=>null);if(!stat?.isDirectory() || !own(stat)){unavailable=true;budget.limited=true;continue;}
      present=true;await walk(root,root,agent,kind);
    }
    sources.push({agent,status:unavailable?"unavailable":present?"ready":"absent"});
  }
  return {files,sources};
}

async function readJSON(handle,max=MAX_JSON) {
  const stat=await handle.stat();if(stat.size>max)throw Object.assign(new Error("large record"),{reason:"record_too_large"});
  const bytes=Buffer.alloc(stat.size);let at=0;
  while(at<bytes.length){const read=await handle.read(bytes,at,bytes.length-at,at);if(!read.bytesRead)break;at+=read.bytesRead;}
  return JSON.parse(bytes.subarray(0,at).toString("utf8"));
}
async function siblingJSON(source,name) {
  let handle;try {
    const file=path.join(path.dirname(source.file),name),stat=await fs.lstat(file);
    if(!stat.isFile() || !own(stat) || stat.isSymbolicLink() || !inside(source.root,file))return null;
    handle=await fs.open(file,require("node:fs").constants.O_RDONLY | (require("node:fs").constants.O_NOFOLLOW || 0));return await readJSON(handle,4*1024*1024);
  }catch{return null;}finally{await handle?.close();}
}
async function jsonCollections(source,handle,budget) {
  const format=source.format, values=await readJSON(handle);
  let collection;
  if(format==="gemini-json")collection=R.geminiSession(values);
  else if(format==="cline-ui")collection=R.clineMessages(source.agent,values,source.expected);
  else if(format==="cline-cli")collection=R.clineCli(values,source.expected,await siblingJSON(source,source.expected+".json") || {});
  else if(format==="opencode-json") {
    const row=R.opencodeMessage(source.agent,values);collection=values?.sessionID?{session:text(values.sessionID,400),rows:row?[row]:[],meta:{cwd:text(values.path?.cwd,4096)},partial:!!values.tokens && !row && values.role==="assistant"}:null;
  }
  if(!collection)throw Object.assign(new Error("unknown history"),{reason:"unsupported_format"});
  budget.bytes+=(await handle.stat()).size;
  return [collection];
}

async function grokCollections(source,handle,budget) {
  const values=[],buffer=Buffer.alloc(65536);let offset=0,carry=Buffer.alloc(0),partial=false;
  while(Date.now()<budget.deadline && values.length<MAX_ROWS && budget.bytes<budget.maxBytes) {
    const {bytesRead}=await handle.read(buffer,0,buffer.length,offset);if(!bytesRead)break;offset+=bytesRead;budget.bytes+=bytesRead;
    const data=Buffer.concat([carry,buffer.subarray(0,bytesRead)]);let from=0;
    for(let at=data.indexOf(10);at>=0;at=data.indexOf(10,from)) {
      const line=data.subarray(from,at);from=at+1;
      if(line.length>8*1024*1024){partial=true;continue;}
      try {const m=JSON.parse(line.toString("utf8"));
        if(source.format==="grok-log") {
          if(["model changed","shell.turn.inference_done"].includes(m.msg)) {
            const ctx=Object.fromEntries(["model","cwd","loop_index","prompt_tokens","cached_prompt_tokens","completion_tokens"].map(k=>[k,m.ctx?.[k]]));
            values.push({sid:m.sid,pid:m.pid,ts:m.ts,msg:m.msg,ctx});
          }
        } else if(m.method==="session/update") {
          const p=m.params,u=p?.update;
          if(u?.sessionUpdate==="turn_completed" || u?.modelId)values.push({params:{sessionId:p.sessionId,_meta:{eventId:p._meta?.eventId,agentTimestampMs:p._meta?.agentTimestampMs},update:{sessionUpdate:u.sessionUpdate,usage:u.usage,modelId:u.modelId,timestamp:u.timestamp}}});
        }
      }catch{if(line.length)partial=true;}
    }
    carry=data.subarray(from);if(carry.length>8*1024*1024){carry=Buffer.alloc(0);partial=true;}
  }
  if(offset<(await handle.stat()).size || carry.length)partial=true;
  if(source.format==="grok-updates") {const c=R.grokUpdates(values,source.expected);c.partial ||= partial;return [c];}
  const parsed=R.grokLog(values),sessions=new Map();
  for(const row of parsed.rows){let c=sessions.get(row.session);if(!c){c={session:row.session,rows:[],meta:parsed.meta.get(row.session) || {},partial:partial || parsed.partial,precise:true};sessions.set(row.session,c);}const {session,...numeric}=row;c.rows.push(numeric);}
  if(!sessions.size && (partial || parsed.partial))return [{session:"log",rows:[],meta:{},partial:true,invalid:true}];
  return [...sessions.values()];
}

// SQLite readers below select only numeric fields and bounded metadata.
function tableColumns(db,name) {return db.prepare("SELECT type FROM sqlite_master WHERE name=?").get(name)?.type==="table"?new Set(db.prepare('PRAGMA table_info("'+name+'")').all().map(c=>c.name)):new Set();}
function optional(columns,column,alias=column,fallback="NULL") {return columns.has(column)?'"'+column+'" AS "'+alias+'"':fallback+' AS "'+alias+'"';}

function sqliteCollections(source,db,budget) {
  const collections=new Map();let limited=false;
  function group(session,meta={}) {
    session=text(session,400);let c=collections.get(session);
    if(!c){c={session,rows:[],meta:{cwd:text(meta.cwd,4096),name:text(meta.name)},partial:false};collections.set(session,c);}return c;
  }
  function visit(sql,params,consume) {
    let count=0;
    for(const row of db.prepare(sql).iterate(...params)) {
      if(++count>MAX_ROWS || Date.now()>budget.deadline){limited=true;break;}
      consume(row);
    }
  }
  if(source.format==="opencode-db") {
    const messages=tableColumns(db,"message"), sessions=tableColumns(db,"session");
    if(!["id","session_id","data"].every(k=>messages.has(k)))throw Object.assign(new Error("unknown schema"),{reason:"unsupported_format"});
    const joined=sessions.has("id"), cwd=joined && sessions.has("directory")?"s.directory":"NULL",title=joined && sessions.has("title")?"s.title":"NULL";
    const omitted=db.prepare("SELECT 1 FROM message WHERE NOT json_valid(data) OR length(data)>8388608 LIMIT 1").get();
    if(omitted){const c=group("unreadable-records");c.partial=true;c.reason="malformed_records";}
    visit(`SELECT m.id, m.session_id, ${cwd} AS cwd, ${title} AS title,
      json_extract(m.data,'$.modelID') AS model, json_extract(m.data,'$.providerID') AS provider,
      json_extract(m.data,'$.time.created') AS at, json_extract(m.data,'$.time.completed') AS completed,
      json_extract(m.data,'$.tokens.input') AS input, json_extract(m.data,'$.tokens.output') AS output,
      json_extract(m.data,'$.tokens.reasoning') AS reasoning, json_extract(m.data,'$.tokens.cache.read') AS cacheRead,
      json_extract(m.data,'$.tokens.cache.write') AS cacheWrite, json_extract(m.data,'$.cost') AS cost
      FROM message m ${joined?"LEFT JOIN session s ON s.id=m.session_id":""}
      WHERE json_valid(m.data) AND length(m.data)<=8388608 AND json_extract(m.data,'$.role')='assistant' ORDER BY m.id LIMIT 100001`,[],r=>{
        const c=group(r.session_id,{cwd:r.cwd,name:r.title});
        if(r.input===null && r.output===null && r.cacheRead===null && r.cacheWrite===null)return;
        const row=R.opencodeMessage(source.agent,{role:"assistant",id:r.id,sessionID:r.session_id,modelID:r.model,providerID:r.provider,time:{created:r.at,completed:r.completed},tokens:{input:r.input,output:r.output,reasoning:r.reasoning ?? undefined,cache:{read:r.cacheRead ?? undefined,write:r.cacheWrite ?? undefined}},cost:r.cost});
        if(row)c.rows.push(row);else c.partial=true;
      });
  }else if(source.format==="hermes-db") {
    const sessions=tableColumns(db,"sessions"), models=tableColumns(db,"session_model_usage");
    if(!["id","started_at","model"].every(k=>sessions.has(k)))throw Object.assign(new Error("unknown schema"),{reason:"unsupported_format"});
    const columns=["input_tokens","output_tokens","cache_read_tokens","cache_write_tokens","estimated_cost_usd","actual_cost_usd","api_call_count","billing_provider","cwd","title"], mainTotals=new Map();
    const meta=new Map();
    visit("SELECT id,model,started_at,"+columns.map(k=>optional(sessions,k)).join(",")+" FROM sessions ORDER BY id LIMIT 100001",[],r=>meta.set(text(r.id,400),r));
    function add(r,session,identity) {
      const c=group(session.id,{cwd:session.cwd,name:session.title});
      const tokens=R.breakdown({input:r.input_tokens,output:r.output_tokens,cacheRead:r.cache_read_tokens ?? undefined,cacheWrite:r.cache_write_tokens ?? undefined});
      if(!tokens || !Object.values(tokens).some(n=>n>0) && !(r.api_call_count>0) && !(r.actual_cost_usd>0) && !(r.estimated_cost_usd>0))return false;
      const cost=number(r.actual_cost_usd)>0?r.actual_cost_usd:r.estimated_cost_usd;
      const row=R.call("hermes",session.id,identity,session.started_at,r.model || session.model,r.billing_provider,tokens,{cost,calls:r.api_call_count,dateApproximate:true,aggregate:true});
      if(row){c.rows.push(row);return true;}c.partial=true;return false;
    }
    if(["session_id","model","input_tokens","output_tokens"].every(k=>models.has(k))) {
      visit("SELECT session_id,model,"+["billing_provider","billing_mode","task","input_tokens","output_tokens","cache_read_tokens","cache_write_tokens","api_call_count","estimated_cost_usd","actual_cost_usd"].map(k=>optional(models,k)).join(",")+" FROM session_model_usage ORDER BY session_id,model LIMIT 100001",[],r=>{
        const session=meta.get(text(r.session_id,400));if(!session)return;
        const id=JSON.stringify([r.model,r.billing_provider,r.billing_mode,r.task]);
        if(add(r,session,id) && !r.task) {
          let totals=mainTotals.get(session.id);
          if(!totals){totals=Object.fromEntries(["input_tokens","output_tokens","cache_read_tokens","cache_write_tokens","api_call_count","estimated_cost_usd","actual_cost_usd"].map(k=>[k,0]));mainTotals.set(session.id,totals);}
          for(const key of Object.keys(totals)) totals[key]+=number(r[key]) || 0;
        }
      });
    }
    for(const r of meta.values()) {
      const totals=mainTotals.get(r.id);
      if(!totals){add(r,r,"session-total");continue;}
      // Gateway totals may include older main-loop calls that predate the
      // per-model ledger. Preserve their numeric residual without assigning
      // those calls to the most recently selected model. Auxiliary calls do
      // not enter sessions' totals and must not suppress this fallback.
      const keys=["input_tokens","output_tokens","cache_read_tokens","cache_write_tokens"];
      if(keys.every(k=>number(r[k])!==null && r[k]>=totals[k])) {
        const rest={...r,model:"unknown",...Object.fromEntries(keys.map(k=>[k,r[k]-totals[k]])),
          api_call_count:Number.isSafeInteger(r.api_call_count) && r.api_call_count>=totals.api_call_count?r.api_call_count-totals.api_call_count:null,
          estimated_cost_usd:number(r.estimated_cost_usd)!==null && r.estimated_cost_usd>=totals.estimated_cost_usd?r.estimated_cost_usd-totals.estimated_cost_usd:null,
          actual_cost_usd:number(r.actual_cost_usd)!==null && r.actual_cost_usd>=totals.actual_cost_usd?r.actual_cost_usd-totals.actual_cost_usd:null};
        if(keys.some(k=>rest[k]>0)) {add(rest,r,"unattributed-main");const c=group(r.id);c.partial=true;c.reason="incomplete_records";}
      }
    }
  }else if(source.format==="antigravity-db") {
    const generations=tableColumns(db,"gen_metadata"), trajectory=tableColumns(db,"trajectory_metadata_blob");
    if(!generations.has("idx") || !generations.has("data"))throw Object.assign(new Error("unknown schema"),{reason:"unsupported_format"});
    const blob=trajectory.has("data")?db.prepare("SELECT data FROM trajectory_metadata_blob WHERE length(data)<=4194304 LIMIT 1").get()?.data:null;
    const context=R.antigravityContext(blob), c=group(source.expected,context);
    if(db.prepare("SELECT 1 FROM gen_metadata WHERE length(data)>4194304 LIMIT 1").get()){c.partial=true;c.reason="record_too_large";}
    visit("SELECT idx,data FROM gen_metadata WHERE length(data)<=4194304 ORDER BY idx LIMIT 100001",[],r=>{
      const row=R.antigravityGeneration(r.data,source.expected,r.idx,context);if(row)c.rows.push(row);else c.partial=true;
    });
  }
  if(limited)for(const c of collections.values()){c.partial=true;c.reason="file_limit";}
  return [...collections.values()];
}

// Filled by the format-specific readers, without invoking any installed agent.
module.exports={SUPPORTED,discoverExtraUsageFiles,readExtraUsageFile};

async function readExtraUsageFile(source,budget) {
  let handle,db;
  try {
    const stat=await fs.lstat(source.file,{bigint:true});
    if(!stat.isFile() || stat.isSymbolicLink() || !own(stat))return {rows:[],partial:true,invalid:true,reason:"unsafe_file"};
    const real=await fs.realpath(source.file);if(!inside(source.root,real))return {rows:[],partial:true,invalid:true,reason:"unsafe_file"};
    const dbFile=source.format.endsWith("-db"), sides=[];
    if(dbFile)for(const suffix of ["-wal","-shm"]) {
      const s=await fs.lstat(real+suffix,{bigint:true}).catch(e=>{if(e.code==="ENOENT")return null;throw e;});
      if(s && (!s.isFile() || s.isSymbolicLink() || !own(s)))return {rows:[],partial:true,invalid:true,reason:"unsafe_file"};
      if(suffix==="-wal")sides.push(s?signature(s):"absent");
    }
    const stamp=signature(stat)+sides.join(":"), key=source.agent+":"+source.format+":"+real,old=cache.get(key);
    if(old?.stamp===stamp)return old.result;
    handle=await fs.open(real,require("node:fs").constants.O_RDONLY | (require("node:fs").constants.O_NOFOLLOW || 0) | (require("node:fs").constants.O_NONBLOCK || 0));
    const opened=await handle.stat({bigint:true});if(signature(opened)!==signature(stat))throw Object.assign(new Error("changed source"),{reason:"source_changed"});
    let collections;
    if(dbFile) {
      db=new DatabaseSync(real,{readOnly:true,allowExtension:false});db.exec("PRAGMA trusted_schema=OFF; PRAGMA query_only=ON; PRAGMA busy_timeout=250; BEGIN;");
      const check=await fs.lstat(real,{bigint:true});if(signature(check)!==signature(stat))throw Object.assign(new Error("changed source"),{reason:"source_changed"});
      collections=sqliteCollections(source,db,budget);db.exec("COMMIT");
    }else if(source.format.startsWith("grok-"))collections=await grokCollections(source,handle,budget);
    else collections=await jsonCollections(source,handle,budget);
    const after=await handle.stat({bigint:true});if(signature(after)!==signature(stat))throw Object.assign(new Error("changed source"),{reason:"source_changed"});
    const result={collections,rows:[],partial:false,invalid:false};
    if(!collections.some(c=>c.partial)) {cache.delete(key);cache.set(key,{stamp,result});let count=0;for(const item of cache.values())count+=item.result.collections.reduce((n,c)=>n+c.rows.length,0);while(cache.size>128 || count>120000){const key=cache.keys().next().value;count-=cache.get(key).result.collections.reduce((n,c)=>n+c.rows.length,0);cache.delete(key);}}
    return result;
  }catch(e){return {rows:[],partial:true,invalid:true,reason:e.reason || errorReason(e)};}
  finally{try{db?.close();}catch{}await handle?.close().catch(()=>{});}
}
