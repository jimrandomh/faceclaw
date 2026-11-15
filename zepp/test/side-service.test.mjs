import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { cleanToken, phoneRequest, TOKEN_KEY } from '../lib/protocol.js';
import { sampleState } from './fixture.mjs';

test('side service keeps authentication on the phone and rejects overlapping commands', async () => {
  const token = 'fc1_' + 'b'.repeat(64), requests = []; let side, finish;
  const code = fs.readFileSync(new URL('../app-side/index.js', import.meta.url), 'utf8').replace(/^import .*;\n/gm, '');
  vm.runInNewContext(code, {
    cleanToken, phoneRequest, TOKEN_KEY,
    AppSideService: value => side = value, BaseSideService: value => value,
    settingsLib: { getItem: key => { assert.equal(key, TOKEN_KEY); return '"' + token + '"'; } },
    fetch: request => { requests.push(request); return new Promise(resolve => finish = resolve); },
  });
  const send = operation => new Promise(resolve => side.onRequest({ method: 'FACECLAW', operation }, (_, result) => resolve(result)));
  const first = send({ kind: 'command', command: 'close-window', windowId: 'notes:2' });
  const second = await send({ kind: 'command', command: 'launch-app', appId: 'timer' });
  assert.equal(second.ok, false); assert.match(second.error, /busy/); assert.equal(requests.length, 1);
  finish({ status: 200, body: { ok: true, message: 'Closed Notes' } });
  const result = await first;
  assert.equal(result.ok, true); assert.equal(result.message, 'Closed Notes'); assert.equal(JSON.stringify(result).includes(token), false);
  assert.equal(JSON.parse(requests[0].body).token, token);
  const state = send({ kind: 'state' }); finish({ status: 200, body: { ok: true, state: sampleState } });
  assert.equal((await state).state.connected, true);
});

test('invalid token stops at the phone settings boundary', async () => {
  let side, fetched = false;
  const code = fs.readFileSync(new URL('../app-side/index.js', import.meta.url), 'utf8').replace(/^import .*;\n/gm, '');
  vm.runInNewContext(code, {
    cleanToken, phoneRequest, TOKEN_KEY, AppSideService: value => side = value, BaseSideService: value => value,
    settingsLib: { getItem: () => 'not-a-token' }, fetch: () => { fetched = true; },
  });
  const result = await new Promise(resolve => side.onRequest({ method: 'FACECLAW', operation: { kind: 'state' } }, (_, result) => resolve(result)));
  assert.equal(result.ok, false); assert.match(result.error, /input token/); assert.equal(fetched, false);
});
