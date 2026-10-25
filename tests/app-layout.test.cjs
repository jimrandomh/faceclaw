const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const read = (file) => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
const js = (source) => ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;

function geometry() {
  const settings = Object.fromEntries(Object.entries({
    displayLayoutSetting: 'band-middle', navigateDisplayLayoutSetting: 'global', terminalDisplayLayoutSetting: 'default',
    appSwitcherPositionSetting: 'left', uiDepthSetting: '0', statusBarPositionSetting: 'top',
    statusBarVisibilitySetting: 'always', windowBorderSetting: true,
  }).map(([name, value]) => [name, { value, get() { return this.value; } }]));
  const context = { exports: {}, require: (name) => {
    if (name === '../../graphics/image') return { G2_LENS_WIDTH: 640, G2_LENS_HEIGHT: 480 };
    assert.equal(name, '../dashboard-settings');
    return settings;
  } };
  vm.runInNewContext(js(read('app/ui/shell/geometry.ts')), context);
  const rect = (mode, appId) => ({ ...context.exports.appViewportRect(mode, appId) });
  return { ...context.exports, settings, rect };
}

const LAYOUTS = ['band-top', 'band-high', 'band-middle', 'band-low', 'band-bottom', 'tall', 'fullscreen'];

test('defaults preserve normal windows, EvenHub height and tall terminal sessions', () => {
  const g = geometry();
  assert.deepEqual(g.rect('min', 'navigate'), { x: 64, y: 124, width: 576, height: 260 });
  assert.deepEqual(g.rect('min', 'terminal'), g.rect('min'));
  assert.deepEqual(g.rect('max', 'terminal'), { x: 64, y: 28, width: 576, height: 452 });
  assert.equal(g.windowBandHeight('medium', 'evenhub'), 316);
  // Tall: every window the whole height, beside the strip.
  g.settings.displayLayoutSetting.value = 'tall';
  assert.deepEqual(g.rect('min'), { x: 64, y: 28, width: 576, height: 452 });
});

test('Navigate can use a small bottom band while other apps are tall', () => {
  const g = geometry();
  g.settings.displayLayoutSetting.value = 'tall';
  g.settings.navigateDisplayLayoutSetting.value = 'band-bottom';
  assert.deepEqual(g.rect('min', 'navigate'), { x: 64, y: 220, width: 576, height: 260 });
  assert.equal(g.minWindowTop('navigate'), 192);
  assert.deepEqual(g.rect('min', 'other'), { x: 64, y: 28, width: 576, height: 452 });
});

test('Terminal can disable its tall default, follow the global band or choose a mode of its own', () => {
  const g = geometry();
  g.settings.terminalDisplayLayoutSetting.value = 'global';
  assert.deepEqual(g.rect('max', 'terminal'), g.rect('min'));
  g.settings.displayLayoutSetting.value = 'band-top';
  assert.equal(g.windowTop('max', 'terminal'), 0);
  g.settings.terminalDisplayLayoutSetting.value = 'band-low';
  assert.equal(g.windowTop('max', 'terminal'), 144);
  g.settings.terminalDisplayLayoutSetting.value = 'tall';
  assert.deepEqual(g.rect('min', 'terminal'), { x: 64, y: 28, width: 576, height: 452 });
  // The default keeps sessions tall and the sessions list in the global band.
  g.settings.terminalDisplayLayoutSetting.value = 'default';
  assert.deepEqual(g.rect('max', 'terminal'), { x: 64, y: 28, width: 576, height: 452 });
  assert.equal(g.windowTop('min', 'terminal'), 0);
});

test('Full Screen widens Tall windows to the panel and drops depth, beside a bottom row or popup only', () => {
  const g = geometry();
  g.settings.displayLayoutSetting.value = 'fullscreen';
  g.settings.uiDepthSetting.value = '48';
  // A side strip leaves no width to spare: there it is Tall.
  assert.equal(g.displayLayout(), 'tall');
  assert.deepEqual(g.rect('min'), { x: 64, y: 28, width: 576, height: 452 });
  g.settings.appSwitcherPositionSetting.value = 'bottom';
  assert.equal(g.displayLayout(), 'fullscreen');
  // Tall's height and the panel's width, the row still reserved under it,
  // always shown; no room for a frame, nor for depth.
  assert.deepEqual(g.rect('min'), { x: 0, y: 28, width: 640, height: 416 });
  assert.deepEqual({ ...g.switcherRect('min') }, { x: 0, y: 444, width: 640, height: 36 });
  assert.equal(g.sidebarStripVisible('window'), true);
  assert.equal(g.windowFramed(), false);
  assert.equal(g.uiDepth(), 0);
  // With the status bar in the row, there's no frame top for a header either.
  g.settings.statusBarPositionSetting.value = 'bottom';
  assert.equal(g.statusInSwitcherRow(), true);
  assert.deepEqual(g.rect('min'), { x: 0, y: 0, width: 640, height: 444 });
  // A popup's status bar keeps its edge.
  g.settings.appSwitcherPositionSetting.value = 'popup';
  assert.deepEqual(g.rect('max'), { x: 0, y: 0, width: 640, height: 452 });
  assert.equal(g.statusBarTop('max'), 452);
  assert.equal(g.windowFramed(), false);
  // Per app: depth follows the foreground app's mode.
  g.settings.displayLayoutSetting.value = 'band-middle';
  g.settings.navigateDisplayLayoutSetting.value = 'fullscreen';
  assert.deepEqual([g.uiDepth('navigate'), g.uiDepth('launcher'), g.uiDepth()], [0, 48, 48]);
  assert.deepEqual([g.rect('min', 'navigate').width, g.rect('min', 'launcher').width], [640, 576]);
});

test('all display modes and layouts stay within the display and align content below the bar', () => {
  const g = geometry();
  g.settings.uiDepthSetting.value = '48';
  const combos = [['left', 'top'], ['right', 'top'], ['bottom', 'top'], ['bottom', 'bottom'], ['left', 'bottom']];
  for (const statusBar of ['top', 'bottom']) {
    for (const visibility of ['always', 'switcher']) {
      for (const border of [true, false]) combos.push(['popup', statusBar, visibility, border]);
    }
  }
  for (const [switcher, statusBar, visibility = 'always', border = true] of combos) {
    g.settings.appSwitcherPositionSetting.value = switcher;
    g.settings.statusBarPositionSetting.value = statusBar;
    g.settings.statusBarVisibilitySetting.value = visibility;
    g.settings.windowBorderSetting.value = border;
    const side = switcher === 'left' || switcher === 'right';
    for (const globalMode of LAYOUTS) {
      g.settings.displayLayoutSetting.value = globalMode;
      for (const appId of ['navigate', 'terminal']) {
        for (const mode of ['default', 'global', ...LAYOUTS]) {
          g.settings[`${appId}DisplayLayoutSetting`].value = mode;
          const wide = g.displayLayout(appId) === 'fullscreen';
          if (wide) assert.equal(side, false, 'Full Screen only beside a bottom row or popup');
          assert.equal(g.uiDepth(appId), side || wide ? 0 : 48);
          for (const heightMode of ['min', 'medium', 'max']) {
            const rect = g.rect(heightMode, appId);
            assert.equal(rect.x + rect.width, wide ? 640 : { left: 640, right: 576, bottom: 608, popup: 608 }[switcher]);
            const header = g.windowHeaderHeight(appId), footer = g.windowFooterHeight(appId);
            assert.equal(g.statusInSwitcherRow(appId), statusBar === 'bottom' && g.switcherRowHeight(appId) > 0);
            if (switcher === 'popup') {
              // Each edge has the status bar's rows (unless it only
              // overlays), else the frame's side, else nothing.
              assert.equal(g.windowFramed(appId), border && !wide);
              const edge = (side) => visibility === 'always' && statusBar === side ? g.TOP_BAR_HEIGHT : g.windowFramed(appId) ? 1 : 0;
              assert.deepEqual([header, footer], [edge('top'), edge('bottom')]);
              // The status bar's rows lie within the band, at its edge.
              const top = g.windowTop(heightMode, appId), band = g.windowBandHeight(heightMode, appId);
              assert.equal(g.statusBarTop(heightMode, appId), statusBar === 'top' ? top : top + band - g.TOP_BAR_HEIGHT);
            } else {
              assert.equal(g.windowFramed(appId), switcher === 'bottom' && !wide);
              assert.deepEqual([header, footer], [!g.statusInSwitcherRow(appId) ? g.TOP_BAR_HEIGHT : g.windowFramed(appId) ? 1 : 0, 0]);
            }
            assert.equal(rect.y, g.windowTop(heightMode, appId) + header);
            assert.equal(rect.height + header + footer, g.windowBandHeight(heightMode, appId));
            assert.ok(rect.y >= header && rect.y + rect.height + footer <= 480 - g.switcherRowHeight(appId));
            const row = g.switcherRect(heightMode, appId);
            assert.ok(row.y + row.height <= 480);
            // A reserved bottom row hangs right under the window, as wide as it.
            if (g.switcherRowHeight(appId)) assert.deepEqual([row.x, row.y, row.width], [rect.x, rect.y + rect.height, rect.width]);
            // The frame's sides, just outside the window, survive the
            // deepest shift (±62 moves each lens 31px).
            if (g.windowFramed(appId)) assert.ok(rect.x - 1 - 31 >= 0 && rect.x + rect.width + 31 < 640);
          }
        }
      }
    }
  }
});

