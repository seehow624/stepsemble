(function (root) {
  "use strict";
  const MAX_PANES = 8, MAX_TABS = 32;
  const id = () => globalThis.crypto.randomUUID();
  const identity = ref => JSON.stringify([ref.host, ref.key]);
  function reference(raw) {
    if (!raw || !/^[A-Za-z0-9_.:-]{1,128}$/.test(raw.host) || !/^[a-f0-9-]{36}$/.test(raw.key)) throw new Error("Invalid session reference");
    return { host: raw.host, key: raw.key, title: String(raw.title || "Session").slice(0, 160) };
  }
  const pane = () => ({ type: "pane", id: id(), tabs: [], active: null });
  function leaves(node) { return node.type === "pane" ? [node] : [...leaves(node.first), ...leaves(node.second)]; }
  function normalize(raw) {
    let count = 0, tabs = 0;
    const ids = new Set(), seen = new Set();
    function walk(n, depth = 0) {
      if (!n || depth > 8 || typeof n.id !== "string" || ids.has(n.id)) throw new Error("Invalid layout");
      ids.add(n.id);
      if (n.type === "pane") {
        if (++count > MAX_PANES || !Array.isArray(n.tabs)) throw new Error("Too many panes");
        const refs = n.tabs.map(reference).filter(r => { const key = identity(r); if (seen.has(key)) return false; seen.add(key); return true; });
        if ((tabs += refs.length) > MAX_TABS) throw new Error("Too many tabs");
        return { type: "pane", id: n.id, tabs: refs, active: refs.some(r => identity(r) === n.active) ? n.active : refs[0] ? identity(refs[0]) : null };
      }
      if (n.type !== "split" || !["row", "column"].includes(n.axis)) throw new Error("Invalid split");
      return { type: "split", id: n.id, axis: n.axis, ratio: Math.max(.15, Math.min(.85, Number(n.ratio) || .5)), first: walk(n.first, depth + 1), second: walk(n.second, depth + 1) };
    }
    return walk(raw);
  }
  function replace(node, target, next) {
    if (node.id === target) return next;
    if (node.type === "pane") return node;
    return { ...node, first: replace(node.first, target, next), second: replace(node.second, target, next) };
  }
  function remove(node, ref) {
    const key = identity(ref);
    if (node.type === "split") return { ...node, first: remove(node.first, ref), second: remove(node.second, ref) };
    const tabs = node.tabs.filter(r => identity(r) !== key);
    return { ...node, tabs, active: node.active === key ? (tabs[0] ? identity(tabs[0]) : null) : node.active };
  }
  function insert(tree, target, ref, edge = "center") {
    ref = reference(ref);
    if (!["center", "left", "right", "top", "bottom"].includes(edge)) throw new Error("Invalid drop location");
    const targetPane = leaves(tree).find(p => p.id === target);
    if (!targetPane) throw new Error("Pane no longer exists");
    if (edge !== "center" && leaves(tree).length >= MAX_PANES) throw new Error("最多同時顯示 8 個面板");
    let next = remove(tree, ref);
    const destination = edge === "center" ? leaves(next).find(p => p.id === target) : pane();
    destination.tabs = [...destination.tabs, ref]; destination.active = identity(ref);
    if (edge === "center") return normalize(replace(next, target, destination));
    const old = leaves(next).find(p => p.id === target);
    const before = edge === "left" || edge === "top";
    return normalize(replace(next, target, { type: "split", id: id(), axis: ["left", "right"].includes(edge) ? "row" : "column", ratio: .5,
      first: before ? destination : old, second: before ? old : destination }));
  }
  function closePane(tree, target) {
    if (tree.type === "pane") return tree.id === target ? pane() : tree;
    if (tree.first.id === target) return tree.second;
    if (tree.second.id === target) return tree.first;
    return { ...tree, first: closePane(tree.first, target), second: closePane(tree.second, target) };
  }
  const api = { pane, leaves, identity, reference, normalize, replace, remove, insert, closePane };
  if (typeof module !== "undefined") module.exports = api;
  else root.StepsembleLayout = api;
})(globalThis);
