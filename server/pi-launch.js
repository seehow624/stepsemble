"use strict";
const path = require("node:path");
const { windowsLaunch } = require("./windows-launch");

// One launch contract for native RPC, the temporary model catalog and version
// probes. Launch configuration is Host-owned, never supplied by browser input.
function piLaunch(command, args, { env = process.env, platform = process.platform, node = process.execPath } = {}) {
  const paths = platform === "win32" ? path.win32 : path.posix;
  if (platform === "win32" && !paths.isAbsolute(command)) throw new Error("Pi executable was not resolved; set PI_BIN to an absolute CLI path");
  const pathKey = Object.hasOwn(env, "PATH") ? "PATH" : Object.keys(env).find(key => key.toUpperCase() === "PATH");
  const runtimeEnv = { ...env };
  if (platform === "win32") for (const key of Object.keys(runtimeEnv)) if (key.toUpperCase() === "PATH") delete runtimeEnv[key];
  runtimeEnv.PATH = [paths.dirname(command), paths.dirname(node), pathKey ? env[pathKey] : platform === "win32" ? "" : "/usr/bin:/bin:/usr/sbin:/sbin"].filter(Boolean).join(paths.delimiter);
  const directScript = platform === "win32" && /\.(?:c?js|mjs)$/i.test(command);
  const launch = directScript
    ? { file: node, args: [command, ...args], windowsVerbatimArguments: false }
    : platform === "win32" ? windowsLaunch(command, env.SystemRoot || env.SYSTEMROOT || "C:\\Windows", args)
      : { file: command, args: [...args], windowsVerbatimArguments: false };
  return { ...launch, env: runtimeEnv, detached: platform !== "win32", windowsHide: true };
}
module.exports = { piLaunch };
