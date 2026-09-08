"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), path = require("node:path"), crypto = require("node:crypto");
const { selectMetadata, validMetadata } = require("../protocol/native/claude/history-metadata");
const { processJob } = require("../protocol/native/claude/history-bytes-worker");
const wire = require("../protocol/native/claude/history-bytes-wire");
const sessionId = "11111111-1111-4111-8111-111111111111", otherId = "22222222-2222-4222-8222-222222222222";
const records = [{ type: "user", sessionId, uuid: otherId, parentUuid: null, message: { role: "user", content: "Synthetic first prompt" } }];
const bytes = Buffer.from(JSON.stringify(records[0]) + "\n");
const source = { kind: "native_source_bytes", sessionId, byteLength: bytes.length, sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
  identity: { device: "1", inode: "2", size: bytes.length, mtimeNs: "3", ctimeNs: "4" }, checks: { owner: "posix_euid_and_mode",
    acl: "no_extended_acl", containment: "root_identity_and_openat_nofollow", reads: 2, matchingBytes: true, unchangedObservedIdentity: true },
  sourceAuthenticated: false, publishable: false };
const snapshot = () => ({ ...structuredClone(source), kind: "source_snapshot", records: structuredClone(records) });
const job = () => ({ protocolVersion: 3, nonce: "a".repeat(64), snapshot: structuredClone(source),
  request: { bindingId: otherId, generation: 1, requestId: sessionId }, history: { sdkPath: path.resolve("owned-sdk/sdk.mjs"), expectedVersion: null } });
const unavailable = code => ({ kind: "source_unavailable", code });
const key = (id, options) => ({ sessionId: id, projectKey: options.dir.replace(/[^a-zA-Z0-9]/g, "-") });
const reader = info => async (id, options) => { await options.sessionStore.load(key(id, options)); return info; };

test("metadata reads one disposable snapshot; custom title and SDK summary remain separate inert values", async () => {
  const original = snapshot(), before = structuredClone(original);
  const result = await selectMetadata(original, async (id, options) => {
    assert.equal(id, sessionId); assert.deepEqual(Object.keys(options).sort(), ["dir", "sessionStore"]);
    const loaded = await options.sessionStore.load(key(id, options)); loaded[0].message.content = "SDK disposable mutation";
    return { sessionId, customTitle: "原本的對話 🐾 <script>alert(1)</script>", summary: "Summary is not a title", cwd: "/private/not-returned", gitBranch: "secret" };
  });
  assert.deepEqual(original, before); assert.deepEqual(result.source, source);
  assert.equal(result.metadata.nativeTitle, "原本的對話 🐾 <script>alert(1)</script>"); assert.equal(result.metadata.titleStatus, "native");
  assert.equal(result.metadata.summary, "Summary is not a title"); assert.equal(validMetadata(result.metadata, sessionId), true);
  assert.equal(JSON.stringify(result).includes("not-returned"), false); assert.equal(Object.hasOwn(result, "records"), false);
});

test("summary, firstPrompt, UUID and file name are never substituted for a missing native title", async () => {
  for (const info of [undefined, null, { sessionId }, { sessionId, customTitle: "", summary: "" },
    { sessionId, summary: "Original first prompt", firstPrompt: "prompt", filename: "2026-session.jsonl" }]) {
    const result = await selectMetadata(snapshot(), reader(info));
    assert.equal(result.metadata.nativeTitle, null); assert.equal(result.metadata.titleStatus, "untitled");
    assert.equal(result.metadata.summary, info?.summary || null);
  }
});

test("out-of-scope, repeated, unused or writable snapshot access refuses metadata even if SDK swallows the error", async () => {
  for (const action of [async () => {}, async (id, o) => o.sessionStore.load({ ...key(id, o), sessionId: otherId }),
    async (id, o) => o.sessionStore.load({ ...key(id, o), projectKey: "-private" }),
    async (id, o) => o.sessionStore.load({ ...key(id, o), file: "/private" }),
    async (id, o) => { await o.sessionStore.load(key(id, o)); await o.sessionStore.load(key(id, o)); },
    async (id, o) => { await o.sessionStore.load(key(id, o)); await o.sessionStore.append({}); }]) {
    await assert.rejects(selectMetadata(snapshot(), async (id, o) => { try { await action(id, o); } catch {} return { sessionId, customTitle: "forbidden" }; }), /snapshot_store_scope/);
  }
  for (const info of [{ sessionId: otherId }, "wrong shape", false]) await assert.rejects(selectMetadata(snapshot(), reader(info)), /snapshot_store_scope/);
});

