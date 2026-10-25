const test = require('node:test');
const assert = require('node:assert/strict');
const { loader } = require('./helpers/load-typescript.cjs');

// Roboto's line heights at the onboarding sizes, and a fixed advance.
const FONTS = { title: 31, body: 24, detail: 19, hero: 52 };
const font = (role) => ({ lineHeight: FONTS[role], measureText: (text) => text.length * 8, getGlyph: () => ({ dwidthX: 8 }) });

function setting(value, values) {
  return { value, values, get() { return this.value; }, set(next) { this.value = next; this.writes.push(next); },
    writes: [], displayValue: (v) => v[0].toUpperCase() + v.slice(1) };
}

function harness() {
  const settings = {
    appSwitcherPositionSetting: setting('bottom', ['left', 'right', 'bottom', 'popup']),
    statusBarPositionSetting: setting('bottom', ['top', 'bottom']),
    uiDepthSetting: setting('48', ['-62', '-48', '-32', '-16', '0', '16', '32', '48', '62']),
  };
  const load = loader({}, {
    './onboarding-fonts': { onboardingFont: font },
    '../../graphics/image': { G2_LENS_WIDTH: 640 },
    '../../ui/dashboard-settings': settings,
    '../../ui/shell/geometry': { MIN_WINDOW_HEIGHT: 288, SIDEBAR_WIDTH: 64, SWITCHER_ROW_HEIGHT: 36, TOP_BAR_HEIGHT: 28 },
  });
  return { settings, load };
}

/** An image that records what is drawn, checking it all lands on the image. */
function recorder(width, height) {
  const calls = [];
  const inside = (kind, x, y, w, h) => {
    assert.ok(x >= 0 && y >= 0 && x + w <= width && y + h <= height, `${kind} out of bounds: ${[x, y, w, h]}`);
  };
  return {
    width, height, calls,
    fillRect(x, y, w, h, value) { inside('fillRect', x, y, w, h); calls.push({ kind: 'fill', x, y, w, h, value }); },
    fillRoundedRect(x, y, w, h, value) { inside('fillRoundedRect', x, y, w, h); calls.push({ kind: 'fill', x, y, w, h, value }); },
    drawRoundedRect(x, y, w, h, value) { inside('drawRoundedRect', x, y, w, h); calls.push({ kind: 'outline', x, y, w, h, value }); },
    drawText(f, x, y, text, value) {
      inside(`text "${text}"`, x, y, f.measureText(text), f.lineHeight);
      calls.push({ kind: 'text', x, y, text, value });
    },
  };
}

test('the layout page fits four 40%-wide diagrams with captions on the immersive panel', () => {
  const { load } = harness();
  const { LayoutPage } = load('app/apps/onboarding/layout-page.ts');
  const page = new LayoutPage();
  assert.equal(page.immersive, true);
  const image = recorder(640, 480);
  page.paint(image, true);
  // Each diagram's outline spans the display's width at 40%.
  const areas = image.calls.filter((call) => call.kind === 'outline' && call.w === 256);
  assert.equal(areas.length, 4);
  assert.deepEqual(areas.map((area) => area.h), [130, 130, 130, 130]);
  // A 2x2 grid, the layouts with depth on top, captioned under each diagram.
  const text = (label) => image.calls.filter((call) => call.kind === 'text' && call.text === label);
  const [bottom, popup, left, right] = ['Bottom (Recommended)', 'Popup', 'Left', 'Right'].map((label) => text(label)[0]);
  assert.equal(bottom.y, popup.y);
  assert.equal(left.y, right.y);
  assert.ok(left.y > bottom.y);
  assert.ok(popup.x > bottom.x && right.x > left.x);
  for (const [caption, area] of [[bottom, areas[0]], [popup, areas[1]], [left, areas[2]], [right, areas[3]]]) {
    assert.ok(caption.y >= area.y + area.h, `${caption.text} sits under its diagram`);
    assert.ok(caption.x > area.x && caption.x + caption.text.length * 8 < area.x + area.w, `${caption.text} sits under its diagram`);
  }
  // Customizable Depth under Bottom and Popup only.
  const depth = text('Customizable Depth');
  assert.equal(depth.length, 2);
  for (const [subtitle, title] of [[depth[0], bottom], [depth[1], popup]]) {
    assert.equal(subtitle.y, title.y + FONTS.body);
    assert.ok(Math.abs(subtitle.x + 'Customizable Depth'.length * 4 - (title.x + title.text.length * 4)) <= 1, 'centred together');
  }
  // Bottom, recommended, is the selected cell at first, filled while focused.
  const box = image.calls.find((call) => call.kind === 'fill' && call.value === 15);
  assert.ok(box.x <= areas[0].x && box.y <= areas[0].y && box.y + box.h >= bottom.y);
});

