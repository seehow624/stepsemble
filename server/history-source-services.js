"use strict";
// One Host registry dispatches already-normalized sources; both implementations
// share its admission. This is not a second registry, grant or worker budget.
const { normalizeRegistrySource } = require("../protocol/native/claude/history-registry");
const { normalizeCodexSource, validPage } = require("../protocol/native/codex/history-source-service");
const { validPage: claudePage } = require("../protocol/native/claude/history-worker-wire");
const normalizeSource = input => normalizeCodexSource(input) ?? normalizeRegistrySource(input);
const validReadPage = input => validPage(input) || claudePage(input);
function createHistorySourceServices({ claude, codex, admission }) {
  const services = [claude, codex].filter(Boolean);
  if (!services.length || services.some(s => ["bind", "status", "shutdown"].some(k => typeof s[k] !== "function"))) throw new TypeError("invalid_history_services");
  let closed = false, closing;
  const status = () => {
    const shared = admission.status(), states = services.map(s => s.status());
    return { closed: closed || shared.closed || states.some(s => s.closed), quarantined: shared.quarantined || states.some(s => s.quarantined),
      activeWorkers: shared.activeWorkers, cleanupConfirmed: shared.cleanupConfirmed && states.every(s => s.cleanupConfirmed === true) };
  };
  function bind(input) {
    const current = status();
    if (current.closed || current.quarantined) return { kind: "source_unavailable", code: current.closed ? "source_service_closed" : "source_service_quarantined" };
    const source = normalizeSource(input?.source), service = source?.agentId === "codex" ? codex : claude;
    return source && service ? service.bind({ ...input, source }) : { kind: "source_unavailable", code: "invalid_source_binding" };
  }
  function shutdown() {
    if (closing) return closing; closed = true;
    closing = Promise.all(services.map(async service => {
      try { return await service.shutdown(); } catch { admission.quarantine(); return { cleanupConfirmed: false, quarantined: true }; }
    })).then(results => ({ kind: "history_source_services_closed", cleanupConfirmed: results.every(r => r.cleanupConfirmed === true) && admission.status().cleanupConfirmed,
      quarantined: admission.status().quarantined || results.some(r => r.quarantined === true) }));
    return closing;
  }
  return Object.freeze({ bind, status, shutdown });
}
module.exports = { normalizeSource, validReadPage, createHistorySourceServices };
