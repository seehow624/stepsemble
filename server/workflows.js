"use strict";

// Host-owned Goals and schedules. Browser lifetime never owns execution.
const fs = require("node:fs"), path = require("node:path"), { randomUUID } = require("node:crypto");
const ACTIVE = new Set(["starting", "running", "waiting"]);
const RESUMABLE = new Set(["paused", "blocked", "interrupted"]);
const AGENTS = ["pi", "codex", "claude-code", "omp", "opencode", "cline", "kilo", "hermes", "grok-build"];
const clone = value => JSON.parse(JSON.stringify(value));
function invalid(message, statusCode = 400) { return Object.assign(new Error(message), { statusCode }); }
function text(value, max, label) {
  if (typeof value !== "string" || !value.trim() || value.length > max || value.includes("\0")) throw invalid(`Invalid ${label}`);
  return value.trim();
}
function integer(value, fallback, min, max) {
  const n = value === undefined ? fallback : value;
  if (!Number.isSafeInteger(n) || n < min || n > max) throw invalid("Invalid task limit");
  return n;
}
function definition(body) {
  const agentId = text(body.agentId, 32, "agent");
  if (!AGENTS.includes(agentId)) throw invalid("This agent does not support background Goals");
  return { title: text(body.title, 120, "title"), objective: text(body.objective, 16000, "objective"),
    agentId, cwd: text(body.cwd, 4096, "project"), mode: body.mode === "task" ? "task" : "goal",
    limits: { minutes: integer(body.limits?.minutes, 60, 1, 1440), turns: integer(body.limits?.turns, 20, 1, 100),
      outputTokens: integer(body.limits?.outputTokens, 100000, 100, 10000000) } };
}
function scheduleSpec(value, now) {
  if (!value || !["once", "daily", "weekly", "interval"].includes(value.kind)) throw invalid("Invalid schedule");
  if (value.kind === "once") {
    const at = Date.parse(value.at);
    if (!Number.isFinite(at) || at <= now) throw invalid("Choose a future date and time");
    return { kind: "once", at: new Date(at).toISOString() };
  }
  if (value.kind === "interval") return { kind: "interval", minutes: integer(value.minutes, 60, 15, 10080) };
  const time = text(value.time, 5, "time"), zone = text(value.timeZone, 100, "time zone");
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw invalid("Invalid schedule time");
  try { new Intl.DateTimeFormat("en", { timeZone: zone }).format(now); } catch { throw invalid("Invalid time zone"); }
  const days = value.kind === "weekly" ? value.days : [0,1,2,3,4,5,6];
  if (!Array.isArray(days) || !days.length || days.some(day => !Number.isInteger(day) || day < 0 || day > 6)) throw invalid("Choose a weekday");
  return { kind: value.kind, time, timeZone: zone, days: [...new Set(days)].sort() };
}
function nextOccurrence(spec, after, previous = null) {
  if (spec.kind === "once") return Date.parse(spec.at) > after ? Date.parse(spec.at) : null;
  if (spec.kind === "interval") return after + spec.minutes * 60000;
  const fmt = new Intl.DateTimeFormat("en-US", { timeZone: spec.timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23", weekday: "short" });
  const parts = at => Object.fromEntries(fmt.formatToParts(at).map(p => [p.type, p.value]));
  const dayKey = p => `${p.year}-${p.month}-${p.day}`;
  const previousDay = previous === null ? null : dayKey(parts(previous));
  // Minutes are real instants: DST gaps are skipped and folded wall times run once.
  for (let at = Math.floor(after / 60000) * 60000 + 60000, end = at + 9 * 86400000; at < end; at += 60000) {
    const p = parts(at), day = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"].indexOf(p.weekday);
    if (`${p.hour}:${p.minute}` === spec.time && spec.days.includes(day) && dayKey(p) !== previousDay) return at;
  }
  throw invalid("Could not determine the next scheduled time");
}
function goalPrompt(run) {
  const marker = status => `[[STEPSEMBLE_GOAL:${run.nonce}:${status}]]`;
  return `${run.turns ? "Continue the existing goal from the current conversation. Do not repeat completed work." : run.objective}\n\n[Stepsemble Goal]\nObjective: ${run.objective}\nWork within the user's permissions and project instructions. Never bypass approvals. Check the completion criteria and report what was verified. If the goal is complete, end your final answer with this exact line: ${marker("complete")}\nIf you need user input, credentials, approval, or an external change before you can make progress, explain the blocker and end with: ${marker("blocked")}\nOtherwise make useful progress in this turn; the Host can continue it. This is turn ${run.turns + 1} of at most ${run.limits.turns}.`;
}
function outcome(run, result) {
  const value = String(result.text || "").trim();
  if (result.error) return "failed";
  if (run.mode === "task") return "completed";
  if (value.endsWith(`[[STEPSEMBLE_GOAL:${run.nonce}:complete]]`)) return "completed";
  if (value.endsWith(`[[STEPSEMBLE_GOAL:${run.nonce}:blocked]]`)) return "blocked";
  return null;
}
function createWorkflows({ file, bridge, now = Date.now, autoStart = true, onError = () => {}, onFinished = () => {} }) {
  let state = { version: 1, schedules: [], runs: [] }, healthy = true, closed = false, ticking = false;
  const inflight = new Map();
  try {
    const stat = fs.statSync(file); if (stat.size > 16 * 1024 * 1024) throw new Error("Workflow state too large");
    const saved = JSON.parse(fs.readFileSync(file, "utf8"));
    if (saved.version !== 1 || !Array.isArray(saved.runs) || !Array.isArray(saved.schedules)) throw new Error("Invalid workflow state");
    if (saved.runs.length > 200 || saved.schedules.length > 100) throw new Error("Too many saved tasks");
    const ids = new Set();
    for (const row of [...saved.runs,...saved.schedules]) {
      if (!row || !/^[a-f0-9-]{36}$/.test(row.id) || ids.has(row.id)) throw new Error("Invalid saved task identity");
      ids.add(row.id); definition(row);
      if (row.schedule) {
        scheduleSpec(row.schedule, row.schedule.kind === "once" ? Date.parse(row.schedule.at) - 1 : now());
        if (typeof row.enabled !== "boolean" || row.nextAt !== null && !Number.isFinite(row.nextAt)) throw new Error("Invalid saved schedule");
      } else if (![...ACTIVE,...RESUMABLE,"queued","stopping","limited","completed","failed","stopped"].includes(row.status)
        || !/^[a-f0-9-]{36}$/.test(row.nonce) || !Number.isFinite(row.elapsedMs) || row.elapsedMs < 0
        || !Number.isSafeInteger(row.turns) || row.turns < 0 || !Number.isFinite(row.outputTokens) || row.outputTokens < 0
        || row.resumedAt !== null && !Number.isFinite(row.resumedAt)) throw new Error("Invalid saved Goal");
    }
    state = saved;
  } catch (error) { if (error.code !== "ENOENT") { healthy = false; onError(error); } }
  function save() {
    if (!healthy) throw invalid("Task storage is unavailable; existing data was preserved", 503);
    const tmp = `${file}.${randomUUID()}.tmp`;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      fs.writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 }); fs.renameSync(tmp, file);
    } catch (error) { healthy = false; try { fs.unlinkSync(tmp); } catch {} onError(error);
      for (const [id, controller] of inflight) { controller.abort(); const run = state.runs.find(r => r.id === id); if (run) void Promise.resolve().then(() => bridge.stop(run)).catch(onError); }
      throw invalid("Could not save tasks; no further work will be started", 503); }
  }
  function elapsed(run) { return run.elapsedMs + (run.resumedAt === null ? 0 : Math.max(0, now() - run.resumedAt)); }
  function finish(run, status, error = null) {
    run.elapsedMs = elapsed(run); run.resumedAt = null; run.status = status; run.activity = status;
    run.error = error; run.updatedAt = now(); run.endedAt = now(); save();
    try { onFinished(summary(run)); } catch (error) { onError(error); }
  }
  // An uncertain send is never replayed on Host restart.
  if (healthy) {
    let changed = false;
    for (const run of state.runs) if (ACTIVE.has(run.status) || run.status === "stopping") {
      run.elapsedMs = (run.elapsedMs || 0) + Math.max(0, (run.updatedAt || run.resumedAt || now()) - (run.resumedAt || now()));
      run.outputTokens += run.checkpointTokens || 0; run.checkpointTokens = 0; run.turnStartedAt = null;
      run.resumedAt = null; run.status = "interrupted"; run.error = "Host restarted. Check the conversation before resuming."; changed = true;
    }
    if (changed) save();
  }
  function summary(run) { return { ...clone(run), elapsedMs: elapsed(run), outputTokens: run.outputTokens + (ACTIVE.has(run.status) ? bridge.tokens?.(run) || 0 : 0), nonce: undefined, record: undefined }; }
  function list(entry = null) { return { available: healthy, runs: (entry ? state.runs.filter(r => r.entry === entry).slice(-1) : state.runs).map(summary), schedules: entry ? [] : clone(state.schedules), serverNow: now() }; }
  function trim() {
    const disposable = state.runs.filter(r => ["limited", "completed", "failed", "stopped"].includes(r.status));
    while (state.runs.length >= 200 && disposable.length) state.runs.splice(state.runs.indexOf(disposable.shift()), 1);
    if (state.runs.length >= 200) throw invalid("Too many active or paused tasks", 409);
  }
  function makeRun(input, scheduleId = null) {
    trim(); const config = definition(input);
    const run = { ...config, id: randomUUID(), nonce: randomUUID(), scheduleId, requestId: scheduleId ? null : input.requestId || null, entry: input.entry || null, record: null,
      status: "queued", activity: "queued", createdAt: now(), updatedAt: now(), startedAt: null, endedAt: null,
      resumedAt: null, elapsedMs: 0, turns: 0, outputTokens: 0, result: "", error: null };
    state.runs.push(run); return run;
  }
  function locked(entry) { return !!entry && state.runs.some(r => r.entry === entry && (ACTIVE.has(r.status) || r.status === "queued" || r.status === "stopping")); }
  function limit(run) { return elapsed(run) >= run.limits.minutes * 60000 || run.turns >= run.limits.turns || run.outputTokens >= run.limits.outputTokens; }
  function launch(run) {
    if (inflight.has(run.id) || closed || !healthy) return;
    run.startedAt ??= now(); run.resumedAt = now(); run.endedAt = null; run.status = "starting"; run.activity = "starting"; run.updatedAt = now(); save();
    const controller = new AbortController(); inflight.set(run.id, controller); bridge.reserve?.(true);
    void (async () => {
      try {
        const target = await bridge.open(run, controller.signal);
        run.entry = target.entry; run.record = target.record; save();
        if (controller.signal.aborted) return;
        while (!controller.signal.aborted && healthy && !closed) {
          if (limit(run)) { finish(run, "limited", "Task limit reached"); break; }
          const prompt = run.mode === "goal" ? goalPrompt(run) : run.objective;
          run.turnStartedAt = now(); run.turns++; run.status = "running"; run.activity = "thinking"; run.updatedAt = now(); save();
          const result = await bridge.turn(run, prompt, controller.signal, activity => {
            if (!ACTIVE.has(run.status)) return;
            run.status = activity.waiting ? "waiting" : "running";
            run.activity = String(activity.text || "thinking").slice(0, 240); run.updatedAt = now();
          });
          run.outputTokens += Math.max(0, Number(result.outputTokens) || 0); run.turnStartedAt = null; run.checkpointTokens = 0;
          run.result = String(result.text || "").replace(new RegExp(`\\[\\[STEPSEMBLE_GOAL:${run.nonce}:(complete|blocked)\\]\\]`, "g"), "").trim().slice(-16000);
          if (controller.signal.aborted || closed || !healthy) break;
          const status = outcome(run, result);
          if (status) { finish(run, status, result.error || null); break; }
          if (limit(run)) { finish(run, "limited", "Task limit reached"); break; }
          save();
          // Yield so pause/stop and provider idle settlement win before continuation.
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
      } catch (error) {
        if (!controller.signal.aborted && healthy && !closed) finish(run, /auth_required|sign.?in|login|not signed/i.test(String(error.message)) ? "blocked" : "failed", String(error.message || error).slice(0, 2000));
      } finally {
        inflight.delete(run.id); bridge.reserve?.(false);
        if (run.status === "stopping" && healthy) finish(run, run.stopStatus || "paused", run.error);
      }
    })().catch(onError);
  }
  async function stop(run, status) {
    if (run.status === "stopping" && !run.error) throw invalid("Task is still stopping", 409);
    const controller = inflight.get(run.id);
    if (!controller) { finish(run, status); return; }
    run.status = "stopping"; run.stopStatus = status; run.activity = "stopping"; run.error = null; save();
    controller.abort();
    try { await bridge.stop(run); }
    catch (error) { run.error = `Stop could not be confirmed: ${error.message}`; save(); }
    // The bridge does not release its waiter until native work has settled.
  }
  async function tick() {
    if (closed || !healthy || ticking) return;
    ticking = true;
    try {
      for (const row of state.schedules) {
        if (!row.enabled || row.nextAt === null || row.nextAt > now()) continue;
        if (state.runs.some(r => r.scheduleId === row.id && (ACTIVE.has(r.status) || ["queued", "stopping"].includes(r.status)))) continue;
        const dueAt = row.nextAt;
        const run = makeRun(row, row.id); run.scheduledAt = dueAt;
        row.lastRunId = run.id; row.lastAt = dueAt;
        row.nextAt = nextOccurrence(row.schedule, now(), dueAt);
        if (row.schedule.kind === "once") row.enabled = false;
        // Commit the occurrence and its run together, before any native send.
        save();
      }
      for (const run of state.runs) if (ACTIVE.has(run.status)) {
        if (elapsed(run) >= run.limits.minutes * 60000 || run.outputTokens + (bridge.tokens?.(run) || 0) >= run.limits.outputTokens) await stop(run, "limited");
        else if (now() - (run.checkpointAt || 0) >= 5000) { run.checkpointAt = now(); run.checkpointTokens = bridge.tokens?.(run) || 0; run.updatedAt = now(); save(); }
      }
      for (const run of state.runs) if (run.status === "queued" && inflight.size < 2) launch(run);
    } catch (error) { onError(error); }
    finally { ticking = false; }
  }
  function create(body) {
    if (!healthy || closed) throw invalid("Tasks are unavailable", 503);
    if (body.requestId !== undefined && (typeof body.requestId !== "string" || !/^[a-f0-9-]{36}$/.test(body.requestId))) throw invalid("Invalid task request");
    if (body.requestId) { const prior = [...state.schedules,...state.runs].find(r => r.requestId === body.requestId); if (prior) return prior.schedule ? clone(prior) : summary(prior); }
    if (body.kind === "schedule") {
      if (state.schedules.length >= 100) throw invalid("Too many schedules", 409);
      const config = definition(body), schedule = scheduleSpec(body.schedule, now());
      const row = { ...config, id: randomUUID(), requestId: body.requestId || null, schedule, enabled: true, createdAt: now(), nextAt: nextOccurrence(schedule, now()), lastRunId: null };
      state.schedules.push(row); save(); return clone(row);
    }
    if (body.entry && locked(body.entry)) throw invalid("This conversation already has an active Goal", 409);
    const run = makeRun(body); save(); void tick(); return summary(run);
  }
  async function action(body) {
    if (!healthy || closed) throw invalid("Tasks are unavailable", 503);
    const schedule = state.schedules.find(r => r.id === body.id);
    if (schedule) {
      if (body.action === "run") {
        if (state.runs.some(r => r.scheduleId === schedule.id && (ACTIVE.has(r.status) || ["queued", "stopping"].includes(r.status)))) throw invalid("This schedule is already running", 409);
        const run = makeRun(schedule, schedule.id); schedule.lastRunId = run.id; save(); void tick(); return summary(run);
      }
      if (body.action === "pause") schedule.enabled = false;
      else if (body.action === "resume") { schedule.nextAt = nextOccurrence(schedule.schedule, now(), schedule.lastAt); if (!schedule.nextAt) throw invalid("Choose a new time for this one-time schedule"); schedule.enabled = true; }
      else if (body.action === "edit") {
        const config = definition(body), spec = scheduleSpec(body.schedule, now());
        Object.assign(schedule, config, { schedule: spec, nextAt: nextOccurrence(spec, now()), enabled: body.enabled !== false });
      } else if (body.action === "delete") { state.schedules.splice(state.schedules.indexOf(schedule), 1); }
      else throw invalid("Unknown schedule action");
      save(); return clone(schedule);
    }
    const run = state.runs.find(r => r.id === body.id);
    if (!run) throw invalid("Task not found", 404);
    if (body.action === "pause" && (ACTIVE.has(run.status) || run.status === "queued")) await stop(run, "paused");
    else if (body.action === "stop" && (ACTIVE.has(run.status) || RESUMABLE.has(run.status) || run.status === "queued" || run.status === "stopping")) await stop(run, "stopped");
    else if (body.action === "resume" && RESUMABLE.has(run.status)) {
      if (inflight.has(run.id) || locked(run.entry)) throw invalid("This conversation is still busy", 409);
      if (limit(run)) throw invalid("Task limit reached; create a new Goal", 409);
      run.status = "queued"; run.error = null; save(); void tick();
    } else throw invalid("This task cannot perform that action", 409);
    return summary(run);
  }
  const timer = autoStart ? setInterval(() => void tick(), 1000) : null; timer?.unref?.();
  return { list, create, action, tick, locked, close() { closed = true; clearInterval(timer); }, healthy: () => healthy };
}
module.exports = { createWorkflows, scheduleSpec, nextOccurrence, definition, goalPrompt, outcome, AGENTS };