test('the layout page starts on Bottom whatever is set, swipes in reading order, and a tap saves the choice', () => {
  const { load, settings } = harness();
  const { LayoutPage } = load('app/apps/onboarding/layout-page.ts');
  const page = new LayoutPage();
  settings.appSwitcherPositionSetting.value = 'right';
  page.enter?.();
  let next = 0;
  const nav = { next: () => next++ };
  page.handleInput({ type: 'click' }, nav);
  assert.deepEqual(settings.appSwitcherPositionSetting.writes, ['bottom']);
  page.handleInput({ type: 'scroll-up' }, nav);
  for (let i = 0; i < 2; i++) page.handleInput({ type: 'scroll-down' }, nav);
  assert.deepEqual(settings.appSwitcherPositionSetting.writes, ['bottom'], 'scrolling saves nothing');
  page.handleInput({ type: 'click' }, nav);
  for (let i = 0; i < 5; i++) page.handleInput({ type: 'scroll-down' }, nav);
  // Coming back keeps the last choice.
  page.enter?.();
  page.handleInput({ type: 'click' }, nav);
  assert.deepEqual(settings.appSwitcherPositionSetting.writes, ['bottom', 'left', 'right']);
  assert.equal(next, 3);
});

test('the text size page offers 12 to 18px, starts on the recommended 16px, and previews plain text', () => {
  const menu = { selected: null, items: [], setItems(items, index) { this.items = items; this.selected = index; },
    get selectedItem() { return this.items[this.selected] ?? null; }, paint(image, box) { this.box = box; },
    async handleInput(event) { this.selected = Math.max(0, Math.min(this.items.length - 1, this.selected + (event.type === 'scroll-down' ? 1 : -1))); } };
  let menuOptions;
  let selection = { kind: 'ttf', file: 'Roboto-Light.ttf', size: 14 };
  const saved = [];
  const load = loader({}, {
    './onboarding-fonts': { onboardingFont: font },
    '../../graphics/installed-fonts': { installedFontPath: (file) => `/fonts/${file}` },
    '../../graphics/ttf-font': { TtfFont: { load: (path, size) => font(size === 12 ? 'title' : 'detail') } },
    '../../graphics/ui-fonts': { fontSelectionLabel: () => 'Terminus', getDefaultSmallFont: () => font('detail'),
      getUiFontSelection: () => selection, setUiFontSelection: (value) => { selection = value; saved.push(value.size); },
      uiFontSizeAllowed: (path, size) => size !== 13 },
    '../../ui/font-picker': { FONT_SIZE_CHOICES: [8, 10, 11, 12, 13, 14, 15, 16, 17, 18, 20, 24] },
    '../../ui/menu-core': { Menu: class { constructor(options) { menuOptions = options; return menu; } } },
    '../../ui/metrics': { LIST_ROW_TEXT_INSET: 4, listRowHeight: (f) => f.lineHeight + 8 },
  });
  const { TextSizePage } = load('app/apps/onboarding/text-size-page.ts');
  const page = new TextSizePage();
  page.enter();
  assert.deepEqual(Array.from(menu.items), [12, 14, 15, 16, 17, 18]);
  assert.equal(menu.selectedItem, 16, 'recommended, not the current 14');
  // Only 16 carries the note, beside its size.
  const rows = [];
  for (const size of menu.items) {
    const row = recorder(menu.box?.width ?? 200, 32);
    menuOptions.draw({ image: row, item: size, x: 0, y: 0, width: row.width, height: 32, selected: size === 16 });
    rows.push(row.calls.map((call) => call.text));
  }
  assert.deepEqual(rows[3], ['16 px', 'Recommended']);
  assert.deepEqual(rows.filter((texts) => texts.length > 1).length, 1);
  // The size column holds the note; the preview is paragraphs of text, no menu.
  const image = recorder(640, 480);
  page.paint(image, true);
  assert.ok(menu.box.width >= 10 + '16 px'.length * 8 + 8 + 'Recommended'.length * 8);
  const preview = image.calls.filter((call) => call.kind === 'text' && call.x > menu.box.x + menu.box.width);
  assert.equal(preview[0].text.startsWith('This is how text will look'), true);
  assert.ok(preview.length > 3);
  assert.equal(image.calls.some((call) => call.kind === 'text' && call.text === 'Timers'), false);
  // A tap saves; coming back keeps the size chosen.
  page.handleInput({ type: 'scroll-up' }, { next: () => {} });
  page.handleInput({ type: 'click' }, { next: () => {} });
  assert.deepEqual(saved, [15]);
  page.enter();
  assert.equal(menu.selectedItem, 15);
});

