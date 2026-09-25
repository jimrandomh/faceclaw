const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');

// Exercise the controller's real methods without starting BLE or the app shell.
function harness() {
  const source = ts.createSourceFile('controller.ts', fs.readFileSync('app/g2/dashboard-controller.ts', 'utf8'), ts.ScriptTarget.Latest, true);
  const controller = source.statements.find(node => ts.isClassDeclaration(node) && node.name.text === 'DashboardController');
  const names = ['attachPhonePreview', 'schedulePreviewUpdate', 'updateCompositePreview'];
  const methods = names.map(name => controller.members.find(node => node.name?.getText(source) === name).getText(source));
  let now = 1000, focus = true, interactive = true, activityPresent = true, previews = 0, records = 0;
  const timers = new Map();
  const activity = { hasWindowFocus: () => focus, getSystemService: () => ({ isInteractive: () => interactive }) };
  const context = { exports: {}, global: { isAndroid: true },
    Application: { android: { get foregroundActivity() { return activityPresent ? activity : null; } } },
    android: { content: { Context: { POWER_SERVICE: 'power' } } },
    Date: { now: () => now }, CONNECTED_PREVIEW_MIN_UPDATE_MS: 100, RECORDING_MIN_CAPTURE_MS: 200,
    previewColorSetting: { get: () => 'green' },
    setTimeout: fn => { const id = timers.size + 1; timers.set(id, fn); return id; },
    clearTimeout: id => timers.delete(id),
  };
  vm.runInNewContext(ts.transpileModule(`export class Harness { ${methods.join('\n')} }`, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText, context);
  const instance = new context.exports.Harness();
  Object.assign(instance, { lastConnectedPreviewUpdateAtMs: 0, lastRecordCaptureAtMs: 0,
    phonePreviewVisible: null, previewTrailingTimer: null, screenRecordingActive: false,
    display: { getCompositePreview: () => { previews++; return {}; }, recordScreenFrame: () => records++ },
    setDisplayPreview() {},
  });
  return { instance, timers, previews: () => previews, records: () => records,
    tick: (ms = 1000) => { now += ms; instance.updateCompositePreview(); },
    focus: value => { focus = value; }, interactive: value => { interactive = value; },
    activity: value => { activityPresent = value; } };
}

test('phone preview skips hidden pages, background activity and screen off; resumes with latest frame', () => {
  const h = harness();
  h.tick();
  assert.equal(h.previews(), 0);
  let shown = true;
  const detach = h.instance.attachPhonePreview(() => shown);
  assert.equal(h.previews(), 1);
  shown = false; h.tick();
  shown = true; h.focus(false); h.tick();
  h.focus(true); h.interactive(false); h.tick();
  h.interactive(true); h.activity(false); h.tick();
  assert.equal(h.previews(), 1);
  h.activity(true); h.tick();
  assert.equal(h.previews(), 2);
  detach(); h.tick();
  assert.equal(h.previews(), 2);
});

test('explicit GIF recording continues without rendering a hidden phone bitmap', () => {
  const h = harness();
  h.instance.screenRecordingActive = true;
  h.instance.attachPhonePreview(() => true);
  h.interactive(false);
  h.tick(); h.tick(100); h.tick(100);
  assert.equal(h.records(), 3);
  assert.equal(h.previews(), 1);
  h.instance.phonePreviewVisible = null;
  h.tick();
  assert.equal(h.records(), 4);
  h.instance.screenRecordingActive = false;
  h.tick();
  assert.equal(h.records(), 4);
});

test('page detach cancels trailing previews and cannot detach a newer page', () => {
  const h = harness();
  const oldDetach = h.instance.attachPhonePreview(() => true);
  const newDetach = h.instance.attachPhonePreview(() => true);
  oldDetach();
  h.tick();
  assert.equal(h.previews(), 3);
  h.instance.schedulePreviewUpdate();
  assert.equal(h.timers.size, 1);
  newDetach();
  assert.equal(h.timers.size, 0);
  h.instance.schedulePreviewUpdate();
  assert.equal(h.timers.size, 0);
});
