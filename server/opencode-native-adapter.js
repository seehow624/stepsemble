"use strict";

// OpenCode's native server is an explicit, operator-selected boundary.  Do
// not scan ports, read ~/.opencode, or copy credentials: the caller must give
// Stepsemble a server URL (and, when configured, the server password).  The
// adapter only reads bounded JSON over that URL and exposes mutation methods
// whose response is returned by OpenCode itself.

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const DEFAULT_TIMEOUT_MS = 8_000;
const DEFAULT_MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const DEFAULT_MAX_SESSIONS = 100;
const DEFAULT_MAX_MESSAGES = 200;
const MAX_CURSOR = 512;
const MAX_TEXT = 1_000_000;
const MAX_CHECKPOINTS = 256;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const LOOPBACK = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

class OpenCodeNativeError extends Error {
  constructor(code, message, statusCode = 503, details = {}) {
    super(message);
    this.name = "OpenCodeNativeError";
    this.code = code;
    this.statusCode = statusCode;
    Object.assign(this, details);
  }
}

function cleanText(value, limit = 512) {
  return String(value ?? "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ")
    .slice(0, limit);
}

function validId(value) {
  return typeof value === "string" && ID.test(value);
}

function validCursor(value) {
  return value === null || value === undefined || (typeof value === "string" && value.length <= MAX_CURSOR && !/[\u0000-\u001f\u007f]/.test(value));
}

function normalizeDirectory(value) {
  if (value === null || value === undefined || value === "") return null;
  const directory = String(value).trim();
  if (!directory || directory.length > 4096 || !path.isAbsolute(directory) || /[\u0000-\u001f\u007f]/.test(directory)) return null;
  return path.normalize(directory);
}

function clampCount(value, fallback, maximum) {
  const count = Number(value);
  return Number.isSafeInteger(count) && count > 0 ? Math.min(count, maximum) : fallback;
}

function clone(value) {
  try { return structuredClone(value); } catch { return value; }
}

function sha256(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function normalizeBaseUrl(value, { allowRemote = false } = {}) {
  const raw = String(value || "").trim();
  if (!raw) return { url: null, error: "not_configured" };
  let parsed;
  try { parsed = new URL(raw); } catch { return { url: null, error: "invalid_url" }; }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
    return { url: null, error: "invalid_url" };
  }
  const host = String(parsed.hostname || "").toLowerCase();
  const local = LOOPBACK.has(host);
  if (!local && (!allowRemote || parsed.protocol !== "https:")) return { url: null, error: "remote_url_not_allowed" };
  parsed.pathname = parsed.pathname.replace(/\/+$/, "");
  parsed.search = "";
  parsed.hash = "";
  return { url: parsed.toString().replace(/\/$/, ""), error: null, local };
}

function resolveConfig(env = process.env, overrides = {}) {
  const source = overrides.baseUrl ?? env?.STEPSEMBLE_OPENCODE_SERVER_URL ?? env?.OPENCODE_SERVER_URL ?? "";
  const allowRemote = overrides.allowRemote ?? ["1", "true", "yes", "on"].includes(String(env?.STEPSEMBLE_OPENCODE_ALLOW_REMOTE || "").toLowerCase());
  const normalized = normalizeBaseUrl(source, { allowRemote });
  const username = cleanText(overrides.username ?? env?.STEPSEMBLE_OPENCODE_SERVER_USERNAME ?? env?.OPENCODE_SERVER_USERNAME ?? "opencode", 128) || "opencode";
  const password = String(overrides.password ?? env?.STEPSEMBLE_OPENCODE_SERVER_PASSWORD ?? env?.OPENCODE_SERVER_PASSWORD ?? "");
  const stateFile = overrides.stateFile || env?.STEPSEMBLE_OPENCODE_STATE_FILE || "";
  return Object.freeze({
    baseUrl: normalized.url,
    origin: normalized.url ? new URL(normalized.url).origin : null,
    local: normalized.local === true,
    error: normalized.error,
    allowRemote: !!allowRemote,
    username,
    password,
    stateFile: stateFile ? path.resolve(String(stateFile)) : "",
  });
}

