// Native OMP, temporary HOME, synthetic local model; no real credentials.
const fs = require('node:fs/promises'), os = require('node:os'), path = require('node:path'), http = require('node:http'), assert = require('node:assert/strict');
const { createAgentClientProtocolAdapter } = require('../server/agent-client-protocol-adapter');
const omp = process.argv[2];
if (!omp || !path.isAbsolute(omp)) throw new Error('Usage: node scripts/check-native-omp-gateway.cjs /absolute/path/to/omp');
(async () => {
 const home = await fs.mkdtemp(path.join(os.tmpdir(),'stepsemble-omp-native-')); const dir=path.join(home,'.omp/agent'); await fs.mkdir(dir,{recursive:true});
 let requests=0;
 const api=http.createServer(async(req,res)=>{
  if(req.url.endsWith('/models')){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({data:[]}));return;}
  let s='';for await(const c of req)s+=c;const b=JSON.parse(s);assert.equal(b.model,'synthetic/model'); requests++;
  res.writeHead(200,{'Content-Type':'text/event-stream'});
  for(const delta of [{role:'assistant',content:''},{content:'omp-gateway-ok'}]) res.write('data: '+JSON.stringify({id:'test',object:'chat.completion.chunk',created:1,model:b.model,choices:[{index:0,delta,finish_reason:null}]})+'\n\n');
  res.write('data: '+JSON.stringify({id:'test',object:'chat.completion.chunk',created:1,model:b.model,choices:[{index:0,delta:{},finish_reason:'stop'}],usage:{prompt_tokens:2,completion_tokens:3,total_tokens:5}})+'\n\ndata: [DONE]\n\n');res.end();
 }); await new Promise(r=>api.listen(0,'127.0.0.1',r));
 let child;
 const adapter=createAgentClientProtocolAdapter({spawnImpl:(...args)=>{child=require('node:child_process').spawn(...args);return child;},command:omp,args:['acp','--no-extensions','--no-skills','--no-tools','--no-lsp'],cwd:home,requiresModel:true,requestTimeoutMs:45000,
 env:{HOME:home,USERPROFILE:home,XDG_CONFIG_HOME:path.join(home,'.config'),XDG_CACHE_HOME:path.join(home,'.cache'),PATH:[path.dirname(omp),path.dirname(process.execPath),'/usr/bin','/bin'].join(path.delimiter),PI_CODING_AGENT_DIR:dir,PI_OFFLINE:'1',OMP_OFFLINE:'1'}});
 try{
  const before=await adapter.createSession({directory:home}); console.log('before',before.kind,before.code);
  await fs.writeFile(path.join(dir,'models.yml'),JSON.stringify({providers:{opencodex:{baseUrl:`http://127.0.0.1:${api.address().port}/v1`,api:'openai-completions',apiKey:'synthetic-only',models:[{id:'synthetic/model',name:'Synthetic Model',contextWindow:32768,maxTokens:1024,cost:{input:0,output:0,cacheRead:0,cacheWrite:0},input:['text'],reasoning:false}]}}}));
  const after=await adapter.createSession({directory:home});console.log('after',after.kind);assert.equal(after.kind,'created');
  const option=after.configOptions.find(o=>o.category==='model');const choices=option.options.flatMap(o=>o.options||[o]);const choice=choices.find(o=>o.value.includes('synthetic/model'));assert.ok(choice);
  assert.notEqual((await adapter.setConfigOption(after.sessionId,option.id,choice.value)).kind,'reject');
  const result=await adapter.prompt(after.sessionId,'Reply with exactly: omp-gateway-ok');console.log('prompt',result.kind);assert.equal(result.kind,'prompted');
  const text=JSON.stringify(adapter.sessionEvents(after.sessionId));assert.ok(text.includes('omp-gateway-ok'));assert.ok(requests>0);console.log('PASS native OMP hot configuration + model selection + local model response');
 }finally{await adapter.close();if(child && child.exitCode===null && child.signalCode===null){const closed=require('node:events').once(child,'close');const timer=setTimeout(()=>child.kill('SIGKILL'),3000);await closed;clearTimeout(timer);}api.closeAllConnections();await new Promise(r=>api.close(r));await fs.rm(home,{recursive:true,force:true});}
})().catch(e=>{console.error(e);process.exitCode=1;});
