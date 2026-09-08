#!/usr/bin/env node
// Three bounded synthetic dual-read rounds; no private source, model or live route.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";
import native from "../protocol/native/claude/history-native-service.js";
import helper from "../protocol/native/claude/history-native-helper.js";
import pinned from "../protocol/native/claude/history-sdk.js";
import fixture from "../protocol/native/claude/history-fixture.cjs";
import { records } from "./benchmark-claude-history.mjs";
const repo = fileURLToPath(new URL("../", import.meta.url)), exec = promisify(execFile);
const digest = bytes => crypto.createHash("sha256").update(bytes).digest("hex"), round = v => Math.round(v * 1000) / 1000;
export async function measureNativeHistoryPipeline(helperPath, suppliedSdk) {
  assert.ok(["darwin", "linux"].includes(process.platform), "POSIX synthetic performance gate required; Windows unsupported");
  const executablePath = await fs.realpath(helperPath), sdkPath = await fs.realpath(suppliedSdk);
  assert.equal(digest(await fs.readFile(sdkPath)), pinned.SDK_SHA256);
  const helperSha256 = digest(await fs.readFile(executablePath));
  const implementationHashes = {};
  for (const name of ["history-native-service.js", "history-native-helper.js", "history-bytes-worker.js", "history-bytes-wire.js", "history-source.js",
    "history-worker-wire.js", "history-record-scope.js", "history-sdk.js", "history-selection.js", "history-observation.js"])
    implementationHashes[`protocol/native/claude/${name}`] = digest(await fs.readFile(path.join(repo, "protocol/native/claude", name)));
  for (const name of ["scripts/measure-native-history-pipeline.mjs", "scripts/benchmark-claude-history.mjs", "public/modules/projection.js", "public/modules/claude-history.js", "public/modules/claude-history-value.js"])
    implementationHashes[name] = digest(await fs.readFile(path.join(repo, name)));
  const sourceCommit = (await exec("git", ["rev-parse", "HEAD"], { cwd: repo })).stdout.trim();
  const sourceWorktreeDirty = Boolean((await exec("git", ["status", "--porcelain"], { cwd: repo })).stdout.trim());
  const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "stepsemble-native-measure-")));
  const files = [], launches = [], rounds = []; let service, cleanupConfirmed = false, physical = 0, peakPhysical = 0;
  const launch = stage => (executable, args, options) => {
    const metric = { stage, wireBytes: 0, parentCloseHandlerMs: 0 }; launches.push(metric);
    const child = spawn(executable, args, options); physical++; peakPhysical = Math.max(peakPhysical, physical);
    child.stdout.on("data", chunk => { metric.wireBytes += chunk.length; });
    child.once("close", () => { physical--; const start = performance.now(); queueMicrotask(() => { metric.parentCloseHandlerMs = round(performance.now() - start); }); });
    return child;
  };
  try {
    const projectsRoot = path.join(temp, "projects"); await fs.mkdir(projectsRoot, { mode: 0o700 });
    const rootStat = await fs.stat(projectsRoot, { bigint: true }), sources = [];
    for (const [index, sessionId] of [fixture.sessionId, fixture.otherSessionId].entries()) {
      const projectKey = `-synthetic-${index}`, project = path.join(projectsRoot, projectKey); await fs.mkdir(project, { mode: 0o700 });
      const content = Buffer.from(records(2000, 3500).map(row => JSON.stringify({ ...row, sessionId })).join("\n") + "\n");
      assert.equal(content.length, 7592414);
      const filename = path.join(project, `${sessionId}.jsonl`); await fs.writeFile(filename, content, { mode: 0o600, flag: "wx" });
      files.push({ filename, sha256: digest(content), bytes: content.length }); sources.push({ projectsRoot, projectKey, sessionId });
    }
    service = native.createNativeSourceService({ helperPath: executablePath, sdkPath,
      roots: [{ projectsRoot, expectedRoot: { device: String(rootStat.dev), inode: String(rootStat.ino) } }],
      createHelper: options => helper.createNativeHelper({ ...options, spawnChild: launch("rust") }), spawnChild: launch("sdk") });
    const bindings = sources.map(source => {
      const bindingId = crypto.randomUUID(); return { bindingId, version: null, bound: service.bind({ bindingId, generation: 1, source }) };
    });
    const thirdId = crypto.randomUUID(), third = service.bind({ bindingId: thirdId, generation: 1, source: sources[0] });
    const request = bindingId => ({ bindingId, generation: 1, requestId: crypto.randomUUID() });
    for (let index = 0; index < 3; index++) {
      const started = performance.now(), before = launches.length, rssBefore = process.memoryUsage().rss;
      let previous = started, maxGap = 0, ticks = 0, peakRss = rssBefore;
      const tick = () => { const now = performance.now(); maxGap = Math.max(maxGap, now - previous); previous = now; ticks++;
        peakRss = Math.max(peakRss, process.memoryUsage().rss); };
      const timer = setInterval(tick, 5), page = { offset: 1975 - index * 25, limit: 25 };
      const pending = bindings.map(async (binding, position) => {
        const result = await binding.bound.observe(request(binding.bindingId), { page, ...(binding.version ? { version: binding.version } : {}) });
        assert.equal(result.kind, "bound_history_observation", result.code); assert.equal(result.cleanupConfirmed, true);
        assert.equal(result.history.source.sessionId, sources[position].sessionId); assert.equal(result.history.source.sha256, files[position].sha256);
        assert.equal(result.history.observation.messages.length, 25); assert.equal(result.history.observation.messages[0].nativeMessageId, fixture.uuid(page.offset + 1));
        assert.equal(result.sourceAuthenticated, false); assert.equal(result.publishable, false);
        if (binding.version) assert.equal(result.sourceVersion, binding.version); else binding.version = result.sourceVersion;
        return { elapsedMs: round(performance.now() - started), sdkHighWaterRssKiB: result.history.metrics.maxRssKiB,
          selectionMs: round(result.history.metrics.selectionMs), mappingMs: round(result.history.metrics.mappingMs) };
      });
      let results;
      try {
        assert.equal(service.status().activeWorkers, 2); assert.equal(physical, 2); assert.equal(launches.length, before + 2);
        assert.deepEqual(await third.observe(request(thirdId), { page }), { kind: "source_unavailable", code: "source_busy" });
        assert.equal(launches.length, before + 2); results = await Promise.all(pending);
      } finally { clearInterval(timer); tick(); await Promise.allSettled(pending); }
      assert.equal(service.status().activeWorkers, 0); assert.equal(physical, 0); assert.ok(peakPhysical <= 2);
      const children = launches.slice(before); assert.deepEqual(children.map(v => v.stage).sort(), ["rust", "rust", "sdk", "sdk"]);
      assert.ok(children.filter(v => v.stage === "sdk").every(v => v.wireBytes <= 256 * 1024));
      rounds.push({ round: index + 1, page, elapsedMs: round(performance.now() - started), workers: results, children,
        parentTimerMaxGapMs: round(maxGap), parentTimerTicks: ticks, parentSampledPeakRssMiB: round(peakRss / 1048576),
        parentRssBeforeMiB: round(rssBefore / 1048576), parentRssAfterMiB: round(process.memoryUsage().rss / 1048576),
        physicalChildrenPeak: peakPhysical, thirdRejectedWithoutSpawn: true, cleanupConfirmed: true });
    }
    const before = launches.length, binding = bindings[0];
    const rejected = await binding.bound.observe(request(binding.bindingId), { page: { offset: 1900, limit: 100 }, version: binding.version });
    assert.deepEqual(rejected, { kind: "source_unavailable", code: "source_observation_too_large" });
    assert.equal(physical, 0); assert.equal(service.status().activeWorkers, 0);
    const errorChildren = launches.slice(before); assert.equal(errorChildren.length, 2);
    const recovery = await binding.bound.observe(request(binding.bindingId), { page: { offset: 1975, limit: 25 }, version: binding.version });
    assert.equal(recovery.kind, "bound_history_observation", recovery.code); assert.equal(recovery.sourceVersion, binding.version);
    assert.equal(physical, 0); assert.ok(peakPhysical <= 2);
    for (const file of files) assert.equal(digest(await fs.readFile(file.filename)), file.sha256);
    assert.equal(digest(await fs.readFile(sdkPath)), pinned.SDK_SHA256); assert.equal(digest(await fs.readFile(executablePath)), helperSha256);
    for (const [name, hash] of Object.entries(implementationHashes)) assert.equal(digest(await fs.readFile(path.join(repo, name))), hash, "implementation changed during measurement");
    return { schemaVersion: 1, recordedAt: new Date().toISOString(), sourceCommit, sourceWorktreeDirty, implementationHashes, helperArtifactSha256: helperSha256,
      environment: { node: process.version, platform: process.platform, release: os.release(), arch: process.arch, cpuLogicalCount: os.cpus().length },
      sdkVersion: pinned.SDK_VERSION, sdkSha256: pinned.SDK_SHA256,
      workload: { sources: 2, rawBytesEach: 7592414, rowsEach: 2000, textBytesPerRow: 3500, rounds: 3, simultaneousReads: 2, pageMessages: 25, freshChildrenPerRound: 4 },
      rounds, capCheck: { result: rejected.code, errorWireBytes: errorChildren.find(v => v.stage === "sdk").wireBytes, explicitSmallerPageRecovery: true },
      physicalChildrenPeak: peakPhysical, modelCalls: 0, privateHistoryReads: 0, sourceUnchanged: true, cleanupConfirmed: true,
      limitations: ["Three rounds only, existing host activity not controlled, warm OS cache, no forced GC or memory-pressure stress",
        "SDK maxRSS is per-process high-water at mapping completion, not simultaneous total RSS; Rust child RSS was not measured",
        "Parent RSS samples can miss peaks and include fixture construction and earlier allocations",
        "5ms timer gap includes scheduler effects; close handler excludes later promise continuations",
        "Not production/browser acceptance, a hard RSS ceiling, long-term leak proof, or authenticated native provenance"] };
  } finally {
    if (service) cleanupConfirmed = (await service.shutdown()).cleanupConfirmed === true && physical === 0;
    if (!service || cleanupConfirmed) await fs.rm(temp, { recursive: true, force: true });
    else { const error = new Error("native_measure_cleanup_unconfirmed_owned_fixture_preserved"); error.cleanupUnconfirmed = true; throw error; }
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  assert.equal(process.argv.length, 4, "Usage: measure-native-history-pipeline.mjs /absolute/helper /absolute/sdk.mjs");
  console.log(JSON.stringify(await measureNativeHistoryPipeline(process.argv[2], process.argv[3]), null, 2));
}
