// Isolated fixture for HTTP and visual tests. No real CLI or credentials.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { cleanEnvironment } from '../scripts/check-rolling-clients.mjs';
import { freePort, waitForServer, stopServer } from '../scripts/host-performance-baseline.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));
export async function startOmpGatewayFixture() {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'stepsemble-omp-gateway-http-'));
  const bin = path.join(home, 'bin'), config = path.join(home, '.opencodex');
  await fs.mkdir(bin); await fs.mkdir(config);
  const gateway = http.createServer((req, res) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ data: [{ id: 'synthetic/model', name: 'Synthetic model' }] })); });
  await new Promise(resolve => gateway.listen(0, '127.0.0.1', resolve));
  await fs.writeFile(path.join(config, 'config.json'), JSON.stringify({ port: gateway.address().port }));
  const cli = path.join(home, 'gateway.cjs');
  await fs.writeFile(cli, `const fs = require('node:fs'), path = require('node:path');
const home = process.env.HOME, file = path.join(home, '.omp/agent/models.yml');
const action = process.argv[4];
if (action !== 'status') {
  fs.appendFileSync(path.join(home, 'mutations'), action + '\\n');
  if (action === 'enable') { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, 'providers: {}\\n'); }
  else if (action === 'disable') fs.rmSync(file, { force: true });
  else process.exit(2);
}
console.log(JSON.stringify({ clientId: 'omp', ok: true, state: fs.existsSync(file) ? 'current' : 'absent', configPath: file }));`);
  const shellQuote = s => "'" + s.replaceAll("'", "'\\''") + "'";
  for (const name of ['ocx', 'omp']) {
    const target = name === 'ocx' ? cli : path.join(root, 'test-support/fake-agent-auth.cjs');
    if (process.platform === 'win32') await fs.writeFile(path.join(bin, name + '.cmd'), `@echo off\r\n"${process.execPath}" "${target}" %*\r\n`);
    else await fs.writeFile(path.join(bin, name), `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(target)} "$@"\n`, { mode: 0o700 });
  }
  const port = await freePort(), token = 'omp-gateway-fixture-only';
  const child = spawn(process.execPath, [path.join(root, 'server.js')], { cwd: home, stdio: ['ignore', 'pipe', 'pipe'], env: {
    ...cleanEnvironment(home), PATH: [bin, path.dirname(process.execPath), '/usr/bin', '/bin'].join(path.delimiter),
    PI_HOME: home, PI_BIN: path.join(home, 'no-pi'), STEPSEMBLE_HOST: '127.0.0.1', STEPSEMBLE_PORT: String(port),
    STEPSEMBLE_TOKEN: token, STEPSEMBLE_ORPHAN_EXIT: '0', STEPSEMBLE_OMP_ACP: '1', STEPSEMBLE_WORKSPACE_KEYCHAIN_USAGE: '0' } });
  child.stderr.on('data', () => {});
  async function close() { await stopServer(child); await new Promise(resolve => gateway.close(resolve)); await fs.rm(home, { recursive: true, force: true, maxRetries: 5 }); }
  try { await waitForServer(child, 60000); } catch (error) { await close(); throw error; }
  child.stdout.resume();
  return { home, url: `http://127.0.0.1:${port}`, token, close };
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const fixture = await startOmpGatewayFixture();
  console.log(JSON.stringify({ url: fixture.url + '/index.html?pane=1&signin=omp', token: fixture.token }));
  let closing = false;
  const stop = async () => { if (closing) return; closing = true; await fixture.close(); process.exit(); };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
}
