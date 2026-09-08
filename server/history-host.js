"use strict";
// Explicit, operator-managed read-only integration. Disabled without a reviewed
// local configuration. No discovery, dependency installation, native login or
// credential export. Config/ancestors/executable are a trusted Host boundary,
// not an OS sandbox or a claim of exact executed-binary pinning.
const fs = require("node:fs"), path = require("node:path");
const { canonicalJSON } = require("../public/modules/projection");
const { normalizeSourceInput } = require("../protocol/native/claude/history-source");
const { createNativeSourceService } = require("../protocol/native/claude/history-native-service");
const { createReaderAdmission } = require("../protocol/native/claude/history-reader-admission");
const { createHistoryRegistry } = require("../protocol/native/claude/history-registry");
const { createHistoryIdentity } = require("./history-identity");
const { createHistoryHttpHandler, configuredOrigin } = require("./history-http");
const { createHistoryRelayHandler } = require("./history-relay");
const CONFIG_BYTES = 128 * 1024;
const invalid = () => { throw new Error("history_configuration_invalid"); };
const exact = (v, keys) => v && typeof v === "object" && !Array.isArray(v)
  && Object.keys(v).sort().join(",") === [...keys].sort().join(",");
const canonicalPath = v => typeof v === "string" && v.length <= 4096 && path.isAbsolute(v)
  && path.resolve(v) === v && v !== path.parse(v).root && !/[\u0000-\u001f\u007f*?\[\]{},]/.test(v);
const u64 = v => typeof v === "string" && /^(0|[1-9][0-9]{0,19})$/.test(v) && BigInt(v) <= 18446744073709551615n;
const readerKey = v => typeof v === "string" && /^(browser:(master|[a-f0-9]{8,32})|peer:[a-f0-9]{32})$/.test(v);
function parseHistoryConfig(value) {
  let config;
  try { const raw = canonicalJSON(value, CONFIG_BYTES); if (raw === null) invalid(); config = JSON.parse(raw); } catch { invalid(); }
  if (!exact(config, ["version", "trustBoundary", "allowedOrigins", "reader", "catalog"])
    || config.version !== 1 || config.trustBoundary !== "host_managed_paths"
    || !Array.isArray(config.allowedOrigins) || !config.allowedOrigins.length || config.allowedOrigins.length > 16
    || !config.allowedOrigins.every(configuredOrigin) || new Set(config.allowedOrigins).size !== config.allowedOrigins.length
    || !Array.isArray(config.catalog) || config.catalog.length > 256) invalid();
  if (config.reader === null) { if (config.catalog.length) invalid(); }
  else if (!exact(config.reader, ["helperPath", "sdkPath"]) || !canonicalPath(config.reader.helperPath)
    || !canonicalPath(config.reader.sdkPath) || path.basename(config.reader.sdkPath) !== "sdk.mjs") invalid();
  const ids = new Set(), roots = new Map();
  for (const entry of config.catalog) {
    if (!exact(entry, ["catalogId", "label", "description", "source", "expectedRoot", "readers"])
      || typeof entry.catalogId !== "string" || !/^[A-Za-z0-9:_-]{1,128}$/.test(entry.catalogId) || ids.has(entry.catalogId)
      || typeof entry.label !== "string" || !entry.label.length || entry.label.length > 120 || /[\u0000-\u001f\u007f]/.test(entry.label)
      || typeof entry.description !== "string" || entry.description.length > 300 || /[\u0000-\u001f\u007f]/.test(entry.description)
      || !exact(entry.source, ["projectsRoot", "projectKey", "sessionId"]) || !normalizeSourceInput(entry.source)
      || !canonicalPath(entry.source.projectsRoot) || !exact(entry.expectedRoot, ["device", "inode"])
      || !u64(entry.expectedRoot.device) || !u64(entry.expectedRoot.inode) || entry.expectedRoot.inode === "0"
      || !Array.isArray(entry.readers) || !entry.readers.length || entry.readers.length > 149
      || !entry.readers.every(readerKey) || new Set(entry.readers).size !== entry.readers.length) invalid();
    ids.add(entry.catalogId);
    const previous = roots.get(entry.source.projectsRoot);
    if (previous && (previous.device !== entry.expectedRoot.device || previous.inode !== entry.expectedRoot.inode)) invalid();
    roots.set(entry.source.projectsRoot, entry.expectedRoot);
  }
  return config;
}

