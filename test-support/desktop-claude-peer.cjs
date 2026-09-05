"use strict";
// Offline synthetic peer. Never opens browsers, reads native credentials or
// contacts a model. The fixture HOME is the only place it writes.
const fs = require("node:fs"), path = require("node:path"), readline = require("node:readline");
const home = process.env.DESKTOP_FIXTURE_HOME || process.env.HOME, args = process.argv.slice(2);
if (process.env.DESKTOP_FIXTURE_CHECK_CONTEXT === "1") {
  const context = require("node:child_process").execFileSync("/bin/launchctl", ["managername"], { timeout: 2500, encoding: "utf8" }).trim();
  fs.appendFileSync(path.join(home, "contexts.jsonl"), JSON.stringify({ kind: args.length ? "metadata" : "task", context }) + "\n");
}
if (args.includes("--version")) console.log("2.1.259 (Claude Code)");
else if (args.includes("--help")) console.log("--safe-mode --claudeai");
else if (args.join(" ") === "--safe-mode auth status --json") console.log(JSON.stringify({ loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty", token: "SYNTHETIC_SECRET", email: "private@example.invalid" }));
else if (args.join(" ") === "--safe-mode auth login --claudeai") {
  fs.appendFileSync(path.join(home, "auth-attempts"), "attempt\n");
  console.log("https://example.invalid/?code=SYNTHETIC_SECRET");
  setInterval(() => {}, 1000);
} else if (!args.length) {
  fs.appendFileSync(path.join(home, "task-attempts"), "attempt\n");
  console.log(`desktop-fixture-ready:${process.env.DESKTOP_FIXTURE_CONTEXT || "missing"}`);
  readline.createInterface({ input: process.stdin }).on("line", line => {
    console.log(`literal:${line}`);
    if (line === "fixture-exit") process.exit(0);
  });
} else process.exitCode = 64;
