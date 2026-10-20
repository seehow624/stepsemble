"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), crypto = require("node:crypto");
const L = require("../public/modules/workspace-layout");
const ref = (host = "local", key = crypto.randomUUID()) => ({ host, key, title: "Same title" });
test("a pane shows one session: opening another there replaces it, and identity keeps host and session", () => {
  let tree = L.pane(); const a = ref(), b = ref("remote", a.key), c = ref();
  tree = L.insert(tree, tree.id, a); tree = L.insert(tree, tree.id, b, "right");
  assert.equal(L.leaves(tree).length, 2); assert.deepEqual(L.leaves(tree).map(p => p.tabs.map(r => r.host)), [["local"], ["remote"]]);
  tree = L.insert(tree, L.leaves(tree)[0].id, c);
  assert.deepEqual(L.leaves(tree)[0].tabs, [c], "the session shown there is replaced, not stacked");
  assert.equal(L.leaves(tree)[0].active, L.identity(c));
  tree = L.remove(tree, b); assert.deepEqual(L.leaves(tree)[1].tabs, []);
  tree = L.closePane(tree, L.leaves(tree)[1].id); assert.equal(tree.type, "pane");
  assert.deepEqual(L.normalize(JSON.parse(JSON.stringify(tree))), tree);
});
test("all four edge targets retain tree topology and the session shown", () => {
  for (const edge of ["left", "right", "top", "bottom"]) {
    const p = L.pane(), a = ref(), b = ref();
    const tree = L.insert(L.insert(p, p.id, a), p.id, b, edge);
    assert.equal(tree.axis, ["left", "right"].includes(edge) ? "row" : "column");
    assert.equal(L.leaves(tree).find(p => p.tabs.some(r => r.key === b.key)).active, L.identity(b));
    assert.deepEqual(L.leaves(tree).map(p => p.tabs.length), [1, 1]);
  }
});
test("a session moved to another pane leaves no empty pane behind; moving it onto itself changes nothing", () => {
  let tree = L.pane(); const a = ref(), b = ref(), c = ref();
  tree = L.insert(tree, tree.id, a); tree = L.insert(tree, tree.id, b, "right"); tree = L.insert(tree, L.leaves(tree)[1].id, c, "bottom");
  assert.equal(L.leaves(tree).length, 3);
  tree = L.insert(tree, L.leaves(tree)[0].id, c);
  assert.deepEqual(L.leaves(tree).map(p => p.tabs.map(r => r.key)), [[c.key], [b.key]], "its old pane closed and it replaced the target's");
  tree = L.insert(tree, L.leaves(tree)[1].id, c, "left");
  assert.deepEqual(L.leaves(tree).map(p => p.tabs.map(r => r.key)), [[c.key], [b.key]], "moved beside b, its old pane gone");
  const same = L.insert(tree, L.leaves(tree)[0].id, c, "right");
  assert.deepEqual(same, tree, "a pane's own session dropped on its own edge stays");
  assert.deepEqual(L.insert(tree, L.leaves(tree)[0].id, c), tree);
});
test("a session leaving the layout takes its pane along while others remain", () => {
  let tree = L.pane(); const a = ref(), b = ref();
  tree = L.insert(tree, tree.id, a); tree = L.insert(tree, tree.id, b, "right");
  tree = L.drop(tree, a);
  assert.equal(tree.type, "pane"); assert.deepEqual(tree.tabs, [b]);
  tree = L.drop(tree, b);
  assert.equal(tree.type, "pane"); assert.deepEqual(tree.tabs, [], "the last pane stays, empty");
  assert.equal(L.drop(tree, ref()), tree);
});
test("a layout saved while panes held tabs keeps each pane's shown session", () => {
  const a = ref(), b = ref(), c = ref();
  const saved = { type: "split", id: "s", axis: "row", ratio: .4, first: { type: "pane", id: "p1", tabs: [a, b], active: L.identity(b) }, second: { type: "pane", id: "p2", tabs: [c], active: null } };
  const tree = L.normalize(saved);
  assert.deepEqual(L.leaves(tree).map(p => p.tabs.map(r => r.key)), [[b.key], [c.key]]);
  assert.equal(L.leaves(tree)[1].active, L.identity(c));
});
test("malformed or excessive persisted layouts are rejected", () => {
  assert.throws(() => L.reference({ host: "../../other", key: crypto.randomUUID() }));
  assert.throws(() => L.normalize({ type: "pane", id: "p", tabs: [ref("local", "bad")] }));
  let tree = L.pane(); for (let i = 0; i < 7; i++) tree = L.insert(tree, L.leaves(tree)[0].id, ref(), "right");
  assert.throws(() => L.insert(tree, L.leaves(tree)[0].id, ref(), "bottom"), /8/);
  assert.throws(() => L.insert(tree, "missing", ref()), /no longer/);
  const moved = L.leaves(tree)[7].tabs[0];
  assert.equal(L.leaves(L.insert(tree, L.leaves(tree)[0].id, moved, "bottom")).length, 8, "moving a session between eight panes keeps eight");
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
  const bot = { host: "mini", key: crypto.randomUUID(), title: "Luna", avatar: "character-nova",
    assistant: { page: "bot", profile: "default", session: "20261016_1", machine: "mini", panel: "history" } };
  let tree = L.pane();
  tree = L.insert(tree, tree.id, bot);
  tree = L.insert(tree, tree.id, ref("local"), "right");
  tree = L.insert(tree, L.leaves(tree)[1].id, bot, "bottom");
  const saved = L.normalize(JSON.parse(JSON.stringify(tree)));
  const tab = L.leaves(saved).flatMap(p => p.tabs).find(r => r.key === bot.key);
  assert.deepEqual(tab.assistant, { page: "bot", profile: "default", session: "20261016_1" }, "the computer is the tab's host and panels are not kept");
  assert.equal(tab.avatar, "character-nova");
  assert.equal(L.identity(tab), JSON.stringify(["mini", bot.key]));
  for (const assistant of [{ page: "group", room: "room-1" }, { page: "routines" }, { page: "bots" }, { page: "newbot" }, { page: "newgroup" }, { page: "pending" }, { page: "home" }, { page: "settings", profile: "qa" }])
    assert.deepEqual(L.reference({ host: "mini", key: crypto.randomUUID(), title: "x", assistant }).assistant, assistant);
  assert.equal(L.reference({ ...bot, avatar: "<img>" }).avatar, undefined, "only a preset name is kept");
});

