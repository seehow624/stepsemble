"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");
const { createNativeHelper } = require("../protocol/native/claude/history-native-helper");
const wire = require("../protocol/native/codex/paginated-resolution-wire");

const threadId = "01234567-89ab-4def-8123-456789abcdef";
const inputPath = "sessions/2026/01/05/rollout-2026-01-05T12-00-00-01234567-89ab-4def-8123-456789abcdef.jsonl";
const input = () => ({ nativeVersion: wire.VERSION, codexRoot: path.resolve("owned-codex"), expectedRoot: { device: "1", inode: "10" },
  threadId, selectedRolloutId: threadId, entries: [{ rolloutId: threadId,
    base64Record: Buffer.from(JSON.stringify({ ordinal: 0, type: "session_meta", payload: { id: threadId, history_mode: "paginated" } }) + "\n").toString("base64"),
    rolloutPath: inputPath }] });

function result() {
  const source = { rolloutId: threadId, rolloutPath: inputPath, compressed: false, archived: false,
    endOrdinalExclusive: null, endByteOffset: null };
  const plan = { profile: "codex_paginated_chain_plan_v1", threadId, sources: [source], reachedRoot: true,
    chainByteBudget: 256 * 1024 * 1024, chainDecodedByteBudget: 256 * 1024 * 1024,
    sourceAuthenticated: false, historyComplete: false };
  return { kind: "native_codex_paginated_resolution", nativeVersion: wire.VERSION, threadId, expectedRoot: { device: "1", inode: "10" }, plan,
    resolution: { profile: "codex_paginated_resolution_v1", threadId, sources: [{ ...source, decodedBytes: "123", storedBytes: "123", recordCount: 2,
      completeLfEndByteOffset: "123", nextOrdinalExclusive: "2" }],
      chainStoredBytes: "123", chainDecodedBytes: "123", ordinalCutoffsVerified: true, reachedRoot: true,
      sourceAuthenticated: false, historyComplete: false }, sourceAuthenticated: false, publishable: false, historyComplete: false };
}

function frame(job, value = result()) {
  const header = Buffer.from(JSON.stringify({ protocolVersion: wire.PROTOCOL_VERSION, nonce: job.nonce, result: value }));
  return Buffer.concat([Buffer.from([header.length >>> 24, header.length >>> 16 & 255, header.length >>> 8 & 255, header.length & 255]), header]);
}

function harness(t) {
  const children = [];
  const helper = createNativeHelper({ executablePath: process.execPath, trustBoundary: "host_managed_executable", platform: "linux", deadlineMs: 1000, cleanupMs: 20,
    spawnChild(_executable, args, options) {
      assert.deepEqual(args, []); assert.deepEqual(options.env, { LANG: "C", LC_ALL: "C" });
      const child = new EventEmitter(); child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kills = 0;
      child.stdin.on("data", chunk => { child.job = JSON.parse(chunk); });
      child.reply = value => { child.stdout.write(frame(child.job, value)); child.close(); };
      child.close = (code = 0, signal = null) => child.emit("close", code, signal);
      child.kill = () => { child.kills++; queueMicrotask(() => child.close(null, "SIGKILL")); return true; };
      children.push(child); return child;
    } });
  t.after(() => { for (const child of children) child.close(); return helper.shutdown(); });
  return { helper, children };
}

test("protocol 15 strictly accepts a resolved oldest-first chain and creates a stable fence", () => {
  const request = input(), job = { protocolVersion: 15, nonce: "a".repeat(64), nativeVersion: wire.VERSION,
    threadId, selectedRolloutId: threadId, expectedRoot: request.expectedRoot }, value = result();
  const decoded = wire.decode(value, Buffer.alloc(0), job);
  assert.equal(decoded.cleanupConfirmed, true);
  assert(wire.validResolvedEvidence(decoded.resolution.sources[0]));
  const version = wire.sourceVersion(decoded);
  assert(wire.validVersion(version)); assert(wire.sameSourceVersion(version, version));
  const changed = structuredClone(decoded); changed.resolution.sources[0].recordCount = 3;
  assert.equal(wire.sameSourceVersion(version, wire.sourceVersion(changed)), false, "a record-count change invalidates the receipt");
  assert.equal(wire.capture(decoded, request).cleanupConfirmed, true);
});

test("protocol 15 rejects malformed input, mismatched plan/resolution and authority flags", () => {
  const base = input();
  for (const value of [null, {}, { ...base, nativeVersion: "latest" }, { ...base, selectedRolloutId: "11111111-1111-4111-8111-111111111111" },
    { ...base, entries: [{ ...base.entries[0], base64Record: "Zh==" }] }, { ...base, entries: [{ ...base.entries[0], rolloutPath: "sessions/2026/02/30/" + inputPath.split("/").at(-1) }] },
    { ...base, entries: [{ ...base.entries[0], rolloutPath: inputPath.replace(threadId, "11111111-1111-4111-8111-111111111111") }] }])
    assert.equal(wire.input(value), false);
  const job = { protocolVersion: 15, nonce: "a".repeat(64), nativeVersion: wire.VERSION, threadId, selectedRolloutId: threadId, expectedRoot: base.expectedRoot };
  for (const mutate of [v => { v.resolution.sources[0].rolloutId = "11111111-1111-4111-8111-111111111111"; },
    v => { v.resolution.chainStoredBytes = "124"; }, v => { v.plan.sourceAuthenticated = true; }, v => { v.resolution.ordinalCutoffsVerified = false; }]) {
    const value = result(); mutate(value); assert.equal(wire.decode(value, Buffer.alloc(0), job), null);
  }
});

test("native helper launches protocol 15 with the full bounded chain request", async t => {
  const h = harness(t), request = input(), pending = h.helper.readCodexPaginatedResolution(request), child = h.children[0];
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(child.job.protocolVersion, wire.PROTOCOL_VERSION); assert.equal(child.job.nativeVersion, wire.VERSION);
  assert.equal(child.job.codexRoot, request.codexRoot); assert.equal(child.job.threadId, threadId);
  assert.equal(child.job.selectedRolloutId, threadId); assert.equal(child.job.source, undefined);
  child.reply(result());
  const value = await pending;
  assert.equal(value.kind, "native_codex_paginated_resolution"); assert.equal(value.cleanupConfirmed, true);
  assert.equal(value.resolution.chainStoredBytes, "123");
});

test("native helper preserves known protocol 15 refusal codes and remains fail-closed", async t => {
  const h = harness(t), pending = h.helper.readCodexPaginatedResolution(input()), child = h.children[0];
  await new Promise(resolve => setImmediate(resolve));
  child.reply({ kind: "source_unavailable", code: "paginated_chain_incomplete" });
  assert.deepEqual(await pending, { kind: "source_unavailable", code: "paginated_chain_incomplete" });
});
