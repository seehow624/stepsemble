"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const source = fs.readFileSync(require.resolve("../public/app.js"), "utf8");
const extract = (start, end) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));

class Node {
  constructor(fragment = false) { this.fragment = fragment; this.children = []; this.parentNode = null; this.dataset = {}; this.scrollTop = 0; this.disabled = false; this.textContent = ""; this.classList = { add() {}, remove() {} }; }
  get firstChild() { return this.children[0] || null; }
  get scrollHeight() { return this.children.length * 20; }
  set innerHTML(_) { this.children = []; }
  appendChild(node) { if (node.fragment) { while (node.firstChild) this.appendChild(node.firstChild); return node; } node.remove(); node.parentNode = this; this.children.push(node); return node; }
  prepend(node) { if (node.fragment) { for (const child of [...node.children].reverse()) this.prepend(child); return; } node.remove(); node.parentNode = this; this.children.unshift(node); }
  remove() { if (this.parentNode) this.parentNode.children.splice(this.parentNode.children.indexOf(this), 1); this.parentNode = null; }
  addEventListener(type, fn) { this.handlers ||= new Map(); if (!this.handlers.has(type)) this.handlers.set(type, []); this.handlers.get(type).push(fn); }
  dispatch(type, event) { for (const fn of this.handlers?.get(type) || []) fn(event); }
  click() { if (!this.disabled) this.dispatch("click", { type: "click", target: this }); }
  querySelector(selector) { return selector === ".history-load-button" ? this.children.find(node => node.className === "history-load-button") || null : null; }
  setAttribute() {}
  getBoundingClientRect() { const top = this.parentNode ? this.parentNode.children.indexOf(this) * 20 - this.parentNode.scrollTop : 0; return { top, bottom: top + (this.parentNode ? 20 : 200) }; }
}
const text = id => ({ id: String(id), role: "assistant", text: `answer ${id}` });
const tools = prefix => Array.from({ length: 300 }, (_, n) => ({ id: `${prefix}-${n}`, role: "toolResult", text: "owned tool output" }));
function piHarness(pages, { integratedIntent = false } = {}) {
  const messages = new Node(), listeners = new Map(), calls = [], notices = [], frames = [];
  const document = { activeElement: null, body: new Node(), documentElement: new Node(), createElement: () => new Node(), createDocumentFragment: () => new Node(true),
    addEventListener(type, fn) { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type).add(fn); },
    removeEventListener(type, fn) { listeners.get(type)?.delete(fn); } };
  document.activeElement = document.body;
  const ctx = vm.createContext({ document, window: { addEventListener: document.addEventListener, removeEventListener: document.removeEventListener },
    performance: { now: () => 0 }, Date, setTimeout, viewGeneration: 0, apiBase: "/owned", rpc: null, activeDraftKey: "owned", userScrollIntentUntil: 0,
    el: { messages, input: { value: "untouched draft" }, viewList: new Node(), viewChat: new Node() },
    historyState: null, historyLoadButton: null, currentSessionCwd: null,
    api: async url => { calls.push(url); return pages(url, calls.length, ctx); },
    appendHistoryMessage(m, container) { const node = new Node(); node.record = m; container.appendChild(node); },
    async connectRpc() { ctx.rpc = { lastEventId: 1, streaming: false }; },
    toast: msg => notices.push(msg), tKey: (key, vars) => key + (vars?.detail || ""), console,
    sessionDisplayTitle: () => "owned", isDesktop: () => true,
    scrollBottom: () => { messages.scrollTop = messages.scrollHeight; },
  });
  for (const name of ["beginDraftScope", "closeChat", "resetTaskProgress", "resetProjectChanges", "resetComposerSummary", "clearLastAgentTask", "rememberLastChat", "updateSessionSelection", "hideChatEmpty", "setChatTitle", "setChatAgent", "setChatPlace", "resetLiveUsage", "resetSessionUsage", "ensureSessionUsageFooter", "refreshProjectChanges", "maybeDateSeparator", "mergeAdjacentWorkMessages", "keepSessionUsageAtEnd", "layoutWorkLog", "updateScrollBottomButton"]) ctx[name] = () => {};
  // Includes the real Pi paging controller; never imports the live app.
  vm.runInContext(extract("function readableHistoryPolicy(", "// Admission bounds include"), ctx);
  vm.runInContext(extract("function removeHistoryLoadButton(", "async function startNew("), ctx);
  vm.runInContext(extract("async function openExisting(", "let currentSessionCwd = null"), ctx);
  if (integratedIntent) {
    ctx.requestAnimationFrame = fn => { frames.push(fn); return frames.length; };
    messages.clientHeight = 200;
    vm.runInContext(extract("let jumpToLatestUntil = 0;", 'el.scrollBottomBtn?.addEventListener'), ctx);
  }
  return { ctx, calls, messages, notices, listeners, input(type) { for (const fn of listeners.get(type) || []) fn({ type, target: document.body }); },
    dispatch(type, extra = {}) { const event = { type, target: messages, ...extra }; for (const fn of listeners.get(type) || []) fn(event); messages.dispatch(type, event); },
    flushFrames() { const ready = frames.splice(0); for (const fn of ready) fn(); },
    intent() { return vm.runInContext("userScrollIntentUntil", ctx); } };
}
const detail = (messages, nextBefore, hasMore = nextBefore > 0) => ({ cwd: "/owned/project", messages, nextBefore, hasMore });

