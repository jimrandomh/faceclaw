import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createMessagingSession } from '../lib/session.js';

const packageRoot = new URL('../node_modules/@zeppos/zml/', import.meta.url);
const state = { connected: true, screenOn: true, remoteEnabled: true };
const flush = () => new Promise(resolve => setImmediate(resolve));

// Execute the exact installed 0.0.43 BaseApp and BasePage bundles, including
// their real framing, deferred requests, handshake and cross-context bridge.
function fixture({ adapted = true } = {}) {
  let app, receive, bleListener, connected = true, now = 0, nextTimer = 0, failSend = false, connects = 0, disconnects = 0;
  const packets = [], timers = new Map(), appEvents = new Map();
  class EventBus {
    constructor() { this.events = new Map(); }
    on(name, callback) { const list = this.events.get(name) || []; list.push(callback); this.events.set(name, list); return this; }
    off(name, callback) { if (!callback) this.events.delete(name); else this.events.set(name, (this.events.get(name) || []).filter(item => item !== callback)); return this; }
    emit(name, ...args) { for (const callback of [...(this.events.get(name) || [])]) callback(...args); }
  }
  const log = { log() {}, info() {}, warn() {}, error() {}, debug() {} };
  const modules = {
    '@zos/utils': { EventBus, log: { getLogger: () => log }, px: value => value },
    '@zos/timer': { setTimeout(fn, delay) { timers.set(++nextTimer, { fn, at: now + delay }); return nextTimer; }, clearTimeout(id) { timers.delete(id); } },
    '@zos/app': { getPackageInfo: () => ({ appId: 12345 }),
      onMessage(name, fn) { appEvents.set(name, fn); }, offMessage(name) { appEvents.delete(name); },
      postMessage(name, value) { appEvents.get(name)?.({}, value); } },
    '@zos/ble': { connectStatus: () => connected, addListener(fn) { bleListener = fn; },
      createConnect(fn) { receive = fn; connects++; }, disConnect() { disconnects++; },
      send(buffer, size) { if (failSend) return false; packets.push(Buffer.from(new Uint8Array(buffer, 0, size))); return true; } },
    '@zos/device': { getDeviceInfo: () => ({}) }, '@zos/i18n': {}, '@zos/router': {}, '@zos/settings': {}, '@zos/ui': {},
  };
  const context = vm.createContext({ Buffer, Promise, Date, console,
    __$$R$$__: name => modules[name], __$$app$$__: { __globals__: { __scopedGlobals__: {} } },
    __$$module$$__: { id: 1 }, getApp: () => ({ _options: app }),
  });
  for (const [filename, name] of [['zml-app.js', 'BaseApp'], ['zml-page.js', 'BasePage']]) {
    const source = fs.readFileSync(new URL('dist/' + filename, packageRoot), 'utf8');
    const code = source.replace(new RegExp('export\\{(\\w+) as ' + name + '\\};?\\s*$'), 'globalThis.' + name + ' = $1;');
    assert.notEqual(code, source, 'Expected pinned ZML bundle export');
    vm.runInContext('(function(){' + code + '\n})();', context);
    if (name === 'BaseApp') { app = context.BaseApp({}); app.onCreate(); }
  }
  const page = context.BasePage({}); page.onInit();
  const transport = app.messaging.transport;
  const session = adapted ? createMessagingSession(app.messaging) : null;
  const envelope = (type, payload = Buffer.alloc(0), port = 77) => transport.buildBin({ flag: 1, version: 1, type,
    port1: 20, port2: port, appId: 12345, extra: 0, payload });
  const deliver = bytes => receive(0, bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), bytes.byteLength);
  const parsed = () => packets.map(bytes => transport.readBin(bytes));
  const requests = () => parsed().filter(packet => packet.type === 4 && transport.readPayload(packet.payload).payloadType === 1).map(packet => {
    const payload = transport.readPayload(packet.payload);
    return { ...payload, body: JSON.parse(payload.payload.toString('utf8')), port: packet.port2 };
  });
  const respond = (result = { ok: true, state }, id = requests().at(-1).traceId, error) => {
    const data = Buffer.from(JSON.stringify(error ? { jsonrpc: 'hmrpcv1', error } : { jsonrpc: 'hmrpcv1', result }));
    deliver(envelope(4, transport.buildPayload({ traceId: id, spanId: 1, seqId: 0, totalLength: data.length,
      type: 2, opCode: 1, contentType: 2, dataType: 2, payload: data })));
  };
  const request = operation => page.request({ method: 'FACECLAW', operation }, { timeout: 100 });
  return { page, transport, session, timers, appEvents, requests,
    reads: () => requests().filter(request => request.body.operation.kind === 'state'),
    mutations: () => requests().filter(request => request.body.operation.kind !== 'state'),
    shakes: () => parsed().filter(packet => packet.type === 1).length,
    shakePorts: () => parsed().filter(packet => packet.type === 1).map(packet => packet.port2),
    request, state: () => request({ kind: 'state' }), command: () => request({ kind: 'gesture', gesture: 'swipe-up' }),
    handshake: (port = 77) => deliver(envelope(1, Buffer.alloc(0), port)),
    close: () => deliver(envelope(2)), reply: respond,
    ble(value) { connected = value; bleListener(value); },
    fail(value) { failSend = value; },
    advance(ms) { now += ms; for (const [id, value] of [...timers]) if (value.at <= now && timers.delete(id)) value.fn(); },
    connections: () => ({ connects, disconnects }),
    async ready() { const pending = this.state(); this.handshake(); await flush(); this.reply(); await pending; await flush(); },
  };
}

