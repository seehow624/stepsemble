"use strict";
// Explicit, operator-managed read-only integration. Disabled without a reviewed
// local configuration. Discovery only on an authorized source-group refresh;
// no dependency installation, native login or credential export.
// Config/ancestors/executable are a trusted Host boundary,
// not an OS sandbox or a claim of exact executed-binary pinning.
const fs = require("node:fs"), path = require("node:path");
const { randomUUID } = require("node:crypto");
const nativeWire = require("../protocol/native/claude/history-bytes-wire");
const { validMetadata } = require("../protocol/native/claude/history-metadata");
const { canonicalJSON } = require("../public/modules/projection");
const { normalizeSourceInput } = require("../protocol/native/claude/history-source");
const { createNativeSourceService } = require("../protocol/native/claude/history-native-service");
const { createReaderAdmission } = require("../protocol/native/claude/history-reader-admission");
const { createSourceIndex } = require("../protocol/native/claude/history-source-index");
const { createHistoryRegistry } = require("../protocol/native/claude/history-registry");
const { createCodexSourceIndex, normalizeGroupSource } = require("../protocol/native/codex/history-source-index");
const { createCodexSourceService } = require("../protocol/native/codex/history-source-service");
const codexWire = require("../protocol/native/codex/parser-wire");
const { createHistorySourceServices, normalizeSource, validReadPage } = require("./history-source-services");
const { createHistoryIdentity } = require("./history-identity");
const { createHistoryHttpHandler, configuredOrigin, PUBLIC_CODES } = require("./history-http");
const { createHistoryRelayHandler } = require("./history-relay");
const CONFIG_BYTES = 128 * 1024;
const SOURCE_GROUP_LIMIT = 8;
const invalid = () => { throw new Error("history_configuration_invalid"); };
const exact = (v, keys) => v && typeof v === "object" && !Array.isArray(v)
  && Object.keys(v).sort().join(",") === [...keys].sort().join(",");
const canonicalPath = v => typeof v === "string" && v.length <= 4096 && path.isAbsolute(v)
  && path.resolve(v) === v && v !== path.parse(v).root && !/[\u0000-\u001f\u007f*?\[\]{},]/.test(v);
const u64 = v => typeof v === "string" && /^(0|[1-9][0-9]{0,19})$/.test(v) && BigInt(v) <= 18446744073709551615n;
const readerKey = v => typeof v === "string" && /^(browser:(master|[a-f0-9]{8,32})|peer:[a-f0-9]{32})$/.test(v);
const codexGroupSource = g => ({ nativeVersion: g.nativeVersion, codexRoot: g.codexRoot, expectedCodexRoot: g.expectedCodexRoot,
  sqliteRoot: g.sqliteRoot, expectedSqliteRoot: g.expectedSqliteRoot });
