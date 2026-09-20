const test = require('node:test');
const assert = require('node:assert/strict');
const { loader } = require('./helpers/load-typescript.cjs');
const flush = () => new Promise(resolve => setImmediate(resolve));

function nativeLocation() {
  const instances = [];
  const FaceclawLocationUpdates = { new() {
    const value = { stopped: 0, startOnce() { this.once = true; }, startTracking(ms) { this.interval = ms; },
      stop() { this.stopped++; this.eventHandler = null; } };
    instances.push(value); return value;
  } };
  return { instances, load: loader({ FaceclawLocationUpdates }) };
}
const fix = { latitude: 37.7, longitude: -122.4, accuracyMeters: 8, bearingDeg: null, speedMps: null, timestampMs: 1234 };

test('iOS one-shot location resolves a fix, rejects native errors, and releases each provider', async () => {
  const h = nativeLocation(), api = h.load('app/native/location.ios.ts');
  const result = api.getCurrentLocation(), native = h.instances[0];
  assert.equal(native.once, true);
  native.eventHandler(JSON.stringify(fix));
  assert.deepEqual({ ...await result }, fix); assert.ok(native.stopped);
  const denied = api.getCurrentLocation();
  h.instances[1].eventHandler(JSON.stringify({ error: 'Permission denied' }));
  await assert.rejects(denied, /Permission denied/);
  assert.ok(h.instances[1].stopped);
});

test('iOS tracking preserves unavailable course/speed and ignores callbacks after stop or restart', () => {
  const h = nativeLocation(), api = h.load('app/native/location-tracker.ios.ts'), fixes = [], errors = [];
  const tracker = new api.LocationTracker({ onLocation: fix => fixes.push(fix), onError: error => errors.push(error) });
  tracker.start(1000); tracker.start(1000);
  assert.equal(h.instances.length, 1); assert.equal(h.instances[0].interval, 1000);
  const old = h.instances[0].eventHandler;
  old(JSON.stringify(fix)); tracker.stop(); old(JSON.stringify(fix)); tracker.start(); old(JSON.stringify(fix));
  assert.equal(fixes.length, 1); assert.equal(fixes[0].bearingDeg, null);
  h.instances[1].eventHandler(JSON.stringify({ error: 'Location disabled' }));
  assert.equal(tracker.isRunning(), false); assert.deepEqual(errors, ['Location disabled']);
});

test('Navigate worker routes sensor callbacks by stream id and receives true-north correction', () => {
  const messages = [], fixes = [], headings = [];
  const api = loader({ global: { postMessage: message => messages.push(message) } })('app/apps/navigate/navigation-sensors.ios.ts');
  const tracker = new api.LocationTracker({ onLocation: fix => fixes.push(fix), onError() {} });
  tracker.start(); const first = messages.at(-1).request.id;
  tracker.stop(); tracker.start(); const second = messages.at(-1).request.id;
  api.handleNavigationSensorEvent({ kind: 'location', id: first, location: fix });
  api.handleNavigationSensorEvent({ kind: 'location', id: second, location: fix });
  assert.equal(fixes.length, 1);
  const off = api.addCompassListener(event => headings.push(event));
  api.handleNavigationSensorEvent({ kind: 'compass', event: { command: 15, headingDegrees: 123 }, declination: 12 });
  assert.equal(api.magneticDeclinationDegrees(37.7, -122.4), 12);
  off(); api.handleNavigationSensorEvent({ kind: 'compass', event: {}, declination: null });
  assert.equal(headings.length, 1); tracker.stop();
});

