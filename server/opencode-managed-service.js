"use strict";

// A deliberately small owner for an explicitly requested OpenCode server.
//
// This module is not a general process launcher.  It only resolves the
// well-known `opencode` executable, binds the child to loopback, and keeps a
// fresh password in memory for the lifetime of that child.  An endpoint that
// the operator already configured is always reused; this service never
// replaces it and never touches OpenCode's credential/config stores.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const net = require("node:net");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");

const LOOPBACK_HOST = "127.0.0.1";
const DEFAULT_STARTUP_TIMEOUT_MS = 10_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 1_000;
const DEFAULT_CLOSE_TIMEOUT_MS = 2_000;
const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024;
const DEFAULT_MAX_RESPONSE_BYTES = 256 * 1024;
const DEFAULT_USERNAME = "opencode";
const SERVICE_ID = "opencode-managed-v1";
const EXTERNAL_ENDPOINT_KEYS = ["STEPSEMBLE_OPENCODE_SERVER_URL", "OPENCODE_SERVER_URL"];
const CREDENTIAL_KEYS = [
  "OPENCODE_SERVER_USERNAME",
  "OPENCODE_SERVER_PASSWORD",
  "STEPSEMBLE_OPENCODE_SERVER_USERNAME",
  "STEPSEMBLE_OPENCODE_SERVER_PASSWORD",
];
const LOOPBACK_NAMES = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

class OpenCodeManagedServiceError extends Error {
  constructor(code, message = code, statusCode = 503) {
    super(message);
    this.name = "OpenCodeManagedServiceError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

function problem(code, statusCode = 503) {
  return new OpenCodeManagedServiceError(code, code, statusCode);
}

function boundedInteger(value, fallback, minimum, maximum) {
  const number = Number(value);
  if (!Number.isSafeInteger(number)) return fallback;
  return Math.min(maximum, Math.max(minimum, number));
}

function safeCredential(value, { fallback = "", maximum = 8192 } = {}) {
  if (value === undefined || value === null) return fallback;
  const text = String(value);
  if (!text || text.length > maximum || /[\u0000-\u001f\u007f]/.test(text)) return fallback;
  return text;
}

function normalizeEndpointUrl(value, { allowRemote = false } = {}) {
  const raw = String(value || "").trim();
  if (!raw) return { url: null, error: "not_configured" };
  let parsed;
  try { parsed = new URL(raw); } catch { return { url: null, error: "invalid_url" }; }
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) {
    return { url: null, error: "invalid_url" };
  }
  const host = String(parsed.hostname || "").toLowerCase();
  const local = LOOPBACK_NAMES.has(host);
  if (!local && (!allowRemote || parsed.protocol !== "https:")) return { url: null, error: "remote_url_not_allowed" };
  parsed.pathname = parsed.pathname.replace(/\/+$/, "");
  parsed.search = "";
  parsed.hash = "";
  return { url: parsed.toString().replace(/\/$/, ""), error: null, local };
}

function pathEntries(env, platform = process.platform) {
  const pathKey = platform === "win32"
    ? Object.keys(env || {}).find(key => key.toLowerCase() === "path") || "Path"
    : "PATH";
  const configured = env && env[pathKey] !== undefined ? env[pathKey] : process.env.PATH;
  return String(configured || "").split(path.delimiter).filter(Boolean);
}

function executableFile(file, platform = process.platform) {
  if (typeof file !== "string" || !file || !path.isAbsolute(file)) return false;
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile()) return false;
    return platform === "win32" || (stat.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

function resolveOpenCodeExecutable({ env = process.env, platform = process.platform, home = env?.HOME || env?.USERPROFILE || os.homedir() } = {}) {
  const explicit = String(env?.STEPSEMBLE_OPENCODE_BIN || "").trim();
  if (explicit) {
    // An explicit binary is still constrained to an absolute, known
    // OpenCode filename.  A malformed override must fail closed rather than
    // silently falling back to another executable on PATH.
    if (!path.isAbsolute(explicit) || !validOpenCodeExecutable(path.resolve(explicit), platform)) return null;
    return path.resolve(explicit);
  }
  // `.cmd`/`.bat` files require shell:true on Windows.  This service never
  // invokes a shell, so only a native executable (or an extensionless binary)
  // is accepted.
  const extensions = platform === "win32" ? ["", ".exe"] : [""];
  const candidates = [];
  for (const directory of pathEntries(env, platform)) {
    for (const extension of extensions) candidates.push(path.resolve(directory, `opencode${extension}`));
  }
  // Keep the fallback list intentionally narrow.  It mirrors the locations
  // used by the installed harness resolver, but never accepts a caller's
  // arbitrary executable or invokes a shell/`which` command.
  const fallbackDirectories = [
    path.join(String(home || os.homedir()) === "~" ? os.homedir() : String(home || os.homedir()), ".opencode", "bin"),
    path.join(String(home || os.homedir()) === "~" ? os.homedir() : String(home || os.homedir()), ".local", "bin"),
  ];
  fallbackDirectories.push(...(platform === "darwin"
    ? ["/opt/homebrew/bin", "/usr/local/bin"]
    : platform === "win32"
      ? [path.join(String(env?.ProgramFiles || "C:\\Program Files"), "OpenCode")]
      : ["/usr/local/bin", "/usr/bin"]));
  for (const directory of fallbackDirectories) {
    for (const extension of extensions) candidates.push(path.join(directory, `opencode${extension}`));
  }
  return candidates.find(candidate => executableFile(candidate, platform)) || null;
}

function validOpenCodeExecutable(value, platform = process.platform) {
  if (typeof value !== "string" || !executableFile(value, platform)) return false;
  const name = path.basename(String(value)).toLowerCase();
  return platform === "win32"
    ? /^opencode(?:\.exe)?$/.test(name)
    : name === "opencode";
}

function allocateLoopbackPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    let settled = false;
    const fail = error => {
      if (settled) return;
      settled = true;
      try { server.close(); } catch {}
      reject(error);
    };
    server.once("error", fail);
    server.listen({ host: LOOPBACK_HOST, port: 0 }, () => {
      const address = server.address();
      const port = address && typeof address === "object" ? address.port : null;
      if (!Number.isInteger(port) || port < 1024 || port > 65535) {
        fail(problem("port_unavailable"));
        return;
      }
      server.close(error => {
        if (settled) return;
        settled = true;
        if (error) reject(problem("port_unavailable"));
        else resolve(port);
      });
    });
  });
}

