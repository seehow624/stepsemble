"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), { randomUUID } = require("node:crypto");
const view = require("../public/modules/codex-history-view"), wire = require("../public/modules/codex-history-records");
const { canonicalJSON } = require("../public/modules/projection"), raw = require("../protocol/native/codex/rollout-snapshot");
const id = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", catalogId = "codex-" + "a".repeat(64), token = "a".repeat(64);
const tick = () => new Promise(resolve => setImmediate(resolve));
function harness(t, options = {}, create = view.createModel) {
  const records = [{ type: "session_meta", payload: { id, history_mode: "legacy" } }, ...Array.from({ length: 31 }, (_, i) => ({ type: "response_item", payload: { type: "message", role: "assistant",
    content: [{ type: "output_text", text: `${i} <script>never()</script> https://never.invalid/ ${options.long ? "長".repeat(20000) : ""}` }] } }))];
  const bytes = Buffer.from(records.map(v => JSON.stringify(v)).join("\n") + "\n"), snapshot = raw.createRolloutSnapshot(bytes, { threadId: id, nativeVersion: "0.153.4" });
  assert.equal(snapshot.kind, "codex_rollout_snapshot"); t.after(() => raw.releaseRolloutSnapshot(snapshot));
  const viewId = randomUUID(), bindingId = randomUUID(), calls = [], control = { generation: 1, now: 1000000 };
  const registration = () => ({ kind: "history_registration", catalogId, viewId, bindingId, generation: control.generation, sessionId: id, expiresAt: control.now + 60000, sourceAuthenticated: false, publishable: false });
  const bound = (request, options) => {
    const { snapshotId: _snapshotId, ...records } = raw.readRolloutPage(snapshot, { ...options.page, snapshotId: snapshot.snapshotId });
    return { kind: "bound_codex_records", ...request, sourceVersion: token, history: { kind: "codex_source_records", nativeVersion: "0.153.4", nativeThreadId: id, nativeTitle: "原生名稱",
      page: options.page, records, semanticHistoryComplete: false, sourceAuthenticated: false, publishable: false,
      authority: { sourceAuthenticated: false, approvalAcknowledged: false, runTerminalObserved: false, resumeAllowed: false } }, sourceAuthenticated: false, publishable: false, cleanupConfirmed: true };
  };
  const transport = {
    async register(...args) { calls.push("register"); return options.register ? options.register(...args, registration) : registration(); },
    async readCodex(scope, request, opts) { calls.push({ offset: opts.page.offset, version: opts.version }); return options.read ? options.read(scope, request, opts, bound) : bound(request, opts); },
    async release(...args) { calls.push("release"); return options.release ? options.release(...args) : { kind: "history_released", cleanupConfirmed: true }; }
  };
  const model = create({ catalogId, viewId, hostId: "owned", transport, canonicalJSON, requestId: randomUUID, now: () => control.now, ...options.dependencies });
  t.after(() => model.close()); return { model, calls, control, registration, bound, snapshot, transport };
}
test("Codex view fetches only the selected catalog; next/previous use native byte-bounded next offsets and retain one page", async t => {
  const h = harness(t, { long: true }); assert.equal(h.calls.length, 0); await h.model.select("other"); assert.equal(h.calls.length, 0);
  await h.model.select(catalogId); const first = h.model.state().page;
  assert(first.history.records.records.length < 10, "byte-limited short page is not EOF"); assert.equal(first.history.records.endOfFile, false);
  await h.model.next(); assert.equal(h.model.state().page.history.records.offset, first.history.records.nextOffset);
  assert.equal(h.calls.at(-1).version, token); assert.equal(Object.hasOwn(h.model.state(), "pages"), false);
  await h.model.previous(); assert.equal(h.model.state().page.history.records.offset, 0);
  await h.model.next(); await h.model.refresh(); assert.equal(h.model.state().pageIndex, 0); assert.equal(h.model.state().page.history.records.offset, 0);
  assert.equal(h.calls.at(-1).version, undefined);
  const copy = h.model.state(); copy.page.history.records.records.length = 0; assert(h.model.state().page.history.records.records.length > 0);
});
test("source version changes, changed generation and expired lease keep old page stale and require explicit refresh", async t => {
  let code = null;
  const h = harness(t, { read: (_scope, request, options, good) => code ? { kind: "source_unavailable", code } : good(request, options) });
  await h.model.select(catalogId); code = "source_version_changed"; await h.model.next();
  assert.equal(h.model.state().page.history.records.offset, 0); assert.equal(h.model.state().stale, true); assert.equal(h.model.state().canNext, false);
  code = null; await h.model.refresh(); h.control.generation++; await h.model.next(); assert.equal(h.model.state().error, "history_binding_unavailable");
  await h.model.refresh(); h.control.now += 60001; assert.equal(h.model.state().stale, true); assert.equal(h.model.state().canNext, false);
  const calls = h.calls.length; await h.model.next(); assert.equal(h.model.state().error, "history_refresh_required");
  assert.equal(h.calls.length, calls, "an expired visible control explains expiry without any source read");
  await h.model.refresh(); assert.equal(h.model.state().stale, false);
});
test("inert DTO validates exact scope, version, authority, raw byte boundaries and whole-source consistency", async t => {
  const mutations = [v => { v.sourceVersion = "b".repeat(64); }, v => { v.history.nativeThreadId = randomUUID(); }, v => { v.history.authority.resumeAllowed = true; },
    v => { v.history.records.records[0].byteOffset++; }, v => { v.history.records.records[0].executable = true; }, v => { v.history.semanticHistoryComplete = true; },
    v => { v.history.records.sha256 = "b".repeat(64); }, v => { v.history.records.recordCount++; }];
  for (const mutate of mutations) {
    let tamper = false; const h = harness(t, { read: (_scope, r, o, good) => { const v = good(r, o); if (tamper) mutate(v); return v; } });
    await h.model.select(catalogId); tamper = true; await h.model.next();
    assert.equal(h.model.state().error, "history_response_invalid"); assert.equal(h.model.state().page.history.records.offset, 0);
  }
});
test("cancel/refresh serializes the old flight; only the newest request can apply", async t => {
  let finish, count = 0;
  const h = harness(t, { read: (_scope, r, o, good) => ++count === 1 ? new Promise(resolve => { finish = () => resolve(good(r, o)); }) : good(r, o) });
  const first = h.model.select(catalogId); await tick(); h.model.cancel(); const second = h.model.refresh(); await tick();
  assert.equal(count, 1); assert.equal(h.model.state().page, null); finish(); await first; await second;
  assert.equal(count, 2); assert.equal(h.model.state().stage, "loaded");
});
test("closing during a late registration awaits cleanup, drops content and only then allows reopen", async t => {
  let finish, calls = 0, released = 0;
  const h = harness(t, { register: (_r, _s, good) => ++calls === 1 ? new Promise(resolve => { finish = () => resolve(good()); }) : good(),
    release: async () => { released++; return { kind: "history_released", cleanupConfirmed: true }; } });
  const first = h.model.select(catalogId); await tick(); let done = false; const closing = h.model.close().then(() => { done = true; });
  const reopen = h.model.select(catalogId); await tick(); assert.equal(done, false); assert.equal(calls, 1);
  finish(); await first; await closing; await reopen; assert.equal(released, 1); assert.equal(calls, 2); assert.equal(h.model.state().stage, "loaded");
});
test("unsupported paginated storage is not an empty successful page; revoked access erases retained content", async t => {
  let code = "native_paginated_history_unsupported";
  const h = harness(t, { read: (_scope, r, o, good) => code ? { kind: "source_unavailable", code } : good(r, o) });
  await h.model.select(catalogId); assert.equal(h.model.state().error, code); assert.equal(h.model.state().page, null);
  code = null; await h.model.refresh(); assert(h.model.state().page);
  code = "history_unauthorized"; await h.model.next(); assert.equal(h.model.state().page, null);
});
class Element {
  constructor(tag, doc) { this.tagName = tag.toUpperCase(); this.ownerDocument = doc; this.children = []; this.attributes = {}; this.dataset = {}; this.listeners = {}; this._text = ""; }
  set textContent(v) { this._text = String(v); this.children = []; } get textContent() { return this._text + this.children.map(c => c.textContent).join(""); }
  set innerHTML(_) { assert.fail("no native text in HTML"); } set href(_) { assert.fail("no active URLs"); } set src(_) { assert.fail("no source fetches"); }
  append(...v) { this.children.push(...v); } replaceChildren(...v) { this._text = ""; this.children = v; }
  setAttribute(k, v) { assert(!/^on|^href$|^src$/i.test(k)); this.attributes[k] = String(v); }
  addEventListener(e, fn) { (this.listeners[e] ??= []).push(fn); } dispatch(e) { for (const fn of this.listeners[e] ?? []) fn({ target: this }); }
}
const all = n => [n, ...n.children.flatMap(all)];
test("raw record UI keeps native text inert, bounds preview DOM, opens original text lazily and preserves controls", async t => {
  const doc = { createElement(tag) { return new Element(tag, doc); } }, root = new Element("div", doc);
  const h = harness(t, { long: true, dependencies: { root } }, view.create);
  const refresh = all(root).find(v => v.dataset.action === "refresh"); await h.model.select(catalogId);
  assert.equal(all(root).find(v => v.dataset.action === "refresh"), refresh);
  assert(all(root).filter(v => v.tagName === "ARTICLE").length <= view.LIMITS.pageRecords); assert(root.textContent.includes("<script>never()</script>"));
  assert(!all(root).some(v => ["SCRIPT", "A", "IMG", "IFRAME"].includes(v.tagName)));
  const previews = all(root).filter(v => v.className === "history-message-text");
  assert(previews.length > 0); assert(previews.every(v => v.tabIndex === 0 && v.attributes["aria-labelledby"]));
  const details = all(root).filter(v => v.tagName === "DETAILS"), pres = all(root).filter(v => v.tagName === "PRE");
  assert(pres.every(v => v.textContent === "")); details[1].open = true; details[1].dispatch("toggle");
  assert.equal(pres[1].textContent, h.model.state().page.history.records.records[1].rawText); assert.equal(pres[1].tabIndex, 0);
  details[0].open = true; details[0].dispatch("toggle"); assert.equal(pres[1].textContent, ""); assert.equal(details[1].open, false);
  assert(all(root).some(v => v.attributes["aria-live"] === "polite")); await h.model.close(); assert.equal(all(root).filter(v => v.tagName === "ARTICLE").length, 0);
});
test("large public names have exact UTF-8 byte limits; structural validation never invents a native session ID", async t => {
  assert.equal(wire.validTitle("名".repeat(10922)), true); assert.equal(wire.validTitle("名".repeat(10923)), false);
  const h = harness(t); await h.model.select(catalogId); assert(!Object.hasOwn(h.model.state().page.history, "nativeSessionId"));
});
