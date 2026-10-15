# Hermes 助理 第 1a 階段（伺服器端）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 讓 Stepsemble 伺服器能找到本機 Hermes、登入、維持連線，並提供 `/api/assistant/*`：Bot 名單、Bot Chat、送訊息、即時事件、Hermes 的提問（approval／clarify／sudo／secret）、其他對話與推播。

**Architecture:** 五個新模組，每個只做一件事：`hermes-discovery`（找伺服器）→ `hermes-session-store`（登入 cookie）→ `hermes-gateway-client`（唯一跟 Hermes 溝通的地方：REST、WebSocket JSON-RPC、事件、伺服器反向提問、重連）→ `hermes-assistant-service`（Bot Mode 邏輯、事件視窗、提問、推播判斷）→ `hermes-assistant-routes`（HTTP）。`server.js` 只負責接上。所有測試都對著 `test-support/fake-hermes-gateway.cjs` 跑，不碰真的 Hermes。

**Tech Stack:** Node ≥ 22.19（內建 `fetch`、`WebSocket`、`node:test`），CommonJS，零外部依賴。

**對規格的兩處調整（實作前確認的 Hermes 0.21.6 事實）：**

1. Hermes 0.21.6 的 approval／clarify／sudo／secret 是「伺服器對客戶端的 JSON-RPC 請求」（`id: "srq-…"`，客戶端以同一個 id 回 `result`），客戶端連線後必須送 `client.capabilities {server_requests: true}`；撤回時 Hermes 送 `request.cancel` 事件；重連時 `session.resume`／`session.events.since` 回傳 `open_requests`。規格 5.1 的 `*.respond` 方法是舊協定，改用新協定。
2. Bot Chat 以 `follow_profile_config: true` 建立，永遠跟隨 Bot 自己的模型。第 1 階段只顯示模型；改模型移到第 4 階段（改 Bot 的設定）。頭像圖片也移到第 4 階段；第 1 階段用名稱首字與 Bot Mode 的顏色。
3. 事件視窗改成全域一個（最多 2048 筆或 4 MiB），以單一游標餵給 SSE；記憶體上限與規格同級。

---

## 檔案結構

| 檔案 | 動作 | 職責 |
|---|---|---|
| `test-support/fake-hermes-gateway.cjs` | 新增 | 測試用的假 Hermes 0.21.6 |
| `server/hermes-discovery.js` | 新增 | 只在本機位址找 Hermes，讀 `/api/status` |
| `server/hermes-session-store.js` | 新增 | 600 權限保存 Hermes cookie；Set-Cookie 處理 |
| `server/hermes-gateway-client.js` | 新增 | REST、登入、ticket、WebSocket JSON-RPC、事件、反向提問、重連、閒置關閉 |
| `server/hermes-assistant-service.js` | 新增 | Bot 名單、Bot Chat、送訊息、事件視窗、提問、其他對話、推播判斷 |
| `server/hermes-assistant-routes.js` | 新增 | `/api/assistant/*` 與 SSE |
| `server.js` | 修改 | 建立上述物件、分派路由、推播帶 `url` |
| `public/sw.js` | 修改 | 點推播打開 `/assistant.html?...` |
| `package.json` | 修改 | 新增 `check:assistant` 並納入 `check` |
| `test/hermes-discovery.test.js` 等 6 個測試檔 | 新增 | 見各任務 |

---

### Task 1: 假 Hermes 伺服器

**Files:**
- Create: `test-support/fake-hermes-gateway.cjs`

這是測試基礎設施，後面每個任務的測試都會用到它；它本身由 Task 4 起的測試驗證。

- [ ] **Step 1: 建立檔案**

```js
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
```

- [ ] **Step 2: 語法檢查**

Run: `node --check test-support/fake-hermes-gateway.cjs`
Expected: 無輸出、exit 0

- [ ] **Step 3: Commit**

```bash
git add test-support/fake-hermes-gateway.cjs
git commit -m "Add a fake Hermes 0.21.6 gateway for assistant tests"
```

---

### Task 2: 找到本機的 Hermes

**Files:**
- Create: `server/hermes-discovery.js`
- Test: `test/hermes-discovery.test.js`

- [ ] **Step 1: 寫失敗的測試**

```js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { createHermesDiscovery, candidateUrls, isOwnHost, normalizeStatus } = require("../server/hermes-discovery");
const { createFakeHermesGateway } = require("../test-support/fake-hermes-gateway.cjs");

const interfaces = {
  en0: [{ family: "IPv4", internal: false, address: "192.168.1.20" }],
  utun4: [{ family: "IPv4", internal: false, address: "100.79.81.95" }],
  lo0: [{ family: "IPv4", internal: true, address: "127.0.0.1" }],
};

test("only this computer's own addresses are tried, the configured one first", () => {
  assert.deepEqual(candidateUrls({ env: { STEPSEMBLE_HERMES_URL: "http://100.79.81.95:9200/ignored" }, interfaces }),
    ["http://100.79.81.95:9200", "http://127.0.0.1:9119", "http://192.168.1.20:9119", "http://100.79.81.95:9119"]);
  for (const outside of ["http://example.com:9119", "http://10.0.0.9:9119", "ftp://127.0.0.1:9119", "http://user:pw@127.0.0.1:9119"]) {
    assert.equal(candidateUrls({ env: { STEPSEMBLE_HERMES_URL: outside }, interfaces })[0], "http://127.0.0.1:9119", outside);
  }
  assert.equal(isOwnHost("localhost", interfaces), true);
  assert.equal(isOwnHost("[::1]", interfaces), true);
  assert.equal(isOwnHost("100.79.81.95", interfaces), true);
  assert.equal(isOwnHost("8.8.8.8", interfaces), false);
});

test("a status answer must name a version, and its sign-in facts are normalized", () => {
  assert.equal(normalizeStatus({}), null);
  assert.equal(normalizeStatus({ version: "" }), null);
  assert.deepEqual(normalizeStatus({ version: "0.21.6", auth_required: true, auth_providers: ["basic", 7], install_id: "abc", gateway_running: true }),
    { version: "0.21.6", authRequired: true, providers: ["basic"], installId: "abc", gatewayRunning: true });
});

test("discovery finds a running Hermes and remembers it for a while", async t => {
  const fake = createFakeHermesGateway();
  await fake.start();
  t.after(() => fake.close());
  let clock = 1_000, probes = 0;
  const fetchImpl = (url, init) => { probes += 1; return fetch(url, init); };
  const discovery = createHermesDiscovery({ env: { STEPSEMBLE_HERMES_URL: fake.url }, interfaces: () => ({}), fetchImpl, now: () => clock });
  const found = await discovery.find();
  assert.equal(found.url, fake.url);
  assert.equal(found.status.version, "0.21.6");
  assert.equal(found.status.authRequired, true);
  const before = probes;
  await discovery.find();
  assert.equal(probes, before, "answered from memory");
  clock += 31_000;
  await discovery.find();
  assert.ok(probes > before, "asked again after the memory window");
});

test("nothing listening means no Hermes, not an error", async () => {
  const discovery = createHermesDiscovery({ env: {}, interfaces: () => ({}), fetchImpl: async () => { throw new Error("ECONNREFUSED"); } });
  assert.equal(await discovery.find(), null);
});
```

- [ ] **Step 2: 確認失敗**

Run: `node --test test/hermes-discovery.test.js`
Expected: FAIL，`Cannot find module '../server/hermes-discovery'`

- [ ] **Step 3: 實作**

```js
"use strict";

// Finds the Hermes web server that runs on this computer. Only this
// computer's own addresses are ever tried, so a request can never be steered
// at another host, and nothing under ~/.hermes is read: the address comes from
// STEPSEMBLE_HERMES_URL or Hermes' default port on each local address.

const os = require("node:os");

const DEFAULT_PORT = 9119;
const PROBE_TIMEOUT_MS = 2500;
const CACHE_MS = 30_000;
const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1"]);

function ownAddresses(interfaces = os.networkInterfaces()) {
  const out = [];
  for (const rows of Object.values(interfaces || {})) {
    for (const row of rows || []) {
      if (row && row.family === "IPv4" && !row.internal && typeof row.address === "string") out.push(row.address);
    }
  }
  return [...new Set(out)];
}

function isOwnHost(hostname, interfaces) {
  const host = String(hostname || "").replace(/^\[|\]$/g, "").toLowerCase();
  return LOOPBACK.has(host) || ownAddresses(interfaces).includes(host);
}

function candidateUrls({ env = process.env, interfaces = os.networkInterfaces() } = {}) {
  const out = [];
  const configured = String(env.STEPSEMBLE_HERMES_URL || "").trim();
  if (configured) {
    try {
      const url = new URL(configured);
      if ((url.protocol === "http:" || url.protocol === "https:") && !url.username && !url.password && isOwnHost(url.hostname, interfaces)) out.push(url.origin);
    } catch {}
  }
  out.push(`http://127.0.0.1:${DEFAULT_PORT}`);
  for (const address of ownAddresses(interfaces)) out.push(`http://${address}:${DEFAULT_PORT}`);
  return [...new Set(out)];
}

function normalizeStatus(body) {
  if (!body || typeof body !== "object" || typeof body.version !== "string" || !body.version) return null;
  return {
    version: body.version.slice(0, 64),
    authRequired: body.auth_required === true,
    providers: Array.isArray(body.auth_providers) ? body.auth_providers.filter(value => typeof value === "string").slice(0, 16) : [],
    installId: typeof body.install_id === "string" ? body.install_id.slice(0, 128) : "",
    gatewayRunning: body.gateway_running === true,
  };
}

async function probe(baseUrl, fetchImpl) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const response = await fetchImpl(`${baseUrl}/api/status`, { signal: controller.signal, redirect: "error", headers: { accept: "application/json" } });
    if (!response.ok) return null;
    const status = normalizeStatus(await response.json());
    return status ? { url: baseUrl, status } : null;
  } catch { return null; } finally { clearTimeout(timer); }
}

