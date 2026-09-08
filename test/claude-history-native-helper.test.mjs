import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { spawn } from "node:child_process";
import helper from "../protocol/native/claude/history-native-helper.js";

const { createNativeHelper, LIMITS, SOURCE_CODES } = helper;
const sessionId = "11111111-1111-4111-8111-111111111111";
const source = { projectsRoot: path.resolve("owned-fixture-root"), projectKey: "-owned-fixture", sessionId };
const input = () => ({ source: { ...source }, expectedRoot: { device: "1", inode: "2" } });
const payload = Buffer.from('{"fixture":"owned synthetic bytes only"}\n');
const trust = { executablePath: process.execPath, trustBoundary: "host_managed_executable" };
const unavailable = code => ({ kind: "source_unavailable", code });
const tick = () => new Promise(resolve => setImmediate(resolve));
function result(bytes = payload) {
  return { kind: "native_source_bytes", sessionId, byteLength: bytes.length, sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
    identity: { device: "1", inode: "3", size: bytes.length, mtimeNs: "4", ctimeNs: "5" },
    checks: { owner: "posix_euid_and_mode", acl: "no_extended_acl", containment: "root_identity_and_openat_nofollow", reads: 2,
      matchingBytes: true, unchangedObservedIdentity: true }, sourceAuthenticated: false, publishable: false };
}
function frame(job, value = result(), bytes = payload, modifyHeader = value => value) {
  const header = Buffer.from(JSON.stringify(modifyHeader({ protocolVersion: 1, nonce: job.nonce, result: value })));
  const length = Buffer.alloc(4); length.writeUInt32BE(header.length);
  return Buffer.concat([length, header, bytes]);
}
function harness({ holdClose = false, killThrows = false, onSpawn, ...options } = {}) {
  const children = [], launches = [];
  const api = createNativeHelper({ ...trust, platform: "linux", deadlineMs: 200, cleanupMs: 30, ...options,
    spawnChild(executable, args, launch) {
      launches.push({ executable, args, launch });
      const child = new EventEmitter(); child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
      child.kills = []; child.kill = signal => {
        child.kills.push(signal); if (killThrows) throw new Error("synthetic kill exception");
        if (!holdClose) child.emit("close", null, "SIGKILL"); return true;
      };
      const chunks = []; child.stdin.on("data", chunk => chunks.push(chunk)); child.job = () => JSON.parse(Buffer.concat(chunks));
      child.bytes = bytes => child.stdout.write(bytes);
      child.finish = (bytes = frame(child.job())) => { child.bytes(bytes); child.emit("close", 0, null); };
      children.push(child); onSpawn?.(child); return child;
    } });
  return { api, children, launches };
}

test("trusted executable boundary and exact options reject caller args/env/source overrides", () => {
  for (const override of [{ trustBoundary: undefined }, { trustBoundary: "hash_proves_no_path_swap" }, { executablePath: "relative/helper" },
    { executablePath: path.parse(process.execPath).root }, { executablePath: process.execPath + "\n" }, { args: ["--source=/private"] },
    { env: { HOME: "/private" } }, { shell: true }, { deadlineMs: 10001 }, { cleanupMs: 1001 }])
    assert.throws(() => createNativeHelper({ ...trust, ...override }), /invalid_native_helper_options/);
  let invoked = 0; const accessor = { ...trust }; Object.defineProperty(accessor, "deadlineMs", { enumerable: true, get() { invoked++; return 1; } });
  assert.throws(() => createNativeHelper(accessor), /invalid_native_helper_options/); assert.equal(invoked, 0);
  assert.throws(() => createNativeHelper(Object.create(trust)), /invalid_native_helper_options/);
});

test("root identity accepts canonical u64 boundaries including zero device but never zero inode", async () => {
  for (const device of ["0", "18446744073709551615"]) {
    const h = harness(), request = input(); request.expectedRoot = { device, inode: "18446744073709551615" };
    const pending = h.api.read(request), child = h.children[0], reply = result(); reply.identity.device = device;
    assert.deepEqual(child.job().expectedRoot, request.expectedRoot); child.finish(frame(child.job(), reply));
    assert.equal((await pending).kind, "native_source_bytes"); await h.api.shutdown();
  }
});

