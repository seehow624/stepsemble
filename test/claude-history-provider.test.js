"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");

const provider = require("../public/modules/claude-history");
const value = require("../public/modules/claude-history-value");
const pages = require("../public/modules/history-pages");
const projection = require("../public/modules/projection");
const fixture = require("../protocol/native/claude/history-fixture.cjs");
const { parseHistoryBytes } = require("../protocol/native/claude/history-source");
const { selectHistory } = require("../protocol/native/claude/history-selection");

const UUID = fixture.uuid;
const SOURCE_TOKEN = "a".repeat(64);
const richCases = fixture.richCases("/synthetic/workspace");
const defaultCase = richCases[0];
const page = { offset: 0, limit: 100 };
const clone = input => JSON.parse(JSON.stringify(input));
const encode = input => new TextEncoder().encode(JSON.stringify(input));
const bytesOf = rows => Buffer.from(`${rows.map(row => JSON.stringify(row)).join("\n")}\n`);
const bad = (input, mutate) => { const output = clone(input); mutate(output); return output; };

/**
 * Synthetic stand-in only. The selected rows come from the existing fixture
 * and the native source parser; this test never imports the SDK or invokes a
 * CLI/model. `selectHistory` is used only to construct a reviewed provider
 * value for the pure browser-safe decoder.
 */
async function historyFor(testCase, requestedPage = page) {
  const parsed = parseHistoryBytes(bytesOf(testCase.records), testCase.sessionId);
  assert.equal(parsed.kind, "source_records");
  const snapshot = {
    ...parsed,
    kind: "source_snapshot",
    identity: { device: "1", inode: "2", size: parsed.byteLength, mtimeNs: "3", ctimeNs: "4" },
    checks: { owner: "posix_euid_and_mode", reads: 2, matchingBytes: true, unchangedObservedIdentity: true },
    sourceAuthenticated: false,
    publishable: false,
  };
  return selectHistory(snapshot, requestedPage, async (sessionId, options) => {
    const projectKey = options.dir.replace(/[^a-zA-Z0-9]/g, "-");
    await options.sessionStore.load({ projectKey, sessionId });
    return fixture.selectedRows(testCase).slice(requestedPage.offset, requestedPage.offset + requestedPage.limit);
  });
}

function makeClient(canonicalJSON = projection.canonicalJSON) {
  return provider.create({ canonicalJSON });
}

function scopeFor(testCase = defaultCase) {
  return { hostId: "synthetic-host", bindingId: UUID(9000), generation: 1, sessionId: testCase.sessionId };
}

function boundReply(call, history) {
  return {
    kind: "bound_history_observation",
    bindingId: call.bindingId,
    generation: call.generation,
    requestId: call.requestId,
    sourceVersion: SOURCE_TOKEN,
    sourceAuthenticated: false,
    publishable: false,
    cleanupConfirmed: true,
    history,
  };
}

function loadBrowserModules() {
  const context = vm.createContext({
    TextEncoder,
    TextDecoder,
    Uint8Array,
    structuredClone,
    AbortController,
  });
  for (const name of ["projection.js", "claude-history-value.js", "claude-history.js", "history-pages.js"])
    vm.runInContext(fs.readFileSync(path.join(__dirname, "../public/modules", name), "utf8"), context, { filename: name });
  return context;
}

test("READER and LIMITS are frozen reviewed constants, without SDK/CLI/model imports", () => {
  assert.deepEqual(provider.READER, {
    sdkVersion: "0.3.259",
    nativeVersion: "2.1.259",
    sdkSha256: "7fa7c212361864544e775e7551519e790515f95d4bb6a4831b0b05f5b368a0c5",
    selection: "snapshot_session_store",
  });
  assert.deepEqual(provider.LIMITS, {
    historyBytes: 256 * 1024,
    sourceBytes: 8 * 1024 * 1024,
    sourceRecords: 2000,
    pageMessages: 100,
  });
  assert.equal(Object.isFrozen(provider.READER), true);
  assert.equal(Object.isFrozen(provider.LIMITS), true);
  assert.throws(() => { provider.READER.sdkVersion = "drifted"; }, TypeError);
  assert.throws(() => { provider.LIMITS.historyBytes = 1; }, TypeError);
  assert.equal(provider.READER.sdkVersion, "0.3.259");
  assert.equal(value.validObservation instanceof Function, true);
});