function createHermesDiscovery({ env = process.env, fetchImpl = fetch, interfaces = () => os.networkInterfaces(), now = Date.now, cacheMs = CACHE_MS } = {}) {
  let cached = null, pending = null;
  async function find({ refresh = false } = {}) {
    if (!refresh && cached && now() - cached.at < cacheMs) return cached.value;
    if (pending) return pending;
    pending = (async () => {
      let value = null;
      for (const url of candidateUrls({ env, interfaces: interfaces() })) {
        value = await probe(url, fetchImpl);
        if (value) break;
      }
      cached = { at: now(), value };
      return value;
    })().finally(() => { pending = null; });
    return pending;
  }
  return Object.freeze({ find });
}

module.exports = { createHermesDiscovery, candidateUrls, normalizeStatus, isOwnHost, ownAddresses, DEFAULT_PORT };
```

- [ ] **Step 4: 確認通過**

Run: `node --test test/hermes-discovery.test.js`
Expected: 4 pass, 0 fail

- [ ] **Step 5: Commit**

```bash
git add server/hermes-discovery.js test/hermes-discovery.test.js
git commit -m "Find the local Hermes server without reading its files"
```

---

### Task 3: 保存 Hermes 登入 cookie

**Files:**
- Create: `server/hermes-session-store.js`
- Test: `test/hermes-session-store.test.js`

- [ ] **Step 1: 寫失敗的測試**

```js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createHermesSessionStore, applySetCookies, cookieHeader } = require("../server/hermes-session-store");

test("Hermes sign-in cookies are kept owner-only, and only Hermes' own cookies", t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "stepsemble-hermes-store-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "config", "hermes-session.json");
  const store = createHermesSessionStore({ file });
  assert.equal(store.read(), null);
  store.save({ baseUrl: "http://127.0.0.1:9119", installId: "i-1",
    cookies: { hermes_session_at: "a1", hermes_session_rt: "r1", hermes_session_provider: "basic", other: "x" } });
  if (process.platform !== "win32") assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(createHermesSessionStore({ file }).read(), { baseUrl: "http://127.0.0.1:9119", installId: "i-1",
    cookies: { hermes_session_at: "a1", hermes_session_rt: "r1", hermes_session_provider: "basic" } });
  assert.equal(fs.readFileSync(file, "utf8").includes("other"), false);
  store.save({ baseUrl: "http://127.0.0.1:9119", cookies: {} });
  assert.equal(fs.existsSync(file), false, "an empty jar removes the file");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "{broken");
  assert.equal(store.read(), null, "a damaged file reads as signed out");
});

test("Set-Cookie headers update, rotate and expire the jar", () => {
  let result = applySetCookies({ hermes_session_at: "a1", hermes_session_rt: "r1" },
    ["hermes_session_at=a2; Max-Age=900; Path=/; HttpOnly", "unrelated=1; Path=/"]);
  assert.equal(result.changed, true);
  assert.deepEqual(result.cookies, { hermes_session_at: "a2", hermes_session_rt: "r1" });
  result = applySetCookies(result.cookies, ["hermes_session_at=a2; Max-Age=900"]);
  assert.equal(result.changed, false, "the same value is not a change");
  result = applySetCookies(result.cookies, ["hermes_session_at=; Max-Age=0; Path=/", "hermes_session_rt=r1; Expires=Thu, 01 Jan 1970 00:00:00 GMT"]);
  assert.deepEqual(result.cookies, {});
  assert.deepEqual(applySetCookies({}, ["__Host-hermes_session_at=h1; Secure; Path=/"]).cookies, { "__Host-hermes_session_at": "h1" });
  assert.equal(cookieHeader({ hermes_session_at: "a", hermes_session_rt: "r" }), "hermes_session_at=a; hermes_session_rt=r");
});
```

- [ ] **Step 2: 確認失敗**

Run: `node --test test/hermes-session-store.test.js`
Expected: FAIL，`Cannot find module '../server/hermes-session-store'`

- [ ] **Step 3: 實作**

```js
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
```

- [ ] **Step 4: 確認通過**

Run: `node --test test/hermes-session-store.test.js`
Expected: 2 pass, 0 fail

- [ ] **Step 5: Commit**

```bash
git add server/hermes-session-store.js test/hermes-session-store.test.js
git commit -m "Keep Hermes sign-in cookies owner-only, never the password"
```

---

### Task 4: Hermes 連線客戶端

**Files:**
- Create: `server/hermes-gateway-client.js`
- Test: `test/hermes-gateway-client.test.js`

- [ ] **Step 1: 寫失敗的測試**

```js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createHermesDiscovery } = require("../server/hermes-discovery");
const { createHermesSessionStore } = require("../server/hermes-session-store");
const { createHermesGatewayClient } = require("../server/hermes-gateway-client");
const { createFakeHermesGateway } = require("../test-support/fake-hermes-gateway.cjs");

const PASSWORD = "correct horse";
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, timeoutMs = 4000) {
  const started = Date.now();
  while (!(await check())) {
    if (Date.now() - started > timeoutMs) throw new Error("timed out waiting");
    await sleep(10);
  }
}

async function setup(t, fakeOptions = {}, options = {}) {
  const fake = createFakeHermesGateway(fakeOptions);
  await fake.start();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "stepsemble-hermes-client-"));
  const file = path.join(dir, "hermes-session.json");
  const store = createHermesSessionStore({ file });
  const discovery = createHermesDiscovery({ env: { STEPSEMBLE_HERMES_URL: fake.url }, interfaces: () => ({}) });
  const client = createHermesGatewayClient({ discovery, store,
    options: { reconnectDelaysMs: [20, 40, 80], keepaliveMs: 60_000, idleCloseMs: 60_000, idleReconnectBudgetMs: 3_000, ...options } });
  t.after(async () => { client.close(); await fake.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { fake, client, store, file };
}

test("a wrong password is reported once and nothing is saved", async t => {
  const { fake, client, store } = await setup(t);
  await assert.rejects(client.login("jerome", "nope"), error => error.code === "hermes_invalid_credentials" && error.statusCode === 401);
  assert.equal(store.read(), null);
  assert.equal(fake.state.loginAttempts, 1, "no automatic retry");
  fake.state.rateLimitAfter = 1;
  await assert.rejects(client.login("jerome", PASSWORD), error => error.code === "hermes_rate_limited" && error.statusCode === 429);
  const status = await client.status();
  assert.equal(status.signedIn, false);
  assert.equal(status.authRequired, true);
  assert.equal(status.version, "0.21.6");
});

test("signing in keeps only cookies; requests use a ticketed socket that says it answers questions", async t => {
  const { fake, client, file } = await setup(t);
  assert.equal((await client.login("jerome", PASSWORD)).signedIn, true);
  assert.equal(fs.readFileSync(file, "utf8").includes(PASSWORD), false, "the password is never written");
  const result = await client.request("profiles.list", { include_sessions: true });
  assert.equal(result.profiles[0].display_name, "Luna");
  assert.equal(fake.state.ticketsIssued, 1);
  assert.deepEqual(fake.state.capabilities, [true]);
  assert.equal((await client.status()).connection, "open");
});

test("events carry their session and sequence; Hermes questions can be claimed and answered", async t => {
  const { fake, client } = await setup(t);
  await client.login("jerome", PASSWORD);
  const events = [], asked = [];
  client.onEvent(event => events.push(event));
  client.onServerRequest(request => { asked.push(request); return true; });
  const created = await client.request("session.create", { profile: "default" });
  fake.emit(created.session_id, "message.delta", { text: "hi" });
  await until(() => events.some(event => event.type === "message.delta"));
  const delta = events.find(event => event.type === "message.delta");
  assert.equal(delta.sessionId, created.session_id);
  assert.equal(delta.seq, 1);
  assert.deepEqual(delta.payload, { text: "hi" });
  assert.ok(client.epoch, "gateway.ready names the replay epoch");
  const answered = fake.serverRequest(created.session_id, "approval", { request_id: "r1", command: "rm -rf /tmp/x", choices: ["once", "deny"] });
  await until(() => asked.length === 1);
  assert.equal(asked[0].method, "approval");
  assert.equal(asked[0].sessionId, created.session_id);
  assert.equal(client.answer(asked[0].id, { choice: "deny" }), true);
  assert.deepEqual((await answered).result, { choice: "deny" });
});

test("questions nobody here can answer are declined at once", async t => {
  const { fake, client } = await setup(t);
  await client.login("jerome", PASSWORD);
  client.onServerRequest(() => false);
  const created = await client.request("session.create", { profile: "default" });
  assert.equal((await fake.serverRequest(created.session_id, "tour", {})).error.code, 4404);
  assert.equal((await fake.serverRequest(created.session_id, "theme.pick", {})).error.code, -32601);
});

test("a dropped socket is reopened with a fresh ticket", async t => {
  const { fake, client } = await setup(t);
  await client.login("jerome", PASSWORD);
  await client.request("ping");
  const states = [];
  client.onState(change => states.push(change.state));
  fake.dropSockets();
  await until(() => states.includes("open"));
  assert.ok(states.includes("retrying"));
  assert.equal(fake.state.ticketsIssued, 2);
  assert.deepEqual(await client.request("ping"), { pong: true });
});

test("an expired sign-in stops the client instead of retrying", async t => {
  const { fake, client, store } = await setup(t);
  await client.login("jerome", PASSWORD);
  await client.request("ping");
  fake.expireSessions();
  fake.dropSockets();
  await until(async () => (await client.status()).connection === "signed_out");
  const issued = fake.state.ticketsIssued;
  await sleep(250);
  assert.equal(fake.state.ticketsIssued, issued, "no retry loop");
  assert.equal(store.read(), null);
  await assert.rejects(client.request("ping"), error => error.code === "hermes_signed_out");
});

test("rotated cookies replace the stored ones", async t => {
  const { fake, client, store } = await setup(t);
  await client.login("jerome", PASSWORD);
  const before = store.read().cookies.hermes_session_at;
  fake.rotateAccessToken();
  await client.rest("GET", "/api/sessions", { query: { profile: "default" } });
  const after = store.read().cookies.hermes_session_at;
  assert.notEqual(after, before);
  assert.deepEqual((await client.rest("GET", "/api/sessions", { query: { profile: "default" } })).sessions, []);
});

test("a Hermes that needs no sign-in is used with its own page token", async t => {
  const { client } = await setup(t, { authRequired: false });
  assert.equal((await client.status()).signedIn, true);
  assert.deepEqual(await client.request("ping"), { pong: true });
  assert.deepEqual((await client.rest("GET", "/api/sessions", { query: { profile: "default" } })).sessions, []);
});

test("an idle connection closes; a held one stays open", async t => {
  const { client } = await setup(t, {}, { idleCloseMs: 100 });
  await client.login("jerome", PASSWORD);
  await client.request("ping");
  const release = client.hold();
  await sleep(250);
  assert.equal((await client.status()).connection, "open");
  release();
  await until(async () => (await client.status()).connection === "idle");
});
```

- [ ] **Step 2: 確認失敗**

Run: `node --test test/hermes-gateway-client.test.js`
Expected: FAIL，`Cannot find module '../server/hermes-gateway-client'`

- [ ] **Step 3: 實作**

```js
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
```

- [ ] **Step 4: 確認通過**

Run: `node --test test/hermes-gateway-client.test.js`
Expected: 9 pass, 0 fail

- [ ] **Step 5: Commit**

```bash
git add server/hermes-gateway-client.js test/hermes-gateway-client.test.js
git commit -m "Talk to Hermes over one ticketed socket that answers its questions"
```

---

### Task 5: 助理服務

**Files:**
- Create: `server/hermes-assistant-service.js`
- Test: `test/hermes-assistant-service.test.js`

- [ ] **Step 1: 寫失敗的測試**

```js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createHermesDiscovery } = require("../server/hermes-discovery");
const { createHermesSessionStore } = require("../server/hermes-session-store");
const { createHermesGatewayClient } = require("../server/hermes-gateway-client");
const { createHermesAssistantService } = require("../server/hermes-assistant-service");
const { createFakeHermesGateway } = require("../test-support/fake-hermes-gateway.cjs");

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, timeoutMs = 5000) {
  const started = Date.now();
  while (!(await check())) {
    if (Date.now() - started > timeoutMs) throw new Error("timed out waiting");
    await sleep(10);
  }
}

