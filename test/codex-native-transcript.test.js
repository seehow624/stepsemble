"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const agentTranscriptPresentation = require("../public/modules/agent-transcript-presentation.js");

const source = fs.readFileSync(require.resolve("../public/app.js"), "utf8");
const slice = source.slice(source.indexOf("function codexNativeItemText("), source.indexOf("async function openCodexNativeTask("));
const entry = (turnId, id, text = id) => ({ turnId, item: { id, type: "agentMessage", text } });
const turn = id => ({ id, status: "completed", items: [] });
const page = (data, nextCursor = null) => ({ data, nextCursor });
const plain = value => JSON.parse(JSON.stringify(value));

// Exercise the actual controller with layout-aware inert nodes. No private
// history, native process or model is involved.
class Node {
  constructor(tag = "div") { this.tag = tag; this.children = []; this.parentNode = null; this.dataset = {}; this.attrs = {}; this.listeners = {}; this._text = ""; this.scrollTop = 0;
    this.classList = { remove() {}, toggle() {} }; }
  set textContent(value) { this._text = String(value); }
  get textContent() { return this._text + this.children.map(n => n.textContent).join(""); }
  get firstChild() { return this.children[0] || null; }
  get nextSibling() { return this.parentNode?.children[this.parentNode.children.indexOf(this) + 1] || null; }
  get scrollHeight() { return this.children.length * 100; }
  appendChild(node) { return this.insertBefore(node, null); }
  append(...nodes) { nodes.forEach(node => this.appendChild(node)); }
  prepend(node) { this.insertBefore(node, this.firstChild); }
  insertBefore(node, before) {
    if (before === node) return node;
    node.remove();
    const index = before === null ? this.children.length : this.children.indexOf(before);
    assert.ok(index >= 0);
    this.children.splice(index, 0, node); node.parentNode = this; return node;
  }
  remove() { if (this.parentNode) this.parentNode.children.splice(this.parentNode.children.indexOf(this), 1); this.parentNode = null; }
  replaceWith(node) { this.parentNode.insertBefore(node, this); this.remove(); }
  setAttribute(key, value) { this.attrs[key] = String(value); }
  addEventListener(key, fn) { this.listeners[key] = fn; }
  getBoundingClientRect() {
    const top = this.parentNode ? this.parentNode.children.indexOf(this) * 100 - this.parentNode.scrollTop : 0;
    return { top, bottom: top + (this.parentNode ? 100 : 300) };
  }
}

function harness(api) {
  const messages = new Node(), notices = [], calls = [], contextCalls = [], timers = [], documentEvents = new Map();
  const doc = { createElement: tag => new Node(tag), body: new Node("body"), activeElement: null,
    addEventListener(type, fn) { if (!documentEvents.has(type)) documentEvents.set(type, new Set()); documentEvents.get(type).add(fn); },
    removeEventListener(type, fn) { documentEvents.get(type)?.delete(fn); } };
  doc.activeElement = doc.body;
  const ctx = vm.createContext({ URLSearchParams, AbortController, apiBase: "/r/owned", viewGeneration: 1, subagentTracker: null,
    agentTranscriptPresentation, agentStatusText: status => status, genericInputBlock: () => null,
    codexNativeHistoryButton: null, codexNativePollTimer: null, autoScrollPinned: false, userScrollIntentUntil: 0,
    document: doc,
    window: { stepsembleI18n: { t: value => value },
      addEventListener(type, fn) { const key = `window:${type}`; if (!documentEvents.has(key)) documentEvents.set(key, new Set()); documentEvents.get(key).add(fn); },
      removeEventListener(type, fn) { documentEvents.get(`window:${type}`)?.delete(fn); } },
    el: { messages, taskReplayNote: new Node() },
    api: async (url, opts) => { calls.push({ url, ...opts }); return api(new URL(url, "http://owned"), opts); },
    toast: msg => notices.push(msg), tKey: (key, vars = {}) => key + ":" + (vars.detail || ""),
    syncGenericInputState() {}, applyGenericTaskSnapshot() {}, ensureSessionUsageFooter() {}, keepSessionUsageAtEnd() {},
    // This slice exercises native ordering and anchor preservation; the
    // presentation pass runs in the browser and has its own interaction tests.
    layoutWorkLog() {},
    async syncNativeContext(connection) { contextCalls.push(connection); },
    updateScrollBottomButton() {}, scrollBottom() { messages.scrollTop = messages.scrollHeight; },
    setInterval(fn) { timers.push(fn); return timers.length; }, clearInterval() {},
    renderMarkdown(text) { const node = new Node(); node.textContent = text; return node; },
    msgActionsRow() { return new Node(); },
    // Branch in new chat is exercised with the page's own row tests.
    codexReplyFork() { return null; },
    makeMsgShell(role, label, container) { const wrap = new Node(), bubble = new Node(); wrap.appendChild(bubble); container.appendChild(wrap); return { wrap, bubble }; },
  });
  vm.runInContext(slice, ctx);
  ctx.appendCodexNativeActivity = (rows, container) => { const node = new Node(); node.textContent = "collapsed work"; container.appendChild(node); };
  ctx.rpc = { nativeCodex: true, nativeThreadId: "thread-a", nativeTranscriptState: ctx.createCodexNativeTranscriptState() };
  return { ctx, calls, contextCalls, notices, messages, state: ctx.rpc.nativeTranscriptState, connection: ctx.rpc, timers,
    documentEvents, documentInput(type, target = doc.body) { for (const fn of documentEvents.get(type) || []) fn({ type, target }); },
    windowInput(type) { for (const fn of documentEvents.get(`window:${type}`) || []) fn({ type, target: doc.body }); } };
}

// Integrate the real common/short input and queued scroll listeners with the
// actual older-page controller; a future timestamp set by hand misses the
// pending-wheel -> long prepend -> edge-return path found in the browser.
function sharedHistoryIntent(h) {
  const listeners = new Map(), frames = new Map(), actions = [];
  let nextFrame = 0;
  h.messages.clientHeight = 300;
  h.messages.addEventListener = (type, fn) => {
    if (!listeners.has(type)) listeners.set(type, []);
    listeners.get(type).push(fn);
  };
  h.messages.querySelector = selector => selector === ".history-load-button" ? h.ctx.codexNativeHistoryButton : null;
  h.ctx.requestAnimationFrame = fn => { const id = ++nextFrame; frames.set(id, fn); return id; };
  h.ctx.window.getSelection = () => null;
  h.ctx.ownedIntentClock = 1000;
  vm.runInContext("Date.now = () => ownedIntentClock", h.ctx);
  const start = source.indexOf("let jumpToLatestUntil = 0;");
  const end = source.indexOf("el.scrollBottomBtn?.addEventListener", start);
  assert.ok(start >= 0 && end > start);
  vm.runInContext(source.slice(start, end), h.ctx);
  const load = h.ctx.loadOlderCodexNativeHistory;
  h.ctx.loadOlderCodexNativeHistory = (...args) => { const action = load(...args); actions.push(action); return action; };
  const button = h.ctx.codexNativeHistoryButton;
  button.click = () => button.listeners.click({ type: "click", target: button });
  return {
    actions,
    input(type) { for (const fn of listeners.get(type) || []) fn({ type, target: h.messages, deltaY: -120, deltaX: 0 }); },
    flush() { const queued = [...frames.values()]; frames.clear(); queued.forEach(fn => fn()); },
    intent() { return vm.runInContext("userScrollIntentUntil", h.ctx); },
    advance(ms) { h.ctx.ownedIntentClock += ms; },
  };
}

async function heldNormalCodex() {
  let release, arrived;
  const gate = new Promise(resolve => { release = resolve; });
  const requested = new Promise(resolve => { arrived = resolve; });
  const h = harness(async url => {
    const kind = url.pathname.split("/").at(-1), cursor = url.searchParams.get("cursor");
    if (kind === "thread") return { thread: { id: "thread-a", status: { type: "idle" } } };
    if (kind === "turns") return page([]);
    if (cursor === "older-one") { arrived(); await gate; }
    return page(Array.from({ length: 40 }, (_, n) => entry("turn-a", `${cursor || "latest"}-${n}`)),
      cursor === "older-one" ? "older-two" : cursor ? "older-three" : "older-one");
  });
  await h.ctx.refreshCodexNativeSnapshot(h.connection, { initial: true });
  const input = sharedHistoryIntent(h);
  assert.ok(h.messages.scrollHeight > h.messages.clientHeight);
  h.messages.scrollTop = 100; input.input("wheel");
  h.messages.scrollTop = 0; input.input("scroll"); input.flush();
  await requested;
  assert.equal(h.state.loading, true);
  assert.equal(input.actions.length, 1);
  return { h, input, release };
}

for (const order of ["before-finally", "after-finally"]) {
  test(`Codex normal40 owned completion consumes renewed shared intent: RAF ${order}`, async () => {
    const { h, input, release } = await heldNormalCodex();
    input.advance(50); input.input("wheel"); // At the upper edge: no second native scroll.
    assert.ok(input.intent() > h.ctx.ownedIntentClock, "actual common input renewed intent while the page is held");
    const render = h.ctx.renderCodexNativeSnapshot;
    h.ctx.renderCodexNativeSnapshot = (...args) => {
      const value = render(...args);
      input.input("scroll");
      if (order === "before-finally") input.flush();
      return value;
    };
    release(); await input.actions[0]; input.flush();
    assert.ok(h.messages.scrollTop > 600, "actual forty-message prepend passes the common edge-return guard");
    assert.equal(input.intent(), 0, "owned completion consumes pending input even when native compensation is beyond600");
    assert.equal(h.ctx.codexNativeReadableKeys(h.state).size, 80);
    assert.equal(h.calls.filter(call => call.url.includes("/items?")).length, 2, "one gesture remains one batch");
    input.advance(801); h.messages.scrollTop = 100; input.input("wheel");
    h.messages.scrollTop = 0; input.input("scroll"); input.flush(); await input.actions[1];
    assert.equal(input.actions.length, 2, "a genuinely later gesture still admits another batch");
    assert.equal(h.calls.filter(call => call.url.includes("/items?")).length, 3);
    assert.equal(input.intent(), 0);
  });
}

