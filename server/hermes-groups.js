"use strict";

// Group chats are Hermes hosted rooms: Hermes schedules who speaks and reads
// @mentions; this module only creates rooms of local Bots, sends the user's
// messages, and reads the room log and state back. Nothing is stored here.

const { randomUUID } = require("node:crypto");
const { HermesError } = require("./hermes-gateway-client");

const PROFILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const THREAD = "main";
const invalid = code => new HermesError(code, code, 400);
const clip = (value, max) => (typeof value === "string" ? value.slice(0, max) : "");

function roomId(value) {
  const id = String(value || "");
  if (!ID.test(id)) throw invalid("invalid_room");
  return id;
}
function title(value) {
  const name = String(value || "").replace(/[\r\n]+/g, " ").trim().slice(0, 120);
  if (!name) throw invalid("invalid_name");
  return name;
}

// A mention handle from the Bot's name: lower case, letters, digits and dashes,
// unique in the room, and never the reserved @all or @everyone.
function handleFor({ profile, displayName }, used) {
  const slug = value => String(value || "").toLowerCase().normalize("NFKD").replace(/[^a-z0-9._-]+/g, "-").replace(/^[^a-z0-9]+|[-._]+$/g, "").slice(0, 40);
  let base = slug(displayName) || slug(profile) || "bot";
  if (base === "all" || base === "everyone") base = `${base}-bot`;
  let handle = base;
  for (let index = 2; used.has(handle); index += 1) handle = `${base}-${index}`;
  used.add(handle);
  return handle;
}

function room(row) {
  if (!row || typeof row.room_id !== "string") return null;
  return {
    id: row.room_id, name: clip(row.name, 200),
    members: (Array.isArray(row.members) ? row.members : []).map(member => ({ memberId: clip(member?.member_id, 128), profile: clip(member?.profile, 64),
      handle: clip(member?.handle, 64), displayName: clip(member?.display_name, 120) || clip(member?.handle, 64) })),
    updatedAt: Number(row.updated_at) || 0, latestSeq: Number(row.latest_seq) || 0, disbanded: row.disbanded_at !== null && row.disbanded_at !== undefined,
  };
}

function event(row) {
  const payload = row?.payload && typeof row.payload === "object" ? row.payload : {};
  const actor = row?.actor && typeof row.actor === "object" ? row.actor : {};
  return { seq: Number(row?.seq) || 0, kind: clip(row?.kind, 64), text: clip(payload.text, 256 * 1024),
    memberId: clip(payload.member_id, 128) || (actor.kind === "member" ? clip(actor.id, 128) : ""), name: clip(payload.name, 200),
    createdAt: Number(row?.created_at) || 0 };
}

function createHermesGroups({ client }) {
  async function call(method, params) {
    try { return await client.request(method, params, { timeoutMs: 30_000 }); } catch (error) {
      if (error?.code === "hermes_rpc_error" && /not found/i.test(error.message) && error.rpcCode !== -32601) {
        throw new HermesError("room_not_found", error.message, 404);
      }
      throw error;
    }
  }

  // Hermes runs group turns itself only when its room driver is on; older or
  // replica-only gateways cannot, and the page says Hermes needs an update.
  async function capabilities() {
    try { return { supported: (await client.request("groups.capabilities", {}, { timeoutMs: 15_000 }))?.driver === true }; } catch (error) {
      if (error?.rpcCode === -32601) return { supported: false };
      throw error;
    }
  }
  async function list() {
    const result = await call("groups.list", { limit: 100 });
    return { rooms: (Array.isArray(result?.rooms) ? result.rooms : []).map(room).filter(row => row && !row.disbanded) };
  }
  async function create({ name, members } = {}) {
    const label = title(name);
    if (!Array.isArray(members) || members.length < 2 || members.length > 6) throw invalid("invalid_members");
    const used = new Set(), seen = new Set();
    const roster = members.map(member => {
      const profile = String(member?.profile || "");
      if (!PROFILE.test(profile) || seen.has(profile)) throw invalid("invalid_members");
      seen.add(profile);
      const displayName = String(member?.displayName || profile).trim().slice(0, 80) || profile;
      return { member_id: profile, profile, handle: handleFor({ profile, displayName }, used), display_name: displayName };
    });
    const result = await call("groups.create", { room_id: `stepsemble-${randomUUID()}`, name: label, members: roster });
    return { room: room(result?.room) };
  }
  async function send(id, text) {
    const body = typeof text === "string" ? text : "";
    if (!body.trim()) throw invalid("empty_message");
    if (body.length > 64 * 1024) throw invalid("text_too_long");
    await call("groups.send", { room_id: roomId(id), event_id: `stepsemble-${randomUUID()}`, payload: { text: body, thread_id: THREAD } });
    return { ok: true };
  }
  async function log(id, since = 0) {
    const from = Number.isSafeInteger(Number(since)) && Number(since) >= 0 ? Number(since) : 0;
    const result = await call("groups.log", { room_id: roomId(id), since_seq: from, limit: 200 });
    const events = (Array.isArray(result?.events) ? result.events : []).map(event);
    return { events, cursor: Number(result?.cursor) || events.at(-1)?.seq || from, hasMore: result?.has_more === true };
  }
  async function state(id) {
    const result = await call("groups.state", { room_id: roomId(id) });
    const status = result?.driver_status && typeof result.driver_status === "object" ? result.driver_status : {};
    const actions = Array.isArray(status.pending_actions) ? status.pending_actions : [];
    return {
      room: room(result?.room), working: status.working === true,
      approvals: actions.filter(action => action?.kind === "approval").map(action => ({ memberId: clip(action.member_id, 128), taskId: clip(action.task_id, 128),
        executionGeneration: Number(action.execution_generation) || 0, requestId: clip(action.request_id, 128),
        command: clip(action.approval?.command, 4000), description: clip(action.approval?.description, 2000),
        choices: (Array.isArray(action.approval?.choices) ? action.approval.choices : ["once", "deny"]).filter(choice => choice === "once" || choice === "deny") })),
      retries: actions.filter(action => action?.kind === "retry").map(action => ({ taskId: clip(action.task_id, 128) })),
    };
  }
  async function approve(id, { memberId, taskId, executionGeneration, requestId, choice } = {}) {
    if (choice !== "once" && choice !== "deny") throw invalid("invalid_choice");
    for (const value of [memberId, taskId, requestId]) if (!ID.test(String(value || ""))) throw invalid("invalid_request");
    if (!Number.isSafeInteger(executionGeneration) || executionGeneration < 0) throw invalid("invalid_request");
    await call("groups.approve", { room_id: roomId(id), member_id: memberId, task_id: taskId, execution_generation: executionGeneration, choice, request_id: requestId });
    return { ok: true };
  }
  async function retry(id, taskId) {
    if (!ID.test(String(taskId || ""))) throw invalid("invalid_request");
    await call("groups.retry", { room_id: roomId(id), task_id: taskId });
    return { ok: true };
  }
  async function rename(id, name) {
    const result = await call("groups.rename", { room_id: roomId(id), event_id: `stepsemble-${randomUUID()}`, name: title(name) });
    return { room: room(result?.room) };
  }
  const simple = method => async id => { await call(method, { room_id: roomId(id) }); return { ok: true }; };

  return Object.freeze({ capabilities, list, create, send, log, state, approve, retry, rename, stop: simple("groups.stop"), disband: simple("groups.disband") });
}

module.exports = { createHermesGroups, handleFor };
