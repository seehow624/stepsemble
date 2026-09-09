// Uses the existing owned SQLite writer and real shared Claude admission.
// No new source grant, test account, reader pool or private-history entrypoint.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { performance } from "node:perf_hooks";
import { createCodexHistoryPipeline } from "../protocol/native/codex/history-pipeline.js";
import wire from "../protocol/native/codex/parser-wire.js";

export async function checkCodexPagePipeline({ helperPath, admission, createHelper, spawnChild, counters, writer, ready, request, sqlSnapshot, claudeRead, codexRead }) {
  const root = await fs.realpath(ready.codexRoot), stat = await fs.stat(root, { bigint: true });
  const history = { nativeVersion: request.nativeVersion, source: { codexRoot: root, rolloutPath: ready.rolloutPath, threadId: ready.threadId },
    expectedRoot: { device: String(stat.dev), inode: String(stat.ino) } };
  const input = { history, sqlite: request, method: "thread_read_sqlite" }, file = path.join(root, ready.rolloutPath);
  const original = await fs.readFile(file); assert(original.length < 8192);
  const meta = original.subarray(0, original.indexOf(10) + 1);
  const row = Buffer.from(JSON.stringify({ type: "event_msg", payload: { type: "agent_message", message: "x".repeat(960) } }) + "\n");
  const count = 16384, sourceBytes = meta.length + (count - 1) * row.length;
  assert(sourceBytes > 16 * 1024 * 1024);
  let stage = 0, cancellation = null, mutation = null, maxPageBytes = 0, maxElapsedMs = 0, maxLoopGapMs = 0, ticks = 0;
  const before = counters().attempts;
  const pipeline = createCodexHistoryPipeline({ helperPath, admission, createHelper: options => {
    const helper = createHelper(options), methods = {};
    for (const method of ["readCodexNameContext", "readCodexValidatedPage"]) methods[method] = async (...args) => {
      const at = stage++;
      assert.equal(method, [0, 3].includes(at) ? "readCodexNameContext" : "readCodexValidatedPage");
      const pending = helper[method](...args); if (cancellation?.stage === at) cancellation.controller.abort();
      const result = await pending; assert.equal(helper.status().cleanupConfirmed, true);
      if (result.kind === "native_codex_validated_source_page") maxPageBytes = Math.max(maxPageBytes, result.pageBytes.length);
      if (mutation?.stage === at) await mutation.work();
      return result;
    };
    return { ...helper, ...methods };
  }, spawnChild: (...args) => {
    assert.equal(stage++, 2); const child = spawnChild(...args);
    if (cancellation?.stage === 2) queueMicrotask(() => cancellation.controller.abort()); return child;
  } });
  async function mutateByte(value, offset = 0) {
    const handle = await fs.open(file, "r+");
    try { await handle.write(Buffer.from(value), 0, 1, meta.length + 9999 * row.length + offset); } finally { await handle.close(); }
  }
  async function snapshot() {
    const handle = await fs.open(file, "r"), hash = crypto.createHash("sha256");
    try { for await (const chunk of handle.createReadStream({ autoClose: false, highWaterMark: 65536 })) hash.update(chunk); }
    finally { await handle.close(); }
    return { rollout: hash.digest("hex"), index: crypto.createHash("sha256").update(await fs.readFile(path.join(root, "session_index.jsonl"))).digest("hex"), sql: await sqlSnapshot() };
  }
  async function read(options = {}) {
    stage = 0; const start = performance.now(); let previous = start;
    const timer = setInterval(() => { const now = performance.now(); maxLoopGapMs = Math.max(maxLoopGapMs, now - previous); previous = now; ticks++; }, 2);
    try {
      const result = await pipeline.readNamedPage(input, options);
      maxElapsedMs = Math.max(maxElapsedMs, performance.now() - start);
      assert.equal(counters().physical, 0); assert.equal(admission.status().cleanupConfirmed, true); assert.equal(admission.status().quarantined, false);
      return result;
    } finally { clearInterval(timer); }
  }
  async function stable(options = {}) {
    const before = await snapshot(), result = await read(options); assert.deepEqual(await snapshot(), before); return result;
  }
  try {
    const handle = await fs.open(file, "w");
    try { await handle.writeFile(meta); const batch = Buffer.from(row.toString().repeat(64));
      for (let n = 1; n < count; n += 64) await handle.writeFile(batch.subarray(0, Math.min(64, count - n) * row.length)); }
    finally { await handle.close(); }
    // Wait for both peers before claiming the shared Host admission is idle.
    const untouched = await snapshot(); stage = 0;
    const first = pipeline.readNamedPage(input), peer = claudeRead();
    assert.equal(admission.status().activeWorkers, 2); assert.equal(counters().physical, 2);
    const busyBefore = counters().attempts; assert.equal((await codexRead()).code, "source_busy"); assert.equal(counters().attempts, busyBefore);
    const [initial, other] = await Promise.all([first, peer]);
    assert.equal(initial.kind, "codex_named_page_capture", initial.code); assert.equal(other.kind, "bound_history_observation", other.code);
    assert.equal(initial.name.name, "最新 WAL 名稱 🐾"); assert.equal(stage, 5); assert.equal(counters().physical, 0);
    assert.deepEqual(await snapshot(), untouched);
    const pages = [];
    for (const [offset, limit] of [[0, 1], [10000, 50], [count - 2, 50], [count, 50]]) {
      const result = await stable({ expectedVersion: initial.source, selection: { mode: "records", offset, limit } });
      assert.equal(result.kind, "codex_named_page_capture", result.code); assert.equal(stage, 5);
      assert(wire.sameNamedVersion(initial.source, result.source, true)); assert.equal(result.name.name, initial.name.name);
      assert.equal(result.page.recordCount, count); assert.equal(result.page.byteLength, sourceBytes);
      const expected = offset === 0 ? meta.toString() : row.toString().repeat(Math.min(limit, count - offset));
      assert.equal(result.page.records.map(r => r.rawText).join(""), expected);
      if (offset > 0 && offset < count) assert.equal(result.page.records[0].byteOffset, meta.length + (offset - 1) * row.length);
      pages.push({ offset, records: result.page.records.length, nextOffset: result.page.nextOffset });
    }
    const old = createCodexHistoryPipeline({ helperPath, admission, createHelper, spawnChild });
    try { assert.equal((await old.read(history)).code, "source_too_large"); } finally { assert.equal((await old.shutdown()).cleanupConfirmed, true); }
    await mutateByte("!"); assert.equal((await stable({ selection: { mode: "records", offset: 0, limit: 1 } })).code, "rollout_invalid_record"); assert.equal(stage, 2);
    await mutateByte("{"); const restored = await stable(); assert.equal(restored.kind, "codex_named_page_capture", restored.code);
    mutation = { stage: 1, work: () => mutateByte("z", row.indexOf("xxx")) };
    assert.equal((await read()).code, "source_version_changed"); mutation = null; assert.equal(stage, 5);
    assert.equal((await stable({ expectedVersion: restored.source })).code, "source_version_changed"); assert.equal(stage, 2);
    const mutations = [];
    for (const [at, command] of [[1, "rename"], [1, "preview"], [1, "path"], [1, "index"], [3, "index"]]) {
      mutation = { stage: at, work: () => writer.command(command) };
      const result = await read(); mutation = null; assert.equal(result.code, "source_version_changed", command);
      mutations.push({ afterCaptureStage: at + 1, command, refused: true });
      if (command === "path") await writer.command("plain_path");
    }
    for (const at of [0, 1, 2, 3, 4]) {
      cancellation = { stage: at, controller: new AbortController() };
      assert.equal((await stable({ signal: cancellation.controller.signal })).code, "source_aborted"); cancellation = null; assert.equal(stage, at + 1);
    }
    const final = await stable({ selection: { mode: "records", offset: 10000, limit: 2 } });
    assert.equal(final.kind, "codex_named_page_capture", final.code); assert.equal(final.page.records[0].rawText.includes("zxx"), true);
    assert.equal(final.publishable, false); assert.equal(final.semanticHistoryComplete, false); assert.equal(final.name.nativeTitleResolved, false);
    return { gate: "posix_owned_named_page_pipeline_passed", sourceBytes, recordCount: count, pages, mutations,
      actualReaderAndParserSpawns: counters().attempts - before, maximumPhysicalChildren: counters().maximum, remainingChildren: counters().physical,
      sequence: ["v5_sqlite_a", "v11_validated_page_a", "permissioned_v8_parser", "v5_sqlite_b", "v11_validated_page_b"],
      crossHarnessSharedAdmission: true, actualClaudeSdkPeer: true, cancellationStages: 5, outsidePageChangeFenced: true,
      malformedOutsidePageRefused: true, exactPageBytesPreserved: true, sourceFilesUnchangedDuringReads: true,
      maxSelectedPageBytes: maxPageBytes, maxElapsedMs, maxMainLoopGapMs: maxLoopGapMs, mainLoopTicks: ticks,
      measurementScope: "owned_pipeline_only_not_Host_Web_or_RSS", oldWholeFileLimitPreserved: true,
      privateHistoryReads: 0, modelCalls: 0, nativeCodexLaunches: 0, nativeProjectionComplete: false, hostWebConnected: false, cleanupConfirmed: true };
  } finally {
    assert.equal((await pipeline.shutdown()).cleanupConfirmed, true, "retain owned writer if reader cleanup is unknown");
    await writer.command("reset"); assert.deepEqual(await fs.readFile(file), original);
  }
}
