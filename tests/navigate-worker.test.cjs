const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const path = require('node:path');
const { loader } = require('./helpers/load-typescript.cjs');
const flush = () => new Promise(resolve => setImmediate(resolve));

const route = { coordinates: [[-122.4, 37.7], [-122.4, 37.71]], distanceMeters: 1112, durationSec: 600,
  steps: [{ distanceMeters: 1112, durationSec: 600, instruction: 'Head north', maneuverType: 'depart' },
    { distanceMeters: 0, durationSec: 0, instruction: 'Arrive', maneuverType: 'arrive' }] };
const fix = latitude => ({ latitude, longitude: -122.4, timestampMs: Date.now(), bearingDeg: 0, speedMps: 1.5, accuracyMeters: 5 });
function fixture() {
  const messages = [], timers = new Set(), timeouts = new Set(), holds = [], maps = [], errors = [], requests = [];
  let callbacks, compass, delayRoute = null, delayMap = null, routeError = null;
  const routeMath = loader()('app/apps/navigate/route-follower.ts');
  const tracker = { running: false, isRunning() { return this.running; }, start() { this.running = true; }, stop() { this.running = false; } };
  const sensor = { LocationTracker: function (value) { callbacks = value; return tracker; }, COMPASS_CHANGED: 15,
    addCompassListener: fn => { compass = fn; return () => { compass = null; }; },
    setCompassEnabled: value => holds.push(value), magneticDeclinationDegrees: () => 12,
    handleNavigationSensorEvent: event => { if (event.kind === 'location') callbacks.onLocation(event.location); } };
  const modules = {
    '@nativescript/core/globals': {},
    '../../graphics/bdffont': { getFont: () => ({}) }, '../../graphics/ui-fonts': { getDefaultSmallFont: () => ({}) },
    '../../native/settings-store': { onSettingsStoreChanged() {} },
    './navigation-sensors': sensor,
    './route-follower': routeMath,
    './destinations': { findSavedDestinationByName: () => null, rememberRecentDestination() {},
      loadSavedDestinations: () => [{ name: 'Home', address: '123 Main St' }], loadRecentDestinations: () => [] },
    '../compass/calibration': { calibrateHeading: value => value + 5, normalizeHeading: value => (value + 360) % 360 },
    '../../native/frame-timings': { startFrame: () => 1, finishFrame() {}, logFrame() {}, span: (_id, _name, fn) => fn(), runWithFrame: (_id, fn) => fn() },
    '../../native/active-display': { getActiveDisplay: () => null },
    '../../ui/window-menu': { WindowMenu: class { paint() { return []; } isOpen() { return false; } resize() {} } },
    '../../graphics/plane': { planesFingerprint: () => 'frame' },
    '../../native/mapbox': {
      isMapboxConfigured: () => true,
      geocodeForward: async () => { requests.push('geocode'); return [{ name: 'Test park', placeFormatted: 'San Francisco', latitude: 37.71, longitude: -122.4 }]; },
      fetchRoute: async () => { requests.push('route'); if (routeError) throw routeError; return delayRoute ? await delayRoute : route; },
      fetchStaticMapGray: async options => { maps.push(options); return delayMap ? await delayMap : { pixels: new Uint8Array([0, 128, 255]) }; },
    },
  };
  const global = { postMessage: message => messages.push(message) };
  const source = fs.readFileSync(path.join(__dirname, '../app/apps/navigate/navigate-app.worker.ts'), 'utf8') +
    '\nexports.probe = { startNavigation, startMap, stopNavigation, idleEntries, describeRouteStatus, state: () => ({ phase, headHeadingDeg, progress, mapImage, mapInFlight, mapLastError }) };';
  const exports = {};
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText, {
    exports, global, Uint8Array,
    setTimeout: fn => { timeouts.add(fn); return fn; }, clearTimeout: fn => timeouts.delete(fn),
    setInterval: fn => { timers.add(fn); return fn; }, clearInterval: fn => timers.delete(fn),
    console: { log() {}, warn() {}, error: error => errors.push(error) }, require: id => modules[id] ?? {},
  });
  const send = data => global.onmessage({ data });
  send({ type: 'open-window', windowId: 'navigate:main', surfaceId: 'window:navigate:main', title: 'Navigate', viewport: { width: 576, height: 480 } });
  send({ type: 'foreground', windowId: 'navigate:main', foreground: true, focused: true });
  return { ...exports.probe, send, timers, holds, maps, errors, tracker, requests,
    input: type => send({ type: 'input', windowId: 'navigate:main', focused: true, frameId: 1, event: { type } }),
    tick: () => { for (const callback of timers) callback(); },
    expireFix: () => { for (const callback of timeouts) callback(); timeouts.clear(); },
    failRoute: () => { routeError = new Error('Route unavailable'); },
    fix: latitude => send({ type: 'navigation-sensors', event: { kind: 'location', location: fix(latitude), id: 1 } }),
    heading: value => compass?.({ command: 15, headingDegrees: value }),
    holdMap: () => { let resolve, reject; delayMap = new Promise((done, fail) => { resolve = done; reject = fail; });
      return { resolve: () => resolve({ pixels: new Uint8Array([0, 128, 255]) }), reject }; },
    holdRoute: () => { let resolve; delayRoute = new Promise(done => { resolve = done; }); return () => resolve(route); } };
}

