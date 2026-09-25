'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { SourceMap } = require('node:module');
const { parseArgs, remapProfile, traceSummary, Inspector } = require('../scripts/profile-android.cjs');

test('profiling CLI validates remote shell arguments and sampling limits', () => {
  assert.equal(parseArgs([], {}).mode, 'all');
  assert.equal(parseArgs([], { ANDROID_SERIAL: 'usb-device' }).device, 'usb-device');
  for (const args of [
    ['--package', 'com.faceclaw.app;id'], ['--package', '../app'],
    ['--seconds', 'NaN'], ['--seconds', '0'], ['--seconds', '301'],
    ['--interval', '1'], ['--interval', '100.5'], ['--mode', 'native'], ['--device'],
  ]) assert.throws(() => parseArgs(args, {}));
});

test('source mapping keeps V8 sample structure and raw locations intact', () => {
  const map = new SourceMap({ version: 3, sources: ['webpack://faceclaw/app/example.ts'],
    names: ['originalName'], mappings: 'AASEA', sourcesContent: [''] });
  const raw = { nodes: [{ id: 1, callFrame: { url: 'bundle.mjs', functionName: 'minified',
    lineNumber: 0, columnNumber: 0 }, hitCount: 2, positionTicks: [{ line: 1, ticks: 2 }] },
    { id: 2, callFrame: { url: '', functionName: '(idle)', lineNumber: -1, columnNumber: -1 } }],
    samples: [1, 2, 1], timeDeltas: [1000, 1500, 2000], startTime: 123, endTime: 4623 };
  const result = remapProfile(raw, new Map([['bundle.mjs', map]]));
  assert.equal(result.mappedNodes, 1);
  assert.deepEqual(result.profile.nodes[0].callFrame, { url: 'webpack://faceclaw/app/example.ts',
    functionName: 'originalName', lineNumber: 9, columnNumber: 2 });
  assert.equal(result.profile.nodes[0].positionTicks, undefined);
  assert.equal(raw.nodes[0].callFrame.url, 'bundle.mjs');
  assert.ok(raw.nodes[0].positionTicks);
  assert.deepEqual(result.profile.samples, raw.samples);
  assert.deepEqual(result.profile.timeDeltas, raw.timeDeltas);
  assert.deepEqual(result.profile.nodes[1], raw.nodes[1]);
});

test('ART validation detects overflow and recognizes Kotlin source names', () => {
  const trace = Buffer.from('*version\n3\ndata-file-overflow=true\n*methods\n' +
    '0x4\tcom.faceclaw.Example\tfoo\t()V\tExample.kt\n' +
    '0x8\tandroid.Example\tbar\t()V\tExample.java\n*end\nSLOW');
  assert.deepEqual(traceSummary(trace), { bytes: trace.length, overflow: true, methods: 2, faceclawMethods: 1, kotlinMethods: 1 });
  assert.throws(() => traceSummary(Buffer.from('Permission denied')));
});

test('CDP routes worker sessions and handles out-of-order replies and disconnects', async () => {
  class Socket extends EventTarget {
    readyState = WebSocket.OPEN;
    sent = [];
    send(data) { this.sent.push(JSON.parse(data)); }
    receive(data) { this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(data) })); }
    close() { this.readyState = WebSocket.CLOSED; this.dispatchEvent(new Event('close')); }
  }
  const socket = new Socket();
  const inspector = new Inspector(socket);
  const main = inspector.call('Profiler.stop');
  const worker = inspector.call('Profiler.stop', {}, 'NS_WORKER_1');
  assert.equal(socket.sent[1].sessionId, 'NS_WORKER_1');
  socket.receive({ id: 2, sessionId: 'NS_WORKER_1', result: { worker: true } });
  socket.receive({ id: 1, result: { main: true } });
  assert.deepEqual(await worker, { worker: true });
  assert.deepEqual(await main, { main: true });
  const failed = inspector.call('Profiler.start');
  socket.receive({ id: 3, error: { message: 'already started' } });
  await assert.rejects(failed, /already started/);
  const disconnected = inspector.call('Profiler.stop');
  inspector.close();
  await assert.rejects(disconnected, /disconnected/);
  await assert.rejects(inspector.call('Profiler.stop'), /not connected/);
});
