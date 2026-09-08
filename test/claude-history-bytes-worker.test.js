"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), crypto = require("node:crypto"), path = require("node:path");
const fs = require("node:fs/promises"), os = require("node:os"), { spawn } = require("node:child_process");
const wire = require("../protocol/native/claude/history-bytes-wire");
const { processJob, validContext, readInput } = require("../protocol/native/claude/history-bytes-worker");
const sessionId = "11111111-1111-4111-8111-111111111111", messageId = "22222222-2222-4222-8222-222222222222";
const record = { type: "user", sessionId, uuid: messageId, parentUuid: null, message: { role: "user", content: "owned synthetic 繁體中文 🐾" } };
const raw = Buffer.from(JSON.stringify(record) + "\n"), sdkPath = path.resolve("owned-sdk-fixture/sdk.mjs");
const hash = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
function metadata(bytes = raw) { return { protocolVersion: 2, nonce: "a".repeat(64),
  request: { bindingId: "33333333-3333-4333-8333-333333333333", generation: 1, requestId: "44444444-4444-4444-8444-444444444444" },
  snapshot: { kind: "native_source_bytes", sessionId, byteLength: bytes.length, sha256: hash(bytes),
    identity: { device: "1", inode: "2", size: bytes.length, mtimeNs: "3", ctimeNs: "4" },
    checks: { owner: "posix_euid_and_mode", acl: "no_extended_acl", containment: "root_identity_and_openat_nofollow", reads: 2, matchingBytes: true, unchangedObservedIdentity: true },
    sourceAuthenticated: false, publishable: false }, history: { sdkPath, page: { offset: 0, limit: 10 }, expectedVersion: null } }; }
const clone = value => JSON.parse(JSON.stringify(value));
const unavailable = code => ({ kind: "source_unavailable", code });
function fakeReader(counter = { loads: 0, stores: 0 }) { return async () => { counter.loads++;
  return async (id, options) => {
    counter.stores++; assert.equal(id, sessionId); assert.equal(options.includeSystemMessages, true);
    const records = await options.sessionStore.load({ sessionId: id, projectKey: options.dir.replace(/[^a-zA-Z0-9]/g, "-") });
    return records.filter(row => row.type === "user").slice(options.offset, options.offset + options.limit).map(row => ({
      type: row.type, uuid: row.uuid, session_id: id, parent_tool_use_id: null, parent_agent_id: null, message: row.message }));
  };
}; }

test("v2 exact binary job roundtrips native metadata/raw bytes without path or authority", () => {
  const job = metadata(), frame = wire.encodeJob(job, raw), parsed = wire.readJob(frame);
  assert.equal(wire.WIRE_VERSION, 2); assert.deepEqual(parsed.job, job); assert.deepEqual(parsed.bytes, raw);
  job.snapshot.identity.inode = "999"; assert.equal(parsed.job.snapshot.identity.inode, "2");
  assert.equal(Object.hasOwn(parsed.job, "source"), false); assert.equal(frame.readUInt32BE(0) + raw.length + 4, frame.length);
});