for (const owner of ["rpc", "generation", "base"]) {
  test(`stale Codex owned completion preserves another view intent: ${owner}`, async () => {
    const { h, input, release } = await heldNormalCodex();
    if (owner === "rpc") h.ctx.rpc = { nativeCodex: true, nativeTranscriptState: h.ctx.createCodexNativeTranscriptState() };
    else if (owner === "generation") h.ctx.viewGeneration++;
    else h.ctx.apiBase = "/r/another-owned-view";
    input.advance(50); input.input("wheel");
    const otherIntent = input.intent();
    assert.ok(otherIntent > h.ctx.ownedIntentClock);
    release(); await input.actions[0]; input.flush();
    assert.equal(input.intent(), otherIntent, "old cleanup cannot consume the new owner's actual input");
    assert.equal(h.calls.filter(call => call.url.includes("/items?")).length, 2);
  });
}

test("Codex normal40 browser targets an already positioned and painted native surface", async () => {
  const browserSource = fs.readFileSync(require.resolve("../scripts/codex-activity-browser-cases.mjs"), "utf8");
  const marker = browserSource.indexOf("window.historyWheelTimes = [];");
  // The wheel-initialization evaluate now also installs the owned diagnostic
  // recorder and takes one argument; the positioning setup follows its close.
  const close = "          }, !!diagnosticRequests);";
  const from = browserSource.indexOf(close, marker), end = browserSource.indexOf("let times = [];", from);
  assert.ok(marker >= 0 && from > marker && end > from);
  const setup = browserSource.slice(from + close.length, end);
  const list = { scrollTop: 1245 };
  let frames = 0, moves = 0;
  const pane = {
    locator() { return { boundingBox: async () => ({ x: 0, y: 0, width: 800, height: 600 }), first() { return this; }, elementHandle: async () => ({ owned: true }) }; },
    evaluate: fn => fn(),
  };
  await vm.runInNewContext("(async () => {" + setup + "})()", {
    fullBatch: true, pane, assert, URL, preview: { origin: "http://owned" },
    document: { querySelector: () => list },
    requestAnimationFrame: fn => { frames++; fn(); },
    page: { mouse: { async move() {
      assert.equal(list.scrollTop, 100, "native input must not target the previous bottom surface");
      assert.equal(frames, 2, "the new target must pass the real frame barrier before mouse movement");
      moves++;
    } }, waitForRequest: () => Promise.resolve() },
  });
  assert.equal(moves, 1);
});

for (const activity of ["untouched", "pointer", "focus", "window"]) {
  test(`native older keyboard focus lease ${activity}`, async () => {
    let release, requested;
    const pending = new Promise(resolve => { release = resolve; }), arrived = new Promise(resolve => { requested = resolve; });
    const h = harness(async url => {
      const kind = url.pathname.split("/").at(-1), cursor = url.searchParams.get("cursor");
      if (kind === "thread") return { thread: { id: "thread-a", status: { type: "idle" } } };
      if (kind === "turns") return page([]);
      if (cursor) { requested(); await pending; }
      return page(Array.from({ length: 40 }, (_, n) => entry("turn-a", `${cursor ? "older" : "latest"}-${n}`)), cursor ? "older-two" : "older-one");
    });
    await h.ctx.refreshCodexNativeSnapshot(h.connection, { initial: true });
    const button = h.ctx.codexNativeHistoryButton, doc = h.ctx.document;
    let disabled = false, restored = 0;
    Object.defineProperty(button, "disabled", { get: () => disabled, set: value => {
      disabled = value; if (value && doc.activeElement === button) doc.activeElement = doc.body;
    } });
    button.focus = options => { assert.equal(options.preventScroll, true); restored++; doc.activeElement = button; };
    doc.activeElement = button;
    const loading = h.ctx.loadOlderCodexNativeHistory(); await arrived;
    assert.equal(doc.activeElement, doc.body, "native disabled controls blur");
    if (activity === "pointer") h.documentInput("pointerdown");
    if (activity === "window") h.windowInput("blur");
    if (activity === "focus") { doc.activeElement = new Node("input"); h.documentInput("focusin", doc.activeElement); }
    release(); await loading;
    assert.equal(restored, activity === "untouched" ? 1 : 0);
    if (activity === "untouched") assert.equal(doc.activeElement, button);
    assert.equal([...h.documentEvents.values()].reduce((sum, listeners) => sum + listeners.size, 0), 0, "temporary focus listeners cleaned up");
  });
}

test("manual Codex older admission consumes shared scroll intent", async () => {
  const h = harness(url => {
    const kind = url.pathname.split("/").at(-1), cursor = url.searchParams.get("cursor");
    if (kind === "thread") return { thread: { id: "thread-a", status: { type: "idle" } } };
    if (kind === "turns") return page([]);
    return page(Array.from({ length: 40 }, (_, n) => entry("turn-a", `${cursor ? "older" : "latest"}-${n}`)), cursor ? "older-two" : "older-one");
  });
  await h.ctx.refreshCodexNativeSnapshot(h.connection, { initial: true });
  h.ctx.userScrollIntentUntil = 1800; // The explicit button's pointerdown/Enter.
  await h.ctx.loadOlderCodexNativeHistory();
  assert.equal(h.ctx.userScrollIntentUntil, 0, "the admitted action consumes intent before any prepend scroll");
  assert.equal(h.state.itemsCursor, "older-two"); assert.equal(h.state.hasMore, true);
  assert.equal(h.calls.filter(call => call.url.includes("/items?")).length, 2);
});

test("failed turn errors remain in their chronological turn and never duplicate across polls or a new failure", () => {
  const h = harness(() => ({}));
  const failed = id => ({ id, status: "failed", error: { message: `capacity ${id}`, codexErrorInfo: "serverOverloaded" } });
  h.state.turns = [failed("new"), failed("old")];
  h.state.entries = [entry("new", "n"), entry("old", "o")];
  h.state.hasMore = false;
  h.ctx.renderCodexNativeSnapshot(h.connection);
  assert.equal(h.messages.children.length, 4);
  assert.match(h.messages.children[1].textContent, /capacity old/);
  assert.match(h.messages.children[3].textContent, /capacity new/);
  h.ctx.renderCodexNativeSnapshot(h.connection);
  assert.equal(h.messages.children.length, 4);
  h.state.turns.unshift({ id: "empty", status: "failed", error: null });
  h.ctx.renderCodexNativeSnapshot(h.connection);
  assert.equal(h.messages.children.length, 5);
  assert.match(h.messages.children[4].textContent, /codexRecovery.unknownError/);
});

test("a snapshot requested before a new send cannot restore the previous failed state", async () => {
  let finish;
  const old = new Promise(resolve => { finish = resolve; });
  let reads = 0;
  const h = harness(async url => {
    if (url.pathname.endsWith("/thread")) {
      reads++;
      if (reads === 1) return old;
      return { thread: { id: "thread-a", status: { type: "active" } } };
    }
    return page([]);
  });
  const refresh = h.ctx.refreshCodexNativeSnapshot(h.connection);
  h.connection.nativeSendRevision = 1;
  finish({ thread: { id: "thread-a", status: { type: "systemError" } } });
  await refresh;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.state.thread.status.type, "active");
  assert.equal(reads, 2);
});

test("unequal turn/item pages retain every item, scoped IDs, native ordering and EOF", async () => {
  const h = harness(url => {
    const kind = url.pathname.split("/").at(-1), cursor = url.searchParams.get("cursor");
    if (kind === "thread") return { thread: { id: "thread-a", status: { type: "idle" } } };
    if (kind === "turns") return page([turn("new"), turn("old")]);
    if (!cursor) return page([entry("new", "same"), entry("old", "same")], "items-2");
    assert.equal(cursor, "items-2");
    return page([entry("old", "before"), entry("outside-turn-page", "first")]);
  });
  await h.ctx.refreshCodexNativeSnapshot(h.connection, { initial: true });
  assert.equal(h.contextCalls.length, 1, "a refreshed native snapshot reconciles adapter context usage");
  assert.equal(h.state.turnsCursor, null);
  await h.ctx.loadOlderCodexNativeHistory();
  assert.deepEqual(plain(h.state.entries).map(v => [v.turnId, v.item.id]), [
    ["new", "same"], ["old", "same"], ["old", "before"], ["outside-turn-page", "first"],
  ]);
  assert.equal(h.state.hasMore, false);
  assert.equal(h.calls.filter(v => v.url.includes("/turns?")).length, 1, "exhausted turns never refetch the first page");
  assert.equal(h.ctx.codexNativeHistoryButton, null);
  assert.deepEqual(h.messages.children.map(n => n.textContent), ["first", "before", "same", "same"]);
  const count = h.calls.length; await h.ctx.loadOlderCodexNativeHistory(); assert.equal(h.calls.length, count);
});

