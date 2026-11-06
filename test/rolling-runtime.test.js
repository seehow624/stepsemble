"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path");
const manifest = require("../scripts/browser-test-runtime/package.json"), lock = require("../scripts/browser-test-runtime/package-lock.json");
const { compileFunction, createContext } = require("node:vm");
// Reviewed complete workflow snapshots: runner migration must not alter any
// other topology, command, tool/artifact pin, asset/digest association or budget.
const runnerPolicies = [
  ["ci", "matrix", ["macos-15", "ubuntu-24.04", "windows-2025"], "c27a2f667906eb0693a717f2392447919746c537dce42600e0173f5fd4f3df34"],
  ["rolling-clients", "matrix", ["macos-15", "ubuntu-24.04"], "49d82ca2fe04d5a47d40bceb80ca5783f3a62c608305fff0935e3a9a106febe4"],
  ["native-history-reader", "matrix", ["macos-15", "ubuntu-24.04", "windows-2025"], "03529f3859f5e9e7340bd468280b8826b24ce81311520afaa4ad05aa6db3036a"],
  ["native-codex-composer", "include", ["macos-15", "ubuntu-24.04", "windows-2025"], "f232a1f4ea3ba39e4207e478833f660d9fe1d7b7ebfc599bca58be4d97b96e42"],
  ["release", "single", ["macos-15"], "f35a692b693296630c44abc536c8e9b38563be5894fdedb3060cde6a7901bbbc"],
];
function workflowText(name) { return fs.readFileSync(path.resolve(`.github/workflows/${name}.yml`), "utf8").replace(/\r\n/g, "\n"); }
for (const [name, kind, systems, digest] of runnerPolicies) test(`supported macOS runner policy preserves reviewed ${name} workflow`, () => {
  const source = workflowText(name);
  const actual = kind === "matrix" ? source.match(/os: \[([^\]]+)\]/)?.[1].split(/,\s*/)
    : kind === "include" ? [...source.matchAll(/- os: ([^\n]+)/g)].map(match => match[1])
    : [source.match(/runs-on: ([^\n]+)/)?.[1]];
  assert.deepEqual(actual, systems, "exact supported runner labels and unchanged OS families");
  assert.equal(require("node:crypto").createHash("sha256").update(source).digest("hex"), digest, "all reviewed workflow bytes except the authorized label are fixed");
});
test("supported runner policy retains all13 required jobs and separate release", () => {
  const expanded = runnerPolicies.filter(([name]) => name !== "release").map(([name, kind]) => {
    const source = workflowText(name);
    const matrix = kind === "include" ? [...source.matchAll(/- os: /g)].length : source.match(/os: \[([^\]]+)\]/)[1].split(",").length;
    const jobs = [...source.split("\njobs:\n")[1].matchAll(/^  [\w-]+:\n/gm)].length;
    return matrix + jobs - 1;
  });
  assert.deepEqual(expanded, [3, 3, 4, 3]);
  assert.equal(expanded.reduce((sum, cells) => sum + cells, 0), 13);
  assert.equal([...workflowText("release").split("\njobs:\n")[1].matchAll(/^  [\w-]+:\n/gm)].length, 1);
});
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
  assert.equal(env.STEPSEMBLE_USAGE_PRICING_NETWORK, "0", "hermetic browser Hosts never fetch reference prices");
  const allowed = new Set(["PATH", "Path", "SystemRoot", "SYSTEMROOT", "WINDIR", "TEMP", "TMP", "TMPDIR", "LANG", "LC_ALL", "HOME", "USERPROFILE", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "PLAYWRIGHT_BROWSERS_PATH", "STEPSEMBLE_USAGE_PRICING_NETWORK"]);
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
  assert.deepEqual(jobs.map(job => job.suite), ["core", "conversation-ux", "agent-speed", "workspace", "sources", "codex"]);
  for (const job of jobs) {
    assert.equal(path.basename(job.args[0]), "rolling-browser-worker.mjs");
    assert.deepEqual(job.args.slice(1), [runtime, job.suite, ...(["core", "sources", "codex"].includes(job.suite) ? [helper] : [])]);
  }
  const fallback = browserWorkerJobs(runtime);
  assert.deepEqual(fallback.map(job => job.suite), ["core", "conversation-ux", "agent-speed", "workspace"]);
  for (const job of fallback) assert.deepEqual(job.args.slice(1), [runtime, job.suite]);
});
// Compile only the real dispatch body: no worker import, browser, Host or native CLI.
const coreBrowserHelpers = ["runAgentTerminalBrowserCases", "runSessionTerminalBrowserCases", "runAntigravityStreamBrowserCases",
  "runAgentSetupBrowserCases", "runMagpieGatewayBrowserCases", "runPiSessionBrowserCases", "runProjectPickerBrowserCases",
  "runConversationBrowserCases", "runWebStabilityBrowserCases", "runComposerEffortBrowserCases"];
