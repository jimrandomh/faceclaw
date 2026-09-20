const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const net = require('node:net');
const { EventEmitter } = require('node:events');
const { TokenStore, handleRequest, GESTURES } = require('../.test-build/app/remote/protocol.js');
const cli = require('../scripts/faceclaw-input.cjs');
function fixture(permissions = ['input', 'text', 'assistant']) {
  let stored = '[]'; const calls = [];
  const tokens = new TokenStore(() => stored, value => { stored = value; },
    () => crypto.randomBytes(32).toString('hex'), value => crypto.createHash('sha256').update(value).digest('hex'));
  const { token, record } = tokens.create('Test app', permissions);
  const host = { ready: () => true, locked: () => false, input: async (...args) => calls.push(args),
    acceptsText: () => true, text: text => calls.push(['text', text]), assistantAvailable: () => true,
    assistant: text => calls.push(['assistant', text]) };
  const request = payload => handleRequest(JSON.stringify({ version: 1, token, ...payload }), tokens, host);
  return { tokens, token, record, host, calls, request, stored: () => stored };
}
test('tokens are random, persisted only as hashes, and survive reload', () => {
  const f = fixture();
  assert.match(f.token, /^fc1_[a-f0-9]{64}$/);
  assert.ok(!f.stored().includes(f.token));
  const another = f.tokens.create('Second', ['input']);
  assert.notEqual(another.token, f.token);
  assert.equal(f.tokens.authenticate(f.token).name, 'Test app');
  assert.equal(f.tokens.authenticate(f.token + 'x'), undefined);
  assert.equal(f.tokens.authenticate('fc1_' + '0'.repeat(64)), undefined);
  assert.throws(() => f.tokens.create('', ['input']));
  assert.throws(() => f.tokens.create('Empty', []));
});
test('permission matrix independently authorizes each operation; edits and revocation take effect immediately', async () => {
  for (const permission of ['input', 'text', 'assistant']) {
    const f = fixture([permission]);
    for (const action of ['input', 'text', 'assistant']) {
      const result = await f.request({ action, gesture: 'click', text: 'hello' });
      assert.equal(result.ok, action === permission);
      if (!result.ok) assert.equal(result.error, 'forbidden');
    }
    f.tokens.permissions(f.record.id, []);
    assert.equal((await f.request({ action: permission, gesture: 'click', text: 'hello' })).error, 'forbidden');
    f.tokens.revoke(f.record.id);
    assert.equal((await f.request({ action: permission })).error, 'unauthorized');
  }
});
test('every supported gesture routes with the selected source, directions require watch', async () => {
  const f = fixture();
  for (const gesture of GESTURES) {
    assert.equal((await f.request({ action: 'input', gesture })).ok, true);
    assert.deepEqual(f.calls.at(-1), [gesture, 'watch']);
    assert.equal((await f.request({ action: 'input', gesture, source: 'ring' })).ok, !gesture.startsWith('swipe-'));
  }
});
test('malformed and unauthorized requests have no side effects', async () => {
  const f = fixture();
  for (const body of ['null', '[]', '{', 'true']) assert.equal((await handleRequest(body, f.tokens, f.host)).ok, false);
  for (const payload of [ { token: 'bad' }, { version: 2 }, { action: 'unlock' },
    { action: 'input', gesture: 'wakeword' }, { action: 'input', gesture: 'click', source: 'phone' },
    { action: 'text', text: '' }, { action: 'text', text: 123 }, { action: 'text', text: 'x'.repeat(8001) },
    { action: 'assistant', text: '\0' } ]) assert.equal((await f.request(payload)).ok, false);
  assert.deepEqual(f.calls, []);
});
test('locks block text and assistant; gestures still use lock-screen dispatch', async () => {
  const f = fixture(); f.host.locked = () => true;
  for (const action of ['text', 'assistant']) assert.equal((await f.request({ action, text: 'hello' })).error, 'locked');
  assert.equal((await f.request({ action: 'input', gesture: 'double-click' })).ok, true);
  assert.deepEqual(f.calls, [['double-click', 'watch']]);
});
test('readiness and unavailable destinations fail; text whitespace is preserved', async () => {
  const f = fixture();
  f.host.ready = () => false;
  assert.equal((await f.request({ action: 'input', gesture: 'click' })).error, 'unavailable');
  f.host.ready = () => true; f.host.acceptsText = () => false;
  assert.equal((await f.request({ action: 'text', text: 'hello' })).error, 'unavailable');
  f.host.assistantAvailable = () => false;
  assert.equal((await f.request({ action: 'assistant', text: 'hello' })).error, 'unavailable');
  f.host.acceptsText = () => true;
  assert.equal((await f.request({ action: 'text', text: '  a\nb  ' })).ok, true);
  assert.deepEqual(f.calls, [['text', '  a\nb  ']]);
  f.host.input = async () => { throw new Error('private detail'); };
  assert.equal((await f.request({ action: 'input', gesture: 'click' })).error, 'failed');
});
test('CLI parses one-off commands and maps keyboard input', () => {
  const env = { FACECLAW_TOKEN: fixture().token };
  assert.deepEqual(cli.parseArgs(['input', 'up'], env).payload, { action: 'input', gesture: 'swipe-up', source: 'watch' });
  assert.equal(cli.parseArgs(['assistant', 'a message'], env).payload.text, 'a message');
  assert.equal(cli.parseArgs(['interactive'], env).interactive, true);
  assert.throws(() => cli.parseArgs(['input', 'up', '--source', 'ring'], env));
  assert.throws(() => cli.parseArgs(['text', ''], env));
  assert.throws(() => cli.parseArgs(['input', 'tap', '--port', '0'], env));
  assert.equal(cli.parseArgs(['--help'], {}).help, true);
  assert.deepEqual(['up','down','left','right','return','escape','tab'].map(name => cli.keyGesture({name})),
    ['swipe-up','swipe-down','swipe-left','swipe-right','click','double-click','long-press']);
});
test('CLI exchanges framed UTF-8 requests with the permission-checking handler', async t => {
  const f = fixture(['assistant']);
  const server = net.createServer({ allowHalfOpen: true }, socket => {
    let text = '';
    socket.setEncoding('utf8');
    socket.on('data', async chunk => {
      text += chunk;
      if (!text.endsWith('\n')) return;
      const response = JSON.stringify(await handleRequest(text.trimEnd(), f.tokens, f.host)) + '\n';
      socket.write(response.slice(0, 4)); socket.end(response.slice(4));
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const options = { host: '127.0.0.1', port: server.address().port, token: f.token };
  await cli.send(options, { action: 'assistant', text: 'hello 世界 👋' });
  assert.deepEqual(f.calls, [['assistant', 'hello 世界 👋']]);
  await assert.rejects(cli.send(options, { action: 'input', gesture: 'click' }), /lacks input permission/);
});
test('interactive mode orders inputs and restores raw mode on Ctrl-C', async () => {
  const input = new EventEmitter(); input.isTTY = true; input.isRaw = false;
  const modes = []; input.setRawMode = value => modes.push(value); input.resume = () => {}; input.pause = () => {};
  const sent = [];
  const task = cli.interactive({}, input, { write: () => {} }, async (_opts, payload) => { if (payload.action === 'input') sent.push(payload.gesture); });
  await new Promise(resolve => setImmediate(resolve));
  input.emit('keypress', '', { name: 'up' });
  input.emit('keypress', '', { name: 'return' });
  await new Promise(resolve => setImmediate(resolve));
  input.emit('keypress', '', { name: 'c', ctrl: true });
  await task;
  assert.deepEqual(sent, ['swipe-up', 'click']);
  assert.deepEqual(modes, [true, false]);
  assert.equal(input.listenerCount('keypress'), 0);
});

test('interactive terminal escape sequences distinguish arrows from standalone Esc', async () => {
  const { PassThrough } = require('node:stream');
  const input = new PassThrough(); input.isTTY = true;
  input.setRawMode = () => {};
  const sent = [];
  const task = cli.interactive({}, input, { write() {} }, async (_opts, payload) => { if (payload.action === 'input') sent.push(payload.gesture); });
  await new Promise(resolve => setImmediate(resolve));
  input.write('\x1b[A\r\t');
  await new Promise(resolve => setTimeout(resolve, 10));
  input.write('\x1b');
  await new Promise(resolve => setTimeout(resolve, 100));
  input.write('\x03');
  await task;
  assert.deepEqual(sent, ['swipe-up', 'click', 'long-press', 'double-click']);
  input.destroy();
});

test('quitting interactive mode cancels the in-flight request and drops queued keys', async () => {
  const input = new EventEmitter(); input.isTTY = true;
  const modes = []; input.setRawMode = value => modes.push(value); input.resume = input.pause = () => {};
  let signal;
  const task = cli.interactive({}, input, { write() {} }, (_opts, payload, abortSignal) => {
    if (payload.action === 'ping') return Promise.resolve();
    signal = abortSignal;
    return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('cancelled'))));
  });
  await new Promise(resolve => setImmediate(resolve));
  input.emit('keypress', '', { name: 'up' });
  input.emit('keypress', '', { name: 'down' });
  input.emit('keypress', '', { name: 'c', ctrl: true });
  await task;
  assert.equal(signal.aborted, true);
  assert.deepEqual(modes, [true, false]);
});


test('text -n preserves the message and suppresses terminal submission only', async () => {
  const f = fixture(); const env = { FACECLAW_TOKEN: f.token };
  const received = []; f.host.text = (text, submit) => received.push({ text, submit });
  for (const args of [['text', 'hello'], ['text', '-n', 'hello'], ['text', '-n', 'line one\nline two'], ['text', '--', '-n']]) {
    const { payload } = cli.parseArgs(args, env);
    assert.equal((await f.request(payload)).ok, true);
  }
  assert.deepEqual(received, [{ text: 'hello', submit: true }, { text: 'hello', submit: false },
    { text: 'line one\nline two', submit: false }, { text: '-n', submit: true }]);
  assert.throws(() => cli.parseArgs(['assistant', '-n', 'hello'], env), /only valid with text/);
  assert.equal((await f.request({ action: 'text', text: 'hello', submit: 'false' })).error, 'bad_request');
});

test('ping authenticates and checks input permission without generating an input or requiring connected glasses', async () => {
  const f = fixture(['input']); f.host.ready = () => false;
  assert.deepEqual(await f.request({ action: 'ping', permission: 'input' }), { ok: true });
  assert.equal((await f.request({ action: 'ping', token: 'bad' })).error, 'unauthorized');
  f.tokens.permissions(f.record.id, ['text']);
  assert.equal((await f.request({ action: 'ping', permission: 'input' })).error, 'forbidden');
  assert.deepEqual(f.calls, []);
});

test('interactive checks connectivity immediately, reports failures and remains alive until Ctrl-C', async () => {
  const input = new EventEmitter(); input.isTTY = true; input.setRawMode = input.resume = input.pause = () => {};
  const requests = [], output = []; let stopped = false;
  const task = cli.interactive({}, input, { write: text => output.push(text) }, async (_opts, payload) => {
    requests.push(payload); throw new Error('Connection refused');
  }).then(() => { stopped = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(requests, [{ action: 'ping' }]);
  assert.match(output.join(''), /Connection refused/); assert.equal(stopped, false);
  input.emit('keypress', '', { name: 'c', ctrl: true }); await task;
});

test('a lost response does not end interactive mode or replay an input on reconnect', async () => {
  const input = new EventEmitter(); input.isTTY = true; input.setRawMode = input.resume = input.pause = () => {};
  const requests = [], output = []; let fail = true, stopped = false;
  const task = cli.interactive({}, input, { write: text => output.push(text) }, async (_opts, payload) => {
    requests.push(payload);
    if (payload.action === 'input' && fail) { fail = false; throw new Error('Faceclaw closed the connection without a response.'); }
  }).then(() => { stopped = true; });
  try {
    await new Promise(resolve => setImmediate(resolve));
    input.emit('keypress', '', { name: 'up' });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(stopped, false); assert.match(output.join(''), /without a response/);
    input.emit('keypress', '', { name: 'down' }); // Discarded while offline.
    await new Promise(resolve => setTimeout(resolve, 3100));
    input.emit('keypress', '', { name: 'return' });
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(requests.filter(r => r.action === 'input').map(r => r.gesture), ['swipe-up', 'click']);
  } finally { input.emit('keypress', '', { name: 'c', ctrl: true }); await task; }
});

test('client keeps the sending side open until the reply, including across a forwarding proxy', async t => {
  let prematureEnd = false;
  const server = net.createServer(socket => {
    let text = '', replied = false;
    socket.on('end', () => { if (!replied) prematureEnd = true; });
    socket.on('data', chunk => {
      text += chunk.toString();
      if (text.includes('\n')) setTimeout(() => { replied = true; if (!socket.destroyed) socket.end('{"ok":true}\n'); }, 25);
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const options = { host: '127.0.0.1', port: server.address().port, token: fixture().token };
  for (let i = 0; i < 4; i++) await cli.send(options, { action: 'input', gesture: 'click' });
  assert.equal(prematureEnd, false);
});