test('the app switcher can sit on the right edge', () => {
  const g = geometry();
  g.settings.appSwitcherPositionSetting.value = 'right';
  assert.deepEqual(g.rect('min'), { x: 0, y: 124, width: 576, height: 260 });
  assert.deepEqual({ ...g.switcherRect('max') }, { x: 576, y: 96, width: 64, height: 288 });
  assert.equal(g.screenCenterInViewportX(), 320);
  assert.equal(g.isOnSwitcherEdge(600, 10, 'min'), true);
  assert.equal(g.isOnSwitcherEdge(10, 200, 'min'), false);
  assert.equal(g.windowFramed(), false);
  // Depth needs the bottom row's side margins.
  g.settings.uiDepthSetting.value = '32';
  assert.equal(g.uiDepth(), 0);
  // Full Screen needs the width a strip takes: beside one it is Tall.
  g.settings.displayLayoutSetting.value = 'fullscreen';
  assert.deepEqual(g.rect('min'), { x: 0, y: 28, width: 576, height: 452 });
});

test('a popup app switcher centres 576-wide windows, whose edges the status bar and frame decide', () => {
  const g = geometry();
  g.settings.appSwitcherPositionSetting.value = 'popup';
  // Nothing is reserved for the switcher: it shows only while focused, and
  // is modal while it does.
  assert.equal(g.sidebarStripVisible('window'), false);
  assert.equal(g.sidebarStripVisible('sidebar'), true);
  assert.equal(g.isOnSwitcherEdge(5, 5, 'min'), true);
  assert.equal(g.screenCenterInViewportX(), 288);
  g.settings.uiDepthSetting.value = '-48';
  assert.equal(g.uiDepth(), -48);
  // The top bar above the content and the frame's bottom side below it.
  assert.equal(g.windowFramed(), true);
  assert.deepEqual(g.rect('min'), { x: 32, y: 124, width: 576, height: 259 });
  assert.deepEqual(g.rect('medium'), { x: 32, y: 110, width: 576, height: 288 });
  assert.deepEqual(g.rect('max', 'terminal'), { x: 32, y: 28, width: 576, height: 451 });
  // At the bottom, the bar takes the band's last rows, and the frame's top a row of its own.
  g.settings.statusBarPositionSetting.value = 'bottom';
  assert.deepEqual(g.rect('min'), { x: 32, y: 97, width: 576, height: 259 });
  assert.equal(g.statusBarTop('min'), 356);
  // Shown only in the switcher, the bar overlays the content, which grows into its rows.
  g.settings.statusBarVisibilitySetting.value = 'switcher';
  assert.deepEqual(g.rect('min'), { x: 32, y: 97, width: 576, height: 286 });
  assert.deepEqual(g.rect('max', 'terminal'), { x: 32, y: 1, width: 576, height: 478 });
  assert.equal(g.statusBarTop('min'), 356);
  // Without the frame too, windows have no chrome rows at all.
  g.settings.windowBorderSetting.value = false;
  assert.equal(g.windowFramed(), false);
  assert.deepEqual(g.rect('max', 'terminal'), { x: 32, y: 0, width: 576, height: 480 });
  assert.deepEqual(g.rect('medium'), { x: 32, y: 96, width: 576, height: 288 });
  // Full Screen: the status bar keeps its edge, but there's no room for a frame.
  g.settings.windowBorderSetting.value = true;
  g.settings.statusBarVisibilitySetting.value = 'always';
  g.settings.displayLayoutSetting.value = 'fullscreen';
  assert.equal(g.windowFramed(), false);
  assert.deepEqual(g.rect('max'), { x: 0, y: 0, width: 640, height: 452 });
  assert.equal(g.statusBarTop('max'), 452);
});

test('a bottom app switcher centres 576-wide windows and hangs one tall tab under them', () => {
  const g = geometry();
  g.settings.appSwitcherPositionSetting.value = 'bottom';
  assert.equal(g.SWITCHER_ROW_HEIGHT, 36);
  assert.deepEqual(g.rect('max', 'terminal'), { x: 32, y: 28, width: 576, height: 416 });
  assert.deepEqual({ ...g.switcherRect('max', 'terminal') }, { x: 32, y: 444, width: 576, height: 36 });
  // Band and row share the slack: no gap under a band shorter than the screen.
  assert.deepEqual(g.rect('min'), { x: 32, y: 106, width: 576, height: 260 });
  assert.deepEqual({ ...g.switcherRect('min') }, { x: 32, y: 366, width: 576, height: 36 });
  assert.equal(g.isOnSwitcherEdge(10, 370, 'min'), true);
  assert.equal(g.isOnSwitcherEdge(10, 360, 'min'), false);
  g.settings.displayLayoutSetting.value = 'band-bottom';
  assert.equal(g.switcherRect('min').y, 444);
  // The true centre is the viewport's own with the window centred.
  assert.equal(g.screenCenterInViewportX(), 288);
  // Depth applies only here, as does the window frame.
  g.settings.uiDepthSetting.value = '-48';
  assert.equal(g.uiDepth(), -48);
  assert.equal(g.windowFramed(), true);
  // Full Screen: windows take the panel's width over the row, which stays.
  g.settings.displayLayoutSetting.value = 'fullscreen';
  assert.deepEqual(g.rect('max'), { x: 0, y: 28, width: 640, height: 416 });
  assert.deepEqual({ ...g.switcherRect('max') }, { x: 0, y: 444, width: 640, height: 36 });
  assert.equal(g.sidebarStripVisible('window'), true);
  assert.equal(g.windowFramed(), false);
});

test('an immersive app fills the panel without chrome rows, frame or depth, in any layout', () => {
  const panel = { x: 0, y: 0, width: 640, height: 480 };
  for (const position of ['left', 'right', 'bottom', 'popup']) {
    const g = geometry();
    g.settings.appSwitcherPositionSetting.value = position;
    g.settings.statusBarPositionSetting.value = 'bottom';
    g.settings.uiDepthSetting.value = '48';
    assert.equal(g.setAppImmersive('onboarding', true), true);
    assert.equal(g.setAppImmersive('onboarding', true), false);
    for (const mode of ['min', 'medium', 'max']) assert.deepEqual(g.rect(mode, 'onboarding'), panel, position);
    assert.equal(g.windowFramed('onboarding'), false);
    assert.equal(g.statusInSwitcherRow('onboarding'), false);
    // The switcher overlays it while focused.
    assert.equal(g.sidebarStripVisible('window', 'onboarding'), false);
    assert.equal(g.sidebarStripVisible('sidebar', 'onboarding'), true);
    assert.equal(g.uiDepth('onboarding'), 0);
    // Other apps keep the layout and its depth.
    const depth = position === 'bottom' || position === 'popup' ? 48 : 0;
    assert.equal(g.uiDepth('launcher'), depth);
    assert.equal(g.uiDepth(), depth);
    assert.notDeepEqual(g.rect('min', 'launcher'), panel);
    assert.equal(g.setAppImmersive('onboarding', false), true);
    assert.deepEqual(g.rect('min', 'onboarding'), g.rect('min', 'launcher'));
    assert.equal(g.uiDepth('onboarding'), depth);
  }
});

