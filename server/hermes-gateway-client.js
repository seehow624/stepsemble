"use strict";

// The one place that talks to Hermes. REST calls carry the stored sign-in
// cookies (or, on a loopback server without sign-in, the token Hermes puts in
// its own page). One WebSocket carries JSON-RPC both ways: our requests,
// Hermes events, and the questions Hermes asks its client (approval, clarify,
// sudo, secret). A dropped socket is reopened with backoff; a rejected
// sign-in is never retried on its own, because Hermes allows ten attempts a
// minute and a loop would lock the person out.

const { applySetCookies, cookieHeader } = require("./hermes-session-store");

const GATEWAY_PROTOCOL = "hermes-gateway-v1";
const TICKET_PROTOCOL_PREFIX = "hermes-gateway-ticket.";
const DEFAULTS = Object.freeze({
  reconnectDelaysMs: [500, 1000, 2000, 4000, 8000, 15000],
  heldReconnectMaxMs: 60_000,
  idleReconnectBudgetMs: 150_000,
  keepaliveMs: 20_000,
  idleCloseMs: 10 * 60_000,
  requestTimeoutMs: 120_000,
  restTimeoutMs: 30_000,
});
// Hermes asks the window that shows a chat for these. This client never shows
// one, so it declines at once instead of letting the agent wait for a deadline.
const WINDOW_REQUESTS = new Set(["terminal.read", "preview.read", "preview.act", "window.read", "tour"]);
const NOT_SHOWN_CODE = 4404;

class HermesError extends Error {
  constructor(code, message, statusCode = 502) {
    super(message || code);
    this.name = "HermesError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

function errorFromResponse(status, body) {
  const detail = typeof body?.detail === "string" ? body.detail : typeof body?.error === "string" ? body.error : "";
  const message = detail.slice(0, 300);
  if (status === 401) return new HermesError("hermes_signed_out", message || "Sign in to Hermes again", 401);
  if (status === 429) return new HermesError("hermes_rate_limited", message || "Too many sign-in attempts; try again shortly", 429);
  if (status === 404) return new HermesError("hermes_not_found", message || "Hermes could not find that", 404);
  if (status >= 400 && status < 500) return new HermesError("hermes_rejected", message || `Hermes rejected the request (${status})`, 400);
  return new HermesError("hermes_unavailable", message || `Hermes answered ${status}`, 502);
}

async function readJsonResponse(response) {
  const text = await response.text();
  if (!text) return null;
  try { return JSON.parse(text); } catch { return { detail: text.slice(0, 300) }; }
}

function createHermesGatewayClient({ discovery, store, fetchImpl = fetch, WebSocketImpl = globalThis.WebSocket,
  now = Date.now, log = () => {}, options = {} } = {}) {
  const config = { ...DEFAULTS, ...options };
  let session = store.read();
  let loopback = null;
  let socket = null, connecting = null, connection = "idle", epoch = null, lastError = null;
  let nextId = 0, holds = 0, manualClose = false;
  let reconnectTimer = null, keepaliveTimer = null, idleTimer = null, reconnectAttempt = 0, reconnectSince = 0;
  const pending = new Map();
  const eventListeners = new Set(), stateListeners = new Set(), requestListeners = new Set();

  function setConnection(next, error = null) {
    connection = next;
    if (error) lastError = { code: error.code || "hermes_error", message: String(error.message || error).slice(0, 240), at: now() };
    for (const listener of stateListeners) { try { listener({ state: connection, epoch }); } catch {} }
  }

  async function server(refresh = false) {
    const found = await discovery.find({ refresh });
    if (!found) throw new HermesError("hermes_not_running", "Hermes is not running on this computer", 503);
    return found;
  }

  async function timedFetch(url, init, timeoutMs = config.restTimeoutMs) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try { return await fetchImpl(url, { ...init, signal: controller.signal, redirect: "manual" }); }
    catch {
      throw controller.signal.aborted ? new HermesError("hermes_timeout", "Hermes did not answer in time", 504)
        : new HermesError("hermes_unreachable", "Could not reach Hermes", 503);
    } finally { clearTimeout(timer); }
  }

  async function loopbackToken(found) {
    if (loopback?.url === found.url) return loopback.token;
    const response = await timedFetch(new URL("/", found.url), { headers: { accept: "text/html" } });
    const match = /__HERMES_SESSION_TOKEN__\s*=\s*"([A-Za-z0-9_-]{16,256})"/.exec(await response.text());
    if (!match) throw new HermesError("hermes_token_unavailable", "Hermes did not offer a local session token", 502);
    loopback = { url: found.url, token: match[1] };
    return loopback.token;
  }

  async function authHeaders(found) {
    if (!found.status.authRequired) return { "x-hermes-session-token": await loopbackToken(found) };
    if (!session || session.baseUrl !== found.url) throw new HermesError("hermes_signed_out", "Sign in to Hermes", 401);
    return { cookie: cookieHeader(session.cookies) };
  }

  function forgetSession() { session = null; store.clear(); }

  function absorbCookies(response) {
    if (!session || typeof response.headers.getSetCookie !== "function") return;
    const { cookies, changed } = applySetCookies(session.cookies, response.headers.getSetCookie());
    if (!changed) return;
    if (Object.keys(cookies).length) { session = { ...session, cookies }; store.save(session); } else forgetSession();
  }

  function signedOut(error) {
    forgetSession();
    closeSocket();
    setConnection("signed_out", error);
  }

  async function rest(method, pathname, { query = null, body } = {}) {
    const found = await server();
    const headers = { accept: "application/json", ...(await authHeaders(found)) };
    if (body !== undefined) headers["content-type"] = "application/json";
    const url = new URL(pathname, found.url);
    for (const [key, value] of Object.entries(query || {})) {
      if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, String(value));
    }
    const response = await timedFetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    absorbCookies(response);
    const parsed = await readJsonResponse(response);
    if (response.ok) return parsed;
    const error = errorFromResponse(response.status, parsed);
    if (error.code === "hermes_signed_out" && found.status.authRequired) signedOut(error);
    throw error;
  }

