"use strict";

// Codex records `imageView` as a local path. Browsers cannot safely consume a
// file:// URL, and accepting a browser-supplied path would turn the transcript
// into an arbitrary-file endpoint. This registry converts only paths already
// observed in authenticated native history into short-lived opaque handles.

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const DEFAULT_TTL_MS = 10 * 60 * 1000;
const DEFAULT_MAX_ENTRIES = 256;
const DEFAULT_MAX_BYTES = 16 * 1024 * 1024;
const TOKEN = /^[A-Za-z0-9_-]{24,96}$/;

function imageMime(buffer) {
  if (!Buffer.isBuffer(buffer)) return null;
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "image/jpeg";
  if (buffer.length >= 6 && ["GIF87a", "GIF89a"].includes(buffer.subarray(0, 6).toString("ascii"))) return "image/gif";
  if (buffer.length >= 12 && buffer.subarray(0, 4).toString("ascii") === "RIFF"
    && buffer.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  return null;
}

function contained(root, filename) {
  return filename === root || filename.startsWith(root + path.sep);
}

function createCodexImagePreviewRegistry({
  roots = [],
  ttlMs = DEFAULT_TTL_MS,
  maxEntries = DEFAULT_MAX_ENTRIES,
  maxBytes = DEFAULT_MAX_BYTES,
  clock = () => Date.now(),
  randomBytes = crypto.randomBytes,
} = {}) {
  const entries = new Map();
  const byKey = new Map();
  const configuredRoots = [...new Set(roots.filter(value => typeof value === "string" && path.isAbsolute(value)))]
    .map(value => { try { return fs.realpathSync.native(value); } catch { return null; } })
    .filter(Boolean);

  function prune(now = clock()) {
    for (const [token, entry] of entries) {
      if (entry.expiresAt > now) continue;
      entries.delete(token);
      if (entry.key) byKey.delete(entry.key);
    }
    while (entries.size > maxEntries) {
      const token = entries.keys().next().value;
      const entry = entries.get(token);
      entries.delete(token);
      if (entry?.key) byKey.delete(entry.key);
    }
  }

  function openObserved(filename) {
    if (typeof filename !== "string" || !path.isAbsolute(filename) || filename.length > 4096
      || /[\u0000-\u001f\u007f]/.test(filename)) return null;
    let real;
    try { real = fs.realpathSync.native(filename); } catch { return null; }
    if (!configuredRoots.some(root => contained(root, real))) return null;
    let fd;
    try {
      fd = fs.openSync(real, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.size < 1 || stat.size > maxBytes) return null;
      const header = Buffer.alloc(Math.min(16, stat.size));
      if (fs.readSync(fd, header, 0, header.length, 0) !== header.length) return null;
      const mimeType = imageMime(header);
      if (!mimeType) return null;
      return { real, size: stat.size, mtimeMs: stat.mtimeMs, ino: stat.ino, mimeType };
    } catch { return null; }
    finally { if (fd !== undefined) { try { fs.closeSync(fd); } catch {} } }
  }

  function register(filename, key = "") {
    const observed = openObserved(filename);
    if (!observed) return null;
    prune();
    const stableKey = typeof key === "string" && key.length <= 1024 ? key : "";
    const currentToken = stableKey ? byKey.get(stableKey) : null;
    const current = currentToken ? entries.get(currentToken) : null;
    if (current && current.real === observed.real && current.size === observed.size
      && current.mtimeMs === observed.mtimeMs && current.ino === observed.ino
      && current.mimeType === observed.mimeType) {
      entries.delete(currentToken);
      entries.set(currentToken, { ...current, expiresAt: clock() + ttlMs });
      return {
        url: `/api/codex/image?token=${encodeURIComponent(currentToken)}`,
        mimeType: observed.mimeType,
        name: path.basename(observed.real).slice(0, 255),
      };
    }
    if (currentToken) entries.delete(currentToken);
    const token = randomBytes(24).toString("base64url");
    entries.set(token, { ...observed, key: stableKey, expiresAt: clock() + ttlMs });
    if (stableKey) byKey.set(stableKey, token);
    prune();
    return {
      url: `/api/codex/image?token=${encodeURIComponent(token)}`,
      mimeType: observed.mimeType,
      name: path.basename(observed.real).slice(0, 255),
    };
  }

  async function read(token) {
    if (typeof token !== "string" || !TOKEN.test(token)) return { status: 404 };
    prune();
    const entry = entries.get(token);
    if (!entry) return { status: 404 };
    // Keep frequently rendered thumbnails alive without allowing an opaque
    // handle to survive indefinitely after the transcript is closed.
    entries.delete(token);
    entries.set(token, { ...entry, expiresAt: clock() + ttlMs });
    const observed = openObserved(entry.real);
    if (!observed || observed.real !== entry.real || observed.size !== entry.size
      || observed.mtimeMs !== entry.mtimeMs || observed.ino !== entry.ino
      || observed.mimeType !== entry.mimeType) {
      entries.delete(token);
      if (entry.key) byKey.delete(entry.key);
      return { status: 410 };
    }
    try {
      const data = await fs.promises.readFile(entry.real);
      if (data.length !== entry.size || imageMime(data.subarray(0, 16)) !== entry.mimeType) {
        entries.delete(token);
        if (entry.key) byKey.delete(entry.key);
        return { status: 410 };
      }
      return { status: 200, data, mimeType: entry.mimeType };
    } catch {
      entries.delete(token);
      if (entry.key) byKey.delete(entry.key);
      return { status: 410 };
    }
  }

  return Object.freeze({ register, read, size: () => entries.size });
}

module.exports = {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_ENTRIES,
  DEFAULT_TTL_MS,
  createCodexImagePreviewRegistry,
  imageMime,
};
