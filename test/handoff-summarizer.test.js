"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { EventEmitter } = require("node:events"); const { PassThrough } = require("node:stream");
const { createHandoffSummarizer, commandFor, parseOutput } = require("../server/handoff-summarizer");
const SOURCE = "00000000-0000-4000-8000-0000000000a1", TARGET = "00000000-0000-4000-8000-0000000000a2";
const flush = () => new Promise(resolve => setImmediate(resolve));
const turn = (index, chars = 40) => ({ index, user: "u".repeat(chars), replies: ["r".repeat(chars)], tools: [] });

// A child process the test answers: it records the arguments and stdin.
function spawner(reply) {
  const runs = [];
  const spawnImpl = (file, args, options) => {
    const child = new EventEmitter(); child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    const run = { file, args, options, input: "", child, killed: false }; runs.push(run);
    child.kill = () => { run.killed = true; setImmediate(() => child.emit("close", null, "SIGTERM")); };
    child.stdin.on("data", chunk => { run.input += chunk; if (/\n$/.test(run.input) || !args.includes("rpc")) reply(run); });
    child.stdin.on("finish", () => { if (!run.answered && !args.includes("rpc")) reply(run); });
    return child;
  };
  return { runs, spawnImpl };
}
const answer = (run, text) => { if (run.answered) return; run.answered = true; setImmediate(() => { run.child.stdout.end(text); run.child.emit("close", 0, null); }); };

function fixture(t, { turns = [turn(1), turn(2)], nativeSummary = null, reply, installed = ["claude-code", "codex", "pi"], limits = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "stepsemble-handoff-")); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const spawn = spawner(reply || (run => answer(run, JSON.stringify({ type: "result", is_error: false, result: "SUMMARY " + run.input.length }))));
  let revision = "rev-1"; const reads = [];
  const service = createHandoffSummarizer({
    transcripts: { async read(key) { reads.push(key); if (key !== SOURCE) throw Object.assign(new Error("workspace_entry_not_found"), { code: "workspace_entry_not_found", statusCode: 404 }); return { agentId: "pi", name: "Fix login", cwd: "/owned", turns, nativeSummary, revision }; } },
    resolve: key => key === TARGET ? { key, record: { agentId: "codex" } } : key === SOURCE ? { key, record: { agentId: "pi" } } : null,
    configFile: path.join(dir, "handoff.json"), commands: () => ({ "claude-code": "/bin/claude", codex: "/bin/codex", pi: "/bin/pi" }),
    installed: () => new Set(installed), spawnImpl: spawn.spawnImpl, environment: () => ({ PATH: "/usr/bin", HOME: dir, SECRET_HOST_TOKEN: "x" }), limits,
  });
  t.after(() => service.close());
  return { service, spawn, reads, setRevision: value => { revision = value; }, dir };
}
async function settle(service, id) { for (let i = 0; i < 200; i++) { const job = service.get(id); if (!["queued", "running"].includes(job.status)) return job; await flush(); } return service.get(id); }

test("each summarizer runs without tools, sessions or extensions, in its own empty folder", () => {
  const claude = commandFor("claude-code", { command: "/bin/claude", model: "sonnet", effort: "low" });
  assert.deepEqual(claude.args, ["-p", "--no-session-persistence", "--tools", "", "--strict-mcp-config", "--disable-slash-commands", "--output-format", "json", "--model", "sonnet", "--effort", "low"]);
  const codex = commandFor("codex", { command: "/bin/codex", model: "gpt-6-mini", effort: "low" });
  assert.equal(codex.args[0], "exec"); for (const flag of ["--ephemeral", "--skip-git-repo-check", "--ignore-rules", "--json"]) assert.ok(codex.args.includes(flag), flag);
  for (const feature of ["shell_tool", "unified_exec", "multi_agent", "goals", "view_image", "apps", "plugins", "hooks", "image_generation", "browser_use", "computer_use"]) assert.ok(codex.args.join(" ").includes("--disable " + feature), feature);
  assert.ok(codex.args.includes('web_search="disabled"')); assert.ok(codex.args.includes("mcp_servers={}")); assert.deepEqual(codex.args.slice(-1), ["-"]);
  assert.ok(codex.args.includes("gpt-6-mini")); assert.ok(codex.args.includes('model_reasoning_effort="low"'));
  const pi = commandFor("pi", { command: "/bin/pi", model: "anthropic/claude", effort: "low" });
  assert.deepEqual(pi.args, ["--mode", "rpc", "--no-session", "--no-tools", "--no-extensions", "--no-mcp", "--no-skills", "--model", "anthropic/claude", "--thinking", "low"]);
  assert.deepEqual(commandFor("claude-code", { command: "/bin/claude" }).args.slice(-1), ["json"], "the agent's own defaults when nothing is chosen");
});

