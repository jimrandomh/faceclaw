import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { cleanToken, phoneRequest, requestBody, TOKEN_KEY } from '../lib/protocol.js';
import { createNavigationSide } from '../lib/navigation-side.js';
import { sampleState } from './fixture.mjs';

test('side service keeps authentication on the phone and rejects overlapping commands', async () => {
  const token = 'fc1_' + 'b'.repeat(64), requests = []; let side, finish;
  const code = fs.readFileSync(new URL('../app-side/index.js', import.meta.url), 'utf8').replace(/^import .*;\n/gm, '');
  vm.runInNewContext(code, {
    createNavigationSide, cleanToken, phoneRequest, requestBody, TOKEN_KEY,
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
    createNavigationSide, cleanToken, phoneRequest, requestBody, TOKEN_KEY, AppSideService: value => side = value, BaseSideService: value => value,
    settingsLib: { getItem: () => 'not-a-token' }, fetch: () => { fetched = true; },
  });
  const result = await new Promise(resolve => side.onRequest({ method: 'FACECLAW', operation: { kind: 'state' } }, (_, result) => resolve(result)));
  assert.equal(result.ok, false); assert.match(result.error, /input token/); assert.equal(fetched, false);
});

function progressFixture(options = {}) {
  const token = 'fc1_' + 'c'.repeat(64), requests = [], events = [];
  let side;
  const code = fs.readFileSync(new URL('../app-side/index.js', import.meta.url), 'utf8').replace(/^import .*;\n/gm, '');
  vm.runInNewContext(code, {
    createNavigationSide, cleanToken, phoneRequest, requestBody, TOKEN_KEY,
    AppSideService: value => side = value, BaseSideService: value => value,
    settingsLib: { getItem: () => token },
    fetch: request => {
      requests.push(request);
      return options.fetch ? options.fetch(request) : Promise.resolve({ status: 200, body: { ok: true, state: sampleState } });
    },
  });
  side.call = payload => {
    events.push(JSON.parse(JSON.stringify(payload)));
    return options.call?.(payload);
  };
  const send = (operation, requestId, method = 'FACECLAW', extra = {}) =>
    new Promise(resolve => side.onRequest({ method, operation, requestId, ...extra }, (_, result) => resolve(result)));
  return { token, requests, events, send };
}

test('touchpad status omits the catalog but preserves the exact focused window; Apps and old clients get full lists', async () => {
  const state = { ...sampleState, apps: Array.from({ length: 29 }, (_, i) => ({ appId: 'example-' + i, title: 'Example application ' + i })) };
  const f = progressFixture({ fetch: () => Promise.resolve({ status: 200, body: { ok: true, state } }) });
  const compact = await f.send({ kind: 'state' }, undefined, 'FACECLAW', { stateScope: 'compact' });
  const full = await f.send({ kind: 'state' }, undefined, 'FACECLAW', { stateScope: 'full' });
  const legacy = await f.send({ kind: 'state' });
  assert.equal(compact.state.apps.length, 0);
  assert.deepEqual(compact.state.windows, full.state.windows.filter(window => window.focused));
  assert.deepEqual(full.state.apps, legacy.state.apps); assert.equal(full.state.apps.length, 29);
  assert.equal(full.state.windows.length, sampleState.windows.length);
  assert.ok(JSON.stringify(compact).length < JSON.stringify(full).length * 0.4);
  assert.equal(f.events.length, 0);
});

test('command receipt is correlated and sent before HTTP without awaiting progress delivery', async () => {
  const order = []; let finish;
  const f = progressFixture({
    call: () => { order.push('progress'); return new Promise(() => {}); },
    fetch: () => { order.push('fetch'); return new Promise(resolve => finish = resolve); },
  });
  const pending = f.send({ kind: 'gesture', gesture: 'swipe-up' }, 'fc-session-1');
  assert.deepEqual(order, ['progress', 'fetch']);
  assert.deepEqual(f.events, [{ method: 'FACECLAW_PROGRESS', params: { requestId: 'fc-session-1', stage: 'phone-received' } }]);
  assert.equal(JSON.stringify(f.events).includes(f.token), false);
  assert.equal(JSON.stringify(f.events).includes('swipe-up'), false);
  finish({ status: 200, body: { ok: true } });
  assert.equal((await pending).ok, true);
  assert.equal(f.requests.length, 1);
});

