"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { create } = require("../public/modules/agent-speed");
function fixture(t, { confirm = async () => true, inPlace = false } = {}) {
  const old = global.document;
  const created = [];
  const element = () => {
    const e = { options: [], textContent: "", value: "", disabled: false, hidden: false, events: {},
      append(...nodes) { this.options.push(...nodes); for (const node of nodes) node.parent = this; },
      remove() { this.parent.options = this.parent.options.filter(row => row !== this); this.parent = null; },
      focus() { global.document.activeElement = this; }, setAttribute(k, v) { this[k] = v; },
      toggleAttribute(k, value) { this[k] = value; }, getAttribute(k) { return this[k]; },
      addEventListener(k, fn) { this.events[k] = fn; } };
    created.push(e); return e;
  };
  global.document = { createElement: element }; t.after(() => { global.document = old; });
  const root = element(), panel = inPlace ? element() : null, indicator = element(), button = element(), description = element(), reads = [], writes = [], errors = [];
  let target = { key: "codex:a:model", agentId: "codex", sessionId: "a", model: "model" };
  const ui = create({ root, panel, indicator, button, description, context: () => target, confirm: inPlace ? null : confirm, onError: e => errors.push(e),
    get: () => new Promise((resolve, reject) => reads.push({ resolve, reject })),
    post: (_url, body) => new Promise((resolve, reject) => writes.push({ body, resolve, reject })) });
  return { ui, select: created.find(e => e.id === "agent-speed-select"), note: created.find(e => e.id === "agent-speed-note"),
    choices: () => created.filter(e => e.parent && e.className === "speed-choice"), info: created.find(e => e.className === "speed-info"),
    ask: created.find(e => e.id === "agent-speed-confirm"), byClass: name => created.find(e => e.className?.split(" ").includes(name)),
    panel, description, indicator, reads, writes, errors, setTarget: value => { target = value; } };
}
const supported = { support: "supported", requested: "standard", effective: "unknown", revision: "r1", fingerprint: "verified" };
const tick = () => new Promise(resolve => setImmediate(resolve));
const ultraCapability = tiers => require("../server/agent-speed").codexSpeedCapability({ version: "0.163.0", config: {}, model: "model", models: [{ id: "model", model: "model", serviceTiers: tiers.map(id => ({ id })) }] });
test("agent-speed UI: pending toggle save keeps native focusability, blocks repeats and never restores unrelated focus", async t => {
  const f = fixture(t), cap = { ...supported, ...ultraCapability(["priority", "ultrafast"]) };
  const read = f.ui.refresh(); f.reads[0].resolve(cap); await read;
  const fast = f.choices().find(e => e["data-speed"] === "fast"), ultra = f.choices().find(e => e["data-speed"] === "ultrafast");
  fast.focus(); fast.events.click(); await tick();
  try {
    assert.equal(fast.disabled, false, "native disabled would remove keyboard focus during a delayed POST");
    assert.equal(fast["aria-disabled"], "true"); assert.equal(fast.parent["aria-busy"], "true");
    assert.equal(fast.events.keydown, undefined, "arrows never trigger paid changes"); ultra.events.click(); await tick();
    assert.equal(f.writes.length, 1, "busy toggles must not create another confirmation/save");
    assert.equal(global.document.activeElement, fast);
    const elsewhere = global.document.createElement("button"); elsewhere.focus();
    f.writes[0].resolve({ ...cap, requested: "fast" }); await f.ui.ready(); await tick();
    assert.equal(global.document.activeElement, elsewhere, "completion never steals focus back");
    assert.equal(fast["aria-disabled"], "false"); assert.equal(fast.parent["aria-busy"], "false");
  } finally { f.writes[0].resolve({ ...cap, requested: "fast" }); await f.ui.ready(); }
});
test("agent-speed UI: no hidden premium upsell; Ultra DOM exists only for a verified offered native tier", async t => {
  const f = fixture(t); let read = f.ui.refresh(); f.reads[0].resolve(supported); await read;
  assert.equal(f.select.hidden, true); assert.equal(f.select.tabIndex, -1);
  assert.equal(f.choices().some(e => e["data-speed"] === "ultrafast"), false);
  assert.equal(f.info["aria-expanded"], "false", "long explanations are optional, not a status paragraph");
  assert.equal(f.note.hidden, true);
  read = f.ui.refresh(); f.reads[1].resolve({ ...supported, ...ultraCapability(["ultrafast"]) }); await read;
  assert.deepEqual(f.choices().filter(e => !e.hidden).map(e => e["data-speed"]), ["ultrafast"]);
  read = f.ui.refresh(); f.reads[2].resolve({ ...supported, ...ultraCapability(["priority", "ultrafast"]) }); await read;
  assert.equal(f.choices().filter(e => !e.hidden).length, 2);
  read = f.ui.refresh(); f.reads[3].resolve({ ...supported, ...ultraCapability(["priority", "ultrafast"]), route: "magpie" }); await read;
  assert.equal(f.choices().some(e => e["data-speed"] === "ultrafast"), false);
});
test("agent-speed UI: unknown Ultra still allows Standard recovery and removes its option", async t => {
  const f = fixture(t); let read = f.ui.refresh();
  f.reads[0].resolve({ ...supported, ...ultraCapability(["ultrafast"]), requested: "ultrafast" }); await read;
  read = f.ui.refresh(); f.reads[1].reject(new Error("offline")); await read;
  assert.equal(f.select.disabled, false); assert.equal(f.choices().some(e => e["data-speed"] === "ultrafast"), false);
  const standard = f.choices().find(e => e["data-speed"] === "standard");
  assert.equal(standard.disabled, false); assert.equal(standard.tabIndex, 0);
  f.select.value = "standard"; const save = f.select.events.change(); await tick();
  f.writes[0].resolve({ ...supported, support: "unknown", requested: "standard" }); await save;
  assert.equal(f.ui.snapshot().speed, "standard"); assert.equal(f.indicator.hidden, true);
});
test("agent-speed UI: Fast to Ultra confirms the named tier, uses separate consent and survives cancel/context change", async t => {
  const confirmations = []; let accept = true;
  const f = fixture(t, { confirm: async text => { confirmations.push(text); return accept; } });
  const cap = { ...supported, ...ultraCapability(["priority", "ultrafast"]), requested: "fast" };
  let read = f.ui.refresh(); f.reads[0].resolve(cap); await read;
  f.select.value = "ultrafast"; let save = f.select.events.change(); await tick();
  assert.match(confirmations[0], /^Turn on Ultra Fast\?/); assert.match(confirmations[0], /cost more/); assert.match(confirmations[0], /subagents/);
  assert.equal(f.writes[0].body.fingerprint, cap.fingerprints.ultrafast);
  assert.equal(f.writes[0].body.confirmCost, true);
  f.writes[0].resolve({ ...cap, requested: "ultrafast", preferenceFingerprint: cap.fingerprints.ultrafast }); await save;
  assert.equal(f.ui.snapshot().speed, "ultrafast"); assert.equal(f.indicator["data-speed"], "ultrafast");
  assert.match(f.description.textContent, /Ultra Fast requested/);
  accept = false; f.select.value = "fast"; save = f.select.events.change(); await save;
  assert.equal(f.writes.length, 1); assert.equal(f.select.value, "ultrafast");
  f.setTarget({ key: "pi:next:model", agentId: "pi", sessionId: "next", model: "model" });
  read = f.ui.sync(); assert.equal(f.indicator.hidden, true);
  assert.equal(f.choices().some(e => e["data-speed"] === "ultrafast"), false);
  f.reads[1].resolve({ ...supported, support: "unknown" }); await read;
});
test("agent-speed UI: exact paid DOM, stable controls, mutually exclusive toggles and active-click Standard", async t => {
  const f = fixture(t);
  const both = { ...supported, ...ultraCapability(["priority", "ultrafast"]) };
  const values = () => f.choices().map(e => e["data-speed"]);
  for (const [tiers, expected] of [[[], []], [["priority"], ["fast"]], [["ultrafast"], ["ultrafast"]], [["priority", "ultrafast"], ["fast", "ultrafast"]]]) {
    const read = f.ui.refresh(); f.reads.at(-1).resolve({ ...supported, ...ultraCapability(tiers) }); await read;
    assert.deepEqual(values().sort(), expected.sort());
    assert.ok(f.choices().every(e => e["aria-pressed"] === "false"));
  }
  const fast = f.choices().find(e => e["data-speed"] === "fast");
  const ultra = f.choices().find(e => e["data-speed"] === "ultrafast");
  assert.match(fast.innerHTML, /<svg/); assert.match(ultra.innerHTML, /speed-plus/);
  for (const [button, value] of [[fast, "fast"], [ultra, "ultrafast"], [fast, "fast"], [fast, "standard"], [ultra, "ultrafast"], [ultra, "standard"]]) {
    button.focus(); button.events.click(); await tick();
    const write = f.writes.at(-1); assert.equal(write.body.speed, value);
    assert.equal(write.body.confirmCost, value !== "standard"); assert.equal(write.body.revision, "r1");
    write.resolve({ ...both, requested: value }); await f.ui.ready();
    assert.equal(f.ui.snapshot().speed, value);
    assert.equal(fast["aria-pressed"], String(value === "fast"));
    assert.equal(ultra["aria-pressed"], String(value === "ultrafast"));
    assert.equal(global.document.activeElement, button);
    assert.equal(f.choices().find(e => e["data-speed"] === "fast"), fast, "render preserves the button");
  }
});
test("agent-speed UI: failed toggle POST rolls back and revoked paid tier has only off recovery", async t => {
  const f = fixture(t), cap = { ...supported, ...ultraCapability(["priority", "ultrafast"]) };
  let read = f.ui.refresh(); f.reads[0].resolve(cap); await read;
  const fast = f.choices().find(e => e["data-speed"] === "fast"); fast.focus(); fast.events.click(); await tick();
  f.writes[0].reject(new Error("CAS conflict")); await tick();
  f.reads[1].resolve(cap); await f.ui.ready();
  assert.equal(f.ui.snapshot().speed, "standard"); assert.match(f.errors[0], /not saved/);
  assert.equal(global.document.activeElement, fast, "failed save readback retains focus");
  read = f.ui.refresh(); f.reads[2].resolve({ ...cap, requested: "ultrafast", choices: ["standard", "fast"] }); await read;
  assert.deepEqual(f.choices().map(e => e["data-speed"]), ["fast", "standard"]);
  f.choices().find(e => e["data-speed"] === "standard").events.click(); await tick();
  assert.equal(f.writes[1].body.speed, "standard"); assert.equal(f.writes[1].body.confirmCost, false);
  f.writes[1].resolve({ ...cap, choices: ["standard", "fast"] }); await f.ui.ready();
  assert.deepEqual(f.choices().map(e => e["data-speed"]), ["fast"]);
});
test("agent-speed UI: model/session change during paid confirmation cannot authorize the new context", async t => {
  let accept;
  const f = fixture(t, { confirm: () => new Promise(resolve => { accept = resolve; }) });
  const read = f.ui.refresh(); f.reads[0].resolve(supported); await read;
  f.select.value = "fast"; const save = f.select.events.change(); await tick();
  f.setTarget({ key: "codex:next:other", agentId: "codex", sessionId: "next", model: "other" });
  const fresh = f.ui.sync(); assert.equal(f.choices().length, 0);
  accept(true); await save;
  assert.equal(f.writes.length, 0, "old confirmation is not a new conversation's consent");
  f.reads[1].resolve(supported); await fresh;
  assert.equal(f.ui.snapshot().speed, "standard");
});
test("agent-speed UI: supported Magpie keeps the forwarding warning without an unverified-route denial", async t => {
  const f = fixture(t); const read = f.ui.refresh();
  f.reads[0].resolve({ ...supported, route: "magpie", reason: "speed_gateway_requested" }); await read;
  assert.equal(f.select.disabled, false);
  assert.match(f.byClass("speed-note-gateway").textContent, /global overrides or fallback/);
  assert.equal(f.byClass("speed-note-gateway").hidden, false);
  assert.doesNotMatch(f.byClass("speed-note-main").textContent, /contract is unverified/);
  assert.doesNotMatch(f.description.textContent, /contract is unverified/);
});
test("agent-speed UI: another conversation\'s pending save cannot reset a focused selection or delay readiness", async t => {
  const f = fixture(t); let read = f.ui.refresh(); f.reads[0].resolve(supported); await read;
  f.select.value = "fast"; const oldSave = f.select.events.change(); await tick();
  try {
    f.setTarget({ key: "pi:b:model", agentId: "pi", sessionId: "b", model: "model" });
    read = f.ui.sync(); f.reads[1].resolve(supported); await read;
    global.document.activeElement = f.select; f.select.value = "fast";
    read = f.ui.refresh(); f.reads[2].resolve(supported); await read;
    assert.equal(f.select.value, "fast");
    let ready = false; const readiness = f.ui.ready().then(() => { ready = true; }); await tick();
    assert.equal(ready, true, "readiness is scoped to the current conversation"); await readiness;
  } finally { f.writes[0].resolve({ ...supported, requested: "fast" }); await oldSave; }
});
test("agent-speed UI: focus GET cannot disable picker or swallow a committed selection; late GET cannot undo save", async t => {
  const f = fixture(t); const initial = f.ui.refresh(); f.reads[0].resolve(supported); await initial;
  const focus = f.ui.refresh();
  assert.equal(f.select.disabled, false);
  f.select.value = "fast"; const save = f.select.events.change(); await tick();
  assert.equal(f.writes.length, 1);
  f.writes[0].resolve({ ...supported, requested: "fast" }); await save;
  f.reads[1].resolve(supported); await focus;
  assert.equal(f.ui.snapshot().speed, "fast"); assert.equal(f.indicator.hidden, false);
});
test("agent-speed UI: confirmation focus is serialized and repeated GETs coalesce", async t => {
  let accept; const f = fixture(t, { confirm: () => new Promise(resolve => { accept = resolve; }) });
  const first = f.ui.refresh(); const second = f.ui.refresh(); assert.equal(f.reads.length, 1);
  f.reads[0].resolve(supported); await Promise.all([first, second]);
  f.select.value = "fast"; const save = f.select.events.change();
  const focus = f.ui.refresh(); assert.equal(f.reads.length, 1);
  await tick(); accept(true); await tick(); f.writes[0].resolve({ ...supported, requested: "fast" }); await Promise.all([save, focus]);
  assert.equal(f.ui.snapshot().speed, "fast");
});
test("agent-speed UI: failed GET is explicit/fail-closed, retry recovers, context switch clears lightning immediately", async t => {
  const f = fixture(t); let read = f.ui.refresh(); f.reads[0].resolve({ ...supported, requested: "fast" }); await read;
  read = f.ui.refresh(); f.reads[1].reject(new Error("secret URL must not appear")); await read;
  assert.match(f.errors[0], /could not be verified/i);
  assert.equal(f.choices().some(e => e["data-speed"] === "fast"), false); assert.equal(f.select.disabled, false, "Standard recovery stays available");
  read = f.ui.refresh(); f.reads[2].resolve(supported); await read;
  assert.equal(f.select.disabled, false);
  f.setTarget({ key: "pi:b:other", agentId: "pi", sessionId: "b", model: "other" });
  read = f.ui.sync(); assert.equal(f.indicator.hidden, true);
  f.reads[3].resolve({ ...supported, support: "unknown", reason: "speed_route_unverified" }); await read;
  assert.equal(f.select.disabled, true);
});
test("agent-speed UI: a same-key GET preserves an in-progress native selection until commit", async t => {
  const f = fixture(t); const initial = f.ui.refresh(); f.reads[0].resolve(supported); await initial;
  global.document.activeElement = f.select;
  const refresh = f.ui.refresh(); f.select.value = "fast";
  f.reads[1].resolve(supported); await refresh;
  assert.equal(f.select.value, "fast");
  const save = f.select.events.change(); await tick();
  f.writes[0].resolve({ ...supported, requested: "fast" }); await save;
  assert.equal(f.select.value, "fast"); assert.equal(f.ui.snapshot().speed, "fast");
});
test("agent-speed UI: old GET/save/confirmation cannot leak into a new or read-only conversation", async t => {
  const f = fixture(t); const old = f.ui.refresh();
  f.setTarget({ key: "claude:b:model", agentId: "claude-code", sessionId: "b", model: "model" });
  const fresh = f.ui.sync(); f.reads[1].resolve(supported); await fresh;
  f.reads[0].resolve({ ...supported, requested: "fast" }); await old;
  assert.equal(f.ui.snapshot().speed, "standard"); assert.equal(f.indicator.hidden, true);
  f.select.value = "fast"; const save = f.select.events.change(); await tick();
  f.setTarget(null); await f.ui.sync(); assert.equal(f.indicator.hidden, true);
  f.writes[0].resolve({ ...supported, requested: "fast" }); await save;
  assert.deepEqual(f.ui.snapshot(), { speed: "standard" });
  assert.equal(f.indicator.hidden, true);
});
test("agent-speed UI: runtime-ready recheck does not coalesce away behind an older focus observation", async t => {
  const f = fixture(t); const early = f.ui.refresh();
  const ready = f.ui.refresh({ afterPending: true });
  f.reads[0].resolve({ support: "unknown", requested: "standard", reason: "speed_runtime_inactive" }); await early; await tick();
  assert.equal(f.reads.length, 2);
  f.reads[1].resolve(supported); await ready;
  assert.equal(f.select.disabled, false);
});
test("agent-speed UI: a pending save in another conversation cannot swallow this conversation's choice", async t => {
  const f = fixture(t); let read = f.ui.refresh(); f.reads[0].resolve(supported); await read;
  f.select.value = "fast"; const oldSave = f.select.events.change(); await tick();
  f.setTarget({ key: "pi:b:model", agentId: "pi", sessionId: "b", model: "model" });
  read = f.ui.sync(); f.reads[1].resolve(supported); await read;
  assert.equal(f.select.disabled, false);
  f.select.value = "fast"; const newSave = f.select.events.change(); await tick();
  assert.equal(f.writes.length, 2);
  f.writes[0].resolve({ ...supported, requested: "fast" }); await oldSave;
  assert.equal(f.ui.snapshot().speed, "standard");
  f.writes[1].resolve({ ...supported, requested: "fast" }); await newSave;
  assert.equal(f.ui.snapshot().speed, "fast"); assert.equal(f.indicator.hidden, false);
});