test("header/snapshot/source path/SDK/page/version mutations reject before SDK loading", async () => {
  const changes = [v => { v.source = { projectsRoot: "/private" }; }, v => { v.snapshot.projectsRoot = "/private"; },
    v => { v.snapshot.bytes = "secret"; }, v => { v.snapshot.cleanupConfirmed = true; }, v => { v.args = []; }, v => { v.env = {}; },
    v => { v.protocolVersion = 1; }, v => { v.nonce = "bad"; }, v => { v.request.generation = 0; },
    v => { v.snapshot.sourceAuthenticated = true; }, v => { v.snapshot.publishable = true; }, v => { delete v.snapshot.checks.acl; },
    v => { v.snapshot.checks.containment = "path_only"; }, v => { v.snapshot.identity.inode = "02"; },
    v => { v.snapshot.identity.device = "18446744073709551616"; }, v => { v.snapshot.identity.mtimeNs = "-1"; },
    v => { v.snapshot.sha256 = "0".repeat(64); }, v => { v.snapshot.byteLength++; }, v => { v.snapshot.identity.size++; },
    v => { v.history.sdkPath = "relative/sdk.mjs"; }, v => { v.history.sdkPath = sdkPath + "?loader"; },
    v => { delete v.history.expectedVersion; }, v => { v.history.expectedVersion = {}; },
    v => { v.history.page.limit = 101; }, v => { v.history.page.offset = 2001; }];
  for (const change of changes) {
    const job = metadata(); change(job); let loaded = 0;
    assert.equal(wire.encodeJob(job, raw), null);
    assert.deepEqual(await processJob(job, raw, { loadReader: async () => { loaded++; } }), unavailable("source_worker_protocol")); assert.equal(loaded, 0);
  }
  let called = 0; const accessor = metadata(); Object.defineProperty(accessor.snapshot, "byteLength", { enumerable: true, get() { called++; return raw.length; } });
  assert.equal(wire.encodeJob(accessor, raw), null); assert.equal(called, 0);
});

test("framing rejects fatal UTF8/BOM/truncation/trailing payload/header caps/raw caps/hash corruption", () => {
  const good = wire.encodeJob(metadata(), raw);
  for (const change of [v => v.subarray(0, 3), v => v.subarray(0, -1), v => Buffer.concat([v, Buffer.from("x")]),
    v => { v.writeUInt32BE(0); return v; }, v => { v.writeUInt32BE(wire.LIMITS.headerBytes + 1); return v; },
    v => { v[4] = 0xff; return v; }, v => { v[4] = 0xef; v[5] = 0xbb; v[6] = 0xbf; return v; }, v => { v[v.length - 1] ^= 1; return v; }])
    assert.equal(wire.readJob(change(Buffer.from(good))), null);
  const exact = Buffer.alloc(wire.LIMITS.sourceBytes, 120); assert.ok(wire.readJob(wire.encodeJob(metadata(exact), exact)));
  const oversize = Buffer.alloc(wire.LIMITS.sourceBytes + 1, 120); assert.equal(wire.encodeJob(metadata(oversize), oversize), null);
});

test("stdin reader counts raw bytes and chunks before parsing and propagates stream failure", async () => {
  const good = wire.encodeJob(metadata(), raw);
  async function* split() { yield good.subarray(0, 2); yield good.subarray(2, 30); yield good.subarray(30); }
  assert.deepEqual((await readInput(split())).bytes, raw);
  for (const chunks of [[Buffer.alloc(wire.LIMITS.inputBytes + 1)], Array.from({ length: wire.LIMITS.inputChunks + 1 }, () => Buffer.alloc(0)),
    [Buffer.from([0, 0, 0, 0])], [good.subarray(0, -1)], ["untrusted decoded text"]]) {
    async function* stream() { yield* chunks; } await assert.rejects(readInput(stream()), /invalid_worker_input/);
  }
  async function* faulty() { yield good.subarray(0, 2); throw new Error("owned failure"); }
  await assert.rejects(readInput(faulty()), /owned failure/);
});

test("bytes-only parser→snapshot store→SDK selection retains native checks and inert authority", async () => {
  const counter = { loads: 0, stores: 0 }, job = metadata(), copy = Buffer.from(raw);
  const result = await processJob(job, copy, { loadReader: fakeReader(counter) });
  assert.equal(result.kind, "source_history_observation"); assert.deepEqual(counter, { loads: 1, stores: 1 });
  assert.deepEqual(result.source.checks, job.snapshot.checks); assert.equal(result.source.kind, "source_snapshot_summary");
  assert.equal(result.source.recordCount, 1); assert.equal(result.observation.messages[0].blocks[0].text, record.message.content);
  assert.equal(result.source.sourceAuthenticated, false); assert.equal(result.observation.authority.resumeAllowed, false); assert.deepEqual(copy, raw);
  const response = wire.encodeResponse(result, job); assert.deepEqual(wire.readResponse(response, job), result);
  assert.equal(response.indexOf(10), response.length - 1); assert.ok(response.length <= wire.LIMITS.pageBytes);
});

