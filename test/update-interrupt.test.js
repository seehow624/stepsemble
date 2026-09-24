"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { spawnSync } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const updater = fs.readFileSync(path.join(root, "deploy", "stepsemble-update.sh"), "utf8");
const zsh = ["/bin/zsh", "/usr/bin/zsh"].find(file => fs.existsSync(file));

// Runs the updater's own flag and first deferral point with stubbed probes, so
// the test exercises the shipped shell logic rather than a copy of it.
function runGate({ flag, active }) {
  const flagLine = updater.split("\n").find(line => line.startsWith("readonly INTERRUPT_UPDATE="));
  const start = updater.indexOf('if [[ "$INTERRUPT_UPDATE" != "1" ]] && active_rpc_running; then');
  const end = updater.indexOf("archive=", start);
  assert.ok(flagLine && start > 0 && end > start, "updater gate markers");
  const script = [
    flagLine,
    `active_rpc_running() { return ${active ? 0 : 1}; }`,
    'write_state() { print -r -- "state:$6:$7"; }',
    'log() { print -r -- "log:$*"; }',
    'now=now latest_version=v9.9.9 installed_version=v1.0.0',
    updater.slice(start, end),
    'print -r -- "installing"',
  ].join("\n");
  const env = { PATH: process.env.PATH };
  if (flag !== undefined) env.STEPSEMBLE_UPDATE_INTERRUPT = flag;
  const result = spawnSync(zsh, ["-f", "-c", script], { encoding: "utf8", env, timeout: 10000 });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

test("scheduled updates still wait for running agent work", { skip: !zsh && "zsh is not installed" }, () => {
  for (const flag of [undefined, "0", "true", "yes"]) {
    const output = runGate({ flag, active: true });
    assert.match(output, /state:deferred:active_rpc_running/, String(flag));
    assert.doesNotMatch(output, /installing/, String(flag));
  }
  assert.match(runGate({ flag: undefined, active: false }), /^installing$/m);
});

test("a confirmed Update now installs past running work and says so", { skip: !zsh && "zsh is not installed" }, () => {
  const output = runGate({ flag: "1", active: true });
  assert.doesNotMatch(output, /state:deferred/);
  assert.match(output, /log:installing v9\.9\.9 now at the user's request/);
  assert.match(output, /installing/);
});

test("every deferral point in the updater honours the Update now flag", () => {
  const sites = [...updater.matchAll(/^if (.*)active_rpc_running; then$/gm)].map(match => match[1]);
  assert.ok(sites.length >= 2);
  for (const guard of sites) assert.equal(guard, '[[ "$INTERRUPT_UPDATE" != "1" ]] && ');
});

const source = fs.readFileSync(path.join(root, "server.js"), "utf8");
function summaryWith(stubs) {
  const start = source.indexOf("function updateWorkSummary(");
  const end = source.indexOf("function startUpdateCheck(", start);
  assert.ok(start > 0 && end > start);
  const context = vm.createContext({ piSession: { title: meta => meta.name }, ...stubs });
  vm.runInContext(`${source.slice(start, end)}\nthis.summary = updateWorkSummary;`, context);
  return JSON.parse(JSON.stringify(context.summary()));
}

test("the Update now summary says which running work stops and which keeps going", () => {
  const items = summaryWith({
    activeRpcSessionsForUpdate: () => [{ meta: { name: "  Pi   run " } }],
    codexNative: { busyTasks: () => [{ nativeThreadId: "thread-1" }] },
    workspaceRegistry: { list: () => ({ entries: [{ record: { agentId: "codex", nativeThreadId: "thread-1", name: "Codex thread" } }] }) },
    activeAgentTasksForUpdate: () => [
      { id: "native-reservation", status: "running" },
      { id: "claude-code:one", agentId: "claude-code", nativeClaudeStructured: true, name: "Claude task", status: "running" },
      { id: "task-1", agentId: "gemini", name: "Supervised task", status: "running" },
      { id: "grok-build:approval", status: "waiting" },
    ],
  });
  assert.deepEqual(items, [
    { agent: "pi", name: "Pi run", effect: "interrupted" },
    { agent: "codex", name: "Codex thread", effect: "interrupted" },
    { agent: "claude-code", name: "Claude task", effect: "interrupted" },
    { agent: "gemini", name: "Supervised task", effect: "continues" },
    { agent: "grok-build", name: null, effect: "interrupted" },
  ]);
});

test("unexplained native work and an unreadable state are reported as interruptions", () => {
  const reserved = summaryWith({
    activeRpcSessionsForUpdate: () => [], codexNative: { busyTasks: () => [] }, workspaceRegistry: { list: () => ({ entries: [] }) },
    activeAgentTasksForUpdate: () => [{ id: "native-reservation", status: "running" }],
  });
  assert.deepEqual(reserved, [{ agent: null, name: null, effect: "interrupted" }]);
  const broken = summaryWith({ activeRpcSessionsForUpdate: () => { throw new Error("unavailable"); } });
  assert.deepEqual(broken, [{ agent: null, name: null, effect: "interrupted" }]);
});
