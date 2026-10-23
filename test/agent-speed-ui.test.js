"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { create } = require("../public/modules/agent-speed");
function fixture(t, { confirm = async () => true } = {}) {
  const old = global.document;
  const element = () => ({ options: [], textContent: "", value: "", disabled: false, hidden: true, events: {},
    append(...nodes) { this.options.push(...nodes); }, setAttribute(k, v) { this[k] = v; },
    toggleAttribute(k, value) { this[k] = value; }, getAttribute(k) { return this[k]; },
    addEventListener(k, fn) { this.events[k] = fn; } });
  global.document = { createElement: element }; t.after(() => { global.document = old; });
  const root = element(), indicator = element(), button = element(), description = element(), reads = [], writes = [], errors = [];
  let target = { key: "codex:a:model", agentId: "codex", sessionId: "a", model: "model" };
  const ui = create({ root, indicator, button, description, context: () => target, confirm, onError: e => errors.push(e),
    get: () => new Promise((resolve, reject) => reads.push({ resolve, reject })),
    post: (_url, body) => new Promise(resolve => writes.push({ body, resolve })) });
  return { ui, select: root.options[1], note: root.options[2], description, indicator, reads, writes, errors, setTarget: value => { target = value; } };
}
const supported = { support: "supported", requested: "standard", effective: "unknown", revision: "r1", fingerprint: "verified" };
const tick = () => new Promise(resolve => setImmediate(resolve));
test("agent-speed UI: supported Magpie keeps the forwarding warning without an unverified-route denial", async t => {
  const f = fixture(t); const read = f.ui.refresh();
  f.reads[0].resolve({ ...supported, route: "magpie", reason: "speed_gateway_requested" }); await read;
  assert.equal(f.select.disabled, false);
  assert.match(f.note.textContent, /global overrides or fallback/);
  assert.doesNotMatch(f.note.textContent, /contract is unverified/);
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
  assert.equal(f.select.options[1].disabled, true); assert.equal(f.select.disabled, false, "Standard recovery stays available");
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
