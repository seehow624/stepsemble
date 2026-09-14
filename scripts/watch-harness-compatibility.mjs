#!/usr/bin/env node

// Local, metadata-only harness compatibility watcher.
// It observes installed binaries and runs bounded preflights. It never logs
// in, starts a turn, selects a model, edits the compatibility registry, or
// enables a write/approval capability by itself.
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);
const { probeCodexCompatibility } = require("../server/codex-compatibility.js");
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_REGISTRY = path.join(ROOT, "protocol", "harness-compatibility.json");
const DEFAULT_STATE = path.join(os.homedir(), ".config", "stepsemble", "harness-compatibility.json");
const MAX_VERSION_BYTES = 64 * 1024;
const DEFAULT_TIMEOUT_MS = 8_000;
const SENSITIVE_ENV = [
  "OPENAI_API_KEY", "CODEX_API_KEY", "CODEX_REMOTE_TOKEN", "OPENCODEX_API_AUTH_TOKEN",
  "ANTHROPIC_API_KEY", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX",
  "GEMINI_API_KEY", "GOOGLE_API_KEY", "XAI_API_KEY",
];

function usageError(message) {
  const error = new Error(message);
  error.code = "invalid_arguments";
  return error;
}

function parseArgs(argv) {
  const options = {
    registryFile: DEFAULT_REGISTRY,
    stateFile: process.env.STEPSEMBLE_HARNESS_STATE_FILE || DEFAULT_STATE,
    intervalSeconds: null,
    watch: false,
    json: false,
    failOnUnreviewed: false,
    harnesses: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--watch") options.watch = true;
    else if (arg === "--json") options.json = true;
    else if (arg === "--fail-on-unreviewed") options.failOnUnreviewed = true;
    else if (arg === "--registry" || arg === "--state-file" || arg === "--interval") {
      const value = argv[++index];
      if (!value) throw usageError(`Missing value for ${arg}`);
      if (arg === "--registry") options.registryFile = value;
      if (arg === "--state-file") options.stateFile = value;
      if (arg === "--interval") options.intervalSeconds = Number(value);
    } else if (arg === "--harness") {
      const value = argv[++index];
      if (!value) throw usageError("Missing value for --harness");
      options.harnesses = options.harnesses || [];
      options.harnesses.push(value);
    } else if (arg === "--once") {
      options.watch = false;
    } else {
      throw usageError(`Unknown option: ${arg}`);
    }
  }
  if (!path.isAbsolute(options.registryFile) || !path.isAbsolute(options.stateFile)) {
    throw usageError("--registry and --state-file must be absolute paths");
  }
  if (options.intervalSeconds !== null && (!Number.isInteger(options.intervalSeconds) || options.intervalSeconds < 60 || options.intervalSeconds > 7 * 24 * 60 * 60)) {
    throw usageError("--interval must be an integer between 60 and 604800 seconds");
  }
  return options;
}

function cleanEnvironment(source = process.env) {
  const env = { ...source };
  for (const key of SENSITIVE_ENV) delete env[key];
  env.STEPSEMBLE_COMPATIBILITY_PROBE = "1";
  return env;
}

async function isExecutable(file) {
  if (!file || !path.isAbsolute(file)) return false;
  const stat = await fs.stat(file).catch(() => null);
  if (!stat?.isFile()) return false;
  if (process.platform === "win32") return true;
  return (stat.mode & 0o111) !== 0;
}

async function resolveExecutable(entry, env = process.env) {
  const explicit = entry.executableEnv ? env[entry.executableEnv] : "";
  const candidates = explicit ? [explicit] : Array.isArray(entry.commands) ? entry.commands : [];
  const pathEntries = String(env.PATH || "").split(path.delimiter).filter(Boolean);
  const extensions = process.platform === "win32" ? ["", ".exe", ".cmd", ".bat"] : [""];
  for (const candidate of candidates) {
    if (!candidate) continue;
    if (path.isAbsolute(candidate)) {
      if (await isExecutable(candidate)) return path.resolve(candidate);
      continue;
    }
    if (candidate.includes(path.sep)) continue;
    for (const directory of pathEntries) {
      for (const extension of extensions) {
        const file = path.resolve(directory, `${candidate}${extension}`);
        if (await isExecutable(file)) return file;
      }
    }
  }
  return null;
}

