"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { mount, elapsed } = require("../public/modules/subagent-panel");
const i18n = require("../public/modules/subagent-i18n");
const flush = () => new Promise(resolve => setImmediate(resolve));

function dom() {
  const document = { activeElement: null, listeners: {}, addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }, removeEventListener(type, fn) { this.listeners[type] = (this.listeners[type] || []).filter(item => item !== fn); } };
  class Element {
    constructor(tag) { this.tagName = tag; this.children = []; this.dataset = {}; this.attrs = {}; this.hidden = false; this._text = ""; this.className = ""; this.listeners = {}; }
    set textContent(value) { this._text = String(value); this.children = []; }
    get textContent() { return this._text + this.children.map(child => child.textContent).join(""); }
    append(...nodes) { for (const node of nodes) { if (typeof node === "string") { const text = new Element("#text"); text._text = node; node = text; } node.parentElement = this; this.children.push(node); } }
    replaceChildren(...nodes) { this.children = []; this.append(...nodes); }
    setAttribute(key, value) { this.attrs[key] = String(value); }
    getAttribute(key) { return this.attrs[key] ?? null; }
    removeAttribute(key) { delete this.attrs[key]; }
    addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
    all() { return this.children.flatMap(node => [node, ...node.all()]); }
    querySelectorAll(selector) { const cls = selector.slice(1); return this.all().filter(node => String(node.className).split(" ").includes(cls)); }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
    contains(node) { return this === node || this.all().includes(node); }
    focus() { document.activeElement = this; }
    click() { for (const fn of this.listeners.click || []) fn({ preventDefault() {}, stopPropagation() {} }); }
  }
  document.createElement = tag => new Element(tag);
  document.body = new Element("body");
  return document;
}
const row = (id, fields = {}) => ({ id, parentId: null, name: "scout", task: "Map the auth flow", prompt: "Map the auth flow\nin detail", status: "running", activity: "read src/auth.js",
  log: [{ kind: "tool", name: "grep", summary: "login", done: true }, { kind: "text", text: "Looking at auth" }], result: "", model: "", tokens: null, background: false, source: "pi", startedAt: 1000, endedAt: null, ...fields });
function setup(options = {}) {
  const document = dom(), host = document.createElement("div"); document.body.append(host);
  let clock = 61000;
  const panel = mount({ document, container: host, t: (key, vars) => i18n.t(key, vars, "en"), now: () => clock, ...options });
  return { document, host, panel, tick: ms => { clock += ms; } };
}

test("the bubble counts working subagents, then finished and failed ones, and hides with none", () => {
  const { host, panel } = setup();
  panel.render([]); assert.equal(host.querySelector(".subagent-bubble").hidden, true);
  panel.render([row("a"), row("b", { status: "pending" })]);
  const bubble = host.querySelector(".subagent-bubble");
  assert.equal(bubble.hidden, false); assert.equal(bubble.dataset.state, "running"); assert.equal(bubble.textContent, "2 subagents working");
  panel.render([row("a", { status: "completed", endedAt: 5000 })]); assert.equal(bubble.textContent, "1 subagent finished"); assert.equal(bubble.dataset.state, "done");
  panel.render([row("a", { status: "completed" }), row("b", { status: "failed" })]); assert.equal(bubble.textContent, "2 subagents finished · 1 failed");
  assert.equal(bubble.getAttribute("aria-expanded"), "false");
});

test("the list shows each subagent's name, task, state, time and activity, nested under its parent", () => {
  const { host, panel } = setup();
  panel.render([row("a"), row("b", { parentId: "a", name: "tester", task: "Check tests", status: "completed", startedAt: 2000, endedAt: 32000, activity: "" })]);
  host.querySelector(".subagent-bubble").click();
  const list = host.querySelector(".subagent-list");
  assert.equal(list.hidden, false); assert.equal(host.querySelector(".subagent-bubble").getAttribute("aria-expanded"), "true");
  const items = list.querySelectorAll(".subagent-item");
  assert.equal(items.length, 2);
  assert.match(items[0].textContent, /scout/); assert.match(items[0].textContent, /Map the auth flow/); assert.match(items[0].textContent, /Working/); assert.match(items[0].textContent, /01:00/); assert.match(items[0].textContent, /read src\/auth\.js/);
  assert.equal(items[1].dataset.depth, "1"); assert.match(items[1].textContent, /Done/); assert.match(items[1].textContent, /00:30/);
});

