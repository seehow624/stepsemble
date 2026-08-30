#!/usr/bin/env node
/**
 * Keep the buildless release version in one auditable place.  This tool only
 * touches current release constants and cache-busting query strings; the
 * historical CHANGELOG is intentionally not rewritten.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const TEXT_FILES = [
  "server.js",
  "public/app.js",
  "public/index.html",
  "public/manifest.webmanifest",
  "public/sw.js",
  "public/style.css",
  "install.sh",
];

function assertVersion(value) {
  const version = String(value || "").trim().replace(/^v/, "");
  if (!VERSION_RE.test(version)) throw new Error(`expected a semantic version such as 2.2.0, got ${value || "nothing"}`);
  return version;
}

function packagePath() { return path.join(ROOT, "package.json"); }
function packageVersion() {
  try { return assertVersion(JSON.parse(fs.readFileSync(packagePath(), "utf8")).version); }
  catch (error) { throw new Error(`could not read package version: ${error.message}`); }
}

function readText(file) { return fs.readFileSync(path.join(ROOT, file), "utf8"); }
function writeText(file, value) { fs.writeFileSync(path.join(ROOT, file), value, "utf8"); }

function currentVersionValues(version) {
  const checks = [];
  const addMatches = (file, pattern, label) => {
    const text = readText(file);
    for (const match of text.matchAll(pattern)) checks.push({ file, label, value: match[1], index: match.index });
  };
  addMatches("server.js", /const APP_VERSION\s*=\s*["']([^"']+)["']/g, "APP_VERSION");
  addMatches("public/app.js", /const CLIENT_APP_VERSION\s*=\s*["']([^"']+)["']/g, "CLIENT_APP_VERSION");
  addMatches("public/app.js", /\/\* pi-harbor v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/g, "client release comment");
  addMatches("public/index.html", /[?&]v=(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/g, "HTML asset query");
  addMatches("public/index.html", /id="set-app-version">v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)</g, "HTML app version");
  addMatches("public/manifest.webmanifest", /[?&]v=(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/g, "manifest asset query");
  addMatches("public/sw.js", /const CACHE_NAME\s*=\s*["'][^"']*-v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)["']/g, "service-worker cache");
  addMatches("public/sw.js", /[?&]v=(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/g, "service-worker asset query");
  addMatches("public/style.css", /\/\* pi-harbor v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/g, "stylesheet release comment");
  addMatches("install.sh", /Pi Harbor (\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?) installer/g, "installer release label");
  return checks.filter((entry) => entry.value !== version);
}

function check(version = packageVersion()) {
  const expected = assertVersion(version);
  const errors = [];
  let packageValue = "";
  try { packageValue = packageVersion(); } catch (error) { errors.push(error.message); }
  if (packageValue && packageValue !== expected) errors.push(`package.json version is ${packageValue}, expected ${expected}`);
  for (const entry of currentVersionValues(expected)) errors.push(`${entry.file} ${entry.label} is ${entry.value}, expected ${expected}`);
  return { ok: errors.length === 0, version: expected, errors };
}

function replaceTextVersions(file, version) {
  let text = readText(file);
  if (file === "server.js") text = text.replace(/(const APP_VERSION\s*=\s*["'])[^"']+(["'])/, `$1${version}$2`);
  if (file === "public/app.js") {
    text = text.replace(/(const CLIENT_APP_VERSION\s*=\s*["'])[^"']+(["'])/, `$1${version}$2`);
    text = text.replace(/(\/\* pi-harbor v)\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/, `$1${version}`);
  }
  if (file === "public/index.html") {
    text = text.replace(/([?&]v=)\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/g, `$1${version}`);
    text = text.replace(/(id="set-app-version">v)\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/, `$1${version}`);
  }
  if (file === "public/manifest.webmanifest") text = text.replace(/([?&]v=)\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/g, `$1${version}`);
  if (file === "public/sw.js") {
    text = text.replace(/(const CACHE_NAME\s*=\s*["'][^"']*-v)\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/, `$1${version}`);
    text = text.replace(/([?&]v=)\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/g, `$1${version}`);
  }
  if (file === "public/style.css") text = text.replace(/(\/\* pi-harbor v)\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/, `$1${version}`);
  if (file === "install.sh") text = text.replace(/(Pi Harbor )\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?( installer)/, `$1${version}$2`);
  writeText(file, text);
}

function setVersion(version) {
  const expected = assertVersion(version);
  const pkg = JSON.parse(fs.readFileSync(packagePath(), "utf8"));
  pkg.version = expected;
  writeText("package.json", `${JSON.stringify(pkg, null, 2)}\n`);
  for (const file of TEXT_FILES) replaceTextVersions(file, expected);
  const result = check(expected);
  if (!result.ok) throw new Error(result.errors.join("; "));
  return result;
}

function usage() {
  console.error("Usage: node scripts/version.mjs check [version] | set <version> | <version>");
}

const [command, argument] = process.argv.slice(2);
try {
  if (command === "check") {
    const result = check(argument || packageVersion());
    if (!result.ok) { console.error(result.errors.join("\n")); process.exitCode = 1; }
    else console.log(`Pi Harbor version sources are synchronized at ${result.version}`);
  } else if (command === "set") {
    if (!argument) throw new Error("set requires one explicit semver argument");
    console.log(`Updated Pi Harbor version sources to ${setVersion(argument).version}`);
  } else if (command && VERSION_RE.test(command.replace(/^v/, "")) && !argument) {
    console.log(`Updated Pi Harbor version sources to ${setVersion(command).version}`);
  } else {
    usage(); process.exitCode = 2;
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}

export { check, setVersion };