test('the phone mirror zooms to the area the shell uses, centred at the panel\'s 4:3', () => {
  const g = geometry();
  const preview = (mode, appId) => {
    const used = { ...g.usedScreenRect(mode, appId) };
    return { used, shown: { ...g.phonePreviewRect(used) } };
  };
  const panel = { x: 0, y: 0, width: 640, height: 480 };
  // A side strip and band: the panel's width, so only centring vertically.
  assert.deepEqual(preview('min'), { used: { x: 0, y: 96, width: 640, height: 288 }, shown: panel });
  g.settings.displayLayoutSetting.value = 'band-top';
  assert.deepEqual(preview('min').shown, { x: 0, y: -96, width: 640, height: 480 });
  g.settings.appSwitcherPositionSetting.value = 'right';
  g.settings.displayLayoutSetting.value = 'band-high';
  assert.deepEqual(preview('min'), { used: { x: 0, y: 48, width: 640, height: 288 }, shown: { x: 0, y: -48, width: 640, height: 480 } });
  // A bottom row: the band with the frame's sides, and the row under it.
  g.settings.appSwitcherPositionSetting.value = 'bottom';
  g.settings.displayLayoutSetting.value = 'band-middle';
  assert.deepEqual(preview('min'), { used: { x: 31, y: 78, width: 578, height: 324 }, shown: { x: 30, y: 23, width: 580, height: 435 } });
  // A tall window (the terminal's default) leaves just the frame's margins.
  assert.deepEqual(preview('max', 'terminal'), { used: { x: 31, y: 0, width: 578, height: 480 }, shown: panel });
  // A popup shows within the window: just the band.
  g.settings.appSwitcherPositionSetting.value = 'popup';
  assert.deepEqual(preview('min'), { used: { x: 31, y: 96, width: 578, height: 288 }, shown: { x: 30, y: 23, width: 580, height: 435 } });
  // Full Screen and immersive windows use the whole panel.
  g.settings.displayLayoutSetting.value = 'fullscreen';
  assert.deepEqual(preview('min'), { used: panel, shown: panel });
  g.settings.displayLayoutSetting.value = 'band-middle';
  g.setAppImmersive('onboarding', true);
  assert.deepEqual(preview('min', 'onboarding'), { used: panel, shown: panel });
  // Every layout's shown area is exactly 4:3 and contains the used area.
  for (const position of ['left', 'right', 'bottom', 'popup']) {
    g.settings.appSwitcherPositionSetting.value = position;
    for (const layout of LAYOUTS) {
      g.settings.displayLayoutSetting.value = layout;
      for (const mode of ['min', 'medium', 'max']) {
        const { used, shown } = preview(mode);
        assert.equal(shown.width * 3, shown.height * 4);
        assert.ok(shown.width <= 640 && shown.height <= 480);
        assert.ok(shown.x <= used.x && shown.y <= used.y);
        assert.ok(shown.x + shown.width >= used.x + used.width && shown.y + shown.height >= used.y + used.height);
      }
    }
  }
});

test('the mirror\'s crop follows Preview scaling, the Glanceboard and the lock, and maps taps back to the panel', () => {
  const g = geometry();
  const scaling = { value: 'scaled', get() { return this.value; } };
  let foreground = { heightMode: 'min', appId: 'launcher' };
  const modules = {
    '../graphics/image': { G2_LENS_WIDTH: 640, G2_LENS_HEIGHT: 480 },
    '../ui/dashboard-settings': { previewScalingSetting: scaling },
    '../ui/shell/geometry': g,
    '../ui/shell/shell': { shell: { foregroundWindow: () => foreground } },
  };
  const context = { exports: {}, require: (name) => modules[name] };
  vm.runInNewContext(js(read('app/g2/phone-preview-crop.ts')), context);
  const { phonePreviewCrop, mirrorToPanelFraction } = context.exports;
  const crop = (locked = false, glance = null) => {
    const rect = phonePreviewCrop(locked, glance);
    return rect && { ...rect };
  };
  g.settings.appSwitcherPositionSetting.value = 'bottom';
  const band = { x: 30, y: 23, width: 580, height: 435 };
  assert.deepEqual(crop(), band);
  // The whole panel is no crop at all.
  foreground = { heightMode: 'max', appId: 'terminal' };
  assert.equal(crop(), null);
  foreground = null;
  assert.deepEqual(crop(), band);
  // The Glanceboard while it shows; a locked display's centred box needs the panel.
  assert.deepEqual(crop(false, { x: 32, y: 48, width: 576, height: 432 }), { x: 32, y: 48, width: 576, height: 432 });
  assert.deepEqual(crop(false, { x: 32, y: 96, width: 576, height: 288 }), { x: 32, y: 24, width: 576, height: 432 });
  assert.equal(crop(true), null);
  scaling.value = 'raw';
  assert.equal(crop(), null);
  // Taps: the mirror's corners are the crop's, its margins past the panel's edges.
  assert.deepEqual({ ...mirrorToPanelFraction(null, 0.25, 0.75) }, { nx: 0.25, ny: 0.75 });
  assert.deepEqual({ ...mirrorToPanelFraction(band, 0, 0) }, { nx: 30 / 640, ny: 23 / 480 });
  assert.deepEqual({ ...mirrorToPanelFraction(band, 1, 1) }, { nx: 610 / 640, ny: 458 / 480 });
  const above = mirrorToPanelFraction({ x: 0, y: -96, width: 640, height: 480 }, 0.5, 0.1);
  assert.ok(above.ny < 0);
});

// The real chrome layer over the given geometry, with platform pieces stubbed:
// a 4px-per-character font that paints each character as a 2x6 block, up to
// `notifications` 24px notification icons (keyed n0, n1, ...), and a phone
// battery at 80%.
const graphics = require('../.test-build/app/graphics/image.js');
const shellScene = require('../.test-build/app/graphics/shell-scene.js');
const displayList = require('../.test-build/app/graphics/display-list.js');
function chromeLayer(g, { notifications = 0, phoneBattery = null, windows = 1, trayIcons = [] } = {}) {
  const font = { lineHeight: 12, ascent: 10, measureText: (text) => text.length * 4,
    drawText: (image, x, y, text, value) => { for (let i = 0; i < text.length; i++) image.fillRect(x + i * 4, y + 2, 2, 6, value); } };
  let nextKey = 100;
  const requested = [];
  const settings = { get: () => 'always' };
  const modules = {
    '../../graphics/shell-scene': shellScene, '../../graphics/image': graphics,
    '../../graphics/display-list': displayList, '../../graphics/ui-fonts': { getDefaultSmallFont: () => font, getDefaultMediumFont: () => font },
    '../../graphics/textwrap': require('../.test-build/app/graphics/textwrap.js'),
    '../../graphics/battery': require('../.test-build/app/graphics/battery.js'),
    './ambient-cards': { activeAmbientCards: () => [] },
    '../../native/notification-icons': { ALL_NOTIFICATIONS: 0x7fffffff, readActiveNotificationIcons: (max) => {
      requested.push(max);
      const count = Math.min(max, notifications);
      return { icons: Array.from({ length: count }, () => new graphics.GrayImage(24, 24, 200)),
        keys: Array.from({ length: count }, (_, index) => `n${index}`), stale: false };
    } },
    '../../native/phone-battery': { readPhoneBatteryState: () => ({ battery: phoneBattery, charging: false }) },
    '../../util/render-freshness': { renderPassAllowsStaleData: () => false },
    '../dashboard-settings': { batteryDisplayModeSetting: { get: () => 'icon' }, phoneBatteryVisibilitySetting: settings,
      batteryIndicatorVisible: () => true },
    '../clock-format': { formatClockDate: () => 'Thu Oct 2', formatClockTime: () => '9:41' },
    '../layers': { LayerStack: { allocateShellKey: () => nextKey++ } },
    // As in menu.ts.
    '../menu': { scrollToKeepSelectionVisible: (scroll, selected, visible, count) => Math.min(Math.max(0, count - visible),
      Math.max(0, selected < scroll ? selected : selected >= scroll + visible ? selected - visible + 1 : scroll)) },
    './geometry': g,
  };
  const context = { exports: {}, require: (name) => modules[name] ?? {} };
  vm.runInNewContext(js(read('app/ui/shell/chrome-layer.ts')), context);
  const state = {
    windows: Array.from({ length: windows }, (_, i) => ({ title: `Window ${i}`, attention: false,
      drawIcon: (image, x, y, size) => image.fillRect(x, y, size, size, 120) })),
    selectedIndex: 0, focus: 'window', foregroundHeightMode: 'min',
    battery: { headset: null, ring: null, watch: null }, trayIcons,
  };
  let heightChanges = 0;
  const chrome = new context.exports.ShellChromeLayer(() => state, () => heightChanges++);
  return { chrome, state, requested, planBottomBar: context.exports.planBottomBar, heightChanges: () => heightChanges };
}
const notification = (key) => ({ kind: 'notification', key });
const keysOf = (items) => Array.from(items, (item) => item.key);

