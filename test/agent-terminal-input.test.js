const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createAgentTaskService } = require("../server/agent-connectors");
const { KEYS, terminalSubmission, terminalTyping, terminalText, createPasteModeTracker } = require("../server/terminal-keys");

const unix = { skip: process.platform === "win32" ? "full-screen programs need a PTY" : false };
const FAKE_TUI = path.join(__dirname, "..", "test-support", "fake-raw-tui.cjs");
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function until(predicate, label, timeoutMs = 8000) {
  const end = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < end) await sleep(25);
  assert.ok(predicate(), label);
}

// An installed "agy" that behaves like a full-screen terminal program.
function terminalAgent(t, env = {}) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "stepsemble-tui-"));
  const bin = path.join(temp, "bin"), project = path.join(temp, "project");
  fs.mkdirSync(bin); fs.mkdirSync(project);
  fs.writeFileSync(path.join(bin, "agy"), `#!/bin/sh\nexec "${process.execPath}" "${FAKE_TUI}"\n`, { mode: 0o755 });
  const service = createAgentTaskService({
    appHome: temp, configDir: path.join(temp, "config"), piBin: "/usr/local/bin/pi",
    env: { PATH: [bin, path.dirname(process.execPath), process.env.PATH || ""].join(path.delimiter), HOME: temp, ...env },
    validateCwd: value => value === project ? project : null,
  });
  t.after(async () => {
    await service.shutdown();
    fs.rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  return { service, project };
}

async function openReady(service, project) {
  const task = await service.open({ agentId: "antigravity", cwd: project, name: "Terminal program" });
  const tail = () => service.get(task.id).outputTail;
  await until(() => /READY raw/.test(tail()), "the terminal program started in raw mode");
  return { task, tail };
}

test("terminal text keeps typing and line breaks but drops control bytes", () => {
  assert.equal(terminalText("a\tb\r\nc\rd\x1b[201~\x03\x00e\x7f"), "a\tb\nc\nd[201~e");
  assert.deepEqual(terminalSubmission("hello"), ["hello\r"]);
  assert.deepEqual(terminalSubmission("one\ntwo"), ["one\ntwo\r"], "without bracketed paste lines are typed, then Enter");
  assert.deepEqual(terminalSubmission("one\r\ntwo", { bracketedPaste: true }), ["\x1b[200~one\ntwo\x1b[201~", "\r"]);
  assert.deepEqual(terminalSubmission("single", { bracketedPaste: true }), ["single\r"], "one line needs no paste");
  assert.equal(terminalTyping("y"), "y");
  assert.equal(terminalTyping("a\nb", { bracketedPaste: true }), "\x1b[200~a\nb\x1b[201~");
  assert.equal(KEYS.enter, "\r");
  assert.equal(KEYS.up, "\x1b[A");
});

test("bracketed paste follows the program's own switch, even split across output chunks", () => {
  const mode = createPasteModeTracker();
  assert.equal(mode.enabled(), false);
  mode.observe("hello \x1b[?20"); mode.observe("04h world");
  assert.equal(mode.enabled(), true, "a switch split across chunks still counts");
  mode.observe("\x1b[?1049;2004l");
  assert.equal(mode.enabled(), false, "a combined DECRST turns it off");
  mode.observe("\x1b[?2004h\x1b[?25l");
  assert.equal(mode.enabled(), true);
  mode.observe("\x1b[?25h text");
  assert.equal(mode.enabled(), true, "other modes leave it alone");
});

test("a composer message reaches a full-screen program as Enter, not a line feed", unix, async t => {
  const { service, project } = terminalAgent(t);
  const { task, tail } = await openReady(service, project);
  assert.deepEqual(task.terminal, { cols: 120, rows: 40, keys: true }, "the browser learns the grid it draws");
  assert.equal(service.send(task.id, "hello").sent, true);
  await until(() => tail().includes('SUBMIT:"hello"'), "the program saw Enter and submitted the message");
  assert.doesNotMatch(tail(), /NEWLINE/, "a line feed would only have added a line to the box");
});

test("several lines go in as one paste when the program allows it", unix, async t => {
  const { service, project } = terminalAgent(t);
  const { task, tail } = await openReady(service, project);
  service.send(task.id, "line one\nline two");
  await until(() => tail().includes('SUBMIT:"line one\\nline two"'), "the whole message was submitted once");
  assert.match(tail(), /PASTE:"line one\\nline two"/);
  assert.equal(tail().split("SUBMIT:").length - 1, 1, "the line break did not submit early");
});

test("without bracketed paste several lines are typed and then submitted once", unix, async t => {
  const { service, project } = terminalAgent(t, { FAKE_TUI_PASTE: "0" });
  const { task, tail } = await openReady(service, project);
  service.send(task.id, "a\nb");
  await until(() => tail().includes('SUBMIT:"a\\nb"'), "typed lines, then one Enter");
  assert.equal(tail().split("SUBMIT:").length - 1, 1);
});

test("a message cannot smuggle keys into the terminal", unix, async t => {
  const { service, project } = terminalAgent(t);
  const { task, tail } = await openReady(service, project);
  service.send(task.id, "x\x1b[201~\x03y");
  await until(() => tail().includes('SUBMIT:"x[201~y"'), "control bytes were dropped from the text");
  assert.doesNotMatch(tail(), /KEY:ctrl-c|KEY:escape/);
});

test("terminal keys from the browser drive a first-run menu, and only known keys or plain text pass", unix, async t => {
  const { service, project } = terminalAgent(t, { FAKE_TUI_MENU: "terminal,light,dark" });
  const { task, tail } = await openReady(service, project);
  await until(() => tail().includes("MENU:terminal"), "the menu is showing");
  assert.equal(service.input(task.id, { key: "down" }).accepted, true);
  await until(() => tail().includes("MENU:light"), "down moved the selection");
  service.input(task.id, { key: "down" });
  await until(() => tail().includes("MENU:dark"), "down again");
  service.input(task.id, { key: "enter" });
  await until(() => tail().includes("CHOSE:dark"), "Enter chose the highlighted item");
  service.input(task.id, { data: "y" });
  service.input(task.id, { key: "enter" });
  await until(() => tail().includes('SUBMIT:"y"'), "typed text then Enter");
  service.input(task.id, { key: "escape" });
  await until(() => tail().includes("KEY:escape"), "Escape is its own key");
  for (const payload of [{ key: "f13" }, { key: "__proto__" }, { data: "\x1b[A" }, { data: "" }, { data: "ok\x03" }, { key: "up", data: "x" }, {}, { data: "x".repeat(8193) }]) {
    assert.throws(() => service.input(task.id, payload), error => error.statusCode === 400, JSON.stringify(payload).slice(0, 40));
  }
  service.get(task.id).transport = "pipe";
  assert.throws(() => service.input(task.id, { key: "enter" }), error => error.statusCode === 409 && error.code === "terminal_keys_unavailable");
  service.get(task.id).transport = "pty";
  assert.equal(await service.stop(task.id), true);
  assert.throws(() => service.input(task.id, { key: "enter" }), error => error.statusCode === 409);
  assert.throws(() => service.input("missing", { key: "enter" }), error => error.statusCode === 404);
});