test("rich synthetic pages pass the independent provider predicate and parse into detached values", async () => {
  const client = makeClient();
  for (const testCase of richCases) {
    const history = await historyFor(testCase);
    assert.equal(provider.validHistoryValue(history, testCase.sessionId, page), true);
    assert.equal(client.validateHistory(history, testCase.sessionId, page), true);
    const parsed = client.parseHistory(history, testCase.sessionId, page);
    assert.deepEqual(parsed, history);
    assert.notStrictEqual(parsed, history);
    assert.notStrictEqual(parsed.source, history.source);
    assert.notStrictEqual(parsed.observation, history.observation);
    parsed.reader.sdkVersion = "caller-mutated-output";
    assert.equal(history.reader.sdkVersion, provider.READER.sdkVersion);
    parsed.observation.warnings.push("caller-mutated-output");
    assert.equal(history.observation.warnings.includes("caller-mutated-output"), false);
    history.observation.authority.resumeAllowed = true;
    assert.equal(parsed.observation.authority.resumeAllowed, false);
  }
});

test("provider enforces the exact shared envelope, source, reader, metrics and authority shapes", async () => {
  const client = makeClient();
  const history = await historyFor(defaultCase);
  const invalid = [
    h => { h.extra = true; },
    h => { delete h.kind; },
    h => { h.source.extra = true; },
    h => { delete h.source.identity.device; },
    h => { h.source.identity.inode = "0"; },
    h => { h.source.checks.reads = 1; },
    h => { h.reader.sdkSha256 = "b".repeat(64); },
    h => { h.reader.selection = "live_model_session"; },
    h => { h.metrics.mappingMs = -1; },
    h => { h.metrics.maxRssKiB = Infinity; },
    h => { h.page.offset = 1; },
    h => { h.source.sourceAuthenticated = true; },
    h => { h.publishable = true; },
    h => { h.observation.authority.approvalAcknowledged = true; },
    h => { h.observation.warnings = [...h.observation.warnings, "unreviewed-warning"]; },
    h => { h.observation.warnings = [...h.observation.warnings, h.observation.warnings[0] ?? "opaque_thinking"]; },
  ];
  for (const mutate of invalid) {
    const candidate = bad(history, mutate);
    assert.equal(provider.validHistoryValue(candidate, defaultCase.sessionId, page), false);
    assert.equal(client.validateHistory(candidate, defaultCase.sessionId, page), false);
    assert.equal(client.parseHistory(candidate, defaultCase.sessionId, page), null);
  }
});

test("nested content, tool pointers, auxiliary records and reported API errors remain fail-closed", async () => {
  const client = makeClient();
  const toolHistory = await historyFor(richCases.find(testCase => testCase.name === "rich"));
  const fileHistory = await historyFor(richCases.find(testCase => testCase.name === "file-history"));
  assert.equal(fileHistory.observation.auxiliaryRecords.length, 4);
  assert.equal(toolHistory.observation.messages.some(message => message.metadata.apiError === true), true);
  const tool = toolHistory.observation.tools.find(entry => entry.result !== null);
  assert.ok(tool);
  const toolMutations = [
    h => { h.observation.tools[0].request.blockIndex = 999; },
    h => { h.observation.tools.find(entry => entry.nativeToolId === tool.nativeToolId).result.messageId = UUID(999); },
    h => { h.observation.tools.find(entry => entry.nativeToolId === tool.nativeToolId).observation = "complete"; },
    h => { h.observation.messages.find(message => message.metadata.apiError === true).metadata.errorCode = "../private"; },
    h => { h.observation.messages.find(message => message.metadata.apiError === true).metadata.unreviewed = true; },
    h => { h.observation.messages.find(message => message.nativeMessageId === tool.request.messageId).blocks[tool.request.blockIndex].kind = "tool_result"; },
    h => {
      const resultPointer = h.observation.tools.find(entry => entry.nativeToolId === tool.nativeToolId).result;
      const block = h.observation.messages.find(message => message.nativeMessageId === resultPointer.messageId).blocks[resultPointer.blockIndex];
      block.content[0].kind = "thinking";
    },
    h => { h.observation.tools.push(clone(h.observation.tools[0])); },
  ];
  for (const mutate of toolMutations) {
    const candidate = bad(toolHistory, mutate);
    assert.equal(client.validateHistory(candidate, toolHistory.source.sessionId, page), false);
    assert.equal(client.parseHistory(candidate, toolHistory.source.sessionId, page), null);
  }
  const auxiliaryMutations = [
    h => { h.observation.auxiliaryRecords[0].recordIndex = h.observation.auxiliaryRecords[1].recordIndex; },
    h => { h.observation.auxiliaryRecords[0].nativeDigest = "not-a-sha256"; },
    h => { h.observation.auxiliaryRecords[0].referenceIds.push(UUID(999), UUID(998)); },
  ];
  for (const mutate of auxiliaryMutations) {
    const candidate = bad(fileHistory, mutate);
    assert.equal(client.validateHistory(candidate, fileHistory.source.sessionId, page), false);
    assert.equal(client.parseHistory(candidate, fileHistory.source.sessionId, page), null);
  }
});

