#!/usr/bin/env node
// Checks the newest stable release of an ACP agent (Cline, Kilo Code, Oh My
// Pi) against what Stepsemble relies on, once per release. Installs the
// official npm package into a scratch folder with no install scripts, runs
// scripts/check-native-acp-release.mjs against it (no account, no model
// request) and keeps the verdict in ~/.config/stepsemble/<agent>-release-checks.json.
//   node scripts/check-acp-release.mjs <cline|kilo|omp> [version] [--force]
// Prints one JSON object. action "none": passed; "adapt": a check failed;
// "wait": it could not be checked. Exit 0, 2 or 1.
import fs from "node:fs/promises";
import path from "node:path";
import { run, releaseCheck, runNative, searchPath, which } from "./agent-release-lib.mjs";

const AGENTS = {
  // The npm package's own launcher finds its platform build.
  cline: { package: "cline", command: "cline", launch: directory => [process.execPath, [path.join(directory, "node_modules", "cline", "bin", "cline"), "--acp"]] },
  kilo: { package: "@kilocode/cli", command: "kilo", launch: directory => [path.join(directory, "node_modules", ".bin", "kilo"), ["acp"]] },
  // Oh My Pi's npm build runs on Bun, as it does when installed with Bun.
  omp: { package: "@oh-my-pi/pi-coding-agent", command: "omp", needs: "bun", launch: directory => [path.join(directory, "node_modules", ".bin", "omp"), ["acp"]] },
};
const [agent, ...rest] = process.argv.slice(2);
const definition = AGENTS[agent];
if (!definition) { console.error("Usage: node scripts/check-acp-release.mjs <" + Object.keys(AGENTS).join("|") + "> [version] [--force]"); process.exit(1); }
const npm = (...args) => run("npm", args, { timeout: 10 * 60 * 1000, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, PATH: searchPath() } });

await releaseCheck({
  name: agent,
  argv: rest,
  // The registry's latest tag; nightly, rc and alpha builds have tags of their own.
  latest: async () => JSON.parse((await npm("view", definition.package, "dist-tags", "--json")).stdout).latest,
  installed: async () => {
    const found = which(definition.command);
    return found ? /(\d+\.\d+\.\d+)/.exec((await run(found, ["--version"], { timeout: 20000, env: { ...process.env, PATH: searchPath() } })).stdout)?.[1] || null : null;
  },
  fetch: async (version, work) => {
    if (definition.needs && !which(definition.needs)) throw Object.assign(new Error(definition.needs + " is not installed"), { state: definition.needs + "_missing" });
    const spec = definition.package + "@" + version;
    const integrity = (await npm("view", spec, "dist.integrity")).stdout.trim() || null;
    await npm("install", "--prefix", work, "--ignore-scripts", "--no-audit", "--no-fund", "--omit=dev", spec);
    const manifest = JSON.parse(await fs.readFile(path.join(work, "node_modules", ...definition.package.split("/"), "package.json"), "utf8"));
    if (manifest.version !== version) throw new Error("installed " + manifest.version + " for " + version);
    const [command, args] = definition.launch(work);
    const printed = (await run(command, [...args.filter(arg => arg !== "acp" && arg !== "--acp"), "--version"], { timeout: 60000, env: { ...process.env, PATH: searchPath() } })).stdout;
    if (!printed.includes(version)) throw new Error("the package reports " + printed.trim().slice(0, 80));
    return { command, args, record: { artifact: spec, integrity } };
  },
  native: candidate => runNative("check-native-acp-release.mjs", [agent, candidate.command, ...candidate.args]),
});
