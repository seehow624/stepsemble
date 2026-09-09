#!/usr/bin/env node
// Full application, owner wizard, pinned writer/reader and typed HTTP; owned data only.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import path from "node:path";
import http from "node:http";
import { once } from "node:events";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import { startSyntheticCodexHistoryHost } from "./history-codex-host-synthetic.mjs";
import transport from "../public/modules/history-transport.js";
import projection from "../public/modules/projection.js";

export async function checkCodexHostNative({ helperPath, onProgress = () => {} }) {
  const started = performance.now();
  const host = await startSyntheticCodexHistoryHost({ helperPath }); let cleanup;
  const mark = async stage => onProgress({ gate: "codex_owned_host_progress", stage, elapsedMs: Math.round(performance.now() - started),
    parentRssBytes: process.memoryUsage().rss, ...await host.diagnostics() });
  const viewId = crypto.randomUUID(), cookie = `stepsemble=${crypto.createHash("sha256").update(host.token).digest("hex")}`;
  const client = transport.create({ origin: host.origin, hostId: "owned-codex-host", viewId, canonicalJSON: projection.canonicalJSON,
    fetch: (url, init) => fetch(url, { ...init, headers: { ...init.headers, origin: host.origin, cookie } }) });
  const catalog = (refresh = true) => client.sourceCatalog({ sourceId: "owned-codex", snapshotId: null, page: { offset: 0, limit: 50 }, refresh });
  const metadata = p => client.sourceMetadata({ sourceId: p.sourceId, catalogId: p.entries[0].catalogId, snapshotId: p.snapshotId, requestId: crypto.randomUUID() });
  const register = p => client.register({ catalogId: p.entries[0].catalogId, viewId });
  const read = (r, offset = 0, version) => client.readCodex({ hostId: "owned-codex-host", bindingId: r.bindingId, generation: r.generation, sessionId: r.sessionId },
    { bindingId: r.bindingId, generation: r.generation, requestId: crypto.randomUUID() }, { page: { offset, limit: 10 }, signal: undefined, ...(version ? { version } : {}) });
  const release = r => client.release({ bindingId: r.bindingId, generation: r.generation });
  try {
    await mark("host_ready");
    assert.equal(host.setupResult.created, true); assert.equal(host.setupResult.sourceReads, 0);
    assert.equal((await client.catalog()).entries.length, 0);
    const sources = await client.sources(); assert.equal(sources.sources.length, 1); assert.equal(sources.sources[0].scope, "stored_threads");
    assert.equal((await catalog(false)).snapshotId, null, "startup and settings never implicitly scan");
    let p = await catalog(); assert.equal(p.total, 1);
    assert.equal((await metadata(p)).metadata.nativeTitle, "最新 WAL 名稱 🐾");
    let r = await register(p); assert.equal(r.kind, "history_registration", r.code);
    const first = await read(r); assert.equal(first.kind, "bound_codex_records", first.code);
    assert.equal(first.history.nativeThreadId, host.threadId); assert.equal(first.history.records.recordCount, 39);
    const records = [...first.history.records.records]; let cursor = first.history.records.nextOffset;
    while (cursor !== null) {
      const next = await read(r, cursor, first.sourceVersion); assert.equal(next.kind, "bound_codex_records", next.code);
      assert.equal(next.history.records.offset, records.length); records.push(...next.history.records.records); cursor = next.history.records.nextOffset;
    }
    assert.equal(records.length, 39); assert.equal(new Set(records.map(row => row.recordIndex)).size, 39);
    assert.equal(records.at(-1).recordType, "future_owned_record");
    assert(records.some(row => row.payloadType === "function_call")); assert(records.some(row => row.payloadType === "function_call_output"));
    assert(records.every(row => row.rawText.endsWith("\r\n"))); assert.equal(first.history.semanticHistoryComplete, false);
    await mark("plain_all_pages");
    for (const command of ["compress", "compress_concat", "compress_corrupt"]) {
      const before = await read(r); assert.equal(before.kind, "bound_codex_records");
      await host.mutate(command);
      assert.equal((await read(r, 10, before.sourceVersion)).code, "source_version_changed");
      const compressed = await read(r);
      if (command === "compress_corrupt") assert.equal(compressed.code, "rollout_compression_invalid");
      else {
        assert.equal(compressed.kind, "bound_codex_records", compressed.code);
        const all = [...compressed.history.records.records]; let next = compressed.history.records.nextOffset;
        while (next !== null) { const page = await read(r, next, compressed.sourceVersion); assert.equal(page.kind, "bound_codex_records", page.code);
          all.push(...page.history.records.records); next = page.history.records.nextOffset; }
        assert.deepEqual(all, records); assert.equal((await metadata(p)).metadata.nativeTitle, first.history.nativeTitle);
      }
      await host.mutate("restore_plain");
      if (command !== "compress_corrupt") assert.equal((await read(r, 10, compressed.sourceVersion)).code, "source_version_changed");
      assert.equal((await read(r)).history.records.recordCount, 39, "plain sibling has priority even over corrupt compressed data");
      await host.mutate("clear_compressed");
      await mark(command);
    }
    await release(r); await host.mutate("compress"); await host.mutate("compressed_path"); p = await catalog();
    assert.equal(p.total, 1); assert.equal((await metadata(p)).metadata.nativeTitle, first.history.nativeTitle);
    r = await register(p); assert.equal((await read(r)).history.records.recordCount, 39, "explicit compressed SQLite locator is selectable");
    await host.mutate("restore_plain"); assert.equal((await read(r)).history.records.recordCount, 39, "explicit compressed selector still prefers its plain sibling");
    await host.mutate("clear_compressed"); await release(r); await host.mutate("plain_path"); p = await catalog(); r = await register(p);
    const beforeCold = await read(r);
    await mark("explicit_compressed_path_and_plain_priority");
    await host.mutate("cold");
    assert.equal((await read(r, 10, beforeCold.sourceVersion)).code, "source_version_changed", "same title, new cold layout invalidates a hot continuation");
    await host.mutate("compress_concat");
    const cold = await read(r); assert.equal(cold.kind, "bound_codex_records", cold.code);
    assert.equal(cold.history.nativeTitle, first.history.nativeTitle);
    const coldRecords = [...cold.history.records.records]; let coldCursor = cold.history.records.nextOffset;
    while (coldCursor !== null) {
      const page = await read(r, coldCursor, cold.sourceVersion); assert.equal(page.kind, "bound_codex_records", page.code);
      coldRecords.push(...page.history.records.records); coldCursor = page.history.records.nextOffset;
    }
    assert.deepEqual(coldRecords, records, "closed writer retains every raw record and page boundary");
    await mark("cold_compressed_all_pages");
    await release(r); p = await catalog(); assert.equal(p.total, 1);
    assert.equal((await metadata(p)).metadata.nativeTitle, first.history.nativeTitle); r = await register(p);
    await host.mutate("restore_plain"); await host.mutate("clear_compressed");
    await host.mutate("partial_sidecar");
    assert.equal((await catalog()).kind, "source_unavailable", "partial files are not an empty catalog");
    assert.equal((await read(r)).kind, "source_unavailable", "no repair, model call or hidden stale cache");
    await host.mutate("remove_partial_sidecar");
    const recoveredCold = await read(r); assert.equal(recoveredCold.kind, "bound_codex_records");
    await host.mutate("reopen");
    assert.equal((await read(r, 10, recoveredCold.sourceVersion)).code, "source_version_changed", "same title, reopened WAL cannot continue a cold page");
    const reopened = await read(r); assert.equal(reopened.history.nativeTitle, first.history.nativeTitle);
    await mark("cold_partial_recovery_and_reopen");
    await host.mutate("rename"); assert.equal((await read(r, 10, reopened.sourceVersion)).code, "source_version_changed");
    assert.equal((await read(r)).history.nativeTitle, "renamed"); assert.equal((await release(r)).cleanupConfirmed, true);
    p = await catalog(); assert.equal((await metadata(p)).metadata.nativeTitle, "renamed");
    await host.mutate("paginated"); p = await catalog();
    assert.equal((await metadata(p)).metadata.nativeTitle, "paginated name");
    r = await register(p); assert.equal((await read(r)).code, "native_paginated_history_unsupported"); await release(r);
    await host.mutate("path"); p = await catalog(); assert.equal(p.total, 1, "unsafe selector is visible, not silently dropped");
    assert.equal((await metadata(p)).code, "source_scope_mismatch"); assert.equal((await register(p)).kind, "source_unavailable");
    await host.mutate("reset"); await host.mutate("rich_rollout"); p = await catalog();
    r = await register(p); assert.equal((await read(r)).history.records.recordCount, 39); await release(r);
    await host.mutate("missing"); p = await catalog(); assert.equal(p.total, 0); assert.equal(p.entries.length, 0);
    await mark("empty_and_main_cleanup_start");
  } finally { cleanup = await host.close(); }
  await mark("main_cleanup_completed");
  const rejectedMutation = await startSyntheticCodexHistoryHost({ helperPath });
  try {
    await rejectedMutation.mutate("compress"); await assert.rejects(rejectedMutation.mutate("compress"), error => {
      assert.equal(error.message, "synthetic_owned_compression_already_active");
      assert.equal(typeof error.actual, "boolean"); return true;
    });
    await rejectedMutation.mutate("restore_plain"); await rejectedMutation.mutate("clear_compressed");
  } finally { assert.equal((await rejectedMutation.close()).cleanupConfirmed, true); }
  await mark("mutation_failure_cleanup_completed");
  // A failed startup must still await actual Host close and stop its owned
  // writer. The fixture rethrows the original error only after that cleanup.
  const occupied = http.createServer(); occupied.listen(0, "127.0.0.1"); await once(occupied, "listening");
  try {
    await assert.rejects(startSyntheticCodexHistoryHost({ helperPath, port: occupied.address().port }), /synthetic_codex_host_early_exit/);
  } finally { await new Promise(resolve => occupied.close(resolve)); }
  await mark("startup_failure_cleanup_completed");
  return { gate: "codex_actual_host_passed", records: 39, sourceScope: "stored_threads", semanticHistoryComplete: false,
    createdConfigUsedUnedited: true, explicitInventory: true, walRenameAndStalePage: true, coldCatalogAndAllPages: true,
    bothLayoutTransitionsRejectStalePage: true, partialSidecarsRefusedWithoutRepair: true, paginatedExplicitUnavailable: true,
    compressedAllPagesAndNames: true, concatenatedAndColdCompressed: true, corruptRefusedAndPlainPriority: true, explicitCompressedCatalogLocator: true,
    unsafePathNotOpened: true, emptyCatalog: true, startupFailureCleanup: true, rejectedMutationRecoveryAndCleanup: true, noClaudeSdk: true, modelCalls: 0, privateHistoryReads: 0, ...cleanup };
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  assert.equal(process.argv.length, 3); console.log(JSON.stringify(await checkCodexHostNative({ helperPath: process.argv[2], onProgress: value => console.log(JSON.stringify(value)) })));
}