test("scope and page inputs are detached, bounded and required before provider parsing", async () => {
  const client = makeClient();
  const history = await historyFor(defaultCase);
  const badSessionIds = ["not-a-uuid", "", null, {}, fixture.otherSessionId];
  for (const sessionId of badSessionIds) {
    assert.equal(client.validateHistory(history, sessionId, page), false);
    assert.equal(client.parseHistory(history, sessionId, page), null);
  }
  const badPages = [
    null,
    {},
    { offset: -1, limit: 1 },
    { offset: 2001, limit: 1 },
    { offset: 0, limit: 0 },
    { offset: 0, limit: 101 },
    { offset: 0, limit: 1, extra: true },
  ];
  for (const invalidPage of badPages) {
    assert.equal(provider.validHistoryValue(history, defaultCase.sessionId, invalidPage), false);
    assert.equal(client.validateHistory(history, defaultCase.sessionId, invalidPage), false);
    assert.equal(client.parseHistory(history, defaultCase.sessionId, invalidPage), null);
  }
  const inputPage = { offset: 0, limit: 100 };
  const parsed = client.parseHistory(history, defaultCase.sessionId, inputPage);
  inputPage.offset = 2000;
  assert.equal(parsed.page.offset, 0);
  assert.throws(() => provider.create({}), /history_json_validator_required/);
});

test("getter, cycle and non-JSON values are rejected without invoking accessors", async () => {
  const client = makeClient();
  const history = await historyFor(defaultCase);
  let getterCalls = 0;
  const accessor = clone(history);
  Object.defineProperty(accessor, "kind", {
    enumerable: true,
    get() { getterCalls++; return "source_history_observation"; },
  });
  assert.equal(client.parseHistory(accessor, defaultCase.sessionId, page), null);
  assert.equal(getterCalls, 0);

  const cycle = clone(history);
  cycle.observation.cycle = cycle;
  assert.equal(client.parseHistory(cycle, defaultCase.sessionId, page), null);

  for (const invalid of [undefined, function noWireFunctions() {}, Symbol("wire"), 1n, NaN, Infinity, new Date(), new Map()]) {
    const candidate = clone(history);
    candidate.metrics.selectionMs = invalid;
    assert.equal(client.validateHistory(candidate, defaultCase.sessionId, page), false);
    assert.equal(client.parseHistory(candidate, defaultCase.sessionId, page), null);
  }
  const pageCycle = { offset: 0, limit: 100 };
  pageCycle.self = pageCycle;
  assert.equal(client.parseHistory(history, defaultCase.sessionId, pageCycle), null);
});

test("raw decoder caps bytes and rejects BOM, fatal UTF-8, multi-frame, malformed, surrogate and partial input", async () => {
  const client = makeClient();
  const history = await historyFor(defaultCase);
  const valid = encode(history);
  assert.deepEqual(client.decodeHistory(valid, defaultCase.sessionId, page), history);
  assert.equal(client.decodeHistory(new Uint8Array(provider.LIMITS.historyBytes + 1), defaultCase.sessionId, page), null);
  assert.equal(client.decodeHistory(Uint8Array.from([0xc3, 0x28]), defaultCase.sessionId, page), null);
  assert.equal(client.decodeHistory(Uint8Array.from([0xef, 0xbb, 0xbf, ...valid]), defaultCase.sessionId, page), null);
  assert.equal(client.decodeHistory(encode(history).subarray(0, -1), defaultCase.sessionId, page), null);
  assert.equal(client.decodeHistory(new TextEncoder().encode(`${JSON.stringify(history)}\n${JSON.stringify(history)}`), defaultCase.sessionId, page), null);
  assert.equal(client.decodeHistory(new TextEncoder().encode("{malformed"), defaultCase.sessionId, page), null);
  const loneSurrogate = clone(history);
  const textMessage = loneSurrogate.observation.messages.find(message => message.blocks.some(block => block.kind === "text"));
  textMessage.blocks.find(block => block.kind === "text").text = "\ud800";
  assert.equal(client.decodeHistory(encode(loneSurrogate), defaultCase.sessionId, page), null);
  assert.equal(client.decodeHistory(valid, defaultCase.sessionId, { offset: 0, limit: 101 }), null);
  assert.equal(client.decodeHistory({}, defaultCase.sessionId, page), null);
});

