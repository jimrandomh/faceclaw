const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
function load(path, imports = {}, globals = {}) {
  const module = { exports: {} };
  const code = ts.transpileModule(fs.readFileSync(path, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS } }).outputText;
  vm.runInNewContext(code, { module, exports: module.exports, require: (name) => { if (!(name in imports)) throw new Error(name); return imports[name]; }, URL, setTimeout, clearTimeout, ...globals });
  return module.exports;
}
const flush = () => new Promise(resolve => setImmediate(resolve));
function shellVoiceHarness(prepare) {
  const source = ts.createSourceFile('shell.ts', fs.readFileSync('app/ui/shell/shell.ts', 'utf8'), ts.ScriptTarget.Latest);
  const imports = {};
  for (const statement of source.statements) if (ts.isImportDeclaration(statement)) imports[statement.moduleSpecifier.text] = {};
  const layers = []; const activity = [];
  class Stack {
    push(layer) { layers.push(layer); }
    isAtBase() { return layers.length === 0; }
    removeLayer(layer) { const index = layers.indexOf(layer); if (index < 0) return false; layers.splice(index, 1); layer.options.onClosed(); return true; }
    popIfTop(predicate) { const top = layers[layers.length - 1]; if (predicate(top)) { layers.pop(); top.options.onClosed(); } }
    clearToBase() { while (layers.length) layers.pop().options.onClosed(); }
  }
  class Voice {
    constructor(options) { this.options = options; this.started = false; }
    startCapture() { this.started = true; }
  }
  imports['../layers'] = { noopLayerActions: {}, LayerStack: Stack };
  imports['./chrome-layer'] = { ShellChromeLayer: class {} };
  imports['../menu'] = { MenuLayer: class {} };
  imports['./voice-input'] = { VoiceInputLayer: Voice };
  imports['./voice-search'] = { VoiceSearchLayer: Voice };
  imports['./voice-activity'] = { voiceActivity: { setActive: (active) => activity.push(active) } };
  const { shell } = load('app/ui/shell/shell.ts', imports);
  shell.config = { actions: {}, prepareVoiceCapture: prepare, requestShellRender() {} };
  return { shell, layers, activity };
}
test('notification reply uses full-shell reviewed voice lifecycle after microphone permission', async () => {
  let permission; let sent = 0;
  const { shell, layers, activity } = shellVoiceHarness(() => new Promise(resolve => { permission = resolve; }));
  const target = { id: 'reply', label: 'Send reply', onSend: () => sent++ };
  shell.openReviewedVoiceInput(target);
  assert.equal(layers.length, 0); assert.equal(sent, 0);
  permission(true); await flush();
  assert.equal(layers.length, 1); assert.equal(layers[0].started, true);
  assert.equal(layers[0].options.sendTargets.length, 1);
  assert.equal(layers[0].options.sendTargets[0], target);
  assert.equal(layers[0].options.autoSend, false);
  assert.deepEqual(activity, [true]); assert.equal(sent, 0);
  layers[0].options.dismiss();
  assert.equal(layers.length, 0); assert.deepEqual(activity, [true, false]);
});
test('notification disappearing during permission prompt prevents capture and send', async () => {
  let permission; let current = true; let rejected = 0;
  const { shell, layers } = shellVoiceHarness(() => new Promise(resolve => { permission = resolve; }));
  shell.openReviewedVoiceInput({ id: 'reply', label: 'Send reply', onSend() { throw new Error('must not send'); } }, () => current, () => rejected++);
  current = false; permission(true); await flush();
  assert.equal(layers.length, 0); assert.equal(rejected, 1);
});

test('review layer cleanup during sleep cannot turn the display back on', async () => {
  const { shell, layers, activity } = shellVoiceHarness(async () => true); const screen = [];
  shell.config.onScreenStateChanged = on => screen.push(on);
  shell.screenOn = true;
  shell.openReviewedVoiceInput({ id: 'reply', label: 'Send reply', onSend() { assert.fail('must not send'); } });
  await flush(); const layer = layers[0]; assert.ok(layer);
  shell.sleepAtAppRoot();
  assert.equal(shell.screenOn, false); assert.equal(layers.length, 0); assert.deepEqual(activity, [true, false]);
  layer.options.onClosed(); await flush();
  assert.equal(shell.screenOn, false); assert.deepEqual(screen, [false]);
});

