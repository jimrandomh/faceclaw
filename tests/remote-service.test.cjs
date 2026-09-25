const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');

function fixture() {
  let ready, changed, tokens = [{}], polls = 0, active = 0, maxActive = 0;
  const queue = [], replies = [], timers = new Map(), handled = [];
  const native = {
    start() {}, addresses: () => ['127.0.0.1'], stop: () => { queue.length = 0; },
    nextRequest() { polls++; return queue.length ? JSON.stringify(queue.shift()) : null; },
    complete: (id, response) => replies.push({ id, ...JSON.parse(response) }),
  };
  let handle = async body => ({ ok: true, body });
  const modules = {
    '../native/settings-store': { getStringSetting: (_k, d) => d, setStringSetting() {},
      onSettingsStoreChanged: cb => { changed = cb; return () => { changed = null; }; } },
    '../native/remote-input': { remoteNative: cb => { ready = cb; return native; }, remoteInterfaces: () => [],
      randomTokenSecret() {}, tokenHash() {} },
    './listeners': require('../.test-build/app/remote/listeners.js'),
    './protocol': { TokenStore: class { list() { return tokens; } }, REMOTE_PORT: 8791,
      handleRequest: async body => {
        handled.push(body); active++; maxActive = Math.max(maxActive, active);
        try { return await handle(body); } finally { active--; }
      } },
  };
  const context = { exports: {}, require: id => modules[id],
    setInterval: (fn, ms) => { timers.set(fn, ms); return fn; }, clearInterval: id => timers.delete(id) };
  vm.runInNewContext(ts.transpileModule(fs.readFileSync('app/remote/service.ts', 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText, context);
  const stop = context.exports.startRemoteInput({});
  return { stop, timers, replies, handled, get polls() { return polls; }, get maxActive() { return maxActive; },
    setHandle: fn => { handle = fn; },
    notify: () => ready(), enqueue: (id, expiresAt = Date.now() + 5000) => queue.push({ id, body: id, expiresAt }),
    tokens: value => { tokens = value; changed('remoteInput.tokens.v1'); },
  };
}
const settle = () => new Promise(resolve => setImmediate(resolve));

test('idle remote sockets do not poll native requests, including network reconciliation', () => {
  const f = fixture();
  assert.deepEqual([...f.timers.values()], [3000]);
  for (let i = 0; i < 100; i++) for (const tick of f.timers.keys()) tick();
  assert.equal(f.polls, 0);
  f.stop(); assert.equal(f.timers.size, 0);
});

test('request notifications drain serially without losing wakeups while busy', async () => {
  const f = fixture(); let release;
  f.setHandle(body => body === 'a' ? new Promise(resolve => { release = resolve; }) : { ok: true });
  f.enqueue('a'); f.notify();
  f.enqueue('b'); f.notify(); f.enqueue('c'); f.notify();
  assert.deepEqual(f.handled, ['a']);
  release({ ok: true }); await settle();
  assert.deepEqual(f.handled, ['a', 'b', 'c']);
  assert.deepEqual(f.replies.map(r => r.id), ['a', 'b', 'c']);
  assert.equal(f.maxActive, 1);
  const idlePolls = f.polls; await settle(); assert.equal(f.polls, idlePolls);
  f.stop();
});

test('expired requests and failed handlers do not prevent queued requests from draining', async () => {
  const f = fixture(); f.setHandle(body => { if (body === 'bad') throw Error('test'); return { ok: true }; });
  f.enqueue('expired', 0); f.enqueue('bad'); f.enqueue('good'); f.notify(); await settle();
  assert.deepEqual(f.handled, ['bad', 'good']);
  assert.equal(f.replies[0].error, 'failed'); assert.equal(f.replies[1].ok, true);
  f.stop();
});

test('token removal and service shutdown stop dispatch, and re-enabling tokens resumes it', async () => {
  const f = fixture();
  f.enqueue('removed'); f.tokens([]); f.notify(); await settle();
  assert.deepEqual(f.handled, []); assert.equal(f.timers.size, 0);
  f.tokens([{}]); f.enqueue('resumed'); f.notify(); await settle();
  assert.deepEqual(f.handled, ['resumed']);
  let release; f.setHandle(() => new Promise(resolve => { release = resolve; }));
  f.enqueue('in-flight'); f.notify(); f.stop();
  f.enqueue('late'); f.notify(); release({ ok: true }); await settle();
  assert.deepEqual(f.replies.map(r => r.id), ['resumed']);
  assert.deepEqual(f.handled, ['resumed', 'in-flight']);
});