test('the depth page follows layouts that have depth, sits in the layout, and applies depth as it scrolls', () => {
  const { load, settings } = harness();
  const menu = { selected: 0, items: [], select(index) { this.selected = index; },
    get selectedItem() { return this.items[this.selected] ?? null; }, paint() {},
    async handleInput(event) { this.selected = Math.max(0, Math.min(this.items.length - 1, this.selected + (event.type === 'scroll-down' ? 1 : -1))); } };
  const mocks = loader({}, {
    './onboarding-fonts': { onboardingFont: font },
    '../../ui/dashboard-settings': settings,
    '../../ui/menu-core': { Menu: class { constructor(options) { menu.items = options.items; return menu; } } },
    '../../ui/metrics': { LIST_ROW_TEXT_INSET: 4, listRowHeight: (f) => f.lineHeight + 8 },
    './layout-page': { layoutHasDepth: (position) => position === 'bottom' || position === 'popup' },
  });
  const { DepthPage } = mocks('app/apps/onboarding/depth-page.ts');
  const page = new DepthPage();
  assert.equal(page.immersive, undefined);
  for (const [position, applies] of [['left', false], ['right', false], ['bottom', true], ['popup', true]]) {
    settings.appSwitcherPositionSetting.value = position;
    assert.equal(page.applies(), applies, position);
  }
  page.enter();
  assert.equal(menu.selectedItem, '48');
  let next = 0;
  page.handleInput({ type: 'scroll-down' }, { next: () => next++ });
  page.handleInput({ type: 'scroll-up' }, { next: () => next++ });
  page.handleInput({ type: 'scroll-up' }, { next: () => next++ });
  assert.deepEqual(settings.uiDepthSetting.writes, ['62', '48', '32']);
  page.handleInput({ type: 'click' }, { next: () => next++ });
  assert.equal(next, 1);
});

