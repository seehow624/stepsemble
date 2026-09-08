"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
const view = require("../public/modules/history-view"), pages = require("../public/modules/history-pages"), transportModule = require("../public/modules/history-transport");
const { canonicalJSON } = require("../public/modules/projection"), provider = require("../public/modules/claude-history");
const fixture = require("../protocol/native/claude/history-fixture.cjs");
const { parseHistoryBytes } = require("../protocol/native/claude/history-source"), { selectHistory } = require("../protocol/native/claude/history-selection");
const uuid = fixture.uuid, hostId = "history-preview", viewId = uuid(901), token = "a".repeat(64);
const catalog = [{ catalogId: "first", label: "第一個範例", description: "只讀合成資料" }, { catalogId: "second", label: "另一個範例", description: "另一个合成來源" }];
const initial = fixture.richCases("/synthetic")[0];
const source = { sessionId: initial.sessionId, expectedIds: Array.from({ length: 35 }, (_, i) => uuid(100 + i)), records: Array.from({ length: 35 }, (_, i) => ({ ...initial.records[0], uuid: uuid(100 + i), parentUuid: i ? uuid(99 + i) : null,
  message: { role: "user", content: `合成訊息 ${i + 1} <script>alert('never')</script> https://example.invalid/file` } })) };
async function history(page) {
  const parsed = parseHistoryBytes(Buffer.from(source.records.map(r => JSON.stringify(r)).join("\n") + "\n"), source.sessionId);
  return selectHistory({ ...parsed, kind: "source_snapshot", identity: { device: "1", inode: "2", size: parsed.byteLength, mtimeNs: "3", ctimeNs: "4" },
    checks: { owner: "posix_euid_and_mode", reads: 2, matchingBytes: true, unchangedObservedIdentity: true }, sourceAuthenticated: false, publishable: false }, page,
  async (sid, options) => {
    await options.sessionStore.load({ projectKey: options.dir.replace(/[^a-zA-Z0-9]/g, "-"), sessionId: sid });
    return fixture.selectedRows(source).slice(page.offset, page.offset + page.limit);
  });
}
const createPages = read => pages.create({ read, canonicalJSON, validateHistory: provider.create({ canonicalJSON }).validateHistory, requestId: () => uuid(902) });
const tick = () => new Promise(resolve => setImmediate(resolve));
function harness(overrides = {}, create = view.createModel) {
  const calls = []; let generation = 1, clock = 1000000;
  const registration = (catalogId, selectedGeneration = generation) => ({ kind: "history_registration", bindingId: uuid(903), generation: selectedGeneration,
    sessionId: source.sessionId, catalogId, viewId, expiresAt: clock + 60000, sourceAuthenticated: false, publishable: false });
  const transport = {
    async register(request, signal) { calls.push({ kind: "register", request, signal }); return registration(request.catalogId); },
    async release(request) { calls.push({ kind: "release", request }); return { kind: "history_released", cleanupConfirmed: true }; },
    async read(scope, request, options) { calls.push({ kind: "read", scope, request, options }); return { kind: "bound_history_observation", ...request,
      sourceVersion: token, sourceAuthenticated: false, publishable: false, cleanupConfirmed: true, history: await history(options.page) }; },
    ...overrides.transport,
  };
  const model = create({ hostId, viewId, catalog, createPages, now: () => clock, ...overrides, transport });
  return { model, transport, calls, registration, setGeneration: v => { generation = v; }, advance: n => { clock += n; } };
}

test("viewer starts empty without auto-registering, fetches only selected public catalog IDs", async () => {
  const h = harness(); assert.equal(h.model.state().selected, null); assert.equal(h.calls.length, 0);
  await h.model.select("/private/path"); assert.equal(h.calls.length, 0);
  await h.model.select("first");
  assert.deepEqual(h.calls.map(c => c.kind), ["register", "read"]);
  assert.deepEqual(h.calls[0].request, { catalogId: "first", viewId });
  assert.equal(h.model.state().page.observation.messages.length, 10); assert.equal(h.model.state().busy, false);
  assert.equal(h.model.state().selected.label, "第一個範例");
  await h.model.select("first"); assert.equal(h.calls.length, 2);
});

test("next read renews same-view registration, cached page navigation performs no network work", async () => {
  const h = harness(); await h.model.select("first"); await h.model.next();
  assert.deepEqual(h.calls.map(c => c.kind), ["register", "read", "register", "read"]);
  assert.equal(h.calls[2].request.viewId, viewId); assert.equal(h.calls[3].options.version, token);
  assert.equal(h.model.state().page.offset, 10); assert.equal(h.model.state().pageCount, 2);
  await h.model.previous(); assert.equal(h.model.state().page.offset, 0); assert.equal(h.calls.length, 4);
  await h.model.next(); assert.equal(h.model.state().page.offset, 10); assert.equal(h.calls.length, 4);
  const copy = h.model.state(); copy.page.observation.messages.length = 0; copy.selected.label = "mutation";
  assert.equal(h.model.state().page.observation.messages.length, 10); assert.equal(h.model.state().selected.label, "第一個範例");
});

