// The EvenHub sign-in form's open/close contract, which is what made it
// impossible to get rid of: it used to open itself on the store layer's first
// paint (which includes the restore of a still-open EvenHub at startup), and
// submitting an untouched form reopened it, so with no Cancel control on the
// panel there was no way out.
//
// The real store layer runs here with its dependencies mocked, so these assert
// the layer's actual behavior rather than a reimplementation of it.
const test = require('node:test');
const assert = require('node:assert/strict');
const { loader } = require('./helpers/load-typescript.cjs');

const setting = (initial = '') => {
  let value = initial;
  return { get: () => value, set: (next) => { value = next; } };
};

class AuthError extends Error {}

/**
 * Load the store layer, by default with a signed-out account and no stored
 * credentials. `api` overrides evenHubApi methods; text the layer paints is
 * collected in `drawn`, and the options each app page is opened with in
 * `detailOptions`.
 */
const loadStoreLayer = ({ configured = false, api = {} } = {}) => {
  const email = setting('');
  const password = setting('');
  const drawn = [];
  const detailOptions = [];
  const font = { lineHeight: 10, measureText: (text) => text.length * 6 };
  const load = loader({}, {
    '../../graphics/ui-fonts': { getDefaultSmallFont: () => font },
    '../../graphics/image': { GrayImage: class { drawText(_f, _x, _y, text) { drawn.push(text); } fillRect() {} } },
    '../../graphics/textwrap': { truncateText: (_f, text) => text, wrapText: (_f, text) => [text] },
    '../../util/numeric-util': { clamp: (v, lo, hi) => Math.min(hi, Math.max(lo, v)) },
    '../../ui/gestures': { GESTURE_CLICK: 'click' },
    '../../ui/menu': { drawSelectionHighlight() {} },
    '../../ui/menu-core': require('../.test-build/app/ui/menu-core.js'),
    '../../ui/shell/shell': { shell: { yieldFocusToSidebar() {} } },
    '../../ui/metrics': { lineStep: () => 12 },
    '../../ui/dashboard-settings': {
      ConfigSettingString: class { constructor(options) { this.value = options.defaultValue ?? ''; }
        get() { return this.value; } set(next) { this.value = next; } },
    },
    './even-api': {
      evenHubApi: { signIn: async () => {}, ...api },
      EvenHubAuthenticationError: AuthError,
      isEvenHubStoreConfigured: () => configured,
    },
    './credentials': {
      evenHubLoginEmailSetting: email,
      evenHubLoginPasswordSetting: password,
      evenHubRememberMeSetting: { get: () => true, set() {} },
      clearEvenHubLoginForm() { email.set(''); password.set(''); },
      resetEvenHubLoginForm() { email.set(''); password.set(''); },
      clearEvenHubSession() {}, clearTransientEvenHubSession() {},
    },
    './installed-apps': { getInstalledEvenHubApps: () => [], uninstallEvenHubPackage: async () => {} },
    './store-detail-layer': { EvenHubStoreDetailLayer: class { constructor(_app, options) { detailOptions.push(options); } } },
    './store-install': { cleanError: (error) => String(error?.message ?? error), installStoreApp: async () => {} },
    './updates': { checkForEvenHubUpdates: async () => [], describeUpdate: () => '' },
  });
  const { EvenHubStoreLayer } = load('app/apps/evenhub/store-layer.ts');
  return { EvenHubStoreLayer, email, password, drawn, detailOptions };
};

/** A LayerContext that records every editor the layer asks the phone to open. */
const makeCtx = () => {
  const opened = [];
  const stack = {
    cleared: 0,
    pushed: [],
    getBaseSize: () => ({ width: 576, height: 136 }),
    isFocused: () => true,
    clearToBase() { stack.cleared++; stack.pushed.length = 0; },
    push(layer) { stack.pushed.push(layer); },
  };
  return {
    opened,
    stack,
    actions: {
      requestRender() {},
      endTextSettingEdit() {},
      startTextSettingsEdit(settings, title, onFinish, toggle, onCancel) {
        opened.push({ title, onFinish, onCancel });
      },
    },
  };
};

const newLayer = () => {
  const { EvenHubStoreLayer } = loadStoreLayer();
  return new EvenHubStoreLayer({ launchApp: async () => {}, appendLog: () => {} });
};

const settle = () => new Promise((resolve) => setImmediate(resolve));

test('painting the signed-out store does not open the phone sign-in form by itself', () => {
  const layer = newLayer(), ctx = makeCtx();
  layer.paint(ctx);
  layer.paint(ctx);
  assert.deepEqual(ctx.opened, [], 'first paint runs on app-start restore too, so it must not open the editor');
});

