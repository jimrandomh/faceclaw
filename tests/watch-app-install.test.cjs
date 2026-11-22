const test = require('node:test');
const assert = require('node:assert/strict');
const { loader } = require('./helpers/load-typescript.cjs');

/** What FaceclawWatchBridge.m and UIKit do, as far as watch-app-install.ios.ts can tell. */
function iosFixture({ state = 'not-installed', bundled = true, kind = 'self-built', receipt = 'sandboxReceipt', available = true, opens = true,
  inFront = true } = {}) {
  const h = { state, bundled, kind, inFront, now: 1_000_000, opened: [], handler: null, handlersSet: 0, warnings: [], resumeListeners: [] };
  /** Faceclaw comes to the front on the iPhone. */
  h.resume = () => { h.inFront = true; for (const listener of h.resumeListeners) listener(); };
  const native = {
    isAvailable: () => available,
    watchAppInstallState: () => h.state,
    bundlesWatchApp: () => h.bundled,
    setInstallStateHandler(handler) { h.handler = handler; h.handlersSet++; },
  };
  const load = loader({
    console: { warn: (...args) => h.warnings.push(args) },
    FaceclawWatchBridge: { shared: () => native },
    NSBundle: { mainBundle: { appStoreReceiptURL: receipt ? { lastPathComponent: receipt } : null } },
    NSURL: { URLWithString: url => url },
    NSDictionary: { dictionary: () => ({}) },
    UIApplicationState: { Active: 0, Background: 2 },
    UIApplication: { sharedApplication: {
      get applicationState() { return h.inFront ? 0 : 2; },
      openURLOptionsCompletionHandler(url, _options, done) { h.opened.push(url); done(opens); },
    } },
    Date: { now: () => h.now },
  }, {
    './build-info': { buildKind: () => h.kind },
    '@nativescript/core': { Application: { resumeEvent: 'resume', on: (name, listener) => { assert.equal(name, 'resume'); h.resumeListeners.push(listener); } } },
  });
  h.install = load('app/native/watch-app-install.ios.ts').watchAppInstall;
  return h;
}

test('iOS reports the native install state, and "unknown" for anything else', () => {
  const h = iosFixture();
  for (const state of ['unknown', 'no-watch', 'not-installed', 'installed']) {
    h.state = state;
    assert.equal(h.install.getState(), state);
  }
  h.state = 'something new';
  assert.equal(h.install.getState(), 'unknown');
  assert.equal(iosFixture({ available: false }).install.getState(), 'unknown', 'no WatchConnectivity (an iPad)');
});

test('a build from Xcode installs from the Watch app, and only if it carries the watch app', async () => {
  const h = iosFixture({ kind: 'self-built', bundled: true });
  assert.equal(h.install.getSource(), 'watch-app');
  assert.equal(await h.install.openSource(), true);
  assert.deepEqual(h.opened, ['itms-watchs://']);

  // Built without FACECLAW_EMBED_WATCH=1: the Watch app would have nothing to list.
  h.bundled = false;
  assert.equal(h.install.getSource(), null);
  assert.equal(await h.install.openSource(), false);
  assert.equal(h.opened.length, 1, 'nothing more was opened');
});

test('a release installs from TestFlight or the Watch app, whatever is in its bundle', async () => {
  // The App Store delivers the watch app separately, so the phone app's bundle may not have it.
  const beta = iosFixture({ kind: 'official', bundled: false, receipt: 'sandboxReceipt' });
  assert.equal(beta.install.getSource(), 'testflight');
  await beta.install.openSource();
  assert.deepEqual(beta.opened, ['itms-beta://']);

  const store = iosFixture({ kind: 'official', bundled: false, receipt: 'receipt' });
  assert.equal(store.install.getSource(), 'watch-app');
  await store.install.openSource();
  assert.deepEqual(store.opened, ['itms-watchs://']);

  // A development build's receipt URL is also named sandboxReceipt; that mustn't send it to TestFlight.
  assert.equal(iosFixture({ kind: 'self-built', receipt: 'sandboxReceipt' }).install.getSource(), 'watch-app');
});

test('opening reports failure when iOS refuses', async () => {
  assert.equal(await iosFixture({ opens: false }).install.openSource(), false);
});

test('every listener hears a state change through the one native handler', () => {
  const h = iosFixture();
  const heard = [];
  const stopFirst = h.install.onStateChanged(() => heard.push('first'));
  h.install.onStateChanged(() => { throw new Error('a broken listener'); });
  h.install.onStateChanged(() => heard.push('third'));
  assert.equal(h.handlersSet, 1);
  h.handler();
  assert.deepEqual(heard, ['first', 'third'], 'one listener failing does not stop the rest');
  assert.equal(h.warnings.length, 1);
  stopFirst();
  h.handler();
  assert.deepEqual(heard, ['first', 'third', 'third']);
});