test("Pi actual initial tool-heavy window seeks 40 readable records beyond raw300", async () => {
  const h = piHarness((url, n) => n === 1 ? detail(tools("latest"), 300) : detail(Array.from({ length: 40 }, (_, i) => text(i)), 0));
  await h.ctx.openExisting({ file: "owned.jsonl", cwd: "/owned/project" });
  assert.equal(h.messages.children.filter(node => node.record?.role === "assistant").length, 40);
  assert.equal(h.calls.length, 2);
  assert.equal(h.ctx.el.input.value, "untouched draft");
});

test("Codex actual continuation seeks 40 NEW readable units rather than8", async () => {
  let reads = 0;
  const state = { error: null, itemsCursor: "c1", entries: Array.from({ length: 8 }, (_, i) => `first-${i}`) };
  const ctx = vm.createContext({ Date, codexNativeReadableKeys: s => new Set(s.entries),
    loadCodexNativeTranscript: async () => { reads++; return { items: { data: Array.from({ length: 8 }, (_, i) => `page-${reads}-${i}`) } }; },
    applyCodexNativeTranscriptPage(s, page) { s.entries.push(...page.items.data); s.itemsCursor = `c${reads + 1}`; }, renderCodexNativeSnapshot() {} });
  vm.runInContext(extract("function readableHistoryPolicy(", "// Admission bounds include"), ctx);
  vm.runInContext(extract("async function continueCodexNativeReadableHistory(", "async function loadCodexNativeTranscript("), ctx);
  await ctx.continueCodexNativeReadableHistory({ nativeThreadId: "owned", nativeTranscriptState: state }, { items: {} }, new Set(), Date.now(), { signal: { aborted: false }, isCurrent: () => true });
  assert.equal(state.entries.length, 40);
  assert.equal(reads, 4);
});

test("Pi initial plain/images count, blank/tool/omitted records do not, and adequate first pages do not prefetch", async () => {
  const h = piHarness(() => detail(Array.from({ length: 40 }, (_, i) => i % 2 ? text(i) : { id: String(i), role: "user", images: 1 }), 300));
  await h.ctx.openExisting({ file: "owned.jsonl" });
  assert.equal(h.calls.length, 1);
  assert.equal(h.ctx.piHistoryReadableCount([{ role: "assistant", text: "hidden", historyContextOmitted: true }, { role: "assistant", text: " " }, { role: "toolResult", text: "not prose" }, { role: "system", text: "metadata" }]), 0);
  assert.equal(h.ctx.piHistoryReadableCount([{ role: "user", imageAttachments: [{}] }, { role: "assistant", text: "kept", historyContextOmitted: true, stopReason: "aborted" }]), 2);
});

