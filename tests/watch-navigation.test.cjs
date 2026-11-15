const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { TokenStore, handleRequest } = require('../.test-build/app/remote/protocol.js');
function fixture() {
  let saved = '[]', target = 'fg=launcher target=window', enabled = true, locked = false, ready = true;
  const calls = [];
  const tokens = new TokenStore(() => saved, text => saved = text, () => crypto.randomBytes(32).toString('hex'), text => crypto.createHash('sha256').update(text).digest('hex'));
  const { token, record } = tokens.create('Watch', ['input']);
  const host = { ready: () => ready, locked: () => locked, watchControlEnabled: () => enabled,
    navigationContext: () => target, watchState: () => ({ protocol: 1, connected: true, apps: [], windows: [] }),
    input: async (gesture, source) => calls.push([gesture, source]) };
  const request = (patch = {}) => handleRequest(JSON.stringify({ version: 1, token, action: 'watch-navigation',
    gesture: 'swipe-down', source: 'watch', context: target, requestId: 'fc-test-1', expiresAt: Date.now() + 1000, ...patch }), tokens, host);
  return { host, tokens, token, record, calls, request, target: value => target = value,
    enable: value => enabled = value, lock: value => locked = value, ready: value => ready = value };
}
test('state advertises safe navigation capability only when the host provides it', async () => {
  const f = fixture(); const state = await f.request({ action: 'watch-state' });
  assert.deepEqual(state.navigation, { version: 1, context: 'fg=launcher target=window' });
  delete f.host.navigationContext;
  assert.equal((await f.request({ action: 'watch-state' })).navigation, undefined);
});
test('fresh navigation executes once in the current target and returns its new context', async () => {
  const f = fixture();
  f.host.input = async (gesture, source) => { f.calls.push([gesture, source]); f.target('fg=timer target=window'); };
  const reply = await f.request();
  assert.equal(reply.ok, true); assert.equal(reply.navigation.context, 'fg=timer target=window');
  assert.deepEqual(f.calls, [['swipe-down', 'watch']]);
});
test('duplicate request ID is reserved before awaiting input and cannot execute twice', async () => {
  const f = fixture(); let finish;
  f.host.input = async () => { f.calls.push('input'); await new Promise(resolve => finish = resolve); };
  const first = f.request(); assert.equal((await f.request()).error, 'duplicate');
  finish(); assert.equal((await first).ok, true); assert.equal((await f.request()).error, 'duplicate');
  assert.equal(f.calls.length, 1);
});
test('unknown execution after side effects remains ambiguous and reserved against retry', async () => {
  const f = fixture(); f.host.input = async () => { f.calls.push('input'); throw new Error('after side effect'); };
  assert.equal((await f.request()).error, 'failed'); assert.equal((await f.request()).error, 'duplicate');
  assert.equal(f.calls.length, 1);
});
test('a duplicate remains ambiguous even after its original deadline expires', async () => {
  const f = fixture();
  assert.equal((await f.request()).ok, true);
  assert.equal((await f.request({ expiresAt: Date.now() - 1 })).error, 'duplicate');
  assert.equal(f.calls.length, 1);
});
test('expired backlog and an overly long expiry are rejected before any input', async () => {
  const f = fixture();
  assert.equal((await f.request({ expiresAt: Date.now() - 1 })).error, 'expired');
  assert.equal((await f.request({ expiresAt: Date.now() + 3000 })).error, 'bad_request');
  assert.deepEqual(f.calls, []);
});
test('new targets, locks, watch disablement, disconnect and token revocation reject before input', async () => {
  for (const scenario of ['target', 'lock', 'disable', 'disconnect', 'revoke', 'permission']) {
    const f = fixture(); const patch = {};
    if (scenario === 'target') patch.context = 'fg=old target=window';
    if (scenario === 'lock') f.lock(true);
    if (scenario === 'disable') f.enable(false);
    if (scenario === 'disconnect') f.ready(false);
    if (scenario === 'revoke') f.tokens.revoke(f.record.id);
    if (scenario === 'permission') f.tokens.permissions(f.record.id, ['text']);
    assert.equal((await f.request(patch)).ok, false, scenario); assert.deepEqual(f.calls, []);
  }
});
test('only bounded directional metadata is allowed for the burst endpoint', async () => {
  const f = fixture();
  for (const patch of [{ gesture: 'click' }, { gesture: 'long-press' }, { source: 'ring' }, { context: '' },
    { context: '\n' }, { context: 'a'.repeat(257) }, { requestId: 'not-valid' }, { requestId: 'fc-'.padEnd(97, 'a') }, { expiresAt: null }]) {
    assert.equal((await f.request(patch)).error, 'bad_request');
  }
  assert.deepEqual(f.calls, []);
});
test('a full live deduplication cache refuses new input rather than allowing old duplicates', async () => {
  const f = fixture();
  for (let i = 0; i < 128; i++) assert.equal((await f.request({ requestId: 'fc-cap-' + i })).ok, true);
  assert.equal((await f.request({ requestId: 'fc-cap-overflow' })).error, 'busy');
  assert.equal((await f.request({ requestId: 'fc-cap-0' })).error, 'duplicate'); assert.equal(f.calls.length, 128);
});
