// EvenHub with a RayNeo iO paired: the store shows only a notice (and loads
// nothing), and each sideloaded app warns once that it won't display
// correctly. The real layers run with their dependencies mocked; what they
// paint is collected as text.
const test = require('node:test');
const assert = require('node:assert/strict');
const { loader } = require('./helpers/load-typescript.cjs');

const gestures = loader({}, {})('app/ui/gestures.ts');
const font = { lineHeight: 10, measureText: (text) => text.length * 6 };

/** Records drawn text; every other drawing call is a no-op. */
const makeImageClass = (drawn) => class {
  drawText(_font, _x, _y, text) { drawn.push(text); }
  fillRect() {}
  fillRoundedRect() {}
  drawRoundedRect() {}
};

const settle = () => new Promise((resolve) => setImmediate(resolve));

// ---- the store -----------------------------------------------------------

const emptyPage = { apps: [], total: 0, page: 1, pageSize: 20 };

class FakeMenu {
  constructor(options) { this.options = options; this.items = options.items; this.selectedIndex = 0; }
  setItems(items) { this.items = items; }
  get selectedItem() { return this.items[this.selectedIndex] ?? null; }
  handleInput() {}
  paint(image, box) { this.items.forEach((item, index) => this.options.draw({ image, item, index, x: box.x, y: box.y, width: box.width })); }
  drawScrollbar() {}
}

const loadStore = () => {
  const drawn = [];
  const glasses = { available: false };
  const calls = { listApps: 0, yields: 0 };
  const setting = { get: () => '', set() {} };
  const load = loader({}, {
    '../../graphics/ui-fonts': { getDefaultSmallFont: () => font },
    '../../graphics/image': { GrayImage: makeImageClass(drawn) },
    '../../graphics/textwrap': { truncateText: (_f, text) => text, wrapText: (_f, text) => [text] },
    '../../ui/gestures': { ...gestures, GESTURE_CLICK: 'click' },
    '../../ui/menu': { drawSelectionHighlight() {} },
    '../../ui/menu-core': { Menu: FakeMenu },
    '../../ui/shell/shell': { shell: { yieldFocusToSidebar() { calls.yields++; } } },
    '../../ui/metrics': { lineStep: () => 12 },
    '../../ui/dashboard-settings': {
      ConfigSettingString: class { constructor(options) { this.value = options.defaultValue ?? ''; }
        get() { return this.value; } set(next) { this.value = next; return next; } },
    },
    './even-api': {
      evenHubApi: {
        listApps: async () => { calls.listApps++; return emptyPage; },
        listNewApps: async () => emptyPage,
        searchApps: async () => emptyPage,
      },
      EvenHubAuthenticationError: class extends Error {},
      isEvenHubStoreConfigured: () => true,
    },
    './credentials': {
      evenHubLoginEmailSetting: setting, evenHubLoginPasswordSetting: setting, evenHubRememberMeSetting: setting,
      clearEvenHubLoginForm() {}, resetEvenHubLoginForm() {}, clearEvenHubSession() {}, clearTransientEvenHubSession() {},
    },
    './installed-apps': { getInstalledEvenHubApps: () => [], uninstallEvenHubPackage: () => true },
    './store-detail-layer': { EvenHubStoreDetailLayer: class {} },
    './store-install': { cleanError: (error) => String(error), installStoreApp: async () => ({}) },
    './updates': { checkForEvenHubUpdates: async () => [], describeUpdate: () => ({}) },
    './glasses-compat': { isEvenHubStoreAvailable: () => glasses.available },
  });
  const { EvenHubStoreLayer } = load('app/apps/evenhub/store-layer.ts');
  const layer = new EvenHubStoreLayer({ launchApp: async () => {}, appendLog: () => {} });
  const stackCalls = { push: 0, clearToBase: 0 };
  const ctx = {
    stack: {
      getBaseSize: () => ({ width: 476, height: 180 }),
      isFocused: () => true,
      clearToBase() { stackCalls.clearToBase++; },
      push() { stackCalls.push++; },
      pop() {},
    },
    actions: { requestRender() {}, endTextSettingEdit() {}, startTextSettingsEdit() {} },
  };
  const repaint = () => {
    drawn.length = 0;
    layer.paint(ctx);
    return [...drawn];
  };
  return { layer, ctx, glasses, calls, stackCalls, repaint };
};

const NOTICE = 'Using the Even Realities app store requires Even Realities glasses.';

