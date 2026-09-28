#!/usr/bin/env node
// Is there a Codex release Stepsemble has not reviewed, and does Stepsemble
// support it? Prints one JSON object; changes nothing.
//   node scripts/codex-release-watch.mjs [version]
// Without a version it asks npm for the newest Codex.
// action:
//   none    - the newest Codex is reviewed.
//   upgrade - it is not reviewed, but its contract is the same as a reviewed
//             one or only adds to it: Hosts with automatic Codex upgrades on
//             install it without a Stepsemble release.
//   adapt   - it changes something Stepsemble sends or reads; Stepsemble must
//             be changed before Hosts can use it.
//   wait    - it could not be checked yet (usually its schema documents are
//             not published yet); check again later.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createRequire } from "node:module";

const run = promisify(execFile);
const require = createRequire(import.meta.url);
const { registry } = require("../server/codex-compatibility.js");
const { createCodexReleaseCheck } = require("../server/codex-release-check.js");

const reviewed = registry().profiles.filter(profile => profile.verification === "reviewed").map(profile => profile.nativeVersion);
const newestReviewed = reviewed[reviewed.length - 1] || null;
let latest = null;
try {
  latest = process.argv[2] || (await run("npm", ["view", "@openai/codex", "version"], { timeout: 60000 })).stdout.trim();
} catch (error) {
  console.log(JSON.stringify({ action: "wait", reason: "npm_unavailable", newestReviewed, error: String(error.message || error).slice(0, 200) }, null, 2));
  process.exit(0);
}
if (!/^\d+\.\d+\.\d+$/.test(latest)) {
  console.log(JSON.stringify({ action: "wait", reason: "version_unrecognized", latest, newestReviewed }, null, 2));
  process.exit(0);
}
if (reviewed.includes(latest)) {
  console.log(JSON.stringify({ action: "none", latest, newestReviewed }, null, 2));
  process.exit(0);
}
const verdict = await createCodexReleaseCheck({ cacheFile: null }).check(latest);
const action = verdict.state === "supported" ? "upgrade" : verdict.state === "unsupported" ? "adapt" : "wait";
console.log(JSON.stringify({ action, latest, newestReviewed, verdict }, null, 2));
