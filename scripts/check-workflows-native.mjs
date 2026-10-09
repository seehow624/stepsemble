// Real Claude Code and Codex on an isolated test Host, against localhost
// model fixtures. No provider credentials or real model calls are used.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
if (!process.env.WORKFLOW_CLAUDE_BIN || !process.env.WORKFLOW_CODEX_BIN) throw new Error('Set WORKFLOW_CLAUDE_BIN and WORKFLOW_CODEX_BIN to installed official CLIs');
await fs.access(process.env.WORKFLOW_CLAUDE_BIN); await fs.access(process.env.WORKFLOW_CODEX_BIN);
const { cleanEnvironment } = await import(root + 'scripts/check-rolling-clients.mjs');
const { freePort, waitForServer, stopServer } = await import(root + 'scripts/host-performance-baseline.mjs');
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---- fake Anthropic Messages API ----
const anthropic = http.createServer((req, res) => {
  let raw = ''; req.on('data', c => raw += c); req.on('end', async () => {
    let body = null; try { body = JSON.parse(raw); } catch {}
    if (/count_tokens/.test(req.url)) { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"input_tokens":12}'); return; }
    if (!body || !/\/messages/.test(req.url)) { res.writeHead(404); res.end(); return; }
    const marker = JSON.stringify(body.messages || []).match(/\[\[STEPSEMBLE_GOAL:[a-f0-9-]+:complete\]\]/)?.[0] || '';
    const answer = 'Verified with real Claude CLI.\n' + marker;
    const id = 'msg_' + crypto.randomUUID().replaceAll('-', '');
    const usage = { input_tokens: 12, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 1 };
    if (!body.stream) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ id, type: 'message', role: 'assistant', model: body.model, content: [{ type: 'text', text: answer }], stop_reason: 'end_turn', usage })); return; }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const send = (n, d) => res.write('event: ' + n + '\ndata: ' + JSON.stringify(d) + '\n\n');
    send('message_start', { type: 'message_start', message: { id, type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: null, usage } });
    send('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
    send('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: answer } });
    send('content_block_stop', { type: 'content_block_stop', index: 0 });
    send('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } });
    send('message_stop', { type: 'message_stop' }); res.end();
  });
});
// ---- fake OpenAI Responses API (Codex) ----
const responses = http.createServer((req, res) => {
  let raw = ''; req.on('data', c => raw += c); req.on('end', async () => {
    let body = null; try { body = JSON.parse(raw); } catch {}
    if (req.method !== 'POST' || !/\/responses$/.test(req.url) || !body) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const send = d => res.write('event: ' + d.type + '\ndata: ' + JSON.stringify(d) + '\n\n');
    const rid = 'resp_' + Date.now(), mid = 'msg_' + Date.now();
    send({ type: 'response.created', response: { id: rid, status: 'in_progress', output: [] } });
    await sleep(1500); // the model thinks before it writes (reasoning not shown)
    send({ type: 'response.output_item.added', output_index: 0, item: { type: 'message', id: mid, role: 'assistant', status: 'in_progress', content: [] } });
    send({ type: 'response.content_part.added', item_id: mid, output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } });
    const marker = JSON.stringify(body.input || []).match(/\[\[STEPSEMBLE_GOAL:[a-f0-9-]+:complete\]\]/)?.[0] || '';
    const full = 'Verified with real Codex CLI.\n' + marker;
    send({ type: 'response.output_text.delta', item_id: mid, output_index: 0, content_index: 0, delta: full });
    const item = { type: 'message', id: mid, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: full, annotations: [] }] };
    send({ type: 'response.output_text.done', item_id: mid, output_index: 0, content_index: 0, text: full });
    send({ type: 'response.content_part.done', item_id: mid, output_index: 0, content_index: 0, part: item.content[0] });
    send({ type: 'response.output_item.done', output_index: 0, item });
    send({ type: 'response.completed', response: { id: rid, status: 'completed', output: [item], usage: { input_tokens: 500, input_tokens_details: { cached_tokens: 0 }, output_tokens: 900, output_tokens_details: { reasoning_tokens: 600 }, total_tokens: 1400 } } });
    res.end();
  });
});
await new Promise(r => anthropic.listen(0, '127.0.0.1', r));
await new Promise(r => responses.listen(0, '127.0.0.1', r));
const home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'stepsemble-native-workflows-')));
const config = path.join(home, '.config/stepsemble'), project = path.join(home, 'Projects', 'Demo'), bin = path.join(home, 'bin');
await fs.mkdir(config, { recursive: true }); await fs.mkdir(project, { recursive: true }); await fs.mkdir(bin);
await fs.writeFile(path.join(config, 'token'), 'native-workflows-local-only', { mode: 0o600 });
await fs.symlink(process.env.WORKFLOW_CLAUDE_BIN, path.join(bin, 'claude'));
const codexBin = process.env.WORKFLOW_CODEX_BIN;
await fs.symlink(codexBin, path.join(bin, 'codex'));
await fs.mkdir(path.join(home, '.codex'), { recursive: true, mode: 0o700 });
await fs.writeFile(path.join(home, '.codex', 'config.toml'), [
  'model = "mock-model"', 'model_provider = "fixture"', 'approval_policy = "never"', 'sandbox_mode = "read-only"', 'cli_auth_credentials_store = "file"', 'project_doc_max_bytes = 0',
  '[model_providers.fixture]', 'name = "Fixture"', 'base_url = "http://127.0.0.1:' + responses.address().port + '/v1"', 'wire_api = "responses"', 'requires_openai_auth = false', 'request_max_retries = 0', 'stream_max_retries = 0',
  '[features]', 'apps = false', 'plugins = false', 'hooks = false', 'shell_snapshot = false', 'memories = false', 'shell_tool = false', ''].join('\n'), { mode: 0o600 });
