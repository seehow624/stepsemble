"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");

test("soak controls have bounded durations, counts and no arbitrary endpoint or existing directory", async () => {
  const { optionsFromArgs } = await import("../scripts/reliability-soak.mjs");
  assert.deepEqual(optionsFromArgs([]), { durationMs: 259200000, intervalMs: 30000, restartEvery: 20, tasks: 8 });
  for (const args of [["--url", "https://example.invalid"], ["--output-dir", "/"], ["--tasks", "0"], ["--tasks", "9"], ["--duration-seconds", "999999"], ["--duration-seconds", "NaN"], ["--interval-ms", "0"], ["--tasks", "2", "--tasks", "3"], ["--tasks"]]) assert.throws(() => optionsFromArgs(args));
});

test("soak process environment cannot inherit native secrets, wrappers or Node preload hooks", async () => {
  const { cleanSoakEnvironment } = await import("../scripts/reliability-soak.mjs");
  const env = cleanSoakEnvironment(path.resolve("synthetic-home"), path.resolve("synthetic-bin"), 12345);
  assert.equal(env.STEPSEMBLE_HOST, "127.0.0.1");
  for (const forbidden of ["NODE_OPTIONS", "NODE_PATH", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "CODEX_HOME", "CLAUDE_CONFIG_DIR", "STEPSEMBLE_TOKEN", "STEPSEMBLE_CLAUDE_DESKTOP_SOCKET", "HTTP_PROXY", "HTTPS_PROXY"]) assert.equal(env[forbidden], undefined);
  assert.equal(env.PI_HOME, env.HOME); assert.equal(env.USERPROFILE, env.HOME);
  assert.deepEqual(env.PATH.split(path.delimiter), [path.resolve("synthetic-bin"), path.dirname(process.execPath)]);
});

test("soak SSE parser reassembles frames and applies replacement snapshots without duplication", async () => {
  const { SoakStream } = await import("../scripts/reliability-soak.mjs");
  const stream = new SoakStream();
  const payload = 'event: connected\ndata: {"type":"connected"}\n\nid: 1\ndata: {"type":"output","text":"你好"}\n\nid: 0\ndata: {"type":"output","text":"你好完整","replace":true}\n\n';
  for (const character of payload) stream.consume(character);
  assert.equal(stream.connected, true); assert.equal(stream.cursor, 0); assert.equal(stream.text, "你好完整");
  assert.throws(() => new SoakStream().consume("x".repeat(2 * 1024 * 1024 + 1)), /sse_frame_limit/);
});

test("real isolated eight-task soak survives graceful and killed HTTP Hosts, then confirms cleanup", async () => {
  const { runSoak } = await import("../scripts/reliability-soak.mjs");
  const result = await runSoak({ durationMs: 3000, intervalMs: 100, restartEvery: 1, tasks: 8 });
  try {
    assert.equal(result.report.status, "passed", `${result.report.failure || result.report.cleanupFailure || "failed"}; evidence: ${result.filename}`);
    assert.equal(result.report.cleanupConfirmed, true);
    assert.ok(result.report.continuousObservedMs >= 3000);
    assert.ok(result.report.gracefulRestarts >= 1 && result.report.crashRestarts >= 1);
    assert.equal(result.report.acknowledgementsVerified, result.report.cycles * 8);
    assert.ok(result.report.sourceSha256["server/session-discovery.js"]);
    await assert.rejects(fs.stat(path.join(result.directory, "home")), { code: "ENOENT" });
    const saved = JSON.parse(await fs.readFile(result.filename, "utf8"));
    assert.equal(saved.status, "passed"); assert.equal(saved.taskCount, 8);
  } finally {
    if (result.report.cleanupConfirmed) await fs.rm(result.directory, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  }
});
