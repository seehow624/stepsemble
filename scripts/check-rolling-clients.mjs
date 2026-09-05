#!/usr/bin/env node
// Real released sources, isolated synthetic Hosts and a fresh browser profile.
// No production endpoint, provider calls, inherited credentials or SMB deps.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runtime = path.join(root, "scripts/browser-test-runtime");
export function cleanEnvironment(home) {
  const env = {};
  for (const key of ["PATH", "Path", "SystemRoot", "SYSTEMROOT", "WINDIR", "TEMP", "TMP", "TMPDIR", "LANG", "LC_ALL"])
    if (process.env[key]) env[key] = process.env[key];
  return { ...env, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: path.join(home, ".config"),
    XDG_CACHE_HOME: path.join(home, ".cache"), PLAYWRIGHT_BROWSERS_PATH: path.join(home, "browsers") };
}
export function validateBrowserLock(manifest, lock) {
  const expected = JSON.stringify({ playwright: "1.63.0" });
  if (manifest.private !== true || JSON.stringify(manifest.dependencies) !== expected || lock.lockfileVersion !== 3
    || JSON.stringify(lock.packages?.[""]?.dependencies) !== expected) throw new Error("Invalid browser test runtime");
  for (const name of ["playwright", "playwright-core"])
    if (lock.packages?.[`node_modules/${name}`]?.version !== "1.63.0") throw new Error("Unpinned browser test runtime");
  for (const [name, pkg] of Object.entries(lock.packages)) {
    if (!name) continue;
    if (!/^node_modules\/(playwright|playwright-core|fsevents)$/.test(name) || pkg.link
      || !pkg.resolved?.startsWith("https://registry.npmjs.org/") || !/^sha512-[A-Za-z0-9+/]{86}==$/.test(pkg.integrity ?? ""))
      throw new Error("Unreviewed browser test dependency");
  }
  return true;
}
export function run(command, args, cwd, env, timeout = 300000) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: "inherit", timeout });
    child.once("error", reject);
    child.once("close", (code, signal) => code === 0 ? resolve() : reject(new Error(`Browser test child failed (${code ?? signal})`)));
  });
}
async function main(updateLock) {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "stepsemble-rolling-runtime-"));
  try {
    const manifest = JSON.parse(await fs.readFile(path.join(runtime, "package.json"), "utf8"));
    await fs.copyFile(path.join(runtime, "package.json"), path.join(temp, "package.json"));
    if (!updateLock) {
      validateBrowserLock(manifest, JSON.parse(await fs.readFile(path.join(runtime, "package-lock.json"), "utf8")));
      await fs.copyFile(path.join(runtime, "package-lock.json"), path.join(temp, "package-lock.json"));
    }
    for (const name of ["user.npmrc", "global.npmrc"]) await fs.writeFile(path.join(temp, name), "", { mode: 0o600 });
    const npmCli = process.env.npm_execpath, env = cleanEnvironment(temp);
    if (process.platform === "win32" && !npmCli) throw new Error("Use npm run test:rolling on Windows");
    await run(npmCli ? process.execPath : "npm", [...(npmCli ? [npmCli] : []), ...(updateLock ? ["install", "--package-lock-only"] : ["ci"]),
      "--ignore-scripts", "--no-audit", "--no-fund", "--registry=https://registry.npmjs.org/", `--userconfig=${path.join(temp, "user.npmrc")}`,
      `--globalconfig=${path.join(temp, "global.npmrc")}`, `--cache=${path.join(temp, "npm-cache")}`], temp, env);
    validateBrowserLock(manifest, JSON.parse(await fs.readFile(path.join(temp, "package-lock.json"), "utf8")));
    if (updateLock) {
      await fs.copyFile(path.join(temp, "package-lock.json"), path.join(runtime, "package-lock.json"));
      console.log("Updated test-only browser lock; review the diff.");
    } else {
      await run(process.execPath, [path.join(temp, "node_modules/playwright/cli.js"), "install", "--only-shell", "chromium"], temp, env);
      await run(process.execPath, [path.join(root, "scripts/rolling-browser-worker.mjs"), temp], root, env);
    }
  } finally { await fs.rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const flags = process.argv.slice(2);
  if (flags.length > 1 || flags.some(flag => flag !== "--update-lock")) throw new Error("Invalid rolling test option");
  await main(flags.includes("--update-lock"));
}
