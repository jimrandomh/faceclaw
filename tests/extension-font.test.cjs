const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const ts = require('typescript');
const vm = require('node:vm');
function harness() {
  let override = {}, base = { kind: 'ttf', file: 'Roboto-Light.ttf', size: 14 };
  const source = ts.createSourceFile('fonts.ts', fs.readFileSync('app/graphics/ui-fonts.ts', 'utf8'), ts.ScriptTarget.Latest, true);
  const fn = source.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === 'getUiFontSelection');
  const context = { exports: {}, typographyPolicy: () => override, parseFontSelection: JSON.parse, getStringSetting: key => key === 'font' ? JSON.stringify(base) : '', UI_FONT_SELECTION_KEY: 'font', LEGACY_UI_FONT_KEY: 'legacy', DEFAULT_UI_FONT: { kind: 'ttf', file: 'Roboto-Light.ttf', size: 14 } };
  vm.runInNewContext(ts.transpileModule(fn.getText(source), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, context);
  return { get: context.exports.getUiFontSelection, override: value => override = value, base: value => base = value };
}
test('font overrides reveal the latest base edit when disabled', () => {
  const h = harness(); h.override({ font: 'Inter_18pt-Regular.ttf', size: 17 });
  assert.equal(h.get().size, 17);
  h.base({ kind: 'ttf', file: 'Montserrat-Light.ttf', size: 19 });
  assert.equal(h.get().file, 'Inter_18pt-Regular.ttf');
  h.override({}); assert.equal(h.get().file, 'Montserrat-Light.ttf'); assert.equal(h.get().size, 19);
});
test('partial typography configuration composes with the current base', () => {
  const h = harness(); h.override({ size: 18 }); assert.equal(h.get().size, 18); assert.equal(h.get().file, 'Roboto-Light.ttf');
  h.override({ font: 'Inter_18pt-Regular.ttf' }); assert.equal(h.get().size, 14);
  h.base({ kind: 'bitmap', face: 'terminus' }); h.override({}); assert.equal(h.get().kind, 'bitmap');
});