function sensorHost() {
  const pending = [], trackers = [], holds = [], replies = [];
  let compass;
  class Tracker {
    constructor(callbacks) { this.callbacks = callbacks; trackers.push(this); }
    start() { this.started = true; }
    stop() { this.stopped = true; }
  }
  const api = loader({}, {
    './location-tracker.ios': { LocationTracker: Tracker },
    './location-permissions.ios': { ensureFineLocationPermission: () => new Promise(resolve => pending.push(resolve)) },
    './compass.ios': { setCompassEnabled: (on, owner) => holds.push([on, owner]),
      addCompassListener: fn => { compass = fn; return () => { compass = null; }; } },
    '../apps/compass/declination': { refreshDeclination() {}, getDeclinationDegrees: () => 12.5 },
  })('app/native/ios-navigation-sensors.ts');
  return { host: new api.IosNavigationSensors(event => replies.push(event)), pending, trackers, holds, replies,
    heading: () => compass?.({ command: 15, headingDegrees: 90 }) };
}
test('closing Navigate while precise permission is pending cannot start GPS later', async () => {
  const h = sensorHost(); h.host.handle({ action: 'start', id: 1, intervalMs: 1000 });
  h.host.stop(); h.pending.shift()(true); await flush();
  assert.equal(h.trackers.length, 0); assert.equal(h.replies.length, 0);
  h.host.handle({ action: 'start', id: 2, intervalMs: 1000 }); h.pending.shift()(false); await flush();
  assert.equal(h.replies[0].kind, 'error'); assert.equal(h.replies[0].id, 2);
});
test('Navigate host releases GPS and compass together and ignores an old stream error', async () => {
  const h = sensorHost(); h.host.handle({ action: 'start', id: 1, intervalMs: 1000 });
  h.pending.shift()(true); await flush();
  h.host.handle({ action: 'compass', enabled: true }); h.heading();
  assert.equal(h.replies[0].declination, 12.5);
  h.trackers[0].callbacks.onLocation(fix); assert.equal(h.replies[1].kind, 'location');
  h.host.stop(); h.trackers[0].callbacks.onError('late error'); h.heading();
  assert.equal(h.replies.length, 2); assert.equal(h.trackers[0].stopped, true);
  assert.deepEqual(h.holds.at(-1), [false, 'worker:navigate']);
});

test('Weather uses the portable location provider and preserves NWS parsing', async () => {
  const requests = [], timers = new Set(); let permission = true;
  const period = { name: 'Today', temperature: 70, temperatureUnit: 'F', shortForecast: 'Sunny', windSpeed: '5 mph', windDirection: 'W' };
  const api = loader({ setTimeout, clearTimeout, setInterval: fn => { timers.add(fn); return fn; }, clearInterval: fn => timers.delete(fn) }, {
    './location-permissions': { hasLocationPermission: () => permission },
    './location': { getCurrentLocation: async () => fix },
    '../version': { USER_AGENT: 'test' },
    '../util/http': { fetchWithUserAgent: async url => { requests.push(url); return { ok: true, json: async () =>
      url.includes('/points/') ? { properties: { forecast: 'https://fixture/forecast', relativeLocation: { properties: { city: 'San Francisco', state: 'CA' } } } }
        : { properties: { periods: [period] } } }; } },
  })('app/native/weather.ts');
  const bridge = new api.WeatherBridge(); bridge.start(); await bridge.refreshNow();
  assert.equal(bridge.snapshot().phase, 'ready'); assert.equal(bridge.snapshot().current.temperatureF, 70);
  assert.equal(bridge.snapshot().locationName, 'San Francisco, CA');
  assert.match(requests[0], /37\.7000,-122\.4000/);
  bridge.stop(); assert.equal(timers.size, 0);
  permission = false; await bridge.refreshNow(); assert.equal(bridge.snapshot().phase, 'permission-required');
});

test('closing Weather during permission prompt cannot restart polling', async () => {
  let granted, options, starts = 0, stops = 0;
  const api = loader({}, {
    '../../native/location-permissions': { hasLocationPermission: () => false, ensureLocationPermission: () => new Promise(resolve => { granted = resolve; }) },
    '../../native/weather': { weatherBridge: { start() { starts++; }, stop() { stops++; }, onStateChange: () => () => {}, snapshot() {} } },
    './weather': { WeatherLayer: class {} },
    '../../ui/shell/in-process-window': { YieldAtRootLayer: class {}, createInProcessWindow: opts => { options = opts; return { requestRender() {} }; } },
  })('app/apps/weather/weather-app.ts');
  api.createWeatherAppWindow({ onClosed() {} }); options.onClosed(); granted(true); await flush();
  assert.equal(starts, 0); assert.equal(stops, 1);
});
