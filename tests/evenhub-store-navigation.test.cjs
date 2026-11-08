// EvenHub store navigation: watch swipes on the tab strip, the Updates tab's
// Update All row, and page-at-a-time scrolling in the permission dialog.
//
// The real layers run with their dependencies mocked; what they paint is
// collected as text, so these assert what the user would see.
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

/** Stand-in for ui/menu-core's Menu: draws every row in order, scrolls the selection by one. */
class FakeMenu {
  constructor(options) {
    this.options = options;
    this.items = options.items;
    this.selectedIndex = 0;
    this.scrollTop = 0;
  }
  setItems(items, selectedIndex) {
    this.items = items;
    if (selectedIndex !== undefined) this.selectedIndex = selectedIndex;
    this.selectedIndex = Math.max(0, Math.min(this.selectedIndex, items.length - 1));
  }
  get selectedItem() { return this.items[this.selectedIndex] ?? null; }
  handleInput(event) {
    if (event.type === 'scroll-down') this.selectedIndex = Math.min(this.items.length - 1, this.selectedIndex + 1);
    if (event.type === 'scroll-up') this.selectedIndex = Math.max(0, this.selectedIndex - 1);
  }
  paint(image, box) {
    this.items.forEach((item, index) => this.options.draw({ image, item, index, x: box.x, y: box.y, width: box.width }));
  }
  drawScrollbar() {}
}

const storeApp = (packageId, name, version) => ({
  id: 1, packageId, name, version, creatorName: '', tagline: '', description: '', categories: [],
  installCount: 0, likeCount: 0, firstPublishedAt: '', iconPath: '', changelog: '', fileSize: 0,
});

const emptyPage = { apps: [], total: 0, page: 1, pageSize: 20 };

/** A signed-in store layer; `updates` is what the update check reports. */
const loadStore = ({ updates = [] } = {}) => {
  const drawn = [];
  const installs = [];
  const setting = { get: () => '', set() {} };
  const load = loader({}, {
    '../../graphics/ui-fonts': { getDefaultSmallFont: () => font },
    '../../graphics/image': { GrayImage: makeImageClass(drawn) },
    '../../graphics/textwrap': { truncateText: (_f, text) => text, wrapText: (_f, text) => [text] },
    '../../ui/gestures': { ...gestures, GESTURE_CLICK: 'click' },
    '../../ui/menu': { drawSelectionHighlight() {} },
    '../../ui/menu-core': { Menu: FakeMenu },
    '../../ui/shell/shell': { shell: { yieldFocusToSidebar() {} } },
    '../../ui/metrics': { lineStep: () => 12 },
    '../../ui/dashboard-settings': {
      ConfigSettingString: class { constructor(options) { this.value = options.defaultValue ?? ''; }
        get() { return this.value; } set(next) { this.value = next; return next; } },
    },
    './even-api': {
      evenHubApi: { listApps: async () => emptyPage, listNewApps: async () => emptyPage, searchApps: async () => emptyPage },
      EvenHubAuthenticationError: class extends Error {},
      isEvenHubStoreConfigured: () => true,
    },
    './credentials': {
      evenHubLoginEmailSetting: setting, evenHubLoginPasswordSetting: setting, evenHubRememberMeSetting: setting,
      clearEvenHubLoginForm() {}, resetEvenHubLoginForm() {}, clearEvenHubSession() {}, clearTransientEvenHubSession() {},
    },
    './installed-apps': { getInstalledEvenHubApps: () => updates.map((update) => update.installed), uninstallEvenHubPackage: () => true },
    './store-detail-layer': { EvenHubStoreDetailLayer: class {} },
    './store-install': {
      cleanError: (error) => String(error?.message ?? error),
      installStoreApp: async (_ctx, app) => { installs.push(app.packageId); return { packageId: app.packageId }; },
    },
    './updates': {
      checkForEvenHubUpdates: async () => updates,
      describeUpdate: () => ({ updateAvailable: false, packageMissing: false }),
    },
  });
  const { EvenHubStoreLayer } = load('app/apps/evenhub/store-layer.ts');
  const layer = new EvenHubStoreLayer({ launchApp: async () => {}, appendLog: () => {} });
  return { layer, drawn, installs };
};

