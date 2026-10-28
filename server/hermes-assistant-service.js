"use strict";

// The assistant: Hermes Bot Mode on top of the gateway client. It lists the
// Bots, opens each Bot's one permanent "Bot Chat" the way Hermes Desktop does,
// sends messages, keeps a bounded window of recent events for the browser,
// holds the questions Hermes asks (approval, clarify, sudo, secret) until
// someone answers, and decides when a phone should hear about it, including
// a Bot's answer to a routine that arrived while no browser was connected.
// Conversations stay in Hermes; nothing here is written to disk, and an
// answer to sudo or secret is passed to Hermes and dropped.

const { HermesError } = require("./hermes-gateway-client");
const { isPreset } = require("../public/modules/assistant-avatars");
const { displayNameOf, avatarIndexesFor } = require("./hermes-bots");
const Media = require("../public/modules/assistant-media");

const BOT_CHAT_TITLE = "Bot Chat";
const PROFILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const SESSION = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const ASK_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const CLIENT_ID = /^[A-Za-z0-9-]{8,64}$/;
const COLOR = /^#[0-9a-fA-F]{3,8}$/;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
const MIME = /^[\w.+-]+\/[\w.+-]+$/;
const RING_EVENTS = 2048, RING_BYTES = 4 * 1024 * 1024;
const WATCH_MS = 45_000, MAX_WATCHERS = 64, MAX_SESSIONS = 200, MAX_OFFERED = 4096;
// Stepsemble is a graphical client: with this source Hermes teaches a Bot to
// send files as MEDIA:/path instead of pasting the path.
const SOURCE = "desktop";
// Attachments follow Telegram: ten to a message, 20 MB each.
const MAX_TEXT = 512 * 1024, MAX_ATTACHMENTS = 10, MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
const ASKS = new Set(["approval", "clarify", "sudo", "secret"]);
const APPROVAL_CHOICES = new Set(["once", "session", "always", "deny"]);
// Hermes hands a routine's output to a Bot Chat as a user message that starts
// `[Cronjob "<name>" output — …]`; the Host never sends one itself.
const ROUTINE_MARK = /^\[Cronjob "([^"\n]{1,200})"/;
const ROUTINE_CHECK_MS = 60_000, ROUTINE_PAGE = 50, MAX_ROUTINE_SENT = 512, LIVE_SKEW_MS = 5_000;
// A conversation's transcript is read over HTTP, newest page first; Hermes
// gives at most 500 rows a page. Messages before a compaction are kept, as the
// resume showed them.
const HISTORY_PAGE = 500, HISTORY_ROWS = 1000;
// thinking.delta is Hermes's waiting line, not reasoning; the reasoning comes
// as reasoning.delta (when the Bot shows it) and whole with message.complete.
// (reasoning.available is a 500-character preview of either, so it is left.)
// Hermes 0.22 says how a turn ended in message.complete's status.
const FIELDS = Object.freeze({
  "message.start": [], "message.delta": ["text"], "thinking.delta": ["text"], "message.complete": ["text", "interrupted", "status", "reasoning"],
  "reasoning.delta": ["text"],
  "tool.start": ["tool_id", "name", "args_text", "context"], "tool.complete": ["tool_id", "name", "summary", "result_text"],
  "status.update": ["kind", "text"], error: ["message"],
});
// A Bot's reasoning comes with the answers it is kept for: the newest ones,
// each up to 16 KB, so a long conversation still opens quickly.
const HISTORY_REASONING = 20, MAX_REASONING = 16 * 1024;

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
// The transcript Hermes keeps (/api/sessions/{id}/messages), in the shape
// session.resume gives it: user, assistant and system text, and each tool step
// named by its tool and labelled the way the call that started it was. Rows
// Hermes marks as display-only scaffolding stay hidden.
function storedMessages(rows) {
  const labels = new Map(), out = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row || typeof row !== "object" || row.display_kind === "hidden") continue;
    if (row.role === "assistant") {
      for (const call of Array.isArray(row.tool_calls) ? row.tool_calls : []) {
        const id = typeof call?.id === "string" ? call.id : "";
        if (id) labels.set(id, toolLabel(row.tool_call_labels?.[id], call.function?.arguments));
      }
    }
    if (row.role === "tool") {
      out.push({ role: "tool", name: clip(row.tool_name, 200) || "tool", context: clip(labels.get(String(row.tool_call_id || "")) || "", 4000) });
      continue;
    }
    // Work a Bot handed to background helpers comes back as a turn Hermes
    // starts itself; its row is a notice, not something the person said.
    if (row.display_kind === "async_delegation_complete") {
      const meta = row.display_metadata && typeof row.display_metadata === "object" ? row.display_metadata : {};
      out.push({ role: "system", kind: "delegation", text: clip(meta.display_text, 2000), ...(count(row.timestamp) ? { at: count(row.timestamp) } : {}) });
      continue;
    }
    if (!["user", "assistant", "system"].includes(row.role)) continue;
    const text = typeof row.display_content === "string" ? row.display_content : typeof row.content === "string" ? row.content : "";
    // at: when Hermes wrote it (seconds), shown in the message's bubble.
    const reasoning = row.role === "assistant" ? clip(typeof row.reasoning === "string" && row.reasoning.trim() ? row.reasoning : row.reasoning_content, MAX_REASONING) : "";
    if (text.trim()) out.push({ role: row.role, text: clip(text, MAX_TEXT), ...(count(row.timestamp) ? { at: count(row.timestamp) } : {}), ...(reasoning.trim() ? { thinking: reasoning } : {}) });
  }
  const kept = out.slice(-1000);
  let answers = 0;
  for (let index = kept.length - 1; index >= 0; index -= 1) if (kept[index].thinking && ++answers > HISTORY_REASONING) delete kept[index].thinking;
  return kept;
}
// What a tool call did, in a line: Hermes's own labels for the tools it labels,
// otherwise the command or arguments it was given.
function toolLabel(stored, args) {
  if (Array.isArray(stored) && stored.length) return stored.map(label => label?.text).filter(text => typeof text === "string" && text).join(" · ");
  let parsed = args;
  if (typeof args === "string") { try { parsed = JSON.parse(args); } catch { return args; } }
  if (!parsed || typeof parsed !== "object") return "";
  for (const key of ["command", "cmd", "query", "path", "file_path", "url", "name"]) if (typeof parsed[key] === "string") return parsed[key];
  if (Array.isArray(parsed.urls) && parsed.urls.every(url => typeof url === "string")) return parsed.urls.join(", ");
  const values = Object.values(parsed);
  if (values.length === 1 && typeof values[0] === "string") return values[0];
  return values.length ? JSON.stringify(parsed) : "";
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
    // The padding is not file content: a file of exactly the limit must fit.
    const bytes = data.length * 0.75 - (data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0);
    if (!["image", "file"].includes(item?.kind) || !data || !BASE64.test(data) || bytes > MAX_ATTACHMENT_BYTES) throw invalid("invalid_attachments");
    const name = clip(item.name, 200).replace(/[\\/\r\n\0]/g, "_") || (item.kind === "image" ? "image" : "file");
    const mime = MIME.test(String(item.mime || "")) ? item.mime : "application/octet-stream";
    return { kind: item.kind, name, mime, data };
  });
}

