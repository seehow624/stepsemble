#!/usr/bin/env node
// Checks the newest stable Claude Code release against what Stepsemble relies on,
// once per release. Downloads the official npm artifact for this platform,
// runs scripts/check-native-claude-release.mjs against it (a local fake
// model; no account or paid request) and keeps the verdict in
// ~/.config/stepsemble/claude-release-checks.json.
//   node scripts/check-claude-release.mjs [version] [--force]
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
const recordFile = process.env.STEPSEMBLE_CLAUDE_RELEASE_CHECKS || recordFileFor("claude");
const PLATFORMS = { "darwin-arm64": "darwin-arm64", "darwin-x64": "darwin-x64", "linux-x64": "linux-x64", "linux-arm64": "linux-arm64" };
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
  // Claude Code's stable channel, which Anthropic tags stable; latest and
  // next come first and are left out.
  if (!version) version = JSON.parse((await run("npm", ["view", "@anthropic-ai/claude-code", "dist-tags", "--json"], { timeout: 60000 })).stdout).stable;
} catch (error) { finish(1, { action: "wait", state: "npm_unavailable", error: String(error.message || error).slice(0, 200) }); }
if (!/^\d{1,4}\.\d{1,4}\.\d{1,4}$/.test(String(version))) finish(1, { action: "wait", state: "version_unrecognized", version });
let installed = null;
try { installed = (await run("claude", ["--version"], { timeout: 20000 })).stdout.trim().split(/\s/)[0] || null; } catch {}
const known = readRecords()[version];
if (known?.result === "passed" && !force) finish(0, { action: "none", state: "already_checked", version, installed, checkedAt: known.checkedAt });

const platform = PLATFORMS[process.platform + "-" + process.arch];
if (!platform) finish(1, { action: "wait", state: "unsupported_platform", version });
work = await fs.mkdtemp(path.join(os.tmpdir(), "stepsemble-claude-check-"));
let binary;
const spec = "@anthropic-ai/claude-code-" + platform + "@" + version;
let archiveSha256 = null;
try {
  const packed = JSON.parse((await run("npm", ["pack", spec, "--json", "--pack-destination", work], { cwd: work, timeout: 10 * 60 * 1000, maxBuffer: 16 * 1024 * 1024 })).stdout);
  const archive = path.join(work, packed[0].filename);
  archiveSha256 = crypto.createHash("sha256").update(await fs.readFile(archive)).digest("hex");
  await run("tar", ["-xzf", archive, "-C", work, "package/claude"], { timeout: 5 * 60 * 1000 });
  binary = path.join(work, "package", "claude");
} catch (error) { finish(1, { action: "wait", state: "download_failed", version, artifact: spec, error: String(error.stderr || error.message || error).slice(0, 300) }); }

let result;
try {
  const { stdout } = await run(process.execPath, [path.join(root, "scripts", "check-native-claude-release.mjs"), binary], { cwd: root, timeout: 10 * 60 * 1000, maxBuffer: 16 * 1024 * 1024 });
  result = JSON.parse(stdout.trim().split("\n").filter(Boolean).pop());
} catch (error) {
  const out = String(error.stdout || "").trim().split("\n").filter(Boolean).pop();
  try { result = JSON.parse(out); } catch { result = { result: "failed", error: String(error.message || error).slice(0, 400) }; }
}
const passed = result.result === "passed";
const entry = { result: passed ? "passed" : "failed", checkedAt: new Date().toISOString(), artifact: spec, archiveSha256, stepsemble: APP_VERSION,
  checks: result.checks || {}, ...(result.error ? { error: String(result.error).slice(0, 600) } : {}) };
writeRecord(version, entry);
finish(passed ? 0 : 2, { action: passed ? "none" : "adapt", state: passed ? "passed" : "failed", version, installed, ...entry, ...(result.debug ? { debug: result.debug } : {}) });
