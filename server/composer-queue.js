"use strict";

// Messages sent while an agent works wait on the Host, one queue per
// conversation, shown as chips above the message box. When a turn ends the
// Host sends the next one by itself, one per turn, whether or not a page is
// open; "Send now" puts one into the turn under way instead. Stop pauses the
// queue: nothing more goes until it is resumed or the person sends again.
// Every change to a message names the revision it was read at, so two devices
// cannot send, edit or remove the same message twice.
//
// The text and pictures of each message are kept in a file of their own; the
// index holds what the chips show. A message the Host was sending when it
// stopped is never sent again by itself: it waits, marked for attention,
// until the person decides.

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { normalizeImages, IMAGE_LIMITS } = require("./prompt-attachments");

const AGENTS = Object.freeze(["pi", "codex", "claude-code"]);
const IMAGE_LIMIT = Object.freeze({ pi: IMAGE_LIMITS.pi, codex: IMAGE_LIMITS.codex, "claude-code": IMAGE_LIMITS.claude });
const MAX_ITEMS = 20;
const MAX_CONVERSATIONS = 200;
const MAX_TEXT = 1024 * 1024;
const PREVIEW_CHARS = 4000;
const MAX_INDEX_BYTES = 8 * 1024 * 1024;
const MAX_PAYLOAD_BYTES = 40 * 1024 * 1024;
// Delivered and removed messages stay in the snapshot this long, so every
// page showing the queue can tell a message that went from one taken back.
const RECENT_MS = 2 * 60_000;
const MAX_RECENT = 8;
const CONVERSATION_ID = /^[^\u0000-\u001f\u007f]{1,1024}$/;
const ITEM_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CHOICE = /^[^\s\u0000-\u001f\u007f]{1,256}$/;
const DEVICE = /^[A-Za-z0-9._:-]{1,128}$/;
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const WAITING = new Set(["queued", "failed", "attention"]);
const STATES = new Set(["queued", "dispatching", "failed", "attention"]);
const PAUSES = new Set(["stopped", "failed", "restart"]);

class ComposerQueueError extends Error {
  constructor(code, statusCode = 409, extra = {}) {
    super(code);
    this.code = code;
    this.statusCode = statusCode;
    Object.assign(this, extra);
  }
}
const fail = (code, statusCode = 409, extra = {}) => { throw new ComposerQueueError(code, statusCode, extra); };
const digest = text => crypto.createHash("sha256").update(String(text), "utf8").digest("hex");
const keyOf = (agent, id) => `${agent}:${id}`;

function validConversation(agent, id) {
  return AGENTS.includes(agent) && typeof id === "string" && CONVERSATION_ID.test(id);
}
function cleanText(value) {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string" || value.length > MAX_TEXT || CONTROL.test(value)) fail("queue_text_invalid", 400);
  return value;
}
function cleanChoice(value) {
  return typeof value === "string" && CHOICE.test(value.trim()) ? value.trim() : null;
}

