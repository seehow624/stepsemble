"use strict";

// Where the Add project dialog may browse, and how it reads a folder.
//
// Browse roots are absolute paths. On Windows the entry "*:\" stands for every
// drive letter, and for the network share a mapped drive leads to, so a USB
// drive connected later can be chosen without restarting the Host. Other
// platforms ignore it, as older Hosts do, because it is not an absolute path.

const fs = require("node:fs");
const path = require("node:path");

const ALL_DRIVES = "*:\\";
const BROWSE_ROOT_SETTINGS = ["STEPSEMBLE_BROWSE_ROOTS", "PI_HARBOR_BROWSE_ROOTS", "PI_WEB_BROWSE_ROOTS"];
const DRIVE_LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("");
const WAITING = Symbol("waiting");

function pathFor(platform) {
  return platform === "win32" ? path.win32 : path.posix;
}

function parseBrowseRoots(raw, { platform = process.platform, expandHome = value => value } = {}) {
  const roots = [];
  let allDrives = false;
  for (const piece of String(raw || "").split(",")) {
    const value = piece.trim();
    if (!value) continue;
    if (value === ALL_DRIVES || value === "*:/") {
      if (platform === "win32") allDrives = true;
      continue;
    }
    const expanded = expandHome(value);
    if (expanded && pathFor(platform).isAbsolute(expanded)) roots.push(expanded);
  }
  return { roots, allDrives };
}

// A root that already ends with a separator ("/" or "C:\") is its own prefix.
function isWithin(child, root, separator = path.sep) {
  if (typeof child !== "string" || typeof root !== "string" || !root) return false;
  if (child === root) return true;
  return child.startsWith(root.endsWith(separator) ? root : root + separator);
}

// A canonical Windows path on a drive letter (C:\...) or a network share
// (\\server\share\...). Device paths (\\?\, \\.\) are not folders to browse.
function onAnyDrive(real) {
  if (typeof real !== "string") return false;
  return /^[A-Za-z]:\\/.test(real) || /^\\\\(?![?.]\\)[^\\]+\\[^\\]+/.test(real);
}

function driveRootLabel(root) {
  return /^[A-Za-z]:\\$/.test(root) ? root.slice(0, 2).toUpperCase() : root;
}

// Defaults for installed services. macOS launchers set their own roots
// (the home folder and /Volumes); a manually started Host keeps only HOME.
function defaultBrowseRoots({ platform = process.platform, home, username } = {}) {
  if (!home) return null;
  if (platform === "win32") return [home, ALL_DRIVES].join(",");
  if (platform === "linux") {
    const roots = [home, "/media", "/mnt"];
    if (username && /^[A-Za-z0-9._-]+$/.test(username)) roots.push("/run/media/" + username);
    return roots.join(",");
  }
  return null;
}

function applyBrowseRootDefaults(env, options = {}) {
  if (!env || typeof env !== "object") return;
  if (BROWSE_ROOT_SETTINGS.some(key => typeof env[key] === "string" && env[key].trim())) return;
  const value = defaultBrowseRoots(options);
  if (value) env.STEPSEMBLE_BROWSE_ROOTS = value;
}

function withTimeout(promise, timeoutMs, fallback) {
  let timer;
  const timeout = new Promise(resolve => { timer = setTimeout(resolve, timeoutMs, fallback); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// Drive letters that answer within a short time. A probe that is still
// waiting (a disconnected network drive) is not started again, so repeated
// listings cannot use up Node's file-system threads.
function createDriveProbe({ stat = root => fs.promises.stat(root), timeoutMs = 1500, cacheMs = 10_000, clock = Date.now } = {}) {
  const inFlight = new Map();
  let cached = null;
  function probe(letter) {
    if (inFlight.has(letter)) return Promise.resolve(null);
    const root = letter + ":\\";
    const pending = Promise.resolve().then(() => stat(root)).then(result => (result?.isDirectory?.() ? root : null), () => null);
    inFlight.set(letter, pending);
    pending.then(() => inFlight.delete(letter));
    return withTimeout(pending, timeoutMs, null);
  }
  return async function drives() {
    if (cached && clock() - cached.at < cacheMs) return cached.roots;
    const roots = (await Promise.all(DRIVE_LETTERS.map(probe))).filter(Boolean);
    cached = { at: clock(), roots };
    return roots;
  };
}

function folderWaitingError() {
  const error = new Error("The folder did not answer in time");
  error.code = "folder_waiting";
  return error;
}

// Reads a folder without blocking the Host. macOS holds the read while it asks
// whether the Host may open a protected folder, and a disconnected network
// drive can hold it for a long time. A read still waiting is shared by later
// requests for the same folder, so asking again does not start another one.
function createFolderReader({ readdir = folder => fs.promises.readdir(folder, { withFileTypes: true }), timeoutMs = 8000 } = {}) {
  const pending = new Map();
  async function read(folder) {
    let entry = pending.get(folder);
    if (!entry) {
      entry = Promise.resolve().then(() => readdir(folder));
      pending.set(folder, entry);
      const clear = () => { if (pending.get(folder) === entry) pending.delete(folder); };
      entry.then(clear, clear);
    }
    const result = await withTimeout(entry, timeoutMs, WAITING);
    if (result === WAITING) throw folderWaitingError();
    return result;
  }
  return { read, isPending: folder => pending.has(folder) };
}

// What the browser is told when a folder cannot be read. On macOS, EPERM is
// the privacy protection (Files and Folders, Full Disk Access); EACCES is an
// ordinary permission. The Node.js path lets the person allow that program.
function folderReadFailure(error, { platform = process.platform, runtime = process.execPath } = {}) {
  if (error?.code === "folder_waiting") {
    return { status: 503, body: { error: error.message, code: "folder_waiting", platform } };
  }
  if (error?.code === "EPERM" && platform === "darwin") {
    return { status: 403, body: { error: error.message, code: "folder_privacy", platform, runtime } };
  }
  if (error?.code === "EPERM" || error?.code === "EACCES") {
    return { status: 403, body: { error: error.message, code: "folder_permission", platform } };
  }
  return { status: 400, body: { error: error?.message || "Could not read the folder" } };
}

module.exports = {
  ALL_DRIVES,
  BROWSE_ROOT_SETTINGS,
  parseBrowseRoots,
  isWithin,
  onAnyDrive,
  driveRootLabel,
  defaultBrowseRoots,
  applyBrowseRootDefaults,
  createDriveProbe,
  createFolderReader,
  folderReadFailure,
};
