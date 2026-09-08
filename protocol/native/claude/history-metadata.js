"use strict";
// Pinned SDK metadata from an already captured source, never a native path.
const path = require("node:path");
const { SDK_VERSION, NATIVE_VERSION, SDK_SHA256 } = require("./history-sdk");
const exact = (v, names) => v && typeof v === "object" && !Array.isArray(v) && Object.keys(v).sort().join() === [...names].sort().join();
const text = (v, max) => typeof v === "string" && v.length > 0 && v.length <= max && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(v);
function validMetadata(v, sessionId) {
  return exact(v, ["sessionId", "nativeTitle", "summary", "titleStatus"]) && v.sessionId === sessionId
    && (v.summary === null || text(v.summary, 4096))
    && (v.titleStatus === "native" && text(v.nativeTitle, 1024) || v.titleStatus === "untitled" && v.nativeTitle === null);
}
async function selectMetadata(snapshot, getSessionInfo) {
  const dir = path.join(path.parse(process.cwd()).root, "stepsemble-memory-snapshot"), projectKey = dir.replace(/[^a-zA-Z0-9]/g, "-");
  const records = JSON.parse(JSON.stringify(snapshot.records)); let loads = 0, denied = false;
  const refuse = () => { denied = true; throw new Error("snapshot_store_scope"); };
  const sessionStore = Object.freeze({ append: async () => refuse(), load: async key => {
    if (++loads !== 1 || !exact(key, ["projectKey", "sessionId"]) || key.projectKey !== projectKey || key.sessionId !== snapshot.sessionId) return refuse();
    return records;
  } });
  const info = await getSessionInfo(snapshot.sessionId, { dir, sessionStore });
  if (loads !== 1 || denied || info != null && (typeof info !== "object" || info.sessionId !== snapshot.sessionId)) throw new Error("snapshot_store_scope");
  const nativeTitle = info?.customTitle === "" ? null : info?.customTitle ?? null;
  const summary = info?.summary === "" ? null : info?.summary ?? null;
  // The SDK's summary may be lastPrompt/firstPrompt. Preserve it separately,
  // never label that fallback as the original native title.
  const metadata = { sessionId: snapshot.sessionId, nativeTitle, summary, titleStatus: nativeTitle === null ? "untitled" : "native" };
  if (!validMetadata(metadata, snapshot.sessionId)) return { kind: "source_unavailable", code: "source_metadata_invalid" };
  const { records: _records, ...source } = snapshot;
  return { kind: "source_session_metadata", source: { ...source, kind: "native_source_bytes" }, metadata,
    reader: { sdkVersion: SDK_VERSION, nativeVersion: NATIVE_VERSION, sdkSha256: SDK_SHA256 } };
}
module.exports = { selectMetadata, validMetadata };
