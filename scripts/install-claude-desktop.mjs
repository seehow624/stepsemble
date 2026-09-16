#!/usr/bin/env node
// Explicit opt-in installation/upgrade. This file never starts an auth flow,
// copies provider credentials, or changes the Web host. The --upgrade path is
// deliberately existing-installation-only: it cannot create a new helper.
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

const run = promisify(execFile);
export const DESKTOP_HELPER_LABEL = "com.stepsemble.claude-desktop";
export const STRUCTURED_STREAM_VERSION = 1;
const label = DESKTOP_HELPER_LABEL;
const ACTIVE_LOGIN_STATES = new Set(["prepared", "starting", "waiting", "verifying", "cancelling"]);
const TERMINAL_LOGIN_STATES = new Set(["completed", "failed", "cancelled", "unconfirmed", "interrupted", "expired", "blocked"]);
const REQUIRED_PLIST_KEYS = ["Label", "ProgramArguments", "WorkingDirectory", "EnvironmentVariables", "LimitLoadToSessionType", "ProcessType", "RunAtLoad", "KeepAlive", "ThrottleInterval", "StandardOutPath", "StandardErrorPath"];
const SAFE_UPGRADE_CODES = new Set([
  "upgrade_existing_installation_required", "upgrade_invalid_installation", "upgrade_permissions",
  "upgrade_helper_unavailable", "upgrade_helper_recovery_required", "upgrade_active_login",
  "upgrade_active_tasks", "upgrade_active_structured", "upgrade_structured_stream_unsupported",
  "upgrade_launchctl", "upgrade_stage_failed", "upgrade_plist_failed", "upgrade_bootstrap_failed",
  "upgrade_verify_failed", "upgrade_rollback_failed", "upgrade_failed",
]);

const xml = value => String(value).replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[char]);
const own = (value, key) => Object.prototype.hasOwnProperty.call(value ?? {}, key);
const isRecord = value => !!value && typeof value === "object" && !Array.isArray(value);
const isAbsoluteClean = value => typeof value === "string" && path.isAbsolute(value) && !value.includes("\0");
const inside = (file, root) => {
  const target = path.resolve(file), base = path.resolve(root);
  return target === base || target.startsWith(base + path.sep);
};

function upgradeError(code, details = {}) {
  const error = new Error(code);
  error.code = code;
  Object.assign(error, details);
  return error;
}

/** Parse and validate installer arguments without consulting the filesystem. */
export function parseInstallerArguments(argv = []) {
  if (!Array.isArray(argv) || !argv.length) throw new Error("Usage: node scripts/install-claude-desktop.mjs --install [--root /absolute/project-root] | --upgrade [--existing-only] | --check");
  const mode = argv[0];
  if (mode === "--check") {
    if (argv.length !== 1) throw new Error("--check does not accept additional arguments.");
    return { mode, roots: [], existingOnly: false };
  }
  if (mode === "--upgrade") {
    if (argv.slice(1).some(value => value !== "--existing-only")) throw new Error("--upgrade accepts only --existing-only.");
    return { mode, roots: [], existingOnly: true };
  }
  if (mode !== "--install") throw new Error("Usage: node scripts/install-claude-desktop.mjs --install [--root /absolute/project-root] | --upgrade [--existing-only] | --check");
  const roots = [];
  for (let i = 1; i < argv.length; i += 2) {
    if (argv[i] !== "--root" || !argv[i + 1] || !path.isAbsolute(argv[i + 1]) || argv[i + 1].includes("\0") || roots.length >= 15) throw new Error("Only explicit absolute --root paths are accepted.");
    roots.push(argv[i + 1]);
  }
  return { mode, roots, existingOnly: false };
}

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

function runtimeRootFor(home) { return path.join(home, ".local", "share", "stepsemble-claude-desktop"); }
function installPaths(home, configDir) {
  const paths = state.desktopPaths(configDir);
  return {
    paths,
    configFile: path.join(paths.directory, "config.json"),
    plistFile: path.join(home, "Library", "LaunchAgents", `${label}.plist`),
    runtimeRoot: runtimeRootFor(home),
  };
}

/** Pure config provenance gate used by --upgrade and tests. */
export function validateExistingConfig(config, { home, configDir } = {}) {
  if (!state.exact(config, ["version", "home", "configDir", "claudeCommand", "roots"]) || config.version !== 1
    || config.home !== home || config.configDir !== configDir || !isAbsoluteClean(config.home) || !isAbsoluteClean(config.configDir)
    || !isAbsoluteClean(config.claudeCommand) || !Array.isArray(config.roots) || !config.roots.length || config.roots.length > 16
    || config.roots.some(root => !isAbsoluteClean(root))) throw upgradeError("upgrade_invalid_installation");
  return config;
}

