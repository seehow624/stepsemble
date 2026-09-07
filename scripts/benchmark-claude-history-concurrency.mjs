#!/usr/bin/env node
// Bounded, synthetic-only dual-worker experiment, NOT an OS memory-pressure
// stressor. Never reads private sessions or starts a server/native CLI/model.
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";
import assert from "node:assert/strict";
import serviceModule from "../protocol/native/claude/history-source-service.js";
import pinned from "../protocol/native/claude/history-sdk.js";
import fixture from "../protocol/native/claude/history-fixture.cjs";
import { records } from "./benchmark-claude-history.mjs";
const repo = fileURLToPath(new URL("../", import.meta.url)), exec = promisify(execFile);
const digest = bytes => crypto.createHash("sha256").update(bytes).digest("hex"), rounded = v => Math.round(v * 1000) / 1000;
export async function benchmark(suppliedSdk) {
  if (!["darwin", "linux"].includes(process.platform)) throw new Error("POSIX fixture source gate required");
  const sdkPath = await fs.realpath(suppliedSdk); assert.ok(pinned.validSdkPath(sdkPath));
  assert.equal(digest(await fs.readFile(sdkPath)), pinned.SDK_SHA256);
  const sourceSha256 = {};
  const names = (await fs.readdir(path.join(repo, "protocol/native/claude"))).filter(n => n.endsWith(".js"));
  for (const name of [...names.map(n => `protocol/native/claude/${n}`), "scripts/benchmark-claude-history-concurrency.mjs",
    "scripts/benchmark-claude-history.mjs", "public/modules/projection.js"])
    sourceSha256[name] = digest(await fs.readFile(path.join(repo, name)));
  const sourceCommit = (await exec("git", ["rev-parse", "HEAD"], { cwd: repo })).stdout.trim();
  const sourceWorktreeDirty = Boolean((await exec("git", ["status", "--porcelain"], { cwd: repo })).stdout.trim());
  const home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "stepsemble-history-concurrency-")));
  const rounds = [], files = [], launches = [];
  let service, cleanupConfirmed = false;
  try {
    const projectsRoot = path.join(home, "projects"); await fs.mkdir(projectsRoot, { mode: 0o700 });
    const sources = [];
    for (const [index, sessionId] of [fixture.sessionId, fixture.otherSessionId].entries()) {
      const projectKey = `-synthetic-${index}`, project = path.join(projectsRoot, projectKey); await fs.mkdir(project, { mode: 0o700 });
      const content = Buffer.from(records(2000, 3500).map(row => JSON.stringify({ ...row, sessionId })).join("\n") + "\n");
      const filename = path.join(project, `${sessionId}.jsonl`); await fs.writeFile(filename, content, { mode: 0o600 });
      files.push({ filename, sha256: digest(content), bytes: content.length }); sources.push({ projectsRoot, projectKey, sessionId });
    }
    service = serviceModule.createSourceService({ sdkPath, spawnChild(executable, args, options) {
      const metric = { wireBytes: 0, parentCloseHandlerMs: 0 }; launches.push(metric);
      const child = spawn(executable, args, options);
      child.stdout.on("data", chunk => { metric.wireBytes += chunk.length; });
      child.on("close", () => { const started = performance.now(); queueMicrotask(() => { metric.parentCloseHandlerMs = performance.now() - started; }); });
      return child;
    } });
    const bindings = sources.map(source => { const bindingId = crypto.randomUUID(); return {
      request: { bindingId, generation: 1, requestId: crypto.randomUUID() }, version: undefined,
      bound: service.bind({ bindingId, generation: 1, source }) }; });
    const thirdId = crypto.randomUUID(), third = service.bind({ bindingId: thirdId, generation: 1, source: sources[0] });
    for (let round = 0; round < 12; round++) {
      const start = performance.now(), rssBefore = process.memoryUsage().rss, launchStart = launches.length;
      let previous = start, maxGapMs = 0, sampledPeakRss = rssBefore, ticks = 0;
      const tick = () => { const now = performance.now(); maxGapMs = Math.max(maxGapMs, now - previous); previous = now; ticks++;
        sampledPeakRss = Math.max(sampledPeakRss, process.memoryUsage().rss); };
      const interval = setInterval(tick, 5);
      const page = { offset: 1975 - round * 25, limit: 25 };
      const pending = bindings.map(async (b, index) => {
        const request = { ...b.request, requestId: crypto.randomUUID() }, options = { page, ...(b.version ? { version: b.version } : {}) };
        const result = await b.bound.observe(request, options), elapsedMs = performance.now() - start;
        assert.equal(result.kind, "bound_history_observation", result.code); assert.equal(result.history.source.sessionId, sources[index].sessionId);
        assert.equal(result.history.source.sha256, files[index].sha256); assert.equal(result.history.observation.messages.length, page.limit);
        assert.equal(result.history.observation.messages[0].nativeMessageId, fixture.uuid(page.offset + 1));
        assert.equal(result.publishable, false); assert.equal(result.cleanupConfirmed, true);
        if (b.version) assert.equal(result.sourceVersion, b.version); else b.version = result.sourceVersion;
        return { elapsedMs: rounded(elapsedMs), workerMetrics: Object.fromEntries(Object.entries(result.history.metrics).map(([k, v]) => [k, rounded(v)])) };
      });
      let results;
      try {
        assert.equal(service.status().activeWorkers, 2);
        assert.deepEqual(await third.observe({ bindingId: thirdId, generation: 1, requestId: crypto.randomUUID() }, { page }),
          { kind: "source_unavailable", code: "source_busy" });
        assert.equal(launches.length, launchStart + 2); results = await Promise.all(pending);
      } finally { clearInterval(interval); tick(); await Promise.allSettled(pending); }
      assert.equal(service.status().activeWorkers, 0); assert.equal(service.status().quarantined, false);
      rounds.push({ round: round + 1, page, elapsedMs: rounded(performance.now() - start), workers: results.map((r, i) => ({ ...r,
        wireBytes: launches[launchStart + i].wireBytes, parentCloseHandlerMs: rounded(launches[launchStart + i].parentCloseHandlerMs) })),
        parentTimerMaxGapMs: rounded(maxGapMs), parentTimerTicks: ticks, parentRssBeforeMiB: rounded(rssBefore / 1048576),
        parentSampledPeakRssMiB: rounded(sampledPeakRss / 1048576), parentRssAfterMiB: rounded(process.memoryUsage().rss / 1048576),
        sumWorkerHighWaterMiB: rounded(results.reduce((n, r) => n + r.workerMetrics.maxRssKiB / 1024, 0)),
        activeWorkersObserved: 2, thirdRejectedWithoutSpawn: true, cleanupObserved: true });
    }
    assert.equal(launches.length, 24);
    for (const file of files) assert.equal(digest(await fs.readFile(file.filename)), file.sha256);
    assert.equal(digest(await fs.readFile(sdkPath)), pinned.SDK_SHA256);
  } finally {
    if (service) cleanupConfirmed = (await service.shutdown()).cleanupConfirmed;
    // Only fixtures owned by this invocation; no active child may retain them.
    if (!service || cleanupConfirmed) await fs.rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
  assert.equal(cleanupConfirmed, true);
  return { schemaVersion: 1, recordedAt: new Date().toISOString(), sourceCommit, sourceWorktreeDirty, sourceSha256,
    environment: { platform: process.platform, release: os.release(), arch: process.arch, node: process.version, cpuLogicalCount: os.cpus().length },
    sdkVersion: pinned.SDK_VERSION, sdkSha256: pinned.SDK_SHA256,
    workload: { sources: 2, sourceBytes: files.map(f => f.bytes), rowsPerSource: 2000, textBytesPerRow: 3500, rounds: 12, successfulReads: 24,
      pageMessages: 25, concurrentWorkers: 2, admissionRejections: 12 }, rounds, cleanupConfirmed, modelCalls: 0, sourceUnchanged: true,
    limitations: ["Local bounded synthetic dual-worker experiment, not OS memory pressure, a memory ceiling or long-term leak proof",
      "Same service across rounds; fresh workers, warm OS cache; no GC forcing or percentile claim",
      "Parent sampled RSS may miss peaks and includes fixture construction and deferred GC",
      "Sum of worker-reported high-water RSS at mapping completion is NOT a simultaneous total-RSS sample",
      "5ms timer gaps include scheduler delay; close-handler includes decoding, validation and settlement",
      "Version tokens reject observed changes but do not cache old snapshots, lock the native file, authenticate its origin or make live UI authoritative"] };
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  if (process.argv.length !== 3) throw new Error("Usage: benchmark-claude-history-concurrency.mjs /absolute/pinned/sdk.mjs");
  console.log(JSON.stringify(await benchmark(process.argv[2]), null, 2));
}
