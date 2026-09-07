"use strict";
// One job in an owned read-only Node subprocess. No SDK, native CLI or network.
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
  const output = JSON.stringify({ protocolVersion: WIRE_VERSION, nonce: job.nonce, request: job.request, result }) + "\n";
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