test("explicit refresh applies selected page size and atomically replaces the retained window", async () => {
  const h = harness(); await h.model.select("first"); await h.model.next();
  h.model.setLimit(25); assert.equal(h.calls.length, 4); assert.equal(h.model.state().limit, 25);
  h.model.setLimit(999); assert.equal(h.model.state().limit, 25);
  await h.model.refresh(); assert.equal(h.calls.at(-1).options.page.offset, 10); assert.equal(h.calls.at(-1).options.page.limit, 25);
  assert.equal(h.model.state().pageCount, 1); assert.equal(h.model.state().page.observation.messages.length, 25);
  h.model.showWindow(10); assert.equal(h.model.state().messageStart, 10);
  h.model.showWindow(1000); assert.equal(h.model.state().messageStart, 10);
  await h.model.next(); assert.equal(h.model.state().page.offset, 10); assert.equal(h.model.state().canNext, false);
  await h.model.refresh(); assert.equal(h.calls.at(-1).options.page.offset, 10);
});

test("server generation rollover blocks continuation and keeps previous pages until successful explicit refresh", async () => {
  const h = harness(); await h.model.select("first"); const before = h.model.state().page;
  h.setGeneration(2); await h.model.next();
  assert.equal(h.calls.filter(c => c.kind === "read").length, 1); assert.equal(h.model.state().stale, true);
  assert.equal(h.model.state().error, "history_binding_unavailable"); assert.deepEqual(h.model.state().page, before);
  await h.model.refresh(); assert.equal(h.model.state().stale, false); assert.equal(h.calls.at(-1).scope.generation, 2);
});

test("an expired local lease is visibly stale on interaction and requires explicit refresh without timers", async () => {
  const h = harness(); await h.model.select("first"); h.advance(60001);
  assert.equal(h.model.state().stale, true); await h.model.next(); assert.equal(h.calls.length, 2);
  assert.equal(h.model.state().error, "history_refresh_required"); await h.model.refresh();
  assert.equal(h.model.state().stale, false); assert.equal(h.calls.length, 4);
});

test("failed renewal preserves old page and marks it stale; exception details never surface", async () => {
  const h = harness(); await h.model.select("first"); const before = h.model.state().page;
  // The existing page controller captures read, so use registration failure to
  // exercise the viewer-side boundary independently from controller failures.
  h.transport.register = async () => ({ kind: "source_unavailable", code: "history_unauthorized" });
  await h.model.refresh(); assert.deepEqual(h.model.state().page, before); assert.equal(h.model.state().stale, true);
  assert.equal(h.model.state().error, "history_unauthorized");
  h.transport.register = async () => { throw new Error("/private/password"); };
  await h.model.refresh(); assert.equal(h.model.state().error, "history_transport_failed");
  assert.ok(!JSON.stringify(h.model.state()).includes("/private"));
  assert.equal(view.describeError("/private/secret"), "目前無法取得新資料。請手動重新整理。");
});

test("cancelled pending page never replaces content; subsequent source failure leaves a clear stale view", async () => {
  let resolveRead, held = false, denied = false;
  const h = harness({ transport: { async read(scope, request, options) {
    if (denied) return { kind: "source_unavailable", code: "source_version_changed" };
    const value = { kind: "bound_history_observation", ...request, sourceVersion: token, sourceAuthenticated: false, publishable: false,
      cleanupConfirmed: true, history: await history(options.page) };
    return held ? new Promise(resolve => { resolveRead = () => resolve(value); }) : value;
  } } });
  await h.model.select("first"); const before = h.model.state().page; held = true;
  const pending = h.model.next(); await tick(); h.model.cancel(); assert.equal(h.model.state().busy, false);
  resolveRead(); await pending; assert.deepEqual(h.model.state().page, before);
  denied = true; await h.model.refresh(); assert.deepEqual(h.model.state().page, before); assert.equal(h.model.state().stale, true);
  assert.equal(h.model.state().error, "source_version_changed");
});

test("source switching releases known old binding before registering a new catalog and clears old content immediately", async () => {
  let resolveRelease;
  const h = harness({ transport: { release: () => new Promise(resolve => { resolveRelease = resolve; }) } });
  await h.model.select("first"); const pending = h.model.select("second");
  assert.equal(h.model.state().selected.catalogId, "second"); assert.equal(h.model.state().page, null); assert.equal(h.model.state().busy, true);
  assert.equal(h.calls.filter(c => c.kind === "register").length, 1);
  resolveRelease({ kind: "history_released", cleanupConfirmed: false }); await pending;
  assert.equal(h.model.state().selected.catalogId, "second"); assert.equal(h.model.state().cleanupPending, true);
  assert.equal(h.calls.filter(c => c.kind === "register").length, 2);
});

