const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const ts = require('typescript');
const vm = require('node:vm');
function load(file, modules = {}) {
  const context = { exports: {}, require: name => { assert.ok(name in modules, name); return modules[name]; } };
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText, context);
  return context.exports;
}
test('viewport text entry uses its full height, renderer widths and reverts to the base layout', () => {
  let expanded = true; const draws = [], boxes = [];
  const font = { lineHeight: 17, measureText: text => Array.from(text).length * 5.5 };
  const { paintInputDialog } = load('app/ui/shell/input-dialog.ts', {
    '../extension-settings': { windowLayoutPolicy: () => ({ inputDialogs: expanded ? 'viewport' : 'compact' }), typographyPolicy: () => ({}) },
    '../../graphics/image': { G2_LENS_WIDTH: 640 },
    '../../graphics/textwrap': load('app/graphics/textwrap.ts'),
    '../../graphics/ui-fonts': { getDefaultSmallFont: () => font },
    '../menu': { drawSelectionHighlight() {} }, '../metrics': { listRowHeight: () => 25 },
    './geometry': { MIN_WINDOW_HEIGHT: 288, minWindowTop: () => 96, appViewportRect: () => ({ x: 0, y: 28, width: 640, height: 452 }) },
  });
  const image = { bakeDeferredDrawsInPlace() {}, fillRoundedRect: (...args) => boxes.push(args), drawRoundedRect() {}, drawText: (_font, x, y, text) => draws.push({ x, y, text }) };
  const content = { title: 'DICTATING', status: 'Nothing sent', text: 'Wide transcript words '.repeat(200), rows: [], selectedRow: 0, hint: 'Tap to review' };
  paintInputDialog(image, content);
  assert.deepEqual(boxes[0].slice(0, 4), [8, 36, 624, 436]);
  const lines = draws.slice(2, -1);
  assert.ok(lines.length > 12); assert.ok(lines.some(line => line.y > 350));
  assert.ok(lines.every(line => line.x + font.measureText(line.text) <= 616));
  assert.ok(lines.every((line, index) => !index || line.y - lines[index - 1].y === 22));
  assert.ok(draws.every(line => line.y + font.lineHeight < 480));
  expanded = false; paintInputDialog(image, content);
  assert.deepEqual(boxes[1].slice(0, 4), [40, 120, 560, 240]);
});