test('a bottom app switcher frames the foreground window\'s content in a rounded border', () => {
  const g = geometry();
  g.settings.appSwitcherPositionSetting.value = 'bottom';
  g.settings.uiDepthSetting.value = '62';
  // The second window is selected: the first's (see the launcher test below)
  // would square the bottom-left corner.
  const { chrome, state } = chromeLayer(g, { windows: 2 });
  state.selectedIndex = 1;
  const parts = chrome.paintParts();
  // Just the top bar and then the row: the frame is no surface of its own.
  const part = (key) => parts.find((p) => p.shellKey === key);
  const [bar, strip] = [part(2), part(1)];
  assert.deepEqual(Array.from(parts, (p) => p.shellKey), [2, 1]);
  // The min band's content spans y=106..365, between the bar's bottom row
  // (the frame's top) at 105 and the row's top edge (its bottom) at 366. The
  // frame is one rounded rect riding on the row, replayed after the bar.
  const frames = (image) => image.draws.filter((d) => d.presentation?.displayList);
  const [frame] = frames(strip.image);
  assert.deepEqual([strip.x + frame.x, strip.y + frame.y, frame.source.width, frame.source.height, frame.presentation.depth], [31, 105, 578, 262, 0]);
  assert.deepEqual(JSON.parse(JSON.stringify(frame.presentation.displayList.calls)), [{ op: displayList.DrawOp.ROUNDED_RECT, x: 0, y: 0, width: 578, height: 262,
    radius: 8, background: 0, border: 3, outside: 0, clip: { x: 0, y: 0, width: 578, height: 261 } }]);
  // Over a lit screen: the sides just outside the window, the top along the
  // bar's bottom row, the content's corners cut black, its interior left
  // alone, and the bottom row left to the separator.
  const lit = new Uint8Array(640 * 480).fill(255);
  displayList.paintDisplayList(lit, lit.slice(), 640, 480, { displayList: frame.presentation.displayList,
    x: strip.x + frame.x, y: strip.y + frame.y, width: 578, height: 262, depth: 0 });
  const px = (x, y) => lit[y * 640 + x];
  assert.deepEqual([px(31, 200), px(608, 200), px(300, 105)], [48, 48, 48]);
  assert.deepEqual([px(31, 105), px(32, 106), px(32, 365), px(607, 365)], [0, 0, 0, 0]);
  assert.deepEqual([px(36, 105), px(300, 200), px(300, 366), px(36, 366)], [48, 255, 255, 255]);
  const at = (p, x, y) => p.image.pixels[(y - p.y) * p.image.width + x - p.x];
  // The separator is the bottom side, starting where the corner's curve ends.
  assert.deepEqual([at(strip, 35, 366), at(strip, 36, 366), at(strip, 603, 366), at(strip, 604, 366)], [1, 40, 40, 1]);
  // The bar's own divider gives way to the frame's top.
  assert.equal(at(bar, 300, 105), 1);
  shellScene.encodeShellScene(parts, g.uiDepth());
  // The flat paint carries the same frame.
  const image = chrome.paint();
  assert.deepEqual(frames(image).map((d) => [d.x, d.y]), [[31, 105]]);
  // No frame in the Full Screen mode.
  g.settings.displayLayoutSetting.value = 'fullscreen';
  assert.equal(chrome.paintParts().flatMap((p) => frames(p.image)).length, 0);
});

test('over an immersive window the chrome draws only the switcher, and only while it has focus', () => {
  for (const position of ['bottom', 'popup', 'left']) {
    const g = geometry();
    g.settings.appSwitcherPositionSetting.value = position;
    g.settings.statusBarPositionSetting.value = position === 'left' ? 'top' : 'bottom';
    g.setAppImmersive('onboarding', true);
    const { chrome, state } = chromeLayer(g, { windows: 2, notifications: 1 });
    state.foregroundAppId = 'onboarding';
    assert.equal(chrome.paintParts().length, 0, position);
    assert.equal(chrome.paint().pixels.some((value) => value !== 0), false, position);
    state.focus = 'sidebar';
    const parts = chrome.paintParts();
    // No status bar (key 2), not even in a bottom row.
    assert.equal(parts.length, 1, position);
    assert.notEqual(parts[0].shellKey, 2, position);
    if (position === 'bottom') assert.deepEqual([parts[0].x, parts[0].y, parts[0].image.width], [0, 444, 640]);
  }
});

test('the launcher\'s tab lines up with the window frame, whose corner squares to meet it', () => {
  const g = geometry();
  g.settings.appSwitcherPositionSetting.value = 'bottom';
  const paint = (chrome) => {
    const [, strip] = chrome.paintParts();
    const [frame] = strip.image.draws.filter((d) => d.presentation?.displayList);
    const lit = new Uint8Array(640 * 480).fill(255);
    displayList.paintDisplayList(lit, lit.slice(), 640, 480, { displayList: frame.presentation.displayList,
      x: strip.x + frame.x, y: strip.y + frame.y, width: frame.source.width, height: frame.source.height, depth: 0 });
    return { strip, px: (x, y) => lit[y * 640 + x], at: (x, y) => strip.image.pixels[(y - strip.y) * strip.image.width + x - strip.x] };
  };
  const { chrome, state } = chromeLayer(g, { windows: 3 });
  // The first cell starts at the frame's left side (x=31), one pixel outside
  // the window, so the row's surface spans the frame.
  let { strip, px, at } = paint(chrome);
  assert.deepEqual([strip.x, strip.image.width], [31, 578]);
  assert.deepEqual([chrome.windowIndexAt(31, 380, 3), chrome.windowIndexAt(30, 380, 3), chrome.windowIndexAt(71, 380, 3)], [0, null, 1]);
  // Selected, its tab's outline continues the frame's left side straight
  // down: the corner is square and the content's corner whole.
  assert.deepEqual([px(31, 360), px(31, 365), px(32, 365)], [48, 48, 255]);
  assert.deepEqual([at(31, 366), at(31, 370)], [150, 150]);
  // Focused, the tab fills from the side.
  state.focus = 'sidebar';
  ({ at } = paint(chrome));
  assert.equal(at(31, 370), 255);
  // With another window selected the corner rounds again, and the separator
  // starts where its curve ends; the launcher's cell stays at the side.
  state.focus = 'window'; state.selectedIndex = 1;
  ({ px, at } = paint(chrome));
  assert.deepEqual([px(31, 365), px(32, 365), at(35, 366), at(36, 366)], [0, 0, 1, 40]);
  assert.equal(chrome.windowIndexAt(31, 380, 3), 0);
  // Scrolled past the launcher (more windows than two rows of 14 hold), the
  // cells keep the left chevron's margin.
  const scrolled = chromeLayer(g, { windows: 40 });
  scrolled.state.selectedIndex = 39;
  ({ px } = paint(scrolled.chrome));
  assert.equal(scrolled.chrome.windowIndexAt(35, 380, 40), null);
  assert.notEqual(scrolled.chrome.windowIndexAt(41, 380, 40), null);
  assert.equal(px(31, 365), 0);
});

