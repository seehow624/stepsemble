"use strict";

// Codex releases are versioned independently from the app-server contract.
// Keep the compatibility decision in one small, read-only module so a newer
// CLI can be probed before Stepsemble starts a real native transport.

const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");

const execFileAsync = promisify(execFile);
const REGISTRY = require("../protocol/native/codex/compatibility.json");
const VERSION_RE = /^codex-cli\s+(\d{1,8}\.\d{1,8}\.\d{1,8})(?:-(alpha|beta)(?:\.\d{1,8}){0,2})?$/;
const MAX_SCHEMA_BYTES = 16 * 1024 * 1024;
const MAX_SCHEMA_FILES = 128;

const SCHEMA_FILES = Object.freeze([...REGISTRY.schemaFiles]);
const PROFILES = Object.freeze(REGISTRY.profiles.map(profile => Object.freeze({
  ...profile,
  capabilities: Object.freeze({ ...(profile.capabilities || {}) }),
})));

function cleanVersionOutput(value) {
  return String(value ?? "").trim().split(/\r?\n/, 1)[0].trim();
}

function parseCodexVersion(value) {
  const raw = cleanVersionOutput(value);
  const match = VERSION_RE.exec(raw);
  if (!match) return null;
  return Object.freeze({
    raw,
    version: match[1],
    channel: match[2] || "stable",
  });
}

function compatibilityError(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, details);
  return error;
}

function schemaFingerprint(rows) {
  if (!Array.isArray(rows) || rows.length !== SCHEMA_FILES.length) {
    throw compatibilityError("codex_schema_incomplete", "Codex compatibility schema is incomplete");
  }
  const sorted = rows
    .map(row => ({ file: String(row?.file || ""), bytes: row?.bytes, sha256: String(row?.sha256 || "") }))
    .sort((left, right) => left.file.localeCompare(right.file));
  if (sorted.some(row => !SCHEMA_FILES.includes(row.file)
    || !Number.isSafeInteger(row.bytes) || row.bytes < 0
    || !/^[a-f0-9]{64}$/.test(row.sha256))) {
    throw compatibilityError("codex_schema_invalid", "Codex compatibility schema metadata is invalid");
  }
  if (new Set(sorted.map(row => row.file)).size !== SCHEMA_FILES.length) {
    throw compatibilityError("codex_schema_incomplete", "Codex compatibility schema contains duplicate files");
  }
  return crypto.createHash("sha256").update(JSON.stringify(sorted)).digest("hex");
}

function profileForVersion(version) {
  return PROFILES.find(profile => profile.version === version) || null;
}

function profileForFingerprint(fingerprint) {
  return PROFILES.find(profile => profile.schemaFingerprint === fingerprint) || null;
}

function publicProfile(profile, { nativeVersion = profile?.version, observedFingerprint = null, verification = profile?.verification } = {}) {
  if (!profile) return null;
  return Object.freeze({
    profileId: profile.profileId,
    nativeVersion,
    channel: profile.channel,
    schemaFingerprint: observedFingerprint || profile.schemaFingerprint,
    verification,
    capabilities: Object.freeze({ ...profile.capabilities }),
  });
}

function isolatedEnvironment(home, source = process.env) {
  const env = { ...source,
    HOME: home,
    USERPROFILE: home,
    CODEX_HOME: path.join(home, "codex"),
    XDG_CONFIG_HOME: path.join(home, ".config"),
    XDG_CACHE_HOME: path.join(home, ".cache"),
  };
  // Schema generation must never inherit an account token, model proxy, or
  // third-party OpenCodex credential. The executable is passed by absolute
  // path and the command is metadata-only.
  for (const key of [
    "OPENAI_API_KEY", "CODEX_API_KEY", "CODEX_REMOTE_TOKEN", "OPENCODEX_API_AUTH_TOKEN",
    "ANTHROPIC_API_KEY", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX",
  ]) delete env[key];
  return env;
}

async function captureSchemaFingerprint(executable, { cwd = process.cwd(), env = process.env, timeoutMs = 20000 } = {}) {
  if (typeof executable !== "string" || !path.isAbsolute(executable)) {
    throw compatibilityError("codex_executable_absolute_required", "Codex compatibility probe requires an absolute executable");
  }
  const realExecutable = await fs.realpath(executable);
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "stepsemble-codex-compat-"));
  const out = path.join(home, "schemas");
  try {
    await fs.mkdir(path.join(home, "codex"), { recursive: true, mode: 0o700 });
    await fs.mkdir(out, { recursive: true, mode: 0o700 });
    const isolated = isolatedEnvironment(home, env);
    await execFileAsync(realExecutable, ["app-server", "generate-json-schema", "--out", out], {
      cwd: home,
      env: isolated,
      shell: false,
      timeout: timeoutMs,
      maxBuffer: 1024 * 1024,
    });
    const rows = [];
    for (const file of SCHEMA_FILES) {
      const filename = path.join(out, file);
      const stat = await fs.stat(filename).catch(() => null);
      if (!stat || !stat.isFile() || stat.size > MAX_SCHEMA_BYTES) {
        throw compatibilityError("codex_schema_incomplete", `Codex schema file is missing or too large: ${file}`);
      }
      const bytes = await fs.readFile(filename);
      rows.push({ file, bytes: bytes.length, sha256: crypto.createHash("sha256").update(bytes).digest("hex") });
    }
    if (rows.length > MAX_SCHEMA_FILES) throw compatibilityError("codex_schema_limit", "Codex schema file count exceeded the safety limit");
    return Object.freeze({ fingerprint: schemaFingerprint(rows), schemas: rows });
  } finally {
    await fs.rm(home, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 }).catch(() => {});
  }
}

