// Native status-item sampling is exercised without a browser or WebKit process.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
if (process.platform !== 'darwin') { console.log('Native menu bar: macOS only'); process.exit(0); }
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'stepsemble-menubar-native-'));
const run = (command, args) => new Promise((resolve, reject) => {
  const child = spawn(command, args, { cwd: root, stdio: 'inherit' });
  const timer = setTimeout(() => { child.kill('SIGKILL'); }, 60000);
  child.once('error', error => { clearTimeout(timer); reject(error); });
  child.once('exit', code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(command + ' failed: ' + code)); });
});
const paths = [], server = http.createServer((req, res) => {
  assert.equal(req.headers.cookie, 'stepsemble=owned-test'); paths.push(req.url);
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ live: { active: 1, tokensPerSecond: 12, estimated: true } }));
});
try {
  const binary = path.join(temp, 'check');
  await run('xcrun', ['swiftc', '-swift-version', '5', '-o', binary, 'macos/Stepsemble/MenuBarCat.swift', 'macos/Stepsemble/MenuBarActivity.swift', 'test-support/menubar/main.swift']);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  await run(binary, [String(server.address().port)]);
  assert.deepEqual(paths.sort(), ['/api/workspace/activity', '/r/mbp/api/workspace/activity']);
} finally { server.closeAllConnections(); server.close(); await fs.rm(temp, { recursive: true, force: true }); }