test('the status bar can join a bottom app switcher, and windows grow into the top bar', () => {
  const g = geometry();
  g.settings.statusBarPositionSetting.value = 'bottom';
  // Only beside a reserved bottom row.
  assert.equal(g.statusInSwitcherRow(), false);
  g.settings.appSwitcherPositionSetting.value = 'bottom';
  assert.equal(g.statusInSwitcherRow(), true);
  // A one-row header (the frame's top) replaces the 28px top bar; medium
  // windows keep a 288px (EvenHub) content area.
  assert.equal(g.windowHeaderHeight(), 1);
  assert.deepEqual(g.rect('min'), { x: 32, y: 79, width: 576, height: 287 });
  assert.deepEqual(g.rect('medium'), { x: 32, y: 79, width: 576, height: 288 });
  assert.deepEqual(g.rect('max', 'terminal'), { x: 32, y: 1, width: 576, height: 443 });
  assert.deepEqual({ ...g.switcherRect('min') }, { x: 32, y: 366, width: 576, height: 36 });
  // Full Screen keeps the row, and the status bar in it, but has no frame.
  g.settings.displayLayoutSetting.value = 'fullscreen';
  assert.equal(g.statusInSwitcherRow(), true);
  assert.deepEqual(g.rect('max'), { x: 0, y: 0, width: 640, height: 444 });
});

test('the switcher row lays out windows, free space, notifications, widgets, batteries and the clock', () => {
  const g = geometry();
  g.settings.appSwitcherPositionSetting.value = 'bottom';
  g.settings.statusBarPositionSetting.value = 'bottom';
  const tray = new graphics.GrayImage(30, 20, 180);
  const { chrome, requested } = chromeLayer(g, { notifications: 2, phoneBattery: 80, trayIcons: [{ ownerId: 'w', icon: tray }] });
  const parts = chrome.paintParts();
  // No top bar: the row, then the status bar on the top bar's surface and depth.
  assert.deepEqual(Array.from(parts, (p) => [p.shellKey, p.depth ?? 0]), [[1, 0], [2, -2]]);
  const [row, status] = parts;
  // Right to left from the row's end (x=608), centred under its separator
  // line (y=366): "Thu Oct 2 9:41" (56px) flush with it; the battery block (label
  // 20 + gap 5 + gauge 21) 16px before it; the 30px widget 10px before that;
  // then the two notification icons, 8px clear of the widget. The surface
  // starts 2px before them, room for a selection box round the first.
  const clockX = 608 - 56, batteryLeft = clockX - 16 - 46, trayLeft = batteryLeft - 40, iconsLeft = trayLeft - 8 - 56 + 4;
  assert.deepEqual([status.x, status.y, status.image.width, status.image.height], [iconsLeft - 2, 367, 608 - iconsLeft + 2, 35]);
  const at = (p, x, y) => p.image.withDrawsBaked().pixels[(y - p.y) * p.image.width + x - p.x];
  // The clock's text runs 8 rows down the top bar's layout, which sits 5 rows into the row.
  assert.deepEqual([at(status, clockX, 366 + 5 + 8 + 2), at(status, trayLeft, 366 + 5 + 4), at(status, iconsLeft, 366 + 5 + 2)], [210, 180, 200]);
  assert.equal(at(status, batteryLeft, 366 + 5 + 8 + 2), 150, 'battery label');
  // Windows take what the status bar leaves; the rest is free space.
  assert.equal(at(row, 40 + 2, 366 + 2), 120, 'first window icon');
  assert.equal(chrome.windowIndexAt(45, 380, 1), 0);
  assert.equal(chrome.windowIndexAt(iconsLeft + 2, 380, 1), null);
  // The row asks for every notification icon, to lay itself out round them all.
  assert.equal(requested.at(-1), 0x7fffffff);
  // No top bar, but the frame is still there, its top one row above the content.
  const [frame] = row.image.draws.filter((d) => d.presentation?.displayList);
  assert.deepEqual([row.x + frame.x, row.y + frame.y, frame.source.height], [31, 78, 289]);
  shellScene.encodeShellScene(parts, g.uiDepth());
});

test('past two rows of windows, they scroll, and notification icons give way to a few slots a row', () => {
  const g = geometry();
  g.settings.appSwitcherPositionSetting.value = 'bottom';
  g.settings.statusBarPositionSetting.value = 'bottom';
  const { chrome, requested, heightChanges } = chromeLayer(g, { notifications: 40, windows: 12 });
  const [row, status] = chrome.paintParts();
  assert.equal(requested.at(-1), 0x7fffffff);
  // The last layout: two rows of each, 72px tall, under the unmoved band.
  assert.equal(g.switcherRowHeight(), 72);
  assert.equal(heightChanges(), 1);
  assert.deepEqual([row.y, row.image.height], [366, 72]);
  // Notification icons drop from the end until the two status rows leave
  // three window slots a row (32 + 20 + 3 * 40 - 8, and the gap): 28 stay,
  // 15 in the first row (416px) and 13 with the clock in the second (432px).
  assert.equal(chrome.statusItems().length, 28);
  assert.deepEqual([status.x, status.y, status.image.height], [608 - 432 - 2, 367, 71]);
  const at = (p, x, y) => p.image.withDrawsBaked().pixels[(y - p.y) * p.image.width + x - p.x];
  assert.deepEqual([at(status, 608 - 416, 366 + 5 + 2), at(status, 608 - 432, 366 + 36 + 5 + 2)], [200, 200]);
  // Three windows a row; the rest scroll, with the chevron after the second
  // row's, at the end of the windows rather than of the row.
  assert.equal(chrome.windowIndexAt(32 + 10 + 2 * 40 + 4, 380, 12), 2);
  assert.equal(chrome.windowIndexAt(32 + 10 + 3 * 40 + 4, 380, 12), null);
  assert.equal(chrome.windowIndexAt(32 + 10 + 2 * 40 + 4, 420, 12), 5);
  const windowsRight = 608 - 432 - 8;
  const chevron = row.image.pixels.findIndex((v) => v === 140);
  assert.deepEqual([chevron % row.image.width + row.x, Math.floor(chevron / row.image.width) + row.y], [windowsRight - 6, 366 + 36 + 18 - 5]);
});

test('the bottom switcher falls back to denser layouts as what it holds outgrows it', () => {
  const { planBottomBar } = chromeLayer(geometry());
  const notifications = (count) => Array.from({ length: count }, () => ({ kind: 'notification', width: 24 }));
  const clock = { kind: 'clock', width: 56 };
  const summary = (plan) => [plan.level, plan.height, plan.windowRows, plan.windowColumns,
    Array.from(plan.statusRows, (items) => items.length), plan.statusWidth, plan.statusPitch];
  // Three windows (132px with margins) and five icons and the clock fit one row.
  assert.deepEqual(summary(planBottomBar(576, 3, [...notifications(5), clock])), [1, 36, 1, 8, [6], 208, 28]);
  // Fourteen icons don't (28 * 14 - 4 + 16 + 56 > 576 - 132 - 8), so the
  // status bar takes two rows, broken where they come nearest the same
  // width: 8 icons (220px) over 6 and the clock (236px), a top bar apart.
  const many = [...notifications(14), clock];
  assert.deepEqual(summary(planBottomBar(576, 3, many)), [2, 64, 1, 8, [8, 7], 236, 28]);
  // Nine windows don't fit the one row of 8 slots that leaves: two rows of
  // windows, the status rows level with them.
  assert.deepEqual(summary(planBottomBar(576, 9, many)), [3, 72, 2, 8, [8, 7], 236, 36]);
  // Seventeen don't fit those 16 slots: the last layout scrolls them.
  assert.deepEqual(summary(planBottomBar(576, 17, many)), [4, 72, 2, 8, [8, 7], 236, 36]);
  // Without the status bar, the windows alone: 14 a row.
  assert.deepEqual(summary(planBottomBar(576, 14, [])), [1, 36, 1, 14, [], 0, 28]);
  assert.deepEqual(summary(planBottomBar(576, 15, [])), [3, 72, 2, 14, [], 0, 36]);
  assert.deepEqual(summary(planBottomBar(576, 29, [])), [4, 72, 2, 14, [], 0, 36]);
  // A full-width (640) row has room for more.
  assert.equal(planBottomBar(640, 3, many).level, 1);
});

