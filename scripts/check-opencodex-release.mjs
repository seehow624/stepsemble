#!/usr/bin/env node
// The stable gateway in a disposable installation/HOME, through the same
// catalog writer and Claude control adapter as the Host. Never updates a host.
import fs from "node:fs/promises";
import path from "node:path";
import { releaseCheck, run, runNative, root, which } from "./agent-release-lib.mjs";

const spec = version => "@bitkyc08/opencodex@" + version;
await releaseCheck({
  name: "opencodex",
  latest: async () => JSON.parse((await run("npm", ["view", "@bitkyc08/opencodex", "dist-tags", "--json"],
    { cwd: root, timeout: 60000 })).stdout).latest,
  installed: async () => {
    const binary = which("opencodex");
    return binary ? (await run(binary, ["--version"], { cwd: root, timeout: 20000 })).stdout.trim().split(/\s/).at(-1) : null;
  },
  fetch: async (version, work) => {
    const bun = which("bun"), claude = which("claude");
    if (!bun || !claude) throw Object.assign(new Error("Installed Bun and Claude Code are required; no software was installed on the host"), { state: "client_missing" });
    await run("npm", ["install", "--prefix", work, "--ignore-scripts", "--no-audit", "--no-fund", "--package-lock=true", spec(version)],
      { cwd: root, timeout: 10 * 60 * 1000, maxBuffer: 4 * 1024 * 1024 });
    const directory = path.join(work, "node_modules", "@bitkyc08", "opencodex");
    const metadata = JSON.parse(await fs.readFile(path.join(directory, "package.json"), "utf8"));
    if (metadata.version !== version) throw new Error("Candidate version mismatch");
    const lock = JSON.parse(await fs.readFile(path.join(work, "package-lock.json"), "utf8"));
    return { directory, bun, claude, record: { artifact: spec(version), integrity: lock.packages["node_modules/@bitkyc08/opencodex"]?.integrity } };
  },
  native: candidate => runNative("check-native-opencodex-release.mjs", [candidate.directory, candidate.bun, candidate.claude]),
});
