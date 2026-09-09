const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');

function harness() {
  let snapshot = { generation: 20, features: [] }, sequence = 0, granted = true, popupAllowed = true, screenOn = true, foreground = 'window';
  let sources = [];
  const sent = [], closed = [], nativeCalls = [], frames = [], module = { exports: {} };
  const imports = {
    '../../ui/shell/shell': { shell: { isScreenOn: () => screenOn, getBatteryLevels: () => ({}), getWindows: () => [], foregroundWindow: () => ({ windowId: foreground }) } },
    '../../assistant/tool-registry': { toolRegistry: { onToolsChanged() {}, listTools: () => [] } },
    '../../native/notification-icons': { readActiveNotifications: () => sources, onAndroidNotificationPosted() {}, onAndroidNotificationRemoved() {}, onAndroidNotificationsChanged() {} },
    '../../native/external-notifications': {},
    '../../native/notification-sources': { shouldShowNotificationOnGlasses: () => popupAllowed },
    '../../native/notification-apps': { readNotificationApps: () => [] },
    '../../native/shared-style': { initializeSharedHostStyle() {} },
    './extension-policy': require('../.test-build/app/apps/external/extension-policy.js'),
    './surface-health': require('../.test-build/app/apps/external/surface-health.js'),
  };
  vm.runInNewContext(ts.transpileModule(fs.readFileSync('app/apps/external/extension-platform.ts', 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText, {
    module, exports: module.exports, require: name => { assert.ok(name in imports, name); return imports[name]; },
    java: { util: { UUID: { randomUUID: () => ({ toString: () => `request-${++sequence}` }) } } }, setInterval() {},
  });
  const native = { extensionsJson: () => JSON.stringify(snapshot), isExtensionGranted: () => granted,
    openExtensionSurface: (...args) => { nativeCalls.push(['open', ...args]); return true; },
    closeExtensionSurface: (...args) => nativeCalls.push(['close', ...args]),
    setExtensionSurfaceVisibility: (...args) => nativeCalls.push(['visibility', ...args]),
    sendExtension: (owner, feature, type, json) => { sent.push({ owner, feature, type, data: JSON.parse(json) }); return true; },
    sendAppProvider: (owner, feature, type, json) => { sent.push({ owner, feature, type, data: JSON.parse(json) }); return true; } };
  const platform = new module.exports.ExtensionPlatform(native, { closeSurface: feature => closed.push(feature), onFrame: (...args) => frames.push(args) }, () => false);
  const state = (feature, component = 'A', generation = 7) => ({ feature, component, generation, available: true, configuration: {} });
  return { platform, state, sent, closed, nativeCalls, frames, sources: value => sources = value, popup: value => popupAllowed = value, grant: value => granted = value, screen: value => screenOn = value, foreground: value => foreground = value,
    update: features => { snapshot = { generation: snapshot.generation + 1, features }; platform.onNativeEvent('', 'extensions-changed', {}); },
    result: (request, owner, feature, generation) => platform.onNativeEvent(owner, 'extension-event', { type: 'result', requestId: request.requestId, feature, generation, data: { text: 'synthetic result' } }) };
}

test('metadata and unrelated feature changes preserve pending requests, menus and notification reviews', async () => {
  const h = harness();const assistant=h.state('assistant'),launcher=h.state('ui.launcher'),notifications=h.state('ui.notifications'),menu=h.state('ui.app-menu');
  h.update([assistant, launcher, notifications, menu]);
  let cancelled=0,menuClosed=0;
  h.platform.reviews.set('review', { cancel: () => cancelled++, current: () => true });
  h.platform.menu={onClosed:()=>menuClosed++};
  const request=h.platform.provider('assistant',{text:'synthetic'});
  h.update([assistant,launcher,notifications,menu,h.state('ui.typography','B',9)]);
  h.result(request,'A','assistant',7);
  assert.equal((await request.promise).text,'synthetic result');
  assert.deepEqual(h.closed,[]);assert.equal(cancelled,0);assert.equal(menuClosed,0);
});

test('surface takeover requires a frame, resets on reopen, and keeps stream generation separate from feature epoch', () => {
  const h = harness();
  h.update([h.state('ui.launcher', 'A', 7)]);
  assert.equal(h.platform.openSurface('ui.launcher', 576, 260), true);
  h.platform.setSurfaceVisibility('ui.launcher', true, true);
  assert.equal(h.platform.surfaceReady('ui.launcher'), false);
  h.platform.surfaceInput('ui.launcher', { type: 'click' });
  assert.equal(h.sent.filter(item => item.type === 'input').length, 0);

  h.platform.onFrame('A', 'ui.launcher', 901, 576, 260, new Uint8Array(576 * 260));
  assert.equal(h.platform.surfaceReady('ui.launcher'), true);
  assert.equal(h.frames[0][2], 901); // Native stream generation is not the feature epoch.
  h.platform.surfaceInput('ui.launcher', { type: 'click' });
  assert.equal(h.sent.filter(item => item.type === 'input').length, 1);

  h.platform.closeSurface('ui.launcher');
  assert.equal(h.platform.openSurface('ui.launcher', 576, 260), true);
  assert.equal(h.platform.surfaceReady('ui.launcher'), false);
  h.platform.surfaceInput('ui.launcher', { type: 'click' });
  assert.equal(h.sent.filter(item => item.type === 'input').length, 1);
});

test('failed global surfaces fall back before menu or notification wake can reach the APK', () => {
  const h = harness();
  h.update([h.state('ui.notifications'), h.state('ui.app-menu')]);
  const shown = [];
  h.platform.hooks.showSurface = (...args) => { shown.push(args); return true; };
  const fail = feature => {
    assert.equal(h.platform.openSurface(feature, 576, 260), true);
    h.platform.surfaceHealth.states.get(feature).failed = true;
  };
  fail('ui.notifications');
  h.screen(false); h.popup(true);
  h.sources([{ key: 'apk:silent', postTime: 1, packageName: 'fixture.app', appName: 'Fixture', actions: [] }]);
  h.platform.notificationsChanged('apk:silent');
  assert.equal(h.platform.handlesNotifications(), false);
  assert.equal(h.platform.openNotificationInbox(), false);
  assert.equal(shown.length, 0);

  fail('ui.app-menu');
  assert.equal(h.platform.openMenu('window', 'System', [], () => {}), false);
  assert.equal(shown.length, 0);
});

test('retrySurface is failed-only and resets quarantine before a fresh open', () => {
  const h = harness();
  h.update([h.state('ui.launcher')]);
  assert.equal(h.platform.openSurface('ui.launcher', 576, 260), true);
  h.platform.setSurfaceVisibility('ui.launcher', true, true);
  h.platform.onFrame('A', 'ui.launcher', 77, 576, 260, new Uint8Array(576 * 260));
  h.platform.retrySurface('ui.launcher');
  assert.equal(h.platform.surfaceReady('ui.launcher'), true);
  assert.deepEqual(h.closed, []);

  h.platform.surfaceHealth.states.get('ui.launcher').failed = true;
  h.platform.retrySurface('ui.launcher');
  assert.equal(h.platform.surfaceFailed('ui.launcher'), false);
  assert.equal(h.closed.at(-1), 'ui.launcher');
});

test('real ownership change rejects only affected requests and ignores their late replies', async () => {
  const h=harness();const refinement=h.state('refinement');h.update([h.state('assistant'),refinement]);
  const old=h.platform.provider('assistant',{text:'synthetic'}),unrelated=h.platform.provider('refinement',{});
  const rejected=assert.rejects(old.promise,/outcome may be unknown/);
  h.update([h.state('assistant','B',8),refinement]);
  h.result(old,'A','assistant',7);h.result(unrelated,'A','refinement',7);
  await rejected;assert.equal((await unrelated.promise).text,'synthetic result');
  assert.equal(h.sent.filter(item=>item.type==='request').length,2); // No automatic replay.
});

test('notification ownership change cancels its review and surface without touching an assistant request', async () => {
  const h=harness(),assistant=h.state('assistant');h.update([assistant,h.state('ui.notifications')]);
  let cancelled=0;h.platform.reviews.set('review',{cancel:()=>cancelled++,current:()=>true});
  const request=h.platform.provider('assistant',{});
  h.update([assistant,h.state('ui.notifications','B',8)]);
  assert.equal(cancelled,1);assert.deepEqual(h.closed,['ui.notifications']);
  h.result(request,'A','assistant',7);await request.promise;
});

test('own transcription remains grant-bound when its app does not own the global feature', async () => {
  const h=harness(),transcription=h.state('transcription');h.update([transcription]);
  const request=h.platform.provider('transcription',{},undefined,'B');
  const rejected=assert.rejects(request.promise,/outcome may be unknown/);
  h.grant(false);h.update([transcription]);await rejected;
  h.grant(true);h.result(request,'B','transcription',7);
  assert.equal(h.platform.pending.size,0);
});


test('host popup filters apply to native and APK arrivals without removing inbox snapshots', () => {
  for (const key of ['native-message', 'apk:message']) {
    const h = harness();
    h.update([h.state('ui.notifications')]);
    const shown = [];
    h.platform.hooks.showSurface = (...args) => { shown.push(args); return true; };
    h.sources([{ key, postTime: 4, packageName: 'fixture.app', appName: 'Fixture', actions: [] }]);
    h.popup(false); h.sent.length = 0;
    h.platform.notificationsChanged(key);
    assert.equal(shown.length, 0);
    assert.ok(h.sent.some(item => item.data.event === 'notification-snapshot-fragment'));
    assert.ok(!h.sent.some(item => item.data.event === 'notification-arrived'));
    h.popup(true); h.platform.notificationsChanged(key);
    assert.equal(shown.length, 1);
    assert.ok(h.sent.some(item => item.data.event === 'notification-arrived'));
  }
});
