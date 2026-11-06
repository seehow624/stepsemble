"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const source = fs.readFileSync(require.resolve("../public/app.js"), "utf8");
const extract = (start, end) => {
  const from = source.indexOf(start), to = source.indexOf(end, from);
  assert.ok(from >= 0 && to > from, `nonempty source bounds: ${start} → ${end}`);
  return source.slice(from, to);
};

class Node {
  constructor(fragment = false) { this.fragment = fragment; this.children = []; this.parentNode = null; this.dataset = {}; this.scrollTop = 0; this.disabled = false; this.textContent = ""; this.classList = { add() {}, remove() {} }; }
  get firstChild() { return this.children[0] || null; }
  get scrollHeight() { return this.children.length * (this.rowHeight ?? 20); }
  set innerHTML(_) { this.children = []; }
  appendChild(node) { if (node.fragment) { while (node.firstChild) this.appendChild(node.firstChild); return node; } node.remove(); node.parentNode = this; this.children.push(node); return node; }
  prepend(node) { if (node.fragment) { for (const child of [...node.children].reverse()) this.prepend(child); return; } node.remove(); node.parentNode = this; this.children.unshift(node); }
  remove() { if (this.parentNode) this.parentNode.children.splice(this.parentNode.children.indexOf(this), 1); this.parentNode = null; }
  addEventListener(type, fn) { this.handlers ||= new Map(); if (!this.handlers.has(type)) this.handlers.set(type, []); this.handlers.get(type).push(fn); }
  dispatch(type, event) { for (const fn of this.handlers?.get(type) || []) fn(event); }
  click() { if (!this.disabled) this.dispatch("click", { type: "click", target: this }); }
  querySelector(selector) { return selector === ".history-load-button" ? this.children.find(node => node.className === "history-load-button") || null : null; }
  setAttribute(name, value) { this.attributes ||= {}; this.attributes[name] = String(value); }
  getAttribute(name) { return this.attributes?.[name] ?? null; }
  set disabled(value) { this._disabled = value; if (value && this.ownerDocument?.activeElement === this) this.ownerDocument.activeElement = this.ownerDocument.body; }
  get disabled() { return this._disabled; }
  focus(options) { this.focusCalls ||= []; this.focusCalls.push(options); if (!this.disabled && this.ownerDocument) this.ownerDocument.activeElement = this; }
  getBoundingClientRect() { const height = this.parentNode?.rowHeight ?? 20; const top = this.parentNode ? this.parentNode.children.indexOf(this) * height - this.parentNode.scrollTop : 0; return { top, bottom: top + (this.parentNode ? height : 200) }; }
}
const text = id => ({ id: String(id), role: "assistant", text: `answer ${id}` });
const tools = prefix => Array.from({ length: 300 }, (_, n) => ({ id: `${prefix}-${n}`, role: "toolResult", text: "owned tool output" }));
function piHarness(pages, { integratedIntent = false, actualConnect = false } = {}) {
  const messages = new Node(), listeners = new Map(), calls = [], notices = [], frames = [];
  const posts = [], streams = [], timers = new Map(), staging = [];
  let clock = 0, holdStaging = false, timerId = 0;
  const document = { activeElement: null, body: new Node(), documentElement: new Node(), createElement() { const node = new Node(); node.ownerDocument = document; return node; }, createDocumentFragment: () => new Node(true),
    addEventListener(type, fn) { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type).add(fn); },
    removeEventListener(type, fn) { listeners.get(type)?.delete(fn); } };
  document.activeElement = document.body;
  const ctx = vm.createContext({ document, window: { addEventListener: document.addEventListener, removeEventListener: document.removeEventListener },
    performance: { now: () => holdStaging ? (clock += 10) : 0 }, Date,
    // Only external boundaries are mocked: no network/live stream or real ready
    // timer. Zero-delay rendering yields can be held at the actual await seam.
    setTimeout: actualConnect ? (fn, ms) => { const id = ++timerId; if (ms === 0) { if (holdStaging) staging.push(fn); else queueMicrotask(fn); } else timers.set(id, fn); return id; } : setTimeout,
    clearTimeout: id => timers.delete(id),
    EventSource: class { constructor(url) { this.url = url; this.handlers = new Map(); streams.push(this); ctx.onStreamCreated?.(); } addEventListener(type, fn) { this.handlers.set(type, fn); } close() { this.closed = true; } },
    post: (url, opts) => new Promise((resolve, reject) => posts.push({ url, opts, resolve, reject })),
    fetch: async () => ({}), encodeURIComponent,
    viewGeneration: 0, apiBase: "/owned", rpc: null, activeDraftKey: "owned", userScrollIntentUntil: 0,
    el: { messages, input: { value: "untouched draft" }, viewList: new Node(), viewChat: new Node(), queueNote: new Node() },
    historyState: null, historyLoadButton: null, currentSessionCwd: null,
    api: async url => { calls.push(url); return pages(url, calls.length, ctx); },
    appendHistoryMessage(m, container) { const node = new Node(); node.record = m; container.appendChild(node); },
    async connectRpc() { ctx.rpc = { lastEventId: 1, streaming: false }; },
    toast: msg => notices.push(msg), tKey: (key, vars) => key + (vars?.detail || ""), console,
    sessionDisplayTitle: () => "owned", isDesktop: () => true,
    scrollBottom: () => { messages.scrollTop = messages.scrollHeight; },
  });
  for (const name of ["beginDraftScope", "closeChat", "resetTaskProgress", "resetProjectChanges", "resetComposerSummary", "clearLastAgentTask", "rememberLastChat", "updateSessionSelection", "hideChatEmpty", "setChatTitle", "setChatAgent", "setChatPlace", "resetLiveUsage", "resetSessionUsage", "ensureSessionUsageFooter", "refreshProjectChanges", "maybeDateSeparator", "mergeAdjacentWorkMessages", "keepSessionUsageAtEnd", "layoutWorkLog", "updateScrollBottomButton"]) ctx[name] = () => {};
  // Includes the real Pi paging controller, UI, and new capability helpers;
  // connectRpc is opt-in so the original 18 cases retain their boundary stub.
  vm.runInContext(extract("function readableHistoryPolicy(", "// Admission bounds include"), ctx);
  vm.runInContext(extract("function removeHistoryLoadButton(", "async function startNew("), ctx);
  vm.runInContext(extract("async function openExisting(", "let currentSessionCwd = null"), ctx);
  if (actualConnect) {
    for (const name of ["resetGenericReplayNotice", "setStreaming", "showList", "refreshCommands", "syncComposerState", "syncSessionStats", "handleRpcEvent"]) ctx[name] = () => {};
    vm.runInContext(extract("async function connectRpc(", "function agentConnectorLabel("), ctx);
  }
  if (integratedIntent) {
    ctx.requestAnimationFrame = fn => { frames.push(fn); return frames.length; };
    messages.clientHeight = 200;
    vm.runInContext(extract("let jumpToLatestUntil = 0;", 'el.scrollBottomBtn?.addEventListener'), ctx);
  }
  return { ctx, calls, messages, notices, listeners, posts, streams, timers, staging,
    holdStaging() { holdStaging = true; },
    releaseStaging() { holdStaging = false; for (const fn of staging.splice(0)) fn(); },
    input(type) { for (const fn of listeners.get(type) || []) fn({ type, target: document.body }); },
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

// Geometry comes from attached child positions, not a canned visual delta.
for (const adjustment of [0, 1, 0.375]) test(`Pi actual controller preserves fractional surviving anchor with native adjustment ${adjustment}`, async () => {
  const h = piHarness((url, n) => detail(Array.from({ length: 40 }, (_, i) => text(`${n}-${i}`)), n === 1 ? 300 : 0));
  h.messages.rowHeight = 20.125;
  await h.ctx.openExisting({ file: "owned.jsonl" });
  h.messages.scrollTop = 50.25;
  const anchor = h.messages.children[5], key = anchor.record.id;
  const beforeTop = h.messages.scrollTop, beforeOffset = anchor.getBoundingClientRect().top;
  const contentTop = h.messages.children.indexOf(anchor) * h.messages.rowHeight;
  let displacement, nativeTop, residualOffset;
  h.ctx.layoutWorkLog = () => {
    displacement = h.messages.children.indexOf(anchor) * h.messages.rowHeight - contentTop;
    // Model native adjustment after attached prepend, before real compensation.
    h.messages.scrollTop += displacement * adjustment;
    nativeTop = h.messages.scrollTop;
    residualOffset = anchor.getBoundingClientRect().top;
  };
  await h.ctx.loadOlderHistory(h.ctx.historyLoadButton);
  assert.equal(displacement, 784.875, "40 fractional rows added, earlier button removed at EOF");
  assert.equal(nativeTop, beforeTop + displacement * adjustment);
  assert.equal(residualOffset, beforeOffset + displacement * (1 - adjustment));
  assert.equal(h.messages.scrollTop, 835.125, `actual controller must retain content position, not stale ${beforeTop}`);
  assert.equal(anchor.parentNode, h.messages);
  assert.equal(anchor.record.id, key);
  assert.equal(anchor.getBoundingClientRect().top, beforeOffset, "same surviving anchor keeps its visual offset");
  assert.equal(h.ctx.historyState.before, 0);
  assert.equal(h.ctx.historyState.hasMore, false);
  assert.equal(h.ctx.el.input.value, "untouched draft");
});

test("Pi actual controller keeps height fallback when no measured anchor survives", async () => {
  const h = piHarness((url, n) => detail(Array.from({ length: 40 }, (_, i) => text(`${n}-${i}`)), n === 1 ? 300 : 0));
  h.messages.rowHeight = 20.125;
  await h.ctx.openExisting({ file: "owned.jsonl" });
  h.messages.scrollTop = 50.25;
  const oldHeight = h.messages.scrollHeight, oldTop = h.messages.scrollTop;
  const oldNodes = [...h.messages.children];
  h.ctx.layoutWorkLog = () => { for (const node of oldNodes) node.remove(); h.messages.scrollTop = 100.5; };
  await h.ctx.loadOlderHistory(h.ctx.historyLoadButton);
  assert.equal(h.messages.scrollTop, h.messages.scrollHeight - oldHeight + oldTop);
  assert.equal(h.messages.scrollTop, 30.125, "fallback remains captured-top height arithmetic");
});

test("Pi held manual page rejects stale ownership without rows or compensation or foreign intent consumption", async () => {
  for (const change of ["view", "state", "base", "rpc", "draft", "key", "live", "event", "lost"]) {
    let release;
    const h = piHarness((url, n) => n === 1 ? detail(Array.from({ length: 40 }, (_, i) => text(i)), 300)
      : new Promise(resolve => { release = resolve; }));
    await h.ctx.openExisting({ file: "owned.jsonl" });
    h.messages.scrollTop = 50.25;
    const rows = [...h.messages.children], state = h.ctx.historyState;
    const request = h.ctx.loadOlderHistory(h.ctx.historyLoadButton);
    if (change === "view") h.ctx.viewGeneration++;
    if (change === "state") h.ctx.historyState = { ...state };
    if (change === "base") h.ctx.apiBase = "/foreign";
    if (change === "rpc") h.ctx.rpc = {};
    if (change === "draft") h.ctx.el.input.value = "new draft";
    if (change === "key") h.ctx.activeDraftKey = "foreign";
    if (change === "live") h.ctx.rpc.streaming = true;
    if (change === "event") h.ctx.rpc.lastEventId++;
    if (change === "lost") h.ctx.rpc.connectionLost = true;
    h.ctx.userScrollIntentUntil = 12345;
    release(detail([text("late")], 0)); await request;
    assert.deepEqual(h.messages.children, rows, change);
    assert.equal(h.messages.scrollTop, 50.25, change);
    assert.equal(state.before, 300, change);
    assert.equal(state.loading, false, change);
    assert.equal(h.ctx.userScrollIntentUntil, ["view", "state", "base", "rpc"].includes(change) ? 12345 : 0, change);
    assert.equal(h.ctx.el.input.value, change === "draft" ? "new draft" : "untouched draft");
    assert.equal(h.notices.length, 0);
    assert.equal([...h.listeners.values()].reduce((n, set) => n + set.size, 0), 0);
  }
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

const turn = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const window300 = prefix => Array.from({ length: 300 }, (_, i) => text(`${prefix}-${i}`));
const rowCount = h => h.messages.children.filter(node => node.record).length;
const listenerCount = h => [...h.listeners.values()].reduce((n, set) => n + set.size, 0);
async function initialReader({ integratedIntent = false, olderPage = detail(window300("older"), 600) } = {}) {
  const pending = [];
  const h = piHarness((url, n) => {
    if (n === 1) return detail(window300("latest"), 900);
    const request = deferred(); pending.push(request); return request.promise;
  }, { actualConnect: true, integratedIntent });
  h.opening = h.ctx.openExisting({ file: "owned.jsonl", cwd: "/owned/project" });
  await turn();
  assert.equal(rowCount(h), 300, "first window is usable while /api/open is unresolved");
  assert.equal(h.posts.length, 1);
  assert.equal(h.posts[0].url, "/api/open");
  assert.equal(h.posts[0].opts.file, "owned.jsonl");
  assert.equal(h.ctx.rpc, null);
  h.state = h.ctx.historyState; h.button = h.ctx.historyLoadButton;
  h.capability = h.state.initialAttach;
  assert.equal(h.capability.active, true);
  assert.equal(h.capability.state, h.state);
  h.attach = async (result = {}) => {
    h.posts[0].resolve({ sid: "owned-sid", replayAfter: 17, ...result });
    await h.opening;
    assert.equal(h.capability.active, false, "attempt revokes further issuance");
  };
  h.admit = async (seam = "api") => {
    h.messages.rowHeight = 20.125; h.messages.scrollTop = 50.25;
    h.button.focus();
    h.anchor = h.messages.children[5]; h.offset = h.anchor.getBoundingClientRect().top;
    h.rows = [...h.messages.children];
    if (seam === "staging") h.holdStaging();
    h.read = h.ctx.loadOlderHistory(h.button);
    assert.equal(h.calls.length, 2, "one manual action admits one older request");
    assert.equal(h.state.loading, true);
    assert.equal(h.button.getAttribute("aria-busy"), "true");
    await h.ctx.loadOlderHistory(h.button);
    assert.equal(h.calls.length, 2, "single flight survives unresolved attachment");
    if (seam === "staging") { pending[0].resolve(olderPage); await turn(); assert.equal(h.staging.length, 1); }
    h.settle = async (page = olderPage) => { if (seam === "api") pending[0].resolve(page); else h.releaseStaging(); await h.read; };
  };
  h.pending = pending;
  return h;
}
function readyButton(h) {
  assert.equal(h.state.loading, false);
  assert.equal(h.button.disabled, false);
  assert.equal(h.button.textContent, "載入更早的訊息");
  assert.equal(h.button.getAttribute("aria-busy"), "false");
  assert.equal(listenerCount(h), 0);
}
function appliedInitialPage(h) {
  assert.equal(rowCount(h), 600);
  assert.equal(h.calls.length, 2);
  assert.match(h.calls[1], /before=900$/);
  assert.equal(h.state.before, 600);
  assert.equal(h.state.seen.size, 600);
  assert.equal(h.ctx.historyState, h.state);
  assert.equal(h.ctx.historyLoadButton, h.button);
  assert.equal(h.anchor.getBoundingClientRect().top, h.offset);
  assert.equal(h.ctx.el.input.value, "untouched draft");
  assert.equal(h.notices.length, 0);
  readyButton(h);
}

for (const seam of ["api", "staging"]) test(`Pi actual openExisting/connectRpc initial assignment transfers one admitted ${seam} page`, async () => {
  const h = await initialReader();
  await h.admit(seam);
  h.ctx.onStreamCreated = () => {
    assert.equal(h.capability.attachment.connection, h.ctx.rpc, "assignment is recorded before the stream boundary");
    assert.equal(h.capability.attachment.eventId, 17);
  };
  await h.attach();
  const record = h.capability.attachment;
  assert.ok(Object.isFrozen(record));
  assert.equal(record.connection, h.ctx.rpc);
  assert.equal(record.eventId, 17, "nonzero replayAfter is the immutable initialization baseline");
  assert.equal(h.streams.length, 1);
  assert.equal(rowCount(h), 300, "attachment itself never replays or prepends");
  assert.equal(h.messages.scrollTop, 50.25, "no attach-time scroll jump");
  assert.equal(h.ctx.document.activeElement, h.ctx.document.body, "attachment does not steal focus");
  await h.settle();
  appliedInitialPage(h);
  assert.equal(h.ctx.document.activeElement, h.button);
  assert.equal(h.button.focusCalls.at(-1).preventScroll, true);
});

test("Pi initial read settles before attachment without provider wait, replay, or cursor changes", async () => {
  const h = await initialReader();
  await h.admit(); await h.settle(); appliedInitialPage(h);
  assert.equal(h.ctx.rpc, null);
  const rows = [...h.messages.children], top = h.messages.scrollTop;
  await h.attach();
  assert.deepEqual(h.messages.children, rows);
  assert.equal(h.messages.scrollTop, top);
  assert.equal(h.state.before, 600);
  assert.equal(h.calls.length, 2);
});

test("Pi initial attach before admission keeps ordinary strict ownership", async () => {
  const h = await initialReader(); await h.attach(); await h.admit(); await h.settle(); appliedInitialPage(h);
});

test("Pi unresolved API honestly stays loading; failed attach revokes unused authority without blocking history", async () => {
  const h = await initialReader(); await h.admit();
  await turn();
  assert.equal(rowCount(h), 300); assert.equal(h.state.loading, true);
  assert.equal(h.button.disabled, true); assert.equal(listenerCount(h), 7);
  h.posts[0].reject(new Error("attach unavailable")); await h.opening;
  assert.equal(h.capability.active, false); assert.equal(h.capability.attachment, null);
  assert.equal(h.ctx.rpc, null);
  assert.equal(h.notices.length, 1); h.notices.length = 0;
  await h.settle(); appliedInitialPage(h);
});

const ownerChanges = ["view", "state", "base", "rpc", "draft", "key", "live", "event", "lost"];
function changeOwner(h, change) {
  if (change === "view") h.ctx.viewGeneration++;
  if (change === "state") h.ctx.historyState = { ...h.state, loading: true };
  if (change === "base") h.ctx.apiBase = "/foreign";
  if (change === "rpc") h.ctx.rpc = { ...h.ctx.rpc };
  if (change === "draft") h.ctx.el.input.value = "new draft";
  if (change === "key") h.ctx.activeDraftKey = "foreign";
  if (change === "live") h.ctx.rpc.streaming = true;
  if (change === "event") h.streams[0].onmessage({ lastEventId: "18", data: '{"type":"noop"}' });
  if (change === "lost") h.ctx.rpc.connectionLost = true;
}
function cancelledPage(h, foreign) {
  assert.deepEqual(h.messages.children, h.rows);
  assert.equal(rowCount(h), 300);
  assert.equal(h.state.before, 900); assert.equal(h.state.seen.size, 300);
  assert.equal(h.messages.scrollTop, 50.25);
  assert.equal(h.state.loading, false);
  assert.equal(h.notices.length, 0); assert.equal(listenerCount(h), 0);
  assert.equal(h.ctx.userScrollIntentUntil, foreign ? 12345 : 0);
  if (foreign) {
    assert.equal(h.button.disabled, true, "foreign view receives no UI cleanup");
    assert.equal(h.button.getAttribute("aria-busy"), "true");
    assert.equal(h.ctx.document.activeElement, h.ctx.document.body, "no foreign focus restoration");
  } else {
    readyButton(h);
    assert.equal(h.ctx.document.activeElement, h.button);
  }
}
for (const attached of [false, true]) for (const seam of ["api", "staging"]) {
  test(`Pi ${attached ? "attached" : "initial-transfer"} ${seam} rejects all nine stale owners`, async t => {
    for (const change of ownerChanges) await t.test(change, async () => {
      const h = await initialReader();
      if (attached) await h.attach();
      await h.admit(seam);
      if (!attached) await h.attach();
      changeOwner(h, change); h.ctx.userScrollIntentUntil = 12345;
      await h.settle(); cancelledPage(h, ["view", "state", "base", "rpc"].includes(change));
      if (change === "state") assert.equal(h.ctx.historyState.loading, true, "never clear replacement state");
      if (change === "draft") assert.equal(h.ctx.el.input.value, "new draft");
    });
  });
}

test("Pi initial transfer never absorbs draft or live changes before or after assignment", async t => {
  for (const timing of ["before", "after"]) for (const change of ["draft", "key", "live", "event"]) await t.test(`${timing}-${change}`, async () => {
    const h = await initialReader(); await h.admit();
    if (timing === "before" && ["draft", "key"].includes(change)) changeOwner(h, change);
    // Live initial state comes from /api/open, not a fabricated null RPC.
    await h.attach({ isStreaming: timing === "before" && change === "live" });
    if (timing === "after" || change === "event") changeOwner(h, change);
    h.ctx.userScrollIntentUntil = 12345;
    await h.settle(); cancelledPage(h, false);
    assert.equal(h.capability.attachment.eventId, 17, "later events cannot rebaseline a still-held read");
  });
});

test("Pi unmarked and lookalike RPC transitions have no transfer authority", async t => {
  for (const change of ["unmarked", "same-sid-lookalike", "second-rpc"]) await t.test(change, async () => {
    const h = await initialReader(); await h.admit();
    if (change === "unmarked") {
      const unmarked = h.ctx.connectRpc({ file: "owned.jsonl" });
      h.posts[1].resolve({ sid: "owned-sid", replayAfter: 17 }); await unmarked;
      assert.equal(h.capability.attachment, null);
    } else {
      await h.attach();
      if (change === "same-sid-lookalike") h.ctx.rpc = { ...h.ctx.rpc };
      else {
        const second = h.ctx.connectRpc({ file: "owned.jsonl" });
        h.posts[1].resolve({ sid: "owned-sid", replayAfter: 17 }); await second;
      }
    }
    h.ctx.userScrollIntentUntil = 12345; await h.settle(); cancelledPage(h, true);
    if (change === "unmarked") await h.attach();
  });
});

test("Pi initial capability mismatch and non-null prior RPC cannot issue an assignment record", async t => {
  for (const change of ["state", "file", "base", "generation", "requested-file", "source-file", "replaced-capability", "prior-rpc", "revoked", "second-issue"]) await t.test(change, async () => {
    const h = await initialReader(); await h.admit();
    if (change === "state") h.capability.state = {};
    if (change === "file") h.capability.file = "other.jsonl";
    if (change === "base") h.capability.base = "/foreign";
    if (change === "generation") h.capability.generation++;
    if (change === "requested-file") h.posts[0].opts.file = "other.jsonl";
    if (change === "source-file") h.state.file = "other.jsonl";
    if (change === "replaced-capability") h.state.initialAttach = { ...h.capability };
    if (change === "prior-rpc") h.ctx.rpc = { sid: "prior" };
    if (change === "revoked") h.capability.active = false;
    if (change === "second-issue") h.capability.attachment = Object.freeze({ connection: {}, eventId: 17 });
    const priorRecord = h.capability.attachment;
    await h.attach(); assert.equal(h.capability.attachment, priorRecord);
    h.ctx.userScrollIntentUntil = 12345; await h.settle(); cancelledPage(h, true);
  });
});

for (const bound of ["readable", "pages", "UTF16", "deadline"]) test(`Pi initial transfer preserves admission counters and ${bound} bound`, async () => {
  const h = await initialReader(); let now = 0;
  h.ctx.Date = { now: () => now };
  await h.admit();
  now = bound === "deadline" ? 1300 : 0;
  await h.attach();
  let page = bound === "readable" ? window300("older") : tools("older");
  if (bound === "UTF16") page[0].text = "😀".repeat(524288);
  h.pending[0].resolve(detail(page, 600));
  // A complete admitted page is retained even when it settles past 1200ms.
  if (bound === "pages") {
    for (let i = 1; i < 8; i++) { await turn(); assert.equal(h.pending.length, i + 1); h.pending[i].resolve(detail(tools(`batch-${i}`), 600 - i * 50)); }
  }
  await h.read;
  assert.equal(h.calls.length, bound === "pages" ? 9 : 2);
  assert.equal(rowCount(h), bound === "pages" ? 2700 : 600);
  assert.equal(h.state.seen.size, rowCount(h));
  assert.equal(h.state.before, bound === "pages" ? 250 : 600);
  assert.equal(h.state.error, null); readyButton(h);
});

test("Pi initial transfer retains partial failure boundary, manual retry and honest EOF", async () => {
  const h = await initialReader(); await h.admit(); await h.attach();
  h.pending[0].resolve(detail(tools("older"), 600)); await turn();
  assert.equal(h.pending.length, 2); h.pending[1].reject(new Error("offline")); await h.read;
  assert.equal(rowCount(h), 600); assert.equal(h.state.before, 600);
  assert.equal(h.button.dataset.autoLoadPaused, "1"); assert.equal(h.notices.length, 1); readyButton(h);
  const retry = h.ctx.loadOlderHistory(h.button);
  assert.match(h.calls.at(-1), /before=600$/);
  h.pending[2].resolve(detail([text("earliest")], 0)); await retry;
  assert.equal(h.state.before, 0); assert.equal(h.state.hasMore, false);
  assert.equal(h.ctx.historyLoadButton, null); assert.equal(h.state.error, null);
  assert.equal(rowCount(h), 601); assert.equal(listenerCount(h), 0);
});

test("Pi initial transfer focus lease honors body, composer, focus escape, input and blur", async t => {
  for (const escape of ["body", "composer", "control", "input", "blur"]) await t.test(escape, async () => {
    const h = await initialReader(); await h.admit();
    const target = escape === "composer" ? h.ctx.el.input : h.ctx.document.createElement("button");
    if (["composer", "control"].includes(escape)) { h.ctx.document.activeElement = target; h.dispatch("focusin", { target }); }
    if (["input", "blur"].includes(escape)) h.input(escape);
    await h.attach(); await h.settle(); appliedInitialPage(h);
    assert.equal(h.ctx.document.activeElement, escape === "body" ? h.button : ["composer", "control"].includes(escape) ? target : h.ctx.document.body);
    if (escape === "body") assert.equal(h.button.focusCalls.at(-1).preventScroll, true);
    else assert.equal(h.button.focusCalls.length, 1, "only the original deliberate focus, never a restore");
  });
});

for (const flushWhileHeld of [false, true]) test(`Pi initial transfer consumes real queued intent without chaining (held RAF ${flushWhileHeld})`, async () => {
  const h = await initialReader({ integratedIntent: true }); await h.admit();
  h.dispatch("wheel", { deltaY: -30, deltaX: 0 }); h.dispatch("scroll");
  if (flushWhileHeld) h.flushFrames();
  await h.attach();
  const page = [{ id: "large-tool", role: "toolResult", text: "x".repeat(1048576) }, ...Array.from({ length: 8 }, (_, i) => text(`small-${i}`))];
  await h.settle(detail(page, 600));
  assert.ok(h.messages.scrollTop <= 600);
  h.dispatch("scroll"); h.flushFrames(); await turn();
  assert.equal(h.calls.length, 2); assert.equal(h.intent(), 0);
  assert.equal(h.anchor.getBoundingClientRect().top, h.offset);
  h.dispatch("wheel", { deltaY: -30, deltaX: 0 }); h.dispatch("scroll"); h.flushFrames(); await turn();
  assert.equal(h.calls.length, 3, "fresh later approach still admits work");
  h.pending[1].resolve(detail([text("last")], 0)); await turn();
  assert.equal(h.state.hasMore, false); assert.equal(listenerCount(h), 0);
});

test("Pi initial transfer keeps counters accumulated before assignment and rejects stale errors", async t => {
  for (const bound of ["pages", "UTF16", "deadline"]) await t.test(bound, async () => {
    const h = await initialReader(); let now = 0; h.ctx.Date = { now: () => now };
    await h.admit();
    const first = tools("before-attach");
    if (bound === "UTF16") first[0].text = "x".repeat(600000);
    h.pending[0].resolve(detail(first, 600)); await turn();
    assert.equal(rowCount(h), 600); assert.equal(h.pending.length, 2);
    now = bound === "deadline" ? 1300 : 0;
    await h.attach();
    const second = tools("after-attach");
    if (bound === "UTF16") second[0].text = "x".repeat(600000);
    h.pending[1].resolve(detail(second, 550));
    if (bound === "pages") for (let i = 2; i < 8; i++) {
      await turn(); assert.equal(h.pending.length, i + 1);
      h.pending[i].resolve(detail(tools(`after-${i}`), 550 - (i - 1) * 50));
    }
    await h.read;
    assert.equal(h.calls.length, bound === "pages" ? 9 : 3);
    assert.equal(rowCount(h), bound === "pages" ? 2700 : 900);
    assert.equal(h.state.before, bound === "pages" ? 250 : 550);
    readyButton(h);
  });
  for (const attached of [false, true]) for (const change of ownerChanges) await t.test(`error-${attached}-${change}`, async () => {
    const h = await initialReader();
    if (attached) await h.attach(); await h.admit(); if (!attached) await h.attach();
    changeOwner(h, change); h.ctx.userScrollIntentUntil = 12345;
    h.pending[0].reject(new Error("late foreign failure")); await h.read;
    cancelledPage(h, ["view", "state", "base", "rpc"].includes(change));
  });
});

// Observations only: no alternate loader, clock patch, or browser execution.
// All acceptance/rejection predicates below are the exports used by the DOM case.
async function piToolDomControls() {
  const helpers = await import("../scripts/readable-history-browser-cases.mjs");
  const fixture = helpers.buildPiToolDomFixture();
  const observation = count => {
    const admitted = fixture.keys.slice(0, count).flatMap(key => fixture.pages[key].messages);
    const boundary = fixture.pages[fixture.keys[count - 1]];
    return {
      reads: fixture.keys.slice(0, count).map((key, n) => ({ file: "owned-readable.jsonl", limit: "300", before: n ? key : null })),
      snapshot: {
        before: boundary.nextBefore, hasMore: boundary.hasMore, loading: false, error: null,
        owner: { sid: "owned-readable-rpc", file: "owned-readable.jsonl", currentFile: "owned-readable.jsonl", base: "", generation: 1, draftKey: "owned", eventId: 0, attached: true, streaming: false, lost: false },
        seen: admitted.map(record => record.id), nodes: 5000, bodies: 0, outputs: 0,
        cards: admitted.filter(record => record.toolCalls).map(record => ({ id: record.toolCalls[0].id, results: admitted.filter(result => result.toolCallId === record.toolCalls[0].id).map(result => result.id) })),
        prose: count === 9 ? fixture.tail.map(record => record.text) : [],
        button: count === 9 ? null : { disabled: false, busy: "false", paused: false }, buttonFocused: count !== 9,
        draft: "Preserve owned sparse draft", intent: 0,
      },
    };
  };
  const verify = (window, options) => helpers.verifyPiToolDomWindow(fixture, window.reads, window.snapshot, options);
  return { ...helpers, fixture, observation, verify };
}

test("Pi DOM fixture canonical2440 matches actual server raw300 slices and real policy", async () => {
  const { fixture } = await piToolDomControls();
  assert.equal(fixture.records.length, 2440);
  assert.equal(fixture.tail.length, 40);
  assert.equal(new Set(fixture.records.map(record => record.id)).size, 2440);
  assert.equal(new Set(fixture.tail.map(record => record.text)).size, 40);
  const h = piHarness(() => { throw new Error("pure controls must not request a page"); });
  assert.deepEqual(JSON.parse(JSON.stringify(h.ctx.readableHistoryPolicy())), { target: 40, pages: 8, size: 1048576, ms: 1200 });
  assert.equal(h.ctx.piHistoryReadableCount(fixture.tail), 40);
  assert.equal(h.ctx.piHistoryReadableCount(fixture.records), 40);
  assert.deepEqual(fixture.keys, ["latest", "2140", "1840", "1540", "1240", "940", "640", "340", "40"]);
  const server = fs.readFileSync(require.resolve("../server.js"), "utf8");
  const from = server.indexOf("  const requestedLimit = Number(options.limit);"), to = server.indexOf("\n}\n\nfunction safeSessionPath", from);
  assert.ok(from >= 0 && to > from);
  const slice = vm.runInNewContext(`(function(allMessages, options) { const header = {}, name = null, firstMessage = null; ${server.slice(from, to)} })`);
  for (const key of fixture.keys) {
    const response = fixture.pages[key], before = key === "latest" ? null : Number(key);
    h.ctx.validatePiHistoryPage(response, before);
    const actual = JSON.parse(JSON.stringify(slice(fixture.records, { before, limit: 300 })));
    assert.deepEqual(response.messages, actual.messages);
    assert.equal(response.nextBefore, actual.nextBefore);
    assert.equal(response.hasMore, actual.hasMore);
    assert.equal(actual.totalMessages, 2440);
    assert.ok(response.messages.length <= 300);
    assert.equal(h.ctx.piHistoryReadableCount(response.messages), key === "40" ? 40 : 0);
  }
  for (let n = 0; n < 8; n++) for (let i = 0; i < 150; i++) {
    const [call, result] = fixture.pages[fixture.keys[n]].messages.slice(i * 2, i * 2 + 2);
    assert.equal(call.id, `sparse-${n}-call-${i}`);
    assert.equal(call.toolCalls[0].id, `sparse-${n}-${i}`);
    assert.equal(call.role, "assistant"); assert.equal(call.text, "");
    assert.equal(result.id, `sparse-${n}-result-${i}`);
    assert.equal(result.toolCallId, call.toolCalls[0].id);
    assert.equal(result.role, "toolResult"); assert.equal(result.toolName, "bash");
    if (n || i) {
      assert.deepEqual(call.toolCalls[0], { id: `sparse-${n}-${i}`, name: "bash", args: { command: "owned synthetic test report" } });
      assert.equal(result.text, `ok ${i} - owned synthetic case`); assert.equal(result.isError, false);
    } else {
      assert.equal(call.toolCalls[0].name, "subagent");
      assert.deepEqual(call.toolCalls[0].args, { agent: "owned", task: "synthetic", extra: "complete Unicode 🌍 arguments" });
      assert.equal(result.text, "owned full output 🌍"); assert.equal(result.isError, true);
      assert.deepEqual(result.subagents, { rows: [{ index: 0, key: "0", harness: "pi", name: "owned", task: "synthetic", status: "failed", result: "owned child error" }] });
    }
  }
  for (const [n, record] of fixture.tail.entries()) {
    assert.equal(record.role, n % 2 ? "assistant" : "user");
    assert.ok(record.text.trim().length > 20);
  }
  assert.deepEqual(h.calls, []);
});

test("Pi DOM complete initial prefixes1..8 reject the old guaranteed8 premise", async t => {
  const { observation, verify } = await piToolDomControls();
  for (let k = 1; k <= 8; k++) await t.test(`initial${k}`, () => {
    const window = observation(k);
    verify(window, { initial: true });
    assert.equal(window.snapshot.cards.length, 150 * k);
    assert.equal(window.snapshot.seen.length, 300 * k);
    assert.equal(window.snapshot.before, 2440 - 300 * k);
    assert.equal(window.snapshot.hasMore, true);
    if (k < 8) assert.throws(() => assert.equal(window.reads.length, 8));
    else verify(window, { final: true }); // Already complete: zero actions required.
  });
});

test("Pi DOM bounded resumption partitions retain full1200 and exact final40/EOF0", async t => {
  const { observation, verify, verifyPiToolDomNoAction } = await piToolDomControls();
  for (let k = 1; k <= 8; k++) {
    const remaining = 8 - k;
    const partitions = [Array(remaining).fill(1), remaining ? [remaining] : [], remaining ? [...Array(Math.floor(remaining / 2)).fill(2), ...(remaining % 2 ? [1] : [])] : []];
    if (remaining) partitions.push([remaining + 1]); // Prose can join the completing batch, never a tail-only action.
    for (const [n, partition] of partitions.entries()) await t.test(`initial${k}-partition${n}`, () => {
      let current = verify(observation(k), { initial: true }), count = k;
      assert.ok(partition.length <= 8);
      for (const pages of partition) {
        count += pages;
        const next = verify(observation(count), { previous: current, draft: current.snapshot.draft });
        verifyPiToolDomNoAction(next, verify(observation(count)));
        current = next;
      }
      verify(current, { final: true });
      assert.equal(current.snapshot.before, count === 9 ? 0 : 40);
      assert.equal(current.snapshot.hasMore, count !== 9);
      assert.equal(current.snapshot.seen.length, count === 9 ? 2440 : 2400);
    });
  }
});

test("Pi DOM actual verifiers HOLD on invalid receipts, retention, ownership or no-action growth", async t => {
  const { fixture, observation, verify, verifyPiToolDomWindow, verifyPiToolDomNoAction } = await piToolDomControls();
  const invalid = [
    ["zero pages", w => { w.reads = []; }],
    ["cursor gap", w => { w.reads[1].before = "1540"; }],
    ["duplicate request", w => { w.reads[1] = { ...w.reads[0] }; }],
    ["foreign file", w => { w.reads[0].file = "foreign.jsonl"; }],
    ["wrong limit", w => { w.reads[0].limit = "500"; }],
    ["error", w => { w.snapshot.error = "pi_history_overlap"; }],
    ["loading", w => { w.snapshot.loading = true; }],
    ["paused error UI", w => { w.snapshot.button.paused = true; }],
    ["foreign RPC", w => { w.snapshot.owner.sid = "foreign"; }],
    ["foreign owner", w => { w.snapshot.owner.attached = false; }],
    ["streaming", w => { w.snapshot.owner.streaming = true; }],
    ["dropped IDs", w => { w.snapshot.seen.pop(); }],
    ["duplicate seen disguised totals", w => { w.snapshot.seen[0] = w.snapshot.seen[1]; }],
    ["dropped result", w => { w.snapshot.cards[0].results = []; }],
    ["duplicate card disguised totals", w => { w.snapshot.cards[0] = w.snapshot.cards[1]; }],
    ["foreign result membership", w => { w.snapshot.cards[0].results = ["foreign-result"]; }],
    ["eager body", w => { w.snapshot.bodies = 1; }],
    ["eager output", w => { w.snapshot.outputs = 1; }],
    ["DOM bound", w => { w.snapshot.nodes = 10000; }],
    ["fake final cursor", w => { w.snapshot.before = 100; }],
  ];
  for (const [name, mutate] of invalid) await t.test(name, () => {
    const window = observation(8); mutate(window); assert.throws(() => verify(window, { initial: true }));
  });
  const badFixtures = [
    ["missing page", f => { delete f.pages["340"]; }],
    ["overlap", f => { f.pages["340"].messages[0] = f.pages.latest.messages[0]; }],
    ["old300-to100", f => { f.pages["340"].nextBefore = 100; }],
    ["fake100-to60", f => { f.keys[8] = "100"; f.pages["100"] = { ...f.pages["40"], nextBefore: 60, hasMore: true }; }],
  ];
  for (const [name, mutate] of badFixtures) await t.test(name, () => {
    const bad = structuredClone(fixture); mutate(bad);
    const window = observation(name === "fake100-to60" ? 9 : 8);
    assert.throws(() => verifyPiToolDomWindow(bad, window.reads, window.snapshot));
  });
  await t.test("no progress is not retryable", () => assert.throws(() => verify(observation(1), { previous: verify(observation(1)) })));
  await t.test("more than8 pages per action", () => assert.throws(() => verify(observation(9), { previous: { reads: [], snapshot: observation(1).snapshot } })));
  await t.test("initial9 exceeds ceiling", () => assert.throws(() => verify(observation(9), { initial: true })));
  await t.test("incomplete1200 proof", () => assert.throws(() => verify(observation(7), { final: true })));
  await t.test("focus lost after batch", () => { const w = observation(2); w.snapshot.buttonFocused = false; assert.throws(() => verify(w, { previous: verify(observation(1)) })); });
  await t.test("owner changed between batches", () => { const w = observation(2); w.snapshot.owner.generation++; assert.throws(() => verify(w, { previous: verify(observation(1)) })); });
  await t.test("draft changed between batches", () => { const w = observation(2); w.snapshot.draft = "changed"; assert.throws(() => verify(w, { previous: verify(observation(1)) })); });
  await t.test("tail content dropped", () => { const w = observation(9); w.snapshot.prose.pop(); assert.throws(() => verify(w, { final: true })); });
  await t.test("EOF button remains", () => { const w = observation(9); w.snapshot.button = observation(8).snapshot.button; assert.throws(() => verify(w, { final: true })); });
  await t.test("unexpected no-action read", () => assert.throws(() => verifyPiToolDomNoAction(verify(observation(7)), verify(observation(8)))));
  await t.test("unexpected no-action intent", () => { const w = observation(8); w.snapshot.intent = 1; assert.throws(() => verifyPiToolDomNoAction(verify(observation(8)), verify(w))); });
});


test("Pi DOM no-action phases distinguish settled batches from real disclosure input", async t => {
  const { observation, verifyPiToolDomNoAction } = await piToolDomControls();
  const previous = observation(8);
  const disclosed = () => { const w = observation(8); w.snapshot.intent = 1793950630954; return w; };
  await t.test("default post-batch accepts consumed intent", () => verifyPiToolDomNoAction(previous, observation(8)));
  await t.test("default post-batch rejects renewed intent", () => assert.throws(() => verifyPiToolDomNoAction(previous, disclosed())));
  await t.test("explicit post-batch rejects renewed intent", () => assert.throws(() => verifyPiToolDomNoAction(previous, disclosed(), { phase: "post-batch" })));
  await t.test("disclosure accepts positive safe integer with identical history", () => verifyPiToolDomNoAction(previous, disclosed(), { phase: "disclosure" }));
  await t.test("disclosure preserves original focus false option", () => {
    const w = disclosed(); w.snapshot.buttonFocused = false;
    verifyPiToolDomNoAction(previous, w, { phase: "disclosure", focus: false });
  });
  for (const [name, intent] of [["zero", 0], ["negative", -1], ["fraction", 1.5], ["unsafe", Number.MAX_SAFE_INTEGER + 1], ["NaN", NaN], ["infinite", Infinity], ["string", "1793950630954"], ["null", null], ["missing", undefined]]) {
    await t.test(`disclosure rejects ${name} intent`, () => {
      const w = disclosed(); w.snapshot.intent = intent;
      assert.throws(() => verifyPiToolDomNoAction(previous, w, { phase: "disclosure" }));
    });
  }
  for (const phase of ["unknown", "", null, false]) await t.test(`reject unknown phase ${JSON.stringify(phase)}`, () => {
    assert.throws(() => verifyPiToolDomNoAction(previous, disclosed(), { phase, focus: false }));
  });
  const invalid = [
    ["extra request", w => { w.reads.push({ ...w.reads.at(-1) }); }],
    ["changed request", w => { w.reads[0].limit = "500"; }],
    ["cursor", w => { w.snapshot.before = 0; }],
    ["hasMore", w => { w.snapshot.hasMore = false; }],
    ["loading", w => { w.snapshot.loading = true; }],
    ["error", w => { w.snapshot.error = "pi_history_overlap"; }],
    ["owner", w => { w.snapshot.owner.generation++; }],
    ["seen IDs", w => { w.snapshot.seen.pop(); }],
    ["card IDs", w => { w.snapshot.cards[0].id = "foreign"; }],
    ["result IDs", w => { w.snapshot.cards[0].results = ["foreign"]; }],
    ["prose", w => { w.snapshot.prose.push("unexpected"); }],
    ["draft", w => { w.snapshot.draft = "changed"; }],
    ["button ownership", w => { w.snapshot.button = null; }],
    ["button disabled", w => { w.snapshot.button.disabled = true; }],
    ["button busy", w => { w.snapshot.button.busy = "true"; }],
    ["button paused", w => { w.snapshot.button.paused = true; }],
  ];
  for (const [name, mutate] of invalid) await t.test(`disclosure still rejects ${name} with focus false`, () => {
    const w = disclosed(); mutate(w);
    assert.throws(() => verifyPiToolDomNoAction(previous, w, { phase: "disclosure", focus: false }));
  });
  await t.test("disclosure default focus still rejects lost button focus", () => {
    const w = disclosed(); w.snapshot.buttonFocused = false;
    assert.throws(() => verifyPiToolDomNoAction(previous, w, { phase: "disclosure" }));
  });
});