test('adapter is pinned to the installed ZML 0.0.43 package', () => {
  const pkg = JSON.parse(fs.readFileSync(new URL('package.json', packageRoot), 'utf8'));
  assert.equal(pkg.version, '0.0.43');
});

test('stock public requests handshake every time; active session reuses one real port', async () => {
  const stock = fixture({ adapted: false });
  await stock.ready(); const second = stock.state(); assert.equal(stock.shakes(), 2);
  stock.handshake(); await flush(); stock.reply(); await second;
  const w = fixture(); await w.ready();
  for (let i = 0; i < 3; i++) {
    const pending = w.command(); await flush(); w.reply({ ok: true }); assert.equal((await pending).ok, true);
  }
  assert.equal(w.shakes(), 1); assert.equal(w.mutations().length, 3);
  assert.ok(w.session.snapshot().validated); assert.deepEqual(w.connections(), { connects: 1, disconnects: 0 });
  await flush(); assert.equal(w.appEvents.size, 0); assert.equal(w.timers.size, 0);
});

test('a handshake alone cannot authorize a mutation before a successful state reply', async () => {
  const w = fixture(); const pending = w.command();
  const rejected = assert.rejects(pending, /Refresh the connection/);
  w.handshake(); await rejected; await flush();
  assert.equal(w.requests().length, 0); assert.equal(w.session.snapshot().validated, false);
  const read = w.state(); await flush(); w.reply(); await read;
  assert.equal(w.shakes(), 1); assert.equal(w.session.snapshot().validated, true);
});

test('sleep after request entry but before its async send cancels a mutation on the wire', async () => {
  const w = fixture(); await w.ready(); const pending = w.command();
  const rejected = assert.rejects(pending, error => error.notSent === true);
  w.session.setAwake(false); await rejected; await flush();
  assert.equal(w.mutations().length, 0); assert.equal(w.transport.handlers.size, 0); assert.equal(w.timers.size, 0);
  w.session.setAwake(true); const read = w.state(); assert.equal(w.shakes(), 2);
  w.handshake(88); await flush(); w.reply(); await read;
  assert.equal(w.reads().at(-1).port, 88); assert.equal(w.mutations().length, 0);
});

test('sleep during handshake blocks old data even when wake precedes its late reply', async () => {
  const w = fixture(); const old = w.state(); const rejected = assert.rejects(old, /screen is off/);
  w.session.setAwake(false); w.session.setAwake(true); await rejected;
  await assert.rejects(w.state(), /resetting/); assert.equal(w.shakes(), 1);
  w.handshake(); await flush(); assert.equal(w.requests().length, 0); assert.equal(w.session.snapshot().ready, false);
  const fresh = w.state(); assert.equal(w.shakes(), 2); w.handshake(88); await flush(); w.reply(); await fresh;
  assert.equal(w.reads().length, 1); assert.equal(w.reads()[0].port, 88);
});