test("Pi manual action adds40 NEW units, consumes intent, and preserves current reader anchor/draft", async () => {
  const h = piHarness((url, n) => n === 1 ? detail(Array.from({ length: 40 }, (_, i) => text(`latest-${i}`)), 900)
    : n === 2 ? detail(tools("older"), 600) : detail(Array.from({ length: 40 }, (_, i) => text(`earlier-${i}`)), 300));
  await h.ctx.openExisting({ file: "owned.jsonl" });
  h.messages.scrollTop = 50;
  const anchor = h.messages.children[5], offset = anchor.getBoundingClientRect().top;
  h.ctx.userScrollIntentUntil = Date.now() + 800;
  await h.ctx.loadOlderHistory(h.ctx.historyLoadButton);
  assert.equal(h.calls.length, 3);
  assert.equal(h.ctx.piHistoryReadableCount(h.messages.children.map(node => node.record).filter(Boolean)), 80);
  assert.equal(h.ctx.historyState.before, 300);
  assert.equal(h.ctx.historyState.hasMore, true);
  assert.equal(h.ctx.userScrollIntentUntil, 0);
  assert.equal(anchor.getBoundingClientRect().top, offset);
  assert.equal(h.ctx.el.input.value, "untouched draft");
  assert.equal([...h.listeners.values()].reduce((n, set) => n + set.size, 0), 0);
});

test("Pi page/UTF16/time admission retains entire last page and real earlier control", async () => {
  for (const bound of ["pages", "bytes", "time"]) {
    let now = 0;
    const h = piHarness((url, n) => {
      const messages = tools(`p${n}`);
      if (bound === "bytes") messages[0].text = "x".repeat(1048576);
      if (bound === "time") now = 1300;
      return detail(messages, 3000 - 300 * n);
    });
    h.ctx.Date = { now: () => now };
    await h.ctx.openExisting({ file: "owned.jsonl" });
    assert.equal(h.calls.length, bound === "pages" ? 8 : 1);
    assert.equal(h.messages.children.filter(node => node.record).length, h.calls.length * 300);
    assert.equal(h.ctx.historyState.hasMore, true);
    assert.equal(h.ctx.historyLoadButton.disabled, false);
    assert.equal(h.ctx.historyState.error, bound === "pages" ? null : undefined);
  }
});

test("Pi EOF and metadata-only pages stop honestly without endless continuation", async () => {
  const h = piHarness((url, n) => n === 1 ? detail([{ id: "meta", role: "system", text: "not readable" }], 1) : detail([], 0));
  await h.ctx.openExisting({ file: "owned.jsonl" });
  assert.equal(h.calls.length, 2);
  assert.equal(h.ctx.historyState.hasMore, false);
  assert.equal(h.ctx.historyLoadButton, null);
  await h.ctx.loadOlderHistory(null);
  assert.equal(h.calls.length, 2);
});

test("Pi partial failures/malformed/repeated cursors/overlap retain last successful boundary for manual retry", async () => {
  for (const failure of ["offline", "malformed", "cursor", "overlap"]) {
    let retry = false;
    const h = piHarness((url, n) => {
      if (n === 1) return detail(tools("p1"), 900);
      if (n === 2) return detail(tools("p2"), 600);
      if (retry) { assert.match(url, /before=600$/); return detail([text("earliest")], 0); }
      if (failure === "offline") throw new Error("offline");
      if (failure === "malformed") return { messages: null };
      if (failure === "cursor") return detail([text("bad")], 900);
      return detail([text("p1-0")], 300);
    });
    await h.ctx.openExisting({ file: "owned.jsonl" });
    assert.equal(h.calls.length, 3);
    assert.equal(h.ctx.historyState.before, 600);
    assert.equal(h.ctx.historyState.hasMore, true);
    assert.equal(h.messages.children.filter(node => node.record).length, 600);
    assert.equal(h.ctx.historyLoadButton.dataset.autoLoadPaused, "1");
    assert.equal(h.notices.length, 1);
    retry = true; await h.ctx.loadOlderHistory(h.ctx.historyLoadButton);
    assert.equal(h.calls.length, 4);
    assert.equal(h.ctx.historyState.hasMore, false);
    assert.equal(h.ctx.historyState.error, null);
  }
});

