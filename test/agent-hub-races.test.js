"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

function appSource({ crlf = false } = {}) {
  const raw = fs.readFileSync(require.resolve("../public/app.js"), "utf8");
  const transformed = crlf ? raw.replace(/\r\n?/g, "\n").replace(/\n/g, "\r\n") : raw;
  return transformed.replace(/\r\n?/g, "\n");
}

function sourceSlice(source, startMarker, endMarker, label = startMarker) {
  const start = source.indexOf(startMarker);
  assert.ok(start >= 0, `${label} start marker`);
  const end = source.indexOf(endMarker, start);
  assert.ok(end >= 0, `${label} end marker`);
  return source.slice(start, end);
}

test("chat stop gives retryable feedback, coalesces clicks and fences old-host replies", async () => {
  const source = appSource();
  const calls = [], notices = [];
  let click;
  const button = { disabled: false, addEventListener(name, handler) { assert.equal(name, "click"); click = handler; } };
  const context = vm.createContext({ el: { btnAbort: button }, rpc: { sid: "a", generic: true }, apiBase: "/r/a",
    post(url, body) { return new Promise((resolve, reject) => calls.push({ url, body, resolve, reject })); },
    toast(message) { notices.push(message); }, agentHubText: key => key, syncGenericInputState() {} });
  vm.runInContext(sourceSlice(source, 'el.btnAbort.addEventListener("click"', '// ---- chat ⋯ menu', "chat stop handler"), context);
  const first = click(); await click();
  assert.equal(calls.length, 1); assert.equal(button.disabled, true);
  calls[0].reject(new Error("Stop not confirmed")); await first;
  assert.deepEqual(notices, ["Stop not confirmed"]); assert.equal(button.disabled, false);
  const second = click(); context.rpc = { sid: "b", generic: true }; context.apiBase = "/r/b";
  calls[1].reject(new Error("Stale failure")); await second;
  assert.equal(notices.length, 1, "old-host failure is not shown in the new chat");
  assert.match(sourceSlice(source, "function setStreaming(on)", "// ---- 送出 / 中止", "streaming state"), /el\.btnAbort\.disabled = !!rpc\?\.stopPending/);
});

