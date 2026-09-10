const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

function evaluate(source, requireModule, globals = {}) {
  const context = { exports: {}, require: requireModule, ...globals };
  vm.runInNewContext(ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText, context);
  return context.exports;
}
const source = (file) => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
const load = (file, requireModule) => evaluate(source(file), requireModule);

function store(settings = new Map()) {
  return load('app/native/notification-sources.ts', () => ({
    getStringSetting: (key, fallback) => settings.get(key) ?? fallback,
    setStringSetting: (key, value) => settings.set(key, value),
  }));
}
const mail = { packageName: 'com.mail', appName: 'Mail' };

test('sources default on and retain per-package choices and names across restart and rediscovery', () => {
  const settings = new Map();
  let prefs = store(settings);
  assert.equal(prefs.shouldShowNotificationOnGlasses(mail.packageName), true);
  prefs.rememberNotificationSources([mail, mail, { packageName: 'com.other', appName: 'Mail' }]);
  assert.equal(prefs.readNotificationSources().length, 2);
  prefs.setNotificationSourceEnabled({ ...mail, text: 'private notification content' }, false);
  assert.ok(!Array.from(settings.values()).join('').includes('private notification content'));
  prefs = store(settings);
  prefs.rememberNotificationSources([{ ...mail, appName: 'Renamed Mail' }, { packageName: 'com.new', appName: '' }]);
  assert.equal(prefs.shouldShowNotificationOnGlasses(mail.packageName), false);
  assert.equal(prefs.shouldShowNotificationOnGlasses('com.other'), true);
  assert.equal(prefs.shouldShowNotificationOnGlasses('com.new'), true);
  assert.equal(prefs.readNotificationSources().find((s) => s.packageName === mail.packageName).appName, 'Renamed Mail');
  prefs.setNotificationSourceEnabled(mail, true);
  assert.equal(store(settings).shouldShowNotificationOnGlasses(mail.packageName), true);
});

test('invalid saved source data falls back to enabled', () => {
  for (const raw of ['invalid', '{}', '[null, {}, {"packageName": 1}]']) {
    assert.equal(store(new Map([['notifications.sources', raw]])).shouldShowNotificationOnGlasses('com.mail'), true);
  }
});

function ui(fontSize = 12) {
  const prefs = store();
  let active = [{ ...mail, key: 'key', title: 'Message', text: 'Hello', bigText: '', lines: [], actions: [], postTime: 0 }];
  let dismissals = 0;
  let closes = 0;
  const textwrap = load('app/graphics/textwrap.ts');
  const graphics = load('app/graphics/image.ts', () => textwrap);
  const { BdfFont } = load('app/graphics/bdffont.ts', () => ({}));
  const font = BdfFont.parse(source(`app/fonts/terminus/ter-u${fontSize}n.bdf`));
  class RecordingImage extends graphics.GrayImage {
    texts = [];
    drawText(font, x, y, text, value) {
      this.texts.push({ x, y, text });
      super.drawText(font, x, y, text, value);
    }
  }
  const native = {
    ALL_NOTIFICATIONS: 0x7fffffff,
    readActiveNotifications: () => { prefs.rememberNotificationSources(active); return active; },
    dismissNotification: () => { dismissals++; active = []; return true; },
    readNotificationIconByKey: () => ({ icon: null, stale: false }),
  };
  const dependencies = {
    '../graphics/image': { ...graphics, GrayImage: RecordingImage },
    '../graphics/textwrap': textwrap,
    '../graphics/ui-fonts': { getDefaultSmallFont: () => font },
    '../util/numeric-util': { clamp: (n, lo, hi) => Math.max(lo, Math.min(hi, n)) },
    '~/util/numeric-util': { clamp: (n, lo, hi) => Math.max(lo, Math.min(hi, n)) },
    '~/util/date-util': { formatRelativeTime: () => '' },
    '../native/notification-icons': native,
    '../native/notification-sources': prefs,
    '../native/notification-access': { isNotificationListenerEnabled: () => true },
    '../util/render-freshness': { renderPassAllowsStaleData: () => false },
    './metrics': load('app/ui/metrics.ts'),
    './gestures': {},
  };
  const requireModule = (name) => {
    assert.ok(name in dependencies, `Unexpected dependency ${name}`);
    return dependencies[name];
  };
  dependencies['./menu'] = load('app/ui/menu.ts', requireModule);
  const { SingleNotificationLayer } = load('app/ui/notifications.ts', requireModule);
  const { NotificationFilterLayer } = load('app/ui/notification-filter.ts', requireModule);
  const ctx = { stack: { getBaseSize: () => ({ width: 540, height: 224 }), isFocused: () => true, pop: () => closes++ } };
  const popup = new SingleNotificationLayer('key', { origin: 'new-notification-modal', closeModal: () => closes++ });
  const filter = new NotificationFilterLayer();
  const paint = (layer) => layer.paint(ctx, () => new RecordingImage(540, 224));
  const input = (layer, type) => layer.handleInput({ type }, ctx);
  return { prefs, popup, filter, paint, input, active: (value) => { active = value; },
    dismissals: () => dismissals, closes: () => closes };
}