/** Pure launchd provenance gate. It accepts only the exact helper plist shape. */
export function validateExistingPlist(plist, { home, configFile, runtimeRoot } = {}) {
  if (!isRecord(plist) || Object.keys(plist).sort().join("|") !== REQUIRED_PLIST_KEYS.slice().sort().join("|")) throw upgradeError("upgrade_invalid_installation");
  if (plist.Label !== label || !Array.isArray(plist.ProgramArguments) || plist.ProgramArguments.length !== 3
    || plist.ProgramArguments.some(value => !isAbsoluteClean(value)) || path.resolve(plist.ProgramArguments[2]) !== path.resolve(configFile)
    || !isAbsoluteClean(plist.WorkingDirectory) || path.resolve(plist.WorkingDirectory) !== path.dirname(path.resolve(plist.ProgramArguments[1]))
    || !isRecord(plist.EnvironmentVariables) || Object.keys(plist.EnvironmentVariables).sort().join("|") !== "HOME|PATH"
    || plist.EnvironmentVariables.HOME !== home || typeof plist.EnvironmentVariables.PATH !== "string" || !plist.EnvironmentVariables.PATH
    || plist.LimitLoadToSessionType !== "Aqua" || plist.ProcessType !== "Interactive" || plist.RunAtLoad !== true
    || !state.exact(plist.KeepAlive, ["SuccessfulExit"]) || plist.KeepAlive.SuccessfulExit !== false
    || plist.ThrottleInterval !== 30 || plist.StandardOutPath !== "/dev/null" || plist.StandardErrorPath !== "/dev/null") throw upgradeError("upgrade_invalid_installation");
  const [node, entry] = plist.ProgramArguments;
  if (!inside(entry, runtimeRoot) || path.basename(entry) !== "claude-desktop-entry.js" || path.basename(path.dirname(entry)) !== "server") throw upgradeError("upgrade_invalid_installation");
  return { node, entry, config: plist.ProgramArguments[2], home, searchPath: plist.EnvironmentVariables.PATH };
}

function readCount(value, key, code) {
  if (!own(value, key)) return null;
  const item = value[key];
  if (item === false) return 0;
  if (Number.isSafeInteger(item) && item >= 0) return item;
  if (Array.isArray(item)) return item.length;
  throw upgradeError(code);
}

function rejectBusyFields(value, source, { allowMaintenance = false } = {}) {
  if (!isRecord(value)) throw upgradeError("upgrade_helper_unavailable");
  if (value.recoveryRequired === true || value.uncertain === true || value.uncertainTasks === true) throw upgradeError("upgrade_helper_recovery_required");
  if (typeof value.blockedReason === "string" && value.blockedReason) {
    if (value.blockedReason === "active_tasks") throw upgradeError("upgrade_active_tasks");
    if (value.blockedReason.includes("recovery") || value.blockedReason.includes("uncertain")) throw upgradeError("upgrade_helper_recovery_required");
    throw upgradeError("upgrade_active_tasks");
  }
  for (const key of ["activeTasks", "activeLegacy", "activeLegacyTasks", "legacyTaskCount", "legacyTasks", "uncertainTasks"]) {
    const count = readCount(value, key, "upgrade_helper_recovery_required");
    if (count !== null && count > 0) throw upgradeError(key.startsWith("uncertain") ? "upgrade_helper_recovery_required" : "upgrade_active_tasks");
  }
  if (own(value, "maintenance") && !allowMaintenance) {
    const maintenance = value.maintenance;
    if (!isRecord(maintenance)) throw upgradeError("upgrade_helper_recovery_required");
    if (["active", "locked", "busy", "starting"].includes(maintenance.state) || maintenance.active === true) throw upgradeError("upgrade_active_tasks");
  }
  if (source === "status" && own(value, "tasks")) {
    const count = readCount(value, "tasks", "upgrade_helper_recovery_required");
    if (count !== null && count > 0) throw upgradeError("upgrade_active_tasks");
  }
}

