"use strict";

/**
 * Stepsemble identity and compatibility boundary.
 *
 * Public names moved from Pi Harbor to Stepsemble in v3. Existing installs
 * may still be launched by older service files and may still hold private
 * state under the former directories. Keep every legacy read explicit here;
 * new writes always use Stepsemble names.
 */

const fs = require("node:fs");
const path = require("node:path");

const PRODUCT_NAME = "Stepsemble";
const PRODUCT_ID = "stepsemble";
const ENV_PREFIX = "STEPSEMBLE_";
const LEGACY_ENV_PREFIXES = Object.freeze(["PI_HARBOR_", "PI_WEB_"]);
const BROWSER_COOKIE = "stepsemble";
const LEGACY_BROWSER_COOKIES = Object.freeze(["pi_harbor", "pi_web"]);
const PAIRING_CODE_PREFIX = "STEPSEMBLE3.";
const LEGACY_PAIRING_CODE_PREFIXES = Object.freeze(["PIHARBOR3."]);
const CONFIG_DIRECTORY_NAME = "stepsemble";
const LEGACY_CONFIG_DIRECTORY_NAMES = Object.freeze(["pi-harbor", "pi-web"]);

const PRIVATE_STATE_FILES = Object.freeze([
  "token",
  "tokens.json",
  "onboarding.json",
  "device-trust.json",
  "updater.json",
  "update-state.json",
  "push.json",
  "push-subscriptions.json",
  "provider-cookies.json",
  "agent-tasks.json",
]);

function nonEmptyEnv(env, key) {
  const value = env?.[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

function settingFromEnv(name, env = process.env) {
  const current = nonEmptyEnv(env, `${ENV_PREFIX}${name}`);
  if (current !== undefined) return current;
  for (const prefix of LEGACY_ENV_PREFIXES) {
    const legacy = nonEmptyEnv(env, `${prefix}${name}`);
    if (legacy !== undefined) return legacy;
  }
  return undefined;
}

function copyPrivateFile(source, target) {
  let stat;
  try { stat = fs.lstatSync(source); } catch { return false; }
  if (!stat.isFile() || stat.isSymbolicLink()) return false;
  try {
    fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
  } catch (error) {
    if (error?.code === "EEXIST") return false;
    throw error;
  }
  try { fs.chmodSync(target, 0o600); } catch {}
  return true;
}

function isPlainDirectory(directory) {
  try {
    const stat = fs.lstatSync(directory);
    return stat.isDirectory() && !stat.isSymbolicLink();
  } catch { return false; }
}

function ensurePrivateDirectory(directory) {
  let stat;
  try { stat = fs.lstatSync(directory); }
  catch (error) {
    if (error?.code !== "ENOENT") throw error;
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    stat = fs.lstatSync(directory);
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`Refusing unsafe Stepsemble state directory: ${directory}`);
  }
  try { fs.chmodSync(directory, 0o700); } catch {}
}

function copyTaskSnapshots(sourceDirectory, targetDirectory) {
  if (!isPlainDirectory(sourceDirectory)) return 0;
  let entries;
  try { entries = fs.readdirSync(sourceDirectory, { withFileTypes: true }); } catch { return 0; }
  const snapshots = entries.filter((entry) => entry.isFile() && !entry.isSymbolicLink() && /^[a-zA-Z0-9_-]+\.json$/.test(entry.name));
  if (!snapshots.length) return 0;
  ensurePrivateDirectory(targetDirectory);
  let copied = 0;
  for (const entry of snapshots) {
    if (copyPrivateFile(path.join(sourceDirectory, entry.name), path.join(targetDirectory, entry.name))) copied += 1;
  }
  return copied;
}

/**
 * Copy, never move or delete, former private state into the Stepsemble config
 * directory. This makes a direct source launch safe before the platform
 * installer has migrated service files, and keeps rollback to v2 possible.
 */
function migrateLegacyConfig(appHome, { onMigrate = () => {} } = {}) {
  const configRoot = path.join(appHome, ".config");
  const configDir = path.join(configRoot, CONFIG_DIRECTORY_NAME);
  ensurePrivateDirectory(configDir);

  const migrated = [];
  for (const directoryName of LEGACY_CONFIG_DIRECTORY_NAMES) {
    const legacyDir = path.join(configRoot, directoryName);
    if (!isPlainDirectory(legacyDir)) continue;
    for (const fileName of PRIVATE_STATE_FILES) {
      const target = path.join(configDir, fileName);
      if (fs.existsSync(target)) continue;
      if (copyPrivateFile(path.join(legacyDir, fileName), target)) migrated.push(`${directoryName}/${fileName}`);
    }
    const copiedSnapshots = copyTaskSnapshots(path.join(legacyDir, "agent-tasks"), path.join(configDir, "agent-tasks"));
    if (copiedSnapshots) migrated.push(`${directoryName}/agent-tasks:${copiedSnapshots}`);
  }

  if (migrated.length) onMigrate(Object.freeze([...migrated]));
  return Object.freeze({ configDir, migrated: Object.freeze(migrated) });
}

module.exports = Object.freeze({
  PRODUCT_NAME,
  PRODUCT_ID,
  ENV_PREFIX,
  LEGACY_ENV_PREFIXES,
  BROWSER_COOKIE,
  LEGACY_BROWSER_COOKIES,
  PAIRING_CODE_PREFIX,
  LEGACY_PAIRING_CODE_PREFIXES,
  CONFIG_DIRECTORY_NAME,
  LEGACY_CONFIG_DIRECTORY_NAMES,
  PRIVATE_STATE_FILES,
  settingFromEnv,
  migrateLegacyConfig,
});
