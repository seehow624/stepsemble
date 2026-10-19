"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
const { parse, createRequest } = require("../public/modules/goal-composer.js");
const source = fs.readFileSync(path.join(__dirname, "../public/modules/goal-composer.js"), "utf8");
const app = fs.readFileSync(path.join(__dirname, "../public/app.js"), "utf8");
const limits = { minutes: 60, turns: 20, outputTokens: 100000 };
const flush = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };

// A minimal DOM adapter runs the actual controller and its event handlers.
// Browser QA separately verifies layout and native keyboard behavior.
class Element {
  constructor(tag) { this.tagName = tag; this.children = []; this.dataset = {}; this.events = {}; this.hidden = false; this.value = ""; }
  append(...nodes) { for (const n of nodes) { n.parentElement = this; this.children.push(n); } }
  before(n) { const p = this.parentElement; n.parentElement = p; p.children.splice(p.children.indexOf(this), 0, n); }
  setAttribute(k, v) { this[k] = v; }
  addEventListener(k, fn) { (this.events[k] ||= []).push(fn); }
  dispatchEvent(e) { for (const fn of this.events[e.type] || []) fn(e); }
  focus() { this.focused = true; }
  async click() { for (const fn of this.events.click || []) await fn(); }
  all() { return [this, ...this.children.flatMap(n => n.all())]; }
}
async function harness({ agent = "pi", connection = {}, post: postImpl, crypto, runs = [], workflowI18n, subagentBar = true } = {}) {
  const composer = new Element("footer"), input = new Element("textarea"), inner = new Element("div"); composer.append(inner);
  const bar = subagentBar ? new Element("div") : null;
  const events = {}, intervals = new Map(); let nextTimer = 0, uuid = 0;
  const h = { input, composer, bar, connection, agent, context: "host:1", runs, posts: [], changed: 0, started: [], now: 10000 };
  const root = { document: { getElementById: id => id === "input" ? input : id === "subagent-bar" ? bar : null, querySelector: () => inner, createElement: tag => new Element(tag), documentElement: { lang: "en" }, hidden: false },
    location: { search: "?entry=fixture-entry", origin: "http://localhost" }, parent: {},
    crypto: crypto || { randomUUID: () => "request-" + ++uuid }, Event: class { constructor(type) { this.type = type; } },
    stepsembleI18n: { tKey: (key, vars) => key + (vars ? " " + JSON.stringify(vars) : "") }, StepsembleWorkflowI18n: workflowI18n,
    addEventListener: (k, fn) => { (events[k] ||= []).push(fn); },
    setInterval: (fn, ms) => { intervals.set(++nextTimer, { fn, ms }); return nextTimer; }, clearInterval: id => intervals.delete(id) };
  const context = { window: root, module: { exports: {} }, URLSearchParams, Date: class extends Date { static now() { return h.now; } } };
  vm.runInNewContext(source, context);
  h.type = text => { input.value = text; input.dispatchEvent(new root.Event("input")); };
  const nodes = () => [composer, ...(bar ? [bar] : [])].flatMap(n => n.all());
  h.find = cls => nodes().find(n => (n.className || "").split(" ").includes(cls));
  h.field = name => nodes().find(n => n.name === name);
  h.button = label => nodes().find(n => n.tagName === "button" && n.textContent === "goalComposer." + label);
  h.controller = context.module.exports.mount({ api: async () => h.api ? h.api() : ({ runs: h.runs.map(r => ({ ...r })) }),
    post: async (route, body) => {
      h.posts.push({ route, body: JSON.parse(JSON.stringify(body)) });
      if (postImpl) return postImpl(body, h);
      const row = { id: "goal-" + h.posts.length, entry: "fixture-entry", objective: body.objective, status: "running", elapsedMs: 0, activity: "thinking", turns: 0 };
      h.runs.push(row); return row;
    }, getConnection: () => h.connection, getAgentId: () => h.agent, getContext: () => h.context,
    onStarted(text) { h.started.push(text); if (input.value === text) h.type(""); }, onChanged() { h.changed++; } });
  h.message = e => { for (const fn of events.message || []) fn(e); };
  h.tick = () => { for (const { fn, ms } of intervals.values()) if (ms === 1000) fn(); };
  h.close = () => { for (const fn of events.pagehide || []) fn(); assert.equal(intervals.size, 0); };
  h.parent = root.parent;
  await flush(); return h;
}

