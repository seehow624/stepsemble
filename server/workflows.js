"use strict";

// Host-owned Goals and schedules. Browser lifetime never owns execution.
const fs = require("node:fs"), path = require("node:path"), { randomUUID, createHash } = require("node:crypto");
const ACTIVE = new Set(["starting", "running", "waiting"]);
const RESUMABLE = new Set(["paused", "blocked", "interrupted"]);
const FINISHED = new Set(["limited", "completed", "failed", "stopped"]);
const AGENTS = ["pi", "codex", "claude-code", "omp", "opencode", "cline", "kilo", "hermes", "grok-build"];
const CHOICE = /^[^\s\u0000-\u001f\u007f]{1,256}$/, PERMISSION = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
// A temporary failure retries the same turn; a usage limit waits for its reset.
const RETRY_DELAYS = [30000, 120000, 480000];
const QUOTA_RECHECK = 30 * 60000, QUOTA_WINDOW = 6 * 3600000, QUOTA_HORIZON = 12 * 3600000;
const STALL_TURNS = 2;
const RETRY_NOTE = "The previous attempt stopped because of a temporary error or usage limit. Check the conversation and continue without repeating completed work.";
const STALL_MESSAGE = "The agent made no visible progress in the last three turns. Check the conversation, then resume.";
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
// A pinned model applies to each new conversation the run opens.
function choice(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "object" || Array.isArray(value)) throw invalid("Invalid model");
  const out = {};
  for (const key of ["model", "effort", "provider"]) {
    if (value[key] === undefined || value[key] === null || value[key] === "") continue;
    if (typeof value[key] !== "string" || !CHOICE.test(value[key])) throw invalid("Invalid model");
    out[key] = value[key];
  }
  if (!out.model && Object.keys(out).length) throw invalid("Invalid model");
  return out.model ? out : null;
}
function permission(value) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || !PERMISSION.test(value)) throw invalid("Invalid permission mode");
  return value;
}
function targetEntry(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || !/^[a-f0-9-]{36}$/.test(value)) throw invalid("Invalid target conversation");
  return value;
}
function definition(body) {
  const agentId = text(body.agentId, 32, "agent");
  if (!AGENTS.includes(agentId)) throw invalid("This agent does not support background Goals");
  return { title: text(body.title, 120, "title"), objective: text(body.objective, 16000, "objective"),
    agentId, cwd: text(body.cwd, 4096, "project"), mode: body.mode === "task" ? "task" : "goal",
    limits: { minutes: integer(body.limits?.minutes, 60, 1, 1440), turns: integer(body.limits?.turns, 20, 1, 100),
      outputTokens: integer(body.limits?.outputTokens, 100000, 100, 10000000),
      approvalMinutes: integer(body.limits?.approvalMinutes, 30, 1, 1440) },
    choice: choice(body.choice), permission: permission(body.permission), targetEntry: targetEntry(body.targetEntry) };
}
// Usage limits are checked first: their messages often also mention a rate.
function failureKind(message) {
  const value = String(message || "");
  if (/usage.?limit|quota|credit balance|hit your (?:\w+ )?limit|out of credits|insufficient.?credits|billing/i.test(value)) return "quota";
  if (/auth_required|sign.?in|login|not signed|unauthori[sz]ed/i.test(value)) return "auth";
  if (/\b(?:429|500|502|503|504|529)\b|rate.?limit|overloaded|too many requests|capacity|ECONNRESET|ETIMEDOUT|ECONNREFUSED|EAI_AGAIN|ENOTFOUND|EPIPE|socket hang up|fetch failed|network|timed? ?out|temporarily unavailable|try again later|stream ?disconnected|httpConnectionFailed|responseStreamConnectionFailed|internalServerError|connection (?:reset|closed|error|refused)|is busy/i.test(value)) return "transient";
  return null;
}
// The wait an agent states for its usage limit, plus a minute; null if none.
function retryDelay(message, now) {
  const value = String(message || "");
  let at = null;
  const epoch = value.match(/\|(\d{10})(?!\d)/);
  const iso = value.match(/\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})/);
  const relative = value.match(/\b(?:in|after)\s+(\d+(?:\.\d+)?)\s*(seconds?|secs?|minutes?|mins?|hours?|hrs?|days?)\b/i);
  if (epoch) at = Number(epoch[1]) * 1000;
  else if (iso) at = Date.parse(iso[0]);
  else if (relative) at = now + Number(relative[1]) * ({ s: 1000, m: 60000, h: 3600000, d: 86400000 })[relative[2][0].toLowerCase()];
  return Number.isFinite(at) && at > now ? at - now + 60000 : null;
}
function projectKey(cwd) {
  let value = path.resolve(String(cwd || ""));
  try { value = fs.realpathSync.native(value); } catch {}
  return ["darwin", "win32"].includes(process.platform) ? value.toLowerCase() : value;
}
function sameProject(a, b) {
  const x = projectKey(a), y = projectKey(b), within = (inner, outer) => inner.startsWith(outer.endsWith(path.sep) ? outer : outer + path.sep);
  return x === y || within(x, y) || within(y, x);
}
function defaultSleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => { clearTimeout(timer); reject(new Error("Task paused")); }, { once: true });
  });
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
const markerPattern = run => `\\[\\[STEPSEMBLE_GOAL:${String(run.nonce).replace(/[^A-Za-z0-9-]/g, "")}:(complete|blocked)\\]\\]`;
// Agents often wrap the marker in Markdown or add punctuation. Anything else
// after it, such as more prose, means the reply did not end with it.
const DECORATION = "`*_~\"'\u201c\u201d\u2018\u2019.,;:!?\u3002\uff0c\uff0e\uff01\uff1f\u3001)\\]\uff09\u3011\u300d\u300f-";
function outcome(run, result) {
  if (result.error) return "failed";
  if (run.mode === "task") return "completed";
  const value = String(result.text || "");
  let last = null;
  for (const match of value.matchAll(new RegExp(markerPattern(run), "g"))) last = match;
  if (!last || !new RegExp(`^[\\s>${DECORATION}]*$`, "u").test(value.slice(last.index + last[0].length))) return null;
  return last[1] === "complete" ? "completed" : "blocked";
}
function cleanResult(run, value) {
  const marker = markerPattern(run);
  return String(value || "")
    .replace(new RegExp(`(^|\\n)[ \\t]*\`\`\`[\\w-]*[ \\t]*\\n[ \\t]*${marker}[ \\t]*\\n[ \\t]*\`\`\`[ \\t]*(?=\\n|$)`, "g"), "$1")
    .replace(new RegExp(`[ \\t]*[>\`*_~"'\u201c\u201d\u2018\u2019]*[ \\t]*${marker}[${DECORATION}]*`, "gu"), "")
    .trim().slice(-16000);
}
// Identical or empty replies on consecutive turns show no visible progress.
function progressHash(run, value) {
  const normal = String(value || "").replace(new RegExp(markerPattern(run), "g"), "").toLowerCase().replace(/\s+/g, " ").trim();
  return normal ? createHash("sha256").update(normal).digest("hex").slice(0, 32) : "";
}
function createWorkflows({ file, bridge, now = Date.now, autoStart = true, sleep = defaultSleep, onError = () => {}, onFinished = () => {} }) {
  let state = { version: 1, schedules: [], runs: [] }, healthy = true, closed = false, ticking = false;
  const inflight = new Map(), preparations = new WeakMap();
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
    // Tasks saved before approval limits and pinned choices take the defaults.
    for (const row of [...saved.runs,...saved.schedules]) {
      row.limits.approvalMinutes ??= 30; row.choice ??= null; row.permission ??= null; row.targetEntry ??= null;
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
  // The clock stops while an approval or a retry waits, not just on pause.
  function holdClock(run) { run.elapsedMs = elapsed(run); run.resumedAt = null; }
  function finish(run, status, error = null, announce = true) {
    run.elapsedMs = elapsed(run); run.resumedAt = null; run.waitingSince = null; run.retryAt = null; run.status = status; run.activity = status;
    run.error = error; run.updatedAt = now(); run.endedAt = now(); save();
    if (announce) try { onFinished(summary(run)); } catch (error) { onError(error); }
  }
  // An uncertain send is never replayed on Host restart.
  if (healthy) {
    let changed = false;
    for (const run of state.runs) if (ACTIVE.has(run.status) || run.status === "stopping") {
      run.elapsedMs = (run.elapsedMs || 0) + Math.max(0, (run.updatedAt || run.resumedAt || now()) - (run.resumedAt || now()));
      run.outputTokens += run.checkpointTokens || 0; run.checkpointTokens = 0; run.turnStartedAt = null; run.waitingSince = null; run.retryAt = null;
      run.resumedAt = null; run.status = "interrupted"; run.error = "Host restarted. Check the conversation before resuming."; changed = true;
    }
    if (changed) save();
  }
  function summary(run) { return { ...clone(run), elapsedMs: elapsed(run), clockRunning: ACTIVE.has(run.status) && run.resumedAt !== null,
    outputTokens: run.outputTokens + (ACTIVE.has(run.status) ? bridge.tokens?.(run) || 0 : 0), nonce: undefined, record: undefined, progressHash: undefined }; }
  function hasRunCapacity() { return state.runs.length < 200 || state.runs.some(r => ["limited", "completed", "failed", "stopped"].includes(r.status)); }
  function scheduledRunPending(id) { return state.runs.some(r => r.scheduleId === id && (ACTIVE.has(r.status) || ["queued", "stopping"].includes(r.status))); }
  // A conversation shows its latest Goal until the person removes it; its
  // history, newest first, includes removed ones.
  function list(entry = null, { history = false } = {}) {
    const runs = !entry ? state.runs : history ? state.runs.filter(r => r.entry === entry).slice(-20).reverse() : state.runs.filter(r => r.entry === entry).slice(-1).filter(r => !r.dismissedAt);
    return { available: healthy, runs: runs.map(summary), schedules: entry ? [] : clone(state.schedules).map(row => ({ ...row,
    capacityBlocked: row.enabled && row.nextAt !== null && row.nextAt <= now() && !scheduledRunPending(row.id) && !hasRunCapacity() })), serverNow: now() }; }
  function trim() {
    const disposable = state.runs.filter(r => ["limited", "completed", "failed", "stopped"].includes(r.status));
    while (state.runs.length >= 200 && disposable.length) state.runs.splice(state.runs.indexOf(disposable.shift()), 1);
    if (state.runs.length >= 200) throw invalid("Too many active or paused tasks", 409);
  }
  function makeRun(input, scheduleId = null) {
    trim(); const config = definition(input);
    const run = { ...config, id: randomUUID(), nonce: randomUUID(), scheduleId, requestId: scheduleId ? null : input.requestId || null, entry: config.targetEntry || input.entry || null, record: null,
      status: "queued", activity: "queued", createdAt: now(), updatedAt: now(), startedAt: null, endedAt: null,
      resumedAt: null, elapsedMs: 0, turns: 0, outputTokens: 0, result: "", error: null };
    state.runs.push(run); return run;
  }
  // The mark a session's list row shows: its latest Goal while that Goal is
  // still the conversation's business. A finished Goal leaves no mark.
  function goalState(entry) {
    if (!entry) return null;
    const run = state.runs.filter(r => r.entry === entry && r.mode !== "task").sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))[0];
    if (!run) return null;
    if (ACTIVE.has(run.status) || run.status === "queued" || run.status === "stopping") return "running";
    if (run.status === "paused") return "paused";
    return run.status === "blocked" || run.status === "interrupted" ? "attention" : null;
  }
  // A scheduled target waiting for idle must not reserve the user's conversation.
  function locked(entry, exceptId = null) { return !!entry && state.runs.some(r => r.id !== exceptId && r.entry === entry && (ACTIVE.has(r.status) || r.status === "queued" && !r.targetEntry || r.status === "stopping")); }
  function targetBusy(entry, exceptId = null) {
    return locked(entry, exceptId) || state.runs.some(r => r.id !== exceptId && r.entry === entry && r.mode === "goal" && RESUMABLE.has(r.status));
  }
  function limit(run) { return elapsed(run) >= run.limits.minutes * 60000 || run.turns >= run.limits.turns || run.outputTokens >= run.limits.outputTokens; }
  function projectBusy(run) {
    return state.runs.some(other => other !== run && (inflight.has(other.id) || ACTIVE.has(other.status) || other.status === "stopping") && sameProject(other.cwd, run.cwd));
  }
  function launch(run) {
    if (run.status !== "queued" || inflight.has(run.id) || closed || !healthy) return;
    run.startedAt ??= now(); run.resumedAt = run.targetEntry ? null : now(); run.endedAt = null; run.notBefore = null; run.retryAt = null; run.waitingSince = null; run.error = null;
    run.stopStatus = null; run.stopReason = null; run.status = "starting"; run.activity = "starting"; run.updatedAt = now(); save();
    const controller = new AbortController(); inflight.set(run.id, controller); bridge.reserve?.(true);
    const live = () => !controller.signal.aborted && healthy && !closed;
    void (async () => {
      try {
        while (live()) {
          let counted = false, attemptElapsed = elapsed(run);
          try {
            const target = await bridge.open(run, controller.signal);
            run.entry = target.entry; run.record = target.record; save();
            if (!live()) return;
            while (live()) {
              if (limit(run)) { finish(run, "limited", "Task limit reached"); return; }
              const prompt = run.mode === "goal" ? goalPrompt(run) : run.objective;
              if (run.targetEntry) { run.resumedAt ??= now(); }
              run.turnStartedAt = now(); run.turns++; counted = true; run.status = "running"; run.activity = "thinking"; run.updatedAt = now(); save();
              const result = await bridge.turn(run, run.retrying ? `${RETRY_NOTE}\n\n${prompt}` : prompt, controller.signal, activity => {
                if (!ACTIVE.has(run.status)) return;
                const waiting = !!activity.waiting;
                if (waiting && run.status !== "waiting") { holdClock(run); run.waitingSince = now(); }
                else if (!waiting && run.status === "waiting") { run.resumedAt = now(); run.waitingSince = null; }
                run.status = waiting ? "waiting" : "running";
                run.activity = String(activity.text || "thinking").slice(0, 240); run.updatedAt = now();
              });
              if (run.waitingSince) { run.resumedAt = now(); run.waitingSince = null; }
              run.outputTokens += Math.max(0, Number(result.outputTokens) || 0); run.turnStartedAt = null; run.checkpointTokens = 0;
              run.result = cleanResult(run, result.text);
              if (!live()) return;
              if (result.error) throw new Error(String(result.error));
              counted = false; run.retries = 0; run.quotaSince = null; run.retrying = false;
              const status = outcome(run, result);
              if (status) { finish(run, status); return; }
              if (run.mode === "goal") {
                const hash = progressHash(run, result.text);
                run.stalls = !hash || hash === run.progressHash ? (run.stalls || 0) + 1 : 0; run.progressHash = hash;
                if (run.stalls >= STALL_TURNS) { finish(run, "blocked", STALL_MESSAGE); return; }
              }
              if (limit(run)) { finish(run, "limited", "Task limit reached"); return; }
              save();
              // Yield so pause/stop and provider idle settlement win before continuation.
              await new Promise(resolve => setTimeout(resolve, 1000));
              attemptElapsed = elapsed(run);
            }
          } catch (error) {
            if (!live()) return;
            const message = String(error.message || error).slice(0, 2000), kind = failureKind(message);
            // A turn that failed before doing work is not charged against the turn limit.
            const uncount = () => { if (counted) run.turns = Math.max(0, run.turns - 1); counted = false; };
            if (run.targetEntry && error.code === "workflow_target_busy") {
              uncount(); run.elapsedMs = attemptElapsed; run.resumedAt = null; run.turnStartedAt = null;
              run.status = "queued"; run.activity = "conversation_busy"; run.error = null; save(); return;
            }
            if (kind === "transient" && (run.retries || 0) < RETRY_DELAYS.length) {
              const delay = RETRY_DELAYS[run.retries || 0];
              uncount(); run.retries = (run.retries || 0) + 1; run.retrying = true; holdClock(run);
              run.retryAt = now() + delay; run.activity = "retrying"; run.error = message; run.updatedAt = now(); save();
              try { await sleep(delay, controller.signal); } catch { return; }
              if (!live()) return;
              run.retryAt = null; run.resumedAt = now(); run.error = null;
              continue;
            }
            if (kind === "quota") {
              run.quotaSince ??= now();
              const delay = retryDelay(message, now());
              if (delay === null ? now() - run.quotaSince < QUOTA_WINDOW : delay <= QUOTA_HORIZON) {
                // Queued work holds no slot; it starts again in the same conversation.
                uncount(); run.retrying = true; holdClock(run);
                run.status = "queued"; run.activity = "usage_reset"; run.notBefore = now() + (delay ?? QUOTA_RECHECK); run.error = message; run.updatedAt = now(); save();
                return;
              }
              finish(run, "blocked", `Usage limit reached: ${message}`.slice(0, 2000)); return;
            }
            finish(run, kind === "auth" ? "blocked" : "failed", message); return;
          }
        }
      } finally {
        inflight.delete(run.id); bridge.reserve?.(false);
        if (run.status === "stopping" && healthy) finish(run, run.stopStatus || "paused", run.stopReason || run.error);
      }
    })().catch(onError);
  }
  async function stop(run, status, reason = null) {
    preparations.delete(run);
    if (run.status === "stopping" && !run.error) throw invalid("Task is still stopping", 409);
    const controller = inflight.get(run.id);
    if (!controller) { finish(run, status, reason); return; }
    run.status = "stopping"; run.stopStatus = status; run.stopReason = reason; run.activity = "stopping"; run.error = null; save();
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
        if (scheduledRunPending(row.id)) continue;
        // A full queue delays only this occurrence. Existing Goals must still
        // enforce their budgets, checkpoint and dispatch on every tick.
        if (!hasRunCapacity()) continue;
        const dueAt = row.nextAt;
        const run = makeRun(row, row.id); run.scheduledAt = dueAt;
        row.lastRunId = run.id; row.lastAt = dueAt;
        row.nextAt = nextOccurrence(row.schedule, now(), dueAt);
        if (row.schedule.kind === "once") row.enabled = false;
        // Commit the occurrence and its run together, before any native send.
        save();
      }
      for (const run of state.runs) if (ACTIVE.has(run.status)) {
        const approval = run.limits.approvalMinutes ?? 30;
        if (run.status === "waiting" && run.waitingSince && now() - run.waitingSince >= approval * 60000)
          await stop(run, "blocked", `No one answered the approval request within ${approval} minutes. Resume the Goal to ask again.`);
        else if (elapsed(run) >= run.limits.minutes * 60000 || run.outputTokens + (bridge.tokens?.(run) || 0) >= run.limits.outputTokens) await stop(run, "limited");
        else if (now() - (run.checkpointAt || 0) >= 5000) { run.checkpointAt = now(); run.checkpointTokens = bridge.tokens?.(run) || 0; run.updatedAt = now(); save(); }
      }
      for (const run of state.runs) if (run.status === "queued" && inflight.size < 2) {
        if (run.notBefore && run.notBefore > now()) continue;
        // Two runs never edit the same project at once.
        if (projectBusy(run)) { if (run.activity !== "project_busy") { run.activity = "project_busy"; save(); } continue; }
        if (run.targetEntry) {
          // Pause/Stop invalidates this admission even if Resume queues the
          // same run again before its native preparation has returned.
          const admission = {}; preparations.set(run, admission);
          const current = () => preparations.get(run) === admission && run.status === "queued" && !closed && healthy;
          try {
            const busy = targetBusy(run.targetEntry, run.id) || await bridge.prepare?.(run) === false;
            if (!current()) continue;
            if (busy) { if (run.activity !== "conversation_busy") { run.activity = "conversation_busy"; save(); } continue; }
          } catch (error) { if (current()) finish(run, "failed", String(error.message || error)); continue; }
          finally { if (preparations.get(run) === admission) preparations.delete(run); }
        }
        launch(run);
      }
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
        const config = definition({ ...body, targetEntry: body.targetEntry === undefined ? schedule.targetEntry : body.targetEntry }), spec = scheduleSpec(body.schedule, now());
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
      run.status = "queued"; run.activity = "queued"; run.error = null; run.notBefore = null;
      run.stalls = 0; run.progressHash = null; run.retries = 0; run.quotaSince = null; save(); void tick();
    } else if (body.action === "dismiss" && (FINISHED.has(run.status) || RESUMABLE.has(run.status))) {
      // A waiting Goal removed ends without a notification: the person did it.
      if (RESUMABLE.has(run.status)) finish(run, "stopped", null, false);
      run.dismissedAt = now(); save();
    } else throw invalid("This task cannot perform that action", 409);
    return summary(run);
  }
  const timer = autoStart ? setInterval(() => void tick(), 1000) : null; timer?.unref?.();
  return { list, create, action, tick, locked, targetBusy, goalState, close() { closed = true; clearInterval(timer); }, healthy: () => healthy };
}
module.exports = { createWorkflows, scheduleSpec, nextOccurrence, definition, goalPrompt, outcome, failureKind, retryDelay, sameProject, AGENTS };