async function setup(t, { installed = true } = {}) {
  const fake = createFakeHermesGateway();
  await fake.start();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "stepsemble-hermes-service-"));
  const client = createHermesGatewayClient({
    discovery: createHermesDiscovery({ env: { STEPSEMBLE_HERMES_URL: fake.url }, interfaces: () => ({}) }),
    store: createHermesSessionStore({ file: path.join(dir, "hermes-session.json") }),
    options: { reconnectDelaysMs: [20, 40, 80], keepaliveMs: 60_000, idleCloseMs: 60_000 },
  });
  await client.login("jerome", "correct horse");
  const notices = [];
  const service = createHermesAssistantService({ client, installed: () => installed, notify: notice => notices.push(notice) });
  t.after(async () => { client.close(); await fake.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { fake, client, service, notices };
}
function collect(service, after = 0) {
  const events = [];
  const stop = service.subscribe(event => events.push(event), after);
  return { events, stop };
}

test("Bots come from Hermes profiles with their Bot Mode names and hidden state", async t => {
  const { service } = await setup(t);
  const { bots, installId } = await service.bots();
  assert.equal(installId, "install-fake");
  assert.deepEqual(bots.map(bot => [bot.name, bot.displayName, bot.hidden, bot.isDefault]),
    [["default", "Luna", false, true], ["qa-reviewer", "QA Reviewer", false, false], ["image-artist", "Image Artist", true, false]]);
  assert.equal(bots[0].color, "#5b8def");
  assert.equal(bots[0].model, "gpt-6-luna");
  assert.equal(bots[0].botChat, null);
});

test("the Bot Chat is created once, hidden and titled, then found again", async t => {
  const { fake, service } = await setup(t);
  const first = await service.openBotChat("default");
  assert.equal(first.profile, "default");
  assert.equal(first.botChat, true);
  assert.deepEqual(first.messages, []);
  const rows = fake.storedSessions();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].title, "Bot Chat");
  assert.equal(rows[0].hidden, true);
  const again = await service.openBotChat("default");
  assert.equal(again.sessionId, first.sessionId);
  assert.equal(fake.storedSessions().length, 1, "no second Bot Chat");
  await assert.rejects(service.openBotChat("../etc"), error => error.statusCode === 400);
});

test("a reply streams to subscribers; a finished reply reaches the phone only when nobody watches", async t => {
  const { fake, service, notices } = await setup(t);
  await service.bots();
  const chat = await service.openBotChat("default");
  const { events } = collect(service, chat.cursor);
  fake.setTurn({ reply: "All done for today.", thinking: "checking", tool: "calendar" });
  await service.prompt({ sessionId: chat.sessionId, text: "plan my day" });
  await until(() => events.some(event => event.type === "message.complete"));
  const kinds = [...new Set(events.map(event => event.type))];
  assert.deepEqual(kinds, ["message.start", "thinking.delta", "tool.start", "tool.complete", "message.delta", "message.complete"]);
  assert.ok(events.every(event => event.sessionId === chat.sessionId));
  assert.equal(events.filter(event => event.type === "message.delta").map(event => event.payload.text).join(""), "All done for today.");
  assert.deepEqual(notices.map(notice => [notice.kind, notice.title, notice.body]), [["completed", "Luna", "All done for today."]]);
  assert.equal(notices[0].url, `/assistant.html?bot=default&session=${encodeURIComponent(chat.sessionId)}`);
  service.watch("client-abcdef12", chat.sessionId);
  await service.prompt({ sessionId: chat.sessionId, text: "again" });
  await until(() => events.filter(event => event.type === "message.complete").length === 2);
  assert.equal(notices.length, 1, "someone was watching");
});

test("a Hermes approval waits for an answer, reaches the phone, and takes only offered choices", async t => {
  const { fake, service, notices } = await setup(t);
  await service.bots();
  const chat = await service.openBotChat("default");
  const { events } = collect(service, chat.cursor);
  fake.setTurn({ reply: "ok", request: { method: "approval",
    params: { request_id: "appr-1", command: "rm -rf build", description: "Delete the build folder", choices: ["once", "session", "deny"] } } });
  await service.prompt({ sessionId: chat.sessionId, text: "clean up" });
  await until(() => service.pendingAsks().length === 1);
  const [ask] = service.pendingAsks();
  assert.equal(ask.kind, "approval");
  assert.deepEqual(ask.choices, ["once", "session", "deny"]);
  assert.equal(ask.sessionId, chat.sessionId);
  assert.ok(events.some(event => event.type === "ask" && event.payload.id === ask.id));
  assert.deepEqual(notices.map(notice => [notice.kind, notice.body]), [["needs_reply", "Delete the build folder"]]);
  await assert.rejects(service.respond({ id: ask.id, answer: { choice: "always" } }), error => error.code === "invalid_choice");
  await service.respond({ id: ask.id, answer: { choice: "once" } });
  await until(() => fake.state.answers.length === 1);
  assert.deepEqual(fake.state.answers[0].response.result, { choice: "once" });
  assert.equal(service.pendingAsks().length, 0);
  assert.ok(events.some(event => event.type === "ask.closed" && event.payload.id === ask.id));
  await assert.rejects(service.respond({ id: ask.id, answer: { choice: "once" } }), error => error.statusCode === 409);
});

test("clarify answers go back by question; sudo and secret values never appear anywhere", async t => {
  const { fake, service, notices } = await setup(t);
  const chat = await service.openBotChat("default");
  const { events } = collect(service, chat.cursor);
  async function ask(request, answer) {
    fake.setTurn({ reply: "thanks", request });
    await service.prompt({ sessionId: chat.sessionId, text: request.method });
    await until(() => service.pendingAsks().length === 1);
    const [pendingAsk] = service.pendingAsks();
    await service.respond({ id: pendingAsk.id, answer });
    await until(() => fake.state.answers.length > 0 && fake.state.answers.at(-1).method === request.method);
    await until(() => service.pendingAsks().length === 0);
    return { pendingAsk, response: fake.state.answers.at(-1).response };
  }
  const clarify = await ask({ method: "clarify", params: { questions: [{ qid: "q1", question: "Which day?", choices: ["Mon", "Tue"], multi_select: false }] } },
    { answers: { q1: "Tue" } });
  assert.deepEqual(clarify.pendingAsk.questions, [{ qid: "q1", question: "Which day?", choices: ["Mon", "Tue"], multiSelect: false }]);
  assert.deepEqual(clarify.response.result, { answers: { q1: "Tue" } });
  assert.deepEqual((await ask({ method: "sudo", params: { command: "sudo ls" } }, { value: "hunter2-sudo" })).response.result, { value: "hunter2-sudo" });
  assert.deepEqual((await ask({ method: "secret", params: { env_var: "API_KEY", prompt: "Paste the key" } }, { value: "sk-secret-value" })).response.result,
    { value: "sk-secret-value" });
  const everything = JSON.stringify({ events, asks: service.pendingAsks(), notices });
  assert.equal(everything.includes("hunter2-sudo"), false);
  assert.equal(everything.includes("sk-secret-value"), false);
});

