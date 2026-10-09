"use strict";

// Agents name files on the Host by absolute path, as Codex does
// ("/Users/me/app.py:12"). A browser cannot open such a path, and a path taken
// from the browser must not turn the Host into an arbitrary-file endpoint. A
// path is accepted only when its real location is inside the folders the Host
// may browse; the browser then receives a short-lived opaque handle for that
// one file. Pictures reuse the Codex image previews. Text is served as plain
// text and anything else as a download, so a file is never run as a page of
// this site.

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const DEFAULT_TTL_MS = 10 * 60 * 1000;
const DEFAULT_MAX_ENTRIES = 256;
const DEFAULT_MAX_TEXT_BYTES = 2 * 1024 * 1024;
const TEXT_SAMPLE_BYTES = 64 * 1024;
const MAX_PATH = 4096;
const TOKEN = /^[A-Za-z0-9_-]{24,96}$/;
// "app.py:12", "app.py:12:5" and "app.py#L12" or "#L12-L20" point into a file.
const LOCATION_SUFFIX = /(?::\d+){1,2}$|#L\d+(?:C\d+)?(?:-L?\d+(?:C\d+)?)?$/;
const OPEN_FLAGS = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0);

function candidatePaths(value, home) {
  if (typeof value !== "string") return [];
  let raw = value.trim();
  if (!raw || raw.length > MAX_PATH || /[\u0000-\u001f\u007f]/.test(raw)) return [];
  if (raw === "~" || raw.startsWith("~/") || raw.startsWith("~\\")) {
    if (typeof home !== "string" || !path.isAbsolute(home)) return [];
    raw = path.join(home, raw.slice(1));
  }
  if (!path.isAbsolute(raw)) return [];
  const candidates = [path.normalize(raw)];
  const bare = raw.replace(LOCATION_SUFFIX, "");
  if (bare && bare !== raw && path.isAbsolute(bare)) candidates.push(path.normalize(bare));
  return candidates;
}

// UTF-8 without NUL bytes reads as text. A sample may end inside a character,
// so the decoder is told more may follow.
function looksLikeText(sample) {
  if (sample.includes(0)) return false;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(sample, { stream: true });
    return true;
  } catch { return false; }
}

// RFC 6266 filename with an ASCII fallback for older clients.
function contentDisposition(type, name) {
  const fallback = String(name || "file").replace(/[^\x20-\x7e]|["\\]/g, "_").slice(0, 200) || "file";
  return type + "; filename=\"" + fallback + "\"; filename*=UTF-8''" + encodeURIComponent(String(name || "file").slice(0, 255));
}

function createHostFileLinks({
  isAllowed,
  home = "",
  imagePreviews = null,
  ttlMs = DEFAULT_TTL_MS,
  maxEntries = DEFAULT_MAX_ENTRIES,
  maxTextBytes = DEFAULT_MAX_TEXT_BYTES,
  clock = () => Date.now(),
  randomBytes = crypto.randomBytes,
} = {}) {
  if (typeof isAllowed !== "function") throw new TypeError("isAllowed is required");
  const entries = new Map();

  function prune(now = clock()) {
    for (const [token, entry] of entries) if (entry.expiresAt <= now) entries.delete(token);
    while (entries.size > maxEntries) entries.delete(entries.keys().next().value);
  }

  async function classify(real) {
    let handle;
    try {
      handle = await fs.promises.open(real, OPEN_FLAGS);
      const stat = await handle.stat();
      if (!stat.isFile()) return null;
      let text = false;
      if (stat.size <= maxTextBytes) {
        const sample = Buffer.alloc(Math.min(TEXT_SAMPLE_BYTES, stat.size));
        const { bytesRead } = sample.length ? await handle.read(sample, 0, sample.length, 0) : { bytesRead: 0 };
        text = looksLikeText(sample.subarray(0, bytesRead));
      }
      return { kind: text ? "text" : "file", size: stat.size, mtimeMs: stat.mtimeMs, ino: stat.ino };
    } catch { return null; }
    finally { if (handle) await handle.close().catch(() => {}); }
  }

  // What the path names, or null when it is missing or not the Host's to show.
  async function describe(value) {
    for (const candidate of candidatePaths(value, home)) {
      let real;
      try { real = await fs.promises.realpath(candidate); } catch { continue; }
      if (!isAllowed(real)) return null;
      const name = path.basename(real) || real;
      let stat;
      try { stat = await fs.promises.stat(real); } catch { return null; }
      if (stat.isDirectory()) return { kind: "folder", name, path: real };
      if (!stat.isFile()) return null;
      const image = typeof imagePreviews?.register === "function" ? imagePreviews.register(real, "host-file:" + real) : null;
      if (image?.url) return { kind: "image", name, path: real, size: stat.size, url: image.url, mimeType: image.mimeType };
      const file = await classify(real);
      if (!file) return null;
      prune();
      const token = randomBytes(24).toString("base64url");
      entries.set(token, { real, ...file, expiresAt: clock() + ttlMs });
      prune();
      return { kind: file.kind, name, path: real, size: file.size, url: "/api/host-file?token=" + encodeURIComponent(token) };
    }
    return null;
  }

  // The handle's file, unchanged since it was described, as a stream.
  async function open(token) {
    if (typeof token !== "string" || !TOKEN.test(token)) return { status: 404 };
    prune();
    const entry = entries.get(token);
    if (!entry) return { status: 404 };
    entries.delete(token);
    entries.set(token, { ...entry, expiresAt: clock() + ttlMs });
    let handle;
    try {
      const real = await fs.promises.realpath(entry.real);
      if (real !== entry.real || !isAllowed(real)) throw new Error("moved");
      handle = await fs.promises.open(real, OPEN_FLAGS);
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size !== entry.size || stat.mtimeMs !== entry.mtimeMs || stat.ino !== entry.ino) throw new Error("changed");
      const stream = handle.createReadStream({ autoClose: true });
      handle = null;
      const name = path.basename(real) || "file";
      return {
        status: 200,
        stream,
        size: stat.size,
        headers: {
          "Content-Type": entry.kind === "text" ? "text/plain; charset=utf-8" : "application/octet-stream",
          "Content-Length": String(stat.size),
          "Content-Disposition": contentDisposition(entry.kind === "text" ? "inline" : "attachment", name),
          "Cache-Control": "private, no-store",
          // Shown by itself, the file still cannot run anything on this site.
          "Content-Security-Policy": "sandbox; default-src 'none'",
        },
      };
    } catch {
      entries.delete(token);
      return { status: 410 };
    } finally {
      if (handle) await handle.close().catch(() => {});
    }
  }

  return Object.freeze({ describe, open });
}

module.exports = { createHostFileLinks, candidatePaths, looksLikeText, contentDisposition };
