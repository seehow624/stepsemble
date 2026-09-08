// Owned fixtures only. This is not source discovery, a model smoke, or a live route.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { createNativeHelper } = require("../protocol/native/claude/history-native-helper.js");
const { parseHistoryBytes } = require("../protocol/native/claude/history-source.js");
const digest = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const target = process.env.CARGO_TARGET_DIR;
assert(target && path.isAbsolute(target), "explicit local CARGO_TARGET_DIR required");
const binary = path.join(target, "debug", `stepsemble-history-source-reader${process.platform === "win32" ? ".exe" : ""}`);
assert((await fs.lstat(binary)).isFile(), "build the owned helper first");
const artifactSha256 = digest(await fs.readFile(binary)); // Reproducibility, not executed-bytes authentication.
const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "stepsemble-reader-check-")));
let helper, cleanup = true;
try {
  const root = path.join(temp, "projects"), project = path.join(root, "owned");
  await fs.mkdir(project, { recursive: true, mode: 0o700 });
  const sessionId = "11111111-1111-1111-1111-111111111111";
  const file = path.join(project, `${sessionId}.jsonl`);
  const bytes = Buffer.from(JSON.stringify({type:"user",sessionId,uuid:"22222222-2222-2222-2222-222222222222",parentUuid:null,
    message:{role:"user",content:"Owned synthetic history — 繁體中文 🐾"}}) + "\n");
  await fs.writeFile(file, bytes, { mode: 0o600, flag: "wx" });
  const rootStat = await fs.stat(root, { bigint: true });
  const input = {source:{projectsRoot:root,projectKey:"owned",sessionId},expectedRoot:{device:String(rootStat.dev),inode:String(rootStat.ino)}};
  helper = createNativeHelper({executablePath:binary,trustBoundary:"host_managed_executable"});
  if (process.platform === "win32") {
    assert.equal((await helper.read(input)).code, "source_platform_unsupported");
    // The actual compiled executable must also reject, not merely the Node gate.
    const frame = await new Promise((resolve, reject) => {
      const child = spawn(binary, [], {env:{},stdio:["pipe","pipe","pipe"],shell:false});
      let output = Buffer.alloc(0), fault = false, closed = false, killSent = false;
      const stop = () => { fault = true; if (!closed && !killSent) { killSent=true; try { child.kill(); } catch { /* close remains authoritative */ } } };
      const timeout = setTimeout(stop, 10000);
      const cleanupTimer = setTimeout(() => { if (!closed) { cleanup = false; reject(new Error("owned_cli_cleanup_unconfirmed")); } }, 11000);
      child.on("error", stop);
      for (const stream of [child.stdin,child.stdout,child.stderr]) stream.on("error",stop);
      child.stdout.on("data", chunk => { if (fault || closed) return; if (output.length + chunk.length > 16388) stop(); else output = Buffer.concat([output,chunk]); });
      child.stderr.on("data", stop);
      child.once("close", code => { closed=true; clearTimeout(timeout); clearTimeout(cleanupTimer); if(fault || code!==0) reject(new Error("owned_cli_failed")); else resolve(output); });
      child.stdin.end(JSON.stringify({protocolVersion:1,nonce:"a".repeat(64),...input}));
    });
    assert.equal(frame.readUInt32BE(0), frame.length-4);
    const header = JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(frame.subarray(4)));
    assert.deepEqual(header,{protocolVersion:1,nonce:"a".repeat(64),result:{kind:"source_unavailable",code:"source_platform_unsupported"}});
  } else {
    const first = await helper.read(input);
    assert.equal(first.kind,"native_source_bytes",first.code);
    assert.equal(first.cleanupConfirmed,true);
    assert.equal(first.sourceAuthenticated,false); assert.equal(first.publishable,false);
    assert.deepEqual(first.bytes,bytes);
    assert.equal(first.sha256,digest(bytes));
    const parsed = parseHistoryBytes(first.bytes,sessionId);
    assert.equal(parsed.kind,"source_records",parsed.code);
    assert.equal(parsed.records.length,1);
    // Caller root-identity mismatch rejects before any success payload.
    const wrong = await helper.read({...input,expectedRoot:{...input.expectedRoot,inode:String(rootStat.ino+1n)}});
    assert.equal(wrong.code,"source_root_identity_changed");
    assert.equal(Object.hasOwn(wrong,"bytes"),false);
    await fs.chmod(file,0o660);
    try { assert.equal((await helper.read(input)).code,"source_owner_or_mode"); }
    finally { await fs.chmod(file,0o600); }
    const last = await helper.read(input);
    assert.equal(last.kind,"native_source_bytes",last.code);
    assert.deepEqual(last.bytes,bytes);
  }
  assert.equal(digest(await fs.readFile(file)),digest(bytes),"owned source unchanged");
  const status = await helper.shutdown();
  assert.equal(status.cleanupConfirmed,true); assert.equal(status.quarantined,false);
  console.log(JSON.stringify({result:"passed",platform:process.platform,arch:process.arch,artifactSha256,
    rawReaderGate:process.platform==="win32"?"source_platform_unsupported":"posix_owned_fixture_passed",
    windowsPermissionProbe:"see_cargo_test_results",nativeSourceAuthenticated:false,
    originalFixtureUnchanged:true,modelCalls:0,privateHistoryReads:0,productionWiring:false,cleanupConfirmed:true}));
} finally {
  if (helper) cleanup = (await helper.shutdown()).cleanupConfirmed && cleanup;
  if (cleanup) await fs.rm(temp,{recursive:true,force:true});
  else throw new Error("owned_fixture_preserved_cleanup_unconfirmed");
}