test("version fence and invalid UTF8/JSONL/scope reject with zero SDK fallback", async () => {
  const job = metadata(); job.history.expectedVersion = wire.sourceVersion(job.snapshot); job.history.expectedVersion.identity.inode = "9";
  let loads = 0; const reader = async () => { loads++; throw new Error("never"); };
  assert.deepEqual(await processJob(job, raw, { loadReader: reader }), unavailable("source_version_changed"));
  for (const [bytes, code] of [[Buffer.from([0xff, 10]), "source_invalid_encoding"], [raw.subarray(0, -1), "source_incomplete_tail"],
    [Buffer.from("{}\n"), "source_scope_mismatch"], [Buffer.from("bad\n"), "source_invalid_json"],
    [Buffer.from(JSON.stringify({ ...record, sessionId: "55555555-5555-4555-8555-555555555555" }) + "\n"), "source_scope_mismatch"]])
    assert.deepEqual(await processJob(metadata(bytes), bytes, { loadReader: reader }), unavailable(code));
  assert.equal(loads, 0);
});

test("SDK load/select failures are sanitized; no alternate source or reader is attempted", async () => {
  for (const reader of [async () => { throw new Error("/private/sdk diagnostic"); }, async () => null])
    assert.deepEqual(await processJob(metadata(), raw, { loadReader: reader }), unavailable("source_sdk_unavailable"));
  assert.deepEqual(await processJob(metadata(), raw, { loadReader: async () => async () => { throw new Error("private"); } }), unavailable("source_selection_failed"));
  const result = await processJob(metadata(), raw, { loadReader: async () => async () => [] });
  assert.equal(result.code, "source_selection_failed"); // SessionStore wasn't used: no fake empty success.
});

test("response fencing rejects changed source, request, session, legacy checks and untrusted authority", async () => {
  const job = metadata(), result = await processJob(job, raw, { loadReader: fakeReader() });
  const response = value => Buffer.from(JSON.stringify({ protocolVersion: 2, nonce: job.nonce, request: job.request, result: value }) + "\n");
  for (const change of [v => { v.source.sha256 = "f".repeat(64); }, v => { v.source.identity.inode = "3"; },
    v => { v.source.sessionId = messageId; }, v => { delete v.source.checks.acl; delete v.source.checks.containment; },
    v => { v.source.publishable = true; }, v => { v.observation.authority.sourceAuthenticated = true; }]) {
    const value = clone(result); change(value); assert.equal(wire.readResponse(response(value), job), null);
  }
  const good = response(result);
  for (const other of [{ ...job, nonce: "b".repeat(64) }, { ...job, request: { ...job.request, generation: 2 } }]) assert.equal(wire.readResponse(good, other), null);
  assert.equal(wire.readResponse(Buffer.concat([good, good]), job), null); assert.equal(wire.readResponse(good.subarray(0, -1), job), null);
  assert.equal(wire.readResponse(response(unavailable("/private")), job), null);
  assert.deepEqual(wire.readResponse(wire.encodeResponse({ ...result, raw: "x".repeat(wire.LIMITS.outputBytes) }, job), job), unavailable("source_observation_too_large"));
});

test("launch grants exact code/SDK files only, not source directories, write, child, environment, or arbitrary flags", () => {
  const launch = wire.launchOptions(sdkPath), grants = launch.args.filter(v => v.startsWith("--allow-fs-read="));
  assert.equal(launch.executable, process.execPath); assert.ok(launch.args.includes("--permission")); assert.equal(grants.length, 13);
  assert.ok(grants.every(v => /\.(?:js|mjs|json)$/.test(v))); assert.ok(!grants.includes(`--allow-fs-read=${path.dirname(sdkPath)}`));
  assert.ok(!launch.args.some(v => /allow-child|allow-fs-write|source-root/.test(v))); assert.deepEqual(launch.options.env, { LANG: "C", LC_ALL: "C" });
  assert.equal(launch.options.shell, false); assert.equal(launch.options.detached, false); assert.deepEqual(launch.options.stdio, ["pipe", "pipe", "pipe"]);
  for (const candidate of ["sdk.mjs", "/", sdkPath + "\n", path.dirname(sdkPath)]) assert.throws(() => wire.launchOptions(candidate));
  assert.equal(validContext(undefined), false);
  for (const permission of ["fs.read", "fs.write", "child"]) assert.equal(validContext({ has: key => key === permission }), false);
  assert.equal(validContext({ has: () => false }), true);
});

