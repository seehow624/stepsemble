"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const NATIVE_FLAGS = ["STEPSEMBLE_CLAUDE_STRUCTURED", "STEPSEMBLE_CODEX_NATIVE", "STEPSEMBLE_CODEX_NATIVE_MUTATIONS"];

function executableInPath(command, rawPath, { platform = process.platform, env = process.env } = {}) {
  const extensions = platform === "win32"
    ? String(env?.PATHEXT || ".EXE;.CMD;.BAT").split(";").filter(Boolean)
    : [""];
  for (const directory of String(rawPath || "").split(path.delimiter).filter(Boolean)) {
    for (const extension of extensions) {
      const candidate = path.resolve(directory, `${command}${extension}`);
      try {
        const stat = fs.statSync(candidate);
        if (!stat.isFile()) continue;
        if (platform !== "win32") fs.accessSync(candidate, fs.constants.X_OK);
        return candidate;
      } catch {}
    }
  }
  return null;
}

// launchd and other service managers may provide a sparse PATH that can find
// the selected CLI wrapper but not the interpreter named by its shebang (for
// example `/usr/bin/env node`). Preserve every operator-supplied PATH entry
// and order; append only the current Node runtime directory when PATH cannot
// resolve an executable `node`.
function ensureNativeRuntimePath(env, { platform = process.platform, execPath = process.execPath } = {}) {
  if (!env || typeof env !== "object") return;
  const pathKey = platform === "win32"
    ? Object.keys(env).find(key => key.toLowerCase() === "path") || "Path"
    : "PATH";
  const current = env[pathKey] === undefined ? "" : String(env[pathKey] || "");
  if (executableInPath("node", current, { platform, env })) return;
  const runtime = String(execPath || "").trim();
  if (!runtime || !path.isAbsolute(runtime)) return;
  const runtimeDirectory = path.dirname(runtime);
  if (!runtimeDirectory || current.split(path.delimiter).includes(runtimeDirectory)) return;
  env[pathKey] = current ? `${current}${path.delimiter}${runtimeDirectory}` : runtimeDirectory;
}

function isInstalledRuntime(directory, home) {
  return ["stepsemble", "pi-harbor", "pi-web"].some(name => path.resolve(directory) === path.join(path.resolve(home), ".local", "share", name));
}

function parsePlist(input) {
  return JSON.parse(execFileSync("/usr/bin/plutil", ["-convert", "json", "-o", "-", "--", "-"], {
    input, encoding: "utf8", timeout: 1500, maxBuffer: 256 * 1024,
    stdio: ["pipe", "pipe", "ignore"],
  }));
}

// Installed launchers share defaults. Explicit values (including 0) win;
// native version/approval gates still decide what the adapter can actually do.
function applyNativeLaunchConfig(env, { home, platform = process.platform, uid = process.getuid?.(), decodePlist = parsePlist } = {}) {
  for (const key of NATIVE_FLAGS) if (env[key] === undefined) env[key] = "1";
  ensureNativeRuntimePath(env, { platform });
  if (platform !== "darwin" || !home || env.STEPSEMBLE_OPENCODE_SERVER_URL !== undefined || env.OPENCODE_SERVER_URL !== undefined) return;

  // Reuse the same existing launchd service that the Mini launcher supported.
  // No port scan, arbitrary plist discovery, credential copy, or disk writes.
  const file = path.join(home, "Library", "LaunchAgents", "com.jerome.opencode-web.plist");
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > 128 * 1024 || stat.uid !== uid || (stat.mode & 0o022)) return;
    const bytes = Buffer.alloc(stat.size + 1);
    const length = fs.readSync(fd, bytes, 0, bytes.length, 0);
    if (length !== stat.size) return;
    const plist = decodePlist(bytes.subarray(0, length));
    const args = plist?.ProgramArguments;
    if (!Array.isArray(args) || !args.every(x => typeof x === "string")
      || !/^opencode(?:\.exe)?$/.test(path.basename(args[0] || "")) || args[1] !== "serve") return;
    const index = args.indexOf("--port");
    const inlinePort = args.find(arg => arg.startsWith("--port="));
    const portText = index >= 0 ? args[index + 1] : inlinePort?.slice(7) ?? "4096";
    if (!/^\d+$/.test(portText || "")) return;
    const port = Number(portText);
    if (!Number.isInteger(port) || port < 1024 || port > 65535) return;
    const settings = plist.EnvironmentVariables || {};
    const password = settings.OPENCODE_SERVER_PASSWORD;
    const username = settings.OPENCODE_SERVER_USERNAME;
    if (password !== undefined && (typeof password !== "string" || password.length > 8192 || /[\r\n\0]/.test(password))) return;
    if (username !== undefined && (typeof username !== "string" || username.length > 128 || /[\r\n\0]/.test(username))) return;
    env.STEPSEMBLE_OPENCODE_SERVER_URL = `http://127.0.0.1:${port}`;
    if (env.STEPSEMBLE_OPENCODE_SERVER_USERNAME === undefined && env.OPENCODE_SERVER_USERNAME === undefined)
      env.STEPSEMBLE_OPENCODE_SERVER_USERNAME = username || "opencode";
    if (env.STEPSEMBLE_OPENCODE_SERVER_PASSWORD === undefined && env.OPENCODE_SERVER_PASSWORD === undefined && password !== undefined)
      env.STEPSEMBLE_OPENCODE_SERVER_PASSWORD = password;
  } catch {
    // Missing/untrusted/broken service configuration leaves OpenCode unconfigured.
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

module.exports = { applyNativeLaunchConfig, isInstalledRuntime, ensureNativeRuntimePath };
