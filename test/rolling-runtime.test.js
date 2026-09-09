"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path");
const manifest = require("../scripts/browser-test-runtime/package.json"), lock = require("../scripts/browser-test-runtime/package-lock.json");
test("browser runtime lock pins reviewed public packages and rejects changed sources or hashes", async () => {
  const { validateBrowserLock } = await import("../scripts/check-rolling-clients.mjs");
  assert.equal(validateBrowserLock(manifest, lock), true);
  for (const patch of [{ version: "1.0.0" }, { resolved: "https://untrusted.invalid/pkg.tgz" }, { integrity: "sha1-bad" }, { link: true }]) {
    const changed = structuredClone(lock); Object.assign(changed.packages["node_modules/playwright"], patch);
    assert.throws(() => validateBrowserLock(manifest, changed));
  }
  const changed = structuredClone(lock); changed.packages["node_modules/unreviewed"] = changed.packages["node_modules/playwright"];
  assert.throws(() => validateBrowserLock(manifest, changed));
  assert.throws(() => validateBrowserLock({ ...manifest, private: false }, lock));
});
test("browser and synthetic Host environments contain only runtime essentials and owned HOME/config paths", async () => {
  const { cleanEnvironment } = await import("../scripts/check-rolling-clients.mjs");
  const home = path.resolve("synthetic-test-home"), env = cleanEnvironment(home);
  assert.equal(env.HOME, home); assert.equal(env.USERPROFILE, home);
  assert.equal(env.PLAYWRIGHT_BROWSERS_PATH, path.join(home, "browsers"));
  const allowed = new Set(["PATH", "Path", "SystemRoot", "SYSTEMROOT", "WINDIR", "TEMP", "TMP", "TMPDIR", "LANG", "LC_ALL", "HOME", "USERPROFILE", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "PLAYWRIGHT_BROWSERS_PATH"]);
  assert.ok(Object.keys(env).every(key => allowed.has(key)));
});
test("rolling matrix names exactly two immutable shipped release commits", () => {
  const { releases } = require("../protocol/rolling-releases.json");
  assert.equal(releases.length, 2); assert.equal(new Set(releases.map(row => row.commit)).size, 2);
  for (const row of releases) { assert.match(row.commit, /^[a-f0-9]{40}$/); assert.equal(row.tag, `v${row.version}`); }
});
test("rolling owned history helper uses the pinned release build and matching output", () => {
  const workflow = fs.readFileSync(path.resolve(".github/workflows/rolling-clients.yml"), "utf8");
  assert.match(workflow, /cargo \+1\.97\.1 build --manifest-path crates\/history-source-reader\/Cargo\.toml --locked --release --bins --example owned_sqlite_writer/);
  assert.match(workflow, /npm run test:rolling -- --history-helper="\$\{\{ runner\.temp \}\}\/stepsemble-browser-reader\/release\/stepsemble-history-source-reader"/);
  assert.doesNotMatch(workflow, /npm run test:rolling -- --history-helper="[^\n]*\/debug\/stepsemble-history-source-reader"/);
});
test("browser matrix splits finite workers without losing or repeating any suite", async () => {
  const { browserWorkerJobs } = await import("../scripts/check-rolling-clients.mjs");
  const runtime = path.resolve("owned-runtime"), helper = path.resolve("owned-helper");
  const jobs = browserWorkerJobs(runtime, helper);
  assert.deepEqual(jobs.map(job => job.suite), ["core", "sources", "codex"]);
  for (const job of jobs) {
    assert.equal(path.basename(job.args[0]), "rolling-browser-worker.mjs");
    assert.deepEqual(job.args.slice(1), [runtime, job.suite, ...(job.suite === "core" ? [] : [helper])]);
  }
  assert.deepEqual(browserWorkerJobs(runtime).map(job => job.suite), ["core"]);
});
test("browser runner distinguishes process-budget cancellation from a case failure and waits for close", async () => {
  const { run } = await import("../scripts/check-rolling-clients.mjs"), { EventEmitter } = require("node:events");
  let attempts = 0, closed = false;
  const makeChild = () => {
    attempts++;
    const child = new EventEmitter();
    child.kill = signal => {
      assert.equal(signal, "SIGTERM");
      setImmediate(() => { closed = true; child.emit("close", 1, null); });
      return true;
    };
    return child;
  };
  await assert.rejects(run("owned", [], ".", {}, 10, makeChild), /exceeded 10ms process budget \(1\); no retry/);
  assert.equal(attempts, 1); assert.equal(closed, true);
  for (const code of [0, 1]) {
    const operation = run("owned", [], ".", {}, 1000, () => {
      const child = new EventEmitter();
      child.kill = () => assert.fail("completed child must not be killed");
      setImmediate(() => child.emit("close", code, null)); return child;
    });
    if (code === 0) await operation;
    else await assert.rejects(operation, /child failed \(1\)/);
  }
});
