"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { createWorkflows, outcome, failureKind, retryDelay, definition } = require("../server/workflows");
const { createWorkflowEvents } = require("../server/workflow-events");
const wait = ms => new Promise(r => setTimeout(r, ms));
// A Goal waits a real second between turns; on a loaded runner the next turn
// can start later than that, so wait for it rather than for a fixed time.
async function nextTurn(f) { const end = Date.now() + 10000; while (!f.pending.length && Date.now() < end) await wait(20); }
const def = { title:"Verify login",objective:"Implement login and test it",agentId:"pi",cwd:os.tmpdir() };
function fixture(t, { sleeps = [] } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(),"stepsemble-goals-hardening-"));
  const file = path.join(dir,"goals.json"); let clock=Date.parse("2026-10-09T00:00:00Z"), pending=[], sends=[], opens=[];
  const bridge={async open(run){opens.push(run);if(bridge.openError){const e=bridge.openError;bridge.openError=null;throw e;}return {entry:run.entry||`entry-${opens.length}`,record:{agentId:run.agentId}};},
    async turn(run,prompt,signal,activity){sends.push(prompt);return new Promise(resolve=>pending.push({resolve,signal,activity,run}));},
    async stop(){pending.shift()?.resolve({text:"Stopped"});}};
  const sleep=async(ms,signal)=>{sleeps.push(ms);clock+=ms;if(signal?.aborted)throw new Error("aborted");};
  const host=createWorkflows({file,bridge,now:()=>clock,autoStart:false,sleep});
  t.after(()=>{host.close(); for(const p of pending)p.resolve({error:"test ended"});fs.rmSync(dir,{recursive:true,force:true});});
  return {host,file,bridge,pending,sends,opens,sleeps,advance:n=>{clock+=n;},now:()=>clock,get:()=>host.list().runs.at(-1),runs:()=>host.list().runs};
}
const marker = (run, status) => `[[STEPSEMBLE_GOAL:${run.nonce}:${status}]]`;

test("completion tolerates trailing punctuation and Markdown decoration but not trailing prose", () => {
  const run = { mode:"goal", nonce:"unique" }, done = "[[STEPSEMBLE_GOAL:unique:complete]]";
  for (const text of [`Done\n${done}.`, `Done\n\`${done}\``, `Done\n**${done}**`, `Done\n\`\`\`\n${done}\n\`\`\``, `Done\n> ${done}`, `Done ${done}。`, `Done\n${done}\n\n`])
    assert.equal(outcome(run, { text }), "completed", JSON.stringify(text));
  assert.equal(outcome(run, { text:`Blocked on credentials\n**[[STEPSEMBLE_GOAL:unique:blocked]]**` }), "blocked");
  assert.equal(outcome(run, { text:`${done}\nMore work needed` }), null);
  assert.equal(outcome(run, { text:`${done}\nLet me know if anything else is needed.` }), null);
  assert.equal(outcome(run, { text:"[[STEPSEMBLE_GOAL:other:complete]]." }), null);
});

test("the stored result drops the marker together with its decoration", async t => {
  const f = fixture(t); f.host.create(def); await wait(10);
  const turn = f.pending.shift(); turn.resolve({ text:`Tests passed.\n\n**${marker(turn.run,"complete")}**` }); await wait(10);
  assert.equal(f.get().status, "completed"); assert.equal(f.get().result, "Tests passed.");
});

test("two consecutive turns without visible progress stop as blocked instead of burning the turn budget", async t => {
  const f = fixture(t); f.host.create(def); await wait(10);
  f.pending.shift().resolve({ text:"Waiting for the staging database to come back." }); await nextTurn(f);
  f.pending.shift().resolve({ text:"Waiting for the staging database to come back." }); await nextTurn(f);
  assert.equal(f.get().status, "running"); assert.equal(f.sends.length, 3);
  f.pending.shift().resolve({ text:"  waiting for the staging   database to come back. " }); await wait(10);
  assert.equal(f.get().status, "blocked"); assert.match(f.get().error, /no visible progress/i); assert.equal(f.sends.length, 3);
});

