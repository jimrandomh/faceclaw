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
  const messages = [], timers = new Set(), holds = [], maps = [], errors = [];
  let callbacks, compass, delayRoute = null;
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
    './destinations': { findSavedDestinationByName: () => null, rememberRecentDestination() {} },
    '../compass/calibration': { calibrateHeading: value => value + 5, normalizeHeading: value => (value + 360) % 360 },
    '../../native/frame-timings': { startFrame: () => 1, finishFrame() {}, span: (_id, _name, fn) => fn(), runWithFrame: (_id, fn) => fn() },
    '../../native/active-display': { getActiveDisplay: () => null },
    '../../ui/window-menu': { WindowMenu: class { paint() { return []; } } },
    '../../graphics/plane': { planesFingerprint: () => 'frame' },
    '../../native/mapbox': {
      isMapboxConfigured: () => true,
      geocodeForward: async () => [{ name: 'Test park', placeFormatted: 'San Francisco', latitude: 37.71, longitude: -122.4 }],
      fetchRoute: async () => delayRoute ? await delayRoute : route,
      fetchStaticMapGray: async options => { maps.push(options); return { pixels: new Uint8Array([0, 128, 255]) }; },
    },
  };
  const global = { postMessage: message => messages.push(message) };
  const source = fs.readFileSync(path.join(__dirname, '../app/apps/navigate/navigate-app.worker.ts'), 'utf8') +
    '\nexports.probe = { startNavigation, stopNavigation, state: () => ({ phase, headHeadingDeg, progress }) };';
  const exports = {};
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText, {
    exports, global, Uint8Array, setTimeout, clearTimeout,
    setInterval: fn => { timers.add(fn); return fn; }, clearInterval: fn => timers.delete(fn),
    console: { log() {}, warn() {}, error: error => errors.push(error) }, require: id => modules[id] ?? {},
  });
  const send = data => global.onmessage({ data });
  send({ type: 'open-window', windowId: 'navigate:main', surfaceId: 'window:navigate:main', title: 'Navigate', viewport: { width: 576, height: 480 } });
  send({ type: 'foreground', windowId: 'navigate:main', foreground: true, focused: true });
  return { ...exports.probe, send, timers, holds, maps, errors, tracker,
    fix: latitude => send({ type: 'navigation-sensors', event: { kind: 'location', location: fix(latitude), id: 1 } }),
    heading: value => compass?.({ command: 15, headingDegrees: value }),
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
