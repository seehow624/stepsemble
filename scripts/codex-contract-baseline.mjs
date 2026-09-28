#!/usr/bin/env node
// Writes protocol/native/codex/contract-baseline.json.gz from the schema
// documents the official openai/codex repository publishes for a release
// (codex-rs/app-server-protocol/schema/json at tag rust-v<version>). They are
// the files `codex app-server generate-json-schema` writes; the fingerprinted
// ones are checked against the reviewed profile. Run it after reviewing a
// newer release and adding its profile.
//   node scripts/codex-contract-baseline.mjs 0.158.0
import fs from "node:fs/promises";
import path from "node:path";
import zlib from "node:zlib";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { CONTRACT_FILES } = require("../server/codex-schema-compat.js");
const { registry, schemaFingerprint, SCHEMA_FILES } = require("../server/codex-compatibility.js");
const version = process.argv[2];
if (!/^\d+\.\d+\.\d+$/.test(String(version))) { console.error("Usage: node scripts/codex-contract-baseline.mjs <reviewed version>"); process.exit(2); }
const profile = registry().profiles.find(item => item.nativeVersion === version);
if (!profile || profile.verification !== "reviewed") { console.error("Add the reviewed profile for " + version + " to compatibility.json first"); process.exit(2); }
const files = [];
for (const file of CONTRACT_FILES) {
  const url = "https://raw.githubusercontent.com/openai/codex/rust-v" + version + "/codex-rs/app-server-protocol/schema/json/" + file;
  const response = await fetch(url);
  if (!response.ok) { console.error("Could not read " + file + ": " + response.status); process.exit(1); }
  const text = await response.text();
  JSON.parse(text);
  files.push({ file, sha256: crypto.createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex"), text });
}
const rows = files.filter(row => SCHEMA_FILES.includes(row.file)).map(row => ({ file: row.file, bytes: Buffer.byteLength(row.text), sha256: row.sha256 }));
if (schemaFingerprint(rows) !== profile.schemaFingerprint) { console.error("The published documents do not match the reviewed fingerprint of " + version); process.exit(1); }
const body = JSON.stringify({ fixtureVersion: 1, nativeVersion: version, source: "openai/codex rust-v" + version + " codex-rs/app-server-protocol/schema/json", files });
const target = path.join(root, "protocol", "native", "codex", "contract-baseline.json.gz");
await fs.writeFile(target, zlib.gzipSync(Buffer.from(body, "utf8"), { level: 9 }));
console.log(JSON.stringify({ written: path.relative(root, target), nativeVersion: version, files: files.length, bytes: (await fs.stat(target)).size }));
