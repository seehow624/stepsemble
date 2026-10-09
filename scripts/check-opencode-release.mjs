#!/usr/bin/env node
// Checks the newest stable OpenCode release against what Stepsemble relies on,
// once per release. Installs the official npm package (opencode-ai) and its
// build for this platform into a scratch folder with no install scripts, runs
// scripts/check-native-opencode-release.mjs against that build (a local fake
// model; no account, no paid request) and keeps the verdict in
// ~/.config/stepsemble/opencode-release-checks.json.
//   node scripts/check-opencode-release.mjs [version] [--force]
// Prints one JSON object. action "none": passed; "adapt": a check failed;
// "wait": it could not be checked. Exit 0, 2 or 1.
import fsSync from "node:fs";
import path from "node:path";
import { run, releaseCheck, runNative, searchPath, which } from "./agent-release-lib.mjs";

const PACKAGE = "opencode-ai";
const npm = (...args) => run("npm", args, { timeout: 10 * 60 * 1000, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, PATH: searchPath() } });

await releaseCheck({
  name: "opencode",
  // The latest tag; snapshot, beta and dev builds have tags of their own.
  latest: async () => JSON.parse((await npm("view", PACKAGE, "dist-tags", "--json")).stdout).latest,
  installed: async () => {
    const found = which("opencode");
    return found ? /(\d+\.\d+\.\d+)/.exec((await run(found, ["--version"], { timeout: 20000 })).stdout)?.[1] || null : null;
  },
  fetch: async (version, work) => {
    const spec = PACKAGE + "@" + version;
    const integrity = (await npm("view", spec, "dist.integrity")).stdout.trim() || null;
    await npm("install", "--prefix", work, "--ignore-scripts", "--no-audit", "--no-fund", "--omit=dev", spec);
    const binary = path.join(work, "node_modules", "opencode-" + process.platform + "-" + process.arch, "bin", "opencode");
    if (!fsSync.existsSync(binary)) throw new Error("no OpenCode build for " + process.platform + "-" + process.arch + " in " + spec);
    const printed = (await run(binary, ["--version"], { timeout: 60000 })).stdout.trim();
    if (printed !== version) throw new Error("the build reports " + printed.slice(0, 60));
    return { binary, record: { artifact: spec, integrity } };
  },
  native: (candidate, version) => runNative("check-native-opencode-release.mjs", [candidate.binary, version]),
});
