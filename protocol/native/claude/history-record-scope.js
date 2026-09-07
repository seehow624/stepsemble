"use strict";
// Pinned 0.3.259/2.1.259 reference profile, not native-origin authentication.
// Call ONLY after bounded canonical JSON detachment/decoding. No IO or mutation.
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const uuid = value => typeof value === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
const identifier = value => typeof value === "string" && /^[A-Za-z0-9_.:-]{1,256}$/.test(value);
const text = value => typeof value === "string" && value.length > 0 && value.length <= 4096 && !value.includes("\0");
const timestamp = value => typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const transcriptTypes = new Set(["user", "assistant", "progress", "system", "attachment"]);
const fileHistoryTypes = new Set(["file-history-snapshot", "file-history-delta"]);
const keys = (value, required, optional = []) => object(value) && required.every(key => Object.hasOwn(value, key))
  && Object.keys(value).every(key => required.includes(key) || optional.includes(key));
const backup = value => keys(value, ["backupFileName", "version", "backupTime"], ["realParentDir"])
  && (value.backupFileName === null || text(value.backupFileName))
  && Number.isSafeInteger(value.version) && value.version > 0 && timestamp(value.backupTime)
  && (!Object.hasOwn(value, "realParentDir") || text(value.realParentDir));
const reject = code => ({ kind: "reject", code });

function fileHistoryReferences(row) {
  if (row.type === "file-history-snapshot") {
    if (!keys(row, ["type", "messageId", "snapshot", "isSnapshotUpdate"], ["sessionId"])
      || !uuid(row.messageId) || typeof row.isSnapshotUpdate !== "boolean"
      || !keys(row.snapshot, ["messageId", "trackedFileBackups", "timestamp"], ["preCheckpoint"])
      || !uuid(row.snapshot.messageId) || !object(row.snapshot.trackedFileBackups) || !timestamp(row.snapshot.timestamp)
      || Object.hasOwn(row.snapshot, "preCheckpoint") && typeof row.snapshot.preCheckpoint !== "boolean") return null;
    const files = Object.entries(row.snapshot.trackedFileBackups);
    if (files.length > 1000 || files.some(([name, value]) => !text(name) || !backup(value))) return null;
    // An update can reference an earlier snapshot. Do not conflate its two IDs
    // or implement native checkpoint replay/restore from this inert profile.
    return [...new Set([row.messageId, row.snapshot.messageId])];
  }
  if (!keys(row, ["type", "messageId", "snapshotMessageId", "trackingPath", "backup", "timestamp"], ["sessionId"])
    || !uuid(row.messageId) || !uuid(row.snapshotMessageId) || !text(row.trackingPath)
    || !backup(row.backup) || !timestamp(row.timestamp)) return null;
  return [...new Set([row.messageId, row.snapshotMessageId])];
}

/** Classifications preserve source order/indices. They NEVER assign a sessionId
 * to an unscoped native record. A same-file reference is correlation only.
 * Missing/ambiguous/sidechain references reject the whole source, not a page.
 */
function classifyRecordScopes(records, sessionId) {
  if (!Array.isArray(records) || !uuid(sessionId)) return reject("native_scope_mismatch");
  const messages = new Map(), classes = [];
  for (const [recordIndex, row] of records.entries()) {
    if (!object(row) || !identifier(row.type)
      || Object.hasOwn(row, "sessionId") && row.sessionId !== sessionId) return reject("native_scope_mismatch");
    if (fileHistoryTypes.has(row.type)) {
      const referenceIds = fileHistoryReferences(row);
      if (referenceIds === null) return reject("native_ancillary_invalid");
      classes.push({ kind: "file_history", recordIndex, nativeType: row.type,
        scopeEvidence: Object.hasOwn(row, "sessionId") ? "recorded_session_id" : "same_file_message_reference", referenceIds });
    } else {
      if (row.sessionId !== sessionId) return reject("native_scope_mismatch");
      const transcript = transcriptTypes.has(row.type);
      classes.push({ kind: transcript ? "transcript" : "scoped_metadata", recordIndex, nativeType: row.type,
        scopeEvidence: "recorded_session_id", referenceIds: [] });
    }
    if (transcriptTypes.has(row.type) && uuid(row.uuid)) {
      // Mark duplicates ambiguous, even if their bytes match. Mapper checks all
      // transcript identities separately; ancillary links must not choose one.
      messages.set(row.uuid, messages.has(row.uuid) ? null : row);
    }
  }
  for (const entry of classes) {
    if (entry.kind !== "file_history") continue;
    for (const id of entry.referenceIds) {
      const row = messages.get(id);
      if (!row || !["user", "assistant"].includes(row.type) || row.sessionId !== sessionId
        || ["isSidechain", "isMeta"].some(key => Object.hasOwn(row, key) && row[key] !== false)
        || row.teamName || row.agentId) return reject("native_ancillary_reference_unavailable");
    }
  }
  return { kind: "record_scopes", classes };
}
module.exports = { classifyRecordScopes };
