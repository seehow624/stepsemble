(function expose(root, factory) {
  "use strict";
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.stepsembleCodexApprovals = Object.freeze(api);
})(typeof window !== "undefined" ? window : null, () => {
  "use strict";
  const METHODS = new Set(["item/commandExecution/requestApproval", "item/fileChange/requestApproval", "item/permissions/requestApproval"]);
  const keyOf = id => typeof id === "number" && Number.isSafeInteger(id) ? `n:${id}`
    : typeof id === "string" && id.length > 0 && id.length <= 256 ? `s:${id}` : null;
  function createController({ threadId, request, isCurrent, onChange = () => {} }) {
    const rows = new Map();
    let available = true;
    const snapshot = () => [...rows.values()].map(row => ({ ...row, available }));
    const emit = () => onChange(snapshot());
    function sync(values) {
      available = true;
      const present = new Set();
      for (const value of (Array.isArray(values) ? values : []).slice(0, 64)) {
        const key = keyOf(value?.requestId);
        if (!key || value.threadId !== threadId || !METHODS.has(value.method) || value.authority?.sourceAuthenticated !== true) continue;
        present.add(key);
        const old = rows.get(key);
        let details = "";
        try { if (value.params && typeof value.params === "object") details = JSON.stringify(value.params, null, 2); } catch {}
        const reviewable = details.length > 0 && details.length <= 32768;
        rows.set(key, { key, requestId: value.requestId, threadId, method: value.method,
          summary: String(value.summary || "Codex is requesting permission.").slice(0, 2000),
          details: details.slice(0, 32768), reviewable,
          scope: value.method === "item/permissions/requestApproval" ? "run" : "once",
          state: value.responseWritten === true ? "written" : old?.state || "pending" });
      }
      for (const [key, row] of rows) if (!present.has(key)) rows.set(key, { ...row, state: "closed" });
      // Keep a bounded recent audit display; never drop an actionable row.
      for (const [key, row] of rows) if (rows.size > 64 && row.state === "closed") rows.delete(key);
      emit();
    }
    async function decide(key, decision) {
      const row = rows.get(key);
      if (!available || !isCurrent() || row?.state !== "pending" || !["approved", "denied"].includes(decision)
        || decision === "approved" && !row.reviewable) return false;
      row.state = "sending"; emit();
      try {
        const result = await request({ threadId, requestId: row.requestId, decision, scope: row.scope });
        // A written response is not proof of approval or successful execution.
        if (rows.get(key)?.state !== "closed") rows.get(key).state = result?.kind === "written" ? "written" : "uncertain";
      } catch {
        if (rows.get(key)?.state !== "closed") rows.get(key).state = "uncertain";
      }
      if (isCurrent()) emit();
      return true;
    }
    return Object.freeze({ sync, decide, snapshot, unavailable() { available = false; emit(); } });
  }
  return { createController, keyOf };
});