  async function status() {
    let found = null;
    try { found = await discovery.find(); } catch {}
    return {
      running: !!found, version: found?.status.version || null, installId: found?.status.installId || "",
      authRequired: found ? found.status.authRequired : null, providers: found?.status.providers || [],
      signedIn: !!found && (!found.status.authRequired || session?.baseUrl === found.url),
      connection, lastError,
    };
  }

  async function login(username, password) {
    const found = await server(true);
    if (!found.status.authRequired) return status();
    if (!found.status.providers.includes("basic")) throw new HermesError("hermes_oauth_only", "This Hermes only accepts OAuth sign-in", 409);
    const response = await timedFetch(new URL("/auth/password-login", found.url), {
      method: "POST", headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ provider: "basic", username: String(username || ""), password: String(password || "") }),
    });
    const parsed = await readJsonResponse(response);
    if (!response.ok) {
      throw response.status === 401 ? new HermesError("hermes_invalid_credentials", "The Hermes username or password is wrong", 401)
        : errorFromResponse(response.status, parsed);
    }
    const { cookies } = applySetCookies({}, typeof response.headers.getSetCookie === "function" ? response.headers.getSetCookie() : []);
    if (!Object.keys(cookies).length) throw new HermesError("hermes_sign_in_failed", "Hermes did not start a session", 502);
    closeSocket();
    session = { baseUrl: found.url, installId: found.status.installId, cookies };
    store.save(session);
    setConnection("idle");
    return status();
  }

  async function logout() {
    const previous = session;
    forgetSession();
    closeSocket();
    setConnection("signed_out");
    if (previous) {
      try { await timedFetch(new URL("/auth/logout", previous.baseUrl), { method: "POST", headers: { cookie: cookieHeader(previous.cookies) } }, 5000); } catch {}
    }
    return status();
  }

  function sendFrame(frame) {
    if (!socket || socket.readyState !== 1) return false;
    try { socket.send(JSON.stringify(frame)); touch(); return true; } catch { return false; }
  }

  function failPending(error) {
    for (const [id, entry] of pending) { clearTimeout(entry.timer); entry.reject(error); pending.delete(id); }
  }

  function rawRequest(ws, method, params, timeoutMs) {
    touch();
    const id = `s${++nextId}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (pending.delete(id)) reject(new HermesError("hermes_timeout", `Hermes did not answer ${method}`, 504));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      try { ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params })); } catch {
        pending.delete(id);
        clearTimeout(timer);
        reject(new HermesError("hermes_disconnected", "The connection to Hermes closed", 502));
      }
    });
  }

  function handleServerRequest(message) {
    const params = message.params && typeof message.params === "object" ? message.params : {};
    const request = Object.freeze({ id: String(message.id), method: message.method,
      sessionId: typeof params.session_id === "string" ? params.session_id : null, params });
    if (WINDOW_REQUESTS.has(request.method)) {
      sendFrame({ jsonrpc: "2.0", id: message.id, error: { code: NOT_SHOWN_CODE, message: "Stepsemble does not show this chat in a Hermes window" } });
      return;
    }
    let claimed = false;
    for (const listener of requestListeners) {
      try { if (listener(request) === true) claimed = true; } catch (error) { log("[hermes] request listener failed:", error?.message); }
    }
    if (!claimed) sendFrame({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: `Stepsemble cannot answer ${request.method}` } });
  }

  function handleFrame(data) {
    let message;
    try { message = JSON.parse(typeof data === "string" ? data : Buffer.from(data).toString("utf8")); } catch { return; }
    if (!message || typeof message !== "object") return;
    if (typeof message.method === "string" && message.id !== undefined && message.id !== null) { handleServerRequest(message); return; }
    if (message.id !== undefined && pending.has(message.id)) {
      const entry = pending.get(message.id);
      pending.delete(message.id);
      clearTimeout(entry.timer);
      if (message.error) {
        const error = new HermesError("hermes_rpc_error", String(message.error.message || "Hermes request failed").slice(0, 300), 502);
        error.rpcCode = message.error.code;
        entry.reject(error);
      } else entry.resolve(message.result ?? null);
      return;
    }
    if (message.method === "event" && message.params && typeof message.params.type === "string") {
      const params = message.params;
      if (params.type === "gateway.ready" && typeof params.payload?.replay_epoch === "string") epoch = params.payload.replay_epoch;
      const event = Object.freeze({ type: params.type, sessionId: typeof params.session_id === "string" ? params.session_id : null,
        seq: Number.isSafeInteger(params.seq) ? params.seq : null,
        payload: params.payload && typeof params.payload === "object" ? params.payload : {} });
      for (const listener of eventListeners) {
        try { listener(event); } catch (error) { log("[hermes] event listener failed:", error?.message); }
      }
    }
  }

  function startKeepalive() {
    stopKeepalive();
    keepaliveTimer = setInterval(() => {
      if (socket?.readyState === 1) rawRequest(socket, "ping", {}, 15_000).catch(() => {});
    }, config.keepaliveMs);
    keepaliveTimer.unref?.();
  }
  function stopKeepalive() { if (keepaliveTimer) clearInterval(keepaliveTimer); keepaliveTimer = null; }

  function touch() {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      idleTimer = null;
      if (holds === 0 && pending.size === 0 && socket) { closeSocket(); setConnection("idle"); } else if (socket) touch();
    }, config.idleCloseMs);
    idleTimer.unref?.();
  }

  function attach(ws) {
    socket = ws;
    ws.addEventListener("message", event => handleFrame(event.data));
    ws.addEventListener("close", () => {
      if (socket !== ws) return;
      socket = null;
      stopKeepalive();
      failPending(new HermesError("hermes_disconnected", "The connection to Hermes closed", 502));
      if (manualClose) return;
      setConnection("retrying", new HermesError("hermes_disconnected", "The connection to Hermes closed", 502));
      scheduleReconnect();
    });
    startKeepalive();
    touch();
  }

  async function openSocket(refresh) {
    const found = await server(refresh);
    const url = new URL("/api/ws", found.url);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    let protocols;
    if (found.status.authRequired) {
      const answer = await rest("POST", "/api/auth/ws-ticket");
      if (typeof answer?.ticket !== "string" || !answer.ticket) throw new HermesError("hermes_ticket_failed", "Hermes did not issue a connection ticket", 502);
      protocols = [GATEWAY_PROTOCOL, TICKET_PROTOCOL_PREFIX + answer.ticket];
    } else {
      url.searchParams.set("token", await loopbackToken(found));
    }
    return await new Promise((resolve, reject) => {
      let ws;
      try { ws = protocols ? new WebSocketImpl(url.href, protocols) : new WebSocketImpl(url.href); } catch {
        reject(new HermesError("hermes_socket_failed", "Could not open a connection to Hermes", 502));
        return;
      }
      let settled = false;
      const fail = () => { if (!settled) { settled = true; reject(new HermesError("hermes_socket_failed", "Hermes refused the connection", 502)); } };
      ws.addEventListener("open", () => { if (!settled) { settled = true; resolve(ws); } });
      ws.addEventListener("error", fail);
      ws.addEventListener("close", fail);
    });
  }

  function connect() {
    if (socket && socket.readyState === 1 && connection === "open") return Promise.resolve(socket);
    if (connecting) return connecting;
    manualClose = false;
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    const refresh = reconnectAttempt > 0;
    setConnection("connecting");
    connecting = (async () => {
      try {
        const ws = await openSocket(refresh);
        attach(ws);
        await rawRequest(ws, "client.capabilities", { server_requests: true }, 15_000).catch(error => log("[hermes] capabilities:", error.message));
        reconnectAttempt = 0;
        reconnectSince = 0;
        setConnection("open");
        return ws;
      } catch (error) {
        if (error.code === "hermes_signed_out") setConnection("signed_out", error);
        else { setConnection("retrying", error); scheduleReconnect(); }
        throw error;
      } finally { connecting = null; }
    })();
    return connecting;
  }

  function scheduleReconnect() {
    if (manualClose || reconnectTimer || connection === "signed_out") return;
    if (!reconnectSince) reconnectSince = now();
    if (holds === 0 && now() - reconnectSince >= config.idleReconnectBudgetMs) { setConnection("stopped"); return; }
    const delays = config.reconnectDelaysMs;
    const base = delays[Math.min(reconnectAttempt, delays.length - 1)];
    const beyond = Math.max(0, reconnectAttempt - delays.length + 1);
    const delay = holds > 0 ? Math.min(config.heldReconnectMaxMs, base * 2 ** beyond) : base;
    reconnectAttempt += 1;
    reconnectTimer = setTimeout(() => { reconnectTimer = null; connect().catch(() => {}); }, delay);
    reconnectTimer.unref?.();
  }

  function closeSocket() {
    manualClose = true;
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    stopKeepalive();
    const ws = socket;
    socket = null;
    failPending(new HermesError("hermes_disconnected", "The connection to Hermes closed", 502));
    if (ws) { try { ws.close(1000); } catch {} }
  }

  async function request(method, params = {}, { timeoutMs = config.requestTimeoutMs } = {}) {
    const ws = await connect();
    return rawRequest(ws, method, params, timeoutMs);
  }

  function hold() {
    holds += 1;
    touch();
    let released = false;
    return () => { if (released) return; released = true; holds = Math.max(0, holds - 1); touch(); };
  }

  function close() {
    closeSocket();
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
    setConnection("idle");
  }

  return Object.freeze({
    status, login, logout, rest, request, connect, hold, close,
    answer: (id, result) => sendFrame({ jsonrpc: "2.0", id, result }),
    decline: (id, code, message) => sendFrame({ jsonrpc: "2.0", id, error: { code, message } }),
    onEvent(listener) { eventListeners.add(listener); return () => eventListeners.delete(listener); },
    onState(listener) { stateListeners.add(listener); return () => stateListeners.delete(listener); },
    onServerRequest(listener) { requestListeners.add(listener); return () => requestListeners.delete(listener); },
    get epoch() { return epoch; },
  });
}

module.exports = { createHermesGatewayClient, HermesError };
