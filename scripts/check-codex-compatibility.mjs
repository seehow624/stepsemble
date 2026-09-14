#!/usr/bin/env node

// Metadata-only Codex compatibility probe. It uses an isolated HOME/CODEX_HOME
// and never starts a thread, turn, login, or model request.
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { probeCodexCompatibility } = require("../server/codex-compatibility.js");
const executable = process.argv[2] || process.env.STEPSEMBLE_CODEX_BIN;

if (!executable || !path.isAbsolute(executable) || process.argv.length > 3) {
  console.error("Usage: node scripts/check-codex-compatibility.mjs /absolute/path/to/codex");
  process.exitCode = 2;
} else {
  try {
    const result = await probeCodexCompatibility(executable);
    console.log(JSON.stringify({
      profileId: result.profileId,
      nativeVersion: result.nativeVersion,
      verification: result.verification,
      schemaFingerprint: result.schemaFingerprint,
      capabilities: result.capabilities,
    }, null, 2));
  } catch (error) {
    console.error(JSON.stringify({
      code: error.code || "codex_compatibility_failed",
      message: error.message,
      nativeVersion: error.nativeVersion || null,
      schemaFingerprint: error.schemaFingerprint || null,
    }, null, 2));
    process.exitCode = 1;
  }
}