const makeCtx = () => ({
  stack: {
    getBaseSize: () => ({ width: 576, height: 288 }),
    isFocused: () => true,
    clearToBase() {},
    push() {},
    pop() {},
  },
  actions: { requestRender() {}, endTextSettingEdit() {}, startTextSettingsEdit() {} },
});

const settle = () => new Promise((resolve) => setImmediate(resolve));

/** Repaint and return the drawn text. */
const repaint = (layer, drawn, ctx) => {
  drawn.length = 0;
  layer.paint(ctx);
  return [...drawn];
};

const watch = (type) => ({ type, source: 'watch', timestampMs: 0 });

test('watch swipes left and right switch tabs while the tab strip is focused', async () => {
  const { layer, drawn } = loadStore();
  const ctx = makeCtx();
  layer.paint(ctx);
  await settle();
  assert.ok(repaint(layer, drawn, ctx).includes('Public apps by popularity'));

  // In the list, a right swipe is "select" and must not change tabs.
  await layer.handleInput(watch('swipe-right'), ctx);
  await settle();
  assert.ok(repaint(layer, drawn, ctx).includes('Public apps by popularity'), 'still on Top');

  // A left swipe in the list is "back", which focuses the tab strip.
  await layer.handleInput(watch('swipe-left'), ctx);
  await layer.handleInput(watch('swipe-right'), ctx);
  await settle();
  assert.ok(repaint(layer, drawn, ctx).includes('Recently published apps'), 'right moved to New');

  await layer.handleInput(watch('swipe-left'), ctx);
  await settle();
  assert.ok(repaint(layer, drawn, ctx).includes('Public apps by popularity'), 'left moved back to Top');

  // Up/down still switch tabs too.
  await layer.handleInput(watch('swipe-down'), ctx);
  await settle();
  assert.ok(repaint(layer, drawn, ctx).includes('Recently published apps'), 'down moved to New');
});

/** Open the store and move to the Updates tab, with focus back in its list. */
const openUpdatesTab = async (layer, ctx) => {
  layer.paint(ctx);
  await settle();
  await layer.handleInput({ type: 'double-click', source: 'ring' }, ctx);
  for (let i = 0; i < 3; i++) await layer.handleInput({ type: 'scroll-down' }, ctx);
  await settle();
  await layer.handleInput({ type: 'click', source: 'ring' }, ctx);
};

test('the Updates tab lists Update All first and it installs every update', async () => {
  const updates = [
    { installed: { packageId: 'a', name: 'Alpha', version: '1' }, latest: storeApp('a', 'Alpha', '2'), packageMissing: false },
    { installed: { packageId: 'b', name: 'Beta', version: '1' }, latest: storeApp('b', 'Beta', '3'), packageMissing: false },
    { installed: { packageId: 'c', name: 'Gamma', version: '1' } },
  ];
  const { layer, drawn, installs } = loadStore({ updates });
  const ctx = makeCtx();
  await openUpdatesTab(layer, ctx);

  const painted = repaint(layer, drawn, ctx);
  assert.ok(painted.includes('Updates (3)'), `the tab count is apps, not rows: ${JSON.stringify(painted)}`);
  assert.ok(painted.includes('3 apps need attention'));
  const updateAll = painted.indexOf('Update All');
  assert.ok(updateAll >= 0, `painted: ${JSON.stringify(painted)}`);
  assert.ok(painted.includes('Install all 2 available updates'), 'the orphan is not counted');
  assert.ok(updateAll < painted.indexOf('Alpha') && updateAll < painted.indexOf('Gamma'), 'Update All is the first row');

  // The list opens on Update All; clicking it installs both updatable apps.
  await layer.handleInput({ type: 'click', source: 'ring' }, ctx);
  await settle();
  assert.deepEqual(installs, ['a', 'b']);
  const after = repaint(layer, drawn, ctx);
  assert.ok(!after.includes('Update All'), 'nothing left to update, so the row goes');
  assert.ok(after.includes('Gamma'), 'the missing package stays listed');
  assert.ok(after.includes('Updated 2 apps.'));
});

