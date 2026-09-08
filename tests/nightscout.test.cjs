const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const alerts = require('../.test-build/app/apps/nightscout/nightscout-alerts.js');
const now = 1_800_000_000_000;
const limits = { maxCannulaAgeHours: 72, cartridgeLowUnits: 20, batteryLowVoltage: 1.2, maxLoopAgeMinutes: 15 };
const healthy = { cageTimestampMs: now, reservoirUnits: 100, batteryVoltage: 1.5, loopTimestampMs: now };

function load(file, dependencies, globals = {}) {
  const source = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
  const context = { exports: {}, require(name) { assert.ok(name in dependencies, name); return dependencies[name]; }, ...globals };
  vm.runInNewContext(ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, context);
  return context.exports;
}

test('each threshold breaches independently, with strict boundaries and zero disabling it', () => {
  const cases = [
    ['cageTimestampMs', 'maxCannulaAgeHours', 'cannula', now - 72 * 3_600_000, -1],
    ['reservoirUnits', 'cartridgeLowUnits', 'cartridge', 20, -0.01],
    ['batteryVoltage', 'batteryLowVoltage', 'battery', 1.2, -0.01],
    ['loopTimestampMs', 'maxLoopAgeMinutes', 'loop', now - 15 * 60_000, -1],
  ];
  for (const [field, threshold, warning, boundary, delta] of cases) {
    assert.equal(alerts.evaluateNightscoutAlerts({ ...healthy, [field]: boundary }, limits, now).any, false);
    const result = alerts.evaluateNightscoutAlerts({ ...healthy, [field]: boundary + delta }, limits, now);
    assert.equal(result[warning], true);
    assert.equal(result.any, true);
    assert.equal(Object.values(result).filter(Boolean).length, 2);
    assert.equal(alerts.evaluateNightscoutAlerts({ ...healthy, [field]: boundary + delta }, { ...limits, [threshold]: 0 }, now).any, false);
  }
});

test('missing/invalid measurements do not alert; real empty reservoirs do', () => {
  for (const value of [null, NaN, -1, Infinity]) {
    const values = Object.fromEntries(Object.keys(healthy).map(key => [key, value]));
    assert.equal(alerts.evaluateNightscoutAlerts(values, limits, now).any, false);
  }
  assert.equal(alerts.evaluateNightscoutAlerts({ ...healthy, reservoirUnits: 0 }, limits, now).cartridge, true);
  assert.equal(alerts.evaluateNightscoutAlerts({ ...healthy, loopTimestampMs: now + 60_000 }, limits, now).loop, false);
  for (const value of ['', '-2', 'NaN', 'Infinity', '12abc', null]) assert.equal(alerts.normalizeNightscoutThreshold(value), '0');
  assert.equal(alerts.normalizeNightscoutThreshold(' 1.25 '), '1.25');
  assert.equal(alerts.normalizeNightscoutThreshold('.5'), '0.5');
});

class Image {
  constructor(width, height) { this.width = width; this.height = height; this.draws = []; }
  drawText(font, ...args) { this.draws.push(['text', ...args]); }
  drawLine(...args) { this.draws.push(['line', ...args]); }
  fillRect(...args) { this.draws.push(['rect', ...args]); }
}
const font = { measureText: text => text.length * 6, lineHeight: 12, hasGlyph: () => true };
function fixture(always = false) {
  let time = now, icon, tick, changed, notify, renders = 0;
  const state = { ...healthy, available: true, latest: { sgv: 100, timestampMs: now }, history: [], units: 'mg/dL', delta: 0, direction: '', iob: 1, cob: 0, pumpStatus: '0m ago', configurationMissing: false };
  const bridge = { snapshot: () => state, onStateChange(fn) { notify = fn; fn(state); } };
  const settings = { loadNightscoutThresholds: () => limits, nightscoutAlwaysShowInTopBarSetting: { get: () => always }, onAnySettingChanged(fn) { changed = fn; }, isNightscoutSettingsConfigured: () => true };
  const deps = {
    '../../graphics/image': { GrayImage: Image },
    '../../graphics/ui-fonts': { getDefaultSmallFont: () => font, getDefaultLargeFont: () => font },
    '../../native/nightscout-bridge': { nightscoutBridge: bridge },
    '../../ui/dashboard-settings': settings,
    './nightscout-alerts': alerts,
  };
  const app = load('app/apps/nightscout/nightscout-app.ts', {
    ...deps,
    './nightscout': { NightscoutLayer: class {}, nightscoutMenuItems() {} },
    '../../ui/shell/shell': { shell: { setTrayIcon(id, value) { icon = value; } } },
    '../../ui/shell/in-process-window': { YieldAtRootLayer: class {}, createInProcessWindow: options => ({ close: options.onClosed, requestRender() { renders++; } }) },
  }, { Date: { now: () => time }, setInterval(fn) { tick = fn; return 1; }, clearInterval() { tick = null; } });
  return { app, deps, state, icon: () => icon, tick: () => tick?.(), advance(ms) { time += ms; }, notify: () => notify(), toggle(value) { always = value; changed(); }, renders: () => renders };
}