test("failed first/older pages keep their own retry cursor while successful streams advance", async () => {
  let attempts = 0;
  const h = harness(url => {
    const kind = url.pathname.split("/").at(-1);
    if (kind === "thread") return { thread: { status: { type: "idle" } } };
    if (kind === "turns") return page([]);
    attempts++;
    if (attempts === 1 || attempts === 3) throw new Error("offline");
    if (attempts === 2) { assert.equal(url.searchParams.has("cursor"), false); return page(messagesPage("latest"), "older"); }
    assert.equal(url.searchParams.get("cursor"), "older"); return page([entry("a", "first")]);
  });
  await h.ctx.refreshCodexNativeSnapshot(h.connection, { initial: true });
  assert.equal(h.state.itemsCursor, undefined); assert.equal(h.state.hasMore, true);
  assert.match(h.ctx.el.taskReplayNote.textContent, /offline/);
  await h.ctx.loadOlderCodexNativeHistory(); assert.equal(h.state.itemsCursor, "older");
  await h.ctx.loadOlderCodexNativeHistory(); assert.equal(h.state.itemsCursor, "older");
  assert.equal(h.state.entries.length, 40);
  await h.ctx.loadOlderCodexNativeHistory();
  assert.equal(h.state.itemsCursor, null); assert.equal(h.state.error, null);
  assert.equal(h.calls.filter(v => v.url.includes("/turns?")).length, 1);
});

test("repeated or cyclic cursors fail visibly without claiming EOF or applying their rows", () => {
  const h = harness(() => {});
  h.ctx.applyCodexNativeTranscriptPage(h.state, { turns: page([]), items: page([entry("a", "one")], "c1") });
  h.ctx.applyCodexNativeTranscriptPage(h.state, { items: page([entry("a", "two")], "c2") }, { older: true });
  for (const next of ["c2", "c1"]) {
    h.ctx.applyCodexNativeTranscriptPage(h.state, { items: page([entry("a", "bad")], next) }, { older: true });
    assert.match(h.state.error, /cursor_repeated/);
    assert.equal(h.state.itemsCursor, "c2"); assert.equal(h.state.entries.length, 2);
    assert.equal(h.state.hasMore, true);
  }
});

test("one Codex turn groups reasoning and tools ahead of its final answer", () => {
  const h = harness(() => {});
  const rows = [
    { turnId: "turn-a", item: { id: "answer", type: "agentMessage", text: "done" } },
    { turnId: "turn-a", item: { id: "edit", type: "fileChange", status: "completed", changes: [{ path: "/owned/app.js" }] } },
    { turnId: "turn-a", item: { id: "command", type: "commandExecution", status: "completed", command: "npm test", aggregatedOutput: "ok" } },
    { turnId: "turn-a", item: { id: "reason", type: "reasoning", summary: [{ text: "checking" }] } },
    { turnId: "turn-a", item: { id: "user", type: "userMessage", content: [{ type: "text", text: "fix it" }] } },
  ];
  const units = h.ctx.codexNativeRenderUnits(rows);
  assert.deepEqual(plain(units).map(unit => [unit.kind, unit.rows?.length || 0]), [
    ["message", 0], ["work", 3], ["message", 0],
  ]);
  assert.equal(units[1].key, "work:turn-a:reason");
});

test("polling preserves old pages and their cursors, updates same-length content and keeps unchanged nodes", async () => {
  let latest = "abcd";
  const h = harness(url => url.pathname.endsWith("/thread")
    ? { thread: { status: { type: "idle" } } }
    : url.pathname.endsWith("/turns") ? page([turn("a")])
    : page([entry("a", "latest", latest), ...Array.from({ length: 39 }, (_, i) => entry("a", `other-${i}`))], "current-tail"));
  await h.ctx.refreshCodexNativeSnapshot(h.connection, { initial: true });
  h.ctx.applyCodexNativeTranscriptPage(h.state, { items: page([entry("a", "older")], "older-tail") }, { older: true });
  h.ctx.renderCodexNativeSnapshot(h.connection);
  const olderNode = h.messages.children.find(n => n.textContent === "older");
  const latestNode = h.messages.children.find(n => n.textContent === "abcd");
  await h.ctx.refreshCodexNativeSnapshot(h.connection);
  assert.equal(h.messages.children.find(n => n.textContent === "abcd"), latestNode);
  latest = "wxyz"; await h.ctx.refreshCodexNativeSnapshot(h.connection);
  assert.equal(h.state.itemsCursor, "older-tail");
  assert.equal(h.messages.children.find(n => n.textContent === "older"), olderNode);
  assert(h.messages.textContent.includes("wxyz")); assert(!h.messages.textContent.includes("abcd"));
});

test("older page insertion and latest append preserve the visible message anchor", () => {
  const h = harness(() => {});
  h.ctx.applyCodexNativeTranscriptPage(h.state, { turns: page([]), items: page([
    entry("a", "4"), entry("a", "3"), entry("a", "2"), entry("a", "1"),
  ], "older") });
  h.ctx.renderCodexNativeSnapshot(h.connection);
  h.messages.scrollTop = 150;
  const anchor = h.messages.children.find(n => n.textContent === "1"), before = anchor.getBoundingClientRect().top;
  h.ctx.applyCodexNativeTranscriptPage(h.state, { items: page([entry("a", "0")], "even-older") }, { older: true });
  h.ctx.renderCodexNativeSnapshot(h.connection, { preserveScroll: true });
  assert.equal(anchor.getBoundingClientRect().top, before);
  const oldTop = h.messages.scrollTop;
  h.ctx.applyCodexNativeTranscriptPage(h.state, { items: page([entry("a", "5"), entry("a", "4")], "tail") });
  h.ctx.renderCodexNativeSnapshot(h.connection);
  assert.equal(h.messages.scrollTop, oldTop, "new work below must not move a reader above");
});

test("a burst beyond the latest page keeps the middle reachable and inserts it before retained older rows", () => {
  const h = harness(() => {});
  const items = ids => ids.map(id => entry("a", String(id)));
  h.ctx.applyCodexNativeTranscriptPage(h.state, { turns: page([]), items: page(items([3, 2, 1])) });
  h.ctx.applyCodexNativeTranscriptPage(h.state, { items: page(items([8, 7]), "gap-1") });
  h.ctx.renderCodexNativeSnapshot(h.connection);
  assert.equal(h.state.itemsCursor, "gap-1"); assert.equal(h.state.hasMore, true);
  assert.match(h.ctx.el.taskReplayNote.textContent, /historyGap/);
  h.ctx.applyCodexNativeTranscriptPage(h.state, { items: page(items([6, 5]), "gap-2") }, { older: true });
  assert.ok(h.state.itemGapKeys);
  // Another burst while filling the first gap must still reach the original tail.
  h.ctx.applyCodexNativeTranscriptPage(h.state, { items: page(items([11, 10]), "gap-3") });
  h.ctx.applyCodexNativeTranscriptPage(h.state, { items: page(items([9, 8, 7, 6, 5]), "gap-4") }, { older: true });
  assert.ok(h.state.itemGapKeys);
  h.ctx.applyCodexNativeTranscriptPage(h.state, { items: page(items([4, 3, 2, 1])) }, { older: true });
  h.ctx.renderCodexNativeSnapshot(h.connection);
  assert.equal(h.state.itemGapKeys, null); assert.equal(h.state.hasMore, false);
  assert.deepEqual(h.messages.children.map(n => n.textContent), Array.from({ length: 11 }, (_, i) => String(i + 1)));
  assert.equal(h.ctx.el.taskReplayNote.textContent, "");
});

test("poll/read-more are single-flight and switching hosts prevents follow-on requests and stale writes", async () => {
  let resolve;
  const h = harness(() => new Promise(done => { resolve = done; }));
  const request = h.ctx.refreshCodexNativeSnapshot(h.connection, { initial: true });
  await h.ctx.refreshCodexNativeSnapshot(h.connection);
  await h.ctx.loadOlderCodexNativeHistory();
  assert.equal(h.calls.length, 1);
  const initialNodes = [...h.messages.children];
  h.ctx.apiBase = "/r/another"; h.ctx.viewGeneration++; h.ctx.rpc = { nativeCodex: false };
  resolve({ thread: { id: "private-old-host" } }); await request;
  assert.equal(h.calls.length, 1, "no old thread ID is sent to the new host");
  assert.deepEqual(h.messages.children, initialNodes); assert.equal(h.notices.length, 0);
  assert.equal(h.state.entries.length, 0);
  assert.equal(h.connection.nativeRefreshInFlight, false);
});

test("aborting a history read prevents its next request even if the transport replies late", async () => {
  let resolve;
  const h = harness(() => new Promise(done => { resolve = done; }));
  const request = h.ctx.refreshCodexNativeSnapshot(h.connection, { initial: true });
  const initialNodes = [...h.messages.children];
  h.connection.nativeHistoryRequest.abort();
  resolve({ thread: { id: "late" } }); await request;
  assert.equal(h.calls.length, 1); assert.deepEqual(h.messages.children, initialNodes);
  assert.equal(h.state.entries.length, 0);
  assert.equal(h.calls[0].signal.aborted, true);
});

const tools = (prefix, count = 50, output = "ok") => Array.from({ length: count }, (_, i) => ({ turnId: "a",
  item: { id: `${prefix}-${i}`, type: "commandExecution", command: "synthetic only", aggregatedOutput: output, status: "completed" } }));