test('native removal contract requires a generated JavaScript proxy override', () => {
  const contract = fs.readFileSync('App_Resources/Android/src/main/java/com/faceclaw/app/FaceclawNotificationListener.java', 'utf8');
  assert.match(contract, /\bvoid onNotificationRemoved\(String key\);/);
  assert.doesNotMatch(contract, /default\s+void\s+onNotificationRemoved/);
  assert.match(contract, /\bvoid onNotificationsChanged\(\);/);
  assert.doesNotMatch(contract, /default\s+void\s+onNotificationsChanged/);
});

test('native snapshot changes invalidate icons and notify all observers without fake arrivals', async () => {
  let proxy; let detached = 0; let active = true; let changed = 0; let posted = 0;
  class GrayImage { constructor(w, h) { this.pixels = new Uint8Array(w * h); } clone() { return this; } }
  const api = load('app/native/notification-icons.ts', {
    '../graphics/icons': { renderIcon: () => null },
    './external-notifications': { externalNotifications: () => [], invokeExternalNotification: () => false, dismissExternalNotification: () => false },
    '../graphics/image': { GrayImage }, './frame-timings': { logCurrent() {}, spanCurrent: (_label, run) => run() },
    '../util/array-util': { toUint8Array: value => value },
  }, { global: { isAndroid: true }, com: { faceclaw: { app: {
    FaceclawNotificationListener: function(listener) { proxy = listener; return listener; },
    FaceclawMediaNotificationListenerService: { addNotificationListener() {}, removeNotificationListener() { detached++; },
      getActiveNotificationIconGrays: () => new Uint8Array(active ? 24 * 24 : 0) },
  } } } });
  const offPosted = api.onAndroidNotificationPosted(() => posted++);
  const offBroken = api.onAndroidNotificationsChanged(() => { throw Error('broken consumer'); });
  const offChanged = api.onAndroidNotificationsChanged(() => changed++);
  assert.equal(api.readActiveNotificationIcons(3, false).icons.length, 1);
  active = false; proxy.onNotificationsChanged();
  assert.equal(api.readActiveNotificationIcons(3, false).icons.length, 0);
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(changed, 1); assert.equal(posted, 0);
  offPosted(); offBroken(); assert.equal(detached, 0); offChanged(); assert.equal(detached, 1);
});

test('native reply dispatch retains access, freshness, creator and duplicate checks', () => {
  const source = fs.readFileSync('App_Resources/Android/src/main/java/com/faceclaw/app/FaceclawMediaNotificationListenerService.java', 'utf8');
  const reply = source.slice(source.indexOf('public static synchronized boolean replyToNotification'), source.indexOf('public static boolean dismissNotification('));
  for (const guard of ['sbn.getPostTime() != expectedPostTime', '!shouldShowNotificationInList(service, sbn)',
    'getCreatorPackage()', 'getAllowFreeFormInput()', 'sentReplies.contains(receipt)', 'sentReplies.add(receipt)']) assert.ok(reply.includes(guard), guard);
  assert.ok(reply.indexOf('sentReplies.add(receipt)') < reply.indexOf('action.actionIntent.send('));
});
test('phone removal invalidates cached icons and reaches every removal observer', async () => {
  let proxy; let active = true; let fetches = 0; const removed = [];
  class GrayImage { constructor(w, h) { this.pixels = new Uint8Array(w * h); } clone() { return this; } }
  const api = load('app/native/notification-icons.ts', {
    '../graphics/icons': { renderIcon: () => null },
    './external-notifications': { externalNotifications: () => [], invokeExternalNotification: () => false, dismissExternalNotification: () => false },
    '../graphics/image': { GrayImage }, './frame-timings': { logCurrent() {}, spanCurrent: (label, run) => run() },
    '../util/array-util': { toUint8Array: value => value },
  }, { global: { isAndroid: true }, com: { faceclaw: { app: {
    FaceclawNotificationListener: function(listener) { proxy = listener; return listener; },
    FaceclawMediaNotificationListenerService: {
      addNotificationListener() {}, removeNotificationListener() {},
      getActiveNotificationIconGrays() { fetches++; return active ? new Uint8Array(24 * 24) : new Uint8Array(0); },
    },
  } } } });
  const offThrowing = api.onAndroidNotificationRemoved(() => { throw new Error('broken observer'); });
  const off = api.onAndroidNotificationRemoved(key => removed.push(key));
  assert.equal(api.readActiveNotificationIcons(3, false).icons.length, 1);
  active = false;
  assert.equal(api.readActiveNotificationIcons(3, false).icons.length, 1);
  proxy.onNotificationRemoved('fixture-key');
  assert.equal(api.readActiveNotificationIcons(3, false).icons.length, 0);
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.deepEqual(removed, ['fixture-key']); assert.equal(fetches, 2);
  off(); offThrowing();
});


