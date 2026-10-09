#!/usr/bin/env node
// Checks the newest stable Google Antigravity CLI release against what
// Stepsemble relies on, once per release. Antigravity publishes no download
// of a given version: its updater installs the release its update service
// has rolled out to everyone. So the installed `agy` is copied into a
// scratch folder and updated there, which leaves the installed one as it is,
// and scripts/check-native-antigravity-release.mjs runs against the copy (no
// account, no model request). The verdict is kept in
// ~/.config/stepsemble/antigravity-release-checks.json.
//   node scripts/check-antigravity-release.mjs [version] [--force]
// Prints one JSON object. action "none": passed; "adapt": a check failed;
// "wait": it could not be checked. Exit 0, 2 or 1.
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { run, releaseCheck, runNative, which } from "./agent-release-lib.mjs";

const UPDATER = "https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/";
const installedAgy = () => process.env.STEPSEMBLE_ANTIGRAVITY_BIN || which("agy");
const versionOf = async (binary, home) => /(\d+\.\d+\.\d+)/.exec((await run(binary, ["--version"], { timeout: 20000, env: { HOME: home || process.env.HOME, PATH: "/usr/bin:/bin" } })).stdout)?.[1] || null;

await releaseCheck({
  name: "antigravity",
  // What the update service has rolled out to everyone; a release still
  // rolling out is not one yet.
  latest: async () => {
    const response = await fetch(UPDATER, { signal: AbortSignal.timeout(30000) });
    const match = /Stable Version:\s*v?([0-9]+\.[0-9]+\.[0-9]+)\.?\s+Rolled out to 100%/.exec(await response.text());
    if (!response.ok || !match) throw new Error("the update service names no release rolled out to everyone");
    return match[1];
  },
  installed: async () => { const found = installedAgy(); return found ? versionOf(found) : null; },
  fetch: async (version, work) => {
    const found = installedAgy();
    if (!found) throw Object.assign(new Error("agy is not installed here, so there is nothing to update a copy of"), { state: "not_installed" });
    const home = path.join(work, "home"), binary = path.join(work, "bin", "agy");
    await fs.mkdir(home, { recursive: true }); await fs.mkdir(path.dirname(binary), { recursive: true });
    await fs.copyFile(await fs.realpath(found), binary); await fs.chmod(binary, 0o755);
    if (await versionOf(binary, home) !== version) await run(binary, ["update"], { cwd: work, timeout: 10 * 60 * 1000, maxBuffer: 1024 * 1024, env: { HOME: home, PATH: "/usr/bin:/bin" } });
    const got = await versionOf(binary, home);
    if (got !== version) throw Object.assign(new Error("agy update gave " + got + ", not " + version), { state: "update_gave_another_release" });
    const archiveSha256 = crypto.createHash("sha256").update(await fs.readFile(binary)).digest("hex");
    return { binary, record: { artifact: "agy update from " + UPDATER, archiveSha256 } };
  },
  native: (candidate, version) => runNative("check-native-antigravity-release.mjs", [candidate.binary, version]),
});
