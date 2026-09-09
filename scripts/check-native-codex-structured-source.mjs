// Real Node -> Rust v12, owned sources only. No public Host or model invocation.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { createNativeHelper } = require("../protocol/native/claude/history-native-helper.js");
const wire = require("../protocol/native/codex/structured-source-wire.js");
const scanned = require("../protocol/native/codex/scanned-source-wire.js");
const old = require("../protocol/native/codex/rollout-structure.js");
const { richRecords } = require("../protocol/native/codex/history-fixture.js");
assert.equal(process.argv.length, 3); assert(path.isAbsolute(process.argv[2]));
const binary = path.resolve(process.argv[2]);
const created = await fs.mkdtemp(path.join(os.tmpdir(), "stepsemble-codex-structure-owned-"));
const temp = await fs.realpath(created), root = path.join(temp, "codex");
const id = "11111111-1111-4111-8111-111111111111", version = "0.153.4";
const locator = `sessions/2026/01/05/rollout-2026-01-05T12-00-00-${id}.jsonl`, file = path.join(root, locator);
const encode = v => Buffer.from(JSON.stringify(v) + "\n");
const meta = { type: "session_meta", payload: { id, cli_version: version, history_mode: "legacy" } };
const event = (type, extra = {}) => ({ type: "event_msg", payload: { type, ...extra } });
const turn_id = "original native turn 🐾", call_id = "original command ID";
const begin = event("exec_command_begin", { turn_id, call_id });
const end = event("exec_command_end", { turn_id, call_id });
const names = encode({ id, thread_name: "owned 原生名稱", updated_at: "2026-01-05T12:00:00Z" });
let helper, spawned = 0, reaped = 0, active = 0, maxActive = 0, passed = false, sourceBytes = 0;
const cases = [], readMs = [];
try {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await fs.writeFile(file, encode(meta), { flag: "wx", mode: 0o600 });
  await fs.writeFile(path.join(root, "session_index.jsonl"), names, { flag: "wx", mode: 0o600 });
  const sentinel = path.join(root, "auth.json"), sentinelBytes = Buffer.from("owned-sentinel-no-credential");
  await fs.writeFile(sentinel, sentinelBytes, { flag: "wx", mode: 0o600 });
  const stat = await fs.stat(root, { bigint: true });
  const base = { nativeVersion: version, source: { codexRoot: root, rolloutPath: locator, threadId: id },
    expectedRoot: { device: String(stat.dev), inode: String(stat.ino) } };
  const input = (offset = 0, limit = 1) => ({ ...base, page: { offset, limit } });
  helper = createNativeHelper({ executablePath: binary, trustBoundary: "host_managed_executable",
    platform: process.platform === "win32" ? "linux" : process.platform,
    spawnChild(...args) { const child = spawn(...args); spawned++; active++; maxActive = Math.max(maxActive, active);
      child.once("close", () => { reaped++; active--; }); return child; } });
  const read = async (offset = 0, limit = 1) => { const start = performance.now();
    const result = await helper.readCodexStructuredPage(input(offset, limit)); readMs.push(performance.now() - start);
    assert.equal(active, 0); return result; };
  const first = await read();
  if (process.platform === "win32") {
    assert.deepEqual(first, { kind: "source_unavailable", code: "source_platform_unsupported" });
    cases.push("actual_windows_v12_unsupported");
  } else {
    assert.equal(first.kind, "native_codex_structured_source_page", first.code);
    const small = Buffer.concat([encode(meta), ...richRecords("/owned-unused").map(encode)]);
    await fs.writeFile(file, small);
    const snapshot = old.createStructuredRolloutSnapshot(small, { threadId: id, nativeVersion: version });
    assert.equal(snapshot.kind, "codex_structured_rollout_snapshot");
    try {
      let offset = 0, sourceVersion; const pages = [];
      do {
        const value = await read(offset, 3), expected = old.readStructuredRolloutPage(snapshot, { snapshotId: snapshot.snapshotId, offset, limit: 3 });
        assert.equal(value.kind, "native_codex_structured_source_page", value.code);
        assert.deepEqual(value.structure, { structureProfile: "codex_legacy_selected_structure_v1", totalTurns: expected.totalTurns,
          retainedTurns: expected.retainedTurns, turns: expected.turns, annotations: expected.annotations });
        assert(value.pageBytes.equals(Buffer.from(expected.records.records.map(r => r.rawText).join(""))));
        assert(value.nameIndexBytes.equals(names)); pages.push(value.pageBytes);
        const current = wire.sourceVersion(value); assert(current);
        if (sourceVersion) assert.equal(wire.sameSourceVersion(sourceVersion, current), true); else sourceVersion = current;
        assert.equal(scanned.sourceVersion(value), null);
        offset = value.page.nextOffset;
      } while (offset !== null);
      assert(Buffer.concat(pages).equals(small)); cases.push("rich_all_pages_original_ids_byte_exact_global_structure");
    } finally { assert.equal(old.releaseStructuredRolloutSnapshot(snapshot), true); }
    const count = 16384, filler = event("agent_message", { message: "原文🐾" + "x".repeat(960) });
    const rowAt = i => i === 0 ? meta : i === 1 ? event("task_started", { turn_id }) : i === 2 ? begin : i === 10000 ? end
      : i === count - 2 ? event("task_complete", { turn_id }) : i === count - 1 ? event("thread_rolled_back", { num_turns: 1 }) : filler;
    async function writeLarge(duplicate = false) {
      const writer = await fs.open(file, "w", 0o600), hash = crypto.createHash("sha256"); sourceBytes = 0;
      try { for (let i = 0; i < count; i++) { const b = encode(duplicate && i === 15000 ? begin : rowAt(i));
        await writer.writeFile(b); hash.update(b); sourceBytes += b.length; } } finally { await writer.close(); }
      return hash.digest("hex");
    }
    const sourceHash = await writeLarge(); assert(sourceBytes > 16 * 1024 * 1024);
    let largeVersion;
    for (const [offset, limit] of [[0, 1], [2, 1], [9000, 50], [10000, 1], [count - 2, 50], [count, 50]]) {
      const value = await read(offset, limit); assert.equal(value.kind, "native_codex_structured_source_page", value.code);
      assert.equal(value.rollout.sha256, sourceHash); assert.equal(value.rollout.recordCount, count);
      assert.equal(value.rollout.identity.size, sourceBytes); assert.equal(value.validation.recordsValidated, count);
      assert.equal(value.structure.totalTurns, 1); assert.equal(value.structure.retainedTurns, 0);
      assert(value.pageBytes.equals(Buffer.concat(Array.from({ length: Math.min(limit, count - offset) }, (_, i) => encode(rowAt(offset + i))))));
      for (const t of value.structure.turns) { assert.equal(t.nativeTurnId, turn_id); assert.equal(t.recordedStatus, "completed");
        assert.equal(t.branchState, "rolled_back"); assert.equal(t.rollbackRecordIndex, count - 1); }
      if ([2, 10000].includes(offset)) { const tool = value.structure.annotations[0].tool;
        assert.equal(tool.nativeCallId, call_id); assert.equal(tool.relatedRecordIndex, offset === 2 ? 10000 : 2); }
      const current = wire.sourceVersion(value); if (largeVersion) assert.equal(wire.sameSourceVersion(largeVersion, current), true); else largeVersion = current;
    }
    cases.push("large_16384_first_middle_last_eof_and_both_cross_page_tool_edges");
    await writeLarge(true); const duplicate = await read(2, 1);
    assert.equal(duplicate.kind, "native_codex_structured_source_page", duplicate.code);
    assert.equal(duplicate.structure.annotations[0].tool.relatedRecordIndex, null);
    assert(duplicate.structure.annotations[0].warnings.includes("ambiguous_tool_reference"));
    assert.equal(wire.sameSourceVersion(largeVersion, wire.sourceVersion(duplicate)), false);
    cases.push("off_page_duplicate_revokes_existing_edge_and_version");
    const edit = await fs.open(file, "a"); try { await edit.writeFile(Buffer.from("!malformed\n")); } finally { await edit.close(); }
    assert.equal((await read(2, 1)).code, "rollout_invalid_record");
    await writeLarge(); const restored = await read(2, 1);
    assert.equal(restored.kind, "native_codex_structured_source_page", restored.code);
    assert.equal(restored.structure.annotations[0].tool.relatedRecordIndex, 10000);
    cases.push("off_page_corruption_no_partial_page_and_repair");
    const oldPage = await helper.readCodexValidatedPage(input(2, 1)); assert.equal(oldPage.kind, "native_codex_validated_source_page");
    assert.equal(wire.sourceVersion(oldPage), null); assert.equal(wire.sameSourceVersion(largeVersion, scanned.sourceVersion(oldPage)), false);
    const before = spawned;
    assert.equal((await helper.readCodexStructuredPage({ ...input(), source: { ...base.source, rolloutPath: "auth.json" } })).code, "invalid_source_input");
    assert.equal(spawned, before);
    assert.equal((await helper.readCodexStructuredPage({ ...input(), expectedRoot: { ...base.expectedRoot, inode: "1" } })).code, "source_root_identity_changed");
    assert.equal((await helper.readCodex(base)).code, "source_too_large");
    assert((await fs.readFile(sentinel)).equals(sentinelBytes)); cases.push("old_receipts_size_limit_root_and_auth_sentinel_preserved");
  }
  assert.equal(active, 0); assert.equal(spawned, reaped); assert.equal(helper.status().quarantined, false); passed = true;
} finally {
  if (helper) assert.equal((await helper.shutdown()).cleanupConfirmed, true);
  assert.equal(active, 0); assert.equal(spawned, reaped);
  await fs.rm(temp, { recursive: true, force: true }); await assert.rejects(fs.access(temp), { code: "ENOENT" });
  console.log(JSON.stringify({ gate: "owned_codex_structured_source", passed, platform: process.platform, cases, sourceBytes,
    maximumReadMs: Math.max(0, ...readMs), spawnedChildren: spawned, reapedChildren: reaped, maximumConcurrentChildren: maxActive,
    remainingChildren: active, cleanupConfirmed: true, removedOwnedDirectories: 1, privateHistoryReads: 0, nativeInvocations: 0,
    modelCalls: 0, nativeProjectionComplete: false, hostWebConnected: false }));
}
