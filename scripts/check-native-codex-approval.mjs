#!/usr/bin/env node
// Owned real-native protocol oracle. The model endpoint is a local deterministic
// SSE fixture; no credentials or subscription model are used. Exercise an
// unanswered interrupt and a journal-backed denial; never accept the command.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { capture, verifyCapture, probeEnvironment } from "./check-native-codex-schema.mjs";
import { createCodexAppServerTransport } from "../server/codex-app-server-transport.js";
import { createCodexApprovalBridge } from "../server/codex-approval-bridge.js";
import { createSessionJournalClient } from "../server/session-journal-client.js";
const require = createRequire(import.meta.url);

// Explicit owned Host bootstrap, not a claim of native history import. The
// session/run mapping is bound to IDs just emitted by the real app-server.
async function ownedView(request) {
  const { createValidator } = require("../protocol/validator"), { createDomain } = require("../protocol/domain");
  const contracts = createValidator(require("../protocol/v1/schema.json")), domain = createDomain(contracts);
  const projection = require("../public/modules/projection").create({ ...contracts, ...domain }, require("../public/modules/lifecycle").create({ ...contracts, ...domain }));
  const wire = require("../protocol/v1/fixtures/wire.json"), { empty } = require("../protocol/v1/fixtures/projection.cjs");
  const types = ["session.created", "model.changed", "run.starting", "launch_profile.locked", "run.started"];
  const events = types.map((type, i) => {
    const event = { ...structuredClone(wire.find(row => row.contract === "event" && row.value.type === type).value),
      eventId: `owned-bootstrap-${i}`, sequence: i + 1, sessionId: empty.cursor.sessionId, generation: empty.cursor.generation };
    if (type === "session.created") event.payload.session.native = { ...event.payload.session.native, harnessId: "codex", nativeSessionId: request.threadId };
    if (type === "model.changed" || type === "launch_profile.locked") Object.assign(event.payload.launchProfile,
      { harnessId: "codex", authMode: "local", billingMode: "local", modelId: "mock-model" });
    if (type === "run.started") event.payload.nativeRunId = request.turnId;
    return event;
  });
  const result = await projection.applyBatch(empty, { afterCursor: empty.cursor, cursor: { ...empty.cursor, sequence: events.length }, events, hasMore: false });
  assert.equal(result.kind, "apply", result.reason);
  return require("../protocol/transaction-state").initialView(result.state, { storeId: "owned-store", storeGeneration: "owned-generation" }).state;
}

function deadline(promise, ms, label) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(label)), ms); })]).finally(() => clearTimeout(timer));
}
function sse(events) { return events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""); }

