"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const vm = require("node:vm");
const { spawn } = require("node:child_process");
const { createLineDecoder } = require("../server/stream-safety");
const { parsePiEvent, validPiCommand, resolvePiResponse, parsePiUiReply } = require("../server/pi-rpc-contract");
const { createPiUiState } = require("../server/pi-ui-state");
const golden = require("../protocol/native/pi/0.84.2.json");
const root = path.resolve(__dirname, "..");

test("captured native Pi frames survive byte fragmentation and Unicode line separators", () => {
  const expected = golden.frames.filter(frame => frame.direction === "out").map(frame => frame.message);
  const bytes = Buffer.from(expected.map(value => JSON.stringify(value)).join("\r\n") + "\r\n");
  for (const size of [1, 2, 3, 7, bytes.length]) {
    const received = [];
    const decoder = createLineDecoder({ onLine: line => received.push(parsePiEvent(line)), onError: error => { throw error; } });
    for (let start = 0; start < bytes.length; start += size) decoder.push(bytes.subarray(start, start + size));
    decoder.end(); assert.deepEqual(received, expected);
  }
  for (const frame of golden.frames.filter(frame => frame.direction === "in")) {
    const { message } = frame;
    if (message.type === "extension_ui_response") assert.deepEqual(parsePiUiReply({ sid: "fixture", ...message }), message);
    else assert.equal(validPiCommand(message), true);
  }
});
test("native UI replies never coerce false strings, accept mixed answers or bypass their endpoint", () => {
  const body = { sid: "session-1", id: "request-1" };
  for (const reply of [{ confirmed: true }, { confirmed: false }, { cancelled: true }, { value: "貓掌🐾\ntext" }, { value: "" }]) assert.deepEqual(parsePiUiReply({ ...body, ...reply }), { type: "extension_ui_response", id: body.id, ...reply });
  for (const reply of [null, [], body, { ...body, confirmed: "false" }, { ...body, confirmed: 1 }, { ...body, cancelled: "false" }, { ...body, cancelled: false }, { ...body, value: {} }, { ...body, value: "x", confirmed: false }, { ...body, cancelled: true, confirmed: true }, { ...body, id: "request-1\n", confirmed: true }, { ...body, value: "x".repeat(1024 * 1024 + 1) }]) {
    assert.throws(() => parsePiUiReply(reply), error => error.statusCode === 400 && error.message === "Invalid native UI reply");
  }
  assert.equal(validPiCommand({ type: "extension_ui_response", id: "request-1", confirmed: "false" }), false);
});
test("malformed native output fails closed without reflecting its payload", () => {
  for (const value of ["not-json", "null", "[]", '"secret-value"', '{}', '{"type":null}', '{"type":"response","command":"prompt","success":"false"}', '{"type":"response","command":"prompt","success":false}', '{"type":"response","command":"get_state","success":true,"data":null}']) {
    assert.throws(() => parsePiEvent(value), error => error.statusCode === 502 && error.message === "Invalid native RPC frame");
  }
  assert.equal(parsePiEvent('{"type":"future_native_event","optional":true}').type, "future_native_event");
});
test("pending native dialogs restore once, expire safely, and have a single in-process winner", () => {
  let now = 1000;
  const closed = [], written = [];
  const state = createPiUiState({ now: () => now, onClose: (...args) => closed.push(args) });
  const request = { type: "extension_ui_request", id: "request-1", method: "confirm", timeout: 10000 };
  state.observe(request); state.observe(request); assert.equal(state.size, 1);
  const snapshot = state.snapshot(); snapshot[0].method = "modified";
  assert.equal(state.snapshot()[0].method, "confirm", "snapshots cannot mutate pending state");
  assert.throws(() => state.submit({ id: request.id, confirmed: "false" }, () => true), /Invalid native UI reply/);
  assert.throws(() => state.submit({ id: request.id, value: "false" }, () => true), /does not match/);
  assert.throws(() => state.submit({ id: request.id, confirmed: false }, () => false), /unavailable/);
  assert.equal(state.size, 1, "failed enqueue leaves the request pending");
  state.submit({ id: request.id, confirmed: false }, value => { written.push(value); return true; });
  assert.equal(written[0].confirmed, false); assert.equal(state.size, 0);
  assert.throws(() => state.submit({ id: request.id, confirmed: true }, () => { throw new Error("must not dispatch"); }), /no longer pending/);
  assert.equal(closed.length, 1); assert.equal(closed[0][0].reason, "answered");
  state.observe({ ...request, id: "expired" }); now = 11000;
  assert.deepEqual(state.snapshot(), []); assert.equal(closed[1][0].reason, "expired"); assert.equal(closed[1][1], true);
  assert.throws(() => state.submit({ id: "expired", confirmed: true }, () => true), /no longer pending/);
  state.observe({ type: "extension_ui_request", id: "choose", method: "select", options: ["one", "two"] });
  assert.throws(() => state.submit({ id: "choose", value: "three" }, () => true), /offered/);
  state.clear(); assert.equal(state.size, 0); assert.equal(closed.at(-1)[0].reason, "process_closed");
});
test("native dialog state is bounded and idle/update gates preserve a pending dialog", async () => {
  const state = createPiUiState({ maxRequests: 1 });
  state.observe({ type: "extension_ui_request", id: "one", method: "input" });
  assert.throws(() => state.observe({ type: "extension_ui_request", id: "two", method: "input" }), /limit reached/);
  assert.throws(() => state.observe({ type: "extension_ui_request", id: "one", method: "confirm" }), /Conflicting/);
  state.clear();
  assert.throws(() => state.observe({ type: "extension_ui_request", id: "big", method: "input", prefill: "x".repeat(65536) }), /limit reached/);
  const source = (await fs.readFile(path.join(root, "server.js"), "utf8")).replace(/\r\n/g, "\n");
  const session = { exited: false, state: { isStreaming: false }, clients: new Set(), ui: { size: 1 }, meta: { lastActivityAt: 1 } };
  const context = vm.createContext({ rpcSessions: new Map([["a", session]]), STUCK_RPC_MS: 60000, shutdownState: null, setTimeout: () => { throw new Error("must not expire a pending dialog"); } });
  for (const name of ["activeRpcSessions", "scheduleRpcCleanup", "rpcStuck", "activeRpcSessionsForUpdate"]) {
    const start = source.indexOf(`function ${name}(`), end = source.indexOf("\n}\n", start) + 2;
    vm.runInContext(source.slice(start, end), context);
  }
  assert.equal(context.activeRpcSessions().length, 1); context.scheduleRpcCleanup("a");
  session.state.isStreaming = true;
  assert.equal(context.rpcStuck(session), false); assert.equal(context.activeRpcSessionsForUpdate().length, 1);
  session.ui.size = 0;
  assert.equal(context.rpcStuck(session), true); assert.equal(context.activeRpcSessionsForUpdate().length, 0);
});
test("RPC signal cleanup does not kill an already signal-exited process group", async () => {
  const source = (await fs.readFile(path.join(root, "server.js"), "utf8")).replace(/\r\n/g, "\n");
  const start = source.indexOf("function killRpcProcess("), end = source.indexOf("\n}\n", start) + 2;
  const kills = [], timers = [];
  const context = vm.createContext({ process: { kill: (...args) => kills.push(args) }, setTimeout: fn => { timers.push(fn); return { unref() {} }; } });
  vm.runInContext(source.slice(start, end), context);
  const proc = { pid: 123, exitCode: null, signalCode: null, kill: signal => kills.push(signal) };
  context.killRpcProcess(proc); assert.equal(kills.length, 2);
  proc.signalCode = "SIGTERM";
  timers[0](); context.killRpcProcess(proc);
  assert.equal(kills.length, 2, "signalCode is terminal even when exitCode remains null");
});
test("RPC correlation binds process, generated request ID and command type", async () => {
  const resolved = [], rejected = [];
  const pending = new Map([["cmd-1", { sid: "a", command: "get_state", resolve: v => resolved.push(v), reject: e => rejected.push(e) }]]);
  const response = { type: "response", id: "cmd-1", command: "get_state", success: true };
  assert.equal(resolvePiResponse(pending, "b", response), false); assert.equal(pending.size, 1);
  assert.equal(resolvePiResponse(pending, "a", { ...response, command: "abort" }), true);
  assert.equal(rejected[0].statusCode, 502); assert.equal(resolved.length, 0);
  assert.equal(resolvePiResponse(pending, "a", response), false);
  const source = (await fs.readFile(path.join(root, "server.js"), "utf8")).replace(/\r\n/g, "\n");
  const start = source.indexOf("function rpcCommand(");
  const end = source.indexOf("\n}\n", start) + 2;
  const sent = [];
  const context = vm.createContext({ validPiCommand, pendingRpcCmds: new Map(), rpcReqSeq: 0, rpcSessions: new Map([["a", {}]]), setTimeout: () => 1, clearTimeout: () => {}, rpcWrite: (sid, command) => { sent.push(command); return true; } });
  vm.runInContext(source.slice(start, end), context);
  const result = context.rpcCommand("a", { type: "get_state", id: "client-controlled" });
  assert.equal(sent[0].id, "cmd-1");
  resolvePiResponse(context.pendingRpcCmds, "a", response); assert.equal((await result).id, "cmd-1");
  for (let i = 0; i < 64; i++) context.pendingRpcCmds.set(`hold-${i}`, { sid: "a" });
  await assert.rejects(context.rpcCommand("a", { type: "get_state" }), /too many pending/);
});

