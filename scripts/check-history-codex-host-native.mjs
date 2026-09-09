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
import codexView from "../public/modules/codex-history-view.js";

export async function checkCodexHostNative({ helperPath, onProgress = () => {} }) {
  const started = performance.now();
  const host = await startSyntheticCodexHistoryHost({ helperPath }); let cleanup, largeResult;
  const mark = async stage => onProgress({ gate: "codex_owned_host_progress", stage, elapsedMs: Math.round(performance.now() - started),
    parentRssBytes: process.memoryUsage().rss, ...await host.diagnostics() });
  const viewId = crypto.randomUUID(), cookie = `stepsemble=${crypto.createHash("sha256").update(host.token).digest("hex")}`;
  const client = transport.create({ origin: host.origin, hostId: "owned-codex-host", viewId, canonicalJSON: projection.canonicalJSON,
    fetch: (url, init) => fetch(url, { ...init, headers: { ...init.headers, origin: host.origin, cookie } }) });
  const catalog = (refresh = true) => client.sourceCatalog({ sourceId: "owned-codex", snapshotId: null, page: { offset: 0, limit: 50 }, refresh });
  const metadata = p => client.sourceMetadata({ sourceId: p.sourceId, catalogId: p.entries[0].catalogId, snapshotId: p.snapshotId, requestId: crypto.randomUUID() });
  const register = p => client.register({ catalogId: p.entries[0].catalogId, viewId });
  const read = (r, offset = 0, version, structured = false) => client.readCodex({ hostId: "owned-codex-host", bindingId: r.bindingId, generation: r.generation, sessionId: r.sessionId },
    { bindingId: r.bindingId, generation: r.generation, requestId: crypto.randomUUID() }, { page: { offset, limit: 10 }, signal: undefined, ...(version ? { version } : {}), ...(structured ? { structured: true } : {}) });
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
    await host.mutate("structured_rollout"); p = await catalog(); r = await register(p);
    const linked = await read(r, 0, undefined, true); assert.equal(linked.kind, "bound_codex_records", linked.code);
    assert.equal(linked.history.structure.totalTurns, 3); assert.equal(linked.history.structure.retainedTurns, 2);
    const linkedRows = [], annotations = [], turns = new Map(); let linkedPage = linked;
    for (;;) {
      linkedRows.push(...linkedPage.history.records.records); annotations.push(...linkedPage.history.structure.annotations);
      for (const turn of linkedPage.history.structure.turns) turns.set(turn.turnKey, turn);
      if (linkedPage.history.records.nextOffset === null) break;
      linkedPage = await read(r, linkedPage.history.records.nextOffset, linked.sourceVersion, true);
      assert.equal(linkedPage.kind, "bound_codex_records", linkedPage.code);
    }
    assert.equal(linkedRows.length, 23); assert.equal(annotations[4].tool.relatedRecordIndex, 13); assert.equal(annotations[13].tool.relatedRecordIndex, 4);
    assert.equal(turns.get("record-15").branchState, "rolled_back"); assert.equal(turns.get("record-20").recordedStatus, "unknown");
    assert.equal(turns.get("record-20").nativeTurnId, null); assert(linkedRows[3].rawText.includes("END-OF-OWNED-LONG-TEXT"));
    const plainLinked = await read(r, 0, linked.sourceVersion); assert.equal(plainLinked.history.structure, undefined);
    assert.deepEqual(plainLinked.history.records, linked.history.records);
    await host.mutate("compress_concat"); assert.equal((await read(r, 10, linked.sourceVersion, true)).code, "source_version_changed");
    const compressedLinked = await read(r, 0, undefined, true); assert.deepEqual(compressedLinked.history.structure, linked.history.structure);
    await host.mutate("restore_plain"); await host.mutate("clear_compressed"); await release(r);
    assert.equal((await read(r, 0, undefined, true)).kind, "source_unavailable"); await mark("structured_turns_tools_raw_roundtrip_and_revocation");
    await host.mutate("reset"); await host.mutate("large_rollout"); p = await catalog();
    assert.equal((await metadata(p)).metadata.nativeTitle, "最新 WAL 名稱 🐾");
    const requests = [], timings = [], healthTimes = [], hostRssSamples = [];
    const model = codexView.createModel({ hostId: "owned-codex-host", viewId, catalogId: p.entries[0].catalogId,
      initialStructured: true, canonicalJSON: projection.canonicalJSON, requestId: crypto.randomUUID,
      transport: { ...client, async readCodex(scope, request, options) {
        const before = performance.now(); requests.push({ offset: options.page.offset, profile: options.profile, version: options.version });
        let monitoring = true;
        const monitor = (async () => {
          while (monitoring) {
            const beforeHealth = performance.now(), health = await fetch(host.origin + "/api/health", { headers: { cookie }, signal: AbortSignal.timeout(5000) });
            assert.equal(health.status, 200); await health.arrayBuffer(); healthTimes.push(performance.now() - beforeHealth);
            const diagnostic = await host.diagnostics(); if (diagnostic.hostRssBytes !== null) hostRssSamples.push(diagnostic.hostRssBytes);
            await new Promise(resolve => setTimeout(resolve, 200));
          }
        })();
        // Install a handler immediately; failures remain fatal after read cleanup.
        const observed = monitor.then(() => null, error => error);
        try { const result = await client.readCodex(scope, request, options); timings.push(performance.now() - before); return result; }
        finally { monitoring = false; const error = await observed; if (error) throw error; }
      } } });
    try {
      await model.select(p.entries[0].catalogId); let state = model.state(); assert.equal(state.error, null, state.error);
      assert.deepEqual(requests.slice(0, 2).map(r => r.profile), [undefined, "codex_structured_page_v1"]);
      const firstLarge = state.page; assert.equal(firstLarge.history.records.recordCount, 16384);
      assert(firstLarge.history.records.byteLength > 16 * 1024 * 1024);
      assert.equal(firstLarge.history.structure.profile, "codex_legacy_selected_structure_v1");
      assert.equal(firstLarge.history.structure.totalTurns, 2); assert.equal(firstLarge.history.structure.retainedTurns, 1);
      assert.equal(firstLarge.history.structure.annotations[3].tool.relatedRecordIndex, 10000);
      const turn = firstLarge.history.structure.turns.find(t => t.turnKey === "record-2");
      assert.equal(turn.nativeTurnId, "owned-large-native-turn 🐾"); assert.equal(turn.recordedStatus, "completed");
      assert.equal(turn.branchState, "rolled_back"); assert.equal(turn.rollbackRecordIndex, 16382);
      assert(firstLarge.history.records.records[1].rawText.includes("END-OF-OWNED-LARGE-TEXT"));
      assert.equal(firstLarge.history.nativeTitle, "最新 WAL 名稱 🐾");
      await model.next(); await model.previous(); assert.equal(model.state().page.history.records.offset, 0);
      await model.jump(10000); state = model.state(); assert.equal(state.page.history.records.offset, 10000);
      assert.equal(state.page.sourceVersion, firstLarge.sourceVersion); assert(state.page.history.records.records[0].rawText.includes("owned-large-10000"));
      assert.equal(state.page.history.structure.annotations[0].tool.relatedRecordIndex, 3);
      assert.equal(state.page.history.structure.annotations[0].tool.nativeCallId, "owned-large-native-call 🐾");
      assert.equal(state.page.history.structure.turns[0].nativeTurnId, turn.nativeTurnId);
      await model.jump(3); assert.equal(model.state().page.history.structure.annotations[0].tool.relatedRecordIndex, 10000);
      await model.jump(16380); state = model.state(); assert.equal(state.canNext, false); assert.equal(state.page.history.records.records.length, 4);
      assert(state.page.history.records.records.at(-1).rawText.includes("END-OF-OWNED-LARGE-HISTORY"));
      await host.mutate("large_append"); await model.jump(0); assert.equal(model.state().error, "source_version_changed");
      assert.equal(model.state().stale, true); await model.refresh(); assert.equal(model.state().page.history.records.recordCount, 16385);
      await host.mutate("rename"); await model.next(); assert.equal(model.state().error, "source_version_changed");
      await model.refresh(); assert.equal(model.state().page.history.nativeTitle, "renamed");
      await host.mutate("large_invalid_outside"); await model.refresh(); assert.equal(model.state().error, "rollout_invalid_record");
      await host.mutate("large_repair"); await model.refresh(); assert.equal(model.state().error, null);
      await model.setStructured(false); assert.equal(requests.at(-1).profile, "codex_validated_page_v1");
      assert.equal(model.state().page.history.structure, undefined);
      healthTimes.sort((a, b) => a - b);
      largeResult = { bytes: firstLarge.history.records.byteLength, records: 16384, maximumPageRecords: 10,
        nextPreviousAndDirectJump: true, originalNameAndRename: true, appendVersionFence: true, offPageCorruptionRefusedAndRepaired: true,
        sameTypedWebModel: true, maxRequestMs: Math.max(...timings), readRequests: requests.length,
        globalSelectedStructure: true, nativeIdsPreserved: true, crossPageToolLinks: true, rollbackOutsidePagePreserved: true,
        nativeProjectionComplete: false,
        healthDuringReads: { samples: healthTimes.length, p95Ms: healthTimes[Math.ceil(healthTimes.length * .95) - 1], maxMs: Math.max(...healthTimes) },
        hostRss: { samples: hostRssSamples.length, maxObservedBytes: hostRssSamples.length ? Math.max(...hostRssSamples) : null,
          scope: "200ms_samples_not_peak_RSS_or_capacity" } };
      await host.mutate("many_records"); await model.refresh();
      const many = model.state(); assert.equal(many.error, null, many.error); assert.equal(many.profile, "codex_validated_page_v1");
      assert(many.page.history.records.byteLength < 8 * 1024 * 1024); assert.equal(many.page.history.records.recordCount, 16384);
      largeResult.smallBytesManyRecords = { bytes: many.page.history.records.byteLength, records: 16384, oldRecordLimitNegotiation: true };
    } finally { await model.close(); assert.equal(model.state().page, null); assert.equal(model.state().cleanupPending, false); }
    await mark("large_history_actual_host_web_model_and_cleanup");
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
    structuredRecords: 23, structuredTurns: 3, crossPageToolLinks: true, rollbackPreserved: true, structuredRawRoundtrip: true, largeHistory: largeResult,
    unsafePathNotOpened: true, emptyCatalog: true, startupFailureCleanup: true, rejectedMutationRecoveryAndCleanup: true, noClaudeSdk: true, modelCalls: 0, privateHistoryReads: 0, ...cleanup };
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  assert.equal(process.argv.length, 3); console.log(JSON.stringify(await checkCodexHostNative({ helperPath: process.argv[2], onProgress: value => console.log(JSON.stringify(value)) })));
}
