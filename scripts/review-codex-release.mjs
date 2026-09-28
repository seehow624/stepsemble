#!/usr/bin/env node
// Reviews a Codex release for Stepsemble from the official npm artifact.
//   node scripts/review-codex-release.mjs <version>           report only
//   node scripts/review-codex-release.mjs <version> --write   record it
//   node scripts/review-codex-release.mjs <version> --write --adapted
//
// The report compares the release's app-server contract with the latest
// reviewed one: whether anything Stepsemble sends or reads was removed or
// changed (codex-schema-compat). With --write, a release that changes nothing
// Stepsemble uses is recorded: its schema file and reviewed profile, the
// contract baseline, and a row and review record in
// docs/codex-compatibility-runtime.md. The composer, parallel, approval and
// branch oracles must pass against the artifact first; if any fails, nothing
// is kept. The oracles use a local fake model: no account or paid request.
// --adapted records a release that does change something Stepsemble uses,
// once Stepsemble has been changed for it; the oracles still have to pass.
//
// Prints one JSON object. Exit 0: reviewed (or already reviewed). Exit 2: the
// release changes something Stepsemble uses; Stepsemble must be adapted by
// hand. Exit 1: the review could not be completed.
import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const run = promisify(execFile);
const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const codexDir = path.join(root, "protocol", "native", "codex");
const registryFile = path.join(codexDir, "compatibility.json");
const docsFile = path.join(root, "docs", "codex-compatibility-runtime.md");
const { registry, captureSchemaFingerprint, SCHEMA_FILES } = require("../server/codex-compatibility.js");
const { CONTRACT_FILES, compareCodexContracts } = require("../server/codex-schema-compat.js");
const { loadContractBaseline } = require("../server/codex-contract-baseline.js");
const ORACLES = ["check-native-codex-composer.mjs", "check-native-codex-parallel.mjs", "check-native-codex-approval.mjs", "check-native-codex-branch.mjs"];
const PLATFORMS = { "darwin-arm64": "aarch64-apple-darwin", "darwin-x64": "x86_64-apple-darwin",
  "linux-arm64": "aarch64-unknown-linux-musl", "linux-x64": "x86_64-unknown-linux-musl" };

const [version, ...flags] = process.argv.slice(2);
const report = { version: version || null };
let work = null;
function finish(code, fields = {}) {
  Object.assign(report, fields);
  if (work) fsSync.rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  console.log(JSON.stringify(report, null, 2));
  process.exit(code);
}
const write = flags.includes("--write");
const adapted = flags.includes("--adapted");
if (!/^\d{1,4}\.\d{1,4}\.\d{1,4}$/.test(String(version)) || flags.some(flag => !["--write", "--adapted"].includes(flag)) || adapted && !write) {
  console.error("Usage: node scripts/review-codex-release.mjs <x.y.z> [--write [--adapted]]");
  process.exit(1);
}
const profiles = registry().profiles;
if (profiles.some(profile => profile.nativeVersion === version && profile.verification === "reviewed")) finish(0, { state: "already_reviewed" });

