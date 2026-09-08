const crypto = require("node:crypto"), path = require("node:path");
const { richRecords } = require("./history-fixture");
const { sourceVersion } = require("./source-wire");
const id = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", root = path.resolve("owned-codex-pipeline");
const locator = `sessions/2026/01/05/rollout-2026-01-05T12-00-00-${id}.jsonl`;
const request = () => ({ nativeVersion: "0.153.4", source: { codexRoot: root, rolloutPath: locator, threadId: id }, expectedRoot: { device: "1", inode: "2" } });
const sha = b => crypto.createHash("sha256").update(b).digest("hex");
function captured(index = Buffer.from(JSON.stringify({ id, thread_name: "  原生候選 🐾  ", updated_at: "x" }) + "\n"), workdir = root) {
  const raw = Buffer.from([{ type: "session_meta", payload: { id, history_mode: "legacy" } }, ...richRecords(workdir)].map(v => JSON.stringify(v)).join("\r\n") + "\r\n");
  const desc = (b, inode, byteOffset) => ({ byteOffset, byteLength: b.length, sha256: sha(b), identity: { device: "1", inode, size: b.length, mtimeNs: "1", ctimeNs: "2" } });
  return { kind: "native_codex_source_bytes", nativeVersion: "0.153.4", threadId: id, rolloutPath: locator, rootIdentity: { device: "1", inode: "2" },
    byteLength: raw.length + (index?.length ?? 0), sha256: sha(Buffer.concat([raw, index ?? Buffer.alloc(0)])), rollout: desc(raw, "3", 0), nameIndex: index === null ? null : desc(index, "4", raw.length),
    checks: { owner: "posix_euid_and_mode", acl: "no_extended_acl", containment: "root_identity_and_openat_nofollow", reads: 2, matchingBytes: true,
      unchangedObservedIdentity: true, nameIndexPresenceRechecked: true }, sourceAuthenticated: false, publishable: false, cleanupConfirmed: true,
    rolloutBytes: raw, nameIndexBytes: index };
}
const job = (capture = captured(), selection = { mode: "records", offset: 0, limit: 2 }) => ({ protocolVersion: 1, nonce: "a".repeat(64), source: sourceVersion(capture), selection, expectedVersion: null });
const sqlFixture = require("./sqlite-fixture.cjs").context;
const namedRequest = () => ({ history: request(), sqlite: sqlFixture.request(), method: "thread_read_sqlite" });
function sqliteCapture(change = () => {}) {
  const body = sqlFixture.body(); body.observation.nameContext.rolloutPath = path.join(root, locator);
  change(body.observation); return sqlFixture.capture(body);
}
function namedJob(capture = captured(), selection = { mode: "names" }, sql = sqliteCapture(), method = "thread_read_sqlite") {
  return { ...job(capture, selection), protocolVersion: 2, nameResolution: { fields: sql.metadata.observation.fields,
    nameContext: sql.metadata.observation.nameContext, method, rolloutPath: path.join(root, locator) } };
}
function withRollout(records, index) {
  const c = captured(index), raw = Buffer.from(records.map(v => typeof v === "string" ? v : JSON.stringify(v)).join("\n") + "\n");
  c.rolloutBytes = raw; Object.assign(c.rollout, { byteLength: raw.length, sha256: sha(raw) }); c.rollout.identity.size = raw.length;
  if (c.nameIndex) c.nameIndex.byteOffset = raw.length;
  c.byteLength = raw.length + (c.nameIndexBytes?.length ?? 0); c.sha256 = sha(Buffer.concat([raw, c.nameIndexBytes ?? Buffer.alloc(0)]));
  return c;
}
module.exports = { id, root, request, captured, job, sha, namedRequest, sqliteCapture, namedJob, withRollout };
