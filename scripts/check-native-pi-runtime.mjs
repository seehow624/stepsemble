#!/usr/bin/env node
// Test-only pinned runtime in a disposable LOCAL directory, never the user's
// installed Pi or project node_modules. Native execution remains offline with
// a separate allow-listed environment in check-native-pi.mjs.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runtime = path.join(root, "scripts/native-pi-runtime");
export function validateLock(manifest, lock) {
  const dependency = "@earendil-works/pi-coding-agent", expected = { [dependency]: "0.84.2" };
  if (manifest.private !== true || JSON.stringify(manifest.dependencies) !== JSON.stringify(expected)
    || lock.lockfileVersion !== 3 || JSON.stringify(lock.packages?.[""]?.dependencies) !== JSON.stringify(expected)
    || lock.packages?.[`node_modules/${dependency}`]?.version !== "0.84.2") throw new Error("Invalid pinned native test runtime");
  for (const [name, pkg] of Object.entries(lock.packages)) {
    if (!name) continue;
    const reason = !name.startsWith("node_modules/") || name.includes("..") || pkg.link || typeof pkg.version !== "string" ? "entry"
      : typeof pkg.resolved !== "string" || !pkg.resolved.startsWith("https://registry.npmjs.org/") ? "registry"
      : !/^sha512-[A-Za-z0-9+/]{86}==$/.test(pkg.integrity ?? "") ? "integrity" : null;
    if (reason) throw new Error(`Unreviewed native runtime ${reason}: ${name.slice(0, 256)}`);
  }
  return true;
}
async function completeRegistryIntegrity(lock) {
  // Pi's published shrinkwrap omits integrity for six first-party packages.
  // Supplement from the exact public version metadata; never relax CI's hash
  // requirement, float a version, or substitute a different tarball/source.
  for (const pkg of Object.values(lock.packages)) {
    if (!pkg.resolved || pkg.integrity) continue;
    if (!pkg.resolved.startsWith("https://registry.npmjs.org/")) throw new Error("Unreviewed native runtime registry");
    const url = new URL(pkg.resolved), index = url.pathname.indexOf("/-/");
    if (index < 1 || typeof pkg.version !== "string") throw new Error("Invalid native runtime package metadata");
    const name = decodeURIComponent(url.pathname.slice(1, index));
    const response = await fetch(`https://registry.npmjs.org/${encodeURIComponent(name)}/${encodeURIComponent(pkg.version)}`, { redirect: "error", signal: AbortSignal.timeout(15000) });
    if (!response.ok || !response.body) throw new Error("Native runtime metadata unavailable");
    const reader = response.body.getReader(), chunks = []; let bytes = 0;
    try {
      while (true) { const { done, value } = await reader.read(); if (done) break; bytes += value.length;
        if (bytes > 1024 * 1024) { await reader.cancel(); throw new Error("Oversized runtime metadata"); } chunks.push(value); }
    } finally { reader.releaseLock(); }
    const metadata = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (metadata.name !== name || metadata.version !== pkg.version || metadata.dist?.tarball !== pkg.resolved
      || !/^sha512-[A-Za-z0-9+/=]+$/.test(metadata.dist?.integrity ?? "")) throw new Error("Native runtime metadata mismatch");
    pkg.integrity = metadata.dist.integrity;
  }
}
function run(command, args, cwd) {
  return new Promise((resolve, reject) => {
    // An explicit public registry and empty npm configs avoid using a private
    // registry, credentials or arbitrary package install scripts for this probe.
    const env = {};
    for (const key of ["PATH", "Path", "SystemRoot", "SYSTEMROOT", "WINDIR", "TEMP", "TMP", "TMPDIR", "LANG", "LC_ALL"])
      if (process.env[key]) env[key] = process.env[key];
    const child = spawn(command, args, { cwd, env, stdio: "inherit", timeout: 240000 });
    child.on("error", reject);
    child.on("close", (code, signal) => code === 0 ? resolve() : reject(new Error(`Native test process failed (${code ?? signal})`)));
  });
}
export async function main(updateLock = false, auditOnly = false) {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "stepsemble-native-runtime-"));
  try {
    const manifest = JSON.parse(await fs.readFile(path.join(runtime, "package.json"), "utf8"));
    await fs.copyFile(path.join(runtime, "package.json"), path.join(temp, "package.json"));
    if (!updateLock) {
      const lock = JSON.parse(await fs.readFile(path.join(runtime, "package-lock.json"), "utf8"));
      validateLock(manifest, lock);
      await fs.copyFile(path.join(runtime, "package-lock.json"), path.join(temp, "package-lock.json"));
    }
    for (const name of ["user.npmrc", "global.npmrc"]) await fs.writeFile(path.join(temp, name), "", { mode: 0o600 });
    const npmCli = process.env.npm_execpath;
    if (process.platform === "win32" && !npmCli) throw new Error("Use npm run test:native:pi:runtime on Windows");
    await run(npmCli ? process.execPath : "npm", [...(npmCli ? [npmCli] : []), ...(auditOnly ? ["audit", "--audit-level=high"] : updateLock ? ["install", "--package-lock-only"] : ["ci"]),
      "--ignore-scripts", ...(!auditOnly ? ["--no-audit"] : []), "--no-fund", "--registry=https://registry.npmjs.org/", `--userconfig=${path.join(temp, "user.npmrc")}`,
      `--globalconfig=${path.join(temp, "global.npmrc")}`, `--cache=${path.join(temp, "cache")}`], temp);
    if (updateLock) {
      const lock = JSON.parse(await fs.readFile(path.join(temp, "package-lock.json"), "utf8"));
      await completeRegistryIntegrity(lock);
      validateLock(manifest, lock);
      await fs.writeFile(path.join(runtime, "package-lock.json"), JSON.stringify(lock, null, 2) + "\n");
      console.log("Updated test-only native runtime lock; review before running the probe.");
    } else if (!auditOnly) {
      validateLock(manifest, JSON.parse(await fs.readFile(path.join(temp, "package-lock.json"), "utf8")));
      await run(process.execPath, [path.join(root, "scripts/check-native-pi.mjs"), path.join(temp, "node_modules/@earendil-works/pi-coding-agent/dist/cli.js")], temp);
    }
  } finally {
    // Only this exact directory, created above, is removed after owned children close.
    await fs.rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const flags = process.argv.slice(2);
  if (flags.length > 1 || flags.some(flag => !["--update-lock", "--audit"].includes(flag))) throw new Error("Invalid native runtime test option");
  await main(flags.includes("--update-lock"), flags.includes("--audit"));
}