test('a request from the glasses opens at once when Faceclaw is in front', async () => {
  const h = iosFixture();
  assert.equal(await h.install.openSourceWhenInFront(), 'opened');
  assert.deepEqual(h.opened, ['itms-watchs://']);
  assert.equal(h.resumeListeners.length, 0, 'nothing is left waiting');

  assert.equal(await iosFixture({ opens: false }).install.openSourceWhenInFront(), 'failed');
  assert.equal(await iosFixture({ bundled: false, inFront: false }).install.openSourceWhenInFront(), 'failed', 'nothing to open');
});

test('with the phone in a pocket, the opening waits for Faceclaw to come to the front', async () => {
  // iOS refuses to let an app in the background open another.
  const h = iosFixture({ inFront: false });
  assert.equal(await h.install.openSourceWhenInFront(), 'waiting');
  assert.equal(await h.install.openSourceWhenInFront(), 'waiting', 'choosing the row again changes nothing');
  assert.deepEqual(h.opened, []);
  assert.equal(h.resumeListeners.length, 1);

  h.now += 30_000;
  h.resume();
  assert.deepEqual(h.opened, ['itms-watchs://']);
  // That was the one opening asked for: later returns to Faceclaw stay in Faceclaw.
  h.resume();
  assert.equal(h.opened.length, 1);
});

test('a waiting opening lapses, and is dropped if the watch got the app meanwhile', async () => {
  const late = iosFixture({ inFront: false });
  await late.install.openSourceWhenInFront();
  late.now += 10 * 60_000;
  late.resume();
  assert.deepEqual(late.opened, [], 'opening Faceclaw much later does not jump to the Watch app');

  // Automatic App Install got there first.
  const moot = iosFixture({ inFront: false });
  await moot.install.openSourceWhenInFront();
  moot.state = 'installed';
  moot.resume();
  assert.deepEqual(moot.opened, []);
});

test('Android has no watch install to offer', async () => {
  const { watchAppInstall } = loader()('app/native/watch-app-install.ts');
  assert.equal(watchAppInstall.getState(), 'unknown');
  assert.equal(watchAppInstall.getSource(), null);
  assert.equal(await watchAppInstall.openSource(), false);
  assert.equal(await watchAppInstall.openSourceWhenInFront(), 'failed');
  watchAppInstall.onStateChanged(() => {})();
});

function promptFixture({ state, source, opens = true }) {
  const h = { alerts: [], opened: 0 };
  const load = loader({}, {
    '@nativescript/core': { Dialogs: { alert: async options => { h.alerts.push(options); } } },
    '../native/watch-app-install': { watchAppInstall: {
      getState: () => state, getSource: () => source, openSource: async () => { h.opened++; return opens; },
    } },
  });
  Object.assign(h, load('app/phone-ui/watch-app-prompt.ts'));
  return h;
}

test('the prompt says nothing without a paired watch', () => {
  for (const state of ['unknown', 'no-watch']) {
    const prompt = promptFixture({ state, source: 'watch-app' }).watchAppPrompt();
    assert.equal(prompt.visible, false);
    assert.equal(prompt.canInstall, false);
    assert.equal(prompt.hint, '');
  }
});

test('the prompt offers the install, and says where it leads', () => {
  const viaWatchApp = promptFixture({ state: 'not-installed', source: 'watch-app' }).watchAppPrompt();
  assert.equal(viaWatchApp.visible, true);
  assert.equal(viaWatchApp.canInstall, true);
  assert.match(viaWatchApp.hint, /Watch app.*Available Apps/);

  const viaTestFlight = promptFixture({ state: 'not-installed', source: 'testflight' }).watchAppPrompt();
  assert.equal(viaTestFlight.canInstall, true);
  assert.match(viaTestFlight.hint, /TestFlight/);

  const installed = promptFixture({ state: 'installed', source: 'watch-app' }).watchAppPrompt();
  assert.deepEqual({ ...installed }, { visible: true, installed: true, canInstall: false, hint: '' });
});

test('a build without the watch app explains itself instead of offering a dead end', () => {
  const prompt = promptFixture({ state: 'not-installed', source: null }).watchAppPrompt();
  assert.equal(prompt.visible, true);
  assert.equal(prompt.canInstall, false);
  assert.match(prompt.hint, /without its watch app/);
});

