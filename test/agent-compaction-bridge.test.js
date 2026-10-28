"use strict";
const test=require("node:test"),assert=require("node:assert/strict");
const {createCompactionBridge}=require("../server/agent-compaction-bridge");
function fixture(){
 const calls=[],piSession={exited:false},claudeState={state:"waiting",closed:false},codexState={threadId:"thread-a",turnId:null};
 const claudeSession={status:()=>claudeState,pendingPermissions:()=>[],compact:async options=>{calls.push(["claude",options]);return {completed:true,beforeTokens:100};}};
 const codex={status:()=>({mutationReady:true}),nativeState:()=>codexState,pendingApprovals:()=>[],resumeThread:async({threadId})=>{calls.push(["resume",threadId]);codexState.threadId=threadId;return {kind:"resumed"};},compactThread:async id=>{calls.push(["codex",id]);return {kind:"completed",completed:true,threadId:id};}};
 const openCode={status:()=>({ready:true}),sessionStatus:async()=>({}),permissions:async()=>({supported:true,permissions:[]}),compact:async(id,options)=>{calls.push(["opencode",id,options]);return {completed:true};}};
 const acp={compactionSupport:()=>({supported:true,instructions:false,busy:false}),compact:async(id,options)=>{calls.push(["acp",id,options]);return {completed:true};}};
 const bridge=createCompactionBridge({pi:{session:()=>piSession,busy:()=>false,command:async(sid,command)=>{calls.push(["pi",sid,command]);return {success:true,data:{tokensBefore:12000,estimatedTokensAfter:2000}};}},claude:()=>({session:claudeSession}),codex,openCode,acp:()=>acp,working:async()=>false,choice:()=>({model:"owned-provider/owned-model"})});
 return {bridge,calls,piSession,claudeState,codexState,codex,openCode,acp};
}
const records={pi:{agentId:"pi",sid:"pi-a",cwd:"/owned"},"claude-code":{agentId:"claude-code",id:"claude-code:claude-a",nativeClaudeStructured:true,cwd:"/owned"},codex:{agentId:"codex",nativeCodex:true,mutation:"native_api",nativeThreadId:"thread-a",cwd:"/owned"},opencode:{agentId:"opencode",nativeOpenCode:true,nativeSessionId:"open-a",cwd:"/owned"},omp:{agentId:"omp",nativeAcp:true,nativeSessionId:"acp-a",cwd:"/owned"},cline:{agentId:"cline",nativeAcp:true,nativeSessionId:"acp-a",cwd:"/owned"},kilo:{agentId:"kilo",nativeAcp:true,nativeSessionId:"acp-a",cwd:"/owned"},"grok-build":{agentId:"grok-build",nativeGrokAcp:true,nativeSessionId:"grok-a",cwd:"/owned"}};
for(const [agentId,record] of Object.entries(records))test(`${agentId} reports native compaction capability without sending a prompt`,async()=>{
 const f=fixture(),state=await f.bridge.describe(record);assert.equal(state.supported,true);assert.equal(state.instructions,["pi","claude-code"].includes(agentId));assert.equal(f.calls.length,0);
});
test("Pi compaction sends customInstructions to the same sid and labels its post-token estimate",async()=>{
 const f=fixture(),result=await f.bridge.run(records.pi,{instructions:"Keep current work"});assert.deepEqual(f.calls,[["pi","pi-a",{type:"compact",customInstructions:"Keep current work"}]]);
 assert.deepEqual(result,{completed:true,beforeTokens:12000,afterTokens:2000,estimated:true});
});
test("Claude, Codex and OpenCode use their native operations, not a generated summary prompt",async()=>{
 const f=fixture();await f.bridge.run(records["claude-code"],{instructions:"Keep decisions"});await f.bridge.run(records.codex,{});await f.bridge.run(records.opencode,{});
 assert.deepEqual(f.calls,[["claude",{instructions:"Keep decisions"}],["codex","thread-a"],["opencode","open-a",{directory:"/owned",model:{providerID:"owned-provider",modelID:"owned-model"}}]]);
});
test("an owned Codex thread may be resumed, but is never replaced by another conversation",async()=>{
 const f=fixture();f.codexState.threadId=null;await f.bridge.run(records.codex,{});assert.deepEqual(f.calls,[["resume","thread-a"],["codex","thread-a"]]);
});
test("unsupported ACP and Antigravity remain disabled; Hermes is excluded",async()=>{
 const f=fixture();f.acp.compactionSupport=()=>({supported:false,instructions:false,reason:"compaction_unavailable"});assert.equal((await f.bridge.describe(records.cline)).supported,false);
 for(const record of [{agentId:"antigravity",nativeAcp:true},{agentId:"hermes",nativeAcp:true}]){assert.equal((await f.bridge.describe(record)).supported,false);await assert.rejects(f.bridge.run(record,{}));}
 assert.equal(f.calls.length,0);
});
test("terminal-only conversations never claim a structured compaction capability",async()=>{
 const f=fixture();for(const agentId of ["claude-code","codex","opencode","omp","grok-build"])assert.equal((await f.bridge.describe({agentId})).reason,"compaction_terminal_only");
});
test("busy and disconnected native sessions do not dispatch",async()=>{
 const f=fixture();f.claudeState.state="running";await assert.rejects(f.bridge.run(records["claude-code"],{}),/compaction_busy/);
 f.codexState.turnId="running-turn";await assert.rejects(f.bridge.run(records.codex,{}),/compaction_busy/);f.piSession.exited=true;assert.equal((await f.bridge.describe(records.pi)).supported,false);assert.equal(f.calls.length,0);
});
test("the backend refuses unsupported instructions instead of dropping them",async()=>{
 const f=fixture();await assert.rejects(f.bridge.run(records.codex,{instructions:"keep this"}),/compaction_instructions_unavailable/);assert.equal(f.calls.length,0);
});
