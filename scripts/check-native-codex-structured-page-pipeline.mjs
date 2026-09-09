// Owned Rust v12 -> permissioned parser v9/v10 -> named SQLite consistency.
// Reuses the existing writer, helpers and two-reader admission; no private source.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { performance } from "node:perf_hooks";
import { createCodexHistoryPipeline } from "../protocol/native/codex/history-pipeline.js";
import wire from "../protocol/native/codex/parser-wire.js";

export async function checkCodexStructuredPagePipeline({ helperPath, admission, createHelper, spawnChild, counters, writer, ready, request, sqlSnapshot, claudeRead, codexRead }) {
  const root = await fs.realpath(ready.codexRoot), stat = await fs.stat(root, { bigint: true });
  const history = { nativeVersion: request.nativeVersion, source: { codexRoot: root, rolloutPath: ready.rolloutPath, threadId: ready.threadId },
    expectedRoot: { device: String(stat.dev), inode: String(stat.ino) } };
  const input = { history, sqlite: request, method: "thread_read_sqlite" }, file = path.join(root, ready.rolloutPath);
  const original = await fs.readFile(file); assert(original.length < 8192);
  const encode = value => Buffer.from(JSON.stringify(value) + "\n");
  const event = (type, extra = {}) => ({ type: "event_msg", payload: { type, ...extra } });
  const meta = { type: "session_meta", payload: { id: ready.threadId, cli_version: request.nativeVersion, history_mode: "legacy" } };
  const nativeTurnId = "original native turn 🐾", nativeCallId = "original command ID";
  const count = 16384, filler = event("agent_message", { message: "原文🐾" + "x".repeat(960) });
  const rowAt = index => index === 0 ? meta : index === 1 ? event("task_started", { turn_id: nativeTurnId })
    : index === 2 ? event("exec_command_begin", { turn_id: nativeTurnId, call_id: nativeCallId })
      : index === 10000 ? event("exec_command_end", { turn_id: nativeTurnId, call_id: nativeCallId })
        : index === count - 2 ? event("task_complete", { turn_id: nativeTurnId })
          : index === count - 1 ? event("thread_rolled_back", { num_turns: 1 }) : filler;
  const encodedSpecial = new Map([[0, encode(rowAt(0))], [1, encode(rowAt(1))], [2, encode(rowAt(2))], [10000, encode(rowAt(10000))],
    [count - 2, encode(rowAt(count - 2))], [count - 1, encode(rowAt(count - 1))]]), fillerBytes = encode(filler), overrides = new Map();
  const rowBytes = index => overrides.get(index) ?? encodedSpecial.get(index) ?? fillerBytes;
  const byteOffset = index => {
    let offset = index * fillerBytes.length;
    for (const [at, bytes] of encodedSpecial) if (at < index) offset += bytes.length - fillerBytes.length;
    return offset;
  };
  const sourceBytes = byteOffset(count); assert(sourceBytes > 17_000_000);
  let stage = 0, expectedSteps = [], cancellation = null, mutation = null, maxPageBytes = 0, maxStructureBytes = 0;
  let maxElapsedMs = 0, maxLoopGapMs = 0, ticks = 0;
  const attemptsBefore = counters().attempts;
  const pipeline = createCodexHistoryPipeline({ helperPath, admission, createHelper: options => {
    const helper = createHelper(options), methods = {};
    for (const method of ["readCodexNameContext", "readCodexStructuredPage"]) methods[method] = async (...args) => {
      const at = stage++; assert.equal(method, expectedSteps[at]);
      const pending = helper[method](...args); if (cancellation?.stage === at) cancellation.controller.abort();
      const result = await pending; assert.equal(helper.status().cleanupConfirmed, true);
      if (result.kind === "native_codex_structured_source_page") {
        maxPageBytes = Math.max(maxPageBytes, result.pageBytes.length);
        maxStructureBytes = Math.max(maxStructureBytes, result.structureBytes.length);
      }
      if (mutation?.stage === at) await mutation.work();
      return result;
    };
    return { ...helper, ...methods };
  }, spawnChild: (...args) => {
    const at = stage++; assert.equal("parser", expectedSteps[at]);
    const child = spawnChild(...args); if (cancellation?.stage === at) queueMicrotask(() => cancellation.controller.abort()); return child;
  } });
  async function mutateRecord(index, value, innerOffset = 0) {
    const updated = Buffer.from(rowBytes(index)); Buffer.from(value).copy(updated, innerOffset, 0, 1);
    const handle = await fs.open(file, "r+");
    try { await handle.write(Buffer.from(value), 0, 1, byteOffset(index) + innerOffset); overrides.set(index, updated); } finally { await handle.close(); }
  }
  async function snapshot() {
    const handle = await fs.open(file, "r"), hash = crypto.createHash("sha256");
    try { for await (const chunk of handle.createReadStream({ autoClose: false, highWaterMark: 65536 })) hash.update(chunk); }
    finally { await handle.close(); }
    return { rollout: hash.digest("hex"), index: crypto.createHash("sha256").update(await fs.readFile(path.join(root, "session_index.jsonl"))).digest("hex"), sql: await sqlSnapshot() };
  }
  async function runNamed(options = {}) {
    stage = 0; expectedSteps = ["readCodexNameContext", "readCodexStructuredPage", "parser", "readCodexNameContext", "readCodexStructuredPage"];
    const start = performance.now(); let previous = start;
    const timer = setInterval(() => { const now = performance.now(); maxLoopGapMs = Math.max(maxLoopGapMs, now - previous); previous = now; ticks++; }, 2);
    try {
      const result = await pipeline.readNamedStructuredPage(input, options); maxElapsedMs = Math.max(maxElapsedMs, performance.now() - start);
      assert.equal(counters().physical, 0); assert.equal(admission.status().cleanupConfirmed, true); assert.equal(admission.status().quarantined, false);
      return result;
    } finally { clearInterval(timer); }
  }
  async function runUnnamed(options = {}) {
    stage = 0; expectedSteps = ["readCodexStructuredPage", "parser"];
    const result = await pipeline.readStructuredPage(history, options);
    assert.equal(counters().physical, 0); assert.equal(admission.status().cleanupConfirmed, true); return result;
  }
  async function stable(options = {}) {
    const before = await snapshot(), result = await runNamed(options); assert.deepEqual(await snapshot(), before); return result;
  }
  const assertPage = (result, offset, limit) => {
    assert.equal(result.kind, "codex_named_structured_page_capture", result.code);
    assert.equal(result.page.kind, "codex_validated_rollout_records");
    assert.equal(result.page.recordCount, count); assert.equal(result.page.byteLength, sourceBytes);
    assert.equal(result.page.offset, offset); assert.equal(result.page.records.length, Math.min(limit, count - offset));
    assert.equal(result.page.endOfFile, offset + result.page.records.length === count);
    assert.equal(result.page.nextOffset, result.page.endOfFile ? null : offset + result.page.records.length);
    const expected = Buffer.concat(Array.from({ length: Math.min(limit, count - offset) }, (_, i) => rowBytes(offset + i))).toString();
    assert.equal(result.page.records.map(record => record.rawText).join(""), expected);
    if (offset < count) assert.equal(result.page.records[0].byteOffset, byteOffset(offset));
    assert.deepEqual(Object.keys(result.structure).sort(), ["annotations", "profile", "retainedTurns", "totalTurns", "turns"]);
    assert.equal(result.structure.profile, "codex_legacy_selected_structure_v1");
    assert.equal(result.structure.totalTurns, 1); assert.equal(result.structure.retainedTurns, 0);
    assert.equal(result.structure.annotations.length, result.page.records.length);
    for (const turn of result.structure.turns) {
      assert.equal(turn.nativeTurnId, nativeTurnId); assert.equal(turn.recordedStatus, "completed");
      assert.equal(turn.statusRecordIndex, count - 2); assert.equal(turn.branchState, "rolled_back"); assert.equal(turn.rollbackRecordIndex, count - 1);
    }
    assert.equal(result.sourceAuthenticated, false); assert.equal(result.publishable, false); assert.equal(result.semanticHistoryComplete, false);
  };
  try {
    const handle = await fs.open(file, "w");
    try {
      for (let start = 0; start < count; start += 64) {
        const batch = Buffer.concat(Array.from({ length: Math.min(64, count - start) }, (_, i) => rowBytes(start + i)));
        await handle.writeFile(batch);
      }
    } finally { await handle.close(); }
    const untouched = await snapshot(); stage = 0; expectedSteps = ["readCodexNameContext", "readCodexStructuredPage", "parser", "readCodexNameContext", "readCodexStructuredPage"];
    const first = pipeline.readNamedStructuredPage(input, { selection: { mode: "records", offset: 2, limit: 1 } }), peer = claudeRead();
    assert.equal(admission.status().activeWorkers, 2); assert.equal(counters().physical, 2);
    const busyBefore = counters().attempts; assert.equal((await codexRead()).code, "source_busy"); assert.equal(counters().attempts, busyBefore);
    const [initial, other] = await Promise.all([first, peer]); assertPage(initial, 2, 1);
    assert.equal(other.kind, "bound_history_observation", other.code); assert.equal(initial.name.name, "最新 WAL 名稱 🐾");
    assert.equal(initial.source.kind, "codex_named_structured_page_source_version"); assert.equal(initial.source.history.kind, "codex_structured_source_version");
    assert.equal(stage, 5); assert.deepEqual(await snapshot(), untouched);

    const unnamed = await runUnnamed({ selection: { mode: "records", offset: 1, limit: 1 }, expectedVersion: initial.source.history });
    assert.equal(unnamed.kind, "codex_parsed_structured_page_capture", unnamed.code); assert.equal(unnamed.page.records[0].rawText, rowBytes(1).toString());
    assert.equal(unnamed.structure.turns[0].nativeTurnId, nativeTurnId); assert.equal(stage, 2);

    const pages = [];
    for (const [offset, limit] of [[0, 1], [1, 1], [2, 1], [10000, 1], [count - 2, 2], [count, 50]]) {
      const result = await stable({ expectedVersion: initial.source, selection: { mode: "records", offset, limit } });
      assert.equal(stage, 5); assert(wire.sameStructuredNamedVersion(initial.source, result.source)); assert.equal(result.name.name, initial.name.name);
      assertPage(result, offset, limit);
      if ([2, 10000].includes(offset)) {
        const tool = result.structure.annotations[0].tool; assert.equal(tool.nativeCallId, nativeCallId);
        assert.equal(tool.relatedRecordIndex, offset === 2 ? 10000 : 2);
      }
      pages.push({ offset, records: result.page.records.length, nextOffset: result.page.nextOffset });
    }
    const names = await stable({ expectedVersion: initial.source, selection: { mode: "names" } });
    assert.equal(names.kind, "codex_named_structured_page_capture", names.code); assert.equal(names.name.name, initial.name.name);
    assert.equal(names.page, null); assert.equal(names.structure, null); assert(wire.sameStructuredNamedVersion(initial.source, names.source));

    await mutateRecord(15000, "!");
    assert.equal((await stable({ selection: { mode: "records", offset: 2, limit: 1 } })).code, "rollout_invalid_record"); assert.equal(stage, 2);
    await mutateRecord(15000, "{"); const restored = await stable({ selection: { mode: "records", offset: 2, limit: 1 } }); assertPage(restored, 2, 1);
    const messageOffset = fillerBytes.indexOf(Buffer.from("原文🐾")) + Buffer.byteLength("原文🐾");
    mutation = { stage: 1, work: () => mutateRecord(15000, "z", messageOffset) };
    assert.equal((await runNamed({ selection: { mode: "records", offset: 2, limit: 1 } })).code, "source_version_changed"); mutation = null; assert.equal(stage, 5);
    assert.equal((await stable({ expectedVersion: restored.source, selection: { mode: "records", offset: 2, limit: 1 } })).code, "source_version_changed"); assert.equal(stage, 2);
    const changed = await stable({ selection: { mode: "records", offset: 2, limit: 1 } }); assertPage(changed, 2, 1);

    await writer.command("rename");
    assert.equal((await stable({ expectedVersion: changed.source, selection: { mode: "records", offset: 2, limit: 1 } })).code, "source_version_changed"); assert.equal(stage, 1);
    const renamed = await stable({ selection: { mode: "records", offset: 2, limit: 1 } }); assert.equal(renamed.name.name, "renamed");
    const mutations = [];
    for (const [at, command] of [[1, "preview"], [1, "path"], [1, "index"], [3, "index"]]) {
      mutation = { stage: at, work: () => writer.command(command) };
      const result = await runNamed({ selection: { mode: "records", offset: 2, limit: 1 } }); mutation = null;
      assert.equal(result.code, "source_version_changed", command); mutations.push({ afterCaptureStage: at + 1, command, refused: true });
      if (command === "path") await writer.command("plain_path");
    }
    for (const at of [0, 1, 2, 3, 4]) {
      cancellation = { stage: at, controller: new AbortController() };
      assert.equal((await stable({ signal: cancellation.controller.signal, selection: { mode: "records", offset: 2, limit: 1 } })).code, "source_aborted");
      cancellation = null; assert.equal(stage, at + 1); assert.equal(admission.status().quarantined, false);
    }
    const final = await stable({ selection: { mode: "records", offset: 15000, limit: 1 } }); assertPage(final, 15000, 1);
    assert.equal(final.page.records[0].rawText.includes("原文🐾z"), true); assert.equal(final.name.nativeTitleResolved, false);
    return { gate: "posix_owned_named_structured_page_pipeline_passed", sourceBytes, recordCount: count, pages, mutations,
      actualReaderAndParserSpawns: counters().attempts - attemptsBefore, maximumPhysicalChildren: counters().maximum, remainingChildren: counters().physical,
      sequence: ["v5_sqlite_a", "v12_structured_page_a", "permissioned_v10_parser", "v5_sqlite_b", "v12_structured_page_b"],
      unnamedSequence: ["v12_structured_page", "permissioned_v9_parser"], crossHarnessSharedAdmission: true, actualClaudeSdkPeer: true,
      cancellationStages: 5, outsidePageChangeFenced: true, malformedOutsidePageRefused: true, exactPageBytesPreserved: true,
      originalTurnAndToolIdsPreserved: true, crossPageToolEdgesPreserved: true, globalTurnCountsPreserved: true, pageIndependentSourceVersion: true,
      nameSelectionCovered: true, dualHistoryAndSqlVersionFence: true, indexMutationFencedBeforeAndAfterParse: true,
      sourceFilesUnchangedDuringReads: true, maxSelectedPageBytes: maxPageBytes, maxStructureBytes, maxElapsedMs,
      maxMainLoopGapMs: maxLoopGapMs, mainLoopTicks: ticks, measurementScope: "owned_pipeline_only_not_Host_Web_or_RSS",
      privateHistoryReads: 0, modelCalls: 0, nativeCodexLaunches: 0, nativeProjectionComplete: false, hostWebConnected: false, cleanupConfirmed: true };
  } finally {
    assert.equal((await pipeline.shutdown()).cleanupConfirmed, true, "retain owned writer if reader cleanup is unknown");
    await writer.command("reset"); assert.deepEqual(await fs.readFile(file), original);
  }
}
