"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), { spawn } = require("node:child_process"), z = require("node:zlib");
const path = require("node:path");
const f = require("../protocol/native/codex/parser-fixture.cjs"), wire = require("../protocol/native/codex/parser-wire"), worker = require("../protocol/native/codex/parser-worker");
function fixture(named = false, compressed = false, selection = { mode: "records", offset: 0, limit: 50 }) {
  const c = f.structuredCaptured();
  if (compressed) {
    const raw = c.rolloutBytes, enc = value => z.zstdCompressSync(value, { pledgedSrcSize: value.length, params: { [z.constants.ZSTD_c_checksumFlag]: 1 } });
    c.rolloutBytes = Buffer.concat([enc(raw.subarray(0, 41)), enc(raw.subarray(41))]); c.storage.encoding = "zstd"; c.storage.rolloutPath += ".zst";
    c.rollout.byteLength = c.rollout.identity.size = c.rolloutBytes.length; c.rollout.sha256 = f.sha(c.rolloutBytes);
    c.nameIndex.byteOffset = c.rolloutBytes.length; c.byteLength = c.rolloutBytes.length + c.nameIndexBytes.length; c.sha256 = f.sha(Buffer.concat([c.rolloutBytes, c.nameIndexBytes]));
  }
  const job = { ...(named ? f.namedJob(c, selection) : f.job(c, selection)), protocolVersion: named ? 6 : 5 };
  const frame = wire.encodeJob(job, c); assert(frame); const parsed = wire.readJob(frame); assert(parsed);
  return { c, job, frame, bytes: parsed.bytes, result: worker.processJob(job, parsed.bytes) };
}
function response(result, job) { return Buffer.from(JSON.stringify({ protocolVersion: job.protocolVersion, nonce: job.nonce, result }) + "\n"); }
test("v5/v6 require stored source and explicit record selection; prior versions cannot accept structural output", () => {
  for (const named of [false, true]) {
    const { c, job, result, bytes } = fixture(named);
    assert.equal(result.kind, "codex_parsed_capture"); assert.equal(result.structure.totalTurns, 1);
    assert.equal(result.structure.turns[0].nativeTurnId, "fixture-rich-turn"); assert.equal(result.page.records.length, 16);
    assert.equal(result.page.snapshotId, undefined); assert.equal(result.structure.snapshotId, undefined);
    assert.deepEqual(wire.readResponse(wire.encodeResponse(result, job), job, bytes), result);
    assert.equal(wire.encodeJob({ ...job, selection: { mode: "names" } }, c), null);
    const noStorage = structuredClone(job); delete noStorage.source.storage; assert.equal(wire.validJob(noStorage), false);
    const oldJob = { ...job, protocolVersion: named ? 4 : 3 };
    assert.equal(wire.readResponse(response(result, oldJob), oldJob, bytes), null);
    const stripped = structuredClone(result); delete stripped.structure; assert.equal(wire.readResponse(response(stripped, job), job, bytes), null);
  }
});
test("plain and concatenated compressed structural pages preserve all raw bytes, names, context and late-page associations", () => {
  for (const compressed of [false, true]) {
    const rows = [], annotations = []; let offset = 0;
    do {
      const { job, result, bytes } = fixture(true, compressed, { mode: "records", offset, limit: 2 });
      assert.equal(result.kind, "codex_parsed_capture", result.code); assert.equal(result.name.name, "原生候選 🐾");
      assert(wire.readResponse(response(result, job), job, bytes));
      rows.push(...result.page.records); annotations.push(...result.structure.annotations); offset = result.page.nextOffset;
    } while (offset !== null);
    assert.equal(rows.map(r => r.rawText).join(""), f.structuredCaptured().rolloutBytes.toString());
    assert.equal(annotations[5].tool.relatedRecordIndex, 6); assert.equal(annotations[6].tool.relatedRecordIndex, 5);
  }
});
test("structural wire rejects forged flags, shapes, counts, references, statuses and inconsistent same-page tool pairs", () => {
  const { job, result, bytes } = fixture(true);
  for (const change of [
    r => { r.sourceAuthenticated = true; }, r => { r.structure.profile = "native_authenticated"; }, r => { r.structure.totalTurns = -1; },
    r => { r.structure.retainedTurns = 2; }, r => { r.structure.retainedTurns = 0; }, r => { r.structure.extra = true; }, r => { r.structure.annotations.pop(); },
    r => { r.structure.annotations[0].recordIndex = 100; }, r => { r.structure.annotations[0].kind = "script"; },
    r => { r.structure.annotations[1].turnKey = "record-9999"; }, r => { r.structure.annotations[1].warnings.push("raw secret"); },
    r => { r.structure.turns[0].turnKey = "record-0"; }, r => { r.structure.turns[0].nativeTurnId = "x".repeat(1025); }, r => { r.structure.turns[0].nativeTurnId = "\ud800"; },
    r => { r.structure.turns[0].boundary = "inferred"; }, r => { r.structure.turns[0].recordedStatus = "running_now"; },
    r => { r.structure.turns[0].statusRecordIndex = null; }, r => { r.structure.turns[0].lastRecordIndex = 1; },
    r => { r.structure.turns[0].branchState = "deleted"; }, r => { r.structure.turns[0].rollbackRecordIndex = 2; },
    r => { r.structure.annotations[5].tool.relatedRecordIndex = 5; }, r => { r.structure.annotations[5].tool.relatedRecordIndex = 99999; },
    r => { r.structure.annotations[5].tool.relatedRecordIndex = 7; }, r => { r.structure.annotations[5].tool.phase = "approved"; },
    r => { r.structure.annotations[5].tool.nativeCallId = "different"; }, r => { r.structure.annotations[5].tool.family = "shell_direct"; },
  ]) { const bad = structuredClone(result); change(bad); assert.equal(wire.readResponse(response(bad, job), job, bytes), null); }
});
test("near-byte-limit and maximum record-count capture succeeds in the actual 128 MiB permissioned worker", async () => {
  const c = f.withRollout([{ type: "session_meta", payload: { id: f.id, history_mode: "legacy", cli_version: "0.153.4" } },
    ...Array.from({ length: 8191 }, (_, i) => ({ type: "event_msg", payload: { type: "user_message", message: `owned ${i} ${"x".repeat(900)}` } }))]);
  assert(c.rolloutBytes.length > 7 * 1024 * 1024 && c.rolloutBytes.length < 8 * 1024 * 1024);
  c.storage = { encoding: "jsonl", rolloutPath: c.rolloutPath }; c.checks.rolloutSelectionRechecked = true;
  const job = { ...f.job(c, { mode: "records", offset: 8142, limit: 50 }), protocolVersion: 5 }, frame = wire.encodeJob(job, c);
  assert(frame); const input = wire.readJob(frame); assert(input); const launch = wire.launchOptions();
  const result = await new Promise((resolve, reject) => {
    const child = spawn(launch.executable, launch.args, launch.options), chunks = [], errors = [];
    const timer = setTimeout(() => child.kill("SIGKILL"), 15000);
    child.once("error", reject); child.stdout.on("data", b => chunks.push(b)); child.stderr.on("data", b => errors.push(b));
    child.once("close", (code, signal) => { clearTimeout(timer); resolve({ code, signal, bytes: Buffer.concat(chunks), errors: Buffer.concat(errors) }); });
    child.stdin.end(frame);
  });
  assert.equal(result.code, 0); assert.equal(result.signal, null); assert.equal(result.errors.length, 0);
  const value = wire.readResponse(result.bytes, job, input.bytes); assert.equal(value?.kind, "codex_parsed_capture");
  assert.equal(value.structure.totalTurns, 8191); assert.equal(value.structure.retainedTurns, 8191);
  assert.equal(value.structure.turns.length, 50); assert.equal(value.page.endOfFile, true);
  assert(value.structure.turns.every(t => t.nativeTurnId === null && t.recordedStatus === "unknown"));
});
test("permissioned v5/v6 workers parse structure with no source grants, side effects or leaked process-local handles", async () => {
  for (const named of [false, true]) for (const compressed of [false, true]) {
    const { job, frame, bytes } = fixture(named, compressed), launch = wire.launchOptions();
    const structureGrant = `--allow-fs-read=${path.resolve(__dirname, "../protocol/native/codex/rollout-structure.js")}`;
    assert.equal(launch.args.filter(a => a === structureGrant).length, 1);
    assert(launch.args.includes("--permission")); assert.equal(launch.options.shell, false);
    const done = await new Promise((resolve, reject) => {
      const child = spawn(launch.executable, launch.args, launch.options), chunks = [], errors = [];
      const timer = setTimeout(() => child.kill("SIGKILL"), 10000);
      child.on("error", reject); child.stdout.on("data", b => chunks.push(b)); child.stderr.on("data", b => errors.push(b));
      child.on("close", (code, signal) => { clearTimeout(timer); resolve({ code, signal, output: Buffer.concat(chunks), errors: Buffer.concat(errors) }); }); child.stdin.end(frame);
    });
    assert.equal(done.code, 0); assert.equal(done.signal, null); assert.equal(done.errors.length, 0);
    const result = wire.readResponse(done.output, job, bytes); assert.equal(result.kind, "codex_parsed_capture");
    assert.equal(result.structure.totalTurns, 1); assert.equal(result.semanticHistoryComplete, false);
    assert.equal(done.output.includes(Buffer.from("snapshotId")), false);
  }
});