test('dispose keeps old handshake sends blocked and a reopened page can attach safely', async () => {
  const w = fixture(); const old = w.state(); const rejected = assert.rejects(old, /closed/);
  w.session.dispose(); await rejected; w.handshake(); await flush();
  assert.equal(w.requests().length, 0); assert.deepEqual(w.connections(), { connects: 1, disconnects: 0 });
  assert.equal(createMessagingSession(w.page.messaging), w.session);
  await w.ready(); assert.equal(w.reads().length, 1); assert.equal(w.shakes(), 2);
});

test('BLE loss rejects a sent mutation despite ZML Map cleanup bug, without replay', async () => {
  const w = fixture(); await w.ready(); const pending = w.command(); await flush();
  const id = w.mutations()[0].traceId; const rejected = assert.rejects(pending, error => error.sessionSent === true);
  w.ble(false); await rejected; await flush();
  assert.equal(w.transport.handlers.size, 0); assert.equal(w.timers.size, 0);
  assert.doesNotThrow(() => w.reply({ ok: true }, id));
  w.ble(true); await w.ready(); assert.equal(w.mutations().length, 1); assert.equal(w.shakes(), 2);
});

test('phone service close invalidates port; next state reconnects without replaying the command', async () => {
  const w = fixture(); await w.ready(); const pending = w.command(); await flush();
  const rejected = assert.rejects(pending, error => error.sessionSent === true);
  w.close(); await rejected; await flush(); assert.equal(w.transport.appSidePort, 0);
  assert.doesNotThrow(() => w.reply({ ok: true }, w.mutations()[0].traceId));
  await w.ready(); assert.equal(w.mutations().length, 1); assert.equal(w.shakes(), 2);
});

test('timeout drops the ready session and ignores a late response without resending', async () => {
  const w = fixture(); await w.ready(); const pending = w.command(); await flush();
  const rejected = assert.rejects(pending, /timeout/); w.advance(100); await rejected; await flush();
  assert.equal(w.session.snapshot().validated, false); assert.equal(w.transport.handlers.size, 0); assert.equal(w.timers.size, 0);
  assert.doesNotThrow(() => w.reply({ ok: true }, w.mutations()[0].traceId));
  await w.ready(); assert.equal(w.shakes(), 2); assert.equal(w.mutations().length, 1);
});

test('synchronous native send failure cleans request handlers and timers, without retry', async () => {
  const w = fixture(); await w.ready(); w.fail(true);
  await assert.rejects(w.command(), error => error.sessionSent === true && /send message error/.test(error.message));
  await flush(); assert.equal(w.transport.handlers.size, 0); assert.equal(w.timers.size, 0);
  w.fail(false); await w.ready(); assert.equal(w.shakes(), 2); assert.equal(w.mutations().length, 0);
});

test('synchronous handshake send failure settles and cleans its original deferred', async () => {
  const w = fixture(); w.fail(true);
  await assert.rejects(w.state(), /failed|send message/); await flush();
  assert.equal(w.timers.size, 0); assert.equal(w.requests().length, 0);
  w.fail(false); await w.ready(); assert.equal(w.shakes(), 1);
});

test('unsolicited changed port invalidates cache; duplicate same-port handshake is harmless', async () => {
  const w = fixture(); await w.ready(); w.handshake(); assert.equal(w.session.snapshot().validated, true);
  w.handshake(99); assert.equal(w.session.snapshot().validated, false); assert.equal(w.transport.appSidePort, 77);
  await assert.rejects(w.command(), /Refresh the connection/);
  const pending = w.state(); w.handshake(99); await flush(); w.reply(); await pending;
  assert.equal(w.shakes(), 2); assert.equal(w.reads().at(-1).port, 99); assert.equal(w.mutations().length, 0);
});

test('changed or cleared native port cannot reuse a previously validated session', async () => {
  for (const port of [0, 91]) {
    const w = fixture(); await w.ready(); w.transport.appSidePort = port;
    await assert.rejects(w.command(), /Refresh the connection/);
    const pending = w.state(); w.handshake(88); await flush(); w.reply(); await pending;
    assert.equal(w.shakes(), 2); assert.deepEqual(w.shakePorts(), [0, 0]);
    assert.equal(w.reads().at(-1).port, 88); assert.equal(w.mutations().length, 0);
  }
});