test("a withdrawn question disappears", async t => {
  const { fake, service } = await setup(t);
  const chat = await service.openBotChat("default");
  const { events } = collect(service, chat.cursor);
  fake.setTurn({ reply: "later", request: { method: "sudo", params: { command: "sudo ls" } } });
  await service.prompt({ sessionId: chat.sessionId, text: "go" });
  await until(() => service.pendingAsks().length === 1);
  fake.cancelRequests("timeout");
  await until(() => service.pendingAsks().length === 0);
  assert.ok(events.some(event => event.type === "ask.closed" && event.payload.reason === "timeout"));
});

test("a message to a conversation Hermes already let go reopens it and is sent once", async t => {
  const { fake, service } = await setup(t);
  const chat = await service.openBotChat("default");
  fake.forgetLive(chat.sessionId);
  await service.prompt({ sessionId: chat.sessionId, text: "still there?" });
  assert.deepEqual(fake.state.prompts.map(prompt => prompt.text), ["still there?"]);
  assert.ok(fake.state.methods.includes("session.resume"));
});

test("attachments are sent before the message, files as references in the text", async t => {
  const { fake, service } = await setup(t);
  const chat = await service.openBotChat("default");
  const image = Buffer.from("fake-png").toString("base64"), file = Buffer.from("hello").toString("base64");
  await service.prompt({ sessionId: chat.sessionId, text: "look", attachments: [
    { kind: "image", name: "photo.png", mime: "image/png", data: image },
    { kind: "file", name: "notes.txt", mime: "text/plain", data: file }] });
  assert.deepEqual(fake.state.attachments.map(item => [item.kind, item.name]), [["image", "photo.png"], ["file", "notes.txt"]]);
  assert.equal(fake.state.prompts.at(-1).text, "look\n@file:uploads/notes.txt");
  await assert.rejects(service.prompt({ sessionId: chat.sessionId, text: "x", attachments: [{ kind: "image", name: "a.png", data: "not base64!" }] }),
    error => error.statusCode === 400);
  await assert.rejects(service.prompt({ sessionId: chat.sessionId, text: "  " }), error => error.code === "empty_message");
});

test("after a dropped connection the missing part of a reply is replayed in order, once", async t => {
  const { fake, service } = await setup(t);
  const chat = await service.openBotChat("default");
  const { events } = collect(service, chat.cursor);
  let release;
  fake.setTurn({ reply: "abcdefghijklmnopqrstuvwxyz", wait: new Promise(resolve => { release = resolve; }) });
  await service.prompt({ sessionId: chat.sessionId, text: "long" });
  await until(() => events.some(event => event.type === "message.start"));
  fake.dropSockets();
  release();
  await until(() => events.some(event => event.type === "message.complete"), 8000);
  assert.equal(events.filter(event => event.type === "message.delta").map(event => event.payload.text).join(""), "abcdefghijklmnopqrstuvwxyz");
  assert.equal(events.filter(event => event.type === "message.complete").length, 1);
});

test("other conversations come from Hermes with their source; rename, read and delete go back", async t => {
  const { fake, service } = await setup(t);
  const telegram = fake.addSession("default", "Groceries", { source: "telegram" });
  telegram.messages.push({ role: "user", text: "buy milk" });
  await service.openBotChat("default");
  const list = await service.listSessions({ profile: "default" });
  assert.deepEqual(list.sessions.map(row => [row.id, row.title, row.source]), [[telegram.id, "Groceries", "telegram"]]);
  assert.equal((await service.listSessions({ profile: "default", query: "milk" })).sessions[0].id, telegram.id);
  await service.renameSession({ sessionId: telegram.id, profile: "default", title: "Shopping" });
  await service.markRead({ sessionId: telegram.id, profile: "default" });
  assert.deepEqual(fake.state.patches.map(patch => [patch.title ?? null, patch.unread ?? null, patch.profile]),
    [["Shopping", null, "default"], [null, false, "default"]]);
  await service.deleteSession({ sessionId: telegram.id, profile: "default" });
  assert.deepEqual(fake.state.deletes, [{ id: telegram.id, profile: "default" }]);
});

test("the event window stays bounded and a stale cursor is told to reload", async t => {
  const { fake, service } = await setup(t);
  const chat = await service.openBotChat("default");
  const live = fake.liveOf(chat.sessionId);
  for (let index = 0; index < 2100; index += 1) fake.emit(live, "message.delta", { text: "x" });
  await until(() => { let count = 0; const stop = service.subscribe(() => { count += 1; }, 0); stop(); return count === 2048; });
  const seen = [];
  const stop = service.subscribe(event => seen.push(event), 1);
  stop();
  assert.equal(seen[0].type, "replay.gap");
});

test("status says when Hermes is not installed", async t => {
  const { service } = await setup(t, { installed: false });
  assert.deepEqual(await service.status(), { installed: false });
});
```

- [ ] **Step 2: 確認失敗**

Run: `node --test test/hermes-assistant-service.test.js`
Expected: FAIL，`Cannot find module '../server/hermes-assistant-service'`

- [ ] **Step 3: 實作**

```js
"use strict";

// The assistant: Hermes Bot Mode on top of the gateway client. It lists the
// Bots, opens each Bot's one permanent "Bot Chat" the way Hermes Desktop does,
// sends messages, keeps a bounded window of recent events for the browser,
// holds the questions Hermes asks (approval, clarify, sudo, secret) until
// someone answers, and decides when a phone should hear about it.
// Conversations stay in Hermes; nothing here is written to disk, and an
// answer to sudo or secret is passed to Hermes and dropped.

const { HermesError } = require("./hermes-gateway-client");

const BOT_CHAT_TITLE = "Bot Chat";
const PROFILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const SESSION = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const ASK_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const CLIENT_ID = /^[A-Za-z0-9-]{8,64}$/;
const COLOR = /^#[0-9a-fA-F]{3,8}$/;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
const MIME = /^[\w.+-]+\/[\w.+-]+$/;
const RING_EVENTS = 2048, RING_BYTES = 4 * 1024 * 1024;
const WATCH_MS = 45_000, MAX_WATCHERS = 64, MAX_SESSIONS = 200;
const MAX_TEXT = 512 * 1024, MAX_ATTACHMENTS = 4, MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const ASKS = new Set(["approval", "clarify", "sudo", "secret"]);
const APPROVAL_CHOICES = new Set(["once", "session", "always", "deny"]);
const FIELDS = Object.freeze({
  "message.start": [], "message.delta": ["text"], "thinking.delta": ["text"], "message.complete": ["text", "interrupted"],
  "tool.start": ["tool_id", "name", "args_text", "context"], "tool.complete": ["tool_id", "name", "summary", "result_text"],
  "status.update": ["kind", "text"], error: ["message"],
});

const clip = (value, max) => (typeof value === "string" ? value.slice(0, max) : "");
const count = value => (Number.isFinite(Number(value)) && Number(value) >= 0 ? Number(value) : 0);
const invalid = code => new HermesError(code, code, 400);

function profileName(value) {
  const name = String(value || "");
  if (!PROFILE.test(name)) throw invalid("invalid_profile");
  return name;
}
function sessionKey(value) {
  const key = String(value || "");
  if (!SESSION.test(key)) throw invalid("invalid_session");
  return key;
}
function trimPayload(type, payload) {
  const out = {};
  for (const key of FIELDS[type] || []) {
    const value = payload?.[key];
    if (typeof value === "string") out[key] = value.slice(0, MAX_TEXT);
    else if (typeof value === "boolean" || typeof value === "number") out[key] = value;
  }
  return out;
}
function messages(rows) {
  return (Array.isArray(rows) ? rows : []).slice(-1000).map(row => {
    const role = ["user", "assistant", "system", "tool"].includes(row?.role) ? row.role : "assistant";
    return role === "tool" ? { role, name: clip(row.name, 200) || "tool", context: clip(row.context, 4000) } : { role, text: clip(row?.text, MAX_TEXT) };
  }).filter(row => row.role === "tool" || row.text);
}
function sessionRow(row) {
  if (!row || typeof row.id !== "string" || !SESSION.test(row.id)) return null;
  return { id: row.id, title: clip(row.title, 300), preview: clip(row.preview || row.snippet, 300), source: clip(row.source, 32),
    startedAt: count(row.started_at), lastActive: count(row.last_active) || count(row.started_at),
    messageCount: count(row.message_count), unread: row.unread === true };
}
function cleanAttachments(list) {
  if (list === undefined || list === null) return [];
  if (!Array.isArray(list) || list.length > MAX_ATTACHMENTS) throw invalid("invalid_attachments");
  return list.map(item => {
    const data = typeof item?.data === "string" ? item.data : "";
    if (!["image", "file"].includes(item?.kind) || !data || !BASE64.test(data) || data.length * 0.75 > MAX_ATTACHMENT_BYTES) throw invalid("invalid_attachments");
    const name = clip(item.name, 200).replace(/[\\/\r\n\0]/g, "_") || (item.kind === "image" ? "image" : "file");
    const mime = MIME.test(String(item.mime || "")) ? item.mime : "application/octet-stream";
    return { kind: item.kind, name, mime, data };
  });
}

