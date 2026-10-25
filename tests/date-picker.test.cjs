const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

function load(file, modules = {}) {
  const source = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
  const context = { exports: {}, require: (name) => modules[name] ?? {}, console, Date };
  vm.runInNewContext(ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText, context, { filename: file });
  return context.exports;
}

const textwrap = load('app/graphics/textwrap.ts');
const graphics = require('../.test-build/app/graphics/image.js');
const plane = load('app/graphics/plane.ts', { './image': graphics });
const gestures = load('app/ui/gestures.ts');
const { BdfFont } = load('app/graphics/bdffont.ts');
const font = (name) => BdfFont.parse(fs.readFileSync(path.join(__dirname, `../app/fonts/terminus/${name}.bdf`), 'utf8'));
const fonts = { getDefaultSmallFont: () => font('ter-u12n'), getDefaultMediumFont: () => font('ter-u16n') };
const layers = load('app/ui/layers.ts', {
  '../graphics/image': graphics, '../graphics/plane': plane, './gestures': gestures,
  '../native/frame-timings': { spanCurrent: (_name, paint) => paint() },
});
const picker = load('app/ui/date-picker.ts', {
  '../graphics/textwrap': textwrap, '../graphics/ui-fonts': fonts, './gestures': gestures,
  './menu': { CONTEXT_MENU_DIM: 0.25 }, './metrics': load('app/ui/metrics.ts'),
});

const day = (year, month, date) => ({ year, month: month - 1, day: date });
// Copied into this realm: the module's objects carry the vm context's prototypes.
const step = (...args) => ({ ...picker.stepCalendarDay(...args) });

function fixture(initial = new Date(2026, 9, 14), size = { width: 576, height: 260 }) {
  const picks = [];
  let cancels = 0;
  const base = { paint: () => new graphics.GrayImage(size.width, size.height, 0), handleInput() {} };
  const stack = new layers.LayerStack(base, layers.noopLayerActions, size);
  const layer = new picker.DatePickerLayer({
    title: 'Go to date', initial, onPick: (date) => picks.push(date), onCancel: () => cancels++,
  });
  stack.push(layer);
  return {
    stack, layer, picks, cancels: () => cancels,
    input: async (...types) => {
      for (const type of types) await stack.handleInput(gestures.makeInputEvent({ type, source: 'ring' }));
    },
  };
}

test('day steps roll across months and years', () => {
  assert.deepEqual(step(day(2026, 10, 31), 'day', 1), day(2026, 11, 1));
  assert.deepEqual(step(day(2026, 1, 1), 'day', -1), day(2025, 12, 31));
  assert.deepEqual(step(day(2024, 2, 28), 'day', 1), day(2024, 2, 29));
});

test('month and year steps clamp to short months but return to the preferred day', () => {
  const feb = step(day(2026, 1, 31), 'month', 1, 31);
  assert.deepEqual(feb, day(2026, 2, 28));
  assert.deepEqual(step(feb, 'month', 1, 31), day(2026, 3, 31));
  assert.deepEqual(step(day(2026, 1, 15), 'month', -1), day(2025, 12, 15));
  assert.deepEqual(step(day(2024, 2, 29), 'year', 1, 29), day(2025, 2, 28));
  assert.deepEqual(step(day(9999, 12, 31), 'day', 1), day(9999, 12, 31));
  assert.deepEqual(step(day(1000, 3, 1), 'year', -1), day(1000, 3, 1));
});

test('relative labels count whole days', () => {
  const today = day(2026, 10, 14);
  assert.equal(picker.relativeDayLabel(today, today), 'today');
  assert.equal(picker.relativeDayLabel(day(2026, 10, 13), today), 'yesterday');
  assert.equal(picker.relativeDayLabel(day(2026, 10, 15), today), 'tomorrow');
  assert.equal(picker.relativeDayLabel(day(2026, 10, 4), today), '10 days ago');
  // Across the US DST change on Nov 1.
  assert.equal(picker.relativeDayLabel(day(2026, 11, 20), today), 'in 37 days');
});

test('scroll adjusts the active field; clicks walk the fields and the last one picks', async () => {
  const f = fixture();
  await f.input('scroll-down', 'scroll-down', 'scroll-down');
  assert.deepEqual({ ...f.layer.value }, day(2026, 10, 11));
  await f.input('click');
  assert.equal(f.layer.activeField, 'month');
  await f.input('scroll-up');
  assert.deepEqual({ ...f.layer.value }, day(2026, 11, 11));
  await f.input('click', 'scroll-down', 'click');
  assert.ok(f.stack.isAtBase());
  assert.equal(f.picks.length, 1);
  assert.equal(f.picks[0].getTime(), new Date(2025, 10, 11).getTime());
  assert.equal(f.cancels(), 0);
});

test('double-click steps back a field, then cancels from the first', async () => {
  const f = fixture();
  await f.input('click', 'click');
  assert.equal(f.layer.activeField, 'year');
  await f.input('double-click', 'double-click');
  assert.equal(f.layer.activeField, 'day');
  assert.ok(!f.stack.isAtBase());
  await f.input('double-click');
  assert.ok(f.stack.isAtBase());
  assert.equal(f.cancels(), 1);
  assert.equal(f.picks.length, 0);
});

test('a host clearing the stack reports a cancel', () => {
  const f = fixture();
  f.stack.clearToBase();
  assert.equal(f.cancels(), 1);
});

test('watch swipes move between fields without picking or cancelling', async () => {
  const f = fixture();
  await f.input('swipe-left');
  assert.ok(!f.stack.isAtBase());
  await f.input('swipe-right', 'swipe-right', 'swipe-right', 'swipe-up');
  assert.equal(f.layer.activeField, 'year');
  assert.deepEqual({ ...f.layer.value }, day(2027, 10, 14));
  assert.ok(!f.stack.isAtBase());
});

test('the dialog is centered over the dimmed window, dropping the calendar when it does not fit', () => {
  const widths = [];
  for (const size of [{ width: 576, height: 260 }, { width: 576, height: 160 }, { width: 300, height: 260 }]) {
    const f = fixture(new Date(2026, 9, 14), size);
    const planes = f.stack.paint();
    assert.equal(planes.length, 2);
    assert.equal(planes.at(-1).dimUnderneath, 0.25);
    // The dialog's backdrop is the only value-1 fill.
    const image = planes.at(-1).image.withDrawsBaked();
    let left = Infinity, right = -1, top = Infinity, bottom = -1;
    for (let y = 0; y < image.height; y++) {
      for (let x = 0; x < image.width; x++) {
        if (image.getPixel(x, y) !== 1) continue;
        left = Math.min(left, x); right = Math.max(right, x);
        top = Math.min(top, y); bottom = Math.max(bottom, y);
      }
    }
    assert.ok(left > 0 && top > 0 && right < size.width - 1 && bottom < size.height - 1);
    assert.ok(Math.abs(left - (size.width - 1 - right)) <= 1);
    assert.ok(Math.abs(top - (size.height - 1 - bottom)) <= 1);
    widths.push(right - left);
  }
  // Only the roomy window has the calendar beside the fields.
  assert.ok(widths[0] > widths[1] + 100);
  assert.equal(widths[1], widths[2]);
});
