"use strict";

// A card names a plan only when its service names one. A key's plan or
// balance and Grok name none and show none; a quota tier read in a plan's
// place is not one (Magpie keeps the plan an account had when it signed in:
// "Antigravity Starter Quota" for a sign-in made before the account's Google
// AI Pro subscription); and under All Hosts an account's plan comes from
// whichever computer's reading names it, so the card does not change with
// the computer that read last.
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path");
const { planLabel, combineQuotas } = require("../public/modules/usage-data");
const { createWorkspaceUsage } = require("../server/workspace-usage");

const KEY = "v1:" + "9".repeat(64), NOW = 1_794_000_000_000;
const read = file => fs.readFileSync(path.join(__dirname, "..", file), "utf8");

test("a quota tier read in a plan's place is not a plan", () => {
  assert.deepEqual(["Antigravity Starter Quota", "antigravity starter quota", "Free quota", "Starter Quotas", "Quota"].map(planLabel), [null, null, null, null, null]);
  assert.deepEqual(["Google AI Pro", "Ultra", "prolite", "Starter", "Quota Plus"].map(planLabel), ["Google AI Pro", "Ultra", "Pro Lite", "Starter", "Quota Plus"]);
});

test("under All Hosts an account's plan comes from whichever computer's reading names it", () => {
  const agy = (plan, at) => ({ provider: "Antigravity", service: "antigravity", source: "magpie", kind: "subscription", status: "ready", accountKey: KEY,
    sampledAt: at, ...(plan === undefined ? {} : { plan }), windows: [{ label: "Gemini · 7 days", usedPercent: 8, windowDurationMins: 10080, bucket: "Gemini", scope: "pool" }] });
  const hosts = (mini, mbp) => [{ host: "mini", name: "Mac Mini", quota: { updatedAt: NOW, providers: [mini] } }, { host: "mbp", name: "MacBook Pro", quota: { updatedAt: NOW, providers: [mbp] } }];
  const plans = results => combineQuotas(results).map(card => planLabel(card.plan));
  // As the two Macs read the same account on 2026-11-08, whichever read last.
  assert.deepEqual(plans(hosts(agy("Antigravity Starter Quota", NOW), agy("Google AI Pro", NOW - 60000))), ["Google AI Pro"]);
  assert.deepEqual(plans(hosts(agy("Antigravity Starter Quota", NOW - 60000), agy("Google AI Pro", NOW))), ["Google AI Pro"]);
  assert.deepEqual(plans(hosts(agy(undefined, NOW), agy("Google AI Pro", NOW - 60000))), ["Google AI Pro"], "a reading without one takes it too");
  // The newest reading's own plan stands; with none anywhere there is none.
  assert.deepEqual(plans(hosts(agy("Google AI Ultra", NOW), agy("Google AI Pro", NOW - 60000))), ["Google AI Ultra"]);
  assert.deepEqual(plans(hosts(agy("Antigravity Starter Quota", NOW), agy(null, NOW - 60000))), [null]);
  // Only the plan is filled in: the windows stay the newest reading's.
  const [card] = combineQuotas(hosts({ ...agy("Antigravity Starter Quota", NOW), windows: [{ usedPercent: 30, windowDurationMins: 300 }] }, agy("Google AI Pro", NOW - 60000)));
  assert.deepEqual(card.windows.map(w => w.usedPercent), [30]); assert.deepEqual(card.hosts.map(h => h.id), ["mini", "mbp"]);
  // Another account keeps its own.
  assert.deepEqual(plans(hosts(agy("Antigravity Starter Quota", NOW), { ...agy("Google AI Pro", NOW), accountKey: "v1:" + "8".repeat(64) })), [null, "Google AI Pro"]);
});

test("the Host names no plan for a quota tier, a key's plan or Grok", async () => {
  const usage = createWorkspaceUsage({ now: () => NOW, codex: async () => ({}), readClaudeToken: async () => null, readSignIn: async () => null,
    readCodexSignIn: async () => null, readProviderQuotas: async () => [], readOpenCodex: async () => [],
    readMagpie: async () => [
      { service: "antigravity", kind: "subscription", label: "Antigravity", plan: "Antigravity Starter Quota", readAt: NOW, accountKey: KEY,
        windows: [{ label: "Gemini · 7 days", windowDurationMins: 10080, bucket: "Gemini", scope: "pool", usedPercent: 8, resetsAt: NOW + 86_400_000 }] },
      { service: "minimax", kind: "plan", label: "MiniMax", readAt: NOW, accountKey: null, windows: [{ label: "5 hours", windowDurationMins: 300, usedPercent: 0, resetsAt: NOW + 3_600_000 }] },
      { service: "grok", kind: "subscription", label: "Grok", readAt: NOW, accountKey: null, windows: [{ label: "7 days", windowDurationMins: 10080, usedPercent: 6, resetsAt: NOW + 86_400_000 }] }] });
  const providers = (await usage.read()).providers;
  for (const service of ["antigravity", "minimax", "grok"]) {
    const provider = providers.find(row => row.service === service);
    assert.ok(provider?.windows.length, service); assert.equal(provider.plan, undefined, service);
  }
});

test("no stand-in names a plan: the cards, the menu bar and Settings leave its place empty", () => {
  for (const file of ["public/modules/usage-ui.js", "public/modules/menubar.js", "public/app.js", "public/i18n.js"]) assert.doesNotMatch(read(file), /keyPlan|keyBalance/, file);
});