test("opening a subagent shows its full task, activity and result; Escape closes and focus returns", async () => {
  const { document, host, panel } = setup();
  panel.render([row("a", { status: "completed", result: "Auth flow mapped.", endedAt: 9000 })]);
  host.querySelector(".subagent-bubble").click();
  const item = host.querySelector(".subagent-item"); item.focus(); item.click(); await flush();
  const drawer = document.body.querySelector(".subagent-drawer");
  assert.equal(drawer.hidden, false); assert.equal(drawer.getAttribute("role"), "dialog");
  assert.match(drawer.textContent, /Map the auth flow\nin detail/); assert.match(drawer.textContent, /grep/); assert.match(drawer.textContent, /Looking at auth/); assert.match(drawer.textContent, /Auth flow mapped\./);
  for (const fn of document.listeners.keydown || []) fn({ key: "Escape", preventDefault() {} });
  assert.equal(drawer.hidden, true); assert.equal(document.activeElement, item);
});

test("an open detail follows live updates, and loads details the agent keeps elsewhere", async () => {
  const requests = [];
  const { document, host, panel } = setup({ loadDetail: async value => { requests.push(value.id); return { log: [{ kind: "text", text: "Child finished the README check." }] }; } });
  panel.render([row("t1", { source: "codex", log: [], name: "Subagent 1" })]);
  panel.open("t1"); await flush();
  const drawer = document.body.querySelector(".subagent-drawer");
  assert.deepEqual(requests, ["t1"]); assert.match(drawer.textContent, /Child finished the README check\./);
  panel.render([row("t1", { source: "codex", log: [], name: "Subagent 1", status: "completed", result: "Done here" })]); await flush();
  assert.match(drawer.textContent, /Done here/); assert.match(drawer.textContent, /Done/);
});

test("a failed detail load says so instead of showing an empty subagent", async () => {
  const { document, panel } = setup({ loadDetail: async () => { throw new Error("offline"); } });
  panel.render([row("t1", { source: "codex", log: [] })]); panel.open("t1"); await flush();
  assert.match(document.body.querySelector(".subagent-drawer").textContent, /could not be loaded/);
});

test("background runs and unanswerable approvals are labelled", async () => {
  const { document, host, panel } = setup();
  panel.render([row("bg", { background: true, approvalUnavailable: true })]);
  host.querySelector(".subagent-bubble").click();
  assert.match(host.querySelector(".subagent-item").textContent, /Background/);
  panel.open("bg"); await flush();
  assert.match(document.body.querySelector(".subagent-drawer").textContent, /cannot answer/);
});

test("elapsed time uses the reported duration, then start and end", () => {
  assert.equal(elapsed({ durationMs: 4000 }, 0), "00:04");
  assert.equal(elapsed({ startedAt: 0, endedAt: 3_725_000 }, 0), "1:02:05");
  assert.equal(elapsed({ startedAt: 1000, endedAt: null }, 11000), "00:10");
});

test("subagent chrome is complete in all 11 locales with matching placeholders", () => {
  const keys = Object.keys(i18n.tables.en);
  assert.equal(i18n.locales.length, 11);
  for (const locale of i18n.locales) {
    assert.deepEqual(Object.keys(i18n.tables[locale]), keys);
    for (const key of keys) assert.deepEqual([...i18n.tables[locale][key].matchAll(/\{(\w+)\}/g)].map(m => m[1]).sort(), [...i18n.tables.en[key].matchAll(/\{(\w+)\}/g)].map(m => m[1]).sort(), locale + ":" + key);
  }
  assert.equal(i18n.t("runningMany", { count: 3 }, "zh-Hant"), "3 個 subagent 執行中");
});

test("the Host's word that a subagent's approval could not be answered is shown", async () => {
  const { document, panel } = setup({ loadDetail: async () => ({ log: [], approvalUnavailable: true }) });
  panel.render([row("t1", { source: "codex", log: [] })]); panel.open("t1"); await flush();
  assert.match(document.body.querySelector(".subagent-drawer").textContent, /cannot answer/);
});

test("a transcript card opens an earlier turn's subagent, or a choice when it started several", async () => {
  const { document, panel } = setup();
  panel.render([]);
  panel.show([row("old", { status: "completed", result: "Earlier result" })]);
  const drawer = document.body.querySelector(".subagent-drawer");
  assert.equal(drawer.hidden, false); assert.match(drawer.textContent, /Earlier result/);
  panel.close();
  panel.show([row("p:0", { name: "scout" }), row("p:1", { name: "reviewer" })]);
  const items = drawer.querySelectorAll(".subagent-item");
  assert.equal(items.length, 2); assert.match(drawer.textContent, /Subagents/);
  items[1].click(); await flush();
  assert.match(drawer.textContent, /reviewer/); assert.equal(drawer.querySelectorAll(".subagent-item").length, 0);
});

