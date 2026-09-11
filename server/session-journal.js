"use strict";

// Host-owned persistence for protocol/v1 planners. Never expose planner/context
// selection directly to an HTTP client. Native evidence must be verified by the
// owning adapter before it reaches this boundary.
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { DatabaseSync } = require("node:sqlite");
const tx = require("../protocol/transaction-state");
const { canonicalJSON } = require("../public/modules/projection");
const contracts = require("../protocol/validator").createValidator(require("../protocol/v1/schema.json"));
const MAX_STATE_BYTES = 8 * 1024 * 1024;
const MAX_EVENTS = 100000;
const MAX_DB_BYTES = 256 * 1024 * 1024;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const reject = code => ({ kind: "reject", code });
const operations = new Set(Object.keys(tx).filter(name => name.startsWith("plan")));

function windowsOwnerSid() {
  const result = spawnSync("whoami", ["/user", "/fo", "csv", "/nh"], {
    encoding: "utf8", windowsHide: true, timeout: 2000,
  });
  if (result.error || result.status !== 0) return null;
  return String(result.stdout || "").match(/S-\d-\d+(?:-\d+)+/i)?.[0] || null;
}

// Windows ignores POSIX mode bits and inherits the parent DACL by default.
// Replace the journal directory and file DACL with an owner-only rule before
// SQLite opens it. The directory matters because SQLite may create `-wal` and
// `-shm` siblings after this function returns. The target/SID travel through
// the environment, never through a shell command string, so a workspace path
// cannot become PowerShell syntax.
function enforceWindowsOwnerAcl(target, { directory = false } = {}) {
  const sid = windowsOwnerSid();
  if (!sid) throw new Error("journal_windows_owner_unavailable");
  const script = [
    "$ErrorActionPreference='Stop'",
    "$path=$env:STEPSEMBLE_JOURNAL_TARGET",
    "$sid=New-Object System.Security.Principal.SecurityIdentifier($env:STEPSEMBLE_JOURNAL_SID)",
    "$acl=if ($env:STEPSEMBLE_JOURNAL_DIRECTORY -eq '1') { New-Object System.Security.AccessControl.DirectorySecurity } else { New-Object System.Security.AccessControl.FileSecurity }",
    "$acl.SetAccessRuleProtection($true,$false)",
    "$rule=New-Object System.Security.AccessControl.FileSystemAccessRule($sid,'FullControl','Allow')",
    "$acl.AddAccessRule($rule)",
    "Set-Acl -LiteralPath $path -AclObject $acl",
  ].join(";");
  const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf8", windowsHide: true, timeout: 5000,
    env: { ...process.env, STEPSEMBLE_JOURNAL_TARGET: target, STEPSEMBLE_JOURNAL_SID: sid,
      STEPSEMBLE_JOURNAL_DIRECTORY: directory ? "1" : "0" },
  });
  if (result.error || result.status !== 0) throw new Error("journal_windows_acl_required");
}

