"use strict";

// The allowance Codex reads is the ChatGPT subscription it is signed in to
// ("Pro Lite" is ChatGPT's plan): Limits shows it as ChatGPT, with ChatGPT's
// mark, as it shows Claude's as Claude and not Claude Code. Other services
// keep their own names, and so does a Host that names no service.
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path");
const { quotaName, combineQuotas } = require("../public/modules/usage-data");
const read = file => fs.readFileSync(path.join(__dirname, "..", file), "utf8");

test("ChatGPT's allowance goes by ChatGPT, whichever source read it", () => {
  assert.equal(quotaName({ service: "codex", provider: "Codex", plan: "Pro Lite" }), "ChatGPT");
  assert.equal(quotaName({ provider: "Codex" }), "ChatGPT", "a Host that names no service");
  for (const [provider, name] of [[{ service: "claude", provider: "Claude" }, "Claude"], [{ service: "antigravity", provider: "Antigravity" }, "Antigravity"],
    [{ service: "openai", provider: "OpenAI" }, "OpenAI"], [{ service: "minimax", provider: "MiniMax" }, "MiniMax"], [{ provider: "Codex Labs", service: "codexlabs" }, "Codex Labs"],
    [{ label: "Grok" }, "Grok"], [{ service: "toString" }, "toString"], [{ service: "__proto__", provider: "X" }, "X"], [null, ""], [{}, ""]]) {
    assert.equal(quotaName(provider), name, JSON.stringify(provider));
  }
  // One account read on two computers is still one card, named ChatGPT.
  const key = "v1:" + "a".repeat(64), reading = at => ({ provider: "Codex", service: "codex", accountKey: key, sampledAt: at, status: "ready", windows: [{ usedPercent: 30, windowDurationMins: 10080 }] });
  const cards = combineQuotas([{ host: "mini", quota: { updatedAt: 1, providers: [reading(1)] } }, { host: "mbp", quota: { updatedAt: 2, providers: [reading(2)] } }]);
  assert.deepEqual(cards.map(quotaName), ["ChatGPT"]);
});

test("the cards, the limits capsule, its tip and the menu bar all name and mark it so", () => {
  const ui = read("public/modules/usage-ui.js"), workspace = read("public/modules/workspace.js"), menubar = read("public/modules/menubar.js");
  assert.match(ui, /const serviceName = usageData\.quotaName \? usageData\.quotaName\(provider\) : provider\.provider;/);
  assert.match(ui, /title\.append\(node\("strong", serviceName\)\)/); assert.match(ui, /heading\.append\(providerLogo\(serviceName\), identity\)/);
  assert.doesNotMatch(ui, /providerLogo\(provider\.provider\)|node\("strong", provider\.provider\)/);
  assert.match(workspace, /return \[quotaName\(provider\), plan,/, "the capsule's tip");
  assert.equal((workspace.match(/providerLogo\(quotaName\(row\.provider\)\)/g) || []).length, 2, "the capsule's marks");
  assert.doesNotMatch(workspace, /providerLogo\(row\.provider\.provider\)/);
  assert.match(menubar, /const account=U\.quotaName \? U\.quotaName\(provider\)/); assert.match(menubar, /container\.title=\[account,period,/);
});
