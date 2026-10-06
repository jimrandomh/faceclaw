const test = require('node:test');
const assert = require('node:assert/strict');
const { T3RpcConnection, causeToError } = require('../.test-build/app/apps/t3code/t3-rpc.js');

// Every connection made here, closed at the end so their ping timers don't keep Node alive.
const connections = [];
test.after(() => { for (const connection of connections) connection.close(); });

/** A connection over a scripted fake socket; `sent` collects parsed outgoing frames. */
function connect(options = {}) {
  const sent = [];
  let handlers = null;
  let closed = 0;
  const connection = new T3RpcConnection({
    url: 'ws://test/ws',
    pingIntervalMs: 1_000_000,
    openTimeoutMs: 1_000_000,
    ...options,
    openSocket: (_url, h) => {
      handlers = h;
      return { send: (text) => sent.push(JSON.parse(text)), close: () => { closed++; } };
    },
  });
  connections.push(connection);
  return {
    connection, sent,
    open: () => handlers.onOpen(),
    receive: (message) => handlers.onMessage(JSON.stringify(message)),
    drop: (reason) => handlers.onClose(reason),
    closedCount: () => closed,
  };
}

test('requests made while connecting are sent once the socket opens', async () => {
  const t = connect();
  const result = t.connection.call('server.probe', {});
  assert.equal(t.sent.length, 0);
  t.open();
  assert.deepEqual(t.sent, [{ _tag: 'Request', id: 0, tag: 'server.probe', payload: {}, headers: [] }]);
  t.receive({ _tag: 'Exit', requestId: 0, exit: { _tag: 'Success', value: { ok: 1 } } });
  assert.deepEqual(await result, { ok: 1 });
});

test('every chunk is acked and delivered; interrupt cancels', () => {
  const t = connect();
  t.open();
  const values = [];
  let ended = 'not yet';
  const sub = t.connection.subscribe('orchestration.subscribeShell', { requestCompletionMarker: true },
    (v) => values.push(...v), (error) => { ended = error; });
  t.receive({ _tag: 'Chunk', requestId: 0, values: [{ kind: 'snapshot' }] });
  t.receive({ _tag: 'Chunk', requestId: 0, values: [{ kind: 'synchronized' }, { kind: 'thread.updated' }] });
  assert.deepEqual(values.map((v) => v.kind), ['snapshot', 'synchronized', 'thread.updated']);
  assert.deepEqual(t.sent.slice(1), [{ _tag: 'Ack', requestId: 0 }, { _tag: 'Ack', requestId: 0 }]);
  sub.cancel();
  assert.deepEqual(t.sent.at(-1), { _tag: 'Interrupt', requestId: 0 });
  t.receive({ _tag: 'Exit', requestId: 0, exit: { _tag: 'Failure', cause: [{ _tag: 'Interrupt', fiberId: 1 }] } });
  assert.equal(ended, 'not yet', 'a cancelled stream reports nothing more');
});

test('typed failures, defects and batched frames', async () => {
  const t = connect();
  t.open();
  const failing = t.connection.call('subscribeAuthAccess', {});
  const dying = t.connection.call('no.such.method', {});
  t.receive([
    { _tag: 'Pong' },
    { _tag: 'Exit', requestId: 0, exit: { _tag: 'Failure', cause: [{ _tag: 'Fail', error: { _tag: 'EnvironmentAuthorizationError', message: 'missing scope' } }] } },
    { _tag: 'Exit', requestId: 1, exit: { _tag: 'Failure', cause: [{ _tag: 'Die', defect: 'Unknown request tag: no.such.method' }] } },
  ]);
  await assert.rejects(failing, (error) => error.kind === 'fail' && error.errorTag === 'EnvironmentAuthorizationError' && error.message === 'missing scope');
  await assert.rejects(dying, (error) => error.kind === 'die' && /Unknown request tag/.test(error.message));
});

test('a connection-level defect fails everything pending', async () => {
  const t = connect();
  t.open();
  const call = t.connection.call('server.getConfig', {});
  let streamError = null;
  t.connection.subscribe('subscribeServerConfig', {}, () => {}, (error) => { streamError = error; });
  t.receive({ _tag: 'Defect', defect: { name: 'SyntaxError', message: 'bad json' } });
  await assert.rejects(call, (error) => error.kind === 'die');
  assert.equal(streamError.kind, 'die');
});

test('dropping the socket fails pending work as disconnected', async () => {
  const t = connect();
  t.open();
  const states = [];
  t.connection.onStateChange((state, reason) => states.push([state, reason]));
  const call = t.connection.call('server.probe', {});
  let streamError = null;
  t.connection.subscribe('orchestration.subscribeThread', { threadId: 'x' }, () => {}, (error) => { streamError = error; });
  t.drop('network gone');
  await assert.rejects(call, (error) => error.kind === 'disconnected' && error.message === 'network gone');
  assert.equal(streamError.kind, 'disconnected');
  assert.deepEqual(states, [['closed', 'network gone']]);
  await assert.rejects(t.connection.call('server.probe'), (error) => error.kind === 'disconnected');
});

test('unanswered pings close the connection', () => {
  const realSetInterval = global.setInterval;
  let tick = null;
  global.setInterval = (fn) => { tick = fn; return 1; };
  try {
    const t = connect({ maxMissedPongs: 2 });
    t.open();
    tick();
    tick();
    assert.equal(t.sent.filter((m) => m._tag === 'Ping').length, 2);
    t.receive({ _tag: 'Pong' });
    tick();
    tick();
    assert.equal(t.connection.getState(), 'open', 'a pong resets the count');
    tick();
    assert.equal(t.connection.getState(), 'closed');
    assert.equal(t.closedCount(), 1);
  } finally {
    global.setInterval = realSetInterval;
  }
});

test('causeToError prefers typed failures', () => {
  const error = causeToError([{ _tag: 'Interrupt' }, { _tag: 'Fail', error: { _tag: 'X', detail: 'why' } }]);
  assert.equal(error.kind, 'fail');
  assert.equal(error.message, 'why');
  assert.equal(causeToError([{ _tag: 'Interrupt' }]).kind, 'interrupt');
});
