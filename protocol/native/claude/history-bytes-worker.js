"use strict";
// Bytes-only SDK child: no source path, source filesystem read, write, or spawn.
const { parseHistoryBytes } = require("./history-source");
const wire = require("./history-bytes-wire");
const { loadReader } = require("./history-sdk");
const { selectHistory } = require("./history-selection");
const unavailable = code => ({ kind: "source_unavailable", code });
async function processJob(input, raw, { loadReader: reader = loadReader } = {}) {
  const job = wire.detach(input);
  if (!wire.validJob(job) || !wire.validBytes(raw, job.snapshot)) return unavailable("source_worker_protocol");
  if (job.history.expectedVersion && !wire.sameSourceVersion(job.history.expectedVersion, job.snapshot)) return unavailable("source_version_changed");
  const parsed = parseHistoryBytes(raw, job.snapshot.sessionId);
  if (parsed.kind !== "source_records") return parsed;
  const snapshot = { ...job.snapshot, kind: "source_snapshot", records: parsed.records };
  let getSessionMessages;
  try { getSessionMessages = await reader(job.history.sdkPath); } catch { return unavailable("source_sdk_unavailable"); }
  if (typeof getSessionMessages !== "function") return unavailable("source_sdk_unavailable");
  try { return await selectHistory(snapshot, job.history.page, getSessionMessages); } catch { return unavailable("source_selection_failed"); }
}
function validContext(permission = process.permission) {
  return !!permission && typeof permission.has === "function" && !permission.has("fs.write") && !permission.has("child") && !permission.has("fs.read");
}
async function readInput(input) {
  const buffer = Buffer.allocUnsafe(wire.LIMITS.inputBytes); let length = 0, chunks = 0;
  for await (const chunk of input) {
    if (!Buffer.isBuffer(chunk) || ++chunks > wire.LIMITS.inputChunks || chunk.length > buffer.length - length) throw new Error("invalid_worker_input");
    chunk.copy(buffer, length); length += chunk.length;
    if (length >= 4 && (!buffer.readUInt32BE(0) || buffer.readUInt32BE(0) > wire.LIMITS.headerBytes)) throw new Error("invalid_worker_input");
  }
  const value = wire.readJob(buffer.subarray(0, length));
  if (!value) throw new Error("invalid_worker_input");
  return value;
}
async function main() {
  if (!validContext()) throw new Error("invalid_worker_context");
  const { job, bytes } = await readInput(process.stdin);
  let result;
  try { result = await processJob(job, bytes); } catch { result = unavailable("source_worker_failure"); }
  const output = wire.encodeResponse(result, job);
  if (!output) throw new Error("worker_output_limit");
  await new Promise((resolve, reject) => process.stdout.write(output, error => error ? reject(error) : resolve()));
}
if (require.main === module) {
  const watchdog = setTimeout(() => process.exit(1), wire.LIMITS.deadlineMs);
  process.stdout.on("error", () => { process.exitCode = 1; });
  main().catch(() => { process.exitCode = 1; }).finally(() => clearTimeout(watchdog));
}
module.exports = { processJob, validContext, readInput };
