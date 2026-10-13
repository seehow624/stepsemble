"use strict";

// Interpret saved numeric usage only. Returned records never contain prompts,
// tool arguments, account credentials, request bodies or model replies.
const crypto = require("node:crypto");
const { number, text, time } = require("./usage-records");
const digest = value => crypto.createHash("sha256").update(value).digest("hex");
const count = (value, optional = false) => value === undefined && optional ? 0 : Number.isSafeInteger(value) && number(value) !== null ? value : null;
function breakdown(raw, inclusive = false, reasoning = false) {
  if (!raw || typeof raw !== "object") return null;
  let input = count(raw.input), output = count(raw.output);
  const cacheRead = count(raw.cacheRead, true), cacheWrite = count(raw.cacheWrite, true), thought = count(raw.reasoning, true);
  if (inclusive) input = input === null || cacheRead === null || cacheWrite === null || input < cacheRead + cacheWrite ? null : input - cacheRead - cacheWrite;
  if (reasoning) output = output === null || thought === null ? null : output + thought;
  if (input === null && output === null && !(cacheRead > 0) && !(cacheWrite > 0)) return null;
  return { input, output, cacheRead, cacheWrite };
}
function call(agent, session, id, at, model, provider, tokens, extra = {}) {
  const timestamp = time(at);
  if (!timestamp || !session || !id || !tokens) return null;
  const calls = Number.isSafeInteger(extra.calls) && extra.calls > 0 ? Math.min(extra.calls, 1e9) : 1;
  return { identity: digest(`${agent}:${text(session, 400)}:${text(id, 1200)}`), at: timestamp, model: text(model) || "unknown", provider: text(provider) || "unknown", tokens,
    cost: number(extra.cost), costSource: number(extra.cost) === null ? null : "agent", calls,
    ...(extra.dateApproximate ? { dateApproximate: true } : {}), ...(extra.aggregate ? { aggregate: true } : {}),
    ...(extra.aggregate && !(Number.isSafeInteger(extra.calls) && extra.calls > 0) ? { callsUnknown: true } : {}) };
}
function opencodeMessage(agent, value, fallback = {}) {
  if (!value || value.role !== "assistant" || !value.tokens || !value.id || !value.sessionID) return null;
  const raw = value.tokens, r = call(agent, value.sessionID, value.id, value.time?.created || fallback.at,
    value.modelID || value.model?.modelID || fallback.model, value.providerID || value.model?.providerID || fallback.provider,
    breakdown({ input:raw.input, output:raw.output, cacheRead:raw.cache?.read, cacheWrite:raw.cache?.write, reasoning:raw.reasoning },false,true), {cost:value.cost});
  return r;
}
function geminiSession(value) {
  if (!value?.sessionId || !Array.isArray(value.messages)) return null;
  const rows=[];let partial=false;
  for (const m of value.messages) {
    if (m.type !== "gemini" || !m.tokens) continue;
    const t=m.tokens, input=count(t.input), cache=count(t.cached,true), out=count(t.output), thoughts=count(t.thoughts,true), tool=count(t.tool,true), total=count(t.total);
    // Some Gemini versions include cache in input, while others report it
    // separately. Use the redundant total to resolve that contract exactly.
    let uncached=input;
    if (total !== null && input !== null && out !== null && thoughts !== null && tool !== null && cache !== null) {
      const base=input+out+thoughts+tool;
      if (total === base) uncached=input>=cache?input-cache:null;
      else if (total !== base+cache) { partial=true;uncached=null; }
    } else if (cache > 0) { partial=true;uncached=null; }
    const tokens=breakdown({input:uncached===null || tool===null?null:uncached+tool,output:out,cacheRead:cache,reasoning:thoughts},false,true);
    const row=call("gemini",value.sessionId,m.id,m.timestamp || value.startTime,m.model,"gemini",tokens,{dateApproximate:!m.timestamp});
    if(row) rows.push(row);else partial=true;
  }
  return {session:text(value.sessionId,400),rows,meta:{cwd:text(value.cwd || value.projectPath,4096),name:text(value.title)},partial};
}
function clineMessages(agent, values, session, model = "unknown") {
  if (!Array.isArray(values)) return null;
  const rows=[];let partial=false;
  for (const m of values) {
    if (m.type !== "say" || m.say !== "api_req_started") continue;
    let usage;try {usage=typeof m.text === "string"?JSON.parse(m.text):null;} catch {partial=true;continue;}
    if(!usage || ![usage.tokensIn,usage.tokensOut,usage.cacheReads,usage.cacheWrites].some(n=>number(n)!==null)) continue;
    const row=call(agent,session,m.id || String(m.ts),m.ts,usage.modelId || usage.model || model,usage.apiProvider || usage.apiProtocol,
      breakdown({input:usage.tokensIn,output:usage.tokensOut,cacheRead:usage.cacheReads,cacheWrite:usage.cacheWrites}),{cost:usage.cost});
    if(row) rows.push(row);else partial=true;
  }
  return {session,rows,meta:{},partial};
}
function clineCli(value, session, manifest = {}) {
  if (!Array.isArray(value?.messages)) return null;
  session=text(value.sessionId || session,400);const rows=[];let partial=false,model=manifest.model,provider=manifest.provider;
  for(const message of value.messages) {
    if(message.role!=="assistant") continue;
    model=message.modelInfo?.id || model;provider=message.modelInfo?.provider || provider;
    const m=message.metrics;if(!m) continue;
    const r=call("cline",session,message.id,message.ts,model,provider,
      breakdown({input:m.inputTokens,output:m.outputTokens,cacheRead:m.cacheReadTokens,cacheWrite:m.cacheWriteTokens},true),{cost:m.cost});
    if(r) rows.push(r);else partial=true;
  }
  return {session,rows,meta:{cwd:text(manifest.cwd || manifest.workspace_root,4096),name:text(manifest.title)},partial};
}
function grokLog(values, session = "") {
  const rows=[],models=new Map(),meta=new Map();let partial=false;
  for(const m of values) {
    const sid=text(m.sid || m.params?.sessionId || session,400), ctx=m.ctx;
    if(sid && m.msg==="model changed" && ctx?.model) models.set(sid,text(ctx.model));
    if(sid && ctx?.cwd) meta.set(sid,{cwd:text(ctx.cwd,4096)});
    if(m.msg !== "shell.turn.inference_done" || !ctx || !sid) continue;
    if(!Number.isSafeInteger(m.pid) || m.pid<=0 || !Number.isSafeInteger(ctx.loop_index) || ctx.loop_index<0) {partial=true;continue;}
    const input=count(ctx.prompt_tokens), cache=count(ctx.cached_prompt_tokens,true), output=count(ctx.completion_tokens);
    if(input===null || output===null || cache===null || cache>input) {partial=true;continue;}
    const at=time(m.ts), id=JSON.stringify([m.pid,ctx.loop_index,at]);
    const row=call("grok-build",sid,id,at,ctx.model || models.get(sid),"xai",breakdown({input,output,cacheRead:cache},true));
    if(row) rows.push({ ...row, session:sid });else partial=true;
  }
  return {rows,meta,partial};
}
function grokUpdates(values, session) {
  const rows=[];let partial=false,model="unknown";
  for(const m of values) {
    const p=m.params,u=p?.update;
    if(!u || p.sessionId!==session) continue;
    if(u.modelId) model=u.modelId;
    if(u.sessionUpdate!=="turn_completed") continue;
    const raw=u.usage;
    if(!raw) {partial=true;continue;}
    const models=raw.modelUsage && typeof raw.modelUsage==="object"?Object.entries(raw.modelUsage):[[model,raw]];
    for(const [name,v] of models) {
      const at=p._meta?.agentTimestampMs || u.timestamp;
      const row=call("grok-build",session,JSON.stringify([p._meta?.eventId || at,name]),at,name,"xai",
        breakdown({input:v.inputTokens ?? v.input_tokens,output:v.outputTokens ?? v.output_tokens,cacheRead:v.cachedReadTokens ?? v.cacheReadTokens,cacheWrite:v.cachedWriteTokens ?? v.cacheWriteTokens},true));
      if(row) rows.push(row);else partial=true;
    }
  }
  return {session,rows,meta:{},partial};
}