test('APK review cancellation removes capture under a newer overlay and cannot send later', async () => {
 const { shell, layers } = shellVoiceHarness(async () => true);
 shell.screenOn = true; shell.foregroundWindow = () => ({ windowId: 'apk:fixture', title: 'Synthetic app' });
 let sent = 0;
 const cancel = shell.startExternalAppReview('apk:fixture', 'Synthetic recipient', '', () => sent++, () => {});
 await flush(); const review = layers[0]; assert.ok(review.started);
 layers.push({ options: { onClosed() {} } }); cancel();
 assert.equal(layers.includes(review), false); assert.equal(layers.length, 1);
 review.options.sendTargets[0].onSend('Must not send'); assert.equal(sent, 0);
});

test('APK search has a Search-only callback and rechecks authority after microphone permission', async () => {
  let permission; let allowed = true; let searches = 0;
  const { shell, layers } = shellVoiceHarness(() => new Promise(resolve => { permission = resolve; }));
  shell.screenOn = true; shell.foregroundWindow = () => ({ windowId: 'apk:fixture', title: 'Fixture' });
  shell.startExternalAppSearch('apk:fixture', 'Search by name', () => searches++, () => {}, () => allowed);
  await flush(); allowed = false; permission(true); await flush(); assert.equal(layers.length, 0); assert.equal(searches, 0);
});
test('APK search cancellation cannot deliver a late query or a send target', async () => {
  const { shell, layers } = shellVoiceHarness(async () => true);
  shell.screenOn = true; shell.foregroundWindow = () => ({ windowId: 'apk:fixture', title: 'Fixture' });
  let searches = 0; const cancel = shell.startExternalAppSearch('apk:fixture', 'Search by name', () => searches++, () => {}, () => true);
  await flush(); const layer = layers[0]; assert.ok(layer.started); assert.equal(layer.options.sendTargets, undefined);
  cancel(); layer.options.onSearch('Stale query'); assert.equal(searches, 0); assert.equal(layers.length, 0);
});

test('notification reply capture paints one opaque view without painting the reader underneath', () => {
  let painted;
  class Image { constructor(width, height, fill) { this.width = width; this.height = height; this.pixels = new Uint8Array(width * height).fill(fill); } }
  const source = ts.createSourceFile('voice.ts', fs.readFileSync('app/ui/shell/voice-input.ts', 'utf8'), ts.ScriptTarget.Latest);
  const imports = {}; for (const statement of source.statements) if (ts.isImportDeclaration(statement)) imports[statement.moduleSpecifier.text] = {};
  imports['../../graphics/image'] = { GrayImage: Image };
  imports['./input-dialog'] = { paintInputDialog: (image, content) => { painted = { image, content }; } };
  const { VoiceInputLayer } = load('app/ui/shell/voice-input.ts', imports);
  const layer = new VoiceInputLayer({ actions: {}, onClosed() {}, dismiss() {}, sendTargets: [{ id: 'reply', label: 'Send reply', captureTitle: 'Reply', concealUnderlay: true, onSend() {} }] });
  layer.hintText = () => '';
  layer.paint({ stack: { getBaseSize: () => ({ width: 640, height: 480 }) } }, () => assert.fail('Reader must not be painted under reply capture'));
  assert.equal(layer.dimUnderneath, 0); assert.equal(painted.content.title, 'Reply'); assert.ok(painted.image.pixels.every(value => value === 1));
  const ordinary = new VoiceInputLayer({ actions: {}, onClosed() {}, dismiss() {}, sendTargets: [] }); assert.equal(ordinary.dimUnderneath, false);
});