const port = await freePort();
const child = spawn(process.execPath, [path.join(root, 'server.js')], { cwd: home, stdio: ['ignore', 'pipe', 'pipe'], env: { ...cleanEnvironment(home),
  PATH: bin + ':' + path.dirname(process.execPath) + ':/usr/bin:/bin:/usr/sbin:/sbin', PI_HOME: home, PI_BIN: path.join(home, 'no-pi'),
  STEPSEMBLE_CLAUDE_STRUCTURED: '1', STEPSEMBLE_CODEX_NATIVE: '1', STEPSEMBLE_CODEX_NATIVE_MUTATIONS: '1', STEPSEMBLE_CODEX_BIN: codexBin,
  ANTHROPIC_BASE_URL: 'http://127.0.0.1:' + anthropic.address().port, ANTHROPIC_API_KEY: 'sk-ant-fixture-only', CLAUDE_CODE_MAX_RETRIES: '0',
  DISABLE_AUTOUPDATER: '1', DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  STEPSEMBLE_WORKSPACE_KEYCHAIN_USAGE: '0', STEPSEMBLE_HOST: '127.0.0.1', STEPSEMBLE_PORT: String(port), STEPSEMBLE_ORPHAN_EXIT: '0' } });
let errlog = ''; child.stderr.on('data', d => { errlog += d; });
try {
  await waitForServer(child, 60000); child.stdout.resume();
  const base = 'http://127.0.0.1:' + port;
  let cookie = '';
  const request = (route, body) => fetch(base + route, { headers: { Cookie: cookie, Origin: base, ...(body ? {'Content-Type':'application/json'} : {}) }, ...(body ? {method:'POST',body:JSON.stringify(body)} : {}) });
  const login = await request('/api/login', {token:'native-workflows-local-only'}); cookie = login.headers.get('set-cookie').split(';')[0];
  for (const agentId of ['claude-code', 'codex']) {
    const createdResponse = await request('/api/workflows', { title: 'Native Goal verification', objective: 'Verify this isolated task and report completion.', agentId, cwd:project, limits:{minutes:1,turns:2} });
    const created = await createdResponse.json(); assert(createdResponse.ok,JSON.stringify(created));
    let done;
    for (let i=0;i<160;i++) { await sleep(250); const state=await (await request('/api/workflows')).json(); const r=state.runs.find(r=>r.id===created.id); if (['completed','failed','limited','blocked'].includes(r.status)) {done=r;break;} }
    assert.equal(done?.status,'completed',agentId+' '+JSON.stringify(done)+' '+errlog);
    assert.equal(done.turns,1); assert(done.result.includes('Verified with real'));
    console.log(JSON.stringify({agentId,status:done.status,turns:done.turns,outputTokens:done.outputTokens,entry:!!done.entry}));
  }
} finally {
  await stopServer(child); anthropic.closeAllConnections(); responses.closeAllConnections(); anthropic.close(); responses.close();
  await fs.rm(home,{recursive:true,force:true});
}
