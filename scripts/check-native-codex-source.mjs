// Actual compiled Rust -> bounded Node -> raw snapshot, owned synthetic files only.
// No native Codex launch, HOME discovery, account, model or production Host.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createNativeHelper } from "../protocol/native/claude/history-native-helper.js";
import { sourceVersion, sameSourceVersion } from "../protocol/native/codex/source-wire.js";
import { createRolloutSnapshot, readRolloutPage, releaseRolloutSnapshot } from "../protocol/native/codex/rollout-snapshot.js";
import { richRecords } from "../protocol/native/codex/history-fixture.js";
import { observeCapturedNameIndex } from "../protocol/native/codex/name-index.js";

const target = process.env.CARGO_TARGET_DIR;
assert(target && path.isAbsolute(target), "explicit local CARGO_TARGET_DIR required");
const binary = path.join(target, "debug", `stepsemble-history-source-reader${process.platform === "win32" ? ".exe" : ""}`);
assert((await fs.lstat(binary)).isFile(), "build the owned helper first");
const hash = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const artifactSha256 = hash(await fs.readFile(binary));
const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "stepsemble-codex-capture-")));
const snapshots = []; let helper, cleanup = true, spawns = 0;
try {
  const root = path.join(temp, "source"), threadId = "11111111-1111-4111-8111-111111111111";
  const stem = `rollout-2026-01-05T12-00-00-${threadId}`;
  const rolloutPath = `sessions/2026/01/05/${stem}.jsonl`, file = path.join(root, rolloutPath), index = path.join(root, "session_index.jsonl");
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const raw = Buffer.from([ { timestamp: "2026-01-05T12:00:00Z", type: "session_meta", payload: { id: threadId, history_mode: "legacy", cli_version: "0.153.4" } },
    ...richRecords(temp).map(v => ({ ...v, timestamp: "2026-01-05T12:00:00Z" })) ].map(v => JSON.stringify(v)).join("\r\n") + "\r\n");
  const names = Buffer.from(JSON.stringify({ id: threadId, thread_name: "完整原生名稱 🐾 ".repeat(12), updated_at: "2026-01-05T12:00:00Z" }) + "\n");
  await fs.writeFile(file, raw, { mode: 0o600, flag: "wx" }); await fs.writeFile(index, names, { mode: 0o600, flag: "wx" });
  // Unrelated files are present but must not become selectable helper inputs.
  const sentinel = path.join(root, "auth.json"); await fs.writeFile(sentinel, "owned-sentinel-not-a-credential", { mode: 0o600, flag: "wx" });
  const rootStat = await fs.stat(root, { bigint: true });
  const request = { nativeVersion: "0.153.4", source: { codexRoot: root, rolloutPath, threadId }, expectedRoot: { device: String(rootStat.dev), inode: String(rootStat.ino) } };
  helper = createNativeHelper({ executablePath: binary, trustBoundary: "host_managed_executable",
    // Trusted fixture override bypasses only Node's platform precheck on Windows
    // so the actual Windows binary must emit unsupported. No POSIX proof is inferred.
    platform: process.platform === "win32" ? "linux" : process.platform,
    spawnChild(...args) { spawns++; return spawn(...args); } });
  const first = await helper.readCodex(request);
  if (process.platform === "win32") {
    assert.deepEqual(first, { kind: "source_unavailable", code: "source_platform_unsupported" }); assert.equal(spawns, 1);
  } else {
    assert.equal(first.kind, "native_codex_source_bytes", first.code); assert.equal(first.cleanupConfirmed, true);
    assert.deepEqual(first.rolloutBytes, raw); assert.deepEqual(first.nameIndexBytes, names);
    assert.equal(first.sourceAuthenticated, false); assert.equal(first.publishable, false);
    const version = sourceVersion(first); assert.ok(version); assert.equal(sameSourceVersion(version, sourceVersion(first)), true);
    const named = observeCapturedNameIndex(first); assert.equal(named.kind, "codex_name_index_observation");
    assert.equal(named.readCandidate, "完整原生名稱 🐾 ".repeat(12)); assert.equal(named.listCandidate, named.readCandidate.trim());
    assert.equal(named.nativeTitleResolved, false); assert.equal(sameSourceVersion(version, named.sourceVersion), true);
    const snapshot = createRolloutSnapshot(first.rolloutBytes, { nativeVersion: first.nativeVersion, threadId }); snapshots.push(snapshot);
    assert.equal(snapshot.kind, "codex_rollout_snapshot", snapshot.code);
    let offset = 0; const rows = [];
    do { const page = readRolloutPage(snapshot, { snapshotId: snapshot.snapshotId, offset, limit: 2 });
      assert.equal(page.kind, "codex_rollout_records"); rows.push(...page.records); offset = page.nextOffset;
    } while (offset !== null);
    assert.deepEqual(Buffer.from(rows.map(row => row.rawText).join("")), raw);
    assert.equal(rows.filter(row => ["exec_command_begin", "exec_command_end", "view_image_tool_call"].includes(row.payloadType)).length, 3);
    first.rolloutBytes.fill(0); first.nameIndexBytes.fill(0);
    assert.equal(observeCapturedNameIndex(first).kind, "codex_history_unavailable"); assert.equal(named.readCandidate, "完整原生名稱 🐾 ".repeat(12));
    assert.equal(readRolloutPage(snapshot, { snapshotId: snapshot.snapshotId, offset: 0, limit: 1 }).records[0].recordType, "session_meta");
    // New title bytes, same bytes with new inode, and absent vs empty index fence separately.
    const replacement = path.join(root, "owned-replacement");
    await fs.writeFile(replacement, names, { mode: 0o600, flag: "wx" }); await fs.rename(replacement, index);
    const swapped = await helper.readCodex(request); assert.equal(swapped.kind, "native_codex_source_bytes");
    assert.equal(sameSourceVersion(version, sourceVersion(swapped)), false);
    await fs.writeFile(index, Buffer.concat([names, names]));
    const appended = await helper.readCodex(request); assert.equal(appended.kind, "native_codex_source_bytes");
    assert.equal(sameSourceVersion(sourceVersion(swapped), sourceVersion(appended)), false);
    await fs.unlink(index); const missing = await helper.readCodex(request); assert.equal(missing.kind, "native_codex_source_bytes"); assert.equal(missing.nameIndexBytes, null);
    await fs.writeFile(index, Buffer.alloc(0), { mode: 0o600, flag: "wx" });
    const empty = await helper.readCodex(request); assert.equal(empty.kind, "native_codex_source_bytes"); assert.equal(empty.nameIndexBytes.length, 0);
    assert.equal(observeCapturedNameIndex(missing).presence, "missing"); assert.equal(observeCapturedNameIndex(empty).presence, "empty");
    assert.equal(sameSourceVersion(sourceVersion(missing), sourceVersion(empty)), false);
    await fs.writeFile(index, names);
    const archive = `archived_sessions/${stem}_22222222-2222-4222-8222-222222222222.jsonl`;
    await fs.mkdir(path.join(root, "archived_sessions"), { mode: 0o700 }); await fs.writeFile(path.join(root, archive), raw, { mode: 0o600, flag: "wx" });
    const archived = await helper.readCodex({ ...request, source: { ...request.source, rolloutPath: archive } });
    assert.equal(archived.kind, "native_codex_source_bytes"); assert.deepEqual(archived.rolloutBytes, raw);
    assert.equal(sameSourceVersion(version, sourceVersion(archived)), false);
    assert.equal((await helper.readCodex({ ...request, source: { ...request.source, rolloutPath: rolloutPath + ".zst" } })).code, "source_encoding_unsupported");
    assert.equal((await helper.readCodex({ ...request, expectedRoot: { ...request.expectedRoot, inode: String(rootStat.ino + 1n) } })).code, "source_root_identity_changed");
    await fs.chmod(index, 0o660);
    try { assert.equal((await helper.readCodex(request)).code, "source_owner_or_mode"); } finally { await fs.chmod(index, 0o600); }
    const count = spawns;
    assert.equal((await helper.readCodex({ ...request, source: { ...request.source, rolloutPath: "auth.json" } })).code, "invalid_source_input"); assert.equal(spawns, count);
  }
  assert.deepEqual(await fs.readFile(file), raw); assert.deepEqual(await fs.readFile(index), names);
  assert.equal(await fs.readFile(sentinel, "utf8"), "owned-sentinel-not-a-credential");
  const status = await helper.shutdown(); assert.equal(status.cleanupConfirmed, true); assert.equal(status.quarantined, false);
  console.log(JSON.stringify({ result: "passed", platform: process.platform, arch: process.arch, artifactSha256,
    codexPairCapture: process.platform === "win32" ? "source_platform_unsupported_actual_binary" : "posix_owned_fixture_passed",
    byteExactRawPaging: process.platform !== "win32", pairVersionFences: process.platform !== "win32", spawns,
    nameIndexBytesInterpreted: process.platform !== "win32", nativeTitleResolved: false,
    sourceFilesUnchangedAtEnd: true, privateHistoryReads: 0, nativeCliLaunches: 0, modelCalls: 0,
    sourceAuthenticated: false, publishable: false, semanticHistoryComplete: false, productionWiring: false, cleanupConfirmed: true }));
} finally {
  for (const snapshot of snapshots) releaseRolloutSnapshot(snapshot);
  if (helper) cleanup = (await helper.shutdown()).cleanupConfirmed && cleanup;
  if (cleanup) await fs.rm(temp, { recursive: true, force: true });
  else throw new Error("owned_codex_source_fixture_preserved_cleanup_unconfirmed");
}