function createComposerQueueStore({ file = null, now = Date.now } = {}) {
  if (file !== null && (typeof file !== "string" || !path.isAbsolute(file))) throw new TypeError("composer_queue_path_absolute_required");
  const directory = file ? path.join(path.dirname(file), `${path.basename(file, ".json")}-messages`) : null;
  const conversations = new Map();
  const memory = new Map();

  function payloadFile(itemId) { return path.join(directory, `${itemId}.json`); }
  function writePayload(itemId, value) {
    if (!directory) { memory.set(itemId, structuredClone(value)); return; }
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const target = payloadFile(itemId), temporary = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temporary, JSON.stringify(value), { encoding: "utf8", mode: 0o600 });
      fs.renameSync(temporary, target);
    } catch (error) { try { fs.rmSync(temporary, { force: true }); } catch {} throw error; }
  }
  function readPayload(itemId) {
    if (!directory) { const value = memory.get(itemId); if (!value) fail("queue_payload_missing", 410); return structuredClone(value); }
    let value;
    try {
      const target = payloadFile(itemId);
      if (fs.statSync(target).size > MAX_PAYLOAD_BYTES) fail("queue_payload_missing", 410);
      value = JSON.parse(fs.readFileSync(target, "utf8"));
    } catch (error) { if (error instanceof ComposerQueueError) throw error; fail("queue_payload_missing", 410); }
    return { text: typeof value?.text === "string" ? value.text : "", images: Array.isArray(value?.images) ? value.images : [] };
  }
  function deletePayload(itemId) {
    if (!directory) { memory.delete(itemId); return; }
    try { fs.rmSync(payloadFile(itemId), { force: true }); } catch {}
  }
  function payloadExists(itemId) {
    if (!directory) return memory.has(itemId);
    try { return fs.statSync(payloadFile(itemId)).isFile(); } catch { return false; }
  }

  function storedItem(item) {
    const { id, revision, state, mode, preview, length, imageCount, digest: hash, model, effort, createdAt, updatedAt, deviceId, error } = item;
    return { id, revision, state, mode, preview, length, imageCount, digest: hash, model, effort, createdAt, updatedAt, deviceId, error };
  }
  function save() {
    if (!file) return true;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
      const rows = [...conversations.values()].filter(row => row.items.length || row.paused).map(row => ({
        agent: row.agent, id: row.id, revision: row.revision, paused: row.paused, pauseReason: row.pauseReason, items: row.items.map(storedItem) }));
      fs.writeFileSync(temporary, JSON.stringify({ version: 1, conversations: rows }) + "\n", { encoding: "utf8", mode: 0o600 });
      fs.renameSync(temporary, file);
      return true;
    } catch { return false; }
  }

  function load() {
    if (!file) return;
    let value = null;
    try {
      const raw = fs.readFileSync(file, "utf8");
      if (Buffer.byteLength(raw) <= MAX_INDEX_BYTES) value = JSON.parse(raw);
    } catch {}
    let changed = false;
    const kept = new Set();
    for (const row of Array.isArray(value?.conversations) ? value.conversations.slice(0, MAX_CONVERSATIONS) : []) {
      if (!validConversation(row?.agent, row?.id)) { changed = true; continue; }
      const items = [];
      for (const item of Array.isArray(row.items) ? row.items.slice(0, MAX_ITEMS) : []) {
        if (!ITEM_ID.test(String(item?.id || "")) || !STATES.has(item.state) || kept.has(item.id) || !payloadExists(item.id)) { changed = true; continue; }
        const restored = { id: item.id, revision: Number.isSafeInteger(item.revision) && item.revision > 0 ? item.revision : 1, state: item.state,
          mode: item.mode === "jump" ? "jump" : item.mode === "start" ? "start" : null, stage: null,
          preview: typeof item.preview === "string" ? item.preview.slice(0, PREVIEW_CHARS) : "", length: Number.isSafeInteger(item.length) ? item.length : 0,
          imageCount: Number.isSafeInteger(item.imageCount) ? item.imageCount : 0, digest: typeof item.digest === "string" ? item.digest : "",
          model: cleanChoice(item.model), effort: cleanChoice(item.effort), createdAt: Number(item.createdAt) || now(), updatedAt: Number(item.updatedAt) || now(),
          deviceId: typeof item.deviceId === "string" && DEVICE.test(item.deviceId) ? item.deviceId : null,
          error: typeof item.error === "string" ? item.error.slice(0, 128) : null };
        // The Host stopped while this message was on its way: whether the agent
        // took it is unknown, so it is never sent again without the person.
        if (restored.state === "dispatching") {
          Object.assign(restored, { state: "attention", stage: null, error: "interrupted", revision: restored.revision + 1 });
          changed = true;
        }
        kept.add(item.id);
        items.push(restored);
      }
      // The turn these messages waited for ended with the Host; they wait for
      // the person to resume rather than going to an agent nobody watched start.
      let paused = row.paused === true, pauseReason = PAUSES.has(row.pauseReason) ? row.pauseReason : null;
      if (!paused && items.some(item => item.state === "queued")) { paused = true; pauseReason = "restart"; changed = true; }
      if (!items.length && !paused) { changed = true; continue; }
      conversations.set(keyOf(row.agent, row.id), { agent: row.agent, id: row.id, revision: (Number(row.revision) || 0) + 1,
        paused, pauseReason: paused ? pauseReason || "stopped" : null, items, recent: [] });
    }
    if (directory) {
      try {
        for (const name of fs.readdirSync(directory)) {
          const match = /^([0-9a-f-]{36})\.json$/.exec(name);
          if (match && !kept.has(match[1])) { fs.rmSync(path.join(directory, name), { force: true }); }
          else if (name.endsWith(".tmp")) fs.rmSync(path.join(directory, name), { force: true });
        }
      } catch {}
    }
    if (changed) save();
  }

  function row(agent, id, create = false) {
    const key = keyOf(agent, id);
    let value = conversations.get(key);
    if (!value && create) {
      if (conversations.size >= MAX_CONVERSATIONS) {
        for (const [other, entry] of conversations) if (!entry.items.length && !entry.paused) conversations.delete(other);
        if (conversations.size >= MAX_CONVERSATIONS) fail("queue_full", 429);
      }
      value = { agent, id, revision: 0, paused: false, pauseReason: null, items: [], recent: [] };
      conversations.set(key, value);
    }
    return value || null;
  }
  function touch(conversation) {
    conversation.revision += 1;
    if (!conversation.items.length && !conversation.paused && !conversation.recent.length) conversations.delete(keyOf(conversation.agent, conversation.id));
  }
  function itemOf(conversation, itemId, revision) {
    const item = conversation?.items.find(row => row.id === itemId);
    if (!item) fail("queue_item_missing", 404);
    if (revision !== undefined && revision !== item.revision) fail("queue_item_changed", 409);
    return item;
  }
  function trimRecent(conversation) {
    const cutoff = now() - RECENT_MS;
    conversation.recent = conversation.recent.filter(row => row.at >= cutoff).slice(-MAX_RECENT);
  }
  function publicItem(item) {
    return { id: item.id, revision: item.revision, state: item.state, stage: item.stage || null, mode: item.mode || null,
      text: item.preview, truncated: item.length > item.preview.length, imageCount: item.imageCount,
      createdAt: item.createdAt, deviceId: item.deviceId, error: item.error };
  }
  function snapshot(agent, id) {
    const conversation = validConversation(agent, id) ? row(agent, id) : null;
    if (conversation) trimRecent(conversation);
    return { agent, id, revision: conversation?.revision || 0, paused: !!conversation?.paused, pauseReason: conversation?.pauseReason || null,
      items: (conversation?.items || []).map(publicItem), recent: (conversation?.recent || []).map(row => ({ ...row })) };
  }
  function retire(conversation, item, outcome) {
    conversation.items.splice(conversation.items.indexOf(item), 1);
    deletePayload(item.id);
    conversation.recent.push({ id: item.id, state: outcome, at: now(), text: item.preview, truncated: item.length > item.preview.length, imageCount: item.imageCount });
    trimRecent(conversation);
  }
  function commit(conversation) {
    touch(conversation);
    save();
  }

  load();

  return Object.freeze({
    snapshot,
    /** Queues a message. Pictures follow the agent's own prompt budget. */
    add(agent, id, input = {}) {
      if (!validConversation(agent, id)) fail("queue_conversation_invalid", 400);
      const text = cleanText(input.text);
      const images = normalizeImages(input.images, { limit: IMAGE_LIMIT[agent] });
      if (!text.trim() && !images.length) fail("queue_text_invalid", 400);
      const conversation = row(agent, id, true);
      if (conversation.items.length >= MAX_ITEMS) fail("queue_full", 429);
      const at = now();
      const item = { id: crypto.randomUUID(), revision: 1, state: "queued", mode: null, stage: null, preview: text.slice(0, PREVIEW_CHARS), length: text.length,
        imageCount: images.length, digest: digest(text), model: cleanChoice(input.model), effort: cleanChoice(input.effort), createdAt: at, updatedAt: at,
        deviceId: typeof input.deviceId === "string" && DEVICE.test(input.deviceId) ? input.deviceId : null, error: null };
      try { writePayload(item.id, { text, images }); }
      catch { if (!conversation.items.length && !conversation.paused) conversations.delete(keyOf(agent, id)); fail("queue_unavailable", 503); }
      conversation.items.push(item);
      touch(conversation);
      if (!save()) {
        conversation.items.pop(); deletePayload(item.id);
        fail("queue_unavailable", 503);
      }
      return publicItem(item);
    },
    payload(agent, id, itemId) {
      itemOf(row(agent, id), itemId);
      return readPayload(itemId);
    },
    item(agent, id, itemId) {
      const item = row(agent, id)?.items.find(entry => entry.id === itemId);
      return item ? { ...item } : null;
    },
    items(agent, id) { return (row(agent, id)?.items || []).map(item => ({ ...item })); },
    paused(agent, id) { return !!row(agent, id)?.paused; },
    /** Replaces a waiting message's text; its pictures stay. */
    edit(agent, id, itemId, revision, text) {
      const conversation = row(agent, id), item = itemOf(conversation, itemId, revision);
      if (!WAITING.has(item.state)) fail("queue_item_busy", 409);
      const value = cleanText(text), payload = readPayload(itemId);
      if (!value.trim() && !payload.images.length) fail("queue_text_invalid", 400);
      writePayload(itemId, { ...payload, text: value });
      Object.assign(item, { preview: value.slice(0, PREVIEW_CHARS), length: value.length, digest: digest(value), revision: item.revision + 1,
        state: item.state === "failed" ? "queued" : item.state, error: null, updatedAt: now() });
      commit(conversation);
      return publicItem(item);
    },
    /** Removes a waiting message; with take its text and pictures come back. */
    remove(agent, id, itemId, revision, { take = false } = {}) {
      const conversation = row(agent, id), item = itemOf(conversation, itemId, revision);
      if (!WAITING.has(item.state)) fail("queue_item_busy", 409);
      const payload = take ? readPayload(itemId) : null;
      retire(conversation, item, take ? "taken" : "removed");
      commit(conversation);
      return take ? { item: publicItem(item), ...payload } : { item: publicItem(item) };
    },
    move(agent, id, itemId, revision, index) {
      const conversation = row(agent, id), item = itemOf(conversation, itemId, revision);
      if (!WAITING.has(item.state)) fail("queue_item_busy", 409);
      if (!Number.isSafeInteger(index) || index < 0 || index >= conversation.items.length) fail("queue_index_invalid", 400);
      conversation.items.splice(conversation.items.indexOf(item), 1);
      conversation.items.splice(index, 0, item);
      item.revision += 1; item.updatedAt = now();
      commit(conversation);
      return publicItem(item);
    },
    /** Takes a waiting message for sending; only one caller can win it. */
    claim(agent, id, itemId, revision, mode) {
      const conversation = row(agent, id), item = itemOf(conversation, itemId, revision);
      if (!WAITING.has(item.state)) fail("queue_item_busy", 409);
      Object.assign(item, { state: "dispatching", stage: "sending", mode: mode === "jump" ? "jump" : "start", error: null, revision: item.revision + 1, updatedAt: now() });
      commit(conversation);
      return publicItem(item);
    },
    /** The dispatcher's own changes to a message it holds. */
    mark(agent, id, itemId, { state, stage, error, front = false } = {}) {
      const conversation = row(agent, id), item = conversation?.items.find(entry => entry.id === itemId);
      if (!item) return null;
      if (state !== undefined) { item.state = state; if (state !== "dispatching") item.mode = null; }
      if (stage !== undefined) item.stage = stage;
      if (error !== undefined) item.error = error;
      if (front) { conversation.items.splice(conversation.items.indexOf(item), 1); conversation.items.unshift(item); }
      item.revision += 1; item.updatedAt = now();
      commit(conversation);
      return publicItem(item);
    },
    /** A message the agent confirmed: it leaves the queue. */
    deliver(agent, id, itemId) {
      const conversation = row(agent, id), item = conversation?.items.find(entry => entry.id === itemId);
      if (!item) return false;
      retire(conversation, item, "delivered");
      commit(conversation);
      return true;
    },
    pause(agent, id, reason = "stopped") {
      if (!validConversation(agent, id)) return false;
      const conversation = row(agent, id);
      if (!conversation?.items.length || conversation.paused && conversation.pauseReason === reason) return false;
      conversation.paused = true; conversation.pauseReason = PAUSES.has(reason) ? reason : "stopped";
      commit(conversation);
      return true;
    },
    /** Lets the queue go on; a message that failed is tried again. */
    resume(agent, id) {
      const conversation = validConversation(agent, id) ? row(agent, id) : null;
      if (!conversation?.paused) return false;
      conversation.paused = false; conversation.pauseReason = null;
      for (const item of conversation.items.filter(entry => entry.state === "failed")) Object.assign(item, { state: "queued", error: null, revision: item.revision + 1 });
      commit(conversation);
      return true;
    },
    pending() {
      return [...conversations.values()].filter(conversation => conversation.items.length).map(conversation => ({ agent: conversation.agent, id: conversation.id }));
    },
  });
}

