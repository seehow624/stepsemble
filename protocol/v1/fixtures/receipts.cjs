"use strict";
// Expected shape/state outcomes are data, independent of either implementation.
const accepted = require("./domains.json").find(item => item.contract === "commandReceipt").value;
const evidence = { kind: "native_ack", reference: "verified-evidence-1" };
const outcome = { status: "succeeded", code: "applied", resultReference: "result-1", evidence };
const states = {
  accepted,
  dispatching: { ...accepted, state: "dispatching", attemptId: "attempt-1", revision: 1 },
  awaiting_confirmation: { ...accepted, state: "awaiting_confirmation", attemptId: "attempt-1", revision: 2 },
  uncertain: { ...accepted, state: "uncertain", attemptId: "attempt-1", revision: 3 },
  succeeded: { ...accepted, state: "succeeded", attemptId: "attempt-1", revision: 4, outcome },
  failed: { ...accepted, state: "failed", attemptId: "attempt-1", revision: 4, outcome: { ...outcome, status: "failed", code: "native_rejected" } },
};
const cases = Object.entries(states).map(([name, value]) => ({ name, value, shape: true, state: true }));
function add(name, value, shape, state = false) { cases.push({ name, value, shape, state }); }
add("pre-dispatch rejection", { ...accepted, state: "failed", revision: 1, outcome: { status: "failed", code: "unsupported", resultReference: null, evidence: null } }, true, true);
add("time reversal", { ...accepted, updatedAt: "2026-09-04T00:00:00Z" }, true);
add("accepted with attempt", { ...accepted, attemptId: "attempt-1" }, true);
add("accepted with nonzero revision", { ...accepted, revision: 1 }, true);
add("dispatch without attempt", { ...states.dispatching, attemptId: null }, true);
add("dispatch with zero revision", { ...states.dispatching, revision: 0 }, true);
add("uncertain with result", { ...states.uncertain, outcome }, true);
add("success without dispatch", { ...states.succeeded, attemptId: null }, true);
add("success without outcome", { ...states.succeeded, outcome: null }, true);
add("success without evidence", { ...states.succeeded, outcome: { ...outcome, evidence: null } }, true);
add("failure with wrong status", { ...states.failed, outcome }, true);
add("pre-dispatch failure cannot claim a result", { ...states.failed, attemptId: null, outcome: { ...states.failed.outcome, evidence: null } }, true);
add("unknown state", { ...accepted, state: "auto_retry" }, false);
add("unknown fingerprint version", { ...accepted, fingerprintVersion: "future" }, false);
add("short digest", { ...accepted, fingerprint: "a".repeat(63) }, false);
add("newline digest", { ...accepted, fingerprint: accepted.fingerprint + "\n" }, false);
add("uppercase digest", { ...accepted, fingerprint: accepted.fingerprint.toUpperCase() }, false);
add("unsafe revision", { ...accepted, revision: Number.MAX_SAFE_INTEGER + 1 }, false);
add("fractional revision", { ...accepted, revision: 1.1 }, false);
add("negative revision", { ...accepted, revision: -1 }, false);
add("oversized fractional timestamp", { ...accepted, createdAt: "2026-09-05T00:00:00." + "0".repeat(100) + "Z" }, false);
add("pipe acceptance is not evidence", { ...states.succeeded, outcome: { ...outcome, evidence: { ...evidence, kind: "pipe_accepted" } } }, false);
add("no secret result blobs", { ...states.succeeded, outcome: { ...outcome, secret: "synthetic" } }, false);
add("no path result references", { ...states.succeeded, outcome: { ...outcome, resultReference: "/private/result" } }, false);
module.exports = { states, cases, outcome };