test('absent or malformed progress IDs preserve command compatibility without emitting progress', async () => {
  const f = progressFixture();
  const operation = { kind: 'command', command: 'close-window', windowId: 'notes:2' };
  for (const id of [undefined, null, '', 1, {}, 'fc-', 'FC-session-1', 'fc-session_1', 'fc-session-1\n', 'fc-' + 'a'.repeat(93)]) {
    assert.equal((await f.send(operation, id)).ok, true);
  }
  assert.deepEqual(f.events, []);
  assert.equal(f.requests.length, 10);
  assert.equal((await f.send(operation, 'fc-' + 'a'.repeat(92))).ok, true);
  assert.equal(f.events.length, 1, 'a valid 95-character ID is accepted');
});

test('polling, rejected busy requests, and unsupported requests do not emit progress', async () => {
  let finish;
  const f = progressFixture({ fetch: () => new Promise(resolve => finish = resolve) });
  const first = f.send({ kind: 'command', command: 'wake' }, 'fc-session-1');
  assert.match((await f.send({ kind: 'gesture', gesture: 'click' }, 'fc-session-2')).error, /busy/);
  assert.equal(f.events.length, 1); assert.equal(f.requests.length, 1);
  finish({ status: 200, body: { ok: true } }); await first;
  const poll = f.send({ kind: 'state' }, 'fc-session-3');
  assert.equal(f.events.length, 1);
  finish({ status: 200, body: { ok: true, state: sampleState } }); await poll;
  assert.equal((await f.send({ kind: 'command', command: 'unknown' }, 'fc-session-4')).ok, false);
  assert.equal((await f.send({ kind: 'command', command: 'launch-app' }, 'fc-session-5')).ok, false);
  assert.equal((await f.send({ kind: 'gesture', gesture: 'click' }, 'fc-session-6', 'UNKNOWN')).ok, false);
  assert.equal(f.events.length, 1); assert.equal(f.requests.length, 2);
});

for (const failure of ['throw', 'reject']) test('progress delivery ' + failure + ' never fails or repeats the command', async () => {
  const f = progressFixture({ call: () => {
    if (failure === 'throw') throw new Error('Progress unavailable');
    return Promise.reject(new Error('Progress unavailable'));
  } });
  assert.equal((await f.send({ kind: 'gesture', gesture: 'swipe-left' }, 'fc-session-1')).ok, true);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.events.length, 1); assert.equal(f.requests.length, 1);
});

test('side service registers capability, serializes rapid navigation, and cancels unsent work', async () => {
  let side; const token = 'fc1_' + 'd'.repeat(64), posts = [], waiting = [];
  const code = fs.readFileSync(new URL('../app-side/index.js', import.meta.url), 'utf8').replace(/^import .*;\n/gm, '');
  vm.runInNewContext(code, { createNavigationSide, cleanToken, phoneRequest, requestBody, TOKEN_KEY,
    AppSideService: value => side = value, BaseSideService: value => value,
    settingsLib: { getItem: () => token },
    fetch: request => { posts.push(JSON.parse(request.body)); return new Promise(resolve => waiting.push(resolve)); },
  });
  side.call = () => Promise.resolve();
  const send = request => new Promise(resolve => side.onRequest({ method: 'FACECLAW', ...request }, (_, result) => resolve(result)));
  const state = send({ operation: { kind: 'state' }, navSession: 'test-session' });
  waiting.shift()({ status: 200, body: { ok: true, state: sampleState, navigation: { version: 1, context: 'window:a' } } });
  assert.equal((await state).state.navigationSupported, true);
  const navigation = sequence => send({ operation: { kind: 'gesture', gesture: 'swipe-up' }, requestId: 'fc-burst-' + sequence,
    navigation: { sessionId: 'test-session', sequence, context: 'window:a' } });
  const first = navigation(1), second = navigation(2), third = navigation(3);
  assert.equal(posts.length, 2); assert.equal(posts[1].action, 'watch-navigation'); assert.equal(posts[1].token, token);
  assert.ok(Number.isSafeInteger(posts[1].expiresAt));
  assert.match((await send({ operation: { kind: 'gesture', gesture: 'click' } })).error, /busy/);
  side.onCall({ method: 'FACECLAW_NAV_CANCEL', params: { sessionId: 'test-session' } });
  assert.equal((await second).notSent, true); assert.equal((await third).notSent, true);
  waiting.shift()({ status: 200, body: { ok: true, navigation: { version: 1, context: 'window:a' } } });
  assert.equal((await first).ok, true); assert.equal(posts.length, 2);
});
