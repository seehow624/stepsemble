"use strict";

// Hermes sign-in cookies, kept so the assistant stays signed in across a
// restart. Only cookies Hermes itself names are kept, owner-only; the
// password is never stored anywhere.

const fs = require("node:fs");
const path = require("node:path");

const COOKIE_NAME = /^(?:__Host-|__Secure-)?hermes_session_(?:at|rt|provider)$/;
const MAX_VALUE = 8192;

function cleanCookies(value) {
  const out = {};
  if (!value || typeof value !== "object") return out;
  for (const [name, raw] of Object.entries(value)) {
    if (COOKIE_NAME.test(name) && typeof raw === "string" && raw && raw.length <= MAX_VALUE && !/[;\r\n]/.test(raw)) out[name] = raw;
  }
  return out;
}

function createHermesSessionStore({ file } = {}) {
  if (typeof file !== "string" || !path.isAbsolute(file)) throw new TypeError("hermes_session_file_required");
  function read() {
    try {
      const value = JSON.parse(fs.readFileSync(file, "utf8"));
      if (value?.version !== 1 || typeof value.baseUrl !== "string") return null;
      const cookies = cleanCookies(value.cookies);
      if (!Object.keys(cookies).length) return null;
      return { baseUrl: value.baseUrl, installId: typeof value.installId === "string" ? value.installId : "", cookies };
    } catch { return null; }
  }
  function clear() { try { fs.rmSync(file, { force: true }); } catch {} }
  function save({ baseUrl, installId = "", cookies } = {}) {
    const clean = cleanCookies(cookies);
    if (!Object.keys(clean).length || typeof baseUrl !== "string") { clear(); return; }
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
    try {
      fs.writeFileSync(temporary, JSON.stringify({ version: 1, baseUrl, installId: String(installId || ""), cookies: clean }) + "\n", { mode: 0o600 });
      fs.renameSync(temporary, file);
    } finally { try { fs.rmSync(temporary, { force: true }); } catch {} }
  }
  return Object.freeze({ read, save, clear });
}

// Applies a response's Set-Cookie headers to a cookie map. Anything that is
// not one of Hermes' session cookies is ignored.
function applySetCookies(cookies, headers) {
  const next = { ...(cookies || {}) };
  let changed = false;
  for (const line of headers || []) {
    const [pair, ...attributes] = String(line).split(";");
    const index = pair.indexOf("=");
    if (index < 1) continue;
    const name = pair.slice(0, index).trim(), value = pair.slice(index + 1).trim();
    if (!COOKIE_NAME.test(name)) continue;
    const expired = !value || attributes.some(attribute => {
      const at = attribute.indexOf("=");
      const key = (at < 0 ? attribute : attribute.slice(0, at)).trim().toLowerCase();
      const raw = at < 0 ? "" : attribute.slice(at + 1).trim();
      if (key === "max-age") return Number(raw) <= 0;
      if (key === "expires") { const when = Date.parse(raw); return Number.isFinite(when) && when <= Date.now(); }
      return false;
    });
    if (expired) {
      if (name in next) { delete next[name]; changed = true; }
    } else if (next[name] !== value && value.length <= MAX_VALUE && !/[\r\n]/.test(value)) {
      next[name] = value;
      changed = true;
    }
  }
  return { cookies: next, changed };
}

function cookieHeader(cookies) {
  return Object.entries(cookies || {}).map(([name, value]) => `${name}=${value}`).join("; ");
}

module.exports = { createHermesSessionStore, applySetCookies, cookieHeader };