// Each agent has a driver: which conversation an id names, whether the agent
// works now, how a message goes in, and what its events say about a turn
// ending or a message arriving.
function createComposerQueue({ store, drivers = {}, locked = () => false, onChange = () => {}, defer = callback => setImmediate(callback),
  setTimer = setTimeout, clearTimer = clearTimeout, setRepeat = setInterval, clearRepeat = clearInterval, sweepMs = 5000, log = () => {} } = {}) {
  if (!store) throw new TypeError("composer_queue_store_required");
  const inFlight = new Set();
  const confirmations = new Map();

  function driverOf(agent) {
    const driver = AGENTS.includes(agent) ? drivers[agent] : null;
    if (!driver) fail("queue_agent_unsupported", 400);
    return driver;
  }
  function conversation(agent, ref) {
    const driver = driverOf(agent);
    let id = null;
    try { id = driver.resolve(String(ref ?? "")); } catch {}
    if (!validConversation(agent, id)) fail("queue_conversation_unavailable", 404);
    return { driver, id };
  }
  function changed(agent, id) {
    try { onChange(agent, id, store.snapshot(agent, id)); } catch {}
  }
  function view(agent, id) {
    const value = store.snapshot(agent, id);
    let jump = true;
    try { jump = drivers[agent]?.canJump?.(id) !== false; } catch {}
    return { ...value, canJump: jump };
  }
  async function busy(driver, id) {
    try { return !!(await driver.busy(id)); } catch { return true; }
  }
  function clearConfirmation(itemId) {
    const timer = confirmations.get(itemId);
    if (timer) { clearTimer(timer); confirmations.delete(itemId); }
  }
  function delivered(agent, id, itemId) {
    clearConfirmation(itemId);
    return store.deliver(agent, id, itemId);
  }

  async function deliver(agent, id, itemId, { jump }) {
    const driver = drivers[agent];
    const item = store.item(agent, id, itemId);
    if (!item || item.state !== "dispatching") return null;
    let payload;
    try { payload = store.payload(agent, id, itemId); }
    catch {
      store.mark(agent, id, itemId, { state: "failed", stage: null, error: "queue_payload_missing" });
      store.pause(agent, id, "failed"); changed(agent, id);
      return "reject";
    }
    let result;
    try { result = await driver.deliver(id, item, payload, { jump }); }
    catch (error) { result = { kind: "reject", code: String(error?.code || "queue_delivery_failed").slice(0, 128) }; }
    const current = store.item(agent, id, itemId);
    // An event can confirm the message before its send call returns.
    if (!current || current.state !== "dispatching") { changed(agent, id); return result?.kind || null; }
    const kind = result?.kind;
    if (kind === "delivered") delivered(agent, id, itemId);
    else if (kind === "accepted") {
      store.mark(agent, id, itemId, { stage: current.stage === "native" ? "native" : "accepted" });
      // Without word from the agent within this time, its acceptance is
      // taken as delivery: an agent that reports nothing more still has it.
      if (Number.isFinite(result.confirmWithin) && result.confirmWithin > 0) {
        clearConfirmation(itemId);
        const timer = setTimer(() => {
          confirmations.delete(itemId);
          const waiting = store.item(agent, id, itemId);
          if (waiting?.state === "dispatching" && waiting.stage === "accepted") { delivered(agent, id, itemId); changed(agent, id); }
        }, result.confirmWithin);
        timer?.unref?.();
        confirmations.set(itemId, timer);
      }
    } else if (kind === "busy") store.mark(agent, id, itemId, { state: "queued", stage: null, front: true, error: null });
    else if (kind === "unsupported") store.mark(agent, id, itemId, { state: "queued", stage: null, front: true, error: "jump_unavailable" });
    else {
      store.mark(agent, id, itemId, { state: "failed", stage: null, error: String(result?.code || "queue_delivery_failed").slice(0, 128) });
      store.pause(agent, id, "failed");
    }
    changed(agent, id);
    return kind || "reject";
  }

  // Sends the first waiting message when the agent is free: after a turn
  // ends, when a message is queued to an idle agent, and on the sweep.
  async function dispatch(agent, id) {
    const key = keyOf(agent, id);
    if (inFlight.has(key)) return;
    inFlight.add(key);
    try {
      const driver = drivers[agent];
      const ready = () => {
        const items = store.items(agent, id);
        return !store.paused(agent, id) && !items.some(item => item.state === "dispatching") && items.find(item => item.state === "queued") || null;
      };
      if (!driver || !ready()) return;
      let free = false;
      try { free = !locked(agent, id) && driver.available(id) !== false; } catch {}
      if (!free || await busy(driver, id)) return;
      const head = ready();
      if (!head) return;
      try { store.claim(agent, id, head.id, head.revision, "start"); } catch { return; }
      changed(agent, id);
      await deliver(agent, id, head.id, { jump: false });
    } catch (error) { log(error); }
    finally { inFlight.delete(key); }
  }
  function kick(agent, id) { defer(() => { void dispatch(agent, id); }); }

  function observe(agent, sourceId, event) {
    const driver = drivers[agent];
    if (!driver?.fromEvent) return;
    let info = null;
    try { info = driver.fromEvent(sourceId, event); } catch {}
    const id = info?.id;
    if (!validConversation(agent, id)) return;
    const items = store.items(agent, id);
    if (!items.length) return;
    let touched = false;
    const holding = items.filter(item => item.state === "dispatching");
    const match = value => holding.find(item => item.id === value);
    if (info.native) {
      const item = match(info.native);
      if (item && item.stage !== "native") { store.mark(agent, id, item.id, { stage: "native" }); touched = true; }
    }
    if (info.delivered || info.deliveredText !== undefined) {
      const hash = info.deliveredText !== undefined ? digest(info.deliveredText) : null;
      const item = info.delivered ? match(info.delivered) : holding.find(entry => entry.digest === hash);
      if (item) touched = delivered(agent, id, item.id) || touched;
    }
    if (info.refused) {
      const item = match(info.refused);
      if (item) {
        clearConfirmation(item.id);
        store.mark(agent, id, item.id, { state: "failed", stage: null, error: String(info.code || "agent_refused").slice(0, 128) });
        store.pause(agent, id, "failed");
        touched = true;
      }
    }
    if (info.turnEnded) {
      // A message the agent took into the turn that just ended went with it;
      // one it still holds in its own queue waits for its own report.
      for (const item of store.items(agent, id).filter(entry => entry.state === "dispatching" && entry.stage === "accepted")) {
        if (info.turnEnded === "completed") delivered(agent, id, item.id);
        else { clearConfirmation(item.id); store.mark(agent, id, item.id, { state: "attention", stage: null, error: "turn_ended" }); }
        touched = true;
      }
      if (info.turnEnded === "stopped" || info.turnEnded === "failed") touched = store.pause(agent, id, info.turnEnded) || touched;
      else kick(agent, id);
    }
    if (touched) changed(agent, id);
  }

  const sweeper = sweepMs > 0 ? setRepeat(() => {
    for (const { agent, id } of store.pending()) void dispatch(agent, id);
  }, sweepMs) : null;
  sweeper?.unref?.();

  return Object.freeze({
    resolve(agent, ref) { return conversation(agent, ref).id; },
    snapshot(agent, ref) { const { id } = conversation(agent, ref); return view(agent, id); },
    /** A snapshot for a conversation id already resolved, or null. */
    snapshotOf(agent, id) { return validConversation(agent, id) ? view(agent, id) : null; },
    /** Whether a message sent now should wait: the agent works, or its queue still holds messages that go first. */
    async shouldQueue(agent, ref) {
      const { driver, id } = conversation(agent, ref);
      if (await busy(driver, id)) return true;
      return !store.paused(agent, id) && store.items(agent, id).some(item => item.state === "queued" || item.state === "dispatching");
    },
    add(agent, ref, input) {
      const { id } = conversation(agent, ref);
      const item = store.add(agent, id, input);
      changed(agent, id);
      kick(agent, id);
      return { item, queue: view(agent, id) };
    },
    edit(agent, ref, itemId, revision, text) {
      const { id } = conversation(agent, ref);
      const item = store.edit(agent, id, itemId, revision, text);
      changed(agent, id);
      return { item, queue: view(agent, id) };
    },
    remove(agent, ref, itemId, revision) {
      const { id } = conversation(agent, ref);
      const result = store.remove(agent, id, itemId, revision);
      changed(agent, id);
      return { ...result, queue: view(agent, id) };
    },
    /** Edit in the composer: the message comes back whole and leaves the queue. */
    take(agent, ref, itemId, revision) {
      const { id } = conversation(agent, ref);
      const result = store.remove(agent, id, itemId, revision, { take: true });
      changed(agent, id);
      return { ...result, queue: view(agent, id) };
    },
    move(agent, ref, itemId, revision, index) {
      const { id } = conversation(agent, ref);
      const item = store.move(agent, id, itemId, revision, index);
      changed(agent, id);
      return { item, queue: view(agent, id) };
    },
    /** Puts a message into the turn under way, or starts one with it. */
    async sendNow(agent, ref, itemId, revision) {
      const { driver, id } = conversation(agent, ref);
      if (locked(agent, id)) fail("queue_conversation_locked", 409);
      store.claim(agent, id, itemId, revision, "jump");
      store.resume(agent, id);
      changed(agent, id);
      const outcome = await deliver(agent, id, itemId, { jump: await busy(driver, id) });
      return { outcome, queue: view(agent, id) };
    },
    resume(agent, ref) {
      const { id } = conversation(agent, ref);
      if (store.resume(agent, id)) changed(agent, id);
      kick(agent, id);
      return { queue: view(agent, id) };
    },
    /** Stop: nothing more goes in by itself until the person says so. */
    pause(agent, ref, reason = "stopped") {
      let id;
      try { id = conversation(agent, ref).id; } catch { return false; }
      const paused = store.pause(agent, id, reason);
      if (paused) changed(agent, id);
      return paused;
    },
    /** Messages taken back from the agent's own queue at Stop wait here again. */
    reclaim(agent, ref, texts) {
      let id;
      try { id = conversation(agent, ref).id; } catch { return; }
      for (const text of Array.isArray(texts) ? texts : []) {
        if (typeof text !== "string" || !text.trim()) continue;
        const held = store.items(agent, id).find(item => item.state === "dispatching" && item.digest === digest(text));
        if (held) { clearConfirmation(held.id); store.mark(agent, id, held.id, { state: "queued", stage: null }); }
        else { try { store.add(agent, id, { text }); } catch {} }
      }
      store.pause(agent, id, "stopped");
      changed(agent, id);
    },
    /** A message sent the ordinary way picks a paused queue up again. */
    noteDirectSend(agent, ref) {
      let id;
      try { id = conversation(agent, ref).id; } catch { return; }
      if (store.resume(agent, id)) changed(agent, id);
    },
    observe,
    dispatch,
    close() { if (sweeper) clearRepeat(sweeper); for (const itemId of [...confirmations.keys()]) clearConfirmation(itemId); },
  });
}

