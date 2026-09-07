#!/usr/bin/env node
// Synthetic-only local benchmark. No server, private history, native CLI/model,
// login, SDK download, installation or fixture content in the report.
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
const repo = fileURLToPath(new URL("../", import.meta.url)), exec = promisify(execFile);
const digest = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const rounded = v => Math.round(v * 1000) / 1000;
export function records(count, textBytes) {
  const text = "x".repeat(textBytes);
  return Array.from({ length: count }, (_, index) => {
    const type = index % 2 === 0 ? "user" : "assistant", n = index + 1;
    return { type, sessionId: fixture.sessionId, uuid: fixture.uuid(n), parentUuid: index ? fixture.uuid(index) : null,
      timestamp: new Date(Date.UTC(2026, 0, 1) + index * 1000).toISOString(),
      message: { role: type, ...(type === "assistant" ? { id: `synthetic-${n}`, stop_reason: "end_turn" } : {}), content: [{ type: "text", text }] } };
  });
}
export async function benchmark(suppliedSdk) {
  if (!["darwin", "linux"].includes(process.platform)) throw new Error("Synthetic source benchmark requires the POSIX source gate");
  const sdkPath = await fs.realpath(suppliedSdk);
  assert.ok(pinned.validSdkPath(sdkPath)); assert.equal(digest(await fs.readFile(sdkPath)), pinned.SDK_SHA256);
  const sourceSha256 = {};
  const names = (await fs.readdir(path.join(repo, "protocol/native/claude"))).filter(name => name.endsWith(".js"));
  for (const name of [...names.map(n => `protocol/native/claude/${n}`), "scripts/benchmark-claude-history.mjs", "public/modules/projection.js",
    "public/modules/claude-history.js", "public/modules/claude-history-value.js"])
    sourceSha256[name] = digest(await fs.readFile(path.join(repo, name)));
  const sourceCommit = (await exec("git", ["rev-parse", "HEAD"], { cwd: repo })).stdout.trim();
  const sourceWorktreeDirty = Boolean((await exec("git", ["status", "--porcelain"], { cwd: repo })).stdout.trim());
  const home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "stepsemble-history-benchmark-")));
  const cases = [], projectsRoot = path.join(home, "projects"), projectKey = "-synthetic", project = path.join(projectsRoot, projectKey);
  let cleanupConfirmed = true;
  try {
    await fs.mkdir(project, { recursive: true, mode: 0o700 });
    const filename = path.join(project, `${fixture.sessionId}.jsonl`);
    for (const workload of [{ rows: 200, textBytes: 256, pageLimit: 100 }, { rows: 2000, textBytes: 3500, pageLimit: 25 },
      { rows: 2000, textBytes: 3500, pageLimit: 100 }]) {
      const bytes = Buffer.from(records(workload.rows, workload.textBytes).map(row => JSON.stringify(row)).join("\n") + "\n");
      await fs.writeFile(filename, bytes, { mode: 0o600 });
      const item = { workload: { ...workload, rawBytes: bytes.length, offset: workload.rows - workload.pageLimit }, runs: [] };
      for (let repetition = 0; repetition < 3; repetition++) {
        // Alternate order; cold worker per read, OS file cache is not flushed.
        for (const mode of repetition % 2 ? ["observe", "capture"] : ["capture", "observe"]) {
          let outputBytes = 0, closeHandlerMs = 0, peakRss = process.memoryUsage().rss, previous = performance.now(), maxGapMs = 0, ticks = 0;
          const service = serviceModule.createSourceService({ sdkPath, spawnChild(executable, args, options) {
            const child = spawn(executable, args, options);
            child.stdout.on("data", chunk => { outputBytes += chunk.length; });
            child.on("close", () => { const start = performance.now(); queueMicrotask(() => { closeHandlerMs = performance.now() - start; }); });
            return child;
          } });
          const bindingId = crypto.randomUUID(), bound = service.bind({ bindingId, generation: 1, source: { projectsRoot, projectKey, sessionId: fixture.sessionId } });
          const tick = () => { const now = performance.now(); maxGapMs = Math.max(maxGapMs, now - previous); previous = now; ticks++;
            peakRss = Math.max(peakRss, process.memoryUsage().rss); };
          const beforeRss = peakRss, interval = setInterval(tick, 5), started = performance.now();
          let result;
          try {
            result = await bound[mode]({ bindingId, generation: 1, requestId: crypto.randomUUID() },
              mode === "observe" ? { page: { offset: item.workload.offset, limit: workload.pageLimit } } : {});
          } finally { clearInterval(interval); tick(); cleanupConfirmed = (await service.shutdown()).cleanupConfirmed && cleanupConfirmed; }
          const elapsedMs = performance.now() - started;
          if (mode === "capture") assert.equal(result.kind, "bound_source_snapshot", result.code);
          else if (workload.textBytes === 3500 && workload.pageLimit === 100) assert.equal(result.code, "source_observation_too_large");
          else {
            assert.equal(result.kind, "bound_history_observation", result.code);
            assert.equal(result.history.observation.messages.length, workload.pageLimit);
            assert.equal(result.history.observation.messages[0].nativeMessageId, fixture.uuid(item.workload.offset + 1));
            assert.equal(result.history.source.sha256, digest(bytes)); assert.equal(result.publishable, false);
          }
          item.runs.push({ repetition: repetition + 1, mode, result: result.code || result.kind, elapsedMs: rounded(elapsedMs),
            outputBytes, parentCloseHandlerMs: rounded(closeHandlerMs), parentTimerMaxGapMs: rounded(maxGapMs), parentTimerTicks: ticks,
            parentRssBeforeMiB: rounded(beforeRss / 1048576), parentSampledPeakRssMiB: rounded(peakRss / 1048576),
            workerMetrics: result.history ? Object.fromEntries(Object.entries(result.history.metrics).map(([k, v]) => [k, rounded(v)])) : null });
        }
      }
      assert.deepEqual(await fs.readFile(filename), bytes); cases.push(item);
    }
  } finally { await fs.rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
  assert.equal(cleanupConfirmed, true); assert.equal(digest(await fs.readFile(sdkPath)), pinned.SDK_SHA256);
  return { schemaVersion: 1, recordedAt: new Date().toISOString(), sourceCommit, sourceWorktreeDirty, sourceSha256,
    environment: { platform: process.platform, release: os.release(), arch: process.arch, node: process.version, cpuLogicalCount: os.cpus().length },
    sdkVersion: pinned.SDK_VERSION, sdkSha256: pinned.SDK_SHA256, cases, cleanupConfirmed, modelCalls: 0, sourceUnchanged: true,
    limitations: ["Local synthetic offline reference, not production/UI/remote-disk/native-subscription acceptance",
      "Three sequential repetitions, fresh child each time, unflushed OS cache; no population percentile",
      "Parent close-handler includes JSON decoding/validation/settlement, not a profiler-exclusive decode measurement",
      "5ms parent timer gaps include scheduling; sampled parent RSS may miss peaks and includes fixture construction/previous runs",
      "Worker maxRssKiB is self-reported process.resourceUsage high-water at mapping completion, not a hard memory ceiling",
      "Each page captures and selects the full bounded source again; no cache/version-pinned multi-page read is implemented"] };
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  if (process.argv.length !== 3) throw new Error("Usage: benchmark-claude-history.mjs /absolute/pinned/sdk.mjs");
  console.log(JSON.stringify(await benchmark(process.argv[2]), null, 2));
}
