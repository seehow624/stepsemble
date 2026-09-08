"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), crypto = require("node:crypto");
const browser = require("../public/modules/history-sources"), protocol = require("../public/modules/history-transport");
const groups = ["one", "two"].map(sourceId => ({ sourceId, agentId: "claude-code", scope: "main_sessions", label: sourceId, description: "Owned" }));
const tick = () => new Promise(resolve => setImmediate(resolve));
const id = n => "claude-" + n.toString(16).padStart(64, "0");
function fixture(overrides = {}, render = null) {
  const calls = [], snapshotId = crypto.randomUUID(); let active = 0, peak = 0;
  const catalog = request => ({ kind: "history_source_catalog", sourceId: request.sourceId, snapshotId: request.snapshotId ?? snapshotId,
    stale: false, refreshing: false, lastError: null, total: 120, page: request.page, nextOffset: request.page.offset + 50 < 120 ? request.page.offset + 50 : null,
    entries: Array.from({ length: Math.min(50, 120 - request.page.offset) }, (_, n) => ({ catalogId: id(request.page.offset + n), nativeTitle: null, titleStatus: "not_loaded" })),
    sourceAuthenticated: false, publishable: false });
  const metadata = request => ({ kind: "history_source_metadata", ...request, metadata: { sessionId: crypto.randomUUID(), nativeTitle: "原生名稱 🐾 " + request.catalogId,
    summary: "獨立摘要", titleStatus: "native" }, sourceAuthenticated: false, publishable: false });
  const deps = { groups, protocol, requestId: () => crypto.randomUUID(), transport: {
    async sourceCatalog(request, signal) { calls.push({ type: "catalog", request, signal }); return overrides.catalog ? overrides.catalog(request, signal, catalog) : catalog(request); },
    async sourceMetadata(request, signal) { calls.push({ type: "metadata", request, signal }); active++; peak = Math.max(active, peak);
      try { return overrides.metadata ? await overrides.metadata(request, signal, metadata) : metadata(request); } finally { active--; } }
  } };
  const instance = render ? browser.create({ ...deps, ...render }) : null;
  const model = instance?.model ?? browser.createModel(deps);
  return { model, instance, calls, catalog, metadata, peak: () => peak };
}
test("source browser lists without scanning and reads only visible names one at a time", async () => {
  const h = fixture(); assert.equal(h.calls.length, 0); await h.model.start();
  assert.equal(h.calls.length, 1); assert.equal(h.calls[0].request.refresh, false); assert.equal(h.model.state().rows.length, 50);
  h.model.setVisible([id(1), id(3), "private.jsonl"]); await tick();
  assert.deepEqual(h.calls.filter(c => c.type === "metadata").map(c => c.request.catalogId), [id(1), id(3)]); assert.equal(h.peak(), 1);
  assert.equal(h.model.state().rows.filter(r => r.metadata).length, 2); h.model.close();
});
test("catalog paging fences both directions and retains only 50 rows plus a selected item", async () => {
  const h = fixture(); await h.model.start(); h.model.select(id(0)); const original = h.model.state();
  await h.model.next(); assert.equal(h.model.state().rows[0].catalogId, id(50)); assert.deepEqual(h.model.state().selected, original.selected);
  assert.equal(h.calls[1].request.snapshotId, original.page.snapshotId); await h.model.previous();
  assert.equal(h.calls[2].request.snapshotId, original.page.snapshotId, "returning to offset zero must not drop the snapshot fence");
  await h.model.next(); await h.model.next(); assert.equal(h.model.state().rows.length, 20);
  await h.model.next(); assert.equal(h.calls.filter(c => c.type === "catalog").length, 5); h.model.close();
});
test("failed refresh preserves stale rows; a successful empty refresh actually clears the list", async () => {
  let fail = false, empty = false;
  const h = fixture({ catalog(request, _signal, good) {
    if (fail) return { kind: "source_unavailable", code: "source_inventory_limit" };
    const page = good(request); return empty ? { ...page, entries: [], total: 0, nextOffset: null } : page;
  } });
  await h.model.start(); h.model.select(id(0)); fail = true; await h.model.refresh();
  assert.equal(h.model.state().rows.length, 50); assert.equal(h.model.state().page.stale, true); assert.equal(h.model.state().error, "source_inventory_limit");
  const count = h.calls.length; await h.model.next(); h.model.select(id(1)); assert.equal(h.calls.length, count); assert.equal(h.model.state().selected.catalogId, id(0));
  fail = false; empty = true; await h.model.refresh(); assert.equal(h.model.state().rows.length, 0); assert.equal(h.model.state().page.stale, false); h.model.close();
});
test("group change aborts old catalog and rejects its late completion even if adapter ignores cancellation", async () => {
  let finish;
  const h = fixture({ catalog(request, _signal, good) { return request.sourceId === "one" ? new Promise(resolve => { finish = () => resolve(good(request)); }) : good(request); } });
  const first = h.model.start(); await tick(); await h.model.selectGroup("two");
  assert.equal(h.calls[0].signal.aborted, true); finish(); await first;
  assert.equal(h.model.state().group.sourceId, "two"); assert.equal(h.model.state().page.sourceId, "two"); h.model.close();
});
test("late metadata from old group/page cannot rename the currently selected conversation", async () => {
  let finish;
  const h = fixture({ metadata(request, _signal, good) { return new Promise(resolve => { finish = () => resolve(good(request)); }); } });
  await h.model.start(); h.model.select(id(0)); h.model.setVisible([id(0)]); await tick();
  const call = h.calls.at(-1); await h.model.selectGroup("two"); h.model.select(id(0)); finish(); await tick();
  assert.equal(call.signal.aborted, true); assert.equal(h.model.state().selected.sourceId, "two"); assert.equal(h.model.state().selected.metadata, null); h.model.close();
});
test("metadata success updates title without changing selection identity; result graphs are detached", async () => {
  const h = fixture(); await h.model.start(); h.model.select(id(0)); const before = h.model.state().selected;
  h.model.setVisible([id(0)]); await tick(); const after = h.model.state();
  assert.equal(after.selected.snapshotId, before.snapshotId); assert.equal(after.selected.catalogId, before.catalogId);
  assert.ok(after.selected.metadata.nativeTitle.startsWith("原生名稱 🐾")); assert.equal(after.selected.metadata.summary, "獨立摘要");
  after.rows[0].metadata.nativeTitle = "mutation"; after.selected.metadata.nativeTitle = "mutation";
  assert.notEqual(h.model.state().rows[0].metadata.nativeTitle, "mutation"); h.model.close();
});
test("busy name reads do not retry automatically; pause cancels and explicit resume retries only visible rows", async () => {
  let busy = true;
  const h = fixture({ metadata(request, _signal, good) { return busy ? { kind: "source_unavailable", code: "source_busy" } : good(request); } });
  await h.model.start(); h.model.setVisible([id(0)]); await tick(); h.model.setVisible([id(0)]); await tick();
  assert.equal(h.calls.filter(c => c.type === "metadata").length, 1); h.model.pauseNames(); busy = false;
  h.model.setVisible([id(0), id(1)]); await tick(); assert.equal(h.calls.filter(c => c.type === "metadata").length, 1);
  h.model.resumeNames(); await tick(); assert.equal(h.calls.filter(c => c.type === "metadata").length, 3); h.model.close();
});
test("revoked source clears rows and selected data; catalog drift marks stale and halts remaining name reads", async () => {
  for (const code of ["history_source_unavailable", "history_unauthorized", "history_catalog_changed"]) {
    const h = fixture({ metadata() { return { kind: "source_unavailable", code }; } }); await h.model.start(); h.model.select(id(0));
    h.model.setVisible([id(0), id(1)]); await tick(); assert.equal(h.calls.filter(c => c.type === "metadata").length, 1); assert.equal(h.model.state().error, code);
    if (code === "history_catalog_changed") assert.equal(h.model.state().page.stale, true);
    else { assert.equal(h.model.state().selected, null); assert.equal(h.model.state().rows.length, 0); }
    h.model.close();
  }
});
test("cancel/close are immediate, abort metadata, discard late values and close never restarts", async () => {
  let finish;
  const h = fixture({ metadata(request, _signal, good) { return new Promise(resolve => { finish = () => resolve(good(request)); }); } });
  await h.model.start(); h.model.setVisible([id(0)]); await tick(); const call = h.calls.at(-1);
  h.model.pauseNames(); assert.equal(call.signal.aborted, true); assert.equal(h.model.state().namesBusy, false); finish(); await tick();
  assert.equal(h.model.state().rows[0].metadata, null); h.model.close(); const count = h.calls.length;
  await h.model.refresh(); h.model.resumeNames(); h.model.setVisible([id(0)]); assert.equal(h.calls.length, count); assert.equal(h.model.state().rows.length, 0);
});

