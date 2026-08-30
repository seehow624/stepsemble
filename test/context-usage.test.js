const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const context = require("../public/modules/context-usage.js");

const root = path.resolve(__dirname, "..");

test("get_session_stats mapping preserves context usage and all cumulative token fields", () => {
  const result = context.normalizeSessionStats({
    sessionFile: "/safe/session.jsonl",
    sessionId: "session-1",
    userMessages: 4,
    assistantMessages: 3,
    toolCalls: 2,
    toolResults: 2,
    totalMessages: 9,
    tokens: { input: 120, output: 45, cacheRead: 300, cacheWrite: 15, total: 480 },
    cost: 1.25,
    contextUsage: { tokens: 42_000, contextWindow: 1_000_000, percent: 4.2 },
  });
  assert.equal(result.available, true);
  assert.deepEqual(result.tokens, { input: 120, output: 45, cacheRead: 300, cacheWrite: 15, total: 480 });
  assert.deepEqual(result.contextUsage, { tokens: 42_000, contextWindow: 1_000_000, percent: 4.2 });
  assert.equal(result.contextCapacity, 1_000_000);
  assert.equal(result.cacheHitPercent, 68.96551724137932);
  assert.equal(result.cost, 1.25);
  assert.equal(context.formatTokenCount(1_000_000), "1M");
  assert.equal(context.formatPercent(4.2), "4.2%");
});

test("cache hit rate uses prompt/cache accounting and not output or context capacity", () => {
  assert.equal(context.computeCacheHitRate({ input: 100, output: 9_999, cacheRead: 300, cacheWrite: 100 }), 60);
  assert.equal(context.computeCacheHitRate({ input: 0, output: 20, cacheRead: 0, cacheWrite: 0 }), null);
  assert.equal(context.computeCacheHitRate({ input: 100, cacheRead: 100 }), null);
});

test("null context values after compaction stay unknown while model capacity remains known", () => {
  const result = context.normalizeSessionStats({
    tokens: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, total: 15 },
    contextUsage: { tokens: null, contextWindow: null, percent: null },
  }, 1_000_000);
  assert.deepEqual(result.contextUsage, { tokens: null, contextWindow: null, percent: null });
  assert.equal(result.contextCapacity, 1_000_000);
  assert.equal(context.mergeContextCapacity({ contextWindow: 0 }, 1_000_000), 1_000_000);
  assert.equal(result.cacheHitPercent, 0);
  assert.equal(context.formatTokenCount(result.contextUsage.tokens), "—");
  assert.equal(context.formatPercent(result.contextUsage.percent), "—");
  // There must be no helper path that derives a percent from cumulative totals.
  assert.equal(context.computeCacheHitRate(result.tokens), 0);
});

test("zeros, old wire objects, and malformed usage are handled without invented values", () => {
  const zeros = context.normalizeSessionStats({
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    contextUsage: { tokens: 0, contextWindow: 1_000_000, percent: 0 },
  });
  assert.equal(zeros.available, true);
  assert.deepEqual(zeros.tokens, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 });
  assert.equal(zeros.cacheHitPercent, null);
  assert.equal(context.formatTokenCount(0), "0");
  assert.equal(context.formatPercent(0), "0%");

  assert.deepEqual(context.normalizeWireUsage({ tokens: 37, cost: 0.2 }), { tokens: 37, cost: 0.2 });
  assert.equal(context.normalizeWireUsage({ input: -1, output: "not-a-number" }), null);
  const partial = context.normalizeSessionStats({ tokens: { input: 8 }, contextUsage: {} });
  assert.equal(partial.tokens.input, 8);
  assert.equal(partial.tokens.output, null);
  assert.equal(partial.contextUsage.tokens, null);
});