function validateLogin(status) {
  if (status.login === null || status.login === undefined) return;
  if (!isRecord(status.login) || typeof status.login.state !== "string") throw upgradeError("upgrade_helper_recovery_required");
  if (ACTIVE_LOGIN_STATES.has(status.login.state)) throw upgradeError("upgrade_active_login");
  if (!TERMINAL_LOGIN_STATES.has(status.login.state)) throw upgradeError("upgrade_helper_recovery_required");
}

/**
 * Pure preflight gate. A missing activeStructured field is the explicit old
 * helper signal (old helpers had no structured children); missing context,
 * malformed fields, and unavailable responses never count as idle.
 */
export function validateUpgradePreflight({ status, health, allowMaintenance = false } = {}) {
  if (!isRecord(status) || !isRecord(health) || status.version !== 1 || status.context !== "Aqua" || health.version !== 1 || health.context !== "Aqua") throw upgradeError("upgrade_helper_unavailable");
  if (typeof status.instance !== "string" || !state.UUID.test(status.instance) || typeof health.instance !== "string" || !state.UUID.test(health.instance) || status.instance !== health.instance) throw upgradeError("upgrade_helper_unavailable");
  if (!isRecord(status.credential) || typeof status.credential.state !== "string" || !status.credential.state || status.credential.liveVerified !== false) throw upgradeError("upgrade_helper_unavailable");
  if (!["detected", "signed_out", "other_auth"].includes(status.credential.state)) throw upgradeError("upgrade_helper_unavailable");
  if (!allowMaintenance && status.canStart !== true) throw upgradeError("upgrade_active_tasks");
  validateLogin(status);
  rejectBusyFields(status, "status", { allowMaintenance });
  rejectBusyFields(health, "health", { allowMaintenance });
  const activeStructured = own(health, "activeStructured") ? readCount(health, "activeStructured", "upgrade_helper_unavailable") : 0;
  if (activeStructured > 0) throw upgradeError("upgrade_active_structured");
  if (own(status, "activeStructured")) {
    const statusStructured = readCount(status, "activeStructured", "upgrade_helper_unavailable");
    if (statusStructured > 0) throw upgradeError("upgrade_active_structured");
  }
  if (own(health, "structuredStreamVersion") && health.structuredStreamVersion !== STRUCTURED_STREAM_VERSION) throw upgradeError("upgrade_structured_stream_unsupported");
  return { credentialState: status.credential.state, activeStructured, oldStructuredStreamVersion: health.structuredStreamVersion ?? null };
}

export function validateUpgradedHelper({ status, health } = {}) {
  const result = validateUpgradePreflight({ status, health });
  if (health.structuredStreamVersion !== STRUCTURED_STREAM_VERSION) throw upgradeError("upgrade_structured_stream_unsupported");
  if (!own(health, "activeStructured") || health.activeStructured !== 0) throw upgradeError("upgrade_active_structured");
  return result;
}

async function privateStat(file, { uid = process.getuid?.(), directory = false, maxBytes = 0 } = {}) {
  let stat;
  try { stat = await fs.lstat(file); } catch (error) { throw upgradeError("upgrade_existing_installation_required", { cause: error }); }
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile()) || uid !== undefined && stat.uid !== uid || (stat.mode & 0o077)) throw upgradeError("upgrade_permissions");
  if (!directory && maxBytes && stat.size > maxBytes) throw upgradeError("upgrade_permissions");
  return stat;
}

async function assertNoSymlinkPath(target, trustedRoot = null) {
  const resolved = path.resolve(target), base = trustedRoot ? path.resolve(trustedRoot) : null;
  const root = base && inside(resolved, base) ? base : path.parse(resolved).root;
  let current = root;
  if (base) {
    const rootStat = await fs.lstat(root).catch(error => { throw upgradeError("upgrade_permissions", { cause: error }); });
    if (rootStat.isSymbolicLink()) throw upgradeError("upgrade_permissions");
  }
  for (const part of resolved.slice(root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    const stat = await fs.lstat(current).catch(error => { throw upgradeError("upgrade_permissions", { cause: error }); });
    if (stat.isSymbolicLink()) throw upgradeError("upgrade_permissions");
  }
}

async function assertNoSymlinks(root) {
  const stat = await fs.lstat(root).catch(error => { throw upgradeError("upgrade_stage_failed", { cause: error }); });
  if (stat.isSymbolicLink()) throw upgradeError("upgrade_stage_failed");
  if (!stat.isDirectory()) return;
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    const target = path.join(root, entry.name), child = await fs.lstat(target);
    if (child.isSymbolicLink()) throw upgradeError("upgrade_stage_failed");
    if (child.isDirectory()) await assertNoSymlinks(target);
  }
}

