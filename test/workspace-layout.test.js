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