test("agent-speed UI: a paid tier is confirmed in place below the heading, and only its own button there confirms", async t => {
  const f = fixture(t, { inPlace: true }), cap = { ...supported, ...ultraCapability(["priority", "ultrafast"]) };
  const read = f.ui.refresh(); f.reads[0].resolve(cap); await read;
  const fast = f.choices().find(e => e["data-speed"] === "fast"), ultra = f.choices().find(e => e["data-speed"] === "ultrafast");
  assert.equal(f.panel.hidden, true, "nothing opens below the heading until asked");
  assert.equal(f.note.parent, f.panel); assert.equal(f.ask.parent, f.panel);
  f.info.events.click();
  assert.deepEqual([f.note.hidden, f.info["aria-expanded"], f.panel.hidden], [false, "true", false], "details open below the heading");
  assert.equal(f.byClass("speed-note-state").textContent, "Reported state: Unknown");
  fast.events.click(); await tick();
  assert.deepEqual([f.ask.hidden, f.note.hidden, fast["data-pending"]], [false, true, "true"], "the confirmation takes the details' place");
  assert.equal(f.byClass("speed-confirm-title").options[1].textContent, "Turn on Fast?");
  assert.equal(f.byClass("speed-confirm-ok").textContent, "Turn on Fast");
  assert.equal(global.document.activeElement, f.byClass("speed-confirm-cancel"), "a repeated Enter cannot confirm a cost");
  assert.deepEqual([f.byClass("speed-confirm-cancel").tabIndex, f.byClass("speed-confirm-ok").tabIndex, f.info.tabIndex], [0, 0, 0], "Safari's Tab order reaches every speed button");
  ultra.events.click(); f.info.events.click(); await tick();
  assert.deepEqual([f.writes.length, f.note.hidden], [0, true], "nothing else confirms or opens while it asks");
  f.byClass("speed-confirm-ok").events.click(); await tick();
  assert.deepEqual([f.writes.length, f.writes[0].body.speed, f.writes[0].body.confirmCost, f.ask.hidden, f.panel.hidden], [1, "fast", true, true, true]);
  f.writes[0].resolve({ ...cap, requested: "fast" }); await f.ui.ready();
  ultra.events.click(); await tick();
  assert.equal(f.byClass("speed-confirm-title").options[1].textContent, "Turn on Ultra Fast?");
  f.ask.events.keydown({ key: "Escape", preventDefault() {}, stopPropagation() {} }); await f.ui.ready();
  assert.deepEqual([f.writes.length, f.ui.snapshot().speed, f.ask.hidden], [1, "fast", true], "Escape cancels without a save");
  ultra.events.click(); await tick();
  f.setTarget({ key: "codex:b:model", agentId: "codex", sessionId: "b", model: "model" });
  const other = f.ui.refresh(); await tick();
  assert.equal(f.ask.hidden, true, "a confirmation belongs to the conversation it was asked in");
  f.reads[1].resolve(cap); await other; await f.ui.ready();
  assert.equal(f.writes.length, 1, "the closed confirmation authorized nothing");
});