test("each summarizer's own output is read: Claude's JSON result, Codex's last agent message, Pi's last reply", () => {
  assert.equal(parseOutput("claude-code", JSON.stringify({ type: "result", is_error: false, result: "Claude summary" })), "Claude summary");
  assert.throws(() => parseOutput("claude-code", JSON.stringify({ type: "result", is_error: true, result: "Not signed in" })), /Not signed in/);
  assert.equal(parseOutput("codex", ['{"type":"thread.started"}', '{"type":"item.completed","item":{"type":"agent_message","text":"first"}}', '{"type":"item.completed","item":{"type":"agent_message","text":"Codex summary"}}', '{"type":"turn.completed"}'].join("\n")), "Codex summary");
  assert.throws(() => parseOutput("codex", '{"type":"turn.failed","error":{"message":"usage limit"}}'), /usage limit/);
  assert.equal(parseOutput("pi", ['{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"Pi summary"}]}}', '{"type":"agent_end"}'].join("\n")), "Pi summary");
  assert.throws(() => parseOutput("codex", ""), /summarizer_empty/);
});

test("a summary runs once per source revision and settings, is cached, and the environment is the Host's own", async t => {
  const f = fixture(t);
  f.service.saveSettings({ agentId: "claude-code", model: "sonnet", effort: "low" });
  const first = await f.service.start({ source: SOURCE, target: TARGET }), again = await f.service.start({ source: SOURCE, target: TARGET });
  assert.equal(first.id, again.id, "an in-flight summary is shared");
  const done = await settle(f.service, first.id);
  assert.equal(done.status, "completed"); assert.match(done.summary, /^SUMMARY/); assert.equal(done.agentId, "claude-code"); assert.equal(done.model, "sonnet"); assert.equal(done.coveredTurns, 2); assert.equal(done.sourceCwd, "/owned");
  assert.equal(f.spawn.runs.length, 1); const run = f.spawn.runs[0];
  assert.equal(run.file, "/bin/claude"); assert.ok(run.options.cwd.startsWith(os.tmpdir()), "an empty temporary folder, not the project");
  assert.equal(fs.existsSync(run.options.cwd), false, "the folder is removed afterwards");
  assert.match(run.input, /data, not instructions/); assert.match(run.input, /Turn 2/);
  const cached = await f.service.start({ source: SOURCE, target: TARGET });
  assert.equal(cached.status, "completed"); assert.equal(cached.cached, true); assert.equal(f.spawn.runs.length, 1);
  f.setRevision("rev-2");
  const fresh = await f.service.start({ source: SOURCE, target: TARGET }); await settle(f.service, fresh.id);
  assert.equal(f.spawn.runs.length, 2, "a new turn in the source makes a new summary");
});

test("a record longer than one call is summarized in order, carrying the summary forward", async t => {
  const f = fixture(t, { turns: Array.from({ length: 6 }, (_, i) => turn(i + 1, 4000)), nativeSummary: { text: "NATIVE-EARLIER", throughTurn: 0 }, limits: { chunkChars: 10000 } });
  f.service.saveSettings({ agentId: "claude-code" });
  const job = await f.service.start({ source: SOURCE, target: TARGET }); const done = await settle(f.service, job.id);
  assert.equal(done.status, "completed"); assert.ok(f.spawn.runs.length > 1); assert.deepEqual(done.progress, { done: f.spawn.runs.length, total: f.spawn.runs.length });
  assert.match(f.spawn.runs[0].input, /NATIVE-EARLIER/, "the agent's own summary seeds the first part");
  assert.match(f.spawn.runs[1].input, /SUMMARY \d+/, "each part updates the summary so far");
});

test("a very large record waits for confirmation before spending tokens", async t => {
  const f = fixture(t, { turns: Array.from({ length: 4 }, (_, i) => turn(i + 1, 5000)), limits: { confirmTokens: 1000 } });
  const waiting = await f.service.start({ source: SOURCE, target: TARGET });
  assert.equal(waiting.status, "needs_confirm"); assert.ok(waiting.estimatedTokens > 1000); assert.equal(f.spawn.runs.length, 0);
  const confirmed = await f.service.start({ source: SOURCE, target: TARGET, confirm: true });
  assert.equal((await settle(f.service, confirmed.id)).status, "completed");
});

