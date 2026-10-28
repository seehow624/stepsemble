"use strict";
// Antigravity runs through its documented stream by default, behind the ACP
// bridge, also in a new Git worktree; agy's own approval is switched off only
// with Stepsemble's gate in its place; and one of its conversations can
// continue in its own screen (a terminal) on request.
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs/promises"), path = require("node:path"), os = require("node:os");
const { spawn, execFile } = require("node:child_process");
const { promisify } = require("node:util");
const execFileAsync = promisify(execFile);
const root = path.resolve(__dirname, "..");
const unix = { skip: process.platform === "win32" ? "the synthetic agy is a POSIX shell shim" : false };

async function knownGitBinary() {
  for (const candidate of ["/usr/bin/git", "/opt/homebrew/bin/git", "/usr/local/bin/git"]) {
    try { await fs.access(candidate); return candidate; } catch {}
  }
  throw new Error("A Git executable in a known system location is required");
}

// A Host with a synthetic agy on PATH and a Git project with one commit.
// agy's first-run pages are done unless a test says otherwise.
async function host(t, extraEnv = {}, { onboarded = true } = {}) {
  const { freePort, waitForServer, stopServer } = await import("../scripts/host-performance-baseline.mjs");
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "stepsemble-agy-routing-"));
  const bin = path.join(home, "bin"), project = path.join(home, "Projects", "app"), log = path.join(home, "agy.log");
  await fs.mkdir(bin); await fs.mkdir(project, { recursive: true });
  if (onboarded) {
    await fs.mkdir(path.join(home, ".gemini/antigravity-cli/cache"), { recursive: true });
    await fs.writeFile(path.join(home, ".gemini/antigravity-cli/cache/onboarding.json"), JSON.stringify({ onboardingComplete: true }));
  }
  await fs.writeFile(path.join(bin, "agy"), `#!/bin/sh\nexec "${process.execPath}" "${path.join(root, "test-support/fake-agy.cjs")}" "$@"\n`, { mode: 0o755 });
  const git = await knownGitBinary();
  const gitEnv = { HOME: home, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: path.join(home, "gitconfig.disabled"), GIT_TERMINAL_PROMPT: "0" };
  const gitArgs = ["-c", "commit.gpgSign=false", "-c", "user.name=Stepsemble Test", "-c", "user.email=test@stepsemble.invalid"];
  await execFileAsync(git, [...gitArgs, "init", "-q"], { cwd: project, env: gitEnv });
  await fs.writeFile(path.join(project, "README.md"), "fixture\n");
  await execFileAsync(git, [...gitArgs, "add", "README.md"], { cwd: project, env: gitEnv });
  await execFileAsync(git, [...gitArgs, "commit", "-q", "-m", "fixture"], { cwd: project, env: gitEnv });
  const port = await freePort(), base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [path.join(root, "server.js")], { cwd: home, env: {
    ...gitEnv, PATH: [bin, path.dirname(process.execPath), path.dirname(git), "/usr/bin", "/bin"].join(path.delimiter),
    GIT_BIN: git, PI_HOME: home, STEPSEMBLE_HOST: "127.0.0.1", STEPSEMBLE_PORT: String(port), STEPSEMBLE_ORPHAN_EXIT: "0",
    FAKE_AGY_LOG: log, ...extraEnv,
  }, stdio: ["ignore", "pipe", "pipe"] });
  await waitForServer(child); child.stdout.resume(); child.stderr.resume();
  const token = (await fs.readFile(path.join(home, ".config/stepsemble/token"), "utf8")).trim();
  let cookie = "";
  const request = (url, body, { origin = true } = {}) => fetch(base + url, { headers: { cookie, "content-type": "application/json", ...(origin ? { origin: base } : {}) },
    ...(body ? { method: "POST", body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(20_000) });
  const login = await request("/api/login", { token }); cookie = login.headers.get("set-cookie").split(";", 1)[0];
  const json = async (url, body, options) => { const response = await request(url, body, options); return { status: response.status, body: await response.json().catch(() => null) }; };
  const starts = async () => (await fs.readFile(log, "utf8").catch(() => "")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
  // agy starts a moment after the conversation is admitted.
  const startedWith = async predicate => {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const row = (await starts()).find(predicate);
      if (row) return row;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    return null;
  };
  t.after(async () => {
    const tasks = (await json("/api/agent-tasks").catch(() => ({ body: {} }))).body?.tasks || [];
    for (const task of tasks) await json("/api/agent/abort", { taskId: task.id }).catch(() => {});
    await stopServer(child);
    await supervisorsExited(home);
    await fs.rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });
  return { home, project: await fs.realpath(project), json, starts, startedWith };
}

// A supervisor records its final state as it exits; removing the home before
// then leaves that record behind in the temporary folder.
async function supervisorsExited(home) {
  const directory = path.join(home, ".config/stepsemble/agent-tasks"), pids = [];
  for (const name of (await fs.readdir(directory).catch(() => [])).filter(name => name.endsWith(".json"))) {
    try { const { supervisorPid } = JSON.parse(await fs.readFile(path.join(directory, name), "utf8")); if (Number.isInteger(supervisorPid)) pids.push(supervisorPid); } catch {}
  }
  const alive = () => pids.filter(pid => { try { process.kill(pid, 0); return true; } catch { return false; } });
  for (let attempt = 0; attempt < 50 && alive().length; attempt += 1) await new Promise(resolve => setTimeout(resolve, 100));
}

test("Antigravity opens in its stream behind the ACP bridge, in a new worktree too, and continues in a terminal on request", unix, async t => {
  const h = await host(t);
  const opened = await h.json("/api/agent/open", { agentId: "antigravity", cwd: h.project, name: "Stream" });
  assert.equal(opened.status, 201, JSON.stringify(opened.body));
  assert.equal(opened.body.kind, "acp");
  assert.equal(opened.body.nativeAcp, true);
  assert.equal(opened.body.acpAgentId, "antigravity");
  const conversationId = opened.body.nativeSessionId;
  assert.match(conversationId, /^fake-conversation-\d+$/, "the conversation is agy's own");
  assert.equal(opened.body.id, `antigravity:${conversationId}`);
  const stream = await h.startedWith(row => row.args.includes("stream-json"));
  assert.ok(stream, "agy started in its stream");
  assert.equal(stream.cwd, h.project);
  // agy's own approval is off only because Stepsemble's gate takes its place.
  assert.ok(stream.args.includes("--dangerously-skip-permissions"));
  assert.equal(stream.args[stream.args.indexOf("--add-dir") + 1], path.join(h.home, ".config/stepsemble/antigravity-gate"));
  assert.ok(stream.gate, "the hook can reach the gate");
  for (const flag of ["--sandbox", "-p", "--print"]) assert.ok(!stream.args.includes(flag), flag);
  assert.ok(!stream.args.includes("--mode"), "a new conversation asks before acting");
  const hooks = JSON.parse(await fs.readFile(path.join(h.home, ".config/stepsemble/antigravity-gate/.agents/hooks.json"), "utf8"));
  assert.match(hooks["stepsemble-approval"].PreToolUse[0].hooks[0].command, /antigravity-approval-hook\.js/);

  const config = await h.json(`/api/antigravity/acp/config?sessionId=${encodeURIComponent(conversationId)}`);
  assert.deepEqual(config.body.configOptions.map(option => option.category), ["model", "thought_level", "mode"]);
  const answered = await h.json("/api/antigravity/acp/prompt", { sessionId: conversationId, text: "hello" });
  assert.equal(answered.status, 200, JSON.stringify(answered.body));
  const events = (await h.json(`/api/antigravity/acp/events?sessionId=${encodeURIComponent(conversationId)}`)).body.events;
  assert.ok(events.some(row => row.update?.sessionUpdate === "agent_message_chunk" && /fake answer 1/.test(row.update.content?.text)));

  const worktree = await h.json("/api/agent/open", { agentId: "antigravity", cwd: h.project, name: "In a worktree", worktree: true });
  assert.equal(worktree.status, 201, JSON.stringify(worktree.body));
  assert.equal(worktree.body.kind, "acp", "a worktree does not fall back to the terminal");
  assert.match(worktree.body.worktree?.branch || "", /^pi-worktree\//);
  assert.equal(worktree.body.cwd, worktree.body.worktree.path);
  assert.ok(await h.startedWith(row => row.args.includes("stream-json") && row.cwd === worktree.body.worktree.path), "agy ran in the worktree");

  // The stream lets go of the conversation before the terminal takes it:
  // agy warns when one conversation is open in two of its processes.
  const starts = (await h.starts()).length;
  const terminal = await h.json("/api/agent/open", { agentId: "antigravity", cwd: h.project, name: "Terminal", terminal: true, conversationId });
  assert.equal(terminal.status, 201, JSON.stringify(terminal.body));
  assert.equal(terminal.body.kind, "cli");
  assert.equal(terminal.body.transport, "pty");
  let tail = "";
  for (let attempt = 0; attempt < 100 && !tail.includes("AGY_ARGS:"); attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 50));
    tail = (await h.json(`/api/agent-task?taskId=${encodeURIComponent(terminal.body.id)}`)).body?.task?.outputTail || "";
  }
  assert.ok(tail.includes('AGY_ARGS:["--conversation","' + conversationId + '"]'), "the same conversation, in agy's own screen");
  // Back in the stream, a new agy process continues the conversation.
  assert.equal((await h.json("/api/antigravity/acp/prompt", { sessionId: conversationId, text: "back here" })).status, 200);
  const resumed = (await h.starts()).slice(starts).find(row => row.args.includes("stream-json"));
  assert.equal(resumed?.args[resumed.args.indexOf("--conversation") + 1], conversationId);

  for (const conversationId of ["bad id", "--mode=auto", "x".repeat(300)]) {
    const refused = await h.json("/api/agent/open", { agentId: "antigravity", cwd: h.project, terminal: true, conversationId });
    assert.equal(refused.status, 400, conversationId.slice(0, 20));
  }
});

test("STEPSEMBLE_ANTIGRAVITY_STRUCTURED=0 keeps Antigravity in the terminal", unix, async t => {
  const h = await host(t, { STEPSEMBLE_ANTIGRAVITY_STRUCTURED: "0" });
  const opened = await h.json("/api/agent/open", { agentId: "antigravity", cwd: h.project, name: "Terminal by choice" });
  assert.equal(opened.status, 201, JSON.stringify(opened.body));
  assert.equal(opened.body.kind, "cli");
  assert.deepEqual(opened.body.terminal, { cols: 120, rows: 40, keys: true });
});

test("a new Antigravity session waits for agy's own first-run pages unless the person starts without them", unix, async t => {
  const h = await host(t, {}, { onboarded: false });
  const status = await h.json(`/api/agent-first-run?agentId=antigravity&cwd=${encodeURIComponent(h.project)}`);
  assert.equal(status.status, 200);
  assert.equal(status.body.onboarding, "needed");
  assert.deepEqual(status.body.trust, { state: "untrusted", writable: true, key: "trustedWorkspaces" });
  const held = await h.json("/api/agent/open", { agentId: "antigravity", cwd: h.project, name: "First" });
  assert.equal(held.status, 409);
  assert.equal(held.body.code, "antigravity_setup_required");
  assert.equal(await h.startedWith(row => row.args.includes("stream-json")), null, "agy did not start before its first-run pages");
  // Starting without them is the person's choice; a terminal continuation
  // shows agy's pages in that terminal itself.
  const skipped = await h.json("/api/agent/open", { agentId: "antigravity", cwd: h.project, name: "Skipped", firstRun: "skip" });
  assert.equal(skipped.status, 201, JSON.stringify(skipped.body));
  const terminal = await h.json("/api/agent/open", { agentId: "antigravity", cwd: h.project, name: "Terminal", terminal: true, conversationId: "fake-conversation-1" });
  assert.equal(terminal.status, 201, JSON.stringify(terminal.body));
  // Trusting the folder is a separate request, never implied.
  const settings = path.join(h.home, ".gemini/antigravity-cli/settings.json");
  assert.equal(await fs.readFile(settings, "utf8").catch(() => null), null, "nothing was written so far");
  assert.equal((await h.json("/api/agent-first-run/trust", { agentId: "antigravity", cwd: h.project }, { origin: false })).status, 403);
  assert.equal((await h.json("/api/agent-first-run/trust", { agentId: "codex", cwd: h.project })).status, 400);
  assert.equal((await h.json("/api/agent-first-run/trust", { agentId: "antigravity", cwd: "/" })).status, 400);
  const trusted = await h.json("/api/agent-first-run/trust", { agentId: "antigravity", cwd: h.project });
  assert.equal(trusted.status, 200);
  assert.deepEqual(JSON.parse(await fs.readFile(settings, "utf8")), { trustedWorkspaces: [h.project] });
  assert.equal((await h.json(`/api/agent-first-run?agentId=antigravity&cwd=${encodeURIComponent(h.project)}`)).body.trust.state, "trusted");
  // Once agy has saved its pages, new sessions start straight away.
  await fs.mkdir(path.join(h.home, ".gemini/antigravity-cli/cache"), { recursive: true });
  await fs.writeFile(path.join(h.home, ".gemini/antigravity-cli/cache/onboarding.json"), JSON.stringify({ consumerOnboardingComplete: true }));
  const opened = await h.json("/api/agent/open", { agentId: "antigravity", cwd: h.project, name: "After setup" });
  assert.equal(opened.status, 201, JSON.stringify(opened.body));
});
