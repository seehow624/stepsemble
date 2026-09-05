"use strict";
// Synthetic CLI for HTTP/browser tests. Never reads native credentials, opens
// a browser, contacts a provider or accepts a model prompt.
const fs = require("node:fs"), path = require("node:path");
const args = process.argv.slice(2), home = process.env.HOME;
const complete = path.join(home, "synthetic-claude-login-complete");
if (args.includes("--version")) console.log("2.1.259 (Claude Code)");
else if (args.includes("--help")) console.log("--safe-mode --claudeai");
else if (args.join(" ") === "--safe-mode auth status --json") {
  const loggedIn = fs.existsSync(complete);
  console.log(JSON.stringify({ loggedIn, authMethod: "claude.ai", apiProvider: "firstParty", email: "synthetic-private@example.invalid", token: "SYNTHETIC_AUTH_SECRET" }));
  process.exitCode = loggedIn ? 0 : 1;
} else if (args.join(" ") === "--safe-mode auth login --claudeai") {
  fs.appendFileSync(path.join(home, "synthetic-claude-login-attempts"), "attempt\n");
  console.log("https://example.invalid/authorize?code=SYNTHETIC_AUTH_SECRET");
  const timer = setInterval(() => { if (fs.existsSync(complete)) { clearInterval(timer); process.exit(0); } }, 25);
} else { console.error("Unexpected synthetic CLI command"); process.exitCode = 1; }