async function runChild(launch, frame) {
  return new Promise((resolve, reject) => {
    const child = spawn(launch.executable, launch.args, launch.options); let out = Buffer.alloc(0), errors = 0, killed = false, closed = false;
    const stop = () => { if (!killed && !closed) { killed = true; child.kill("SIGKILL"); } };
    const timer = setTimeout(stop, 2000), cleanup = setTimeout(() => {
      const error = new Error("owned_child_cleanup_unconfirmed"); error.cleanupUnconfirmed = true; reject(error);
    }, 3000);
    child.on("error", stop); for (const stream of [child.stdin, child.stdout, child.stderr]) stream.on("error", stop);
    child.stdout.on("data", chunk => { if (out.length + chunk.length > wire.LIMITS.outputBytes) stop(); else out = Buffer.concat([out, chunk]); });
    child.stderr.on("data", () => { errors++; stop(); });
    child.once("close", (code, signal) => { closed = true; clearTimeout(timer); clearTimeout(cleanup); resolve({ code, signal, out, errors }); });
    child.stdin.end(frame);
  });
}

test("actual permissioned worker rejects owned invalid SDK hash without evaluating code; unpermissioned launch rejects context", async () => {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "owned-bytes-worker-")));
  let cleanupConfirmed = true;
  try {
    const sdk = path.join(dir, "sdk.mjs"); await fs.writeFile(sdk, "throw new Error('MUST_NOT_EVALUATE');"); await fs.writeFile(path.join(dir, "package.json"), '{"type":"module"}');
    const job = metadata(); job.history.sdkPath = sdk; const frame = wire.encodeJob(job, raw), launch = wire.launchOptions(sdk);
    const reply = await runChild(launch, frame); assert.equal(reply.code, 0); assert.equal(reply.errors, 0);
    assert.deepEqual(wire.readResponse(reply.out, job), unavailable("source_sdk_unavailable"));
    // Even a sibling of the granted SDK file is not a source-root grant.
    const sentinel = path.join(dir, "owned-source.jsonl"); await fs.writeFile(sentinel, raw);
    const probe = `const result={}; for(const [key,fn] of Object.entries({read:()=>require('node:fs').readFileSync(${JSON.stringify(sentinel)}),write:()=>require('node:fs').writeFileSync(${JSON.stringify(sentinel)},'forbidden'),child:()=>require('node:child_process').spawnSync(process.execPath,[])})){try{fn();result[key]='allowed';}catch(e){result[key]=e.code;}}process.stdout.write(JSON.stringify(result));`;
    const denied = await runChild({ ...launch, args: [...launch.args.slice(0, -1), "-e", probe] }, Buffer.alloc(0));
    assert.equal(denied.code, 0); assert.equal(denied.errors, 0);
    assert.deepEqual(JSON.parse(denied.out), { read: "ERR_ACCESS_DENIED", write: "ERR_ACCESS_DENIED", child: "ERR_ACCESS_DENIED" });
    assert.deepEqual(await fs.readFile(sentinel), raw);
    const open = await runChild({ ...launch, args: [launch.args.at(-1)] }, frame); assert.notEqual(open.code, 0); assert.equal(open.out.length, 0); assert.equal(open.errors, 0);
  } catch (error) { if (error.cleanupUnconfirmed) cleanupConfirmed = false; throw error; }
  finally { if (cleanupConfirmed) await fs.rm(dir, { recursive: true, force: true }); }
});
