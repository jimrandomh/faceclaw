const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const path = require('node:path');
function load(file, context = {}) {
  const sandbox = { exports: {}, console, ...context };
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText, sandbox);
  return sandbox.exports;
}

test('iOS compass owners and listeners work before connection and across session replacement', () => {
  const api = load('app/native/compass.ios.ts', { require: () => ({}) });
  const states = [], nextStates = [], events = [];
  const off = api.addCompassListener(event => events.push(event));
  api.setCompassEnabled(true, 'compass');
  api.setCompassEnabled(true, 'glanceboard');
  api.bindCompassSession({ setCompassEnabled: enabled => states.push(enabled) });
  api.setCompassEnabled(false, 'compass');
  assert.deepEqual(states, [true, true]);
  api.bindCompassSession({ setCompassEnabled: enabled => nextStates.push(enabled) });
  assert.equal(states.at(-1), false);
  api.setCompassEnabled(false, 'glanceboard');
  assert.deepEqual(nextStates, [true, false]);
  api.receiveCompassEvent({ command: 15, headingDegrees: 271 });
  off(); api.receiveCompassEvent({ command: 15, headingDegrees: 90 });
  assert.deepEqual(events, [{ command: 15, headingDegrees: 271 }]);
});

test('shared declination cache handles iOS fixes, persisted corrections and unavailable sensors', async () => {
  const store = new Map(), listeners = [];
  let permission = false, lookups = 0, fail = false;
  let now = 1_800_000_000_000;
  const ios = load('app/native/declination.ios.ts');
  const context = {
    Date: { now: () => now }, console: { warn() {} },
    require: id => ({
      '../../native/location-permissions': { hasLocationPermission: () => permission },
      '../../native/declination': { restoreDeclination: ios.restoreDeclination, getCurrentDeclination: async () => {
        lookups++; if (fail) throw new Error('No heading sensor');
        return { latitude: 37.7, longitude: -122.4, degrees: 12.5 };
      } },
      '../../native/settings-store': { getStringSetting: (key, fallback) => store.get(key) ?? fallback,
        setStringSetting: (key, value) => store.set(key, value) },
    })[id],
  };
  const api = load('app/apps/compass/declination.ts', context);
  api.onDeclinationChanged(() => listeners.push(api.getDeclinationDegrees()));
  assert.equal(api.getDeclinationAvailability(), 'no-permission');
  api.refreshDeclination(); assert.equal(lookups, 0);
  permission = true;
  assert.equal(api.getDeclinationAvailability(), 'no-fix');
  api.refreshDeclination(); api.refreshDeclination();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(lookups, 1); assert.deepEqual(listeners, [12.5]);
  assert.equal(api.getDeclinationAvailability(), 'available');
  const restarted = load('app/apps/compass/declination.ts', context);
  assert.equal(restarted.getDeclinationDegrees(), 12.5);
  restarted.refreshDeclination(); assert.equal(lookups, 1);
  now += 25 * 60 * 60 * 1000; fail = true;
  restarted.refreshDeclination(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(restarted.getDeclinationDegrees(), 12.5);
  restarted.refreshDeclination(); assert.equal(lookups, 2);
  // Existing Android preferences have coordinates but no cached correction.
  store.delete('compass.declination.degrees'); fail = false;
  store.set('compass.declination.locatedAtMs', String(now));
  const migrated = load('app/apps/compass/declination.ts', context);
  assert.equal(migrated.getDeclinationDegrees(), null);
  migrated.refreshDeclination(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(migrated.getDeclinationDegrees(), 12.5);
});

test('iOS native correction callbacks resolve values or propagate unavailable errors', async () => {
  let unavailable = false;
  const api = load('app/native/declination.ios.ts', { FaceclawLocation: { shared: () => ({
    requestDeclination: callback => callback(-8.25, 51, 0, unavailable ? 'Heading unavailable' : ''),
  }) } });
  assert.deepEqual({ ...await api.getCurrentDeclination() }, { latitude: 51, longitude: 0, degrees: -8.25 });
  unavailable = true;
  await assert.rejects(api.getCurrentDeclination(), /Heading unavailable/);
  assert.equal(api.restoreDeclination(0, 0, NaN), null);
  assert.equal(api.restoreDeclination(0, 0, 360), null);
});
