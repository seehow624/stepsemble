#!/usr/bin/env node
// Checks the newest Grok Build release against what Stepsemble relies on,
// once per release. Downloads the official build for this platform (the one
// xAI's installer fetches), runs scripts/check-native-grok-release.mjs
// against it (a local fake model; no account or paid request) and keeps the
// verdict in ~/.config/stepsemble/grok-release-checks.json.
//   node scripts/check-grok-release.mjs [version] [--force]
// Prints one JSON object. action "none": the release passed (now or before);
// "adapt": it failed a check, and Stepsemble must be changed for it. Exit 0
// when it passed, 2 when it failed, 1 when it could not be checked.
import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { APP_VERSION, recordFileFor } from "./agent-release-lib.mjs";

const run = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const recordFile = process.env.STEPSEMBLE_GROK_RELEASE_CHECKS || recordFileFor("grok");
// The download hosts and platform names of xAI's installer (https://x.ai/cli/install.sh).
const BASES = ["https://x.ai/cli", "https://storage.googleapis.com/grok-build-public-artifacts/cli"];
const PLATFORMS = { "darwin-arm64": "macos-aarch64", "darwin-x64": "macos-x86_64", "linux-x64": "linux-x86_64", "linux-arm64": "linux-aarch64" };
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
async function latest() {
  for (const base of BASES) {
    try {
      const response = await fetch(base + "/stable", { signal: AbortSignal.timeout(30000) });
      if (response.ok) return (await response.text()).trim();
    } catch {}
  }
  throw new Error("the stable channel is unreachable at " + BASES.join(" and "));
}
async function download(url, file) {
  const response = await fetch(url, { signal: AbortSignal.timeout(10 * 60 * 1000) });
  if (!response.ok) throw new Error(url + " answered " + response.status);
  const hash = crypto.createHash("sha256");
  const out = fsSync.createWriteStream(file, { mode: 0o700 });
  for await (const chunk of response.body) { hash.update(chunk); if (!out.write(chunk)) await new Promise(resolve => out.once("drain", resolve)); }
  await new Promise((resolve, reject) => out.end(error => error ? reject(error) : resolve()));
  return hash.digest("hex");
}

let version = requested;
try { if (!version) version = await latest(); }
catch (error) { finish(1, { action: "wait", state: "channel_unavailable", error: String(error.message || error).slice(0, 200) }); }
if (!/^\d{1,4}\.\d{1,4}\.\d{1,4}$/.test(String(version))) finish(1, { action: "wait", state: "version_unrecognized", version });
let installed = null;
try { installed = /(\d+\.\d+\.\d+)/.exec((await run("grok", ["--version"], { timeout: 20000 })).stdout)?.[1] || null; } catch {}
const known = readRecords()[version];
if (known?.result === "passed" && !force) finish(0, { action: "none", state: "already_checked", version, installed, checkedAt: known.checkedAt });

const platform = PLATFORMS[process.platform + "-" + process.arch];
if (!platform) finish(1, { action: "wait", state: "unsupported_platform", version });
work = await fs.mkdtemp(path.join(os.tmpdir(), "stepsemble-grok-check-"));
const binary = path.join(work, "grok");
let artifact = null, archiveSha256 = null;
const failures = [];
for (const base of BASES) {
  const url = base + "/grok-" + version + "-" + platform;
  try { archiveSha256 = await download(url, binary); artifact = url; break; }
  catch (error) { failures.push(String(error.message || error).slice(0, 160)); }
}
if (!artifact) finish(1, { action: "wait", state: "download_failed", version, error: failures.join("; ") });
await fs.chmod(binary, 0o755);

let result;
try {
  const { stdout } = await run(process.execPath, [path.join(root, "scripts", "check-native-grok-release.mjs"), binary], { cwd: root, timeout: 10 * 60 * 1000, maxBuffer: 16 * 1024 * 1024 });
  result = JSON.parse(stdout.trim().split("\n").filter(Boolean).pop());
} catch (error) {
  const out = String(error.stdout || "").trim().split("\n").filter(Boolean).pop();
  try { result = JSON.parse(out); } catch { result = { result: "failed", error: String(error.message || error).slice(0, 400) }; }
}
const passed = result.result === "passed";
const entry = { result: passed ? "passed" : "failed", checkedAt: new Date().toISOString(), artifact, archiveSha256, stepsemble: APP_VERSION,
  checks: result.checks || {}, ...(result.error ? { error: String(result.error).slice(0, 600) } : {}) };
writeRecord(version, entry);
finish(passed ? 0 : 2, { action: passed ? "none" : "adapt", state: passed ? "passed" : "failed", version, installed, ...entry, ...(result.debug ? { debug: result.debug } : {}) });
