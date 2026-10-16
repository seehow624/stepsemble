"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { create } = require("../public/modules/session-reference");
const i18n = require("../public/modules/session-reference-i18n");
const ENTRY = "00000000-0000-4000-8000-0000000000e1", A = "00000000-0000-4000-8000-0000000000a1", B = "00000000-0000-4000-8000-0000000000b2";
const flush = () => new Promise(resolve => setImmediate(resolve));

function dom() {
  const document = { activeElement: null };
  class Element {
    constructor(tag) { this.tagName = tag; this.children = []; this.dataset = {}; this.attrs = {}; this.hidden = false; this._text = ""; this.className = ""; this.listeners = {}; this.value = ""; this.open = false; }
    set textContent(value) { this._text = String(value); this.children = []; }
    get textContent() { return this._text + this.children.map(child => child.textContent).join(""); }
    append(...nodes) { for (const node of nodes) { node.parentElement = this; this.children.push(node); } }
    replaceChildren(...nodes) { this.children = []; this.append(...nodes); }
    setAttribute(key, value) { this.attrs[key] = String(value); }
    getAttribute(key) { return this.attrs[key] ?? null; }
    addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
    all() { return this.children.flatMap(node => [node, ...node.all()]); }
    querySelectorAll(selector) { const cls = selector.slice(1); return this.all().filter(node => String(node.className).split(" ").includes(cls)); }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
    focus() { document.activeElement = this; }
    click() { for (const fn of this.listeners.click || []) fn({ preventDefault() {} }); }
    showModal() { this.open = true; } close() { this.open = false; }
    remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(node => node !== this); }
  }
  document.createElement = tag => new Element(tag);
  document.body = new Element("body");
  return document;
}
function setup({ server } = {}) {
  const document = dom(), container = document.createElement("div"); document.body.append(container);
  const calls = [], timers = []; let context = { context: "host-1:1", entry: ENTRY, host: "host-1" };
  const jobs = new Map(); let next = 0;
  const handler = server || (async (path, body) => {
    if (path === "/api/handoff/summary" && body) { const id = "job-" + (++next); jobs.set(id, { id, status: "running", progress: { done: 0, total: 2 }, summary: "", agentId: "claude-code", coveredTurns: 4, sourceCwd: "/owned/app" }); return jobs.get(id); }
    if (path.startsWith("/api/handoff/summary?id=")) return jobs.get(decodeURIComponent(path.split("=")[1]));
    throw new Error("unexpected " + path);
  });
  const controller = create({ document, container, request: async (path, body) => { calls.push([path, body]); return handler(path, body, jobs); },
    getContext: () => context, t: (key, vars) => i18n.t(key, vars, "en"), schedule: fn => { timers.push(fn); return timers.length; }, cancel() {} });
  return { document, container, controller, calls, jobs, timers, tick: async () => { const fn = timers.shift(); if (fn) await fn(); await flush(); }, setContext: value => { context = { ...context, ...value }; } };
}
const session = (key = A, fields = {}) => ({ key, host: "host-1", title: "Fix login", agentId: "pi", ...fields });

test("dropping a session adds a chip and starts its summary at once", async () => {
  const f = setup();
  assert.deepEqual(f.controller.add(session()), { added: true });
  await flush();
  assert.deepEqual(f.calls[0], ["/api/handoff/summary", { source: A, target: ENTRY }]);
  const chip = f.container.querySelector(".session-ref");
  assert.match(chip.textContent, /Fix login/); assert.match(chip.textContent, /Summarizing 0\/2/); assert.equal(chip.dataset.state, "running");
  assert.equal(f.controller.ready(), false); assert.equal(f.controller.count(), 1);
});

test("a chip follows its job to completion, then can be previewed and edited before sending", async () => {
  const f = setup(); f.controller.add(session()); await flush();
  Object.assign(f.jobs.get("job-1"), { status: "completed", progress: { done: 2, total: 2 }, summary: "Goal: fix the redirect." });
  await f.tick();
  const chip = f.container.querySelector(".session-ref");
  assert.equal(chip.dataset.state, "completed"); assert.equal(f.controller.ready(), true);
  chip.querySelector(".session-ref-preview").click();
  const dialog = f.document.body.querySelector(".session-ref-dialog");
  assert.equal(dialog.open, true); assert.match(dialog.textContent, /through turn 4/);
  const editor = dialog.querySelector(".session-ref-editor"); assert.equal(editor.value, "Goal: fix the redirect.");
  editor.value = "Goal: fix the redirect. Keep the tests."; dialog.querySelector(".session-ref-save").click();
  const message = f.controller.compose("Continue this work");
  assert.match(message, /^Continue this work\n\n---\nReference: session "Fix login" \(pi, \/owned\/app\), handoff summary through turn 4:\nGoal: fix the redirect\. Keep the tests\.$/);
});

test("limits, duplicates, itself and another Host are refused with a reason", async () => {
  const f = setup();
  assert.deepEqual(f.controller.add(session(ENTRY)), { added: false, reason: "self" });
  assert.deepEqual(f.controller.add(session(A, { host: "host-2" })), { added: false, reason: "otherHost" });
  f.controller.add(session(A)); assert.deepEqual(f.controller.add(session(A)), { added: false, reason: "duplicate" });
  f.controller.add(session(B)); f.controller.add(session("00000000-0000-4000-8000-0000000000c3"));
  assert.deepEqual(f.controller.add(session("00000000-0000-4000-8000-0000000000d4")), { added: false, reason: "limit" });
  assert.equal(f.controller.count(), 3);
});