test("history and live usage adapters retain exact component fields and legacy totals", () => {
  const raw = {
    input: 11,
    output: 7,
    cacheRead: 13,
    cacheWrite: 17,
    totalTokens: 48,
    cost: { input: 0.11, output: 0.07, cacheRead: 0.013, cacheWrite: 0.017, total: 0.21 },
  };
  const wire = context.normalizeWireUsage(raw);
  assert.equal(wire.input, 11);
  assert.equal(wire.output, 7);
  assert.equal(wire.cacheRead, 13);
  assert.equal(wire.cacheWrite, 17);
  assert.equal(wire.totalTokens, 48);
  assert.equal(wire.tokens, 48);
  assert.deepEqual(wire.cost, raw.cost);

  const totals = context.createUsageTotals();
  context.addUsageTotals(totals, raw);
  context.addUsageTotals(totals, { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, totalTokens: 10, cost: { total: 0.5 } });
  const aggregate = context.usageTotalsToWire(totals);
  assert.deepEqual({
    input: aggregate.input,
    output: aggregate.output,
    cacheRead: aggregate.cacheRead,
    cacheWrite: aggregate.cacheWrite,
    totalTokens: aggregate.totalTokens,
    tokens: aggregate.tokens,
  }, { input: 12, output: 9, cacheRead: 16, cacheWrite: 21, totalTokens: 58, tokens: 58 });
  assert.equal(aggregate.cost.input, 0.11);
  assert.equal(aggregate.cost.total, 0.71);
});

test("stats request identity rejects stale session, view, or device responses", () => {
  const request = { sid: "sid-a", generation: 3, base: "/r/device-a" };
  assert.equal(context.isContextRequestCurrent(request, { sid: "sid-a", generation: 3, base: "/r/device-a" }), true);
  assert.equal(context.isContextRequestCurrent(request, { sid: "sid-b", generation: 3, base: "/r/device-a" }), false);
  assert.equal(context.isContextRequestCurrent(request, { sid: "sid-a", generation: 4, base: "/r/device-a" }), false);
  assert.equal(context.isContextRequestCurrent(request, { sid: "sid-a", generation: 3, base: "" }), false);
});

test("context sync lifecycle and responsive composer wiring are event-driven", () => {
  const app = fs.readFileSync(path.join(root, "public", "app.js"), "utf8");
  const html = fs.readFileSync(path.join(root, "public", "index.html"), "utf8");
  const css = fs.readFileSync(path.join(root, "public", "style.css"), "utf8");
  const server = fs.readFileSync(path.join(root, "server.js"), "utf8");
  const sw = fs.readFileSync(path.join(root, "public", "sw.js"), "utf8");
  const syncStart = app.indexOf("function syncSessionStats");
  const sync = app.slice(syncStart, app.indexOf("function makeMsgShell", syncStart));
  assert.match(sync, /get_session_stats/);
  assert.doesNotMatch(sync, /setInterval/);
  assert.match(app, /void syncSessionStats\(rpc\?\.sid\)/);
  assert.match(app, /case "message_end"[\s\S]*?void syncSessionStats\(eventSid\)/);
  assert.match(app, /case "compaction_end"[\s\S]*?void syncSessionStats\(eventSid\)/);
  assert.match(app, /case "agent_settled"[\s\S]*?void syncSessionStats\(eventSid\)/);
  assert.match(app, /active\.needsRefresh = true/);
  assert.match(app, /contextStatsRequestIsCurrent/);
  assert.match(server, /addUsageTotals\(usageTotals, msg\.usage\)/);
  assert.match(server, /wire\.usage = usage/);
  assert.match(server, /usageTotalsToWire/);
  const appVersion = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version;
  assert.match(sw, new RegExp(`modules/context-usage\\.js\\?v=${appVersion.replaceAll(".", "\\.")}`));

  const model = html.indexOf('id="btn-model"');
  const abort = html.indexOf('id="btn-abort"');
  const send = html.indexOf('id="btn-send"');
  assert.ok(model > 0 && model < abort && abort < send, "model control must stay beside Send/Stop");
  assert.match(html, /id="context-dashboard"/);
  assert.match(html, /id="context-info"[^>]*aria-expanded="false"/);
  assert.match(html, /id="context-popover" class="context-popover hidden"/);
  // Fixed-width chip: name truncates, the trailing thinking level stays visible.
  assert.match(html, /id="composer-model-name"/);
  assert.match(html, /id="composer-model-level"/);
  assert.match(css, /\.composer-model-control[^}]*width: var\(--composer-model-w/);
  assert.match(css, /\.composer-model-name[^}]*text-overflow: ellipsis/);
  assert.match(css, /\.composer-model-level[^}]*flex: 0 0 auto/);
  assert.match(css, /\.context-popover/);
  assert.match(css, /\.context-info-wrap[^}]*position: relative/);
  assert.match(css, /@media \(max-width: 979px\)/);
  assert.match(css, /#view-chat \{ min-width: 0; overflow-x: hidden; \}/);
});