test('tray boots without a window, persists on close, and responds to settings and elapsed time', () => {
  const f = fixture(true);
  f.app.startNightscoutTrayIcon();
  assert.ok(f.icon());
  const width = f.icon().width;
  f.advance(16 * 60_000); f.tick();
  assert.equal(f.icon().width, width + 24);
  const triangle = f.icon().draws.filter(d => d[0] === 'line' && d.at(-1) === 255);
  assert.equal(triangle.length, 3);
  assert.ok(triangle.every(d => d[1] > width && d[3] > width));
  f.toggle(false); assert.equal(f.icon(), null);
  const window = f.app.createNightscoutAppWindow({ onClosed() {} });
  assert.ok(f.icon());
  f.toggle(true); window.close(); assert.ok(f.icon());
  const renders = f.renders(); f.notify(); assert.equal(f.renders(), renders);
  f.toggle(false); assert.equal(f.icon(), null);
  const reopened = f.app.createNightscoutAppWindow({ onClosed() {} });
  reopened.close(); assert.equal(f.icon(), null);
});

test('tray is hidden by default and clears recovered measurement warnings immediately', () => {
  const f = fixture();
  f.app.startNightscoutTrayIcon();
  assert.equal(f.icon(), null);
  const first = f.app.createNightscoutAppWindow({ onClosed() {} });
  const width = f.icon().width;
  f.state.batteryVoltage = 1;
  f.notify(); assert.equal(f.icon().width, width + 24);
  f.state.batteryVoltage = 1.5;
  f.notify(); assert.equal(f.icon().width, width);
  const second = f.app.createNightscoutAppWindow({ onClosed() {} });
  first.close(); assert.ok(f.icon());
  second.close(); assert.equal(f.icon(), null);
});

test('main page highlights only the breached field and removes highlights on recovery', () => {
  const f = fixture();
  const page = load('app/apps/nightscout/nightscout.ts', {
    ...f.deps,
    '../../graphics/textwrap': { truncateText: (font, text) => text },
    '../../ui/gestures': {}, '../../ui/layers': {}, '../../ui/menu': {},
    '../../ui/dashboard/settings-panel': {}, '../../ui/metrics': { lineStep: () => 16 },
    '~/util/date-util': { formatAgeShortFromTimestamp: () => '1m', formatTimestamp: () => '12:00' },
  }, { Date: { now: () => now } });
  const layer = new page.NightscoutLayer();
  const paint = () => layer.paint({ stack: { getBaseSize: () => ({ width: 576, height: 260 }) } });
  for (const [field, value, label] of [['reservoirUnits', 10, '10U'], ['batteryVoltage', 1, '1.00V'], ['cageTimestampMs', now - 73 * 3_600_000, 'CAGE 1m'], ['loopTimestampMs', now - 16 * 60_000, 'Loop 1m']]) {
    f.state[field] = value;
    const image = paint();
    const highlighted = image.draws.filter(d => d[0] === 'text' && d.at(-1) === 0);
    assert.equal(highlighted.length, 1);
    assert.equal(highlighted[0][3], label);
    f.state[field] = healthy[field];
    assert.equal(paint().draws.filter(d => d[0] === 'text' && d.at(-1) === 0).length, 0);
  }
});

test('bridge exposes numeric measurements and treats absent values as unknown', async () => {
  let pump = { reservoir: '10.5', battery: { voltage: '1.15' } };
  const module = load('app/native/nightscout-bridge.ts', {
    '../ui/dashboard-settings': { nightscoutSiteUrlSetting: { get: () => 'https://example.test' }, nightscoutApiTokenSetting: { get: () => 'test' } },
    '../util/http': { async fetchWithUserAgent(url) {
      const body = url.includes('/entries.') ? [{ date: now, sgv: 100 }] : url.includes('/devicestatus.') ? [{ pump, openaps: { suggested: { mills: now - 60_000 } } }] : url.includes('/status.') ? {} : [];
      return { ok: true, json: async () => body };
    } },
  }, { Date, console });
  const bridge = new module.NightscoutBridge();
  await bridge.refreshNow();
  assert.equal(bridge.snapshot().reservoirUnits, 10.5);
  assert.equal(bridge.snapshot().batteryVoltage, 1.15);
  assert.equal(bridge.snapshot().loopTimestampMs, now - 60_000);
  pump = { reservoir: null, battery: { voltage: '' } };
  await bridge.refreshNow();
  assert.equal(bridge.snapshot().reservoirUnits, null);
  assert.equal(bridge.snapshot().batteryVoltage, null);
  pump = { reservoir: 0, battery: { voltage: 0 } };
  await bridge.refreshNow();
  assert.equal(bridge.snapshot().reservoirUnits, 0);
});
