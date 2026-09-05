#!/usr/bin/env node
// Explicit opt-in installation. Does not restart/modify the Web host, invoke
// login/logout/model prompts, or alter provider credential storage.
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import state from "../server/claude-desktop-state.js";
import desktop from "../server/claude-desktop-client.js";
import connectors from "../server/agent-connectors.js";

const run = promisify(execFile), label = "com.stepsemble.claude-desktop";
const xml = value => String(value).replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[char]);
export function launchAgentPlist({ node, entry, config, home, searchPath, serviceLabel = label }) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${xml(serviceLabel)}</string>
<key>ProgramArguments</key><array>${[node, entry, config].map(value => `<string>${xml(value)}</string>`).join("")}</array>
<key>WorkingDirectory</key><string>${xml(path.dirname(entry))}</string>
<key>EnvironmentVariables</key><dict><key>HOME</key><string>${xml(home)}</string><key>PATH</key><string>${xml(searchPath)}</string></dict>
<key>LimitLoadToSessionType</key><string>Aqua</string>
<key>ProcessType</key><string>Interactive</string>
<key>RunAtLoad</key><true/>
<key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
<key>ThrottleInterval</key><integer>30</integer>
<key>StandardOutPath</key><string>/dev/null</string>
<key>StandardErrorPath</key><string>/dev/null</string>
</dict></plist>\n`;
}
export async function installDesktop(argv = process.argv.slice(2)) {
  if (process.platform !== "darwin" || !process.getuid?.()) throw new Error("Run as the desktop user on macOS, never root.");
  const mode = argv[0], roots = [];
  if (!["--install", "--check"].includes(mode)) throw new Error("Usage: node scripts/install-claude-desktop.mjs --install [--root /absolute/project-root] | --check");
  for (let i = 1; i < argv.length; i += 2) {
    if (argv[i] !== "--root" || !argv[i + 1] || !path.isAbsolute(argv[i + 1]) || roots.length >= 15) throw new Error("Only explicit absolute --root paths are accepted.");
    roots.push(await fs.realpath(argv[i + 1]));
  }
  const home = os.homedir(), configDir = path.join(home, ".config", "stepsemble"), paths = state.desktopPaths(configDir);
  const configFile = path.join(paths.directory, "config.json"), service = `gui/${process.getuid()}/${label}`;
  if (mode === "--check") {
    const client = desktop.createDesktopClaudeClient({ configDir });
    try { const status = await client.status(); console.log(JSON.stringify({ context: status.context || "unavailable", credential: status.credential.state, liveVerified: false, canStart: status.canStart }));
      if (!status.context) throw new Error("Desktop helper is unavailable.");
    } finally { client.close(); } return;
  }
  await run("/bin/launchctl", ["print", `gui/${process.getuid()}`], { timeout: 3000, maxBuffer: 4 * 1024 * 1024 });
  const plistFile = path.join(home, "Library", "LaunchAgents", `${label}.plist`);
  for (const file of [configFile, plistFile]) {
    if (await fs.lstat(file).then(() => true, error => { if (error.code === "ENOENT") return false; throw error; })) throw new Error("A desktop helper installation already exists; use --check. Existing files will not be overwritten.");
  }
  const command = connectors.resolveCommand(connectors.CONNECTOR_DEFINITIONS.find(item => item.id === "claude-code"));
  if (!command) throw new Error("Install the official Claude Code CLI first.");
  await state.privateDirectory(configDir);
  await state.privateDirectory(paths.directory, true);
  await state.privateDirectory(paths.socketDirectory, true);
  const runtimeRoot = path.join(home, ".local", "share", "stepsemble-claude-desktop");
  await state.privateDirectory(runtimeRoot, true);
  const release = await fs.mkdtemp(path.join(runtimeRoot, "candidate-"));
  const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  // Runtime copy stays on the local disk. No npm install, SMB cache or mutable
  // Web-install path dependency; Web rollback cannot erase a running helper.
  await fs.cp(path.join(source, "server"), path.join(release, "server"), { recursive: true });
  await fs.mkdir(path.join(release, "public", "modules"), { recursive: true, mode: 0o700 });
  await fs.copyFile(path.join(source, "public", "modules", "claude-auth.js"), path.join(release, "public", "modules", "claude-auth.js"));
  const config = { version: 1, home, configDir, claudeCommand: command, roots: [...new Set([home, ...roots])] };
  // A separate random local IPC key; this is never a provider/OAuth token.
  try { await fs.writeFile(paths.key, crypto.randomBytes(32).toString("hex"), { mode: 0o600, flag: "wx" }); }
  catch (error) { if (error.code !== "EEXIST") throw error; await state.privateRead(paths.key, 128); }
  await fs.writeFile(configFile, JSON.stringify(config), { mode: 0o600, flag: "wx" });
  const entry = path.join(release, "server", "claude-desktop-entry.js");
  const searchPath = [...new Set([path.dirname(process.execPath), path.dirname(command), ...connectorsPath(), "/usr/bin", "/bin", "/usr/sbin", "/sbin"])].join(":");
  await fs.mkdir(path.dirname(plistFile), { recursive: true });
  await fs.writeFile(plistFile, launchAgentPlist({ node: process.execPath, entry, config: configFile, home, searchPath }), { mode: 0o600, flag: "wx" });
  await run("/usr/bin/plutil", ["-lint", plistFile], { timeout: 3000 });
  let bootstrapped = false;
  try {
    await run("/bin/launchctl", ["bootstrap", `gui/${process.getuid()}`, plistFile], { timeout: 5000 }); bootstrapped = true;
    const client = desktop.createDesktopClaudeClient({ configDir, timeoutMs: 45000 });
    try {
      let health;
      for (let n = 0; n < 10; n++) { health = await client.health().catch(() => null); if (health?.context === "Aqua") break; await new Promise(resolve => setTimeout(resolve, 250)); }
      if (health?.context !== "Aqua") throw new Error("Desktop helper did not become ready.");
      const status = await client.status();
      if (status.context !== "Aqua" || status.credential.state !== "detected") throw new Error("Desktop context/native metadata gate did not pass.");
      console.log(JSON.stringify({ installed: true, context: "Aqua", credential: status.credential.state, liveVerified: false, webHostChanged: false }));
    } finally { client.close(); }
  } catch {
    // This exact newly installed agent has never received a task/login request.
    if (bootstrapped) await run("/bin/launchctl", ["bootout", service], { timeout: 5000 }).catch(() => {});
    const suffix = `.failed-${crypto.randomUUID()}`;
    await fs.rename(plistFile, plistFile + suffix); await fs.rename(configFile, configFile + suffix);
    throw new Error("Desktop helper gate failed; the new agent was unloaded and its files retained for inspection. Web host was not changed.");
  }
}
function connectorsPath() { return ["/opt/homebrew/bin", "/usr/local/bin", path.join(os.homedir(), ".local", "bin")]; }
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) installDesktop().catch(error => { console.error(error.message); process.exitCode = 1; });
