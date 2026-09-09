"use strict";
// Permissionless projection of one Host-captured v12 page. The selected raw
// records, private structure sideband and optional index bytes are supplied by
// the parent; this module never opens a source or grants native authority.
const crypto = require("node:crypto");
const { canonicalJSON } = require("../../../public/modules/projection");
const source = require("./structured-source-wire"), paged = require("./validated-page");
const { observeNameIndex } = require("./name-index");
const { observeSqliteNameResolution } = require("./name-resolution");
const LIMITS = Object.freeze({ combinedBytes: 272 * 1024, publicBytes: 380 * 1024, parserBytes: 416 * 1024 });
const keys = (v, names) => v !== null && typeof v === "object" && !Array.isArray(v)
  && Object.keys(v).sort().join(",") === [...names].sort().join(",");
const digest = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const unavailable = code => ({ kind: "source_unavailable", code });

function baseSource(v) {
  if (!source.sameSourceVersion(v, v)) return null;
  const { structureProfile: _privateProfile, ...rest } = v;
  return { ...rest, kind: "codex_validated_source_version" };
}
function baseJob(job) {
  const selected = baseSource(job?.source);
  return selected ? { ...job, source: selected } : null;
}
function descriptor(frame, job) {
  const base = baseJob(job), indexBytes = job?.source?.nameIndex?.identity?.size ?? 0;
  return !!base && paged.descriptor(job.page, base.source, job.selection)
    && keys(frame, ["profile", "byteOffset", "byteLength", "sha256"])
    && frame.profile === source.PROFILE && frame.profile === job.source.structureProfile
    && Number.isSafeInteger(frame.byteOffset) && frame.byteOffset === job.page.byteLength + indexBytes
    && Number.isSafeInteger(frame.byteLength) && frame.byteLength > 0 && frame.byteLength <= source.LIMITS.structureBytes
    && typeof frame.sha256 === "string" && /^[a-f0-9]{64}$/.test(frame.sha256);
}
function decode(bytes, job) {
  if (!Buffer.isBuffer(bytes) || !descriptor(job?.structureFrame, job)) return null;
  const frame = job.structureFrame, indexLength = job.source.nameIndex?.identity.size ?? 0;
  if (bytes.length !== frame.byteOffset + frame.byteLength) return null;
  const pageAndIndex = bytes.subarray(0, frame.byteOffset), structureBytes = bytes.subarray(frame.byteOffset);
  if (digest(structureBytes) !== frame.sha256 || structureBytes[0] === 0xef && structureBytes[1] === 0xbb && structureBytes[2] === 0xbf)
    return null;
  const base = baseJob(job);
  if (!paged.payload(pageAndIndex, base)) return null;
  let structure;
  try { structure = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(structureBytes)); } catch { return null; }
  try {
    const json = canonicalJSON(structure, source.LIMITS.structureBytes);
    structure = json === null ? null : JSON.parse(json);
  } catch { structure = null; }
  if (!structure || !source.validStructure(structure, job.page, job.source.rollout.recordCount)) return null;
  return { pageAndIndex, pageBytes: pageAndIndex.subarray(0, job.page.byteLength),
    indexBytes: job.source.nameIndex === null ? null : pageAndIndex.subarray(job.page.byteLength, job.page.byteLength + indexLength), structure };
}

