// Install and upgrade questions are the app's own dialog (modules/app-dialog.js):
// the answer comes later, and one question may wait behind another. A device
// or agent is never installed twice because of a question that waited, and a
// question about one device is never dropped because another device started.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "../public/app.js"), "utf8");
const slice = (from, to) => { const start = source.indexOf(from), end = source.indexOf(to, start); assert.ok(start > -1 && end > start, from); return source.slice(start, end); };

function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
const settle = () => new Promise(resolve => setImmediate(resolve));

function harness() {
  const questions = [], runs = [], statuses = new Map(), timers = [];
  const context = vm.createContext({
    Set, Map, Promise, Number, String, Array, JSON, console,
    machines: [{ id: "a" }, { id: "b" }],
    viewGeneration: 0, selectedId: null,
    updateViewIsOpen: () => true,
    updateDeviceView: () => ({ install: true, latest: "3.9.53" }),
    updateDeviceName: machine => machine.id, updateVersionText: value => value, updateText: text => text,
    renderUpdateCenter() {}, renderHarnessUpdates() {}, toast() {}, scheduleUpdateRefreshes() {}, setUpdateCenterSummaryParts() {},
    setTimeout: callback => { timers.push(callback); },
    askConfirm: (question, options) => { const answer = deferred(); questions.push({ question, options, answer }); return answer.promise; },
    requestMachineUpdate: async (machine, route, body) => {
      if (route === "/api/update/status") { const reply = statuses.get(machine.id); return reply ? reply.promise : { data: { updater: {} } }; }
      if (route === "/api/update/run") { runs.push("install " + machine.id); return { data: {} }; }
      if (route === "/api/harness-updates/apply") { runs.push("upgrade " + body.id); return { data: {} }; }
      return { data: {} };
    },
    mergeHarnessStatus: (data) => data, harnessUpdateDataByDevice: new Map(),
    currentMachine: () => ({ id: "a" }), harnessUpdateKind: () => "available", harnessUpgradeable: () => true,
    el: { harnessUpdateApplyAll: {} }, harnessUpgradeResultText: () => "",
  });
  vm.runInContext([
    "let updateInstallAllRunning = false;",
    slice("const harnessUpdateInFlight = new Set();", "const updateRefreshTimers"),
    slice("const updateInstallInFlight = new Set();", "const updateAutoInFlight"),
    slice("async function upgradeHarness(", "\nfunction harnessUpgradeResultText"),
    slice("async function applyHarnessUpdate(", "\n// ---- Settings section list"),
    slice("function updateInterruptQuestion(", "\nasync function checkForClientUpdate("),
    "this.api = { installDeviceUpdate, installAllDeviceUpdates, applyHarnessUpdate, applyAllHarnessUpdates };",
  ].join("\n"), context);
  context.harnessUpdateDataByDevice.set("a", { harnesses: [{ id: "codex", label: "Codex" }, { id: "claude", label: "Claude" }] });
  return { api: context.api, questions, runs, statuses, flushTimers: () => { for (const callback of timers.splice(0)) callback(); } };
}

test("a device's waiting install question does not install it again after Install all did", async () => {
  const h = harness(); h.statuses.set("a", deferred());
  const single = h.api.installDeviceUpdate("a"); await settle();
  const all = h.api.installAllDeviceUpdates(); await settle();
  h.statuses.get("a").resolve({ data: { updater: {} } }); await settle();
  assert.equal(h.questions.length, 2, "both questions are asked");
  h.questions[0].answer.resolve(true); await all; h.flushTimers();
  assert.deepEqual(h.runs, ["install a", "install b"]);
  h.questions[1].answer.resolve(true); await single;
  assert.deepEqual(h.runs, ["install a", "install b"], "device a is not sent a second install");
});

test("a confirmed install for one device is not dropped because another device started", async () => {
  const h = harness(); h.statuses.set("b", deferred());
  const slow = h.api.installDeviceUpdate("b"); await settle();
  const fast = h.api.installDeviceUpdate("a"); await settle();
  h.questions[0].answer.resolve(true); await fast; h.flushTimers();
  h.statuses.get("b").resolve({ data: { updater: {} } }); await settle();
  h.questions[1].answer.resolve(true); await slow;
  assert.deepEqual(h.runs, ["install a", "install b"]);
});

test("Install all skips only a device that started while it was asked", async () => {
  const h = harness();
  const all = h.api.installAllDeviceUpdates(); await settle();
  const single = h.api.installDeviceUpdate("a"); await settle();
  h.questions[1].answer.resolve(true); await single;
  h.questions[0].answer.resolve(true); await all;
  assert.deepEqual(h.runs, ["install a", "install b"], "b still installs; a is not installed twice");
});

test("an agent's upgrade question is not dropped by another agent's upgrade, nor run beside Upgrade all", async () => {
  const h = harness();
  const claude = h.api.applyHarnessUpdate("claude"); await settle();
  const codex = h.api.applyHarnessUpdate("codex"); await settle();
  h.questions[1].answer.resolve(true); await codex;
  h.questions[0].answer.resolve(true); await claude;
  assert.deepEqual(h.runs, ["upgrade codex", "upgrade claude"]);
  // Upgrade all asked while codex's own question waits: codex upgrades once.
  const g = harness();
  const all = g.api.applyAllHarnessUpdates(); await settle();
  const one = g.api.applyHarnessUpdate("codex"); await settle();
  g.questions[1].answer.resolve(true); await one;
  g.questions[0].answer.resolve(true); await all;
  assert.deepEqual(g.runs, ["upgrade codex", "upgrade claude"]);
});
