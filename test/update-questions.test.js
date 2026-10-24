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
  const questions = [], runs = [], statuses = new Map(), applies = new Map(), toasts = [], timers = [];
  let shown = Promise.resolve();
  const context = vm.createContext({
    Set, Map, Promise, Number, String, Array, JSON, console,
    machines: [{ id: "a" }, { id: "b" }],
    viewGeneration: 0, selectedId: null,
    updateViewIsOpen: () => true,
    updateDeviceView: () => ({ install: true, latest: "3.9.53" }),
    updateDeviceName: machine => machine.id, updateVersionText: value => value, updateText: text => text,
    renderUpdateCenter() {}, renderHarnessUpdates() {}, scheduleUpdateRefreshes() {}, setUpdateCenterSummaryParts() {},
    toast: (message, error) => { toasts.push([message, !!error]); },
    setTimeout: callback => { timers.push(callback); },
    // As the app's dialog: one question at a time, in the order asked. An
    // answer to a later question only counts once the earlier ones have one.
    askConfirm: (question, options) => {
      const answer = deferred(), turn = shown.then(() => answer.promise);
      shown = turn.catch(() => {}); questions.push({ question, options, answer }); return turn;
    },
    requestMachineUpdate: async (machine, route, body) => {
      if (route === "/api/update/status") { const reply = statuses.get(machine.id); return reply ? reply.promise : { data: { updater: {} } }; }
      if (route === "/api/update/run") { runs.push("install " + machine.id); return { data: {} }; }
      if (route === "/api/harness-updates/apply") { runs.push("upgrade " + body.id); const hold = applies.get(body.id); if (hold) await hold.promise; return { data: {} }; }
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
  return { api: context.api, questions, runs, statuses, applies, toasts, flushTimers: () => { for (const callback of timers.splice(0)) callback(); } };
}
const wait = "Wait for the running upgrade to finish, then try again.";

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

test("Install all skips only a device that started while it waited", async () => {
  const h = harness();
  const single = h.api.installDeviceUpdate("a"); await settle();
  const all = h.api.installAllDeviceUpdates(); await settle();
  h.questions[0].answer.resolve(true); await single; h.flushTimers();
  h.questions[1].answer.resolve(true); await all;
  assert.deepEqual(h.runs, ["install a", "install b"], "b still installs; a is not installed twice");
});

test("an agent's upgrade question is not dropped by another agent's upgrade", async () => {
  const h = harness();
  const codex = h.api.applyHarnessUpdate("codex"); await settle();
  const claude = h.api.applyHarnessUpdate("claude"); await settle();
  h.questions[0].answer.resolve(true); await codex;
  h.questions[1].answer.resolve(true); await claude;
  assert.deepEqual(h.runs, ["upgrade codex", "upgrade claude"]);
  assert.deepEqual(h.toasts.filter(([message]) => message === wait), []);
});

test("a yes to Upgrade all while an upgrade still runs says to wait, never vanishes", async () => {
  const h = harness(); h.applies.set("codex", deferred());
  const codex = h.api.applyHarnessUpdate("codex"); await settle();
  const all = h.api.applyAllHarnessUpdates(); await settle();
  h.questions[0].answer.resolve(true); await settle();
  h.questions[1].answer.resolve(true); await all;
  assert.deepEqual(h.runs, ["upgrade codex"], "nothing runs beside the running upgrade");
  assert.deepEqual(h.toasts.at(-1), [wait, true]);
  h.applies.get("codex").resolve(); await codex;
});

test("a single upgrade asked behind Upgrade all neither runs twice nor beside it", async () => {
  const h = harness(); h.applies.set("codex", deferred());
  const all = h.api.applyAllHarnessUpdates(); await settle();
  const codex = h.api.applyHarnessUpdate("codex"); await settle();
  const claude = h.api.applyHarnessUpdate("claude"); await settle();
  h.questions[0].answer.resolve(true); await settle();
  h.questions[1].answer.resolve(true); await codex;
  h.questions[2].answer.resolve(true); await claude;
  assert.deepEqual(h.toasts.at(-1), [wait, true], "claude's own question waits for Upgrade all");
  h.applies.get("codex").resolve(); await all;
  assert.deepEqual(h.runs, ["upgrade codex", "upgrade claude"], "each agent upgrades once, one at a time");
});
