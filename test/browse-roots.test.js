"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const {
  parseBrowseRoots, isWithin, onAnyDrive, driveRootLabel, defaultBrowseRoots, applyBrowseRootDefaults,
  createDriveProbe, createFolderReader, folderReadFailure,
} = require("../server/browse-roots");

test("browse roots keep absolute paths, and \"*:\\\" means every drive only on Windows", () => {
  const expandHome = value => (value === "~" ? "C:\\Users\\jo" : value);
  assert.deepEqual(parseBrowseRoots(" C:\\Users\\jo , *:\\ ,relative,, ~ ", { platform: "win32", expandHome }),
    { roots: ["C:\\Users\\jo", "C:\\Users\\jo"], allDrives: true });
  assert.deepEqual(parseBrowseRoots("/home/jo,*:\\,/media", { platform: "linux" }), { roots: ["/home/jo", "/media"], allDrives: false });
  assert.deepEqual(parseBrowseRoots(undefined, { platform: "darwin" }), { roots: [], allDrives: false });
});

test("a root that ends with a separator contains every path below it", () => {
  assert.equal(isWithin("C:\\dev\\app", "C:\\", "\\"), true);
  assert.equal(isWithin("C:\\", "C:\\", "\\"), true);
  assert.equal(isWithin("C:\\Users\\jo2", "C:\\Users\\jo", "\\"), false);
  assert.equal(isWithin("C:\\Users\\jo\\src", "C:\\Users\\jo", "\\"), true);
  assert.equal(isWithin("/srv/app", "/", "/"), true);
  assert.equal(isWithin("/homework", "/home", "/"), false);
  assert.equal(isWithin("/home/jo", null, "/"), false);
});

test("every drive covers drive letters and network shares, never device paths", () => {
  for (const real of ["C:\\", "d:\\Projects", "\\\\nas\\share", "\\\\nas\\share\\code"]) assert.equal(onAnyDrive(real), true, real);
  for (const real of ["\\\\?\\C:\\x", "\\\\.\\PhysicalDrive0", "\\\\nas", "C:relative", "/home/jo", null]) assert.equal(onAnyDrive(real), false, String(real));
  assert.equal(driveRootLabel("c:\\"), "C:");
  assert.equal(driveRootLabel("C:\\Users\\jo"), "C:\\Users\\jo");
});

test("installed Linux and Windows services browse other drives; explicit settings win", () => {
  assert.equal(defaultBrowseRoots({ platform: "linux", home: "/home/jo", username: "jo" }), "/home/jo,/media,/mnt,/run/media/jo");
  assert.equal(defaultBrowseRoots({ platform: "linux", home: "/home/jo", username: "../x" }), "/home/jo,/media,/mnt");
  assert.equal(defaultBrowseRoots({ platform: "win32", home: "C:\\Users\\jo" }), "C:\\Users\\jo,*:\\");
  assert.equal(defaultBrowseRoots({ platform: "darwin", home: "/Users/jo" }), null, "macOS launchers set their own roots");
  assert.equal(defaultBrowseRoots({ platform: "linux" }), null);

  const fresh = {};
  applyBrowseRootDefaults(fresh, { platform: "win32", home: "C:\\Users\\jo" });
  assert.equal(fresh.STEPSEMBLE_BROWSE_ROOTS, "C:\\Users\\jo,*:\\");
  const blank = { STEPSEMBLE_BROWSE_ROOTS: "  " };
  applyBrowseRootDefaults(blank, { platform: "linux", home: "/home/jo", username: "jo" });
  assert.equal(blank.STEPSEMBLE_BROWSE_ROOTS, "/home/jo,/media,/mnt,/run/media/jo", "a blank value is unset, as the server reads it");
  for (const key of ["STEPSEMBLE_BROWSE_ROOTS", "PI_HARBOR_BROWSE_ROOTS", "PI_WEB_BROWSE_ROOTS"]) {
    const env = { [key]: "/srv/only" };
    applyBrowseRootDefaults(env, { platform: "linux", home: "/home/jo", username: "jo" });
    assert.deepEqual(env, { [key]: "/srv/only" }, key);
  }
  const mac = {};
  applyBrowseRootDefaults(mac, { platform: "darwin", home: "/Users/jo" });
  assert.deepEqual(mac, {});
});