async function readVersion(executable, { env = process.env, timeoutMs = DEFAULT_TIMEOUT_MS, exec = execFileAsync } = {}) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "stepsemble-harness-version-"));
  try {
    const isolated = cleanEnvironment(env);
    isolated.HOME = home;
    isolated.USERPROFILE = home;
    isolated.XDG_CONFIG_HOME = path.join(home, ".config");
    isolated.XDG_CACHE_HOME = path.join(home, ".cache");
    if (process.platform === "win32") {
      isolated.APPDATA = path.join(home, "AppData", "Roaming");
      isolated.LOCALAPPDATA = path.join(home, "AppData", "Local");
    }
    const result = await exec(executable, ["--version"], {
      cwd: home,
      env: isolated,
      shell: false,
      timeout: timeoutMs,
      maxBuffer: MAX_VERSION_BYTES,
    });
    const output = String(result?.stdout || result?.stderr || "").trim();
    if (!output) throw Object.assign(new Error("Harness did not report a version"), { code: "version_missing" });
    return output.split(/\r?\n/, 1)[0].trim();
  } finally {
    await fs.rm(home, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 }).catch(() => {});
  }
}

function stableDigest(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

async function readState(file) {
  try {
    const parsed = JSON.parse(await fs.readFile(file, "utf8"));
    if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.harnesses)) return {};
    return parsed;
  } catch {
    return {};
  }
}

async function writeState(file, value) {
  const directory = path.dirname(file);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    await fs.chmod(temporary, 0o600).catch(() => {});
    await fs.rename(temporary, file);
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => {});
  }
}

function validateRegistry(registry) {
  if (!registry || registry.registryVersion !== 1 || !Array.isArray(registry.harnesses) || registry.harnesses.length > 32) {
    throw usageError("Invalid harness compatibility registry");
  }
  if (registry.pollIntervalSeconds !== undefined
    && (!Number.isInteger(registry.pollIntervalSeconds) || registry.pollIntervalSeconds < 60 || registry.pollIntervalSeconds > 7 * 24 * 60 * 60)) {
    throw usageError("Invalid harness watcher poll interval");
  }
  const ids = new Set();
  for (const entry of registry.harnesses) {
    if (!entry || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(entry.id) || ids.has(entry.id)) throw usageError("Invalid or duplicate harness id");
    ids.add(entry.id);
    if (typeof entry.label !== "string" || typeof entry.kind !== "string" || !Array.isArray(entry.commands)) throw usageError(`Invalid harness entry: ${entry.id}`);
  }
  return registry;
}

