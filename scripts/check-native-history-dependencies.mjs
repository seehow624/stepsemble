// Standalone RustSec lockfile gate. No dependency upgrades or production IO.
// Usage: node scripts/check-native-history-dependencies.mjs AUDIT_BIN DB_DIR TEMP_ROOT
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const VERSION = '0.22.2';
const OFFICIAL_DB = 'https://github.com/RustSec/advisory-db.git';
const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const lockfile = join(repository, 'crates/history-source-reader/Cargo.lock');
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

function run(command, args, cwd, env = process.env) {
  const result = spawnSync(command, args, {
    cwd, env, encoding: 'utf8', timeout: 300_000,
    killSignal: 'SIGKILL', maxBuffer: 2 * 1024 * 1024,
    windowsHide: true,
  });
  assert.equal(result.error, undefined, 'audit command failed or exceeded its budget');
  assert.equal(result.signal, null, 'audit command was terminated');
  assert.equal(result.status, 0, `audit command failed: ${result.stderr || result.stdout}`);
  // cargo-audit may otherwise report registry lookup failures on stderr without
  // making its JSON vulnerability count nonzero. Never mistake that for a pass.
  assert.equal(result.stderr.trim(), '', `audit emitted diagnostics: ${result.stderr}`);
  return result.stdout.trim();
}

async function main() {
  const args = process.argv.slice(2);
  assert.equal(args.length, 3, 'expected absolute AUDIT_BIN DB_DIR TEMP_ROOT');
  assert(args.every(isAbsolute), 'audit paths must be absolute');
  const [binary, database, tempRoot] = await Promise.all(args.map(path => realpath(path)));
  const work = await mkdtemp(join(tempRoot, 'stepsemble-history-audit-'));
  await mkdir(join(work, '.cargo'));
  await mkdir(join(work, 'cargo-home'));
  await writeFile(join(work, '.cargo/audit.toml'), [
    '# Generated in an owned temporary directory: no inherited ignores/filters.',
    '[advisories]', 'ignore = []', '',
    '[database]', 'fetch = true', 'stale = false', '',
    '[output]', 'deny = ["warnings"]', 'quiet = false', '',
    '[yanked]', 'enabled = true', 'update_index = true', '',
  ].join('\n'), { flag: 'wx' });
  // This is a process-local Cargo home for public index data, not a change to
  // the user's home, configuration, PATH, or installed toolchain.
  const env = { ...process.env, CARGO_HOME: join(work, 'cargo-home') };
  assert.equal(run(binary, ['audit', '--version'], work, env), `cargo-audit-audit ${VERSION}`);
  assert.equal(run('git', ['-C', database, 'remote', 'get-url', 'origin'], work), OFFICIAL_DB);
  assert.equal(run('git', ['-C', database, 'status', '--porcelain'], work), '', 'database is dirty');
  const lockBytes = await readFile(lockfile);
  const before = sha256(lockBytes);
  const packageCount = (lockBytes.toString('utf8').match(/^\[\[package\]\]$/gm) || []).length;
  assert(packageCount > 0, 'lockfile must contain packages');
  const output = run(binary, [
    'audit', '--file', lockfile, '--db', database, '--url', OFFICIAL_DB,
    '--deny', 'warnings', '--json',
  ], work, env);
  const report = JSON.parse(output);
  const databaseCommit = run('git', ['-C', database, 'rev-parse', 'HEAD'], work);
  assert.match(databaseCommit, /^[a-f0-9]{40}$/);
  assert.equal(run('git', ['-C', database, 'status', '--porcelain'], work), '', 'database changed locally');
  assert.equal(report.database?.['last-commit'], databaseCommit, 'report must identify the exact database');
  assert(Number.isSafeInteger(report.database?.['advisory-count']) && report.database['advisory-count'] > 0);
  assert.equal(report.lockfile?.['dependency-count'], packageCount, 'report must cover every locked package');
  assert.equal(sha256(await readFile(lockfile)), before, 'lockfile changed while auditing');
  assert.deepEqual(report.settings?.ignore, []);
  assert.deepEqual(report.settings?.target_arch, []);
  assert.deepEqual(report.settings?.target_os, []);
  assert.equal(report.settings?.severity, null);
  assert.deepEqual(report.settings?.informational_warnings, ['unmaintained', 'unsound', 'notice']);
  assert.equal(report.vulnerabilities?.found, false);
  assert.equal(report.vulnerabilities?.count, 0);
  assert.deepEqual(report.vulnerabilities?.list, []);
  assert.deepEqual(report.warnings, {});
  const result = {
    kind: 'native_history_dependency_audit',
    cargoAuditVersion: VERSION,
    cargoAuditSha256: sha256(await readFile(binary)),
    databaseUrl: OFFICIAL_DB,
    databaseCommit,
    databaseUpdated: report.database['last-updated'],
    advisoryCount: report.database['advisory-count'],
    lockfile: 'crates/history-source-reader/Cargo.lock',
    lockfileSha256: before,
    packageCountIncludingRoot: report.lockfile?.['dependency-count'],
    knownVulnerabilities: 0,
    warnings: 0,
    productionEnabled: false,
    sourceAuthenticated: false,
    reportDirectory: work,
  };
  await writeFile(join(work, 'cargo-audit.json'), `${output}\n`, { flag: 'wx' });
  await writeFile(join(work, 'evidence.json'), `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx' });
  console.log(JSON.stringify(result, null, 2));
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
