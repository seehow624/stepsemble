// Actual Rust -> permissioned Codex parser, with a real Claude SDK peer on the
// same admission. Sources, markers and data belong exclusively to this test.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { performance } from "node:perf_hooks";
import { createCodexHistoryPipeline } from "../protocol/native/codex/history-pipeline.js";
import { createReaderAdmission } from "../protocol/native/claude/history-reader-admission.js";
import { createNativeHelper } from "../protocol/native/claude/history-native-helper.js";
import { createNativeSourceService } from "../protocol/native/claude/history-native-service.js";
import { createSourceIndex } from "../protocol/native/claude/history-source-index.js";
import { processJob } from "../protocol/native/codex/parser-worker.js";
import wire from "../protocol/native/codex/parser-wire.js";
import codexFixture from "../protocol/native/codex/parser-fixture.cjs";
import claudeFixture from "../protocol/native/claude/history-fixture.cjs";
import { checkCodexSqlitePipeline } from "./check-native-codex-sqlite-pipeline.mjs";

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function sampleLoop(work) {
  const gaps = []; let last = performance.now();
  const timer = setInterval(() => { const now = performance.now(); gaps.push(now - last); last = now; }, 2);
  try {
    await sleep(8); const start = performance.now(), result = await work(), elapsedMs = performance.now() - start;
    await sleep(8); return { result, elapsedMs, maxLoopGapMs: Math.max(...gaps), ticks: gaps.length };
  } finally { clearInterval(timer); }
}
export async function checkCodexHistoryPipeline({ helperPath, sdkPath }) {
  assert(path.isAbsolute(helperPath) && path.isAbsolute(sdkPath));
  const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "stepsemble-codex-pipeline-")));
  const admission = createReaderAdmission(), services = [], saved = new Map();
  let physical = 0, maximum = 0, attempts = 0, cleanup = true, abortParser = null;
  const spawnOwned = (...args) => {
    assert(physical < 2, "one shared cross-harness physical budget"); attempts++;
    const child = spawn(...args); physical++; maximum = Math.max(maximum, physical);
    child.once("close", () => { physical--; }); return child;
  };
  const parserSpawn = (...args) => { const child = spawnOwned(...args); if (abortParser) { const controller = abortParser; abortParser = null; queueMicrotask(() => controller.abort()); } return child; };
  const createHelper = options => createNativeHelper({ ...options, spawnChild: spawnOwned });
  const save = async (file, bytes) => { await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 }); await fs.writeFile(file, bytes, { flag: "wx", mode: 0o600 }); saved.set(file, Buffer.from(bytes)); };
  const rootIdentity = async root => { const s = await fs.stat(root, { bigint: true }); return { device: String(s.dev), inode: String(s.ino) }; };
  try {
    const codexRoot = path.join(temp, "codex"), capture = codexFixture.captured(undefined, temp), rollout = path.join(codexRoot, capture.rolloutPath), indexFile = path.join(codexRoot, "session_index.jsonl");
    await save(rollout, capture.rolloutBytes); await save(indexFile, capture.nameIndexBytes);
    const request = { nativeVersion: "0.153.4", source: { codexRoot, rolloutPath: capture.rolloutPath, threadId: capture.threadId }, expectedRoot: await rootIdentity(codexRoot) };
    const pipeline = createCodexHistoryPipeline({ helperPath, admission, createHelper, spawnChild: parserSpawn }); services.push(pipeline);
    const claudeRoot = path.join(temp, "projects"), projectKey = "owned-cross-harness", c = claudeFixture.richCases(temp)[0];
    await save(path.join(claudeRoot, projectKey, `${c.sessionId}.jsonl`), Buffer.from(c.records.map(v => JSON.stringify(v)).join("\n") + "\n"));
    const roots = [{ projectsRoot: claudeRoot, expectedRoot: await rootIdentity(claudeRoot) }];
    const claude = createNativeSourceService({ helperPath, sdkPath, roots, admission, createHelper, spawnChild: spawnOwned }); services.push(claude);
    const inventory = createSourceIndex({ sourceId: "owned-cross-harness", source: roots[0], helperPath, admission, createHelper, authorize: who => who === "owner" }); services.push(inventory);
    const bindingId = crypto.randomUUID(), bound = claude.bind({ bindingId, generation: 1, source: { projectsRoot: claudeRoot, projectKey, sessionId: c.sessionId } });
    const peerRequest = { bindingId, generation: 1, requestId: crypto.randomUUID() };
    const sqlitePipeline = await checkCodexSqlitePipeline({ helperPath, admission, createHelper,
      claudeRead: () => bound.observe({ ...peerRequest, requestId: crypto.randomUUID() }),
      codexRead: () => pipeline.read(request, { selection: { mode: "names" } }), counters: () => ({ physical, maximum, attempts }) });
    if (process.platform === "win32") {
      assert.deepEqual(await pipeline.read(request), { kind: "source_unavailable", code: "source_platform_unsupported" });
      assert.equal(attempts, 0);
      return { gate: "source_platform_unsupported", sqlitePipeline, sourceReads: 0, modelCalls: 0, privateHistoryReads: 0, productionWiring: false, cleanupConfirmed: true };
    }
    const native = bound.observe(peerRequest), parsed = pipeline.read(request, { selection: { mode: "names" } });
    assert.equal(admission.status().activeWorkers, 2); assert.equal(physical, 2);
    const before = attempts; assert.equal((await inventory.refresh("owner")).code, "source_busy"); assert.equal(attempts, before);
    const [a, b] = await Promise.all([native, parsed]);
    assert.equal(a.kind, "bound_history_observation", a.code); assert.equal(b.kind, "codex_parsed_capture", b.code);
    assert.equal(b.index.readCandidate, "  原生候選 🐾  "); assert.equal(b.page, null);
    assert.equal(physical, 0); assert.equal(admission.status().cleanupConfirmed, true);
    const rows = []; let offset = 0;
    do {
      const r = await pipeline.read(request, { expectedVersion: b.source, selection: { mode: "records", offset, limit: 2 } });
      assert.equal(r.kind, "codex_parsed_capture", r.code); assert.equal(r.cleanupConfirmed, true); rows.push(...r.page.records); offset = r.page.nextOffset;
    } while (offset !== null);
    assert.equal(rows.map(v => v.rawText).join(""), capture.rolloutBytes.toString());
    assert.equal(rows.filter(v => ["exec_command_begin", "exec_command_end", "view_image_tool_call"].includes(v.payloadType)).length, 3);
    await fs.writeFile(indexFile, Buffer.concat([capture.nameIndexBytes, capture.nameIndexBytes]));
    const staleBefore = attempts;
    assert.equal((await pipeline.read(request, { expectedVersion: b.source })).code, "source_version_changed");
    assert.equal(attempts, staleBefore + 1, "stale requires only a capture, never a parser");
    await fs.writeFile(indexFile, capture.nameIndexBytes);
    const controller = new AbortController(); abortParser = controller;
    assert.equal((await pipeline.read(request, { signal: controller.signal })).code, "source_aborted");
    assert.equal(physical, 0); assert.equal(admission.status().cleanupConfirmed, true); assert.equal(admission.status().quarantined, false);
    const cancelled = new AbortController(); cancelled.abort(); const cancelledBefore = attempts;
    assert.equal((await pipeline.read(request, { signal: cancelled.signal })).code, "source_aborted"); assert.equal(attempts, cancelledBefore);

    // Same parse workload before/after: measure main-loop gaps, not a claimed
    // Web Core Vital or a throughput speedup (the pipeline includes disk/IPC).
    const other = JSON.stringify({ id: "00000000-0000-4000-8000-000000000000", thread_name: "x".repeat(1024), updated_at: "x" }) + "\n";
    const largeIndex = Buffer.from(other.repeat(Math.floor((8 * 1024 * 1024 - 1000) / Buffer.byteLength(other))) + capture.nameIndexBytes.toString());
    await fs.writeFile(indexFile, largeIndex);
    const owned = codexFixture.captured(largeIndex, temp), j = codexFixture.job(owned, { mode: "names" }), payload = wire.readJob(wire.encodeJob(j, owned)).bytes;
    const comparison = [];
    for (let i = 0; i < 3; i++) {
      const direct = await sampleLoop(() => processJob(j, payload));
      const isolated = await sampleLoop(() => pipeline.read(request, { selection: { mode: "names" } }));
      for (const x of [direct, isolated]) assert.equal(x.result.index?.readCandidate, "  原生候選 🐾  ", x.result.code);
      comparison.push({ iteration: i + 1, directElapsedMs: direct.elapsedMs, directMaxLoopGapMs: direct.maxLoopGapMs,
        pipelineElapsedMs: isolated.elapsedMs, pipelineMaxLoopGapMs: isolated.maxLoopGapMs, pipelineTicks: isolated.ticks });
    }
    await fs.writeFile(indexFile, capture.nameIndexBytes);
    for (const [file, original] of saved) assert.deepEqual(await fs.readFile(file), original, "owned fixture bytes restored");
    assert.equal(admission.status().cleanupConfirmed, true); assert.equal(physical, 0); assert.equal(maximum, 2);
    bound.revoke();
    return { gate: "posix_owned_fixture_passed", sqlitePipeline, platform: process.platform, nodeVersion: process.version, crossHarnessSharedAdmission: true,
      actualClaudeSdkPeer: true, maximumPhysicalChildren: maximum, remainingChildren: physical, spawnAttempts: attempts, byteExactRawPages: true,
      preservedTransientRecords: 3, staleBeforeParser: true, actualParserCancellation: true, beforeAfter: { inputIndexBytes: largeIndex.length, comparison,
        syntheticMainLoopOnly: true, webOrHostAcceptance: false }, modelCalls: 0, privateHistoryReads: 0, nativeCodexLaunches: 0,
      sourceFilesRestoredAtEnd: saved.size, nativeTitleResolved: false, productionWiring: false, cleanupConfirmed: true };
  } finally {
    for (const s of services) { try { cleanup = (await s.shutdown()).cleanupConfirmed === true && cleanup; } catch { cleanup = false; } }
    cleanup = admission.close().cleanupConfirmed === true && physical === 0 && cleanup;
    if (cleanup) await fs.rm(temp, { recursive: true, force: true });
    else throw new Error("codex_pipeline_owned_sources_retained_cleanup_unknown");
  }
}
