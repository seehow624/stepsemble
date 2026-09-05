"use strict";
// Independent expected rows. These are synthetic contract data, not native traces.
const seed = Object.fromEntries(require("./domains.json").map(item => [item.contract, item.value]));
const at = "2026-09-05T00:00:00.000Z", expires = "2026-09-05T00:10:00.000Z";
const profile = seed.launchProfile;
const initialSession = { session: seed.session, revision: 0, updatedAt: at, title: null, archiveId: null, launchProfile: null };
const session = { ...initialSession, session: { ...seed.session, launchProfileId: profile.launchProfileId }, revision: 1, launchProfile: profile };
const archived = { ...session, session: { ...session.session, status: "archived" }, revision: 2, archiveId: "archive-1" };
const starting = { run: { ...seed.run, state: "starting" }, revision: 0, updatedAt: at, launchProfile: profile, profileLocked: false,
  nativeRunId: null, startedAt: null, stopRequestedAt: null, finishedAt: null, recoveryReason: null };
const locked = { ...starting, revision: 1, profileLocked: true };
const running = { ...locked, run: { ...seed.run, state: "running" }, revision: 2, nativeRunId: "native-run-1", startedAt: at };
const runs = {
  starting, locked, running,
  waiting_approval: { ...running, run: { ...seed.run, state: "waiting_approval" }, revision: 3 },
  stopping: { ...running, run: { ...seed.run, state: "stopping" }, revision: 4, stopRequestedAt: at },
  orphaned: { ...running, run: { ...seed.run, state: "orphaned" }, revision: 5, recoveryReason: "host_restarted" },
  completed: { ...running, run: { ...seed.run, state: "completed" }, revision: 6, finishedAt: at },
  failed: { ...running, run: { ...seed.run, state: "failed" }, revision: 6, finishedAt: at },
  interrupted: { ...running, run: { ...seed.run, state: "interrupted" }, revision: 6, finishedAt: at },
};
const pending = { approval: seed.approval, revision: 0, updatedAt: at, resolvedAt: null, resolvedByDeviceId: null,
  resolutionReceiptId: null, nativeAcknowledgement: null, terminalReason: null };
const approved = { ...pending, approval: { ...seed.approval, status: "approved" }, revision: 1, resolvedAt: at,
  resolvedByDeviceId: "device-1", resolutionReceiptId: "receipt-approval-1" };
const approvals = {
  pending, approved,
  denied: { ...approved, approval: { ...seed.approval, status: "denied" } },
  expired: { ...pending, approval: { ...seed.approval, status: "expired" }, revision: 1, updatedAt: expires, resolvedAt: expires, terminalReason: "expired" },
  cancelled: { ...pending, approval: { ...seed.approval, status: "cancelled" }, revision: 1, resolvedAt: at, terminalReason: "Run interrupted" },
};
const acknowledged = { ...approved, revision: 2, nativeAcknowledgement: { receiptId: "receipt-approval-1", attemptId: "attempt-1", evidence: { kind: "native_ack", reference: "evidence-1" } } };
const cases = [];
function add(name, contract, value, shape = true, state = false) { cases.push({ name, contract, value, shape, state }); }
for (const [name, value] of Object.entries({ initialSession, session, archived })) add(name, "sessionState", value, true, true);
for (const [name, value] of Object.entries(runs)) add(name, "runState", value, true, true);
for (const [name, value] of Object.entries({ ...approvals, acknowledged })) add(name, "approvalState", value, true, true);
add("archive status without archive ID", "sessionState", { ...archived, archiveId: null });
add("profile reference mismatch", "sessionState", { ...session, launchProfile: { ...profile, launchProfileId: "other" } });
add("revision zero cannot be archived", "sessionState", { ...archived, revision: 0 });
add("different harness profile", "sessionState", { ...session, launchProfile: { ...profile, harnessId: "other" } });
add("no silent auth fallback", "sessionState", { ...session, launchProfile: { ...profile, billingMode: "metered" } });
add("time reversal", "runState", { ...running, updatedAt: "2026-09-04T00:00:00.000Z" });
add("do not truncate submillisecond time", "runState", { ...running, updatedAt: "2026-09-05T00:00:00.0001Z" });
add("completed without finish time", "runState", { ...runs.completed, finishedAt: null });
add("starting with start time", "runState", { ...starting, startedAt: at });
add("running without lock", "runState", { ...running, profileLocked: false });
add("stopping without stop intent", "runState", { ...runs.stopping, stopRequestedAt: null });
add("orphaned without reason", "runState", { ...runs.orphaned, recoveryReason: null });
add("active cannot clear stop intent", "runState", { ...running, stopRequestedAt: at });
add("pending with winner", "approvalState", { ...pending, resolvedByDeviceId: "device-1" });
add("decision requires receipt", "approvalState", { ...approved, resolutionReceiptId: null });
add("decision at exact expiry", "approvalState", { ...approved, updatedAt: expires, resolvedAt: expires });
add("early expiry", "approvalState", { ...approvals.expired, updatedAt: at, resolvedAt: at });
add("cancelled is not a user decision", "approvalState", { ...approvals.cancelled, resolvedByDeviceId: "device-1" });
add("foreign receipt acknowledgement", "approvalState", { ...acknowledged, nativeAcknowledgement: { ...acknowledged.nativeAcknowledgement, receiptId: "other" } });
add("negative revision", "runState", { ...running, revision: -1 }, false);
add("unknown root intent", "approvalState", { ...pending, autoApprove: true }, false);
add("pipe is not native evidence", "approvalState", { ...acknowledged, nativeAcknowledgement: { ...acknowledged.nativeAcknowledgement, evidence: { kind: "pipe_accepted", reference: "pipe-1" } } }, false);
add("oversized native identity", "runState", { ...running, nativeRunId: "x".repeat(513) }, false);
add("unsafe revision", "sessionState", { ...session, revision: Number.MAX_SAFE_INTEGER + 1 }, false);
module.exports = { at, expires, initialSession, session, archived, runs, approvals, acknowledged, cases };