function unwrapList(value, keys = []) {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  for (const key of keys) if (Array.isArray(value[key])) return value[key];
  if (value.data && typeof value.data === "object") return unwrapList(value.data, keys);
  return null;
}

function normalizeSession(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const id = String(value.id ?? value.sessionID ?? value.sessionId ?? "");
  if (!validId(id)) return null;
  const parentID = value.parentID ?? value.parentId ?? null;
  return {
    id,
    parentID: validId(parentID) ? parentID : null,
    title: cleanText(value.title || "", 512),
    projectID: cleanText(value.projectID ?? value.projectId ?? "", 256) || null,
    directory: cleanText(value.directory || "", 2048) || null,
    path: cleanText(value.path || "", 2048) || null,
    agent: cleanText(value.agent || "", 128) || null,
    model: value.model && typeof value.model === "object" ? {
      providerID: cleanText(value.model.providerID ?? value.model.providerId ?? "", 128) || null,
      modelID: cleanText(value.model.modelID ?? value.model.modelId ?? "", 256) || null,
    } : null,
    time: value.time && typeof value.time === "object" ? {
      created: Number.isFinite(Number(value.time.created)) ? Number(value.time.created) : null,
      updated: Number.isFinite(Number(value.time.updated)) ? Number(value.time.updated) : null,
    } : null,
    version: cleanText(value.version || "", 128) || null,
    raw: clone(value),
  };
}

function normalizeMessage(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const info = value.info && typeof value.info === "object" ? value.info : value;
  const id = String(info.id ?? info.messageID ?? info.messageId ?? "");
  const sessionID = String(info.sessionID ?? info.sessionId ?? value.sessionID ?? value.sessionId ?? "");
  if (!validId(id)) return null;
  return {
    id,
    sessionID: validId(sessionID) ? sessionID : null,
    role: cleanText(info.role || "", 32) || null,
    time: info.time && typeof info.time === "object" ? {
      created: Number.isFinite(Number(info.time.created)) ? Number(info.time.created) : null,
      completed: Number.isFinite(Number(info.time.completed)) ? Number(info.time.completed) : null,
    } : null,
    parentID: validId(info.parentID ?? info.parentId) ? (info.parentID ?? info.parentId) : null,
    parts: Array.isArray(value.parts) ? clone(value.parts) : [],
    info: clone(info),
  };
}

function normalizePermission(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const id = String(value.id ?? value.permissionID ?? value.permissionId ?? value.requestID ?? value.requestId ?? "");
  const sessionID = String(value.sessionID ?? value.sessionId ?? "");
  if (!validId(id)) return null;
  return {
    id,
    sessionID: validId(sessionID) ? sessionID : null,
    permission: cleanText(value.permission ?? value.action ?? value.type ?? "", 128) || null,
    pattern: Array.isArray(value.patterns) ? value.patterns.map(item => cleanText(item, 1024)).slice(0, 32) : cleanText(value.pattern || "", 1024) || null,
    title: cleanText(value.title || value.reason || "", 1024),
    metadata: value.metadata && typeof value.metadata === "object" ? clone(value.metadata) : {},
    time: value.time && typeof value.time === "object" ? clone(value.time) : null,
    raw: clone(value),
  };
}

function normalizeStatusMap(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const source = value.data && typeof value.data === "object" && !Array.isArray(value.data) ? value.data : value;
  const result = {};
  for (const [id, status] of Object.entries(source)) {
    if (!validId(id)) continue;
    if (typeof status === "string") result[id] = { type: cleanText(status, 64) };
    else if (status && typeof status === "object" && !Array.isArray(status)) result[id] = clone(status);
  }
  return result;
}

function readPrivateJson(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch { return null; }
}