test('a taller bottom switcher takes its room from the slack under a band, or from full-height windows', () => {
  const g = geometry();
  g.settings.appSwitcherPositionSetting.value = 'bottom';
  g.settings.statusBarPositionSetting.value = 'bottom';
  const before = g.rect('min');
  assert.equal(g.setSwitcherBarHeight(64), true);
  assert.equal(g.setSwitcherBarHeight(64), false);
  // The band stays put, the switcher growing down into the slack under it...
  assert.deepEqual(g.rect('min'), before);
  assert.deepEqual({ ...g.switcherRect('min') }, { x: 32, y: 366, width: 576, height: 64 });
  assert.equal(g.isOnSwitcherEdge(10, 420, 'min'), true);
  // ...pushing it up only where there's too little.
  g.settings.displayLayoutSetting.value = 'band-low';
  assert.equal(g.windowTop('min'), 117);
  g.settings.displayLayoutSetting.value = 'band-bottom';
  assert.equal(g.windowTop('min'), 480 - 64 - 288);
  assert.equal(g.switcherRect('min').y + 64, 480);
  // Tall windows give up the height.
  g.settings.displayLayoutSetting.value = 'tall';
  assert.deepEqual(g.rect('max'), { x: 32, y: 1, width: 576, height: 415 });
  g.settings.displayLayoutSetting.value = 'band-middle';
  assert.deepEqual(g.rect('max', 'terminal'), { x: 32, y: 1, width: 576, height: 415 });
  // Over an immersive window the switcher is an overlay of its own height,
  // which moves no window.
  g.setAppImmersive('onboarding', true);
  assert.equal(g.setSwitcherBarHeight(72, 'onboarding'), false);
  assert.deepEqual({ ...g.switcherRect('min', 'onboarding') }, { x: 0, y: 408, width: 640, height: 72 });
  assert.equal(g.switcherRowHeight(), 64);
  // Beside a side strip it takes nothing.
  g.settings.appSwitcherPositionSetting.value = 'left';
  assert.equal(g.switcherRowHeight(), 0);
});

test('the status bar takes a second row of its own before the windows do', () => {
  const g = geometry();
  g.settings.appSwitcherPositionSetting.value = 'bottom';
  g.settings.statusBarPositionSetting.value = 'bottom';
  const { chrome, heightChanges } = chromeLayer(g, { notifications: 14, windows: 3 });
  const before = g.rect('min');
  const [row, status] = chrome.paintParts();
  assert.equal(g.switcherRowHeight(), 64);
  assert.equal(heightChanges(), 1);
  chrome.paintParts();
  assert.equal(heightChanges(), 1, 'reported once');
  assert.deepEqual(g.rect('min'), before);
  // Both rows right-aligned against the row's end: 8 icons (220px) over 6
  // and the clock (236px), a top bar's height apart.
  assert.deepEqual([status.x, status.y, status.image.height], [608 - 236 - 2, 367, 63]);
  const at = (p, x, y) => p.image.withDrawsBaked().pixels[(y - p.y) * p.image.width + x - p.x];
  assert.deepEqual([at(status, 608 - 220, 371 + 2), at(status, 608 - 236, 371 + 28 + 2), at(status, 608 - 56, 371 + 28 + 8 + 2)],
    [200, 200, 210]);
  assert.deepEqual(keysOf(chrome.statusItems()), Array.from({ length: 14 }, (_, i) => `n${i}`));
  // The windows keep one row, against the window.
  assert.equal(chrome.windowIndexAt(45, 380, 3), 0);
  assert.equal(chrome.windowIndexAt(45, 410, 3), null);
  assert.equal(row.image.height, 64);
});

test('windows past one row take a second, where a selected one sits in a box', () => {
  const g = geometry();
  g.settings.appSwitcherPositionSetting.value = 'bottom';
  g.settings.statusBarPositionSetting.value = 'bottom';
  const { chrome, state } = chromeLayer(g, { notifications: 14, windows: 9 });
  state.selectedIndex = 8;
  const [row, status] = chrome.paintParts();
  assert.equal(g.switcherRowHeight(), 72);
  // Eight slots a row (what the 236px status rows leave); the ninth window
  // starts the second row, under the first.
  assert.deepEqual([chrome.windowIndexAt(31 + 7 * 40, 380, 9), chrome.windowIndexAt(31, 410, 9), chrome.windowIndexAt(71, 410, 9)], [7, 8, null]);
  const at = (p, x, y) => p.image.pixels[(y - p.y) * p.image.width + x - p.x];
  // Its selection is a box (as for a sidebar overflow column), and the
  // separator runs unbroken over the first row.
  assert.deepEqual([at(row, 31, 402 + 18), at(row, 31 + 5, 402 + 7)], [150, 120]);
  assert.equal(at(row, 50, 366), 40);
  // The status rows line up with the window rows.
  assert.equal(status.image.withDrawsBaked().pixels[(366 + 36 + 5 + 2 - status.y) * status.image.width + 608 - 236 - status.x], 200);
});

test('a popup app switcher shows a box of window icons over the dimmed window while focused', () => {
  const g = geometry();
  g.settings.appSwitcherPositionSetting.value = 'popup';
  const { chrome, state } = chromeLayer(g, { windows: 3 });
  const summary = (parts) => Array.from(parts, (p) => [p.shellKey, p.depth ?? 0, p.dimUnderneath ?? 1]);
  const at = (p, x, y) => p.image.pixels[(y - p.y) * p.image.width + x - p.x];
  // In the window: the top bar, then the frame, which rides on a pixel of
  // its own at its top-left corner (outside its curve).
  let parts = chrome.paintParts();
  assert.deepEqual(summary(parts), [[2, -2, 1], [1, 0, 1]]);
  const [bar, carrier] = parts;
  assert.deepEqual([carrier.x, carrier.y, carrier.image.width, carrier.image.height], [31, 123, 1, 1]);
  // The whole rounded rect, from the bar's last row (in place of its
  // divider) round the content (32,124 576×259) to the footer row under it.
  const [frame] = carrier.image.draws.filter((d) => d.presentation?.displayList);
  assert.deepEqual([carrier.x + frame.x, carrier.y + frame.y, frame.presentation.depth], [31, 123, 0]);
  assert.deepEqual(JSON.parse(JSON.stringify(frame.presentation.displayList.calls)), [{ op: displayList.DrawOp.ROUNDED_RECT,
    x: 0, y: 0, width: 578, height: 261, radius: 8, background: 0, border: 3, outside: 0 }]);
  assert.equal(at(bar, 300, 123), 1);
  // Focused: the box, nearer than the window, last. Its dim rides on the
  // first part, so it dims the windows and none of the chrome.
  state.focus = 'sidebar';
  parts = chrome.paintParts();
  assert.deepEqual(summary(parts), [[2, -2, 0.5], [1, 0, 1], [100, 4, 1]]);
  const encoded = shellScene.encodeShellScene(parts, g.uiDepth());
  assert.equal(new DataView(encoded.buffer).getUint16(12, true), 128, 'first layer dims to half');
  // Three 44px cells 4px apart, in the minimum 272px width, centred over the
  // content; 12px padding round the cells and the 12px title line under them.
  let popup = parts[2];
  assert.deepEqual([popup.x, popup.y, popup.image.width, popup.image.height], [184, 210, 272, 86]);
  assert.equal(at(popup, 184, 210), 72, 'border');
  // The selected (first) cell is filled white around its icon; the others'
  // icons are depth images of their own over the black box.
  assert.deepEqual([at(popup, 252, 240), at(popup, 260, 240), at(popup, 310, 240)], [255, 120, 1]);
  assert.deepEqual(popup.image.draws.filter((d) => d.presentation).map((d) => [popup.x + d.x, popup.y + d.y]), [[304, 227], [352, 227]]);
  // The selected window's title, centred under the icons.
  assert.equal(at(popup, 184 + (272 - 32) / 2, 222 + 44 + 6 + 2), 210);
  assert.deepEqual([chrome.windowIndexAt(260, 240, 3), chrome.windowIndexAt(300, 240, 3), chrome.windowIndexAt(296, 240, 3),
    chrome.windowIndexAt(10, 10, 3)], [0, 1, null, null]);
  // The flat paint shows it too.
  assert.equal(chrome.paint().pixels[210 * 640 + 184], 72);
  // Many windows scroll, with a chevron at either end of the icons.
  const many = chromeLayer(g, { windows: 20 });
  many.state.focus = 'sidebar';
  many.state.selectedIndex = 15;
  popup = many.chrome.paintParts()[2];
  assert.deepEqual([popup.x, popup.image.width], [58, 524]);
  assert.equal(many.chrome.windowIndexAt(90, 240, 20), 6);
  assert.deepEqual([at(popup, 74, 244), at(popup, 565, 244)], [140, 140]);
});