// Full readable pages isolate the retained focus/cursor regressions from the
// shared 40-unit continuation policy; partial-page tests stay partial below.
const messagesPage = prefix => Array.from({ length: 40 }, (_, i) => entry("a", `${prefix}-${i}`));
function readableHarness(items) {
  return harness(url => url.pathname.endsWith("/thread") ? { thread: { status: { type: "idle" } } }
    : url.pathname.endsWith("/turns") ? page([turn("a")], "turn-tail") : items(url.searchParams.get("cursor")));
}
test("readable history initial seeks messages through tools, renders first page early, and ordinary polls stay cheap", async () => {
  let finish;
  const waiting = new Promise(resolve => { finish = resolve; });
  const h = readableHarness(cursor => cursor === "older" ? waiting : page([entry("a", "latest"), ...tools("first", 49)], "older"));
  const request = h.ctx.refreshCodexNativeSnapshot(h.connection, { initial: true });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.calls.filter(call => call.url.includes("/items?")).length, 2);
  assert.equal(h.connection.nativeLoading, false, "composer ready before older continuation resolves");
  assert.ok(h.messages.textContent.includes("latest"));
  finish(page(messagesPage("older"), "tail")); await request;
  assert.equal(h.state.entries.length, 90); assert.equal(h.state.itemsCursor, "tail");
  assert.equal(h.state.turnsCursor, "turn-tail");
  const count = h.calls.length; await h.ctx.refreshCodexNativeSnapshot(h.connection);
  assert.equal(h.calls.length - count, 3, "poll only reads metadata, summaries and latest items");
  assert.equal(h.state.itemsCursor, "tail"); assert.equal(h.state.error, null);
});
test("readable history manual older seeks NEW messages not retained ones, keeps anchors and independent summaries", async () => {
  const h = readableHarness(cursor => cursor === "older" ? page(tools("work"), "messages") : page(messagesPage("earlier")));
  h.ctx.applyCodexNativeTranscriptPage(h.state, { turns: page([turn("a")], "summary"), items: page(messagesPage("retained"), "older") });
  h.ctx.renderCodexNativeSnapshot(h.connection); h.messages.scrollTop = 150;
  const anchor = h.messages.children[1], before = anchor.getBoundingClientRect().top;
  await h.ctx.loadOlderCodexNativeHistory();
  assert.equal(h.state.entries.length, 130); assert.equal(h.state.itemsCursor, null);
  assert.equal(h.state.turnsCursor, "turn-tail");
  assert.equal(h.calls.filter(call => call.url.includes("/turns?")).length, 1);
  assert.equal(anchor.getBoundingClientRect().top, before);
});
test("readable history all-tools and large pages have finite admission caps without false EOF", async () => {
  for (const large of [false, true]) {
    let reads = 0;
    const h = readableHarness(() => page(tools(`page-${++reads}`, 50, large ? "x".repeat(24000) : "ok"), `c${reads}`));
    await h.ctx.refreshCodexNativeSnapshot(h.connection, { initial: true });
    assert.equal(reads, large ? 1 : 8); assert.equal(h.state.entries.length, reads * 50);
    assert.equal(h.state.itemsCursor, `c${reads}`); assert.equal(h.state.hasMore, true); assert.equal(h.state.error, null);
  }
});
test("readable history continuation keeps successful rows on failure/cycle and leaves exact manual retry boundary", async () => {
  for (const failure of ["offline", "cycle", "invalid"]) {
    let reads = 0;
    const h = readableHarness(() => {
      reads++;
      if (reads === 1) return page(tools("first"), "c1");
      if (reads === 2) return page(tools("second"), "c2");
      if (failure === "offline") throw new Error("offline");
      return failure === "cycle" ? page([entry("a", "bad")], "c1") : page(tools("too-many", 51), null);
    });
    await h.ctx.refreshCodexNativeSnapshot(h.connection, { initial: true });
    assert.equal(reads, 3); assert.equal(h.state.entries.length, 100); assert.equal(h.state.itemsCursor, "c2");
    assert.match(h.state.error, /offline|cursor_repeated|page_invalid/);
    assert.equal(h.ctx.codexNativeHistoryButton.dataset.autoLoadPaused, "1");
    assert.equal(h.state.olderError, h.state.error); assert.equal(h.state.hasMore, true);
  }
});
test("readable history continuation abort, Host/view switch and send revision stop follow-ons and stale writes", async () => {
  for (const change of ["abort", "host", "view", "send"]) {
    let finish;
    const waiting = new Promise(resolve => { finish = resolve; });
    const h = readableHarness(cursor => cursor ? waiting : page(tools("first"), "c1"));
    const request = h.ctx.refreshCodexNativeSnapshot(h.connection, { initial: true });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(h.calls.filter(call => call.url.includes("/items?")).length, 2);
    if (change === "abort") h.connection.nativeHistoryRequest.abort();
    if (change === "host") h.ctx.apiBase = "/r/new";
    if (change === "view") { h.ctx.viewGeneration++; h.ctx.rpc = {}; }
    if (change === "send") h.connection.nativeSendRevision = 1;
    finish(page(tools("late"), "c2")); await request;
    if (change === "send") await new Promise(resolve => setImmediate(resolve));
    // A send schedules one cheap fresh snapshot; no stale continuation applies.
    if (change !== "send") assert.equal(h.calls.filter(call => call.url.includes("/items?")).length, 2);
    assert.equal(h.state.entries.some(row => row.item.id.startsWith("late")), false);
    assert.equal(h.state.itemsCursor, "c1"); assert.equal(h.connection.nativeRefreshInFlight, false);
  }
});

test("readable history latency admission stops after a slow successful first page", async () => {
  let now = 0, reads = 0;
  const h = readableHarness(() => { reads++; now = 1300; return page(tools("slow"), "older"); });
  h.ctx.Date = { now: () => now };
  await h.ctx.refreshCodexNativeSnapshot(h.connection, { initial: true });
  assert.equal(reads, 1); assert.equal(h.state.entries.length, 50); assert.equal(h.state.itemsCursor, "older");
});
test("readable history counts visible messages, not blank plans, collapsed work, duplicate rows or summary items", async () => {
  let reads = 0;
  const h = readableHarness(() => {
    reads++;
    return reads === 1 ? page([...messagesPage("same").slice(0, 7), entry("a", "blank", "  "),
      { turnId: "a", item: { id: "blank-plan", type: "plan", text: "" } }], "c1")
      : reads === 2 ? page(messagesPage("same").slice(0, 7), "c2") : page([entry("a", "eighth")]);
  });
  await h.ctx.refreshCodexNativeSnapshot(h.connection, { initial: true });
  assert.equal(reads, 3); assert.equal(h.ctx.codexNativeReadableKeys(h.state).size, 8);
  assert.equal(h.state.entries.length, 10); assert.equal(h.state.itemsCursor, null);
});
test("readable history manual partial failure pauses through polling and explicit retry starts at failed cursor only", async () => {
  let failed = false, retry = false;
  const cursors = [];
  const h = harness(url => {
    if (url.pathname.endsWith("/thread")) return { thread: { status: { type: "idle" } } };
    if (url.pathname.endsWith("/turns")) return page([]);
    const cursor = url.searchParams.get("cursor"); cursors.push(cursor);
    if (!cursor) return page(messagesPage("latest"), "older");
    if (cursor === "older") return page(tools("older-work"), "failed-page");
    if (!retry) { failed = true; throw new Error("offline"); }
    return page(messagesPage("earliest"));
  });
  await h.ctx.refreshCodexNativeSnapshot(h.connection, { initial: true });
  await h.ctx.loadOlderCodexNativeHistory();
  assert.equal(failed, true); assert.equal(h.state.entries.length, 90);
  assert.equal(h.state.itemsCursor, "failed-page"); assert.equal(h.state.olderError, "offline");
  const echo = new Node(); h.messages.appendChild(echo); echo.isConnected = true;
  h.connection.codexNativeEchoes = [{ node: echo, text: "pending send", knownKeys: new Set() }];
  await h.ctx.refreshCodexNativeSnapshot(h.connection);
  assert.equal(h.ctx.codexNativeHistoryButton.dataset.autoLoadPaused, "1");
  assert.equal(h.state.itemsCursor, "failed-page"); assert.equal(echo.parentNode, h.messages);
  retry = true; await h.ctx.loadOlderCodexNativeHistory();
  assert.deepEqual(cursors, [null, "older", "failed-page", null, "failed-page"]);
  assert.equal(h.state.entries.length, 130); assert.equal(h.state.error, null); assert.equal(h.state.hasMore, false);
  assert.equal(echo.parentNode, h.messages);
});

