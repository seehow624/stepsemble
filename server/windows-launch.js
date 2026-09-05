"use strict";
const path = require("node:path");

// Batch shims need cmd.exe on Windows. Only the resolved allow-listed filename
// goes through cmd; prompts and all subsequent input travel over stdin.
function windowsLaunch(command, systemRoot = "C:\\Windows") {
  if (!path.win32.isAbsolute(command)) throw new Error("Agent command must be absolute");
  if (!/\.(cmd|bat)$/i.test(command)) return { file: command, args: [], windowsVerbatimArguments: false };
  if (/[\x00-\x1f\x7f"%!^&|<>]/.test(command)) throw new Error("Unsupported characters in Windows agent shim path");
  if (!path.win32.isAbsolute(systemRoot) || /[\x00-\x1f\x7f"%!^&|<>]/.test(systemRoot)) throw new Error("Invalid Windows system directory");
  return {
    file: path.win32.join(systemRoot, "System32", "cmd.exe"),
    args: ["/d", "/s", "/c", `""${command}""`],
    windowsVerbatimArguments: true,
  };
}
module.exports = { windowsLaunch };
