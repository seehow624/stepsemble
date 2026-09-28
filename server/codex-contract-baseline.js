"use strict";

// The latest reviewed Codex app-server contract, kept whole so a release
// Stepsemble has not reviewed can be compared with it (codex-schema-compat).
// The file holds the documents `codex app-server generate-json-schema`
// writes; each is checked against the hashes of the reviewed profile before
// use. scripts/codex-contract-baseline.mjs writes it when a newer release is
// reviewed.

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const zlib = require("node:zlib");

const BASELINE_FILE = path.join(__dirname, "..", "protocol", "native", "codex", "contract-baseline.json.gz");
const MAX_BASELINE_BYTES = 64 * 1024 * 1024;

let cached = null;

function baselineError(message) {
  const error = new Error(message);
  error.code = "codex_baseline_invalid";
  return error;
}

function loadContractBaseline({ file = BASELINE_FILE } = {}) {
  if (cached && cached.file === file) return cached.value;
  // Required here so this module and codex-compatibility can load each other.
  const { registry, schemaFingerprint, SCHEMA_FILES } = require("./codex-compatibility");
  const { CONTRACT_FILES } = require("./codex-schema-compat");
  let parsed;
  try {
    const packed = fs.readFileSync(file);
    parsed = JSON.parse(zlib.gunzipSync(packed, { maxOutputLength: MAX_BASELINE_BYTES }).toString("utf8"));
  } catch { throw baselineError("Codex contract baseline is unreadable"); }
  if (parsed?.fixtureVersion !== 1 || typeof parsed.nativeVersion !== "string" || !Array.isArray(parsed.files)) {
    throw baselineError("Codex contract baseline has an unknown format");
  }
  const byFile = new Map(parsed.files.map(row => [row?.file, row]));
  const documents = {};
  const rows = [];
  for (const name of CONTRACT_FILES) {
    const row = byFile.get(name);
    if (!row || typeof row.text !== "string" || !/^[a-f0-9]{64}$/.test(String(row.sha256))) throw baselineError("Codex contract baseline is incomplete");
    const bytes = Buffer.from(row.text, "utf8");
    const sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
    if (sha256 !== row.sha256) throw baselineError("Codex contract baseline does not match its hashes");
    try { documents[name] = JSON.parse(row.text); } catch { throw baselineError("Codex contract baseline holds invalid JSON"); }
    if (SCHEMA_FILES.includes(name)) rows.push({ file: name, bytes: bytes.length, sha256 });
  }
  const profile = registry().profiles.find(item => item.nativeVersion === parsed.nativeVersion);
  if (!profile || profile.verification !== "reviewed" || schemaFingerprint(rows) !== profile.schemaFingerprint) {
    throw baselineError("Codex contract baseline is not a reviewed profile");
  }
  const value = Object.freeze({ nativeVersion: parsed.nativeVersion, profile, documents: Object.freeze(documents) });
  cached = { file, value };
  return value;
}

module.exports = { BASELINE_FILE, loadContractBaseline };