test("request carries detached trusted root identity and a fresh nonce through bounded stdin with no inherited environment", async () => {
  const h = harness(), value = input(), pending = h.api.read(value), child = h.children[0];
  value.expectedRoot.inode = "999"; value.source.projectKey = "caller-mutated";
  const job = child.job(); assert.deepEqual(Object.keys(job).sort(), ["expectedRoot", "nonce", "protocolVersion", "source"]);
  assert.equal(job.protocolVersion, 1); assert.match(job.nonce, /^[a-f0-9]{64}$/); assert.deepEqual(job.expectedRoot, { device: "1", inode: "2" });
  assert.equal(job.source.projectKey, source.projectKey); assert.ok(Buffer.byteLength(JSON.stringify(job)) + 1 <= LIMITS.inputBytes);
  assert.equal(h.launches[0].executable, process.execPath); assert.deepEqual(h.launches[0].args, []);
  assert.deepEqual(h.launches[0].launch.env, { LANG: "C", LC_ALL: "C" }); assert.equal(h.launches[0].launch.shell, false);
  assert.equal(h.launches[0].launch.detached, false); assert.equal(h.launches[0].launch.cwd, path.dirname(process.execPath));
  child.finish(); const reply = await pending;
  assert.deepEqual(reply.bytes, payload); assert.equal(reply.cleanupConfirmed, true); assert.equal(reply.sourceAuthenticated, false); assert.equal(reply.publishable, false);
  assert.deepEqual(reply.checks, result().checks); assert.equal(child.kills.length, 0);
  const next = h.api.read(input()); assert.notEqual(h.children[1].job().nonce, job.nonce); h.children[1].finish(); await next;
  await h.api.shutdown();
});

test("source, expected root and signal shapes fail closed without invoking getters or spawning", async () => {
  const h = harness(); let invoked = 0;
  const getter = input(); Object.defineProperty(getter.expectedRoot, "inode", { enumerable: true, get() { invoked++; return "2"; } });
  for (const candidate of [null, {}, { ...input(), sdkPath: "/private/sdk" }, { ...input(), args: [] }, getter,
    { ...input(), source: { ...source, file: "private" } }, { ...input(), source: { ...source, projectKey: "../escape" } },
    { ...input(), source: { ...source, projectsRoot: path.parse(source.projectsRoot).root } },
    { ...input(), expectedRoot: { device: "1", inode: "000" } }, { ...input(), expectedRoot: { device: "1", inode: "2", extra: true } },
    { ...input(), expectedRoot: { device: "-1", inode: "2" } }, { ...input(), expectedRoot: { device: "1", inode: "1".repeat(21) } },
    { ...input(), expectedRoot: { device: "01", inode: "2" } }, { ...input(), expectedRoot: { device: "1", inode: "02" } },
    { ...input(), expectedRoot: { device: "18446744073709551616", inode: "2" } },
    { ...input(), expectedRoot: { device: "1", inode: "18446744073709551616" } },
    ...["/.", "//", "/"].map(suffix => ({ ...input(), source: { ...source, projectsRoot: source.projectsRoot + suffix } })),
    { ...input(), source: { ...source, projectsRoot: source.projectsRoot + "x".repeat(LIMITS.inputBytes) } }])
    assert.deepEqual(await h.api.read(candidate), unavailable("invalid_source_input"));
  const options = {}; Object.defineProperty(options, "signal", { enumerable: true, get() { invoked++; return undefined; } });
  for (const candidate of [options, { signal: {} }, { signal: new AbortController().signal, env: {} }])
    assert.deepEqual(await h.api.read(input(), candidate), unavailable("invalid_source_signal"));
  assert.equal(invoked, 0); assert.equal(h.children.length, 0); await h.api.shutdown();
});

test("Windows gate is explicitly unsupported and a pre-aborted read never spawns", async () => {
  const windows = harness({ platform: "win32" }); assert.deepEqual(await windows.api.read(input()), unavailable("source_platform_unsupported"));
  assert.equal(windows.children.length, 0); await windows.api.shutdown();
  const h = harness(), abort = new AbortController(); abort.abort("secret reason");
  assert.deepEqual(await h.api.read(input(), { signal: abort.signal }), unavailable("source_aborted")); assert.equal(h.children.length, 0); await h.api.shutdown();
});