test("source/message/tool/auxiliary caps are independent and never trim to a superficially valid page", async () => {
  const client = makeClient();
  const history = await historyFor(defaultCase);
  const capCases = [
    h => { h.source.recordCount = provider.LIMITS.sourceRecords + 1; },
    h => { h.source.byteLength = provider.LIMITS.sourceBytes + 1; h.source.identity.size = h.source.byteLength; },
    h => { h.source.identity.size = h.source.byteLength + 1; },
    h => { h.page.offset = provider.LIMITS.sourceRecords + 1; },
    h => { h.page.limit = provider.LIMITS.pageMessages + 1; },
    h => { h.observation.messages = new Array(page.limit + 1).fill(h.observation.messages[0]); },
    h => { h.observation.tools = new Array(4001).fill({}); },
    h => { h.observation.auxiliaryRecords = new Array(h.source.recordCount + 1).fill({}); },
    h => {
      const textMessage = h.observation.messages.find(message => message.blocks.some(block => block.kind === "text"));
      textMessage.blocks.find(block => block.kind === "text").text = "x".repeat(524289);
    },
  ];
  for (const mutate of capCases) {
    const candidate = bad(history, mutate);
    assert.equal(client.validateHistory(candidate, defaultCase.sessionId, page), false);
    assert.equal(client.parseHistory(candidate, defaultCase.sessionId, page), null);
  }
  const oversized = clone(history);
  const textMessage = oversized.observation.messages.find(message => message.blocks.some(block => block.kind === "text"));
  textMessage.blocks.find(block => block.kind === "text").text = "x".repeat(provider.LIMITS.historyBytes);
  assert.equal(client.parseHistory(oversized, defaultCase.sessionId, page), null);
});

test("Node history-pages controller validates with the real provider, not the legacy Node wire bridge", async () => {
  const history = await historyFor(defaultCase);
  let validations = 0;
  const calls = [];
  const api = pages.create({
    canonicalJSON: projection.canonicalJSON,
    validateHistory: (candidate, sessionId, requestedPage) => {
      validations++;
      return makeClient().validateHistory(candidate, sessionId, requestedPage);
    },
    requestId: () => UUID(9001),
    read: async (scope, request, options) => {
      calls.push({ scope, request, options });
      return boundReply(request, history);
    },
  });
  assert.deepEqual(api.reset(scopeFor(defaultCase)), { kind: "applied" });
  assert.deepEqual(await api.refresh(page), { kind: "applied" });
  assert.equal(validations, 1);
  assert.equal(calls.length, 1);
  assert.equal(api.state().status, "ready");
  assert.equal(api.state().publishable, false);
  assert.ok(api.state().pages[0].observation.authority);
  assert.ok(Object.values(api.state().pages[0].observation.authority).every(entry => entry === false));
});

test("browser-language provider and controller match Node outcomes with only Web primitives", async () => {
  const browser = loadBrowserModules();
  assert.equal(browser.Buffer, undefined);
  assert.equal(browser.process, undefined);
  assert.equal(browser.require, undefined);
  const browserProvider = browser.StepsembleClaudeHistory.create({ canonicalJSON: browser.StepsembleProjection.canonicalJSON });
  const nodeClient = makeClient();
  const history = await historyFor(defaultCase);
  const browserValid = browserProvider.validateHistory(history, defaultCase.sessionId, page);
  assert.equal(browserValid, true);
  assert.equal(browserValid, nodeClient.validateHistory(history, defaultCase.sessionId, page));
  const browserBytes = new browser.Uint8Array(encode(history));
  const browserDecoded = browserProvider.decodeHistory(browserBytes, defaultCase.sessionId, page);
  assert.deepEqual(JSON.parse(JSON.stringify(browserDecoded)), history);

  const invalidCases = [
    [bad(history, h => { h.reader.nativeVersion = "2.1.260"; }), false],
    [bad(history, h => { h.observation.authority.resumeAllowed = true; }), false],
    [bad(history, h => { h.observation.messages[0].blocks[0].nativeDigest = "bad"; }), false],
    [bad(history, h => { h.source.checks.matchingBytes = false; }), false],
  ];
  for (const [candidate, expected] of invalidCases) {
    assert.equal(nodeClient.validateHistory(candidate, defaultCase.sessionId, page), expected);
    assert.equal(browserProvider.validateHistory(candidate, defaultCase.sessionId, page), expected);
  }
  const browserPages = browser.StepsembleHistoryPages;
  let validations = 0;
  const browserApi = browserPages.create({
    canonicalJSON: browser.StepsembleProjection.canonicalJSON,
    validateHistory: (candidate, sessionId, requestedPage) => {
      validations++;
      return browserProvider.validateHistory(candidate, sessionId, requestedPage);
    },
    requestId: () => UUID(9010),
    read: async (scope, request, options) => boundReply(request, history),
  });
  assert.equal(browserApi.reset(scopeFor(defaultCase)).kind, "applied");
  assert.equal((await browserApi.refresh(page)).kind, "applied");
  assert.equal(validations, 1);
  assert.equal(browserApi.state().status, "ready");
  assert.equal(browserApi.state().publishable, false);
  assert.equal(browserApi.state().messageCount, history.observation.messages.length);
});
