"use strict";
// Antigravity runs through its documented stream by default, also in a new
// Git worktree; it never gets a flag that approves on its own; and one of its
// conversations can continue in its own screen (a terminal) on request.
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs/promises"), path = require("node:path"), os = require("node:os");
const { spawn, execFile } = require("node:child_process");
const { promisify } = require("node:util");
const execFileAsync = promisify(execFile);
const { buildAntigravityStructuredArgs } = require("../server/antigravity-cli-structured-adapter");
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
    await fs.rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });
  return { home, project: await fs.realpath(project), json, starts, startedWith };
}

test("the stream arguments never carry a flag that approves on its own", () => {
  for (const options of [{}, { model: "magpie/antigravity/gemini-3.8-flash" }, { conversationId: "conv-1" },
    { model: "gemini-4-argon-high", conversationId: "4e502687-290c-4030-b908-5ed6c68fa5dc" }]) {
    const args = buildAntigravityStructuredArgs(options);
    assert.deepEqual(args.slice(0, 4), ["--input-format", "stream-json", "--output-format", "stream-json"]);
    for (const flag of ["--dangerously-skip-permissions", "--mode", "--sandbox", "-p", "--print"]) assert.ok(!args.includes(flag), flag);
  }
  assert.throws(() => buildAntigravityStructuredArgs({ model: "--dangerously-skip-permissions" }));
  assert.throws(() => buildAntigravityStructuredArgs({ conversationId: "--mode=auto" }));
});

test("Antigravity opens in its stream by default, in a new worktree too, and continues in a terminal on request", unix, async t => {
  const h = await host(t);
  const opened = await h.json("/api/agent/open", { agentId: "antigravity", cwd: h.project, name: "Stream" });
  assert.equal(opened.status, 201, JSON.stringify(opened.body));
  assert.equal(opened.body.kind, "antigravity-structured", "no flag is needed for the stream");
  const stream = await h.startedWith(row => row.args.includes("stream-json"));
  assert.ok(stream, "agy started in its stream");
  for (const flag of ["--dangerously-skip-permissions", "--mode", "--sandbox"]) assert.ok(!stream.args.includes(flag), flag);
  assert.equal(stream.cwd, h.project);

  const worktree = await h.json("/api/agent/open", { agentId: "antigravity", cwd: h.project, name: "In a worktree", worktree: true });
  assert.equal(worktree.status, 201, JSON.stringify(worktree.body));
  assert.equal(worktree.body.kind, "antigravity-structured", "a worktree no longer falls back to the terminal");
  assert.match(worktree.body.worktree?.branch || "", /^pi-worktree\//);
  assert.equal(worktree.body.cwd, worktree.body.worktree.path);
  assert.ok(await h.startedWith(row => row.args.includes("stream-json") && row.cwd === worktree.body.worktree.path), "agy ran in the worktree");

  const terminal = await h.json("/api/agent/open", { agentId: "antigravity", cwd: h.project, name: "Terminal", terminal: true, conversationId: "fake-conversation-1" });
  assert.equal(terminal.status, 201, JSON.stringify(terminal.body));
  assert.equal(terminal.body.kind, "cli");
  assert.equal(terminal.body.transport, "pty");
  let tail = "";
  for (let attempt = 0; attempt < 100 && !tail.includes("AGY_ARGS:"); attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 50));
    tail = (await h.json(`/api/agent-task?taskId=${encodeURIComponent(terminal.body.id)}`)).body?.task?.outputTail || "";
  }
  assert.match(tail, /AGY_ARGS:\["--conversation","fake-conversation-1"\]/, "the same conversation, in agy's own screen");

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
