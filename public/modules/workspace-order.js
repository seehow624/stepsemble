/* Sidebar order belongs to the Host; identity and membership stay unchanged. */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.StepsembleWorkspaceOrder = api;
})(typeof window === "object" ? window : globalThis, function () {
  "use strict";
  const unique = values => [...new Set(values)];
  const projectIds = snapshot => unique([...(snapshot.projects || []), ...(snapshot.entries || []).map(row => row.record.cwd || "")]);
  function normalize(value, snapshot) {
    const projects = projectIds(snapshot), sessions = (snapshot.entries || []).map(row => row.key);
    const keep = (values, allowed) => unique((Array.isArray(values) ? values : []).filter(id => typeof id === "string" && allowed.includes(id)));
    return {
      projectOrder: keep(value?.projectOrder, projects), pinnedProjects: keep(value?.pinnedProjects, projects),
      sessionOrder: keep(value?.sessionOrder, sessions), pinnedSessions: keep(value?.pinnedSessions, sessions),
    };
  }
  function ordered(ids, order, pins) {
    const ranks = new Map(unique([...order, ...ids]).map((id, index) => [id, index]));
    const pinned = new Set(pins);
    return [...ids].sort((a, b) => Number(pinned.has(b)) - Number(pinned.has(a)) || ranks.get(a) - ranks.get(b));
  }
  function projects(snapshot) {
    const p = normalize(snapshot.presentation, snapshot);
    return ordered(projectIds(snapshot), p.projectOrder, p.pinnedProjects);
  }
  function entries(snapshot, cwd) {
    const p = normalize(snapshot.presentation, snapshot), rows = (snapshot.entries || []).filter(row => (row.record.cwd || "") === cwd);
    const byId = new Map(rows.map(row => [row.key, row]));
    return ordered([...byId.keys()], p.sessionOrder, p.pinnedSessions).map(id => byId.get(id));
  }
  function arrange(snapshot, input) {
    const kind = input?.kind, id = input?.id;
    if (!["project", "session"].includes(kind) || typeof id !== "string") throw new Error("workspace_order_invalid");
    const result = normalize(snapshot.presentation, snapshot);
    const ids = kind === "project" ? projectIds(snapshot) : (snapshot.entries || []).map(row => row.key);
    if (!ids.includes(id)) throw new Error("workspace_order_missing");
    const orderKey = kind === "project" ? "projectOrder" : "sessionOrder", pinKey = kind === "project" ? "pinnedProjects" : "pinnedSessions";
    const order = unique([...result[orderKey], ...ids]);
    if (typeof input.pinned === "boolean") {
      result[pinKey] = result[pinKey].filter(key => key !== id);
      if (input.pinned) result[pinKey].push(id);
      // A newly pinned item goes first. Unpinning keeps it easy to find.
      result[orderKey] = [id, ...order.filter(key => key !== id)];
    } else {
      if (!Object.prototype.hasOwnProperty.call(input, "before") || input.before !== null && typeof input.before !== "string") throw new Error("workspace_order_invalid");
      if (input.before === id) return result;
      const rows = snapshot.entries || [], cwd = rows.find(row => row.key === id)?.record.cwd || "";
      const pins = new Set(result[pinKey]);
      const peers = ids.filter(key => pins.has(key) === pins.has(id) && (kind === "project" || (rows.find(row => row.key === key)?.record.cwd || "") === cwd));
      if (input.before !== null && !peers.includes(input.before)) throw new Error("workspace_order_target_invalid");
      const next = order.filter(key => key !== id);
      const at = input.before === null ? next.length : next.indexOf(input.before);
      next.splice(at, 0, id); result[orderKey] = next;
    }
    return result;
  }
  return { normalize, ordered, projects, entries, arrange };
});
