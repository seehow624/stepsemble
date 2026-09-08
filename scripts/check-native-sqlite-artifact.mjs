// Build-time provenance gate only; never opens a database or user's Codex home.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const revision = "901f9946efdaaa289e6b1c5bd56dc67f4b651e51";
const source = `git+https://github.com/rusqlite/rusqlite.git?rev=${revision}#${revision}`;
const officialSha3 = "67f423e9ebbbdc473cbc4772c872ee6b89f31fde4ed0279a5c25d5f65c043a16";
const sourceId = "2026-07-24 19:02:57 bf7c7f30031888f4e796e429ab3978879485813aaca6f641c7b33e4e09459bcc";
assert.equal(process.argv.length, 2, "no user-supplied sources or artifact overrides");
const result = spawnSync("cargo", ["+1.97.1", "metadata", "--manifest-path", "crates/history-source-reader/Cargo.toml", "--locked", "--offline", "--format-version", "1"], {
  cwd: root, encoding: "utf8", timeout: 120000, maxBuffer: 4 * 1024 * 1024, windowsHide: true,
});
assert.equal(result.error, undefined); assert.equal(result.signal, null); assert.equal(result.status, 0, "locked metadata must be available after the build");
assert.equal(result.stderr.trim(), "", "metadata diagnostics are not ignored");
const metadata = JSON.parse(result.stdout);
function packageFor(name, version, features) {
  const packages = metadata.packages.filter(p => p.name === name);
  assert.equal(packages.length, 1); const pkg = packages[0];
  assert.equal(pkg.version, version); assert.equal(pkg.source, source);
  const node = metadata.resolve.nodes.find(n => n.id === pkg.id);
  assert.deepEqual([...node.features].sort(), [...features].sort());
  return pkg;
}
packageFor("rusqlite", "0.40.1", ["bundled", "hooks", "limits", "modern_sqlite"]);
const binding = packageFor("libsqlite3-sys", "0.38.1", ["bundled", "bundled_bindings", "cc", "default", "min_sqlite_version_3_34_1", "pkg-config", "vcpkg"]);
const directory = join(dirname(binding.manifest_path), "sqlite3");
const file = join(directory, "sqlite3.c"), info = await stat(file);
assert(info.isFile() && info.size > 8 * 1024 * 1024 && info.size < 16 * 1024 * 1024);
const amalgamation = await readFile(file), header = await readFile(join(directory, "sqlite3.h"), "utf8");
assert.equal(createHash("sha3-256").update(amalgamation).digest("hex"), officialSha3);
assert(header.includes('#define SQLITE_VERSION        "3.53.4"'));
assert(header.includes('#define SQLITE_VERSION_NUMBER 3053004'));
assert(header.includes(`#define SQLITE_SOURCE_ID      "${sourceId}"`));
console.log(JSON.stringify({ kind: "sqlite_source_artifact_verified", sqliteVersion: "3.53.4", sqliteSourceId: sourceId,
  upstreamRevision: revision, amalgamationBytes: amalgamation.length, amalgamationSha3: officialSha3,
  packageCountIncludingRoot: metadata.packages.length, runtimeVerificationRequired: "Rust engine_matches_pin test",
  productionSourceReader: false, privateHistoryReads: 0 }));
