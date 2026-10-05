"use strict";

// A CLI written as a script names its runtime on its first line, such as
// "#!/usr/bin/env node" or "#!/usr/bin/env bun". Package managers keep that
// runtime in the same folder as the CLI (Bun puts both bun and omp in
// ~/.bun/bin), so a service started with a short PATH could find the CLI and
// still fail to start it. The CLI's own folder is added at the end of PATH:
// it fills that gap without changing which programs the PATH already chooses.

const path = require("node:path");

function withCommandDirectory(env, command) {
  const source = env && typeof env === "object" ? env : {};
  if (typeof command !== "string" || !path.isAbsolute(command)) return { ...source };
  const key = Object.keys(source).find(name => name.toUpperCase() === "PATH") || "PATH";
  const directory = path.dirname(command);
  const entries = String(source[key] || "").split(path.delimiter).filter(Boolean);
  if (entries.includes(directory)) return { ...source };
  return { ...source, [key]: [...entries, directory].join(path.delimiter) };
}

module.exports = { withCommandDirectory };
