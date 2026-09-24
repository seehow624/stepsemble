"use strict";
const { writeBounded } = require("./stream-safety");
const zlib = require("node:zlib");

// Long conversations travel as JSON: one opened session can carry hundreds of
// kilobytes of messages, which matters most on a phone over Tailscale. Gzip is
// used for these one-off payloads because it costs a fraction of brotli's CPU
// while JSON still compresses to roughly a quarter of its size.
const JSON_COMPRESSION_MIN_BYTES = 1024;
function acceptsEncoding(header, name) {
  let quality = null;
  for (const part of String(header || "").split(",")) {
    const [rawToken, ...params] = part.split(";");
    const token = rawToken.trim().toLowerCase();
    if (!token) continue;
    let q = 1;
    for (const param of params) {
      const match = /^\s*q\s*=\s*([0-9.]+)\s*$/i.exec(param);
      if (match) q = Number(match[1]);
    }
    if (token === name) quality = Number.isFinite(q) ? q : 1;
    else if (token === "*" && quality === null) quality = Number.isFinite(q) ? q : 1;
  }
  return quality !== null && quality > 0;
}

/**
 * HTTP/SSE primitives shared by Stepsemble's route handlers.
 *
 * Keeping these helpers independent from the route table makes it possible to
 * add route modules without copying security headers, cookie parsing, or body
 * limits. The factory receives the pieces of server state that must stay
 * private to the main process: secure-cookie mode, the browser-token
 * comparator, and an optional peer-credential comparator. Authentication
 * results identify their mode without returning credential material.
 */
function createHttpUtils({
  secureCookie = false,
  browserCookieNames = ["stepsemble", "pi_harbor", "pi_web"],
  isTokenValid = () => false,
  isPeerCredentialValid = () => null,
} = {}) {
  function sseFrame(data, eventName = null, id = null) {
    const lines = [];
    if (eventName) lines.push(`event: ${String(eventName).replace(/[\r\n]/g, "")}`);
    if (id !== null && id !== undefined) lines.push(`id: ${String(id).replace(/[\r\n]/g, "")}`);
    lines.push(`data: ${typeof data === "string" ? data : JSON.stringify(data)}`);
    return lines.join("\n") + "\n\n";
  }

  function trySseWrite(res, payload) {
    return writeBounded(res, payload);
  }

  function send(res, status, body, headers = {}) {
    const securityHeaders = {
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
      "Referrer-Policy": "no-referrer",
      "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Resource-Policy": "same-origin",
      "X-Permitted-Cross-Domain-Policies": "none",
      ...(secureCookie ? { "Strict-Transport-Security": "max-age=31536000; includeSubDomains" } : {}),
      "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
      ...headers,
    };
    if (typeof body === "string" || Buffer.isBuffer(body)) {
      if (!securityHeaders["Content-Type"]) securityHeaders["Content-Type"] = "text/plain; charset=utf-8";
      securityHeaders["Content-Length"] = Buffer.byteLength(body);
    }
    res.writeHead(status, securityHeaders);
    res.end(body);
  }

  function sendJSON(res, status, obj) {
    const payload = JSON.stringify(obj);
    const headers = { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" };
    // `res.req` is the request this response belongs to; a caller without one
    // (tests, internal probes) simply receives the uncompressed payload.
    if (payload.length >= JSON_COMPRESSION_MIN_BYTES && acceptsEncoding(res?.req?.headers?.["accept-encoding"], "gzip")) {
      let gzip = null;
      try { gzip = zlib.gzipSync(payload, { level: 6 }); } catch { gzip = null; }
      if (gzip && gzip.length < payload.length) {
        headers["Content-Encoding"] = "gzip";
        headers.Vary = "Accept-Encoding";
        send(res, status, gzip, headers);
        return;
      }
    }
    send(res, status, payload, headers);
  }

  function getCookie(req, key) {
    const raw = req.headers.cookie || "";
    for (const part of raw.split(";")) {
      const [name, ...value] = part.trim().split("=");
      if (name !== key) continue;
      try { return decodeURIComponent(value.join("=")); } catch { return null; }
    }
    return null;
  }

  function isAuthed(req) {
    return browserCookieNames.some((name) => isTokenValid(getCookie(req, name)));
  }

  function getBearerToken(req) {
    const value = req?.headers?.authorization;
    if (typeof value !== "string" || value.length > 256) return null;
    const match = value.match(/^Bearer ([A-Za-z0-9_-]{64})$/);
    return match ? match[1] : null;
  }

  function authenticate(req) {
    const bearer = getBearerToken(req);
    if (bearer) {
      const peer = isPeerCredentialValid(bearer);
      if (peer && typeof peer === "object") {
        return { mode: "peer", grantId: peer.grantId || null, device: peer.device || null };
      }
    }
    return isAuthed(req) ? { mode: "browser", grantId: null, device: null } : null;
  }

  function readBody(req, limit = 16 * 1024 * 1024) {
    return new Promise((resolve, reject) => {
      let size = 0;
      let settled = false;
      const chunks = [];
      req.on("data", (chunk) => {
        if (settled) return;
        size += chunk.length;
        if (size > limit) {
          settled = true;
          const error = new Error("body too large");
          error.statusCode = 413;
          reject(error);
          req.resume();
          return;
        }
        chunks.push(chunk);
      });
      req.on("end", () => {
        if (!settled) {
          settled = true;
          resolve(Buffer.concat(chunks).toString("utf8"));
        }
      });
      req.on("error", (error) => {
        if (!settled) {
          settled = true;
          reject(error);
        }
      });
    });
  }

  async function readJSON(req, limit) {
    const raw = await readBody(req, limit);
    if (!raw) return {};
    try {
      const value = JSON.parse(raw);
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("JSON object required");
      return value;
    } catch (cause) {
      const error = new Error(cause.message === "JSON object required" ? cause.message : "invalid JSON body");
      error.statusCode = 400;
      throw error;
    }
  }

  return Object.freeze({ sseFrame, trySseWrite, send, sendJSON, getCookie, isAuthed, getBearerToken, authenticate, readBody, readJSON });
}

module.exports = { createHttpUtils };