test('the Install button opens the installer, and says what to do by hand if it will not open', async () => {
  const works = promptFixture({ state: 'not-installed', source: 'watch-app' });
  await works.openWatchAppInstall();
  assert.equal(works.opened, 1);
  assert.equal(works.alerts.length, 0);

  const refused = promptFixture({ state: 'not-installed', source: 'testflight', opens: false });
  await refused.openWatchAppInstall();
  assert.equal(refused.alerts.length, 1);
  assert.match(refused.alerts[0].message, /TestFlight/);

  const nothingToOffer = promptFixture({ state: 'not-installed', source: null });
  await nothingToOffer.openWatchAppInstall();
  assert.equal(nothingToOffer.opened, 0);
  assert.equal(nothingToOffer.alerts.length, 0);
});

/** The glasses' Settings > Watch row, over a fake of the phone side. */
function glassesFixture({ state = 'not-installed', source = 'watch-app', handover = 'opened' } = {}) {
  const h = { state, source, handover, requests: 0, renders: 0, pushed: [], listeners: new Set() };
  const load = loader({}, {
    '../../apps/files/text-viewer': { TextViewerLayer: class { constructor(text, title) { this.text = text; this.title = title; } } },
    '../../native/watch-app-install': { watchAppInstall: {
      getState: () => h.state, getSource: () => h.source,
      onStateChanged: listener => { h.listeners.add(listener); return () => h.listeners.delete(listener); },
      openSourceWhenInFront: async () => { h.requests++; return h.handover; },
    } },
  });
  h.rows = load('app/ui/dashboard/watch-app-install-menu.ts').watchAppInstallMenuItems;
  h.ctx = { stack: { push: layer => h.pushed.push(layer) }, actions: { requestRender: () => { h.renders++; } } };
  h.setState = next => { h.state = next; for (const listener of Array.from(h.listeners)) listener(); };
  return h;
}

test('the glasses offer the install only while a paired watch lacks the app', () => {
  for (const state of ['unknown', 'no-watch', 'installed']) assert.equal(glassesFixture({ state }).rows().length, 0, state);
  assert.equal(glassesFixture({ source: null }).rows().length, 0, 'a build with no watch app to give');

  const [row] = glassesFixture().rows();
  assert.equal(row.label, 'Install watch app');
  // The same steps as the phone's hint, plus where they happen.
  assert.equal(row.description, 'Opens the Watch app on your iPhone. Scroll down to Available Apps and tap Install next to Faceclaw.');
  assert.match(glassesFixture({ source: 'testflight' }).rows()[0].description, /^Opens TestFlight on your iPhone\. /);
});

test('choosing the row on the glasses opens the installer, or says to get the phone out', async () => {
  const direct = glassesFixture();
  await direct.rows()[0].onSelect(direct.ctx);
  assert.equal(direct.requests, 1);
  assert.equal(direct.pushed.length, 0, 'the phone is already showing the Watch app');

  const pocketed = glassesFixture({ handover: 'waiting' });
  await pocketed.rows()[0].onSelect(pocketed.ctx);
  assert.equal(pocketed.pushed.length, 1);
  assert.match(pocketed.pushed[0].text, /^Unlock your iPhone and open Faceclaw to go on to the Watch app\. Scroll down to Available Apps/);

  const refused = glassesFixture({ handover: 'failed', source: 'testflight' });
  await refused.rows()[0].onSelect(refused.ctx);
  assert.match(refused.pushed[0].text, /^Couldn't open TestFlight on your iPhone\./);
});

test('a row left on screen after the watch got the app only repaints', async () => {
  // Installed from the phone's own Settings page: nothing told the glasses' Settings to repaint.
  const h = glassesFixture();
  const [row] = h.rows();
  h.state = 'installed';
  await row.onSelect(h.ctx);
  assert.equal(h.requests, 0, 'the Watch app is not opened for an app the watch already has');
  assert.equal(h.renders, 1);
  assert.equal(h.pushed.length, 0);
});

test('Settings repaints when the watch gets the app, and then stops listening', async () => {
  const h = glassesFixture({ handover: 'waiting' });
  await h.rows()[0].onSelect(h.ctx);
  await h.rows()[0].onSelect(h.ctx);
  assert.equal(h.listeners.size, 1, 'choosing the row twice listens once');
  h.setState('not-installed');
  assert.equal(h.renders, 1);
  h.setState('installed');
  assert.equal(h.renders, 2);
  assert.equal(h.rows().length, 0, 'the row is gone');
  assert.equal(h.listeners.size, 0);
});