// The implicit disabled-button fallback is a mocked DOM boundary. Run the actual
// controller, captured focusin listener, render and finally for both root nodes.
for (const boundary of ["body", "html"]) {
  for (const activity of ["untouched", "explicit-input", "pointer", "key", "windowblur", "staleRPC", "generation", "base", "detached", "replaced", "alreadybutton", "disabledbutton"]) {
    test(`Codex actual older root-focus lease ${boundary}/${activity}`, async () => {
      let release, requested;
      const pending = new Promise(resolve => { release = resolve; });
      const arrived = new Promise(resolve => { requested = resolve; });
      const h = harness(async url => {
        const kind = url.pathname.split("/").at(-1), cursor = url.searchParams.get("cursor");
        if (kind === "thread") return { thread: { id: "thread-a", status: { type: "idle" } } };
        if (kind === "turns") return page([]);
        if (cursor) { requested(); await pending; }
        return page(Array.from({ length: 40 }, (_, n) => entry("turn-a", `${cursor ? "older" : "latest"}-${n}`)), cursor ? "older-two" : "older-one");
      });
      const doc = h.ctx.document;
      doc.documentElement = new Node("html");
      const root = boundary === "body" ? doc.body : doc.documentElement;
      await h.ctx.refreshCodexNativeSnapshot(h.connection, { initial: true });
      assert.equal(h.ctx.codexNativeReadableKeys(h.state).size, 40);
      assert.equal(h.state.entries.length, 40);
      assert.equal(h.state.itemsCursor, "older-one");
      assert.equal(h.state.turnsCursor, null);
      const button = h.ctx.codexNativeHistoryButton;
      let disabled = !!button.disabled, restored = 0, implicitFocusEvents = 0;
      Object.defineProperty(button, "disabled", { configurable: true, get: () => disabled, set: value => {
        disabled = value;
        if (value && doc.activeElement === button) {
          doc.activeElement = root;
          implicitFocusEvents++;
          h.documentInput("focusin", root);
        }
      } });
      button.focus = options => {
        assert.deepEqual(plain(options), { preventScroll: true });
        restored++;
        doc.activeElement = button;
      };
      doc.activeElement = button;
      const loading = h.ctx.loadOlderCodexNativeHistory();
      await arrived;
      assert.equal(implicitFocusEvents, 1, "disabled fallback dispatches to the captured real focusin listener");
      assert.equal(doc.activeElement, root);
      assert.equal(button.disabled, true);
      assert.equal(h.state.loading, true);
      assert.ok(h.connection.nativeHistoryRequest);
      assert.deepEqual(Object.fromEntries([...h.documentEvents].map(([type, listeners]) => [type, listeners.size])),
        { pointerdown: 1, keydown: 1, focusin: 1, "window:blur": 1 });
      let input;
      if (activity === "explicit-input") {
        input = new Node("input"); doc.activeElement = input; h.documentInput("focusin", input);
      }
      if (activity === "pointer") h.documentInput("pointerdown", root);
      if (activity === "key") h.documentInput("keydown", root);
      if (activity === "windowblur") h.windowInput("blur");
      if (activity === "staleRPC") h.ctx.rpc = { nativeCodex: true, nativeTranscriptState: h.ctx.createCodexNativeTranscriptState() };
      if (activity === "generation") h.ctx.viewGeneration++;
      if (activity === "base") h.ctx.apiBase = "/r/another-owned-view";
      // Mutate the external owner only after the actual final re-enable. Do not
      // replace the controller's render/finally or any focus/ownership predicate.
      let ownerMutations = 0, replacement;
      if (["detached", "replaced", "alreadybutton", "disabledbutton"].includes(activity)) {
        const show = h.ctx.showCodexNativeHistoryButton;
        h.ctx.showCodexNativeHistoryButton = (...args) => {
          const result = show(...args);
          if (!h.state.loading) {
            ownerMutations++;
            if (activity === "detached") button.remove();
            if (activity === "replaced") {
              replacement = new Node("button"); replacement.disabled = false;
              button.replaceWith(replacement); h.ctx.codexNativeHistoryButton = replacement;
            }
            if (activity === "alreadybutton") { doc.activeElement = button; h.documentInput("focusin", button); }
            if (activity === "disabledbutton") button.disabled = true;
          }
          return result;
        };
      }
      release();
      await loading;
      const stale = ["staleRPC", "generation", "base"].includes(activity);
      assert.equal(restored, activity === "untouched" ? 1 : 0, "only an untouched implicit root lease restores focus");
      assert.equal(doc.activeElement, activity === "untouched" || activity === "alreadybutton" ? button : input || root,
        "cleanup never steals focus from an input or foreign/revoked owner");
      assert.equal(h.ctx.codexNativeReadableKeys(h.state).size, stale ? 40 : 80);
      assert.equal(h.state.entries.length, stale ? 40 : 80);
      assert.equal(h.state.itemsCursor, stale ? "older-one" : "older-two");
      assert.equal(h.state.turnsCursor, null);
      assert.equal(h.state.loading, false);
      assert.equal(h.connection.nativeHistoryRequest, null);
      assert.equal([...h.documentEvents.values()].reduce((sum, listeners) => sum + listeners.size, 0), 0);
      const itemCalls = h.calls.filter(call => call.url.includes("/items?"));
      assert.equal(itemCalls.length, 2, "no cascade beyond the one admitted batch");
      assert.deepEqual(itemCalls.map(call => new URL(call.url, "http://owned").searchParams.get("cursor")), [null, "older-one"]);
      assert.equal(h.calls.length, 4);
      assert.deepEqual(h.notices, []);
      assert.ok(!h.state.error);
      assert.equal(ownerMutations, ["detached", "replaced", "alreadybutton", "disabledbutton"].includes(activity) ? 1 : 0);
      if (activity === "detached") assert.equal(button.parentNode, null);
      if (activity === "replaced") { assert.equal(button.parentNode, null); assert.equal(h.ctx.codexNativeHistoryButton, replacement); assert.equal(replacement.parentNode, h.messages); }
      if (activity === "disabledbutton") assert.equal(button.disabled, true);
    });
  }
}

// MOCKED diagnostic contracts: execute the actual owned fixture callbacks, not
// copies of recorder logic. These tests do not establish browser chronology.
// A Windows checkout may hold CRLF; the markers below span lines, so compare LF.
const focusDiagnosticSource = fs.readFileSync(require.resolve("../scripts/codex-activity-browser-cases.mjs"), "utf8").replace(/\r\n/g, "\n");
function diagnosticRegion(start, end) {
  assert.equal(focusDiagnosticSource.split(start).length, 2, `unique start: ${start}`);
  assert.equal(focusDiagnosticSource.split(end).length, 2, `unique end: ${end}`);
  const a = focusDiagnosticSource.indexOf(start), b = focusDiagnosticSource.indexOf(end, a + start.length);
  assert.ok(b > a);
  return focusDiagnosticSource.slice(a + start.length, b);
}
const diagnosticHelpers = diagnosticRegion("// BEGIN Codex readable diagnostic helpers", "// END Codex readable diagnostic helpers");
const diagnosticInstallCallback = "manual => {" + diagnosticRegion("await pane.evaluate(manual => {", "}, !!diagnosticRequests);") + "}";
const diagnosticSelectedCallback = diagnosticRegion("else assert.equal(await pane.waitForFunction(", ").then(() => true, () => false), true, \"explicit keyboard retry keeps its button focus\");");
const diagnosticRangeCallback = diagnosticRegion("const range = await pane.evaluate(", ");\n          if (fullBatch)");
const diagnosticFailureBoundary = "catch (error) {" + diagnosticRegion("      } catch (error) {\n        if (diagnosticRequests)", "\n    }\n  }\n}").replace(/^/, "\n        if (diagnosticRequests)");

function diagnosticHarness({ unavailableParent = false, listenerFailure = false } = {}) {
  const listeners = [], mutations = [];
  let clock = 0;
  function target(tagName) {
    const node = { tagName, isConnected: true, hidden: false, parentNode: null,
      getAttribute(name) { assert.equal(name, "aria-hidden"); return null; },
      addEventListener(type, fn, options) {
        if (listenerFailure && type !== "wheel") throw new Error("mock listener unavailable");
        listeners.push({ target: node, type, fn, options });
      },
      focus() { mutations.push("focus"); }, setAttribute() { mutations.push("attribute"); },
    };
    for (const key of ["textContent", "innerText", "innerHTML", "value", "ariaLabel"]) {
      Object.defineProperty(node, key, { get() { throw new Error(`private read: ${key}`); }, set() { mutations.push(key); } });
    }
    return node;
  }
  function doc() {
    const d = target(), nodes = { ".history-load-button": target("BUTTON"), "#input": target("TEXTAREA"),
      "#workspace-search": target("INPUT"), "#messages": target("DIV") };
    nodes["#messages .history-load-button"] = nodes[".history-load-button"];
    d.body = target("BODY"); d.documentElement = target("HTML"); d.activeElement = d.body;
    d.hasFocus = () => true; d.visibilityState = "visible";
    d.querySelector = selector => { assert.ok(Object.hasOwn(nodes, selector)); return nodes[selector]; };
    nodes[".history-load-button"].parentNode = nodes["#messages"]; nodes[".history-load-button"].disabled = false;
    nodes["#messages"].scrollTop = 17; nodes["#messages"].scrollHeight = 800; nodes["#messages"].clientHeight = 300;
    return { d, nodes };
  }
  const pane = doc(), parent = doc(), win = target(), parentWin = target(), frame = target("IFRAME");
  frame.ownerDocument = parent.d; win.frameElement = frame; win.parent = parentWin; parentWin.document = parent.d;
  if (unavailableParent) Object.defineProperty(win, "parent", { get() { throw new Error("mock cross origin"); } });
  parent.d.activeElement = frame;
  const connection = Object.freeze({ nativeTranscriptState: Object.freeze({ loading: false }), nativeRefreshInFlight: false, nativeHistoryRequest: {} });
  const ctx = vm.createContext({ window: win, document: pane.d, rpc: connection, viewGeneration: 7,
    apiBase: "/private/base-secret", codexNativeHistoryButton: pane.nodes[".history-load-button"],
    performance: { now: () => ++clock } });
  const compile = code => vm.compileFunction(`return (${code});`, [], { parsingContext: ctx })();
  const install = compile(diagnosticInstallCallback);
  install(true);
  const recorder = win.__codexReadableFocusDiagnostic;
  function fire(on, type, extra = {}) {
    const event = { type, target: pane.nodes[".history-load-button"], relatedTarget: null, eventPhase: 1, isTrusted: true,
      preventDefault() { mutations.push("default"); }, stopPropagation() { mutations.push("propagation"); }, ...extra };
    for (const listener of listeners.filter(l => l.target === on && l.type === type)) listener.fn(event);
    return event;
  }
  return { ctx, compile, install, recorder, listeners, mutations, pane, parent, win, parentWin, frame, connection, fire };
}
function diagnosticNodeHelpers({ timeout = false, emitFailure = false } = {}) {
  const logs = [], timers = [], cleared = [];
  const ctx = vm.createContext({ performance: { now: () => 12 }, console: { error(line) { logs.push(line); if (emitFailure) throw new Error("mock log failure"); } },
    setTimeout(fn, ms) { timers.push({ fn, ms }); if (timeout) queueMicrotask(fn); return timers.length; },
    clearTimeout(id) { cleared.push(id); } });
  const helpers = vm.compileFunction(diagnosticHelpers + "\nreturn { createCodexReadableRequestDiagnostic, rethrowCodexReadableDiagnostic };", [], { parsingContext: ctx })();
  return { ...helpers, logs, timers, cleared };
}

