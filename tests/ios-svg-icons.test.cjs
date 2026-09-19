const test = require('node:test');
const assert = require('node:assert/strict');
const { loader } = require('./helpers/load-typescript.cjs');

function renderSource(svg) {
  let source;
  const { rasterizeSvg } = loader({}, { './ios-graphics': {
    rasterizeSvg: (value, size) => { source = value; assert.equal(size, 32); return 'rendered'; },
  } })('app/native/svg-rasterizer.ios.ts');
  assert.equal(rasterizeSvg(svg, 32, 2), 'rendered');
  return source;
}

test('EvenHub currentColor SVG fills are resolved before handing them to SVGKit', () => {
  // Same document shape as the Snake and Weather store icons copied from the phone.
  const source = renderSource('<svg width="24" height="24" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" fill="currentColor"><path d="M4 1h10v2h-10Z"/></svg>');
  assert.match(source, /fill="#ffffff"/);
  assert.doesNotMatch(source, /currentColor/i);
  assert.equal((source.match(/fill=/g) || []).length, 1);
  assert.match(source, /viewBox="0 0 24 24"/);
});

test('currentColor strokes/styles resolve without filling open Lucide shapes', () => {
  const source = renderSource('<svg fill="none" stroke="currentColor"><path style="stroke:currentColor" d="M2 2L8 8"/></svg>');
  assert.match(source, /fill="none"/);
  assert.match(source, /stroke="#ffffff"/);
  assert.match(source, /style="stroke:#ffffff"/);
  assert.match(source, /stroke-linecap="round"/);
});