test("Pi late page ownership rejects stale generation/base/RPC/live/draft/initial user interaction", async () => {
  for (const change of ["view", "base", "rpc", "live", "event", "draft", "key", "interaction"]) {
    let release;
    const waiting = new Promise(resolve => { release = resolve; });
    const h = piHarness((url, n) => n === 1 ? detail(tools("first"), 600) : waiting);
    const request = h.ctx.openExisting({ file: "owned.jsonl" });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(h.calls.length, 2);
    assert.ok(h.ctx.rpc, "RPC attaches before older backfill resolves");
    if (change === "view") h.ctx.viewGeneration++;
    if (change === "base") h.ctx.apiBase = "/another";
    if (change === "rpc") h.ctx.rpc = {};
    if (change === "live") h.ctx.rpc.streaming = true;
    if (change === "event") h.ctx.rpc.lastEventId++;
    if (change === "draft") h.ctx.el.input.value = "new draft";
    if (change === "key") h.ctx.activeDraftKey = "another";
    if (change === "interaction") h.input("wheel");
    release(detail([text("late")], 300)); await request;
    assert.equal(h.messages.children.some(node => node.record?.id === "late"), false);
    assert.equal(h.ctx.historyState.before, 600);
    assert.equal(h.ctx.historyState.loading, false);
    assert.equal(h.notices.length, 0);
    assert.equal([...h.listeners.values()].reduce((n, set) => n + set.size, 0), 0);
  }
});

test("Pi manual single flight and scroll during request use the latest visible anchor", async () => {
  let release;
  const waiting = new Promise(resolve => { release = resolve; });
  const h = piHarness((url, n) => n === 1 ? detail(Array.from({ length: 40 }, (_, i) => text(i)), 300) : waiting);
  await h.ctx.openExisting({ file: "owned.jsonl" });
  const button = h.ctx.historyLoadButton;
  const request = h.ctx.loadOlderHistory(button);
  await h.ctx.loadOlderHistory(button);
  h.messages.scrollTop = 160;
  const anchor = h.messages.children[10], before = anchor.getBoundingClientRect().top;
  h.input("wheel"); // A manual action keeps working; it must not reset this scroll.
  release(detail([text("older")], 0)); await request;
  assert.equal(h.calls.length, 2);
  assert.equal(anchor.getBoundingClientRect().top, before);
});

