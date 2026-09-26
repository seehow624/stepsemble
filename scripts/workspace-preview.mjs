#!/usr/bin/env node
// Owned temporary Host: synthetic tasks only; no provider credentials or CLI.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { cleanEnvironment } from './check-rolling-clients.mjs';
import { freePort, waitForServer, stopServer } from './host-performance-baseline.mjs';
const require = createRequire(import.meta.url);
const { createWorkspaceRegistry } = require('../server/workspace-registry');
const root = fileURLToPath(new URL('../', import.meta.url));
const home = await fs.mkdtemp(path.join(os.tmpdir(), 'stepsemble-workspace-preview-'));
const config = path.join(home, '.config/stepsemble'), project = path.join(home, 'Projects', 'Demo');
await fs.mkdir(config, { recursive: true }); await fs.mkdir(project, { recursive: true });
await fs.writeFile(path.join(config, 'token'), 'workspace-preview-local-only', { mode: 0o600 });
const tasks = ['網站設計', 'API 開發', '回歸檢查'].map((name, i) => ({ id: `workspace-fixture-${i}`, agentId: ['codex', 'claude-code', 'pi'][i], name, cwd: project,
  status: 'completed', startedAt: Date.now()-5000, endedAt: Date.now()-2000, outputTail: `Synthetic session ${i}: ${name}\nThis is an isolated UI fixture. No model was called.`, settledNotified: true }));
// Use generic completed tasks for the conversation viewers; real native adapters
// have their own fixtures and are not launched by this visual test.
tasks[2].agentId = 'codex';
// A session nobody named, under the name its agent gives it.
tasks.push({ id: 'workspace-fixture-3', agentId: 'claude-code', name: 'Claude Code 1a2b3c4d', cwd: project, status: 'completed',
  startedAt: Date.now()-5000, endedAt: Date.now()-2000, outputTail: 'Synthetic unnamed session. No model was called.', settledNotified: true });
await fs.writeFile(path.join(config, 'agent-tasks.json'), JSON.stringify({ tasks }));
const registry = createWorkspaceRegistry(path.join(config, 'workspaces.json'));
for (const task of tasks.slice(0, 2)) registry.remember(task);
const piDir = path.join(home, '.pi/agent/sessions/demo'); await fs.mkdir(piDir, { recursive: true });
await fs.writeFile(path.join(piDir, 'external.jsonl'), [ { type: 'session', id: 'external-pi', cwd: project, timestamp: new Date().toISOString() },
  { type: 'session_info', name: '外部 Pi 對話' }, { type: 'message', id: 'external-message', parentId: null, message: { role: 'user', content: [{ type: 'text', text: 'External history should stay outside the workspace until added.' }] } } ].map(r => JSON.stringify(r)).join('\n')+'\n');
await fs.writeFile(path.join(piDir, 'untitled.jsonl'), [ { type: 'session', id: 'untitled-pi', cwd: project, timestamp: new Date().toISOString() },
  { type: 'message', id: 'first-message', parentId: null, message: { role: 'user', content: [{ type: 'text', text: 'Plan the dashboard layout' }] } } ].map(r => JSON.stringify(r)).join('\n')+'\n');
// A transcript larger than the response-compression threshold, so the
// compressible-payload path is exercised the same way on every platform.
await fs.writeFile(path.join(piDir, 'padding.jsonl'), [ { type: 'session', id: 'padding-pi', cwd: project, timestamp: new Date().toISOString() },
  { type: 'message', id: 'padding-message', parentId: null, message: { role: 'user', content: [{ type: 'text', text: 'compressible payload '.repeat(200) }] } } ].map(r => JSON.stringify(r)).join('\n')+'\n');
const port = await freePort();
const child = spawn(process.execPath, [path.join(root, 'server.js')], { cwd: home, stdio: ['ignore','pipe','pipe'], env: { ...cleanEnvironment(home), PATH: '/usr/bin:/bin', PI_HOME: home, PI_BIN: path.join(home, 'no-pi'), STEPSEMBLE_WORKSPACE_KEYCHAIN_USAGE: '0', STEPSEMBLE_HOST: '127.0.0.1', STEPSEMBLE_PORT: String(port), STEPSEMBLE_ORPHAN_EXIT: '0' } });
child.stderr.on('data', () => {});
try { await waitForServer(child, 60000); } catch (error) { await stopServer(child); await fs.rm(home, { recursive: true, force: true }); throw error; }
child.stdout.resume();
console.log(JSON.stringify({ url: `http://127.0.0.1:${port}`, token: 'workspace-preview-local-only', home }));
let closing = false;
async function close() { if (closing) return; closing = true; await stopServer(child); await fs.rm(home, { recursive: true, force: true }); process.exit(); }
process.on('SIGINT', close); process.on('SIGTERM', close);
