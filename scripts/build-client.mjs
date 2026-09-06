#!/usr/bin/env node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temp = await fs.mkdtemp(path.join(os.tmpdir(), "stepsemble-ts-"));
try {
  const entries = [["client", "client-sdk"], ["native-dialogs", "native-dialogs"], ["lifecycle", "lifecycle"], ["projection", "projection"], ["pi-session", "pi-session"]];
  // npm's local cache and temporary output keep dependency/build files off SMB.
  const npmCli = process.env.npm_execpath;
  if (process.platform === "win32" && !npmCli) throw new Error("Use npm run build:client on Windows");
  const result = spawnSync(npmCli ? process.execPath : "npm", [
    ...(npmCli ? [npmCli] : []),
    "exec", "--yes", "--package=typescript@7.0.2", "--", "tsc",
    "--strict", "--target", "es2022", "--lib", "es2022,dom", "--module", "es2022", "--moduleDetection", "legacy",
    "--newLine", "lf", "--outDir", temp, ...entries.map(([source]) => path.join(root, `client/${source}.ts`)),
  ], { cwd: temp, stdio: "inherit", timeout: 120000 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`TypeScript compilation failed: ${result.status}`);
  const types = spawnSync(npmCli ? process.execPath : "npm", [
    ...(npmCli ? [npmCli] : []), "exec", "--yes", "--package=typescript@7.0.2", "--", "tsc",
    "--strict", "--target", "es2022", "--lib", "es2022,dom", "--module", "es2022", "--moduleDetection", "legacy",
    "--noEmit", path.join(root, "client/contract-type-tests.ts"),
  ], { cwd: temp, stdio: "inherit", timeout: 120000 });
  if (types.error) throw types.error;
  if (types.status !== 0) throw new Error(`Protocol type assertions failed: ${types.status}`);
  for (const [source, target] of entries) {
    const built = await fs.readFile(path.join(temp, `${source}.js`), "utf8");
    const artifact = path.join(root, `public/modules/${target}.js`);
    if (process.argv.includes("--check")) {
      if (built !== await fs.readFile(artifact, "utf8")) throw new Error(`Client artifact ${target} is stale; run npm run build:client`);
    } else await fs.writeFile(artifact, built);
  }
} finally { await fs.rm(temp, { recursive: true, force: true }); }
