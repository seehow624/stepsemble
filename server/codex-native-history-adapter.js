"use strict";

// Bridge to the official Codex app-server.  History remains opt-in.  Mutations
// have a second opt-in (`STEPSEMBLE_CODEX_NATIVE_MUTATIONS=1`) and a small
// owner-only intent journal: every native write is authorized and persisted
// before JSON-RPC IO, then settled only from a bounded native result.  This is
// deliberately `structured_ack_required`, not a claim of Codex client parity.

const fs = require("node:fs");
const path = require("node:path");
const { CONNECTOR_DEFINITIONS, resolveCommand } = require("./agent-connectors");
const {
  CODEX_NATIVE_VERSION,
  launchCodexAppServer,
} = require("./codex-app-server-transport");
const {
  probeCodexCompatibility,
} = require("./codex-compatibility");
const {
  normalizeModelListResponse,
  normalizeTokenUsageBreakdown,
  normalizeTurnInput,
} = require("./codex-app-server-transport");
const crypto = require("node:crypto");

const MAX_THREADS = 100;
const MAX_PAGE = 100;
// A full turn/item page can contain model output and tool logs. Keep the
// default HTTP read small enough for the app-server's bounded JSONL frame;
// callers may request a larger page up to MAX_PAGE when they have measured it.
const DEFAULT_TURN_PAGE = 20;
const DEFAULT_ITEM_PAGE = 50;
const MAX_THREAD_ID = 256;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const TRUTHY = new Set(["1", "true", "yes", "on"]);
const MUTATION_OPERATIONS = new Set(["thread.start", "thread.resume", "turn.start", "turn.interrupt", "approval.resolve"]);
const MAX_MUTATION_ROWS = 256;
const MAX_MODEL_ID = 256;
const MAX_REASONING_EFFORT = 128;
// Context usage is not part of the persisted thread/read contract.  The
// adapter therefore keeps only a small, owner-written last observation.  This
// is deliberately a row-per-thread store (or one bounded file when used
// directly), never a scan of Codex's private rollout files.
const CONTEXT_SNAPSHOT_VERSION = 1;
const MAX_CONTEXT_SNAPSHOTS = 256;
const MAX_CONTEXT_SNAPSHOT_BYTES = 256 * 1024;
const MAX_CONTEXT_SNAPSHOT_TEXT = 512;
const CONTEXT_SNAPSHOT_CLOCK_SKEW_MS = 30_000;
const CONTEXT_SNAPSHOT_FILE = "codex-native-context.json";

class CodexNativeHistoryError extends Error {
  constructor(code, message, statusCode = 503, details = {}) {
    super(message);
    this.name = "CodexNativeHistoryError";
    this.code = code;
    this.statusCode = statusCode;
    Object.assign(this, details);
  }
}

function enabledValue(value) {
  return TRUTHY.has(String(value ?? "").trim().toLowerCase());
}

function mutationId(prefix) { return `${prefix}-${crypto.randomUUID()}`; }
function jsonHash(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 32);
}
function mutationFilePath(value, fallback) {
  const raw = String(value ?? fallback ?? "").trim();
  if (!raw || !path.isAbsolute(raw) || /[\u0000-\u001f\u007f]/.test(raw) || raw.length > 4096) return null;
  return path.normalize(raw);
}

function contextSnapshotPath(value, fallback) {
  const raw = String(value ?? fallback ?? "").trim();
  if (!raw || !path.isAbsolute(raw) || /[\u0000-\u001f\u007f]/.test(raw) || raw.length > 4096) return null;
  return path.normalize(raw);
}

function contextSnapshotRoot(value, fallback) {
  const result = contextSnapshotPath(value, fallback);
  return result;
}

function validSnapshotTime(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function snapshotHash(threadId) {
  return crypto.createHash("sha256").update(threadId, "utf8").digest("hex");
}

function readBoundedUtf8(filename, maxBytes = MAX_CONTEXT_SNAPSHOT_BYTES) {
  if (!filename) return null;
  // These snapshots are owner-only state.  If this process cannot prove the
  // file belongs to the current owner, fail closed instead of displaying it.
  if (typeof process.getuid !== "function") return null;
  let fd;
  try {
    const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0);
    fd = fs.openSync(filename, flags);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size < 0 || stat.size > maxBytes || stat.nlink !== 1
      || stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0) return null;
    const buffer = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < buffer.length) {
      const read = fs.readSync(fd, buffer, offset, buffer.length - offset, offset);
      if (!read) break;
      offset += read;
    }
    if (offset !== buffer.length) return null;
    return buffer.toString("utf8");
  } catch { return null; }
  finally { if (fd !== undefined) { try { fs.closeSync(fd); } catch {} } }
}

function ensureOwnedSnapshotDirectory(directory) {
  if (!directory || !path.isAbsolute(directory) || typeof process.getuid !== "function") return false;
  const normalized = path.normalize(directory);
  const parsed = path.parse(normalized);
  if (normalized === parsed.root) return false;
  let current = parsed.root;
  const parts = path.relative(parsed.root, normalized).split(path.sep).filter(Boolean);
  try {
    for (const part of parts) {
      current = path.join(current, part);
      let stat;
      try {
        const link = fs.lstatSync(current);
        // macOS exposes /var as a root-level compatibility symlink.  Permit
        // that OS path only; a caller-controlled nested symlink would make the
        // owner-only root ambiguous and is rejected.
        if (link.isSymbolicLink()) {
          if (path.dirname(current) !== parsed.root) return false;
          stat = fs.statSync(current);
          if (!stat.isDirectory()) return false;
        } else if (!link.isDirectory()) return false;
        if (!stat) stat = fs.statSync(current);
      } catch (error) {
        if (error?.code !== "ENOENT") return false;
        fs.mkdirSync(current, { mode: 0o700 });
        stat = fs.statSync(current);
      }
      const rootOwnedSticky = stat.uid === 0 && (stat.mode & 0o1000) !== 0;
      const trustedOwner = stat.uid === process.getuid() || stat.uid === 0;
      if (!trustedOwner || (stat.mode & 0o022) !== 0 && !rootOwnedSticky) return false;
      if (current === normalized && (stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0)) return false;
    }
    return true;
  } catch { return false; }
}

function snapshotFileForRoot(root, threadId) {
  return root && validThreadId(threadId) ? path.join(root, `${snapshotHash(threadId)}.json`) : null;
}

