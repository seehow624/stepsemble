#!/usr/bin/env node
// Pure release-tag policy shared by the tag workflow and policy tests.
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const CORE = "(?:0|[1-9]\\d*)";
const IDENTIFIER = "[0-9A-Za-z-]+";
const VERSION_RE = new RegExp(`^${CORE}\\.${CORE}\\.${CORE}(?:-${IDENTIFIER}(?:\\.${IDENTIFIER})*)?$`);

function assertVersion(value, label) {
  if (typeof value !== "string" || value !== value.trim() || !VERSION_RE.test(value)) throw new Error(`invalid ${label}`);
  const separator = value.indexOf("-");
  const prerelease = separator < 0 ? undefined : value.slice(separator + 1);
  if (prerelease?.split(".").some(identifier => /^\d+$/.test(identifier) && identifier.length > 1 && identifier.startsWith("0"))) {
    throw new Error(`invalid ${label}`);
  }
  return value;
}

function releasePlan(tag, packageVersion) {
  const version = assertVersion(packageVersion, "package version");
  if (typeof tag !== "string" || tag !== `v${version}`) throw new Error("tag/package version mismatch");
  assertVersion(tag.slice(1), "release tag");
  return { tag, version, prerelease: version.includes("-") };
}

const invokedPath = process.argv[1] && path.resolve(process.argv[1]);
const modulePath = path.resolve(fileURLToPath(import.meta.url));
const canonicalPath = value => {
  try {
    return fs.realpathSync.native(value);
  } catch {
    return value;
  }
};

if (invokedPath && canonicalPath(invokedPath) === canonicalPath(modulePath)) {
  try {
    if (process.argv.length !== 4) throw new Error("usage: release-policy.mjs TAG PACKAGE_VERSION");
    const plan = releasePlan(process.argv[2], process.argv[3]);
    process.stdout.write(`prerelease=${plan.prerelease}\n`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

export { releasePlan };
