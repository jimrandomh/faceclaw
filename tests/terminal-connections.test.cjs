const test = require('node:test');
const assert = require('node:assert/strict');
const { loader } = require('./helpers/load-typescript.cjs');

const settings = new Map();
const connections = loader({}, {
  '../../native/settings-store': {
    getStringSetting: (key, fallback) => (settings.has(key) ? settings.get(key) : fallback),
    setStringSetting: (key, value) => settings.set(key, value),
  },
})('app/apps/terminal/connections.ts');

// vm-realm objects: compare as plain JSON.
const plain = (value) => JSON.parse(JSON.stringify(value));

test('ssh:// strings select tmux by default', () => {
  assert.deepEqual(plain(connections.parseSshConnectionString('ssh://jim@laptop')), { user: 'jim', host: 'laptop', port: 22, mode: 'tmux' });
  assert.deepEqual(plain(connections.parseSshConnectionString('ssh://jim@laptop:2222/')), { user: 'jim', host: 'laptop', port: 2222, mode: 'tmux' });
  assert.deepEqual(plain(connections.parseSshConnectionString('ssh://jim@[fd7a::1]:22')), { user: 'jim', host: 'fd7a::1', port: 22, mode: 'tmux' });
  assert.equal(connections.parseSshConnectionString('ssh://jim%40corp@laptop').user, 'jim@corp');
});

test('?g2mirror= tunnels a g2mirror server over ssh', () => {
  assert.deepEqual(plain(connections.parseSshConnectionString('ssh://jim@laptop?g2mirror=tok')), {
    user: 'jim', host: 'laptop', port: 22, mode: 'g2mirror', authToken: 'tok', targetHost: '127.0.0.1', targetPort: 8737,
  });
  const custom = connections.parseSshConnectionString('ssh://jim@laptop?g2mirror=tok@en@localhost:9000');
  assert.equal(custom.authToken, 'tok@en');
  assert.equal(custom.targetHost, 'localhost');
  assert.equal(custom.targetPort, 9000);
});

test('malformed ssh:// strings are rejected', () => {
  for (const url of ['ssh://laptop', 'ssh://jim@', 'ssh://jim@laptop:0', 'ssh://jim@laptop?mode=tmux', 'ssh://jim@laptop?g2mirror=', 'ssh://jim@laptop?g2mirror=tok@host:99999', 'ssh://jim@laptop?g2mirror']) {
    assert.equal(connections.parseSshConnectionString(url), null, url);
  }
});

test('any-kind parsing and host labels', () => {
  assert.equal(connections.parseAnyConnectionString('g2mirror://tok@laptop').kind, 'g2mirror');
  assert.equal(connections.parseAnyConnectionString('ssh://jim@laptop').kind, 'ssh');
  assert.equal(connections.parseAnyConnectionString('http://laptop'), null);
  assert.equal(connections.connectionStringHostLabel('ssh://jim@laptop?g2mirror=secret'), 'jim@laptop');
  assert.equal(connections.connectionStringHostLabel('ssh://jim@laptop:2222'), 'jim@laptop:2222');
  assert.equal(connections.connectionStringHostLabel('ssh://jim@[fd7a::1]'), 'jim@[fd7a::1]');
  assert.equal(connections.connectionStringHostLabel('g2mirror://tok@laptop'), 'laptop');
});

test('stored connections keep pinned host keys', () => {
  connections.saveConnections([{ id: 'c1', url: 'ssh://jim@laptop', serverName: null, enabled: true, hostKeys: ['AAAA'] }]);
  connections.updateConnection('c1', { hostKeys: ['AAAA', 'BBBB'] });
  assert.deepEqual(plain(connections.loadConnections()[0].hostKeys), ['AAAA', 'BBBB']);
  // Entries saved before SSH support have no hostKeys.
  settings.set(connections.TERMINAL_CONNECTIONS_KEY, JSON.stringify([{ id: 'c2', url: 'g2mirror://t@h', enabled: true }]));
  assert.deepEqual(plain(connections.loadConnections()[0].hostKeys), []);
});
