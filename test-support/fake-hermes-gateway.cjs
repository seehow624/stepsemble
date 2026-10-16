"use strict";

// A stand-in for the Hermes 0.22.0 web server, for tests only: /api/status,
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

function defaultSkills() {
  return [
    { name: "daily-brief", category: "productivity", description: "Morning brief", provenance: "agent", enabled: true, content: "---\nname: daily-brief\n---\nBrief me.\n" },
    { name: "web-search", category: "research", description: "Search the web", provenance: "bundled", enabled: true, content: "---\nname: web-search\n---\nSearch.\n" },
    { name: "image-gen", category: "creative", description: "Make images", provenance: "hub", enabled: false, content: "---\nname: image-gen\n---\nDraw.\n" },
  ];
}
function defaultHub() {
  return [
    { name: "pdf-reader", description: "Read PDFs", source: "official", identifier: "official/docs/pdf-reader", trust_level: "builtin", repo: null, tags: ["pdf"],
      scan: { verdict: "safe", summary: "No issues", policy: "allow", policy_reason: "", findings: [], severity_counts: { critical: 0, high: 0, medium: 0, low: 0 } } },
    { name: "shell-helper", description: "Runs shell scripts", source: "github", identifier: "github/someone/shell-helper", trust_level: "community", repo: "someone/shell-helper", tags: [],
      scan: { verdict: "caution", summary: "Runs commands", policy: "ask", policy_reason: "community skill with shell access",
        findings: [{ severity: "high", category: "exec", file: "SKILL.md", line: 4, description: "Runs arbitrary shell commands" }], severity_counts: { critical: 0, high: 1, medium: 0, low: 0 } } },
    { name: "stealer", description: "Bad", source: "github", identifier: "github/bad/stealer", trust_level: "community", repo: "bad/stealer", tags: [],
      scan: { verdict: "dangerous", summary: "Exfiltrates keys", policy: "block", policy_reason: "critical finding",
        findings: [{ severity: "critical", category: "exfiltration", file: "run.sh", line: 1, description: "Sends ~/.ssh to a server" }], severity_counts: { critical: 1, high: 0, medium: 0, low: 0 } } },
  ];
}