test('with a RayNeo iO the store shows the notice and loads nothing', async () => {
  const { layer, ctx, calls, repaint } = loadStore();
  const painted = repaint();
  assert.ok(painted.includes(NOTICE), JSON.stringify(painted));
  assert.ok(!painted.includes('Top'), 'no tabs');
  await settle();
  assert.equal(calls.listApps, 0, 'no request to the store');
  assert.equal(layer.buildMenuItems().length, 0, 'no store actions in the window menu');

  await layer.handleInput({ type: 'click', source: 'ring' }, ctx);
  await layer.handleInput({ type: 'scroll-down' }, ctx);
  layer.receiveTextInput('chess', ctx);
  await settle();
  assert.equal(calls.listApps, 0, 'input and dictation do nothing');
  assert.ok(repaint().includes(NOTICE));

  await layer.handleInput({ type: 'double-click', source: 'ring' }, ctx);
  await layer.handleInput({ type: 'swipe-left', source: 'watch', timestampMs: 0 }, ctx);
  assert.equal(calls.yields, 2, 'double-click and a back swipe leave the window');
});

test('an installed app\'s store page opens to the notice, naming the app', () => {
  const { layer, ctx, stackCalls, repaint } = loadStore();
  layer.showInstalledPackage(ctx.stack, { packageId: 'com.example.alpha', name: 'Alpha', version: '1' });
  assert.equal(stackCalls.push, 0, 'no store page is opened');
  assert.equal(stackCalls.clearToBase, 1, 'pages above the notice are closed');
  const painted = repaint();
  assert.ok(painted.includes("Alpha's package is missing."), JSON.stringify(painted));
  assert.ok(painted.includes(NOTICE));
});

test('the store comes back once Even Realities glasses are paired', async () => {
  const { glasses, calls, repaint } = loadStore();
  repaint();
  glasses.available = true;
  repaint();
  await settle();
  assert.equal(calls.listApps, 1, 'the Top tab loads on the first paint it gets');
  const painted = repaint();
  assert.ok(!painted.includes(NOTICE));
  assert.ok(painted.includes('Public apps by popularity'), JSON.stringify(painted));
});

// ---- the display warning ---------------------------------------------------

const loadWarning = () => {
  const drawn = [];
  const load = loader({}, {
    '../../graphics/ui-fonts': { getDefaultSmallFont: () => font },
    '../../graphics/image': { GrayImage: makeImageClass(drawn) },
    '../../graphics/textwrap': { wrapText: (_f, text) => [text] },
    '../../ui/gestures': gestures,
    '../../ui/layers': {},
    '../../ui/menu': { drawListScrollbar() {}, drawSelectionHighlight() {} },
    '../../ui/metrics': { lineStep: () => 12, listRowHeight: () => 20 },
  });
  const { EvenHubDisplayWarningLayer } = load('app/apps/evenhub/display-warning-dialog.ts');
  const ImageClass = makeImageClass(drawn);
  const outcome = { answered: 0, closed: 0, popped: 0 };
  const dialog = new EvenHubDisplayWarningLayer(
    'Demo',
    () => { outcome.answered++; },
    () => { outcome.closed++; },
  );
  // The real stack calls onRemoved as it pops.
  const ctx = {
    stack: {
      getBaseSize: () => ({ width: 476, height: 180 }),
      isFocused: () => true,
      pop() { outcome.popped++; dialog.onRemoved(); },
    },
  };
  const paint = () => {
    drawn.length = 0;
    dialog.paint(ctx, () => new ImageClass());
    return [...drawn];
  };
  return { dialog, ctx, paint, outcome };
};

test('the display warning names the app and the reason', () => {
  const { paint } = loadWarning();
  const painted = paint();
  assert.ok(painted.includes('Compatibility warning'));
  const message = painted.find((text) => text.includes('Demo'));
  assert.ok(message, JSON.stringify(painted));
  assert.match(message, /will not display correctly on the RayNeo iO/);
  assert.match(message, /different resolution/);
  assert.ok(painted.includes('Continue') && painted.includes('Close app'));
});

test('Continue dismisses the warning and leaves the app running', () => {
  const { dialog, ctx, paint, outcome } = loadWarning();
  paint();
  dialog.handleInput({ type: 'click', source: 'ring' }, ctx);
  assert.deepEqual(outcome, { answered: 1, closed: 0, popped: 1 });
});

test('Close app dismisses the warning and closes the app', () => {
  const { dialog, ctx, paint, outcome } = loadWarning();
  paint();
  dialog.handleInput({ type: 'scroll-down' }, ctx);
  dialog.handleInput({ type: 'click', source: 'ring' }, ctx);
  assert.deepEqual(outcome, { answered: 1, closed: 1, popped: 1 });
});

