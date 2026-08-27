"use strict";

/**
 * HTTP/SSE primitives shared by Pi Harbor's route handlers.
 *
 * Keeping these helpers independent from the route table makes it possible to
 * add route modules without copying security headers, cookie parsing, or body
 * limits. The factory receives the two pieces of server state that must stay
 * private to the main process: secure-cookie mode and the token comparator.
 */
function createHttpUtils({ secureCookie = false, isTokenValid = () => false } = {}) {
  function sseFrame(data, eventName = null, id = null) {
    const lines = [];
    if (eventName) lines.push(`event: ${String(eventName).replace(/[\r\n]/g, "")}`);
    if (id !== null && id !== undefined) lines.push(`id: ${String(id).replace(/[\r\n]/g, "")}`);
    lines.push(`data: ${typeof data === "string" ? data : JSON.stringify(data)}`);
    return lines.join("\n") + "\n\n";
  }

  function trySseWrite(res, payload) {
    if (!res || res.destroyed || res.writableEnded) return false;
    try { res.write(payload); return true; } catch { return false; }
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
      "Content-Security-Policy": "default-src 'self'; script-src 'self' https://cdn.jsdelivr.net; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self' https://cdn.jsdelivr.net; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
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
    send(res, status, JSON.stringify(obj), {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    });
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
    return isTokenValid(getCookie(req, "pi_harbor"));
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

  async function readJSON(req) {
    const raw = await readBody(req);
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

  return Object.freeze({ sseFrame, trySseWrite, send, sendJSON, getCookie, isAuthed, readBody, readJSON });
}

module.exports = { createHttpUtils };
