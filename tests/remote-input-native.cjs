// macOS host probe for the production iOS socket implementation. Run separately:
// node tests/remote-input-native.cjs (requires Xcode command-line tools).
const assert = require('node:assert/strict');
const { execFileSync, spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const crypto = require('node:crypto');
const { send } = require('../scripts/faceclaw-input.cjs');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'faceclaw-input-'));
async function main() {
  const harness = path.join(directory, 'main.m');
  fs.writeFileSync(harness, `
#import "FaceclawRemoteInput.h"
#import <unistd.h>
int main(int argc, const char **argv) { @autoreleasepool {
  FaceclawRemoteInput *server = [FaceclawRemoteInput shared];
  NSString *secret = [server randomSecret];
  if (secret.length != 64 || ![[server tokenDigest:@"test"] isEqual:@"9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08"]) return 2;
  NSString *failure = [server start:atoi(argv[1])];
  if (failure.length) return 3;
  puts("READY"); fflush(stdout);
  __weak FaceclawRemoteInput *weakServer = server;
  [server setRequestListener:^{ @autoreleasepool {
    FaceclawRemoteInput *server = weakServer;
    if (![NSThread isMainThread]) exit(4);
    NSString *raw = [server nextRequest];
    if (raw) {
      NSDictionary *request = [NSJSONSerialization JSONObjectWithData:[raw dataUsingEncoding:NSUTF8StringEncoding] options:0 error:nil];
      NSDictionary *body = [NSJSONSerialization JSONObjectWithData:[request[@"body"] dataUsingEncoding:NSUTF8StringEncoding] options:0 error:nil];
      if ([body[@"text"] isEqual:@"stop"]) { [server stop]; usleep(300000); puts("STOPPED"); fflush(stdout); exit(0); }
      NSData *reply = [NSJSONSerialization dataWithJSONObject:@{@"ok":@YES, @"echo":body ?: @{}} options:0 error:nil];
      [server complete:[request[@"id"] longLongValue] response:[[NSString alloc] initWithData:reply encoding:NSUTF8StringEncoding]];
    }
  }}];
  [[NSRunLoop mainRunLoop] run];
}}
`);
  const binary = path.join(directory, 'probe');
  execFileSync('xcrun', ['clang', '-fobjc-arc', '-framework', 'Foundation', '-framework', 'Security',
    '-IApp_Resources/iOS/src', harness, 'App_Resources/iOS/src/FaceclawRemoteInput.m',
    'App_Resources/iOS/src/FaceclawCrypto.m', '-o', binary], { stdio: 'inherit' });
  const reservation = net.createServer();
  await new Promise((resolve, reject) => { reservation.once('error', reject); reservation.listen(0, '127.0.0.1', resolve); });
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const child = spawn(binary, [String(port)], { stdio: ['ignore', 'pipe', 'inherit'] });
  const exited = new Promise(resolve => child.once('exit', resolve));
  try {
    await new Promise((resolve, reject) => {
      child.stdout.once('data', data => data.toString().includes('READY') ? resolve() : reject(new Error('Probe not ready')));
      child.once('exit', code => reject(new Error(`Probe exited: ${code}`)));
      child.once('error', reject);
    });
    const options = { host: '127.0.0.1', port, token: 'fc1_' + crypto.randomBytes(32).toString('hex') };
    const reply = await send(options, { action: 'assistant', text: 'Native round trip 👋 世界' });
    assert.equal(reply.echo.text, 'Native round trip 👋 世界');
    assert.equal(reply.echo.token, options.token);
    // Invalid UTF-8 and oversized frames close without becoming JS requests.
    for (const frame of [Buffer.from([0xff, 0x0a]), Buffer.from('x'.repeat(65537) + '\n')]) {
      await new Promise((resolve, reject) => {
        const socket = net.createConnection({ host: options.host, port }, () => socket.end(frame));
        socket.on('data', () => reject(new Error('Invalid frame was dispatched')));
        socket.on('error', error => error.code === 'ECONNRESET' ? resolve() : reject(error));
        socket.on('close', resolve);
      });
    }
    await send(options, { action: 'input', gesture: 'click' });
    await assert.rejects(send(options, { action: 'text', text: 'stop' }));
    assert.equal(await exited, 0);
    console.log('Native socket probe passed: crypto, framing, UTF-8, main-thread request notifications, multiple connections, shutdown.');
  } finally { child.kill(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => fs.rmSync(directory, { recursive: true, force: true }));