function initializeParams(profile) {
  return {
    clientInfo: {
      name: "stepsemble",
      title: "Stepsemble",
      version: "3.0.31",
    },
    // thread/turns/list and several lifecycle fields are experimental in the
    // public app-server contract. Opting in here is capability negotiation,
    // not permission to mutate a thread.
    capabilities: { experimentalApi: profile?.capabilities?.turns === true },
  };
}

const compatibilityCache = new Map();

async function probeCodexCompatibility(executable, {
  cwd = process.cwd(),
  env = process.env,
  versionOutput = null,
  versionProbe = null,
  schemaProbe = null,
  cache = compatibilityCache,
} = {}) {
  const output = versionOutput !== null && versionOutput !== undefined
    ? versionOutput
    : typeof versionProbe === "function"
      ? await versionProbe(executable, { cwd, env: { ...env } })
      : (await execFileAsync(executable, ["--version"], {
        cwd,
        env: { ...env },
        shell: false,
        timeout: 5000,
        maxBuffer: 64 * 1024,
      })).stdout;
  const parsed = parseCodexVersion(typeof output === "string" ? output : output?.stdout || output?.version);
  if (!parsed) throw compatibilityError("invalid_codex_version", "Codex executable did not report a supported version");
  if (parsed.channel !== "stable") {
    throw compatibilityError("unsupported_codex_native_version", "Pre-release Codex builds remain fail-closed", {
      nativeVersion: parsed.version,
      channel: parsed.channel,
    });
  }

  const realExecutable = await fs.realpath(executable).catch(() => executable);
  const stat = await fs.stat(executable).catch(() => null);
  const binaryIdentity = stat
    ? `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}`
    : "unstatable";
  const cacheKey = `${realExecutable}:${parsed.version}:${binaryIdentity}`;
  if (cache?.has(cacheKey)) return cache.get(cacheKey);

  const observed = typeof schemaProbe === "function"
    ? await schemaProbe(executable, { cwd, env: { ...env }, version: parsed.version })
    : await captureSchemaFingerprint(executable, { cwd, env });
  const fingerprint = typeof observed === "string" ? observed : observed?.fingerprint;
  if (!/^[a-f0-9]{64}$/.test(String(fingerprint))) {
    throw compatibilityError("codex_schema_invalid", "Codex compatibility probe returned no valid schema fingerprint");
  }
  const exact = profileForVersion(parsed.version);
  const matched = profileForFingerprint(fingerprint);
  if (!matched || exact && exact.schemaFingerprint !== fingerprint) {
    throw compatibilityError("codex_schema_mismatch", "Codex app-server schema is not reviewed by Stepsemble", {
      nativeVersion: parsed.version,
      schemaFingerprint: fingerprint,
    });
  }

  const source = exact || matched;
  const isExactProfile = source.version === parsed.version;
  const capabilities = {
    ...source.capabilities,
    // A schema-equivalent future release is safe for bounded reads, but its
    // writes remain disabled until the exact release has passed the owned
    // approval contract.
    ...(isExactProfile ? {} : { sessionResume: false, mutations: false, approvals: false }),
  };
  const result = Object.freeze({
    ...publicProfile({ ...source, capabilities }, {
      nativeVersion: parsed.version,
      observedFingerprint: fingerprint,
      verification: isExactProfile ? source.verification : "schema-fingerprint-readonly",
    }),
    initializeParams: initializeParams({ ...source, capabilities }),
    schemas: Array.isArray(observed?.schemas) ? observed.schemas : null,
  });
  cache?.set(cacheKey, result);
  return result;
}

function registry() {
  return Object.freeze({
    registryVersion: REGISTRY.registryVersion,
    schemaFiles: [...SCHEMA_FILES],
    profiles: PROFILES.map(profile => publicProfile(profile)),
  });
}

module.exports = {
  SCHEMA_FILES,
  parseCodexVersion,
  schemaFingerprint,
  captureSchemaFingerprint,
  probeCodexCompatibility,
  registry,
};
