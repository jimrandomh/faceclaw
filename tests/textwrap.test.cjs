const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const moduleObject = { exports: {} };
vm.runInNewContext(ts.transpileModule(fs.readFileSync('app/graphics/textwrap.ts', 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS },
}).outputText, { module: moduleObject, exports: moduleObject.exports });
const { wrapText, truncateText, truncateLeft } = moduleObject.exports;
const exactFont = {
  // Deliberately disagree with the renderer: no shared layout should use this.
  getGlyph() { throw new Error('rounded glyph advances used for layout'); },
  measureText(text) { return Array.from(text).reduce((sum, ch) => sum + (ch === 'i' ? 2.25 : ch === 'W' ? 9.5 : 5.5), 0) - (text.match(/AV/g)?.length || 0) * 2; },
};
const mono = { measureText: text => Array.from(text).length };

test('all default wrapping uses renderer widths, including kerning and fractional advances', () => {
  assert.deepEqual(Array.from(wrapText(exactFont, 'iiiiiiii WWWW next', 50)), ['iiiiiiii', 'WWWW', 'next']);
  assert.deepEqual(Array.from(wrapText(exactFont, 'AV AV', 23.5)), ['AV AV']);
});

test('shared wrapping splits overlong words without dropping Unicode codepoints', () => {
  const source = 'W'.repeat(40) + '🙂' + 'W'.repeat(10);
  const lines = Array.from(wrapText(exactFont, source, 50));
  assert.equal(lines.join(''), source);
  assert.ok(lines.every(line => exactFont.measureText(line) <= 50));
  assert.ok(lines.every(line => !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(line)));
});

test('shared wrapping retains hard paragraphs and code indentation on request', () => {
  assert.deepEqual(Array.from(wrapText(mono, 'Heading\n\n  const x = 1;\n    call(x);', 40, { preserveLeadingWhitespace: true })), ['Heading', '', '  const x = 1;', '    call(x);']);
});

test('left and right truncation never split a supplementary codepoint', () => {
  assert.equal(truncateText(mono, '🙂abcdef', 5), '🙂a...');
  assert.equal(truncateLeft(mono, 'abcdef🙂', 5), '...f🙂');
  assert.equal(truncateText(mono, '🙂abc', 4), '🙂abc');
});

test('truncation includes its marker in tiny and shaped width budgets', () => {
  for (const truncate of [truncateText, truncateLeft]) {
    for (const width of [0, 0.5, 1, 2, 3, 4, 5, 9]) assert.ok(mono.measureText(truncate(mono, 'a long label', width)) <= width);
    for (const width of [8, 16, 24, 32, 40]) assert.ok(exactFont.measureText(truncate(exactFont, 'AV WiWiWi final', width)) <= width);
  }
});

function loadLayer(path, imports) {
  const module = { exports: {} };
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(path, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS },
  }).outputText, { module, exports: module.exports, require: name => { assert.ok(name in imports, name); return imports[name]; } });
  return module.exports;
}

test('caption names, transcript words and translations share a bounded width', () => {
  const { CaptionsLayer } = loadLayer('app/apps/microphones/captions-layer.ts', {
    '../../graphics/textwrap': moduleObject.exports, '../../graphics/image': {}, '../../graphics/ui-fonts': {},
    '../../ui/metrics': {}, '../../ui/gestures': {}, './mic-session': { micSession: { getState: () => ({}) } },
  });
  const rows = new CaptionsLayer().buildRows(mono, 30, [{ speakerName: 'A very long speaker display name', text: 'x'.repeat(90), translation: 'y'.repeat(60), isWearer: true }]);
  assert.ok(rows.length > 5);
  for (const row of rows) assert.ok(mono.measureText(row.prefix || '') + row.indent + mono.measureText(row.text) <= 30);
  assert.equal(rows.filter(row => row.value === 230).map(row => row.text).join(''), 'x'.repeat(90));
});