test("single flight has no queue and only actual close frees its slot or publishes bytes", async () => {
  const h = harness(), pending = h.api.read(input()), child = h.children[0]; let settled = false; pending.then(() => { settled = true; });
  child.bytes(frame(child.job())); child.emit("exit", 0, null); await tick();
  assert.equal(settled, false); assert.equal(h.api.status().activeWorker, true);
  assert.deepEqual(await h.api.read(input()), unavailable("source_busy")); assert.equal(h.children.length, 1);
  child.emit("close", 0, null); assert.equal((await pending).kind, "native_source_bytes"); assert.equal(h.api.status().cleanupConfirmed, true);
  await h.api.shutdown();
});

test("frame nonce/session/byte digest and exact metadata authority checks reject malformed successful exits", async () => {
  const mutations = [r => { r.sessionId = "22222222-2222-4222-8222-222222222222"; }, r => { r.byteLength++; }, r => { r.sha256 = "f".repeat(64); },
    r => { r.sourceAuthenticated = true; }, r => { r.publishable = true; }, r => { r.cleanupConfirmed = true; }, r => { r.identity.inode = "0"; },
    r => { r.identity.device = "2"; }, r => { r.identity.inode = "03"; }, r => { r.identity.inode = "18446744073709551616"; },
    r => { r.identity.size++; }, r => { r.identity.extra = "private"; }, r => { r.checks.acl = "unverified"; }, r => { r.checks.containment = "path_only"; },
    r => { r.checks.reads = 1; }, r => { r.checks.extra = true; }];
  for (const mutate of mutations) {
    const h = harness(), pending = h.api.read(input()), child = h.children[0], value = result(); mutate(value);
    child.finish(frame(child.job(), value)); assert.deepEqual(await pending, unavailable("source_worker_protocol")); await h.api.shutdown();
  }
  for (const mutate of [h => ({ ...h, nonce: "0".repeat(64) }), h => ({ ...h, protocolVersion: 2 }), h => ({ ...h, path: "/private" })]) {
    const h = harness(), pending = h.api.read(input()), child = h.children[0]; child.finish(frame(child.job(), result(), payload, mutate));
    assert.deepEqual(await pending, unavailable("source_worker_protocol")); await h.api.shutdown();
  }
});

test("binary framing rejects BOM/bad UTF-8/partial headers/truncated payload/trailing frames with no partial result", async () => {
  for (const mutate of [bytes => bytes.subarray(0, 3), bytes => bytes.subarray(0, -1), bytes => Buffer.concat([bytes, bytes]),
    bytes => { const value = Buffer.from(bytes); value[4] = 0xff; return value; },
    bytes => { const value = Buffer.from(bytes); value[4] = 0xef; value[5] = 0xbb; value[6] = 0xbf; return value; },
    bytes => { const value = Buffer.from(bytes); value.writeUInt32BE(0, 0); return value; },
    bytes => { const value = Buffer.from(bytes); value.writeUInt32BE(LIMITS.headerBytes + 1, 0); return value; }]) {
    const h = harness(), pending = h.api.read(input()), child = h.children[0]; child.finish(mutate(frame(child.job())));
    assert.deepEqual(await pending, unavailable("source_worker_protocol")); assert.ok(child.kills.length <= 1); await h.api.shutdown();
  }
});

test("raw source payload has an independent 8 MiB cap; total stdout and chunk caps terminate immediately", async () => {
  const exact = Buffer.alloc(LIMITS.sourceBytes, 120), h = harness({ deadlineMs: 2000 }), pending = h.api.read(input()), child = h.children[0];
  const encoded = frame(child.job(), result(exact), exact);
  for (let i = 0; i < encoded.length; i += 64000) child.bytes(encoded.subarray(i, i + 64000));
  child.emit("close", 0, null); const accepted = await pending; assert.equal(accepted.bytes.length, LIMITS.sourceBytes);
  accepted.bytes[0] = 1; assert.equal(exact[0], 120); await h.api.shutdown();
  const tooLarge = Buffer.alloc(LIMITS.sourceBytes + 1, 120), over = harness({ deadlineMs: 2000 }), oversized = over.api.read(input());
  over.children[0].finish(frame(over.children[0].job(), result(tooLarge), tooLarge));
  assert.deepEqual(await oversized, unavailable("source_worker_protocol")); await over.api.shutdown();
  for (const mode of ["bytes", "chunks"]) {
    const f = harness(), read = f.api.read(input()), c = f.children[0];
    if (mode === "bytes") c.bytes(Buffer.alloc(LIMITS.outputBytes + 1));
    else for (let i = 0; i <= LIMITS.outputChunks; i++) c.stdout.emit("data", Buffer.alloc(0));
    assert.deepEqual(await read, unavailable("source_worker_output_limit")); assert.deepEqual(c.kills, ["SIGKILL"]); await f.api.shutdown();
  }
});

