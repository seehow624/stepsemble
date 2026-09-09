"use strict";
// Host-private v12 full-source structure sideband for one selected page.
// This is neither a native projection nor an approval, execution or source
// authority receipt. Public parser/HTTP/UI contracts deliberately do not use it.
const crypto = require("node:crypto"), path = require("node:path");
const { canonicalJSON } = require("../../../public/modules/projection");
const scanned = require("./scanned-source-wire");
const PROFILE = "codex_legacy_selected_structure_v1";
const LIMITS = Object.freeze({ ...scanned.LIMITS, headerBytes: 16 * 1024, structureBytes: 512 * 1024,
  outputBytes: scanned.LIMITS.outputBytes + 512 * 1024 });
const WARNINGS = Object.freeze(["invalid_turn_reference", "ambiguous_turn_reference", "unmatched_turn_reference", "invalid_tool_reference",
  "ambiguous_tool_reference", "unknown_record_preserved", "unknown_event_preserved", "invalid_terminal_error", "unclassified_error_preserved",
  "invalid_rollback_count", "invalid_message_preserved"]);
const KINDS = Object.freeze(["unknown", "metadata", "model_context", "tool", "user", "assistant", "reasoning", "lifecycle", "compaction", "review", "assessment", "item", "subagent", "hook"]);
const TOOL_PHASES = Object.freeze({ command: ["begin", "end"], patch: ["begin", "end", "request"], dynamic: ["begin", "end"],
  mcp: ["begin", "end"], web: ["begin", "end"], image_generation: ["begin", "end"], image_view: ["single"],
  spawn_agent: ["begin", "end"], send_input: ["begin", "end"], wait_agents: ["begin", "end"], close_agent: ["begin", "end"], resume_agent: ["begin", "end"] });
const object = v => v !== null && typeof v === "object" && !Array.isArray(v);
const keys = (v, names) => object(v) && Object.keys(v).sort().join(",") === [...names].sort().join(",");
const integer = (v, min, max) => Number.isSafeInteger(v) && v >= min && v <= max;
const hash = v => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
const digest = v => crypto.createHash("sha256").update(v).digest("hex");
const identifier = v => typeof v === "string" && v.length > 0 && v.length <= 1024 && v.isWellFormed()
  && !/[\u0000-\u001f\u007f-\u009f]/.test(v);
const turnKey = (v, recordCount) => typeof v === "string" && /^record-(0|[1-9]\d*)$/.test(v)
  && integer(Number(v.slice(7)), 0, recordCount - 1);
const exactHeaderKeys = ["kind", "nativeVersion", "threadId", "rolloutPath", "rootIdentity", "storage", "byteLength", "sha256", "rollout", "page", "nameIndex", "checks",
  "recordSemanticsValidated", "semanticHistoryComplete", "sourceAuthenticated", "publishable", "validation", "structureFrame"];
function detach(value, limit) {
  try { const json = canonicalJSON(value, limit); return json === null ? null : JSON.parse(json); } catch { return null; }
}
function input(v) { return scanned.input(v); }