function boundedSnapshotFileCount(directory) {
  if (!directory || typeof process.getuid !== "function") return null;
  let handle;
  let count = 0;
  try {
    handle = fs.opendirSync(directory);
    for (let index = 0; index <= MAX_CONTEXT_SNAPSHOTS; index += 1) {
      const entry = handle.readSync();
      if (!entry) return count;
      if (!/^[a-f0-9]{64}\.json$/.test(entry.name)) continue;
      const filename = path.join(directory, entry.name);
      let stat;
      try {
        const link = fs.lstatSync(filename);
        if (link.isSymbolicLink()) return null;
        stat = fs.statSync(filename);
      } catch { return null; }
      if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0) return null;
      count += 1;
      if (count > MAX_CONTEXT_SNAPSHOTS) return count;
    }
    // A full bounded directory read is not evidence that the directory is
    // below the cap; fail closed rather than undercounting entries beyond it.
    return MAX_CONTEXT_SNAPSHOTS + 1;
  } catch { return null; }
  finally { try { handle?.closeSync(); } catch {} }
}

function safeSnapshotString(value, limit = MAX_CONTEXT_SNAPSHOT_TEXT) {
  return typeof value === "string" && value.length > 0 && value.length <= limit
    && !/[\u0000-\u001f\u007f]/.test(value) ? value : null;
}
function loadMutationJournal(filename) {
  if (!filename) return { version: 1, operations: [] };
  try {
    const parsed = JSON.parse(fs.readFileSync(filename, "utf8"));
    if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.operations)) return { version: 1, operations: [] };
    return { version: 1, operations: parsed.operations.filter(row => row && typeof row === "object").slice(-MAX_MUTATION_ROWS) };
  } catch { return { version: 1, operations: [] }; }
}
function persistMutationJournal(filename, journal) {
  if (!filename) return false;
  try {
    fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
    try { fs.chmodSync(path.dirname(filename), 0o700); } catch {}
    const temp = `${filename}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
    fs.writeFileSync(temp, JSON.stringify({ version: 1, operations: journal.operations.slice(-MAX_MUTATION_ROWS) }) + "\n", { mode: 0o600 });
    try { fs.chmodSync(temp, 0o600); } catch {}
    fs.renameSync(temp, filename);
    try { fs.chmodSync(filename, 0o600); } catch {}
    return true;
  } catch { return false; }
}

function cleanText(value, limit = 512) {
  return String(value ?? "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ")
    .slice(0, limit);
}

function absoluteDirectory(value, fallback) {
  const raw = String(value ?? fallback ?? "").trim();
  if (!raw || raw.length > 4096 || !path.isAbsolute(raw) || /[\u0000-\u001f\u007f]/.test(raw)) return null;
  const normalized = path.normalize(raw);
  try {
    if (!fs.statSync(normalized).isDirectory()) return null;
  } catch { return null; }
  return normalized;
}

function executablePath(value, env, includeKnownPaths = true) {
  const explicit = String(value ?? "").trim();
  if (explicit) {
    if (!path.isAbsolute(explicit)) return null;
    try {
      const stat = fs.statSync(explicit);
      if (!stat.isFile()) return null;
      if (process.platform !== "win32") fs.accessSync(explicit, fs.constants.X_OK);
      return fs.realpathSync.native(explicit);
    } catch { return null; }
  }
  const definition = CONNECTOR_DEFINITIONS.find(item => item.id === "codex");
  return resolveCommand(definition, { env, includeKnownPaths });
}

function resolveConfig(env = process.env, overrides = {}) {
  const enabled = overrides.enabled === undefined
    ? enabledValue(env?.STEPSEMBLE_CODEX_NATIVE) || !!env?.STEPSEMBLE_CODEX_APP_SERVER
    : overrides.enabled === true;
  const mutationEnabled = overrides.mutationEnabled === undefined
    ? enabledValue(env?.STEPSEMBLE_CODEX_NATIVE_MUTATIONS)
    : overrides.mutationEnabled === true;
  const executable = executablePath(overrides.executable ?? env?.STEPSEMBLE_CODEX_BIN, env,
    overrides.includeKnownPaths !== false);
  const cwd = absoluteDirectory(overrides.cwd ?? env?.STEPSEMBLE_CODEX_CWD, process.cwd());
  const journalFile = mutationFilePath(overrides.journalFile ?? env?.STEPSEMBLE_CODEX_MUTATION_JOURNAL,
    cwd ? path.join(cwd, ".stepsemble", "codex-native-mutations.json") : null);
  const contextSnapshotFile = contextSnapshotPath(
    overrides.contextSnapshotFile ?? env?.STEPSEMBLE_CODEX_CONTEXT_SNAPSHOT,
    journalFile ? path.join(path.dirname(journalFile), CONTEXT_SNAPSHOT_FILE) : null,
  );
  const contextSnapshotRootValue = overrides.contextSnapshotRoot ?? env?.STEPSEMBLE_CODEX_CONTEXT_ROOT;
  const contextSnapshotRootResolved = contextSnapshotRootValue
    ? contextSnapshotRoot(contextSnapshotRootValue)
    : null;
  return Object.freeze({
    enabled,
    mutationEnabled,
    executable,
    cwd,
    journalFile,
    contextSnapshotFile,
    contextSnapshotRoot: contextSnapshotRootResolved,
    configured: enabled && !!executable && !!cwd,
    error: !enabled ? "disabled" : !executable ? "codex_executable_unavailable" : !cwd ? "codex_cwd_unavailable" : null,
  });
}

function validThreadId(value) {
  return typeof value === "string" && value.length <= MAX_THREAD_ID && ID.test(value);
}

function validOverride(value, limit) {
  return value === undefined || value === null
    || typeof value === "string" && value.length > 0 && value.length <= limit && !/[\u0000-\u001f\u007f]/.test(value);
}

function validTurnOptions(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    && validOverride(value.model, MAX_MODEL_ID) && validOverride(value.effort, MAX_REASONING_EFFORT);
}

function nativeUsageSnapshot(value) {
  const source = value?.tokenUsage && typeof value.tokenUsage === "object" ? value : { tokenUsage: value };
  const tokenUsage = source.tokenUsage;
  if (!tokenUsage || typeof tokenUsage !== "object") return null;
  const last = normalizeTokenUsageBreakdown(tokenUsage.last);
  if (!last) return null;
  const contextWindow = tokenUsage.modelContextWindow === null || tokenUsage.modelContextWindow === undefined
    ? null : Number.isSafeInteger(tokenUsage.modelContextWindow) && tokenUsage.modelContextWindow >= 0 ? tokenUsage.modelContextWindow : null;
  if (tokenUsage.modelContextWindow !== null && tokenUsage.modelContextWindow !== undefined && contextWindow === null) return null;
  return { threadId: validThreadId(source.threadId) ? source.threadId : null,
    turnId: validThreadId(source.turnId) ? source.turnId : null,
    tokenUsage: { last, modelContextWindow: contextWindow } };
}

function scopedNativeUsageSnapshot(threadId, value) {
  const snapshot = nativeUsageSnapshot(value);
  if (!snapshot || snapshot.threadId && snapshot.threadId !== threadId) return null;
  return snapshot.threadId ? snapshot : { ...snapshot, threadId };
}

function contextUsageDto(threadId, model, value, metadata = {}) {
  const candidate = nativeUsageSnapshot(value);
  const snapshot = candidate && (!candidate.threadId || candidate.threadId === threadId) ? candidate : null;
  const last = snapshot?.tokenUsage?.last || null;
  const contextWindow = snapshot?.tokenUsage?.modelContextWindow ?? null;
  const contextTokens = last?.totalTokens ?? null;
  const contextPercent = contextWindow !== null && contextWindow > 0 && contextTokens !== null
    ? (contextTokens / contextWindow) * 100 : null;
  return {
    model: typeof model === "string" && model.length ? model : null,
    contextWindow,
    contextTokens,
    contextPercent: Number.isFinite(contextPercent) ? contextPercent : null,
    usage: last ? { ...last } : null,
    source: metadata.source === "live" || metadata.source === "last_observed" ? metadata.source : "unknown",
    observedAt: validSnapshotTime(metadata.observedAt) ? new Date(metadata.observedAt).toISOString() : null,
    stale: metadata.source === "live" ? false : true,
  };
}

function normalizeContextSnapshotRow(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (!validThreadId(value.threadId) || !validSnapshotTime(value.observedAt)) return null;
  const usage = nativeUsageSnapshot({ threadId: value.threadId, turnId: value.turnId, tokenUsage: value.tokenUsage });
  if (!usage || usage.threadId !== value.threadId) return null;
  const turnId = usage.turnId;
  const sessionId = value.sessionId === null || value.sessionId === undefined ? null : validThreadId(value.sessionId) ? value.sessionId : null;
  const model = value.model === null || value.model === undefined ? null : safeSnapshotString(value.model, MAX_MODEL_ID);
  if (value.model !== null && value.model !== undefined && !model) return null;
  const createdAt = value.createdAt === null || value.createdAt === undefined ? null : validSnapshotTime(value.createdAt) ? value.createdAt : null;
  const threadUpdatedAt = value.threadUpdatedAt === null || value.threadUpdatedAt === undefined
    ? null : validSnapshotTime(value.threadUpdatedAt) ? value.threadUpdatedAt : null;
  if ((value.createdAt !== null && value.createdAt !== undefined && createdAt === null)
    || (value.threadUpdatedAt !== null && value.threadUpdatedAt !== undefined && threadUpdatedAt === null)) return null;
  const nativeVersion = value.nativeVersion === null || value.nativeVersion === undefined
    ? null : safeSnapshotString(value.nativeVersion, 64);
  const schemaFingerprint = value.schemaFingerprint === null || value.schemaFingerprint === undefined
    ? null : safeSnapshotString(value.schemaFingerprint, 128);
  if ((value.nativeVersion !== null && value.nativeVersion !== undefined && !nativeVersion)
    || (value.schemaFingerprint !== null && value.schemaFingerprint !== undefined && !schemaFingerprint)) return null;
  return {
    threadId: value.threadId,
    turnId,
    sessionId,
    model,
    createdAt,
    threadUpdatedAt,
    observedAt: value.observedAt,
    nativeVersion,
    schemaFingerprint,
    tokenUsage: usage.tokenUsage,
  };
}

function contextSnapshotPayload(rows) {
  const snapshots = [...rows.values()].slice(-MAX_CONTEXT_SNAPSHOTS);
  const payload = JSON.stringify({ version: CONTEXT_SNAPSHOT_VERSION, snapshots }) + "\n";
  return Buffer.byteLength(payload, "utf8") <= MAX_CONTEXT_SNAPSHOT_BYTES ? payload : null;
}

function epochMilliseconds(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return null;
  // Codex releases have exposed all three Unix timestamp precisions. Keep the
  // public DTO in milliseconds so one bad unit cannot move a thread into the
  // future and hide every other agent's session.
  if (number >= 1e17) return Math.floor(number / 1e6); // nanoseconds
  if (number >= 1e14) return Math.floor(number / 1e3); // microseconds
  if (number >= 1e11) return number; // milliseconds
  return number * 1000; // seconds
}

function statusType(value) {
  const type = String(value?.type || "");
  return ["notLoaded", "idle", "systemError", "active"].includes(type) ? type : "unknown";
}

function publicStatus(value) {
  const type = statusType(value);
  const running = type === "active";
  return {
    type,
    activeFlags: running && Array.isArray(value?.activeFlags) ? value.activeFlags.slice(0, 8).map(flag => cleanText(flag, 64)) : [],
  };
}

function publicThread(thread) {
  if (!thread || typeof thread !== "object" || !validThreadId(thread.id)) return null;
  const status = publicStatus(thread.status);
  const createdAt = epochMilliseconds(thread.createdAt);
  const updatedAt = epochMilliseconds(thread.updatedAt);
  const running = status.type === "active";
  return {
    id: thread.id,
    sessionId: validThreadId(thread.sessionId) ? thread.sessionId : thread.id,
    parentThreadId: validThreadId(thread.parentThreadId) ? thread.parentThreadId : null,
    forkedFromId: validThreadId(thread.forkedFromId) ? thread.forkedFromId : null,
    name: thread.name === null || thread.name === undefined ? null : cleanText(thread.name, 512) || null,
    cwd: cleanText(thread.cwd, 4096),
    cliVersion: cleanText(thread.cliVersion, 128),
    modelProvider: cleanText(thread.modelProvider, 128),
    model: thread.model === null || thread.model === undefined ? null : cleanText(thread.model, 256) || null,
    reasoningEffort: thread.reasoningEffort === null || thread.reasoningEffort === undefined ? null : cleanText(thread.reasoningEffort, 64) || null,
    preview: cleanText(thread.preview, 4096),
    createdAt,
    updatedAt,
    recencyAt: epochMilliseconds(thread.recencyAt),
    ephemeral: thread.ephemeral === true,
    status,
    isRunning: running,
    canAcceptDirectInput: thread.canAcceptDirectInput === true,
    historyMode: cleanText(thread.historyMode, 64) || null,
    source: typeof thread.source === "string" ? cleanText(thread.source, 64) : null,
    projectId: thread.projectId === null || thread.projectId === undefined ? null : cleanText(thread.projectId, 256) || null,
    // The transport deliberately excludes Codex's native on-disk path.  A
    // browser should not receive a private rollout location from this bridge.
    turns: Array.isArray(thread.turns) ? thread.turns : [],
  };
}

function taskFromThread(thread) {
  const value = publicThread(thread);
  if (!value) return null;
  const label = value.name || value.preview || `Codex ${value.id.slice(0, 8)}`;
  const status = value.status.type === "systemError" ? "failed" : value.isRunning ? "running" : "waiting";
  return {
    id: `codex:${value.id}`,
    taskId: `codex:${value.id}`,
    agentId: "codex",
    agent: "codex",
    connector: "codex",
    nativeCodex: true,
    nativeThreadId: value.id,
    nativeSessionId: value.sessionId,
    name: label,
    cwd: value.cwd,
    status,
    isRunning: value.isRunning,
    startedAt: value.createdAt,
    endedAt: value.isRunning ? null : value.updatedAt,
    lastActivityAt: value.updatedAt || value.createdAt,
    nativeStatus: value.status,
    history: "native_readonly",
    readOnly: true,
    model: value.model,
    modelProvider: value.modelProvider,
    preview: value.preview,
  };
}

function createCodexNativeHistoryAdapter({
  env = process.env,
  executable,
  cwd,
  enabled,
  includeKnownPaths = true,
  launch = launchCodexAppServer,
  transportFactory = null,
  clock = () => Date.now(),
  journalFile,
  contextSnapshotFile,
  contextSnapshotRoot,
  mutationEnabled,
  onEvent = null,
  onApprovalRequest = null,
  versionProbe = null,
  schemaProbe = null,
} = {}) {
  const config = resolveConfig(env, { executable, cwd, enabled, includeKnownPaths, journalFile, contextSnapshotFile, contextSnapshotRoot, mutationEnabled });
  const mutationJournal = loadMutationJournal(config.journalFile);
  const mutationRows = new Map(mutationJournal.operations.map(row => [row.operationId, row]));
  let mutationWriteError = null;
  let state = {
    adapter: "codex-app-server-v2",
    nativeVersion: null,
    compatibility: null,
    state: config.configured ? "configured" : config.enabled ? "unavailable" : "disabled",
    enabled: config.enabled,
    configured: config.configured,
    ready: false,
    history: "native_readonly",
    mutationEnabled: config.mutationEnabled,
    mutationReady: false,
    approvalReady: false,
    sessionReady: false,
    lastError: config.error,
    checkedAt: null,
  };
  let transport = null;
  let transportPromise = null;
  let refreshPromise = null;
  const threadCache = new Map();
  const usageCache = new Map();
  const usageObservationCache = new Map();
  const usageInvalidated = new Set();
  const contextSnapshotRows = new Map();
  const contextSnapshotLoaded = new Set();
  const contextSnapshotPending = new Map();
  let contextSnapshotWriteScheduled = null;
  let contextSnapshotWritePromise = Promise.resolve();
  let contextSnapshotFileLoaded = false;
  let verifiedCompatibility = null;
  // Tests can inject a transport or version/schema probe. Production launches
  // are compatibility-gated before app-server IO so an unreviewed alpha or
  // schema drift cannot be silently treated as the native contract.
  let versionVerified = typeof transportFactory === "function";

  function contextSnapshotFilename(threadId) {
    return config.contextSnapshotRoot
      ? snapshotFileForRoot(config.contextSnapshotRoot, threadId)
      : config.contextSnapshotFile;
  }

  function loadContextSnapshotFile() {
    if (contextSnapshotFileLoaded || config.contextSnapshotRoot || !config.contextSnapshotFile) return;
    contextSnapshotFileLoaded = true;
    const raw = readBoundedUtf8(config.contextSnapshotFile);
    if (!raw) return;
    try {
      const parsed = JSON.parse(raw);
      if (!parsed || parsed.version !== CONTEXT_SNAPSHOT_VERSION || !Array.isArray(parsed.snapshots)
        || parsed.snapshots.length > MAX_CONTEXT_SNAPSHOTS) return;
      for (const candidate of parsed.snapshots) {
        const row = normalizeContextSnapshotRow(candidate);
        if (row) contextSnapshotRows.set(row.threadId, row);
      }
    } catch { /* invalid or truncated owner snapshot is fail-closed */ }
  }

  function loadContextSnapshot(threadId) {
    if (!validThreadId(threadId)) return null;
    if (!config.contextSnapshotRoot) {
      loadContextSnapshotFile();
      if (contextSnapshotLoaded.size >= MAX_CONTEXT_SNAPSHOTS && !contextSnapshotLoaded.has(threadId)) return null;
      contextSnapshotLoaded.add(threadId);
      return contextSnapshotRows.get(threadId) || null;
    }
    // A child adapter can write this exact hashed file after the history
    // adapter has already observed a miss.  Re-read one bounded file on each
    // cold lookup rather than permanently negative-caching that miss.
    const raw = readBoundedUtf8(contextSnapshotFilename(threadId));
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw);
      if (!parsed || parsed.version !== CONTEXT_SNAPSHOT_VERSION) return null;
      const row = normalizeContextSnapshotRow(parsed.snapshot);
      if (!row || row.threadId !== threadId) return null;
      contextSnapshotRows.set(threadId, row);
      return row;
    } catch { return null; }
  }

  async function writeContextSnapshotFile(filename, payload) {
    if (!filename || typeof payload !== "string" || Buffer.byteLength(payload, "utf8") > MAX_CONTEXT_SNAPSHOT_BYTES) return false;
    const directory = path.dirname(filename);
    if (!ensureOwnedSnapshotDirectory(directory)) return false;
    let targetExists = false;
    try {
      const link = fs.lstatSync(filename);
      if (link.isSymbolicLink() || !link.isFile()) return false;
      const stat = fs.statSync(filename);
      if (stat.nlink !== 1 || stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0) return false;
      targetExists = true;
    } catch (error) {
      if (error?.code !== "ENOENT") return false;
    }
    if (config.contextSnapshotRoot && !targetExists) {
      const count = boundedSnapshotFileCount(directory);
      if (count === null || count >= MAX_CONTEXT_SNAPSHOTS) return false;
    }
    let temp = null;
    try {
      temp = `${filename}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
      await fs.promises.writeFile(temp, payload, { encoding: "utf8", mode: 0o600 });
      try { await fs.promises.chmod(temp, 0o600); } catch {}
      await fs.promises.rename(temp, filename);
      temp = null;
      try { await fs.promises.chmod(filename, 0o600); } catch {}
      return true;
    } catch {
      if (temp) { try { await fs.promises.unlink(temp); } catch {} }
      return false;
    }
  }

  async function deleteContextSnapshotFile(filename) {
    if (!filename) return false;
    try { await fs.promises.unlink(filename); return true; }
    catch (error) { return error?.code === "ENOENT"; }
  }

  function drainContextSnapshotWrites() {
    contextSnapshotWriteScheduled = null;
    if (!contextSnapshotPending.size) return;
    const pending = [...contextSnapshotPending.entries()];
    contextSnapshotPending.clear();
    contextSnapshotWritePromise = contextSnapshotWritePromise.catch(() => {}).then(async () => {
      for (const [threadId, action] of pending) {
        const filename = contextSnapshotFilename(threadId);
        if (!filename) continue;
        if (action === "delete") {
          if (config.contextSnapshotRoot) {
            await deleteContextSnapshotFile(filename);
          } else {
            const payload = contextSnapshotPayload(contextSnapshotRows);
            if (payload) await writeContextSnapshotFile(filename, payload);
          }
          continue;
        }
        const row = contextSnapshotRows.get(threadId);
        if (!row) continue;
        const payload = config.contextSnapshotRoot
          ? JSON.stringify({ version: CONTEXT_SNAPSHOT_VERSION, snapshot: row }) + "\n"
          : contextSnapshotPayload(contextSnapshotRows);
        if (!payload || Buffer.byteLength(payload, "utf8") > MAX_CONTEXT_SNAPSHOT_BYTES) continue;
        await writeContextSnapshotFile(filename, payload);
      }
    });
  }

  function queueContextSnapshotWrite(threadId, action = "write") {
    if (!validThreadId(threadId) || !contextSnapshotFilename(threadId)) return;
    contextSnapshotPending.set(threadId, action);
    if (!contextSnapshotWriteScheduled) contextSnapshotWriteScheduled = setImmediate(drainContextSnapshotWrites);
  }

  async function flushContextSnapshotWrites() {
    if (contextSnapshotWriteScheduled) {
      clearImmediate(contextSnapshotWriteScheduled);
      drainContextSnapshotWrites();
    }
    await contextSnapshotWritePromise.catch(() => {});
    if (contextSnapshotPending.size) return flushContextSnapshotWrites();
  }

  function canRestoreContextSnapshot(row, cached) {
    if (!row || !cached || row.threadId !== cached.id || !validSnapshotTime(row.observedAt)) return false;
    const now = Number(clock());
    if (validSnapshotTime(now) && row.observedAt > now + CONTEXT_SNAPSHOT_CLOCK_SKEW_MS) return false;
    if (!validSnapshotTime(cached.updatedAt) || cached.updatedAt > row.observedAt + CONTEXT_SNAPSHOT_CLOCK_SKEW_MS) return false;
    if (row.nativeVersion !== snapshotNativeVersion()) return false;
    const currentSchema = verifiedCompatibility?.schemaFingerprint || null;
    if (row.schemaFingerprint !== currentSchema) return false;
    if (row.sessionId && cached.sessionId && row.sessionId !== cached.sessionId) return false;
    if (row.createdAt !== null && cached.createdAt !== null && row.createdAt !== cached.createdAt) return false;
    if (row.model && cached.model && row.model !== cached.model) return false;
    return true;
  }

  async function verifyExecutableVersion() {
    if (verifiedCompatibility) return verifiedCompatibility;
    // Injected transports are test/owned fixtures and already provide their
    // own protocol contract. Production launches always pass through the
    // schema/capability registry before app-server IO.
    if (versionVerified || typeof transportFactory === "function") {
      verifiedCompatibility = Object.freeze({
        profileId: "injected-transport",
        nativeVersion: state.nativeVersion || CODEX_NATIVE_VERSION,
        channel: "stable",
        schemaFingerprint: null,
        verification: "injected-transport",
        capabilities: Object.freeze({ historyRead: true, historyPages: true, sessionResume: true, turns: true, mutations: true, approvals: true }),
        initializeParams: undefined,
      });
      return verifiedCompatibility;
    }
    try {
      verifiedCompatibility = await probeCodexCompatibility(config.executable, {
        cwd: config.cwd,
        env,
        versionProbe,
        schemaProbe,
      });
    } catch (error) {
      if (error?.code === "unsupported_codex_native_version" || error?.code === "codex_schema_mismatch"
        || error?.code === "codex_schema_incomplete" || error?.code === "codex_schema_invalid") {
        throw new CodexNativeHistoryError(error.code, error.message, 503, {
          nativeVersion: error.nativeVersion || null,
          schemaFingerprint: error.schemaFingerprint || null,
          channel: error.channel || null,
        });
      }
      throw error;
    }
    state = { ...state,
      nativeVersion: verifiedCompatibility.nativeVersion,
      compatibility: {
        profileId: verifiedCompatibility.profileId,
        verification: verifiedCompatibility.verification,
        schemaFingerprint: verifiedCompatibility.schemaFingerprint,
        capabilities: { ...verifiedCompatibility.capabilities },
      },
    };
    versionVerified = true;
    return verifiedCompatibility;
  }

  function writeMutationJournal() {
    mutationJournal.operations = [...mutationRows.values()].slice(-MAX_MUTATION_ROWS);
    if (!persistMutationJournal(config.journalFile, mutationJournal)) mutationWriteError = "mutation_journal_unavailable";
    return !mutationWriteError;
  }

  function operationContextKey(operation, context) {
    try { return `${operation}:${jsonHash(context)}`; } catch { return null; }
  }

  async function authorizeNative(operation, context = {}) {
    if (!config.mutationEnabled) return { kind: "reject", code: "native_mutations_disabled" };
    if (!MUTATION_OPERATIONS.has(operation) || !context || typeof context !== "object") return { kind: "reject", code: "native_operation_invalid" };
    if (!config.journalFile || mutationWriteError) return { kind: "reject", code: "mutation_journal_unavailable" };
    const key = operationContextKey(operation, context);
    if (!key) return { kind: "reject", code: "native_operation_invalid" };
    const prior = [...mutationRows.values()].reverse().find(row => row.key === key && ["dispatching", "awaiting_confirmation"].includes(row.state));
    if (prior) return { kind: "committed", receiptId: prior.receiptId, attemptId: prior.attemptId, incarnationId: prior.incarnationId };
    const now = Number(clock());
    if (!Number.isSafeInteger(now) || now < 0) return { kind: "reject", code: "invalid_time" };
    const row = {
      operationId: mutationId("op"), key, operation, context: cleanText(JSON.stringify(context), 8192),
      receiptId: mutationId("receipt"), attemptId: mutationId("attempt"), incarnationId: mutationId("inc"),
      state: "dispatching", createdAt: now, updatedAt: now, evidence: null,
    };
    mutationRows.set(row.operationId, row);
    if (!writeMutationJournal()) { mutationRows.delete(row.operationId); return { kind: "reject", code: "mutation_journal_unavailable" }; }
    return { kind: "committed", receiptId: row.receiptId, attemptId: row.attemptId, incarnationId: row.incarnationId };
  }

  function settleMutation(dispatch, result, evidenceReference = null) {
    if (!dispatch?.receiptId) return;
    const row = [...mutationRows.values()].find(item => item.receiptId === dispatch.receiptId);
    if (!row) return;
    row.updatedAt = Number(clock());
    if (result?.kind === "requested") row.state = "awaiting_confirmation";
    // A pipe write only proves that Stepsemble handed the approval response to
    // the child process.  The native server must still emit a correlated
    // approval-resolved/turn lifecycle event before this row can be called
    // succeeded.  The transport currently exposes that boundary as
    // `written`, so keep it explicitly awaiting confirmation.
    else if (result?.kind === "written") row.state = "awaiting_confirmation";
    else if (["started", "resumed", "completed", "cancelled"].includes(result?.kind)) {
      row.state = "succeeded";
      row.evidence = { kind: "native_ack", reference: cleanText(evidenceReference || `${row.operationId}:${result.kind}`, 256) };
    } else if (result?.kind === "reject") row.state = "uncertain";
    writeMutationJournal();
  }

  function mutationStatus() {
    return Object.freeze({ enabled: config.mutationEnabled, ready: state.mutationReady, journalFile: config.journalFile ? "owner-only" : null,
      lastError: mutationWriteError, operations: [...mutationRows.values()].slice(-64).map(row => ({ operationId: row.operationId, operation: row.operation, state: row.state, createdAt: row.createdAt, updatedAt: row.updatedAt, evidence: row.evidence })) });
  }
  function nativeState() {
    return typeof transport?.state === "function" ? transport.state() : { state: "not_ready", threadId: null, turnId: null };
  }

  function snapshotNativeVersion() {
    return state.nativeVersion || verifiedCompatibility?.nativeVersion || CODEX_NATIVE_VERSION;
  }

  function invalidateUsage(threadId) {
    if (!validThreadId(threadId)) return;
    usageCache.delete(threadId);
    usageObservationCache.delete(threadId);
    usageInvalidated.add(threadId);
    contextSnapshotRows.delete(threadId);
    queueContextSnapshotWrite(threadId, "delete");
  }

  function cacheThread(value) {
    if (!value || !validThreadId(value.id)) return;
    const prior = threadCache.get(value.id);
    const observedAt = usageObservationCache.get(value.id)?.observedAt
      ?? contextSnapshotRows.get(value.id)?.observedAt;
    if (prior && ((prior.model || null) !== (value.model || null)
      || (prior.sessionId || null) !== (value.sessionId || null)
      || (prior.createdAt ?? null) !== (value.createdAt ?? null)
      || validSnapshotTime(value.updatedAt) && validSnapshotTime(observedAt)
        && value.updatedAt > observedAt + CONTEXT_SNAPSHOT_CLOCK_SKEW_MS)) invalidateUsage(value.id);
    threadCache.set(value.id, value);
  }

  function observeNativeEvent(event) {
    const threadId = validThreadId(event?.threadId) ? event.threadId : null;
    if (threadId && ["context.compaction", "thread.compacted", "thread/compacted", "context_compacted",
      "thread.settings.updated", "thread/settings/updated", "model.rerouted", "model/rerouted", "turn.started"].includes(event?.type)) {
      invalidateUsage(threadId);
    }
    if (event?.type === "thread.tokenUsage.updated" && threadId) {
      const snapshot = nativeUsageSnapshot(event);
      if (snapshot) {
        const observedAt = Number(clock());
        usageInvalidated.delete(threadId);
        usageCache.set(threadId, snapshot);
        usageObservationCache.set(threadId, {
          source: "live",
          observedAt: validSnapshotTime(observedAt) ? observedAt : null,
        });
        if (validSnapshotTime(observedAt) && (contextSnapshotRows.has(threadId) || contextSnapshotRows.size < MAX_CONTEXT_SNAPSHOTS)) {
          const cached = threadCache.get(threadId);
          contextSnapshotRows.set(threadId, {
            threadId,
            turnId: snapshot.turnId,
            sessionId: cached?.sessionId || null,
            model: cached?.model || null,
            createdAt: cached?.createdAt ?? null,
            threadUpdatedAt: cached?.updatedAt ?? null,
            observedAt,
            nativeVersion: snapshotNativeVersion(),
            schemaFingerprint: verifiedCompatibility?.schemaFingerprint || null,
            tokenUsage: snapshot.tokenUsage,
          });
          contextSnapshotLoaded.add(threadId);
          queueContextSnapshotWrite(threadId);
        }
      }
    }
    if (typeof onEvent === "function") {
      try { onEvent(event); } catch { /* transport report owns failure semantics */ }
    }
  }

  function retireBrokenTransport(error) {
    const code = String(error?.code || "");
    if (!transport || !["native_frame_invalid", "native_transport_ended", "native_transport_read_failed",
      "native_transport_write_failed", "native_request_timeout", "native_response_invalid"].includes(code)) return;
    const instance = transport;
    transport = null;
    usageCache.clear();
    usageObservationCache.clear();
    threadCache.clear();
    state = { ...state, state: "degraded", ready: false, sessionReady: false, mutationReady: false, approvalReady: false, lastError: code, checkedAt: clock() };
    try { void Promise.resolve(instance.close?.()).catch(() => {}); } catch {}
  }

  function status() { return Object.freeze({ ...state }); }

  function capability() {
    const compatibility = state.compatibility ? { ...state.compatibility, capabilities: { ...state.compatibility.capabilities } } : null;
    return state.ready ? {
      mode: state.mutationReady ? "native_mutation" : "native_readonly",
      history: "native_readonly",
      subagents: "native_readonly",
      approval: state.mutationReady ? "structured_ack_required" : "unavailable",
      session: state.mutationReady ? "native_api" : "native_readonly",
      source: "codex-app-server-v2",
      adapter: state.adapter,
      nativeVersion: state.nativeVersion,
      compatibility,
      readOnly: !state.mutationReady,
      mutationJournal: state.mutationReady ? "owner-only" : null,
    } : {
      mode: "compat",
      history: "canonical_bounded",
      subagents: "unavailable",
      approval: "structured_ack_required",
      session: "cli",
      source: state.enabled ? "codex-app-server-unverified" : "cli",
      adapter: state.adapter,
      nativeVersion: state.nativeVersion,
      compatibility,
      reason: state.lastError || "native_app_server_not_ready",
    };
  }

  function requireReady() {
    if (!state.configured) throw new CodexNativeHistoryError(state.lastError || "not_configured", "Codex native history is not configured", 503);
    if (!state.ready || !transport) throw new CodexNativeHistoryError("native_not_ready", "Codex native history is not ready", 503);
  }

  async function ensureTransport() {
    if (transport) return transport;
    if (transportPromise) return transportPromise;
    if (!config.configured) throw new CodexNativeHistoryError(config.error || "not_configured", "Codex native history is not configured", 503);
    transportPromise = (async () => {
      let instance;
      try {
        const compatibility = await verifyExecutableVersion();
        const options = { executable: config.executable, cwd: config.cwd, env: { ...env }, nativeVersion: compatibility.nativeVersion,
          onEvent: observeNativeEvent,
          ...(config.mutationEnabled ? { authorizeNative, onApprovalRequest } : {}) };
        if (typeof transportFactory === "function") instance = await transportFactory(options);
        else instance = launch(options);
        if (!instance || typeof instance.initialize !== "function") throw new Error("native_transport_invalid");
        await instance.initialize(compatibility.initializeParams);
        transport = instance;
        return instance;
      } catch (error) {
        try { await instance?.close?.(); } catch {}
        throw error;
      }
    })();
    try { return await transportPromise; }
    finally { transportPromise = null; }
  }

  async function refresh() {
    if (refreshPromise) return refreshPromise;
    refreshPromise = (async () => {
      state = { ...state, checkedAt: clock(), state: config.configured ? "probing" : config.enabled ? "unavailable" : "disabled", ready: false, sessionReady: false, lastError: config.error };
      if (!config.configured) return status();
      try {
        const api = await ensureTransport();
        const probe = await api.listThreads({ limit: 1, sortKey: "updated_at", sortDirection: "desc", useStateDbOnly: true });
        if (!probe || probe.kind !== "threads" || !Array.isArray(probe.data)) throw new Error("native_response_invalid");
        const capabilities = verifiedCompatibility?.capabilities || {};
        const mutationAllowed = verifiedCompatibility?.verification === "injected-transport"
          || capabilities.mutations === true;
        state = { ...state, state: "ready", ready: true, sessionReady: true,
          mutationReady: config.mutationEnabled && mutationAllowed && !mutationWriteError,
          approvalReady: config.mutationEnabled && mutationAllowed && capabilities.approvals !== false && !mutationWriteError,
          lastError: null, checkedAt: clock() };
      } catch (error) {
        state = { ...state, state: "degraded", ready: false, sessionReady: false, mutationReady: false, approvalReady: false,
          lastError: cleanText(error?.code || "probe_failed", 128), checkedAt: clock() };
      }
      return status();
    })();
    try { return await refreshPromise; }
    finally { refreshPromise = null; }
  }

  async function listThreads(params = {}) {
    requireReady();
    let result;
    try {
      result = await transport.listThreads({
        limit: MAX_THREADS,
        sortKey: "updated_at",
        sortDirection: "desc",
        useStateDbOnly: true,
        ...params,
        limit: Math.min(MAX_PAGE, Number.isSafeInteger(params.limit) ? params.limit : MAX_THREADS),
      });
    } catch (error) { retireBrokenTransport(error); throw error; }
    if (!result || result.kind !== "threads") throw new CodexNativeHistoryError("native_response_invalid", "Codex thread list was invalid", 502);
    const threads = result.data.map(publicThread).filter(Boolean).slice(0, MAX_PAGE);
    for (const thread of threads) cacheThread(thread);
    return { kind: "threads", threads, data: threads, nextCursor: result.nextCursor || null, backwardsCursor: result.backwardsCursor || null };
  }

  async function readThread(threadId, { includeTurns = true } = {}) {
    requireReady();
    if (!validThreadId(threadId)) throw new CodexNativeHistoryError("invalid_thread_id", "Codex thread id is invalid", 400);
    let result;
    try { result = await transport.readThread({ threadId, includeTurns: includeTurns === true }); }
    catch (error) { retireBrokenTransport(error); throw error; }
    const thread = publicThread(result?.thread);
    if (!thread) throw new CodexNativeHistoryError("native_response_invalid", "Codex thread response was invalid", 502);
    cacheThread(thread);
    return { kind: "thread", thread };
  }

  async function listThreadTurns(threadId, params = {}) {
    requireReady();
    if (!validThreadId(threadId)) throw new CodexNativeHistoryError("invalid_thread_id", "Codex thread id is invalid", 400);
    let result;
    try { result = await transport.listThreadTurns({ ...params, threadId, limit: Math.min(MAX_PAGE, Number.isSafeInteger(params.limit) ? params.limit : DEFAULT_TURN_PAGE) }); }
    catch (error) { retireBrokenTransport(error); throw error; }
    if (!result || result.kind !== "thread_turns") throw new CodexNativeHistoryError("native_response_invalid", "Codex turn page was invalid", 502);
    return { ...result, threadId };
  }

  async function listThreadItems(threadId, params = {}) {
    requireReady();
    if (!validThreadId(threadId)) throw new CodexNativeHistoryError("invalid_thread_id", "Codex thread id is invalid", 400);
    let result;
    try { result = await transport.listThreadItems({ ...params, threadId, limit: Math.min(MAX_PAGE, Number.isSafeInteger(params.limit) ? params.limit : DEFAULT_ITEM_PAGE) }); }
    catch (error) { retireBrokenTransport(error); throw error; }
    if (!result || result.kind !== "thread_items") throw new CodexNativeHistoryError("native_response_invalid", "Codex item page was invalid", 502);
    return { ...result, threadId };
  }

  async function getThreadGoal(threadId) {
    requireReady();
    if (!validThreadId(threadId)) throw new CodexNativeHistoryError("invalid_thread_id", "Codex thread id is invalid", 400);
    if (typeof transport?.getThreadGoal !== "function") {
      throw new CodexNativeHistoryError("native_goal_unavailable", "Codex goal state is unavailable", 503);
    }
    let result;
    try { result = await transport.getThreadGoal({ threadId }); }
    catch (error) { retireBrokenTransport(error); throw error; }
    if (!result || result.kind !== "thread_goal" || result.goal && result.goal.threadId !== threadId) {
      throw new CodexNativeHistoryError("native_response_invalid", "Codex goal response was invalid", 502);
    }
    return { kind: "thread_goal", threadId, goal: result.goal || null };
  }

  async function listModels(params = {}) {
    requireReady();
    if (!params || typeof params !== "object" || Array.isArray(params)) {
      throw new CodexNativeHistoryError("invalid_model_list_params", "Codex model list parameters are invalid", 400);
    }
    const request = { ...params };
    if (Object.hasOwn(request, "limit")) {
      if (!Number.isSafeInteger(request.limit) || request.limit < 0) {
        throw new CodexNativeHistoryError("invalid_model_list_params", "Codex model list limit is invalid", 400);
      }
      request.limit = Math.min(MAX_PAGE, request.limit);
    } else request.limit = MAX_PAGE;
    let result;
    try { result = await transport.listModels(request); }
    catch (error) { retireBrokenTransport(error); throw error; }
    if (!result || !Array.isArray(result.data)) throw new CodexNativeHistoryError("native_response_invalid", "Codex model list was invalid", 502);
    const normalized = normalizeModelListResponse({ data: result.data, nextCursor: result.nextCursor ?? null });
    if (!normalized) throw new CodexNativeHistoryError("native_response_invalid", "Codex model list was invalid", 502);
    return { data: normalized.data, nextCursor: normalized.nextCursor };
  }

  async function contextUsage(threadId) {
    requireReady();
    if (!validThreadId(threadId)) throw new CodexNativeHistoryError("invalid_thread_id", "Codex thread id is invalid", 400);
    let snapshot = usageCache.get(threadId) || null;
    let metadata = usageObservationCache.get(threadId) || null;
    if (!snapshot && !usageInvalidated.has(threadId) && typeof transport?.tokenUsage === "function") {
      try { snapshot = await transport.tokenUsage(threadId); }
      catch (error) { retireBrokenTransport(error); throw error; }
      if (snapshot) {
        snapshot = scopedNativeUsageSnapshot(threadId, snapshot);
        const observedAt = Number(clock());
        metadata = { source: "live", observedAt: validSnapshotTime(observedAt) ? observedAt : null };
      }
    }
    if (!snapshot && !usageInvalidated.has(threadId) && typeof transport?.contextUsage === "function") {
      try { snapshot = await transport.contextUsage(threadId); }
      catch (error) { retireBrokenTransport(error); throw error; }
      if (snapshot) {
        snapshot = scopedNativeUsageSnapshot(threadId, snapshot);
        const observedAt = Number(clock());
        metadata = { source: "live", observedAt: validSnapshotTime(observedAt) ? observedAt : null };
      }
    }
    let restored = !snapshot && !usageInvalidated.has(threadId) ? loadContextSnapshot(threadId) : null;
    let cached = threadCache.get(threadId);
    const needsFreshMetadata = typeof transport?.readThread === "function"
      && (!!restored || metadata?.source === "live");
    const requiresFreshRestoreMetadata = !!restored;
    if ((!cached || needsFreshMetadata) && typeof transport?.readThread === "function") {
      try {
        const result = await transport.readThread({ threadId, includeTurns: false });
        cached = publicThread(result?.thread);
        if (cached) cacheThread(cached);
      } catch (error) {
        // Usage is still authoritative when a metadata-only read races a
        // thread close. Keep the DTO scoped to the requested id and expose an
        // unknown model instead of inventing one from a stale sibling thread.
        if (requiresFreshRestoreMetadata) cached = null;
      }
    }
    if (!snapshot && !usageInvalidated.has(threadId)) {
      if (canRestoreContextSnapshot(restored, cached)) {
        snapshot = restored;
        metadata = { source: "last_observed", observedAt: restored.observedAt };
      }
    }
    // A fresh metadata read can discover a model/session identity change and
    // invalidate the live observation while this async call was in flight.
    // Never return the pre-change local snapshot in that race.
    if (snapshot && usageInvalidated.has(threadId)) {
      snapshot = null;
      metadata = null;
    }
    if (!snapshot) metadata = null;
    return contextUsageDto(threadId, cached?.model || null, snapshot, metadata || { source: "unknown" });
  }

  async function listTasks() {
    const page = await listThreads({ limit: MAX_THREADS });
    return page.threads.map(thread => {
      const task = taskFromThread(thread);
      if (!task) return null;
      return state.mutationReady ? { ...task, history: "native_readonly", readOnly: false, mutation: "native_api" } : task;
    }).filter(Boolean);
  }

  function requireMutation() {
    requireReady();
    if (!state.mutationReady || !config.mutationEnabled) {
      const code = verifiedCompatibility && verifiedCompatibility.capabilities?.mutations !== true
        ? "native_mutations_not_reviewed"
        : "native_mutations_disabled";
      throw new CodexNativeHistoryError(code, "Codex native mutations are not enabled for this compatibility profile", 409);
    }
  }

  async function startThread(params = {}) {
    requireMutation();
    const result = await transport.startThread(params);
    settleMutation(result?.dispatch, result, result?.threadId || "thread-started");
    return result;
  }

  async function resumeThread(params = {}) {
    requireMutation();
    if (!validThreadId(params.threadId)) throw new CodexNativeHistoryError("invalid_thread_id", "Codex thread id is invalid", 400);
    const result = await transport.resumeThread(params);
    settleMutation(result?.dispatch, result, params.threadId);
    return result;
  }

  async function startTurn(input, params = {}, expectedThreadId = null) {
    requireMutation();
    if (!Array.isArray(input) || !input.length) throw new CodexNativeHistoryError("invalid_turn_input", "Codex turn input is invalid", 400);
    const normalizedInput = normalizeTurnInput(input);
    if (!normalizedInput) throw new CodexNativeHistoryError("invalid_turn_input", "Codex turn input is invalid", 400);
    if (!validTurnOptions(params)) throw new CodexNativeHistoryError("invalid_turn_options", "Codex turn model or effort override is invalid", 400);
    if (expectedThreadId !== null && !validThreadId(expectedThreadId)) return { kind: "reject", code: "native_thread_mismatch" };
    if (expectedThreadId !== null && typeof transport?.state === "function" && transport.state().threadId !== expectedThreadId) {
      return { kind: "reject", code: "native_thread_mismatch" };
    }
    const result = await transport.startTurn(normalizedInput, params, expectedThreadId);
    settleMutation(result?.dispatch, result, result?.turnId || result?.completedTurnId || "turn-started");
    return result;
  }

  async function interruptTurn(expectedThreadId = null) {
    requireMutation();
    if (expectedThreadId !== null && !validThreadId(expectedThreadId)) return { kind: "reject", code: "native_thread_mismatch" };
    if (expectedThreadId !== null && typeof transport?.state === "function" && transport.state().threadId !== expectedThreadId) {
      return { kind: "reject", code: "native_thread_mismatch" };
    }
    const result = await transport.interruptTurn(expectedThreadId);
    settleMutation(result?.dispatch, result, result?.completedTurnId || result?.turnId || "turn-interrupt-requested");
    return result;
  }

  async function respondApproval(requestId, decision = {}) {
    requireMutation();
    const result = await transport.respondApproval(requestId, decision);
    settleMutation(result?.dispatch, result, `approval:${String(requestId)}`);
    return result;
  }

  function pendingApprovals() {
    return typeof transport?.pendingApprovals === "function" ? transport.pendingApprovals() : [];
  }

  async function close() {
    const instance = transport;
    transport = null;
    usageCache.clear();
    usageObservationCache.clear();
    threadCache.clear();
    usageInvalidated.clear();
    state = { ...state, ready: false, sessionReady: false, mutationReady: false, approvalReady: false, state: "closed" };
    await flushContextSnapshotWrites();
    if (!instance) return { kind: "closed", cleanupConfirmed: true };
    try { return await instance.close?.() || { kind: "closed", cleanupConfirmed: true }; }
    catch { return { kind: "closed", cleanupConfirmed: false }; }
  }

  return Object.freeze({
    status,
    capability,
    refresh,
    listThreads,
    readThread,
    listThreadTurns,
    listThreadItems,
    getThreadGoal,
    listModels,
    async rateLimits() { requireReady(); if (typeof transport?.rateLimits !== "function") throw new Error("quota_unavailable"); return transport.rateLimits(); },
    contextUsage,
    listTasks,
    startThread,
    resumeThread,
    startTurn,
    interruptTurn,
    respondApproval,
    pendingApprovals,
    mutationStatus,
    nativeState,
    close,
    config: Object.freeze({ ...config, executable: undefined }),
    validThreadId,
  });
}

module.exports = {
  CODEX_NATIVE_VERSION,
  CodexNativeHistoryError,
  resolveConfig,
  publicThread,
  taskFromThread,
  createCodexNativeHistoryAdapter,
};
