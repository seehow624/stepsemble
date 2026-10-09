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
    base,
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


test("a folder the Host may not read or write says why, and the Host keeps answering", { skip: process.platform === "win32" || process.getuid?.() === 0 }, async (t) => {
  const temp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "stepsemble-refused-browse-"));
  const home = path.join(temp, "home"), locked = path.join(home, "Locked"), readOnly = path.join(home, "ReadOnly");
  await fs.promises.mkdir(locked, { recursive: true });
  await fs.promises.mkdir(readOnly);
  const host = await authenticatedBrowseHost(t, home, [home], temp);
  await fs.promises.chmod(locked, 0o000);
  await fs.promises.chmod(readOnly, 0o555);
  try {
    const refused = await host.browse(`?path=${encodeURIComponent(locked)}`);
    assert.equal(refused.status, 403);
    const body = await refused.json();
    assert.equal(body.code, "folder_permission", "an ordinary permission, not a privacy setting");
    assert.equal(body.platform, process.platform);
    assert.equal(Object.prototype.hasOwnProperty.call(body, "runtime"), false);

    const listing = await host.browse("");
    assert.equal(listing.status, 200, "the Host still answers after a refused folder");
    const listed = await listing.json();
    assert.equal(listed.platform, process.platform);
    assert.ok(listed.entries.some(entry => entry.name === "Locked"));

    const made = await host.post("/api/browse/folder", { parent: await fs.promises.realpath(readOnly), name: "new" });
    assert.equal(made.status, 403);
    const madeBody = await made.json();
    assert.equal(madeBody.error, "not_writable");
    assert.equal(madeBody.code, "not_writable");
    assert.equal(madeBody.reason, "EACCES");
    assert.equal(madeBody.platform, process.platform);
    assert.equal(madeBody.runtime, process.execPath);
  } finally {
    await fs.promises.chmod(locked, 0o755).catch(() => {});
    await fs.promises.chmod(readOnly, 0o755).catch(() => {});
  }
});

test("an allowed filesystem root lists its own folders", { skip: process.platform === "win32" }, async (t) => {
  const temp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "stepsemble-root-browse-"));
  const home = path.join(temp, "home");
  await fs.promises.mkdir(home);
  const host = await authenticatedBrowseHost(t, home, [home, "/"], temp);
  const response = await host.browse("?path=%2F");
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.selectable, true);
  assert.equal(body.parent, "/");
  const top = (await fs.promises.realpath(temp)).split(path.sep).filter(Boolean)[0];
  assert.ok(body.entries.some(entry => entry.name === top), "the real top-level folders, not the list of roots");
});

test("on Windows every drive can be browsed, with the drives listed above them", { skip: process.platform !== "win32" }, async (t) => {
  const temp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "stepsemble-drives-"));
  const home = path.join(temp, "home"), outside = path.join(temp, "outside");
  await fs.promises.mkdir(home);
  await fs.promises.mkdir(path.join(outside, "project"), { recursive: true });
  const host = await authenticatedBrowseHost(t, home, [home, "*:\\"], temp);
  const realHome = fs.realpathSync.native(home), realOutside = fs.realpathSync.native(outside);
  const drive = path.parse(realOutside).root;

  const opened = await host.browse(`?path=${encodeURIComponent(outside)}`);
  assert.equal(opened.status, 200);
  const openedBody = await opened.json();
  assert.equal(openedBody.path, realOutside);
  assert.equal(openedBody.selectable, true, "a folder outside HOME can be chosen");
  assert.equal(openedBody.platform, "win32");
  assert.ok(openedBody.entries.some(entry => entry.name === "project"));

  const root = await host.browse(`?path=${encodeURIComponent(drive)}`);
  assert.equal(root.status, 200);
  const rootBody = await root.json();
  assert.equal(rootBody.selectable, true, "the drive itself can be chosen");
  assert.equal(rootBody.parent, "/", "a drive's parent is the list of places");
  assert.ok(rootBody.entries.length > 0, "the drive lists its own folders");

  for (const query of ["?path=%2F", "?path=%5C"]) {
    const places = await host.browse(query);
    assert.equal(places.status, 200);
    const placesBody = await places.json();
    assert.equal(placesBody.path, "/");
    assert.equal(placesBody.selectable, false);
    assert.ok(placesBody.entries.some(entry => entry.path.toUpperCase() === drive.toUpperCase() && entry.name === drive.slice(0, 2).toUpperCase()), JSON.stringify(placesBody.entries));
    assert.ok(placesBody.entries.some(entry => entry.path === realHome), JSON.stringify(placesBody.entries));
  }

  const created = await host.post("/api/browse/folder", { parent: realOutside, name: "made-on-a-drive" });
  assert.equal(created.status, 201);
  const project = await host.post("/api/workspace/project", { cwd: realOutside });
  assert.ok(project.status < 400, `a folder on a drive can be added: ${project.status}`);
});