const platform = process.platform + "-" + process.arch;
const triple = PLATFORMS[platform];
if (!triple) finish(1, { state: "error", error: "unsupported_platform", platform });
work = await fs.mkdtemp(path.join(os.tmpdir(), "stepsemble-codex-review-"));
const written = [];
const restore = [];
try {
  // The official platform artifact, as npm publishes it.
  const spec = "@openai/codex@" + version + "-" + platform;
  const packed = JSON.parse((await run("npm", ["pack", spec, "--json", "--pack-destination", work], { cwd: work, maxBuffer: 16 * 1024 * 1024, timeout: 10 * 60 * 1000 })).stdout);
  const archive = path.join(work, packed[0].filename);
  const archiveSha256 = crypto.createHash("sha256").update(await fs.readFile(archive)).digest("hex");
  await run("tar", ["-xzf", archive, "-C", work, "package/vendor/" + triple + "/bin"], { timeout: 5 * 60 * 1000 });
  const binary = path.join(work, "package", "vendor", triple, "bin", "codex");
  const printed = (await run(binary, ["--version"], { timeout: 20000 })).stdout.trim();
  if (printed !== "codex-cli " + version) finish(1, { state: "error", error: "unexpected_version", printed });
  Object.assign(report, { artifact: spec, archiveSha256 });

  // What changed, against the latest reviewed contract.
  const captured = await captureSchemaFingerprint(binary);
  const baseline = loadContractBaseline();
  const sameAs = profiles.find(profile => profile.verification === "reviewed" && profile.schemaFingerprint === captured.fingerprint)?.nativeVersion || null;
  const comparison = compareCodexContracts(baseline.documents, captured.documents);
  const changedFiles = CONTRACT_FILES.filter(file => JSON.stringify(baseline.documents[file]) !== JSON.stringify(captured.documents[file]));
  Object.assign(report, { baseline: baseline.nativeVersion, fingerprint: captured.fingerprint, sameAs,
    contractFiles: CONTRACT_FILES.length, changedFiles, compatible: comparison.compatible,
    breakingCount: comparison.breakingCount, breaking: comparison.breaking });
  if (!comparison.compatible && !adapted) finish(2, { state: "needs_adaptation" });
  if (!write) finish(0, { state: "compatible_not_recorded" });

  // Record the release, then hold it to the oracles.
  const schemaFile = path.join(codexDir, version + "-schema.json");
  const newest = JSON.parse(await fs.readFile(path.join(codexDir, baseline.nativeVersion + "-schema.json"), "utf8"));
  const order = new Map(newest.schemas.map((row, index) => [row.file, index]));
  const schemas = [...captured.schemas].filter(row => SCHEMA_FILES.includes(row.file))
    .sort((a, b) => (order.get(a.file) ?? 999) - (order.get(b.file) ?? 999) || a.file.localeCompare(b.file));
  await fs.writeFile(schemaFile, JSON.stringify({ fixtureVersion: 1, nativeVersion: version, scope: newest.scope,
    fingerprint: captured.fingerprint, schemas }, null, 2) + "\n", { flag: "wx" });
  written.push(schemaFile);
  const registryText = await fs.readFile(registryFile, "utf8");
  restore.push([registryFile, registryText]);
  const parsed = JSON.parse(registryText);
  const latest = parsed.profiles.filter(profile => profile.verification === "reviewed").pop();
  parsed.profiles.push({ profileId: "codex-app-server-v2-" + version, version, channel: "stable", schemaFingerprint: captured.fingerprint,
    verification: "reviewed", capabilities: { ...latest.capabilities } });
  await fs.writeFile(registryFile, JSON.stringify(parsed, null, 2) + "\n");

  const oracles = {};
  for (const oracle of ORACLES) {
    try {
      const { stdout } = await run(process.execPath, [path.join(root, "scripts", oracle), binary], { cwd: root, timeout: 5 * 60 * 1000,
        maxBuffer: 16 * 1024 * 1024, env: { ...process.env, STEPSEMBLE_ORACLE_CODEX_VERSION: version } });
      const line = stdout.trim().split("\n").filter(Boolean).pop() || "{}";
      const result = JSON.parse(line);
      if (result.result !== "passed") throw new Error(line.slice(0, 400));
      oracles[oracle.replace(/^check-native-codex-|\.mjs$/g, "")] = "passed";
    } catch (error) {
      oracles[oracle.replace(/^check-native-codex-|\.mjs$/g, "")] = "failed";
      throw Object.assign(new Error("oracle_failed"), { detail: oracle + ": " + String(error.stderr || error.message || error).slice(-1200), oracles });
    }
  }
  report.oracles = oracles;

  // The baseline the next release is compared with.
  const baselineFile = path.join(codexDir, "contract-baseline.json.gz");
  restore.push([baselineFile, await fs.readFile(baselineFile)]);
  await run(process.execPath, [path.join(root, "scripts", "codex-contract-baseline.mjs"), version], { cwd: root, timeout: 5 * 60 * 1000 });

  // The review record.
  const docs = await fs.readFile(docsFile, "utf8");
  restore.push([docsFile, docs]);
  const rows = [...docs.matchAll(/^\| Codex `[^`]+` \| native \| native \| reviewed native mutation \|$/gm)];
  const lastRow = rows[rows.length - 1];
  if (!lastRow) throw new Error("docs_table_not_found");
  let next = docs.slice(0, lastRow.index + lastRow[0].length) + "\n| Codex `" + version + "` | native | native | reviewed native mutation |" + docs.slice(lastRow.index + lastRow[0].length);
  const identical = CONTRACT_FILES.length - changedFiles.length;
  const code = value => "`" + value + "`";
  const paragraph = ["Reviewed with " + code("scripts/review-codex-release.mjs") + " against the " + code(baseline.nativeVersion) + " baseline, from the official npm artifact ("
    + code(spec) + ", archive SHA-256 " + code(archiveSha256) + "). " + identical + " of the " + CONTRACT_FILES.length + " contract files are identical"
    + (changedFiles.length ? "; the others are " + changedFiles.map(code).join(", ") + "." : ".")
    + (comparison.compatible ? " None of the changes removes or alters anything Stepsemble sends or reads."
      : " Stepsemble was changed for these differences: " + comparison.breaking.map(row => code(row.file + " " + row.path) + " (" + row.reason + ")").join("; ") + ".")
    + " The composer, parallel-pool, approval and branch oracles passed against that artifact with a local model. "
    + code(version + "-schema.json") + " records the baseline."].join("");
  const wrap = text => text.split(" ").reduce((lines, word) => {
    const last = lines[lines.length - 1];
    if (last && (last + " " + word).length <= 78) lines[lines.length - 1] = last + " " + word; else lines.push(word);
    return lines;
  }, []).join("\n");
  const record = "### " + version + " review record\n\n" + wrap(paragraph) + "\n\n";
  // After the last review record, before the next section.
  const lastRecord = next.lastIndexOf(" review record\n");
  const anchor = lastRecord < 0 ? -1 : next.indexOf("\n## ", lastRecord) + 1;
  if (anchor <= 0) throw new Error("docs_anchor_not_found");
  next = next.slice(0, anchor) + record + next.slice(anchor);
  await fs.writeFile(docsFile, next);
  finish(0, { state: "reviewed", written: [path.relative(root, schemaFile), path.relative(root, registryFile), "protocol/native/codex/contract-baseline.json.gz", path.relative(root, docsFile)] });
} catch (error) {
  for (const file of written) await fs.rm(file, { force: true }).catch(() => {});
  for (const [file, content] of restore.reverse()) await fs.writeFile(file, content).catch(() => {});
  finish(1, { state: "error", error: String(error.message || error).slice(0, 200), detail: error.detail || undefined, oracles: error.oracles || report.oracles });
} finally {
  await fs.rm(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {});
}
