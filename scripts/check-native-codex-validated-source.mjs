// Real Node -> Rust v11, complete envelope validation over owned files only.
// Not native projection parity, native model work, name resolution or Host UI.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
const require=createRequire(import.meta.url);
const {createNativeHelper}=require("../protocol/native/claude/history-native-helper.js");
const wire=require("../protocol/native/codex/scanned-source-wire.js");
const raw=require("../protocol/native/codex/rollout-snapshot.js");
const {richRecords}=require("../protocol/native/codex/history-fixture.js");
if(process.argv.length!==3||!path.isAbsolute(process.argv[2]))throw new Error("explicit_owned_helper_required");
const binary=path.resolve(process.argv[2]);
const created=await fs.mkdtemp(path.join(os.tmpdir(),"stepsemble-codex-validated-owned-")), temp=await fs.realpath(created);
const root=path.join(temp,"codex"), id="11111111-1111-4111-8111-111111111111";
const locator=`sessions/2026/01/05/rollout-2026-01-05T12-00-00-${id}.jsonl`, file=path.join(root,locator);
const encode=v=>Buffer.from(JSON.stringify(v)+"\n"), sha=b=>crypto.createHash("sha256").update(b).digest("hex");
const meta={type:"session_meta",payload:{id,cli_version:"0.153.4",history_mode:"legacy"}};
const row={type:"event_msg",payload:{type:"agent_message",message:"原文🐾"}};
const options={nativeVersion:"0.153.4",threadId:id},cases=[];
let helper, spawned=0,reaped=0,active=0,maxActive=0,passed=false, differentialCases=0,validatedSize=0;
try {
  await fs.mkdir(path.dirname(file),{recursive:true,mode:0o700});
  await fs.writeFile(file,encode(meta),{flag:"wx",mode:0o600});
  const names=encode({id,thread_name:"owned 原生名稱",updated_at:"2026-01-05T12:00:00Z"});
  await fs.writeFile(path.join(root,"session_index.jsonl"),names,{flag:"wx",mode:0o600});
  const sentinel=path.join(root,"auth.json"), sentinelBytes=Buffer.from("owned-sentinel-no-credential");
  await fs.writeFile(sentinel,sentinelBytes,{flag:"wx",mode:0o600});
  const stat=await fs.stat(root,{bigint:true});
  const base={nativeVersion:"0.153.4",source:{codexRoot:root,rolloutPath:locator,threadId:id},expectedRoot:{device:String(stat.dev),inode:String(stat.ino)}};
  const input=(offset=0,limit=2)=>({...base,page:{offset,limit}});
  helper=createNativeHelper({executablePath:binary,trustBoundary:"host_managed_executable",platform:process.platform==="win32"?"linux":process.platform,
    spawnChild(...args){const child=spawn(...args);spawned++;active++;maxActive=Math.max(maxActive,active);child.once("close",()=>{reaped++;active--;});return child;}});
  const read=(offset=0,limit=2)=>helper.readCodexValidatedPage(input(offset,limit));
  const first=await read();
  if(process.platform==="win32") {
    assert.deepEqual(first,{kind:"source_unavailable",code:"source_platform_unsupported"});cases.push("actual_windows_v11_unsupported");
  } else {
    assert.equal(first.kind,"native_codex_validated_source_page",first.code);
    assert.deepEqual(first.validation,{profile:"codex_legacy_envelope_v1",recordsValidated:1,selectedMetadataRecord:0,metadataRecords:1,historyMode:"legacy"});
    const good=[encode(meta),encode(row)];
    const corpus=[
      encode(meta),Buffer.concat(good),Buffer.concat([Buffer.from("\r\n"),...good]),
      Buffer.concat([encode(meta),...richRecords("/owned-unused").map(encode)]),
      Buffer.concat([encode(meta),encode({...meta,payload:{...meta.payload,id:"22222222-2222-4222-8222-222222222222"}})]),
      encode({...meta,payload:{id,cli_version:"0.99.0"}}),
      Buffer.concat([encode(meta),encode({type:"future_unknown",payload:{nested:[null,true,{raw:"<script>inert</script>"}]}})]),
      encode({...meta,payload:{...meta.payload,id:"22222222-2222-4222-8222-222222222222"}}),
      encode(row),Buffer.concat([encode(row),encode(meta)]),Buffer.from("\n\n"),
      Buffer.concat([encode(meta),Buffer.from([255,10])]),
      ...["{}\n","null\n","[]\n",'{"type":"future","x":1e400}\n','{"type":"future","x":"\\ud800"}\n',
        '{"type":"future","\\ud800":0}\n','{"type":"future"}{}\n','\ufeff{"type":"future"}\n',"\u0085\n","\u180e\n"].map(s=>Buffer.concat([encode(meta),Buffer.from(s)])),
      ...["paginated","future",null,3].flatMap(history_mode=>{const b=encode({...meta,payload:{...meta.payload,history_mode}});return[b,Buffer.concat([encode(meta),b])];}),
      ...[63,64].map(n=>Buffer.concat([encode(meta),Buffer.from(`{"type":"future","x":${"[".repeat(n)}null${"]".repeat(n)}}\n`)])),
      ...[64,65].map(n=>Buffer.concat([encode(meta),encode({type:"🐾".repeat(n)})])),
      ...["\t","\u000b","\u000c","\u00a0","\u1680","\u200a","\u2028","\u2029","\u202f","\u205f","\u3000","\ufeff"].map(s=>Buffer.concat([Buffer.from(s+"\n"),encode(meta)])),
    ];
    for(const [i,bytes] of corpus.entries()) {
      await fs.writeFile(file,bytes);const expected=raw.createRolloutSnapshot(bytes,options),value=await read(0,1);
      if(expected.kind==="codex_rollout_snapshot") {
        try { assert.equal(value.kind,"native_codex_validated_source_page",`corpus ${i}: ${value.code}`);
          assert.equal(value.rollout.sha256,expected.sha256);assert.equal(value.validation.recordsValidated,expected.recordCount);
          const old=raw.readRolloutPage(expected,{snapshotId:expected.snapshotId,offset:0,limit:1});
          assert.ok(value.pageBytes.equals(Buffer.from(old.records.map(r=>r.rawText).join(""))),`corpus ${i}`);
        } finally {raw.releaseRolloutSnapshot(expected);}
      } else { assert.equal(value.kind,"source_unavailable",`corpus ${i}`);assert.equal(value.code,expected.code,`corpus ${i}`); }
      assert.equal(active,0);differentialCases++;
    }
    cases.push("differential_existing_raw_contract_full_source_envelopes_and_errors");
    const small=Buffer.concat([Buffer.from("\r\n"),encode(meta),...richRecords("/owned-unused").map(encode),encode(row)]);
    await fs.writeFile(file,small);let offset=0,version,parts=[];
    do {const value=await read(offset,3);assert.equal(value.kind,"native_codex_validated_source_page",value.code);
      const next=wire.sourceVersion(value);if(version)assert.equal(wire.sameSourceVersion(version,next),true);else version=next;
      parts.push(value.pageBytes);assert.ok(value.nameIndexBytes.equals(names));offset=value.page.nextOffset;
    }while(offset!==null);
    assert.ok(Buffer.concat(parts).equals(small));cases.push("rich_all_pages_byte_exact_same_validation_and_version");
    const count=16384, record=encode({...row,payload:{...row.payload,message:"x".repeat(960)}}), metadata=encode(meta);
    const writer=await fs.open(file,"w",0o600);try{await writer.writeFile(metadata);for(let i=1;i<count;i++)await writer.writeFile(record);}finally{await writer.close();}
    validatedSize=metadata.length+(count-1)*record.length;assert.ok(validatedSize>16*1024*1024);
    let largeVersion;
    for(const [at,limit]of [[0,1],[10000,50],[count-2,50],[count,50]]) {
      const value=await read(at,limit);assert.equal(value.kind,"native_codex_validated_source_page",value.code);
      assert.equal(value.validation.recordsValidated,count);assert.equal(value.rollout.identity.size,validatedSize);
      if(at>0&&at<count)assert.equal(value.page.records[0].byteOffset,metadata.length+(at-1)*record.length);
      const current=wire.sourceVersion(value);if(largeVersion)assert.equal(wire.sameSourceVersion(largeVersion,current),true);else largeVersion=current;
      assert.equal(value.pageBytes.length,at===0?metadata.length:Math.min(limit,count-at)*record.length);
    }
    // The selected first page stays valid. A bad record far outside that page
    // must reject the WHOLE request; v10 still only observes these opaque bytes.
    const position=metadata.length+9999*record.length, edit=await fs.open(file,"r+");
    try {await edit.write(Buffer.from("!"),0,1,position);}finally{await edit.close();}
    assert.equal((await read(0,1)).code,"rollout_invalid_record");
    const opaque=await helper.readCodexPage(input(0,1));assert.equal(opaque.kind,"native_codex_source_page");assert.ok(opaque.pageBytes.equals(metadata));
    assert.equal(wire.sameSourceVersion(largeVersion,wire.sourceVersion(opaque)),false);
    const restore=await fs.open(file,"r+");try{await restore.write(Buffer.from("{"),0,1,position);}finally{await restore.close();}
    const recovered=await read(0,1);assert.equal(recovered.kind,"native_codex_validated_source_page",recovered.code);
    assert.equal(recovered.rollout.sha256,largeVersion.rollout.sha256);assert.equal(active,0);
    cases.push("large_16384_full_validation_first_middle_last_eof","malformed_unselected_record_no_partial_page_and_recovery");
    // A valid changed record also invalidates the whole version, not just pages.
    const mutate=await fs.open(file,"r+");try{await mutate.write(Buffer.from("z"),0,1,position+record.indexOf("xxx"));}finally{await mutate.close();}
    const changed=await read(0,1);assert.equal(changed.kind,"native_codex_validated_source_page",changed.code);assert.ok(changed.pageBytes.equals(metadata));
    assert.equal(wire.sameSourceVersion(largeVersion,wire.sourceVersion(changed)),false);
    cases.push("valid_unselected_change_invalidates_full_version");
    const before=spawned;assert.equal((await helper.readCodexValidatedPage({...input(),source:{...base.source,rolloutPath:"auth.json"}})).code,"invalid_source_input");assert.equal(spawned,before);
    assert.equal((await helper.readCodexValidatedPage({...input(),expectedRoot:{...base.expectedRoot,inode:"1"}})).code,"source_root_identity_changed");
    assert.equal((await helper.readCodex({...base})).code,"source_too_large");
    assert.ok((await fs.readFile(sentinel)).equals(sentinelBytes));cases.push("old_8mib_limit_and_root_scope_preserved");
  }
  assert.equal(active,0);assert.equal(spawned,reaped);assert.equal(helper.status().quarantined,false);passed=true;
} finally {
  if(helper)assert.equal((await helper.shutdown()).cleanupConfirmed,true);
  assert.equal(active,0);assert.equal(spawned,reaped);
  await fs.rm(temp,{recursive:true,force:true});await assert.rejects(fs.access(temp),{code:"ENOENT"});
  console.log(JSON.stringify({gate:"owned_codex_validated_source",passed,platform:process.platform,cases,differentialCases,validatedSourceBytes:validatedSize,
    spawnedChildren:spawned,reapedChildren:reaped,maximumConcurrentChildren:maxActive,remainingChildren:active,cleanupConfirmed:true,removedOwnedDirectories:1,
    privateHistoryReads:0,nativeInvocations:0,modelCalls:0,nativeProjectionComplete:false,hostWebConnected:false}));
}
