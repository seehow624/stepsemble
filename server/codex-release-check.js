"use strict";

// Before Stepsemble updates Codex it checks that it supports the release the
// update would install, so an update never leaves Codex conversations unable
// to send. The official openai/codex repository publishes, for every release,
// the app-server schema documents that `codex app-server generate-json-schema`
// writes (codex-rs/app-server-protocol/schema/json at tag rust-v<version>);
// they are about 1 MB, where the release itself is 70 to 100 MB. A reviewed
// release needs no download. Any other is supported when its contract is the
// same as a reviewed one or only adds to the latest reviewed one.
//
// This is the check before installing. Once installed, the Host checks the
// executable itself again before using it (codex-compatibility.js).

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { registry, schemaFingerprint, SCHEMA_FILES } = require("./codex-compatibility");
const { CONTRACT_FILES, compareCodexContracts } = require("./codex-schema-compat");
const { loadContractBaseline } = require("./codex-contract-baseline");

const SOURCE_ROOT = "https://raw.githubusercontent.com/openai/codex/";
const SCHEMA_DIRECTORY = "/codex-rs/app-server-protocol/schema/json/";
const VERSION = /^\d{1,8}\.\d{1,8}\.\d{1,8}$/;
const MAX_FILE_BYTES = 16 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 20_000;
// A check that could not reach GitHub is tried again after this long.
const RETRY_UNKNOWN_MS = 10 * 60 * 1000;
const MAX_CACHED = 24;

function readCache(file) {
  if (!file) return {};
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    return value && typeof value === "object" && value.releases && typeof value.releases === "object" ? value.releases : {};
  } catch { return {}; }
}

function writeCache(file, releases) {
  if (!file) return;
  const directory = path.dirname(file);
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    fs.writeFileSync(temporary, JSON.stringify({ version: 1, releases }, null, 2) + "\n", { mode: 0o600 });
    fs.renameSync(temporary, file);
  } catch {
    try { fs.rmSync(temporary, { force: true }); } catch {}
  }
}

function createCodexReleaseCheck({
  cacheFile = null,
  fetchImpl = globalThis.fetch,
  clock = () => Date.now(),
  baseline = loadContractBaseline,
  profiles = () => registry().profiles,
  concurrency = 6,
  timeoutMs = FETCH_TIMEOUT_MS,
} = {}) {
  let releases = readCache(cacheFile);
  const pending = new Map();

  function verdict(version, state, extra = {}) {
    return Object.freeze({ state, version, how: null, reason: null, breaking: null, checkedAt: new Date(clock()).toISOString(), ...extra });
  }

  async function fetchText(url) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(url, { signal: controller.signal, redirect: "follow" });
      if (!response.ok) return { status: response.status };
      const length = Number(response.headers?.get?.("content-length"));
      if (Number.isFinite(length) && length > MAX_FILE_BYTES) return { status: 413 };
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.length > MAX_FILE_BYTES) return { status: 413 };
      return { status: 200, bytes };
    } catch { return { status: 0 }; }
    finally { clearTimeout(timer); }
  }

  async function evaluate(version) {
    const known = profiles().find(profile => profile.nativeVersion === version);
    if (known?.verification === "reviewed") return verdict(version, "supported", { how: "reviewed" });
    let contract;
    try { contract = baseline(); } catch { return verdict(version, "unknown", { reason: "baseline_unavailable" }); }
    const fetched = new Map();
    const queue = [...CONTRACT_FILES];
    await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, queue.length)) }, async () => {
      while (queue.length) {
        const file = queue.shift();
        fetched.set(file, await fetchText(SOURCE_ROOT + "rust-v" + version + SCHEMA_DIRECTORY + file));
      }
    }));
    const failed = [...fetched.values()].filter(result => result.status !== 200);
    if (failed.length) {
      const unpublished = failed.every(result => result.status === 404);
      return verdict(version, "unknown", { reason: unpublished ? "schema_unpublished" : "network" });
    }
    const rows = SCHEMA_FILES.map(file => {
      const bytes = fetched.get(file).bytes;
      return { file, bytes: bytes.length, sha256: crypto.createHash("sha256").update(bytes).digest("hex") };
    });
    let fingerprint;
    try { fingerprint = schemaFingerprint(rows); } catch { return verdict(version, "unknown", { reason: "schema_invalid" }); }
    if (profiles().some(profile => profile.schemaFingerprint === fingerprint)) return verdict(version, "supported", { how: "identical" });
    const documents = {};
    try { for (const file of CONTRACT_FILES) documents[file] = JSON.parse(fetched.get(file).bytes.toString("utf8")); }
    catch { return verdict(version, "unknown", { reason: "schema_invalid" }); }
    const comparison = compareCodexContracts(contract.documents, documents);
    return comparison.compatible
      ? verdict(version, "supported", { how: "additive", basedOn: contract.nativeVersion })
      : verdict(version, "unsupported", { reason: "contract_changed", basedOn: contract.nativeVersion, breaking: comparison.breaking.slice(0, 5) });
  }

  // The verdict for a stable release version. A decided verdict is kept (it
  // cannot change for that release and this Stepsemble); one that could not be
  // reached is tried again after a while.
  async function check(version) {
    const value = String(version || "").trim();
    if (!VERSION.test(value)) return verdict(value, "unknown", { reason: "version_unrecognized" });
    const baselineVersion = (() => { try { return baseline().nativeVersion; } catch { return null; } })();
    const cached = releases[value];
    if (cached && cached.baselineVersion === baselineVersion && (cached.state !== "unknown" || clock() - Date.parse(cached.checkedAt) < RETRY_UNKNOWN_MS)) {
      return Object.freeze({ ...cached });
    }
    if (pending.has(value)) return pending.get(value);
    const work = (async () => {
      const result = await evaluate(value);
      if (result.how !== "reviewed") {
        releases = { ...releases, [value]: { ...result, baselineVersion } };
        const names = Object.keys(releases);
        if (names.length > MAX_CACHED) for (const name of names.slice(0, names.length - MAX_CACHED)) delete releases[name];
        writeCache(cacheFile, releases);
      }
      return result;
    })().finally(() => pending.delete(value));
    pending.set(value, work);
    return work;
  }

  return Object.freeze({ check });
}

module.exports = { createCodexReleaseCheck, SOURCE_ROOT, SCHEMA_DIRECTORY };
