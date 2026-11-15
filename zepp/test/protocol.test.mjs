import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanToken, requestBody, normalizeState, phoneRequest, ENDPOINT } from '../lib/protocol.js';
import { sampleState } from './fixture.mjs';

const token = 'fc1_' + 'a'.repeat(64);
test('only a complete Faceclaw input token is accepted', () => {
  assert.equal(cleanToken(' "' + token + '" '), token);
  for (const invalid of ['', 'a'.repeat(32), token + 'a', token.toUpperCase(), undefined]) assert.equal(cleanToken(invalid), '');
  assert.throws(() => requestBody({ kind: 'state' }, ''), /input token/);
});

test('requests use the existing input permission and explicit watch routes', () => {
  assert.deepEqual(requestBody({ kind: 'state' }, token), { version: 1, token, action: 'watch-state' });
  assert.deepEqual(requestBody({ kind: 'gesture', gesture: 'double-click' }, token), { version: 1, token, action: 'input', gesture: 'double-click', source: 'watch' });
  assert.deepEqual(requestBody({ kind: 'command', command: 'close-window', windowId: 'notes:7', url: 'https://example.com' }, token), { version: 1, token, action: 'watch-command', command: 'close-window', windowId: 'notes:7' });
  for (const operation of [null, { kind: 'gesture', gesture: 'unknown' }, { kind: 'command', command: 'exec' }, { kind: 'command', command: 'launch-app', appId: '' }, { kind: 'command', command: 'focus-window', windowId: '\n' }]) assert.throws(() => requestBody(operation, token));
});

test('state validation requires protocol and arrays, drops malformed or duplicate identities', () => {
  assert.throws(() => normalizeState({ ...sampleState, protocol: 2 }), /not compatible/);
  assert.throws(() => normalizeState({ ...sampleState, windows: null }), /not compatible/);
  const state = normalizeState({ ...sampleState, battery: 101, apps: [...sampleState.apps, sampleState.apps[0], null, { appId: '', title: 'Bad' }], windows: [{ windowId: 'l', appId: 'launcher', title: 'Apps', closeable: false }] });
  assert.equal(state.apps.length, 3); assert.equal(state.battery, null);
  assert.equal(state.windows[0].title, 'Launcher'); assert.equal(state.windows[0].closeable, false);
});

for (const stringBody of [true, false]) test('Zepp fetch object and both response body formats: ' + stringBody, async () => {
  const calls = [], reply = { ok: true, state: sampleState };
  const result = await phoneRequest(async request => { calls.push(request); return { status: 200, body: stringBody ? JSON.stringify(reply) : reply }; }, { kind: 'state' }, token);
  assert.equal(result.state.connected, true); assert.equal(calls.length, 1);
  assert.equal(calls[0].url, ENDPOINT); assert.equal(calls[0].method, 'POST');
  assert.equal(JSON.parse(calls[0].body).token, token);
});

test('timed-out command sends one POST and a late success is not replayed', async () => {
  let timeout, resolve; const calls = [];
  const pending = phoneRequest(request => { calls.push(request); return new Promise(r => resolve = r); }, { kind: 'command', command: 'launch-app', appId: 'timer' }, token, { setTimeout: fn => { timeout = fn; return 1; }, clearTimeout() {} });
  timeout();
  await assert.rejects(pending, /Result unknown/);
  resolve({ status: 200, body: { ok: true } });
  await new Promise(r => setImmediate(r));
  assert.equal(calls.length, 1);
});

test('native transport error text cannot leak tokens into the watch', async () => {
  await assert.rejects(phoneRequest(async () => { throw new Error('Network failed Faceclaw request token=' + token); }, { kind: 'state' }, token), error => !error.message.includes(token) && /Open Faceclaw/.test(error.message));
});

test('rejected tokens and incompatible phone builds have actionable errors', async () => {
  await assert.rejects(phoneRequest(async () => ({ status: 401, body: {} }), { kind: 'state' }, token), /Provide input/);
  await assert.rejects(phoneRequest(async () => ({ status: 404, body: {} }), { kind: 'state' }, token), /Zepp-enabled/);
  await assert.rejects(phoneRequest(async () => ({ status: 200, body: 'not json' }), { kind: 'state' }, token), /Update Faceclaw/);
  await assert.rejects(phoneRequest(async () => ({ status: 409, body: { ok: false, message: 'Watch control disabled' } }), { kind: 'command', command: 'sleep' }, token), /Watch control disabled/);
  await assert.rejects(phoneRequest(async () => ({ status: 200, body: { ok: false, error: 'unauthorized', message: 'Invalid or revoked token.' } }), { kind: 'state' }, token), /Copy a new token/);
  await assert.rejects(phoneRequest(async () => ({ status: 504, body: { ok: false, error: 'timeout' } }), { kind: 'command', command: 'sleep' }, token), /Result unknown/);
});