test("cancel is immediate and late registration from a different selection is released without publishing", async () => {
  const registrations = [];
  const h = harness({ transport: { register: (request, signal) => new Promise(resolve => registrations.push({ request, signal, resolve })) } });
  const old = h.model.select("first"); await tick(); const newer = h.model.select("second"); await tick();
  assert.equal(registrations[0].signal.aborted, true); registrations[1].resolve(h.registration("second", 2)); await newer;
  const retained = h.model.state().page; registrations[0].resolve(h.registration("first", 1)); await old;
  assert.equal(h.model.state().selected.catalogId, "second"); assert.deepEqual(h.model.state().page, retained);
  assert.deepEqual(h.calls.filter(c => c.kind === "release").map(c => c.request.generation), [1]);
  h.transport.register = (request, signal) => new Promise(resolve => registrations.push({ request, signal, resolve }));
  const pending = h.model.refresh(); await tick(); h.model.cancel(); assert.equal(h.model.state().busy, false);
  assert.equal(registrations.at(-1).signal.aborted, true); registrations.at(-1).resolve(h.registration("second", 2)); await pending;
  assert.deepEqual(h.model.state().page, retained); assert.equal(h.calls.filter(c => c.kind === "release").length, 1);
});

test("close clears pages and releases only the known binding; unconfirmed cleanup is never reported as success", async () => {
  const h = harness({ transport: { release: async () => { throw new Error("offline"); } } });
  await h.model.select("first"); await h.model.close();
  assert.equal(h.model.state().closed, true); assert.equal(h.model.state().selected, null); assert.equal(h.model.state().page, null);
  assert.equal(h.model.state().cleanupPending, true); await h.model.refresh(); assert.equal(h.calls.length, 2);
});

// A small DOM double exercises native DOM operations/events without a browser,
// jsdom, HTML parser or GUI. Attempts to create executable attributes fail.
class Element {
  constructor(tagName, ownerDocument) { this.tagName = tagName.toUpperCase(); this.ownerDocument = ownerDocument; this.children = []; this.attributes = {}; this.dataset = {}; this.listeners = {}; this._text = ""; }
  set textContent(value) { this._text = String(value); this.children = []; }
  get textContent() { return this._text + this.children.map(child => child.textContent).join(""); }
  set innerHTML(_) { assert.fail("untrusted text must never enter an HTML parser"); }
  set href(_) { assert.fail("source text must not become an active URL"); }
  set src(_) { assert.fail("source text must not initiate a fetch"); }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this._text = ""; this.children = children; }
  setAttribute(key, value) { assert.ok(!/^on|^href$|^src$/i.test(key)); this.attributes[key] = String(value); }
  addEventListener(event, listener) { (this.listeners[event] ??= []).push(listener); }
  dispatch(event) { for (const listener of this.listeners[event] ?? []) listener({ target: this }); }
}
function dom() { const doc = { createElement(tag) { return new Element(tag, doc); } }; return new Element("div", doc); }
const descendants = node => [node, ...node.children.flatMap(descendants)];
const action = (root, name) => descendants(root).find(e => e.dataset.action === name);

test("DOM viewer uses inert text/details, stable toolbar elements, accessible status and bounded message windows", async () => {
  const root = dom(), h = harness({ root }, view.create); const refresh = action(root, "refresh");
  assert.equal(refresh.disabled, true); action(root, "source:first").dispatch("click"); await tick(); await tick();
  assert.strictEqual(action(root, "refresh"), refresh); assert.equal(refresh.disabled, false);
  assert.equal(action(root, "source:first").attributes["aria-pressed"], "true");
  assert.ok(root.textContent.includes("<script>alert('never')</script>"));
  assert.ok(!descendants(root).some(e => ["SCRIPT", "A", "IFRAME", "IMG"].includes(e.tagName)));
  assert.equal(descendants(root).filter(e => e.tagName === "ARTICLE").length, 10);
  const select = descendants(root).find(e => e.tagName === "SELECT"); select.value = "25"; select.dispatch("change");
  await h.model.refresh(); assert.equal(descendants(root).filter(e => e.tagName === "ARTICLE").length, 10);
  action(root, "windowNext").dispatch("click"); assert.equal(h.model.state().messageStart, 10);
  assert.equal(descendants(root).filter(e => e.tagName === "ARTICLE").length, 10);
  assert.ok(descendants(root).some(e => e.attributes.role === "status" && e.attributes["aria-live"] === "polite"));
  assert.equal(root.attributes["aria-busy"], "false"); await h.model.close(); assert.equal(descendants(root).filter(e => e.tagName === "ARTICLE").length, 0);
});

