"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), crypto = require("node:crypto");
const L = require("../public/modules/workspace-layout");
const ref = (host = "local", key = crypto.randomUUID()) => ({ host, key, title: "Same title" });
test("split, move, and close preserve exact host/session identity", () => {
  let tree = L.pane(); const a = ref(), b = ref("remote", a.key);
  tree = L.insert(tree, tree.id, a); tree = L.insert(tree, tree.id, b, "right");
  assert.equal(L.leaves(tree).length, 2); assert.equal(L.leaves(tree).flatMap(p => p.tabs).length, 2);
  const right = L.leaves(tree)[1]; tree = L.insert(tree, right.id, a);
  assert.equal(L.leaves(tree).flatMap(p => p.tabs).length, 2);
  assert.equal(L.leaves(tree)[1].tabs.length, 2);
  tree = L.remove(tree, b); assert.deepEqual(L.leaves(tree)[1].tabs, [a]);
  tree = L.closePane(tree, L.leaves(tree)[0].id); assert.equal(tree.type, "pane");
  assert.deepEqual(L.normalize(JSON.parse(JSON.stringify(tree))), tree);
});
test("all four edge targets retain tree topology and active tab", () => {
  for (const edge of ["left", "right", "top", "bottom"]) {
    const p = L.pane(), a = ref(), b = ref();
    const tree = L.insert(L.insert(p, p.id, a), p.id, b, edge);
    assert.equal(tree.axis, ["left", "right"].includes(edge) ? "row" : "column");
    assert.equal(L.leaves(tree).find(p => p.tabs.some(r => r.key === b.key)).active, L.identity(b));
  }
});
test("malformed or excessive persisted layouts are rejected", () => {
  assert.throws(() => L.reference({ host: "../../other", key: crypto.randomUUID() }));
  assert.throws(() => L.normalize({ type: "pane", id: "p", tabs: [ref("local", "bad")] }));
  let tree = L.pane(); for (let i = 0; i < 7; i++) tree = L.insert(tree, L.leaves(tree)[0].id, ref(), "right");
  assert.throws(() => L.insert(tree, L.leaves(tree)[0].id, ref(), "bottom"), /8/);
  assert.throws(() => L.insert(tree, "missing", ref()), /no longer/);
});

test("tab insertion preserves selection, supports both directions and the 32-tab bound", () => {
  let tree = L.pane(); const refs = Array.from({ length: 32 }, () => ref());
  for (const r of refs) tree = L.insert(tree, tree.id, r);
  const selected = tree.active;
  tree = L.moveAt(tree, tree.id, refs[0], 32);
  assert.equal(tree.tabs[31].key, refs[0].key); assert.equal(tree.active, selected);
  tree = L.moveAt(tree, tree.id, refs[0], 0);
  assert.deepEqual(tree.tabs, refs); assert.equal(tree.active, selected);
  assert.throws(() => L.moveAt(tree, tree.id, ref(), 0), /Too many tabs/);
  assert.equal(L.selectAdjacent(tree, tree.id, 1).active, L.identity(refs[0]));
  assert.equal(L.selectAdjacent(tree, tree.id, -1).active, L.identity(refs[30]));
});
test("closing active tabs selects their nearest neighbour, not the first tab", () => {
  const refs = Array.from({ length: 4 }, () => ref());
  let tree = L.pane(); for (const r of refs) tree = L.insert(tree, tree.id, r);
  assert.equal(L.remove(tree, refs[3]).active, L.identity(refs[2]));
  tree.active = L.identity(refs[1]);
  assert.equal(L.remove(tree, refs[1]).active, L.identity(refs[2]));
  assert.equal(L.remove(tree, refs[0]).active, tree.active);
});
test("a tab keeps its agent for the logo, and a tab saved without one still loads", () => {
  const key = crypto.randomUUID();
  assert.equal(L.reference({ host: "local", key, title: "T", agentId: "claude-code" }).agentId, "claude-code");
  assert.equal("agentId" in L.reference({ host: "local", key, title: "T", agentId: "../../other" }), false);
  assert.equal("agentId" in L.reference({ host: "local", key, title: "T" }), false);
  let tree = L.pane(); tree = L.insert(tree, tree.id, { host: "local", key, title: "T", agentId: "codex" });
  assert.equal(L.normalize(JSON.parse(JSON.stringify(tree))).tabs[0].agentId, "codex");
});

test("an assistant tab keeps its route and avatar through moves, splits and saves", () => {
  const bot = { host: "mini", key: crypto.randomUUID(), title: "Luna", avatar: "orbit",
    assistant: { page: "bot", profile: "default", session: "20261016_1", machine: "mini", panel: "history" } };
  let tree = L.pane();
  tree = L.insert(tree, tree.id, bot);
  tree = L.insert(tree, tree.id, ref("local"), "right");
  tree = L.moveAt(tree, L.leaves(tree)[1].id, bot, 0);
  const saved = L.normalize(JSON.parse(JSON.stringify(tree)));
  const tab = L.leaves(saved).flatMap(p => p.tabs).find(r => r.key === bot.key);
  assert.deepEqual(tab.assistant, { page: "bot", profile: "default", session: "20261016_1" }, "the computer is the tab's host and panels are not kept");
  assert.equal(tab.avatar, "orbit");
  assert.equal(L.identity(tab), JSON.stringify(["mini", bot.key]));
  for (const assistant of [{ page: "group", room: "room-1" }, { page: "routines" }, { page: "bots" }, { page: "newbot" }, { page: "newgroup" }, { page: "pending" }, { page: "home" }, { page: "settings", profile: "qa" }])
    assert.deepEqual(L.reference({ host: "mini", key: crypto.randomUUID(), title: "x", assistant }).assistant, assistant);
  assert.equal(L.reference({ ...bot, avatar: "<img>" }).avatar, undefined, "only a preset name is kept");
});

test("an assistant tab that names a page it cannot show is rejected", () => {
  for (const assistant of [{ page: "console" }, { page: "bot" }, { page: "bot", profile: "../x" }, { page: "group" }, { page: "nope" }, "bot", []])
    assert.throws(() => L.reference({ host: "mini", key: crypto.randomUUID(), title: "x", assistant }), /assistant/i, JSON.stringify(assistant));
});
