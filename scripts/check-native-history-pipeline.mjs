#!/usr/bin/env node
// Actual native-reader → bytes-only worker → pinned SDK → HTTP/provider gate.
// All sources/listeners/credentials belong to this invocation's synthetic test.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import fixture from "../protocol/native/claude/history-fixture.cjs";
import nativeService from "../protocol/native/claude/history-native-service.js";
import provider from "../public/modules/claude-history.js";
import projection from "../public/modules/projection.js";
import { checkHistoryAccess } from "./check-history-access.mjs";
import { withDownloadedSdk, SDK_VERSION, NATIVE_VERSION, SDK_SHA256 } from "./check-native-claude-history.mjs";
const digest = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const encode = rows => Buffer.from(rows.map(row => JSON.stringify(row)).join("\n") + "\n");

export async function checkNativeHistoryPipeline({ helperPath, sdkPath }) {
  assert.ok(path.isAbsolute(helperPath) && path.isAbsolute(sdkPath), "explicit trusted absolute artifacts required");
  const helper = await fs.realpath(helperPath), sdk = await fs.realpath(sdkPath);
  assert.ok((await fs.lstat(helper)).isFile());
  const helperSha256 = digest(await fs.readFile(helper)); // Artifact reproducibility, NOT executed-byte pinning.
  const sdkBytes = await fs.readFile(sdk), sdkSha256 = digest(sdkBytes);
  assert.equal(sdkSha256, SDK_SHA256);
  const pkg = JSON.parse(await fs.readFile(path.join(path.dirname(sdk), "package.json"), "utf8"));
  assert.equal(pkg.name, "@anthropic-ai/claude-agent-sdk"); assert.equal(pkg.version, SDK_VERSION); assert.equal(pkg.claudeCodeVersion, NATIVE_VERSION);
  const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "stepsemble-native-pipeline-")));
  const services = [], expectedFiles = new Map(), metrics = [], started = performance.now();
  let cleanupConfirmed = true;
  try {
    const root = path.join(temp, "projects"), projectKey = "owned-pipeline", project = path.join(root, projectKey);
    await fs.mkdir(project, { recursive: true, mode: 0o700 });
    await fs.chmod(root, 0o700); await fs.chmod(project, 0o700);
    const rootStat = await fs.stat(root, { bigint: true });
    const roots = [{ projectsRoot: root, expectedRoot: { device: String(rootStat.dev), inode: String(rootStat.ino) } }];
    const createService = () => {
      const service = nativeService.createNativeSourceService({ helperPath: helper, sdkPath: sdk, roots }); services.push(service); return service;
    };
    const cases = fixture.richCases(temp);
    const write = async (sessionId, bytes) => {
      const file = path.join(project, `${sessionId}.jsonl`); await fs.writeFile(file, bytes, { mode: 0o600, flag: "wx" });
      expectedFiles.set(file, bytes); return file;
    };
    for (const testCase of cases) await write(testCase.sessionId, encode(testCase.records));
    const service = createService(), validator = provider.create({ canonicalJSON: projection.canonicalJSON });
    for (const testCase of cases) {
      const bindingId = crypto.randomUUID(), request = { bindingId, generation: 1, requestId: crypto.randomUUID() };
      const bound = service.bind({ bindingId, generation: 1, source: { projectsRoot: root, projectKey, sessionId: testCase.sessionId } });
      assert.equal(bound.kind, "bound_source", bound.code);
      const start = performance.now(), full = await bound.observe(request);
      if (process.platform === "win32") {
        assert.deepEqual(full, { kind: "source_unavailable", code: "source_platform_unsupported" }); bound.revoke(); continue;
      }
      assert.equal(full.kind, "bound_history_observation", full.code);
      assert.equal(full.cleanupConfirmed, true); assert.equal(full.sourceAuthenticated, false); assert.equal(full.publishable, false);
      const history = full.history;
      assert.equal(validator.validateHistory(history, testCase.sessionId, { offset: 0, limit: 100 }), true);
      assert.deepEqual(history.observation.messages.map(row => row.nativeMessageId), testCase.expectedIds);
      assert.equal(history.source.sha256, digest(encode(testCase.records)));
      assert.deepEqual(history.source.checks, { owner: "posix_euid_and_mode", acl: "no_extended_acl", containment: "root_identity_and_openat_nofollow",
        reads: 2, matchingBytes: true, unchangedObservedIdentity: true });
      assert.ok(Object.values(history.observation.authority).every(v => v === false));
      if (testCase.name === "rich") {
        assert.deepEqual(history.observation.tools.map(tool => tool.observation), ["result_recorded", "error_result_recorded", "request_only"]);
        assert.equal(history.observation.messages[3].metadata.aborted, true);
        assert.equal(history.observation.messages[4].metadata.errorCode, "authentication_failed");
      } else if (testCase.name === "compaction") {
        assert.equal(history.observation.messages[0].blocks[0].kind, "compaction_boundary");
        assert.equal(history.observation.messages[1].metadata.compactSummary, true);
      } else {
        assert.equal(testCase.name, "file-history"); assert.equal(history.observation.auxiliaryRecords.length, 4);
        assert.equal(history.observation.auxiliaryCoverage, "whole_source"); assert.ok(!JSON.stringify(history).includes("/synthetic/never-open"));
      }
      const page = { offset: 1, limit: 2 }, part = await bound.observe({ ...request, requestId: crypto.randomUUID() }, { page, version: full.sourceVersion });
      assert.equal(part.kind, "bound_history_observation", part.code); assert.equal(part.sourceVersion, full.sourceVersion);
      assert.deepEqual(part.history.observation.messages.map(row => row.nativeMessageId), testCase.expectedIds.slice(1, 3));
      assert.equal(part.history.source.recordCount, testCase.records.length); assert.equal(Object.hasOwn(part.history.source, "records"), false);
      assert.equal(service.status().activeWorkers, 0);
      metrics.push({ case: testCase.name, elapsedMs: Math.round(performance.now() - start), rawBytes: history.source.byteLength,
        fullPageBytes: Buffer.byteLength(JSON.stringify(history)), selectedMessages: testCase.expectedIds.length, ...history.metrics });
      bound.revoke(); assert.equal(bound.status().cleanupConfirmed, true);
    }
    if (process.platform !== "win32") {
      const sessionId = "66666666-6666-4666-8666-666666666666", bindingId = crypto.randomUUID();
      const records = Array.from({ length: 80 }, (_, i) => ({ type: "user", sessionId, uuid: fixture.uuid(i + 500),
        parentUuid: i ? fixture.uuid(i + 499) : null, timestamp: "2026-09-01T00:00:00.000Z", message: { role: "user", content: "x".repeat(4000) } }));
      const file = await write(sessionId, encode(records));
      const bound = service.bind({ bindingId, generation: 1, source: { projectsRoot: root, projectKey, sessionId } });
      const request = { bindingId, generation: 1, requestId: crypto.randomUUID() };
      assert.deepEqual(await bound.observe(request), { kind: "source_unavailable", code: "source_observation_too_large" });
      assert.equal(service.status().activeWorkers, 0);
      const page = { offset: 79, limit: 1 }, small = await bound.observe(request, { page });
      assert.equal(small.kind, "bound_history_observation", small.code);
      const appended = Buffer.from(JSON.stringify({ type: "custom-title", sessionId, customTitle: "owned explicit version mutation" }) + "\n");
      await fs.appendFile(file, appended); expectedFiles.set(file, Buffer.concat([expectedFiles.get(file), appended]));
      assert.deepEqual(await bound.observe(request, { page, version: small.sourceVersion }), { kind: "source_unavailable", code: "source_version_changed" });
      assert.deepEqual(await bound.observe(request, { page, version: small.sourceVersion }), { kind: "source_unavailable", code: "source_version_unavailable" });
      const fresh = await bound.observe(request, { page }); assert.equal(fresh.kind, "bound_history_observation", fresh.code); assert.notEqual(fresh.sourceVersion, small.sourceVersion);
      assert.equal(fresh.history.source.sha256, digest(expectedFiles.get(file))); bound.revoke();
    }
    assert.equal((await service.shutdown()).cleanupConfirmed, true);
    const access = await checkHistoryAccess({ sdkPath: sdk, createService, catalog: cases.map(testCase => ({
      catalogId: `fixture-${testCase.name}`, expectedIds: testCase.expectedIds, source: { projectsRoot: root, projectKey, sessionId: testCase.sessionId } })) });
    for (const [file, bytes] of expectedFiles) assert.deepEqual(await fs.readFile(file), bytes, "owned fixture changed outside explicit mutation");
    assert.equal(digest(await fs.readFile(sdk)), sdkSha256); assert.equal(digest(await fs.readFile(helper)), helperSha256);
    for (const instance of services) { const status = await instance.shutdown(); assert.equal(status.cleanupConfirmed, true); assert.equal(status.quarantined, false); }
    return { result: "passed", nodeVersion: process.version, platform: process.platform, arch: process.arch,
      nativePipelineGate: process.platform === "win32" ? "source_platform_unsupported" : "posix_owned_fixture_passed",
      officialSdkVersion: SDK_VERSION, nativeVersion: NATIVE_VERSION, sdkSha256, helperArtifactSha256: helperSha256,
      metrics, elapsedMs: Math.round(performance.now() - started), ...access,
      boundedPageAndVersionGate: process.platform === "win32" ? "source_platform_unsupported" : "posix_owned_fixture_passed",
      sourceAuthenticated: false, publishable: false, privateHistoryReads: 0, modelCalls: 0, productionWiring: false,
      ownedFixturesUnchangedExceptExplicitMutation: true, cleanupConfirmed: true };
  } finally {
    for (const service of services) {
      try { cleanupConfirmed = (await service.shutdown()).cleanupConfirmed === true && cleanupConfirmed; }
      catch { cleanupConfirmed = false; }
    }
    if (cleanupConfirmed) await fs.rm(temp, { recursive: true, force: true });
    else { const error = new Error("native_pipeline_cleanup_unconfirmed_owned_fixtures_preserved"); error.cleanupUnconfirmed = true; throw error; }
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  let helperPath, sdk;
  if (args.length === 1) {
    const target = process.env.CARGO_TARGET_DIR;
    assert.ok(target && path.isAbsolute(target), "explicit absolute local CARGO_TARGET_DIR required");
    helperPath = path.join(target, "debug", `stepsemble-history-source-reader${process.platform === "win32" ? ".exe" : ""}`);
    [sdk] = args;
  } else [helperPath, sdk] = args;
  assert.ok(helperPath && sdk && [1, 2].includes(args.length), "Usage: [CARGO_TARGET_DIR=/absolute/local/build] check-native-history-pipeline.mjs [/absolute/helper] /absolute/sdk.mjs|--download");
  const run = sdkPath => checkNativeHistoryPipeline({ helperPath, sdkPath });
  console.log(JSON.stringify(await (sdk === "--download" ? withDownloadedSdk(run) : run(sdk)), null, 2));
}
