"use strict";

// A stand-in for the Hermes 0.21.6 web server, for tests only: /api/status,
// password sign-in with cookies, WebSocket tickets, one JSON-RPC socket with
// events and server→client requests, and the session REST routes the
// assistant reads. Tests steer it through the returned controls; no model is
// ever called.

const crypto = require("node:crypto");
const http = require("node:http");

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const BOT_CHAT = "Bot Chat";

function encodeFrame(data, opcode = 0x1) {
  const payload = Buffer.isBuffer(data) ? data : Buffer.from(String(data));
  let header;
  if (payload.length < 126) header = Buffer.from([0x80 | opcode, payload.length]);
  else if (payload.length < 65536) {
    header = Buffer.alloc(4); header[0] = 0x80 | opcode; header[1] = 126; header.writeUInt16BE(payload.length, 2);
  } else {
    header = Buffer.alloc(10); header[0] = 0x80 | opcode; header[1] = 127; header.writeBigUInt64BE(BigInt(payload.length), 2);
  }
  return Buffer.concat([header, payload]);
}

function frameReader({ onText, onClose, onPing }) {
  let buffer = Buffer.alloc(0), parts = [];
  return chunk => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 2) {
      const fin = (buffer[0] & 0x80) !== 0, opcode = buffer[0] & 0x0f, masked = (buffer[1] & 0x80) !== 0;
      let length = buffer[1] & 0x7f, offset = 2;
      if (length === 126) { if (buffer.length < 4) return; length = buffer.readUInt16BE(2); offset = 4; }
      else if (length === 127) { if (buffer.length < 10) return; length = Number(buffer.readBigUInt64BE(2)); offset = 10; }
      const maskAt = offset;
      if (masked) offset += 4;
      if (buffer.length < offset + length) return;
      const payload = Buffer.from(buffer.subarray(offset, offset + length));
      if (masked) for (let index = 0; index < payload.length; index += 1) payload[index] ^= buffer[maskAt + (index % 4)];
      buffer = buffer.subarray(offset + length);
      if (opcode === 0x8) { onClose(); return; }
      if (opcode === 0x9) { onPing(payload); continue; }
      if (opcode !== 0x1 && opcode !== 0x0) continue;
      parts.push(payload);
      if (fin) { const text = Buffer.concat(parts).toString("utf8"); parts = []; onText(text); }
    }
  };
}

function defaultProfiles() {
  return [
    { name: "default", is_default: true, display_name: "Luna", description: "Personal assistant", model: "gpt-6-luna",
      provider: "openai-codex", ui_meta: { "hermes-bots": { title: "Luna", color: "#5b8def" } } },
    { name: "qa-reviewer", is_default: false, display_name: "", description: "Checks subtitles", model: "deepseek-v4-pro:cloud",
      provider: "ollama", ui_meta: { "hermes-bots": { title: "QA Reviewer" } } },
    { name: "image-artist", is_default: false, display_name: "", description: "Makes covers", model: "deepseek-v4-pro:cloud",
      provider: "ollama", ui_meta: { "hermes-bots": { title: "Image Artist", hidden: true } } },
  ];
}

function cookie(req, name) {
  for (const part of String(req.headers.cookie || "").split(";")) {
    const index = part.indexOf("=");
    if (index > 0 && part.slice(0, index).trim() === name) return part.slice(index + 1).trim();
  }
  return "";
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : {};
}

