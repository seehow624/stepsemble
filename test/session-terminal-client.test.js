"use strict";
// The page side of a CLI session that runs in a terminal (PTY): its screen is
// rebuilt from the output the Host still holds, output feeds the screen
// rather than a transcript, and typed input is not repeated as a bubble.
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), vm = require("node:vm");
const source = fs.readFileSync(require.resolve("../public/app.js"), "utf8");
const slice = (from, to) => source.slice(source.indexOf(from), source.indexOf(to));

function connectSetup(task) {
  const streams = [], calls = { canonical: 0, terminals: 0 };
  class EventSource { constructor(url) { this.url = url; streams.push(this); } addEventListener() {} close() {} }
  const context = vm.createContext({ EventSource, rpc: null, apiBase: "", viewGeneration: 1, currentSessionCwd: "/fixture",
    el: { queueNote: { dataset: {}, classList: { add() {}, remove() {} } } },
    api: async () => ({ task }), setTimeout: () => 0, clearTimeout() {}, agentConnectorLabel: id => id,
    agentTaskIsRunning: row => ["starting", "running"].includes(row.status), updateAgentTaskCache() {}, setStreaming() {},
    resetGenericReplayNotice() {}, syncGenericInputState() {}, toast() {}, showList() {}, tKey: key => key,
    loadGenericCanonicalHistory: async () => { calls.canonical += 1; return true; },
    sessionTerminalFor: () => { calls.terminals += 1; return {}; } });
  vm.runInContext(slice("async function connectAgentTask(", "function closeChat("), context);
  return { context, streams, calls };
}

test("a terminal task replays the screen from the Host's output, not the journal", async () => {
  const f = connectSetup({ id: "pty-task", status: "running", agentId: "antigravity", eventSeq: 7, transport: "pty", terminal: { cols: 120, rows: 40, keys: true } });
  await f.context.connectAgentTask({ taskId: "pty-task" });
  assert.deepEqual(JSON.parse(JSON.stringify(f.context.rpc.terminal)), { cols: 120, rows: 40 });
  assert.equal(f.calls.terminals, 1, "the screen is drawn at once");
  assert.equal(f.calls.canonical, 0, "the journal keeps only the start of a long session");
  assert.match(f.streams[0].url, /after=0$/, "every event the Host still holds is replayed onto the screen");
});

test("a task without a terminal keeps its transcript and journal history", async () => {
  const f = connectSetup({ id: "pipe-task", status: "running", agentId: "codex", eventSeq: 7, transport: "pipe", terminal: null });
  await f.context.connectAgentTask({ taskId: "pipe-task" });
  assert.equal(f.context.rpc.terminal, null);
  assert.equal(f.calls.terminals, 0);
  assert.equal(f.calls.canonical, 1);
  assert.match(f.streams[0].url, /after=7&canonicalHistory=1$/);
});

test("a grid the Host did not vouch for is not drawn as a terminal", async () => {
  for (const terminal of [null, { cols: 120, rows: 40 }, { cols: 1, rows: 40, keys: true }, { cols: "120", rows: 40, keys: true }]) {
    const f = connectSetup({ id: "odd-task", status: "running", agentId: "codex", eventSeq: 1, transport: "pty", terminal });
    await f.context.connectAgentTask({ taskId: "odd-task" });
    assert.equal(f.context.rpc.terminal, null, JSON.stringify(terminal));
  }
});

test("terminal output feeds the screen and typed input is not repeated as a bubble", () => {
  const written = [], appended = [], inputs = [];
  const context = vm.createContext({ rpc: { generic: true, sid: "pty-task", terminal: { cols: 120, rows: 40 }, genericInputEchoes: [] },
    markRpcActivity() {}, writeSessionTerminal: (text, options) => written.push([text, options.replace]),
    appendGenericOutput: text => appended.push(text), appendGenericInput: text => inputs.push(text), el: { messages: { querySelectorAll: () => [] } } });
  vm.runInContext(slice("function handleAgentTaskEvent(", "function openCodeMessageText("), context);
  context.handleAgentTaskEvent({ type: "output", text: "\x1b[2Jscreen", stream: "stdout" }, "pty-task");
  context.handleAgentTaskEvent({ type: "output", text: "tail", replace: true }, "pty-task");
  context.handleAgentTaskEvent({ type: "input", text: "hello" }, "pty-task");
  assert.deepEqual(written, [["\x1b[2Jscreen", false], ["tail", true]]);
  assert.deepEqual(appended, [], "no transcript text for a terminal task");
  assert.deepEqual(inputs, [], "what was typed shows on the program's own screen");
});
