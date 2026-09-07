const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const path = require('node:path');
function load(file, context) {
  const sandbox = { exports: {}, ...context };
  const source = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText, sandbox);
  return sandbox.exports;
}
test('iOS phone battery distinguishes unknown, charging, full and unplugged readings', () => {
  const device = { batteryLevel: -1, batteryState: 0 };
  const api = load('app/native/phone-battery.ts', { require: () => ({}), global: { isIOS: true },
    UIDevice: { currentDevice: device }, UIDeviceBatteryState: { Unknown: 0, Unplugged: 1, Charging: 2, Full: 3 } });
  assert.deepEqual({ ...api.readPhoneBatteryState() }, { battery: null, charging: null });
  device.batteryLevel = 0.726; device.batteryState = 2;
  assert.deepEqual({ ...api.readPhoneBatteryState() }, { battery: 73, charging: true });
  device.batteryLevel = 1; device.batteryState = 3;
  assert.deepEqual({ ...api.readPhoneBatteryState() }, { battery: 100, charging: true });
  device.batteryLevel = 0; device.batteryState = 1;
  assert.deepEqual({ ...api.readPhoneBatteryState() }, { battery: 0, charging: false });
});
test('settings changes propagate between iOS worker isolates once, including after a getter read', () => {
  const store = new Map(), ticks = new Set(), tasks = [];
  const ApplicationSettings = { getString: (k, d) => store.get(k) ?? d, getBoolean: (k, d) => store.get(k) ?? d,
    setString: (k, v) => store.set(k, v), setBoolean: (k, v) => store.set(k, v), hasKey: k => store.has(k) };
  const context = { require: () => ({ ApplicationSettings }), setTimeout: fn => tasks.push(fn),
    setInterval: fn => { ticks.add(fn); return fn; }, clearInterval: fn => ticks.delete(fn) };
  const main = load('app/native/settings-store.ios.ts', context), worker = load('app/native/settings-store.ios.ts', context);
  const seenMain = [], seenWorker = [];
  const offMain = main.onSettingsStoreChanged(k => seenMain.push(k));
  const offWorker = worker.onSettingsStoreChanged(k => seenWorker.push(k));
  main.getStringSetting('terminal.connections', '[]'); worker.getStringSetting('terminal.connections', '[]');
  main.setStringSetting('terminal.connections', '["test"]');
  assert.equal(worker.getStringSetting('terminal.connections', '[]'), '["test"]');
  const flush = () => { for (const tick of ticks) tick(); while (tasks.length) tasks.shift()(); };
  flush(); flush();
  assert.deepEqual(seenMain, ['terminal.connections']); assert.deepEqual(seenWorker, ['terminal.connections']);
  main.getBooleanSetting('sound', true); worker.getBooleanSetting('sound', true);
  worker.setBooleanSetting('sound', false); flush();
  assert.equal(main.getBooleanSetting('sound', true), false);
  assert.deepEqual(seenMain, ['terminal.connections', 'sound']);
  offWorker(); offMain(); assert.equal(ticks.size, 0);
});
test('iOS worker frames preserve baked grayscale bytes through the message boundary', () => {
  const messages = [];
  const api = load('app/native/active-display.ios.ts', { global: { postMessage: m => messages.push(m) },
    interop: { handleof: b => b }, NSData: { dataWithBytesLength: (b, n) => ({ base64EncodedStringWithOptions: () => Buffer.from(b, 0, n).toString('base64') }) } });
  const pixels = new Uint8Array([0, 1, 15, 127, 254, 255]);
  api.getActiveDisplay().submitSurfaceFrame(pixels.buffer, 'window:blocks:main', 0, 0, 3, 2);
  assert.equal(messages[0].surfaceId, 'window:blocks:main');
  assert.equal(messages[0].width, 3); assert.equal(messages[0].height, 2);
  assert.deepEqual(Buffer.from(messages[0].pixels, 'base64'), Buffer.from(pixels));
});