async function privateDirectory(directory, { uid = process.getuid?.(), create = false } = {}) {
  if (create) await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  // Private directory checks intentionally reject symlinks and group/world access.
  await privateStat(directory, { uid, directory });
}

async function privateRead(file, options = {}) {
  await privateStat(file, { ...options, directory: false, maxBytes: options.maxBytes ?? 16 * 1024 * 1024 });
  try { return await fs.readFile(file, "utf8"); } catch (error) { throw upgradeError("upgrade_permissions", { cause: error }); }
}

async function syncDirectory(directory) {
  const handle = await fs.open(directory, "r");
  try { await handle.sync(); } finally { await handle.close(); }
}

async function stageLocalRuntime({ source, runtimeRoot, uid = process.getuid?.() }) {
  await privateDirectory(runtimeRoot, { uid, create: true });
  const release = await fs.mkdtemp(path.join(runtimeRoot, `candidate-${crypto.randomUUID()}-`));
  try {
    await fs.chmod(release, 0o700);
    await fs.cp(path.join(source, "server"), path.join(release, "server"), { recursive: true });
    // The helper's server graph imports protocol/transaction-state and native
    // wire modules. Keep the complete checked-in protocol tree beside it;
    // never point an immutable helper back at the mutable Web checkout.
    await fs.cp(path.join(source, "protocol"), path.join(release, "protocol"), { recursive: true });
    // protocol/transaction-state imports the browser-safe projection and
    // lifecycle modules; copy the complete checked-in module set to avoid a
    // runtime that passes syntax checks but fails on first structured request.
    await fs.cp(path.join(source, "public", "modules"), path.join(release, "public", "modules"), { recursive: true });
    await assertNoSymlinks(release);
    // The helper runtime is immutable from the user's perspective: owner-only
    // files/directories, with no symlink escape back into the working tree.
    const chmodTree = async current => {
      const stat = await fs.lstat(current);
      if (stat.isDirectory()) {
        await fs.chmod(current, 0o700);
        for (const entry of await fs.readdir(current)) await chmodTree(path.join(current, entry));
      } else await fs.chmod(current, 0o700);
    };
    await chmodTree(release);
    return release;
  } catch (error) {
    throw upgradeError("upgrade_stage_failed", { cause: error, candidate: release });
  }
}

async function writeUpgradeTemp(file, contents) {
  const temporary = `${file}.upgrade-${crypto.randomUUID()}.tmp`;
  try { await fs.writeFile(temporary, contents, { encoding: "utf8", mode: 0o600, flag: "wx" }); await fs.chmod(temporary, 0o600); return temporary; }
  catch (error) { throw upgradeError("upgrade_plist_failed", { cause: error, temporary }); }
}

async function atomicInstallFile(temporary, destination) {
  await fs.rename(temporary, destination);
  await syncDirectory(path.dirname(destination));
}

async function decodePlistDefault(file, runImpl) {
  const result = await runImpl("/usr/bin/plutil", ["-convert", "json", "-o", "-", "--", file], { timeout: 3000, maxBuffer: 256 * 1024 });
  try { return JSON.parse(result.stdout); } catch (error) { throw upgradeError("upgrade_invalid_installation", { cause: error }); }
}

async function lintPlist(file, runImpl) {
  try { await runImpl("/usr/bin/plutil", ["-lint", file], { timeout: 3000, maxBuffer: 256 * 1024 }); }
  catch (error) { throw upgradeError("upgrade_plist_failed", { cause: error }); }
}

async function smokeEntry({ node, entry, runImpl }) {
  try { await runImpl(node, ["-e", "require(process.argv[1])", entry], { timeout: 5000, maxBuffer: 256 * 1024 }); }
  catch (error) { throw upgradeError("upgrade_stage_failed", { cause: error }); }
}

async function servicePrint(service, runImpl) {
  let result;
  try { result = await runImpl("/bin/launchctl", ["print", service], { timeout: 3000, maxBuffer: 4 * 1024 * 1024 }); }
  catch (error) { throw upgradeError("upgrade_launchctl", { cause: error }); }
  const output = typeof result?.stdout === "string" ? result.stdout.trim() : "";
  // launchctl always prints the label for a valid target. Test doubles may
  // return no stdout; the exact service argument is still retained there.
  if (output && !output.includes(label)) throw upgradeError("upgrade_launchctl");
  if (result && result.stdout !== undefined && !output) throw upgradeError("upgrade_launchctl");
  return result;
}