async function collectHarnesses(registry, {
  env = process.env,
  previous = {},
  selected = null,
  resolve = resolveExecutable,
  version = readVersion,
  codex = probeCodexCompatibility,
} = {}) {
  const previousById = new Map((previous.harnesses || []).map(item => [item.id, item]));
  const entries = selected?.length ? registry.harnesses.filter(item => selected.includes(item.id)) : registry.harnesses;
  const unknownSelected = selected?.filter(id => !registry.harnesses.some(item => item.id === id)) || [];
  if (unknownSelected.length) throw usageError(`Unknown harness: ${unknownSelected.join(", ")}`);
  const results = [];
  for (const entry of entries) {
    const observed = {
      id: entry.id,
      label: entry.label,
      kind: entry.kind,
      probe: entry.probe,
      executable: null,
      nativeVersion: null,
      verification: entry.probe === "manual" ? "manual" : "not-probed",
      status: "not-configured",
      capabilities: { historyRead: false, historyPages: false, sessionResume: false, mutations: false, approvals: false },
      error: null,
    };
    const executable = await resolve(entry, env);
    if (!executable) {
      observed.status = entry.probe === "manual" ? "manual" : "not-installed";
      observed.observation = stableDigest({ status: observed.status, nativeVersion: null, executable: null });
      observed.changeDetected = previousById.has(entry.id) && previousById.get(entry.id)?.observation !== observed.observation;
      results.push(observed);
      continue;
    }
    observed.executable = executable;
    try {
      const versionOutput = await version(executable, { env });
      observed.nativeVersion = versionOutput;
      if (entry.probe === "codex-compatibility") {
        const compatibility = await codex(executable, { env, versionOutput });
        observed.verification = compatibility.verification;
        observed.status = compatibility.capabilities?.mutations ? "compatible" : "read-only";
        observed.capabilities = { ...observed.capabilities, ...(compatibility.capabilities || {}) };
        observed.profileId = compatibility.profileId;
        observed.schemaFingerprint = compatibility.schemaFingerprint;
      } else {
        observed.status = "version-observed";
        observed.verification = "version-only";
      }
    } catch (error) {
      observed.status = "needs-review";
      observed.verification = "failed-preflight";
      observed.error = { code: error.code || "probe_failed", message: String(error.message || error).slice(0, 500) };
      if (error.nativeVersion) observed.nativeVersion = error.nativeVersion;
      if (error.schemaFingerprint) observed.schemaFingerprint = error.schemaFingerprint;
    }
    observed.observation = stableDigest({
      executable: observed.executable,
      nativeVersion: observed.nativeVersion,
      verification: observed.verification,
      profileId: observed.profileId || null,
      schemaFingerprint: observed.schemaFingerprint || null,
      capabilities: observed.capabilities,
      status: observed.status,
    });
    const hadPrevious = previousById.has(entry.id);
    observed.changeDetected = hadPrevious && previousById.get(entry.id)?.observation !== observed.observation;
    if (entry.probe === "version-only" && observed.changeDetected) {
      observed.status = "needs-review";
      observed.verification = "version-change-review";
      observed.observation = stableDigest({
        executable: observed.executable,
        nativeVersion: observed.nativeVersion,
        verification: observed.verification,
        capabilities: observed.capabilities,
        status: observed.status,
      });
    }
    results.push(observed);
  }
  return results;
}

async function runOnce(options, dependencies = {}) {
  const registry = validateRegistry(JSON.parse(await fs.readFile(options.registryFile, "utf8")));
  const previous = await readState(options.stateFile);
  const harnesses = await collectHarnesses(registry, {
    ...dependencies,
    previous,
    selected: options.harnesses,
  });
  const report = {
    schemaVersion: 1,
    registryVersion: registry.registryVersion,
    pollIntervalSeconds: registry.pollIntervalSeconds || 21600,
    checkedAt: new Date().toISOString(),
    host: { platform: process.platform, arch: process.arch, node: process.version },
    harnesses,
  };
  await writeState(options.stateFile, report);
  return report;
}

function printReport(report, json) {
  if (json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  for (const harness of report.harnesses) {
    const change = harness.changeDetected ? " changed" : "";
    console.log(`${harness.label}: ${harness.status}${change}${harness.nativeVersion ? ` (${harness.nativeVersion})` : ""}`);
  }
}

function shouldFail(report) {
  return report.harnesses.some(item => item.status === "needs-review");
}

async function main(argv = process.argv.slice(2), dependencies = {}) {
  const options = parseArgs(argv);
  const interval = options.intervalSeconds || null;
  do {
    const report = await runOnce(options, dependencies);
    printReport(report, options.json);
    if (options.failOnUnreviewed && shouldFail(report)) process.exitCode = 1;
    if (!options.watch) return report;
    await new Promise(resolve => setTimeout(resolve, (interval || report.pollIntervalSeconds || 21600) * 1000));
  } while (true);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    await main();
  } catch (error) {
    console.error(JSON.stringify({ code: error.code || "harness_watcher_failed", message: error.message }, null, 2));
    process.exitCode = error.code === "invalid_arguments" ? 2 : 1;
  }
}

export {
  cleanEnvironment,
  collectHarnesses,
  main,
  parseArgs,
  readState,
  resolveExecutable,
  runOnce,
  shouldFail,
  validateRegistry,
  writeState,
};
