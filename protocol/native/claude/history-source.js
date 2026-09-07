"use strict";
// Reserved, read-only source boundary. No discovery, repair, retries or model API.
// Caller authorization and authenticated native provenance are separate gates.
const fs = require("node:fs/promises"), { constants } = require("node:fs");
const path = require("node:path"), crypto = require("node:crypto");
const { canonicalJSON } = require("../../../public/modules/projection");
const { classifyRecordScopes } = require("./history-record-scope");
const LIMITS = Object.freeze({ bytes: 8 * 1024 * 1024, lineBytes: 1024 * 1024, records: 2000, chunkBytes: 65536, elapsedMs: 5000 });
const uuid = value => typeof value === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
class SourceFailure extends Error { constructor(code) { super(code); this.sourceCode = code; } }
const fail = code => { throw new SourceFailure(code); };
const reject = code => ({ kind: "source_unavailable", code });
const digest = bytes => crypto.createHash("sha256").update(bytes).digest("hex");

/** Strict whole-file decoding. A newline-less tail is unavailable, even if it
 * happens to parse; never trim a live partial write or discard a bad middle row.
 * Digests bind original bytes (including CRLF), not a reserialized transcript.
 */
function parseHistoryBytes(bytes, sessionId) {
  if (!Buffer.isBuffer(bytes) || !uuid(sessionId)) return reject("invalid_source_input");
  if (bytes.length === 0) return reject("source_empty");
  if (bytes.length > LIMITS.bytes) return reject("source_too_large");
  if (bytes.at(-1) !== 10) return reject("source_incomplete_tail");
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return reject("source_invalid_encoding");
  const records = [], decoder = new TextDecoder("utf-8", { fatal: true });
  let start = 0;
  try {
    for (let end = 0; end < bytes.length; end++) {
      if (end - start > LIMITS.lineBytes) return reject("source_line_too_large");
      if (bytes[end] !== 10) continue;
      if (records.length >= LIMITS.records) return reject("source_too_many_records");
      let line;
      try { line = decoder.decode(bytes.subarray(start, end)); }
      catch { return reject("source_invalid_encoding"); }
      if (!line.trim()) return reject("source_blank_record");
      let row;
      try { row = JSON.parse(line); } catch { return reject("source_invalid_json"); }
      if (canonicalJSON(row, LIMITS.lineBytes) === null) return reject("source_invalid_json_value");
      records.push(row); start = end + 1;
    }
    const scope = classifyRecordScopes(records, sessionId);
    if (scope.kind === "reject") return reject(scope.code.replace(/^native_/, "source_"));
    return { kind: "source_records", sessionId, records, byteLength: bytes.length, sha256: digest(bytes) };
  } catch { return reject("source_invalid_json_value"); }
}

const sameIdentity = (a, b) => ["dev", "ino", "uid", "mode"].every(key => a[key] === b[key]);
const sameVersion = (a, b) => sameIdentity(a, b) && ["size", "mtimeNs", "ctimeNs", "nlink"].every(key => a[key] === b[key]);
function checkNode(stat, uid, directory) {
  if (stat.isSymbolicLink() || !(directory ? stat.isDirectory() : stat.isFile())) fail("source_not_regular_or_linked");
  if (stat.uid !== BigInt(uid) || (stat.mode & 0o022n) !== 0n) fail("source_owner_or_mode");
  if (stat.ino <= 0n || stat.dev < 0n || typeof stat.mtimeNs !== "bigint" || typeof stat.ctimeNs !== "bigint") fail("source_identity_unavailable");
  if (!directory && stat.nlink !== 1n) fail("source_hardlinked");
}

/** io/platform/uid/now are trusted in-process dependencies for deterministic
 * tests, never request parameters. One flight remains occupied until all IO and
 * descriptor cleanup settle. A timeout cannot cancel a kernel filesystem call.
 */
