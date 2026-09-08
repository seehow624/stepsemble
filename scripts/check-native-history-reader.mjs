// Owned fixtures only. Explicit-root inventory/capture, never HOME discovery,
// private histories, a model smoke, or a live route.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { createNativeHelper } = require("../protocol/native/claude/history-native-helper.js");
const { createSourceIndex } = require("../protocol/native/claude/history-source-index.js");
const { parseHistoryBytes } = require("../protocol/native/claude/history-source.js");
const digest = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const target = process.env.CARGO_TARGET_DIR;
assert(target && path.isAbsolute(target), "explicit local CARGO_TARGET_DIR required");
const binary = path.join(target, "debug", `stepsemble-history-source-reader${process.platform === "win32" ? ".exe" : ""}`);
assert((await fs.lstat(binary)).isFile(), "build the owned helper first");
const artifactSha256 = digest(await fs.readFile(binary)); // Reproducibility, not executed-bytes authentication.
const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "stepsemble-reader-check-")));
let helper, index, cleanup = true;
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
  const inventoryInput = { projectsRoot: root, expectedRoot: input.expectedRoot };
  helper = createNativeHelper({executablePath:binary,trustBoundary:"host_managed_executable"});
  if (process.platform === "win32") {
    assert.equal((await helper.read(input)).code, "source_platform_unsupported");
    assert.equal((await helper.inventory(inventoryInput)).code, "source_platform_unsupported");
    // The actual compiled executable must also reject, not merely the Node gate.
    for (const protocolVersion of [1, 2]) {
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
      child.stdin.end(JSON.stringify({protocolVersion,nonce:"a".repeat(64),...(protocolVersion === 1 ? input : inventoryInput)}));
    });
    assert.equal(frame.readUInt32BE(0), frame.length-4);
    const header = JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(frame.subarray(4)));
    assert.deepEqual(header,{protocolVersion,nonce:"a".repeat(64),result:{kind:"source_unavailable",code:"source_platform_unsupported"}});
    }
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
    const inventory = await helper.inventory(inventoryInput);
    assert.equal(inventory.kind, "native_source_inventory", inventory.code);
    assert.equal(inventory.entryCount, 1); assert.equal(inventory.projectsScanned, 1);
    assert.equal(inventory.entries[0].sessionId, sessionId); assert.equal(inventory.entries[0].identity.size, bytes.length);
    assert.equal(inventory.cleanupConfirmed, true);
    index = createSourceIndex({ sourceId: "owned-claude-fixture", source: inventoryInput, helperPath: binary, authorize: p => p === "synthetic-owner" });
    assert.equal(index.view("synthetic-owner").snapshot, null);
    assert.equal((await index.refresh("not-authorized")).code, "history_source_unavailable");
    const firstIndex = await index.refresh("synthetic-owner");
    assert.equal(firstIndex.stale, false); assert.equal(firstIndex.snapshot.entries.length, 1);
    const originalId = firstIndex.snapshot.entries[0].catalogId;
    const secondFile = path.join(project, "33333333-3333-4333-8333-333333333333.jsonl");
    await fs.writeFile(secondFile, "metadata inventory must not parse this content\n", { mode: 0o600, flag: "wx" });
    try {
      const changed = await index.refresh("synthetic-owner");
      assert.equal(changed.snapshot.entries[0].catalogId, originalId);
      assert.deepEqual(changed.snapshot.changes, { added: 1, changed: 0, removed: 0 });
      await fs.chmod(secondFile, 0o660);
      assert.equal((await index.refresh("synthetic-owner")).code, "source_owner_or_mode");
      const stale = index.view("synthetic-owner"); assert.equal(stale.stale, true); assert.equal(stale.snapshot.entries.length, 2);
    } finally { await fs.unlink(secondFile); }
    const restored = await index.refresh("synthetic-owner"); assert.equal(restored.stale, false);
    assert.deepEqual(restored.snapshot.changes, { added: 0, changed: 0, removed: 1 });
    assert.equal((await index.shutdown()).cleanupConfirmed, true);
  }
  assert.equal(digest(await fs.readFile(file)),digest(bytes),"owned source unchanged");
  const status = await helper.shutdown();
  assert.equal(status.cleanupConfirmed,true); assert.equal(status.quarantined,false);
  console.log(JSON.stringify({result:"passed",platform:process.platform,arch:process.arch,artifactSha256,
    rawReaderGate:process.platform==="win32"?"source_platform_unsupported":"posix_owned_fixture_passed",
    inventoryGate:process.platform==="win32"?"source_platform_unsupported":"metadata_incremental_stale_recovery_passed",
    windowsPermissionProbe:"see_cargo_test_results",nativeSourceAuthenticated:false,
    originalFixtureUnchanged:true,modelCalls:0,privateHistoryReads:0,productionWiring:false,cleanupConfirmed:true}));
} finally {
  if (index) cleanup = (await index.shutdown()).cleanupConfirmed && cleanup;
  if (helper) cleanup = (await helper.shutdown()).cleanupConfirmed && cleanup;
  if (cleanup) await fs.rm(temp,{recursive:true,force:true});
  else throw new Error("owned_fixture_preserved_cleanup_unconfirmed");
}