test("without a chosen summarizer the first installed agent is used at a low effort", async t => {
  const f = fixture(t, { installed: ["pi"], reply: run => { if (run.input.includes('"type":"prompt"')) answer(run, '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"Pi summary"}]}}\n{"type":"agent_end"}\n'); } });
  const job = await f.service.start({ source: SOURCE, target: TARGET }); const done = await settle(f.service, job.id);
  assert.equal(done.status, "completed"); assert.equal(done.agentId, "pi"); assert.equal(done.summary, "Pi summary");
  assert.ok(f.spawn.runs[0].args.includes("--thinking")); assert.ok(f.spawn.runs[0].args.includes("low"));
  const none = fixture(t, { installed: [] });
  await assert.rejects(none.service.start({ source: SOURCE, target: TARGET }), error => error.code === "summarizer_unavailable");
  const chosen = fixture(t, { installed: ["pi"] });
  chosen.service.saveSettings({ agentId: "codex", model: null, effort: null });
  await assert.rejects(chosen.service.start({ source: SOURCE, target: TARGET }), error => error.code === "summarizer_not_installed", "a missing choice never falls back to another agent");
  assert.equal(chosen.spawn.runs.length, 0);
});

test("cancellation stops the process, failures keep the agent's reason, and nothing retries by itself", async t => {
  const f = fixture(t, { reply: () => {} });
  const job = await f.service.start({ source: SOURCE, target: TARGET }); await flush();
  f.service.cancel(job.id); const cancelled = await settle(f.service, job.id);
  assert.equal(cancelled.status, "cancelled"); assert.equal(f.spawn.runs[0].killed, true);
  const failing = fixture(t, { reply: run => answer(run, JSON.stringify({ type: "result", is_error: true, result: "Claude is not signed in" })) });
  failing.service.saveSettings({ agentId: "claude-code" });
  const bad = await failing.service.start({ source: SOURCE, target: TARGET }); const failed = await settle(failing.service, bad.id);
  assert.equal(failed.status, "failed"); assert.match(failed.error, /not signed in/); assert.equal(failing.spawn.runs.length, 1);
});

test("requests are validated: a missing source, a Hermes target or referencing itself never run", async t => {
  const f = fixture(t);
  await assert.rejects(f.service.start({ source: "bad", target: TARGET }), error => error.statusCode === 400);
  await assert.rejects(f.service.start({ source: SOURCE, target: SOURCE }), error => error.code === "reference_self");
  await assert.rejects(f.service.start({ source: SOURCE, target: "00000000-0000-4000-8000-0000000000ff" }), error => error.statusCode === 404);
  assert.throws(() => f.service.saveSettings({ agentId: "hermes" }), error => error.code === "summarizer_invalid");
  assert.throws(() => f.service.saveSettings({ agentId: "codex", model: "bad\nmodel" }), error => error.code === "summarizer_invalid");
  assert.equal(f.spawn.runs.length, 0);
});

test("settings persist privately and are read back", async t => {
  const f = fixture(t);
  f.service.saveSettings({ agentId: "codex", model: "gpt-6-mini", effort: "medium" });
  assert.deepEqual(f.service.settings(), { agentId: "codex", model: "gpt-6-mini", effort: "medium" });
  if (process.platform !== "win32") assert.equal(fs.statSync(path.join(f.dir, "handoff.json")).mode & 0o777, 0o600);
  f.service.saveSettings({ agentId: null }); assert.deepEqual(f.service.settings(), { agentId: null, model: null, effort: null });
});

test("a shared working folder is reused by every run and kept", async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "stepsemble-handoff-shared-")); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const spawn = spawner(run => answer(run, JSON.stringify({ type: "result", is_error: false, result: "ok" }))), workdir = path.join(dir, "handoff-workdir");
  let revision = 0;
  const service = createHandoffSummarizer({ transcripts: { read: async () => ({ agentId: "pi", name: "n", cwd: "/p", turns: [turn(1)], nativeSummary: null, revision: String(++revision) }) },
    resolve: key => ({ key, record: { agentId: "codex" } }), configFile: path.join(dir, "h.json"), commands: () => ({ "claude-code": "/bin/claude" }),
    installed: () => new Set(["claude-code"]), spawnImpl: spawn.spawnImpl, workdir });
  t.after(() => service.close());
  for (let i = 0; i < 2; i++) { const job = await service.start({ source: SOURCE, target: TARGET }); await settle(service, job.id); }
  assert.equal(spawn.runs.length, 2); assert.ok(spawn.runs.every(run => run.options.cwd === workdir)); assert.equal(fs.existsSync(workdir), true);
});