/** Detached JSON only. page is the exact private v12 page descriptor. */
function validStructure(value, page, recordCount) {
  const v = detach(value, LIMITS.structureBytes);
  if (!v || !keys(page, ["offset", "byteLength", "records", "nextOffset"]) || !integer(recordCount, 1, LIMITS.records)
    || !integer(page.offset, 0, recordCount) || !integer(page.byteLength, 0, LIMITS.pageBytes) || !Array.isArray(page.records)
    || page.records.length > LIMITS.pageRecords || page.offset + page.records.length > recordCount
    || page.nextOffset !== (page.offset + page.records.length === recordCount ? null : page.offset + page.records.length)
    || page.nextOffset !== null && page.records.length === 0
    || !keys(v, ["structureProfile", "totalTurns", "retainedTurns", "turns", "annotations"])
    || v.structureProfile !== PROFILE || !integer(v.totalTurns, 0, recordCount) || !integer(v.retainedTurns, 0, v.totalTurns)
    || !Array.isArray(v.turns) || v.turns.length > Math.min(v.totalTurns, page.records.length)
    || !Array.isArray(v.annotations) || v.annotations.length !== page.records.length) return false;
  const turns = new Map();
  for (const t of v.turns) {
    if (!keys(t, ["turnKey", "nativeTurnId", "boundary", "firstRecordIndex", "lastRecordIndex", "recordedStatus", "statusRecordIndex", "branchState", "rollbackRecordIndex"])
      || !turnKey(t.turnKey, recordCount) || turns.has(t.turnKey) || t.nativeTurnId !== null && !identifier(t.nativeTurnId)
      || t.boundary !== (t.nativeTurnId === null ? "inferred" : "explicit")
      || !integer(t.firstRecordIndex, 0, recordCount - 1) || !integer(t.lastRecordIndex, t.firstRecordIndex, recordCount - 1)
      || t.turnKey !== `record-${t.firstRecordIndex}` || !["unknown", "started", "completed", "failed", "interrupted"].includes(t.recordedStatus)
      || t.statusRecordIndex !== null && !integer(t.statusRecordIndex, t.firstRecordIndex, t.lastRecordIndex)
      || t.recordedStatus !== "unknown" && t.statusRecordIndex === null
      || t.recordedStatus === "started" && (t.boundary !== "explicit" || t.statusRecordIndex !== t.firstRecordIndex)
      || !["retained", "rolled_back"].includes(t.branchState)
      || (t.branchState === "retained" ? t.rollbackRecordIndex !== null : !integer(t.rollbackRecordIndex, t.lastRecordIndex + 1, recordCount - 1))) return false;
    turns.set(t.turnKey, t);
  }
  const selectedRecords = new Map();
  for (const [i, r] of page.records.entries()) {
    if (!object(r) || r.recordIndex !== page.offset + i) return false;
    selectedRecords.set(r.recordIndex, i);
  }
  const used = new Set();
  for (const [i, a] of v.annotations.entries()) {
    if (!keys(a, ["recordIndex", "kind", "turnKey", "tool", "warnings"]) || a.recordIndex !== page.offset + i
      || !integer(a.recordIndex, 0, recordCount - 1) || !KINDS.includes(a.kind)
      || a.turnKey !== null && (!turnKey(a.turnKey, recordCount) || !turns.has(a.turnKey))
      || !Array.isArray(a.warnings) || a.warnings.length > WARNINGS.length || new Set(a.warnings).size !== a.warnings.length
      || a.warnings.some(w => !WARNINGS.includes(w)) || a.kind !== "tool" && a.tool !== null) return false;
    if (a.turnKey !== null) {
      const turn = turns.get(a.turnKey); used.add(a.turnKey);
      if (!integer(a.recordIndex, turn.firstRecordIndex, turn.lastRecordIndex)) return false;
    }
    if (a.tool === null) {
      if (a.kind === "tool" && !a.warnings.includes("invalid_tool_reference")) return false;
      continue;
    }
    const t = a.tool, phases = typeof t?.family === "string" && Object.hasOwn(TOOL_PHASES, t.family) ? TOOL_PHASES[t.family] : null;
    if (a.kind !== "tool" || !keys(t, ["family", "phase", "nativeCallId", "relatedRecordIndex"])
      || !phases || !phases.includes(t.phase) || !identifier(t.nativeCallId) || a.warnings.includes("invalid_tool_reference")
      || t.relatedRecordIndex !== null && (!integer(t.relatedRecordIndex, 0, recordCount - 1) || t.relatedRecordIndex === a.recordIndex
        || a.turnKey === null || !["begin", "end"].includes(t.phase))) return false;
    if (a.warnings.includes("ambiguous_tool_reference") && t.relatedRecordIndex !== null) return false;
    if (t.relatedRecordIndex !== null) {
      const turn = turns.get(a.turnKey);
      if (!integer(t.relatedRecordIndex, turn.firstRecordIndex, turn.lastRecordIndex)) return false;
      const otherIndex = selectedRecords.get(t.relatedRecordIndex);
      const other = otherIndex === undefined ? null : v.annotations[otherIndex];
      if (other && (other.turnKey !== a.turnKey || other.kind !== "tool" || other.tool?.family !== t.family
        || other.tool.nativeCallId !== t.nativeCallId || other.tool.relatedRecordIndex !== a.recordIndex
        || other.tool.phase !== (t.phase === "begin" ? "end" : "begin"))) return false;
    }
  }
  const visibleRetained = v.turns.filter(t => t.branchState === "retained").length;
  return used.size === turns.size && visibleRetained <= v.retainedTurns
    && v.turns.length - visibleRetained <= v.totalTurns - v.retainedTurns;
}

