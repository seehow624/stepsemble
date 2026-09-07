"use strict";
// Pure snapshot -> official public SessionStore reader -> inert observation.
// getSessionMessages is a trusted dependency, NOT request-supplied executable code.
const path = require("node:path");
const { performance } = require("node:perf_hooks");
const { observeHistory } = require("./history-observation");
const { SDK_VERSION, NATIVE_VERSION, SDK_SHA256 } = require("./history-sdk");
async function selectHistory(snapshot, page, getSessionMessages) {
  const started = performance.now();
  // The SDK rewires compaction parents. Give it a disposable copy, preserving
  // the captured native rows for exact-content comparison and source digests.
  const records = JSON.parse(JSON.stringify(snapshot.records));
  const dir = path.join(path.parse(process.cwd()).root, "stepsemble-memory-snapshot");
  const projectKey = dir.replace(/[^a-zA-Z0-9]/g, "-");
  let loads = 0, denied = false;
  const refuse = () => { denied = true; throw new Error("snapshot_store_scope"); };
  const sessionStore = Object.freeze({ append: async () => refuse(), load: async key => {
    if (++loads !== 1 || !key || Object.keys(key).sort().join(",") !== "projectKey,sessionId"
      || key.sessionId !== snapshot.sessionId || key.projectKey !== projectKey) return refuse();
    return records;
  } });
  const selected = await getSessionMessages(snapshot.sessionId, { dir, sessionStore, includeSystemMessages: true, ...page });
  if (loads !== 1 || denied || !Array.isArray(selected) || selected.length > page.limit) throw new Error("snapshot_store_scope");
  // Official cR contains undefined properties; JSON wire legitimately omits them.
  const messages = JSON.parse(JSON.stringify(selected)), selectedAt = performance.now();
  const observation = observeHistory({ sessionId: snapshot.sessionId, messages, nativeRecords: snapshot.records });
  if (observation.kind !== "history_observation") return { kind: "source_unavailable", code: "source_observation_rejected" };
  const { records: discarded, ...summary } = snapshot;
  return { kind: "source_history_observation", source: { ...summary, kind: "source_snapshot_summary", recordCount: discarded.length },
    page, observation, reader: { sdkVersion: SDK_VERSION, nativeVersion: NATIVE_VERSION, sdkSha256: SDK_SHA256, selection: "snapshot_session_store" },
    metrics: { selectionMs: selectedAt - started, mappingMs: performance.now() - selectedAt, maxRssKiB: process.resourceUsage().maxRSS } };
}
module.exports = { selectHistory };