test("a file a reply names on the Host opens only inside the browse roots and never as a page", async (t) => {
  const temp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "stepsemble-host-files-"));
  const home = path.join(temp, "home");
  const outside = path.join(temp, "outside");
  const project = path.join(home, "Projects");
  await fs.promises.mkdir(project, { recursive: true });
  await fs.promises.mkdir(outside, { recursive: true });
  await fs.promises.writeFile(path.join(project, "notes.html"), "<script>alert(1)</script>\n第二行\n");
  await fs.promises.writeFile(path.join(project, "shot.png"),
    Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)]));
  await fs.promises.writeFile(path.join(project, "data.bin"), Buffer.from([0, 1, 2, 3, 255]));
  await fs.promises.writeFile(path.join(outside, "secret.txt"), "secret");
  const host = await authenticatedBrowseHost(t, home, [home], temp);
  const open = async value => host.post("/api/host-files/open", { path: value });

  // Text, with the line a reply points at, is plain text that cannot run.
  let response = await open(path.join(project, "notes.html") + ":2");
  assert.equal(response.status, 200);
  const notes = await response.json();
  assert.deepEqual([notes.kind, notes.name, notes.path], ["text", "notes.html", await fs.promises.realpath(path.join(project, "notes.html"))]);
  response = await host.get(notes.url);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "text/plain; charset=utf-8");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.match(response.headers.get("content-security-policy"), /^sandbox/);
  assert.equal(await response.text(), "<script>alert(1)</script>\n第二行\n");

  // A picture uses the image previews; other files download.
  response = await open("~/Projects/shot.png");
  const picture = await response.json();
  assert.equal(picture.kind, "image");
  assert.match(picture.url, /^\/api\/codex\/image\?token=/);
  response = await host.get(picture.url);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "image/png");
  response = await open(path.join(project, "data.bin"));
  const binary = await response.json();
  assert.equal(binary.kind, "file");
  response = await host.get(binary.url);
  assert.equal(response.headers.get("content-type"), "application/octet-stream");
  assert.match(response.headers.get("content-disposition"), /^attachment;/);
  assert.deepEqual([...new Uint8Array(await response.arrayBuffer())], [0, 1, 2, 3, 255]);
  assert.equal((await (await open(project)).json()).kind, "folder");

  // Outside the roots, missing, relative or empty: nothing is described.
  for (const value of [path.join(outside, "secret.txt"), path.join(project, "..", "..", "outside", "secret.txt"),
    path.join(project, "missing.txt"), "Projects/shot.png", ""]) {
    assert.equal((await open(value)).status, 404, value);
  }
  if (process.platform !== "win32") {
    await fs.promises.symlink(path.join(outside, "secret.txt"), path.join(project, "escape.txt"));
    assert.equal((await open(path.join(project, "escape.txt"))).status, 404);
  }
  // Without signing in, neither the description nor the file is available.
  const anonymous = await fetch(`${host.base}/api/host-files/open`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: path.join(project, "notes.html") }),
  });
  assert.equal(anonymous.status, 401);
  assert.equal((await fetch(host.base + notes.url)).status, 401);
});