async function launchctl(action, args, runImpl, code = "upgrade_launchctl") {
  try { return await runImpl("/bin/launchctl", [action, ...args], { timeout: action === "bootstrap" ? 5000 : 5000, maxBuffer: 4 * 1024 * 1024 }); }
  catch (error) { throw upgradeError(code, { cause: error }); }
}

// bootout returning is not proof that launchd has removed the job or reaped
// its old process. Do not race bootstrap against a terminating service.
async function waitForServiceRemoval(service, runImpl, pid = null, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    let absent = false;
    try { await runImpl("/bin/launchctl", ["print", service], { timeout: 2000, maxBuffer: 4 * 1024 * 1024 }); }
    catch (error) { if (error.code === 113) absent = true; else throw upgradeError("upgrade_launchctl", { cause: error }); }
    let alive = false;
    if (Number.isSafeInteger(pid) && pid > 1) {
      try { process.kill(pid, 0); alive = true; } catch (error) { alive = error.code !== "ESRCH"; }
    }
    if (absent && !alive) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw upgradeError("upgrade_launchctl");
}

function createClient(factory, configDir, timeoutMs) {
  return factory({ configDir, timeoutMs });
}

async function oldState(client, { allowMaintenance = false } = {}) {
  let status, health;
  try {
    status = await client.status();
    health = await client.health();
  } catch (error) { throw upgradeError("upgrade_helper_unavailable", { cause: error }); }
  return { status, health, gate: validateUpgradePreflight({ status, health, allowMaintenance }) };
}

async function prepareMaintenance(client, health) {
  // The method is present in the current client object even when it is talking
  // to a legacy helper. Only the explicit protocol marker authorizes sending
  // the new endpoint; a 404 must not turn a v1 upgrade into a false recovery.
  if (health?.maintenanceVersion !== 1 || typeof client?.prepareUpgrade !== "function") return null;
  let lock;
  try { lock = await client.prepareUpgrade(); } catch (error) { throw upgradeError("upgrade_active_tasks", { cause: error }); }
  if (!isRecord(lock) || typeof lock.token !== "string" || !lock.token || typeof lock.instance !== "string" || !state.UUID.test(lock.instance)) throw upgradeError("upgrade_helper_recovery_required");
  return { token: lock.token, instance: lock.instance };
}

async function cancelMaintenance(client, lock) {
  if (!lock || typeof client?.cancelUpgrade !== "function") return;
  try { await client.cancelUpgrade(lock.token, lock.instance); } catch {}
}

async function upgradedState(client, timeoutMs = 45000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() <= deadline) {
    try {
      const status = await client.status(), health = await client.health();
      return { status, health, gate: validateUpgradedHelper({ status, health }) };
    } catch (error) { last = error; }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw upgradeError("upgrade_verify_failed", { cause: last });
}

async function restoredState(client, timeoutMs = 45000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() <= deadline) {
    try { return await oldState(client); } catch (error) { last = error; }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw upgradeError("upgrade_rollback_failed", { cause: last });
}

function formatUpgradeError(error) {
  const code = SAFE_UPGRADE_CODES.has(error?.code) ? error.code : "upgrade_failed";
  return { upgraded: false, code, candidateRetained: error?.candidateRetained !== false, rollback: error?.rollback || "not_attempted" };
}

export { formatUpgradeError };

/**
 * Upgrade exactly one already-installed helper. All mutable effects are
 * injected at the edges so the safety gates can be tested without launchctl.
 */
