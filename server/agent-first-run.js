"use strict";

// An agent's first run, as Stepsemble sees it: read, never completed for the
// person. Stepsemble reads whether the agent's own first-run pages are done
// and, when they are not, offers the agent's own screen in a terminal, where
// the person chooses (a colour scheme, the terms, whether to share data).
// The only value written here is a folder-trust entry, under the key the
// agent documents, and only when the person asks for it.

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const MAX_FILE_BYTES = 1024 * 1024;

function readJson(file) {
  let stat;
  try { stat = fs.statSync(file); } catch (error) { return { missing: error?.code === "ENOENT", error: true }; }
  if (!stat.isFile() || stat.size > MAX_FILE_BYTES) return { error: true };
  try {
    const text = fs.readFileSync(file, "utf8");
    return { text, value: JSON.parse(text), stat };
  } catch { return { error: true }; }
}

function antigravityDirectory(home) { return path.join(home, ".gemini", "antigravity-cli"); }

// agy writes cache/onboarding.json when its first-run pages (colour scheme,
// then Terms of Service & Data Use) end with Done; agy 1.4.8 starts without
// them when any of these flags is true. This file is agy's own record and
// not a documented setting: when it cannot be read, the state is "unknown"
// and nothing is held back.
function antigravityOnboarding(home) {
  const read = readJson(path.join(antigravityDirectory(home), "cache", "onboarding.json"));
  if (read.missing) return "needed";
  if (read.error) return "unknown";
  const value = read.value;
  if (!value || typeof value !== "object" || Array.isArray(value)) return "unknown";
  return value.onboardingComplete === true || value.consumerOnboardingComplete === true || value.enterpriseOnboardingComplete === true
    ? "complete" : "needed";
}

function realFolder(folder) {
  try { return fs.realpathSync(folder); } catch { return null; }
}

// trustedWorkspaces is agy's documented settings key: "Folders you chose to
// trust when the CLI asked." agy matches a folder exactly, by its real path;
// a parent, a subfolder or a worktree is a folder of its own.
function antigravityTrust(home, folder) {
  const real = realFolder(folder);
  if (!real) return "unknown";
  const read = readJson(path.join(antigravityDirectory(home), "settings.json"));
  if (read.missing) return "untrusted";
  if (read.error || !read.value || typeof read.value !== "object" || Array.isArray(read.value)) return "unknown";
  const list = read.value.trustedWorkspaces;
  if (list === undefined) return "untrusted";
  if (!Array.isArray(list)) return "unknown";
  return list.includes(real) ? "trusted" : "untrusted";
}

function problem(code, statusCode = 409) {
  return Object.assign(new Error(code), { code, statusCode });
}

// Resolve existing files through every symlink, but distinguish a new file
// from a broken link. A broken link is an unreadable setting, never a place
// to create a replacement. Resolve the parent too when only the file is new.
function settingsWriteTarget(file) {
  let entry;
  try { entry = fs.lstatSync(file); }
  catch (error) { if (error?.code !== "ENOENT") throw problem("antigravity_settings_unreadable"); }
  if (entry) {
    if (!entry.isFile() && !entry.isSymbolicLink()) throw problem("antigravity_settings_unreadable");
    try { return { file: fs.realpathSync(file), existed: true }; }
    catch { throw problem("antigravity_settings_unreadable"); }
  }
  try { return { file: path.join(fs.realpathSync(path.dirname(file)), path.basename(file)), existed: false }; }
  catch (error) {
    if (error?.code !== "ENOENT") throw problem("antigravity_settings_unreadable");
    return { file, existed: false };
  }
}

// Adds one folder to agy's trustedWorkspaces, keeping every other key as it
// is. Replace the resolved target in its own directory, preserving symlinks
// and the target's permissions. Recheck identity, content and permissions
// before replacement to detect intervening changes (not a cross-process lock).
function trustAntigravityFolder(home, folder) {
  const real = realFolder(folder);
  if (!real) throw problem("project_folder_unavailable", 400);
  const directory = antigravityDirectory(home), file = path.join(directory, "settings.json");
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const target = settingsWriteTarget(file);
    const read = readJson(target.file);
    if (read.error && (!read.missing || target.existed)) throw problem("antigravity_settings_unreadable");
    const settings = read.missing ? {} : read.value;
    if (!settings || typeof settings !== "object" || Array.isArray(settings)) throw problem("antigravity_settings_unreadable");
    const list = settings.trustedWorkspaces === undefined ? [] : settings.trustedWorkspaces;
    if (!Array.isArray(list) || !list.every(item => typeof item === "string")) throw problem("antigravity_settings_unreadable");
    if (list.includes(real)) return { trusted: true, written: false, folder: real };
    const next = JSON.stringify({ ...settings, trustedWorkspaces: [...list, real] }, null, 2) + "\n";
    const mode = read.missing ? 0o600 : read.stat.mode & 0o777;
    fs.mkdirSync(path.dirname(target.file), { recursive: true, mode: 0o700 });
    const temporary = `${target.file}.${process.pid}.${crypto.randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temporary, next, { mode: 0o600, flag: "wx" });
      // chmod before publication also preserves modes masked by the umask.
      fs.chmodSync(temporary, mode);
      const currentTarget = settingsWriteTarget(file);
      if (currentTarget.file !== target.file || currentTarget.existed !== target.existed) continue;
      const current = readJson(target.file);
      if (read.missing ? !current.missing : current.error || current.text !== read.text
        || current.stat.dev !== read.stat.dev || current.stat.ino !== read.stat.ino || current.stat.mode !== read.stat.mode) continue;
      fs.renameSync(temporary, target.file);
      return { trusted: true, written: true, folder: real };
    } finally { try { fs.unlinkSync(temporary); } catch {} }
  }
  throw problem("antigravity_settings_busy");
}

// What the New session dialog needs to know before an agent starts.
function firstRunStatus(agentId, { home, folder = null } = {}) {
  if (agentId !== "antigravity") return { agentId, onboarding: "not_applicable", trust: null, needed: false };
  const onboarding = antigravityOnboarding(home);
  const trust = folder ? { state: antigravityTrust(home, folder), writable: true, key: "trustedWorkspaces" } : null;
  return { agentId, onboarding, trust, needed: onboarding === "needed" };
}

module.exports = { antigravityOnboarding, antigravityTrust, trustAntigravityFolder, firstRunStatus };
