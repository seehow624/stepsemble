#!/usr/bin/env node
// Offline metadata only: never start an app server, thread, turn or login.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
const exec = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const VERSION = "0.153.3";
export const SCHEMAS = Object.freeze([
  "ClientRequest.json", "ServerRequest.json", "ServerNotification.json",
  "v1/InitializeParams.json", "v1/InitializeResponse.json", "v2/ThreadListParams.json", "v2/ThreadListResponse.json",
  "v2/ThreadReadParams.json", "v2/ThreadReadResponse.json", "v2/ThreadResumeParams.json", "v2/ThreadResumeResponse.json",
  "CommandExecutionRequestApprovalParams.json", "CommandExecutionRequestApprovalResponse.json",
  "FileChangeRequestApprovalParams.json", "FileChangeRequestApprovalResponse.json",
  "PermissionsRequestApprovalParams.json", "PermissionsRequestApprovalResponse.json", "v2/ServerRequestResolvedNotification.json",
]);
export function methods(schema) {
  if (!Array.isArray(schema.oneOf) || !schema.oneOf.length) throw new Error("Native schema union missing");
  const result = schema.oneOf.map(row => {
    const definition = row?.properties?.method;
    if (definition?.type !== "string" || definition.enum?.length !== 1 || typeof definition.enum[0] !== "string"
      || !row.required?.includes("method")) throw new Error("Unexpected native method schema");
    return definition.enum[0];
  });
  if (new Set(result).size !== result.length) throw new Error("Duplicate native methods");
  return result.sort();
}
export function probeEnvironment(home) {
  const result = { HOME: home, USERPROFILE: home, CODEX_HOME: path.join(home, "codex"), XDG_CONFIG_HOME: path.join(home, ".config"),
    XDG_CACHE_HOME: path.join(home, ".cache"), PATH: path.dirname(process.execPath) + path.delimiter + (process.platform === "win32" ? "" : "/usr/bin:/bin") };
  for (const key of ["SystemRoot", "SYSTEMROOT", "WINDIR", "TEMP", "TMP", "TMPDIR", "LANG", "LC_ALL"])
    if (process.env[key]) result[key] = process.env[key];
  return result;
}
export async function capture(binary) {
  if (!path.isAbsolute(binary)) throw new Error("Provide the absolute official native Codex binary, not a shell/model-routing wrapper");
  const executable = await fs.realpath(binary), home = await fs.mkdtemp(path.join(os.tmpdir(), "stepsemble-codex-schema-"));
  try {
    const env = probeEnvironment(home), out = path.join(home, "schemas");
    const options = { cwd: home, env, timeout: 20000, maxBuffer: 1024 * 1024 };
    const version = await exec(executable, ["--version"], options);
    if (version.stdout.trim() !== `codex-cli ${VERSION}`) throw new Error(`Expected official Codex ${VERSION}; review a new version separately`);
    await exec(executable, ["app-server", "generate-json-schema", "--out", out], options);
    const schemas = [], catalogs = {};
    for (const name of SCHEMAS) {
      const bytes = await fs.readFile(path.join(out, name));
      const schema = JSON.parse(bytes.toString("utf8"));
      if (bytes.length > 16 * 1024 * 1024 || schema.$schema !== "http://json-schema.org/draft-07/schema#") throw new Error("Unexpected native schema format");
      schemas.push({ file: name, bytes: bytes.length, sha256: crypto.createHash("sha256").update(bytes).digest("hex") });
      if (["ClientRequest.json", "ServerRequest.json", "ServerNotification.json"].includes(name)) catalogs[name] = methods(schema);
    }
    return { fixtureVersion: 1, nativeVersion: VERSION,
      scope: "Official CLI generated schema metadata only; no app-server startup, model, account, thread or approval execution", schemas, catalogs };
  } finally { await fs.rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [binary, flag, ...rest] = process.argv.slice(2);
  if (!binary || rest.length || (flag && flag !== "--record")) throw new Error("Usage: check-native-codex-schema.mjs /absolute/native/codex [--record]");
  const value = await capture(binary), output = JSON.stringify(value, null, 2) + "\n";
  const target = path.join(root, `protocol/native/codex/${VERSION}-schema.json`);
  if (flag === "--record") await fs.writeFile(target, output);
  else if ((await fs.readFile(target, "utf8")).replace(/\r\n/g, "\n") !== output) throw new Error("Native Codex schema changed; review instead of silently accepting drift");
  console.log(`Native Codex ${VERSION}: ${value.schemas.length} schema hashes; ${Object.values(value.catalogs).map(values => values.length).join("/")} request/server-request/notification methods verified (metadata only).`);
}
