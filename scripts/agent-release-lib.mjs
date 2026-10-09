// What every agent release check shares: where its verdicts are kept, which
// versions count as stable releases, and how the native check is run.
//
// A verdict is kept per release in ~/.config/stepsemble/<name>-release-checks.json
// with the Stepsemble version that made it. The Host reads the same file
// before it upgrades an agent (server/agent-release-gate.js): a release that
// passed is installed; one that failed waits until a Stepsemble that supports
// it checks it again.
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

export const run = promisify(execFile);
export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const APP_VERSION = JSON.parse(fsSync.readFileSync(path.join(root, "package.json"), "utf8")).version;

// A stable release: three numbers, nothing after them (no -beta, -rc,
// -nightly, -alpha or snapshot builds).
export const isStable = value => /^\d{1,4}\.\d{1,4}\.\d{1,4}$/.test(String(value || ""));

export function recordFileFor(name) {
  const directory = process.env.STEPSEMBLE_RELEASE_CHECKS_DIR || path.join(os.homedir(), ".config", "stepsemble");
  return path.join(directory, name + "-release-checks.json");
}
export function readRecords(file) {
  try { const value = JSON.parse(fsSync.readFileSync(file, "utf8")); return value?.releases && typeof value.releases === "object" ? value.releases : {}; }
  catch { return {}; }
}
export function writeRecord(file, version, entry) {
  const releases = { ...readRecords(file), [version]: { ...entry, stepsemble: APP_VERSION } };
  const kept = Object.fromEntries(Object.entries(releases).sort((a, b) => String(b[1].checkedAt).localeCompare(String(a[1].checkedAt))).slice(0, 40));
  fsSync.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = file + "." + process.pid + ".tmp";
  fsSync.writeFileSync(temp, JSON.stringify({ releases: kept }, null, 2) + "\n", { mode: 0o600 });
  fsSync.renameSync(temp, file);
}

// The folders an agent's own installer puts it in, after Node's own.
export function searchPath() {
  const home = os.homedir();
  return [...new Set([path.dirname(process.execPath), path.join(home, ".bun", "bin"), path.join(home, ".local", "bin"),
    "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"])].join(path.delimiter);
}
export function which(name, extra = []) {
  for (const directory of [...extra, ...searchPath().split(path.delimiter)]) {
    const candidate = path.join(directory, name);
    try { if (fsSync.statSync(candidate).isFile()) { fsSync.accessSync(candidate, fsSync.constants.X_OK); return candidate; } } catch {}
  }
  return null;
}

// Runs scripts/<script> and reads the JSON object it prints last.
export async function runNative(script, args, { timeout = 10 * 60 * 1000 } = {}) {
  try {
    const { stdout } = await run(process.execPath, [path.join(root, "scripts", script), ...args], { cwd: root, timeout, maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, PATH: searchPath() } });
    return JSON.parse(stdout.trim().split("\n").filter(Boolean).pop());
  } catch (error) {
    const out = String(error.stdout || "").trim().split("\n").filter(Boolean).pop();
    try { return JSON.parse(out); } catch { return { result: "failed", error: String(error.message || error).slice(0, 400) }; }
  }
}

// One release check from start to verdict. fetch() returns what the native
// check needs and what to record of the artifact; native() returns its result.
export async function releaseCheck({ name, latest, installed = async () => null, fetch, native, argv = process.argv.slice(2) }) {
  const force = argv.includes("--force");
  const requested = argv.find(arg => !arg.startsWith("--")) || null;
  const file = recordFileFor(name);
  let work = null;
  const finish = (code, report) => {
    if (work) fsSync.rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    console.log(JSON.stringify(report, null, 2));
    process.exit(code);
  };
  let version = requested;
  try { if (!version) version = await latest(); }
  catch (error) { finish(1, { action: "wait", state: "channel_unavailable", error: String(error.message || error).slice(0, 200) }); }
  if (!isStable(version)) finish(1, { action: "wait", state: "not_a_stable_release", version });
  let current = null;
  try { current = await installed(); } catch {}
  const known = readRecords(file)[version];
  if (known?.result === "passed" && !force) finish(0, { action: "none", state: "already_checked", version, installed: current, checkedAt: known.checkedAt });
  work = fsSync.mkdtempSync(path.join(os.tmpdir(), "stepsemble-" + name + "-check-"));
  let candidate;
  try { candidate = await fetch(version, work); }
  catch (error) { finish(1, { action: "wait", state: error.state || "download_failed", version, error: String(error.stderr || error.message || error).slice(0, 300) }); }
  const result = await native(candidate, version);
  const passed = result.result === "passed";
  const entry = { result: passed ? "passed" : "failed", checkedAt: new Date().toISOString(), ...(candidate.record || {}),
    checks: result.checks || {}, ...(result.error ? { error: String(result.error).slice(0, 600) } : {}) };
  writeRecord(file, version, entry);
  finish(passed ? 0 : 2, { action: passed ? "none" : "adapt", state: passed ? "passed" : "failed", version, installed: current,
    ...entry, stepsemble: APP_VERSION, ...(result.debug ? { debug: result.debug } : {}) });
}
