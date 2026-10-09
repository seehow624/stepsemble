'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs/promises'), path = require('node:path');
test('OMP gateway HTTP requires authentication, validates input and verifies enable/disable on the selected Host', async t => {
  const { startOmpGatewayFixture } = await import('../test-support/omp-gateway-host.mjs');
  const f = await startOmpGatewayFixture(); t.after(f.close);
  const login = await fetch(f.url + '/api/login', { method: 'POST', headers: { Origin: f.url, 'Content-Type': 'application/json' }, body: JSON.stringify({ token: f.token }) });
  assert.equal(login.status, 204);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const request = (url, body, token = f.token, origin = f.url) => fetch(f.url + url, { method: body ? 'POST' : 'GET',
    headers: { ...(token ? { Cookie: cookie } : {}), ...(origin ? { Origin: origin } : {}), 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}) });
  const action = { action: 'omp_integration', enabled: true };
  assert.equal((await request('/api/gateway/action', action, '')).status, 401);
  assert.equal((await request('/api/gateway/action', action, f.token, 'https://evil.invalid')).status, 403);
  assert.equal((await request('/api/gateway/action', action, f.token, '')).status, 403);
  assert.equal((await request('/api/gateway/action', { ...action, command: 'arbitrary' })).status, 400);
  assert.equal((await request('/api/gateway/action', { ...action, enabled: 'true' })).status, 400);
  const before = await (await request('/api/gateway/status?agentId=omp')).json();
  assert.equal(before.omp.state, 'absent'); assert.equal(before.reachable, true);
  const enabled = await request('/api/gateway/action', action);
  assert.equal(enabled.status, 200, await enabled.clone().text()); assert.equal((await enabled.json()).state, 'current');
  const disabled = await request('/api/gateway/action', { ...action, enabled: false });
  assert.equal(disabled.status, 200); assert.equal((await disabled.json()).state, 'absent');
  assert.equal(await fs.readFile(path.join(f.home, 'mutations'), 'utf8'), 'enable\ndisable\n');
});