function createHermesAssistantService({ client, installed = () => false, notify = () => {}, now = Date.now } = {}) {
  const sessions = new Map();   // storedId -> { storedId, liveId, profile, running, lastSeq, resyncing, buffer }
  const byLive = new Map();     // liveId -> storedId
  const asks = new Map();       // Hermes request id -> ask
  const ring = [];
  const subscribers = new Set();
  const watchers = new Map();   // clientId -> { sessionId, until }
  const botNames = new Map();
  let ringBytes = 0, nextEvent = 0, epoch = null, turnHold = null;

  const botName = profile => botNames.get(profile) || (profile === "default" ? "Hermes" : profile);

  function publish(sessionId, type, payload = {}) {
    const event = Object.freeze({ id: ++nextEvent, sessionId, type, payload, at: now() });
    const bytes = Buffer.byteLength(JSON.stringify(event));
    ring.push({ event, bytes });
    ringBytes += bytes;
    while (ring.length > RING_EVENTS || ringBytes > RING_BYTES) ringBytes -= ring.shift().bytes;
    for (const listener of subscribers) { try { listener(event); } catch {} }
    return event;
  }

  function updateTurnHold() {
    const running = [...sessions.values()].some(entry => entry.running) || asks.size > 0;
    if (running && !turnHold) turnHold = client.hold();
    if (!running && turnHold) { turnHold(); turnHold = null; }
  }

  function isWatched(sessionId) {
    const at = now();
    for (const [id, watcher] of watchers) {
      if (watcher.until <= at) watchers.delete(id);
      else if (watcher.sessionId === sessionId) return true;
    }
    return false;
  }

  function notice(entry, kind, body) {
    return { kind, title: botName(entry.profile), body: String(body || "").replace(/\s+/g, " ").trim().slice(0, 140),
      sessionId: entry.storedId, profile: entry.profile,
      url: `/assistant.html?bot=${encodeURIComponent(entry.profile)}&session=${encodeURIComponent(entry.storedId)}` };
  }

  function track(storedId, liveId, profile) {
    let entry = sessions.get(storedId);
    if (!entry) {
      entry = { storedId, liveId, profile: profile || "default", running: false, lastSeq: null, resyncing: false, buffer: [] };
      sessions.set(storedId, entry);
    }
    if (entry.liveId !== liveId) { byLive.delete(entry.liveId); entry.liveId = liveId; entry.lastSeq = null; }
    if (profile) entry.profile = profile;
    byLive.set(liveId, storedId);
    while (sessions.size > MAX_SESSIONS) {
      const [oldest, value] = sessions.entries().next().value;
      byLive.delete(value.liveId);
      sessions.delete(oldest);
    }
    return entry;
  }

  function ingest(entry, event) {
    if (event.seq !== null) {
      if (entry.lastSeq !== null && event.seq <= entry.lastSeq) return;
      entry.lastSeq = event.seq;
    }
    if (event.type === "request.cancel") { closeAsk(String(event.payload?.id || ""), clip(event.payload?.reason, 64) || "withdrawn"); return; }
    if (!FIELDS[event.type]) return;
    if (event.type === "message.start") { entry.running = true; updateTurnHold(); }
    publish(entry.storedId, event.type, trimPayload(event.type, event.payload));
    if (event.type === "message.complete") {
      entry.running = false;
      updateTurnHold();
      if (event.payload?.interrupted !== true && !isWatched(entry.storedId)) notify(notice(entry, "completed", event.payload?.text));
    }
    if (event.type === "error") {
      entry.running = false;
      updateTurnHold();
      if (!isWatched(entry.storedId)) notify(notice(entry, "failed", event.payload?.message));
    }
  }

  function onHermesEvent(event) {
    if (event.type === "sessions.changed" || event.type === "cron.changed") { publish(null, event.type, {}); return; }
    const storedId = event.sessionId ? byLive.get(event.sessionId) : null;
    const entry = storedId ? sessions.get(storedId) : null;
    if (!entry) return;
    if (entry.resyncing) { entry.buffer.push(event); return; }
    ingest(entry, event);
  }

  function makeAsk(request, entry) {
    const p = request.params || {};
    const base = { id: request.id, kind: request.method, sessionId: entry.storedId, profile: entry.profile, bot: botName(entry.profile), at: now() };
    if (request.method === "approval") {
      const choices = (Array.isArray(p.choices) ? p.choices : []).filter(choice => APPROVAL_CHOICES.has(choice));
      return { ...base, command: clip(p.command, 4000), description: clip(p.description, 2000), choices: choices.length ? choices : ["once", "deny"] };
    }
    if (request.method === "clarify") {
      const questions = (Array.isArray(p.questions) ? p.questions : []).slice(0, 5).map(question => ({
        qid: clip(question?.qid, 100), question: clip(question?.question, 4000),
        choices: Array.isArray(question?.choices) ? question.choices.filter(choice => typeof choice === "string").slice(0, 20).map(choice => choice.slice(0, 500)) : null,
        multiSelect: question?.multi_select === true,
      })).filter(question => question.qid && question.question);
      return { ...base, questions };
    }
    if (request.method === "sudo") return { ...base, command: clip(p.command, 4000) };
    return { ...base, envVar: clip(p.env_var, 200), prompt: clip(p.prompt, 2000) };
  }

  function askSummary(ask) {
    if (ask.kind === "approval") return ask.description || ask.command;
    if (ask.kind === "clarify") return ask.questions[0]?.question || "";
    if (ask.kind === "sudo") return ask.command || "sudo";
    return ask.prompt || ask.envVar;
  }

  function registerAsk(request, entry, { announce }) {
    if (!ASKS.has(request.method) || !ASK_ID.test(String(request.id || "")) || asks.has(request.id)) return false;
    const ask = makeAsk(request, entry);
    asks.set(ask.id, ask);
    updateTurnHold();
    publish(entry.storedId, "ask", { ...ask });
    if (announce) notify(notice(entry, "needs_reply", askSummary(ask)));
    return true;
  }

  function closeAsk(id, reason) {
    const ask = asks.get(id);
    if (!ask) return;
    asks.delete(id);
    updateTurnHold();
    publish(ask.sessionId, "ask.closed", { id, reason });
  }

  function onServerRequest(request) {
    if (!ASKS.has(request.method)) return false;
    const storedId = request.sessionId ? byLive.get(request.sessionId) : null;
    const entry = storedId ? sessions.get(storedId) : null;
    if (!entry) return false;
    registerAsk(request, entry, { announce: true });
    return true;
  }

  function restoreAsks(entry, list) {
    for (const frame of Array.isArray(list) ? list : []) {
      if (!frame || typeof frame !== "object") continue;
      registerAsk({ id: String(frame.id || ""), method: frame.method, params: frame.params || {} }, entry, { announce: false });
    }
  }

  async function resync(entry) {
    try {
      const resumed = await client.request("session.resume", { session_id: entry.storedId, profile: entry.profile, omit_messages: true }, { timeoutMs: 60_000 });
      if (typeof resumed?.session_id !== "string" || !resumed.session_id) throw new Error("resume failed");
      const sameLive = resumed.session_id === entry.liveId && entry.lastSeq !== null;
      track(entry.storedId, resumed.session_id, entry.profile);
      if (sameLive) {
        const replay = await client.request("session.events.since", { session_id: entry.liveId, last_seen: entry.lastSeq });
        if (replay?.truncated) publish(entry.storedId, "session.reload", {});
        const frames = (Array.isArray(replay?.events) ? replay.events : []).filter(frame => frame && typeof frame.type === "string")
          .map(frame => ({ type: frame.type, sessionId: entry.liveId, seq: Number.isSafeInteger(frame.seq) ? frame.seq : null,
            payload: frame.payload && typeof frame.payload === "object" ? frame.payload : {} }));
        for (const frame of frames.sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0))) ingest(entry, frame);
        restoreAsks(entry, replay?.open_requests);
      } else {
        entry.running = resumed.running === true;
        publish(entry.storedId, "session.reload", {});
        restoreAsks(entry, resumed.open_requests);
      }
    } catch { publish(entry.storedId, "session.reload", {}); } finally {
      const buffered = entry.buffer.sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
      entry.buffer = [];
      entry.resyncing = false;
      for (const event of buffered) ingest(entry, event);
      updateTurnHold();
    }
  }

  function onConnection({ state, epoch: nextEpoch }) {
    if (state !== "open") {
      for (const entry of sessions.values()) if (entry.running || [...asks.values()].some(ask => ask.sessionId === entry.storedId)) entry.resyncing = true;
      return;
    }
    if (nextEpoch && epoch && nextEpoch !== epoch) for (const entry of sessions.values()) entry.lastSeq = null;
    if (nextEpoch) epoch = nextEpoch;
    for (const entry of sessions.values()) if (entry.resyncing) void resync(entry);
  }

  client.onEvent(onHermesEvent);
  client.onServerRequest(onServerRequest);
  client.onState(onConnection);

  function view(entry, extra) {
    return { sessionId: entry.storedId, profile: entry.profile, running: entry.running, cursor: nextEvent,
      asks: [...asks.values()].filter(ask => ask.sessionId === entry.storedId).map(ask => ({ ...ask })), ...extra };
  }

  async function status() {
    if (!installed()) return { installed: false };
    return { installed: true, ...(await client.status()), asks: asks.size };
  }

  async function bots() {
    const result = await client.request("profiles.list", { include_sessions: true }, { timeoutMs: 30_000 });
    const rows = [];
    for (const row of Array.isArray(result?.profiles) ? result.profiles : []) {
      if (!row || typeof row.name !== "string" || !PROFILE.test(row.name)) continue;
      const meta = row.ui_meta && typeof row.ui_meta === "object" && row.ui_meta["hermes-bots"] && typeof row.ui_meta["hermes-bots"] === "object" ? row.ui_meta["hermes-bots"] : {};
      const displayName = clip(meta.title, 120) || clip(row.display_name, 120) || (row.is_default === true ? "Hermes" : row.name);
      const chat = row.canonical_session && typeof row.canonical_session === "object" ? row.canonical_session : null;
      botNames.set(row.name, displayName);
      rows.push({ name: row.name, displayName, description: clip(row.description, 500) || clip(meta.description, 500),
        isDefault: row.is_default === true, hidden: meta.hidden === true, color: COLOR.test(String(meta.color || "")) ? meta.color : null,
        model: clip(row.model, 200), provider: clip(row.provider, 100),
        botChat: chat ? { id: clip(chat.resolved_id, 200) || clip(chat.id, 200), preview: clip(chat.preview, 300), lastActive: count(chat.last_active) } : null });
    }
    return { installId: clip(result?.install_id, 128), bots: rows };
  }

  async function openSession({ sessionId, profile } = {}) {
    const storedId = sessionKey(sessionId);
    const name = profile ? profileName(profile) : sessions.get(storedId)?.profile || null;
    const resumed = await client.request("session.resume", { session_id: storedId, ...(name ? { profile: name } : {}) }, { timeoutMs: 60_000 });
    if (typeof resumed?.session_id !== "string" || !resumed.session_id) throw new HermesError("hermes_session_failed", "Hermes could not open that conversation", 502);
    const key = typeof resumed.session_key === "string" && SESSION.test(resumed.session_key) ? resumed.session_key : storedId;
    const entry = track(key, resumed.session_id, name);
    entry.running = resumed.running === true;
    restoreAsks(entry, resumed.open_requests);
    updateTurnHold();
    return view(entry, { botChat: false, messages: messages(resumed.messages),
      inflight: entry.running ? { user: clip(resumed.inflight?.user, MAX_TEXT), assistant: clip(resumed.inflight?.assistant, MAX_TEXT) } : null });
  }

  async function openBotChat(profile) {
    const name = profileName(profile);
    const found = await client.request("session.list", { profile: name, title: BOT_CHAT_TITLE, limit: 5, include_hidden: true }, { timeoutMs: 30_000 });
    const row = (Array.isArray(found?.sessions) ? found.sessions : []).find(item => typeof item?.id === "string" && SESSION.test(item.id));
    if (row) return { ...(await openSession({ sessionId: row.id, profile: name })), botChat: true };
    const created = await client.request("session.create",
      { profile: name, title: BOT_CHAT_TITLE, hidden: true, follow_profile_config: true }, { timeoutMs: 60_000 });
    if (typeof created?.session_id !== "string" || !created.session_id) throw new HermesError("hermes_session_failed", "Hermes did not open the Bot Chat", 502);
    // session.create is lazy: titling it now creates the row, so a second
    // open cannot mint another Bot Chat before the first message.
    await client.request("session.title", { session_id: created.session_id, title: BOT_CHAT_TITLE }).catch(() => null);
    const storedId = typeof created.stored_session_id === "string" && SESSION.test(created.stored_session_id) ? created.stored_session_id : created.session_id;
    return view(track(storedId, created.session_id, name), { botChat: true, messages: [], inflight: null });
  }

  async function submit(entry, text, files) {
    let body = text;
    for (const file of files) {
      if (file.kind === "image") {
        await client.request("image.attach_bytes", { session_id: entry.liveId, content_base64: file.data, filename: file.name });
      } else {
        const attached = await client.request("file.attach", { session_id: entry.liveId, data_url: `data:${file.mime};base64,${file.data}`, name: file.name });
        if (typeof attached?.ref_text === "string" && attached.ref_text) body = body ? `${body}\n${attached.ref_text}` : attached.ref_text;
      }
    }
    await client.request("prompt.submit", { session_id: entry.liveId, text: body });
  }

  async function prompt({ sessionId, text, attachments } = {}) {
    const storedId = sessionKey(sessionId);
    const body = typeof text === "string" ? text : "";
    if (body.length > MAX_TEXT) throw invalid("text_too_long");
    const files = cleanAttachments(attachments);
    if (!body.trim() && !files.length) throw invalid("empty_message");
    if (!sessions.has(storedId)) await openSession({ sessionId: storedId });
    let entry = sessions.get(storedId);
    try { await submit(entry, body, files); } catch (error) {
      if (!/session not found/i.test(String(error?.message))) throw error;
      await openSession({ sessionId: storedId, profile: entry.profile });
      entry = sessions.get(storedId);
      await submit(entry, body, files);
    }
    entry.running = true;
    updateTurnHold();
    return { ok: true };
  }

  async function interrupt({ sessionId } = {}) {
    const entry = sessions.get(sessionKey(sessionId));
    if (!entry) throw new HermesError("assistant_session_unknown", "Open the conversation first", 409);
    await client.request("session.interrupt", { session_id: entry.liveId });
    return { ok: true };
  }

  async function respond({ id, answer } = {}) {
    if (typeof id !== "string" || !ASK_ID.test(id)) throw invalid("invalid_request");
    const ask = asks.get(id);
    if (!ask) throw new HermesError("assistant_request_gone", "This question was already answered or withdrawn", 409);
    let result;
    if (ask.kind === "approval") {
      const choice = String(answer?.choice || "");
      if (!ask.choices.includes(choice)) throw invalid("invalid_choice");
      result = { choice };
    } else if (ask.kind === "clarify") {
      const answers = {};
      for (const question of ask.questions) {
        const value = answer?.answers?.[question.qid];
        answers[question.qid] = typeof value === "string" ? value.slice(0, 8000) : null;
      }
      result = { answers };
    } else {
      const value = answer?.value;
      if (typeof value !== "string" || value.length > 8192) throw invalid("invalid_value");
      result = { value };
    }
    if (!client.answer(id, result)) throw new HermesError("hermes_disconnected", "Hermes is not connected right now; try again", 503);
    closeAsk(id, "answered");
    return { ok: true };
  }

  async function listSessions({ profile, query = "", offset = 0 } = {}) {
    const name = profileName(profile);
    const q = typeof query === "string" ? query.trim().slice(0, 200) : "";
    const start = Number.isSafeInteger(Number(offset)) && Number(offset) >= 0 ? Number(offset) : 0;
    const keep = row => row && row.title !== BOT_CHAT_TITLE;
    if (q) {
      const found = await client.rest("GET", "/api/sessions/search", { query: { q, profile: name, limit: 30 } });
      const seen = new Set();
      const rows = (Array.isArray(found?.results) ? found.results : []).map(sessionRow).filter(keep).filter(row => !seen.has(row.id) && seen.add(row.id));
      return { sessions: rows, hasMore: false };
    }
    const found = await client.rest("GET", "/api/sessions", { query: { profile: name, order: "recent", limit: 30, offset: start } });
    const rows = Array.isArray(found?.sessions) ? found.sessions : [];
    return { sessions: rows.map(sessionRow).filter(keep), hasMore: rows.length === 30 };
  }

  async function renameSession({ sessionId, profile, title } = {}) {
    const clean = typeof title === "string" ? title.replace(/[\r\n]+/g, " ").trim().slice(0, 200) : "";
    if (!clean) throw invalid("invalid_title");
    await client.rest("PATCH", `/api/sessions/${encodeURIComponent(sessionKey(sessionId))}`, { body: { title: clean, profile: profileName(profile) } });
    return { ok: true, title: clean };
  }

  async function markRead({ sessionId, profile } = {}) {
    await client.rest("PATCH", `/api/sessions/${encodeURIComponent(sessionKey(sessionId))}`, { body: { unread: false, profile: profileName(profile) } });
    return { ok: true };
  }

  async function deleteSession({ sessionId, profile } = {}) {
    const key = sessionKey(sessionId);
    await client.rest("DELETE", `/api/sessions/${encodeURIComponent(key)}`, { query: { profile: profileName(profile) } });
    const entry = sessions.get(key);
    if (entry) { byLive.delete(entry.liveId); sessions.delete(key); }
    return { ok: true };
  }

  function watch(clientId, sessionId) {
    if (typeof clientId !== "string" || !CLIENT_ID.test(clientId)) throw invalid("invalid_client");
    if (sessionId === null || sessionId === undefined || sessionId === "") { watchers.delete(clientId); return { ok: true }; }
    watchers.set(clientId, { sessionId: sessionKey(sessionId), until: now() + WATCH_MS });
    while (watchers.size > MAX_WATCHERS) watchers.delete(watchers.keys().next().value);
    return { ok: true };
  }

  function subscribe(listener, after = 0) {
    const from = Number.isSafeInteger(after) && after > 0 ? after : 0;
    if (from && ring.length && ring[0].event.id > from + 1) listener(Object.freeze({ id: from, sessionId: null, type: "replay.gap", payload: {}, at: now() }));
    for (const { event } of ring) if (event.id > from) listener(event);
    subscribers.add(listener);
    const release = client.hold();
    return () => { subscribers.delete(listener); release(); };
  }

  return Object.freeze({
    status, login: (username, password) => client.login(username, password), logout: () => client.logout(),
    bots, openBotChat, openSession, prompt, interrupt, respond,
    pendingAsks: () => [...asks.values()].map(ask => ({ ...ask })),
    listSessions, renameSession, markRead, deleteSession, watch, subscribe,
  });
}