function decode(value, payload, job) {
  if (job?.protocolVersion !== 12 || !input({ nativeVersion: job.nativeVersion, source: job.source, expectedRoot: job.expectedRoot, page: job.page })
    || !Buffer.isBuffer(payload)) return null;
  const v = detach(value, LIMITS.headerBytes);
  if (!keys(v, exactHeaderKeys) || v.kind !== "native_codex_structured_source_page" || !keys(v.structureFrame, ["profile", "byteOffset", "byteLength", "sha256"])
    || v.recordSemanticsValidated !== false || v.semanticHistoryComplete !== false || v.sourceAuthenticated !== false || v.publishable !== false
    || v.structureFrame.profile !== PROFILE || !integer(v.structureFrame.byteLength, 1, LIMITS.structureBytes)
    || !integer(v.structureFrame.byteOffset, 0, LIMITS.pageBytes + LIMITS.indexBytes)
    || v.structureFrame.byteOffset !== v.page?.byteLength + (v.nameIndex?.byteLength ?? 0)
    || v.byteLength !== v.structureFrame.byteOffset + v.structureFrame.byteLength || payload.length !== v.byteLength
    || !hash(v.sha256) || digest(payload) !== v.sha256 || !hash(v.structureFrame.sha256)) return null;
  const structureBytes = payload.subarray(v.structureFrame.byteOffset);
  if (structureBytes.length !== v.structureFrame.byteLength || digest(structureBytes) !== v.structureFrame.sha256
    || structureBytes[0] === 0xef && structureBytes[1] === 0xbb && structureBytes[2] === 0xbf) return null;
  const basePayload = payload.subarray(0, v.structureFrame.byteOffset);
  const base = scanned.decode({ kind: "native_codex_validated_source_page", nativeVersion: v.nativeVersion, threadId: v.threadId,
    rolloutPath: v.rolloutPath, rootIdentity: v.rootIdentity, storage: v.storage, byteLength: basePayload.length, sha256: digest(basePayload),
    rollout: v.rollout, page: v.page, nameIndex: v.nameIndex, checks: v.checks, recordSemanticsValidated: false,
    semanticHistoryComplete: false, sourceAuthenticated: false, publishable: false, validation: v.validation }, basePayload,
  { protocolVersion: 11, nativeVersion: job.nativeVersion, source: job.source, expectedRoot: job.expectedRoot, page: job.page });
  if (!base) return null;
  let structure;
  try { structure = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(structureBytes)); } catch { return null; }
  structure = detach(structure, LIMITS.structureBytes);
  if (!validStructure(structure, v.page, v.rollout.recordCount)) return null;
  return { kind: v.kind, nativeVersion: v.nativeVersion, threadId: v.threadId, rolloutPath: v.rolloutPath,
    rootIdentity: v.rootIdentity, storage: v.storage, byteLength: v.byteLength, sha256: v.sha256, rollout: v.rollout, page: v.page,
    nameIndex: v.nameIndex, checks: v.checks, recordSemanticsValidated: false, semanticHistoryComplete: false, sourceAuthenticated: false,
    publishable: false, validation: v.validation, structureFrame: v.structureFrame, pageBytes: base.pageBytes,
    nameIndexBytes: base.nameIndexBytes, structureBytes: Buffer.from(structureBytes), structure, cleanupConfirmed: true };
}

