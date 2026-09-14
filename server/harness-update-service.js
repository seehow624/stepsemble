"use strict";

// Explicit, allow-listed update orchestration for local agent harnesses.
// This service is intentionally separate from Stepsemble's own updater:
// harnesses own their accounts, sessions, credentials, and release channels.
// A status check can observe those channels; an update always needs an
// explicit caller confirmation and is blocked while agent work is active.

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { execFile } = require("node:child_process");

const MAX_STATE_ENTRIES = 32;
const MAX_OUTPUT = 2_000;
const CHECK_TIMEOUT_MS = 20_000;
const UPDATE_TIMEOUT_MS = 15 * 60 * 1000;
const SENSITIVE_ENV = new Set([
  "OPENAI_API_KEY", "CODEX_API_KEY", "CODEX_REMOTE_TOKEN", "OPENCODEX_API_AUTH_TOKEN",
  "ANTHROPIC_API_KEY", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX",
  "GEMINI_API_KEY", "GOOGLE_API_KEY", "XAI_API_KEY",
]);

function cleanOutput(value) {
  return String(value || "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ").trim().slice(0, MAX_OUTPUT);
}

function now(clock) {
  return new Date((clock?.() || Date.now())).toISOString();
}

function safeId(value) {
  const id = String(value || "").trim().toLowerCase();
  return /^[a-z0-9][a-z0-9-]{0,63}$/.test(id) ? id : "";
}

function validateRegistry(registry) {
  if (!registry || registry.registryVersion !== 1 || !Array.isArray(registry.harnesses)
    || registry.harnesses.length > MAX_STATE_ENTRIES) throw new Error("Invalid harness update registry");
  const ids = new Set();
  for (const entry of registry.harnesses) {
    if (!entry || !safeId(entry.id) || ids.has(entry.id) || typeof entry.label !== "string") {
      throw new Error("Invalid or duplicate harness update entry");
    }
    if (!entry.check || !entry.update || typeof entry.check.kind !== "string" || typeof entry.update.kind !== "string"
      || !Array.isArray(entry.commands) || entry.commands.length > 8
      || entry.commands.some(command => typeof command !== "string" || !/^[a-zA-Z0-9._+@/-]{1,160}$/.test(command))) {
      throw new Error(`Missing update strategy for ${entry.id}`);
    }
    for (const strategy of [entry.check, entry.update]) {
      if (strategy.args !== undefined && (!Array.isArray(strategy.args) || strategy.args.length > 16
        || strategy.args.some(arg => typeof arg !== "string" || arg.length > 160 || /[\u0000-\u001f\u007f]/.test(arg)))) {
        throw new Error(`Invalid update arguments for ${entry.id}`);
      }
      if (strategy.kind === "command" && !Array.isArray(strategy.args)) throw new Error(`Missing command arguments for ${entry.id}`);
      if (!["manual", "version-only", "official-check", "command", "npm-outdated", "npm-global", "brew-or-official", "brew-or-command"].includes(strategy.kind)) {
        throw new Error(`Unsupported update strategy for ${entry.id}`);
      }
    }
    if (entry.package !== undefined && (typeof entry.package !== "string" || !/^@?[a-zA-Z0-9._/-]+$/.test(entry.package))) {
      throw new Error(`Invalid package for ${entry.id}`);
    }
    ids.add(entry.id);
  }
  return registry;
}

function readJson(file) {
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch { return {}; }
}

function writeJsonAtomic(file, value) {
  const directory = path.dirname(file);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(directory, 0o700); } catch {}
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    try { fs.chmodSync(temporary, 0o600); } catch {}
    fs.renameSync(temporary, file);
    try { fs.chmodSync(file, 0o600); } catch {}
  } finally {
    try { fs.rmSync(temporary, { force: true }); } catch {}
  }
}

function cleanEnvironment(source = process.env, { preserveHome = true } = {}) {
  const env = { ...source };
  for (const key of SENSITIVE_ENV) delete env[key];
  env.STEPSEMBLE_UPDATE_PROBE = "1";
  if (!preserveHome) {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "stepsemble-harness-probe-"));
    env.HOME = home;
    env.USERPROFILE = home;
    env.XDG_CONFIG_HOME = path.join(home, ".config");
    env.XDG_CACHE_HOME = path.join(home, ".cache");
  }
  return env;
}