function sleep(milliseconds) {
  return new Promise(resolve => {
    setTimeout(resolve, Math.max(0, milliseconds));
  });
}

function readEndpoint(env) {
  const first = String(env?.STEPSEMBLE_OPENCODE_SERVER_URL || "").trim();
  const second = String(env?.OPENCODE_SERVER_URL || "").trim();
  if (first && second && first !== second) return { error: "conflicting_endpoint_config" };
  const raw = first || second;
  if (!raw) return null;
  const allowRemote = ["1", "true", "yes", "on"].includes(String(env?.STEPSEMBLE_OPENCODE_ALLOW_REMOTE || "").toLowerCase());
  const normalized = normalizeEndpointUrl(raw, { allowRemote });
  if (!normalized.url) return { error: "explicit_endpoint_invalid" };
  const username = safeCredential(
    env?.STEPSEMBLE_OPENCODE_SERVER_USERNAME ?? env?.OPENCODE_SERVER_USERNAME,
    { fallback: DEFAULT_USERNAME, maximum: 128 },
  ) || DEFAULT_USERNAME;
  const passwordValue = env?.STEPSEMBLE_OPENCODE_SERVER_PASSWORD ?? env?.OPENCODE_SERVER_PASSWORD;
  const password = passwordValue === undefined ? "" : safeCredential(passwordValue, { fallback: "", maximum: 8192 });
  return {
    baseUrl: normalized.url,
    origin: new URL(normalized.url).origin,
    local: normalized.local === true,
    username,
    password,
    explicit: true,
  };
}