module.exports = { createHermesAssistantService, BOT_CHAT_TITLE };
```

- [ ] **Step 4: 確認通過**

Run: `node --test test/hermes-assistant-service.test.js`
Expected: 12 pass, 0 fail

- [ ] **Step 5: Commit**

```bash
git add server/hermes-assistant-service.js test/hermes-assistant-service.test.js
git commit -m "Add the assistant service: Bots, Bot Chat, questions and replay"
```

---

### Task 6: HTTP 路由與 SSE

**Files:**
- Create: `server/hermes-assistant-routes.js`
- Test: `test/hermes-assistant-routes.test.js`

- [ ] **Step 1: 寫失敗的測試**

```js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { once } = require("node:events");
const { createHttpUtils } = require("../server/http-utils");
const { createHermesAssistantRoutes } = require("../server/hermes-assistant-routes");
const { HermesError } = require("../server/hermes-gateway-client");

async function serve(t, service) {
  const { readJSON, sendJSON, sseFrame, trySseWrite } = createHttpUtils();
  const handle = createHermesAssistantRoutes({ service, readJSON, sendJSON, sseFrame, trySseWrite });
  const server = http.createServer(async (req, res) => {
    if (!await handle(req, res, new URL(req.url, "http://localhost"))) sendJSON(res, 404, { error: "not_found" });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => { server.closeAllConnections(); server.close(); });
  return `http://127.0.0.1:${server.address().port}`;
}
const post = (base, path, body) => fetch(base + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

test("routes call the service and turn its errors into codes the page can read", async t => {
  const calls = [];
  const service = {
    status: async () => ({ installed: true, running: true, signedIn: false }),
    login: async (username, password) => { calls.push(["login", username, password.length]); throw new HermesError("hermes_invalid_credentials", "wrong", 401); },
    bots: async () => ({ installId: "i", bots: [{ name: "default" }] }),
    openBotChat: async profile => { calls.push(["bot-chat", profile]); return { sessionId: "st-1" }; },
    prompt: async body => { calls.push(["prompt", body.sessionId, body.text]); return { ok: true }; },
    respond: async body => { calls.push(["respond", body.id, body.answer]); return { ok: true }; },
    listSessions: async query => { calls.push(["sessions", query.profile, query.query, query.offset]); return { sessions: [], hasMore: false }; },
    watch: (clientId, sessionId) => { calls.push(["watch", clientId, sessionId]); return { ok: true }; },
    pendingAsks: () => [{ id: "srq-1", kind: "sudo" }],
  };
  const base = await serve(t, service);
  assert.deepEqual(await (await fetch(base + "/api/assistant/status")).json(), { installed: true, running: true, signedIn: false });
  const login = await post(base, "/api/assistant/login", { username: "jerome", password: "secret" });
  assert.equal(login.status, 401);
  assert.deepEqual(await login.json(), { error: "hermes_invalid_credentials", message: "wrong" });
  assert.deepEqual((await (await fetch(base + "/api/assistant/bots")).json()).bots, [{ name: "default" }]);
  assert.equal((await post(base, "/api/assistant/bot-chat", { profile: "default" })).status, 200);
  assert.equal((await post(base, "/api/assistant/prompt", { sessionId: "st-1", text: "hi" })).status, 202);
  assert.equal((await post(base, "/api/assistant/respond", { id: "srq-1", answer: { value: "x" } })).status, 200);
  await (await fetch(base + "/api/assistant/sessions?profile=default&q=milk&offset=30")).json();
  await post(base, "/api/assistant/watch", { clientId: "client-1234", sessionId: "st-1" });
  assert.deepEqual((await (await fetch(base + "/api/assistant/asks")).json()).asks, [{ id: "srq-1", kind: "sudo" }]);
  assert.equal((await fetch(base + "/api/assistant/nope")).status, 404);
  assert.deepEqual(calls, [["login", "jerome", 6], ["bot-chat", "default"], ["prompt", "st-1", "hi"],
    ["respond", "srq-1", { value: "x" }], ["sessions", "default", "milk", "30"], ["watch", "client-1234", "st-1"]]);
});

test("the event stream replays after the cursor and follows new events", async t => {
  const listeners = new Set();
  let released = 0;
  const backlog = [{ id: 1, type: "message.start", sessionId: "st-1", payload: {} }, { id: 2, type: "message.delta", sessionId: "st-1", payload: { text: "a" } }];
  const service = {
    subscribe(listener, after) {
      for (const event of backlog) if (event.id > after) listener(event);
      listeners.add(listener);
      return () => { listeners.delete(listener); released += 1; };
    },
  };
  const base = await serve(t, service);
  const controller = new AbortController();
  const response = await fetch(base + "/api/assistant/stream", { headers: { "last-event-id": "1" }, signal: controller.signal });
  assert.equal(response.headers.get("content-type"), "text/event-stream; charset=utf-8");
  const reader = response.body.getReader();
  let text = "";
  const decoder = new TextDecoder();
  while (!text.includes("message.delta")) text += decoder.decode((await reader.read()).value);
  assert.equal(text.includes("message.start"), false, "the cursor skips what was seen");
  for (const listener of listeners) listener({ id: 3, type: "message.complete", sessionId: "st-1", payload: { text: "a" } });
  while (!text.includes("message.complete")) text += decoder.decode((await reader.read()).value);
  assert.match(text, /id: 3\n/);
  controller.abort();
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(released, 1, "closing the page releases the subscription");
});
```

- [ ] **Step 2: 確認失敗**

Run: `node --test test/hermes-assistant-routes.test.js`
Expected: FAIL，`Cannot find module '../server/hermes-assistant-routes'`

- [ ] **Step 3: 實作**

```js
"use strict";

// HTTP routes for the assistant page. server.js has already checked the
// caller's Stepsemble sign-in before any of these run. Only GET and POST are
// used, so the device relay (/r/<machine>/api/...) can carry every call, and
// the event stream ends in /stream so the relay keeps it open.

const SMALL = 64 * 1024, LOGIN = 8 * 1024, PROMPT = 16 * 1024 * 1024;

function createHermesAssistantRoutes({ service, readJSON, sendJSON, sseFrame, trySseWrite }) {
  function fail(res, error) {
    const status = Number.isInteger(error?.statusCode) && error.statusCode >= 400 && error.statusCode < 600 ? error.statusCode : 502;
    sendJSON(res, status, { error: typeof error?.code === "string" ? error.code : "assistant_failed",
      message: typeof error?.message === "string" ? error.message.slice(0, 300) : "" });
  }

  function stream(req, res, url) {
    res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-store", Connection: "keep-alive",
      "X-Accel-Buffering": "no", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer" });
    if (typeof res.flushHeaders === "function") res.flushHeaders();
    const after = Math.max(Number(url.searchParams.get("after")) || 0, Number(req.headers["last-event-id"]) || 0);
    let closed = false, ping = null, unsubscribe = () => {};
    const end = () => {
      if (closed) return;
      closed = true;
      if (ping) clearInterval(ping);
      unsubscribe();
      try { res.end(); } catch {}
    };
    unsubscribe = service.subscribe(event => { if (!closed && !trySseWrite(res, sseFrame(event, null, event.id))) end(); }, after);
    if (closed) { unsubscribe(); return; }
    ping = setInterval(() => { if (!trySseWrite(res, ": ping\n\n")) end(); }, 15_000);
    req.on("close", end);
    res.on("close", end);
    res.on("error", end);
  }

  return async function handle(req, res, url) {
    const p = url.pathname;
    if (!p.startsWith("/api/assistant/")) return false;
    const get = req.method === "GET", post = req.method === "POST";
    try {
      if (p === "/api/assistant/status" && get) sendJSON(res, 200, await service.status());
      else if (p === "/api/assistant/stream" && get) stream(req, res, url);
      else if (p === "/api/assistant/login" && post) {
        const body = await readJSON(req, LOGIN);
        sendJSON(res, 200, await service.login(body.username, body.password));
      } else if (p === "/api/assistant/logout" && post) sendJSON(res, 200, await service.logout());
      else if (p === "/api/assistant/bots" && get) sendJSON(res, 200, await service.bots());
      else if (p === "/api/assistant/bot-chat" && post) sendJSON(res, 200, await service.openBotChat((await readJSON(req, SMALL)).profile));
      else if (p === "/api/assistant/session/open" && post) sendJSON(res, 200, await service.openSession(await readJSON(req, SMALL)));
      else if (p === "/api/assistant/sessions" && get) {
        sendJSON(res, 200, await service.listSessions({ profile: url.searchParams.get("profile"), query: url.searchParams.get("q") || "",
          offset: url.searchParams.get("offset") || 0 }));
      } else if (p === "/api/assistant/session/rename" && post) sendJSON(res, 200, await service.renameSession(await readJSON(req, SMALL)));
      else if (p === "/api/assistant/session/read" && post) sendJSON(res, 200, await service.markRead(await readJSON(req, SMALL)));
      else if (p === "/api/assistant/session/delete" && post) sendJSON(res, 200, await service.deleteSession(await readJSON(req, SMALL)));
      else if (p === "/api/assistant/prompt" && post) sendJSON(res, 202, await service.prompt(await readJSON(req, PROMPT)));
      else if (p === "/api/assistant/interrupt" && post) sendJSON(res, 200, await service.interrupt(await readJSON(req, SMALL)));
      else if (p === "/api/assistant/asks" && get) sendJSON(res, 200, { asks: service.pendingAsks() });
      else if (p === "/api/assistant/respond" && post) sendJSON(res, 200, await service.respond(await readJSON(req, SMALL)));
      else if (p === "/api/assistant/watch" && post) {
        const body = await readJSON(req, SMALL);
        sendJSON(res, 200, service.watch(body.clientId, body.sessionId ?? null));
      } else sendJSON(res, 404, { error: "assistant_route_not_found" });
    } catch (error) {
      if (!res.headersSent) fail(res, error);
    }
    return true;
  };
}

module.exports = { createHermesAssistantRoutes };
```

- [ ] **Step 4: 確認通過**

Run: `node --test test/hermes-assistant-routes.test.js`
Expected: 2 pass, 0 fail

- [ ] **Step 5: Commit**

```bash
git add server/hermes-assistant-routes.js test/hermes-assistant-routes.test.js
git commit -m "Serve the assistant API and its event stream"
```

---

### Task 7: 接上 server.js、推播與 Service Worker

**Files:**
- Modify: `server.js`（require 區、`hermesCommand` 之後、`deliverPushNotification`、路由分派處）
- Modify: `public/sw.js:161-178`
- Test: `test/hermes-assistant-http.test.js`

- [ ] **Step 1: 寫失敗的整合測試**

```js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const net = require("node:net");
const { spawn } = require("node:child_process");
const { createFakeHermesGateway } = require("../test-support/fake-hermes-gateway.cjs");
const { isolatedEnvironment } = require("../test-support/env");

const root = path.resolve(__dirname, "..");

async function freePort() {
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  await new Promise(resolve => server.close(resolve));
  return port;
}

test("the running server reaches Hermes, keeps the sign-in and streams a Bot Chat reply", async t => {
  const fake = createFakeHermesGateway();
  await fake.start();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "stepsemble-assistant-http-"));
  const bin = path.join(home, "bin");
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, "hermes"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const port = await freePort();
  const child = spawn(process.execPath, [path.join(root, "server.js")], {
    env: isolatedEnvironment({ HOME: home, PI_HOME: home, PATH: `${bin}${path.delimiter}${process.env.PATH}`, STEPSEMBLE_HOST: "127.0.0.1",
      STEPSEMBLE_PORT: String(port), PI_BIN: "/path/that/does/not/exist", STEPSEMBLE_HERMES_URL: fake.url, STEPSEMBLE_HERMES_ACP: "0" }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(async () => { child.kill("SIGTERM"); await fake.close(); fs.rmSync(home, { recursive: true, force: true }); });
  let output = "";
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`server did not start:\n${output}`)), 20_000);
    const read = chunk => { output += chunk; if (output.includes(" listening on ")) { clearTimeout(timer); resolve(); } };
    child.stdout.on("data", read);
    child.stderr.on("data", read);
    child.on("exit", code => reject(new Error(`server exited ${code}:\n${output}`)));
  });
  const base = `http://127.0.0.1:${port}`;
  const token = fs.readFileSync(path.join(home, ".config", "stepsemble", "token"), "utf8").trim();
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  const call = async (pathname, body) => {
    const response = await fetch(base + pathname, body === undefined ? { headers } : { method: "POST", headers, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  assert.equal((await fetch(base + "/api/assistant/status")).status, 401, "Stepsemble sign-in comes first");
  const before = await call("/api/assistant/status");
  assert.equal(before.body.installed, true);
  assert.equal(before.body.signedIn, false);
  assert.equal((await call("/api/assistant/login", { username: "jerome", password: "correct horse" })).body.signedIn, true);
  const sessionFile = path.join(home, ".config", "stepsemble", "hermes-session.json");
  if (process.platform !== "win32") assert.equal(fs.statSync(sessionFile).mode & 0o777, 0o600);
  assert.equal(fs.readFileSync(sessionFile, "utf8").includes("correct horse"), false);
  assert.equal((await call("/api/assistant/bots")).body.bots[0].displayName, "Luna");
  const chat = (await call("/api/assistant/bot-chat", { profile: "default" })).body;
  const controller = new AbortController();
  const stream = await fetch(`${base}/api/assistant/stream?after=${chat.cursor}`, { headers, signal: controller.signal });
  const reader = stream.body.getReader();
  assert.equal((await call("/api/assistant/prompt", { sessionId: chat.sessionId, text: "hello" })).status, 202);
  let text = "";
  const decoder = new TextDecoder();
  while (!text.includes("message.complete")) text += decoder.decode((await reader.read()).value);
  assert.match(text, /Echo: hel/);
  controller.abort();
});
```

`test-support/env.js` 的 `isolatedEnvironment` 會移除外部的 `STEPSEMBLE_*` 再套用覆寫，所以測試不受開發機環境影響。若 `authorization: Bearer <token>` 在這個伺服器不被接受，改照 `test/browse.test.js` 用 `/api/login` 取 cookie（`authenticate` 同時接受兩者，實作時以實測為準）。

- [ ] **Step 2: 確認失敗**

Run: `node --test test/hermes-assistant-http.test.js`
Expected: FAIL，`/api/assistant/status` 回 404（路由尚未接上）

- [ ] **Step 3: 在 server.js 加入 require**

在 `const { createAgentModeRoutes, codexTurnPermissions, modeOption } = require("./server/agent-mode-routes");` 下一行加入：

```js
const { createHermesDiscovery } = require("./server/hermes-discovery");
const { createHermesSessionStore } = require("./server/hermes-session-store");
const { createHermesGatewayClient } = require("./server/hermes-gateway-client");
const { createHermesAssistantService } = require("./server/hermes-assistant-service");
const { createHermesAssistantRoutes } = require("./server/hermes-assistant-routes");
```

- [ ] **Step 4: 建立助理服務與路由**

在 `const handleAgentModeRoute = createAgentModeRoutes({` 這個呼叫結束（`});`）之後加入：

```js
// Hermes Bot Mode for the assistant page (docs/hermes-assistant.md). The
// client connects only when the page or a running turn needs it; nothing is
// spawned and no Hermes file is read.
const hermesAssistant = createHermesAssistantService({
  client: createHermesGatewayClient({
    discovery: createHermesDiscovery(),
    store: createHermesSessionStore({ file: path.join(CONFIG_DIR, "hermes-session.json") }),
    log: (...args) => console.warn(...args),
  }),
  installed: () => !!hermesCommand,
  notify: notice => { void deliverPushNotification({ url: notice.url }, notice.title, notice.body); },
});
const handleHermesAssistantRoute = createHermesAssistantRoutes({ service: hermesAssistant, readJSON, sendJSON, sseFrame, trySseWrite });
```

若 `sseFrame`／`trySseWrite` 在該處不是已解構的變數，改從 server.js 既有的 `createHttpUtils(...)` 回傳值取得（`server.js:3054` 已使用 `sseFrame`）。

- [ ] **Step 5: 分派路由**

在 `if (await handleAgentModeRoute(req, res, url)) return;` 下一行加入：

```js
      if (await handleHermesAssistantRoute(req, res, url)) return;
```

- [ ] **Step 6: 推播帶上助理網址**

在 `deliverPushNotification` 的 payload 物件中，`taskId: session?.taskId || session?.id || null,` 之後加入：

```js
      url: typeof session?.url === "string" && session.url.startsWith("/assistant.html?") ? session.url : null,
```

- [ ] **Step 7: Service Worker 點推播打開助理**

把 `public/sw.js` 的 `notificationclick` 處理改成：

```js
self.addEventListener("notificationclick", event => {
  event.notification.close();
  const { notice, file, taskId, url } = event.notification.data || {};
  const assistant = typeof url === "string" && url.startsWith("/assistant.html?") ? url : null;
  const valid = notice && /^[a-zA-Z0-9_-]{1,128}$/.test(notice.host) && /^[a-f0-9-]{36}$/i.test(notice.key);
  const href = assistant || (valid ? "/workspace.html?host=" + encodeURIComponent(notice.host) + "&entry=" + encodeURIComponent(notice.key) : "/workspace.html");
  event.waitUntil((async () => {
    const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const client of clients.filter(row => row.frameType !== "nested")) {
      const current = new URL(client.url);
      if (current.origin !== self.location.origin) continue;
      if (assistant) {
        if (current.pathname !== "/assistant.html") continue;
        client.postMessage({ type: "STEPSEMBLE_OPEN_ASSISTANT", url: assistant });
        return client.focus();
      }
      if (!["/", "/workspace.html"].includes(current.pathname)) continue;
      if (valid) client.postMessage({ type: "STEPSEMBLE_OPEN_NOTIFICATION", notice });
      else if (taskId) client.postMessage({ type: "PI_HARBOR_OPEN_AGENT_TASK", product: "stepsemble", taskId });
      else if (file) client.postMessage({ type: "PI_HARBOR_OPEN_SESSION", product: "stepsemble", file });
      return client.focus();
    }
    return self.clients.openWindow(href);
  })());
});
```

- [ ] **Step 8: 確認通過**

Run: `node --test test/hermes-assistant-http.test.js`
Expected: 1 pass, 0 fail

- [ ] **Step 9: Commit**

```bash
git add server.js public/sw.js test/hermes-assistant-http.test.js
git commit -m "Wire the Hermes assistant into the server and notifications"
```

---

### Task 8: 檢查腳本與完整驗證

**Files:**
- Modify: `package.json`（`scripts.check` 結尾與新增 `check:assistant`）

- [ ] **Step 1: 新增檢查腳本**

在 `package.json` 的 `scripts` 加入：

```json
"check:assistant": "node --check server/hermes-discovery.js && node --check server/hermes-session-store.js && node --check server/hermes-gateway-client.js && node --check server/hermes-assistant-service.js && node --check server/hermes-assistant-routes.js && node --check test-support/fake-hermes-gateway.cjs && node --check public/sw.js",
```

並把 `scripts.check` 結尾的 `&& npm run check:workflows` 改成 `&& npm run check:workflows && npm run check:assistant`。

- [ ] **Step 2: 跑檢查**

Run: `npm run check`
Expected: exit 0

- [ ] **Step 3: 跑完整測試**

Run: `npm test`
Expected: 0 fail（基準 2,167 項加上本計畫新增的測試）

- [ ] **Step 4: 版本一致性**

Run: `npm run version:check`
Expected: exit 0

- [ ] **Step 5: Commit**

```bash
git add package.json
git commit -m "Check the assistant modules with the rest of the host"
```

---

## Self-review（寫完後對照規格）

- 規格 4.3 找伺服器 → Task 2；4.4 登入、限流不重試、ticket → Task 4；4.5 重連、心跳、閒置、`session.events.since` → Task 4、5；4.6 事件視窗與 SSE → Task 5、6；4.8 只存 cookie → Task 3、7。
- 規格 5.1 Bot 名單、Bot Chat（`session.list` + `session.create` + `session.title`）、附件、中斷、待處理、其他對話、推播 → Task 5、6、7。畫面、入口切換、從新增對話移除 Hermes、機器路由在 1b 計畫。
- 規格 7 安全：密碼不寫檔（Task 4、7 測試）、sudo／secret 值不進事件（Task 5 測試）、只連本機（Task 2）、不自動核准（Task 5 只接受 Hermes 給的選項）。