function isExecutable(file) {
  if (!file || !path.isAbsolute(file)) return false;
  try {
    const stat = fs.statSync(file);
    return stat.isFile() && (process.platform === "win32" || (stat.mode & 0o111) !== 0);
  } catch { return false; }
}

function commandPath(name, env = process.env) {
  if (!name) return null;
  if (path.isAbsolute(name)) return isExecutable(name) ? path.resolve(name) : null;
  const pathKey = Object.hasOwn(env, "PATH") ? "PATH" : Object.keys(env).find(key => key.toUpperCase() === "PATH");
  const entries = String(pathKey ? env[pathKey] || "" : process.env.PATH || "").split(path.delimiter).filter(Boolean);
  const extensions = process.platform === "win32" ? ["", ".exe", ".cmd", ".bat"] : [""];
  for (const dir of entries) for (const ext of extensions) {
    const candidate = path.resolve(dir, `${name}${ext}`);
    if (isExecutable(candidate)) return candidate;
  }
  const home = String(env.HOME || os.homedir());
  const extra = process.platform === "darwin"
    ? ["/opt/homebrew/bin", "/usr/local/bin"]
    : ["/usr/local/bin", "/usr/bin"];
  extra.push(path.join(home, ".local", "bin"), path.join(home, ".hermes", "node", "bin"));
  for (const dir of extra) for (const ext of extensions) {
    const candidate = path.join(dir, `${name}${ext}`);
    if (isExecutable(candidate)) return candidate;
  }
  return null;
}

function execFilePromise(file, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { shell: false, ...options }, (error, stdout, stderr) => {
      const result = { code: error ? (Number.isInteger(error.code) ? error.code : null) : 0,
        stdout: String(stdout || ""), stderr: String(stderr || ""), error: error || null };
      if (error && !Number.isInteger(error.code) && error.killed) result.code = "timeout";
      resolve(result);
    });
  });
}

function parseVersion(output) {
  const text = cleanOutput(output);
  const match = text.match(/(?:^|\s)v?(\d+(?:\.\d+){0,3}(?:[-+][0-9A-Za-z.-]+)?)(?:\s|$)/);
  return match ? match[1] : text.slice(0, 160) || null;
}

function parseSemver(value) {
  const match = String(value || "").trim().replace(/^v/i, "").match(/^(\d+)\.(\d+)(?:\.(\d+))?/);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3] || 0)] : null;
}

function isNewer(latest, current) {
  const a = parseSemver(latest), b = parseSemver(current);
  if (!a || !b) return Boolean(latest && current && latest !== current);
  for (let i = 0; i < 3; i += 1) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}

function resultError(result, fallback = "command_failed") {
  if (!result) return fallback;
  if (result.code === "timeout") return "timeout";
  if (result.error?.code === "ENOENT") return "not-installed";
  return `exit-${result.code ?? "unknown"}`;
}