// Bounded one-time startup read, never a request-path source scan. Reject a
// changed/symlinked/overbroad config rather than silently enabling defaults.
// ACL and ancestor trust remain the operator's explicit responsibility here;
// the native reader independently enforces its stricter fd policy on sources.
function loadHistoryConfig(filename) {
  if (!canonicalPath(filename)) invalid();
  if (!["darwin", "linux"].includes(process.platform)) throw new Error("history_configuration_platform_unsupported");
  let fd, failure, result;
  try {
    if (fs.realpathSync(filename) !== filename) invalid();
    fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const before = fs.fstatSync(fd, { bigint: true });
    if (!before.isFile() || before.nlink !== 1n || before.uid !== BigInt(process.geteuid())
      || (before.mode & 0o077n) !== 0n || before.size < 1n || before.size > BigInt(CONFIG_BYTES)) invalid();
    const bytes = Buffer.alloc(Number(before.size)); let offset = 0;
    while (offset < bytes.length) { const n = fs.readSync(fd, bytes, offset, bytes.length - offset, offset); if (!n) invalid(); offset += n; }
    if (fs.readSync(fd, Buffer.alloc(1), 0, 1, offset)) invalid();
    const after = fs.fstatSync(fd, { bigint: true }), named = fs.lstatSync(filename, { bigint: true });
    const same = s => ["dev", "ino", "size", "mtimeNs", "ctimeNs", "uid", "mode", "nlink"].every(k => s[k] === before[k]);
    if (!same(after) || !same(named) || bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))) invalid();
    result = parseHistoryConfig(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
    if (result.reader) for (const target of [result.reader.helperPath, result.reader.sdkPath]) {
      if (fs.realpathSync(target) !== target) invalid();
      const s = fs.lstatSync(target);
      if (!s.isFile() || s.nlink !== 1 || s.uid !== process.geteuid() || (s.mode & 0o022)) invalid();
      fs.accessSync(target, target === result.reader.helperPath ? fs.constants.X_OK | fs.constants.R_OK : fs.constants.R_OK);
    }
  } catch { failure = new Error("history_configuration_invalid"); }
  finally { if (fd !== undefined) try { fs.closeSync(fd); } catch { failure = new Error("history_configuration_invalid"); } }
  if (failure) throw failure;
  return result;
}

const inHistoryNamespace = target => target === "/api/history" || target.startsWith("/api/history/") || target.startsWith("/api/history?")
  || /^\/r\/[^/]+\/api\/history(?:$|\/|\?)/.test(target);