test("known helper errors require zero payload and raw stderr/unknown error codes never escape", async () => {
  for (const code of SOURCE_CODES) {
    const h = harness(), pending = h.api.read(input()), child = h.children[0]; child.finish(frame(child.job(), unavailable(code), Buffer.alloc(0)));
    assert.deepEqual(await pending, unavailable(code)); await h.api.shutdown();
  }
  for (const [code, bytes] of [["/private/raw_diagnostic", Buffer.alloc(0)], ["source_missing", payload]]) {
    const h = harness(), pending = h.api.read(input()), child = h.children[0]; child.finish(frame(child.job(), unavailable(code), bytes));
    assert.deepEqual(await pending, unavailable("source_worker_protocol")); await h.api.shutdown();
  }
  const h = harness(), pending = h.api.read(input()), child = h.children[0]; child.stderr.write("/private/transcript-or-credential");
  assert.deepEqual(await pending, unavailable("source_worker_diagnostic")); assert.deepEqual(child.kills, ["SIGKILL"]); await h.api.shutdown();
});

test("abort/deadline send SIGKILL once to the owned object and wait for actual close", async () => {
  for (const mode of ["abort", "deadline"]) {
    const h = harness({ holdClose: true, deadlineMs: mode === "deadline" ? 10 : 200, cleanupMs: 100 });
    const abort = new AbortController(), pending = h.api.read(input(), { signal: abort.signal }), child = h.children[0];
    let settled = false; pending.then(() => { settled = true; }); if (mode === "abort") abort.abort();
    else await new Promise(resolve => setTimeout(resolve, 15));
    assert.deepEqual(child.kills, ["SIGKILL"]); assert.equal(settled, false); assert.equal(h.api.status().activeWorker, true);
    child.emit("error", new Error("late private failure")); child.stderr.write("late diagnostic"); assert.equal(child.kills.length, 1);
    child.emit("close", null, "SIGKILL"); assert.deepEqual(await pending, unavailable(mode === "abort" ? "source_aborted" : "source_worker_timeout"));
    assert.equal(h.api.status().quarantined, false); await h.api.shutdown();
  }
});

test("unconfirmed close permanently quarantines even after late close frees the slot", async () => {
  for (const killThrows of [false, true]) {
    const h = harness({ holdClose: true, killThrows, cleanupMs: 10 }), abort = new AbortController();
    const pending = h.api.read(input(), { signal: abort.signal }), child = h.children[0]; abort.abort();
    assert.deepEqual(await pending, unavailable("source_cleanup_unconfirmed")); assert.equal(h.api.status().activeWorker, true);
    assert.equal(h.api.status().cleanupConfirmed, false); assert.equal(h.api.status().quarantined, true);
    assert.deepEqual(await h.api.read(input()), unavailable("source_service_quarantined"));
    child.emit("close", 0, null); child.stdout.write(frame(child.job())); child.emit("error", new Error("late"));
    assert.equal(h.api.status().activeWorker, false); assert.equal(h.api.status().quarantined, true); assert.equal(child.kills.length, 1);
    assert.deepEqual(await h.api.read(input()), unavailable("source_service_quarantined")); assert.equal(h.children.length, 1);
    assert.deepEqual(await h.api.shutdown(), { kind: "source_helper_closed", cleanupConfirmed: true, quarantined: true });
  }
});