test("/goal is an exact leading command; ordinary messages and other commands remain text", () => {
  for (const text of ["/goal", "/goal "]) assert.deepEqual(parse(text), { objective: "" });
  assert.deepEqual(parse("  /GOAL 修復錯誤\n並驗證"), { objective: "修復錯誤\n並驗證" });
  for (const text of ["/goals", "/goalie x", "Explain /goal", "`/goal x`", "普通訊息", null]) assert.equal(parse(text), null);
});

test("Goal requests keep multiline objectives and validate every budget before posting", () => {
  const request = createRequest({ entry: "here", text: "/goal 修復\n檢查", limits, requestId: "id" });
  assert.equal(request.entry, "here"); assert.equal(request.objective, "修復\n檢查"); assert.equal(request.title, "修復");
  assert.deepEqual(request.limits, limits); assert.equal(request.kind, "goal"); assert.equal(request.agentId, undefined);
  assert.equal(createRequest({ entry: "here", text: "/goal x", limits, title: "x".repeat(200) }).title.length, 120);
  assert.equal(createRequest({ entry: "here", text: "/goal default name", limits, title: "   " }).title, "default name");
  for (const budget of [undefined, { ...limits, minutes: 0 }, { ...limits, minutes: 1.5 }, { ...limits, turns: 101 }, { ...limits, outputTokens: 99 }, { ...limits, outputTokens: 10000001 }]) {
    assert.throws(() => createRequest({ text: "/goal x", limits: budget }), /limits/);
  }
  for (const text of ["/goal", "/goal " + "x".repeat(16001)]) assert.throws(() => createRequest({ text, limits }), /objective/);
});

test("one submission starts the current entry and swaps the draft above the input for a Goal chip beside the subagents", async () => {
  const h = await harness(); h.type("/goal 修復並測試");
  assert.equal(h.composer.children[0], h.find("goal-composer"));
  assert.equal(h.find("goal-draft").hidden, false); assert.equal(h.find("goal-chip").hidden, true);
  h.field("minutes").value = "30"; h.field("tokens").value = "20000"; h.field("turns").value = "5";
  await h.controller.submit(h.input.value);
  assert.equal(h.posts.length, 1); assert.deepEqual(h.posts[0].body.limits, { minutes: 30, outputTokens: 20000, turns: 5 });
  assert.equal(h.posts[0].body.entry, "fixture-entry"); assert.equal(h.input.value, "");
  assert.equal(h.find("goal-composer").hidden, true, "nothing is left above the input");
  assert.equal(h.find("goal-chip").parentElement, h.bar); assert.equal(h.find("goal-chip").hidden, false);
  assert.equal(h.find("goal-panel").hidden, true, "progress starts closed");
  assert.equal(h.changed, 1); assert.equal(h.controller.commandItem().name, "goal"); h.close();
});

test("the Goal chip says how the Goal is doing and for how long, and opens its progress and closes it again", async () => {
  const h = await harness({ runs: [{ id: "g1", entry: "fixture-entry", objective: "Ship the release", status: "running", elapsedMs: 65000, activity: "thinking", turns: 2, outputTokens: 900 }] });
  await h.controller.refresh();
  const chip = h.find("goal-chip"), panel = h.find("goal-panel");
  assert.equal(h.find("goal-chip-state").textContent, "goalComposer.state.running");
  assert.equal(h.find("goal-chip-clock").textContent, "01:05");
  assert.equal(chip.dataset.state, "running"); assert.equal(chip.dataset.ticking, "true");
  h.now += 5000; h.tick(); assert.equal(h.find("goal-chip-clock").textContent, "01:10", "a working Goal's time goes on");
  assert.equal(panel.hidden, true); assert.equal(chip["aria-expanded"], "false");
  await chip.click();
  assert.equal(panel.hidden, false); assert.equal(h.find("goal-live").hidden, false); assert.equal(chip["aria-expanded"], "true");
  assert.equal(h.find("goal-live").children[1].textContent, "Ship the release");
  await chip.click();
  assert.equal(panel.hidden, true); assert.equal(chip["aria-expanded"], "false");
  // Finished: it says so and keeps the time it took.
  h.runs = [{ ...h.runs[0], status: "completed", elapsedMs: 3723000, result: "Released" }];
  await h.controller.refresh(); h.now += 60000; h.tick();
  assert.equal(h.find("goal-chip-state").textContent, "goalComposer.state.completed");
  assert.equal(h.find("goal-chip-clock").textContent, "1:02:03"); assert.equal(chip.dataset.ticking, "false");
  await chip.click(); assert.equal(panel.hidden, false);
  // Another Goal starts closed.
  h.runs = [{ id: "g2", entry: "fixture-entry", objective: "Next", status: "running", elapsedMs: 0, activity: "thinking" }];
  await h.controller.refresh(); assert.equal(panel.hidden, true); h.close();
});