function createFakeHermesGateway({ authRequired = true, providers = ["basic"], username = "jerome",
  password = "correct horse", version = "0.21.6", installId = "install-fake", profiles = defaultProfiles() } = {}) {
  const state = {
    epoch: crypto.randomBytes(8).toString("hex"), loopbackToken: crypto.randomBytes(24).toString("base64url"),
    accessTokens: new Set(), tickets: new Set(), ticketsIssued: 0, loginAttempts: 0, rateLimitAfter: Infinity,
    rotateNext: false, rejectSockets: false, keepLiveOnResume: true,
    capabilities: [], methods: [], prompts: [], attachments: [], answers: [], patches: [], deletes: [],
    profiles, stored: new Map(), live: new Map(), peers: new Map(), rings: new Map(), seqs: new Map(),
    open: new Map(), sockets: new Set(), next: 0, turn: null,
  };
  const nextId = prefix => `${prefix}-${++state.next}`;
  const preview = row => row.messages.at(-1)?.text?.slice(0, 80) || "";

  function newStored(profile, title, { hidden = false, source = "tui" } = {}) {
    const at = 1_760_000_000 + state.next;
    const row = { id: nextId("st"), profile, title, hidden, source, messages: [], startedAt: at, lastActive: at, unread: false, running: false, inflight: null };
    state.stored.set(row.id, row);
    return row;
  }
  function liveFor(storedId, peer) {
    if (state.keepLiveOnResume) {
      for (const [liveId, owner] of state.live) if (owner === storedId) { state.peers.set(liveId, peer); return liveId; }
    }
    const liveId = nextId("live");
    state.live.set(liveId, storedId);
    state.peers.set(liveId, peer);
    return liveId;
  }
  function emit(liveId, type, payload = {}) {
    const seq = (state.seqs.get(liveId) || 0) + 1;
    state.seqs.set(liveId, seq);
    const params = { type, session_id: liveId, payload, seq };
    const ring = state.rings.get(liveId) || [];
    ring.push(params);
    if (ring.length > 512) ring.shift();
    state.rings.set(liveId, ring);
    state.peers.get(liveId)?.send({ jsonrpc: "2.0", method: "event", params });
  }
  function broadcast(type, payload = {}) {
    for (const peer of state.sockets) peer.send({ jsonrpc: "2.0", method: "event", params: { type, payload } });
  }
  function serverRequest(liveId, method, params = {}) {
    const requestId = `srq-${crypto.randomBytes(6).toString("hex")}`;
    const frame = { jsonrpc: "2.0", id: requestId, method, params: { session_id: liveId, ...params } };
    return new Promise(resolve => {
      const peer = state.peers.get(liveId);
      if (!peer?.answers) { resolve(null); return; }
      state.open.set(requestId, { frame, liveId, resolve });
      peer.send(frame);
    });
  }
  function openRequests(liveId) {
    return [...state.open.values()].filter(entry => entry.liveId === liveId).map(entry => entry.frame);
  }
  function cancelRequests(reason = "timeout") {
    for (const [requestId, entry] of [...state.open]) {
      state.open.delete(requestId);
      emit(entry.liveId, "request.cancel", { id: requestId, method: entry.frame.method, reason });
      entry.resolve(null);
    }
  }
  function roster() {
    return state.profiles.map(profile => {
      const chat = [...state.stored.values()].find(row => row.profile === profile.name && row.title === BOT_CHAT);
      return { path: `/fake/${profile.name}`, skill_count: 3, previous_names: [], ui_meta_revisions: {}, has_avatar: false,
        worker_session: null, last_session: null, ...profile,
        canonical_session: chat ? { id: chat.id, title: BOT_CHAT, root_title: BOT_CHAT, preview: preview(chat), last_active: chat.lastActive } : null };
    });
  }
  async function runTurn(liveId, storedId, text) {
    const row = state.stored.get(storedId);
    const script = state.turn || {};
    state.turn = null;
    const reply = script.reply ?? `Echo: ${text}`;
    row.messages.push({ role: "user", text });
    row.running = true;
    row.inflight = { user: text, assistant: "" };
    emit(liveId, "message.start", {});
    if (script.thinking) emit(liveId, "thinking.delta", { text: script.thinking });
    if (script.tool) {
      emit(liveId, "tool.start", { tool_id: "tool-1", name: script.tool, args_text: "{}" });
      emit(liveId, "tool.complete", { tool_id: "tool-1", name: script.tool, summary: "done" });
    }
    if (script.request) state.answers.push({ method: script.request.method, response: await serverRequest(liveId, script.request.method, script.request.params) });
    if (script.wait) await script.wait;
    for (const piece of reply.match(/.{1,6}/gs) || []) {
      row.inflight.assistant += piece;
      emit(liveId, "message.delta", { text: piece });
      await new Promise(resolve => setImmediate(resolve));
    }
    row.messages.push({ role: "assistant", text: reply });
    row.running = false;
    row.inflight = null;
    row.lastActive += 1;
    emit(liveId, "message.complete", { text: reply });
  }

  function handleRpc(peer, text) {
    let message;
    try { message = JSON.parse(text); } catch { return; }
    if (message.id !== undefined && message.method === undefined) {
      const entry = state.open.get(message.id);
      if (entry) { state.open.delete(message.id); entry.resolve(message); }
      return;
    }
    state.methods.push(message.method);
    const p = message.params || {};
    const reply = result => peer.send({ jsonrpc: "2.0", id: message.id, result });
    const fail = (code, error) => peer.send({ jsonrpc: "2.0", id: message.id, error: { code, message: error } });
    const storedOf = liveId => state.live.get(liveId);
    switch (message.method) {
      case "ping": return reply({ pong: true });
      case "client.capabilities":
        peer.answers = p.server_requests === true;
        state.capabilities.push(peer.answers);
        return reply({ server_requests: ["approval", "clarify", "secret", "sudo"], declines_not_shown: true });
      case "profiles.list": return reply({ profiles: roster(), bot_mode_protocol: true, install_id: installId });
      case "session.list": {
        const rows = [...state.stored.values()].filter(row => row.profile === (p.profile || "default")
          && (!p.title || row.title === p.title) && (p.include_hidden || !row.hidden));
        return reply({ sessions: rows.map(row => ({ id: row.id, title: row.title, preview: preview(row), started_at: row.startedAt,
          message_count: row.messages.length, source: row.source })) });
      }
      case "session.create": {
        const row = newStored(p.profile || "default", "", { hidden: p.hidden === true });
        return reply({ session_id: liveFor(row.id, peer), stored_session_id: row.id });
      }
      case "session.title": {
        const storedId = storedOf(p.session_id);
        if (!storedId) return fail(4001, "session not found");
        state.stored.get(storedId).title = String(p.title || "");
        return reply({ title: p.title });
      }
      case "session.resume": {
        const row = state.stored.get(p.session_id);
        if (!row) return fail(4001, "session not found");
        const liveId = liveFor(row.id, peer);
        return reply({ session_id: liveId, session_key: row.id, messages: row.messages.map(item => ({ ...item })), running: row.running,
          inflight: row.inflight ? { ...row.inflight } : {}, pending_approvals: [], open_requests: openRequests(liveId) });
      }
      case "session.events.since": {
        const last = Number(p.last_seen) || 0;
        const events = (state.rings.get(p.session_id) || []).filter(params => params.seq > last);
        return reply({ events, latest_seq: state.seqs.get(p.session_id) || 0, truncated: false, count: events.length,
          epoch: state.epoch, open_requests: openRequests(p.session_id) });
      }
      case "image.attach_bytes":
        if (!storedOf(p.session_id)) return fail(4001, "session not found");
        state.attachments.push({ kind: "image", name: p.filename, bytes: Buffer.from(String(p.content_base64 || ""), "base64").length });
        return reply({ attached: true, count: 1 });
      case "file.attach":
        if (!storedOf(p.session_id)) return fail(4001, "session not found");
        state.attachments.push({ kind: "file", name: p.name, dataUrl: String(p.data_url || "").slice(0, 40) });
        return reply({ attached: true, ref_text: `@file:uploads/${p.name}` });
      case "prompt.submit": {
        const storedId = storedOf(p.session_id);
        if (!storedId) return fail(4001, "session not found");
        state.prompts.push({ liveId: p.session_id, text: p.text });
        reply({ ok: true });
        void runTurn(p.session_id, storedId, String(p.text || ""));
        return undefined;
      }
      case "session.interrupt": return reply({ ok: true });
      default: return fail(-32601, `Method not found: ${message.method}`);
    }
  }

  const sessionRow = row => ({ id: row.id, title: row.title, preview: preview(row), source: row.source, started_at: row.startedAt,
    last_active: row.lastActive, message_count: row.messages.length, archived: false, unread: row.unread });

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://fake");
    const send = (status, body, headers = {}) => { res.writeHead(status, { "content-type": "application/json", ...headers }); res.end(JSON.stringify(body)); };
    try {
      if (url.pathname === "/api/status" && req.method === "GET") {
        return send(200, { version, auth_required: authRequired, auth_providers: authRequired ? providers : [], install_id: installId, gateway_running: true });
      }
      if (url.pathname === "/" && req.method === "GET") {
        res.writeHead(200, { "content-type": "text/html" });
        return res.end(authRequired ? "<html><body>sign in</body></html>"
          : `<html><script>window.__HERMES_SESSION_TOKEN__="${state.loopbackToken}";</script></html>`);
      }
      if (url.pathname === "/auth/password-login" && req.method === "POST") {
        state.loginAttempts += 1;
        if (state.loginAttempts > state.rateLimitAfter) return send(429, { detail: "Too many login attempts. Try again shortly." });
        const body = await readJson(req);
        if (!providers.includes(body.provider)) return send(404, { detail: "Unknown provider" });
        if (body.username !== username || body.password !== password) return send(401, { detail: "Invalid credentials" });
        const at = `at-${crypto.randomBytes(8).toString("hex")}`;
        state.accessTokens.add(at);
        return send(200, { ok: true, next: "/" }, { "set-cookie": [
          `hermes_session_at=${at}; Max-Age=900; Path=/; HttpOnly; SameSite=lax`,
          `hermes_session_rt=rt-${crypto.randomBytes(8).toString("hex")}; Max-Age=2592000; Path=/; HttpOnly; SameSite=lax`,
          "hermes_session_provider=basic; Max-Age=2592000; Path=/; HttpOnly; SameSite=lax"] });
      }
      if (url.pathname === "/auth/logout" && req.method === "POST") {
        state.accessTokens.delete(cookie(req, "hermes_session_at"));
        res.writeHead(302, { location: "/login", "set-cookie": ["hermes_session_at=; Max-Age=0; Path=/", "hermes_session_rt=; Max-Age=0; Path=/"] });
        return res.end();
      }
      const authed = authRequired ? state.accessTokens.has(cookie(req, "hermes_session_at"))
        : req.headers["x-hermes-session-token"] === state.loopbackToken;
      if (url.pathname.startsWith("/api/") && !authed) return send(401, { error: "unauthenticated", reason: "unauthenticated" });
      const rotated = {};
      if (state.rotateNext && authRequired) {
        state.rotateNext = false;
        state.accessTokens.delete(cookie(req, "hermes_session_at"));
        const at = `at-${crypto.randomBytes(8).toString("hex")}`;
        state.accessTokens.add(at);
        rotated["set-cookie"] = [`hermes_session_at=${at}; Max-Age=900; Path=/; HttpOnly; SameSite=lax`];
      }
      if (url.pathname === "/api/auth/ws-ticket" && req.method === "POST") {
        const ticket = `t-${crypto.randomBytes(12).toString("hex")}`;
        state.tickets.add(ticket);
        state.ticketsIssued += 1;
        return send(200, { ticket, ttl_seconds: 30 }, rotated);
      }
      if (url.pathname === "/api/sessions" && req.method === "GET") {
        const profile = url.searchParams.get("profile") || "default";
        const limit = Number(url.searchParams.get("limit") || 20), offset = Number(url.searchParams.get("offset") || 0);
        const rows = [...state.stored.values()].filter(row => row.profile === profile && !row.hidden).sort((a, b) => b.lastActive - a.lastActive);
        return send(200, { sessions: rows.slice(offset, offset + limit).map(sessionRow), total: rows.length, limit, offset }, rotated);
      }
      if (url.pathname === "/api/sessions/search" && req.method === "GET") {
        const q = String(url.searchParams.get("q") || "").toLowerCase(), profile = url.searchParams.get("profile") || "default";
        const rows = [...state.stored.values()].filter(row => row.profile === profile
          && (row.title.toLowerCase().includes(q) || row.messages.some(item => item.text.toLowerCase().includes(q))));
        return send(200, { results: rows.map(row => ({ ...sessionRow(row), snippet: preview(row) })) }, rotated);
      }
      const match = /^\/api\/sessions\/([^/]+)$/.exec(url.pathname);
      if (match && req.method === "PATCH") {
        const row = state.stored.get(decodeURIComponent(match[1]));
        if (!row) return send(404, { detail: "Session not found" });
        const body = await readJson(req);
        state.patches.push({ id: row.id, ...body });
        if (typeof body.title === "string") row.title = body.title;
        if (body.unread === false) row.unread = false;
        return send(200, { ok: true, title: row.title }, rotated);
      }
      if (match && req.method === "DELETE") {
        const key = decodeURIComponent(match[1]);
        if (!state.stored.delete(key)) return send(404, { detail: "Session not found" });
        state.deletes.push({ id: key, profile: url.searchParams.get("profile") });
        return send(200, { ok: true }, rotated);
      }
      return send(404, { detail: "Not Found" });
    } catch (error) { return send(500, { detail: String(error.message) }); }
  });

  server.on("upgrade", (req, socket) => {
    const url = new URL(req.url, "http://fake");
    const refuse = () => { socket.end("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n"); };
    if (url.pathname !== "/api/ws" || state.rejectSockets) return refuse();
    let protocol = null;
    if (authRequired) {
      const offered = String(req.headers["sec-websocket-protocol"] || "").split(",").map(value => value.trim()).filter(Boolean);
      const carrier = offered.find(value => value.startsWith("hermes-gateway-ticket."));
      const ticket = carrier ? carrier.slice("hermes-gateway-ticket.".length) : url.searchParams.get("ticket") || "";
      if (!ticket || !state.tickets.delete(ticket)) return refuse();
      if (carrier) {
        if (!offered.includes("hermes-gateway-v1")) return refuse();
        protocol = "hermes-gateway-v1";
      }
    } else if (url.searchParams.get("token") !== state.loopbackToken) return refuse();
    const accept = crypto.createHash("sha1").update(String(req.headers["sec-websocket-key"]) + WS_GUID).digest("base64");
    socket.write(["HTTP/1.1 101 Switching Protocols", "Upgrade: websocket", "Connection: Upgrade", `Sec-WebSocket-Accept: ${accept}`,
      ...(protocol ? [`Sec-WebSocket-Protocol: ${protocol}`] : []), "", ""].join("\r\n"));
    const peer = { answers: false, socket, send: value => { if (!socket.destroyed) socket.write(encodeFrame(JSON.stringify(value))); } };
    state.sockets.add(peer);
    const forget = () => state.sockets.delete(peer);
    socket.on("close", forget);
    socket.on("error", forget);
    socket.on("data", frameReader({
      onText: text => handleRpc(peer, text),
      onClose: () => { if (!socket.destroyed) socket.end(encodeFrame(Buffer.alloc(0), 0x8)); },
      onPing: payload => { if (!socket.destroyed) socket.write(encodeFrame(payload, 0xa)); },
    }));
    peer.send({ jsonrpc: "2.0", method: "event", params: { type: "gateway.ready", payload: { replay_epoch: state.epoch, heartbeat: true, change_events: true } } });
    return undefined;
  });

  const api = {
    state, url: null,
    async start() {
      await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
      api.url = `http://127.0.0.1:${server.address().port}`;
      return api.url;
    },
    async close() {
      for (const peer of state.sockets) peer.socket.destroy();
      server.closeAllConnections?.();
      await new Promise(resolve => server.close(resolve));
    },
    setTurn(script) { state.turn = script; },
    dropSockets() { for (const peer of [...state.sockets]) peer.socket.destroy(); },
    expireSessions() { state.accessTokens.clear(); },
    rotateAccessToken() { state.rotateNext = true; },
    forgetLive(storedId) {
      for (const [liveId, owner] of [...state.live]) if (owner === storedId) { state.live.delete(liveId); state.peers.delete(liveId); }
    },
    liveOf(storedId) { for (const [liveId, owner] of state.live) if (owner === storedId) return liveId; return null; },
    addSession(profile, title, options) { return newStored(profile, title, options); },
    storedSessions: () => [...state.stored.values()],
    cancelRequests, emit, broadcast, serverRequest,
  };
  return api;
}

module.exports = { createFakeHermesGateway, BOT_CHAT };