test("Codex readable focus diagnostic: stable opaque references, parent/frame relation and external identities", () => {
  const h = diagnosticHarness(), button = h.pane.nodes[".history-load-button"];
  h.pane.d.activeElement = button;
  h.fire(h.pane.d, "click"); h.fire(h.parent.d, "focusout", { target: h.frame, relatedTarget: h.parent.nodes["#workspace-search"] });
  const trace = plain(h.recorder.read()), [click, out] = trace.events;
  assert.equal(trace.inconclusive, false); assert.equal(click.snapshot.parent.ownsFrame, true);
  assert.equal(click.target.id, click.snapshot.pane.active.id); assert.equal(click.target.id, click.snapshot.button.owner.id);
  assert.notEqual(click.target.id, out.target.id); assert.equal(out.target.category, "owned-frame");
  assert.equal(out.relatedTarget.category, "workspace-search");
  assert.equal(click.snapshot.rpcId, out.snapshot.rpcId); assert.equal(click.snapshot.apiBaseId, out.snapshot.apiBaseId);
  assert.equal(click.snapshot.viewGeneration, 7); assert.equal(click.snapshot.frame.attached, true);
  assert.equal(click.snapshot.frame.hidden, false); assert.equal(click.snapshot.frame.ariaHidden, false);
  assert.equal(click.snapshot.button.enabled, true); assert.equal(click.snapshot.button.inMessages, true);
  assert.equal(click.snapshot.parent.hasFocus, true); assert.equal(click.snapshot.pane.visibility, "visible");
  h.parent.d.activeElement = h.parent.nodes["#workspace-search"]; h.frame.isConnected = false; h.frame.hidden = true;
  h.recorder.checkpoint("settled");
  const changed = h.recorder.read().checkpoints.settled.snapshot;
  assert.equal(changed.parent.ownsFrame, false); assert.equal(changed.frame.attached, false); assert.equal(changed.frame.hidden, true);
  assert.deepEqual(h.mutations, []); assert.equal(h.ctx.rpc, h.connection);
});

test("Codex readable focus diagnostic: capture/passive document listeners and only noncapturing window blur/focus", () => {
  const h = diagnosticHarness();
  for (const boundary of [h.pane.d, h.parent.d]) {
    const listeners = h.listeners.filter(l => l.target === boundary);
    assert.deepEqual(listeners.map(l => l.type), ["pointerdown", "keydown", "keyup", "click", "focusin", "focusout"]);
    for (const l of listeners) assert.deepEqual(plain(l.options), { capture: true, passive: true });
  }
  for (const boundary of [h.win, h.parentWin]) {
    const listeners = h.listeners.filter(l => l.target === boundary);
    assert.deepEqual(listeners.map(l => l.type), ["blur", "focus"]);
    for (const l of listeners) assert.deepEqual(plain(l.options), { capture: false, passive: true });
    h.fire(boundary, "blur"); // An element blur must not be labelled window blur.
    assert.equal(h.recorder.read().events.length, boundary === h.win ? 0 : 1);
    h.fire(boundary, "blur", { target: boundary });
  }
  assert.deepEqual(plain(h.recorder.read()).events.map(e => e.scope), ["pane-window", "parent-window"]);
  assert.deepEqual(h.mutations, []);
});

test("Codex readable focus diagnostic: single pane ordering, Enter/Space classification and private-key redaction", () => {
  const h = diagnosticHarness();
  for (const [key, expected] of [["Enter", "Enter"], [" ", "Space"], ["secret-typed-key", "other"]]) {
    const event = h.fire(h.pane.d, "keydown", { key, repeat: true, ctrlKey: true, timeStamp: -900 });
    assert.equal(h.recorder.read().events.at(-1).keyClass, expected);
    assert.equal(event.key, key);
  }
  h.fire(h.parent.d, "keyup", { key: "Enter", timeStamp: 999999 });
  h.fire(h.pane.d, "pointerdown"); h.fire(h.pane.d, "focusin");
  const trace = plain(h.recorder.read());
  assert.deepEqual(trace.events.map(e => e.sequence), [2, 3, 4, 5, 6, 7]);
  assert.deepEqual(trace.events.map(e => e.paneMonotonicMs), [2, 3, 4, 5, 6, 7]);
  assert.equal(trace.events[0].repeat, true); assert.equal(trace.events[0].ctrl, true); assert.equal(trace.events[0].shift, false);
  assert.equal(trace.events[0].phase, 1); assert.equal(trace.events[0].isTrusted, true);
  const serialized = JSON.stringify(trace);
  for (const secret of ["secret-typed-key", "/private/base-secret", "timeStamp", "textContent", "ariaLabel"]) assert.equal(serialized.includes(secret), false);
  assert.deepEqual(h.mutations, []);
});

test("Codex readable focus diagnostic: unavailable parent, failed collection and bounded overflow are inconclusive", () => {
  const h = diagnosticHarness({ unavailableParent: true });
  for (let n = 0; n < 131; n++) h.fire(h.pane.d, "click");
  h.recorder.checkpoint("settled"); h.recorder.checkpoint("selected", h.pane.nodes[".history-load-button"]);
  h.recorder.checkpoint("not-a-retained-name");
  const trace = plain(h.recorder.read());
  assert.equal(trace.events.length, 128); assert.equal(trace.overflowCount, 3); assert.equal(trace.truncated, true);
  assert.equal(trace.parentUnavailable, true); assert.equal(trace.inconclusive, true); assert.equal(trace.events[0].snapshot.parent, null);
  assert.deepEqual(Object.keys(trace.checkpoints), ["installed", "settled", "selected"]);
  assert.equal(trace.checkpoints.selected.sequence, 134);
  const broken = diagnosticHarness({ listenerFailure: true }).recorder.read();
  assert.equal(broken.collectionErrors, 1); assert.equal(broken.inconclusive, true);
  const failing = diagnosticHarness(); failing.pane.d.hasFocus = () => { throw new Error("private failure text"); };
  failing.fire(failing.pane.d, "click"); failing.recorder.checkpoint("settled");
  assert.equal(failing.recorder.read().collectionErrors, 2);
  assert.equal(JSON.stringify(failing.recorder.read()).includes("private failure text"), false);
  const identities = diagnosticHarness();
  for (let n = 0; n < 34; n++) { identities.ctx.apiBase = `private-${n}`; identities.fire(identities.pane.d, "click"); }
  assert.equal(identities.recorder.read().identityTruncated, true); assert.equal(identities.recorder.read().inconclusive, true);
});

test("Codex readable focus diagnostic: latest/null cursor versus older request metadata, bounds and loading/refresh witnesses", () => {
  const helpers = diagnosticNodeHelpers(), requests = helpers.createCodexReadableRequestDiagnostic();
  for (const path of ["/unrelated?token=private-token", "/api/codex/items", "/api/codex/turns?cursor=private-cursor", "/api/codex/items?cursor=private-cursor", "/api/codex/items?cursor="]) {
    requests.record(new URL(path, "http://owned.invalid"));
  }
  let trace = plain(requests.read());
  assert.equal(trace.count, 4); assert.deepEqual(trace.events.map(e => e.kind), ["latest", "older", "older", "latest"]);
  assert.deepEqual(trace.events.map(e => e.cursorPresent), [false, true, true, true]);
  assert.deepEqual(trace.events.map(e => e.cursorKind), ["absent", "opaque", "opaque", "empty"]);
  assert.equal(trace.events[0].cursorId, null); assert.equal(trace.events[1].cursorId, trace.events[2].cursorId);
  assert.deepEqual(trace.events.map(e => e.endpoint), ["items", "turns", "items", "items"]);
  assert.match(trace.clock, /NOT pane order/); assert.equal(JSON.stringify(trace).includes("private-"), false);
  for (let n = 0; n < 62; n++) requests.record(new URL("http://owned.invalid/api/codex/items"));
  requests.record({ get pathname() { throw new Error("private-error"); } });
  trace = plain(requests.read()); assert.equal(trace.events.length, 64); assert.equal(trace.overflowCount, 2);
  assert.equal(trace.collectionErrors, 1); assert.equal(trace.truncated, true); assert.equal(trace.inconclusive, true);
  const h = diagnosticHarness();
  h.ctx.rpc = { nativeTranscriptState: { loading: true }, nativeRefreshInFlight: false, nativeHistoryRequest: {} };
  h.fire(h.pane.d, "click");
  h.ctx.rpc.nativeTranscriptState.loading = false; h.ctx.rpc.nativeRefreshInFlight = true; h.ctx.rpc.nativeHistoryRequest = {};
  h.fire(h.pane.d, "click");
  const [older, refresh] = plain(h.recorder.read()).events.map(e => e.snapshot);
  assert.equal(older.loading, true); assert.equal(older.nativeRefreshInFlight, false);
  assert.equal(refresh.loading, false); assert.equal(refresh.nativeRefreshInFlight, true);
  assert.notEqual(older.requestControllerId, refresh.requestControllerId);
  assert.equal(older.rpcId, refresh.rpcId);
});

