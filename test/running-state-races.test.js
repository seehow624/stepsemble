"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), vm = require("node:vm");
const source = fs.readFileSync(require.resolve("../public/app.js"), "utf8");
function setup() {
  const calls = []; let renders = 0, hidden = false;
  const context = vm.createContext({ AbortController, apiBase: "/r/a", selectedId: "a", viewGeneration: 1,
    sessionsCache: [{ file: "same-path", isRunning: true, runStuck: false }], el: { viewList: { classList: { contains: () => hidden } }, search: { value: "" } },
    api(route, opts) { return new Promise((resolve, reject) => calls.push({ route, ...opts, resolve, reject })); },
    renderSessionList() { renders++; }, syncSessionListPolling() {} });
  vm.runInContext('let runningStateRequest = null;\n' + source.slice(source.indexOf('let lastRunningSignature = ""'), source.indexOf("function syncSessionListPolling()")), context);
  return { context, calls, renders: () => renders, hide: () => { hidden = true; } };
}
test("running badges ignore late same-path replies from a previous Host", async () => {
  const f = setup(), old = f.context.refreshRunningState();
  f.context.apiBase = "/r/b"; f.context.selectedId = "b";
  const next = f.context.refreshRunningState(); assert.equal(f.calls[0].signal.aborted, true);
  f.calls[0].resolve({ rpcs: [] }); await old;
  assert.equal(f.context.sessionsCache[0].isRunning, true); assert.equal(f.renders(), 0);
  await f.context.refreshRunningState(); assert.equal(f.calls.length, 2, "old finally must not clear the new flight");
  f.calls[1].resolve({ rpcs: [] }); await next; assert.equal(f.context.sessionsCache[0].isRunning, false);
});
test("slow polls coalesce and malformed/failed snapshots do not clear live flags", async () => {
  const f = setup(), first = f.context.refreshRunningState(); await f.context.refreshRunningState(); assert.equal(f.calls.length, 1);
  f.calls[0].resolve({ rpcs: null }); await first; assert.equal(f.context.sessionsCache[0].isRunning, true);
  const failed = f.context.refreshRunningState(); f.calls[1].reject(new Error("offline")); await failed;
  assert.equal(f.context.sessionsCache[0].isRunning, true); assert.equal(f.renders(), 0);
});
test("leaving or replacing the view fences a pending run-state response", async () => {
  for (const mode of ["hidden", "generation"]) {
    const f = setup(), first = f.context.refreshRunningState();
    if (mode === "hidden") f.hide(); else f.context.viewGeneration++;
    f.calls[0].resolve({ rpcs: [] }); await first; assert.equal(f.context.sessionsCache[0].isRunning, true); assert.equal(f.renders(), 0);
  }
});
