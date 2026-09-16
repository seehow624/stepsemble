const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const context = require("../public/modules/opencode-context");

function assistant(id, created, info = {}) {
  return {
    info: {
      id,
      role: "assistant",
      time: { created },
      providerID: "provider-a",
      modelID: "model-a",
      ...info,
    },
    parts: [],
  };
}

test("OpenCode context module exposes its browser UMD global", () => {
  const window = {};
  const source = fs.readFileSync(path.join(__dirname, "..", "public", "modules", "opencode-context.js"), "utf8");
  vm.runInNewContext(source, { window, Object, String, Number, Date, Math, JSON, Array, RegExp });
  assert.equal(window.stepsembleOpenCodeContext.normalizeModel({ providerID: "p", modelID: "m" }).id, "m");
});

test("model normalization accepts OpenCode catalog and message identities", () => {
  const model = context.normalizeModel({
    provider: "provider-a",
    id: "model-a",
    name: "Model A",
    capabilities: { reasoning: true },
    limit: { context: 128000, output: 4096 },
  });
  assert.deepEqual({ providerID: model.providerID, modelID: model.modelID, contextWindow: model.contextWindow, outputLimit: model.outputLimit }, {
    providerID: "provider-a",
    modelID: "model-a",
    contextWindow: 128000,
    outputLimit: 4096,
  });
  assert.equal(context.modelIdentity(model), "provider-a/model-a");
  assert.equal(context.normalizeModel({ providerID: "provider-a", modelID: "" }), null);
  assert.equal(context.normalizeModel({ providerID: "provider-a", modelID: "model-a", limit: { context: -1 } }).contextWindow, null);
});

test("mergeModel preserves capacity only for the same identity", () => {
  const previous = context.normalizeModel({
    providerID: "provider-a", modelID: "model-a", name: "Known", limit: { context: 100000 },
    reasoning: true, attachment: true, variants: ["high"],
  });
  const polled = context.mergeModel(previous, { providerID: "provider-a", modelID: "model-a", name: "Known", limit: {} });
  assert.equal(polled.contextWindow, 100000);
  assert.equal(polled.name, "Known");
  assert.equal(polled.reasoning, true);
  assert.equal(polled.attachment, true);
  assert.deepEqual(polled.variants, ["high"]);

  // The browser normalizes session/model payloads before merging. Presence
  // metadata must survive that round trip so an ID-only payload does not erase
  // richer catalog capabilities from the prior same-identity model.
  const normalizedIdOnly = context.normalizeModel({ providerID: "provider-a", modelID: "model-a" });
  const mergedNormalized = context.mergeModel(previous, normalizedIdOnly);
  assert.equal(mergedNormalized.reasoning, true);
  assert.equal(mergedNormalized.attachment, true);
  assert.deepEqual(mergedNormalized.variants, ["high"]);

  const switched = context.mergeModel(previous, { providerID: "provider-b", modelID: "model-b", limit: {} });
  assert.equal(switched.contextWindow, null);
  assert.equal(context.modelIdentity(switched), "provider-b/model-b");
  assert.equal(context.mergeModel(previous, { providerID: "provider-a" }), null);
});

test("latest assistant selection is timestamp based and stable for ties", () => {
  const oldMessage = assistant("old", 100, { time: { created: 100, completed: 110 } });
  const latestMessage = assistant("latest", 200, {
    time: { created: 200, completed: 210 },
    tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
  });
  const selected = context.selectLatestAssistantMessage([latestMessage, oldMessage]);
  assert.equal(selected.info.id, "latest");

  const tieA = assistant("tie-a", 300);
  const tieB = assistant("tie-b", 300);
  assert.equal(context.selectLatestAssistantMessage([tieA, tieB]).info.id, "tie-b");
  assert.equal(context.selectLatestUsageMessage([{ info: { role: "assistant", time: { created: 500 } } }, latestMessage]).info.id, "latest");
  assert.equal(context.selectLatestAssistantMessage([{ info: { role: "user" } }]), null);
});

test("usage normalization follows OpenCode's five disjoint token components", () => {
  const complete = context.normalizeUsage({ input: 1, output: 2, reasoning: 3, cache: { read: 4, write: 5 } });
  assert.equal(complete.total, 15);
  assert.equal(complete.used, 15);
  assert.equal(complete.source, "components");
  assert.equal(complete.state, "ready");

  const reported = context.normalizeUsage({ total: 99, input: 1, output: 2, reasoning: 3, cache: { read: 4, write: 5 } });
  assert.equal(reported.total, 99);
  assert.equal(reported.used, 99);
  assert.equal(reported.totalKnown, true);

  const zero = context.normalizeUsage({ input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } });
  assert.equal(zero.state, "zero");
  assert.equal(zero.used, 0);

  const pendingZero = context.contextStatsFromSnapshot({
    messages: [assistant("pending", 1, {
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 }, total: 0 },
    })],
  }, { modelCatalog: [{ providerID: "provider-a", modelID: "model-a", limit: { context: 100 } }] });
  assert.equal(pendingZero.reason, "usage_pending");
  assert.equal(pendingZero.state, "unknown");
  assert.equal(pendingZero.contextUsage.percent, null);

  const completedZero = context.contextStatsFromSnapshot({
    messages: [assistant("completed-zero", 2, {
      time: { created: 2, completed: 3 },
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 }, total: 0 },
    })],
  }, { modelCatalog: [{ providerID: "provider-a", modelID: "model-a", limit: { context: 100 } }] });
  assert.equal(completedZero.state, "zero");
  assert.equal(completedZero.contextUsage.percent, 0);

  const partial = context.normalizeUsage({ input: 7, output: 2 });
  assert.equal(partial.state, "incomplete");
  assert.equal(partial.used, null);

  const missing = context.normalizeUsage({ input: -1, output: "not-a-number" });
  assert.equal(missing.state, "missing");
  assert.equal(missing.used, null);
});