export async function upgradeDesktop(argvOrOptions = ["--upgrade"], maybeOptions = {}) {
  const argv = Array.isArray(argvOrOptions) ? argvOrOptions : ["--upgrade"];
  const options = Array.isArray(argvOrOptions) ? maybeOptions : argvOrOptions;
  const parsed = parseInstallerArguments(argv);
  if (parsed.mode !== "--upgrade") throw new Error("upgradeDesktop requires --upgrade.");
  const platform = options.platform ?? process.platform, uid = options.uid ?? process.getuid?.();
  if (platform !== "darwin" || uid === undefined || uid === 0) throw upgradeError("upgrade_helper_unavailable");
  const home = options.home ?? os.homedir(), configDir = options.configDir ?? path.join(home, ".config", "stepsemble");
  if (!isAbsoluteClean(home) || !isAbsoluteClean(configDir) || path.resolve(configDir) !== path.join(path.resolve(home), ".config", "stepsemble")) throw upgradeError("upgrade_invalid_installation");
  const locations = installPaths(home, configDir), paths = locations.paths, runtimeRoot = locations.runtimeRoot, configFile = locations.configFile, plistFile = locations.plistFile;
  const runImpl = options.runImpl ?? run, source = options.source ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const clientFactory = options.clientFactory ?? (clientOptions => desktop.createDesktopClaudeClient(clientOptions));
  const readPlist = options.readPlist ?? (file => decodePlistDefault(file, runImpl));
  const stageRuntime = options.stageRuntime ?? stageLocalRuntime;
  const operation = crypto.randomUUID();
  let candidate, temporary, oldClient, newClient, maintenance, oldPlistBytes, oldConfigText, oldKeyText, newPlistText, replaced = false, bootedOut = false, newBootstrapped = false;
  let rollback = "not_attempted";
  try {
    await privateDirectory(configDir, { uid }); await privateDirectory(paths.directory, { uid });
    await privateDirectory(runtimeRoot, { uid, create: true });
    await privateStat(configFile, { uid, maxBytes: 16384 });
    oldConfigText = await privateRead(configFile, { uid, maxBytes: 16384 });
    let config; try { config = JSON.parse(oldConfigText); } catch (error) { throw upgradeError("upgrade_invalid_installation", { cause: error }); }
    validateExistingConfig(config, { home, configDir });
    oldKeyText = await privateRead(paths.key, { uid, maxBytes: 128 });
    if (!/^[a-f0-9]{64}$/.test(oldKeyText.trim())) throw upgradeError("upgrade_invalid_installation");
    await privateStat(plistFile, { uid, maxBytes: 256 * 1024 });
    oldPlistBytes = await fs.readFile(plistFile);
    const plist = await readPlist(plistFile);
    const old = validateExistingPlist(plist, { home, configFile, runtimeRoot });
    await assertNoSymlinkPath(old.entry, runtimeRoot); await assertNoSymlinkPath(old.node);
    const nodePath = options.nodePath ?? process.execPath;
    if (!isAbsoluteClean(nodePath)) throw upgradeError("upgrade_invalid_installation");
    await servicePrint(`gui/${uid}/${label}`, runImpl);

    oldClient = createClient(clientFactory, configDir, options.timeoutMs ?? 45000);
    await oldState(oldClient);
    candidate = await stageRuntime({ source, runtimeRoot, uid });
    if (!isAbsoluteClean(candidate) || !inside(candidate, runtimeRoot)) throw upgradeError("upgrade_stage_failed");
    await assertNoSymlinkPath(candidate, runtimeRoot);
    const entry = path.join(candidate, "server", "claude-desktop-entry.js");
    await assertNoSymlinkPath(entry, runtimeRoot);
    const searchPath = [...new Set([path.dirname(nodePath), old.searchPath, path.dirname(config.claudeCommand), "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(":").split(":").filter(Boolean))].join(":");
    await smokeEntry({ node: nodePath, entry, runImpl });
    newPlistText = launchAgentPlist({ node: nodePath, entry, config: configFile, home, searchPath });
    temporary = await writeUpgradeTemp(plistFile, newPlistText);
    await lintPlist(temporary, runImpl);

    // New helpers provide a short owner-only maintenance lease. Acquire it
    // only after staging (so its bounded TTL covers the destructive window).
    // v1 helpers have no lease; the repeated read below is their last fence.
    const maintenanceHealth = (await oldState(oldClient)).health;
    maintenance = await prepareMaintenance(oldClient, maintenanceHealth);
    // Re-read immediately before the only destructive operation. The Web
    // maintenance barrier and lease close the normal race; this second read
    // handles a legacy v1 helper which has no maintenance lock of its own.
    await oldState(oldClient, { allowMaintenance: maintenance !== null });
    // Config, IPC key and the verified old plist are immutable inputs. If a
    // concurrent updater changes any of them, abort before bootout rather than
    // replacing a file whose provenance is no longer the one we checked.
    await privateStat(plistFile, { uid, maxBytes: 256 * 1024 });
    if (await privateRead(configFile, { uid, maxBytes: 16384 }) !== oldConfigText
      || await privateRead(paths.key, { uid, maxBytes: 128 }) !== oldKeyText
      || !oldPlistBytes.equals(await fs.readFile(plistFile))) throw upgradeError("upgrade_invalid_installation");
    const priorService = await servicePrint(`gui/${uid}/${label}`, runImpl);
    const priorPid = Number(priorService?.stdout?.match(/^\s*pid = (\d+)\s*$/m)?.[1]) || null;
    await launchctl("bootout", [`gui/${uid}/${label}`], runImpl); bootedOut = true;
    await waitForServiceRemoval(`gui/${uid}/${label}`, runImpl, priorPid);
    oldClient.close(); oldClient = null;
    await atomicInstallFile(temporary, plistFile); temporary = null; replaced = true;
    await lintPlist(plistFile, runImpl);
    await launchctl("bootstrap", [`gui/${uid}`, plistFile], runImpl, "upgrade_bootstrap_failed"); newBootstrapped = true;
    newClient = createClient(clientFactory, configDir, options.timeoutMs ?? 45000);
    const verified = await upgradedState(newClient, options.verifyTimeoutMs ?? 45000);
    newClient.close(); newClient = null;
    maintenance = null; // bootout consumed the helper-owned lease.
    return { upgraded: true, context: "Aqua", structuredStreamVersion: STRUCTURED_STREAM_VERSION, activeStructured: 0, credential: verified.status.credential.state, webHostChanged: false };
  } catch (error) {
    newClient?.close(); newClient = null;
    if (!bootedOut) await cancelMaintenance(oldClient, maintenance);
    oldClient?.close(); oldClient = null;
    if (temporary) {
      const retained = `${plistFile}.failed-${operation}`;
      try { await fs.rename(temporary, retained); temporary = null; } catch {}
    }
    if (bootedOut || replaced || newBootstrapped) {
      try {
        if (newBootstrapped) {
          const candidateService = await servicePrint(`gui/${uid}/${label}`, runImpl);
          const candidatePid = Number(candidateService?.stdout?.match(/^\s*pid = (\d+)\s*$/m)?.[1]) || null;
          await launchctl("bootout", [`gui/${uid}/${label}`], runImpl);
          await waitForServiceRemoval(`gui/${uid}/${label}`, runImpl, candidatePid);
        }
        if (replaced) {
          const currentStat = await fs.lstat(plistFile).catch(error => { throw upgradeError("upgrade_rollback_failed", { cause: error }); });
          if (currentStat.isSymbolicLink() || !currentStat.isFile() || (currentStat.mode & 0o077) || currentStat.uid !== uid) throw upgradeError("upgrade_rollback_failed");
          const current = await fs.readFile(plistFile);
          // Never overwrite a file changed by another owner between the
          // replacement and rollback. Leave it in place for manual recovery.
          if (!newPlistText || current.toString() !== newPlistText) throw upgradeError("upgrade_rollback_failed");
          await fs.rename(plistFile, `${plistFile}.failed-${operation}`);
        }
        const restore = `${plistFile}.restore-${operation}.tmp`;
        await fs.writeFile(restore, oldPlistBytes, { mode: 0o600, flag: "wx" }); await fs.chmod(restore, 0o600); await atomicInstallFile(restore, plistFile);
        await lintPlist(plistFile, runImpl);
        await launchctl("bootstrap", [`gui/${uid}`, plistFile], runImpl, "upgrade_rollback_failed");
        const restoredClient = createClient(clientFactory, configDir, options.timeoutMs ?? 45000);
        try { await restoredState(restoredClient, options.rollbackTimeoutMs ?? 45000); rollback = "verified"; } finally { restoredClient.close(); }
      } catch (restoreError) { rollback = "failed"; error = upgradeError("upgrade_rollback_failed", { cause: restoreError }); }
    } else rollback = "not_needed";
    error.candidateRetained = true; error.rollback = rollback;
    throw error;
  }
}

export async function installDesktop(argv = process.argv.slice(2), options = {}) {
  const parsed = parseInstallerArguments(argv);
  if (parsed.mode === "--upgrade") return upgradeDesktop(argv, options);
  const platform = options.platform ?? process.platform, uid = options.uid ?? process.getuid?.();
  if (platform !== "darwin" || uid === undefined || uid === 0) throw new Error("Run as the desktop user on macOS, never root.");
  const home = options.home ?? os.homedir(), configDir = options.configDir ?? path.join(home, ".config", "stepsemble"), roots = [];
  for (const root of parsed.roots) roots.push(await fs.realpath(root));
  const paths = state.desktopPaths(configDir), configFile = path.join(paths.directory, "config.json"), service = `gui/${uid}/${label}`;
  if (parsed.mode === "--check") {
    const client = desktop.createDesktopClaudeClient({ configDir });
    try { const status = await client.status(); console.log(JSON.stringify({ context: status.context || "unavailable", credential: status.credential.state, liveVerified: false, canStart: status.canStart }));
      if (!status.context) throw new Error("Desktop helper is unavailable.");
    } finally { client.close(); } return;
  }
  await run("/bin/launchctl", ["print", `gui/${uid}`], { timeout: 3000, maxBuffer: 4 * 1024 * 1024 });
  const plistFile = path.join(home, "Library", "LaunchAgents", `${label}.plist`);
  for (const file of [configFile, plistFile]) {
    if (await fs.lstat(file).then(() => true, error => { if (error.code === "ENOENT") return false; throw error; })) throw new Error("A desktop helper installation already exists; use --check. Existing files will not be overwritten.");
  }
  const command = connectors.resolveCommand(connectors.CONNECTOR_DEFINITIONS.find(item => item.id === "claude-code"));
  if (!command) throw new Error("Install the official Claude Code CLI first.");
  await state.privateDirectory(configDir); await state.privateDirectory(paths.directory, true); await state.privateDirectory(paths.socketDirectory, true);
  const runtimeRoot = path.join(home, ".local", "share", "stepsemble-claude-desktop"); await state.privateDirectory(runtimeRoot, true);
  const release = await fs.mkdtemp(path.join(runtimeRoot, "candidate-"));
  const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  await fs.cp(path.join(source, "server"), path.join(release, "server"), { recursive: true });
  await fs.cp(path.join(source, "protocol"), path.join(release, "protocol"), { recursive: true });
  await fs.cp(path.join(source, "public", "modules"), path.join(release, "public", "modules"), { recursive: true });
  const config = { version: 1, home, configDir, claudeCommand: command, roots: [...new Set([home, ...roots])] };
  try { await fs.writeFile(paths.key, crypto.randomBytes(32).toString("hex"), { mode: 0o600, flag: "wx" }); }
  catch (error) { if (error.code !== "EEXIST") throw error; await state.privateRead(paths.key, 128); }
  await fs.writeFile(configFile, JSON.stringify(config), { mode: 0o600, flag: "wx" });
  const entry = path.join(release, "server", "claude-desktop-entry.js");
  const searchPath = [...new Set([path.dirname(process.execPath), path.dirname(command), ...connectorsPath(), "/usr/bin", "/bin", "/usr/sbin", "/sbin"])].join(":");
  await fs.mkdir(path.dirname(plistFile), { recursive: true });
  await fs.writeFile(plistFile, launchAgentPlist({ node: process.execPath, entry, config: configFile, home, searchPath }), { mode: 0o600, flag: "wx" }); await run("/usr/bin/plutil", ["-lint", plistFile], { timeout: 3000 });
  let bootstrapped = false;
  try {
    await run("/bin/launchctl", ["bootstrap", `gui/${uid}`, plistFile], { timeout: 5000 }); bootstrapped = true;
    const client = desktop.createDesktopClaudeClient({ configDir, timeoutMs: 45000 });
    try { let health; for (let n = 0; n < 10; n++) { health = await client.health().catch(() => null); if (health?.context === "Aqua") break; await new Promise(resolve => setTimeout(resolve, 250)); }
      if (health?.context !== "Aqua") throw new Error("Desktop helper did not become ready."); const status = await client.status(); if (status.context !== "Aqua" || status.credential.state !== "detected") throw new Error("Desktop context/native metadata gate did not pass.");
      console.log(JSON.stringify({ installed: true, context: "Aqua", credential: status.credential.state, liveVerified: false, webHostChanged: false }));
    } finally { client.close(); }
  } catch {
    if (bootstrapped) await run("/bin/launchctl", ["bootout", service], { timeout: 5000 }).catch(() => {});
    const suffix = `.failed-${crypto.randomUUID()}`; await fs.rename(plistFile, plistFile + suffix); await fs.rename(configFile, configFile + suffix);
    throw new Error("Desktop helper gate failed; the new agent was unloaded and its files retained for inspection. Web host was not changed.");
  }
}

function connectorsPath() { return ["/opt/homebrew/bin", "/usr/local/bin", path.join(os.homedir(), ".local", "bin")]; }

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const upgrade = process.argv[2] === "--upgrade";
  installDesktop().then(result => { if (upgrade && result) console.log(JSON.stringify(result)); }).catch(error => {
    if (upgrade) console.log(JSON.stringify(formatUpgradeError(error))); else console.error(error.message);
    process.exitCode = 1;
  });
}