function openSessionJournal({ filename }) {
  const windows = process.platform === "win32";
  if (typeof filename !== "string" || !path.isAbsolute(filename) || path.resolve(filename) !== filename) throw new Error("journal_path_invalid");
  const directory = path.dirname(filename), parent = fs.lstatSync(directory);
  if (!parent.isDirectory() || fs.realpathSync(directory) !== directory
    || !windows && (parent.uid !== process.getuid() || (parent.mode & 0o077))) throw new Error("journal_directory_private_required");
  if (windows) enforceWindowsOwnerAcl(directory, { directory: true });
  let fd;
  try { fd = fs.openSync(filename, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600); }
  catch (error) { if (error.code !== "EEXIST") throw error; }
  finally { if (fd !== undefined) fs.closeSync(fd); }
  const stat = fs.lstatSync(filename);
  if (!stat.isFile() || stat.nlink !== 1 || stat.size > MAX_DB_BYTES || !windows && (stat.uid !== process.getuid() || (stat.mode & 0o077))) throw new Error("journal_file_private_required");
  if (windows) enforceWindowsOwnerAcl(filename);
  const db = new DatabaseSync(filename);
  let tail = Promise.resolve(), closed = false, closePromise;
  try {
    db.exec("PRAGMA busy_timeout=50; PRAGMA foreign_keys=ON; PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL;");
    const pageSize = db.prepare("PRAGMA page_size").get().page_size;
    db.exec(`PRAGMA max_page_count=${Math.floor(MAX_DB_BYTES / pageSize)}`);
    const version = db.prepare("PRAGMA user_version").get().user_version;
    if (version !== 0 && version !== 1) throw new Error("journal_version_unsupported");
    if (version === 0) {
      if (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().length) throw new Error("journal_schema_invalid");
      db.exec(`BEGIN IMMEDIATE;
        CREATE TABLE sessions (id TEXT PRIMARY KEY, revision INTEGER NOT NULL, state TEXT NOT NULL, event_count INTEGER NOT NULL DEFAULT 0);
        CREATE TABLE grants (session_id TEXT NOT NULL REFERENCES sessions(id), device_id TEXT NOT NULL, allowed INTEGER NOT NULL CHECK(allowed IN (0,1)), PRIMARY KEY(session_id,device_id));
        CREATE TABLE events (session_id TEXT NOT NULL REFERENCES sessions(id), generation TEXT NOT NULL, sequence INTEGER NOT NULL, event_id TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY(session_id,generation,sequence), UNIQUE(session_id,event_id));
        PRAGMA user_version=1; COMMIT;`);
    }
    if (db.prepare("PRAGMA quick_check").get().quick_check !== "ok") throw new Error("journal_corrupt");
  } catch (error) { db.close(); throw error; }

  function queue(action) {
    if (closed) return Promise.resolve(reject("journal_closed"));
    const next = tail.then(action);
    tail = next.catch(() => {});
    return next;
  }
  function load(id) {
    const row = db.prepare(`SELECT revision,state,event_count,
      (SELECT COUNT(*) FROM events WHERE session_id=sessions.id) AS actual_count,
      (SELECT MIN(sequence) FROM events WHERE session_id=sessions.id) AS first_sequence,
      (SELECT MAX(sequence) FROM events WHERE session_id=sessions.id) AS last_sequence,
      (SELECT COUNT(DISTINCT generation) FROM events WHERE session_id=sessions.id) AS generations,
      (SELECT MIN(generation) FROM events WHERE session_id=sessions.id) AS generation
      FROM sessions WHERE id=?`).get(id);
    if (!row) return null;
    if (Buffer.byteLength(row.state) > MAX_STATE_BYTES) throw new Error("journal_corrupt");
    let state;
    try { state = JSON.parse(row.state); } catch { throw new Error("journal_corrupt"); }
    if (tx.checkView(state).kind !== "valid" || state.revision !== row.revision || state.projection.cursor.sessionId !== id) throw new Error("journal_corrupt");
    const end = state.projection.cursor;
    if (!Number.isSafeInteger(row.event_count) || row.event_count < 0 || row.event_count > MAX_EVENTS
      || row.actual_count !== row.event_count
      || row.event_count > 0 && (row.generations !== 1 || row.generation !== end.generation
        || row.last_sequence !== end.sequence || row.first_sequence !== end.sequence - row.event_count + 1)) throw new Error("journal_corrupt");
    return { state, count: row.event_count };
  }
  async function atomic(action) {
    let begun = false;
    try {
      db.exec("BEGIN IMMEDIATE"); begun = true;
      const result = await action();
      if (result.kind === "reject") { db.exec("ROLLBACK"); begun = false; return result; }
      db.exec("COMMIT"); begun = false; return result;
    } catch (error) {
      if (begun) { try { db.exec("ROLLBACK"); } catch { closed = true; } }
      return reject(error.message === "journal_corrupt" ? "journal_corrupt" : error.errcode === 5 || error.errcode === 6 ? "journal_busy" : "journal_write_failed");
    }
  }
  function create(state) {
    // Snapshot bootstrap is explicit. Its existing cursor is the replay floor;
    // only subsequent events are journal entries, not invented prior history.
    const body = canonicalJSON(state, MAX_STATE_BYTES);
    if (body === null || tx.checkView(state).kind !== "valid") return Promise.resolve(reject("invalid_store_view"));
    const copy = JSON.parse(body);
    return queue(() => atomic(() => {
      const id = copy.projection.cursor.sessionId;
      if (load(id)) return reject("session_exists");
      db.prepare("INSERT INTO sessions(id,revision,state) VALUES(?,?,?)").run(id, copy.revision, body);
      return { kind: "created", state: copy };
    }));
  }
  // Owner-only administration. Revocations serialize with decisions and are
  // reread inside the same write transaction as every admission/dispatch.
  function setGrant(sessionId, deviceId, allowed) {
    if (typeof sessionId !== "string" || typeof deviceId !== "string" || !ID.test(sessionId) || !ID.test(deviceId) || typeof allowed !== "boolean") return Promise.resolve(reject("invalid_grant"));
    return queue(() => atomic(() => {
      if (!load(sessionId)) return reject("session_unavailable");
      db.prepare("INSERT INTO grants VALUES(?,?,?) ON CONFLICT(session_id,device_id) DO UPDATE SET allowed=excluded.allowed").run(sessionId, deviceId, Number(allowed));
      return { kind: "grant_updated" };
    }));
  }
  function execute(sessionId, operation, args = [], context = {}) {
    if (!operations.has(operation) || !Array.isArray(args)) return Promise.resolve(reject("unsupported_operation"));
    // Clone at admission: a caller cannot mutate an intent while queued.
    let inputs;
    try { inputs = structuredClone({ args, context }); } catch { return Promise.resolve(reject("invalid_payload")); }
    return queue(() => atomic(async () => {
      const loaded = load(sessionId);
      if (!loaded) return reject("session_unavailable");
      const current = loaded.state, c = inputs.context;
      if (c.expectedRevision !== undefined && c.expectedRevision !== current.revision) return reject("store_revision_conflict");
      const device = c.authenticatedDeviceId;
      const grant = typeof device === "string" ? db.prepare("SELECT allowed FROM grants WHERE session_id=? AND device_id=?").get(sessionId, device) : null;
      const proposal = await tx[operation](current, ...inputs.args, { ...c,
        storeId: current.storeId, storeGeneration: current.storeGeneration,
        expectedRevision: current.revision, authorized: grant?.allowed === 1 });
      if (proposal.kind !== "transaction") return proposal;
      const body = canonicalJSON(proposal.state, MAX_STATE_BYTES);
      if (body === null || loaded.count + proposal.append.length > MAX_EVENTS) return reject("journal_capacity");
      const expected = proposal.expected;
      if (expected.storeId !== current.storeId || expected.storeGeneration !== current.storeGeneration
        || expected.revision !== current.revision || JSON.stringify(expected.cursor) !== JSON.stringify(current.projection.cursor)) return reject("store_revision_conflict");
      for (const event of proposal.append) {
        db.prepare("INSERT INTO events VALUES(?,?,?,?,?)").run(sessionId, event.generation, event.sequence, event.eventId, JSON.stringify(event));
      }
      const updated = db.prepare("UPDATE sessions SET revision=?,state=?,event_count=? WHERE id=? AND revision=?")
        .run(proposal.state.revision, body, loaded.count + proposal.append.length, sessionId, current.revision);
      if (updated.changes !== 1) return reject("store_revision_conflict");
      // Only returned after FULL synchronous COMMIT. Native IO may follow this
      // result, never the detached planner's proposal.
      return { kind: "committed", state: proposal.state, append: proposal.append, receiptId: proposal.receiptId };
    }));
  }
  function read(sessionId) {
    return queue(() => { try { const row = load(sessionId); return row ? { kind: "view", state: row.state } : reject("session_unavailable"); } catch { return reject("journal_corrupt"); } });
  }
  function eventsAfter(sessionId, cursor, limit = 50) {
    return queue(() => {
      if (!cursor || cursor.sessionId !== sessionId || !Number.isSafeInteger(cursor.sequence) || cursor.sequence < 0
        || !Number.isInteger(limit) || limit < 1 || limit > 100) return reject("invalid_cursor");
      try {
        db.exec("BEGIN");
        const row = load(sessionId);
        if (!row) return reject("session_unavailable");
        const end = row.state.projection.cursor;
        if (cursor.generation !== end.generation || cursor.sequence > end.sequence) return reject("snapshot_required");
        if (cursor.sequence < end.sequence - row.count) return reject("snapshot_required");
        const events = db.prepare("SELECT body,event_id,generation,sequence FROM events WHERE session_id=? AND generation=? AND sequence>? ORDER BY sequence LIMIT ?")
          .all(sessionId, cursor.generation, cursor.sequence, limit + 1).map(record => {
            const event = JSON.parse(record.body);
            if (!contracts.validate("event", event).valid || event.eventId !== record.event_id || event.sessionId !== sessionId
              || event.generation !== record.generation || event.sequence !== record.sequence) throw new Error("journal_corrupt");
            return event;
          });
        const selected = events.slice(0, limit);
        if (cursor.sequence < end.sequence && (!selected.length || selected[0].sequence !== cursor.sequence + 1)
          || selected.some((event, i) => event.sequence !== cursor.sequence + i + 1)) return reject("journal_corrupt");
        return { kind: "events", afterCursor: structuredClone(cursor), cursor: { ...cursor, sequence: selected.at(-1)?.sequence ?? cursor.sequence }, events: selected, hasMore: events.length > limit };
      } catch { return reject("journal_corrupt"); }
      finally { if (db.isTransaction) db.exec("ROLLBACK"); }
    });
  }
  function close() {
    if (!closePromise) { closed = true; closePromise = tail.then(() => db.close()); }
    return closePromise;
  }
  return Object.freeze({ create, setGrant, execute, read, eventsAfter, close });
}
module.exports = { openSessionJournal, MAX_STATE_BYTES, MAX_EVENTS };
