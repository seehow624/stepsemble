"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

// Run the actual controller functions, including finally blocks, with a
// transport that deliberately delivers replies even after abort.
function setup() {
  const source = fs.readFileSync(require.resolve("../public/app.js"), "utf8");
  const calls = [];
  let restores = 0;
  const context = vm.createContext({
    AbortController,
    api(url, opts) { return new Promise((resolve, reject) => calls.push({ url, ...opts, resolve, reject })); },
    renderNewAgentOptions() {}, renderAgentHub() {}, renderAgentTaskCenter() {}, syncAgentTaskPolling() {},
    restoreLastChat() { restores++; },
  });
  vm.runInContext(`let agentCatalogRequest = null, agentCatalog = [], agentTasks = [], agentCatalogError = false;
    let apiBase = '/r/a', selectedId = 'a';
    ${source.slice(source.indexOf("async function loadAgentCatalog("), source.indexOf("function syncAgentTaskPolling("))}
    function snapshot() { return { agentCatalog, agentTasks, agentCatalogError, catalogPending: !!agentCatalogRequest, tasksPending: !!agentTaskRefreshRequest }; }
    function switchHost(id) { resetAgentHub(); selectedId = id; apiBase = '/r/' + id; }
  `, context);
  return { context, calls, snapshot: () => JSON.parse(JSON.stringify(context.snapshot())), restores: () => restores };
}

for (const [method, field, pending] of [["loadAgentCatalog", "connectors", "catalogPending"], ["refreshAgentTasks", "tasks", "tasksPending"]]) {
  test(`${method} fences old-host replies and does not clear a newer request`, async () => {
    const f = setup(), old = f.context[method]();
    f.context.switchHost("b");
    const current = f.context[method]();
    assert.equal(f.calls[0].signal.aborted, true);
    f.calls[0].resolve({ [field]: [{ id: "private-host-a" }] });
    await old;
    assert.equal(f.snapshot()[pending], true);
    assert.deepEqual(f.snapshot().agentTasks, []);
    assert.deepEqual(f.snapshot().agentCatalog, []);
    assert.equal(f.restores(), 0);
    f.calls[1].resolve({ [field]: [{ id: "host-b" }] });
    await current;
    assert.equal(f.snapshot()[pending], false);
    assert.equal(f.snapshot()[field === "tasks" ? "agentTasks" : "agentCatalog"][0].id, "host-b");
  });

  test(`${method} rejects same-host stale success and late failures`, async () => {
    const f = setup(), old = f.context[method](), current = f.context[method]();
    f.calls[1].resolve({ [field]: [{ id: "newest" }] }); await current;
    f.calls[0].resolve({ [field]: [{ id: "stale" }] }); await old;
    assert.equal(f.snapshot()[field === "tasks" ? "agentTasks" : "agentCatalog"][0].id, "newest");
    const failed = f.context[method](); f.context.switchHost("c");
    f.calls[2].reject(new Error("network")); await failed;
    assert.equal(f.snapshot().agentCatalogError, false);
    assert.deepEqual(f.snapshot().agentCatalog, []);
    assert.deepEqual(f.snapshot().agentTasks, []);
  });
}

test("catalog failures are unknown; only a legacy 404 allows Pi fallback", async () => {
  for (const status of [401, 403, 500, undefined, 404]) {
    const f = setup(), request = f.context.loadAgentCatalog();
    f.calls[0].reject(Object.assign(new Error("failure"), { status })); await request;
    assert.equal(f.snapshot().agentCatalogError, status !== 404);
    assert.equal(f.snapshot().agentCatalog.length, status === 404 ? 1 : 0);
  }
});

test("malformed task snapshot preserves the last known same-host tasks", async () => {
  const f = setup(), first = f.context.refreshAgentTasks();
  f.calls[0].resolve({ tasks: [{ id: "running" }] }); await first;
  const invalid = f.context.refreshAgentTasks(); f.calls[1].resolve({ tasks: null }); await invalid;
  assert.equal(f.snapshot().agentTasks[0].id, "running");
  assert.equal(f.restores(), 1);
});

test("project creation is disabled when discovery or the selected executable is unknown", () => {
  const source = fs.readFileSync(require.resolve("../public/app.js"), "utf8");
  const el = { newAgent: { value: "pi" }, newStart: {}, newAgentNote: {}, newWorktree: {} };
  const context = vm.createContext({ el, agentCatalog: [], agentCatalogError: false, agentHubText: key => key });
  vm.runInContext(source.slice(source.indexOf("function updateNewAgentNote("), source.indexOf("async function loadAgentCatalog(")), context);
  context.updateNewAgentNote(); assert.equal(el.newStart.disabled, true);
  context.agentCatalog = [{ id: "pi", installed: true }];
  context.updateNewAgentNote(); assert.equal(el.newStart.disabled, false);
  context.agentCatalogError = true;
  context.updateNewAgentNote(); assert.equal(el.newStart.disabled, true);
  assert.equal(el.newAgentNote.textContent, "unavailable");
});

test("returning to a mobile list clears the desktop pane and stale session identity", async () => {
  const source = fs.readFileSync(require.resolve("../public/app.js"), "utf8");
  const element = () => ({ classList: { add() {}, remove() {} }, style: {}, dataset: {}, textContent: "old session" });
  const el = { viewChat: element(), viewList: element(), viewSettings: element(), viewModelSettings: element(),
    chatTitle: element(), chatSub: element(), messages: { innerHTML: "private old chat" } };
  const context = vm.createContext({ el, isDesktop: () => false, saveActiveDraft() {}, resetProjectChanges() {},
    stopUpdateCenterPolling() {}, closeChat() {}, resetSettingsOverlay() {}, resetSessionUsage() {},
    refreshSessions: async () => {}, rpc: null, viewGeneration: 0, currentSessionCwd: "old" });
  vm.runInContext(source.slice(source.indexOf("function showList(options"), source.indexOf('el.btnBack.addEventListener')), context);
  vm.runInContext(source.slice(source.indexOf("function showChatEmpty("), source.indexOf("function hideChatEmpty(")), context);
  await context.showList();
  assert.equal(el.messages.innerHTML, "");
  assert.equal(el.chatTitle.textContent, "Stepsemble");
  assert.equal(el.chatSub.textContent, "");
  assert.equal(el.chatSub.dataset.base, "");
});