test("a subagent from a saved conversation shows no invented time and says where it came from", () => {
  assert.equal(elapsed({ status: "completed", startedAt: null, endedAt: null, durationMs: null }, 5000), "");
  assert.equal(elapsed({ status: "completed", startedAt: null, durationMs: 65000 }, 5000), "01:05");
  const { document, panel } = setup();
  panel.show([row("toolu_bg", { status: "started", background: true, history: true, startedAt: null, endedAt: null, activity: "", log: [], result: "" })]);
  const drawer = document.body.querySelector(".subagent-drawer");
  assert.equal(drawer.hidden, false); assert.match(drawer.textContent, /Started/); assert.match(drawer.textContent, /Background/);
  assert.match(drawer.textContent, /from the saved conversation/); assert.doesNotMatch(drawer.textContent, /00:00/);
});

test("each subagent shows its own harness, reported model and reasoning mode in the list and drawer", () => {
  const { document, host, panel } = setup();
  const values = [row("cc", { source: "claude", model: "reported-claude-model", reasoningEffort: "high" }),
    row("cx", { source: "codex", model: "reported-codex-model", reasoningEffort: "xhigh" }),
    row("pi", { source: "pi", model: "reported-pi-model", reasoningEffort: "off" }),
    row("unknown", { source: "history", model: "", parentId: "cc" })];
  panel.render(values); host.querySelector(".subagent-bubble").click();
  const items = host.querySelectorAll(".subagent-item");
  assert.deepEqual(items.map(item => item.querySelector(".subagent-execution-tool")?.textContent), ["Claude Code", "Codex", "Pi Agent", "Not provided"]);
  assert.deepEqual(items.map(item => item.querySelector(".subagent-execution-model")?.textContent), ["reported-claude-model", "reported-codex-model", "reported-pi-model", "Not provided"]);
  assert.deepEqual(items.map(item => item.querySelector(".subagent-execution-thinking")?.textContent), ["high", "xhigh", "off", "Not provided"]);
  panel.open("unknown");
  const drawer = document.body.querySelector(".subagent-drawer");
  assert.equal(drawer.querySelector(".subagent-execution-model").textContent, "Not provided", "never borrow its parent's model");
  assert.equal(drawer.querySelector(".subagent-execution-thinking").textContent, "Not provided");
  panel.show([row("saved", { source: "history", harness: "pi", model: "saved-child-model", reasoningEffort: "medium", history: true })]);
  assert.equal(drawer.querySelector(".subagent-execution-tool").textContent, "Pi Agent");
  assert.equal(drawer.querySelector(".subagent-execution-model").textContent, "saved-child-model");
  assert.equal(drawer.querySelector(".subagent-execution-thinking").textContent, "medium");
});

test("the owned child's detail supplies execution metadata without extra polling and updates the list", async () => {
  const requests = [];
  const { document, host, panel } = setup({ loadDetail: async value => {
    requests.push(value.id); return { log: [], harness: "codex", model: "actual-child-model", reasoningEffort: "low" };
  } });
  const child = row("child", { source: "codex", model: "", requestedModel: "requested-model", log: [] });
  panel.render([child]); host.querySelector(".subagent-bubble").click();
  const opener = host.querySelector(".subagent-item"); opener.focus(); opener.click(); await flush();
  const drawer = document.body.querySelector(".subagent-drawer");
  assert.equal(drawer.querySelector(".subagent-execution-model")?.textContent, "actual-child-model");
  assert.equal(drawer.querySelector(".subagent-execution-thinking")?.textContent, "low");
  assert.equal(host.querySelector(".subagent-execution-model").textContent, "actual-child-model");
  panel.render([child]); panel.render([child]); await flush();
  assert.deepEqual(requests, ["child"], "rendering does not add metadata requests");
  panel.close();
  assert.equal(document.activeElement, host.querySelector(".subagent-item"), "focus returns to the current list item after metadata refresh");
});

test("a Claude subagent's model and reasoning mode load from the Host once the list is shown", async () => {
  const requests = [];
  const { document, host, panel } = setup({ loadDetail: async value => { requests.push(value.id);
    return { log: [{ kind: "tool", name: "Grep", summary: "login", done: true }], harness: "claude-code", model: "claude-opus-5-5", reasoningEffort: "xhigh" }; } });
  panel.render([row("toolu_1", { source: "claude", log: [], background: true })]); await flush();
  assert.deepEqual(requests, [], "nothing loads while nothing is shown");
  host.querySelector(".subagent-bubble").click(); await flush();
  assert.deepEqual(requests, ["toolu_1"]);
  const item = host.querySelector(".subagent-item");
  assert.equal(item.querySelector(".subagent-execution-tool").textContent, "Claude Code");
  assert.equal(item.querySelector(".subagent-execution-model").textContent, "claude-opus-5-5");
  assert.equal(item.querySelector(".subagent-execution-thinking").textContent, "xhigh");
  panel.open("toolu_1"); await flush();
  const drawer = document.body.querySelector(".subagent-drawer");
  assert.match(drawer.textContent, /Grep/, "a background subagent's work comes from its transcript");
  assert.deepEqual(requests, ["toolu_1"], "opening it reuses what the list loaded");
});