function parseHistoryConfig(value) {
  let config;
  try { const raw = canonicalJSON(value, CONFIG_BYTES); if (raw === null) invalid(); config = JSON.parse(raw); } catch { invalid(); }
  if (!exact(config, ["version", "trustBoundary", "allowedOrigins", "reader", "catalog", ...(config?.version >= 2 ? ["sourceGroups"] : [])])
    || ![1, 2, 3].includes(config.version) || config.trustBoundary !== "host_managed_paths"
    || !Array.isArray(config.allowedOrigins) || !config.allowedOrigins.length || config.allowedOrigins.length > 16
    || !config.allowedOrigins.every(configuredOrigin) || new Set(config.allowedOrigins).size !== config.allowedOrigins.length
    || !Array.isArray(config.catalog) || config.catalog.length > 256) invalid();
  const groups = config.version >= 2 ? config.sourceGroups : [];
  if (!Array.isArray(groups) || groups.length > SOURCE_GROUP_LIMIT) invalid();
  if (config.reader === null) { if (config.catalog.length || groups.length) invalid(); }
  else if (!exact(config.reader, ["helperPath", "sdkPath"]) || !canonicalPath(config.reader.helperPath)
    || !(canonicalPath(config.reader.sdkPath) && path.basename(config.reader.sdkPath) === "sdk.mjs"
      || config.version === 3 && config.reader.sdkPath === null && config.catalog.length === 0 && groups.every(g => g?.agentId === "codex"))) invalid();
  const ids = new Set(), roots = new Map();
  function root(projectsRoot, expectedRoot) {
    const previous = roots.get(projectsRoot);
    if (previous && (previous.device !== expectedRoot.device || previous.inode !== expectedRoot.inode)) invalid();
    roots.set(projectsRoot, expectedRoot);
    if (roots.size > 256) invalid();
  }
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
    if (groups.length && /^(claude|codex)-[a-f0-9]{64}$/.test(entry.catalogId)) invalid(); // Reserved dynamic identity namespace.
    root(entry.source.projectsRoot, entry.expectedRoot);
  }
  const groupIds = new Set(), groupRoots = new Set();
  for (const group of groups) {
    const codex = config.version === 3 && group?.agentId === "codex";
    if (!exact(group, ["sourceId", "agentId", "scope", "label", "description", "readers", ...(codex
      ? ["nativeVersion", "codexRoot", "expectedCodexRoot", "sqliteRoot", "expectedSqliteRoot"] : ["projectsRoot", "expectedRoot"])])
      || typeof group.sourceId !== "string" || !/^[A-Za-z0-9:_-]{1,128}$/.test(group.sourceId) || groupIds.has(group.sourceId)
      || !(codex ? group.scope === "stored_threads" : group.agentId === "claude-code" && group.scope === "main_sessions")
      || typeof group.label !== "string" || !group.label.length || group.label.length > 120 || /[\u0000-\u001f\u007f]/.test(group.label)
      || typeof group.description !== "string" || group.description.length > 300 || /[\u0000-\u001f\u007f]/.test(group.description)
      || !Array.isArray(group.readers) || !group.readers.length || group.readers.length > 149
      || !group.readers.every(readerKey) || new Set(group.readers).size !== group.readers.length) invalid();
    if (codex) {
      if (!normalizeGroupSource(codexGroupSource(group)) || !canonicalPath(group.codexRoot) || !canonicalPath(group.sqliteRoot)) invalid();
      const key = JSON.stringify(["codex", group.sqliteRoot, group.codexRoot]);
      if (groupRoots.has(key)) invalid(); groupRoots.add(key);
      root(group.codexRoot, group.expectedCodexRoot); root(group.sqliteRoot, group.expectedSqliteRoot);
    } else {
      if (!canonicalPath(group.projectsRoot) || groupRoots.has(group.projectsRoot)
        || !exact(group.expectedRoot, ["device", "inode"]) || !u64(group.expectedRoot.device) || !u64(group.expectedRoot.inode) || group.expectedRoot.inode === "0") invalid();
      groupRoots.add(group.projectsRoot); root(group.projectsRoot, group.expectedRoot);
    }
    groupIds.add(group.sourceId);
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
    historyReaderMetadata(result.reader);
  } catch { failure = new Error("history_configuration_invalid"); }
  finally { if (fd !== undefined) try { fs.closeSync(fd); } catch { failure = new Error("history_configuration_invalid"); } }
  if (failure) throw failure;
  return result;
}

