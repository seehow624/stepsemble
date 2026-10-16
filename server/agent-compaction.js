"use strict";

// One explicit native compaction of an owned conversation, never a summary
// prompt or a new session. Capabilities and results stay separate from IO.
const { randomUUID } = require("node:crypto");
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const MAX_OPERATIONS = 200;
const NAMES = ["compact", "compress", "summarize"];
// "uncertain" ends the operation without claiming success; nothing retries it.
const ACTIVE = new Set(["running"]);
const error = (code, statusCode = 409) => Object.assign(new Error(code), { code, statusCode });
const copy = value => structuredClone(value);

// Only a session's native announcement authorizes an ACP slash command. A
// model reply, a nearby spelling or a name from another session never does.
function normalizeCompactCommand(commands) {
  if (!Array.isArray(commands)) return null;
  for (const name of NAMES) {
    const command = commands.slice(0, 256).find(row => row?.name === name);
    if (!command) continue;
    const hint = command.input?.hint;
    return { command: name, instructions: typeof hint === "string" && hint.trim().length > 0 && hint.length <= 1000 && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(hint) };
  }
  return null;
}
// ACP commands are advertised per live session, including announcements that
// arrive before session/new returns its id. Store only this one capability.
function createAdvertisedCompaction({ ready, session, permissions, prompt }) {
  const commands = new Map();
  function observe(id, update) {
    if (update?.sessionUpdate !== "available_commands_update") return;
    const command = normalizeCompactCommand(update.availableCommands);
    commands.delete(id);
    if (command) commands.set(id, command);
    while (commands.size > 100) commands.delete(commands.keys().next().value);
  }
  function support(id) {
    const current = session(id), command = commands.get(id);
    if (!ready() || !current || !command) return { supported: false, instructions: false, reason: "compaction_unavailable" };
    const approval = permissions().some(row => (row.sessionId || row.params?.sessionId) === id);
    return { ...command, supported: true, reason: null, busy: current.promptInFlight === true || current.status === "running" || approval };
  }
  async function compact(id, { instructions = "" } = {}) {
    const capability = support(id);
    if (!capability.supported) return { kind: "reject", code: "compaction_unavailable" };
    if (capability.busy) return { kind: "reject", code: "compaction_busy" };
    if (typeof instructions !== "string" || instructions.length > 16000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(instructions)) return { kind: "reject", code: "compaction_invalid_request" };
    if (instructions.trim() && !capability.instructions) return { kind: "reject", code: "compaction_instructions_unavailable" };
    const result = await prompt(id, `/${capability.command}${instructions.trim() ? " " + instructions.trim() : ""}`);
    if (result?.kind === "reject") return result;
    return result?.kind === "prompted" && result.result?.stopReason === "end_turn" ? { completed: true } : { kind: "reject", code: "compaction_interrupted" };
  }
  return { observe, support, compact };
}
function identity(record) {
  return JSON.stringify([record.agentId, record.sid || null, record.id || record.taskId || null,
    record.nativeThreadId || null, record.nativeSessionId || null, record.cwd || null]);
}
function cleanError(value) {
  const code = value?.code;
  return typeof code === "string" && /^[a-z][a-z0-9_.:-]{1,95}$/i.test(code) ? code : "compaction_failed";
}
function parseInput(body) {
  if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some(key => !["entry", "requestId", "instructions"].includes(key))) throw error("compaction_invalid_request", 400);
  if (!UUID.test(body.entry || "") || !UUID.test(body.requestId || "")) throw error("compaction_invalid_request", 400);
  const instructions = body.instructions === undefined ? "" : body.instructions;
  if (typeof instructions !== "string" || instructions.length > 16000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(instructions)) throw error("compaction_invalid_request", 400);
  return { entry: body.entry, requestId: body.requestId.toLowerCase(), instructions: instructions.trim() };
}
function createAgentCompaction({ resolve, describe, run, goalLocked = () => false, reserve = () => {}, now = Date.now } = {}) {
  const operations = new Map(), requests = new Map(), admissions = new Map();
  let closed = false;
  function membership(key) {
    if (closed) throw error("compaction_closed", 503);
    if (!UUID.test(key || "")) throw error("compaction_invalid_request", 400);
    const entry = resolve(key);
    if (!entry?.record) throw error("workspace_entry_not_found", 404);
    return entry;
  }
  function restriction(entry) {
    const record = entry.record;
    if (record.agentId === "hermes") return "compaction_excluded";
    if (record.nativeHistoryReadonly || record.readOnly && !(record.nativeCodex && record.mutation === "native_api")) return "compaction_readonly";
    if (goalLocked(entry.key)) return "compaction_goal_owned";
    return null;
  }
  function locked(key) { return admissions.has(key) || ACTIVE.has(operations.get(key)?.status); }
  function release(job) { if (job.reserved) { job.reserved = false; reserve(false); } }
  function publicOperation(job) {
    if (!job) return null;
    const out = { id: job.id, status: job.status, error: job.error, startedAt: job.startedAt, endedAt: job.endedAt };
    for (const key of ["beforeTokens", "afterTokens"]) if (Number.isSafeInteger(job[key]) && job[key] >= 0) out[key] = job[key];
    if (job.estimated === true && (out.beforeTokens !== undefined || out.afterTokens !== undefined)) out.estimated = true;
    return out;
  }
  function response(key, capability, job = operations.get(key)) {
    return { supported: capability.supported === true, instructions: capability.instructions === true,
      reason: capability.reason || null, busy: capability.busy === true || locked(key), operation: publicOperation(job) };
  }
  async function inspect(key) {
    const entry = membership(key), reason = restriction(entry);
    if (reason) return response(key, { supported: false, instructions: false, reason });
    const capability = await describe(copy(entry.record));
    const current = membership(key);
    if (identity(current.record) !== identity(entry.record)) throw error("compaction_conversation_changed");
    return response(key, capability);
  }
  async function execute(job, record, instructions) {
    try {
      if (closed) return;
      const current = membership(job.entry);
      if (identity(current.record) !== job.scope) throw error("compaction_conversation_changed");
      const reason = restriction(current);
      if (reason) throw error(reason);
      const result = await run(copy(record), { instructions });
      if (closed) return;
      if (result?.completed !== true) throw error("compaction_not_confirmed");
      job.status = "completed"; job.error = null;
      for (const key of ["beforeTokens", "afterTokens"]) if (Number.isSafeInteger(result[key]) && result[key] >= 0) job[key] = result[key];
      job.estimated = result.estimated === true;
    } catch (failure) {
      if (closed) return;
      job.error = cleanError(failure);
      job.status = /timeout|unconfirmed|not_confirmed|result_unknown/.test(job.error) ? "uncertain" : "failed";
    } finally {
      if (!closed) { job.endedAt = now(); release(job); }
    }
  }
  async function start(body) {
    const input = parseInput(body), entry = membership(input.entry), requestKey = `${input.entry}:${input.requestId}`;
    const prior = requests.get(requestKey);
    if (prior) {
      if (prior.instructions !== input.instructions) throw error("compaction_request_conflict");
      return response(input.entry, prior.capability, prior);
    }
    const admission = admissions.get(input.entry);
    if (admission) {
      if (admission.requestId !== input.requestId) throw error("compaction_busy");
      if (admission.instructions !== input.instructions) throw error("compaction_request_conflict");
      return admission.promise;
    }
    if (locked(input.entry)) throw error("compaction_busy");
    const scope = identity(entry.record), marker = { ...input };
    const promise = (async () => {
      const reason = restriction(entry);
      if (reason) throw error(reason);
      const capability = await describe(copy(entry.record));
      const current = membership(input.entry);
      if (identity(current.record) !== scope) throw error("compaction_conversation_changed");
      const changedReason = restriction(current);
      if (changedReason) throw error(changedReason);
      if (!capability.supported) throw error(capability.reason || "compaction_unavailable");
      if (capability.busy) throw error("compaction_busy");
      if (input.instructions && !capability.instructions) throw error("compaction_instructions_unavailable", 400);
      while (requests.size >= MAX_OPERATIONS) {
        const disposable = [...requests].find(([, job]) => !ACTIVE.has(job.status));
        if (!disposable) throw error("compaction_capacity", 503);
        requests.delete(disposable[0]);
      }
      const job = { id: randomUUID(), entry: input.entry, scope, instructions: input.instructions, capability: copy(capability),
        status: "running", error: null, startedAt: now(), endedAt: null, reserved: true };
      reserve(true); operations.set(input.entry, job); requests.set(requestKey, job);
      // Admission is committed before the native operation starts; reconnects
      // poll this operation rather than submitting it again.
      void Promise.resolve().then(() => execute(job, copy(current.record), input.instructions));
      return response(input.entry, capability, job);
    })();
    marker.promise = promise; admissions.set(input.entry, marker);
    try { return await promise; }
    finally { if (admissions.get(input.entry) === marker) admissions.delete(input.entry); }
  }
  function close() {
    closed = true;
    for (const job of requests.values()) release(job);
    admissions.clear();
  }
  return { inspect, start, locked, close };
}
function createCompactionRoutes({ service, readJSON, sendJSON }) {
  return async function handle(req, res, url) {
    if (url.pathname !== "/api/agent/compaction" || !["GET", "POST"].includes(req.method)) return false;
    try {
      const state = req.method === "GET" ? await service.inspect(url.searchParams.get("entry")) : await service.start(await readJSON(req, 20000));
      sendJSON(res, req.method === "POST" && state.operation?.status === "running" ? 202 : 200, state);
    } catch (failure) { sendJSON(res, failure.statusCode || 500, { error: cleanError(failure), code: cleanError(failure) }); }
    return true;
  };
}
module.exports = { normalizeCompactCommand, createAdvertisedCompaction, createAgentCompaction, createCompactionRoutes };