test("Codex readable focus diagnostic: actual settlement/selected callbacks keep range and strict boolean unchanged", () => {
  const h = diagnosticHarness(), button = h.pane.nodes[".history-load-button"];
  assert.deepEqual(plain(h.compile(diagnosticRangeCallback)()), { top: 17, max: 500 });
  const selected = h.compile(diagnosticSelectedCallback);
  assert.equal(selected(button), false);
  h.pane.d.activeElement = button; assert.equal(selected(button), true);
  // Idle contract: a focused button is not settled while an ordinary refresh or
  // an older read is in flight, or while it is disabled.
  const idle = h.ctx.rpc;
  h.ctx.rpc = { nativeTranscriptState: { loading: false }, nativeRefreshInFlight: true, nativeHistoryRequest: {} }; assert.equal(selected(button), false);
  h.ctx.rpc = { nativeTranscriptState: { loading: true }, nativeRefreshInFlight: false, nativeHistoryRequest: {} }; assert.equal(selected(button), false);
  h.ctx.rpc = idle; button.disabled = true; assert.equal(selected(button), false);
  button.disabled = false; assert.equal(selected(button), true);
  const trace = plain(h.recorder.read());
  assert.equal(trace.checkpoints.selected.snapshot.selected.id, trace.checkpoints.selected.snapshot.button.owner.id);
  assert.equal(trace.checkpoints.selected.snapshot.selected.id, trace.checkpoints.selected.snapshot.pane.active.id);
  assert.deepEqual(h.mutations, []);
  delete h.win.__codexReadableFocusDiagnostic;
  h.install(false); assert.equal(h.win.__codexReadableFocusDiagnostic, undefined);
  assert.equal(selected(button), true); assert.deepEqual(plain(h.compile(diagnosticRangeCallback)()), { top: 17, max: 500 });
  assert.equal(h.win.historyWheelTimes.length, 0);
  h.fire(h.pane.nodes["#messages"], "wheel"); assert.equal(h.win.historyWheelTimes.length, 2); // Two actual installations, unchanged wheel observer.
});

test("Codex readable focus diagnostic: failure-only JSON escaping, original error identity and actual cleanup boundary", async () => {
  for (const outcome of ["success", "reject", "throw", "timeout", "emit-failure", "nonmanual"]) {
    const helpers = diagnosticNodeHelpers({ timeout: outcome === "timeout", emitFailure: outcome === "emit-failure" });
    const original = new Error("original assertion"), cleanup = [], requests = helpers.createCodexReadableRequestDiagnostic();
    const collect = () => {
      if (outcome === "reject") return Promise.reject(new Error("private-collection-error"));
      if (outcome === "throw") throw new Error("private-collection-error");
      if (outcome === "timeout") return new Promise(() => {});
      return { safe: "line\n\u001b\"\\", inconclusive: false };
    };
    const boundary = vm.compileFunction("return (async () => { try { throw original; } " + diagnosticFailureBoundary + "})();",
      ["original", "diagnosticRequests", "rethrowCodexReadableDiagnostic", "diagnosticPane", "mode", "viewport", "reduced", "releasePage", "context", "preview"]);
    await assert.rejects(boundary(original, outcome === "nonmanual" ? null : requests, helpers.rethrowCodexReadableDiagnostic,
      { evaluate: collect }, "manual", { width: 1440, height: 1000 }, false, () => cleanup.push("release"),
      { close: async () => { cleanup.push("context"); } }, { close: async () => { cleanup.push("preview"); } }), e => e === original);
    assert.deepEqual(cleanup, ["release", "context", "preview"]);
    if (outcome === "nonmanual") { assert.equal(helpers.logs.length, 0); assert.equal(helpers.timers.length, 0); continue; }
    assert.equal(helpers.logs.length, 1); assert.equal(helpers.logs[0].includes("\n"), false); assert.equal(helpers.logs[0].includes("\u001b"), false);
    assert.equal(helpers.logs[0].includes("private-collection-error"), false);
    const report = JSON.parse(helpers.logs[0]);
    assert.equal(report.browser.status, outcome === "timeout" ? "collection-timeout" : ["reject", "throw"].includes(outcome) ? "collection-failed" : "collected");
    assert.equal(report.controllerLocals, "UNKNOWN"); assert.equal(report.historicalLinuxCause, "UNKNOWN");
    assert.equal(helpers.timers[0].ms, 750); assert.deepEqual(helpers.cleared, [1]);
  }
  // Even a context-close failure reaches the original nested preview finally.
  const helpers = diagnosticNodeHelpers(), original = new Error("assertion"), closeError = new Error("close"), cleanup = [];
  const boundary = vm.compileFunction("return (async () => { try { throw original; } " + diagnosticFailureBoundary + "})();",
    ["original", "diagnosticRequests", "rethrowCodexReadableDiagnostic", "diagnosticPane", "mode", "viewport", "reduced", "releasePage", "context", "preview"]);
  await assert.rejects(boundary(original, null, helpers.rethrowCodexReadableDiagnostic, null, "burst", {}, false,
    () => cleanup.push("release"), { close: async () => { cleanup.push("context"); throw closeError; } },
    { close: async () => { cleanup.push("preview"); } }), e => e === closeError);
  assert.deepEqual(cleanup, ["release", "context", "preview"]);
});

// The ordinary latest-page poll disables the same button through
// nativeRefreshInFlight. Exercise the ACTUAL refresh controller with the same
// mocked disabled-button fallback and captured real focusin listener as the
// older-page lease above. The second latest read is held to observe flight.
function heldRefreshFocus(boundary, { reject = false } = {}) {
  let release, requested, threadReads = 0, latestReads = 0;
  const pending = new Promise(resolve => { release = resolve; });
  const arrived = new Promise(resolve => { requested = resolve; });
  const h = harness(async url => {
    const kind = url.pathname.split("/").at(-1), cursor = url.searchParams.get("cursor");
    if (kind === "thread") {
      if (reject && ++threadReads === 2) { requested(); await pending; throw new Error("offline"); }
      return { thread: { id: "thread-a", status: { type: "idle" } } };
    }
    if (kind === "turns") return page([]);
    assert.equal(cursor, null, "a poll refresh only reads the latest page");
    if (++latestReads === 2) { requested(); await pending; }
    return page(Array.from({ length: 40 }, (_, n) => entry("turn-a", `latest-${n}`)), "older-one");
  });
  const doc = h.ctx.document;
  doc.documentElement = new Node("html");
  const root = boundary === "body" ? doc.body : doc.documentElement;
  return { h, doc, root, arrived, release };
}

function leaseRefreshButton(h, doc, root) {
  const button = h.ctx.codexNativeHistoryButton;
  assert.ok(button, "the initial refresh produced the history button");
  let disabled = !!button.disabled, restored = 0, implicitFocusEvents = 0;
  Object.defineProperty(button, "disabled", { configurable: true, get: () => disabled, set: value => {
    disabled = value;
    if (value && doc.activeElement === button) {
      doc.activeElement = root;
      implicitFocusEvents++;
      h.documentInput("focusin", root);
    }
  } });
  button.focus = options => {
    assert.deepEqual(plain(options), { preventScroll: true });
    restored++;
    doc.activeElement = button;
  };
  return { button, restored: () => restored, implicitFocusEvents: () => implicitFocusEvents };
}

const listenerCounts = h => Object.fromEntries([...h.documentEvents].map(([type, listeners]) => [type, listeners.size]));
const listenerTotal = h => [...h.documentEvents.values()].reduce((sum, listeners) => sum + listeners.size, 0);

