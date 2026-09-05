"use strict";

// Pure contract semantics. No IO, storage, clocks, dispatch or auto-approval.
// The future durable Host must perform these checks inside its transaction.
function createDomain(contracts) {
  const valid = Object.freeze({ valid: true });
  const invalid = code => ({ valid: false, code });
  const terminal = new Set(["completed", "failed", "interrupted"]);
  const same = (left, right) => left.sessionId === right.sessionId;
  function checkEvent(event) {
    if (!contracts.validate("event", event).valid) return invalid("invalid_payload");
    const { payload, type } = event;
    if (type === "session.created" && (!same(event, payload.session) || payload.session.status !== "active")) return invalid("entity_mismatch");
    if (type === "run.starting" && (!same(event, payload.run) || event.runId !== payload.run.runId || payload.run.state !== "starting")) return invalid("entity_mismatch");
    if (type === "approval.requested") {
      const approval = payload.approval;
      if (!same(event, approval) || event.runId !== approval.runId || approval.status !== "pending") return invalid("entity_mismatch");
      if (Date.parse(approval.createdAt) > Date.parse(event.createdAt) || Date.parse(approval.expiresAt) <= Date.parse(event.createdAt)) return invalid("approval_expired");
    }
    if (type === "model.changed" || type === "launch_profile.locked") {
      const result = checkProfile(payload.launchProfile);
      if (!result.valid) return result;
    }
    return valid;
  }
  function checkProfile(profile) {
    if (!contracts.validate("launchProfile", profile).valid) return invalid("invalid_payload");
    const expected = { native_subscription: "subscription", api_key: "metered", local: "local", unknown: "unknown" };
    // A native account is referenced by its harness, never by copied credentials.
    if (profile.billingMode !== expected[profile.authMode] || profile.authMode === "native_subscription" && profile.credentialReference !== null) return invalid("profile_mismatch");
    return valid;
  }
  function checkCommandContext(command, context) {
    if (!contracts.validate("command", command).valid || !context || !contracts.validate("session", context.session).valid
      || !Object.hasOwn(context, "run") || context.run === undefined
      || !contracts.validate("id", context.authenticatedDeviceId).valid) return invalid("invalid_payload");
    if (command.deviceId !== context.authenticatedDeviceId) return invalid("device_mismatch");
    if (!same(command, context.session)) return invalid("entity_mismatch");
    const run = context.run;
    if (run != null && (!contracts.validate("run", run).valid || !same(command, run))) return invalid("entity_mismatch");
    const active = run != null && !terminal.has(run.state);
    if (command.type === "session.restore") return context.session.status === "archived" && !active ? valid : invalid("session_conflict");
    if (context.session.status !== "active") return invalid("session_conflict");
    if (["run.start", "model.change", "session.archive", "context.compact"].includes(command.type) && active) return invalid("run_conflict");
    if (["run.start", "model.change"].includes(command.type)) {
      const profile = context.launchProfile;
      if (!checkProfile(profile).valid || profile.launchProfileId !== command.payload.launchProfileId || profile.harnessId !== context.session.native.harnessId) return invalid("profile_mismatch");
      if (command.type === "run.start" && run?.runId === command.payload.runId) return invalid("run_conflict");
    }
    if (command.type === "run.interrupt" && (!active || run.runId !== command.payload.runId)) return invalid("run_conflict");
    if (command.type === "approval.resolve") {
      const approval = context.approval;
      if (!contracts.validate("approval", approval).valid || !Number.isSafeInteger(context.now)) return invalid("invalid_payload");
      if (!active || run.state !== "waiting_approval" || run.runId !== command.payload.runId || !same(command, approval)
        || approval.runId !== run.runId || approval.approvalId !== command.payload.approvalId) return invalid("entity_mismatch");
      if (approval.status !== "pending") return invalid("approval_conflict");
      if (context.now < Date.parse(approval.createdAt) || context.now >= Date.parse(approval.expiresAt)) return invalid("approval_expired");
      if (approval.nonce !== command.payload.nonce || approval.scope !== command.payload.scope) return invalid("approval_conflict");
    }
    return valid;
  }
  function checkReplayBatch(batch) {
    if (!contracts.validate("replayBatch", batch).valid) return invalid("invalid_payload");
    const { afterCursor: start, cursor: end, events, hasMore } = batch;
    if (!same(start, end) || start.generation !== end.generation) return invalid("cursor_mismatch");
    if (end.sequence - start.sequence !== events.length || hasMore && !events.length) return invalid("sequence_gap");
    const ids = new Set();
    for (let index = 0; index < events.length; index++) {
      const event = events[index];
      const result = checkEvent(event);
      if (!result.valid) return result;
      if (!same(start, event) || start.generation !== event.generation) return invalid("cursor_mismatch");
      if (event.sequence !== start.sequence + index + 1) return invalid("sequence_gap");
      if (ids.has(event.eventId)) return invalid("event_conflict");
      ids.add(event.eventId);
    }
    return valid;
  }
  function inspectReplay(cursor, batch) {
    const reset = reason => ({ kind: "snapshot_required", reason });
    if (!contracts.validate("cursor", cursor).valid) return reset("invalid_payload");
    const result = checkReplayBatch(batch);
    if (!result.valid) return reset(result.code);
    if (!same(cursor, batch.cursor) || cursor.generation !== batch.cursor.generation) return reset("cursor_mismatch");
    if (batch.afterCursor.sequence > cursor.sequence) return reset("sequence_gap");
    if (batch.cursor.sequence <= cursor.sequence) return { kind: "duplicate" };
    // Apply atomically with the projection, then persist the returned cursor.
    // Never advance it just because a transport frame was received.
    return { kind: "apply", events: batch.events.filter(event => event.sequence > cursor.sequence), cursor: { ...batch.cursor } };
  }
  return Object.freeze({ checkEvent, checkProfile, checkCommandContext, checkReplayBatch, inspectReplay });
}

module.exports = { createDomain };