function writePrivateJson(file, value) {
  const directory = path.dirname(file);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(directory, 0o700); } catch {}
  const temp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(value)}\n`, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(temp, file);
  try { fs.chmodSync(file, 0o600); } catch {}
}

function createOpenCodeNativeAdapter({
  env = process.env,
  baseUrl,
  username,
  password,
  allowRemote,
  stateFile,
  fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxResponseBytes = DEFAULT_MAX_RESPONSE_BYTES,
  clock = () => Date.now(),
} = {}) {
  const config = resolveConfig(env, { baseUrl, username, password, allowRemote, stateFile });
  const boundedTimeout = Math.max(250, Math.min(Number(timeoutMs) || DEFAULT_TIMEOUT_MS, 60_000));
  const boundedResponse = Math.max(16 * 1024, Math.min(Number(maxResponseBytes) || DEFAULT_MAX_RESPONSE_BYTES, 16 * 1024 * 1024));
  const statePath = config.stateFile;
  let state = {
    state: config.baseUrl ? "configured" : "unconfigured",
    configured: !!config.baseUrl,
    ready: false,
    local: config.local,
    origin: config.origin,
    version: null,
    approvalReady: false,
    lastError: config.error || null,
    checkedAt: null,
    adapter: "opencode-server-v2",
  };
  let refreshPromise = null;

  function status() { return Object.freeze({ ...state }); }

  function requireConfigured() {
    if (!config.baseUrl) throw new OpenCodeNativeError(config.error || "not_configured", "OpenCode native server is not configured", 503);
    if (typeof fetchImpl !== "function") throw new OpenCodeNativeError("fetch_unavailable", "OpenCode native adapter requires fetch", 503);
  }

  function requestUrl(pathname, query) {
    requireConfigured();
    if (!String(pathname || "").startsWith("/")) throw new OpenCodeNativeError("invalid_path", "OpenCode path must be absolute", 400);
    const target = new URL(`${config.baseUrl}${pathname}`);
    if (query && typeof query === "object") {
      for (const [key, value] of Object.entries(query)) {
        if (value === null || value === undefined || value === "") continue;
        target.searchParams.set(key, String(value));
      }
    }
    return target;
  }

  async function readResponse(response) {
    let bytes;
    try {
      if (response && response.body && typeof response.body.getReader === "function") {
        const reader = response.body.getReader();
        const chunks = [];
        let total = 0;
        for (;;) {
          const part = await reader.read();
          if (part.done) break;
          const chunk = Buffer.from(part.value || []);
          total += chunk.length;
          if (total > boundedResponse) {
            try { await reader.cancel(); } catch {}
            throw new OpenCodeNativeError("response_too_large", "OpenCode response exceeded the bounded limit", 502);
          }
          chunks.push(chunk);
        }
        bytes = Buffer.concat(chunks);
      } else if (response && typeof response.arrayBuffer === "function") {
        bytes = Buffer.from(await response.arrayBuffer());
        if (bytes.length > boundedResponse) throw new OpenCodeNativeError("response_too_large", "OpenCode response exceeded the bounded limit", 502);
      } else {
        const text = await response.text();
        bytes = Buffer.from(String(text));
        if (bytes.length > boundedResponse) throw new OpenCodeNativeError("response_too_large", "OpenCode response exceeded the bounded limit", 502);
      }
    } catch (error) {
      if (error instanceof OpenCodeNativeError) throw error;
      throw new OpenCodeNativeError("response_read_failed", "Could not read OpenCode response", 502, { cause: error });
    }
    if (!bytes.length) return null;
    try { return JSON.parse(bytes.toString("utf8")); }
    catch { throw new OpenCodeNativeError("invalid_json", "OpenCode returned invalid JSON", 502); }
  }

  async function request(pathname, { method = "GET", query = null, body = undefined, timeout = boundedTimeout } = {}) {
    const target = requestUrl(pathname, query);
    const headers = { Accept: "application/json" };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (config.password) headers.Authorization = `Basic ${Buffer.from(`${config.username}:${config.password}`).toString("base64")}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(250, Math.min(Number(timeout) || boundedTimeout, 60_000)));
    try {
      const response = await fetchImpl(target, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: controller.signal });
      if (!response || typeof response.status !== "number") throw new OpenCodeNativeError("invalid_response", "OpenCode returned an invalid response", 502);
      const data = await readResponse(response);
      if (!response.ok) {
        throw new OpenCodeNativeError(`upstream_http_${response.status}`, `OpenCode request failed (${response.status})`, response.status >= 500 ? 502 : response.status, { upstreamStatus: response.status });
      }
      return { data, status: response.status, headers: response.headers };
    } catch (error) {
      if (error instanceof OpenCodeNativeError) throw error;
      if (error?.name === "AbortError") throw new OpenCodeNativeError("timeout", "OpenCode request timed out", 504);
      throw new OpenCodeNativeError("unreachable", "OpenCode server is unreachable", 503, { cause: error });
    } finally { clearTimeout(timer); }
  }

  async function health() {
    const result = await request("/global/health");
    const value = result.data;
    if (!value || typeof value !== "object" || Array.isArray(value) || value.healthy !== true) throw new OpenCodeNativeError("health_invalid", "OpenCode health response was not healthy", 502);
    return { healthy: true, version: cleanText(value.version || "", 128) || null };
  }

  async function listSessions({ limit = DEFAULT_MAX_SESSIONS, cursor = null, directory = null } = {}) {
    if (!validCursor(cursor)) throw new OpenCodeNativeError("invalid_cursor", "OpenCode cursor is invalid", 400);
    const safeDirectory = directory === null ? null : normalizeDirectory(directory);
    if (directory !== null && safeDirectory === null) throw new OpenCodeNativeError("invalid_directory", "OpenCode directory is invalid", 400);
    const response = await request("/session", { query: { limit: clampCount(limit, DEFAULT_MAX_SESSIONS, DEFAULT_MAX_SESSIONS), cursor, directory: safeDirectory } });
    const rows = unwrapList(response.data, ["sessions", "items"]);
    if (!rows) throw new OpenCodeNativeError("sessions_invalid", "OpenCode session list was invalid", 502);
    return {
      sessions: rows.slice(0, DEFAULT_MAX_SESSIONS).map(normalizeSession).filter(Boolean),
      nextCursor: response.data && typeof response.data === "object" && !Array.isArray(response.data)
        ? cleanText(response.data.nextCursor ?? response.data.next_cursor ?? null, MAX_CURSOR) || null : null,
    };
  }

  async function getSession(sessionId, { directory = null } = {}) {
    if (!validId(sessionId)) throw new OpenCodeNativeError("invalid_session_id", "OpenCode session id is invalid", 400);
    const safeDirectory = directory === null ? null : normalizeDirectory(directory);
    if (directory !== null && safeDirectory === null) throw new OpenCodeNativeError("invalid_directory", "OpenCode directory is invalid", 400);
    const response = await request(`/session/${encodeURIComponent(sessionId)}`, { query: { directory: safeDirectory } });
    const value = normalizeSession(response.data);
    if (!value) throw new OpenCodeNativeError("session_invalid", "OpenCode session response was invalid", 502);
    return value;
  }

  async function sessionStatus({ directory = null } = {}) {
    const safeDirectory = directory === null ? null : normalizeDirectory(directory);
    if (directory !== null && safeDirectory === null) throw new OpenCodeNativeError("invalid_directory", "OpenCode directory is invalid", 400);
    const response = await request("/session/status", { query: { directory: safeDirectory } });
    return normalizeStatusMap(response.data);
  }

  async function children(sessionId, { directory = null } = {}) {
    if (!validId(sessionId)) throw new OpenCodeNativeError("invalid_session_id", "OpenCode session id is invalid", 400);
    const safeDirectory = directory === null ? null : normalizeDirectory(directory);
    if (directory !== null && safeDirectory === null) throw new OpenCodeNativeError("invalid_directory", "OpenCode directory is invalid", 400);
    const response = await request(`/session/${encodeURIComponent(sessionId)}/children`, { query: { directory: safeDirectory } });
    const rows = unwrapList(response.data, ["children", "sessions", "items"]);
    if (!rows) throw new OpenCodeNativeError("children_invalid", "OpenCode child session response was invalid", 502);
    return rows.slice(0, DEFAULT_MAX_SESSIONS).map(normalizeSession).filter(Boolean);
  }

  async function messages(sessionId, { limit = DEFAULT_MAX_MESSAGES, cursor = null, directory = null } = {}) {
    if (!validId(sessionId)) throw new OpenCodeNativeError("invalid_session_id", "OpenCode session id is invalid", 400);
    if (!validCursor(cursor)) throw new OpenCodeNativeError("invalid_cursor", "OpenCode cursor is invalid", 400);
    const safeDirectory = directory === null ? null : normalizeDirectory(directory);
    if (directory !== null && safeDirectory === null) throw new OpenCodeNativeError("invalid_directory", "OpenCode directory is invalid", 400);
    const response = await request(`/session/${encodeURIComponent(sessionId)}/message`, { query: { limit: clampCount(limit, DEFAULT_MAX_MESSAGES, DEFAULT_MAX_MESSAGES), cursor, directory: safeDirectory } });
    const rows = unwrapList(response.data, ["messages", "items"]);
    if (!rows) throw new OpenCodeNativeError("messages_invalid", "OpenCode message response was invalid", 502);
    return {
      messages: rows.slice(0, DEFAULT_MAX_MESSAGES).map(normalizeMessage).filter(Boolean),
      nextCursor: response.data && typeof response.data === "object" && !Array.isArray(response.data)
        ? cleanText(response.data.nextCursor ?? response.data.next_cursor ?? null, MAX_CURSOR) || null : null,
    };
  }

  async function permissions({ sessionId = null, directory = null } = {}) {
    if (sessionId !== null && !validId(sessionId)) throw new OpenCodeNativeError("invalid_session_id", "OpenCode session id is invalid", 400);
    const safeDirectory = directory === null ? null : normalizeDirectory(directory);
    if (directory !== null && safeDirectory === null) throw new OpenCodeNativeError("invalid_directory", "OpenCode directory is invalid", 400);
    let response;
    try { response = await request("/permission", { query: { directory: safeDirectory } }); }
    catch (error) {
      if (error.code !== "upstream_http_404") throw error;
      try { response = await request("/permission/", { query: { directory: safeDirectory } }); }
      catch (second) {
        if (second.code === "upstream_http_404") return { supported: false, permissions: [] };
        throw second;
      }
    }
    const rows = unwrapList(response.data, ["permissions", "requests", "items"]);
    if (!rows) throw new OpenCodeNativeError("permissions_invalid", "OpenCode permission response was invalid", 502);
    const normalized = rows.map(normalizePermission).filter(Boolean);
    return { supported: true, permissions: sessionId ? normalized.filter(row => row.sessionID === sessionId) : normalized };
  }

  async function respondPermission({ sessionId, permissionId, response: decision, remember = false, directory = null } = {}) {
    if (!validId(sessionId) || !validId(permissionId)) throw new OpenCodeNativeError("invalid_permission_id", "OpenCode permission identity is invalid", 400);
    if (!["once", "always", "reject"].includes(String(decision))) throw new OpenCodeNativeError("invalid_permission_decision", "OpenCode permission decision is invalid", 400);
    const safeDirectory = directory === null ? null : normalizeDirectory(directory);
    if (directory !== null && safeDirectory === null) throw new OpenCodeNativeError("invalid_directory", "OpenCode directory is invalid", 400);
    const body = { response: String(decision), remember: remember === true };
    try {
      const result = await request(`/session/${encodeURIComponent(sessionId)}/permissions/${encodeURIComponent(permissionId)}`, { method: "POST", query: { directory: safeDirectory }, body });
      return { accepted: result.data === undefined || result.data === null ? true : result.data === true || result.data?.ok !== false, endpoint: "session.permission" };
    } catch (error) {
      if (error.code !== "upstream_http_404") throw error;
      const result = await request(`/permission/${encodeURIComponent(permissionId)}/reply`, { method: "POST", query: { directory: safeDirectory }, body });
      return { accepted: result.data === undefined || result.data === null ? true : result.data === true || result.data?.ok !== false, endpoint: "permission.reply" };
    }
  }

  async function createSession({ title = "", parentID = null, directory = null } = {}) {
    const safeTitle = cleanText(title, 512);
    if (parentID !== null && !validId(parentID)) throw new OpenCodeNativeError("invalid_parent_id", "OpenCode parent session id is invalid", 400);
    const safeDirectory = directory === null ? null : normalizeDirectory(directory);
    if (directory !== null && safeDirectory === null) throw new OpenCodeNativeError("invalid_directory", "OpenCode directory is invalid", 400);
    const body = {};
    if (safeTitle) body.title = safeTitle;
    if (parentID) body.parentID = parentID;
    const result = await request("/session", { method: "POST", query: { directory: safeDirectory }, body });
    const session = normalizeSession(result.data);
    if (!session) throw new OpenCodeNativeError("session_invalid", "OpenCode create session response was invalid", 502);
    return session;
  }

  async function sendMessage(sessionId, text, { model = null, agent = null, noReply = false, directory = null } = {}) {
    if (!validId(sessionId)) throw new OpenCodeNativeError("invalid_session_id", "OpenCode session id is invalid", 400);
    const message = String(text ?? "");
    if (!message || message.length > MAX_TEXT) throw new OpenCodeNativeError("invalid_message", "OpenCode message is empty or too large", 400);
    const safeDirectory = directory === null ? null : normalizeDirectory(directory);
    if (directory !== null && safeDirectory === null) throw new OpenCodeNativeError("invalid_directory", "OpenCode directory is invalid", 400);
    const body = { parts: [{ type: "text", text: message }], noReply: noReply === true };
    if (model && typeof model === "object") body.model = clone(model);
    if (agent) body.agent = cleanText(agent, 128);
    // The async prompt endpoint keeps the Web UI responsive while the native
    // server runs its agent loop. Older servers may not expose it, so a 404
    // falls back to the synchronous message endpoint; no other error is
    // retried because a mutation's network outcome is otherwise uncertain.
    try {
      await request(`/session/${encodeURIComponent(sessionId)}/prompt_async`, { method: "POST", query: { directory: safeDirectory }, body });
      return { accepted: true, endpoint: "prompt_async", sessionID: sessionId };
    } catch (error) {
      if (error.code !== "upstream_http_404") throw error;
      const result = await request(`/session/${encodeURIComponent(sessionId)}/message`, { method: "POST", query: { directory: safeDirectory }, body });
      const normalized = normalizeMessage(result.data);
      return normalized || { accepted: true, endpoint: "message", raw: clone(result.data) };
    }
  }

  async function abort(sessionId, { directory = null } = {}) {
    if (!validId(sessionId)) throw new OpenCodeNativeError("invalid_session_id", "OpenCode session id is invalid", 400);
    const safeDirectory = directory === null ? null : normalizeDirectory(directory);
    if (directory !== null && safeDirectory === null) throw new OpenCodeNativeError("invalid_directory", "OpenCode directory is invalid", 400);
    const result = await request(`/session/${encodeURIComponent(sessionId)}/abort`, { method: "POST", query: { directory: safeDirectory } });
    return { aborted: result.data === undefined || result.data === null ? true : result.data === true || result.data?.ok !== false };
  }

  function loadCheckpoints() {
    if (!statePath) return { version: 1, origin: config.origin, sessions: {} };
    const stored = readPrivateJson(statePath);
    if (!stored || stored.version !== 1 || stored.origin !== config.origin || !stored.sessions || typeof stored.sessions !== "object") return { version: 1, origin: config.origin, sessions: {} };
    return { version: 1, origin: config.origin, sessions: stored.sessions };
  }

  function saveCheckpoint(sessionId, snapshot) {
    if (!statePath) return;
    const stored = loadCheckpoints();
    stored.sessions[sessionId] = snapshot;
    const keys = Object.keys(stored.sessions);
    while (keys.length > MAX_CHECKPOINTS) delete stored.sessions[keys.shift()];
    try { writePrivateJson(statePath, stored); } catch { /* checkpoint is an optimization, never authority */ }
  }

  async function reconcile(sessionId, { limit = DEFAULT_MAX_MESSAGES, directory = null } = {}) {
    if (!validId(sessionId)) throw new OpenCodeNativeError("invalid_session_id", "OpenCode session id is invalid", 400);
    const [session, statuses, childRows, messagePage, permissionPage] = await Promise.all([
      getSession(sessionId, { directory }), sessionStatus({ directory }), children(sessionId, { directory }), messages(sessionId, { limit, directory }), permissions({ sessionId, directory }),
    ]);
    const messagesById = messagePage.messages.map(row => ({ id: row.id, time: row.time, role: row.role }));
    const checkpoint = loadCheckpoints().sessions[sessionId] || null;
    const observed = {
      sessionId,
      messageIds: messagesById.map(row => row.id),
      childIds: childRows.map(row => row.id),
      permissionIds: permissionPage.permissions.map(row => row.id),
      status: statuses[sessionId] || null,
      updated: session.time?.updated || null,
      nextCursor: messagePage.nextCursor || null,
      observedAt: clock(),
    };
    const revision = sha256({ ...observed, observedAt: undefined });
    const previous = checkpoint ? { ...checkpoint } : null;
    const previousRevision = previous?.revision || null;
    saveCheckpoint(sessionId, { ...observed, revision });
    return {
      session,
      status: observed.status,
      children: childRows,
      messages: messagePage.messages,
      permissions: permissionPage.permissions,
      nextCursor: messagePage.nextCursor,
      revision,
      changed: previousRevision !== revision,
      restarted: !!previous,
      previousRevision,
      addedMessageIds: messagesById.map(row => row.id).filter(id => !previous?.messageIds?.includes(id)),
      removedMessageIds: (previous?.messageIds || []).filter(id => !messagesById.some(row => row.id === id)),
    };
  }

  async function refresh() {
    if (refreshPromise) return refreshPromise;
    refreshPromise = (async () => {
      if (!config.baseUrl) {
        state = { ...state, state: "unconfigured", configured: false, ready: false, approvalReady: false, lastError: config.error || "not_configured", checkedAt: clock() };
        return status();
      }
      state = { ...state, state: "probing", configured: true, ready: false, approvalReady: false, lastError: null, checkedAt: clock() };
      try {
        const result = await health();
        // A session list probe validates that the advertised native source can
        // actually read history; health alone is not enough to upgrade the UI.
        await listSessions({ limit: 1 });
        // Permission listing is a separate capability. Some older OpenCode
        // servers expose sessions before the permission route; keep native
        // history in that case but do not claim a native approval bridge.
        const permissionProbe = await permissions();
        state = { ...state, state: "ready", ready: true, approvalReady: permissionProbe.supported === true, version: result.version, lastError: null, checkedAt: clock() };
      } catch (error) {
        state = { ...state, state: "degraded", ready: false, approvalReady: false, lastError: cleanText(error.code || "probe_failed", 128), checkedAt: clock() };
      }
      return status();
    })();
    try { return await refreshPromise; }
    finally { refreshPromise = null; }
  }

  function capability() {
    if (state.ready) return {
      mode: "native_api",
      history: "native_readonly",
      subagents: "native_readonly",
      approval: state.approvalReady ? "native_api" : "unavailable",
      session: "native_api",
      source: "opencode-server-v2",
      adapter: state.adapter,
      serverVersion: state.version,
    };
    return {
      mode: "compat",
      history: "canonical_bounded",
      subagents: "unavailable",
      approval: "structured_ack_required",
      session: "cli",
      source: state.configured ? "opencode-server-unverified" : "cli",
      adapter: state.adapter,
      reason: state.lastError || "native_server_not_ready",
    };
  }

  return Object.freeze({
    status,
    capability,
    refresh,
    health,
    listSessions,
    getSession,
    sessionStatus,
    children,
    messages,
    permissions,
    respondPermission,
    createSession,
    sendMessage,
    abort,
    reconcile,
    config: Object.freeze({ ...config, password: undefined }),
  });
}

module.exports = {
  DEFAULT_MAX_MESSAGES,
  DEFAULT_MAX_SESSIONS,
  OpenCodeNativeError,
  createOpenCodeNativeAdapter,
  normalizeBaseUrl,
  normalizeMessage,
  normalizePermission,
  normalizeSession,
  resolveConfig,
};