// Native DOM double: text never enters an HTML parser, URL or executable attribute.
class Element {
  constructor(tag, doc) { this.tagName = tag.toUpperCase(); this.ownerDocument = doc; this.children = []; this.attributes = {}; this.dataset = {}; this.listeners = {}; this._text = ""; }
  set textContent(value) { this._text = String(value); this.children = []; }
  get textContent() { return this._text + this.children.map(child => child.textContent).join(""); }
  set innerHTML(_) { assert.fail("no HTML parser"); }
  append(...children) { this.children.push(...children); }
  prepend(...children) { this.children.unshift(...children); }
  replaceChildren(...children) { this._text = ""; this.children = children; }
  setAttribute(key, value) { assert.ok(!/^on|^href$|^src$/i.test(key)); this.attributes[key] = String(value); }
  addEventListener(name, fn) { (this.listeners[name] ??= new Set()).add(fn); }
  removeEventListener(name, fn) { this.listeners[name]?.delete(fn); }
  dispatch(name) { for (const fn of this.listeners[name] ?? []) fn({ target: this }); }
  focus() { this.ownerDocument.activeElement = this; }
  scrollIntoView(options) { this.scrolled = options; }
}
const all = node => [node, ...node.children.flatMap(all)];
function renderer(createContent) {
  const doc = new Element("document"); doc.createElement = tag => new Element(tag, doc);
  const root = new Element("div", doc);
  return { root, describeError: code => `Safe ${code}`, badge: doc => doc.createElement("span"), createContent };
}
test("source renderer preserves row, retry focus and content while full inert native title arrives", async () => {
  let finish; const opens = [], closes = [], selects = [];
  const nativeTitle = "原生 🐾 <script>never()</script> " + "長名稱。".repeat(50);
  const r = renderer((_root, id) => { opens.push(id); return { async select() { selects.push(id); }, async close() { closes.push(id); } }; });
  const h = fixture({ metadata(request, _signal, good) { return new Promise(resolve => { finish = () => resolve({ ...good(request), metadata: { ...good(request).metadata, nativeTitle } }); }); } }, r);
  await tick(); const find = name => all(r.root).filter(e => e.className === name);
  assert.equal(find("source-row").length, 50);
  const row = find("source-row")[0], open = find("source-open")[0], retry = find("source-name-retry")[0];
  open.dispatch("click"); const title = r.root.children[1].children.find(e => e.tagName === "H2");
  assert.strictEqual(r.root.ownerDocument.activeElement, title); assert.deepEqual(opens, [id(0)]);
  assert.deepEqual(r.root.children[1].scrolled, { block: "start", behavior: "instant" });
  retry.focus(); retry.dispatch("click"); await tick(); finish(); await tick();
  assert.strictEqual(find("source-row")[0], row); assert.strictEqual(find("source-name-retry")[0], retry);
  assert.strictEqual(r.root.ownerDocument.activeElement, retry); assert.deepEqual(opens, [id(0)]);
  assert.equal(title.textContent, nativeTitle); assert.equal(find("source-title")[0].textContent, nativeTitle);
  assert.equal(title.className, "source-compact-title");
  all(r.root).find(e => e.tagName === "BUTTON" && e.textContent === "展開完整名稱").dispatch("click");
  assert.equal(title.className, "source-full-title"); assert.deepEqual(opens, [id(0)]);
  assert.equal(find("source-summary")[0].textContent, "原生摘要：獨立摘要");
  assert.ok(!all(r.root).some(e => ["SCRIPT", "A", "IMG", "IFRAME"].includes(e.tagName)));
  all(r.root).find(e => e.tagName === "BUTTON" && e.textContent === "回到對話清單").dispatch("click");
  assert.strictEqual(r.root.ownerDocument.activeElement, open);
  assert.deepEqual(selects, [id(0)]); open.dispatch("click"); assert.deepEqual(selects, [id(0), id(0)]);
  assert.deepEqual(opens, [id(0)], "explicit reselection reaches the same viewer without recreating it");
  await h.instance.close(); assert.deepEqual(closes, [id(0)]); assert.equal(find("source-row").length, 0);
  assert.equal(r.root.ownerDocument.listeners.visibilitychange.size, 0);
});
test("renderer waits for one content cleanup and opens only latest selection, never queued clicks", async () => {
  let finishClose; const opened = [], closed = [];
  const r = renderer((_root, selected) => { opened.push(selected); return { async select() {}, close() {
    closed.push(selected); return selected === id(0) ? new Promise(resolve => { finishClose = resolve; }) : Promise.resolve();
  } }; });
  const h = fixture({}, r); await tick(); h.model.select(id(0)); h.model.select(id(1)); h.model.select(id(2));
  assert.deepEqual(opened, [id(0)]); assert.deepEqual(closed, [id(0)]); finishClose(); await tick();
  assert.deepEqual(opened, [id(0), id(2)]); await h.instance.close(); assert.deepEqual(closed, [id(0), id(2)]);
});
test("closing during content cleanup never opens pending selection or creates new observers", async () => {
  let finish; const opened = []; const observers = [];
  const previous = global.IntersectionObserver;
  global.IntersectionObserver = class { constructor() { observers.push(this); } observe() {} disconnect() { this.disconnected = true; } };
  try {
    const r = renderer((_root, selected) => { opened.push(selected); return { async select() {}, close() { return new Promise(resolve => { finish = resolve; }); } }; });
    const h = fixture({}, r); await tick(); h.model.select(id(0)); h.model.select(id(1)); const count = observers.length;
    const closing = h.instance.close(); finish(); await closing; await tick();
    assert.deepEqual(opened, [id(0)]); assert.equal(observers.length, count); assert.ok(observers.every(o => o.disconnected));
  } finally { if (previous === undefined) delete global.IntersectionObserver; else global.IntersectionObserver = previous; }
});