test("isolated HTTP native boundary preserves responses, reconnect replay, and approval false", async t => {
  // Windows exercises an actual batch shim and child pipes, not a native
  // provider/model call. The frozen peer is synthetic on every platform.
  const { freePort, waitForServer, stopServer } = await import("../scripts/host-performance-baseline.mjs");
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "stepsemble-pi-contract-"));
  const script = path.join(home, process.platform === "win32" ? "pi-peer.cjs" : "pi");
  const peer = process.platform === "win32" ? path.join(home, "pi.cmd") : script;
  await fs.copyFile(path.join(root, "test-support/pi-contract-peer.cjs"), script); await fs.chmod(script, 0o700);
  if (process.platform === "win32") await fs.writeFile(peer, `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`);
  const port = await freePort();
  const child = spawn(process.execPath, [path.join(root, "server.js")], { cwd: home, env: { PATH: path.dirname(process.execPath), ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}), PI_HOME: home, PI_BIN: peer, STEPSEMBLE_HOST: "127.0.0.1", STEPSEMBLE_PORT: String(port), STEPSEMBLE_ORPHAN_EXIT: "0", STEPSEMBLE_TEST_PI_FIXTURE: path.join(root, "protocol/native/pi/0.84.2.json") }, stdio: ["ignore", "pipe", "pipe"] });
  const streams = [], owned = [];
  let post;
  t.after(async () => {
    for (const stream of streams) await stream.reader.cancel().catch(() => {});
    for (const item of owned) await post?.("/api/close", { sid: item.sid }).catch(() => {});
    for (let i = 0; i < 60 && owned.some(item => { try { process.kill(item.pid, 0); return true; } catch { return false; } }); i++) await new Promise(resolve => setTimeout(resolve, 50));
    await stopServer(child);
    assert.ok(child.exitCode !== null || child.signalCode !== null, "owned HTTP host must exit before temporary files are removed");
    for (const item of owned) assert.throws(() => process.kill(item.pid, 0), "owned Pi peer must exit before temporary files are removed");
    // Windows may briefly retain a cwd handle after the owned processes exit.
    // Retry only this fixture's directory cleanup, never the test or peer work.
    await fs.rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });
  await waitForServer(child); child.stdout.resume(); child.stderr.resume();
  const base = `http://127.0.0.1:${port}`;
  const token = (await fs.readFile(path.join(home, ".config/stepsemble/token"), "utf8")).trim();
  const login = await fetch(base + "/api/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token }) });
  const cookie = login.headers.get("set-cookie").split(";", 1)[0];
  post = (url, body) => fetch(base + url, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(5000) });
  assert.equal((await (await fetch(base + "/api/version", { headers: { cookie } })).json()).version, "synthetic-pi-contract-0.84.2");
  assert.deepEqual((await (await fetch(base + "/api/models", { headers: { cookie } })).json()).models, []);
  const a = await (await post("/api/open", { cwd: home, name: "Synthetic name with spaces" })).json();
  const b = await (await post("/api/open", { cwd: home })).json();
  const rpc = (sid, command) => post("/api/rpc-cmd", { sid, command });
  for (const item of [a, b]) {
    const launched = await (await rpc(item.sid, { type: "fixture_args" })).json();
    owned.push({ sid: item.sid, pid: launched.data.pid });
    assert.ok(launched.data.args.includes("--mode"));
    if (item === a) assert.deepEqual(launched.data.args, ["--mode", "rpc", "--name", "Synthetic name with spaces"]);
  }
  const state = await (await rpc(a.sid, { type: "get_state", id: "client-controlled" })).json();
  assert.equal(state.success, true); assert.notEqual(state.id, "client-controlled");
  async function stream(after, lastId, uiSnapshot = false) {
    const response = await fetch(base + `/api/stream?sid=${a.sid}&after=${after}${uiSnapshot ? "&uiSnapshot=1" : ""}`, { headers: { cookie, ...(lastId ? { "last-event-id": String(lastId) } : {}) }, signal: AbortSignal.timeout(10000) });
    assert.equal(response.status, 200);
    const value = { reader: response.body.getReader(), buffer: "", decoder: new TextDecoder() }; streams.push(value); return value;
  }
  async function next(stream, predicate) {
    for (;;) {
      let end;
      while ((end = stream.buffer.indexOf("\n\n")) >= 0) {
        const packet = stream.buffer.slice(0, end); stream.buffer = stream.buffer.slice(end + 2);
        const data = packet.split("\n").filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n");
        if (!data) continue;
        const value = JSON.parse(data), id = Number(packet.match(/^id:\s*(\d+)$/m)?.[1]);
        if (predicate(value)) return { value, id };
      }
      const read = await stream.reader.read(); assert.equal(read.done, false); stream.buffer += stream.decoder.decode(read.value, { stream: true });
    }
  }
  const first = await stream(0); assert.equal((await next(first, value => value.type === "connected")).value.nativeUiSnapshot, undefined, "legacy clients keep the original replay path");
  await rpc(a.sid, { type: "prompt", message: "/stepsemble-probe record" });
  const ended = await next(first, value => value.type === "message_end");
  assert.equal(ended.value.message.content, "貓掌🐾\u2028line\u2029end");
  await first.reader.cancel();
  // Last-Event-ID beats an older query cursor. No already-applied message replays.
  const second = await stream(0, ended.id); await next(second, value => value.type === "connected");
  const response = await next(second, () => true); assert.equal(response.value.type, "response"); assert.ok(response.id > ended.id);
  const waiting = rpc(a.sid, { type: "prompt", message: "/stepsemble-probe confirm" });
  const dialog = await next(second, value => value.type === "extension_ui_request" && value.method === "confirm");
  await second.reader.cancel();
  assert.equal((await (await post("/api/close", { sid: a.sid })).json()).closed, false, "leaving a view cannot kill a pending native dialog");
  const third = await stream(dialog.id); await next(third, value => value.type === "connected");
  const restored = await next(third, value => value.method === "confirm");
  assert.equal(restored.value.id, dialog.value.id); assert.equal(Number.isNaN(restored.id), true, "snapshot must not advance event cursor");
  assert.equal((await post("/api/rpc-ui", { sid: a.sid, id: "native-id-1", confirmed: "false" })).status, 400);
  assert.equal((await rpc(a.sid, { type: "extension_ui_response", id: "native-id-1", confirmed: "false" })).status, 409);
  assert.equal((await (await rpc(a.sid, { type: "fixture_counts" })).json()).data.uiReplies, 0);
  assert.equal((await post("/api/rpc-ui", { sid: a.sid, id: "native-id-1", confirmed: false })).status, 200);
  const closedDialog = await next(third, value => value.type === "extension_ui_closed"); assert.equal(closedDialog.value.reason, "answered");
  const notification = await next(third, value => value.method === "notify"); assert.equal(JSON.parse(notification.value.message).result, false);
  assert.equal((await waiting).status, 200);
  assert.equal((await post("/api/rpc-ui", { sid: a.sid, id: "native-id-1", confirmed: true })).status, 409);
  assert.equal((await (await rpc(a.sid, { type: "fixture_counts" })).json()).data.uiReplies, 1);
  await third.reader.cancel();
  const fourth = await stream(0); await next(fourth, value => value.type === "connected");
  const beforeClosed = [];
  await next(fourth, value => { beforeClosed.push(value); return value.type === "extension_ui_closed"; });
  assert.equal(beforeClosed.some(value => value.method === "confirm"), false, "answered historical dialogs must not reopen");
  await fourth.reader.cancel();
  await rpc(a.sid, { type: "fixture_dialogs" });
  const full = await stream(0, null, true);
  const boundary = await next(full, value => value.type === "connected");
  assert.equal(Number.isNaN(boundary.id), true, "full snapshot cannot advance SSE cursor");
  assert.equal(boundary.value.nativeUiSnapshot.version, 1); assert.equal(boundary.value.nativeUiSnapshot.sid, a.sid);
  assert.deepEqual(boundary.value.nativeUiSnapshot.requests.map(item => item.id), ["batch-input", "batch-confirm"]);
  const marker = await (await rpc(a.sid, { type: "fixture_counts" })).json();
  const replay = [];
  await next(full, value => { replay.push(value); return value.id === marker.id; });
  assert.equal(replay.some(value => value.type === "extension_ui_closed" || ["confirm", "input", "editor", "select"].includes(value.method)), false, "historical lifecycle events cannot undo the full snapshot");
  await full.reader.cancel();
  // This client misses the answer and then the entire replay range. Only the
  // still-pending confirm belongs in its next full snapshot.
  assert.equal((await post("/api/rpc-ui", { sid: a.sid, id: "batch-input", value: "accepted elsewhere" })).status, 200);
  assert.equal((await rpc(a.sid, { type: "fixture_rollover" })).status, 200);
  const recovered = await stream(boundary.value.eventSeq, null, true);
  const recoveredBoundary = await next(recovered, value => value.type === "connected");
  assert.deepEqual(recoveredBoundary.value.nativeUiSnapshot.requests.map(item => item.id), ["batch-confirm"]);
  const earliest = await next(recovered, () => true);
  assert.equal(earliest.value.type, "fixture_noise"); assert.ok(earliest.id > boundary.value.eventSeq + 1, "the old close really fell out of the ring");
  // New live closes still arrive after the boundary (only historical UI is skipped).
  assert.equal((await post("/api/rpc-ui", { sid: a.sid, id: "batch-confirm", confirmed: false })).status, 200);
  assert.equal((await next(recovered, value => value.type === "extension_ui_closed")).value.id, "batch-confirm");
  await recovered.reader.cancel();
  const empty = await stream(Number.MAX_SAFE_INTEGER, null, true);
  assert.deepEqual((await next(empty, value => value.type === "connected")).value.nativeUiSnapshot.requests, [], "empty state is explicit even past the newest cursor");
  await empty.reader.cancel();
  // A reused native ID must not be removed by its earlier historical close.
  await rpc(a.sid, { type: "fixture_dialogs" });
  const reused = await stream(0, null, true);
  assert.deepEqual((await next(reused, value => value.type === "connected")).value.nativeUiSnapshot.requests.map(item => item.id), ["batch-input", "batch-confirm"]);
  const reusedMarker = await (await rpc(a.sid, { type: "fixture_counts" })).json(), reusedReplay = [];
  await next(reused, value => { reusedReplay.push(value); return value.id === reusedMarker.id; });
  assert.equal(reusedReplay.some(value => value.type === "extension_ui_closed"), false);
  for (const id of ["batch-input", "batch-confirm"]) assert.equal((await post("/api/rpc-ui", { sid: a.sid, id, cancelled: true })).status, 200);
  await reused.reader.cancel();
  const held = rpc(a.sid, { type: "fixture_hold" });
  const counts = await (await rpc(a.sid, { type: "fixture_counts" })).json();
  await rpc(b.sid, { type: "fixture_spoof", spoofId: counts.data.heldId });
  await rpc(a.sid, { type: "fixture_release" });
  assert.equal((await (await held).json()).data.source, "own-session");
  assert.equal((await rpc(a.sid, { type: "fixture_mismatch" })).status, 502);
  assert.equal((await rpc(a.sid, { type: "fixture_malformed" })).status, 502);
  assert.equal((await fetch(base + "/api/health")).status, 200);
  assert.equal((await rpc(b.sid, { type: "get_state" })).status, 200);
});