test('the Updates tab has no Update All row when nothing can be installed', async () => {
  const updates = [{ installed: { packageId: 'c', name: 'Gamma', version: '1' } }];
  const { layer, drawn } = loadStore({ updates });
  const ctx = makeCtx();
  await openUpdatesTab(layer, ctx);
  const painted = repaint(layer, drawn, ctx);
  assert.ok(painted.includes('Gamma'));
  assert.ok(!painted.includes('Update All'));
});

// ---- permission dialog ---------------------------------------------------

const loadDialog = (detailLines) => {
  const drawn = [];
  const load = loader({}, {
    '../../graphics/ui-fonts': { getDefaultSmallFont: () => font },
    '../../graphics/image': { GrayImage: makeImageClass(drawn) },
    '../../graphics/textwrap': { truncateText: (_f, text) => text, wrapText: (_f, text) => text.split('|') },
    '../../ui/gestures': gestures,
    '../../ui/layers': {},
    '../../ui/menu': { drawListScrollbar() {}, drawSelectionHighlight() {} },
    './permissions': { permissionDetail: (permission) => permission.detail, permissionLabel: (name) => name },
    './privacy-policy': { openPrivacyPolicyOnPhone() {} },
    '../../ui/metrics': { lineStep: () => 12, listRowHeight: () => 20 },
  });
  const { EvenHubPermissionDialogLayer } = load('app/apps/evenhub/permission-dialog.ts');
  const ImageClass = makeImageClass(drawn);
  const outcome = { confirmed: null };
  const dialog = new EvenHubPermissionDialogLayer(
    'Demo',
    [{ name: 'network', detail: detailLines.join('|') }],
    '',
    () => { outcome.confirmed = true; },
    () => { outcome.confirmed = false; },
  );
  const ctx = { stack: { getBaseSize: () => ({ width: 576, height: 136 }), isFocused: () => true, pop() {} } };
  const paint = () => {
    drawn.length = 0;
    dialog.paint(ctx, () => new ImageClass());
    return [...drawn];
  };
  return { dialog, ctx, paint, outcome };
};

test('the permission dialog scrolls a page at a time with one line of overlap', () => {
  const lines = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`);
  const { dialog, ctx, paint, outcome } = loadDialog(lines);

  const pages = [paint()];
  while (!pages[pages.length - 1].includes('Allow')) {
    assert.ok(pages.length < 20, 'paging reaches the actions');
    dialog.handleInput({ type: 'scroll-down' }, ctx);
    pages.push(paint());
  }
  assert.ok(pages.length >= 3, `the list is long enough to need several pages (${pages.length})`);
  // Every page but the last (which stops at the bottom) starts on the line the previous one ended on.
  for (let page = 1; page < pages.length - 1; page++) {
    const previous = pages[page - 1];
    assert.equal(pages[page][0], previous[previous.length - 1], `page ${page + 1} overlaps page ${page} by one line`);
    assert.ok(pages[page].length > 2, 'a page moves by more than one line');
  }
  // Every line was on screen on some page.
  for (const line of lines) assert.ok(pages.some((page) => page.includes(line)), `${line} was shown`);

  // Paging up from the bottom: the old first line becomes the new last one.
  const bottom = pages[pages.length - 1];
  dialog.handleInput({ type: 'scroll-up' }, ctx);
  const up = paint();
  assert.equal(up[up.length - 1], bottom[0], 'one line of overlap going up');
  assert.ok(up.length > 2);
  for (let i = 0; i < pages.length; i++) dialog.handleInput({ type: 'scroll-up' }, ctx);
  assert.deepEqual(paint(), pages[0], 'back at the top');

  // A click before the bottom pages down rather than allowing; scrolling up returns.
  dialog.handleInput({ type: 'click', source: 'ring' }, ctx);
  assert.deepEqual(paint(), pages[1]);
  assert.equal(outcome.confirmed, null);
  dialog.handleInput({ type: 'scroll-up' }, ctx);
  assert.deepEqual(paint(), pages[0]);
});