export async function checkNativeApproval(binary, { journalDenial = false } = {}) {
  assert(path.isAbsolute(binary), "absolute official native executable required");
  if (journalDenial && process.platform === "win32") return { result: "unsupported", scope: "owned_native_journal_denial", reason: "journal_owner_acl_not_implemented" };
  const metadata = await capture(binary); await verifyCapture(metadata);
  assert.equal(metadata.nativeVersion, "0.153.4");
  const home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "stepsemble-native-approval-owned-")));
  let child, transport, journal, bridge, journalSessionId, journalReceipt, childClosed, modelRequests = 0, terminal, resolved, requested, stderr = "";
  const events = [];
  let approvalReady, completedReady, resolvedReady;
  const approvalPromise = new Promise(resolve => { approvalReady = resolve; });
  const completedPromise = new Promise(resolve => { completedReady = resolve; });
  const resolvedPromise = new Promise(resolve => { resolvedReady = resolve; });
  const server = createServer((req, res) => {
    req.resume();
    if (req.method !== "POST" || req.url !== "/v1/responses") { res.writeHead(404); res.end(); return; }
    if (++modelRequests > (journalDenial ? 2 : 1)) { res.writeHead(503); res.end(); return; }
    if (modelRequests === 2) {
      const message = { type: "message", id: "msg-owned", role: "assistant", content: [{ type: "output_text", text: "Owned denied command finished.", annotations: [] }] };
      res.writeHead(200, { "Content-Type": "text/event-stream", Connection: "close" });
      res.end(sse([
        { type: "response.created", response: { id: "resp-owned-final" } },
        { type: "response.output_item.done", output_index: 0, item: message },
        { type: "response.completed", response: { id: "resp-owned-final", output: [], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
      ]));
      return;
    }
    const item = { type: "function_call", id: "fc-owned", call_id: "call-owned-approval", name: "exec_command",
      arguments: JSON.stringify({ cmd: "python3 -c 'open(\"owned-command-executed\",\"w\").write(\"unexpected\")'", workdir: home, yield_time_ms: 1000 }) };
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "close" });
    res.end(sse([
      { type: "response.created", response: { id: "resp-owned" } },
      { type: "response.output_item.done", output_index: 0, item },
      { type: "response.completed", response: { id: "resp-owned", output: [], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
    ]));
  });
  try {
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    const codex = path.join(home, "codex"); await fs.mkdir(codex, { mode: 0o700 });
    await fs.writeFile(path.join(codex, "config.toml"), `model = "mock-model"
model_provider = "owned_fixture"
approval_policy = "on-request"
approvals_reviewer = "user"
sandbox_mode = "read-only"
[model_providers.owned_fixture]
name = "Owned local fixture"
base_url = "http://127.0.0.1:${server.address().port}/v1"
wire_api = "responses"
requires_openai_auth = false
request_max_retries = 0
stream_max_retries = 0
`, { flag: "wx", mode: 0o600 });
    child = spawn(await fs.realpath(binary), ["app-server", "--listen", "stdio://"], { cwd: home, env: probeEnvironment(home), shell: false, stdio: ["pipe", "pipe", "pipe"] });
    childClosed = new Promise(resolve => child.once("close", resolve));
    child.stderr.on("data", chunk => { stderr = (stderr + chunk.toString()).slice(-4096); });
    transport = createCodexAppServerTransport({ child, nativeVersion: metadata.nativeVersion, trustedNative: true, requestTimeoutMs: 10000,
      // This is an owned oracle permission, not a production journal proof.
      // Lifecycle is owned fixture permission. An approval decision, when
      // exercised, must use the actual journal-backed bridge below.
      authorizeNative: async (operation, context) => operation === "approval.resolve" && bridge ? bridge.authorizeNative(operation, context)
        : ["thread.start", "turn.start", "turn.interrupt"].includes(operation)
        ? { kind: "committed", receiptId: `owned-${operation}`, attemptId: `owned-attempt-${operation}`, incarnationId: "owned-native" }
        : { kind: "reject", code: "owned_action_forbidden" },
      onApprovalRequest: request => { requested = request; approvalReady(request); },
      onEvent: event => {
        bridge?.onEvent(event);
        if (events.length < 128) events.push(event.type);
        if (event.type === "approval.resolved" || event.type === "approval.closed") { resolved = event; resolvedReady(event); }
        if (event.type === "turn.interrupted" || event.type === "turn.completed") { terminal = event; completedReady(event); }
      },
    });
    assert.equal((await transport.initialize()).kind, "ready");
    assert.equal((await transport.startThread({ model: "mock-model", cwd: home, approvalPolicy: "untrusted", sandbox: "read-only" })).kind, "started");
    assert.equal((await transport.startTurn([{ type: "text", text: "Owned fixture: request the test command; the client will interrupt before approving.", text_elements: [] }], { approvalPolicy: "untrusted" })).kind, "started");
    await deadline(approvalPromise, 12000, "native_approval_not_observed");
    assert.equal(requested.method, "item/commandExecution/requestApproval");
    assert.equal(requested.itemId, "call-owned-approval");
    assert.equal(requested.authority.approvalAcknowledged, false);
    if (journalDenial) {
      const initial = await ownedView(requested);
      journalSessionId = initial.projection.cursor.sessionId;
      journal = createSessionJournalClient({ filename: path.join(home, "journal.sqlite") });
      assert.equal((await journal.create(initial)).kind, "created");
      assert.equal((await journal.setGrant(journalSessionId, "device-1", true)).kind, "grant_updated");
      bridge = createCodexApprovalBridge({ journal, sessionId: journalSessionId, runId: initial.projection.runs[0].run.runId,
        deviceId: "device-1", threadId: requested.threadId, turnId: requested.turnId, incarnationId: "owned-native" });
      bridge.attach(transport);
      assert.equal((await bridge.observe(requested)).kind, "observed");
      const decision = await bridge.resolve(requested.requestId, { decision: "denied", scope: "once" });
      assert.equal(decision.kind, "written", JSON.stringify(decision));
      assert.equal(decision.pipe.kind, "committed");
      journalReceipt = decision.pipe.state.receipts[0].receiptId;
    } else assert.equal((await transport.interruptTurn()).kind, "requested");
    await deadline(Promise.all([resolvedPromise, completedPromise]), 10000, "native_interrupt_not_observed");
    assert.equal(resolved.authority.approvalAcknowledged, false, "request closed by interrupt is not approval ACK");
    assert.equal(terminal.status, journalDenial ? "completed" : "interrupted");
    assert.equal(modelRequests, journalDenial ? 2 : 1);
    assert.equal(events.includes("approval.response_written"), journalDenial);
    await assert.rejects(fs.stat(path.join(home, "owned-command-executed")), { code: "ENOENT" });
    if (journalDenial) {
      const view = await journal.read(journalSessionId);
      assert.equal(view.state.receipts.find(row => row.receiptId === journalReceipt).state, "awaiting_confirmation");
      assert.equal(view.state.projection.approvals[0].approval.status, "denied");
      await journal.close();
      journal = createSessionJournalClient({ filename: path.join(home, "journal.sqlite") });
      assert.equal((await journal.read(journalSessionId)).state.receipts[0].state, "awaiting_confirmation");
      assert.equal(events.filter(type => type === "approval.response_written").length, 1);
    }
    await transport.close();
    await deadline(childClosed, 5000, "native_cleanup_timeout");
    return { result: "passed", nativeVersion: metadata.nativeVersion, scope: journalDenial ? "owned_native_journal_denial" : "owned_native_approval_interrupted_before_answer",
      modelRequests, realModelRequests: 0, approvalMethod: requested.method, requestResolvedWithoutApprovalAck: true,
      terminalStatus: terminal.status, commandExecuted: false, journalReopenVerified: journalDenial, remainingChildren: 0, cleanupConfirmed: true };
  } catch (error) {
    // Owned fixture diagnostics contain no user's configuration or credentials.
    error.message += `; transport=${JSON.stringify(transport?.state())}; events=${JSON.stringify(events)}; ownedStderr=${stderr}`;
    throw error;
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    try {
      if (childClosed) await deadline(childClosed, 5000, "native_child_not_reaped");
    } finally {
      bridge?.close();
      await journal?.close();
      server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
      await fs.rm(home, { recursive: true, force: true });
    }
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [binary, ...extra] = process.argv.slice(2);
  assert(binary && extra.length === 0, "Usage: check-native-codex-approval.mjs /absolute/official/native/codex");
  console.log(JSON.stringify(await checkNativeApproval(binary)));
  console.log(JSON.stringify(await checkNativeApproval(binary, { journalDenial: true })));
}