function publicStructure(privateValue, page, count) {
  const annotations = privateValue.annotations.slice(0, count), used = new Set(annotations.map(v => v.turnKey).filter(v => v !== null));
  return { profile: source.PROFILE, totalTurns: privateValue.totalTurns, retainedTurns: privateValue.retainedTurns,
    turns: privateValue.turns.filter(v => used.has(v.turnKey)), annotations };
}
function selectedPage(page, count) {
  const records = page.records.slice(0, count), endOfFile = page.offset + records.length === page.recordCount;
  return { ...page, records, nextOffset: endOfFile ? null : page.offset + records.length, endOfFile };
}
function privateShape(structure) {
  return { structureProfile: structure.profile, totalTurns: structure.totalTurns, retainedTurns: structure.retainedTurns,
    turns: structure.turns, annotations: structure.annotations };
}
function validProjection(page, structure, job) {
  if (job.selection.mode === "names") return page === null && structure === null;
  const base = baseJob(job);
  if (!base || !paged.matches(page, base) || !keys(structure, ["profile", "totalTurns", "retainedTurns", "turns", "annotations"])) return false;
  const selectedBytes = page.records.reduce((n, r) => n + r.byteLength, 0);
  const synthetic = { offset: page.offset, byteLength: selectedBytes, records: page.records, nextOffset: page.nextOffset };
  return source.validStructure(privateShape(structure), synthetic, page.recordCount);
}
function byteLength(value) { try { return Buffer.byteLength(JSON.stringify(value)); } catch { return Number.POSITIVE_INFINITY; } }
function budgets(result, job) {
  if (job.selection.mode !== "names") {
    if (byteLength({ records: result.page, structure: result.structure }) > LIMITS.combinedBytes) return false;
    if (byteLength({ records: result.page, structure: result.structure, nativeTitle: result.name?.name ?? null }) > LIMITS.publicBytes) return false;
  }
  return byteLength({ protocolVersion: job.protocolVersion, nonce: job.nonce, result }) + 1 <= LIMITS.parserBytes;
}
function makeResult(job, index, name, page, structure) {
  return { kind: "codex_parsed_structured_page_capture", source: job.source, index, page,
    ...(job.protocolVersion === 10 ? { name } : {}), structure,
    sourceAuthenticated: false, publishable: false, semanticHistoryComplete: false };
}
function process(job, bytes) {
  const decoded = decode(bytes, job);
  if (!decoded) return unavailable("source_worker_protocol");
  const parameters = { nativeVersion: job.source.nativeVersion, threadId: job.source.threadId };
  const index = observeNameIndex(decoded.indexBytes, parameters);
  if (index.kind !== "codex_name_index_observation") return unavailable(index.code);
  let name;
  if (job.protocolVersion === 10) {
    const context = job.nameResolution;
    name = observeSqliteNameResolution(context.fields, context.nameContext, decoded.indexBytes, { ...parameters, method: context.method,
      rollout: { threadId: job.source.threadId, historyMode: job.source.validation.historyMode, path: context.rolloutPath } });
    if (name.kind !== "codex_name_resolution_observation") return unavailable(name.code);
  }
  const rawPage = paged.project(decoded.pageAndIndex, baseJob(job));
  if (rawPage?.kind === "source_unavailable") return rawPage;
  if (job.selection.mode === "names") {
    const result = makeResult(job, index, name, null, null);
    return budgets(result, job) ? result : unavailable("source_worker_output_limit");
  }
  for (let count = rawPage.records.length; count > 0 || count === 0 && rawPage.endOfFile; count--) {
    const page = selectedPage(rawPage, count), structure = publicStructure(decoded.structure, page, count);
    const result = makeResult(job, index, name, page, structure);
    if (validProjection(page, structure, job) && budgets(result, job)) return result;
    if (count === 0) break;
  }
  return unavailable("rollout_structure_page_limit");
}
function validResult(value, job) {
  if (!keys(value, ["kind", "source", "index", "page", "structure", "sourceAuthenticated", "publishable", "semanticHistoryComplete",
    ...(job.protocolVersion === 10 ? ["name"] : [])]) || value.kind !== "codex_parsed_structured_page_capture"
    || value.sourceAuthenticated !== false || value.publishable !== false || value.semanticHistoryComplete !== false
    || !validProjection(value.page, value.structure, job)) return false;
  return budgets(value, job);
}
function matches(value, job, bytes) {
  const expected = process(job, bytes);
  return expected.kind === "codex_parsed_structured_page_capture" && canonicalJSON(value, LIMITS.parserBytes) === canonicalJSON(expected, LIMITS.parserBytes);
}
module.exports = { LIMITS, descriptor, decode, validProjection, budgets, process, validResult, matches };
