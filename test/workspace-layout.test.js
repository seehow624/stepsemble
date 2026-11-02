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

test("a Bot's tab saved by an older Stepsemble is left out; the rest of the layout stays", () => {
  const bot = { host: "mini", key: crypto.randomUUID(), title: "Nova", avatar: "character-nova", assistant: { page: "bot", profile: "default" } };
  const session = ref(), other = ref();
  const saved = { type: "split", id: "s", axis: "row", ratio: .5,
    first: { type: "pane", id: "a", tabs: [bot], active: L.identity(bot) },
    second: { type: "split", id: "t", axis: "column", ratio: .5,
      first: { type: "pane", id: "b", tabs: [bot, session], active: L.identity(bot) },
      second: { type: "pane", id: "c", tabs: [other], active: L.identity(other) } } };
  const tree = L.normalize(saved);
  assert.deepEqual(L.leaves(tree).map(p => p.tabs.map(r => r.key)), [[], [session.key], [other.key]], "its pane is empty or shows the pane's session");
  assert.throws(() => L.reference(bot), /Invalid session reference/, "nor can one be dropped in");
});

test("a Schedules tab stays one through moves, splits and saves; only true marks it", () => {
  const schedules = { host: "mbp", key: crypto.randomUUID(), title: "Schedules", schedules: true };
  let tree = L.pane();
  tree = L.insert(tree, tree.id, schedules);
  tree = L.insert(tree, tree.id, ref("local"), "right");
  tree = L.insert(tree, L.leaves(tree)[1].id, schedules, "bottom");
  const tab = L.leaves(L.normalize(JSON.parse(JSON.stringify(tree)))).flatMap(p => p.tabs).find(r => r.key === schedules.key);
  assert.deepEqual(tab, schedules);
  for (const value of ["true", 1, {}, false]) assert.equal(L.reference({ ...schedules, schedules: value }).schedules, undefined, JSON.stringify(value));
});