function expectedBrowserCalls(helper) {
  const call = (name, ...args) => ({ name, args });
  return {
    core: coreBrowserHelpers.map(name => call(name)),
    "conversation-ux": [call("runPiRecoveryBrowserCases", { output: path.join("/owned/temp", "pi-recovery") }), call("runConversationUxBrowserCases")],
    "agent-speed": [call("runComposerQueueBrowserCases"), ...["native", "magpie"].map(route => call("runAgentSpeedBrowserCases", {
      engine: "chromium", route, output: path.join("/owned/temp", "agent-speed"),
    })), call("runUsageBrowserCases")],
    workspace: ["runScrollbarBrowserCases", "runProjectFilesBrowserCases", "runWorkspaceReorderBrowserCases", "runWorkspacePanesBrowserCases",
      "runWorkspaceMachinesBrowserCases", "runWorkspaceSchedulesBrowserCases", "runWorkspaceStatusBrowserCases", "runInterfaceStyleBrowserCases"]
      .map(name => call(name)).concat(call("runDesignPolishBrowserCases", { engine: "chromium" })),
    sources: [call("runHistorySourcesBrowserCases", helper), call("runCodexActivityBrowserCases")],
    codex: [call("runCodexHistoryBrowserCases", helper)],
  };
}
async function captureBrowserDispatch(workerSource, jobs) {
  const worker = workerSource.replace(/\r\n/g, "\n");
  const start = worker.indexOf('  if (suite === "core") {'), end = worker.indexOf("} finally { await cleanup(); }", start);
  assert.ok(start >= 0 && end > start, "actual final suite dispatch is present");
  const names = [...new Set(Object.values(expectedBrowserCalls("/owned/helper")).flat().map(call => call.name))];
  const dispatch = compileFunction(`return (async () => {\n${worker.slice(start, end)}\n})();`,
    ["suite", "browser", "historyHelper", "pins", "released", "exec", "runCase", "path", "root", "temp", "console", ...names],
    { parsingContext: createContext({}) });
  const pins = [{ tag: "synthetic-old-a", commit: "a".repeat(40) }, { tag: "synthetic-old-b", commit: "b".repeat(40) }];
  const plain = value => JSON.parse(JSON.stringify(value));
  const graph = {};
  for (const job of jobs) {
    const record = graph[job.suite] = { calls: [], pairs: [], released: [], exec: [] }, browser = {};
    const released = async pin => { record.released.push(pin); return { name: pin.tag, directory: path.join("/owned/temp", pin.tag), commit: pin.commit }; };
    const exec = async (command, args, options) => {
      record.exec.push(plain({ command, args, options }));
      assert.equal(command, "git");
      assert.ok([JSON.stringify(["rev-parse", "HEAD"]), JSON.stringify(["status", "--porcelain"])].includes(JSON.stringify(args)));
      return { stdout: args[0] === "rev-parse" ? "synthetic-head\n" : "" };
    };
    await dispatch(job.suite, browser, job.args[3], pins, released, exec,
      async (host, client, viewport) => record.pairs.push(plain({ host, client, viewport })),
      path, "/owned/root", "/owned/temp", { log() {} }, ...names.map(name => async (actualBrowser, ...args) => {
        assert.equal(actualBrowser, browser, `${name} receives the same worker browser`);
        record.calls.push({ name, args: plain(args) });
      }));
  }
  return { graph, pins };
}

