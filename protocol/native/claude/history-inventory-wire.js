"use strict";
// Private Host -> owned helper contract. Never accepts a browser path/grant.
const path = require("node:path"), crypto = require("node:crypto");
const { canonicalJSON } = require("../../../public/modules/projection");
const LIMITS = Object.freeze({ bytes: 1024 * 1024, entries: 2048, projects: 512, directoryEntries: 10000 });
const keys = (v, k) => !!v && typeof v === "object" && !Array.isArray(v) && Object.keys(v).sort().join() === [...k].sort().join();
const u64 = v => typeof v === "string" && /^(0|[1-9][0-9]{0,19})$/.test(v) && BigInt(v) <= 18446744073709551615n;
const count = (v, max) => Number.isSafeInteger(v) && v >= 0 && v <= max;
const rootIdentity = v => keys(v, ["device", "inode"]) && u64(v.device) && u64(v.inode) && v.inode !== "0";
const projectKey = v => typeof v === "string" && /^[A-Za-z0-9_-]{1,255}$/.test(v);
const sessionId = v => typeof v === "string" && /^[a-fA-F0-9]{8}(?:-[a-fA-F0-9]{4}){3}-[a-fA-F0-9]{12}$/.test(v);
function input(value) {
  if (!keys(value, ["projectsRoot", "expectedRoot"]) || !rootIdentity(value.expectedRoot)) return null;
  const p = value.projectsRoot;
  return typeof p === "string" && p.length <= 8192 && path.isAbsolute(p) && path.resolve(p) === p && p !== path.parse(p).root
    && !/[\u0000-\u001f\u007f*?\[\]{},]/.test(p) ? value : null;
}
function decode(result, payload, job) {
  if (!keys(result, ["kind", "byteLength", "sha256", "entryCount", "projectsScanned", "ignoredEntries", "expectedRoot", "checks", "sourceAuthenticated", "publishable"])
    || result.kind !== "native_source_inventory" || result.sourceAuthenticated !== false || result.publishable !== false
    || !count(result.byteLength, LIMITS.bytes) || result.byteLength !== payload.length
    || !count(result.entryCount, LIMITS.entries) || !count(result.projectsScanned, LIMITS.projects) || !count(result.ignoredEntries, LIMITS.directoryEntries)
    || result.entryCount + result.projectsScanned + result.ignoredEntries > LIMITS.directoryEntries
    || !rootIdentity(result.expectedRoot) || result.expectedRoot.device !== job.expectedRoot.device || result.expectedRoot.inode !== job.expectedRoot.inode
    || typeof result.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(result.sha256)
    || crypto.createHash("sha256").update(payload).digest("hex") !== result.sha256
    || !keys(result.checks, ["owner", "acl", "containment", "enumerations", "matchingInventory"])
    || result.checks.owner !== "posix_euid_and_mode" || result.checks.acl !== "no_extended_acl"
    || result.checks.containment !== "root_identity_and_openat_nofollow" || result.checks.enumerations !== 2 || result.checks.matchingInventory !== true
    || payload.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))) return null;
  let entries;
  try { entries = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(payload)); } catch { return null; }
  if (!Array.isArray(entries) || entries.length !== result.entryCount || canonicalJSON(entries, LIMITS.bytes) === null) return null;
  let previous = null; const projects = new Set();
  for (const e of entries) {
    if (!keys(e, ["projectKey", "sessionId", "identity"]) || !projectKey(e.projectKey) || !sessionId(e.sessionId)
      || !keys(e.identity, ["device", "inode", "size", "mtimeNs", "ctimeNs"])
      || !u64(e.identity.device) || e.identity.device !== job.expectedRoot.device || !u64(e.identity.inode) || e.identity.inode === "0"
      || !Number.isSafeInteger(e.identity.size) || e.identity.size < 0
      || !["mtimeNs", "ctimeNs"].every(k => typeof e.identity[k] === "string" && /^(0|[1-9][0-9]{0,29})$/.test(e.identity[k]))) return null;
    // Byte/ASCII order matches Rust; never locale-sort a security identity.
    if (previous && (e.projectKey < previous.projectKey || e.projectKey === previous.projectKey && e.sessionId <= previous.sessionId)) return null;
    previous = e; projects.add(e.projectKey);
  }
  if (projects.size > result.projectsScanned) return null;
  return { ...result, entries, cleanupConfirmed: true };
}
module.exports = { LIMITS, input, decode };