test("a working subagent whose model is not known yet is asked again every few seconds, and once more when it ends", async () => {
  const requests = [];
  let answer = { log: [], harness: "claude-code", model: "", reasoningEffort: "" };
  const { host, panel, tick } = setup({ loadDetail: async value => { requests.push(value.id); return answer; } });
  const working = row("toolu_2", { source: "claude", log: [] });
  panel.render([working]); host.querySelector(".subagent-bubble").click(); await flush();
  assert.equal(requests.length, 1);
  tick(4999); panel.render([working]); await flush();
  assert.equal(requests.length, 1);
  answer = { ...answer, model: "claude-sonnet-5-5", reasoningEffort: "high" };
  tick(1); panel.render([working]); await flush();
  assert.equal(requests.length, 2);
  assert.equal(host.querySelector(".subagent-execution-model").textContent, "claude-sonnet-5-5");
  tick(60000); panel.render([working]); await flush();
  assert.equal(requests.length, 2, "a known model is not asked for again while the list is shown");
  const done = { ...working, status: "completed" };
  panel.render([done]); await flush();
  assert.equal(requests.length, 3);
  tick(60000); panel.render([done]); await flush();
  assert.equal(requests.length, 3);
});

test("an open working subagent's activity is refreshed while it works", async () => {
  const requests = [];
  const { document, panel, tick } = setup({ loadDetail: async value => { requests.push(value.id);
    return { log: [{ kind: "text", text: `step ${requests.length}` }], harness: "claude-code", model: "claude-opus-5-5", reasoningEffort: "max" }; } });
  const working = row("toolu_3", { source: "claude", log: [] });
  panel.render([working]); panel.open("toolu_3"); await flush();
  const drawer = document.body.querySelector(".subagent-drawer");
  assert.match(drawer.textContent, /step 1/);
  tick(5000); panel.render([working]); await flush();
  assert.match(drawer.textContent, /step 2/);
  panel.close(); tick(5000); panel.render([working]); await flush();
  assert.equal(requests.length, 2, "a closed one is not refreshed");
});

test("the list loads at most three subagents' details at a time", async () => {
  const requests = [], pending = [];
  const { host, panel } = setup({ loadDetail: value => { requests.push(value.id); return new Promise(resolve => pending.push(() => resolve({ log: [], model: `model-${value.id}` }))); } });
  panel.render(["a", "b", "c", "d", "e"].map(id => row(id, { source: "codex", log: [], status: "completed" })));
  host.querySelector(".subagent-bubble").click(); await flush();
  assert.deepEqual(requests, ["a", "b", "c"]);
  pending.shift()(); await flush(); await flush();
  assert.deepEqual(requests, ["a", "b", "c", "d"]);
  while (pending.length) { pending.shift()(); await flush(); await flush(); }
  assert.deepEqual(requests, ["a", "b", "c", "d", "e"]);
  assert.deepEqual(host.querySelectorAll(".subagent-execution-model").map(node => node.textContent), ["model-a", "model-b", "model-c", "model-d", "model-e"]);
});

test("a saved Claude conversation's subagent loads its details, and a model the stream reported is kept until the Host has one", async () => {
  const requests = [];
  const { document, panel } = setup({ loadDetail: async value => { requests.push(value.id); return { log: [], harness: "claude-code", model: value.id === "toolu_saved" ? "claude-opus-5-5" : "", reasoningEffort: value.id === "toolu_saved" ? "high" : "" }; } });
  panel.show([row("toolu_saved", { source: "history", harness: "claude-code", history: true, status: "completed", log: [], startedAt: null })]); await flush();
  const drawer = document.body.querySelector(".subagent-drawer");
  assert.deepEqual(requests, ["toolu_saved"]);
  assert.equal(drawer.querySelector(".subagent-execution-model").textContent, "claude-opus-5-5");
  assert.equal(drawer.querySelector(".subagent-execution-thinking").textContent, "high");
  panel.show([row("pi_saved", { source: "history", harness: "pi", history: true, status: "completed", log: [] })]); await flush();
  assert.deepEqual(requests, ["toolu_saved"], "other saved subagents keep what their record says");
  panel.render([row("toolu_live", { source: "claude", model: "stream-model", log: [] })]); panel.open("toolu_live"); await flush();
  assert.equal(drawer.querySelector(".subagent-execution-model").textContent, "stream-model");
});
