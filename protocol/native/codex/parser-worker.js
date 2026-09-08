"use strict";
const wire = require("./parser-wire");
const { observeNameIndex } = require("./name-index");
const { sameSourceVersion } = require("./source-wire");
const { createRolloutSnapshot, readRolloutPage, releaseRolloutSnapshot } = require("./rollout-snapshot");
const unavailable = code => ({ kind: "source_unavailable", code });
function processJob(input, bytes) {
  const job = wire.detach(input);
  if (!wire.validPayload(bytes, job)) return unavailable("source_worker_protocol");
  if (job.expectedVersion !== null && !sameSourceVersion(job.expectedVersion, job.source)) return unavailable("source_version_changed");
  const split = job.source.rollout.identity.size;
  const snapshot = createRolloutSnapshot(bytes.subarray(0, split), { nativeVersion: job.source.nativeVersion, threadId: job.source.threadId });
  if (snapshot.kind !== "codex_rollout_snapshot") return unavailable(snapshot.code);
  try {
    const index = observeNameIndex(job.source.nameIndex === null ? null : bytes.subarray(split), { nativeVersion: job.source.nativeVersion, threadId: job.source.threadId });
    if (index.kind !== "codex_name_index_observation") return unavailable(index.code);
    let page = null;
    if (job.selection.mode === "records") {
      const result = readRolloutPage(snapshot, { snapshotId: snapshot.snapshotId, offset: job.selection.offset, limit: job.selection.limit });
      if (result.kind !== "codex_rollout_records") return unavailable(result.code);
      const { snapshotId: _ephemeralHandle, ...records } = result; page = records;
    }
    return { kind: "codex_parsed_capture", source: job.source, index, page, sourceAuthenticated: false, publishable: false, semanticHistoryComplete: false };
  } finally { releaseRolloutSnapshot(snapshot); }
}
function validContext(permission = process.permission) {
  return !!permission && typeof permission.has === "function" && !permission.has("fs.write") && !permission.has("child") && !permission.has("fs.read");
}
async function readInput(input) {
  const buffer = Buffer.allocUnsafe(wire.LIMITS.inputBytes); let length = 0, chunks = 0;
  for await (const chunk of input) {
    if (!Buffer.isBuffer(chunk) || ++chunks > wire.LIMITS.chunks || chunk.length > buffer.length - length) throw new Error("parser_input_limit");
    chunk.copy(buffer, length); length += chunk.length;
    if (length >= 4 && (!buffer.readUInt32BE(0) || buffer.readUInt32BE(0) > wire.LIMITS.headerBytes)) throw new Error("parser_input_header");
  }
  const decoded = wire.readJob(buffer.subarray(0, length)); if (!decoded) throw new Error("parser_input_frame");
  return decoded;
}
async function main() {
  if (!validContext()) throw new Error("parser_context");
  const { job, bytes } = await readInput(process.stdin);
  let result;
  try { result = processJob(job, bytes); } catch { result = unavailable("source_worker_failure"); }
  finally { bytes.fill(0); }
  const output = wire.encodeResponse(result, job);
  if (!output) throw new Error("parser_output");
  await new Promise((resolve, reject) => process.stdout.write(output, error => error ? reject(error) : resolve()));
}
if (require.main === module) {
  const watchdog = setTimeout(() => process.exit(1), wire.LIMITS.deadlineMs);
  process.stdout.on("error", () => { process.exitCode = 1; });
  main().catch(() => { process.exitCode = 1; }).finally(() => clearTimeout(watchdog));
}
module.exports = { processJob, validContext, readInput };