test("empty replies count as no progress, and changed replies reset the count", async t => {
  const f = fixture(t); f.host.create(def); await wait(10);
  f.pending.shift().resolve({ text:"" }); await nextTurn(f);
  f.pending.shift().resolve({ text:"Implemented the form" }); await nextTurn(f);
  f.pending.shift().resolve({ text:"" }); await nextTurn(f);
  assert.equal(f.get().status, "running");
  f.pending.shift().resolve({ text:"" }); await wait(10);
  assert.equal(f.get().status, "blocked");
});

test("resuming a stalled Goal starts a fresh progress count", async t => {
  const f = fixture(t); f.host.create(def); await wait(10);
  for (let i = 0; i < 3; i++) { f.pending.shift().resolve({ text:"Same" }); if (i < 2) await nextTurn(f); else await wait(10); }
  assert.equal(f.get().status, "blocked");
  await f.host.action({ id:f.get().id, action:"resume" }); await f.host.tick(); await wait(10);
  f.pending.shift().resolve({ text:"Same" }); await nextTurn(f);
  assert.equal(f.get().status, "running");
});

test("one-turn tasks are never judged for progress", async t => {
  const f = fixture(t); f.host.create({ ...def, mode:"task" }); await wait(10);
  f.pending.shift().resolve({ text:"" }); await wait(10);
  assert.equal(f.get().status, "completed");
});

test("time spent waiting for an approval does not use the time budget", async t => {
  const f = fixture(t); f.host.create({ ...def, limits:{ minutes:10 } }); await wait(10);
  f.advance(60000); f.pending[0].activity({ text:"approval", waiting:true });
  assert.equal(f.get().status, "waiting"); assert.equal(f.get().clockRunning, false);
  f.advance(20 * 60000); await f.host.tick();
  assert.equal(f.get().status, "waiting"); assert.equal(f.get().elapsedMs, 60000);
  f.pending[0].activity({ text:"thinking" }); f.advance(30000);
  assert.equal(f.get().status, "running"); assert.equal(f.get().clockRunning, true); assert.equal(f.get().elapsedMs, 90000);
});

test("an unanswered approval pauses the Goal as blocked after its approval limit and frees the slot", async t => {
  const f = fixture(t); f.host.create({ ...def, limits:{ approvalMinutes:5 } }); await wait(10);
  f.pending[0].activity({ text:"approval", waiting:true });
  f.advance(5 * 60000 - 1); await f.host.tick(); assert.equal(f.get().status, "waiting");
  f.advance(1); await f.host.tick(); await wait(10);
  assert.equal(f.get().status, "blocked"); assert.match(f.get().error, /approval/i);
  await f.host.action({ id:f.get().id, action:"resume" }); await f.host.tick(); await wait(10);
  assert.equal(f.get().status, "running"); assert.equal(f.sends.length, 2);
});

test("the approval limit defaults to 30 minutes and is validated", () => {
  assert.equal(definition(def).limits.approvalMinutes, 30);
  assert.equal(definition({ ...def, limits:{ approvalMinutes:1440 } }).limits.approvalMinutes, 1440);
  assert.throws(() => definition({ ...def, limits:{ approvalMinutes:0 } }), /limit/);
  assert.throws(() => definition({ ...def, limits:{ approvalMinutes:1441 } }), /limit/);
});

test("Goals from older Hosts without an approval limit still load and use the default", async t => {
  const f = fixture(t); const run = f.host.create(def); await wait(10);
  f.pending.shift().resolve({ error:"stopped for the test" }); await wait(10);
  const saved = JSON.parse(fs.readFileSync(f.file, "utf8")); delete saved.runs[0].limits.approvalMinutes; fs.writeFileSync(f.file, JSON.stringify(saved));
  const reopened = createWorkflows({ file:f.file, bridge:f.bridge, autoStart:false }); t.after(() => reopened.close());
  assert.equal(reopened.list().available, true); assert.equal(reopened.list().runs[0].id, run.id);
  assert.equal(reopened.list().runs[0].limits.approvalMinutes, 30);
});

test("work in the same project runs one at a time, including nested folders", async t => {
  const f = fixture(t), project = fs.mkdtempSync(path.join(os.tmpdir(), "stepsemble-project-"));
  const nested = path.join(project, "packages", "web"); fs.mkdirSync(nested, { recursive:true });
  t.after(() => fs.rmSync(project, { recursive:true, force:true }));
  f.host.create({ ...def, cwd:project }); f.host.create({ ...def, cwd:nested }); await f.host.tick(); await wait(10);
  assert.equal(f.sends.length, 1);
  const [first, second] = f.runs(); assert.equal(first.status, "running"); assert.equal(second.status, "queued"); assert.equal(second.activity, "project_busy");
});