test("metadata rejects wrong types, controls and oversized title/summary instead of silently inventing a title", async () => {
  for (const bad of [false, 0, [], {}, "\u0000", "\u001b[1m", "x".repeat(1025)]) {
    assert.deepEqual(await selectMetadata(snapshot(), reader({ sessionId, customTitle: bad })), unavailable("source_metadata_invalid"));
  }
  for (const bad of [false, 0, [], "\u007f", "s".repeat(4097)])
    assert.deepEqual(await selectMetadata(snapshot(), reader({ sessionId, summary: bad })), unavailable("source_metadata_invalid"));
  assert.equal((await selectMetadata(snapshot(), reader({ sessionId, customTitle: "t".repeat(1024), summary: "s".repeat(4096) }))).kind, "source_session_metadata");
});

test("v3 operation explicitly requests only getSessionInfo and has no page/path/flag expansion", async () => {
  const request = job(); assert.deepEqual(wire.readJob(wire.encodeJob(request, bytes)), { job: request, bytes });
  let loads = 0;
  const result = await processJob(request, bytes, { loadReader: async (sdkPath, method) => {
    loads++; assert.equal(sdkPath, request.history.sdkPath); assert.equal(method, "getSessionInfo"); return reader({ sessionId, customTitle: "Original" });
  } });
  assert.equal(loads, 1); assert.equal(result.metadata.nativeTitle, "Original");
  assert.deepEqual(wire.readResponse(wire.encodeResponse(result, request), request), result);
  for (const change of [v => { v.history.page = { offset: 0, limit: 1 }; }, v => { v.history.method = "query"; },
    v => { v.protocolVersion = 2; }, v => { v.protocolVersion = 4; }, v => { v.snapshot.projectsRoot = "/private"; }]) {
    const altered = job(); change(altered);
    assert.equal(wire.encodeJob(altered, bytes), null);
    assert.deepEqual(await processJob(altered, bytes, { loadReader: async () => { loads++; } }), unavailable("source_worker_protocol"));
  }
  assert.equal(loads, 1);
});

test("v3 response fences operation, source identity, session, pin, shape and correlation before publication", async () => {
  const request = job(), result = await selectMetadata(snapshot(), reader({ sessionId, customTitle: "Native" }));
  const encode = result => Buffer.from(JSON.stringify({ protocolVersion: 3, nonce: request.nonce, request: request.request, result }) + "\n");
  for (const change of [r => { r.kind = "source_history_observation"; }, r => { r.metadata.sessionId = otherId; },
    r => { r.source.sessionId = otherId; }, r => { r.source.identity.inode = "9"; }, r => { r.source.sha256 = "f".repeat(64); },
    r => { r.source.publishable = true; }, r => { r.reader.sdkSha256 = "f".repeat(64); }, r => { r.reader.sdkVersion = "future"; },
    r => { r.metadata.titleStatus = "not_loaded"; }, r => { r.metadata.path = "/private"; }, r => { r.records = records; }]) {
    const altered = structuredClone(result); change(altered); assert.equal(wire.readResponse(encode(altered), request), null);
  }
  for (const change of [r => { r.protocolVersion = 2; r.history.page = { offset: 0, limit: 1 }; }, r => { r.nonce = "b".repeat(64); },
    r => { r.request.requestId = otherId; }, r => { r.request.generation++; }]) {
    const altered = job(); change(altered); assert.equal(wire.readResponse(encode(result), altered), null);
  }
  const changed = job(); changed.history.expectedVersion = wire.sourceVersion(source); changed.history.expectedVersion.identity.inode = "9";
  assert.deepEqual(wire.readResponse(encode(result), changed), unavailable("source_version_changed"));
});
