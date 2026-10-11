// macOS integration test for the same NSURLSession transport compiled into iOS.
const { Server: WebSocketServer } = require('ws');
const { spawn, execFileSync } = require('node:child_process');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const root = resolve(__dirname, '..'), dir = mkdtempSync(join(tmpdir(), 'faceclaw-socket-'));
execFileSync('xcrun', ['clang', '-fobjc-arc', '-framework', 'Foundation', '-I', 'App_Resources/iOS/src',
  'tests/native/ios-socket-test.m', 'App_Resources/iOS/src/FaceclawSocket.m', '-o', join(dir, 'socket-test')], { cwd: root, stdio: 'inherit' });
// Requires the handshake header; answers binary frames with their hex, echoes text and closes.
const server = new WebSocketServer({ host: '127.0.0.1', port: 0,
  verifyClient: (info, done) => done(info.req.headers['x-faceclaw-key'] === 'secret', 401, 'Unauthorized') });
server.on('connection', socket => socket.on('message', data => {
  if (Buffer.isBuffer(data)) socket.send(`binary:${data.toString('hex')}`);
  else socket.send(data, () => socket.close(1000, 'done'));
}));
server.on('listening', () => {
  const child = spawn(join(dir, 'socket-test'), [`ws://127.0.0.1:${server.address().port}`], { stdio: 'inherit' });
  child.on('exit', code => { server.close(); rmSync(dir, { recursive: true, force: true }); process.exitCode = code ?? 1; });
});