test("a Schedules tab stays one through moves, splits and saves; only true marks it, and a Bot's page wins", () => {
  const schedules = { host: "mbp", key: crypto.randomUUID(), title: "Schedules", schedules: true };
  let tree = L.pane();
  tree = L.insert(tree, tree.id, schedules);
  tree = L.insert(tree, tree.id, ref("local"), "right");
  tree = L.insert(tree, L.leaves(tree)[1].id, schedules, "bottom");
  const tab = L.leaves(L.normalize(JSON.parse(JSON.stringify(tree)))).flatMap(p => p.tabs).find(r => r.key === schedules.key);
  assert.deepEqual(tab, schedules);
  for (const value of ["true", 1, {}, false]) assert.equal(L.reference({ ...schedules, schedules: value }).schedules, undefined, JSON.stringify(value));
  const both = L.reference({ ...schedules, assistant: { page: "routines" } });
  assert.deepEqual([both.assistant, both.schedules], [{ page: "routines" }, undefined]);
});

test("an assistant tab that names a page it cannot show is rejected", () => {
  for (const assistant of [{ page: "console" }, { page: "bot" }, { page: "bot", profile: "../x" }, { page: "group" }, { page: "nope" }, "bot", []])
    assert.throws(() => L.reference({ host: "mini", key: crypto.randomUUID(), title: "x", assistant }), /assistant/i, JSON.stringify(assistant));
});
