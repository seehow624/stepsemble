#!/usr/bin/env node
"use strict";
const os = require("node:os"), path = require("node:path");
const { privateRead, exact } = require("./claude-desktop-state");
const { createDesktopHelper } = require("./claude-desktop-helper");

async function main() {
  if (process.argv.length !== 3 || !path.isAbsolute(process.argv[2]) || process.platform !== "darwin") throw new Error("configuration");
  const config = JSON.parse(await privateRead(process.argv[2], 16384));
  if (!exact(config, ["version", "home", "configDir", "claudeCommand", "roots"]) || config.version !== 1 || config.home !== os.homedir()) throw new Error("configuration");
  const helper = await createDesktopHelper(config);
  let closing = false;
  const close = () => { if (closing) return; closing = true; void helper.close().finally(() => process.exit(0)); setTimeout(() => process.exit(1), 5000).unref(); };
  process.on("SIGTERM", close); process.on("SIGINT", close);
  await helper.start();
}
if (require.main === module) main().catch(() => { console.error("Stepsemble desktop Claude helper unavailable; check its private configuration and desktop login context."); process.exitCode = 1; });
