"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
const appSource = fs.readFileSync(path.join(root, "public", "app.js"), "utf8");
const contextUtils = require("../public/modules/context-usage.js");

function element({ valueNode = null } = {}) {
  const attributes = Object.create(null);
  const classes = new Set();
  return {
    textContent: "",
    dataset: Object.create(null),
    style: {
      values: Object.create(null),
      setProperty(name, value) { this.values[name] = String(value); },
    },
    classList: {
      toggle(name, enabled) {
        if (enabled) classes.add(name);
        else classes.delete(name);
      },
      contains(name) { return classes.has(name); },
    },
    setAttribute(name, value) { attributes[name] = String(value); },
    removeAttribute(name) { delete attributes[name]; },
    getAttribute(name) { return attributes[name]; },
    querySelector(selector) {
      return selector === ".context-value-strong" ? valueNode : null;
    },
    _attributes: attributes,
  };
}

function renderHarness({ unknown = "Unknown", unavailable = "Unavailable", notReported = "Not reported",
  lastReported = "Last reported", modelChanged = "Model changed", capacityUnknown = "Capacity unknown" } = {}) {
  const valueNode = element();
  const el = {
    contextDashboard: element({ valueNode }),
    contextProgress: element(),
    contextInlinePercent: element(),
    contextInfo: element(),
    contextUsed: element(),
    contextCapacity: element(),
    contextPercent: element(),
    contextInput: element(),
    contextOutput: element(),
    contextCacheHit: element(),
    contextCacheHitPercent: element(),
    contextCacheWrite: element(),
    contextDashboardStatus: element(),
    contextDashboardSummary: element(),
  };
  const translationCalls = [];
  const translationArgs = [];
  const sandbox = vm.createContext({
    el,
    CONTEXT_RING_CIRCUMFERENCE: 2 * Math.PI * 15.5,
    finiteNonNegative: contextUtils.finiteNonNegative,
    positiveFinite: contextUtils.positiveFinite,
    formatTokenCount: contextUtils.formatTokenCount,
    formatPercent: contextUtils.formatPercent,
    computeCacheHitRate: contextUtils.computeCacheHitRate,
    tKey(key, vars = {}) {
      translationCalls.push(key);
      translationArgs.push({ key, vars });
      return key === "contextDashboard.unknown" ? unknown
        : key === "contextDashboard.unavailable" ? unavailable
          : key === "contextDashboard.notReported" ? notReported
            : key === "contextDashboard.lastReported" ? lastReported
              : key === "contextDashboard.modelChanged" ? modelChanged
                : key === "contextDashboard.capacityUnknown" ? capacityUnknown
            : key === "contextDashboard.context" ? "Context"
              : key === "contextDashboard.details" ? "Usage details"
                : key;
    },
  });
  const start = appSource.indexOf("function renderContextDashboard()");
  const end = appSource.indexOf("/** Fetch exact current-context and cumulative session stats", start);
  assert.ok(start >= 0 && end > start, "renderContextDashboard source found");
  vm.runInContext(`
    let contextStats = null;
    let contextStatsState = "awaiting";
    let composerModelContextWindow = null;
    ${appSource.slice(start, end)}
    globalThis.__setContext = (stats, state = "ready", modelCapacity = null) => {
      contextStats = stats;
      contextStatsState = state;
      composerModelContextWindow = modelCapacity;
    };
    globalThis.__renderContextDashboard = renderContextDashboard;
  `, sandbox);
  return {
    ...sandbox,
    el,
    translationCalls,
    translationArgs,
    setContext: sandbox.__setContext,
    render: sandbox.__renderContextDashboard,
  };
}