function createSourceReader({ io = fs, platform = process.platform, uid = process.geteuid?.(), now = Date.now } = {}) {
  let busy = false, quarantined = false;
  return async function capture(input) {
    const json = canonicalJSON(input, 8192);
    if (json === null) return reject("invalid_source_input");
    const value = JSON.parse(json);
    if (!value || typeof value !== "object" || Array.isArray(value)
      || Object.keys(value).sort().join(",") !== "projectKey,projectsRoot,sessionId"
      || typeof value.projectsRoot !== "string" || !path.isAbsolute(value.projectsRoot)
      || value.projectsRoot.includes("\0") || typeof value.projectKey !== "string"
      || !/^[A-Za-z0-9_-]{1,255}$/.test(value.projectKey) || !uuid(value.sessionId)) return reject("invalid_source_input");
    // Node uid/mode are not a Windows ACL check. Do not weaken this branch.
    if (!["darwin", "linux"].includes(platform) || !Number.isSafeInteger(uid) || uid < 0
      || typeof constants.O_NOFOLLOW !== "number" || typeof constants.O_NONBLOCK !== "number") return reject("source_platform_unsupported");
    if (quarantined) return reject("source_reader_quarantined");
    if (busy) return reject("source_busy");
    busy = true; let handle = null, result, sourceObserved = false;
    const deadline = now() + LIMITS.elapsedMs;
    const budget = () => { if (now() >= deadline) fail("source_read_budget"); };
    const stat = async filename => { budget(); const value = await io.lstat(filename, { bigint: true }); budget(); return value; };
    try {
      // Canonicalize trusted root aliases (e.g. macOS /var -> /private/var).
      // The root itself and the project/file entries may not be symlinks.
      const suppliedRoot = await stat(value.projectsRoot); checkNode(suppliedRoot, uid, true);
      budget(); const root = await io.realpath(value.projectsRoot); budget();
      const rootBefore = await stat(root); checkNode(rootBefore, uid, true);
      if (!sameIdentity(suppliedRoot, rootBefore)) fail("source_changed");
      const project = path.join(root, value.projectKey), filename = path.join(project, `${value.sessionId}.jsonl`);
      const projectBefore = await stat(project); checkNode(projectBefore, uid, true);
      budget(); if (await io.realpath(project) !== project) fail("source_not_regular_or_linked"); budget();
      const fileBefore = await stat(filename); checkNode(fileBefore, uid, false);
      sourceObserved = true;
      if (fileBefore.size === 0n) fail("source_empty");
      if (fileBefore.size > BigInt(LIMITS.bytes)) fail("source_too_large");
      budget(); handle = await io.open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); budget();
      const opened = await handle.stat({ bigint: true }); checkNode(opened, uid, false);
      if (!sameVersion(fileBefore, opened)) fail("source_changed");
      const size = Number(opened.size);
      const readPass = async () => {
        const bytes = Buffer.alloc(size); let offset = 0;
        while (offset < size) {
          budget(); const count = Math.min(LIMITS.chunkBytes, size - offset);
          const { bytesRead } = await handle.read(bytes, offset, count, offset); budget();
          if (!Number.isInteger(bytesRead) || bytesRead <= 0 || bytesRead > count) fail("source_changed");
          offset += bytesRead;
        }
        const extra = Buffer.alloc(1); budget();
        if ((await handle.read(extra, 0, 1, size)).bytesRead !== 0) fail("source_changed"); budget();
        return bytes;
      };
      const first = await readPass();
      const middle = await handle.stat({ bigint: true }); budget();
      if (!sameVersion(opened, middle)) fail("source_changed");
      const second = await readPass();
      const after = await handle.stat({ bigint: true }); budget();
      if (!sameVersion(opened, after) || !first.equals(second)) fail("source_changed");
      const fileAfter = await stat(filename), projectAfter = await stat(project), rootAfter = await stat(root);
      checkNode(fileAfter, uid, false); checkNode(projectAfter, uid, true); checkNode(rootAfter, uid, true);
      // Also recheck the supplied alias, not only the resolved root.
      const suppliedAfter = await stat(value.projectsRoot); checkNode(suppliedAfter, uid, true);
      if (!sameVersion(opened, fileAfter) || !sameIdentity(projectBefore, projectAfter)
        || !sameIdentity(rootBefore, rootAfter) || !sameIdentity(suppliedRoot, suppliedAfter)) fail("source_changed");
      const parsed = parseHistoryBytes(first, value.sessionId); budget();
      result = parsed.kind === "source_records" ? { ...parsed, kind: "source_snapshot",
        identity: { device: opened.dev.toString(), inode: opened.ino.toString(), size: size,
          mtimeNs: opened.mtimeNs.toString(), ctimeNs: opened.ctimeNs.toString() },
        checks: { owner: "posix_euid_and_mode", reads: 2, matchingBytes: true, unchangedObservedIdentity: true },
        sourceAuthenticated: false, publishable: false } : parsed;
    } catch (error) {
      result = reject(error instanceof SourceFailure ? error.sourceCode : ({ ENOENT: sourceObserved ? "source_changed" : "source_missing", ENOTDIR: "source_not_regular_or_linked",
        ELOOP: "source_not_regular_or_linked", EACCES: "source_access_denied", EPERM: "source_access_denied", ERR_ACCESS_DENIED: "source_access_denied" })[error?.code] || "source_io_error");
    } finally {
      if (handle) try { await handle.close(); } catch {
        // A failed close has uncertain resource state. Do not permit another
        // capture (or retry close against a possibly reused descriptor number).
        quarantined = true; result = reject("source_close_failed");
      }
      busy = false;
    }
    return result;
  };
}
module.exports = { createSourceReader, parseHistoryBytes, LIMITS };
