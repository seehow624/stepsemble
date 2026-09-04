const test = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const net = require("node:net");
const { isolatedEnvironment } = require("../test-support/env");

const root = path.resolve(__dirname, "..");

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function waitForServer(child) {
  return new Promise((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`server did not start: ${output}`));
    }, 8_000);
    const cleanup = () => {
      clearTimeout(timer);
      child.stdout?.off("data", onData);
      child.stderr?.off("data", onError);
      child.off("exit", onExit);
    };
    const onData = (chunk) => {
      output += chunk.toString();
      if (output.includes(" listening on ")) {
        cleanup();
        resolve();
      }
    };
    const onError = (chunk) => { output += chunk.toString(); };
    const onExit = (code, signal) => {
      cleanup();
      reject(new Error(`server exited before start (${code ?? signal}): ${output}`));
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onError);
    child.on("exit", onExit);
  });
}

async function stopServer(child) {
  if (!child || child.exitCode !== null) return;
  child.kill("SIGTERM");
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, 4_000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
  if (child.exitCode === null) child.kill("SIGKILL");
}

test("browse defaults blank paths to APP_HOME and rejects relative or outside paths", async (t) => {
  const temp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "stepsemble-browse-"));
  const home = path.join(temp, "home");
  const outside = path.join(temp, "outside");
  await fs.promises.mkdir(path.join(home, "Projects"), { recursive: true });
  await fs.promises.mkdir(outside, { recursive: true });
  const port = await freePort();
  const env = isolatedEnvironment({
    HOME: home,
    PI_HOME: home,
    STEPSEMBLE_HOST: "127.0.0.1",
    STEPSEMBLE_PORT: String(port),
    STEPSEMBLE_BROWSE_ROOTS: home,
    PI_BIN: "/path/that/does/not/exist",
  });
  const child = spawn(process.execPath, [path.join(root, "server.js")], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(async () => {
    await stopServer(child);
    await fs.promises.rm(temp, { recursive: true, force: true });
  });
  await waitForServer(child);
  const base = `http://127.0.0.1:${port}`;
  const tokenFile = path.join(home, ".config", "stepsemble", "token");
  const token = (await fs.promises.readFile(tokenFile, "utf8")).trim();
  assert.match(token, /^[a-f0-9]{64}$/);
  const tokenStat = await fs.promises.stat(tokenFile);
  if (process.platform !== "win32") assert.equal(tokenStat.mode & 0o077, 0);

  const publicMachine = await fetch(`${base}/api/machine`);
  const publicMachineBody = await publicMachine.json();
  assert.equal(publicMachineBody.authed, false);
  assert.equal(Object.prototype.hasOwnProperty.call(publicMachineBody, "home"), false);
  assert.equal(JSON.stringify(publicMachineBody).includes(token), false);

  const login = await fetch(`${base}/api/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token }),
  });
  assert.equal(login.status, 204);
  const cookie = (login.headers.get("set-cookie") || "").split(";", 1)[0];
  assert.match(cookie, /^stepsemble=/);

  const browse = (query) => fetch(`${base}/api/browse${query}`, { headers: { cookie } });
  const noPath = await browse("");
  assert.equal(noPath.status, 200);
  const noPathBody = await noPath.json();
  assert.equal(noPathBody.path, await fs.promises.realpath(home));
  assert.ok(noPathBody.entries.some((entry) => entry.name === "Projects"));

  const blankPath = await browse("?path=%20%20");
  assert.equal(blankPath.status, 200);
  assert.equal((await blankPath.json()).path, noPathBody.path);

  const tildePath = await browse("?path=~");
  assert.equal(tildePath.status, 200);
  assert.equal((await tildePath.json()).path, noPathBody.path);

  const relative = await browse("?path=.");
  assert.equal(relative.status, 400);
  assert.match((await relative.json()).error, /absolute path required/);

  const traversal = await browse("?path=..%2Foutside");
  assert.equal(traversal.status, 400);
  assert.match((await traversal.json()).error, /absolute path required/);

  const invalidHomeMarker = await browse("?path=~other");
  assert.equal(invalidHomeMarker.status, 400);
  assert.match((await invalidHomeMarker.json()).error, /absolute path required/);

  const outsidePath = await browse(`?path=${encodeURIComponent(outside)}`);
  assert.equal(outsidePath.status, 403);
  assert.match((await outsidePath.json()).error, /outside browse roots/);
});