test('a popup switcher\'s status bar can sit at the bottom, show only in the switcher, or go without the frame', () => {
  const g = geometry();
  g.settings.appSwitcherPositionSetting.value = 'popup';
  g.settings.statusBarVisibilitySetting.value = 'switcher';
  const { chrome, state } = chromeLayer(g);
  const at = (p, x, y) => p.image.pixels[(y - p.y) * p.image.width + x - p.x];
  // Outside the switcher there's only the frame.
  assert.deepEqual(Array.from(chrome.paintParts(), (p) => p.shellKey), [1]);
  // In it, the bar overlays the content's top inside the frame, whose top
  // runs along the bar's first row, so it keeps its divider on its last.
  state.focus = 'sidebar';
  let [bar, carrier] = chrome.paintParts();
  assert.deepEqual([bar.x, bar.y, bar.image.width, bar.image.height, carrier.y], [32, 96, 576, 28, 96]);
  assert.equal(at(bar, 300, 123), 40);
  // At the bottom, its divider is its first row, and the frame's bottom its last.
  g.settings.statusBarPositionSetting.value = 'bottom';
  [bar] = chrome.paintParts();
  assert.deepEqual([bar.y, at(bar, 300, 356), at(bar, 300, 383)], [356, 40, 1]);
  // Always shown without a frame, a divider still separates bar and window.
  g.settings.statusBarVisibilitySetting.value = 'always';
  g.settings.windowBorderSetting.value = false;
  state.focus = 'window';
  const parts = chrome.paintParts();
  assert.deepEqual(Array.from(parts, (p) => p.shellKey), [2]);
  assert.deepEqual([parts[0].y, at(parts[0], 300, 356)], [356, 40]);
  g.settings.statusBarPositionSetting.value = 'top';
  [bar] = chrome.paintParts();
  assert.deepEqual([bar.y, at(bar, 300, 123)], [96, 40]);
});

test('a notification the switcher selects sits in a box, filled with its icon inverted while the switcher has focus', () => {
  const g = geometry();
  g.settings.appSwitcherPositionSetting.value = 'bottom';
  g.settings.statusBarPositionSetting.value = 'bottom';
  const { chrome, state } = chromeLayer(g, { notifications: 3, windows: 2 });
  Object.assign(state, { selectedIndex: -1, selectedStatusItem: notification('n1'), focus: 'sidebar' });
  let [row, status] = chrome.paintParts();
  assert.deepEqual(keysOf(chrome.statusItems()), ['n0', 'n1', 'n2']);
  // Clock only: the icons end 8px before its 8px lead-in, 28px apart, each
  // 7 rows into the row (the top bar's layout, 5 rows down).
  const iconsLeft = 608 - 56 - 8 - 8 - 3 * 28 + 4, iconY = 366 + 7, n1 = iconsLeft + 28;
  const at = (p, x, y) => p.image.withDrawsBaked().pixels[(y - p.y) * p.image.width + x - p.x];
  // The box: 2px either side of the icon, 1px above and below, white; the
  // icon inside it inverted (bright, so to black); its neighbours as ever.
  assert.deepEqual([at(status, n1 - 2, iconY + 12), at(status, n1 + 25, iconY + 12), at(status, n1 + 12, iconY - 1)], [255, 255, 255]);
  assert.equal(at(status, n1 + 12, iconY - 2), 1);
  assert.deepEqual([at(status, n1 + 5, iconY + 5), at(status, iconsLeft + 5, iconY + 5)], [1, 200]);
  // No window is selected: the separator runs unbroken over the windows.
  assert.equal(at(row, 50, 366), 40);
  // Mirror touches find the icons by their boxes, which tile the icons' run.
  const keyAt = (x, y) => chrome.statusItemAt(x, y)?.key ?? null;
  assert.deepEqual([keyAt(n1 + 5, 380), keyAt(n1 - 3, 380), keyAt(iconsLeft - 3, 380), keyAt(n1 + 5, 400)], ['n1', 'n0', null, null]);
  // With its detail view focused instead, the box is an outline round the plain icon.
  state.focus = 'window';
  [, status] = chrome.paintParts();
  assert.deepEqual([at(status, n1 - 2, iconY + 12), at(status, n1 - 1, iconY + 12), at(status, n1 + 5, iconY + 5)], [150, 1, 200]);
  // The first icon's box fits the status bar's surface.
  state.selectedStatusItem = notification('n0');
  [, status] = chrome.paintParts();
  assert.equal(at(status, iconsLeft - 2, iconY + 12), 150);
  // In the top bar (the status bar's default place) likewise; barTop=78.
  g.settings.statusBarPositionSetting.value = 'top';
  const [bar] = chrome.paintParts();
  const barIconsLeft = 32 + 10 + 56 + 16;
  assert.deepEqual(keysOf(chrome.statusItems()), ['n0', 'n1', 'n2']);
  assert.deepEqual([at(bar, barIconsLeft - 2, 78 + 14), at(bar, barIconsLeft + 5, 78 + 7)], [150, 200]);
  assert.equal(keyAt(barIconsLeft + 30, 78 + 10), 'n1');
});

test('an app widget the switcher selects sits in a box as a notification does, after the notifications', () => {
  const g = geometry();
  g.settings.appSwitcherPositionSetting.value = 'bottom';
  g.settings.statusBarPositionSetting.value = 'bottom';
  // A faint 30x20 widget, its bright text a deferred draw, and a 12x16 one.
  const wide = new graphics.GrayImage(30, 20, 0);
  wide.fillRect(0, 0, 30, 20, 16);
  wide.drawImage(new graphics.GrayImage(4, 4, 220), 10, 8);
  const small = new graphics.GrayImage(12, 16, 160);
  const { chrome, state } = chromeLayer(g, { notifications: 2, windows: 2,
    trayIcons: [{ ownerId: 'nightscout', icon: wide }, { ownerId: 'timer', icon: small }] });
  Object.assign(state, { selectedIndex: -1, selectedStatusItem: { kind: 'widget', key: 'nightscout' }, focus: 'sidebar' });
  let [, status] = chrome.paintParts();
  // Notifications first, then the widgets, as they sit left to right.
  assert.deepEqual(Array.from(chrome.statusItems(), (item) => `${item.kind}:${item.key}`),
    ['notification:n0', 'notification:n1', 'widget:nightscout', 'widget:timer']);
  // Right to left from the row's end: the clock (56px), its 16px lead-in,
  // the small widget, 10px, the wide one. Each centred in the top bar's
  // layout, 5 rows into the row.
  const smallLeft = 608 - 56 - 16 - 12, wideLeft = smallLeft - 10 - 30, wideTop = 366 + 5 + 4;
  const at = (p, x, y) => p.image.withDrawsBaked().pixels[(y - p.y) * p.image.width + x - p.x];
  // The box: 2px either side, as tall as a notification's (rows 1..26 of
  // the layout) whatever the widget's height; white, with the widget
  // inverted inside it, its deferred draw too. The inversion is perceptual:
  // the faint fill (level 1) becomes mid-gray level 7, the bright text black.
  assert.deepEqual([at(status, wideLeft - 2, 366 + 5 + 14), at(status, wideLeft + 31, 366 + 5 + 14),
    at(status, wideLeft + 15, 366 + 5 + 1), at(status, wideLeft + 15, 366 + 5 + 26)], [255, 255, 255, 255]);
  assert.equal(at(status, wideLeft + 15, 366 + 5 + 27), 1);
  assert.deepEqual([at(status, wideLeft + 2, wideTop + 2), at(status, wideLeft + 11, wideTop + 9)], [112, 1]);
  assert.equal(at(status, smallLeft + 2, 366 + 5 + 8), 160);
  // Mirror touches find widgets by their boxes too.
  assert.deepEqual({ ...chrome.statusItemAt(wideLeft - 1, 380) }, { kind: 'widget', key: 'nightscout' });
  assert.deepEqual({ ...chrome.statusItemAt(smallLeft + 13, 380) }, { kind: 'widget', key: 'timer' });
  // With its window focused instead, an outline round the plain widget.
  state.focus = 'window';
  [, status] = chrome.paintParts();
  assert.deepEqual([at(status, wideLeft - 2, 366 + 5 + 14), at(status, wideLeft + 2, wideTop + 2)], [150, 16]);
  // In the top bar likewise, the notifications still before the widgets
  // though drawn after them; barTop=78.
  g.settings.statusBarPositionSetting.value = 'top';
  const [bar] = chrome.paintParts();
  assert.deepEqual(Array.from(chrome.statusItems(), (item) => item.key), ['n0', 'n1', 'nightscout', 'timer']);
  const barWideLeft = 608 - 10 - 12 - 10 - 30;
  assert.deepEqual([at(bar, barWideLeft - 2, 78 + 14), at(bar, barWideLeft + 2, 78 + 6)], [150, 16]);
});