test("rolling actual dispatch routes complete Codex activity exactly once in both matrix modes", async t => {
  const { browserWorkerJobs } = await import("../scripts/check-rolling-clients.mjs");
  const source = fs.readFileSync(path.resolve("scripts/rolling-browser-worker.mjs"), "utf8").replace(/\r\n/g, "\n");
  const snapshots = [];
  for (const [ending, worker] of [["LF", source], ["CRLF", source.replace(/\n/g, "\r\n")]]) {
    for (const helper of ["/owned/helper", undefined]) {
      const jobs = browserWorkerJobs("/owned/runtime", helper), captured = await captureBrowserDispatch(worker, jobs);
      snapshots.push({ ending, helper, jobs, ...captured });
      t.diagnostic(JSON.stringify({ ending, mode: helper ? "helper6" : "nohelper4", jobs, graph: captured.graph }));
    }
  }
  for (const { ending, helper, jobs, graph, pins } of snapshots) {
    const owners = Object.entries(graph).flatMap(([suite, row]) => row.calls.filter(call => call.name === "runCodexActivityBrowserCases").map(() => suite));
    assert.deepEqual(owners, [helper ? "sources" : "core"], `${ending}: complete Codex activity owner in ${helper ? "helper6" : "nohelper4"}`);
    const expected = expectedBrowserCalls(helper);
    if (!helper) expected.core.splice(-1, 0, { name: "runCodexActivityBrowserCases", args: [] });
    assert.deepEqual(jobs.map(job => job.suite), helper ? Object.keys(expected) : Object.keys(expected).slice(0, 4));
    for (const job of jobs) {
      const row = graph[job.suite];
      assert.deepEqual(row.calls, expected[job.suite], `${ending}: ${job.suite} helper order and arguments`);
      if (job.suite !== "core") assert.deepEqual({ pairs: row.pairs, released: row.released, exec: row.exec }, { pairs: [], released: [], exec: [] });
    }
    const current = { name: "development", directory: "/owned/root", commit: "synthetic-head" };
    const pairs = [];
    for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) for (const pin of pins) {
      const release = { name: pin.tag, directory: path.join("/owned/temp", pin.tag), commit: pin.commit };
      pairs.push({ host: current, client: release, viewport }, { host: release, client: current, viewport });
    }
    assert.deepEqual(graph.core.pairs, pairs, `${ending}: all eight original historical pair/viewport calls exactly once`);
    assert.deepEqual(graph.core.released, pins);
    assert.deepEqual(graph.core.exec, [
      { command: "git", args: ["rev-parse", "HEAD"], options: { cwd: "/owned/root" } },
      { command: "git", args: ["status", "--porcelain"], options: { cwd: "/owned/root" } },
    ]);
  }
});

