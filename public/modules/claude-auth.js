(function expose(root, factory) {
  "use strict";
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.stepsembleClaudeAuth = Object.freeze(api);
})(typeof window !== "undefined" ? window : null, () => {
  "use strict";
  const ACTIVE = new Set(["prepared", "starting", "waiting", "verifying", "cancelling"]);
  const STATES = new Set([...ACTIVE, "completed", "unconfirmed", "failed", "blocked", "cancelled", "timed_out", "expired", "interrupted"]);
  const CREDENTIALS = new Set(["detected", "signed_out", "unknown", "other_auth", "not_installed", "unsupported", "desktop_required", "desktop_recovery_required"]);
  function normalize(value) {
    if (!value || !CREDENTIALS.has(value.credential?.state) || value.credential.liveVerified !== false || typeof value.canStart !== "boolean") throw new Error("unsupported");
    if (value.login && (!STATES.has(value.login.state) || !/^[a-f0-9-]{36}$/.test(value.login.id || ""))) throw new Error("unsupported");
    return { credential: { state: value.credential.state, liveVerified: false }, canStart: value.canStart,
      blockedReason: value.blockedReason === "active_tasks" ? "active_tasks" : null,
      login: value.login ? { id: value.login.id, state: value.login.state } : null };
  }
  function createController({ request, render, scope = () => "", isVisible = () => true, setTimer = setTimeout, clearTimer = clearTimeout }) {
    let generation = 0, data = null, error = null, pending = false, timer = null, controller = null, failures = 0;
    const snapshot = () => ({ data, error, pending });
    function emit() { render(snapshot()); }
    function pause() { if (timer !== null) clearTimer(timer); timer = null; }
    function schedule() {
      pause();
      if (isVisible() && ACTIVE.has(data?.login?.state) && failures < 4) timer = setTimer(() => { timer = null; void refresh(); }, error ? 5000 : 2000);
    }
    function reset() { generation++; pause(); controller?.abort(); controller = null; data = null; error = null; pending = false; failures = 0; emit(); }
    async function perform(action) {
      if (pending) return;
      pause(); pending = true; error = null; emit();
      const captured = scope(), stamp = generation, local = new AbortController(); controller = local;
      const current = () => stamp === generation && captured === scope() && !local.signal.aborted;
      const call = (path, body) => request(`/api/claude-auth/${path}`, { signal: local.signal,
        ...(body === undefined ? {} : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }) });
      try {
        let result;
        if (action === "start") {
          result = normalize(await call("prepare", { confirm: true }));
          if (!current()) return;
          data = result; emit();
          if (result.login?.state === "prepared") result = normalize(await call("start", { id: result.login.id }));
        } else if (action === "cancel") {
          if (!data?.login?.id) return;
          result = normalize(await call("cancel", { id: data.login.id }));
        } else result = normalize(await call("status"));
        if (current()) { data = result; failures = 0; }
      } catch (cause) {
        if (current()) {
          failures++;
          const reason = cause.code || cause.message;
          error = cause.status === 404 || cause.message === "unsupported" ? "unsupported_host"
            : ["active_tasks", "other_auth", "login_unavailable", "stale_intent", "service_closed", "desktop_required", "desktop_recovery_required"].includes(reason) ? reason
              : action === "start" ? "request_uncertain" : "status_unavailable";
        }
      } finally {
        if (current()) { pending = false; controller = null; emit(); schedule(); }
      }
    }
    function refresh() { return perform("status"); }
    function start() { if (data?.canStart !== true || error || pending) return Promise.resolve(); return perform("start"); }
    function cancel() { return perform("cancel"); }
    return Object.freeze({ refresh, start, cancel, reset, pause, snapshot });
  }
  return { normalize, createController };
});
