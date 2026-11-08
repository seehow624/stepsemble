"use strict";

// Claude's five hours show only for a plan that has them. Pro and Max do,
// all there before they start; Ultra does not (Claude's usage of an Ultra
// account names a week and the weeks of models, no session). Magpie reads
// five hours that have not started, or that the plan does not have, as
// nothing used with no reset time; those show only for a plan known to have
// them. Five hours in use always show. Codex shows the windows ChatGPT
// reports, which are already the plan's: five hours for Plus, none for Pro.
const test = require("node:test"), assert = require("node:assert/strict");
const { combineQuotas, claudeHasFiveHours, fiveHourPlaceholder } = require("../public/modules/usage-data");
const { createWorkspaceUsage } = require("../server/workspace-usage");

const NOW = 1_794_000_000_000, KEY = "v1:" + "a".repeat(64);
const placeholder = { label: "5 hours", windowDurationMins: 300, usedPercent: 0, resetsAt: null };
const week = { label: "7 days", windowDurationMins: 10080, usedPercent: 81, resetsAt: NOW + 86_400_000 };
const spans = windows => windows.map(w => w.windowDurationMins);

test("which plans have five hours, and what five hours not started look like", () => {
  assert.deepEqual(["Ultra", "claude_ultra", "Max", "claude_max", "Pro", "Team", null, "", "unknown"].map(claudeHasFiveHours), [false, false, true, true, true, true, false, false, false]);
  assert.deepEqual([placeholder, { ...placeholder, usedPercent: 3 }, { ...placeholder, resetsAt: NOW }, { ...placeholder, windowDurationMins: 10080 }, { ...placeholder, scope: "pool", bucket: "Gemini" }].map(fiveHourPlaceholder),
    [true, false, false, false, false]);
});

test("the Host shows Magpie's five hours of a Claude account only when its plan has them", async () => {
  const read = async (plan, five) => {
    const usage = createWorkspaceUsage({ now: () => NOW, codex: async () => ({}), readSignIn: async () => null, readClaudeToken: async () => null, readCodexSignIn: async () => null,
      readProviderQuotas: async () => [], readOpenCodex: async () => [], readDesktopClaudeQuota: async () => undefined,
      readMagpie: async () => [{ service: "claude", kind: "subscription", label: "Claude", ...(plan ? { plan } : {}), readAt: NOW, accountKey: null, windows: [five, week] }] });
    const result = await usage.read();
    return { card: spans(result.providers.find(row => row.service === "claude").windows), settings: spans(result.sources.magpie.services.find(row => row.service === "claude").windows) };
  };
  // As Magpie 0.1.3295 reads the Ultra account on both Macs: five hours, nothing used, no reset time, no plan.
  assert.deepEqual(await read(null, placeholder), { card: [10080], settings: [10080] }, "a plan not known");
  assert.deepEqual(await read("Ultra", placeholder), { card: [10080], settings: [10080] });
  assert.deepEqual(await read("max", placeholder), { card: [300, 10080], settings: [300, 10080] }, "Max has five hours, all there before they start");
  assert.deepEqual(await read(null, { ...placeholder, usedPercent: 12, resetsAt: NOW + 3_600_000 }), { card: [300, 10080], settings: [300, 10080] }, "five hours in use always show");
});

test("under All Hosts too, an Ultra account's card has no five hours, whichever computer read last", () => {
  const claude = (source, plan, at, windows) => ({ provider: "Claude", service: "claude", source, status: "ready", accountKey: KEY, sampledAt: at, ...(plan ? { plan } : {}), windows });
  const hosts = (mini, mbp) => [{ host: "mini", name: "Mac Mini", quota: { updatedAt: NOW, providers: [mini] } }, { host: "mbp", name: "MacBook Pro", quota: { updatedAt: NOW, providers: [mbp] } }];
  // The Mac mini reads the account itself (Ultra); the MacBook only through Magpie (no plan, five hours not started).
  for (const [mini, mbp] of [[NOW, NOW - 60000], [NOW - 60000, NOW]]) {
    const cards = combineQuotas(hosts(claude("native", "Ultra", mini, [week]), claude("magpie", null, mbp, [placeholder, week])));
    assert.deepEqual(cards.map(card => [card.plan, spans(card.windows)]), [["Ultra", [10080]]]);
  }
  // An older Host adds five hours to every Claude card; an Ultra account's go, a Max account's stay.
  const alone = (plan, windows) => combineQuotas([{ host: "mini", name: "Mac Mini", quota: { updatedAt: NOW, providers: [claude("native", plan, NOW, windows)] } }])[0];
  assert.deepEqual(spans(alone("Ultra", [placeholder, week]).windows), [10080]);
  assert.deepEqual(spans(alone("Max", [placeholder, week]).windows), [300, 10080]);
  assert.deepEqual(spans(alone("Ultra", [{ ...placeholder, usedPercent: 5, resetsAt: NOW + 3_600_000 }, week]).windows), [300, 10080], "five hours in use");
  // Codex keeps the windows ChatGPT reports.
  const codex = combineQuotas([{ host: "mini", name: "Mac Mini", quota: { updatedAt: NOW, providers: [{ provider: "Codex", service: "codex", status: "ready", plan: "plus", windows: [placeholder, week] }] } }])[0];
  assert.deepEqual(spans(codex.windows), [300, 10080]);
});
