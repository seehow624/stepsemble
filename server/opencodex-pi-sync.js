"use strict";

// OpenCodex keeps a block in Pi's models.json (providers.opencodex) that lists
// the models it serves. OpenCodex rewrites that block when it starts, when its
// own settings change and on "ocx sync", but its hourly catalog refresh does
// not, so a model OpenCodex starts serving between those moments stays out of
// Pi's model menu. This check compares the two lists and, when they differ,
// asks OpenCodex to write its block again with its own command:
//
//   opencodex integration client enable --client pi --json
//
// OpenCodex owns that write: it keeps a snapshot first and refuses when the
// block was edited by hand. Stepsemble never edits the block itself and never
// reads OpenCodex's credentials. The model list is read from OpenCodex's
// loopback /models endpoint only.

const crypto = require("node:crypto");
const { execFile } = require("node:child_process");
const { withCommandDirectory } = require("./command-environment");

const PROVIDER = "opencodex";
const FETCH_TIMEOUT_MS = 5000;
const COMMAND_TIMEOUT_MS = 60 * 1000;
// A refresh that left the lists different is not tried again for the same
// OpenCodex list; a failed one is tried again after this long.
const RETRY_FAILED_MS = 60 * 60 * 1000;
const MAX_MODELS = 2000;
const COMMAND_ARGS = Object.freeze(["integration", "client", "enable", "--client", "pi", "--json"]);

function loopbackModelsUrl(baseUrl) {
  let url;
  try { url = new URL(String(baseUrl || "")); } catch { return null; }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) return null;
  if (url.username || url.password) return null;
  url.pathname = url.pathname.replace(/\/+$/, "") + "/models";
  url.search = ""; url.hash = "";
  return url.href;
}

function modelIds(rows) {
  if (!Array.isArray(rows) || rows.length > MAX_MODELS) return null;
  const ids = new Set();
  for (const row of rows) {
    const id = typeof row === "string" ? row : row?.id;
    if (typeof id !== "string" || !id || id.length > 256) return null;
    ids.add(id);
  }
  return ids;
}

function fingerprint(ids) {
  return crypto.createHash("sha256").update([...ids].sort().join("\n")).digest("hex").slice(0, 16);
}

// The command prints notices before its JSON; the result is the object that
// starts at the beginning of a line.
function parseCommandResult(stdout) {
  const text = String(stdout || "");
  const start = text.search(/^\{/m);
  if (start < 0) return null;
  try { return JSON.parse(text.slice(start)); } catch { return null; }
}

function execFilePromise(file, args, options) {
  return new Promise(resolve => {
    execFile(file, args, { shell: false, ...options }, (error, stdout, stderr) => {
      resolve({ code: error ? (Number.isInteger(error.code) ? error.code : null) : 0, stdout: String(stdout || ""), stderr: String(stderr || "") });
    });
  });
}

function createOpenCodexPiSync({
  readModelConfig,
  resolveCommand,
  fetch: request = globalThis.fetch,
  runner = execFilePromise,
  env = process.env,
  cwd,
  now = Date.now,
  onRefreshed = () => {},
  platform = process.platform,
  // The command is a Node script ("#!/usr/bin/env node"); the Node that runs
  // Stepsemble is found after anything already on PATH.
  runtime = process.execPath,
} = {}) {
  if (typeof readModelConfig !== "function") throw new TypeError("read_model_config_required");
  if (typeof resolveCommand !== "function") throw new TypeError("resolve_command_required");
  let inFlight = null;
  let lastAttempt = null;
  let last = { state: "unchecked", checkedAt: null };

  function record(result) {
    last = { ...result, checkedAt: now() };
    return last;
  }

  async function served(url) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const response = await request(url, { headers: { accept: "application/json" }, redirect: "error", signal: controller.signal });
      if (!response.ok) return null;
      const body = await response.json();
      return modelIds(body?.data);
    } catch { return null; }
    finally { clearTimeout(timer); }
  }

  async function run() {
    let config;
    try { config = readModelConfig(); } catch { return record({ state: "unreadable" }); }
    const block = config?.providers?.[PROVIDER];
    if (!block || typeof block !== "object") return record({ state: "absent" });
    const url = loopbackModelsUrl(block.baseUrl);
    if (!url) return record({ state: "absent" });
    const listed = modelIds(Array.isArray(block.models) ? block.models : []);
    const offered = await served(url);
    if (!listed || !offered) return record({ state: "unavailable" });
    const added = [...offered].filter(id => !listed.has(id));
    const removed = [...listed].filter(id => !offered.has(id));
    if (!added.length && !removed.length) return record({ state: "current" });
    const print = fingerprint(offered);
    if (lastAttempt?.fingerprint === print && (lastAttempt.ok || now() - lastAttempt.at < RETRY_FAILED_MS)) {
      return record({ state: "waiting", added: added.length, removed: removed.length });
    }
    if (platform === "win32") return record({ state: "unsupported", added: added.length, removed: removed.length });
    const command = resolveCommand();
    if (!command) return record({ state: "no_command", added: added.length, removed: removed.length });
    const result = await runner(command, COMMAND_ARGS.slice(), {
      cwd, env: withCommandDirectory(withCommandDirectory(env, command), runtime), timeout: COMMAND_TIMEOUT_MS, maxBuffer: 1024 * 1024,
    });
    const parsed = parseCommandResult(result.stdout);
    const ok = result.code === 0 && !!parsed && parsed.ok !== false;
    lastAttempt = { fingerprint: print, at: now(), ok };
    if (ok) {
      try { onRefreshed(); } catch {}
      return record({ state: "refreshed", added: added.length, removed: removed.length });
    }
    return record({ state: "refused", added: added.length, removed: removed.length,
      reason: typeof parsed?.message === "string" ? parsed.message.slice(0, 200) : result.code === null ? "command_failed" : "exit_" + result.code });
  }

  function check() {
    if (!inFlight) inFlight = run().catch(() => record({ state: "failed" })).finally(() => { inFlight = null; });
    return inFlight;
  }

  return Object.freeze({ check, status: () => ({ ...last }) });
}

module.exports = { createOpenCodexPiSync, loopbackModelsUrl, parseCommandResult, COMMAND_ARGS };