// Run the actual controller functions, including finally blocks, with a
// transport that deliberately delivers replies even after abort.
function setup() {
  const source = appSource();
  const calls = [];
  let restores = 0;
  const context = vm.createContext({
    AbortController,
    api(url, opts) { return new Promise((resolve, reject) => calls.push({ url, ...opts, resolve, reject })); },
    renderNewAgentOptions() {}, renderAgentHub() {}, renderAgentTaskCenter() {}, syncAgentTaskPolling() {},
    restoreLastChat() { restores++; },
  });
  vm.runInContext(`let agentCatalogRequest = null, agentCatalog = [], agentTasks = [], agentCatalogError = false;
    let newAgentOpenRequest = null, newAgentStartPending = false;
    let apiBase = '/r/a', selectedId = 'a';
    ${sourceSlice(source, "async function loadAgentCatalog(", "function syncAgentTaskPolling(", "agent catalog functions")}
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
  const source = appSource();
  const el = { newAgent: { value: "pi" }, newStart: {}, newAgentNote: {}, newWorktree: {}, newCwd: { value: "/allowed" } };
  const context = vm.createContext({ el, agentCatalog: [], agentCatalogError: false, agentHubText: key => key });
  vm.runInContext(`let newAgentStartPending = false;\n${sourceSlice(source, "function updateNewAgentNote(", "async function loadAgentCatalog(", "new-agent note")}`, context);
  context.updateNewAgentNote(); assert.equal(el.newStart.disabled, true);
  context.agentCatalog = [{ id: "pi", installed: true }];
  context.updateNewAgentNote(); assert.equal(el.newStart.disabled, false);
  el.newCwd.value = "";
  context.updateNewAgentNote(); assert.equal(el.newStart.disabled, true);
  el.newCwd.value = "/allowed";
  context.agentCatalogError = true;
  context.updateNewAgentNote(); assert.equal(el.newStart.disabled, true);
  assert.equal(el.newAgentNote.textContent, "unavailable");
});

test("Pi worktree launch coalesces repeated clicks and host reset aborts the single owned request", async () => {
  // Exercise the same source path after a Windows-style checkout conversion;
  // the VM must receive normalized LF rather than relying on the working tree.
  const source = appSource({ crlf: true });
  const resetStart = source.indexOf("function resetAgentHub(");
  assert.ok(resetStart >= 0, "resetAgentHub start marker");
  const resetEnd = source.indexOf("\n}\n", resetStart);
  assert.ok(resetEnd >= 0, "resetAgentHub end marker");
  const resetSource = source.slice(resetStart, resetEnd + 2);
  let click, finish;
  const launches = [];
  const classes = { add() {} };
  const el = {
    newStart: { disabled: false, addEventListener(type, handler) { assert.equal(type, "click"); click = handler; } },
    newAgent: { value: "pi" }, newAgentNote: {}, newWorktree: { checked: true },
    newCwd: { value: "/owned/repo" }, newName: { value: "Owned Pi worktree" }, newDialog: { classList: classes },
  };
  const context = vm.createContext({ AbortController, el, agentHubText: key => key, browseText: key => key,
    toast() {}, cancelProjectFolderRequest() {}, saveSettings: value => value,
    startNew(...args) { launches.push(args); return new Promise(resolve => { finish = resolve; }); },
    runningStateRequest: null, agentTaskRefreshRequest: null, conversationView: null,
    renderNewAgentOptions() {}, renderAgentHub() {}, renderAgentTaskCenter() {}, syncAgentTaskPolling() {},
  });
  vm.runInContext(`let agentCatalog = [{ id: "pi", installed: true, capabilities: ["rpc", "worktree"] }];
    let agentCatalogError = false, newAgentStartPending = false, newAgentOpenRequest = null;
    let agentCatalogRequest = null, agentTasks = [], conversationSourceState = {}, settings = { removedProjects: [] };
    ${sourceSlice(source, "function updateNewAgentNote(", "async function loadAgentCatalog(", "new-agent note")}
    ${resetSource}
    ${sourceSlice(source, 'el.newStart.addEventListener("click"', "// ---- iOS 鍵盤適配", "new-agent start handler")}
  `, context);
  const first = click();
  assert.equal(el.newStart.disabled, true);
  assert.equal(launches.length, 1);
  await click();
  assert.equal(launches.length, 1, "repeat click cannot create a second child");
  const signal = launches[0][4];
  assert.equal(signal.aborted, false);
  context.resetAgentHub();
  assert.equal(signal.aborted, true, "Host reset cancels the owned worktree launch");
  finish(); await first;
  assert.equal(launches.length, 1);
});

test("folder root bridge is navigation-only and loading cannot start the previously selected cwd", async () => {
  const source = appSource();
  const folderList = () => ({
    innerHTML: "", scrollTop: 0, children: [], contains() { return false; }, focus() {},
    cloneNode() { return folderList(); }, replaceWith() {}, appendChild(child) { this.children.push(child); },
  });
  const el = { newAgent: { value: "pi" }, newStart: {}, newAgentNote: {}, newWorktree: {},
    newCwd: { value: "/previous" }, newFolderPath: {}, newFolderUp: {}, newFolderList: folderList() };
  let finish;
  const replies = [];
  const context = vm.createContext({ AbortController, el, apiBase: "", selectedId: "local", viewGeneration: 1,
    agentHubText: key => key, window: {}, document: {
      activeElement: null, createElement() { return { className: "", textContent: "" }; }, createTextNode: value => value,
    },
    api() { return replies.length ? Promise.resolve(replies.shift()) : new Promise(resolve => { finish = resolve; }); },
  });
  const browseStart = source.indexOf("function isAbsoluteBrowsePath(");
  assert.ok(browseStart >= 0, "browse path start marker");
  const browseEnd = source.indexOf("function openNewDialog(", browseStart);
  assert.ok(browseEnd >= 0, "browse path end marker");
  vm.runInContext(`let agentCatalog = [{ id: "pi", installed: true, capabilities: ["rpc", "worktree"] }];
    let agentCatalogError = false, newAgentStartPending = false;
    ${sourceSlice(source, "function updateNewAgentNote(", "async function loadAgentCatalog(", "new-agent note")}
    let projectFolder = { path: null, parent: null }, projectFolderRequest = null, projectFolderSequence = 0;
    ${source.slice(browseStart, browseEnd)}
  `, context);
  context.renderProjectFolderList = () => {};

  const loading = context.loadProjectFolder("/bridge");
  assert.equal(el.newCwd.value, "");
  assert.equal(el.newStart.disabled, true, "loading a new directory fences the previous selection");
  finish({ path: "/", parent: "/", selectable: false, entries: [{ name: "allowed", path: "/allowed" }] });
  await loading;
  assert.equal(el.newCwd.value, "");
  assert.equal(el.newStart.disabled, true, "filesystem root is a chooser, not a project cwd");

  replies.push({ path: "/allowed", parent: "/", selectable: true, entries: [] });
  await context.loadProjectFolder("/allowed");
  assert.equal(el.newCwd.value, "/allowed");
  assert.equal(el.newStart.disabled, false);

  replies.push({ path: "/", parent: "/", entries: [{ name: "allowed", path: "/allowed" }] });
  await context.loadProjectFolder("/");
  assert.equal(el.newCwd.value, "", "old Hosts use path=parent as a conservative root-bridge fallback");
  assert.equal(el.newStart.disabled, true);
});

test("returning to a mobile list clears the desktop pane and stale session identity", async () => {
  const source = appSource();
  const element = () => ({ classList: { add() {}, remove() {} }, style: {}, dataset: {}, textContent: "old session" });
  const el = { viewChat: element(), viewList: element(), viewSettings: element(), viewModelSettings: element(),
    chatTitle: element(), chatSub: element(), messages: { innerHTML: "private old chat" } };
  const context = vm.createContext({ el, isDesktop: () => false, saveActiveDraft() {}, resetProjectChanges() {},
    stopUpdateCenterPolling() {}, closeChat() {}, resetSettingsOverlay() {}, resetSessionUsage() {},
    refreshSessions: async () => {}, rpc: null, viewGeneration: 0, currentSessionCwd: "old" });
  vm.runInContext(sourceSlice(source, "function showList(options", 'el.btnBack.addEventListener', "show list"), context);
  vm.runInContext(sourceSlice(source, "function showChatEmpty(", "function hideChatEmpty(", "empty chat"), context);
  vm.runInContext(sourceSlice(source, "function setChatAgent(", "function setChatTitle(", "chat agent"), context);
  await context.showList();
  assert.equal(el.messages.innerHTML, "");
  assert.equal(el.chatTitle.textContent, "Stepsemble");
  assert.equal(el.chatSub.textContent, "");
  assert.equal(el.chatSub.dataset.base, "");
});