test("a /goal draft typed while a Goal shows keeps the chip; an error shows above the input", async () => {
  const h = await harness({ post: () => { throw new Error("Host refused"); },
    runs: [{ id: "g1", entry: "fixture-entry", objective: "Done before", status: "completed", elapsedMs: 1000 }] });
  await h.controller.refresh();
  h.type("/goal again");
  assert.equal(h.find("goal-draft").hidden, false); assert.equal(h.find("goal-chip").hidden, true, "the draft replaces a finished Goal's chip");
  await h.controller.submit(h.input.value);
  assert.equal(h.find("goal-composer").hidden, false); assert.equal(h.find("goal-error").hidden, false);
  assert.equal(h.find("goal-error").textContent, "Host refused"); h.close();
});

test("a page without the subagent bar keeps Goal progress above the input", async () => {
  const h = await harness({ subagentBar: false, runs: [{ id: "g1", entry: "fixture-entry", objective: "work", status: "running", elapsedMs: 0, activity: "thinking" }] });
  await h.controller.refresh();
  assert.equal(h.find("goal-composer").hidden, false); assert.equal(h.find("goal-live").hidden, false);
  assert.equal(h.find("goal-live").parentElement, h.find("goal-composer")); h.close();
});

test("repeated Enter while creation is pending cannot create two Goals or erase a newer draft", async () => {
  const pending = deferred(), h = await harness({ post: () => pending.promise });
  h.type("/goal first"); const sending = h.controller.submit(h.input.value);
  await h.controller.submit(h.input.value); assert.equal(h.posts.length, 1);
  h.type("new unsent message");
  pending.resolve({ id: "created", entry: "fixture-entry", objective: "first", status: "running" }); await sending;
  assert.equal(h.input.value, "new unsent message"); assert.equal(h.started.length, 1); h.close();
});

test("uncertain POST outcomes keep the draft and reuse the request ID; confirmed new Goals get new IDs", async () => {
  let calls = 0;
  const h = await harness({ post: (body, state) => {
    if (++calls === 1) throw new Error("connection lost after sending");
    const run = { id: "done-" + calls, entry: "fixture-entry", objective: body.objective, status: "completed", elapsedMs: 2000 };
    state.runs.push(run); return run;
  } });
  h.type("/goal same objective"); await h.controller.submit(h.input.value);
  assert.equal(h.input.value, "/goal same objective"); assert.equal(h.find("goal-error").hidden, false);
  await h.controller.submit(h.input.value);
  assert.equal(h.posts[0].body.requestId, h.posts[1].body.requestId); assert.equal(h.input.value, "");
  h.type("/goal same objective"); await h.controller.submit(h.input.value);
  assert.notEqual(h.posts[1].body.requestId, h.posts[2].body.requestId); h.close();
});

test("late creation replies after switching context cannot clear or populate the new view", async () => {
  const pending = deferred(), h = await harness({ post: () => pending.promise }); h.type("/goal first");
  const sending = h.controller.submit(h.input.value); h.context = "other-host:2"; h.type("new host draft");
  pending.resolve({ id: "old", entry: "fixture-entry", status: "running" }); await sending;
  assert.equal(h.started.length, 0); assert.equal(h.changed, 0); assert.equal(h.input.value, "new host draft"); h.close();
});

for (const [name, options, submitOptions, errorKey] of [
  ["read-only", { connection: { readOnly: true } }, {}, "unsupported"],
  ["native history read-only", { connection: { nativeHistoryReadonly: true } }, {}, "unsupported"],
  ["unsupported agent", { agent: "antigravity" }, {}, "unsupported"],
  ["busy model", { connection: { streaming: true } }, {}, "busy"],
  ["busy ACP", { connection: { acpPromptInFlight: true } }, {}, "busy"],
  ["attachments", {}, { hasAttachments: true }, "attachments"],
]) test(`${name} leaves the draft intact and never sends a Goal`, async () => {
  const h = await harness(options); h.type("/goal objective"); await h.controller.submit(h.input.value, submitOptions);
  assert.equal(h.posts.length, 0); assert.equal(h.input.value, "/goal objective");
  assert.equal(h.find("goal-error").textContent, "goalComposer." + errorKey); h.close();
});