test('the flow switches immersive mode per page and skips pages that do not apply, both ways', async () => {
  const shell = { yields: 0, yieldFocusToSidebar() { this.yields++; } };
  const load = loader({}, {
    '../../graphics/image': { GrayImage: class {} },
    '../../ui/shell/in-process-window': {}, '../../ui/shell/shell': { shell }, '../../ui/sound-effects': {},
    './data-collection-page': {}, './depth-page': {}, './display-mode-page': {}, './ios-privacy-page': {}, './layout-page': {},
    './onboarding-progress': {}, './text-size-page': {}, './welcome-page': {},
  });
  const { OnboardingLayer } = load('app/apps/onboarding/onboarding-app.ts');
  let depthApplies = false;
  const entered = [];
  const page = (name, extra) => ({ ...extra, enter: () => entered.push(name),
    handleInput: (event, nav) => { if (event.type === 'click') nav.next(); } });
  const immersive = [];
  let finished = 0;
  const layer = new OnboardingLayer([
    page('welcome', { immersive: true }), page('layout', { immersive: true }),
    page('depth', { applies: () => depthApplies }), page('voice', {}),
  ], (value) => immersive.push(value), () => finished++);
  const input = (type) => layer.handleInput({ type });
  await input('click');
  await input('click');
  assert.deepEqual(entered, ['welcome', 'layout', 'voice'], 'depth skipped going forward');
  assert.deepEqual(immersive, [true, false]);
  await input('double-click');
  assert.deepEqual(entered.at(-1), 'layout', 'and going back');
  depthApplies = true;
  await input('click');
  await input('click');
  assert.deepEqual(entered.slice(-2), ['depth', 'voice']);
  assert.deepEqual(immersive, [true, false, true, false, false]);
  await input('click');
  assert.equal(finished, 1);
  for (let i = 0; i < 4; i++) await input('double-click');
  assert.equal(entered.at(-1), 'welcome');
  assert.equal(shell.yields, 1, 'double-click on the first page leaves the app');
});

test('the display mode page offers Full Screen only where the layout allows it, and applies the mode as it scrolls', () => {
  const values = ['band-top', 'band-high', 'band-middle', 'band-low', 'band-bottom', 'tall', 'fullscreen'];
  const settings = {
    appSwitcherPositionSetting: setting('bottom', ['left', 'right', 'bottom', 'popup']),
    displayLayoutSetting: { ...setting('fullscreen', values), displayValue: (v) => v,
      isDisabled: (v) => v === 'fullscreen' && ['left', 'right'].includes(settings.appSwitcherPositionSetting.value) },
  };
  const menu = { selected: null, items: [], setItems(items, index) { this.items = items; this.selected = index; },
    get selectedItem() { return this.items[this.selected] ?? null; }, paint(image, box) { this.box = box; },
    async handleInput(event) { this.selected = Math.max(0, Math.min(this.items.length - 1, this.selected + (event.type === 'scroll-down' ? 1 : -1))); } };
  const load = loader({}, {
    './onboarding-fonts': { onboardingFont: font },
    '../../ui/dashboard-settings': settings,
    '../../ui/menu-core': { Menu: class { constructor() { return menu; } } },
    '../../ui/metrics': { LIST_ROW_TEXT_INSET: 4, listRowHeight: (f) => f.lineHeight + 8 },
  });
  const { DisplayModePage } = load('app/apps/onboarding/display-mode-page.ts');
  const page = new DisplayModePage();
  // An ordinary window, which the mode being applied resizes.
  assert.equal(page.immersive, undefined);
  page.enter();
  assert.deepEqual(Array.from(menu.items), values);
  assert.equal(menu.selectedItem, 'fullscreen');
  // The selected mode's description sits beside the list, within the window (a band's).
  const image = recorder(576, 260);
  page.paint(image, true);
  const description = image.calls.filter((call) => call.kind === 'text' && call.x >= menu.box.x + menu.box.width);
  assert.match(description.map((call) => call.text).join(' '), /Depth is turned off/);
  let next = 0;
  const nav = { next: () => next++ };
  page.handleInput({ type: 'scroll-up' }, nav);
  page.handleInput({ type: 'scroll-up' }, nav);
  assert.deepEqual(settings.displayLayoutSetting.writes, ['tall', 'band-bottom'], 'applied as it scrolls');
  page.handleInput({ type: 'click' }, nav);
  assert.equal(next, 1);
  assert.deepEqual(settings.displayLayoutSetting.writes, ['tall', 'band-bottom']);
  // Beside a side strip, a saved Full Screen shows as Tall, and is saved as such on a tap.
  settings.displayLayoutSetting.value = 'fullscreen';
  settings.appSwitcherPositionSetting.value = 'left';
  page.enter();
  assert.deepEqual(Array.from(menu.items), values.slice(0, 6));
  assert.equal(menu.selectedItem, 'tall');
  page.handleInput({ type: 'click' }, nav);
  assert.equal(settings.displayLayoutSetting.value, 'tall');
});