function defaultConfig() {
  return {
    model: { provider: "openai-codex", default: "gpt-6-luna", api_key: "sk-config-secret-never-leaves" },
    agent: { reasoning_effort: "medium" },
    fallback_model: [{ provider: "ollama", model: "deepseek-v4-pro:cloud" }],
    auxiliary: { vision: { provider: "auto", model: "" }, compression: { provider: "ollama", model: "deepseek-v4-pro:cloud", reasoning_effort: "low" } },
    providers: { "local-llm": { name: "Local LLM", base_url: "http://127.0.0.1:1234/v1", model: "qwen3", api_key: "sk-endpoint-secret" } },
  };
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
  password = "correct horse", version = "0.22.0", installId = "install-fake", profiles = defaultProfiles() } = {}) {
  const state = {
    epoch: crypto.randomBytes(8).toString("hex"), loopbackToken: crypto.randomBytes(24).toString("base64url"),
    accessTokens: new Set(), tickets: new Set(), ticketsIssued: 0, loginAttempts: 0, rateLimitAfter: Infinity,
    rotateNext: false, rejectSockets: false, keepLiveOnResume: true,
    capabilities: [], methods: [], prompts: [], attachments: [], answers: [], patches: [], deletes: [],
    profiles, stored: new Map(), live: new Map(), peers: new Map(), rings: new Map(), seqs: new Map(),
    open: new Map(), sockets: new Set(), next: 0, turn: null, cron: [],
    rooms: new Map(), roomEvents: new Map(), groupDriver: true, groupApproval: null, groupCalls: [],
    bots: new Map(), avatars: new Map(), hubCatalog: defaultHub(), actions: new Map(), botCalls: [],
    files: new Map(), downloads: [], sources: [],
    consoleCalls: [], gatewayRunning: true, config: defaultConfig(), env: { OPENAI_API_KEY: "sk-live-abcdef123456", TELEGRAM_BOT_TOKEN: "123:abc" },
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
      return { path: `/fake/${profile.name}`, skill_count: 3, previous_names: [], has_avatar: state.avatars.has(profile.name), ui_meta_revisions: { ...(state.bots.get(profile.name)?.revisions || {}) },
        worker_session: null, last_session: null, ...profile,
        canonical_session: chat ? { id: chat.id, title: BOT_CHAT, root_title: BOT_CHAT, preview: preview(chat), last_active: chat.lastActive } : null };
    });
  }
  // Per-profile editor state (SOUL, skills, toolsets, MCP), created on first use.
  function botOf(name) {
    if (!state.bots.has(name)) {
      state.bots.set(name, { soul: `You are ${name}.`, skills: defaultSkills(), revisions: {},
        toolsets: [{ name: "web", label: "Web", description: "Search and fetch", tool_count: 3, enabled: true },
          { name: "terminal", label: "Terminal", description: "Run commands", tool_count: 2, enabled: false }],
        mcp: [{ name: "github", enabled: true, transport: "http" }, { name: "notion", enabled: false, transport: "stdio" }] });
    }
    return state.bots.get(name);
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

  // Hosted group rooms: every member mentioned (or everyone, without a
  // mention) answers once, in member order, through the room log.
  function appendRoomEvent(room, kind, actor, payload) {
    const events = state.roomEvents.get(room.room_id);
    room.latest_seq += 1;
    const event = { room_id: room.room_id, seq: room.latest_seq, event_id: `ev-${++state.next}`, kind, actor, payload, created_at: 1_760_000_000 + room.latest_seq };
    events.push(event);
    return event;
  }
  async function answerRoom(room, text) {
    const handles = [...String(text).matchAll(/@([A-Za-z0-9][A-Za-z0-9._:-]*)/g)].map(match => match[1].toLowerCase());
    const everyone = handles.includes("all") || handles.includes("everyone") || !handles.length;
    for (const member of room.members) {
      if (!everyone && !handles.includes(member.handle.toLowerCase())) continue;
      await new Promise(resolve => setTimeout(resolve, 20));
      appendRoomEvent(room, "turn.started", { kind: "member", id: member.member_id }, { member_id: member.member_id });
      appendRoomEvent(room, "message.member", { kind: "member", id: member.member_id }, { text: `${member.display_name || member.handle} heard: ${text}`, member_id: member.member_id });
      appendRoomEvent(room, "turn.settled", { kind: "member", id: member.member_id }, { member_id: member.member_id });
    }
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
        state.sources.push(p.source ?? null);
        const row = newStored(p.profile || "default", "", { hidden: p.hidden === true });
        return reply({ session_id: liveFor(row.id, peer), stored_session_id: row.id });
      }
      case "session.title": {
        const storedId = storedOf(p.session_id);
        if (!storedId) return fail(4001, "session not found");
        if (Object.hasOwn(p, "title")) state.stored.get(storedId).title = String(p.title || "");
        return reply({ title: state.stored.get(storedId).title });
      }
      case "session.resume": {
        state.sources.push(p.source ?? null);
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
      case "profiles.describe": {
        const profile = state.profiles.find(row => row.name === p.name);
        if (!profile) return fail(4064, `profile '${p.name}' not found`);
        const bot = botOf(profile.name);
        return reply({ name: profile.name, description: profile.description || "", soul: bot.soul, model: { provider: profile.provider || "", default: profile.model || "" },
          skills: bot.skills.map(skill => ({ name: skill.name, enabled: skill.enabled })), toolsets: bot.toolsets.map(row => ({ ...row })),
          toolsets_pinned: false, mcp_servers: bot.mcp.map(row => ({ ...row })) });
      }
      case "profiles.configure": {
        const profile = state.profiles.find(row => row.name === p.name);
        if (!profile) return fail(4064, `profile '${p.name}' not found`);
        const bot = botOf(profile.name);
        state.botCalls.push({ method: "configure", ...p });
        const applied = {};
        if (p.ui_meta && typeof p.ui_meta === "object") {
          const expected = p.ui_meta_expected_revisions || {};
          const conflicts = Object.keys(p.ui_meta).filter(key => p.ui_meta_expected_revisions && (expected[key] ?? -1) !== (bot.revisions[key] || 0));
          if (conflicts.length) { applied.ui_meta = false; applied.ui_meta_conflicts = Object.fromEntries(conflicts.map(key => [key, { expected: expected[key], actual: bot.revisions[key] || 0 }])); }
          else {
            profile.ui_meta = { ...(profile.ui_meta || {}) };
            for (const [key, value] of Object.entries(p.ui_meta)) { if (value === null) delete profile.ui_meta[key]; else profile.ui_meta[key] = value; bot.revisions[key] = (bot.revisions[key] || 0) + 1; }
            applied.ui_meta = true;
          }
        }
        if (typeof p.soul === "string") { bot.soul = p.soul; applied.soul = true; }
        if (typeof p.description === "string") { profile.description = p.description.trim(); applied.description = true; }
        let confirm = null;
        if (p.model && p.provider) {
          if (/expensive/.test(p.model) && p.confirm_expensive_model !== true) confirm = `${p.model} costs more than usual`;
          else { profile.model = p.model; profile.provider = p.provider; applied.model = true; }
        }
        if (Array.isArray(p.disabled_skills)) { for (const skill of bot.skills) skill.enabled = !p.disabled_skills.includes(skill.name); applied.skills = true; }
        if (Array.isArray(p.enabled_toolsets)) { for (const row of bot.toolsets) row.enabled = p.enabled_toolsets.includes(row.name); applied.toolsets = true; }
        if (Array.isArray(p.enabled_mcp_servers)) { for (const row of bot.mcp) row.enabled = p.enabled_mcp_servers.includes(row.name); applied.mcp_servers = true; }
        return reply({ ok: Object.values(applied).every(value => value !== false), applied, ...(confirm ? { confirm_required: true, confirm_message: confirm } : {}) });
      }
      case "profiles.create": {
        const name = String(p.name || "").trim();
        if (!name) return fail(4061, "name required");
        if (state.profiles.some(row => row.name === name)) return fail(4062, `Profile '${name}' already exists`);
        const source = p.clone_from ? state.profiles.find(row => row.name === p.clone_from) : null;
        if (p.clone_from && !source) return fail(4062, `Profile '${p.clone_from}' does not exist`);
        state.botCalls.push({ method: "create", ...p });
        state.profiles.push({ name, is_default: false, display_name: "", description: String(p.description || ""), model: p.model || source?.model || "gpt-6-luna",
          provider: p.provider || source?.provider || "openai-codex", ui_meta: {} });
        if (typeof p.soul === "string" && p.soul.trim()) botOf(name).soul = p.soul;
        return reply({ ok: true, name, path: `/fake/${name}`, soul_written: !!p.soul, model_set: !!(p.model && p.provider), mirrored: {} });
      }
      case "profiles.set_asset": {
        if (!state.profiles.some(row => row.name === p.name)) return fail(4064, `profile '${p.name}' not found`);
        if (p.clear === true) { state.avatars.delete(p.name); return reply({ ok: true, asset: "avatar", size: 0, removed: 1 }); }
        const match = /^data:(image\/(?:png|jpeg|webp));base64,(.*)$/s.exec(String(p.data || ""));
        if (!match) return fail(4070, "unsupported image format (PNG/JPEG/WebP only)");
        state.avatars.set(p.name, String(p.data));
        return reply({ ok: true, asset: "avatar", size: Buffer.from(match[2], "base64").length });
      }
      case "profiles.get_asset": {
        const data = state.avatars.get(p.name);
        return reply(data ? { found: true, mime: /^data:([^;]+)/.exec(data)[1], size: data.length, data } : { found: false });
      }
      case "model.options":
        return reply({ model: "gpt-6-luna", provider: "openai-codex", providers: [
          { slug: "openai-codex", name: "OpenAI Codex", is_current: true, models: ["gpt-6-luna", "gpt-6-mini"], total_models: 2 },
          { slug: "ollama", name: "Ollama", is_current: false, models: ["deepseek-v4-pro:cloud", "expensive-model"], total_models: 2 }] });
      case "config.set": {
        state.consoleCalls.push({ method: "config.set", key: p.key, value: p.value, scope: p.scope });
        if (p.key !== "reasoning") return fail(4002, `unknown config key: ${p.key}`);
        if (!["none", "minimal", "low", "medium", "high", "xhigh", "max"].includes(p.value)) return fail(4002, `unknown reasoning value: ${p.value}`);
        state.config.agent.reasoning_effort = p.value;
        return reply({ key: "reasoning", value: p.value });
      }
      case "groups.capabilities":
        return reply({ protocol_version: 1, driver: state.groupDriver, persistent_process: true, authority_gateway_id: installId,
          room_link: { enabled: false, reason: "disabled" }, features: ["discussion"], methods: ["groups.create", "groups.send"], max_log_limit: 500 });
      case "groups.list":
        return reply({ rooms: [...state.rooms.values()].filter(room => p.include_disbanded || !room.disbanded_at), next_offset: null });
      case "groups.create": {
        const members = Array.isArray(p.members) ? p.members : [];
        if (members.length < 2 || members.length > 6) return fail(4100, "members must contain between 2 and 6 entries");
        for (const member of members) {
          if (Object.keys(member).some(key => !["member_id", "profile", "handle", "display_name", "target"].includes(key))) return fail(4100, "unexpected member field");
          if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(member.handle || "") || ["all", "everyone"].includes(member.handle)) return fail(4100, "invalid handle");
        }
        const room = state.rooms.get(p.room_id) || { room_id: p.room_id, name: p.name, members, authority_gateway_id: installId, authority_epoch: 1,
          revision: 1, created_at: 1_760_000_000, updated_at: 1_760_000_000, disbanded_at: null, latest_seq: 0 };
        state.rooms.set(room.room_id, room);
        state.roomEvents.set(room.room_id, state.roomEvents.get(room.room_id) || []);
        return reply({ room });
      }
      case "groups.send": {
        const room = state.rooms.get(p.room_id);
        if (!room) return fail(4101, "room not found");
        if (Object.keys(p.payload || {}).sort().join(",") !== "text,thread_id") return fail(4100, "user payload must have exactly text and thread_id");
        state.groupCalls.push({ method: "send", text: p.payload.text, threadId: p.payload.thread_id });
        const event = appendRoomEvent(room, "message.user", { kind: "user", id: "owner" }, { text: p.payload.text, thread_id: p.payload.thread_id });
        reply({ event, accepted: true, driver_started: true });
        void answerRoom(room, p.payload.text);
        return undefined;
      }
      case "groups.log": {
        if (!state.rooms.has(p.room_id)) return fail(4112, "hosted room not found");
        const since = Number(p.since_seq) || 0;
        const events = (state.roomEvents.get(p.room_id) || []).filter(event => event.seq > since).slice(0, Number(p.limit) || 200);
        return reply({ events, cursor: events.at(-1)?.seq ?? since, latest_seq: state.rooms.get(p.room_id)?.latest_seq || 0, has_more: false,
          authority: { gateway_id: installId, epoch: 1 } });
      }
      case "groups.state": {
        const room = state.rooms.get(p.room_id);
        if (!room) return fail(4101, "room not found");
        return reply({ room, driver_status: { running: true, working: !!state.groupApproval, blocked: !!state.groupApproval, counts: {},
          pending_actions: state.groupApproval ? [state.groupApproval] : [], peer_routes: [] } });
      }
      case "groups.stop":
        state.groupCalls.push({ method: "stop", room: p.room_id });
        appendRoomEvent(state.rooms.get(p.room_id), "room.stop_requested", { kind: "user", id: "owner" }, {});
        return reply({ cancelled: 1 });
      case "groups.approve":
        state.groupCalls.push({ method: "approve", ...p });
        state.groupApproval = null;
        return reply({ approved: true, result: { resolved: true } });
      case "groups.retry":
        state.groupCalls.push({ method: "retry", ...p });
        return reply({ retried: true, task: { room_id: p.room_id, task_id: p.task_id, thread_id: "main", turn_id: "t1", status: "queued", execution_generation: 2, cancel_generation: 0 } });
      case "groups.rename": {
        const room = state.rooms.get(p.room_id);
        if (!room) return fail(4101, "room not found");
        room.name = p.name;
        appendRoomEvent(room, "room.renamed", { kind: "user", id: "owner" }, { name: p.name });
        return reply({ room });
      }
      case "groups.disband": {
        const room = state.rooms.get(p.room_id);
        if (!room) return fail(4101, "room not found");
        room.disbanded_at = 1_760_600_000;
        return reply({ tombstone: { room_id: room.room_id, disbanded_at: room.disbanded_at, idempotent: false } });
      }
      default: return fail(-32601, `Method not found: ${message.method}`);
    }
  }

  const sessionRow = row => ({ id: row.id, title: row.title, preview: preview(row), source: row.source, started_at: row.startedAt,
    last_active: row.lastActive, message_count: row.messages.length, archived: false, unread: row.unread });

  function cronJob(profile, body = {}) {
    const schedule = String(body.schedule || "");
    const kind = /^every /i.test(schedule) ? "interval" : /^\d{4}-\d{2}-\d{2}/.test(schedule) ? "once" : "cron";
    const minutes = kind === "interval" ? Number(/(\d+)/.exec(schedule)?.[1] || 0) * (/h$/i.test(schedule) ? 60 : 1) : undefined;
    return { id: `job${++state.next}`, profile, is_default_profile: profile === "default", name: String(body.name || ""), prompt: String(body.prompt || ""),
      schedule: { kind, ...(kind === "cron" ? { expr: schedule } : {}), ...(kind === "interval" ? { minutes } : {}), ...(kind === "once" ? { run_at: schedule } : {}), display: schedule },
      schedule_display: schedule, deliver: String(body.deliver || "local"), enabled: body.paused !== true, state: body.paused ? "paused" : "scheduled",
      next_run_at: body.paused ? null : "2026-10-16T07:00:00+08:00", last_run_at: null, last_status: null, last_error: null, last_delivery_error: null,
      model: body.model || null, provider: body.provider || null, skills: Array.isArray(body.skills) ? body.skills : [], no_agent: body.no_agent === true,
      script: body.script || null, repeat: { times: null, completed: 0 } };
  }
  const findJob = id => state.cron.find(job => job.id === id);

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://fake");
    const send = (status, body, headers = {}) => { res.writeHead(status, { "content-type": "application/json", ...headers }); res.end(JSON.stringify(body)); };
    try {
      if (url.pathname === "/api/status" && req.method === "GET") {
        return send(200, { version, auth_required: authRequired, auth_providers: authRequired ? providers : [], install_id: installId, gateway_running: state.gatewayRunning,
          gateway_state: state.gatewayRunning ? "running" : "stopped", gateway_pid: state.gatewayRunning ? 5150 : null, active_sessions: 1,
          gateway_platforms: { telegram: { state: "connected", error_message: null }, discord: { state: "fatal", error_message: "token rejected" } } });
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
      // Hermes 0.22's /api/files/download: sensitive names are refused, Range is
      // honoured, and the raw bytes come back.
      if (url.pathname === "/api/files/download" && req.method === "GET") {
        const target = String(url.searchParams.get("path") || ""), name = target.split("/").pop().toLowerCase();
        if (name === ".env" || name === "config.yaml" || name === "auth.json") return send(403, { detail: "Access to sensitive files is not allowed" });
        const file = state.files.get(target);
        if (!file) return send(404, { detail: "File not found" });
        state.downloads.push({ path: target, range: req.headers.range || null });
        const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || "");
        if (range) {
          const start = Number(range[1]), end = range[2] ? Math.min(Number(range[2]), file.length - 1) : file.length - 1;
          res.writeHead(206, { "content-type": "application/octet-stream", "accept-ranges": "bytes", "content-range": `bytes ${start}-${end}/${file.length}`, "content-length": end - start + 1 });
          return res.end(file.subarray(start, end + 1));
        }
        res.writeHead(200, { "content-type": "application/octet-stream", "accept-ranges": "bytes", "content-length": file.length, "content-disposition": `attachment; filename="${encodeURIComponent(name)}"` });
        return res.end(file);
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
          && (row.title.toLowerCase().includes(q) || row.messages.some(item => String(item.text || "").toLowerCase().includes(q))));
        return send(200, { results: rows.map(row => ({ ...sessionRow(row), snippet: preview(row) })) }, rotated);
      }
      if (url.pathname === "/api/cron/delivery-targets" && req.method === "GET") {
        return send(200, { targets: [{ id: "local", name: "Local (save only)", home_target_set: true, home_env_var: null },
          { id: "telegram", name: "Telegram", home_target_set: true, home_env_var: "TELEGRAM_HOME_CHANNEL" }] }, rotated);
      }
      if (url.pathname === "/api/cron/jobs" && req.method === "GET") {
        const profile = url.searchParams.get("profile") || "all";
        return send(200, state.cron.filter(job => profile === "all" || job.profile === profile), rotated);
      }
      if (url.pathname === "/api/cron/jobs" && req.method === "POST") {
        const body = await readJson(req);
        if (!String(body.schedule || "").trim()) return send(400, { detail: "schedule required" });
        const job = cronJob(url.searchParams.get("profile") || "default", body);
        state.cron.push(job);
        broadcast("cron.changed", {});
        return send(200, job, rotated);
      }
      const cronMatch = /^\/api\/cron\/jobs\/([^/]+)(?:\/(pause|resume|trigger|runs))?$/.exec(url.pathname);
      if (cronMatch) {
        const job = findJob(decodeURIComponent(cronMatch[1]));
        if (!job) return send(404, { detail: "Job not found" });
        const verb = cronMatch[2];
        if (!verb && req.method === "GET") return send(200, job, rotated);
        if (!verb && req.method === "PUT") {
          const { updates = {} } = await readJson(req);
          for (const key of ["name", "prompt", "deliver", "model", "provider", "skills"]) if (updates[key] !== undefined) job[key] = updates[key];
          if (updates.schedule !== undefined) Object.assign(job, { schedule: cronJob(job.profile, { schedule: updates.schedule }).schedule, schedule_display: updates.schedule });
          broadcast("cron.changed", {});
          return send(200, job, rotated);
        }
        if (!verb && req.method === "DELETE") {
          state.cron = state.cron.filter(other => other !== job);
          broadcast("cron.changed", {});
          return send(200, { ok: true }, rotated);
        }
        if (verb === "pause" || verb === "resume") {
          Object.assign(job, { enabled: verb === "resume", state: verb === "resume" ? "scheduled" : "paused" });
          broadcast("cron.changed", {});
          return send(200, job, rotated);
        }
        if (verb === "trigger") {
          const row = { id: `cron_${job.id}_20261015_070000`, profile: job.profile, title: job.name, hidden: false, source: "cron",
            messages: [{ role: "assistant", text: `Ran ${job.name}` }], startedAt: 1_760_500_000, lastActive: 1_760_500_000, unread: true, running: false, inflight: null };
          state.stored.set(row.id, row);
          Object.assign(job, { last_run_at: "2026-10-15T07:00:00+08:00", last_status: "ok" });
          broadcast("cron.changed", {});
          return send(200, job, rotated);
        }
        if (verb === "runs") {
          const runs = [...state.stored.values()].filter(row => row.id.startsWith(`cron_${job.id}_`))
            .map(row => ({ id: row.id, title: row.title, preview: preview(row), source: "cron", started_at: row.startedAt }));
          runs.push({ id: `cron_output:${job.id}:latest`, title: "Script output", preview: null, source: "cron_output", started_at: 1_760_400_000 });
          return send(200, { runs, limit: 20 }, rotated);
        }
      }
      if (url.pathname === "/api/config" && req.method === "GET") return send(200, JSON.parse(JSON.stringify(state.config)), rotated);
      if (url.pathname === "/api/config" && req.method === "PUT") {
        const body = await readJson(req);
        state.consoleCalls.push({ method: "config.put", config: body.config });
        for (const [key, value] of Object.entries(body.config || {})) state.config[key] = value;
        return send(200, { ok: true }, rotated);
      }
      if (url.pathname === "/api/model/auxiliary" && req.method === "GET") {
        return send(200, { tasks: Object.entries(state.config.auxiliary).map(([task, slot]) => ({ task, provider: slot.provider, model: slot.model, base_url: "",
          reasoning_effort: slot.reasoning_effort || null, local_endpoint: false })), main: { provider: state.config.model.provider, model: state.config.model.default } }, rotated);
      }
      if (url.pathname === "/api/model/set" && req.method === "POST") {
        const body = await readJson(req);
        state.consoleCalls.push({ method: "model.set", ...body });
        if (/expensive/.test(body.model) && body.confirm_expensive_model !== true) {
          return send(200, { ok: false, scope: body.scope, provider: body.provider, model: body.model, confirm_required: true, confirm_message: `${body.model} costs more than usual` }, rotated);
        }
        if (body.scope === "main") Object.assign(state.config.model, { provider: body.provider, default: body.model });
        else state.config.auxiliary[body.task] = { provider: body.provider, model: body.model, ...(body.reasoning_effort ? { reasoning_effort: body.reasoning_effort } : {}) };
        return send(200, { ok: true, scope: body.scope }, rotated);
      }
      if (url.pathname === "/api/env" && req.method === "GET") {
        const rows = { OPENAI_API_KEY: { description: "OpenAI API key", provider: "openai", provider_label: "OpenAI", category: "provider" },
          ANTHROPIC_API_KEY: { description: "Anthropic API key", provider: "anthropic", provider_label: "Anthropic", category: "provider" },
          TELEGRAM_BOT_TOKEN: { description: "Telegram bot token", provider: "", provider_label: "", category: "messaging" } };
        return send(200, Object.fromEntries(Object.entries(rows).map(([key, meta]) => [key, { is_set: !!state.env[key],
          redacted_value: state.env[key] ? `«redacted:${state.env[key].slice(0, 3)}...${state.env[key].slice(-4)}»` : null, url: null, is_password: true,
          tools: [], advanced: false, channel_managed: key === "TELEGRAM_BOT_TOKEN", provider_profiles: [], provider_primary: true, custom: false, ...meta }])), rotated);
      }
      if (url.pathname === "/api/env" && (req.method === "PUT" || req.method === "DELETE")) {
        const body = await readJson(req);
        state.consoleCalls.push({ method: `env.${req.method.toLowerCase()}`, key: body.key, length: typeof body.value === "string" ? body.value.length : null });
        if (req.method === "PUT") state.env[body.key] = body.value;
        else if (!(body.key in state.env)) return send(404, { detail: `${body.key} not found in .env` });
        else delete state.env[body.key];
        return send(200, { ok: true, key: body.key }, rotated);
      }
      const endpointRows = () => ({ endpoints: Object.entries(state.config.providers).map(([id, row]) => ({ id, name: row.name, base_url: row.base_url, model: row.model,
        models: [row.model], context_length: null, discover_models: true, has_api_key: !!row.api_key, api_key: row.api_key, active: state.config.model.provider === `custom:${id}`, source: "providers" })) });
      if (url.pathname === "/api/providers/custom-endpoints" && req.method === "GET") return send(200, endpointRows(), rotated);
      if (url.pathname === "/api/providers/custom-endpoints" && req.method === "POST") {
        const body = await readJson(req);
        const id = body.id || body.name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
        state.consoleCalls.push({ method: "endpoint.save", id, name: body.name, base_url: body.base_url, model: body.model, hasKey: !!body.api_key });
        state.config.providers[id] = { name: body.name, base_url: body.base_url, model: body.model, ...(body.api_key ? { api_key: body.api_key } : {}) };
        return send(200, { ...endpointRows(), ok: true, id }, rotated);
      }
      const endpointMatch = /^\/api\/providers\/custom-endpoints\/([^/]+)(\/activate)?$/.exec(url.pathname);
      if (endpointMatch) {
        const id = decodeURIComponent(endpointMatch[1]);
        if (!state.config.providers[id]) return send(404, { detail: "Custom endpoint not found" });
        state.consoleCalls.push({ method: endpointMatch[2] ? "endpoint.activate" : "endpoint.delete", id });
        if (endpointMatch[2] && req.method === "POST") { Object.assign(state.config.model, { provider: `custom:${id}`, default: state.config.providers[id].model }); return send(200, { ...endpointRows(), ok: true }, rotated); }
        if (!endpointMatch[2] && req.method === "DELETE") { delete state.config.providers[id]; return send(200, { ...endpointRows(), ok: true }, rotated); }
      }
      if (url.pathname === "/api/analytics/usage" && req.method === "GET") {
        const days = Number(url.searchParams.get("days"));
        state.consoleCalls.push({ method: "usage", days });
        return send(200, { period_days: days, daily: [{ day: "2026-10-14", input_tokens: 1200, output_tokens: 300, cache_read_tokens: 0, reasoning_tokens: 50, estimated_cost: 0.12,
          actual_cost: 0, sessions: 3, api_calls: 9 }, { day: "2026-10-15", input_tokens: 800, output_tokens: 200, cache_read_tokens: 0, reasoning_tokens: 0, estimated_cost: 0.08,
          actual_cost: 0, sessions: 2, api_calls: 4 }], by_model: [{ model: "gpt-6-luna", provider: "openai-codex", input_tokens: 2000, output_tokens: 500, estimated_cost: 0.2,
          sessions: 5, api_calls: 13 }], totals: { total_input: 2000 * days / 7, total_output: 500, total_cache_read: 0, total_reasoning: 50, total_estimated_cost: 0.2,
          total_actual_cost: 0, total_sessions: 5, total_api_calls: 13 }, by_task: [], skills: {}, tools: {} }, rotated);
      }
      if (url.pathname === "/api/gateway/restart" && req.method === "POST") {
        state.consoleCalls.push({ method: "gateway.restart" });
        state.actions.set("gateway-restart", { name: "gateway-restart", running: false, exit_code: 0, pid: 5151, lines: ["Gateway restarted"] });
        return send(200, { ok: true, pid: 5151, name: "gateway-restart" }, rotated);
      }
      const profileMatch = /^\/api\/profiles\/([^/]+)$/.exec(url.pathname);
      if (profileMatch && req.method === "DELETE") {
        const name = decodeURIComponent(profileMatch[1]);
        const index = state.profiles.findIndex(row => row.name === name);
        if (index < 0) return send(404, { detail: `Profile '${name}' not found` });
        if (state.profiles[index].is_default) return send(400, { detail: "Cannot delete the default profile" });
        state.profiles.splice(index, 1);
        state.botCalls.push({ method: "delete", name });
        return send(200, { ok: true, path: `/fake/${name}` }, rotated);
      }
      const skillProfile = () => {
        const name = url.searchParams.get("profile") || "default";
        return state.profiles.some(row => row.name === name) ? botOf(name) : null;
      };
      if (url.pathname === "/api/skills" && req.method === "GET") {
        const bot = skillProfile();
        if (!bot) return send(404, { detail: "Profile not found" });
        return send(200, bot.skills.map(({ content, ...skill }) => ({ ...skill, usage: 0 })), rotated);
      }
      if (url.pathname === "/api/skills/toggle" && req.method === "PUT") {
        const body = await readJson(req);
        const skill = (state.profiles.some(row => row.name === body.profile) ? botOf(body.profile) : null)?.skills.find(row => row.name === body.name);
        if (!skill) return send(404, { detail: "Skill not found" });
        skill.enabled = body.enabled === true;
        state.botCalls.push({ method: "toggle", profile: body.profile, name: body.name, enabled: skill.enabled });
        return send(200, { ok: true, name: skill.name, enabled: skill.enabled }, rotated);
      }
      if (url.pathname === "/api/skills/content" && req.method === "GET") {
        const skill = skillProfile()?.skills.find(row => row.name === url.searchParams.get("name"));
        if (!skill) return send(404, { detail: "Skill not found." });
        return send(200, { name: skill.name, content: skill.content, path: `/fake/skills/${skill.name}/SKILL.md` }, rotated);
      }
      if (url.pathname === "/api/skills/content" && req.method === "PUT") {
        const body = await readJson(req);
        const skill = (state.profiles.some(row => row.name === body.profile) ? botOf(body.profile) : null)?.skills.find(row => row.name === body.name);
        if (!skill) return send(404, { detail: "Skill 'x' not found." });
        skill.content = String(body.content);
        state.botCalls.push({ method: "skill.save", profile: body.profile, name: body.name });
        return send(200, { success: true }, rotated);
      }
      if (url.pathname === "/api/skills/hub/search" && req.method === "GET") {
        const query = String(url.searchParams.get("q") || "").toLowerCase();
        const results = state.hubCatalog.filter(row => query && (row.name.includes(query) || row.description.toLowerCase().includes(query)));
        const installed = Object.fromEntries((skillProfile()?.skills || []).filter(row => row.identifier).map(row => [row.identifier, row.name]));
        return send(200, { results: results.map(({ scan, ...row }) => row), source_counts: {}, timed_out: [], installed }, rotated);
      }
      if ((url.pathname === "/api/skills/hub/preview" || url.pathname === "/api/skills/hub/scan") && req.method === "GET") {
        const row = state.hubCatalog.find(item => item.identifier === url.searchParams.get("identifier"));
        if (!row) return send(404, { detail: "Skill not found" });
        if (url.pathname.endsWith("/preview")) return send(200, { name: row.name, description: row.description, source: row.source, identifier: row.identifier,
          trust_level: row.trust_level, repo: row.repo, tags: row.tags, skill_md: `---\nname: ${row.name}\n---\n${row.description}\n`, files: ["SKILL.md"] }, rotated);
        state.botCalls.push({ method: "scan", identifier: row.identifier });
        return send(200, { name: row.name, identifier: row.identifier, source: row.source, trust_level: row.trust_level, ...row.scan, tier1: null }, rotated);
      }
      if ((url.pathname === "/api/skills/hub/install" || url.pathname === "/api/skills/hub/uninstall") && req.method === "POST") {
        const body = await readJson(req);
        const bot = state.profiles.some(row => row.name === body.profile) ? botOf(body.profile) : null;
        if (!bot) return send(404, { detail: "Profile not found" });
        const install = url.pathname.endsWith("/install");
        const key = install ? body.identifier : body.name;
        const name = `skills-${install ? "install" : "uninstall"}-${String(key).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48)}-${crypto.createHash("sha1").update(String(key)).digest("hex").slice(0, 8)}`;
        state.botCalls.push({ method: install ? "install" : "uninstall", profile: body.profile, key });
        if (install) {
          const row = state.hubCatalog.find(item => item.identifier === key);
          if (row && !bot.skills.some(skill => skill.name === row.name)) bot.skills.push({ name: row.name, category: "hub", description: row.description, provenance: "hub", enabled: true, identifier: row.identifier, content: `---\nname: ${row.name}\n---\n` });
        } else bot.skills = bot.skills.filter(skill => skill.name !== key);
        state.actions.set(name, { name, running: false, exit_code: 0, pid: 4242, lines: [`${install ? "Installed" : "Uninstalled"} ${key}`] });
        return send(200, { ok: true, pid: 4242, name }, rotated);
      }
      const actionMatch = /^\/api\/actions\/([^/]+)\/status$/.exec(url.pathname);
      if (actionMatch && req.method === "GET") {
        const action = state.actions.get(decodeURIComponent(actionMatch[1]));
        if (!action) return send(404, { detail: "Unknown action" });
        return send(200, action, rotated);
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
    addFile(path, data) { state.files.set(path, Buffer.from(data)); },
    addRoutine(profile, body) { const job = cronJob(profile, body); state.cron.push(job); return job; },
    storedSessions: () => [...state.stored.values()],
    requestGroupApproval(roomId, memberId) {
      state.groupApproval = { kind: "approval", member_id: memberId, task_id: "task-1", execution_generation: 1, run_id: "run-1", session_id: "live-x",
        request_id: "appr-g1", approval: { request_id: "appr-g1", command: "rm -rf cache", description: "Clear the cache", choices: ["once", "deny"] } };
    },
    cancelRequests, emit, broadcast, serverRequest,
  };
  return api;
}

module.exports = { createFakeHermesGateway, BOT_CHAT };
