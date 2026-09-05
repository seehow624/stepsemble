/// <reference path="./protocol-types.d.ts" />
/** Reserved, pure entity reducers shared by Node and future clients.
 * Events are already-authorized journal facts, NOT requests or permission to
 * execute. No clocks, storage, native IO, retries or global mutable state. */
namespace StepsembleLifecycle {
  type Session = StepsembleClient.SessionState;
  type Run = StepsembleClient.RunState;
  type Approval = StepsembleClient.ApprovalState;
  type Event = StepsembleClient.WireEvent;
  type Profile = StepsembleClient.LaunchProfile;
  export type Check = { valid: boolean; code?: string };
  export interface Contracts {
    validate(name: string, value: unknown): Check;
    checkEvent(value: unknown): Check;
    checkProfile(value: unknown): Check;
  }
  export type Proposal<T> = { kind: "transition"; expectedRevision: number | null; state: T } | { kind: "reject"; code: string };
  export interface SessionContext { expectedRevision: number | null; writer: Run | null; profile?: Profile | null; }
  export interface RunContext {
    expectedRevision: number | null; session: Session; writer: Run | null;
    /** Complete transaction read of pending or decided-but-unacknowledged rows for this run. */
    unsettledApprovals: Approval[];
    identityAvailable?: boolean; approvalIdentityAvailable?: boolean; approvalNonceAvailable?: boolean;
  }
  export interface ApprovalContext { expectedRevision: number | null; run: Run; identityAvailable?: boolean; nonceAvailable?: boolean; }
  const ok: Check = Object.freeze({ valid: true });
  const bad = (code: string): Check => ({ valid: false, code });
  const reject = (code: string): { kind: "reject"; code: string } => ({ kind: "reject", code });
  const terminal = (state: string): boolean => ["completed", "failed", "interrupted"].includes(state);
  const clone = <T>(value: T): T => structuredClone(value);
  // Transport byte caps still belong BEFORE JSON parsing. This is a second cap
  // for already-decoded records, including additive informational properties.
  function bounded(value: unknown): boolean {
    try {
      const pending: Array<[unknown, number]> = [[value, 0]], seen = new Set<object>();
      let nodes = 0;
      while (pending.length) {
        const [item, depth] = pending.pop()!;
        if (++nodes > 8192 || depth > 64) return false;
        if (item === null || typeof item === "boolean") continue;
        if (typeof item === "string") { if (item.length > 65536) return false; continue; }
        if (typeof item === "number") { if (!Number.isFinite(item)) return false; continue; }
        if (typeof item !== "object" || seen.has(item)) return false;
        seen.add(item);
        const proto = Object.getPrototypeOf(item);
        if (!Array.isArray(item) && proto !== null && Object.getPrototypeOf(proto) !== null) return false;
        const descriptors = Object.getOwnPropertyDescriptors(item), keys = Reflect.ownKeys(descriptors);
        if (Array.isArray(item) && keys.length !== item.length + 1) return false;
        for (const key of keys) {
          if (Array.isArray(item) && key === "length") continue;
          if (typeof key !== "string" || !("value" in descriptors[key]) || !descriptors[key].enumerable) return false;
          pending.push([descriptors[key].value, depth + 1]);
        }
      }
      return new TextEncoder().encode(JSON.stringify(value)).length <= 65536;
    } catch { return false; }
  }
  function equal(a: unknown, b: unknown): boolean {
    if (a === b) return true;
    if (!a || !b || typeof a !== "object" || typeof b !== "object" || Array.isArray(a) !== Array.isArray(b)) return false;
    const left = a as Record<string, unknown>, right = b as Record<string, unknown>, keys = Object.keys(left);
    return keys.length === Object.keys(right).length && keys.every(key => Object.hasOwn(right, key) && equal(left[key], right[key]));
  }
  const profileFields = ["launchProfileId", "harnessId", "modelId", "sourceId", "authMode", "billingMode", "credentialReference"] as const;
  const sameProfile = (a: Profile, b: Profile): boolean => profileFields.every(key => a[key] === b[key]);
  // Lifecycle ordering is explicitly millisecond-resolution. Never silently
  // truncate a higher-precision timestamp while comparing expiry or transitions.
  const instant = (value: string): number => value.length <= 64 && !/\.\d{4}/.test(value) ? Date.parse(value) : NaN;
  const inRange = (value: string | null, start: number, end: number): boolean => value === null || instant(value) >= start && instant(value) <= end;
  const unsettled = (state: Approval): boolean => state.approval.status === "pending"
    || ["approved", "denied"].includes(state.approval.status) && state.nativeAcknowledgement === null;

