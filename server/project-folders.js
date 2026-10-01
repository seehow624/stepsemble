"use strict";

// Creates a folder for a new project, inside a folder the person may already
// browse. One level at a time, never over an existing entry, and only with a
// plain name, so the Add project dialog cannot write anywhere else.

const fs = require("node:fs");
const path = require("node:path");

const MAX_NAME_BYTES = 255;

function folderName(value) {
  if (typeof value !== "string") return null;
  const name = value.normalize("NFC").trim();
  if (!name || name === "." || name === ".." || name.startsWith(".")) return null;
  if (/[\/\\:\u0000-\u001f\u007f]/.test(name)) return null;
  if (Buffer.byteLength(name) > MAX_NAME_BYTES) return null;
  return name;
}

/**
 * @param parent absolute path of the folder being browsed
 * @param name the new folder's name
 * @param isAllowed (realPath) => boolean, the Host's browse rule
 */
function createProjectFolder({ parent, name, isAllowed }) {
  if (typeof parent !== "string" || !path.isAbsolute(parent)) return { kind: "reject", status: 400, code: "parent_invalid" };
  const clean = folderName(name);
  if (!clean) return { kind: "reject", status: 400, code: "name_invalid" };
  let realParent;
  try { realParent = fs.realpathSync.native(parent); } catch { return { kind: "reject", status: 404, code: "parent_missing" }; }
  try { if (!fs.statSync(realParent).isDirectory()) return { kind: "reject", status: 400, code: "parent_invalid" }; } catch { return { kind: "reject", status: 404, code: "parent_missing" }; }
  if (!isAllowed(realParent)) return { kind: "reject", status: 403, code: "outside_browse_roots" };
  const target = path.join(realParent, clean);
  if (path.dirname(target) !== realParent) return { kind: "reject", status: 400, code: "name_invalid" };
  try { fs.mkdirSync(target, { mode: 0o755 }); }
  catch (error) {
    if (error?.code === "EEXIST") return { kind: "reject", status: 409, code: "exists" };
    // The reason tells the dialog whether the system refused (EPERM: macOS
    // privacy protection, Windows Controlled folder access) or the folder is
    // simply not writable.
    if (error?.code === "EACCES" || error?.code === "EPERM" || error?.code === "EROFS") return { kind: "reject", status: 403, code: "not_writable", reason: error.code };
    return { kind: "reject", status: 500, code: "create_failed" };
  }
  let real = target;
  try { real = fs.realpathSync.native(target); } catch {}
  return { kind: "created", path: real };
}

module.exports = { createProjectFolder, folderName };
