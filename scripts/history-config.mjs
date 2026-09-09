#!/usr/bin/env node
// Explicit operator action; never auto-scan ~/.claude or edit a running Host.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import host from "../server/history-host.js";
const invalid = () => { throw new Error("history_configuration_invalid"); };
const reviews = new WeakMap();
const identity = (a, b, fields) => fields.every(key => a[key] === b[key]);
const directoryFields = ["dev", "ino", "uid", "mode"];
const artifactFields = [...directoryFields, "size", "nlink", "mtimeNs", "ctimeNs"];
const freeze = value => { if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
const sourceId = value => typeof value === "string" && /^[A-Za-z0-9:_-]{1,128}$/.test(value);
function readReviewedConfig(filename) {
  // loadHistoryConfig bounds the fd read and validates owner/mode/no-follow.
  // Bind the returned value to this named identity, including later changes
  // which preserve JSON semantics. Never silently rebase after owner review.
  if (!["darwin", "linux"].includes(process.platform)) throw new Error("history_configuration_platform_unsupported");
  if (typeof filename !== "string" || !path.isAbsolute(filename) || path.resolve(filename) !== filename
    || fs.realpathSync(path.dirname(filename)) !== path.dirname(filename)) invalid();
  const parent = fs.lstatSync(path.dirname(filename), { bigint: true });
  if (!parent.isDirectory() || parent.uid !== BigInt(process.geteuid()) || (parent.mode & 0o077n)) invalid();
  const before = fs.lstatSync(filename, { bigint: true });
  const config = host.loadHistoryConfig(filename);
  if (!identity(before, fs.lstatSync(filename, { bigint: true }), artifactFields)
    || !identity(parent, fs.lstatSync(path.dirname(filename), { bigint: true }), directoryFields)) invalid();
  return { filename, config, stat: before, parent };
}
export function inspectHistoryConfigFile(filename) {
  return freeze({ filename, config: readReviewedConfig(filename).config });
}
function prepareConfig(filename, value, inputs = [], change = null) {
  if (!["darwin", "linux"].includes(process.platform)) throw new Error("history_configuration_platform_unsupported");
  if (typeof filename !== "string" || filename.length > 4096 || /[\u0000-\u001f\u007f*?\[\]{},]/.test(filename)
    || !path.isAbsolute(filename) || path.resolve(filename) !== filename || fs.realpathSync(path.dirname(filename)) !== path.dirname(filename)) invalid();
  const parent = fs.lstatSync(path.dirname(filename), { bigint: true });
  if (!parent.isDirectory() || parent.uid !== BigInt(process.geteuid()) || (parent.mode & 0o077n)) invalid();
  try { fs.lstatSync(filename); throw new Error("history_configuration_not_created"); } catch (error) { if (error.code !== "ENOENT") throw error; }
  const config = host.parseHistoryConfig(value), selectedRoots = new Map();
  const remember = (root, expectedRoot) => selectedRoots.set(root, expectedRoot);
  for (const entry of config.catalog) remember(entry.source.projectsRoot, entry.expectedRoot);
  for (const group of config.sourceGroups ?? []) {
    if (group.agentId === "codex") { remember(group.codexRoot, group.expectedCodexRoot); remember(group.sqliteRoot, group.expectedSqliteRoot); }
    else remember(group.projectsRoot, group.expectedRoot);
  }
  const roots = [...selectedRoots].map(([root, expected]) => {
    if (fs.realpathSync(root) !== root) invalid();
    const stat = fs.lstatSync(root, { bigint: true });
    if (!stat.isDirectory() || String(stat.dev) !== expected.device || String(stat.ino) !== expected.inode) invalid();
    return { root, stat };
  });
  const artifacts = host.historyReaderMetadata(config.reader);
  const prepared = freeze({ filename, config: JSON.parse(JSON.stringify(config)), ...(change ? { change: JSON.parse(JSON.stringify(change)) } : {}) });
  reviews.set(prepared, { filename, config, parent, roots, artifacts, inputs });
  return prepared;
}
// Local owner management produces a NEW, inactive candidate. No config route,
// running-Host mutation, reader union, implicit root capture or history scan.
export function prepareHistoryConfigRevision(baseFilename, filename, operation) {
  if (!["darwin", "linux"].includes(process.platform)) throw new Error("history_configuration_platform_unsupported");
  if (!operation || typeof operation !== "object" || Array.isArray(operation)) invalid();
  const importing = ["add", "replace"].includes(operation.action);
  const keys = operation.action === "edit" ? ["action", "sourceId", "label", "description", "readers"]
    : ["action", "sourceId", ...(importing ? ["from", ...(Object.hasOwn(operation, "adoptSdk") ? ["adoptSdk"] : [])] : [])];
  if (!["add", "replace", "edit", "remove"].includes(operation.action)
    || Object.keys(operation).sort().join() !== keys.sort().join() || !sourceId(operation.sourceId)
    || Object.hasOwn(operation, "adoptSdk") && typeof operation.adoptSdk !== "boolean") invalid();
  const base = readReviewedConfig(baseFilename), inputs = [base], config = JSON.parse(JSON.stringify(base.config));
  if (config.reader === null) throw new Error("history_configuration_reader_required");
  const groups = config.sourceGroups ?? [], index = groups.findIndex(group => group.sourceId === operation.sourceId);
  if (operation.action === "add" ? index !== -1 : index === -1) throw new Error("history_configuration_group_conflict");
  const before = index < 0 ? null : JSON.parse(JSON.stringify(groups[index]));
  if (["add", "replace"].includes(operation.action)) {
    const imported = readReviewedConfig(operation.from); inputs.push(imported);
    if (identity(base.stat, imported.stat, ["dev", "ino"])) invalid();
    const group = imported.config.sourceGroups?.find(row => row.sourceId === operation.sourceId);
    if (!group || JSON.stringify(config.allowedOrigins) !== JSON.stringify(imported.config.allowedOrigins)) invalid();
    const reader = imported.config.reader;
    if (config.reader.helperPath !== reader.helperPath
      || config.reader.sdkPath !== null && reader.sdkPath !== null && config.reader.sdkPath !== reader.sdkPath) invalid();
    const needsSdk = config.reader.sdkPath === null && reader.sdkPath !== null && group.agentId === "claude-code";
    if (needsSdk && operation.adoptSdk !== true) throw new Error("history_configuration_sdk_adoption_required");
    if (!needsSdk && operation.adoptSdk === true) invalid();
    if (needsSdk) config.reader.sdkPath = reader.sdkPath;
    if (operation.action === "add") groups.push(group); else groups[index] = group;
  } else if (operation.action === "edit") {
    groups[index] = { ...groups[index], label: operation.label, description: operation.description, readers: operation.readers };
  } else groups.splice(index, 1);
  config.version = Math.max(config.version, groups.some(group => group.agentId === "codex") ? 3 : 2);
  config.sourceGroups = groups;
  return prepareConfig(filename, config, inputs, { action: operation.action, sourceId: operation.sourceId,
    baseFilename, importedFilename: operation.from ?? null, before, after: groups.find(row => row.sourceId === operation.sourceId) ?? null,
    previousReader: base.config.reader, sdkAdopted: operation.adoptSdk === true, unchangedCatalogEntries: base.config.catalog.length });
}
export function prepareHistoryConfigFile(filename, options, mode = "session") {
  if (!["darwin", "linux"].includes(process.platform)) throw new Error("history_configuration_platform_unsupported");
  if (!["session", "group", "codex-group"].includes(mode)) invalid();
  const codex = mode === "codex-group", grouped = mode !== "session";
  const names = ["origin", "helper", "reader", "label", ...(codex ? ["codex-root", "sqlite-root"] : ["sdk", "projects-root"]),
    ...(grouped ? ["source-id", "scope"] : ["project-key", "session-id"])];
  if (!options || Object.keys(options).sort().join() !== names.sort().join() || names.some(n => typeof options[n] !== "string" || !options[n])) invalid();
  if (typeof filename !== "string" || filename.length > 4096 || /[\u0000-\u001f\u007f*?\[\]{},]/.test(filename)
    || !path.isAbsolute(filename) || path.resolve(filename) !== filename || fs.realpathSync(path.dirname(filename)) !== path.dirname(filename)) invalid();
  const parent = fs.lstatSync(path.dirname(filename), { bigint: true });
  if (!parent.isDirectory() || parent.uid !== BigInt(process.geteuid()) || (parent.mode & 0o077n)) invalid();
  try { fs.lstatSync(filename); throw new Error("history_configuration_not_created"); } catch (error) { if (error.code !== "ENOENT") throw error; }
  // Metadata capture is an expected root identity, not proof that native source
  // owner/ACL/mount/containment checks will pass. No transcript content is read.
  const roots = (codex ? ["codex-root", "sqlite-root"] : ["projects-root"]).map(key => {
    const root = options[key]; if (fs.realpathSync(root) !== root) invalid();
    const stat = fs.lstatSync(root, { bigint: true }); if (!stat.isDirectory()) invalid();
    return { root, stat, expectedRoot: { device: String(stat.dev), inode: String(stat.ino) } };
  });
  const readers = options.reader.split(",").map(value => value.trim()), { root, expectedRoot } = roots[0];
  const config = host.parseHistoryConfig({ version: codex ? 3 : grouped ? 2 : 1, trustBoundary: "host_managed_paths", allowedOrigins: [options.origin],
    reader: { helperPath: options.helper, sdkPath: codex ? null : options.sdk }, catalog: grouped ? [] : [{ catalogId: "source-1", label: options.label, description: "",
      source: { projectsRoot: root, projectKey: options["project-key"], sessionId: options["session-id"] }, expectedRoot, readers }],
    ...(grouped ? { sourceGroups: [{ sourceId: options["source-id"], scope: options.scope, label: options.label, description: "", readers,
      ...(codex ? { agentId: "codex", nativeVersion: "0.153.4", codexRoot: root, expectedCodexRoot: expectedRoot, sqliteRoot: roots[1].root, expectedSqliteRoot: roots[1].expectedRoot }
        : { agentId: "claude-code", projectsRoot: root, expectedRoot }) }] } : {}) });
  return prepareConfig(filename, config);
}
export function discardHistoryConfigReview(prepared) { return reviews.delete(prepared); }
export function commitHistoryConfigFile(prepared) {
  const review = reviews.get(prepared); if (!review) throw new Error("history_configuration_review_unavailable");
  reviews.delete(prepared); // Single use even when validation or publication fails.
  const { filename, config, parent, roots, artifacts, inputs } = review;
  const verifyReview = () => {
    try {
      if (fs.realpathSync(path.dirname(filename)) !== path.dirname(filename)
        || !identity(parent, fs.lstatSync(path.dirname(filename), { bigint: true }), directoryFields)
        || roots.some(({ root, stat }) => fs.realpathSync(root) !== root || !identity(stat, fs.lstatSync(root, { bigint: true }), directoryFields))) throw new Error();
      const current = host.historyReaderMetadata(config.reader);
      if (current.some((item, index) => !identity(item.stat, artifacts[index].stat, artifactFields))) throw new Error();
      for (const input of inputs) {
        if (!identity(input.parent, fs.lstatSync(path.dirname(input.filename), { bigint: true }), directoryFields)) throw new Error();
        const loaded = readReviewedConfig(input.filename);
        if (!identity(input.stat, loaded.stat, artifactFields) || JSON.stringify(input.config) !== JSON.stringify(loaded.config)) throw new Error();
      }
    } catch { throw new Error("history_configuration_review_changed"); }
  };
  verifyReview();
  let fd, createdIdentity, failure;
  try {
    fd = fs.openSync(filename, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    createdIdentity = fs.fstatSync(fd, { bigint: true });
    fs.writeFileSync(fd, JSON.stringify(config, null, 2) + "\n"); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
    const loaded = host.loadHistoryConfig(filename); // Startup validator, no worker or source read.
    if (JSON.stringify(loaded) !== JSON.stringify(config)) throw new Error();
    verifyReview();
  } catch { failure = new Error("history_configuration_not_created"); }
  finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch { failure = new Error("history_configuration_not_created"); }
    // Only our exclusive new output; never an existing file or another target.
    if (failure && createdIdentity) try {
      const current = fs.lstatSync(filename, { bigint: true });
      if (current.dev !== createdIdentity.dev || current.ino !== createdIdentity.ino) throw new Error();
      fs.unlinkSync(filename);
    } catch { failure = new Error("history_configuration_incomplete_check_output"); }
  }
  if (failure) throw failure;
  return { valid: true, catalogEntries: config.catalog.length, sourceGroups: config.sourceGroups?.length ?? 0,
    origins: config.allowedOrigins.length, sourceReads: 0, hostRestarted: false };
}
export function createHistoryConfigFile(filename, options, mode = "session") {
  return commitHistoryConfigFile(prepareHistoryConfigFile(filename, options, mode));
}
export function run(args) {
  const [command, filename, ...rest] = args;
  if (command === "check" && filename && !rest.length) {
    const c = host.loadHistoryConfig(filename);
    return { valid: true, catalogEntries: c.catalog.length, sourceGroups: c.sourceGroups?.length ?? 0, origins: c.allowedOrigins.length, sourceReads: 0, hostRestarted: false };
  }
  if (!["create", "create-group", "create-codex-group"].includes(command) || !filename || rest.length % 2) invalid();
  const options = Object.create(null);
  for (let i = 0; i < rest.length; i += 2) {
    if (!rest[i].startsWith("--") || Object.hasOwn(options, rest[i].slice(2))) invalid();
    options[rest[i].slice(2)] = rest[i + 1];
  }
  return createHistoryConfigFile(filename, options, command === "create-codex-group" ? "codex-group" : command === "create-group" ? "group" : "session");
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { console.log(JSON.stringify(run(process.argv.slice(2)))); }
  catch { console.error("History configuration was not accepted. Existing configurations, native accounts and running Hosts were not changed. See docs/history-host-integration.md."); process.exitCode = 1; }
}