test('popup dismisses before confirmation; confirming disables the source even after the notification disappears', async () => {
  const app = ui();
  await app.input(app.popup, 'scroll-down');
  await app.input(app.popup, 'scroll-down');
  await app.input(app.popup, 'click');
  assert.equal(app.dismissals(), 1);
  assert.equal(app.closes(), 0);
  assert.equal(app.prefs.shouldShowNotificationOnGlasses(mail.packageName), true);
  assert.ok(app.paint(app.popup).texts.some(({ text }) => text.includes('Mail')));
  assert.equal(app.closes(), 0);
  await app.input(app.popup, 'scroll-down');
  await app.input(app.popup, 'click');
  assert.equal(app.prefs.shouldShowNotificationOnGlasses(mail.packageName), false);
  assert.equal(app.closes(), 1);
});

test('cancel and back dismiss the popup without changing source preferences', async () => {
  for (const cancel of ['click', 'double-click']) {
    const app = ui();
    await app.input(app.popup, 'scroll-down');
    await app.input(app.popup, 'scroll-down');
    await app.input(app.popup, 'click');
    await app.input(app.popup, cancel);
    assert.equal(app.dismissals(), 1);
    assert.equal(app.closes(), 1);
    assert.equal(app.prefs.shouldShowNotificationOnGlasses(mail.packageName), true);
  }
});

test('filter toggles persist after notifications disappear and discovers new sources while open', async () => {
  const app = ui();
  app.paint(app.filter);
  await app.input(app.filter, 'click');
  assert.equal(app.prefs.shouldShowNotificationOnGlasses(mail.packageName), false);
  app.active([{ packageName: 'com.alpha', appName: 'Alpha' }]);
  const image = app.paint(app.filter);
  assert.ok(image.texts.some(({ text }) => text === 'Alpha'));
  assert.ok(image.texts.some(({ text }) => text === 'Mail'));
  // A source inserted before the selection must not move the toggle to another app.
  await app.input(app.filter, 'click');
  assert.equal(app.prefs.shouldShowNotificationOnGlasses(mail.packageName), true);
  assert.equal(app.prefs.shouldShowNotificationOnGlasses('com.alpha'), true);
});

test('popup action wraps fully and stays visible with small and large fonts', async () => {
  for (const size of [12, 20]) {
    const app = ui(size);
    await app.input(app.popup, 'scroll-down');
    await app.input(app.popup, 'scroll-down');
    const image = app.paint(app.popup);
    assert.ok(image.texts.map(({ text }) => text).join(' ').includes("Don't show on glasses again"));
    assert.ok(image.texts.every(({ y }) => y >= 0 && y < image.height));
  }
});

test('controller filters before waking or opening a popup, and still refreshes the tray', async () => {
  const file = ts.createSourceFile('controller.ts', source('app/g2/dashboard-controller.ts'), ts.ScriptTarget.Latest, true);
  const controller = file.statements.find((node) => ts.isClassDeclaration(node) && node.name.text === 'DashboardController');
  const handler = controller.members.find((node) => node.name?.getText(file) === 'handleAndroidNotificationPosted');
  const prefs = store();
  let wakes = 0, popups = 0, renders = 0;
  const { Harness } = evaluate(`export class Harness { ${handler.getText(file)} }`, null, {
    ALL_NOTIFICATIONS: 0x7fffffff,
    readActiveNotifications: () => [{ ...mail, key: 'key' }],
    shouldShowNotificationOnGlasses: prefs.shouldShowNotificationOnGlasses,
    shell: { isScreenOn: () => false, wake: () => { wakes++; return true; }, openNotificationModal: () => popups++ },
  });
  const instance = new Harness();
  instance.requestShellRender = () => renders++;
  instance.appendLog = () => {};
  prefs.setNotificationSourceEnabled(mail, false);
  await instance.handleAndroidNotificationPosted('key');
  await instance.handleAndroidNotificationPosted('gone');
  assert.equal(wakes, 0);
  assert.equal(popups, 0);
  assert.equal(renders, 2);
  prefs.setNotificationSourceEnabled(mail, true);
  await instance.handleAndroidNotificationPosted('key');
  assert.equal(wakes, 1);
  assert.equal(popups, 1);
});
