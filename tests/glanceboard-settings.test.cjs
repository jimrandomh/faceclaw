const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const layout = require('../.test-build/app/apps/glanceboard/layout.js');

function load(file, dependencies) {
  const context = { exports: {}, console, require: (name) => {
    assert.ok(name in dependencies, name);
    return dependencies[name];
  } };
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText, context);
  return context.exports;
}

function harness() {
  const values = new Map();
  const listeners = new Set();
  class Setting {
    constructor(options) { Object.assign(this, options); }
    get() { return values.get(this.storageKey) ?? this.defaultValue; }
    set(value) { values.set(this.storageKey, value); }
  }
  const config = {
    ConfigSettingBoolean: Setting, ConfigSettingEnum: Setting,
    onAnySettingChanged: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
  };
  const widgets = {
    glanceWidgetSpans: (choice) => choice === 'calendar' || choice === 'terminal',
    findGlanceWidget: () => ({ create: () => ({ start() {}, stop() {}, paint() {} }) }),
  };
  const settings = load('app/apps/glanceboard/glanceboard-settings.ts', {
    '../../ui/dashboard-settings': config, './layout': layout, './widgets': widgets,
  });
  class GrayImage {
    constructor(width, height) { this.width = width; this.height = height; }
    drawLine() {}
    composeInto() {}
  }
  const { GlanceBoard } = load('app/apps/glanceboard/board.ts', {
    '../../graphics/image': { GrayImage }, '../../ui/dashboard-settings': config,
    './glanceboard-settings': settings, './layout': layout, './widgets': widgets,
  });
  return { settings, GlanceBoard, values, listeners, notify: () => [...listeners].forEach((listener) => listener()) };
}

test('layout defaults to 2x2; expanding preserves stored slots and remembers the extra row', () => {
  const { settings: s, values } = harness();
  values.set('glanceboard.quadrants.slot.0', 'compass');
  assert.equal(s.glanceLayoutSetting.get(), '2x2');
  assert.equal(s.glanceLayout(), layout.QUADRANT_LAYOUT);
  s.glanceLayoutSetting.set('2x3');
  assert.equal(s.glanceLayout(), layout.SIX_SLOT_LAYOUT);
  assert.deepEqual(Array.from(s.glanceSlotSettings(), (slot) => slot.get()),
    ['compass', 'calendar', 'music', 'calendar', 'none', 'none']);
  s.glanceSlotSettings()[5].set('nightscout');
  s.glanceLayoutSetting.set('2x2');
  assert.equal(s.glanceSlotSettings().length, 4);
  s.glanceLayoutSetting.set('2x3');
  assert.equal(s.glanceSlotSettings()[5].get(), 'nightscout');
});

test('a spanning widget in the middle row keeps only one adjacent partner', () => {
  const { settings: s } = harness();
  s.glanceLayoutSetting.set('2x3');
  const slots = s.glanceSlotSettings();
  for (const index of [0, 2, 4]) slots[index].set('terminal');
  s.clearConflictingSlots(s.glanceLayout(), 2, 'terminal');
  assert.deepEqual(Array.from(slots, (slot) => slot.get()),
    ['terminal', 'calendar', 'terminal', 'calendar', 'none', 'none']);
  slots[4].set('terminal');
  s.clearConflictingSlots(s.glanceLayout(), 4, 'terminal');
  assert.equal(slots[0].get(), 'none');
  assert.equal(slots[2].get(), 'terminal');
});

test('an active empty board resizes and requests a frame when the layout changes', () => {
  const h = harness();
  for (const slot of h.settings.glanceSlotSettings(layout.SIX_SLOT_LAYOUT)) slot.set('none');
  let renders = 0;
  const board = new h.GlanceBoard(() => renders++);
  board.start();
  assert.equal(board.paint().height, 288);
  h.settings.glanceLayoutSetting.set('2x3');
  h.notify();
  assert.equal(board.paint().width, 576);
  assert.equal(board.paint().height, 432);
  assert.equal(renders, 1);
  h.settings.glanceLayoutSetting.set('2x2');
  h.notify();
  assert.equal(board.paint().height, 288);
  assert.equal(renders, 2);
  board.stop();
  assert.equal(h.listeners.size, 0);
});