for (const boundary of ["body", "html"]) {
  for (const activity of ["untouched", "explicit-input", "pointer", "key", "windowblur", "staleRPC", "generation", "base", "detached", "replaced", "alreadybutton", "disabledbutton"]) {
    test(`Codex refresh focus lease: actual poll refresh ${boundary}/${activity}`, async () => {
      const { h, doc, root, arrived, release } = heldRefreshFocus(boundary);
      await h.ctx.refreshCodexNativeSnapshot(h.connection, { initial: true });
      assert.equal(h.ctx.codexNativeReadableKeys(h.state).size, 40);
      assert.equal(h.state.itemsCursor, "older-one");
      assert.equal(h.documentEvents.size, 0, "the initial refresh with no button installs no lease listeners");
      const lease = leaseRefreshButton(h, doc, root), button = lease.button;
      h.ctx.userScrollIntentUntil = 1800; // Pending reading input is not a refresh's to consume.
      doc.activeElement = button;
      const refreshing = h.ctx.refreshCodexNativeSnapshot(h.connection);
      await arrived;
      assert.equal(lease.implicitFocusEvents(), 1, "disabled fallback dispatches to the captured real focusin listener");
      assert.equal(doc.activeElement, root);
      assert.equal(button.disabled, true);
      assert.equal(h.connection.nativeRefreshInFlight, true);
      assert.equal(h.state.loading, false);
      assert.ok(h.connection.nativeHistoryRequest);
      assert.deepEqual(listenerCounts(h), { pointerdown: 1, keydown: 1, focusin: 1, "window:blur": 1 });
      let input;
      if (activity === "explicit-input") {
        input = new Node("input"); doc.activeElement = input; h.documentInput("focusin", input);
      }
      if (activity === "pointer") h.documentInput("pointerdown", root);
      if (activity === "key") h.documentInput("keydown", root);
      if (activity === "windowblur") h.windowInput("blur");
      if (activity === "staleRPC") h.ctx.rpc = { nativeCodex: true, nativeTranscriptState: h.ctx.createCodexNativeTranscriptState() };
      if (activity === "generation") h.ctx.viewGeneration++;
      if (activity === "base") h.ctx.apiBase = "/r/another-owned-view";
      // Mutate the external owner only after the actual final re-enable. Do not
      // replace the controller's render/finally or any focus/ownership predicate.
      const mutated = ["detached", "replaced", "alreadybutton", "disabledbutton"].includes(activity);
      let ownerMutations = 0, replacement;
      if (mutated) {
        const show = h.ctx.showCodexNativeHistoryButton;
        h.ctx.showCodexNativeHistoryButton = (...args) => {
          const result = show(...args);
          if (!h.connection.nativeRefreshInFlight) {
            ownerMutations++;
            if (activity === "detached") button.remove();
            if (activity === "replaced") {
              replacement = new Node("button"); replacement.disabled = false;
              button.replaceWith(replacement); h.ctx.codexNativeHistoryButton = replacement;
            }
            if (activity === "alreadybutton") { doc.activeElement = button; h.documentInput("focusin", button); }
            if (activity === "disabledbutton") button.disabled = true;
          }
          return result;
        };
      }
      release();
      await refreshing;
      const stale = ["staleRPC", "generation", "base"].includes(activity);
      assert.equal(lease.restored(), activity === "untouched" ? 1 : 0, "only an untouched implicit root lease restores focus");
      assert.equal(doc.activeElement, activity === "untouched" || activity === "alreadybutton" ? button : input || root,
        "settlement never steals focus from an input or foreign/revoked owner");
      assert.equal(h.ctx.codexNativeReadableKeys(h.state).size, 40, "the latest page refreshes the same forty keys");
      assert.equal(h.state.entries.length, 40);
      assert.equal(h.state.itemsCursor, "older-one");
      assert.equal(h.state.turnsCursor, null);
      assert.equal(h.state.hasMore, true);
      assert.equal(h.state.loading, false);
      assert.equal(h.connection.nativeRefreshInFlight, false);
      assert.equal(h.connection.nativeHistoryRequest, null);
      assert.equal(listenerTotal(h), 0, "temporary focus listeners are always removed");
      assert.equal(h.contextCalls.length, stale ? 1 : 2, "a stale completion still writes nothing");
      assert.equal(!!h.connection.connectionLost, false);
      assert.equal(h.ctx.userScrollIntentUntil, 1800, "a poll refresh is not a reading action");
      const itemCalls = h.calls.filter(call => call.url.includes("/items?"));
      assert.deepEqual(itemCalls.map(call => new URL(call.url, "http://owned").searchParams.get("cursor")), [null, null],
        "no items reads beyond the two latest pages");
      assert.equal(h.calls.length, 6);
      assert.deepEqual(h.notices, []);
      assert.ok(!h.state.error);
      assert.equal(ownerMutations, mutated ? 1 : 0);
      if (activity === "detached") assert.equal(button.parentNode, null);
      if (activity === "replaced") { assert.equal(button.parentNode, null); assert.equal(h.ctx.codexNativeHistoryButton, replacement); assert.equal(replacement.parentNode, h.messages); }
      if (activity === "disabledbutton") assert.equal(button.disabled, true);
      else if (!stale) assert.equal(button.disabled, false, "settlement re-enables the button");
    });
  }
}

for (const boundary of ["body", "html"]) {
  test(`Codex refresh focus lease: unfocused button installs no lease ${boundary}`, async () => {
    const { h, doc, root, arrived, release } = heldRefreshFocus(boundary);
    await h.ctx.refreshCodexNativeSnapshot(h.connection, { initial: true });
    const lease = leaseRefreshButton(h, doc, root), button = lease.button;
    doc.activeElement = root;
    const refreshing = h.ctx.refreshCodexNativeSnapshot(h.connection);
    await arrived;
    assert.equal(button.disabled, true);
    assert.equal(h.connection.nativeRefreshInFlight, true);
    assert.equal(h.documentEvents.size, 0, "no lease listeners at any time without a focused button");
    assert.equal(lease.implicitFocusEvents(), 0);
    release();
    await refreshing;
    assert.equal(h.documentEvents.size, 0);
    assert.equal(lease.restored(), 0);
    assert.equal(doc.activeElement, root);
    assert.equal(button.disabled, false);
    assert.equal(h.connection.nativeRefreshInFlight, false);
    assert.equal(h.connection.nativeHistoryRequest, null);
    assert.equal(h.ctx.codexNativeReadableKeys(h.state).size, 40);
    assert.equal(h.calls.length, 6);
  });
}

test("Codex refresh focus lease: initial refresh before the button exists installs no lease", async () => {
  let release, requested, focusCalls = 0;
  const pending = new Promise(resolve => { release = resolve; });
  const arrived = new Promise(resolve => { requested = resolve; });
  const h = harness(async url => {
    const kind = url.pathname.split("/").at(-1);
    if (kind === "thread") return { thread: { id: "thread-a", status: { type: "idle" } } };
    if (kind === "turns") return page([]);
    requested(); await pending;
    return page(Array.from({ length: 40 }, (_, n) => entry("turn-a", `latest-${n}`)), "older-one");
  });
  const doc = h.ctx.document;
  doc.documentElement = new Node("html");
  const createElement = doc.createElement;
  doc.createElement = tag => { const node = createElement(tag); if (tag === "button") node.focus = () => { focusCalls++; }; return node; };
  assert.equal(h.ctx.codexNativeHistoryButton, null);
  const initial = h.ctx.refreshCodexNativeSnapshot(h.connection, { initial: true });
  await arrived;
  const button = h.ctx.codexNativeHistoryButton;
  assert.ok(button, "the first refresh creates the disabled button while in flight");
  assert.equal(button.disabled, true);
  assert.equal(h.documentEvents.size, 0);
  assert.equal(doc.activeElement, doc.body);
  release();
  await initial;
  assert.equal(focusCalls, 0);
  assert.equal(h.documentEvents.size, 0);
  assert.equal(button.disabled, false);
  assert.equal(doc.activeElement, doc.body);
  assert.equal(h.ctx.codexNativeReadableKeys(h.state).size, 40);
  assert.equal(h.calls.length, 3);
});

for (const boundary of ["body", "html"]) {
  for (const activity of ["untouched", "key"]) {
    test(`Codex refresh focus lease: rejected latest read still releases and restores ${boundary}/${activity}`, async () => {
      const { h, doc, root, arrived, release } = heldRefreshFocus(boundary, { reject: true });
      await h.ctx.refreshCodexNativeSnapshot(h.connection, { initial: true });
      const lease = leaseRefreshButton(h, doc, root), button = lease.button;
      doc.activeElement = button;
      const refreshing = h.ctx.refreshCodexNativeSnapshot(h.connection);
      await arrived;
      assert.equal(lease.implicitFocusEvents(), 1);
      assert.equal(doc.activeElement, root);
      assert.equal(button.disabled, true);
      assert.equal(h.connection.nativeRefreshInFlight, true);
      assert.deepEqual(listenerCounts(h), { pointerdown: 1, keydown: 1, focusin: 1, "window:blur": 1 });
      if (activity === "key") h.documentInput("keydown", root);
      release();
      await refreshing;
      assert.equal(h.connection.connectionLost, true, "a transport failure still marks the connection lost");
      assert.equal(h.connection.nativeLoading, false);
      assert.equal(h.connection.nativeRefreshInFlight, false);
      assert.equal(h.connection.nativeHistoryRequest, null);
      assert.equal(button.disabled, false);
      assert.equal(lease.restored(), activity === "untouched" ? 1 : 0);
      assert.equal(doc.activeElement, activity === "untouched" ? button : root);
      assert.equal(listenerTotal(h), 0, "temporary focus listeners are removed on failure too");
      assert.equal(h.ctx.codexNativeReadableKeys(h.state).size, 40);
      assert.equal(h.calls.length, 4);
      assert.equal(h.calls.filter(call => call.url.includes("/items?")).length, 1);
      assert.deepEqual(h.notices, []);
      assert.ok(!h.state.error);
    });
  }
}

test("Codex refresh focus lease: shares the older controller's revocation predicate and restore guard", () => {
  const flat = text => text.replace(/\s+/g, " ");
  const count = needle => flat(source).split(flat(needle)).length - 1;
  assert.equal(count(`const releaseFocus = event => {
    if (event.type !== "focusin" || event.target !== focusButton && event.target !== document.body
      && event.target !== document.documentElement) restoreFocus = false;
  };`), 2, "older and refresh controllers share one revocation predicate");
  assert.equal(count(`restoreFocus && focusButton === codexNativeHistoryButton && focusButton.parentNode === el.messages
      && !focusButton.disabled && (document.activeElement === document.body
        || document.activeElement === document.documentElement)) focusButton.focus({ preventScroll: true });`), 2,
  "older and refresh controllers share one restore guard");
  const refresh = source.slice(source.indexOf("async function refreshCodexNativeSnapshot("), source.indexOf("async function loadCodexModelCatalog("));
  assert.equal(refresh.includes("userScrollIntentUntil"), false, "a poll refresh never consumes reading intent");
  assert.ok(refresh.indexOf("document.addEventListener(type, releaseFocus, true)") < refresh.indexOf("showCodexNativeHistoryButton()"),
    "the lease listeners precede the disabling call");
});
