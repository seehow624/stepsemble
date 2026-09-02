const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const { isolatedEnvironment } = require("../test-support/env");

const root = path.resolve(__dirname, "..");

async function freePort() {
  const socket = net.createServer();
  socket.listen(0, "127.0.0.1");
  await once(socket, "listening");
  const { port } = socket.address();
  await new Promise((resolve, reject) => socket.close((error) => error ? reject(error) : resolve()));
  return port;
}

function health(port) {
  return new Promise((resolve) => {
    const req = http.request({ hostname: "127.0.0.1", port, path: "/api/health", method: "GET", headers: { Host: `127.0.0.1:${port}` } }, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode));
    });
    req.on("error", () => resolve(0));
    req.end();
  });
}

async function waitFor(predicate, timeoutMs, stepMs = 100) {
  const deadline = Date.now() + timeoutMs;
  // Always start with a real timer: a synchronous predicate would otherwise
  // resolve on the microtask queue and let the test runner see an empty event
  // loop before the first wait is scheduled.
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, stepMs));
    if (await predicate()) return true;
  }
  return false;
}

function processAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

// A wrapper script that throws before its own cleanup used to leave this
// server running forever: it held the port open and kept the caller's event
// loop alive, so parent and child waited for each other indefinitely.
test("an orphaned server exits instead of waiting for a parent that is gone", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "pi-harbor-orphan-"));
  const port = await freePort();
  const env = isolatedEnvironment({
    HOME: home,
    PI_HOME: home,
    PI_BIN: process.execPath,
    PI_HARBOR_PORT: String(port),
    PI_HARBOR_HOST: "127.0.0.1",
    PI_HARBOR_SECURE_COOKIE: "0",
  });

  // An intermediate parent that starts the server and then exits abruptly,
  // exactly like a test harness that throws after spawning it.
  const parent = spawn(process.execPath, [
    path.join(root, "test-support", "orphan-launcher.js"),
    process.execPath,
    path.join(root, "server.js"),
    JSON.stringify(env),
    root,
  ], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  parent.stdout.on("data", (chunk) => { out += chunk; });
  parent.stderr.on("data", (chunk) => { out += chunk; });

  // The launcher exits as soon as the server is listening, so waiting on its
  // exit is both the readiness signal and the moment the server is orphaned.
  await once(parent, "exit");
  const match = out.match(/SERVER_PID=(\d+)/);
  assert.ok(match, `launcher never reported a server pid: ${out}`);
  const serverPid = Number(match[1]);

  t.after(async () => {
    if (processAlive(serverPid)) {
      try { process.kill(serverPid, "SIGKILL"); } catch {}
    }
    fs.rmSync(home, { recursive: true, force: true });
  });

  // The orphan check polls every 2s; allow a few cycles on a loaded machine.
  const exited = await waitFor(() => !processAlive(serverPid), 20000, 250);
  assert.ok(exited, "orphaned server should exit after its parent disappears");
  assert.equal(await health(port), 0, "the port must be released");
});

// launchd starts the service as a child of PID 1, and the SSH launcher keeps a
// long-lived parent. Neither may be mistaken for an orphan.
test("a server with a live parent keeps running", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "pi-harbor-parented-"));
  const port = await freePort();
  const env = isolatedEnvironment({
    HOME: home,
    PI_HOME: home,
    PI_BIN: process.execPath,
    PI_HARBOR_PORT: String(port),
    PI_HARBOR_HOST: "127.0.0.1",
    PI_HARBOR_SECURE_COOKIE: "0",
  });
  let logs = "";
  const child = spawn(process.execPath, [path.join(root, "server.js")], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", (chunk) => { logs += chunk; });
  child.stderr.on("data", (chunk) => { logs += chunk; });
  t.after(async () => {
    if (child.exitCode === null) {
      child.kill("SIGTERM");
      await Promise.race([once(child, "exit"), new Promise((resolve) => setTimeout(resolve, 2000))]);
      if (child.exitCode === null) child.kill("SIGKILL");
    }
    fs.rmSync(home, { recursive: true, force: true });
  });

  const ready = await waitFor(async () => (await health(port)) === 200, 15000);
  assert.ok(ready, `server did not become ready: ${logs}`);
  // Outlive several orphan-check cycles while this test process stays alive.
  await new Promise((resolve) => setTimeout(resolve, 7000));
  assert.equal(child.exitCode, null, "a supervised server must not exit on its own");
  assert.equal(await health(port), 200);
  assert.doesNotMatch(logs, /parent process exited/);
});
