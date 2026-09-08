#!/usr/bin/env node
// Explicit operator action; never auto-scan ~/.claude or edit a running Host.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import host from "../server/history-host.js";
const invalid = () => { throw new Error("history_configuration_invalid"); };
export function createHistoryConfigFile(filename, options, mode = "session") {
  if (!["darwin", "linux"].includes(process.platform)) throw new Error("history_configuration_platform_unsupported");
  if (!["session", "group"].includes(mode)) invalid();
  const names = ["origin", "helper", "sdk", "projects-root", "reader", "label",
    ...(mode === "group" ? ["source-id", "scope"] : ["project-key", "session-id"])];
  if (!options || Object.keys(options).sort().join() !== names.sort().join() || names.some(n => typeof options[n] !== "string" || !options[n])) invalid();
  if (!path.isAbsolute(filename) || path.resolve(filename) !== filename || fs.realpathSync(path.dirname(filename)) !== path.dirname(filename)) invalid();
  const parent = fs.lstatSync(path.dirname(filename));
  if (!parent.isDirectory() || parent.uid !== process.geteuid() || (parent.mode & 0o077)) invalid();
  // Metadata capture is an expected root identity, not proof that native source
  // owner/ACL/mount/containment checks will pass. No transcript content is read.
  const root = options["projects-root"];
  if (fs.realpathSync(root) !== root) invalid();
  const stat = fs.lstatSync(root, { bigint: true }); if (!stat.isDirectory()) invalid();
  const expectedRoot = { device: String(stat.dev), inode: String(stat.ino) };
  const config = host.parseHistoryConfig({ version: mode === "group" ? 2 : 1, trustBoundary: "host_managed_paths", allowedOrigins: [options.origin],
    reader: { helperPath: options.helper, sdkPath: options.sdk }, catalog: mode === "group" ? [] : [{ catalogId: "source-1", label: options.label, description: "",
      source: { projectsRoot: root, projectKey: options["project-key"], sessionId: options["session-id"] },
      expectedRoot, readers: [options.reader] }], ...(mode === "group" ? { sourceGroups: [{ sourceId: options["source-id"], agentId: "claude-code",
        scope: options.scope, label: options.label, description: "", projectsRoot: root, expectedRoot, readers: [options.reader] }] } : {}) });
  let fd, createdIdentity, failure;
  try {
    fd = fs.openSync(filename, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    createdIdentity = fs.fstatSync(fd, { bigint: true });
    fs.writeFileSync(fd, JSON.stringify(config, null, 2) + "\n"); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
    host.loadHistoryConfig(filename); // Same startup validator; no worker or source read.
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
  return { valid: true, catalogEntries: config.catalog.length, sourceGroups: config.sourceGroups?.length ?? 0, origins: 1, sourceReads: 0, hostRestarted: false };
}
export function run(args) {
  const [command, filename, ...rest] = args;
  if (command === "check" && filename && !rest.length) {
    const c = host.loadHistoryConfig(filename);
    return { valid: true, catalogEntries: c.catalog.length, sourceGroups: c.sourceGroups?.length ?? 0, origins: c.allowedOrigins.length, sourceReads: 0, hostRestarted: false };
  }
  if (!["create", "create-group"].includes(command) || !filename || rest.length % 2) invalid();
  const options = Object.create(null);
  for (let i = 0; i < rest.length; i += 2) {
    if (!rest[i].startsWith("--") || Object.hasOwn(options, rest[i].slice(2))) invalid();
    options[rest[i].slice(2)] = rest[i + 1];
  }
  return createHistoryConfigFile(filename, options, command === "create-group" ? "group" : "session");
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { console.log(JSON.stringify(run(process.argv.slice(2)))); }
  catch { console.error("History configuration was not accepted. Existing configurations, native accounts and running Hosts were not changed. See docs/history-host-integration.md."); process.exitCode = 1; }
}
