const test = require('node:test');
const assert = require('node:assert/strict');
const { loader } = require('./helpers/load-typescript.cjs');

function harness(width, height) {
  const font = { lineHeight: 20, measureText: text => text.length * 10, getGlyph: () => ({ dwidthX: 10 }) };
  const load = loader({}, { './onboarding-fonts': { onboardingFont: () => font } });
  const { IosPrivacyPage } = load('app/apps/onboarding/ios-privacy-page.ts');
  const { IOS_PRIVACY_NOTICE } = load('app/analytics/privacy-disclosure.ts');
  const page = new IosPrivacyPage();
  let next = 0;
  return {
    page, notice: IOS_PRIVACY_NOTICE, get next() { return next; },
    input(type) { page.handleInput({ type }, { next: () => next++ }); },
    paint() {
      const rows = [];
      page.paint({ width, height, drawText(font, x, y, text) {
        assert.ok(x + font.measureText(text) <= width, `horizontal overflow: ${text}`);
        assert.ok(y >= 0 && y + font.lineHeight <= height, `vertical overflow: ${text}`);
        rows.push({ y, text });
      } });
      return rows;
    },
  };
}

for (const [width, height] of [[576, 188], [576, 260], [640, 432]]) {
  test(`entire iOS notice is readable before continuing at ${width}x${height}`, () => {
    const h = harness(width, height);
    const shown = [];
    for (let i = 0; !h.next && i < 30; i++) {
      const rows = h.paint();
      const footer = rows.at(-1);
      for (const row of rows.slice(1, -1)) {
        assert.ok(row.y + 20 <= footer.y, 'body must not overlap navigation');
        shown.push(row.text);
      }
      h.input('click');
    }
    assert.equal(h.next, 1);
    // Line breaking may also split after punctuation (e.g. device/app).
    assert.equal(shown.join('').replace(/\s+/g, ''), h.notice.replace(/\s+/g, ''));
  });
}

test('scrolling stays inside the notice; revisiting starts at the beginning', () => {
  const h = harness(576, 188);
  const first = h.paint().map(row => row.text);
  h.input('scroll-up');
  assert.deepEqual(h.paint().map(row => row.text), first);
  h.input('scroll-down');
  assert.notDeepEqual(h.paint().map(row => row.text), first);
  for (let i = 0; i < 30; i++) h.input('scroll-down');
  assert.equal(h.next, 0, 'scrolling must not accept the notice');
  h.page.enter();
  assert.deepEqual(h.paint().map(row => row.text), first);
});