  export function create(contracts: Contracts) {
    function shape(name: string, value: unknown): boolean { return bounded(value) && contracts.validate(name, value).valid; }
    function checkSession(value: unknown): Check {
      if (!shape("sessionState", value)) return bad("invalid_payload");
      const s = value as Session, created = instant(s.session.createdAt), updated = instant(s.updatedAt);
      if (!Number.isFinite(created) || !Number.isFinite(updated) || updated < created) return bad("state_time_conflict");
      if ((s.session.status === "archived") !== (s.archiveId !== null)) return bad("session_conflict");
      if (s.revision === 0 && (s.session.status !== "active" || s.title !== null || updated !== created)) return bad("session_conflict");
      if (s.launchProfile === null) return s.session.launchProfileId === null ? ok : bad("profile_mismatch");
      return contracts.checkProfile(s.launchProfile).valid && s.session.launchProfileId === s.launchProfile.launchProfileId
        && s.session.native.harnessId === s.launchProfile.harnessId ? ok : bad("profile_mismatch");
    }
    function checkRun(value: unknown): Check {
      if (!shape("runState", value)) return bad("invalid_payload");
      const s = value as Run, created = instant(s.run.createdAt), updated = instant(s.updatedAt), state = s.run.state;
      if (!Number.isFinite(created) || !Number.isFinite(updated) || updated < created
        || ![s.startedAt, s.stopRequestedAt, s.finishedAt].every(time => inRange(time, created, updated))) return bad("state_time_conflict");
      if (!contracts.checkProfile(s.launchProfile).valid) return bad("profile_mismatch");
      if (s.revision === 0 && (state !== "starting" || updated !== created || s.profileLocked)) return bad("run_conflict");
      if ((s.finishedAt !== null) !== terminal(state) || (s.recoveryReason !== null) !== (state === "orphaned")) return bad("run_conflict");
      if (s.finishedAt !== null && [s.startedAt, s.stopRequestedAt].some(time => time !== null && instant(time) > instant(s.finishedAt!))) return bad("state_time_conflict");
      if (s.nativeRunId !== null && s.startedAt === null || s.startedAt !== null && !s.profileLocked) return bad("run_conflict");
      if (["running", "waiting_approval", "completed"].includes(state) && s.startedAt === null) return bad("run_conflict");
      if (state === "starting" && (s.startedAt !== null || s.stopRequestedAt !== null)
        || state === "stopping" && s.stopRequestedAt === null
        || ["running", "waiting_approval"].includes(state) && s.stopRequestedAt !== null) return bad("run_conflict");
      return ok;
    }
    function checkApproval(value: unknown): Check {
      if (!shape("approvalState", value)) return bad("invalid_payload");
      const s = value as Approval, a = s.approval, created = instant(a.createdAt), expires = instant(a.expiresAt), updated = instant(s.updatedAt);
      if (![created, expires, updated].every(Number.isFinite) || expires <= created || updated < created || !inRange(s.resolvedAt, created, updated)) return bad("state_time_conflict");
      if (a.status === "pending") return s.revision === 0 && updated === created && s.resolvedAt === null && s.resolvedByDeviceId === null
        && s.resolutionReceiptId === null && s.nativeAcknowledgement === null && s.terminalReason === null ? ok : bad("approval_conflict");
      if (s.revision === 0 || s.resolvedAt === null) return bad("approval_conflict");
      if (["approved", "denied"].includes(a.status)) {
        if (instant(s.resolvedAt) >= expires || s.resolvedByDeviceId === null || s.resolutionReceiptId === null || s.terminalReason !== null) return bad("approval_conflict");
        if (s.nativeAcknowledgement !== null && s.nativeAcknowledgement.receiptId !== s.resolutionReceiptId) return bad("approval_conflict");
      } else if (s.resolvedByDeviceId !== null || s.resolutionReceiptId !== null || s.nativeAcknowledgement !== null || s.terminalReason === null
        || a.status === "expired" && instant(s.resolvedAt) < expires) return bad("approval_conflict");
      return ok;
    }
    function preflight(prior: { revision: number; updatedAt: string } | null, event: unknown, expected: unknown): Check {
      if (!shape("event", event) || !contracts.checkEvent(event).valid) return bad("invalid_payload");
      if (expected !== (prior?.revision ?? null)) return bad("revision_conflict");
      if (prior?.revision === Number.MAX_SAFE_INTEGER) return bad("revision_overflow");
      const now = instant((event as Event).createdAt);
      if (!Number.isFinite(now) || prior && now < instant(prior.updatedAt)) return bad("state_time_conflict");
      return ok;
    }
    function finish<T extends { revision: number; updatedAt: string }>(prior: T | null, state: T, event: Event, check: (state: unknown) => Check): Proposal<T> {
      state.revision = prior ? prior.revision + 1 : 0;
      state.updatedAt = new Date(instant(event.createdAt)).toISOString();
      const result = check(state);
      return result.valid ? { kind: "transition", expectedRevision: prior?.revision ?? null, state } : reject(result.code!);
    }
    function reduceSession(prior: Session | null, input: unknown, context: SessionContext): Proposal<Session> {
      if (prior !== null && !checkSession(prior).valid || !context || !Object.hasOwn(context, "writer")) return reject("invalid_context");
      const check = preflight(prior, input, context.expectedRevision); if (!check.valid) return reject(check.code!);
      const event = input as Event, writer = context.writer;
      if (writer !== null && (!checkRun(writer).valid || writer.run.sessionId !== event.sessionId || terminal(writer.run.state))) return reject("invalid_context");
      if (writer && instant(event.createdAt) < instant(writer.updatedAt)) return reject("state_time_conflict");
      if (prior === null) {
        if (event.type !== "session.created" || writer !== null || !Object.hasOwn(context, "profile") || context.profile === undefined) return reject("session_conflict");
        const session = clone(event.payload.session);
        return finish(null, { session, revision: 0, updatedAt: event.createdAt, title: null, archiveId: null, launchProfile: clone(context.profile ?? null) }, event, checkSession);
      }
      if (prior.session.sessionId !== event.sessionId) return reject("entity_mismatch");
      const next = clone(prior);
      if (event.type === "session.restored") {
        if (prior.session.status !== "archived" || prior.archiveId !== event.payload.archiveId || writer !== null) return reject("session_conflict");
        next.session.status = "active"; next.archiveId = null;
      } else {
        if (prior.session.status !== "active") return reject("session_conflict");
        if (event.type === "session.updated") next.title = event.payload.title;
        else if (event.type === "session.archived") {
          if (writer !== null) return reject("run_conflict");
          next.session.status = "archived"; next.archiveId = event.payload.archiveId;
        } else if (event.type === "model.changed") {
          if (writer !== null) return reject("run_conflict");
          const profile = event.payload.launchProfile;
          if (!contracts.checkProfile(profile).valid || profile.harnessId !== prior.session.native.harnessId) return reject("profile_mismatch");
          if (prior.launchProfile) {
            if (["sourceId", "authMode", "billingMode", "credentialReference"].some(key => profile[key] !== prior.launchProfile![key])) return reject("fork_required");
            if (profile.launchProfileId === prior.launchProfile.launchProfileId && !sameProfile(profile, prior.launchProfile)) return reject("profile_mismatch");
          }
          next.launchProfile = clone(profile); next.session.launchProfileId = profile.launchProfileId;
        } else return reject("unsupported_event");
      }
      return finish(prior, next, event, checkSession);
    }
    function reduceRun(prior: Run | null, input: unknown, context: RunContext): Proposal<Run> {
      if (prior !== null && !checkRun(prior).valid || !context || !checkSession(context.session).valid
        || !Object.hasOwn(context, "writer") || !Array.isArray(context.unsettledApprovals) || context.unsettledApprovals.length > 128) return reject("invalid_context");
      const check = preflight(prior, input, context.expectedRevision); if (!check.valid) return reject(check.code!);
      const event = input as Event, session = context.session, writer = context.writer, approvals = context.unsettledApprovals;
      if (event.sessionId !== session.session.sessionId || prior && (prior.run.sessionId !== event.sessionId || prior.run.runId !== event.runId)) return reject("entity_mismatch");
      if (session.session.status !== "active") return reject("session_conflict");
      if (instant(event.createdAt) < instant(session.updatedAt)) return reject("state_time_conflict");
      if (prior && (prior.launchProfile.harnessId !== session.session.native.harnessId
        || !terminal(prior.run.state) && (!session.launchProfile || !sameProfile(prior.launchProfile, session.launchProfile)))) return reject("profile_mismatch");
      if (writer !== null && (!checkRun(writer).valid || writer.run.sessionId !== event.sessionId || terminal(writer.run.state))) return reject("invalid_context");
      if (prior && !terminal(prior.run.state) && !equal(writer, prior) || prior && terminal(prior.run.state) && writer !== null) return reject("writer_conflict");
      const seen = new Set<string>(), nonces = new Set<string>(), nativeRequests = new Set<string>();
      for (const a of approvals) {
        if (!checkApproval(a).valid || !unsettled(a) || a.approval.runId !== event.runId || a.approval.sessionId !== event.sessionId
          || seen.has(a.approval.approvalId) || nonces.has(a.approval.nonce) || nativeRequests.has(a.approval.nativeRequestId)) return reject("invalid_context");
        if (instant(event.createdAt) < instant(a.updatedAt)) return reject("state_time_conflict");
        seen.add(a.approval.approvalId); nonces.add(a.approval.nonce); nativeRequests.add(a.approval.nativeRequestId);
      }
      if (prior === null) {
        if (event.type !== "run.starting" || writer !== null || approvals.length || context.identityAvailable !== true) return reject("run_conflict");
        if (session.launchProfile === null) return reject("profile_mismatch");
        return finish(null, { run: clone(event.payload.run), revision: 0, updatedAt: event.createdAt, launchProfile: clone(session.launchProfile), profileLocked: false,
          nativeRunId: null, startedAt: null, stopRequestedAt: null, finishedAt: null, recoveryReason: null }, event, checkRun);
      }
      if (terminal(prior.run.state)) return reject("run_conflict");
      const next = clone(prior), now = new Date(instant(event.createdAt)).toISOString(), state = prior.run.state;
      if (event.type === "launch_profile.locked") {
        if (state !== "starting" || prior.profileLocked || !sameProfile(prior.launchProfile, event.payload.launchProfile)) return reject("profile_mismatch");
        next.profileLocked = true;
      } else if (event.type === "run.started") {
        if (state !== "starting" || !prior.profileLocked || approvals.length) return reject("run_conflict");
        next.run.state = "running"; next.startedAt = now; next.nativeRunId = event.payload.nativeRunId;
      } else if (event.type === "approval.requested") {
        if (seen.has(event.payload.approval.approvalId) || nonces.has(event.payload.approval.nonce)
          || nativeRequests.has(event.payload.approval.nativeRequestId) || approvals.length >= 32) return reject("approval_conflict");
        const approval = reduceApproval(null, event, { expectedRevision: null, run: prior, identityAvailable: context.approvalIdentityAvailable, nonceAvailable: context.approvalNonceAvailable });
        if (approval.kind === "reject") return approval;
        next.run.state = "waiting_approval";
      } else if (event.type === "run.stopping") {
        if (!["starting", "running", "waiting_approval"].includes(state)) return reject("run_conflict");
        next.run.state = "stopping"; next.stopRequestedAt = now;
      } else if (event.type === "run.orphaned") {
        if (state === "orphaned") return reject("run_conflict");
        next.run.state = "orphaned"; next.recoveryReason = event.payload.reason;
      } else if (event.type === "run.resumed" || event.type === "run.reconciled") {
        if (state !== (event.type === "run.resumed" ? "waiting_approval" : "orphaned") || !prior.profileLocked) return reject("run_conflict");
        const target = event.type === "run.resumed" ? "running" : event.payload.state;
        if (target === "running" && (approvals.length || prior.stopRequestedAt !== null)
          || target === "waiting_approval" && (!approvals.length || prior.stopRequestedAt !== null)) return reject("approval_conflict");
        if (prior.nativeRunId !== null && event.payload.nativeRunId !== prior.nativeRunId) return reject("entity_mismatch");
        next.run.state = target; next.recoveryReason = null; next.nativeRunId = event.payload.nativeRunId;
        next.startedAt ??= now;
        if (target === "stopping") next.stopRequestedAt ??= now;
      } else if (["run.completed", "run.failed", "run.interrupted"].includes(event.type)) {
        if (approvals.some(a => a.approval.status === "pending")) return reject("approval_conflict");
        if (event.type === "run.completed" && prior.startedAt === null) return reject("run_conflict");
        next.run.state = event.type === "run.completed" ? "completed" : event.type === "run.failed" ? "failed" : "interrupted";
        next.finishedAt = now; next.recoveryReason = null;
      } else return reject("unsupported_event");
      return finish(prior, next, event, checkRun);
    }
    function reduceApproval(prior: Approval | null, input: unknown, context: ApprovalContext): Proposal<Approval> {
      if (prior !== null && !checkApproval(prior).valid || !context || !checkRun(context.run).valid) return reject("invalid_context");
      const check = preflight(prior, input, context.expectedRevision); if (!check.valid) return reject(check.code!);
      const event = input as Event, run = context.run;
      if (event.sessionId !== run.run.sessionId || event.runId !== run.run.runId
        || prior && (prior.approval.sessionId !== event.sessionId || prior.approval.runId !== event.runId)) return reject("entity_mismatch");
      if (instant(event.createdAt) < instant(run.updatedAt)) return reject("state_time_conflict");
      if (prior === null) {
        if (event.type !== "approval.requested" || !["running", "waiting_approval"].includes(run.run.state)
          || context.identityAvailable !== true || context.nonceAvailable !== true) return reject("approval_conflict");
        return finish(null, { approval: clone(event.payload.approval), revision: 0, updatedAt: event.createdAt, resolvedAt: null,
          resolvedByDeviceId: null, resolutionReceiptId: null, nativeAcknowledgement: null, terminalReason: null }, event, checkApproval);
      }
      if (!["approval.resolved", "approval.expired", "approval.cancelled", "approval.acknowledged"].includes(event.type)) return reject("unsupported_event");
      // Narrow explicitly: unrelated informational events are never silently applied.
      if (!("approvalId" in event.payload) || event.payload.approvalId !== prior.approval.approvalId) return reject("entity_mismatch");
      const next = clone(prior), now = instant(event.createdAt);
      if (event.type === "approval.acknowledged") {
        if (!["approved", "denied"].includes(prior.approval.status) || prior.nativeAcknowledgement !== null
          || event.payload.nonce !== prior.approval.nonce || event.payload.receiptId !== prior.resolutionReceiptId) return reject("approval_conflict");
        next.nativeAcknowledgement = { receiptId: event.payload.receiptId, attemptId: event.payload.attemptId, evidence: clone(event.payload.evidence) };
      } else {
        if (prior.approval.status !== "pending" || terminal(run.run.state)) return reject("approval_conflict");
        next.resolvedAt = new Date(now).toISOString();
        if (event.type === "approval.resolved") {
          if (run.run.state !== "waiting_approval" || now >= instant(prior.approval.expiresAt) || event.payload.nonce !== prior.approval.nonce
            || event.payload.nativeAcknowledged !== false) return reject("approval_conflict");
          next.approval.status = event.payload.decision; next.resolvedByDeviceId = event.payload.deviceId; next.resolutionReceiptId = event.payload.receiptId;
        } else if (event.type === "approval.expired") {
          if (now < instant(prior.approval.expiresAt)) return reject("approval_conflict");
          next.approval.status = "expired"; next.terminalReason = "expired";
        } else if (event.type === "approval.cancelled") {
          next.approval.status = "cancelled"; next.terminalReason = event.payload.reason;
        } else return reject("unsupported_event");
      }
      return finish(prior, next, event, checkApproval);
    }
    return Object.freeze({ checkSession, checkRun, checkApproval, reduceSession, reduceRun, reduceApproval });
  }
}
// The exact same generated artifact is required by Node tests and evaluated by
// browsers. It is deliberately not loaded by the live legacy UI yet.
declare const module: { exports: unknown } | undefined;
if (typeof module !== "undefined") module.exports = StepsembleLifecycle;
