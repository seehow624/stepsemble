/// <reference path="./lifecycle.ts" />
/** Reserved normalized history, NOT the native transcript or a durable store.
 * Applying a batch returns one detached proposal. Publish it only with a cursor
 * compare-and-swap AND a local/store revision fence (a same-cursor snapshot can
 * replace state). No event in this module dispatches a native action. */
namespace StepsembleProjection {
  type State = StepsembleClient.SessionProjection;
  type Event = StepsembleClient.WireEvent;
  type Cursor = StepsembleClient.Cursor;
  type Run = StepsembleClient.RunState;
  type Approval = StepsembleClient.ApprovalState;
  type Message = StepsembleClient.ProjectionMessage;
  type Tool = StepsembleClient.ProjectionTool;
  type Life = ReturnType<typeof StepsembleLifecycle.create>;
  type Check = StepsembleLifecycle.Check;
  export interface Contracts extends StepsembleLifecycle.Contracts { checkReplayBatch(value: unknown): Check; }
  export type Result = { kind: "apply"; expectedCursor: Cursor; state: State } | { kind: "duplicate"; expectedCursor: Cursor }
    | { kind: "snapshot_required"; reason: string };
  /** Capture these when sending a snapshot request, not when it returns.
   * A generation change is explicit; snapshots are accepted only from an
   * authenticated Host. The digest is corruption detection, not authentication. */
  export interface RestoreContext { expectedCursor: Cursor; targetGeneration: string; }
  export interface SnapshotRequest extends RestoreContext { localRevision: number; }
  const LIMIT = 32 * 1024 * 1024, WINDOW = 5000;
  const bad = (code: string): Check => ({ valid: false, code });
  const reset = (reason: string): Result => ({ kind: "snapshot_required", reason });
  const terminal = (state: string): boolean => ["completed", "failed", "interrupted"].includes(state);
  const unsettled = (a: Approval): boolean => a.approval.status === "pending" || ["approved", "denied"].includes(a.approval.status) && a.nativeAcknowledgement === null;
  const instant = (time: string): number => time.length <= 64 && !/\.\d{4}/.test(time) ? Date.parse(time) : NaN;
  const sameCursor = (a: Cursor, b: Cursor): boolean => a.sessionId === b.sessionId && a.generation === b.generation && a.sequence === b.sequence;
  const sameProfile = (a: StepsembleClient.LaunchProfile, b: StepsembleClient.LaunchProfile): boolean =>
    ["launchProfileId", "harnessId", "modelId", "sourceId", "authMode", "billingMode", "credentialReference"].every(key => a[key] === b[key]);
  const points = (value: string): number => Array.from(value).length;
  function wellFormed(value: string): boolean {
    for (let i = 0; i < value.length; i++) {
      const unit = value.charCodeAt(i);
      if (unit >= 0xd800 && unit <= 0xdbff) { const next = value.charCodeAt(++i); if (!(next >= 0xdc00 && next <= 0xdfff)) return false; }
      else if (unit >= 0xdc00 && unit <= 0xdfff) return false;
    }
    return true;
  }
  /** Sorted UTF-16 keys; JSON primitive/number encoding; arrays retain order.
   * Plain JSON trees only. Never call accessors, toJSON or error.stringify.
   * Transport MUST also cap raw bytes before parsing; Proxies are not a wire type. */
  export function canonicalJSON(value: unknown, limit = LIMIT): string | null {
    let nodes = 0, units = 0;
    const seen = new Set<object>();
    function visit(item: unknown, depth: number): string {
      if (++nodes > 1000000 || depth > 64) throw 0;
      if (item === null || typeof item === "boolean") return JSON.stringify(item);
      if (typeof item === "string") { units += item.length; if (units > limit || !wellFormed(item)) throw 0; return JSON.stringify(item); }
      if (typeof item === "number") { if (!Number.isFinite(item)) throw 0; return JSON.stringify(item); }
      if (typeof item !== "object" || seen.has(item)) throw 0;
      seen.add(item);
      const proto = Object.getPrototypeOf(item), array = Array.isArray(item);
      if (!array && proto !== null && Object.getPrototypeOf(proto) !== null) throw 0;
      const descriptors = Object.getOwnPropertyDescriptors(item), keys = Reflect.ownKeys(descriptors);
      if (array && keys.length !== item.length + 1) throw 0;
      for (const key of keys) {
        if (array && key === "length") continue;
        if (typeof key !== "string" || !wellFormed(key) || !("value" in descriptors[key]) || !descriptors[key].enumerable) throw 0;
        units += key.length; if (units > limit) throw 0;
      }
      if (array) return `[${Array.from({ length: item.length }, (_, i) => {
        const d = descriptors[String(i)]; if (!d || !("value" in d)) throw 0; return visit(d.value, depth + 1);
      }).join(",")}]`;
      return `{${(keys as string[]).sort().map(key => `${JSON.stringify(key)}:${visit(descriptors[key].value, depth + 1)}`).join(",")}}`;
    }
    try { const json = visit(value, 0); return new TextEncoder().encode(json).length <= limit ? json : null; } catch { return null; }
  }
  async function hash(kind: "event" | "snapshot", canonical: string): Promise<string> {
    const bytes = new TextEncoder().encode(`["stepsemble.${kind}.v1",${canonical}]`);
    const result = await globalThis.crypto.subtle.digest("SHA-256", bytes);
    return Array.from(new Uint8Array(result), byte => byte.toString(16).padStart(2, "0")).join("");
  }
  export function create(contracts: Contracts, lifecycle: Life) {
    const rows = (s: State) => [s.runs, s.approvals, s.messages, s.tools, s.usage, s.contexts];
    function checkState(input: unknown): Check {
      if (canonicalJSON(input) === null || !contracts.validate("sessionProjection", input).valid) return bad("invalid_payload");
      return checkRelations(input as State);
    }
    function checkRelations(s: State): Check {
      const { cursor } = s, end = s.updatedAt === null ? NaN : instant(s.updatedAt);
      if (s.identityFloor > cursor.sequence || cursor.sequence - s.identityFloor !== s.identities.length) return bad("identity_conflict");
      const ids = new Set<string>();
      for (let i = 0; i < s.identities.length; i++) {
        const id = s.identities[i];
        if (id.sequence !== s.identityFloor + i + 1 || ids.has(id.eventId)) return bad("identity_conflict");
        ids.add(id.eventId);
      }
      if (cursor.sequence === 0) return s.session === null && s.updatedAt === null && rows(s).every(list => !list.length) ? { valid: true } : bad("session_conflict");
      if (!Number.isFinite(end) || s.session === null || !lifecycle.checkSession(s.session).valid || s.session.session.sessionId !== cursor.sessionId) return bad("session_conflict");
      const start = instant(s.session.session.createdAt);
      const time = (created: string, updated: string): boolean => instant(created) >= start && instant(updated) >= instant(created) && instant(updated) <= end;
      if (!time(s.session.session.createdAt, s.session.updatedAt) || s.session.revision >= cursor.sequence) return bad("state_time_conflict");
      const runs = new Map<string, Run>(); let writer: Run | null = null;
      for (const row of s.runs) {
        if (!lifecycle.checkRun(row).valid || row.run.sessionId !== cursor.sessionId || runs.has(row.run.runId) || row.revision >= cursor.sequence
          || row.launchProfile.harnessId !== s.session.session.native.harnessId || !time(row.run.createdAt, row.updatedAt)) return bad("run_conflict");
        if (!terminal(row.run.state)) {
          if (writer || s.session.session.status !== "active" || !s.session.launchProfile || !sameProfile(s.session.launchProfile, row.launchProfile)) return bad("writer_conflict");
          writer = row;
        }
        runs.set(row.run.runId, row);
      }
      const bound = (row: { runId: string; updatedAt: string }, created = row.updatedAt): Run | null => {
        const run = runs.get(row.runId);
        return run && time(created, row.updatedAt) && instant(created) >= instant(run.run.createdAt) ? run : null;
      };
      const toolMap = new Map<string, Tool>(), messageIds = new Set<string>();
      for (const m of s.messages) {
        const run = bound(m, m.createdAt);
        if (!run || messageIds.has(m.messageId) || m.role === "user" && (m.status !== "completed" || m.thinking !== "")
          || (m.status === "incomplete") !== (m.terminalCause !== null) || m.status === "streaming" && terminal(run.run.state)
          || m.status === "incomplete" && (m.terminalCause !== run.run.state || m.updatedAt !== run.finishedAt)
          || terminal(run.run.state) && instant(m.updatedAt) > instant(run.finishedAt!)
          || m.role === "assistant" && (run.startedAt === null || instant(m.createdAt) < instant(run.startedAt))) return bad("message_conflict");
        messageIds.add(m.messageId);
      }
      for (const t of s.tools) {
        const run = bound(t, t.createdAt);
        if (!run || toolMap.has(t.toolId) || run.startedAt === null || instant(t.createdAt) < instant(run.startedAt)
          || (t.status === "completed") !== (t.output !== null) || (t.status === "failed") !== (t.error !== null)
          || (t.status === "incomplete") !== (t.terminalCause !== null) || ["requested", "running"].includes(t.status) && terminal(run.run.state)
          || t.status === "incomplete" && (t.terminalCause !== run.run.state || t.updatedAt !== run.finishedAt)
          || terminal(run.run.state) && instant(t.updatedAt) > instant(run.finishedAt!)) return bad("tool_conflict");
        toolMap.set(t.toolId, t);
      }
      const approvalIds = new Set<string>(), nonces = new Set<string>(), nativeIds = new Set<string>();
      const unsettledCounts = new Map<string, number>();
      for (const a of s.approvals) {
        const run = bound({ runId: a.approval.runId, updatedAt: a.updatedAt }, a.approval.createdAt);
        const nativeKey = JSON.stringify([a.approval.runId, a.approval.nativeRequestId]);
        if (!run || !lifecycle.checkApproval(a).valid || a.approval.sessionId !== cursor.sessionId || a.revision >= cursor.sequence
          || approvalIds.has(a.approval.approvalId) || nonces.has(a.approval.nonce) || nativeIds.has(nativeKey)
          || a.approval.toolId !== null && toolMap.get(a.approval.toolId)?.runId !== a.approval.runId
          || a.approval.toolId !== null && ["running", "completed"].includes(toolMap.get(a.approval.toolId)?.status ?? "")
            && (a.approval.status !== "approved" || a.nativeAcknowledgement === null)
          || run.startedAt === null || instant(a.approval.createdAt) < instant(run.startedAt)
          || a.approval.status === "pending" && terminal(run.run.state)
          || a.resolvedAt !== null && terminal(run.run.state) && instant(a.resolvedAt) > instant(run.finishedAt!)) return bad("approval_conflict");
        approvalIds.add(a.approval.approvalId); nonces.add(a.approval.nonce); nativeIds.add(nativeKey);
        if (unsettled(a)) unsettledCounts.set(run.run.runId, (unsettledCounts.get(run.run.runId) ?? 0) + 1);
      }
      for (const run of runs.values()) {
        const count = unsettledCounts.get(run.run.runId) ?? 0;
        if (count > 32 || ["starting", "running"].includes(run.run.state) && count > 0) return bad("approval_conflict");
      }
      for (const list of [s.usage, s.contexts]) {
        const runIds = new Set<string>();
        for (const row of list) {
          if (!bound(row) || runIds.has(row.runId)) return bad("entity_mismatch");
          if ("lastCompaction" in row && row.lastCompaction && !bound(row, row.lastCompaction.createdAt)) return bad("state_time_conflict");
          runIds.add(row.runId);
        }
      }
      return { valid: true };
    }
    function empty(cursor: Cursor): State {
      if (!contracts.validate("cursor", cursor).valid || cursor.sequence !== 0) throw new Error("invalid_cursor");
      return { snapshotVersion: 1, cursor: structuredClone(cursor), session: null, runs: [], approvals: [], messages: [], tools: [], usage: [], contexts: [], identities: [], identityFloor: 0, updatedAt: null };
    }
    async function applyBatch(prior: unknown, input: unknown): Promise<Result> {
      // Finish all synchronous reads and detach inputs BEFORE the first await.
      const before = checkState(prior), encoded = canonicalJSON(input, 16 * 1024 * 1024);
      if (!before.valid) return reset(before.code!);
      if (encoded === null || !contracts.checkReplayBatch(input).valid) return reset("invalid_payload");
      const next = structuredClone(prior as State), batch = JSON.parse(encoded) as StepsembleClient.ReplayBatch;
      const expectedCursor = structuredClone(next.cursor);
      if (batch.cursor.sessionId !== next.cursor.sessionId || batch.cursor.generation !== next.cursor.generation) return reset("cursor_mismatch");
      if (batch.afterCursor.sequence > next.cursor.sequence) return reset("sequence_gap");
      if (batch.events.length && batch.events[0].sequence <= next.identityFloor) return reset("replay_too_old");
      const eventIds = new Set(next.identities.map(row => row.eventId));
      const runs = new Map(next.runs.map(row => [row.run.runId, row])), approvals = new Map(next.approvals.map(row => [row.approval.approvalId, row]));
      const messages = new Map(next.messages.map(row => [row.messageId, row])), toolMap = new Map(next.tools.map(row => [row.toolId, row]));
      const usage = new Map(next.usage.map(row => [row.runId, row])), contexts = new Map(next.contexts.map(row => [row.runId, row]));
      const nonces = new Set(next.approvals.map(row => row.approval.nonce));
      const nativeIds = new Set(next.approvals.map(row => JSON.stringify([row.approval.runId, row.approval.nativeRequestId])));
      const byRun = new Map<string, Approval[]>();
      for (const row of next.approvals) { const list = byRun.get(row.approval.runId) ?? []; list.push(row); byRun.set(row.approval.runId, list); }
      let writer = next.runs.find(row => !terminal(row.run.state)) ?? null, added = 0;
      function take<T>(proposal: StepsembleLifecycle.Proposal<T>): T {
        if (proposal.kind === "reject") throw new Error(proposal.code);
        return proposal.state;
      }
      function eventApply(event: Event): void {
        const now = instant(event.createdAt);
        if (!Number.isFinite(now) || next.updatedAt !== null && now < instant(next.updatedAt)) throw new Error("state_time_conflict");
        const at = new Date(now).toISOString(), runId = event.runId;
        const run = runId === null ? null : runs.get(runId) ?? null;
        if (event.type !== "session.created" && next.session === null) throw new Error("session_conflict");
        if (runId !== null && event.type !== "run.starting" && run === null) throw new Error("entity_mismatch");
        const list = runId === null ? [] : byRun.get(runId) ?? [];
        const rc = () => ({ expectedRevision: run?.revision ?? null, session: next.session!, writer,
          unsettledApprovals: list.filter(unsettled), identityAvailable: !runs.has(runId!),
          approvalIdentityAvailable: event.type === "approval.requested" && !approvals.has(event.payload.approval.approvalId),
          approvalNonceAvailable: event.type === "approval.requested" && !nonces.has(event.payload.approval.nonce) });
        const live = (started = true): Run => {
          if (!run || terminal(run.run.state) || run.run.state === "orphaned" || started && run.startedAt === null) throw new Error("run_conflict");
          return run;
        };
        switch (event.type) {
          case "session.created": case "session.updated": case "session.archived": case "session.restored": case "model.changed":
            next.session = take(lifecycle.reduceSession(next.session, event, { expectedRevision: next.session?.revision ?? null, writer, profile: null })); break;
          case "run.starting": case "launch_profile.locked": case "run.started": case "run.stopping": case "run.orphaned": case "run.resumed": case "run.reconciled":
          case "run.completed": case "run.failed": case "run.interrupted": {
            const updated = take(lifecycle.reduceRun(run, event, rc())); runs.set(updated.run.runId, updated);
            writer = terminal(updated.run.state) ? null : updated;
            if (terminal(updated.run.state)) {
              // Preserve partial content; never invent a native final/cancellation.
              const cause = updated.run.state as "completed" | "failed" | "interrupted";
              for (const m of messages.values()) if (m.runId === runId && m.status === "streaming") { m.status = "incomplete"; m.terminalCause = cause; m.updatedAt = at; }
              for (const t of toolMap.values()) if (t.runId === runId && ["requested", "running"].includes(t.status)) { t.status = "incomplete"; t.terminalCause = cause; t.updatedAt = at; }
            }
            break;
          }
          case "approval.requested": case "approval.resolved": case "approval.expired": case "approval.cancelled": case "approval.acknowledged": {
            const id = event.type === "approval.requested" ? event.payload.approval.approvalId : event.payload.approvalId;
            const old = approvals.get(id) ?? null;
            if (event.type === "approval.requested") {
              const a = event.payload.approval, key = JSON.stringify([runId, a.nativeRequestId]);
              if (a.toolId !== null && toolMap.get(a.toolId)?.runId !== runId || nativeIds.has(key)) throw new Error("approval_conflict");
              const updated = take(lifecycle.reduceRun(run, event, rc())); runs.set(runId!, updated); writer = updated; nativeIds.add(key);
            }
            const row = take(lifecycle.reduceApproval(old, event, { expectedRevision: old?.revision ?? null, run: run!, identityAvailable: !old,
              nonceAvailable: event.type === "approval.requested" && !nonces.has(event.payload.approval.nonce) }));
            approvals.set(id, row); nonces.add(row.approval.nonce);
            const index = list.findIndex(a => a.approval.approvalId === id); if (index < 0) list.push(row); else list[index] = row;
            byRun.set(runId!, list); break;
          }
          case "message.delta": case "message.completed": {
            live(event.type === "message.delta" || event.payload.role === "assistant");
            const p = event.payload, old = messages.get(p.messageId), role = event.type === "message.delta" ? "assistant" : event.payload.role;
            if (old && (old.runId !== runId || old.status !== "streaming" || old.role !== role)) throw new Error("message_conflict");
            const m: Message = old ?? { messageId: p.messageId, runId: runId!, role, status: "streaming", text: "", thinking: "", createdAt: at, updatedAt: at, terminalCause: null };
            if (event.type === "message.completed") { m.text = event.payload.content; m.status = "completed"; }
            else { const key = event.payload.channel === "text" ? "text" : "thinking"; m[key] += event.payload.delta; if (points(m[key]) > 262144) throw new Error("projection_capacity"); }
            m.updatedAt = at; messages.set(m.messageId, m); break;
          }
          case "tool.requested": case "tool.started": case "tool.progress": case "tool.completed": case "tool.failed": {
            live(); const p = event.payload, old = toolMap.get(p.toolId);
            if (event.type === "tool.requested") {
              if (old) throw new Error("tool_conflict");
              toolMap.set(p.toolId, { toolId: p.toolId, runId: runId!, name: event.payload.name, summary: event.payload.summary,
                status: "requested", progress: "", output: null, error: null, createdAt: at, updatedAt: at, terminalCause: null }); break;
            }
            if (!old || old.runId !== runId || !["requested", "running"].includes(old.status)) throw new Error("tool_conflict");
            if (event.type !== "tool.failed" && list.some(a => a.approval.toolId === p.toolId && (a.approval.status !== "approved" || a.nativeAcknowledgement === null))) throw new Error("approval_conflict");
            if (event.type === "tool.started") { if (old.status !== "requested") throw new Error("tool_conflict"); old.status = "running"; }
            else if (event.type === "tool.failed") { old.status = "failed"; old.error = structuredClone(event.payload.error); }
            else {
              if (old.status !== "running") throw new Error("tool_conflict");
              if (event.type === "tool.completed") { old.status = "completed"; old.output = event.payload.output; }
              else { old.progress += event.payload.text; if (points(old.progress) > 262144) throw new Error("projection_capacity"); }
            }
            old.updatedAt = at; break;
          }
          case "usage.updated": {
            const old = usage.get(runId!);
            if (old && ["inputTokens", "outputTokens", "cachedTokens"].some(key => (event.payload[key] as number) < (old[key as keyof typeof old] as number))) throw new Error("usage_regression");
            usage.set(runId!, { runId: runId!, updatedAt: at, inputTokens: event.payload.inputTokens, outputTokens: event.payload.outputTokens, cachedTokens: event.payload.cachedTokens }); break;
          }
          case "context.updated": case "context.compacted": {
            const old = contexts.get(runId!);
            contexts.set(runId!, event.type === "context.updated" ? { runId: runId!, updatedAt: at, usedTokens: event.payload.usedTokens,
              limitTokens: event.payload.limitTokens, lastCompaction: old?.lastCompaction ?? null } : { runId: runId!, updatedAt: at, usedTokens: event.payload.afterTokens,
              limitTokens: old?.limitTokens ?? null, lastCompaction: { beforeTokens: event.payload.beforeTokens, afterTokens: event.payload.afterTokens, createdAt: at } }); break;
          }
          // Transport/Host frames are cursor-bearing facts, never evidence that a
          // run resumed/completed. Current connectivity is connection-local UI state.
          case "transport.connected": case "transport.degraded": case "transport.recovered": case "host.restarting": case "host.ready": break;
          default: { const exhaustive: never = event; void exhaustive; throw new Error("unsupported_event"); }
        }
        next.updatedAt = at;
      }
      try {
        for (const event of batch.events) {
          const digest = await hash("event", canonicalJSON(event)!);
          if (event.sequence <= expectedCursor.sequence) {
            const old = next.identities[event.sequence - next.identityFloor - 1];
            if (!old || old.eventId !== event.eventId || old.digest !== digest) return reset("event_conflict");
            continue;
          }
          if (eventIds.has(event.eventId)) return reset("event_conflict");
          eventApply(event); added++; eventIds.add(event.eventId);
          next.identities.push({ sequence: event.sequence, eventId: event.eventId, digest });
        }
      } catch (error) {
        // Never include native text, prompts, credentials or arbitrary exception messages.
        const allowed = ["invalid_payload", "invalid_context", "session_conflict", "run_conflict", "approval_conflict", "profile_mismatch", "writer_conflict", "entity_mismatch", "state_time_conflict", "revision_conflict", "revision_overflow", "fork_required", "message_conflict", "tool_conflict", "projection_capacity", "usage_regression", "unsupported_event"];
        return reset(error instanceof Error && allowed.includes(error.message) ? error.message : "projection_failed");
      }
      if (!added) return { kind: "duplicate", expectedCursor };
      next.cursor = structuredClone(batch.cursor);
      if (next.identities.length > WINDOW) next.identities.splice(0, next.identities.length - WINDOW);
      next.identityFloor = next.cursor.sequence - next.identities.length;
      next.runs = Array.from(runs.values()); next.approvals = Array.from(approvals.values()); next.messages = Array.from(messages.values());
      next.tools = Array.from(toolMap.values()); next.usage = Array.from(usage.values()); next.contexts = Array.from(contexts.values());
      const checked = checkState(next); return checked.valid ? { kind: "apply", expectedCursor, state: next } : reset(checked.code!);
    }
    async function sealSnapshot(input: unknown): Promise<StepsembleClient.ProjectionSnapshot | { kind: "reject"; code: string }> {
      const checked = checkState(input); if (!checked.valid) return { kind: "reject", code: checked.code! };
      const canonical = canonicalJSON(input)!;
      const state = JSON.parse(canonical) as State;
      try { return { digestVersion: "sha256-sorted-json-v1", digest: await hash("snapshot", canonical), state }; }
      catch { return { kind: "reject", code: "digest_unavailable" }; }
    }
    async function restoreSnapshot(current: unknown, input: unknown, context: RestoreContext): Promise<Result> {
      if (!checkState(current).valid || canonicalJSON(input, LIMIT + 1024) === null || !contracts.validate("projectionSnapshot", input).valid
        || !context || !contracts.validate("cursor", context.expectedCursor).valid || !contracts.validate("id", context.targetGeneration).valid) return reset("invalid_payload");
      const expectedCursor = structuredClone((current as State).cursor), snapshot = structuredClone(input as StepsembleClient.ProjectionSnapshot);
      if (!sameCursor(expectedCursor, context.expectedCursor)) return reset("stale_snapshot");
      const target = snapshot.state.cursor;
      if (target.sessionId !== expectedCursor.sessionId || target.generation !== context.targetGeneration
        || target.generation === expectedCursor.generation && target.sequence < expectedCursor.sequence) return reset("cursor_mismatch");
      const check = checkState(snapshot.state); if (!check.valid) return reset(check.code!);
      try { if (await hash("snapshot", canonicalJSON(snapshot.state)!) !== snapshot.digest) return reset("snapshot_corrupt"); }
      catch { return reset("digest_unavailable"); }
      return { kind: "apply", expectedCursor, state: snapshot.state };
    }
    /** A connection-local, in-memory publication fence. Not durable storage.
     * Every replacement increments a local revision, including same-cursor
     * repairs, so slow replay/snapshot responses cannot overwrite newer state. */
    function createReplica(initial: unknown) {
      if (!checkState(initial).valid) throw new Error("invalid_projection");
      let state = structuredClone(initial as State), revision = 0;
      function publish(result: Result, expected: number): Result {
        if (revision !== expected) return reset("stale_projection");
        if (result.kind === "apply") {
          if (revision === Number.MAX_SAFE_INTEGER) return reset("revision_overflow");
          state = structuredClone(result.state); revision++;
        }
        return result;
      }
      return Object.freeze({
        read: () => ({ localRevision: revision, state: structuredClone(state) }),
        snapshotRequest: (targetGeneration: string): SnapshotRequest => {
          if (!contracts.validate("id", targetGeneration).valid) throw new Error("invalid_generation");
          return { localRevision: revision, expectedCursor: structuredClone(state.cursor), targetGeneration };
        },
        apply: async (input: unknown): Promise<Result> => {
          const expected = revision; return publish(await applyBatch(state, input), expected);
        },
        restore: async (input: unknown, request: SnapshotRequest): Promise<Result> => {
          if (!request || request.localRevision !== revision) return reset("stale_snapshot");
          const expected = revision; return publish(await restoreSnapshot(state, input, request), expected);
        },
      });
    }
    return Object.freeze({ empty, checkState, applyBatch, sealSnapshot, restoreSnapshot, createReplica });
  }
}
if (typeof module !== "undefined") module.exports = StepsembleProjection;
