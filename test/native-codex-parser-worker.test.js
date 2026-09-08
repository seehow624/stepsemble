"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), { spawn, execFile } = require("node:child_process"), { promisify } = require("node:util");
const { Readable } = require("node:stream");
const wire = require("../protocol/native/codex/parser-wire"), worker = require("../protocol/native/codex/parser-worker");
const fixture = require("../protocol/native/codex/parser-fixture.cjs");
const source = require("../protocol/native/codex/source-wire");
const frame = (job, bytes) => { const h = Buffer.from(JSON.stringify(job)), n = Buffer.alloc(4); n.writeUInt32BE(h.length); return Buffer.concat([n, h, bytes]); };
function prepared(selection) {
  const capture = fixture.captured(), job = fixture.job(capture, selection), encoded = wire.encodeJob(job, capture), parsed = wire.readJob(encoded);
  return { capture, job, encoded, parsed, result: worker.processJob(parsed.job, parsed.bytes) };
}
test("Codex parser keeps names and raw records in one captured version without leaking a process-local snapshot handle", () => {
  const { capture, job, parsed, result } = prepared();
  assert.equal(result.kind, "codex_parsed_capture"); assert.equal(result.index.readCandidate, "  原生候選 🐾  "); assert.equal(result.index.listCandidate, "原生候選 🐾");
  assert.equal(result.page.records.length, 2); assert.equal(Object.hasOwn(result.page, "snapshotId"), false);
  assert.equal(result.page.records[0].rawText, capture.rolloutBytes.toString().split("\r\n")[0] + "\r\n");
  assert.equal(source.sameSourceVersion(result.source, job.source), true); assert.equal(result.publishable, false); assert.equal(result.semanticHistoryComplete, false);
  assert.deepEqual(wire.readResponse(wire.encodeResponse(result, job), job, parsed.bytes), result);
  const names = prepared({ mode: "names" }); assert.equal(names.result.page, null); assert.equal(names.result.index.nativeTitleResolved, false);
});
test("worker pages round trip all captured records, preserving command/image events and stable content digests", () => {
  const capture = fixture.captured(), records = []; let offset = 0;
  do {
    const job = fixture.job(capture, { mode: "records", offset, limit: 2 }), parsed = wire.readJob(wire.encodeJob(job, capture));
    const result = worker.processJob(parsed.job, parsed.bytes), response = wire.readResponse(wire.encodeResponse(result, job), job, parsed.bytes);
    assert.equal(response.kind, "codex_parsed_capture"); records.push(...response.page.records); offset = response.page.nextOffset;
  } while (offset !== null);
  assert.equal(records.map(r => r.rawText).join(""), capture.rolloutBytes.toString());
  assert.equal(records.filter(r => ["exec_command_begin", "exec_command_end", "view_image_tool_call"].includes(r.payloadType)).length, 3);
});
test("binary input rejects segment substitution, unknown fields, extra bytes and stale versions before parsing", () => {
  const { job, parsed, encoded, capture } = prepared();
  assert.equal(encoded.subarray(4, 4 + encoded.readUInt32BE(0)).includes(Buffer.from(fixture.root)), false, "no absolute source-reading path in worker header");
  assert.equal(parsed.bytes.includes(Buffer.from(fixture.root)), true, "transcript paths remain inert bytes, never read grants");
  for (const change of [v => { v.protocolVersion = 2; }, v => { v.nonce = "bad"; }, v => { v.path = "private"; },
    v => { v.selection.limit = 51; }, v => { v.source.nativeVersion = "latest"; }, v => { v.selection = { mode: "names", offset: 0 }; }]) {
    const bad = structuredClone(job); change(bad); assert.equal(wire.readJob(frame(bad, parsed.bytes)), null);
  }
  const corrupt = Buffer.from(encoded); corrupt[corrupt.length - 2] ^= 1;
  for (const bytes of [corrupt, encoded.subarray(0, -1), Buffer.concat([encoded, Buffer.from("x")]), Buffer.from([255, 255, 255, 255, 1])]) assert.equal(wire.readJob(bytes), null);
  const stale = structuredClone(job); stale.expectedVersion = structuredClone(job.source); stale.expectedVersion.nameIndex.identity.inode = "8";
  assert.equal(worker.processJob(stale, parsed.bytes).code, "source_version_changed");
  capture.nameIndexBytes.fill(0); assert.equal(wire.readJob(wire.encodeJob(job, capture)), null, "child rejects bytes changed after capture");
});
test("capture byte accessors are not executed and forged cleanup, shared buffers or mismatched lengths refuse encoding", () => {
  const good = fixture.captured(), job = fixture.job(good); let calls = 0;
  const getter = fixture.captured(); Object.defineProperty(getter, "rolloutBytes", { enumerable: true, get() { calls++; return good.rolloutBytes; } });
  assert.equal(wire.encodeJob(job, getter), null); assert.equal(calls, 0);
  for (const mutate of [v => { v.cleanupConfirmed = false; }, v => { v.rolloutBytes = Buffer.alloc(1); },
    v => { v.nameIndexBytes = Buffer.from(new SharedArrayBuffer(v.nameIndexBytes.length)); }, v => { v.nameIndexBytes = null; }]) {
    const bad = fixture.captured(); mutate(bad); assert.equal(wire.encodeJob(job, bad), null);
  }
});
test("responses bind nonce, source, shape, ranges and exact captured record bytes, never authority flags or private diagnostics", () => {
  const { job, parsed, result } = prepared();
  for (const mutate of [v => { v.nonce = "b".repeat(64); }, v => { v.result.publishable = true; },
    v => { v.result.source.rollout.identity.inode = "9"; }, v => { v.result.index.nativeTitleResolved = true; },
    v => { v.result.index.extra = "private"; }, v => { v.result.page.records[0].recordIndex++; },
    v => { v.result.page.records[0].byteOffset++; }, v => { v.result.page.nextOffset++; },
    v => { const r = v.result.page.records[0]; r.rawText = r.rawText.replace("legacy", "xxxxxx"); r.sha256 = fixture.sha(Buffer.from(r.rawText)); },
    v => { v.result = { kind: "source_unavailable", code: "private native error" }; }]) {
    const value = { protocolVersion: 1, nonce: job.nonce, result: structuredClone(result) }; mutate(value);
    assert.equal(wire.readResponse(Buffer.from(JSON.stringify(value) + "\n"), job, parsed.bytes), null);
  }
  const valid = wire.encodeResponse(result, job);
  for (const bad of [valid.subarray(0, -1), Buffer.concat([valid, valid]), Buffer.concat([Buffer.from([239, 187, 191]), valid])]) assert.equal(wire.readResponse(bad, job, parsed.bytes), null);
});
test("source failure modes and wrong rollout selection stay unavailable, not empty successful history", () => {
  const { job, parsed } = prepared();
  for (const [value, code] of [[null, null], [Buffer.alloc(0), null], [Buffer.from([255]), "name_index_invalid_utf8"]]) {
    const capture = fixture.captured(value), j = fixture.job(capture, { mode: "names" }), p = wire.readJob(wire.encodeJob(j, capture)), r = worker.processJob(j, p.bytes);
    if (code) assert.equal(r.code, code); else assert.equal(r.index.presence, value === null ? "missing" : "empty");
  }
  const changed = Buffer.from(parsed.bytes), text = changed.subarray(0, job.source.rollout.identity.size).toString().replace(fixture.id, "00000000-0000-4000-8000-000000000000");
  Buffer.from(text).copy(changed); const j = structuredClone(job); j.source.rollout.sha256 = fixture.sha(changed.subarray(0, j.source.rollout.identity.size));
  assert.equal(worker.processJob(j, changed).code, "rollout_selected_thread_mismatch");
  const outOfRange = structuredClone(job); outOfRange.selection.offset = 8192;
  assert.equal(worker.processJob(outOfRange, parsed.bytes).code, "invalid_rollout_page");
  for (const [mode, code] of [["paginated", "native_paginated_history_unsupported"], ["future", "native_history_mode_unknown"]]) {
    const raw = Buffer.from(parsed.bytes.subarray(0, job.source.rollout.identity.size).toString().replace('"history_mode":"legacy"', `"history_mode":"${mode}"`));
    const selected = structuredClone(job); selected.selection = { mode: "names" }; selected.source.rollout.identity.size = raw.length; selected.source.rollout.sha256 = fixture.sha(raw);
    assert.equal(worker.processJob(selected, Buffer.concat([raw, parsed.bytes.subarray(job.source.rollout.identity.size)])).code, code);
  }
});
test("bounded stdin refuses oversized header and excess chunks without a partial result", async () => {
  const { encoded } = prepared(); assert.equal((await worker.readInput(Readable.from([encoded]))).job.protocolVersion, 1);
  await assert.rejects(worker.readInput(Readable.from([Buffer.from([255, 255, 255, 255])])), /parser_input_header/);
  await assert.rejects(worker.readInput(Readable.from(Array(4097).fill(Buffer.alloc(0)))), /parser_input_limit/);
  await assert.rejects(worker.readInput(Readable.from([encoded.subarray(0, -1)])), /parser_input_frame/);
});
test("actual permissioned Node worker parses owned bytes and exits with no diagnostic output", async () => {
  const { encoded, job, parsed } = prepared(), launch = wire.launchOptions();
  const result = await new Promise((resolve, reject) => {
    const child = spawn(launch.executable, launch.args, launch.options), out = [], errors = [];
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(Error("owned parser timeout")); }, 10000);
    child.on("error", reject); child.stdout.on("data", v => out.push(v)); child.stderr.on("data", v => errors.push(v));
    child.on("close", (code, signal) => { clearTimeout(timer); resolve({ code, signal, out: Buffer.concat(out), errors: Buffer.concat(errors) }); });
    child.stdin.end(encoded);
  });
  assert.equal(result.code, 0, result.errors.toString()); assert.equal(result.signal, null); assert.equal(result.errors.length, 0);
  assert.equal(wire.readResponse(result.out, job, parsed.bytes).kind, "codex_parsed_capture");
});
test("parser launch strips inherited routes and denies broad source reads, writes and child execution", async () => {
  const launch = wire.launchOptions(); assert.deepEqual(launch.options.env, { LANG: "C", LC_ALL: "C" }); assert.equal(launch.options.shell, false);
  assert.equal(launch.args.some(v => v.includes(fixture.root)), false); assert.equal(worker.validContext(undefined), false);
  const { stdout } = await promisify(execFile)(launch.executable, [...launch.args.slice(0, -1), "-e",
    'const fs=require("node:fs"),cp=require("node:child_process");for(const call of [()=>fs.readFileSync("/owned-denied-source"),()=>fs.writeFileSync("/owned-denied-target","x"),()=>cp.spawnSync(process.execPath,["--version"])]){try{call();throw Error("permission_not_denied")}catch(e){if(e.code!=="ERR_ACCESS_DENIED")throw e}}process.stdout.write("denied")'],
  { ...launch.options, timeout: 10000, maxBuffer: 65536 }); assert.equal(stdout, "denied");
});
