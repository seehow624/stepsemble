#!/usr/bin/env node
// Checks the newest stable release of every agent Stepsemble upgrades for you,
// one after another, with each agent's own release check (the Host runs the
// same checks before it upgrades an agent: server/agent-release-gate.js).
// Codex is reviewed separately (npm run -s watch:codex).
//   node scripts/check-agent-releases.mjs [--force] [agent ...]
// Prints one JSON object: { action, agents: [{ id, action, version, ... }] }.
// action "adapt" when any release failed a check (Stepsemble must be changed
// for it), "wait" when one could not be checked, "none" when all passed.
// Exit 2, 1 or 0.
import path from "node:path";
import { execFile } from "node:child_process";
import { root, searchPath } from "./agent-release-lib.mjs";

const CHECKS = {
  "claude-code": ["check-claude-release.mjs"], "grok-build": ["check-grok-release.mjs"], pi: ["check-pi-release.mjs"],
  antigravity: ["check-antigravity-release.mjs"], opencode: ["check-opencode-release.mjs"],
  cline: ["check-acp-release.mjs", "cline"], kilo: ["check-acp-release.mjs", "kilo"], omp: ["check-acp-release.mjs", "omp"],
};
const args = process.argv.slice(2);
const force = args.includes("--force");
const chosen = args.filter(arg => !arg.startsWith("--"));
for (const id of chosen) if (!CHECKS[id]) { console.error("Unknown agent " + id + "; one of " + Object.keys(CHECKS).join(", ")); process.exit(1); }
const agents = [];
for (const id of chosen.length ? chosen : Object.keys(CHECKS)) {
  const [script, ...extra] = CHECKS[id];
  const report = await new Promise(resolve => execFile(process.execPath, [path.join(root, "scripts", script), ...extra, ...(force ? ["--force"] : [])],
    { cwd: root, timeout: 25 * 60 * 1000, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, PATH: searchPath() } }, (error, stdout) => {
      const text = String(stdout || "");
      const start = text.indexOf("{"), end = text.lastIndexOf("}");
      try { resolve(JSON.parse(text.slice(start, end + 1))); }
      catch { resolve({ action: "wait", state: "check_crashed", error: String(error?.message || "no report").slice(0, 300) }); }
    }));
  const { debug, ...kept } = report;
  agents.push({ id, ...kept });
}
const action = agents.some(row => row.action === "adapt") ? "adapt" : agents.some(row => row.action === "wait") ? "wait" : "none";
console.log(JSON.stringify({ action, agents }, null, 2));
process.exit(action === "adapt" ? 2 : action === "wait" ? 1 : 0);
