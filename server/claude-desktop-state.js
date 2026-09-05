"use strict";

const fs = require("node:fs/promises"), path = require("node:path"), crypto = require("node:crypto");
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
function failure(code, uncertain = false) { return Object.assign(new Error(code), { code, statusCode: 409, uncertain }); }
function desktopPaths(configDir) {
  const directory = path.join(path.resolve(configDir), "claude-desktop");
  const digest = crypto.createHash("sha256").update(directory).digest("hex").slice(0, 24);
  return { directory, key: path.join(directory, "bridge-key"), state: path.join(directory, "state.json"),
    socketDirectory: path.join("/tmp", `stepsemble-desktop-${process.getuid?.() ?? "unsupported"}`),
    socket: path.join("/tmp", `stepsemble-desktop-${process.getuid?.() ?? "unsupported"}`, `${digest}.sock`) };
}
async function privateDirectory(directory, create = false) {
  if (create) await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o077)) throw failure("desktop_permissions");
}
async function privateRead(file, maxBytes = 131072) {
  const handle = await fs.open(file, require("node:fs").constants.O_RDONLY | require("node:fs").constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) || stat.size > maxBytes) throw failure("desktop_permissions");
    const buffer = Buffer.alloc(Math.min(maxBytes + 1, stat.size + 1));
    let total = 0;
    while (total < buffer.length) {
      const { bytesRead } = await handle.read(buffer, total, buffer.length - total, total);
      if (!bytesRead) break;
      total += bytesRead;
    }
    if (total > maxBytes || total > stat.size) throw failure("desktop_permissions");
    return buffer.subarray(0, total).toString("utf8");
  } finally { await handle.close(); }
}
async function privateWrite(file, value) {
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  let handle;
  try {
    handle = await fs.open(temporary, "wx", 0o600);
    await handle.writeFile(JSON.stringify(value)); await handle.sync(); await handle.close(); handle = null;
    await fs.rename(temporary, file);
    const directory = await fs.open(path.dirname(file), "r");
    try { await directory.sync(); } finally { await directory.close(); }
  } finally { await handle?.close(); await fs.unlink(temporary).catch(error => { if (error.code !== "ENOENT") throw error; }); }
}
function exact(value, keys) { return value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).sort().join("|") === [...keys].sort().join("|"); }
module.exports = { UUID, failure, desktopPaths, privateDirectory, privateRead, privateWrite, exact };