test("polling keeps focused limits and expanded settings; the timer freezes while paused or disconnected", async () => {
  const h = await harness(); h.type("/goal test"); const field = h.field("minutes"); field.value = "17"; field.focus(); h.find("goal-more").open = true;
  await h.controller.refresh(); assert.equal(h.field("minutes"), field); assert.equal(field.value, "17"); assert.equal(field.focused, true); assert.equal(h.find("goal-more").open, true);
  h.type(""); h.runs = [{ id: "g", entry: "fixture-entry", objective: "test", status: "running", elapsedMs: 2000, activity: "thinking" }];
  await h.controller.refresh(); h.now += 5000; h.tick(); assert.match(h.find("goal-clock").textContent, /00:07/);
  h.runs[0].status = "paused"; await h.controller.refresh(); h.now += 5000; h.tick(); assert.match(h.find("goal-clock").textContent, /00:02/); h.close();
});

test("pause, resume and stop act on the displayed run; untrusted parent events cannot refresh it", async () => {
  const h = await harness({ post: (body, state) => {
    state.runs[0].status = { pause: "paused", resume: "running", stop: "stopped" }[body.action]; return state.runs[0];
  } });
  h.runs = [{ id: "displayed-run", entry: "fixture-entry", objective: "work", status: "running", activity: "thinking", elapsedMs: 1000 }];
  await h.controller.refresh(); await h.button("pause").click(); assert.equal(h.button("resume").hidden, false);
  await h.button("resume").click(); await h.button("stop").click();
  assert.deepEqual(h.posts.map(p => p.body), [{ id: "displayed-run", action: "pause" }, { id: "displayed-run", action: "resume" }, { id: "displayed-run", action: "stop" }]);
  h.runs[0].objective = "new";
  h.message({ origin: "https://untrusted.invalid", source: h.parent, data: { type: "workspace-workflows-changed" } }); await flush();
  assert.equal(h.find("goal-live").children[1].textContent, "work");
  h.message({ origin: "http://localhost", source: h.parent, data: { type: "workspace-workflows-changed" } }); await flush();
  assert.equal(h.find("goal-live").children[1].textContent, "new"); h.close();
});

test("the real send handler routes /goal to the Host controller before native agent prompts", async () => {
  const start = app.indexOf("async function sendCurrent() {");
  const end = app.indexOf('\nel.btnAbort.addEventListener', start);
  const submitted = [], queued = [], input = { value: "/goal verify this project" };
  const context = { el: { input }, rpc: {}, pendingImages: [], conversationGoal: { submit: async (...args) => submitted.push(args) }, sendOnceConnected: () => queued.push(true) };
  vm.runInNewContext(app.slice(start, end), context);
  await context.sendCurrent(); assert.equal(submitted.length, 1); assert.equal(submitted[0][0], input.value);
  context.rpc = null; await context.sendCurrent(); assert.equal(queued.length, 1); assert.equal(submitted.length, 1);
});

test("an older poll cannot erase a Goal that has just been acknowledged", async () => {
  const h = await harness(), pending = deferred(); h.api = () => pending.promise;
  const polling = h.controller.refresh(); h.type("/goal fresh"); await h.controller.submit(h.input.value);
  assert.equal(h.find("goal-chip").hidden, false);
  pending.resolve({ runs: [] }); await polling;
  assert.equal(h.find("goal-chip").hidden, false); assert.equal(h.find("goal-live").children[1].textContent, "fresh"); h.close();
});

test("a poll recovers a Goal when its POST response was lost without issuing a second write", async () => {
  const h = await harness({ post: (body, state) => {
    state.runs.push({ ...body, id: "committed", status: "running", elapsedMs: 0 });
    throw new Error("response lost");
  } });
  h.type("/goal recover"); await h.controller.submit(h.input.value); assert.equal(h.input.value, "/goal recover");
  await h.controller.refresh(); assert.equal(h.input.value, ""); assert.equal(h.posts.length, 1); assert.equal(h.started.length, 1);
  assert.equal(h.find("goal-chip").hidden, false); h.close();
});