test('unsuccessful state response cannot validate a port for subsequent mutations', async () => {
  const w = fixture(); const read = w.state(); w.handshake(); await flush();
  w.reply({ ok: false, error: 'Unavailable' }); assert.equal((await read).ok, false);
  await assert.rejects(w.command(), /Refresh the connection/); assert.equal(w.mutations().length, 0);
});

test('late response for an unknown request is ignored by actual packet parser', async () => {
  const w = fixture(); await w.ready();
  assert.doesNotThrow(() => w.reply({ ok: true }, 123456));
  assert.equal(w.transport.sessionMgr.sessions.size, 0);
});

test('unsupported transport shapes fall back without changing messaging methods', () => {
  const request = () => Promise.resolve('original');
  const messaging = { request, transport: { request } };
  const session = createMessagingSession(messaging);
  assert.equal(session.supported, false); session.setAwake(false); session.invalidate(); session.dispose();
  assert.equal(messaging.request, request); assert.equal(messaging.transport.request, request);
});


test('late timed-out discovery cannot enable commands without a fresh state round trip', async () => {
  const w = fixture(); const first = w.state(); const rejected = assert.rejects(first, /failed|timeout/);
  w.advance(5000); await rejected; await flush();
  w.handshake(66); assert.equal(w.transport.appSidePort, 0); // No pending discovery: ignored.
  const next = w.state(); w.handshake(66); await flush(); // Wire protocol cannot distinguish this old response.
  assert.equal(w.reads().at(-1).port, 66);
  await assert.rejects(w.command(), /Refresh the connection/);
  const noReply = assert.rejects(next, /timeout/); w.advance(100); await noReply; await flush();
  assert.equal(w.mutations().length, 0); assert.equal(w.session.snapshot().validated, false);
  await w.ready(); assert.equal(w.shakes(), 3); assert.deepEqual(w.shakePorts(), [0, 0, 0]);
});

test('dispose after a sent mutation reports unknown delivery and never replays on reopen', async () => {
  const w = fixture(); await w.ready(); const pending = w.command(); await flush();
  const rejected = assert.rejects(pending, error => error.sessionSent === true);
  w.session.dispose(); await rejected; await flush();
  assert.doesNotThrow(() => w.reply({ ok: true }, w.mutations()[0].traceId));
  createMessagingSession(w.page.messaging); await w.ready();
  assert.equal(w.mutations().length, 1); assert.equal(w.transport.handlers.size, 0);
});


test('a request while BLE is already off leaves no handshake timer and reconnects on the next read', async () => {
  const w = fixture(); w.ble(false);
  await assert.rejects(w.state(), /failed|disconnect/); await flush();
  assert.equal(w.timers.size, 0); assert.equal(w.requests().length, 0); assert.equal(w.shakes(), 0);
  w.ble(true); await w.ready(); assert.equal(w.shakes(), 1); assert.equal(w.session.snapshot().validated, true);
});

test('three rapid requests reuse one handshake and correlate responses arriving out of order', async () => {
  const w = fixture(); await w.ready();
  const first = w.command(), second = w.command(), third = w.command(); await flush();
  const ids = w.mutations().map(request => request.traceId);
  assert.equal(ids.length, 3); assert.equal(w.shakes(), 1);
  w.reply({ ok: true, label: 'second' }, ids[1]); w.reply({ ok: true, label: 'first' }, ids[0]); w.reply({ ok: true, label: 'third' }, ids[2]);
  assert.equal((await first).label, 'first'); assert.equal((await second).label, 'second'); assert.equal((await third).label, 'third');
  await flush(); assert.equal(w.transport.handlers.size, 0); assert.equal(w.timers.size, 0);
});

test('cancel navigation uses a ready session without another handshake and cannot run after sleep', async () => {
  const w = fixture(); await w.ready();
  w.session.cancelNavigation('nav-session'); assert.equal(w.shakes(), 1);
  w.session.setAwake(false); w.session.cancelNavigation('nav-session'); assert.equal(w.shakes(), 1);
  assert.equal(w.mutations().length, 0);
});
