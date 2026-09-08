"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs/promises");
const os = require("node:os"), path = require("node:path"), { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream"), { spawn } = require("node:child_process");
const { performance } = require("node:perf_hooks");
const crypto = require("node:crypto");
const { createSourceService, LIMITS } = require("../protocol/native/claude/history-source-service");
const { createSourceReader } = require("../protocol/native/claude/history-source");
const fixture = require("../protocol/native/claude/history-fixture.cjs");
const posix = { skip: !["darwin", "linux"].includes(process.platform) };
const bindingId = fixture.uuid(70), requestId = fixture.uuid(71);
const request = generation => ({ bindingId, generation: generation || 1, requestId });
const binding = () => ({ bindingId, generation: 1, source: { projectsRoot: path.resolve("synthetic-projects"), projectKey: "-workspace", sessionId: fixture.sessionId } });
const reject = code => ({ kind: "source_unavailable", code });
function harness(options = {}) {
  const children = [], launches = [];
  const service = createSourceService({ platform: "darwin", deadlineMs: 2000, cleanupMs: 50, ...options,
    spawnChild(executable, args, launch) {
      launches.push({ executable, args, launch });
      if (options.spawnError) throw new Error("private source/path/credential must not escape");
      const child = new EventEmitter(); child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
      child.kills = []; child.kill = signal => { child.kills.push(signal); options.onKill?.(child); return false; };
      const input = []; child.stdin.on("data", chunk => input.push(chunk));
      child.job = () => JSON.parse(Buffer.concat(input));
      child.reply = result => child.stdout.write(JSON.stringify({ protocolVersion: 1, nonce: child.job().nonce, request: child.job().request, result }) + "\n");
      child.close = (code = 0, signal = null) => child.emit("close", code, signal);
      children.push(child); options.onSpawn?.(child);
      return child;
    } });
  return { service, children, launches };
}
async function setup(t) {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "stepsemble-bound-history-"));
  const home = await fs.realpath(temp), projectsRoot = path.join(home, "projects"), projectKey = "-workspace";
  const project = path.join(projectsRoot, projectKey); await fs.mkdir(project, { recursive: true, mode: 0o700 });
  const c = fixture.richCases("/synthetic/workspace").find(c => c.name === "file-history"), filename = path.join(project, `${c.sessionId}.jsonl`);
  const bytes = Buffer.from(c.records.map(row => JSON.stringify(row)).join("\n") + "\n"); await fs.writeFile(filename, bytes, { mode: 0o600 });
  t.after(() => fs.rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));
  return { home, bytes, filename, binding: { ...binding(), source: { projectsRoot, projectKey, sessionId: c.sessionId } } };
}
test("binding detaches trusted source and capture accepts only exact identity/generation/request fields", async () => {
  const h = harness(), value = binding(), bound = h.service.bind(value);
  assert.equal(bound.kind, "bound_source"); assert.ok(Object.isFrozen(bound.descriptor));
  value.source.projectsRoot = path.resolve("other-projects"); value.source.sessionId = fixture.otherSessionId;
  for (const bad of [{ ...request(), source: value.source }, { ...request(), projectsRoot: value.source.projectsRoot },
    { ...request(), generation: 2 }, { ...request(), bindingId: fixture.uuid(80) }, { ...request(), requestId: "../escape" }])
    assert.deepEqual(await bound.capture(bad), reject("source_binding_mismatch"));
  assert.equal(h.children.length, 0);
  const pending = bound.capture(request());
  assert.deepEqual(h.children[0].job().source, binding().source);
  h.children[0].reply(reject("source_missing")); h.children[0].close();
  assert.deepEqual(await pending, reject("source_missing")); assert.equal(h.service.status().activeWorkers, 0);
  assert.deepEqual(await h.service.shutdown(), { kind: "source_service_closed", cleanupConfirmed: true, quarantined: false });
});
test("invalid registration, wildcard/broad roots, accessors and unsupported platforms never launch IO", async () => {
  const h = harness(); let invoked = false;
  const accessor = binding(); Object.defineProperty(accessor, "source", { enumerable: true, get() { invoked = true; return binding().source; } });
  for (const bad of [accessor, { ...binding(), generation: 0 }, { ...binding(), approved: true },
    { ...binding(), source: { ...binding().source, projectsRoot: path.parse(process.cwd()).root } },
    { ...binding(), source: { ...binding().source, projectsRoot: path.resolve("synthetic-*") } },
    { ...binding(), source: { ...binding().source, projectKey: "../other" } }]) assert.deepEqual(h.service.bind(bad), reject("invalid_source_binding"));
  const invalidRequest = request(); Object.defineProperty(invalidRequest, "requestId", { enumerable: true, get() { invoked = true; return requestId; } });
  assert.deepEqual(await h.service.bind(binding()).capture(invalidRequest), reject("source_binding_mismatch"));
  assert.equal(invoked, false); assert.equal(h.children.length, 0);
  const windows = harness({ platform: "win32" });
  assert.deepEqual(await windows.service.bind(binding()).capture(request()), reject("source_platform_unsupported"));
  assert.equal(windows.children.length, 0);
  await h.service.shutdown(); await windows.service.shutdown();
});
test("two worker ceiling has no queue; cancelling one flight does not cancel another or free early", async () => {
  const h = harness(), a = h.service.bind(binding()), id2 = fixture.uuid(72), b = h.service.bind({ ...binding(), bindingId: id2 });
  const abort = new AbortController(), first = a.capture(request(), { signal: abort.signal }), second = b.capture({ ...request(), bindingId: id2 });
  assert.equal(h.service.status().activeWorkers, 2);
  assert.deepEqual(await a.capture(request()), reject("source_busy"));
  const c = h.service.bind({ ...binding(), bindingId: fixture.uuid(73) });
  assert.deepEqual(await c.capture({ ...request(), bindingId: fixture.uuid(73) }), reject("source_busy"));
  abort.abort(); assert.deepEqual(h.children[0].kills, ["SIGKILL"]); assert.deepEqual(h.children[1].kills, []);
  assert.equal(h.service.status().activeWorkers, 2);
  h.children[0].close(null, "SIGKILL"); assert.deepEqual(await first, reject("source_aborted"));
  h.children[1].reply(reject("source_empty")); h.children[1].close(); assert.deepEqual(await second, reject("source_empty"));
  assert.equal(h.children.length, 2); await h.service.shutdown();
});
test("revocation fences late replies and rebind requires a strictly newer generation after cleanup", async () => {
  const h = harness(), a = h.service.bind(binding()), pending = a.capture(request());
  assert.deepEqual(a.status(), { revoked: false, activeWorker: true, cleanupConfirmed: false });
  assert.ok(Object.isFrozen(a.status()));
  a.revoke(); a.revoke(); assert.deepEqual(h.children[0].kills, ["SIGKILL"]);
  assert.deepEqual(a.status(), { revoked: true, activeWorker: true, cleanupConfirmed: false });
  assert.deepEqual(h.service.bind({ ...binding(), generation: 2 }), reject("source_binding_conflict"));
  h.children[0].reply(reject("source_missing")); h.children[0].close(); assert.deepEqual(await pending, reject("source_binding_revoked"));
  assert.deepEqual(a.status(), { revoked: true, activeWorker: false, cleanupConfirmed: true });
  assert.deepEqual(h.service.bind(binding()), reject("source_binding_conflict"));
  const next = h.service.bind({ ...binding(), generation: 2 }); assert.equal(next.kind, "bound_source");
  assert.deepEqual(next.status(), { revoked: false, activeWorker: false, cleanupConfirmed: true });
  assert.deepEqual(a.status(), { revoked: true, activeWorker: false, cleanupConfirmed: true });
  assert.deepEqual(await a.capture(request()), reject("source_binding_revoked"));
  assert.deepEqual(await next.capture(request()), reject("source_binding_mismatch"));
  const p = next.capture(request(2)); h.children[1].reply(reject("source_empty")); h.children[1].close();
  assert.deepEqual(await p, reject("source_empty")); await h.service.shutdown();
});
test("unconfirmed cleanup resolves boundedly, quarantines service, retains slot and ignores late output", async () => {
  const h = harness({ deadlineMs: 20, cleanupMs: 20 }), a = h.service.bind(binding()), start = performance.now();
  const result = await a.capture(request());
  assert.deepEqual(result, reject("source_cleanup_unconfirmed")); assert.ok(performance.now() - start < 2000);
  assert.deepEqual(a.status(), { revoked: false, activeWorker: true, cleanupConfirmed: false });
  assert.deepEqual(h.children[0].kills, ["SIGKILL"]); assert.equal(h.service.status().activeWorkers, 1); assert.equal(h.service.status().quarantined, true);
  assert.deepEqual(await a.capture(request()), reject("source_service_quarantined"));
  assert.deepEqual(h.service.bind({ ...binding(), bindingId: fixture.uuid(81) }), reject("source_service_quarantined"));
  assert.deepEqual(await h.service.shutdown(), { kind: "source_service_closed", cleanupConfirmed: false, quarantined: true });
  assert.deepEqual(a.status(), { revoked: true, activeWorker: true, cleanupConfirmed: false });
  h.children[0].reply(reject("source_empty")); h.children[0].close();
  assert.deepEqual(a.status(), { revoked: true, activeWorker: false, cleanupConfirmed: true });
  assert.equal(h.service.status().activeWorkers, 0); assert.equal(h.service.status().quarantined, true);
});
test("a response alone is not completion; timeout wins until actual process and stream close", async () => {
  const h = harness({ deadlineMs: 20, onKill: child => child.close(null, "SIGKILL") }), a = h.service.bind(binding());
  const p = a.capture(request()); h.children[0].reply(reject("source_missing"));
  assert.equal(h.service.status().activeWorkers, 1);
  assert.deepEqual(await p, reject("source_worker_timeout")); assert.equal(h.service.status().activeWorkers, 0);
  await h.service.shutdown();
});
test("abort-before-spawn, abort inside launch and shutdown preserve cleanup and never start a replacement", async () => {
  const abort = new AbortController(); abort.abort(); const h = harness(), a = h.service.bind(binding());
  assert.deepEqual(await a.capture(request(), { signal: abort.signal }), reject("source_aborted")); assert.equal(h.children.length, 0);
  assert.deepEqual(await a.capture(request(), { signal: {} }), reject("invalid_source_signal"));
  const during = new AbortController(), sync = harness({ onSpawn: () => during.abort(), onKill: c => c.close(null, "SIGKILL") });
  assert.deepEqual(await sync.service.bind(binding()).capture(request(), { signal: during.signal }), reject("source_aborted"));
  assert.deepEqual(sync.children[0].kills, ["SIGKILL"]); await sync.service.shutdown();
  const p = a.capture(request()), shutdown = h.service.shutdown();
  h.children[0].close(null, "SIGKILL"); assert.deepEqual(await p, reject("source_service_closed"));
  assert.equal((await shutdown).cleanupConfirmed, true);
  assert.deepEqual(await a.capture(request()), reject("source_service_closed")); assert.deepEqual(h.service.bind(binding()), reject("source_service_closed"));
});
test("spawn exceptions, error events, stream errors, noisy stderr and oversized output stay sanitized", async () => {
  const thrown = harness({ spawnError: true });
  assert.deepEqual(await thrown.service.bind(binding()).capture(request()), reject("source_worker_spawn_failed"));
  assert.equal(thrown.service.status().activeWorkers, 0); await thrown.service.shutdown();
  for (const [code, action] of [
    ["source_worker_spawn_failed", c => c.emit("error", new Error("private error"))],
    ["source_worker_io_error", c => c.stdin.emit("error", new Error("private error"))],
    ["source_worker_diagnostic", c => c.stderr.write("private path and transcript")],
    ["source_worker_output_limit", c => c.stdout.write(Buffer.alloc(LIMITS.outputBytes + 1))],
    ["source_worker_output_limit", c => { for (let i = 0; i <= LIMITS.outputChunks; i++) c.stdout.write(Buffer.from("x")); }],
  ]) {
    const h = harness({ onKill: c => c.close(null, "SIGKILL") }), p = h.service.bind(binding()).capture(request());
    action(h.children[0]); assert.deepEqual(await p, reject(code)); assert.equal(h.service.status().activeWorkers, 0);
    h.children[0].emit("error", new Error("late private child error"));
    h.children[0].emit("error", new Error("repeated private child error")); await h.service.shutdown();
  }
});
test("wrong nonce/correlation, malformed UTF-8, extra frames, absent tail and nonzero exits never return rows", async () => {
  for (const modify of [
    (wire) => { wire.protocolVersion = 2; },
    (wire) => { wire.nonce = "0".repeat(64); }, (wire) => { wire.request.generation++; },
    (wire) => { wire.request.requestId = fixture.uuid(99); }, (wire) => { wire.result.code = "private contents"; },
  ]) {
    const h = harness(), p = h.service.bind(binding()).capture(request()), c = h.children[0];
    const wire = { protocolVersion: 1, nonce: c.job().nonce, request: c.job().request, result: reject("source_missing") }; modify(wire);
    c.stdout.write(JSON.stringify(wire) + "\n"); c.close(); assert.deepEqual(await p, reject("source_worker_protocol")); await h.service.shutdown();
  }
  for (const output of [Buffer.from([0xc3, 0x28, 10]), Buffer.from('{}\n{}\n'), Buffer.from('{}'), Buffer.from([0xef, 0xbb, 0xbf, 123, 125, 10])]) {
    const h = harness(), p = h.service.bind(binding()).capture(request()); h.children[0].stdout.write(output); h.children[0].close();
    assert.deepEqual(await p, reject("source_worker_protocol")); await h.service.shutdown();
  }
  const h = harness(), p = h.service.bind(binding()).capture(request()); h.children[0].reply(reject("source_missing")); h.children[0].close(1);
  assert.deepEqual(await p, reject("source_worker_exit")); await h.service.shutdown();
});
test("binding tombstones and limits prevent unbounded registration or stale generation reuse", async () => {
  const h = harness();
  for (let n = 1; n <= LIMITS.bindings; n++) h.service.bind({ ...binding(), bindingId: fixture.uuid(n) }).revoke();
  assert.equal(h.service.status().retainedBindings, LIMITS.bindings);
  assert.deepEqual(h.service.bind(binding()), reject("source_binding_limit"));
  assert.equal(h.service.bind({ ...binding(), bindingId: fixture.uuid(1), generation: 2 }).kind, "bound_source");
  await h.service.shutdown();
  for (const options of [{ deadlineMs: 0 }, { deadlineMs: 10001 }, { cleanupMs: 1001 }]) assert.throws(() => createSourceService(options), /limits/);
});
test("real permission worker captures owned synthetic bytes without source writes or extra authority", posix, async t => {
  const f = await setup(t), launches = [];
  const service = createSourceService({ spawnChild(...args) { launches.push(args); return spawn(...args); } });
  t.after(() => service.shutdown());
  const direct = await createSourceReader()(f.binding.source), bound = service.bind(f.binding), result = await bound.capture(request());
  assert.equal(result.kind, "bound_source_snapshot", JSON.stringify(result)); assert.deepEqual(result.snapshot, direct);
  assert.equal(result.cleanupConfirmed, true); assert.equal(result.publishable, false); assert.equal(result.sourceAuthenticated, false);
  assert.deepEqual(await fs.readFile(f.filename), f.bytes); assert.equal(service.status().activeWorkers, 0);
  const [executable, args, options] = launches[0]; assert.equal(executable, process.execPath);
  assert.ok(args.includes("--permission")); assert.ok(args.includes("--max-old-space-size=128"));
  assert.ok(!args.includes("--allow-child-process")); assert.ok(!args.some(v => v.startsWith("--allow-fs-write")));
  assert.equal(options.shell, false); assert.equal(options.detached, false);
  const allowed = new Set(["PATH", "SystemRoot", "SYSTEMROOT", "WINDIR", "LANG", "LC_ALL"]);
  assert.ok(Object.keys(options.env).every(key => allowed.has(key)));
  assert.ok(args.filter(v => v.startsWith("--allow-fs-read=")).includes(`--allow-fs-read=${f.binding.source.projectsRoot}`));
});
test("parent rejects a foreign or authority-elevated snapshot even with correct worker correlation", async () => {
  const c = fixture.richCases("/synthetic/workspace").find(c => c.name === "file-history");
  const bytes = Buffer.from(c.records.map(row => JSON.stringify(row)).join("\n") + "\n");
  const snapshot = { kind: "source_snapshot", sessionId: c.sessionId, records: c.records, byteLength: bytes.length,
    sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
    identity: { device: "1", inode: "2", size: bytes.length, mtimeNs: "123", ctimeNs: "123" },
    checks: { owner: "posix_euid_and_mode", reads: 2, matchingBytes: true, unchangedObservedIdentity: true }, sourceAuthenticated: false, publishable: false };
  const sourceBinding = { ...binding(), source: { ...binding().source, sessionId: c.sessionId } };
  for (const change of [s => { s.sessionId = fixture.otherSessionId; }, s => { s.records[1].sessionId = fixture.otherSessionId; },
    s => { s.sourceAuthenticated = true; }, s => { s.publishable = true; }, s => { s.identity.size++; }, s => { s.checks.reads = 1; }]) {
    const h = harness(), p = h.service.bind(sourceBinding).capture(request()), altered = structuredClone(snapshot); change(altered);
    h.children[0].reply(altered); h.children[0].close(); assert.deepEqual(await p, reject("source_worker_protocol")); await h.service.shutdown();
  }
  const h = harness(), p = h.service.bind(sourceBinding).capture(request()), child = h.children[0];
  snapshot.records[1].message.content = "合成 Unicode 🐾";
  const updatedBytes = Buffer.from(snapshot.records.map(row => JSON.stringify(row)).join("\n") + "\n");
  snapshot.byteLength = snapshot.identity.size = updatedBytes.length;
  snapshot.sha256 = crypto.createHash("sha256").update(updatedBytes).digest("hex");
  const wire = Buffer.from(JSON.stringify({ protocolVersion: 1, nonce: child.job().nonce, request: child.job().request, result: snapshot }) + "\n");
  // Split across individual UTF-8 bytes (without exceeding the chunk cap).
  const unicode = wire.indexOf(Buffer.from("合成"));
  child.stdout.write(wire.subarray(0, unicode));
  for (let i = unicode; i < unicode + 6; i++) child.stdout.write(wire.subarray(i, i + 1));
  child.stdout.write(wire.subarray(unicode + 6)); child.close();
  assert.equal((await p).snapshot.records[1].message.content, "合成 Unicode 🐾");
  await h.service.shutdown();
});
test("real stuck worker is terminated after deadline while parent event loop remains responsive", async t => {
  let child, kills = 0, ticks = 0, ready = false;
  const service = createSourceService({ platform: "darwin", deadlineMs: 1500, cleanupMs: 1000,
    spawnChild(executable, args, options) {
      child = spawn(executable, [...args.slice(0, -1), "-e", "process.stdin.resume(); process.stdout.write('ready\\n'); while (true) {}"], options);
      child.stdout.on("data", chunk => { if (chunk.includes(Buffer.from("ready\n"))) ready = true; });
      const kill = child.kill.bind(child); child.kill = signal => { kills++; return kill(signal); }; return child;
    } });
  t.after(() => service.shutdown());
  const timer = setInterval(() => ticks++, 20), started = performance.now();
  const result = await service.bind(binding()).capture(request()); clearInterval(timer);
  assert.deepEqual(result, reject("source_worker_timeout")); assert.ok(performance.now() - started < 5000);
  assert.equal(ready, true); assert.ok(ticks >= 2); assert.equal(kills, 1); assert.equal(service.status().activeWorkers, 0);
  assert.ok(child.exitCode !== null || child.signalCode !== null);
});
test("real worker permissions deny writes, spawning and reading outside the registered root", async t => {
  const f = await setup(t);
  const script = `const fs=require('node:fs'),cp=require('node:child_process');let ok=process.permission.has('fs.read',${JSON.stringify(path.join(f.binding.source.projectsRoot, "another-session.jsonl"))});
    for(const fn of [()=>fs.openSync(${JSON.stringify(f.filename)},'r+'),()=>fs.readFileSync(${JSON.stringify(path.join(f.home, "outside"))}),()=>cp.spawn(process.execPath,['--version'])])
      try{fn();ok=false;}catch(e){if(e.code!=='ERR_ACCESS_DENIED')ok=false;}
    process.stdin.resume();process.stdin.once('end',()=>{if(ok)process.stdout.write('{}\\n');else process.exitCode=2;});`;
  let child;
  const service = createSourceService({ platform: "darwin", spawnChild(executable, args, options) {
    child = spawn(executable, [...args.slice(0, -1), "-e", script], options); return child;
  } });
  t.after(() => service.shutdown());
  assert.deepEqual(await service.bind(f.binding).capture(request()), reject("source_worker_protocol")); // Deliberately no valid response, but canaries exited 0.
  assert.equal(child.exitCode, 0); assert.deepEqual(await fs.readFile(f.filename), f.bytes);
});
test("worker self-watchdog exits its own context if the parent disappears during unresolved async IO", async () => {
  const vm = require("node:vm"), wireModule = require("../protocol/native/claude/history-worker-wire");
  const source = await fs.readFile(path.join(__dirname, "../protocol/native/claude/history-source-worker.js"), "utf8");
  const stdin = new PassThrough(), stdout = new PassThrough(), module = {}, exits = [];
  let resolveExit, timeout;
  const exited = new Promise((resolve, reject) => { resolveExit = resolve; timeout = setTimeout(() => reject(new Error("watchdog did not exit")), 2000); });
  const stubRequire = name => name === "./history-source" ? { createSourceReader: () => async () => new Promise(() => {}) }
    : { ...wireModule, LIMITS: { ...wireModule.LIMITS, deadlineMs: 20 } };
  stubRequire.main = module;
  vm.runInNewContext(source, { module, require: stubRequire, Buffer, setTimeout, clearTimeout,
    process: { stdin, stdout, permission: { has: () => false }, exit: code => { exits.push(code); resolveExit(); } } });
  stdin.end(JSON.stringify({ protocolVersion: 1, nonce: "a".repeat(64), request: request(), source: binding().source }) + "\n");
  try { await exited; assert.deepEqual(exits, [1]); assert.equal(stdout.readableLength, 0); }
  finally { clearTimeout(timeout); stdin.destroy(); stdout.destroy(); }
});
