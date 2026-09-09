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

async function authenticatedBrowseHost(t, home, browseRoots, cleanupRoot = null) {
  const port = await freePort();
  const child = spawn(process.execPath, [path.join(root, "server.js")], {
    env: isolatedEnvironment({
      HOME: home, PI_HOME: home, STEPSEMBLE_HOST: "127.0.0.1", STEPSEMBLE_PORT: String(port),
      STEPSEMBLE_BROWSE_ROOTS: browseRoots.join(","), PI_BIN: "/path/that/does/not/exist",
    }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(async () => {
    await stopServer(child);
    if (cleanupRoot) await fs.promises.rm(cleanupRoot, { recursive: true, force: true });
  });
  await waitForServer(child);
  const base = `http://127.0.0.1:${port}`;
  const token = (await fs.promises.readFile(path.join(home, ".config", "stepsemble", "token"), "utf8")).trim();
  const login = await fetch(`${base}/api/login`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token }),
  });
  assert.equal(login.status, 204);
  const cookie = (login.headers.get("set-cookie") || "").split(";", 1)[0];
  return {
    browse: query => fetch(`${base}/api/browse${query}`, { headers: { cookie } }),
    get: pathname => fetch(`${base}${pathname}`, { headers: { cookie } }),
    post: (pathname, body) => fetch(`${base}${pathname}`, {
      method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify(body),
    }),
  };
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

test("blank browse starts at the first allowed root when HOME is outside narrow roots", async (t) => {
  const temp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "stepsemble-narrow-browse-"));
  const home = path.join(temp, "home"), first = path.join(temp, "allowed-a"), second = path.join(temp, "allowed-b");
  const missing = path.join(temp, "missing"), sibling = path.join(temp, "sibling");
  await Promise.all([home, first, second, sibling].map(directory => fs.promises.mkdir(directory, { recursive: true })));
  await fs.promises.mkdir(path.join(second, "project"));
  const host = await authenticatedBrowseHost(t, home, [missing, second, first], temp);
  const realFirst = await fs.promises.realpath(first), realSecond = await fs.promises.realpath(second);
  const realSibling = await fs.promises.realpath(sibling);

  for (const query of ["", "?path=%20%20"]) {
    const response = await host.browse(query);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.path, realSecond, "configured order chooses the first valid explicit root");
    assert.equal(body.selectable, true);
    assert.ok(body.entries.some(entry => entry.name === "project"));
  }
  const explicitHome = await host.browse("?path=~");
  assert.equal(explicitHome.status, 403, "explicit HOME remains outside the authority boundary");
  const outside = await host.browse(`?path=${encodeURIComponent(sibling)}`);
  assert.equal(outside.status, 403);
  const projectChanges = await host.get(`/api/project-changes?cwd=${encodeURIComponent(sibling)}`);
  assert.equal(projectChanges.status, 400, "non-browse consumers keep the same root fence");

  const picker = await host.browse(`?path=${encodeURIComponent(path.parse(realSecond).root)}`);
  assert.equal(picker.status, 200);
  const pickerBody = await picker.json();
  assert.equal(pickerBody.selectable, false, "the filesystem bridge is navigation-only");
  assert.deepEqual(pickerBody.entries.map(entry => entry.path).sort(), [realFirst, realSecond].sort());
  assert.equal(pickerBody.entries.some(entry => entry.path === realSibling), false);

  for (const cwd of [path.parse(realSecond).root, sibling, ""]) {
    const opened = await host.post("/api/open", { cwd, name: "Must not spawn" });
    assert.equal(opened.status, 403, `new Pi cwd must remain inside browse roots: ${cwd || "default HOME"}`);
    assert.match((await opened.json()).error, /outside browse roots|unavailable/);
  }
  const rpcs = await host.get("/api/rpcs");
  assert.equal(rpcs.status, 200);
  assert.deepEqual((await rpcs.json()).rpcs, [], "rejected cwd never reaches Pi spawn");
});

test("blank browse fails clearly when no configured root exists", async (t) => {
  const temp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "stepsemble-missing-browse-"));
  const home = path.join(temp, "home");
  await fs.promises.mkdir(home);
  const host = await authenticatedBrowseHost(t, home, [path.join(temp, "missing")], temp);
  const response = await host.browse("");
  assert.equal(response.status, 403);
  assert.match((await response.json()).error, /no allowed browse root is available/);
});
