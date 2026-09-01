"use strict";

/**
 * Read-only inventory of the Pi Agent resources a user may want to mirror on
 * another computer: global extensions, global skills, and installed packages.
 *
 * Safety invariants (Phase 1 of resource sync — inventory and diff only):
 * - Everything is read-only; no file under the Pi home is ever written.
 * - Only resource directories and the resource arrays of settings.json are
 *   read. Credentials (auth.json, models.json, tokens) are never opened and
 *   the raw settings file is never returned to a client.
 * - Paths leave this process as display strings relative to the Pi home
 *   ("~/.pi/agent/…"), never as absolute local paths.
 * - Directory scans and hashing are bounded, and symlinks are never followed,
 *   so a link pointing outside the Pi home cannot leak outside content.
 */

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const MAX_ENTRIES_PER_GROUP = 400;
const MAX_FILES_PER_RESOURCE = 300;
const MAX_FILE_HASH_BYTES = 512 * 1024;
const MAX_HASHED_BYTES_PER_RESOURCE = 8 * 1024 * 1024;
const MAX_SKILLMD_BYTES = 64 * 1024;
const MAX_DESCRIPTION_CHARS = 200;
const MAX_SCAN_DEPTH = 8;
const EXTENSION_SUFFIXES = new Set([".ts", ".tsx", ".js", ".mjs", ".cjs"]);
const EXTENSION_INDEX_NAMES = ["index.ts", "index.js", "index.mjs"];