test("spawn/setup/stream/nonzero-exit failures are sanitized and preserve owned cleanup semantics", async () => {
  const failure = createNativeHelper({ ...trust, platform: "linux", spawnChild() { throw new Error("/private/executable"); } });
  assert.deepEqual(await failure.read(input()), unavailable("source_worker_spawn_failed")); assert.equal(failure.status().activeWorker, false); await failure.shutdown();
  for (const stream of ["stdin", "stdout", "stderr"]) {
    const h = harness(), pending = h.api.read(input()); h.children[0][stream].emit("error", new Error("/private/io"));
    assert.deepEqual(await pending, unavailable("source_worker_io_error")); assert.equal(h.children[0].kills.length, 1); await h.api.shutdown();
  }
  const h = harness(), pending = h.api.read(input()); h.children[0].bytes(frame(h.children[0].job())); h.children[0].emit("close", 1, null);
  assert.deepEqual(await pending, unavailable("source_worker_exit")); await h.api.shutdown();
});

test("synchronous abort during trusted spawn and shutdown never lose the termination request", async () => {
  const abort = new AbortController(), h = harness({ onSpawn: () => abort.abort() });
  assert.deepEqual(await h.api.read(input(), { signal: abort.signal }), unavailable("source_aborted")); assert.equal(h.children[0].kills.length, 1);
  await h.api.shutdown(); assert.deepEqual(await h.api.read(input()), unavailable("source_service_closed"));
  const waiting = harness({ holdClose: true, cleanupMs: 10 }), pending = waiting.api.read(input()), shutdown = waiting.api.shutdown();
  assert.deepEqual(await pending, unavailable("source_cleanup_unconfirmed"));
  assert.deepEqual(await shutdown, { kind: "source_helper_closed", cleanupConfirmed: false, quarantined: true });
});

test("external abort listener is removed after a successful close or quarantined failure", async () => {
  for (const fail of [false, true]) {
    const abort = new AbortController(); let adds = 0, removes = 0;
    const add = abort.signal.addEventListener.bind(abort.signal), remove = abort.signal.removeEventListener.bind(abort.signal);
    abort.signal.addEventListener = (...args) => { adds++; return add(...args); }; abort.signal.removeEventListener = (...args) => { removes++; return remove(...args); };
    const h = harness({ holdClose: fail, cleanupMs: 10 }), pending = h.api.read(input(), { signal: abort.signal });
    if (fail) abort.abort(); else h.children[0].finish(); await pending; assert.equal(adds, 1); assert.equal(removes, 1);
    h.children[0].emit("close", 0, null); await h.api.shutdown();
  }
});

test("real owned subprocess transports a binary frame with isolated environment; no native history/SDK/CLI is invoked", async () => {
  const script = `const fs = require('node:fs'), crypto = require('node:crypto');
    const job = JSON.parse(fs.readFileSync(0, 'utf8'));
    // macOS injects this runtime key even when spawn's environment is exact.
    if (Object.keys(process.env).some(k => !['LANG','LC_ALL',...(process.platform==='darwin'?['__CF_USER_TEXT_ENCODING']:[])].includes(k))) { process.stderr.write('environment_not_isolated'); process.exit(1); }
    const bytes = Buffer.from('owned synthetic child fixture\\n');
    const result = {kind:'native_source_bytes',sessionId:job.source.sessionId,byteLength:bytes.length,sha256:crypto.createHash('sha256').update(bytes).digest('hex'),
      identity:{device:'1',inode:'3',size:bytes.length,mtimeNs:'4',ctimeNs:'5'},checks:{owner:'posix_euid_and_mode',acl:'no_extended_acl',containment:'root_identity_and_openat_nofollow',reads:2,matchingBytes:true,unchangedObservedIdentity:true},sourceAuthenticated:false,publishable:false};
    const header = Buffer.from(JSON.stringify({protocolVersion:1,nonce:job.nonce,result})); const length=Buffer.alloc(4);length.writeUInt32BE(header.length);
    process.stdout.write(Buffer.concat([length,header,bytes]));`;
  const api = createNativeHelper({ ...trust, platform: "linux", spawnChild: (executable, args, options) => {
    assert.deepEqual(args, []); assert.deepEqual(options.env, { LANG: "C", LC_ALL: "C" });
    return spawn(executable, ["-e", script], options); // Trusted fixture injection only.
  } });
  const result = await api.read(input()); assert.equal(result.kind, "native_source_bytes", result.code);
  assert.equal(result.bytes.toString(), "owned synthetic child fixture\n"); assert.equal(result.cleanupConfirmed, true);
  assert.equal(api.status().activeWorker, false); assert.equal((await api.shutdown()).cleanupConfirmed, true);
});
