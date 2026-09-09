"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), { randomUUID } = require("node:crypto");
const view = require("../public/modules/codex-history-view"), wire = require("../public/modules/codex-history-records");
const { canonicalJSON } = require("../public/modules/projection"), raw = require("../protocol/native/codex/rollout-snapshot");
const structure = require("../protocol/native/codex/rollout-structure"), fixture = require("../protocol/native/codex/parser-fixture.cjs");
const id = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", catalogId = "codex-" + "a".repeat(64), token = "a".repeat(64);
const tick = () => new Promise(resolve => setImmediate(resolve));
function harness(t, options = {}, create = view.createModel) {
  const records = [{ type: "session_meta", payload: { id, history_mode: "legacy" } }, ...Array.from({ length: 31 }, (_, i) => ({ type: "response_item", payload: { type: "message", role: "assistant",
    content: [{ type: "output_text", text: `${i} <script>never()</script> https://never.invalid/ ${options.long ? "長".repeat(20000) : ""}` }] } }))];
  const bytes = options.structured ? fixture.structuredCaptured().rolloutBytes : Buffer.from(records.map(v => JSON.stringify(v)).join("\n") + "\n"), snapshot = raw.createRolloutSnapshot(bytes, { threadId: id, nativeVersion: "0.153.4" });
  const structuredSnapshot = options.structured ? structure.createStructuredRolloutSnapshot(bytes, { threadId: id, nativeVersion: "0.153.4" }) : null;
  assert.equal(snapshot.kind, "codex_rollout_snapshot"); t.after(() => raw.releaseRolloutSnapshot(snapshot));
  if (structuredSnapshot) t.after(() => structure.releaseStructuredRolloutSnapshot(structuredSnapshot));
  const viewId = randomUUID(), bindingId = randomUUID(), calls = [], control = { generation: 1, now: 1000000 };
  const registration = () => ({ kind: "history_registration", catalogId, viewId, bindingId, generation: control.generation, sessionId: id, expiresAt: control.now + 60000, sourceAuthenticated: false, publishable: false });
  const bound = (request, options) => {
    const { snapshotId: _snapshotId, ...records } = raw.readRolloutPage(snapshot, { ...options.page, snapshotId: snapshot.snapshotId });
    const linked = options.structured && structuredSnapshot ? structure.readStructuredRolloutPage(structuredSnapshot, { ...options.page, snapshotId: structuredSnapshot.snapshotId }) : null;
    return { kind: "bound_codex_records", ...request, sourceVersion: token, history: { kind: "codex_source_records", nativeVersion: "0.153.4", nativeThreadId: id, nativeTitle: "原生名稱",
      page: options.page, records, semanticHistoryComplete: false, sourceAuthenticated: false, publishable: false,
      ...(linked ? { structure: { profile: linked.structureProfile, totalTurns: linked.totalTurns, retainedTurns: linked.retainedTurns, turns: linked.turns, annotations: linked.annotations } } : {}),
      authority: { sourceAuthenticated: false, approvalAcknowledged: false, runTerminalObserved: false, resumeAllowed: false } }, sourceAuthenticated: false, publishable: false, cleanupConfirmed: true };
  };
  const transport = {
    async register(...args) { calls.push("register"); return options.register ? options.register(...args, registration) : registration(); },
    async readCodex(scope, request, opts) { calls.push({ offset: opts.page.offset, version: opts.version, structured: opts.structured, profile: opts.profile }); return options.read ? options.read(scope, request, opts, bound) : bound(request, opts); },
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
  append(...v) { this.children.push(...v); } appendChild(v) { this.append(v); return v; } replaceChildren(...v) { this._text = ""; this.children = v; }
  setAttribute(k, v) { assert(!/^on|^href$|^src$/i.test(k)); this.attributes[k] = String(v); }
  addEventListener(e, fn) { (this.listeners[e] ??= []).push(fn); } dispatch(e) { for (const fn of this.listeners[e] ?? []) fn({ target: this }); }
}
const all = n => [n, ...n.children.flatMap(all)];
function largeReader(large) {
  return (_scope, request, options, good) => {
    if (!options.profile) return { kind: "source_unavailable", code: "source_too_large" };
    const reply = good(request, { ...options, page: { offset: 0, limit: 1 } });
    reply.history.kind = "codex_validated_source_records"; reply.history.page = options.page; reply.history.records = large.page(options.page);
    return reply;
  };
}
test("large history negotiates once after the old limit, then jumps beyond 8192 using the same version", async t => {
  const large = require("./support/codex-large-fixture.cjs")(), h = harness(t, { read: largeReader(large), dependencies: { initialStructured: true } });
  await h.model.select(catalogId); assert.equal(h.model.state().error, null); assert.equal(h.model.state().profile, wire.PAGE_PROFILE);
  assert.equal(h.model.state().page.history.records.recordCount, 9005); assert.equal(h.model.state().page.history.structure, undefined);
  assert.deepEqual(h.calls.filter(v => typeof v === "object").map(v => [v.structured, v.profile]), [[true, undefined], [undefined, wire.PAGE_PROFILE]]);
  await h.model.jump(9000); assert.equal(h.model.state().page.history.records.offset, 9000); assert.equal(h.model.state().canNext, false);
  assert.equal(h.calls.at(-1).version, token); assert.equal(h.calls.at(-1).structured, undefined);
  await h.model.setStructured(false); assert.equal(h.calls.at(-1).profile, wire.PAGE_PROFILE); assert.equal(h.model.state().error, null);
  await h.model.refresh(); assert.equal(h.calls.at(-2).profile, undefined); assert.equal(h.calls.at(-1).profile, wire.PAGE_PROFILE);
  assert.equal(Object.hasOwn(h.model.state(), "pages"), false);
});
test("format negotiation never retries other failures, continuation failures or the new profile's failure", async t => {
  for (const code of ["source_busy", "source_worker_timeout", "source_cleanup_unconfirmed", "rollout_invalid_record", "history_unauthorized", "source_version_changed"]) {
    const h = harness(t, { read: () => ({ kind: "source_unavailable", code }) }); await h.model.select(catalogId);
    assert.equal(h.calls.filter(v => typeof v === "object").length, 1); assert.equal(h.model.state().error, code);
  }
  const h = harness(t, { read: () => ({ kind: "source_unavailable", code: "rollout_record_limit" }) }); await h.model.select(catalogId);
  assert.equal(h.calls.filter(v => typeof v === "object").length, 2); assert.equal(h.model.state().error, "rollout_record_limit");
  let limited = false; const old = harness(t, { read: (_s, r, o, good) => limited ? { kind: "source_unavailable", code: "source_too_large" } : good(r, o) });
  await old.model.select(catalogId); limited = true; await old.model.next();
  assert.equal(old.calls.filter(v => typeof v === "object").length, 2); assert.equal(old.model.state().stale, true);
});
test("cancel between profile selection and read prevents the second request and keeps the UI interruptible", async t => {
  let model; const h = harness(t, { read: () => ({ kind: "source_unavailable", code: "source_too_large" }),
    dependencies: { onChange() { if (model?.state().stage === "codexLargeReading") model.cancel(); } } }); model = h.model;
  await model.select(catalogId); assert.equal(h.calls.filter(v => typeof v === "object").length, 1);
  assert.equal(model.state().stage, "cancelled"); assert.equal(model.state().busy, false); assert.equal(model.state().page, null);
});
test("large public DTOs require exact opt-in and reject old versions, mixed scopes, fake structure or excess totals", async t => {
  const large = require("./support/codex-large-fixture.cjs")(), h = harness(t, { read: largeReader(large) }); await h.model.select(catalogId);
  const value = h.model.state().page, scope = { bindingId: value.bindingId, generation: value.generation, requestId: value.requestId, profile: wire.PAGE_PROFILE };
  assert(wire.validBoundRecords(value, id, value.history.page, scope));
  assert.equal(wire.validBoundRecords(value, id, value.history.page, { ...scope, profile: undefined }), false);
  assert.equal(wire.validPage({ offset: 9000, limit: 1 }), false); assert(wire.validPage({ offset: 9000, limit: 1 }, wire.PAGE_PROFILE));
  for (const change of [v => { v.history.kind = "codex_source_records"; }, v => { v.history.records.scope = "one_legacy_rollout_raw_records"; },
    v => { v.history.structure = {}; }, v => { v.history.records.byteLength = wire.PAGE_LIMITS.sourceBytes + 1; },
    v => { v.history.records.recordCount = wire.PAGE_LIMITS.records + 1; }, v => { v.history.authority.resumeAllowed = true; }]) {
    const changed = structuredClone(value); change(changed); assert.equal(wire.validBoundRecords(changed, id, value.history.page, scope), false);
  }
});
test("large readable UI retains complete text, bounded cards, direct jump and localized controls without rereading", async t => {
  const doc = { createElement(tag) { return new Element(tag, doc); } }, root = new Element("div", doc), large = require("./support/codex-large-fixture.cjs")();
  const h = harness(t, { read: largeReader(large), dependencies: { root } }, view.create); await h.model.select(catalogId);
  assert.equal(all(root).filter(v => v.tagName === "ARTICLE").length, 10);
  assert(all(root).some(v => v.className === "history-message-text" && v.textContent.endsWith("END-OF-LARGE-TEXT")));
  const input = all(root).find(v => v.dataset.action === "recordNumber"), form = all(root).find(v => v.tagName === "FORM");
  assert.equal(input.max, "9005"); input.value = "9001"; form.listeners.submit[0]({ preventDefault() {} }); await tick();
  assert.equal(h.model.state().page.history.records.offset, 9000); assert.equal(all(root).filter(v => v.tagName === "ARTICLE").length, 5);
  assert.equal(h.calls.at(-1).profile, wire.PAGE_PROFILE); assert.equal(input.disabled, false);
  await h.model.setStructured(false); assert(all(root).filter(v => v.className === "history-message-text").every(v => v.textContent.length <= 4000));
  await h.model.close(); assert.equal(form.hidden, true); assert.equal(all(root).filter(v => v.tagName === "ARTICLE").length, 0);
});
test("raw record UI keeps native text inert, bounds preview DOM, opens original text lazily and preserves controls", async t => {
  const doc = { createElement(tag) { return new Element(tag, doc); } }, root = new Element("div", doc);
  const h = harness(t, { long: true, dependencies: { root, initialStructured: false } }, view.create);
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
test("structured mode is explicit, source-versioned across page jumps, and can return to the exact original records", async t => {
  const h = harness(t, { structured: true, dependencies: { initialStructured: true } });
  await h.model.select(catalogId); const first = h.model.state().page;
  assert.equal(first.history.structure.totalTurns, 1); assert.equal(h.calls.at(-1).structured, true);
  await h.model.jump(12); assert.equal(h.model.state().page.history.records.offset, 12); assert.equal(h.calls.at(-1).version, first.sourceVersion);
  assert.equal(h.model.state().canPrevious, false); const calls = h.calls.length;
  for (const n of [-1, NaN, 0.5, 99999]) await h.model.jump(n); assert.equal(h.calls.length, calls);
  await h.model.setStructured(false); const plain = h.model.state().page;
  assert.equal(h.calls.at(-1).structured, undefined); assert.equal(plain.history.structure, undefined);
  assert.deepEqual(plain.history.records, first.history.records); assert.equal(plain.sourceVersion, first.sourceVersion);
  await h.model.setStructured(true); await h.model.next(); assert.equal(h.calls.at(-1).structured, true);
});
test("mode changes await actual old-flight completion and reject a silent structural downgrade", async t => {
  let finish, count = 0;
  const h = harness(t, { structured: true, read: (_s, r, o, good) => ++count === 1 ? new Promise(resolve => { finish = () => resolve(good(r, o)); }) : good(r, o) });
  const first = h.model.select(catalogId); await tick(); const switching = h.model.setStructured(true); await tick();
  assert.equal(count, 1); assert.equal(h.model.state().page, null); finish(); await first; await switching;
  assert.equal(h.model.state().structured, true); assert(h.model.state().page.history.structure);
  const bad = harness(t, { dependencies: { initialStructured: true } }); await bad.model.select(catalogId);
  assert.equal(bad.model.state().error, "history_response_invalid"); assert.equal(bad.model.state().page, null);
  await bad.model.setStructured(false); assert.equal(bad.model.state().stage, "loaded");
});
test("conversation DOM shows inert native roles, Codex identity, historical turns and source links with stable mode controls", async t => {
  const doc = { createElement(tag) { return new Element(tag, doc); } }, root = new Element("div", doc);
  const h = harness(t, { structured: true, dependencies: { root } }, view.create);
  const control = all(root).find(v => v.dataset.historyMode === "structured"); await h.model.select(catalogId);
  assert.equal(control.attributes["aria-pressed"], "true");
  assert(root.textContent.includes("Historical status")); assert(root.textContent.includes("fixture-rich-turn"));
  assert.equal(/\{(?:count|limit|record)\}/.test(root.textContent), false);
  assert(all(root).some(v => v.dataset.recordKind === "model_context")); assert(all(root).some(v => v.dataset.relatedRecord !== undefined));
  await h.model.next(); assert(all(root).some(v => v.dataset.agentId === "codex"));
  assert(!all(root).some(v => ["SCRIPT", "A", "IMG", "IFRAME"].includes(v.tagName)));
  await h.model.setStructured(false); assert.equal(all(root).find(v => v.dataset.historyMode === "structured"), control);
  assert.equal(control.attributes["aria-pressed"], "false"); assert(!all(root).some(v => v.dataset.turnKey));
});
