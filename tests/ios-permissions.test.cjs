const test = require('node:test');
const assert = require('node:assert/strict');
const { loader } = require('./helpers/load-typescript.cjs');

const NOT_DETERMINED = 0, DENIED = 2, ALLOWED = 3;
const STATE_UNAUTHORIZED = 3, STATE_POWERED_ON = 5;

/**
 * The Permissions page and the real scan layer over a fake Kotlin central. As in
 * IosBleCentral, registering the scan listener is what creates the CBCentralManager, so
 * `registrations` counting up from 0 is the moment iOS would show its permission prompt.
 */
function harness({ authorization = NOT_DETERMINED, onboarding = true } = {}) {
  const central = {
    authorizationValue: authorization,
    listener: null,
    registrations: 0,
    authorization() { return this.authorizationValue; },
    setScanListenerListener(listener) { this.registrations++; this.listener = listener; },
    // CoreBluetooth answering: the state arrives some time after the central is created.
    report(state, value) {
      this.authorizationValue = value;
      this.listener.onBluetoothStateStateAuthorization(state, value);
    },
  };
  const alerts = [];
  const timers = [];
  const appListeners = new Set();
  const load = loader({
    global: { isIOS: true },
    setTimeout: (fn, delay) => { timers.push({ fn, delay }); return timers.length; },
    clearTimeout: id => { timers[id - 1].cleared = true; },
    FaceclawKitIosBleCentral: { alloc: () => ({ initWithPlatform: () => central }) },
    FaceclawKitIosProtocolPlatform: { shared: {} },
    FaceclawKitIosBleScanListener: {},
  }, {
    '@nativescript/core': {
      Application: { resumeEvent: 'resume', on: (_name, fn) => appListeners.add(fn), off: (_name, fn) => appListeners.delete(fn) },
      ApplicationSettings: { getString: (_key, fallback) => fallback, setString() {}, remove() {} },
      Dialogs: { alert: async options => { alerts.push(options.message); }, confirm: async () => true },
      Frame: { topmost: () => null },
      Observable: class { notifyPropertyChange() {} },
    },
    '../g2/ios-peripheral-identity': {},
    '../util/hex-util': { hexToBytes() {} },
    './kotlin-listener.ios': { kotlinListener: (_protocol, methods) => methods },
    '../g2/android-permissions': {},
    '../native/calendar-permissions': { hasCalendarPermission: () => false, ensureCalendarPermission: async () => false },
    '../native/battery-optimization': {},
    '../native/file-access': {},
    '../native/notification-access': {},
    '../native/media-controller': { mediaControllerBridge: { hasAccess: () => false, requestAccess: async () => false } },
  });
  const { PermissionsViewModel } = load('app/phone-ui/permissions-view-model.ts');
  const model = new PermissionsViewModel({ onboarding });
  const card = () => model.cards.find(item => item.id === 'nearby-devices');
  return {
    central, alerts, timers, appListeners, model, card,
    checked: () => card().checkVisibility === 'visible',
    tap: () => card().onCardTap({ object: { bindingContext: card() } }),
    flush: () => new Promise(resolve => setImmediate(resolve)),
  };
}

test('opening the page does not prompt; tapping the card does, and allowing checks it', async () => {
  const page = harness();
  page.model.onPageLoaded();
  assert.equal(page.central.registrations, 0, 'rendering the card must not create the central');
  assert.equal(page.checked(), false);
  assert.match(page.model.primaryClass, /dimmed/);

  page.tap();
  assert.equal(page.central.registrations, 1, 'the tap creates the central, which shows the prompt');

  page.central.report(STATE_POWERED_ON, ALLOWED);
  await page.flush();
  assert.equal(page.checked(), true);
  assert.equal(page.model.primaryClass, '-primary');
  assert.equal(page.alerts.length, 0);
});

test('Bluetooth already allowed is checked on the first render, with no central and no prompt', () => {
  // A central's state arrives asynchronously, which is why a card reading it rendered unchecked
  // and then had its tap ignored once the state said granted.
  const page = harness({ authorization: ALLOWED });
  assert.equal(page.checked(), true);
  assert.equal(page.model.primaryClass, '-primary');
  page.tap();
  assert.equal(page.central.registrations, 0);
});

test('an answer arriving after the wait timed out still updates the page', async () => {
  const page = harness();
  page.model.onPageLoaded();
  page.tap();
  page.timers.find(timer => timer.delay === 30_000).fn();
  await page.flush();
  assert.match(page.alerts[0], /timed out/);
  assert.equal(page.checked(), false);

  page.central.report(STATE_POWERED_ON, ALLOWED);
  assert.equal(page.checked(), true);
  assert.equal(page.model.primaryClass, '-primary');
});

test('denied stays unchecked, and tapping again re-reads the state and explains', async () => {
  const page = harness();
  page.model.onPageLoaded();
  page.tap();
  page.central.report(STATE_UNAUTHORIZED, DENIED);
  await page.flush();
  assert.equal(page.checked(), false);
  assert.match(page.alerts[0], /iPhone Settings/);

  page.tap();
  assert.equal(page.central.registrations, 2, 'an existing central re-reports its state when registered again');
  page.central.report(STATE_UNAUTHORIZED, DENIED);
  await page.flush();
  assert.equal(page.alerts.length, 2);
});

test('leaving the page stops watching Bluetooth', () => {
  const page = harness();
  page.model.onPageLoaded();
  page.tap();
  page.model.onPageUnloaded();
  assert.equal(page.appListeners.size, 0);
  const before = page.model.cards;
  page.central.report(STATE_POWERED_ON, ALLOWED);
  assert.equal(page.model.cards, before, 'no refresh once unloaded');
});
