const test = require('node:test');
const assert = require('node:assert/strict');
const { loader } = require('./helpers/load-typescript.cjs');

// The developer demos' sensor plumbing on iOS: FaceclawCommunicatorBridge over a
// fake IosGlassesSession, and the imu/ambient-light/audio-monitor/mic-control-link
// .ios.ts modules over that bridge.
function harness() {
  const calls = [];
  const listeners = { imu: new Set(), light: new Set(), status: new Set(), audio: new Set() };
  // Like the Kotlin facade, the NSData add* methods return an adapter handle for remove*.
  const handleFor = (set, proxy) => { const handle = { proxy }; set.add(handle); return handle; };
  const session = {
    setRequiredFirmwareRevisionRevision() {}, setListenerListener() {}, setPreviewAnimationListenerListener() {},
    start() { calls.push(['start']); return true; },
    close() { calls.push(['close']); },
    setImuReportEnabledEnableReportFrq(enable, freq) { calls.push(['imu', enable, freq]); },
    addImuListenerListener(proxy) { listeners.imu.add(proxy); },
    removeImuListenerListener(proxy) { listeners.imu.delete(proxy); },
    queryAmbientLight() { calls.push(['als-query']); },
    setAmbientLightPollingEnableIntervalMsMinDeltaHeartbeatMsBindToLease(...args) { calls.push(['als-poll', ...args]); },
    addAmbientLightListenerNsDataListener: proxy => handleFor(listeners.light, proxy),
    removeAmbientLightListenerListener(handle) { listeners.light.delete(handle); },
    addMicStatusListenerNsDataListener: proxy => handleFor(listeners.status, proxy),
    removeMicStatusListenerListener(handle) { listeners.status.delete(handle); },
    addAudioMonitorListenerNsDataListener: proxy => handleFor(listeners.audio, proxy),
    removeAudioMonitorListenerListener(handle) { listeners.audio.delete(handle); },
    isAudioCaptureActive: () => true,
    sendFaceclawMicControlRecordLabelRightTempleLeftTemple(record, label, right, left) {
      calls.push(['mic-control', Array.from(record), label, right, left]);
      return label !== 'refused';
    },
  };
  class NSObject { static new() { return new this(); } }
  const load = loader({
    NSObject, NativeClass: () => cls => cls, setTimeout, clearTimeout,
    FaceclawKitIosGlassesSession: { alloc: () => ({ initWithRightAddressLeftAddressRingAddress: () => session }) },
    FaceclawKitFaceclawBleCommunicatorListener: {}, FaceclawKitIosAncsListener: {}, FaceclawKitIosAudioPacketListener: {},
    FaceclawKitFaceclawCompassListener: {}, FaceclawKitFaceclawImuListener: {}, FaceclawKitIosAmbientLightListener: {},
    FaceclawKitIosMicStatusListener: {}, console: { log() {}, warn() {} },
  }, {
    '@nativescript/core': { File: {}, knownFolders: {}, path: {} },
    '../g2/firmware-compat': { REQUIRED_FACECLAW_FIRMWARE_VERSION: 37 },
    // NSData stands in as the bytes themselves.
    './kotlin-data': { toData: bytes => bytes, fromData: data => new Uint8Array(data) },
    './ios-graphics': { previewPixels() {} },
    './ios-bluetooth': { iosBluetooth: {} },
  });
  const bridgeModule = load('app/native/faceclaw-communicator.ios.ts');
  return { load, session, calls, listeners, FaceclawCommunicatorBridge: bridgeModule.FaceclawCommunicatorBridge };
}

function alsRecord(alsValue) {
  const body = new Uint8Array(24);
  body.set([0x41, 0x4c, 1, 2, 0x0b]);
  body[6] = alsValue & 0xff; body[7] = alsValue >> 8;
  return body;
}

test('the bridge is the active session from start() until close()', async () => {
  const h = harness();
  const bridge = new h.FaceclawCommunicatorBridge({ right: 'r', left: 'l' });
  assert.equal(h.FaceclawCommunicatorBridge.getActive(), null, 'not before start');
  await bridge.start();
  assert.equal(h.FaceclawCommunicatorBridge.getActive(), bridge);
  const closing = bridge.close();
  assert.equal(h.FaceclawCommunicatorBridge.getActive(), null, 'cleared as soon as close() is called');
  await closing;
  assert.deepEqual(h.calls, [['start'], ['close']]);
});

test('a start queued behind close() does not make a closed bridge active', async () => {
  const h = harness();
  const bridge = new h.FaceclawCommunicatorBridge({ right: 'r', left: 'l' });
  const started = bridge.start();
  const closed = bridge.close();
  await Promise.all([started, closed]);
  assert.equal(h.FaceclawCommunicatorBridge.getActive(), null);
});

test('the sensor modules are no-ops without a running session', () => {
  const h = harness();
  const imu = h.load('app/native/imu.ios.ts');
  const light = h.load('app/native/ambient-light.ios.ts');
  const monitor = h.load('app/native/audio-monitor.ios.ts');
  imu.setImuReportEnabled(true, 200);
  light.setAmbientLightPolling(true);
  light.queryAmbientLight();
  imu.addImuListener(() => assert.fail('no session'))();
  light.addAmbientLightListener(() => assert.fail('no session'))();
  assert.equal(monitor.audioMonitorCommunicator(), null);
  assert.equal(monitor.isFaceclawAudioCaptureActive(), false);
  monitor.addAudioMonitorListeners(null, () => {}, () => {})();
  assert.deepEqual(h.calls, []);
});