test("a queued run starts once the other run in its project settles", async t => {
  const f = fixture(t), project = fs.mkdtempSync(path.join(os.tmpdir(), "stepsemble-project-"));
  t.after(() => fs.rmSync(project, { recursive:true, force:true }));
  f.host.create({ ...def, cwd:project, mode:"task" }); f.host.create({ ...def, cwd:project, mode:"task" }); await f.host.tick(); await wait(10);
  assert.equal(f.sends.length, 1);
  f.pending.shift().resolve({ text:"First done" }); await wait(10); await f.host.tick(); await wait(10);
  assert.equal(f.sends.length, 2); assert.equal(f.runs()[0].status, "completed"); assert.equal(f.runs()[1].status, "running");
});

test("different projects still run side by side", async t => {
  const f = fixture(t), a = fs.mkdtempSync(path.join(os.tmpdir(), "stepsemble-a-")), b = fs.mkdtempSync(path.join(os.tmpdir(), "stepsemble-ab-"));
  t.after(() => { fs.rmSync(a, { recursive:true, force:true }); fs.rmSync(b, { recursive:true, force:true }); });
  f.host.create({ ...def, cwd:a }); f.host.create({ ...def, cwd:b }); await f.host.tick(); await wait(10);
  assert.equal(f.sends.length, 2);
});

test("failure kinds separate temporary errors, usage limits and sign-in problems", () => {
  for (const message of ["API Error: 529 {\"type\":\"overloaded_error\"}", "Codex turn failed: serverOverloaded Selected model is at capacity.", "fetch failed", "socket hang up",
    "Request failed with status 503", "rate_limit_error: Number of requests has exceeded your per-minute rate limit", "Codex turn failed: responseStreamDisconnected",
    "This conversation is busy; wait for it to finish", "Host is updating or shutting down; try again later", "read ECONNRESET", "Codex turn failed: httpConnectionFailed 502"])
    assert.equal(failureKind(message), "transient", message);
  for (const message of ["Claude AI usage limit reached|1792040000", "You've hit your usage limit. Try again in 2 hours.", "Codex turn failed: usageLimitExceeded",
    "insufficient_quota", "Your credit balance is too low to access the API"])
    assert.equal(failureKind(message), "quota", message);
  for (const message of ["claude-code_auth_required", "Please sign in to continue", "Not signed in"]) assert.equal(failureKind(message), "auth", message);
  for (const message of ["Pi process exited", "Agent rejected the prompt", "The Goal's conversation was removed", ""]) assert.equal(failureKind(message), null, message);
});

test("usage-limit retry time comes from the agent's message when it gives one", () => {
  const now = Date.parse("2026-10-09T00:00:00Z");
  assert.equal(retryDelay("Claude AI usage limit reached|1791518400", now), Date.parse("2026-10-09T04:00:00Z") - now + 60000);
  assert.equal(retryDelay("You've hit your usage limit. Try again in 2 hours.", now), 2 * 3600000 + 60000);
  assert.equal(retryDelay("Limit resets at 2026-10-09T03:00:00Z", now), 3 * 3600000 + 60000);
  assert.equal(retryDelay("Codex turn failed: usageLimitExceeded", now), null);
  assert.equal(retryDelay("Claude AI usage limit reached|1791000000", now), null);
});

test("a temporary error retries the same turn with backoff, without using a turn or the time budget", async t => {
  const sleeps = [], f = fixture(t, { sleeps }); f.host.create({ ...def, limits:{ turns:2 } }); await wait(10);
  f.pending.shift().resolve({ error:"API Error: 529 overloaded" }); await wait(20);
  assert.deepEqual(sleeps, [30000]); assert.equal(f.sends.length, 2); assert.match(f.sends[1], /temporary error/i);
  assert.equal(f.get().turns, 1); assert.equal(f.get().elapsedMs, 0); assert.equal(f.get().status, "running");
  f.pending.shift().resolve({ error:"fetch failed" }); await wait(20);
  f.pending.shift().resolve({ error:"fetch failed" }); await wait(20);
  assert.deepEqual(sleeps, [30000, 120000, 480000]); assert.equal(f.sends.length, 4);
  f.pending.shift().resolve({ error:"fetch failed" }); await wait(20);
  assert.equal(f.get().status, "failed"); assert.equal(f.sends.length, 4);
});