test('double-click dismisses the warning; closing the window under it does not count', () => {
  const backedOut = loadWarning();
  backedOut.paint();
  backedOut.dialog.handleInput({ type: 'double-click', source: 'ring' }, backedOut.ctx);
  assert.deepEqual(backedOut.outcome, { answered: 1, closed: 0, popped: 1 });

  const abandoned = loadWarning();
  abandoned.paint();
  abandoned.dialog.onRemoved();
  assert.deepEqual(abandoned.outcome, { answered: 0, closed: 0, popped: 0 }, 'shown again next launch');
});

// ---- which launches warn -------------------------------------------------

const loadCompat = (glassesType) => {
  const store = new Map();
  const glasses = { type: glassesType };
  const compat = loader({}, {
    '../../ui/dashboard-settings': { glassesTypeSetting: { get: () => glasses.type } },
    '../../native/settings-store': {
      getStringSetting: (key, fallback) => (store.has(key) ? store.get(key) : fallback),
      setStringSetting: (key, value) => { store.set(key, value); },
    },
  })('app/apps/evenhub/glasses-compat.ts');
  return { compat, glasses };
};

test('each app warns once with a RayNeo iO paired, and never with Even glasses', () => {
  const { compat, glasses } = loadCompat('rayneo-io');
  assert.equal(compat.isEvenHubStoreAvailable(), false);
  assert.equal(compat.needsDisplayWarning('com.example.a'), true);
  compat.markDisplayWarningShown('com.example.a');
  compat.markDisplayWarningShown('com.example.a');
  assert.equal(compat.needsDisplayWarning('com.example.a'), false, 'answered once');
  assert.equal(compat.needsDisplayWarning('com.example.b'), true, 'another app still warns');

  glasses.type = 'g2';
  assert.equal(compat.isEvenHubStoreAvailable(), true);
  assert.equal(compat.needsDisplayWarning('com.example.b'), false);
  glasses.type = 'g1';
  assert.equal(compat.isEvenHubStoreAvailable(), true);
  assert.equal(compat.needsDisplayWarning('com.example.b'), false);
});

// ---- the app window ------------------------------------------------------

const loadWindow = (needsWarning) => {
  const pushed = [];
  const closed = [];
  const marked = [];
  class FakeWarning { constructor(appName, onAnswered, closeApp) { Object.assign(this, { appName, onAnswered, closeApp }); } }
  const load = loader({}, {
    '../../graphics/image': { GrayImage: class {} },
    './compositor': { EVENHUB_SCREEN_WIDTH: 576 },
    '../../ui/gestures': gestures,
    '../../ui/layers': {},
    '../../ui/shell/in-process-window': {
      createInProcessWindow: () => ({
        stack: { push: (layer) => pushed.push(layer) },
        window: { handleInput: async () => {} },
        requestRender() {},
        setHeightMode() {},
      }),
    },
    '../../ui/shell/shell': { shell: { closeWindow: (id) => closed.push(id), foregroundWindow: () => null } },
    '../../ui/shell/chrome-layer': { makeImageWindowIcon: () => () => {}, windowIcon: () => () => {} },
    './session': { EvenHubSession: class {} },
    './installed-apps': { renderInstalledEvenHubIcon: () => null },
    './glasses-compat': {
      needsDisplayWarning: () => needsWarning,
      markDisplayWarningShown: (id) => marked.push(id),
    },
    './display-warning-dialog': { EvenHubDisplayWarningLayer: FakeWarning },
  });
  const { createEvenHubWindow } = load('app/apps/evenhub/evenhub-window.ts');
  const session = {
    manifest: { packageId: 'com.example.demo', name: 'Demo' },
    attachWindow() {},
  };
  const options = { actions: {}, submitFrame() {}, setSurfaceVisible() {}, removeSurface() {}, onClosed() {} };
  createEvenHubWindow('evenhub:app:7', 'evenhub', session, options, () => {}, () => {});
  return { pushed, closed, marked, FakeWarning };
};

test('an EvenHub window opens under the warning when the app needs one', () => {
  const { pushed, closed, marked, FakeWarning } = loadWindow(true);
  assert.equal(pushed.length, 1);
  const warning = pushed[0];
  assert.ok(warning instanceof FakeWarning);
  assert.equal(warning.appName, 'Demo');
  warning.onAnswered();
  assert.deepEqual(marked, ['com.example.demo']);
  warning.closeApp();
  assert.deepEqual(closed, ['evenhub:app:7']);
});

test('an EvenHub window opens straight to the app otherwise', () => {
  assert.equal(loadWindow(false).pushed.length, 0);
});
