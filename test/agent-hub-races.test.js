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
    AbortController, WORKSPACE_PANE: false,
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
  vm.runInContext(`let newAgentStartPending = false;\n${sourceSlice(source, "const PRIMARY_AGENT_FEATURES", "async function loadAgentCatalog(", "new-agent note")}`, context);
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

test("New Project renders only the server capability contract", () => {
  const source = appSource();
  const capabilityRoot = {
    children: [], dataset: {}, hidden: true,
    replaceChildren() { this.children = []; },
    appendChild(child) { this.children.push(child); },
  };
  const el = { newAgent: { value: "claude-code" }, newStart: {}, newAgentNote: {}, newWorktree: {},
    newCwd: { value: "/allowed" }, newAgentCapabilities: capabilityRoot };
  const features = Object.fromEntries([
    ["followUp", "ready"], ["model", "ready"], ["reasoning", "limited"], ["images", "ready"],
    ["approval", "unavailable"], ["recovery", "limited"], ["history", "ready"], ["context", "unknown"],
  ].map(([id, status]) => [id, { status, authority: "fixture", reason: status === "ready" ? null : "fixture_reason" }]));
  const context = vm.createContext({
    el,
    agentCatalogError: false,
    agentCatalog: [{ id: "claude-code", installed: true, description: "Claude fixture", capabilities: [],
      featureContract: { version: 1, features } }],
    agentHubText: key => key,
    tKey: key => key,
    document: { createElement() { return { className: "", dataset: {}, textContent: "", title: "" }; } },
  });
  vm.runInContext(`let newAgentStartPending = false;\n${sourceSlice(source, "const PRIMARY_AGENT_FEATURES", "async function loadAgentCatalog(", "new-agent note")}`, context);
  context.updateNewAgentNote();
  assert.equal(capabilityRoot.hidden, false);
  assert.equal(capabilityRoot.dataset.contractVersion, "1");
  assert.equal(capabilityRoot.children.length, 8);
  assert.deepEqual(capabilityRoot.children.map(chip => [chip.dataset.feature, chip.dataset.status]), [
    ["followUp", "ready"], ["model", "ready"], ["reasoning", "limited"], ["images", "ready"],
    ["approval", "unavailable"], ["recovery", "limited"], ["history", "ready"], ["context", "unknown"],
  ]);
  assert.match(capabilityRoot.children[2].title, /fixture reason/);
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
    ${sourceSlice(source, "const PRIMARY_AGENT_FEATURES", "async function loadAgentCatalog(", "new-agent note")}
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
    ${sourceSlice(source, "const PRIMARY_AGENT_FEATURES", "async function loadAgentCatalog(", "new-agent note")}
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

test("leaving a conversation empties a pane and never shows the old session list", async () => {
  const source = appSource();
  const shown = [];
  const element = name => ({ classList: { add() {}, remove(value) { if (value === "hidden") shown.push(name); } }, style: {}, dataset: {}, textContent: "old session" });
  const el = { viewChat: element("chat"), viewList: element("list"), viewSettings: element("settings"), viewModelSettings: element("models"),
    chatTitle: element("title"), chatSub: element("sub"), messages: { innerHTML: "private old chat" } };
  const replaced = [];
  const context = vm.createContext({ el, WORKSPACE_PANE: true, location: { replace: url => replaced.push(url) }, saveActiveDraft() {}, resetProjectChanges() {},
    stopUpdateCenterPolling() {}, closeChat() {}, resetSettingsOverlay() {}, resetSessionUsage() {},
    refreshSessions: async () => {}, rpc: null, viewGeneration: 0, currentSessionCwd: "old" });
  vm.runInContext(sourceSlice(source, "function showList(", 'el.btnBack.addEventListener', "show list"), context);
  vm.runInContext(sourceSlice(source, "function showChatEmpty(", "function hideChatEmpty(", "empty chat"), context);
  vm.runInContext(sourceSlice(source, "function setChatAgent(", "function setChatTitle(", "chat agent"), context);
  await context.showList();
  assert.equal(el.messages.innerHTML, "");
  assert.equal(el.chatTitle.textContent, "Stepsemble");
  assert.equal(el.chatSub.textContent, "");
  assert.equal(el.chatSub.dataset.base, "");
  assert.ok(!shown.includes("list"), "the old session list stays hidden");
  assert.deepEqual(replaced, [], "a pane stays in the Workspace");
  // Any other page goes to the Workspace instead of a list of its own.
  vm.runInContext("WORKSPACE_PANE = false", context);
  await context.showList();
  assert.deepEqual(replaced, ["/workspace.html"]);
  assert.ok(!shown.includes("list"));
});

// A stored OpenCode conversation reports an idle native status. It used to be
// published as "waiting", which made the inbox claim dozens of pending jobs,
// offered a Stop button the native server always refuses, and let stale rows
// block an update.
test("an idle native conversation is not pending work and cannot offer Stop", () => {
  const source = appSource();
  const context = vm.createContext({});
  vm.runInContext(sourceSlice(source, "function agentTaskIsRunning(", "function agentTaskElapsed(", "task state helpers"), context);

  const stored = { id: "opencode:ses_1", agentId: "opencode", status: "history", idleNativeSession: true, isRunning: false };
  const live = { id: "opencode:ses_2", agentId: "opencode", status: "running", idleNativeSession: false, isRunning: true };
  const cliWaiting = { id: "cli-1", agentId: "codex", status: "waiting" };

  assert.equal(context.agentTaskIsRunning(stored), false);
  assert.equal(context.agentTaskCanStop(stored), false, "a stored conversation must not offer Stop");
  assert.equal(context.agentTaskCanStop(live), true);
  assert.equal(context.agentTaskCanStop(cliWaiting), true, "a real waiting CLI task keeps Stop");

  const filterContext = vm.createContext({ agentTaskIsRunning: context.agentTaskIsRunning });
  vm.runInContext(sourceSlice(source, "function agentTaskCenterFilterMatches(", "function agentTaskCenterSort(", "task filter"), filterContext);
  const active = filterContext.agentTaskCenterFilterMatches;
  assert.equal(active(stored, "active"), false, "stored conversations must not inflate the active count");
  assert.equal(active(live, "active"), true);
  assert.equal(active(cliWaiting, "active"), true);
  assert.equal(active(stored, "all"), true, "All still lists every record");
  // A stored conversation that the user reopens and runs is real active work.
  assert.equal(active({ ...stored, status: "running", isRunning: true }, "active"), true);
});

// Rebuilding the Sessions list on every 5-second poll destroys the row the
// user is clicking and costs a full sort plus re-layout on a phone.
test("an unchanged task poll does not rebuild the session list", () => {
  const source = appSource();
  const context = vm.createContext({ agentTasks: [] });
  vm.runInContext(sourceSlice(source, "function agentTaskListSignature(", "async function refreshAgentTasks(", "task signature"), context);

  const rows = [
    { id: "opencode:a", agentId: "opencode", status: "history", name: "One", cwd: "/p" },
    { id: "cli-b", agentId: "codex", status: "running", name: "Two", cwd: "/p" },
  ];
  context.agentTasks = rows;
  const first = context.agentTaskListSignature();

  // A fresh snapshot with new elapsed/activity values is the common case and
  // must be treated as unchanged.
  context.agentTasks = rows.map((row, index) => ({ ...row, lastActivityAt: 1000 + index, startedAt: 5 }));
  assert.equal(context.agentTaskListSignature(), first, "volatile timestamps must not force a redraw");

  context.agentTasks = [{ ...rows[0], status: "running" }, rows[1]];
  assert.notEqual(context.agentTaskListSignature(), first, "a real status change still redraws");

  context.agentTasks = [rows[0]];
  assert.notEqual(context.agentTaskListSignature(), first, "a removed row still redraws");

  context.agentTasks = [{ ...rows[0], name: "Renamed" }, rows[1]];
  assert.notEqual(context.agentTaskListSignature(), first, "a rename still redraws");
});
