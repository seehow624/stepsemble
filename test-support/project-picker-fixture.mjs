import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { freePort, waitForServer, stopServer } from '../scripts/host-performance-baseline.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export async function startProjectPickerFixture() {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'stepsemble-picker-'));
  const home = path.join(temp, 'home');
  let child;
  const close = async () => { await stopServer(child); await fs.rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); };
  try {
    await fs.mkdir(home);
    for (let i = 0; i < 200; i++) await fs.mkdir(path.join(home, `Folder ${String(i).padStart(3, '0')}`));
    for (let i = 0; i < 80; i++) await fs.mkdir(path.join(home, 'Folder 000', `Child ${String(i).padStart(3, '0')}`));
    const port = await freePort();
    child = spawn(process.execPath, [path.join(root, 'server.js')], {
      cwd: root, stdio: ['ignore', 'pipe', 'pipe'],
      // No inherited credentials, user tooling, native history or model process.
      env: { HOME: home, PI_HOME: home, PI_BIN: path.join(temp, 'unavailable-pi'), PATH: '/usr/bin:/bin',
        STEPSEMBLE_HOST: '127.0.0.1', STEPSEMBLE_PORT: String(port), STEPSEMBLE_ORPHAN_EXIT: '0',
        STEPSEMBLE_BROWSE_ROOTS: home, ...(process.env.TMPDIR ? { TMPDIR: process.env.TMPDIR } : {}) },
    });
    await waitForServer(child); child.stdout.resume(); child.stderr.resume();
    return { base: `http://127.0.0.1:${port}`, home, tokenFile: path.join(home, '.config/stepsemble/token'), close };
  } catch (error) { await close(); throw error; }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const fixture = await startProjectPickerFixture();
  console.log(JSON.stringify({ url: fixture.base, tokenFile: fixture.tokenFile, folders: 200, children: 80 }));
  let closing = false;
  const finish = async () => { if (closing) return; closing = true; await fixture.close(); process.exit(); };
  process.once('SIGINT', finish); process.once('SIGTERM', finish);
}
