"use strict";
const path = require("node:path");

// Batch shims need cmd.exe on Windows. Only the resolved allow-listed filename
// goes through cmd; prompts and all subsequent input travel over stdin.
function windowsLaunch(command, systemRoot = "C:\\Windows", args = []) {
  if (!path.win32.isAbsolute(command)) throw new Error("Agent command must be absolute");
  if (!Array.isArray(args) || args.length > 64 || args.some(arg => typeof arg !== "string" || arg.includes("\0"))) throw new Error("Invalid Windows agent arguments");
  if (!/\.(cmd|bat)$/i.test(command)) return { file: command, args: [...args], windowsVerbatimArguments: false };
  if (/[\x00-\x1f\x7f"%!^&|<>]/.test(command)) throw new Error("Unsupported characters in Windows agent shim path");
  if (!path.win32.isAbsolute(systemRoot) || /[\x00-\x1f\x7f"%!^&|<>]/.test(systemRoot)) throw new Error("Invalid Windows system directory");
  // Do not let cmd expand argument contents, even when quoted. A direct .js
  // PI_BIN can be used when a session path contains these shell characters.
  if (args.some(arg => /[\x00-\x1f\x7f"%!^&|<>]/.test(arg))) throw new Error("Unsupported characters in Windows agent shim arguments; use a direct CLI .js path");
  const quote = value => `"${value.replace(/\\+$/, suffix => suffix + suffix)}"`;
  const line = `"${[quote(command), ...args.map(quote)].join(" ")}"`;
  if (Buffer.byteLength(line) > 8000) throw new Error("Windows agent shim command is too long");
  return {
    file: path.win32.join(systemRoot, "System32", "cmd.exe"),
    args: ["/d", "/s", "/c", line],
    windowsVerbatimArguments: true,
  };
}
module.exports = { windowsLaunch };