// Shared startup/operator preflight. Metadata only: does not load/execute the
// artifacts and is not their runtime hash pin or the source fd ACL/mount gate.
function historyReaderMetadata(reader) {
  if (reader === null) return [];
  return [reader.helperPath, ...(reader.sdkPath === null ? [] : [reader.sdkPath])].map(target => {
    if (!canonicalPath(target) || fs.realpathSync(target) !== target) invalid();
    const stat = fs.lstatSync(target, { bigint: true });
    if (!stat.isFile() || stat.nlink !== 1n || stat.uid !== BigInt(process.geteuid()) || (stat.mode & 0o022n)) invalid();
    fs.accessSync(target, target === reader.helperPath ? fs.constants.X_OK | fs.constants.R_OK : fs.constants.R_OK);
    return { target, stat };
  });
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
  resolvePeer, browserCookieNames = ["stepsemble", "pi_harbor", "pi_web"], sourceServiceFactory = createNativeSourceService,
  sourceIndexFactory = createSourceIndex, codexSourceServiceFactory = createCodexSourceService, codexSourceIndexFactory = createCodexSourceIndex } = {}) {
  const config = parseHistoryConfig(input);
  if ([resolvePeer, sourceServiceFactory, sourceIndexFactory, codexSourceServiceFactory, codexSourceIndexFactory].some(v => typeof v !== "function")) invalid();
  let registry, relay, closing, closed = false;
  const groups = new Map((config.sourceGroups ?? []).map(group => [group.sourceId, { config: group, active: true, index: null }]));
  const identity = createHistoryIdentity({ browserCredentials, peerGrantIds, authenticatePeerCredential,
    onRevoke(principal) {
      for (const group of groups.values()) group.index?.revokePrincipal(principal);
      try { registry?.revokePrincipal(principal); } finally { relay?.revokePrincipal(principal); }
    } });
  const metadata = new Map(config.catalog.map(e => [e.catalogId, e]));
  const groupAllowed = (principal, id) => {
    const group = groups.get(id), key = identity.credentialKey(principal);
    return !closed && group?.active === true && !!key && group.config.readers.includes(key);
  };
  const resolveSource = (principal, id) => {
    if (!/^(claude|codex)-[a-f0-9]{64}$/.test(id)) return null;
    for (const group of groups.values()) if (groupAllowed(principal, group.config.sourceId)) {
      const value = group.index?.lookup(principal, id);
      if (value) return value.unavailable ? null : { source: value.source, revision: value.revision };
    }
    return null;
  };
  const allowed = (principal, id) => {
    const entry = metadata.get(id), key = identity.credentialKey(principal);
    return !!key && (entry ? entry.readers.includes(key) : resolveSource(principal, id) !== null);
  };
  const roots = [...new Map([...config.catalog.map(e => [e.source.projectsRoot, e.expectedRoot]),
    ...(config.sourceGroups ?? []).filter(g => g.agentId === "claude-code").map(g => [g.projectsRoot, g.expectedRoot])])]
    .map(([projectsRoot, expectedRoot]) => ({ projectsRoot, expectedRoot }));
  const admission = createReaderAdmission();
  function closeIndex(group) {
    if (!group.closing) group.closing = (async () => {
      try { return await group.index.shutdown(); }
      catch { admission.quarantine(); return { cleanupConfirmed: false, quarantined: true }; }
    })();
    return group.closing;
  }
  let service, claudeService, codexService;
  try {
    if (config.reader) {
      for (const group of groups.values()) {
        const { sourceId, projectsRoot, expectedRoot } = group.config;
        const codex = group.config.agentId === "codex";
        group.index = (codex ? codexSourceIndexFactory : sourceIndexFactory)({ sourceId, source: codex ? codexGroupSource(group.config) : { projectsRoot, expectedRoot }, helperPath: config.reader.helperPath,
          authorize: groupAllowed, admission });
        if (!["refresh", "metadata", "lookup", codex ? "matchesSelection" : "matchesIdentity", "page", "revokePrincipal", "shutdown", "status"].every(k => typeof group.index?.[k] === "function")) invalid();
      }
      if (config.version < 3 || roots.length || config.reader.sdkPath !== null) claudeService = sourceServiceFactory({ ...config.reader, roots, admission });
      const codexRoots = [...groups.values()].filter(g => g.config.agentId === "codex").map(g => codexGroupSource(g.config));
      if (codexRoots.length) codexService = codexSourceServiceFactory({ helperPath: config.reader.helperPath, roots: codexRoots, admission });
      service = codexService ? createHistorySourceServices({ claude: claudeService, codex: codexService, admission }) : claudeService;
      if (!service) invalid();
      registry = createHistoryRegistry({ sourceService: service, catalog: config.catalog.map(({ catalogId, source }) => ({ catalogId, source })),
        authorize: allowed, principalActive: identity.isPrincipalCurrent, resolveSource,
        ...(codexService ? { normalizeSource, validReadPage, privateSourceBytes: 64 * 1024 } : {}) });
    }
    const local = registry ? createHistoryHttpHandler({ registry, auth: identity, allowedOrigins: config.allowedOrigins, browserCookieNames, codexEnabled: !!codexService,
      listCatalog: principal => {
        const key = identity.credentialKey(principal);
        return config.catalog.filter(e => key && e.readers.includes(key)).map(({ catalogId, label, description }) => ({ catalogId, label, description }));
      },
      listSources: principal => ({ kind: "history_sources", sources: [...groups.values()].filter(g => groupAllowed(principal, g.config.sourceId))
        .map(({ config: { sourceId, agentId, scope, label, description } }) => ({ sourceId, agentId, scope, label, description })),
        sourceAuthenticated: false, publishable: false }),
      async sourceCatalog(principal, body, { signal }) {
        if (!groupAllowed(principal, body.sourceId)) return { kind: "source_unavailable", code: "history_source_unavailable" };
        const group = groups.get(body.sourceId);
        if (body.refresh) {
          const result = await group.index.refresh(principal, { signal });
          registry.sweep(); // Changed/removed identities retire pages and in-flight publishers before reply.
          if (result.kind === "source_unavailable") return result;
        }
        if (!groupAllowed(principal, body.sourceId) || signal.aborted) return { kind: "source_unavailable", code: "history_source_unavailable" };
        const reply = group.index.page(principal, { ...body.page, snapshotId: body.snapshotId });
        if (reply.kind === "history_source_catalog" && reply.lastError !== null && !PUBLIC_CODES.has(reply.lastError)) reply.lastError = "history_transport_failed";
        return reply;
      },
      async sourceMetadata(principal, body, { signal }) {
        const denied = code => ({ kind: "source_unavailable", code });
        if (!groupAllowed(principal, body.sourceId)) return denied("history_source_unavailable");
        const group = groups.get(body.sourceId), index = group.index, codex = group.config.agentId === "codex";
        if (index.metadata(principal).snapshotId !== body.snapshotId) return denied("history_catalog_changed");
        const selected = index.lookup(principal, body.catalogId);
        if (!selected) return denied("history_source_unavailable");
        if (selected.unavailable) return denied(selected.unavailable);
        if (signal.aborted) return denied("source_aborted");
        // One ephemeral registration in the same bounded 64-slot registry. A
        // metadata request cannot renew, replace or claim a browser's view.
        const receipt = registry.register(principal, { catalogId: body.catalogId, viewId: randomUUID() });
        if (receipt.kind !== "history_registration") return receipt;
        const scope = { bindingId: receipt.bindingId, generation: receipt.generation, viewId: receipt.viewId };
        try {
          const raw = await registry.metadata(principal, { ...scope, requestId: body.requestId }, { signal });
          if (raw?.kind === "source_unavailable") return raw;
          const encoded = canonicalJSON(raw, codex ? 224 * 1024 : 32 * 1024), value = encoded === null ? null : JSON.parse(encoded);
          if (!exact(value, ["kind", "bindingId", "generation", "requestId", "sourceVersion", "metadata", "source", "sourceAuthenticated", "publishable", "cleanupConfirmed", ...(codex ? ["name"] : [])])
            || value.kind !== (codex ? "bound_codex_metadata" : "bound_session_metadata") || value.bindingId !== scope.bindingId || value.generation !== scope.generation || value.requestId !== body.requestId
            || typeof value.sourceVersion !== "string" || !/^[a-f0-9]{64}$/.test(value.sourceVersion)
            || !(codex ? validCodexMetadata(value, selected.source) : nativeWire.validNativeSnapshot(value.source) && value.source.sessionId === selected.source.sessionId
              && validMetadata(value.metadata, selected.source.sessionId)) || value.sourceAuthenticated !== false || value.publishable !== false || value.cleanupConfirmed !== true)
            return denied("history_response_invalid");
          if (signal.aborted) return denied("source_aborted");
          if (!groupAllowed(principal, body.sourceId)) return denied("history_source_unavailable");
          if (index.metadata(principal).snapshotId !== body.snapshotId || index.lookup(principal, body.catalogId)?.revision !== selected.revision
            || !(codex ? index.matchesSelection(principal, body.catalogId, selected.revision) : index.matchesIdentity(principal, body.catalogId, value.source.identity))) return denied("history_catalog_changed");
          return { kind: "history_source_metadata", ...body, metadata: value.metadata, sourceAuthenticated: false, publishable: false };
        } finally { registry.release(principal, scope); }
      },
      catalogCurrent(principal, reply) {
        if (reply.kind === "history_sources") return reply.sources.every(g => groupAllowed(principal, g.sourceId));
        if (!groupAllowed(principal, reply.sourceId)) return false;
        const state = groups.get(reply.sourceId).index.metadata(principal);
        return state.kind !== "source_unavailable" && state.snapshotId === reply.snapshotId;
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
      revokeSourceGroup(sourceId) {
        const group = groups.get(sourceId); if (!group?.active || closed) return false;
        group.active = false; registry?.sweep();
        // Logical withdrawal is synchronous; Host shutdown still awaits the
        // index's cached actual-close evidence, not this boolean result.
        void closeIndex(group);
        return true;
      },
      status: () => ({ enabled: true, registry: registry?.status() ?? null, workers: service?.status() ?? null, admission: admission.status(),
        sourceGroups: [...groups.values()].map(g => ({ sourceId: g.config.sourceId, active: g.active, ...g.index.status() })) }),
      shutdown() {
        if (!closed) {
          closed = true;
          admission.close();
          identity.shutdown(); relay.shutdown();
          closing = (async () => {
            const registryClosing = registry ? registry.shutdown() : Promise.resolve({ cleanupConfirmed: true });
            const results = await Promise.all([...groups.values()].map(closeIndex));
            const result = await registryClosing;
            const shared = admission.status();
            return { ...result, cleanupConfirmed: result.cleanupConfirmed === true && shared.cleanupConfirmed && results.every(r => r.cleanupConfirmed === true),
              quarantined: result.quarantined === true || shared.quarantined || results.some(r => r.quarantined === true) };
          })();
        }
        return closing;
      },
    });
  } catch (error) {
    admission.close();
    identity.shutdown(); relay?.shutdown();
    for (const group of groups.values()) try { void Promise.resolve(group.index?.shutdown()).catch(() => {}); } catch { /* construction failed closed */ }
    for (const created of service ? [service] : [claudeService, codexService]) try { void Promise.resolve(created?.shutdown()).catch(() => {}); } catch { /* construction failed closed */ }
    throw error;
  }
}
function validCodexMetadata(value, selected) {
  const paged = value.source?.kind === "codex_named_page_source_version";
  if (!codexWire.sameNamedVersion(value.source, value.source, paged)) return false;
  const h = value.source.history, s = value.source.sqlite, m = value.metadata;
  return h.threadId === selected.sessionId && h.rolloutPath === selected.history.source.rolloutPath
    && h.rootIdentity.device === selected.history.expectedRoot.device && h.rootIdentity.inode === selected.history.expectedRoot.inode
    && s.threadId === selected.sessionId && s.rootIdentity.device === selected.sqlite.expectedRoot.device && s.rootIdentity.inode === selected.sqlite.expectedRoot.inode
    && codexWire.validName(value.name, { source: h, nameResolution: { method: "thread_read_sqlite" } })
    && exact(m, ["sessionId", "nativeTitle", "summary", "titleStatus"]) && m.sessionId === selected.sessionId && m.nativeTitle === value.name.name && m.summary === null
    && m.titleStatus === (m.nativeTitle === null ? "untitled" : "native");
}
module.exports = { parseHistoryConfig, loadHistoryConfig, historyReaderMetadata, createHistoryHost, disabledHistoryHost, CONFIG_BYTES, SOURCE_GROUP_LIMIT };