test("a drive that does not answer is left out and is not probed again while it waits", async () => {
  const calls = new Map();
  let now = 0;
  const stat = root => {
    calls.set(root, (calls.get(root) || 0) + 1);
    if (root === "C:\\" || root === "D:\\") return Promise.resolve({ isDirectory: () => true });
    if (root === "Z:\\") return new Promise(() => {});
    return Promise.reject(Object.assign(new Error("missing"), { code: "ENOENT" }));
  };
  const drives = createDriveProbe({ stat, timeoutMs: 20, cacheMs: 1000, clock: () => now });
  assert.deepEqual(await drives(), ["C:\\", "D:\\"]);
  assert.deepEqual(await drives(), ["C:\\", "D:\\"]);
  assert.equal(calls.get("C:\\"), 1, "a recent listing is reused");
  now = 5000;
  assert.deepEqual(await drives(), ["C:\\", "D:\\"]);
  assert.equal(calls.get("C:\\"), 2);
  assert.equal(calls.get("Z:\\"), 1, "a probe still waiting is not started again");
});

test("a folder read that waits is shared, times out for the browser, and finishes later", async () => {
  let release, calls = 0;
  const readdir = folder => {
    calls++;
    if (folder === "/denied") return Promise.reject(Object.assign(new Error("Operation not permitted"), { code: "EPERM" }));
    return new Promise(resolve => { release = () => resolve(["a", "b"]); });
  };
  const reader = createFolderReader({ readdir, timeoutMs: 20 });
  await assert.rejects(reader.read("/asking"), error => error.code === "folder_waiting");
  assert.equal(reader.isPending("/asking"), true);
  const again = createFolderReader({ readdir, timeoutMs: 20 });
  assert.equal(again.isPending("/asking"), false, "each Host has its own reads");
  const second = reader.read("/asking");
  release();
  assert.deepEqual(await second, ["a", "b"], "a later request receives the answer of the same read");
  assert.equal(calls, 1, "asking again does not start another read");
  assert.equal(reader.isPending("/asking"), false);

  await assert.rejects(reader.read("/denied"), error => error.code === "EPERM");
  await assert.rejects(reader.read("/denied"), error => error.code === "EPERM");
  assert.equal(calls, 3, "a refused read is tried again on the next request");
  assert.equal(reader.isPending("/denied"), false);
});

test("a refused folder is explained by platform and cause", () => {
  const waiting = folderReadFailure(Object.assign(new Error("The folder did not answer in time"), { code: "folder_waiting" }), { platform: "darwin" });
  assert.deepEqual(waiting, { status: 503, body: { error: "The folder did not answer in time", code: "folder_waiting", platform: "darwin" } });
  const privacy = folderReadFailure(Object.assign(new Error("EPERM: operation not permitted, scandir"), { code: "EPERM" }), { platform: "darwin", runtime: "/opt/node/bin/node" });
  assert.equal(privacy.status, 403);
  assert.deepEqual(privacy.body, { error: "EPERM: operation not permitted, scandir", code: "folder_privacy", platform: "darwin", runtime: "/opt/node/bin/node" });
  const unix = folderReadFailure(Object.assign(new Error("EACCES"), { code: "EACCES" }), { platform: "darwin", runtime: "/opt/node/bin/node" });
  assert.deepEqual(unix.body, { error: "EACCES", code: "folder_permission", platform: "darwin" }, "an ordinary permission is not a privacy setting");
  assert.equal(folderReadFailure(Object.assign(new Error("EPERM"), { code: "EPERM" }), { platform: "linux" }).body.code, "folder_permission");
  assert.deepEqual(folderReadFailure(Object.assign(new Error("ENOENT: no such file"), { code: "ENOENT" })), { status: 400, body: { error: "ENOENT: no such file" } });
});