// Bounded protobuf decoding for saved Antigravity generator metadata. Unknown
// timestamp layouts remain session-dated instead of guessing opaque bytes.
function proto(bytes) {
  if (!Buffer.isBuffer(bytes) && !(bytes instanceof Uint8Array)) return null;
  bytes=Buffer.from(bytes);if(bytes.length>4*1024*1024) return null;
  let at=0,fields=new Map();
  function varint(){let n=0n;for(let i=0;i<10 && at<bytes.length;i++){const b=bytes[at++];n|=BigInt(b&127)<<BigInt(i*7);if(!(b&128))return n;}throw new Error("bad protobuf");}
  try {
    while(at<bytes.length){const key=varint(),field=Number(key>>3n),kind=Number(key&7n);if(!field || fields.size>256) return null;let value;
      if(kind===0)value=varint();else if(kind===2){const size=varint();if(size>BigInt(bytes.length-at))return null;value=bytes.subarray(at,at+Number(size));at+=Number(size);}
      else if(kind===1 || kind===5){const size=kind===1?8:4;if(at+size>bytes.length)return null;value=bytes.subarray(at,at+size);at+=size;}else return null;
      if(!fields.has(field))fields.set(field,value);
    }return fields;
  } catch{return null;}
}
const num = (fields,key) => {const n=fields?.get(key);return typeof n==="bigint" && n<=1000000000000n?Number(n):null;};
const nested = (fields,key) => proto(fields?.get(key));
const str = (fields,key) => {const v=fields?.get(key);return Buffer.isBuffer(v) && v.length<=1200?text(v.toString("utf8"),1200):"";};
function protoTime(fields) {const s=num(fields,1),n=num(fields,2) ?? 0;return s && n<1e9?time(s*1000+Math.floor(n/1e6)):null;}
function antigravityGeneration(blob, session, index, context = {}) {
  const model=nested(proto(blob),1), usage=nested(model,4);if(!usage)return null;
  const input=num(usage,1), prompt=num(usage,2), output=num(usage,9), thought=num(usage,10) ?? 0, cache=num(usage,5) ?? 0;
  const at=protoTime(nested(nested(model,9),4)), totalOutput=num(usage,3);
  if(totalOutput!==null && output!==null && totalOutput!==output+thought) return null;
  const id=str(usage,11) || String(index), name=str(model,19) || str(model,21) || "unknown";
  return call("antigravity",session,id,at || context.started,name,"antigravity",
    breakdown({input:input===null || prompt===null?null:input+prompt,output,cacheRead:cache,reasoning:thought},false,true),{dateApproximate:!at});
}
function antigravityContext(blob) {const fields=proto(blob);let cwd=str(nested(fields,1),1);try{const url=new URL(cwd);cwd=url.protocol==="file:"?decodeURIComponent(url.pathname):"";}catch{cwd="";}return {started:protoTime(nested(fields,2)),cwd:text(cwd,4096)};}
module.exports={breakdown,call,opencodeMessage,geminiSession,clineMessages,clineCli,grokLog,grokUpdates,proto,protoTime,antigravityGeneration,antigravityContext};