test("a large record waits for the person's go-ahead, and a failure offers retry or the plain digest", async () => {
  const replies = [{ id: "j1", status: "needs_confirm", estimatedTokens: 420000, progress: { done: 0, total: 5 } }, { id: "j2", status: "running", progress: { done: 0, total: 5 } }];
  const f = setup({ server: async (path, body) => {
    if (path === "/api/handoff/summary" && body) return replies.shift() || { id: "j3", status: "failed", error: "Claude is not signed in", progress: { done: 0, total: 1 } };
    if (path.startsWith("/api/handoff/summary?id=")) return { id: "j2", status: "failed", error: "Claude is not signed in", progress: { done: 0, total: 5 } };
    if (path.startsWith("/api/handoff/digest?")) return { summary: "Requests by turn: 1. Fix login", plain: true, coveredTurns: 3 };
    throw new Error(path);
  } });
  f.controller.add(session()); await flush();
  let chip = f.container.querySelector(".session-ref");
  assert.equal(chip.dataset.state, "needs_confirm"); assert.match(chip.textContent, /420,000 tokens/);
  chip.querySelector(".session-ref-confirm").click(); await flush();
  assert.deepEqual(f.calls.at(-1), ["/api/handoff/summary", { source: A, target: ENTRY, confirm: true }]);
  await f.tick(); chip = f.container.querySelector(".session-ref");
  assert.equal(chip.dataset.state, "failed"); assert.match(chip.textContent, /not signed in/);
  chip.querySelector(".session-ref-plain").click(); await flush(); chip = f.container.querySelector(".session-ref");
  assert.equal(chip.dataset.state, "completed"); assert.equal(chip.dataset.plain, "true");
  assert.match(f.controller.compose(""), /plain digest through turn 3:\nRequests by turn/);
});

test("a failure the Host names by code reads as words, and the agent's own reason is kept", async () => {
  const replies = [{ id: "j1", status: "failed", error: "summarizer_timeout", progress: { done: 0, total: 1 } }, { id: "j2", status: "failed", error: "Claude is not signed in", progress: { done: 0, total: 1 } }];
  const f = setup({ server: async (path, body) => { if (path === "/api/handoff/summary" && body) return replies.shift(); throw new Error(path); } });
  f.controller.add(session()); await flush();
  assert.match(f.container.querySelector(".session-ref").textContent, new RegExp(i18n.t("summarizer_timeout", {}, "en").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  f.container.querySelector(".session-ref-retry").click(); await flush();
  assert.match(f.container.querySelector(".session-ref").textContent, /Claude is not signed in/);
});

test("sending waits for pending summaries; removing the chip or a failure releases the wait", async () => {
  const f = setup(); f.controller.add(session()); await flush();
  let resolved = null; const waiting = f.controller.whenReady().then(value => { resolved = value; });
  await flush(); assert.equal(resolved, null);
  Object.assign(f.jobs.get("job-1"), { status: "completed", summary: "Done." }); await f.tick(); await waiting;
  assert.equal(resolved, true);
  f.controller.add(session(B)); await flush();
  const second = f.controller.whenReady(); f.controller.remove(B); assert.equal(await second, true, "nothing left to wait for");
  f.controller.add(session(B)); await flush(); const third = f.controller.whenReady();
  // The removed chip's poll is still queued (cancel is a no-op here) and ends without effect.
  Object.assign(f.jobs.get("job-3"), { status: "failed", error: "boom" }); await f.tick(); await f.tick();
  assert.equal(await third, false, "a failure needs the person to act");
});

test("a reply from an earlier conversation never lands on the new one, and clear drops every chip", async () => {
  const f = setup(); f.controller.add(session()); await flush();
  f.setContext({ context: "host-1:2", entry: "00000000-0000-4000-8000-0000000000e9" });
  Object.assign(f.jobs.get("job-1"), { status: "completed", summary: "Old" }); await f.tick();
  assert.equal(f.controller.count(), 0, "a conversation switch drops the old chips");
  f.setContext({ context: "host-1:1", entry: ENTRY }); f.controller.add(session()); await flush(); f.controller.clear();
  assert.equal(f.controller.count(), 0); assert.equal(f.container.querySelectorAll(".session-ref").length, 0);
});

test("reference chrome is complete in all 11 locales with matching placeholders", () => {
  const keys = Object.keys(i18n.tables.en); assert.equal(i18n.locales.length, 11);
  for (const locale of i18n.locales) { assert.deepEqual(Object.keys(i18n.tables[locale]), keys);
    for (const key of keys) assert.deepEqual([...i18n.tables[locale][key].matchAll(/\{(\w+)\}/g)].map(m => m[1]).sort(), [...i18n.tables.en[key].matchAll(/\{(\w+)\}/g)].map(m => m[1]).sort(), locale + ":" + key); }
  assert.equal(i18n.reason("summarizer_unavailable", "zh-Hant"), i18n.t("summarizer_unavailable", {}, "zh-Hant"));
  assert.equal(i18n.reason("something_unknown", "en"), i18n.t("reference_failed", {}, "en"));
  assert.equal(i18n.reason("summarizer_not_installed", "en"), "The summarizer chosen in Settings is not installed on this Host.");
});