function botMetaOf(row) {
  return row.ui_meta && typeof row.ui_meta === "object" && row.ui_meta["hermes-bots"] && typeof row.ui_meta["hermes-bots"] === "object" ? row.ui_meta["hermes-bots"] : {};
}

function createHermesAssistantService({ client, installed = () => false, notify = () => {}, noticesWanted = () => true, now = Date.now } = {}) {
  const sessions = new Map();   // storedId -> { storedId, liveId, profile, running, lastSeq, resyncing, buffer }
  const byLive = new Map();     // liveId -> storedId
  const asks = new Map();       // Hermes request id -> ask
  const ring = [];
  const subscribers = new Set();
  const watchers = new Map();   // clientId -> { sessionId, until }
  const botNames = new Map();
  const offered = new Map();    // paths a Bot has sent; only these can be downloaded
  const routineSince = new Map(); // profile -> Bot Chat last activity at the previous routine check
  const routineSent = new Set();  // routine messages whose answer was already considered
  const liveNoticeAt = new Map(); // storedId -> when a live event last reached the phone
  let ringBytes = 0, nextEvent = 0, epoch = null, turnHold = null;

  const botName = profile => botNames.get(profile) || (profile === "default" ? "Hermes" : profile);

  function offerMedia(text) {
    for (const file of Media.extract(text).files) {
      offered.delete(file.path);
      offered.set(file.path, true);
      if (offered.size > MAX_OFFERED) offered.delete(offered.keys().next().value);
    }
  }
  function offerMessages(list) { for (const row of list) if (row.role === "assistant") offerMedia(row.text); return list; }

  // Only files a Bot sent in a conversation are relayed; Hermes still applies
  // its own path and sensitive-file rules.
  function mediaFile(path, { range, signal } = {}) {
    if (typeof path !== "string" || !offered.has(path)) return Promise.reject(new HermesError("assistant_media_not_found", "This file was not sent by a Bot", 404));
    return client.download("/api/files/download", { query: { path }, headers: range ? { range: String(range).slice(0, 200) } : {}, signal });
  }

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
    const found = Media.extract(String(body || ""));
    const text = found.text || found.files.map(file => file.name).join(", ");
    return { kind, title: botName(entry.profile), body: text.replace(/\s+/g, " ").trim().slice(0, 140),
      sessionId: entry.storedId, profile: entry.profile,
      url: `/assistant.html?bot=${encodeURIComponent(entry.profile)}&session=${encodeURIComponent(entry.storedId)}` };
  }

  function notifyLive(entry, kind, text) {
    liveNoticeAt.delete(entry.storedId);
    liveNoticeAt.set(entry.storedId, now());
    while (liveNoticeAt.size > MAX_SESSIONS) liveNoticeAt.delete(liveNoticeAt.keys().next().value);
    notify(notice(entry, kind, text));
  }

  function track(storedId, liveId, profile) {
    let entry = sessions.get(storedId);
    if (!entry) {
      entry = { storedId, liveId, profile: profile || "default", running: false, compacting: false, failureNoticed: false, lastSeq: null, resyncing: false, buffer: [] };
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
    if (event.type === "message.start") { entry.running = true; entry.compacting = false; entry.failureNoticed = false; updateTurnHold(); }
    // While Hermes compacts the conversation, a message waits for the next
    // turn. Compaction ends with a "compacted" status or the work going on.
    if (event.type === "status.update" && event.payload?.kind === "compacting") entry.compacting = true;
    if (event.type === "status.update" && event.payload?.kind === "compacted") entry.compacting = false;
    if (["message.delta", "reasoning.delta", "tool.start"].includes(event.type)) entry.compacting = false;
    if (event.type === "message.complete") offerMedia(event.payload?.text);
    publish(entry.storedId, event.type, trimPayload(event.type, event.payload));
    const failed = message => {
      if (entry.failureNoticed) return;
      entry.failureNoticed = true;
      if (!isWatched(entry.storedId)) notifyLive(entry, "failed", message);
    };
    if (event.type === "message.complete") {
      entry.running = false; entry.compacting = false;
      updateTurnHold();
      // A turn stopped with Stop is not a finished one.
      const ended = clip(event.payload?.status, 20);
      if (ended === "error") failed(clip(event.payload?.error, 2000) || event.payload?.text);
      else if (ended !== "interrupted" && event.payload?.interrupted !== true && !isWatched(entry.storedId)) notifyLive(entry, "completed", event.payload?.text);
    }
    if (event.type === "error") {
      entry.running = false; entry.compacting = false;
      updateTurnHold();
      failed(event.payload?.message);
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
      const resumed = await client.request("session.resume", { session_id: entry.storedId, profile: entry.profile, omit_messages: true, source: SOURCE }, { timeoutMs: 60_000 });
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
      speed: require("./agent-speed").unknownSpeed("speed_runtime_unverified"),
      asks: [...asks.values()].filter(ask => ask.sessionId === entry.storedId).map(ask => ({ ...ask })), ...extra };
  }

  async function status() {
    if (!installed()) return { installed: false };
    return { installed: true, ...(await client.status()), asks: asks.size };
  }

  async function bots() {
    const result = await client.request("profiles.list", { include_sessions: true }, { timeoutMs: 30_000 });
    const rows = [], avatarIndexes = avatarIndexesFor(result?.profiles);
    for (const row of Array.isArray(result?.profiles) ? result.profiles : []) {
      if (!row || typeof row.name !== "string" || !PROFILE.test(row.name)) continue;
      const meta = botMetaOf(row);
      const displayName = displayNameOf(row, meta);
      const chat = row.canonical_session && typeof row.canonical_session === "object" ? row.canonical_session : null;
      botNames.set(row.name, displayName);
      rows.push({ name: row.name, displayName, description: clip(row.description, 500) || clip(meta.description, 500),
        isDefault: row.is_default === true, hidden: meta.hidden === true, hasAvatar: row.has_avatar === true, color: COLOR.test(String(meta.color || "")) ? meta.color : null,
        avatarPreset: isPreset(meta.avatarPreset) ? meta.avatarPreset : null, avatarIndex: avatarIndexes.get(row.name),
        model: clip(row.model, 200), provider: clip(row.provider, 100),
        botChat: chat ? { id: clip(chat.resolved_id, 200) || clip(chat.id, 200), preview: clip(chat.preview, 300), lastActive: count(chat.last_active) } : null });
    }
    return { installId: clip(result?.install_id, 128), bots: rows };
  }

  // A routine's answer is found by looking, not listening: Hermes delivers it
  // and the Bot replies without the Host connected. Each check compares every
  // Bot Chat's last activity with the previous check, reads the newest page
  // when it moved, and pushes the Bot's answer to each routine message nobody
  // is watching. The first check only records where each Bot Chat stands, so
  // a restart does not replay old answers.
  async function checkRoutineReplies() {
    if (!installed() || !noticesWanted()) return { sent: 0 };
    const result = await client.request("profiles.list", { include_sessions: true }, { timeoutMs: 30_000 });
    let sent = 0;
    for (const row of Array.isArray(result?.profiles) ? result.profiles : []) {
      if (!row || typeof row.name !== "string" || !PROFILE.test(row.name)) continue;
      const chat = row.canonical_session && typeof row.canonical_session === "object" ? row.canonical_session : null;
      const ids = chat ? [...new Set([clip(chat.resolved_id, 200), clip(chat.id, 200)])].filter(id => SESSION.test(id)) : [];
      if (!ids.length) continue;
      botNames.set(row.name, displayNameOf(row, botMetaOf(row)));
      const active = count(chat.last_active), since = routineSince.get(row.name);
      if (since === undefined) { routineSince.set(row.name, active); continue; }
      if (active <= since) continue;
      // A page Hermes could not read is read again on the next check.
      try { sent += await pushRoutineAnswers(row.name, ids, since); routineSince.set(row.name, active); } catch {}
    }
    return { sent };
  }

  async function pushRoutineAnswers(profile, ids, since) {
    const page = await client.rest("GET", `/api/sessions/${encodeURIComponent(ids[0])}/messages`,
      { query: { profile, order: "latest", limit: ROUTINE_PAGE, inline_images: false } });
    let routine = null, sent = 0;
    const finish = () => {
      // An answer still being written is left for the next check.
      if (!routine?.answer || routine.answer.at <= since || routineSent.has(routine.key)) return;
      routineSent.add(routine.key);
      while (routineSent.size > MAX_ROUTINE_SENT) routineSent.delete(routineSent.values().next().value);
      if (ids.some(isWatched)) return;
      // The Host was connected when this answer arrived and already pushed it.
      const answeredAt = routine.answer.at * 1000;
      if (ids.some(id => (liveNoticeAt.get(id) || 0) >= answeredAt - LIVE_SKEW_MS)) return;
      notify({ ...notice({ profile, storedId: ids[0] }, "routine", routine.answer.text), title: `${botName(profile)} · ${routine.name}` });
      sent += 1;
    };
    for (const message of Array.isArray(page?.messages) ? page.messages : []) {
      const text = typeof message?.content === "string" ? message.content : "";
      if (message?.role === "user") {
        finish();
        const mark = ROUTINE_MARK.exec(text);
        routine = mark ? { name: mark[1], key: `${profile}:${message.id ?? message.timestamp ?? text.slice(0, 200)}`, answer: null } : null;
      } else if (message?.role === "assistant" && routine && text.trim()) {
        routine.answer = { text, at: Number(message.timestamp) || 0 };
      }
    }
    finish();
    return sent;
  }

  // The transcript comes over HTTP, not with the resume: Node's WebSocket drops
  // any message that unpacks to more than 4 MB and the connection with it, and a
  // resume carrying a long conversation grows past that (a Bot Chat of 710
  // messages was 4.06 MB), so such a Bot could no longer be opened.
  async function transcript(storedId, profile) {
    const rows = [];
    for (let offset = 0; offset < HISTORY_ROWS; offset += HISTORY_PAGE) {
      const page = await client.rest("GET", `/api/sessions/${encodeURIComponent(storedId)}/messages`,
        { query: { profile, order: "latest", limit: HISTORY_PAGE, offset, include_compacted: true, inline_images: false } });
      const got = Array.isArray(page?.messages) ? page.messages : [];
      rows.unshift(...got);
      if (got.length < HISTORY_PAGE) break;
    }
    return storedMessages(rows);
  }

  async function openSession({ sessionId, profile } = {}) {
    const storedId = sessionKey(sessionId);
    const name = profile ? profileName(profile) : sessions.get(storedId)?.profile || null;
    const resumed = await client.request("session.resume", { session_id: storedId, source: SOURCE, omit_messages: true, ...(name ? { profile: name } : {}) },
      { timeoutMs: 60_000 });
    if (typeof resumed?.session_id !== "string" || !resumed.session_id) throw new HermesError("hermes_session_failed", "Hermes could not open that conversation", 502);
    const key = typeof resumed.session_key === "string" && SESSION.test(resumed.session_key) ? resumed.session_key : storedId;
    const entry = track(key, resumed.session_id, name);
    entry.running = resumed.running === true;
    restoreAsks(entry, resumed.open_requests);
    updateTurnHold();
    // session.title 省略 title 時是唯讀，讓重載的歷史對話仍保有正確標題。
    const [named, history] = await Promise.all([
      client.request("session.title", { session_id: resumed.session_id }, { timeoutMs: 10_000 }).catch(() => ({ title: resumed.title })),
      transcript(key, name)]);
    return view(entry, { botChat: false, title: clip(named?.title, 300), messages: offerMessages(history),
      inflight: entry.running ? { user: clip(resumed.inflight?.user, MAX_TEXT), assistant: clip(resumed.inflight?.assistant, MAX_TEXT) } : null });
  }

  async function openBotChat(profile) {
    const name = profileName(profile);
    const found = await client.request("session.list", { profile: name, title: BOT_CHAT_TITLE, limit: 5, include_hidden: true }, { timeoutMs: 30_000 });
    const row = (Array.isArray(found?.sessions) ? found.sessions : []).find(item => typeof item?.id === "string" && SESSION.test(item.id));
    if (row) return { ...(await openSession({ sessionId: row.id, profile: name })), botChat: true };
    const created = await client.request("session.create",
      { profile: name, title: BOT_CHAT_TITLE, hidden: true, follow_profile_config: true, source: SOURCE }, { timeoutMs: 60_000 });
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
    // A message sent while the Bot works is added to the work under way
    // (Hermes's steer): nothing is thrown away, and the Bot takes it before
    // its next step. One it cannot add (the Bot has just finished, is
    // compacting, or the message carries files) waits for the next turn,
    // which queued asks for; it never interrupts the turn. Hermes's own
    // busy setting, which Telegram also follows, is left as it is.
    if (entry.running && !entry.compacting && !files.length) {
      const steered = await client.request("session.steer", { session_id: entry.liveId, text: body }).catch(() => null);
      if (steered?.status === "queued") return "steered";
    }
    const sent = await client.request("prompt.submit", { session_id: entry.liveId, text: body, queued: true });
    return ["queued", "steered", "redirected"].includes(sent?.status) ? sent.status : "started";
  }

  async function prompt({ sessionId, text, attachments } = {}) {
    const storedId = sessionKey(sessionId);
    const body = typeof text === "string" ? text : "";
    if (body.length > MAX_TEXT) throw invalid("text_too_long");
    const files = cleanAttachments(attachments);
    if (!body.trim() && !files.length) throw invalid("empty_message");
    if (!sessions.has(storedId)) await openSession({ sessionId: storedId });
    let entry = sessions.get(storedId), delivered;
    try { delivered = await submit(entry, body, files); } catch (error) {
      if (!/session not found/i.test(String(error?.message))) throw error;
      await openSession({ sessionId: storedId, profile: entry.profile });
      entry = sessions.get(storedId);
      delivered = await submit(entry, body, files);
    }
    entry.running = true;
    updateTurnHold();
    // delivered: started (a new turn), steered (added to the work under
    // way) or queued (waits for the next turn), for the page to say so.
    return { ok: true, delivered };
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
    return { sessions: rows.map(sessionRow).filter(keep), hasMore: rows.length === 30, nextOffset: start + rows.length };
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
    bots, checkRoutineReplies, openBotChat, openSession, prompt, interrupt, respond,
    pendingAsks: () => [...asks.values()].map(ask => ({ ...ask })),
    listSessions, renameSession, markRead, deleteSession, watch, subscribe, offerMedia, mediaFile,
    // The live ids of a Bot's conversations open now, for a setting to reach them at once.
    liveSessions: profile => [...sessions.values()].filter(entry => entry.profile === profile && entry.liveId).map(entry => entry.liveId),
  });
}

module.exports = { createHermesAssistantService, BOT_CHAT_TITLE, ROUTINE_CHECK_MS, MAX_TEXT, MAX_ATTACHMENTS, MAX_ATTACHMENT_BYTES };
