"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), vm = require("node:vm");
const source = fs.readFileSync(require.resolve("../public/app.js"), "utf8");
function setup() {
  const streams = [], seen = [], timers = new Map(); let nextTimer = 0;
  class EventSource {
    constructor(url) { this.url = url; this.listeners = {}; this.closed = false; streams.push(this); }
    addEventListener(name, fn) { this.listeners[name] = fn; }
    close() { this.closed = true; }
    connected(status = "running", extra = {}) { this.listeners.connected({ data: JSON.stringify({ taskId: "same-id", id: "same-id", eventSeq: 10, status, ...extra }) }); }
    message(type, seq, extra = {}) { this.onmessage({ lastEventId: String(seq), data: JSON.stringify({ type, taskId: "same-id", ...extra }) }); }
  }
  const replayNote = { textContent: "", dataset: {}, classList: { add() { replayNote.hidden = true; }, remove() { replayNote.hidden = false; } }, hidden: true };
  const el = { input: { value: "preserved draft" }, btnSend: {}, queueNote: { dataset: {}, classList: { add() {}, remove() {} } }, taskReplayNote: replayNote };
  const context = vm.createContext({ EventSource, el, rpc: null, apiBase: "/r/a", viewGeneration: 1, currentSessionCwd: "/fixture",
    api: async () => ({ task: { id: "same-id", status: "running", agentId: "codex" } }),
    setTimeout(fn) { const id = ++nextTimer; timers.set(id, fn); return id; }, clearTimeout(id) { timers.delete(id); },
    $: () => null, agentHubText: key => key, tKey: key => key, agentConnectorLabel: id => id, updateAgentTaskCache() {}, resetGenericReplayNotice() {},
    agentTaskIsRunning: task => ["starting", "running", "reconnecting"].includes(task.status),
    toast() {}, showList() {}, showRemoteAuthorizationState() {} });
  vm.runInContext(source.slice(source.indexOf("function genericTaskTerminal("), source.indexOf("function updateAgentTaskCache(")), context);
  context.setStreaming = on => { if (context.rpc) context.rpc.streaming = on; context.syncGenericInputState(); };
  context.applyGenericTaskSnapshot = snapshot => { context.applyGenericReplayMetadata(snapshot); context.rpc.taskStatus = snapshot.status; seen.push(snapshot.status); context.syncGenericInputState(); };
  context.handleAgentTaskEvent = data => { seen.push(data.type); if (data.status) { context.rpc.taskStatus = data.status; context.syncGenericInputState(); } };
  vm.runInContext(source.slice(source.indexOf("async function connectAgentTask("), source.indexOf("function closeChat(")), context);
  return { context, streams, seen, timers, el };
}
test("generic input waits for the task snapshot, not transport-open", async () => {
  const f = setup(); await f.context.connectAgentTask({ taskId: "same-id" });
  assert.equal(f.el.btnSend.disabled, true); f.streams[0].onopen(); assert.equal(f.el.btnSend.disabled, true);
  f.streams[0].connected(); assert.equal(f.el.btnSend.disabled, false);
  f.streams[0].onerror(); assert.equal(f.el.btnSend.disabled, true); assert.equal(f.el.input.value, "preserved draft");
});
test("bounded replay gaps are surfaced without making the task look complete", async () => {
  const f = setup(); await f.context.connectAgentTask({ taskId: "same-id" });
  f.streams[0].connected("running", { replayGap: true });
  assert.equal(f.el.taskReplayNote.hidden, false);
  assert.equal(f.el.taskReplayNote.textContent, "runtime.genericReplayGap");
  assert.equal(f.context.rpc.taskStatus, "running");
});
test("terminal task snapshots stay read-only despite historical lifecycle replay", async () => {
  const f = setup(); await f.context.connectAgentTask({ taskId: "same-id" }); f.streams[0].connected("completed");
  assert.equal(f.el.input.readOnly, true); assert.equal(f.el.btnSend.disabled, true);
  f.streams[0].message("task_started", 1, { status: "running" });
  f.streams[0].message("status", 9, { status: "waiting" });
  f.streams[0].message("output", 8, { text: "historical output still visible" });
  assert.equal(f.context.rpc.taskStatus, "completed"); assert.deepEqual(f.seen, ["completed", "output"]);
  f.streams[0].onerror(); assert.equal(f.streams[0].closed, true, "terminal EOF must stop native EventSource retries");
});
test("old Host/same-task-ID callbacks and timers cannot control a new connection", async () => {
  const f = setup(); await f.context.connectAgentTask({ taskId: "same-id" }); const old = f.streams[0];
  const oldTimeout = [...f.timers.values()][0];
  f.context.apiBase = "/r/b"; f.context.viewGeneration++;
  await f.context.connectAgentTask({ taskId: "same-id" }); const current = f.context.rpc;
  old.onopen(); old.connected("failed"); old.message("task_exit", 11, { status: "failed" }); old.onerror(); oldTimeout();
  assert.equal(f.context.rpc, current); assert.equal(current.taskStatus, "running"); assert.deepEqual(f.seen, []);
  assert.equal(f.streams.length, 2); assert.equal(f.streams[1].closed, false);
  f.streams[1].connected("waiting"); assert.equal(f.el.btnSend.disabled, false);
  f.context.rpc = null; old.connected(); assert.equal(f.streams[1].closed, false);
});
test("invalid or foreign connected frames cannot enable input", async () => {
  for (const extra of [{ taskId: "foreign" }, { id: "foreign" }, { status: "approved" }, { eventSeq: -1 },
    { replayFloor: 12 }, { replayFloor: "2" }, { replayTruncated: "true" }, { replayGap: "true" }, { replayAfter: "later" }]) {
    const f = setup(); await f.context.connectAgentTask({ taskId: "same-id" }); f.streams[0].connected("running", extra);
    assert.equal(f.streams[0].closed, true); assert.equal(f.el.btnSend.disabled, true); assert.deepEqual(f.seen, []);
  }
});
test("send guard does not clear a draft or contact the Host while input is unavailable", async () => {
  const f = setup(); await f.context.connectAgentTask({ taskId: "same-id" }); f.streams[0].connected("stopped");
  f.context.pendingImages = [];
  vm.runInContext(source.slice(source.indexOf("async function sendCurrent("), source.indexOf('el.btnAbort.addEventListener("click"')), f.context);
  await f.context.sendCurrent(); assert.equal(f.el.input.value, "preserved draft");
  assert.equal(f.context.genericInputBlock({ generic: false }), null);
  assert.equal(f.context.genericInputBlock({ generic: true, streamReady: true, taskStatus: "waiting", stopPending: true }), "inputUnavailable");
});