test("a successful turn resets the retry allowance", async t => {
  const sleeps = [], f = fixture(t, { sleeps }); f.host.create(def); await wait(10);
  f.pending.shift().resolve({ error:"fetch failed" }); await wait(20);
  f.pending.shift().resolve({ text:"Progress" }); await nextTurn(f);
  f.pending.shift().resolve({ error:"fetch failed" }); await wait(20);
  assert.deepEqual(sleeps, [30000, 30000]);
});

test("a temporary failure to open the conversation is retried", async t => {
  const sleeps = [], f = fixture(t, { sleeps }); f.bridge.openError = new Error("Host is updating or shutting down; try again later");
  f.host.create(def); await wait(20);
  assert.deepEqual(sleeps, [30000]); assert.equal(f.opens.length, 2); assert.equal(f.sends.length, 1); assert.equal(f.get().status, "running");
});

test("pausing during a retry wait stops the retry", async t => {
  const f = fixture(t); let release;
  const host = f.host; host.close();
  const sleep = (ms, signal) => new Promise((resolve, reject) => { release = resolve; signal.addEventListener("abort", () => reject(new Error("aborted")), { once:true }); });
  const paused = createWorkflows({ file:f.file + ".2", bridge:f.bridge, now:f.now, autoStart:false, sleep }); t.after(() => paused.close());
  paused.create(def); await wait(10);
  f.pending.shift().resolve({ error:"fetch failed" }); await wait(10);
  assert.equal(paused.list().runs[0].activity, "retrying"); assert.ok(paused.list().runs[0].retryAt);
  await paused.action({ id:paused.list().runs[0].id, action:"pause" }); await wait(10);
  assert.equal(paused.list().runs[0].status, "paused"); assert.equal(f.sends.length, 1); release?.();
});

test("a usage limit with a known reset waits as queued and continues afterwards", async t => {
  const f = fixture(t); f.host.create(def); await wait(10);
  f.pending.shift().resolve({ error:"You've hit your usage limit. Try again in 2 hours." }); await wait(10);
  const run = f.get(); assert.equal(run.status, "queued"); assert.equal(run.activity, "usage_reset"); assert.equal(run.notBefore, f.now() + 2 * 3600000 + 60000);
  assert.ok(f.host.locked(run.entry));
  f.advance(3600000); await f.host.tick(); await wait(10); assert.equal(f.sends.length, 1);
  f.advance(3600000 + 60000); await f.host.tick(); await wait(10);
  assert.equal(f.sends.length, 2); assert.equal(f.get().status, "running"); assert.equal(f.get().entry, run.entry);
  assert.equal(f.get().error, null, "a continued run no longer reports the usage limit");
});

test("a usage limit without a reset time is checked again every 30 minutes for up to 6 hours", async t => {
  const f = fixture(t); f.host.create(def); await wait(10);
  for (let i = 0; i < 12; i++) {
    f.pending.shift().resolve({ error:"Codex turn failed: usageLimitExceeded" }); await wait(10);
    assert.equal(f.get().status, "queued", `attempt ${i}`); assert.equal(f.get().notBefore, f.now() + 30 * 60000);
    f.advance(30 * 60000); await f.host.tick(); await wait(10);
  }
  f.pending.shift().resolve({ error:"Codex turn failed: usageLimitExceeded" }); await wait(10);
  assert.equal(f.get().status, "blocked"); assert.match(f.get().error, /usage limit/i);
});

test("a usage limit that resets more than 12 hours away blocks immediately", async t => {
  const f = fixture(t); f.host.create(def); await wait(10);
  f.pending.shift().resolve({ error:"You've hit your weekly usage limit. Try again in 72 hours." }); await wait(10);
  assert.equal(f.get().status, "blocked"); assert.match(f.get().error, /usage limit/i);
});

