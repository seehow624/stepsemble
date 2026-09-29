#!/usr/bin/env node
// Checks the newest Pi release against what Stepsemble relies on, once per
// release. Installs the official npm package into a scratch folder (with no
// install scripts), runs scripts/check-native-pi-release.mjs against it (a
// local fake model; no account or paid request) and keeps the verdict in
// ~/.config/stepsemble/pi-release-checks.json.
//   node scripts/check-pi-release.mjs [version] [--force]
// Prints one JSON object. action "none": the release passed (now or before);
// "adapt": it failed a check, and Stepsemble must be changed for it. Exit 0
// when it passed, 2 when it failed, 1 when it could not be checked.
import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const run = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PACKAGE = "@earendil-works/pi-coding-agent";
const recordFile = process.env.STEPSEMBLE_PI_RELEASE_CHECKS
  || path.join(os.homedir(), ".config", "stepsemble", "pi-release-checks.json");
const args = process.argv.slice(2);
const force = args.includes("--force");
const requested = args.find(arg => !arg.startsWith("--")) || null;
let work = null;
function finish(code, report) {
  if (work) fsSync.rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  console.log(JSON.stringify(report, null, 2));
  process.exit(code);
}
function readRecords() {
  try { const value = JSON.parse(fsSync.readFileSync(recordFile, "utf8")); return value?.releases && typeof value.releases === "object" ? value.releases : {}; }
  catch { return {}; }
}
function writeRecord(version, entry) {
  const releases = { ...readRecords(), [version]: entry };
  const kept = Object.fromEntries(Object.entries(releases).sort((a, b) => String(b[1].checkedAt).localeCompare(String(a[1].checkedAt))).slice(0, 40));
  fsSync.mkdirSync(path.dirname(recordFile), { recursive: true, mode: 0o700 });
  const temp = recordFile + "." + process.pid + ".tmp";
  fsSync.writeFileSync(temp, JSON.stringify({ releases: kept }, null, 2) + "\n", { mode: 0o600 });
  fsSync.renameSync(temp, recordFile);
}

let version = requested;
try {
  if (!version) version = JSON.parse((await run("npm", ["view", PACKAGE, "dist-tags", "--json"], { timeout: 60000 })).stdout).latest;
} catch (error) { finish(1, { action: "wait", state: "npm_unavailable", error: String(error.message || error).slice(0, 200) }); }
if (!/^\d{1,4}\.\d{1,4}\.\d{1,4}$/.test(String(version))) finish(1, { action: "wait", state: "version_unrecognized", version });
let installed = null;
try { installed = /(\d+\.\d+\.\d+)/.exec((await run("pi", ["--version"], { timeout: 20000 })).stdout)?.[1] || null; } catch {}
const known = readRecords()[version];
if (known?.result === "passed" && !force) finish(0, { action: "none", state: "already_checked", version, installed, checkedAt: known.checkedAt });

work = await fs.mkdtemp(path.join(os.tmpdir(), "stepsemble-pi-check-"));
const spec = PACKAGE + "@" + version;
let entry, integrity = null;
try {
  integrity = (await run("npm", ["view", spec, "dist.integrity"], { timeout: 60000 })).stdout.trim() || null;
  await run("npm", ["install", "--prefix", work, "--ignore-scripts", "--no-audit", "--no-fund", "--omit=dev", spec], { cwd: work, timeout: 10 * 60 * 1000, maxBuffer: 16 * 1024 * 1024 });
  const directory = path.join(work, "node_modules", ...PACKAGE.split("/"));
  const manifest = JSON.parse(await fs.readFile(path.join(directory, "package.json"), "utf8"));
  if (manifest.version !== version) throw new Error("installed " + manifest.version + " for " + version);
  const bin = typeof manifest.bin === "string" ? manifest.bin : manifest.bin?.pi;
  if (!bin) throw new Error("the package names no pi command");
  entry = path.join(directory, bin);
} catch (error) { finish(1, { action: "wait", state: "download_failed", version, artifact: spec, error: String(error.stderr || error.message || error).slice(0, 300) }); }

let result;
try {
  const { stdout } = await run(process.execPath, [path.join(root, "scripts", "check-native-pi-release.mjs"), entry], { cwd: root, timeout: 10 * 60 * 1000, maxBuffer: 16 * 1024 * 1024 });
  result = JSON.parse(stdout.trim().split("\n").filter(Boolean).pop());
} catch (error) {
  const out = String(error.stdout || "").trim().split("\n").filter(Boolean).pop();
  try { result = JSON.parse(out); } catch { result = { result: "failed", error: String(error.message || error).slice(0, 400) }; }
}
const passed = result.result === "passed";
const entryRecord = { result: passed ? "passed" : "failed", checkedAt: new Date().toISOString(), artifact: spec, integrity,
  checks: result.checks || {}, ...(result.error ? { error: String(result.error).slice(0, 600) } : {}) };
writeRecord(version, entryRecord);
finish(passed ? 0 : 2, { action: passed ? "none" : "adapt", state: passed ? "passed" : "failed", version, installed, ...entryRecord, ...(result.debug ? { debug: result.debug } : {}) });