const PROMPT_BODY_BYTES = 28 * 1024 * 1024;
const ROUTES = new Set(["add", "edit", "remove", "take", "move", "send-now", "resume"]);

// Called only inside the main authenticated, origin-checked API block.
function createComposerQueueRoutes({ queue, readJSON, sendJSON, admit = () => null }) {
  const reply = (res, error, current = null) => {
    const known = error instanceof ComposerQueueError, code = known ? error.code : String(error?.code || "queue_unavailable");
    sendJSON(res, known ? error.statusCode : error?.statusCode || 503, { error: code, code, ...(current ? { queue: current } : {}) });
  };
  return async function handle(req, res, url) {
    const p = url.pathname;
    if (p === "/api/composer-queue" && req.method === "GET") {
      try { sendJSON(res, 200, { queue: queue.snapshot(String(url.searchParams.get("agent") || ""), url.searchParams.get("id")) }); }
      catch (error) { reply(res, error); }
      return true;
    }
    const action = p.startsWith("/api/composer-queue/") ? p.slice("/api/composer-queue/".length) : "";
    if (!ROUTES.has(action) || req.method !== "POST") return false;
    let agent = "", ref = null;
    try {
      const body = await readJSON(req, action === "add" ? PROMPT_BODY_BYTES : action === "edit" ? MAX_TEXT * 4 + 4096 : 16 * 1024);
      agent = String(body?.agent || ""); ref = body?.id;
      const itemId = typeof body?.itemId === "string" ? body.itemId : "", revision = Number(body?.revision);
      if (action !== "add" && action !== "resume" && (!ITEM_ID.test(itemId) || !Number.isSafeInteger(revision))) fail("queue_item_invalid", 400);
      if (action === "add" || action === "send-now") {
        const refused = admit(agent, ref);
        if (refused) fail(refused, 409);
      }
      const result = action === "add" ? queue.add(agent, ref, { text: body.text, images: body.images, model: body.model, effort: body.effort, deviceId: body.deviceId })
        : action === "edit" ? queue.edit(agent, ref, itemId, revision, body.text)
          : action === "remove" ? queue.remove(agent, ref, itemId, revision)
            : action === "take" ? queue.take(agent, ref, itemId, revision)
              : action === "move" ? queue.move(agent, ref, itemId, revision, Number(body.index))
                : action === "send-now" ? await queue.sendNow(agent, ref, itemId, revision)
                  : queue.resume(agent, ref);
      sendJSON(res, 200, action === "add" ? { queued: true, ...result } : result);
    } catch (error) {
      // A message changed on another device: the page gets the queue as it is.
      let current = null;
      if (["queue_item_changed", "queue_item_busy", "queue_item_missing"].includes(error?.code)) {
        try { current = queue.snapshot(agent, ref); } catch {}
      }
      reply(res, error, current);
    }
    return true;
  };
}

module.exports = { AGENTS, MAX_ITEMS, PREVIEW_CHARS, ComposerQueueError, createComposerQueueStore, createComposerQueue, createComposerQueueRoutes };
