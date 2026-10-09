'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), vm = require('node:vm'), fs = require('node:fs'), path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
function layer() {
  const term = { hostBase: '/r/mini' }, calls = [], notes = [];
  const context = { agentTerminal: term, apiBase: '/r/mini',
    api: async () => ({ installed: true, reachable: true, gatewayModels: [{ id: 'a/b' }], omp: { supported: true, state: 'absent' } }),
    post: async (route, body) => { calls.push({ route, body, base: context.apiBase }); },
    gatewayText: key => key, gatewayActionError: () => 'failure', ompGatewayDetail: () => 'unavailable',
    newAgentTerminalScreen: () => {}, renderAgentTerminal: () => {}, agentTerminalLine: (_term, text) => notes.push(text), finishAgentTerminal: (_term, state) => notes.push(state),
    startAgentTerminalRun: (_term, choice) => calls.push(choice),
  };
  vm.createContext(context);
  vm.runInContext(source.slice(source.indexOf('async function prepareOmpConnection('), source.indexOf('\nfunction agentTerminalChoiceLabel(')), context);
  return { context, term, calls, notes, prepare: () => context.prepareOmpConnection(term, [{ id: 'default' }]) };
}

test('OMP login offers gateway and direct sign-in; double click sends one mutation', async () => {
  const f = layer(); await f.prepare(); assert.equal(f.term.controls.length, 2);
  const click = f.term.controls[0].onClick;
  await Promise.all([click(), click()]); assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].base, '/r/mini'); assert.equal(f.calls[0].body.enabled, true);
  assert.ok(f.notes.includes('completed'));
});

test('switching Host while status loads or before a click cannot configure another Host', async () => {
  const f = layer(); let resolve;
  f.context.api = () => new Promise(r => resolve = r);
  const pending = f.prepare(); f.context.apiBase = '/r/mbp'; resolve({ installed: true }); await pending;
  assert.equal(f.term.controls, undefined); assert.equal(f.calls.length, 0);
  const g = layer(); await g.prepare(); g.context.apiBase = '/r/mbp'; await g.term.controls[0].onClick(); assert.equal(g.calls.length, 0);
});

test('gateway absence, incompatible Host, conflict and offline all retain direct login', async () => {
  for (const status of [null, { installed: true }, { installed: true, omp: { supported: false } },
    { installed: true, reachable: false, omp: { supported: true, state: 'current' } },
    { installed: true, reachable: true, gatewayModels: ['model'], omp: { supported: true, state: 'conflict' } }]) {
    const f = layer(); f.context.api = async () => status; await f.prepare();
    assert.equal(f.term.controls.length, 1); assert.equal(f.term.controls[0].label, 'omp.direct');
    f.term.controls[0].onClick(); assert.equal(f.calls[0].choice, 'default');
  }
});

test('closing the sheet during an action suppresses stale completion; failure offers retry', async () => {
  const f = layer(); let resolve;
  f.context.post = () => new Promise(r => resolve = r); await f.prepare();
  const pending = f.term.controls[0].onClick(); f.context.agentTerminal = null; resolve(); await pending;
  assert.equal(f.notes.includes('completed'), false);
  const g = layer(); g.context.post = async () => { throw new Error('synthetic failure'); };
  await g.prepare(); await g.term.controls[0].onClick();
  assert.equal(g.term.phase, 'choose'); assert.equal(g.term.controls.length, 2); assert.equal(g.notes.includes('completed'), false);
});