test("a poll acknowledgment and a late successful POST acknowledge the draft only once", async () => {
  const pending = deferred(), h = await harness({ post: (body, state) => {
    state.runs.push({ ...body, id: "committed", status: "running", elapsedMs: 0 }); return pending.promise;
  } });
  h.type("/goal once"); const sending = h.controller.submit(h.input.value);
  await h.controller.refresh(); pending.resolve(h.runs[0]); await sending;
  assert.equal(h.started.length, 1); assert.equal(h.changed, 1); h.close();
});

test("a disconnected timer keeps its displayed elapsed time until the Host answers again", async () => {
  const h = await harness(); h.runs = [{ id: "g", entry: "fixture-entry", objective: "test", status: "running", elapsedMs: 2000 }];
  await h.controller.refresh(); h.now += 5000; h.tick(); assert.match(h.find("goal-clock").textContent, /00:07/);
  h.api = () => { throw new Error("offline"); }; await h.controller.refresh(); h.now += 5000; h.tick();
  assert.match(h.find("goal-clock").textContent, /00:07/); assert.equal(h.find("goal-activity").textContent, "goalComposer.disconnected"); h.close();
});

test("mobile HTTP access can create a valid idempotency ID without crypto.randomUUID", async () => {
  const h = await harness({ crypto: { getRandomValues: array => require("node:crypto").randomFillSync(array) } });
  h.type("/goal phone"); await h.controller.submit(h.input.value);
  assert.match(h.posts[0].body.requestId, /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/); h.close();
});

test("a Goal waiting to retry, for its project or for a usage reset says so, and its held clock does not advance", async () => {
  const workflowI18n = require("../public/modules/workflows-i18n.js");
  const row = { id: "g", entry: "fixture-entry", objective: "Ship", status: "running", activity: "retrying", retryAt: 70000, error: "fetch failed", elapsedMs: 5000, clockRunning: false, turns: 1 };
  const h = await harness({ runs: [row], workflowI18n });
  assert.match(h.find("goal-activity").textContent, /Retrying after a temporary error/);
  const before = h.find("goal-clock").textContent; h.now += 10000; h.tick(); assert.equal(h.find("goal-clock").textContent, before);
  h.close();
  const busy = await harness({ runs: [{ ...row, status: "queued", activity: "project_busy", error: null }], workflowI18n });
  assert.match(busy.find("goal-activity").textContent, /Waiting for another task in this project/); busy.close();
  const quota = await harness({ runs: [{ ...row, status: "queued", activity: "usage_reset", notBefore: 7200000, error: "usage limit" }], workflowI18n });
  assert.match(quota.find("goal-activity").textContent, /usage limit to reset/); quota.close();
});

test("a running Goal pauses or stops; a waiting or ended one is removed from the conversation; another panel opening closes it", async () => {
  const h = await harness({ post: (body, state) => {
    const run = state.runs[0];
    if (body.action === "pause") run.status = "paused";
    if (body.action === "dismiss") { run.status = "stopped"; run.dismissedAt = 5; state.runs = []; return run; }
    return run;
  } });
  h.runs = [{ id: "shown", entry: "fixture-entry", objective: "work", status: "running", activity: "thinking", elapsedMs: 1000 }];
  await h.controller.refresh();
  const visible = () => ["pause", "resume", "stop", "remove"].filter(label => !h.button(label).hidden);
  assert.deepEqual(visible(), ["pause", "stop"]);
  await h.button("pause").click();
  assert.deepEqual(visible(), ["resume", "remove"], "a paused Goal goes on or is removed");
  const chip = h.find("goal-chip");
  await chip.click(); assert.equal(h.find("goal-panel").hidden, false);
  h.controller.collapse(); assert.equal(h.find("goal-panel").hidden, true);
  await h.button("remove").click();
  assert.deepEqual(h.posts.at(-1).body, { id: "shown", action: "dismiss" });
  assert.equal(chip.hidden, true, "a removed Goal leaves the conversation");
  h.runs = [{ id: "done", entry: "fixture-entry", objective: "work", status: "completed", activity: "completed", elapsedMs: 1000, result: "All done" }];
  await h.controller.refresh();
  assert.equal(chip.hidden, false); assert.deepEqual(visible(), ["remove"]);
  h.close();
});