test("Pi admitted batch consumes renewed real shared intent before its prepend RAF can load again", async () => {
  for (const flushWhileHeld of [false, true]) {
    let release;
    const waiting = new Promise(resolve => { release = resolve; });
    const h = piHarness((url, n) => n === 1 ? detail(Array.from({ length: 40 }, (_, i) => text(`latest-${i}`)), 900)
      : n === 2 ? waiting : detail(Array.from({ length: 40 }, (_, i) => text(`fresh-${i}`)), 0), { integratedIntent: true });
    await h.ctx.openExisting({ file: "owned.jsonl" });
    h.messages.scrollTop = 0;
    const anchor = h.messages.children[5], offset = anchor.getBoundingClientRect().top;
    const request = h.ctx.loadOlderHistory(h.ctx.historyLoadButton);
    assert.equal(h.calls.length, 2);
    assert.equal(h.ctx.historyState.loading, true);
    h.dispatch("wheel", { deltaY: -30, deltaX: 0 });
    h.dispatch("scroll");
    if (flushWhileHeld) h.flushFrames();
    release(detail([{ id: "typed-tool", role: "toolResult", text: "owned command output\n" + "x".repeat(1048576) },
      ...Array.from({ length: 8 }, (_, i) => text(`older-${i}`))], 600));
    await request;
    assert.equal(h.ctx.historyState.hasMore, true);
    assert.equal(h.ctx.historyState.loading, false);
    assert.ok(h.messages.scrollTop <= 600, "native compensated position still reaches the common earlier listener");
    assert.equal(anchor.getBoundingClientRect().top, offset, "reader anchor survives the admitted batch");
    h.dispatch("scroll");
    h.flushFrames();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(h.calls.length, 2, "held-page wheel plus own prepend cannot admit a second intent batch");
    assert.equal(h.ctx.historyState.before, 600);
    assert.equal(h.ctx.el.input.value, "untouched draft");
    assert.equal(h.intent(), 0);
    assert.equal([...h.listeners.values()].reduce((n, set) => n + set.size, 0), 0);
    h.dispatch("wheel", { deltaY: -30, deltaX: 0 }); h.dispatch("scroll"); h.flushFrames();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(h.calls.length, 3, "a fresh deliberate approach still admits the next batch");
    assert.equal(h.ctx.historyState.hasMore, false);
  }
});

test("Pi stale batch cleanup does not consume a different RPC view's shared intent", async () => {
  let release;
  const h = piHarness((url, n) => n === 1 ? detail(Array.from({ length: 40 }, (_, i) => text(i)), 300)
    : new Promise(resolve => { release = resolve; }), { integratedIntent: true });
  await h.ctx.openExisting({ file: "owned.jsonl" });
  const request = h.ctx.loadOlderHistory(h.ctx.historyLoadButton);
  h.ctx.rpc = { lastEventId: 2 };
  h.dispatch("wheel", { deltaY: -30, deltaX: 0 }); const intent = h.intent();
  release(detail([text("late")], 0)); await request;
  assert.equal(h.intent(), intent);
  assert.equal(h.messages.children.some(node => node.record?.id === "late"), false);
});

test("Pi historical shells never inherit live entry motion that shifts the reader anchor", () => {
  const shells = [], messages = new Node();
  const ctx = vm.createContext({ el: { messages }, taskProgress: null,
    makeMsgShell() { const classes = new Set(["msg", "msg-in"]), wrap = new Node(), bubble = new Node();
      wrap.classList = { remove: name => classes.delete(name), contains: name => classes.has(name) };
      shells.push(wrap); return { wrap, bubble }; },
    stampMessageTime() {}, renderMarkdown: () => new Node(), appendImageGallery() {}, updateTaskProgressFromAssistant() {},
    isFailureMessage: () => false, msgActionsRow: () => new Node(), piReplyFork: () => null,
    keepSessionUsageAtEnd() {}, scrollBottom() {} });
  vm.runInContext(extract("function appendHistoryMessage(", "function usageTag("), ctx);
  for (const role of ["user", "assistant"]) ctx.appendHistoryMessage({ role, text: "owned history" }, new Node(), { latest: true });
  assert.equal(shells.length, 2);
  for (const shell of shells) assert.equal(shell.classList.contains("msg-in"), false, "past conversation is spatially stable, not entering live");
  assert.match(extract("function makeMsgShell(", "const SAFE_IMAGE_DATA_URL"), /wrap\.className = "msg " \+ role \+ " msg-in";/,
    "the common shell still animates genuine live messages; only historical projection removes it");
});

test("Pi first page changing hosts cannot attach an old file on the new host", async () => {
  let release;
  const h = piHarness(() => new Promise(resolve => { release = resolve; }));
  const request = h.ctx.openExisting({ file: "owned.jsonl" });
  h.ctx.apiBase = "/another";
  release(detail([text("late")], 0)); await request;
  assert.equal(h.ctx.rpc, null);
  assert.equal(h.messages.children.length, 0);
});