function sortedDirents(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  return entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

function readHead(file, maxBytes) {
  let descriptor;
  try {
    descriptor = fs.openSync(file, "r");
  } catch {
    return "";
  }
  try {
    const size = fs.fstatSync(descriptor).size;
    const buffer = Buffer.alloc(Math.min(maxBytes, size));
    const read = fs.readSync(descriptor, buffer, 0, buffer.length, 0);
    return buffer.toString("utf8", 0, read);
  } catch {
    return "";
  } finally {
    try { fs.closeSync(descriptor); } catch {}
  }
}

function hashFile(file) {
  const hash = crypto.createHash("sha256");
  try {
    hash.update(fs.readFileSync(file));
  } catch {
    return null;
  }
  return hash.digest("hex");
}

function fileSize(file) {
  try { return fs.statSync(file).size; } catch { return null; }
}

function frontmatterValue(block, field) {
  const match = block.match(new RegExp(`^${field}:[ \\t]*([^\\n]*)$`, "mi"));
  if (!match) return "";
  const value = match[1].trim().replace(/^["']+|["']+$/g, "");
  return value.slice(0, MAX_DESCRIPTION_CHARS);
}

function readSkillMeta(file) {
  const head = readHead(file, MAX_SKILLMD_BYTES);
  if (!head.startsWith("---")) return {};
  const end = head.indexOf("\n---", 3);
  if (end < 0) return {};
  const block = head.slice(3, end);
  const meta = {};
  const name = frontmatterValue(block, "name");
  const description = frontmatterValue(block, "description");
  if (name) meta.name = name.slice(0, 64);
  if (description) meta.description = description;
  return meta;
}

/**
 * Hash a directory deterministically: entries are visited in sorted order so
 * two identical trees on different computers produce the same digest. Caps
 * keep a pathological tree from pinning the process; anything past a cap is
 * marked `partial` (drift inside the skipped region is then not detected).
 */
function hashTree(dir) {
  const hash = crypto.createHash("sha256");
  const state = { files: 0, bytes: 0, partial: false };
  const walk = (current, level) => {
    const dirents = sortedDirents(current);
    if (!dirents) {
      state.partial = true;
      return;
    }
    for (const dirent of dirents) {
      if (dirent.isSymbolicLink()) continue;
      const child = path.join(current, dirent.name);
      if (dirent.isDirectory()) {
        if (level >= MAX_SCAN_DEPTH) {
          state.partial = true;
          continue;
        }
        hash.update(`d\0${dirent.name}\0`);
        walk(child, level + 1);
        continue;
      }
      if (!dirent.isFile()) continue;
      state.files += 1;
      const size = fileSize(child);
      if (size === null) {
        state.partial = true;
        continue;
      }
      if (state.files > MAX_FILES_PER_RESOURCE || state.bytes > MAX_HASHED_BYTES_PER_RESOURCE) {
        state.partial = true;
        continue;
      }
      if (size > MAX_FILE_HASH_BYTES) {
        // Deterministic size marker keeps the digest stable across machines,
        // and partial=true tells the client that content drift inside this
        // file is not fully detected.
        hash.update(`b\0${dirent.name}\0big:${size}\0`);
        state.bytes += size;
        state.partial = true;
        continue;
      }
      const digest = hashFile(child);
      if (digest === null) {
        state.partial = true;
        continue;
      }
      state.bytes += size;
      hash.update(`f\0${dirent.name}\0${digest}\0`);
    }
  };
  walk(dir, 0);
  return { hash: hash.digest("hex"), ...state };
}

function displayHomePath(home, absolute) {
  const relative = path.relative(home, absolute);
  if (!relative || relative.startsWith("..")) return "~";
  return `~${path.sep}${relative}`.replaceAll("\\", "/");
}

function fileEntry(file, home, name, withMeta) {
  const entry = {
    name,
    path: displayHomePath(home, file),
    origin: "file",
    hash: hashFile(file),
    bytes: fileSize(file),
  };
  if (withMeta) Object.assign(entry, readSkillMeta(file));
  return entry;
}

function indexEntry(dir, name, home) {
  const tree = hashTree(dir);
  return {
    name,
    path: displayHomePath(home, dir),
    origin: "directory",
    hash: tree.hash,
    bytes: tree.bytes,
    files: tree.files,
    ...(tree.partial ? { partial: true } : {}),
  };
}

function skillEntry(dir, name, home) {
  const tree = hashTree(dir);
  const meta = readSkillMeta(path.join(dir, "SKILL.md"));
  return {
    name: meta.name || name,
    path: displayHomePath(home, dir),
    origin: "directory",
    hash: tree.hash,
    bytes: tree.bytes,
    files: tree.files,
    ...(meta.description ? { description: meta.description } : {}),
    ...(tree.partial ? { partial: true } : {}),
  };
}

/**
 * Scan one resource directory.
 * - mode "extension-files": single-file extension modules (*.ts/*.js/…).
 * - mode "skill-files": root .md skill files (allowed in ~/.pi/agent/skills).
 * - mode "extension-dirs": directories with an index module.
 * - mode "skill-nested": directories holding SKILL.md; when `root` is set the
 *   scan also descends into non-skill directories (Pi discovers skill folders
 *   recursively).
 */
function listResourceEntries({ dir, home, mode, root = false }) {
  const dirents = sortedDirents(dir);
  if (!dirents) return [];
  const entries = [];
  for (const dirent of dirents) {
    if (entries.length >= MAX_ENTRIES_PER_GROUP) break;
    if (dirent.isSymbolicLink()) continue;
    const child = path.join(dir, dirent.name);
    if (dirent.isFile()) {
      if (mode === "extension-files" && EXTENSION_SUFFIXES.has(path.extname(dirent.name))) {
        entries.push(fileEntry(child, home, dirent.name.replace(/\.[^.]+$/, ""), false));
      } else if (mode === "skill-files" && dirent.name.toLowerCase().endsWith(".md")) {
        entries.push(fileEntry(child, home, dirent.name.replace(/\.md$/i, ""), true));
      }
      continue;
    }
    if (!dirent.isDirectory()) continue;
    if (mode === "extension-dirs") {
      const hasIndex = EXTENSION_INDEX_NAMES.some((candidate) => {
        try { return fs.statSync(path.join(child, candidate)).isFile(); } catch { return false; }
      });
      if (hasIndex) entries.push(indexEntry(child, dirent.name, home));
      continue;
    }
    if (mode !== "skill-nested") continue;
    let hasSkillFile = false;
    try { hasSkillFile = fs.statSync(path.join(child, "SKILL.md")).isFile(); } catch { hasSkillFile = false; }
    if (hasSkillFile) {
      entries.push(skillEntry(child, dirent.name, home));
      continue;
    }
    if (root) {
      for (const nested of listResourceEntries({ dir: child, home, mode: "skill-nested" })) {
        if (entries.length >= MAX_ENTRIES_PER_GROUP) break;
        entries.push(nested);
      }
    }
  }
  return entries;
}

function packageInfo(source) {
  const raw = String(source ?? "").trim();
  if (!raw) return null;
  let type = "path";
  let rest = raw;
  if (raw.startsWith("npm:")) { type = "npm"; rest = raw.slice(4); }
  else if (raw.startsWith("git:")) { type = "git"; rest = raw.slice(4); }
  else if (/^(?:https?|ssh):\/\//i.test(raw) || raw.startsWith("git@")) { type = "git"; rest = raw; }
  let ref = "";
  if (type !== "path") {
    const at = rest.lastIndexOf("@");
    if (at > 0) {
      const tail = rest.slice(at + 1);
      if (tail && !tail.includes("/") && !tail.includes(":")) {
        ref = tail;
        rest = rest.slice(0, at);
      }
    }
  }
  return { source: raw, type, name: rest, ref };
}

function resourceArray(settings, key) {
  const value = settings?.[key];
  return Array.isArray(value) ? value : [];
}

function settingsResourceEntries(rawEntries, home) {
  const entries = [];
  for (const raw of rawEntries) {
    if (entries.length >= MAX_ENTRIES_PER_GROUP) break;
    if (typeof raw !== "string" || !raw.trim()) continue;
    const configured = raw.trim();
    const expanded = configured.startsWith("~/")
      ? path.join(home, configured.slice(2))
      : configured;
    const name = path.basename(expanded.replace(/[\\/]+$/, "")) || expanded;
    const entry = { name, path: configured, origin: "settings" };
    if (path.isAbsolute(expanded)) {
      const relative = path.relative(home, expanded);
      if (relative && !relative.startsWith("..")) {
        // Settings paths under the Pi home are hashed so two machines that
        // declare the same relative location can still be compared.
        let stat = null;
        try { stat = fs.statSync(expanded); } catch { stat = null; }
        if (stat?.isFile()) {
          entry.hash = hashFile(expanded);
          entry.bytes = stat.size;
        } else if (stat?.isDirectory()) {
          const tree = hashTree(expanded);
          entry.hash = tree.hash;
          entry.bytes = tree.bytes;
          entry.files = tree.files;
          if (tree.partial) entry.partial = true;
        }
      }
    }
    entries.push(entry);
  }
  return entries;
}

function createPiResourcesService({ home, agentDirName = ".pi", agentsDirName = ".agents" } = {}) {
  if (!home || !path.isAbsolute(home)) throw new Error("pi-resources requires an absolute home");
  const agentDir = path.join(home, agentDirName, "agent");

  function inventory() {
    const warnings = [];
    const extensionsDir = path.join(agentDir, "extensions");
    const piSkillsDir = path.join(agentDir, "skills");
    const agentsSkillsDir = path.join(home, agentsDirName, "skills");
    const settingsFile = path.join(agentDir, "settings.json");

    let settings = null;
    try {
      const parsed = JSON.parse(fs.readFileSync(settingsFile, "utf8"));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) settings = parsed;
    } catch {
      if (fs.existsSync(settingsFile)) warnings.push("settings unreadable");
    }

    // Extensions: single-file modules and index-module directories, plus any
    // extra local paths declared in settings.
    let extensions = [
      ...listResourceEntries({ dir: extensionsDir, home, mode: "extension-files" }),
      ...listResourceEntries({ dir: extensionsDir, home, mode: "extension-dirs" }),
      ...settingsResourceEntries(resourceArray(settings, "extensions"), home),
    ];

    // Skills: the Pi agent skills directory (root .md files allowed), the
    // cross-harness ~/.agents/skills directory (directories only), plus any
    // extra local paths declared in settings.
    const skills = [
      ...listResourceEntries({ dir: piSkillsDir, home, mode: "skill-files" }),
      ...listResourceEntries({ dir: piSkillsDir, home, mode: "skill-nested", root: true }),
      ...listResourceEntries({ dir: agentsSkillsDir, home, mode: "skill-nested" }),
      ...settingsResourceEntries(resourceArray(settings, "skills"), home),
    ];

    // Packages: only the declared sources; nothing is installed or resolved.
    const packages = [];
    for (const raw of resourceArray(settings, "packages")) {
      if (packages.length >= MAX_ENTRIES_PER_GROUP) break;
      const source = typeof raw === "string"
        ? raw.trim()
        : (raw && typeof raw === "object" && typeof raw.source === "string" ? raw.source.trim() : "");
      if (!source) continue;
      const info = packageInfo(source);
      if (info) packages.push(info);
    }

    const capGroup = (entries, label) => {
      if (entries.length > MAX_ENTRIES_PER_GROUP) {
        warnings.push(`${label} truncated`);
        return entries.slice(0, MAX_ENTRIES_PER_GROUP);
      }
      return entries;
    };
    extensions = capGroup(extensions, "extensions");

    return {
      agentDir: "~/.pi/agent",
      groups: { extensions, skills, packages },
      ...(warnings.length ? { warnings } : {}),
    };
  }

  return { inventory };
}

module.exports = { createPiResourcesService };