function fullStats({ tokens = 45_000, capacity = 100_000, percent = 45 } = {}) {
  return {
    tokens: { input: tokens, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
    contextUsage: { tokens, contextWindow: capacity, percent },
    contextCapacity: capacity,
  };
}

test("the inline context trigger has a 44px hit target and keeps the percent outside details", () => {
  const html = fs.readFileSync(path.join(root, "public", "index.html"), "utf8");
  const css = fs.readFileSync(path.join(root, "public", "style.css"), "utf8");
  const triggerAt = html.indexOf('id="context-info"');
  const inlineAt = html.indexOf('id="context-inline-percent"');
  const popoverAt = html.indexOf('id="context-popover"');
  assert.ok(triggerAt >= 0 && inlineAt > triggerAt && popoverAt > inlineAt);
  const statusTag = html.match(/<p id="context-dashboard-status"[^>]*>/)?.[0] || "";
  assert.match(statusTag, /data-i18n-ignore/);
  assert.doesNotMatch(statusTag, /data-i18n-key/);
  assert.match(css, /#view-chat \.context-ring-btn\s*\{[^}]*height:\s*44px;[^}]*min-height:\s*44px;/s);
});

test("context dashboard keeps a numeric percentage visible, including a real zero", () => {
  const h = renderHarness();
  h.setContext(fullStats());
  h.render();
  assert.equal(h.el.contextInlinePercent.textContent, "45%");
  assert.equal(h.el.contextProgress.getAttribute("aria-valuenow"), "45");
  assert.equal(h.el.contextDashboard.dataset.contextState, "normal");

  h.setContext(fullStats({ tokens: 0, percent: 0 }));
  h.render();
  assert.equal(h.el.contextInlinePercent.textContent, "0%");
  assert.equal(h.el.contextProgress.getAttribute("aria-valuenow"), "0");
  assert.equal(h.el.contextDashboard.dataset.contextState, "normal");
});

test("last-observed context is marked approximate while live context stays compact", () => {
  const h = renderHarness({ lastReported: "最後回報" });
  h.setContext({ ...fullStats(), source: "last_observed", stale: true, observedAt: "2026-09-16T04:00:00.000Z" });
  h.render();
  assert.equal(h.el.contextInlinePercent.textContent, "~45%");
  assert.equal(h.el.contextDashboardStatus.textContent, "最後回報");
  const detail = h.translationArgs.find(call => call.key === "contextDashboard.lastReported");
  assert.equal(typeof detail?.vars?.time, "string");

  h.setContext({ ...fullStats(), source: "live", stale: false }, "ready");
  h.render();
  assert.equal(h.el.contextInlinePercent.textContent, "45%");
  assert.doesNotMatch(h.el.contextInlinePercent.textContent, /^~/);
});

test("unknown and unavailable context are localized and never rendered as zero", () => {
  const h = renderHarness({ unknown: "未知" });
  h.setContext(null, "awaiting");
  h.render();
  assert.equal(h.el.contextInlinePercent.textContent, "未知");
  assert.notEqual(h.el.contextInlinePercent.textContent, "0%");
  assert.equal(h.el.contextProgress.getAttribute("aria-valuenow"), undefined);
  assert.equal(h.el.contextDashboard.dataset.contextState, "unknown");
  assert.ok(h.translationCalls.includes("contextDashboard.unknown"));

  // A failed refresh must not leave the previously known percentage painted.
  h.setContext(fullStats(), "ready");
  h.render();
  assert.equal(h.el.contextInlinePercent.textContent, "45%");
  h.setContext(fullStats(), "unavailable");
  h.render();
  assert.equal(h.el.contextInlinePercent.textContent, "未知");
  assert.notEqual(h.el.contextInlinePercent.textContent, "45%");
  assert.equal(h.el.contextProgress.getAttribute("aria-valuenow"), undefined);
  assert.equal(h.el.contextDashboardStatus.textContent, "Unavailable");

  h.setContext({ ...fullStats({ percent: null }), source: "last_observed", stale: true, observedAt: "2026-09-16T04:00:00.000Z" }, "ready");
  h.render();
  assert.equal(h.el.contextInlinePercent.textContent, "未知");
  assert.notEqual(h.el.contextInlinePercent.textContent, "~未知");
});

test("a model mismatch cannot leak the newly selected model's capacity", () => {
  const h = renderHarness({ unknown: "Unknown", modelChanged: "Model changed" });
  h.setContext({
    tokens: { input: 45_000, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
    contextUsage: { tokens: 45_000, contextWindow: null, percent: null },
    contextCapacity: null,
    reason: "model_mismatch",
  }, "ready", 200_000);
  h.render();
  assert.equal(h.el.contextCapacity.textContent, "—");
  assert.equal(h.el.contextInlinePercent.textContent, "Unknown");
  assert.equal(h.el.contextDashboardStatus.textContent, "Model changed");
});

test("rendering never derives a percentage from cumulative token totals", () => {
  const h = renderHarness({ unknown: "Unknown" });
  h.setContext({
    // This is intentionally a cumulative/session total, not current context.
    tokens: { input: 45_000, output: 55_000, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
    contextUsage: { tokens: 45_000, contextWindow: 100_000, percent: null },
    contextCapacity: 100_000,
  }, "ready");
  h.render();
  assert.equal(h.el.contextInlinePercent.textContent, "Unknown");
  assert.equal(h.el.contextPercent.textContent, "—");
  assert.equal(h.el.contextProgress.getAttribute("aria-valuenow"), undefined);
});

function nativeContextHarness() {
  const render = renderHarness({ unknown: "Unknown" });
  const calls = [];
  const connection = {
    sid: "codex:readonly-thread",
    nativeCodex: true,
    nativeThreadId: "readonly-thread",
    codexModel: { id: "fixture-codex-fast", contextWindow: 100_000 },
    codexModelSelected: false,
  };
  const sandbox = vm.createContext({
    el: render.el,
    CONTEXT_RING_CIRCUMFERENCE: 2 * Math.PI * 15.5,
    finiteNonNegative: contextUtils.finiteNonNegative,
    positiveFinite: contextUtils.positiveFinite,
    normalizeWireUsage: contextUtils.normalizeWireUsage,
    formatTokenCount: contextUtils.formatTokenCount,
    formatPercent: contextUtils.formatPercent,
    computeCacheHitRate: contextUtils.computeCacheHitRate,
    tKey: render.tKey,
    encodeURIComponent,
    AbortController,
    queueMicrotask,
    api: async (requestPath, options) => {
      calls.push({ requestPath, options });
      return { contextTokens: 45_000, contextWindow: 100_000, contextPercent: 45 };
    },
    rpc: connection,
    viewGeneration: 11,
    apiBase: "/",
    updateComposerSummary() {},
    normalizeCodexModel() { return null; },
    renderContextDashboard: render.render,
  });
  const start = appSource.indexOf("function nativeContextRecord(");
  const end = appSource.indexOf("function contextStatsRequestIsCurrent(", start);
  assert.ok(start >= 0 && end > start, "native context helpers source found");
  vm.runInContext(`
    let contextStats = null;
    let contextStatsState = "awaiting";
    let composerModelContextWindow = null;
    let nativeContextRequest = null;
    let nativeContextRequestSequence = 0;
    const contextDashboardIdentity = () => ({ sid: rpc?.sid || null, generation: viewGeneration, base: apiBase });
    ${appSource.slice(start, end)}
    globalThis.__syncNativeContext = syncNativeContext;
    globalThis.__nativeContextPath = nativeContextPath;
    globalThis.__contextSnapshot = () => ({ contextStats, contextStatsState });
  `, sandbox);
  return { ...render, ...sandbox, connection, calls,
    sync: sandbox.__syncNativeContext,
    nativePath: sandbox.__nativeContextPath,
    snapshot: sandbox.__contextSnapshot,
  };
}

test("read-only Codex native context uses the safe context GET without mutation authority", async () => {
  const h = nativeContextHarness();
  assert.equal(h.nativePath(h.connection), "/api/codex/context?threadId=readonly-thread");
  assert.doesNotMatch(h.nativePath(h.connection), /mutation/);
  const before = structuredClone(h.connection);
  await h.sync(h.connection);
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].requestPath, "/api/codex/context?threadId=readonly-thread");
  assert.equal(h.calls[0].options.method, undefined, "context read must use the default GET");
  assert.deepEqual(h.connection, before, "read-only context observation must not mutate the Codex connection");
  assert.equal(h.snapshot().contextStats.contextUsage.percent, 45);
});

function openCodeCatalogHarness() {
  const calls = [];
  let resolveRequest = null;
  const connection = {
    sid: "opencode:fixture-session",
    nativeOpenCode: true,
    cwd: "/tmp/stepsemble-native-composer",
    openCodeModel: null,
    openCodeModelSelected: false,
    openCodeModels: [],
    openCodeModelsLoadedAt: 0,
    openCodeModelsRequest: null,
    openCodeContextSnapshot: null,
    connectionLost: false,
  };
  const context = vm.createContext({
    Date,
    encodeURIComponent,
    rpc: connection,
    viewGeneration: 1,
    apiBase: "/",
    openCodeContext: {
      modelIdentity(model) {
        return model?.providerID && model?.modelID ? `${model.providerID}/${model.modelID}` : null;
      },
    },
    normalizeOpenCodeModel(model) {
      if (!model?.providerID || !model?.modelID) return null;
      return { ...model, providerID: String(model.providerID), modelID: String(model.modelID), contextWindow: Number(model.contextWindow || model.limit?.context) || null };
    },
    applyOpenCodeModel(model) {
      connection.openCodeModel = model;
      calls.push({ type: "apply", model });
      return model;
    },
    applyOpenCodeContextStats() { calls.push({ type: "context" }); },
    api(requestPath) {
      calls.push({ type: "api", requestPath });
      return new Promise(resolve => { resolveRequest = resolve; });
    },
  });
  const start = appSource.indexOf("function syncOpenCodeModelCatalog(");
  const end = appSource.indexOf("// ACP advertises model choice", start);
  assert.ok(start >= 0 && end > start, "OpenCode catalog hydration source found");
  vm.runInContext(`
    ${appSource.slice(start, end)}
    globalThis.__sync = syncOpenCodeModelCatalog;
    globalThis.__setView = (nextRpc, nextGeneration, nextBase) => {
      rpc = nextRpc;
      viewGeneration = nextGeneration;
      apiBase = nextBase;
    };
  `, context);
  return {
    context,
    connection,
    calls,
    sync: context.__sync,
    resolve(value) {
      assert.ok(resolveRequest, "catalog request is in flight");
      const resolve = resolveRequest;
      resolveRequest = null;
      resolve(value);
    },
    setView: context.__setView,
  };
}

test("OpenCode catalog hydration is directory-scoped and coalesces repeated polls", async () => {
  const h = openCodeCatalogHarness();
  const first = h.sync(h.connection);
  const second = h.sync(h.connection);
  assert.strictEqual(first, second, "same connection shares one in-flight catalog request");
  assert.equal(h.calls.filter(call => call.type === "api").length, 1);
  assert.equal(h.calls.find(call => call.type === "api").requestPath, "/api/opencode/models?directory=%2Ftmp%2Fstepsemble-native-composer");
  h.resolve({ models: [{ providerID: "fixture-provider", modelID: "fixture-model", limit: { context: 100_000 } }] });
  await first;
  assert.equal(h.connection.openCodeModels[0].contextWindow, 100_000);
  await h.sync(h.connection);
  assert.equal(h.calls.filter(call => call.type === "api").length, 1, "a recent catalog is reused on later polls");
});

test("late OpenCode catalog responses cannot cross session, view-generation, or device scope", async () => {
  for (const mutate of [
    (h, other) => h.setView(other, 1, "/"),
    (h, other) => h.setView(h.connection, 2, "/"),
    (h, other) => h.setView(h.connection, 1, "/r/other-device"),
  ]) {
    const h = openCodeCatalogHarness();
    const other = { sid: "opencode:other", nativeOpenCode: true, cwd: h.connection.cwd };
    const pending = h.sync(h.connection);
    mutate(h, other);
    h.resolve({ models: [{ providerID: "fixture-provider", modelID: "late-model", limit: { context: 100_000 } }] });
    await pending;
    assert.deepEqual(h.connection.openCodeModels, [], "stale response is ignored");
    assert.equal(h.calls.some(call => call.type === "apply"), false);
  }
});

test("an in-flight catalog response cannot overwrite a newly selected OpenCode model", async () => {
  const h = openCodeCatalogHarness();
  const selected = { providerID: "fixture-provider", modelID: "new-model", contextWindow: 200_000 };
  const pending = h.sync(h.connection);
  h.connection.openCodeModelSelected = true;
  h.connection.openCodeModel = selected;
  h.resolve({ models: [{ providerID: "fixture-provider", modelID: "old-model", limit: { context: 100_000 } }] });
  await pending;
  assert.equal(h.connection.openCodeModel, selected, "poll hydration retains the selected identity");
  assert.equal(h.calls.some(call => call.type === "apply"), false, "old catalog identity cannot reselect the model");
});

function loadOpenCodeContext() {
  const modulePath = path.join(root, "public", "modules", "opencode-context.js");
  assert.ok(fs.existsSync(modulePath), "OpenCode context helper is part of the browser shell");
  return require(modulePath);
}

const OPEN_CODE_ID = Object.freeze({ providerID: "fixture-provider", modelID: "fixture-opencode-model" });

function assistantMessage(tokens, created, model = OPEN_CODE_ID) {
  return {
    role: "assistant",
    time: { created },
    info: { role: "assistant", time: { created }, model, tokens },
  };
}

test("OpenCode preserves capacity for an ID-only session model with the same identity", () => {
  const helper = loadOpenCodeContext();
  const catalogModel = helper.normalizeModel({ ...OPEN_CODE_ID, name: "Fixture OpenCode", limit: { context: 100_000, output: 8_000 } });
  const idOnly = helper.normalizeModel(OPEN_CODE_ID);
  assert.equal(helper.modelIdentity(catalogModel), helper.modelIdentity(idOnly));
  const merged = helper.mergeModel(idOnly, catalogModel);
  assert.equal(merged.contextWindow, 100_000);
  assert.equal(merged.outputLimit, 8_000);

  const snapshot = {
    session: { model: { ...OPEN_CODE_ID } },
    messages: [
      assistantMessage({ input: 10, output: 5, reasoning: 0, total: 15, cache: { read: 0, write: 0 } }, 1),
      assistantMessage({ input: 45_000, output: 0, reasoning: 0, total: 45_000, cache: { read: 0, write: 0 } }, 2),
    ],
  };
  const stats = helper.contextStatsFromSnapshot(snapshot, { modelCatalog: [catalogModel] });
  assert.equal(stats.state, "ready");
  assert.equal(stats.contextUsage.contextWindow, 100_000);
  assert.equal(stats.contextUsage.tokens, 45_000);
  assert.equal(stats.contextUsage.percent, 45);
});

test("OpenCode context helper distinguishes missing, partial, and real zero usage", () => {
  const helper = loadOpenCodeContext();
  const catalogModel = helper.normalizeModel({ ...OPEN_CODE_ID, limit: { context: 100_000 } });
  const options = { modelCatalog: [catalogModel] };

  const missing = helper.contextStatsFromSnapshot({ session: { model: OPEN_CODE_ID }, messages: [] }, options);
  assert.equal(missing.state, "unknown");
  assert.equal(missing.contextUsage.tokens, null);
  assert.equal(missing.contextUsage.contextWindow, null);
  assert.equal(missing.contextUsage.percent, null);

  const partial = helper.contextStatsFromSnapshot({
    session: { model: OPEN_CODE_ID },
    messages: [assistantMessage({ input: 12, output: 3 }, 1)],
  }, options);
  assert.equal(partial.state, "incomplete");
  assert.equal(partial.contextUsage.tokens, null);
  assert.equal(partial.contextUsage.percent, null);

  const zeroMessage = assistantMessage({ input: 0, output: 0, reasoning: 0, total: 0, cache: { read: 0, write: 0 } }, 1);
  zeroMessage.info.time.completed = 2;
  const zero = helper.contextStatsFromSnapshot({
    session: { model: OPEN_CODE_ID },
    messages: [zeroMessage],
  }, options);
  assert.equal(zero.state, "zero");
  assert.equal(zero.contextUsage.tokens, 0);
  assert.equal(zero.contextUsage.percent, 0);
});

test("OpenCode context helper uses the latest assistant turn, never a cumulative sum", () => {
  const helper = loadOpenCodeContext();
  const catalogModel = helper.normalizeModel({ ...OPEN_CODE_ID, limit: { context: 100_000 } });
  const stats = helper.contextStatsFromSnapshot({
    session: { model: OPEN_CODE_ID },
    messages: [
      assistantMessage({ input: 90_000, output: 10_000, reasoning: 0, total: 100_000, cache: { read: 0, write: 0 } }, 1),
      assistantMessage({ input: 45_000, output: 0, reasoning: 0, total: 45_000, cache: { read: 0, write: 0 } }, 2),
    ],
  }, { modelCatalog: [catalogModel] });
  assert.equal(stats.contextUsage.tokens, 45_000);
  assert.equal(stats.contextUsage.percent, 45);
  assert.notEqual(stats.contextUsage.percent, 100);
});