test('shared Navigate worker follows streamed GPS, uses calibrated true heading and stops at arrival', async () => {
  const h = fixture(); const starting = h.startNavigation('Test park', 'walking');
  h.fix(37.7); assert.match(await starting, /Navigating to Test park/); await flush();
  assert.equal(h.state().phase, 'navigating'); assert.ok(h.maps.length > 0);
  h.heading(90); assert.equal(h.state().headHeadingDeg, 107);
  h.send({ type: 'screen', on: false }); assert.equal(h.holds.at(-1), false); assert.equal(h.tracker.running, true);
  h.fix(37.705); assert.ok(h.state().progress.remainingMeters < 600);
  h.fix(37.71); assert.equal(h.state().phase, 'arrived'); assert.equal(h.tracker.running, false);
  assert.equal(h.timers.size, 0); assert.deepEqual(h.errors, []);
});

test('closing Navigate while a route request is pending cannot restart guidance or GPS', async () => {
  const h = fixture(), release = h.holdRoute();
  const starting = h.startNavigation('Test park', 'walking');
  h.fix(37.7); await flush(); assert.equal(h.state().phase, 'routing');
  h.send({ type: 'close-window', windowId: 'navigate:main' }); release();
  await assert.rejects(starting, /Navigation cancelled/);
  assert.equal(h.state().phase, 'idle'); assert.equal(h.tracker.running, false); assert.equal(h.timers.size, 0);
});

test('front page map entry follows location without routing, supports zoom and returns to destinations', async () => {
  const h = fixture();
  assert.equal(h.idleEntries()[0].label, 'Map around me');
  assert.equal(h.idleEntries()[1].destination.name, 'Home');
  h.input('click');
  assert.equal(h.state().phase, 'acquiring');
  assert.equal(h.tracker.running, true);
  h.fix(37.7); await flush();
  assert.equal(h.state().phase, 'map');
  assert.deepEqual(h.requests, []);
  assert.equal(h.maps.at(-1).width, 576);
  assert.equal(h.maps.at(-1).height, 450);
  assert.equal(h.maps.at(-1).routePath, undefined);
  assert.equal(h.maps.at(-1).camera.latitude, 37.7);
  assert.equal(h.maps.at(-1).camera.bearingDeg, 0);
  assert.match(h.describeRouteStatus(), /No destination/);
  h.heading(90); assert.equal(h.state().headHeadingDeg, 107);
  h.fix(37.705); await flush();
  assert.equal(h.maps.at(-1).camera.latitude, 37.705);
  const zoom = h.maps.at(-1).camera.zoom;
  h.input('scroll-up'); await flush();
  assert.equal(h.maps.at(-1).camera.zoom, zoom + 0.5);
  h.input('click');
  assert.equal(h.state().phase, 'idle');
  assert.equal(h.tracker.running, false);
  assert.equal(h.holds.at(-1), false);
  assert.equal(h.timers.size, 0);
  const count = h.maps.length;
  h.send({ type: 'foreground', foreground: true, focused: true });
  assert.equal(h.maps.length, count);
  assert.deepEqual(h.errors, []);
});