test('IMU control and samples go through the active session', async () => {
  const h = harness();
  const bridge = new h.FaceclawCommunicatorBridge({ right: 'r', left: 'l' });
  await bridge.start();
  const imu = h.load('app/native/imu.ios.ts');
  imu.setImuReportEnabled(true, 199.6);
  imu.setImuReportEnabled(false, -5);
  const readings = [];
  const off = imu.addImuListener(reading => readings.push({ ...reading }));
  const [proxy] = h.listeners.imu;
  proxy.onImuDataXYZEventSource(0.5, -1, 9.75, 3);
  off();
  assert.equal(h.listeners.imu.size, 0);
  assert.deepEqual(readings, [{ x: 0.5, y: -1, z: 9.75, source: 3 }]);
  assert.equal(imu.imuSourceLabel(3), 'L arm');
  assert.deepEqual(h.calls.slice(1), [['imu', true, 200], ['imu', false, 0]]);
});

test('ambient light: defaults, query, and decoded reports over NSData', async () => {
  const h = harness();
  const bridge = new h.FaceclawCommunicatorBridge({ right: 'r', left: 'l' });
  await bridge.start();
  const light = h.load('app/native/ambient-light.ios.ts');
  light.setAmbientLightPolling(true, { intervalMs: 250, minDelta: 0, heartbeatMs: 1000, bindToLease: true });
  light.setAmbientLightPolling(false);
  light.queryAmbientLight();
  assert.deepEqual(h.calls.slice(1), [
    ['als-poll', true, 250, 0, 1000, true],
    ['als-poll', false, 500, 1, 5000, true],
    ['als-query'],
  ]);
  const reports = [];
  const off = light.addAmbientLightListener(report => reports.push(report));
  const [handle] = h.listeners.light;
  handle.proxy.onNsDataAmbientLightBody(alsRecord(1234));
  handle.proxy.onNsDataAmbientLightBody(new Uint8Array([1, 2, 3])); // not a report: dropped
  off();
  assert.equal(h.listeners.light.size, 0, 'removed by the handle the session returned');
  assert.equal(reports.length, 1);
  assert.equal(reports[0].alsValue, 1234);
  assert.equal(reports[0].reason, 'poll');
  assert.equal(reports[0].opened, true);
  assert.equal(reports[0].passive, true);
  assert.equal(reports[0].readOk, true);
});

test('the passive audio monitor sees packets and mic status per temple', async () => {
  const h = harness();
  const bridge = new h.FaceclawCommunicatorBridge({ right: 'r', left: 'l' });
  await bridge.start();
  const monitor = h.load('app/native/audio-monitor.ios.ts');
  const communicator = monitor.audioMonitorCommunicator();
  assert.equal(communicator, bridge);
  assert.equal(monitor.isFaceclawAudioCaptureActive(), true);
  const packets = [], statuses = [];
  const off = monitor.addAudioMonitorListeners(communicator,
    (data, arm, arrivalMs) => packets.push([Array.from(data), arm, arrivalMs]),
    (body, arm) => statuses.push([Array.from(body), arm]));
  const [audio] = h.listeners.audio, [status] = h.listeners.status;
  audio.proxy.onNsDataAudioPacketDataArmArrivalMs(new Uint8Array([1, 2]), 'L', 42);
  audio.proxy.onNsDataAudioPacketDataArmArrivalMs(new Uint8Array([3]), '', 43);
  status.proxy.onNsDataMicStatusBodyArm(new Uint8Array([0x4d, 0x43]), 'R');
  off();
  assert.equal(h.listeners.audio.size + h.listeners.status.size, 0);
  assert.deepEqual(packets, [[[1, 2], 'L', 42], [[3], '?', 43]]);
  assert.deepEqual(statuses, [[[0x4d, 0x43], 'R']]);
  assert.deepEqual(h.calls, [['start']], 'monitoring sends nothing');
});

test('mic-control link sends records and hears status on iOS', async () => {
  const h = harness();
  const link = h.load('app/native/mic-control-link.ios.ts');
  assert.equal(link.micControlSession(), null);
  const bridge = new h.FaceclawCommunicatorBridge({ right: 'r', left: 'l' });
  await bridge.start();
  const session = link.micControlSession();
  assert.equal(session, bridge);
  assert.equal(link.sendMicControlRecord(session, new Uint8Array([0x4d, 0x43, 1, 4]), 'query', true, true), true);
  assert.equal(link.sendMicControlRecord(session, new Uint8Array([0x4d, 0x43, 1, 4]), 'refused', true, false), false);
  const heard = [];
  const off = link.addMicStatusListener(session, (body, arm) => heard.push([Array.from(body), arm]));
  [...h.listeners.status][0].proxy.onNsDataMicStatusBodyArm(new Uint8Array([7]), 'L');
  off();
  assert.equal(h.listeners.status.size, 0);
  assert.deepEqual(heard, [[[7], 'L']]);
  assert.deepEqual(h.calls.slice(1), [
    ['mic-control', [0x4d, 0x43, 1, 4], 'query', true, true],
    ['mic-control', [0x4d, 0x43, 1, 4], 'refused', true, false],
  ]);
});
