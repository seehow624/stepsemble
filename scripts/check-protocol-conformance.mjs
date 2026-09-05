#!/usr/bin/env node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temp = await fs.mkdtemp(path.join(os.tmpdir(), "stepsemble-conformance-"));
function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: temp, stdio: "inherit", timeout: 120000 });
    child.on("error", reject);
    child.on("exit", (code, signal) => code === 0 ? resolve() : reject(new Error(`Conformance process failed (${code ?? signal})`)));
  });
}
try {
  for (const file of ["package.json", "package-lock.json", "check.cjs"]) await fs.copyFile(path.join(root, "scripts/protocol-conformance", file), path.join(temp, file));
  const npmCli = process.env.npm_execpath;
  if (process.platform === "win32" && !npmCli) throw new Error("Use npm run check:protocol:conformance on Windows");
  await run(npmCli ? process.execPath : "npm", [...(npmCli ? [npmCli] : []), "ci", "--ignore-scripts", "--no-audit", "--no-fund"]);
  await run(process.execPath, [path.join(temp, "check.cjs"), root]);
} finally {
  // This exact directory was created above; dependencies never reach SMB or production.
  await fs.rm(temp, { recursive: true, force: true });
}
