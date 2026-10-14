"use strict";

// A read-only, project-scoped browser. Never walk the whole disk or read an
// unbounded file just to show a preview (including pipes and device files).
const fs = require("node:fs");
const path = require("node:path");
const { TextDecoder } = require("node:util");
const MAX_ENTRIES = 2000;
const MAX_PREVIEW_BYTES = 256 * 1024;
function failure(code, statusCode = 400) {
  return Object.assign(new Error(code), { code, statusCode });
}
function inside(root, target) {
  const relative = path.relative(root, target);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}
function createProjectFilesService({ validateProject = value => value } = {}) {
  async function resolve(cwd, relative = "") {
    const approved = await validateProject(cwd);
    if (!approved || !path.isAbsolute(approved)) throw failure("projectUnavailable", 403);
    if (typeof relative !== "string" || relative.includes("\0") || path.isAbsolute(relative)
      || /^[a-z]:/i.test(relative) || relative.includes("\\") || relative.split("/").includes("..")) throw failure("outsideProject", 403);
    const root = await fs.promises.realpath(approved);
    const target = path.resolve(root, relative);
    if (!inside(root, target)) throw failure("outsideProject", 403);
    const real = await fs.promises.realpath(target);
    if (!inside(root, real)) throw failure("outsideProject", 403);
    return { root, real, relative: path.relative(root, target).split(path.sep).join("/") };
  }
  async function list(cwd, relative = "") {
    const location = await resolve(cwd, relative);
    const entries = [];
    let truncated = false;
    const directory = await fs.promises.opendir(location.real);
    for await (const entry of directory) {
      if (entries.length === MAX_ENTRIES) { truncated = true; break; }
      let kind = entry.isDirectory() ? "directory" : entry.isFile() ? "file" : "unsupported";
      let blocked = kind === "unsupported";
      const relativePath = location.relative ? `${location.relative}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) {
        try {
          const target = await resolve(cwd, relativePath);
          const stat = await fs.promises.stat(target.real);
          kind = stat.isDirectory() ? "directory" : stat.isFile() ? "file" : "unsupported";
          blocked = kind === "unsupported";
        } catch { kind = "link"; blocked = true; }
      }
      entries.push({ name: entry.name, path: relativePath, kind, hidden: entry.name.startsWith("."), link: entry.isSymbolicLink(), blocked });
    }
    // A directory renamed/replaced during enumeration must not become a way
    // to return a listing from another project.
    if ((await resolve(cwd, relative)).real !== location.real) throw failure("fileChanged", 409);
    entries.sort((a, b) => Number(b.kind === "directory") - Number(a.kind === "directory") || a.name.localeCompare(b.name, "en", { numeric: true }));
    return { root: location.root, path: location.relative, entries, truncated };
  }
  async function read(cwd, relative) {
    const location = await resolve(cwd, relative);
    const before = await fs.promises.lstat(location.real);
    if (!before.isFile()) throw failure("notTextFile", 415);
    const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0);
    const handle = await fs.promises.open(location.real, flags);
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) throw failure("notTextFile", 415);
      if (stat.ino !== before.ino || stat.dev !== before.dev || (await resolve(cwd, relative)).real !== location.real) throw failure("fileChanged", 409);
      const buffer = Buffer.alloc(Math.min(stat.size, MAX_PREVIEW_BYTES));
      let used = 0;
      while (used < buffer.length) {
        const { bytesRead } = await handle.read(buffer, used, buffer.length - used, used);
        if (!bytesRead) break;
        used += bytesRead;
      }
      const sample = buffer.subarray(0, used);
      const after = await handle.stat();
      if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs) throw failure("fileChanged", 409);
      const truncated = stat.size > used;
      let content;
      try {
        if (sample.includes(0)) throw new Error("binary");
        content = new TextDecoder("utf-8", { fatal: true }).decode(sample, { stream: truncated });
      } catch { return { path: location.relative, size: stat.size, binary: true }; }
      return { path: location.relative, size: stat.size, content, truncated };
    } finally { await handle.close(); }
  }
  return { list, read };
}
module.exports = { createProjectFilesService, MAX_ENTRIES, MAX_PREVIEW_BYTES };
