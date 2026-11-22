const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm'), ts = require('typescript');

function load(file, modules = {}, globals = {}) {
  const context = { exports: {}, require: name => {
    if (!(name in modules)) throw new Error(`Missing mock: ${name} in ${file}`);
    return modules[name];
  }, console: { log() {} }, setTimeout, clearTimeout, ...globals };
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText, context);
  return context.exports;
}

const LEFT = 'EC:D7:82:69:3C:CB', RIGHT = 'EC:D7:82:82:09:67';
const POWERED_ON = 5, ACTIVE = 0, BACKGROUND = 2;

/**
 * IosBluetooth over a fake Kotlin central. `remembered` is what earlier scans saved, `systemConnected` the
 * identifiers the system holds a link to. An advertisement's name is "<role>|<address>" and its identifier is the
 * peripheral the system currently has for that arm.
 */
function fixture({ remembered = {}, systemConnected = [], applicationState = ACTIVE } = {}) {
  const settings = new Map(Object.entries(remembered).map(([address, record]) => [`ios.ble.peripheral.${address}`, JSON.stringify(record)]));
  const central = { scans: 0, stops: 0, listener: null,
    setScanListenerListener(listener) { this.listener = listener; },
    authorization: () => 3,
    startScan() { this.scans++; }, stopScan() { this.stops++; },
    systemConnectedArms: () => ({ count: systemConnected.length, objectAtIndex: i => ({ identifier: systemConnected[i] }) }) };
  const { IosBluetooth } = load('app/native/ios-bluetooth.ts', {
    '@nativescript/core': { ApplicationSettings: {
      getString: (key, fallback) => settings.get(key) ?? fallback, setString: (key, value) => settings.set(key, value),
      remove: key => settings.delete(key), getAllKeys: () => [...settings.keys()] } },
    '../g2/device-addresses': { loadPairedGlassesIdentity: () => null },
    '../g2/even-advertisement': { g2ManufacturerData: () => null },
    '../g2/glasses-hardware-identity': { serialKey: () => null },
    '../g2/ios-peripheral-identity': { identifyIosPeripheral: raw => {
      const [role, address] = raw.name.split('|');
      return address ? { identifier: raw.identifier, name: raw.name, manufacturerData: raw.manufacturerData, role, address } : null;
    } },
    '../util/hex-util': { hexToBytes: () => new Uint8Array(0) },
    './kotlin-listener.ios': { kotlinListener: (_protocol, methods) => methods },
  }, { FaceclawKitIosBleCentral: { alloc: () => ({ initWithPlatform: () => central }) }, FaceclawKitIosProtocolPlatform: { shared: {} },
    FaceclawKitIosBleScanListener: {}, UIApplication: { sharedApplication: { applicationState } }, UIApplicationState: { Active: ACTIVE } });
  const bluetooth = new IosBluetooth();
  bluetooth.state = POWERED_ON;
  const advertise = (role, address, identifier) =>
    bluetooth.scanListener.onAdvertisementIdentifierNameManufacturerDataHexRssiConnectable(identifier, `${role}|${address}`, '', -50, true);
  const saved = address => JSON.parse(settings.get(`ios.ble.peripheral.${address}`)).identifier;
  return { bluetooth, central, advertise, saved };
}
const settle = () => new Promise(resolve => setImmediate(resolve));
const both = { [LEFT]: { identifier: 'L-OLD', role: 'left' }, [RIGHT]: { identifier: 'R-ID', role: 'right' } };

test('an arm that now advertises under another identifier is connected by that one', async () => {
  // The right arm is on the system's ANCS link, so it can't be heard and doesn't need to be.
  const f = fixture({ remembered: both, systemConnected: ['R-ID'] });
  const resolving = f.bluetooth.resolveDevices({ left: LEFT, right: RIGHT, ring: '' });
  await settle();
  assert.equal(f.central.scans, 1, 'the left arm is listened for');
  f.advertise('left', LEFT, 'L-NEW');
  assert.deepEqual({ ...await resolving }, { left: 'L-NEW', right: 'R-ID' });
  assert.equal(f.saved(LEFT), 'L-NEW', 'and remembered for next time');
  assert.equal(f.central.stops, 1, 'the scan ends as soon as the arm is heard');
});

test('arms the system is connected to are trusted without a scan', async () => {
  const f = fixture({ remembered: both, systemConnected: ['R-ID', 'l-old'] });
  assert.deepEqual({ ...await f.bluetooth.resolveDevices({ left: LEFT, right: RIGHT, ring: '' }) }, { left: 'L-OLD', right: 'R-ID' });
  assert.equal(f.central.scans, 0);
});

test('an arm that is not heard keeps its remembered identifier', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture({ remembered: both });
  const resolving = f.bluetooth.resolveDevices({ left: LEFT, right: RIGHT, ring: '' });
  await settle();
  f.advertise('right', RIGHT, 'R-ID');
  t.mock.timers.tick(2_500);
  assert.deepEqual({ ...await resolving }, { left: 'L-OLD', right: 'R-ID' });
  assert.equal(f.bluetooth.scanning, false);
});

test('in the background nothing can be heard, so nothing is waited for', async () => {
  const f = fixture({ remembered: both, applicationState: BACKGROUND });
  assert.deepEqual({ ...await f.bluetooth.resolveDevices({ left: LEFT, right: RIGHT, ring: '' }) }, { left: 'L-OLD', right: 'R-ID' });
  assert.equal(f.central.scans, 0);
});

test('a scan someone else is running is listened to and left running', async () => {
  const f = fixture({ remembered: both });
  await f.bluetooth.startScan(60_000);
  const resolving = f.bluetooth.resolveDevices({ left: LEFT, right: RIGHT, ring: '' });
  await settle();
  f.advertise('left', LEFT, 'L-NEW');
  f.advertise('right', RIGHT, 'R-ID');
  assert.deepEqual({ ...await resolving }, { left: 'L-NEW', right: 'R-ID' });
  assert.equal(f.central.scans, 1);
  assert.equal(f.bluetooth.scanning, true, 'the pairing page keeps its scan');
  f.bluetooth.stopScan();
});