test("context stats resolve capacity from the producing model, not a different selection", () => {
  const snapshot = {
    messages: [
      assistant("new", 200, {
        providerID: "provider-a",
        modelID: "model-a",
        tokens: { input: 10, output: 2, reasoning: 1, cache: { read: 7, write: 3 } },
      }),
      assistant("old", 100, {
        providerID: "provider-a",
        modelID: "model-a",
        tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
      }),
    ],
  };
  const catalog = [{ providerID: "provider-a", modelID: "model-a", limit: { context: 100 } }];
  const selected = { providerID: "provider-a", modelID: "model-a", contextWindow: null };
  const stats = context.contextStatsFromSnapshot(snapshot, { modelCatalog: catalog, selectedModel: selected });
  assert.equal(stats.available, true);
  assert.equal(stats.state, "ready");
  assert.equal(stats.usage.used, 23);
  assert.equal(stats.contextCapacity, 100);
  assert.equal(stats.contextUsage.percent, 23);
  assert.equal(stats.capacitySource, "catalog");
  assert.equal(stats.modelIdentity, "provider-a/model-a");

  const overWindow = context.contextStatsFromSnapshot({
    messages: [assistant("over", 300, {
      tokens: { input: 75, output: 25, reasoning: 0, cache: { read: 0, write: 0 } },
    })],
  }, { modelCatalog: [{ providerID: "provider-a", modelID: "model-a", limit: { context: 100 } }] });
  assert.equal(overWindow.contextUsage.percent, 100);

  const overWindowByTwo = context.contextStatsFromSnapshot({
    messages: [assistant("over-two", 400, {
      tokens: { input: 100, output: 50, reasoning: 0, cache: { read: 0, write: 0 } },
    })],
  }, { modelCatalog: [{ providerID: "provider-a", modelID: "model-a", limit: { context: 100 } }] });
  assert.equal(overWindowByTwo.contextUsage.percent, 150);

  const catalogWithoutCapacity = context.contextStatsFromSnapshot(snapshot, {
    modelCatalog: [{ providerID: "provider-a", modelID: "model-a" }],
    selectedModel: { providerID: "provider-a", modelID: "model-a", contextWindow: 200 },
  });
  assert.equal(catalogWithoutCapacity.contextCapacity, 200);
  assert.equal(catalogWithoutCapacity.capacitySource, "selected");

  const mismatch = context.contextStatsFromSnapshot(snapshot, {
    modelCatalog: catalog,
    selectedModel: { providerID: "provider-b", modelID: "model-b", contextWindow: 1000 },
  });
  assert.equal(mismatch.available, true);
  assert.equal(mismatch.reason, "model_mismatch");
  assert.equal(mismatch.contextCapacity, null);
  assert.equal(mismatch.contextUsage.percent, null);
});

test("context stats stay unknown for missing, incomplete, or unidentifiable data", () => {
  const noAssistant = context.contextStatsFromSnapshot({ messages: [] });
  assert.equal(noAssistant.state, "unknown");
  assert.equal(noAssistant.reason, "no_assistant");
  assert.equal(noAssistant.contextUsage.tokens, null);

  const missingUsage = context.contextStatsFromSnapshot({ messages: [assistant("missing", 1)] });
  assert.equal(missingUsage.state, "unknown");
  assert.equal(missingUsage.reason, "usage_missing");
  assert.equal(missingUsage.available, false);

  const incomplete = context.contextStatsFromSnapshot({ messages: [assistant("partial", 1, {
    tokens: { input: 12, output: 2 },
  })] });
  assert.equal(incomplete.state, "incomplete");
  assert.equal(incomplete.reason, "usage_incomplete");
  assert.equal(incomplete.contextUsage.tokens, null);

  const unknownModel = context.contextStatsFromSnapshot({ messages: [assistant("modelless", 1, {
    providerID: null,
    modelID: null,
    tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
  })] });
  assert.equal(unknownModel.state, "unknown");
  assert.equal(unknownModel.reason, "model_unknown");
  assert.equal(unknownModel.contextCapacity, null);
});

test("catalog capacity never crosses provider/model identities", () => {
  const snapshot = { messages: [assistant("one", 1, {
    providerID: "provider-a",
    modelID: "model-a",
    tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
  })] };
  const stats = context.contextStatsFromSnapshot(snapshot, {
    modelCatalog: [{ providerID: "provider-a", modelID: "model-other", limit: { context: 999 } }],
  });
  assert.equal(stats.contextCapacity, null);
  assert.equal(stats.contextUsage.percent, null);
  assert.equal(stats.reason, "capacity_unknown");
});
