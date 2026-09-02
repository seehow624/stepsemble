"use strict";

// Starts server.js and then exits as soon as the server is listening. This is
// the shape of a harness that spawns the server and later throws before its
// own cleanup, leaving the server without a parent.
const { spawn } = require("node:child_process");

const [nodeBin, serverPath, envJson, cwd] = process.argv.slice(2);
const child = spawn(nodeBin, [serverPath], {
  env: JSON.parse(envJson),
  cwd,
  stdio: ["ignore", "pipe", "pipe"],
});

child.stdout.on("data", (chunk) => {
  if (String(chunk).includes(" listening on ")) {
    process.stdout.write(`SERVER_PID=${child.pid}\n`);
    process.exit(0);
  }
});
child.stderr.on("data", (chunk) => process.stderr.write(chunk));
