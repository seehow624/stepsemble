"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

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
  const messages = new Node(), notices = [], calls = [], timers = [];
  const ctx = vm.createContext({ URLSearchParams, AbortController, apiBase: "/r/owned", viewGeneration: 1,
    codexNativeHistoryButton: null, codexNativePollTimer: null, autoScrollPinned: false,
    document: { createElement: tag => new Node(tag) },
    window: { stepsembleI18n: { t: value => value } },
    el: { messages, taskReplayNote: new Node() },
    api: async (url, opts) => { calls.push({ url, ...opts }); return api(new URL(url, "http://owned"), opts); },
    toast: msg => notices.push(msg), tKey: (key, vars = {}) => key + ":" + (vars.detail || ""),
    syncGenericInputState() {}, applyGenericTaskSnapshot() {}, ensureSessionUsageFooter() {}, keepSessionUsageAtEnd() {},
    updateScrollBottomButton() {}, scrollBottom() { messages.scrollTop = messages.scrollHeight; },
    setInterval(fn) { timers.push(fn); return timers.length; }, clearInterval() {},
    renderMarkdown(text) { const node = new Node(); node.textContent = text; return node; },
    msgActionsRow() { return new Node(); },
    makeMsgShell(role, label, container) { const wrap = new Node(), bubble = new Node(); wrap.appendChild(bubble); container.appendChild(wrap); return { wrap, bubble }; },
  });
  vm.runInContext(slice, ctx);
  ctx.rpc = { nativeCodex: true, nativeThreadId: "thread-a", nativeTranscriptState: ctx.createCodexNativeTranscriptState() };
  return { ctx, calls, notices, messages, state: ctx.rpc.nativeTranscriptState, connection: ctx.rpc, timers };
}

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
    if (attempts === 2) { assert.equal(url.searchParams.has("cursor"), false); return page([entry("a", "latest")], "older"); }
    assert.equal(url.searchParams.get("cursor"), "older"); return page([entry("a", "first")]);
  });
  await h.ctx.refreshCodexNativeSnapshot(h.connection, { initial: true });
  assert.equal(h.state.itemsCursor, undefined); assert.equal(h.state.hasMore, true);
  assert.match(h.ctx.el.taskReplayNote.textContent, /offline/);
  await h.ctx.loadOlderCodexNativeHistory(); assert.equal(h.state.itemsCursor, "older");
  await h.ctx.loadOlderCodexNativeHistory(); assert.equal(h.state.itemsCursor, "older");
  assert.equal(h.state.entries.length, 1);
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

test("polling preserves old pages and their cursors, updates same-length content and keeps unchanged nodes", async () => {
  let latest = "abcd";
  const h = harness(url => url.pathname.endsWith("/thread")
    ? { thread: { status: { type: "idle" } } }
    : url.pathname.endsWith("/turns") ? page([turn("a")])
    : page([entry("a", "latest", latest)], "current-tail"));
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
