"use strict";
// Synthetic reference scenario only. No clocks, native IO, secrets or filesystem
// effects; this records the reference planners for a future Rust implementation.
const tx = require("../protocol/transaction-state");
const { state: imported } = require("../protocol/v1/fixtures/projection.cjs");
const wire = require("../protocol/v1/fixtures/wire.json");
const clone = value => structuredClone(value), now = Date.parse("2026-09-05T00:00:00.000Z");
const command = (type, payload) => { const c = clone(wire.find(row => row.contract === "command" && row.value.type === type).value); if (payload) c.payload = payload; return c; };
const payload = type => clone(wire.find(row => row.contract === "event" && row.value.type === type).value.payload);
async function capture() {
  const initial = tx.initialView(clone(imported), { storeId: "golden-store", storeGeneration: "golden-store-generation" });
  if (initial.kind !== "view") throw new Error("Invalid synthetic fixture seed");
  let state = clone(initial.state), eventId = 0;
  const steps = [], eventIds = count => Array.from({ length: count }, () => `golden-event-${++eventId}`);
  const context = more => ({ storeId: state.storeId, storeGeneration: state.storeGeneration, expectedRevision: state.revision, now,
    authorized: true, authenticatedDeviceId: "device-1", ...more });
  const receipt = id => state.receipts.find(row => row.receiptId === id);
  async function step(name, method, args, kind = "transaction") {
    const input = clone(args), result = await tx[method](state, ...args);
    if (result.kind !== kind) throw new Error(`Synthetic scenario rejected: ${name} (${result.code})`);
    steps.push({ name, method, args: input, expected: clone(result) });
    if (result.kind === "transaction") state = clone(result.state);
  }
  const admit = (type, id, count, cmd, more = {}) => step(`${type} admission`, "planAdmission", [cmd ?? command(type), context({ receiptId: id, eventIds: eventIds(count), ...more })]);
  const dispatch = id => step(`${id} dispatch`, "planDispatch", [id, context({ receiptRevision: receipt(id).revision, attemptId: `attempt-${id}`, incarnationId: "native-incarnation-2" })]);
  const proof = (id, count, more = {}) => context({ receiptRevision: receipt(id).revision, attemptId: `attempt-${id}`, incarnationId: "native-incarnation-2", evidenceVerified: true,
    evidence: { kind: "authoritative_readback", reference: `proof-${id}` }, eventIds: eventIds(count), ...more });
  const confirm = (id, count, more = {}) => step(`${id} confirmation`, "planOperationAcknowledgement", [id, proof(id, count, more)]);
  const selectedProfile = { ...clone(imported.session.launchProfile), launchProfileId: "profile-2", modelId: "synthetic-model-2" };
  await admit("session.rename", "receipt-rename", 0);
  await dispatch("receipt-rename"); await confirm("receipt-rename", 1, { title: "Updated title", evidence: { kind: "host_commit", reference: "proof-title" } });
  await admit("model.change", "receipt-model", 0, command("model.change", { launchProfileId: "profile-2" }), { launchProfile: clone(selectedProfile) });
  await dispatch("receipt-model"); await confirm("receipt-model", 1, { launchProfile: clone(selectedProfile) });
  const start = command("run.start", { runId: "run-2", launchProfileId: "profile-2", prompt: "Synthetic 貓掌🐾\nInspect only" });
  await admit("run.start", "receipt-start", 2, start);
  await dispatch("receipt-start");
  await step("native start confirmation", "planRunStartAcknowledgement", ["receipt-start", proof("receipt-start", 1, { runId: "run-2", nativeRunId: "native-run-2" })]);
  const request = { ...payload("approval.requested").approval, approvalId: "approval-2", runId: "run-2", nonce: "nonce-2", toolId: "tool-2", nativeRequestId: "native-request-2" };
  const source = more => context({ runtimeVerified: true, sessionId: "session-1", runId: "run-2", incarnationId: "native-incarnation-2", ...more });
  await step("native history and approval request", "planObservedEvents", [[
    { type: "message.delta", payload: { messageId: "message-2", channel: "thinking", delta: "思考中" } },
    { type: "message.delta", payload: { messageId: "message-2", channel: "text", delta: "Working" } },
    { type: "tool.requested", payload: { toolId: "tool-2", name: "read", summary: "Synthetic read" } },
    { type: "approval.requested", payload: { approval: request } },
  ], source({ eventIds: eventIds(4) })]);
  await admit("approval.resolve", "receipt-approval", 1, command("approval.resolve", { approvalId: "approval-2", runId: "run-2", nonce: "nonce-2", decision: "approved", scope: "once" }));
  await dispatch("receipt-approval");
  await step("native approval confirmation", "planApprovalAcknowledgement", ["receipt-approval", proof("receipt-approval", 1, { nonce: "nonce-2", nativeRequestId: "native-request-2" })]);
  const resume = { kind: "native_ack", reference: "proof-resume" };
  await step("native resume, tool result and complete response", "planObservedEvents", [[
    { type: "run.resumed", payload: { nativeRunId: "native-run-2", evidence: clone(resume) } },
    { type: "tool.started", payload: { toolId: "tool-2" } },
    { type: "tool.progress", payload: { toolId: "tool-2", text: "Reading" } },
    { type: "tool.completed", payload: { toolId: "tool-2", output: "Synthetic bytes" } },
    { type: "message.completed", payload: { messageId: "message-2", role: "assistant", content: "Done，🐾" } },
    { type: "usage.updated", payload: { inputTokens: 10, outputTokens: 20, cachedTokens: 0 } },
    { type: "context.updated", payload: { usedTokens: 40, limitTokens: 100 } },
  ], source({ eventIds: eventIds(7), evidenceVerified: true, evidence: clone(resume) })]);
  await admit("run.interrupt", "receipt-stop", 1, command("run.interrupt", { runId: "run-2" }));
  await dispatch("receipt-stop"); await confirm("receipt-stop", 0, { runId: "run-2" });
  await step("verified terminal observation", "planRunTerminal", ["run-2", source({ eventIds: eventIds(1), source: "current_store", evidenceVerified: true,
    evidence: { kind: "authoritative_readback", reference: "proof-terminal" }, nativeRunId: "native-run-2", type: "run.interrupted", payload: { reason: "user" } })]);
  await admit("context.compact", "receipt-compact", 0, null, { targetRunId: "run-2" });
  await dispatch("receipt-compact"); await confirm("receipt-compact", 1, { runId: "run-2", beforeTokens: 40, afterTokens: 10 });
  await admit("session.archive", "receipt-archive", 0, null, { archiveId: "archive-golden" });
  await dispatch("receipt-archive"); await confirm("receipt-archive", 1, { archiveId: "archive-golden", evidence: { kind: "host_commit", reference: "proof-archive" } });
  await admit("session.restore", "receipt-restore", 0, command("session.restore", { archiveId: "archive-golden" }));
  await dispatch("receipt-restore"); await confirm("receipt-restore", 1, { archiveId: "archive-golden", evidence: { kind: "host_commit", reference: "proof-restore" } });
  await step("backup quarantine", "planRecovery", [context({ source: "restored_backup" })]);
  await step("read-only original receipt replay in quarantine", "planAdmission", [clone(start), context({ eventIds: [], receiptId: "unused" })], "replay");
  const blocked = clone(start); blocked.commandId = "command-after-backup"; blocked.idempotencyKey = "new-after-backup"; blocked.payload.runId = "run-3";
  await step("no new effect from an old backup", "planAdmission", [blocked, context({ eventIds: eventIds(2), receiptId: "blocked" })], "reject");
  return { fixtureVersion: 1, source: "Synthetic Host transaction reference; no native IO, account access or persistence", initial: initial.state, steps };
}
module.exports = { capture };