function historyTarget(target) {
  if (inHistoryNamespace(target)) return true;
  // server.js normalizes URL dot segments before its legacy router. Reserve
  // normalized aliases as well, but let strict handlers reject their raw form;
  // otherwise /r/mini/api/./history could bypass gateway ownership checks.
  try { return inHistoryNamespace(new URL(target, "http://history.invalid").pathname); } catch { return false; }
}
function unavailable(res, code = "history_source_unavailable") {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(503, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
  res.end(JSON.stringify({ kind: "source_unavailable", code }));
}
function disabledHistoryHost() {
  return Object.freeze({ async handle(req, res) { if (!historyTarget(req.url || "")) return false; unavailable(res); return true; },
    logout() {}, credentialsChanged() {}, peerChanged() {}, status: () => ({ enabled: false }),
    shutdown: async () => ({ cleanupConfirmed: true }) });
}
function createHistoryHost({ config: input, browserCredentials, peerGrantIds, authenticatePeerCredential,
  resolvePeer, browserCookieNames = ["stepsemble", "pi_harbor", "pi_web"], sourceServiceFactory = createNativeSourceService } = {}) {
  const config = parseHistoryConfig(input);
  if (typeof resolvePeer !== "function" || typeof sourceServiceFactory !== "function") invalid();
  let registry, relay, closing, closed = false;
  const identity = createHistoryIdentity({ browserCredentials, peerGrantIds, authenticatePeerCredential,
    onRevoke(principal) { try { registry?.revokePrincipal(principal); } finally { relay?.revokePrincipal(principal); } } });
  const metadata = new Map(config.catalog.map(e => [e.catalogId, e]));
  const allowed = (principal, id) => { const key = identity.credentialKey(principal); return !!key && metadata.get(id)?.readers.includes(key) === true; };
  const roots = [...new Map(config.catalog.map(e => [e.source.projectsRoot, e.expectedRoot]))].map(([projectsRoot, expectedRoot]) => ({ projectsRoot, expectedRoot }));
  const admission = createReaderAdmission();
  let service;
  try {
    if (config.reader) {
      service = sourceServiceFactory({ ...config.reader, roots, admission });
      registry = createHistoryRegistry({ sourceService: service, catalog: config.catalog.map(({ catalogId, source }) => ({ catalogId, source })),
        authorize: allowed, principalActive: identity.isPrincipalCurrent });
    }
    const local = registry ? createHistoryHttpHandler({ registry, auth: identity, allowedOrigins: config.allowedOrigins, browserCookieNames,
      listCatalog: principal => {
        const key = identity.credentialKey(principal);
        return config.catalog.filter(e => key && e.readers.includes(key)).map(({ catalogId, label, description }) => ({ catalogId, label, description }));
      } }) : null;
    relay = createHistoryRelayHandler({ auth: identity, allowedOrigins: config.allowedOrigins, browserCookieNames, resolvePeer,
      isPeerCurrent(machineId, selected) {
        const p = resolvePeer(machineId);
        return !!p && [selected.url, selected.url + "/"].includes(p.url) && p.grantId === selected.grantId;
      } });
    return Object.freeze({
      async handle(req, res) {
        if (!historyTarget(req.url || "")) return false;
        if (closed) { unavailable(res, "history_registry_closed"); return true; }
        if (await relay(req, res)) return true;
        if (local && await local(req, res)) return true;
        unavailable(res); return true; // Never enter the legacy generic relay.
      },
      logout(req) {
        // Retire every accepted legacy alias, even when normal auth would pick
        // only one. This does not delete a shared Host token or native account.
        const text = req.headers.cookie;
        if (typeof text !== "string" || text.length > 4096) return;
        for (const part of text.split(";")) {
          const pair = part.trim().split("="); if (pair.length !== 2 || !browserCookieNames.includes(pair[0])) continue;
          try { identity.invalidateBrowserCookie(pair[0], decodeURIComponent(pair[1])); } catch { /* malformed cookie has no authority */ }
        }
      },
      credentialsChanged: () => identity.refresh(),
      peerChanged: machineId => relay.revokePeer(machineId),
      status: () => ({ enabled: true, registry: registry?.status() ?? null, workers: service?.status() ?? null, admission: admission.status() }),
      shutdown() {
        if (!closed) {
          closed = true;
          admission.close();
          identity.shutdown(); relay.shutdown();
          closing = (async () => {
            const result = registry ? await registry.shutdown() : { cleanupConfirmed: true };
            const shared = admission.status();
            return { ...result, cleanupConfirmed: result.cleanupConfirmed === true && shared.cleanupConfirmed,
              quarantined: result.quarantined === true || shared.quarantined };
          })();
        }
        return closing;
      },
    });
  } catch (error) {
    admission.close();
    identity.shutdown(); relay?.shutdown();
    try { void Promise.resolve(service?.shutdown()).catch(() => {}); } catch { /* construction failed closed */ }
    throw error;
  }
}
module.exports = { parseHistoryConfig, loadHistoryConfig, createHistoryHost, disabledHistoryHost, CONFIG_BYTES };