function decodedParts(result) {
  try {
    if (!object(result) || ![Object.prototype, null].includes(Object.getPrototypeOf(result)) || Object.getOwnPropertySymbols(result).length) return null;
    const descriptors = Object.getOwnPropertyDescriptors(result), names = [...exactHeaderKeys, "pageBytes", "nameIndexBytes", "structureBytes", "structure", "cleanupConfirmed"];
    if (Object.keys(descriptors).sort().join(",") !== names.sort().join(",")
      || Object.values(descriptors).some(d => !Object.hasOwn(d, "value") || !d.enumerable)) return null;
    return Object.fromEntries(Object.entries(descriptors).map(([k, d]) => [k, d.value]));
  } catch { return null; }
}
function sourceVersion(result) {
  const r = decodedParts(result);
  if (!r || !Buffer.isBuffer(r.pageBytes) || r.nameIndexBytes !== null && !Buffer.isBuffer(r.nameIndexBytes)
    || !Buffer.isBuffer(r.structureBytes) || r.cleanupConfirmed !== true) return null;
  const header = detach(Object.fromEntries(exactHeaderKeys.map(k => [k, r[k]])), LIMITS.headerBytes);
  if (!keys(header, exactHeaderKeys) || !keys(header.page, ["offset", "byteLength", "records", "nextOffset"])
    || !keys(header.structureFrame, ["profile", "byteOffset", "byteLength", "sha256"])
    || !keys(header.rootIdentity, ["device", "inode"]) || typeof header.rootIdentity.device !== "string"
    || !integer(header.page.byteLength, 0, LIMITS.pageBytes) || !Array.isArray(header.page.records) || header.page.records.length > LIMITS.pageRecords
    || !integer(header.structureFrame.byteLength, 1, LIMITS.structureBytes)
    || header.nameIndex !== null && (!object(header.nameIndex) || !integer(header.nameIndex.byteLength, 0, LIMITS.indexBytes))) return null;
  const sizes = [header.page.byteLength, header.nameIndex?.byteLength ?? 0, header.structureFrame.byteLength];
  if (header.structureFrame.byteOffset !== sizes[0] + sizes[1] || header.byteLength !== sizes.reduce((n, size) => n + size, 0)) return null;
  // Capture buffers are Host-owned. Read typed-array intrinsics without caller
  // properties and reject SharedArrayBuffer before allocating a bounded copy.
  const typed = Object.getPrototypeOf(Uint8Array.prototype), get = key => Object.getOwnPropertyDescriptor(typed, key).get;
  const arrayBufferLength = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, "byteLength").get;
  const view = (value, size) => {
    try {
      if (!Buffer.isBuffer(value) || get("byteLength").call(value) !== size) return null;
      const backing = get("buffer").call(value), offset = get("byteOffset").call(value);
      return Object.getPrototypeOf(backing) === ArrayBuffer.prototype && arrayBufferLength.call(backing) >= offset + size
        ? new Uint8Array(backing, offset, size) : null;
    } catch { return null; }
  };
  const parts = [view(r.pageBytes, sizes[0]), sizes[1] === 0 && header.nameIndex === null ? null : view(r.nameIndexBytes, sizes[1]), view(r.structureBytes, sizes[2])];
  if (!parts[0] || !parts[2] || (header.nameIndex === null ? r.nameIndexBytes !== null : !parts[1])) return null;
  const payload = Buffer.allocUnsafe(header.byteLength); let offset = 0;
  for (const part of parts) if (part) { payload.set(part, offset); offset += part.byteLength; }
  const checked = decode(header, payload, { protocolVersion: 12, nativeVersion: header.nativeVersion,
    source: { codexRoot: pathlessRoot(header), rolloutPath: header.rolloutPath, threadId: header.threadId }, expectedRoot: header.rootIdentity,
    page: { offset: header.page.offset, limit: Math.max(1, header.page.records.length) } });
  if (!checked || canonicalJSON(checked.structure, LIMITS.structureBytes) !== canonicalJSON(r.structure, LIMITS.structureBytes)) return null;
  return { kind: "codex_structured_source_version", nativeVersion: checked.nativeVersion, threadId: checked.threadId, rolloutPath: checked.rolloutPath,
    rootIdentity: checked.rootIdentity, storage: checked.storage, rollout: checked.rollout, validation: checked.validation,
    nameIndex: checked.nameIndex === null ? null : { identity: checked.nameIndex.identity, sha256: checked.nameIndex.sha256 }, structureProfile: PROFILE };
}
// The source root is intentionally absent from result/version DTOs. Constructing
// a self-check job therefore cannot recover it; use the exact locator's harmless
// absolute placeholder, which is validated only as an input shape at this stage.
function pathlessRoot(r) { return path.join(path.parse(process.execPath).root, `structured-version-${r.rootIdentity.device}`); }
function validVersion(v) {
  const x = detach(v, LIMITS.headerBytes);
  if (!keys(x, ["kind", "nativeVersion", "threadId", "rolloutPath", "rootIdentity", "storage", "rollout", "validation", "nameIndex", "structureProfile"])
    || x.kind !== "codex_structured_source_version" || x.structureProfile !== PROFILE) return false;
  const base = { kind: "codex_validated_source_version", nativeVersion: x.nativeVersion, threadId: x.threadId, rolloutPath: x.rolloutPath,
    rootIdentity: x.rootIdentity, storage: x.storage, rollout: x.rollout, validation: x.validation, nameIndex: x.nameIndex };
  return scanned.sameSourceVersion(base, base);
}
function sameSourceVersion(a, b) { a = detach(a, LIMITS.headerBytes); b = detach(b, LIMITS.headerBytes); return validVersion(a) && validVersion(b) && canonicalJSON(a) === canonicalJSON(b); }
module.exports = { PROFILE, LIMITS, WARNINGS, KINDS, TOOL_FAMILIES: Object.freeze(Object.keys(TOOL_PHASES)), input, validStructure, decode, sourceVersion, sameSourceVersion };
