"use strict";
// One job in an owned read-only Node subprocess. Optional pinned offline SDK
// history selection; no native CLI, model, login or network API is called.
const { createSourceReader } = require("./history-source");
const { WIRE_VERSION, LIMITS, decode, validJob } = require("./history-worker-wire");
async function main() {
  const chunks = []; let length = 0;
  for await (const chunk of process.stdin) {
    length += chunk.length;
    if (length > LIMITS.inputBytes) throw new Error("invalid_worker_input");
    chunks.push(chunk);
  }
  const job = decode(Buffer.concat(chunks), LIMITS.inputBytes);
  if (!validJob(job) || !process.permission || process.permission.has("fs.write") || process.permission.has("child"))
    throw new Error("invalid_worker_context");
  let result;
  try { result = await createSourceReader()(job.source); }
  catch { result = { kind: "source_unavailable", code: "source_worker_failure" }; }
  if (job.history && result.kind === "source_snapshot") {
    let getSessionMessages;
    try { getSessionMessages = await require("./history-sdk").loadReader(job.history.sdkPath); }
    catch { result = { kind: "source_unavailable", code: "source_sdk_unavailable" }; }
    if (getSessionMessages) try {
      result = await require("./history-selection").selectHistory(result, job.history.page, getSessionMessages);
    } catch { result = { kind: "source_unavailable", code: "source_selection_failed" }; }
  }
  const encode = () => JSON.stringify({ protocolVersion: WIRE_VERSION, nonce: job.nonce, request: job.request, result }) + "\n";
  let output = encode();
  if (job.history && Buffer.byteLength(output) > LIMITS.pageBytes) {
    result = { kind: "source_unavailable", code: "source_observation_too_large" }; output = encode();
  }
  if (Buffer.byteLength(output) > LIMITS.outputBytes) throw new Error("worker_output_limit");
  await new Promise((resolve, reject) => process.stdout.write(output, error => error ? reject(error) : resolve()));
}
if (require.main === module) {
  // Backstop if the parent disappears while async filesystem IO is pending.
  // Only this worker exits; still not a guarantee against uninterruptible IO.
  const watchdog = setTimeout(() => process.exit(1), LIMITS.deadlineMs);
  process.stdout.on("error", () => { process.exitCode = 1; });
  main().catch(() => { process.exitCode = 1; }).finally(() => clearTimeout(watchdog)); // Never print raw errors.
}