function basicAuthorization(username, password) {
  return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
}

function clonePublicStatus(value) {
  return Object.freeze({ ...value });
}

function createOpenCodeManagedService({
  env = process.env,
  spawnImpl = spawn,
  resolveExecutable = () => resolveOpenCodeExecutable({ env }),
  portAllocator = allocateLoopbackPort,
  fetchImpl = globalThis.fetch,
  randomBytes = crypto.randomBytes,
  startupTimeoutMs = DEFAULT_STARTUP_TIMEOUT_MS,
  requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  closeTimeoutMs = DEFAULT_CLOSE_TIMEOUT_MS,
  maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES,
  maxResponseBytes = DEFAULT_MAX_RESPONSE_BYTES,
  platform = process.platform,
  clock = () => Date.now(),
} = {}) {
  const explicit = readEndpoint(env);
  const startupLimit = boundedInteger(startupTimeoutMs, DEFAULT_STARTUP_TIMEOUT_MS, 250, 120_000);
  const requestLimit = boundedInteger(requestTimeoutMs, DEFAULT_REQUEST_TIMEOUT_MS, 100, 10_000);
  const closeLimit = boundedInteger(closeTimeoutMs, DEFAULT_CLOSE_TIMEOUT_MS, 100, 30_000);
  const outputLimit = boundedInteger(maxOutputBytes, DEFAULT_MAX_OUTPUT_BYTES, 1024, 16 * 1024 * 1024);
  const responseLimit = boundedInteger(maxResponseBytes, DEFAULT_MAX_RESPONSE_BYTES, 1024, 4 * 1024 * 1024);

  let state = explicit?.error ? "blocked" : explicit ? "external" : "idle";
  let lastError = explicit?.error || null;
  let child = null;
  let childClosePromise = null;
  let startPromise = null;
  let closed = false;
  let stopping = false;
  let startupReject = null;
  let managedConfig = null;
  let managedEnv = null;
  let port = null;
  let startedAt = null;
  let checkedAt = null;
  let outputBytes = 0;
  let startupAbortController = null;
  let startupResult = null;
  let outputCapturing = false;

  function activeConfig() {
    if (closed) return null;
    if (managedConfig) return managedConfig;
    if (explicit && !explicit.error) return explicit;
    return null;
  }

  function status() {
    const active = activeConfig();
    return clonePublicStatus({
      service: SERVICE_ID,
      adapter: SERVICE_ID,
      state,
      configured: !!active,
      managed: !!managedConfig && !!child,
      ready: state === "ready",
      local: active?.local === true,
      origin: active?.origin || null,
      port: Number.isInteger(port) ? port : null,
      pid: child && Number.isSafeInteger(child.pid) ? child.pid : null,
      cleanupConfirmed: !child,
      lastError: lastError || null,
      startedAt,
      checkedAt,
    });
  }

  function config() {
    const active = activeConfig();
    if (!active) return Object.freeze({ baseUrl: null, origin: null, local: false, username: null, password: null, managed: false });
    return Object.freeze({
      baseUrl: active.baseUrl,
      origin: active.origin,
      local: active.local === true,
      username: active.username,
      password: active.password,
      managed: active.explicit !== true,
      port: active.explicit === true ? null : port,
    });
  }

  // Parent code can merge these three values into its adapter configuration.
  // It is intentionally not returned by status() or embedded in errors.
  function resultingEnv() {
    if (!activeConfig()) return Object.freeze({});
    const active = activeConfig();
    const result = {
      STEPSEMBLE_OPENCODE_SERVER_URL: active.baseUrl,
      STEPSEMBLE_OPENCODE_SERVER_USERNAME: active.username,
    };
    if (active.password) result.STEPSEMBLE_OPENCODE_SERVER_PASSWORD = active.password;
    return Object.freeze(result);
  }

  function childEnvironment(username, password) {
    const childEnv = { ...env };
    // Never let a previously configured credential accidentally win over the
    // fresh service credential. The endpoint keys are also removed so the
    // child cannot be redirected to an existing external server.
    const blocked = new Set([
      ...CREDENTIAL_KEYS,
      ...EXTERNAL_ENDPOINT_KEYS,
      "OPENCODE_SERVER_HOST",
      "OPENCODE_SERVER_HOSTNAME",
      "OPENCODE_SERVER_PORT",
      "OPENCODE_SERVER_MDNS",
      "OPENCODE_SERVER_CORS",
    ].map(key => key.toUpperCase()));
    for (const key of Object.keys(childEnv)) if (blocked.has(key.toUpperCase())) delete childEnv[key];
    childEnv.OPENCODE_SERVER_USERNAME = username;
    childEnv.OPENCODE_SERVER_PASSWORD = password;
    return childEnv;
  }

  function failStartup(error) {
    startupAbortController?.abort();
    if (!startupReject) return;
    const reject = startupReject;
    startupReject = null;
    reject(error instanceof OpenCodeManagedServiceError ? error : problem("startup_failed"));
  }

  function stopChild(childToStop) {
    if (!childToStop || stopping || childToStop.exitCode !== null && childToStop.exitCode !== undefined
      || childToStop.signalCode !== null && childToStop.signalCode !== undefined) return;
    stopping = true;
    try { childToStop.kill?.("SIGTERM"); } catch {}
    const timer = setTimeout(() => {
      if (child === childToStop && childToStop.exitCode == null && childToStop.signalCode == null) {
        try { childToStop.kill?.("SIGKILL"); } catch {}
      }
    }, Math.min(closeLimit, 1_500));
    timer.unref?.();
    childClosePromise?.finally(() => clearTimeout(timer));
  }

  function attachChild(childToAttach) {
    child = childToAttach;
    childClosePromise = new Promise(resolve => {
      let settled = false;
      const finish = (code, signal) => {
        if (settled) return;
        settled = true;
        const wasReady = state === "ready";
        if (child === childToAttach) child = null;
        checkedAt = clock();
        if (!stopping && !closed) {
          state = "failed";
          lastError = wasReady ? "process_exit" : (lastError || "process_exit");
          managedConfig = null;
          managedEnv = null;
          port = null;
          failStartup(problem("process_exit"));
        }
        resolve({ code: Number.isInteger(code) ? code : null, signal: signal || null });
      };
      childToAttach.once?.("error", () => {
        if (!stopping && !closed) {
          state = "failed";
          lastError = "process_error";
          managedConfig = null;
          managedEnv = null;
          port = null;
          failStartup(problem("process_error"));
        }
      });
      childToAttach.once?.("close", finish);
      const consume = chunk => {
        if (!outputCapturing) return;
        outputBytes += Buffer.byteLength(Buffer.isBuffer(chunk) ? chunk : String(chunk || ""));
        if (outputBytes > outputLimit) {
          lastError = "output_limit";
          failStartup(problem("output_limit", 502));
          stopChild(childToAttach);
        }
      };
      childToAttach.stdout?.on?.("data", consume);
      childToAttach.stderr?.on?.("data", consume);
      if (childToAttach.exitCode !== null && childToAttach.exitCode !== undefined
        || childToAttach.signalCode !== null && childToAttach.signalCode !== undefined) {
        queueMicrotask(() => finish(childToAttach.exitCode, childToAttach.signalCode));
      }
    });
    return childClosePromise;
  }

  function stopOutputCapture(childToStop) {
    outputCapturing = false;
    // Keep stdout/stderr drained after the startup gate.  Capturing output for
    // the entire lifetime would make normal verbose logs look like a startup
    // overflow and could kill a healthy server.
    childToStop?.stdout?.resume?.();
    childToStop?.stderr?.resume?.();
  }

  async function probe(baseUrl, username, password, authenticated, timeoutMs, externalSignal = null) {
    if (typeof fetchImpl !== "function") throw problem("fetch_unavailable");
    if (externalSignal?.aborted) throw problem("startup_cancelled");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(100, timeoutMs));
    const onExternalAbort = () => controller.abort();
    externalSignal?.addEventListener?.("abort", onExternalAbort, { once: true });
    const headers = { Accept: "application/json" };
    if (authenticated) headers.Authorization = basicAuthorization(username, password);
    try {
      const response = await fetchImpl(`${baseUrl}/global/health`, {
        method: "GET", headers, signal: controller.signal, redirect: "error",
      });
      if (!response || typeof response.status !== "number") throw problem("health_invalid", 502);
      if (!authenticated) {
        // Do not leave an unauthenticated conflict response body attached to a
        // live socket; it is not part of the trust decision.
        try { await response.body?.cancel?.(); } catch {}
        return { status: response.status };
      }
      let bytes = null;
      if (response.body?.getReader) {
        const reader = response.body.getReader();
        const chunks = [];
        let total = 0;
        for (;;) {
          const part = await reader.read();
          if (part.done) break;
          const chunk = Buffer.from(part.value || []);
          total += chunk.length;
          if (total > responseLimit) {
            try { await reader.cancel(); } catch {}
            throw problem("health_response_too_large", 502);
          }
          chunks.push(chunk);
        }
        bytes = Buffer.concat(chunks);
      } else if (typeof response.arrayBuffer === "function") {
        bytes = Buffer.from(await response.arrayBuffer());
        if (bytes.length > responseLimit) throw problem("health_response_too_large", 502);
      } else if (typeof response.text === "function") {
        bytes = Buffer.from(String(await response.text()));
        if (bytes.length > responseLimit) throw problem("health_response_too_large", 502);
      } else if (typeof response.json === "function") {
        const value = await response.json();
        bytes = Buffer.from(JSON.stringify(value));
        if (bytes.length > responseLimit) throw problem("health_response_too_large", 502);
        return { status: response.status, value };
      }
      if (!bytes?.length) return { status: response.status, value: null };
      try { return { status: response.status, value: JSON.parse(bytes.toString("utf8")) }; }
      catch { return { status: response.status, value: null }; }
    } catch (error) {
      if (error instanceof OpenCodeManagedServiceError) throw error;
      if (externalSignal?.aborted) throw problem("startup_cancelled");
      if (error?.name === "AbortError") throw problem("health_timeout", 504);
      throw problem("health_unreachable", 503);
    } finally {
      clearTimeout(timer);
      externalSignal?.removeEventListener?.("abort", onExternalAbort);
    }
  }

  async function waitForReady(baseUrl, username, password, deadline, externalSignal = null) {
    let delay = 25;
    let last = "health_unreachable";
    for (;;) {
      if (closed) throw problem("service_closed", 503);
      if (externalSignal?.aborted) throw problem("startup_cancelled");
      const remaining = deadline - clock();
      if (remaining <= 0) throw problem("startup_timeout", 504);
      try {
        const unauthenticated = await probe(baseUrl, username, password, false, Math.min(requestLimit, remaining), externalSignal);
        if (![401, 403].includes(unauthenticated.status)) {
          throw problem("unauthenticated_health_allowed", 409);
        }
        const authenticated = await probe(baseUrl, username, password, true, Math.min(requestLimit, remaining), externalSignal);
        if (authenticated.status === 401 || authenticated.status === 403) throw problem("authentication_failed", 502);
        if (authenticated.status < 200 || authenticated.status >= 300 || authenticated.value?.healthy !== true) {
          throw problem("health_invalid", 502);
        }
        return authenticated.value;
      } catch (error) {
        if (["unauthenticated_health_allowed", "authentication_failed", "health_invalid", "health_response_too_large", "fetch_unavailable", "startup_cancelled"].includes(error.code)) throw error;
        last = error.code || last;
        if (deadline - clock() <= 0) break;
        await sleep(Math.min(delay, Math.max(1, deadline - clock())));
        delay = Math.min(250, delay * 2);
      }
    }
    throw problem(last === "health_unreachable" ? "startup_timeout" : last, last === "health_timeout" ? 504 : 504);
  }

  async function startExternal() {
    if (explicit?.error) {
      state = "blocked";
      lastError = explicit.error;
      throw problem(explicit.error, 409);
    }
    state = "external";
    lastError = null;
    checkedAt = clock();
    startupResult = Object.freeze({ mode: "external", managed: false, status: status(), config: config(), env: resultingEnv() });
    return startupResult;
  }

  async function startManaged() {
    if (closed) throw problem("service_closed", 503);
    // Mark the manager busy before any asynchronous executable/port lookup so
    // an updater cannot observe a misleading idle state during startup.
    state = "starting";
    lastError = null;
    if (typeof resolveExecutable !== "function") throw problem("opencode_not_installed", 404);
    let executable;
    try { executable = await resolveExecutable(); } catch { throw problem("opencode_not_installed", 404); }
    if (closed) throw problem("service_closed", 503);
    if (!validOpenCodeExecutable(executable, platform)) throw problem("opencode_not_installed", 404);

    let allocated;
    try { allocated = await portAllocator(); } catch { throw problem("port_unavailable", 503); }
    if (closed) throw problem("service_closed", 503);
    const selectedPort = Number(allocated);
    if (!Number.isSafeInteger(selectedPort) || selectedPort < 1024 || selectedPort > 65535) throw problem("port_unavailable", 503);

    let bytes;
    try { bytes = randomBytes(32); } catch { throw problem("credential_generation_failed", 503); }
    if (!bytes || typeof bytes.toString !== "function") throw problem("credential_generation_failed", 503);
    const password = bytes.toString("base64url");
    if (!password || password.length < 32) throw problem("credential_generation_failed", 503);
    const username = DEFAULT_USERNAME;
    const baseUrl = `http://${LOOPBACK_HOST}:${selectedPort}`;
    const nextConfig = { baseUrl, origin: baseUrl, local: true, username, password, explicit: false };
    const nextEnv = childEnvironment(username, password);
    const args = ["serve", "--hostname", LOOPBACK_HOST, "--port", String(selectedPort)];
    if (closed) throw problem("service_closed", 503);
    outputBytes = 0;
    outputCapturing = true;
    port = selectedPort;
    startedAt = clock();
    state = "starting";
    lastError = null;
    managedConfig = nextConfig;
    managedEnv = nextEnv;
    stopping = false;

    let spawned;
    try {
      spawned = spawnImpl(executable, args, {
        env: nextEnv,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch {
      managedConfig = null; managedEnv = null; port = null; state = "failed"; lastError = "spawn_failed";
      throw problem("spawn_failed", 503);
    }
    if (!spawned || typeof spawned.once !== "function") {
      state = "failed"; lastError = "spawn_failed"; managedConfig = null; managedEnv = null; port = null;
      throw problem("spawn_failed", 503);
    }
    const failure = new Promise((_, reject) => { startupReject = reject; });
    // Install the rejection hook before attaching listeners: a child can
    // report a synchronous spawn/close failure in a test double (and on some
    // platforms an error event can arrive in the same turn as spawn()).
    attachChild(spawned);
    startupAbortController = new AbortController();
    const deadline = clock() + startupLimit;
    const startupTimer = setTimeout(() => {
      startupAbortController?.abort();
      failStartup(problem("startup_timeout", 504));
    }, startupLimit);
    try {
      const health = await Promise.race([waitForReady(baseUrl, username, password, deadline, startupAbortController.signal), failure]);
      if (closed) throw problem("service_closed", 503);
      if (!child || child !== spawned || spawned.exitCode !== null && spawned.exitCode !== undefined
        || spawned.signalCode !== null && spawned.signalCode !== undefined) throw problem("process_exit", 503);
      clearTimeout(startupTimer);
      stopOutputCapture(spawned);
      checkedAt = clock();
      state = "ready";
      startupAbortController = null;
      startupReject = null;
      startupResult = Object.freeze({ mode: "managed", managed: true, health, status: status(), config: config(), env: resultingEnv() });
      return startupResult;
    } catch (error) {
      clearTimeout(startupTimer);
      state = closed ? "closed" : "failed";
      lastError = error?.code || "startup_failed";
      startupAbortController?.abort();
      startupAbortController = null;
      startupReject = null;
      stopOutputCapture(spawned);
      stopChild(spawned);
      await Promise.race([childClosePromise || Promise.resolve(), sleep(closeLimit)]);
      managedConfig = null;
      managedEnv = null;
      port = null;
      startupResult = null;
      throw error instanceof OpenCodeManagedServiceError ? error : problem("startup_failed");
    }
  }

  async function start() {
    if (closed) throw problem("service_closed", 503);
    if ((state === "ready" || state === "external") && startupResult) return startupResult;
    if (startPromise) return startPromise;
    if (child && !status().cleanupConfirmed) throw problem("cleanup_pending", 503);
    startPromise = (explicit ? startExternal() : startManaged())
      .catch(error => {
        if (!closed && state !== "external") {
          state = "failed";
          lastError = error?.code || "startup_failed";
          managedConfig = null;
          managedEnv = null;
          port = null;
        }
        throw error;
      })
      .finally(() => { startPromise = null; });
    return startPromise;
  }

  async function close() {
    if (closed && !child) return status();
    closed = true;
    state = "closing";
    failStartup(problem("service_closed", 503));
    startupAbortController?.abort();
    if (child) {
      stopOutputCapture(child);
      stopChild(child);
    }
    if (startPromise) {
      try { await startPromise; } catch {}
    }
    let cleanupConfirmed = true;
    if (childClosePromise && child) {
      cleanupConfirmed = await Promise.race([
        childClosePromise.then(() => true),
        sleep(closeLimit).then(() => false),
      ]);
      if (cleanupConfirmed) child = null;
    }
    managedConfig = null;
    managedEnv = null;
    port = null;
    startupResult = null;
    lastError = null;
    state = "closed";
    // `child` remains referenced when the bounded reap deadline expires. The
    // service is terminal and cannot start another child, so ownership is not
    // silently lost while a stubborn process is still being quarantined.
    if (!cleanupConfirmed && child) state = "closed";
    return status();
  }

  // Bounded child replacement: stop the current server and spawn a fresh one
  // with the same credentials. Used after config-file edits so the next
  // /config/providers request reflects the new providers without touching the
  // terminal close() lifecycle.
  async function restart() {
    if (closed) throw problem("service_closed", 503);
    if (startPromise) {
      try { await startPromise; } catch {}
    }
    failStartup(problem("service_restart", 503));
    startupAbortController?.abort();
    const childToStop = child;
    if (childToStop) {
      stopOutputCapture(childToStop);
      stopChild(childToStop);
      if (childClosePromise) {
        await Promise.race([childClosePromise, sleep(closeLimit)]);
      }
    }
    child = null;
    childClosePromise = null;
    managedConfig = null;
    managedEnv = null;
    port = null;
    startupResult = null;
    state = explicit?.error ? "blocked" : explicit ? "external" : "idle";
    lastError = null;
    checkedAt = clock();
    stopping = false;
    return start();
  }

  return Object.freeze({
    start,
    status,
    config,
    env: resultingEnv,
    close,
    restart,
    resolveExecutable: async () => {
      let candidate;
      try { candidate = await resolveExecutable(); } catch { return null; }
      return validOpenCodeExecutable(candidate, platform) ? path.resolve(candidate) : null;
    },
  });
}

module.exports = {
  DEFAULT_CLOSE_TIMEOUT_MS,
  DEFAULT_MAX_OUTPUT_BYTES,
  DEFAULT_MAX_RESPONSE_BYTES,
  DEFAULT_REQUEST_TIMEOUT_MS,
  DEFAULT_STARTUP_TIMEOUT_MS,
  LOOPBACK_HOST,
  OpenCodeManagedServiceError,
  SERVICE_ID,
  allocateLoopbackPort,
  createOpenCodeManagedService,
  resolveOpenCodeExecutable,
};
