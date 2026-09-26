const { test } = require('node:test');
const assert = require('node:assert/strict');
const { listenerAddresses, createListenerPool } = require('../.test-build/app/remote/listeners.js');
const address = (name, address, pointToPoint = true) => ({ name, address, pointToPoint });
const interfaces = [address('wlan0', '192.168.1.2', false), address('wlan0', 'fd7a:115c:a1e0::2', false),
  address('rmnet0', '100.70.1.2'), address('tun0', '100.70.2.3'), address('tun0', 'fd7a:115c:a1e0::1234'),
  address('utun2', '10.0.1.2'), address('utun2', 'fe80::1')];
test('automatic detection selects only tailnet addresses of the Tailscale tunnel, plus localhost', () => {
  assert.deepEqual(listenerAddresses(interfaces, 'tailscale'), ['100.70.2.3', '127.0.0.1', 'fd7a:115c:a1e0::1234']);
  assert.deepEqual(listenerAddresses([address('tun1', '100.70.1.2')], 'tailscale'), ['127.0.0.1']);
  assert.deepEqual(listenerAddresses([address('tailscale0', '100.70.1.2', false)], 'tailscale'), ['100.70.1.2', '127.0.0.1']);
});
test('explicit tunnel selection persists by name; absent tunnel never falls back to LAN or wildcard', () => {
  assert.deepEqual(listenerAddresses(interfaces, 'interface:tun0'), ['100.70.2.3', '127.0.0.1', 'fd7a:115c:a1e0::1234']);
  assert.deepEqual(listenerAddresses(interfaces, 'interface:utun2'), ['10.0.1.2', '127.0.0.1']);
  for (const choice of ['localhost', 'interface:wlan0', 'interface:rmnet0', 'interface:missing', '0.0.0.0'])
    assert.deepEqual(listenerAddresses(interfaces, choice), ['127.0.0.1']);
  assert.deepEqual(listenerAddresses([address('tun0', '0.0.0.0'), address('tun0', '::')], 'interface:tun0'), ['127.0.0.1']);
});
test('listener pool preserves USB, adds/removes tunnel sockets and routes replies with unique IDs', () => {
  const sockets = [];
  const pool = createListenerPool(() => {
    const socket = { start: (port, address) => { socket.address = address; return ''; }, stop: () => { socket.stopped = true; },
      nextRequest: () => socket.pending ? (socket.pending = false, JSON.stringify({ id: 1, body: '{}', expiresAt: Date.now() + 5000 })) : null,
      complete: (id, response) => socket.reply = { id, response }, pending: true };
    sockets.push(socket); return socket;
  });
  pool.start(8791, ['127.0.0.1']);
  pool.start(8791, ['127.0.0.1', '100.70.2.3']);
  assert.equal(sockets.length, 2);
  const first = JSON.parse(pool.nextRequest()), second = JSON.parse(pool.nextRequest());
  assert.notEqual(first.id, second.id);
  pool.complete(first.id, 'first'); pool.complete(second.id, 'second');
  assert.deepEqual(sockets.map(s => s.reply.response), ['first', 'second']);
  pool.start(8791, ['127.0.0.1']);
  assert.equal(sockets[0].stopped, undefined); assert.equal(sockets[1].stopped, true);
  pool.start(8791, ['127.0.0.1', '100.70.2.3']);
  pool.complete(second.id, 'late'); assert.equal(sockets[2].reply, undefined);
  pool.stop(); assert.ok(sockets.every(s => s.stopped));
});
