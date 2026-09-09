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
function structuredCaptured(index, workdir = root) {
  const c = withRollout([{ type: "session_meta", payload: { id, history_mode: "legacy", cli_version: "0.153.4" } }, ...richRecords(workdir)], index);
  c.storage = { encoding: "jsonl", rolloutPath: c.rolloutPath }; c.checks.rolloutSelectionRechecked = true;
  return c;
}
function pageCaptured(offset = 0, limit = 2, base = structuredCaptured()) {
  const rows = [], bytes = base.rolloutBytes; let start = 0;
  for (let end = 0; end < bytes.length; end++) if (bytes[end] === 10) { rows.push({ start, end: end + 1 }); start = end + 1; }
  const records = []; let size = 0;
  for (let i = offset; i < rows.length && records.length < limit; i++) {
    const row = rows[i], b = bytes.subarray(row.start, row.end);
    if (size + b.length > 256 * 1024) break;
    records.push({ recordIndex: i, byteOffset: row.start, byteLength: b.length, payloadOffset: size, sha256: sha(b) }); size += b.length;
  }
  const pageBytes = records.length ? Buffer.from(bytes.subarray(rows[offset].start, rows[offset].start + size)) : Buffer.alloc(0);
  const index = base.nameIndexBytes, body = Buffer.concat([pageBytes, index ?? Buffer.alloc(0)]);
  return { kind: "native_codex_validated_source_page", nativeVersion: base.nativeVersion, threadId: base.threadId, rolloutPath: base.rolloutPath,
    rootIdentity: base.rootIdentity, storage: { encoding: "jsonl", rolloutPath: base.rolloutPath }, byteLength: body.length, sha256: sha(body),
    rollout: { identity: base.rollout.identity, sha256: base.rollout.sha256, recordCount: rows.length },
    page: { offset, byteLength: size, records, nextOffset: offset + records.length === rows.length ? null : offset + records.length },
    nameIndex: base.nameIndex === null ? null : { ...base.nameIndex, byteOffset: size },
    validation: { profile: "codex_legacy_envelope_v1", recordsValidated: rows.length, selectedMetadataRecord: 0, metadataRecords: 1, historyMode: "legacy" },
    checks: { owner: "posix_euid_and_mode", acl: "no_extended_acl", containment: "root_identity_and_openat_nofollow", reads: 2,
      matchingRolloutDigests: true, matchingNameIndexBytes: true, unchangedObservedIdentity: true, nameIndexPresenceRechecked: true, rolloutSelectionRechecked: true },
    recordSemanticsValidated: false, sourceAuthenticated: false, publishable: false, semanticHistoryComplete: false,
    pageBytes, nameIndexBytes: index, cleanupConfirmed: true };
}
function pageJob(capture = pageCaptured(), selection = { mode: "records", offset: capture.page.offset, limit: 2 }, named = false, sql = sqliteCapture()) {
  const base = named ? namedJob(undefined, selection, sql) : job(undefined, selection);
  return { ...base, protocolVersion: named ? 8 : 7, source: require("./scanned-source-wire").sourceVersion(capture), page: capture.page };
}
module.exports = { id, root, request, captured, job, sha, namedRequest, sqliteCapture, namedJob, withRollout, structuredCaptured, pageCaptured, pageJob };