test('map suspends fetching and compass while hidden and resizes to the viewport', async () => {
  const h = fixture(), starting = h.startMap();
  h.fix(37.7); await starting; await flush();
  const count = h.maps.length;
  h.send({ type: 'screen', on: false });
  h.fix(37.71); h.tick(); await flush();
  assert.equal(h.maps.length, count);
  assert.equal(h.holds.at(-1), false);
  h.send({ type: 'screen', on: true }); await flush();
  assert.equal(h.maps.at(-1).camera.latitude, 37.71);
  h.send({ type: 'resize-window', windowId: 'navigate:main', viewport: { width: 540, height: 260 } }); await flush();
  assert.equal(h.maps.at(-1).width, 540);
  assert.equal(h.maps.at(-1).height, 230);
  h.send({ type: 'close-window' });
  assert.equal(h.tracker.running, false);
  assert.equal(h.timers.size, 0);
  assert.deepEqual(h.errors, []);
});

test('starting a destination from map mode switches to route guidance', async () => {
  const h = fixture(), starting = h.startMap();
  h.fix(37.7); await starting; await flush();
  await h.startNavigation('Test park', 'walking'); await flush();
  assert.equal(h.state().phase, 'navigating');
  assert.deepEqual(h.requests, ['geocode', 'route']);
  assert.equal(h.maps.at(-1).width, 260);
  assert.ok(h.maps.at(-1).routePath.length >= 2);
  assert.deepEqual(h.errors, []);
});

test('failed destination lookup keeps map mode and tracking active', async () => {
  const h = fixture(), starting = h.startMap();
  h.fix(37.7); await starting; await flush();
  h.failRoute();
  await assert.rejects(h.startNavigation('Test park', 'walking'), /Route unavailable/);
  assert.equal(h.state().phase, 'map');
  assert.equal(h.tracker.running, true);
  h.fix(37.705); await flush();
  assert.equal(h.maps.at(-1).routePath, undefined);
  assert.match(h.describeRouteStatus(), /No destination/);
});

test('map requires a fresh fix and releases tracking when GPS times out', async () => {
  const h = fixture(), starting = h.startMap();
  h.send({ type: 'navigation-sensors', event: { kind: 'location', location: { ...fix(37.7), timestampMs: Date.now() - 120000 } } });
  await flush();
  assert.equal(h.state().phase, 'acquiring');
  assert.equal(h.maps.length, 0);
  h.expireFix(); await starting;
  assert.equal(h.state().phase, 'idle');
  assert.equal(h.tracker.running, false);
  assert.equal(h.timers.size, 0);
});

test('closing map during GPS acquisition cannot reopen it on a late fix', async () => {
  const h = fixture(), starting = h.startMap();
  h.send({ type: 'close-window' });
  h.fix(37.7); h.expireFix(); await starting;
  assert.equal(h.state().phase, 'idle');
  assert.equal(h.tracker.running, false);
  assert.equal(h.maps.length, 0);
  assert.equal(h.timers.size, 0);
});

for (const completion of ['resolve', 'reject']) {
  test(`old map fetch ${completion} cannot overwrite a new mode or clear its pending fetch`, async () => {
    const h = fixture(), oldMap = h.holdMap(), starting = h.startMap();
    h.fix(37.7); await starting;
    h.input('click');
    const newMap = h.holdMap();
    await h.startMap();
    oldMap[completion](new Error('Old map failed')); await flush();
    assert.equal(h.state().mapInFlight, true);
    assert.equal(h.state().mapImage, null);
    assert.equal(h.state().mapLastError, '');
    newMap.resolve(); await flush();
    assert.ok(h.state().mapImage);
    assert.equal(h.state().mapInFlight, false);
  });
}
