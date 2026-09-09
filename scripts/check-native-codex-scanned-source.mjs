// Actual Node helper -> Rust v10, owned byte fixtures ONLY. No account/model,
// source discovery, native JSON semantics, HTTP endpoint or private histories.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { createNativeHelper } = require("../protocol/native/claude/history-native-helper.js");
const wire = require("../protocol/native/codex/scanned-source-wire.js");
const sha = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
if (process.argv.length !== 3 || !path.isAbsolute(process.argv[2])) throw new Error("explicit_owned_helper_required");
const binary = process.argv[2], created = await fs.mkdtemp(path.join(os.tmpdir(), "stepsemble-codex-scanned-owned-"));
const temp = await fs.realpath(created), root = path.join(temp, "codex");
const id = "11111111-1111-4111-8111-111111111111", stem = `rollout-2026-01-05T12-00-00-${id}.jsonl`;
const rolloutPath = `sessions/2026/01/05/${stem}`, file = path.join(root, rolloutPath), index = path.join(root, "session_index.jsonl");
let helper, spawned = 0, reaped = 0, active = 0, maxActive = 0, success = false;
const observed = [];
try {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const original = Buffer.from("first🐾\r\n \r\nthird\nfourth\n"), names = Buffer.from("owned name index, not a semantic fixture\n");
  const sentinel = path.join(root, "auth.json"), sentinelBytes = Buffer.from("owned-sentinel-not-a-credential");
  await fs.writeFile(file, original, { flag: "wx", mode: 0o600 });
  await fs.writeFile(index, names, { flag: "wx", mode: 0o600 });
  await fs.writeFile(sentinel, sentinelBytes, { flag: "wx", mode: 0o600 });
  const stat = await fs.stat(root, { bigint: true });
  const base = { nativeVersion: "0.153.4", source: { codexRoot: root, rolloutPath, threadId: id },
    expectedRoot: { device: String(stat.dev), inode: String(stat.ino) } };
  const input = (offset = 0, limit = 2) => ({ ...base, page: { offset, limit } });
  helper = createNativeHelper({ executablePath: binary, trustBoundary: "host_managed_executable",
    // Windows bypasses only the Node precheck to test the REAL unsupported
    // binary response; it does not get a fabricated POSIX source proof.
    platform: process.platform === "win32" ? "linux" : process.platform,
    spawnChild(...args) { const child = spawn(...args); spawned++; active++; maxActive = Math.max(maxActive, active);
      child.once("close", () => { reaped++; active--; }); return child; } });
  const first = await helper.readCodexPage(input());
  if (process.platform === "win32") {
    assert.deepEqual(first, { kind: "source_unavailable", code: "source_platform_unsupported" });
    observed.push("actual_windows_v10_unsupported_no_posix_proof");
  } else {
    assert.equal(first.kind, "native_codex_source_page", first.code);
    assert.equal(first.rollout.sha256, sha(original)); assert.equal(first.rollout.recordCount, 4);
    assert.equal(first.recordSemanticsValidated, false); assert.equal(first.publishable, false);
    assert.equal(first.checks.matchingRolloutDigests, true); assert.equal(Object.hasOwn(first.checks, "matchingBytes"), false);
    assert.equal(first.cleanupConfirmed, true); assert.ok(first.nameIndexBytes.equals(names));
    const next = await helper.readCodexPage(input(2)), eof = await helper.readCodexPage(input(4));
    assert.equal(next.kind, "native_codex_source_page", next.code); assert.equal(eof.kind, "native_codex_source_page", eof.code);
    assert.ok(Buffer.concat([first.pageBytes, next.pageBytes]).equals(original));
    assert.equal(next.page.nextOffset, null); assert.equal(eof.pageBytes.length, 0);
    assert.equal(wire.sameSourceVersion(wire.sourceVersion(first), wire.sourceVersion(next)), true);
    assert.ok((await fs.readFile(file)).equals(original));
    observed.push("all_small_pages_raw_offsets_digests_index_and_eof_unchanged");
    const legacy = await helper.readCodex(base); assert.equal(legacy.kind, "native_codex_source_bytes", legacy.code);
    assert.equal(legacy.rollout.sha256, first.rollout.sha256); assert.ok(legacy.rolloutBytes.equals(original));
    assert.equal((await helper.readCodexPage({ ...input(), expectedRoot: { ...base.expectedRoot, inode: "1" } })).code, "source_root_identity_changed");
    const countBefore = spawned;
    assert.equal((await helper.readCodexPage({ ...input(), source: { ...base.source, rolloutPath: "auth.json" } })).code, "invalid_source_input");
    assert.equal(spawned, countBefore); observed.push("wrong_root_and_unselectable_sentinel_refused");
    // Stream a >8MiB, >8192-record source to disk, retaining one fixture record.
    const row = Buffer.alloc(1024, 97); row[row.length - 1] = 10;
    const writer = await fs.open(file, "w", 0o600), count = 16384;
    try { for (let i = 0; i < count; i++) await writer.writeFile(row); } finally { await writer.close(); }
    assert.equal((await helper.readCodex(base)).code, "source_too_large");
    let version;
    for (const [offset, limit] of [[0, 2], [10000, 50], [count - 2, 50], [count, 50]]) {
      const value = await helper.readCodexPage(input(offset, limit));
      assert.equal(value.kind, "native_codex_source_page", value.code); assert.equal(value.rollout.identity.size, 16 * 1024 * 1024);
      const returned = Math.min(limit, count - offset);
      assert.equal(value.rollout.recordCount, count); assert.equal(value.page.records.length, returned);
      assert.ok(value.pageBytes.equals(Buffer.concat(Array.from({ length: returned }, () => row))));
      if (offset !== count) assert.equal(value.page.records[0].byteOffset, offset * row.length);
      const current = wire.sourceVersion(value); if (version) assert.equal(wire.sameSourceVersion(version, current), true); else version = current;
      assert.equal(value.cleanupConfirmed, true); assert.equal(active, 0);
    }
    const beforeStat = await fs.stat(file); assert.equal(beforeStat.size, 16 * 1024 * 1024);
    const edit = await fs.open(file, "r+"); try { await edit.write(Buffer.from("z"), 0, 1, 10000 * row.length); } finally { await edit.close(); }
    const changed = await helper.readCodexPage(input()); assert.equal(changed.kind, "native_codex_source_page", changed.code);
    assert.ok(changed.pageBytes.equals(Buffer.concat([row, row]))); assert.equal(wire.sameSourceVersion(version, wire.sourceVersion(changed)), false);
    observed.push("large_16mib_16384_records_first_middle_last_eof_bounded","unselected_record_change_invalidates_full_version_not_selected_bytes");
    await fs.writeFile(file, original);
    await fs.unlink(index); const absent = await helper.readCodexPage(input());
    await fs.writeFile(index, Buffer.alloc(0), { flag: "wx", mode: 0o600 }); const empty = await helper.readCodexPage(input());
    assert.equal(absent.nameIndexBytes, null); assert.equal(empty.nameIndexBytes.length, 0);
    assert.equal(wire.sameSourceVersion(wire.sourceVersion(absent), wire.sourceVersion(empty)), false);
    const replacement = path.join(root, "owned-replacement"); await fs.writeFile(replacement, names, { flag: "wx", mode: 0o600 }); await fs.rename(replacement, index);
    const replaced = await helper.readCodexPage(input()); assert.equal(replaced.kind, "native_codex_source_page", replaced.code);
    assert.equal(wire.sameSourceVersion(wire.sourceVersion(first), wire.sourceVersion(replaced)), false);
    assert.ok(replaced.nameIndexBytes.equals(names));
    observed.push("missing_empty_and_replaced_name_index_fenced");
    for (const [raw, expected] of [[Buffer.from("ok\ntail"), "source_incomplete_tail"], [Buffer.alloc(131073, 97), "source_record_limit"], [Buffer.alloc(0), "source_empty"]]) {
      await fs.writeFile(file, raw); assert.equal((await helper.readCodexPage(input())).code, expected);
    }
    await fs.writeFile(file, original);
    const compressedInput = { ...input(), source: { ...base.source, rolloutPath: rolloutPath + ".zst" } };
    assert.equal((await helper.readCodexPage(compressedInput)).storage.rolloutPath, rolloutPath);
    await fs.rename(file, file + ".zst"); assert.equal((await helper.readCodexPage(input())).code, "source_encoding_unsupported");
    await fs.rename(file + ".zst", file);
    const archive = `archived_sessions/rollout-2026-01-05T12-00-00-${id}_22222222-2222-4222-8222-222222222222.jsonl`;
    await fs.mkdir(path.join(root, "archived_sessions"), { mode: 0o700 }); await fs.writeFile(path.join(root, archive), original, { mode: 0o600, flag: "wx" });
    assert.equal((await helper.readCodexPage({ ...input(), source: { ...base.source, rolloutPath: archive } })).kind, "native_codex_source_page");
    observed.push("tail_record_empty_errors_no_partial_page_and_recovery","compressed_explicit_refusal_plain_priority_and_archived_revert_locator");
  }
  assert.ok((await fs.readFile(sentinel)).equals(sentinelBytes));
  assert.equal(active, 0); assert.equal(spawned, reaped); assert.equal(helper.status().quarantined, false);
  success = true;
} finally {
  if (helper) { const result = await helper.shutdown(); assert.equal(result.cleanupConfirmed, true); }
  assert.equal(active, 0); assert.equal(spawned, reaped);
  // Only the exact directory created by this script, never a source/root input.
  await fs.rm(temp, { recursive: true, force: true });
  await assert.rejects(fs.access(temp), { code: "ENOENT" });
  console.log(JSON.stringify({ gate: "owned_codex_scanned_source", passed: success, platform: process.platform, cases: observed,
    spawnedChildren: spawned, reapedChildren: reaped, maximumConcurrentChildren: maxActive, remainingChildren: active,
    cleanupConfirmed: true, removedOwnedDirectories: 1, privateHistoryReads: 0, nativeInvocations: 0, modelCalls: 0,
    nativeSemanticsValidated: false, hostWebConnected: false }));
}