test("rolling worker argument guard permits only core optional absolute helper and retains fail-closed suites", async () => {
  const { browserWorkerJobs } = await import("../scripts/check-rolling-clients.mjs");
  const source = fs.readFileSync(path.resolve("scripts/rolling-browser-worker.mjs"), "utf8").replace(/\r\n/g, "\n");
  for (const workerSource of [source, source.replace(/\n/g, "\r\n")]) {
    const worker = workerSource.replace(/\r\n/g, "\n"), start = worker.indexOf("const runtime = process.argv[2];"), end = worker.indexOf('if (process.platform === "win32")', start);
    assert.ok(start >= 0 && end > start);
    const guard = compileFunction(worker.slice(start, end), ["process", "path"], { parsingContext: createContext({}) });
    const validate = args => guard({ argv: ["node", "worker", ...args] }, path);
    for (const helper of [undefined, "/owned/helper"]) for (const job of browserWorkerJobs("/owned/runtime", helper)) assert.doesNotThrow(() => validate(job.args.slice(1)));
    for (const suite of ["core", "sources", "codex"]) {
      assert.doesNotThrow(() => validate(["/owned/runtime", suite, "/owned/helper"]));
      for (const helper of ["relative/helper", ""]) assert.throws(() => validate(["/owned/runtime", suite, helper]), /Invalid browser suite or owned helper path/);
      assert.throws(() => validate(["/owned/runtime", suite, "/owned/helper", "extra"]), /Invalid browser suite or owned helper path/);
    }
    for (const suite of ["sources", "codex"]) assert.throws(() => validate(["/owned/runtime", suite]), /Invalid browser suite or owned helper path/);
    for (const suite of ["conversation-ux", "agent-speed", "workspace"]) {
      assert.doesNotThrow(() => validate(["/owned/runtime", suite]));
      for (const helper of ["/owned/helper", "relative/helper", ""]) assert.throws(() => validate(["/owned/runtime", suite, helper]), /Invalid browser suite or owned helper path/);
      assert.throws(() => validate(["/owned/runtime", suite, "/owned/helper", "extra"]), /Invalid browser suite or owned helper path/);
    }
    for (const runtime of [undefined, "", "relative/runtime"]) assert.throws(() => validate([runtime, "core"]), /Missing isolated browser runtime/);
    for (const suite of [undefined, "", "unknown"]) assert.throws(() => validate(["/owned/runtime", suite]), /Invalid browser suite or owned helper path/);
  }
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

test("rolling job leaves enough time for seven bounded suites and cold macOS setup", () => {
  const workflow = fs.readFileSync(path.resolve(".github/workflows/rolling-clients.yml"), "utf8");
  const minutes = Number(workflow.match(/timeout-minutes:\s*(\d+)/)?.[1]);
  assert.ok(minutes >= 25 && minutes <= 30, "the whole-job budget must allow the complete suite without becoming unbounded");
});

test("rolling browser schedules complete Usage helper once after existing agent-speed cases", () => {
  const source = fs.readFileSync(path.resolve("scripts/rolling-browser-worker.mjs"), "utf8");
  // The same scheduling contract applies to LF and CRLF checkouts.
  for (const workerSource of [source.replace(/\r\n/g, "\n"), source.replace(/\r?\n/g, "\r\n")]) {
    const worker = workerSource.replace(/\r\n/g, "\n");
    const agentSpeed = worker.match(/else if \(suite === "agent-speed"\) \{([\s\S]*?)\n  \}\n  else if \(suite === "workspace"\)/)?.[1];
    const workspace = worker.match(/else if \(suite === "workspace"\) \{([\s\S]*?)\n  \}\n  else if \(suite === "sources"\)/)?.[1];
    assert.equal((worker.match(/await runUsageBrowserCases\(browser\);/g) || []).length, 1, "the complete Usage helper runs exactly once");
    assert.ok(agentSpeed && workspace, "both existing worker branches remain present");
    assert.deepEqual(agentSpeed.trim().split("\n").map(line => line.trim()), [
      "await runComposerQueueBrowserCases(browser);",
      'for (const route of ["native", "magpie"]) await runAgentSpeedBrowserCases(browser, { engine: "chromium", route, output: path.join(temp, "agent-speed") });',
      "await runUsageBrowserCases(browser);",
    ], "Usage runs sequentially after the unchanged agent-speed cases");
    assert.doesNotMatch(workspace, /runUsageBrowserCases/, "workspace no longer carries the Usage workload");
  }
});
