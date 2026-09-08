// Actual, owned-only v5 -> v3 -> permissioned parser -> v5 -> v3 gate.
// The independent pinned writer owns both roots and all fixture mutations.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { createCodexHistoryPipeline } from "../protocol/native/codex/history-pipeline.js";
import wire from "../protocol/native/codex/parser-wire.js";

export async function checkCodexNamedPipeline({ helperPath, admission, createHelper, spawnChild, counters, writer, ready, request, sqlSnapshot, claudeRead, codexRead }) {
  const codexRoot = await fs.realpath(ready.codexRoot), rootStat = await fs.stat(codexRoot, { bigint: true });
  const history = { nativeVersion: request.nativeVersion, source: { codexRoot, threadId: ready.threadId, rolloutPath: ready.rolloutPath },
    expectedRoot: { device: String(rootStat.dev), inode: String(rootStat.ino) } };
  const input = { history, sqlite: request, method: "thread_read_sqlite" }, stages = [], captures = [];
  let stage = 0, mutation = null, cancel = null;
  const beforeAttempts = counters().attempts;
  const pipeline = createCodexHistoryPipeline({ helperPath, admission, createHelper: options => {
    const helper = createHelper(options), methods = {};
    for (const method of ["readCodexNameContext", "readCodex"]) methods[method] = async (...args) => {
      const current = stage++; stages.push(method);
      assert.equal(method, [0, 3].includes(current) ? "readCodexNameContext" : "readCodex");
      const pending = helper[method](...args); if (cancel?.stage === current) cancel.controller.abort();
      const result = await pending;
      assert.equal(helper.status().cleanupConfirmed, true); assert.equal(helper.status().activeWorker, false);
      if (result.kind === "native_sqlite_name_context") { assert(result.metadata.shmMappingsClosed > 0); captures.push(result.metadata.requestedReadBytes); }
      if (mutation?.stage === current) await writer.command(mutation.command);
      return result;
    };
    return { ...helper, ...methods };
  }, spawnChild: (...args) => {
    const current = stage++; assert.equal(current, 2); stages.push("parser"); const child = spawnChild(...args);
    if (cancel?.stage === current) queueMicrotask(() => cancel.controller.abort()); return child;
  } });
  async function sourceSnapshot() {
    const files = [path.join(codexRoot, ready.rolloutPath), path.join(codexRoot, "session_index.jsonl")], hashes = [];
    for (const file of files) { const bytes = await fs.readFile(file); hashes.push(crypto.createHash("sha256").update(bytes).digest("hex")); }
    return { sql: await sqlSnapshot(), hashes };
  }
  function read(options = {}, selected = input) { stage = 0; return pipeline.readNamed(selected, options); }
  async function stableRead(options = {}, selected = input) {
    const before = await sourceSnapshot(), result = await read(options, selected);
    assert.deepEqual(await sourceSnapshot(), before, "named reads/errors/cancels never modify either owned source");
    assert.equal(counters().physical, 0); assert.equal(admission.status().cleanupConfirmed, true); assert.equal(admission.status().quarantined, false);
    return result;
  }
  try {
    const untouched = await sourceSnapshot(), first = read(), peer = claudeRead();
    assert.equal(admission.status().activeWorkers, 2); assert.equal(counters().physical, 2);
    const busy = counters().attempts; assert.equal((await codexRead()).code, "source_busy"); assert.equal(counters().attempts, busy);
    const [initial, nativePeer] = await Promise.all([first, peer]); assert.equal(nativePeer.kind, "bound_history_observation", nativePeer.code);
    assert.equal(initial.kind, "codex_named_capture", initial.code); assert.equal(initial.name.name, "最新 WAL 名稱 🐾");
    assert.equal(stage, 5); assert(wire.sameNamedVersion(initial.source, initial.source));
    assert.deepEqual(await sourceSnapshot(), untouched);
    const raw = read({ expectedVersion: initial.source, selection: { mode: "records", offset: 0, limit: 2 } }), other = codexRead();
    assert.equal(admission.status().activeWorkers, 2); const again = counters().attempts;
    assert.equal((await claudeRead()).code, "source_busy"); assert.equal(counters().attempts, again);
    const [page, old] = await Promise.all([raw, other]); assert.equal(old.kind, "codex_parsed_capture", old.code);
    assert.equal(page.kind, "codex_named_capture", page.code); assert.equal(page.page.records.length, 2);
    assert.equal(page.page.records.map(r => r.rawText).join(""), await fs.readFile(path.join(codexRoot, ready.rolloutPath), "utf8"));
    assert.deepEqual(await sourceSnapshot(), untouched);

    await writer.command("fallback"); const readFallback = await stableRead(), listFallback = await stableRead({}, { ...input, method: "thread_list_state_row" });
    assert.equal(readFallback.name.name, "  owned index 🐾  "); assert.equal(readFallback.name.candidateSource, "legacy_index_single_read");
    assert.equal(listFallback.name.name, null); assert.equal(listFallback.name.suppressedByPreview, true);
    await writer.command("paginated"); const paginated = await stableRead();
    assert.equal(paginated.name.name, "paginated name"); assert.equal(paginated.name.candidateSource, "sqlite_paginated_name");
    assert.equal((await stableRead({ selection: { mode: "records", offset: 0, limit: 2 } })).code, "native_paginated_history_unsupported");

    const mutations = [];
    for (const [at, command] of [[1, "rename"], [1, "preview"], [1, "path"], [1, "index"], [1, "rollout"], [3, "index"]]) {
      await writer.command("reset"); mutation = { stage: at, command };
      const result = await read(); mutation = null;
      assert.equal(result.code, "source_version_changed", command); assert.equal(counters().physical, 0);
      assert.equal(stage, ["rename", "preview", "path"].includes(command) ? 4 : 5);
      mutations.push({ afterCaptureStage: at + 1, command, refused: true });
    }
    await writer.command("reset"); const fresh = await stableRead();
    await writer.command("rename"); assert.equal((await stableRead({ expectedVersion: fresh.source })).code, "source_version_changed"); assert.equal(stage, 1);
    await writer.command("reset"); assert.equal((await stableRead({ expectedVersion: fresh.source })).code, "source_version_changed"); assert.equal(stage, 2);
    for (const at of [0, 1, 2, 3, 4]) {
      cancel = { stage: at, controller: new AbortController() };
      const result = await stableRead({ signal: cancel.controller.signal }); cancel = null;
      assert.equal(result.code, "source_aborted"); assert.equal(stage, at + 1);
    }
    await writer.command("path"); assert.equal((await stableRead()).code, "name_resolution_rollout_mismatch"); assert.equal(stage, 3);
    await writer.command("reset"); const final = await stableRead(); assert.equal(final.name.name, initial.name.name);
    assert.equal(final.sourceAuthenticated, false); assert.equal(final.publishable, false); assert.equal(final.name.nativeTitleResolved, false);
    return { gate: "posix_owned_named_pipeline_passed", actualReaderAndParserSpawns: counters().attempts - beforeAttempts,
      actualSqliteCaptures: captures.length, everySqliteCaptureMappedShm: true, maximumSqliteReadBytes: Math.max(...captures),
      sequence: ["v5_sqlite_a", "v3_bytes_a", "permissioned_parser", "v5_sqlite_b", "v3_bytes_b"], crossHarnessSharedAdmission: true,
      maximumPhysicalChildren: counters().maximum, remainingChildren: counters().physical, actualCancellationStages: 5, mutations,
      exactBothSourceBytesPreserved: true, expectedCompositeVersionFenced: true, rawPageBytesPreserved: true,
      paginatedMetadataOnly: true, paginatedCompleteHistoryUnsupported: true, inertPathNotFollowed: true,
      cleanupConfirmed: true, atomicCrossSourceSnapshot: false, nativeTitleResolved: false, productionWiring: false, privateHistoryReads: 0, modelCalls: 0 };
  } finally { assert.equal((await pipeline.shutdown()).cleanupConfirmed, true, "retain owned writer if reader cleanup is unknown"); }
}