test('a click on the login pane opens the sign-in form', () => {
  const layer = newLayer(), ctx = makeCtx();
  layer.paint(ctx);
  layer.handleInput({ type: 'click' }, ctx);
  assert.equal(ctx.opened.length, 1);
  assert.equal(ctx.opened[0].title, 'Sign in to EvenHub');
  assert.equal(typeof ctx.opened[0].onCancel, 'function', 'the editor must hand back a way to close it');
});

test('submitting an untouched sign-in form closes it instead of reopening it', async () => {
  const layer = newLayer(), ctx = makeCtx();
  layer.paint(ctx);
  layer.handleInput({ type: 'click' }, ctx);
  ctx.opened[0].onFinish();
  await settle();
  assert.equal(ctx.opened.length, 1, 'an empty submission is the only way out, so it must not reopen the editor');
});

test('a half-filled sign-in form is a mistake and reopens with the reason', async () => {
  const { EvenHubStoreLayer, email } = loadStoreLayer();
  const layer = new EvenHubStoreLayer({ launchApp: async () => {}, appendLog: () => {} });
  const ctx = makeCtx();
  layer.paint(ctx);
  layer.handleInput({ type: 'click' }, ctx);
  email.set('someone@example.com');
  ctx.opened[0].onFinish();
  await settle();
  assert.equal(ctx.opened.length, 2);
  assert.equal(ctx.opened[1].title, 'Sign in to EvenHub');
});

test('cancelling the sign-in form leaves it reopenable', () => {
  const layer = newLayer(), ctx = makeCtx();
  layer.paint(ctx);
  layer.handleInput({ type: 'click' }, ctx);
  ctx.opened[0].onCancel();
  layer.handleInput({ type: 'click' }, ctx);
  assert.equal(ctx.opened.length, 2, 'a dropped onCancel latches the guard and no later open is allowed');
});

test('an expired session drops the store back to the logged-out pane', async () => {
  const { EvenHubStoreLayer, drawn } = loadStoreLayer({
    configured: true,
    api: { listApps: async () => { throw new AuthError('Your login is expired'); } },
  });
  const layer = new EvenHubStoreLayer({ launchApp: async () => {}, appendLog: () => {} });
  const ctx = makeCtx();
  layer.paint(ctx);
  await settle();
  assert.equal(layer.buildMenuItems().length, 0, 'the signed-in menu (Refresh, Log Out) is gone');
  assert.equal(ctx.stack.cleared, 1, 'pages above the list needed the session too');
  assert.deepEqual(ctx.opened, [], 'this can happen on a startup restore, so the form must not pop up by itself');
  drawn.length = 0;
  layer.paint(ctx);
  assert.ok(drawn.includes('Signed out: Your login is expired'), `painted: ${JSON.stringify(drawn)}`);
  layer.handleInput({ type: 'click' }, ctx);
  assert.equal(ctx.opened.length, 1, 'a click on the pane opens the sign-in form');
});

test('an expired session on an app page drops the store back to the logged-out pane', () => {
  const { EvenHubStoreLayer, detailOptions } = loadStoreLayer({
    configured: true,
    api: { listApps: () => new Promise(() => {}) },
  });
  const layer = new EvenHubStoreLayer({ launchApp: async () => {}, appendLog: () => {} });
  const ctx = makeCtx();
  layer.paint(ctx);
  layer.showInstalledPackage(ctx.stack, { packageId: 'com.example.app', name: 'Example' });
  assert.equal(ctx.stack.pushed.length, 1);
  const { onAuthError } = detailOptions[0];
  assert.equal(onAuthError(ctx, new Error('network down')), false, 'other failures stay on the page');
  assert.ok(layer.buildMenuItems().length > 0);
  assert.equal(onAuthError(ctx, new AuthError('Your login is expired')), true);
  assert.equal(ctx.stack.pushed.length, 0, 'the app page is closed');
  assert.equal(layer.buildMenuItems().length, 0);
});

test('an API envelope with code 401 is a rejected session and forgets the token', async () => {
  let token = 'stale-token';
  let invalidated = 0;
  const api = loader({ setTimeout, clearTimeout }, {
    './even-platform': { getPhoneOpenUdid: () => 'fixture-terminal', hmacSha256Base64: () => 'fixture-signature' },
    './credentials': {
      getEvenHubToken: () => token, hasEvenHubCredentials: () => !!token,
      saveEvenHubSession() {}, invalidateEvenHubToken() { invalidated++; token = ''; },
    },
    '../../util/http': {
      fetchWithUserAgent: async () => ({ status: 200, json: async () => ({ code: 401, msg: 'Your login is expired' }) }),
    },
  })('app/apps/evenhub/even-api.ts');
  await assert.rejects(api.evenHubApi.listApps(), (error) => {
    assert.ok(error instanceof api.EvenHubAuthenticationError, `got ${error}`);
    assert.equal(error.message, 'Your login is expired');
    return true;
  });
  assert.equal(invalidated, 1);
  assert.equal(api.isEvenHubStoreConfigured(), false);
});