test('with the selection out on a notification, the windows stay scrolled as they were', () => {
  const g = geometry();
  g.settings.appSwitcherPositionSetting.value = 'bottom';
  const { chrome, state } = chromeLayer(g, { notifications: 2, windows: 40 });
  state.selectedIndex = 39;
  chrome.paintParts();
  const last = 32 + 10 + 2 * 40 + 4;
  const before = chrome.windowIndexAt(last, 380, 40);
  assert.ok(before > 2);
  Object.assign(state, { selectedIndex: -1, selectedStatusItem: notification('n0') });
  chrome.paintParts();
  assert.equal(chrome.windowIndexAt(last, 380, 40), before);
});

// Exercise the real worker message handler with platform work stubbed out.
function resizeHandler(file, globals) {
  const source = ts.createSourceFile(file, read(file), ts.ScriptTarget.Latest, true);
  const handler = source.statements.find((s) => ts.isExpressionStatement(s)
    && ts.isBinaryExpression(s.expression) && s.expression.left.getText(source) === 'global.onmessage');
  assert.ok(handler);
  const context = { global: {}, ...globals };
  vm.runInNewContext(js(handler.getText(source)), context);
  return (viewport) => context.global.onmessage({ data: { type: 'resize-window', windowId: 'test', viewport } });
}

test('Navigate resize preserves its active route and window, and remeasures an open menu', () => {
  let paints = 0;
  let menuSize;
  const window = { windowId: 'test', viewportWidth: 640, viewportHeight: 452,
    menu: { resize: (size) => { menuSize = size; } }, lastSubmittedFingerprint: 'old' };
  const route = { destination: 'Home' };
  const resize = resizeHandler('app/apps/navigate/navigate-app.worker.ts', {
    window, route, phase: 'navigating', render: () => { paints++; },
  });
  resize({ width: 576, height: 260 });
  assert.equal(window.viewportHeight, 260);
  assert.equal(window.viewportWidth, 576);
  assert.equal(window.lastSubmittedFingerprint, '');
  assert.equal(route.destination, 'Home');
  assert.deepEqual(menuSize, { width: 576, height: 260 });
  resize({ width: 576, height: 260 });
  assert.equal(paints, 1);
});

test('Terminal resize keeps the view identity, negotiates its grid and skips position-only changes', () => {
  const calls = [];
  const window = { kind: 'view', windowId: 'test', socket: 'session-1',
    viewportWidth: 576, viewportHeight: 452, cellWidth: 8, cellHeight: 16,
    menu: null, reconnectTimer: 42, emulator: { dispose: () => calls.push("dispose") },
    client: { stop: () => calls.push('stop'), setViewport: (...size) => calls.push(size) },
  };
  const resize = resizeHandler('app/apps/terminal/terminal-app.worker.ts', {
    windows: new Map([['test', window]]), clearTimeout: (timer) => calls.push(timer),
    TerminalEmulator: class { constructor(cols, rows) { this.cols = cols; this.rows = rows; } },
    reconnectView: (view) => { assert.equal(view, window); calls.push('reconnect'); },
    scheduleRender: () => calls.push('paint'),
  });
  resize({ width: 576, height: 260 });
  assert.equal(window.socket, 'session-1');
  assert.equal(window.gridCols, 72);
  assert.equal(window.gridRows, 16);
  assert.equal(window.emulator.rows, 16);
  assert.deepEqual(calls, [42, 'stop', [72, 16], 'dispose', 'reconnect', 'paint']);
  resize({ width: 576, height: 260 });
  assert.equal(calls.length, 6);
});

test('the games and Roam resize in place, keeping their state, and repaint when in front', () => {
  for (const app of ['blocks', 'freecell', 'minesweeper', 'pinball']) {
    let paints = 0, menuSize;
    const window = { windowId: 'test', viewportWidth: 576, viewportHeight: 443, foreground: true, phase: 'playing',
      menu: { resize: (size) => { menuSize = size; } }, lastSubmittedFingerprint: 'old' };
    const resize = resizeHandler(`app/apps/${app}/${app}-app.worker.ts`, {
      windows: new Map([['test', window]]), renderAndSubmit: () => paints++,
    });
    resize({ width: 576, height: 415 });
    assert.deepEqual([window.viewportWidth, window.viewportHeight, window.phase, window.lastSubmittedFingerprint, paints],
      [576, 415, 'playing', '', 1], app);
    assert.deepEqual({ ...menuSize }, { width: 576, height: 415 }, app);
    window.foreground = false;
    resize({ width: 576, height: 443 });
    assert.deepEqual([window.viewportHeight, paints], [443, 1], app);
  }
  let paints = 0, viewSize;
  const window = { windowId: 'test', viewportWidth: 576, viewportHeight: 443, menu: null, lastSubmittedFingerprint: 'old',
    view: { resize: (...size) => { viewSize = size; } } };
  const resize = resizeHandler('app/apps/roam/roam-app.worker.ts', {
    window, render: () => paints++, DOC_MARGIN: 6, HEADER_HEIGHT: 30, BOTTOM_MARGIN: 6,
  });
  resize({ width: 576, height: 415 });
  // The document re-wraps for the region under its header.
  assert.deepEqual([window.viewportHeight, viewSize, window.lastSubmittedFingerprint, paints], [415, [564, 379], '', 1]);
});

test('resizing a terminal reconnects with the new grid and ignores callbacks from the old socket', () => {
  const sockets = [];
  const context = {
    exports: {}, require: () => ({}),
    com: { faceclaw: { app: {
      FaceclawWebSocketListener: class { constructor(callbacks) { return callbacks; } },
      FaceclawWebSocket: class {
        constructor(url, listener) { this.listener = listener; this.messages = []; sockets.push(this); }
        sendText(text) { this.messages.push(JSON.parse(text)); }
        close() {}
      },
    } } },
  };
  const socketContext = { exports: {}, com: context.com, require: () => ({ toJavaBytes: bytes => bytes }) };
  vm.runInNewContext(js(read('app/native/socket.ts')), socketContext);
  context.require = name => name === './socket' ? socketContext.exports : {};
  vm.runInNewContext(js(read('app/native/g2mirror-client.ts')), context);
  const client = new context.exports.G2MirrorClient({ host: 'localhost', port: 1234, cols: 72, rows: 28 });
  client.start();
  const oldSocket = sockets[0];
  oldSocket.listener.onOpen();
  assert.equal(oldSocket.messages[0].height, 28);
  client.stop();
  client.setViewport(80, 16);
  client.start();
  const newSocket = sockets[1];
  oldSocket.listener.onClosed(1000, 'bye');
  oldSocket.listener.onFailure('late failure');
  oldSocket.listener.onTextMessage('{"type":"error","message":"late error"}');
  assert.equal(client.state().phase, 'connecting');
  newSocket.listener.onOpen();
  assert.equal(newSocket.messages[0].width, 80);
  assert.equal(newSocket.messages[0].height, 16);
  assert.equal(client.state().status, 'Authenticating...');
});