test("message block/character/evidence caps bound DOM even for large trusted provider pages", async () => {
  const root = dom(), giant = "<img src='https://never.invalid'>" + "字".repeat(10000);
  const observation = { selectionDigest: token, messages: Array.from({ length: 25 }, () => ({ role: "assistant", originalTimestamp: null,
    blocks: Array.from({ length: 40 }, (_, i) => i % 2 ? { kind: "tool_use", name: "run", input: { command: giant } } : { kind: "text", text: giant }) })),
    tools: Array.from({ length: 100 }, () => ({ name: giant })), auxiliaryRecords: [], warnings: [] };
  const fakePages = () => {
    let loaded = false;
    return { reset() {}, cancel() {}, dispose() {}, refresh: async () => { loaded = true; return { kind: "applied" }; }, loadNext: async () => ({ kind: "applied" }), loadPrevious: async () => ({ kind: "applied" }),
      state: () => ({ scope: { bindingId: uuid(903), generation: 1 }, status: "ready", pages: loaded ? [{ offset: 0, limit: 25, observation }] : [],
        sourceVersion: token, messageCount: loaded ? 25 : 0, reachedEnd: true, startOffset: 0, nextOffset: 25 }) };
  };
  const h = harness({ root, createPages: fakePages }, view.create); await h.model.select("first");
  const nodes = descendants(root); assert.equal(nodes.filter(e => e.tagName === "ARTICLE").length, 10);
  assert.ok(nodes.length < 800); assert.ok(root.textContent.length < 65000);
  assert.ok(root.textContent.includes("長內容已縮短顯示")); assert.ok(root.textContent.includes("只顯示前 24 個內容區塊"));
  assert.ok(nodes.some(e => e.tagName === "DETAILS")); assert.ok(!nodes.some(e => e.tagName === "IMG"));
});

test("isolated preview markup preserves mark, accessibility media and excludes production/SW imports", () => {
  const html = fs.readFileSync(path.join(__dirname, "../public/history-preview.html"), "utf8"), css = fs.readFileSync(path.join(__dirname, "../public/history-preview.css"), "utf8");
  assert.match(html, /stepsemble-mark\.svg/); assert.match(html, /開發預覽/); assert.match(html, /來源未認證/);
  assert.doesNotMatch(html, /public\/app|src="\/app\.js|serviceWorker|\son[a-z]+=/);
  for (const query of ["prefers-reduced-motion", "prefers-reduced-transparency", "prefers-contrast", "max-width: 640px"]) assert.ok(css.includes(query));
  assert.ok(css.includes("system-ui")); assert.ok(css.includes("button:active"));
  const context = vm.createContext({ structuredClone, AbortController });
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../public/modules/history-view.js"), "utf8"), context);
  assert.equal(context.StepsembleHistoryView.describeError("unknown"), view.describeError("unknown"));
});

test("catalog transport shares bounded decoder, fixed path and exact metadata/authority validation", async () => {
  const make = value => transportModule.create({ origin: "https://synthetic.invalid", hostId, viewId, canonicalJSON, fetch: async (url, init) => {
    assert.equal(url, "https://synthetic.invalid/api/history/catalog"); assert.equal(init.method, "POST"); assert.equal(init.body, "{}");
    assert.equal(init.headers["X-Stepsemble-History-CSRF"], "1"); assert.equal(init.headers["X-Stepsemble-History-View"], viewId);
    return new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
  } });
  const good = { kind: "history_catalog", entries: catalog, sourceAuthenticated: false, publishable: false };
  assert.deepEqual(await make(good).catalog(), good);
  for (const mutate of [v => { v.sourceAuthenticated = true; }, v => { v.publishable = true; }, v => { v.extra = true; },
    v => { v.entries[0].sourcePath = "/private"; }, v => { v.entries[0].label = "x".repeat(121); }, v => { v.entries[0].description = "x".repeat(301); },
    v => { v.entries[0].label = ""; }, v => { v.entries[0].label = "name\n"; }, v => { v.entries[0].description = "hidden\u007f"; },
    v => { v.entries[0].catalogId = "../private"; }, v => { v.entries.push(v.entries[0]); }, v => { v.entries = new Array(257).fill(v.entries[0]); }]) {
    const value = structuredClone(good); mutate(value); await assert.rejects(make(value).catalog(), /history_response_invalid/);
  }
});

test("viewer catalog rejects empty labels and control characters before rendering", () => {
  for (const entry of [{ ...catalog[0], label: "" }, { ...catalog[0], label: "title\n" }, { ...catalog[0], description: "\u0000" }]) {
    assert.throws(() => harness({ catalog: [entry] }), /history_catalog_invalid/);
  }
});