function createHarnessUpdateService({
  registry,
  registryFile,
  stateFile,
  env = process.env,
  clock = () => Date.now(),
  runner = execFilePromise,
  busy = () => false,
  resolve = commandPath,
  home = String(env.HOME || os.homedir()),
} = {}) {
  const loadedRegistry = validateRegistry(registry || readJson(registryFile));
  const entries = loadedRegistry.harnesses.map(item => ({ ...item, id: safeId(item.id) }));
  let state = readJson(stateFile);
  if (!Array.isArray(state.entries)) state.entries = [];
  let running = null;

  const byId = id => entries.find(entry => entry.id === safeId(id)) || null;
  const stateById = id => state.entries.find(entry => entry.id === id) || null;
  const save = () => { if (stateFile) writeJsonAtomic(stateFile, state); };
  const errorStatus = (code, message, statusCode = 409) => Object.assign(new Error(message), { code, statusCode });

  function publicEntry(definition, observed = {}) {
    const result = {
      id: definition.id,
      label: definition.label,
      installed: observed.installed === true,
      executable: observed.installed === true,
      currentVersion: observed.currentVersion || null,
      latestVersion: observed.latestVersion || null,
      updateAvailable: observed.updateAvailable === true ? true : observed.updateAvailable === false ? false : "unknown",
      status: observed.status || (definition.check.kind === "manual" ? "manual" : "not-checked"),
      checkMode: definition.check.kind,
      updateMode: definition.update.kind,
      checkedAt: observed.checkedAt || null,
      updatedAt: observed.updatedAt || null,
      error: observed.error || null,
      note: definition.note || definition.update.reason || null,
    };
    return result;
  }

  function publicStatus() {
    let busyState = { busy: true, reason: "busy_state_unavailable" };
    try { busyState = busy(); } catch {}
    return {
      schemaVersion: 1,
      checkedAt: state.checkedAt || null,
      running: Boolean(running),
      busy: Boolean(busyState?.busy ?? busyState),
      harnesses: entries.map(entry => publicEntry(entry, stateById(entry.id) || {})),
      lastUpdate: state.lastUpdate || null,
    };
  }

  async function observe(definition) {
    const previous = stateById(definition.id) || {};
    const executable = definition.executableEnv && env[definition.executableEnv]
      ? resolve(env[definition.executableEnv], env) : (definition.commands || []).map(name => resolve(name, env)).find(Boolean);
    const observed = { ...previous, id: definition.id, checkedAt: now(clock), executable: executable || null };
    if (!executable) {
      observed.installed = false;
      observed.currentVersion = null;
      observed.latestVersion = null;
      observed.status = definition.check.kind === "manual" ? "manual" : "not-installed";
      observed.updateAvailable = false;
      observed.error = null;
      return observed;
    }
    observed.installed = true;
    const version = await runner(executable, ["--version"], {
      shell: false, cwd: home, env: cleanEnvironment(env), timeout: CHECK_TIMEOUT_MS, maxBuffer: 64 * 1024,
    });
    if (version.code !== 0 && !version.stdout && !version.stderr) {
      observed.status = "error";
      observed.error = resultError(version, "version_failed");
      return observed;
    }
    observed.currentVersion = parseVersion(version.stdout || version.stderr);
    const check = definition.check || { kind: "version-only" };
    if (check.kind === "manual" || check.kind === "version-only") {
      observed.status = check.kind === "manual" ? "manual" : "unknown";
      observed.updateAvailable = "unknown";
      observed.error = null;
      return observed;
    }
    if (check.kind === "npm-outdated") {
      const npm = resolve("npm", env);
      if (!npm || !definition.package) {
        observed.status = "unknown";
        observed.updateAvailable = "unknown";
        observed.error = "npm_unavailable";
        return observed;
      }
      const checked = await runner(npm, ["outdated", "--global", "--json", definition.package], {
        shell: false, cwd: home, env: cleanEnvironment(env), timeout: CHECK_TIMEOUT_MS, maxBuffer: 128 * 1024,
      });
      let parsed = null;
      try { parsed = JSON.parse(checked.stdout || "{}"); } catch {}
      const row = parsed?.[definition.package] || parsed?.[definition.package.replace(/^@[^/]+\//, "")] || null;
      observed.latestVersion = row?.latest || row?.wanted || null;
      observed.updateAvailable = Boolean(row && isNewer(row.latest || row.wanted, row.current || observed.currentVersion));
      observed.status = observed.updateAvailable ? "available" : checked.code === 0 ? "up-to-date" : parsed ? "up-to-date" : "unknown";
      observed.error = parsed || checked.code === 0 ? null : resultError(checked, "npm_check_failed");
      return observed;
    }
    if (check.kind === "brew-or-official") {
      const brew = resolve("brew", env);
      let brewManaged = false;
      if (brew && check.package) {
        const listed = await runner(brew, ["list", "--versions", check.package], {
          shell: false, cwd: home, env: cleanEnvironment(env), timeout: CHECK_TIMEOUT_MS, maxBuffer: 32 * 1024,
        });
        brewManaged = listed.code === 0 && Boolean(String(listed.stdout || "").trim());
      }
      if (brewManaged) {
        const checked = await runner(brew, ["outdated", "--json=v2", check.package], {
          shell: false, cwd: home, env: cleanEnvironment(env), timeout: CHECK_TIMEOUT_MS, maxBuffer: 128 * 1024,
        });
        let parsed = null;
        try { parsed = JSON.parse(checked.stdout || "{}"); } catch {}
        const formula = [...(parsed?.formulae || []), ...(parsed?.casks || [])].find(item => item.name === check.package);
        observed.latestVersion = formula?.latest_version || formula?.versioned_formula?.version || null;
        observed.updateAvailable = Boolean(formula);
        observed.status = formula ? "available" : checked.code === 0 ? "up-to-date" : "unknown";
        observed.error = parsed || checked.code === 0 ? null : resultError(checked, "brew_check_failed");
        return observed;
      }
      // Homebrew is preferred because it can check without mutating. When a
      // binary is not brew-managed, fall back to its own check flag only if it
      // is explicitly supported by the harness.
      if (Array.isArray(check.args) && check.args.length) {
        const checked = await runner(executable, check.args, {
          shell: false, cwd: home, env: cleanEnvironment(env), timeout: CHECK_TIMEOUT_MS, maxBuffer: 128 * 1024,
        });
        const output = cleanOutput(`${checked.stdout}\n${checked.stderr}`);
        observed.status = checked.code === 0 && /available|upgrade|outdated/i.test(output) ? "available" : checked.code === 0 ? "up-to-date" : "unknown";
        observed.updateAvailable = observed.status === "available";
        observed.error = observed.status === "unknown" ? resultError(checked, "official_check_unavailable") : null;
        return observed;
      }
    }
    if (check.kind === "official-check" || check.kind === "command") {
      const checked = await runner(executable, Array.isArray(check.args) ? check.args : [], {
        shell: false, cwd: home, env: cleanEnvironment(env), timeout: CHECK_TIMEOUT_MS, maxBuffer: 128 * 1024,
      });
      const output = cleanOutput(`${checked.stdout}\n${checked.stderr}`);
      // Several vendor CLIs ship an updater but no stable dry-run flag. Treat
      // that capability gap as an honest, neutral "unknown" result instead of
      // presenting it as a failed update or asking the user to retry blindly.
      const unsupported = /unknown option|unrecognized option|invalid option|unexpected argument|not found/i.test(output);
      const supported = checked.code === 0 && !unsupported;
      if (!supported) {
        observed.status = "unknown";
        observed.updateAvailable = "unknown";
        observed.error = unsupported ? null : resultError(checked, "official_check_unavailable");
      } else {
        observed.status = /available|outdated|behind|upgrade available/i.test(output) ? "available" : "up-to-date";
        observed.updateAvailable = observed.status === "available";
        observed.error = null;
      }
      return observed;
    }
    observed.status = "unknown";
    observed.updateAvailable = "unknown";
    observed.error = "unsupported_check_strategy";
    return observed;
  }

  async function checkOne(definition) {
    const observed = await observe(definition);
    const index = state.entries.findIndex(item => item.id === definition.id);
    if (index >= 0) state.entries[index] = observed; else state.entries.push(observed);
    state.entries = state.entries.slice(-MAX_STATE_ENTRIES);
    state.checkedAt = now(clock);
    save();
    return publicEntry(definition, observed);
  }

  async function check({ id = null } = {}) {
    const selected = id ? byId(id) : null;
    if (id && !selected) throw errorStatus("unknown_harness", "Unknown harness", 404);
    const target = selected ? [selected] : entries;
    const work = (async () => {
      const output = [];
      for (const definition of target) {
        try { output.push(await checkOne(definition)); }
        catch (error) {
          const previous = stateById(definition.id) || { id: definition.id };
          previous.status = "error"; previous.error = String(error.code || error.message || "check_failed").slice(0, 120);
          previous.checkedAt = now(clock); state.entries = [...state.entries.filter(item => item.id !== definition.id), previous];
          output.push(publicEntry(definition, previous));
        }
      }
      save();
      return publicStatusWith(output);
    })();
    return work;
  }

  function publicStatusWith(entriesOverride) {
    const status = publicStatus();
    if (Array.isArray(entriesOverride)) status.harnesses = entriesOverride;
    return status;
  }

  async function updateCommand(definition, executable) {
    const strategy = definition.update || {};
    if (strategy.kind === "command") return { executable, args: Array.isArray(strategy.args) ? strategy.args : [] };
    if (strategy.kind === "npm-global") {
      const npm = resolve("npm", env);
      if (!npm || !definition.package) return null;
      return { executable: npm, args: ["install", "--global", `${definition.package}@latest`] };
    }
    if (strategy.kind === "brew-or-command") {
      const brew = resolve("brew", env);
      if (brew && strategy.package) {
        const listed = await runner(brew, ["list", "--versions", strategy.package], {
          shell: false, cwd: home, env: cleanEnvironment(env), timeout: CHECK_TIMEOUT_MS, maxBuffer: 32 * 1024,
        });
        if (listed.code === 0 && String(listed.stdout || "").trim()) return { executable: brew, args: ["upgrade", strategy.package] };
      }
      return { executable, args: Array.isArray(strategy.args) ? strategy.args : [] };
    }
    return null;
  }

  async function updateOne(definition, { confirm = false } = {}) {
    if (!confirm) throw errorStatus("confirmation_required", "Explicit confirmation is required", 400);
    let busyState;
    try { busyState = busy(); } catch { throw errorStatus("agent_busy", "Agent state is unavailable; try again when idle", 409); }
    if (busyState?.busy ?? busyState) throw errorStatus("agent_busy", "Wait for active agent work to finish", 409);
    const executable = definition.executableEnv && env[definition.executableEnv]
      ? resolve(env[definition.executableEnv], env) : (definition.commands || []).map(name => resolve(name, env)).find(Boolean);
    if (!executable) throw errorStatus("not_installed", `${definition.label} is not installed`, 422);
    const command = await updateCommand(definition, executable);
    if (!command) throw errorStatus("manual_update", definition.update.reason || `${definition.label} must be updated by its host`, 422);
    const startedAt = now(clock);
    const result = await runner(command.executable, command.args, {
      shell: false, cwd: home, env: cleanEnvironment(env), timeout: UPDATE_TIMEOUT_MS, maxBuffer: 512 * 1024,
    });
    const successful = result.code === 0;
    // Never persist stdout/stderr: package managers and vendor updaters may
    // print URLs, account identifiers, or other sensitive diagnostics.
    const record = { id: definition.id, label: definition.label, startedAt, finishedAt: now(clock), success: successful,
      code: successful ? 0 : result.code, error: successful ? null : resultError(result, "update_failed") };
    state.lastUpdate = record;
    const previous = stateById(definition.id) || { id: definition.id };
    previous.updatedAt = record.finishedAt;
    if (successful) { previous.status = "updated"; previous.updateAvailable = false; previous.error = null; }
    else { previous.status = "error"; previous.error = record.error; }
    state.entries = [...state.entries.filter(item => item.id !== definition.id), previous];
    save();
    if (!successful) throw Object.assign(new Error(record.error || "Harness update failed"), { statusCode: 502, code: record.error, result: record });
    return { ...publicStatus(), updated: record };
  }

  async function update({ id, confirm = false } = {}) {
    const definition = byId(id);
    if (!definition) throw errorStatus("unknown_harness", "Unknown harness", 404);
    if (running) throw errorStatus("update_in_progress", "Another harness update is already running", 409);
    running = updateOne(definition, { confirm }).finally(() => { running = null; });
    return running;
  }

  async function updateAll({ confirm = false } = {}) {
    if (!confirm) throw errorStatus("confirmation_required", "Explicit confirmation is required", 400);
    if (running) throw errorStatus("update_in_progress", "Another harness update is already running", 409);
    running = (async () => {
      const results = [];
      for (const definition of entries) {
        if (definition.update?.kind === "manual") {
          results.push({ id: definition.id, label: definition.label, status: "manual", reason: definition.update.reason || null });
          continue;
        }
        try {
          const result = await updateOne(definition, { confirm: true });
          results.push({ id: definition.id, label: definition.label, status: "updated", result: result.updated });
        } catch (error) {
          const status = error.code === "agent_busy" ? "blocked" : error.code === "not_installed" ? "not-installed" : "failed";
          results.push({ id: definition.id, label: definition.label, status,
            code: error.code || null, error: String(error.message || error).slice(0, 200) });
          if (error.code === "agent_busy") break;
        }
      }
      return { ...publicStatus(), results };
    })().finally(() => { running = null; });
    return running;
  }

  return Object.freeze({ status: publicStatus, check, update, updateAll, isRunning: () => Boolean(running) });
}

function loadHarnessUpdateRegistry(file) {
  return validateRegistry(readJson(file));
}

module.exports = { createHarnessUpdateService, loadHarnessUpdateRegistry, validateRegistry, cleanEnvironment, parseVersion, isNewer };