test("a Host restart keeps a run that is waiting for a usage reset", async t => {
  const f = fixture(t); f.host.create(def); await wait(10);
  f.pending.shift().resolve({ error:"You've hit your usage limit. Try again in 2 hours." }); await wait(10);
  const restarted = createWorkflows({ file:f.file, bridge:f.bridge, now:f.now, autoStart:false }); t.after(() => restarted.close());
  assert.equal(restarted.list().runs[0].status, "queued"); assert.equal(restarted.list().runs[0].activity, "usage_reset");
});

test("pinned model and permission are validated, stored, and cleared on edit", async t => {
  const f = fixture(t);
  assert.deepEqual(definition(def).choice, null); assert.equal(definition(def).permission, null);
  assert.deepEqual(definition({ ...def, choice:{ model:"anthropic/claude-opus-5-5", effort:"high", junk:"x" }, permission:"acceptEdits" }).choice, { model:"anthropic/claude-opus-5-5", effort:"high" });
  assert.throws(() => definition({ ...def, choice:{ model:"has space" } }), /model/);
  assert.throws(() => definition({ ...def, permission:"bad mode" }), /permission/);
  const schedule = f.host.create({ ...def, kind:"schedule", schedule:{ kind:"interval", minutes:15 }, choice:{ model:"opus" }, permission:"acceptEdits" });
  assert.deepEqual(schedule.choice, { model:"opus" }); assert.equal(schedule.permission, "acceptEdits");
  await f.host.action({ id:schedule.id, action:"run" }); await wait(10);
  assert.deepEqual(f.opens.at(-1).choice, { model:"opus" }); assert.equal(f.opens.at(-1).permission, "acceptEdits");
  const edited = await f.host.action({ ...def, id:schedule.id, action:"edit", schedule:{ kind:"interval", minutes:15 } });
  assert.equal(edited.choice, null); assert.equal(edited.permission, null);
});

test("a failed Codex turn passes its reason to the Goal", async () => {
  const events = createWorkflowEvents(), row = events.observe("codex", "s", () => {});
  events.emit("codex", "s", { type:"turn.started", turnId:"t" });
  events.emit("codex", "s", { type:"turn.completed", turnId:"t", status:"failed", error:"usageLimitExceeded: You've hit your usage limit." });
  const result = await row.promise; assert.match(result.error, /usageLimitExceeded/); assert.equal(failureKind(result.error), "quota");
});

test("only a Claude Code tool permission request counts as waiting for approval", () => {
  const events = createWorkflowEvents(), activity = [];
  events.observe("claude-code", "s", value => activity.push(value));
  events.emit("claude-code", "s", { type:"control_request", request:{ subtype:"hook_callback" } });
  events.emit("claude-code", "s", { type:"control_request", request:{ subtype:"mcp_message" } });
  assert.equal(activity.some(value => value.waiting), false);
  events.emit("claude-code", "s", { type:"control_request", request:{ subtype:"can_use_tool", tool_name:"Bash" } });
  assert.equal(activity.at(-1).waiting, true);
  events.emit("claude-code", "s", { type:"control_cancel_request", request_id:"r" });
  assert.equal(activity.at(-1).waiting, false);
  events.emit("claude-code", "s", { type:"permission_request" });
  assert.equal(activity.at(-1).waiting, true);
});

test("chat presentation hides a decorated final marker but keeps one followed by prose", () => {
  const { display } = require("../public/modules/workflow-text"), nonce = require("node:crypto").randomUUID(), done = `[[STEPSEMBLE_GOAL:${nonce}:complete]]`;
  for (const text of [`Verified.\n**${done}**`, `Verified.\n\`${done}\`.`, `Verified.\n\`\`\`\n${done}\n\`\`\``, `Verified.\n> ${done}`]) assert.equal(display(text), "Verified.", JSON.stringify(text));
  assert.equal(display(`${done}\nMore to do`), `${done}\nMore to do`);
});

test("chat presentation of a retried Goal turn hides the scaffold but keeps the retry note", () => {
  const { display } = require("../public/modules/workflow-text"), { goalPrompt } = require("../server/workflows");
  const run = { ...def, nonce:require("node:crypto").randomUUID(), turns:1, limits:{ turns:20 } };
  const shown = display(`The previous attempt stopped because of a temporary error or usage limit. Check the conversation and continue without repeating completed work.\n\n${goalPrompt(run)}`);
  assert.match(shown, /^The previous attempt stopped/); assert.doesNotMatch(shown, /STEPSEMBLE_GOAL|\[Stepsemble Goal\]/);
});
